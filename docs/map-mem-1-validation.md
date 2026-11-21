# MAP-MEM-1 検証報告

対象は `KM9250/Multi-agent-Platform`、基準mainは `2309d5e4b30f3eabb60ead959e16611b2ae50cfb`（PR #38）。開始時のリモートmainと一致し、全履歴を取得した。提出ブランチは `codex/map-mem-1-vault`。対象OSはLinux x86_64、kernel 6.18.57、検証用ファイルシステムはoverlayfs、Node.js 24.22.3、npm 11.19.1、SQLite 3.54.1。試験データは一時Root内の合成会話、アカウント、添付、Vaultに限定した。

今回の再監査対象と結果は [F-01〜F-05の修正と回帰試験](#pr39-reaudit) にまとめた。

## 初回監査時の結果

検証日 2026-11-21。対象コミットは `90e7ca049ef27bdab4a75c4496c2fe9b711df8ea`。開始時の基準mainでも、通常並列設定の既存試験2,125件すべての成功を確認した。表の件数には同じテストが含まれるため、コマンド間では合算しない。

| コマンド・条件 | 成功 / 失敗 / Skip | 実行時間 |
| --- | ---: | ---: |
| `npm run test:memory`（並列度2） | 40 / 0 / 0 | 12.1秒 |
| `npm test`（通常設定、並列度2。他のスイートとの重複なし） | 2,169 / 0 / 0 | 379.3秒 |
| 全 `test/*.test.ts` を `--test-concurrency=1` で単独実行 | 2,169 / 0 / 0 | 713.5秒 |
| DATA-1・MEM-1の `test/app-*.test.ts test/memory*.test.ts` を並列度1で実行 | 190 / 0 / 0 | 77.3秒 |
| `npm run test:app-data-redteam` | 131 / 0 / 0 | 26.9秒 |
| `npm run test:app-data-crash` | 17 / 0 / 0 | 9.5秒 |
| `npm run test:macp`（固定Receiver・一時loopback） | 9 / 0 / 0 | 1.2秒 |
| `npm run test:notification-macp`（同じReceiver） | 8 / 0 / 0 | 4.7秒 |
| `npm run typecheck` | 成功 | 7秒 |
| `npm run build` | 成功 | 4秒 |
| `npm run test:memory-browser` | 成功 | 17秒 |
| `npm run test:app-data-browser` | 成功 | 17秒 |

既存の合成 `npm run bench:app-data` も成功した。10万件の会話を用いた最新50件のHTTP読取で、ウォーム時のp95は29.6ms、4読者同時のp95は90.9ms。これは会話読取の測定値である。MEM-1の走査中の制御返却は専用試験で別に確認した。

先行した通常並列実行（並列度2、ほかにCOORD直列スイートが同時稼働）では2,168成功・1失敗・Skip 0、407.7秒だった。`coordination-execution-crash.test.ts:63` でSIGKILL前の子プロセス応答の `stage` が期待値 `uncertain-legacy-task` にならず、実測値は `undefined` だった。コードも試験条件も変えず、通常並列設定をホスト上で単独再実行した結果が上表である。同時稼働が失敗を引き起こしたかは確定していない。

標準スイートはリポジトリ既定の並列度2で実行した。全体直列は以下の単一プロセスで、ほかの検証コマンド終了後に実行した。個別スイートの性能は、その時点のホスト負荷に依存する。MACP参照は `e88937d0c8132ae7d18098a24d01ee28bffda655` に固定した。一時ReceiverのSSEとSQLiteを使用した。

```bash
node --experimental-transform-types --loader ./test/ts-loader.mjs --test --test-concurrency=1 test/*.test.ts
```

開発中に復元直後の履歴読取試験が `MAINTENANCE` になったため、停止をアサートした上で、資格情報を再設定して明示再開したRootから履歴を検査するよう試験を修正した。共有先への再試行権限と初回承認の不一致、登録件数の増加や初回走査量による読取停止もレビューで修正し、回帰試験を加えた。データ消失・不一致を許容するassert変更や、期限延長による成功扱いは行っていない。

## 確認した障害境界

| 境界 | 観測・成功条件 |
| --- | --- |
| 生成確定 | 前後空白付きコマンドを受理し、成功したmemory用Call・Segment・Receipt・候補を同じトランザクションで記録。取消し、不完全出力、結果確定失敗や読み直しで候補やProvider呼出しが増えない |
| 認可とレビュー | 通常アカウントには追加権限なし。専用APIでPersona・Room・原文・管理の権限を区別し、private本文・件数・原文を未認可応答から除外。対象版、本文、出所、Owner、Scopeの食い違いでまとめ承認をロールバック |
| 部分公開 | 一方の宛先に人間のファイルを先に作ると、その内容は維持される。同じまとめ承認の再照会で `CONFLICT` と `PUBLISHED` が並び、Receiptは成功分だけ増える |
| 強制終了と競合 | 承認後、準備後、排他的リンク作成後、Receipt前で子プロセスをSIGKILL。同じJobを選んだ複数Workerが同一操作へ収束し、履歴ファイルと利用者の編集ファイルが別のinodeに保持される |
| 外部編集 | 現在版の読取でID・digestを照合。検出イベントがなくても異なる内容は返さず、安定した編集だけを同じScopeの新版へ取込。改名、重複ID、削除、リンク、異常なProperties、過大ファイル、再起動、走査上限を検査 |
| 出所変更 | 依存原文の訂正・削除、対象Noteの版変更、権限の撤回は候補／公開版を要再確認にする。権限再付与後にも旧承認は復活しない。許可された履歴と原文は保持される |
| Migration | Schema 1の会話・添付・生成・ACLを保持して2へ移行。移行COMMIT前後でSIGKILLし、台帳・Schemaを確認。未知／将来Schemaを拒否。基準コミットの旧バイナリで新DBの安全な拒否、旧Backupの別Root復元を検証 |
| Backup／Restore | DB Snapshotと対応する独立した確定版から、履歴・現在版・保留Jobを含む復元を実施。復元元Vaultは保持され、復元Rootの認証・公開処理は停止。資格情報を再設定してApp再開後もVaultの明示再開が必要 |
| 画面 | 合成Providerの1回の送信で2候補。出所確認、編集、承認のACK喪失・再試行、2件のReceipt、リロード、ファイルの外部編集・改名、履歴・変更提案・撤回をChromiumで検査。外部通信とブラウザー永続ストレージへの本文保存を検査 |

通常のBackendは対象Scopeを認可した時点のローカルファイルを照合する。別プロセスはその直後にも保存できるので、読取後のバイト列や編集中の断片が将来変わらない保証はない。連続した二度の観測は通常保存の安定判定であり、書込みを長時間中断した外部エディタの完了通知にはならない。ファイルサイズ・件数・処理単位の上限およびイベントループへ制御を返すことを合成環境で確認した。実媒体でのfsync遅延、電源断、長時間連続運転は配備構成で測定する。

<a id="pr39-reaudit"></a>

## PR #39 再監査　F-01〜F-05

監査対象は `b98241429466f1ad6406288c1f0ad724bafe6115`。着手時のリモートPRのHEADと一致した。以下の修正前観測はそのコミットを別チェックアウトで動かした結果である。今回の実装・試験対象は `584874092b7c84d554deef2930d1c969757b4193`。同じLinux／overlayfs上で一時Rootと合成データを使用した。

### 指摘別の変更と観測

| 指摘 | 変更箇所・判断 | 修正前の観測 | 修正後に確認した結果 |
| --- | --- | --- | --- |
| F-01 元発言の訂正 | `memory/lineage.ts`、`memory/sources.ts`、`app-data/db.ts`。生成Receiptとmanifestから推移的な依存関係をたどり、既存の失効判定に版と認可を渡す。人が確認する直接のSourceRefを保持する。 | 履歴窓2、先頭固定なしで「月曜」→ `/memory` 2回。2回目には最初の生成出力が入り、元発言は窓外。公開後に「火曜」に訂正しても、2回目は `PUBLISHED` のまま「月曜」を返した。先に訂正してから作る派生候補も `PENDING_REVIEW` になった。 | いずれの順でも派生した記憶は `NEEDS_REVIEW`。通常の現在版取得を拒否し、原文、読取権限を確認できる過去版、依存しないノートを保持した。通常回答を経由した場合と、添付が発言とPersona設定の両方で使われた場合も検証した。 |
| F-02 外部保存直後の撤回 | `memory/notes.ts`、`components/MemoryPanel.tsx`。確認した状態・版・digestを固定し、公開中の新規撤回ではVaultの現在ファイルを照合する。成功済み操作は現在の権限を確認して再照会する。 | 確認画面を開いた後、走査前に本文を保存すると、旧画面の撤回にHTTP 200、状態 `RETRACTED`、Receipt 1件。 | 同じ操作はHTTP 409、`REVISION_CONFLICT`、Receipt 0件。保存済み本文を保持し、取込後に第1版・第2版が読めた。第2版の再確認後に撤回・同一要求の再送が成功。既知の削除・競合からの明示撤回と旧Receiptの再送も確認した。 |
| F-03 公開途中の停止 | `memory/vault.ts`、`memory/worker.ts`。公開前の準備と、リンクを試行したことを保護領域に永続化する。復旧時はOperationと元ファイルの識別情報を照合する。 | 初回リンクが見えた直後に子プロセスをSIGKILL。停止中の削除で元パスが復活し、同一バイト列の別ファイルへの置換でも成功Receiptができた。改名と内容の異なる置換では従来も競合した。 | 無変更は同じノートとReceipt各1件に収束。削除、改名、差し替えでは人の操作を保持し、再起動を繰り返しても別名・元パスへの追加公開と成功Receiptは0件。公開前か削除後かを判別できない旧Jobも保留した。 |
| F-04 版履歴を含むBackup | `operations/backup.ts`、`operations/memory-ledger.ts`。ハッシュ検証したSQLiteスナップショットを版の対応表に使い、順序付き読み出しと内容アドレス方式で件数・digest・確定本文を照合する。 | 85,001版の旧形式の版一覧だけで19,454,124バイト。旧 `BackupService` は `BACKUP_MANIFEST_LIMIT` で停止した。 | 同じ件数、3種類の実ファイルで `BACKUP:3` のmanifestは1,325バイト。空の別Rootに復元し、全版のNote ID・版番号・ファイルdigest・本文digest・パスが一致。先頭・中央・末尾の本文が取得できた。欠落・内容不一致を検出し、復元元データを保持した。 |
| F-05 閲覧権限と差分 | `memory/notes.ts`、`memory/change-cursor.ts`、`http/memory.ts`、`shared/memory-contracts.ts`。固定した終了位置でページを区切り、認証付き暗号によるカーソルをActor・Room・現行の認可に束縛する。 | private→共有の順に公開し、共有の位置で差分を取得。private閲覧権の追加後も撤回後も、共有のカーソルからは空配列が返り、同期側に権限変更が伝わらなかった。 | 追加・撤回・旧形式カーソルでHTTP 409 `MEMORY_RESYNC_REQUIRED`。空から再取得すると権限追加時は2件、撤回時は共有1件で現在の一覧と一致。権限が変わらない場合は451件を複数ページで復元し、途中の更新も続く差分で取得した。 |

表のサーバー実装パスは `server/` 配下。既存手法の適用範囲は推移的な依存追跡、楽観的競合検出、書込み先行の試行記録、内容アドレスによる重複排除、認可に束縛したカーソルページングである。MAPでは、モデルが読んだ資料と利用者が確認した出所を区別する。外部エディタが行った操作と失効した閲覧権を尊重するため、曖昧な公開Jobは保留し、古い差分位置では利用者ごとに全件再同期する。WorkspaceのACL版が進むと、別Scopeの権限変更でも再同期を要求する場合がある。

### 回帰試験の対応

| 指摘 | 再実行できる試験ファイルとケース名 |
| --- | --- |
| F-01 | `test/app-memory-lineage.test.ts` の `PR39 F-01 two memory exports in a two-message window both follow the original correction`、`a corrected ancestor outside the direct window prevents publication of a new derivative` と、通常回答・添付の経路。 `test/memory-lineage-migration.test.ts` の `PR39 F-01 migrates existing lineage and withholds stale or unprovable ancestry before serving` |
| F-02 | `test/app-memory-import.test.ts` の `F-02 retraction at the watcher gap preserves an unimported external edit and its publication`、`deleted files and identity conflicts require acknowledgement of the recorded state`、新旧Receiptの再送2件。 `test/integration/memory-browser.integration.ts` の `stale V1 retraction conflicts, V2 preserved and explicitly retracted` |
| F-03 | `test/memory-publication.test.ts` の `F-03 first visible link + SIGKILL + external … preserves the user's file state`（delete、rename、replace、replace-identical）。リンク前停止、準備ファイルの同一性、旧形式のlone-stage／original-pair／lone-targetも収録。無変更時の単回回復には既存の `MEM-1 SIGKILL afterLink followed by concurrent publishers yields one note and receipt` を使用 |
| F-04 | `test/memory-backup-history.test.ts` の `F-04: 85,001 committed revisions round-trip in a bounded header with every identity preserved`。 `test/memory-backup-compat.test.ts` の `F-03/F-04: previous MEM-1 binary backups and paused restore reports stay readable, including an archive made after old resume`。既存の `test/memory-backup.test.ts` と `test/memory-migration.test.ts` で保留Job・認可・添付・DATA-1形式を確認 |
| F-05 | `test/app-data-http.test.ts` の `memory change API resets a still-visible checkpoint on gain and loss of private access`、`test/app-memory-changes.test.ts` の `baseline and delta pages share gapless, finite cutoffs during concurrent publication`。空集合からの初期読込、別Actor・別Room、閲覧範囲の変更、空ページ・複数ページの継続を検証 |

### 既存データの読み継ぎ

- `app_003_memory_integrity` は、Schema 2に保存された生成Receiptから依存を補う。元の版、生成元、必要な権限、または探索範囲を確定できない候補とその公開版は要再確認となる。元データと確定版を保持し、直接の出所への権限を確認できない履歴の閲覧は拒否する。手書きノートは明示登録の来歴で管理する。Schema 1からの段階移行、MigrationのCOMMIT前後の強制終了、旧バイナリによるSchema 3拒否を検証した。
- 同じVaultでの旧Jobの復旧は、元の準備ファイルと公開先が同じinodeで確定内容と一致する場合に限って中断した公開を成功にできる。別Rootへ復元した場合、公開の有無が不確かなJobは競合として残る。旧実装が `PENDING / prepared=0` に巻き戻したJobについて、旧バイナリで復元・再開後に取り直したBackupからの再作成も防止した。現在版を読める既存の公開ノート、過去版、既存の成功Receiptを引き継ぐ。
- DATA-1と監査対象MEM-1のバイナリで作成した旧Backupを実際に読み込んだ。復元したRootはセッションを無効化し、資格情報の再設定と明示再開を要求する。Vaultには別の明示再開が必要。旧・新Backupの識別方法、切戻し、差分APIの応答とクライアントの再同期手順は[運用手順](map-mem-1.md)に記載した。

### 修正コミットの検証結果

| コマンド・条件 | 成功 / 失敗 / Skip | 経過時間 |
| --- | ---: | ---: |
| `npm run test:memory`（並列度2） | 64 / 0 / 0 | 24秒 |
| `npm test`（リポジトリ既定、並列度2、ほかのスイートとの同時実行なし） | 2,196 / 0 / 0 | 426秒 |
| 同じMEM-1専用スイートを `--test-concurrency=1` で実行 | 64 / 0 / 0 | 35秒 |
| `npm run typecheck` | 成功 | 8秒 |
| `npm run build` | 成功 | 3秒 |
| `npm run test:memory-browser`（Chromium） | 成功 | 21秒 |
| `npm run test:app-data-browser`（Chromium） | 成功 | 16秒 |
| `npm run test:app-data-redteam` | 132 / 0 / 0 | 27秒 |
| `npm run test:app-data-crash` | 19 / 0 / 0 | 9秒 |
| `npm run test:macp`（固定Receiver、一時loopback） | 9 / 0 / 0 | 2秒 |
| `npm run test:notification-macp`（同じReceiver） | 8 / 0 / 0 | 6秒 |

`git diff --check` と、監査対象から修正コミットまでを指定した `git diff --check b982414 HEAD` はともに成功。試験件数はスイート間で重複する。全体は通常の並列設定で、MEM-1は同一ファイル群を並列度2と1の各条件で確認した。MACP Receiverは上記の固定コミットを使用した。

F-03については、同じ修正コミットの初回リンク直後の強制終了試験に、復旧完了後もう一度新しいWorkerプロセスを起動する操作を加えて別途確認した。削除・改名・内容の異なる置換・同一内容への差し替えの4条件で、2回目の再起動後のVault内全Markdown名が利用者の操作結果と一致し、成功Receiptは0件だった。

Chromium 156のMEM-1試験では合成Providerの送信1回、公開Receipt 2件を観測し、外部保存直後の古い撤回への409、新版・削除確認後の撤回、リロード時の版履歴を実画面で検証した。DATA-1のブラウザー試験は、実セッションCookie、添付・会話の保存と再読込、訂正履歴、権限失効時のキャッシュ破棄、外部通信0件を確認した。

## 最終確認へ引き継ぐ項目

各工程の検証報告から下表の情報を集め、MEM-3後に採用構成に必要な手順、実施順、合否判定、切戻しを一本化する。先に採用したMEM-4の変更もその時点の確認対象に含める。

| 未実施の確認項目 | 既に確認した範囲 | 必要な実施条件 | 確認手順と成功条件 |
| --- | --- | --- | --- |
| 実Providerの疎通・費用・利用上限 | 合成Provider、Usage不明時の扱い、単回送信・上限・Receiptの回帰 | 採用モデルの提供状況、価格表、鍵、許可費用と回数 | モデル設定と価格を照合し、明示的に有限の送信を実施。保存Usage・料金・上限と再読込時の送信数を照合する |
| 実データ移行 | 合成会話・添付とPR #38移行回帰、旧Schema／Backup | 利用者が保全した原本、分離した試験Root、移行を許可した担当者 | Dry Run→移行→件数・日時・分類・添付・digestを照合し、原本からやり直せることを確認する |
| 配備先での復元と切戻し | Linuxの一時領域でDB・添付・Vault確定版・レビュー・保留Jobを復元 | 対象媒体、旧バイナリと更新前Backup、資格情報再設定経路 | 空の別Rootに復元、停止状態・参照・失効を確認し、MEM-2の索引を再構築。元構成への切戻しを実演する |
| 認証・配備 | ローカルHTTPでCookie、CSRF、Origin、ログアウト・失効、保護されたAPI | 実TLS終端、Proxy、採用Origin、Cookie方針、鍵配置 | 正規経路でのみログイン・更新でき、セッション取消しが反映されることと、秘密・Vaultが静的配信されないことを確認する |
| 対象OS／ファイル操作 | Linux procfsとoverlayfs、通常の本文編集・改名・ファイル競合・強制終了 | 実際のOS、媒体、Obsidian、OS権限・同期ソフト・プラグインの構成 | 新規公開・本文編集・改名・リンク・重複・停止回復を実施し、人間の内容を保持し、異常な現在版を返さないことを確認する |
| 品質・性能・運用 | 合成データで保存から記憶管理・復元まで。公開処理・走査の有界性 | MEM-2／MEM-3の検索と回答構成、採用データ量、費用・性能目標、Backup頻度・保持世代・RPO／RTO | 記憶・原文検索と回答の根拠、応答時間・費用・連続利用、復元時間と損失範囲を測り、採用時の目標と照合する |
