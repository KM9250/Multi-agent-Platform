# PR #41 再監査修正記録 v1.1

対象はF-01・F-02の残存条件。作業開始時のPRとローカルHEADはともに `2beb8c4bcc5836a93348b7e2c5ff11857867a1f2` で、後続変更・ローカル変更はなかった。F-03〜F-05の実装は維持する。マージは再監査後の判断とする。

添付ZIPの3ファイルを `test/` に配置して修正前に実行した結果は **11成功・3失敗・0skip**。失敗はF-01のworker先行と内部readNote補足の2件、F-02の入力上限1,600の1件。F-05のscope matrixは11件とも成功した。添付READMEに記された全体2,399成功は再監査側の記録であり、今回の最終実行とは分けて扱う。

最終HEAD、各コマンドの結果・件数・実行時間は、コミット後に同じHEADで実行し、[PR #41のv1.1再監査提出欄](https://github.com/KM9250/Multi-agent-Platform/pull/41)へ記録する。この文書は実装と再実行手順の対応表である。

## F-01：実際に失敗したアクセス段階で保留を判定

`vault.ts` の `registeredDir()` で、登録Vaultのパスを安全に開き、dev・inode・modeを確認する境界に例外分類を置いた。ここでのENOENT、EIO、EAGAIN、EBUSY、EACCES、ESTALEは `VaultRootUnavailable`（`NoteVerificationPending`の派生）になる。登録ルートを取得できていないので、個別原本の削除を確認したとは扱わない。

`readVaultFile()` は読取後にも登録ルートから再openして原本を照合する。この再openにも同じ分類が適用され、事前のexists検査だけでは検出できない読取途中のルート不在を保留できる。ルート取得後の個別NoteのENOENT、内容不一致、安全性違反は既存の失効・再確認処理を維持する。別ディレクトリのdev/inode不一致とsymlinkは保留による正常復帰として受理せず、登録情報を書き換えない。

祖先のfile stamp取得、Note自身の原本読取、scannerのreconcileでもPendingを恒久失効へ変換しない。readNoteは公開エラーコードMEMORY_UNAVAILABLEを維持しつつ、内部のPending型を保持する。索引更新の同期／非同期ページ読取もこの型を再送可能な保留として伝播し、個別削除のtombstoneやcursor進行へ変換しない。この追加回帰は修正前に失敗を確認した。workerとpublicationの既存Pending経路へ伝播する。scannerの完全inventory内部scope、完了までのincomplete維持、通常読取の原本照合は変更していない。

NOTE検証では既存の永続frontier・authority cursor・checked・検証数を保持し、未完了NOTEを数えない。Pending時にlast_stepを後ろへ回す処理と1 sliceの上限を維持する。復帰後も現在の原本、digest、権限、失効epochを照合する。既存INVALID／NEEDS_REVIEWの一括解除はない。

| 変更・確認 | ファイル／テスト |
|---|---|
| ルートopenと再openの段階分類 | `server/memory/vault.ts`、`verification-state.ts` |
| Pendingの伝播 | `server/memory/source-validation.ts`、`notes.ts`、`importer.ts`、`server/search/sources.ts`の取得不能分類 |
| 実worker先行の主再現、内部readNote補足 | `test/pr41-reaudit-f01-read-before-scan.test.ts`（添付名を維持） |
| scan先行、再中断、原本変更・削除、duplicate、revoke→regrant | `test/pr41-audit-lineage-scan-recovery.test.ts` |
| Pendingでの再試行・再起動・別候補の完了、再開時の改変・権限失効 | 同ファイルをscan先行／worker先行の両方へ拡張 |
| 読取中の実rename、個別削除・改変、別root・symlink、祖先stamp、publication、索引ページの保留 | `test/memory-vault-access-boundary.test.ts` |

worker主再現は実Memory参照回答と `/memory` から候補を作り、manifest・依存関係・queueを注入しない。障害中はPENDING／LINEAGE_PENDING、復帰後はDONE／PENDING_REVIEWになり、原本digestは変わらない。readNote補足は直接の内部呼出しの検証であり、先行する祖先検証があるHTTP／UIで必ず同じ失効が起きるという説明には使わない。

## F-02：必要な範囲を確保してから周辺資料を収める

`context-excerpt.ts` は同一の検証済み原本に対し、文・行の境界と既存検索のquery scoreで必要範囲を選ぶ。冒頭の明示指定は最初の空白でない文・行を選ぶ。比較用の正規化はscoreにだけ使い、供給する本文は原本のsliceのままとする。一般的な意味解析器や追加LLMは導入しない。

必要な文がhit境界や旧128-unit marginを越える場合は、その文末まで必要範囲に含める。hitと前後最大128 unitsは補助範囲であり、サイズ自体をユーザーの必須引用範囲と扱わない。明示的全文要求では従来どおりSource全体が必要範囲になる。

`context-plan.ts` は検索と原本検証を終えた後に容量を調整する。両検索先の必要範囲を先に確保し、優先順に周辺と補助資料を追加する。部分引用の候補は周辺margin付き、元hit（必要な文を欠かさない範囲）、必要な文・行の順で評価する。必要範囲を切断して収める処理はない。容量に余裕があれば従来の周辺も供給する。

各評価で実際のsystem instruction、現在入力、通常履歴、reference metadata、全検索status・reasonを含むenvelopeを構築する。短縮時のEXCERPT_TRUNCATED、除外時のCONTEXT_CAPACITYも含める。Memory 2,048、Archive 4,096、合計6,144 tokens、Host入力枠、citation API 4,096 UTF-16 unitsは維持する。

最終範囲の原本内包含・UTF-16・CRLF境界を確認し、原本のsliceと対応するoffsetsでContextPlanを確定する。その後の再検証はidentity・revision・digest・固定範囲を照合するだけで、再検索・範囲再選択・外部APIを行わない。

主再現の実Coordinatorによる最終payloadは次の結果になった（最終HEADでも再実行する）。

| 項目 | 実測 |
|---|---|
| 状態 | COMPLETED |
| requiresFullSource | false |
| 対象Source | 通常履歴窓外、4,920 UTF-16 units |
| 必要な一文 | `cedarの保存先はSQLiteです。`、19 units |
| 固定引用範囲 | `[0, 768)`、原本sliceと一致 |
| 全入力の推定token数 | **1,488 / 1,600**（EXCERPT_TRUNCATED込み） |
| 合成Provider | 通常回答1回 |
| 実Provider | 0回 |

添付の仮想payloadによる容量証明も残すが、修正の受入assertは実際に渡したpayload、Citation、最終token数、呼出し回数で行う。

| 確認 | テスト |
|---|---|
| 主再現、既定枠、Source/Citation一致、実payload token数 | `test/pr41-reaudit-f02-partial-budget.test.ts`（添付名・元assertを維持して強化） |
| hitにも収まらない狭い枠、途中の文＋長い補助候補、hitと旧marginをまたぐ文、絵文字・CRLF、必要範囲自体の容量不足 | 同ファイルに5ケース追加 |
| 全文が枠内なら全文、Host枠外なら拒否、固定Planの再現 | `test/context-packing.test.ts` |
| 部分引用、全文citation上限、Router v1/v2 reader、F-03の実生成 | `test/pr41-audit-context.test.ts` |

## 互換性・解消済み指摘

永続schema、migration、HTTP入力項目、Router v2のフィールド、manifestの保存形式は変更していない。旧v1／DATA-1を含め、保存済みmanifestは元のSourceRef・引用範囲・digestを読む。新packingで過去のmanifestを作り直さない。Citation、Note lineage、Backup／Restoreの既存readerを維持する。DB初期化、Vault再作成、全件再Importは不要。

F-03のRouter、F-04の送信期限・送信後Usage回収、F-05のfreshness認可条件に変更はない。SearchSourcesの変更はF-01に関係する原本読取のPending分類のみ。前回の主再現5件を再実行し、添付 `test/pr41-reaudit-f05-scope-matrix.test.ts` の11ケースも実grant／AI bindingのまま確認する。前回監査のArchive主再現、前回修正時に追加したMemory動的検証、今回追加されたscope matrixは別の確認として記録する。

## 再実行

```bash
mkdir -p work/pr41-reaudit-v11
PR41_REAUDIT_EVIDENCE_DIR="$PWD/work/pr41-reaudit-v11" \
PR41_AUDIT_EVIDENCE_DIR="$PWD/work/pr41-reaudit-v11" \
node --experimental-transform-types --loader ./test/ts-loader.mjs \
  --test --test-concurrency=1 test/pr41-reaudit-*.test.ts

npm run typecheck
npm run build
npm test
git diff --check

npm run test:context-browser
npm run test:app-data-browser
npm run test:memory-browser
npm run test:search-browser
MACP_REPO_PATH="$PWD/work/macp" MACP_PYTHON="$PWD/work/macp-venv/bin/python" npm run test:macp
MACP_REPO_PATH="$PWD/work/macp" MACP_PYTHON="$PWD/work/macp-venv/bin/python" npm run test:notification-macp
```

Browserは利用可能なChromium実体、MACPは既存の固定checkout `e88937d0c8132ae7d18098a24d01ee28bffda655` を使用する。一時DB／Vault、合成Provider、loopbackの検証のみで実Provider呼出しは0件。実Provider疎通・Usage／請求、実データ移行、運用機器のBackup／Restore、実TLSは既存の本稼働前Gateへ残す。


## v1.2で確認した残存条件への追記

v1.1の提出HEAD `1869fb7d0feb82662a7704e0d97e98002cc74022` に対する追加監査で、次の3条件が残っていた。上記v1.1の結果とは区別し、修正・実測・最終検証は[再修正v1.2記録](map-mem-3a-pr41-reaudit-v12.md)とPR提出欄へ記録する。

- F-01：LEGACY公開復元のsavepoint rollback後にもPendingを再throwし、既存の再試行へ渡す。新規候補のレビュー待ちではなく、旧公開済みNoteのPUBLISHEDへの復帰を確認する。
- F-02-A：内部の行指定と文指定を区別し、要求された行の複数文を必要範囲として保持する。
- F-02-B：全完全版／全最小版だけで判定せず、primaryの最大9候補組み合わせをstatus・reason込みの実容量で評価する。添付なしanswerの固定2,048-byte予約による先行拒否も、既存の実入力検査へ到達させる。添付ありの本文読取前の容量検査は維持する。
