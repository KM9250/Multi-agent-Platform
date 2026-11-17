# PR #38 監査修正 F-01〜F-04

2026-11-17（日本時間）。本報告はDATA-1初回提出の[検証報告](map-data-1-validation.md)に対する追加記録である。
実データ移行・課金Provider呼出しは実施していない。実Providerと対象配備環境の復元が未確認のため、**本稼働Gateは未通過**。

## 来歴

| 項目                  | 値                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| 修正基準HEAD          | `76be76a57a57fbe2dcb01768dd5257ecc660fcaf`                                                               |
| 元の基準main          | `c945bd1228af2c346791012ef3a6935bd5a82d17`                                                               |
| 実装修正              | `d2fcd7f8e4306e3122560b70fb90411d129eb869`                                                               |
| 最終コード・テストSHA | `ebbfa79f89c958e3d60cca4ee3f821cbb2140aa1`                                                               |
| 公開HEAD              | PR #38本文の「公開HEAD」。最終コードSHA以降は文書だけを追加                                              |
| 差分                  | 監査基準HEADから21 files、元mainから66 files                                                             |
| DB                    | App Schema 1 / `app_001_conversation_persistence`を維持。DDL変更なし。COORD Schema 11・既存Migration不変 |
| 環境                  | Node 24.22.1、npm 11.9.0、SQLite 3.53.4、Linux x86_64 / 6.18.57、実Chromium / Playwright 1.65.1          |

## 修正前の再現

基準HEADのソースに、既存と同じDB・認証・HTTP Handler・Provider fixtureを使用する追加試験を置き、
期待動作を確認した。6件すべて失敗し、以下の原因を再現した。さらに基準HEADの独立worktreeで
Frameworkだけを検査し、CoT指示が要求に入らないことも再現した。独立worktreeの試験を全体回帰の代用にはしていない。

| 指摘           | 修正前の観測                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-01           | 3 RoomのBatchにMessageだけ・Decisionだけ・Reactionだけが残る旧Personaを含めると、実HTTP Dry Runが400 `IMPORT_REFERENCE_MISSING`                        |
| F-02           | 実HTTPから `afterAcceptCommit` に一度だけ例外を注入。最初の応答500、保存RunはQUEUED、同Request再送は202/newlyAccepted=falseだが同process内で完了しない |
| F-03 pin       | 窓外の最初の人間発言がProvider要求から欠落。省略したpin設定も旧 `applyHistoryWindow` のtrue既定値と不一致                                              |
| F-03 framework | StandardとCoTのsystemInstructionが同じ。独立Framework試験で `/For CoT/` が見つからない                                                                 |
| F-03 thinking  | 実Loopback HTTPでWorker 512 / Persona 1024を指定しても、双方のgenerationConfigにthinkingConfigが存在しない                                             |
| F-04           | 人間/B/Cの本文が同じ無ラベルtext。`[User]`を含む本文と正規話者情報を分けるEnvelopeが存在しない                                                         |

受付COMMIT後の例外は、通常のHTTP応答喪失やClient側abortではなくCoordinatorからenqueueへ戻る前の障害である。
同じサーバーprocessを維持して再送した。旧HTTP ACK喪失試験も変更せず維持している。

## 修正内容と互換性

### F-01: 履歴Identityと実行Persona

旧agentsにない参照を、Room/旧Persona ID別の履歴専用Identityへ対応付ける。
既存Persona/Revision表とFKを利用するが、サーバー専用 `historicalIdentity` を付け、
`isEnabled:false` と元IDだけを保存し、モデル・Prompt・実行設定を復活させない。
現在の `agents` と `historicalPersonas` を分け、編集による有効化も拒否する。
生成時の対象選択・Persona数上限には現行Personaだけを用いる。Schema/Migration追加は不要。
Schema番号が同じでも、履歴Identityを理解しない監査前バイナリで更新後DBを運用する後方互換性は保証しない。
バイナリの切戻しには更新前Backupを別Rootへ復元し、更新後Rootを保全する。

元Message本文・時刻・Segment分類・Private Owner参照と、Decision/Reactionを保全する。
名前を根拠に統合しない。旧名前の原本がないIdentityは画面で「Deleted Persona (旧ID)」と表示する。
Exportは現在認可を適用したうえで、履歴Persona情報と各Eventの `legacySources` に元ID/Room/出所を含める。
従来の完了済みImportにない詳細は捏造せず既存sourceKeyを保持する。
旧Role/Owner等の未知フィールドを権限へ昇格する変更はない。

3 Room一括のDry Run・Import・同Request再実行・別Request alias・再Dry Run・各Room Exportを実HTTPで検査した。
入力Messageは合計2、履歴IdentityはRoom別3、Provider 0。Private本文は通常Exportから除外し、
そのIdentityへの明示的なPrivate Grant後だけExportに含まれることも確認した。
BatchのPersona件数は履歴Identityを含み、全体20,000の有限上限を設けた。

### F-02: 受付の永続状態から初回実行への接続

POSTの初回・同Request再要求とも、返却ReceiptがQUEUEDなら実行予約する。
Coordinatorの原子的claimと既存の現在Session/認可・期限・版検査を経てから初回Callを作る。
GETのReader・pollingは予約しない。QUEUEDなのにCallが存在する場合はNEEDS_REVIEWへ収束する。
DISPATCH_INTENT/OUTCOME_UNKNOWNを再送可能な状態へ戻さない。

COMMIT直後の一度限りの失敗→同Request再送で、入力Message 1・Turn 1・Run 1・Provider 1を確認した。
成功した回答Messageが別に1件保存される。期限切れとProvider送信権撤回ではFAILED・Provider 0。
保存Intent/Unknownを持つ不整合QUEUEDを注入した場合もNEEDS_REVIEW・追加Call 0・Provider 0である。

### F-03: 設定の意味とProvider能力

- Pinは認可された最初の人間発言を窓内の1枠に固定する。窓外固定ON、OFF、窓1を旧関数の意味と照合した。Hostの履歴/token/byte上限は越えない。
- Standard/CoT/ReActの要求を区別する。不明FrameworkをStandardへフォールバックしない。CoT/ReActは簡潔な明示的要約用の既存Strategyを使用し、Room分離OFFでも構造化出力とPrivate debug分類を適用する。旧公開THOUGHT/ACTIONタグ表示への復帰はしない。
- Personaの回答・memory生成とWorkerのthinkingBudgetをManifestと実generationConfigへ渡す。参加判断Callは引き続き独立した短い判断Promptと有限output上限を使い、Personaの回答用budgetを流用しない。数値budgetの宣言済み能力はGemini 2.5 Flash/Flash Lite/Proに限定し、実効output cap（最大2048）を超える値は `THINKING_BUDGET_LIMIT`、未対応値は `THINKING_BUDGET_UNSUPPORTED` で失敗する。黙ってclamp・model変更・thinking level変換しない。
- 対応Flashの0は明示的な無効化要求。Proの0、Gemini 3への数値budgetは拒否する。その他モデルのlegacy 0は旧Client同様のoverrideなし。未宣言モデルの正数budgetは拒否する。UIにもモデル依存を表示する。
- 旧データで省略された値は、pin=true、framework=standard、Persona budget=0、historyWindow=0を維持する。Worker budget省略は省略のままとし、画面ではProvider defaultと表示する。旧窓0の無制限動作はHost有限上限に制限する。

実Loopback HTTPでは、Worker 512→Persona 1024の2 POSTに加え、各Framework/Persona 0の3 POSTを検査した。
合計5 POST、対応フィールド・systemInstruction・JSON出力指定・保存分類を確認した。
不正モデル能力/Host上限の検査ではProvider HTTP 0、Call予約0、明示FAILED。
これらはfetchの宛先を一時Loopback receiverへ差し替えた試験であり、実Google疎通ではない。
実Providerの数値budget能力・Usageの現在の外部仕様は本稼働前に専用Gateで確認する。

すでに修正前コードで完了したImportの設定を自動変更しない。同Batch再実行は元の確定済み対応へ収束する。
以前に誤った省略既定値が保存された設定は、利用者が確認して明示更新する。

### F-04: 正規メタデータによる話者区別

履歴は `MAP_HISTORY_MESSAGE` JSON Envelopeにし、human/persona・安定Persona ID・表示名・Persona版を
サーバーの保存メタデータから生成する。本文はJSON内のSegment文字列で、偽 `[User]` やJSONを話者として解析しない。
同名B/Cと同文の人間発言が、対象Aへの入力で区別されることを確認した。自身の発言はProvider role=modelを保つ。
Private本文は公開Contextへ追加していない。Envelope/話者情報も入力量計算に含めるため、限界付近の履歴は従来より早くContext上限に達する場合がある。

話者版をManifestへ含め、compile後とIntent COMMIT後の話者名変更も送信前に拒否する。
前者FAILED、後者NEEDS_REVIEW、双方Provider 0。モデルの解釈の完全性を保証するものではなく、
アプリケーションによる正規話者の決定と、機密原文を公開Contextへ渡さない境界を検査している。

## 最終検証

| コマンドまたは対象Suite                       |   成功 / 失敗 / Skip |      秒 |
| --------------------------------------------- | -------------------: | ------: |
| `npm ci --cache /workspace/work/npm-cache`    |               exit 0 |   6.124 |
| `npm run typecheck`                           |               exit 0 |   7.905 |
| `npm run build`                               |               exit 0 |   4.430 |
| 全テストファイル（並列度1）                   |         2112 / 0 / 0 | 916.949 |
| `npm run test:app-data`                       |          133 / 0 / 0 |  28.688 |
| `npm run test:app-data-redteam`               |          116 / 0 / 0 |  21.803 |
| `npm run test:app-data-crash`                 |           15 / 0 / 0 |   8.216 |
| `npm run test:app-data-import`                |           12 / 0 / 0 |   2.547 |
| `npm run test:app-data-backup`                |            6 / 0 / 0 |   2.646 |
| `npm run test:app-data-browser`               | exit 0（件数は別記） |  29.949 |
| `npm run bench:app-data`                      | exit 0（件数は別記） |  22.897 |
| `npm run test:app-data-audit`                 |           15 / 0 / 0 |  14.716 |
| `test:durable` 相当（並列度1）                |          163 / 0 / 0 | 144.240 |
| `test:durable-execution` 相当（並列度1）      |          111 / 0 / 0 |  85.278 |
| `test:recovery-reader` 相当（並列度1）        |          495 / 0 / 0 | 241.935 |
| `test:runtime-lease` 相当（並列度1）          |           46 / 0 / 0 |  23.941 |
| `test:model-call-ledger` 相当（並列度1）      |          103 / 0 / 0 |  36.109 |
| `test:recovery-authorization` 相当（並列度1） |           90 / 0 / 0 |  34.025 |
| `test:recovery-execution` 相当（並列度1）     |          119 / 0 / 0 |  51.678 |
| `test:recovery-dispatch` 相当（並列度1）      |          129 / 0 / 0 |  66.629 |
| `test:recovery-continuation` 相当（並列度1）  |           92 / 0 / 0 | 123.151 |
| `test:planning-only` 相当（並列度1）          |           52 / 0 / 0 |  19.307 |
| `test:hold-lifecycle` 相当（並列度1）         |            5 / 0 / 0 |   2.303 |
| `test:reconciliation` 相当（並列度1）         |          251 / 0 / 0 | 172.474 |
| `test:reconciliation-redteam` 相当（並列度1） |          135 / 0 / 0 |  47.199 |
| `test:notification-outbox` 相当（並列度1）    |          136 / 0 / 0 | 185.598 |
| `test:notification-redteam` 相当（並列度1）   |           82 / 0 / 0 |  13.803 |
| `npm run test:macp`                           |            9 / 0 / 0 |   2.378 |
| `npm run test:notification-macp`              |            8 / 0 / 0 |   6.844 |
| `git diff --check`                            |               exit 0 |   0.014 |

<details>
<summary>ファイル並列度1で実行した正確なコマンド</summary>

```bash
# npm-test-serial
node --experimental-transform-types --loader ./test/ts-loader.mjs --test --test-concurrency=1 test/*.test.ts

# durable
node --experimental-transform-types --loader ./test/ts-loader.mjs --test --test-concurrency=1 test/coordination-durable-*.test.ts test/coordination-checkpoint.test.ts test/coordination-execution-*.test.ts

# durable-execution
node --experimental-transform-types --loader ./test/ts-loader.mjs --test --test-concurrency=1 test/coordination-durable-actions.test.ts test/coordination-durable-evidence.test.ts test/coordination-durable-execution.test.ts test/coordination-execution-*.test.ts test/coordination-durable-migration.test.ts test/coordination-durable-browser.test.ts

# recovery-reader
node --experimental-transform-types --loader ./test/ts-loader.mjs --test --test-concurrency=1 test/coordination-recovery-*.test.ts

# runtime-lease
node --experimental-transform-types --loader ./test/ts-loader.mjs --test --test-concurrency=1 test/coordination-lease-*.test.ts

# model-call-ledger
node --experimental-transform-types --loader ./test/ts-loader.mjs --test --test-concurrency=1 test/coordination-model-call-*.test.ts

# recovery-authorization
node --experimental-transform-types --loader ./test/ts-loader.mjs --test --test-concurrency=1 test/coordination-recovery-authorization*.test.ts

# recovery-execution
node --experimental-transform-types --loader ./test/ts-loader.mjs --test --test-concurrency=1 test/coordination-recovery-execution*.test.ts

# recovery-dispatch
node --experimental-transform-types --loader ./test/ts-loader.mjs --test --test-concurrency=1 test/coordination-recovery-dispatch*.test.ts test/coordination-reconciliation-redteam-pr36-controlled.test.ts

# recovery-continuation
node --experimental-transform-types --loader ./test/ts-loader.mjs --test --test-concurrency=1 test/coordination-recovery-continuation*.test.ts

# planning-only
node --experimental-transform-types --loader ./test/ts-loader.mjs --test --test-concurrency=1 test/coordination-planning-only*.test.ts

# hold-lifecycle
node --experimental-transform-types --loader ./test/ts-loader.mjs --test --test-concurrency=1 test/coordination-hold-lifecycle*.test.ts

# reconciliation
node --experimental-transform-types --loader ./test/ts-loader.mjs --test --test-concurrency=1 test/coordination-reconciliation*.test.ts

# reconciliation-redteam
node --experimental-transform-types --loader ./test/ts-loader.mjs --test --test-concurrency=1 test/coordination-reconciliation-redteam*.test.ts

# notification-outbox
node --experimental-transform-types --loader ./test/ts-loader.mjs --test --test-concurrency=1 test/coordination-notification-outbox.test.ts test/coordination-notification-source*.test.ts test/coordination-notification-migration.test.ts test/coordination-notification-process.test.ts test/coordination-notification-crash.test.ts test/coordination-notification-db.test.ts test/coordination-notification-worker.test.ts test/coordination-notification-db-review.test.ts test/coordination-notification-reader.test.ts test/coordination-notification-ordering.test.ts test/coordination-notification-audit-pr37.test.ts

# notification-redteam
node --experimental-transform-types --loader ./test/ts-loader.mjs --test --test-concurrency=1 test/coordination-notification-redteam*.test.ts

```

</details>

成功表とは別に、以下の初回・再試行の失敗を記録した。全体回帰の最終結果は、同じコード・同じ全テストファイルをファイル並列度1で再実行したものであり、通常の `npm test` が成功したという意味ではない。

- `npm test`: 2111成功 / 1失敗 / 0 Skip。
- `npm test`: 2111成功 / 1失敗 / 0 Skip。
- `npm run test:durable`: 162成功 / 1失敗 / 0 Skip。
- `npm run test:durable`: 161成功 / 2失敗 / 0 Skip。

G1-08の80ms期限試験では、期待した1呼出しに対してProvider呼出しが0だった（試験全体118.506ms）。開始前の期限到達と整合するが、初回ログはCall数Assertionで停止しているためerrorCodeまでは取得していない。公開成功・二重送信が起きた失敗ではない。Assertionや80ms期限を変えず、単独試験1/1成功の後、同じnpm testを再実行した。その2回目はG1-08が成功したが、未変更のCOORD recovery-dispatch Crash after-Bでchild準備待ちが失敗した（19.112秒）。そこで既存npm testの設定は変えず、同じ全ファイルを --test-concurrency=1 で実行した。試験内の二process競合・Assertion・timeoutは維持している。

専用 `test:durable` の初回は162成功/1失敗。未変更の `coordination-execution-crash.test.ts` のresult-beforeで `Child timeout`（28.506秒）となった。同じコマンドの再実行は161成功/2失敗で、durable-recoveryの同時再送試験（16.816秒）とCrash registration-before（17.088秒）が子プロセスtimeoutとなった。失敗ログを保全し、以降の既存COORD 15 Suiteはnpmスクリプトと同じファイル集合をファイル並列度1で検査した。表の直下にある展開済みNodeコマンドが実際の条件である。試験内の複数process競合とAssertion/timeoutは維持し、MACP 2コマンドは元のnpmスクリプトで実行した。

全コマンドは上記最終コードSHAで順次実行した。重複Suiteを独立件数として合算しない。
既存COORD/旧Clientテスト、既存Assertion、Skip、timeout、loaderは変更していない。
新しい監査試験は通常 `npm test`、`test:app-data`、`test:app-data-redteam` と専用 `test:app-data-audit` から到達する。

中間試行では、追加negative試験のRequest IDにmodel名のピリオドを使って既存入力検査に拒否された。
fixtureを許可済みID形式に直し、拒否検査自体は変更していない。
UIのモデル依存表示を追加する前に開始した全体検証は途中停止し、成功に計上せず最終コードSHAで最初から実行し直した。

実Chromiumは18操作群成功、合成Provider 3呼出し、外部要求0。ログイン・添付・Avatar/Context・訂正/履歴・再生成・移行・再接続・失効を含む。

| 実Browser HTTP | 回数 |
| -------------- | ---: |
| GET 200        |   94 |
| GET 401        |    6 |
| GET 404        |    1 |
| PATCH 200      |    3 |
| PATCH 409      |    1 |
| POST 200       |    5 |
| POST 201       |    5 |
| POST 202       |    4 |
| POST 409       |    1 |

10万Message（各本文60 bytes）、最新50件の認証付きHTTPを逐次50回、4並列100回、保存50回で測定。
機器はINTEL(R) XEON(R) PLATINUM 8573C、論理CPU 5、メモリ18,882,662,400 bytes。

| 測定                                     |                            結果 |
| ---------------------------------------- | ------------------------------: |
| 新SQLite接続・HTTP単発                   |                       29.693 ms |
| Warm HTTP p50 / p95                      |              14.175 / 28.510 ms |
| 4並列HTTP p50 / p95                      |              50.516 / 70.427 ms |
| Repository保存 p50 / p95                 |                1.637 / 3.261 ms |
| RSS / DB本体                             | 201,875,456 / 159,891,456 bytes |
| 2,000件Import                            |                    13866.822 ms |
| Lease更新 / 失敗 / 最大間隔              |            117 / 0 / 237.695 ms |
| Event-loop delay p95 / 最大              |             36.143 / 136.970 ms |
| 共存通知Attempt / Receipt / Import中完了 |                    20 / 20 / 20 |
| 通知失敗 / Pending / HTTP                |                       0 / 0 / 0 |
| 通知enqueue→ACK p95 / 最大               |            126.988 / 128.431 ms |

新接続測定でもOS page cacheは消去していない。保存はRepository時間でHTTPを含まない。
COORD共存通知は既存Workerの永続claim/intent/receiptを動かし、process内の合成ACKを返す。実HTTP通知ではない。
この条件での暫定目標を満たした結果であり、実運用機器や大きい添付・長期履歴のSLAを保証しない。

機器欄のCPU数・メモリはosが返すHost値である。検証中に読んだcontainerのcgroup設定は `cpu.max=400000 100000`（4 CPU相当）、`memory.max=17179869184`（16 GiB）。これらの値だけで各timeoutの原因を確定したとは扱わない。

MACPは `KM9250/Multi-Agent-Command-Protocol` の
`e88937d0c8132ae7d18098a24d01ee28bffda655` に固定し、Python 3.12.14の専用venv、
一時SQLite・認証付きLoopback HTTP・実SSEで実行した。稼働Receiverへは送っていない。
Crashは既存の実SIGKILL・二process単回送信・実SQLite BUSY/FULL境界を維持する。
FULLはSQLite `max_page_count` による試験で、実媒体ENOSPC/停電試験ではない。

## 公開検査と未検証範囲

修正実装2コミット・延べ14ファイル版を検査し、実DB/WAL/SHM・Export・添付・Rawログの混入、および一般的なGoogle/GitHub/OpenAIキー形式・秘密鍵は検出なし。追加文書も公開前に再検査した。偽キーcanaryを与えた実buildのdist 3ファイルにcanary・GEMINI_API_KEY・Provider SDK/endpointが含まれず、source mapもない。検査は万能な秘密検出の保証ではない。

実Provider 0呼出し、実データ移行0。実課金額・実Usage・選択Modelの疎通結果は未取得。
対象運用機器・実媒体・実データでのRestore、Windows Junction/Reparse Point、実TLS/Proxy、RPO/RTOは未検証。
Linux合成環境のBackup/Restore成功を実運用の成功に置き換えない。
既存の[運用手順](map-data-1-runbook.md)と[移行・復元手順](map-data-1-migration.md)を更新した。
DATA-1以外のMEM/Vault公開・検索・動的Workerは実装対象外のままである。
既存のPR #38へ追加し、Draftを維持、自動マージとmainへの直接Pushは行わない。
