# SQLMegane — read your SQL back before you run it

*megane* = glasses in Japanese. Put your glasses on and read the statement before it touches production.

[日本語 README](README.md) | [Try it (English UI)](https://selene-nyx-ai.github.io/sqlmegane/en/) | [日本語 UI](https://selene-nyx-ai.github.io/sqlmegane/)

## What it is

SQLMegane takes the UPDATE / DELETE you are about to run by hand against a production database and reads it back to you as plain English: which table, which rows, what changes. It also flags common mistakes (missing WHERE, `1=1` left over from debugging, an outer join cancelled by WHERE, TRUNCATE vs DELETE) and generates a `SELECT COUNT(*)` with the same WHERE clause so you can check the row count first.

The readback is generated deterministically from an AST, without an LLM. For a given version and selected dialect, the output is repeatable, although parser and rule limitations can still produce an incorrect or incomplete reading. SQL analysis stays in the browser.

It is an early-stage tool and feedback is welcome. See [Author](#author) for who runs it.

## Try it

- Open **https://selene-nyx-ai.github.io/sqlmegane/en/** and paste SQL. No sign-up, no install.
- Or clone the repository and double-click `en/index.html`. It works from `file://` and offline; there is no build step and no server.

SQL analysis makes no network requests and stays in the browser. The app has no analytics or telemetry (see [Privacy & how it runs](#privacy--how-it-runs)).

Example. Paste `DELETE FROM t_log;` with the MySQL dialect and you get:

```
DELETE: deletes ALL rows of `t_log`
⚠ No WHERE clause — every row is affected.
[DANGER] DELETE without a WHERE clause: No WHERE clause was found. This deletes every row in the table. Confirm that a full-table delete is intended.
Verification SELECT: SELECT COUNT(*) FROM t_log;
```

Paste a statement that does have a WHERE clause and you get the filter as a sentence instead, which can help catch cases where the SQL does not match your intent:

```
UPDATE: updates rows in `m_users` where `last_login` < '2024-01-01', setting `status` = 'INACTIVE'
Verification SELECT: SELECT COUNT(*) FROM m_users WHERE last_login < '2024-01-01';
```

## Dialect support

## Build UPDATE / DELETE from SELECT

For a SELECT whose outer FROM contains one base table, SQLMegane can build an UPDATE, a DELETE, and a candidate row count SELECT with the same filter. The WHERE text is copied from the source, and UPDATE keeps `<column> = <value>` as an explicit placeholder. Always read generated SQL before using it. The candidate count is not the actual affected row count and can change because of concurrent work and transaction isolation.

The first version accepts single-table queries only. It returns a reason without SQL for JOINs, comma joins, CTEs, derived tables, set operations, aggregation, row limits, locking clauses, and other forms whose meaning cannot be proven to carry over. Syntax checking and the WHERE, target table, and other-table invariants are reported separately.

### Key IN form: choose the target table and key

The second form preserves an analytical SELECT containing CTEs, JOINs, and aggregation. Choose a base table (or enter another table) and a key returned by the final SELECT. Add a key such as `product_id` to the final output first if it is missing.

```sql
DELETE FROM products
WHERE product_id IN (
  SELECT product_id
  FROM (WITH ... SELECT product_id, ... FROM ranked WHERE ...) sqlmegane_src
);
```

Its equivalence is defined as: rows in the target table whose key value appears in the original SELECT result. SQLMegane does not move JOIN or WHERE conditions. It places the complete SELECT in one derived table. It removes the final SELECT's `ORDER BY`, which does not affect membership in the `IN` set and may be rejected inside a derived table, and records the removal in a generated comment.

A final SELECT with a row limit (`LIMIT` / `OFFSET` / `FETCH` / `TOP`) is not converted. A top-N query can pick different rows when the DML re-evaluates it unless `ORDER BY` is unique, and the tool cannot verify uniqueness. To act on exactly the rows you checked, save their keys to a temporary table and run the DML against that fixed set (a row limit inside a CTE does not decide the final result set and is not rejected). A SELECT with a locking clause (`FOR UPDATE` / `FOR SHARE`) is not converted either: some products do not accept it inside a derived table, and dropping it changes the locking semantics.

The generated result shows these warnings:

- Choose the primary key or a NOT NULL unique key of the target table (all columns of a composite key). With a non-unique column, rows that share a key value but did not appear in the SELECT are also updated or deleted. The tool cannot verify uniqueness.
- A `NULL` key does not match `IN`, so that row is not updated or deleted.
- The subquery is evaluated again when the DML runs and may differ from the SELECT result checked earlier.
- When the entered target is absent from the source query, check the table and key mapping.

When the final SELECT outputs the same key name more than once (self-joins, joins on same-named columns), the converter refuses because it cannot tell which table's column to filter on. Output the key once, with an alias if needed.

Dialect differences:

- **MySQL**: DML that reads the modified table in a subquery raises `ERROR 1093`. A materialized derived table is the documented exception, so the generated SQL adds `SELECT /*+ NO_MERGE(sqlmegane_src) */ ...`. Confirm it runs on your MySQL 8.0 version before use.
- **SQL Server**: `WITH` is not allowed inside a derived table, so the `WITH` clause is moved to the start of the statement and only the final SELECT goes into the derived table (`WITH ... DELETE FROM t WHERE k IN (SELECT k FROM (final SELECT) sqlmegane_src)`). The bundled parser cannot read `WITH ... DELETE`, so the syntax check parses the original WITH SELECT and the DML body separately.
- **PostgreSQL**: the whole `WITH ... SELECT` goes inside the derived table.
- **Oracle / Generic**: `WITH` cannot precede DML, so the derived-table form is used. These dialects have basic syntax checks only. Verify support for `WITH` inside a derived table on the database product and version you run.

For MySQL, PostgreSQL, and SQL Server, the bundled parser re-parses the generated statement. The check still fails when the original SELECT contains syntax from another dialect, such as PostgreSQL's `INTERVAL '90 days'` in a query checked as MySQL or SQL Server.

Always read the generated SQL before using it. The candidate count SELECT is an estimate of matching rows, not the affected-row count. A DELETE built from an aliased SELECT uses MySQL 8.0.16+ syntax (`DELETE FROM t AS a`); drop the alias on older MySQL. The CLI `convert` command prints danger and warning findings from the self-check to stderr (for example, DML built from a SELECT without WHERE).

The generated DELETE / UPDATE is run through the pre-execution checker. Nothing is shown when it is clean. If it is dangerous (no WHERE, an always-true WHERE, and so on), the top of the result shows what is wrong and how to change the original SELECT so it passes, and copying the DELETE / UPDATE and the safe block stays disabled until you tick "This is intended". Warnings (such as a leading % in LIKE) are shown in yellow and do not block copying.

## Back up before changing (backup → change → compensation)

Open the collapsed **Back up before changing** section below the SELECT converter. Specify a new backup table, explicitly select backup and key columns, and enter literal assignments for UPDATE. Candidates come from direct SELECT output columns; replace `SELECT *` with explicit columns first. Missing or unsupported input disables copying. This tool prepares SQL without connecting to a database.

| Dialect | Tier | Protection during backup |
|---|---|---|
| PostgreSQL | verified: 13 live-database checks passed on PostgreSQL 18.3 (2026-09-20, `npm run test:pg`) | INSERT SELECT with `FOR UPDATE OF t` in the same statement; READ COMMITTED supported |
| MySQL 8.0 | reference: based on official documentation, not database-tested | Both tables must use transactional engines such as InnoDB; REPEATABLE READ required. `FOR UPDATE` takes record and, depending on search/index/plan, gap or next-key locks; exact unique-key lookups may take only record locks |
| SQL Server | reference: based on official documentation, not database-tested | `UPDLOCK, HOLDLOCK`, including range protection and possible lock escalation |
| Oracle 19c+ | reference: based on official documentation, not database-tested | `LOCK TABLE ... IN EXCLUSIVE MODE` blocks writes to the whole table; ordinary reads can continue, FOR UPDATE waits |

Use **one new, initially empty backup table per operation**. Never append or reuse, even if an existing table is empty. Default names are `<table>_bk_<UTC yyyymmddhhmmss>_<4 characters>`, retaining schemas and quoting and shortening only the table-name portion to fit. Names are not guaranteed unique; change the work ID on collision. Limits: PostgreSQL 63 bytes, MySQL 64 characters, SQL Server 128 characters, Oracle 128 bytes with COMPATIBLE >= 12.2, otherwise 30 bytes (API: `oracleCompatible: 'legacy'`, CLI: `--oracle-compatible legacy`). Backup and key columns must be direct output columns of the SELECT (`SELECT *` and expression columns are rejected with `column-not-in-select`). A WHERE clause with a subquery is rejected with `subquery-predicate`. A WHERE clause containing a backslash, a comment, Oracle `q'…'` alternative quoting, an alias-qualified function call, or a bare whole-row alias reference (such as `row_to_json(d)`) is rejected with `predicate-unsupported`, because the alias cannot be rewritten safely. Quoted identifiers must use the dialect's own style (`"x"` for PostgreSQL / Oracle, `` `x` `` for MySQL, `[x]` only for SQL Server; `"x"` depends on QUOTED_IDENTIFIER and is not accepted).

| Empty-table method | Attribute inheritance |
|---|---|
| PostgreSQL CTAS | Does not inherit constraints or indexes |
| MySQL CTAS | Does not inherit AUTO_INCREMENT; inherits NOT NULL and DEFAULT; expressions may change types |
| Oracle CTAS | Conditionally inherits explicit NOT NULL; does not inherit PK, FK, indexes or defaults |
| SQL Server SELECT INTO | Simple direct column selection inherits IDENTITY, with exceptions for joins, unions and expressions. This feature defaults to CREATE TABLE with explicit column definitions instead |

Use five separate copies in an interactive client. Preparation DDL has a separate construction path from A–D. Keep B–D on the same connection and transaction.

1. **0: Preparation.** Use a dedicated connection with no pending work; create a new empty table with matching types, precision and collations. Oracle/MySQL DDL commits implicitly; Oracle commits before valid DDL even if execution fails. SQL Server’s column-definition placeholder must be filled manually in this separate preparation template.
2. **A: Precheck.** Confirm the backup is empty; inspect the original SELECT and record its candidate count. psql: autocommit ON, explicit BEGIN in B. Other clients must not commit between B and D. MySQL: autocommit=1, REPEATABLE-READ, both engines transactional, end A with ROLLBACK. Oracle: AUTOCOMMIT OFF, end A with ROLLBACK. SQL Server: IMPLICIT_TRANSACTIONS OFF, roll back any existing transaction at A’s end. Do not paste B on failure.
3. **B: Back up and check.** Start, lock and copy; require backup count = A’s candidate count = present key count, no duplicate rows, NULL keys or missing matches. SQL Server requires @@TRANCOUNT=1; stop if 2 or greater. Review the final key list. A is preliminary; equal counts do not prove equal sets. The backup defines the final target. No transaction-ending statement is appended.
4. **C: Change and check.** Change only backed-up keys, never reuse the original predicate. DELETE requires zero remaining target keys; UPDATE requires all keys present and zero value mismatches, including one-sided NULLs. Affected counts are supporting evidence only (MySQL counts changed rows). No transaction-ending statement is appended.
5. **D: Finish.** ROLLBACK is the default. COMMIT is a separate copy inside a disclosure and commits backup and change together, only after all checks pass. SQL Server requires @@TRANCOUNT=0 afterward. Record the backup table, time and chosen operation.

SQL errors, timeouts, cancellations and unknown check results are failures. If the transaction remains active on the same connection, roll back, confirm completion and restart. **On connection loss or an unknown COMMIT response, stop; do not retry or compensate.** A reconnecting ROLLBACK cannot undo a server-side commit. Confirm the original connection ended and establish the outcome from backup, target and work records. With psql `ON_ERROR_ROLLBACK=on`, later statements may still run after an error; the operator must stop.

**Proposed compensation SQL (not a full restore)** is a conditional template with three boundaries: begin/lock/precheck; compensation DML/postcheck; finish (separate ROLLBACK and COMMIT copies). UPDATE checks existence, one-to-one matching and expected post-change values, locking mismatching rows too. DELETE checks absence, which row locks cannot protect. Keys must be enforced by valid database constraints, all relevant unique constraints must be immediate, SQL Server IGNORE_DUP_KEY must be OFF, and duplicates must never be ignored. A concurrent insert must cause a constraint error and rollback of the entire compensation unit. Add checks for known non-key unique constraints manually. Confirm all recovery columns were backed up, omitted columns may receive DEFAULT/NULL, and no insert column is unwritable. `--identity none` describes column attributes only; it never promotes an untested dialect. `backupSet` cannot verify attributes and always returns compensation as reference.

Excluded: automatic compensation SQL generation (only conditional templates for human review are provided), batch execution, pasting the entire procedure at once, key-IN shapes, multiple tables, expression assignments, changing keys, generated keys, partial compensation, automatic column matching and per-column writability management. Compensation for identity/generated/computed/rowversion columns is reference only. FK cascades, triggers and audit side effects are not restored; those operations require a separate recovery procedure. Never compensate a rolled-back change. Check backup permissions and retention before starting; remove tables according to work records and organizational policy. No DROP is generated.

Additional conservative restrictions: predicates containing subqueries are rejected for every dialect. Assignment strings containing line breaks or backslashes, and TRUE/FALSE assignments for Oracle / SQL Server, are rejected because interpretation depends on product or settings. Declared update-column mismatches, invalid insert-column subsets and partial-compensation inputs also receive reason codes.

```sh
node cli/sqlmegane.mjs convert --to delete --dialect postgres --backup-table t_log_bk --backup-columns id,created_at --key-columns id --stage all -
node cli/sqlmegane.mjs convert --to update --dialect postgres --backup-columns id,status --key-columns id --set "status='DONE'" --stage change input.sql
node cli/sqlmegane.mjs template --kind compensate-delete --dialect postgres --identity none
```

`--stage` accepts `prepare|precheck|backup|change|rollback|commit|all`. `all` is for review, begins with a warning against pasting everything at once and separates the stages with headings. Rejections use the shared validator, print reason codes to stderr and exit with code 2. `--json` returns the exact `backupSet` result. Unsupported inputs never fall back to ordinary conversion.

`node tests/run-tests.mjs` checks generated strings and contracts. `npm run test:pg` skips without a `SQLMEGANE_PG` connection string; otherwise it runs generated SQL on PostgreSQL 18. 13 checks passed on PostgreSQL 18.3 on 2026-09-20 (see tests/pg-smoke.mjs). psql `ON_ERROR_ROLLBACK`, the NOWAIT failure procedure, and disconnection / unknown COMMIT outcomes cannot be automated; follow the operating notes above.

## Templates

Dialect-specific templates are available for UPDATE, DELETE, INSERT SELECT, UPSERT / MERGE, and CREATE TABLE. They appear in a separate preview and do not replace the current input. Fillable locations use only `<table>`, `<column>`, `<value>`, `<condition>`, `<key>`, and `<source>`. An unfilled placeholder outside strings and comments is reported as danger.

## Safe execution wrapper

Converted DML can be copied with a transaction start, the original SELECT, candidate count, DML, affected-row check, a post-change check (the original SELECT again), and a default ROLLBACK. The ROLLBACK version is meant to stop right after the DML for review; run as a whole, it ends with a rollback (dry run). To make the change permanent, run COMMIT yourself after reviewing, or use the COMMIT version, which requires confirmation before copying. A wrapper never contains both an executable COMMIT and an executable ROLLBACK. For MySQL, `ROW_COUNT()` after UPDATE counts changed rows only; check Rows matched for the matched count. When an UPDATE changes a column that also appears in the condition (`SET status = ... WHERE status = 'ACTIVE'`), the post-change SELECT returns 0 rows, so the wrapper switches to a note telling you to record the keys beforehand and re-check with `WHERE <key> IN (...)`. Oracle also supports SQL\*Plus interactive and batch wrappers. A transaction alone does not guarantee the same row set; choose isolation and locking where needed.

```sh
printf "SELECT id FROM m_users WHERE id = 1;" | node cli/sqlmegane.mjs convert --to update --dialect mysql --columns name,status -
printf "SELECT id FROM m_users WHERE id = 1;" | node cli/sqlmegane.mjs convert --to delete --dialect oracle --safe-block sqlplus-interactive -
node cli/sqlmegane.mjs inspect --dialect postgres report.sql
node cli/sqlmegane.mjs convert --to delete --dialect postgres --target products --by-key product_id report.sql
# If the target key has a different name: --target-key id
node cli/sqlmegane.mjs template --kind upsert --dialect postgres --lang en
```

Exit codes of `convert`: `0` = generated / `2` = generated, but the self-check of the output has a finding at or above `--fail-on` (default `danger`), such as a whole-table DELETE built from a SELECT without WHERE (the SQL still goes to stdout, findings to stderr; unfilled placeholders are not counted) / `3` = cannot convert (reason on stderr) / `4` = dialect could not be determined (`--dialect auto`) / `1` = usage or input error (for example an unknown dialect name). When piping the generated SQL into another command, gate on the exit code just as in analysis mode.

| Dialect selected | Analysis | English summary | Parser |
|---|---|---|---|
| MySQL | Parsed SQL (AST) | yes | bundled node-sql-parser (mysql) |
| PostgreSQL | Parsed SQL (AST) | yes | bundled node-sql-parser (postgresql) |
| SQL Server | Parsed SQL (AST) | yes | bundled node-sql-parser (transactsql) |
| Oracle | **Basic checks (no parser)** | no | none (regular-expression heuristics) |
| Generic | **Basic checks (no parser)** | no | none (regular-expression heuristics) |

- Oracle is not supported by node-sql-parser, so it falls back to regular-expression checks. The page shows a "Basic checks (no parser)" badge so you know which mode you are in.
- For Oracle, **PL/SQL units are recognized structurally and the DML inside them is extracted and checked one statement at a time** (`CREATE OR REPLACE PACKAGE / PACKAGE BODY / PROCEDURE / FUNCTION / TRIGGER / TYPE`, `DECLARE ... BEGIN ... END;`, anonymous `BEGIN ... END;`, each chunk terminated by a line containing only `/`). Bind and PL/SQL variables are kept as "value decided at runtime". Control flow (loops, branches, exception handling) is **not** analyzed, and the page says so every time.
- If a statement cannot be parsed in an AST dialect, **that statement only** falls back to basic checks, with a notice that includes the line number.
- Some syntax that the bundled PostgreSQL / SQL Server parser rejects but the MySQL parser accepts (for example `WITH ... DELETE`, which is valid PostgreSQL) is re-parsed once with the MySQL parser before giving up. When that happens the card shows a parser-fallback notice: the selected dialect's parser rejected the statement, so the MySQL parser was tried instead. This indicates a limitation of the bundled parser; it does not verify whether the statement is compatible with your selected database. Dialect-specific tips (such as the PostgreSQL RETURNING hint) are not shown for such statements.

## What it catches

The checker currently implements the following rules; see also [Known limitations](#known-limitations).

| Severity | Rule | What it means |
|---|---|---|
| danger | `no-where-update` | UPDATE without a WHERE clause (for `UPDATE ... JOIN ...` the wording becomes "every row matched by the JOIN is updated") |
| danger | `no-where-delete` | DELETE without a WHERE clause (the body DELETE is still checked when a `WITH ... AS (...)` CTE prefix is present) |
| danger | `always-true-where` | WHERE clause that is always true (`1=1`, `'a'='a'`, ...). Not reported when combined with a real condition such as `1=1 AND real_condition`, but reported when joined by a **top-level OR** such as `id=42 OR 1=1`. An `OR 1=1` inside parentheses (`a=1 AND (b=2 OR 1=1)`) does not widen the result to all rows and is not reported |
| danger | `left-join-where-cancellation` | **(AST only)** A column from the nullable side of a LEFT / RIGHT / FULL JOIN is filtered by an equality in the top-level AND of the WHERE clause. For LEFT or RIGHT JOIN, a null-rejecting WHERE condition on the nullable side removes the unmatched rows and can make the result equivalent to an INNER JOIN. For FULL JOIN, it reduces which unmatched rows are preserved but does not generally turn the join into an INNER JOIN. `IS NOT NULL` is exactly this cancellation and is reported; `IS NULL` (the deliberate anti-join pattern) is not. Conditions under an OR are not reported. Conditions inside a parenthesized AND group (`(a AND b) AND c`) are reported as long as there is no OR outside the parentheses |
| danger | `truncate-table` | TRUNCATE TABLE |
| danger | `drop-table` | DROP TABLE |
| danger | `drop-database` | DROP DATABASE |
| warning | `or-no-parens` | WHERE clause mixes OR and AND without parentheses (`a=1 OR b=2 AND c=3` may apply to more rows than intended). The AND in `BETWEEN x AND y` is excluded because it is not the logical operator |
| warning / danger | `not-in-null-risk` | **(AST only)** `NOT IN (SELECT ...)` is a warning (a single NULL in the subquery result excludes every row; `NOT EXISTS` is suggested). `NOT IN (1, NULL, 3)` with a literal NULL in the value list is danger, because three-valued logic makes the result empty before you even run it. A value list without NULL, such as `NOT IN (1,2,3)`, is not reported |
| warning | `like-leading-wildcard` | `LIKE '%...'` and other non-prefix LIKE patterns (they tend to match more than expected) |
| warning | `self-subquery-no-condition` | `IN (SELECT ... FROM same_table)` where the subquery has no WHERE clause (a common missing-correlation mistake) |
| warning | `implicit-conversion` | Flags a possible implicit conversion when a comparison uses a quoted numeric literal such as `id = '123'`. Without schema information, SQLMegane cannot determine whether a conversion actually occurs or affects an index |
| info (MySQL) | `mysql-no-limit` | UPDATE / DELETE without LIMIT. Not shown for a syntactically simple equality predicate (SQLMegane has no schema information and cannot tell whether the compared column is a primary key or unique), nor for multi-table UPDATE / DELETE (`DELETE a FROM a JOIN b ...`), which do not support LIMIT |
| warning (SQL Server, whole script) | `mssql-multi-no-begintran` | Several UPDATE / DELETE statements not wrapped in BEGIN TRAN (a BEGIN TRAN that only appears after the destructive statements counts as "not wrapped") |
| warning (Oracle) | `oracle-ddl-autocommit` | DDL (CREATE / ALTER / DROP / TRUNCATE) after DML in the same script (Oracle commits implicitly) |
| info (PostgreSQL) | `postgres-returning-tip` | UPDATE / DELETE without a RETURNING clause (a hint: RETURNING lets you see the changed rows) |
| info | `update-delete-join-basis` | **(AST only)** For UPDATE / DELETE with JOIN, states which table is actually changed or deleted from |
| info | `no-transaction` | A destructive statement is not wrapped in a BEGIN ... COMMIT transaction |
| info (whole paste) | `multiple-destructive` | A single paste contains more than one destructive operation |

Each finding comes with a short "why this is dangerous" and "what to do".

For statements that parse successfully, `no-where-update` / `always-true-where` / `or-no-parens` / `like-leading-wildcard` / `implicit-conversion` / `self-subquery-no-condition` / `mysql-no-limit` are evaluated on the AST instead of with regular expressions (same codes, same severities). Because the AST sees parentheses and subquery boundaries correctly, there are fewer false positives and misses. For example `WHERE (a = 1) OR b = 2 AND c = 3` was skipped by the regex version ("has parentheses, give up") but is reported as `or-no-parens` by the AST version.

The verification SELECT is also built from the AST's row source (the FROM-equivalent) when parsing succeeds, so T-SQL `UPDATE u SET ... FROM users u LEFT JOIN depts d ON ... WHERE ...` and MySQL `UPDATE t1 LEFT JOIN t2 ON ... SET ...` produce a runnable SELECT that keeps the JOIN. When the SELECT contains a JOIN, `COUNT(*)` returns the **joined** row count, which for a one-to-many join can be larger than the number of rows actually updated or deleted. In that case the generated SQL carries a comment saying so, and the card says so too.

Rules considered and deliberately not implemented (too many false positives with regex): SELECT without WHERE, general AND/OR precedence mistakes in the regex path (only "OR and AND mixed with no parentheses at all" is reported there; the AST path has no such restriction), full correlated-subquery verification (only the "same table referenced with no condition" pattern is checked), and always-false WHERE clauses such as `1=2` (a "0 rows updated" accident, deprioritized in favour of the all-rows kind).

## Why not just `--safe-updates` / DataGrip / a linter?

Keep using the database, IDE, review, and linting safeguards that fit your workflow. MySQL's `--safe-updates`, PostgreSQL's `safeupdate` extension, DataGrip's unsafe-query warning, DBCode, Bytebase's SQL review rules and linters such as SQLFluff, Squawk or SlowQL all cover ground that SQLMegane does not (server-side enforcement, IDE integration, migration safety, style, hundreds of rules). SQLMegane is a small layer next to them, and it is different in four ways:

1. **Readback, not just a block.** It turns the statement into one sentence ("updates rows in `m_users` where `last_login` < '2024-01-01', setting `status` = 'INACTIVE'") so you can compare it with what you meant. Missing-WHERE detection is table stakes; the sentence is where wrong-range mistakes get noticed. The readback is generated deterministically from an AST, without an LLM, and does not require sending SQL to a service. For a given version and selected dialect, the output is repeatable, although parser and rule limitations can still produce an incorrect or incomplete reading.
2. **"WHERE is there but it is still wrong" patterns.** `1=1` left from debugging, `OR 1=1` at the top level, an outer join cancelled by the WHERE clause, `NOT IN` with a NULL, DML hidden inside a PL/SQL package body, TRUNCATE where DELETE was meant.
3. **A verification SELECT you can paste right away**, generated from the same parsed WHERE clause and FROM source, including aliases and JOINs.
4. **Nothing to install, nothing to send.** A static browser app that works from a cloned directory over `file://`, no server, no account, no CDN, and a CLI that uses the same core with no dependencies beyond Node.js.

## CLI

The same analysis core runs from Node.js (18 or later). No `npm install` is needed.

```
node cli/sqlmegane.mjs --lang en planned.sql              # analyze a file
cat planned.sql | node cli/sqlmegane.mjs --lang en -      # from standard input
node cli/sqlmegane.mjs --lang en --dialect mysql --json planned.sql
```

Options:

- `--lang <ja|en>` output language (default `ja`)
- `--dialect <auto|generic|mysql|postgres|mssql|oracle>` (default `auto` = detect from the input)
- `--json` print the result as JSON (no AST is included)
- `--fail-on <danger|warning|info|never>` (default `danger`): if any finding is at or above this severity the process exits with **code 2**
- `--include-sql` include the full SQL text (`raw`, and `sql` for DML extracted from PL/SQL) in the output. Off by default
- `--max-bytes <N>` input size limit (default 5 MiB). Larger input exits with code 1

Exit codes: `0` = no finding at or above the threshold, `2` = at least one finding at or above the threshold, `1` = usage, input or internal error. DML found inside PL/SQL blocks counts toward the exit code.

Example output for `printf 'DELETE FROM t_log;' | node cli/sqlmegane.mjs --lang en --dialect mysql -`:

```
Dialect: mysql  Statements: 1

--- #1 DELETE ---
DELETE: deletes ALL rows of `t_log`
⚠ No WHERE clause — every row is affected.
[DANGER] DELETE without a WHERE clause: No WHERE clause was found. This deletes every row in the table. Confirm that a full-table delete is intended.
[INFO] Not wrapped in a transaction: No transaction start was found before this destructive statement. Use an explicit transaction when your database and operation support rollback.
Verification SELECT: SELECT COUNT(*) FROM t_log;
```

(exit code 2)

### Using it as a gate in CI or a pre-run hook

The CLI never executes SQL and never blocks anything by itself. It only reads the input and writes to stdout / stderr. The gate is the exit code, evaluated by whatever calls it:

```sh
node cli/sqlmegane.mjs --lang en --dialect mysql planned.sql && mysql -h prod-host mydb < planned.sql
```

The same pattern works in a CI job, a Makefile target, a git hook, or as a check that an AI coding agent must pass before a database step is allowed to run. Use `--fail-on warning` if you want warnings to stop the pipeline as well.

Two things to keep in mind:

- **Some SQL content is in the output even without `--include-sql`.** The summary, the findings and the verification SELECT contain table names, column names and WHERE literals (e-mail addresses, IDs, ...), because that is what a readback is. Check who can read your CI logs.
- **The CLI does not certify a statement as safe.** Only the implemented rules are checked, and by default anything below `danger` passes. A green exit code means "none of the known patterns matched", nothing more.

## Pre-run checklist

[CHECKLIST.md](CHECKLIST.md) (Japanese) is a checklist for running UPDATE / DELETE / TRUNCATE by hand against production, written to work with or without this tool, MIT-licensed so you can copy it into your team's runbook. In short:

1. **Say the statement as one sentence** ("set `status` to INACTIVE for rows in `m_users` whose last login is before 2024"). If you cannot, do not run it.
2. **Check the range (WHERE).** WHERE is present; no debug `1=1` / `OR 1=1`; parentheses when OR and AND are mixed; you know which table a JOINed UPDATE / DELETE actually changes; no null-rejecting WHERE condition on the nullable side of a LEFT JOIN (it can make the result equivalent to an INNER JOIN; move it to ON); for `IN` / `NOT IN (SELECT ...)`, run the subquery alone first (NULL in a `NOT IN` list makes non-matching rows UNKNOWN and drops them).
3. **DELETE vs TRUNCATE.** If you wrote TRUNCATE, you meant TRUNCATE. On regular tables it commits implicitly in Oracle and MySQL and cannot be rolled back; PostgreSQL and SQL Server can roll it back only inside an uncommitted transaction. Treat it as irreversible.
4. **Verification SELECT.** `SELECT COUNT(*)` with the same WHERE clause matches your expectation; for DELETE also record the table's total row count and stop if they are equal; look at a few rows with `SELECT *`; remember the count is a snapshot and compare with the affected-row count afterwards. The verification SELECT counts rows matching the reconstructed row source and WHERE clause. It is an estimate, not a prediction of the affected-row count; LIMIT/TOP, joins, concurrent changes, triggers, and database/client counting semantics can make the numbers differ.
5. **Transaction.** Before starting, check the autocommit setting and that no transaction is already open (in MySQL, issuing `BEGIN` inside an open transaction implicitly commits what came before). Start one explicitly: `BEGIN` (MySQL / PostgreSQL), `BEGIN TRANSACTION` (SQL Server); Oracle starts one with the first DML, so disable client autocommit. With SQL*Plus, check `SHOW AUTOCOMMIT` and `SET EXITCOMMIT` (EXITCOMMIT defaults to ON and commits on a normal exit even with AUTOCOMMIT OFF); always end with an explicit COMMIT or ROLLBACK. MySQL defaults to `autocommit=1` and psql also autocommits: without BEGIN the statement is final the moment it runs. Do not put COMMIT in the same block; look at the affected-row count first, then COMMIT or ROLLBACK. Consider running several destructive statements one at a time.
6. **Environment.** Confirm you are on production (host, database, prompt colour); if you run a selection in a GUI, the selection includes the whole WHERE clause; for large row counts think about lock time and replication lag (LIMIT, batches).

After running: compare the affected-row count with the verification count; record the COMMIT time and the exact SQL. If something goes wrong: do not "fix" it with more UPDATE / DELETE; record time, SQL and row count precisely; follow your incident procedure and let the DBA decide about stopping writes or a delayed replica; and check in calm times that backups / PITR / delayed replicas / binlog or WAL actually exist.

## Known limitations

- **A successful parse does not tell you whether the meaning is right.** The tool can only check what is mechanically readable from the structure. **"No danger detected" does not mean "safe".**
- **Oracle, Generic and any statement that failed to parse are handled by regular expressions and a simple state machine.** Deeply nested subqueries, complex vendor-specific syntax and dynamic SQL built from strings may not be analyzed correctly.
- Oracle-specific syntax (`(+)` outer-join notation, `CONNECT BY`, `MERGE`, ...) is not supported by the bundled parser.
- The bundled parser (node-sql-parser v5.4.0) **does not apply AND / OR precedence and builds a left-associative tree in source order** (`a=1 OR b=2 AND c=3` becomes `AND(OR(a,b), c)`). Used as is, the summary would present a wrong reading, so SQLMegane rebuilds the tree with SQL precedence (AND before OR) in `js/sql-ast.js` (`logicalTree`) before summarizing and checking.
- CTEs (`WITH` clauses): the leading `WITH ... AS (...)` prefix is skipped and the body UPDATE / DELETE / SELECT is checked, but malformed CTE definitions, nested CTEs and complex forms may not be handled.
- String literals, comments (`--`, `/* */`) and backtick / double-quote / bracket quoted identifiers are recognized, but **PostgreSQL dollar quoting (`$$...$$` / `$tag$...$tag$`) is not supported**. Statements containing it may be analyzed incorrectly.
- Backslash escapes inside string literals (`'it\'s bad'`) are recognized only when the MySQL dialect is selected. Other dialects follow standard SQL and do not treat the backslash specially.
- Table-name extraction handles `schema.table`, quoted identifiers and simple aliases (`AS alias` / `alias`), but complex schema qualification, dynamic identifiers and complex multi-table forms such as `DELETE t1 FROM t1 JOIN t2 ...` may not be handled.
- The verification SELECT counts rows matching the reconstructed row source and WHERE clause. It is an estimate, not a prediction of the affected-row count; LIMIT/TOP, joins, concurrent changes, triggers, and database/client counting semantics can make the numbers differ.
- Transaction detection is a string-based approximation. Nested transaction control inside procedures is not tracked correctly.
- **PL/SQL is not fully parsed.** The structure is read and DML is extracted; control flow (loops, branches, exception handling) is not analyzed. How many times an extracted statement actually runs, or what is rolled back on an exception, is not determined.
- Recognizing a PL/SQL unit requires a line containing only `/` (the SQL*Plus / SQLcl block terminator). Blocks without it are split on semicolons as usual. This is deliberately conservative so that T-SQL `BEGIN TRAN ... COMMIT` is not mistaken for a PL/SQL block.
- T-SQL `CREATE PROCEDURE ... AS BEGIN ... END` is outside the scope of the PL/SQL extraction.
- **"No danger detected" does not mean "safe".** This is an aid for reducing accidents; the final decision and the execution are always a human's.

## Privacy & how it runs

- **SQL analysis makes no network requests.** There is no server component and no account. The app has no analytics or telemetry. Its `Content-Security-Policy` (`default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; form-action 'none'`) blocks network connections and form submissions; user-initiated navigation through ordinary links (for example to GitHub) still works.
- **Works from `file://`.** Opening `index.html` or `en/index.html` by double-clicking is the primary use case. Earlier versions used ES modules, which browsers block under `file://` (the page looked fine but nothing happened on "Analyze"), so the scripts were changed to plain `<script src>` files that expose their API on `globalThis`. The CSP above was verified to load them under `file://` without violations.
- **No CDN.** The SQL parser is bundled in `js/vendor/`; nothing is fetched at runtime.
- **Bundled parser:** [node-sql-parser](https://github.com/taozhi8833998/node-sql-parser) v5.4.0, Apache-2.0 (full license text in `js/vendor/LICENSE-node-sql-parser`). The upstream UMD payloads are unchanged. The build script wraps each payload in an IIFE so the dialect builds do not overwrite one another's global `Parser`. About 890 KB in total for the three dialects (about 184 KB gzipped).
- **The English page** `en/index.html` is generated from `index.html` and the English messages in `js/i18n.js` by `node tools/build-en.mjs`; the analysis code is identical.
- Tests: `node tests/run-tests.mjs` (plain `assert`, no external dependencies; includes the CLI's output and exit codes).

## Author

Built and maintained by Selene, an AI assistant, under human supervision. A human reviews and approves published changes and is responsible for the project.

Bug reports, false positives and missed detections: [GitHub Issues](https://github.com/selene-nyx-ai/sqlmegane/issues). Questions and requests: [Discussions](https://github.com/selene-nyx-ai/sqlmegane/discussions/1). "Why it did not fit my workflow" is just as useful: [Discussions](https://github.com/selene-nyx-ai/sqlmegane/discussions/2).

## License

MIT. See [LICENSE](LICENSE). The bundled node-sql-parser is Apache-2.0 (see above).
