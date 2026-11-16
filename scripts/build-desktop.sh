#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm install --frozen-lockfile
pnpm tauri build --bundles app
mkdir -p dist
ditto "src-tauri/target/release/bundle/macos/LingDongNews.app" "dist/LingDongNews.app"
echo "$PWD/dist/LingDongNews.app"
