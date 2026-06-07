#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build-macos.sh can only run on macOS." >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo is required but was not found in PATH." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but was not found in PATH." >&2
  exit 1
fi

if ! cargo tauri --version >/dev/null 2>&1; then
  echo "cargo-tauri is not installed; installing tauri-cli..." >&2
  cargo install tauri-cli --locked
fi

if [ ! -d "src-ui/node_modules" ]; then
  (cd src-ui && npm install)
fi

(cd src-ui && npm run build)
cargo tauri build --bundles app "$@"

app_path="$(
  find target -type d -path '*/release/bundle/macos/*.app' -print0 \
    | xargs -0 stat -f '%m %N' \
    | sort -rn \
    | sed -n '1s/^[0-9][0-9]* //p'
)"

if [ -z "$app_path" ]; then
  echo "No macOS .app bundle found under target/*/release/bundle/macos." >&2
  exit 1
fi

echo "Re-signing macOS bundle: $app_path"
codesign --force --deep --sign - "$app_path"

signature="$(codesign -dv --verbose=4 "$app_path" 2>&1)"
printf '%s\n' "$signature"

if printf '%s\n' "$signature" | grep -qE 'flags=.*runtime'; then
  echo "Unexpected hardened runtime flag after ad-hoc re-sign." >&2
  exit 1
fi

if printf '%s\n' "$signature" | grep -q 'Sealed Resources=none'; then
  echo "Bundle resources were not sealed after ad-hoc re-sign." >&2
  exit 1
fi

codesign --verify --deep --strict "$app_path"
echo "Built and verified: $app_path"
