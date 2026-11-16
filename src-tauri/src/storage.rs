use crate::model::{DiskState, Preferences};
use std::{io::Write, path::Path};

pub fn save(path: &Path, state: &DiskState) -> Result<(), String> {
    if state.analysis_history.len() > 10000
        || state.playback_history.len() > 10000
        || state.items.len() > 1000
        || state.read_stories.len() > 3000
        || state.unread.len() > 10000
        || state.analysis_pending.len() > 10000
    {
        return Err("缓存超过容量，请先处理待看消息；原文件已保留".into());
    }
    let data = serde_json::to_vec(state).map_err(|_| "无法编码缓存")?;
    if data.len() > 16 * 1024 * 1024 {
        return Err("缓存超过容量；原文件已保留".into());
    }
    let dir = path.parent().ok_or("无效的缓存目录")?;
    std::fs::create_dir_all(dir).map_err(|_| "无法创建应用数据目录")?;
    let mut temp = tempfile::NamedTempFile::new_in(dir).map_err(|_| "无法写入应用数据目录")?;
    temp.write_all(&data)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|_| "本地缓存写入失败；原文件已保留")?;
    temp.persist(path)
        .map_err(|_| "无法替换缓存；原文件已保留")?;
    Ok(())
}
pub fn load(path: &Path) -> Result<DiskState, String> {
    match std::fs::read(path) {
        Ok(bytes) if bytes.len() <= 16 * 1024 * 1024 => serde_json::from_slice(&bytes)
            .map_err(|_| "缓存格式异常，原文件已保留；本次使用内存模式".into()),
        Ok(_) => Err("缓存超过容量，原文件已保留；本次使用内存模式".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(DiskState {
            preferences: legacy_preferences().unwrap_or_default(),
            ..Default::default()
        }),
        Err(_) => Err("系统拒绝读取应用缓存，原文件已保留；本次使用内存模式".into()),
    }
}
fn legacy_preferences() -> Option<Preferences> {
    // Import only old settings. The old protected news/inbox files are never touched.
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")?;
        let path = Path::new(&home).join("Library/Preferences/local.newsfloat.mac.plist");
        let root = plist::Value::from_file(path).ok()?;
        let bytes = root.as_dictionary()?.get("preferences")?.as_data()?;
        serde_json::from_slice(bytes).ok()
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disabled_ai_keeps_positive_and_negative_history_on_disk_and_old_caches_default_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let mut state = DiskState::default();
        state.analysis_history=serde_json::from_value(serde_json::json!([
            {"key":"positive","savedAt":1,"judgement":{"probability":1.0,"model":"test","fingerprint":"positive","contextFingerprint":"positive","kind":"json","relevant":true}},
            {"key":"negative","savedAt":2,"judgement":{"probability":0.0,"model":"test","fingerprint":"negative","contextFingerprint":"negative","kind":"json","relevant":false}}
        ])).unwrap();
        save(&path, &state).unwrap();
        let loaded = load(&path).unwrap();
        assert!(!loaded.preferences.ai_enabled);
        assert_eq!(loaded.analysis_history.len(), 2);
        assert_eq!(loaded.analysis_history[1].judgement.relevant, Some(false));
        assert!(serde_json::from_str::<DiskState>("{}")
            .unwrap()
            .analysis_history
            .is_empty());
    }
    #[test]
    fn old_cache_importance_is_ignored_and_new_settings_default_safely() {
        let state:DiskState=serde_json::from_value(serde_json::json!({"items":[{
            "id":"cls:old","source":"cls","title":"","body":"旧正文","publishedAt":1,"url":"","important":true
        }]})).unwrap();
        assert!(state.items[0].tags.is_empty());
        assert!(state.analysis_pending.is_empty());
        assert_eq!(state.preferences.ai.batch_size, 8);
        assert_eq!(state.preferences.ai.concurrency, 2);
        assert!(include_str!("../../src/core.ts").contains(crate::model::default_system_prompt()));
        let encoded = serde_json::to_value(state).unwrap();
        assert!(encoded["items"][0].get("important").is_none());
    }

    #[test]
    fn atomic_state_and_no_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let state = DiskState::default();
        save(&path, &state).unwrap();
        save(&path, &state).unwrap();
        assert!(!load(&path).unwrap().preferences.ai_enabled);
        assert!(!std::fs::read_to_string(&path).unwrap().contains("apiKey"));
        assert!(serde_json::from_str::<DiskState>(r#"{"apiKey":"secret"}"#).is_err());
    }
    #[test]
    fn uninstalled_channels_survive_disk_roundtrip_and_old_preferences_default_to_preinstalled() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let mut state = DiskState::default();
        state.preferences.sources.retain(|id| id != "cls");
        state.preferences.uninstalled_sources.push("cls".into());
        save(&path, &state).unwrap();
        let loaded = load(&path).unwrap();
        assert_eq!(loaded.preferences.uninstalled_sources, vec!["cls"]);
        assert!(!loaded.preferences.sources.contains(&"cls".into()));
        let old: Preferences = serde_json::from_str(r#"{"sources":["wallstreet"]}"#).unwrap();
        assert!(old.uninstalled_sources.is_empty());
        assert_eq!(old.sources, vec!["wallstreet"]);
    }
    #[test]
    fn corrupt_state_is_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::fs::write(&path, "corrupt").unwrap();
        assert!(load(&path).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "corrupt");
    }
    #[test]
    fn legacy_swift_preferences_keep_config_without_enabling_filters() {
        let prefs: Preferences = serde_json::from_str(r#"{"sources":["cls","wallstreet"],"interval":60,"pinned":true,"keywords":"芯片","keywordEnabled":false,"interests":"AI 新闻","aiEnabled":false,"ai":{"apiURL":"https://openrouter.ai/api/alpha/decisions","model":"typesafe/jev-1.14","format":"decisions"},"threshold":0.7}"#).unwrap();
        assert_eq!(prefs.keywords, "芯片");
        assert_eq!(
            prefs.ai.api_url,
            "https://openrouter.ai/api/alpha/decisions"
        );
        assert!(!prefs.keyword_enabled && !prefs.ai_enabled);
        assert!(prefs.auto_scroll);
    }

    #[test]
    fn playback_defaults_on_for_old_state_and_completed_versions_roundtrip() {
        let mut state: DiskState =
            serde_json::from_str(r#"{"preferences":{},"items":[]}"#).unwrap();
        assert!(state.preferences.skip_played);
        assert!(state.playback_history.is_empty());
        state.playback_history.push(crate::model::PlaybackRecord {
            id: "cls:one".into(),
            key: "deadbeef".into(),
            published_at: 1000.,
            played_at: 2000.,
        });
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        save(&path, &state).unwrap();
        let restored = load(&path).unwrap();
        assert!(restored.preferences.skip_played);
        assert_eq!(restored.playback_history.len(), 1);
        assert_eq!(restored.playback_history[0].id, "cls:one");
        assert_eq!(restored.playback_history[0].key, "deadbeef");
    }
}
