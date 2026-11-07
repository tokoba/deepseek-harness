# 改修済みの DSH で既存のインストール（exe と `dsh` コマンド）を置き換える方法

## 現状の構成（調べた結果）

いま使っている exe と `dsh` コマンドは、別々にインストールされたものではありません。どちらも Desktop インストーラが入れた同じ一式です。

| 種類 | 実体 |
|---|---|
| exe | `%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe`（Electron 製） |
| `dsh` コマンド | `...\resources\runtime\cli\bin\dsh.cmd`。中身は `DeepSeek Harness.exe` を Node として動かし、`resources\app.asar` 内の `dsh-desktop-host\lib\cli.js` を実行するだけ |
| npm グローバル版 | 入っていない（`C:\nvm4w\nodejs\node_modules\@deepseek-ai` は存在しない） |

このため、**Desktop を差し替えれば exe と `dsh` コマンドの両方が置き換わります**。

もう一つ大事な点があります。いまの Desktop は `app-update.yml` に従い、`https://download.deepseek.com/dsh-desk/feeds/win-x64/`（nightly チャネル）を 10 分ごとに確認しています。ファイルだけ差し替えると、**公式の新版で上書きされて元に戻る**可能性があります。

## 方法 A：改修版の Desktop インストーラを自分でビルドして入れ替える（推奨）

リポジトリには、署名なしのローカル用インストーラを作る手順があります（[apps/desktop/packaging/README.md](../../apps/desktop/packaging/README.md) の「Unsigned Windows test installer」）。

この手順では、ワークスペース内のパッケージ（今回改修した `llm-deepseek` や `session-log-deepseek` など）は、**ローカルのソースから作った tarball** が同梱されます（`apps/desktop/scripts/prepare-package-set.ts`）。npm から取ってくるのは外部の依存パッケージだけなので、改修内容はそのまま反映されます。

1. **ビルドに必要なツールを用意する**
   - Node 24
   - リポジトリ指定バージョンの pnpm
   - Git
   - PowerShell 7（`pwsh`）
   - tar、Python
   - Visual C++ Build Tools と Windows SDK

   ビルド中に npm、GitHub、nodejs.org へ接続します。プロキシ環境（例：`172.31.1.225:8080`）ではそれに合わせて設定してください。
2. **`apps/desktop/.env.windows` を作る**
   - `.env.windows.example` をコピーして作ります。
   - 必須なのは `DSH_DESKTOP_APP_ID` と、強制アップデート用の設定（`DSH_DESKTOP_MANDATORY_UPDATE_*_ORIGIN` など）です。後者は署名なしビルドでも必要で、実在する HTTPS のオリジンを指定する必要があります。
   - `DSH_DESKTOP_APP_ID` の決め方は次のどちらかです。
     - **公式と同じ ID**：既存のインストールにそのまま上書きされます。
     - **別の ID**：公式版と並べて入れられますが、後で公式版をアンインストールする必要があります。
   - 強制アップデートの接続先が公式サーバーにならないように、自分で管理するか到達しないオリジンを指定することをおすすめします。
3. **ビルドする**
   ```powershell
   pnpm install --frozen-lockfile
   pnpm run package:desktop:win:x64:unsigned --check   # 設定とツールの事前確認
   pnpm run package:desktop:win:x64:unsigned
   ```
   インストーラは `.desktop-build\targets\win-x64\unsigned-artifacts\` に出力されます。この署名なしビルドには**自動アップデートの設定が入らない**ため、公式版で上書きされる問題はなくなります。
4. **入れ替える**
   1. 実行中の DeepSeek Harness をトレイの「Quit」で完全に終了します。
   2. `Uninstall DeepSeek Harness.exe` で公式版をアンインストールしてから、作ったインストーラを実行します（同じ App ID なら上書きインストールでも構いません）。
   3. 署名がないので、SmartScreen の警告が出たら「詳細情報 → 実行」を選びます。
   4. アプリのメニュー「Manage dsh Command…」から Install または Repair を実行し、`dsh` コマンドを登録し直します。
5. **ユーザーデータ**
   - `%USERPROFILE%\.dsh`（`DSH_HOME`）は共有されるので、セッションや設定はそのまま引き継がれます。
   - 改修版は既存のイベント型を残しているので、既存のセッションログも開けます。
   - 以前の ID を残さないように、`%USERPROFILE%\.dsh\.anonymous-user-id` は削除しておくことをおすすめします。

## 方法 B：インストーラを作らず、ソースから直接動かす

Electron のパッケージングが重い場合や、まず試したい場合の方法です。

- Web UI：リポジトリで `pnpm run build:artifacts` のあと `pnpm dsh web`（または `make web`）
- CLI：`pnpm dsh --profile headless "task"`。`dsh` という名前で呼びたい場合は、リポジトリの `pnpm dsh` を呼ぶ小さな `dsh.cmd` を作り、PATH の先頭に置きます。
- **既存の Desktop はアンインストールしてください。**
  - 理由1：Desktop の `dsh.cmd` がユーザー PATH に登録されたまま残り、名前がぶつかります。
  - 理由2：公式の自動アップデートが動き続けます。

  残したい場合は、少なくとも「Manage dsh Command… → Remove」で PATH から外してください。
- この方法では Desktop（exe）の画面は使えず、ブラウザで Web UI を使うことになります。

## 避けた方がよい方法

- **`app.asar` の中身だけを差し替える**：`app-update.yml` によるアップデート、署名済みの更新フィード、同梱ランタイムのダイジェスト（`runtime.json`）とずれが生じます。上書きで元に戻ったり、起動に失敗したりするおそれがあります。
- **公式版を残したまま改修版を並べて使う**：PATH の `dsh` がどちらを指すかがあいまいになり、`DSH_HOME` も共有されるので、どちらで動いているのか分かりにくくなります。

## 入れ替えた後の確認

- バージョン表示：署名なしビルドでは「About」とバッジに **「DSH Local Build」** と表示されるので、改修版で動いているかすぐ分かります。
- 実際の通信：[wire-test.ts](dsh-hardened-kit/wire-test.ts) を使い、`dsh_*` フィールドと `x-deepseek-harness-*` ヘッダが送られていないことを確認してください（実環境では未検証）。
