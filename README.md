# SQLMegane（SQLめがね）

[English README](README.en.md) / [English UI](https://selene-nyx-ai.github.io/sqlmegane/en/)

**実行前のSQLを、日本語で読み返す道具です。**

本番データベースに手作業でUPDATE/DELETEなどのSQLを実行する前に、貼り付けるだけで
「このSQLが何をするか」を日本語で書き下し、あわせて危険な箇所をその場でチェックする、
需要検証用の試作品（プロトタイプ）です。

競合の Bytebase のような組織導入型ツール（サーバー構築・アカウント管理が必要）とは異なり、
**インストール不要・組織導入不要・SQLはブラウザから一切外部に送信されない** ことを狙いにしています。
SQLMegane から入力 SQL が AI サービスを含む外部サービスへ渡り、そこで保存されたり AI の学習に使われたりすることはありません。
判定には LLM を使わず、構文解析と規則を用います。同じバージョン・同じ方言設定では、同じ SQL に同じ解析結果を返します
（MySQL / PostgreSQL / SQL Server は AST、Oracle / 汎用は正規表現によるヒューリスティック）。解析や規則の制約により、結果が誤ったり不完全になったりする場合があります。

v2 から、MySQL / PostgreSQL / SQL Server については本物のSQLパーサ
（[node-sql-parser](https://github.com/taozhi8833998/node-sql-parser) / Apache-2.0 / 同梱）で
構文解析（AST）を行い、日本語要約とAST基盤の検出を提供します。
パーサはページに同梱しており、**実行時にCDN等の外部から読み込むことはありません**。

## 起動方法

ビルドや依存パッケージのインストールは不要です。

1. `index.html` をブラウザで直接開く（ダブルクリックでも可）
2. SQLを貼り付けて「解析する」を押す、または方言を選ぶだけで自動的に解析されます

ローカルサーバーを立てる必要はありません。オフラインでも動作します。

### CLI（CI や実行前フック向け）

ブラウザ版と同じ解析コアを Node.js（18 以上）から使えます。追加のインストールは不要です。

```
node cli/sqlmegane.mjs 実行予定.sql            # ファイルを解析
cat 実行予定.sql | node cli/sqlmegane.mjs -     # 標準入力から
node cli/sqlmegane.mjs --dialect mysql --json 実行予定.sql
```

- `--dialect auto|generic|mysql|postgres|mssql|oracle`（既定 `auto` = 自動判定）
- `--json` で解析結果を JSON 出力（AST は含みません）
- `--fail-on danger|warning|info|never`（既定 `danger`）: この重要度以上の指摘があると **終了コード 2** で終わります。CI やフック側でこの終了コードを判定すれば、検出した danger がある場合に後続処理を止められます（CLI 自体は SQL を実行も阻止もしません）
- `--include-sql`: 出力に SQL の全文（`raw` / PL/SQL 内の `sql`）を含めます。既定では含めません。ただし要約・指摘・検算SELECT には、テーブル名・列名・WHERE 句の条件やリテラル（メールアドレスや ID など）がそのまま現れます。**既定でも出力には SQL の内容の一部が含まれる**ので、CI ログの閲覧範囲に注意してください
- `--max-bytes N`（既定 5 MiB）: 入力の上限。超えると終了コード 1
- PL/SQL（Oracle）のブロック内にある DML も、要約・指摘・検算SELECT を出し、終了コードの判定に含めます
- 検出できるのは実装済みのルール（下の「検出ルール一覧」）に限られます。未検出の危険や warning 以下の指摘は既定では通過するので、**SQL の安全性を保証するものではありません**

終了コードを実際に評価する例（危険な指摘があれば実行コマンドに進まない）:

```sh
node cli/sqlmegane.mjs --dialect mysql 実行予定.sql && mysql -h 本番ホスト mydb < 実行予定.sql
```

出力例（`DELETE FROM t_log;` を渡した場合）:

```
--- #1 DELETE ---
DELETE: `t_log` の全行を削除します
⚠ 条件なし＝全行が対象です。WHERE句が無いため、テーブルの全行が削除されます。
【危険】WHERE句のないDELETE: WHERE句が見つかりません。このままではテーブルの全行が削除されます。TRUNCATEとの違いも含め、本当に全件削除でよいか再確認してください。
検算SELECT: SELECT COUNT(*) FROM t_log;
```

### 実行前チェックリスト

ツールを使わない場合も含めた手作業運用向けのチェックリストを [CHECKLIST.md](CHECKLIST.md) に置いています。チームの手順書にコピーして使ってください。

## 方言ごとの解析レベル

## 更新文を作る（SELECT → UPDATE/DELETE）

単一の基底表を読む SELECT から、同じ対象条件を持つ UPDATE、DELETE、候補行数 SELECT を作れます。WHERE 句は入力からそのまま切り出し、UPDATE の SET は `<column> = <value>` のまま提示します。生成 SQL は必ず読み返してから使ってください。候補行数は実更新行数ではなく、同時更新やトランザクション分離レベルによって変わります。

v1 は外側の FROM が単一テーブルの SELECT だけが対象です。JOIN、カンマ結合、CTE、派生表、集合演算、集約、行数制限、ロック句など、意味を保てると証明できない形では SQL を生成せず理由を表示します。構文確認と、WHERE・対象表・他テーブル参照に関する不変条件を別々に表示します。

### キー IN 形（対象表とキー列を選ぶ）

第 2 弾では、CTE・JOIN・集計を含む分析 SELECT を書き換えず、最終 SELECT が出力するキー列を使って対象表を絞れます。画面の「対象表とキーを選んで変換する」で基底表（または自由入力した表）とキーを選びます。最終 SELECT にキーがなければ、先に `product_id` などを出力列へ追加してください。

```sql
DELETE FROM products
WHERE product_id IN (
  SELECT product_id
  FROM (WITH ... SELECT product_id, ... FROM ranked WHERE ...) sqlmegane_src
);
```

この形で同値とする範囲は「元の SELECT の結果にキー値が現れる、対象表の行」です。JOIN 条件や WHERE 条件を移動せず、元の SELECT 全体を派生表へ 1 回だけ入れます。最終 SELECT の `ORDER BY` は `IN` の集合には影響せず、派生表内では不要または使えないため除き、生成 SQL のコメントに記録します。

最終 SELECT に行数制限（`LIMIT` / `OFFSET` / `FETCH` / `TOP`）がある場合は変換しません。上位 N 件は `ORDER BY` が一意に並べていないと DML 実行時の再評価で別の行を選ぶことがあり、ツールは並びの一意性を確認できないためです。同じ行を確実に扱うには、確認した SELECT のキーを一時表などに保存し、その固定した集合に対して DML を流してください（CTE の中の行数制限は最終 SELECT の対象集合を決めないので拒否しません）。ロック句（`FOR UPDATE` / `FOR SHARE`）を含む SELECT も、派生表にそのまま移せない製品があり、外すとロックの意味が変わるため変換しません。

次の点を生成結果にも黄色の注記で表示します。

- キーには対象表の主キーか NOT NULL の一意キーを選んでください（複合キーは全列）。一意でない列だと、SELECT に出なかった同じキー値の行も更新・削除されます。ツールは一意性を確認できません。
- キーが `NULL` の行は `IN` で一致せず、更新・削除されません。
- サブクエリは DML 実行時に再評価されるため、先に確認した SELECT の結果から変わることがあります。
- 自由入力した対象表が元 SELECT にない場合は、表とキーの対応を確認してください。

最終 SELECT の出力に同じ名前のキーが複数あるとき（自己結合や同名列の結合）は、どの表の列で絞るかが決まらないため変換せず、別名で 1 回だけ出力するよう求めます。

方言別の違いは次のとおりです。

- **MySQL**: 更新する表を副問合せで読む DML は `ERROR 1093` になります。派生表が実体化される場合は例外なので、`SELECT /*+ NO_MERGE(sqlmegane_src) */ ...` のヒントを付けて実体化を指示します。対象の MySQL（8.0 系）で通ることは実行前に確認してください。
- **SQL Server**: 派生表の中に `WITH` を書けないため、`WITH` 句を文頭へ移し、最終 SELECT だけを派生表に入れます（`WITH ... DELETE FROM t WHERE k IN (SELECT k FROM (最終 SELECT) sqlmegane_src)`）。同梱パーサは `WITH ... DELETE` を読めないため、構文確認は WITH 付きの元 SELECT と DML 本体を分けて行います。
- **PostgreSQL**: 派生表の中に `WITH` ごと入れます。
- **Oracle / 汎用**: DML の先頭に `WITH` を置けないため派生表形を使います。AST パーサがないため簡易構文確認です。接続先の製品・バージョンで派生表内の `WITH` が使えるかも実行前に確認してください。

MySQL / PostgreSQL / SQL Server では、同梱パーサで生成文を再解析します。元 SELECT 自体に別方言の構文があれば構文確認は失敗します（上の PostgreSQL 例をそのまま MySQL / SQL Server として確認した場合の `INTERVAL '90 days'` など）。

注意: 生成した SQL は必ず読み返してから使ってください。候補行数 SELECT は結合後の候補件数の目安で、実際の影響行数ではありません。別名付きの SELECT から作った DELETE は、MySQL では 8.0.16 以降の構文（`DELETE FROM t AS a`）になります。それより前の MySQL では別名を外してください。CLI の `convert` は、生成物の自己検証で danger / warning が出た場合に標準エラーへ表示します（WHERE の無い SELECT から作った DML など）。

## 退避してから変更する（退避 → 変更 → 補償）

「更新文を作る」の下にある、既定で閉じた「退避してから変更する」で、退避表名・退避列・キー列と UPDATE の列／値を指定します。列は SELECT の直接の出力列から明示選択します。`SELECT *` は列を明示した SELECT に変更してください。未入力や非対応形ではコピーを無効化します。接続なしの準備ツールであり、画面から DB を操作しません。

| 方言 | 区分 | 退避時の保護 |
|---|---|---|
| PostgreSQL | verified：PostgreSQL 18.3 で実 DB 試験 13 項目に合格（2026-09-20、`npm run test:pg`） | INSERT SELECT と同じ文の `FOR UPDATE OF t`。READ COMMITTED 可 |
| MySQL 8.0 | reference：公式ドキュメントに基づく参考型紙・実機未検証 | 両表 InnoDB 等、REPEATABLE READ 必須。`FOR UPDATE`、検索・索引・計画に応じ gap / next-key ロック（一意キー完全一致はレコードのみの場合あり） |
| SQL Server | reference：公式ドキュメントに基づく参考型紙・実機未検証 | `UPDLOCK, HOLDLOCK`。範囲保護、ロック拡大の可能性 |
| Oracle 19c 以降 | reference：公式ドキュメントに基づく参考型紙・実機未検証 | `LOCK TABLE ... IN EXCLUSIVE MODE`。表全体の書き込みを待機させる（通常 SELECT は可、FOR UPDATE は待機） |

退避は **1 作業 1 新規退避表、開始時に空、追記・再利用禁止**。既定名は `<表名>_bk_<UTC の yyyymmddhhmmss>_<4文字>`。スキーマと引用を保ち、名前の表名部分だけを長さ制限に合わせ短縮します。一意性の保証はありません。同名表があれば空でも使わず作業 ID を変更してください。PostgreSQL は 63 バイト、MySQL は 64 文字、SQL Server は 128 文字、Oracle は `COMPATIBLE >= 12.2` で 128 バイト（それ未満は 30 バイト）です。API の `oracleCompatible: 'legacy'`、CLI の `--oracle-compatible legacy` で 30 バイトを指定できます。退避列・キー列は元の SELECT に直接書かれた出力列に限ります（`SELECT *` や式の列は `column-not-in-select` で拒否）。WHERE に副問い合わせを含む SELECT は `subquery-predicate` で拒否します。

空表作成は属性を完全に複製しません。

| 製品／空表コピー | 継承される属性・制限 |
|---|---|
| PostgreSQL CTAS | 制約・索引を継承しない |
| MySQL CTAS | AUTO_INCREMENT を継承しない。NOT NULL・DEFAULT は継承。式は型が変わる場合あり |
| Oracle CTAS | 明示 NOT NULL を条件付き継承。PK・FK・索引・既定値は継承しない |
| SQL Server SELECT INTO | 単純な直接列選択では IDENTITY を継承する（JOIN・UNION・式は例外）。この機能では **明示列定義の CREATE TABLE** を既定にする |

5 段階をそれぞれコピーして対話クライアントで実行し、結果を見て次へ進みます。DDL と A〜D は別の構築経路です。B〜D は同じ接続・同じトランザクションです。

1. **0：準備** — 専用接続、未確定作業なしで新規の空表を作成。列型・精度・照合規則を元表と合わせる。Oracle / MySQL の DDL は暗黙コミット（Oracle は有効な DDL の実行失敗時も実行前コミット）。SQL Server の列定義プレースホルダは人が記入する準備型紙です。
2. **A：事前検査** — 退避表 0 件、元 SELECT と候補件数、接続設定を確認。psql は autocommit ON＋B の明示 BEGIN。他クライアントは B〜D 間に自動 COMMIT しないこと。MySQL は autocommit=1 / REPEATABLE-READ と両表のエンジンを確認し末尾 ROLLBACK。Oracle は AUTOCOMMIT OFF、末尾 ROLLBACK。SQL Server は IMPLICIT_TRANSACTIONS OFF、既存トランザクションを末尾で ROLLBACK。不合格なら B を貼らない。
3. **B：退避と検査** — 開始・ロックとコピー・検査。候補件数＝退避件数＝対象キー存在件数、重複 0 行、NULL 0、対応漏れ 0。SQL Server は開始直後 @@TRANCOUNT=1（2 以上なら中止）。キー一覧を最終確認。A は予備確認で、件数一致は集合一致の証明ではありません。退避集合が最終対象です。末尾に終了文はありません。
4. **C：変更と検査** — 元述語ではなく退避キー全体に固定して変更。DELETE は対象キー 0 件、UPDATE は全キー存在・値の不一致 0。NULL の片側不一致も検査。影響行数は補助証拠（MySQL は変更行数）。末尾に終了文はありません。
5. **D：終了** — 既定は ROLLBACK。全検査合格後の COMMIT は別の折りたたみ・別コピーで、退避と変更が一緒に確定します。SQL Server は終了後 @@TRANCOUNT=0 を確認。退避表・日時・終了操作を記録します。

SQL エラー・タイムアウト・取消し・検査結果不明は全て不合格。同じ接続でトランザクション継続中なら ROLLBACK し、終了を確認して最初からやり直します。**接続喪失・COMMIT 応答不明は「結果不明」として停止し、再実行・補償は禁止**。サーバーで確定済みなら再接続後の ROLLBACK では取り消せません。元接続の終了を確認し、退避表・対象表・作業記録から確定結果を確認してください。psql の `ON_ERROR_ROLLBACK=on` ではエラー後も後続文が動くため、人が必ず停止します。

「補償 SQL 案（完全復元ではない）」は **条件付き型紙** です。①開始・ロック・事前検査 ②補償 DML＋事後検査 ③終了（ROLLBACK と COMMIT は別コピー）に分けます。UPDATE は全退避キーの存在・1 対 1・作業直後値を確認し、不一致行もロックします。DELETE は不在を確認しますが、不在は行ロックでは守れません。キーを有効な DB 制約で強制し、関係する一意制約は即時検査、SQL Server は IGNORE_DUP_KEY=OFF、重複無視は禁止。検査後の競合は制約エラーで補償単位全体を ROLLBACK します。キー以外の一意制約の検査は人が追記します。復旧列が足りるか、省略列への DEFAULT / NULL が許容されるか、書き戻せない列がないか確認します。`--identity none` は列属性条件だけであり、他方言を検証済みにはしません。`backupSet` は属性を確認できないため補償を常に reference で返します。

対象外：補償 SQL の自動生成（前提を人が確認する型紙のみ）、バッチ実行、一括貼り付け、キー IN 形、複数表、式代入、キー変更、生成列キー、部分補償、列の自動照合、列ごとの書き込み可否管理。識別列・生成列・計算列・rowversion を持つ表の補償は参考のみ。関連表の連鎖変更・トリガー・監査列の副作用は戻りません（別途復旧手順がなければ対象外）。元作業を ROLLBACK したら補償しません。退避先の権限と保管期限を確認し、削除は作業記録と組織の保管期限に従ってください。DROP は生成しません。

保守的な追加制限：副問い合わせ付き述語は全方言で拒否します。改行・バックスラッシュを含む代入文字列、Oracle / SQL Server の TRUE/FALSE は方言・設定依存の解釈を避けるため拒否します。申告更新列の不一致、書き戻し列の包含違反、部分補償の指定にも理由コードを返します。

```sh
node cli/sqlmegane.mjs convert --to delete --dialect postgres --backup-table t_log_bk --backup-columns id,created_at --key-columns id --stage all -
node cli/sqlmegane.mjs convert --to update --dialect postgres --backup-columns id,status --key-columns id --set "status='DONE'" --stage change input.sql
node cli/sqlmegane.mjs template --kind compensate-delete --dialect postgres --identity none
```

`--stage` は `prepare|precheck|backup|change|rollback|commit|all`。`all` は閲覧用で、一括貼り付け不可のコメントと段階見出しを付けます。拒否は共通 validator の理由コードを stderr に出し終了コード 2。`--json` は `backupSet` の結果そのものです。未対応の述語や値表現は既存の変換にフォールバックしません。

`node tests/run-tests.mjs` は文字列・契約検査。`npm run test:pg` は `SQLMEGANE_PG` 接続文字列がなければ skip、あれば PostgreSQL 18 に接続して生成 SQL を実行します。2026-09-20 に PostgreSQL 18.3 で 13 項目に合格しています（試験の内訳は tests/pg-smoke.mjs）。psql の ON_ERROR_ROLLBACK、NOWAIT 失敗後の手順、切断・COMMIT 応答不明時の運用は自動化できないため、上の運用注記に従ってください。

## 型紙

UPDATE、DELETE、INSERT SELECT、UPSERT / MERGE、CREATE TABLE の方言別型紙を入力欄とは別のプレビューで確認できます。型紙の入力箇所は `<table>`、`<column>`、`<value>`、`<condition>`、`<key>`、`<source>` です。これらが SQL の文字列・コメント以外に残っている場合は danger として指摘します。

## 安全実行の枠

変換した DML を、トランザクション開始、元 SELECT、候補行数、DML、影響行数確認、更新後の内容確認（元 SELECT の再掲）、既定の ROLLBACK の順にまとめてコピーできます。末尾が ROLLBACK の版は、DML の直後で止めて確認するための並びで、そのまま一括で流すと取り消しで終わります（予行演習）。確定するときは、確認のあと COMMIT を自分で実行するか、確認ダイアログを経てコピーできる末尾 COMMIT の版を使います。1 つの出力に実行可能な COMMIT と ROLLBACK は同時に入りません。MySQL の `ROW_COUNT()` は UPDATE では値が変わった行数なので、一致行数は Rows matched で確認してください。UPDATE で更新する列が条件に含まれる場合（`SET status = ... WHERE status = 'ACTIVE'` など）、更新後の確認 SELECT は 0 行になるため、その旨と「更新前にキーを控えて `WHERE <key> IN (...)` で引き直す」注記に切り替えます。Oracle では SQL\*Plus 対話用とバッチ用も選べます。同じトランザクション内でも同じ行集合は保証されないため、必要に応じて分離レベルやロックを設計してください。

CLI からも利用できます。

```sh
printf "SELECT id FROM m_users WHERE id = 1;" | node cli/sqlmegane.mjs convert --to update --dialect mysql --columns name,status -
printf "SELECT id FROM m_users WHERE id = 1;" | node cli/sqlmegane.mjs convert --to delete --dialect oracle --safe-block sqlplus-interactive -
node cli/sqlmegane.mjs inspect --dialect postgres report.sql
node cli/sqlmegane.mjs convert --to delete --dialect postgres --target products --by-key product_id report.sql
# 対象表のキー名が出力名と違う場合: --target-key id
node cli/sqlmegane.mjs template --kind upsert --dialect postgres --lang ja
```

`convert` の終了コード: `0` = 生成した / `2` = 生成したが、生成物の自己検証に `--fail-on`（既定 `danger`）以上の指摘がある（WHERE の無い SELECT から作った全行 DELETE など。SQL は stdout に出し、指摘は stderr に出す。未記入のプレースホルダは数えない） / `3` = 変換できない（理由は stderr） / `4` = 方言を確定できない（`--dialect auto` のとき） / `1` = 使い方・入力の誤り（存在しない方言名など）。生成した SQL をパイプで後続コマンドへ渡す運用では、解析モードと同じく終了コードで止めてください。

| 方言の選択 | 解析 | 日本語要約 | 使うパーサ |
|---|---|---|---|
| MySQL | 構文解析（AST） | あり | 同梱 node-sql-parser（mysql） |
| PostgreSQL | 構文解析（AST） | あり | 同梱 node-sql-parser（postgresql） |
| SQL Server | 構文解析（AST） | あり | 同梱 node-sql-parser（transactsql） |
| Oracle | **簡易チェック（構文解析なし）** | なし | なし（正規表現ヒューリスティック） |
| 汎用 | **簡易チェック（構文解析なし）** | なし | なし（正規表現ヒューリスティック） |

- Oracle は node-sql-parser が対応していないため、従来どおり正規表現ベースの簡易チェックになります。画面上部に「簡易チェック（構文解析なし）」バッジを表示して明示します
- ただし **PL/SQL については構造を認識し、中に埋め込まれたDMLを抽出して個別にチェックします**（下記「PL/SQL（Oracle）への対応」参照）
- AST対応方言でも、パーサが解析できない構文だった場合は**その文だけ**簡易チェックへフォールバックし、「構文解析に失敗したため簡易チェックで表示しています（位置: 行X）」と表示します
- PostgreSQL / SQL Server のパーサでは通らないが MySQL のパーサでは通る構文（例: `WITH ... DELETE`）については、諦める前に MySQL のパーサで1回だけ再解析し、その旨を文カードに表示します

## PL/SQL（Oracle）への対応

業務システムのOracleスクリプトは、その大半が PL/SQL のパッケージ／プロシージャの形をしています。
ブラウザに同梱できる PL/SQL の完全なパーサは存在しないため、SQLMegane は
**「完全にパースする」のではなく「構造を読み取って中のDMLを取り出す」** というアプローチを取ります。

対象となる形（`/` だけの行で区切られた各チャンクごとに判定します）:

- `CREATE OR REPLACE PACKAGE` / `PACKAGE BODY` / `PROCEDURE` / `FUNCTION` / `TRIGGER` / `TYPE`
- `DECLARE ... BEGIN ... END;`
- `BEGIN ... END;`（無名ブロック）

やること:

1. **構造サマリの表示**: 「PL/SQLユニット: `PACKAGE BODY pkg_order_batch`」「プロシージャ2個 / 抽出したDML: UPDATE 1本・INSERT 1本 / カーソル1個 / COMMITあり・ROLLBACKあり」
2. **埋め込みDMLの抽出**: 文の開始位置に現れる `INSERT` / `UPDATE` / `DELETE` / `MERGE` / `SELECT ... INTO`、および `CURSOR ... IS SELECT` のカーソル定義を1本ずつ切り出します。
   文字列リテラル・コメント（`--`、`/* */`）・Oracleの代替引用符（`q'[...]'`）を正しくスキップし、括弧の深さを見ながら対応する `;` までを1文として扱います
3. **抽出した1本ずつに通常のチェック**: WHERE句の有無、常に真になる条件、`LIKE '%...'`、検算SELECTの生成などを、通常の文と同じようにサブカードで表示します。
   `FORALL i IN 1..n SAVE EXCEPTIONS UPDATE ... WHERE order_id = v_orders(i).order_id;` のように、キーワードとDMLの間に語が挟まる形にも対応しています
4. **バインド変数・PL/SQL変数はそのまま保持**: `p_limit_size`、`v_orders(i).order_id`、`SQL%ROWCOUNT` などは「実行時に値が決まる変数」として扱い、リテラル同様「条件がある」とみなします。
   生成した検算SELECTのWHERE句に変数が残る場合は「実行時の値に置き換えてください」と注記します

**やらないこと（重要）**:

- **制御フロー（ループ・分岐・例外処理）は解析していません。** どのDMLが実際に何回実行されるか、
  例外時に何がロールバックされるかは判断していません。この点は毎回 info として画面に明示します
- 動的SQL（`EXECUTE IMMEDIATE 'DELETE FROM ...'`）の文字列の中身は解析しません。
  DMLを1本も抽出できなかったブロックは、従来どおり「解析できませんでした」の警告を出します

## 機能一覧

- **PL/SQLユニットの構造認識と埋め込みDMLの抽出**（上記「PL/SQL（Oracle）への対応」）
- **日本語要約（v2の主役）**: パースに成功した文について「このSQLは何をするか」を日本語のカードで表示します（警告より上）
  - 操作と対象: 「`m_users`（別名 u）の `deleted_flg` を更新します」
  - WHERE条件の言い換え: 「対象は `dept_cd` が '10' かつ `last_login` が '2024-01-01' より前である行です」。OR/ANDの入れ子は箇条書きのインデントで表現します
  - WHERE句が無い場合は要約内でも「⚠ 条件なし＝全行が対象です」を強調します
  - **JOINの意味論**: 「`orders` に一致する行がある `users` だけが対象です（一致しない行は対象外）」/「`orders` に一致する行が無い `users` も対象に含まれます」のように、**残る側と落ちる側を必ず両方**言語化します（「取得したい/外したい」の取り違えに気づけるようにするため）
  - UPDATE/DELETE + JOIN では「実際に書き換わるのはどのテーブルか」を明示します
- **スクリプトモード**: 5文以上をまとめて貼ると、結果の先頭に全体サマリカード（全N文の内訳 / 触るテーブル一覧 / 警告のある文への文内リンク）を表示します
- 複数SQL文の一括解析（セミコロン区切り。文字列リテラル・コメント内のセミコロンでは誤分割しません）
- 方言選択（汎用 / Oracle / SQL Server / MySQL / PostgreSQL）に応じた警告の出し分け
- 文ごとのカード表示（危険度バッジ付き）
- **検算SELECTの自動生成**: UPDATE/DELETE文から `SELECT COUNT(*) FROM テーブル WHERE 同条件;` を自動生成し、コピーボタンで即座に控えられます（テーブルエイリアスが使われている場合は `FROM テーブル alias` の形でエイリアスも引き継ぎ、そのまま実行できるようにします）
- 危険が検出されなかった場合も「検出できない危険もあります」という文言で過信を防止
- プライバシー表記の常時表示（実際に外部通信・アナリティクスは一切実装していません）
- チーム版（構想）への興味・意見・誤検知/検出漏れの報告はGitHub Issueで受け付け（リンクボタンから直接遷移）

## 検出ルール一覧

| 重大度 | ルール | 内容 |
|---|---|---|
| danger | `no-where-update` | WHERE句のないUPDATE（`UPDATE ... JOIN ...` の形の場合は「JOINで一致した行がすべて更新されます」という文言に変わります） |
| danger | `no-where-delete` | WHERE句のないDELETE（`WITH ... AS (...)` のCTEプレフィックスがあっても本体のDELETEを判定します） |
| danger | `always-true-where` | 常に真になるWHERE句（`1=1`、`'a'='a'` など。`1=1 AND 実条件` のように他の条件と組み合わさっている場合は対象外。ただし `id=42 OR 1=1` のように**トップレベルのOR**でつながっている場合は検出します。括弧の中の `OR 1=1`（例: `a=1 AND (b=2 OR 1=1)`）は全行に波及しないため対象外） |
| danger | `left-join-where-cancellation` | **（AST時のみ）** LEFT/RIGHT/FULL JOIN した外側テーブルの列を、WHERE句のトップレベルANDで等値絞り込みしている（NULL行が必ず除外されるため実質INNER JOIN化し、外部結合の意味が失われる）。`IS NOT NULL` はまさにこの打ち消しそのものなので検出対象、`IS NULL`（アンチジョイン等の意図的な書き方）は対象外。ORの下にある条件は対象外。括弧で括られたANDグループ（例: `(a AND b) AND c`）の中の条件も、括弧の外にORが無ければ検出対象に含めます |
| danger | `truncate-table` | TRUNCATE TABLE |
| danger | `drop-table` | DROP TABLE |
| danger | `drop-database` | DROP DATABASE |
| warning | `or-no-parens` | WHERE句がOR結合かつ括弧なし（`a=1 OR b=2 AND c=3` のような意図しない範囲拡大。`BETWEEN x AND y` のANDは演算子優先順位の対象外として除外） |
| warning / danger | `not-in-null-risk` | **（AST時のみ）** `NOT IN (SELECT ...)` を使っている場合はwarning（サブクエリ結果にNULLが1件でもあると全行が除外される。`NOT EXISTS` の使用を促します）。`NOT IN (1, NULL, 3)` のように値リストに直接NULLが含まれる場合はdanger（三値論理により結果が常に空になることが実行前から確定しているため）。NULLを含まない値リスト `NOT IN (1,2,3)` は対象外 |
| warning | `like-leading-wildcard` | `LIKE '%...'` のような前方一致でないLIKE（対象が広がりやすい） |
| warning | `self-subquery-no-condition` | `IN (SELECT ... FROM 同じテーブル)` で、サブクエリ側に絞り込み条件（WHERE）がない（相関ミスの定番） |
| warning | `implicit-conversion` | `id = '123'` のような引用符付き数値リテラルの比較（暗黙型変換によりインデックスが効かない/意図しない一致の懸念） |
| info (MySQL) | `mysql-no-limit` | UPDATE/DELETEにLIMITがない（主キー1行更新のような単純な等価WHEREのみの場合、およびLIMITに対応しないマルチテーブルUPDATE・マルチテーブルDELETE（`DELETE a FROM a JOIN b ...` 等）の場合は出しません） |
| warning (SQL Server, 複数文全体) | `mssql-multi-no-begintran` | 複数のUPDATE/DELETEがBEGIN TRANで囲まれていない（BEGIN TRANが破壊的文より後ろにしかない場合は「囲まれていない」扱いにします） |
| warning (Oracle) | `oracle-ddl-autocommit` | DML実行後にDDL（CREATE/ALTER/DROP/TRUNCATE）が混在（Oracleでは暗黙コミットが発生） |
| info (PostgreSQL) | `postgres-returning-tip` | UPDATE/DELETEにRETURNING句がない（付けると変更行を確認できる、というヒント） |
| info | `update-delete-join-basis` | **（AST時のみ）** UPDATE/DELETE + JOIN のとき、実際に書き換わる/削除されるのがどのテーブルかを明示 |
| info | `no-transaction` | 破壊的操作がBEGIN〜COMMITのようなトランザクションに包まれていない |
| info (貼り付け全体) | `multiple-destructive` | 1回の貼り付けに複数の破壊的操作が含まれている |

各警告には「なぜ危険か」「どうすればよいか」を短く添えています。

構文解析に成功した文では、`no-where-update` / `always-true-where` / `or-no-parens` /
`like-leading-wildcard` / `implicit-conversion` / `self-subquery-no-condition` /
`mysql-no-limit` の判定を**AST基盤の同等判定に置き換えています**（コードと重大度は互換）。
括弧やサブクエリの境界を正しく見られるぶん、誤検知・見逃しが減ります。
例えば `WHERE (a = 1) OR b = 2 AND c = 3` は、正規表現版では「括弧があるので判定を放棄」して
いましたが、AST版では `or-no-parens` として検出できます。

検算SELECTも、構文解析に成功した場合はASTで判断した「行の供給元（FROM句相当）」から生成します。
これにより `UPDATE u SET ... FROM users u LEFT JOIN depts d ON ... WHERE ...`（T-SQL）や
`UPDATE t1 LEFT JOIN t2 ON ... SET ...`（MySQL）でも、JOINを落とさない実行可能な検算SELECTになります。
ただし検算SELECTがJOINを含む場合、`COUNT(*)` が返すのは**結合後の行数**であり、
1対多のJOINでは実際にUPDATE/DELETEされる行数（例: `UPDATE users u JOIN orders o ON ...` なら
`users` 側の行数）より大きくなることがあります。この場合は生成SQLに注記コメントを付け、
ラベルとカード内の注記でも「結合行数である」ことを明示します。

選択した方言のパーサでは構文エラーになったSQLでも、`WITH ... DELETE` のような既知のパーサの
穴を吸収するため、MySQLパーサでもう一度だけ解析を試みることがあります。この再挑戦が成功した
場合は「選択した方言（例: PostgreSQL）では構文エラーである」事実を警告として必ず表示します
（位置つき）。このケースでは選択方言固有のTips（例: PostgreSQLのRETURNING案内）は出しません。
選択方言では実行できない可能性があるSQLだと分かった上で参考にしてください。

## 検出しなかった/見送ったルール

以下は仕様検討時に候補に挙がりましたが、正規表現ベースでは誤検知が多くなりやすいため、
このプロトタイプでは実装を見送りました（誤検知を出すより検出項目を絞る方針のため）。

- **WHERE句のないSELECT**: 事故につながりにくく、危険度が低いため対象外
- **AND/ORの一般的な優先順位ミス全般**: 簡易チェック（正規表現）経路では、`OR`と`AND`が混在し、かつ**括弧が一つもない**場合のみに限定して検出しています。一部でも括弧が使われている式は、正規表現では「意図した括弧か抜けている括弧か」を安全に判別できないためです。**構文解析に成功した場合はこの制限がなくなり**、括弧で優先順位が明示されていない混在を正確に検出します
- **相関サブクエリの完全な検証**: 別名（エイリアス）を介した本当の相関関係の有無まではチェックしていません。「同じテーブル名を条件なしで参照している」という最も典型的なパターンのみを検出しています
- **常に偽になるWHERE句（`1=2`など）**: 「更新0件」に気づきにくいという別種の事故ですが、危険側（全件に影響する事故）を優先し、今回は対象外としました

## 既知の限界

- **構文解析に成功しても「意味が正しいか」までは分かりません。** 本ツールが検査できるのは構造から機械的に読み取れる範囲だけです。**「危険が検出されない = 安全」ではありません**
- **Oracle・汎用方言、および構文解析に失敗した文では、従来どおり正規表現と簡易な状態機械によるヒューリスティックです。** 複雑な入れ子のサブクエリ、ベンダー固有の複雑な構文、動的SQLの文字列組み立てなどは正しく解析できない場合があります
- Oracle固有の構文（`(+)` 外部結合記法、`CONNECT BY`、`MERGE` など）は同梱パーサが非対応です
- 同梱パーサ（node-sql-parser v5.4.0）は **AND / OR の優先順位を適用せず、出現順の左結合でASTを組みます**（`a=1 OR b=2 AND c=3` を `AND(OR(a,b), c)` と解釈する）。そのままでは日本語要約が誤った読み方を提示してしまうため、SQLMegane 側（`js/sql-ast.js` の `logicalTree`）で **SQLの優先順位（AND > OR）に組み直してから** 要約・検出に使っています
- CTE（`WITH`句）は先頭の `WITH ... AS (...)` プレフィックスを読み飛ばして本体のUPDATE/DELETE/SELECT等を判定しますが、CTE定義部分の構文が崩れている場合や、ネストしたCTE・複雑な構文には対応できない場合があります
- 文字列リテラル・コメント（`--`、`/* */`）およびバッククォート/ダブルクォート/角カッコの引用符付き識別子を認識したうえで解析していますが、**PostgreSQLのドル引用符（`$$...$$` / `$tag$...$tag$`）には対応していません**。ドル引用符を含む文は正しく解析できない場合があります
- 文字列リテラル内のバックスラッシュエスケープ（例: `'it\'s bad'`）はMySQL方言選択時のみ認識します。他の方言では標準SQLに合わせてバックスラッシュを特別扱いしません
- テーブル名の抽出は `schema.table`、バッククォート/ダブルクォート/角カッコ識別子、および単純なテーブルエイリアス（`AS alias` / `alias`）に対応していますが、複雑なスキーマ修飾や動的な識別子、`DELETE t1 FROM t1 JOIN t2 ...` のような複雑なマルチテーブル構文には対応できない場合があります
- トランザクションの検出は文字列ベースの近似です。プロシージャ内のネストしたトランザクション制御などは正しく追跡できません
- **PL/SQLは「完全なパース」ではありません。** 構造を読み取ってDMLを取り出すだけで、制御フロー（ループ・分岐・例外処理）は解析していません。抽出したDMLが実際に何回実行されるか、例外時に何がロールバックされるかは判断していません
- PL/SQLユニットの認識には `/` だけの行（SQL*Plus / SQLcl のブロック終端）を必須にしています。`/` で終端されていないPL/SQLブロックは、従来どおりセミコロンで分割されます（T-SQLの `BEGIN TRAN 〜 COMMIT` を誤ってPL/SQLブロック扱いにしないための、意図的に保守的な判定です）
- T-SQL の `CREATE PROCEDURE ... AS BEGIN ... END` は今回のPL/SQL抽出の対象外です
- **「危険が検出されない」ことは「安全である」ことを意味しません。** 本ツールは事故を減らす補助ツールであり、最終判断・実行は必ず人間が行ってください

## file:// 直開き対応（ESMを廃止した経緯）

「このページを開くだけで使える」ことは本ツールの製品要件そのものであり、実際のユーザー環境
（Windowsのブラウザで `index.html` をダブルクリックして `file://` プロトコルで直接開く）で
確実に動くことを最優先している。

過去のバージョンでは `js/analyzer.js` / `js/app.js` をESM（`export` / `import`、
`<script type="module">`）で構成していたが、ブラウザは `file://` プロトコル配下での
モジュール間 `import` をCORS制限としてブロックする。この場合サーバー経由（`http://localhost`）
では問題なく動く一方、ユーザーが実際に行う「ダウンロードしてダブルクリックで開く」という
使い方では **JavaScriptが一切実行されず、SQLを入力して「解析する」を押しても何も起きない**
という致命的な不具合になっていた（見た目はCSSが効いているため正常に見えてしまい、気づきにくい）。

このため、ESMを廃止し次の構成に変更した:

- `js/analyzer.js`: `export` 文を持たない。全体を即時関数（IIFE）で包み、末尾で
  `globalThis.SQLMeganeAnalyzer = { analyzeSQL, splitStatements, SEVERITY_ORDER, _internal }`
  としてグローバルに公開する（IIFEで包んでいるのは、包まずにトップレベル関数宣言のまま
  公開すると `window.analyzeSQL` のような暗黙のグローバルが生まれ、`app.js` 側の変数宣言と
  衝突して `SyntaxError` になるため）
- `js/app.js`: `import` せず、`globalThis.SQLMeganeAnalyzer` から必要な関数を取得する
- `index.html`: `<script type="module">` をやめ、`<script src="js/analyzer.js">` →
  `<script src="js/app.js">` の順に通常のスクリプトとして読み込む（この順序が
  `SQLMeganeAnalyzer` の定義完了を保証するために重要）
- `tests/run-tests.mjs`: `js/analyzer.js` に `export` 文が無くなったため、
  `import '../js/analyzer.js'` で副作用のみインポート（実行）し、
  `globalThis.SQLMeganeAnalyzer` から `analyzeSQL` 等を取り出す形に変更した。
  テスト内容・件数（85件）は変更していない

**CSPについて**: `index.html` の `Content-Security-Policy` メタタグ（`script-src 'self'` など）は
このESM廃止にあたって変更していない。`file://` で直接開いた状態でheadless Chromeを使って
実機検証したところ、`script-src 'self'` は同一ディレクトリ配下の通常の `<script src="...">` を
問題なくロードでき、CSP違反やCORSエラーは発生しなかった。したがって `connect-src 'none'` /
`form-action 'none'` を含む既存の保護方針はそのまま維持している。

## ディレクトリ構成

```
sqlmegane/
├── index.html            日本語UI本体（i18n → vendor → sql-ast → summarizer → ast-rules → plsql-extract → analyzer → dialect-detect → app の順に読み込む）
├── en/index.html         英語UI（同じスクリプトを同じ順序で読み込む）
├── css/style.css         スタイル（ダーク基調）
├── js/vendor/            同梱サードパーティ（実行時の外部読み込みは一切なし）
│   ├── node-sql-parser-mysql.js        node-sql-parser 5.4.0 UMD（MySQL方言）
│   ├── node-sql-parser-postgresql.js   同（PostgreSQL方言）
│   ├── node-sql-parser-transactsql.js  同（T-SQL方言）
│   └── LICENSE-node-sql-parser         Apache-2.0 ライセンス全文
├── js/sql-ast.js         同梱パーサのラッパーとAST共通ヘルパー（方言マッピング、フォールバック、
│                          AND/OR優先順位の正規化）
├── js/i18n.js            日本語・英語のメッセージ辞書とロケール選択（globalThis.SQLMeganeI18n）
- `tools/build-en.mjs`: `en/index.html` を `index.html` と `js/i18n.js` の英語メッセージから生成する（英語ページを直接編集しない。`node tools/build-en.mjs`）
├── js/summarizer.js      日本語要約の生成（v2の主役。表示用データを返すだけでDOMは触らない）
├── js/ast-rules.js       AST基盤の検出ルール（既存ルールのAST版 + 新ルール3種）
├── js/plsql-extract.js   PL/SQLの構造認識と埋め込みDMLの抽出（Oracle対応 Phase 1）。
│                          文字列・コメント・q'記法をスキップしながらトークン走査する。
│                          制御フローは解析しない（できないため、しないことを明示する）
├── js/analyzer.js        解析の司令塔＋正規表現フォールバック（IIFE + globalThis.SQLMeganeAnalyzer で公開。
│                          ESMのexportは使わず、file://直開きでも動く通常のスクリプト）
├── js/app.js             UI結線（DOM操作のみ、解析ロジックは持たない）
├── tools/build-vendor.mjs js/vendor/ を node_modules から再生成するスクリプト（配布物には不要）
├── tests/run-tests.mjs   自動テスト（`node tests/run-tests.mjs` で実行）
├── tests/fixtures/       受け入れ用のPL/SQLサンプル（パッケージ仕様部+本体、抽出境界ケース）
└── package.json          "type": "module" 指定のみ。実行時の依存パッケージなし
```

### 同梱パーサについて

- ライブラリ: [node-sql-parser](https://github.com/taozhi8833998/node-sql-parser) v5.4.0
- ライセンス: **Apache-2.0**（全文を `js/vendor/LICENSE-node-sql-parser` として同梱）
- 上流のUMDビルドはコードを一切改変せず、IIFEで包んで `globalThis.SQLMeganeVendor[方言]` に登録する形にしています。
  UMDが「エクスポートを直接グローバルへ代入する」実装のため、3方言をそのまま `<script>` で読み込むと
  `window.Parser` を互いに上書きしてしまうためです（理由と生成手順は `tools/build-vendor.mjs` のコメント参照）
- 再生成手順: `npm install --no-save node-sql-parser && node tools/build-vendor.mjs`
- サイズ: 3方言合計で約890KB（gzip配信時 約184KB）

## テストの実行

```
node tests/run-tests.mjs
```

CLI（`cli/sqlmegane.mjs`）の終了コードと出力もこのテストに含まれます。

外部依存なし、プレーンな `assert` によるテストです（テストは同梱パーサを `js/vendor/` から読み込みます）。
