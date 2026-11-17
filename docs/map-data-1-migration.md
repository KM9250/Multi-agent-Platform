# DATA-1 移行・Export・Backup／Restore

この手順は `app-data.sqlite`（App Schema 1、`app_001_conversation_persistence`）だけを対象にする。COORD Schema 11、Obsidian、MEM-1以降の記憶公開・索引は変更しない。以下のデータは合成試験用であり、実データの移行や実Provider呼出しを自動実行しない。

## 旧ブラウザからの移行

1. 旧ブラウザで通常の会話生成を停止し、旧ページの既知キー `rooms` を明示的にExportする。新画面の「旧localStorage Export」も同じキーだけを読む。通常起動はlocalStorageから会話を復元しない。移行元識別 `sourceId` はExportファイルに保存し、再試行時に同じ値を使う。
2. 保護された場所へ元Exportを保存する。Exportは暗号化されていない。APIキーを含むフィールドは取込拒否になるため、旧データを別の保護コピーとして保全し、秘密フィールドを除いた移行用コピーを作る。秘密をサーバーの会話データへ移さない。
3. 認証済み画面でJSONを選び、Dry Runを実行する。APIは `POST /api/app/v1/migrations/dry-run`、本文は `{sourceId, rooms}`。件数、Manifest Digest、時刻不明・旧未完了生成・分類不明情報の隔離警告を確認する。
4. 確認後に明示的にImportを開始する。`POST /api/app/v1/migrations/import` に同じデータと新しい `requestId` を送る。切断・再試行時は同じ `requestId` とPayloadを維持する。同じRequest IDの異なるPayloadは拒否される。新しいRequest IDで同一Batchを再照会した場合も、そのRequest IDは元Payloadに束縛される。
5. `GET /api/app/v1/migrations/:batchId` で照合結果を確認する。Batch完了までRoomは通常一覧に公開されない。中断したBatchは同じ入力から再開し、確定済み項目対応を再利用する。生成処理はImportから起動しない。
6. 空の別ブラウザでログインし、Room・Persona・会話・添付・日時を確認する。旧端末のデータ削除はこの確認後の明示操作として行う。全ブラウザStorageの無差別消去や移行前の自動削除は行わない。

同名Personaは自動統合せずRoom内の旧IDから別の安定IDへ対応付ける。同じ旧IDの内容が異なる別ブラウザExportは競合として拒否し、どの原本を採用するか利用者が確認する。同一内容のコピーは既存の確定済み対応へ収束する。IDの変更、Base64からバイナリ添付への変換、未完了状態の隔離を対応表へ記録する。

旧本文をImport時刻で置換しない。`occurred_at` は旧時刻、`ingested_at` は取込時刻である。旧時刻が欠ける場合は0と `timestamp_trust=unknown` を保存する。旧モデル本文・未知分類・不完全な構造化応答は、必要に応じ `developer_only` の `gm_log` に隔離し、公開本文へ変換しない。元の本文は保護された `import_source_records` とそのDigestに保全する。旧Owner、Roleによる権限、承認、実行済みフラグ、`isStreaming` は新しい権限やProvider送信Receiptにならない。

移行照合はRoom・Persona・Message・Revision・Segment・Decision・Reaction・添付の件数に加え、保存された本文・Segment・設定・添付のDigestと時刻を確認する。Legacy Decision／Reactionは履歴として専用表に保存する。既存のGeneration Receiptを偽造しない。Raw Decision／Error本文を通常の診断DTOへ出さない。

初期上限は16 MiBの移行JSON、50 Room、Roomあたり16 Persona、合計20,000 Message、1,000添付、各添付4 MiB、各Message本文32,768文字。HTTP入口の共通Body上限がこれより小さい場合は入口が優先する。上限超過は固定エラーで拒否し、切り詰めない。大きな移行は別Exportへ分割し、元のIDと出所を保持する。各項目のDB確定とイベントループへのyieldを分離して、長い単一書込みTransactionを作らない。

## 認可付き標準Export

`GET /api/app/v1/rooms/:roomId/export?limit=50` は `MAP-DATA-1:EXPORT:1` のJSON Chunkを返す。`nextCursor` がある間、同じRoomとSessionで `cursor` を渡して続きのChunkを取得する。画面は全Chunkの取得が完了した場合だけ完了したExportとして保存する。CursorはActor・Workspace・Room・現在のACL版・期限・Export用途へ暗号的に束縛する。

各Chunkは最大200 Messageで、各Messageの最大1,000 Revision、最大16 MiBの出力に制限する。これらを超えた場合は固定エラーとなる。公開本文と、現在の明示的なPersona／Visibility単位のPrivate閲覧権で許可された原本だけを出力する。Private専用 `/memory` 原本も同じ認可を満たす場合に含まれる。通常の会話閲覧権や管理権限だけでは含まれない。削除済みMessage／Persona本文は過去Revisionを含めて除外する。

JSONにはStable ID、Revision、分類、原本参照、許可されたSegmentのDigest、添付Manifestを含む。添付のバイナリは現在認可付きの `.../attachments/:id/content` から取得する。サーバーパス、Blobキー、Session、Provider生応答、Raw Promptは含めない。Export途中のACL撤回・Room変更・原本削除を確認して固定エラーにし、古い出力を返さない。複数Chunkをまたぐ利用者の同時編集は一つのDB Snapshotとは保証しないため、完全な保全には次の停止中Backupを用いる。

## Host Backup

Backupは停止したアプリケーションサーバーの保護データ領域で実行する。HTTPサーバーとCLIは `.server.lock` を共通利用するため、起動中のHostを勝手に停止してBackupすることはない。Crash後のStale Lockは自動削除せず、Host管理者が当該プロセス停止を確認してから除去する。直接SQLiteを書き換える外部ツールを同時使用しない。

CLIの `backup` で、稼働Rootと重複しない空の保護された別ディレクトリを指定する。新規書込みをDB上の保守状態でも停止し、RUNNING／DISPATCH_INTENTが残るとBackupを拒否する。新たな実行はせず、まず既存Generationを診断する。

Backupは `VACUUM INTO` で整合DB Snapshotを作り、DBが参照する添付をコピーする。稼働DB本体だけをコピーする処理ではない。単一のファイル・DBの原子的Transactionを複数Store全体へ拡張したと説明しない。アプリケーションの書込みを静止させたうえで、添付のサイズとDigest、Schema、外部キー、SQLite整合性、保存Segment・Persona設定・Message Revision・Import原本文の意味上のDigest、削除状態、原本参照、Import状態を検証し `manifest.json` を最後に確定する。

Manifestの `restoreTested:false` はBackup成功と復元試験成功の区別を示す。ハッシュ計算・参照検証は小さな単位で処理する。Backup CLIはHTTP・COORD Runtimeとは別プロセスで実行する。失敗したBackup先には未完成ファイルが残り得るが、Manifestがない領域を成功したBackupとして使わない。稼働領域の保守フラグは通常の例外時に解除する。強制終了後に保守状態が残った場合はHost管理者が停止状況とデータ整合性を確認する。

既存COORDも同時に保全する場合は、そのRuntimeの既存停止・Backup手順を別に実行し、両Snapshotの取得時刻と対応を運用台帳に残す。このコマンドはCOORD Runtimeを停止せず、複数DB全体の原子的Snapshotを保証しない。保持世代・RPO・RTOはHost側で明示設定し、自動消去期間は勝手に設定しない。

## 空の別領域へのRestoreと再開

1. CLIの `restore` に検証済みBackup元と空の別Rootを渡す。既存稼働Rootへの上書き、Backup元とのパス重複、Symlink／Hardlinkを拒否する。添付Digest不一致・欠落は空ファイルへ置き換えず失敗にする。
2. Restoreはコピー前に `RESTORED_DISABLED` を書き、完了時にSchema、参照、削除状態、Import状態、添付、意味上のDigestを検証して `restore-report.json` を作る。途中停止したRootも自動起動できない。
3. 旧Sessionを削除し、旧Password検証値を無効化する。復元されたQUEUED／RUNNINGは `NEEDS_REVIEW`、予約・送信Intentは `OUTCOME_UNKNOWN` へ保存する。Provider送信、App Job、通知は自動再開しない。
4. Host側の `password-reset` で少なくとも一つのActive Accountへ新しい資格情報を設定する。復元直後の保守状態では、この明示的なHost専用資格情報変更だけを許す。旧Passwordを設定し直さないAccountはログインできないまま残る。Providerキー・TLSなどのHost設定も別経路で用意する。
5. `resume` は上記資格情報変更、復元Report、添付、原本参照を再確認して停止マーカーを解除する。この操作自体ではProviderを呼ばず、旧Generationを再送しない。明示的にサーバーを起動し、ログイン・Room／会話／添付の復元確認を行う。
6. 元Rootは復元検証完了まで保全し、切替えを戻す場合は復元Rootを停止して元Rootへ設定を戻す。元Rootと復元Rootを同じ書込み先として同時起動しない。

Linux合成環境ではBackupと別RootのRestoreをそれぞれ試験する。Windows Junction／Reparse Point、実配備先の権限、バックアップ媒体、実Providerは別の実環境Gateで確認する。本書のLinux合成成功をそれらの成功へ合算しない。
