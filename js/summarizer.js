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

function summarizeUpdate(ast) {
  const rowSource = A.rowSourceTables(ast);
  const targets = A.writeTargets(ast);
  const cols = (ast.set || []).map((s) => A.columnName(s.column)).filter((c) => c != null);
  const colText = cols.length > 0 ? cols.map(columnLabel).join('、') : '（不明な列）';

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

  return {
    op: 'UPDATE',
    headline: `${tableLabels(targets)}の ${colText} を更新します`,
    blocks,
  };
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

  return {
    op: 'DELETE',
    headline: `${tableLabels(targets)}から行を削除します`,
    blocks,
  };
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

  return {
    op: 'INSERT',
    headline: `${tableLabels(targets)}に行を追加します`,
    blocks,
  };
}

function summarizeSelect(ast) {
  const rowSource = A.rowSourceTables(ast);
  const blocks = [];

  const cols = Array.isArray(ast.columns) ? ast.columns : [];
  const isStar = cols.length === 1 && (cols[0] === '*' || (cols[0] && cols[0].expr && (cols[0].expr.type === 'star' || A.columnName(cols[0].expr.column) === '*')));
  if (isStar || cols.length === 0) {
    blocks.push({ type: 'text', text: '取得する列: すべての列（*）' });
  } else {
    const names = cols.slice(0, 8).map((c) => {
      if (c && c.as) return `${valueText(c.expr)}（別名 ${c.as}）`;
      return c && c.expr ? valueText(c.expr) : '（式）';
    });
    const more = cols.length > 8 ? ` ほか${cols.length - 8}件` : '';
    blocks.push({ type: 'text', text: `取得する列: ${names.join('、')}${more}` });
  }

  blocks.push(...joinBlocks(rowSource));
  blocks.push(...whereBlocks(ast, 'SELECT'));

  if (ast.groupby) blocks.push({ type: 'text', text: 'GROUP BY によって集計された結果が返ります（行数は元テーブルの行数とは一致しません）。' });
  if (ast.limit && ast.limit.value && ast.limit.value.length > 0) {
    blocks.push({ type: 'text', text: `LIMIT による件数制限があります（${ast.limit.value.map(valueText).join(', ')}）。` });
  }

  return {
    op: 'SELECT',
    headline: rowSource.length > 0 ? `${tableLabels(rowSource.slice(0, 1))}から行を取得します` : '行を取得します',
    blocks,
  };
}

function summarizeSimple(op, headline) {
  return { op, headline, blocks: [] };
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
      summary = summarizeSimple('TRUNCATE', `${name}の全行を即座に削除します（多くの環境で取り消せません）`);
      break;
    }
    case 'drop': {
      const name = Array.isArray(ast.name) ? tableLabels(ast.name) : '（不明な対象）';
      summary = summarizeSimple('DROP', `${name}を定義ごと削除します`);
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
  },
};

})();
