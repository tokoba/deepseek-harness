# Cache Hit Ratio Improvement — DeepSeek Harness × GitHub Copilot Enterprise

- Status: Design proposal / investigation
- Date: 2026-11-08
- Target: locally built `deepseek-ai/deepseek-harness`, GitHub Copilot Enterprise provider integration
- Intended repository path: `docs/feat/cache-hit-ratio-improvement.md`
- Scope: architecture, implementation plan, instrumentation, experiments, acceptance criteria; **no source changes implemented**.

## 1. Executive decision

**Priority order:** (P0) reliable provider usage telemetry and prefix-diff diagnostics; (P1) deterministic prompt/tool construction and dynamic-context relocation; (P2) cache-aware history management and tool-schema loading; (P3) measured, opt-in, provider-aware keep-alive; (P4) experimental retention settings where the actual Copilot endpoint explicitly supports them.

Do **not** assume that a local plugin can preserve a remote provider's KV cache. It can improve cacheability of requests, but provider retention, routing, eviction, cache-control fields and billing remain under the Copilot/model provider's control. Do **not** conflate DeepSeek API disk caching with GitHub Copilot's OpenAI/Anthropic-backed caching.

## 2. Evidence and confidence

### Primary sources

1. DeepSeek Harness upstream architecture, plugin-first design, build workflow: https://github.com/deepseek-ai/deepseek-harness
2. VS Code engineering: *Improving token efficiency for GitHub Copilot in VS Code* (2026-06-17): https://code.visualstudio.com/blogs/2026/06/17/improving-token-efficiency-in-github-copilot
3. GitHub Enterprise AI credits and input/output/cached-token billing: https://docs.github.com/copilot/concepts/billing/usage-based-billing-for-organizations-and-enterprises
4. GitHub Copilot SDK usage and billing events: https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/usage-and-billing
5. Anthropic prompt caching documentation: https://docs.anthropic.com/api/prompt-caching
6. OpenAI prompt caching documentation: https://platform.openai.com/docs/guides/prompt-caching
7. DSH token-meter projection implementation: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/token-meter/src/usage-projection.ts

### Relevant community implementations and issue reports

- `dongsheng123132/dsh-cache-stabilizer`: https://github.com/dongsheng123132/dsh-cache-stabilizer — moves known cwd persona content into runtime context, canonicalizes schema object keys, exposes `/cache`. Reports DSH 0.2.0-rc.2 compatibility; validate on local commit.
- `121212165/dsh-plugin-cache-guard`: https://github.com/121212165/dsh-plugin-cache-guard — distinguishes prefix rewrite from ordinary prompt growth; reports token usage and diagnostics.
- `theworld-lab/deep-seek-cache-plugin`: https://github.com/theworld-lab/deep-seek-cache-plugin — canonicalization and prefix diagnostics; **primarily DeepSeek API**, not proven for Copilot.
- DSH discussion #8993: https://github.com/deepseek-ai/deepseek-harness/discussions/8993 — `{{model}}` in `personaPrefix` can change initial system-prompt bytes; cross-model cache reuse is **not guaranteed** even if this text is stabilized.
- DSH discussion #8190: https://github.com/deepseek-ai/deepseek-harness/discussions/8190 — gateway-specific cache-write usage aliases can be misclassified as uncached input.
- DSH discussion #9225: https://github.com/deepseek-ai/deepseek-harness/discussions/9225 — one-hour cache-write token breakdown may be lost in `llm-pi-ai` mapping; verify against current source.
- Community research on Copilot control limitations: https://github.com/olonok69/copilot_code_ml_engineer/blob/main/examples/prompt-caching/README.md

**Evidence hierarchy:** official provider and GitHub docs > upstream source at pinned commit > upstream issue with reproduction > community plugin README. Repository issue reports are leads, not proof that a bug still exists on the locally checked-out version. Public web investigation is not a local source audit.

## 3. Problem model

Each model call serializes some combination of tool schemas, system/developer instructions, session messages, runtime context and recent tool output. Prompt caches typically reuse an **identical initial token prefix**, not arbitrary matching substrings. Consequently:

- An early system-message change can destroy reuse of all later history.
- A tool catalog/schema change can destroy reuse, depending on provider-specific request layout.
- New user messages appended after an unchanged prefix normally allow reuse of the existing prefix.
- Context compaction, truncation, editing past turns or injecting retrieved content near the front can create a new prefix.
- Provider cache expiry, routing and eviction can produce misses **even when the serialized prompt is unchanged**.
- Model selection and provider route define separate cache domains unless proven otherwise.

**Critical distinction:** DSH's session projection cache is local application-state caching, not the inference provider's prompt/KV cache. Neither local session persistence nor a locally stored prefix hash restores remote model KV state.

### Cache-hit metrics

For each model call, collect, when provider actually supplies them:

- `U` = uncached input tokens
- `R` = cache-read tokens
- `W` = cache-write tokens (if reported separately)
- `O` = output tokens
- `T = U + R + W` = billable input-token buckets, **only if** adapter semantics guarantee disjoint buckets
- `hit_ratio = R / T` when T > 0
- `cache_eligible_hit_ratio` = R / eligible-prefix tokens when a reliable eligible-prefix estimate exists; otherwise unavailable
- `estimated_input_cost = U*price_uncached + R*price_read + W5*price_write_5m + W1h*price_write_1h` using actual per-model GitHub Copilot pricing and confirmed bucket semantics

Never silently turn absent usage fields into zero in provider-quality diagnostics. Distinguish `missing`, `zero`, `estimated` and `provider-reported`. Do not equate high cache ratio with low total spend: growing history and unnecessary keep-alive calls can increase cost.

## 4. Architectural proposal

Implement a **Cache Efficiency Layer (CEL)** with three separable parts:

1. **Request observer:** records a privacy-safe fingerprint of the final outbound model request and provider usage response.
2. **Semantic-preserving normalizer:** canonicalizes deterministic schema generation and relocates only explicitly approved dynamic fields, before final provider serialization.
3. **Policy controller:** recommends or executes narrowly scoped retention/keep-alive behavior only when the provider path and measured economics justify it.

Suggested internal boundaries (conceptual, not verified API names):

```text
Session/history + system prompt + tool registry
              |
     Prompt assembly stage
              |
  Cache Efficiency Layer (normalizer)
              |
  Provider-specific serializer/adapter
              |
  Final-wire fingerprint observer ------> local diagnostic store
              |
  GitHub Copilot provider transport
              |
  Usage mapper / token-meter -----------> cost and cache dashboards
```

**Instrument at the final provider request boundary.** Comparing an earlier internal prompt representation can miss changes introduced by SDK adapters, tool schema conversion or JSON serialization. For privacy, hash a canonical representation locally with a per-install secret; do not log source text, credentials or full prompts by default. A token-level divergence may differ from a byte-level divergence; label diagnostic precision correctly.

### 4.1 Stable-prefix partitioning

Recommended conceptual sequence:

1. Stable persona / agent instructions (avoid model name, timestamp, cwd, branch name and volatile status).
2. Stable, deterministic tool declarations and schemas.
3. Stable project rules (versioned, change only on intentional refresh).
4. Append-only conversation history.
5. Fresh task-specific context and tool results at their correct chronological positions.

**Do not blindly reorder message roles, system instructions, tools or tool results.** Actual wire ordering is provider-specific and may be constrained by SDK behavior. Preserve semantic and security boundaries: developer/system instructions must not be demoted to untrusted user text merely to gain cache hits.

### 4.2 Deterministic tool catalogs

- Keep tool registration order deterministic, and canonicalize nested JSON-schema object keys where semantics are unchanged.
- Freeze the **visible tool-set version per active session** unless a capability change is necessary; include a stable `toolset_version` in local diagnostics, not the prompt.
- Separate small, always-visible tool discovery metadata from full tool schemas if the harness/provider supports deferred loading.
- Do not assume sorting tools helps: upstream DSH plugin documentation reports top-level tool order is already deterministic; test schema serialization and actual wire requests first.
- Treat MCP server reconnects, dynamic discovery, schema descriptions and plugin hot reload as potential prefix invalidators.
- Preserve schema property ordering when the order conveys meaning or affects generated model behavior; compare task success, not only cache hits.

### 4.3 System prompt stabilization

- Inspect `system-prompt` configuration, `personaPrefix`, template interpolation and all environment snapshots.
- If the current persona interpolates `{{model}}`, use a stable persona only where the model identity is not needed for correct instructions; still partition cache statistics by actual model and route.
- Move volatile cwd/time/branch information into an existing dynamic runtime context slot **only if** the semantic timing and trust level are preserved.
- Freeze AGENTS.md / instruction-file snapshots for the current turn/session; apply file changes at an explicit refresh boundary, never conceal new security-relevant rules.
- Use versioned hashes for persona, project rules, tool schemas and runtime context.

### 4.4 History, compaction and context growth

- Preserve append-only history when possible.
- Detect impending context pressure before automatic compaction; choose a compaction boundary based on task continuity, quality and total cost.
- Keep an explicit immutable summary of decisions, current files, tests and unresolved tasks when compaction is unavoidable.
- Do not repeatedly rewrite early historical turns with new summaries; make compaction an explicit new cache epoch.
- Avoid inserting retrieval/RAG content into the earliest system message on every turn. Append retrieved content at the appropriate late conversation position, with source and freshness metadata.
- For independent research, use subagents when they reduce main-thread context bloat; note each subagent can incur its own cold prefix and cost.

## 5. Provider-specific retention and keep-alive

### 5.1 OpenAI-family via GitHub Copilot

OpenAI's direct API documents automatic prompt caching and model/endpoint-dependent retention options. **These direct API controls must not be assumed available through GitHub Copilot's provider transport.** First inspect the Copilot plugin/adapter's request schema and capture whether supported cache-related fields are passed through. Do not inject undocumented options into production calls.

Potential optimization: stable model/route, stable prefix, continued use of an active session. Any `prompt_cache_key` or retention setting is experimental until the Copilot endpoint demonstrably accepts it and usage metrics show an improvement.

### 5.2 Anthropic-family via GitHub Copilot

Anthropic direct API documentation describes short-lived cache entries and optional longer-lived cache controls, with provider-specific write/read economics. A five-minute default and one-hour optional duration are **direct-API behavior, not a verified GitHub Copilot Enterprise guarantee**. Confirm whether the Copilot transport controls cache breakpoints/TTL and exposes read/write metrics. Keep tool/system content stable; avoid changing the prefix to refresh a cache.

### 5.3 Why naive keep-alive is dangerous

A keep-alive model request is not a zero-cost ping: it can consume input, output, cache writes and AI Credits. Sending a repeated prompt every few minutes may produce little benefit if the provider route is different, the cache has already expired, the prefix has changed, or retention is not refreshed as expected. It may also trigger rate limits or generate unnecessary model work.

**Default policy: `keepAlive.enabled = false`.** Enable only after a controlled experiment proves savings under a particular model/route and realistic idle-time distribution.

**Break-even decision:** Let `P` be the probability that the next real user call arrives after the natural cache expiry but before the proposed keep-alive benefit expires; `S` the measured expected reduction in the next call's input cost; `K` the expected cost of all keep-alive calls (including cache writes and output). Activate only when `P*S > K + safety_margin`, and task-quality/rate-limit constraints are satisfied. These quantities must be measured, not invented.

Recommended guards:

- explicit opt-in per provider/model/session;
- maximum one outstanding keep-alive per session and strict per-hour cap;
- only when idle, never during an active user request;
- do not generate synthetic user-facing conversation turns or modify durable history;
- use an authorized, non-sensitive, semantically valid request and verify it refreshes the **same** cacheable prefix;
- automatically disable on unknown usage metrics, repeated misses, throttling, billing anomalies or route changes;
- honor Enterprise administrator policies and API terms; no covert bypass of metering or quotas.

## 6. Implementation plan for local source checkout

### Phase 0 — Pin and audit local implementation

Record `git rev-parse HEAD`, active branch, package versions, GitHub Copilot plugin version, selected model IDs, provider route and session profile. Identify actual request assembly and usage mapping using:

```bash
rg -n 'personaPrefix|cacheReadTokens|cacheWriteTokens|cacheRetention|prompt_cache|cache_control' packages apps docs
rg -n 'system-prompt|tokenUsage|llm-pi-ai|tool.*schema|serialize|compaction' packages apps
rg -n 'copilot|github-copilot|provider' packages apps docs
```

Candidate confirmed upstream location: `packages/llm/token-meter/src/usage-projection.ts`. Other integration points **must be located in the local checkout**; no unverified filename should be treated as an exact patch target. The Copilot provider may be installed as an external plugin rather than present in the upstream monorepo.

Deliverables: dependency graph, sequence diagram, local version compatibility matrix, list of wire serialization points and normalized usage fields.

### Phase 1 — Read-only `cache-observer` plugin

- Observe each outgoing call's final effective model, provider, route and stable component fingerprints.
- Compute longest common prefix **of locally captured serialized request tokens when tokenizer fidelity is known**, otherwise first differing byte/structured component; avoid false precision.
- Collect provider-reported usage with explicit unknown states.
- Classify `PREFIX_REWRITE`, `NORMAL_APPEND`, `PROVIDER_EXPIRY_OR_ROUTING`, `COMPACTION`, `MODEL_OR_TOOLSET_CHANGE`, `UNKNOWN`.
- Distinguish a rewrite from ordinary uncached growth by checking prefix fingerprints, not solely usage spikes.
- Expose a `/cache` report: last 20 calls, per-model hit ratio, cold/warm transitions, first divergent component, costs and confidence.
- Keep all logs local, encrypted or permission-restricted; default to hashes and token counts only.

### Phase 2 — `prefix-stabilizer` plugin

Start from an audited implementation of `dsh-cache-stabilizer`, or implement equivalent behavior in the local source. Test exact known persona relocation and nested schema key canonicalization. Add deterministic snapshots for instruction files and MCP discovery. Ensure no request semantics, authorization rules, tool parameter validation or safety policies change.

### Phase 3 — `cache-aware-context` integration

Introduce a compaction epoch identifier and immutable prefix version tracking. Emit a cache-reset event whenever a rewrite is intentional. Add opt-in deferred tool schema loading if existing harness infrastructure supports it. Compare completion quality and task success before rollout.

### Phase 4 — `adaptive-cache-retention` experiment

Implement only after Phase 1 establishes trustworthy usage telemetry. Support `off`, `observe`, `recommend`, `opt_in_active` modes. In active mode, keep-alive requests must use a verified provider route and demonstrate actual cache reuse. Persist measured savings and disable on negative ROI.

## 7. Proposed configuration (design schema, NOT current DSH syntax)

```yaml
cacheEfficiency:
  enabled: true
  observer:
    enabled: true
    storePromptText: false
    reportWindow: 20
    redactSecrets: true
  prefix:
    stabilizePersona: true
    canonicalizeToolSchemaKeys: true
    freezeToolsetPerSession: true
    relocateApprovedVolatileFields: true
  context:
    explicitCompactionEpoch: true
    preferAppendOnly: true
    deferredToolLoading: auto
  keepAlive:
    mode: off  # off | observe | recommend | opt_in_active
    requireProviderUsageMetrics: true
    requirePositiveMeasuredROI: true
    maxRequestsPerHour: 2
    disableOnRateLimit: true
    disableOnRouteChange: true
```

Do not paste this into `cordis.patch.yml` as-is: map the design to real plugin IDs, schemas and version-specific configuration after local inspection.

## 8. Test and measurement matrix

Use the same repository snapshot, model, toolset, agent instructions, task sequence and sampling parameters. Randomize baseline vs treatment order where possible. Compare **actual AI Credits**, provider cache-read/write usage, latency and coding task success; avoid evaluating cache ratio alone.

| Case | Change | Expected diagnosis | Pass condition |
| --- | --- | --- | --- |
| A | Same session, append user turn | Normal append | Reused prefix when provider cache is warm |
| B | Change cwd only | Potential early prefix rewrite | Stable early prefix without losing correct cwd |
| C | MCP tools enumerate in different order | Potential tool rewrite | Stable wire tool schema, unchanged tool behavior |
| D | Change nested JSON-schema key ordering | Serialization jitter | Stable effective serialized schema |
| E | Change `AGENTS.md` mid-session | Intentional rule update | New epoch, no stale rules hidden |
| F | Switch GPT ↔ Claude | New cache domain | No unsupported cross-provider reuse claim |
| G | Idle intervals: short/medium/long | Possible provider expiry | Actual usage-based decay curve |
| H | Explicit compaction | Prefix rewrite | Correct epoch and retained task quality |
| I | Large new tool output | Normal prompt growth | No false rewrite alert |
| J | Copilot response omits cache fields | Unknown metrics | No fabricated zero/hit or ROI |
| K | Copilot route returns alias for cache writes | Adapter normalization | Correct disjoint buckets or explicit unknown |
| L | Concurrent sessions | Routing/cache isolation | No cross-session secret exposure or false hits |

**Statistics:** report median, p90, p95 latency; per-call and aggregate hit ratio; AI Credits/task; 95% bootstrap confidence intervals where sample size supports them; task success and regression counts. Use repeated task suites rather than one demonstration. Record actual model and provider route with each sample.

## 9. Acceptance criteria

- **Telemetry:** all available provider usage buckets captured without double counting; absent data labeled unknown.
- **Correctness:** no instruction priority changes, stale cwd, stale repository rules, broken MCP schemas or altered authorization behavior.
- **Stability:** deterministic prompt signatures for logically identical turns; first divergence correctly identified in controlled fixtures.
- **Efficiency:** statistically supported reduction in AI Credits per successfully completed coding task, not merely increased hit ratio.
- **Keep-alive:** off by default; only enabled when same-route retention refresh and positive net ROI are demonstrated; auto-off on uncertainty.
- **Security:** no source text, tokens, credentials or sensitive tool results exported by the observer without explicit opt-in.
- **Maintenance:** tests pin the local DSH commit and plugin API version; CI fails on unexpected request-schema changes.

Suggested initial engineering targets (hypotheses, **not measured outcomes**): eliminate avoidable prefix rewrites in deterministic fixtures; improve cached-token ratio on repeat-turn tests; reduce AI Credits/task without reducing success rate. Set numeric thresholds after baseline collection.

## 10. Risks, countermeasures and rejected approaches

| Risk | Mitigation |
| --- | --- |
| Copilot gateway ignores provider cache-control options | Feature-detect; never assume direct API behavior |
| Keep-alive costs more than it saves | ROI gating; default off; per-model experiment |
| Cache fields mapped incorrectly | Preserve raw provider usage locally in redacted diagnostic fixtures; test aliases |
| Early system prompt modified unsafely | Allowlist relocation, semantic tests, rollback switch |
| Tool canonicalization alters schema semantics | Snapshot and behavioral regression tests |
| Compaction reduces task quality | Task success as hard guardrail |
| Cache route/provider eviction | Classify unknown expiry separately from local prefix rewrite |
| Telemetry leaks proprietary source | Hash-only diagnostics by default, strict local storage controls |
| Plugin incompatibility across DSH releases | Pin commit/version and test CI against exact checkout |

Reject: hidden background token-burning pings; forced provider cache TTL without supported API; cache-hit figures inferred from request similarity alone; treating DeepSeek API cache semantics as GitHub Copilot semantics; changing trust boundaries to stabilize prefixes; promising cross-model cache reuse.

## 11. Recommended implementation sequence and decision gates

1. **Baseline:** 30–100 real coding turns across selected GPT and Claude models, with provider usage fields and route recorded where available.
2. **Audit:** inspect installed GitHub Copilot plugin, DSH request assembler, adapter and token-meter; fix usage accounting first.
3. **Observer:** implement read-only diagnostics and classify misses.
4. **Normalizer:** test persona and schema stabilization behind flags.
5. **Context:** reduce unnecessary early-prefix mutations and compaction churn.
6. **A/B:** compare AI Credits per successful task and latency.
7. **Keep-alive trial:** only for idle-heavy workloads with verified same-route cache refresh and positive ROI.
8. **Rollout:** conservative defaults, feature flags, local logging, version-pinned tests.

## 12. Immediate practical recommendations

- Keep one model and a stable tool catalog during a long coding task.
- Avoid editing system instructions or AGENTS.md repeatedly during an active session.
- Prefer follow-up turns to unnecessary new sessions when the context remains relevant.
- Keep runtime environment changes and retrieved content late in the prompt without compromising semantics.
- Audit existing DSH cache plugins before installing them in an Enterprise environment; plugin claims and compatibility must be verified.
- Measure usage **through the actual Copilot Enterprise route**. Do not rely on direct Anthropic/OpenAI/DeepSeek examples as proof of Copilot behavior.
- Prefer passive cache stabilization over synthetic keep-alive traffic.

## 13. Open questions requiring local verification

1. Which exact GitHub Copilot provider plugin and revision is installed, and does it use an OpenAI-compatible endpoint, Copilot SDK or another transport?
2. Which selected GPT/Claude model IDs and endpoint routes expose cache-read/cache-write usage?
3. Does the route honor any explicit retention/cache key/cache-control parameters?
4. Does DSH already normalize tool ordering, persona interpolation and schema key ordering in this revision?
5. Is compaction automatic, configurable, and visible in session events?
6. Do session forks and subagents preserve an identical wire prefix or start distinct cache domains?
7. What are the Enterprise billing rates and policy restrictions for each tested model?
8. Is the external plugin's request hook before or after final provider serialization?

These questions must be resolved from the local checkout and real response traces before coding a production retention controller.

---

**Bottom line:** Build an evidence-based cache observer and stable-prefix layer first. Treat keep-alive as an optional, measured optimization—not the primary cache strategy. Provider cache state cannot be guaranteed or restored from a local harness alone.
