use crate::model::{CustomSource, NewsItem};
use sha1::{Digest, Sha1};
use std::collections::HashSet;
use url::Url;
pub struct Parsed {
    pub items: Vec<NewsItem>,
    pub warning: Option<String>,
}
fn digest(value: &str) -> String {
    format!("{:x}", Sha1::digest(value.as_bytes()))
}
pub fn plain(value: &str, html: bool) -> String {
    if !html {
        return value.trim().to_string();
    }
    let mut out = String::new();
    let mut pos = 0;
    let lower = value.to_ascii_lowercase();
    while pos < value.len() {
        if value.as_bytes()[pos] != b'<' {
            let c = value[pos..].chars().next().unwrap();
            out.push(c);
            pos += c.len_utf8();
            continue;
        }
        let mut quote = None;
        let mut end = None;
        for (offset, c) in value[pos + 1..].char_indices() {
            if let Some(q) = quote {
                if c == q {
                    quote = None;
                }
            } else if c == '"' || c == '\'' {
                quote = Some(c);
            } else if c == '>' {
                end = Some(pos + 1 + offset);
                break;
            }
        }
        let Some(end) = end else {
            out.push_str(&value[pos..]);
            break;
        };
        let tag = value[pos + 1..end].trim();
        let name = tag
            .trim_start_matches('/')
            .split([' ', '\t', '\n', '/'])
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        if name.is_empty() || !name.as_bytes()[0].is_ascii_alphabetic() {
            out.push('<');
            pos += 1;
            continue;
        }
        if ["script", "style", "iframe"].contains(&name.as_str()) && !tag.starts_with('/') {
            if let Some(close) = lower[end + 1..].find(&format!("</{name}")) {
                pos = end + 1 + close;
                if let Some(close_end) = value[pos..].find('>') {
                    pos += close_end + 1;
                } else {
                    break;
                }
            } else {
                break;
            }
            continue;
        }
        if [
            "p",
            "br",
            "div",
            "li",
            "article",
            "section",
            "h1",
            "h2",
            "h3",
            "tr",
            "blockquote",
        ]
        .contains(&name.as_str())
        {
            out.push('\n');
        }
        pos = end + 1;
    }
    let decoded = quick_xml::escape::unescape(&out)
        .map(|s| s.into_owned())
        .unwrap_or(out);
    decoded
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}
fn is_html(mime: &str) -> bool {
    mime.contains("html")
}
pub fn parse(raw: &str, source: &CustomSource, now: u64) -> Result<Parsed, String> {
    if raw.len() > 4 * 1024 * 1024 {
        return Err("订阅响应超过4 MiB".into());
    }
    let upper = raw.to_ascii_uppercase();
    if upper.contains("<!DOCTYPE") || upper.contains("<!ENTITY") {
        return Err("订阅包含不支持的 XML 实体声明".into());
    }
    let parser = feed_rs::parser::Builder::new()
        .base_uri(Some(&source.url))
        .id_generator(|links, title, base| {
            let link = links
                .iter()
                .find(|l| l.rel.as_deref().is_none_or(|r| r == "alternate"))
                .map(|l| l.href.as_str())
                .unwrap_or("");
            let title = title.as_ref().map(|t| t.content.as_str()).unwrap_or("");
            if link.is_empty() && title.is_empty() {
                String::new()
            } else {
                format!(
                    "generated:{}",
                    digest(&format!("{}|{link}|{title}", base.unwrap_or("")))
                )
            }
        })
        .build();
    let feed = parser
        .parse(raw.as_bytes())
        .map_err(|_| "无法识别订阅格式，请使用 RSS、Atom 或 JSON Feed 的订阅地址")?;
    if feed.entries.len() > 500 {
        return Err("单次订阅超过500条，请使用条数较少的订阅地址".into());
    }
    let mut items = Vec::new();
    let mut ids = HashSet::new();
    let mut estimated = 0;
    for (index, entry) in feed.entries.into_iter().enumerate() {
        let title = entry
            .title
            .as_ref()
            .map(|t| plain(&t.content, is_html(t.content_type.as_ref())))
            .unwrap_or_default();
        let body = entry
            .content
            .as_ref()
            .and_then(|c| {
                c.body
                    .as_ref()
                    .map(|b| plain(b, is_html(c.content_type.as_ref())))
            })
            .filter(|b| !b.is_empty())
            .or_else(|| {
                entry
                    .summary
                    .as_ref()
                    .map(|s| plain(&s.content, is_html(s.content_type.as_ref())))
                    .filter(|s| !s.is_empty())
            })
            .unwrap_or_else(|| title.clone());
        if title.is_empty() && body.is_empty() {
            return Err(format!("第{}条订阅缺少可读的标题和正文", index + 1));
        }
        if body.chars().count() > 32000 || title.chars().count() > 1000 {
            return Err(format!("第{}条订阅正文过长；已保留上次缓存", index + 1));
        }
        let url = entry
            .links
            .iter()
            .filter(|l| l.rel.as_deref().is_none_or(|r| r == "alternate"))
            .filter_map(|l| Url::parse(&l.href).ok())
            .find(|u| {
                ["http", "https"].contains(&u.scheme())
                    && u.username().is_empty()
                    && u.password().is_none()
            })
            .map(|u| u.to_string())
            .unwrap_or_default();
        let remote_id = if entry.id.trim().is_empty() {
            format!("content:{}", digest(&format!("{title}|{body}")))
        } else {
            entry.id.clone()
        };
        let id = format!("{}:{remote_id}", source.id);
        if !ids.insert(id.clone()) {
            return Err("订阅内有重复条目 ID，已保留缓存，请检查来源".into());
        }
        let timestamp = entry
            .published
            .or(entry.updated)
            .map(|d| d.timestamp_millis())
            .filter(|t| *t > 0 && *t <= now as i64 + 86_400_000);
        let date_estimated = timestamp.is_none();
        if date_estimated {
            estimated += 1;
        }
        let published_at = timestamp.unwrap_or(now.saturating_sub(index as u64) as i64) as f64;
        let mut tags = Vec::new();
        for category in entry.categories {
            let tag = category
                .label
                .unwrap_or(category.term)
                .trim()
                .chars()
                .take(24)
                .collect::<String>();
            if !tag.is_empty() && !tags.contains(&tag) && tags.len() < 8 {
                tags.push(tag);
            }
        }
        items.push(NewsItem {
            updated_at: None,
            id,
            source: source.id.clone(),
            title,
            body,
            published_at,
            date_estimated,
            url,
            _legacy_important: false,
            tags,
            judgement: None,
        });
    }
    Ok(Parsed {
        items,
        warning: (estimated > 0)
            .then(|| format!("{estimated}条没有有效发布时间，按首次发现时间显示")),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn source() -> CustomSource {
        CustomSource {
            id: "custom:rss".into(),
            name: "测试".into(),
            url: "https://example.com/feed".into(),
            format: "auto".into(),
            adapter: None,
            folder: String::new(),
            plugin: None,
            parameters: Default::default(),
            auth: "none".into(),
        }
    }
    #[test]
    fn rss_full_content_categories_and_ids_are_stable() {
        let raw = r#"<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>测试</title><link>https://example.com</link><description>测试</description><item><guid>one</guid><title>标题</title><link>/news/one</link><description>短摘要</description><content:encoded><![CDATA[<p>完整&nbsp;正文 &amp; 详情</p><p>第二段<script>doNotRun()</script></p>]]></content:encoded><pubDate>Sun, 15 Nov 2026 08:30:00 +0800</pubDate><category>半导体</category></item></channel></rss>"#;
        let parsed = parse(raw, &source(), 1794733200000).unwrap();
        let item = &parsed.items[0];
        assert_eq!(item.id, "custom:rss:one");
        assert_eq!(item.url, "https://example.com/news/one");
        assert!(item.body.contains("第二段"));
        assert!(!item.body.contains("doNotRun"));
        assert_eq!(item.tags, vec!["半导体"]);
        assert!(!item.date_estimated);
    }
    #[test]
    fn atom_handles_namespace_xhtml_updated_and_relative_links() {
        let raw = r#"<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://example.com/"><title>测试</title><id>urn:feed:test</id><updated>2026-11-15T00:30:00Z</updated><entry><id>urn:news:one</id><title>Atom标题</title><updated>2026-11-15T00:30:00Z</updated><link rel="alternate" href="news/one"/><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>完整正文</p><p>第二段</p></div></content><category term="科技"/></entry></feed>"#;
        let parsed = parse(raw, &source(), 1794733200000).unwrap();
        assert_eq!(parsed.items[0].url, "https://example.com/news/one");
        assert!(parsed.items[0].body.contains("第二段"));
        assert_eq!(parsed.items[0].tags, vec!["科技"]);
    }
    #[test]
    fn undated_and_missing_ids_are_stable_across_polls() {
        let raw = r#"<rss version="2.0"><channel><title>测试</title><link>https://example.com</link><description>测试</description><item><title>无日期新闻</title><description>完整正文</description></item></channel></rss>"#;
        let a = parse(raw, &source(), 1794733200000).unwrap();
        let b = parse(raw, &source(), 1794733260000).unwrap();
        assert_eq!(a.items[0].id, b.items[0].id);
        assert!(a.items[0].date_estimated);
        assert!(a.warning.is_some());
    }
    #[test]
    fn json_feed_works_and_malformed_or_entity_xml_is_rejected() {
        let raw = r#"{"version":"https://jsonfeed.org/version/1.1","title":"测试","items":[{"id":"json-one","content_text":"JSON Feed正文","date_published":"2026-11-15T00:30:00Z","tags":["新闻"]}]}"#;
        assert_eq!(
            parse(raw, &source(), 1794733200000).unwrap().items[0].body,
            "JSON Feed正文"
        );
        for raw in [
            "<html><body>网页</body></html>",
            "<rss><item>",
            "<!DOCTYPE rss [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><rss/>",
        ] {
            assert!(parse(raw, &source(), 1794733200000).is_err());
        }
    }
}
