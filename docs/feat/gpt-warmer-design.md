# GPT 向け cache warmer 設計

GitHub Copilot 経由で GPT-6.1 Sol を使うときのプロンプトキャッシュ維持（warmer 拡張）の設計案です。Claude 向け warmer（[cache-hit-ratio-improvement.md](cache-hit-ratio-improvement.md)）の続きにあたります。Gemini は対象外とし、その理由も記録します。

## 1. 背景

2026-11-10 の cache-report で、`gpt-6.1-sol` のセッション（2bd8217a）に TTL 切れの cold が 2 件出ました。

| 時刻 (UTC) | 間隔 | 書き込み |
|---|---|---|
| 2026-11-10T14:30:35Z | 4,123 秒（69 分） | 428,894 |
| 2026-11-10T21:50:18Z | 26,184 秒（7.3 時間） | 439,600 |

Claude のセッションは、同じ程度の離席でも warmer によってキャッシュが維持されています。

## 2. 現状の実装で GPT が維持されない理由（コードで確認済み）

### 2.1 warmer の対象外

[cache-warmer.ts](../../packages/llm/llm-pi-ai/src/cache-warmer.ts) の `cacheTtlMs` は、`model.api !== 'anthropic-messages'` のとき `undefined` を返します。GPT のリクエストでは ping がスケジュールされません。つまり 2 件の cold は「ping に失敗した」ものではなく、「ping が送られていない」ものです。

### 2.2 `cacheRetention: long` が GPT-5.6 以降向けのパラメータにならない

pi-ai 1.3.0 の `dist/providers/openai-responses.js` の変換は次のとおりです。

| compat | 送られるパラメータ |
|---|---|
| `supportsExplicitPromptCacheMode: false`（既定） | `prompt_cache_retention: "24h"`（GPT-5.5 以前の指定） |
| `supportsExplicitPromptCacheMode: true` | `prompt_cache_options: { ttl: "30m" }` |
| — | `prompt_cache_key` = sessionId（64 文字に切り詰め。`cacheRetention: none` のときは付かない） |

- 既定では GPT-5.6 以降向けの `prompt_cache_options` が付きません。代わりに旧世代向けの `"24h"` 指定が送られます。Copilot がこれを無視するのか、受け付けるのかは確認できていません。
- `long` を指定しても、pi-ai が送るのは `"30m"` だけです。`"12h"` を送る経路はありません。
- `prompt_cache_key` は `openai-responses` 経路では URL に関係なく送られます（`api.openai.com` 限定になっているのは openai-completions 経路だけです）。Copilot がこの key を上流に渡しているかは確認できていません。
- 前提として、gpt-6.1-sol の `api` は `openai-responses` と推定しています。セッションログは zstd 圧縮のため、まだ確認していません。

## 3. 各社のキャッシュ保持仕様（公式文書と二次情報。Copilot 経由で効くかは確認していない）

### 3.1 GPT（GPT-5.6 以降。GPT-6.1 Sol を含む）

| 項目 | 内容 |
|---|---|
| TTL の指定 | `prompt_cache_options.ttl`：`"30m"`（既定）／`"12h"`（Responses API のみ。2026-10-20 に追加） |
| TTL の起点 | 書き込み、**または読み取り**から少なくとも 30 分。読み取りで期限が延びる |
| 単価（入力比） | 読み取り 0.1 倍、30m 書き込み 1.25 倍、12h 書き込み 2.5 倍 |
| GPT-6.1 Sol（$/1M） | 入力 2.00、読み取り 0.10、30m 書き込み 2.50、12h 書き込み 5.00 |
| breakpoint | implicit モードでは、最新の user / tool メッセージの末尾に自動で置かれる |
| ルーティング | `prompt_cache_key` を固定すると当たりやすい（同じ key は毎分 15 回程度まで） |
| 12h の注意 | 30m で有効なキャッシュを 12h に切り替えると、全体を 12h 単価で書き直す。12h のエントリを 30m 設定で読んでも 12h の時計は戻らない |

69 分の cold は、TTL 30 分の仕様と整合します。ただしプレフィックスの変更などでも cold は起きるので、この 2 件だけで TTL 切れとは断定できません。

GitHub の使用量ガイドには「OpenAI モデルは 24 時間」という一般的な説明がありますが、GPT-5.6 以降の 30 分仕様とは食い違います。設計では 30 分を前提にします。

### 3.2 Gemini（Gemini 4 Argon）：対象外

| 項目 | 内容 |
|---|---|
| 方式 | 暗黙キャッシュのみ。明示キャッシュ（`cachedContents`）は Gemini 4 Argon 以降では使えない |
| TTL | 指定できない。追い出しは容量次第。耐久層は作成から最長 24 時間 |
| 小さい追加 | 追加が 2,050 トークン未満だと、前回リクエストの末尾 2,050 トークンを通常単価で処理し直す |
| Copilot の単価（$/1M） | 入力 2、キャッシュ 0.10。書き込み料金はない |

- 期限を前提にした「失効の直前に送る」という考え方が成り立ちません。
- 書き込み料金がないので、現在の損益分岐の式 `(cacheWrite − cacheRead) / cacheRead` が使えません。
- Copilot から明示キャッシュの TTL を延長する手段（`caches.update`）はありません。

まずは cachedContentTokenCount（cache read）を記録し、ヒット率を実測します。warmer の対象にはしません。

## 4. 損益の試算（43 万トークンの会話、GPT-6.1 Sol、TTL 30 分）

| 項目 | 金額 |
|---|---|
| ping 1 回（全体を読み取り） | 約 $0.043 ≈ 4.3 credits |
| cold での書き直し（30m 書き込み） | 約 $1.075 ≈ 107.5 credits |
| 損益分岐 | (2.50 − 0.10) / 0.10 = 24 回 |
| 7.3 時間守る場合 | 約 29 分ごとに 15 回 ≈ 64 credits |

- 現在の `breakEvenPings` は丸めてから floor をとるので、24 になります（浮動小数で 23 になる問題は対策済み）。
- 12h 方式は 1 回の書き込みで長時間を守れます。ただし毎ターンの書き込み単価が 2 倍になり、会話の途中で切り替えると全体の書き直し（約 215 credits）が発生します。初期実装では採用しません。

## 5. 実装方針

### 5.1 TTL 戦略をプロトコル単位で持つ

`cacheTtlMs` を、プロトコルごとの戦略テーブルに置き換えます。

| 項目 | anthropic-messages | openai-responses（GPT-5.6 以降） |
|---|---|---|
| ttlMs | short 5 分／long 60 分 | 30 分 |
| TTL の起点 | 送信時刻 | 最後の読み取り、または書き込みの完了時刻 |
| 損益分岐の書き込み単価 | `cost.cacheWrite` | `cost.cacheWrite`（30m 単価） |
| ping 成功の判定 | cache read ≈ プレフィックス、cache write ≈ 0 | `cached_tokens` ≈ プレフィックス、cache write ≈ 0 |
| 対象の条件 | 現状どおり | `cacheRetention !== 'none'`、`prompt_cache_key` を送っていること |

- 対象モデルは名前ではなく、`api` と compat で判定します。GPT-5.5 以前（`prompt_cache_retention` 世代）は、まず対象外にします。
- GPT 用の TTL は設定可能な値（`ttlMs`）にし、既定値 30 分の根拠を README に書きます（固定値をハードコードしないという規約に従う）。
- 損益分岐の式は共通です。`cacheWrite` が未定義か 0 のモデル（Gemini）は 0 回、つまり対象外になります。これは現在の実装でも同じ動作です。

### 5.2 ping の送り方

- 直前のリクエストと同じ入力・tools・reasoning effort・verbosity・service tier・`prompt_cache_key` で送ります。
- 変えてよいのは出力上限だけです。reasoning トークンも出力上限に含まれるため、`pingMaxTokens: 16` で reasoning が打ち切られるのか、それとも 400 エラーになるのかを先に検証します。サーバー側で出力上限を強制できない経路では、ping を送りません。
- ping が成功したら、TTL の起点をその完了時刻に更新します（読み取りで期限が延びる仕様に合わせる）。
- 書き込みが出たら、その時点で keepalive を止めます。現在の「失敗 1 回で停止」も、そのまま使います。

### 5.3 予算と回数

- 30 分間隔では、`maxPingsPerIdle: 16` で約 8 時間を守れます。7.3 時間の例は収まります。
- 1 日の上限 `dailyCreditBudget`（現在 2000）は Claude と共通の枠で使います。GPT の 43 万トークンの会話は 1 回 4.3 credits なので、15 回で約 64 credits です。
- 将来の候補：最後の実リクエストからの最大保護時間（`maxIdleDuration`）を設けること、再開の確率を入れた損益判定にすること。

### 5.4 ログ

ping ごとに、次を記録します（本文と認証情報は記録しない）。

```
session / model / api / strategy / ttlMs
ping scheduled / sent / completed
cachedTokens / cacheWriteTokens / input / output / reasoning
estimated credits / stop reason（対象外・予算・miss・コンテキスト変更など）
```

cache-report には、GPT の cold が warmer の対象外だったのか、ping に失敗したのかを区別して表示できるようにします。

## 6. 実装前の検証（必須）

小さい合成コンテキスト（30k トークン程度）を使い、GPT-6.1 Sol を Copilot 経由で呼んで確かめます。

1. **既定の送信内容**：HTTP body に `prompt_cache_retention: "24h"` と `prompt_cache_key` が含まれるか。Copilot が 400 を返さないか。
2. **30 分 TTL**：35 分空けたあとの再送が cold になるか（書き込みが出るか）。
3. **ping による延長**：20 分後に出力上限だけを下げた ping を送り、さらに 20 分後の本番リクエストで `cached_tokens` が維持されるか。
4. **出力上限**：`max_output_tokens: 16` と reasoning effort の組み合わせが、エラーにならず短く終わるか。
5. **`prompt_cache_options`**：compat に `supportsExplicitPromptCacheMode: true` を設定したとき、`{ttl:"30m"}` が受け付けられるか。`{ttl:"12h"}` は無視されるか、エラーになるか、効くか（書き込みトークン数で判断）。
6. **usage のフィールド**：Copilot の応答が `cached_tokens` と書き込みトークン数を返すか。返さない場合、ping の成功を判定できないので実装を止めます。

1〜3 と 6 が確認できたら、5.1〜5.4 を実装します。どれかが成り立たなければ、GPT は「compact してから離席する」運用で対処します。

## 6.1 検証結果（2026-11-11、[gpt-cache-probe.mjs](cache-hit/gpt-cache-probe.mjs) quick、約 27.6k トークン）

`api.business.githubcopilot.com/responses` に直接送信しました（Copilot Business、proxy 経由）。gpt-6.1-sol の `api` が `openai-responses` であることは、pi-ai の `github-copilot.json` で確認しました。

| # | 送信内容 | 結果 |
|---|---|---|
| 1, 6 | `prompt_cache_retention:"24h"` + `prompt_cache_key`（pi-ai の既定と同じ） | HTTP 200。1 回目 `cache_write_tokens` 27,621、2 回目 `cached_tokens` 27,621 / write 0。usage は `input_tokens_details.cache_write_tokens` と `cached_tokens` で判定できる |
| 1 | retention 指定なし | 同じ挙動。応答には `prompt_cache_retention:"24h"` が返る（Copilot 側の既定値の表示） |
| 5 | `prompt_cache_options:{ttl:"30m"}`（**pi-ai が compat 有効時に送る形**） | **HTTP 400**：`Supported values are: 'implicit' and 'explicit'`。`mode` が必須 |
| 5 | `prompt_cache_options:{mode:"implicit",ttl:"30m"}` | 200。`cache_write_tokens_details.ttl_30m_tokens` 27,601 |
| 5 | `prompt_cache_options:{mode:"implicit",ttl:"12h"}` | **200。`ttl_12h_tokens` 27,609。12h が Copilot 経由で有効**。2 回目は read |
| 4 | `max_output_tokens:16`、reasoning effort low | 200、`status=completed`、read 27,576 / write 0 |

分かったこと：
- `prompt_cache_key` と usage の書き込み／読み取りトークン数は Copilot 経由で使える。warmer の成功判定ができる。
- compat に `supportsExplicitPromptCacheMode: true` を設定すると、pi-ai 1.3.0 は `mode` なしの `{ttl:"30m"}` を送るため 400 になる。この compat は設定しないこと。12h を使うには、`onPayload` などで `{mode:"implicit", ttl:"12h"}` を付ける必要がある。
- 12h 方式（5.3 の書き込み 2 倍単価と引き換え）が選択肢として現実的になった。

30 分 TTL と ping による延長（検証 2, 3）の結果は 6.2 に記録します。

## 6.2 検証結果（timed、2026-11-11 07:16〜07:56 JST）

| 会話 | 送信 | 40 分後の結果 |
|---|---|---|
| X | 既定（30m）で書き込み、20 分後に `max_output_tokens:16` の ping | read 27,595 / write 0（**ping で延長された**） |
| Y | 既定（30m）で書き込み、ping なし | write 27,604（**30 分 TTL で失効**） |
| Z | `{mode:"implicit",ttl:"12h"}` で書き込み、ping なし | read 27,597 / write 0（**12h で保持**） |

Copilot 経由の GPT-6.1 Sol は公式どおり 30 分 TTL で、読み取りで期限が延びます。12h 指定も有効です。

## 6.3 採用した対応

`llm-pi-ai` のルート設定に `openaiPromptCacheTtl`（`30m` / `12h`）を追加しました。`openai-responses` のリクエストで `prompt_cache_retention` を外し、`prompt_cache_options: {mode:"implicit", ttl}` を付けます。プロファイルでは `github-copilot` に `openaiPromptCacheTtl: 12h` を設定し、GPT の warmer は実装しません（12 時間以内の離席は ping なしで保持される）。書き込み単価は 30m の 2 倍（GPT-6.1 Sol で $5/1M、272k トークン超は $10/1M）になります。

## 7. 未確認事項

- 12h の実際の保持時間（数時間空けた再送で確認が必要）。
- 公開プラグイン `dsh-cache-warmer`（プロトコルの能力に基づいて判定し、TTL は利用者が推定値を設定する方式）を採用するかどうか。採用するなら、自前の warmer と二重に動かないよう、どちらか一方にします。
