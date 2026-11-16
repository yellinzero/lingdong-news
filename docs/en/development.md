# Development

[简体中文](../development.md) · English

## Setup

Node.js 24, pnpm 10.5, Rust stable and Git. Source packaging requires Python 3.

| Platform | Dependencies |
| --- | --- |
| macOS | Xcode Command Line Tools |
| Windows | Visual Studio C++ Build Tools, WebView2 |
| Linux | WebKitGTK 4.1, GTK, AppIndicator, OpenSSL, D-Bus, Secret Service |

[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

```sh
git clone https://github.com/yellinzero/lingdong-news.git
cd lingdong-news
pnpm install --frozen-lockfile
pnpm tauri dev
```

`pnpm dev` previews the UI only.

## Layout

| Directory | Contents |
| --- | --- |
| `src/` | UI and application logic |
| `src-tauri/` | Windows, network, storage, icons |
| `tests/` | Logic and UI tests |
| `source-adapters/` | News source examples |
| `scripts/` | Development and release scripts |
| `docs/` | Chinese and English guides |

## Check and build

```sh
pnpm test
pnpm test:release
pnpm exec playwright install webkit chromium
pnpm test:ui
cargo test --locked --manifest-path src-tauri/Cargo.toml
pnpm docs:check
pnpm version:check
pnpm tauri build
```

Build on the target OS; output is in `src-tauri/target/release/bundle/`. On Mac, `bash scripts/build-desktop.sh` creates `dist/LingDongNews.app`; `--ui-smoke` checks window interactions.

## Update resources

- Icons: edit `src-tauri/icons/icon.svg`, run `pnpm icons`.
- Screenshots: run `pnpm docs:screenshots`; use dark theme and orange accents.
- [Build a source](news-source-development.md) · [Release a version](releasing.md)

Repack preinstalled sources after editing:

```sh
python3 scripts/pack-source.py source-adapters/packages/cls source-adapters/packages/wallstreet source-adapters/packages/jin10 --out source-adapters/packages/preinstalled.json
```
