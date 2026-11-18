#!/bin/sh
# Build a styled DMG without relying on Finder automation, including on CI.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
app="$root/src-tauri/target/release/bundle/macos/Keybay.app"
background="$root/src-tauri/dmg/background.png"
settings="$root/src-tauri/dmg/settings.py"
version=$(node -p "require('./package.json').version")
output=${1:-"$root/src-tauri/target/release/bundle/dmg/Keybay_${version}_aarch64.dmg"}
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

# A local certificate keeps the app's designated requirement stable across
# builds. Preserve a signature already supplied by Tauri (e.g. Developer ID).
local_identity=${DB_STUDIO_LOCAL_SIGNING_PEM:-"$HOME/Library/Application Support/DB Studio Signing/identity.pem"}
signature=$(codesign --display --verbose=2 "$app" 2>&1)
if [ -n "${DB_STUDIO_LOCAL_SIGNING_PEM:-}" ] && [ ! -r "$local_identity" ]; then
  echo "无法读取本地签名证书：$local_identity" >&2
  exit 1
fi
if [ -f "$local_identity" ] && printf '%s\n' "$signature" | grep -qx 'Signature=adhoc'; then
  signer=${RCODESIGN:-rcodesign}
  if [ "$signer" = rcodesign ] && ! command -v rcodesign >/dev/null 2>&1 && [ -x "$HOME/.local/bin/rcodesign" ]; then
    signer="$HOME/.local/bin/rcodesign"
  fi
  if ! command -v "$signer" >/dev/null 2>&1; then
    echo "本地签名证书已配置，请安装 rcodesign 或设置 RCODESIGN 后重新打包" >&2
    exit 1
  fi
  staging=$(mktemp -d)
  trap 'rm -rf "$staging"' EXIT
  trap 'exit 1' HUP INT TERM
  ditto "$app" "$staging/Keybay.app"
  app="$staging/Keybay.app"
  "$signer" sign --config-file /dev/null --timestamp-url none --pem-file "$local_identity" "$app"
  codesign --verify --deep --strict "$app"
  codesign --display -r- "$app" 2>&1 | grep -q '^designated =>.*certificate '
fi

mkdir -p "$(dirname -- "$output")"
"$dmgbuild" -s "$settings" -D "app=$app" -D "background=$background" "Keybay ${version}" "$output"
