# dsh-hardened-kit 1.0.0 (2026-11-07)

A privacy hardening kit for DeepSeek Harness (DSH). See `deepseek_harness_telemetry_hardening_2026-11-07.md` for the full background and design.

| File | Role | Verification status |
|---|---|---|
| `egress-guard.ts` | Process-wide outbound guard (fetch / http(s) / dns; propagates to Workers and child Node processes). Strips `dsh_*` fields and `x-deepseek-harness-*` headers, and blocks `*.deepseeksvc.com` | Self-test passed 12/12 on Node 24.22 + tsc strict |
| `egress-guard.selftest.ts` | Guard self-test (no network required) | `node egress-guard.selftest.ts` |
| `wire-test.ts` | Starts a mock DeepSeek Messages API and inspects the outbound packets of real DSH | Detection logic verified with fake stock/hardened processes |
| `privacy-hardened.patch.yml` | Cordis overlay passed via `--patch` (session-log / inventory / OTel) | YAML validation passed. Verify against real DSH with wire-test |
| `dsh-hardened.ps1` / `dsh-hardened.sh` | Launchers (env opt-out + guard + overlay) | `.sh` tested; `.ps1` not run in this environment (no pwsh) |
| `fork/apply-hardening.ts` | Idempotent fork codemod with drift detection | Applied, idempotent, and drift-detected on an upstream-shaped fixture |
| `fork/hardened-fetch.ts` | In-source filter inserted into llm-deepseek / web-deepseek-api | tsc strict passed |
| `fork/hardening-ci.yml` | Upstream sync → re-hardening → build → wire verification CI | YAML validation only |

## Quick start (Windows, today, no fork)

```powershell
# 1) Unpack the kit somewhere outside node_modules
Expand-Archive dsh-hardened-kit.zip C:\tools\dsh-hardened
cd C:\tools\dsh-hardened
node .\egress-guard.selftest.ts                 # Confirm ALL 12 CHECKS PASSED
.\dsh-hardened.ps1 -InstallHomePatch            # Write the overlay to %USERPROFILE%\.dsh\cordis.patch.yml as well (also applies to Desktop)
.\dsh-hardened.ps1 web                          # Launch the hardened Web UI
# Measure before trusting: verify the real DSH on the wire
node .\wire-test.ts --entry "$(npm root -g)\@deepseek-ai\dsh\<bin>" --patch .\privacy-hardened.patch.yml --guard audit
```

Git Bash: `./dsh-hardened.sh web` / `DSH_HARDENED_STRICT=1 ./dsh-hardened.sh web`

## Fork

```bash
git clone https://github.com/deepseek-ai/deepseek-harness dsh-hardened && cd dsh-hardened
git checkout -b hardened <pinned tag or commit>
mkdir hardening && cp -r /c/tools/dsh-hardened/* hardening/
node hardening/fork/apply-hardening.ts --dry-run && node hardening/fork/apply-hardening.ts
pnpm install --frozen-lockfile && pnpm run build
node hardening/wire-test.ts --cmd "pnpm dsh" --no-env-optout --guard audit   # The fork itself is PASS even without env vars
```

Opt back in (only when needed; every default is OFF): `DSH_HARDENED_ALLOW_SESSION_LOG_UPLOAD=1` / `DSH_HARDENED_ALLOW_PLUGIN_INVENTORY=1` / `DSH_HARDENED_ALLOW_PERSISTENT_ID=1` / `DSH_HARDENED_ALLOW_SESSION_HEADER=1`
