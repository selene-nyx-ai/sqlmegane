/**
 * SQLMegane（SQLめがね） sql-ast.js
 *
 * 同梱した node-sql-parser（js/vendor/）のラッパーと、AST を読むための共通
 * ヘルパー群。summarizer.js（日本語要約）と ast-rules.js（AST基盤の検出ルール）の
 * 両方から使われる。
 *
 * analyzer.js と同じ理由（file:// 直開き時に ESM が CORS でブロックされる）で
 * ESM の export は使わず、globalThis.SQLMeganeSqlAst に公開する。
 *
 * 設計方針:
 *  - パーサが使えない環境（vendor 未読込・方言非対応）でも決して例外を投げない。
 *    呼び出し側は「ASTが取れたら使う、取れなければ従来の正規表現解析」で動く。
 *  - パース失敗は異常ではなく想定内の分岐。エラー位置（行・列）を返して
 *    UI が「どこで諦めたか」をユーザーに伝えられるようにする。
 */

(function () {

// ---------------------------------------------------------------------------
// 方言マッピング
// ---------------------------------------------------------------------------

// UIの方言セレクタの値 → node-sql-parser の dialect 名
// Oracle は node-sql-parser が非対応、汎用は「どの方言とも言い切れない」ため
// AST解析の対象外（＝既存の正規表現解析のみ）。
const DIALECT_MAP = {
  mysql: 'mysql',
  postgres: 'postgresql',
  mssql: 'transactsql',
};

// パース失敗時に「もう一度だけ」試す方言。
// 調査（docs/parser-research.md）で、`WITH ... DELETE` のように
// postgresql/transactsql のパーサでは通らないが mysql のパーサでは通る構文が
// あることが分かっているため、素の失敗で諦める前に mysql で再挑戦する。
// 別方言のパーサを使ったことは呼び出し側に返し、UIで明示できるようにする。
const RETRY_DIALECT = 'mysql';

function parserDialectFor(uiDialect) {
  return DIALECT_MAP[uiDialect] || null;
}

function isAstDialect(uiDialect) {
  return parserDialectFor(uiDialect) !== null;
}

function getVendor(parserDialect) {
  const vendor = globalThis.SQLMeganeVendor;
  if (!vendor) return null;
  const mod = vendor[parserDialect];
  if (!mod || typeof mod.Parser !== 'function') return null;
  return mod;
}

/** その方言のパーサが実際に読み込まれているか（vendorの同梱漏れ検知にも使う） */
function isAvailable(uiDialect) {
  const d = parserDialectFor(uiDialect);
  return d !== null && getVendor(d) !== null;
}

// ---------------------------------------------------------------------------
// パース
// ---------------------------------------------------------------------------

function normalizeAstList(ast) {
  if (ast == null) return [];
  return Array.isArray(ast) ? ast : [ast];
}

function tryAstify(sql, parserDialect) {
  const mod = getVendor(parserDialect);
  if (!mod) return { ok: false, error: { message: `パーサ（${parserDialect}）が読み込まれていません`, line: null, column: null } };
  try {
    const parser = new mod.Parser();
    const list = normalizeAstList(parser.astify(sql, { database: parserDialect }));
    if (list.length === 0) return { ok: false, error: { message: '解析結果が空でした', line: null, column: null } };
    return { ok: true, ast: list[0], all: list, parser, parserDialect };
  } catch (e) {
    const loc = e && e.location && e.location.start ? e.location.start : null;
    return {
      ok: false,
      error: {
        message: (e && e.message) ? String(e.message) : String(e),
        line: loc ? loc.line : null,
        column: loc ? loc.column : null,
        offset: loc ? loc.offset : null,
      },
    };
  }
}

/**
 * 1文をパースする。成功したら { ok:true, ast, parserDialect, usedFallbackDialect }、
 * 失敗したら { ok:false, error:{message,line,column} } を返す。例外は投げない。
 */
function parseStatement(sql, uiDialect) {
  const primary = parserDialectFor(uiDialect);
  if (!primary) return { ok: false, error: { message: 'この方言は構文解析の対象外です', line: null, column: null }, unsupportedDialect: true };

  const first = tryAstify(sql, primary);
  if (first.ok) return { ok: true, ast: first.ast, parser: first.parser, parserDialect: primary, usedFallbackDialect: null };

  if (primary !== RETRY_DIALECT) {
    const retry = tryAstify(sql, RETRY_DIALECT);
    if (retry.ok) {
      return { ok: true, ast: retry.ast, parser: retry.parser, parserDialect: RETRY_DIALECT, usedFallbackDialect: RETRY_DIALECT };
    }
  }
  return { ok: false, error: first.error };
}

// ---------------------------------------------------------------------------
// AST を読むための共通ヘルパー
// ---------------------------------------------------------------------------

/**
 * 列名の取り出し。node-sql-parser は方言によって column を
 * 文字列（mysql/transactsql）で返したり、`{ expr: { type:'default', value:'flg' } }`
 * というオブジェクト（postgresql）で返したりする。両方を吸収する。
 */
function columnName(col) {
  if (col == null) return null;
  if (typeof col === 'string') return col;
  if (typeof col === 'object') {
    if (typeof col.value === 'string') return col.value;
    if (col.expr) return columnName(col.expr);
  }
  return null;
}

/** column_ref を { table, column, text } に正規化する */
function columnRef(node) {
  if (!node || node.type !== 'column_ref') return null;
  const column = columnName(node.column);
  if (column == null) return null;
  const table = node.table || null;
  return { table, column, text: table ? `${table}.${column}` : column };
}

function lower(s) {
  return typeof s === 'string' ? s.toLowerCase() : s;
}

/**
 * 行の供給元（FROM句相当）のテーブル一覧。
 * - MySQL の `UPDATE t1 JOIN t2 ... SET ...` は ast.table に JOIN が入る
 * - T-SQL の `UPDATE u SET ... FROM users u JOIN ...` は ast.from に入る
 * - `DELETE FROM orders` は ast.table と ast.from の両方に入る
 * ため、from があればそちらを、無ければ table を行の供給元とみなす。
 */
function rowSourceTables(ast) {
  if (!ast || typeof ast !== 'object') return [];
  const from = Array.isArray(ast.from) ? ast.from.filter((t) => t && (t.table || t.expr)) : [];
  if (from.length > 0) return from;
  const table = Array.isArray(ast.table) ? ast.table.filter((t) => t && t.table) : [];
  return table;
}

/** エイリアス（無ければテーブル名）→ テーブル参照 のマップ */
function aliasMap(rowSource) {
  const map = new Map();
  for (const t of rowSource) {
    const key = lower(t.as || t.table);
    if (key && !map.has(key)) map.set(key, t);
  }
  return map;
}

/** `u` のようなエイリアス名から実テーブル名を引く。引けなければ入力をそのまま返す */
function resolveTable(name, rowSource) {
  if (!name) return null;
  const hit = aliasMap(rowSource).get(lower(name));
  return hit ? { table: hit.table, as: hit.as || null } : { table: name, as: null };
}

/**
 * 実際に書き換わるテーブル（UPDATE/DELETE/INSERTの対象）。
 * UPDATE は SET句の修飾（`SET u.flg = 1` の `u`）を優先し、無ければ先頭テーブル。
 */
function writeTargets(ast) {
  if (!ast || typeof ast !== 'object') return [];
  const rowSource = rowSourceTables(ast);
  const out = [];
  const push = (info) => {
    if (!info || !info.table) return;
    if (out.some((o) => lower(o.table) === lower(info.table) && lower(o.as || '') === lower(info.as || ''))) return;
    out.push(info);
  };

  if (ast.type === 'update') {
    const setTables = [];
    for (const s of (ast.set || [])) {
      if (s && s.table) setTables.push(s.table);
    }
    if (setTables.length > 0) {
      for (const t of setTables) push(resolveTable(t, rowSource));
    } else if (Array.isArray(ast.table) && ast.table.length > 0) {
      const first = ast.table[0];
      // T-SQL の `UPDATE u SET ...` は ast.table にエイリアスだけが入るので解決する
      push(resolveTable(first.table, rowSource.length > 0 ? rowSource : ast.table));
    }
    if (out.length === 0 && rowSource.length > 0) push({ table: rowSource[0].table, as: rowSource[0].as || null });
    return out;
  }

  if (ast.type === 'delete') {
    const refs = Array.isArray(ast.table) ? ast.table : [];
    for (const r of refs) push(resolveTable(r.table, rowSource.length > 0 ? rowSource : refs));
    if (out.length === 0 && rowSource.length > 0) push({ table: rowSource[0].table, as: rowSource[0].as || null });
    return out;
  }

  if (ast.type === 'insert' || ast.type === 'replace') {
    const refs = Array.isArray(ast.table) ? ast.table : [];
    for (const r of refs) push({ table: r.table, as: r.as || null });
    return out;
  }

  return out;
}

/** JOINの種類を正規化する（'INNER' | 'LEFT' | 'RIGHT' | 'FULL' | 'CROSS' | null） */
function joinKind(entry) {
  if (!entry || !entry.join) return null;
  const j = String(entry.join).toUpperCase();
  if (j.includes('CROSS')) return 'CROSS';
  if (j.includes('FULL')) return 'FULL';
  if (j.includes('LEFT')) return 'LEFT';
  if (j.includes('RIGHT')) return 'RIGHT';
  return 'INNER';
}

/**
 * 外部結合によって「NULL埋めされうる（＝一致しない行も残る）」側のテーブル参照集合。
 * LEFT JOIN なら結合された側、RIGHT JOIN ならそれより前の全テーブル、
 * FULL JOIN なら両方が該当する。
 * 戻り値は 参照キー（エイリアスまたはテーブル名、小文字） の Set。
 */
function nullableTableKeys(rowSource) {
  const keys = new Set();
  const keyOf = (t) => lower(t.as || t.table);
  for (let i = 0; i < rowSource.length; i++) {
    const kind = joinKind(rowSource[i]);
    if (kind === 'LEFT') {
      keys.add(keyOf(rowSource[i]));
    } else if (kind === 'RIGHT') {
      for (let j = 0; j < i; j++) keys.add(keyOf(rowSource[j]));
    } else if (kind === 'FULL') {
      keys.add(keyOf(rowSource[i]));
      for (let j = 0; j < i; j++) keys.add(keyOf(rowSource[j]));
    }
  }
  keys.delete(null);
  keys.delete(undefined);
  return keys;
}

/** binary_expr を指定の論理演算子でフラットに分解する（括弧の情報は保持しない） */
function flattenLogical(expr, op) {
  if (!expr) return [];
  if (expr.type === 'binary_expr' && String(expr.operator).toUpperCase() === op) {
    return flattenLogical(expr.left, op).concat(flattenLogical(expr.right, op));
  }
  return [expr];
}

// ---------------------------------------------------------------------------
// 論理式（AND / OR）の正規化
// ---------------------------------------------------------------------------
//
// 【重要】node-sql-parser は AND / OR の優先順位を適用せず、出てきた順の
// 左結合でASTを組む。実測（v5.4.0）:
//
//   WHERE a = 1 OR b = 2 AND c = 3
//     → AND( OR(a=1, b=2), c=3 )      ← SQLの意味とは違う！
//   SQLの正しい解釈は AND のほうが強く結合するので
//     → OR( a=1, AND(b=2, c=3) )
//
// ASTをそのまま日本語要約に流すと「意図と違う読み方」を自信満々に提示して
// しまい、このツールの存在意義を裏切る。そこで、括弧で保護されていない
// AND/ORの連なりを一度フラットな列に戻し、SQLの優先順位（AND > OR）で
// 組み直してから使う。括弧付きの部分式（parentheses: true）は1つの塊として
// 扱い、その内側で同じ正規化を再帰的に行う。

function isLogicalNode(node) {
  if (!node || node.type !== 'binary_expr') return false;
  const op = String(node.operator || '').toUpperCase();
  return op === 'AND' || op === 'OR';
}

/** 括弧で保護されていないAND/ORの連なりを「オペランド列 + 演算子列」に開く */
function linearizeLogical(node, out) {
  const acc = out || { operands: [], ops: [] };
  const op = String(node.operator).toUpperCase();
  if (isLogicalNode(node.left) && !node.left.parentheses) linearizeLogical(node.left, acc);
  else acc.operands.push(node.left);
  acc.ops.push(op);
  if (isLogicalNode(node.right) && !node.right.parentheses) linearizeLogical(node.right, acc);
  else acc.operands.push(node.right);
  return acc;
}

/**
 * 論理式を SQL の優先順位で組み直したツリーにする。
 * 葉:   { connector: null, expr, children: [] }
 * 集合: { connector: 'AND'|'OR', expr: null, children: [...] }
 */
function logicalTree(expr) {
  if (!isLogicalNode(expr)) return { connector: null, expr: expr || null, children: [] };

  const { operands, ops } = linearizeLogical(expr);
  const groups = [];
  let current = [operands[0]];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i] === 'AND') current.push(operands[i + 1]);
    else { groups.push(current); current = [operands[i + 1]]; }
  }
  groups.push(current);

  const nodes = groups.map((g) => (
    g.length === 1
      ? logicalTree(g[0])
      : { connector: 'AND', expr: null, children: g.map(logicalTree) }
  ));

  if (nodes.length === 1) return nodes[0];
  return { connector: 'OR', expr: null, children: nodes };
}

/**
 * 括弧なしで AND と OR が混在しているか。
 * パーサが優先順位を適用しないおかげで、「同じ連なりの中に AND と OR の両方が
 * 現れる」＝「括弧で優先順位が明示されていない」を素直に判定できる。
 */
function hasMixedLogicalWithoutParens(expr) {
  if (!isLogicalNode(expr)) return false;
  const { operands, ops } = linearizeLogical(expr);
  if (ops.includes('AND') && ops.includes('OR')) return true;
  return operands.some(hasMixedLogicalWithoutParens);
}

/**
 * 「この条件は必ず適用される」と言い切れるトップレベルのAND項だけを返す。
 * ORの下にある条件は「他の条件で救われる可能性がある」ため含めない
 * （外部結合の打ち消し判定などで誤検知しないようにするため）。
 */
function topLevelAndParts(expr) {
  if (!expr) return [];
  const tree = logicalTree(expr);
  if (tree.connector === null) return tree.expr ? [tree.expr] : [];
  if (tree.connector === 'AND') return tree.children.filter((c) => c.connector === null).map((c) => c.expr);
  return [];
}

/** 式ツリーを深さ優先で走査する（サブクエリの中にも入る） */
function walkExpr(node, visit, seen) {
  if (node == null || typeof node !== 'object') return;
  const visited = seen || new Set();
  if (visited.has(node)) return;
  visited.add(node);

  if (Array.isArray(node)) {
    for (const n of node) walkExpr(n, visit, visited);
    return;
  }
  if (node.type) visit(node);
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (v && typeof v === 'object') walkExpr(v, visit, visited);
  }
}

/** expr_list の中に入っているサブクエリ（{ ast: {...} }）を取り出す */
function subqueryOf(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.ast && typeof node.ast === 'object') return node.ast;
  if (node.type === 'expr_list' && Array.isArray(node.value)) {
    for (const v of node.value) {
      const sub = subqueryOf(v);
      if (sub) return sub;
    }
  }
  if (node.type === 'select') return node;
  return null;
}

/** リテラル値のテキスト表現（要約と検出メッセージで共用） */
function literalText(node) {
  if (!node || typeof node !== 'object') return null;
  switch (node.type) {
    case 'number': return String(node.value);
    case 'single_quote_string':
    case 'string':
    case 'double_quote_string': return `'${node.value}'`;
    case 'null': return 'NULL';
    case 'bool': return node.value ? 'TRUE' : 'FALSE';
    case 'param': return `:${node.value}`;
    case 'origin': return String(node.value);
    default: return null;
  }
}

function isLiteral(node) {
  return literalText(node) !== null;
}

globalThis.SQLMeganeSqlAst = {
  DIALECT_MAP,
  parserDialectFor,
  isAstDialect,
  isAvailable,
  parseStatement,
  columnName,
  columnRef,
  rowSourceTables,
  aliasMap,
  resolveTable,
  writeTargets,
  joinKind,
  nullableTableKeys,
  flattenLogical,
  isLogicalNode,
  linearizeLogical,
  logicalTree,
  hasMixedLogicalWithoutParens,
  topLevelAndParts,
  walkExpr,
  subqueryOf,
  literalText,
  isLiteral,
};

})();
