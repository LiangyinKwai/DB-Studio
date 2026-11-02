#!/bin/sh
# Build a styled DMG without relying on Finder automation, including on CI.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
app="$root/src-tauri/target/release/bundle/macos/DB Studio.app"
background="$root/src-tauri/dmg/background.png"
settings="$root/src-tauri/dmg/settings.py"
version=$(node -p "require('./package.json').version")
output=${1:-"$root/src-tauri/target/release/bundle/dmg/DB Studio_${version}_aarch64.dmg"}
dmgbuild=${DMGBUILD:-dmgbuild}
if [ ! -d "$app" ]; then
  echo "构建 DMG 前请先运行 npm run tauri -- build --bundles app" >&2
  exit 1
fi
if [ -e "$output" ]; then
  echo "目标文件已存在，请指定新的输出路径：$output" >&2
  exit 1
fi
actual_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")
if [ "$actual_version" != "$version" ]; then
  echo "应用版本 $actual_version 与项目版本 $version 不一致，请先重新构建应用" >&2
  exit 1
fi
codesign --verify --deep --strict "$app"
mkdir -p "$(dirname -- "$output")"
"$dmgbuild" -s "$settings" -D "app=$app" -D "background=$background" "DB Studio ${version}" "$output"
