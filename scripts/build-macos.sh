#!/usr/bin/env bash
# macOS：飞梭 → ../out/飞梭.app + ../out/飞梭.dmg
# 打 .app 与 dmg（拖进 Applications），不删 target。
set -euo pipefail
cd "$(dirname "$0")/.."
shopt -s nullglob

if [[ ! -d node_modules ]]; then
  npm install
fi

npx tauri build --bundles app,dmg

APP_SRC=""
for candidate in src-tauri/target/release/bundle/macos/*.app; do
  if [[ -d "$candidate" ]]; then
    APP_SRC="$candidate"
    break
  fi
done
if [[ -z "$APP_SRC" ]]; then
  echo "未生成 .app" >&2
  exit 1
fi

DMG_SRC=""
for candidate in src-tauri/target/release/bundle/dmg/*.dmg src-tauri/target/release/bundle/macos/*.dmg; do
  if [[ -f "$candidate" ]]; then
    DMG_SRC="$candidate"
    break
  fi
done
if [[ -z "$DMG_SRC" ]]; then
  echo "未生成 .dmg" >&2
  exit 1
fi

mkdir -p out
rm -rf out/飞梭.app out/Feisuo.app
rm -f out/Feisuo out/飞梭.dmg out/Feisuo.dmg
ditto "$APP_SRC" out/飞梭.app
cp -f "$DMG_SRC" out/飞梭.dmg
echo "OK  $(pwd)/out/飞梭.app  $(du -sh out/飞梭.app | awk '{print $1}')"
echo "OK  $(pwd)/out/飞梭.dmg  $(du -sh out/飞梭.dmg | awk '{print $1}')"
