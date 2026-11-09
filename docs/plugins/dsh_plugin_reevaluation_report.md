# DeepSeek Harness プラグイン 再評価レポート（添付文書の精査 + GitHub 本流・安全性の再調査）

- 調査基準日: 2026-11-10 前後（各リポジトリ／カタログの表示時点。スター数・版は日々変動）
- 対象: 添付 `plugins-gemini.md`（3本のレポートを連結した文書）と、前回の `dsh_plugin_research_report.md`
- 方針: ①文書内の主張を一次情報（作者の GitHub、公式 `deepseek-ai/deepseek-harness`）と突き合わせる ②公式に既にある機能と重複するものを除く ③安全性（実行権限・外部送信・保守状況・名称衝突）で再採点する
- 限界: 私は実際にインストール・実行していません。「確認済み」は"公開ページで確認できた"の意味です。Reddit / Medium の個別評価は今回も有意な材料が得られず、判断根拠にしていません。

---

## 1. 結論（最も有用な部分だけ）

### 1.1 添付文書のうち使える部分

| 文書（連結順） | 使える点 | 使えない／要注意な点 |
|---|---|---|
| ① Gemini 版 | 領域別の整理（設計／開発／調査／テスト／記憶）という切り口 | 事実誤認・未検証が多い（§2）。特に `dsh-browser`（ログイン維持と説明）、`Squeeze`（"セマンティックチャンキング"と説明）、`dsh-budget`（"標準セキュリティパック"と説明）、Archify の★数 |
| ② `dsh-mcp` 中心版 | 「観測→MCP→開発支援→画像→並列化」の段階導入、キャッシュ影響を測る手順 | `dsh-undo-plugin` の機能説明が実体と違う、`dsh-at-file` は公式機能に統合済み、`dsh-sentinel` は同名の別物（セキュリティスキャナ）が実在、`dsh-mcp` は同名多数で特定不能 |
| ③ `dsh-context` 中心版（2026-11-10 付） | **最も慎重**。「作者の主張」と「判断」を分離、限界を明記、段階導入と測定項目あり。`dsh-context` / `cc-safety-net` / `Aegis` / `ModSearch` / `dsh-mnemon` / `dsh-agent-teams` はいずれも一次情報で実在・活発を確認 | `ModLens` の外部送信、`dsh-docs` の日本語 OCR 等は未確認のまま。公式の実験機能（auto-review 等）への言及が無い |
| 前回レポート（私） | 網羅性、セキュリティ節 | 後述の修正点あり（§6） |

→ **③を土台にし、②の段階導入手順を取り込み、①は項目単位で再検証した上で採否を決める**のが最も有用です。

### 1.2 再評価後の最終推奨（優先順）

| 順 | 何を | 具体名 | 判定理由（要約） |
|---|---|---|---|
| 0 | 公式機能を先に使う | `Workspace Write` 権限プリセット、公式 experimental の auto-review / schedule / agent-team / session-search / worktree、組込み `@file` `@session`、公式 MCP クライアント、公式 LSP | コミュニティ製と重複する機能が公式に入っている。信頼境界を増やさない |
| 1 | 観測 | `dsh-context`（bowenliang123） | 4.7k★・Apache-2.0・1,376 コミット・数十分前にも更新。観測専用で副作用が小さい |
| 1 | 実行前ガード | `cc-safety-net`（kenryu42） | DeepSeek Harness を明示対応、Windows 対応、1,984 コミット、v2.7.8。**サンドボックスではない**と自ら明記 |
| 1 | 変更の巻き戻し | `dsh-turn-rewind`（Anionex）または `dsh-rewind`（sirilee） | ファイル状態も戻せる。※添付②が推す `dsh-undo-plugin` は用途が違う（§3.4） |
| 2 | 開発規律 | `Aegis`（GanyuanRan）**または** Superpowers 系のどちらか1つ | 1.4k★・v2.15.0 (11/4)・SECURITY.md・CODEOWNERS あり。Windows のフック起動器を 2.15.0 で硬化済み |
| 2 | 並列化 | `dsh-agent-teams`（NanmiCoder） | 2.7k★、最新 0.2.2 での検証を継続。ただし dsh-xray は C3（強い権限＋敏感動作）判定 |
| 3 | 画像 | `ModLens`（liustack） | 4.9k★・v3.27.2。ただし**画像が外部の視覚エンジンへ送られる**。送信先を限定して使う |
| 3 | 記憶 | `dsh-mnemon`（omdsh-dev） | 945★・1,934 コミット・DSH 0.2.2-rc.1 検証記載。**ローカルのみ・自動レビュー無効**から開始 |

### 1.3 見送る／後回し

- `dsh-our-free-model`、`dsh-budget`（作者が FROZEN 宣言）、`dsh-at-file`（公式統合済み）、`dsh-usage-plugin`（用途が DeepSeek 課金に偏る）、`Squeeze`（公開 6 日・外部モデルへ原文送信）、`dsh-browser`（C3・ログイン維持ではない）、`harness-github`（宣言互換が 0.2 未満）。
- 第三者サイト `deepseekharness.dev` のプラグイン紹介ページは**偽情報が確認された**ため、判断材料にしない（§4.3）。

---

## 2. 添付文書の主張チェック（項目別）

凡例: ✔=一次情報で確認 / △=一部確認・補足あり / ✘=文書の説明と実体が食い違う / ？=今回は未確認

### 2.1 ①Gemini 版

| 主張 | 判定 | 一次情報で分かったこと |
|---|---|---|
| Aegis の A/B 結果（契約合格 61.67→93.33%、危険出力 13.33→0%） | △ | 作者の README 記載どおり。ただし作者自身が「限定的な助言レベルの証拠」と明記し、スナップショットは別のモデル環境での測定（dsh での実測ではない） |
| Archify 約 14.8k★ | ✘ | 現在は約 92〜95k★（本体リポジトリ。dsh 用サブパッケージ単体の人気ではない） |
| `dsh-tool-ast-grep` | △ | 実在・MIT・Windows 対応修正あり。ただし **2★・v0.1.2**、`ast-grep` CLI の別途導入が必要、提供ツールは `ast_search` / `ast_outline` の2つ。C 言語での適合は未確認 |
| `harness-github`（18 ツール、書込みは承認必須） | △ | 実在。**1★・v0.1.0（8/23 以降更新なし）**。作者 README は「DSH ≥0.1.0-rc.6、0.2.0 未満」を要件としており、0.2.x では要確認 |
| `dsh-plugin-debug-mode`（Cursor Debug Mode 再現） | △ | 実在・MIT・v0.22.1。dsh.so では 0.2.1-rc.5 でランタイム検証通過（L5）。**ただし探針は HTTP POST で送る方式**で、RX/RZ 上のファームから直接は使えない（§3.6） |
| `Squeeze`（"セマンティックチャンキングで必要章節だけ注入"） | ✘ | 実体は **長文／PDF を"補助モデル"に丸ごと渡し、答えだけ返す**ツール。公開 2026-11-04（約 6 日）、3★。原文は補助モデルの提供元へ送信され、フォールバック有効だと別の提供元にも送られうる。スキャン PDF は OCR 不可 |
| `dsh-budget` / `dsh-permission-rules`（"VPS 推奨セキュリティパック標準"） | △ | どちらも実在（PerryLink）。`dsh-permission-rules` は 136★・Apache-2.0・292 コミットで活発。`dsh-budget` は **2026-10-05 に FROZEN**（新機能なし）、価格表に無いモデルは費用 0 として扱う |
| `dsh-browser`（既存ログイン・Cookie を保持して社内ポータルを巡回） | ✘ | 実体は **ヘッドレス Chromium で描画する組込みブラウザ**（Chromium 検出／`puppeteer-core`）。"ログイン済みブラウザの再利用"の記載は確認できない。dsh-xray は C3（ランタイム改変・system prompt・exec・ネットワークサーバ）。ログイン済みブラウザ操作が目的なら BrowserSkill 系 |
| `dsh-auto-mode`（~71★） | △ | 同名系が複数。NanmiCoder 版は 143〜161★、log-li 版は分類器＋サーキットブレーカ。いずれも「サンドボックスではない」と自ら明記。**公式にも experimental の auto-review がある**（§3.1） |
| OpenViking ~38k★ / Hindsight ~20.7k★ | △ | 親リポジトリの★。dsh 用の連携部分の実績ではない |

### 2.2 ②`dsh-mcp` 中心版

| 主張 | 判定 | 一次情報で分かったこと |
|---|---|---|
| `dsh-mcp`（36★・9 fork・124 commits）が最優先 | ？ | その数値に一致するリポジトリを特定できず。**`dsh-mcp-manager` 系が少なくとも 6 種**（xxxyz 25★／hyqhyq3 28★／nekojackie／jokeran／Nichts0v0／HuanLinOTO 等）。名称衝突が多く、どれを指すか不明。OAuth(PKCE)・stdio・オンデマンド"ブローカー"を謳うのは hyqhyq3 版（v0.16.2 が約 15 時間前の更新） |
| `dsh-at-file` を最優先級（S） | ✘（不要化） | FSMargoo 版の README 冒頭に「**最新の公式リリースに `@file` と `@session` が組み込まれたので、新規は公式を使うこと**」とある |
| `dsh-undo-plugin`＝AI のファイル変更の巻き戻し | ✘ | lire1131 版（103★）は **設定とプラグインコードのスナップショット／Safe Mode／起動不能時の救出**。プロジェクトのソース変更の巻き戻しではない。別の `LingLambda/dsh-undo` は"未公開の本体機能に依存、現行版では使えない"と自ら警告 |
| `dsh-usage-plugin`（約 21★）でキャッシュ・コスト把握 | △ | feiyang-dev 版は 37★・v1.18〜2.0 系。DeepSeek 課金（ピーク/オフピーク、`DEEPSEEK_API_KEY` での残高照会）前提。**価格表に無いモデルは費用 0**（GLM/Copilot の費用は出ない）。Qiongkura 版は**本体ソースへのパッチ適用が必要** |
| `dsh-sentinel`＝条件監視で DSH を起動 | ？ | 同名で見つかったのは eligahyu/dsh-sentinel＝**プラグインの静的セキュリティスキャナ**（5★・51 ルール）。文書が指すものと別物の可能性 |
| `ModLens`（約 2,369★） | △ | 現在 4.9k★。機能は一致。**外部の視覚エンジン送信**が文書①②では明示されていない |
| `dsh-agent-teams`（413★）/ `Aegis`（1,025★） | △ | 現在 2.7k★ / 1.4k★。機能説明は概ね一致 |

### 2.3 ③`dsh-context` 中心版

| 主張 | 判定 | メモ |
|---|---|---|
| `dsh-context` ≒ 観測基盤であって最適化ではない | ✔ | 妥当。★は約 4.7k |
| `cc-safety-net` はサンドボックスではない | ✔ | 作者も明記。DeepSeek Harness を対応一覧に記載 |
| `Aegis`：作者のベンチは限定的、本体向けの新リリース単位の動作確認は未完 | ✔ | 慎重な評価。リリース v2.15.0（11/4）は Windows フック起動器の硬化と SKILL サイズ上限の追加 |
| `ModSearch`：無料でも検索語の送信先が変わりうる | ✔ | 親 liustack の 958★。ただし公式 Web 検索が既定で DeepSeek Search API になる動きあり（§3.1） |
| `dsh-agent-teams`：スコープ制御は完了時監査で書込み遮断ではない | ✔ | README の記載どおり |
| 「Desktop 版は CLI の `web` を `desktop` に置換すれば良いとは限らない」 | ✔ | Desktop 内蔵のパッケージ管理が別。アプリ内のプラグイン追加画面を優先 |
| `dsh-docs`（OCR は英語・簡体字のみ） | ？ | 今回は再確認していない（一次情報未取得） |

---

## 3. 本流（`deepseek-ai/deepseek-harness`）の調査

### 3.1 公式リポジトリの状況と、公式に既にある機能

- 約 277k★、約 34k fork、25,848 コミット、MIT。直近 5 日以内にも `0.2.2` 系のマージあり。README は「developer preview。**互換性を壊す変更がある**。実行前に安全上の注意を読むこと」と明記。
- **公式 SAFETY.md の要点**: 未監査で本番利用不可／モデル生成コードとコマンドを実行し、**サードパーティプラグインを読み込む**／サンドボックス・承認・権限制御はリスクを下げるが隔離を保証しない／**使い捨て VM・コンテナ、最小権限、バックアップ、プラグイン・設定・コマンドのレビュー**を推奨。
- 公式（experimental 含む）に**既にあって、コミュニティ製と重複する**もの（リポジトリのパッケージ一覧と公式サイトの機能紹介で確認）:
  - `@file` / `@session` 参照（FSMargoo 版 README が統合済みと記載）
  - **auto-review**（各ツール呼び出しの前にモデルがレビュー。固定ポリシー、曖昧なら fail-closed。ただし PTC の `run_code` 外側と直接の Node 副作用は保証対象外）
  - schedule（スケジュール実行。既定オフの実験機能。配信の受領＝完了ではない）
  - agent team / subagent / ralph ループ、worktree、session-search、forge-github、webhook-github
  - browser-use 系（chrome-devtools-mcp / playwright-mcp / stagehand）、computer-use 系
  - MCP クライアント、LSP（読み取り 4 操作）、usage-query（用量集計）
  - 権限プリセット（Read Only / Workspace Write / Full access）、Windows 向け ACL 制限トークンのサンドボックス
  - Web 検索／取得の設定分離（Search の既定を DeepSeek Search API へ変更するコミットあり）
- 含意: **コミュニティ製を足す前に、公式の experimental を有効化して足りない部分だけ補う**のが信頼境界の観点で最も安全。

### 3.2 エコシステム全体の安全性

- dsh-xray（静的スキャン、2026-10-22 時点）: 約 20,606 リポジトリを走査し、**C3 が 6,887、C2 が 12,469**（合わせて約 94% が"強い権限"を持つ）。C レベルは**能力の大きさと透明性の指標であり、悪意の判定ではない**が、「プラグインに権限モデルが無い」ことの裏付けになる。
- Tencent Zhuque Lab の論文（A.I.G、arXiv 2608.16393）: DSH に対する間接プロンプトインジェクションを 14,560 回の制御実行で評価。最大の攻撃成功率は、ルール判定で 25.5%（隠し Unicode、ファイル経路）、LLM 判定で 17.0%（偽の完了報告、テキスト経路）、skills チャネルのファイル経路で 16.0%。→ **スキル／文書／Web／MCP 結果は"信頼できない入力"として扱い、機微な操作の前に承認ゲートを置く**必要がある。スキル集（Aegis・Superpowers 等）自体も入力経路になりうる。
- 公式の注意: カタログ掲載は監査ではない。サードパーティ各サイトも「掲載＝安全ではない」と明記。

### 3.3 偽情報・なりすましの具体例（今回確認）

| 例 | 内容 | 対処 |
|---|---|---|
| `deepseekharness.dev` の ModLens ページ | 正規は画像読解プラグイン（OCR／版面／意味）だが、同サイトは "ModLens Code Intelligence & AST Semantic Grepper `@liustack/modlens` v1.4.2（Tree-sitter、55K+★）" と**全く別の機能を記載** | このサイトのプラグイン紹介は判断材料にしない。リポジトリ本体で確認 |
| `deepseekharness.dev` の BrowserSkill ページ | `@tencent/browserskill-agent`（captcha 突破・anti-ban 等）。本家 README と dsh 用パッケージ名（`@wxg-prc-cpg/browser-skill-dsh-plugin`）に該当記載なし | 本家 README のパッケージ名のみ使う |
| `dsh1024` という代替 CLI | `dsh-budget` の README 内に「`npm i -g dsh1024` 経由で `plugin add` するとランキングに加算」とある（第三者カタログ経由の表示） | 公式 `dsh` 以外の導入ラッパーは使わない |
| 名称衝突 | `dsh-at-file`（FSMargoo／omdsh-dev の2リポジトリ）、`dsh-rewind`（sirilee／ddll8023 fork／jiangr100）、`dsh-undo` 系 3 種、`dsh-usage-plugin` 2 種、`dsh-review` 3 種、`dsh-mcp-manager` 6 種、`dsh-superpowers` 3 種 | **owner/repo まで指定**して導入。名前だけで入れない |

### 3.4 `undo` / `rewind` 系の整理（添付②の誤りを正す）

| プラグイン | 戻せるもの | ★・版・状況 | 判定 |
|---|---|---|---|
| `Anionex/dsh-turn-rewind` | 会話＋プロジェクトファイル（"Change Ledger"、非 Git ディレクトリも可） | 145★・v0.3.11（約 2 週間前、rc.3 対応）・SECURITY.md あり・BSD-3 | **第一候補** |
| `sirilee/dsh-rewind` | 会話＋ワークスペースのバックアップ復元（Claude Code の `/rewind` 相当） | 245★・v0.21.2・昨日更新。書込み系ツールのみ追跡と記載 | 第二候補（bash 経由の変更が対象外の可能性を要確認） |
| `lire1131/dsh-undo-plugin` | **設定・プラグインコード**のスナップショット、Safe Mode、起動不能時の救出 | 103★ | プロジェクト変更の巻き戻しではないが、**自作改良版 DSH や導入失敗時の復旧**には別途有用 |
| `LingLambda/dsh-undo` | 会話コンテキスト | 現行版では動作しない旨を自ら警告 | 不可 |
| `23swccp/dsh-undo-plugin` | 会話ロールバック（Shadow Git） | `0.1.0-rc.6` 向け | 古い。不可 |

### 3.5 公式 experimental を有効化する際の注意

- 公式の experimental は「明示的に導入するもの」で、既定の Web プロファイルには含まれない。有効化はアプリ内のプラグイン管理画面から。
- auto-review の保証範囲: PTC の外側 `run_code` と直接の Node 副作用は対象外。許可は"低リスク"のみ自動、"中リスク"は現在の人間または直近の親の明示的な認可が必要、"高リスク"（越境の機微データ送信など）は拒否。

### 3.6 `debug-mode` の限界（組み込み用途）

- 探針は **dsh の HTTP エンドポイントへ POST する方式**で、エージェントは自分ではコマンドを実行せず、**再現はユーザーが行う**。したがって RX/RZ 上のファームウェアから直接ログを飛ばす用途には向かず、**ホスト側ツール、Rust / C# / TypeScript / Python の個人開発向け**。ファームの実機デバッグには、シリアル系（`dsh-serial-console`、前回レポート §3.9）やデバッガログの取り込みの方が現実的。

---

## 4. 再評価一覧（実在・保守・安全性の所見つき）

| プラグイン | 実在 | 保守・規模 | 安全性・注意の要点 | 判定 |
|---|---|---|---|---|
| 公式 experimental 各種 | ✔ | 本流と同一リポジトリ | 未監査の本体と同じ信頼境界。権限は Workspace Write を基準に | **S** |
| `dsh-context` | ✔ | 4.7k★、Apache-2.0、毎日更新 | 観測のみ。機能は大きい（多言語 README、サイドバー等）ので xray カードを確認 | **S** |
| `cc-safety-net` | ✔ | 1,984 commits、v2.7.8、Node 22 要求 | **サンドボックスではない**。破壊的 Git／FS 操作と機密ファイル参照の実行前ブロック。毎ツール呼び出しでフックが動く | **S** |
| `dsh-turn-rewind` | ✔ | 145★、直近 rc.3 対応 | ファイル復元はバックアップ。Git の代替にしない | **S〜A** |
| `Aegis` | ✔ | 1.4k★、412 commits、v2.15.0 | セッション開始フック（Windows では bash を探索）あり。2.15.0 で偽 `bash.cmd` 実行を防ぐ検証を追加。効果の数値は作者測定 | **A**（Superpowers 系と併用しない） |
| `dsh-agent-teams` | ✔ | 2.7k★、311 commits、0.1.29、0.2.2 検証継続 | xray C3（ランタイムパッチ・system prompt 改変・exec・ネットワークサーバ）。**完了時の監査で、書込み遮断ではない**。同一ファイルの並列編集は避ける | **A**（まず 2 エージェント） |
| `dsh-mnemon` | ✔ | 945★、1,934 commits、v0.5.40、SECURITY.md | 外部メモリ基盤（9 種）を有効にすると**データが外部へ出る**。自動アイドルレビューはタスクエージェントを起動しトークンを消費（個別に無効化可）。まずローカル・文書／ランタイムのみ | **A**（条件付き） |
| `ModLens` | ✔ | 4.9k★、v3.27.2、SECURITY.md・CHANGELOG あり、リモート画像のプライベート宛先ブロックと DNS 固定を実装 | **画像が視覚エンジン（Gemini／Anthropic／OpenAI 互換／各 CLI）へ送信される**。`recover-paste` は Claude Code 等のローカルセッション保管から貼付画像を取り出す機能（明示コマンド） | **B**（送信先を限定） |
| `ModSearch` | ✔ | 958★（親 liustack の別リポジトリ） | 検索語が検索先へ出る。公式の検索設定と重複しうる | **B** |
| `dsh-permission-rules` | ✔ | 136★、292 commits、0.7.21、0.2.2 対応 | 規則（allow/deny/ask＋ネットワーク宛先）は強力だが、単一作者が 100 超のプラグインを維持する"ファミリー"（FROZEN／退役を含む）の一部。`cc-safety-net` と役割が重なる | **B** |
| `dsh-debug-mode` | ✔ | 1★（GitHub）／dsh.so L5 通過、v0.22.1 | 中リスク表示。コードに探針を埋める。HTTP POST 前提（§3.6） | **B**（ホスト側開発向け） |
| `dsh-usage-plugin`（feiyang-dev） | ✔ | 37★、更新あり | `DEEPSEEK_API_KEY` を読む。GLM/Copilot は費用 0 扱い。公式 usage と `dsh-context` で代替可 | **C** |
| `dsh-tool-ast-grep` | ✔ | 2★、v0.1.2 | 外部 CLI（`ast-grep`）依存。実績が少ない | **C** |
| `harness-github` | ✔ | 1★、v0.1.0、8/23 以降更新なし | 書込みは承認必須の設計。宣言互換は 0.2 未満 | **C**（公式 forge-github 優先） |
| `Squeeze`（q8atnight/dsh-squeeze） | ✔ | 3★、公開 6 日 | 原文が補助モデルの提供元へ送信。OCR なし | **C** |
| `dsh-browser`（Nono-neko） | ✔ | 13★、xray C3 | ログイン維持の機能ではない | **C**（公式 browser-use 優先） |
| `dsh-budget` | ✔ | 10★、**FROZEN** | 価格未登録モデルは費用 0 | **見送り** |
| `dsh-at-file` | ✔ | 563★ | 公式に統合済み | **見送り** |
| `dsh-our-free-model` | ✔ | 55〜66k★ | 送信先・運営主体が不透明（前回の所見を維持） | **業務では使わない** |
| `dsh-mcp`（特定不能） | ？ | — | 名称衝突。**公式 MCP クライアントを先に使い、管理 UI が必要なら owner/repo を特定して個別評価** | 保留 |
| `mstar-harness` / `dsh-automation` / `dsh-docs` / `dsh-tier-router` / `dsh-library` / `dsh-memento` / `dsh-gungnir` / goalloop 系 | ？ | — | 今回は一次確認していない。②③の記述（作者主張）の範囲で、導入判断前に個別確認が必要 | 未評価 |

（◎相当＝S、A＞B＞C の順。評価は私の判断）

---

## 5. 推奨構成と導入手順

### Phase 0: 土台（まずここから）
1. **導入先を本番にしない**。本番プロファイルをコピーしたテスト環境（別ポート）を作り、プラグインは必ずそこで先に試す。自作改良版 DSH では `cordis.patch.yml` による改変が競合しうるため特に重要。
2. 現在の `dsh --version`、Node 版（22.19 以上が前提のものが多い）、`dsh --profile <name> --dump-config` を保存。設定・プロファイルをバックアップ（秘密情報はコミットしない）。
3. 権限プリセットは **Workspace Write** を基準にする。Full access は使い捨て環境のみ。
4. 公式 experimental を有効化: auto-review、session-search、worktree、（必要なら）schedule と agent-team。
5. `dsh-context` を入れ、**同じ小課題を DeepSeek／GLM／Copilot で各 3 回**実行してトークン・キャッシュのベースラインを記録。

### Phase 1: 防御と回復
- `cc-safety-net`（`npx -y cc-safety-net@latest install` は対話式。`@latest` は省略しない旨が公式文書にある）。`doctor` で ready を確認。
- `dsh-turn-rewind`（または `dsh-rewind`）。小さなリポジトリで「3 ファイル修正→巻き戻し→再起動後の復元→Git 差分と一致」を確認。

### Phase 2: 開発規律と並列化
- `Aegis`（または Superpowers 系）を1つだけ。小さな不具合修正（再現→回帰テスト追加→最小修正）で効果と手数を比較。
- `dsh-agent-teams` は最後。キャプテン＋2名（設計とレビュー）に限定。

### Phase 3: 必要になってから
- `ModLens`（送信先エンジンを契約済みの経路に限定。社内資料のスクショは送らない）。
- `dsh-mnemon`（ローカルのみ、自動アイドルレビューは無効で開始）。記憶は重要事項を `decisions.md` 等で Git 管理する運用の方が監査しやすい。

### 導入前チェック（1 プラグイン 5 分）
1. owner/repo を README とカタログで照合（名称衝突を避ける）。
2. `package.json` の `scripts`（postinstall 等）、`dsh.bundle.patch`（`cordis.patch.yml`＝ランタイム改変）、依存を確認。
3. dsh-xray のカードで C レベルと根拠行（exec／環境変数読取／外向きドメイン）を確認。**スキャナ類は dsh の外（`npx` など）で実行**し、プラグインとして入れて権限を与えない。
4. バージョンまたはコミットハッシュを固定（`github:owner/repo#sha`）。pnpm の `allowBuilds` 承認は信頼判断である。
5. 導入後に `--dump-config` の差分を確認し、数日は承認フローを有効のまま使う。

---

## 6. 前回レポートの修正点

1. `dsh-at-file` を「UI 基盤」として挙げたが、**公式に統合済み**で、新規導入の理由は薄い。
2. 公式 experimental（auto-review／schedule／browser-use／usage-query／forge-github）の位置づけが弱かった。**まず公式、足りない部分だけコミュニティ**が正しい順序。
3. `dsh-review`（Viger1）の機能説明は第三者サイトの記述のみが根拠で、作者の GitHub での一次確認はできていなかった。導入前に作者リポジトリで再確認すること。
4. `dsh-cost-meter` / `dsh-client-ui-cache-hit` / `dsh-cache-probe` は DeepSeek 系の課金・キャッシュ項目を前提とする記述が多く、GLM・Copilot 経路で値が出る保証はない（今回も未確認）。
5. 第三者カタログの★・件数は不一致が多い。数字は参考値に留める。

---

## 7. 今回確認できなかったこと

- Reddit／Medium での個別プラグインの利用報告・障害報告（有意な材料なし）。
- Renesas RX/RZ・NORTi／FreeRTOS を前提にした各プラグインの実機動作。
- 自作改良版 DSH との互換性（バージョン表示だけでは判断できない）。
- `ModLens` の各視覚エンジンの具体的なデータ保持方針、`dsh-mnemon` の外部メモリ基盤各種の取扱い。
- 添付②③のうち §4 で「未評価」とした項目。

---

## 8. 出典（主なもの）

- 公式リポジトリ: https://github.com/deepseek-ai/deepseek-harness
- 公式 SAFETY.md: https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md
- 公式 auto-review ノート: https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-08-28-auto-review.md
- 公式サイト（機能紹介）: https://www.deepseek.com/en/harness/
- Windows ACL サンドボックス解説: https://deepwiki.com/deepseek-ai/deepseek-harness/4.3-sandboxing-and-security
- A.I.G 論文: https://arxiv.org/pdf/2608.16393v2
- dsh-xray: https://github.com/unStone/dsh-xray ／ https://unstone.github.io/dsh-xray/
- cc-safety-net: https://github.com/kenryu42/cc-safety-net
- dsh-context: https://github.com/bowenliang123/dsh-context
- Aegis: https://github.com/GanyuanRan/Aegis ／ https://github.com/GanyuanRan/Aegis/releases
- dsh-agent-teams: https://github.com/NanmiCoder/dsh-agent-teams
- ModLens: https://github.com/liustack/modlens
- dsh-mnemon: https://github.com/omdsh-dev/dsh-mnemon
- dsh-permission-rules: https://github.com/PerryLink/dsh-permission-rules
- dsh-budget: https://github.com/PerryLink/dsh-budget
- dsh-turn-rewind: https://github.com/Anionex/dsh-turn-rewind
- dsh-rewind（sirilee）: https://dsh-plugin.org/plugins/sirilee/dsh-rewind
- dsh-undo-plugin（lire1131）: https://deepseek-plugin.org/plugins/lire1131/dsh-undo-plugin
- dsh-undo（LingLambda）: https://github.com/LingLambda/dsh-undo
- dsh-at-file: https://github.com/FSMargoo/dsh-at-file
- dsh-usage-plugin: https://github.com/feiyang-dev/dsh-usage-plugin
- dsh-plugin-debug-mode: https://github.com/rh666666/dsh-plugin-debug-mode ／ https://www.dsh.so/zh/artifact/dsh-plugin-debug-mode/
- dsh-tool-ast-grep: https://github.com/Jaylor-Wang/dsh-tool-ast-grep
- harness-github: https://github.com/988hj7tczd-oss/harness-github
- dsh-squeeze: https://github.com/q8atnight/dsh-squeeze
- dsh-browser: https://github.com/Nono-neko/dsh-browser
- dsh-mcp-manager 系: https://github.com/xxxyz/DeepSeekHarness-MCP-Manager ／ https://github.com/hyqhyq3/dsh-mcp-manager
- dsh-sentinel（スキャナ）: https://dsh-plugin.org/plugins/eligahyu/dsh-sentinel
- 偽情報の例（参考・信頼しない）: https://deepseekharness.dev/plugins/modlens
