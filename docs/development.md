# 本地开发

简体中文 · [English](en/development.md)

## 环境与启动

Node.js 24、pnpm 10.5、Rust stable、Git；打包新闻源需要 Python 3。

| 系统 | 依赖 |
| --- | --- |
| macOS | Xcode Command Line Tools |
| Windows | Visual Studio C++ Build Tools、WebView2 |
| Linux | WebKitGTK 4.1、GTK、AppIndicator、OpenSSL、D-Bus |

[Tauri 环境配置](https://v2.tauri.app/start/prerequisites/)

```sh
git clone https://github.com/yellinzero/lingdong-news.git
cd lingdong-news
pnpm install --frozen-lockfile
pnpm tauri dev
```

`pnpm dev` 仅预览界面。

## 目录

| 目录 | 内容 |
| --- | --- |
| `src/` | 界面与业务逻辑 |
| `src-tauri/` | 窗口、网络、存储、图标 |
| `tests/` | 逻辑与界面测试 |
| `source-adapters/` | 新闻源示例 |
| `scripts/` | 开发与发布脚本 |
| `docs/` | 中英文文档 |

## 检查与打包

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

在目标系统构建，产物位于 `src-tauri/target/release/bundle/`。Mac 可用 `bash scripts/build-desktop.sh` 生成 `dist/LingDongNews.app`，用 `--ui-smoke` 检查窗口交互。

## 界面语言

文案使用 `src/i18n.ts` 的 `t()`，英文译文放在 `src/locales/en.ts`。保留占位符；不要翻译新闻、来源名称或用户提示词。

## 更新资源

- 图标：修改 `src-tauri/icons/icon.svg`，运行 `pnpm icons`。
- 截图：运行 `pnpm docs:screenshots`，统一深色主题与橙色强调色。
- [开发新闻源](news-source-development.md) · [发布版本](releasing.md)

修改预装来源后重新打包：

```sh
python3 scripts/pack-source.py source-adapters/packages/cls source-adapters/packages/wallstreet source-adapters/packages/jin10 --out source-adapters/packages/preinstalled.json
```
