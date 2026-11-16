# 新闻源开发

简体中文 · [English](en/news-source-development.md)

## 接入方式

| 方式 | 如何接入 |
| --- | --- |
| RSS / Atom / JSON Feed | 在“设置 → 新闻来源 → 添加新闻来源”填写地址；支持批量添加和 OPML 导入 |
| 标准 JSON 接口 | 提供 GET 接口，返回下方的新闻 JSON，再添加接口地址 |
| 自定义适配器 | 编写 `manifest.json` 和 `adapter.js`，打包为 `.news-source.json` 后安装 |

## 新闻 JSON

JSON 接口与适配器统一返回：

```json
{
  "version": 1,
  "items": [{
    "id": "news-123",
    "title": "新闻标题",
    "body": "完整新闻正文",
    "publishedAt": "2026-11-16T09:30:00+08:00",
    "url": "https://example.com/news/123",
    "tags": ["科技"]
  }]
}
```

| 字段 | 要求 |
| --- | --- |
| `version` | 固定为 `1` |
| `items` | 最多 500 条；空数组表示暂无新闻 |
| `id` | 必填，1～200 字符；来源内唯一、刷新后保持不变 |
| `body` | 必填，完整纯文本，最多 32,000 字符 |
| `publishedAt` | 必填，带时区的 ISO 时间或 Unix 毫秒数 |
| `title` | 可选，最多 1,000 字符 |
| `url` | 可选，原文 HTTP / HTTPS 地址 |
| `tags` | 可选，最多 8 个标签，每个最多 24 字符 |

更正新闻保留 `id`；跨站点用 `site-a:123` 等前缀区分。来源标签与关键词／AI 标记分开展示。

[新闻 Schema](news-feed.schema.json)

## 开发适配器

在同一目录创建 `manifest.json` 和 `adapter.js`。

**manifest.json**

```json
{
  "id": "custom:my-news",
  "name": "我的新闻",
  "version": "1.0.0",
  "apiVersion": 1,
  "entry": "adapter.js",
  "network": ["https://example.com"],
  "config": []
}
```

| 字段 | 要求 |
| --- | --- |
| `id` | `custom:` 加 1～73 个字母、数字、下划线或连字符 |
| `name` | 显示名称，1～32 字符 |
| `version` | 三段版本号，如 `1.0.0`；更新时保持 ID、提高版本号 |
| `apiVersion` / `entry` | 固定为 `1` / `adapter.js` |
| `network` | 允许请求的域名（含协议和端口），最多 16 个；如 `https://example.com`，不含路径或通配符 |
| `config` | 最多 32 个配置项，支持 `string`、`number`、`boolean`；通过 `ctx.config` 读取 |

配置项示例：`{"key":"channel","label":"频道","kind":"string","default":"tech","required":true}`。配置键为 1～64 个字母、数字或下划线，不能使用 `__proto__`、`constructor`、`prototype`。

**adapter.js**

示例上游：`{"rows":[{"id":"123","content":"正文","time":1794792600}]}`，`time` 为 Unix 秒数。

```js
function fetch(ctx) {
  const response = ctx.request({url: 'https://example.com/api/news'});
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  const data = JSON.parse(response.text);
  return {
    version: 1,
    items: data.rows.map(row => ({
      id: String(row.id),
      body: ctx.plain(row.content),
      publishedAt: row.time * 1000
    }))
  };
}
```

`fetch(ctx)` 同步返回新闻 JSON。使用普通 JavaScript，不使用 Promise、模块导入、Node API、DOM 或定时器。

### 输入和函数

| 输入 / API | 说明 |
| --- | --- |
| `ctx.now` | 本次采集时间，Unix 毫秒 |
| `ctx.config` | 用户填写的非敏感配置 |
| `ctx.request({url,method?,headers?,body?,useKey?})` | 返回 `{status,text,headers}`；支持 GET、POST；body 为字符串 |
| `ctx.sha1(text)` / `ctx.md5(text)` | 返回十六进制散列 |
| `ctx.plain(html)` | HTML 转纯文本 |
| `ctx.parseFeed(text,url)` | RSS / Atom / JSON Feed 转新闻 JSON |
| `ctx.mapJSON(text,rules)` | 按字段映射生成新闻 JSON，见下表 |

所有请求域名须列入 `network`。使用 HTTPS，本机可用 HTTP；不跟随重定向。

### 字段映射

| `rules` 字段 | 含义 |
| --- | --- |
| `itemsPath` | 条目数组路径；顶层数组用 `""` |
| `idPath` / `titlePath` | ID / 标题字段 |
| `bodyPaths` | 正文字段列表，按顺序取第一个非空值 |
| `datePath` / `dateUnit` | 时间字段；单位为 `seconds`、`milliseconds`、`iso` 或 `local` |
| `timezone` | `local` 时间的时区，如 `+08:00` |
| `urlPath` / `urlTemplate` | 原文链接字段或模板；模板支持 `{id}` |
| `tagsPath` | 标签数组字段 |
| `jsonPrefix` | 解析前移除的固定前缀，如 `var newest =` |
| `exclude` | 排除广告等条目；支持 `truthy`、`gt`、`contains` |

字段路径支持点号和数组下标。完整用法见[财联社](../source-adapters/packages/cls/adapter.js)、[华尔街见闻](../source-adapters/packages/wallstreet/adapter.js)、[金十](../source-adapters/packages/jin10/adapter.js)。

### 接口鉴权

需要 Key 时，在 manifest 中添加：

```json
"auth": {"origin":"https://example.com","header":"Authorization","prefix":"Bearer "}
```

`origin` 须列入 `network`；header 支持 `Authorization` / `x-api-key`。用户在应用中填 Key，请求用 `useKey:true` 注入。脚本和 config 不存 Key 或 Cookie。

## 打包、测试、安装

在仓库根目录执行：

```sh
python3 scripts/pack-source.py my-source --out my-source.news-source.json
cargo run --manifest-path src-tauri/Cargo.toml -- --check-source-file my-source.news-source.json
```

在“设置 → 新闻来源 → 添加新闻来源 → 从文件添加”安装并保存。带 Key 的来源在应用内测试。

安装文件可包含多个来源，直接分享即可。格式见[安装文件 Schema](source-package.schema.json)。

[POST](../source-adapters/packages/custom-example/) / [RSS](../source-adapters/packages/rss-example/) 示例：先运行 `python3 scripts/mock-feed.py 18765`，再打包测试。

## 运行限制

| 项目 | 上限 |
| --- | --- |
| 文件 | 单个脚本 256 KiB，安装文件 1 MiB，本地脚本合计 4 MiB |
| 执行 | 内存 32 MiB，JS 计算约 2 秒，任务总计 30 秒 |
| 网络 | 每次采集最多 8 个请求；单请求 20 秒 |
| 数据 | 请求正文 256 KiB；单响应 4 MiB，累计响应 8 MiB；输出 4 MiB |

无本地文件、进程和环境变量访问。采集间隔为 30 / 60 / 120 秒；返回数据应覆盖间隔。原始缓存：最近 7 天、最多 1,000 条。
