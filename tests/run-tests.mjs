// SQLMegane（SQLめがね） analyzer.js の自動テスト。
// テストフレームワークは使わず、Node標準の assert のみで検証する。
// 実行: node tests/run-tests.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// js/analyzer.js はfile://直開き対応のためESMのexportを使わず、globalThisに
// SQLMeganeAnalyzer を公開する通常のスクリプトになっている（詳細はREADME.md /
// docs/architecture.md 参照）。export文を持たないファイルなので、ここでは
// 副作用インポート（実行だけしてbindingは受け取らない）した後、
// globalThis.SQLMeganeAnalyzer から必要な関数を取り出す。
// 同梱パーサ（UMD）と AST 関連モジュールも同じ方式で読み込む。
// index.html の <script> の並び順と同じ順序で読み込むこと。
import '../js/vendor/node-sql-parser-mysql.js';
import '../js/vendor/node-sql-parser-postgresql.js';
import '../js/vendor/node-sql-parser-transactsql.js';
import '../js/sql-ast.js';
import '../js/summarizer.js';
import '../js/ast-rules.js';
import '../js/analyzer.js';

const { analyzeSQL, splitStatements, _internal } = globalThis.SQLMeganeAnalyzer;
const { summarize, summaryToLines } = globalThis.SQLMeganeSummarizer;

/** 要約を1本のテキストにして部分一致で検証しやすくする */
function summaryText(stmt) {
  return summaryToLines(stmt.summary).join('\n');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const readProjectFile = (rel) => fs.readFileSync(path.join(projectRoot, rel), 'utf8');

let passCount = 0;
let failCount = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passCount++;
  } catch (err) {
    failCount++;
    failures.push({ name, err });
  }
}

function findCode(findings, code) {
  return findings.find((f) => f.code === code);
}

function hasCode(findings, code) {
  return findCode(findings, code) !== undefined;
}

function firstStatement(sql, dialect) {
  const result = analyzeSQL(sql, dialect || 'generic');
  return result.statements[0];
}

// ---------------------------------------------------------------------------
// 文分割 (splitStatements)
// ---------------------------------------------------------------------------

test('splitStatements: 単純な複数文をセミコロンで分割する', () => {
  const stmts = splitStatements('SELECT 1; SELECT 2;');
  assert.equal(stmts.length, 2);
  assert.match(stmts[0], /SELECT 1/);
  assert.match(stmts[1], /SELECT 2/);
});

test('splitStatements: 末尾セミコロンなしでも最後の文を拾う', () => {
  const stmts = splitStatements('SELECT 1; SELECT 2');
  assert.equal(stmts.length, 2);
});

test('splitStatements: 文字列リテラル内のセミコロンで分割しない', () => {
  const stmts = splitStatements("UPDATE t SET note = 'a;b;c' WHERE id = 1;");
  assert.equal(stmts.length, 1);
  assert.match(stmts[0], /note = 'a;b;c'/);
});

test('splitStatements: エスケープされたシングルクォート(\'\')を含む文字列を正しく扱う', () => {
  const stmts = splitStatements("UPDATE t SET note = 'it''s; fine' WHERE id = 1; SELECT 1;");
  assert.equal(stmts.length, 2);
});

test('splitStatements: 行コメント(--)内のセミコロンで分割しない', () => {
  const stmts = splitStatements('SELECT 1; -- comment with ; inside\nSELECT 2;');
  assert.equal(stmts.length, 2);
});

test('splitStatements: ブロックコメント(/* */)内のセミコロンで分割しない', () => {
  const stmts = splitStatements('SELECT 1; /* comment ; with ; semicolons */ SELECT 2;');
  assert.equal(stmts.length, 2);
});

test('splitStatements: 空文・コメントのみの文は除外される', () => {
  const stmts = splitStatements('SELECT 1;;  -- just a comment\n;');
  assert.equal(stmts.length, 1);
});

test('splitStatements: ダブルクォート識別子内のセミコロンで分割しない', () => {
  const stmts = splitStatements('SELECT "weird;column" FROM t;');
  assert.equal(stmts.length, 1);
});

// ---------------------------------------------------------------------------
// WHERE句の有無
// ---------------------------------------------------------------------------

test('WHEREなしUPDATEはdangerで検出される', () => {
  const s = firstStatement('UPDATE users SET active = 0;');
  assert.ok(hasCode(s.findings, 'no-where-update'));
  assert.equal(findCode(s.findings, 'no-where-update').severity, 'danger');
});

test('WHEREありUPDATEはno-where-updateを出さない', () => {
  const s = firstStatement("UPDATE users SET active = 0 WHERE id = 42;");
  assert.ok(!hasCode(s.findings, 'no-where-update'));
});

test('WHEREなしDELETEはdangerで検出される', () => {
  const s = firstStatement('DELETE FROM users;');
  assert.ok(hasCode(s.findings, 'no-where-delete'));
  assert.equal(findCode(s.findings, 'no-where-delete').severity, 'danger');
});

test('WHEREありDELETEはno-where-deleteを出さない', () => {
  const s = firstStatement('DELETE FROM users WHERE id = 42;');
  assert.ok(!hasCode(s.findings, 'no-where-delete'));
});

test('SELECT文はWHEREなしでも危険判定しない（対象外）', () => {
  const s = firstStatement('SELECT * FROM users;');
  assert.ok(!hasCode(s.findings, 'no-where-update'));
  assert.ok(!hasCode(s.findings, 'no-where-delete'));
});

test('サブクエリを含むUPDATEでも外側にWHEREがあれば誤検知しない', () => {
  const s = firstStatement('UPDATE t SET x = (SELECT count(*) FROM t2) WHERE id = 1;');
  assert.ok(!hasCode(s.findings, 'no-where-update'));
});

// ---------------------------------------------------------------------------
// 常に真のWHERE句 (1=1 判定)
// ---------------------------------------------------------------------------

test("WHERE 1=1 のみはdangerで検出される", () => {
  const s = firstStatement('UPDATE users SET active = 0 WHERE 1=1;');
  assert.ok(hasCode(s.findings, 'always-true-where'));
  assert.equal(findCode(s.findings, 'always-true-where').severity, 'danger');
});

test("WHERE 1 = 1 (空白あり) も検出される", () => {
  const s = firstStatement('DELETE FROM users WHERE 1 = 1;');
  assert.ok(hasCode(s.findings, 'always-true-where'));
});

test("WHERE 'a'='a' も検出される", () => {
  const s = firstStatement("DELETE FROM users WHERE 'a'='a';");
  assert.ok(hasCode(s.findings, 'always-true-where'));
});

test("WHERE (1=1) のように括弧で全体を包んでいても検出される", () => {
  const s = firstStatement('UPDATE users SET active = 0 WHERE (1=1);');
  assert.ok(hasCode(s.findings, 'always-true-where'));
});

test("WHERE 1=1 AND 実条件 は対象外（誤検知しない）", () => {
  const s = firstStatement('UPDATE users SET active = 0 WHERE 1=1 AND id = 42;');
  assert.ok(!hasCode(s.findings, 'always-true-where'));
});

test("WHERE id = 5 のような通常条件では検出しない", () => {
  const s = firstStatement('DELETE FROM users WHERE id = 5;');
  assert.ok(!hasCode(s.findings, 'always-true-where'));
});

test("WHERE 'a'='b' (値が異なる) は常に真ではないので検出しない", () => {
  const s = firstStatement("DELETE FROM users WHERE 'a'='b';");
  assert.ok(!hasCode(s.findings, 'always-true-where'));
});

// ---------------------------------------------------------------------------
// TRUNCATE / DROP
// ---------------------------------------------------------------------------

test('TRUNCATE TABLEはdangerで検出される', () => {
  const s = firstStatement('TRUNCATE TABLE orders;');
  assert.ok(hasCode(s.findings, 'truncate-table'));
  assert.equal(findCode(s.findings, 'truncate-table').severity, 'danger');
});

test('DROP TABLEはdangerで検出される', () => {
  const s = firstStatement('DROP TABLE orders;');
  assert.ok(hasCode(s.findings, 'drop-table'));
});

test('DROP DATABASEはdangerで検出される', () => {
  const s = firstStatement('DROP DATABASE prod;');
  assert.ok(hasCode(s.findings, 'drop-database'));
});

test('DROP INDEXはdrop-table/drop-databaseどちらでもない', () => {
  const s = firstStatement('DROP INDEX idx_users_email;');
  assert.ok(!hasCode(s.findings, 'drop-table'));
  assert.ok(!hasCode(s.findings, 'drop-database'));
});

// ---------------------------------------------------------------------------
// OR結合で括弧がない
// ---------------------------------------------------------------------------

test('OR/AND混在で括弧なしはwarningで検出される', () => {
  const s = firstStatement('UPDATE t SET x=1 WHERE a=1 OR b=2 AND c=3;');
  assert.ok(hasCode(s.findings, 'or-no-parens'));
  assert.equal(findCode(s.findings, 'or-no-parens').severity, 'warning');
});

test('括弧で明示されていれば検出しない', () => {
  const s = firstStatement('UPDATE t SET x=1 WHERE a=1 OR (b=2 AND c=3);');
  assert.ok(!hasCode(s.findings, 'or-no-parens'));
});

test('ORのみ（ANDなし）は対象外', () => {
  const s = firstStatement('UPDATE t SET x=1 WHERE a=1 OR b=2;');
  assert.ok(!hasCode(s.findings, 'or-no-parens'));
});

// ---------------------------------------------------------------------------
// LIKE 前方一致でない
// ---------------------------------------------------------------------------

test("LIKE '%foo' は前方一致でないため検出される", () => {
  const s = firstStatement("UPDATE t SET x=1 WHERE name LIKE '%foo';");
  assert.ok(hasCode(s.findings, 'like-leading-wildcard'));
});

test("LIKE 'foo%' (前方一致)は検出しない", () => {
  const s = firstStatement("UPDATE t SET x=1 WHERE name LIKE 'foo%';");
  assert.ok(!hasCode(s.findings, 'like-leading-wildcard'));
});

// ---------------------------------------------------------------------------
// 暗黙型変換の疑い
// ---------------------------------------------------------------------------

test("id = '123' のような引用符付き数値はwarningで検出される", () => {
  const s = firstStatement("UPDATE t SET x=1 WHERE id = '123';");
  assert.ok(hasCode(s.findings, 'implicit-conversion'));
});

test("id = 123 (引用符なし)は検出しない", () => {
  const s = firstStatement('UPDATE t SET x=1 WHERE id = 123;');
  assert.ok(!hasCode(s.findings, 'implicit-conversion'));
});

test("name = 'abc' (数値でない文字列)は検出しない", () => {
  const s = firstStatement("UPDATE t SET x=1 WHERE name = 'abc';");
  assert.ok(!hasCode(s.findings, 'implicit-conversion'));
});

// ---------------------------------------------------------------------------
// 自己参照サブクエリで条件なし
// ---------------------------------------------------------------------------

test('IN (SELECT ... FROM 同テーブル) で条件なしはwarningで検出される', () => {
  const s = firstStatement('DELETE FROM orders WHERE id IN (SELECT id FROM orders);');
  assert.ok(hasCode(s.findings, 'self-subquery-no-condition'));
});

test('サブクエリにWHEREがあれば検出しない', () => {
  const s = firstStatement('DELETE FROM orders WHERE id IN (SELECT id FROM orders WHERE status = 1);');
  assert.ok(!hasCode(s.findings, 'self-subquery-no-condition'));
});

test('別テーブルを参照するサブクエリは検出しない', () => {
  const s = firstStatement('DELETE FROM orders WHERE id IN (SELECT order_id FROM order_items);');
  assert.ok(!hasCode(s.findings, 'self-subquery-no-condition'));
});

// ---------------------------------------------------------------------------
// 検算SELECTの自動生成
// ---------------------------------------------------------------------------

test('UPDATEから検算SELECTが生成される（WHERE条件を引き継ぐ）', () => {
  const s = firstStatement('UPDATE orders SET status = 1 WHERE id = 42;');
  assert.equal(s.verifySelect, 'SELECT COUNT(*) FROM orders WHERE id = 42;');
});

test('DELETEから検算SELECTが生成される', () => {
  const s = firstStatement('DELETE FROM orders WHERE customer_id = 7;');
  assert.equal(s.verifySelect, 'SELECT COUNT(*) FROM orders WHERE customer_id = 7;');
});

test('WHEREなしUPDATEでもテーブル全体件数の検算SELECTを出す', () => {
  const s = firstStatement('UPDATE orders SET status = 1;');
  assert.equal(s.verifySelect, 'SELECT COUNT(*) FROM orders;');
});

test('SELECT文には検算SELECTを生成しない', () => {
  const s = firstStatement('SELECT * FROM orders;');
  assert.equal(s.verifySelect, null);
});

// ---------------------------------------------------------------------------
// トランザクション文脈 / 複数破壊的文
// ---------------------------------------------------------------------------

test('BEGINなしの破壊的操作にはno-transaction infoが付く', () => {
  const s = firstStatement('DELETE FROM orders WHERE id = 1;');
  assert.ok(hasCode(s.findings, 'no-transaction'));
  assert.equal(findCode(s.findings, 'no-transaction').severity, 'info');
});

test('BEGINで囲まれていればno-transactionは付かない', () => {
  const result = analyzeSQL('BEGIN; DELETE FROM orders WHERE id = 1; COMMIT;', 'generic');
  const del = result.statements.find((s) => s.kind === 'DELETE');
  assert.ok(!hasCode(del.findings, 'no-transaction'));
});

test('複数の破壊的文があるとglobalFindingsにmultiple-destructiveが出る', () => {
  const result = analyzeSQL('DELETE FROM a WHERE id=1; DELETE FROM b WHERE id=2;', 'generic');
  assert.ok(result.globalFindings.some((f) => f.code === 'multiple-destructive'));
});

test('破壊的文が1つだけならmultiple-destructiveは出ない', () => {
  const result = analyzeSQL('DELETE FROM a WHERE id=1;', 'generic');
  assert.ok(!result.globalFindings.some((f) => f.code === 'multiple-destructive'));
});

// ---------------------------------------------------------------------------
// 方言別ルール
// ---------------------------------------------------------------------------

test('MySQL方言: LIMITなしUPDATEは検出される（重大度は指摘8の項目で個別に確認）', () => {
  const s = firstStatement('UPDATE t SET x=1 WHERE id > 100;', 'mysql');
  assert.ok(hasCode(s.findings, 'mysql-no-limit'));
});

test('MySQL方言: LIMITありなら検出しない', () => {
  const s = firstStatement('UPDATE t SET x=1 WHERE id > 100 LIMIT 10;', 'mysql');
  assert.ok(!hasCode(s.findings, 'mysql-no-limit'));
});

test('汎用方言ではmysql-no-limitは出さない', () => {
  const s = firstStatement('UPDATE t SET x=1 WHERE id > 100;', 'generic');
  assert.ok(!hasCode(s.findings, 'mysql-no-limit'));
});

test('SQL Server方言: 複数更新かつBEGIN TRANなしでglobal warning', () => {
  const result = analyzeSQL('UPDATE a SET x=1 WHERE id=1; UPDATE b SET x=1 WHERE id=2;', 'mssql');
  assert.ok(result.globalFindings.some((f) => f.code === 'mssql-multi-no-begintran'));
});

test('SQL Server方言: BEGIN TRANがあればwarningを出さない', () => {
  const result = analyzeSQL('BEGIN TRAN; UPDATE a SET x=1 WHERE id=1; UPDATE b SET x=1 WHERE id=2; COMMIT;', 'mssql');
  assert.ok(!result.globalFindings.some((f) => f.code === 'mssql-multi-no-begintran'));
});

test('Oracle方言: DML後のDDLでwarning', () => {
  const result = analyzeSQL("UPDATE t SET x=1 WHERE id=1; DROP TABLE tmp_backup;", 'oracle');
  const drop = result.statements.find((s) => s.kind === 'DROP_TABLE');
  assert.ok(hasCode(drop.findings, 'oracle-ddl-autocommit'));
});

test('Oracle方言: DML前のDDLだけならwarningを出さない', () => {
  const result = analyzeSQL('DROP TABLE tmp_backup;', 'oracle');
  const drop = result.statements.find((s) => s.kind === 'DROP_TABLE');
  assert.ok(!hasCode(drop.findings, 'oracle-ddl-autocommit'));
});

test('PostgreSQL方言: RETURNINGなしUPDATEはinfoで案内', () => {
  const s = firstStatement('UPDATE t SET x=1 WHERE id=1;', 'postgres');
  assert.ok(hasCode(s.findings, 'postgres-returning-tip'));
});

test('PostgreSQL方言: RETURNINGありなら案内しない', () => {
  const s = firstStatement('UPDATE t SET x=1 WHERE id=1 RETURNING *;', 'postgres');
  assert.ok(!hasCode(s.findings, 'postgres-returning-tip'));
});

// ---------------------------------------------------------------------------
// 危険なしケース
// ---------------------------------------------------------------------------

test('安全なUPDATEはdanger/warningを出さない', () => {
  const s = firstStatement("UPDATE orders SET status = 'shipped' WHERE id = 42;", 'generic');
  const bad = s.findings.filter((f) => f.severity === 'danger' || f.severity === 'warning');
  assert.equal(bad.length, 0);
});

// ---------------------------------------------------------------------------
// レビュー指摘 1 (critical): 引用符付きテーブル名で検算SELECTが壊れる
// ---------------------------------------------------------------------------

test('バッククォート付きテーブル名でも検算SELECTが正しいテーブル名を保持する', () => {
  const s = firstStatement('UPDATE `users` SET x=1 WHERE id=1;');
  assert.equal(s.verifySelect, 'SELECT COUNT(*) FROM `users` WHERE id=1;');
});

test('ダブルクォート付きテーブル名でも検算SELECTが正しいテーブル名を保持する', () => {
  const s = firstStatement('DELETE FROM "orders" WHERE id = 1;');
  assert.equal(s.verifySelect, 'SELECT COUNT(*) FROM "orders" WHERE id = 1;');
});

test('角カッコ付きテーブル名（SQL Server）でも検算SELECTが正しいテーブル名を保持する', () => {
  const s = firstStatement('DELETE FROM [orders] WHERE id = 1;');
  assert.equal(s.verifySelect, 'SELECT COUNT(*) FROM [orders] WHERE id = 1;');
});

test('バッククォート付き識別子内のセミコロンで文分割しない（識別子はマスク対象でない）', () => {
  const stmts = splitStatements('SELECT * FROM `weird;table`;');
  assert.equal(stmts.length, 1);
});

// ---------------------------------------------------------------------------
// レビュー指摘 2 (major): OR 1=1 型トートロジー見逃し
// ---------------------------------------------------------------------------

test('WHERE id = 42 OR 1=1 はトップレベルORでdangerとして検出される', () => {
  const s = firstStatement('DELETE FROM users WHERE id = 42 OR 1=1;');
  assert.ok(hasCode(s.findings, 'always-true-where'));
  assert.equal(findCode(s.findings, 'always-true-where').severity, 'danger');
});

test('括弧内のOR 1=1は全行に波及しないため誤検知しない', () => {
  const s = firstStatement('UPDATE t SET x=1 WHERE a=1 AND (b=2 OR 1=1);');
  assert.ok(!hasCode(s.findings, 'always-true-where'));
});

// ---------------------------------------------------------------------------
// レビュー指摘 3 (major): CTE付きDELETE/UPDATEが素通り
// ---------------------------------------------------------------------------

test('WITH句付きのWHEREなしDELETEもno-where-deleteで検出される', () => {
  const s = firstStatement('WITH old AS (SELECT * FROM users WHERE active=0) DELETE FROM users;');
  assert.equal(s.kind, 'DELETE');
  assert.ok(hasCode(s.findings, 'no-where-delete'));
});

test('WITH句付きでも外側にWHEREがあれば誤検知せず、検算SELECTも正しく生成される', () => {
  const s = firstStatement('WITH old AS (SELECT * FROM users) DELETE FROM users WHERE id IN (SELECT id FROM old);');
  assert.equal(s.kind, 'DELETE');
  assert.ok(!hasCode(s.findings, 'no-where-delete'));
  assert.equal(s.verifySelect, 'SELECT COUNT(*) FROM users WHERE id IN (SELECT id FROM old);');
});

// ---------------------------------------------------------------------------
// レビュー指摘 4 (major): MySQLバックスラッシュエスケープ非対応
// ---------------------------------------------------------------------------

test('MySQL方言ではリテラル内のバックスラッシュエスケープを認識し、誤って文分割しない', () => {
  const sql = "UPDATE t SET note = 'it\\'s bad; ok' WHERE id=1; SELECT 1;";
  const stmts = splitStatements(sql, 'mysql');
  assert.equal(stmts.length, 2);
  assert.match(stmts[0], /note = 'it\\'s bad; ok'/);
});

test('MySQL方言でのバックスラッシュエスケープありSQLはUPDATE文として正しく解析される', () => {
  const sql = "UPDATE t SET note = 'it\\'s bad; ok' WHERE id=1;";
  const s = firstStatement(sql, 'mysql');
  assert.equal(s.kind, 'UPDATE');
  assert.equal(s.verifySelect, 'SELECT COUNT(*) FROM t WHERE id=1;');
});

// ---------------------------------------------------------------------------
// レビュー指摘 5 (major): 予約語風カラム名で検算SELECTが黙ってWHEREを落とす
// ---------------------------------------------------------------------------

test("カラム名がOFFSETでも検算SELECTのWHERE句を黙って落とさない", () => {
  const s = firstStatement('DELETE FROM t WHERE offset > 5;');
  assert.equal(s.verifySelect, 'SELECT COUNT(*) FROM t WHERE offset > 5;');
});

test('ORDER BYが実際に続く場合は従来通りWHERE句の終端として扱う（回帰確認）', () => {
  const s = firstStatement('DELETE FROM t WHERE id = 1 ORDER BY name;');
  assert.equal(s.verifySelect, 'SELECT COUNT(*) FROM t WHERE id = 1;');
});

// ---------------------------------------------------------------------------
// レビュー指摘 6 (major): BETWEEN誤検知
// ---------------------------------------------------------------------------

test('BETWEEN x AND y のANDはor-no-parens判定の対象外になる', () => {
  const s = firstStatement('UPDATE t SET x=1 WHERE a BETWEEN 1 AND 5 OR b = 2;');
  assert.ok(!hasCode(s.findings, 'or-no-parens'));
});

test('BETWEEN以外に本物のANDがあればor-no-parensは引き続き検出される', () => {
  const s = firstStatement('UPDATE t SET x=1 WHERE a BETWEEN 1 AND 5 AND b = 2 OR c = 3;');
  assert.ok(hasCode(s.findings, 'or-no-parens'));
});

// ---------------------------------------------------------------------------
// レビュー指摘 7 (major): テーブルエイリアスで検算SELECTが実行不能
// ---------------------------------------------------------------------------

test('テーブルエイリアス付きDELETEの検算SELECTにもエイリアスが含まれる', () => {
  const s = firstStatement('DELETE FROM orders o WHERE o.id = 7;');
  assert.equal(s.verifySelect, 'SELECT COUNT(*) FROM orders o WHERE o.id = 7;');
});

test('AS付きエイリアスのUPDATEでも検算SELECTにエイリアスが含まれる', () => {
  const s = firstStatement('UPDATE orders AS o SET status=1 WHERE o.id=5;');
  assert.equal(s.verifySelect, 'SELECT COUNT(*) FROM orders o WHERE o.id=5;');
});

test('エイリアスなしの従来ケースは引き続きテーブル名のみ（回帰確認）', () => {
  const s = firstStatement('DELETE FROM orders WHERE customer_id = 7;');
  assert.equal(s.verifySelect, 'SELECT COUNT(*) FROM orders WHERE customer_id = 7;');
});

// ---------------------------------------------------------------------------
// レビュー指摘 8 (major): mysql-no-limit が全UPDATE/DELETEに発火
// ---------------------------------------------------------------------------

test('MySQL方言: LIMITなしUPDATEはinfoに格下げされている', () => {
  const s = firstStatement('UPDATE t SET x=1 WHERE id > 100;', 'mysql');
  assert.ok(hasCode(s.findings, 'mysql-no-limit'));
  assert.equal(findCode(s.findings, 'mysql-no-limit').severity, 'info');
});

test('MySQL方言: 主キー1行更新のような単純な等価WHEREだけならmysql-no-limitを出さない', () => {
  const s = firstStatement('UPDATE users SET active=1 WHERE id = 42;', 'mysql');
  assert.ok(!hasCode(s.findings, 'mysql-no-limit'));
});

test('MySQL方言: JOINを使ったマルチテーブルUPDATEはLIMIT非対応なのでmysql-no-limitを出さない', () => {
  const s = firstStatement('UPDATE t1 JOIN t2 ON t1.id = t2.id SET t1.x = 1 WHERE t2.y > 2;', 'mysql');
  assert.ok(!hasCode(s.findings, 'mysql-no-limit'));
});

test('MySQL方言: カンマ区切りのマルチテーブルUPDATEもmysql-no-limitを出さない', () => {
  const s = firstStatement('UPDATE t1, t2 SET t1.x = t2.y WHERE t1.id > t2.id;', 'mysql');
  assert.ok(!hasCode(s.findings, 'mysql-no-limit'));
});

// ---------------------------------------------------------------------------
// レビュー指摘 9 (minor): UPDATE ... JOIN（WHEREなし）の文言
// ---------------------------------------------------------------------------

test('WHEREなしのUPDATE...JOINはJOIN一致行についての文言になる', () => {
  const s = firstStatement('UPDATE orders o JOIN customers c ON o.customer_id = c.id SET o.status = 1;');
  assert.ok(hasCode(s.findings, 'no-where-update'));
  assert.match(findCode(s.findings, 'no-where-update').message, /JOINで一致した行がすべて更新されます/);
});

test('JOINを使わない通常のWHEREなしUPDATEは従来通り「全行」の文言のまま（回帰確認）', () => {
  const s = firstStatement('UPDATE users SET active = 0;');
  assert.match(findCode(s.findings, 'no-where-update').message, /テーブルの全行が更新されます/);
});

// ---------------------------------------------------------------------------
// レビュー指摘 10 (minor): mssql-multi-no-begintran が位置を見ない
// ---------------------------------------------------------------------------

test('SQL Server方言: 破壊的文より後ろにあるBEGIN TRANでは抑止されない', () => {
  const result = analyzeSQL('UPDATE a SET x=1 WHERE id=1; BEGIN TRAN; UPDATE b SET x=1 WHERE id=2;', 'mssql');
  assert.ok(result.globalFindings.some((f) => f.code === 'mssql-multi-no-begintran'));
});

// ---------------------------------------------------------------------------
// レビュー指摘 11 (minor): index.html のCSP・インラインonsubmit廃止
// ---------------------------------------------------------------------------

test('index.htmlはインラインonsubmit属性を持たない', () => {
  const html = readProjectFile('index.html');
  assert.ok(!/onsubmit\s*=/.test(html));
});

test('index.htmlはCSP metaタグを持ち、想定のディレクティブを含む', () => {
  const html = readProjectFile('index.html');
  const m = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)">/);
  assert.ok(m, 'CSP meta タグが見つかりません');
  const csp = m[1];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /style-src 'self'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /form-action 'none'/);
});

test('index.htmlはCTAフォームを持たず、GitHub IssueへのリンクをCTAとして持つ', () => {
  const html = readProjectFile('index.html');
  assert.ok(!/<form/.test(html), 'CTA用のformが残っています');
  assert.match(html, /<a class="btn btn-primary cta-issue-link" href="https:\/\/github\.com\/selene-nyx-ai\/sqlmegane\/issues" target="_blank" rel="noopener">/);
  const appJs = readProjectFile('js/app.js');
  assert.ok(!/ctaForm/.test(appJs), 'app.jsにctaFormへの参照が残っています');
});

// ---------------------------------------------------------------------------
// レビュー指摘 12 (minor): 「検出なし」チップの色・文言
// ---------------------------------------------------------------------------

test('app.jsは「検出なし」チップの文言を「危険の検出なし」に変更している', () => {
  const appJs = readProjectFile('js/app.js');
  assert.match(appJs, /危険の検出なし/);
});

test('style.cssは検出なしチップにニュートラル色（--neutral系）を使い、緑（--ok）を使わない', () => {
  const css = readProjectFile('css/style.css');
  const m = css.match(/\.severity-chip\.ok\s*\{([^}]*)\}/);
  assert.ok(m, '.severity-chip.ok のスタイル定義が見つかりません');
  const body = m[1];
  assert.match(body, /var\(--neutral\)/);
  assert.match(body, /var\(--neutral-bg\)/);
  assert.match(body, /var\(--neutral-border\)/);
  assert.ok(!/var\(--ok\)/.test(body));
});

// ---------------------------------------------------------------------------
// レビュー指摘 13 (minor): Postgresドル引用符は非対応（ドキュメントのみ）
// ---------------------------------------------------------------------------

test('README.mdの既知の限界にPostgresドル引用符（$$）の非対応が明記されている', () => {
  const readme = readProjectFile('README.md');
  assert.match(readme, /\$\$/);
});

test('README.mdのmysql-no-limitの重大度表記がinfoに更新されている', () => {
  const readme = readProjectFile('README.md');
  assert.match(readme, /\|\s*info\s*\(MySQL\)\s*\|\s*`mysql-no-limit`/);
});

// ---------------------------------------------------------------------------
// v2: 同梱パーサの読み込みと解析モード
// ---------------------------------------------------------------------------

test('同梱パーサ3方言がグローバルに登録され、互いに上書きし合っていない', () => {
  const vendor = globalThis.SQLMeganeVendor;
  assert.ok(vendor, 'SQLMeganeVendor が未定義です');
  for (const d of ['mysql', 'postgresql', 'transactsql']) {
    assert.equal(typeof vendor[d].Parser, 'function', `${d} の Parser がありません`);
  }
  // UMDがグローバルへ直接エクスポートしていないこと（名前衝突対策の回帰確認）
  assert.equal(typeof globalThis.Parser, 'undefined');
});

test('MySQL方言はASTで解析される', () => {
  const s = firstStatement('UPDATE users SET flg = 1 WHERE id = 1;', 'mysql');
  assert.equal(s.parse.mode, 'ast');
  assert.equal(s.parse.parserDialect, 'mysql');
});

test('PostgreSQL方言はASTで解析される', () => {
  const s = firstStatement('UPDATE users SET flg = 1 WHERE id = 1;', 'postgres');
  assert.equal(s.parse.mode, 'ast');
  assert.equal(s.parse.parserDialect, 'postgresql');
});

test('SQL Server方言はASTで解析される', () => {
  const s = firstStatement('UPDATE users SET flg = 1 WHERE id = 1;', 'mssql');
  assert.equal(s.parse.mode, 'ast');
  assert.equal(s.parse.parserDialect, 'transactsql');
});

test('Oracle・汎用は構文解析の対象外（簡易チェック）で、要約も出さない', () => {
  for (const dialect of ['oracle', 'generic']) {
    const result = analyzeSQL('UPDATE users SET flg = 1 WHERE id = 1;', dialect);
    assert.equal(result.analysis.astSupported, false, dialect);
    assert.equal(result.statements[0].parse.mode, 'regex-only', dialect);
    assert.equal(result.statements[0].summary, null, dialect);
  }
});

test('パースできない文は簡易チェックへフォールバックし、エラー位置を返す', () => {
  const s = firstStatement('SELECT * FROM t WHERE a = = ;', 'mysql');
  assert.equal(s.parse.mode, 'fallback');
  assert.ok(s.parse.error, 'error が入っていません');
  assert.equal(typeof s.parse.error.message, 'string');
  assert.equal(s.parse.error.line, 1);
});

test('フォールバック時のエラー位置は貼り付けたテキスト全体での行番号に変換される', () => {
  const sql = 'UPDATE a SET x = 1 WHERE id = 1;\n\nSELECT * FROM t WHERE a = = ;';
  const result = analyzeSQL(sql, 'mysql');
  const broken = result.statements[1];
  assert.equal(broken.parse.mode, 'fallback');
  assert.equal(broken.parse.error.globalLine, 3);
});

test('フォールバックしても既存の正規表現ルールは働き続ける', () => {
  // わざと壊した構文（パース不能）だが、WHERE句が無いことは簡易チェックで拾える
  const s = firstStatement('UPDATE users SET flg = 1 (', 'mysql');
  assert.equal(s.parse.mode, 'fallback');
  assert.ok(hasCode(s.findings, 'no-where-update'));
});

test('PostgreSQLで通らないCTE付きDELETEはmysqlパーサで解析され、その旨が返る', () => {
  const s = firstStatement('WITH old AS (SELECT id FROM users WHERE active = 0) DELETE FROM users WHERE id IN (SELECT id FROM old);', 'postgres');
  assert.equal(s.parse.mode, 'ast');
  assert.equal(s.parse.usedFallbackDialect, 'mysql');
  assert.equal(s.kind, 'DELETE');
});

test('splitStatementsWithOffsets は元テキストでの開始位置を返す', () => {
  const sql = 'SELECT 1;\nSELECT 2;';
  const parts = _internal.splitStatementsWithOffsets(sql, 'generic');
  assert.equal(parts.length, 2);
  assert.equal(parts[0].start, 0);
  assert.equal(sql.slice(parts[1].start, parts[1].start + 8), 'SELECT 2');
});

// ---------------------------------------------------------------------------
// v2: 日本語要約 (summarizer.js)
// ---------------------------------------------------------------------------

test('要約: UPDATEは対象テーブル（別名つき）と更新列を述べる', () => {
  const s = firstStatement("UPDATE m_users u SET u.deleted_flg = 1 WHERE u.dept_cd = '10';", 'mysql');
  assert.ok(s.summary, '要約が生成されていません');
  assert.equal(s.summary.op, 'UPDATE');
  assert.match(s.summary.headline, /`m_users`（別名 u）の `deleted_flg` を更新します/);
});

test('要約: DELETEは対象テーブルからの削除であることを述べる', () => {
  const s = firstStatement('DELETE FROM orders WHERE id = 7;', 'mysql');
  assert.equal(s.summary.op, 'DELETE');
  assert.match(s.summary.headline, /`orders`から行を削除します/);
});

test('要約: INSERTは追加先テーブルと列を述べる', () => {
  const s = firstStatement('INSERT INTO logs (a, b) VALUES (1, 2);', 'mysql');
  assert.equal(s.summary.op, 'INSERT');
  assert.match(summaryText(s), /`logs`に行を追加します/);
  assert.match(summaryText(s), /指定している列: `a`、`b`/);
});

test('要約: SELECTは取得元と取得列を述べる', () => {
  const s = firstStatement('SELECT id, name FROM users WHERE id = 1;', 'mysql');
  assert.equal(s.summary.op, 'SELECT');
  assert.match(summaryText(s), /`users`から行を取得します/);
});

test('要約: WHERE条件をANDでつないだ日本語に言い換える', () => {
  const s = firstStatement("UPDATE m_users u SET u.deleted_flg = 1 WHERE u.dept_cd = '10' AND u.last_login < '2024-01-01';", 'mysql');
  const text = summaryText(s);
  assert.match(text, /`u\.dept_cd` が '10' と等しい/);
  assert.match(text, /かつ/);
  assert.match(text, /`u\.last_login` が '2024-01-01' より前である/);
});

test('要約: WHERE句が無いUPDATEは「条件なし＝全行が対象」を要約内でも強調する', () => {
  const s = firstStatement('UPDATE users SET flg = 1;', 'mysql');
  const alert = s.summary.blocks.find((b) => b.type === 'alert');
  assert.ok(alert, '強調ブロックがありません');
  assert.match(alert.text, /条件なし＝全行が対象です/);
});

test('要約: WHERE句が無いDELETEも「条件なし＝全行が対象」を強調する', () => {
  const s = firstStatement('DELETE FROM users;', 'mysql');
  const alert = s.summary.blocks.find((b) => b.type === 'alert');
  assert.ok(alert);
  assert.match(alert.text, /条件なし＝全行が対象です/);
});

test('要約: OR/ANDの入れ子は箇条書き（入れ子リスト）で表現する', () => {
  const s = firstStatement('UPDATE t SET x = 1 WHERE (a = 1 OR b = 2) AND c = 3;', 'mysql');
  const list = s.summary.blocks.find((b) => b.type === 'list' && /WHERE/.test(b.title || ''));
  assert.ok(list, '条件の箇条書きブロックがありません');
  const text = summaryText(s);
  assert.match(text, /次のすべてを満たす/);
  assert.match(text, /次のいずれかを満たす/);
});

test('要約: INNER JOINは「一致する行がある側だけが対象」と、外れる側の両方を述べる', () => {
  const s = firstStatement('SELECT u.id FROM users u INNER JOIN orders o ON u.id = o.user_id;', 'mysql');
  const join = s.summary.blocks.find((b) => b.type === 'join');
  assert.ok(join, 'JOINの説明がありません');
  assert.match(join.text, /INNER JOIN/);
  assert.match(join.text, /一致する行がある/);
  assert.match(join.text, /一致する行が無い .*対象から外れます/);
});

test('要約: LEFT JOINは「一致しない行も含まれる」ことと NULL 化の両方を述べる', () => {
  const s = firstStatement('SELECT u.id FROM users u LEFT JOIN orders o ON u.id = o.user_id;', 'mysql');
  const join = s.summary.blocks.find((b) => b.type === 'join');
  assert.ok(join);
  assert.match(join.text, /LEFT JOIN/);
  assert.match(join.text, /一致する行が無い .*も対象に含まれます/);
  assert.match(join.text, /NULL になります/);
});

test('要約: RIGHT JOINも含まれる側と除外されない側を言語化する', () => {
  const s = firstStatement('SELECT u.id FROM users u RIGHT JOIN orders o ON u.id = o.user_id;', 'mysql');
  const join = s.summary.blocks.find((b) => b.type === 'join');
  assert.ok(join);
  assert.match(join.text, /RIGHT JOIN/);
  assert.match(join.text, /も対象に含まれます/);
});

test('要約: CROSS JOINは直積になることを述べる', () => {
  const s = firstStatement('SELECT * FROM a CROSS JOIN b;', 'mysql');
  const join = s.summary.blocks.find((b) => b.type === 'join');
  assert.ok(join);
  assert.match(join.text, /直積/);
});

test('要約: UPDATE + JOIN ではどのテーブルが書き換わるかを明示する', () => {
  const s = firstStatement("UPDATE u SET u.flg = 1 FROM users u LEFT JOIN depts d ON u.dept_id = d.id WHERE d.code = 'A';", 'mssql');
  assert.match(summaryText(s), /更新されるのは `users`（別名 u）側の行です/);
});

test('要約: CTEがあれば先に組み立てることを述べる', () => {
  const s = firstStatement('WITH old AS (SELECT id FROM users) DELETE FROM users WHERE id IN (SELECT id FROM old);', 'mysql');
  assert.match(summaryText(s), /WITH句（CTE）/);
});

test('要約: 対応しない文（トランザクション制御）ではnullを返して何も書かない', () => {
  const s = firstStatement('COMMIT;', 'mysql');
  assert.equal(s.summary, null);
});

test('要約: 条件を要約できない場合は黙って省略せず、その旨を書く', () => {
  const { conditionText } = globalThis.SQLMeganeSummarizer._internal;
  assert.match(conditionText({ type: 'unknown_node' }), /要約できませんでした/);
});

// ---------------------------------------------------------------------------
// v2: AST基盤の新ルール (ast-rules.js)
// ---------------------------------------------------------------------------

test('left-join-where-cancellation: LEFT JOIN先の列をWHEREで等値絞り込みするとdanger', () => {
  const s = firstStatement("UPDATE u SET u.flg = 1 FROM users u LEFT JOIN depts d ON u.dept_id = d.id WHERE d.code = 'A';", 'mssql');
  assert.ok(hasCode(s.findings, 'left-join-where-cancellation'));
  assert.equal(findCode(s.findings, 'left-join-where-cancellation').severity, 'danger');
  assert.match(findCode(s.findings, 'left-join-where-cancellation').message, /実質INNER JOIN/);
});

test('left-join-where-cancellation: SELECT+LEFT JOINでも検出される', () => {
  const s = firstStatement("DELETE u FROM users u LEFT JOIN orders o ON u.id = o.user_id WHERE o.status = 'x';", 'mysql');
  assert.ok(hasCode(s.findings, 'left-join-where-cancellation'));
});

test('left-join-where-cancellation: IS NULL（アンチジョイン）では誤検知しない', () => {
  const s = firstStatement('DELETE u FROM users u LEFT JOIN orders o ON u.id = o.user_id WHERE o.id IS NULL;', 'mysql');
  assert.ok(!hasCode(s.findings, 'left-join-where-cancellation'));
});

test('left-join-where-cancellation: 駆動表側の列で絞り込むだけなら誤検知しない', () => {
  const s = firstStatement('DELETE u FROM users u LEFT JOIN orders o ON u.id = o.user_id WHERE u.active = 0;', 'mysql');
  assert.ok(!hasCode(s.findings, 'left-join-where-cancellation'));
});

test('left-join-where-cancellation: INNER JOINでは検出しない', () => {
  const s = firstStatement("DELETE u FROM users u INNER JOIN orders o ON u.id = o.user_id WHERE o.status = 'x';", 'mysql');
  assert.ok(!hasCode(s.findings, 'left-join-where-cancellation'));
});

test('left-join-where-cancellation: ORの中の条件では検出しない（トップレベルANDのみ対象）', () => {
  const s = firstStatement("DELETE u FROM users u LEFT JOIN orders o ON u.id = o.user_id WHERE o.status = 'x' OR o.id IS NULL;", 'mysql');
  assert.ok(!hasCode(s.findings, 'left-join-where-cancellation'));
});

test('left-join-where-cancellation: RIGHT JOINでは反対側の表が対象になる', () => {
  const s = firstStatement("DELETE o FROM users u RIGHT JOIN orders o ON u.id = o.user_id WHERE u.active = 1;", 'mysql');
  assert.ok(hasCode(s.findings, 'left-join-where-cancellation'));
});

test('not-in-null-risk: NOT IN (SELECT ...) をwarningで検出する', () => {
  const s = firstStatement('DELETE FROM users WHERE id NOT IN (SELECT user_id FROM orders);', 'postgres');
  assert.ok(hasCode(s.findings, 'not-in-null-risk'));
  assert.equal(findCode(s.findings, 'not-in-null-risk').severity, 'warning');
  assert.match(findCode(s.findings, 'not-in-null-risk').message, /NOT EXISTS/);
});

test('not-in-null-risk: 値リストのNOT INでは検出しない', () => {
  const s = firstStatement('DELETE FROM users WHERE id NOT IN (1, 2, 3);', 'postgres');
  assert.ok(!hasCode(s.findings, 'not-in-null-risk'));
});

test('not-in-null-risk: NOT EXISTSでは検出しない', () => {
  const s = firstStatement('DELETE FROM users u WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id);', 'postgres');
  assert.ok(!hasCode(s.findings, 'not-in-null-risk'));
});

test('update-delete-join-basis: JOINありUPDATEでどのテーブルが書き換わるかをinfoで示す', () => {
  const s = firstStatement("UPDATE u SET u.flg = 1 FROM users u LEFT JOIN depts d ON u.dept_id = d.id WHERE d.code = 'A';", 'mssql');
  const f = findCode(s.findings, 'update-delete-join-basis');
  assert.ok(f);
  assert.equal(f.severity, 'info');
  assert.match(f.message, /書き換わるのは `users`（別名 u）/);
});

test('update-delete-join-basis: JOINのない単純なUPDATEでは出さない', () => {
  const s = firstStatement('UPDATE users SET flg = 1 WHERE id = 1;', 'mysql');
  assert.ok(!hasCode(s.findings, 'update-delete-join-basis'));
});

// ---------------------------------------------------------------------------
// v2: 既存ルールのAST版（誤検知が減っていること）
// ---------------------------------------------------------------------------

test('AST版: WHEREなしUPDATE/DELETEを従来と同じcodeで検出する', () => {
  assert.ok(hasCode(firstStatement('UPDATE users SET flg = 1;', 'mysql').findings, 'no-where-update'));
  assert.ok(hasCode(firstStatement('DELETE FROM users;', 'mysql').findings, 'no-where-delete'));
});

test('AST版: 常に真のWHERE句を検出し、AND付きでは誤検知しない', () => {
  assert.ok(hasCode(firstStatement('UPDATE users SET flg = 1 WHERE 1 = 1;', 'mysql').findings, 'always-true-where'));
  assert.ok(hasCode(firstStatement('DELETE FROM users WHERE id = 42 OR 1 = 1;', 'mysql').findings, 'always-true-where'));
  assert.ok(!hasCode(firstStatement('UPDATE users SET flg = 1 WHERE 1 = 1 AND id = 42;', 'mysql').findings, 'always-true-where'));
  assert.ok(!hasCode(firstStatement('UPDATE t SET x = 1 WHERE a = 1 AND (b = 2 OR 1 = 1);', 'mysql').findings, 'always-true-where'));
});

test('AST版: OR/AND混在の括弧漏れを検出し、括弧があれば出さない', () => {
  assert.ok(hasCode(firstStatement('UPDATE t SET x = 1 WHERE a = 1 OR b = 2 AND c = 3;', 'mysql').findings, 'or-no-parens'));
  assert.ok(!hasCode(firstStatement('UPDATE t SET x = 1 WHERE a = 1 OR (b = 2 AND c = 3);', 'mysql').findings, 'or-no-parens'));
});

test('AST版: 括弧を含む条件でもor-no-parensの判定を諦めない（正規表現版からの改善）', () => {
  // 正規表現版は括弧が1つでもあると判定を放棄していたため、この形は見逃していた
  const s = firstStatement('UPDATE t SET x = 1 WHERE (a = 1) OR b = 2 AND c = 3;', 'mysql');
  assert.ok(hasCode(s.findings, 'or-no-parens'));
  const legacy = firstStatement('UPDATE t SET x = 1 WHERE (a = 1) OR b = 2 AND c = 3;', 'generic');
  assert.ok(!hasCode(legacy.findings, 'or-no-parens'), '正規表現版の挙動（見逃し）が変わっています');
});

test('AST版: BETWEEN ... AND ... はor-no-parensの誤検知にならない', () => {
  const s = firstStatement('UPDATE t SET x = 1 WHERE a BETWEEN 1 AND 5 OR b = 2;', 'mysql');
  assert.ok(!hasCode(s.findings, 'or-no-parens'));
});

test('AST版: LIKE / 暗黙型変換 / 自己参照サブクエリを従来と同じcodeで検出する', () => {
  assert.ok(hasCode(firstStatement("UPDATE t SET x = 1 WHERE name LIKE '%foo';", 'mysql').findings, 'like-leading-wildcard'));
  assert.ok(!hasCode(firstStatement("UPDATE t SET x = 1 WHERE name LIKE 'foo%';", 'mysql').findings, 'like-leading-wildcard'));
  assert.ok(hasCode(firstStatement("UPDATE t SET x = 1 WHERE id = '123';", 'mysql').findings, 'implicit-conversion'));
  assert.ok(!hasCode(firstStatement('UPDATE t SET x = 1 WHERE id = 123;', 'mysql').findings, 'implicit-conversion'));
  assert.ok(hasCode(firstStatement('DELETE FROM orders WHERE id IN (SELECT id FROM orders);', 'mysql').findings, 'self-subquery-no-condition'));
  assert.ok(!hasCode(firstStatement('DELETE FROM orders WHERE id IN (SELECT id FROM orders WHERE status = 1);', 'mysql').findings, 'self-subquery-no-condition'));
});

test("AST版: 文字列リテラル内の 'WHERE' に釣られない（回帰確認）", () => {
  const s = firstStatement("UPDATE t SET note = 'no WHERE here';", 'mysql');
  assert.ok(hasCode(s.findings, 'no-where-update'));
});

// ---------------------------------------------------------------------------
// v2: AST基盤の検算SELECT生成
// ---------------------------------------------------------------------------

test('検算SELECT: T-SQLの UPDATE ... FROM ... JOIN からJOIN込みで生成される', () => {
  const s = firstStatement("UPDATE u SET u.flg = 1 FROM users u LEFT JOIN depts d ON u.dept_id = d.id WHERE d.code = 'A';", 'mssql');
  assert.equal(s.verifySelect, "SELECT COUNT(*) FROM users u LEFT JOIN depts d ON u.dept_id = d.id WHERE d.code = 'A';");
});

test('検算SELECT: MySQLのマルチテーブルUPDATEでもJOINが落ちない', () => {
  const s = firstStatement('UPDATE t1 LEFT JOIN t2 ON t1.id = t2.id SET t1.x = 1 WHERE t2.y = 2;', 'mysql');
  assert.equal(s.verifySelect, 'SELECT COUNT(*) FROM t1 LEFT JOIN t2 ON t1.id = t2.id WHERE t2.y = 2;');
});

test('検算SELECT: DELETE ... FROM ... JOIN でもJOINが落ちない', () => {
  const s = firstStatement('DELETE o FROM orders o JOIN customers c ON o.customer_id = c.id WHERE c.id = 3;', 'mysql');
  assert.equal(s.verifySelect, 'SELECT COUNT(*) FROM orders o JOIN customers c ON o.customer_id = c.id WHERE c.id = 3;');
});

test('検算SELECT: 単純なUPDATE/DELETEでは従来と同じ文字列のまま（回帰確認）', () => {
  assert.equal(firstStatement('UPDATE orders SET status = 1 WHERE id = 42;', 'mysql').verifySelect, 'SELECT COUNT(*) FROM orders WHERE id = 42;');
  assert.equal(firstStatement('DELETE FROM orders o WHERE o.id = 7;', 'mysql').verifySelect, 'SELECT COUNT(*) FROM orders o WHERE o.id = 7;');
  assert.equal(firstStatement('UPDATE orders SET status = 1;', 'mysql').verifySelect, 'SELECT COUNT(*) FROM orders;');
});

// ---------------------------------------------------------------------------
// v2: スクリプトモード（全体サマリ）
// ---------------------------------------------------------------------------

const SCRIPT_SQL = [
  'UPDATE a SET x = 1 WHERE id = 1;',
  'DELETE FROM b WHERE id = 2;',
  'UPDATE c SET y = 2;',
  'INSERT INTO d (a) VALUES (1);',
  'SELECT * FROM e;',
  "DELETE FROM f WHERE name LIKE '%x';",
].join('\n');

test('スクリプトモード: 5文以上で全体サマリが生成される', () => {
  const result = analyzeSQL(SCRIPT_SQL, 'mysql');
  assert.ok(result.overview, 'overview がありません');
  assert.equal(result.overview.total, 6);
  assert.equal(result.overview.counts.UPDATE, 2);
  assert.equal(result.overview.counts.DELETE, 2);
});

test('スクリプトモード: 4文以下では全体サマリを出さない', () => {
  const result = analyzeSQL('SELECT 1; SELECT 2; SELECT 3; SELECT 4;', 'mysql');
  assert.equal(result.overview, null);
});

test('スクリプトモード: 触るテーブルの一覧を集約する', () => {
  const result = analyzeSQL(SCRIPT_SQL, 'mysql');
  for (const t of ['a', 'b', 'c', 'd', 'e', 'f']) {
    assert.ok(result.overview.tables.includes(t), `${t} が一覧にありません`);
  }
});

test('スクリプトモード: 警告のある文の番号を列挙する', () => {
  const result = analyzeSQL(SCRIPT_SQL, 'mysql');
  assert.deepEqual(result.overview.warnedStatements, [3, 6]);
});

// ---------------------------------------------------------------------------
// v2: 同梱物・ドキュメント
// ---------------------------------------------------------------------------

test('index.htmlは同梱パーサとAST関連スクリプトをこの順で読み込む', () => {
  const html = readProjectFile('index.html');
  const order = [
    'js/vendor/node-sql-parser-mysql.js',
    'js/vendor/node-sql-parser-postgresql.js',
    'js/vendor/node-sql-parser-transactsql.js',
    'js/sql-ast.js',
    'js/summarizer.js',
    'js/ast-rules.js',
    'js/analyzer.js',
    'js/app.js',
  ];
  let prev = -1;
  for (const src of order) {
    const idx = html.indexOf(`<script src="${src}"></script>`);
    assert.ok(idx > prev, `${src} の <script> が無いか順序が誤っています`);
    prev = idx;
  }
});

test('index.htmlはCDNなど外部ホストのスクリプトを読み込まない', () => {
  const html = readProjectFile('index.html');
  assert.ok(!/<script[^>]+src="https?:/i.test(html));
  assert.ok(!/<script[^>]+src="\/\//i.test(html));
});

test('node-sql-parserのライセンス（Apache-2.0）が同梱されている', () => {
  const license = readProjectFile('js/vendor/LICENSE-node-sql-parser');
  assert.match(license, /Apache License/);
  assert.match(license, /Version 2\.0/);
});

test('同梱パーサの各ファイル冒頭にApache-2.0の表記がある', () => {
  for (const d of ['mysql', 'postgresql', 'transactsql']) {
    const head = readProjectFile(`js/vendor/node-sql-parser-${d}.js`).slice(0, 400);
    assert.match(head, /Apache-2\.0/, d);
  }
});

test('README.mdにv2の機能・方言ごとの解析レベル・Apache-2.0同梱が書かれている', () => {
  const readme = readProjectFile('README.md');
  assert.match(readme, /Apache-2\.0/);
  assert.match(readme, /node-sql-parser/);
  assert.match(readme, /left-join-where-cancellation/);
  assert.match(readme, /not-in-null-risk/);
  assert.match(readme, /簡易チェック/);
});

// ---------------------------------------------------------------------------
// 結果表示
// ---------------------------------------------------------------------------

console.log(`\n${passCount} passed, ${failCount} failed (total ${passCount + failCount})`);
if (failCount > 0) {
  for (const f of failures) {
    console.error(`\nFAIL: ${f.name}`);
    console.error(f.err && f.err.stack ? f.err.stack : f.err);
  }
  process.exitCode = 1;
} else {
  console.log('全テストがパスしました。');
}
