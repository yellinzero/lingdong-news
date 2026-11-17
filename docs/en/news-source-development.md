# Build a news source

[简体中文](../news-source-development.md) · English

## Ways to connect

| Method | How to connect |
| --- | --- |
| RSS / Atom / JSON Feed | Add URLs in Settings → News sources → Add source; bulk entry and OPML are supported |
| Standard JSON endpoint | Expose a GET endpoint returning the format below, then add its URL |
| Custom adapter | Write `manifest.json` and `adapter.js`, package them as `.news-source.json`, and install |

## News JSON

Endpoints and adapters return:

```json
{
  "version": 1,
  "items": [{
    "id": "news-123",
    "title": "Story title",
    "body": "Full story text",
    "publishedAt": "2026-11-16T09:30:00+08:00",
    "url": "https://example.com/news/123",
    "tags": ["technology"]
  }]
}
```

| Field | Requirement |
| --- | --- |
| `version` | Always `1` |
| `items` | At most 500 items; an empty array means no news |
| `id` | Required; 1–200 characters; unique within the source and stable across refreshes |
| `body` | Required; full plain text, up to 32,000 characters |
| `publishedAt` | Required; timezone-aware ISO timestamp or Unix milliseconds |
| `title` | Optional; up to 1,000 characters |
| `url` | Optional; original HTTP / HTTPS URL |
| `tags` | Optional; at most 8 tags, each up to 24 characters |

Keep IDs for corrections; use prefixes such as `site-a:123` across sites. Source tags and match labels are separate.

[News schema](../news-feed.schema.json)

## Write an adapter

Create `manifest.json` and `adapter.js` in one directory.

**manifest.json**

```json
{
  "id": "custom:my-news",
  "name": "My news",
  "version": "1.0.0",
  "apiVersion": 1,
  "entry": "adapter.js",
  "network": ["https://example.com"],
  "config": []
}
```

| Field | Requirement |
| --- | --- |
| `id` | `custom:` followed by 1–73 letters, digits, underscores or hyphens |
| `name` | Display name, 1–32 characters |
| `version` | Three-part version such as `1.0.0`; retain the ID and increase the version for updates |
| `apiVersion` / `entry` | Always `1` / `adapter.js` |
| `network` | Up to 16 allowed origins, including scheme and port; no paths or wildcards |
| `config` | Up to 32 string, number or boolean parameters, read through `ctx.config` |

Example parameter: `{"key":"channel","label":"Channel","kind":"string","default":"tech","required":true}`. Keys contain 1–64 letters, digits or underscores; `__proto__`, `constructor` and `prototype` are reserved.

**adapter.js**

Example upstream: `{"rows":[{"id":"123","content":"Story text","time":1794792600}]}`; time is Unix seconds.

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

`fetch(ctx)` returns news JSON synchronously. Use plain JavaScript without Promises, module imports, Node APIs, DOM or timers.

## Inputs and host functions

| Input / API | Meaning |
| --- | --- |
| `ctx.now` | Fetch time, Unix milliseconds |
| `ctx.config` | User-entered, non-secret parameters |
| `ctx.request({url,method?,headers?,body?,useKey?})` | Returns `{status,text,headers}`; GET and POST; body is a string |
| `ctx.sha1(text)` / `ctx.md5(text)` | Hexadecimal digest |
| `ctx.plain(html)` | HTML to plain text |
| `ctx.parseFeed(text,url)` | RSS / Atom / JSON Feed to news JSON |
| `ctx.mapJSON(text,rules)` | Field mapping to news JSON |

Declare all origins in `network`. Use HTTPS except locally; redirects are disabled.

## Field mappings

| `rules` field | Meaning |
| --- | --- |
| `itemsPath` | Item-array path; `""` for a top-level array |
| `idPath` / `titlePath` | ID / title path |
| `bodyPaths` | Body paths, selecting the first nonempty value |
| `datePath` / `dateUnit` | Timestamp path; `seconds`, `milliseconds`, `iso` or `local` |
| `timezone` | Timezone for local timestamps, such as `+08:00` |
| `urlPath` / `urlTemplate` | Original URL path or template supporting `{id}` |
| `tagsPath` | Tag-array path |
| `jsonPrefix` | Fixed prefix to remove before parsing, such as `var newest =` |
| `exclude` | Exclusion rules; `truthy`, `gt` and `contains` |

Paths support dots and array indexes. See the [CLS](../../source-adapters/packages/cls/adapter.js), [WallstreetCN](../../source-adapters/packages/wallstreet/adapter.js) and [Jin10](../../source-adapters/packages/jin10/adapter.js) examples.

## Authentication

Add this to the manifest when a key is needed:

```json
"auth": {"origin":"https://example.com","header":"Authorization","prefix":"Bearer "}
```

Declare the origin in `network`. Use `Authorization` or `x-api-key`. Users enter keys in the app; `useKey:true` injects them. Keep keys and cookies out of scripts and config.

## Package, test and install

From the repository root:

```sh
python3 scripts/pack-source.py my-source --out my-source.news-source.json
cargo run --manifest-path src-tauri/Cargo.toml -- --check-source-file my-source.news-source.json
```

Install and save through “Settings → News sources → Add news sources → Import file”. Test authenticated sources in the app.

Share the package directly; it can contain multiple sources. See the [package schema](../source-package.schema.json).

Runnable [POST](../../source-adapters/packages/custom-example/) and [RSS](../../source-adapters/packages/rss-example/) examples use `python3 scripts/mock-feed.py 18765`.

## Runtime limits

| Resource | Limit |
| --- | --- |
| Files | 256 KiB per script, 1 MiB per package, 4 MiB total local scripts |
| Execution | 32 MiB memory, about 2 seconds of JS computation, 30 seconds total |
| Network | 8 requests per fetch, 20 seconds per request |
| Data | 256 KiB request body; 4 MiB per response, 8 MiB total responses; 4 MiB output |

No local file, process or environment access. Return enough data to cover the 30 / 60 / 120-second fetch interval. Raw cache: 7 days, up to 1,000 stories.
