#!/usr/bin/env bash
# Builds private-tools-signer in this directory. cgo (a C compiler) is required.
set -euo pipefail
cd "$(dirname "$0")"
if command -v go >/dev/null 2>&1; then
  go build -trimpath -o private-tools-signer .
elif command -v mise >/dev/null 2>&1; then
  mise exec go@latest -- go build -trimpath -o private-tools-signer .
else
  echo "Go is required: https://go.dev/dl/" >&2
  exit 1
fi
echo "Built $(pwd)/private-tools-signer"
