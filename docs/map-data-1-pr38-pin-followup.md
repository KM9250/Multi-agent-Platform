# PR #38 再監査追補：履歴窓1件と先頭固定

2026-11-17（日本時間）。基準HEADは `8316007b8803f44f1cee4d200b177f9babb0201c`。
対象はF-03の履歴枠と先頭発言固定の衝突だけである。F-01・F-02・F-04とFramework／推論設定の修正は維持する。
最終コード・テストSHA: `02e5254c2947e50b8b8f6c26e29fa1c02d520acd`。公開HEADはPR #38本文に記載する。コードSHA以降は文書のみ。
実Provider課金と実データ移行は行っていない。本稼働Gateは未通過のまま。

## 修正する契約

旧動作では、履歴窓1件・固定ONで現在入力が先頭発言と異なると、先頭発言が現在入力を押し出し、
現在入力の本文も添付もProviderへ渡らないまま生成が成功した。
ContextCompilerは、現在の認可と入力版を検査した後、認可・分類・削除状態・入力のseq境界内の
最初の人間発言を選ぶ。そのMessage IDが受理した入力と異なり、Host上限適用後の枠が1件なら、
固定コード `HISTORY_WINDOW_PIN_CONFLICT`（GenerationError 409）を投げる。
HTTP受付は従来どおり202で入力・Runを保存し、非同期実行のReceiptはFAILEDと固定エラーを返す。
Call予約とProvider送信に到達せず、待機中へ放置しない。

画面の最新Run概要と各Runには「履歴を2件以上にするか、最初の発言固定を解除してください。」と表示する。
リロード後も保存Receiptから同じ案内を表示し、入力Messageと添付への認可付きリンクを保持する。
保存設定を修正するのは利用者の明示操作であり、自動で窓を広げたり固定を解除したりしない。
同Request ID再送は元のFAILEDへ収束する。設定変更によって古いRunの送信権限を作らない。

| 条件                                               | 動作                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| 実効窓1 / 固定ON / 最初の発言と現在入力が別Message | 固定エラー、Provider 0、Call予約0、入力・添付・設定保持           |
| 実効窓1 / 固定ON / 最初の発言と現在入力が同じ初回  | 現在入力と添付を使用して生成可能                                  |
| 実効窓1 / 固定OFF                                  | 現在入力と添付を使用して生成可能                                  |
| 窓2以上 / 固定ON                                   | 最初の適格な発言と現在入力を保持。Host上限・現在ACL・版検査を維持 |
| 保存窓2以上でもHost上限で実効窓1                   | 別Messageとの衝突は同じ固定エラー。Host上限を広げない             |
| 旧データのImport・設定保存・閲覧                   | 窓1・固定ONを許可し、値を保持                                     |

Messageの同一性は本文の一致で判定しない。同文でも別IDなら衝突する。
Schema・Migration・契約番号は変更しない。この追補前の、窓1で現在入力が欠落して成功する生成動作だけを変更する。

## 修正前と修正後の確認

基準HEADの本番コードに追補試験を置き、実HTTP・Cookie認証・一時SQLite・既存Provider fixtureで確認した。
14追補ケースのうち9成功・5失敗。失敗は本文、本文＋添付、添付のみ、Importした窓1設定、Hostで実効窓1に
制限された設定の5件で、いずれも固定拒否せず生成を完了した。基準HEADの再現を全体回帰の代用にしない。

修正後は、旧「窓1・固定ONでcurrent inputが含まれないことを成功とする」テストを置き換えた。
固定エラー、FAILED、completed_at、Provider 0、Call表0、保存入力本文・添付ID、設定保持、
同Request再照会でRun/Inputが増えないことを検査する。自動参加判断のCallも拒否対象に含める。
初回と固定OFFは本文と添付のみの両方を試し、Provider要求に現在入力のIDと内容が含まれることを検査する。

窓2では削除済み先頭を選ばず、訂正された次の先頭と現在入力・添付をProvider要求に保持する。
compile後に先頭を削除・訂正した場合と送信ACLを撤回した場合も、既存の送信前再検査でProvider 0・FAILEDになる。
これらの後段変更では既存仕様どおりRESERVEDの監査記録1件を保持するが、DISPATCH_INTENTへ進まず送信時刻はNULL。
これは今回の窓衝突の「予約0」と区別する。有限History・token上限の拒否も確認する。

実Chromium試験は、窓1・固定ONの旧設定をImportし、添付付き現在入力でエラー案内を表示する。
入力・添付の保持、送信欄が再編集可能であること、リロード後の案内と添付リンク、Provider追加0・Call追加0を検査する。

## 最終検証

最終SHAの通常並列（ファイル並列度2）は **2,124成功・1失敗**。直列（ファイル並列度1）は **2,125成功・0失敗**。
並列の失敗と診断の詳細は表の後に記載する。既存の `npm test` の並列設定は変更していない。

| 実行コマンド                                                                                                   | 成功 / 失敗 / Skip |      秒 |
| -------------------------------------------------------------------------------------------------------------- | -----------------: | ------: |
| `npm ci --cache /workspace/work/npm-cache`                                                                     |             exit 0 |   7.689 |
| `npm run typecheck`                                                                                            |             exit 0 |   9.275 |
| `npm run build`                                                                                                |             exit 0 |   3.892 |
| `node --experimental-transform-types --loader ./test/ts-loader.mjs --test --test-concurrency=1 test/*.test.ts` |       2125 / 0 / 0 | 980.796 |
| `npm run test:app-data-browser`                                                                                |             exit 0 |  17.846 |
| `npm run test:macp`                                                                                            |          9 / 0 / 0 |   2.326 |
| `npm run test:notification-macp`                                                                               |          8 / 0 / 0 |   6.973 |
| `git diff --check 8316007..HEAD`                                                                               |             exit 0 |   0.012 |

最終SHAで、上表の実行条件を使用した。通常の `npm test` はファイル並列度2。直列へ変更した場合は展開済みNodeコマンドと並列度1を表へ明記する。

その前のコード・テストSHA `333ab53d83fc0c25e76656b2b268b17d0eca6ada` での通常 `npm test` は、2,124成功/1失敗/0 Skip（543.905秒）だった。既存 `coordination-execution-crash.test.ts` のexternal-after試験が `Child timeout`（試験全体39.114秒）となった。この試行には子processのready受信時刻がなく、準備前/後のどちらで止まったかは未特定。結果とログを保全し、同じ15秒watchdogへ準備時刻・観測時刻・期限・PID・終了状態の診断だけを追加した。最終SHAとの本番コード差分はなく、追加後に全体回帰を最初から実行した。

最終SHAの先行試行 `npm test`: 2124成功 / 1失敗 / 0 Skip（552.899秒）。

- PR35 F-01: deadline during the final permission check prevents external entry (232.02849ms)

最終SHAの通常並列失敗は、未変更の `coordination-pr35-audit-regressions.test.ts` の50ms期限ケースで `checked=false` に対してtrueを要求したAssertion（試験232.028ms）だった。最終権限検査の条件分岐に到達したという観測が得られていない。前段の期限到達と整合するが、この失敗試行のInvocation/Step状態は保存しておらず、原因を確定していない。

同じテストをリポジトリ外へ複製し、import参照先を元のファイルに固定、await終了後に状態/期限の診断だけを挿入した。50ms期限、200ms待機、既存Assertionを変えない単独実行は1/1成功。以下はその独立した診断実行の記録であり、上の並列失敗時の状態ではない。全リポジトリ回帰は別途上表のコマンドで行った。

```json
{
  "diagnostic": "independent PR35 deadline fixture",
  "boundary": "deadline",
  "configuredModelTimeoutMs": 50,
  "observedAt": 1794900411739,
  "checked": true,
  "fixtureCounts": {
    "draft": 1,
    "plan": 0,
    "verify": 0,
    "action": 0,
    "prepare": 0
  },
  "counts": {
    "rounds": 0,
    "modelCalls": 2,
    "actionDispatches": 0,
    "readCalls": 1
  },
  "usage": {
    "committed": {
      "inputTokens": 1,
      "outputTokens": 1,
      "costMicros": 0
    },
    "outstanding": {
      "inputTokens": 20,
      "outputTokens": 20,
      "costMicros": 0
    }
  },
  "invocation": {
    "status": "REVIEW_REQUIRED",
    "outcome": "MODEL_REVIEW_REQUIRED"
  },
  "steps": [
    {
      "kind": "MODEL",
      "execution_deadline": 1794900411384,
      "collection_deadline": 1794900441384,
      "application_deadline": 1794900471384
    },
    {
      "kind": "READ",
      "execution_deadline": 1794900416429,
      "collection_deadline": 1794900446429,
      "application_deadline": 1794900476429
    },
    {
      "kind": "MODEL",
      "execution_deadline": 1794900411531,
      "collection_deadline": 1794900441531,
      "application_deadline": 1794900471531
    }
  ],
  "calls": [
    {
      "state": "SETTLED",
      "application_status": "APPLIED"
    },
    {
      "state": "REVIEW_REQUIRED",
      "application_status": "NOT_APPLICABLE"
    }
  ]
}
```

導入中のブラウザ初回試行では、追加ケースより前の既存ACK喪失後の表示待ちが15秒でtimeoutした。記録されたRunはCOMPLETED、Providerは1回で、画面状態は当該ログでは未取得だった。失敗診断へ画面・HTTP・Run期限を追加し、Timeoutを変えず再実行した19操作群が成功した。最終SHAでの再検証は上表の結果を用いる。

最終SHAの実Chromium: 19操作群成功、合成Provider 3回、外部要求0。今回の拒否で追加されたProvider呼出しとCall予約は0。

| Browser HTTP | 回数 |
| ------------ | ---: |
| GET 200      |   87 |
| GET 401      |    6 |
| GET 404      |    1 |
| PATCH 200    |    3 |
| PATCH 409    |    1 |
| POST 200     |    5 |
| POST 201     |    6 |
| POST 202     |    5 |
| POST 409     |    1 |

MACPは `e88937d0c8132ae7d18098a24d01ee28bffda655` に固定し、一時DB・認証付きLoopback HTTP・実SSEを使用した。稼働Receiverへは送信していない。Node 24.22.1 / npm 11.9.0 / Linux / 実Chromiumを使用。containerのCPU quotaは4 CPU相当、メモリ上限は16 GiB。設定値のみからtimeoutの原因を断定しない。

既存Assertion・Timeoutは緩和していない。旧窓1の成功Assertionだけは依頼された拒否契約へ置き換え、より具体的な保存・予約・状態検査を追加した。
既存80ms期限試験は不一致時にRun状態・受付/期限/完了時刻・Call状態を診断出力する。
既存Crash試験は15秒watchdog発火時と準備前終了時に子processのPID・mode・境界・ready/done・終了状態を記録する。
ブラウザ失敗時は画面本文（合成fixtureのみ）・HTTP件数・console error・Runの期限を記録する。
これらは失敗診断の追加で、Assert内容や制限時間の変更ではない。既存COORD、通常・redteam・Crash・Import・Backupの試験は全件回帰に含める。
独立したブラウザとMACPの統合試験も実行した。重複Suiteの成功件数は合算しない。

## 公開検査と未検証

公開対象のコミットを検査し、実DB/WAL/SHM・Rawログの混入、一般的なGoogle/GitHub/OpenAIキー形式・秘密鍵は検出なし。診断を追加した既存テストはTypeScript ASTで旧Assertion 121個の保持を確認した。旧窓1の追加試験だけは依頼に基づく契約変更で置き換えた。COORD本番ソースとMigrationは不変。偽キーを環境へ与えたbuildのdistに、キーcanary・GEMINI_API_KEY・Provider SDK/endpoint・source mapはない。最終コードSHA以降は文書のみ。検査は万能な秘密検出保証ではない。

実Providerの課金・Usage・疎通、実データ移行、対象運用機器・実媒体でのRestore、Windows Junction/Reparse Point、
実TLS/Proxy、RPO/RTOは未検証。今回の最小修正で新しい性能SLAは主張しない。
前回の[監査報告](map-data-1-pr38-audit.md)と[運用手順](map-data-1-runbook.md)の本稼働Gateを維持する。
既存PR #38へ追加し、Draftを維持、自動マージは行わない。
