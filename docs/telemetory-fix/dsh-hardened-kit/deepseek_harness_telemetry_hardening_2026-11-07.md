# DeepSeek Harness（DSH）外部送信の実態調査と、フォークによる完全ハードニング設計

- 調査日: 2026-11-07（JST）
- 対象: `deepseek-ai/deepseek-harness` master（0.2.2-rc.1 / 0.2.2-alpha.3 系）、Windows 10/11 上の Web / Desktop / headless 利用
- 成果物: 本書、および動作検証済みの `*.ts` 一式（`dsh-hardened-kit.zip`）
- 調査方法: 公式リポジトリの README・設計ノート・ソース断片、GitHub Discussions（一次報告・計測値）、既存フォーク（時雨堂 fork ほか）、技術ブログ、Reddit/Medium の検索。サンドボックスから GitHub/npm への直接接続は遮断されていたため、**upstream の clone とビルドは本書の作成環境では実施していない**。そのためコード改変は「upstream 内部構造に依存しない実行時ガード」と「アンカー検証付き codemod」の二本立てとし、前者は実機 Node 24 で自動テスト済み、後者は upstream と同形のフィクスチャで検証した（§9）。

---

## 0. 結論（先に要点）

1. **疑惑は事実に基づいている。** ただし「隠れたスパイウェア」ではなく、**公開ソースに既定で有効な形で実装された 4 つの外部送信経路**によるもの。最大の経路は OTel テレメトリではなく、**公式 DeepSeek API リクエスト本文に同梱される `dsh_session_log`** である。
2. **`DSH_TELEMETRY_DISABLED=1` ではこの経路は止まらない。** `dsh_session_log` と `dsh_plugin_packages` は API リクエスト拡張であり、OTel とは独立している。さらにこれらは「公式エンドポイント」ではなく `deepseek-official` **プロバイダ**単位で付与されるため、`DEEPSEEK_BASE_URL` で自前ゲートウェイに向けても送られる（#9927）。
3. **量は「大量」と言ってよい。** 通常ターンで約 10 KB／リクエストが上乗せされ、セッションを fork した直後は 1 リクエストで **7.5 MB**（本文全体 8.07 MB の 93%）。Windows 11・Desktop 0.2.0-rc.2 での実測報告がある（#11834）。過去には 48.8 MiB や 160 MB 超の本文で 413 エラーが続き、セッションが使えなくなった事例もある（#7247 / #6847）。
4. **中身は会話全文にとどまらない。** モデルへの入力に含まれないメタデータ（sandbox / approval / permission / workspace の変更、retry、compaction）、compaction で既に刈り込まれた履歴、ツールの引数と結果、絶対パスの cwd、未知イベントのそのままの転送まで含まれ、**脱敏（マスキング）処理はない**（#7725 / #8527、公式 README）。
5. **対策は三層で行う。** (A) 設定オーバーレイ＋環境変数（今日すぐ適用できる）、(B) **プロセス全体の egress guard**（`egress-guard.ts`。upstream の実装に依存せず、`dsh_*` フィールドと識別ヘッダの除去、`*.deepseeksvc.com` の遮断を行う。テスト済み）、(C) **フォーク**（`apply-hardening.ts` でソースの既定値を fail-closed に変え、UI・プロファイル・HMR からは再有効化できないようにする）。
6. DSH の使い勝手（エージェントループ、UI、ツール、ローカルのセッション永続化）には**一切手を入れない**。外部共有の境界だけを変える最小差分なので、upstream への追従コストは低い。

---

## 1. 調査範囲と証拠の扱い

| 区分 | 内容 | 本書での扱い |
|---|---|---|
| A: 公式一次資料 | パッケージ README、`cordis.patch.yml`、設計ノート、公式ドキュメント | 仕様の根拠 |
| B: 再現付き一次報告 | GitHub Discussions のうち、ファイル・行番号・計測値・PoC を示すもの | 実装挙動の根拠（自分では未再現と明記） |
| C: 二次資料 | 技術ブログ、コミュニティ文書、フォーク解説 | 補強材料。A/B と矛盾する場合は採用しない |
| D: SNS | Reddit 等 | 端緒としてのみ扱う |

**Reddit について:** 指摘された「大量送信」を主張する Reddit 投稿本文は、今回の検索では特定できなかった（r/DeepSeekHarness の OTel プラグイン紹介投稿は見つかったが、送信疑惑の一次証拠ではない）。一方、GitHub Discussions #8527 は同じ趣旨の主張を**実測値付き**で提示しており、Reddit 側の主張よりも強い一次証拠である。本書の結論は A/B に基づいている。

**Medium について:** DSH の送信経路をソースまたはパケットで検証した Medium 記事は見つからなかった。一般論の OTel 記事は証拠として採用していない。

---

## 2. 一次データ（コミュニティの実測と公式記述）

### 2.1 公式 README の現行仕様 — `@deepseek-ai/dsh-session-log-deepseek`

- 設定 `enabled` の**既定値は `true`**、`maxBytes` は **8 MiB**（1 リクエストあたりの上限）。
- 出荷プロファイルはこのプラグインをマウントするため、既定構成のままリクエストフィールドが登録される。
- Web の **Settings → General → Upload Session Log when using the official model API** スイッチで切り替えられる。ただし home パッチやコマンドラインのオーバーレイが優先され、それと矛盾するフォームからの書き込みは拒否される。
- **再度有効にすると、無効にしていた間に記録された未受理イベントも送信対象になる。**
- OTel のフィードバック送信は別の設定である。

> 補足: コミュニティ文書 deepseekdocs.com は「session-log の既定値は false」と記載しているが、公式 README・#7725 のソース引用・#8527 / #9927 / #11834 の実測と矛盾する。本書は**既定値 true を前提に**対策する。

### 2.2 base バンドル `packages/bundle/base/cordis.patch.yml`（master）

- `session-log-deepseek` と `plugin-package-inventory-deepseek` の行が **config 指定なし**（= プラグインの既定値 true のまま）で base に入っている。
- 直近の commit `3859913` で「Web 検索の既定を **DeepSeek Search API** に変更」が入った（§4.6 で扱う別経路）。

### 2.3 GitHub Discussions の計測値

| # | 日付 | 環境 | 計測・主張（要旨） |
|---|---|---|---|
| **#8527** | 2026-09-30 | — | 実際にアップロードされたのは **16 セッション分、`delivery-accepted` 記録 3,682 件、累計約 27,398 イベント**。1 セッションでは 9,382 イベント中 9,374 件が送信済み。モデル入力に含まれないメタデータ（`sandbox/mode`、`approval/policy`、`permission/preset`、`workspace/changes`、`llm/retry`、`compaction/prune`）や、compaction で刈り込まれた履歴も含まれる。脱敏なし |
| **#9927** | 2026-10-17 | 0.2.1-alpha.5, acp プロファイル, `DSH_TELEMETRY_DISABLED=1` | `DEEPSEEK_BASE_URL` を自前サーバーに向けても、全 Messages リクエストに `dsh_session_log` と `dsh_plugin_packages` が付く。初回は約 25 KB（system prompt、ユーザーメッセージ、実行時コンテキスト、ツール定義を含むヘッダ）。**付与の判定は endpoint ではなく provider 単位**。overlay で両フィールドを無効にしても会話は正常に動作した |
| **#11834** | 2026-11-02 | **Windows 11**, Desktop 0.2.0-rc.2, deepseek-flash | 親セッションの通常ターン: 本文 583,455 B のうち `dsh_session_log` は 10,856 B。**fork 直後の初回ターン: 本文 8,071,802 B のうち `dsh_session_log` が 7,504,595 B**（本文が 14 倍に膨らみ、その分はすべてこのフィールド） |
| **#7247** | 2026-09-19 | Windows 10, 0.1.6-alpha.1 | 大きなセッションを fork すると水位（watermark）が -1 になり、48.8 MiB を送って 413 エラー。413 は再試行対象外で水位が進まないため、以後すべてのリクエストが失敗し続ける（`/compact` も含む） |
| **#6847** | 2026-09-16 | Windows 11 + WSL2, 0.1.6-alpha.1 | 上限なしで送ったため本文が 160 MB を超え、413 エラーで同様に動かなくなった（その後 8 MiB の上限が導入された） |
| **#7725** | 2026-09-24 | master `46a7f68b`（0.1.7-rc.1） | ソース L44-46 で `enabled: z.boolean().default(true)`。送信内容は cwd の絶対パス・agentPreset・origin・parentSession、tool/result の全データ、approval 操作。**未知のイベント型もそのまま転送**される。PR #4183 で導入 |
| **#952** | 2026-08-13 | 0.1.0-rc.6 | `x-deepseek-harness-user-id`（永続 UUID）がテレメトリ設定に関係なく毎リクエストに付き、カスタム baseURL にも送られる。`llm-pi-ai` アダプタでは送られない。第三者が TS ソースで独立に再現・確認済み |
| **#4100** | 2026-08-22 | — | FULL モードでの OTLP 送信に、埋め込んだ API キー・SSH 秘密鍵・Bearer トークンがそのまま含まれた。`/feedback` 1 回でセッションの先頭からの全履歴が解放される |

### 2.4 識別子 — `@deepseek-ai/dsh-anonymous-user-id`

公式 README によると、`$DSH_HOME/.anonymous-user-id` にランダムな UUID v4 を永続化し、**同じ値を 3 か所で使う**: OTel の Resource `user.id`、`/feedback` の受付応答、`dsh-llm-deepseek` が送る `x-deepseek-harness-user-id`。目的は、受信側が独自に ID を作らずに記録を突合（相関）できるようにすることと明記されている。

### 2.5 プラグイン一覧 — `@deepseek-ai/dsh-plugin-package-inventory-deepseek`

既定は `enabled: true`。出荷プロファイルではこの既定値が使われるため、**全ての公式 DeepSeek リクエストが**有効なプラグインの `{name, version}` 一覧を運ぶ。社名やプロジェクト名を含む私有プラグイン名は、それ自体が業務情報になりうる。

---

## 3. ソース解析 — 外部送信経路の全体像

```
                         ┌──────────── DSH host process (node) ────────────┐
 Session log (append-only, canonical)                                       │
   │                                                                        │
   ├─(R1) session-log-deepseek ── ctx.deepseekLlmApiExtensions ──┐          │
   ├─(R2) plugin-package-inventory-deepseek ─────────────────────┤ prepare  │
   │                                                             ▼          │
   │                    llm-deepseek adapter: fetch(`${messagesApiRoot(baseURL)}/messages`)
   │                      headers: attributionHeaders()                     │
   │                               x-deepseek-harness-user-id   ← (R3) anonymous-user-id
   │                               x-deepseek-harness-session-id / -compact │
   │                      body:    {model, system, messages, tools, …,      │
   │                                dsh_session_log, dsh_plugin_packages}   │
   │                                         │                              │
   └─(R4) session-telemetry → session-telemetry-otel (FEEDBACK_ONLY)        │
             └ OTLP/HTTP → dsh-otel-collector.deepseeksvc.com/v1/logs       │
                         (旧: harness-telemetry.deepseeksvc.com)            │
                         └──────────────────────────────────────────────────┘
        ▼ api.deepseek.com  /  DEEPSEEK_BASE_URL（自前 GW でも R1/R2/R3 が付く）
```

| 経路 | 実装位置 | 既定 | 送信先 | 内容 | `DSH_TELEMETRY_DISABLED` で止まるか |
|---|---|---|---|---|---|
| **R1** `dsh_session_log` | `packages/session/session-log-deepseek` → `deepseek-llm-api-extensions` 経由で adapter が merge | **有効** | 解決後の DeepSeek endpoint（カスタム baseURL を含む） | 正準セッションログの未受理部分（≤ 8 MiB／リクエスト、backlog は複数リクエストに分けて送信、fork 時は全量を再送） | **止まらない** |
| **R2** `dsh_plugin_packages` | `packages/llm/plugin-package-inventory-deepseek` | **有効** | 同上 | 有効なプラグインの name/version | **止まらない** |
| **R3** 識別ヘッダ | `packages/llm/llm-deepseek/src/adapter.ts` + `packages/identity/anonymous-user-id` | **常時** | 同上 | 永続 UUID、session id、compact フラグ | **止まらない** |
| **R4** OTel セッションテレメトリ | `packages/session/session-telemetry(-otel)` | **FEEDBACK_ONLY** | `*.deepseeksvc.com` collector | `/feedback`・評価・ノート編集を契機に、それまでのセッション全体を脱敏なしで送信 | 止まる（設計上） |
| R5 product telemetry | `packages/host/product-telemetry-otel` | 出荷プロファイルではマウントされない | collector | caller が emit したイベント | — |
| 通常のモデル入力 | adapter | 必須 | 選択したプロバイダ | messages / system / tools | 対象外（推論そのもの） |

### 3.1 R1 の処理フロー（README と設計ノートから再構成）

1. live な `sessionId` を持つリクエストについて、同じ session id と format 世代の `session-log-deepseek/delivery-accepted` イベントを畳み込み、受理済みの水位を求める。
2. 水位の次から、`maxBytes` に収まる最長の連続イベントを切り出す（version-1 フィールド: `sessionFormatVersion`、raw session header、`afterSeq`、`throughSeq`、正準イベント全体）。
3. adapter が本文のトップレベルに `dsh_session_log` を merge して送信する。
4. HTTP 2xx を受けた時点で（SSE を消費する前に）`delivery-accepted` をローカルログに追記し、水位を進める。
5. **fork した子セッションは親の水位を引き継がない**ため、継承した履歴を全量再送する（#11834 / #7247 の原因）。

### 3.2 フォーク設計に効く重要な事実

- `session-log-deepseek` は `session-log-deepseek/delivery-accepted` というイベント型を宣言している。**このパッケージを workspace から削除すると、生成される既知イベント語彙からこの型が消え、既存のセッションログが「unknown to this harness ... refusing to interpret the log」で開けなくなる**（未知型を拒否する仕様は公開済み）。したがってフォークでは**パッケージを削除せず、振る舞いだけを無効化する**のが正解。
- 構成レイヤーは「バンドル → プロファイルの `cordis.patch.yml` → Harness Home の `cordis.patch.yml` → コマンドラインの `--patch`」の順に適用され、後のものが勝つ。`config` は深いマージではなく行全体の置換。
- OTel バックエンドの行をアンマウントすると `/feedback` は "not configured" と表示する（バックエンド未マウントは設計上サポートされている）。
- `llm-pi-ai` アダプタは R1〜R3 を一切付けない（#952、request-extension 設計ノート）。→ **フォークしない代替策**として使える（§6.4）。

---

## 4. イベント内容の評価 — 何が出ていくか

| データ | 経路 | 機密性の評価 |
|---|---|---|
| ユーザープロンプト・アシスタント応答（compaction で刈り込み済みの履歴を含む） | R1, R4 | 設計情報・顧客情報・未公開コード |
| ツール引数・結果（ファイル内容、シェル出力、diff） | R1, R4 | ソースコード全文、`.env` やトークンが表示された場合の秘密情報 |
| system prompt・ツール定義 | R1（ヘッダ）, R4 | 社内プロンプト・独自ツールの構成 |
| cwd の絶対パス（`C:\Users\<名前>\…\<顧客名>\…`） | R1, R4 | ユーザー名・製品名・顧客名 |
| sandbox / approval / permission / preset | R1 | 防御設定・運用ポリシー |
| `workspace/changes` | R1 | 変更されたファイル名と構成 |
| エラー文字列 | R1, R4 | upstream エラーに混入したトークンや endpoint |
| プラグイン名とバージョン | R2 | 社内プラグイン名・環境の推定 |
| 永続 UUID・session id | R3, R4 | 端末単位での長期的な相関 |

**組み込みファームウェア開発の文脈では**、RX / RZ のレジスタ設定コード、NORTi / FreeRTOS の構成、社内パス、顧客型番などが R1 経由でツール結果としてそのまま出ていく構造になっている。

### 4.1 テレメトリ以外の外部送信（今回新たに確認したもの）

- **Web 検索:** master で既定が DeepSeek Search API（`https://api.deepseek.com/v1/tools/search`）に変更された。0.2.2-rc.1 の新 API 経路では、検索クエリに加え、**検索のきっかけになったユーザー質問の断片（最大 128 文字、`ori_question` / `sendOriginalQuestion`）**も送られうる。
- **Web fetch（ローカル HTTP）:** 0.2.2-rc.1 で loopback・内部ネットワーク・クラウドメタデータアドレスへの制限が外れ、承認も不要になった（SSRF 面）。社内ネットワークに接続された PC では要注意。
- `session-title-first-prompt-llm`: 最初のプロンプトでタイトルを生成するため、既定ルートのモデルに送られる（通常のモデル通信の一種）。

これらは「テレメトリ」ではないが、外部への出口として egress guard の allow-list と `sendOriginalQuestion=false`（フォークの P7）で扱う。

---

## 5. 既存のフォーク・プラグイン・PR の評価

| 名前 | 内容 | 評価・取り込み |
|---|---|---|
| **shiguredo/deepseek-harness**（時雨堂） | upstream に積極的に追従。日本語 UI、Ollama Cloud、**公式 API 利用時の session log アップロードを既定オフ**など | 方針は本書と同じ。ただし session-log の既定オフのみで、R2・R3・R4 と UI からの再有効化は対象外。日本語 UI が欲しければ、このフォークに本 kit の codemod を重ねて適用する選択肢もある |
| 0xSmartis/deepseek-harness-privacy | privacy fork を名乗る | クロール時点で「upstream master と同一（up to date）」、identity パッケージも upstream のまま。**実質的に差分がなく、そのままでは使えない** |
| dsh-telemetry-redactor（#1365）/ dsh-redact（#2208） | OTel 送信コピーやログ共有時の脱敏 | 補助策としては有用。ただし R1（API 本文）には効かず、**送信停止の代わりにはならない** |
| #4100 / #7725 / #952 / #9927 の提案 | 既定 false、明示的な同意、非公式 endpoint では送らない、未知イベントは drop、環境変数スイッチの追加 | 本書のフォーク仕様に**すべて取り込み済み**（§7） |
| upstream の現状 | README を整備し、UI スイッチを追加。home/CLI パッチが UI より優先 | 既定値は true のまま。fork の付与条件（provider 単位）も未修正 |

---

## 6. 今すぐできる対策（フォーク不要）

### 6.1 最小構成（3 つすべて必須）

1. **環境変数**（OTel のハードな opt-out）
   ```powershell
   [Environment]::SetEnvironmentVariable('DSH_TELEMETRY_DISABLED','1','User')
   [Environment]::SetEnvironmentVariable('DSH_TELEMETRY_MODE','DISABLED','User')
   ```
2. **オーバーレイ** `privacy-hardened.patch.yml` を最後のレイヤーとして適用する（`--patch`、または `%USERPROFILE%\.dsh\cordis.patch.yml` に追記）
   ```yaml
   - id: session-log-deepseek
     config: { enabled: false }
   - id: plugin-package-inventory-deepseek
     config: { enabled: false }
   - id: session-telemetry-otel
     disabled: true
     config: { mode: DISABLED }
   ```
   home/CLI パッチが優先されるため、**UI のスイッチを誤って ON にしても書き込みは拒否される**。
3. **egress guard** を使って起動する（R3 の識別ヘッダは設定では止められないため）
   ```powershell
   C:\tools\dsh-hardened\dsh-hardened.ps1 web
   ```

### 6.2 起動ランチャーが行うこと

`dsh-hardened.ps1` / `.sh` は、①上記の環境変数を設定し、②`npm root -g` から `@deepseek-ai/dsh` の `bin` を解決する（`dsh.cmd` が PATH に無い nvm4w 環境でも動く）、③`node --import=file:///…/egress-guard.ts <entry> … --patch privacy-hardened.patch.yml` で起動する。`-InstallHomePatch` を付けると home パッチもインストールするので、同じ `DSH_HOME` を使う Desktop にも効く。

### 6.3 Desktop 版（AppData\Local\Programs 配下の exe）について

- 環境変数と home パッチは Desktop にも効く（同じ `DSH_HOME` を使っている場合）。
- egress guard の注入: Desktop は Electron で、子の harness プロセスに `NODE_OPTIONS` が渡るかどうかはビルド設定（fuse）に依存する。ユーザー環境変数に `NODE_OPTIONS=--import=file:///C:/tools/dsh-hardened/egress-guard.ts` と `DSH_EGRESS_LOG` を設定して起動し、**`egress-audit.jsonl` に Desktop の pid の記録が現れれば有効**。現れない場合は Desktop には guard が効いていないので、機密作業は `dsh-hardened.ps1 web` で行う。
  - `NODE_OPTIONS` をユーザー全体に設定すると、他の Node プロセスにも guard が読み込まれる。既定は deny-list のみ（`*.deepseeksvc.com`）で副作用はほぼないが、通知を消すために `DSH_EGRESS_QUIET=1` を併用するとよい。

### 6.4 フォークしない代替策: DeepSeek を `llm-pi-ai` 経由で使う

R1〜R3 は `deepseek-official` プロバイダ（`llm-deepseek` アダプタ）に結びついている。DeepSeek API を **pi-ai のカスタムプロバイダ**として登録すれば、これらは付かない。

```yaml
# ~/.dsh/settings.yaml（例。実際の api 値と baseURL は Models 画面の候補で確認）
llm-pi-ai:
  providers:
    deepseek-direct:
      apiKeyEnv: DEEPSEEK_API_KEY
      api: openai-completions
      baseURL: https://api.deepseek.com/v1
      models:
        - id: deepseek-flash
agent-default-model:
  provider: deepseek-direct
  model: deepseek-flash
```
トレードオフ: DeepSeek 専用アダプタの機能（Files API、画像の扱い、reasoning の詳細な制御など）が使えなくなる可能性がある。タイトル生成や Web 検索が引き続き `deepseek-official` を使うかどうかは、`wire-test.ts --guard audit` で確認すること。

### 6.5 補助策

- `hosts`: `0.0.0.0 dsh-otel-collector.deepseeksvc.com` / `0.0.0.0 harness-telemetry.deepseeksvc.com`（R4 のみに有効。**R1〜R3 は api.deepseek.com と同じ接続で送られるため、hosts では止まらない**）。
- `/feedback`・評価・ノート編集は、機密セッションでは使わない。
- 既に送信してしまった可能性がある場合: ツール結果に出た API キーなどは失効させて再発行する。#8527 のコミュニティは privacy@deepseek.com への削除依頼を推奨している（効果は未確認）。ローカルの `delivery-accepted` 件数を数えれば、送信済みの範囲を見積もれる。

---

## 7. フォークの詳細設計（本書の中核）

### 7.1 設計原則

| 原則 | 具体化 |
|---|---|
| **既定値で fail-closed** | すべての外部共有はソースレベルの既定で OFF |
| **再有効化の経路を一本化** | UI、profile、home patch、HMR、`config-editor` からは**有効化できない**。再有効化できるのはプロセス環境変数（`DSH_HARDENED_ALLOW_*=1`）だけ |
| **二重化** | ① 各プラグインの `apply()` で送信処理を登録しない、② adapter の `fetch` を `hardenedFetch` に差し替える、③ プロセス全体の egress guard。どれか 1 つが upstream の変更で外れても、他の層で止まる |
| **パッケージは削除しない** | 既知イベント語彙を維持し、既存セッションログの互換性を保つ（§3.2） |
| **追従性** | 改変はアンカー付きの codemod で再適用する。upstream が変わればアンカーが見つからず CI が止まり、無言のまま無効化されることはない |
| **UX 不変** | エージェントループ、UI、ツール、ローカル永続化、compaction、retry には触れない |

### 7.2 パッチ一覧（`fork/apply-hardening.ts` が自動適用）

| ID | 対象ファイル | 変更 | 区分 |
|---|---|---|---|
| **P1a** | `packages/session/session-log-deepseek/src/index.ts` | `enabled: z.boolean().default(true)` → `default(false)` | required |
| **P1b** | 同上 | `apply()` の先頭に `if (process.env.DSH_HARDENED_ALLOW_SESSION_LOG_UPLOAD !== '1') return` を挿入。拡張フィールドの登録自体を行わない → UI スイッチは無効化される | required |
| **P2a/b** | `packages/llm/plugin-package-inventory-deepseek/src/index.ts` | 同様（`DSH_HARDENED_ALLOW_PLUGIN_INVENTORY`） | required |
| **P3** | `packages/identity/anonymous-user-id/src/index.ts` | `getOrCreateAnonymousUserId` を、**プロセスごとに生成する非永続のランダム ID**を返すラッパーに置き換える。`.anonymous-user-id` は作成しない（`DSH_HARDENED_ALLOW_PERSISTENT_ID=1` で元の動作に戻す）。OTel の `user.id`・`/feedback` の受付応答・ヘッダの 3 か所に一括で効く | required |
| **P4a** | `packages/llm/llm-deepseek/src/*.ts` | 素の `fetch(` 呼び出しをすべて `hardenedFetch(` に置換し、`hardened-fetch.ts` を同梱する。`dsh_*` の除去（将来追加される `dsh_*` フィールドも fail-closed で除去）、`x-deepseek-harness-*` の除去、`*.deepseeksvc.com` の拒否を行う。メソッド定義・`function fetch(`・コメント行は置換しない | required |
| P4b | `packages/web/web-deepseek-api/src/*.ts` | 同上 | optional |
| P5 | `llm-deepseek/src/adapter.ts` | `'x-deepseek-harness-user-id': …` の行をソースから削除（多層防御） | optional |
| **P6** | `packages/bundle/*/cordis.patch.yml` | `DSH_TELEMETRY_MODE \|\| 'FEEDBACK_ONLY'` → `'DISABLED'`、`*.deepseeksvc.com` の URL を `http://127.0.0.1:9/dsh-hardened-blackhole` に置換、`session-telemetry-otel` 行に `disabled: true`、R1/R2 の行に `config.enabled: false` を明示 | required（session-log の行が見つかること） |
| P7 | `packages/web/web-*deepseek*/src/*.ts` | `sendOriginalQuestion` の既定を false に | optional |

`x-deepseek-harness-session-id` は**セッション単位のランダム値**（セッション間での相関はできない）なので、DeepSeek 側のキャッシュ親和性に影響する可能性を考慮し、`DSH_HARDENED_ALLOW_SESSION_HEADER=1` を設定したときに限り、**api.deepseek.com に対してのみ**送る選択肢を残した（既定は送らない）。キャッシュヒット率への影響は未検証であり、有効にするかどうかは実測で判断すること。

### 7.3 主要な差分（フィクスチャへの適用結果から抜粋）

```diff
--- a/packages/session/session-log-deepseek/src/index.ts
+++ b/packages/session/session-log-deepseek/src/index.ts
-  enabled: z.boolean().default(true),
+  enabled: z.boolean().default(false),
 ...
 export function apply(ctx: Context, config: Config): void {
+  // [dsh-hardened] gate DSH_HARDENED_ALLOW_SESSION_LOG_UPLOAD: dsh_session_log upload is compiled out ...
+  if (process.env.DSH_HARDENED_ALLOW_SESSION_LOG_UPLOAD !== '1') {
+    return
+  }
   if (!config.enabled) return
   ctx.deepseekLlmApiExtensions.register(...)
```
```diff
--- a/packages/llm/llm-deepseek/src/adapter.ts
+++ b/packages/llm/llm-deepseek/src/adapter.ts
+import { hardenedFetch } from './hardened-fetch.ts' // [dsh-hardened]
-    const response = await fetch(`${messagesApiRoot(connection.baseURL)}/messages`, {
+    const response = await hardenedFetch(`${messagesApiRoot(connection.baseURL)}/messages`, {
-        'x-deepseek-harness-user-id': this.dependencies.resolveUserId(),
+        // [dsh-hardened] x-deepseek-harness-user-id removed
```
```diff
--- a/packages/bundle/base/cordis.patch.yml
+++ b/packages/bundle/base/cordis.patch.yml
   - id: session-log-deepseek
     name: '@deepseek-ai/dsh-session-log-deepseek'
+    # [dsh-hardened] session-log-deepseek: upload disabled by default
+    config:
+      enabled: false
   - id: session-telemetry-otel
+    disabled: true # [dsh-hardened] session-telemetry-otel disabled
-      mode: !!js "process.env.DSH_TELEMETRY_MODE || 'FEEDBACK_ONLY'"
+      mode: !!js "process.env.DSH_TELEMETRY_MODE || 'DISABLED'"
-        url: !!js "process.env.DSH_TELEMETRY_OTLP_URL || 'https://dsh-otel-collector.deepseeksvc.com/v1/logs'"
+        url: !!js "process.env.DSH_TELEMETRY_OTLP_URL || 'http://127.0.0.1:9/dsh-hardened-blackhole'"
```
```ts
// packages/identity/anonymous-user-id/src/index.ts（末尾に追加。元の関数はリネームして残す）
let hardenedEphemeralUserId: string | undefined
export function getOrCreateAnonymousUserId(...args: Parameters<typeof upstreamGetOrCreateAnonymousUserId>) {
  if (process.env.DSH_HARDENED_ALLOW_PERSISTENT_ID === '1') return upstreamGetOrCreateAnonymousUserId(...args)
  hardenedEphemeralUserId ??= globalThis.crypto.randomUUID()
  return hardenedEphemeralUserId
}
```

### 7.4 egress guard（`egress-guard.ts`）の設計

upstream の内部構造に**一切依存しない**最後の防壁。`--import` でユーザーコードより前に読み込まれる。

| 層 | フック | 動作 |
|---|---|---|
| L1 | `globalThis.fetch` | JSON 本文のトップレベル `dsh_*` を除去（gzip / deflate / br は伸長→除去→再圧縮）、`x-deepseek-harness-*` を除去、host の deny / allow 判定。`Request` オブジェクトや Uint8Array の本文にも対応 |
| L2 | `node:http` / `node:https` の `request` / `get` | deny 対象なら接続できない専用の Agent を差し込み、`error` イベントで失敗させる。呼び出し側が error リスナーを付けていなくてもプロセスは落ちない。`syncBuiltinESMExports()` で `import { request } from 'node:https'` の形にも反映させる（OTLP/HTTP exporter の経路） |
| L3 | `dns.lookup` / `dns.promises.lookup` | deny 対象のホスト名は名前解決させない → undici・net・tls など、すべての経路を名前解決の段階で止める |
| 伝播 | `worker_threads.Worker` / `NODE_OPTIONS` | `--import` は Worker に継承されないことを確認したため（§9.1）、Worker の生成をラップして guard を先に読み込ませる。子の Node プロセスには `NODE_OPTIONS` で伝播させる |
| 監査 | JSONL | host、path（クエリは除く）、ヘッダ**名**、除去したキー、バイト数のみを記録。本文・値・トークンは一切記録しない |

ポリシー: 既定は deny-list（`*.deepseeksvc.com`）のみ。`DSH_EGRESS_ALLOW` を設定すると**厳格な allow-list**になる（loopback は常に許可、deny-list が常に優先）。`DSH_EGRESS_MODE=audit` を設定すると、改変も遮断もせずに記録だけを行う（ベースラインの計測用）。

### 7.5 upstream への追従（`fork/hardening-ci.yml`）

1. 毎日 upstream/master を `hardening/candidate` に merge する。
2. `apply-hardening.ts --strict` を実行する（アンカーが 1 つでも見つからなければ exit 2 で停止）。
3. 静的ゲート: ソース中に `deepseeksvc.com` の URL や `'x-deepseek-harness-user-id':` が残っていないこと、gate のマーカーがあること。
4. `pnpm install --frozen-lockfile && pnpm run build`
5. `egress-guard.selftest.ts`
6. **wire test ①: 環境変数なし・guard は audit モード** → フォーク**自体**が PASS すること（guard が直しているのではないことの証明）
7. wire test ②: ランチャー構成（enforce）
8. 結果を artifact に保存し、PR を作成する。

運用ルール: master を直接追わず、**検証済みのタグに pin** する。`packages/session`、`packages/llm`、`packages/telemetry`、`packages/bundle`、`packages/web` の差分はレビュー必須。リポジトリの lint（oxlint / knip）が `hardening/` を拾う場合は ignore に追加する。

---

## 8. 導入手順（Windows 11 / Git Bash 想定）

```bash
# 0) kit を node_modules の外に展開（例 C:\tools\dsh-hardened）
cd /c/tools/dsh-hardened && node egress-guard.selftest.ts        # ALL 12 CHECKS PASSED

# 1) 現状の計測（stock + 設定なし、guard は audit モード）
ENTRY="$(npm root -g)/@deepseek-ai/dsh/$(node -p "const p=require('$(npm root -g)/@deepseek-ai/dsh/package.json');typeof p.bin==='string'?p.bin:p.bin.dsh")"
node wire-test.ts --entry "$ENTRY" --no-env-optout --guard audit      # 期待: FAIL（dsh_session_log 等を検出）

# 2) 設定で塞いだ状態を計測
node wire-test.ts --entry "$ENTRY" --patch privacy-hardened.patch.yml --guard audit
#    → dsh_* は PASS、x-deepseek-harness-user-id は FAIL のはず（設定では止められない）

# 3) 日常運用（今日から）
./dsh-hardened.sh web

# 4) フォーク
git clone https://github.com/deepseek-ai/deepseek-harness /c/src/dsh-hardened && cd /c/src/dsh-hardened
git tag -l 'dsh-v0.2*' | tail -5 && git checkout -b hardened <検証するタグ>
mkdir hardening && cp -r /c/tools/dsh-hardened/* hardening/
node hardening/fork/apply-hardening.ts --dry-run       # REQUIRED が全部 APPLY/OK か確認
node hardening/fork/apply-hardening.ts && git diff --stat
pnpm install --frozen-lockfile && pnpm run build
node hardening/wire-test.ts --cmd "pnpm dsh" --no-env-optout --guard audit   # 期待: PASS
git add -A && git commit -m "hardening: fail-closed outbound sharing"
DSH_ENTRY="<fork の dsh エントリ>" /c/tools/dsh-hardened/dsh-hardened.sh web    # 二重化して起動
```

> VS Code で `cordis.patch.yml` に "Unresolved tag: tag:yaml.org,2002:js" と表示される場合は、settings.json に `"yaml.customTags": ["!!js scalar"]` を追加する（表示上の問題で、DSH の動作には影響しない）。

---

## 9. 検証結果

### 9.1 egress guard（Node v24.22.1、外部ネットワークなし）

```
  ok  fetch(string) strips dsh_* body keys and x-deepseek-harness-* headers, keeps auth
  ok  fetch(Request) path strips body + headers
  ok  gzip body is decoded, stripped and re-encoded
  ok  x-deepseek-harness-session-id kept only for explicitly allowed host; user-id always removed
  ok  fetch to *.deepseeksvc.com rejected (EGRESS_BLOCKED)
  ok  https.request / https.get blocked with error event, unlistened error does not crash
  ok  named ESM import { request } from node:https is guarded
  ok  dns.lookup / dns.promises.lookup / net.connect cannot resolve deny-listed hosts
  ok  strict allow-list denies everything else, loopback always allowed, deny-list wins
  ok  non-JSON / non-object bodies are passed through unchanged
  ok  audit mode logs but does not modify (for baseline measurement)
  ok  audit log has 13 metadata-only records (no canary, no token, no id values)

ALL 12 CHECKS PASSED  (guard policy mode=enforce)
```
追加確認: Worker（eval / URL / パスの各指定方法）、子 Node プロセスで `EGRESS_BLOCKED` になること。`workerData` と `import.meta.url` が保持されること。`tsc --strict`（`erasableSyntaxOnly`）でエラー 0。
発見と修正: ① `agent:false` を指定すると Node が既定の Agent を作り直し、`createConnection` が無視される → 専用の Agent を使うように修正。② `--import` は Worker に継承されない → Worker のラッパーを追加。

### 9.2 wire-test の判定ロジック（stock / hardened を模した疑似プロセス）

| ケース | 結果 |
|---|---|
| stock を模したプロセス、guard=audit | **FAIL**: `dsh_session_log` / `dsh_plugin_packages`、user-id / session-id ヘッダ、canary の混入、collector への接続試行、`.anonymous-user-id` の生成をすべて検出 |
| 同じプロセス、guard=enforce | 本文・ヘッダは PASS。collector への試行は「blocked」の WARN として報告（設定やフォークで直すべき点として可視化） |
| hardened を模したプロセス | **全項目 PASS** |

### 9.3 codemod（upstream と同形のフィクスチャ）

- 1 回目: 16 件を適用（7 ファイル、+45/−11 行）。2 回目: 0 件適用・16 件は既に適用済み（冪等）。
- アンカーを壊した場合: `FAIL P1a ... anchor-not-found` で **exit 2**（無言のまま無効化されない）。
- 変更後の YAML は `!!js` タグを含めてパース可能。変更後の TS は構文エラー 0。メソッド定義・`globalThis.fetch`・コメント中の `fetch(` は置換されないことを確認。

### 9.4 未検証の事項（実機で確認が必要）

- 本物の upstream ソースへの codemod 適用（アンカーの実位置）。→ `--dry-run` で REQUIRED が全部 APPLY/OK になることを確認する。
- 本物の DSH 0.2.x に対する wire-test。特に `DEEPSEEK_BASE_URL` を mock に向けた場合の到達性（#9927 で同じ手法の有効性は報告されている）。
- Desktop（Electron）に `NODE_OPTIONS` が伝播するか。
- `dsh-hardened.ps1` の実行（本環境には pwsh がないため。引数は `$args` を手動で解析する設計）。
- session-id ヘッダを外したときのキャッシュヒット率への影響。

---

## 10. 残るリスク

| リスク | 対処 |
|---|---|
| 通常のモデル入力（messages / tools）は選択したプロバイダに送られる | ガードの対象外。機密度に応じてプロバイダを選ぶ（ローカル LLM / 社内ゲートウェイ） |
| サードパーティのプラグインはホスト権限で動作する | プラグインを pin、レビュー、allow-list 化。guard は L1〜L3 で検知・遮断する |
| ツールが起動するシェルや MCP サーバーの外部通信 | guard は Node の子プロセスにしか効かない。OS ファイアウォールや VM で制御する |
| upstream が新しい送信経路を追加する（`dsh_*` 以外の名前、別ホスト） | 未知の `dsh_*` は fail-closed で除去。厳格な allow-list と、CI の wire-test（「その他の外部送信」が WARN になる）で検知する |
| 0.2.2-rc.1 の web fetch で SSRF の制限が外れた | allow-list 運用、または fetch プロバイダを無効化 |

---

## 11. 出典

**公式（deepseek-ai/deepseek-harness）**
- session-log-deepseek README: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-log-deepseek/README.md
- base composition: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/base/cordis.patch.yml
- llm-deepseek adapter.ts: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-deepseek/src/adapter.ts
- llm-deepseek README: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-deepseek/README.md
- deepseek-llm-api-extensions: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/deepseek-llm-api-extensions
- plugin-package-inventory-deepseek README（ミラー）: https://github.com/PlayForm/Harness-DeepSeek/blob/master/packages/llm/plugin-package-inventory-deepseek/README.md
- anonymous-user-id README: https://deepseek-plugin.org/plugins/deepseek-ai/deepseek-harness/packages/identity/anonymous-user-id
- Session telemetry リファレンス: https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session-telemetry
- DeepSeek Search & Fetch API: https://api-docs.deepseek.com/guides/search/

**GitHub Discussions（一次報告）**
- #8527 https://github.com/deepseek-ai/deepseek-harness/discussions/8527
- #9927 https://github.com/deepseek-ai/deepseek-harness/discussions/9927
- #11834 https://github.com/deepseek-ai/deepseek-harness/discussions/11834
- #7247 https://github.com/deepseek-ai/deepseek-harness/discussions/7247
- #6847 https://github.com/deepseek-ai/deepseek-harness/discussions/6847
- #7725 https://github.com/deepseek-ai/deepseek-harness/discussions/7725
- #952 https://github.com/deepseek-ai/deepseek-harness/discussions/952
- #4100 https://github.com/deepseek-ai/deepseek-harness/discussions/4100
- #1365 https://github.com/deepseek-ai/deepseek-harness/discussions/1365 / #2208 https://github.com/deepseek-ai/deepseek-harness/discussions/2208

**フォーク・解説**
- 時雨堂 fork 解説: https://voluntas.ghost.io/deepseek-harness-fork/ ／ 変更一覧: https://gist.github.com/voluntas/34ac1f8ced7052d69dc37f54fc57155c
- 0xSmartis/deepseek-harness-privacy: https://github.com/0xSmartis/deepseek-harness-privacy
- Magnus Hedemark, "DeepSeek Harness: What I Found Before I Let It Run": https://magnus919.com/2026/08/deepseek-harness-what-i-found-before-i-let-it-run/
- DSH の Web 検索・取得の設定（0.2.2-rc.1）: https://52dsh.com/tutorials/dsh-web-search-fetch-guide/
- ローカル LLM と llm-pi-ai: https://zenn.dev/amu_lab/articles/deepseek-harness-local-llm-ollama-guide-2026
- 構成レイヤー: https://deepseekdocs.com/en/docs/user-guide/configuration ／ https://www.xuanyuancode.com/learn-deepseek-harness/lessons/profile-bundle-patch
- コミュニティのプライバシー文書（既定値の記載が upstream と矛盾）: https://deepseekdocs.com/en/docs/user-guide/privacy
