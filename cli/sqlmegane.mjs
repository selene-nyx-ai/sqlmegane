#!/usr/bin/env node
// SQLMegane（SQLめがね）CLI。ブラウザ版と同じ解析コアを Node から呼び、
// 実行前の SQL を日本語で読み返す。CI や実行前フックに組み込むためのもの。
//
//   node cli/sqlmegane.mjs [オプション] [--] [ファイル.sql | -]
//
//   --dialect <auto|generic|mysql|postgres|mssql|oracle>  方言（既定: auto = 自動判定）
//   --json                                                 解析結果を JSON で出力
//   --fail-on <danger|warning|info|never>                  この重要度以上の指摘があれば終了コード 2（既定: danger）
//   --include-sql                                          出力に SQL 本文（raw / sql）を含める（既定: 含めない）
//   --max-bytes <N>                                        入力の上限バイト数（既定: 5242880 = 5 MiB）
//   -h, --help                                             使い方
//
// ファイルを省略するか '-' を指定すると標準入力から読む。
// 終了コード: 0 = 指摘が閾値未満 / 2 = 閾値以上の指摘あり / 1 = 使い方エラー・入力エラー
//
// この CLI は SQL を実行しない。ファイルの読み込みと標準出力への書き出し以外に外部へ触れない。
// 終了コードを呼び出し側（CI・フック）で判定して初めて後続処理を止められる。
// 検出できるのは実装済みのルールに限られ、SQL の安全性を保証するものではない。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// js/*.js は file:// 直開き対応のため ESM export を使わず globalThis に公開する
// 通常スクリプト。index.html と同じ順序で副作用インポートする（tests/run-tests.mjs と同じ方式）。
import '../js/vendor/node-sql-parser-mysql.js';
import '../js/vendor/node-sql-parser-postgresql.js';
import '../js/vendor/node-sql-parser-transactsql.js';
import '../js/sql-ast.js';
import '../js/summarizer.js';
import '../js/ast-rules.js';
import '../js/plsql-extract.js';
import '../js/analyzer.js';
import '../js/dialect-detect.js';

const { analyzeSQL, SEVERITY_ORDER } = globalThis.SQLMeganeAnalyzer;
const { summaryToLines } = globalThis.SQLMeganeSummarizer;
const { detectDialect } = globalThis.SQLMeganeDialectDetect;

const DIALECTS = ['auto', 'generic', 'mysql', 'postgres', 'mssql', 'oracle'];
const FAIL_ON = ['danger', 'warning', 'info', 'never'];
const SEVERITY_LABEL = { danger: '【危険】', warning: '【警告】', info: '【情報】' };
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

function usage(exitCode) {
  const me = path.basename(fileURLToPath(import.meta.url));
  const text = [
    `使い方: node cli/${me} [オプション] [--] [ファイル.sql | -]`,
    '',
    '  --dialect <auto|generic|mysql|postgres|mssql|oracle>  方言（既定: auto）',
    '  --json                                                 JSON で出力',
    '  --fail-on <danger|warning|info|never>                  終了コード 2 にする重要度の閾値（既定: danger）',
    '  --include-sql                                          出力に SQL 本文を含める（既定: 含めない）',
    `  --max-bytes <N>                                        入力の上限バイト数（既定: ${DEFAULT_MAX_BYTES}）`,
    '  -h, --help                                             この使い方',
    '',
    'ファイルを省略するか - を指定すると標準入力から読みます。',
    '終了コード: 0 = 閾値未満 / 2 = 閾値以上の指摘あり / 1 = 使い方・入力エラー',
  ].join('\n');
  (exitCode === 0 ? process.stdout : process.stderr).write(text + '\n');
  process.exit(exitCode);
}

function fail(message) {
  process.stderr.write(message + '\n');
  usage(1);
}

function parseArgs(argv) {
  const opts = { dialect: 'auto', json: false, failOn: 'danger', includeSql: false, maxBytes: DEFAULT_MAX_BYTES, file: null };
  const takeValue = (name, i) => {
    const v = argv[i + 1];
    if (v === undefined || (v.startsWith('-') && v !== '-')) fail(`${name} には値が必要です。`);
    return v;
  };
  let positionalOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!positionalOnly && a === '--') { positionalOnly = true; continue; }
    if (!positionalOnly && a.startsWith('-') && a !== '-') {
      if (a === '-h' || a === '--help') usage(0);
      else if (a === '--json') opts.json = true;
      else if (a === '--include-sql') opts.includeSql = true;
      else if (a === '--dialect') opts.dialect = takeValue(a, i++);
      else if (a.startsWith('--dialect=')) opts.dialect = a.slice('--dialect='.length);
      else if (a === '--fail-on') opts.failOn = takeValue(a, i++);
      else if (a.startsWith('--fail-on=')) opts.failOn = a.slice('--fail-on='.length);
      else if (a === '--max-bytes') opts.maxBytes = Number(takeValue(a, i++));
      else if (a.startsWith('--max-bytes=')) opts.maxBytes = Number(a.slice('--max-bytes='.length));
      else fail(`不明なオプション: ${a}`);
      continue;
    }
    if (opts.file !== null) fail('ファイルは 1 つだけ指定してください。');
    opts.file = a;
  }
  if (!DIALECTS.includes(opts.dialect)) fail(`--dialect は ${DIALECTS.join(' / ')} のいずれかです: ${opts.dialect}`);
  if (!FAIL_ON.includes(opts.failOn)) fail(`--fail-on は ${FAIL_ON.join(' / ')} のいずれかです: ${opts.failOn}`);
  if (!Number.isInteger(opts.maxBytes) || opts.maxBytes <= 0) fail('--max-bytes は正の整数で指定してください。');
  return opts;
}

/** 上限バイト数を超えたら Error を投げる。ファイルは読む前にサイズで判定し、標準入力は読みながら数える */
function readInput(file, maxBytes) {
  if (file === null || file === '-') {
    const chunks = [];
    let total = 0;
    const fd = 0;
    const buf = Buffer.alloc(64 * 1024);
    for (;;) {
      let n;
      try {
        n = fs.readSync(fd, buf, 0, buf.length, null);
      } catch (err) {
        if (err.code === 'EAGAIN') continue;
        if (err.code === 'EOF') break;
        throw err;
      }
      if (n === 0) break;
      total += n;
      if (total > maxBytes) throw new Error(`入力が上限（${maxBytes} バイト）を超えています。--max-bytes で上限を変更できます。`);
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const size = fs.statSync(file).size;
  if (size > maxBytes) throw new Error(`入力が上限（${maxBytes} バイト）を超えています（${size} バイト）。--max-bytes で上限を変更できます。`);
  return fs.readFileSync(file, 'utf8');
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
  // SQL 本文（raw / sql）は --include-sql のときだけ含める（CI ログにリテラルが残るのを避ける）。
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
  return `${SEVERITY_LABEL[f.severity] || `[${f.severity}]`}${f.title}: ${f.message}`;
}

function renderText(plain, detected, includeSql) {
  const out = [];
  const dialectNote = detected ? `${plain.dialect}（自動判定: ${detected.reason}）` : plain.dialect;
  out.push(`方言: ${dialectNote}　文の数: ${plain.statements.length}`);
  for (const st of plain.statements) {
    out.push('');
    out.push(`--- #${st.number} ${st.kind} ---`);
    if (st.summary && st.summary.length) {
      for (const line of st.summary) out.push(line);
    } else if (includeSql && st.raw) {
      out.push(`（要約なし）${st.raw.replace(/\s+/g, ' ').slice(0, 120)}`);
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

function main() {
  const opts = parseArgs(process.argv.slice(2));
  let sql;
  try {
    sql = readInput(opts.file, opts.maxBytes);
  } catch (err) {
    process.stderr.write(`読み込みに失敗しました: ${err.message}\n`);
    process.exit(1);
  }
  if (!sql.trim()) {
    process.stderr.write('SQL が空です。\n');
    process.exit(1);
  }

  let dialect = opts.dialect;
  let detected = null;
  if (dialect === 'auto') {
    detected = detectDialect(sql);
    dialect = detected.dialect || 'generic';
  }

  const result = analyzeSQL(sql, dialect);
  applyAmbiguousFilter(result, detected);
  const plain = toPlain(result, opts.includeSql);

  if (opts.json) {
    process.stdout.write(JSON.stringify(plain, null, 2) + '\n');
  } else {
    process.stdout.write(renderText(plain, detected, opts.includeSql));
  }

  const hit = allFindings(plain).some((f) => atLeast(f.severity, opts.failOn));
  process.exitCode = hit ? 2 : 0;
}

main();
