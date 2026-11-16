# News source examples

[简体中文](README.md) · English

| Example | Source | Installable package |
| --- | --- | --- |
| CLS | [cls](packages/cls/) | [Preinstalled sources](packages/preinstalled.json) |
| WallstreetCN | [wallstreet](packages/wallstreet/) | Same package |
| Jin10 | [jin10](packages/jin10/) | Same package |
| POST endpoint | [custom-example](packages/custom-example/) | [JSON](examples/custom-logic.news-source.json) |
| RSS | [rss-example](packages/rss-example/) | [JSON](examples/rss-logic.news-source.json) |

Copy an example, edit `id`, `name`, requests and field mappings, then package:

```sh
python3 scripts/pack-source.py my-source --out my-source.news-source.json
```

Install through “设置 → 新闻来源 → 添加新闻来源 → 从文件添加”, then save.

POST / RSS test server: `python3 scripts/mock-feed.py 18765`. [Multiple-subscription OPML example](examples/local-subscriptions.opml).

[Development contract and input/output](../docs/en/news-source-development.md) · [Package schema](../docs/source-package.schema.json)
