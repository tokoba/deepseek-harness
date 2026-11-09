# cordis.patch.yml 設定リファレンス (desktop プロファイル)

対象ファイル: `C:\Users\tokob\.dsh\profiles\desktop\cordis.patch.yml`

このファイルは dsh プロファイルのパッチ層である。全バンドル層の後に適用される YAML 配列で、各要素は `id` で既存プラグインを指定して `config` を上書きするか、`insert` でプラグインを追加する。`!!js` を付けた値は読み込み時に JavaScript 式として評価される。変更はアプリの再起動後に反映される。

## 1. ui-chat (`@deepseek-ai/dsh-client-ui-chat`)

| キー | 現在値 | 意味 |
|---|---|---|
| `transcriptView` | `detailed` | 会話表示の詳細度。`detailed` はツール呼び出しや推理ブロックを展開して表示する |
| `performanceUsage` | `detailed` | ターン/ステップごとのトークン使用量 (input / cache read / cache write / output) と所要時間の表示詳細度 |

## 2. ui-settings (`@deepseek-ai/dsh-client-ui-settings`)

| キー | 現在値 | 意味 |
|---|---|---|
| `enabled` | `true` | 設定画面を有効にする |

## 3. ui-settings-account (`@deepseek-ai/dsh-client-ui-settings-account`)

初回セットアップ (オンボーディング) の状態と表示設定。

| キー | 現在値 | 意味 |
|---|---|---|
| `version` | `1` | オンボーディング状態の形式バージョン |
| `step` | `done` | オンボーディングの進行段階。`done` で完了済み |
| `usage` | `detailed` | 使用量表示の詳細度 |
| `developerTools` | `true` | 開発者向けツール (統計など) を表示する |
| `purpose` | `null` | 利用目的 (development / office / both)。未選択 |
| `process` | `standard` | 作業プロセスの既定スタイル |
| `completion` | `api-key` | セットアップを完了した方法 |

## 4. llm-pi-ai (`@deepseek-ai/dsh-llm-pi-ai`)

pi-ai 経由の LLM プロバイダルート。`providers` の各キーがルート名で、`github-copilot` は pi-ai 同梱の GitHub Copilot カタログ (エンドポイント・モデル一覧・プロトコル) を既定値として使う。認証は `@lujianjun19/dsh-llm-github-copilot` がログイン時に保存したクレデンシャルを使う。

### 4.1 `providers.github-copilot.cacheRetention`

| 値 | 意味 |
|---|---|
| `none` | プロンプトキャッシュ指定を送らない |
| `short` (既定) | Claude は 5 分 TTL の `cache_control`。GPT 系は `prompt_cache_key` のみ |
| `long` (現在値) | Claude は `cache_control.ttl: "1h"` (1 時間保持、書き込み単価は入力の 2.0 倍)。GPT 系は `prompt_cache_retention: "24h"` |

5 分以上の中断が 1 回でもある対話セッションでは `long` の方が安い (詳細は [docs/feat/cache-hit-ratio-improvement.md](docs/feat/cache-hit-ratio-improvement.md) §3.3)。Copilot が 1 時間指定を拒否するとリクエストが 400 で失敗するので、その場合は `short` に戻す。

### 4.2 `providers.github-copilot.cacheWarmer`

プロンプトキャッシュの keepalive。会話の主リクエスト完了後、そのリクエストをメモリに保持し、キャッシュ TTL 失効の直前に出力上限だけを下げて同一内容を再送する。対象は `anthropic-messages` (Claude 系) モデルのみ。セクションを省略すると無効。設定する場合は 5 項目すべてが必須。

| キー | 現在値 | 意味 |
|---|---|---|
| `maxPingsPerIdle` | `2` | 2 つの実リクエストの間 (1 回のアイドル) に送る ping の上限 (1 以上)。モデル単価の損益分岐回数 `floor((cacheWrite - cacheRead) / cacheRead)` (opus-5.5 では 24) の方が小さければそちらが上限になる。`long` と組み合わせると 2 回で約 3 時間のアイドルを保護する |
| `dailyCreditBudget` | `50` | 全 ping で 1 日 (ローカル日付) に使ってよい推定 AI Credits (1 credit = 0.01 USD)。超える ping は送らずそのセッションの keepalive を止める |
| `minPrefixTokens` | `30000` | keepalive する最小プレフィックス長 (input + cache read + cache write トークン)。小さい会話は cold 化しても損失が小さいので温めない |
| `marginMs` | `60000` | TTL 失効の何ミリ秒前に ping を送るか。TTL は送信時刻起点 (`short` 5 分 / `long` 60 分) |
| `pingMaxTokens` | `16` | ping リクエストの出力上限トークン数 (1 以上)。出力は破棄されるので小さくする。thinking の制約でエラーになる場合のみ増やす |

動作上の規則:

- 同じセッションで新しいリクエストが始まると、保留中・送信中の ping は取り消される。次の主リクエスト完了時に再設定される。
- compaction・タイトル生成など `purpose` 付きのリクエストは ping の対象にしない。
- ping が失敗するとそのセッションの keepalive は次の主リクエストまで停止する。
- ping の応答はセッションログに記録されない。ログに `llm-pi-ai cache warmer: ping on ...` が info で出る。
- ping は課金リクエストである。止めるにはセクションを削除して再起動する。

### 4.3 `providers.github-copilot.modelOverrides`

同梱カタログのモデル定義をモデル単位で上書きする。キーはモデル ID。

| キー | 意味 |
|---|---|
| `claude-sonnet-5.5.reasoningEfforts` | 選択可能な思考レベルと、その送信値。現在値は `low` / `medium` / `high` / `xhigh` / `max`。`off` を列挙しないことで「思考オフ」を選択不可にする |

上書きの理由: 同梱カタログ (pi-ai 1.3.0) の claude-sonnet-5.5 は `off: null` 指定が欠けている。そのため effort 未選択時に `thinking: {type: "disabled"}` が送られ、Copilot が `400 To turn thinking off on this model, send "thinking": {"type": "between_tools"}` で拒否する。上書き後は effort 未選択時に thinking パラメータ自体を送らず、モデル既定の adaptive thinking で動く。

## 5. agent-default-model (`@deepseek-ai/dsh-agent-default-model`)

新規セッションの既定モデル。

| キー | 現在値 | 意味 |
|---|---|---|
| `provider` | `github-copilot` | 既定のプロバイダルート (`llm-pi-ai.providers` のキー) |
| `model` | `claude-opus-5.5` | 既定のモデル ID |

セッション途中のモデル切替はキャッシュ空間が変わり、次のリクエストで履歴全体が再書き込みになる。モデルを試すときは新しいセッションで行う。

## 6. ui-theme (`@deepseek-ai/dsh-client-ui-theme`)

| キー | 現在値 | 意味 |
|---|---|---|
| `preference` | `dark` | 配色 (`light` / `dark` / システム追従) |
| `fontSize` | `12` | 本文のフォントサイズ (px) |
| `terminalFontSize` | `11` | ターミナルのフォントサイズ (px) |
| `textFontFamily` | `"HackGen Console"` | 本文フォント (CSS font-family) |
| `codeFontFamily` | `"HackGen Console"` | コード表示フォント |
| `terminalFontFamily` | `"HackGen Console"` | ターミナルフォント |

## 7. insert: mcp-shimai (`@deepseek-ai/dsh-mcp-client`)

MCP サーバー shimai を追加する。追加されたツール (`mcp__shimai__*`) はリクエストのツール定義に入るため、セッション途中で追加・削除するとツール層からキャッシュが無効になる。

| キー | 現在値 | 意味 |
|---|---|---|
| `serverName` | `shimai` | サーバー名。ツール名の接頭辞 `mcp__shimai__` になる |
| `transport` | `stdio` | 子プロセスの標準入出力で通信する |
| `command` | `shimai-mcp-v2.exe` | 起動する実行ファイル (PATH から解決) |
| `args` | `[]` | 起動引数 |
| `env.OPENAI_COMPAT_API_KEY` | `!!js process.env.OPENAI_COMPAT_API_KEY` | shimai が使う OpenAI 互換 API キー。dsh 起動時の環境変数から渡す |
| `env.OPENAI_COMPAT_BASE_URL_V2` | `!!js process.env.OPENAI_COMPAT_BASE_URL_V2` | 同 API のベース URL |
| `env.SHIMAI_LOG_DIR` | `.log` | shimai のログ出力ディレクトリ (プロファイル相対) |
| `env.SHIMAI_LOG_FILE_ONLY` | `'true'` | ログをファイルのみに出す (stdio を汚さない) |
| `env.SHIMAI_LOG_TO_FILE` | `'true'` | ファイルログを有効にする |

## 8. session-log-deepseek

| キー | 現在値 | 意味 |
|---|---|---|
| `enabled` | `false` | セッションログの DeepSeek へのアップロードを無効にする |

## キャッシュ状況の確認

```
node docs/feat/cache-hit/cache-report.mjs --ttl-min 60
node docs/feat/cache-hit/cache-report.mjs <sessionId先頭> --ttl-min 60 --detail
node docs/feat/cache-hit/cache-report.mjs --ttl-min 60 --root /c/Users/tokob/.dsh/sessions   # 別ユーザーのシェルから実行する場合
```

セッションログからリクエストごとの cache read / write を集計し、cold 化の原因 (ttl-expired / after-compaction / model-changed など) を表示する。
