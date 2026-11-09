#!/usr/bin/env bash
# Prompt-cache report over the DSH sessions of Windows user tokob (1-hour TTL).
# Usage: docs/feat/cache-hit/cache-report.sh [sessionIdPrefix] [--detail]
# Override the sessions directory with CACHE_REPORT_ROOT.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="${CACHE_REPORT_ROOT:-/c/Users/tokob/.dsh/sessions}"
exec node "$here/cache-report.mjs" --ttl-min 60 --root "$root" "$@"
