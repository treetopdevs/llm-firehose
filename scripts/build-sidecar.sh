#!/usr/bin/env bash
# Builds the firehosed daemon into the Tauri sidecar slot. Tauri expects
# external binaries suffixed with the host target triple, e.g.
# binaries/firehosed-aarch64-apple-darwin(.exe).
set -euo pipefail

cd "$(dirname "$0")/.."

TRIPLE="${1:-$(rustc -vV | sed -n 's/^host: //p')}"
if [ -z "$TRIPLE" ]; then
  echo "error: could not determine target triple (is rustc installed?)" >&2
  exit 1
fi

case "$TRIPLE" in
aarch64-apple-darwin) GOOS=darwin GOARCH=arm64 ;;
x86_64-apple-darwin) GOOS=darwin GOARCH=amd64 ;;
x86_64-unknown-linux-gnu) GOOS=linux GOARCH=amd64 ;;
aarch64-unknown-linux-gnu) GOOS=linux GOARCH=arm64 ;;
x86_64-pc-windows-msvc) GOOS=windows GOARCH=amd64 ;;
aarch64-pc-windows-msvc) GOOS=windows GOARCH=arm64 ;;
*)
  echo "error: unmapped target triple $TRIPLE" >&2
  exit 1
  ;;
esac

EXT=""
if [ "$GOOS" = "windows" ]; then
  EXT=".exe"
fi

OUT="apps/tauri-desktop/src-tauri/binaries/firehosed-${TRIPLE}${EXT}"
mkdir -p "$(dirname "$OUT")"
echo "building $OUT (GOOS=$GOOS GOARCH=$GOARCH)"
CGO_ENABLED=0 GOOS="$GOOS" GOARCH="$GOARCH" go build -trimpath -ldflags="-s -w" -o "$OUT" ./cmd/firehosed
echo "done"
