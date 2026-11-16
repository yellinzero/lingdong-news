use crate::model::{AiLimits, NewsItem, Preferences};
use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Mutex,
    },
};
use tokio::sync::watch;
const DAY: u64 = 86_400_000;
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn validate_limits(l: &AiLimits) -> Result<(), String> {
    if !(1..=60).contains(&l.request_window_minutes)
        || !(1..=1440).contains(&l.lookback_minutes)
        || !(1..=10000).contains(&l.max_items24h)
        || !(1..=1000).contains(&l.max_requests24h)
        || !(2000..=128000).contains(&l.max_chars_per_request)
        || !(2000..=10_000_000).contains(&l.max_input_chars24h)
        || !(1..=120).contains(&l.max_requests_per_minute)
        || !(8000..=2_000_000).contains(&l.max_input_chars_per_minute)
        || l.max_retries > 1
    {
        return Err("AI 用量保护设置无效".into());
    }
    Ok(())
}
pub fn eligible(item: &NewsItem, prefs: &Preferences, time: u64) -> bool {
    let limits = &prefs.ai_limits;
    let date = item.published_at.max(item.updated_at.unwrap_or(0.));
    let cutoff = (time.saturating_sub(limits.lookback_minutes * 60_000)).max(if limits.new_only {
        prefs.ai_started_at
    } else {
        0
    });
    (limits.include_estimated || !item.date_estimated)
        && date >= cutoff as f64
        && date <= time as f64 + 60_000.
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reservation {
    #[serde(default = "one_request")]
    requests: usize,
    at: u64,
    items: usize,
    input_chars: usize,
}
fn one_request() -> usize {
    1
}
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ledger {
    records: Vec<Reservation>,
    #[serde(default)]
    cooldown_until: u64,
}
#[derive(Clone, Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub items: usize,
    pub requests: usize,
    pub input_chars: usize,
    pub reset_at: u64,
}
impl Ledger {
    fn prune(&mut self, time: u64) {
        // Keep the last minute exact for rate limits; compact older accounting
        // into minute buckets. Budget release is conservative by at most 60s.
        let mut buckets = std::collections::BTreeMap::<u64, Reservation>::new();
        let mut recent = Vec::new();
        for record in self
            .records
            .drain(..)
            .filter(|r| r.at > time.saturating_sub(DAY))
        {
            if record.at > time.saturating_sub(60000) {
                recent.push(record);
                continue;
            }
            let entry = buckets.entry(record.at / 60000).or_insert(Reservation {
                at: record.at,
                items: 0,
                input_chars: 0,
                requests: 0,
            });
            entry.at = entry.at.max(record.at);
            entry.items += record.items;
            entry.input_chars += record.input_chars;
            entry.requests += record.requests;
        }
        self.records = buckets.into_values().chain(recent).collect();
        self.records.sort_by_key(|r| r.at);
    }
    fn usage(&self) -> Usage {
        Usage {
            items: self.records.iter().map(|r| r.items).sum(),
            requests: self.records.iter().map(|r| r.requests).sum(),
            input_chars: self.records.iter().map(|r| r.input_chars).sum(),
            reset_at: self
                .records
                .iter()
                .map(|r| r.at.saturating_add(DAY))
                .min()
                .unwrap_or(0),
        }
    }
    fn wait_until(&self, limits: &AiLimits, input_chars: usize, time: u64) -> u64 {
        let window = limits.request_window_minutes * 60000;
        let interval = window.div_ceil(limits.max_requests_per_minute);
        let mut until = self.cooldown_until.max(
            self.records
                .last()
                .map(|r| r.at.saturating_add(interval))
                .unwrap_or(0),
        );
        let requests: Vec<_> = self
            .records
            .iter()
            .filter(|r| r.at > time.saturating_sub(window))
            .collect();
        let mut used_requests: usize = requests.iter().map(|r| r.requests).sum();
        for record in requests {
            if used_requests < limits.max_requests_per_minute as usize {
                break;
            }
            used_requests = used_requests.saturating_sub(record.requests);
            until = until.max(record.at.saturating_add(window));
        }
        let records: Vec<_> = self
            .records
            .iter()
            .filter(|r| r.at > time.saturating_sub(60000))
            .collect();
        let mut used: usize = records.iter().map(|r| r.input_chars).sum();
        for record in records {
            if used.saturating_add(input_chars) <= limits.max_input_chars_per_minute {
                break;
            }
            used = used.saturating_sub(record.input_chars);
            until = until.max(record.at.saturating_add(60000));
        }
        until
    }
}
pub struct Permit<'a> {
    gate: &'a Gate,
}
impl Drop for Permit<'_> {
    fn drop(&mut self) {
        self.gate.active.fetch_sub(1, Ordering::SeqCst);
    }
}

pub struct Ticket {
    pub generation: u64,
    pub receiver: watch::Receiver<u64>,
    automatic: bool,
}
pub struct Gate {
    active: AtomicUsize,
    control: Mutex<()>,
    halted: AtomicBool,
    generation: AtomicU64,
    signal: watch::Sender<u64>,
    ledger: Mutex<Result<Ledger, String>>,
    path: PathBuf,
}
impl Gate {
    pub fn load(path: PathBuf, halted: bool) -> Self {
        let ledger = match std::fs::read(&path) {
            Ok(bytes) if bytes.len() <= 1024 * 1024 => serde_json::from_slice::<Ledger>(&bytes)
                .map_err(|_| "AI 用量记录无法读取，已暂停发送".to_string())
                .and_then(|l| {
                    if l.records.len() > 10000 {
                        Err("AI 用量记录超过限制".into())
                    } else {
                        Ok(l)
                    }
                }),
            Ok(_) => Err("AI 用量记录超过限制".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Ledger::default()),
            Err(_) => Err("AI 用量记录无法读取，已暂停发送".into()),
        };
        let (signal, _) = watch::channel(0);
        Self {
            active: AtomicUsize::new(0),
            control: Mutex::new(()),
            halted: AtomicBool::new(halted),
            generation: AtomicU64::new(0),
            signal,
            ledger: Mutex::new(ledger),
            path,
        }
    }
    pub fn paused(&self) -> bool {
        self.halted.load(Ordering::SeqCst)
    }
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }
    #[cfg(test)]
    pub fn set_paused(&self, paused: bool) {
        let _ = self.transition(paused, None);
    }
    pub fn transition(&self, paused: bool, expected: Option<u64>) -> Result<u64, String> {
        let _control = self.control.lock().unwrap();
        if expected.is_some_and(|e| e != self.generation()) {
            return Err("AI 状态已变化，请重新操作".into());
        }
        self.halted.store(paused, Ordering::SeqCst);
        Ok(self.signal_cancel())
    }
    fn signal_cancel(&self) -> u64 {
        let value = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.signal.send_replace(value);
        value
    }
    pub fn cancel(&self) {
        let _control = self.control.lock().unwrap();
        self.signal_cancel();
    }
    pub fn ticket(&self, automatic: bool) -> Result<Ticket, String> {
        let receiver = self.signal.subscribe();
        let generation = *receiver.borrow();
        let t = Ticket {
            generation,
            receiver,
            automatic,
        };
        if !self.valid(&t) {
            return Err("AI 已暂停".into());
        }
        Ok(t)
    }
    pub fn valid(&self, t: &Ticket) -> bool {
        self.generation.load(Ordering::SeqCst) == t.generation && (!t.automatic || !self.paused())
    }
    pub fn usage(&self, time: u64) -> Result<Usage, String> {
        let mut guard = self.ledger.lock().unwrap();
        let l = guard.as_mut().map_err(|e| e.clone())?;
        l.prune(time);
        Ok(l.usage())
    }
    pub fn begin(&self, ticket: &Ticket, concurrency: usize) -> Result<Permit<'_>, String> {
        if !self.valid(ticket) {
            return Err("AI 已暂停".into());
        }
        let limit = concurrency.clamp(1, 4);
        let mut active = self.active.load(Ordering::SeqCst);
        loop {
            if active >= limit {
                return Err(format!("AI_WAIT:{}", now() + 250));
            }
            match self.active.compare_exchange(
                active,
                active + 1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => return Ok(Permit { gate: self }),
                Err(current) => active = current,
            }
        }
    }
    pub fn defer(&self, until: u64) -> Result<(), String> {
        let mut guard = self.ledger.lock().unwrap();
        let ledger = guard.as_mut().map_err(|e| e.clone())?;
        ledger.cooldown_until = ledger.cooldown_until.max(until.min(now() + 900000));
        save(&self.path, ledger)
    }
    pub fn reserve(
        &self,
        limits: &AiLimits,
        items: usize,
        input_chars: usize,
        time: u64,
        ticket: &Ticket,
    ) -> Result<Usage, String> {
        validate_limits(limits)?;
        if !self.valid(ticket) {
            return Err("AI 已暂停".into());
        }
        if items == 0
            || items > 20
            || input_chars
                > limits
                    .max_chars_per_request
                    .min(limits.max_input_chars_per_minute)
        {
            return Err("AI_INPUT_LIMIT：本批内容过长，请减少每批条数或提高单次文字上限".into());
        }
        let mut guard = self.ledger.lock().unwrap();
        let ledger = guard.as_mut().map_err(|e| e.clone())?;
        ledger.prune(time);
        let usage = ledger.usage();
        if limits.daily_enabled
            && (usage.items.saturating_add(items) > limits.max_items24h
                || usage.requests >= limits.max_requests24h
                || usage.input_chars.saturating_add(input_chars) > limits.max_input_chars24h)
        {
            return Err("AI_LIMIT：已达到你设置的24小时额度，额度恢复后自动继续".into());
        }
        let until = ledger.wait_until(limits, input_chars, time);
        if until > time {
            return Err(format!("AI_WAIT:{until}"));
        }
        if !self.valid(ticket) {
            return Err("AI 已暂停".into());
        }
        ledger.records.push(Reservation {
            requests: 1,
            at: time,
            items,
            input_chars,
        });
        if let Err(error) = save(&self.path, ledger) {
            ledger.records.pop();
            return Err(error);
        }
        Ok(ledger.usage())
    }
}
// Dropping reqwest's future aborts the local in-flight request. A provider may
// already have accepted/billed it; its reservation intentionally stays charged.
pub async fn execute<T>(
    gate: &Gate,
    mut ticket: Ticket,
    request: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    if !gate.valid(&ticket) {
        return Err("AI 已暂停".into());
    }
    let result = {
        let request = std::pin::pin!(request);
        let canceled = std::pin::pin!(ticket.receiver.changed());
        match futures_util::future::select(request, canceled).await {
            futures_util::future::Either::Left((result, _)) => result,
            futures_util::future::Either::Right(_) => Err("AI 已暂停".into()),
        }
    };
    if !gate.valid(&ticket) {
        return Err("AI 已暂停".into());
    }
    result
}

fn save(path: &Path, ledger: &Ledger) -> Result<(), String> {
    let parent = path.parent().ok_or("AI 用量记录位置无效")?;
    std::fs::create_dir_all(parent).map_err(|_| "无法保存 AI 用量，已暂停发送")?;
    let mut temp =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| "无法保存 AI 用量，已暂停发送")?;
    temp.write_all(&serde_json::to_vec(ledger).map_err(|_| "无法保存 AI 用量")?)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|_| "无法保存 AI 用量，已暂停发送")?;
    temp.persist(path)
        .map_err(|_| "无法保存 AI 用量，已暂停发送")?;
    Ok(())
}
#[cfg(test)]
mod tests {
    #[test]
    fn configured_window_spaces_batches_and_counts_requests_instead_of_news() {
        let dir = tempfile::tempdir().unwrap();
        let gate = Gate::load(dir.path().join("usage.json"), false);
        let limits = AiLimits {
            request_window_minutes: 15,
            max_requests_per_minute: 6,
            ..Default::default()
        };
        let start = 10_000_000;
        let ticket = gate.ticket(true).unwrap();
        let usage = gate.reserve(&limits, 8, 1000, start, &ticket).unwrap();
        assert_eq!(usage.items, 8);
        assert_eq!(usage.requests, 1);
        assert_eq!(
            gate.reserve(&limits, 8, 1000, start + 149999, &ticket)
                .unwrap_err(),
            format!("AI_WAIT:{}", start + 150000)
        );
        for n in 1..6 {
            gate.reserve(&limits, 8, 1000, start + n * 150000, &ticket)
                .unwrap();
        }
        assert!(gate
            .reserve(&limits, 8, 1000, start + 899999, &ticket)
            .is_err());
        assert!(gate
            .reserve(&limits, 8, 1000, start + 900000, &ticket)
            .is_ok());
    }
    #[test]
    fn increasing_request_window_honors_calls_already_made_in_that_window() {
        let ledger = Ledger {
            records: (0..6)
                .map(|n| Reservation {
                    at: 10_000_000 + n * 10000,
                    requests: 1,
                    items: 8,
                    input_chars: 100,
                })
                .collect(),
            cooldown_until: 0,
        };
        let limits = AiLimits {
            request_window_minutes: 15,
            max_requests_per_minute: 6,
            ..Default::default()
        };
        assert_eq!(ledger.wait_until(&limits, 100, 10_200_000), 10_900_000);
    }

    use super::*;
    use std::time::Duration;
    #[test]
    fn hard_limits_survive_restarts_failures_and_rolling_window() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage.json");
        let limits = AiLimits {
            daily_enabled: true,
            max_items24h: 2,
            max_requests24h: 2,
            ..Default::default()
        };
        let gate = Gate::load(path.clone(), false);
        let t = gate.ticket(true).unwrap();
        gate.reserve(&limits, 2, 1000, 100_000_000, &t).unwrap();
        assert!(gate
            .reserve(&limits, 1, 100, 100_000_001, &t)
            .unwrap_err()
            .starts_with("AI_LIMIT"));
        let gate = Gate::load(path, false);
        assert_eq!(gate.usage(100_000_002).unwrap().items, 2);
        let t = gate.ticket(true).unwrap();
        assert!(gate.reserve(&limits, 1, 100, 100_000_002, &t).is_err());
        assert!(gate.reserve(&limits, 1, 100, 100_000_001 + DAY, &t).is_ok());
    }
    #[test]
    fn pause_invalidates_active_tickets_manual_tests_share_limits_and_corrupt_records_fail_closed()
    {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage.json");
        let gate = Gate::load(path.clone(), false);
        let t = gate.ticket(true).unwrap();
        gate.set_paused(true);
        assert!(!gate.valid(&t));
        assert!(gate.ticket(true).is_err());
        let manual = gate.ticket(false).unwrap();
        assert!(gate
            .reserve(&AiLimits::default(), 1, 100, now(), &manual)
            .is_ok());
        std::fs::write(&path, b"corrupt").unwrap();
        let gate = Gate::load(path, false);
        let manual = gate.ticket(false).unwrap();
        assert!(gate
            .reserve(&AiLimits::default(), 1, 100, now(), &manual)
            .is_err());
    }

    #[test]
    fn concurrent_reservations_never_exceed_persisted_limits_and_stale_resume_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage.json");
        let gate = Gate::load(path.clone(), false);
        let limits = AiLimits {
            daily_enabled: true,
            max_requests24h: 3,
            ..Default::default()
        };
        let successes = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..12)
                .map(|_| {
                    scope.spawn(|| {
                        let ticket = gate.ticket(true).unwrap();
                        gate.reserve(&limits, 1, 100, now(), &ticket).is_ok()
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().unwrap())
                .filter(|ok| *ok)
                .count()
        });
        assert_eq!(successes, 1);
        assert_eq!(Gate::load(path, false).usage(now()).unwrap().requests, 1);
        let generation = gate.transition(true, None).unwrap();
        gate.set_paused(true);
        assert!(gate.transition(false, Some(generation)).is_err());
        assert!(gate.paused());
    }
    #[test]
    fn stop_cancels_an_inflight_http_request_without_waiting_for_the_server() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (started, wait_started) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = [0; 8192];
            let _ = stream.read(&mut bytes);
            started.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(700));
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
        });
        let dir = tempfile::tempdir().unwrap();
        let gate = std::sync::Arc::new(Gate::load(dir.path().join("usage.json"), false));
        let ticket = gate.ticket(true).unwrap();
        let stop = gate.clone();
        let cancel = std::thread::spawn(move || {
            wait_started.recv_timeout(Duration::from_secs(3)).unwrap();
            stop.set_paused(true);
        });
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let time = std::time::Instant::now();
        let result = runtime.block_on(execute(&gate, ticket, async {
            reqwest::Client::new()
                .post(format!("http://{address}/"))
                .body("{}")
                .send()
                .await
                .map_err(|e| e.to_string())
        }));
        assert!(result.unwrap_err().contains("暂停"));
        assert!(time.elapsed() < Duration::from_millis(500));
        cancel.join().unwrap();
        server.join().unwrap();
    }

    #[test]
    fn minute_limits_wait_then_recover_survive_restart_and_do_not_cap_a_full_day() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage.json");
        let gate = Gate::load(path.clone(), false);
        let ticket = gate.ticket(true).unwrap();
        let limits = AiLimits::default();
        let time = 100_000_000;
        gate.reserve(&limits, 8, 16000, time, &ticket).unwrap();
        assert_eq!(
            gate.reserve(&limits, 8, 16000, time + 1, &ticket)
                .unwrap_err(),
            format!("AI_WAIT:{}", time + 10000)
        );
        let gate = Gate::load(path, false);
        let ticket = gate.ticket(true).unwrap();
        assert!(gate
            .reserve(&limits, 8, 16000, time + 5000, &ticket)
            .is_err());
        gate.reserve(&limits, 8, 16000, time + 10000, &ticket)
            .unwrap();
        gate.reserve(&limits, 8, 16000, time + 20000, &ticket)
            .unwrap();
        assert_eq!(
            gate.reserve(&limits, 8, 16000, time + 30000, &ticket)
                .unwrap_err(),
            format!("AI_WAIT:{}", time + 60000)
        );
        gate.reserve(&limits, 8, 16000, time + 60000, &ticket)
            .unwrap();
        for i in 7..=34 {
            gate.reserve(&limits, 8, 1000, time + i * 10000, &ticket)
                .unwrap();
        }
        let usage = gate.usage(time + 340000).unwrap();
        assert!(usage.items > 100);
        assert!(usage.requests > 25);
        // An old preferences document inherits rate control, with daily caps off.
        let migrated: AiLimits =
            serde_json::from_str(r#"{"maxItems24h":100,"maxRequests24h":25}"#).unwrap();
        assert!(!migrated.daily_enabled);
        assert_eq!(migrated.max_requests_per_minute, 6);
    }
    #[test]
    fn concurrency_and_provider_cooldown_apply_to_manual_and_auto_calls() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage.json");
        let gate = Gate::load(path.clone(), false);
        let ticket = gate.ticket(true).unwrap();
        let manual = gate.ticket(false).unwrap();
        let permit = gate.begin(&ticket, 1).unwrap();
        assert!(gate.begin(&manual, 1).is_err());
        drop(permit);
        assert!(gate.begin(&manual, 1).is_ok());
        let time = now();
        gate.defer(time + 60000).unwrap();
        let gate = Gate::load(path, false);
        let manual = gate.ticket(false).unwrap();
        assert!(gate
            .reserve(&AiLimits::default(), 1, 100, time, &manual)
            .unwrap_err()
            .starts_with("AI_WAIT:"));
        gate.reserve(&AiLimits::default(), 1, 100, time + 60001, &manual)
            .unwrap();
    }
    #[test]
    fn ledger_compaction_keeps_long_running_accounting_small_without_losing_usage() {
        let time = 200_000_000;
        let mut ledger = Ledger {
            records: (0..20000)
                .map(|i| Reservation {
                    at: time - 80_000_000 + i * 4000,
                    items: 8,
                    input_chars: 100,
                    requests: 1,
                })
                .collect(),
            ..Default::default()
        };
        ledger.prune(time);
        let usage = ledger.usage();
        assert_eq!(usage.requests, 20000);
        assert_eq!(usage.items, 160000);
        assert!(ledger.records.len() < 1500);
        assert!(serde_json::to_vec(&ledger).unwrap().len() < 300000);
    }
}
