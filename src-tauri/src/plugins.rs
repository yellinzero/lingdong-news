//! Every executable source, including the three preinstalled sources, uses this ABI.
//! Fresh QuickJS realm per run; only explicit, bounded host capabilities are provided.
use crate::{adapters, model::CustomSource, network, syndication};
use md5::Md5;
use rquickjs::{Context, Function, Runtime};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::{
    collections::{BTreeMap, HashSet},
    time::{Duration, Instant},
};
use url::Url;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Package {
    pub manifest: Manifest,
    pub script: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: u32,
    pub entry: String,
    pub network: Vec<String>,
    #[serde(default)]
    pub config: Vec<Field>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<Auth>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Field {
    pub key: String,
    pub label: String,
    pub kind: String,
    pub default: Value,
    #[serde(default)]
    pub required: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Auth {
    pub origin: String,
    pub header: String,
    #[serde(default)]
    pub prefix: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Directory {
    version: u32,
    sources: Vec<Package>,
}
pub fn preinstalled() -> Vec<Package> {
    let directory = serde_json::from_str::<Directory>(include_str!(
        "../../source-adapters/packages/preinstalled.json"
    ))
    .expect("preinstalled packages");
    assert_eq!(directory.version, 2);
    directory.sources
}
pub fn builtin(id: &str) -> Option<CustomSource> {
    preinstalled()
        .into_iter()
        .find(|p| p.manifest.id == id)
        .map(|p| p.source())
}
impl Package {
    pub fn source(self) -> CustomSource {
        let manifest = &self.manifest;
        CustomSource {
            id: manifest.id.clone(),
            name: manifest.name.clone(),
            url: manifest
                .auth
                .as_ref()
                .map(|a| a.origin.clone())
                .unwrap_or_else(|| manifest.network.first().cloned().unwrap_or_default()),
            format: "plugin".into(),
            auth: if manifest.auth.is_some() {
                "bearer"
            } else {
                "none"
            }
            .into(),
            folder: String::new(),
            adapter: None,
            parameters: manifest
                .config
                .iter()
                .map(|f| (f.key.clone(), f.default.clone()))
                .collect(),
            plugin: Some(self),
        }
    }
}
pub fn valid_id(id: &str) -> bool {
    ["cls", "wallstreet", "jin10"].contains(&id)
        || id.strip_prefix("custom:").is_some_and(|s| {
            !s.is_empty()
                && s.len() <= 73
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        })
}
fn origin(input: &str) -> Result<String, String> {
    if input.contains('*') {
        return Err("网络权限不支持通配符".into());
    }
    let u = network::safe_url(input, true)?;
    if u.path() != "/" || u.query().is_some() {
        return Err("network 只接受完整 origin，如 https://example.com".into());
    }
    Ok(u.origin().ascii_serialization())
}
fn typed(field: &Field, value: &Value) -> bool {
    match field.kind.as_str() {
        "string" => value
            .as_str()
            .is_some_and(|s| s.len() <= 8000 && (!field.required || !s.trim().is_empty())),
        "number" => value.as_f64().is_some_and(f64::is_finite),
        "boolean" => value.is_boolean(),
        _ => false,
    }
}
pub fn validate(package: &Package) -> Result<(), String> {
    let m = &package.manifest;
    if !valid_id(&m.id)
        || m.name.trim().is_empty()
        || m.name.chars().count() > 32
        || m.api_version != 1
        || m.entry != "adapter.js"
        || m.version.len() > 40
        || m.version.split('.').count() != 3
        || !m
            .version
            .split('.')
            .all(|s| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()))
    {
        return Err("渠道 manifest 的 ID、名称、版本、apiVersion 或 entry 无效".into());
    }
    if package.script.trim().is_empty()
        || package.script.len() > 256 * 1024
        || m.network.is_empty()
        || m.network.len() > 16
        || m.config.len() > 32
    {
        return Err("渠道脚本、网络权限或配置数量超过限制".into());
    }
    let mut hosts = HashSet::new();
    for host in &m.network {
        if host != &origin(host)? || !hosts.insert(host) {
            return Err("网络权限须为不重复的规范 origin，不支持通配符".into());
        }
    }
    let mut keys = HashSet::new();
    for field in &m.config {
        if field.key.is_empty()
            || field.key.len() > 64
            || !field
                .key
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_')
            || ["__proto__", "constructor", "prototype"].contains(&field.key.as_str())
            || !keys.insert(&field.key)
            || field.label.trim().is_empty()
            || field.label.chars().count() > 64
            || !typed(field, &field.default)
        {
            return Err("渠道配置定义无效，默认值须符合类型和必填规则".into());
        }
    }
    if let Some(auth) = &m.auth {
        if !m.network.contains(&origin(&auth.origin)?)
            || !["Authorization", "x-api-key"].contains(&auth.header.as_str())
            || auth.prefix.len() > 64
            || auth.prefix.contains(['\r', '\n'])
        {
            return Err("渠道凭据声明无效".into());
        }
    }
    Ok(())
}
pub fn validate_source(source: &CustomSource) -> Result<(), String> {
    let p = source.plugin.as_ref().ok_or("缺少可执行渠道包")?;
    validate(p)?;
    if source.auth
        != (if p.manifest.auth.is_some() {
            "bearer"
        } else {
            "none"
        })
        || source.id != p.manifest.id
        || source.name != p.manifest.name
        || !source
            .parameters
            .keys()
            .all(|key| p.manifest.config.iter().any(|f| &f.key == key))
    {
        return Err("渠道身份或配置与 manifest 不一致".into());
    }
    for f in &p.manifest.config {
        if !typed(f, source.parameters.get(&f.key).unwrap_or(&f.default)) {
            return Err(format!("请检查渠道配置：{}", f.label));
        }
    }
    Ok(())
}

/// Validate the same v1 output before it can reach the common frontend consumer.
pub fn validate_feed(feed: &Value, now: u64) -> Result<(), String> {
    let items = feed
        .get("items")
        .and_then(Value::as_array)
        .ok_or("渠道须返回 {version:1,items:[…]}")?;
    if feed["version"] != 1 || items.len() > 500 {
        return Err("新闻输出协议或条目数量无效".into());
    }
    let mut ids = HashSet::new();
    for (index, row) in items.iter().enumerate() {
        let fail = || {
            format!(
                "渠道第 {} 条新闻无效：检查 ID、正文、日期、链接和标签",
                index + 1
            )
        };
        let id = row["id"].as_str().ok_or_else(fail)?;
        let body = row["body"].as_str().ok_or_else(fail)?;
        if id.trim().is_empty()
            || id.chars().count() > 200
            || !ids.insert(id)
            || body.trim().is_empty()
            || body.chars().count() > 32000
        {
            return Err(fail());
        }
        if row
            .get("title")
            .is_some_and(|s| s.as_str().is_none_or(|t| t.chars().count() > 1000))
        {
            return Err(fail());
        }
        let date = if let Some(n) = row["publishedAt"].as_f64() {
            n
        } else {
            chrono::DateTime::parse_from_rfc3339(row["publishedAt"].as_str().ok_or_else(fail)?)
                .map_err(|_| fail())?
                .timestamp_millis() as f64
        };
        if !date.is_finite() || date < 1_000_000_000_000.0 || date > now as f64 + 86_400_000.0 {
            return Err(fail());
        }
        if let Some(value) = row.get("url") {
            let text = value.as_str().ok_or_else(fail)?;
            if !text.is_empty() {
                let u = Url::parse(text).map_err(|_| fail())?;
                if !["http", "https"].contains(&u.scheme())
                    || !u.username().is_empty()
                    || u.password().is_some()
                {
                    return Err(fail());
                }
            }
        }
        if row.get("dateEstimated").is_some_and(|v| !v.is_boolean()) {
            return Err(fail());
        }
        if let Some(tags) = row.get("tags") {
            let tags = tags.as_array().ok_or_else(fail)?;
            if tags.len() > 8
                || tags.iter().any(|v| {
                    v.as_str().is_none_or(|s| {
                        s.trim().is_empty() || s.chars().count() > 24 || s.contains(['\n', '\r'])
                    })
                })
            {
                return Err(fail());
            }
        }
    }
    Ok(())
}

#[derive(Debug)]
pub struct Output {
    pub text: String,
    pub warning: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    url: String,
    #[serde(default = "get")]
    method: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    use_key: bool,
}
fn get() -> String {
    "GET".into()
}
struct Host {
    client: reqwest::Client,
    source: CustomSource,
    key: Option<String>,
    now: u64,
    deadline: Instant,
    requests: usize,
    total_bytes: usize,
    warning: Option<String>,
}
impl Host {
    fn request(&mut self, args: Value) -> Result<Value, String> {
        let input: Request = serde_json::from_value(args).map_err(|_| "请求参数无效")?;
        let p = self.source.plugin.as_ref().unwrap();
        let u = network::safe_url(&input.url, true)?;
        if !p
            .manifest
            .network
            .contains(&u.origin().ascii_serialization())
        {
            return Err("请求超出渠道声明的网络权限".into());
        }
        if !["GET", "POST"].contains(&input.method.as_str())
            || input.headers.len() > 16
            || input.body.as_ref().is_some_and(|s| s.len() > 256 * 1024)
        {
            return Err("请求方法、标头或正文超过限制".into());
        }
        if self.requests >= 8 || self.total_bytes >= 8 * 1024 * 1024 {
            return Err("单次渠道请求配额已用完".into());
        }
        self.requests += 1;
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("渠道执行超时".into());
        }
        let mut request = self
            .client
            .request(
                reqwest::Method::from_bytes(input.method.as_bytes()).unwrap(),
                u.clone(),
            )
            .timeout(remaining.min(Duration::from_secs(20)));
        for (key, value) in input.headers {
            if [
                "authorization",
                "x-api-key",
                "cookie",
                "proxy-authorization",
                "host",
                "content-length",
                "connection",
            ]
            .contains(&key.to_lowercase().as_str())
                || key.len() > 128
                || value.len() > 8000
            {
                return Err("凭据由宿主注入，请勿在脚本中传入敏感请求头".into());
            }
            request = request.header(key, value);
        }
        if let Some(body) = input.body {
            request = request.body(body);
        }
        if input.use_key {
            let auth = p.manifest.auth.as_ref().ok_or("渠道未声明凭据用途")?;
            if origin(&auth.origin)? != u.origin().ascii_serialization() {
                return Err("凭据只能用于声明的 origin".into());
            }
            let key = self
                .key
                .as_deref()
                .filter(|k| !k.is_empty())
                .ok_or("该渠道需要 Key，请在配置中填写")?;
            request = request.header(&auth.header, format!("{}{key}", auth.prefix));
        }
        let response = tauri::async_runtime::block_on(async { request.send().await })
            .map_err(|e| network::network_error(&e))?;
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        let text = tauri::async_runtime::block_on(network::bounded_text(response))?;
        self.total_bytes += text.len();
        if self.total_bytes > 8 * 1024 * 1024 {
            return Err("渠道响应累计超过限制".into());
        }
        Ok(json!({"status":status,"text":text,"headers":{"content-type":content_type}}))
    }
    fn dispatch(&mut self, input: &str) -> Result<Value, String> {
        if input.len() > 12 * 1024 * 1024 || Instant::now() > self.deadline {
            return Err("渠道执行超时或输入超过限制".into());
        }
        let mut value: Value = serde_json::from_str(input).map_err(|_| "宿主调用参数不是 JSON")?;
        let op = value["op"].as_str().unwrap_or_default().to_string();
        match op.as_str() {
            "request" => self.request(value["args"].take()),
            "sha1" | "md5" => {
                let s = value["text"].as_str().ok_or("散列输入须为字符串")?;
                Ok(json!(if op == "sha1" {
                    format!("{:x}", Sha1::digest(s.as_bytes()))
                } else {
                    format!("{:x}", Md5::digest(s.as_bytes()))
                }))
            }
            "plain" => Ok(json!(syndication::plain(
                value["text"].as_str().ok_or("正文须为字符串")?,
                true
            ))),
            "mapJSON" => {
                let rules = serde_json::from_value(value["rules"].take())
                    .map_err(|_| "字段映射规则无效")?;
                adapters::map_json(value["text"].as_str().ok_or("正文须为字符串")?, &rules)
            }
            "parseFeed" => {
                let url = value["url"].as_str().ok_or("订阅 URL 无效")?;
                let u = network::safe_url(url, true)?;
                if !self
                    .source
                    .plugin
                    .as_ref()
                    .unwrap()
                    .manifest
                    .network
                    .contains(&u.origin().ascii_serialization())
                {
                    return Err("订阅地址超出网络权限".into());
                }
                let mut source = self.source.clone();
                source.url = url.into();
                source.format = "feed".into();
                let parsed = adapters::custom(
                    value["text"].as_str().ok_or("订阅正文无效")?,
                    &source,
                    self.now,
                )?;
                self.warning = parsed.warning;
                Ok(parsed.feed)
            }
            _ => Err("未知渠道宿主能力".into()),
        }
    }
}
const BOOTSTRAP: &str = r#"
((host, input) => {
  const call = (op, args) => {
    const result = JSON.parse(host(JSON.stringify({op, ...args})));
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  return Object.freeze({now:input.now,config:Object.freeze(input.config),
    request:args=>call('request',{args}),
    sha1:text=>call('sha1',{text}),md5:text=>call('md5',{text}),
    plain:text=>call('plain',{text}),mapJSON:(text,rules)=>call('mapJSON',{text,rules}),
    parseFeed:(text,url)=>call('parseFeed',{text,url})
  });
})(__host, JSON.parse(__input))
"#;
fn execute(
    source: CustomSource,
    client: reqwest::Client,
    key: Option<String>,
    now: u64,
) -> Result<Output, String> {
    execute_bounded(
        source,
        client,
        key,
        now,
        Duration::from_secs(30),
        Duration::from_secs(2),
    )
}
fn execute_bounded(
    source: CustomSource,
    client: reqwest::Client,
    key: Option<String>,
    now: u64,
    wall: Duration,
    cpu: Duration,
) -> Result<Output, String> {
    validate_source(&source)?;
    let runtime = Runtime::new().map_err(|_| "无法创建渠道执行环境")?;
    runtime.set_memory_limit(32 * 1024 * 1024);
    runtime.set_max_stack_size(512 * 1024);
    let started = Instant::now();
    let deadline = started + wall;
    let paused = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let pause_counter = paused.clone();
    runtime.set_interrupt_handler(Some(Box::new(move || {
        Instant::now() > deadline
            || started.elapsed().saturating_sub(Duration::from_nanos(
                pause_counter.load(std::sync::atomic::Ordering::Relaxed),
            )) > cpu
    })));
    let context = Context::full(&runtime).map_err(|_| "无法创建渠道上下文")?;
    let package = source.plugin.as_ref().unwrap().clone();
    let config: BTreeMap<_, _> = package
        .manifest
        .config
        .iter()
        .map(|f| {
            (
                f.key.clone(),
                source.parameters.get(&f.key).unwrap_or(&f.default).clone(),
            )
        })
        .collect();
    let host = std::rc::Rc::new(std::cell::RefCell::new(Host {
        client,
        source,
        key,
        now,
        deadline,
        requests: 0,
        total_bytes: 0,
        warning: None,
    }));
    let run_host = host.clone();
    let output=context.with(|ctx|->rquickjs::Result<String>{
        ctx.globals().set("__host",Function::new(ctx.clone(),move|input:String|->String{
            let call_started=Instant::now();let outcome=run_host.borrow_mut().dispatch(&input);paused.fetch_add(call_started.elapsed().as_nanos().min(u64::MAX as u128) as u64,std::sync::atomic::Ordering::Relaxed);
            match outcome{Ok(value)=>json!({"ok":true,"value":value}).to_string(),Err(error)=>json!({"ok":false,"error":error}).to_string()}
        })?)?;
        ctx.globals().set("__input",json!({"now":now,"config":config}).to_string())?;
        let api:rquickjs::Value=ctx.eval(BOOTSTRAP)?;ctx.globals().set("__api",api)?;
        ctx.globals().set("__script",package.script.clone())?;
        let result=ctx.eval::<String,_>(r#"((api, stringify) => {
          const execute = new Function('ctx', __script + "\n; if(typeof fetch !== 'function') throw new Error('缺少 fetch(ctx)'); return fetch(ctx);");
          const result=execute(api);
          if(result && typeof result.then==='function') throw new Error('fetch 须同步返回 JSON，ctx.request 已由宿主管理');
          return stringify(result);
        })(__api, JSON.stringify)"#);
        if result.is_err(){let exception=ctx.catch();let message=exception.as_object().and_then(|o|o.get::<_,String>("message").ok()).unwrap_or_else(||"脚本异常或资源限制".into());ctx.globals().set("__error",message)?;}
        result
    });
    let text = output.map_err(|_| {
        let message = context
            .with(|ctx| ctx.globals().get::<_, String>("__error"))
            .unwrap_or_else(|_| "脚本异常或资源限制".into());
        format!(
            "渠道执行失败：{}",
            message.chars().take(240).collect::<String>()
        )
    })?;
    if text.len() > 4 * 1024 * 1024 {
        return Err("渠道输出超过 4 MiB".into());
    }
    let value: Value = serde_json::from_str(&text).map_err(|_| "渠道输出不是合法 JSON")?;
    validate_feed(&value, now)?;
    let warning = host.borrow().warning.clone();
    Ok(Output { text, warning })
}
pub async fn fetch(
    client: &reqwest::Client,
    source: &CustomSource,
    key: Option<&str>,
) -> network::FeedResult {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let mut result = network::FeedResult {
        source: source.id.clone(),
        text: None,
        error: None,
        warning: None,
        fetched_at: now,
    };
    let (source, client, key) = (source.clone(), client.clone(), key.map(str::to_string));
    match tauri::async_runtime::spawn_blocking(move || execute(source, client, key, now * 1000))
        .await
    {
        Ok(Ok(output)) => {
            result.text = Some(output.text);
            result.warning = output.warning;
        }
        Ok(Err(error)) => result.error = Some(error),
        Err(_) => result.error = Some("渠道执行任务未完成".into()),
    }
    result
}

pub fn check_syntax(package: &Package) -> Result<(), String> {
    validate(package)?;
    let runtime = Runtime::new().map_err(|_| "无法检查渠道脚本")?;
    runtime.set_memory_limit(16 * 1024 * 1024);
    runtime.set_max_stack_size(512 * 1024);
    let deadline = Instant::now() + Duration::from_millis(500);
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() > deadline)));
    let context = Context::full(&runtime).map_err(|_| "无法检查渠道脚本")?;
    context
        .with(|ctx| {
            ctx.globals().set("script", package.script.clone())?;
            ctx.eval::<rquickjs::Value, _>("new Function('ctx', script)")
                .map(|_| ())
        })
        .map_err(|_: rquickjs::Error| {
            "渠道脚本语法无效；请提供普通 JavaScript fetch(ctx) 函数".into()
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };
    const NOW: u64 = 1794702600000;
    fn server(body: &str) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let body = body.to_string();
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let n = stream.read(&mut chunk).unwrap();
                if n == 0 {
                    break;
                }
                bytes.extend_from_slice(&chunk[..n]);
                if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]);
                    let len = headers
                        .lines()
                        .find_map(|s| {
                            s.to_lowercase()
                                .strip_prefix("content-length: ")
                                .and_then(|n| n.parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + len {
                        break;
                    }
                }
            }
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            String::from_utf8(bytes).unwrap()
        });
        (address, thread)
    }
    fn repoint(mut package: Package, address: &str) -> Package {
        let original = package.manifest.network[0].clone();
        package.script = package.script.replace(&original, address);
        package.manifest.network = vec![address.into()];
        package
    }
    #[test]
    fn all_preinstalled_scripts_and_a_renamed_cls_copy_run_through_the_same_host_and_output_contract(
    ) {
        let fixtures = [
            r#"{"data":{"roll_data":[{"id":1,"title":"标题","content":"【标题】完整<br/>正文","ctime":1794702600,"bold":1},{"id":2,"content":"广告","ctime":1794702600,"is_ad":1}]}}"#,
            r#"{"data":{"items":[{"id":"w","content_text":"华尔街完整正文","display_time":1794702600,"uri":"https://wallstreetcn.com/live/w","score":5}]}}"#,
            r#"var newest = [{"id":"j","time":"2026-11-15 08:30:00","data":{"content":"金十完整正文"},"important":1},{"id":"vip","time":"2026-11-15 08:30:00","data":{"content":"锁定","lock":true}}];"#,
        ];
        for (index, package) in preinstalled().into_iter().enumerate() {
            check_syntax(&package).unwrap();
            for cloned in if index == 0 {
                vec![false, true]
            } else {
                vec![false]
            } {
                let (address, thread) = server(fixtures[index]);
                let mut package = repoint(package.clone(), &address);
                if cloned {
                    package.manifest.id = "custom:user-cls-copy".into();
                    package.manifest.name = "用户复制的财联社示例".into();
                }
                let output = execute(package.source(), network::client(), None, NOW).unwrap();
                let feed: Value = serde_json::from_str(&output.text).unwrap();
                assert_eq!(feed["version"], 1);
                assert_eq!(feed["items"].as_array().unwrap().len(), 1);
                assert!(feed["items"][0].get("important").is_none());
                if index == 0 {
                    assert_eq!(feed["items"][0]["body"], "【标题】完整\n正文");
                    let query="appName=CailianpressWeb&last_time=1794702600&os=web&refresh_type=1&rn=50&sv=7.7.5";
                    let sha = format!("{:x}", Sha1::digest(query.as_bytes()));
                    let sign = format!("{:x}", Md5::digest(sha.as_bytes()));
                    assert!(thread
                        .join()
                        .unwrap()
                        .contains(&format!("{query}&sign={sign}")));
                } else {
                    thread.join().unwrap();
                }
            }
        }
    }
    fn package(script: &str, origin: &str) -> Package {
        Package {
            manifest: Manifest {
                id: "custom:test-source".into(),
                name: "测试逻辑渠道".into(),
                version: "1.0.0".into(),
                api_version: 1,
                entry: "adapter.js".into(),
                network: vec![origin.into()],
                config: vec![],
                auth: None,
            },
            script: script.into(),
        }
    }
    #[test]
    fn user_post_logic_reads_config_computes_news_and_persists_as_a_regular_source() {
        let (address, thread) =
            server(r#"{"rows":[{"uid":7,"text":"用户渠道完整正文","seconds":1794702600}]}"#);
        let mut package = package(
            &format!(
                r#"function fetch(ctx){{const r=ctx.request({{url:'{address}/news',method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{topic:ctx.config.topic}})}});return {{version:1,items:JSON.parse(r.text).rows.map(row=>({{id:String(row.uid),body:row.text,publishedAt:row.seconds*1000,tags:[ctx.config.topic]}}))}};}}"#
            ),
            &address,
        );
        package.manifest.config.push(Field {
            key: "topic".into(),
            label: "关注频道".into(),
            kind: "string".into(),
            default: json!("宏观"),
            required: true,
        });
        let mut source = package.source();
        source.parameters.insert("topic".into(), json!("芯片"));
        let serialized = serde_json::to_string(&source).unwrap();
        let restored = serde_json::from_str(&serialized).unwrap();
        let output = execute(restored, network::client(), None, NOW).unwrap();
        let feed: Value = serde_json::from_str(&output.text).unwrap();
        assert_eq!(feed["items"][0]["tags"], json!(["芯片"]));
        let request = thread.join().unwrap();
        assert!(request.starts_with("POST /news "));
        assert!(request.contains("{\"topic\":\"芯片\"}"));
    }
    #[test]
    fn feed_helper_normalizes_rss_without_a_gateway() {
        let (address, thread) = server(
            r#"<rss version="2.0"><channel><title>测试</title><link>https://example.com</link><description>测试</description><item><guid>one</guid><title>订阅标题</title><description>完整订阅正文</description></item></channel></rss>"#,
        );
        let p=package(&format!("function fetch(ctx){{const url='{address}/rss';return ctx.parseFeed(ctx.request({{url}}).text,url);}}"),&address);
        let output = execute(p.source(), network::client(), None, NOW).unwrap();
        let feed: Value = serde_json::from_str(&output.text).unwrap();
        assert_eq!(feed["items"][0]["id"], "one");
        assert_eq!(feed["items"][0]["dateEstimated"], true);
        assert!(output.warning.is_some());
        thread.join().unwrap();
    }
    #[test]
    fn credentials_are_injected_for_the_declared_origin_and_are_not_exposed_to_script() {
        let (address, thread) = server("{}");
        let mut p=package(&format!("function fetch(ctx){{ctx.request({{url:'{address}/private',useKey:true}});if(ctx.key!==undefined)throw new Error('key leak');return {{version:1,items:[]}};}}"),&address);
        p.manifest.auth = Some(Auth {
            origin: address.clone(),
            header: "Authorization".into(),
            prefix: "Bearer ".into(),
        });
        let output = execute(
            p.clone().source(),
            network::client(),
            Some("test-placeholder".into()),
            NOW,
        )
        .unwrap();
        assert!(!output.text.contains("test-placeholder"));
        assert!(thread
            .join()
            .unwrap()
            .to_lowercase()
            .contains("authorization: bearer test-placeholder"));
        p.manifest.network.push("https://elsewhere.example".into());
        p.script="function fetch(ctx){ctx.request({url:'https://elsewhere.example/',useKey:true});return {version:1,items:[]};}".into();
        assert!(execute(
            p.source(),
            network::client(),
            Some("test-placeholder".into()),
            NOW
        )
        .unwrap_err()
        .contains("凭据只能"));
    }
    #[test]
    fn domain_permissions_and_missing_os_capabilities_are_enforced_without_per_source_exceptions() {
        let p=package("function fetch(ctx){ctx.request({url:'https://not-declared.example/data'});return {version:1,items:[]};}","https://example.com");
        assert!(execute(p.source(), network::client(), None, NOW)
            .unwrap_err()
            .contains("网络权限"));
        let p=package("function fetch(ctx){if(typeof process!=='undefined'||typeof require!=='undefined'||typeof std!=='undefined'||typeof window!=='undefined')throw new Error('ambient access');return {version:1,items:[]};}","https://example.com");
        assert!(execute(p.source(), network::client(), None, NOW).is_ok());
    }
    #[test]
    fn inspection_only_compiles_and_runtime_rejects_bad_output_and_bounds_cpu_and_memory() {
        let p = package(
            "function fetch(ctx){throw new Error('must not run during inspection');}",
            "https://example.com",
        );
        check_syntax(&p).unwrap();
        assert!(execute(p.source(), network::client(), None, NOW).is_err());
        assert!(check_syntax(&package("function fetch( {", "https://example.com")).is_err());
        for script in ["function fetch(){return {version:1,items:[{id:'x',body:'one',publishedAt:1794702600000},{id:'x',body:'two',publishedAt:1794702600000}]};}","function fetch(){return Promise.resolve({version:1,items:[]});}"] {assert!(execute(package(script,"https://example.com").source(),network::client(),None,NOW).is_err());}
        let started = Instant::now();
        let result = execute_bounded(
            package("function fetch(){while(true){}}", "https://example.com").source(),
            network::client(),
            None,
            NOW,
            Duration::from_millis(250),
            Duration::from_millis(30),
        );
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(execute_bounded(
            package(
                "function fetch(){const a=[];while(true)a.push('x'.repeat(1000000));}",
                "https://example.com"
            )
            .source(),
            network::client(),
            None,
            NOW,
            Duration::from_secs(1),
            Duration::from_millis(500)
        )
        .is_err());
    }
}
