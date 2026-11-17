use crate::model::{AiConfig, CustomSource, Preferences};
use reqwest::{Client, Response};
use serde::Serialize;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;

pub fn client() -> Client {
    Client::builder()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Mozilla/5.0 NewsFloat/0.4")
        .build()
        .expect("OS TLS client")
}
pub fn endpoint(config: &AiConfig) -> Result<Url, String> {
    let url = safe_url(&config.api_url, false)?;
    if !(256..=8192).contains(&config.max_output_tokens) {
        return Err("AI 输出上限须为 256 至 8192 tokens".into());
    }
    if config.model.trim().is_empty() {
        return Err("请填写模型名称".into());
    }
    if !["decisions", "chat", "messages", "responses"].contains(&config.format.as_str()) {
        return Err("未知的模型接口格式".into());
    }
    if !["auto", "bearer", "x-api-key"].contains(&config.auth.as_str()) {
        return Err("未知鉴权方式".into());
    }
    if !["default", "disabled"].contains(&config.thinking_mode.as_str()) {
        return Err("未知思考模式".into());
    }
    if !["prompt", "object", "schema"].contains(&config.json_mode.as_str()) {
        return Err("未知 JSON 约束方式".into());
    }
    if config.format == "messages"
        && (config.api_version.is_empty()
            || !config
                .api_version
                .bytes()
                .all(|c| c.is_ascii_digit() || c == b'-'))
    {
        return Err("请填写 Messages API 版本日期".into());
    }
    if config.format == "messages" && config.json_mode == "object" {
        return Err("Messages 请使用提示词约束或 JSON Schema".into());
    }
    if !(1..=20).contains(&config.batch_size) || !(1..=4).contains(&config.concurrency) {
        return Err("批量大小须为1至20，并发数须为1至4".into());
    }
    if config.system_prompt.trim().is_empty() || config.system_prompt.chars().count() > 8000 {
        return Err("系统提示词须为 1 至 8,000 字".into());
    }
    Ok(url)
}
pub fn safe_url(input: &str, allow_query: bool) -> Result<Url, String> {
    let url = Url::parse(input.trim()).map_err(|_| "请填写完整接口 URL")?;
    let local = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if url.host_str().is_none()
        || !(url.scheme() == "https" || local && url.scheme() == "http")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || (!allow_query && url.query().is_some())
    {
        return Err("接口须为 HTTPS；本地可用 HTTP；密钥请单独填写".into());
    }
    if url.query_pairs().any(|(k, _)| {
        let k = k.to_lowercase().replace(['-', '_'], "");
        [
            "key",
            "apikey",
            "token",
            "accesstoken",
            "authorization",
            "password",
            "secret",
        ]
        .contains(&k.as_str())
    }) {
        return Err("URL 不可含密钥参数，请使用单独的 Key 栏".into());
    }
    Ok(url)
}
pub fn custom_endpoint(source: &CustomSource) -> Result<Url, String> {
    if source.format == "plugin" {
        crate::plugins::validate_source(source)?;
        let manifest = &source.plugin.as_ref().unwrap().manifest;
        let origin = manifest
            .auth
            .as_ref()
            .map(|auth| auth.origin.as_str())
            .unwrap_or(&manifest.network[0]);
        return safe_url(origin, true);
    }
    if !source.id.starts_with("custom:")
        || source.id.len() > 80
        || source.id.len() < 8
        || !source.id[7..]
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("自定义来源 ID 无效".into());
    }
    if source.name.trim().is_empty() || source.name.chars().count() > 32 {
        return Err("来源名称须为 1 至 32 字".into());
    }
    if !["none", "bearer"].contains(&source.auth.as_str()) {
        return Err("未知来源鉴权方式".into());
    }
    if !["auto", "json", "feed", "adapter"].contains(&source.format.as_str()) {
        return Err("未知来源格式".into());
    }
    if source.folder.chars().count() > 128 {
        return Err("来源分组最多128字".into());
    }
    if source.format == "adapter" {
        crate::adapters::validate_rules(source.adapter.as_ref().ok_or("缺少适配器规则")?)?;
    }
    safe_url(&source.url, true)
}
pub fn source_account(source: &CustomSource) -> Result<String, String> {
    Ok(format!(
        "{}@{}",
        source.id,
        custom_endpoint(source)?.origin().ascii_serialization()
    ))
}
pub fn validate_preferences(prefs: &Preferences) -> Result<(), String> {
    if !["system", "zh-CN", "en"].contains(&prefs.language.as_str()) {
        return Err("语言设置无效".into());
    }
    if !["dark", "light", "system"].contains(&prefs.theme.as_str())
        || !["orange", "blue", "green", "purple"].contains(&prefs.accent.as_str())
    {
        return Err("外观设置无效".into());
    }
    crate::ai_control::validate_limits(&prefs.ai_limits)?;
    if prefs.custom_sources.len() > 200 {
        return Err("最多接入 200 个自定义来源".into());
    }
    let mut ids = std::collections::HashSet::new();
    let mut urls = std::collections::HashSet::new();
    for source in &prefs.custom_sources {
        let endpoint = custom_endpoint(source)?;
        if source.format != "plugin" && !urls.insert(endpoint.to_string()) {
            return Err("来源地址重复，请合并或移除重复订阅".into());
        }
        if !ids.insert(&source.id) {
            return Err("来源 ID 重复".into());
        }
    }
    if prefs
        .custom_sources
        .iter()
        .filter_map(|s| s.plugin.as_ref())
        .map(|p| p.script.len())
        .sum::<usize>()
        > 4 * 1024 * 1024
    {
        return Err("本地渠道脚本累计最多 4 MiB".into());
    }
    let known =
        |id: &String| ["cls", "wallstreet", "jin10"].contains(&id.as_str()) || ids.contains(id);
    let mut removed = std::collections::HashSet::new();
    if prefs
        .uninstalled_sources
        .iter()
        .any(|id| !known(id) || !removed.insert(id))
    {
        return Err("未安装渠道记录无效".into());
    }
    if prefs
        .sources
        .iter()
        .any(|id| !known(id) || removed.contains(id))
    {
        return Err("请选择已安装的有效新闻渠道".into());
    }
    if ![30, 60, 120].contains(&prefs.interval)
        || !prefs.threshold.is_finite()
        || !(0.0..=1.0).contains(&prefs.threshold)
    {
        return Err("更新间隔或阈值无效".into());
    }
    // Incomplete disabled AI settings are allowed, but never persist a credential URL.
    if !prefs.ai.api_url.trim().is_empty() {
        safe_url(&prefs.ai.api_url, false)?;
    }
    if prefs.ai_enabled {
        endpoint(&prefs.ai)?;
    }
    Ok(())
}
pub fn account(config: &AiConfig) -> Result<String, String> {
    let u = endpoint(config)?;
    Ok(format!(
        "{}://{}{}",
        u.scheme(),
        u.host_str().unwrap(),
        u.port().map(|p| format!(":{p}")).unwrap_or_default()
    ))
}
pub fn network_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return "请求超时，将自动重试".into();
    }
    // Inspect locally, but never return URLs/headers or provider response bodies.
    let detail = format!("{error:?}").to_lowercase();
    if detail.contains("tls") || detail.contains("certificate") || detail.contains("ssl") {
        "TLS 连接校验失败，请检查系统时间、代理或证书；将自动重试".into()
    } else {
        "暂时无法连接，请检查网络或代理；将自动重试".into()
    }
}
pub async fn bounded_text(mut response: Response) -> Result<String, String> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| network_error(&e))? {
        if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
            return Err("响应过大，已停止读取".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "响应不是 UTF-8 文本".into())
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedResult {
    pub source: String,
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    pub error: Option<String>,
    pub fetched_at: u64,
}
pub async fn fetch(client: &Client, source: &str) -> FeedResult {
    if let Some(plugin) = crate::plugins::builtin(source) {
        return crate::plugins::fetch(client, &plugin, None).await;
    }
    FeedResult {
        source: source.into(),
        text: None,
        warning: None,
        error: Some("未知渠道，请先安装".into()),
        fetched_at: 0,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unsafe_endpoints() {
        for url in [
            "http://example.com/api",
            "https://key@example.com/api",
            "https://example.com/#key",
            "https://example.com/?key=secret",
            "file:///tmp/a",
        ] {
            assert!(endpoint(&AiConfig {
                api_url: url.into(),
                ..Default::default()
            })
            .is_err());
        }
        for url in [
            "https://openrouter.ai/api/alpha/decisions",
            "http://127.0.0.1:8080/v1/chat/completions",
            "http://[::1]:8080/v1/chat/completions",
        ] {
            assert!(endpoint(&AiConfig {
                api_url: url.into(),
                ..Default::default()
            })
            .is_ok());
        }
    }
    #[test]
    fn stable_key_accounts() {
        assert_eq!(
            account(&AiConfig::default()).unwrap(),
            "https://openrouter.ai"
        );
    }
    #[test]
    fn never_follows_a_redirect_with_credentials() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0; 2048];
            let _ = socket.read(&mut request);
            socket.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/never-contact\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        tauri::async_runtime::block_on(async {
            let response = client()
                .post(format!("http://{address}/configured"))
                .bearer_auth("test-only-placeholder")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), reqwest::StatusCode::FOUND);
        });
        server.join().unwrap();
    }
}

pub async fn fetch_custom(client: &Client, source: &CustomSource, key: Option<&str>) -> FeedResult {
    if source.format == "plugin" {
        return crate::plugins::fetch(client, source, key).await;
    }
    let mut result = FeedResult {
        source: source.id.clone(),
        text: None,
        warning: None,
        error: None,
        fetched_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    };
    let url = match custom_endpoint(source) {
        Ok(u) => u,
        Err(e) => {
            result.error = Some(e);
            return result;
        }
    };
    if source.auth == "bearer" && key.is_none_or(|k| k.is_empty()) {
        result.error = Some("该来源需要 Key，请在设置中填写".into());
        return result;
    }
    let mut request = client.get(url.clone()).header("Accept", "application/rss+xml, application/atom+xml, application/feed+json, application/json;q=0.9, application/xml;q=0.8, text/xml;q=0.7");
    if source.auth == "bearer" {
        request = request.bearer_auth(key.unwrap_or_default());
    }
    match request.send().await {
        Ok(response) if response.status().is_success() => match bounded_text(response).await {
            Ok(text) => match crate::adapters::custom(&text, source, result.fetched_at * 1000) {
                Ok(output) => {
                    result.text = Some(output.feed.to_string());
                    result.warning = output.warning;
                }
                Err(error) => result.error = Some(error),
            },
            Err(e) => result.error = Some(e),
        },
        Ok(response) => {
            result.error = Some(format!(
                "来源返回 HTTP {}，请检查接口或鉴权",
                response.status().as_u16()
            ))
        }
        Err(e) => result.error = Some(network_error(&e)),
    }
    result
}

#[cfg(test)]
mod custom_tests {
    use super::*;
    #[test]
    fn validates_custom_sources_and_credential_scopes() {
        let source = CustomSource {
            id: "custom:mine".into(),
            name: "个人聚合".into(),
            url: "https://example.com/news?limit=50".into(),
            auth: "bearer".into(),
            format: "auto".into(),
            adapter: None,
            folder: String::new(),
            plugin: None,
            parameters: Default::default(),
        };
        assert_eq!(
            source_account(&source).unwrap(),
            "custom:mine@https://example.com"
        );
        for url in [
            "https://example.com/news?api_key=hidden",
            "https://hidden@example.com/news",
            "http://remote.example/news",
        ] {
            assert!(custom_endpoint(&CustomSource {
                url: url.into(),
                ..source.clone()
            })
            .is_err());
        }
        let prefs = Preferences {
            sources: vec![source.id.clone()],
            custom_sources: vec![source.clone()],
            ..Default::default()
        };
        assert!(validate_preferences(&prefs).is_ok());
        assert!(validate_preferences(&Preferences {
            custom_sources: vec![source.clone(), source],
            ..prefs
        })
        .is_err());
    }
    #[test]
    fn channel_installation_state_is_validated_and_empty_sources_are_allowed() {
        let mut prefs = Preferences::default();
        prefs.sources.clear();
        prefs.uninstalled_sources = vec!["cls".into(), "wallstreet".into(), "jin10".into()];
        assert!(validate_preferences(&prefs).is_ok());
        prefs.sources.push("cls".into());
        assert!(validate_preferences(&prefs).is_err());
        prefs.uninstalled_sources.retain(|id| id != "cls");
        assert!(validate_preferences(&prefs).is_ok());
        prefs.uninstalled_sources.push("unknown".into());
        assert!(validate_preferences(&prefs).is_err());
    }
    #[test]
    fn custom_http_source_preserves_payload_and_auth_without_a_proxy() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0; 2048];
            let count = socket.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..count]).to_lowercase();
            assert!(request.starts_with("get /news?limit=50 "));
            assert!(request.contains("authorization: bearer test-placeholder"));
            let body = r#"{"version":1,"items":[{"id":"1","body":"完整正文","publishedAt":"2026-11-15T08:30:00+08:00","tags":["市场"]}]}"#;
            let response=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
            socket.write_all(response.as_bytes()).unwrap();
        });
        let source = CustomSource {
            id: "custom:mine".into(),
            name: "个人聚合".into(),
            url: format!("http://{address}/news?limit=50"),
            auth: "bearer".into(),
            format: "auto".into(),
            adapter: None,
            folder: String::new(),
            plugin: None,
            parameters: Default::default(),
        };
        let result = tauri::async_runtime::block_on(fetch_custom(
            &client(),
            &source,
            Some("test-placeholder"),
        ));
        assert_eq!(result.source, "custom:mine");
        assert!(result.error.is_none());
        assert!(result.text.unwrap().contains("完整正文"));
        server.join().unwrap();
        let missing = tauri::async_runtime::block_on(fetch_custom(&client(), &source, None));
        assert!(missing.error.unwrap().contains("需要 Key"));
    }
}
