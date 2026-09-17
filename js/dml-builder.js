/**
 * SELECT -> UPDATE / DELETE converter for one base table.
 * Loaded as a classic script so it also works from file:// pages.
 */
(function () {
'use strict';

const REASON_CODES = new Set([
  'join-unsupported-v1', 'row-limit', 'grouping', 'set-operation',
  'cte-unsupported-v1', 'derived-table', 'hierarchical-or-special',
  'lock-clause', 'select-into', 'not-single-select', 'parse-failed',
  'dialect-ambiguous', 'key-not-in-output', 'star-output',
]);

function lex(sql) {
  const tokens = [];
  let i = 0;
  let depth = 0;
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1] || '';
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && n === '-') {
      i += 2; while (i < sql.length && sql[i] !== '\n') i++; continue;
    }
    if (c === '/' && n === '*') {
      i += 2; while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i = Math.min(sql.length, i + 2); continue;
    }
    if (c === "'") {
      const start = i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i++] === "'") break;
      }
      tokens.push({ text: sql.slice(start, i), upper: '', start, end: i, depth, kind: 'string' });
      continue;
    }
    if (c === '$') {
      const m = sql.slice(i).match(/^\$[A-Za-z_0-9]*\$/);
      if (m) {
        const start = i; const tag = m[0]; i += tag.length;
        const close = sql.indexOf(tag, i); i = close < 0 ? sql.length : close + tag.length;
        tokens.push({ text: sql.slice(start, i), upper: '', start, end: i, depth, kind: 'string' });
        continue;
      }
    }
    if (c === '"' || c === '`' || c === '[') {
      const start = i; const close = c === '[' ? ']' : c; i++;
      while (i < sql.length) {
        if (sql[i] === close && sql[i + 1] === close) { i += 2; continue; }
        if (sql[i++] === close) break;
      }
      const text = sql.slice(start, i);
      tokens.push({ text, upper: text.toUpperCase(), start, end: i, depth, kind: 'identifier' });
      continue;
    }
    if (c === '(') { tokens.push({ text: c, upper: c, start: i, end: i + 1, depth, kind: 'symbol' }); depth++; i++; continue; }
    if (c === ')') { depth = Math.max(0, depth - 1); tokens.push({ text: c, upper: c, start: i, end: i + 1, depth, kind: 'symbol' }); i++; continue; }
    if (/[A-Za-z_$#\u0080-\uFFFF]/.test(c)) {
      const start = i++;
      while (i < sql.length && /[A-Za-z0-9_$#\u0080-\uFFFF]/.test(sql[i])) i++;
      const text = sql.slice(start, i);
      tokens.push({ text, upper: text.toUpperCase(), start, end: i, depth, kind: 'word' });
      continue;
    }
    if (/[0-9]/.test(c)) {
      const start = i++; while (i < sql.length && /[0-9.eE+-]/.test(sql[i])) i++;
      tokens.push({ text: sql.slice(start, i), upper: '', start, end: i, depth, kind: 'number' });
      continue;
    }
    tokens.push({ text: c, upper: c, start: i, end: i + 1, depth, kind: 'symbol' }); i++;
  }
  return tokens;
}

function significantStatements(sql, dialect) {
  const A = globalThis.SQLMeganeAnalyzer;
  if (A && A._internal && A._internal.splitStatementsWithOffsets) {
    return A._internal.splitStatementsWithOffsets(sql, dialect).map((x) => x.raw).filter((x) => x.trim());
  }
  return sql.split(';').filter((x) => x.trim());
}

function atTop(tokens, word) { return tokens.findIndex((t) => t.depth === 0 && t.upper === word); }
function hasSeq(tokens, words) {
  const top = tokens.filter((t) => t.depth === 0);
  return top.some((_, i) => words.every((w, j) => top[i + j] && top[i + j].upper === w));
}
function unsupported(reasonCode, original, reasonParams, reasonCodes) {
  return {
    status: 'unsupported', reasonCode, reasonCodes: reasonCodes && reasonCodes.length ? reasonCodes : [reasonCode],
    reasonParams: reasonParams || {}, target: null,
    original, delete: null, update: null, countSelect: null, columnCandidates: [],
    equivalence: 'unsupported', invariants: { whereOnce: false, targetOnce: false, noOtherTables: false },
    warnings: [], syntaxCheck: null,
  };
}
function isIdentifier(t) { return !!t && (t.kind === 'word' || t.kind === 'identifier'); }

function parseTable(sql, tokens, fromIndex, endPos) {
  const part = tokens.slice(fromIndex + 1).filter((t) => t.depth === 0 && t.start < endPos);
  if (!part.length) return { error: 'parse-failed' };
  if (part[0].text === '(' || ['LATERAL', 'APPLY'].includes(part[0].upper)) return { error: 'derived-table' };
  let i = 0;
  if (!isIdentifier(part[i])) return { error: 'derived-table' };
  const tableTokens = [part[i++]];
  while (part[i] && part[i].text === '.' && isIdentifier(part[i + 1])) {
    tableTokens.push(part[i], part[i + 1]); i += 2;
  }
  if (part[i] && part[i].text === '(') return { error: 'derived-table' };
  let aliasToken = null;
  if (part[i] && part[i].upper === 'AS') {
    if (!isIdentifier(part[i + 1])) return { error: 'parse-failed' };
    aliasToken = part[i + 1]; i += 2;
  } else if (isIdentifier(part[i])) {
    aliasToken = part[i++];
  }
  if (i !== part.length) {
    const rest = part.slice(i);
    if (rest.some((t) => t.text === ',' || /JOIN/.test(t.upper) || ['NATURAL', 'USING'].includes(t.upper))) return { error: 'join-unsupported-v1' };
    return { error: 'derived-table' };
  }
  const tableStart = tableTokens[0].start;
  const tableEnd = tableTokens[tableTokens.length - 1].end;
  const asEnd = aliasToken ? aliasToken.end : tableEnd;
  return {
    table: sql.slice(tableStart, tableEnd),
    alias: aliasToken ? aliasToken.text : null,
    asWritten: sql.slice(tableStart, asEnd).trim(),
  };
}

function normalizeIdentifier(s) {
  return String(s || '').replace(/^(?:"(.*)"|`(.*)`|\[(.*)\])$/, '$1$2$3').toLowerCase();
}

function identifierValue(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return identifierValue(value.value != null ? value.value : value.expr);
  return null;
}

function isQuotedIdentifier(value) {
  const s = String(value || '');
  return (s.startsWith('"') && s.endsWith('"')) || (s.startsWith('`') && s.endsWith('`')) || (s.startsWith('[') && s.endsWith(']'));
}

function identifierEquals(a, b) {
  if (a == null || b == null) return false;
  if (isQuotedIdentifier(a) || isQuotedIdentifier(b)) return String(a) === String(b);
  return normalizeIdentifier(a) === normalizeIdentifier(b);
}

function tableText(ref) {
  if (!ref || !ref.table) return null;
  return [ref.db, ref.schema, ref.table].filter(Boolean).join('.');
}

function collectAstTables(ast) {
  const ctes = [];
  const cteSet = new Set();
  const tables = [];
  const seenNodes = new Set();
  const processedSelects = new Set();
  const addCte = (name) => {
    if (name == null || cteSet.has(normalizeIdentifier(name))) return;
    ctes.push(name); cteSet.add(normalizeIdentifier(name));
  };
  for (const item of (ast && ast.with) || []) addCte(identifierValue(item.name));
  const addTable = (ref, where) => {
    const name = tableText(ref);
    if (!name || cteSet.has(normalizeIdentifier(ref.table))) return;
    const key = normalizeIdentifier(name);
    let found = tables.find((x) => normalizeIdentifier(x.name) === key);
    if (!found) { found = { name, alias: [], where }; tables.push(found); }
    if (ref.as && !found.alias.some((a) => identifierEquals(a, ref.as))) found.alias.push(ref.as);
  };
  const walk = (node, where, isRoot) => {
    if (!node || typeof node !== 'object' || seenNodes.has(node)) return;
    seenNodes.add(node);
    if (Array.isArray(node)) { for (const value of node) walk(value, where, false); return; }
    const select = node.type === 'select' ? node : (node.ast && node.ast.type === 'select' ? node.ast : null);
    if (select && !processedSelects.has(select)) {
      processedSelects.add(select);
      for (const item of select.with || []) {
        const name = identifierValue(item.name); addCte(name);
        walk(item.stmt, `cte:${name}`, false);
      }
      for (const ref of select.from || []) {
        if (ref && ref.table) addTable(ref, where);
        if (ref && ref.expr) walk(ref.expr, 'subquery', false);
      }
      for (const [key, value] of Object.entries(select)) {
        if (key !== 'with' && key !== 'from') walk(value, isRoot ? 'subquery' : where, false);
      }
      return;
    }
    for (const value of Object.values(node)) walk(value, where, false);
  };
  walk(ast, 'outer', true);
  return { tables: tables.map((x) => ({ ...x, alias: x.alias.join(', ') || null })), ctes };
}

function cteNamesFromTokens(tokens) {
  const names = [];
  const first = tokens.find((t) => t.depth === 0);
  if (!first || first.upper !== 'WITH') return names;
  for (let j = tokens.indexOf(first) + 1; j < tokens.length; j++) {
    const t = tokens[j];
    if (t.depth !== 0 || !isIdentifier(t) || t.upper === 'RECURSIVE') continue;
    let k = j + 1;
    if (tokens[k] && tokens[k].text === '(' && tokens[k].depth === 0) {
      k++; while (tokens[k] && !(tokens[k].text === ')' && tokens[k].depth === 0)) k++;
      k++;
    }
    if (tokens[k] && tokens[k].depth === 0 && tokens[k].upper === 'AS' && tokens[k + 1] && tokens[k + 1].text === '(') names.push(t.text);
    if (t.upper === 'SELECT') break;
  }
  return [...new Set(names)];
}

function cteSpansFromTokens(tokens, ctes) {
  const wanted = new Set(ctes.map(normalizeIdentifier));
  const spans = [];
  for (let i = 0; i < tokens.length - 2; i++) {
    if (tokens[i].depth !== 0 || !isIdentifier(tokens[i]) || !wanted.has(normalizeIdentifier(tokens[i].text))) continue;
    let asAt = i + 1;
    if (tokens[asAt] && tokens[asAt].text === '(' && tokens[asAt].depth === 0) {
      asAt++;
      while (tokens[asAt] && !(tokens[asAt].text === ')' && tokens[asAt].depth === 0)) asAt++;
      asAt++;
    }
    const open = tokens[asAt + 1];
    if (!tokens[asAt] || tokens[asAt].upper !== 'AS' || !open || open.text !== '(' || open.depth !== 0) continue;
    const close = tokens.find((t, j) => j > asAt + 1 && t.text === ')' && t.depth === 0);
    if (close) spans.push({ name: tokens[i].text, start: open.end, end: close.start });
  }
  return spans;
}

function collectLexicalTables(tokens, ctes) {
  const tables = [];
  const cteSet = new Set(ctes.map(normalizeIdentifier));
  const cteSpans = cteSpansFromTokens(tokens, ctes);
  for (let i = 0; i < tokens.length; i++) {
    if (!['FROM', 'JOIN'].includes(tokens[i].upper)) continue;
    let j = i + 1;
    if (!isIdentifier(tokens[j]) || ['SELECT', 'LATERAL'].includes(tokens[j].upper)) continue;
    const parts = [tokens[j].text]; j++;
    while (tokens[j] && tokens[j].text === '.' && isIdentifier(tokens[j + 1])) { parts.push('.', tokens[j + 1].text); j += 2; }
    const name = parts.join('');
    if (cteSet.has(normalizeIdentifier(name.split('.').pop()))) continue;
    if (tokens[j] && tokens[j].text === '(') continue;
    if (tokens[j] && tokens[j].upper === 'AS') j++;
    const alias = isIdentifier(tokens[j]) && !['WHERE', 'JOIN', 'ON', 'GROUP', 'ORDER', 'HAVING', 'UNION', 'LIMIT', 'OFFSET', 'FETCH'].includes(tokens[j].upper) ? tokens[j].text : null;
    let found = tables.find((x) => normalizeIdentifier(x.name) === normalizeIdentifier(name));
    const cte = cteSpans.find((span) => tokens[i].start >= span.start && tokens[i].start < span.end);
    if (!found) { found = { name, alias: [], where: tokens[i].depth === 0 ? 'outer' : (cte ? `cte:${cte.name}` : 'subquery') }; tables.push(found); }
    if (alias && !found.alias.some((a) => identifierEquals(a, alias))) found.alias.push(alias);
  }
  return tables.map((x) => ({ ...x, alias: x.alias.join(', ') || null }));
}

function finalSelectInfo(tokens) {
  const selects = tokens.filter((t) => t.depth === 0 && t.upper === 'SELECT');
  const select = selects[selects.length - 1];
  if (!select) return null;
  const selectIndex = tokens.indexOf(select);
  const fromIndex = tokens.findIndex((t, i) => i > selectIndex && t.depth === 0 && t.upper === 'FROM');
  return fromIndex < 0 ? null : { selectIndex, fromIndex };
}

function outputColumnsFromTokens(tokens) {
  const info = finalSelectInfo(tokens);
  if (!info) return [];
  let listTokens = tokens.slice(info.selectIndex + 1, info.fromIndex);
  // 選択リスト先頭の修飾子（DISTINCT / ALL / SQL Server の TOP n・TOP (n) [PERCENT] [WITH TIES]）は列ではないので読み飛ばす
  for (;;) {
    const first = listTokens[0];
    if (!first || first.depth !== 0) break;
    if (['DISTINCT', 'ALL'].includes(first.upper)) { listTokens = listTokens.slice(1); continue; }
    if (first.upper === 'TOP') {
      let i = 1;
      if (listTokens[i] && listTokens[i].text === '(') { while (listTokens[i] && !(listTokens[i].text === ')' && listTokens[i].depth === 0)) i++; i++; }
      else if (listTokens[i] && listTokens[i].kind === 'number') i++;
      if (listTokens[i] && listTokens[i].upper === 'PERCENT') i++;
      if (listTokens[i] && listTokens[i].upper === 'WITH' && listTokens[i + 1] && listTokens[i + 1].upper === 'TIES') i += 2;
      listTokens = listTokens.slice(i); continue;
    }
    break;
  }
  const groups = []; let current = [];
  for (const token of listTokens) {
    if (token.depth === 0 && token.text === ',') { groups.push(current); current = []; } else current.push(token);
  }
  groups.push(current);
  return groups.map((group) => {
    if (!group.length) return null;
    const top = group.filter((t) => t.depth === 0);
    const star = (top.length === 1 && top[0].text === '*')
      || (top.length === 3 && isIdentifier(top[0]) && top[1].text === '.' && top[2].text === '*');
    if (star) return { name: '*', kind: 'star' };
    let asAt = -1;
    for (let i = top.length - 2; i >= 0; i--) if (top[i].upper === 'AS' && isIdentifier(top[i + 1])) { asAt = i; break; }
    if (asAt >= 0) return { name: top[asAt + 1].text, kind: 'alias' };
    const simple = (top.length === 1 && isIdentifier(top[0]))
      || (top.length === 3 && isIdentifier(top[0]) && top[1].text === '.' && isIdentifier(top[2]));
    if (simple) return { name: top[top.length - 1].text, kind: 'column' };
    return { name: null, kind: 'expression' };
  }).filter(Boolean);
}

function inspect(sqlText, options) {
  const original = String(sqlText || '');
  const dialect = (options && options.dialect) || 'generic';
  const statements = significantStatements(original, dialect);
  if (statements.length !== 1) return { status: 'unsupported', reasonCode: 'not-single-select', tables: [], ctes: [], outputColumns: [], singleTable: false };
  const statement = statements[0].trim();
  const tokens = lex(statement);
  const first = tokens.find((t) => t.depth === 0);
  if (!first || !['SELECT', 'WITH'].includes(first.upper)) return { status: 'unsupported', reasonCode: 'not-single-select', tables: [], ctes: [], outputColumns: [], singleTable: false };
  let details = null;
  const Ast = globalThis.SQLMeganeSqlAst;
  if (['mysql', 'postgres', 'mssql'].includes(dialect) && Ast && Ast.isAvailable(dialect)) {
    const parsed = Ast.parseStatement(statement, dialect);
    if (parsed.ok && !parsed.usedFallbackDialect) details = collectAstTables(parsed.ast);
  }
  if (!details) {
    const ctes = cteNamesFromTokens(tokens);
    details = { ctes, tables: collectLexicalTables(tokens, ctes) };
  }
  const outputColumns = outputColumnsFromTokens(tokens);
  return { status: 'ok', reasonCode: null, tables: details.tables, ctes: details.ctes, outputColumns, singleTable: details.tables.length === 1 };
}

function stripLeadingComments(sql) {
  let out = String(sql || '').replace(/^\uFEFF/, '');
  while (true) {
    const next = out.replace(/^\s+/, '');
    if (next.startsWith('--')) { const nl = next.indexOf('\n'); out = nl < 0 ? '' : next.slice(nl + 1); continue; }
    if (next.startsWith('/*')) { const end = next.indexOf('*/', 2); out = end < 0 ? '' : next.slice(end + 2); continue; }
    return next;
  }
}

function innerSelect(sql) {
  let statement = stripLeadingComments(sql).replace(/;\s*$/, '').trimEnd();
  const tokens = lex(statement);
  const info = finalSelectInfo(tokens);
  if (!info) return { text: statement, orderByRemoved: false, finalSelectStart: 0, rowLimit: false, whereFrom: 0 };
  // 最終 SELECT の開始位置。SQL Server は派生表の中に WITH を書けないので、WITH 句をこの位置で切って文頭へ移す
  const finalSelectStart = tokens[info.selectIndex].start;
  // 最終 SELECT の FROM の位置。選択リストを除いた「条件の部分」を取り出すのに使う
  const whereFrom = tokens[info.fromIndex].start;
  // 行数制限（LIMIT / OFFSET / FETCH / TOP）の有無。上位 N 件は ORDER BY が一意でないと再評価で別の行になり、
  // 確認した SELECT と同じキー集合を再現できないため、キー IN 形では変換しない（呼び出し側で拒否する）
  const top = tokens.filter((t) => t.depth === 0);
  const selectAt = top.findIndex((t) => t.start === finalSelectStart);
  const rowLimit = top.some((t, i) => (['LIMIT', 'OFFSET', 'FETCH'].includes(t.upper) && t.start > whereFrom)
    || (t.upper === 'TOP' && selectAt >= 0 && i === selectAt + 1));
  const orderIndex = tokens.findIndex((t, i) => i > info.fromIndex && t.depth === 0 && t.upper === 'ORDER'
    && tokens[i + 1] && tokens[i + 1].depth === 0 && tokens[i + 1].upper === 'BY');
  if (orderIndex < 0 || rowLimit) return { text: statement, orderByRemoved: false, finalSelectStart, rowLimit, whereFrom };
  return { text: statement.slice(0, tokens[orderIndex].start).trimEnd(), orderByRemoved: true, finalSelectStart, rowLimit, whereFrom };
}

// generated は WITH 句の文頭移動（SQL Server）や注記コメントを付ける前の本体で検証する
function byKeyInvariants(generated, inner, targetTable, keyHead) {
  const values = Object.values(generated);
  const targetNorm = normalizeIdentifier(String(targetTable).split('.').pop());
  const outside = (sql) => sql.slice(0, sql.indexOf(' IN (SELECT '));
  return {
    innerOnce: values.every((sql) => countLiteral(sql, inner) === 1),
    targetOnce: values.every((sql) => lex(outside(sql)).filter((t) => isIdentifier(t) && normalizeIdentifier(t.text) === targetNorm).length === 1),
    keyInOutput: values.every((sql) => sql.includes(keyHead)),
  };
}

function convertByKey(sqlText, options) {
  const original = String(sqlText || '');
  const opts = options || {};
  const dialect = opts.dialect || 'generic';
  const checked = inspect(original, { dialect });
  if (checked.status !== 'ok') return unsupported(checked.reasonCode, original);
  const targetTable = String(opts.targetTable || '').trim();
  const outputKey = String(opts.outputKey || '').trim();
  const targetKey = String(opts.targetKey || outputKey).trim();
  // 行数制限とロック句の判定は出力列の判定より先に行う。SELECT * のまま試した利用者に「列を明示すれば通る」と
  // 誤解させないため（ブラインドテスト 2026-09-17 の指摘）
  const inner = innerSelect(original);
  // 上位 N 件（LIMIT / OFFSET / FETCH / TOP）は、ORDER BY が一意でないと DML 実行時の再評価で別の行を選ぶ。
  // ツールは一意性を確認できないので変換しない。確認済みのキーを一時表に保存して固定する手順を案内する
  if (inner.rowLimit) { const result = unsupported('row-limit', original); result.inspection = checked; return result; }
  // ロック句（FOR UPDATE / FOR SHARE）は派生表や副問合せにそのまま移せない製品があり、外すとロックの意味が変わる
  const innerTokens = lex(inner.text);
  if (innerTokens.some((t, i) => t.upper === 'FOR' && innerTokens[i + 1] && ['UPDATE', 'SHARE'].includes(innerTokens[i + 1].upper))) {
    const result = unsupported('lock-clause', original); result.inspection = checked; return result;
  }
  const named = checked.outputColumns.filter((c) => c.name && c.kind !== 'star');
  if (!named.length && checked.outputColumns.some((c) => c.kind === 'star')) return unsupported('star-output', original);
  const keyMatches = named.filter((c) => identifierEquals(c.name, outputKey));
  if (!keyMatches.length) {
    const result = unsupported('key-not-in-output', original, { key: outputKey, available: named.map((c) => c.name).join(', ') });
    result.inspection = checked; return result;
  }
  // 同名の出力が複数あると、どの表の列で絞るかが決まらない（自己結合・同名キーの結合）。別名で 1 回にしてもらう
  if (keyMatches.length > 1) {
    const result = unsupported('ambiguous-key', original, { key: outputKey });
    result.inspection = checked; return result;
  }
  // 条件の部分（WITH 句＋最終 SELECT の FROM 以降）。更新する列が条件に含まれるかの判定に使う
  const where = inner.text.slice(0, inner.finalSelectStart) + inner.text.slice(inner.whereFrom);
  const note = inner.orderByRemoved ? '-- SQLMegane: removed the final ORDER BY inside the derived table.\n' : '';
  // 一意性は確認できないので必ず注意を出す。NULL キーと再評価も同様
  const warnings = ['key-uniqueness', 'null-key-ignored', 'subquery-recomputed'];
  // SQL Server は派生表の中に WITH を書けない → WITH 句を文頭へ移し、最終 SELECT だけを派生表にする
  let prefix = '';
  let body = inner.text;
  if (dialect === 'mssql' && checked.ctes.length > 0 && inner.finalSelectStart > 0) {
    prefix = inner.text.slice(0, inner.finalSelectStart).trimEnd() + '\n';
    body = inner.text.slice(inner.finalSelectStart);
    warnings.push('mssql-cte-hoisted');
  }
  // MySQL は更新する表を副問合せで読む DML を禁止（ERROR 1093）。派生表が実体化される場合だけ例外なので NO_MERGE で実体化を指示する
  const hint = dialect === 'mysql' ? '/*+ NO_MERGE(sqlmegane_src) */ ' : '';
  if (hint) warnings.push('mysql-no-merge');
  const keyHead = `SELECT ${hint}${outputKey} FROM (`;
  const predicate = `${targetKey} IN (${keyHead}${body}) sqlmegane_src)`;
  const bodies = {
    update: `UPDATE ${targetTable} SET <column> = <value> WHERE ${predicate};`,
    delete: `DELETE FROM ${targetTable} WHERE ${predicate};`,
    countSelect: `SELECT COUNT(*) FROM ${targetTable} WHERE ${predicate};`,
  };
  const invariants = byKeyInvariants(bodies, body, targetTable, keyHead);
  const update = `${note}${prefix}${bodies.update}`;
  const del = `${note}${prefix}${bodies.delete}`;
  const countSelect = `${note}${prefix}${bodies.countSelect}`;
  if (!checked.tables.some((t) => identifierEquals(t.name, targetTable))) warnings.push('target-not-in-query');
  return {
    status: 'ok', reasonCode: null, reasonCodes: [], reasonParams: {}, mode: 'by-key',
    target: { table: targetTable, alias: null, asWritten: targetTable, outputKey, targetKey },
    original: original.trim().replace(/;\s*$/, '') + ';', delete: del, update, countSelect, where,
    columnCandidates: [], equivalence: Object.values(invariants).every(Boolean) ? 'proven' : 'unsupported',
    invariants, warnings, inspection: checked,
    syntaxCheck: { delete: check(del, bodies.delete), update: check(update, bodies.update), countSelect: check(countSelect, bodies.countSelect) },
  };

  // WITH 句を文頭へ移した形（SQL Server）は、同梱パーサが `WITH ... DELETE` を読めないため、
  // 「WITH 付きの元 SELECT」と「DML 本体（CTE 名を表として参照）」を別々に確認して合成する
  function check(full, bodySql) {
    if (!prefix) return syntaxCheck(full, dialect);
    const a = syntaxCheck(bodySql, dialect);
    const b = syntaxCheck(inner.text, dialect);
    return {
      ok: !!(a.ok && b.ok), mode: a.mode, partial: true,
      error: a.ok ? (b.ok ? null : b.error) : a.error,
      usedFallbackDialect: a.usedFallbackDialect || b.usedFallbackDialect || null,
    };
  }
}

function columnCandidates(sql, tokens, selectIndex, fromIndex, target) {
  const selected = tokens.slice(selectIndex + 1, fromIndex);
  const groups = []; let current = [];
  for (const token of selected) {
    if (token.depth === 0 && token.text === ',') { groups.push(current); current = []; }
    else current.push(token);
  }
  groups.push(current);
  const allowedQualifiers = new Set([
    normalizeIdentifier(target.alias),
    normalizeIdentifier(target.table.split('.').pop()),
  ].filter(Boolean));
  const out = [];
  for (const group of groups) {
    const g = group.filter((t) => t.kind !== 'string');
    if (g.length === 1 && isIdentifier(g[0]) && g[0].text !== '*') out.push(g[0].text);
    else if (g.length === 3 && isIdentifier(g[0]) && g[1].text === '.' && isIdentifier(g[2])
      && allowedQualifiers.has(normalizeIdentifier(g[0].text)) && g[2].text !== '*') out.push(g[2].text);
  }
  return [...new Set(out)];
}

function replaceAlias(whereText, alias, table) {
  if (!alias) return whereText;
  const tokens = lex(whereText);
  const wanted = normalizeIdentifier(alias);
  let out = ''; let cursor = 0;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].kind !== 'string' && normalizeIdentifier(tokens[i].text) === wanted && tokens[i + 1].text === '.') {
      out += whereText.slice(cursor, tokens[i].start) + table;
      cursor = tokens[i].end;
    }
  }
  return out + whereText.slice(cursor);
}

function countLiteral(haystack, needle) {
  if (!needle) return 1;
  let count = 0; let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) >= 0) { count++; pos += needle.length; }
  return count;
}

function syntaxCheck(sql, dialect) {
  const parseable = sql.replace(/<column>/g, 'placeholder_column').replace(/<value>/g, '0');
  const Ast = globalThis.SQLMeganeSqlAst;
  if (['mysql', 'postgres', 'mssql'].includes(dialect) && Ast && Ast.isAvailable(dialect)) {
    const parsed = Ast.parseStatement(parseable, dialect);
    const ok = !!(parsed.ok && !parsed.usedFallbackDialect);
    return {
      ok, mode: 'ast',
      error: ok ? null : (parsed.usedFallbackDialect ? parsed.primaryError : parsed.error),
      usedFallbackDialect: parsed.usedFallbackDialect || null,
    };
  }
  const tokens = lex(sql);
  const kind = tokens.find((t) => t.depth === 0 && t.kind === 'word');
  const balanced = !tokens.some((t) => t.text === ')' && t.depth < 0);
  return { ok: !!(kind && ['UPDATE', 'DELETE', 'SELECT'].includes(kind.upper) && balanced), mode: 'basic', error: null };
}

function convert(sqlText, options) {
  const original = String(sqlText || '');
  const opts = options || {};
  let dialect = opts.dialect || 'generic';
  if (dialect === 'auto') {
    const detect = globalThis.SQLMeganeDialectDetect && globalThis.SQLMeganeDialectDetect.detectDialect;
    const found = detect ? detect(original) : null;
    if (!found || ['parse-success-ambiguous', 'undetermined', 'empty'].includes(found.reason)) return unsupported('dialect-ambiguous', original);
    dialect = found.dialect;
  }
  const statements = significantStatements(original, dialect);
  if (statements.length !== 1) return unsupported('not-single-select', original);
  const statement = statements[0].trim();
  const tokens = lex(statement);
  const top = tokens.filter((t) => t.depth === 0);
  if (!top[0] || (top[0].upper !== 'SELECT' && top[0].upper !== 'WITH')) return unsupported('not-single-select', original);
  // 変換できない理由は 1 つ目で止めず全部集める（利用者が SELECT を書き直す時に、直す箇所が一度で分かるように）。
  // reasonCode は互換のため先頭の 1 つ、reasonCodes に全件。
  const reasons = [];
  const isCte = top[0].upper === 'WITH';
  if (isCte) reasons.push('cte-unsupported-v1');
  if (hasSeq(tokens, ['UNION']) || hasSeq(tokens, ['INTERSECT']) || hasSeq(tokens, ['EXCEPT']) || hasSeq(tokens, ['MINUS'])) reasons.push('set-operation');
  if (top.some((t) => ['LIMIT', 'OFFSET', 'FETCH', 'TOP'].includes(t.upper))) reasons.push('row-limit');
  if (hasSeq(tokens, ['FOR', 'UPDATE']) || hasSeq(tokens, ['FOR', 'SHARE'])) reasons.push('lock-clause');
  if (top.some((t) => ['CONNECT', 'MODEL', 'MATCH_RECOGNIZE', 'PIVOT', 'UNPIVOT', 'TABLESAMPLE'].includes(t.upper))
      || (!isCte && hasSeq(tokens, ['START', 'WITH']))) reasons.push('hierarchical-or-special');
  if (top.some((t) => ['DISTINCT', 'HAVING', 'QUALIFY', 'ROLLUP', 'CUBE'].includes(t.upper)) || hasSeq(tokens, ['GROUP', 'BY']) || hasSeq(tokens, ['GROUPING', 'SETS'])
      || top.some((t, i) => ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'LISTAGG', 'STRING_AGG', 'ARRAY_AGG', 'JSON_AGG'].includes(t.upper) && top[i + 1] && top[i + 1].text === '(')
      || top.some((t) => t.upper === 'OVER')) reasons.push('grouping');
  // CTE の場合、外側の SELECT は最後の depth 0 の SELECT。JOIN 等の判定はその外側ブロックで行う
  const selectTop = isCte ? [...top].reverse().find((t) => t.upper === 'SELECT') : top[0];
  const selectIndex = selectTop ? tokens.indexOf(selectTop) : -1;
  const fromIndex = selectIndex >= 0 ? tokens.findIndex((t, i) => i > selectIndex && t.depth === 0 && t.upper === 'FROM') : -1;
  if (fromIndex < 0) {
    reasons.push('parse-failed');
    return unsupported(reasons[0], original, {}, reasons);
  }
  if (tokens.slice(selectIndex + 1, fromIndex).some((t) => t.depth === 0 && t.upper === 'INTO')) reasons.push('select-into');
  const whereIndex = tokens.findIndex((t, i) => i > fromIndex && t.depth === 0 && t.upper === 'WHERE');
  const orderIndex = tokens.findIndex((t, i) => i > fromIndex && t.depth === 0 && t.upper === 'ORDER' && tokens[i + 1] && tokens[i + 1].depth === 0 && tokens[i + 1].upper === 'BY');
  const clauseStart = [whereIndex, orderIndex].filter((x) => x >= 0).reduce((a, b) => Math.min(a, b), tokens.length);
  const endPos = clauseStart < tokens.length ? tokens[clauseStart].start : statement.length;
  const sourceTop = tokens.slice(fromIndex + 1, clauseStart).filter((t) => t.depth === 0);
  const hasOracleOuterJoin = tokens.some((t, i) => t.start >= endPos && t.text === '(' && t.depth === 0
    && tokens[i + 1] && tokens[i + 1].text === '+' && tokens[i + 1].depth === 1
    && tokens[i + 2] && tokens[i + 2].text === ')' && tokens[i + 2].depth === 0);
  if (sourceTop.some((t) => t.text === ',' || /JOIN/.test(t.upper) || ['NATURAL', 'USING'].includes(t.upper)) || hasOracleOuterJoin) {
    reasons.push('join-unsupported-v1');
  }
  const target = reasons.includes('join-unsupported-v1') ? { error: null } : parseTable(statement, tokens, fromIndex, endPos);
  if (target.error && !reasons.includes(target.error)) reasons.push(target.error);
  if (reasons.length) return unsupported(reasons[0], original, {}, [...new Set(reasons)]);

  const Ast = globalThis.SQLMeganeSqlAst;
  if (['mysql', 'postgres', 'mssql'].includes(dialect) && Ast && Ast.isAvailable(dialect)) {
    const parsed = Ast.parseStatement(statement, dialect);
    if (!parsed.ok || parsed.usedFallbackDialect) return unsupported('parse-failed', original);
  } else {
    const parenBalance = tokens.reduce((n, t) => n + (t.text === '(' ? 1 : t.text === ')' ? -1 : 0), 0);
    if (parenBalance !== 0) return unsupported('parse-failed', original);
  }

  const whereEnd = orderIndex >= 0 ? tokens[orderIndex].start : statement.length;
  let whereClause = whereIndex >= 0 ? statement.slice(tokens[whereIndex].start, whereEnd).trim().replace(/;\s*$/, '') : '';
  const warnings = [];
  const uncertainAlias = dialect === 'generic' && target.alias;
  if (uncertainAlias) { whereClause = replaceAlias(whereClause, target.alias, target.table); warnings.push('alias-rewritten'); }
  const updateAlias = target.alias && !uncertainAlias ? (dialect === 'postgres' ? ` AS ${target.alias}` : ` ${target.alias}`) : '';
  const deleteAlias = target.alias && !uncertainAlias ? (dialect === 'postgres' || dialect === 'mysql' ? ` AS ${target.alias}` : ` ${target.alias}`) : '';
  const selectAlias = target.alias && !uncertainAlias ? (dialect === 'oracle' ? ` ${target.alias}` : ` AS ${target.alias}`) : '';
  const updateTarget = `${target.table}${updateAlias}`;
  const deleteHead = target.alias && !uncertainAlias && dialect === 'mssql'
    ? `DELETE ${target.alias} FROM ${target.table} AS ${target.alias}`
    : `DELETE FROM ${target.table}${deleteAlias}`;
  const suffix = whereClause ? ` ${whereClause}` : '';
  const update = `UPDATE ${updateTarget} SET <column> = <value>${suffix};`;
  const del = `${deleteHead}${suffix};`;
  const countSelect = `SELECT COUNT(*) FROM ${target.table}${selectAlias}${suffix};`;
  const generated = [update, del, countSelect];
  // 生成物から元の WHERE を除いた部分（DML の頭部）を取り出し、対象表が一度だけ現れ、
  // 他の識別子（別の表）が行ソースに紛れ込んでいないことを実際に数えて確認する。
  // 「固定で true」にしない: equivalence: proven はこの検証の結果だけから決まる。
  const headOf = (s) => (whereClause ? s.slice(0, s.indexOf(whereClause)) : s);
  const tableNorm = normalizeIdentifier(target.table.split('.').pop());
  const countTableRefs = (head) => lex(head).filter((tk) => isIdentifier(tk) && normalizeIdentifier(tk.text) === tableNorm).length;
  const rowSourceOf = (head) => {
    const toks = lex(head).filter((tk) => tk.depth === 0);
    const fromAt = toks.findIndex((tk) => tk.upper === 'FROM');
    const setAt = toks.findIndex((tk) => tk.upper === 'SET');
    const start = fromAt >= 0 ? fromAt + 1 : 1;
    const end = setAt > start ? setAt : toks.length;
    return toks.slice(start, end).filter((tk) => isIdentifier(tk) && !['AS'].includes(tk.upper));
  };
  const allowedNames = new Set([tableNorm, normalizeIdentifier(target.alias)].filter(Boolean));
  const invariants = {
    whereOnce: !whereClause || generated.every((s) => countLiteral(s, whereClause) === 1),
    targetOnce: generated.every((s) => countTableRefs(headOf(s)) === 1),
    noOtherTables: generated.every((s) => rowSourceOf(headOf(s)).every((tk) => {
      const n = normalizeIdentifier(tk.text);
      return allowedNames.has(n) || target.table.split('.').map(normalizeIdentifier).includes(n);
    })),
  };
  const equivalence = Object.values(invariants).every(Boolean) ? 'proven' : 'unsupported';
  return {
    status: 'ok', reasonCode: null, reasonParams: {},
    target: { table: target.table, alias: target.alias, asWritten: target.asWritten },
    original: statement.replace(/;\s*$/, '') + ';', delete: del, update, countSelect, where: whereClause,
    columnCandidates: columnCandidates(statement, tokens, selectIndex, fromIndex, target),
    equivalence, invariants, warnings,
    syntaxCheck: {
      delete: syntaxCheck(del, dialect), update: syntaxCheck(update, dialect), countSelect: syntaxCheck(countSelect, dialect),
    },
  };
}

function applyColumns(updateSql, columns) {
  const selected = Array.isArray(columns) ? columns.filter((c) => typeof c === 'string' && c.trim()) : [];
  if (!selected.length) return updateSql;
  return String(updateSql).replace(/\bSET\s+<column>\s*=\s*<value>/i,
    `SET ${selected.map((c) => `${c.trim()} = <value>`).join(', ')}`);
}

globalThis.SQLMeganeDmlBuilder = {
  convert, inspect, convertByKey, applyColumns, REASON_CODES,
  _internal: { lex, syntaxCheck, innerSelect, byKeyInvariants, outputColumnsFromTokens, collectAstTables },
};
})();
