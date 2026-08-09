# SQLMegane（SQLめがね）

本番データベースに手作業でUPDATE/DELETEなどのSQLを実行する前に、貼り付けるだけで
危険な箇所をその場でチェックする、需要検証用の試作品（プロトタイプ）です。

競合の Bytebase のような組織導入型ツール（サーバー構築・アカウント管理が必要）とは異なり、
**インストール不要・組織導入不要・SQLはブラウザから一切外部に送信されない** ことを狙いにしています。

## 起動方法

ビルドや依存パッケージのインストールは不要です。

1. `index.html` をブラウザで直接開く（ダブルクリックでも可）
2. SQLを貼り付けて「解析する」を押す、または方言を選ぶだけで自動的に解析されます

ローカルサーバーを立てる必要はありません。オフラインでも動作します。

## 機能一覧

- 複数SQL文の一括解析（セミコロン区切り。文字列リテラル・コメント内のセミコロンでは誤分割しません）
- 方言選択（汎用 / Oracle / SQL Server / MySQL / PostgreSQL）に応じた警告の出し分け
- 文ごとのカード表示（危険度バッジ付き）
- **検算SELECTの自動生成**: UPDATE/DELETE文から `SELECT COUNT(*) FROM テーブル WHERE 同条件;` を自動生成し、コピーボタンで即座に控えられます（テーブルエイリアスが使われている場合は `FROM テーブル alias` の形でエイリアスも引き継ぎ、そのまま実行できるようにします）
- 危険が検出されなかった場合も「検出できない危険もあります」という文言で過信を防止
- プライバシー表記の常時表示（実際に外部通信・アナリティクスは一切実装していません）
- チーム版（構想）向けのメール登録プレースホルダー（送信ボタンはdisabledで「準備中」表示。実際の送信・外部フォーム接続は行っていません）

## 検出ルール一覧

| 重大度 | ルール | 内容 |
|---|---|---|
| danger | `no-where-update` | WHERE句のないUPDATE（`UPDATE ... JOIN ...` の形の場合は「JOINで一致した行がすべて更新されます」という文言に変わります） |
| danger | `no-where-delete` | WHERE句のないDELETE（`WITH ... AS (...)` のCTEプレフィックスがあっても本体のDELETEを判定します） |
| danger | `always-true-where` | 常に真になるWHERE句（`1=1`、`'a'='a'` など。`1=1 AND 実条件` のように他の条件と組み合わさっている場合は対象外。ただし `id=42 OR 1=1` のように**トップレベルのOR**でつながっている場合は検出します。括弧の中の `OR 1=1`（例: `a=1 AND (b=2 OR 1=1)`）は全行に波及しないため対象外） |
| danger | `truncate-table` | TRUNCATE TABLE |
| danger | `drop-table` | DROP TABLE |
| danger | `drop-database` | DROP DATABASE |
| warning | `or-no-parens` | WHERE句がOR結合かつ括弧なし（`a=1 OR b=2 AND c=3` のような意図しない範囲拡大。`BETWEEN x AND y` のANDは演算子優先順位の対象外として除外） |
| warning | `like-leading-wildcard` | `LIKE '%...'` のような前方一致でないLIKE（対象が広がりやすい） |
| warning | `self-subquery-no-condition` | `IN (SELECT ... FROM 同じテーブル)` で、サブクエリ側に絞り込み条件（WHERE）がない（相関ミスの定番） |
| warning | `implicit-conversion` | `id = '123'` のような引用符付き数値リテラルの比較（暗黙型変換によりインデックスが効かない/意図しない一致の懸念） |
| info (MySQL) | `mysql-no-limit` | UPDATE/DELETEにLIMITがない（主キー1行更新のような単純な等価WHEREのみの場合、およびLIMITに対応しないマルチテーブルUPDATEの場合は出しません） |
| warning (SQL Server, 複数文全体) | `mssql-multi-no-begintran` | 複数のUPDATE/DELETEがBEGIN TRANで囲まれていない（BEGIN TRANが破壊的文より後ろにしかない場合は「囲まれていない」扱いにします） |
| warning (Oracle) | `oracle-ddl-autocommit` | DML実行後にDDL（CREATE/ALTER/DROP/TRUNCATE）が混在（Oracleでは暗黙コミットが発生） |
| info (PostgreSQL) | `postgres-returning-tip` | UPDATE/DELETEにRETURNING句がない（付けると変更行を確認できる、というヒント） |
| info | `no-transaction` | 破壊的操作がBEGIN〜COMMITのようなトランザクションに包まれていない |
| info (貼り付け全体) | `multiple-destructive` | 1回の貼り付けに複数の破壊的操作が含まれている |

各警告には「なぜ危険か」「どうすればよいか」を短く添えています。

## 検出しなかった/見送ったルール

以下は仕様検討時に候補に挙がりましたが、正規表現ベースでは誤検知が多くなりやすいため、
このプロトタイプでは実装を見送りました（誤検知を出すより検出項目を絞る方針のため）。

- **WHERE句のないSELECT**: 事故につながりにくく、危険度が低いため対象外
- **AND/ORの一般的な優先順位ミス全般**: `OR`と`AND`が混在し、かつ**括弧が一つもない**場合のみに限定して検出しています。一部でも括弧が使われている式は、正規表現では「意図した括弧か抜けている括弧か」を安全に判別できないため判定を見送っています
- **相関サブクエリの完全な検証**: 別名（エイリアス）を介した本当の相関関係の有無まではチェックしていません。「同じテーブル名を条件なしで参照している」という最も典型的なパターンのみを検出しています
- **常に偽になるWHERE句（`1=2`など）**: 「更新0件」に気づきにくいという別種の事故ですが、危険側（全件に影響する事故）を優先し、今回は対象外としました

## 既知の限界

- **本ツールはSQLパーサではなく、正規表現と簡易な状態機械によるヒューリスティックです。** 複雑な入れ子のサブクエリ、ベンダー固有の複雑な構文、動的SQLの文字列組み立てなどは正しく解析できない場合があります
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
prototype/sqlmegane/
├── index.html          UI本体（js/analyzer.js → js/app.js の順に通常スクリプトとして読み込む）
├── css/style.css        スタイル（ダーク基調）
├── js/analyzer.js        解析ロジック（UIから独立。IIFE + globalThis.SQLMeganeAnalyzer で公開。
│                          ESMのexportは使わず、file://直開きでも動く通常のスクリプト）
├── js/app.js             UI結線（DOM操作のみ、解析ロジックは持たない）
├── tests/run-tests.mjs    自動テスト（`node tests/run-tests.mjs` で実行）
└── package.json          "type": "module" 指定のみ。依存パッケージなし
```

## テストの実行

```
node tests/run-tests.mjs
```

外部依存なし、プレーンな `assert` によるテストです。
