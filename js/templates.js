/** SQL templates and transaction wrappers. Classic script / global API. */
(function () {
'use strict';

const comments = {
  ja: {
    genericCheck: '製品のトランザクション構文を確認してください。',
    mysqlStart: '進行中のトランザクションがあると暗黙コミットされます。無いことと、対象表が InnoDB などトランザクション対応エンジンであることを確認してから実行してください。',
    oracleStart: 'Oracle は最初の DML で自動的に開始します。BEGIN は書きません。',
    inspect: '対象行を目で確認', count: '候補行数（実更新行数ではない。同時更新で変わる）',
    isolation: '同じトランザクション内でも同じ行集合は保証されません（分離レベル・ロックが必要）。',
    pgRows: 'クライアントのコマンドタグ（UPDATE n / DELETE n）を確認してください。',
    oraRows: 'SQL*Plus のフィードバック（n rows updated / deleted）を確認してください。',
    mysqlRows: 'ROW_COUNT() は UPDATE では既定で値が変わった行数です（同じ値を再設定した行は数えません。接続に CLIENT_FOUND_ROWS があれば一致行数）。一致行数は Rows matched で確認してください。',
    after: '更新後の内容を確認（DELETE なら 0 行。UPDATE で WHERE に更新した列が含まれる場合も 0 行になる）',
    afterMasked: '更新する列（{cols}）が条件に含まれるため、下の SELECT では更新後の値を確認できません（0 行になります）。更新前にキーを控えておき、SELECT ... FROM <table> WHERE <key> IN (<控えたキー>) で引き直してください。',
    rollback: 'ここで止めて、影響行数と内容を確認してください。この下まで一括で流すと取り消しになります（予行演習）。確定する場合は、確認のあと COMMIT を自分で実行してください。',
    commit: 'ここで止めて、影響行数と内容を確認してください。この下まで一括で流すと確定します。想定外なら COMMIT の代わりに ROLLBACK を実行してください。',
    genericMerge: '製品がこの MERGE 構文に対応するか確認してください。',
  },
  en: {
    genericCheck: 'Check the transaction syntax for your database product.',
    mysqlStart: 'An existing transaction may be committed implicitly. Run this only after confirming none is active and that the target table uses a transactional engine such as InnoDB.',
    oracleStart: 'Oracle starts a transaction with the first DML statement; do not write BEGIN.',
    inspect: 'Inspect the target rows', count: 'Candidate row count (not the actual affected row count; concurrent changes may alter it)',
    isolation: 'The same row set is not guaranteed within one transaction; an appropriate isolation level or locking is required.',
    pgRows: 'Check the client command tag (UPDATE n / DELETE n).',
    oraRows: 'Check SQL*Plus feedback (n rows updated / deleted).',
    mysqlRows: 'For UPDATE, ROW_COUNT() counts rows whose values changed by default (rows set to the same value are not counted; with CLIENT_FOUND_ROWS on the connection it counts matched rows). Check Rows matched for the matched count.',
    after: 'Inspect the rows after the change (0 rows for DELETE; also 0 rows for UPDATE when the WHERE clause uses an updated column)',
    afterMasked: 'The updated column(s) ({cols}) appear in the condition, so the SELECT below cannot show the new values (it returns 0 rows). Record the keys before the UPDATE and re-check with SELECT ... FROM <table> WHERE <key> IN (<recorded keys>).',
    rollback: 'Stop here and review the affected row count and contents. Running past this point rolls the change back (dry run). To make it permanent, run COMMIT yourself after reviewing.',
    commit: 'Stop here and review the affected row count and contents. Running past this point makes the change permanent. If anything is unexpected, run ROLLBACK instead of COMMIT.',
    genericMerge: 'Confirm that your database product supports this MERGE syntax.',
  },
};
function lang(locale) { return locale === 'en' ? 'en' : 'ja'; }
function c(text) { return `-- ${text}`; }

function get(kind, dialect, options) {
  const d = dialect || 'generic'; const l = lang(options && options.locale); const m = comments[l];
  if (['backup-table', 'compensate-update', 'compensate-delete'].includes(kind)) return backupTemplate(kind, d, options || {});
  const common = {
    update: 'UPDATE <table>\nSET <column> = <value>\nWHERE <condition>;',
    delete: 'DELETE FROM <table>\nWHERE <condition>;',
    'insert-select': 'INSERT INTO <table> (<column>)\nSELECT <column>\nFROM <source>\nWHERE <condition>;',
    'create-table': 'CREATE TABLE <table> (\n  <column> VARCHAR(255)\n);',
  };
  if (common[kind]) return common[kind];
  if (kind === 'merge' && d === 'postgres') return 'MERGE INTO <table> AS target\nUSING <source> AS source\nON target.<key> = source.<key>\nWHEN MATCHED THEN\n  UPDATE SET <column> = <value>\nWHEN NOT MATCHED THEN\n  INSERT (<key>, <column>) VALUES (source.<key>, <value>);';
  if (kind === 'upsert') {
    if (d === 'mysql') return 'INSERT INTO <table> (<key>, <column>)\nVALUES (<value>, <value>)\nON DUPLICATE KEY UPDATE <column> = <value>;';
    if (d === 'postgres') return 'INSERT INTO <table> (<key>, <column>)\nVALUES (<value>, <value>)\nON CONFLICT (<key>) DO UPDATE\nSET <column> = <value>;';
  }
  if (kind === 'merge' || kind === 'upsert') {
    const note = d === 'generic' ? `${c(m.genericMerge)}\n` : '';
    return `${note}MERGE INTO <table> target\nUSING <source> source\nON (target.<key> = source.<key>)\nWHEN MATCHED THEN\n  UPDATE SET target.<column> = <value>\nWHEN NOT MATCHED THEN\n  INSERT (<key>, <column>) VALUES (source.<key>, <value>);`;
  }
  if (kind === 'safe-block') return buildSafeBlock({ dialect: d, client: 'generic', originalSelect: 'SELECT <column> FROM <table> WHERE <condition>;', countSelect: 'SELECT COUNT(*) FROM <table> WHERE <condition>;', dml: common.update, locale: l });
  return '';
}

function buildSafeBlock(options) {
  const o = options || {}; const d = o.dialect || 'generic'; const client = o.client || 'generic';
  const l = lang(o.locale); const m = comments[l]; const commit = o.commit === true;
  const lines = [];
  if (d === 'oracle' && client !== 'generic') {
    lines.push('SET AUTOCOMMIT OFF', 'SET EXITCOMMIT OFF');
    if (client === 'sqlplus-batch') lines.push('WHENEVER SQLERROR EXIT SQL.SQLCODE ROLLBACK', 'WHENEVER OSERROR EXIT FAILURE ROLLBACK');
    lines.push('');
  }
  if (d === 'mysql') lines.push(c(m.mysqlStart), 'START TRANSACTION;');
  else if (d === 'postgres') lines.push('BEGIN;');
  else if (d === 'mssql') lines.push('BEGIN TRANSACTION;');
  else if (d === 'oracle') lines.push(c(m.oracleStart));
  else lines.push(c(m.genericCheck), 'START TRANSACTION;');
  lines.push('', c(m.isolation), '', c(m.inspect), String(o.originalSelect || '').trim(), '', c(m.count), String(o.countSelect || '').trim(), '', String(o.dml || '').trim(), '');
  if (d === 'mysql') lines.push('SELECT ROW_COUNT();', c(m.mysqlRows));
  else if (d === 'mssql') lines.push('SELECT @@ROWCOUNT AS affected_rows;');
  else if (d === 'postgres') lines.push(c(m.pgRows));
  else if (d === 'oracle') lines.push(c(m.oraRows));
  // 件数だけでは SET 値の誤りや連鎖変更に気づけないので、元 SELECT をもう一度流して内容を見る。
  // ただし更新する列が条件に含まれると再実行の SELECT は 0 行になり確認にならないので、その旨と引き直し方を書く
  const cols = Array.isArray(o.updatedColumns) ? o.updatedColumns.filter((x) => typeof x === 'string' && x.trim()) : [];
  const words = new Set(String(o.whereText || '').split(/[^A-Za-z0-9_$]+/).map((w) => w.toLowerCase()).filter(Boolean));
  const masked = cols.filter((col) => words.has(col.trim().replace(/^.*\./, '').replace(/^["`\[]|["`\]]$/g, '').toLowerCase()));
  lines.push('', c(masked.length ? m.afterMasked.replace('{cols}', masked.join(', ')) : m.after), String(o.originalSelect || '').trim());
  if (commit) lines.push('', c(m.commit), 'COMMIT;', '-- ROLLBACK;');
  else lines.push('', c(m.rollback), 'ROLLBACK;', '-- COMMIT;');
  if (d === 'oracle' && client === 'sqlplus-batch') lines.push('', commit ? 'EXIT' : 'EXIT ROLLBACK');
  return lines.join('\n') + '\n';
}

// Preparation has its own construction path; it is never part of the transaction stages.
function backupTemplate(kind, d, o) {
  const B = globalThis.SQLMeganeDmlBuilder;
  const t = (key) => B.backupMessage(key, o.locale);
  // bare: the caller (backupSet.stage) prints tier / pass / fail / errors itself, so skip them here.
  const head = o.bare ? '' : `-- ${t(d === 'postgres' ? 'planned' : 'reference')}\n-- ${t('errors')}\n`;
  const table = o.table || '<table>', bk = o.backupTable || '<backup_table>';
  const cols = o.columns || ['<column>'], keys = o.keys || ['<key>'];
  if (kind === 'backup-table') return `${head}${o.bare ? '' : `-- ${t('prepare.pass')}\n-- ${t('prepare.fail')}\n`}-- ${t('prepare.note')}\n${d === 'mssql' ? `CREATE TABLE ${bk} (<column_definitions>);` : `CREATE TABLE ${bk} AS SELECT ${cols.join(', ')} FROM ${table} WHERE 1 = 0;`}\n`;
  const assignments = o.assignments || [{ column: '<column>', value: '<expected_value>' }];
  const inserts = o.inserts || cols;
  const join = keys.map((k) => `t.${k} = b.${k}`).join(' AND ');
  const exists = `EXISTS (SELECT 1 FROM ${bk} b WHERE ${join})`;
  const count = `SELECT COUNT(*) AS backup_count FROM ${bk};`;
  const missing = `SELECT COUNT(*) AS missing_keys FROM ${bk} b WHERE NOT EXISTS (SELECT 1 FROM ${table} t WHERE ${join});`;
  const present = `SELECT COUNT(*) AS present_keys FROM ${table} t WHERE ${exists};`;
  const mismatch = assignments.map((a) => B.backupMismatch(d, `t.${a.column}`, String(a.value).trim())).join(' OR ');
  const start = d === 'postgres' ? 'BEGIN;' : d === 'mysql' ? 'START TRANSACTION;' : d === 'mssql' ? 'SET IMPLICIT_TRANSACTIONS OFF;\nBEGIN TRANSACTION;\nSELECT @@TRANCOUNT AS transaction_count;' : '';
  const locks = d === 'oracle' ? `LOCK TABLE ${table} IN EXCLUSIVE MODE;` : `SELECT ${keys.map((k) => `t.${k}`).join(', ')} FROM ${table} t${d === 'mssql' ? ' WITH (UPDLOCK, HOLDLOCK)' : ''} WHERE ${exists}${d === 'postgres' ? ' FOR UPDATE OF t' : d === 'mysql' ? ' FOR UPDATE' : ''};`;
  const duplicate = `SELECT ${keys.join(', ')}, COUNT(*) FROM ${bk} GROUP BY ${keys.join(', ')} HAVING COUNT(*) > 1;`;
  const nulls = `SELECT COUNT(*) AS null_keys FROM ${bk} b WHERE ${keys.map((k) => `b.${k} IS NULL`).join(' OR ')};`;
  const isUpdate = kind === 'compensate-update';
  const precheck = isUpdate ? `${locks}\n${missing}\n${present}\nSELECT COUNT(*) AS mismatches FROM ${table} t WHERE ${exists} AND (${mismatch});` : present;
  const set = assignments.map((a) => `${['oracle', 'mysql'].includes(d) ? 't.' : ''}${a.column} = b.${a.column}`).join(', ');
  // Direct mismatch tests are two-valued, so their negation is safe for the expected-state guard.
  const guard = `NOT (${mismatch})`;
  const update = d === 'oracle' ? `MERGE INTO ${table} t USING ${bk} b ON (${join}) WHEN MATCHED THEN UPDATE SET ${set} WHERE ${guard};`
    : d === 'mysql' ? `UPDATE ${table} t JOIN ${bk} b ON ${join} SET ${set} WHERE ${guard};`
    : d === 'mssql' ? `UPDATE t SET ${set} FROM ${table} t JOIN ${bk} b ON ${join} WHERE ${guard};`
    : `UPDATE ${table} t SET ${set} FROM ${bk} b WHERE ${join} AND ${guard};`;
  const write = isUpdate ? update : `INSERT INTO ${table} (${inserts.join(', ')}) SELECT ${inserts.map((c) => `b.${c}`).join(', ')} FROM ${bk} b;`;
  const restored = (isUpdate ? assignments.map((a) => a.column) : inserts).map((col) => B.backupMismatch(d, `t.${col}`, `b.${col}`)).join(' OR ');
  const postcheck = `${count}\n${missing}\n${present}\nSELECT COUNT(*) AS mismatches FROM ${table} t JOIN ${bk} b ON ${join} WHERE ${restored};`;
  const section = (n, key, body) => `-- ===== ${n}/3 ${t(`${key}.title`)} =====\n-- ${t(`${key}.pass`)}\n-- ${t(`${key}.fail`)}\n-- ${t('errors')}\n${body}\n`;
  return `${head}-- ${t('compensation')}\n-- ${t('compNote')}\n-- ${t('scope')}\n${o.identity === 'none' ? '' : `-- ${t('identity')}\n`}${isUpdate ? '' : `-- ${t('deleteContract')}\n`}`
    + section(1, 'compPrecheck', `-- ${t('connection')}\n-- ${t(`connection.${d}`) || t('reference')}\n${start}\n${count}\n${duplicate}\n${nulls}\n${precheck}`)
    + section(2, 'compApply', `-- ${t('compApply.start')}\n${write}\n${postcheck}`)
    + `-- ===== 3/3 ${t('rollback.title')} / ${t('commit.title')} =====\n-- ${t('errors')}\n-- ${t('unknown')}\n-- ${t('rollback.pass')}\n-- ${t('rollback.fail')}\n-- ${bk} | ${new Date(o.now === undefined ? Date.now() : o.now).toISOString()} | ROLLBACK\nROLLBACK${d === 'mssql' ? ' TRANSACTION' : ''};${d === 'mssql' ? '\nSELECT @@TRANCOUNT AS transaction_count;' : ''}\n-- ----- COMMIT -----\n-- ${t('errors')}\n-- ${t('unknown')}\n-- ${t('compCommit.pass')}\n-- ${t('commit.fail')}\n-- ${bk} | ${new Date(o.now === undefined ? Date.now() : o.now).toISOString()} | COMMIT\n-- COMMIT${d === 'mssql' ? ' TRANSACTION' : ''};\n${d === 'mssql' ? '-- SELECT @@TRANCOUNT AS transaction_count;\n' : ''}`;
}

globalThis.SQLMeganeTemplates = { get, buildSafeBlock, comments };
})();
