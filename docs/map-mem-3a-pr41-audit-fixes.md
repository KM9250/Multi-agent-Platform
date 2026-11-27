# PR #41 監査修正記録（F-01〜F-05）

この記録はv1.0修正時点のもの。追加で判明したF-01のworker先行とF-02の狭いHost枠については[再監査v1.1修正記録](map-mem-3a-pr41-reaudit-v11.md)を参照。

作業開始時のPR最新HEADは監査対象と同じ `99d124ae9ecd4d38282926ac531ae17733ff4c7f`。後続差分はなかった。監査証拠ZIPの4ファイル・5件をそのまま配置して実行し、修正前は0成功・5失敗・0skipだった。各assertは要求される動作を検査している。実装後は5件すべて成功し、同ファイルに関連する回帰試験を追加した。

最終HEADと、そのHEAD上の型検査・ビルド・全体試験・Browser・MACPの実行時間／件数は[PR #41](https://github.com/KM9250/Multi-agent-Platform/pull/41)の再監査提出欄に記録する。以下は修正内容と、同じ確認を再実行するための対応表である。実Provider呼出しは0件。監査時の既存suite 2,355成功は監査者の記録であり、今回の実行結果と区別する。

## F-01：一時的な検証不能と恒久失効

`NoteVerificationPending`（`NOTE_VERIFICATION_PENDING`）を共有の一時保留として導入した。全体inventoryの未完了、走査中の再不在・ファイル変化、再試行可能なI/O異常は、原本・承認・必要権限の不一致とは区別する。原本検証、由来確認、原文取得、publicationの呼出元までこの区別を保持する。

scannerは開始時から`incomplete=1`を維持する。完全inventoryのID一意性と現在のfile stampを使う内部の同期scopeでのみreconcileを行い、各原本のbytes・version・digest・由来・権限の確認を続ける。通常読取はこのscopeを使えない。directoryとfileのstampをreconcile前後で照合し、最後まで正常な場合だけ`incomplete`を解除する。走査中のNote取得・Index更新も一時保留とし、不在とみなしたtombstoneとcursorを確定しない。

NOTEの分割検証は一時保留時に`PENDING`、NOTEカーソル、検証数を維持する。`last_step`だけを後ろへ回し、別候補の進行を妨げない。再開時には現在の原本・権限と既存の失効epochを再確認する。1 sliceの上限4作業、NOTE authorityの上限32件は変更しない。既存の`NEEDS_REVIEW`／`INVALID`を一括解除する処理は追加していない。

- 主実装：`server/memory/verification-state.ts`、`lineage.ts`、`sources.ts`、`source-validation.ts`、`importer.ts`、`notes.ts`、`worker.ts`。Index側の一時保留は`server/search/sources.ts`。
- 主再現：`test/pr41-audit-lineage-scan-recovery.test.ts`の`PR41 audit:`。実検索によるA→回答→`/memory`→Bを再現し、同一bytes・version・receiptのまま復帰後のA/Bを読めることを確認。
- 別回帰：同ファイルの再中断、走査途中のduplicate追加、再度の物理Vault不在、実改変・削除・duplicate・revoke→regrant、NOTE保留中の再起動と別候補の完了。保留カーソルが不変で、未検証NOTEを数えないことも検査する。
- 既存回帰：`memory-context-lineage`、`memory-source-validation`、長いlineageのF-06、関連権限のF-07、`context-backup`等。

## F-02：部分引用と全文要求

新しいRouter v2は原文忠実性と全文必須を別フィールドで保存する。「一文」「該当箇所」「冒頭の文」は部分引用であり、「全文から一文だけ」も同様。「原文」「引用」だけでは全文へ展開しない。

部分引用は検証済みhitとその前後各最大128 UTF-16 unitsを同一原本から取得する。汎用の文抽出器や追加LLMではなく、境界付近の短文を含む有界の原文範囲を選ぶ。Source identity・revision・digest・半開offsetsを保持し、サロゲートペア／CRLFの途中を避けてPlan確定前に範囲を決める。

明示的な全文要求は各検索先の最初の採用Source全体を必須とし、補助候補の全文を要求しない。必須範囲が引用APIの4,096 UTF-16 units上限、検索先のtoken枠、合計枠、Host入力枠を超える場合は`CONTEXT_LIMIT`を維持する。通常履歴・入力・pin・添付を削って収めない。

- 主実装：`server/generation/context-router.ts`、`context-plan.ts`、`context-manifest.ts`、`shared/context-contracts.ts`。
- 主再現：`test/pr41-audit-context.test.ts`の4,920 units Sourceから短い原文を引用するケース。
- 別回帰：同ファイルのSource途中／chunk境界の一文、長い補助候補、絵文字・CRLF、無指定の原文引用、引用API上限超過。
- 全文保護：`test/context-packing.test.ts`の入力を「全文を省略せず引用」へ明確化。全文が収まる場合の0..lengthと、Host枠不足時の失敗assertは維持した。

## F-03：日時付きの過去発言確認

`auto`では比較意図→明示日付→解決済み日付付きの会話確認→Memory意図の順で判定する。過去発言と「方針」「決定」「合意」の語が重なってもArchiveへ到達する。明示mode、Persona／Room既定値、用途除外、訂正前のHuman履歴案内は既存の優先順位を維持する。

受付時点の相対日・IANA timezone snapshot、年省略の曖昧／strict条件不足、approx前後7暦日を維持した。検索先の判定だけを修正し、原文の記録日時は変更しない。

- 主実装：`server/generation/context-router.ts`。
- 回帰：`test/context-router.test.ts`、`test/pr41-audit-context.test.ts`。通常履歴窓外・pinなしの実GenerationでArchive manifestとProvider payloadを確認。11/11指定から11/9の原文が得られても`recordedAt`は11/9のままである。

## F-04：外部送信の直前に期限を再確認

親Runの送信開始専用gateを予算予約、Intent記録、Intent COMMIT後に適用する。最後のgateはSource・認可・AbortSignalの確認後、`provider.embed()`の直前に現在のDB状態とサーバー時計を確認し、その間に追加の原本取得やawaitを挟まない。Run/binding、RUNNING状態、取消、`dispatch_before`、`deadline_at`を確認し、既存と同じ`now > deadline`で失効させる。

このgateを応答回収用の共通`check()`へ混在させない。期限内に開始した正常Embeddingのreceipt・Usageは記録し、後続Answerの新規送信は独立して期限を検証する。期限エラーはDense／SearchでLexical品質低下へ変換せず、Coordinatorの停止経路まで伝える。

同じスタックがTransport未呼出しと分かる拒否は`REJECTED`、`dispatched_at=NULL`、Provider Usageなしとして記録し、RunとProfile双方の消費集計から除く。Run終了時のAnswer hold解放、送信後の`OUTCOME_UNKNOWN`と再起動時Intentの保守的回復、自動再送禁止は維持する。

- 主実装：`server/generation/search-budget.ts`、`server/search/profile.ts`、`dense.ts`、`service.ts`。
- 主再現：`test/pr41-audit-budget-generation-deadline.test.ts`の実Coordinator＋AbortSignal＋Intent直後の時計更新。
- 別回帰：同ファイルのIntent前失効、deadline超過、取消、SEND撤回、期限内と境界時刻、dispatch期限後の正常応答回収。`context-budget*.test.ts`、SearchのCrash・UNKNOWN・Human経路も確認対象。

## F-05：AIの送信可能範囲に一致するfreshness

AI用SQLへ現在のSource ownerに対する`SEND_TO_PROVIDER`（Providerとvisibilityを含む）を追加した。READ、Actor／Workspace／Room、ownerの所属・削除・有効性・historical identityも候補の認可と一致させる。consumerのgrantで別ownerを代用せず、空visibilityのgrantをpublic／room_sharedへ読み替えない。Human用SQLは維持した。

Archiveはaccepted input cutoffと再生成除外を適用したうえで、change logの該当revisionと直前revision、削除時の過去公開segmentを確認する。Memoryは現在の共有scopeと認可を確認し、Note別change logを状態で除外せず照合するため、撤回等の除去イベントも検出する。過去grantで現在の権限を復活させる処理はない。

後段の有限件数filterを使わず、認可条件をSQL内のLIMIT前に適用する。全本文やMarkdownをfreshnessのために読み込まない。Room/change positionとNote/change positionの索引を利用し、読取エラーをreadyへ変換しない。

- 主実装：`server/search/sources.ts`の`AI_ARCHIVE_FRESHNESS_SQL`／`AI_MEMORY_FRESHNESS_SQL`。
- 監査済み主再現：`test/pr41-audit-search-scope.test.ts`のArchiveケース。監査時の漏れを観測する補助assertも、内部判定・Provider payloadともに`INDEX_LAGGING`がないことをassertする形に更新した。最後の期待assertを弱めてはいない。
- **今回新たに動的確認**：同ファイルのMemory。実grant、AI binding、Worker、ContextPlan、Provider payloadを使い、送信不可Noteの実ファイル編集が遅延を立てないこと、許可Noteの編集／撤回は遅延を立て、同期で解消することを確認する。
- 別回帰：Archive削除／非公開化、240件の対象外更新の後にある対象内変更、cutoff・再生成除外、Human判定、`EXPLAIN QUERY PLAN`の索引探索。

## 保存互換性と実行入口

DB schemaは7のまま。新migration、適用済みmigration変更、DB初期化、Vault再作成、全件再Importは不要。Manifest外側の`MAP-MEM-3:CONTEXT:1`と旧DATA-1 readerは維持する。閉じたroute schemaはv2のbooleanだけ追加し、未知項目・不正型を拒否する。保存済みv1を読み直す際は元のSource・引用範囲を保持し、Routerを再実行しない。NOTE lineage／citation／Backupのreaderも同じ検証器を使う。

```bash
mkdir -p work/pr41-audit-after
PR41_AUDIT_EVIDENCE_DIR="$PWD/work/pr41-audit-after" \
node --experimental-transform-types --loader ./test/ts-loader.mjs \
  --test --test-concurrency=1 --test-name-pattern='PR41 audit:' test/pr41-audit-*.test.ts
# 全監査回帰（追加ケースを含む）
node --experimental-transform-types --loader ./test/ts-loader.mjs \
  --test --test-concurrency=2 test/pr41-audit-*.test.ts
npm run typecheck
npm run build
npm test
git diff --check
```

Browser4本とMACP2本は、利用可能なChromium実体と既存の固定MACP checkoutで実行する。MACPの基準は`e88937d0c8132ae7d18098a24d01ee28bffda655`。実Provider Usage／請求額、実利用者データ移行、対象運用機器のBackup／Restore、実TLSは今回の確認に含めず、既存の本稼働Gateへ引き継ぐ。MEM-3B以降の新機能は含めない。

今回のv1.0記録以降のLEGACY公開復元、行指定、短縮metadataの残存条件と対応は[再修正v1.2記録](map-mem-3a-pr41-reaudit-v12.md)を参照。過去の監査結果・実行HEADは各版の記録として保持する。
