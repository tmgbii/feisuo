#!/usr/bin/env bash
# Linux：飞梭 → ../out/Feisuo
# 不打 deb/AppImage，不删 target（第二次起增量）。
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -d node_modules ]]; then
  npm install
fi

npx tauri build --no-bundle

mkdir -p out
cp -f src-tauri/target/release/commbox out/Feisuo
chmod +x out/Feisuo
echo "OK  $(pwd)/out/Feisuo  $(du -h out/Feisuo | awk '{print $1}')"
