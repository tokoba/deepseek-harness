# GitHub Copilot Enterprise × DeepSeek Harness: Cache Hit Ratio Improvement

- 配置先: `docs/feat/cache-hit-ratio-improvement.md`
- 調査日: 2026-11-08
- 状態: Design proposal / 実装・有料接続試験前
- 対象: ローカルビルド版 DeepSeek Harness、組み込み github-copilot provider、主としてテキストによるコード開発
- 設計方針: 観測 → prefix 安定化 → compact/replay 改善 → 条件付き warming

> 本書は公開リポジトリ・公式文書を基にした設計である。利用者のローカル checkout、lockfile、インストール済み plugin、実リクエスト、請求明細にはアクセスしていない。公開 master の取得結果には異なる時点のファイルが混在するため、単一 commit をビルド・実行して検証した監査結果ではない。既存コードとして確認したもの、コミュニティ報告、提案を区別する。以下の新しい型・サービス・設定名は、明示しない限り提案であり、そのまま既存設定に貼り付けて使うものではない。

## 1. 結論と採用方針

**「常時 warm」ではなく、「実作業の総コストと待ち時間を最小化しつつ、再利用可能な prefix を最大限保持する」を目的にする。**

1. 最初に provider が返す cache read/write と未キャッシュ入力を正しく観測する。
2. system、tool schema、履歴、reasoning 設定の不必要な変動をなくす。
3. 会話は append-only を基本とし、必要な compact は計画的な cache epoch の切り替えとして扱う。
4. Copilot 経由の TTL・long retention・warming の実効性は、直接 API の仕様から推定して有効化しない。
5. warming はデフォルト無効。正確な native serializer、実際の cache evidence、課金、出力制限、利用者の同意が揃った場合だけ短時間・予算付きで試す。
6. 最初の導入候補は CacheScope 相当の観測と、cache-stabilizer 相当の限定的な安定化。warmer は後段、全面 freeze は原則不採用。

根拠: 認証 plugin は現行 README 上では認証情報の提供だけを担い、モデル送信は Harness の `@deepseek-ai/dsh-llm-pi-ai` route が担当する。従って cache 改善の中心はログイン plugin ではなく、prompt assembly、pi-ai adapter、native serializer、履歴 projection にある。[S2][S3]

### 1.1 cold に関する前提の修正

cold になれば、再利用できなくなった prefix は再度 prefill の対象になり得る。しかし、以下は別物である。

- HTTP で送る入力サイズ。
- モデルの論理入力トークン数。
- 未キャッシュ入力として処理されるトークン数。
- cache write として処理されるトークン数。
- 実際の AI credits / 請求額。

通常の stateless request は cache hit でも履歴を再送する。cache は主として計算と課金分類の最適化であり、通信量削減を保証しない。cold からの回復に、同じ巨大履歴を何回も段階的に送る必要があるとは限らない。対応する prefix を含む一度の実リクエストが cache を形成し、その後の利用で hit が観測される可能性がある。書き込み完了時点や保持は route 依存である。[S10][S11]

**小さな独立した「ping」を送っても、巨大な会話 prefix の cache を refresh した証拠にはならない。** 目的の prefix と一致する入力が必要であり、その送信・cache read・追加出力自体にコストがある。

## 2. 調査結果と証拠の強さ

### 2.1 公式仕様と適用境界

| 項目 | 確認内容 | この環境での扱い |
|---|---|---|
| GitHub Copilot 課金 | 公式価格表は入力、cached input、モデルによって cache write、出力を区別し、AI credits へ換算する | 現行価格表と組織の実利用レポートを優先する。Enterprise だから追加リクエストが無料とはしない |
| Anthropic 直接 API | `cache_control`、5 分 / 1 時間の TTL、利用時 refresh を説明 | Copilot gateway が同じ制御を受け入れる保証ではない |
| OpenAI 直接 API | 同じ rendered prefix の再利用。session 維持だけでは hit を保証しない | `prompt_cache_key` や retention の Copilot 対応を別途確認する |
| DSH adapter | `cacheRetention` を profile から pi-ai options に渡す | 設定が通ることと、上流で効くことは別 |
| DSH usage mapping | `mapUsage` が `input`、`output`、`cacheRead`、`cacheWrite` を変換 | 欠落・ゼロ・unsupported の区別に注意する |

出典: [S4][S5][S10][S11][S12]。

**本調査では Copilot route のモデル別 cache TTL、明示的 refresh API、1 時間 retention の保証を確認できなかった。** 5 分・1 時間・24 時間を全 Copilot モデルに一律適用しない。画面の countdown はあくまでローカル推定であり、サーバーの残存時間ではない。

### 2.2 公開コードで確認した変更候補

| パス | 確認した役割 | 改良方針 |
|---|---|---|
| `packages/llm/llm-pi-ai/src/config.ts` | provider ごとの `cacheRetention: none/short/long`、compat、reasoning 等 | capability を route/model/serializer 単位で検証する |
| `packages/llm/llm-pi-ai/src/adapter.ts` | `profileOptions()` が cacheRetention 等を pi-ai に渡す | 最終解決済み設定の fingerprint と診断 seam を追加する |
| `packages/llm/llm-pi-ai/src/context.ts` | `toPiContext()`、`toolsOf()`、`piContext()` が変換。`options.system` は `systemPrompt` に対応 | 論理入力と native wire の差を観測する |
| `packages/llm/llm-pi-ai/src/replay.ts` | assistant replay state の変換境界 | reasoning/signature/tool-call replay の不変性を検証する |
| `packages/llm/llm-pi-ai/src/stream.ts` | `mapUsage()` による usage 変換 | 欠落とゼロの provenance、TTL 別 write を保持する |
| `packages/compaction/compaction-basic/src/summarizer.ts` | 元の system/tools/履歴を replay し、末尾に compact 指示を追加する設計 | effective reasoning/options を含めて prefix を揃える |
| `packages/llm/llm/src/types.ts` | usage 型の変更候補。コミュニティ報告に記載 | ローカル型を確認して後方互換で拡張する |

`replay.ts` の詳細実装は今回全文監査していない。名前だけから完全な replay 保証を主張しない。他の項目は公開コード・文書の確認範囲である。[S3][S4][S5][S6][S7][S13]

### 2.3 注意すべき公開報告

- Discussion #9225: pi-ai の `cacheWrite1h` が DSH mapping で落ち、1 時間 write を安く見積もる問題の報告。取得した `stream.ts` でも `cacheRead` / `cacheWrite` の mapping は確認できるが、TTL 別 mapping は見当たらない。ローカル版で再確認する。[S5][S13]
- Discussion #7794: compact 呼び出しで reasoning effort が欠落し、local endpoint の prefix が変わる報告。これは local Qwen 系の事例であり、Copilot で同じ障害が再現する証拠ではない。共通の regression test として採用する。[S14]
- Discussion #8190: gateway 固有の cache-write フィールドが読み落とされる報告。Copilot の障害と断定しないが、usage alias と provenance の必要性を示す。[S15]
- Discussion #9091: UI の session 累積 hit ratio と per-call 指標の混同を問題提起している。累積値だけで最新の cold を判断しない。[S16]

これらはコミュニティの報告であり、全バージョンでの未修正を意味しない。

## 3. 既存 plugin の評価

| 候補 | 公開 README にある機能 | 採用判断 |
|---|---|---|
| `kober-basket/dsh-cachescope` | provider usage、隣接 logical input 差分、TTFT、purpose/retry 別表示。送信内容は変更しない | 最優先の評価候補。最初は `captureInput: metadata` |
| `dongsheng123132/dsh-cache-stabilizer` | 既知の persona 文から cwd を runtime context に移し、tool schema object key を canonicalize。`/cache` 表示 | 限定導入または実装の参考。ローカル版の既存対策と重複しないことを確認 |
| `lemonel/dsh-prompt-freeze` | tool 宣言と名前付き system section の snapshot/replay、差分確認と明示適用 | opt-in の比較実験のみ。権限・安全ルール・最新状態を凍結しない |
| `yoggu/dsh-cache-warmer` | native route による opt-in warming、推定 lifetime、経済判定、個別 accounting | 設計参考として有用。ただしレビュー済み adapter/serializer バージョンが限定されるため、そのまま動作保証しない |
| `theworld-lab/deep-seek-cache-plugin` | prefix 診断、動的フィールド移動、schema 安定化。Python wrapper と TS 構成を含む | DeepSeek API 向けの前提を Copilot に移植しない。汎用的な自動 role 移動は不採用 |
| `lujianjun19/dsh-llm-github-copilot` | device flow と credential 提供。LLM adapter は登録しない | 認証維持に利用。cache policy をここへ実装しない |

出典: [S2][S8][S9][S17][S18][S19]。これらの README 上の機能・互換性は、当方でのインストール・実 API 試験結果ではない。

### 3.1 バージョン上の重要な落とし穴

- 公開 root は `0.2.2-rc.1` の release を示す一方、認証 plugin の README の明示検証範囲は主に `0.2.1-rc.3` まで。[S1][S2]
- warmer は `llm-pi-ai 0.2.0-rc.2 / pi-ai 0.99.1` のレビューを記載する一方、取得した `stream.ts` の履歴には pi-ai `1.3.0` への更新がある。[S5][S18]
- freeze の README も DSH `0.2.0` ～ `0.2.1` の範囲を示す。[S17]

従って「最新版 plugin を全部入れる」は作戦にしない。ローカル commit、resolved dependency、plugin commit を固定して、互換性を先に検証する。特に warmer が version drift で fail closed する場合、バージョンチェックだけを削除して動かしてはいけない。

### 3.2 初期構成

第一段階は観測 plugin だけを有効化し、次に stabilizer を単独で追加する。freeze、stabilizer、自作 canonicalizer を同時に有効化すると変更原因の切り分けができない。

CacheScope の公開設定例に基づく override:

```yaml
- id: cachescope
  name: '@kober-basket/dsh-cachescope'
  config:
    captureInput: metadata
```

これは既存 bundle の override を意図する。profile の実際の構成に合わせ、同じ plugin を二重登録しない。公開 bundle は full capture を有効化するため、機密コードを送る前に metadata へ変更する。[S8]

## 4. 最適化目標と計測定義

### 4.1 トークン指標

正規化後の互いに重複しない bucket を使う。

- `U`: uncached input
- `R`: cache read
- `W`: cache write
- `O`: output。provider によって reasoning が含まれる
- `P = U + R + W`: logical prompt total
- `H = R / P`: token-weighted cache hit ratio。`P = 0` は N/A

複数 call の集計は `sum(R) / sum(P)` とし、各 call の百分率の単純平均を使わない。出力は分母に入れない。cache read が不明の call は「0%」にせず、既知データの ratio と reporting coverage を併記する。[S8][S16]

**重要:** 取得した `mapUsage()` は pi-ai の cache count が 0 のとき DSH field を省略する。従って DSH field の欠落だけから「provider が非対応」も「本当にゼロ」も断定できない。native raw usage の有無と parser の capability を別に持つ必要がある。[S5]

### 4.2 主指標

1. 実ユーザー要求 1 件当たりの AI credits または検証済み費用。
2. 実ユーザー要求の TTFT p50/p95。
3. 作業完了率、ツール実行の正確性、最新状態の反映。
4. 実ユーザー要求だけの weighted hit ratio。
5. 実ユーザー要求 + warming + compact + title + retries を含む総費用。
6. `cache usage known / total attempts` の reporting coverage。
7. cold が疑われる復帰時の未キャッシュ入力と待ち時間。

warming call だけを大量に作って hit ratio を上げても成功としない。大きな履歴を残し続けて 99% hit にするより、必要な情報だけの短い入力が安い場合がある。

### 4.3 cold 原因の分類

- `prefix_changed`: 論理入力または native prefix が変わった。
- `route_changed`: model/account/endpoint/protocol/serializer が変わった。
- `epoch_changed`: compact、履歴編集、branch 切替等。
- `usage_unknown`: 観測不能。
- `stable_prefix_miss`: ローカル上は安定しているが provider は hit を報告しない。
- `suspected_expiry`: idle 時間と再現試験から期限切れが疑われる。
- `suspected_routing_or_eviction`: routing/eviction が疑われる。

最後の二つは推定であり確定原因ではない。prefix hash の一致を server cache hit と表示しない。

## 5. Prefix 安定化の設計

### 5.1 不変条件

- 既存の system/developer/user の権限階層を保つ。
- tool 実行許可は毎回現在の authority で評価する。
- 安全・組織ポリシーの変更は cache より優先する。
- 過去の tool call ID、result、reasoning signature を書き換えない。
- コード本文、改行、空白、識別子、JSON Schema の意味を壊さない。
- prefix の変更が必要なら正しく変更し、cache epoch を更新する。

### 5.2 Prompt assembly

論理的には次の領域を区別する。ただし provider の rendered order を独自に仮定しない。

1. 安定した system policy/persona。
2. 安定した tool declarations。
3. session 内で不変の project instructions。
4. 過去の messages/tool results。
5. 最新の runtime context とユーザー入力。

timestamp、random ID、毎回の全ファイル一覧、全 git diff を system の先頭に埋め込まない。観測用 trace ID は prompt 外のローカル metadata に置く。cwd は必要な情報だが、既知のテンプレートで意味を保てる場合だけ runtime context へ移す。任意の system 文を user message に自動降格しない。[S9]

runtime context を末尾に置く場合も、既存 adapter の developer-change / runtime-context 機構を優先する。履歴中の system message は `context.ts` で user に変換される経路が確認できるため、単純な「system message を追加する」実装は避ける。[S6]

### 5.3 Tool catalog

- 登録順や非同期 MCP discovery の到着順に依存しない最終 catalog を生成する。
- 既存の順序が既に安定していれば追加の sort は不要。
- object key の canonicalization は schema を構築する境界で一度行う。
- 配列を無差別に sort しない。`enum`、`oneOf`、説明文、モデルに見せる順序には意味・挙動差があり得る。
- `required` 等も schema-aware な検証なしに変更しない。
- MCP reconnect 時は同一 schema なら同じ fingerprint にする。
- tool の削除、権限剥奪、schema 変更は即時反映する。古い宣言を cache のためだけに残さない。
- 巨大な全 MCP catalog を常に載せるのではなく、作業単位で小さく安定した toolset を選ぶ。

stable superset は token 増加と権限誤認のリスクがある。採用する場合は「宣言が見えても実行権限は別」を保証し、削除済みツールを呼んだときの安全な失敗をテストする。

### 5.4 履歴と project context

- append-only を原則とする。
- 過去のファイル読み取り結果を現在のファイル内容で置換しない。
- 新しい変更は新しい観測として末尾に追加する。
- RAG の再ランキングで過去の先頭 context を毎ターン入れ替えない。
- 大きなログ・生成物は最初の取得時から上限を設け、必要部分だけ取り込む。
- 正確性のため古い情報を削除する必要がある場合は、cache 維持より削除を優先する。
- `AGENTS.md` や組織ルール変更は検出し、ユーザーへ変更理由を示して epoch を切り替える。
- project ごとの cwd やコードを他 project と共有するための危険な cache-key 共通化はしない。

### 5.5 モデル・reasoning・route

同じ作業中は model と reasoning effort を安定させる。ただし必要な品質変更を妨げない。effective reasoning、thinking budget、tool choice、response format、endpoint、protocol、serializer version、account authority を route fingerprint に含める。

認証 token の値は fingerprint に含めない。通常の token refresh で同じ account/route が維持されるなら、理論上同じ cache scope の可能性がある。ただし in-flight request の credential snapshot は破棄して再解決する。account 切替と token refresh は別イベントとして扱う。

## 6. 観測と adapter 改良

### 6.1 二段階の観測点

**Logical observation:** 最終 assembly 後、`ctx.llm.stream()` に渡る入力を観測する。plugin からの診断に向く。

**Native observation:** provider serializer が作る payload と cache-affecting options を観測する。logical input が同じでも native payload が変わるケースを診断する。

native observer は provider の auth header や bearer token を記録しない。raw request をログへ丸ごと保存しない。hash は内容が推測可能な短い文字列の辞書攻撃を避けるため、process-local HMAC を基本とする。再起動をまたぐ比較が必要な場合だけ、ローカル秘密鍵を OS の保護機構で管理する。

wire JSON 全体の byte hash は診断用であり、provider の token prefix と同じではない。無関係な metadata や object key order の違いを cache miss の確定原因にしない。

### 6.2 提案データ契約

```ts
// Proposed internal contract, not an existing Harness API.
type CacheEvidence = {
  source: 'provider' | 'adapter' | 'local-diagnostic';
  reporting: 'known' | 'unknown' | 'unsupported';
  uncachedInput?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number; // subset of cacheWrite, never add twice
  rawUsagePresent: boolean;
  parserVersion: string;
};

type CacheAttempt = {
  attemptId: string;
  sessionId?: string;
  purpose: 'conversation' | 'compaction' | 'title' | 'warming' | 'direct';
  epoch: number;
  routeFingerprint: string;
  logicalFingerprint: string;
  nativeFingerprint?: string;
  startedAt: number;
  firstTokenAt?: number;
  finishedAt?: number;
  status: 'ok' | 'failed' | 'aborted' | 'unknown';
  evidence: CacheEvidence;
};
```

入力値は finite、非負、整数で検証する。矛盾した bucket を黙って clamp して成功扱いにしない。raw total と normalized total の差を診断する。失敗・abort で usage が得られなければ費用は unknown とし、無料としない。

### 6.3 TTL 別 write

`cacheWrite1h` は `cacheWrite` の部分集合として扱う。

- `W1h = cacheWrite1h`
- `W5m = cacheWrite - W1h` は両方が既知で、かつこの provider が 5m/1h の二分類であると確認した場合だけ計算する。
- split 不明の場合は `writeTier: unknown`。
- request に `long` を指定しただけで `W1h = W` と断定しない。

型、mapping、session persistence、token meter、UI、cost plugin の全経路で情報を落とさない。[S13]

## 7. Compaction / cold recovery

### 7.1 compact を禁止しない

巨大履歴の維持は cache read の累積費用、context 上限、品質劣化を招く。compact は必要な最適化である。短期の hit ratio 低下だけを理由に無効化しない。

既存 summarizer は元の system/tools/messages を replay して末尾へ指示を足す方針であり、これは cache reuse を意識した設計である。[S7]

### 7.2 改良点

1. 最後の成功 request の immutable snapshot を参照する。
2. provider/model だけでなく effective reasoning、thinking budget、replay state、cache-affecting tool choice を検証する。
3. compact 用に system persona を別のものへ置換しない。
4. tool execution を実行経路で禁止する。宣言の保持と実行許可を分離する。
5. `tool_choice=none` 等への変更が prefix に影響する route は、cache と安全性の両立を個別に評価する。
6. compact 完了後は epoch を増やし、旧 warming target を破棄する。
7. 次の実ユーザー request が新しい prefix を自然に warm にする。直後の無条件 prewarm は行わない。
8. compact が繰り返し失敗する場合、同じ巨大 request の無制限 retry をしない。

### 7.3 cold recovery の標準動作

- 期限切れが疑われても、通常は次の実要求をそのまま実行する。
- 一度 cold になったことを理由に keepalive を連打しない。
- UI は「cache 不明 / 再構築中の可能性」と表示し、根拠なしに warm を断言しない。
- cache をローカルへ保存して provider KV を復元することは、この gateway 経路では設計対象外。保存できるのは prompt snapshot と診断 metadata であり、provider の KV tensor ではない。
- cold cost が大きすぎる場合は、常時維持より、checkpoint と必要ファイル再取得で入力自体を小さくする。

## 8. Warming の詳細設計

### 8.1 デフォルト

`mode = observe-only`。Copilot route は、TTL・課金・native output cap が未確認なら自動 warming を禁止する。provider 名が `github-copilot` であるだけでは許可しない。

warmer の公開実装は opt-in、native route、推定 TTL、経済判定、version drift 時の fail closed を採用している。一方、公開 README 自身が live scheduled benefit を offline test で証明していないと明記している。これを実運用で効果保証済みの plugin と紹介してはいけない。[S18]

### 8.2 Admission 条件

以下をすべて満たす場合のみ候補にする。

- 明示的な per-model enable と per-session consent。
- 直近の genuine request が成功し、cache read の provider evidence がある。
- route/account/model/serializer がレビュー済みで一致する。
- TTL は公式仕様またはその route の制御試験に基づく planning assumption として登録済み。
- 現在の epoch と snapshot が一致する。
- 実リクエストが in-flight でない。
- 出力上限が server 側で有効と確認できる。client abort しかない場合は初期実装では非対応。
- attachments、billed tools、reasoning budget を安全に扱える。
- 単価・課金方式が既知。API-equivalent 価格だけでは quota 削減を断言しない。
- 期待純便益が閾値を超える。
- 予算予約に成功し、cooldown と回数上限を満たす。

未知・曖昧・バージョン不一致なら送信しない。

### 8.3 送信内容

最後の genuine request の cacheable prefix を native serializer 経由で保持し、必要な場合のみ短い keepalive suffix を追加する。巨大な履歴を独自の OpenAI-compatible request へ再構成しない。schema、reasoning、signature、tool choice を cache のために勝手に変更しない。

- 応答は transcript に追加しない。
- tool call は実行しない。
- title、memory、todo、subagent、workspace mutation を発火させない。
- 通常会話と別 purpose / accounting で記録する。
- SDK の自動 retry を禁止し、一度の失敗で自動継続しない。
- prefix を守るため安全制御を弱めない。両立しなければ unsupported。

### 8.4 State machine

`Disabled → Observing → Eligible → Scheduled → Warming → Observing`

例外状態: `UnknownEvidence`、`BudgetBlocked`、`UnsupportedRoute`、`Paused`、`Failed`。

`Eligible` は warm の保証ではない。`Warming` 完了後も cache read evidence がなければ成功表示しない。`lastAttemptAt` と `lastObservedCacheReadAt` を別々に保持する。

キャンセル条件:

- 新しい実ユーザー要求。
- compact、branch/epoch 変更、履歴編集。
- account/model/endpoint/serializer の変更。
- tool permission / policy 変更。
- plugin unload、process shutdown。
- idle deadline 到達、予算不足。
- suspend/resume 後の時刻飛び。

### 8.5 Scheduling

既知の推定 lifetime を `T`、安全余裕を `m` として、`lastRelevantRequestStart + T - m` 付近で一度だけ判定する。Anthropic 直接 API の文書は TTL を request start 基準としており、response 終了基準ではない。[S10]

ただしこの規則を Copilot の保証としない。TTL 未知なら timer を作らない。UI countdown は `estimated` と表示する。warm call はユーザー活動時間を延長しない。長い tool 実行を「ユーザーが継続する確率 100%」と自動判定しない。

Windows の sleep/resume では期限切れ timer をまとめて実行しない。resume 時は一旦 observe-only に戻し、新しい genuine request を待つ。multi-process では account/route/epoch ごとの lease を取り、二重 warming を防ぐ。

### 8.6 推奨初期制限（設計値）

以下は provider 仕様ではなく保守的な初期案。

- warming: 無効。
- 手動実験時の最大 warming: session 当たり 1 回。
- 自動 retry: 0。
- 新しい genuine request からの対象期間: 最大 15 分。
- 未知費用・usage 欠落: 次の warming を停止。
- 背景要求の同時実行: process 全体で 1。
- 予算上限: 利用者が明示設定するまで 0。
- subagent: 対象外。
- native output cap 未確認: 対象外。

「4 分ごとに全会話へ ping」は採用しない。

## 9. 経済モデル

### 9.1 基本式

`B = p × (C_cold_next - C_warm_next) - C_refresh - C_risk`

- `p`: refresh しないと失効する時間帯に、対象 prefix を使う実要求が来る確率。
- `C_cold_next`: その実要求が cold の場合の費用。
- `C_warm_next`: その実要求が warm の場合の費用。
- `C_refresh`: warming 自体の入力/cache read/write/出力/要求固定費。
- `C_risk`: 未計測生成、abort 後の課金、routing 変動等への保守的 reserve。

`B > minimumBenefit` のときだけ検討する。さらに hard budget を満たす必要がある。`p` は単なる「いつか再開する確率」ではなく、refresh によって cache 状態が変わる期間内の再開確率である。

複数 refresh の場合は `sum(C_refresh)` を含める。翌朝の再開のため一晩維持する設計は原則不採用。

### 9.2 料金計算

`C = (U×rU + R×rR + Wshort×rWs + Wlong×rWl + O×rO) / 1,000,000 + requestFee`

write rate を通常入力に加算するのではなく、provider の課金定義に従って bucket ごとに一度だけ計上する。長文 tier の閾値は、そのモデルの公式条件に従う。cached tokens を除外して tier 判定してよいと勝手に仮定しない。[S11][S12]

GitHub 公式文書は `1 AI credit = $0.01 USD` とするが、ローカル adapter の表示費用が組織の実請求と一致することは別途確認する。[S12]

### 9.3 価格例を固定しない理由

使用モデルが指定されていないため、本書では「Copilot なら 90% 割引」「1 時間 cache が必ず得」といった数値を固定しない。実験時に以下を保存する。

- model ID と long-context tier。
- 価格表の取得日。
- input/read/write/output の単価。
- quota/credits の観測方法。
- pricing source と effective date。
- unknown な費用の有無。

API-equivalent list price と actual billed credits は別の列にする。

## 10. 提案モジュール構成

DSH は Cordis plugin による構成を基本としているため、巨大な一枚岩の core patch より、公開 seam と小さな adapter 拡張を優先する。[S20]

### 10.1 提案コンポーネント

- `cache-observer`: logical/native fingerprint、usage、purpose、epoch、差分。
- `cache-prefix-policy`: 安定した assembly と schema canonicalization。
- `cache-capabilities`: route/model/protocol/serializer ごとの対応表。
- `cache-budget`: 予算予約、usage 確定、unknown reserve。
- `cache-warmer`: opt-in scheduler と隔離された native request。

これらは提案名。既存 package が存在すると主張するものではない。

### 10.2 最小 core/adapter patch

1. usage の provenance と optional TTL split を伝える。
2. native request の安全な診断 hook を追加する。
3. resolved cache-affecting options の immutable snapshot を提供する。
4. genuine/auxiliary/warming の purpose を伝播する。
5. warm-only call が tool execution と transcript mutation を起こさない隔離 seam を提供する。
6. compact に必要な effective options を引き渡す。

既存 plugin が private adapter internals を monkey patch するより、上流へ小さな公開 API として提案する。

### 10.3 提案設定例

```yaml
# Proposed schema only. Not an existing cordis.patch.yml contract.
cachePolicy:
  mode: observe-only
  capture: metadata
  prefix:
    canonicalizeToolSchemaObjects: true
    freezeSafetyPolicy: false
    freezeRuntimeContext: false
  warming:
    enabled: false
    requireSessionConsent: true
    requireProviderCacheEvidence: true
    requireVerifiedServerOutputCap: true
    unknownTtlAction: skip
    unknownPriceAction: skip
    maxAttemptsPerSession: 1
    maxConcurrent: 1
    retries: 0
    budgetUsd: 0
```

既存 `cacheRetention` は `llm-pi-ai` の provider profile に存在するが、`long` を書くだけで Copilot の 1 時間 cache が保証されるわけではない。[S3][S4]

## 11. 実験計画

### 11.1 Phase 0: ローカル baseline の固定

実装開始前にローカル checkout で記録する項目:

```bash
git rev-parse HEAD
git status --short
pnpm --version
node --version
pnpm list -r @deepseek-ai/dsh-llm-pi-ai @earendil-works/pi-ai
```

これらは利用者環境で実施する確認手順であり、本調査で実行済みではない。lockfile、profile、plugin versions、モデル ID、protocol、effective reasoning を添える。credential 値は記録しない。

公開 master のファイル履歴が混在しているため、ローカル commit で source path、型、関数名、package script を再確認する。

### 11.2 Phase 1: 観測のみ

同じ model/route、同じ toolset、同じ system で実作業を行い、以下を記録する。

- 直後の follow-up。
- 数分の tool 実行後の follow-up。
- idle 後の follow-up。
- compact 前後。
- MCP reconnect 前後。
- model/reasoning 変更前後。
- process restart 前後。

request を増やすためだけの benchmark は通常業務と分離し、明示予算で行う。

### 11.3 Phase 2: 安定化 A/B

A: baseline、B: schema/cwd 等の限定的な安定化。

- 同じ作業種別と入力サイズ帯で比較する。
- 各条件に異なるが同じ長さの synthetic prefix を使い、相互の cache contamination を避ける。
- 本番コードを不要に複製送信しない。
- 最初の cold call と follow-up を分けて報告する。
- 品質、総費用、TTFT を比較し、hit ratio だけで採否を決めない。

### 11.4 Phase 3: Copilot retention の制御試験

TTL は初めから既知としない。例として 1/3/5/10/20/40/60 分の idle gap を別 cohort で試す。これは試験点の提案であり TTL の主張ではない。

**同じ prefix を 1 分、3 分、5 分…と連続 probe すると、その probe 自体が refresh して自然失効を測れない。** 各 gap に独立した prefix を割り当て、seed request の後は probe 時刻まで触らない。

route、account、model、reasoning、serializer を固定し、各 gap で複数回の独立試験を行う。zero hit は expiry の確定証拠ではなく routing/eviction の可能性を含む。最短の観測失効時間をそのまま SLA にしない。

### 11.5 Phase 4: warming の小規模試験

- A: warming なし。
- B: 1 回だけ warming。
- 次の genuine request の時刻を揃える。
- B の refresh 費用を必ず加算する。
- native payload の prefix alignment を確認する。
- cache evidence と実 credits を比較する。
- warm response が履歴・tool・memory を変更していないことを検証する。

改善が再現しなければ自動 warming を導入しない。

## 12. テストと受け入れ条件

### 12.1 Unit / property tests

- 同じ logical input から同じ fingerprint を生成する。
- schema object key の登録順だけが異なる場合は同じ canonical schema になる。
- 配列順・説明文・コード空白を勝手に変更しない。
- timestamp/trace metadata の変化が prompt に漏れない。
- `cacheRead=0`、field 欠落、raw usage 欠落を区別する。
- `cacheWrite1h <= cacheWrite` を検証する。
- weighted ratio、N/A、coverage を検証する。
- negative、NaN、Infinity、過大値を拒否する。
- compact、model、account、policy 変更で旧 target を無効化する。
- token refresh で credential を漏らさない。

### 12.2 Integration tests

- 実際に解決された pi-ai serializer を loopback endpoint で使う。
- fake serializer だけで output cap を保証したことにしない。
- original request と warm request の cache-affecting prefix を比較する。
- reasoning/signature/tool result replay を保持する。
- tools が生成されても実行しない。
- transcript、memory、title、subagent を変更しない。
- retryable error でも background retry しない。
- stream stall、abort、unknown usage を費用ゼロにしない。
- sleep/resume、二重 process、plugin unload を試験する。
- Windows の ACL と機密 snapshot 削除を検証する。

### 12.3 受け入れ条件

**P0 観測:** provider evidence と local diagnosis を区別し、未知をゼロにしない。通常会話の payload を変えない。

**P1 安定化:** semantic regression なし。cache を壊す不要な変動が減り、総費用または TTFT が改善する。

**P2 compact:** effective options を保持し、compact 後の epoch と warming cancellation が正しい。

**P3 warming:** exact route で cache reuse と総費用改善を実測。出力上限・予算・隔離を確認。未確認 route は fail closed。

数値目標は baseline 後に決める。事前に「常時 95% 以上」を保証しない。

## 13. セキュリティ・運用

- metadata-only を標準とする。
- raw prompt capture は明示 opt-in、短い retention、容量上限付き。
- POSIX `0600/0700` の記載だけで Windows のアクセス制御を保証しない。ユーザー SID に限定した ACL を検証する。
- snapshot にソースコード、内部パス、tool schema、秘密情報が入り得る。
- credentials を snapshot、fingerprint、例外、telemetry へ含めない。
- cache diagnostics を外部 telemetry へ送信しない。
- dashboard は loopback を基本とするが、loopback は他の local process に対する認証境界ではない。[S8]
- plugin はタグまたは commit を固定し、install/build script と依存をレビューする。
- tool 権限変更、安全ルール変更、削除要求は cache より優先する。
- background warming は追加の外部データ送信である。組織の利用規定と許可範囲を確認する。

## 14. 実装ロードマップ

### PR 1: usage と evidence の正確化

`stream.ts` / usage 型 / persistence / token meter の情報経路を確認し、provenance と TTL split を追加。既存ログを壊さない optional field と migration test を用意する。

### PR 2: cache diagnostics

purpose、epoch、route fingerprint、logical diff、必要に応じ native diagnostic hook。metadata-only で導入する。

### PR 3: prefix stability

既存の deterministic tool order を確認したうえで、schema object canonicalization と既知の動的 persona 情報の配置を改善。汎用 system-to-user 移動はしない。

### PR 4: compaction replay

effective reasoning/options の引き継ぎ、epoch、旧 warming target 破棄。local endpoint の報告を regression test 化する。

### PR 5: capability-gated warming

observe-only から開始。native serializer version gate、予算予約、single-flight、同意、隔離、Windows lifecycle 対応を実装する。

### PR 6: Copilot live validation

明示予算のもとでモデル別に試験し、対応表へ evidence date と条件を記載する。成功したモデルの結果を他モデルへ一般化しない。

## 15. 今すぐ採用する運用ルール

1. 同じ作業では同じ model/reasoning/toolset を使う。
2. 作業途中の不要な plugin enable/disable、MCP catalog 再構成を避ける。
3. system 先頭へ毎回変わる timestamp、git status、全 diff を挿入しない。
4. 大量ログを最初から取り込まない。必要部分を限定する。
5. 累積 hit ratio ではなく最新 call の usage を確認する。
6. compact を禁止しない。作業の区切りで適切に実行する。
7. idle が長い場合は checkpoint を残し、無理に warm を維持しない。
8. cacheScope 相当の観測を先に入れ、改善を一つずつ比較する。
9. cacheRetention long や warmer を未検証のまま本番有効化しない。
10. 最終判断は「作業完了までの総 credits・待ち時間・品質」で行う。

## 16. 未解決事項

- ローカル DSH commit と resolved pi-ai version。
- 実際の Copilot model ID / native protocol。
- raw usage が cache read/write と TTL split を返すか。
- Copilot route で `cacheRetention: long` が実効性を持つか。
- Copilot の route/account 単位の cache scope と retention。
- warm-only request の server output cap と reasoning 課金。
- 実 AI credits と adapter 推定費用の整合。
- 現行版で compact reasoning の問題が残っているか。
- plugin の現行ローカル版互換性。

これらを解決するまでは「自動 warming が最適」と結論しない。**現時点の推奨は、観測と prefix 安定化を先に実装し、warming は条件付きの実験機能に留めることである。**

## 17. 参照資料

リンクは調査時に確認した公開資料。master/main は更新されるため、実装時にはローカル baseline に対応する commit permalink へ固定する。

- [S1: DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness)
- [S2: dsh-llm-github-copilot](https://github.com/lujianjun19/dsh-llm-github-copilot)
- [S3: llm-pi-ai README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-pi-ai/README.md)
- [S4: llm-pi-ai config.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-pi-ai/src/config.ts)
- [S5: llm-pi-ai stream.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-pi-ai/src/stream.ts)
- [S6: llm-pi-ai context.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-pi-ai/src/context.ts)
- [S7: compaction summarizer.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction-basic/src/summarizer.ts)
- [S8: dsh-cachescope](https://github.com/kober-basket/dsh-cachescope)
- [S9: dsh-cache-stabilizer](https://github.com/dongsheng123132/dsh-cache-stabilizer)
- [S10: Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [S11: OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [S12: GitHub Copilot models and pricing](https://docs.github.com/ja/copilot/reference/copilot-billing/models-and-pricing)
- [S13: Discussion #9225, cacheWrite1h mapping](https://github.com/deepseek-ai/deepseek-harness/discussions/9225)
- [S14: Discussion #7794, compaction reasoning/cache](https://github.com/deepseek-ai/deepseek-harness/discussions/7794)
- [S15: Discussion #8190, gateway cache-write accounting](https://github.com/deepseek-ai/deepseek-harness/discussions/8190)
- [S16: Discussion #9091, cache-hit UI semantics](https://github.com/deepseek-ai/deepseek-harness/discussions/9091)
- [S17: dsh-prompt-freeze](https://github.com/lemonel/dsh-prompt-freeze)
- [S18: dsh-cache-warmer](https://github.com/yoggu/dsh-cache-warmer)
- [S19: deep-seek-cache-plugin](https://github.com/theworld-lab/deep-seek-cache-plugin)
- [S20: DSH architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [S21: llm-pi-ai adapter.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-pi-ai/src/adapter.ts)

---
End of design document.
