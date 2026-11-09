# DeepSeek Harness (dsh) プラグイン調査レポート
開発・設計・調査・テスト能力を高めるプラグインの比較検討

- 調査日: 2026-11-09 前後（各サイトの表示時点。スター数は日々変動）
- 対象: 現在 DeepSeek API / GLM(z.ai) subscription / GitHub Copilot の3プロバイダー接続済み、プラグインは Copilot 連携のみ利用
- ユーザー背景: 組み込みファームウェア（C / NORTi・FreeRTOS / Renesas RX・RZ）、業務外で Rust・C#・Python・TypeScript、Windows 11 + Git Bash、Claude Code / Roo Code / Codex 併用、キャッシュヒット率とテレメトリに高い関心

---

## 0. 調査の前提と限界（先に読んでください）

1. **Reddit / Medium の直接ヒットは少なかった**。実際に取得できた情報源は GitHub（リポジトリ・Topics・Discussions）、Qiita / Zenn / note の技術記事、Composio のブログ、および複数のコミュニティ運営カタログ（dsh-plugin.org, harnesscatalog.com, deepseek-plugin.org, dsh.so 等）。Reddit / Medium の評判を根拠にした記述はこのレポートにはありません。
2. **カタログ系サイトは非公式**で、スター数・件数（約1.4万〜2.9万件と、サイトにより大きく異なる）・「Verified」の定義がバラバラ。「Verified」は動作確認や構造チェックの意味であり、**セキュリティ監査ではない**と各サイト自身が明記しています。
3. **スター数は親リポジトリの値が混ざる**（例: OpenViking / Hindsight / MemOS / WeKnora / archify はモノレポや他エージェント向け本体の星で、dsh 用サブパッケージ単体の人気ではない）。
4. dsh は **developer preview** で、公式 README が互換性を壊す変更があると明記。プラグインは dsh のバージョンに強く依存します（後述の dsh-tool-tdd の例）。
5. 私が実際にインストール・実行して検証したものはありません。「機能」はリポジトリ README / 各カタログ記載に基づきます。「あなたへの適合度」は私の判断です。

---

## 1. 結論（優先導入ロードマップ）

| 優先 | 目的 | 第一候補 | 理由 |
|---|---|---|---|
| 0 | 安全な土台 | テスト用プロファイル + `dsh-plugin-vetting` または `dsh-vet` | プラグインは dsh と同一プロセスで動き、ファイル・シェル・環境変数（APIキー）に届く。テレメトリを気にするあなたには必須 |
| 1 | 開発規律 | `superpowers-dsh`（LayneChai）か `Aegis` のどちらか一方 | TDD・体系的デバッグ・計画・レビューの手順をスキルとして注入 |
| 1 | コード理解 | 公式 `dsh-lsp` 系 + `dsh-tool-lsp`（community） | grep ではなく言語サーバーで定義・参照・診断を取得 |
| 1 | レビュー | `dsh-review`（yutingzhao1991） / `dsh-review`（Viger1） / `dsh-review-squad` | 既に使っている Claude Code・Codex をレビュアーにできる／偽陽性を減らす／役割別に別モデルを割り当てる |
| 2 | コスト・キャッシュ | `dsh-context` + `dsh-client-ui-cache-hit` + `dsh-cache-probe` | Copilot / DeepSeek / GLM の経路ごとのキャッシュ実測と、コンテキスト構成の可視化 |
| 2 | 並列化 | `dsh-agent-teams` | 3プロバイダーを役割別に振り分ける土台になる |
| 3 | 調査 | 検索プロバイダー系 + `BrowserSkill` + `dsh-obsidian` / `WeKnora` | 検索・ログイン済みブラウザ操作・ナレッジ参照 |
| 3 | 設計 | `archify` | コードベースや設計から検証可能な図を生成 |
| 4 | 組み込み | `dsh-serial-console` | モデルが UART（U-Boot / MCU シェル）を直接操作でき、人とモデルが同じセッションを共有 |

**避ける／慎重にするもの**: `dsh-our-free-model`（ログイン・APIキー不要の無料フロンティアモデル）は高スターだが、プロンプトの送信先が不明確になり、テレメトリを警戒している方針と相性が悪い（私の評価）。詳細は §3.12。

---

## 2. エコシステム概況

- dsh は「Everything is a Plugin」。モデル・ツール・スキル・サンドボックス・セッション保存・UI・エージェントループまでプラグイン（Cordis 上）。
- 公式リポジトリ `deepseek-ai/deepseek-harness` は 27万超スター。`dsh-plugin` トピックに数万リポジトリ。
- 主要カタログ／発見経路
  - awesome-dsh-plugin（GitHub）: dsh 0.2.1+ では Plugins → Discover → Index sources に `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json` を追加すると、アプリ内で検索可能。
  - `dsh-market`: 設定画面内のプラグインマーケット。`dsh plugin --profile web add dshmarket`
  - `dsh-find-plugin`: エージェントにプラグインを探してもらう。
  - 公式 experimental `dsh-experimental-plugin-market-bundle`: プラグインインデックスから探せる Discover タブ。
- 基本コマンド: `dsh plugin --profile web add <npm名 | github:owner/repo>`、確認は `dsh --profile web --dump-config`。
- Windows 注意: プラグイン管理に pnpm を使う。pnpm ≥10 はビルドスクリプトをブロックするため、初回 add が失敗したら `allowBuilds` の指示に従い profile の `pnpm-workspace.yaml` に追記して再実行（dsh-meow-memory の README より）。
- 公式 experimental プラグイン（Zenn の記事より、0.2.2-rc.1 時点）: `agent-team-profile` / `session-search` / `terminal-bundle` / `tool-worktree` / `forge-bundle` / `plugin-market-bundle` / `session-titles-bundle` / `inspector-profile` / `badge-skill-bundle`。コミュニティ導入の前に、まずこれらを有効化するのが安全で効果が大きい。

---

## 3. カテゴリ別の詳細と比較

### 3.1 開発規律（スキル／方法論パック）

| プラグイン | 概要 | 規模 | 強み | 注意点 |
|---|---|---|---|---|
| **superpowers-dsh**（LayneChai） | obra/superpowers の 14〜15 スキル（brainstorming, writing-plans, subagent-driven-development, TDD, systematic-debugging, code review, worktree 隔離）を dsh の skill 登録に移植 | 約140〜150★ | 実行時依存ゼロ。上流 v7.0.x に追従。`skill` ツールで任意ロード | プリセットではなくスキル集。ライセンス表記が一部カタログで未記載 |
| **dsh-superpowers**（goodjin） | Superpowers を**エージェントプリセット**として提供（15スキル + ペルソナ）。**スキルごとにサブエージェントのモデルを設定画面で指定可能** | 0★ / v0.2.0（11月更新） | 「デバッグは大モデル、テスト生成は安価モデル」を実現。3プロバイダー運用と相性が最良 | 新しく実績が薄い。`delegate_skill` 経由の運用 |
| **dsh-superpowers**（oThTJx / firefly0621） | 35スキルを core / advanced / product / authoring に分割。既定は 19 スキルの core + セッション開始ブートストラップ | 0★ | 網羅的 | 公式 dsh-base には含まれない opt-in。バージョンが rc 系で変動 |
| **Aegis**（GanyuanRan） | 22 の方法スキル。コード編集前に実際のベースラインを読む、エラー時は根本原因調査、完了時は検証証拠を要求。セッション開始／再開／clear／compact で短いルーティング指示を注入 | 約1.1k〜1.4k★、v2.15.0、MIT | 作者の固定ベンチマークで契約合格率 61.67%→93.33%、危険な結果 13.33%→0%（**作者自身の限定的な助言レベルの証拠**。Codex 上の測定で dsh での結果ではない） | 公式文書上、dsh では薄いバンドルで「ハード強制ではなく指示」。Superpowers 系との**併用は指示が重複しトークンが増える**ため避けるのが無難（私の判断） |
| mattpocock-skills-dsh | Matt Pocock のスキル 25 本（TDD, grilling, code-review, wayfinder 等） | 28★ | 小粒で読みやすい | 個人移植で更新頻度は不明 |
| keel（spec-driven） | 仕様先行・前提検証・過剰設計抑止のスキルパック | 2★ | 軽量 | 実績薄 |

**比較・推奨**
- まず **superpowers-dsh か Aegis のどちらか1つ**。「手順を型にはめたい」なら superpowers、「大規模既存コードで勝手な再設計を防ぎたい」なら Aegis。組み込み既存資産（NORTi / FreeRTOS ベースの長期ブランチ）には Aegis の baseline-first が合うと考えられるが、検証はしていない。
- 複数プロバイダーを役割で使い分けたいなら goodjin の dsh-superpowers が唯一モデル配分を一級機能にしている。

### 3.2 テスト

| プラグイン | 機能 | 対応フレームワーク | 状態 |
|---|---|---|---|
| **dsh-test-runner**（suimi8） | `test_run` ツール。フレームワーク自動検出、失敗要約のみ返却（トークン節約）、失敗のみ再実行、独自コマンド上書き、タイムアウト | vitest / jest / pytest / node:test | 3★、8/14 公開、MIT。パース失敗時は exitCode + 出力末尾に退避 |
| **dsh-tool-tdd**（Xiaooooo434680） | `tdd_test` / `tdd_parse`。失敗を file:line・期待値/実際値・分類で構造化。TDD スキル同梱で red→green ループ | Jest / Vitest / Pytest / Go / Rust(cargo) / TAP / tsc | 0★。**宣言互換が dsh 0.1.x のみ。dsh.so の検証では 0.2.1-rc.3 でインストール拒否（要 allow-version）** |
| 公式 `tool-worktree` / Forge | git worktree 作成・移動、変更リクエストパネル | — | 公式 experimental |

**あなたへの意味**
- C 言語の組み込みテスト（Unity/Ceedling 等）は **どのプラグインの自動検出対象でもない**。`command` 上書きで実行はできるが構造化要約は期待できず、「exitCode + 出力末尾」止まりになる（READMEからの推論）。C 向けは、自作の薄いラッパー（クリエイターモードで作成）か、要約をスキルで指示する方が現実的。
- Rust / TypeScript / Python の個人開発には dsh-test-runner、Rust・Go を扱うなら dsh-tool-tdd が適するが、互換性の確認が先。

### 3.3 コードレビュー

| プラグイン | 方式 | 強み | 注意点 |
|---|---|---|---|
| **dsh-review**（yutingzhao1991） | diff を CLI エージェント（codex, claude, gemini, opencode, cursor, 任意コマンド）または dsh サブエージェントへ並列に渡し、1本の統合レポート。review モード（quick/deep 等）を保存 | **既に使っている Claude Code / Codex をレビュアーにできる**。プロバイダー・認証情報は dsh 設定を再利用 | 1★、10月公開 |
| **dsh-review**（Viger1） | **敵対的レビュー**: 観点別（正確性・ライフサイクル/並行性・API契約・セキュリティ）の finder が失敗シナリオ付きで報告 → 各指摘を独立 verifier が反証。生き残りのみ報告 | 偽陽性対策が明確。`depth: quick` はコスト約1/3。並行性観点は RTOS コードに有用 | 同名で別物（作者が違う）。コストは finder×verifier 分増える |
| **dsh-review-squad**（luomeii） | `/review` で security / correctness / tests / style の4名の読み取り専用サブエージェント。**各役割に別モデル・思考強度を指定可** | 「セキュリティは強いモデル、スタイルは安価モデル」 | 1★ |

**推奨**: 品質重視なら Viger1（敵対的検証）、コスト配分重視なら review-squad、既存エージェントの目を借りるなら yutingzhao1991。同時に全部は不要。

### 3.4 コードインテリジェンス（LSP）

| 実装 | 提供 | 操作 | 備考 |
|---|---|---|---|
| **公式 `dsh-lsp` / `dsh-lsp-stdio` / `dsh-tool-lsp`** | 公式パッケージ群（ctx.lsp、stdio 言語サーバー、モデル向け `lsp` ツール） | goToDefinition / findReferences / goToImplementation / hover の **4 操作のみ**（汎用 JSON-RPC の抜け道なし＝意図的なセキュリティ境界） | 設定は profile の patch で言語サーバーを指定 |
| **dsh-tool-lsp**（jaylor-wang、npm） | 診断・フォーマット・セマンティック rename・コードアクション・シンボル検索の 5 ツール | 書き込みは dsh のファイル観測ポリシー経由で競合時は LSP_WRITE_CONFLICT | 既定オフ。サーバーは PATH 上に必要。2★ |
| **dsh-lsp-bridge**（voidmind26） | 読み取り専用（hover/definition/references/symbols/diagnostics）、複数言語・マルチルート。`lsp_setup` で診断→インストール→設定→起動検証 | インストールコマンドは固定の許可リスト、サーバーは dsh 専用ディレクトリへ | 0★、9月 |
| dsh-lsp-plugin（KeynoWu） | — | — | **アーカイブ済み**（dsh-omp-tools に統合）。使わない |

**あなたへの意味**: C（RX/RZ）では clangd 等が自然な候補だが、CC-RX 等のベンダーコンパイラ向けの `compile_commands.json` 整備が前提になる（私の見立て。各プラグインの C 対応実績は確認できていない）。まず公式 4 操作で試し、診断・rename が欲しければ jaylor-wang 版を追加するのが段階的。

### 3.5 マルチエージェント／並列作業

| プラグイン | 内容 | 規模 | 注意点 |
|---|---|---|---|
| **dsh-agent-teams**（NanmiCoder） | 現セッションが「キャプテン」になり、継続可能なサブエージェントを編成、依存関係付きタスクを分割、直接メッセージで連携。Web UI にタスク DAG とアクティビティパネル。**実行前に計画（ロスター+DAG）を承認**、品質ゲート（要件→実装→検証→レビュー→統合）あり | 約2.7k★、v0.1.29、MIT、最新 dsh 0.2.2 での検証を継続 | Open issue が多め（約79）。スコープ制御は「完了時の監査」で書き込みの事前阻止ではない |
| 公式 `agent-team-profile` | 複数エージェント協働のツールと UI | 公式 experimental | まずこちらを試す価値あり |
| DSH-better-sidebar | ファイル編集・ターミナル・Git・ブラウザ・サブエージェントページを同居させるサイドバー基盤 | 約3.8k〜4.8k★ | UI 基盤。他プラグインが新タブを登録できる |

**推奨**: 3プロバイダーを「大モデル=設計・難所、安価=雑務」に振り分けるなら agent-teams（メンバーごとのモデルルート、ホストのモデルカタログ利用）。

### 3.6 コンテキスト・メモリ・コスト・キャッシュ（あなたの関心領域）

| プラグイン | 機能 | 規模・状態 | キャッシュ観点 |
|---|---|---|---|
| **dsh-context** | Context パネル／ブラウザ／`/context`。コンテキストの構成・推移・圧縮・剪定イベントを可視化 | 1.2k〜4k★（情報源により差）、導入直後から有効（ビルド・再起動不要） | **何がキャッシュを壊したか原因調査に使える**（推論） |
| **dsh-client-ui-cache-hit** | サイドバーにキャッシュ命中率（命中÷(命中+未命中+書込)）、分段バー、≥70% 緑／40–70% 琥珀／<40% 赤、直近リクエスト命中率。ブラウザ側のみ・ネットワーク送信なし | 0★、新規 | リアルタイム監視に最適。ただし **DeepSeek 系の tokenUsage 項目前提**（READMEが DeepSeek コンテキストキャッシュを前提）で、Copilot / GLM 経路で値が出るかは未確認 |
| **dsh-cache-probe** | チャネル試験ページ: キャッシュヒット率（ウォームアップ+再試験N回）、TTFT、出力 tok/s、実トラフィック基準との比較、ペリカン SVG 描画テスト | 0★、11/5 公開 | **リレーやモデル切替後に「本当にキャッシュが効くか」を数値化**。cold 化の検知に有用 |
| **dsh-compaction-cacheaware** | Reasonix 由来のキャッシュ配慮型コンパクション。`@deepseek-ai/dsh-compaction-basic` の代替として ctx.compaction に差す。自動トリガーは `compact_ratio`（既定 0.8）1本 | 1★ | **cold 後の再ウォームを抑える設計思想**に合致。ただし README 上、パッケージ導入だけでは preset の realm は置換されない（追加設定が必要） |
| **dsh-meow-memory** | 7 層 SQLite 記憶（soul/user/project/fact/lesson/topic/rules）、BM25 検索、窓ごとの dream 整理、圧縮後の再注入。静的な guide セクションで **KV キャッシュを壊さない設計** | 約379★、v0.31.0。README は dsh 0.1.5 互換と記載 | 注入位置が user メッセージの前の別スナップショットで、プロンプトを書き換えない。現行 dsh での動作は要検証 |
| **OpenViking（dsh-memory-plugin）** | 事前ステップの自動 recall とプロファイル注入、セッション記録、`viking://` URI 保護、recall/write ツール。OpenViking サーバーが必要 | 親リポジトリ 34k★ | サーバー運用が前提。データが外部サービス側に残る場合の扱いは要確認 |
| **Hindsight（coding-agents）** | 長期プロジェクトメモリ、自動 recall/retain、ナレッジページ、リポジトリ別メモリバンク | 親リポジトリ 22k★ | |
| **MemOS (memos)** | 各タスク前の永続的 recall、各ターン後の経験記録 | 12.2k★ | |
| **dsh-mnemon** | 設定・プロジェクト文書・検索可能なセッション横断メモリ | — | Composio の推奨リストに掲載 |
| 公式 `session-search` | 同ワークスペースの過去セッションをエージェントが検索 | 公式 experimental | まず導入（外部依存なし） |
| **dsh-cost-meter** | セッション／日次コスト、予算%、残高、履歴ダッシュボード、価格の自動同期（ピーク/オフピーク対応） | 約597★ | DeepSeek 課金向け |
| **TokenLedger** | リレーサイト・プロジェクト・モデル別のトークン使用量、残高、サブスク枠 | 約202★ | 複数経路の集計に向く |
| deepseek-balance-whale-widget | 残高・日次支出・ターン単価をウィジェット表示 | 約599〜6.7k★（記載差あり） | |

**推奨の組み合わせ**: `dsh-context`（原因可視化）+ `dsh-client-ui-cache-hit`（常時監視）+ `dsh-cache-probe`（定期試験）。コンパクションの差し替えは最後（影響範囲が大きいので、テストプロファイルで実測してから）。メモリ系は **1つだけ**（まず meow-memory か Hindsight のようにローカル完結かどうかを確認）。複数入れると注入が重複しキャッシュ観点でも不利になりうる（私の推論）。

### 3.7 調査（検索・ブラウザ・ナレッジ・視覚）

| 領域 | プラグイン | 要点 |
|---|---|---|
| 検索 | `dsh-free-search` | DuckDuckGo バックエンド、APIキー不要 |
| | `SAC_search` | 約200のキー不要検索エンジンのメタ検索、実行時依存ゼロ |
| | `argo` | CN/EN・学術・コード・ショッピング・金融・ニュースの多言語検索 |
| | `dsh-web-search-pro` / `anysearch-dsh` / `modsearch` | 複数エンジン・プロバイダー |
| | `dsh-scholar` | 学術検索 |
| ブラウザ | **BrowserSkill**（Tencent、dsh 用 `@wxg-prc-cpg/browser-skill-dsh-plugin`） | ログイン済みの実 Chrome/Edge を別 Agent ウィンドウで操作。11 個の `browser_*` ツール、最大5セッション並列、自分が起動したセッションのみ操作、`lazyTools` でスキーマをプロンプトに出さない。本体 10.2k★、MIT。要 `bsk` CLI + ブラウザ拡張。dsh ^0.1.5-rc.3 / ^0.2.0-rc.1 対応を宣言 |
| | dsh-mcp-bridge（imaused） | stdio MCP を dsh ツール化（Playwright MCP 向け）。0★ |
| ナレッジ | **WeKnora（dsh-weknora）** | ナレッジベースへの読み取り専用 4 ツール（一覧、ハイブリッド検索、文書再構成、引用付き RAG/ReAct 回答）。親 21k★。**医療データ×RAG 構想がある場合は設計の参考になる** |
| | dsh-obsidian | ローカル Obsidian vault を MCP なしで検索・読書き・移動 |
| | Mirage | ファイルシステムを仮想化し S3/Redis/Slack/Gmail/Notion/PostgreSQL 等をワークスペース風に扱う（Qiita 紹介） |
| | dsh-mimir-academic-research | 文献検索から LaTeX 出力・発表スライドまで9ビュー（約550★） |
| 視覚 | `modlens` | テキスト専用モデルに画像（OCR・レイアウト・関係抽出）を与える視覚ブリッジ（約3.4k★） |
| | `dsh-vision-toolkit` / `dsh-vision` / `dsh-vision-router` | 長大スクショ OCR、グラウンディング、UI 復元、任意の OpenAI 互換 VLM ブリッジ |

**注意**: BrowserSkill は実ログイン状態に触れる強力な権限を持つ。社内サイト・VPN 環境で使う場合は、対象タブ・セッションの明示と、テストプロファイルでの確認が前提。

### 3.8 設計・可視化

| プラグイン | 内容 | 注意 |
|---|---|---|
| **archify** | コードベースやシステム記述から、検証済み・自己完結の対話型図（アーキテクチャ／ワークフロー／シーケンス／データフロー／ライフサイクル）を生成。dsh 用は `integrations/deepseek-harness` | 本体は94k★だが dsh 用サブパッケージ単体の評価ではない。ファームウェアのタスク/割り込み/メッセージキュー関係図の叩き台に有用そう（私の見立て） |
| open-design | ローカルファーストの設計エージェントワークスペース（HTML/スライド/動画等） | 105k★（本体）。ファームウェア設計には直接は不要 |
| dsh-genui / dsh-visualize | 応答内にインタラクティブ UI（チャート・フォーム・mermaid・3D・HTML カード）を描画 | 設計レビュー資料・クイズ化に有用 |
| dsh-openpencil | OpenPencil のデザイン編集 | 約206★ |

### 3.9 組み込み開発

| プラグイン | 内容 | 検証状況 | 注意 |
|---|---|---|---|
| **dsh-serial-console**（InfinitePersistence） | **人間とモデルが同じ UART セッションを共有**。xterm ベースの VT 端末（Ctrl+F 検索、Text/HEX 表示）、来源マーカー（U=ユーザー、M=モデル、B=ボード、S=システム）、監査ログ。モデルツール: `serial_list_ports` / `serial_connect` / `serial_send` / `serial_read` / `serial_expect` / `serial_mark` | 12★、29コミット、dsh 0.2.2-rc.1 対応作業が進行中（rc.6 候補） | アクティブポートは1つのみ、自動再接続なし、シェルのエコーが無効だと入力が表示されない、ユーザー/AI の入力権リースなし（README 記載）。**モデルが実機へコマンドを送る**ため、承認フローを必ず有効にし、破壊的コマンド（フラッシュ消去等）が流れない運用にする |
| **dsh-serial-debugger**（floydc-sz） | 右サイドバーの XCOM 風シリアルアシスタント（ポート・ボーレート・16進表示・DTR/RTS・定周期送信・ファイル送信・受信保存） | 1★。dsh.so で dsh 0.2.1-rc.2 に対し L5 runtime verified | **モデル向けツールではなく人間用 GUI**。ネイティブビルド不要と記載 |

**使い分け**: 起動ログ確認・U-Boot・MCU シェル・AT コマンドをモデルに任せるなら serial-console。手動デバッグだけなら serial-debugger。どちらも Renesas RX/RZ 実機での動作確認情報は見つからなかった。

### 3.10 外部接続（MCP・アプリ連携）

| プラグイン | 方向 | 内容 |
|---|---|---|
| 公式 MCP クライアント（`packages/mcp`） | 外部 MCP → dsh | 公式。まずこれを使う（あなたが codex で使っていた `shimai-mcp` 相当の接続も基本はこちら） |
| dsh-plugin-mcp（menotbobbybrown） | 外部 MCP → dsh | stdio/SSE/WebSocket 対応の汎用ブリッジ、ツール名のプレフィックス化、ライブダッシュボード。4★ |
| dsh-mcp-bridge（imaused） | 外部 MCP → dsh | stdio MCP をネイティブツール化（Playwright 向け） |
| dsh-mcp-bridge（liiiubai） | **dsh → 外部** | dsh のツールを MCP サーバー（streamable HTTP）として公開。Claude Code / Codex から dsh を呼べる。許可リスト方式、dsh のサンドボックス/承認を維持。2★ |
| Composio | 外部アプリ | 1,500+ アプリ連携、認証・スコープ・トークン更新を代行（ブログ紹介）。**認証情報が外部サービスを経由するため、ガバナンス確認が必要** |

### 3.11 UI・運用基盤

| プラグイン | 要点 | 規模 |
|---|---|---|
| dsh-market / dsh-plugin-hub | アプリ内マーケット、1クリック導入/更新/テーマ、診断・バックアップ | 約10k★（dsh-market） |
| dsh-web-ui（zhu1090093659） | タスクボード・Git グラフ・右パネル・モバイル遠隔 UI・トークン統計・スキンセンター | 約10k★ |
| DSH-better-sidebar | VS Code 風のサイドバー/下部パネル基盤 | 約3.8〜4.8k★ |
| dsh-TUI / dsh-tianshu-tui | Claude Code 風のフルスクリーン TUI（ダブルEsc 巻き戻し、コンテキスト進捗、TPS）。tianshu は TDD ワークフロー内蔵 | dsh-TUI 約2.2〜6.5k★ |
| dsh-at-file | `@file` メンション | 約559〜667★ |
| dsh-pocket / ds-harness-remote | スマホから操作（QR/トンネル、E2E暗号） | 約1.2〜2.7k★ |

**注意**: リモート操作系は公開面を増やす。公式は「初回検証で公開IPに bind しない」ことを推奨。

### 3.12 セキュリティ・信頼性（最優先で理解すべき点）

- 公式の安全上の注意: developer preview であり、セキュリティ監査を受けておらず、本番利用向けではない。プラグインは信頼できる出所のものだけを導入し、事前にレビューすること。
- dsh-plugin トピックにはなりすまし・タイポスクワットの余地があり、インストール時スクリプト（postinstall）や依存パッケージ経由の攻撃は npm と同様に成立する（dsharness.org の検証ガイドの指摘）。公式 Discussions にも、Full Access セッションがホームディレクトリを消去した事例を踏まえたプラグイン監査ツールの紹介がある。
- 監査ツール3種

| ツール | 方式 | 特徴 |
|---|---|---|
| **dsh-vet**（rogerdigital） | `npx dsh-vet <plugin>` でインストール・実行せずに静的監査。決定的な `dsh-vet/v1` レポート、A–F グレード、低信頼度の指摘は減点しない | ルールごとに公開根拠と誤検知の申し立てテンプレート。11パッケージの校正記録を公開 |
| **dsh-plugin-vetting**（truelove-dreamer） | プラグイン（v0.5.6）。15の悪性ルール（外部送信・資格情報アクセス・コード実行・永続化・**セッションログ読み取り**・ライフサイクルスクリプト）、過剰権限の指摘、推移的依存、公式パッケージのハッシュ基準、ツールゲーティング | `plugin_vet` ツール／`/plugin-vet`。ブロックはせず報告のみ。ライセンス表記なし |
| **dsh-plugin-vet**（wulun811） | 静的11ルール + LLM 監査プロトコル + スコアカード + 任意の実行時ガード（fs / child_process フック）とハニーポット | 既定は監視・通知のみで、自動削除しない |

- **dsh-our-free-model（約56k〜66k★）への所見**: 「ログイン・登録・APIキー不要で DeepSeek V4.1 Flash や Kimi K3 を無制限無料」という説明。誰のインフラ・どの経路にプロンプトが流れるかが利用者に見えにくく、収益・運営主体も README 説明からは判断できない。あなたの「不要な外向きデータを最小化したい」という方針とは合わないため、**業務コード・社内情報では使わない**ことを推奨（私の評価。悪意の証拠があるという意味ではない）。
- **BrowserSkill のなりすまし疑い**: deepseekharness.dev に「Tencent BrowserSkill Enterprise Web Agent & Crawler（`@tencent/browserskill-agent`、captcha 自動突破・anti-ban 等）」というページがあるが、Tencent/BrowserSkill 本家 README と dsh 用パッケージ（`@wxg-prc-cpg/browser-skill-dsh-plugin`）にそのような機能記述はなく、パッケージ名も異なる。**導入するのは本家 README に記載のパッケージ名のみ**にする。
- dsh.so の検証例: `dsh-tool-tdd` は「宣言互換 dsh 0.1.x」で、0.2.1-rc.3 では公式のインストールゲートが拒否（`allow-version` で回避可能だが非推奨）。**互換範囲の宣言と dsh のバージョンの照合は導入前に必須**。

---

## 4. あなた向け推奨構成

### フェーズ0: 安全な土台（先に）
1. クリエイターモードでテスト環境を作る（Zenn の記事の方法: 本番の `DSH_HOME` を丸ごとコピーして別ポート 3081〜 で起動する `dsh-test` 的な CLI を作ってもらう）。新規プラグインは**必ずここで先に試す**。
2. `npx dsh-vet <plugin>` で導入前スキャン、または `dsh-plugin-vetting` を常設。
3. バージョンを固定（`@x.y.z` または commit ハッシュ）。`postinstall` と依存を確認。
4. 公式 experimental（`session-search`, `terminal-bundle`, `tool-worktree`, `inspector-profile` など）を機能を見ながら有効化。
5. 本番 profile の環境変数にある API キー（DeepSeek など）をテスト環境へ持ち込まない（テスト専用キーを使う）。

### フェーズ1: 開発・テスト・レビュー
- スキル: `superpowers-dsh` か `Aegis` を1つ。
- LSP: 公式 `dsh-lsp` 系 → 必要なら `dsh-tool-lsp`。
- レビュー: `dsh-review`（Viger1）または `dsh-review-squad`。
- テスト: 言語別（Rust/TS/Python は `dsh-test-runner`）。C 組み込みは独自コマンド + スキルで運用。

### フェーズ2: マルチプロバイダー最適化
- `dsh-context` + `dsh-client-ui-cache-hit` + `dsh-cache-probe` で経路別（DeepSeek / GLM / Copilot）のキャッシュ実測を取り、cold 化の原因を特定。
- `dsh-agent-teams` または goodjin の `dsh-superpowers` で、役割別にモデルを割り当て。
- 効果が確認できてから `dsh-compaction-cacheaware` や記憶系プラグイン（1つ）を検討。

### フェーズ3: 調査・設計・組み込み
- 検索プロバイダー（`dsh-free-search` か `SAC_search`）、`BrowserSkill`、`dsh-obsidian`、（医療 RAG 設計の参考に）`WeKnora`。
- `archify` で設計図生成。
- `dsh-serial-console` で実機ログ確認（承認フロー必須）。

### 導入しない／後回し
- `dsh-our-free-model`、出所不明の「Enterprise」「無制限」系、親リポジトリのスターだけが高いサブパッケージ、アーカイブ済み（dsh-lsp-plugin）、互換宣言が現行 dsh に合わないもの。

---

## 5. 総合比較マトリクス（主要プラグイン）

| プラグイン | 開発 | 設計 | 調査 | テスト | コスト/キャッシュ | リスク | 導入コスト |
|---|---|---|---|---|---|---|---|
| superpowers-dsh | ◎ | ○ | – | ◎ | – | 低 | 低 |
| Aegis | ◎ | ◎ | – | ○ | – | 低〜中（注入量） | 低 |
| dsh-superpowers（goodjin） | ◎ | ○ | – | ○ | ○（モデル配分） | 低 | 中 |
| dsh-test-runner | ○ | – | – | ◎（JS/Py） | ○（トークン節約） | 低 | 低 |
| dsh-review 系 | ◎ | – | – | ○ | △〜○ | 低 | 低 |
| 公式 LSP / dsh-tool-lsp | ◎ | – | ○ | – | ○ | 低 | 中（サーバー準備） |
| dsh-agent-teams | ◎ | ○ | ○ | ○ | ○（配分） | 中 | 中 |
| dsh-context | – | – | – | – | ◎ | 低 | 低 |
| dsh-cache-probe / cache-hit | – | – | – | – | ◎ | 低 | 低 |
| compaction-cacheaware | – | – | – | – | ○〜◎ | 中 | 高 |
| meow-memory / Hindsight / OpenViking | ○ | – | ○ | – | △ | 中（データ保持） | 中〜高 |
| BrowserSkill | ○ | – | ◎ | ○ | – | 中〜高（ログイン状態） | 中 |
| archify | – | ◎ | ○ | – | – | 低 | 低 |
| dsh-serial-console | ◎（組込み） | – | – | ◎（実機） | – | 中〜高（実機操作） | 中 |
| dsh-vet / vetting | – | – | – | – | – | **リスク低減** | 低 |

（◎=強い、○=役立つ、△=条件付き、–=対象外。評価は私の判断）

---

## 6. 出典（主なもの）

- 公式リポジトリ（LSP パッケージ、Discussions #5423）: https://github.com/deepseek-ai/deepseek-harness
- GitHub Topics dsh-plugin: https://github.com/topics/dsh-plugin
- awesome-dsh-plugin: https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
- awesome-deepseek-harness（Dominic789654）: https://github.com/Dominic789654/awesome-deepseek-harness
- awesome-deepseek-harness-plugins（SihanTeng）: https://github.com/SihanTeng/awesome-deepseek-harness-plugins
- Composio「Best plugins for DeepSeek Harness」: https://composio.dev/content/best-deepseek-harness-plugins
- Zenn「DeepSeek Harnessを使ってみた：モード選び・テスト環境・プラグイン」: https://zenn.dev/algia/articles/deepseek-harness-intro
- Qiita「人気プラグイン10選」: https://qiita.com/suuuuuu135/items/a9292a6dea3cfd3ff8b7
- Harness Catalog（手作業レビュー）: https://harnesscatalog.com/best-dsh-plugins/
- dsh-plugin.org 各プラグイン詳細: https://dsh-plugin.org/
- superpowers-dsh: https://github.com/LayneChai/superpowers-dsh
- dsh-superpowers（oThTJx）: https://github.com/oThTJx/dsh-superpowers
- Aegis: https://github.com/GanyuanRan/Aegis
- dsh-agent-teams: https://github.com/NanmiCoder/dsh-agent-teams
- dsh-test-runner: https://dsh-plugin.org/plugins/suimi8/dsh-test-runner
- dsh-tool-tdd（互換性検証）: https://www.dsh.so/artifact/dsh-tool-tdd/
- dsh-review-squad: https://github.com/luomeii/dsh-review-squad
- dsh-lsp-bridge: https://dsh-plugin.org/plugins/voidmind26/dsh-lsp-bridge
- dsh-tool-lsp（community）: https://dsh-plugin.org/plugins/jaylor-wang/dsh-tool-lsp
- 公式 LSP ドキュメント: https://deepseekdocs.com/en/docs/features/lsp
- dsh-meow-memory: https://github.com/Phant0Meow/dsh-meow-memory
- dsh-cache-probe: https://dsh-plugin.org/plugins/xymy666/dsh-cache-probe
- dsh-client-ui-cache-hit: https://github.com/sqs404/dsh-client-ui-cache-hit
- dsh-compaction-cacheaware: https://github.com/Zhuchen00123/dsh-compaction-cacheaware
- BrowserSkill: https://github.com/Tencent/BrowserSkill/
- dsh-serial-console: https://github.com/InfinitePersistence/dsh-serial-console
- dsh-serial-debugger: https://dsh-plugin.org/plugins/floydc-sz/dsh-serial-debugger
- dsh-plugin-mcp: https://github.com/menotbobbybrown/dsh-plugin-mcp
- dsh-mcp-bridge（liiiubai）: https://github.com/liiiubai/dsh-mcp-bridge
- プラグイン検証ガイド: https://dsharness.org/plugin-security
- セキュリティチェックリスト: https://deepseek-plugin.org/learn/plugin-security-checklist
- dsh-plugin-vetting: https://dsh-plugin.org/plugins/truelove-dreamer/dsh-plugin-vetting
- dsh-plugin-vet: https://dsh-plugin.org/plugins/wulun811/dsh-plugin-vet
