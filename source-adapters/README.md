# 新闻源示例

简体中文 · [English](README.en.md)

| 示例 | 目录 | 安装文件 |
| --- | --- | --- |
| 财联社 | [cls](packages/cls/) | [预装来源包](packages/preinstalled.json) |
| 华尔街见闻 | [wallstreet](packages/wallstreet/) | 同上 |
| 金十 | [jin10](packages/jin10/) | 同上 |
| POST 接口 | [custom-example](packages/custom-example/) | [JSON](examples/custom-logic.news-source.json) |
| RSS | [rss-example](packages/rss-example/) | [JSON](examples/rss-logic.news-source.json) |

复制示例，修改 `id`、`name`、请求和字段转换，再打包：

```sh
python3 scripts/pack-source.py my-source --out my-source.news-source.json
```

在“设置 → 新闻来源 → 添加新闻来源 → 从文件添加”安装并保存。

POST / RSS 测试服务：`python3 scripts/mock-feed.py 18765`。[多个订阅的 OPML 示例](examples/local-subscriptions.opml)。

[开发规范与输入输出](../docs/news-source-development.md) · [安装文件 Schema](../docs/source-package.schema.json)
