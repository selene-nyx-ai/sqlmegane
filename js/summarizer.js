/**
 * SQLMegane（SQLめがね） summarizer.js
 *
 * パースに成功したSQLについて「このSQLは何をするか」を日本語で構造化して返す。
 * v2の主役機能。警告（findings）が「危ないところ」を指すのに対し、こちらは
 * 「書いたSQLの意味」を読み返すためのもの。
 *
 * 出力は表示用の素のデータ（文字列と入れ子のリスト）で返し、DOM生成は app.js に
 * 任せる。テキストとして扱えるので Node のテストからも検証できる。
 *
 * 文体: です・ます調。技術用語（UPDATE / JOIN / NULL 等）はそのまま残す。
 * 断定できないものは「要約できませんでした」と正直に書く（黙って省略しない）。
 *
 * analyzer.js と同じ理由で ESM の export は使わず globalThis に公開する。
 */

(function () {

const A = globalThis.SQLMeganeSqlAst;

// ---------------------------------------------------------------------------
// ラベル生成
// ---------------------------------------------------------------------------

function q(name) {
  return '`' + name + '`';
}

/** テーブル参照 → 「`users`（別名 u）」 */
function tableLabel(ref) {
  if (!ref) return '（不明なテーブル）';
  const name = ref.table || ref.name;
  if (!name) return '（不明なテーブル）';
  const alias = ref.as || ref.alias || null;
  return alias && alias !== name ? `${q(name)}（別名 ${alias}）` : q(name);
}

function tableLabels(refs) {
  if (!refs || refs.length === 0) return '（不明なテーブル）';
  return refs.map(tableLabel).join('、');
}

function columnLabel(name) {
  return name == null ? '（不明な列）' : q(name);
}

// ---------------------------------------------------------------------------
// 値・式のテキスト化
// ---------------------------------------------------------------------------

const DATE_LIKE_RE = /^'?\d{4}[-/]\d{1,2}([-/]\d{1,2})?/;

function funcName(node) {
  if (!node) return null;
  const n = node.name;
  if (typeof n === 'string') return n;
  if (n && Array.isArray(n.name) && n.name[0]) return n.name[0].value || null;
  if (n && typeof n.value === 'string') return n.value;
  return null;
}

/** 式を「値としての見え方」でテキスト化する（要約の右辺・左辺に使う） */
function valueText(node) {
  if (node == null) return '（不明）';
  const lit = A.literalText(node);
  if (lit !== null) return lit;

  switch (node.type) {
    case 'column_ref': {
      const ref = A.columnRef(node);
      return ref ? q(ref.text) : '（不明な列）';
    }
    case 'expr_list': {
      const sub = A.subqueryOf(node);
      if (sub) return 'サブクエリの結果';
      const items = (node.value || []).map(valueText);
      return `(${items.join(', ')})`;
    }
    case 'select':
      return 'サブクエリの結果';
    case 'function':
    case 'aggr_func': {
      const name = funcName(node);
      return name ? `${name}(...)` : '関数の結果';
    }
    case 'star':
      return 'すべての列（*）';
    case 'cast':
      return '型変換した値';
    case 'case':
      return 'CASE式の結果';
    case 'interval':
      return '期間（INTERVAL）';
    case 'binary_expr': {
      const l = valueText(node.left);
      const r = valueText(node.right);
      return `${l} ${node.operator} ${r}`;
    }
    default:
      if (node.ast) return 'サブクエリの結果';
      return '（式）';
  }
}

function isDateLikeText(text) {
  return typeof text === 'string' && DATE_LIKE_RE.test(text);
}

// ---------------------------------------------------------------------------
// 条件（WHERE / ON）の日本語化
// ---------------------------------------------------------------------------

const UNSUMMARIZED = '（この条件は要約できませんでした。原文を確認してください）';

function comparisonText(op, leftText, rightText, rightNode) {
  const dateLike = isDateLikeText(rightText) || (rightNode && rightNode.type === 'single_quote_string' && isDateLikeText(`'${rightNode.value}'`));
  switch (op) {
    case '=': return `${leftText} が ${rightText} と等しい`;
    case '!=':
    case '<>': return `${leftText} が ${rightText} と異なる`;
    case '>': return dateLike ? `${leftText} が ${rightText} より後である` : `${leftText} が ${rightText} より大きい`;
    case '<': return dateLike ? `${leftText} が ${rightText} より前である` : `${leftText} が ${rightText} より小さい`;
    case '>=': return `${leftText} が ${rightText} 以上である`;
    case '<=': return `${leftText} が ${rightText} 以下である`;
    default: return null;
  }
}

/** 単一の条件式を日本語1文にする */
function conditionText(expr) {
  if (!expr || typeof expr !== 'object') return UNSUMMARIZED;

  if (expr.type === 'unary_expr') {
    const op = String(expr.operator || '').toUpperCase();
    if (op === 'NOT') return `次の条件に当てはまらない: ${conditionText(expr.expr)}`;
    if (op === 'EXISTS') return 'サブクエリに該当する行が存在する';
    if (op === 'NOT EXISTS') return 'サブクエリに該当する行が存在しない';
    return UNSUMMARIZED;
  }

  if (expr.type === 'bool') return expr.value ? '常に真（TRUE）' : '常に偽（FALSE）';
  if (expr.type === 'number') return `${expr.value}（値そのもの）`;

  if (expr.type !== 'binary_expr') {
    const lit = A.literalText(expr);
    if (lit !== null) return `${lit}（値そのもの）`;
    return UNSUMMARIZED;
  }

  const op = String(expr.operator || '').toUpperCase();
  const left = valueText(expr.left);

  // 1 = 1 のような「両辺が同じリテラル」は、素直に訳すと
  // 「1 が 1 と等しい」となって危険さが伝わらないため、明示的に言い切る
  if (op === '=' && A.isLiteral(expr.left) && A.isLiteral(expr.right)
      && A.literalText(expr.left) === A.literalText(expr.right)) {
    return `常に真になる条件（${left} = ${valueText(expr.right)}）`;
  }

  if (op === 'IS' || op === 'IS NOT') {
    const isNull = expr.right && expr.right.type === 'null';
    if (isNull) return op === 'IS' ? `${left} が NULL である` : `${left} が NULL でない`;
    return `${left} が ${valueText(expr.right)} ${op === 'IS' ? 'である' : 'でない'}`;
  }

  if (op === 'LIKE' || op === 'NOT LIKE') {
    const pat = valueText(expr.right);
    const head = op === 'LIKE' ? '一致する' : '一致しない';
    const note = /^'%/.test(pat) ? '（先頭が % なので前方一致ではありません）' : '';
    return `${left} がパターン ${pat} に${head}${note}`;
  }

  if (op === 'IN' || op === 'NOT IN') {
    const sub = A.subqueryOf(expr.right);
    if (sub) {
      return op === 'IN'
        ? `${left} がサブクエリの結果に含まれる`
        : `${left} がサブクエリの結果に含まれない`;
    }
    const list = valueText(expr.right);
    // NOT IN の値リストに直接NULLが含まれる場合、SQLの三値論理により比較結果が
    // 常にUNKNOWNになり、この条件は常に空（1行もヒットしない）になる。
    // 要約でも黙って省略せず、その事実をそのまま書く。
    if (op === 'NOT IN' && expr.right && expr.right.type === 'expr_list'
        && Array.isArray(expr.right.value) && expr.right.value.some((v) => v && v.type === 'null')) {
      return `${left} が ${list} のいずれでもない（NULLが含まれるため結果は常に空です）`;
    }
    return op === 'IN' ? `${left} が ${list} のいずれかである` : `${left} が ${list} のいずれでもない`;
  }

  if (op === 'BETWEEN' || op === 'NOT BETWEEN') {
    const vals = (expr.right && expr.right.value) || [];
    const lo = valueText(vals[0]);
    const hi = valueText(vals[1]);
    return op === 'BETWEEN' ? `${left} が ${lo} 〜 ${hi} の範囲内である` : `${left} が ${lo} 〜 ${hi} の範囲外である`;
  }

  const cmp = comparisonText(op, left, valueText(expr.right), expr.right);
  if (cmp) return cmp;

  return UNSUMMARIZED;
}

/**
 * WHERE句を AND / OR の入れ子ツリー（表示用）に変換する。
 * 木の形は sql-ast.js の logicalTree に任せる。パーサがAND/ORの優先順位を
 * 適用しない（＝ASTの形がSQLの意味と一致しない）ため、必ずそちらで
 * 組み直したものを使うこと。詳細は sql-ast.js のコメントを参照。
 *
 * 戻り値: { connector: 'AND'|'OR'|null, text, children: [] }
 */
function conditionTree(expr) {
  if (!expr || typeof expr !== 'object') return { connector: null, text: UNSUMMARIZED, children: [] };
  return fromLogicalTree(A.logicalTree(expr));
}

function fromLogicalTree(node) {
  if (node.connector === null) return { connector: null, text: conditionText(node.expr), children: [] };
  return { connector: node.connector, text: null, children: node.children.map(fromLogicalTree) };
}

function treeIsFlat(node) {
  return node.connector !== null && node.children.every((c) => c.connector === null);
}

function joinWord(connector) {
  return connector === 'AND' ? ' かつ ' : ' または ';
}

/** ツリーを一行の文にできるなら文字列を、できないなら null を返す */
function flatConditionSentence(node) {
  if (node.connector === null) return node.text;
  if (!treeIsFlat(node) || node.children.length > 4) return null;
  return node.children.map((c) => c.text).join(joinWord(node.connector));
}

/** 表示用の入れ子リスト（app.js が <ul> に展開する） */
function conditionListItems(node) {
  if (node.connector === null) return [{ text: node.text, children: [] }];
  const label = node.connector === 'AND' ? '次のすべてを満たす' : '次のいずれかを満たす';
  return [{
    text: label,
    children: node.children.reduce((acc, c) => acc.concat(conditionListItems(c)), []),
  }];
}

// ---------------------------------------------------------------------------
// JOIN の意味論
// ---------------------------------------------------------------------------

function onConditionSuffix(entry) {
  if (!entry || !entry.on) return '';
  const sentence = flatConditionSentence(conditionTree(entry.on));
  return sentence ? `（結合条件: ${sentence}）` : '';
}

/**
 * JOIN を「どちら側が残り、どちら側が落ちるか」の日本語にする。
 * 「取得したい／外したい」の取り違えに気づけるよう、含まれる側と除外される側の
 * 両方を必ず言語化する。
 */
function joinBlocks(rowSource) {
  const blocks = [];
  if (!rowSource || rowSource.length < 2) return blocks;

  for (let i = 1; i < rowSource.length; i++) {
    const entry = rowSource[i];
    const kind = A.joinKind(entry);
    const right = tableLabel(entry);
    const left = i === 1 ? tableLabel(rowSource[0]) : 'ここまでの結合結果';
    const rightName = entry.table ? q(entry.table) : '結合先';
    const leftName = i === 1 && rowSource[0].table ? q(rowSource[0].table) : 'ここまでの結合結果';
    const on = onConditionSuffix(entry);
    let text;

    if (kind === 'INNER' || kind === null) {
      text = `INNER JOIN: ${right}に一致する行がある ${left}だけが対象です（${rightName}に一致する行が無い ${leftName}の行は対象から外れます）。${on}`;
    } else if (kind === 'LEFT') {
      text = `LEFT JOIN: ${right}に一致する行が無い ${left}も対象に含まれます（一致する行がある ${leftName}はもちろん対象です）。一致しなかった行では ${rightName}側の列は NULL になります。${on}`;
    } else if (kind === 'RIGHT') {
      text = `RIGHT JOIN: ${left}に一致する行が無い ${right}も対象に含まれます（一致する行がある ${rightName}はもちろん対象です）。一致しなかった行では ${leftName}側の列は NULL になります。${on}`;
    } else if (kind === 'FULL') {
      text = `FULL OUTER JOIN: ${left}と ${right}のどちらか一方にしか無い行も、両方とも対象に含まれます（足りない側の列は NULL になります）。${on}`;
    } else if (kind === 'CROSS') {
      text = `CROSS JOIN: 結合条件がありません。${left}と ${right}のすべての組み合わせ（直積）が対象になります。行数が掛け算で増えるため件数に注意してください。`;
    } else {
      text = `${entry.join}: ${left}と ${right}を結合します。${on}`;
    }

    blocks.push({ type: 'join', kind: kind || 'INNER', text: text.trim() });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// 見出し（headline）の一文統合
// ---------------------------------------------------------------------------
//
// 見出しの一文だけ読めば「どの行に何が起きるか」が分かることを目標にする。
// 構成は [JOIN要旨] 対象テーブル のうち、[WHERE要旨] 行の [操作] 。
//
// 【最優先は正確性】。一文に織り込むと意味が変わる・係り受けが曖昧になる場合は、
// 無理に短くせず省略形（「…など、複数の条件を…満たす」「（条件の詳細は下記）」）へ
// 落とす。下部の詳細ブロック（JOIN説明・WHERE箇条書き）が常に「正」で、
// 見出しはあくまで要旨。嘘をつくくらいなら長いか不完全な方がまし。

/** 一文に織り込める条件文の上限（AND/ORの葉の数）。超えたら省略形へ */
const HEADLINE_INLINE_LEAF_MAX = 3;
/** 省略形で名前を挙げる条件の数 */
const HEADLINE_NAMED_ON_OMIT = 2;

const DETAIL_NOTE = '（条件の詳細は下記）';

// 終止形 → 連用形。conditionText() が実際に生成しうる語尾だけを対象にする。
// 長い語尾から先に判定すること（「しない」を「ない」より先に見る）。
const RENYO_SUFFIXES = [
  ['である', 'であり'],
  ['でない', 'でなく'],
  ['しない', 'せず'],
  ['れない', 'れず'],
  ['する', 'し'],
  ['れる', 'れ'],
  ['ない', 'なく'],
  ['い', 'く'],
  ['る', 'り'],
];

/**
 * 一文に織り込める条件文か。
 * 「（…）」で終わる注釈付き（例: 常に真（TRUE）、NULLが含まれるため…）や
 * 「次の条件に当てはまらない: …」のような入れ子説明、要約不能は
 * そのまま「〜行」に繋ぐと日本語が壊れるので対象外にする。
 */
function inlinableCondition(text) {
  if (!text || text === UNSUMMARIZED) return false;
  if (/）$/.test(text)) return false;
  if (text.includes(':')) return false;
  return true;
}

/** 終止形の条件文を連用形にする。変換できない語尾なら null */
function toRenyo(text) {
  for (const [from, to] of RENYO_SUFFIXES) {
    if (text.endsWith(from)) return text.slice(0, -from.length) + to;
  }
  return null;
}

/**
 * 見出しに書く条件文。書けないなら null。
 *
 * conditionText() は「（先頭が % なので前方一致ではありません）」のような注意書きを
 * 末尾に足すことがある。これは「〜行」に繋ぐと日本語が壊れるので見出しでは落とす
 * （注意書き自体は下部のWHERE箇条書きにそのまま残るので情報は失われない）。
 * ただし「常に真（TRUE）」「1（値そのもの）」のように、括弧を外すと文でなくなる
 * ものまで落とすと意味不明になるため、外した後も述語で終わっている場合だけ採用する。
 */
function headlineLeafText(expr) {
  const text = conditionText(expr);
  if (inlinableCondition(text)) return text;
  const stripped = text.replace(/（[^（）]*）$/, '');
  if (stripped !== text && inlinableCondition(stripped) && toRenyo(stripped) !== null) return stripped;
  return null;
}

function lowerName(s) {
  return typeof s === 'string' ? s.toLowerCase() : null;
}

function refTableKey(node) {
  const ref = A.columnRef(node);
  return ref && ref.table ? lowerName(ref.table) : null;
}

// 「その列がNULLの行は必ず落ちる」比較演算子。外部結合の打ち消し判定に使う
const CANCELLING_OPS = new Set(['=', '!=', '<>', '>', '<', '>=', '<=', 'LIKE', 'NOT LIKE', 'IN', 'BETWEEN']);

/**
 * LEFT JOIN された表が、WHERE句のトップレベルAND項でどう扱われているかを判定する。
 *  - 'inner': NULL埋め行を必ず落とす条件がある（実質INNER JOIN）
 *  - 'anti' : その表の列の IS NULL だけがある（アンチジョイン。IS NULL は要旨に吸収する）
 *  - 'left' : WHEREで絞っていない（一致の有無にかかわらず残る）
 * ORの下の条件は「他の条件で救われうる」ため見ない（topLevelAndParts の仕様）。
 */
function classifyOuterJoin(entry, andParts) {
  const key = lowerName(entry.as || entry.table);
  if (!key) return { kind: 'left', consumed: [] };

  const isNulls = [];
  let cancelling = false;
  for (const part of andParts) {
    if (!part || part.type !== 'binary_expr') continue;
    const op = String(part.operator || '').toUpperCase();
    const touches = refTableKey(part.left) === key || refTableKey(part.right) === key;
    if (!touches) continue;
    if (op === 'IS' && part.right && part.right.type === 'null' && refTableKey(part.left) === key) {
      isNulls.push(part);
    } else if (CANCELLING_OPS.has(op) || (op === 'IS NOT' && part.right && part.right.type === 'null')) {
      cancelling = true;
    }
  }
  // 打ち消しとアンチジョインが同居する場合（矛盾した条件）は、断定できる
  // 「実質INNER」を採り、IS NULL は WHERE 要旨側に残して見えるようにする。
  if (cancelling) return { kind: 'inner', consumed: [] };
  if (isNulls.length > 0) return { kind: 'anti', consumed: isNulls };
  return { kind: 'left', consumed: [] };
}

// restricting = その結合によって対象テーブル側の行が落ちうるか。
// 落ちうる場合はWHERE句が無くても「全行」とは言い切れない。
const GIST_INNER = (name) => ({ rentai: `${name} に一致する行がある`, renyo: `${name} に一致する行があり`, restricting: true });
const GIST_ANTI = (name) => ({ rentai: `${name} に一致する行が無い`, renyo: `${name} に一致する行が無く`, restricting: true });
const GIST_LEFT = (name) => ({ rentai: `${name} との一致の有無にかかわらず`, renyo: `${name} との一致の有無にかかわらず`, restricting: false });
const GIST_CROSS = (name) => ({ rentai: `${name} と総当たりで組み合わせた`, renyo: `${name} と総当たりで組み合わせ`, restricting: true });
const GIST_PLAIN = (name) => ({ rentai: `${name} と結合した`, renyo: `${name} と結合し`, restricting: true });
const GIST_MANY = { rentai: '複数のテーブルと結合した', renyo: '複数のテーブルと結合し', restricting: true };

function joinTableName(entry) {
  return entry && entry.table ? q(entry.table) : '結合先';
}

/**
 * JOIN の要旨（対象テーブルの前に置く連体修飾）と、要旨に吸収して
 * WHERE要旨からは外してよい条件式（アンチジョインの IS NULL）を返す。
 */
function joinGist(ast, rowSource, targetTable) {
  if (!rowSource || rowSource.length < 2) return { text: null, consumed: [], restricting: false };

  const andParts = ast && ast.where ? A.topLevelAndParts(ast.where) : [];
  const joins = rowSource.slice(1);
  const baseName = lowerName(rowSource[0] && rowSource[0].table);
  const targetName = lowerName(targetTable);
  const baseIsTarget = !targetName || !baseName || baseName === targetName;

  let gists;
  let consumed = [];

  if (baseIsTarget) {
    gists = [];
    for (const entry of joins) {
      const kind = A.joinKind(entry);
      const name = joinTableName(entry);
      if (kind === 'CROSS') {
        gists.push(GIST_CROSS(name));
      } else if (kind === 'LEFT') {
        const c = classifyOuterJoin(entry, andParts);
        if (c.kind === 'inner') gists.push(GIST_INNER(name));
        else if (c.kind === 'anti') { gists.push(GIST_ANTI(name)); consumed = consumed.concat(c.consumed); }
        else gists.push(GIST_LEFT(name));
      } else if (kind === 'RIGHT' || kind === 'FULL') {
        // 残る側／落ちる側が対象テーブルとの関係で反転するため断定しない
        gists.push(GIST_PLAIN(name));
      } else {
        gists.push(GIST_INNER(name));
      }
    }
  } else {
    // 書き換え対象が結合された側にある場合（DELETE o FROM users u JOIN orders o ...）。
    // INNER JOIN は「両方に一致する行だけが残る」ので向きを入れ替えても言い切れるが、
    // 外部結合は反転すると意味が変わるため、断定を避けて「複数のテーブルと結合した」に落とす。
    const allInner = joins.every((e) => {
      const k = A.joinKind(e);
      return k === 'INNER' || k === null;
    });
    if (!allInner) return { text: GIST_MANY.rentai, consumed: [], restricting: true };
    const others = rowSource.filter((e) => lowerName(e.table) !== targetName);
    gists = others.map((e) => GIST_INNER(joinTableName(e)));
  }

  if (gists.length === 0) return { text: null, consumed: [], restricting: false };
  const restricting = gists.some((g) => g.restricting);
  if (gists.length === 1) return { text: gists[0].rentai, consumed, restricting };
  if (gists.length === 2) return { text: `${gists[0].renyo}、${gists[1].rentai}`, consumed, restricting };
  // 3個以上は一文に入れると読めなくなるので要約し、詳細は下部のJOINブロックに任せる。
  // 要旨がアンチジョインを表現しなくなるため、条件の吸収も取り消す。
  return { text: GIST_MANY.rentai, consumed: [], restricting: true };
}

/** 消費済み（JOIN要旨に吸収された）条件をANDツリーから取り除く */
function pruneConsumed(node, consumed) {
  if (consumed.size === 0) return node;
  if (node.connector === null) return consumed.has(node.expr) ? null : node;
  // ORの枝から条件を落とすと条件が緩む方向に意味が変わるため触らない
  if (node.connector !== 'AND') return node;
  const kids = [];
  for (const c of node.children) {
    const k = pruneConsumed(c, consumed);
    if (k) kids.push(k);
  }
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0];
  return { connector: 'AND', expr: null, children: kids };
}

function omitTail(connector) {
  return connector === 'AND' ? 'など、複数の条件をすべて満たす' : 'など、複数の条件のいずれかを満たす';
}

function opaqueText(connector) {
  return connector === 'AND' ? '複数の条件をすべて満たす' : '複数の条件のいずれかを満たす';
}

/** 論理ツリー（A.logicalTree のノード）を見出し用の一文の断片にする */
function headlineConditionText(node) {
  if (node.connector === null) {
    const t = headlineLeafText(node.expr);
    return t ? { text: t, note: false } : { text: '条件に一致する', note: true };
  }

  const flat = node.children.every((c) => c.connector === null);
  if (flat && node.children.length <= HEADLINE_INLINE_LEAF_MAX) {
    const texts = node.children.map((c) => headlineLeafText(c.expr));
    if (texts.every((t) => t !== null)) {
      const last = texts[texts.length - 1];
      if (node.connector === 'OR') {
        return { text: texts.join('、または '), note: false };
      }
      // AND は連用形で繋ぐ（「〜と等しく、かつ 〜」）
      const heads = texts.slice(0, -1).map(toRenyo);
      if (heads.every((h) => h !== null)) {
        return { text: heads.concat([last]).join('、かつ '), note: false };
      }
    }
  }

  // 省略形: 浅い（直下の葉）条件を2つまで挙げ、省略していることを明示する。
  // AND/OR混在で「かつ／または」の係り受けが曖昧になる文はここに落ちる。
  // 挙げた条件どうしは並列に「、」で並べるだけにして、実際の関係（すべて／いずれか）は
  // 末尾で言い切る。連用形で繋ぐとORでもANDに読めてしまうため。
  const named = [];
  for (const c of node.children) {
    if (named.length >= HEADLINE_NAMED_ON_OMIT) break;
    if (c.connector !== null) continue;
    const t = headlineLeafText(c.expr);
    if (t) named.push(t);
  }
  if (named.length === 0) return { text: opaqueText(node.connector), note: true };
  return { text: named.join('、') + omitTail(node.connector), note: false };
}

/**
 * WHERE の要旨。
 *  { kind: 'all-rows' }                … WHERE句なし（絞り込みゼロ）
 *  { kind: 'none' }                    … 条件がすべてJOIN要旨に吸収された
 *  { kind: 'text', text, note }        … 一文に織り込む条件（note=true なら省略の明示が必要）
 */
function whereGist(ast, consumedList) {
  if (!ast || !ast.where) return { kind: 'all-rows' };
  const consumed = new Set(consumedList || []);
  const pruned = pruneConsumed(A.logicalTree(ast.where), consumed);
  if (!pruned) return { kind: 'none' };
  const r = headlineConditionText(pruned);
  return { kind: 'text', text: r.text, note: r.note };
}

// --- 見出しの部品組み立て --------------------------------------------------

function pushPart(parts, value) {
  if (value == null || value === '') return;
  parts.push(typeof value === 'string' ? { text: value, strong: false } : value);
}

/**
 * 助詞の前に空ける半角スペース。`users` のようにバッククォートで終わる直後は
 * 空けたほうが読みやすいが、「（別名 u）」のように全角の閉じ括弧で終わる場合は
 * 空けると間延びするので詰める。
 */
function particleSpace(parts) {
  const prev = parts.length > 0 ? parts[parts.length - 1].text : '';
  return /[）」』】]$/.test(prev) ? '' : ' ';
}

/**
 * 「[JOIN要旨] 対象テーブル のうち、[WHERE要旨] 行」までを組み立てる。
 * endsWithRow は「行」「全行」で終わったか（後続の助詞の付け方が変わる）。
 */
function subjectParts(targetLabel, gist, where, emphasizeAllRows) {
  const parts = [];
  if (gist.text) { pushPart(parts, gist.text); pushPart(parts, ' '); }
  pushPart(parts, targetLabel);

  if (where.kind === 'all-rows') {
    // 結合で行が落ちうる場合、WHERE句が無くても「全行」ではない。嘘になるので言わない。
    if (gist.restricting) return { parts, endsWithRow: false, note: false };
    pushPart(parts, `${particleSpace(parts)}の`);
    parts.push({ text: '全行', strong: !!emphasizeAllRows });
    return { parts, endsWithRow: true, note: false };
  }
  if (where.kind === 'none') {
    return { parts, endsWithRow: false, note: false };
  }
  pushPart(parts, `${particleSpace(parts)}のうち、`);
  pushPart(parts, where.text);
  pushPart(parts, '行');
  return { parts, endsWithRow: true, note: where.note };
}

function finishHeadline(parts, note) {
  if (note) pushPart(parts, DETAIL_NOTE);
  return {
    headline: parts.map((p) => p.text).join(''),
    headlineParts: parts,
  };
}

// ---------------------------------------------------------------------------
// 文種別ごとの要約
// ---------------------------------------------------------------------------

function setAssignmentsBlock(ast) {
  const sets = Array.isArray(ast.set) ? ast.set : [];
  const items = sets.map((s) => {
    const col = A.columnName(s.column);
    const val = valueText(s.value);
    return `${columnLabel(col)} を ${val} にする`;
  });
  if (items.length === 0) return null;
  return { type: 'list', title: '設定する値', items: items.map((t) => ({ text: t, children: [] })) };
}

function whereBlocks(ast, kind) {
  const blocks = [];
  if (!ast.where) {
    if (kind === 'UPDATE' || kind === 'DELETE') {
      blocks.push({
        type: 'alert',
        text: kind === 'UPDATE'
          ? '⚠ 条件なし＝全行が対象です。WHERE句が無いため、絞り込みは一切かかりません。'
          : '⚠ 条件なし＝全行が対象です。WHERE句が無いため、テーブルの全行が削除されます。',
      });
    } else {
      blocks.push({ type: 'text', text: 'WHERE句はありません（絞り込みなし）。' });
    }
    return blocks;
  }

  const tree = conditionTree(ast.where);
  const sentence = flatConditionSentence(tree);
  if (sentence) {
    blocks.push({ type: 'text', text: `対象は ${sentence}行です。` });
  } else {
    blocks.push({ type: 'list', title: '対象になる行の条件（WHERE）', items: conditionListItems(tree) });
  }
  return blocks;
}

/** SET句を見出しに織り込む断片。1〜2列は値まで、3列以上は列数に丸める */
function setPhrase(ast) {
  const sets = Array.isArray(ast.set) ? ast.set : [];
  const cols = sets.map((s) => A.columnName(s.column));
  if (sets.length === 0 || cols.some((c) => c == null)) {
    return cols.length > 0
      ? `${cols.map(columnLabel).join('、')} を更新します`
      : '（不明な列）を更新します';
  }
  if (sets.length <= 2) {
    const pairs = sets.map((s, i) => `${columnLabel(cols[i])} を ${valueText(s.value)} に`);
    return `${pairs.join('、')}更新します`;
  }
  return `${columnLabel(cols[0])} など${sets.length}列を更新します`;
}

function summarizeUpdate(ast) {
  const rowSource = A.rowSourceTables(ast);
  const targets = A.writeTargets(ast);

  const blocks = [];
  if (rowSource.length > 1) {
    blocks.push({
      type: 'text',
      text: `更新されるのは ${tableLabels(targets)}側の行です（他のテーブルは条件の判定に使われるだけで、書き換わりません）。`,
    });
  }
  const setBlock = setAssignmentsBlock(ast);
  if (setBlock) blocks.push(setBlock);
  blocks.push(...joinBlocks(rowSource));
  blocks.push(...whereBlocks(ast, 'UPDATE'));

  const gist = joinGist(ast, rowSource, targets[0] && targets[0].table);
  const where = whereGist(ast, gist.consumed);
  const subj = subjectParts(tableLabels(targets), gist, where, true);
  pushPart(subj.parts, subj.endsWithRow ? 'の ' : `${particleSpace(subj.parts)}の `);
  pushPart(subj.parts, setPhrase(ast));

  return Object.assign({ op: 'UPDATE', blocks }, finishHeadline(subj.parts, subj.note));
}

function summarizeDelete(ast) {
  const rowSource = A.rowSourceTables(ast);
  const targets = A.writeTargets(ast);

  const blocks = [];
  if (rowSource.length > 1) {
    blocks.push({
      type: 'text',
      text: `削除されるのは ${tableLabels(targets)}側の行です（他のテーブルは条件の判定に使われるだけで、削除されません）。`,
    });
  }
  blocks.push(...joinBlocks(rowSource));
  blocks.push(...whereBlocks(ast, 'DELETE'));

  const gist = joinGist(ast, rowSource, targets[0] && targets[0].table);
  const where = whereGist(ast, gist.consumed);
  const subj = subjectParts(tableLabels(targets), gist, where, true);
  if (!subj.endsWithRow) pushPart(subj.parts, `${particleSpace(subj.parts)}の行`);
  pushPart(subj.parts, 'を削除します');

  return Object.assign({ op: 'DELETE', blocks }, finishHeadline(subj.parts, subj.note));
}

function summarizeInsert(ast) {
  const targets = A.writeTargets(ast);
  const blocks = [];
  const cols = Array.isArray(ast.columns) ? ast.columns.map((c) => A.columnName(c)).filter((c) => c != null) : [];
  if (cols.length > 0) {
    blocks.push({ type: 'text', text: `指定している列: ${cols.map(columnLabel).join('、')}` });
  }

  const values = ast.values;
  if (values && values.type === 'values' && Array.isArray(values.values)) {
    blocks.push({ type: 'text', text: `固定値を ${values.values.length} 行ぶん追加します。` });
  } else if (values && (values.type === 'select' || values.ast)) {
    blocks.push({ type: 'text', text: 'SELECTの結果をそのまま追加します。取得件数がそのまま追加件数になります。' });
  } else if (ast.set) {
    const setBlock = setAssignmentsBlock(ast);
    if (setBlock) blocks.push(setBlock);
  }

  // INSERT には JOIN / WHERE が無いので、「どこに・何を・何行」を一文にまとめる。
  const label = tableLabels(targets);
  const colPhrase = cols.length === 0
    ? ''
    : (cols.length <= 3
      ? ` の ${cols.map(columnLabel).join('、')}`
      : ` の ${columnLabel(cols[0])} など${cols.length}列`);
  const headParts = [];
  pushPart(headParts, label + colPhrase + ' に');
  if (values && values.type === 'values' && Array.isArray(values.values)) {
    pushPart(headParts, `固定値を ${values.values.length} 行追加します`);
  } else if (values && (values.type === 'select' || values.ast)) {
    pushPart(headParts, ' SELECT の結果をそのまま追加します（取得件数がそのまま追加件数になります）');
  } else if (Array.isArray(ast.set) && ast.set.length > 0) {
    const sets = ast.set;
    if (sets.length <= 2) {
      const pairs = sets.map((s) => `${columnLabel(A.columnName(s.column))} を ${valueText(s.value)} に`);
      pushPart(headParts, `${pairs.join('、')}した行を 1 行追加します`);
    } else {
      pushPart(headParts, `${columnLabel(A.columnName(sets[0].column))} など${sets.length}列を設定した行を 1 行追加します`);
    }
  } else {
    pushPart(headParts, '行を追加します');
  }

  return Object.assign({ op: 'INSERT', blocks }, finishHeadline(headParts, false));
}

function selectColumnNames(ast) {
  const cols = Array.isArray(ast.columns) ? ast.columns : [];
  return cols.map((c) => {
    if (c && c.as) return `${valueText(c.expr)}（別名 ${c.as}）`;
    return c && c.expr ? valueText(c.expr) : '（式）';
  });
}

function selectIsStar(ast) {
  const cols = Array.isArray(ast.columns) ? ast.columns : [];
  return cols.length === 0
    || (cols.length === 1 && (cols[0] === '*' || (cols[0] && cols[0].expr && (cols[0].expr.type === 'star' || A.columnName(cols[0].expr.column) === '*'))));
}

/** 取得する列を見出しに織り込む断片。3列までは並べ、4列以上は列数に丸める */
function selectColumnsPhrase(ast) {
  if (selectIsStar(ast)) return 'すべての列（*）';
  const names = selectColumnNames(ast);
  if (names.length <= 3) return names.join('、');
  return `${names[0]} など${names.length}列`;
}

function summarizeSelect(ast) {
  const rowSource = A.rowSourceTables(ast);
  const blocks = [];

  if (selectIsStar(ast)) {
    blocks.push({ type: 'text', text: '取得する列: すべての列（*）' });
  } else {
    const all = selectColumnNames(ast);
    const names = all.slice(0, 8);
    const more = all.length > 8 ? ` ほか${all.length - 8}件` : '';
    blocks.push({ type: 'text', text: `取得する列: ${names.join('、')}${more}` });
  }

  blocks.push(...joinBlocks(rowSource));
  blocks.push(...whereBlocks(ast, 'SELECT'));

  if (ast.groupby) blocks.push({ type: 'text', text: 'GROUP BY によって集計された結果が返ります（行数は元テーブルの行数とは一致しません）。' });
  if (ast.limit && ast.limit.value && ast.limit.value.length > 0) {
    blocks.push({ type: 'text', text: `LIMIT による件数制限があります（${ast.limit.value.map(valueText).join(', ')}）。` });
  }

  if (rowSource.length === 0) {
    return Object.assign({ op: 'SELECT', blocks }, finishHeadline([{ text: '行を取得します', strong: false }], false));
  }

  const gist = joinGist(ast, rowSource, rowSource[0] && rowSource[0].table);
  const where = whereGist(ast, gist.consumed);
  // SELECT の「全行」は危険を意味しないので強調はしない
  const subj = subjectParts(tableLabels(rowSource.slice(0, 1)), gist, where, false);

  if (ast.groupby) {
    // GROUP BY があると返るのは集計結果で、行と列の対応がそのままではない。
    // 列名を並べると誤読させるため、集計であることだけを述べる。
    if (!subj.endsWithRow) pushPart(subj.parts, `${particleSpace(subj.parts)}の行`);
    pushPart(subj.parts, 'を集計した結果を取得します');
  } else {
    pushPart(subj.parts, subj.endsWithRow ? 'の ' : `${particleSpace(subj.parts)}の `);
    pushPart(subj.parts, `${selectColumnsPhrase(ast)} を取得します`);
  }

  return Object.assign({ op: 'SELECT', blocks }, finishHeadline(subj.parts, subj.note));
}

function summarizeSimple(op, parts) {
  return Object.assign({ op, blocks: [] }, finishHeadline(parts.map(
    (p) => (typeof p === 'string' ? { text: p, strong: false } : p)
  ), false));
}

// ---------------------------------------------------------------------------
// エントリポイント
// ---------------------------------------------------------------------------

/**
 * AST から日本語要約を作る。要約できない文種別では null を返す
 * （＝要約カードを出さない。無理に何か書くより黙るほうが誠実）。
 */
function summarize(ast) {
  if (!ast || typeof ast !== 'object') return null;
  let summary = null;

  switch (ast.type) {
    case 'update': summary = summarizeUpdate(ast); break;
    case 'delete': summary = summarizeDelete(ast); break;
    case 'insert':
    case 'replace': summary = summarizeInsert(ast); break;
    case 'select': summary = summarizeSelect(ast); break;
    case 'truncate': {
      const name = Array.isArray(ast.name) ? tableLabels(ast.name) : '（不明なテーブル）';
      summary = summarizeSimple('TRUNCATE', [
        `${name} の`,
        { text: '全行', strong: true },
        'を即座に削除します（多くの環境で取り消せません）',
      ]);
      break;
    }
    case 'drop': {
      const name = Array.isArray(ast.name) ? tableLabels(ast.name) : '（不明な対象）';
      summary = summarizeSimple('DROP', [`${name} を定義ごと削除します`]);
      break;
    }
    default:
      return null;
  }

  if (ast.with && Array.isArray(ast.with) && ast.with.length > 0) {
    const names = ast.with.map((w) => (w && w.name && (w.name.value || w.name)) || '?').join('、');
    summary.blocks.unshift({ type: 'text', text: `WITH句（CTE）: ${names} を先に組み立ててから本体を実行します。` });
  }

  return summary;
}

/** 要約を素のテキスト行に落とす（テスト・コピー用） */
function summaryToLines(summary) {
  if (!summary) return [];
  const lines = [`${summary.op}: ${summary.headline}`];
  const pushItems = (items, depth) => {
    for (const item of items) {
      lines.push(`${'  '.repeat(depth)}- ${item.text}`);
      if (item.children && item.children.length > 0) pushItems(item.children, depth + 1);
    }
  };
  for (const b of summary.blocks) {
    if (b.type === 'list') {
      if (b.title) lines.push(`${b.title}:`);
      pushItems(b.items, 1);
    } else {
      lines.push(b.text);
    }
  }
  return lines;
}

globalThis.SQLMeganeSummarizer = {
  summarize,
  summaryToLines,
  _internal: {
    conditionText,
    conditionTree,
    flatConditionSentence,
    conditionListItems,
    joinBlocks,
    valueText,
    tableLabel,
    toRenyo,
    inlinableCondition,
    joinGist,
    whereGist,
  },
};

})();
