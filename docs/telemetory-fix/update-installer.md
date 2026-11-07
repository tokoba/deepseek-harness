# 改修済みの DSH で既存のインストール（exe と `dsh` コマンド）を置き換える方法

## 置換前の構成（調べた結果）

今回の置換前に使っていた exe と `dsh` コマンドは、別々にインストールされたものではありません。どちらも Desktop インストーラが入れた同じ一式です。

| 種類 | 実体 |
| --- | --- |
| exe | `%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe`（Electron 製） |
| `dsh` コマンド | `...\resources\runtime\cli\bin\dsh.cmd`。中身は `DeepSeek Harness.exe` を Node として動かし、`resources\app.asar` 内の `dsh-desktop-host\lib\cli.js` を実行するだけ |
| npm グローバル版 | 入っていない（`C:\nvm4w\nodejs\node_modules\@deepseek-ai` は存在しない） |

このため、**Desktop を差し替えれば exe と `dsh` コマンドの両方が置き換わります**。

置換前の公式 Desktop は `app-update.yml` に従い、`https://download.deepseek.com/dsh-desk/feeds/win-x64/`（nightly チャネル）を 10 分ごとに確認する構成でした。ファイルだけ差し替えると、**公式の新版で上書きされて元に戻る**可能性があります。今回作成した署名なし版には `app-update.yml` が含まれません。

<!-- markdownlint-disable-next-line MD033 -->
<a id="local-desktop-reinstall"></a>

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
   - 必須なのは `DSH_DESKTOP_APP_ID` と、強制アップデート用の設定（`DSH_DESKTOP_MANDATORY_UPDATE_*_ORIGIN` など）です。後者は署名なしビルドでも必要で、資格情報・パス・クエリ・フラグメントを含まない HTTPS オリジンを指定します。今回のローカルビルドでは、到達しない `https://dsh-updates.invalid` で事前確認とビルドを通過しました。
   - **公式と同じ App ID**：既存と同じアプリとしてインストールできます。ただし、同じ ID でもディレクトリの上書きが成功するとは限りません。
   - **別の App ID**：公式版と並べて入れられますが、後で公式版をアンインストールする必要があります。
   - 強制アップデートの接続先が公式サーバーにならないように、自分で管理するか到達しないオリジンを指定することをおすすめします。
3. **ビルドする**

   ```powershell
   pnpm install --frozen-lockfile
   pnpm run package:desktop:win:x64:unsigned --check   # 設定とツールの事前確認
   pnpm run package:desktop:win:x64:unsigned
   ```

   リポジトリルートから見た出力先は `apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/` です。この署名なしビルドには**通常の自動アップデート設定が入りません**。強制アップデートポリシーの設定は別に同梱されるため、その接続先も確認してください。
4. **入れ替える**
   1. 実行中の DeepSeek Harness をトレイの「Quit」で完全に終了します。
   2. アンインストール前に `DSH_HOME` と既存アプリをバックアップします。今回のバックアップ先は `%LOCALAPPDATA%\DSH-Reinstall-Backups\0.2.2-rc.1.20261107.1\` で、`dsh-home` と `installed-app` に保存しました。
   3. `uninstall-deepseek-harness.exe` など、インストール済みのアンインストーラーで公式版を削除してから、作ったインストーラで新規インストールします。この環境の置換前の実体名は `Uninstall DeepSeek Harness.exe` でした。今回、上書きはアクセス拒否で失敗し、**アンインストール後の新規インストールで成功しました**。
   4. 署名がないので、SmartScreen の警告が出たら「詳細情報 → 実行」を選びます。
   5. アプリのメニュー「Manage dsh Command…」から Install または Repair を実行し、`dsh` コマンドを登録し直します。別途 npm グローバル版をインストールする必要はありません。
5. **ユーザーデータ**
   - `%USERPROFILE%\.dsh`（既定の `DSH_HOME`）は共有されます。ただし、アンインストール時の保持を前提にせず、バックアップ後に入れ替え、再インストール後にセッションと設定を確認してください。アンインストールの扱いは [Desktop の Windows アンインストール規則](../../apps/desktop/README.md#windows-uninstall-rules) を参照してください。
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
- 実際の通信：[wire-test.ts](dsh-hardened-kit/wire-test.ts) で、作成したインストーラに対応する展開済み CLI をローカル模擬 API に接続し、`dsh_*` フィールドと `x-deepseek-harness-*` ヘッダーが送られていないことを確認しました。実サービスへの接続と、インストール後の GUI 全体の通信は未検証です。

## 作業記録（Dev Note：2026-11-07）

この節は今回のローカル環境での作業記録です。環境依存の回避策や利用者による成功報告を含み、すべての Windows 環境で同じ結果になることを保証するものではありません。

### セッションサマリー

- 推奨 A 案の署名なし Windows x64 インストーラを、ローカルソースから作成しました。外部への公開・アップロードは行っていません。
- ビルド元の版は `0.2.2-rc.1`、Desktop のビルド版番号は `0.2.2-rc.1.20261107.1`、既存と同じ App ID は `com.deepseek.dsh` です。
- 使用した主なツールは Node `24.15.0`、pnpm `11.28.5`、PowerShell `7.6.9`、Python `3.12`、Visual Studio `18` の C++ ツールと Windows SDK です。プロキシ設定はビルド環境から継承しました。
- ロックファイル固定の依存関係準備と事前チェックを実行し、最終的に全体ビルド、同梱ランタイムのスモークテスト、CLI のオフラインプラグイン操作、DOCX・XLSX・PPTX から PDF への変換が成功しました。
- 自動実行と利用者の手動実行による上書きは失敗しました。利用者から、旧版のアンインストール後に新規インストールしたところ成功したとの報告を受けました。その後、インストール先の埋め込み版番号が `0.2.2-rc.1.20261107.1` で、`app-update.yml` が存在しないことを確認しました。
- セッションと資格情報をバックアップしました。上書き失敗後の確認では、記録した 12 個のセッションファイルと資格情報ファイルに変更はありませんでした。匿名 ID は一度退避し、上書きが失敗した時点で元へ戻しました。利用者によるアンインストール後のデータ引き継ぎは、この確認には含まれません。

### ビルド設定と成果物

今回ビルドに使用した Git 管理外の `apps/desktop/.env.windows` の設定は次のとおりです。署名・配布用の資格情報は設定していません。

```dotenv
DSH_DESKTOP_APP_ID=com.deepseek.dsh
DSH_DESKTOP_AUTO_UPDATE_ENV=test
DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN=https://dsh-updates.invalid
DSH_DESKTOP_MANDATORY_UPDATE_CONFIG='{"allowedAuthOrigins":["https://dsh-updates.invalid"]}'
DSH_DESKTOP_WINDOWS_COMPRESSION_LEVEL=3
```

`test` 設定では `allowedAuthOrigins` も必要です。署名なしでも強制アップデートポリシーは同梱されます。今回の到達しないオリジンは、公式サーバーへのポリシー接続を避けるローカル用途の設定であり、有効な更新サービスではありません。

リポジトリルートから次のコマンドを実行しました。本ビルドでは、後述の Windows 固有の回避策も使用しました。

```powershell
pnpm install --frozen-lockfile
pnpm run package:desktop:win:x64:unsigned --check --build-version 0.2.2-rc.1.20261107.1
pnpm run package:desktop:win:x64:unsigned --build-version 0.2.2-rc.1.20261107.1
```

成果物は `apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/deepseek-harness-0.2.2-rc.1.20261107.1-win-x64-unsigned.exe` です。サイズは 318,169,322 バイトで、Authenticode の状態は `NotSigned` でした。署名なし版の作成に、EV 証明書・トークン PIN・配布先の資格情報は不要でした。

```text
SHA256: F72EBB9B63E34ABC4C922E2DD48D0F00A169C15FF5C2B0C6A541D802BCAF6557
```

ビルドログと終了記録は `apps/desktop/.desktop-build/packaging-runs/` に残ります。出力が長くても、インストール前に `result.json` と最終ステージの成功を確認してください。

### Windows 固有のビルド対策

Git Bash の GNU `tar` は、Node 子プロセスから渡された `C:\...` をリモート指定と解釈し、`Cannot connect to C: resolve failed` でパッケージ準備に失敗しました。Windows 標準の `tar.exe` を PATH の先頭に置くことで、同じステージが成功しました。これはビルド用ターミナルだけの設定です。

```bash
export PATH="/c/Windows/System32:$PATH"
command -v tar
tar --version
pnpm --dir apps/desktop run prepare:packages
```

Inspector の DevTools 生成では、`lib/devtools.build-*` から `lib/devtools` への `rename` が `EPERM` で失敗しました。単独実行でも再現し、NTFS の状態と読み取った ACL からは原因を確定できませんでした。今回のビルドでは、該当する生成物の `rename` が `EPERM` になった場合だけ、出力先が存在しないことを確認してコピーする一時的な Node プリロードを使用しました。リポジトリのソースは変更していません。

今回使用した Git Bash の回避コマンドは次のとおりです。`NODE_OPTIONS` はこのビルドプロセスにだけ渡し、通常の DSH 起動には使用しません。

```bash
DSH_LOCAL_BUILD_NODE_OPTIONS="--import=data:text/javascript;base64,$(printf '%s' 'import fs from "node:fs/promises"; import {syncBuiltinESMExports} from "node:module"; import path from "node:path"; const rename=fs.rename; fs.rename=async function(source,destination){try{return await rename(source,destination)}catch(error){if(error.code!=="EPERM"||typeof source!=="string"||typeof destination!=="string"||!path.basename(source).startsWith("devtools.build-")||!destination.replaceAll("\\","/").endsWith("/packages/experimental/inspector/lib/devtools"))throw error;try{await fs.stat(destination);throw error}catch(probe){if(probe.code!=="ENOENT")throw error;}await fs.cp(source,destination,{recursive:true,errorOnExist:true,force:false});console.warn("local build: copied Inspector DevTools output after Windows EPERM");}};syncBuiltinESMExports();' | base64 -w 0)"
NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }$DSH_LOCAL_BUILD_NODE_OPTIONS" pnpm exec tsx packages/experimental/inspector/scripts/build-devtools.ts
NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }$DSH_LOCAL_BUILD_NODE_OPTIONS" pnpm run package:desktop:win:x64:unsigned --build-version 0.2.2-rc.1.20261107.1
unset DSH_LOCAL_BUILD_NODE_OPTIONS
```

コピー後の 768 ファイルについて、`resource-manifest.json` のサイズと SHA-256 に一致することを確認しました。この回避策は生成物の置換専用であり、インストール済みアプリを手動コピーで差し替える手順ではありません。

### 上書き失敗と新規インストールの成功

上書きでは `MoveFileExW` による既存ディレクトリのバックアップ名への移動が失敗し、Windows エラー `5`（アクセス拒否）とインストーラ終了コード `2` が記録されました。診断ログには 10 回の `backup: Windows error: 5` があり、新版の配置より前に停止していました。

ログの保存先は `%LOCALAPPDATA%\@deepseek-aidsh-desktop-updater\installer-logs\directory-failure-*.log` です。今回のログ名は `directory-failure-20261107-195253.log` と `directory-failure-20261107-195722.log` でした。

確認時に DSH のアプリプロセスは見つかりませんでした。Windows 標準の Restart Manager で既存アプリの 7,790 ファイルを登録して調べても、使用中のプロセスは検出されませんでした。ただし、ディレクトリのハンドルやアクセス制御による拒否まで否定したものではありません。手動実行でも同じエラーが出たため、サンドボックスだけを原因とする説明は確定していません。権限変更やプロセスの強制終了は行っていません。

成功した入れ替え手順は [方法 A の「入れ替える」](#local-desktop-reinstall) に記載した、バックアップ後のアンインストールと新規インストールです。同じエラーが出る環境では、同じ App ID の上書きを繰り返すのではなく、この経路を使用してください。

### 通信検証の結果

テレメトリー無効化の環境変数をテストから追加せず、監査モードで展開済みの同梱 CLI を実行しました。模擬 API とダミーキーを使用し、通常のセッションや実際の API キーには接続していません。

```bash
node docs/telemetory-fix/dsh-hardened-kit/wire-test.ts --cmd '"C:/Drive/ts/deepseek-harness/apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/win-unpacked/resources/runtime/cli/bin/dsh.cmd"' --guard audit --no-env-optout --timeout 120 --json apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/wire-test-packaged.json
```

2 件の `POST /v1/messages` を取得し、結果は `PASS` でした。`dsh_*` 本文フィールド、`x-deepseek-harness-*` ヘッダー、`*.deepseeksvc.com` への接続試行、その他の非ループバック通信、永続的な `.anonymous-user-id` の生成はいずれもありませんでした。機械可読の結果は `apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/wire-test-packaged.json` に保存しました。この結果は検証した CLI 実行の範囲に限られます。
