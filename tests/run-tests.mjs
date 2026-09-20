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
import '../js/i18n.js';
import '../js/vendor/node-sql-parser-mysql.js';
import '../js/vendor/node-sql-parser-postgresql.js';
import '../js/vendor/node-sql-parser-transactsql.js';
import '../js/sql-ast.js';
import '../js/summarizer.js';
import '../js/ast-rules.js';
import '../js/plsql-extract.js';
import '../js/analyzer.js';
import '../js/dialect-detect.js';
import '../js/dml-builder.js';
import '../js/templates.js';

const { analyzeSQL, splitStatements, _internal } = globalThis.SQLMeganeAnalyzer;
const PlsqlExtract = globalThis.SQLMeganePlsqlExtract;
const { summarize, summaryToLines } = globalThis.SQLMeganeSummarizer;
const { detectDialect } = globalThis.SQLMeganeDialectDetect;
const DmlBuilder = globalThis.SQLMeganeDmlBuilder;
const Templates = globalThis.SQLMeganeTemplates;

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

test('Oracle 方言の no-transaction は BEGIN ではなく自動開始と自動コミットの確認を案内する', () => {
  const single = analyzeSQL('DELETE FROM orders WHERE id = 1;', 'oracle');
  const f = findCode(single.statements[0].findings, 'no-transaction');
  assert.ok(f);
  assert.ok(f.message.includes('SET AUTOCOMMIT'), f.message);
  assert.ok(!f.message.includes('前にBEGIN'), f.message);
  const multi = analyzeSQL('DELETE FROM orders WHERE id = 1; DELETE FROM items WHERE id = 1;', 'oracle');
  const g = multi.globalFindings.find((x) => x.code === 'no-transaction');
  assert.ok(g);
  assert.ok(g.message.includes('SET AUTOCOMMIT'), g.message);
  const generic = analyzeSQL('DELETE FROM orders WHERE id = 1;', 'generic');
  assert.ok(findCode(generic.statements[0].findings, 'no-transaction').message.includes('BEGIN'));
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

test('index.htmlはCTAフォームを持たず、GitHub Discussions へのリンクをCTAとして持つ（2026-09-11 に Issue → Discussions/1 に変更）', () => {
  const html = readProjectFile('index.html');
  assert.ok(!/<form/.test(html), 'CTA用のformが残っています');
  assert.match(html, /<a class="btn btn-primary cta-issue-link" href="https:\/\/github\.com\/selene-nyx-ai\/sqlmegane\/discussions\/1" target="_blank" rel="noopener">/);
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

test('要約: UPDATEは対象テーブル（別名つき）・条件・SET句を一文にまとめる', () => {
  const s = firstStatement("UPDATE m_users u SET u.deleted_flg = 1 WHERE u.dept_cd = '10';", 'mysql');
  assert.ok(s.summary, '要約が生成されていません');
  assert.equal(s.summary.op, 'UPDATE');
  assert.equal(s.summary.headline, "`m_users`（別名 u）のうち、`u.dept_cd` が '10' と等しい行の `deleted_flg` を 1 に更新します");
});

test('要約: DELETEは対象テーブルと条件を一文にまとめる', () => {
  const s = firstStatement('DELETE FROM orders WHERE id = 7;', 'mysql');
  assert.equal(s.summary.op, 'DELETE');
  assert.equal(s.summary.headline, '`orders` のうち、`id` が 7 と等しい行を削除します');
});

test('要約: INSERTは追加先テーブルと列を述べる', () => {
  const s = firstStatement('INSERT INTO logs (a, b) VALUES (1, 2);', 'mysql');
  assert.equal(s.summary.op, 'INSERT');
  assert.equal(s.summary.headline, '`logs` の `a`、`b` に固定値を 1 行追加します');
  assert.match(summaryText(s), /指定している列: `a`、`b`/);
});

test('要約: SELECTは取得元・条件・取得列を一文にまとめる', () => {
  const s = firstStatement('SELECT id, name FROM users WHERE id = 1;', 'mysql');
  assert.equal(s.summary.op, 'SELECT');
  assert.equal(s.summary.headline, '`users` のうち、`id` が 1 と等しい行の `id`、`name` を取得します');
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
// v2: 見出しの一文統合要約
//
// 見出しの一文だけで「どの行に何が起きるか」が分かることを検証する。
// 詳細ブロック（JOIN説明・WHERE箇条書き）は従来どおり残っていることも併せて確認する。
// ---------------------------------------------------------------------------

function headline(sql, dialect) {
  const s = firstStatement(sql, dialect || 'mysql');
  assert.ok(s.summary, `要約が生成されていません: ${sql}`);
  return s.summary.headline;
}

test('見出し1: プロダクトオーナー指摘のSQL — JOIN・WHERE・SETがすべて一文に入る', () => {
  const h = headline('UPDATE users u LEFT JOIN orders o ON u.id = o.user_id SET u.flag = 1 WHERE o.total > 100;');
  // LEFT JOIN が WHERE で打ち消されている（NULL行は必ず落ちる）ので「一致する行がある」が正しい
  assert.equal(h, '`orders` に一致する行がある `users`（別名 u）のうち、`o.total` が 100 より大きい行の `flag` を 1 に更新します');
});

test('見出し1: INNER JOIN は「`X` に一致する行がある」を対象テーブルの前に織り込む', () => {
  assert.equal(
    headline('UPDATE a JOIN b ON a.id = b.aid SET a.x = 1 WHERE b.y > 2;'),
    '`b` に一致する行がある `a` のうち、`b.y` が 2 より大きい行の `x` を 1 に更新します'
  );
});

test('見出し1: WHEREで絞っていないLEFT JOINは「一致の有無にかかわらず」', () => {
  assert.equal(
    headline('SELECT u.id, u.name FROM users u LEFT JOIN orders o ON u.id = o.user_id;'),
    '`orders` との一致の有無にかかわらず `users`（別名 u）の全行の `u.id`、`u.name` を取得します'
  );
});

test('見出し1: LEFT JOIN + IS NULL のアンチジョインは「一致する行が無い」に畳み込む', () => {
  // IS NULL はJOIN要旨に吸収されるので、WHERE要旨としては重ねて書かない
  assert.equal(
    headline('DELETE u FROM users u LEFT JOIN orders o ON u.id = o.user_id WHERE o.id IS NULL;'),
    '`orders` に一致する行が無い `users`（別名 u）の行を削除します'
  );
});

test('見出し1: JOIN 2個は連結する', () => {
  assert.equal(
    headline('UPDATE a JOIN b ON a.id = b.aid JOIN c ON c.id = a.cid SET a.x = 1 WHERE b.y > 2;'),
    '`b` に一致する行があり、`c` に一致する行がある `a` のうち、`b.y` が 2 より大きい行の `x` を 1 に更新します'
  );
});

test('見出し1: JOIN 3個以上は「複数のテーブルと結合した」に要約し、詳細はJOINブロックに残す', () => {
  const sql = 'UPDATE a JOIN b ON a.id = b.aid JOIN c ON c.id = a.cid JOIN d ON d.id = a.did SET a.x = 1 WHERE b.y > 2;';
  const h = headline(sql);
  assert.match(h, /^複数のテーブルと結合した `a` のうち、/);
  assert.ok(!/`b` に一致する行がある/.test(h), '3個以上のJOINを一文に並べています');
  const s = firstStatement(sql, 'mysql');
  assert.equal(s.summary.blocks.filter((b) => b.type === 'join').length, 3, 'JOINの詳細ブロックが減っています');
});

test('見出し1: CROSS JOIN は総当たりであることを織り込み、「全行」とは言い切らない', () => {
  const h = headline('SELECT * FROM a CROSS JOIN b;');
  assert.equal(h, '`b` と総当たりで組み合わせた `a` の すべての列（*） を取得します');
  assert.ok(!/全行/.test(h), '結合で行が落ちうるのに「全行」と言い切っています');
});

test('見出し2: 葉が3個以下のANDは全部を一文に織り込む', () => {
  assert.equal(
    headline("UPDATE t SET x = 1 WHERE a = 1 AND b = '10';"),
    "`t` のうち、`a` が 1 と等しく、かつ `b` が '10' と等しい行の `x` を 1 に更新します"
  );
});

test('見出し2: 葉が3個のORも全部を一文に織り込む', () => {
  assert.equal(
    headline("UPDATE users SET flag = 1 WHERE dept = 'x' OR dept = 'y' OR dept = 'z';"),
    "`users` のうち、`dept` が 'x' と等しい、または `dept` が 'y' と等しい、または `dept` が 'z' と等しい行の `flag` を 1 に更新します"
  );
});

test('見出し2: 葉が4個以上のANDは2つだけ挙げて省略を明示する', () => {
  const h = headline('UPDATE t SET x = 1 WHERE a = 1 AND b = 2 AND c = 3 AND d = 4;');
  assert.equal(h, '`t` のうち、`a` が 1 と等しい、`b` が 2 と等しいなど、複数の条件をすべて満たす行の `x` を 1 に更新します');
  assert.ok(!/`c` が 3/.test(h), '省略するはずの条件まで書いています');
});

test('見出し2: 深い入れ子は浅い条件だけ挙げて省略を明示する', () => {
  assert.equal(
    headline('UPDATE t SET x = 1 WHERE (a = 1 OR b = 2) AND c = 3;'),
    '`t` のうち、`c` が 3 と等しいなど、複数の条件をすべて満たす行の `x` を 1 に更新します'
  );
});

test('見出し2: 4個以上でも詳細のWHERE箇条書きは従来どおり全条件を保つ（ルール6）', () => {
  const s = firstStatement('UPDATE t SET x = 1 WHERE a = 1 AND b = 2 AND c = 3 AND d = 4;', 'mysql');
  const text = summaryText(s);
  for (const col of ['`a`', '`b`', '`c`', '`d`']) assert.match(text, new RegExp(`${col} が`));
});

test('見出し3: WHERE無しのUPDATEは「全行」を強調表示つきで言い切る', () => {
  const s = firstStatement('UPDATE users SET flag = 1;', 'mysql');
  assert.equal(s.summary.headline, '`users` の全行の `flag` を 1 に更新します');
  const strong = s.summary.headlineParts.filter((p) => p.strong).map((p) => p.text);
  assert.deepEqual(strong, ['全行']);
});

test('見出し3: WHERE無しのDELETEも「全行」を強調表示する', () => {
  const s = firstStatement('DELETE FROM users;', 'mysql');
  assert.equal(s.summary.headline, '`users` の全行を削除します');
  assert.ok(s.summary.headlineParts.some((p) => p.strong && p.text === '全行'));
});

test('見出し3: 結合で行が落ちうる場合はWHERE無しでも「全行」と言わない', () => {
  const h = headline('UPDATE a JOIN b ON a.id = b.aid SET a.x = 1;');
  assert.equal(h, '`b` に一致する行がある `a` の `x` を 1 に更新します');
  assert.ok(!/全行/.test(h));
});

test('見出し4: SET句が1〜2列なら値まで織り込む', () => {
  assert.equal(
    headline("UPDATE t SET x = 1, y = 'a' WHERE id = 1;"),
    "`t` のうち、`id` が 1 と等しい行の `x` を 1 に、`y` を 'a' に更新します"
  );
});

test('見出し4: SET句が3列以上なら列数に丸める', () => {
  assert.equal(
    headline('UPDATE t SET a = 1, b = 2, c = 3 WHERE x = 1;'),
    '`t` のうち、`x` が 1 と等しい行の `a` など3列を更新します'
  );
});

test('見出し5: AND/OR混在で係り受けが曖昧になる場合は「かつ／または」を作らず省略形へ落とす', () => {
  // a = 1 OR b = 2 AND c = 3 は OR(a=1, AND(b=2, c=3))。
  // これを一列に「かつ／または」で並べると読み手が優先順位を取り違えるため、
  // トップレベルの関係（いずれか）だけを言い切って詳細は箇条書きに委ねる。
  const h = headline('UPDATE t SET x = 1 WHERE a = 1 OR b = 2 AND c = 3;');
  assert.equal(h, '`t` のうち、`a` が 1 と等しいなど、複数の条件のいずれかを満たす行の `x` を 1 に更新します');
  assert.ok(!/かつ/.test(h), 'AND/OR混在なのに「かつ」を含む一文を作っています');
});

test('見出し5: 一文にできない条件は嘘をつかず「（条件の詳細は下記）」に落とす', () => {
  const h = headline('UPDATE t SET x = 1 WHERE NOT (a = 1);');
  assert.equal(h, '`t` のうち、条件に一致する行の `x` を 1 に更新します（条件の詳細は下記）');
});

test('見出し5: 注意書き付きの条件は見出しでは注意書きを外し、詳細側には残す', () => {
  const s = firstStatement("DELETE FROM users WHERE name LIKE '%tanaka';", 'mysql');
  assert.equal(s.summary.headline, "`users` のうち、`name` がパターン '%tanaka' に一致する行を削除します");
  assert.match(summaryText(s), /先頭が % なので前方一致ではありません/);
});

test('見出し5: 括弧を外すと文でなくなる条件（常に真）は無理に織り込まない', () => {
  const h = headline('UPDATE t SET x = 1 WHERE 1 = 1;');
  assert.equal(h, '`t` のうち、条件に一致する行の `x` を 1 に更新します（条件の詳細は下記）');
});

test('見出し6: 一文を変えてもJOIN説明とWHERE箇条書きのブロックは残っている', () => {
  const s = firstStatement('UPDATE users u LEFT JOIN orders o ON u.id = o.user_id SET u.flag = 1 WHERE o.total > 100;', 'mysql');
  assert.ok(s.summary.blocks.some((b) => b.type === 'join' && /LEFT JOIN/.test(b.text)), 'JOIN説明ブロックがありません');
  assert.match(summaryText(s), /対象は `o\.total` が 100 より大きい行です。/);
});

test('見出し7: SELECTの取得列は3列まで並べ、4列以上は列数に丸める', () => {
  assert.equal(
    headline('SELECT id, name, age, addr, tel FROM users WHERE id = 1;'),
    '`users` のうち、`id` が 1 と等しい行の `id` など5列 を取得します'
  );
});

test('見出し7: GROUP BYがあるSELECTは列を並べず「集計した結果」と述べる', () => {
  assert.equal(
    headline('SELECT dept, COUNT(*) FROM users GROUP BY dept;'),
    '`users` の全行を集計した結果を取得します'
  );
});

test('見出し7: INSERT ... SELECT は件数が読めないことまで一文に含める', () => {
  assert.equal(
    headline('INSERT INTO logs SELECT * FROM staging;'),
    '`logs` に SELECT の結果をそのまま追加します（取得件数がそのまま追加件数になります）'
  );
});

test('見出し7: TRUNCATEも「全行」を強調表示する', () => {
  const s = firstStatement('TRUNCATE TABLE t;', 'mysql');
  assert.equal(s.summary.headline, '`t` の全行を即座に削除します（多くの環境で取り消せません）');
  assert.ok(s.summary.headlineParts.some((p) => p.strong && p.text === '全行'));
});

test('見出し7: DROPは定義ごと消えることを述べる', () => {
  assert.equal(headline('DROP TABLE t;'), '`t` を定義ごと削除します');
});

test('見出し: 書き換え対象が結合された側でも、INNER JOINなら向きを入れ替えて言い切れる', () => {
  assert.equal(
    headline('DELETE o FROM users u JOIN orders o ON u.id = o.user_id WHERE u.active = 0;'),
    '`users` に一致する行がある `orders`（別名 o）のうち、`u.active` が 0 と等しい行を削除します'
  );
});

test('見出し: 書き換え対象が外部結合された側のときは断定せず「複数のテーブルと結合した」に落とす', () => {
  const h = headline('DELETE o FROM users u RIGHT JOIN orders o ON u.id = o.user_id WHERE u.active = 1;');
  assert.equal(h, '複数のテーブルと結合した `orders`（別名 o）のうち、`u.active` が 1 と等しい行を削除します');
  assert.ok(!/一致する行が/.test(h), '向きが反転する外部結合で残る側を断定しています');
});

test('見出し: 連用形変換は conditionText が作る語尾だけを対象にし、想定外は null を返す', () => {
  const { toRenyo } = globalThis.SQLMeganeSummarizer._internal;
  assert.equal(toRenyo('`a` が 1 と等しい'), '`a` が 1 と等しく');
  assert.equal(toRenyo('`a` が NULL である'), '`a` が NULL であり');
  assert.equal(toRenyo('`a` が NULL でない'), '`a` が NULL でなく');
  assert.equal(toRenyo('サブクエリに該当する行が存在しない'), 'サブクエリに該当する行が存在せず');
  assert.equal(toRenyo('`a` がサブクエリの結果に含まれる'), '`a` がサブクエリの結果に含まれ');
  assert.equal(toRenyo('常に真'), null);
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

test('検算SELECT: T-SQLの UPDATE ... FROM ... JOIN からJOIN込みで生成される（JOIN注記コメント付き）', () => {
  const s = firstStatement("UPDATE u SET u.flg = 1 FROM users u LEFT JOIN depts d ON u.dept_id = d.id WHERE d.code = 'A';", 'mssql');
  assert.equal(
    s.verifySelect,
    "-- ※JOINを含むため結合行数です。1対多の結合では実際の更新行数より大きくなることがあります\n"
      + "SELECT COUNT(*) FROM users u LEFT JOIN depts d ON u.dept_id = d.id WHERE d.code = 'A';"
  );
  assert.equal(s.verifySelectHasJoin, true);
});

test('検算SELECT: MySQLのマルチテーブルUPDATEでもJOINが落ちない（JOIN注記コメント付き）', () => {
  const s = firstStatement('UPDATE t1 LEFT JOIN t2 ON t1.id = t2.id SET t1.x = 1 WHERE t2.y = 2;', 'mysql');
  assert.equal(
    s.verifySelect,
    "-- ※JOINを含むため結合行数です。1対多の結合では実際の更新行数より大きくなることがあります\n"
      + "SELECT COUNT(*) FROM t1 LEFT JOIN t2 ON t1.id = t2.id WHERE t2.y = 2;"
  );
  assert.equal(s.verifySelectHasJoin, true);
});

test('検算SELECT: DELETE ... FROM ... JOIN でもJOINが落ちない（JOIN注記コメント付き）', () => {
  const s = firstStatement('DELETE o FROM orders o JOIN customers c ON o.customer_id = c.id WHERE c.id = 3;', 'mysql');
  assert.equal(
    s.verifySelect,
    "-- ※JOINを含むため結合行数です。1対多の結合では実際の更新行数より大きくなることがあります\n"
      + "SELECT COUNT(*) FROM orders o JOIN customers c ON o.customer_id = c.id WHERE c.id = 3;"
  );
  assert.equal(s.verifySelectHasJoin, true);
});

test('検算SELECT: 単純なUPDATE/DELETEでは従来と同じ文字列のまま（回帰確認、JOIN注記も付かない）', () => {
  const s1 = firstStatement('UPDATE orders SET status = 1 WHERE id = 42;', 'mysql');
  assert.equal(s1.verifySelect, 'SELECT COUNT(*) FROM orders WHERE id = 42;');
  assert.equal(s1.verifySelectHasJoin, false);

  const s2 = firstStatement('DELETE FROM orders o WHERE o.id = 7;', 'mysql');
  assert.equal(s2.verifySelect, 'SELECT COUNT(*) FROM orders o WHERE o.id = 7;');
  assert.equal(s2.verifySelectHasJoin, false);

  const s3 = firstStatement('UPDATE orders SET status = 1;', 'mysql');
  assert.equal(s3.verifySelect, 'SELECT COUNT(*) FROM orders;');
  assert.equal(s3.verifySelectHasJoin, false);
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
// feature/ast-summary 別視点レビュー指摘（M1〜M3 + minor 1〜4）
// ---------------------------------------------------------------------------

// --- M1: 検算SELECTが1:N JOINで対象件数を過大に返す ---

test('M1: JOINを含む検算SELECTには「結合行数」注記コメントが付き、verifySelectHasJoinがtrueになる', () => {
  const s = firstStatement('UPDATE users u JOIN orders o ON u.id=o.user_id SET u.flag=1 WHERE o.total>100;', 'mysql');
  assert.equal(s.verifySelectHasJoin, true);
  assert.match(s.verifySelect, /^-- ※JOINを含むため結合行数です。1対多の結合では実際の更新行数より大きくなることがあります\n/);
  assert.match(s.verifySelect, /SELECT COUNT\(\*\) FROM users u JOIN orders o ON u\.id=o\.user_id WHERE o\.total>100;$/);
});

test('M1: JOINを含まない検算SELECTには注記が付かない（回帰確認）', () => {
  const s = firstStatement('UPDATE users SET flag=1 WHERE id=1;', 'mysql');
  assert.equal(s.verifySelectHasJoin, false);
  assert.ok(!/JOINを含むため/.test(s.verifySelect));
});

test('M1: app.jsはJOIN時の検算SELECTラベル・注記文言を持つ', () => {
  const appJs = readProjectFile('js/app.js');
  assert.match(appJs, /検算SELECT（実行前に対象件数を確認・JOINのため結合行数です）/);
  assert.match(appJs, /※JOINを含むため結合行数です。1対多の結合では実際の更新行数より大きくなることがあります。/);
});

// --- M2: 方言再挑戦（mysql）の見せ方が過剰 ---

test('M2: 選択方言(PostgreSQL)で構文エラーのSQLがmysql再挑戦でAST成功しても、選択方言での構文エラーをprimaryErrorとして保持する', () => {
  const s = firstStatement('UPDATE t SET x=1 WHERE id=1 LIMIT 1;', 'postgres');
  assert.equal(s.parse.mode, 'ast');
  assert.equal(s.parse.usedFallbackDialect, 'mysql');
  assert.ok(s.parse.primaryError, 'primaryError が設定されていません');
  assert.equal(typeof s.parse.primaryError.message, 'string');
  assert.equal(s.parse.primaryError.line, 1);
});

test('M2: primaryErrorの行番号も貼り付けたテキスト全体での行番号に変換される', () => {
  const sql = 'SELECT 1;\n\nUPDATE t SET x=1 WHERE id=1 LIMIT 1;';
  const result = analyzeSQL(sql, 'postgres');
  const updateStmt = result.statements.find((s) => s.kind === 'UPDATE');
  assert.equal(updateStmt.parse.usedFallbackDialect, 'mysql');
  assert.equal(updateStmt.parse.primaryError.globalLine, 3);
});

test('M2: 方言再挑戦が成功した文にはPostgreSQL固有tips（RETURNING）を出さない', () => {
  const s = firstStatement('UPDATE t SET x=1 WHERE id=1 LIMIT 1;', 'postgres');
  assert.ok(!hasCode(s.findings, 'postgres-returning-tip'));
});

test('M2: 通常どおりPostgreSQLでパースできた文には引き続きRETURNINGのtipsが出る（回帰確認）', () => {
  const s = firstStatement('UPDATE t SET x=1 WHERE id=1;', 'postgres');
  assert.ok(hasCode(s.findings, 'postgres-returning-tip'));
});

test('M2: app.jsは方言不一致を「参考」ではなく警告として表示する文言を持つ', () => {
  const appJs = readProjectFile('js/app.js');
  assert.match(appJs, /では構文エラーです/);
  assert.match(appJs, /このSQLは選択した方言では実行できない可能性があります/);
  assert.ok(!/text: '参考'/.test(appJs), '「参考」表記がまだ残っています');
});

// --- M3: 括弧で括られたANDグループが left-join-where-cancellation をすり抜ける ---

test('M3: 括弧で括られたANDグループの中の条件でもleft-join-where-cancellationを検出する', () => {
  const s = firstStatement(
    "DELETE u FROM users u LEFT JOIN orders o ON u.id = o.user_id WHERE (o.status = 'x' AND o.amount > 10) AND u.active = 1;",
    'mysql'
  );
  assert.ok(hasCode(s.findings, 'left-join-where-cancellation'));
});

test('M3: 括弧グループの中にORが混ざる場合は従来通り検出しない（誤検知しないことの確認）', () => {
  const s = firstStatement(
    "DELETE u FROM users u LEFT JOIN orders o ON u.id = o.user_id WHERE (o.status = 'x' OR o.id IS NULL) AND u.active = 1;",
    'mysql'
  );
  assert.ok(!hasCode(s.findings, 'left-join-where-cancellation'));
});

// --- minor 1: left-join-where-cancellation で IS NOT NULL を除外しない ---

test('minor1: WHERE o.id IS NOT NULL は外部結合の打ち消しとして検出される', () => {
  const s = firstStatement('DELETE u FROM users u LEFT JOIN orders o ON u.id = o.user_id WHERE o.id IS NOT NULL;', 'mysql');
  assert.ok(hasCode(s.findings, 'left-join-where-cancellation'));
});

test('minor1: WHERE o.id IS NULL は引き続き除外される（アンチジョインの意図的な書き方、回帰確認）', () => {
  const s = firstStatement('DELETE u FROM users u LEFT JOIN orders o ON u.id = o.user_id WHERE o.id IS NULL;', 'mysql');
  assert.ok(!hasCode(s.findings, 'left-join-where-cancellation'));
});

// --- minor 2: not-in-null-risk がリテラル列のNULL混入を検出しない ---

test('minor2: NOT IN (1, NULL, 3) のようなリテラル列のNULL混入をdangerで検出する', () => {
  const s = firstStatement('DELETE FROM users WHERE id NOT IN (1, NULL, 3);', 'mysql');
  assert.ok(hasCode(s.findings, 'not-in-null-risk'));
  assert.equal(findCode(s.findings, 'not-in-null-risk').severity, 'danger');
  assert.match(findCode(s.findings, 'not-in-null-risk').message, /NULLが含まれるため結果は常に空です/);
});

test('minor2: NULLを含まないリテラルのNOT INは引き続き検出しない（回帰確認）', () => {
  const s = firstStatement('DELETE FROM users WHERE id NOT IN (1, 2, 3);', 'mysql');
  assert.ok(!hasCode(s.findings, 'not-in-null-risk'));
});

test('minor2: サブクエリのNOT INは引き続きwarningのまま（回帰確認、リテラル版のdangerと混同しない）', () => {
  const s = firstStatement('DELETE FROM users WHERE id NOT IN (SELECT user_id FROM orders);', 'postgres');
  assert.ok(hasCode(s.findings, 'not-in-null-risk'));
  assert.equal(findCode(s.findings, 'not-in-null-risk').severity, 'warning');
});

test('minor2: 要約でもNOT INリストのNULL混入時に「結果は常に空です」と指摘する', () => {
  const s = firstStatement('UPDATE t SET x = 1 WHERE id NOT IN (1, NULL, 3);', 'mysql');
  assert.match(summaryText(s), /NULLが含まれるため結果は常に空です/);
});

// --- minor 3: mysql-no-limit がMySQLの複数テーブルDELETEにも発火してしまう ---

test('minor3: MySQLの複数テーブルDELETE（DELETE a FROM a JOIN b ...）ではmysql-no-limitを出さない', () => {
  const s = firstStatement('DELETE a FROM a JOIN b ON a.id = b.id WHERE b.y > 2;', 'mysql');
  assert.ok(!hasCode(s.findings, 'mysql-no-limit'));
});

test('minor3: MySQLの単一テーブルDELETEでは引き続きmysql-no-limitが出る（回帰確認）', () => {
  const s = firstStatement('DELETE FROM a WHERE id > 100;', 'mysql');
  assert.ok(hasCode(s.findings, 'mysql-no-limit'));
});

test('minor3: 内部関数isMysqlMultiTableDeleteはJOIN・カンマ複数テーブルDELETEを検出する（正規表現フォールバック経路向け）', () => {
  const { masked: m1 } = _internal.scan('DELETE a FROM a JOIN b ON a.id=b.id WHERE b.y>2', 'mysql');
  assert.equal(_internal.isMysqlMultiTableDelete(m1), true);

  const { masked: m2 } = _internal.scan('DELETE FROM a, b USING a JOIN b ON a.id=b.id WHERE b.y>2', 'mysql');
  assert.equal(_internal.isMysqlMultiTableDelete(m2), true);

  const { masked: m3 } = _internal.scan('DELETE FROM a WHERE id=1', 'mysql');
  assert.equal(_internal.isMysqlMultiTableDelete(m3), false);
});

// --- minor 4: RIGHT JOINのNULL側を削除対象にしたケースの文言（「OUTER JOIN した」表記）改善 ---

test('minor4: RIGHT JOINでNULL埋めされる側の打ち消しは「RIGHT JOIN した」と正しく表記される（「OUTER JOIN した」にならない）', () => {
  const s = firstStatement('DELETE o FROM users u RIGHT JOIN orders o ON u.id = o.user_id WHERE u.active = 1;', 'mysql');
  const f = findCode(s.findings, 'left-join-where-cancellation');
  assert.ok(f);
  assert.match(f.message, /RIGHT JOIN した/);
  assert.ok(!/OUTER JOIN した/.test(f.message), 'joinKind不明時のフォールバック表記「OUTER JOIN した」のままです');
});

test('minor4: LEFT JOINの通常ケースでは引き続き「LEFT JOIN した」と表記される（回帰確認）', () => {
  const s = firstStatement("UPDATE u SET u.flg = 1 FROM users u LEFT JOIN depts d ON u.dept_id = d.id WHERE d.code = 'A';", 'mssql');
  const f = findCode(s.findings, 'left-join-where-cancellation');
  assert.ok(f);
  assert.match(f.message, /LEFT JOIN した/);
});

// ---------------------------------------------------------------------------
// ペルソナテスト指摘の修正（P1: 解析不能文の沈黙素通り対策）
// ---------------------------------------------------------------------------

test('P1-1: MERGE文はfindingsが空にならず、unanalyzed-statement警告が必ず付く', () => {
  const s = firstStatement('MERGE INTO tgt t USING src s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET t.val = s.val;', 'oracle');
  assert.equal(s.kind, 'MERGE');
  assert.ok(s.findings.length > 0, 'findingsが空のまま（沈黙素通り）です');
  const f = findCode(s.findings, 'unanalyzed-statement');
  assert.ok(f);
  assert.equal(f.severity, 'warning');
  assert.match(f.message, /MERGE文の解析は未対応/);
});

test('P1-1: kind=OTHERで破壊的キーワード（EXEC）を含む文はunanalyzed-statement警告が付く', () => {
  const s = firstStatement('EXEC sp_do_something @id = 1;', 'mssql');
  assert.equal(s.kind, 'OTHER');
  const f = findCode(s.findings, 'unanalyzed-statement');
  assert.ok(f, 'EXEC文が沈黙で素通りしています');
  assert.equal(f.severity, 'warning');
});

test('P1-1: kind=OTHERでも破壊的キーワードを含まない文にはunanalyzed-statement警告を出さない（過剰検出しない）', () => {
  const s = firstStatement('SHOW TABLES;', 'mysql');
  assert.equal(s.kind, 'OTHER');
  assert.ok(!hasCode(s.findings, 'unanalyzed-statement'));
});

// ---------------------------------------------------------------------------
// P1-2: Oracle更新可能結合ビュー（インラインビューUPDATE）の誤検知修正
// ---------------------------------------------------------------------------

test('P1-2: インラインビューUPDATEで外側WHEREが無くても、インラインビュー自身にWHEREがあればno-where-updateを誤爆しない', () => {
  const s = firstStatement('UPDATE (SELECT a, b FROM t WHERE x = 1) v SET a = 10;', 'oracle');
  assert.ok(!hasCode(s.findings, 'no-where-update'), 'インラインビューのWHEREを無視してdanger誤爆しています');
  const f = findCode(s.findings, 'unanalyzed-statement');
  assert.ok(f, 'インラインビューUPDATEは対象外である旨の警告が必要です');
  assert.equal(f.severity, 'warning');
  assert.match(f.message, /インラインビュー|更新可能結合ビュー/);
});

test('P1-2: インラインビューUPDATEでも外側にWHEREがあれば通常のUPDATEとして扱う（回帰確認）', () => {
  const s = firstStatement('UPDATE (SELECT a, b FROM t WHERE x = 1) v SET a = 10 WHERE b = 2;', 'oracle');
  assert.ok(!hasCode(s.findings, 'no-where-update'));
  assert.ok(!hasCode(s.findings, 'unanalyzed-statement'), '外側にWHEREがある通常ケースまでunanalyzed扱いにしないこと');
});

test('P1-2: インラインビューUPDATEで内外どちらにもWHEREが無ければ、従来通りno-where-update dangerを出す', () => {
  const s = firstStatement('UPDATE (SELECT a, b FROM t) v SET a = 10;', 'oracle');
  const f = findCode(s.findings, 'no-where-update');
  assert.ok(f, '本当に絞り込みが無いケースまでunanalyzedに倒して危険を隠さないこと');
  assert.equal(f.severity, 'danger');
});

// ---------------------------------------------------------------------------
// P1-3: PL/SQL/T-SQL無名ブロックの分解事故修正
//
// Oracle対応 Phase 1 で kind は PLSQL_BLOCK → PLSQL_UNIT に変わり、
// 「丸ごと解析対象外」から「中のDMLを抽出して個別チェック」に格上げされた。
// ここでは分解事故（中身がセミコロン分割されて誤判定される）が再発していない
// ことと、抽出したDMLに従来の危険検出が効いていることの両方を確認する。
// ---------------------------------------------------------------------------

test('P1-3: BEGIN〜END;/ の無名ブロックはセミコロン分割されず1文として扱われる', () => {
  const sql = 'BEGIN\n  UPDATE emp SET sal = sal * 1.1;\n  COMMIT;\nEND;\n/';
  const result = analyzeSQL(sql, 'oracle');
  assert.equal(result.statements.length, 1, 'ブロックが複数文に分割されてしまっています');
  assert.equal(result.statements[0].kind, 'PLSQL_UNIT');
});

test('P1-3: PL/SQLブロック内のWHERE漏れUPDATEが無警告で素通りしない（抽出して危険検出する）', () => {
  const sql = 'BEGIN\n  UPDATE emp SET sal = sal * 1.1;\n  COMMIT;\nEND;\n/';
  const s = firstStatement(sql, 'oracle');
  // v2 では kind=BEGIN_TX に誤判定され、中のUPDATEのWHERE漏れは一切チェックされず
  // findingsが空のまま静かに通っていた。Phase 1 では中のUPDATEを抽出して
  // no-where-update を出す（＝「解析対象外」で逃げない）。
  assert.ok(s.plsql, 'PL/SQLユニットとして解析されていません');
  assert.equal(s.plsql.items.length, 1);
  assert.ok(hasCode(s.plsql.items[0].findings, 'no-where-update'));
  assert.equal(findCode(s.plsql.items[0].findings, 'no-where-update').severity, 'danger');
});

test('P1-3: DECLARE で始まるPL/SQLブロックも同様に1文として扱われ、中のDELETEが抽出される', () => {
  const sql = 'DECLARE\n  v_count NUMBER;\nBEGIN\n  DELETE FROM emp;\nEND;\n/';
  const result = analyzeSQL(sql, 'oracle');
  assert.equal(result.statements.length, 1);
  assert.equal(result.statements[0].kind, 'PLSQL_UNIT');
  const items = result.statements[0].plsql.items;
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'DELETE');
  assert.ok(hasCode(items[0].findings, 'no-where-delete'));
});

test('P1-3: 通常のBEGIN TRAN 〜 COMMIT（T-SQLの複数文スクリプト）はブロック扱いにせず、従来通り分割される（誤検知しない）', () => {
  const sql = 'BEGIN TRAN\nUPDATE a SET x = 1 WHERE id = 1;\nCOMMIT\n';
  const result = analyzeSQL(sql, 'mssql');
  assert.ok(result.statements.length >= 2, 'BEGIN TRANスクリプトを誤ってPL/SQLブロック扱いにしています');
  assert.ok(result.statements.every((s) => s.kind !== 'PLSQL_UNIT'));
});

// ---------------------------------------------------------------------------
// P2-4: implicit-conversion のノイズ疲れ対策（info格下げ・集約）
// ---------------------------------------------------------------------------

test('P2-4: implicit-conversionはseverityがinfoに格下げされている', () => {
  const s = firstStatement("UPDATE t SET x=1 WHERE id = '123';", 'mysql');
  const f = findCode(s.findings, 'implicit-conversion');
  assert.ok(f);
  assert.equal(f.severity, 'info');
});

test('P2-4: 同一文内に複数箇所あっても1つのfindingに集約され、件数が明示される', () => {
  const s = firstStatement("UPDATE t SET x=1 WHERE dept_cd = '10' AND cost_cd = '20' AND flag_cd = '30';", 'mysql');
  const matches = s.findings.filter((f) => f.code === 'implicit-conversion');
  assert.equal(matches.length, 1, '複数のfindingに分かれてしまっています');
  assert.match(matches[0].message, /3箇所/);
});

test('P2-4: メッセージに文字コード列（ゼロ埋めコード等）への言及が含まれる', () => {
  const s = firstStatement("UPDATE t SET x=1 WHERE id = '123';", 'mysql');
  const f = findCode(s.findings, 'implicit-conversion');
  assert.match(f.message, /文字コード列/);
  assert.match(f.message, /ゼロ埋め/);
});

test('P2-4: AST版（PostgreSQL）でもseverityがinfoに格下げ・集約される', () => {
  const s = firstStatement("UPDATE t SET x=1 WHERE dept_cd = '10' AND cost_cd = '20';", 'postgres');
  const matches = s.findings.filter((f) => f.code === 'implicit-conversion');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].severity, 'info');
  assert.match(matches[0].message, /2箇所/);
});

// ---------------------------------------------------------------------------
// P2-5: no-transaction のノイズ疲れ対策（複数文貼り付け時の集約）
// ---------------------------------------------------------------------------

test('P2-5: 複数文貼り付け時、no-transactionは文ごとに出さずglobalFindingsに1回だけ集約される', () => {
  const sql = 'UPDATE a SET x=1 WHERE id=1;\nDELETE FROM b WHERE id=2;\nUPDATE c SET y=2 WHERE id=3;';
  const result = analyzeSQL(sql, 'generic');
  for (const s of result.statements) {
    assert.ok(!hasCode(s.findings, 'no-transaction'), `文${s.number}に個別のno-transactionが残っています`);
  }
  const g = result.globalFindings.find((f) => f.code === 'no-transaction');
  assert.ok(g, 'globalFindingsに集約されたno-transactionがありません');
  assert.equal(g.severity, 'info');
  assert.match(g.message, /3件/);
  assert.match(g.message, /#1/);
  assert.match(g.message, /#2/);
  assert.match(g.message, /#3/);
});

test('P2-5: 単文貼り付け時はno-transactionが従来通りその文自身に付く（回帰確認）', () => {
  const result = analyzeSQL('DELETE FROM orders WHERE id = 1;', 'generic');
  assert.equal(result.statements.length, 1);
  assert.ok(hasCode(result.statements[0].findings, 'no-transaction'));
  assert.ok(!result.globalFindings.some((f) => f.code === 'no-transaction'));
});

test('P2-5: 複数文でもBEGIN〜COMMITで保護されている文は集約対象に含まれない', () => {
  const sql = 'BEGIN;\nDELETE FROM orders WHERE id = 1;\nCOMMIT;\nDELETE FROM logs WHERE id = 2;';
  const result = analyzeSQL(sql, 'generic');
  const g = result.globalFindings.find((f) => f.code === 'no-transaction');
  assert.ok(g);
  assert.match(g.message, /1件/);
  assert.match(g.message, /#4/);
  assert.ok(!/#2/.test(g.message));
});

// ---------------------------------------------------------------------------
// スクリプトモード: 未解析の文の一覧（overview.unanalyzedStatements）
// ---------------------------------------------------------------------------

test('overview.unanalyzedStatementsにMERGE文・PL/SQLブロックの番号が列挙される', () => {
  const sql = [
    'UPDATE a SET x = 1 WHERE id = 1;',
    'DELETE FROM b WHERE id = 2;',
    'MERGE INTO c cc USING d dd ON (cc.id = dd.id) WHEN MATCHED THEN UPDATE SET cc.v = dd.v;',
    'INSERT INTO e (a) VALUES (1);',
    'SELECT * FROM f;',
  ].join('\n');
  const result = analyzeSQL(sql, 'oracle');
  assert.ok(result.overview, 'overviewがありません');
  assert.deepEqual(result.overview.unanalyzedStatements, [3]);
});

// ---------------------------------------------------------------------------
// Oracle対応 Phase 1: PL/SQL構造認識と埋め込みDML抽出
// ---------------------------------------------------------------------------

// 受け入れ用サンプル。実務でよくある形のPL/SQLパッケージ（tests/fixtures/plsql-package.sql）と、
// 抽出境界を突くための合成サンプル（q'記法・文字列内セミコロン等）。
const REAL_SAMPLE = readProjectFile('tests/fixtures/plsql-package.sql');
const EDGE_SAMPLE = readProjectFile('tests/fixtures/plsql-package-edgecases.sql');

function plsqlUnit(sql, dialect) {
  const result = analyzeSQL(sql, dialect || 'oracle');
  return result.statements.find((s) => s.kind === 'PLSQL_UNIT');
}

function itemKinds(unit) {
  return unit.plsql.items.map((i) => i.kind);
}

// --- 構造認識 -------------------------------------------------------------

test('Phase1: CREATE OR REPLACE PACKAGE BODY がPL/SQLユニットとして認識される', () => {
  const sql = 'CREATE OR REPLACE PACKAGE BODY pkg_x AS\n'
    + '  PROCEDURE p1 IS\n  BEGIN\n    UPDATE t SET a = 1 WHERE id = 1;\n  END p1;\n'
    + 'END pkg_x;\n/';
  const u = plsqlUnit(sql);
  assert.ok(u, 'PL/SQLユニットとして認識されていません');
  assert.equal(u.plsql.unitKind, 'PACKAGE BODY');
  assert.equal(u.plsql.unitName, 'pkg_x');
  assert.equal(u.plsql.header, 'PACKAGE BODY pkg_x');
});

test('Phase1: 仕様部と本体が `/` 区切りで並んでいると、2つのPL/SQLユニットに分かれる', () => {
  const sql = 'CREATE OR REPLACE PACKAGE pkg_x AS\n  PROCEDURE p1;\nEND pkg_x;\n/\n'
    + 'CREATE OR REPLACE PACKAGE BODY pkg_x AS\n  PROCEDURE p1 IS\n  BEGIN\n'
    + '    DELETE FROM t WHERE id = 1;\n  END p1;\nEND pkg_x;\n/\n';
  const result = analyzeSQL(sql, 'oracle');
  assert.equal(result.statements.length, 2, 'v2は先頭の1ブロックしか見ていなかった（複数ユニット対応の回帰）');
  assert.ok(result.statements.every((s) => s.kind === 'PLSQL_UNIT'));
  assert.equal(result.statements[0].plsql.unitKind, 'PACKAGE');
  assert.equal(result.statements[1].plsql.unitKind, 'PACKAGE BODY');
});

test('Phase1: ユニット先頭にコメント行があってもPL/SQLユニットとして認識される', () => {
  const sql = '-- 1. パッケージ仕様部\nCREATE OR REPLACE PACKAGE pkg_x AS\n  PROCEDURE p1;\nEND pkg_x;\n/';
  const u = plsqlUnit(sql);
  assert.ok(u);
  assert.equal(u.plsql.unitKind, 'PACKAGE');
});

test('Phase1: 構造サマリにプロシージャ数・DML本数・カーソル数・COMMIT/ROLLBACKが出る', () => {
  const sql = 'CREATE OR REPLACE PACKAGE BODY pkg_x AS\n'
    + '  CURSOR c1 IS SELECT id FROM t WHERE a = 1;\n'
    + '  PROCEDURE p1 IS\n  BEGIN\n    INSERT INTO logs (m) VALUES (1);\n    COMMIT;\n  END p1;\n'
    + '  PROCEDURE p2 IS\n  BEGIN\n    UPDATE t SET a = 2 WHERE id = 1;\n  EXCEPTION WHEN OTHERS THEN ROLLBACK;\n  END p2;\n'
    + 'END pkg_x;\n/';
  const u = plsqlUnit(sql);
  assert.equal(u.plsql.procedureCount, 2);
  assert.equal(u.plsql.cursorCount, 1);
  assert.ok(u.plsql.hasCommit);
  assert.ok(u.plsql.hasRollback);
  assert.match(u.plsql.structure, /プロシージャ2個/);
  assert.match(u.plsql.structure, /UPDATE 1本/);
  assert.match(u.plsql.structure, /INSERT 1本/);
  assert.match(u.plsql.structure, /カーソル1個/);
  assert.match(u.plsql.structure, /COMMITあり・ROLLBACKあり/);
});

test('Phase1: 制御フローを解析していないことを必ず info で明示する（danger縁取りにはしない）', () => {
  const sql = 'BEGIN\n  UPDATE t SET a = 1 WHERE id = 1;\nEND;\n/';
  const u = plsqlUnit(sql);
  const f = findCode(u.findings, 'plsql-control-flow');
  assert.ok(f, '制御フロー未解析の注記がありません');
  assert.equal(f.severity, 'info');
  assert.match(f.message, /制御フロー/);
  assert.ok(!hasCode(u.findings, 'unanalyzed-statement'), 'DMLを抽出できたユニットは未解析扱いにしない');
});

// --- 抽出境界 -------------------------------------------------------------

test('Phase1: 文字列リテラル内のセミコロンでDMLが切れない', () => {
  const sql = "BEGIN\n  UPDATE t SET note = 'a;b;c' WHERE id = 1;\nEND;\n/";
  const u = plsqlUnit(sql);
  assert.equal(u.plsql.items.length, 1);
  assert.match(u.plsql.items[0].sql, /WHERE id = 1$/);
  assert.equal(u.plsql.items[0].findings.length, 0, 'WHERE句があるので危険は出ないはず');
});

test('Phase1: コメント内の BEGIN / END; / DML は構造にもDML抽出にも影響しない', () => {
  const sql = 'BEGIN\n'
    + '  -- ここに DELETE FROM t; と書いてあるがコメント\n'
    + '  /* BEGIN\n     UPDATE t SET a = 1;\n     END; */\n'
    + '  UPDATE t SET a = 1 WHERE id = 1;\nEND;\n/';
  const u = plsqlUnit(sql);
  assert.deepEqual(itemKinds(u), ['UPDATE']);
});

test('Phase1: ネストしたBEGIN/ENDブロックの中のDMLも抽出される', () => {
  const sql = 'BEGIN\n  LOOP\n    BEGIN\n      UPDATE t SET a = 1 WHERE id = 1;\n'
    + '    EXCEPTION WHEN OTHERS THEN\n      INSERT INTO err (m) VALUES (1);\n    END;\n'
    + '  END LOOP;\nEND;\n/';
  const u = plsqlUnit(sql);
  assert.deepEqual(itemKinds(u), ['UPDATE', 'INSERT']);
});

test('Phase1: q\'記法の中のセミコロン・クォートで構造解析が壊れない', () => {
  const sql = 'DECLARE\n'
    + "  v VARCHAR2(100) := q'[status='X'; DELETE FROM t]';\n"
    + 'BEGIN\n  UPDATE t SET a = 1 WHERE id = 1;\nEND;\n/';
  const u = plsqlUnit(sql);
  assert.deepEqual(itemKinds(u), ['UPDATE'], "q'記法の中のDELETEを拾ってしまっています");
});

test('Phase1: SELECT ... FOR UPDATE の UPDATE を別の文として切り出さない', () => {
  const sql = 'BEGIN\n  SELECT a INTO v FROM t WHERE id = 1 FOR UPDATE;\nEND;\n/';
  const u = plsqlUnit(sql);
  assert.equal(u.plsql.items.length, 1);
  assert.equal(u.plsql.items[0].label, 'SELECT INTO');
});

test('Phase1: FORALL + SAVE EXCEPTIONS のUPDATEが抽出される（キーワードとDMLの間に語が挟まる形）', () => {
  const sql = 'BEGIN\n'
    + '  FORALL i IN 1..v_orders.COUNT SAVE EXCEPTIONS\n'
    + '    UPDATE orders SET status = 1 WHERE order_id = v_orders(i).order_id;\n'
    + 'END;\n/';
  const u = plsqlUnit(sql);
  assert.deepEqual(itemKinds(u), ['UPDATE']);
});

test('Phase1: CURSOR宣言のSELECTは「カーソル定義」として抽出される', () => {
  const sql = 'DECLARE\n  CURSOR c_pending IS SELECT id FROM orders WHERE status = 1;\n'
    + 'BEGIN\n  NULL;\nEND;\n/';
  const u = plsqlUnit(sql);
  assert.equal(u.plsql.items.length, 1);
  assert.equal(u.plsql.items[0].kind, 'CURSOR');
  assert.equal(u.plsql.items[0].cursorName, 'c_pending');
  assert.match(u.plsql.items[0].sql, /^SELECT id FROM orders/);
});

// --- バインド変数・条件判定 ------------------------------------------------

test('Phase1: WHERE句がPL/SQL変数でも「条件あり」と判定され、no-where-updateは出ない', () => {
  const sql = 'BEGIN\n  UPDATE orders SET status = 1 WHERE order_id = v_orders(i).order_id;\nEND;\n/';
  const u = plsqlUnit(sql);
  const item = u.plsql.items[0];
  assert.ok(!hasCode(item.findings, 'no-where-update'), '変数条件を「WHERE無し」と誤判定しています');
  assert.equal(item.verifySelect, 'SELECT COUNT(*) FROM orders WHERE order_id = v_orders(i).order_id;');
  assert.ok(item.verifySelectHasRuntimeVariable, '実行時変数が残っていることを示すフラグが立っていません');
});

test('Phase1: 抽出DMLにWHERE漏れがあると no-where-update が発火する', () => {
  const sql = 'CREATE OR REPLACE PACKAGE BODY pkg_x AS\n'
    + '  PROCEDURE p1 IS\n  BEGIN\n'
    + "    UPDATE orders SET status = 'PROCESSED', processed_at = SYSDATE;\n"
    + '  END p1;\nEND pkg_x;\n/';
  const u = plsqlUnit(sql);
  const item = u.plsql.items[0];
  const f = findCode(item.findings, 'no-where-update');
  assert.ok(f, 'PL/SQL内部のWHERE漏れUPDATEが検出できていません');
  assert.equal(f.severity, 'danger');
});

test('Phase1: 抽出DMLにWHERE漏れDELETEがあると no-where-delete が発火する', () => {
  const sql = 'BEGIN\n  DELETE FROM orders;\nEND;\n/';
  const u = plsqlUnit(sql);
  assert.ok(hasCode(u.plsql.items[0].findings, 'no-where-delete'));
});

test('Phase1: 抽出DMLの OR 1=1 も always-true-where で検出される', () => {
  const sql = 'BEGIN\n  UPDATE orders SET status = 1 WHERE order_id = 7 OR 1=1;\nEND;\n/';
  const u = plsqlUnit(sql);
  assert.ok(hasCode(u.plsql.items[0].findings, 'always-true-where'));
});

test("Phase1: 抽出DMLの LIKE '%...' も like-leading-wildcard で検出される", () => {
  const sql = "BEGIN\n  DELETE FROM orders WHERE code LIKE '%X';\nEND;\n/";
  const u = plsqlUnit(sql);
  assert.ok(hasCode(u.plsql.items[0].findings, 'like-leading-wildcard'));
});

// --- 常に真のWHERE句: カーソル定義とSELECT文（プロダクトオーナー指摘の穴埋め） -------

test('カーソル定義のWHERE 1=1はwarningで検出される（AST経路・mysql方言のパーサでカーソルSELECTをパース）', () => {
  const sql = 'CREATE OR REPLACE PACKAGE BODY pkg_x AS\n'
    + '  PROCEDURE p1 IS\n'
    + '    CURSOR c_orders IS SELECT order_id FROM orders WHERE 1=1;\n'
    + '  BEGIN\n    NULL;\n  END p1;\nEND pkg_x;\n/';
  const u = plsqlUnit(sql, 'oracle');
  const item = u.plsql.items[0];
  assert.equal(item.kind, 'CURSOR');
  const f = findCode(item.findings, 'always-true-where');
  assert.ok(f, 'カーソルのWHERE 1=1が検出されていません');
  assert.equal(f.severity, 'warning');
  assert.match(f.message, /カーソル/);
});

test('実機再現ケース: plsql-sample-real.sql のカーソルWHEREを1=1に変えるとwarningが出る', () => {
  // サンプルファイルは別リポジトリ（AutoClaude/business/）にある実データのため、
  // sqlmegane側には存在しない場合スキップする（CI等で当該パスが無い環境を想定）。
  const samplePath = 'D:\\GitHub\\AutoClaude\\business\\plsql-sample-real.sql';
  if (!fs.existsSync(samplePath)) return;
  const sql = fs.readFileSync(samplePath, 'utf8')
    .replace("WHERE status = 'PENDING'", 'WHERE 1=1');
  const result = analyzeSQL(sql, 'oracle');
  const unit = result.statements.find((s) => s.plsql && s.plsql.items.some((i) => i.cursorName === 'c_orders'));
  assert.ok(unit, 'c_ordersカーソルを含むユニットが見つかりません');
  const item = unit.plsql.items.find((i) => i.cursorName === 'c_orders');
  assert.equal(item.kind, 'CURSOR');
  const f = findCode(item.findings, 'always-true-where');
  assert.ok(f, '改変後のカーソルでwarningが検出されていません');
  assert.equal(f.severity, 'warning');
  assert.ok(!hasCode(item.findings, 'no-where-update') && !hasCode(item.findings, 'no-where-delete'));
});

test('FORループのカーソルSELECTのWHERE 1=1もwarningで検出される', () => {
  const sql = 'BEGIN\n  FOR r IN (SELECT id FROM t WHERE 1=1) LOOP\n    NULL;\n  END LOOP;\nEND;\n/';
  const u = plsqlUnit(sql);
  const item = u.plsql.items.find((i) => i.kind === 'CURSOR');
  assert.ok(item, 'FORループのカーソルが抽出されていません');
  const f = findCode(item.findings, 'always-true-where');
  assert.ok(f);
  assert.equal(f.severity, 'warning');
});

test('WHERE句のないカーソル定義はinfoで「無条件で全行取得」を明示する', () => {
  const sql = 'CREATE OR REPLACE PACKAGE BODY pkg_x AS\n'
    + '  PROCEDURE p1 IS\n'
    + '    CURSOR c_all IS SELECT id FROM t;\n'
    + '  BEGIN\n    NULL;\n  END p1;\nEND pkg_x;\n/';
  const u = plsqlUnit(sql, 'oracle');
  const item = u.plsql.items[0];
  const f = findCode(item.findings, 'cursor-no-where');
  assert.ok(f, 'WHERE句なしカーソルのinfoが出ていません');
  assert.equal(f.severity, 'info');
});

test('絞り込み条件のある通常のカーソル定義は危険を検出しない（従来通り）', () => {
  const sql = 'CREATE OR REPLACE PACKAGE BODY pkg_x AS\n'
    + '  PROCEDURE p1 IS\n'
    + "    CURSOR c_orders IS SELECT id FROM orders WHERE status = 'PENDING';\n"
    + '  BEGIN\n    NULL;\n  END p1;\nEND pkg_x;\n/';
  const u = plsqlUnit(sql, 'oracle');
  assert.equal(u.plsql.items[0].findings.length, 0);
});

test('通常のSELECT文のWHERE 1=1はinfoで検出される（mysql方言・AST経路）', () => {
  const s = firstStatement('SELECT * FROM t WHERE 1=1;', 'mysql');
  assert.equal(s.kind, 'SELECT');
  const f = findCode(s.findings, 'always-true-where');
  assert.ok(f);
  assert.equal(f.severity, 'info');
  assert.match(f.message, /動的SQL/);
});

test('通常のSELECT文のWHERE 1=1はinfoで検出される（oracle方言・regex経路）', () => {
  const s = firstStatement('SELECT * FROM t WHERE 1=1;', 'oracle');
  assert.equal(s.kind, 'SELECT');
  assert.equal(s.parse.mode, 'regex-only');
  const f = findCode(s.findings, 'always-true-where');
  assert.ok(f);
  assert.equal(f.severity, 'info');
});

test('通常のSELECT文でWHERE句が無くてもcursor-no-whereは出ない（カーソル以外は対象外）', () => {
  const s = firstStatement('SELECT * FROM t;', 'mysql');
  assert.ok(!hasCode(s.findings, 'cursor-no-where'));
  assert.ok(!hasCode(s.findings, 'always-true-where'));
});

test('通常のSELECT文で条件のあるWHEREはalways-true-whereを出さない', () => {
  const s = firstStatement('SELECT * FROM t WHERE id = 1;', 'mysql');
  assert.ok(!hasCode(s.findings, 'always-true-where'));
});

test('UPDATE/DELETEのWHERE 1=1はdangerのまま変わらない（回帰防止）', () => {
  const u = firstStatement('UPDATE t SET x=1 WHERE 1=1;', 'mysql');
  assert.equal(findCode(u.findings, 'always-true-where').severity, 'danger');
  const d = firstStatement('DELETE FROM t WHERE 1=1;', 'oracle');
  assert.equal(findCode(d.findings, 'always-true-where').severity, 'danger');
});

// --- フォールバック --------------------------------------------------------

test('Phase1: DMLを1本も抽出できない実行ブロックは従来通り unanalyzed-statement 警告を出す', () => {
  const sql = "BEGIN\n  EXECUTE IMMEDIATE 'DELETE FROM t';\n  DBMS_OUTPUT.PUT_LINE('done');\nEND;\n/";
  const u = plsqlUnit(sql);
  assert.equal(u.plsql.items.length, 0);
  const f = findCode(u.findings, 'unanalyzed-statement');
  assert.ok(f, 'DMLゼロ件のブロックが無警告で素通りしています');
  assert.equal(f.severity, 'warning');
});

test('Phase1: パッケージ仕様部（宣言のみ・実行部なし）はDMLゼロでも danger 扱いにしない', () => {
  const sql = 'CREATE OR REPLACE PACKAGE pkg_x AS\n  PROCEDURE p1(p_a IN NUMBER);\n  FUNCTION f1 RETURN NUMBER;\nEND pkg_x;\n/';
  const u = plsqlUnit(sql);
  assert.equal(u.plsql.items.length, 0);
  assert.ok(!hasCode(u.findings, 'unanalyzed-statement'), '宣言だけの仕様部を「解析できなかった」扱いにしないこと');
  assert.ok(hasCode(u.findings, 'plsql-declaration-only'));
  assert.equal(u.plsql.procedureCount, 1);
  assert.equal(u.plsql.functionCount, 1);
});

// --- 既存挙動の非破壊 ------------------------------------------------------

test('Phase1: `/` 終端行のない通常SQLスクリプトは従来通りセミコロン分割される', () => {
  const sql = 'UPDATE a SET x = 1 WHERE id = 1;\nDELETE FROM b WHERE id = 2;';
  const result = analyzeSQL(sql, 'oracle');
  assert.equal(result.statements.length, 2);
  assert.ok(result.statements.every((s) => s.kind !== 'PLSQL_UNIT'));
});

test('Phase1: T-SQLの BEGIN TRAN スクリプトをPL/SQLユニット扱いにしない（誤検知しない）', () => {
  const sql = 'BEGIN TRAN\nUPDATE a SET x = 1 WHERE id = 1;\nCOMMIT\n';
  const result = analyzeSQL(sql, 'mssql');
  assert.ok(result.statements.every((s) => s.kind !== 'PLSQL_UNIT'));
});

test('Phase1: PL/SQLユニットとその後の通常SQLが混在しても両方解析される', () => {
  const sql = 'BEGIN\n  UPDATE t SET a = 1 WHERE id = 1;\nEND;\n/\n'
    + 'DELETE FROM logs WHERE id = 2;\n';
  const result = analyzeSQL(sql, 'oracle');
  assert.equal(result.statements.length, 2);
  assert.equal(result.statements[0].kind, 'PLSQL_UNIT');
  assert.equal(result.statements[1].kind, 'DELETE');
});

test('Phase1: PL/SQLユニットが触るテーブルは全体サマリの「触るテーブル」に持ち上がる', () => {
  const sql = 'BEGIN\n  UPDATE orders SET a = 1 WHERE id = 1;\nEND;\n/';
  const u = plsqlUnit(sql);
  assert.deepEqual(u.tables.map((t) => t.toLowerCase()), ['orders']);
});

test('Phase1: PL/SQL内部の危険は overview.warnedStatements に載る', () => {
  const sql = 'BEGIN\n  UPDATE orders SET a = 1;\nEND;\n/\n'
    + 'SELECT 1 FROM dual;\nSELECT 2 FROM dual;\nSELECT 3 FROM dual;\nSELECT 4 FROM dual;\nSELECT 5 FROM dual;';
  const result = analyzeSQL(sql, 'oracle');
  assert.ok(result.overview, 'overviewがありません');
  assert.ok(result.overview.warnedStatements.includes(1), 'PL/SQL内部の危険が全体サマリから漏れています');
});

// --- 実サンプルでの受け入れ検証 -------------------------------------------

test('Phase1[受け入れサンプル]: 仕様部と本体の2ユニットに分かれる', () => {
  const sql = REAL_SAMPLE;
  const result = analyzeSQL(sql, 'oracle');
  assert.equal(result.statements.length, 2);
  assert.equal(result.statements[0].plsql.header, 'PACKAGE pkg_order_batch');
  assert.equal(result.statements[1].plsql.header, 'PACKAGE BODY pkg_order_batch');
});

test('Phase1[受け入れサンプル]: 仕様部はDMLなし・構造表示のみ（danger扱いにしない）', () => {
  const sql = REAL_SAMPLE;
  const spec = analyzeSQL(sql, 'oracle').statements[0];
  assert.equal(spec.plsql.items.length, 0);
  assert.equal(spec.plsql.procedureCount, 1);
  assert.ok(!hasCode(spec.findings, 'unanalyzed-statement'));
});

test('Phase1[受け入れサンプル]: 本体からUPDATE1本・INSERT1本・カーソル1個を抽出する', () => {
  const sql = REAL_SAMPLE;
  const body = analyzeSQL(sql, 'oracle').statements[1];
  assert.equal(body.plsql.procedureCount, 2);
  assert.equal(body.plsql.cursorCount, 1);
  assert.ok(body.plsql.hasCommit);
  assert.ok(body.plsql.hasRollback);
  assert.deepEqual(itemKinds(body).sort(), ['CURSOR', 'INSERT', 'UPDATE']);
  assert.match(body.plsql.structure, /プロシージャ2個 \/ 抽出したDML: UPDATE 1本・INSERT 1本 \/ カーソル1個 \/ COMMITあり・ROLLBACKあり/);
});

test('Phase1[受け入れサンプル]: FORALL内UPDATEのWHERE（order_id = v_orders(i).order_id）が「条件あり」と判定される', () => {
  const sql = REAL_SAMPLE;
  const body = analyzeSQL(sql, 'oracle').statements[1];
  const upd = body.plsql.items.find((i) => i.kind === 'UPDATE');
  assert.ok(upd, 'FORALL内のUPDATEが抽出されていません');
  assert.equal(upd.findings.length, 0, `想定外のfindings: ${JSON.stringify(upd.findings)}`);
  assert.equal(upd.verifySelect, 'SELECT COUNT(*) FROM orders WHERE order_id = v_orders(i).order_id;');
  assert.ok(upd.verifySelectHasRuntimeVariable);
});

test('Phase1[受け入れサンプル]: WHERE句を落とした改変版では no-where-update が発火する', () => {
  const sql = REAL_SAMPLE;
  const broken = sql.replace(/\s*WHERE order_id = v_orders\(i\)\.order_id;/, ';');
  assert.notEqual(broken, sql, '改変が効いていません（テストの前提が崩れています）');
  const body = analyzeSQL(broken, 'oracle').statements[1];
  const upd = body.plsql.items.find((i) => i.kind === 'UPDATE');
  assert.ok(upd);
  assert.ok(hasCode(upd.findings, 'no-where-update'), 'WHERE漏れを仕込んでも検出できていません');
});

test('Phase1[境界サンプル]: q\'記法・文字列内セミコロン入りでも正しく抽出できる', () => {
  const sql = EDGE_SAMPLE;
  const result = analyzeSQL(sql, 'oracle');
  assert.equal(result.statements.length, 2);
  const body = result.statements[1];
  assert.deepEqual(itemKinds(body).sort(), ['CURSOR', 'INSERT', 'SELECT', 'UPDATE']);
  const upd = body.plsql.items.find((i) => i.kind === 'UPDATE');
  assert.equal(upd.findings.length, 0);
  assert.match(upd.sql, /WHERE order_id = v_orders\(i\)\.order_id$/);
});

// --- 抽出ユーティリティの単体テスト ---------------------------------------

test('Phase1: maskPlsql は文字列・コメント・q\'記法を無害化し、長さを保つ', () => {
  const src = "a '--x' b -- c\n/* d */ e q'[f;g]' h";
  const { plain, masked } = PlsqlExtract.maskPlsql(src);
  assert.equal(masked.length, src.length, 'masked は元テキストと同じ長さでなければならない');
  assert.equal(plain.length, src.length);
  assert.ok(!/--x/.test(masked), '文字列の中身がマスクされていません');
  assert.ok(!/;/.test(masked), "q'記法の中のセミコロンがマスクされていません");
});

test('Phase1: splitSlashChunks は文字列リテラル内の `/` 行では分割しない', () => {
  const src = "BEGIN\n  v := '\n/\n';\nEND;\n/";
  const chunks = PlsqlExtract.splitSlashChunks(src);
  assert.equal(chunks.length, 1, '文字列リテラル内の `/` 行で分割されています');
});

// ---------------------------------------------------------------------------
// 機能A: 「チェックゼロの文」の撲滅（MERGE / OTHER文への簡易チェック併走）
// ---------------------------------------------------------------------------

test('機能A: ON句ありのMERGEはmerge-missing-on警告が付かない', () => {
  const s = firstStatement('MERGE INTO tgt t USING src s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET t.val = s.val;', 'oracle');
  assert.equal(s.kind, 'MERGE');
  assert.ok(!hasCode(s.findings, 'merge-missing-on'), 'ON句があるのにmerge-missing-onが誤爆しています');
  const f = findCode(s.findings, 'unanalyzed-statement');
  assert.ok(f);
  assert.equal(f.severity, 'warning');
  assert.equal(f.meta && f.meta.checkLevel, 'basic', 'MERGEは簡易チェックを併走させるのでcheckLevelはbasicになるはず');
  assert.match(f.message, /MERGE文の解析は未対応/, '既存の文言（テスト互換性）が失われています');
  assert.match(f.message, /簡易チェックのみ実施/, '簡易チェックのみ実施した旨が新文言に含まれていません');
});

test('機能A: ON句なしのMERGEは「結合条件が確認できません」警告が付く', () => {
  const s = firstStatement('MERGE INTO tgt t USING src s WHEN MATCHED THEN UPDATE SET t.val = s.val;', 'oracle');
  const f = findCode(s.findings, 'merge-missing-on');
  assert.ok(f, 'ON句がないMERGEでmerge-missing-onが検出されていません');
  assert.equal(f.severity, 'warning');
  assert.match(f.message, /結合条件が確認できません/);
});

test('機能A: MERGEのWHEN MATCHED THEN UPDATEのWHERE句が「1=1」なら常に真になる条件を検出する', () => {
  const s = firstStatement("MERGE INTO tgt t USING src s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET t.val = s.val WHERE 1=1;", 'oracle');
  const f = findCode(s.findings, 'always-true-where');
  assert.ok(f, 'MERGEのWHERE句のOR 1=1相当が検出されていません');
  assert.equal(f.severity, 'danger');
  assert.match(f.title, /WHEN MATCHED THEN UPDATE WHERE句/);
});

test('機能A: MERGEのWHEN MATCHED THEN UPDATEのSET句にOR 1=1相当が含まれる場合も検出する', () => {
  const s = firstStatement("MERGE INTO tgt t USING src s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET t.val = s.val WHERE t.id = 1 OR 1=1;", 'oracle');
  const f = findCode(s.findings, 'always-true-where');
  assert.ok(f);
  assert.equal(f.severity, 'danger');
});

test('機能A: MERGEのWHEN MATCHED THEN UPDATEのWHERE句のLIKE前方一致でないパターンを検出する', () => {
  const s = firstStatement("MERGE INTO tgt t USING src s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET t.val = s.val WHERE t.name LIKE '%foo';", 'oracle');
  const f = findCode(s.findings, 'like-leading-wildcard');
  assert.ok(f, 'MERGEのWHERE句のLIKE前方一致でないパターンが検出されていません');
});

test('機能A: Oracle形式（WHEN MATCHED THEN UPDATE ... DELETE WHERE ...）のMERGEは「削除句を含むMERGE」infoが付く', () => {
  const s = firstStatement("MERGE INTO tgt t USING src s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET t.val = s.val WHERE t.val <> s.val DELETE WHERE t.flag = 'Y';", 'oracle');
  const f = findCode(s.findings, 'merge-has-delete');
  assert.ok(f, 'Oracle形式の埋め込みDELETEが検出されていません');
  assert.equal(f.severity, 'info');
  assert.match(f.title, /削除句を含むMERGE/);
});

test('機能A: T-SQL形式（WHEN MATCHED THEN DELETE 単独）のMERGEも「削除句を含むMERGE」infoが付く', () => {
  const s = firstStatement('MERGE INTO tgt AS t USING src AS s ON (t.id = s.id) WHEN MATCHED AND s.deleted = 1 THEN DELETE WHEN MATCHED THEN UPDATE SET t.val = s.val;', 'mssql');
  const f = findCode(s.findings, 'merge-has-delete');
  assert.ok(f, 'T-SQL形式の単独DELETEアクションが検出されていません');
  assert.equal(f.severity, 'info');
});

test('機能A: MERGEのWHEN NOT MATCHED THEN INSERTのWHERE句（Oracle）にもOR 1=1相当を検出する', () => {
  const s = firstStatement("MERGE INTO tgt t USING src s ON (t.id = s.id) WHEN NOT MATCHED THEN INSERT (id, val) VALUES (s.id, s.val) WHERE 1=1;", 'oracle');
  const f = findCode(s.findings, 'always-true-where');
  assert.ok(f, 'INSERT句のWHERE1=1が検出されていません');
  assert.match(f.title, /WHEN NOT MATCHED THEN INSERT WHERE句/);
});

test('機能A: kind=OTHERで破壊的キーワード（EXEC）を含む文はcheckLevel=basicになる', () => {
  const s = firstStatement('EXEC sp_do_something @id = 1;', 'mssql');
  const f = findCode(s.findings, 'unanalyzed-statement');
  assert.ok(f);
  assert.equal(f.meta && f.meta.checkLevel, 'basic');
  assert.match(f.message, /簡易チェックのみ実施/);
});

test('機能A: kind=OTHERで破壊的キーワードを含み、文字列リテラル外に1=1がある場合はalways-true-whereも検出する', () => {
  const s = firstStatement('EXEC sp_do_something WHERE 1=1;', 'mssql');
  assert.ok(hasCode(s.findings, 'unanalyzed-statement'));
  const f = findCode(s.findings, 'always-true-where');
  assert.ok(f, 'OTHER文の文字列リテラル外1=1が検出されていません');
  assert.equal(f.severity, 'warning');
});

test('機能A: kind=OTHERで破壊的キーワードが無くても、1=1のような常に真になる式は検出する（unanalyzed-statementは付けない）', () => {
  const s = firstStatement('SHOW STATUS WHERE 1=1;', 'mysql');
  assert.equal(s.kind, 'OTHER');
  assert.ok(!hasCode(s.findings, 'unanalyzed-statement'), '破壊的キーワードが無いのにunanalyzed-statementが付いています');
  const f = findCode(s.findings, 'always-true-where');
  assert.ok(f, '破壊的キーワードが無くても1=1自体は検出してほしい');
});

test('機能A: kind=OTHERで文字列リテラル内の1=1は誤検知しない', () => {
  const s = firstStatement("EXEC sp_run 'WHERE 1=1';", 'mssql');
  assert.ok(!hasCode(s.findings, 'always-true-where'), '文字列リテラル内の1=1を誤検知しています');
});

test('機能A: PL/SQLブロックからDMLを1本も抽出できない場合は従来通りcheckLevel=noneのまま', () => {
  const sql = 'BEGIN\n  EXECUTE IMMEDIATE v_sql;\nEND;\n/';
  const u = analyzeSQL(sql, 'oracle').statements[0];
  const f = findCode(u.findings, 'unanalyzed-statement');
  assert.ok(f, 'DMLを抽出できない実行ブロックでunanalyzed-statementが付いていません');
  assert.equal(f.meta && f.meta.checkLevel, 'none', '簡易チェックすら適用できない場合はcheckLevel=noneのままであるべき');
  assert.match(f.message, /チェックは行われていません/, '簡易チェックすら不可能な場合は従来文言を維持する');
});

test('機能A: findGenericTautologiesは数値の1=1と文字列同士のa=aを検出し、文字列内の1=1は無視する', () => {
  const { scan } = _internal;
  const { masked, plain } = scan("SELECT * FROM t WHERE 1=1 AND x = 'literal 1=1 inside' AND 'a'='a'", 'generic');
  const hits = _internal.findGenericTautologies(masked, plain);
  assert.ok(hits.some((h) => h === '1=1'));
  assert.ok(hits.some((h) => h === "'a'='a'"));
  assert.ok(!hits.some((h) => /literal/.test(h)));
});

// ---------------------------------------------------------------------------
// 機能B: 方言の自動判定（dialect-detect.js）
// ---------------------------------------------------------------------------

test('機能B: Oracle方言のマーカー（NVL・SYSDATE・ROWNUM・(+)・%TYPE・DUAL・MERGE INTO）でoracleと判定する', () => {
  const sql = "SELECT NVL(a.name, 'unknown') FROM emp a, dept b WHERE a.dept_id = b.id(+) AND ROWNUM <= 10 AND a.hired = SYSDATE";
  const d = detectDialect(sql);
  assert.equal(d.dialect, 'oracle');
  assert.equal(d.reason, 'heuristic');
  assert.ok(d.markers.length > 0 && d.markers.length <= 3);
});

test('機能B: 実プロジェクト由来のサンプル（PL/SQLパッケージ）がoracleと判定される', () => {
  const samplePath = path.join('d:', 'GitHub', 'AutoClaude', 'business', 'plsql-sample-real.sql');
  if (!fs.existsSync(samplePath)) {
    console.warn('  [skip] plsql-sample-real.sql が見つからないためスキップ:', samplePath);
    return;
  }
  const sql = fs.readFileSync(samplePath, 'utf8');
  const d = detectDialect(sql);
  assert.equal(d.dialect, 'oracle', `期待: oracle, 実際: ${d.dialect}（reason=${d.reason}, scores=${JSON.stringify(d.scores)}）`);
});

test('機能B: SQL Server方言のマーカー（@変数・[角括弧]・TOP n・GETDATE・ISNULL・BEGIN TRAN・sp_・NOLOCK）でmssqlと判定する', () => {
  const sql = "DECLARE @id INT; SELECT TOP 10 * FROM [dbo].[Users] WITH (NOLOCK) WHERE ISNULL(deleted_at, GETDATE()) = GETDATE(); EXEC sp_helptext 'x'; BEGIN TRAN;";
  const d = detectDialect(sql);
  assert.equal(d.dialect, 'mssql');
  assert.equal(d.reason, 'heuristic');
});

test('機能B: MySQL方言のマーカー（バッククォート・LIMIT・NOW・ON DUPLICATE KEY・AUTO_INCREMENT）でmysqlと判定する', () => {
  const sql = "INSERT INTO `users` (id, updated_at) VALUES (1, NOW()) ON DUPLICATE KEY UPDATE updated_at = NOW(); SELECT * FROM `t` LIMIT 10;";
  const d = detectDialect(sql);
  assert.equal(d.dialect, 'mysql');
  assert.equal(d.reason, 'heuristic');
});

test('機能B: PostgreSQL方言のマーカー（::キャスト・RETURNING・ILIKE・ON CONFLICT・SERIAL）でpostgresと判定する', () => {
  const sql = "UPDATE t SET x = y::int WHERE name ILIKE 'a%' RETURNING id; INSERT INTO t (id) VALUES (1) ON CONFLICT (id) DO NOTHING;";
  const d = detectDialect(sql);
  assert.equal(d.dialect, 'postgres');
  assert.equal(d.reason, 'heuristic');
});

test('機能B: 文字列リテラル内に方言キーワードがあっても誤判定しない', () => {
  const sql = "SELECT * FROM t WHERE msg = 'Please add LIMIT 10 and TOP 5 and `col` and ::cast to your query';";
  const d = detectDialect(sql);
  assert.notEqual(d.reason, 'heuristic', `文字列内のキーワードでheuristic判定してしまっています（scores=${JSON.stringify(d.scores)}）`);
});

test('機能B: コメント内に方言キーワードがあっても誤判定しない', () => {
  const sql = "-- この処理はLIMIT 10件ずつ`col`を処理するTOP 5対応版\nSELECT * FROM t WHERE id = 1;";
  const d = detectDialect(sql);
  assert.notEqual(d.reason, 'heuristic', `コメント内のキーワードでheuristic判定してしまっています（scores=${JSON.stringify(d.scores)}）`);
});

test('機能B: ANSI互換SQL（複数方言でパース成功）はmysqlを採用しparse-success-ambiguousになる', () => {
  const sql = 'SELECT id, name FROM users WHERE id = 1;';
  const d = detectDialect(sql);
  assert.equal(d.reason, 'parse-success-ambiguous');
  assert.equal(d.dialect, 'mysql');
});

test('機能B: マーカーが同点タイの場合はheuristicで決め打ちしない（試しパースに回す）', () => {
  const sql = 'SELECT NVL(`col`, 0) FROM t;';
  const d = detectDialect(sql);
  assert.notEqual(d.reason, 'heuristic', 'oracle(NVL)とmysql(バッククォート)が同点タイなのにheuristicで決めています');
});

test('機能B: どの方言のパーサでも通らずマーカーも無いSQLは汎用（generic）にとどまる', () => {
  const sql = 'THIS IS NOT VALID SQL AT ALL ???undefined_garbage%%%';
  const d = detectDialect(sql);
  assert.equal(d.dialect, 'generic');
  assert.equal(d.reason, 'undetermined');
});

test('機能B: 空文字列はdialect=nullを返す（判定自体を行わない）', () => {
  const d = detectDialect('   ');
  assert.equal(d.dialect, null);
});

test('機能B: PL/SQLユニット構造だけでもoracleのマーカーとして加点される', () => {
  const sql = 'BEGIN\n  UPDATE emp SET sal = sal * 1.1 WHERE emp_id = 1;\n  COMMIT;\nEND;\n/';
  const d = detectDialect(sql);
  assert.equal(d.dialect, 'oracle');
  assert.ok(d.markers.includes('PL/SQLユニット構造'));
});

// ---------------------------------------------------------------------------
// CLI（cli/sqlmegane.mjs）: ブラウザ版と同じコアを Node から呼ぶ入口
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
const CLI = path.join(projectRoot, 'cli', 'sqlmegane.mjs');
function runCli(args, input) {
  return spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8' });
}

test('CLI: WHERE のない DELETE は要約と【危険】を出し、終了コード 2 で終わる', () => {
  const r = runCli(['--dialect', 'mysql', '-'], 'DELETE FROM t_log;');
  assert.equal(r.status, 2, r.stderr);
  assert.ok(r.stdout.includes('DELETE: `t_log` の全行を削除します'), r.stdout);
  assert.ok(r.stdout.includes('【危険】WHERE句のないDELETE'), r.stdout);
  assert.ok(r.stdout.includes('検算SELECT: SELECT COUNT(*) FROM t_log;'), r.stdout);
});

test('CLI: 主キー1行の UPDATE は danger が無いので終了コード 0', () => {
  const r = runCli(['--dialect', 'mysql', '-'], ['BEGIN;', 'UPDATE m_users SET status = 1 WHERE id = 5;', 'COMMIT;'].join('\n'));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('UPDATE: `m_users` のうち'), r.stdout);
});

test('CLI: --fail-on info なら info の指摘でも終了コード 2', () => {
  const r = runCli(['--dialect', 'mysql', '--fail-on', 'info', '-'], "UPDATE m_users SET status = 1 WHERE last_login < '2024-01-01';");
  assert.equal(r.status, 2, r.stdout + r.stderr);
});

test('CLI: --json は AST を含まない JSON を返し、方言は自動判定される', () => {
  const r = runCli(['--json', '-'], 'DELETE FROM t_log;');
  assert.equal(r.status, 2, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.ok(['mysql', 'postgres', 'mssql', 'oracle', 'generic'].includes(j.dialect));
  assert.equal(j.statements[0].kind, 'DELETE');
  assert.equal(j.statements[0].findings[0].code, 'no-where-delete');
  assert.ok(!('parse' in j.statements[0]) && !('ast' in j.statements[0]));
});

test('CLI: ファイル指定で読める（fixtures を使う）', () => {
  const tmp = path.join(projectRoot, 'tests', '_cli_tmp.sql');
  fs.writeFileSync(tmp, 'SELECT 1;', 'utf8');
  try {
    const r = runCli(['--dialect', 'generic', tmp]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes('#1 SELECT'), r.stdout);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('CLI: 空入力と不正オプションは終了コード 1', () => {
  assert.equal(runCli(['-'], '   ').status, 1);
  assert.equal(runCli(['--dialect', 'nope', '-'], 'SELECT 1;').status, 1);
});

test('CLI: PL/SQL ブロック内の WHERE なし DELETE も出力と終了コード判定に含まれる', () => {
  const plsql = ['BEGIN', '  DELETE FROM t_log;', 'END;', '/'].join('\n');
  const r = runCli(['--dialect', 'oracle', '-'], plsql);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('PL/SQL'), r.stdout);
  assert.ok(r.stdout.includes('【危険】WHERE句のないDELETE'), r.stdout);
  const j = JSON.parse(runCli(['--dialect', 'oracle', '--json', '-'], plsql).stdout);
  assert.ok(j.statements[0].plsql && j.statements[0].plsql.items.length === 1);
  assert.equal(j.statements[0].plsql.items[0].findings[0].code, 'no-where-delete');
});

test('CLI: 自動判定が曖昧（ANSI 互換）なら mysql-no-limit を落とす（ブラウザ版と同じ後処理）', () => {
  const sql = "UPDATE m_users SET status = 'INACTIVE' WHERE last_login < '2024-01-01';";
  const auto = JSON.parse(runCli(['--json', '-'], sql).stdout);
  assert.ok(!auto.statements[0].findings.some((f) => f.code === 'mysql-no-limit'), JSON.stringify(auto.statements[0].findings));
  const mysql = JSON.parse(runCli(['--json', '--dialect', 'mysql', '-'], sql).stdout);
  assert.ok(mysql.statements[0].findings.some((f) => f.code === 'mysql-no-limit'));
});

test('CLI: テキスト出力でも --include-sql で SQL 全文が出る（PL/SQL 内の sql も）', () => {
  const r = runCli(['--dialect', 'mysql', '--include-sql', '-'], 'DELETE FROM t_log WHERE id = 1;');
  assert.ok(r.stdout.includes('SQL: DELETE FROM t_log WHERE id = 1'), r.stdout);
  const p = runCli(['--dialect', 'oracle', '--include-sql', '-'], ['BEGIN', '  DELETE FROM t_log WHERE id = 1;', 'END;', '/'].join(String.fromCharCode(10)));
  assert.ok(p.stdout.includes('  SQL: DELETE FROM t_log WHERE id = 1'), p.stdout);
});

test('CLI: 既定では SQL 本文（raw）を出力に含めず、--include-sql で含める', () => {
  const sql = "DELETE FROM t_log WHERE note = 'literal-marker-xyz';";
  const a = JSON.parse(runCli(['--json', '--dialect', 'mysql', '-'], sql).stdout);
  assert.ok(!('raw' in a.statements[0]));
  const b = JSON.parse(runCli(['--json', '--include-sql', '--dialect', 'mysql', '-'], sql).stdout);
  assert.equal(b.statements[0].raw, "DELETE FROM t_log WHERE note = 'literal-marker-xyz'");
});

test('CLI: 入力が --max-bytes を超えると終了コード 1', () => {
  const r = runCli(['--max-bytes', '10', '-'], 'SELECT 1 FROM a_very_long_table_name;');
  assert.equal(r.status, 1, r.stdout);
  assert.ok(r.stderr.includes('上限'), r.stderr);
  const tmp = path.join(projectRoot, 'tests', '_cli_big.sql');
  fs.writeFileSync(tmp, 'SELECT 1;'.repeat(20), 'utf8');
  try {
    assert.equal(runCli(['--max-bytes', '50', tmp]).status, 1);
    assert.equal(runCli(['--max-bytes', '1000', tmp]).status, 0);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('CLI: 引数解析の境界（値なしオプション・重複ファイル・-- 以降は位置引数・存在しないファイル）', () => {
  assert.equal(runCli(['--dialect'], 'SELECT 1;').status, 1);
  assert.equal(runCli(['--fail-on'], 'SELECT 1;').status, 1);
  assert.equal(runCli(['--max-bytes', '0', '-'], 'SELECT 1;').status, 1);
  assert.equal(runCli(['a.sql', 'b.sql']).status, 1);
  const tmp = path.join(projectRoot, 'tests', '-dash.sql');
  fs.writeFileSync(tmp, 'SELECT 1;', 'utf8');
  try {
    assert.equal(runCli(['--dialect', 'generic', '--', tmp]).status, 0);
  } finally {
    fs.unlinkSync(tmp);
  }
  assert.equal(runCli(['nonexistent_file_xyz.sql']).status, 1);
});

// ---------------------------------------------------------------------------
// 英語ロケール
// ---------------------------------------------------------------------------

test('i18n: ja と en のメッセージキー集合が一致する', () => {
  const { messages } = globalThis.SQLMeganeI18n;
  assert.deepEqual(Object.keys(messages.en).sort(), Object.keys(messages.ja).sort());
});

test('i18n: 主要SQLの英語要約とfindingに日本語文字が混ざらない', () => {
  const I18n = globalThis.SQLMeganeI18n;
  const japanese = /[\u3040-\u30ff\u3400-\u9fff]/;
  const cases = [
    ['DELETE FROM m_users;', 'mysql'],
    ["UPDATE m_users SET status = 'INACTIVE' WHERE last_login < '2024-01-01';", 'mysql'],
    ['TRUNCATE TABLE m_users;', 'mysql'],
    ["SELECT u.id FROM users u LEFT JOIN orders o ON u.id = o.user_id WHERE o.status = 'x';", 'mysql'],
    [['BEGIN', '  DELETE FROM m_users;', 'END;', '/'].join('\n'), 'oracle'],
  ];
  I18n.setLocale('en');
  try {
    for (const [sql, dialect] of cases) {
      const result = analyzeSQL(sql, dialect);
      const visible = [];
      for (const stmt of result.statements) {
        if (stmt.summary) visible.push(...summaryToLines(stmt.summary));
        for (const f of stmt.findings) visible.push(f.title, f.message);
        if (stmt.plsql) {
          visible.push(stmt.plsql.unitKind, stmt.plsql.structure);
          for (const item of stmt.plsql.items) {
            if (item.summary) visible.push(...summaryToLines(item.summary));
            for (const f of item.findings) visible.push(f.title, f.message);
          }
        }
      }
      assert.ok(visible.length > 0, sql);
      assert.ok(!japanese.test(visible.join('\n')), visible.join('\n'));
    }
  } finally {
    I18n.setLocale('ja');
  }
});

test('i18n: setLocale(ja) で既存の日本語要約に戻る', () => {
  const I18n = globalThis.SQLMeganeI18n;
  I18n.setLocale('en');
  firstStatement('DELETE FROM m_users;', 'mysql');
  I18n.setLocale('ja');
  assert.equal(firstStatement('DELETE FROM m_users;', 'mysql').summary.headline, '`m_users` の全行を削除します');
});

test('i18n: en/index.html は index.html と同じ順序で同じJSを読み込む', () => {
  const scripts = (html) => [...html.matchAll(/<script src="(?:\.\.\/)?(js\/[^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(scripts(readProjectFile('en/index.html')), scripts(readProjectFile('index.html')));
});

test('CLI: --lang en は英語を出力し終了コードの意味を維持する', () => {
  const r = runCli(['--lang', 'en', '-'], 'DELETE FROM t_log;');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /DELETE: deletes ALL rows of `t_log`/);
  assert.match(r.stdout, /\[DANGER\]/);
  assert.ok(!/[\u3040-\u30ff\u3400-\u9fff]/.test(r.stdout), r.stdout);
});

test('en/index.html は英語が静的に焼き込まれ、インラインスクリプト無しで data-locale=en を持つ（tools/build-en.mjs の生成物）', () => {
  const html = readProjectFile('en/index.html');
  assert.match(html, /<html lang="en" data-locale="en">/);
  assert.match(html, /<title>SQLMegane — Review SQL before you run it<\/title>/);
  assert.ok(!html.includes('SQLMEGANE_LOCALE'), 'インラインスクリプトでロケールを渡していない（CSP と両立させるため data-locale を使う）');
  const jp = /[぀-ヿ㐀-鿿]/;
  const body = html.slice(html.indexOf('<body'));
  const jpLines = body.split(String.fromCharCode(10)).filter((l) => jp.test(l) && !/^\s*(<!--|[^<]*-->|同梱パーサ|js\/vendor|ライセンス)/.test(l));
  assert.deepEqual(jpLines.map((l) => l.trim().slice(0, 40)), ['<div><a href="../" lang="ja" data-i18n="'], '日本語が残るのは日本語ページへのリンクだけ');
});

// ---------------------------------------------------------------------------
// SELECT -> DML / templates / safe execution wrapper
// ---------------------------------------------------------------------------

for (const dialect of ['mysql', 'postgres', 'mssql', 'oracle', 'generic']) {
  test(`DML builder: ${dialect} single table`, () => {
    const r = DmlBuilder.convert('SELECT id, name FROM app.users WHERE active = 1;', { dialect });
    assert.equal(r.status, 'ok'); assert.equal(r.equivalence, 'proven');
    assert.deepEqual(r.columnCandidates, ['id', 'name']); assert.ok(r.delete.includes('WHERE active = 1'));
  });
  test(`DML builder: ${dialect} alias and subquery`, () => {
    const r = DmlBuilder.convert('SELECT u.id FROM users u WHERE u.id IN (SELECT user_id FROM logs WHERE ok = 1) ORDER BY u.id;', { dialect });
    assert.equal(r.status, 'ok'); assert.ok(r.delete.includes('SELECT user_id FROM logs WHERE ok = 1'));
  });
  test(`DML builder: ${dialect} no WHERE`, () => {
    const r = DmlBuilder.convert('SELECT id FROM users;', { dialect });
    assert.equal(r.status, 'ok'); assert.ok(!r.delete.includes(' WHERE '));
    assert.ok(analyzeSQL(r.delete, dialect).statements[0].findings.some((f) => f.code === 'no-where-delete'));
  });
  test(`templates: ${dialect} placeholders only`, () => {
    for (const kind of ['update', 'delete', 'insert-select', 'upsert', 'merge', 'create-table', 'safe-block']) {
      const sql = Templates.get(kind, dialect, { locale: 'en' });
      assert.ok(!/(:x\b|@x\b|\$1\b|\?)/.test(sql), `${dialect}/${kind}`);
      assert.ok([...(sql.matchAll(/<([^>]+)>/g))].every((m) => ['table', 'column', 'value', 'condition', 'key', 'source'].includes(m[1])));
    }
  });
}

const rejected = {
  'join-unsupported-v1': 'SELECT t.id FROM t JOIN u ON u.id=t.id',
  'row-limit': 'SELECT id FROM t LIMIT 1',
  grouping: 'SELECT COUNT(id) FROM t',
  'set-operation': 'SELECT id FROM t UNION SELECT id FROM u',
  'cte-unsupported-v1': 'WITH q AS (SELECT id FROM t) SELECT id FROM q',
  'derived-table': 'SELECT id FROM (SELECT id FROM t) q',
  'hierarchical-or-special': 'SELECT id FROM t CONNECT BY PRIOR id = parent_id',
  'lock-clause': 'SELECT id FROM t FOR UPDATE',
  'select-into': 'SELECT id INTO x FROM t',
  'not-single-select': 'SELECT id FROM t; SELECT id FROM u',
};
for (const [reason, sql] of Object.entries(rejected)) {
  test(`DML builder rejects ${reason}`, () => assert.equal(DmlBuilder.convert(sql, { dialect: 'generic' }).reasonCode, reason));
}

test('DML builder: quoted target and column candidates', () => {
  const r = DmlBuilder.convert('SELECT "u"."id", name, name || suffix AS display, *, 1 FROM "app"."users" AS "u" WHERE "u"."id" = 1;', { dialect: 'postgres' });
  assert.equal(r.status, 'ok'); assert.deepEqual(r.columnCandidates, ['"id"', 'name']); assert.equal(r.target.table, '"app"."users"');
});
test('DML builder: applyColumns replaces only SET placeholder', () => {
  assert.match(DmlBuilder.applyColumns('UPDATE t SET <column> = <value> WHERE id=1;', ['a', 'b']), /SET a = <value>, b = <value>/);
});
test('DML builder: MySQL output drops LIMIT', () => {
  assert.equal(DmlBuilder.convert('SELECT id FROM t LIMIT 1', { dialect: 'mysql' }).reasonCode, 'row-limit');
});
test('DML builder: ambiguous auto dialect', () => {
  assert.equal(DmlBuilder.convert('SELECT id FROM t WHERE id=1', { dialect: 'auto' }).reasonCode, 'dialect-ambiguous');
});

for (const [dialect, version, code] of [['oracle', 'legacy', 'dialect-join-dml-unsupported'], ['generic', 'legacy', 'vendor-specific-join-dml']]) {
  test(`join DML finding: ${dialect}`, () => assert.ok(analyzeSQL('UPDATE t SET c=1 FROM u WHERE t.id=u.id', dialect, { oracleVersion: version }).statements[0].findings.some((f) => f.code === code)));
}
test('join DML finding: Oracle 23 has no legacy warning', () => assert.ok(!analyzeSQL('UPDATE t SET c=1 FROM u WHERE t.id=u.id', 'oracle', { oracleVersion: '23' }).statements[0].findings.some((f) => f.code === 'dialect-join-dml-unsupported')));
for (const dialect of ['mysql', 'postgres', 'mssql']) test(`join DML finding: no cross-dialect warning for ${dialect}`, () => assert.ok(!analyzeSQL('UPDATE t SET c=1 FROM u WHERE t.id=u.id', dialect).statements[0].findings.some((f) => /join-dml/.test(f.code))));
test('join DML finding ignores subquery/comment/string', () => {
  for (const sql of ["UPDATE t SET x=(SELECT y FROM u WHERE id=1) WHERE id=1", "UPDATE t SET x='FROM u USING z' WHERE id=1", 'UPDATE t SET x=1 /* FROM u */ WHERE id=1']) assert.ok(!analyzeSQL(sql, 'generic').statements[0].findings.some((f) => f.code === 'vendor-specific-join-dml'));
});
test('unfilled placeholder finding excludes strings and comments', () => {
  assert.ok(analyzeSQL('UPDATE t SET c=<value> WHERE id=1', 'mysql').statements[0].findings.some((f) => f.code === 'unfilled-placeholder' && f.severity === 'danger'));
  assert.ok(!analyzeSQL("SELECT '<value>' /* <table> */ FROM t", 'mysql').statements[0].findings.some((f) => f.code === 'unfilled-placeholder'));
});

for (const dialect of ['mysql', 'postgres', 'mssql', 'oracle', 'generic']) {
  test(`safe block: ${dialect} rollback/commit exclusivity`, () => {
    const base = { dialect, originalSelect: 'SELECT id FROM t;', countSelect: 'SELECT COUNT(*) FROM t;', dml: 'DELETE FROM t;', locale: 'en' };
    const rollback = Templates.buildSafeBlock(base); const commit = Templates.buildSafeBlock({ ...base, commit: true });
    assert.match(rollback, /^ROLLBACK;$/m); assert.doesNotMatch(rollback, /^COMMIT;$/m);
    assert.match(commit, /^COMMIT;$/m); assert.doesNotMatch(commit, /^ROLLBACK;$/m);
    if (dialect === 'oracle') assert.doesNotMatch(rollback, /^BEGIN(?:;|\s)/m);
  });
}
test('safe block: SQLPlus modes and affected rows', () => {
  const base = { dialect: 'oracle', originalSelect: 'SELECT id FROM t;', countSelect: 'SELECT COUNT(*) FROM t;', dml: 'DELETE FROM t;' };
  const interactive = Templates.buildSafeBlock({ ...base, client: 'sqlplus-interactive' });
  assert.match(interactive, /SET EXITCOMMIT OFF/); assert.doesNotMatch(interactive, /^EXIT(?:\s|$)/m);
  const batch = Templates.buildSafeBlock({ ...base, client: 'sqlplus-batch' });
  assert.match(batch, /WHENEVER SQLERROR/); assert.match(batch, /WHENEVER OSERROR/); assert.match(batch, /EXIT ROLLBACK\s*$/);
  assert.match(Templates.buildSafeBlock({ ...base, dialect: 'mysql' }), /ROW_COUNT/);
  assert.match(Templates.buildSafeBlock({ ...base, dialect: 'mssql' }), /@@ROWCOUNT/);
});
test('English template and wrapper comments contain no Japanese', () => {
  const text = Templates.get('safe-block', 'generic', { locale: 'en' });
  assert.doesNotMatch(text, /[\u3040-\u30ff\u3400-\u9fff]/);
  globalThis.SQLMeganeI18n.setLocale('ja');
});
test('CLI convert: SQL-only stdout and exit codes 0/3/4', () => {
  const ok = runCli(['convert', '--to', 'delete', '--dialect', 'mysql', '-'], 'SELECT id FROM t WHERE id=1');
  assert.equal(ok.status, 0, ok.stderr); assert.equal(ok.stdout.trim(), 'DELETE FROM t WHERE id=1;');
  const unsupported = runCli(['convert', '--to', 'delete', '--dialect', 'mysql', '-'], 'SELECT t.id FROM t JOIN u ON u.id=t.id');
  assert.equal(unsupported.status, 3); assert.ok(unsupported.stderr.trim());
  const ambiguous = runCli(['convert', '--to', 'delete', '--dialect', 'auto', '-'], 'SELECT id FROM t WHERE id=1');
  assert.equal(ambiguous.status, 4);
});
test('CLI convert: JSON schema and columns', () => {
  const r = runCli(['convert', '--to', 'update', '--dialect', 'mysql', '--columns', 'name,status', '--json', '-'], 'SELECT id FROM t WHERE id=1');
  assert.equal(r.status, 0, r.stderr); const value = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(value), ['status', 'reasonCode', 'sql', 'target', 'dialect', 'oracleVersion', 'mode', 'placeholders', 'equivalence', 'invariants', 'columnCandidates', 'warnings', 'selfCheck']);
  assert.equal(value.mode, 'single-table');
  assert.match(value.sql, /SET name = <value>, status = <value>/);
  assert.deepEqual(value.invariants, { whereOnce: true, targetOnce: true, noOtherTables: true });
  assert.ok(!value.selfCheck.some((f) => f.code === 'unfilled-placeholder'), 'convert の生成物ではプレースホルダ未記入を自己検証に含めない');
});
test('CLI convert: WHERE の無い SELECT から作った DML は stderr に danger を出し、終了コード 2（--fail-on never なら 0）', () => {
  const r = runCli(['convert', '--to', 'delete', '--dialect', 'mysql', '-'], 'SELECT id FROM t');
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout.trim(), 'DELETE FROM t;');
  assert.ok(r.stderr.includes('WHERE'), r.stderr);
  const never = runCli(['convert', '--to', 'delete', '--dialect', 'mysql', '--fail-on', 'never', '-'], 'SELECT id FROM t');
  assert.equal(never.status, 0, never.stderr);
  const safe = runCli(['convert', '--to', 'delete', '--dialect', 'mysql', '-'], 'SELECT id FROM t WHERE id = 1');
  assert.equal(safe.status, 0, safe.stderr);
  // プレースホルダ未記入（<value>）は convert の前提なので終了コードに数えない
  const upd = runCli(['convert', '--to', 'update', '--dialect', 'mysql', '--columns', 'name', '-'], 'SELECT id FROM t WHERE id = 1');
  assert.equal(upd.status, 0, upd.stderr);
  const bad = runCli(['convert', '--to', 'delete', '--dialect', 'db2', '-'], 'SELECT id FROM t WHERE id = 1');
  assert.equal(bad.status, 1); assert.ok(bad.stderr.includes('--dialect は'), bad.stderr);
});
test('dml-builder: invariants は実際に数えて判定する（対象表と同名の別名では targetOnce が偽になる）', () => {
  const B = globalThis.SQLMeganeDmlBuilder;
  const ok = B.convert("SELECT id FROM app.users u WHERE u.id = 1", { dialect: 'postgres' });
  assert.equal(ok.equivalence, 'proven');
  assert.deepEqual(ok.invariants, { whereOnce: true, targetOnce: true, noOtherTables: true });
  const dup = B.convert('SELECT id FROM users users WHERE users.id = 1', { dialect: 'postgres' });
  assert.equal(dup.status, 'ok');
  assert.equal(dup.invariants.targetOnce, false);
  assert.equal(dup.equivalence, 'unsupported');
});
test('CLI template: emits the selected dialect template', () => {
  const r = runCli(['template', '--kind', 'upsert', '--dialect', 'postgres', '--lang', 'en']);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /ON CONFLICT/);
});
test('CLI convert: Oracle SQLPlus wrapper defaults to rollback', () => {
  const r = runCli(['convert', '--to', 'update', '--dialect', 'oracle', '--safe-block', 'sqlplus-interactive', '-'], 'SELECT id FROM t WHERE id=1');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /SET EXITCOMMIT OFF/);
  assert.match(r.stdout, /^ROLLBACK;$/m); assert.doesNotMatch(r.stdout, /^COMMIT;$/m);
});

test('dml-builder: 変換できない理由は全部 reasonCodes に集める（先頭が reasonCode）', () => {
  const B = globalThis.SQLMeganeDmlBuilder;
  const r = B.convert('SELECT a.id, COUNT(*) FROM a JOIN b ON a.id = b.a_id GROUP BY a.id LIMIT 5', { dialect: 'mysql' });
  assert.equal(r.status, 'unsupported');
  assert.equal(r.reasonCode, r.reasonCodes[0]);
  assert.deepEqual([...r.reasonCodes].sort(), ['grouping', 'join-unsupported-v1', 'row-limit']);
  const cte = B.convert('WITH x AS (SELECT 1 AS id) SELECT id FROM x WHERE id = 1', { dialect: 'postgres' });
  assert.deepEqual(cte.reasonCodes, ['cte-unsupported-v1']);
  const ok = B.convert('SELECT id FROM t WHERE id = 1', { dialect: 'postgres' });
  assert.equal(ok.status, 'ok');
});

test('CLI convert: 変換不可のとき理由を全部と単一テーブル化のヒントを stderr に出す', () => {
  const r = runCli(['convert', '--to', 'delete', '--dialect', 'mysql', '-'], 'SELECT a.id FROM a JOIN b ON a.id = b.a_id LIMIT 5');
  assert.equal(r.status, 3);
  assert.ok(r.stderr.includes('LIMIT') && r.stderr.includes('JOIN'), r.stderr);
  assert.ok(r.stderr.includes('対象表とキー'), r.stderr);
  assert.equal(r.stdout, '');
});

// ---------------------------------------------------------------------------
// 更新文を作る 第2弾: キー IN (元の SELECT) 形
// ---------------------------------------------------------------------------

const byKeyBase = `-- 直近90日の商品集計
WITH monthly_sales AS (
  SELECT p.product_id, p.product_name, c.category_name,
    DATE_TRUNC('month', o.ordered_at) AS sales_month,
    SUM(oi.quantity * oi.unit_price) AS revenue,
    COUNT(DISTINCT o.customer_id) AS buyers
  FROM orders o
  JOIN order_items oi ON oi.order_id = o.order_id
  JOIN products p ON p.product_id = oi.product_id
  JOIN categories c ON c.category_id = p.category_id
  WHERE o.status = 'completed'
    AND o.ordered_at >= CURRENT_DATE - INTERVAL '90 days'
  GROUP BY p.product_id, p.product_name, c.category_name, DATE_TRUNC('month', o.ordered_at)
), ranked AS (
  SELECT *,
    RANK() OVER (PARTITION BY category_name, sales_month ORDER BY revenue DESC) AS rank_in_category,
    LAG(revenue) OVER (PARTITION BY product_id ORDER BY sales_month) AS prev_revenue
  FROM monthly_sales
)
SELECT category_name, sales_month, rank_in_category, product_name, revenue, buyers,
  ROUND(100.0 * (revenue - prev_revenue) / NULLIF(prev_revenue, 0), 1) AS mom_growth_pct
FROM ranked
WHERE rank_in_category <= 3
ORDER BY sales_month DESC, category_name, rank_in_category;`;
const byKeyWithId = byKeyBase.replace('SELECT category_name,', 'SELECT product_id, category_name,');

test('by-key inspect: CTE 名を除外し全基底表と CTE を返す', () => {
  const r = DmlBuilder.inspect(byKeyBase, { dialect: 'postgres' });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.tables.map((x) => x.name), ['orders', 'order_items', 'products', 'categories']);
  assert.deepEqual(r.ctes, ['monthly_sales', 'ranked']);
  assert.ok(r.tables.every((x) => x.where === 'cte:monthly_sales'));
  assert.equal(r.singleTable, false);
});
test('by-key inspect: 最終 SELECT の出力名と種類を返す', () => {
  const cols = DmlBuilder.inspect(byKeyBase, { dialect: 'postgres' }).outputColumns;
  assert.ok(cols.some((x) => x.name === 'product_name' && x.kind === 'column'));
  assert.ok(cols.some((x) => x.name === 'mom_growth_pct' && x.kind === 'alias'));
  assert.ok(!cols.some((x) => x.name === 'product_id'));
});
test('by-key: 出力にキーがなければ key-not-in-output', () => {
  const r = DmlBuilder.convertByKey(byKeyBase, { dialect: 'postgres', targetTable: 'products', outputKey: 'product_id' });
  assert.equal(r.reasonCode, 'key-not-in-output');
  assert.equal(r.reasonParams.key, 'product_id');
  assert.match(r.reasonParams.available, /product_name/);
});
test('by-key: CTE/JOIN/集計を派生表に保った DELETE を作る', () => {
  const r = DmlBuilder.convertByKey(byKeyWithId, { dialect: 'postgres', targetTable: 'products', outputKey: 'product_id' });
  assert.equal(r.status, 'ok'); assert.equal(r.equivalence, 'proven');
  assert.match(r.delete, /DELETE FROM products WHERE product_id IN \(SELECT product_id FROM \(WITH monthly_sales AS/);
  assert.match(r.delete, /\) sqlmegane_src\);$/);
});
test('by-key: 末尾 ORDER BY と先頭コメントを inner から除く', () => {
  const r = DmlBuilder.convertByKey(byKeyWithId, { dialect: 'postgres', targetTable: 'products', outputKey: 'product_id' });
  const inner = DmlBuilder._internal.innerSelect(byKeyWithId);
  assert.equal(inner.orderByRemoved, true); assert.doesNotMatch(inner.text, /ORDER BY sales_month DESC/);
  assert.ok(!inner.text.startsWith('--')); assert.match(r.delete, /removed the final ORDER BY/);
});
for (const dialect of ['mysql', 'postgres', 'mssql', 'oracle', 'generic']) {
  test(`by-key: ${dialect} で派生表形と syntaxCheck を返す`, () => {
    const r = DmlBuilder.convertByKey(byKeyWithId, { dialect, targetTable: 'products', outputKey: 'product_id' });
    assert.equal(r.status, 'ok');
    // SQL Server は派生表の中に WITH を書けないため、WITH 句を文頭へ移す。他方言は派生表の中に WITH ごと入れる
    if (dialect === 'mssql') { assert.ok(r.update.includes('\nWITH monthly_sales'), r.update); assert.ok(!r.update.includes('FROM (WITH'), r.update); }
    else assert.match(r.update, /FROM \(WITH monthly_sales/);
    assert.equal(typeof r.syntaxCheck.update.ok, 'boolean');
    assert.equal(r.syntaxCheck.update.mode, ['mysql', 'postgres', 'mssql'].includes(dialect) ? 'ast' : 'basic');
  });
}
test('by-key: PostgreSQL 固有の元 SELECT は方言別 syntaxCheck に結果を記録する', () => {
  const expected = { mysql: false, postgres: true, mssql: false, oracle: true, generic: true };
  for (const [dialect, ok] of Object.entries(expected)) {
    const r = DmlBuilder.convertByKey(byKeyWithId, { dialect, targetTable: 'products', outputKey: 'product_id' });
    assert.equal(r.syntaxCheck.delete.ok, ok, dialect);
    assert.equal(r.equivalence, 'proven', `${dialect}: 構文確認と意味の不変条件は別`);
  }
});
test('by-key: outputKey と targetKey を別名にできる', () => {
  const r = DmlBuilder.convertByKey('SELECT pid AS product_id FROM source_products', { dialect: 'postgres', targetTable: 'products', outputKey: 'product_id', targetKey: 'id' });
  assert.match(r.delete, /WHERE id IN \(SELECT product_id FROM/);
});
test('by-key: SELECT * のみは star-output', () => {
  assert.equal(DmlBuilder.convertByKey('SELECT * FROM products', { dialect: 'mysql', targetTable: 'products', outputKey: 'id' }).reasonCode, 'star-output');
});
test('by-key: query 外の対象表でも生成し warning を返す', () => {
  const r = DmlBuilder.convertByKey('SELECT id FROM source_table', { dialect: 'mysql', targetTable: 'other_table', outputKey: 'id' });
  assert.equal(r.status, 'ok'); assert.ok(r.warnings.includes('target-not-in-query'));
});
test('by-key: NULL と再評価の warning を必ず返す', () => {
  const r = DmlBuilder.convertByKey('SELECT id FROM products', { dialect: 'mysql', targetTable: 'products', outputKey: 'id' });
  assert.deepEqual(r.warnings, ['key-uniqueness', 'null-key-ignored', 'subquery-recomputed', 'mysql-no-merge']);
  const pg = DmlBuilder.convertByKey('SELECT id FROM products', { dialect: 'postgres', targetTable: 'products', outputKey: 'id' });
  assert.deepEqual(pg.warnings, ['key-uniqueness', 'null-key-ignored', 'subquery-recomputed']);
});
test('by-key: MySQL の更新対象自己参照も二重派生表になる', () => {
  const r = DmlBuilder.convertByKey('SELECT id FROM t WHERE active = 0', { dialect: 'mysql', targetTable: 't', outputKey: 'id' });
  assert.ok(r.delete.includes('DELETE FROM t WHERE id IN (SELECT /*+ NO_MERGE(sqlmegane_src) */ id FROM (SELECT id FROM t WHERE active = 0) sqlmegane_src)'), r.delete);
});
test('by-key: 引用識別子は大小文字を区別する', () => {
  const bad = DmlBuilder.convertByKey('SELECT id AS "Product_ID" FROM t', { dialect: 'postgres', targetTable: 't', outputKey: '"product_id"' });
  assert.equal(bad.reasonCode, 'key-not-in-output');
  const ok = DmlBuilder.convertByKey('SELECT id AS "Product_ID" FROM t', { dialect: 'postgres', targetTable: 't', outputKey: '"Product_ID"' });
  assert.equal(ok.status, 'ok');
});
test('by-key: unquoted outputKey は大小文字を区別しない', () => {
  assert.equal(DmlBuilder.convertByKey('SELECT ID FROM t', { dialect: 'mysql', targetTable: 't', outputKey: 'id' }).status, 'ok');
});
test('by-key: invariants の実測が偽なら proven にならない', () => {
  const inner = 'SELECT id FROM t';
  const generated = { update: 'UPDATE t SET c=0 WHERE id IN (SELECT id FROM (SELECT 1) sqlmegane_src);', delete: 'DELETE FROM t;', countSelect: 'SELECT COUNT(*) FROM t;' };
  const inv = DmlBuilder._internal.byKeyInvariants(generated, inner, 't', 'id');
  assert.equal(inv.innerOnce, false); assert.equal(Object.values(inv).every(Boolean), false);
});
test('by-key inspect: サブクエリ内の基底表も収集する', () => {
  const r = DmlBuilder.inspect('SELECT t.id, (SELECT MAX(x.v) FROM extras x) AS mx FROM things t WHERE EXISTS (SELECT 1 FROM flags f)', { dialect: 'postgres' });
  assert.deepEqual(r.tables.map((x) => x.name), ['things', 'extras', 'flags']);
  assert.equal(r.tables[0].where, 'outer'); assert.ok(r.tables.slice(1).every((x) => x.where === 'subquery'));
});
test('CLI by-key: DELETE を stdout に出して mode を JSON に含める', () => {
  const textResult = runCli(['convert', '--to', 'delete', '--dialect', 'postgres', '--target', 'products', '--by-key', 'product_id', '-'], byKeyWithId);
  assert.equal(textResult.status, 0, textResult.stderr); assert.match(textResult.stdout, /DELETE FROM products WHERE product_id IN/);
  const jsonResult = runCli(['convert', '--to', 'delete', '--dialect', 'postgres', '--target', 'products', '--by-key', 'product_id', '--json', '-'], byKeyWithId);
  assert.equal(jsonResult.status, 0, jsonResult.stderr); const value = JSON.parse(jsonResult.stdout);
  assert.equal(value.mode, 'by-key'); assert.ok(value.warnings.includes('null-key-ignored'));
});
test('CLI by-key: --target と --by-key は両方必須', () => {
  assert.equal(runCli(['convert', '--to', 'delete', '--dialect', 'mysql', '--target', 't', '-'], 'SELECT id FROM t').status, 1);
  assert.equal(runCli(['convert', '--to', 'delete', '--dialect', 'mysql', '--by-key', 'id', '-'], 'SELECT id FROM t').status, 1);
});
test('CLI inspect: tables / ctes / outputColumns を JSON で返す', () => {
  const r = runCli(['inspect', '--dialect', 'postgres', '-'], byKeyWithId);
  assert.equal(r.status, 0, r.stderr); const value = JSON.parse(r.stdout);
  assert.deepEqual(value.ctes, ['monthly_sales', 'ranked']); assert.ok(value.tables.some((x) => x.name === 'products'));
  assert.ok(value.outputColumns.some((x) => x.name === 'product_id'));
});
test('by-key i18n: 英語の理由と warning を返して日本語に戻せる', () => {
  globalThis.SQLMeganeI18n.setLocale('en');
  assert.match(globalThis.SQLMeganeI18n.t('dml.reason.key-not-in-output', { key: 'id', available: 'name' }), /not in the final SELECT output/);
  assert.match(globalThis.SQLMeganeI18n.t('dml.warning.null-key-ignored'), /NULL/);
  globalThis.SQLMeganeI18n.setLocale('ja');
  assert.match(globalThis.SQLMeganeI18n.t('dml.warning.subquery-recomputed'), /再評価/);
});
test('by-key UI: 対象表選択と warning 用の文言を i18n 経由で持つ', () => {
  assert.equal(globalThis.SQLMeganeI18n.t('ui.byKeyTitle'), '対象表とキーを選んで変換する');
  assert.match(readProjectFile('js/app.js'), /appendByKeyChooser/);
  assert.match(readProjectFile('css/style.css'), /conversion-warning/);
});

test('by-key: 行数制限（LIMIT / OFFSET / FETCH / TOP）のある SELECT は変換しない（上位 N 件は再評価で別の行になり得る）', () => {
  const B = globalThis.SQLMeganeDmlBuilder;
  const limited = B.convertByKey('SELECT id, score FROM scores s ORDER BY score DESC LIMIT 5', { dialect: 'postgres', targetTable: 'scores', outputKey: 'id' });
  assert.equal(limited.status, 'unsupported'); assert.equal(limited.reasonCode, 'row-limit');
  const noOrder = B.convertByKey('SELECT id FROM scores LIMIT 5', { dialect: 'mysql', targetTable: 'scores', outputKey: 'id' });
  assert.equal(noOrder.reasonCode, 'row-limit');
  const fetch = B.convertByKey('SELECT id FROM scores ORDER BY score DESC FETCH FIRST 5 ROWS ONLY', { dialect: 'oracle', targetTable: 'scores', outputKey: 'id' });
  assert.equal(fetch.reasonCode, 'row-limit');
  const top = B.convertByKey('SELECT TOP 5 id FROM scores ORDER BY score DESC', { dialect: 'mssql', targetTable: 'scores', outputKey: 'id' });
  assert.equal(top.reasonCode, 'row-limit');
  // CTE の中の行数制限は最終 SELECT の対象集合を決めないので拒否しない
  const inCte = B.convertByKey('WITH top5 AS (SELECT id FROM scores ORDER BY score DESC LIMIT 5) SELECT s.id FROM scores s JOIN top5 t ON t.id = s.id', { dialect: 'postgres', targetTable: 'scores', outputKey: 'id' });
  assert.equal(inCte.status, 'ok', JSON.stringify(inCte.reasonCodes));
  const plain = B.convertByKey('SELECT id, score FROM scores s ORDER BY score DESC', { dialect: 'postgres', targetTable: 'scores', outputKey: 'id' });
  assert.ok(!plain.delete.includes('ORDER BY score'), plain.delete);
  assert.ok(plain.delete.includes('removed the final ORDER BY'), plain.delete);
});
test('by-key: ロック句（FOR UPDATE / FOR SHARE）のある SELECT は変換しない', () => {
  const B = globalThis.SQLMeganeDmlBuilder;
  assert.equal(B.convertByKey('SELECT id FROM t WHERE x = 1 FOR UPDATE', { dialect: 'postgres', targetTable: 't', outputKey: 'id' }).reasonCode, 'lock-clause');
  assert.equal(B.convertByKey('SELECT id FROM t WHERE x = 1 FOR SHARE', { dialect: 'postgres', targetTable: 't', outputKey: 'id' }).reasonCode, 'lock-clause');
});
test('convert / convertByKey: 条件の部分を where として返す', () => {
  const B = globalThis.SQLMeganeDmlBuilder;
  const single = B.convert("SELECT id FROM t WHERE status = 'ACTIVE'", { dialect: 'postgres' });
  assert.equal(single.where, "WHERE status = 'ACTIVE'");
  const byKey = B.convertByKey("SELECT e.id, e.status FROM t e JOIN u ON u.id = e.id WHERE e.status = 'ACTIVE'", { dialect: 'postgres', targetTable: 't', outputKey: 'id' });
  assert.ok(byKey.where.startsWith('FROM t e JOIN u'), byKey.where);
  assert.ok(byKey.where.includes("WHERE e.status = 'ACTIVE'"), byKey.where);
  assert.ok(!byKey.where.includes('SELECT e.id, e.status'), byKey.where);
});
test('手順つきブロック: 更新する列が条件に含まれると、更新後の確認が 0 行になる注記と引き直し方に切り替わる', () => {
  const base = { dialect: 'postgres', client: 'generic', originalSelect: "SELECT id, status FROM t WHERE status = 'ACTIVE';", countSelect: "SELECT COUNT(*) FROM t WHERE status = 'ACTIVE';", dml: "UPDATE t SET status = 'LEFT' WHERE status = 'ACTIVE';", locale: 'ja', whereText: "WHERE status = 'ACTIVE'" };
  const masked = Templates.buildSafeBlock({ ...base, updatedColumns: ['status'] });
  assert.ok(masked.includes('更新する列（status）が条件に含まれる'), masked);
  assert.ok(masked.includes('WHERE <key> IN ('), masked);
  const other = Templates.buildSafeBlock({ ...base, updatedColumns: ['name'] });
  assert.ok(!other.includes('更新する列（'), other);
  assert.ok(other.includes('更新後の内容を確認'), other);
  const en = Templates.buildSafeBlock({ ...base, updatedColumns: ['e.status'], locale: 'en' });
  assert.ok(en.includes('(e.status) appear in the condition'), en);
});

test('by-key: 同名のキー出力が複数あれば ambiguous-key', () => {
  const r = DmlBuilder.convertByKey('SELECT a.id, b.id FROM t a JOIN t b ON a.parent_id = b.id', { dialect: 'postgres', targetTable: 't', outputKey: 'id' });
  assert.equal(r.status, 'unsupported'); assert.equal(r.reasonCode, 'ambiguous-key');
});
test('by-key: key-uniqueness warning を必ず返す', () => {
  const r = DmlBuilder.convertByKey('SELECT id FROM products', { dialect: 'postgres', targetTable: 'products', outputKey: 'id' });
  assert.ok(r.warnings.includes('key-uniqueness'));
});
test('by-key: SQL Server では WITH 句を文頭へ移し、派生表には最終 SELECT だけを入れる', () => {
  const sql = 'WITH recent AS (SELECT id FROM orders WHERE created_at > DATEADD(day, -7, GETDATE()))\nSELECT o.id, o.total FROM orders o JOIN recent r ON r.id = o.id WHERE o.total > 100';
  const r = DmlBuilder.convertByKey(sql, { dialect: 'mssql', targetTable: 'orders', outputKey: 'id' });
  assert.equal(r.status, 'ok', JSON.stringify(r.reasonCodes));
  assert.ok(r.delete.startsWith('WITH recent AS ('), r.delete);
  assert.ok(r.delete.includes('DELETE FROM orders WHERE id IN (SELECT id FROM (SELECT o.id, o.total FROM orders o JOIN recent r ON r.id = o.id WHERE o.total > 100) sqlmegane_src);'), r.delete);
  assert.ok(!r.delete.includes('(WITH'), r.delete);
  assert.ok(r.warnings.includes('mssql-cte-hoisted'));
  assert.equal(r.equivalence, 'proven', JSON.stringify(r.invariants));
  assert.equal(r.syntaxCheck.delete.ok, true, JSON.stringify(r.syntaxCheck.delete));
  const pg = DmlBuilder.convertByKey(sql.replace('DATEADD(day, -7, GETDATE())', "NOW() - INTERVAL '7 days'"), { dialect: 'postgres', targetTable: 'orders', outputKey: 'id' });
  assert.ok(pg.delete.includes('FROM (WITH recent AS ('), pg.delete);
  assert.ok(!pg.warnings.includes('mssql-cte-hoisted'));
});
test('by-key: MySQL では NO_MERGE ヒントを付け、warning を返す', () => {
  const r = DmlBuilder.convertByKey('SELECT id FROM t WHERE active = 0', { dialect: 'mysql', targetTable: 't', outputKey: 'id' });
  assert.ok(r.delete.includes('DELETE FROM t WHERE id IN (SELECT /*+ NO_MERGE(sqlmegane_src) */ id FROM (SELECT id FROM t WHERE active = 0) sqlmegane_src);'), r.delete);
  assert.ok(r.warnings.includes('mysql-no-merge'));
  assert.equal(r.equivalence, 'proven', JSON.stringify(r.invariants));
  assert.equal(r.syntaxCheck.delete.ok, true, JSON.stringify(r.syntaxCheck.delete));
  const pg = DmlBuilder.convertByKey('SELECT id FROM t WHERE active = 0', { dialect: 'postgres', targetTable: 't', outputKey: 'id' });
  assert.ok(!pg.delete.includes('NO_MERGE'), pg.delete);
});
test('手順つきブロック: DML の後に元 SELECT を再掲し、終端の説明に一括実行時の挙動を書く', () => {
  const base = { dialect: 'oracle', client: 'sqlplus-interactive', originalSelect: 'SELECT id FROM t WHERE x = 1;', countSelect: 'SELECT COUNT(*) FROM t WHERE x = 1;', dml: 'DELETE FROM t WHERE x = 1;', locale: 'ja' };
  const out = Templates.buildSafeBlock(base);
  const first = out.indexOf('SELECT id FROM t WHERE x = 1;'); const dmlAt = out.indexOf('DELETE FROM t WHERE x = 1;'); const second = out.indexOf('SELECT id FROM t WHERE x = 1;', dmlAt);
  assert.ok(first >= 0 && dmlAt > first && second > dmlAt, out);
  assert.ok(out.includes('予行演習'), out);
  assert.ok(Templates.buildSafeBlock({ ...base, commit: true }).includes('ROLLBACK を実行'), 'commit 版');
  const my = Templates.buildSafeBlock({ ...base, dialect: 'mysql', client: 'generic' });
  assert.ok(my.includes('Rows matched') && my.includes('InnoDB'), my);
});
test('検算SELECT（簡易チェック）: 結合を含む DML では結合表も FROM に入れる', () => {
  const upd = analyzeSQL("UPDATE employees e SET status = 'LEFT' FROM departments d WHERE e.dept_id = d.dept_id AND d.closed = 1;", 'oracle').statements[0];
  assert.ok(upd.verifySelect.includes('SELECT COUNT(*) FROM employees e, departments d WHERE e.dept_id = d.dept_id AND d.closed = 1;'), upd.verifySelect);
  assert.equal(upd.verifySelectHasJoin, true);
  const del = analyzeSQL('DELETE FROM employees e USING departments d WHERE e.dept_id = d.dept_id;', 'generic').statements[0];
  assert.ok(del.verifySelect.includes('FROM employees e, departments d WHERE'), del.verifySelect);
  const mj = analyzeSQL("UPDATE employees e JOIN departments d ON d.dept_id = e.dept_id SET e.status = 'LEFT' WHERE d.closed = 1;", 'oracle').statements[0];
  assert.ok(mj.verifySelect.includes('SELECT COUNT(*) FROM employees e JOIN departments d ON d.dept_id = e.dept_id WHERE d.closed = 1;'), mj.verifySelect);
  const dj = analyzeSQL('DELETE e FROM employees e JOIN departments d ON d.dept_id = e.dept_id WHERE d.closed = 1;', 'generic').statements[0];
  assert.ok(dj.verifySelect.includes('SELECT COUNT(*) FROM employees e JOIN departments d ON d.dept_id = e.dept_id WHERE d.closed = 1;'), dj.verifySelect);
  const plain = analyzeSQL('DELETE FROM orders o WHERE o.id IN (1, 2);', 'oracle').statements[0];
  assert.equal(plain.verifySelect, 'SELECT COUNT(*) FROM orders o WHERE o.id IN (1, 2);');
  assert.equal(plain.verifySelectHasJoin, false);
});

// ---------------------------------------------------------------------------
// Backup sets: keep all existing tests above unchanged.
const backupInput = "SELECT id, value FROM demo WHERE value = 'old';";
const backupOptions = { dialect: 'postgres', to: 'update', shape: 'single', backupTable: 'demo_bk', backupColumns: ['id', 'value'], keyColumns: ['id'], assignments: [{ column: 'value', value: "'new'" }], now: '2026-09-20T00:00:00Z', workId: 'a123', locale: 'en' };
const buildBackup = (options = {}, sql = backupInput) => DmlBuilder.backupSet(sql, { ...backupOptions, ...options });
for (const dialect of ['postgres', 'mysql', 'mssql', 'oracle']) {
  for (const to of ['update', 'delete']) {
    const r = buildBackup({ dialect, to });
    test(`backup ${dialect}/${to}: tier and original`, () => {
      assert.equal(r.status, 'ok'); assert.equal(r.originalSelect, backupInput);
      assert.equal(r.dialectTier, dialect === 'postgres' ? 'planned' : 'reference');
      assert.equal(r.compensation.tier, 'reference');
    });
    for (const name of ['prepare', 'precheck', 'backup', 'change']) test(`backup ${dialect}/${to}: ${name}`, () => {
      const s = r.stages[name]; assert.ok(s.title && s.passCondition && s.onFail);
      assert.match(s.sql, /Any SQL error/); assert.doesNotMatch(s.sql, /undefined/);
      if (name === 'prepare') assert.match(s.sql, /CREATE TABLE demo_bk/);
      else assert.doesNotMatch(s.sql, /CREATE TABLE/);
      if (name === 'precheck') assert.match(s.sql, /COUNT\(\*\).*demo_bk/);
      if (name === 'backup') { assert.match(s.sql, /INSERT INTO demo_bk \(id, value\) SELECT t.id, t.value/); assert.match(s.sql, /HAVING COUNT\(\*\) > 1/); assert.match(s.sql, /null_keys/); assert.match(s.sql, /ORDER BY b.id/); }
      if (name === 'change') { assert.match(s.sql, /t.id IN \(SELECT b.id FROM demo_bk b\)/); assert.doesNotMatch(s.sql, /value = 'old'/); }
      if (['backup', 'change'].includes(name)) assert.doesNotMatch(s.sql, /^\s*(ROLLBACK|COMMIT)\b/m);
    });
    test(`backup ${dialect}/${to}: independent finish`, () => {
      assert.match(r.stages.finish.rollback.sql, /^ROLLBACK/m); assert.doesNotMatch(r.stages.finish.rollback.sql, /^COMMIT/m);
      assert.match(r.stages.finish.commit.sql, /^COMMIT/m); assert.doesNotMatch(r.stages.finish.commit.sql, /^ROLLBACK/m);
      assert.match(r.stages.finish.commit.sql, /do not retry or compensate/);
    });
    test(`backup ${dialect}/${to}: compensation boundary`, () => {
      const s = Templates.get(`compensate-${to}`, dialect, { locale: 'en', identity: 'none' });
      assert.equal((s.match(/^-- ===== [123]\/3 /gm) || []).length, 3);
      assert.doesNotMatch(r.compensation.precheck.sql, /^(INSERT|UPDATE|MERGE|DELETE) /m);
      assert.match(r.compensation.apply.sql, /^(INSERT|UPDATE|MERGE) /m);
      assert.match(r.compensation.precheck.sql, to === 'update' ? /AS missing_keys/ : /AS present_keys/);
      assert.match(r.compensation.precheck.sql, /not a full restore/);
      assert.doesNotMatch(r.compensation.apply.sql, /^\s*(ROLLBACK|COMMIT)\b/m);
    });
  }
  test(`backup ${dialect}: direct NULL mismatch`, () => {
    const s = buildBackup({ dialect, assignments: [{ column: 'value', value: 'NULL' }] }).stages.change.sql;
    if (dialect === 'postgres') assert.match(s, /t.value IS DISTINCT FROM NULL/);
    else if (dialect === 'mysql') assert.match(s, /NOT \(t.value <=> NULL\)/);
    else { assert.match(s, /t.value IS NULL AND NULL IS NOT NULL/); assert.match(s, /t.value IS NOT NULL AND NULL IS NULL/); }
  });
}
const backupRejections = [
  ['assignment-columns-mismatch', { updateColumns: ['other'] }],
  ['backup-columns-required', { backupColumns: [] }], ['backup-columns-required', { backupColumns: ['*'] }],
  ['key-columns-required', { keyColumns: [] }], ['key-not-in-backup', { keyColumns: ['other'] }],
  ['update-columns-not-in-backup', { assignments: [{ column: 'other', value: '1' }] }],
  ['key-column-assigned', { assignments: [{ column: 'id', value: '1' }] }],
  ['duplicate-column', { backupColumns: ['id', 'id', 'value'] }], ['duplicate-column', { keyColumns: ['id', 'ID'] }],
  ['duplicate-column', { assignments: [{ column: 'value', value: '1' }, { column: 'value', value: '2' }] }],
  ['backup-table-same-as-target', { backupTable: 'demo' }], ['backup-name-too-long', { backupTable: 'x'.repeat(64) }],
  ['expression-assignment', { assignments: [{ column: 'value', value: 'value + 1' }] }],
  ['expression-assignment', { assignments: [{ column: 'value', value: 'NOW()' }] }],
  ['lock-method-undefined', { dialect: 'generic' }], ['lock-method-undefined', { shape: 'by-key' }],
  ['lock-method-undefined', { dialect: 'mysql', isolation: 'READ COMMITTED' }],
  ['unfilled-placeholder', { assignments: [] }], ['unfilled-placeholder', { backupTable: '<backup>' }],
  ['unfilled-placeholder', { assignments: [{ column: 'value', value: '<value>' }] }],
  ['unfilled-placeholder', { backupColumns: ['id', 'value; DROP TABLE demo'] }],
  ['insert-columns-not-in-backup', { insertColumns: ['id', 'other'] }],
  ['insert-columns-not-in-backup', { insertColumns: ['value'] }],
  ['partial-compensation-unsupported', { partial: true }],
];
backupRejections.forEach(([code, options], i) => test(`backup rejection ${i}: ${code}`, () => {
  const r = buildBackup(options); assert.equal(r.status, 'unsupported'); assert.ok(r.reasonCodes.includes(code));
  assert.equal(r.stages, null); assert.equal(r.compensation, null);
  for (const locale of ['ja', 'en']) assert.ok(globalThis.SQLMeganeI18n.messages[locale][`dml.reason.${code}`]);
}));
for (const [code, sql] of [
  ['cte-unsupported-v1', 'WITH x AS (SELECT id FROM demo) SELECT id FROM x'],
  ['join-unsupported-v1', 'SELECT a.id FROM demo a JOIN other b ON a.id = b.id'],
  ['grouping', 'SELECT COUNT(*) FROM demo'],
  ['subquery-predicate', 'SELECT id, value FROM demo WHERE id IN (SELECT id FROM other)'],
]) test(`backup existing shape: ${code}`, () => assert.ok(buildBackup({}, sql).reasonCodes.includes(code)));
test('backup postgres locks in INSERT and no trailing rollback', () => {
  assert.match(buildBackup().stages.backup.sql, /INSERT INTO[\s\S]*FOR UPDATE OF t;/);
  assert.doesNotMatch(buildBackup().stages.backup.sql.trim(), /ROLLBACK;$/);
});
test('backup SQL Server composite EXISTS and transaction contract', () => {
  const r = buildBackup({ dialect: 'mssql', to: 'delete', keyColumns: ['id', 'value'] });
  assert.match(r.stages.change.sql, /WHERE EXISTS \(SELECT 1 FROM demo_bk b WHERE t.id = b.id AND t.value = b.value\)/);
  assert.match(r.stages.precheck.sql, /SET IMPLICIT_TRANSACTIONS OFF;/);
  assert.match(r.stages.precheck.sql, /IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;/);
  assert.match(r.stages.backup.sql, /BEGIN TRANSACTION;\nSELECT @@TRANCOUNT/);
  assert.match(r.stages.backup.sql, /WITH \(UPDLOCK, HOLDLOCK\)/);
  assert.match(r.stages.finish.commit.sql, /COMMIT TRANSACTION;\nSELECT @@TRANCOUNT/);
});
test('backup generated name preserves schema and quoted escape', () => {
  assert.equal(DmlBuilder.backupName('public."a""b"', 'postgres', backupOptions), 'public."a""b_bk_20260920000000_a123"');
  assert.equal(buildBackup({ backupTable: undefined }).backupTable, 'demo_bk_20260920000000_a123');
});
test('backup generated name truncates by UTF-8 bytes', () => {
  const name = DmlBuilder.backupName('"' + 'あ'.repeat(30) + '"', 'postgres', backupOptions);
  assert.ok(Buffer.byteLength(name.slice(1, -1)) <= 63); assert.match(name, /_a123"$/);
});
test('backup supplied name length limits for each dialect', () => {
  for (const [dialect, max] of [['postgres', 63], ['mysql', 64], ['mssql', 128], ['oracle', 128]]) {
    assert.equal(buildBackup({ dialect, backupTable: 'b'.repeat(max) }).status, 'ok');
    assert.ok(buildBackup({ dialect, backupTable: 'b'.repeat(max + 1) }).reasonCodes.includes('backup-name-too-long'));
  }
});
test('backup assignments share SET, change check and compensation expected check', () => {
  const r = buildBackup({ backupColumns: ['id', 'value', 'other'], assignments: [{ column: 'value', value: 'NULL' }, { column: 'other', value: '12' }] }, "SELECT id, value, other FROM demo WHERE value = 'old';");
  assert.match(r.stages.change.sql, /SET value = NULL, other = 12/);
  for (const sql of [r.stages.change.sql, r.compensation.precheck.sql, r.compensation.apply.sql]) assert.match(sql, /t.value IS DISTINCT FROM NULL OR t.other IS DISTINCT FROM 12/);
});
test('backup ja/en translation keys remain identical', () => assert.deepEqual(Object.keys(globalThis.SQLMeganeI18n.messages.ja).sort(), Object.keys(globalThis.SQLMeganeI18n.messages.en).sort()));

const backupCli = await import('../cli/sqlmegane.mjs');
test('backup CLI all begins with separate-copy notice', () => {
  const opts = backupCli.parseSubcommand(['--to', 'delete', '--dialect', 'postgres', '--backup-table', 'demo_bk', '--backup-columns', 'id,value', '--key-columns', 'id', '--stage', 'all', '-'], 'convert');
  const output = backupCli.renderBackup(backupInput, opts);
  assert.equal(output.code, 0); assert.match(output.stdout, /^-- 一括貼り付け用ではありません/);
  assert.equal((output.stdout.match(/^-- ===== 段階 /gm) || []).length, 6);
});
test('backup CLI generic rejects with code 2 and reason', () => {
  const output = backupCli.renderBackup(backupInput, { ...backupOptions, dialect: 'generic', lang: 'en' });
  assert.equal(output.code, 2); assert.match(output.stderr, /\[lock-method-undefined\]/); assert.equal(output.stdout, '');
});
test('backup CLI JSON is the exact shared result', () => {
  const output = backupCli.renderBackup(backupInput, { ...backupOptions, json: true, lang: 'en' });
  assert.deepEqual(JSON.parse(output.stdout), output.result);
});
test('backup CLI every validator reason is shared', () => {
  for (const [code, options] of backupRejections) {
    const output = backupCli.renderBackup(backupInput, { ...backupOptions, ...options, byKey: options.shape === 'by-key' ? 'id' : undefined, lang: 'en' });
    assert.equal(output.code, 2); assert.ok(output.stderr.includes(`[${code}]`));
  }
});
test('backup CLI repeated structured assignments', () => {
  const opts = backupCli.parseSubcommand(['--to', 'update', '--set', "value='a=b'", '--set', 'other=NULL'], 'convert');
  assert.deepEqual(opts.assignments, [{ column: 'value', value: "'a=b'" }, { column: 'other', value: 'NULL' }]);
});
test('backup CLI individual stage has no DDL or termination', () => {
  const out = backupCli.renderBackup(backupInput, { ...backupOptions, stage: 'change', lang: 'en' });
  assert.doesNotMatch(out.stdout, /^(CREATE|COMMIT|ROLLBACK)/m); assert.equal(out.code, 0);
});
test('backup template identity none never promotes reference dialect', () => {
  for (const d of ['mysql', 'mssql', 'oracle']) assert.match(Templates.get('compensate-delete', d, { identity: 'none', locale: 'en' }), /^-- Reference template/);
});
test('backup compensation finish is split from template with separate executable endings', () => {
  const r = buildBackup();
  assert.match(r.compensation.finish.rollback.sql, /^ROLLBACK;/m);
  assert.doesNotMatch(r.compensation.finish.rollback.sql, /^COMMIT;/m);
  assert.match(r.compensation.finish.commit.sql, /^COMMIT;/m);
  assert.doesNotMatch(r.compensation.finish.commit.sql, /^ROLLBACK;/m);
  assert.match(r.compensation.finish.commit.sql, /all compensation 2\/3 checks passed/);
});
test('backup rejects unfilled bind parameters', () => {
  for (const value of [':id', '?', '$1']) assert.ok(buildBackup({}, `SELECT id,value FROM demo WHERE id=${value}`).reasonCodes.some((c) => ['unfilled-placeholder', 'parse-failed'].includes(c)));
});
test('backup quoted alias is rewritten without changing string literals', () => {
  const r = buildBackup({}, "SELECT d.id,d.value FROM demo d WHERE d.value='d.id';");
  assert.equal(r.status, 'ok'); assert.match(r.stages.backup.sql, /WHERE t.value='d.id'/);
});
test('backup compensation DELETE uses full backup and no duplicate-ignore syntax', () => {
  for (const dialect of ['postgres', 'mysql', 'mssql', 'oracle']) {
    const sql = buildBackup({ dialect, to: 'delete' }).compensation.apply.sql;
    assert.match(sql, /INSERT INTO demo \(id, value\) SELECT b.id, b.value FROM demo_bk b;/);
    assert.doesNotMatch(sql, /INSERT IGNORE|ON CONFLICT|ON DUPLICATE/);
  }
});

test('backup quoted case-sensitive columns cannot bypass subset validation', () => {
  const r = buildBackup({ assignments: [{ column: '"VALUE"', value: '1' }] });
  assert.ok(r.reasonCodes.includes('update-columns-not-in-backup'));
  const key = buildBackup({ keyColumns: ['"ID"'] });
  assert.ok(key.reasonCodes.includes('key-not-in-backup'));
});
test('backup Oracle MERGE keeps expected state outside ON', () => {
  const sql = buildBackup({ dialect: 'oracle' }).compensation.apply.sql;
  assert.match(sql, /ON \(t.id = b.id\) WHEN MATCHED THEN UPDATE SET t.value = b.value WHERE NOT/);
});
test('backup placeholder in SELECT output blocks A-D', () => {
  assert.equal(buildBackup({}, 'SELECT id, $1 FROM demo').status, 'unsupported');
});
// Blind test 2026-09-20: columns must exist in the SELECT output; SELECT * has no candidates.
test('backup rejects columns that are not direct SELECT output columns', () => {
  const star = buildBackup({}, "SELECT * FROM demo WHERE value = 'old';");
  assert.equal(star.status, 'unsupported'); assert.ok(star.reasonCodes.includes('column-not-in-select'));
  const missing = buildBackup({ backupColumns: ['id', 'value', 'other'] });
  assert.equal(missing.status, 'unsupported'); assert.ok(missing.reasonCodes.includes('column-not-in-select'));
  const badKey = buildBackup({ keyColumns: ['nope'], backupColumns: ['id', 'value', 'nope'] });
  assert.ok(badKey.reasonCodes.includes('column-not-in-select'));
  assert.equal(buildBackup({}).status, 'ok');
});
test('backup subquery predicate has its own reason code', () => {
  const r = buildBackup({}, "SELECT id, value FROM demo WHERE id IN (SELECT id FROM other);");
  assert.equal(r.status, 'unsupported'); assert.ok(r.reasonCodes.includes('subquery-predicate'));
  assert.ok(!r.reasonCodes.includes('lock-method-undefined'));
});
// Publish review 2026-09-20 (Codex): alias rewriting must never change literal or function meaning.
test('backup rejects predicates where alias rewriting would change meaning', () => {
  const bs = buildBackup({ dialect: 'mysql' }, "SELECT d.id, d.value FROM demo d WHERE d.value = 'x\\' d.id'");
  assert.equal(bs.status, 'unsupported'); assert.ok(bs.reasonCodes.includes('predicate-unsupported'));
  const fn = buildBackup({}, 'SELECT d.id, d.value FROM demo d WHERE d.fn(d.id) = 1');
  assert.equal(fn.status, 'unsupported'); assert.ok(fn.reasonCodes.includes('predicate-unsupported'));
  const comment = buildBackup({}, 'SELECT id, value FROM demo WHERE id = 1 -- hi');
  assert.equal(comment.status, 'unsupported'); assert.ok(comment.reasonCodes.includes('predicate-unsupported'));
  const block = buildBackup({}, 'SELECT id, value FROM demo WHERE /* c */ id = 1');
  assert.ok(block.reasonCodes.includes('predicate-unsupported'));
  const okLiteral = buildBackup({}, "SELECT d.id, d.value FROM demo d WHERE d.value = '-- d.id'");
  assert.equal(okLiteral.status, 'ok'); assert.match(okLiteral.stages.backup.sql, /t\.value = '-- d\.id'\nFOR UPDATE OF t;/);
});
test('backup identifier quoting follows the dialect', () => {
  assert.equal(buildBackup({ backupTable: '`demo_bk`' }).status, 'unsupported');
  assert.equal(buildBackup({ backupTable: '[demo_bk]' }).status, 'unsupported');
  assert.equal(buildBackup({ backupTable: '"demo_bk"' }).status, 'ok');
  assert.equal(buildBackup({ dialect: 'mysql', backupTable: '`demo_bk`' }).status, 'ok');
  assert.equal(buildBackup({ dialect: 'mysql', backupTable: '"demo_bk"' }).status, 'unsupported');
  assert.equal(buildBackup({ dialect: 'mssql', backupTable: '[demo_bk]' }).status, 'ok');
  // QUOTED_IDENTIFIER is not set by the generated SQL, so "x" is not accepted for SQL Server.
  assert.equal(buildBackup({ dialect: 'mssql', backupTable: '"demo_bk"' }).status, 'unsupported');
  // Unquoted identifier rules per dialect.
  assert.equal(buildBackup({ dialect: 'oracle', backupTable: '_demo_bk' }).status, 'unsupported');
  assert.equal(buildBackup({ dialect: 'oracle', backupTable: 'demo_bk#1' }).status, 'ok');
  assert.equal(buildBackup({ backupTable: 'demo#bk' }).status, 'unsupported');
});
// Publish review round 2 (Codex): Oracle alternative quoting and whole-row alias references.
test('backup rejects Oracle q-quoted strings and bare whole-row alias references', () => {
  for (const sql of ["SELECT d.id, d.value FROM demo d WHERE d.value = q'[it's d.id]'", "SELECT d.id, d.value FROM demo d WHERE d.value = nq'[it's d.id]'", "SELECT d.id, d.value FROM demo d WHERE d.value = Q'{x}'"]) {
    const r = buildBackup({ dialect: 'oracle' }, sql);
    assert.equal(r.status, 'unsupported', sql); assert.ok(r.reasonCodes.includes('predicate-unsupported'));
  }
  const row = buildBackup({}, 'SELECT d.id, d.value FROM demo d WHERE row_to_json(d) IS NOT NULL');
  assert.equal(row.status, 'unsupported'); assert.ok(row.reasonCodes.includes('predicate-unsupported'));
  // A column that merely contains the alias text (d_flag, seq_d) is not a bare alias.
  assert.equal(buildBackup({}, "SELECT d.id, d.value FROM demo d WHERE d.value = 'old' AND d_flag = 1").status, 'ok');
  // Dollar-quoted strings are literals, not comments.
  const dollar = buildBackup({}, 'SELECT d.id, d.value FROM demo d WHERE d.value = $$-- d.id$$');
  assert.equal(dollar.status, 'ok'); assert.match(dollar.stages.backup.sql, /t\.value = \$\$-- d\.id\$\$\nFOR UPDATE OF t;/);
});
// 2026-09-20 real-browser trial: a SELECT whose last line ends with a comment swallowed `) sqlmegane_src)` / `;`.
test('trailing line comment in the original SELECT does not swallow generated closing text', () => {
  const sql = 'WITH cs AS (SELECT user_id FROM orders WHERE total > 1)\nSELECT u.user_id FROM cs JOIN users u ON u.user_id = cs.user_id\nWHERE cs.user_id > 0 -- VIP\nORDER BY u.user_id;';
  const byKey = DmlBuilder.convertByKey(sql, { dialect: 'postgres', targetTable: 'orders', outputKey: 'user_id' });
  assert.equal(byKey.status, 'ok');
  for (const s of [byKey.delete, byKey.update, byKey.countSelect]) assert.match(s, /-- VIP\n\) sqlmegane_src\);$/);
  const single = DmlBuilder.convert('SELECT id FROM t_log WHERE id = 1 -- VIP', { dialect: 'postgres' });
  assert.equal(single.status, 'ok');
  for (const s of [single.delete, single.update, single.countSelect]) assert.match(s, /-- VIP\n;$/);
  // A `--` inside a string literal on the last line is not a comment; keep the terminator on the same line.
  const literal = DmlBuilder.convert("SELECT id FROM t_log WHERE note = 'a -- b'", { dialect: 'postgres' });
  assert.match(literal.delete, /'a -- b';$/);
  // Codex review: multi-line strings and block comments must not hide a real trailing line comment.
  const multi = DmlBuilder.convert("SELECT id FROM demo WHERE note = 'a\nb' -- 'VIP'", { dialect: 'postgres' });
  assert.match(multi.delete, /-- 'VIP'\n;$/);
  const blockThenLine = DmlBuilder.convert("SELECT id FROM demo WHERE id = 1 /* ' */ -- 'VIP'", { dialect: 'postgres' });
  assert.match(blockThenLine.delete, /-- 'VIP'\n;$/);
  const byKeyMulti = DmlBuilder.convertByKey("WITH cs AS (SELECT user_id FROM orders WHERE total > 1)\nSELECT u.user_id FROM cs JOIN users u ON u.user_id = cs.user_id\nWHERE u.note = 'a\nb' -- 'VIP'", { dialect: 'postgres', targetTable: 'orders', outputKey: 'user_id' });
  assert.match(byKeyMulti.delete, /-- 'VIP'\n\) sqlmegane_src\);$/);
  // Not comments: Oracle identifier with #, a block comment containing --, MySQL # only for MySQL.
  assert.match(DmlBuilder.convert('SELECT id FROM demo WHERE code# = 1', { dialect: 'oracle' }).delete, /code# = 1;$/);
  assert.match(DmlBuilder.convert('SELECT id FROM demo WHERE id = 1 /* -- VIP */', { dialect: 'postgres' }).delete, /\*\/;$/);
  assert.match(DmlBuilder.convert('SELECT id FROM demo WHERE id = 1 # VIP', { dialect: 'mysql' }).delete, /# VIP\n;$/);
  // Codex review round 2: $ inside identifiers, MySQL backslash escapes, nested block comments (PostgreSQL).
  const dollarIdent = DmlBuilder.convertByKey('SELECT id FROM demo WHERE code$tag$ = 1 -- VIP', { dialect: 'postgres', targetTable: 'demo', outputKey: 'id' });
  assert.match(dollarIdent.delete, /-- VIP\n\) sqlmegane_src\);$/);
  const myEscape = DmlBuilder.convert("SELECT id FROM demo WHERE note = 'a\\'b' -- VIP", { dialect: 'mysql' });
  assert.match(myEscape.delete, /-- VIP\n;$/);
  const myEscapeKey = DmlBuilder.convertByKey("SELECT id FROM demo WHERE note = 'a\\'b' -- VIP", { dialect: 'mysql', targetTable: 'demo', outputKey: 'id' });
  assert.match(myEscapeKey.delete, /-- VIP\n\) sqlmegane_src\);$/);
  const nested = DmlBuilder.convert("SELECT id FROM demo WHERE id = 1 /* outer /* inner */ ' */ -- VIP", { dialect: 'postgres' });
  assert.match(nested.delete, /-- VIP\n;$/);
  // Non-PostgreSQL block comments end at the first */ (the rest is not a comment).
  assert.match(DmlBuilder.convert("SELECT id FROM demo WHERE id = 1 /* a /* b */ AND id = 1", { dialect: 'mysql' }).delete, /AND id = 1;$/);
  // Backup stage A reuses the single-table count SELECT, so it must also terminate correctly.
  const backup = buildBackup({}, "SELECT id, value FROM demo WHERE value = 'old' AND id > 0");
  assert.equal(backup.status, 'ok'); assert.match(backup.stages.precheck.sql, /AND id > 0;\n/);
});
// Publish review round 3 (Codex): arrays hide alias references; SQL Server "x" anywhere; q-quote false positives.
test('backup rejects PostgreSQL array syntax and SQL Server double-quoted identifiers in the SELECT', () => {
  for (const sql of ['SELECT d.id, d.value FROM demo d WHERE array_to_json(ARRAY[d,d]) IS NOT NULL', 'SELECT d.id, d.value FROM demo d WHERE d.id = ANY(ARRAY[d.id])']) {
    const r = buildBackup({}, sql);
    assert.equal(r.status, 'unsupported', sql); assert.ok(r.reasonCodes.includes('predicate-unsupported'));
  }
  for (const sql of ['SELECT d.id, d.value FROM "demo" d WHERE d.id = 1', 'SELECT d.id, d.value FROM demo d WHERE "value" = \'old\'']) {
    const r = buildBackup({ dialect: 'mssql', backupTable: 'demo_bk' }, sql);
    assert.equal(r.status, 'unsupported', sql); assert.ok(r.reasonCodes.includes('unfilled-placeholder'));
  }
  assert.equal(buildBackup({ dialect: 'mssql', backupTable: 'demo_bk' }, 'SELECT d.id, d.value FROM [demo] d WHERE d.id = 1').status, 'ok');
  assert.equal(buildBackup({ dialect: 'postgres' }, 'SELECT d.id, d.value FROM `demo` d WHERE d.id = 1').status, 'unsupported');
  // Ordinary strings that merely contain q' are fine.
  assert.equal(buildBackup({}, "SELECT d.id, d.value FROM demo d WHERE d.value = 'q''abc'").status, 'ok');
  assert.equal(buildBackup({}, "SELECT d.id, d.value FROM demo d WHERE d.value = $$ q'abc $$").status, 'ok');
  assert.equal(buildBackup({ dialect: 'oracle' }, "SELECT d.id, d.value FROM demo d WHERE d.value = 'x' AND d.id = q'[1]'").status, 'unsupported');
});
test('backup duplicate detection respects quoted-identifier case per dialect', () => {
  const pg = buildBackup({ backupColumns: ['"id"', '"ID"', 'value'] }, 'SELECT "id", "ID", value FROM demo WHERE value = \'old\';');
  assert.ok(!pg.reasonCodes.includes('duplicate-column'));
  const my = buildBackup({ dialect: 'mysql', backupColumns: ['id', 'ID', 'value'] }, "SELECT id, ID, value FROM demo WHERE value = 'old';");
  assert.ok(my.reasonCodes.includes('duplicate-column'));
});
test('backup compensation stages are labelled reference even for postgres', () => {
  const r = buildBackup();
  for (const sql of [r.compensation.precheck.sql, r.compensation.apply.sql, r.compensation.finish.commit.sql]) assert.match(sql, /^-- Reference template/);
  assert.match(r.stages.backup.sql, /^-- Verified on PostgreSQL 18\.3/);
  assert.match(globalThis.SQLMeganeTemplates.get('compensate-update', 'postgres', { locale: 'en' }), /^-- Reference template/);
});
test('backup oracle legacy compatible shortens the default name to 30 bytes', () => {
  const r = buildBackup({ dialect: 'oracle', backupTable: undefined, oracleCompatible: 'legacy' }, "SELECT id, value FROM a_rather_long_table_name_here WHERE value = 'old';");
  assert.equal(r.status, 'ok'); assert.ok(Buffer.byteLength(r.backupTable) <= 30, r.backupTable);
  assert.ok(r.backupTable.endsWith('_bk_20260920000000_a123'));
});

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
