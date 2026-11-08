# feat: Cache Hit Ratio Improvement — GitHub Copilot route on DeepSeek Harness

| 項目 | 内容 |
|---|---|
| Status | Draft (設計調査フェーズ) |
| Target | DeepSeek Harness (DSH) ローカルビルド版 `0.2.x` 系 + GitHub Copilot Enterprise |
| Scope | `@deepseek-ai/dsh-llm-pi-ai` の `github-copilot` ルート経由で呼び出す Claude / GPT 系モデルのプロンプトキャッシュ |
| Non-goals | DeepSeek 公式 API (`llm-deepseek`) のキャッシュ最適化そのもの / モデル品質改善 / Copilot 補完 (AI Credits 非課金) |
| Author | (fill in) |
| Last updated | 2026-11 |

> **前提の注意**: 本書は公開情報 (GitHub リポジトリ、Discussions、公式ドキュメント、コミュニティ記事) をもとに作成した。ローカルソースと突き合わせて確認すべき箇所は **【要ローカル確認】** で示す。DSH は developer preview であり、内部 API は破壊的変更があり得る。

---

## 0. TL;DR

1. **Copilot Enterprise は 2026-06-01 以降トークン従量 (GitHub AI Credits) 課金**。input / output / cached を別単価で課金し、Anthropic 系と GPT-5.6 以降の OpenAI 系には **cache write (≒1.25x)** 課金がある。つまり *cold → warm* は「プレフィックス全量の再処理 + 書き込み割増」になり、キャッシュ維持の経済価値は従来より大きい。
2. DSH 本体はすでに「**決定的なリクエスト組み立て (request compiler)**」設計で、セクション順・ツール順・append-only セッションによりプレフィックス安定性は高い。**Copilot ルートで落ちる主因はハーネス外側 (TTL 失効・retention 未設定・breakpoint 配置・compaction パラメータ差・揮発値混入・モデル切替)**。
3. 打ち手は次の 4 層で構成する。
   - **L1 計測**: リクエスト単位でプレフィックスを区間ハッシュし、ミスの「最初の分岐点」を特定する (無ければ何も最適化できない)。
   - **L2 プレフィックス安定化**: 揮発値の排除、ツール集合の session 固定、compaction の header 継承、モデル切替ガード。
   - **L3 Retention 制御**: モデル別に `cacheRetention` (short/long) を設定し、Anthropic は 1h TTL、OpenAI は 24h / 30m を活用。
   - **L4 Cold 回避 (Keepalive)**: アイドル時に「直前リクエストを最小出力で再送」するウォーマー。**損益分岐を計算して自動で ON/OFF** する (常時 ON は逆に損)。
4. 実装は **新規プラグイン `dsh-cache-guardian`** + **小さな upstream パッチ (compaction / runtime-context)** の組み合わせとし、`dsh-llm-github-copilot` (認証専用) には手を入れない。

---

## 1. 背景と課金モデル

### 1.1 GitHub Copilot の課金 (2026-06-01 以降)

- 全プランが premium request 単位から **GitHub AI Credits (1 credit = $0.01)** に移行。消費は **input / output / cached tokens** をモデル別 API 単価で換算する。
- Business / Enterprise はユーザーごとの月次クレジットが組織で **プール** される (Enterprise: 3,900 credits/user)。プール超過分は従量課金。
- 課金対象: Copilot Chat / CLI / cloud agent / third-party coding agents 等。**インライン補完と NES は対象外**。
- **cache write** は Anthropic モデルと GPT-5.6 以降の OpenAI ファミリーに適用される。例: GPT-5.6 Sol は input $4.00 / cached $0.40 / cache write $5.00 / output $20.00 (per 1M tokens)。

> DSH から `github-copilot` ルートで呼ぶ場合も、Copilot API (CAPI) を経由する以上、同じ AI Credits で計上される前提で設計する。**【要確認】** Enterprise 管理画面の *Usage this cycle* でモデル別内訳と cached 比率を実測する。

### 1.2 プロバイダ別キャッシュ仕様 (設計に効く部分のみ)

| 項目 | Anthropic (Claude) | OpenAI GPT-5.5 以前 | OpenAI GPT-5.6 以降 |
|---|---|---|---|
| 有効化 | `cache_control` (top-level 自動 or block 明示) | 自動 | 自動 + 明示 breakpoint 可 |
| breakpoint | 明示最大 4 / 自動は末尾ブロックに追従 | 自動 (GPT-5.5 は 2,048 tok 間隔) | 自動は最新 user/tool メッセージ末尾、明示は最大 3 (+自動 1) |
| 最小長 | 1,024 tok 程度 (モデル依存) | 2,048 tok (GPT-5.5) | 1,024 tok |
| TTL | 既定 5 分 (ヒットで延長) / `ttl: "1h"` | `in_memory` 5–10 分 / `24h` | `prompt_cache_options.ttl: "30m"` |
| read 単価 | 0.1x | モデル別割引 | 0.1x |
| write 単価 | 1.25x (5m) / 2.0x (1h) | なし | 1.25x |
| 失効しやすい原因 | **プレフィックス変更** (tools → system → messages の順で連鎖無効化) | **沈黙 (アイドル)** | 両方 |

ポイント: **Anthropic は「変更」で壊れ、OpenAI は「沈黙」で壊れる**。対策を同じにしてはいけない。

### 1.3 cold → warm のコスト (定式化)

プレフィックス長を $P$ (tokens)、通常 input 単価を $c$、read 倍率 $r$、write 倍率 $w$ とする。

- warm (ヒット) の次ターン入力コスト: $$C_{hit} = r \cdot c \cdot P$$
- cold (ミス→再書き込み) の次ターン入力コスト: $$C_{miss} = w \cdot c \cdot P$$
- 1 回の cold 化による損失: $$\Delta = (w - r)\, c\, P$$

Anthropic 5m TTL なら $\Delta = (1.25-0.1)cP = 1.15\,cP$。例えば $P = 150\text{k}$、Claude Opus 系 input $5/M なら 1 回の cold 化で約 $0.86 (≈86 credits)。長時間セッションで 1 日 10 回 cold 化すれば約 860 credits/日 となり、**Enterprise の月次プール 3,900 credits/user の大きな割合を cold 化だけで失う**。

---

## 2. DSH 現行設計の調査結果

### 2.1 Copilot ルートのリクエスト経路

```text
UI / agent-loop
   │  GenerateOptions { provider: "github-copilot", model, reasoningEffort, ... }
   ▼
@deepseek-ai/dsh-llm (LLM seam)
   ▼
@deepseek-ai/dsh-llm-pi-ai   ← ルート "github-copilot" (pi-ai catalog route)
   │  PiAiProviderProfile { cacheRetention?, compat?, headers?, retryPolicy? ... }
   ▼
@earendil-works/pi-ai        ← github-copilot provider
   │  OpenAI completions / responses  or  Anthropic messages (モデル依存)
   ▼
api.githubcopilot.com (CAPI)
```

- **`dsh-llm-github-copilot` (lujianjun19) は認証専用**。v0.4 系以降は OAuth device flow とクレデンシャル書き込みだけを担い、LLM アダプタもモデルカタログも持たない。トークン交換・リクエスト・ストリーミングは Harness 同梱の `@deepseek-ai/dsh-llm-pi-ai` ルートが担当する (同リポジトリの ADR-0002)。
  → **キャッシュ制御の改修ポイントは `dsh-llm-pi-ai` / `pi-ai` 側**であり、認証プラグインではない。
- 【要ローカル確認】`node_modules/@earendil-works/pi-ai` の github-copilot provider が、Claude モデルで **どの wire protocol (Anthropic messages / chat completions) を使い、`cache_control` を付与しているか**。

### 2.2 プレフィックス組み立て (request compiler)

公開解析記事・公式ドキュメントから確認できた設計:

| 構成要素 | 決定性の担保 | 出典の要旨 |
|---|---|---|
| System prompt sections | `order` 昇順 → 同順位は code-unit 名順。不正設定・未登録変数は組み立てエラー | system-prompt package / plugin tutorial |
| Tools | 既定は名前順。`toolOrder` で明示順 + `<unlisted-tools>` スロット | 同上 |
| Runtime context | **cache-safe な PromptContext** として durable な user-role snapshot に固定。更新は新 revision を **追記** (旧 snapshot は残す) | Discussion #5227 の実測 |
| Session | append-only `SessionEvent` ログから `deriveMessages()` で履歴を導出。「モデルに見えるものは記録済み」制約 | BestHub 解析記事 |
| Compaction | 履歴 prefix を checkpoint (user message) で置換。tool-result pruning → LLM 要約の 2 機構 | compaction docs / deep-dive |

→ **DSH 本体のプレフィックス安定性は高い**。実際、DeepSeek V4 + DSH/Pi 系で 99% 前後のヒット率が報告されている。ただしこれは「DeepSeek のディスクキャッシュ (自動・TTL 長め)」での数字で、**Copilot 経由の Anthropic / OpenAI では TTL と breakpoint 制約が加わる**ため同じ数字は期待できない。

### 2.3 既知のキャッシュ破壊要因 (DSH コミュニティ報告)

| # | 事象 | 原因 | 状態 / 対処 |
|---|---|---|---|
| K1 | resume 後 1 リクエスト目のヒット率が 0–3% に急落 | 同一 `order` の section (tool:workflow / tool:cordis = 115) の登録順が再起動で入れ替わる | 公式は 2026-08-24 に `tool:workflow` を 115.5 に変更して解消。コミュニティ版 `dsh-prompt-order-fix` もある |
| K2 | `--port 0` 再起動後 1 リクエスト目がミス | Web GUI の local URL (ポート番号) がモデル可視コンテキストに入る | 未解決扱い。**本設計で対処 (§4.2)** |
| K3 | compaction リクエストがプレフィックスキャッシュを全く使わない | summarizer が `reasoningEffort` を継承せず、`maxTokens: 8192` を追加 → キャッシュキーが分岐 | Discussion #1944 にパッチ案 (header.config を丸ごと継承)。**本設計で取り込む (§4.4)** |
| K4 | 並行セッションでヒット率が崩壊 | z.ai はキャッシュが API キー単位で共有 → 相互追い出し。pi-ai の session affinity 系 compat が DSH 側 gate で無効化 | z.ai 固有。Copilot でも **サブエージェント/並行セッションの影響を計測で確認** (§5) |
| K5 | `prompt_cache_key` が送られない | pi-ai は `api.openai.com` か long retention 時のみ送出。`cacheRetention: long` + `compat.supportsLongCacheRetention: true` で session id が key として送られる | Discussion #3761。**Copilot ルートで有効か要検証** |
| K6 | ウォーマーと実リクエストで TTL 認識がずれる | pi 本体で warmer が request options を env マージ前に取得 → 1h 設定でも 5m 前提で計画 | pi issue #11101。DSH で warmer を実装する際に **同じ値を単一ソースから読む** |

### 2.4 公式の直近改善 (0.2.2-rc.1 リリースノート)

- 実験的プラグイン「開発者ツール - 統計」: ターン/ステップごとにコンテキスト・**キャッシュ**・モデル・ツール時間を表示。→ L1 計測の土台に使える。
- 「Auto 自動レビュー」が連続ツール呼び出し間で履歴キャッシュをより再利用するよう改善。
- システムプロンプトが変わらない場合、新しいターンも既存のプレフィックスキャッシュを再利用できるよう修正。
- 小さいコンテキストのモデルに切り替える前に、元モデルで履歴を圧縮するよう変更。
- pi-ai 経由で「会話途中の system message 追記」非対応モデルは、後続 system message を元の位置にリマインダーとして置く (先頭 system へ移動しない = プレフィックスを壊さない)。

→ ローカルビルドが **0.2.2-rc.1 以降であること** を前提にする。【要ローカル確認】`git log --oneline | head` と `packages/*/package.json` の version。

---

## 3. 目標と KPI

### 3.1 KPI 定義

$$\text{HitRatio} = \frac{T_{read}}{T_{read} + T_{write} + T_{uncached}}$$

- $T_{read}$: cache read tokens / $T_{write}$: cache write (creation) tokens / $T_{uncached}$: キャッシュ対象外の通常 input
- **ColdEvents**: 前リクエストと同一プレフィックスのはずなのに $T_{read}/P < 0.5$ になった回数
- **CreditsPerTask**: 代表タスク完了までの AI Credits

### 3.2 目標値 (初期案)

| 指標 | 現状 (計測で埋める) | 目標 |
|---|---|---|
| HitRatio (Claude, 連続ツールステップ) | ? | ≥ 95% |
| HitRatio (セッション全体、人間のアイドル込み) | ? | ≥ 85% |
| ColdEvents / 時間 (アクティブ利用中) | ? | ≤ 1 |
| compaction リクエストの HitRatio | ? (K3 の場合 ~0%) | ≥ 90% |
| CreditsPerTask | ? | -30% 以上 |

> 参考: VS Code の Copilot ハーネスは Anthropic で cache_control アンカー配置の見直しによりエージェントセッションで約 94% のヒット率を報告している。95% は野心的だが不可能ではない値として置く。

---
## 4. 設計

### 4.1 全体構成

新規プラグイン **`dsh-cache-guardian`** (Cordis プラグイン, profile の `cordis.patch.yml` で mount) と、upstream への小パッチで構成する。

```text
┌───────────────────────── dsh-cache-guardian ─────────────────────────┐
│ CG-1 PrefixProbe     : リクエスト区間ハッシュ・usage 記録・ミス分岐点特定 │
│ CG-2 DriftLinter     : 揮発値/同順位 section/ツール集合変化の検出        │
│ CG-3 RetentionPolicy : モデル別 cacheRetention・TTL の単一ソース化       │
│ CG-4 Warmer          : 損益分岐ベースの keepalive (cold 回避)            │
│ CG-5 SessionGuard    : モデル切替・MCP 追加・指示ファイル編集の抑止/警告  │
│ CG-6 Dashboard       : /cache status コマンド + 統計プラグイン連携        │
└──────────────────────────────────────────────────────────────────────┘
          │ uses                                   │ patches (upstream PR)
          ▼                                        ▼
  llm-pi-ai: onPayload / usage event       P-1 compaction header 継承 (K3)
                                           P-2 runtime-context 揮発値除去 (K2)
                                           P-3 payload/usage イベント公開
```

設計原則:

1. **セッションログ (append-only JSONL) には書かない**。外部ツールによるログ改変は seq gap 破損の原因になるため、計測は `~/.dsh/cache-guardian/<sessionId>.jsonl` に別出しする。
2. **プレフィックスを変える処理はしない**。本プラグインはリクエスト本文を書き換えない (例外: CG-3 の retention 指定、CG-4 の `max_tokens` のみ変えた再送)。
3. **1 つの値は 1 か所で決める**。TTL・retention・価格表は CG-3 が単一ソースとなり、CG-4 も同じ値を読む (K6 の再発防止)。

### 4.2 CG-1 PrefixProbe (計測) — 最優先

**目的**: 「なぜ cold になったか」を 1 リクエスト単位で説明できるようにする。

**フック点**: pi-ai には、プロトコル組み立て後に発火する `StreamOptions.onPayload` フックがある (Discussion #3761)。DSH の `llm-pi-ai` がこれをプラグインに公開していない場合は **P-3 パッチ** で log-only イベントとして公開する。

```ts
// P-3: packages/llm/llm-pi-ai に追加する想定のイベント (log-only, surface には載せない)
interface LlmRequestPayloadEvent {
  sessionId: string
  requestId: string
  provider: string          // "github-copilot"
  model: string
  purpose?: 'turn' | 'compaction' | 'subagent' | 'warmup' | string
  payload: unknown          // wire payload (メモリ上のみ。永続化しない)
  sentAt: number
}
interface LlmUsageEvent {
  requestId: string
  inputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  outputTokens: number
}
```

**区間ハッシュ**: payload を正規化せず **送信バイト列そのまま** で区間分割し、SHA-256 を取る。

| 区間 | 内容 | 変化したときの意味 |
|---|---|---|
| H0 `routing` | model, reasoning/thinking 設定, tool_choice, retention 指定 | キャッシュ空間の切替 (全ミス) |
| H1 `tools` | tools 配列 (順序込み) | 全区間ミス |
| H2 `system` | system / developer | system 以降ミス |
| H3 `history[i]` | 各メッセージ (累積ハッシュ $h_i = \mathrm{H}(h_{i-1} \Vert m_i)$) | 分岐 index 以降ミス |

**ミス診断**: 直前リクエストと比べて最初に不一致となった区間を `firstDivergence` として記録する。H3 の不一致時は該当メッセージの **差分の先頭 200 バイトだけ** をマスクしてログ (全文は保存しない)。

**判定ロジック**:

```ts
expectedCached = commonPrefixTokens(prev, cur)          // 区間ハッシュから推定
observed       = usage.cacheReadTokens ?? 0
if (expectedCached > minCacheable && observed < 0.5 * expectedCached) {
  cause = firstDivergence ?? (idleMs > ttlMs ? 'ttl-expired' : 'provider-evicted-or-routing')
  emit('cache-guardian/cold', { cause, lostTokens: expectedCached - observed, idleMs })
}
```

`cause` 分類: `prefix-changed:<区間>` / `ttl-expired` / `routing-changed` / `provider-evicted-or-routing` (プレフィックス一致・TTL 内なのにミス = CAPI 側のルーティングやキャッシュ追い出し。K4 型の検出)。

**出力**: `/cache status` で直近 N リクエストのヒット率、cold 原因の内訳、推定損失 credits を表示する。0.2.2 の「開発者ツール - 統計」プラグインが入っている場合はそちらにも値を出す。

### 4.3 CG-2 DriftLinter (プレフィックス安定化)

**静的チェック (起動時)**

- 同一 `order` の system-prompt section / context が複数あれば警告する (K1 型。公式は「同順位は名前順」に変わっているが、サードパーティのプラグインが同値を使うケースへの保険)。
- section / context の **レンダリング結果** に揮発パターンがあれば警告する:
  - `127.0.0.1:\d+` / `localhost:\d+` (K2)
  - ISO8601 時刻、epoch、UUID、PID、乱数 ID
  - 絶対パス中の一時ディレクトリ (`\Temp\`, `/tmp/`)
- 検出時は **P-2 パッチ** で該当値を「system/context から外し、必要なら最初の user turn 側に一度だけ入れる」形にする。

**実行時チェック (毎リクエスト)**

- H1 (tools) がセッション途中で変化 → 原因プラグインを特定して警告する (MCP サーバー追加・プラグインのホットリロード・権限モード変更など)。
- H2 (system) が変化 → 原因 section 名を特定する (AGENTS.md 再読込、persona 変更など)。

**P-2 パッチ方針 (runtime-context の揮発値)**: Web GUI URL などはモデルにとって必須ではないため、`includeRuntimeContext` の対象から外すか、ポートを含まない固定表記 (`<local web ui>`) にする。【要ローカル確認】`rg -n "127.0.0.1|localhost" packages/**/src --glob '*context*'`

### 4.4 P-1 compaction の header 継承 (K3)

`dsh-compaction-basic` の `summarizeWithLlm` が、通常ターンと異なるパラメータ (`reasoningEffort` の欠落、`maxTokens: 8192` の追加) で要約を呼ぶため、プロバイダ側のキャッシュキーが分岐する問題への対処。

- 通常ターンと同様に `agent.session.requestHeader().config` を **丸ごと継承** する (`adapterDefaults` 由来のフィールドはスキップ)。
- 明示 `maxTokens` は付けない (アダプタ既定に任せる)。要約長の制御はプロンプト側で行う。
- 報告例では、同様のローカルパッチで compaction リクエストのプレフィックス再利用率がほぼ 0% から 99.7% に改善している (DeepSeek 系ゲートウェイでの値)。
- **Anthropic 経由の補足**: `max_tokens` 自体はキャッシュキーに入らないが、**thinking パラメータ / effort の差は messages 層を無効化する**。header 継承は Copilot→Claude でも必須。

【要ローカル確認】`rg -n "summarizeWithLlm|purpose: ?['\"]compaction" packages/compaction`

追加検討: **compaction 頻度そのものを下げる**。compaction は「履歴の先頭を置換」するので、実行後は置換点以降が必ず cold になる。

- `thresholdRatio` (既定 0.8) を上げる (例: 0.88) と、置換回数が減る。ただしオーバーフロー回復のリスクが増える。
- コミュニティの `dsh-live-compact` のように「終わったターンをモデル呼び出しなしでその場で切る」方式は、切断点より前を一切触らないためプレフィックスキャッシュを保つ。**大きな compaction を遅延させる手段として評価対象に入れる** (§6 Phase 3)。

### 4.5 CG-3 RetentionPolicy (TTL の設計)

**モデル別ポリシー表 (既定値案)**

| モデル族 (Copilot 経由) | retention | 理由 |
|---|---|---|
| Claude (Opus/Sonnet) — 対話主体 | `long` (1h) | 人間の思考待ちで 5 分を超えやすい。1 回の cold 化損失 $1.15\,cP$ が、1h write 割増 $0.75\,c\,\Delta_t$ (ターンごとの新規 tokens 分) を上回りやすい |
| Claude — 自律ループ主体 (連続ツール) | `short` (5m) | ステップ間隔が秒〜数十秒なら 5m で十分。1h の割増は無駄 |
| GPT-5.5 以前 | `long` (`24h`) | write 課金なし。24h 保持でアイドル後もヒット |
| GPT-5.6 以降 | 既定 (`30m`) | 30m のみ指定可。write 1.25x |

**1h を選ぶ損益分岐 (Claude)**: ターンあたりの新規書き込み tokens を $\Delta_t$、1 セッション中に 5 分超のアイドルが起きる回数を $k$、ターン数を $N$ とすると、

$$\text{1h が有利} \iff 0.75\, c \sum_{t=1}^{N} \Delta_t \;<\; k \cdot 1.15\, c\, P$$

例: $P=120\text{k}$、$\Delta_t = 4\text{k}$、$N=40$ なら左辺は $0.75 \times 160\text{k} = 120\text{k}\,c$、右辺は $k=1$ で $138\text{k}\,c$。**5 分超のアイドルが 1 回でもあれば 1h が有利**。CG-3 は CG-1 の実測 ($\Delta_t$, アイドル分布) から、セッションごとにこの式を評価して推奨値を出す。

**設定経路**

```yaml
# ~/.dsh/settings.yaml (案) — フィールド名は【要ローカル確認】
llm-pi-ai:
  providers:
    github-copilot:
      cacheRetention: long            # none | short | long
      compat:
        supportsLongCacheRetention: true   # prompt_cache_key(session id) 送出の前提 (K5)
      modelOverrides:
        claude-sonnet-x:              # 自律ループ用途なら short に
          cacheRetention: short
```

- pi-ai の `CacheRetention` は `none | short | long`。Anthropic では `long` で `cache_control` に `ttl: "1h"` が付く。OpenAI 系は `prompt_cache_key` / `prompt_cache_retention` に反映される。グローバルな `PI_CACHE_RETENTION` 環境変数はプロセス全体 (DeepSeek ルート含む) に効いてしまうため **使わない**。ルート/モデル単位で設定する。
- 【要検証】DSH の `llm-pi-ai` が `cacheRetention` をルート設定として受け付けるか、また COMPLETIONS_COMPAT_GATE が `github-copilot` ルートで何を withhold しているか。受け付けない場合は **P-4 パッチ**: `PiAiProviderProfile` に `cacheRetention` と `modelOverrides[*].cacheRetention` を追加し、`buildRequestOptions()` で一度だけ解決して `options.cacheRetention` に設定する (pi issue #11101 と同じ方針)。
- 【要検証】Copilot API (CAPI) が Claude の `cache_control.ttl: "1h"` と OpenAI の `prompt_cache_retention` / `prompt_cache_key` を **素通しするか**。VS Code の Copilot ハーネスは OpenAI に 24h retention、Anthropic に cache_control アンカーを使っていると公表しているため、CAPI 側に経路はある見込み。CG-1 の usage で `cacheWriteTokens` の単価差 (1.25x/2.0x) と 5〜60 分アイドル後のヒットを実測して確定させる。

### 4.6 Anthropic breakpoint 配置 (Claude via Copilot)

pi-ai が付与する `cache_control` の位置を CG-1 で確認し、以下になっていなければ P-5 パッチ (pi-ai の onPayload で付け替え) を行う。

| # | 位置 | 意図 |
|---|---|---|
| BP1 | tools 配列の末尾 | ツール定義 (最も安定) |
| BP2 | system の末尾 | ハーネス指示・AGENTS.md・skills |
| BP3 | runtime-context snapshot の末尾 (最初の user 側 durable snapshot) | 揮発しにくい環境情報 |
| BP4 | 最後のメッセージ (自動追従) | 会話履歴 |

- 明示 breakpoint は最大 4。上記で上限に達するので、**ツール結果ごとに付けるような実装は禁止**。
- breakpoint 区間が最小キャッシュ長 (約 1,024 tok) 未満だと書き込まれない。BP3 が短い場合は BP3 を省き BP4 を前に置く。
- Copilot の CLI/VS Code も「system / tools / 最終 user メッセージ」の 3 か所にアンカーを置く方式で、これと整合する。

### 4.7 CG-4 Warmer (cold 回避 keepalive) — 本件の核心

**方式**: 直前の「実リクエスト」の payload をメモリに保持し、TTL 失効の少し前に **同じ payload を `max_tokens` 最小 (例: 1) で再送** する。会話は再構築せず、ツールも実行せず、応答はセッションに入れない。pi のコミュニティ拡張 `pi-warm-cache` と同じ方式。

**なぜ「同じ payload の再送」か**: 新しいダミー user メッセージを足すと、そのメッセージ自体が書き込み対象になり、次の実リクエストとの共通プレフィックスもずれる。再送ならプレフィックスはバイト単位で一致し、Anthropic では読み取りで TTL が延長される。

**損益分岐 (自動 ON/OFF の根拠)**

ping 1 回のコスト ≈ $r\,c\,P + \epsilon$ (出力 1 token 程度)。cold 化 1 回の損失は $(w-r)\,c\,P$。よってアイドル 1 回あたりの最大 ping 回数は

$$n_{max} = \left\lfloor \frac{w - r}{r} \right\rfloor$$

| 対象 | $w$ | $r$ | $n_{max}$ | ping 間隔 (TTL − 余裕) | 保護できるアイドル長 |
|---|---|---|---|---|---|
| Claude, 5m TTL | 1.25 | 0.1 | 11 | 約 4.5 分 | 約 50 分 |
| Claude, 1h TTL | 2.0 | 0.1 | 19 | 約 55 分 | 約 17 時間 (実用上は上限で打ち切り) |
| GPT-5.6+, 30m | 1.25 | 0.1 | 11 | 約 27 分 | 約 5 時間 |
| GPT-5.5, 24h | — | — | 不要 | — | — |

ただし、アイドルがそのまま「作業終了」になると ping はすべて無駄になる。そのため期待値で判断する。

$$\mathbb{E}[\text{利得}] = p_{resume}(I)\,(w-r)\,c\,P \;-\; n(I)\, r\, c\, P$$

$p_{resume}(I)$ は「アイドル $I$ 分後に同セッションへ戻る確率」で、CG-1 の履歴から推定する (初期値: 15 分以内 0.8、60 分以内 0.4)。**期待利得が負になった時点で ping を止める。**

**ポリシー (既定)**

```yaml
cache-guardian:
  warmer:
    enabled: auto            # auto | on | off
    minPrefixTokens: 30000   # これ未満の prefix は温めない (損失が小さい)
    marginMs: 30000          # TTL の 30 秒前に ping
    maxPingsPerIdle: auto    # n_max と期待値から算出 (上限 hardCap)
    hardCap: 8
    dailyCreditBudget: 50    # warmer が 1 日に使える AI Credits 上限
    onlyWhenUiOpen: true     # Web UI / Desktop のタブが開いている間だけ
    excludePurposes: [compaction, subagent]
    excludeThinkingBudget: true   # Anthropic の budget 型 thinking は対象外
```

**安全装置**

1. **実ターン開始で即キャンセル**。in-flight の ping が後から返ってきても、usage を「実ターンのヒット」として数えない。
2. **thinking 設定の扱い**: Anthropic の budget 型 thinking は `budget_tokens < max_tokens` 制約があるため、`max_tokens` を小さくできない。thinking パラメータを変えるとキャッシュが無効になるため、**budget 型 thinking のリクエストは温めない** (`pi-warm-cache` も同じ制限)。adaptive/effort 型の場合は【要検証】。
3. **無効化イベントで anchor を破棄**: compaction 完了、モデル変更、effort 変更、ブランチ/フォーク切替、ツール集合変化のあとは、次の実ターンまで ping しない。
4. **期限**: anchor 取得 (または最後の成功 ping 送信) から TTL を過ぎたら payload を破棄する。期限の起点は **送信時刻** (Anthropic の TTL はリクエスト開始時刻起点のため)。
5. **payload は永続化しない** (メモリのみ)。プロセス終了で消える。
6. **Copilot 利用規約・レート制御への配慮**: ping は実課金リクエストであり、過度な自動化は abuse 判定の対象になり得る。`hardCap` と `dailyCreditBudget` を必須にし、UI が閉じている間・夜間は止める。組織ポリシー上 keepalive 自体が許容されるか、事前に管理者へ確認すること。

**再起動 / resume 時**: 再起動しても **TTL 内でプレフィックスがバイト一致していればヒットする**。したがって「resume 時の事前ウォームアップ」は不要 (実リクエストと同コストになるだけ)。重要なのは K1/K2 の解消でバイト一致を保証すること。

### 4.8 CG-5 SessionGuard (運用ガード)

| 操作 | 影響 | ガード |
|---|---|---|
| セッション途中のモデル切替 | キャッシュ空間が別 (全ミス) | 確認ダイアログ。「新しいセッションで切り替え」を推奨 |
| MCP サーバー / ツール提供プラグインの追加・削除 | tools 層から全ミス | 確認。可能なら次セッションから反映 |
| AGENTS.md / instructions の編集 | system 層から全ミス | **セッション開始時に内容を固定 (snapshot)**。変更は次セッションから反映、または「追記メッセージ」として末尾に流す (Codex が設定更新を新メッセージとして追記する方式と同じ) |
| reasoning effort の変更 | Anthropic では messages 層が無効 | 警告 |
| 画像の追加・削除 (過去メッセージ) | messages 層が無効 | 警告 |
| 小タスクごとの新セッション | 毎回、初回ターンが全額 | 「1 つのまとまった作業は 1 セッションで」をヒント表示 |

### 4.9 (任意) ツール定義の遅延ロード

VS Code の Copilot は、ツール定義を必要になった時点で読み込む tool search を導入し、遅延ロードしたツールは **コンテキスト末尾に追加** してプレフィックスキャッシュを保つ設計で、セッション全体のトークンを中央値で約 18% 削減したと報告している。DSH でも MCP ツールが多い構成では効果がある。ただし本件 (ヒット率) への寄与は二次的なので Phase 3 とする。

- 常時ロード: read / write / edit / bash / search など頻出ツール
- 遅延ロード: MCP ツール群。名前と 1 行説明だけを system に置き、スキーマは `tool_search` の結果 (末尾メッセージ) として返す
- 【要検証】pi-ai と CAPI で Anthropic / OpenAI の deferred tool 機能が使えるか。使えない場合はハーネス側の擬似実装 (ツール結果として schema を返し、汎用 `call_tool` で実行) を検討する

---

## 5. 計測計画

### 5.1 ベースライン (Phase 0)

1. 代表タスクを 3 種類用意する (例: RX/RZ ファームのバグ修正 1 件、TypeScript 機能追加 1 件、ドキュメント生成 1 件)。
2. 各タスクを Claude 系 1 モデル・GPT 系 1 モデルで、現状設定のまま 3 回ずつ実行する。
3. CG-1 (または暫定で統計プラグイン + セッションログの usage) から HitRatio、ColdEvents と原因内訳、CreditsPerTask を取得する。
4. Enterprise の Usage 画面の数値と突き合わせる (CAPI 側の cached 計上が DSH の usage と一致するか)。

### 5.2 CAPI 挙動の検証実験

| 実験 | 手順 | 判定 |
|---|---|---|
| E1 TTL (Claude, short) | 同一 payload を 0 / 4 / 6 / 10 分間隔で再送 | 6 分でミスなら 5m TTL が有効 |
| E2 TTL (Claude, long) | `cacheRetention: long` で 10 / 30 / 55 / 65 分 | 55 分ヒット・65 分ミスなら 1h が素通し |
| E3 write 単価 | E1/E2 の初回の credits 差 | 1.25x / 2.0x の差が見えるか |
| E4 OpenAI retention | GPT-5.5 で 1h / 6h アイドル後 | 24h 保持の有無 |
| E5 並行干渉 | 同一アカウントで 2 セッションを交互に実行 | K4 型の追い出しが CAPI で起きるか |
| E6 ping 延命 | E1 の条件で 4.5 分ごとに `max_tokens=1` ping | 20 分後にヒットするか |
| E7 compaction | P-1 の前後で /compact を実行 | compaction リクエストのヒット率 |

### 5.3 A/B 判定

施策ごとにタスク成功率が下がらないことを確認したうえで、CreditsPerTask の中央値で判定する。モデル出力は非決定的なので各条件 3 回以上実行する。

---

## 6. 実装計画

| Phase | 内容 | 成果物 | 目安 |
|---|---|---|---|
| **P0** | ローカルソース調査 (§7) + Phase 0 ベースライン | 調査メモ、ベースライン数値 | 1–2 日 |
| **P1** | CG-1 PrefixProbe + P-3 (payload/usage イベント公開) + `/cache status` | ミス原因が説明できる状態 | 2–3 日 |
| **P2** | quick wins: P-1 compaction 継承、P-2 揮発値除去、CG-2 DriftLinter、CG-5 SessionGuard (警告のみ) | ColdEvents の削減 | 2–3 日 |
| **P3** | CG-3 RetentionPolicy (+P-4 必要時)、E1–E4 の実験で CAPI 挙動を確定 | モデル別 retention 既定値 | 2 日 |
| **P4** | CG-4 Warmer (auto モード、予算・上限付き)、E6 で検証 | アイドル時の cold 回避 | 3–4 日 |
| **P5** | 任意: breakpoint 最適化 (P-5)、ツール遅延ロード、live-compact 型の軽量圧縮 | 追加の削減 | 適宜 |

**upstream 方針**: P-1 / P-2 / P-3 は汎用性が高いため、DSH 本体へ PR (英中バイリンガル README と Agent Note が必要な文化なので、それに合わせる)。CG-* はプラグインとして独立させ、DSH のアップデートに追従しやすくする。

### 6.1 テスト

- **単体**: 区間ハッシュの安定性 (同一入力→同一ハッシュ)、`firstDivergence` の判定、損益分岐計算、warmer の状態遷移 (anchor 取得 → ping → キャンセル → 失効)。
- **request-rebuild 系**: DSH 既存の「ログからリクエストを再構築できる」テストに、*resume 前後で H0–H2 が一致すること* と *`--port` を変えて再起動しても H2 が一致すること* を追加する。
- **snapshot**: `system-prompt.expected.md` 系のスナップショットに、揮発パターンが含まれないことの lint を追加する。
- **E2E (手動)**: §5.2 の実験をスクリプト化する (`scripts/cache-probe.ts`)。

---

## 7. ローカルソース調査チェックリスト (P0)

Git Bash から実行する想定。

```bash
# 0. バージョン
git log --oneline -5
jq -r '.version' packages/llm/llm-pi-ai/package.json packages/compaction/compaction-basic/package.json

# 1. pi-ai のキャッシュ制御 (github-copilot provider と cache retention)
PIAI=$(node -p "require.resolve('@earendil-works/pi-ai/package.json')" | xargs dirname)
rg -n "cacheRetention|cache_control|prompt_cache_key|prompt_cache_retention|ttl" "$PIAI/dist" | head -50
rg -n "github-copilot|githubcopilot" "$PIAI/dist" | head -30
rg -n "onPayload" "$PIAI/dist" | head

# 2. DSH llm-pi-ai のプロファイル項目と compat gate
rg -n "cacheRetention|supportsLongCacheRetention|COMPLETIONS_COMPAT_GATE|sendSessionAffinityHeaders|onPayload" packages/llm/llm-pi-ai/src

# 3. usage の cacheRead / cacheWrite 取り回し
rg -n "cacheReadTokens|cacheWriteTokens|cache_read_input_tokens|cache_creation_input_tokens|cached_tokens" packages/llm packages/agent* packages/telemetry

# 4. system prompt の順序決定と同順位
rg -n "getSectionOrder|getContextOrder|order:\s*1[0-9]{2}" packages | sort | uniq -c | sort -rn | head

# 5. runtime context の揮発値
rg -n "127\.0\.0\.1|localhost|new Date\(|Date\.now\(|randomUUID|process\.pid" packages/**/src --glob '*context*' --glob '*prompt*'

# 6. compaction の要約リクエスト
rg -n "summarizeWithLlm|maxTokens|reasoningEffort|purpose" packages/compaction/compaction-basic/src

# 7. 統計プラグイン (0.2.2 実験機能) の取得元
rg -n "cache" packages/experimental --glob '*stat*'
```

調査で確定させる項目:

- [ ] github-copilot ルートで Claude は Anthropic messages / chat completions のどちらか
- [ ] Claude リクエストに `cache_control` が何か所付くか (§4.6 と一致するか)
- [ ] `cacheRetention` をルート/モデル単位で設定できるか (P-4 の要否)
- [ ] `prompt_cache_key` が Copilot ルートで送られるか (K5)
- [ ] usage に cache read / write が両方入っているか (CAPI が返しているか)
- [ ] runtime context に揮発値があるか (K2)
- [ ] compaction が header を継承しているか (K3)

---

## 8. 利用者向け運用ルール (コード改修なしで今日からできること)

1. **最初のターンの前にハーネスを確定する**: モデル、MCP、プラグイン、AGENTS.md、effort をセッション開始前に決め、途中で変えない。
2. **1 つのまとまった作業は 1 セッションで行う**: セッションの初回ターンは常に全額。細切れにすると固定費が積み上がる。
3. **モデルを試したいときは新しいセッションで**: 同一セッション内の切替は、それまでの履歴を全額で再処理する。
4. **離席の目安**: Claude (5m TTL) で 5 分以上離れると次のターンが cold になる。長考や会議を挟むなら retention を long に (§4.5)。GPT-5.5 は 24h 保持のため気にしなくてよい。
5. **`--port 0` での起動を避け、ポートを固定する** (K2 の暫定回避)。
6. **compaction を必要以上に手動実行しない**: 実行のたびに置換点以降が cold になる。
7. **サブエージェントは用途を絞る**: 別セッション扱いのため、それぞれに初回コストがかかる。小さな作業は親セッションで行う。

---

## 9. リスクと未解決事項

| リスク | 影響 | 緩和策 |
|---|---|---|
| CAPI が `ttl`/`prompt_cache_retention` を無視・拒否 | CG-3 の効果なし、またはリクエスト失敗 | E1–E4 で確認。拒否時はルート単位で自動 fallback |
| keepalive が利用規約 / abuse 判定に抵触 | アカウント制限 | `hardCap`・予算・UI 開時のみに制限。管理者に事前確認。既定は `auto` で控えめに |
| warmer の誤判定で credits を浪費 | コスト増 | `dailyCreditBudget`、期待値が負なら停止、CG-1 で warmer 自身の ROI を表示 |
| pi-ai / DSH のアップデートで内部 API 変更 | パッチ破損 | upstream PR 化、ハッシュ計測は wire payload ベースで内部構造に依存しない |
| Copilot の token 交換エンドポイントが非公開 API | 将来の破損 | 認証は既存プラグイン任せ。本設計の範囲外 |
| 計測ログに機密コードが残る | 情報漏えい | ハッシュと統計のみ保存。差分抜粋はマスクして 200 バイトまで。payload はメモリのみ |
| TTL 切替 (short↔long) がキャッシュキーに影響する可能性 | 切替時に 1 回 cold | 【要検証】セッション途中では切り替えない (開始時に決定) |

---

## 10. 参考資料

**DSH 本体・ディスカッション**
- deepseek-ai/deepseek-harness — https://github.com/deepseek-ai/deepseek-harness
- Releases (0.2.2-rc.1 notes) — https://github.com/deepseek-ai/deepseek-harness/releases
- Discussion #2141 section ordering drift — https://github.com/deepseek-ai/deepseek-harness/discussions/2141
- Discussion #2136 `--port 0` cache miss — https://github.com/deepseek-ai/deepseek-harness/discussions/2136
- Discussion #1944 compaction cache miss — https://github.com/deepseek-ai/deepseek-harness/discussions/1944
- Discussion #5227 session affinity / compat gate — https://github.com/deepseek-ai/deepseek-harness/discussions/5227
- Discussion #3761 extraBody / prompt_cache_key — https://github.com/deepseek-ai/deepseek-harness/discussions/3761
- Note: equal-order sections fix — https://www.dsh-remote.com/notes/archived/bug-fix/2026-08-24-system-prompt-section-order-ties
- System Prompt Assembly reference — https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/system-prompt.html
- Compaction docs — https://www.deepseek-harness-docs.com/en/runtime/compaction
- Compaction deep dive — https://hoco-scy.github.io/deepseek-harness-deep-dive/pages/compaction.html
- DSH 99% cache hit analysis (request compiler) — https://www.besthub.dev/articles/deepseek-harness-how-99-cache-hits-validate-request-prefix-stability-f40160929ea9

**プラグイン / 拡張**
- lujianjun19/dsh-llm-github-copilot — https://github.com/lujianjun19/dsh-llm-github-copilot
- yugbin/dsh-prompt-order-fix — https://github.com/yugbin/dsh-prompt-order-fix
- dsh-live-compact — https://dsh-plugin.org/plugins/merkyorlynn/dsh-live-compact
- pi-warm-cache (Pi) — https://pi.dev/packages/pi-warm-cache
- pi-cache-optimizer (Pi) — https://github.com/jiangge/pi-cache-optimizer
- pi issue #11101 cacheRetention setting — https://github.com/earendil-works/pi/issues/11101
- pi-ai prompt caching (DeepWiki) — https://deepwiki.com/earendil-works/pi/3.3-prompt-caching-thinking-and-cross-provider-handoff

**GitHub Copilot / プロバイダ**
- GitHub Copilot usage-based billing announcement — https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/
- Usage-based billing for organizations and enterprises — https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/billing
- Models and pricing for GitHub Copilot — https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
- Improving token efficiency for GitHub Copilot in VS Code — https://code.visualstudio.com/blogs/2026/06/17/improving-token-efficiency-in-github-copilot
- Copilot Token Optimization Workshop: Prompt cache — https://chibayuki347.github.io/token-optimization-workshop/concepts/prompt-cache/
- Anthropic prompt caching — https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- OpenAI prompt caching — https://developers.openai.com/api/docs/guides/prompt-caching
- GPT-5.6 以降のプロンプトキャッシュ仕様 (Zenn) — https://zenn.dev/shogo_h/articles/gpt56-prompt-caching-explicit
