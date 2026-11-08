GitHub Copilot (DeepSeek/LLMプロバイダ側、あるいはHarness内のコンテキストキャッシュ機能) のキャッシュヒット率を最高に保つための設計文書を策定しました。
DeepSeek Harnessは「Everything is a Plugin」を掲げ、Cordisアーキテクチャによる優れた時空間合成性（Spatiotemporal Composability）を備えています。このプラグイン機構を活かし、LLMプロバイダ側のコンテキストキャッシュ（Prompt Caching）のヒット率を最大化、およびCold状態からの復帰トークン消費を最小化するためのカスタムプラグイン、およびミドルウェアの設計を以下に記載します。
そのまま docs/feat/cache-hit-ratio-improvement.md としてリポジトリに配置できるマークダウン形式で出力します。

docs/feat/cache-hit-ratio-improvement.md

設計文書: コンテキストキャッシュヒット率の最大化とCold状態回避（GitHub Copilot / DeepSeek Harness）

1. 目的と背景

DeepSeek Harnessを用いてGitHub Copilot Enterprise（および付随するLLMプロバイダ機能）を運用するにあたり、大規模なソースコードコンテキストや開発履歴をプロンプトに含める必要があります。
コンテキストキャッシュ（Prompt Caching）は、リクエスト間で重複するプロンプト部分（プレフィックス）のトークン料金とレイテンシを大幅に削減しますが、一定時間リクエストがないとキャッシュは消失（Cold状態に遷移）します。Cold状態から再Warmupする際には、再度大量の入力トークンを消費するため、コストおよびパフォーマンスの観点から「いかに高いヒット率を維持するか」「いかに効率的にWarm状態を保ち、Cold復帰時のオーバーヘッドを抑えるか」が極めて重要です。
本設計では、DeepSeek Harnessが持つ「Everything is a Plugin」(Cordisベース) のアーキテクチャを最大限に活かし、ローカルコード変更によるキャッシュ最適化機構（キャッシュ管理プラグインおよびミドルウェア）の導入を提案します。

1. コアアプローチ（戦略）

キャッシュヒット率を最高に保つための3つの基本原則に従い、Harness側で実装を行います。

1. プロンプトの厳密な固定化と構造化 (Exact Prefix Matching)
 • キャッシュはプロンプトの「先頭からの完全一致」で判定されます。動的な要素（タイムスタンプ、ユーザーセッションID、頻繁に変わる会話履歴）をプロンプトの先頭や中間に配置するとキャッシュが破壊されます。
 • 対策: システムプロンプト、大規模なリポジトリ構造、固定ソースコードなどの「不変なコンテキスト」を最前方に配置し、動的な要素はすべてプロンプトの最後尾（Suffix）に結合します。
2. コンテキストのパディング・バケット化 (Block/Bucket Padding)
 • LLMプロバイダ（DeepSeek等）のプロンプトキャッシュは、通常「1024トークン単位」などのブロック（バケット）ごとにキャッシュされます。1文字、1行の追加・削除で全体のブロック境界がずれると、以降のキャッシュがすべて無効化されます。
 • 対策: 読み込むファイルコンテキストのサイズを固定ブロックサイズ（例: 1024の倍数）にパディングトークンで調整する、あるいは特定モジュールごとに独立したキャッシュスロットを意識したバケット管理を行います。
3. アクティブ・ハイドレーション（Warmup Keep-Alive）
 • キャッシュの生存期間（TTL）は一般的に数十分〜数時間（プロバイダ依存）です。開発者が離席している間や夜間にキャッシュが枯渇（Cold化）します。
 • 対策: バックグラウンドで定期的に「軽量なPing（Cache Keep-Alive リクエスト）」を送信し、LLM側のメモリ上にキャッシュを強制維持（Hydration）させます。

4. 詳細設計とアーキテクチャ

DeepSeek Harness（Cordis）のコンポーネント構造として、以下の2つのモジュールを packages/ または plugins/ 内に新規実装します。
deepseek-harness/
├── plugins/
│   └── cache-optimizer/
│       ├── index.ts          # Cordis プラグインのエントリポイント
│       ├── middleware.ts     # プロンプトの並び替え・パディングを担うミドルウェア
│       └── hydrator.ts       # バックグラウンドでのKeep-Alive・Warmupタスク

3.1. プロンプト並び替え＆バケットパディング・ミドルウェア (middleware.ts)

HarnessからGitHub Copilot / DeepSeek APIへのリクエストをインターセプトし、キャッシュ効率を最大化する構造にプロンプトを再構成します。
• 静的コンテキストの最前方配置:
[システムプロンプト] -> [共通ルール/ドキュメント] -> [リポジトリ構造] -> [不変な参照ソースコード] -> [動的な会話履歴/直近の編集] の順に強制ソートします。
• トークンアライメント（パディング）:
静的コンテキストの末尾に、トークン境界（例: 1024トークン）にジャストフィットさせるためのダミーコメント（例: // padding for cache alignment ...）を動的に挿入し、動的要素（会話履歴）の増減が静的部分のキャッシュに影響を与えないように分離します。

3.2. キャッシュ・ハイドレーター・プラグイン (hydrator.ts)

最もコストがかかる「Cold状態からの復帰（再Warmup）」を防止・緩和するためのバックグラウンド制御機構です。
• 定期的ハイドレーション (Ping-to-Warm):
Harness起動時、および最後にアクティブなリクエストがあってから N分（例: 20分）が経過する前に、最小限のインクリメンタルなリクエスト（max_tokens=1 のダミー生成リクエスト）を送信し、LLM側のコンテキストキャッシュTTLを延長し続けます。
• インテリジェント・プリフェッチ (Intelligent Prefetching):
開発者が特定のワークスペースを開いた瞬間、またはGitのブランチを切り替えた瞬間に、そのコンテキスト（主要ファイル群）を非同期でLLMプロバイダに送信し、最初のユーザープロンプトが実行される前にあらかじめ「Warm」状態にしておきます。これにより、ユーザー体感上のレイテンシがゼロになります。

1. 実装コード例

Cordisのプラグインモデルに準拠した、実装のスケルトンコードです。
typescript
// plugins/cache-optimizer/index.ts
import { Context, Plugin } from 'cordis';

export interface CacheOptimizerConfig {
  enableHydration: boolean;
  hydrationIntervalMs: number; // デフォルト: 1200000 (20分)
  alignmentBlockSize: number;  // デフォルト: 1024 (トークン)
}

export const name = 'cache-optimizer';

export function apply(ctx: Context, config: CacheOptimizerConfig) {
  let lastRequestTime = Date.now();
  let lastStaticContext: any = null;

  // 1. リクエスト送信前のミドルウェア (プロンプト構造化とパディング)
  ctx.on('llm/before-request', (params) => {
    lastRequestTime = Date.now();

    if (params.messages) {
      // メッセージを静的（System, 不変コード）と動的（Userの質問、直近の会話）に分類
      const staticMessages = params.messages.filter((m: any) => m.role === 'system' || m.tags?.includes('immutable'));
      const dynamicMessages = params.messages.filter((m: any) => m.role === 'user' || m.role === 'assistant');

      // 静的コンテキストの保存（Hydrator用）
      lastStaticContext = staticMessages;

      // [最適化] 静的メッセージを先頭に固定
      // 必要に応じてここに1024トークンアライメントのパディング処理を実装
      params.messages = [...staticMessages, ...dynamicMessages];
    }
  });

  // 2. キャッシュ維持のためのバックグラウンドハイドレーター
  if (config.enableHydration) {
    ctx.setInterval(async () => {
      const now = Date.now();
      // 最後のリアルリクエストから一定時間経過しており、かつ静的コンテキストが存在する場合
      if (now - lastRequestTime >= config.hydrationIntervalMs && lastStaticContext) {
        ctx.logger('cache-optimizer').info('Cache expiration imminent. Sending hydration ping...');

        try {
          // キャッシュを維持するためだけの最小限のリクエストを実行 (max_tokens=1)
          await ctx.llm.client.chat.completions.create({
            messages: [...lastStaticContext, { role: 'user', content: 'keep-alive ping' }],
            max_tokens: 1,
            temperature: 0
          });
          // タイマーリセット
          lastRequestTime = Date.now();
        } catch (err) {
          ctx.logger('cache-optimizer').error('Hydration failed:', err);
        }
      }
    }, config.hydrationIntervalMs / 2); // 安全のためTTLの半分の周期でチェック
  }
}
コードは注意してご使用ください。

1. 運用と効果測定

本機能を有効化した後の評価指標（KPI）およびデバッグ方法。

1. キャッシュヒット率の可視化:
DeepSeek API等のレスポンスに含まれる usage.prompt_tokens_details.cached_tokens をHarnessのロガーでトラッキングし、全体の cached_tokens / total_prompt_tokens の比率（キャッシュヒット率）が 85%以上 に維持されているかを測定します。
2. コスト・トークン消費削減の確認:
Cold状態からの復帰（ハイドレーション失敗）が発生していないかを、Harnessのダッシュボードまたはログから監視します。夜間休日の自動Pingによる微小なトークン消費と、翌朝の最初のクエリがWarm状態で返ってくることによる恩恵（コスト・速度）を比較計測します。
設計詳細のベースラインが固まりました。この設計書をもとに、まずは「プロンプトを静的・動的に分離して先頭に固定するミドルウェア」から実装を進めるか、それとも夜間などのCold化を防ぐ「定期的Keep-Alive（ハイドレーター）プラグイン」から着手するか、どちらを優先したいですか？
また、現在お使いのDeepSeek Harnessに組み込まれている、既存のLLMリクエスト処理ロジックのファイルパスや関数名などが分かれば、より具体的なコード書き換えの提案が可能です。
