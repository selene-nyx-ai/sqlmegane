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
import '../js/analyzer.js';

const { analyzeSQL, splitStatements, _internal } = globalThis.SQLMeganeAnalyzer;

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

test('index.htmlのCTAフォームはidを持ち、app.js側でsubmitを防止している', () => {
  const html = readProjectFile('index.html');
  assert.match(html, /<form id="cta-form" class="cta-form">/);
  const appJs = readProjectFile('js/app.js');
  assert.match(appJs, /ctaForm[\s\S]*addEventListener\('submit'/);
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
