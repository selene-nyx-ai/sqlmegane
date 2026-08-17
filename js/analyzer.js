/**
 * SQLMegane（SQLめがね） analyzer.js
 *
 * SQL の危険パターンを検出する純粋なロジック層。UI (app.js) からは独立しており、
 * ブラウザでも Node.js (テスト) でも同じコードで動く。
 *
 * file:// 直開きでのCORS制限を避けるため ESM の export は使わず、通常の
 * スクリプトとして読み込んだ上でファイル末尾から globalThis.SQLMeganeAnalyzer に
 * 公開する（経緯は README.md / docs/architecture.md を参照）。
 *
 * 重要な設計方針:
 *  - v2 から、MySQL / PostgreSQL / SQL Server の3方言については同梱パーサ
 *    （js/vendor/node-sql-parser-*.js）でASTを取り、AST基盤の検出ルール
 *    （js/ast-rules.js）と日本語要約（js/summarizer.js）を使う。
 *  - パースできない場合（Oracle・汎用、または構文がパーサの対応外だった場合）は、
 *    このファイルが元々持っている "正規表現 + 簡易な状態機械" のヒューリスティックに
 *    フォールバックする。フォールバックしたことは結果に含めてUIで明示する。
 *  - 正規表現側は "パーサ" ではないため、複雑な SQL を 100% 正しく解析することは
 *    できません（README / docs/architecture.md 参照）。
 *  - 誤検知（false positive）を出すくらいなら検出を諦める、という方針で実装しています。
 *  - 入力された SQL 文字列はこのファイル内で完結して処理され、どこにも送信されません。
 */

// IIFEで包む理由: このファイルはESMではなく通常のスクリプトとして読み込まれる
// ため、トップレベルの function/const 宣言はそのまま window の直下に漏れ出す。
// もし包まずに `function analyzeSQL(...) {...}` を素で置くと、window.analyzeSQL
// という「暗黙のグローバル」が生まれ、app.js 側で
// `const { analyzeSQL } = globalThis.SQLMeganeAnalyzer;` のように同名の const を
// 宣言した瞬間に "Identifier 'analyzeSQL' has already been declared" という
// SyntaxError になる（実際にheadless Chromeでのfile://検証で再現・確認した）。
// IIFEで閉じ込め、最後に globalThis.SQLMeganeAnalyzer への代入だけを明示的に
// 行うことで、この種の名前衝突を避ける。
(function () {

// ---------------------------------------------------------------------------
// 低レベルユーティリティ: 文字列リテラル / コメントを意識した走査
// ---------------------------------------------------------------------------

/**
 * SQL 文字列を「元のテキストのまま (plain)」と「構造解析用にマスクしたもの
 * (masked)」の 2 種類、同じ長さで同時に生成する。
 * コメント (-- ... / * ... * /) はどちらも空白に置き換える。
 *
 * scan() が区別する 3 つのカテゴリ:
 *  - 文字列リテラル（シングルクォート `'...'`）: 値の中身は危険パターン検出に
 *    使わないため、masked では中身を x でマスクする（WHERE や OR という
 *    単語がたまたま値に含まれていても誤検知しないようにするため）。
 *  - 引用符付き識別子（バッククォート `` `...` ``、ダブルクォート `"..."`、
 *    SQL Serverの角カッコ `[...]`）: テーブル名・カラム名なので、masked でも
 *    中身をマスクせずそのまま残す。これにより `` UPDATE `users` SET ... ``
 *    のような文でも、検算SELECTの生成などで実際のテーブル名を正しく
 *    読み取れる。
 *  - コメント: plain/masked どちらも空白に置き換える。
 *
 * masked はキーワード検索・括弧の深さ計算など「構造」を見るために使う。
 * plain は実際のリテラルの値が必要な場面（'123' のような値の中身、
 * LIKE のパターンなど）で使う。
 *
 * dialect が 'mysql' の場合、文字列リテラル内のバックスラッシュエスケープ
 * （例: 'it\'s bad'）を認識し、エスケープされたクォートで文字列が終端しない
 * ようにする。他方言ではバックスラッシュは特別扱いしない（標準SQLでは
 * バックスラッシュに構文的な意味はないため）。
 */
function scan(stmt, dialect) {
  const mysqlEscapes = dialect === 'mysql';
  let plain = '';
  let masked = '';
  let i = 0;
  const n = stmt.length;
  let state = 'normal'; // normal | single | double | backtick | bracket | line | block

  while (i < n) {
    const c = stmt[i];
    const c2 = i + 1 < n ? stmt[i + 1] : '';

    if (state === 'normal') {
      if (c === "'") {
        plain += c; masked += c; state = 'single'; i++; continue;
      }
      if (c === '"') {
        plain += c; masked += c; state = 'double'; i++; continue;
      }
      if (c === '`') {
        plain += c; masked += c; state = 'backtick'; i++; continue;
      }
      if (c === '[') {
        plain += c; masked += c; state = 'bracket'; i++; continue;
      }
      if (c === '-' && c2 === '-') {
        plain += '  '; masked += '  '; state = 'line'; i += 2; continue;
      }
      if (c === '/' && c2 === '*') {
        plain += '  '; masked += '  '; state = 'block'; i += 2; continue;
      }
      plain += c; masked += c; i++; continue;
    }

    if (state === 'single') {
      if (mysqlEscapes && c === '\\' && i + 1 < n) {
        plain += c + c2; masked += 'xx'; i += 2; continue;
      }
      if (c === "'" && c2 === "'") { plain += "''"; masked += 'xx'; i += 2; continue; }
      if (c === "'") { plain += c; masked += c; state = 'normal'; i++; continue; }
      plain += c; masked += (c === '\n' ? '\n' : 'x'); i++; continue;
    }

    // 引用符付き識別子（ダブルクォート）: 中身はマスクせず、そのまま保持する。
    if (state === 'double') {
      if (c === '"' && c2 === '"') { plain += '""'; masked += '""'; i += 2; continue; }
      if (c === '"') { plain += c; masked += c; state = 'normal'; i++; continue; }
      plain += c; masked += c; i++; continue;
    }

    // 引用符付き識別子（バッククォート、MySQL）: 中身はマスクせず、そのまま保持する。
    if (state === 'backtick') {
      if (c === '`' && c2 === '`') { plain += '``'; masked += '``'; i += 2; continue; }
      if (c === '`') { plain += c; masked += c; state = 'normal'; i++; continue; }
      plain += c; masked += c; i++; continue;
    }

    // 引用符付き識別子（角カッコ、SQL Server）: 中身はマスクせず、そのまま保持する。
    if (state === 'bracket') {
      if (c === ']' && c2 === ']') { plain += ']]'; masked += ']]'; i += 2; continue; }
      if (c === ']') { plain += c; masked += c; state = 'normal'; i++; continue; }
      plain += c; masked += c; i++; continue;
    }

    if (state === 'line') {
      const ch = c === '\n' ? '\n' : ' ';
      plain += ch; masked += ch;
      if (c === '\n') state = 'normal';
      i++; continue;
    }

    if (state === 'block') {
      if (c === '*' && c2 === '/') { plain += '  '; masked += '  '; state = 'normal'; i += 2; continue; }
      const ch = c === '\n' ? '\n' : ' ';
      plain += ch; masked += ch; i++; continue;
    }
  }

  return { plain, masked };
}

/**
 * SQL テキストをセミコロンで文に分割する。文字列リテラル・引用符付き識別子・
 * コメント内のセミコロンでは分割しない。空文（コメントのみ・空白のみ）は除外する。
 *
 * dialect が 'mysql' の場合、文字列リテラル内のバックスラッシュエスケープを
 * 認識する（scan() と同じ方針。詳細はそちらのコメント参照）。
 */
function splitStatementsWithOffsets(sql, dialect) {
  const mysqlEscapes = dialect === 'mysql';
  const statements = [];
  let i = 0;
  const n = sql.length;
  let state = 'normal';
  let start = 0;
  const push = (from, to) => statements.push({ raw: sql.slice(from, to), start: from });

  while (i < n) {
    const c = sql[i];
    const c2 = i + 1 < n ? sql[i + 1] : '';

    if (state === 'normal') {
      if (c === "'") { state = 'single'; i++; continue; }
      if (c === '"') { state = 'double'; i++; continue; }
      if (c === '`') { state = 'backtick'; i++; continue; }
      if (c === '[') { state = 'bracket'; i++; continue; }
      if (c === '-' && c2 === '-') { state = 'line'; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; i += 2; continue; }
      if (c === ';') { push(start, i); i++; start = i; continue; }
      i++; continue;
    }
    if (state === 'single') {
      if (mysqlEscapes && c === '\\' && i + 1 < n) { i += 2; continue; }
      if (c === "'" && c2 === "'") { i += 2; continue; }
      if (c === "'") { state = 'normal'; i++; continue; }
      i++; continue;
    }
    if (state === 'double') {
      if (c === '"' && c2 === '"') { i += 2; continue; }
      if (c === '"') { state = 'normal'; i++; continue; }
      i++; continue;
    }
    if (state === 'backtick') {
      if (c === '`' && c2 === '`') { i += 2; continue; }
      if (c === '`') { state = 'normal'; i++; continue; }
      i++; continue;
    }
    if (state === 'bracket') {
      if (c === ']' && c2 === ']') { i += 2; continue; }
      if (c === ']') { state = 'normal'; i++; continue; }
      i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') state = 'normal';
      i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'normal'; i += 2; continue; }
      i++; continue;
    }
  }
  if (start < n) push(start, n);

  return statements
    .map((s) => {
      // trim した分だけ開始位置をずらす（構文エラー位置を元テキストの行番号へ
      // 変換するために、文の開始オフセットを正確に保つ必要がある）
      const leading = s.raw.length - s.raw.replace(/^\s+/, '').length;
      return { raw: s.raw.trim(), start: s.start + leading };
    })
    .filter((s) => s.raw.length > 0)
    // コメントだけの文（例: "-- foo"）は実質空文なので除外する
    .filter((s) => scan(s.raw, dialect).plain.trim().length > 0);
}

/** 従来通り文字列の配列を返す公開API（互換維持） */
function splitStatements(sql, dialect) {
  return splitStatementsWithOffsets(sql, dialect).map((s) => s.raw);
}

function lineNumberAt(text, offset) {
  if (offset == null || offset < 0) return 1;
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

// ---------------------------------------------------------------------------
// トップレベル（括弧の深さ 0）でのキーワード検索
// ---------------------------------------------------------------------------

function topLevelSearch(str, words, start) {
  let depth = 0;
  const re = /[A-Za-z_][A-Za-z0-9_]*|\(|\)/g;
  re.lastIndex = start || 0;
  let m;
  while ((m = re.exec(str))) {
    const tok = m[0];
    if (tok === '(') { depth++; continue; }
    if (tok === ')') { depth--; continue; }
    if (depth === 0 && words.includes(tok.toUpperCase())) {
      return { index: m.index, length: tok.length, word: tok.toUpperCase() };
    }
  }
  return null;
}

function hasTopLevelWord(str, word, start) {
  return topLevelSearch(str, [word], start || 0) !== null;
}

function extractParenGroupEnd(str, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < str.length; i++) {
    if (str[i] === '(') depth++;
    else if (str[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// 識別子（テーブル名・列名）の抽出
// ---------------------------------------------------------------------------

const IDENT = '(?:`[^`]+`|"[^"]+"|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)';
const QUALIFIED_IDENT_RE = new RegExp('^(' + IDENT + '(?:\\.' + IDENT + ')*)');

function matchLeadingIdentifier(str) {
  const m = str.match(QUALIFIED_IDENT_RE);
  return m ? m[1] : null;
}

function normalizeIdent(name) {
  return name
    .replace(/[`"\[\]]/g, '')
    .split('.')
    .pop()
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// CTE (WITH句) のスキップ
// ---------------------------------------------------------------------------

/**
 * masked が `WITH ... AS (...), ... AS (...) <本体>` の形で始まっている場合、
 * CTE定義部分を読み飛ばして本体（実際のUPDATE/DELETE/SELECT等）が始まる
 * インデックスを返す。WITH句がない場合は 0 を返す。
 * CTE定義が想定外の形（構文が崩れている等）で読み切れない場合も、安全側に
 * 倒して 0 を返す（＝先頭からそのまま判定させる。CTEを見誤って中身を
 * 誤判定するより、CTE自体を無視してOTHER寄りに倒れる方が実害が少ない）。
 */
function findCteBodyStart(masked) {
  const n = masked.length;
  let i = 0;
  while (i < n && /\s/.test(masked[i])) i++;

  const withMatch = /^WITH\b/i.exec(masked.slice(i));
  if (!withMatch) return 0;
  i += withMatch[0].length;

  const recMatch = /^\s+RECURSIVE\b/i.exec(masked.slice(i));
  if (recMatch) i += recMatch[0].length;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    while (i < n && /\s/.test(masked[i])) i++;

    const ident = matchLeadingIdentifier(masked.slice(i));
    if (!ident) return 0;
    i += ident.length;

    while (i < n && /\s/.test(masked[i])) i++;

    // 任意のカラムリスト: WITH cte (col1, col2) AS (...)
    if (masked[i] === '(') {
      const closeIdx = extractParenGroupEnd(masked, i);
      if (closeIdx === -1) return 0;
      i = closeIdx + 1;
      while (i < n && /\s/.test(masked[i])) i++;
    }

    const asMatch = /^AS\b/i.exec(masked.slice(i));
    if (!asMatch) return 0;
    i += asMatch[0].length;
    while (i < n && /\s/.test(masked[i])) i++;

    if (masked[i] !== '(') return 0;
    const bodyCloseIdx = extractParenGroupEnd(masked, i);
    if (bodyCloseIdx === -1) return 0;
    i = bodyCloseIdx + 1;

    while (i < n && /\s/.test(masked[i])) i++;

    if (masked[i] === ',') { i++; continue; }
    break;
  }

  return i;
}

// ---------------------------------------------------------------------------
// 文の種類判定
// ---------------------------------------------------------------------------

function getStatementKind(masked) {
  const bodyStart = findCteBodyStart(masked);
  const s = masked.slice(bodyStart).replace(/^\s+/, '');
  if (/^UPDATE\b/i.test(s)) return 'UPDATE';
  if (/^DELETE\b/i.test(s)) return 'DELETE';
  if (/^INSERT\b/i.test(s)) return 'INSERT';
  if (/^SELECT\b/i.test(s)) return 'SELECT';
  if (/^MERGE\b/i.test(s)) return 'MERGE';
  if (/^TRUNCATE\b/i.test(s)) return 'TRUNCATE_TABLE';
  if (/^DROP\s+TABLE\b/i.test(s)) return 'DROP_TABLE';
  if (/^DROP\s+DATABASE\b/i.test(s)) return 'DROP_DATABASE';
  if (/^DROP\b/i.test(s)) return 'DROP_OTHER';
  if (/^CREATE\b/i.test(s)) return 'CREATE';
  if (/^ALTER\b/i.test(s)) return 'ALTER';
  if (/^(BEGIN\s+TRAN(SACTION)?|START\s+TRANSACTION)\b/i.test(s)) return 'BEGIN_TX';
  if (/^BEGIN\b/i.test(s)) return 'BEGIN_TX';
  if (/^(COMMIT|ROLLBACK|END\s+TRAN(SACTION)?)\b/i.test(s)) return 'END_TX';
  return 'OTHER';
}

const DESTRUCTIVE_KINDS = new Set(['UPDATE', 'DELETE', 'TRUNCATE_TABLE', 'DROP_TABLE', 'DROP_DATABASE', 'DROP_OTHER']);
const DDL_KINDS = new Set(['CREATE', 'ALTER', 'TRUNCATE_TABLE', 'DROP_TABLE', 'DROP_DATABASE', 'DROP_OTHER']);
const DML_KINDS = new Set(['INSERT', 'UPDATE', 'DELETE']);

// ---------------------------------------------------------------------------
// WHERE 句の抽出
// ---------------------------------------------------------------------------

const WHERE_END_WORDS = ['ORDER', 'GROUP', 'HAVING', 'LIMIT', 'RETURNING', 'FETCH', 'WINDOW', 'UNION', 'EXCEPT', 'INTERSECT', 'OFFSET', 'FOR'];

/**
 * WHERE_END_WORDS は本来キーワードだが、`offset` や `order` のように
 * 予約語風のカラム名として使われることもある。その位置で構文的に
 * 妥当な場合だけ終端語として扱う。判定に確信が持てない場合は「終端語とは
 * 認めない＝WHERE句を長めに残す」方向に倒す（WHERE句を誤って短く切って
 * 検算SELECTの条件を黙って落とすのが最悪のため）。
 */
function isValidWhereEndMatch(word, str, afterIndex) {
  const after = str.slice(afterIndex);
  switch (word) {
    case 'ORDER':
    case 'GROUP':
      // ORDER BY / GROUP BY の形になっている場合のみ終端語として扱う
      return /^\s+BY\b/i.test(after);
    case 'LIMIT':
    case 'OFFSET':
      // 後ろに数値（プレースホルダ含む簡易チェック）が続く場合のみ
      return /^\s+\d/.test(after);
    case 'FETCH':
      // FETCH FIRST/NEXT ... ROWS ONLY の形になっている場合のみ
      return /^\s+(FIRST|NEXT)\b/i.test(after);
    default:
      // HAVING / RETURNING / WINDOW / UNION / EXCEPT / INTERSECT / FOR は
      // カラム名との衝突が現実的に稀なため、従来通り常に終端語として扱う
      return true;
  }
}

function topLevelSearchValidated(str, words, start, validator) {
  let depth = 0;
  const re = /[A-Za-z_][A-Za-z0-9_]*|\(|\)/g;
  re.lastIndex = start || 0;
  let m;
  while ((m = re.exec(str))) {
    const tok = m[0];
    if (tok === '(') { depth++; continue; }
    if (tok === ')') { depth--; continue; }
    if (depth === 0 && words.includes(tok.toUpperCase())) {
      const afterIdx = m.index + tok.length;
      if (!validator || validator(tok.toUpperCase(), str, afterIdx)) {
        return { index: m.index, length: tok.length, word: tok.toUpperCase() };
      }
      // 終端語として妥当でない（カラム名の可能性が高い）ので読み飛ばして続行
    }
  }
  return null;
}

function findWhereClause(masked, plain) {
  const w = topLevelSearch(masked, ['WHERE'], 0);
  if (!w) return null;
  const clauseStart = w.index + w.length;
  const e = topLevelSearchValidated(masked, WHERE_END_WORDS, clauseStart, isValidWhereEndMatch);
  const clauseEnd = e ? e.index : masked.length;
  return {
    maskedClause: masked.slice(clauseStart, clauseEnd),
    plainClause: plain.slice(clauseStart, clauseEnd),
  };
}

// ---------------------------------------------------------------------------
// 常に真の WHERE 句判定
// ---------------------------------------------------------------------------

function stripOuterParens(s) {
  let str = s.trim();
  // eslint-disable-next-line no-constant-condition
  while (str.startsWith('(') && str.endsWith(')')) {
    let depth = 0;
    let wrapsWhole = true;
    for (let i = 0; i < str.length; i++) {
      if (str[i] === '(') depth++;
      else if (str[i] === ')') {
        depth--;
        if (depth === 0 && i !== str.length - 1) { wrapsWhole = false; break; }
      }
    }
    if (!wrapsWhole) break;
    str = str.slice(1, -1).trim();
  }
  return str;
}

function isTautologyClause(rawClause) {
  const c = stripOuterParens(rawClause);
  const patterns = [
    /^(-?\d+(?:\.\d+)?)\s*=\s*(-?\d+(?:\.\d+)?)$/,
    /^'([^']*)'\s*=\s*'([^']*)'$/,
    /^"([^"]*)"\s*=\s*"([^"]*)"$/,
  ];
  for (const p of patterns) {
    const m = c.match(p);
    if (m && m[1] === m[2]) return true;
  }
  if (/^true$/i.test(c)) return true;
  if (/^1$/.test(c)) return true;
  return false;
}

/**
 * WHERE句をトップレベル（括弧の深さ0）の OR で分割する。
 * 例: "id = 42 OR 1=1" → ["id = 42", "1=1"]
 * 括弧の中にある OR（深さ>0）では分割しない。
 */
function splitTopLevelOr(str) {
  const segments = [];
  let depth = 0;
  let segStart = 0;
  const re = /[A-Za-z_][A-Za-z0-9_]*|\(|\)/g;
  let m;
  while ((m = re.exec(str))) {
    const tok = m[0];
    if (tok === '(') { depth++; continue; }
    if (tok === ')') { depth--; continue; }
    if (depth === 0 && tok.toUpperCase() === 'OR') {
      segments.push({ start: segStart, end: m.index });
      segStart = m.index + tok.length;
    }
  }
  segments.push({ start: segStart, end: str.length });
  return segments;
}

/**
 * `DELETE FROM users WHERE id = 42 OR 1=1;` のように、トップレベルの OR で
 * 分割した区間のどれか一つがそれ単独で常に真（トートロジー）であれば、
 * OR全体としてWHERE句が常に真になる（Xが何であれ `X OR true` は true）。
 * 括弧内にある OR 1=1（例: `a=1 AND (b=2 OR 1=1)`）はトップレベルの分割に
 * 現れないため、全行には波及せず誤検知しない。
 */
function hasTopLevelTautologyOr(maskedClause, plainClause) {
  const segments = splitTopLevelOr(maskedClause);
  if (segments.length < 2) return false;
  return segments.some((seg) => isTautologyClause(plainClause.slice(seg.start, seg.end)));
}

// ---------------------------------------------------------------------------
// OR / AND 混在で括弧なし
// ---------------------------------------------------------------------------

/**
 * BETWEEN x AND y の AND は演算子優先順位（OR/AND混在の警告)の対象外にする。
 * 括弧を含む場合は呼び出し元で既に判定を諦めているため、ここでは
 * 単純な「BETWEEN <トークン> AND」の形だけを対象にすれば十分。
 */
function maskBetweenAnd(maskedClause) {
  return maskedClause.replace(/\bBETWEEN\b\s+\S+\s+AND\b/gi, (m) => m.replace(/\bAND\b/i, '&&&'));
}

function hasUnparenthesizedOrAnd(maskedClause) {
  // 誤検知を避けるため、括弧が一つでも含まれる場合は判定を諦める
  if (/[()]/.test(maskedClause)) return false;
  const withoutBetweenAnd = maskBetweenAnd(maskedClause);
  const hasOr = /\bOR\b/i.test(withoutBetweenAnd);
  const hasAnd = /\bAND\b/i.test(withoutBetweenAnd);
  return hasOr && hasAnd;
}

// ---------------------------------------------------------------------------
// LIKE '%...' 前方一致でない
// ---------------------------------------------------------------------------

function hasLeadingWildcardLike(plainClause) {
  return /\bLIKE\s+'%/i.test(plainClause);
}

// ---------------------------------------------------------------------------
// 引用符付き数値リテラル（暗黙型変換の疑い）
// ---------------------------------------------------------------------------

function findQuotedNumericComparisons(plainClause) {
  const re = /([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)\s*(=|<>|!=|<=|>=|<|>)\s*'(-?\d+(?:\.\d+)?)'/g;
  const results = [];
  let m;
  while ((m = re.exec(plainClause))) {
    results.push({ column: m[1], op: m[2], value: m[3] });
  }
  return results;
}

// ---------------------------------------------------------------------------
// テーブル名（+ エイリアス）の抽出
// ---------------------------------------------------------------------------

// テーブル名の直後に現れてもエイリアスとは見なさない語（次の句の開始語）
const NON_ALIAS_KEYWORDS = new Set([
  'SET', 'WHERE', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'JOIN', 'ON',
  'USING', 'NATURAL', 'ORDER', 'GROUP', 'LIMIT', 'RETURNING', 'HAVING', 'FOR',
]);

/**
 * DELETE FROM <table> [[AS] alias] ... / UPDATE <table> [[AS] alias] ...
 * からテーブル名とエイリアス（あれば）を抽出する。
 * `DELETE FROM orders o WHERE o.id = 7;` のようにエイリアスを使っている文でも
 * 検算SELECTがそのままエイリアス込みで実行できるようにするため。
 */
function extractOuterTableWithAlias(kind, masked) {
  const bodyStart = findCteBodyStart(masked);
  const s = masked.slice(bodyStart).replace(/^\s+/, '');
  let rest = null;
  if (kind === 'DELETE') {
    const m = s.match(/^DELETE\s+FROM\s+/i);
    if (m) rest = s.slice(m[0].length);
  } else if (kind === 'UPDATE') {
    const m = s.match(/^UPDATE\s+/i);
    if (m) rest = s.slice(m[0].length);
  }
  if (rest == null) return null;
  rest = rest.replace(/^\s+/, '');
  const table = matchLeadingIdentifier(rest);
  if (!table) return null;

  const after = rest.slice(table.length);
  let alias = null;
  const asMatch = after.match(/^\s+AS\s+/i);
  if (asMatch) {
    const aliasIdent = matchLeadingIdentifier(after.slice(asMatch[0].length));
    if (aliasIdent) alias = aliasIdent;
  } else {
    const spaceMatch = after.match(/^\s+/);
    if (spaceMatch) {
      const identMatch = matchLeadingIdentifier(after.slice(spaceMatch[0].length));
      if (identMatch && !NON_ALIAS_KEYWORDS.has(identMatch.toUpperCase())) {
        alias = identMatch;
      }
    }
  }

  return { table, alias };
}

function extractOuterTable(kind, masked) {
  const info = extractOuterTableWithAlias(kind, masked);
  return info ? info.table : null;
}

// ---------------------------------------------------------------------------
// IN (SELECT ... FROM 同テーブル) で条件なし（相関ミスの定番）
// ---------------------------------------------------------------------------

function findUncorrelatedSelfSubquery(masked, outerTableRaw) {
  if (!outerTableRaw) return [];
  const outerNorm = normalizeIdent(outerTableRaw);
  const issues = [];
  const re = /\bIN\s*\(\s*SELECT\b/gi;
  let m;
  while ((m = re.exec(masked))) {
    const openIdx = masked.indexOf('(', m.index);
    if (openIdx === -1) break;
    const closeIdx = extractParenGroupEnd(masked, openIdx);
    if (closeIdx === -1) break;
    const sub = masked.slice(openIdx + 1, closeIdx);
    const fromHit = topLevelSearch(sub, ['FROM'], 0);
    if (fromHit) {
      const after = sub.slice(fromHit.index + fromHit.length).replace(/^\s+/, '');
      const subTableRaw = matchLeadingIdentifier(after);
      if (subTableRaw && normalizeIdent(subTableRaw) === outerNorm) {
        const whereHit = topLevelSearch(sub, ['WHERE'], 0);
        if (!whereHit) {
          issues.push({ table: outerTableRaw });
        }
      }
    }
    re.lastIndex = closeIdx + 1;
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 検算 SELECT の生成
// ---------------------------------------------------------------------------

function buildVerifySelect(kind, masked, whereInfo) {
  const info = extractOuterTableWithAlias(kind, masked);
  if (!info) return null;
  // エイリアスがある場合は検算SELECTにも含める。そうしないと
  // `DELETE FROM orders o WHERE o.id = 7;` のような文から
  // `SELECT COUNT(*) FROM orders WHERE o.id = 7;` という、
  // エイリアス未定義で実行できないSELECTが生成されてしまう。
  const tableExpr = info.alias ? `${info.table} ${info.alias}` : info.table;
  if (whereInfo) {
    const cond = whereInfo.plainClause.trim().replace(/\s+/g, ' ');
    if (cond.length > 0) {
      return `SELECT COUNT(*) FROM ${tableExpr} WHERE ${cond};`;
    }
  }
  return `SELECT COUNT(*) FROM ${tableExpr};`;
}

/**
 * AST が取れている場合の「行の供給元（FROM句相当）」のソース範囲を返す。
 *
 * 検算SELECTのために必要なのは「テーブル式のテキスト」そのもの（JOINやON句を
 * 含む）だが、ASTから元のSQLテキストを完全に復元すると引用符の付き方が変わって
 * 読みにくくなる。そこで「どこがテーブル式なのか」の判断だけASTに任せ、
 * 文字列自体は元のSQLから切り出す。
 *
 * これにより、正規表現版では壊れていた次のケースが正しく検算できるようになる:
 *   - `UPDATE t1 LEFT JOIN t2 ON ... SET ...`（MySQLのマルチテーブルUPDATE）
 *   - `UPDATE u SET ... FROM users u JOIN ... WHERE ...`（T-SQL）
 *   - `DELETE o FROM orders o JOIN ...`
 */
function findTableExprRange(kind, masked, hasFromClause) {
  const bodyStart = findCteBodyStart(masked);
  const lead = masked.slice(bodyStart);
  const leadOffset = bodyStart + (lead.length - lead.replace(/^\s+/, '').length);
  const s = masked.slice(leadOffset);

  let start = -1;
  if (hasFromClause) {
    const f = topLevelSearch(s, ['FROM'], 0);
    if (!f) return null;
    start = f.index + f.length;
  } else if (kind === 'UPDATE') {
    const m = s.match(/^UPDATE\s+/i);
    if (!m) return null;
    start = m[0].length;
  } else if (kind === 'DELETE') {
    const f = topLevelSearch(s, ['FROM'], 0);
    if (!f) return null;
    start = f.index + f.length;
  } else {
    return null;
  }

  const endWords = ['SET', 'WHERE'].concat(WHERE_END_WORDS);
  const e = topLevelSearchValidated(s, endWords, start, isValidWhereEndMatch);
  const end = e ? e.index : s.length;
  if (end <= start) return null;
  return { start: leadOffset + start, end: leadOffset + end };
}

function buildVerifySelectFromAst(kind, ast, masked, plain, whereInfo) {
  const A = globalThis.SQLMeganeSqlAst;
  if (!A || !ast) return null;
  const hasFromClause = Array.isArray(ast.from) && ast.from.length > 0;
  const range = findTableExprRange(kind, masked, hasFromClause);
  if (!range) return null;
  const tableExpr = plain.slice(range.start, range.end).trim().replace(/\s+/g, ' ');
  if (tableExpr.length === 0) return null;
  if (whereInfo) {
    const cond = whereInfo.plainClause.trim().replace(/\s+/g, ' ');
    if (cond.length > 0) return `SELECT COUNT(*) FROM ${tableExpr} WHERE ${cond};`;
  }
  return `SELECT COUNT(*) FROM ${tableExpr};`;
}

// ---------------------------------------------------------------------------
// finding ヘルパー
// ---------------------------------------------------------------------------

function mk(severity, code, title, message) {
  return { severity, code, title, message };
}

const SEVERITY_ORDER = { danger: 0, warning: 1, info: 2 };

// ---------------------------------------------------------------------------
// UPDATE文の構造判定（JOIN・複数テーブル・単純な等価条件かどうか）
// ---------------------------------------------------------------------------

/** UPDATE ... の "UPDATE" と "SET" の間（テーブル指定部分）を取り出す */
function getUpdateHeadClause(masked) {
  const bodyStart = findCteBodyStart(masked);
  const s = masked.slice(bodyStart).replace(/^\s+/, '');
  const m = s.match(/^UPDATE\s+/i);
  if (!m) return null;
  const setHit = topLevelSearch(s, ['SET'], m[0].length);
  const headEnd = setHit ? setHit.index : s.length;
  return s.slice(m[0].length, headEnd);
}

/** UPDATE ... JOIN ... SET （JOINで一致した行だけが更新される形）かどうか */
function updateHasJoin(masked) {
  const head = getUpdateHeadClause(masked);
  if (!head) return false;
  return /\bJOIN\b/i.test(head);
}

/** MySQLのマルチテーブルUPDATE（`UPDATE t1, t2 SET ...` / `UPDATE t1 JOIN t2 ... SET ...`）かどうか。
 *  MySQLではこの形のUPDATEにLIMITを付けられないため、mysql-no-limitの対象から除外する。 */
function isMysqlMultiTableUpdate(masked) {
  const head = getUpdateHeadClause(masked);
  if (!head) return false;
  if (/,/.test(head)) return true;
  return /\b(JOIN|INNER|LEFT|RIGHT|FULL|CROSS)\b/i.test(head);
}

/** WHERE句が「単一カラム = 単一値」のような単純な等価条件だけかどうか
 *  （主キー1行更新のような、対象件数の見積もりに自信が持てるケース）。
 *  括弧・AND・OR・他の演算子が絡む場合は対象外（false）とし、安全側に倒す。 */
function isSingleEqualityWhere(maskedClause) {
  const c = maskedClause.trim();
  if (/[()]/.test(c)) return false;
  if (/\b(AND|OR)\b/i.test(c)) return false;
  return /^[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?\s*=\s*(?:-?\d+(?:\.\d+)?|'[^']*'|"[^"]*"|`[^`]+`|\?|:[A-Za-z_]\w*)$/.test(c);
}

// ---------------------------------------------------------------------------
// 文単位の解析
// ---------------------------------------------------------------------------

// AST の文種別 ↔ 正規表現側の文種別の対応（両者が食い違う場合はASTルールを使わない）
const AST_TYPE_TO_KIND = { update: 'UPDATE', delete: 'DELETE' };

/**
 * 1文を解析する。
 *
 * 手順:
 *  1. 方言がAST対応（MySQL/PostgreSQL/SQL Server）かつパーサが読み込まれていれば
 *     パースを試みる。失敗したら（調査で判明している方言差を吸収するため）
 *     mysql方言のパーサでもう一度だけ試す。
 *  2. パース成功 → 日本語要約 + AST基盤ルール + AST基盤の検算SELECT。
 *  3. パース失敗・方言非対応 → 従来の正規表現ヒューリスティック。
 *     失敗の場合はエラー位置を parse.error に入れてUIで明示できるようにする。
 */
function analyzeStatement(rawStmt, dialect) {
  const { plain, masked } = scan(rawStmt, dialect);
  const kind = getStatementKind(masked);
  const whereInfo = findWhereClause(masked, plain);

  const Ast = globalThis.SQLMeganeSqlAst;
  const AstRules = globalThis.SQLMeganeAstRules;
  const Summarizer = globalThis.SQLMeganeSummarizer;

  const parse = { mode: 'regex-only', error: null, parserDialect: null, usedFallbackDialect: null };
  let ast = null;

  if (Ast && Ast.isAvailable(dialect)) {
    const result = Ast.parseStatement(rawStmt, dialect);
    if (result.ok) {
      ast = result.ast;
      parse.mode = 'ast';
      parse.parserDialect = result.parserDialect;
      parse.usedFallbackDialect = result.usedFallbackDialect;
    } else {
      parse.mode = 'fallback';
      parse.error = result.error;
    }
  }

  const summary = (ast && Summarizer) ? Summarizer.summarize(ast) : null;

  // AST基盤ルールを使うのは UPDATE / DELETE のうち、ASTの文種別が正規表現側の
  // 判定と一致するものだけ。食い違うときは安全側（従来ロジック）に倒す。
  // それ以外の文種別（TRUNCATE / DROP / トランザクション制御など）はASTを使っても
  // 判定内容が変わらないため、従来経路のまま要約だけを追加する。
  const astRulesUsable = !!(ast && AstRules && AST_TYPE_TO_KIND[ast.type] === kind);

  if (astRulesUsable) {
    const findings = AstRules.analyzeAst(ast, kind, dialect);
    let verifySelect = null;
    if (kind === 'UPDATE' || kind === 'DELETE') {
      verifySelect = buildVerifySelectFromAst(kind, ast, masked, plain, whereInfo)
        || buildVerifySelect(kind, masked, whereInfo);
    }
    findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    return { kind, findings, verifySelect, masked, plain, summary, parse, ast };
  }

  return analyzeStatementByRegex(rawStmt, dialect, { plain, masked, kind, whereInfo, summary, parse, ast });
}

/** 従来の正規表現ヒューリスティックによる解析（フォールバック経路） */
function analyzeStatementByRegex(rawStmt, dialect, ctx) {
  const { plain, masked, kind, whereInfo } = ctx;
  const findings = [];

  if (kind === 'UPDATE' && !whereInfo) {
    const joinUpdate = updateHasJoin(masked);
    findings.push(mk(
      'danger',
      'no-where-update',
      'WHERE句のないUPDATE',
      joinUpdate
        ? 'WHERE句が見つかりません。このままではJOINで一致した行がすべて更新されます（範囲を必ず確認してください）。想定通りであっても、WHERE句を明示するか、下記の検算SELECTで対象件数を確認してから実行することを強く推奨します。'
        : 'WHERE句が見つかりません。このままではテーブルの全行が更新されます。想定通りであっても、WHERE句を明示するか、下記の検算SELECTで対象件数を確認してから実行することを強く推奨します。'
    ));
  }
  if (kind === 'DELETE' && !whereInfo) {
    findings.push(mk(
      'danger',
      'no-where-delete',
      'WHERE句のないDELETE',
      'WHERE句が見つかりません。このままではテーブルの全行が削除されます。TRUNCATEとの違いも含め、本当に全件削除でよいか再確認してください。'
    ));
  }

  if ((kind === 'UPDATE' || kind === 'DELETE') && whereInfo) {
    if (isTautologyClause(whereInfo.plainClause) || hasTopLevelTautologyOr(whereInfo.maskedClause, whereInfo.plainClause)) {
      findings.push(mk(
        'danger',
        'always-true-where',
        '常に真になるWHERE句',
        'WHERE句が「1=1」や「\'a\'=\'a\'」のように常に真となる条件だけで構成されている、または他の条件とトップレベルのORでつながっています（「X OR 1=1」はXの内容にかかわらず常に真になります）。事実上WHERE句がないのと同じで、全行が対象になります。意図した絞り込み条件が抜けていないか確認してください。'
      ));
    }

    if (hasUnparenthesizedOrAnd(whereInfo.maskedClause)) {
      findings.push(mk(
        'warning',
        'or-no-parens',
        'OR条件に括弧がありません',
        '「a=1 OR b=2 AND c=3」のような条件は AND が OR より先に評価されるため、意図せず対象範囲が広がることがあります。括弧で優先順位を明示してください（例: a=1 OR (b=2 AND c=3)）。'
      ));
    }

    if (hasLeadingWildcardLike(whereInfo.plainClause)) {
      findings.push(mk(
        'warning',
        'like-leading-wildcard',
        '前方一致でないLIKE条件',
        "LIKE '%...' のように先頭が % で始まるパターンは、想定より広い範囲の行がヒットする可能性があります。更新・削除対象を特定する条件としては特に、検算SELECTで対象件数を確認してから実行してください。"
      ));
    }

    const quotedNumeric = findQuotedNumericComparisons(whereInfo.plainClause);
    if (quotedNumeric.length > 0) {
      const examples = quotedNumeric.slice(0, 3).map((q) => `${q.column} ${q.op} '${q.value}'`).join(' / ');
      findings.push(mk(
        'warning',
        'implicit-conversion',
        '引用符付き数値リテラルによる暗黙型変換の疑い',
        `数値に見える値が文字列リテラルとして比較されています（例: ${examples}）。方言によっては暗黙的な型変換が行われ、インデックスが使われなくなったり、意図しない一致・不一致が起きることがあります。列の型を確認し、数値型であれば引用符なしでの比較を検討してください。`
      ));
    }

    const outerTable = extractOuterTable(kind, masked);
    const subIssues = findUncorrelatedSelfSubquery(masked, outerTable);
    if (subIssues.length > 0) {
      findings.push(mk(
        'warning',
        'self-subquery-no-condition',
        'サブクエリに絞り込み条件がありません',
        'IN (SELECT ... FROM 同じテーブル) の形をしていますが、サブクエリ側に絞り込み条件（WHERE）が見当たりません。これは実質的に元のテーブルと同じ範囲を指しており、本来入れるはずだった相関条件が抜けている可能性があります。'
      ));
    }

    if (dialect === 'mysql' && !hasTopLevelWord(masked, 'LIMIT', 0)) {
      // 主キー1行更新のような単純な等価条件だけのWHEREでは、対象件数の見積もりに
      // 自信が持てるためオオカミ少年化を避けて出さない。また、MySQLのマルチテーブル
      // UPDATE（`UPDATE t1, t2 SET ...` / `UPDATE t1 JOIN t2 ... SET ...`）は
      // そもそもLIMITに対応していないため出さない。
      const singleEquality = isSingleEqualityWhere(whereInfo.maskedClause);
      const multiTableUpdate = kind === 'UPDATE' && isMysqlMultiTableUpdate(masked);
      if (!singleEquality && !multiTableUpdate) {
        findings.push(mk(
          'info',
          'mysql-no-limit',
          'LIMIT句がありません（MySQL）',
          'MySQLではUPDATE/DELETEにLIMITを付けることで、一度に変更される行数の上限を設定できます。対象件数の見積もりに自信がない場合は、検算SELECTで件数を確認するか、LIMITを付けて段階的に実行することを検討してください。'
        ));
      }
    }
  }

  if (kind === 'TRUNCATE_TABLE') {
    findings.push(mk(
      'danger',
      'truncate-table',
      'TRUNCATE TABLE',
      'TRUNCATE TABLEはテーブルの全データを即座に削除します。多くの環境でロールバックが困難、または不可能です（DDL扱いで自動コミットされる場合があります）。対象テーブル名と実行環境（本番かどうか）を必ず再確認してください。'
    ));
  }
  if (kind === 'DROP_TABLE') {
    findings.push(mk(
      'danger',
      'drop-table',
      'DROP TABLE',
      'DROP TABLEはテーブル定義とデータを完全に削除します。多くの場合バックアップからの復元以外に取り消す方法がありません。対象テーブル名と実行環境を必ず再確認してください。'
    ));
  }
  if (kind === 'DROP_DATABASE') {
    findings.push(mk(
      'danger',
      'drop-database',
      'DROP DATABASE',
      'DROP DATABASEはデータベース全体を削除します。影響範囲が最も大きい操作の一つです。本当に実行が必要か、対象環境が本番でないか、複数人での確認を強く推奨します。'
    ));
  }

  let verifySelect = null;
  if (kind === 'UPDATE' || kind === 'DELETE') {
    verifySelect = buildVerifySelect(kind, masked, whereInfo);
  }

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  return {
    kind,
    findings,
    verifySelect,
    masked,
    plain,
    summary: ctx.summary || null,
    parse: ctx.parse || { mode: 'regex-only', error: null, parserDialect: null, usedFallbackDialect: null },
    ast: ctx.ast || null,
  };
}

// ---------------------------------------------------------------------------
// 触るテーブルの収集（スクリプトモードの全体サマリで使う）
// ---------------------------------------------------------------------------

function extractDdlTarget(kind, masked) {
  if (kind !== 'TRUNCATE_TABLE' && kind !== 'DROP_TABLE') return null;
  const m = masked.match(/^\s*(?:TRUNCATE\s+TABLE|DROP\s+TABLE)\s+(?:IF\s+EXISTS\s+)?/i);
  if (!m) return null;
  return matchLeadingIdentifier(masked.slice(m[0].length));
}

function collectTables(result) {
  const names = [];
  const push = (n) => {
    if (!n) return;
    const norm = normalizeIdent(n);
    if (!norm) return;
    if (!names.some((x) => normalizeIdent(x) === norm)) names.push(n);
  };

  const A = globalThis.SQLMeganeSqlAst;
  if (result.ast && A) {
    for (const t of A.rowSourceTables(result.ast)) push(t.table);
    for (const t of A.writeTargets(result.ast)) push(t.table);
    if (Array.isArray(result.ast.name)) for (const t of result.ast.name) push(t && t.table);
    if (names.length > 0) return names;
  }

  push(extractOuterTable(result.kind, result.masked));
  push(extractDdlTarget(result.kind, result.masked));
  return names;
}

// スクリプトモード（全体サマリカードを出す）に切り替える文数のしきい値
const SCRIPT_MODE_MIN_STATEMENTS = 5;

function buildOverview(statements) {
  if (statements.length < SCRIPT_MODE_MIN_STATEMENTS) return null;

  const counts = {};
  const tables = [];
  const warnedStatements = [];
  const fallbackStatements = [];

  for (const s of statements) {
    counts[s.kind] = (counts[s.kind] || 0) + 1;
    for (const t of s.tables || []) {
      if (!tables.some((x) => normalizeIdent(x) === normalizeIdent(t))) tables.push(t);
    }
    if (s.findings.some((f) => f.severity === 'danger' || f.severity === 'warning')) {
      warnedStatements.push(s.number);
    }
    if (s.parse && s.parse.mode === 'fallback') fallbackStatements.push(s.number);
  }

  const destructive = statements.filter((s) => DESTRUCTIVE_KINDS.has(s.kind)).length;

  return {
    total: statements.length,
    counts,
    destructiveCount: destructive,
    tables,
    warnedStatements,
    fallbackStatements,
  };
}

// ---------------------------------------------------------------------------
// 全体解析（複数文 + トランザクション文脈 + 方言別ルール + 全体まとめ）
// ---------------------------------------------------------------------------

function analyzeSQL(fullText, dialect) {
  const d = dialect || 'generic';
  const text = fullText || '';
  const rawStatements = splitStatementsWithOffsets(text, d);
  const statements = [];
  let txOpen = false;
  let sawDmlInBatch = false;
  let destructiveCount = 0;
  let firstBeginTranIdx = -1;
  let firstDestructiveIdx = -1;

  rawStatements.forEach((entry, idx) => {
    const raw = entry.raw;
    const result = analyzeStatement(raw, d);
    const { kind, findings } = result;

    if (kind === 'BEGIN_TX') {
      txOpen = true;
      if (firstBeginTranIdx === -1) firstBeginTranIdx = idx;
    } else if (kind === 'END_TX') {
      txOpen = false;
    }

    if (DESTRUCTIVE_KINDS.has(kind)) {
      if (firstDestructiveIdx === -1) firstDestructiveIdx = idx;
      destructiveCount++;
      if (!txOpen) {
        findings.push(mk(
          'info',
          'no-transaction',
          'トランザクションに包まれていません',
          'この破壊的操作の前にBEGIN（トランザクション開始）が見当たりません。明示的にトランザクションを開始しておくと、結果を確認してからCOMMIT、想定外であればROLLBACKする運用がしやすくなります。'
        ));
      }
    }

    if (d === 'oracle' && DDL_KINDS.has(kind) && sawDmlInBatch) {
      findings.push(mk(
        'warning',
        'oracle-ddl-autocommit',
        'DDL文による暗黙コミットに注意（Oracle）',
        'この文より前にDML（INSERT/UPDATE/DELETE）が実行されていますが、OracleではこのあとのDDL文（CREATE/ALTER/DROP/TRUNCATE）の実行時に、それまでの変更が暗黙的にCOMMITされます。DML側に誤りがないか、DDLを実行する前に確認してください。'
      ));
    }
    if (DML_KINDS.has(kind)) sawDmlInBatch = true;

    if (d === 'postgres' && (kind === 'UPDATE' || kind === 'DELETE') && !hasTopLevelWord(result.masked, 'RETURNING', 0)) {
      findings.push(mk(
        'info',
        'postgres-returning-tip',
        'RETURNING句のヒント（PostgreSQL）',
        'PostgreSQLでは UPDATE/DELETE に RETURNING句 を付けると、実際に変更・削除された行を実行結果として確認できます（例: RETURNING *）。実行結果の検証に活用できます。'
      ));
    }

    findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

    // 構文エラーの位置は「その文の中での行番号」で返ってくるので、
    // 貼り付けたテキスト全体での行番号に変換してから表示する
    const parse = result.parse;
    if (parse && parse.error && parse.error.line != null) {
      parse.error.globalLine = lineNumberAt(text, entry.start) + (parse.error.line - 1);
    }

    statements.push({
      number: idx + 1,
      raw,
      kind,
      findings,
      verifySelect: result.verifySelect,
      summary: result.summary,
      parse,
      tables: collectTables(result),
    });
  });

  const globalFindings = [];
  if (destructiveCount >= 2) {
    globalFindings.push(mk(
      'info',
      'multiple-destructive',
      '複数の破壊的操作が含まれています',
      'この貼り付けには複数の破壊的操作（UPDATE/DELETE/TRUNCATE/DROPなど）が含まれています。1文ずつ内容と対象範囲を確認しながら、可能であれば1文ずつ実行することをおすすめします。'
    ));
  }
  if (d === 'mssql' && destructiveCount >= 2) {
    // BEGIN TRANが「どこかにある」だけでは不十分。破壊的文より前に開始されて
    // いなければ、実際には保護されていないため抑止しない。
    const hasBeginTranBeforeDestructive =
      firstBeginTranIdx !== -1 && (firstDestructiveIdx === -1 || firstBeginTranIdx < firstDestructiveIdx);
    if (!hasBeginTranBeforeDestructive) {
      globalFindings.push(mk(
        'warning',
        'mssql-multi-no-begintran',
        '複数の更新をBEGIN TRANで囲んでいません（SQL Server）',
        '複数のUPDATE/DELETEが含まれていますが、BEGIN TRANが見当たりません。BEGIN TRAN 〜 COMMIT/ROLLBACKで囲むと、途中でエラーや想定外の結果に気づいた際にROLLBACKで全体を取り消せます。'
      ));
    }
  }

  const Ast = globalThis.SQLMeganeSqlAst;
  const astSupported = !!(Ast && Ast.isAvailable(d));

  return {
    dialect: d,
    statements,
    globalFindings,
    overview: buildOverview(statements),
    // UIが「構文解析あり / 簡易チェック」バッジを出すための情報
    analysis: {
      astSupported,
      parserDialect: Ast ? Ast.parserDialectFor(d) : null,
      astStatements: statements.filter((s) => s.parse && s.parse.mode === 'ast').length,
      fallbackStatements: statements.filter((s) => s.parse && s.parse.mode === 'fallback').length,
    },
  };
}

// テスト等から直接呼べるように内部関数もエクスポートしておく
const _internal = {
  scan,
  topLevelSearch,
  findWhereClause,
  isTautologyClause,
  hasTopLevelTautologyOr,
  hasUnparenthesizedOrAnd,
  hasLeadingWildcardLike,
  findQuotedNumericComparisons,
  extractOuterTable,
  extractOuterTableWithAlias,
  findUncorrelatedSelfSubquery,
  getStatementKind,
  findCteBodyStart,
  buildVerifySelect,
  isSingleEqualityWhere,
  isMysqlMultiTableUpdate,
  updateHasJoin,
  splitStatementsWithOffsets,
  lineNumberAt,
  findTableExprRange,
  buildVerifySelectFromAst,
  collectTables,
  buildOverview,
  analyzeStatement,
  SCRIPT_MODE_MIN_STATEMENTS,
};

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------
//
// file:// プロトコルで index.html を直接開いた場合、ブラウザは ESM の
// import/export をCORS制限でブロックし、モジュールが一切読み込まれない
// （＝JSが全く実行されない）。このツールは「ページを開くだけで使える」ことが
// 製品要件であるため、ESMのexport文は使わず、通常の<script>として読み込んだ上で
// globalThisに公開する方式に統一している（詳細はREADME.md / docs/architecture.md
// を参照）。
//
// Node.js側（tests/run-tests.mjs）は `import '../js/analyzer.js'`
// のように副作用インポートしたうえで globalThis.SQLMeganeAnalyzer から
// 関数を取得する（この .js ファイル自体は export 文を持たないため、
// 通常の<script>としてもESMの副作用インポート対象としても同じコードで動く）。
globalThis.SQLMeganeAnalyzer = {
  analyzeSQL,
  splitStatements,
  splitStatementsWithOffsets,
  SEVERITY_ORDER,
  SCRIPT_MODE_MIN_STATEMENTS,
  _internal,
};

})();
