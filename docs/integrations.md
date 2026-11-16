# 数据与 AI 接口

简体中文 · [English](en/integrations.md)

## 标准 JSON 网站接口

提供 GET 接口，返回[新闻 JSON](news-source-development.md#新闻-json)。在设置中添加地址，选择“标准 JSON”。

- UTF-8 JSON，每次最多 500 条、4 MiB。
- 使用 HTTPS；本机地址可用 HTTP。
- 可选 Bearer 鉴权，Key 在应用中填写，不放进 URL。
- 重复采集按 ID 更新；同一新闻更正时保留 ID。

本地示例：运行 `python3 scripts/mock-feed.py`，添加 `http://127.0.0.1:8765/news`。

## AI 协议与系统提示词

配置完整 URL、模型名称和 Key。

| 协议 | 输入 | 读取结果 |
| --- | --- | --- |
| Chat Completions | system / user `messages` | `choices[0].message.content` |
| Messages | 顶层 `system`、user `messages`、`max_tokens` | `content` 中的 text 块 |
| Responses | `instructions`、`input` | `output` 中的 output_text 块 |
| JEV Decisions | `state`、`questions.news_N` | `answers.news_N.noul` |

Chat、Responses、JEV 默认使用 Bearer；Messages 默认使用 `x-api-key` 和可配置的 `anthropic-version`。

### 普通模型输入

在“高级设置”编辑系统提示词，写入 system / instructions。用户输入：

```json
{
  "user_interests": "关注芯片供应与产品发布",
  "items": [{
    "id": "cls:123",
    "source": "cls",
    "news": "待判断的新闻全文",
    "tags": ["芯片"]
  }]
}
```

### 普通模型输出

```json
{
  "schemaVersion": 1,
  "results": [{
    "id": "cls:123",
    "relevant": true,
    "reason": "涉及关注的芯片供应。",
    "tags": ["芯片"]
  }]
}
```

- 每个输入 ID 返回一次，不缺失、不重复、不增加 ID。
- `relevant` 为布尔值；`reason` 为 1～160 字符。
- `tags` 最多 3 个，每个 1～24 字符，可为空。
- 不添加额外字段或 Markdown；格式错误时本批结果不生效。

按 `relevant` 高亮，未命中新闻照常展示。JSON 约束默认使用提示词，也可选择 JSON Object 或 JSON Schema；Messages 不支持 JSON Object。

### JEV 输入与输出

请求格式：

```json
{
  "model": "用户配置的模型名称",
  "state": {
    "user_interests": "关注芯片供应",
    "decision_policy": "只匹配直接相关的新闻",
    "items": [{"id":"cls:123","source":"cls","news":"新闻全文","tags":[]}]
  },
  "questions": {
    "news_0": {
      "type": "noul",
      "instructions": "按 decision_policy 判断 items[0] 是否符合 user_interests",
      "criteria": {"true":"直接相关","false":"不相关或依据不足"}
    }
  }
}
```

每条新闻对应一个 `news_N`，返回：

```json
{"answers":{"news_0":{"type":"noul","noul":0.92}}}
```

`noul` 为 0～1，达到设置的阈值即高亮，不要求 reason 或 tags。

## 批量和调用限制

- 按请求窗口平滑合批；零散新闻最多额外等待 2 秒。
- 均匀调用，如 15 分钟 6 次，间隔至少 150 秒。超频排队，鉴权或余额错误时暂停。
- 字符上限包含提示词、新闻和 JSON。放不下的留待下一批，单条超限只展示原文。
- 判断结果持久复用；正文、关注条件或模型变更后重新判断。缓存上限 10,000 份 / 4 MiB，满后淘汰最旧记录。

| 设置 | 默认值 |
| --- | --- |
| 每批上限 | 8 条 |
| 并发请求 | 2 个 |
| 请求频控 | 每 1 分钟最多 6 次 |
| 每分钟输入 | 60,000 字符 |
| 单次输入 | 16,000 字符 |
| 文本输出 | 最多 2,048 tokens |
| 每日硬额度 / 失败重试 | 关闭 |

关闭 AI 取消待发和在途请求，保留已有高亮与结果。

## 测试接口

设置中点“测试来源”或“试判一次”；Key 留空使用已存凭据。

命令行实测：`--check-ai <凭据文件> --format decisions,chat,messages,responses`。

协议参考：[JEV](https://openrouter.ai/docs/guides/community/jev-tutorial)、[Messages](https://platform.claude.com/docs/en/api/messages/create)、[Responses](https://developers.openai.com/api/reference/resources/responses/methods/create)。
