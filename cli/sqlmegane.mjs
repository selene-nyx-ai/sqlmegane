#!/usr/bin/env node
// SQLMegane（SQLめがね）CLI。ブラウザ版と同じ解析コアを Node から呼び、
// 実行前の SQL を日本語で読み返す。CI や実行前フックに組み込むためのもの。
//
//   node cli/sqlmegane.mjs [オプション] [--] [ファイル.sql | -]
//
//   --dialect <auto|generic|mysql|postgres|mssql|oracle>  方言（既定: auto = 自動判定）
//   --json                                                 解析結果を JSON で出力
//   --fail-on <danger|warning|info|never>                  この重要度以上の指摘があれば終了コード 2（既定: danger）
//   --include-sql                                          出力に SQL 全文（raw / sql）を含める（既定: 含めない）
//   --max-bytes <N>                                        入力の上限バイト数（既定: 5242880 = 5 MiB）
//   -h, --help                                             使い方
//
// ファイルを省略するか '-' を指定すると標準入力から読む。
// 終了コード: 0 = 指摘が閾値未満 / 2 = 閾値以上の指摘あり / 1 = 使い方エラー・入力エラー・内部エラー
//
// この CLI は SQL を実行しない。ファイルの読み込みと標準出力・標準エラーへの書き出し以外に外部へ触れない。
// 終了コードを呼び出し側（CI・フック）で判定して初めて後続処理を止められる。
// 検出できるのは実装済みのルールに限られ、SQL の安全性を保証するものではない。
//
// 出力に含まれる SQL の内容について: 既定では SQL の全文（raw / PL/SQL 内の sql）は出さないが、
// 要約・指摘・検算SELECT にはテーブル名・列名・WHERE 句の条件やリテラルが含まれる（それが要約の役割）。
// CI ログの閲覧範囲に注意すること。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// js/*.js は file:// 直開き対応のため ESM export を使わず globalThis に公開する
// 通常スクリプト。index.html と同じ順序で副作用インポートする（tests/run-tests.mjs と同じ方式）。
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

const { analyzeSQL, SEVERITY_ORDER } = globalThis.SQLMeganeAnalyzer;
const { summaryToLines } = globalThis.SQLMeganeSummarizer;
const { detectDialect } = globalThis.SQLMeganeDialectDetect;
const DmlBuilder = globalThis.SQLMeganeDmlBuilder;
const Templates = globalThis.SQLMeganeTemplates;
const I18n = globalThis.SQLMeganeI18n;
const t = (key, params) => I18n.t(key, params);

const DIALECTS = ['auto', 'generic', 'mysql', 'postgres', 'mssql', 'oracle'];
const FAIL_ON = ['danger', 'warning', 'info', 'never'];
const SEVERITY_LABEL = { danger: '【危険】', warning: '【警告】', info: '【情報】' };
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

class UsageError extends Error {}
class InputError extends Error {}

function usageText() {
  const me = path.basename(fileURLToPath(import.meta.url));
  if (I18n.getLocale() === 'en') return t('cli.usage', { name: me, max: DEFAULT_MAX_BYTES });
  return [
    `使い方: node cli/${me} [オプション] [--] [ファイル.sql | -]`,
    '',
    '  --dialect <auto|generic|mysql|postgres|mssql|oracle>  方言（既定: auto）',
    '  --oracle-version <legacy|23>                          Oracle バージョン（既定: legacy）',
    '  --lang <ja|en>                                        出力言語（既定: ja）',
    '  --json                                                 JSON で出力',
    '  --fail-on <danger|warning|info|never>                  終了コード 2 にする重要度の閾値（既定: danger）',
    '  --include-sql                                          出力に SQL 全文を含める（既定: 含めない）',
    `  --max-bytes <N>                                        入力の上限バイト数（既定: ${DEFAULT_MAX_BYTES}）`,
    '  -h, --help                                             この使い方',
    '',
    'ファイルを省略するか - を指定すると標準入力から読みます。',
    '終了コード: 0 = 閾値未満 / 2 = 閾値以上の指摘あり / 1 = 使い方・入力・内部エラー',
  ].join('\n') + '\n';
}

function parseArgs(argv) {
  const opts = { dialect: 'auto', oracleVersion: 'legacy', lang: 'ja', json: false, failOn: 'danger', includeSql: false, maxBytes: DEFAULT_MAX_BYTES, file: null, help: false };
  const takeValue = (name, i) => {
    const v = argv[i + 1];
    if (v === undefined || (v.startsWith('-') && v !== '-')) throw new UsageError(I18n.getLocale() === 'en' ? t('cli.err.value', { option: name }) : `${name} には値が必要です。`);
    return v;
  };
  let positionalOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!positionalOnly && a === '--') { positionalOnly = true; continue; }
    if (!positionalOnly && a.startsWith('-') && a !== '-') {
      if (a === '-h' || a === '--help') opts.help = true;
      else if (a === '--json') opts.json = true;
      else if (a === '--include-sql') opts.includeSql = true;
      else if (a === '--dialect') opts.dialect = takeValue(a, i++);
      else if (a.startsWith('--dialect=')) opts.dialect = a.slice('--dialect='.length);
      else if (a === '--oracle-version') opts.oracleVersion = takeValue(a, i++);
      else if (a.startsWith('--oracle-version=')) opts.oracleVersion = a.slice('--oracle-version='.length);
      else if (a === '--lang') { opts.lang = takeValue(a, i++); I18n.setLocale(opts.lang); }
      else if (a.startsWith('--lang=')) { opts.lang = a.slice('--lang='.length); I18n.setLocale(opts.lang); }
      else if (a === '--fail-on') opts.failOn = takeValue(a, i++);
      else if (a.startsWith('--fail-on=')) opts.failOn = a.slice('--fail-on='.length);
      else if (a === '--max-bytes') opts.maxBytes = Number(takeValue(a, i++));
      else if (a.startsWith('--max-bytes=')) opts.maxBytes = Number(a.slice('--max-bytes='.length));
      else throw new UsageError(I18n.getLocale() === 'en' ? t('cli.err.option', { option: a }) : `不明なオプション: ${a}`);
      continue;
    }
    if (opts.file !== null) throw new UsageError(I18n.getLocale() === 'en' ? t('cli.err.file') : 'ファイルは 1 つだけ指定してください。');
    opts.file = a;
  }
  if (!DIALECTS.includes(opts.dialect)) throw new UsageError(I18n.getLocale() === 'en' ? t('cli.err.dialect', { values: DIALECTS.join(', '), value: opts.dialect }) : `--dialect は ${DIALECTS.join(' / ')} のいずれかです: ${opts.dialect}`);
  if (!['legacy', '23'].includes(opts.oracleVersion)) throw new UsageError('--oracle-version must be legacy or 23');
  if (!I18n.locales.includes(opts.lang)) throw new UsageError(I18n.getLocale() === 'en' ? t('cli.err.lang') : '--lang は ja / en のいずれかです。');
  if (!FAIL_ON.includes(opts.failOn)) throw new UsageError(I18n.getLocale() === 'en' ? t('cli.err.failOn', { values: FAIL_ON.join(', '), value: opts.failOn }) : `--fail-on は ${FAIL_ON.join(' / ')} のいずれかです: ${opts.failOn}`);
  if (!Number.isInteger(opts.maxBytes) || opts.maxBytes <= 0) throw new UsageError(I18n.getLocale() === 'en' ? t('cli.err.maxBytes') : '--max-bytes は正の整数で指定してください。');
  return opts;
}

/**
 * 入力をストリームで読み、実際に読んだバイト数で上限を判定する。
 * 通常ファイルは stat のサイズで早期に拒否するが、最終判定は読んだバイト数で行う
 * （stat 後の追記や、stat のサイズが実データ量を表さない名前付きパイプ等に備える）。
 */
async function readInput(file, maxBytes) {
  let stream;
  if (file === null || file === '-') {
    stream = process.stdin;
  } else {
    let size = null;
    try {
      size = fs.statSync(file).size;
    } catch (err) {
      throw new InputError(I18n.getLocale() === 'en' ? t('cli.err.read', { message: err.code || err.message }) : `読み込みに失敗しました: ${err.code || err.message}`);
    }
    if (size > maxBytes) throw new InputError(I18n.getLocale() === 'en' ? t('cli.err.size', { max: maxBytes }) : `入力が上限（${maxBytes} バイト）を超えています（${size} バイト）。--max-bytes で上限を変更できます。`);
    stream = fs.createReadStream(file);
  }
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        if (typeof stream.destroy === 'function') stream.destroy();
        throw new InputError(I18n.getLocale() === 'en' ? t('cli.err.size', { max: maxBytes }) : `入力が上限（${maxBytes} バイト）を超えています。--max-bytes で上限を変更できます。`);
      }
      chunks.push(buf);
    }
  } catch (err) {
    if (err instanceof InputError) throw err;
    throw new InputError(I18n.getLocale() === 'en' ? t('cli.err.read', { message: err.code || err.message }) : `読み込みに失敗しました: ${err.code || err.message}`);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** severity が閾値以上か（SEVERITY_ORDER は { danger: 0, warning: 1, info: 2 }。小さいほど重い） */
function atLeast(severity, threshold) {
  if (threshold === 'never') return false;
  const rank = SEVERITY_ORDER[severity];
  const limit = SEVERITY_ORDER[threshold];
  return typeof rank === 'number' && typeof limit === 'number' && rank <= limit;
}

/**
 * ブラウザ版（js/app.js）と同じ後処理: 自動判定が parse-success-ambiguous
 * （複数方言で解析に成功した ANSI 互換 SQL）のときは、便宜上 mysql で解析しているだけで
 * MySQL だと言い切れないため、MySQL 固有の LIMIT 案内（mysql-no-limit）を落とす。
 */
function applyAmbiguousFilter(result, detected) {
  if (!detected || detected.reason !== 'parse-success-ambiguous') return;
  for (const stmt of result.statements) {
    stmt.findings = stmt.findings.filter((f) => f.code !== 'mysql-no-limit');
    if (stmt.plsql) {
      for (const item of stmt.plsql.items) {
        item.findings = item.findings.filter((f) => f.code !== 'mysql-no-limit');
      }
    }
  }
}

function toPlain(result, includeSql) {
  // ブラウザ版と同じ内容のうち、AST とパーサ内部情報を除いたもの。
  // SQL 全文（raw / sql）は --include-sql のときだけ含める。
  const plainItem = (item) => ({
    label: item.label,
    kind: item.kind,
    analyzedKind: item.analyzedKind,
    ...(includeSql ? { sql: item.sql } : {}),
    tables: item.tables,
    summary: item.summary ? summaryToLines(item.summary) : null,
    findings: item.findings,
    verifySelect: item.verifySelect,
    verifySelectHasRuntimeVariable: !!item.verifySelectHasRuntimeVariable,
  });
  return {
    dialect: result.dialect,
    analysis: result.analysis,
    globalFindings: result.globalFindings,
    statements: result.statements.map((st) => ({
      number: st.number,
      kind: st.kind,
      ...(includeSql ? { raw: st.raw } : {}),
      tables: st.tables,
      summary: st.summary ? summaryToLines(st.summary) : null,
      findings: st.findings,
      verifySelect: st.verifySelect,
      plsql: st.plsql
        ? {
            unitKind: st.plsql.unitKind,
            unitName: st.plsql.unitName,
            structure: st.plsql.structure,
            hasCommit: st.plsql.hasCommit,
            hasRollback: st.plsql.hasRollback,
            items: st.plsql.items.map(plainItem),
          }
        : null,
    })),
  };
}

/** 文・PL/SQL 内の項目・全体のすべての finding を平らに列挙する（終了コード判定用） */
function allFindings(plain) {
  const out = [...(plain.globalFindings || [])];
  for (const st of plain.statements) {
    out.push(...st.findings);
    if (st.plsql) for (const item of st.plsql.items) out.push(...item.findings);
  }
  return out;
}

function findingLine(f) {
  const label = I18n.getLocale() === 'en' ? t(`cli.severity.${f.severity}`) : (SEVERITY_LABEL[f.severity] || `[${f.severity}]`);
  return `${label}${f.title}: ${f.message}`;
}

function renderText(plain, detected, includeSql) {
  if (I18n.getLocale() === 'en') {
    const out = [];
    out.push(t('cli.dialect', { dialect: plain.dialect, detected: detected ? t('cli.detected', { reason: detected.reason }) : '', count: plain.statements.length }));
    for (const st of plain.statements) {
      out.push('', t('cli.statement', { number: st.number, kind: st.kind }));
      if (includeSql && st.raw) out.push(`SQL: ${st.raw}`);
      if (st.summary && st.summary.length) out.push(...st.summary);
      else out.push(t('cli.noSummary'));
      for (const f of st.findings) out.push(findingLine(f));
      if (st.verifySelect) out.push(t('cli.verify', { sql: st.verifySelect }));
      if (st.plsql) {
        const p = st.plsql;
        out.push(t('cli.plsql', { header: [p.unitKind, p.unitName].filter(Boolean).join(' ') }));
        for (const [index, item] of p.items.entries()) {
          out.push(t('cli.extracted', { number: index + 1, kind: item.kind, label: item.label || item.kind }));
          if (includeSql && item.sql) out.push(`  SQL: ${item.sql}`);
          if (item.summary) for (const line of item.summary) out.push(`  ${line}`);
          for (const f of item.findings) out.push(`  ${findingLine(f)}`);
          if (item.verifySelect) out.push(`  ${t('cli.verify', { sql: item.verifySelect })}${item.verifySelectHasRuntimeVariable ? t('cli.runtimeVariable') : ''}`);
        }
      }
    }
    if (plain.globalFindings && plain.globalFindings.length) {
      out.push('', t('cli.overall'));
      for (const f of plain.globalFindings) out.push(findingLine(f));
    }
    return out.join('\n') + '\n';
  }
  const out = [];
  const dialectNote = detected ? `${plain.dialect}（自動判定: ${detected.reason}）` : plain.dialect;
  out.push(`方言: ${dialectNote}　文の数: ${plain.statements.length}`);
  for (const st of plain.statements) {
    out.push('');
    out.push(`--- #${st.number} ${st.kind} ---`);
    if (includeSql && st.raw) out.push(`SQL: ${st.raw}`);
    if (st.summary && st.summary.length) {
      for (const line of st.summary) out.push(line);
    } else {
      out.push('（要約なし）');
    }
    for (const f of st.findings) out.push(findingLine(f));
    if (st.verifySelect) out.push(`検算SELECT: ${st.verifySelect}`);
    if (st.plsql) {
      const p = st.plsql;
      out.push(`PL/SQL ${p.unitKind || ''} ${p.unitName || ''} 内の SQL: ${p.items.length} 件（COMMIT ${p.hasCommit ? 'あり' : 'なし'} / ROLLBACK ${p.hasRollback ? 'あり' : 'なし'}）`.replace(/\s+/g, ' '));
      for (const item of p.items) {
        out.push(`  [${item.label || item.kind}]`);
        if (includeSql && item.sql) out.push(`  SQL: ${item.sql}`);
        if (item.summary && item.summary.length) for (const line of item.summary) out.push(`  ${line}`);
        for (const f of item.findings) out.push(`  ${findingLine(f)}`);
        if (item.verifySelect) {
          out.push(`  検算SELECT: ${item.verifySelect}${item.verifySelectHasRuntimeVariable ? '（PL/SQL 変数を含むため、値を埋めてから実行）' : ''}`);
        }
      }
    }
  }
  if (plain.globalFindings && plain.globalFindings.length) {
    out.push('');
    out.push('--- 全体 ---');
    for (const f of plain.globalFindings) out.push(findingLine(f));
  }
  return out.join('\n') + '\n';
}

/** stdout/stderr の書き込み先が閉じている（EPIPE）場合は静かに終了する */
function installEpipeHandler() {
  for (const s of [process.stdout, process.stderr]) {
    s.on('error', (err) => {
      if (err && err.code === 'EPIPE') process.exit(process.exitCode || 0);
    });
  }
}

function parseSubcommand(argv, command) {
  const out = {
    command, to: null, kind: null, dialect: command === 'convert' ? 'auto' : 'generic',
    oracleVersion: 'legacy', columns: [], safeBlock: null, commit: false,
    lang: 'ja', json: false, maxBytes: DEFAULT_MAX_BYTES, file: null,
    target: null, byKey: null, targetKey: null,
  };
  let positionalOnly = false;
  const value = (name, index) => {
    const v = argv[index + 1];
    if (v === undefined || (v.startsWith('-') && v !== '-')) throw new UsageError(`${name} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!positionalOnly && a === '--') { positionalOnly = true; continue; }
    if (!positionalOnly && a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(0, eq) : a;
      const take = () => eq >= 0 ? a.slice(eq + 1) : value(name, i++);
      if (name === '--to') out.to = take();
      else if (name === '--kind') out.kind = take();
      else if (name === '--dialect') out.dialect = take();
      else if (name === '--oracle-version') out.oracleVersion = take();
      else if (name === '--columns') out.columns = take().split(',').map((x) => x.trim()).filter(Boolean);
      else if (name === '--target') out.target = take();
      else if (name === '--by-key') out.byKey = take();
      else if (name === '--target-key') out.targetKey = take();
      else if (name === '--safe-block') out.safeBlock = take();
      else if (name === '--lang') out.lang = take();
      else if (name === '--max-bytes') out.maxBytes = Number(take());
      else if (name === '--commit') out.commit = true;
      else if (name === '--json') out.json = true;
      else throw new UsageError(`Unknown option: ${name}`);
      continue;
    }
    if (out.file !== null) throw new UsageError('Only one input file may be specified');
    out.file = a;
  }
  if (!['generic', 'mysql', 'postgres', 'mssql', 'oracle', 'auto'].includes(out.dialect)) throw new UsageError(`Invalid dialect: ${out.dialect}`);
  if (!['legacy', '23'].includes(out.oracleVersion)) throw new UsageError('--oracle-version must be legacy or 23');
  if (!['ja', 'en'].includes(out.lang)) throw new UsageError('--lang must be ja or en');
  if (!Number.isInteger(out.maxBytes) || out.maxBytes <= 0) throw new UsageError('--max-bytes must be a positive integer');
  if (command === 'convert') {
    if (!['update', 'delete'].includes(out.to)) throw new UsageError('--to must be update or delete');
    if (out.safeBlock && !['generic', 'sqlplus-interactive', 'sqlplus-batch'].includes(out.safeBlock)) throw new UsageError('Invalid --safe-block client');
    if (!!out.target !== !!out.byKey) throw new UsageError('--target and --by-key must be specified together');
    if (out.targetKey && !out.byKey) throw new UsageError('--target-key requires --target and --by-key');
  } else if (command === 'template') {
    if (!['update', 'delete', 'insert-select', 'upsert', 'merge', 'create-table', 'safe-block'].includes(out.kind)) throw new UsageError('Invalid or missing --kind');
    if (out.dialect === 'auto') throw new UsageError('template requires an explicit dialect');
  } else if (command === 'inspect') {
    if (out.dialect === 'auto') throw new UsageError('inspect requires an explicit dialect');
  }
  return out;
}

async function runSubcommand(command, argv) {
  let opts;
  try { opts = parseSubcommand(argv, command); I18n.setLocale(opts.lang); }
  catch (err) { process.stderr.write(`${err.message}\n`); process.exitCode = 1; return; }
  if (command === 'template') {
    process.stdout.write(Templates.get(opts.kind, opts.dialect, { oracleVersion: opts.oracleVersion, locale: opts.lang }) + '\n');
    process.exitCode = 0;
    return;
  }
  let sql;
  try { sql = await readInput(opts.file, opts.maxBytes); }
  catch (err) { process.stderr.write(`${err.message}\n`); process.exitCode = 1; return; }
  if (!sql.trim()) { process.stderr.write((opts.lang === 'en' ? 'SQL input is empty.' : 'SQL が空です。') + '\n'); process.exitCode = 1; return; }
  if (command === 'inspect') {
    const inspected = DmlBuilder.inspect(sql, { dialect: opts.dialect });
    process.stdout.write(JSON.stringify(inspected, null, 2) + '\n');
    process.exitCode = inspected.status === 'ok' ? 0 : 3;
    return;
  }
  const mode = opts.target && opts.byKey ? 'by-key' : 'single-table';
  let dialect = opts.dialect;
  if (dialect === 'auto') {
    const detected = detectDialect(sql);
    if (!detected || ['parse-success-ambiguous', 'undetermined', 'empty'].includes(detected.reason)) {
      const reasonCode = 'dialect-ambiguous';
      if (opts.json) process.stdout.write(JSON.stringify({ status: 'unsupported', reasonCode, sql: null, target: null, dialect: 'auto', oracleVersion: opts.oracleVersion, placeholders: [], equivalence: 'unsupported', mode, warnings: [] }) + '\n');
      else process.stderr.write(t(`dml.reason.${reasonCode}`) + '\n');
      process.exitCode = 4; return;
    }
    dialect = detected.dialect;
  }
  const converted = mode === 'by-key'
    ? DmlBuilder.convertByKey(sql, { dialect, oracleVersion: opts.oracleVersion, targetTable: opts.target, outputKey: opts.byKey, targetKey: opts.targetKey })
    : DmlBuilder.convert(sql, { dialect, oracleVersion: opts.oracleVersion });
  if (converted.status !== 'ok') {
    if (opts.json) process.stdout.write(JSON.stringify({ status: converted.status, reasonCode: converted.reasonCode, reasonParams: converted.reasonParams, sql: null, target: null, dialect, oracleVersion: opts.oracleVersion, placeholders: [], equivalence: converted.equivalence, mode, warnings: converted.warnings || [] }) + '\n');
    else {
      for (const code of converted.reasonCodes || [converted.reasonCode]) process.stderr.write(t(`dml.reason.${code}`, converted.reasonParams) + '\n');
      process.stderr.write(t(mode === 'by-key' ? 'dml.hint.byKey' : 'dml.hint.singleTable') + '\n');
    }
    process.exitCode = 3; return;
  }
  const dml = opts.to === 'delete' ? converted.delete : DmlBuilder.applyColumns(converted.update, opts.columns);
  // 生成物の自己検証: 危険・警告の指摘（WHERE 無しの DML など）は stderr に出す。stdout は SQL だけ。
  const selfCheck = analyzeSQL(dml, dialect, { oracleVersion: opts.oracleVersion });
  // プレースホルダ未記入は convert の生成物では前提（利用者が埋める）なので、ここでは除く
  const selfFindings = selfCheck.statements.flatMap((s) => s.findings)
    .filter((f) => (f.severity === 'danger' || f.severity === 'warning') && f.code !== 'unfilled-placeholder');
  if (!opts.json) for (const f of selfFindings) process.stderr.write(`${findingLine(f)}\n`);
  if (!opts.json && mode === 'by-key') for (const code of converted.warnings) process.stderr.write(`${t(`dml.warning.${code}`)}\n`);
  let output = dml;
  if (opts.safeBlock) output = Templates.buildSafeBlock({ dialect, client: opts.safeBlock, originalSelect: converted.original, countSelect: converted.countSelect, dml: output, locale: opts.lang, commit: opts.commit, updatedColumns: opts.to === 'update' ? opts.columns : [], whereText: converted.where });
  if (opts.json) {
    const placeholders = [...new Set(output.match(/<[a-z_]+>/g) || [])];
    process.stdout.write(JSON.stringify({
      status: 'ok', reasonCode: null, sql: output, target: converted.target, dialect, oracleVersion: opts.oracleVersion,
      mode,
      placeholders, equivalence: converted.equivalence, invariants: converted.invariants,
      columnCandidates: converted.columnCandidates, warnings: converted.warnings,
      selfCheck: selfFindings.map((f) => ({ severity: f.severity, code: f.code, title: f.title })),
    }) + '\n');
  } else process.stdout.write(output.replace(/\s+$/, '') + '\n');
  process.exitCode = 0;
}

async function main() {
  installEpipeHandler();
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === 'convert' || rawArgs[0] === 'template' || rawArgs[0] === 'inspect') {
    await runSubcommand(rawArgs[0], rawArgs.slice(1));
    return;
  }
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    I18n.setLocale(opts.lang);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(err.message + '\n' + usageText());
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  if (opts.help) {
    process.stdout.write(usageText());
    return;
  }

  let sql;
  try {
    sql = await readInput(opts.file, opts.maxBytes);
  } catch (err) {
    const message = err instanceof InputError ? err.message : (I18n.getLocale() === 'en' ? `Failed to read input: ${err.code || err.message}` : `読み込みに失敗しました: ${err.code || err.message}`);
    process.stderr.write(message + '\n');
    process.exitCode = 1;
    return;
  }
  if (!sql.trim()) {
    process.stderr.write((I18n.getLocale() === 'en' ? t('cli.err.empty') : 'SQL が空です。') + '\n');
    process.exitCode = 1;
    return;
  }

  let plain;
  let detected = null;
  try {
    let dialect = opts.dialect;
    if (dialect === 'auto') {
      detected = detectDialect(sql);
      dialect = detected.dialect || 'generic';
    }
    const result = analyzeSQL(sql, dialect, { oracleVersion: opts.oracleVersion });
    applyAmbiguousFilter(result, detected);
    plain = toPlain(result, opts.includeSql);
  } catch (err) {
    // 解析コアの例外文には SQL の断片が含まれ得るので、種別だけを出す
    process.stderr.write(`解析中に内部エラーが発生しました（${err && err.name ? err.name : 'Error'}）。--json 無しで再実行しても同じ場合は、SQL を短く分けて試してください。\n`);
    process.exitCode = 1;
    return;
  }

  try {
    if (opts.json) {
      process.stdout.write(JSON.stringify(plain, null, 2) + '\n');
    } else {
      process.stdout.write(renderText(plain, detected, opts.includeSql));
    }
  } catch (err) {
    if (err && err.code === 'EPIPE') return;
    process.stderr.write(`出力中に内部エラーが発生しました（${err && err.name ? err.name : 'Error'}）。\n`);
    process.exitCode = 1;
    return;
  }

  const hit = allFindings(plain).some((f) => atLeast(f.severity, opts.failOn));
  process.exitCode = hit ? 2 : 0;
}

main().catch((err) => {
  process.stderr.write(`内部エラー（${err && err.name ? err.name : 'Error'}）。\n`);
  process.exitCode = 1;
});
