mod adapters;
mod ai;
mod ai_control;
mod branding;
mod credentials;
mod geometry;
mod live_check;
#[cfg(target_os = "macos")]
mod mac_window;
mod model;
mod network;
mod plugins;
mod storage;
mod syndication;

use model::{AiConfig, CustomSource, DiskState, Judgement, NewsItem};
use serde::Serialize;
use serde_json::json;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager};

struct TrayAiControl {
    item: tauri::menu::MenuItem<tauri::Wry>,
    enabled: AtomicBool,
}
fn sync_tray_ai(app: &tauri::AppHandle) {
    if let Some(tray) = app.try_state::<TrayAiControl>() {
        let enabled = app
            .state::<Backend>()
            .disk
            .lock()
            .unwrap()
            .preferences
            .ai_enabled;
        if tray.enabled.swap(enabled, Ordering::SeqCst) != enabled {
            let _ = tray
                .item
                .set_text(if enabled { "关闭 AI" } else { "开启 AI" });
        }
    }
}
struct Backend {
    disk: Mutex<DiskState>,
    ai_gate: ai_control::Gate,
    credentials: credentials::Store,
    writable: bool,
    warning: Option<String>,
    path: PathBuf,
    client: reqwest::Client,
    refreshing: AtomicBool,
    paused: AtomicBool,
    smoke: bool,
    geometry: Mutex<geometry::Geometry>,
    geometry_writable: bool,
    geometry_changing: AtomicBool,
    geometry_generation: AtomicU64,
    geometry_ignore_until: Mutex<std::time::Instant>,
    compact_drag: Arc<AtomicBool>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Loaded {
    app_name: &'static str,
    state: DiskState,
    warning: Option<String>,
    data_path: String,
    smoke: bool,
    native_compact_drag: bool,
    native_resize_drag: bool,
}

#[tauri::command]
fn load_state(app: tauri::AppHandle, backend: tauri::State<Backend>) -> Loaded {
    let _ = app;
    Loaded {
        app_name: branding::app_name(),
        state: backend.disk.lock().unwrap().clone(),
        warning: backend.warning.clone(),
        data_path: backend.path.display().to_string(),
        smoke: backend.smoke,
        native_compact_drag: cfg!(target_os = "macos"),
        native_resize_drag: !cfg!(target_os = "macos"),
    }
}
#[tauri::command]
async fn save_state(
    app: tauri::AppHandle,
    mut state: DiskState,
    ai_generation: Option<u64>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let backend = app.state::<Backend>();
        if state.preferences.ai_enabled && backend.ai_gate.paused() {
            state.preferences.ai_paused = true;
        }
        network::validate_preferences(&state.preferences)?;
        let mut current = backend.disk.lock().unwrap();
        if ai_generation.is_some_and(|value| value != backend.ai_gate.generation()) {
            state.preferences.ai_enabled = current.preferences.ai_enabled;
            state.preferences.ai_paused = current.preferences.ai_paused;
            state.preferences.ai_started_at = current.preferences.ai_started_at;
        }
        if !backend.writable {
            return Err(backend
                .warning
                .clone()
                .unwrap_or("本地记录暂不可保存".into()));
        }
        storage::save(&backend.path, &state)?;
        *current = state;
        drop(current);
        sync_tray_ai(&app);
        Ok(())
    })
    .await
    .map_err(|_| "设置保存未完成".to_string())?
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiPauseState {
    paused: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    enabled: Option<bool>,
    started_at: u64,
    generation: u64,
    request_id: Option<String>,
}
#[tauri::command]
async fn set_ai_paused(
    app: tauri::AppHandle,
    paused: bool,
    expected_generation: Option<u64>,
    request_id: Option<String>,
    enabled: Option<bool>,
) -> Result<AiPauseState, String> {
    let backend = app.state::<Backend>();
    let paused = enabled.map(|value| !value).unwrap_or(paused);
    let generation = backend
        .ai_gate
        .transition(paused, if paused { None } else { expected_generation })?;
    let started_at = {
        let mut disk = backend.disk.lock().unwrap();
        if backend.ai_gate.generation() != generation {
            return Err("AI 操作已被更新的操作取消".into());
        }
        disk.preferences.ai_paused = paused;
        if let Some(enabled) = enabled {
            disk.preferences.ai_enabled = enabled;
        }
        if !paused {
            disk.preferences.ai_started_at = ai_control::now();
        }
        disk.preferences.ai_started_at
    };
    let _ = app.emit(
        "ai-pause-changed",
        AiPauseState {
            paused,
            enabled,
            started_at,
            generation,
            request_id: request_id.clone(),
        },
    );
    let menu_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let backend = app.state::<Backend>();
        let mut disk = backend.disk.lock().unwrap();
        disk.preferences.ai_paused = backend.ai_gate.paused();
        if !backend.writable {
            return Err("本地记录暂不可保存".to_string());
        }
        storage::save(&backend.path, &disk)
    })
    .await
    .map_err(|_| "AI 状态保存未完成".to_string())?;
    sync_tray_ai(&menu_app);
    result?;
    Ok(AiPauseState {
        paused,
        enabled,
        started_at,
        generation,
        request_id: request_id.clone(),
    })
}
#[tauri::command]
fn ai_usage(backend: tauri::State<Backend>) -> Result<ai_control::Usage, String> {
    backend.ai_gate.usage(ai_control::now())
}

fn stored_key(config: &AiConfig, backend: &Backend) -> Result<Option<String>, String> {
    backend.credentials.get("ai", &network::account(config)?)
}
#[tauri::command]
async fn key_status(app: tauri::AppHandle, config: AiConfig) -> Result<bool, String> {
    if network::endpoint(&config).is_err() {
        return Ok(false);
    }
    tauri::async_runtime::spawn_blocking(move || {
        stored_key(&config, &app.state::<Backend>()).map(|k| k.is_some())
    })
    .await
    .map_err(|_| "无法读取本地 Key 文件".to_string())?
}
#[tauri::command]
async fn save_key(app: tauri::AppHandle, config: AiConfig, key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Backend>()
            .credentials
            .set("ai", &network::account(&config)?, &key)
    })
    .await
    .map_err(|_| "无法保存本地 Key".to_string())?
}

async fn fetch_all(app: &tauri::AppHandle) -> Vec<network::FeedResult> {
    let backend = app.state::<Backend>();
    if backend.refreshing.swap(true, Ordering::SeqCst) {
        return Vec::new();
    }
    let prefs = backend.disk.lock().unwrap().preferences.clone();
    let sources: Vec<_> = prefs
        .sources
        .iter()
        .filter(|id| !prefs.uninstalled_sources.contains(id))
        .cloned()
        .collect();
    let mut tasks = tokio::task::JoinSet::new();
    let semaphore = Arc::new(tokio::sync::Semaphore::new(4));
    for source in sources {
        let revision = subscription_revision(&prefs, &source);
        let client = backend.client.clone();
        let custom = prefs
            .custom_sources
            .iter()
            .find(|s| s.id == source)
            .cloned();
        let semaphore = semaphore.clone();
        let app = app.clone();
        tasks.spawn(async move {
            let _permit = semaphore.acquire_owned().await.expect("source semaphore");
            let result = if let Some(custom) = custom {
                let key = read_source_key(&app, &custom).await;
                match key {
                    Ok(key) => network::fetch_custom(&client, &custom, key.as_deref()).await,
                    Err(error) => network::FeedResult {
                        source: custom.id,
                        text: None,
                        warning: None,
                        error: Some(error),
                        fetched_at: 0,
                    },
                }
            } else {
                network::fetch(&client, &source).await
            };
            (result, revision)
        });
    }
    let mut results = Vec::new();
    while let Some(task) = tasks.join_next().await {
        if let Ok((result, revision)) = task {
            let current = backend.disk.lock().unwrap().preferences.clone();
            if !current.sources.contains(&result.source)
                || current.uninstalled_sources.contains(&result.source)
                || subscription_revision(&current, &result.source) != revision
            {
                continue;
            }
            let _ = app.emit("feeds", vec![result.clone()]);
            results.push(result);
        }
    }
    backend.refreshing.store(false, Ordering::SeqCst);
    results
}

fn subscription_revision(prefs: &model::Preferences, id: &str) -> serde_json::Value {
    let source = prefs
        .custom_sources
        .iter()
        .find(|source| source.id == id)
        .cloned()
        .or_else(|| plugins::builtin(id));
    serde_json::to_value(source).expect("source definitions are JSON values")
}
#[tauri::command]
async fn refresh(app: tauri::AppHandle) -> Vec<network::FeedResult> {
    fetch_all(&app).await
}

#[tauri::command]
async fn inspect_source_packages(packages: Vec<plugins::Package>) -> Result<(), String> {
    if packages.len() > 200 || packages.iter().map(|p| p.script.len()).sum::<usize>() > 1024 * 1024
    {
        return Err("安装文件超过限制".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        for package in packages {
            plugins::check_syntax(&package)?;
        }
        Ok(())
    })
    .await
    .map_err(|_| "渠道检查未完成".to_string())?
}

#[tauri::command]
fn set_paused(backend: tauri::State<Backend>, paused: bool) {
    backend.paused.store(paused, Ordering::SeqCst);
    if paused {
        backend.ai_gate.cancel();
    }
}

#[derive(serde::Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SmokeReport {
    horizontal: bool,
    glance_scroll: bool,
    feed_scroll: bool,
    collapse: bool,
    no_overflow: bool,
    pin_toggle: bool,
    #[serde(default)]
    details: Option<serde_json::Value>,
}
#[tauri::command]
fn smoke_report(app: tauri::AppHandle, report: SmokeReport) {
    if !app.state::<Backend>().smoke {
        return;
    }
    let pass = report.horizontal
        && report.glance_scroll
        && report.feed_scroll
        && report.collapse
        && report.no_overflow
        && report.pin_toggle;
    println!("NATIVE_SMOKE {}", serde_json::to_string(&report).unwrap());
    app.exit(if pass { 0 } else { 1 });
}

async fn budgeted_judgement(
    app: tauri::AppHandle,
    config: AiConfig,
    interests: String,
    inputs: Vec<ai::BatchInput>,
    provided_key: Option<String>,
    automatic: bool,
) -> Result<Vec<ai::BatchJudgement>, String> {
    let backend = app.state::<Backend>();
    let prefs = backend.disk.lock().unwrap().preferences.clone();
    if automatic && !backend.writable {
        return Err("无法保存新闻判断，已暂停 AI 发送".into());
    }
    if inputs.is_empty() || inputs.len() > 20 || inputs.iter().any(|i| i.item.id.is_empty()) || {
        let ids: std::collections::HashSet<_> = inputs.iter().map(|i| &i.item.id).collect();
        ids.len() != inputs.len()
    } {
        return Err("AI 批次新闻 ID 无效".into());
    }
    if automatic && (!prefs.ai_enabled || prefs.ai_paused || backend.paused.load(Ordering::SeqCst))
    {
        return Err("AI 已暂停".into());
    }
    if automatic
        && inputs.iter().any(|i| {
            !prefs.sources.contains(&i.item.source)
                || !ai_control::eligible(&i.item, &prefs, ai_control::now())
        })
    {
        return Err("新闻已超出当前 AI 判断范围".into());
    }
    network::endpoint(&config)?;
    let mut ticket = backend.ai_gate.ticket(automatic)?;
    let key = match provided_key {
        Some(key) if !key.trim().is_empty() => key,
        _ => {
            let c = config.clone();
            let handle = app.clone();
            tauri::async_runtime::spawn_blocking(move || stored_key(&c, &handle.state::<Backend>()))
                .await
                .map_err(|_| "无法读取模型凭据")??
                .ok_or("未配置模型 Key")?
        }
    };
    if !backend.ai_gate.valid(&ticket) {
        return Err("AI 已暂停".into());
    }
    let chars = ai::request_body(&inputs, &config, &interests)
        .to_string()
        .chars()
        .count();
    let _permit = backend.ai_gate.begin(&ticket, prefs.ai.concurrency)?;
    let original_generation = ticket.generation;
    let count = inputs.len();
    let limits = prefs.ai_limits.clone();
    let handle = app.clone();
    // Reserve and persist before HTTP; all attempts, including failures/tests, consume quota.
    let usage = tauri::async_runtime::spawn_blocking(move || {
        let backend = handle.state::<Backend>();
        backend
            .ai_gate
            .reserve(&limits, count, chars, ai_control::now(), &ticket)
    })
    .await
    .map_err(|_| "AI 用量检查未完成")??;
    let _ = app.emit("ai-usage", usage);
    // A fresh receiver observes cancellation even when stop arrives during key/quota IO.
    ticket = backend.ai_gate.ticket(automatic)?;
    if ticket.generation != original_generation {
        return Err("AI 已暂停".into());
    }
    // Re-check age after credential/ledger IO, just before any paid dispatch.
    if automatic
        && inputs
            .iter()
            .any(|i| !ai_control::eligible(&i.item, &prefs, ai_control::now()))
    {
        return Err("新闻已超出当前 AI 判断范围".into());
    }
    let result = ai_control::execute(
        &backend.ai_gate,
        ticket,
        ai::evaluate_batch(&backend.client, &config, &interests, &inputs, &key),
    )
    .await;
    if let Err(error) = &result {
        if let Some(rest) = error.strip_prefix("AI_PROVIDER_WAIT:") {
            if let Some(until) = rest.split(':').next().and_then(|v| v.parse::<u64>().ok()) {
                let handle = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    handle.state::<Backend>().ai_gate.defer(until)
                })
                .await
                .map_err(|_| "AI 冷却状态未保存")??;
            }
        }
    }
    result
}
#[tauri::command]
async fn judge(
    app: tauri::AppHandle,
    item: NewsItem,
    fingerprint: String,
) -> Result<Option<Judgement>, String> {
    let prefs = app
        .state::<Backend>()
        .disk
        .lock()
        .unwrap()
        .preferences
        .clone();
    let results = budgeted_judgement(
        app,
        prefs.ai,
        prefs.interests,
        vec![ai::BatchInput { item, fingerprint }],
        None,
        true,
    )
    .await?;
    Ok(results.into_iter().next().map(|r| r.judgement))
}
#[tauri::command]
async fn prepare_ai_batch(
    app: tauri::AppHandle,
    inputs: Vec<ai::BatchInput>,
) -> Result<ai::BatchCapacity, String> {
    if inputs.len() > 20 {
        return Err("每批最多 20 条新闻".into());
    }
    let prefs = app
        .state::<Backend>()
        .disk
        .lock()
        .unwrap()
        .preferences
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        ai::batch_capacity(
            &inputs,
            &prefs.ai,
            &prefs.interests,
            prefs
                .ai_limits
                .max_chars_per_request
                .min(prefs.ai_limits.max_input_chars_per_minute),
        )
    })
    .await
    .map_err(|_| "AI 批次检查未完成".into())
}

#[tauri::command]
async fn judge_batch(
    app: tauri::AppHandle,
    inputs: Vec<ai::BatchInput>,
) -> Result<Vec<ai::BatchJudgement>, String> {
    let prefs = app
        .state::<Backend>()
        .disk
        .lock()
        .unwrap()
        .preferences
        .clone();
    budgeted_judgement(app, prefs.ai, prefs.interests, inputs, None, true).await
}

async fn read_source_key(
    app: &tauri::AppHandle,
    source: &CustomSource,
) -> Result<Option<String>, String> {
    if source.auth == "none" {
        return Ok(None);
    }
    let source = source.clone();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Backend>()
            .credentials
            .get("source", &network::source_account(&source)?)
    })
    .await
    .map_err(|_| "无法读取来源 Key".to_string())?
}
#[tauri::command]
async fn save_source_key(
    app: tauri::AppHandle,
    source: CustomSource,
    key: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Backend>()
            .credentials
            .set("source", &network::source_account(&source)?, &key)
    })
    .await
    .map_err(|_| "无法保存来源 Key".to_string())?
}
#[tauri::command]
fn export_subscriptions(app: tauri::AppHandle, content: String) -> Result<String, String> {
    if content.len() > 1024 * 1024 || !content.contains("<opml") {
        return Err("OPML 内容无效或过大".into());
    }
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let path = app
        .path()
        .download_dir()
        .map_err(|_| "无法定位下载目录")?
        .join(format!("NewsFloat-subscriptions-{time}.opml"));
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|_| "无法写入下载目录，可复制 OPML 文本手动保存")?;
    file.write_all(content.as_bytes())
        .map_err(|_| "OPML 导出未完成，可复制文本手动保存")?;
    Ok(path.display().to_string())
}

#[tauri::command]
async fn test_source(
    app: tauri::AppHandle,
    source: CustomSource,
    key: Option<String>,
) -> Result<network::FeedResult, String> {
    network::custom_endpoint(&source)?;
    let key = match key {
        Some(key) => Some(key),
        None => read_source_key(&app, &source).await?,
    };
    Ok(network::fetch_custom(&app.state::<Backend>().client, &source, key.as_deref()).await)
}
#[tauri::command]
async fn test_ai(
    app: tauri::AppHandle,
    config: AiConfig,
    interests: String,
    item: NewsItem,
    key: Option<String>,
) -> Result<Judgement, String> {
    network::endpoint(&config)?;
    if interests.trim().is_empty() {
        return Err("请填写关注条件".into());
    }
    let key = if let Some(key) = key {
        Some(key)
    } else {
        let key_config = config.clone();
        let key_app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            stored_key(&key_config, &key_app.state::<Backend>())
        })
        .await
        .map_err(|_| "无法读取模型凭据")??
    }
    .filter(|key| !key.trim().is_empty())
    .ok_or("请填写此接口的 Key")?;
    let results = budgeted_judgement(
        app,
        config,
        interests,
        vec![ai::BatchInput {
            item,
            fingerprint: String::new(),
        }],
        Some(key),
        false,
    )
    .await?;
    results
        .into_iter()
        .next()
        .map(|r| r.judgement)
        .ok_or("模型未返回结果".into())
}

#[tauri::command]
fn presentation(window: tauri::WebviewWindow, mode: &str, pinned: bool) -> Result<(), String> {
    resize(&window, mode, pinned)
}
fn apply_pin(window: &tauri::WebviewWindow, pinned: bool) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    window
        .set_always_on_top(pinned)
        .map_err(|_| "无法切换窗口置顶状态".to_string())?;
    #[cfg(target_os = "linux")]
    let _ = window.set_visible_on_all_workspaces(pinned);
    #[cfg(target_os = "macos")]
    mac_window::apply(window, pinned)?;
    if std::env::args().any(|a| a == "--trace-window") {
        println!("WINDOW_PIN {}", actual_pinned(window).unwrap_or(false));
    }
    Ok(())
}
#[tauri::command]
fn set_pin(window: tauri::WebviewWindow, pinned: bool) -> Result<(), String> {
    apply_pin(&window, pinned)
}
#[tauri::command]
fn window_hover(window: tauri::WebviewWindow) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    return mac_window::hovered(&window);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Ok(false)
    }
}
#[tauri::command]
fn drag_window(window: tauri::WebviewWindow) -> Result<(), String> {
    if std::env::args().any(|a| a == "--trace-window") {
        println!("WINDOW_DRAG_REQUEST");
    }
    #[cfg(target_os = "macos")]
    return mac_window::drag(&window);
    #[cfg(not(target_os = "macos"))]
    window.start_dragging().map_err(|_| "无法拖动窗口".into())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowStatus {
    x: i32,
    y: i32,
    pinned: bool,
    width: f64,
    height: f64,
    scale: f64,
    #[cfg(target_os = "macos")]
    native: mac_window::Status,
}
fn actual_pinned(window: &tauri::WebviewWindow) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    return Ok(mac_window::status(window)?.level >= 3);
    #[cfg(not(target_os = "macos"))]
    window
        .is_always_on_top()
        .map_err(|_| "无法读取置顶状态".into())
}
#[tauri::command]
fn window_status(window: tauri::WebviewWindow) -> Result<WindowStatus, String> {
    let p = window
        .outer_position()
        .map_err(|_| "无法读取窗口位置".to_string())?;
    let scale = window.scale_factor().map_err(|_| "无法读取窗口缩放")?;
    let size = window.inner_size().map_err(|_| "无法读取窗口尺寸")?;
    Ok(WindowStatus {
        x: p.x,
        y: p.y,
        pinned: actual_pinned(&window)?,
        width: size.width as f64 / scale,
        height: size.height as f64 / scale,
        scale,
        #[cfg(target_os = "macos")]
        native: mac_window::status(&window)?,
    })
}
fn remember_geometry(window: &tauri::WebviewWindow, persist: bool) -> Result<(), String> {
    let backend = window.state::<Backend>();
    if backend.geometry_changing.load(Ordering::SeqCst) {
        return Ok(());
    }
    let size = window.inner_size().map_err(|_| "无法读取窗口尺寸")?;
    let scale = window.scale_factor().map_err(|_| "无法读取缩放比例")?;
    let mut g = backend.geometry.lock().unwrap();
    let mode = g.mode.clone();
    if mode.is_empty() {
        return Ok(());
    }
    g.sizes.insert(
        mode.clone(),
        geometry::constrained(
            &mode,
            geometry::Size {
                width: size.width as f64 / scale,
                height: size.height as f64 / scale,
            },
        ),
    );
    if persist && !backend.smoke {
        if !backend.geometry_writable {
            return Err("窗口尺寸文件不可写，原文件已保留".into());
        }
        geometry::save(&backend.path.with_file_name("window-layout.json"), &g)?;
    }
    Ok(())
}
fn debounce_geometry(window: &tauri::WebviewWindow) {
    if std::time::Instant::now()
        < *window
            .state::<Backend>()
            .geometry_ignore_until
            .lock()
            .unwrap()
    {
        return;
    }
    if remember_geometry(window, false).is_err() {
        return;
    }
    let backend = window.state::<Backend>();
    let token = backend.geometry_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        if window
            .state::<Backend>()
            .geometry_generation
            .load(Ordering::SeqCst)
            == token
        {
            if let Err(error) = remember_geometry(&window, true) {
                let _ = window.emit("window-error", error);
            }
        }
    });
}
#[tauri::command]
fn prepare_window_resize(window: tauri::WebviewWindow) {
    *window
        .state::<Backend>()
        .geometry_ignore_until
        .lock()
        .unwrap() = std::time::Instant::now();
}
#[tauri::command]
fn resize_window(
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    persist: bool,
) -> Result<(), String> {
    if !x.is_finite() || !y.is_finite() || !width.is_finite() || !height.is_finite() {
        return Err("无效的窗口尺寸".into());
    }
    let mode = window
        .state::<Backend>()
        .geometry
        .lock()
        .unwrap()
        .mode
        .clone();
    let mut size = geometry::constrained(&mode, geometry::Size { width, height });
    if let Some(m) = window.current_monitor().ok().flatten() {
        let a = m.work_area();
        let s = m.scale_factor();
        size.width = size.width.min(a.size.width as f64 / s);
        size.height = size.height.min(a.size.height as f64 / s);
    }
    window
        .set_size(tauri::LogicalSize::new(size.width, size.height))
        .map_err(|_| "无法调整窗口尺寸")?;
    let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    // Setters are dispatched asynchronously on macOS. Record the requested,
    // constrained size now rather than querying the previous frame immediately.
    let backend = window.state::<Backend>();
    *backend.geometry_ignore_until.lock().unwrap() =
        std::time::Instant::now() + Duration::from_millis(150);
    let mut geometry = backend.geometry.lock().unwrap();
    geometry.sizes.insert(mode, size);
    if persist && !backend.smoke {
        if !backend.geometry_writable {
            return Err("窗口尺寸文件不可写，原文件已保留".into());
        }
        geometry::save(
            &backend.path.with_file_name("window-layout.json"),
            &geometry,
        )?;
    }
    Ok(())
}
fn resize(window: &tauri::WebviewWindow, mode: &str, pinned: bool) -> Result<(), String> {
    let backend = window.state::<Backend>();
    *backend.geometry_ignore_until.lock().unwrap() =
        std::time::Instant::now() + Duration::from_millis(500);
    backend.geometry_changing.store(true, Ordering::SeqCst);
    let result = resize_impl(window, mode, pinned);
    backend.geometry_changing.store(false, Ordering::SeqCst);
    result
}
fn resize_impl(window: &tauri::WebviewWindow, mode: &str, pinned: bool) -> Result<(), String> {
    window
        .state::<Backend>()
        .compact_drag
        .store(mode == "compact", Ordering::SeqCst);
    if !["compact", "glance", "feed", "settings"].contains(&mode) {
        return Err("未知的窗口模式".into());
    }
    let saved = window
        .state::<Backend>()
        .geometry
        .lock()
        .unwrap()
        .sizes
        .get(mode)
        .copied()
        .unwrap_or(geometry::default_size(mode));
    let size = geometry::constrained(mode, saved);
    let (width, height) = (size.width, size.height);
    let monitor = window
        .current_monitor()
        .map_err(|_| "无法读取屏幕尺寸")?
        .or(window.primary_monitor().ok().flatten());
    let mut x = window
        .outer_position()
        .ok()
        .map(|p| p.x as f64)
        .unwrap_or(60.0);
    let mut y = window
        .outer_position()
        .ok()
        .map(|p| p.y as f64)
        .unwrap_or(60.0);
    let mut width: f64 = width;
    let mut height: f64 = height;
    if let Some(monitor) = monitor {
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        let left = area.position.x as f64 / scale;
        let top = area.position.y as f64 / scale;
        let screen_w = area.size.width as f64 / scale;
        let screen_h = area.size.height as f64 / scale;
        let old = window
            .inner_size()
            .map(|v| v.width as f64 / scale)
            .unwrap_or(width);
        x = x / scale + old - width;
        y /= scale;
        width = width.min(screen_w - 16.0);
        height = height.min(screen_h - 16.0);
        x = x.clamp(left + 8.0, left + screen_w - width - 8.0);
        y = y.clamp(top + 8.0, top + screen_h - height - 8.0);
    }
    window.set_resizable(false).map_err(|_| "无法调整窗口")?;
    let _ = window.set_max_size(None::<tauri::LogicalSize<f64>>);
    window
        .set_min_size(Some(tauri::LogicalSize::new(0.0, 0.0)))
        .map_err(|_| "无法调整窗口")?;
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|_| "无法调整窗口")?;
    // Wayland compositors may deny application positioning or topmost requests.
    // Keep the usable window visible even when these optional hints are ignored.
    let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    apply_pin(window, pinned)?;
    let _ = window.set_min_size(Some(tauri::LogicalSize::new(
        if mode == "compact" {
            180.0_f64.min(width)
        } else {
            320.0_f64.min(width)
        },
        if mode == "compact" {
            34.0
        } else {
            220.0_f64.min(height)
        },
    )));
    if mode == "compact" {
        let _ = window.set_max_size(Some(tauri::LogicalSize::new(4000., 34.)));
    }
    let _ = window.set_resizable(true);
    window.state::<Backend>().geometry.lock().unwrap().mode = mode.into();
    window.show().map_err(|_| "无法显示窗口".into())
}
#[tauri::command]
fn open_original(url: String) -> Result<(), String> {
    let url = url::Url::parse(&url).map_err(|_| "无效的原文链接")?;
    if !["https", "http"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("无效的原文链接".into());
    }
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(url.as_str()).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", url.as_str()])
        .spawn();
    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open")
        .arg(url.as_str())
        .spawn();
    result.map(|_| ()).map_err(|_| "无法打开默认浏览器".into())
}
#[tauri::command]
fn quit(app: tauri::AppHandle) {
    app.exit(0);
}

fn context() -> tauri::Context<tauri::Wry> {
    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    #[cfg(target_os = "macos")]
    {
        context.package_info_mut().name = branding::app_name().into();
    }
    context
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            load_state,
            inspect_source_packages,
            save_state,
            set_ai_paused,
            ai_usage,
            key_status,
            save_key,
            save_source_key,
            test_source,
            export_subscriptions,
            test_ai,
            refresh,
            set_paused,
            smoke_report,
            judge,
            judge_batch,
            prepare_ai_batch,
            presentation,
            set_pin,
            window_hover,
            drag_window,
            window_status,
            resize_window,
            prepare_window_resize,
            open_original,
            quit
        ])
        .setup(|app| {
            let smoke = std::env::args().any(|a| a == "--ui-smoke");
            let path = if smoke {
                std::env::temp_dir()
                    .join("NewsFloat-native-smoke")
                    .join("state.json")
            } else {
                app.path().app_data_dir()?.join("desktop-state.json")
            };
            let (disk, warning, writable) = if smoke {
                (DiskState::default(), None, false)
            } else {
                match storage::load(&path) {
                    Ok(disk) => (disk, None, true),
                    Err(e) => (DiskState::default(), Some(e), false),
                }
            };
            let pinned = disk.preferences.pinned;
            let (geometry, geometry_writable) = if smoke {
                (geometry::Geometry::default(), true)
            } else {
                match geometry::load(&path.with_file_name("window-layout.json")) {
                    Ok(g) => (g, true),
                    Err(_) => (geometry::Geometry::default(), false),
                }
            };
            let ai_gate = ai_control::Gate::load(
                path.with_file_name("ai-usage.json"),
                !disk.preferences.ai_enabled || disk.preferences.ai_paused,
            );
            app.manage(Backend {
                ai_gate,
                disk: Mutex::new(disk),
                credentials: credentials::Store::new(path.with_file_name("credentials.json")),
                writable,
                warning,
                path,
                client: network::client(),
                refreshing: AtomicBool::new(false),
                paused: AtomicBool::new(false),
                smoke,
                geometry: Mutex::new(geometry),
                geometry_writable,
                geometry_changing: AtomicBool::new(false),
                geometry_generation: AtomicU64::new(0),
                geometry_ignore_until: Mutex::new(std::time::Instant::now()),
                compact_drag: Arc::new(AtomicBool::new(true)),
            });
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let show = tauri::menu::MenuItem::with_id(app, "show", "查看快讯", true, None::<&str>)?;
            let settings =
                tauri::menu::MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
            let quit = tauri::menu::MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let ai_enabled = app
                .state::<Backend>()
                .disk
                .lock()
                .unwrap()
                .preferences
                .ai_enabled;
            let ai_toggle = tauri::menu::MenuItem::with_id(
                app,
                "toggle-ai",
                if ai_enabled { "关闭 AI" } else { "开启 AI" },
                true,
                None::<&str>,
            )?;
            let menu = tauri::menu::Menu::with_items(app, &[&show, &settings, &ai_toggle, &quit])?;
            app.manage(TrayAiControl {
                item: ai_toggle,
                enabled: AtomicBool::new(ai_enabled),
            });
            tauri::tray::TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip(branding::app_name())
                .menu(&menu)
                .on_menu_event(|app, event| {
                    if event.id.as_ref() == "toggle-ai" {
                        let enabled = app
                            .state::<Backend>()
                            .disk
                            .lock()
                            .unwrap()
                            .preferences
                            .ai_enabled;
                        if enabled {
                            let app = app.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = set_ai_paused(app, true, None, None, Some(false)).await;
                            });
                        } else {
                            let _ = app.emit("ai-configure", ());
                        }
                        return;
                    }
                    let mode = match event.id.as_ref() {
                        "show" => "feed",
                        "settings" => "settings",
                        "quit" => {
                            app.exit(0);
                            return;
                        }
                        _ => return,
                    };
                    if let Some(window) = app.get_webview_window("main") {
                        let pinned = app
                            .state::<Backend>()
                            .disk
                            .lock()
                            .unwrap()
                            .preferences
                            .pinned;
                        let _ = resize(&window, mode, pinned);
                        let _ = window.emit("presentation", mode);
                    }
                })
                .build(app)?;
            if let Some(window) = app.get_webview_window("main") {
                window.set_title(branding::app_name())?;
                #[cfg(target_os = "macos")]
                mac_window::install_compact_drag(
                    &window,
                    app.state::<Backend>().compact_drag.clone(),
                )?;
                if let Some(monitor) = window.primary_monitor()? {
                    let scale = monitor.scale_factor();
                    let area = monitor.work_area();
                    let _ = window.set_position(tauri::LogicalPosition::new(
                        (area.position.x + area.size.width as i32) as f64 / scale - 320.0,
                        area.position.y as f64 / scale + 24.0,
                    ));
                }
                let _ = resize(&window, "compact", pinned);
                let handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Resized(_) = event {
                        if let Some(w) = handle.get_webview_window("main") {
                            debounce_geometry(&w);
                        }
                    }
                    if let tauri::WindowEvent::Moved(position) = event {
                        if std::env::args().any(|a| a == "--trace-window") {
                            println!("WINDOW_MOVED {},{}", position.x, position.y);
                        }
                    }
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Some(window) = handle.get_webview_window("main") {
                            let pinned = handle
                                .state::<Backend>()
                                .disk
                                .lock()
                                .unwrap()
                                .preferences
                                .pinned;
                            let _ = resize(&window, "compact", pinned);
                            let _ = window.emit("presentation", "compact");
                        }
                    }
                });
            }
            let handle = app.handle().clone();
            #[cfg(target_os = "macos")]
            {
                let hover_handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let mut last = None;
                    let mut heartbeat = std::time::Instant::now();
                    loop {
                        if let Some(window) = hover_handle.get_webview_window("main") {
                            let inside = mac_window::hovered(&window).unwrap_or(false);
                            if last != Some(inside)
                                || heartbeat.elapsed() > Duration::from_millis(500)
                            {
                                let _ = window.emit("window-hover", inside);
                                last = Some(inside);
                                heartbeat = std::time::Instant::now();
                            }
                        }
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                });
            }
            tauri::async_runtime::spawn(async move {
                loop {
                    let interval = handle
                        .state::<Backend>()
                        .disk
                        .lock()
                        .unwrap()
                        .preferences
                        .interval
                        .clamp(30, 300);
                    tokio::time::sleep(Duration::from_secs(interval)).await;
                    if !handle.state::<Backend>().paused.load(Ordering::SeqCst) && !smoke {
                        let results = fetch_all(&handle).await;
                        let _ = handle.emit("feeds", results);
                    }
                }
            });
            Ok(())
        })
        .run(context())
        .expect("lingdong-news desktop runtime");
}

pub fn check_sources() {
    tauri::async_runtime::block_on(async {
        let client = network::client();
        for source in ["cls", "wallstreet", "jin10"] {
            let result = network::fetch(&client, source).await;
            if let Some(error) = result.error {
                println!("{source}: {error}");
            } else {
                let text = result.text.unwrap_or_default();
                let value: serde_json::Value =
                    serde_json::from_str(&text).expect("standard adapter JSON");
                println!(
                    "{source}: OK (standard JSON version {}, {} items)",
                    value["version"],
                    value["items"].as_array().map_or(0, Vec::len)
                );
            }
        }
    });
}

pub fn check_storage() {
    // Run as the signed app itself: do not use another process to bypass a
    // protected-file read. Read/save the new app-owned state, never old queues.
    let app = tauri::Builder::default()
        .build(context())
        .expect("storage check context");
    let path = app
        .path()
        .app_data_dir()
        .expect("application data directory")
        .join("desktop-state.json");
    match storage::load(&path).and_then(|state| {
        storage::save(&path, &state)?;
        let reopened = storage::load(&path)?;
        println!("STORAGE_CHECK {}", json!({"roundTrip":true,"cachedItems":reopened.items.len(),"keywordEnabled":reopened.preferences.keyword_enabled,"aiEnabled":reopened.preferences.ai_enabled}));
        Ok(())
    }) {
        Ok(()) => (),
        Err(error) => { eprintln!("STORAGE_CHECK {error}"); std::process::exit(1); }
    }
}

pub fn check_ai(path: &std::path::Path) -> i32 {
    live_check::run(path)
}

pub fn check_source_file(path: &std::path::Path) -> i32 {
    let Ok(bytes) = std::fs::read(path) else {
        return 1;
    };
    if bytes.len() > 1024 * 1024 {
        return 1;
    }
    let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return 1;
    };
    if value["version"] != 1 && value["version"] != 2 {
        return 1;
    }
    let Some(sources) = value["sources"].as_array_mut() else {
        return 1;
    };
    tauri::async_runtime::block_on(async {
        let mut failures = 0;
        for (index, item) in sources.iter_mut().enumerate() {
            let source = if item.get("manifest").is_some() {
                let parameters = item
                    .as_object_mut()
                    .and_then(|map| map.remove("parameters"));
                let Ok(package) = serde_json::from_value::<plugins::Package>(item.clone()) else {
                    println!("SOURCE_CHECK invalid_package");
                    failures += 1;
                    continue;
                };
                if plugins::check_syntax(&package).is_err() {
                    println!("SOURCE_CHECK invalid_script");
                    failures += 1;
                    continue;
                }
                let mut source = package.source();
                if let Some(value) = parameters {
                    let Ok(params) = serde_json::from_value::<
                        std::collections::BTreeMap<String, serde_json::Value>,
                    >(value) else {
                        failures += 1;
                        continue;
                    };
                    source.parameters.extend(params);
                }
                source
            } else if let Some(id) = item["builtin"].as_str() {
                let Some(source) = plugins::builtin(id) else {
                    failures += 1;
                    continue;
                };
                source
            } else {
                if item.get("id").is_none() {
                    item["id"] = json!(format!("custom:check-{index}"));
                }
                let Ok(source) = serde_json::from_value::<CustomSource>(item.clone()) else {
                    println!("SOURCE_CHECK invalid_directory_entry");
                    failures += 1;
                    continue;
                };
                source
            };
            if source.auth != "none" {
                println!("SOURCE_CHECK private_source_requires_app_test");
                failures += 1;
                continue;
            }
            let result = network::fetch_custom(&network::client(), &source, None).await;
            if let Some(error) = result.error {
                println!("SOURCE_CHECK {}", json!({"name":source.name,"error":error}));
                failures += 1;
            } else {
                let feed: serde_json::Value =
                    serde_json::from_str(result.text.as_deref().unwrap_or_default())
                        .unwrap_or_default();
                let valid = feed["version"] == 1 && feed["items"].is_array();
                if !valid {
                    failures += 1;
                }
                println!(
                    "SOURCE_CHECK {}",
                    json!({"name":source.name,"format":source.format,"version":feed["version"],"items":feed["items"].as_array().map_or(0,Vec::len),"valid":valid})
                );
            }
        }
        if failures == 0 {
            0
        } else {
            1
        }
    })
}

#[cfg(test)]
mod subscription_tests {
    use super::*;
    #[test]
    fn package_updates_and_parameter_edits_invalidate_inflight_results_but_an_identical_builtin_copy_does_not(
    ) {
        let mut prefs = model::Preferences::default();
        let revision = subscription_revision(&prefs, "cls");
        prefs.custom_sources.push(plugins::builtin("cls").unwrap());
        assert_eq!(subscription_revision(&prefs, "cls"), revision);
        prefs.custom_sources[0]
            .plugin
            .as_mut()
            .unwrap()
            .script
            .push_str("\n// updated adapter\n");
        assert_ne!(subscription_revision(&prefs, "cls"), revision);
        let updated = subscription_revision(&prefs, "cls");
        prefs.custom_sources[0]
            .parameters
            .insert("changed".into(), json!(true));
        assert_ne!(subscription_revision(&prefs, "cls"), updated);
    }
}
