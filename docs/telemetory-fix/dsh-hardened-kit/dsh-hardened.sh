#!/usr/bin/env bash
# DeepSeek Harness launcher with telemetry/session-log side channels disabled + egress guard (Git Bash / WSL / Linux).
#   ./dsh-hardened.sh web
#   DSH_HARDENED_STRICT=1 ./dsh-hardened.sh --profile headless "job"
#   DSH_HARDENED_AUDIT=1  ./dsh-hardened.sh web      # measure only
set -euo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
to_native() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

export DSH_TELEMETRY_DISABLED=1
export DSH_TELEMETRY_MODE=DISABLED
if [[ "${DSH_HARDENED_STRICT:-0}" == 1 && -z "${DSH_EGRESS_ALLOW:-}" ]]; then
  export DSH_EGRESS_ALLOW='api.deepseek.com,registry.npmjs.org,*.npmjs.org,github.com,*.githubusercontent.com'
fi
export DSH_EGRESS_MODE=$([[ "${DSH_HARDENED_AUDIT:-0}" == 1 ]] && echo audit || echo enforce)
export DSH_EGRESS_LOG="${DSH_EGRESS_LOG:-$(to_native "$KIT/egress-audit.jsonl")}"

if [[ -n "${DSH_ENTRY:-}" ]]; then ENTRY="$DSH_ENTRY"; else
  ENTRY="$(node -e '
    const p=require("path"),cp=require("child_process");
    const root=cp.execSync("npm root -g",{encoding:"utf8"}).trim();
    const dir=p.join(root,"@deepseek-ai","dsh"); const pkg=require(p.join(dir,"package.json"));
    process.stdout.write(p.join(dir, typeof pkg.bin==="string"?pkg.bin:pkg.bin.dsh));')"
fi
GUARD_URL="$(node -e 'process.stdout.write(require("url").pathToFileURL(process.argv[1]).href)' "$(to_native "$KIT/egress-guard.ts")")"
OVERLAY="$(to_native "$KIT/privacy-hardened.patch.yml")"
echo "[dsh-hardened] entry=$ENTRY guard=$DSH_EGRESS_MODE allow=${DSH_EGRESS_ALLOW:-(deny-list only)}" >&2
exec node "--import=$GUARD_URL" "$ENTRY" "$@" --patch "$OVERLAY"
