use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, io::Write, path::Path};
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}
#[derive(Default, Serialize, Deserialize)]
pub struct Geometry {
    pub sizes: BTreeMap<String, Size>,
    #[serde(skip)]
    pub mode: String,
}
pub fn default_size(mode: &str) -> Size {
    match mode {
        "compact" => Size {
            width: 300.,
            height: 34.,
        },
        "glance" => Size {
            width: 380.,
            height: 320.,
        },
        "settings" => Size {
            width: 480.,
            height: 730.,
        },
        _ => Size {
            width: 480.,
            height: 700.,
        },
    }
}
pub fn constrained(mode: &str, size: Size) -> Size {
    Size {
        width: if size.width.is_finite() {
            size.width
                .clamp(if mode == "compact" { 180. } else { 320. }, 4000.)
        } else {
            default_size(mode).width
        },
        height: if mode == "compact" {
            34.
        } else if size.height.is_finite() {
            size.height.clamp(220., 2400.)
        } else {
            default_size(mode).height
        },
    }
}
pub fn load(path: &Path) -> Result<Geometry, String> {
    match std::fs::read(path) {
        Ok(data) => {
            serde_json::from_slice(&data).map_err(|_| "窗口尺寸记录异常，原文件已保留".into())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Geometry::default()),
        Err(_) => Err("无法读取窗口尺寸记录，原文件已保留".into()),
    }
}
pub fn save(path: &Path, value: &Geometry) -> Result<(), String> {
    let dir = path.parent().ok_or("无效的窗口设置目录")?;
    std::fs::create_dir_all(dir).map_err(|_| "无法创建窗口设置目录")?;
    let mut temp = tempfile::NamedTempFile::new_in(dir).map_err(|_| "无法保存窗口尺寸")?;
    temp.write_all(&serde_json::to_vec(value).map_err(|_| "无法编码窗口尺寸")?)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|_| "无法保存窗口尺寸")?;
    temp.persist(path).map_err(|_| "无法替换窗口尺寸记录")?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remembers_each_presentation_and_locks_compact_height() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("window.json");
        let mut g = Geometry::default();
        g.sizes.insert(
            "compact".into(),
            constrained(
                "compact",
                Size {
                    width: 620.,
                    height: 500.,
                },
            ),
        );
        g.sizes.insert(
            "glance".into(),
            constrained(
                "glance",
                Size {
                    width: 580.,
                    height: 490.,
                },
            ),
        );
        save(&path, &g).unwrap();
        let restored = load(&path).unwrap();
        assert_eq!(
            restored.sizes["compact"],
            Size {
                width: 620.,
                height: 34.
            }
        );
        assert_eq!(
            restored.sizes["glance"],
            Size {
                width: 580.,
                height: 490.
            }
        );
        assert!(!restored.sizes.contains_key("feed"));
    }
    #[test]
    fn limits_invalid_sizes() {
        assert_eq!(
            constrained(
                "compact",
                Size {
                    width: f64::NAN,
                    height: 0.
                }
            ),
            default_size("compact")
        );
        assert_eq!(
            constrained(
                "feed",
                Size {
                    width: 0.,
                    height: 10.
                }
            ),
            Size {
                width: 320.,
                height: 220.
            }
        );
    }
}
