#!/usr/bin/env bash
# Regenerates tests/fixtures/exiftool-reference.json from ExifTool, the independent reference reader.
# Usage: EXIFTOOL=/path/to/exiftool tests/make-reference.sh
set -euo pipefail
cd "$(dirname "$0")/fixtures"
"${EXIFTOOL:-exiftool}" -j -a -G1 -s -n -struct real/* formats/* > exiftool-reference.json
