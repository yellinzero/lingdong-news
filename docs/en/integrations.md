# Data and AI APIs

[简体中文](../integrations.md) · English

## Standard JSON endpoints

Serve [news JSON](news-source-development.md#news-json) over GET. Add the URL in Settings and select Standard JSON.

- UTF-8 JSON, at most 500 items and 4 MiB per response.
- HTTPS, with HTTP allowed for local addresses.
- Optional Bearer authentication; enter the key in the app, not the URL.
- Reuse the same ID when a story is updated or corrected.

Local example: run `python3 scripts/mock-feed.py` and add `http://127.0.0.1:8765/news`.

## AI protocols

Provide the complete API URL, model and key.

| Protocol | Request | Result |
| --- | --- | --- |
| Chat Completions | system / user `messages` | `choices[0].message.content` |
| Messages | Top-level `system`, user `messages`, `max_tokens` | text blocks in `content` |
| Responses | `instructions`, `input` | output_text blocks in `output` |
| JEV Decisions | `state`, `questions.news_N` | `answers.news_N.noul` |

Chat, Responses and JEV default to Bearer authentication. Messages defaults to `x-api-key` with a configurable `anthropic-version`.

### Text model input

Edit the system prompt in Advanced settings; it goes into system / instructions. User payload:

```json
{
  "user_interests": "Follow chip supply and product launches",
  "items": [{
    "id": "cls:123",
    "source": "cls",
    "news": "Full story text",
    "tags": ["chips"]
  }]
}
```

### Text model output

```json
{
  "schemaVersion": 1,
  "results": [{
    "id": "cls:123",
    "relevant": true,
    "reason": "Directly concerns chip supply.",
    "tags": ["chips"]
  }]
}
```

- Return each input ID exactly once, with no missing or additional IDs.
- `relevant` is boolean; `reason` contains 1–160 characters.
- `tags` may be empty; at most 3 tags, each 1–24 characters.
- No extra fields or Markdown. Invalid batches are not applied.

`relevant` controls highlighting; unrelated stories remain visible. JSON constraints default to prompt instructions. JSON Object and JSON Schema are optional; Messages does not support JSON Object.

### JEV input and output

```json
{
  "model": "your-model",
  "state": {
    "user_interests": "Follow chip supply",
    "decision_policy": "Match only directly relevant stories",
    "items": [{"id":"cls:123","source":"cls","news":"Full story text","tags":[]}]
  },
  "questions": {
    "news_0": {
      "type": "noul",
      "instructions": "Does items[0] match user_interests under decision_policy?",
      "criteria": {"true":"Directly relevant","false":"Unrelated or insufficient evidence"}
    }
  }
}
```

One `news_N` question per story. Response:

```json
{"answers":{"news_0":{"type":"noul","noul":0.92}}}
```

`noul` is a probability from 0 to 1. Highlight at or above the configured threshold. JEV does not need to generate reason or tags.

## Batching and limits

- Batches adapt to the configured request window; sparse arrivals wait up to 2 extra seconds.
- Calls are evenly paced: 6 per 15 minutes means at least 150 seconds apart. Rate-limited work waits; authentication or balance errors pause it.
- Character limits include prompts, news and JSON. Overflow stays queued; individually oversized stories stay visible without analysis.
- Saved decisions survive disabling AI and restart. Changed content, interests or model settings require a new decision. Cache: 10,000 records / 4 MiB, oldest evicted first.

| Setting | Default |
| --- | --- |
| Maximum batch size | 8 stories |
| Concurrent requests | 2 |
| Request rate | 6 per 1 minute |
| Input per minute | 60,000 characters |
| Input per request | 16,000 characters |
| Text output | At most 2,048 tokens |
| Daily hard caps / automatic retries | Off |

Disabling AI cancels queued and in-flight work, preserving highlights and results.

## Test an endpoint

Use “测试来源” or “试判一次” in Settings. A blank key uses saved credentials.

Live CLI test: `--check-ai <credential-file> --format decisions,chat,messages,responses`.

Protocol references: [JEV](https://openrouter.ai/docs/guides/community/jev-tutorial), [Messages](https://platform.claude.com/docs/en/api/messages/create), [Responses](https://developers.openai.com/api/reference/resources/responses/methods/create).
