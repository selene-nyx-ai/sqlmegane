# SQLMegane（SQLめがね）

**実行前のSQLを、日本語で読み返す道具です。**

本番データベースに手作業でUPDATE/DELETEなどのSQLを実行する前に、貼り付けるだけで
「このSQLが何をするか」を日本語で書き下し、あわせて危険な箇所をその場でチェックする、
需要検証用の試作品（プロトタイプ）です。

競合の Bytebase のような組織導入型ツール（サーバー構築・アカウント管理が必要）とは異なり、
**インストール不要・組織導入不要・SQLはブラウザから一切外部に送信されない** ことを狙いにしています。

v2 から、MySQL / PostgreSQL / SQL Server については本物のSQLパーサ
（[node-sql-parser](https://github.com/taozhi8833998/node-sql-parser) / Apache-2.0 / 同梱）で
構文解析（AST）を行い、日本語要約とAST基盤の検出を提供します。
パーサはページに同梱しており、**実行時にCDN等の外部から読み込むことはありません**。

## 起動方法

ビルドや依存パッケージのインストールは不要です。

1. `index.html` をブラウザで直接開く（ダブルクリックでも可）
2. SQLを貼り付けて「解析する」を押す、または方言を選ぶだけで自動的に解析されます

ローカルサーバーを立てる必要はありません。オフラインでも動作します。

## 方言ごとの解析レベル

| 方言の選択 | 解析 | 日本語要約 | 使うパーサ |
|---|---|---|---|
| MySQL | 構文解析（AST） | あり | 同梱 node-sql-parser（mysql） |
| PostgreSQL | 構文解析（AST） | あり | 同梱 node-sql-parser（postgresql） |
| SQL Server | 構文解析（AST） | あり | 同梱 node-sql-parser（transactsql） |
| Oracle | **簡易チェック（構文解析なし）** | なし | なし（正規表現ヒューリスティック） |
| 汎用 | **簡易チェック（構文解析なし）** | なし | なし（正規表現ヒューリスティック） |

- Oracle は node-sql-parser が対応していないため、従来どおり正規表現ベースの簡易チェックになります。画面上部に「簡易チェック（構文解析なし）」バッジを表示して明示します
- AST対応方言でも、パーサが解析できない構文だった場合は**その文だけ**簡易チェックへフォールバックし、「構文解析に失敗したため簡易チェックで表示しています（位置: 行X）」と表示します
- PostgreSQL / SQL Server のパーサでは通らないが MySQL のパーサでは通る構文（例: `WITH ... DELETE`）については、諦める前に MySQL のパーサで1回だけ再解析し、その旨を文カードに表示します

## 機能一覧

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
| danger | `left-join-where-cancellation` | **（AST時のみ）** LEFT/RIGHT/FULL JOIN した外側テーブルの列を、WHERE句のトップレベルANDで等値絞り込みしている（NULL行が必ず除外されるため実質INNER JOIN化し、外部結合の意味が失われる）。`IS NULL` / `IS NOT NULL` は意図的な書き方なので対象外、ORの下にある条件も対象外 |
| danger | `truncate-table` | TRUNCATE TABLE |
| danger | `drop-table` | DROP TABLE |
| danger | `drop-database` | DROP DATABASE |
| warning | `or-no-parens` | WHERE句がOR結合かつ括弧なし（`a=1 OR b=2 AND c=3` のような意図しない範囲拡大。`BETWEEN x AND y` のANDは演算子優先順位の対象外として除外） |
| warning | `not-in-null-risk` | **（AST時のみ）** `NOT IN (SELECT ...)` を使っている（サブクエリ結果にNULLが1件でもあると全行が除外される）。`NOT EXISTS` の使用を促します。値リストの `NOT IN (1,2,3)` は対象外 |
| warning | `like-leading-wildcard` | `LIKE '%...'` のような前方一致でないLIKE（対象が広がりやすい） |
| warning | `self-subquery-no-condition` | `IN (SELECT ... FROM 同じテーブル)` で、サブクエリ側に絞り込み条件（WHERE）がない（相関ミスの定番） |
| warning | `implicit-conversion` | `id = '123'` のような引用符付き数値リテラルの比較（暗黙型変換によりインデックスが効かない/意図しない一致の懸念） |
| info (MySQL) | `mysql-no-limit` | UPDATE/DELETEにLIMITがない（主キー1行更新のような単純な等価WHEREのみの場合、およびLIMITに対応しないマルチテーブルUPDATEの場合は出しません） |
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
├── index.html            UI本体（vendor → sql-ast → summarizer → ast-rules → analyzer → app の順に読み込む）
├── css/style.css         スタイル（ダーク基調）
├── js/vendor/            同梱サードパーティ（実行時の外部読み込みは一切なし）
│   ├── node-sql-parser-mysql.js        node-sql-parser 5.4.0 UMD（MySQL方言）
│   ├── node-sql-parser-postgresql.js   同（PostgreSQL方言）
│   ├── node-sql-parser-transactsql.js  同（T-SQL方言）
│   └── LICENSE-node-sql-parser         Apache-2.0 ライセンス全文
├── js/sql-ast.js         同梱パーサのラッパーとAST共通ヘルパー（方言マッピング、フォールバック、
│                          AND/OR優先順位の正規化）
├── js/summarizer.js      日本語要約の生成（v2の主役。表示用データを返すだけでDOMは触らない）
├── js/ast-rules.js       AST基盤の検出ルール（既存ルールのAST版 + 新ルール3種）
├── js/analyzer.js        解析の司令塔＋正規表現フォールバック（IIFE + globalThis.SQLMeganeAnalyzer で公開。
│                          ESMのexportは使わず、file://直開きでも動く通常のスクリプト）
├── js/app.js             UI結線（DOM操作のみ、解析ロジックは持たない）
├── tools/build-vendor.mjs js/vendor/ を node_modules から再生成するスクリプト（配布物には不要）
├── tests/run-tests.mjs   自動テスト（`node tests/run-tests.mjs` で実行）
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

外部依存なし、プレーンな `assert` によるテストです（テストは同梱パーサを `js/vendor/` から読み込みます）。
