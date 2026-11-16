use std::{collections::BTreeMap, io::Write, path::PathBuf, sync::Mutex};

// Separate from news/preferences: never serialized to the webview or exports.
pub struct Store {
    path: PathBuf,
    access: Mutex<()>,
}

impl Store {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            access: Mutex::new(()),
        }
    }

    fn load(&self) -> Result<BTreeMap<String, String>, String> {
        match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| "本地 Key 文件格式异常，原文件已保留".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(_) => Err("无法读取本地 Key 文件".into()),
        }
    }

    pub fn get(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        let _guard = self.access.lock().map_err(|_| "本地 Key 文件暂不可用")?;
        Ok(self.load()?.remove(&format!("{service}:{account}")))
    }

    pub fn set(&self, service: &str, account: &str, key: &str) -> Result<(), String> {
        let _guard = self.access.lock().map_err(|_| "本地 Key 文件暂不可用")?;
        let mut keys = self.load()?;
        let id = format!("{service}:{account}");
        let key = key.trim();
        if key.is_empty() {
            keys.remove(&id);
        } else {
            keys.insert(id, key.into());
        }
        let directory = self.path.parent().ok_or("无效的本地 Key 目录")?;
        std::fs::create_dir_all(directory).map_err(|_| "无法创建本地 Key 目录")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| "无法设置本地 Key 目录权限")?;
        }
        let mut file =
            tempfile::NamedTempFile::new_in(directory).map_err(|_| "无法创建本地 Key 文件")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|_| "无法设置本地 Key 文件权限")?;
        }
        let data = serde_json::to_vec_pretty(&keys).map_err(|_| "无法编码本地 Key 文件")?;
        file.write_all(&data)
            .and_then(|_| file.as_file().sync_all())
            .map_err(|_| "本地 Key 保存失败，原文件已保留")?;
        file.persist(&self.path)
            .map_err(|_| "无法替换本地 Key 文件，原文件已保留")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_survive_restart_and_accounts_and_sources_are_independent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("credentials.json");
        let store = Store::new(path.clone());
        assert_eq!(store.get("ai", "https://example.com").unwrap(), None);
        store
            .set("ai", "https://example.com", " test-only-ai ")
            .unwrap();
        store
            .set("ai", "https://another.example", "test-only-other")
            .unwrap();
        store
            .set("source", "https://example.com", "test-only-source")
            .unwrap();
        let restarted = Store::new(path);
        assert_eq!(
            restarted
                .get("ai", "https://example.com")
                .unwrap()
                .as_deref(),
            Some("test-only-ai")
        );
        restarted.set("ai", "https://example.com", "").unwrap();
        assert_eq!(store.get("ai", "https://example.com").unwrap(), None);
        assert_eq!(
            store
                .get("ai", "https://another.example")
                .unwrap()
                .as_deref(),
            Some("test-only-other")
        );
        assert_eq!(
            store
                .get("source", "https://example.com")
                .unwrap()
                .as_deref(),
            Some("test-only-source")
        );
    }

    #[test]
    fn concurrent_saves_do_not_lose_other_keys_and_corrupt_files_are_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("credentials.json");
        let store = std::sync::Arc::new(Store::new(path.clone()));
        let tasks: Vec<_> = (0..8)
            .map(|n| {
                let store = store.clone();
                std::thread::spawn(move || {
                    store
                        .set("source", &n.to_string(), "test-only-key")
                        .unwrap()
                })
            })
            .collect();
        for task in tasks {
            task.join().unwrap();
        }
        assert_eq!(store.load().unwrap().len(), 8);
        std::fs::write(&path, "broken").unwrap();
        assert!(store.set("ai", "endpoint", "test-only-key").is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "broken");
    }

    #[cfg(unix)]
    #[test]
    fn key_file_is_private_after_creation_and_replacement() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("keys/credentials.json");
        let store = Store::new(path.clone());
        for value in ["test-only-first", "test-only-second"] {
            store.set("ai", "endpoint", value).unwrap();
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                std::fs::metadata(path.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
    }
}
