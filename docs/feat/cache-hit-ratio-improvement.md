# GitHub Copilot ルートのプロンプトキャッシュヒット率改善設計

| 項目 | 内容 |
|---|---|
| 状態 | 設計 (ローカルソース調査済み、未実装) |
| 対象 | ローカルビルド版 DSH + `@deepseek-ai/dsh-llm-pi-ai` の `github-copilot` ルート + GitHub Copilot Enterprise |
| 主対象モデル | `claude-opus-5.5` (現行プロファイル既定)。他の Claude / GPT 系も併記 |
| 入力資料 | [cache-hit/](cache-hit/) 配下の事前調査 6 件、ローカルソース、同梱 pi-ai 1.3.0 の `dist` |

## 0. 結論

### 0.1 ベースライン実測 (2026-11-08、F2 適用前)

[cache-report.mjs](cache-hit/cache-report.mjs) で `~/.dsh/sessions` の全セッションを集計した結果: 785 リクエスト、HitRatio 95.0%、cold 32 回、推定損失約 3,214 credits。cold の原因は `ttl-expired` 28 回 (直前リクエストとの間隔 5〜60 分が大半)、compaction 後 2 回、プレフィックス変化またはプロバイダ側 2 回。cold のほぼすべてが 5 分 TTL の失効であり、F2 (1h) と F4 (warmer) の対象である。F2 適用・再起動後に同じスクリプトを `--ttl-min 60` で実行して比較する。

### 0.2 方針

1. 事前調査が「要ローカル確認」としていた項目をソースで確定した (§2)。Copilot 経由の Claude は pi-ai の `anthropic-messages` で送られ、`cache_control` は system・最後のツール定義・最後の user/tool_result ブロックの 3 か所に自動付与されている。現状でも 5 分 TTL のキャッシュは機能している。
2. 現状でキャッシュを壊している、または活かし切れていない箇所はハーネス内に 4 つある。
   - **G1 compaction 要約が `reasoningEffort` を引き継がない** ([summarizer.ts:152-162](../../packages/compaction/compaction-basic/src/summarizer.ts#L152-L162))。Claude では thinking 設定が変わると messages 層のキャッシュが無効になるため、最も長いプレフィックスを持つ compaction リクエストが全額 write になる。
   - **G2 `cacheRetention` が未設定** ([cordis.patch.yml](<C:/Users/tokob/.dsh/profiles/desktop/cordis.patch.yml>) の `github-copilot: {}`)。pi-ai 既定の `short` (Anthropic 5 分) のまま。人間の思考・レビュー待ちで 5 分を超えると次ターンは cold になる。
   - **G3 リクエスト単位のキャッシュ観測が無い**。`cacheReadTokens` / `cacheWriteTokens` は usage に入る ([stream.ts:29-30](../../packages/llm/llm-pi-ai/src/stream.ts#L29-L30)) が、「なぜミスしたか」(TTL 失効か、プレフィックス変化か) を判定する仕組みが無い。
   - **G4 アイドル時の keepalive (warmer) が存在しない**。リポジトリ内に該当実装は無い。
3. 打ち手の優先順位は「G1 修正 → G2 設定 → G3 計測 → G4 warmer (損益分岐で自動制御)」。G1/G2 はコード 10 行・設定 1 行規模で即効性がある。G4 は Copilot の利用規約と課金に関わるため、G3 で TTL と CAPI の挙動を実測してから有効化する。
4. 事前調査で挙がった既知障害のうち、Web GUI ポート番号の混入 (K2) と同順位 section の並び替え (K1) は現行ソースで解消済みであり、追加対応は不要 (§2.5)。

## 1. 前提: 課金と cold のコスト

### 1.1 Copilot 経由モデルのキャッシュ単価 (同梱カタログ値)

同梱 pi-ai の `providers/data/github-copilot.json` から抜粋した per-1M-token 単価。DSH の usage 表示とコスト推定はこの値を使う。

| モデル | wire API | input | cache read | cache write | read/input | write/input |
|---|---|---|---|---|---|---|
| claude-opus-5.5 | anthropic-messages | 4 | 0.2 | 5 | 0.05 | 1.25 |
| claude-sonnet-5.5 | anthropic-messages | 2 | 0.1 | 2.5 | 0.05 | 1.25 |
| claude-opus-5 / 4.8 | anthropic-messages | 5 | 0.5 | 6.25 | 0.1 | 1.25 |
| gpt-5.5 | openai-responses | 5 | 0.5 | 0 | 0.1 | — |
| gpt-5.6-sol | openai-responses | 4 | 0.4 | 5 | 0.1 | 1.25 |
| gpt-6.1-sol | openai-responses | 2 | 0.1 | 2.5 | 0.05 | 1.25 |
| gemini / kimi 系 | openai-completions | — | 0.1 倍前後 | 0 | — | — |

カタログ値は 5 分 TTL の write 単価である。Anthropic の 1 時間 TTL write は input の 2.0 倍になる (Anthropic 公開仕様)。CAPI がこの差を AI Credits にそのまま反映するかは §5 の実験 E3 で確認する。

### 1.2 1 回の cold 化で失う額

プレフィックス長を P、input 単価を c、read 倍率を r、write 倍率を w とすると、cold 化 1 回の損失は (w − r)·c·P である。

- claude-opus-5.5、P = 150k tokens: (1.25 − 0.05) × $4 × 0.15 = **$0.72 (約 72 credits)**。
- 同条件で warm なら read は $0.03。cold は warm の 25 倍。
- 1 日 10 回 cold 化すると約 720 credits。Enterprise の月次プール (3,900 credits/user) に対して無視できない。

Anthropic は「プレフィックス変更」と「TTL 失効」の両方で cold になる。write 課金の無い GPT-5.5 以前は TTL 失効しても損失は (1 − r)·c·P で済み、warmer の価値は小さい。

## 2. 現状調査 (ローカルソース)

### 2.1 Copilot ルートのリクエスト経路

```text
agent-loop (request header: provider / model / reasoningEffort / tools / system)
  └ ctx.llm.stream(GenerateOptions)
      └ PiAiAdapter.stream()                packages/llm/llm-pi-ai/src/adapter.ts
          profileOptions(): cacheRetention / reasoning / transport …   (L140-157)
          streamSimple(model, context, { …, sessionId, maxTokens, headers })  (L460-467)
            └ pi-ai 1.3.0 provider "github-copilot"
                 claude-*      → api/anthropic-messages.js
                 gpt-*/grok/mai → api/openai-responses.js
                 gemini/kimi   → api/openai-completions.js
                   └ https://api.individual.githubcopilot.com (Enterprise はトークン由来の URL)
```

- 認証は `@lujianjun19/dsh-llm-github-copilot` が担う (プロファイル `package.json` に git 依存で導入済み)。キャッシュ制御には関与しないため改修対象外。
- `sessionId` は毎リクエスト pi-ai に渡る ([adapter.ts:464](../../packages/llm/llm-pi-ai/src/adapter.ts#L464))。pi-ai はこれを Anthropic のセッションヘッダ、Responses の `prompt_cache_key` に使う (`cacheRetention !== 'none'` のとき)。

### 2.2 Anthropic (Claude) のブレークポイント配置

`anthropic-messages.js` の `buildParams` と `convertMessages` を読んだ結果:

| # | 位置 | 根拠 (pi-ai dist 行) |
|---|---|---|
| BP1 | 最後のツール定義 | L1327 `index === tools.length - 1` |
| BP2 | system テキスト | L952 |
| BP3 | 最後の user / system / tool_result ブロック | L1218-1238 |

- 明示ブレークポイントは 3 個で、Anthropic の上限 4 を超えない。各ブレークポイントから最大 20 ブロック遡ってキャッシュを探索するため、1 ステップで 20 ブロックを超えて履歴が伸びない限り、直前リクエストの書き込みにヒットする。DSH の 1 ステップは通常「assistant (tool_use 複数) + user (tool_result 複数)」で 20 ブロック未満に収まる。並列ツール呼び出しが 10 件を超えるステップでは遡り範囲を超える可能性があり、§3.6 の補助ブレークポイントで対処する。
- `ttl` は `cacheRetention === 'long'` かつ `compat.supportsLongCacheRetention` (既定 true) のとき `"1h"` になる (L31-39)。
- Copilot の Claude 系カタログは `supportsMidConvoSystemMessages: true` だが、DSH の [catalog.ts:294-308](../../packages/llm/llm-pi-ai/src/catalog.ts#L294-L308) は `ANTHROPIC_COMPAT_GATE` で withhold している。runtime context の更新は履歴内リマインダーとして末尾に追記され (`systemPromptUpdate === 'in-history'`)、先頭 system を書き換えない。この挙動はプレフィックス保存に有利であり変更しない。

### 2.3 OpenAI Responses (GPT 系) の挙動

`openai-responses.js` L252-261:

- `prompt_cache_key` = `sessionId` (retention が `none` 以外なら常に送る)。セッション単位で同一キャッシュノードに寄せる効果がある。
- `cacheRetention: 'long'` のとき GPT-5.5 以前は `prompt_cache_retention: "24h"`、GPT-5.6 以降 (`supportsExplicitPromptCacheMode`) は `prompt_cache_options.ttl: "30m"`。
- DSH は `RESPONSES_COMPAT_GATE` で `supportsExplicitPromptCacheMode` を withhold している ([catalog.ts:288](../../packages/llm/llm-pi-ai/src/catalog.ts#L288))。そのため GPT-5.6 以降で `long` を指定すると `prompt_cache_retention: "24h"` 側が送られる。CAPI がこれを受理するかは未検証 (§5 E4)。

### 2.4 compaction 要約リクエスト

[summarizer.ts:120-181](../../packages/compaction/compaction-basic/src/summarizer.ts#L120-L181) の `summarizeWithLlm` は、会話プレフィックスとツール定義をそのまま再送し、末尾に指示文を 1 件追加する。プレフィックス再利用を意図した設計であり、方針は正しい。ただし `GenerateOptions` に次の差がある。

| フィールド | 通常ターン | compaction | Claude キャッシュへの影響 |
|---|---|---|---|
| `reasoningEffort` | request header の値 (例 `high`) | **未設定** → `profile.reasoning` (未設定) → thinking 無効化 | thinking 設定の変化は messages 層のキャッシュを無効化する。**ミスの主因** |
| `maxTokens` | header の値 / 既定 | `config.maxTokens` (例 8192) | `max_tokens` はキャッシュキーに含まれない。影響なし |
| `tools` | 現行ツール | 同一配列 | 一致 |
| `toolHistory` | 同一 | 同一 | 一致 |

Copilot の Claude 系は `forceAdaptiveThinking: true` で、`thinkingLevelMap.off` が `null` のモデルもある。effort が欠落すると pi-ai は thinking パラメータを省略または別値で送るため、tools と system の層はヒットしても messages 層 (P の大半) が write になる。compaction はコンテキスト上限付近で走るので、P は最大値に近い。claude-opus-5.5 で P = 800k なら 1 回の compaction で約 $3.8 の余計な write が発生する。

### 2.5 解消済みの既知障害

| 事前調査の ID | 内容 | 現行ソースの状態 |
|---|---|---|
| K1 | 同一 `order` の system section が再起動で入れ替わる | 同順位は名前順で決定的に整列。対応不要 |
| K2 | Web GUI URL のポート番号が system に入り resume 後にミス | [harness-dev-context](../../packages/context/harness-dev-context/src/index.ts#L156) は URL を runtime context (追記型) として出し、system section は値を含まない。テストがポート変更時のプロンプト安定性を検証済み |
| K3 | compaction がキャッシュを使わない | 本書 G1 として未解消 (`maxTokens` ではなく `reasoningEffort` 欠落が原因) |
| K5 | `prompt_cache_key` が送られない | Responses API では retention が `none` 以外なら送られる。completions API (gemini / kimi) では `long` 指定時のみ |

### 2.6 現行プロファイル設定

[cordis.patch.yml](<C:/Users/tokob/.dsh/profiles/desktop/cordis.patch.yml>) の該当部分:

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      github-copilot: {}
- id: agent-default-model
  config:
    provider: github-copilot
    model: claude-opus-5.5
```

`cacheRetention` も `compat.supportsLongCacheRetention` も未指定。`ui-settings-account` の `usage: detailed` と `developerTools: true` は有効で、client-ui-stats (`@deepseek-ai/dsh-experimental-client-ui-stats`) でステップ単位の cache read/write を確認できる。また MCP サーバー `shimai` が常時ツールを追加する。MCP ツール集合がセッション途中で変わると tools 層 (BP1) から全ミスになる。

## 3. 改善設計

### 3.1 全体構成

| ID | 種別 | 変更先 | 効果 | 規模 |
|---|---|---|---|---|
| F1 | コード修正 | `compaction-basic` summarizer | compaction の messages 層ヒット | 小 |
| F2 | 設定 | プロファイル `cordis.patch.yml` | アイドル 5〜60 分後のヒット | 設定 1 行 |
| F3 | コード追加 | `llm-pi-ai` の観測イベント + 新規プラグイン `cache-observer` | ミス原因の特定 | 中 |
| F4 | 新規プラグイン | `cache-warmer` | アイドル中の TTL 失効回避 | 中 |
| F5 | コード追加 | `llm-pi-ai` の route/model 単位 retention | モデル別の最適 TTL | 小 |
| F6 | 運用ガード | client UI / 警告 | モデル・ツール集合変更による全ミスの抑止 | 小〜中 |

すべて既存の拡張点に載せ、agent-loop は変更しない (AGENTS.md「Plugins, not loop changes」)。

### 3.2 F1: compaction の reasoning 継承

`summarizeWithLlm` で、要約先が直近 request header と同じ provider/model の場合に限り、header の `reasoningEffort` を引き継ぐ。別モデルで要約する設定 (`summarizationProvider` 指定) ではキャッシュ空間が別なので継承しない。

```ts
// packages/compaction/compaction-basic/src/summarizer.ts (変更案)
const inherited = latest !== undefined
  && latest.provider === target.provider
  && latest.model === target.model
  ? latest.reasoningEffort
  : undefined
const options: GenerateOptions = {
  provider: target.provider,
  model: target.model,
  messages,
  toolHistory: agent.session.toolHistory(),
  ...input.tools === undefined ? {} : { tools: [...input.tools] },
  ...inherited === undefined ? {} : { reasoningEffort: inherited },
  maxTokens: config.maxTokens,
  sessionId: agent.session.id,
  purpose: 'compaction',
  ...signal === undefined ? {} : { signal },
}
```

- `maxTokens` は残す。Anthropic・OpenAI とも出力上限はキャッシュキーに含まれず、要約長の上限として必要である。ただし Anthropic では `max_tokens` が thinking の予算上限にもなるため、effort 継承後に `max_tokens` が thinking に不足しないか、compaction の `maxTokens` 既定 (`headroomTokens` 由来) を確認する。不足する場合は要約失敗として表面化するので、テストで検出する。
- 要約リクエストと次の通常ターンは、置換後の履歴が異なるため共有しない。F1 が改善するのは要約リクエスト自体の input コスト。
- テスト: `compaction-basic.spec.ts` に「同一 model で header の `reasoningEffort` が要約リクエストに渡る」「別 model 指定時は渡らない」を追加。モデル可視の変化は無いが、要約リクエストの記録 (`SummaryResult` の envelope) に effort を含めるかを決める。含める場合は session event の型変更になるため persistence-type 確認手順に従う。
- 効果の確認: client-ui-stats で compaction ステップの cache read 比率が 0% 付近から 90% 以上になること。

### 3.3 F2: retention を long にする

コード変更なしで今日から実施できる。

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      github-copilot:
        cacheRetention: long
```

- Claude: `cache_control: { type: "ephemeral", ttl: "1h" }`。
- GPT 系 (Responses): `prompt_cache_retention: "24h"`。
- gemini / kimi (completions): `prompt_cache_key` と `prompt_cache_retention: "24h"` が送られる。ただし completions 側の `supportsLongCacheRetention` は URL から自動判定されるため、Copilot URL で false になる場合は送られない。

**1h が得かどうか (Claude)**: 1h write は 2.0 倍、5m write は 1.25 倍。各ターンで新規に書き込む量を Δ、セッション中の 5 分超アイドル回数を k、ターン数を N とすると、1h が有利な条件は 0.75·c·ΣΔ < k·(1.25 − 0.05)·c·P である。P = 120k、Δ = 4k、N = 40 なら左辺 120k·c、右辺は k = 1 で 144k·c。**対話中心のセッションで 5 分超の中断が 1 回でもあれば 1h が有利**。自律ループ (ツール連続実行で人間を待たない) だけなら 5m の方が安い。現行の利用形態 (Web GUI での対話・レビュー) では long を既定とする。

**リスク**: CAPI が `ttl` を拒否するとリクエストが 400 で失敗する。失敗時は `cacheRetention: short` に戻す。1h が実際に効いているかは §5 E2 で判定する。

### 3.4 F3: キャッシュ観測 (cache-observer)

**目的**: ミス 1 件ごとに原因を「TTL 失効」「プレフィックス変化 (どの層か)」「CAPI 側の追い出し」に分類する。

**観測点**: pi-ai の `streamSimple` オプションには、送信直前の wire payload を受け取る `onPayload` がある。`llm-pi-ai` はこれを使っていない。`PiAiAdapterOptions` に次のコールバックを追加し、`llm-pi-ai` プラグインがイベントとして発行する。

```ts
/** One provider request as sent, observed after pi-ai protocol conversion. */
interface PiAiRequestObservation {
  readonly provider: string
  readonly model: string
  readonly sessionId?: string
  readonly purpose?: string
  /** SHA-256 digests of the request's cache layers, in prefix order. */
  readonly layers: readonly { readonly name: string; readonly digest: string; readonly approxTokens: number }[]
  readonly sentAt: number
}
```

- payload 本体はイベントに載せない。`llm-pi-ai` 内で層ごとのダイジェストだけを計算する。層は `routing` (model・thinking・tool_choice・cache 設定) → `tools` → `system` → `messages[i]` の累積ダイジェスト。
- usage (`cacheReadTokens` / `cacheWriteTokens`) は既存 stream chunk から取る。
- 新イベントはモデル入力に影響しないため session log には書かない。`~/.dsh/cache-observer/<sessionId>.jsonl` に、ダイジェストと数値だけを書く (コード本文を残さない)。
- 判定: 直前リクエストとの共通プレフィックス推定トークンを E、実測 read を R とする。E が最小キャッシュ長 (Claude 1,024 tokens) を超え、R < 0.5·E のとき cold と判定し、原因を以下で決める。
  1. 最初に不一致となった層があれば `prefix-changed:<層名>`。
  2. 全層一致かつ前回送信から TTL 超過なら `ttl-expired`。
  3. 全層一致かつ TTL 内なら `provider-evicted` (CAPI のルーティングやキャッシュ追い出し)。
- 表示: client-ui-stats の既存ステップ表示に「cold 原因」と「推定損失 (credits)」を追加するか、`/cache` コマンドで直近 N 件の集計を出す。

### 3.5 F4: cache-warmer (cold 回避 keepalive)

**方式**: 直前の実リクエストの **wire payload をメモリに保持** し、TTL 失効の少し前に、`max_tokens` だけを最小にした同一 payload を再送する。新しいメッセージは追加しない。応答はセッションに記録せず、ツールも実行しない。

同一 payload を再送する理由: ダミーの user メッセージを追加すると、そのメッセージ自体が write になり、次の実リクエストとの共通プレフィックスもずれる。同一 payload なら全ブレークポイントが read になり、Anthropic では read で TTL が延長される。`max_tokens` はキャッシュキーに含まれない。

**DSH での実装位置**: payload は pi-ai 内部で生成されるため、warmer は `llm-pi-ai` の内部機能として実装し、新規の小プラグインは方針 (いつ・何回送るか) だけを持つ。`PiAiAdapter` に「直前 payload を同一オプションで再送する」内部操作を追加し、方針プラグインからサービス経由で呼ぶ。payload はプロセスメモリだけに保持し、永続化しない。

**送信回数の上限 (損益分岐)**: ping 1 回のコストは約 r·c·P、cold 1 回の損失は (w − r)·c·P。アイドル 1 回あたりの ping 数の上限は ⌊(w − r)/r⌋。

| 対象 | w | r | 上限 | ping 間隔 | 守れるアイドル長 |
|---|---|---|---|---|---|
| claude-opus-5.5, 5m | 1.25 | 0.05 | 24 | 約 4.5 分 | 約 1.8 時間 |
| claude-opus-5.5, 1h | 2.0 | 0.05 | 39 | 約 55 分 | 実用上は無制限 (上限で打ち切る) |
| claude-opus-5, 5m | 1.25 | 0.1 | 11 | 約 4.5 分 | 約 50 分 |
| gpt-5.6-sol 等, 24h/30m | 1.25 | 0.1 | 11 | TTL − 余裕 | 長い |
| gpt-5.5 以前 | 0 | — | 不要 | — | — |

実際にはアイドルがそのまま作業終了になることがある。セッションへ戻る確率を p(I) として、期待利得 p(I)·(w − r)·c·P − n·r·c·P が負になった時点で ping を止める。p(I) の初期値は 15 分以内 0.8、60 分以内 0.4 とし、F3 の記録から更新する。

**推奨の組み合わせ**: F2 で 1h TTL にすると、1 時間以内の中断は warmer 無しで守れる。warmer は「1 時間を少し超える中断」を 1〜2 回の ping で延長する用途に限定する。5m TTL のまま warmer で守るより、1h TTL + 少数の ping の方が送信回数が少なく、利用規約上の懸念も小さい。

**設定 (案)**: Config は cordis.yml から変更可能な検証付きフィールドとする (AGENTS.md「No hardcoded tunables」)。

```yaml
- id: cache-warmer
  name: "@local/dsh-cache-warmer"
  config:
    enabled: true
    providers: [github-copilot]
    minPrefixTokens: 30000
    marginMs: 60000
    maxPingsPerIdle: 2
    dailyCreditBudget: 50
    onlyWhileClientConnected: true
    excludePurposes: [compaction, subagent]
```

**安全条件**

1. 実ターンが始まったら保留中の ping を即座に中止する。中止できず返ってきた ping の usage は実ターンの統計に混ぜない。
2. compaction 完了、モデル・effort 変更、ツール集合変化、セッション切替の後は、次の実ターンまで ping しない (保持 payload が古いため)。
3. thinking に固定予算 (`budget_tokens`) を使うモデルは `max_tokens` を下げると要求が不正になる。Copilot の Claude 系は adaptive thinking (`forceAdaptiveThinking`) なので対象にできるが、E6 で `max_tokens` 最小値でのエラー有無を確認する。
4. `dailyCreditBudget` と `maxPingsPerIdle` を必須にし、Web/Desktop クライアントが接続していない間は送らない。
5. ping は課金対象の実リクエストである。組織の利用規約上 keepalive が許容されるか、Enterprise 管理者に事前確認する。

### 3.6 F5: モデル別 retention と補助ブレークポイント

- `cacheRetention` は現在ルート単位 (`PiAiProviderProfile`) だけで設定できる。`PiAiModelProfile` / `modelOverrides` に `cacheRetention` を追加し、`profileOptions()` でモデル値 → ルート値の順に解決する。用途: Claude Opus は `long`、自律ループ用の Sonnet は `short`。
- `supportsExplicitPromptCacheMode` (Responses) の withhold を見直す。GPT-5.6 以降で `prompt_cache_options.ttl: "30m"` を送れるようにする。CAPI の受理を E4 で確認してから `offer` に変える。
- 1 ステップで 20 ブロックを超える並列ツール結果が付く場合に備え、pi-ai の `onPayload` で「直前リクエストの BP3 位置」に 4 個目の `cache_control` を付ける案を評価する。pi-ai の dist を直接パッチすると更新時に壊れるため、`onPayload` 上で `llm-pi-ai` が行う。

### 3.7 F6: 運用ガード

| 操作 | キャッシュへの影響 | ガード |
|---|---|---|
| セッション途中のモデル切替 | キャッシュ空間が別になり全ミス | 切替時に「推定再書き込み credits」を表示 |
| MCP サーバーやツール提供プラグインの追加・削除 | tools 層から全ミス | F3 が `prefix-changed:tools` を検出したら原因プラグインを通知 |
| reasoning effort の変更 | Claude では messages 層が無効 | 切替 UI に警告 |
| AGENTS.md 編集 | DSH は差分を履歴に追記するため影響は末尾のみ | 対応不要 (確認のみ) |
| 小タスクごとの新規セッション | 初回は常に全額 write | 運用ルールで抑止 |

## 4. 運用ルール (コード変更なしで今日から)

1. F2 の `cacheRetention: long` を設定する。
2. セッション開始前にモデル・effort・MCP・プラグインを決め、途中で変えない。モデルを試すときは新しいセッションを作る。
3. 関連する作業は 1 セッションにまとめる。初回ターンは常に全額 write になる。
4. 手動 compaction は必要なときだけ実行する。F1 適用前は compaction 1 回ごとにコンテキスト全量が write になる。
5. 1 時間以上離れる場合、戻った最初のターンは cold になる前提で、作業区切りで離れる。
6. サブエージェントは別セッションとしてキャッシュを別に持つ。小さな作業は親セッションで行う。
7. client-ui-stats のキャッシュ列を見て、cache write が大きいステップの直前に何をしたかを確認する習慣をつける。

## 5. 検証計画

### 5.1 ベースライン

代表タスク 3 種 (バグ修正、TypeScript 機能追加、文書作成) を claude-opus-5.5 で各 3 回実行し、client-ui-stats と Enterprise の Usage 画面から HitRatio = read ÷ (read + write + uncached input) と credits を取る。

### 5.2 CAPI 挙動の実験

| ID | 手順 | 判定 |
|---|---|---|
| E1 | `short` で同一セッションに 4 / 6 / 10 分間隔で 1 ターン送る | 6 分でミスなら 5m TTL が有効 |
| E2 | `long` で 10 / 30 / 55 / 65 分間隔 | 55 分でヒット、65 分でミスなら 1h TTL が CAPI を通過 |
| E3 | E1 / E2 の初回 write の credits を比較 | 1.25 倍と 2.0 倍の差が課金に出るか |
| E4 | gpt-5.5 / gpt-5.6-sol で `long` 指定、1h / 6h 後 | `prompt_cache_retention` の受理と効果 |
| E5 | 同一アカウントで 2 セッションを交互に実行 | 並行セッション間の追い出しの有無 |
| E6 | F4 の ping (`max_tokens` 最小) を 4.5 分間隔で 20 分 | 20 分後の実ターンがヒットするか、エラーが出ないか |
| E7 | F1 の前後で `/compact` | compaction リクエストの read 比率 |

### 5.3 目標値

| 指標 | 目標 |
|---|---|
| HitRatio (連続ツールステップ) | 95% 以上 |
| HitRatio (セッション全体、人間のアイドル込み) | 85% 以上 |
| compaction リクエストの read 比率 | 90% 以上 |
| credits / タスク | ベースライン比 30% 減 |

## 6. 実装順序

| 段階 | 内容 | 前提 |
|---|---|---|
| 0 | F2 設定、運用ルール、ベースライン計測 | なし |
| 1 | F1 compaction の effort 継承 (テスト・README 更新込み) | なし |
| 2 | F3 観測 (`onPayload` ダイジェスト + usage 突合 + 表示) | なし |
| 3 | E1〜E5 で CAPI の TTL・retention を確定し、F5 を実装 | F3 |
| 4 | F4 warmer (既定は無効、`maxPingsPerIdle` 小、予算必須) と E6 | F3、管理者確認 |
| 5 | F6 ガードと補助ブレークポイント評価 | F3 の原因統計 |

各段階でリポジトリ規約に従い、package README の Model Experience 節 (トークン・KV キャッシュへの影響) を更新し、`pnpm run test` の該当 spec と `build:check` を実行する。F3 と F4 は Product-visible プラグインとなるため、Loader 経由の REAL-composition テストを追加する。

## 7. 外部の参考実装と情報源

- pi-warm-cache (pi 用 keepalive 拡張、同一 payload 再送方式): <https://pi.dev/packages/pi-warm-cache>
- pi issue #11101 (warmer と実リクエストで retention 値の参照元がずれる問題。F4 は retention を `llm-pi-ai` の解決済みプロファイルから読むことで回避する): <https://github.com/earendil-works/pi/issues/11101>
- Anthropic prompt caching (ブレークポイント、20 ブロック遡り、1h TTL 単価): <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
- OpenAI prompt caching (`prompt_cache_key`、`prompt_cache_retention`): <https://developers.openai.com/api/docs/guides/prompt-caching>
- GitHub Copilot 従量課金とモデル単価: <https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing>
- VS Code Copilot のトークン効率改善 (アンカー配置、ツール遅延ロード): <https://code.visualstudio.com/blogs/2026/06/17/improving-token-efficiency-in-github-copilot>
- 事前調査資料: [cache-hit/](cache-hit/) 配下 (特に [cache-hit-ratio-improvement(6).md](<cache-hit/cache-hit-ratio-improvement(6).md>) の課金式とリスク表を本書に統合した)
