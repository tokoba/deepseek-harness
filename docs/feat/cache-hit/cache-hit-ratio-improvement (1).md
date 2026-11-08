# GitHub Copilot × DeepSeek Harness キャッシュヒット率改善設計

- **配置先**: `docs/feat/cache-hit-ratio-improvement.md`
- **対象**: DeepSeek Harness ローカルビルド版 + GitHub Copilot Enterprise
- **ステータス**: Proposed
- **作成日**: 2026-11-08
- **主対象モデル**: GitHub Copilot 経由の OpenAI 系 / Anthropic Claude 系モデル

## 1. エグゼクティブサマリー

本設計の結論は、**「定期 ping で無条件に warm を維持する」よりも、送信プレフィックスの決定性を上げ、モデル別のキャッシュ機構を正しく利用し、cold start を検出して必要な場合だけ再温存する**方が安全かつ効果的、というものである。

最優先の実装は次の 5 点である。

1. **Prompt Canonicalizer**: system prompt、tools、JSON、MCP tool schema の順序と表現を決定的にする。
2. **Stable Prefix Builder**: 静的情報を先頭、動的情報を後方へ移し、同一セッション内の共通プレフィックスを最大化する。
3. **Provider-aware Cache Policy**: OpenAI 系と Anthropic 系を分離し、対応するパラメータだけを送信する。
4. **Cache Telemetry / First-divergence 診断**: cache read / write / miss tokens と最初の差分位置を記録する。
5. **Selective Warm Keeper**: 予測される再利用価値が再温存コストを上回るセッションだけを対象にする。既定では無効にする。

DeepSeek Harness は Cordis ベースの「everything-is-a-plugin」構成で、モデルアダプター、system prompt、tool registry、agent loop を設定から交換できる。このため、コアへ散発的なパッチを入れるより、**LLM request の直前に canonicalize / fingerprint / policy injection を行うプラグイン**と、レスポンス usage を集計するプラグインに分割するのが適切である。

> 重要: GitHub Copilot の非公開・非保証エンドポイントを使うアダプターでは、`cache_control` や `prompt_cache_retention` が実際にバックエンドへ透過される保証はない。まず telemetry により実効性を確認し、未対応フィールドは送らないこと。

## 2. 目的と非目的

### 2.1 目的

- 同一エージェントセッションの 2 ターン目以降で、再利用可能な prompt prefix を最大化する。
- system prompt / tool schema の微小な非決定性による全体 miss を排除する。
- cold / warm を推定し、再温存が経済的な場合にだけ実施する。
- GitHub Copilot Enterprise のモデル差を吸収し、モデル変更時のキャッシュ汚染を防ぐ。
- 改善を hit ratio だけでなく、総入力 token、TTFT、task success、premium request / quota 影響で評価する。

### 2.2 非目的

- 必要な安全指示、権限、tool schema、repository context をキャッシュ目的だけで削除しない。
- 異なるユーザー、リポジトリ、モデル、組織ポリシー間でキャッシュキーを共有しない。
- GitHub Copilot の契約上保証されない内部 API の挙動を前提にしない。
- heartbeat により常時リクエストを発行することを既定動作にしない。

## 3. 調査結果

### 3.1 DeepSeek Harness の変更ポイント

DeepSeek Harness は Cordis の plugin tree と profiles / bundles で構成され、model adapter、tool registry、session log、agent loop 自体が置換可能である。`@deepseek-ai/dsh-system-prompt` は各モデルステップで system prompt と tool schemas を組み立て、section は `order`、同順位では名前順で連結される。これは安定化層を実装するうえで有利である。

主な接続点:

- `packages/core/system-prompt`: prompt section、runtime context、tool order の決定
- `packages/llm`: provider-neutral message / content block / StreamChunk 語彙
- Copilot adapter: OpenAI-compatible request への変換、SSE、usage の取り込み
- token meter / session log: 実測値と再現用 fingerprint の永続化

### 3.2 Prompt cache の一般則

キャッシュ対象は、通常 **tools → system → messages** の順に評価される prompt prefix である。先頭に近い差分ほど、その後方の再利用可能部分を大きく失う。したがって「内容が同じ」では不十分で、送信される構造、配列順、文字列、JSON schema、空白を安定させる必要がある。

VS Code チームの公開測定では、cached input は uncached input より最大約 10 倍安価で、Anthropic 系では stable boundary に最大 4 個の breakpoint を置き、直近 2 つの cacheable message を rolling anchors とすることで agent workload の hit rate が約 94% に達した。tool search も、未使用 tool schema を prefix 外に遅延ロードすることで、セッション単位の token 利用を大きく削減している。

### 3.3 GitHub Copilot / provider ごとの差

#### OpenAI 系

- provider が自動 prefix caching を行う場合、完全に同一の先頭部分が主要条件となる。
- 対応モデル / 経路では `prompt_cache_retention: "24h"` が利用できるが、Copilot adapter が任意フィールドを透過するとは限らない。
- Responses API の WebSocket continuation は、連続 tool loop のレイテンシ低下と connection-local state 再利用が期待できるが、Copilot endpoint と adapter の対応確認が必要。
- `prompt_cache_key` 相当を使える場合、`tenant/repo/model/session` を含む安定キーを使う。ただし高カーディナリティ化と hotspot を避ける。

#### Anthropic 系

- 明示的 `cache_control` が使える直結 API では、5 分 TTL が既定で、hit のたびに更新される。1 時間 TTL は高い write cost と引き換えに長い中断へ対応する。
- tools、system の末尾と、直近 2 個の cacheable message に breakpoint を置く方式が有効。
- GitHub Copilot 経由では、Copilot 側が breakpoint を管理する可能性があり、Harness から直接 `cache_control` を送っても有効とは限らない。

### 3.4 Copilot / agent harness で起きやすい miss

公開事例では、主因は以下である。

1. tool array がターン途中で変化する。
2. system message がターンごとに再組み立てされる。
3. timestamp、cwd の一時値、terminal state、trace ID、ランダム ID が上流へ入る。
4. MCP server の接続 / 切断により tool schema が増減する。
5. JSON object の key order、schema の `required`、`enum`、description の整形が揺れる。
6. context compaction / summary が過去の message prefix を置換する。
7. reasoning effort、model ID、API route をセッション途中で変える。
8. retry 時に system / tools を再生成し、元リクエストと異なる。

## 4. 提案アーキテクチャ

### 4.1 コンポーネント

```text
Agent Loop
  -> System Prompt Assembly
  -> Tool Registry Snapshot
  -> Cache Optimizer Plugin
       1. classify stable / session / volatile
       2. canonicalize
       3. build prefix fingerprint
       4. apply provider policy
       5. emit request diagnostics
  -> Copilot LLM Adapter
  -> GitHub Copilot endpoint
  <- usage / timings / response
  <- Cache Telemetry Plugin
  -> Session cache ledger + metrics
```

推奨パッケージ構成:

```text
packages/llm-cache-optimizer/
  src/
    canonicalize.ts
    fingerprint.ts
    policy.ts
    request-middleware.ts
    telemetry.ts
    warm-keeper.ts
    types.ts
  tests/
    canonicalize.test.ts
    prefix-stability.test.ts
    provider-policy.test.ts
    warm-keeper.test.ts
  package.json
  README.md
```

Copilot adapter 自体への変更は、provider-specific fields の許可リスト、usage parsing、transport capability reporting に限定する。汎用の安定化ロジックは adapter の外側に置く。

### 4.2 Stable Prefix のレイヤー

送信順を以下に固定する。

1. **L0 Global immutable**
   - Harness identity
   - 安全・権限制約
   - tool-calling protocol
2. **L1 Profile immutable**
   - persona
   - coding conventions
   - organization policy
3. **L2 Repository stable**
   - repository instructions
   - build / test commands
   - architecture summary
4. **L3 Tool catalog stable core**
   - file read / edit
   - search
   - terminal
   - minimum MCP router
5. **L4 Session stable**
   - task goal
   - selected workspace roots
   - chosen model / reasoning effort
6. **L5 Conversation append-only**
   - user / assistant / tool history
7. **L6 Volatile tail**
   - current time
   - trace ID
   - live terminal state
   - one-turn hints

L0-L4 は同じセッション中に変更しない。L6 は system prompt の先頭へ入れず、必要なら直近 user message の末尾に structured metadata として追加する。

### 4.3 Canonicalization

#### tools

- tool は正規化後の `name` 昇順で固定する。
- JSON schema object key は再帰的に辞書順へ正規化する。
- `required` と純粋な集合として扱える `enum` は、意味を変えない場合だけソートする。
- description の末尾空白、CRLF / LF、連続空行を正規化する。
- `undefined`、既定値と等価な optional field、実行時だけの metadata を schema から除外する。
- 同名 tool の schema hash が変わったら、黙って差し替えず `tool_catalog_epoch` を増やす。

#### system prompt

- section order は `(order, name)` で固定する。
- 改行は LF、末尾改行は 1 個へ統一する。
- timestamp、session UUID、PID、temporary path を stable section へ混ぜない。
- runtime context は固定項目と volatile 項目に分割する。
- repository summary は毎ターン再生成せず、Git commit / worktree state に紐づけて更新する。

#### messages

- 過去 message は immutable とし、編集ではなく append-only にする。
- tool result の JSON は canonical JSON へ変換する。ただし生ログや source fidelity が必要な結果は raw content hash と別 payload に分ける。
- reasoning replay を必要とするモデルでは、provider が要求する replay field を欠落させない。
- compaction は閾値到達時だけ行い、頻繁な再要約を避ける。

### 4.4 Fingerprint

秘匿情報を保存せず、各層の SHA-256 を記録する。

```ts
interface PromptFingerprint {
  version: 1
  provider: string
  model: string
  route: 'chat-completions' | 'responses' | 'messages'
  globalHash: string
  profileHash: string
  repoHash: string
  toolsHash: string
  sessionHash: string
  historyPrefixHash: string
  canonicalTokenEstimate: number
}
```

最終キー例:

```text
sha256(org_id | provider | model | route | globalHash | profileHash |
       repoHash | toolsHash | sessionHash)
```

`reasoning_effort`、vision mode、tool choice により request semantics が変わる場合はキーへ含める。GitHub OAuth token、ユーザー名、raw source code は含めない。

### 4.5 First-divergence 診断

前回 request と今回 request を component 単位で比較し、最初に異なる層を記録する。

```json
{
  "event": "prompt_cache_divergence",
  "session": "hashed-session-id",
  "turn": 18,
  "provider": "copilot-oauth",
  "model": "model-id",
  "firstDivergence": "tools",
  "previousHash": "...",
  "currentHash": "...",
  "changedTools": ["mcp.foo.search"],
  "expected": false
}
```

raw prompt をログへ保存しない。debug mode でも差分の先頭 / 末尾 64 文字などを既定で記録せず、hash、byte length、token estimate、component name のみとする。

## 5. Provider-aware policy

### 5.1 Capability negotiation

adapter は model discovery と別に、次の capability を公開する。

```ts
interface PromptCacheCapabilities {
  reportsUsage: boolean
  supportsExplicitBreakpoints: boolean
  supportsAutomaticCacheControl: boolean
  supportsExtendedRetention: boolean
  supportsPromptCacheKey: boolean
  supportsResponsesWebSocket: boolean
  maxExplicitBreakpoints?: number
  defaultTtlSeconds?: number
}
```

不明な capability は `false` とする。未確認フィールドを本番 request へ追加しない。

### 5.2 OpenAI 系ポリシー

優先順:

1. canonical prefix を保証する。
2. 対応が確認できる場合だけ `prompt_cache_retention: "24h"` を付与する。
3. 対応が確認できる場合だけ安定した `prompt_cache_key` を付与する。
4. Responses API + WebSocket が Copilot route で動作する場合、agent loop 内の連続 step に使う。
5. 同一セッション中の model / route / reasoning effort を固定する。

24h retention は heartbeat より優先する。長時間保持が provider 側で利用できるなら、追加 request を発生させず warm を維持できるためである。

### 5.3 Anthropic 系ポリシー

Copilot が breakpoint を受け付けることを実験で確認した場合のみ、次を利用する。

- breakpoint 1: tools の末尾
- breakpoint 2: system の末尾
- breakpoint 3: 直近から 2 番目の cacheable message
- breakpoint 4: 直近の cacheable message

古い rolling anchor は、最新 anchor が TTL 切れや軽微な drift で miss したときの退避点となる。

5 分 TTL の場合、request 開始時刻から TTL が進む点に注意する。長い生成や tool 実行後は、ユーザーの操作間隔が短くても cache が切れる可能性がある。

### 5.4 未確認の Copilot 経路

GitHub Copilot 用の公開 / 非公式 adapter は、OAuth token を短期 Copilot session token へ交換し、OpenAI-compatible endpoint を呼ぶ構成が見られる。しかし、これは prompt caching の制御面を保証しない。したがって次の canary を実施する。

1. 10k token 以上の固定 prefix を持つ 2 ターンを 20 回実行する。
2. 2 ターン目の usage に cache read tokens が現れるか確認する。
3. 同じ試験を 1、6、15、45 分の間隔で実行する。
4. retention field なし / ありを A/B 比較する。
5. field 追加で 400、無視、usage 変化なしの場合は capability を false にする。

## 6. Warm Keeper 設計

### 6.1 原則

**blind heartbeat は採用しない。** 理由は次のとおり。

- GitHub Copilot Enterprise の quota / premium request / token accounting を消費する可能性がある。
- endpoint が cache-control を公開していない場合、warm 維持を保証できない。
- 生成を伴う ping は output token と agent loop 副作用を生む。
- 多数セッションを温存すると、再温存コストが miss の期待損失を上回る。

### 6.2 再温存判定

セッション `s` の warm 維持は、以下を満たす場合だけ候補とする。

```text
expected_miss_cost(s)
  = P(resume within horizon) × reusable_prefix_tokens × uncached_unit_cost

expected_keepalive_cost(s)
  = number_of_keepalives × keepalive_input_tokens × effective_unit_cost

実行条件:
expected_miss_cost > expected_keepalive_cost × safety_factor
```

`safety_factor` は既定 2.0 とする。Copilot 経由で実単価を取得できない場合は、cost ではなく token-equivalent / quota-equivalent で比較する。

### 6.3 セッション状態

```ts
type CacheTemperature = 'unknown' | 'warm' | 'cooling' | 'cold'

interface CacheLedgerEntry {
  fingerprint: PromptFingerprint
  lastRequestStartedAt: number
  lastConfirmedHitAt?: number
  lastCacheReadTokens?: number
  lastCacheWriteTokens?: number
  reusablePrefixTokens: number
  temperature: CacheTemperature
  confidence: number
  nextEligibleWarmAt?: number
  warmAttempts: number
}
```

状態遷移:

- `unknown -> warm`: 明示的 cache read を確認
- `unknown -> cooling`: 2 ターン目の TTFT / usage が改善したが usage field はない
- `warm -> cooling`: model-specific TTL の 70% 経過
- `cooling -> cold`: TTL 超過、fingerprint 変更、model / route 変更
- `cold -> warm`: 実ユーザー request で cache write 後、続く request の hit を確認

usage がない場合、`warm` と断定せず confidence を最大 0.6 に制限する。

### 6.4 Warm request

provider が zero-output / cache-write-only request を正式にサポートし、Copilot 経路で検証できる場合のみ利用する。サポートが不明な `max_tokens: 0` を前提にしない。

安全な優先順位:

1. extended retention を使う。
2. 通常の agent loop 内で自然に hit を更新する。
3. 予定された継続作業の直前に prewarm する。
4. 最後の手段として低頻度 heartbeat を使う。

heartbeat を有効化する場合:

- 同時 warm session 上限: 3
- 1 セッションの最大 warm 回数: 2 / 時
- idle 30 分超は停止
- バッテリー動作 / metered network / VPN 不安定時は停止
- tool execution は禁止
- temperature 0、output 上限最小、固定 prompt
- model と prefix fingerprint を既存セッションと完全一致させる
- 429 / 401 / 403 / 400 で即停止し、自動 retry しない

## 7. Tool Search / MCP 最適化

キャッシュ改善で最も大きい対象の一つは tool definitions である。

### 7.1 Core tools と deferred tools

常時ロードする core tools:

- file read
- exact / regex search
- file edit / patch
- terminal execution
- tool search router

遅延ロード候補:

- ブラウザ、Office、画像、外部 SaaS
- 使用頻度の低い MCP tools
- 大きな JSON schema を持つ domain-specific tools

モデル / Copilot route が native tool search をサポートしない場合、Harness 側にローカル tool router を置く。router の schema は小さく固定し、検索結果として返す tool references は message 後方へ追加する。発見済み tool set はセッション中は縮小せず append-only とし、順序を固定する。

### 7.2 MCP snapshot

セッション開始時に接続済み MCP server と tool schema を snapshot する。途中の hot plug は次のいずれかにする。

- 新規セッションへ切り替える。
- `tool_catalog_epoch` を更新し、意図的な cache break として UI / log に表示する。

接続順に依存した tools 配列を生成しない。

## 8. Context compaction

compaction は cache を破壊するが、context overflow 回避には必要である。

提案:

- token 使用率 70% 未満では compaction しない。
- 70-80% で次回 compaction を予告し、古い tool outputs を artifact reference 化する。
- 80-85% で 1 回だけ deterministic summary を生成する。
- summary prompt、モデル、temperature、format を固定する。
- summary 出力は canonical section とし、以降は編集せず append-only にする。
- compaction 前後を別 `context_epoch` として計測し、miss を異常扱いしない。

短い会話を頻繁に要約する設定は cache hit 率を下げる可能性がある。一方、compaction を完全無効化すると context overflow と品質低下を招くため、hit ratio だけで判断しない。

## 9. Telemetry と SLO

### 9.1 指標

- `cache_read_tokens`
- `cache_write_tokens`
- `cache_miss_tokens` または `input_tokens - cache_read_tokens`
- `cache_hit_ratio = read / (read + write + miss)`
- `stable_prefix_tokens / total_input_tokens`
- TTFT p50 / p95
- turn duration p50 / p95
- input / output tokens per completed task
- task success rate
- retry rate
- tool schema tokens
- first-divergence category
- cold-start count / session
- warm request count と warm request token

### 9.2 受け入れ基準

代表的な 10k token 以上の repository task で:

- 2 ターン目以降の median cache hit ratio: **85% 以上**
- Anthropic 系の連続 agent workload: **90% 以上を目標**
- 意図しない system / tools divergence: **1% 未満**
- median prompt tokens / turn: baseline 比 **10% 以上削減**
- task success: baseline から **2 percentage points を超えて悪化しない**
- keepalive token: 全 input token の **1% 未満**
- secret / raw prompt の telemetry 保存: **0 件**

provider が cache usage を返さない場合は hit ratio SLO を適用せず、stable-prefix ratio、TTFT、input token、first divergence を代理指標とする。

## 10. 実装フェーズ

### Phase 0: Baseline instrumentation

- Copilot adapter の raw usage mapping を確認する。
- provider response の cache fields を `TokenUsage` へ損失なく保持する。
- request component hash と first-divergence log を追加する。
- 既存挙動を変更せず 1 週間計測する。

完了条件: model 別、session 別に hit / miss が可視化できる、または「provider 非公開」と判定できる。

### Phase 1: Deterministic prefix

- canonical JSON serializer
- tool order 固定
- system section の stable / volatile 分離
- retry 時 request snapshot 再利用
- fingerprint test vectors

完了条件: 同一 fixture を 1,000 回組み立て、byte hash が 100% 一致する。

### Phase 2: Tool deferral

- core tool set
- local tool search
- MCP snapshot / epoch
- discovered tools append-only

完了条件: task success を維持し、tool schema tokens を 30% 以上削減する。

### Phase 3: Provider policy

- capability negotiation
- OpenAI retention / key canary
- Anthropic breakpoint canary
- unsupported field allowlist

完了条件: capability ごとの integration test と、400 / silent-ignore の fallback がある。

### Phase 4: Selective Warm Keeper

- resume probability のローカル推定
- safety factor 付き cost gate
- rate limit / quota guard
- UI opt-in と停止スイッチ

完了条件: keepalive token が全 input の 1% 未満で、cold start 減少が統計的に確認できる。効果がなければ機能を削除する。

## 11. テスト計画

### 11.1 Unit tests

- object key 順序が異なる schema の hash が一致する。
- tool 登録順が異なっても request bytes が一致する。
- timestamp だけが変化しても L0-L5 hash が一致する。
- semantic schema change では toolsHash が変化する。
- model / reasoning effort / route 変更で final key が変化する。
- secret が log payload に含まれない。

### 11.2 Replay tests

Harness の LLM replay fixture を利用し、同一 session JSONL から request fingerprint が再現できることを検証する。

シナリオ:

1. 通常 5 ターン
2. tool call 10 step
3. MCP 接続変更
4. retry after 429
5. context compaction
6. process restart / session resume
7. model switch
8. reasoning effort switch

### 11.3 Live canary matrix

| Model family | Gap | Prefix | Tool set | Expected |
|---|---:|---:|---|---|
| OpenAI via Copilot | 1 min | 10k | fixed | 2nd turn hit または TTFT 改善 |
| OpenAI via Copilot | 15 min | 10k | fixed | retention 有無を比較 |
| OpenAI via Copilot | 45 min | 10k | fixed | extended retention 検証 |
| Claude via Copilot | 1 min | 10k | fixed | high hit |
| Claude via Copilot | 6 min | 10k | fixed | TTL / Copilot 管理挙動を確認 |
| Any | 1 min | 10k | one tool changed | divergence=tools |
| Any | 1 min | 10k | fixed | system timestamp injection で意図的 miss |

各 cell は最低 20 session、同じ repository fixture で比較する。

## 12. 設定案

```yaml
- id: llm-cache-optimizer
  name: '@local/dsh-llm-cache-optimizer'
  config:
    enabled: true
    canonicalization:
      normalizeNewlines: true
      sortToolsByName: true
      canonicalizeJsonSchema: true
      moveVolatileContextToTail: true
    diagnostics:
      fingerprint: true
      firstDivergence: true
      persistRawPrompt: false
    providerPolicy:
      capabilityDiscovery: true
      rejectUnknownCacheFields: true
      openai:
        extendedRetention: auto
        promptCacheKey: auto
        websocket: auto
      anthropic:
        automaticCaching: auto
        rollingAnchors: 2
    warmKeeper:
      enabled: false
      maxSessions: 3
      maxPerSessionPerHour: 2
      idleStopMinutes: 30
      safetyFactor: 2.0
```

`auto` は provider capability の確認が取れた場合のみ有効化する意味とする。

## 13. リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| Copilot が cache field を無視 | 効果なし | canary と capability=false fallback |
| tool 固定で機能が古くなる | 誤動作 | epoch を明示し、新セッションへ誘導 |
| canonicalize が schema semantics を変更 | tool call failure | sort 対象を allowlist、golden tests |
| heartbeat が quota を消費 | コスト増 | opt-in、1% budget、safety factor、即停止 |
| raw prompt telemetry 漏えい | セキュリティ事故 | hash only、redaction、保存期間制限 |
| compaction 抑制で context overflow | 品質低下 | 70/80% staged policy |
| 非公式 Copilot adapter の仕様変更 | 接続不可 | adapter を隔離、401/403 で停止、公式経路優先 |
| model switch で誤った再利用 | 品質不整合 | model / route / effort を key に含める |

## 14. 採用判断

### 採用する

- stable-first prompt 構造
- deterministic serialization
- tool catalog snapshot と tool search
- first-divergence diagnostics
- provider capability negotiation
- usage で確認できる場合の extended retention / breakpoints

### 条件付き採用

- Responses WebSocket
- explicit `cache_control`
- `prompt_cache_key`
- scheduled prewarm

### 当面採用しない

- すべての active session に 4-5 分間隔で ping
- raw prompt 全文の永続ログ
- tool / security instruction を削って hit ratio を上げる最適化
- 非公開 Copilot API の特定挙動を固定前提とする実装

## 15. 実装開始時の具体的な変更候補

1. `packages/core/system-prompt/src/index.ts`
   - section classification (`stable | session | volatile`) を追加するか、外側 plugin が assembly 後に分類できる typed metadata を追加する。
   - 現在の `(order, name)` 決定性を golden test で固定する。
2. `packages/llm`
   - `TokenUsage` に provider cache usage の損失なしフィールドを追加する。
   - request fingerprint 型を provider-neutral な metadata として定義する。
3. Copilot adapter
   - model capability と route capability を公開する。
   - cache-related request fields は capability allowlist を通す。
   - usage の `cached_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens` 相当を正規化する。
4. Agent loop
   - retry では request を再 assemble せず、同一 attempt snapshot を再利用する。
5. Session log / token meter
   - raw prompt ではなく component hash、token counts、temperature を保存する。
6. 新規 plugin
   - canonicalize、fingerprint、divergence、policy、warm keeper を集約する。

## 16. 参考資料

### 一次資料・公式資料

- [DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness)
- [DeepSeek Harness architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [DeepSeek Harness development guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/development.md)
- [DeepSeek Harness system prompt package](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/system-prompt/README.md)
- [DeepSeek Harness LLM package](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/README.md)
- [VS Code: Improving token efficiency for GitHub Copilot](https://code.visualstudio.com/blogs/2026/06/17/improving-token-efficiency-in-github-copilot)
- [VS Code Cache Explorer documentation](https://github.com/microsoft/vscode-docs/blob/main/docs/agents/agent-troubleshooting/cache-explorer.md)
- [Anthropic Prompt Caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

### 実装・コミュニティ調査

- [dsh-llm-copilot](https://github.com/ericleoo/dsh-llm-copilot)
- [dsh-copilot](https://github.com/nathan5580/dsh-copilot)
- [DeepSeek Harness Cache Reducer Plugin](https://github.com/theworld-lab/deep-seek-cache-plugin)
- [Copilot Chat と prefix caching の論点](https://github.com/Vizards/deepseek-v4-for-copilot/issues/56)
- [長文セッションの cache miss 診断 issue](https://github.com/Vizards/deepseek-v4-for-copilot/issues/25)

## 17. 最終推奨作戦

最短で効果を出す順序は次のとおりである。

1. **まず 1 週間 instrumentation のみを導入する。**
2. **system / tools の byte-level 決定性を 100% にする。**
3. **MCP tool catalog を snapshot し、core + deferred に分割する。**
4. **モデル別に retention / breakpoint の透過可否を canary で判定する。**
5. **context compaction を epoch 化する。**
6. **それでも human pause 後の cold start が支配的な場合だけ Warm Keeper を opt-in で試す。**

この順序なら、GitHub Copilot 側の非公開仕様へ依存する前に、Harness が制御できる最大の miss 要因を除去できる。特にローカルソースを改良可能という条件では、heartbeat plugin 単体よりも、**request canonicalization + telemetry + provider capability negotiation** の 3 点セットが長期的に最も保守しやすい。
