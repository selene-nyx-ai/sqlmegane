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
  'dialect-ambiguous',
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
    return { ok: !!(parsed.ok && !parsed.usedFallbackDialect), mode: 'ast', error: parsed.ok ? null : parsed.error };
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
    original: statement.replace(/;\s*$/, '') + ';', delete: del, update, countSelect,
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

globalThis.SQLMeganeDmlBuilder = { convert, applyColumns, REASON_CODES, _internal: { lex, syntaxCheck } };
})();
