<p align="center">
  <img src="src-tauri/icons/icon.svg" width="80" height="80" alt="LingDongNews icon">
</p>
<h1 align="center">LingDongNews · 灵动新闻</h1>
<p align="center">lingdong-news · 0.1.1</p>
<p align="center">A few minutes while your agent works. A quick look at the news.</p>
<p align="center">
  <a href="README.md">简体中文</a> · English<br>
  <a href="https://github.com/yellinzero/lingdong-news/releases">Download</a> ·
  <a href="https://www.youtube.com/watch?v=kb6YXzWzQ-0">Demo video</a> ·
  <a href="docs/en/usage.md">User guide</a> ·
  <a href="docs/en/news-source-development.md">Build a news source</a> ·
  <a href="docs/en/development.md">Development</a>
</p>

A desktop news ticker with automatic updates, single-line scrolling and keyword or AI highlights.

<p align="center"><img src="docs/assets/v0.1.1/en/compact-dark.png" width="460" alt="Compact ticker showing one story, with a matching topic highlighted"></p>

## Demo

[![Watch the LingDongNews English demo](docs/assets/demo/cover.en.png)](https://www.youtube.com/watch?v=kb6YXzWzQ-0)

[Watch the English demo](https://www.youtube.com/watch?v=kb6YXzWzQ-0) · [中文演示](https://www.youtube.com/watch?v=5_2iOTCwTzM)

## Get started

1. Choose sources in Settings.
2. Adjust the window and scrolling speed.
3. Enable keyword or AI highlighting as needed.

## A small floating window that stays out of your way

News scrolls on one line; click a story to read its full text. The window stays on top by default, with adjustable size, position and scrolling speed.

<p align="center"><img src="docs/assets/v0.1.1/en/reader-expanded-dark.png" width="480" alt="Full story opened from the compact ticker"></p>

## Highlight topics with keywords

Enter terms in Settings → Keywords, such as `inference chip, interest rate`. Matches are highlighted; other stories stay visible.

<table>
  <tr><th>Choose your terms</th><th>See matches in the feed</th></tr>
  <tr>
    <td width="50%" valign="top"><a href="docs/assets/v0.1.1/en/keyword-settings-dark.png"><img src="docs/assets/v0.1.1/en/keyword-settings-dark.png" alt="Keyword settings with highlighting enabled and two terms entered"></a></td>
    <td width="50%" valign="top"><a href="docs/assets/v0.1.1/en/keyword-result-dark.png"><img src="docs/assets/v0.1.1/en/keyword-result-dark.png" alt="Matching stories highlighted alongside their keyword labels"></a></td>
  </tr>
</table>

## Let AI identify stories that interest you

Enter your API URL, model, key and interests. AI highlights relevant stories in batches. Supports **Chat Completions, Messages, Responses and JEV Decisions**.

Set rate and character limits, or turn AI off with one click. Highlights and saved decisions remain; identical content reuses results.

<table>
  <tr><th>Configure AI and your interests</th><th>Highlight relevant stories by meaning</th></tr>
  <tr>
    <td width="50%" valign="top"><a href="docs/assets/v0.1.1/en/ai-settings-dark.png"><img src="docs/assets/v0.1.1/en/ai-settings-dark.png" alt="AI protocol, endpoint, model, credential and interest settings"></a></td>
    <td width="50%" valign="top"><a href="docs/assets/v0.1.1/en/ai-result-dark.png"><img src="docs/assets/v0.1.1/en/ai-result-dark.png" alt="JEV highlights inference hardware and open-source deployment news while keeping other stories visible"></a></td>
  </tr>
</table>

[Configuration and limits](docs/en/usage.md#keywords-and-ai) · [API contracts](docs/en/integrations.md#ai-protocols)

## Add the news sources you read

CLS, WallstreetCN and Jin10 are preinstalled. Add multiple RSS / Atom / JSON Feed subscriptions, JSON endpoints or custom adapters. Sources can be enabled, uninstalled and reinstalled.

<p align="center"><img src="docs/assets/v0.1.1/en/sources-settings-dark.png" width="480" alt="Preinstalled sources and a custom subscription managed in one list"></p>

[Source development guide](docs/en/news-source-development.md) · [Runnable examples](source-adapters/README.en.md)

## Developer documentation

[Develop, test and build](docs/en/development.md) · [Versions and CI](docs/en/releasing.md)

## License

Project code and original icons are licensed under [MIT](LICENSE).
