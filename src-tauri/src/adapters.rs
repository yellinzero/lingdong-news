// Every adapter returns the same {version:1,items:[...]} JSON contract.
// Neither the consumer nor AI needs to know whether upstream was XML or JSON.
use crate::{
    model::{AdapterRules, CustomSource},
    syndication,
};
use serde_json::{json, Value};

pub struct Output {
    pub feed: Value,
    pub warning: Option<String>,
}
fn envelope(items: Vec<Value>) -> Value {
    json!({"version":1,"items":items})
}
fn string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
fn at<'a>(value: &'a Value, path: &str) -> &'a Value {
    if path.is_empty() {
        return value;
    }
    let mut current = value;
    for part in path.split('.') {
        current = if let Some(map) = current.as_object() {
            map.get(part).unwrap_or(&Value::Null)
        } else if let Some(list) = current.as_array() {
            part.parse::<usize>()
                .ok()
                .and_then(|i| list.get(i))
                .unwrap_or(&Value::Null)
        } else {
            return &Value::Null;
        };
    }
    current
}
fn date(value: &Value, unit: &str, timezone: &str) -> Result<f64, String> {
    match unit {
        "seconds" | "milliseconds" => value
            .as_f64()
            .or_else(|| value.as_str().and_then(|v| v.parse().ok()))
            .filter(|n: &f64| n.is_finite())
            .map(|n| if unit == "seconds" { n * 1000.0 } else { n })
            .ok_or("适配器时间字段须为数字".into()),
        "iso" | "local" => {
            let value = value.as_str().ok_or("适配器时间字段须为字符串")?;
            let text = if unit == "local" {
                format!("{}{}", value.replace(' ', "T"), timezone)
            } else {
                value.to_string()
            };
            chrono::DateTime::parse_from_rfc3339(&text)
                .map(|d| d.timestamp_millis() as f64)
                .map_err(|_| "适配器日期格式或时区无效".into())
        }
        _ => Err("未知适配器时间单位".into()),
    }
}
pub fn validate_rules(rules: &AdapterRules) -> Result<(), String> {
    let mut paths = vec![
        &rules.items_path,
        &rules.id_path,
        &rules.title_path,
        &rules.date_path,
        &rules.url_path,
        &rules.tags_path,
    ];
    paths.extend(rules.body_paths.iter());
    paths.extend(rules.exclude.iter().map(|e| &e.path));
    if rules.body_paths.is_empty()
        || rules.body_paths.len() > 8
        || rules.exclude.len() > 16
        || rules.id_path.is_empty()
        || rules.date_path.is_empty()
        || paths.iter().any(|p| {
            p.len() > 200
                || p.split('.').count() > 16
                || !p
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        })
    {
        return Err("适配器字段路径无效；只支持点号路径和数组下标".into());
    }
    if !["seconds", "milliseconds", "iso", "local"].contains(&rules.date_unit.as_str()) {
        return Err("适配器时间单位无效".into());
    }
    if rules.date_unit == "local"
        && !(rules.timezone.is_ascii()
            && rules.timezone.len() == 6
            && ["+", "-"].contains(&&rules.timezone[..1])
            && rules.timezone.as_bytes()[3] == b':'
            && rules.timezone[1..3].bytes().all(|c| c.is_ascii_digit())
            && rules.timezone[4..].bytes().all(|c| c.is_ascii_digit()))
    {
        return Err("本地日期须指定如 +08:00 的时区".into());
    }
    if rules.json_prefix.len() > 100 || rules.url_template.len() > 2048 {
        return Err("适配器前缀或 URL 模板过长".into());
    }
    if !rules.url_template.is_empty() {
        let url = url::Url::parse(&rules.url_template.replace("{id}", "item"))
            .map_err(|_| "原文链接模板无效")?;
        if !["http", "https"].contains(&url.scheme())
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("原文链接模板须为 HTTP/HTTPS".into());
        }
    }
    for rule in &rules.exclude {
        if !["truthy", "gt", "contains"].contains(&rule.op.as_str()) {
            return Err("未知适配器过滤条件".into());
        }
    }
    Ok(())
}
pub fn map_json(raw: &str, rules: &AdapterRules) -> Result<Value, String> {
    validate_rules(rules)?;
    let raw = raw.trim();
    let raw = if rules.json_prefix.is_empty() {
        raw
    } else {
        raw.strip_prefix(&rules.json_prefix)
            .ok_or("来源未包含指定的 JSON 前缀")?
            .trim()
            .trim_end_matches(';')
            .trim()
    };
    let value: Value = serde_json::from_str(raw).map_err(|_| "适配器上游未返回合法 JSON")?;
    let rows = at(&value, &rules.items_path)
        .as_array()
        .ok_or("适配器 itemsPath 未指向数组")?;
    if rows.len() > 1000 {
        return Err("适配器单次最多1,000条".into());
    }
    let mut items = Vec::new();
    for row in rows {
        if rules.exclude.iter().any(|rule| {
            let field = at(row, &rule.path);
            match rule.op.as_str() {
                "truthy" => truthy(field),
                "gt" => field
                    .as_f64()
                    .zip(rule.value.as_f64())
                    .is_some_and(|(a, b)| a > b),
                "contains" => field
                    .as_array()
                    .is_some_and(|values| values.contains(&rule.value)),
                _ => false,
            }
        }) {
            continue;
        }
        let id = string(at(row, &rules.id_path));
        if id.is_empty() {
            return Err("适配器新闻缺少稳定 ID".into());
        }
        let title = syndication::plain(&string(at(row, &rules.title_path)), true);
        let mut body = rules
            .body_paths
            .iter()
            .map(|p| syndication::plain(&string(at(row, p)), true))
            .find(|s| !s.is_empty())
            .unwrap_or_default();
        if body.is_empty() {
            if title.is_empty() {
                continue;
            }
            body = title.clone();
        }
        let published_at = date(at(row, &rules.date_path), &rules.date_unit, &rules.timezone)?;
        let mut url = if rules.url_path.is_empty() {
            String::new()
        } else {
            string(at(row, &rules.url_path))
        };
        if url.is_empty() && !rules.url_template.is_empty() {
            let encoded: String = url::form_urlencoded::byte_serialize(id.as_bytes()).collect();
            url = rules.url_template.replace("{id}", &encoded);
        }
        let tags = if rules.tags_path.is_empty() {
            Vec::new()
        } else {
            at(row, &rules.tags_path)
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default()
        };
        items.push(json!({"id":id,"title":title,"body":body,"publishedAt":published_at,"url":url,"tags":tags}));
    }
    Ok(envelope(items))
}
pub fn custom(raw: &str, source: &CustomSource, now: u64) -> Result<Output, String> {
    if source.format == "adapter" {
        return Ok(Output {
            feed: map_json(raw, source.adapter.as_ref().ok_or("缺少适配器规则")?)?,
            warning: None,
        });
    }
    if source.format == "json"
        || source.format == "auto"
            && serde_json::from_str::<Value>(raw)
                .ok()
                .is_some_and(|v| v["version"] == 1)
    {
        let feed: Value = serde_json::from_str(raw).map_err(|_| "来源未返回合法 JSON")?;
        if feed["version"] != 1 || !feed["items"].is_array() {
            return Err("来源须返回 version:1 和 items 数组".into());
        }
        return Ok(Output {
            feed,
            warning: None,
        });
    }
    let parsed = syndication::parse(raw, source, now)?;
    let items=parsed.items.into_iter().map(|item|{
        let prefix=format!("{}:",source.id);let id=item.id.strip_prefix(&prefix).unwrap_or(&item.id);
        json!({"id":id,"title":item.title,"body":item.body,"publishedAt":item.published_at,"url":item.url,"tags":item.tags,"dateEstimated":item.date_estimated})
    }).collect();
    Ok(Output {
        feed: envelope(items),
        warning: parsed.warning,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source(format: &str) -> CustomSource {
        CustomSource {
            id: "custom:demo".into(),
            name: "测试源".into(),
            url: "https://example.com/feed".into(),
            format: format.into(),
            adapter: None,
            folder: String::new(),
            plugin: None,
            parameters: Default::default(),
            auth: "none".into(),
        }
    }
    #[test]
    fn rss_and_passthrough_json_exit_through_the_same_envelope() {
        let raw = r#"<rss version="2.0"><channel><title>测试</title><link>https://example.com</link><description>测试</description><item><guid>item-1</guid><title>标题</title><description>正文</description></item></channel></rss>"#;
        let output = custom(raw, &source("feed"), 1794702600000).unwrap();
        assert_eq!(output.feed["version"], 1);
        assert_eq!(output.feed["items"][0]["id"], "item-1");
        assert_eq!(output.feed["items"][0]["dateEstimated"], true);
        let standard = output.feed.to_string();
        assert_eq!(
            custom(&standard, &source("json"), 1794702600000)
                .unwrap()
                .feed,
            output.feed
        );
        assert_eq!(
            custom(&standard, &source("auto"), 1794702600000)
                .unwrap()
                .feed,
            output.feed
        );
    }
    #[test]
    fn imported_local_adapter_needs_no_hosted_normalization_service() {
        let rules:AdapterRules=serde_json::from_value(json!({"itemsPath":"payload.rows","idPath":"key","bodyPaths":["text"],"datePath":"time","dateUnit":"milliseconds","tagsPath":"topics","urlTemplate":"https://example.com/article/{id}"})).unwrap();
        let source = CustomSource {
            format: "adapter".into(),
            adapter: Some(rules),
            ..source("adapter")
        };
        let output=custom(r#"{"payload":{"rows":[{"key":"a/b","text":"本地转换后的完整正文","time":1794702600000,"topics":["测试"]}]}}"#,&source,1794702600000).unwrap();
        assert_eq!(output.feed["items"][0]["id"], "a/b");
        assert_eq!(
            output.feed["items"][0]["url"],
            "https://example.com/article/a%2Fb"
        );
        assert_eq!(output.feed["items"][0]["tags"], json!(["测试"]));
    }
    #[test]
    fn malformed_rules_are_rejected_without_running_code() {
        let mut rules: AdapterRules =
            serde_json::from_value(json!({"itemsPath":"rows","idPath":"id","bodyPaths":["body"],"datePath":"time","dateUnit":"local","timezone":"+08:00"}))
                .unwrap();
        rules.timezone = "你abc".into();
        assert!(validate_rules(&rules).is_err());
        rules.timezone = "+08:00".into();
        rules.id_path = "eval(alert(1))".into();
        assert!(validate_rules(&rules).is_err());
    }
}
