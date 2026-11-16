#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm install --frozen-lockfile
build_args=(build --bundles app)
# Keep local rebuilds under the same signing identity without publishing it.
if [[ -f dist/macos-signing.local.json ]]; then
  build_args+=(--config dist/macos-signing.local.json)
fi
pnpm tauri "${build_args[@]}"
mkdir -p dist
ditto "src-tauri/target/release/bundle/macos/LingDongNews.app" "dist/LingDongNews.app"
echo "$PWD/dist/LingDongNews.app"
