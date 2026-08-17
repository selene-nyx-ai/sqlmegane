/**
 * SQLMegane（SQLめがね） ast-rules.js
 *
 * AST（構文解析結果）を前提にした検出ルール。
 *
 *  - 既存の正規表現ルールと同じ code / severity を返す「置き換え版」
 *    （パース成功時はこちらを使う。括弧・演算子の優先順位・サブクエリの境界を
 *      正しく見られるため、誤検知が減る）
 *  - ASTがなければ書けなかった新ルール
 *      * left-join-where-cancellation (danger)
 *      * not-in-null-risk (warning)
 *      * update-delete-join-basis (info)
 *
 * analyzer.js と同じ理由で ESM の export は使わず globalThis に公開する。
 */

(function () {

const A = globalThis.SQLMeganeSqlAst;

function mk(severity, code, title, message) {
  return { severity, code, title, message };
}

function q(name) {
  return '`' + name + '`';
}

function tableLabel(ref) {
  if (!ref || !ref.table) return '（不明なテーブル）';
  const alias = ref.as || null;
  return alias && alias !== ref.table ? `${q(ref.table)}（別名 ${alias}）` : q(ref.table);
}

function lower(s) {
  return typeof s === 'string' ? s.toLowerCase() : s;
}

const COMPARISON_OPS = new Set(['=', '!=', '<>', '<', '>', '<=', '>=', 'LIKE', 'NOT LIKE', 'IN', 'NOT IN']);
const EQUALITY_OPS = new Set(['=', '!=', '<>', '<', '>', '<=', '>=', 'LIKE', 'IN']);

// ---------------------------------------------------------------------------
// 常に真のWHERE句
// ---------------------------------------------------------------------------

function sameLiteralValue(a, b) {
  if (!a || !b) return false;
  const numeric = new Set(['number']);
  const stringy = new Set(['single_quote_string', 'string', 'double_quote_string']);
  if (numeric.has(a.type) && numeric.has(b.type)) return Number(a.value) === Number(b.value);
  if (stringy.has(a.type) && stringy.has(b.type)) return String(a.value) === String(b.value);
  if (a.type === 'bool' && b.type === 'bool') return a.value === b.value;
  return false;
}

/** その式単独で常に真か（1=1 / 'a'='a' / TRUE / 1） */
function isTautologyExpr(expr) {
  if (!expr || typeof expr !== 'object') return false;
  if (expr.type === 'bool') return expr.value === true;
  if (expr.type === 'number') return Number(expr.value) === 1;
  if (expr.type === 'binary_expr') {
    const op = String(expr.operator || '').toUpperCase();
    if (op === '=') return sameLiteralValue(expr.left, expr.right);
    if (op === 'AND') return isTautologyExpr(expr.left) && isTautologyExpr(expr.right);
    if (op === 'OR') return isTautologyExpr(expr.left) || isTautologyExpr(expr.right);
  }
  return false;
}

/**
 * WHERE句全体が常に真になるか。
 * SQLの優先順位で組み直したツリー（sql-ast.js の logicalTree）の上で判定するため、
 * `X OR 1=1` はもちろん `1=1 OR a=1 AND b=2` のような形も正しく拾える。
 * 逆に `a=1 AND (b=2 OR 1=1)` は AND の全項が真でないと真にならないため発火しない。
 */
function isTautologyNode(node) {
  if (node.connector === null) return isTautologyExpr(node.expr);
  if (node.connector === 'AND') return node.children.every(isTautologyNode);
  return node.children.some(isTautologyNode);
}

function isAlwaysTrueWhere(expr) {
  if (!expr) return false;
  return isTautologyNode(A.logicalTree(expr));
}

// ---------------------------------------------------------------------------
// OR と AND の混在で括弧がない
// ---------------------------------------------------------------------------

/**
 * ASTなら「括弧で優先順位が明示されているか」が parentheses フラグで分かるので、
 * 正規表現版のように「括弧が一文字でもあれば判定を諦める」必要がない。
 * BETWEEN x AND y は binary_expr(AND) にならないため、そもそも誤検知しない。
 * 判定本体は sql-ast.js（パーサがAND/ORの優先順位を適用しない件の対処込み）。
 */
function hasUnparenthesizedOrAnd(expr) {
  return A.hasMixedLogicalWithoutParens(expr);
}

// ---------------------------------------------------------------------------
// LIKE / 暗黙型変換
// ---------------------------------------------------------------------------

function hasLeadingWildcardLike(expr) {
  let found = false;
  A.walkExpr(expr, (node) => {
    if (found) return;
    if (node.type !== 'binary_expr') return;
    if (String(node.operator).toUpperCase() !== 'LIKE') return;
    const r = node.right;
    if (r && (r.type === 'single_quote_string' || r.type === 'string') && typeof r.value === 'string' && r.value.startsWith('%')) {
      found = true;
    }
  });
  return found;
}

function findQuotedNumericComparisons(expr) {
  const results = [];
  A.walkExpr(expr, (node) => {
    if (node.type !== 'binary_expr') return;
    const op = String(node.operator || '').toUpperCase();
    if (!EQUALITY_OPS.has(op) || op === 'LIKE' || op === 'IN') return;
    const pairs = [[node.left, node.right], [node.right, node.left]];
    for (const [colNode, litNode] of pairs) {
      if (!colNode || colNode.type !== 'column_ref') continue;
      if (!litNode || (litNode.type !== 'single_quote_string' && litNode.type !== 'string')) continue;
      if (!/^-?\d+(\.\d+)?$/.test(String(litNode.value))) continue;
      const ref = A.columnRef(colNode);
      if (ref) results.push({ column: ref.text, op: node.operator, value: String(litNode.value) });
    }
  });
  return results;
}

// ---------------------------------------------------------------------------
// 自己参照サブクエリで絞り込み条件なし
// ---------------------------------------------------------------------------

function findUncorrelatedSelfSubquery(ast, targetTables) {
  const targets = new Set(targetTables.map((t) => lower(t.table)));
  const hits = [];
  A.walkExpr(ast.where, (node) => {
    if (node.type !== 'binary_expr') return;
    if (String(node.operator).toUpperCase() !== 'IN') return;
    const sub = A.subqueryOf(node.right);
    if (!sub || sub.type !== 'select') return;
    const subFrom = A.rowSourceTables(sub);
    if (subFrom.length !== 1) return;
    if (!targets.has(lower(subFrom[0].table))) return;
    if (sub.where) return;
    hits.push(subFrom[0].table);
  });
  return hits;
}

// ---------------------------------------------------------------------------
// 新ルール: NOT IN (SELECT ...) のNULLリスク
// ---------------------------------------------------------------------------

/**
 * NOT IN のNULLリスクを2パターン検出する:
 *  - kind: 'subquery'     … NOT IN (SELECT ...)。サブクエリの結果にNULLが混じるかは
 *                            実行してみないと分からないため warning（要確認）。
 *  - kind: 'literal-null' … NOT IN (1, NULL, 3) のようにリテラルの値リストに直接NULLが
 *                            含まれる。これは実行前から確実に分かる（SQLの三値論理により
 *                            比較結果が常にUNKNOWNになり、WHERE句は常に空を返す）ため
 *                            danger扱いにする。
 */
function findNotInSubqueries(ast) {
  const hits = [];
  A.walkExpr(ast, (node) => {
    if (node.type !== 'binary_expr') return;
    if (String(node.operator).toUpperCase() !== 'NOT IN') return;
    const ref = A.columnRef(node.left);
    const column = ref ? ref.text : null;
    const sub = A.subqueryOf(node.right);
    if (sub) {
      hits.push({ column, kind: 'subquery' });
      return;
    }
    if (node.right && node.right.type === 'expr_list' && Array.isArray(node.right.value)) {
      const hasNull = node.right.value.some((v) => v && v.type === 'null');
      if (hasNull) hits.push({ column, kind: 'literal-null' });
    }
  });
  return hits;
}

// ---------------------------------------------------------------------------
// 新ルール: 外部結合がWHEREで打ち消されている
// ---------------------------------------------------------------------------

/**
 * LEFT/RIGHT/FULL JOIN した「NULL埋めされうる側」のテーブルの列を、WHERE句の
 * トップレベルANDで等値比較などで絞り込むと、NULL行が必ず条件から漏れるため
 * 実質的にINNER JOINになる（外部結合の意味が失われる）。
 *
 * 誤検知を避けるため、対象はトップレベルのAND項（括弧付きANDグループ含む）のみに限定する。
 * `IS NULL` は意図的な書き方（アンチジョイン）なので対象外。
 * `IS NOT NULL` は外部結合の打ち消しそのものなので検出対象。
 */
function findOuterJoinCancellation(ast) {
  const rowSource = A.rowSourceTables(ast);
  if (rowSource.length < 2 || !ast.where) return [];
  const nullable = A.nullableTableKeys(rowSource);
  if (nullable.size === 0) return [];

  const hits = [];
  for (const part of A.topLevelAndParts(ast.where)) {
    if (!part || part.type !== 'binary_expr') continue;
    const op = String(part.operator || '').toUpperCase();
    // IS NOT NULL はまさに外部結合の打ち消し（NULL埋めされた行を除外する）そのものなので
    // 対象に含める。IS NULL（アンチジョイン等の意図的な書き方）は引き続き対象外。
    const isNotNull = op === 'IS NOT' && part.right && part.right.type === 'null';
    if (!COMPARISON_OPS.has(op) && !isNotNull) continue;
    for (const side of [part.left, part.right]) {
      const ref = A.columnRef(side);
      if (!ref || !ref.table) continue;
      const key = lower(ref.table);
      if (!nullable.has(key)) continue;
      const entry = A.aliasMap(rowSource).get(key);
      hits.push({
        column: ref.text,
        table: entry ? entry.table : ref.table,
        alias: entry ? (entry.as || null) : null,
        // nullable.get(key) は「この参照をNULL埋め対象にした実際のJOIN種別」。
        // entry（rowSource中の自分自身のエントリ）の .join を見ると、RIGHT JOINで
        // NULL埋めされる側（先頭のFROMテーブルなど）では常にnullになってしまうため、
        // 必ず nullableTableKeys() が返す「原因のJOIN種別」を使う。
        joinKind: nullable.get(key),
        operator: part.operator,
      });
    }
  }

  // 同じテーブルについて何度も言わない
  const seen = new Set();
  return hits.filter((h) => {
    const key = lower(h.table) + '|' + lower(h.column);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// 既存ルールの補助判定（AST版）
// ---------------------------------------------------------------------------

function hasLimit(ast) {
  const l = ast.limit;
  if (!l) return false;
  if (Array.isArray(l.value)) return l.value.length > 0;
  return true;
}

function isSingleEqualityWhere(expr) {
  if (!expr || expr.type !== 'binary_expr') return false;
  if (String(expr.operator).toUpperCase() !== '=') return false;
  if (!expr.left || expr.left.type !== 'column_ref') return false;
  return A.isLiteral(expr.right);
}

function isMultiTableStatement(ast) {
  return A.rowSourceTables(ast).length > 1;
}

// ---------------------------------------------------------------------------
// エントリポイント
// ---------------------------------------------------------------------------

/**
 * AST から findings を組み立てる。
 * kind は analyzer.js の文種別（'UPDATE' / 'DELETE' 等）。
 * ここでは「文単位」で判定できるものだけを返し、トランザクション文脈など
 * 複数文にまたがるルールは analyzer.js 側で従来通り付与する。
 */
function analyzeAst(ast, kind, dialect) {
  const findings = [];
  if (!ast || typeof ast !== 'object') return findings;
  if (kind !== 'UPDATE' && kind !== 'DELETE') return findings;

  const rowSource = A.rowSourceTables(ast);
  const targets = A.writeTargets(ast);
  const hasJoin = rowSource.length > 1;

  if (!ast.where) {
    if (kind === 'UPDATE') {
      findings.push(mk(
        'danger',
        'no-where-update',
        'WHERE句のないUPDATE',
        hasJoin
          ? 'WHERE句が見つかりません。このままではJOINで一致した行がすべて更新されます（範囲を必ず確認してください）。想定通りであっても、WHERE句を明示するか、下記の検算SELECTで対象件数を確認してから実行することを強く推奨します。'
          : 'WHERE句が見つかりません。このままではテーブルの全行が更新されます。想定通りであっても、WHERE句を明示するか、下記の検算SELECTで対象件数を確認してから実行することを強く推奨します。'
      ));
    } else {
      findings.push(mk(
        'danger',
        'no-where-delete',
        'WHERE句のないDELETE',
        'WHERE句が見つかりません。このままではテーブルの全行が削除されます。TRUNCATEとの違いも含め、本当に全件削除でよいか再確認してください。'
      ));
    }
  } else {
    if (isAlwaysTrueWhere(ast.where)) {
      findings.push(mk(
        'danger',
        'always-true-where',
        '常に真になるWHERE句',
        'WHERE句が「1=1」や「\'a\'=\'a\'」のように常に真となる条件だけで構成されている、または他の条件とトップレベルのORでつながっています（「X OR 1=1」はXの内容にかかわらず常に真になります）。事実上WHERE句がないのと同じで、全行が対象になります。意図した絞り込み条件が抜けていないか確認してください。'
      ));
    }

    if (hasUnparenthesizedOrAnd(ast.where)) {
      findings.push(mk(
        'warning',
        'or-no-parens',
        'OR条件に括弧がありません',
        '「a=1 OR b=2 AND c=3」のような条件は AND が OR より先に評価されるため、意図せず対象範囲が広がることがあります。括弧で優先順位を明示してください（例: a=1 OR (b=2 AND c=3)）。'
      ));
    }

    if (hasLeadingWildcardLike(ast.where)) {
      findings.push(mk(
        'warning',
        'like-leading-wildcard',
        '前方一致でないLIKE条件',
        "LIKE '%...' のように先頭が % で始まるパターンは、想定より広い範囲の行がヒットする可能性があります。更新・削除対象を特定する条件としては特に、検算SELECTで対象件数を確認してから実行してください。"
      ));
    }

    const quotedNumeric = findQuotedNumericComparisons(ast.where);
    if (quotedNumeric.length > 0) {
      const examples = quotedNumeric.slice(0, 3).map((x) => `${x.column} ${x.op} '${x.value}'`).join(' / ');
      findings.push(mk(
        'warning',
        'implicit-conversion',
        '引用符付き数値リテラルによる暗黙型変換の疑い',
        `数値に見える値が文字列リテラルとして比較されています（例: ${examples}）。方言によっては暗黙的な型変換が行われ、インデックスが使われなくなったり、意図しない一致・不一致が起きることがあります。列の型を確認し、数値型であれば引用符なしでの比較を検討してください。`
      ));
    }

    if (findUncorrelatedSelfSubquery(ast, targets).length > 0) {
      findings.push(mk(
        'warning',
        'self-subquery-no-condition',
        'サブクエリに絞り込み条件がありません',
        'IN (SELECT ... FROM 同じテーブル) の形をしていますが、サブクエリ側に絞り込み条件（WHERE）が見当たりません。これは実質的に元のテーブルと同じ範囲を指しており、本来入れるはずだった相関条件が抜けている可能性があります。'
      ));
    }

    if (dialect === 'mysql' && !hasLimit(ast)) {
      // MySQLの複数テーブルUPDATE（`UPDATE t1, t2 SET ...` / `UPDATE t1 JOIN t2 ... SET ...`）だけでなく
      // 複数テーブルDELETE（`DELETE a FROM a JOIN b ... WHERE ...`）もLIMITを付けると構文エラーになるため、
      // どちらも対象から除外する。
      const multiTableStatement = (kind === 'UPDATE' || kind === 'DELETE') && isMultiTableStatement(ast);
      if (!isSingleEqualityWhere(ast.where) && !multiTableStatement) {
        findings.push(mk(
          'info',
          'mysql-no-limit',
          'LIMIT句がありません（MySQL）',
          'MySQLではUPDATE/DELETEにLIMITを付けることで、一度に変更される行数の上限を設定できます。対象件数の見積もりに自信がない場合は、検算SELECTで件数を確認するか、LIMITを付けて段階的に実行することを検討してください。'
        ));
      }
    }
  }

  // --- ここから AST でしか書けない新ルール ---

  const cancellations = findOuterJoinCancellation(ast);
  if (cancellations.length > 0) {
    const c = cancellations[0];
    const label = c.alias ? `${q(c.table)}（別名 ${c.alias}）` : q(c.table);
    findings.push(mk(
      'danger',
      'left-join-where-cancellation',
      '外部結合がWHERE句で打ち消されています',
      `${c.joinKind || 'OUTER'} JOIN した ${label} の列 ${q(c.column)} を、WHERE句で ${c.operator} により絞り込んでいます。外部結合で残したはずの「一致しなかった行」はこの列がNULLになるため、この条件で必ず除外されます。結果として実質INNER JOINになり、外部結合の意味が失われています。意図的なら INNER JOIN と明示的に書くか、条件を ON 句へ移す（もしくは ${q(c.column)} IS NULL を許容する形にする）ことを検討してください。`
    ));
  }

  const notIns = findNotInSubqueries(ast);
  const notInLiteralNull = notIns.find((h) => h.kind === 'literal-null');
  const notInSubquery = notIns.find((h) => h.kind === 'subquery');
  if (notInLiteralNull) {
    const col = notInLiteralNull.column ? `${q(notInLiteralNull.column)} の ` : '';
    findings.push(mk(
      'danger',
      'not-in-null-risk',
      'NOT IN リストにNULLが含まれています',
      `${col}NOT IN (...) の値リストにNULLが含まれています。SQLの三値論理により、リストに1件でもNULLがあると比較結果はすべて UNKNOWN になり、NULLが含まれるため結果は常に空です（この条件は1行もヒットしません）。意図した値だけを残すか、リストからNULLを取り除いてください。`
    ));
  }
  if (notInSubquery) {
    const col = notInSubquery.column ? `${q(notInSubquery.column)} の ` : '';
    findings.push(mk(
      'warning',
      'not-in-null-risk',
      'NOT IN (サブクエリ) のNULLリスク',
      `${col}NOT IN (SELECT ...) が使われています。サブクエリの結果に1件でもNULLが含まれると、比較結果がすべて UNKNOWN になり「1行も該当しない」＝全行が除外される挙動になります。サブクエリ側の列がNOT NULLだと確信できない場合は、NOT EXISTS の使用（または サブクエリ側に IS NOT NULL を追加）を検討してください。`
    ));
  }

  if (hasJoin && targets.length > 0) {
    const targetLabel = targets.map(tableLabel).join('、');
    const others = rowSource
      .filter((t) => !targets.some((tg) => lower(tg.table) === lower(t.table)))
      .map((t) => q(t.table));
    const otherText = others.length > 0 ? `JOINしている他のテーブル（${others.join('、')}）は条件の判定に使われるだけで、変更されません。` : '';
    findings.push(mk(
      'info',
      'update-delete-join-basis',
      kind === 'UPDATE' ? 'どのテーブルが更新されるか' : 'どのテーブルが削除されるか',
      `この文で実際に${kind === 'UPDATE' ? '書き換わる' : '削除される'}のは ${targetLabel} の行です。${otherText}`
    ));
  }

  return findings;
}

globalThis.SQLMeganeAstRules = {
  analyzeAst,
  _internal: {
    isTautologyExpr,
    isAlwaysTrueWhere,
    hasUnparenthesizedOrAnd,
    hasLeadingWildcardLike,
    findQuotedNumericComparisons,
    findUncorrelatedSelfSubquery,
    findNotInSubqueries,
    findOuterJoinCancellation,
    isSingleEqualityWhere,
    hasLimit,
  },
};

})();
