// Run only against a dedicated PostgreSQL 18 test database.
// Fixture/fault-injection SQL is handwritten; operation SQL comes unchanged from backupSet.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import '../cli/sqlmegane.mjs'; // Loads the same classic-script core without running the CLI.

if (!process.env.SQLMEGANE_PG) {
  console.log('skip: SQLMEGANE_PG is not set');
  process.exit(0);
}
const { Client } = await import('pg');
const B = globalThis.SQLMeganeDmlBuilder;
const split = (sql) => globalThis.SQLMeganeAnalyzer.splitStatements(sql, 'postgres');
const clients = [new Client({ connectionString: process.env.SQLMEGANE_PG }), new Client({ connectionString: process.env.SQLMEGANE_PG })];
const [a, x] = clients;
const runId = `${process.pid}_${Date.now()}`;
const names = new Set();
const functions = new Set();
const results = [];
let sequence = 0;
const rows = (result) => (Array.isArray(result) ? result : [result]).flatMap((r) => r.rows || []);
const number = (result, name) => Number(rows(result).find((r) => Object.hasOwn(r, name))?.[name]);
const query = (client, stage) => client.query(stage.sql);
const mismatchQuery = (stage) => {
  const sql = split(stage.sql).find((s) => /AS mismatches\b/.test(s));
  assert.ok(sql); return sql; // Extract a complete generated statement, never rewrite it.
};

async function fixture({ to = 'update', assignments = [{ column: 'value', value: "'new'" }], reordered = false } = {}) {
  const table = `sqlmegane_smoke_${runId}_${++sequence}`, backupTable = `${table}_bk`;
  names.add(table); names.add(backupTable);
  await a.query(`CREATE TABLE ${table} (id integer PRIMARY KEY, value text, other text);
    INSERT INTO ${table} VALUES (1, 'old', 'a'), (2, 'old', 'b');`);
  const options = { dialect: 'postgres', shape: 'single', to, backupTable, keyColumns: ['id'], backupColumns: ['id', 'value', 'other'], assignments, locale: 'en' };
  const r = B.backupSet(`SELECT id, value, other FROM ${table} WHERE id <= 2;`, options);
  assert.equal(r.status, 'ok');
  if (reordered) await a.query(`CREATE TABLE ${backupTable} (other text, value text, id integer);`);
  else await query(a, r.stages.prepare);
  return { table, backupTable, r, options };
}

async function blocked(client, sql, release) {
  let settled = false;
  // Attach rejection handling immediately; a failed assertion must not leak a rejection.
  const pending = client.query(sql).then((value) => { settled = true; return { value }; }, (error) => { settled = true; return { error }; });
  try {
    await delay(500);
    assert.equal(settled, false, 'concurrent statement must still be waiting after 500ms');
  } finally {
    await release();
  }
  const outcome = await pending;
  if (outcome.error) throw outcome.error;
  return outcome.value;
}

async function test(item, name, fn) {
  try { await fn(); results.push({ item, test: name, result: 'PASS' }); }
  catch (error) { results.push({ item, test: name, result: 'FAIL', detail: error.message }); process.exitCode = 1; }
  finally {
    await Promise.allSettled(clients.map((c) => c.query('ROLLBACK')));
  }
}

try {
  await Promise.all(clients.map((c) => c.connect()));
  const version = Number((await a.query('SHOW server_version_num')).rows[0].server_version_num);
  assert.ok(version >= 180000 && version < 190000, 'Release smoke tests require PostgreSQL 18');
  await Promise.all(clients.map((c) => c.query("SET statement_timeout = '10s'; SET default_transaction_isolation = 'read committed';")));

  await test(1, 'Every backed-up row blocks concurrent UPDATE and DELETE through C', async () => {
    for (const verb of ['UPDATE', 'DELETE']) for (const id of [1, 2]) {
      const { table, r } = await fixture();
      await query(a, r.stages.backup);
      await blocked(x, verb === 'UPDATE' ? `UPDATE ${table} SET value='concurrent' WHERE id=${id}` : `DELETE FROM ${table} WHERE id=${id}`, async () => {
        await query(a, r.stages.change);
        await query(a, r.stages.finish.rollback);
      });
    }
  });

  await test(2, 'One-statement snapshot: exclude new rows, back up updated locked values', async () => {
    const { table, backupTable, r } = await fixture();
    await x.query(`BEGIN; SELECT * FROM ${table} WHERE id=1 FOR UPDATE;`);
    await blocked(a, r.stages.backup.sql, async () => {
      await x.query(`INSERT INTO ${table} VALUES (0,'inserted','c'); UPDATE ${table} SET value='concurrent' WHERE id=1; COMMIT;`);
    });
    assert.deepEqual((await a.query(`SELECT id, value FROM ${backupTable} ORDER BY id`)).rows, [{ id: 1, value: 'concurrent' }, { id: 2, value: 'old' }]);
    // All rows actually backed up remain protected, including the row changed by X.
    await x.query("SET lock_timeout = '650ms'");
    for (const id of [1, 2]) await assert.rejects(x.query(`UPDATE ${table} SET value='blocked' WHERE id=${id}`), (e) => e.code === '55P03');
    await x.query("SET lock_timeout = '0'");
    await query(a, r.stages.change);
    await query(a, r.stages.finish.rollback);
  });

  await test(3, 'A rejects a nonempty backup', async () => {
    const { backupTable, r } = await fixture();
    await a.query(`INSERT INTO ${backupTable} VALUES (9,'existing','x')`);
    assert.equal(number(await query(a, r.stages.precheck), 'backup_count'), 1);
    // Deliberately stop here: B must not run.
  });

  await test(4, 'Backup INSERT error aborts transaction; rollback leaves target untouched', async () => {
    const { table, backupTable, r } = await fixture();
    await a.query(`ALTER TABLE ${backupTable} DROP COLUMN value`);
    await assert.rejects(query(a, r.stages.backup), (e) => e.code === '42703');
    await assert.rejects(a.query('SELECT 1'), (e) => e.code === '25P02');
    await query(a, r.stages.finish.rollback);
    assert.equal(Number((await a.query(`SELECT COUNT(*) FROM ${table} WHERE value='old'`)).rows[0].count), 2);
  });

  await test(5, 'All NULL comparison cases in C and compensation; one mismatching column', async () => {
    for (const [expected, actual, mismatch] of [['NULL', null, 0], ["'x'", null, 1], ['NULL', 'x', 1], ["'x'", 'x', 0], ["'x'", 'y', 1]]) {
      const { table, r } = await fixture({ assignments: [{ column: 'value', value: expected }, { column: 'other', value: "'same'" }] });
      await query(a, r.stages.backup); await query(a, r.stages.change);
      await a.query(`UPDATE ${table} SET value=$1 WHERE id=1`, [actual]); // Fault injection.
      assert.equal(number(await a.query(mismatchQuery(r.stages.change)), 'mismatches'), mismatch);
      assert.equal(number(await a.query(mismatchQuery(r.compensation.precheck)), 'mismatches'), mismatch);
      await query(a, r.stages.finish.rollback);
    }
  });

  await test(6, 'Compensation mismatch stops all writes and locks every target key', async () => {
    const { table, r } = await fixture();
    await query(a, r.stages.backup); await query(a, r.stages.change); await query(a, r.stages.finish.commit);
    await x.query(`UPDATE ${table} SET value='later' WHERE id=1`);
    assert.equal(number(await query(a, r.compensation.precheck), 'mismatches'), 1);
    const before = (await a.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
    await blocked(x, `UPDATE ${table} SET other='concurrent' WHERE id=1`, async () => {
      // Do not execute compensation.apply when the precheck fails.
      assert.deepEqual((await a.query(`SELECT * FROM ${table} ORDER BY id`)).rows, before);
      await query(a, r.compensation.finish.rollback);
    });
    assert.deepEqual((await a.query(`SELECT id,value FROM ${table} ORDER BY id`)).rows, [{ id: 1, value: 'later' }, { id: 2, value: 'new' }]);
  });

  await test(6, 'Successful UPDATE compensation uses the generated apply and postchecks', async () => {
    const { table, r } = await fixture();
    await query(a, r.stages.backup); await query(a, r.stages.change); await query(a, r.stages.finish.commit);
    assert.equal(number(await query(a, r.compensation.precheck), 'mismatches'), 0);
    assert.equal(number(await query(a, r.compensation.apply), 'mismatches'), 0);
    await query(a, r.compensation.finish.commit);
    assert.equal(Number((await a.query(`SELECT COUNT(*) FROM ${table} WHERE value='old'`)).rows[0].count), 2);
  });

  await test(7, 'DELETE compensation race fails with unique violation and rolls back all inserts', async () => {
    const { table, r } = await fixture({ to: 'delete' });
    await query(a, r.stages.backup); await query(a, r.stages.change); await query(a, r.stages.finish.commit);
    assert.equal(number(await query(a, r.compensation.precheck), 'present_keys'), 0);
    await x.query(`INSERT INTO ${table} VALUES (2,'racer','racer')`);
    await assert.rejects(query(a, r.compensation.apply), (e) => e.code === '23505');
    await query(a, r.compensation.finish.rollback);
    assert.deepEqual((await a.query(`SELECT id,value FROM ${table} ORDER BY id`)).rows, [{ id: 2, value: 'racer' }]);
  });

  await test(8, 'ROLLBACK removes backup and change; COMMIT makes both visible', async () => {
    for (const finish of ['rollback', 'commit']) {
      const { table, backupTable, r } = await fixture();
      await query(a, r.stages.backup); await query(a, r.stages.change); await query(a, r.stages.finish[finish]);
      assert.equal(Number((await x.query(`SELECT COUNT(*) FROM ${backupTable}`)).rows[0].count), finish === 'commit' ? 2 : 0);
      assert.equal(Number((await x.query(`SELECT COUNT(*) FROM ${table} WHERE value='new'`)).rows[0].count), finish === 'commit' ? 2 : 0);
    }
  });

  await test(9, 'Explicit column lists support a differently ordered backup table', async () => {
    const { backupTable, r } = await fixture({ reordered: true });
    await query(a, r.stages.backup);
    assert.deepEqual((await a.query(`SELECT id,value,other FROM ${backupTable} ORDER BY id`)).rows, [{ id: 1, value: 'old', other: 'a' }, { id: 2, value: 'old', other: 'b' }]);
    await query(a, r.stages.finish.rollback);
  });

  await test(10, 'Compensation does not restore cascade-deleted children or undo trigger effects', async () => {
    const { table, r } = await fixture({ to: 'delete' });
    const child = `${table}_child`, audit = `${table}_audit`, fn = `${table}_fn`;
    names.add(child); names.add(audit); functions.add(fn);
    await a.query(`CREATE TABLE ${child} (id integer REFERENCES ${table}(id) ON DELETE CASCADE);
      INSERT INTO ${child} VALUES (1),(2);
      CREATE TABLE ${audit} (event text);
      CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO ${audit} VALUES (TG_OP); RETURN NEW; END $$;
      CREATE TRIGGER smoke_audit AFTER INSERT OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}();`);
    await query(a, r.stages.backup); await query(a, r.stages.change); await query(a, r.stages.finish.commit);
    assert.equal(number(await query(a, r.compensation.precheck), 'present_keys'), 0);
    assert.equal(number(await query(a, r.compensation.apply), 'mismatches'), 0);
    await query(a, r.compensation.finish.commit);
    assert.equal(Number((await a.query(`SELECT COUNT(*) FROM ${child}`)).rows[0].count), 0);
    assert.deepEqual((await a.query(`SELECT event,COUNT(*)::int AS n FROM ${audit} GROUP BY event ORDER BY event`)).rows, [{ event: 'DELETE', n: 2 }, { event: 'INSERT', n: 2 }]);
  });

  await test(11, 'Nonzero A/B count mismatch after concurrent insert stops before C', async () => {
    const { table, r } = await fixture();
    const pre = await query(a, r.stages.precheck);
    const candidate = Number(rows(pre).find((row) => Object.hasOwn(row, 'count')).count);
    assert.equal(candidate, 2);
    await x.query(`INSERT INTO ${table} VALUES (0,'added','c')`);
    assert.equal(number(await query(a, r.stages.backup), 'backup_count'), 3);
    await query(a, r.stages.finish.rollback); // No C or COMMIT on mismatch.
  });

  await test(12, 'Shared validator rejects assignment and insert-column contract violations', async () => {
    const { table, options } = await fixture();
    for (const [patch, code] of [[{ assignments: [{ column: 'missing', value: '1' }] }, 'update-columns-not-in-backup'], [{ insertColumns: ['id', 'missing'] }, 'insert-columns-not-in-backup']]) {
      const r = B.backupSet(`SELECT id,value FROM ${table}`, { ...options, ...patch });
      assert.equal(r.status, 'unsupported'); assert.ok(r.reasonCodes.includes(code)); assert.equal(r.stages, null);
    }
  });
  results.push({ item: '4/manual', test: 'psql ON_ERROR_ROLLBACK on/off; NOWAIT failure procedure; client cancellation/disconnection and unknown COMMIT response', result: 'MANUAL' });
} catch (error) {
  results.push({ item: 'setup', test: 'Connect to PostgreSQL 18', result: 'FAIL', detail: error.message });
  process.exitCode = 1;
} finally {
  await Promise.allSettled(clients.map((c) => c.query('ROLLBACK')));
  try {
    // Every identifier is locally generated and tracked; never drop user-provided names.
    if (names.size) await a.query(`DROP TABLE IF EXISTS ${[...names].map((name) => { assert.match(name, /^sqlmegane_smoke_[0-9_]+(?:_bk|_child|_audit)?$/); return name; }).join(', ')} CASCADE`);
    for (const name of functions) { assert.match(name, /^sqlmegane_smoke_[0-9_]+_fn$/); await a.query(`DROP FUNCTION IF EXISTS ${name}()`); }
  } catch (error) {
    results.push({ item: 'cleanup', test: 'Remove smoke fixtures', result: 'FAIL', detail: error.message }); process.exitCode = 1;
  }
  await Promise.allSettled(clients.map((c) => c.end()));
  console.table(results);
}
