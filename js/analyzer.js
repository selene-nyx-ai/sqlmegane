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
// 解析不能文の沈黙素通り対策（P1）
// ---------------------------------------------------------------------------
//
// ASTパースにも正規表現にも引っかからず kind=OTHER・findings=[] のまま
// 「警告なし」に見えてしまう文（MERGE / EXEC / CALL など）を検出したら、
// 必ず1つは警告を出す。「レビューしたのに何も言わなかった」を防ぐのが目的。

// P2（プロダクトオーナー指摘）: 「構文解析はできないが簡易チェックは併走させた」
// 場合と「簡易チェックすら適用できなかった」場合で文言・カードの縁取りを変える。
// checkLevel:
//  - 'basic' : 構文解析（AST/日本語要約）はできなかったが、正規表現ベースの簡易
//              チェック（ON句有無・OR 1=1・LIKE前方一致・破壊的キーワード検出等）
//              は必ず実施した。カードは warning 系の縁取りに留める。
//  - 'none'  : 簡易チェックすら適用できなかった（例: PL/SQLブロックからDMLを
//              1本も抽出できず、動的SQL等で中身が全く見えない場合）。この場合
//              だけ、従来通りdanger系の縁取りで強く目立たせる。
const UNANALYZED_STATEMENT_TITLE_NONE = '⚠ この文は解析できませんでした（チェック未実施）';
const UNANALYZED_STATEMENT_MESSAGE_NONE = 'この文は解析できませんでした。チェックは行われていません。MERGE等の未対応構文が含まれます。目視での確認が必要です。';

const UNANALYZED_STATEMENT_TITLE_BASIC = '⚠ 構文解析はできませんでした（簡易チェックのみ実施）';
const UNANALYZED_STATEMENT_MESSAGE_BASIC = '構文解析はできませんでした（簡易チェックのみ実施）。構文解析による要約・詳細検査は行われていません。';

// 後方互換のためのエイリアス（従来コードやコメントが参照している名前）
const UNANALYZED_STATEMENT_TITLE = UNANALYZED_STATEMENT_TITLE_NONE;
const UNANALYZED_STATEMENT_MESSAGE = UNANALYZED_STATEMENT_MESSAGE_NONE;

/**
 * 「解析できなかった文」のfindingを組み立てる。checkLevelをfinding.metaに
 * 残しておき、UI（app.js）がカードの縁取り色を切り替えられるようにする。
 */
function mkUnanalyzed(checkLevel, extraMessage) {
  const title = checkLevel === 'basic' ? UNANALYZED_STATEMENT_TITLE_BASIC : UNANALYZED_STATEMENT_TITLE_NONE;
  const baseMessage = checkLevel === 'basic' ? UNANALYZED_STATEMENT_MESSAGE_BASIC : UNANALYZED_STATEMENT_MESSAGE_NONE;
  const message = extraMessage ? `${baseMessage} ${extraMessage}` : baseMessage;
  const finding = mk('warning', 'unanalyzed-statement', title, message);
  finding.meta = { checkLevel };
  return finding;
}

// kindがOTHERになる文のうち、破壊的な操作につながりうるキーワードを含む場合に
// 警告を出す対象にする（MERGEは専用kindで判定するためここでは主にEXEC系）。
const UNANALYZED_DESTRUCTIVE_KEYWORDS = ['MERGE', 'EXEC', 'EXECUTE', 'SP_EXECUTESQL', 'CALL'];

function hasUnanalyzedDestructiveKeyword(masked) {
  return topLevelSearch(masked, UNANALYZED_DESTRUCTIVE_KEYWORDS, 0) !== null;
}

/**
 * 文字列リテラル外の「1=1」「'a'='a'」のような常に真になる式を、WHERE句の
 * ような特定の構造を前提とせず文全体から広く拾う（機能A: OTHER文向け簡易チェック）。
 * masked は文字列リテラルの中身が x でマスクされているため、数値の「1=1」等は
 * masked 側で拾えば文字列リテラルの中身を誤検知しない。引用符付き文字列同士の
 * 比較（'a'='a'）は masked 側だと中身がすべて x になり値の異同が分からなくなる
 * ため、こちらは plain（コメントは空白化済み・文字列の中身はそのまま）を使う。
 */
function findGenericTautologies(masked, plain) {
  const hits = [];
  const numRe = /(-?\d+(?:\.\d+)?)\s*=\s*(-?\d+(?:\.\d+)?)/g;
  let m;
  while ((m = numRe.exec(masked))) {
    if (m[1] === m[2]) hits.push(`${m[1]}=${m[2]}`);
  }
  const strRe = /'([^']*)'\s*=\s*'([^']*)'/g;
  while ((m = strRe.exec(plain))) {
    if (m[1] === m[2]) hits.push(`'${m[1]}'='${m[2]}'`);
  }
  return hits;
}

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

/**
 * implicit-conversion のメッセージを組み立てる。P2: ノイズ疲れ対策として、
 * 同一文内に複数箇所あっても1つのfindingに集約する（例: `dept_cd = '10' など3箇所`）。
 * ゼロ埋めコードのような文字コード列への文字列比較は日本の業務DBでは正しい書き方
 * であることが多いため、その旨も明示して過剰な警戒を避ける。
 */
function buildImplicitConversionMessage(list) {
  const first = list[0];
  const example = `\`${first.column}\` ${first.op} '${first.value}'`;
  const label = list.length > 1 ? `${example} など${list.length}箇所` : example;
  return `数値に見える値が文字列リテラルとして比較されています（${label}）。方言によっては暗黙的な型変換が行われ、インデックスが使われなくなったり、意図しない一致・不一致が起きることがあります。文字コード列（ゼロ埋めコードなど）への文字列比較はそれ自体正しい書き方です。数値列との比較の場合のみ、列の型を確認してください。`;
}

// ---------------------------------------------------------------------------
// MERGE文の簡易チェック（機能A: チェックゼロの文の撲滅）
// ---------------------------------------------------------------------------
//
// MERGEはAST基盤の検出ルールを持たず、これまでは「解析できませんでした」警告を
// 出すだけで中身を一切見ていなかった（＝チェックゼロ）。ここでは構文解析はできな
// くても、正規表現ベースの簡易チェックだけは必ず併走させる:
//  - ON句（結合条件）の有無
//  - WHEN MATCHED THEN UPDATE の SET句 / WHERE句、WHEN NOT MATCHED THEN INSERT
//    のINSERT句 / WHERE句を切り出し、既存のWHERE句簡易検査（OR 1=1・LIKE前方
//    一致でない・括弧なしOR/AND混在・引用符付き数値リテラル）を適用
//  - WHEN MATCHED ... DELETE（Oracle式の埋め込みDELETE、T-SQL式の単独DELETE
//    アクションどちらも）を検出したらinfoで明示
//
// 完全なMERGE構文パーサではないため、崩れた/未対応の書き方は検出を諦める
// （誤検知を出すくらいなら検出を諦める、という既存方針を踏襲）。

/** WHERE句と同じ簡易検査（tautology / OR-AND混在 / LIKE前方一致 / 引用符付き数値）
 *  を任意の切り出したクローズ（maskedClause/plainClause）に適用する。
 *  MERGEのSET句・WHERE句・INSERT句など、通常のWHERE句以外の場所にも使い回す。 */
function buildClauseExpressionFindings(maskedClause, plainClause, contextLabel) {
  const out = [];
  const trimmedPlain = plainClause.trim();

  if ((trimmedPlain && isTautologyClause(trimmedPlain)) || hasTopLevelTautologyOr(maskedClause, plainClause)) {
    out.push(mk(
      'danger',
      'always-true-where',
      `常に真になる条件が含まれています（${contextLabel}）`,
      `${contextLabel}に、「1=1」や「'a'='a'」のように常に真となる条件が含まれている、または他の条件とトップレベルのORでつながっています。事実上絞り込みが効いていないのと同じです。意図した条件が抜けていないか確認してください。`
    ));
  }
  if (hasUnparenthesizedOrAnd(maskedClause)) {
    out.push(mk(
      'warning',
      'or-no-parens',
      `OR条件に括弧がありません（${contextLabel}）`,
      `${contextLabel}にある「a=1 OR b=2 AND c=3」のような条件は、ANDがORより先に評価されるため意図せず対象範囲が広がることがあります。括弧で優先順位を明示してください（例: a=1 OR (b=2 AND c=3)）。`
    ));
  }
  if (hasLeadingWildcardLike(plainClause)) {
    out.push(mk(
      'warning',
      'like-leading-wildcard',
      `前方一致でないLIKE条件です（${contextLabel}）`,
      `${contextLabel}に LIKE '%...' のように先頭が % で始まるパターンがあります。想定より広い範囲の行がヒットする可能性があるため、目視で確認してください。`
    ));
  }
  const quotedNumeric = findQuotedNumericComparisons(plainClause);
  if (quotedNumeric.length > 0) {
    out.push(mk(
      'info',
      'implicit-conversion',
      `引用符付き数値リテラルとの比較です（${contextLabel}）`,
      buildImplicitConversionMessage(quotedNumeric)
    ));
  }
  return out;
}

/**
 * MERGE文1本を対象にした簡易チェック。ON句の有無・各WHEN句のSET/WHERE/INSERT
 * 部分への式レベルチェック・埋め込みDELETEの検出をまとめて行う。
 */
function analyzeMergeStatement(masked, plain) {
  const findings = [];

  // ON句（結合条件）の有無。最初のWHENより前で、トップレベルのONを探す。
  const firstWhen = topLevelSearch(masked, ['WHEN'], 0);
  const onSearchEnd = firstWhen ? firstWhen.index : masked.length;
  const onHit = topLevelSearch(masked.slice(0, onSearchEnd), ['ON'], 0);
  if (!onHit) {
    findings.push(mk(
      'warning',
      'merge-missing-on',
      'MERGEの結合条件（ON句）が見当たりません',
      '結合条件が確認できません。MERGEのON句が省略されているか、簡易チェックで認識できない形になっている可能性があります。想定通りの行だけがMATCHED / NOT MATCHEDと判定されているか、目視で確認してください。'
    ));
  }

  // WHEN句をトップレベルで分割する（複数のWHEN MATCHED / WHEN NOT MATCHEDに対応）。
  const whenStarts = [];
  {
    let searchStart = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const hit = topLevelSearch(masked, ['WHEN'], searchStart);
      if (!hit) break;
      whenStarts.push(hit.index);
      searchStart = hit.index + hit.length;
    }
  }

  let hasDeleteAction = false;

  whenStarts.forEach((start, i) => {
    const end = i + 1 < whenStarts.length ? whenStarts[i + 1] : masked.length;
    const segMasked = masked.slice(start, end);
    const segPlain = plain.slice(start, end);

    const notMatched = /^WHEN\s+NOT\s+MATCHED\b/i.test(segMasked);
    const label = notMatched ? 'WHEN NOT MATCHED THEN INSERT' : 'WHEN MATCHED THEN UPDATE';

    const thenHit = topLevelSearch(segMasked, ['THEN'], 0);
    if (!thenHit) return; // THENが見当たらない崩れた構文は判定を諦める（安全側）

    const actionStart = thenHit.index + thenHit.length;
    const actionMasked = segMasked.slice(actionStart);
    const actionPlain = segPlain.slice(actionStart);

    const updateMatch = /^\s*UPDATE\b/i.exec(actionMasked);
    const deleteMatch = /^\s*DELETE\b/i.exec(actionMasked);
    const insertMatch = /^\s*INSERT\b/i.exec(actionMasked);

    if (updateMatch) {
      const setHit = topLevelSearch(actionMasked, ['SET'], updateMatch[0].length);
      if (setHit) {
        const setBodyStart = setHit.index + setHit.length;
        // Oracle形式の埋め込みDELETE: WHEN MATCHED THEN UPDATE SET ... [WHERE ...] DELETE WHERE ...
        const embeddedDeleteHit = topLevelSearch(actionMasked, ['DELETE'], setBodyStart);
        if (embeddedDeleteHit) hasDeleteAction = true;
        const actionEnd = embeddedDeleteHit ? embeddedDeleteHit.index : actionMasked.length;

        const whereHit = topLevelSearch(actionMasked, ['WHERE'], setBodyStart);
        const whereIdx = whereHit && whereHit.index < actionEnd ? whereHit.index : -1;
        const setEnd = whereIdx !== -1 ? whereIdx : actionEnd;

        findings.push(...buildClauseExpressionFindings(
          actionMasked.slice(setBodyStart, setEnd),
          actionPlain.slice(setBodyStart, setEnd),
          `MERGEの${label} SET句`
        ));

        if (whereIdx !== -1) {
          const whereBodyStart = whereIdx + whereHit.length;
          findings.push(...buildClauseExpressionFindings(
            actionMasked.slice(whereBodyStart, actionEnd),
            actionPlain.slice(whereBodyStart, actionEnd),
            `MERGEの${label} WHERE句`
          ));
        }
      }
    } else if (deleteMatch) {
      // T-SQL形式: WHEN MATCHED THEN DELETE（SETを伴わない単独のDELETEアクション）
      hasDeleteAction = true;
    } else if (insertMatch) {
      const insertBodyStart = insertMatch[0].length;
      // OracleはINSERT句の末尾に任意のWHEREを付けられる（WHEN NOT MATCHED THEN
      // INSERT (...) VALUES (...) WHERE ...）。あれば切り出して個別にチェックする。
      const whereHit = topLevelSearch(actionMasked, ['WHERE'], insertBodyStart);
      const insertEnd = whereHit ? whereHit.index : actionMasked.length;

      findings.push(...buildClauseExpressionFindings(
        actionMasked.slice(insertBodyStart, insertEnd),
        actionPlain.slice(insertBodyStart, insertEnd),
        `MERGEの${label} INSERT句`
      ));

      if (whereHit) {
        const whereBodyStart = whereHit.index + whereHit.length;
        findings.push(...buildClauseExpressionFindings(
          actionMasked.slice(whereBodyStart),
          actionPlain.slice(whereBodyStart),
          `MERGEの${label} WHERE句`
        ));
      }
    }
  });

  if (hasDeleteAction) {
    findings.push(mk(
      'info',
      'merge-has-delete',
      '削除句を含むMERGE',
      'このMERGEにはDELETEを伴う分岐が含まれています。UPDATEやINSERTだけでなく行の削除も発生します。削除対象の範囲が意図通りか、目視で確認してください。'
    ));
  }

  return findings;
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

// 検算SELECTがJOINを含む場合に付ける注記。
// 1:N のJOINでは COUNT(*) が「結合後の行数」になり、更新・削除対象の行数
// （例えば UPDATE の場合は users 側の行数）とは一致しないことがあるため、
// 検算SELECTを鵜呑みにして「対象件数」だと誤解しないよう明示する。
const VERIFY_SELECT_JOIN_NOTE = '※JOINを含むため結合行数です。1対多の結合では実際の更新行数より大きくなることがあります';

/** 検算SELECTの文字列にJOINが含まれるかどうか（テーブル式部分にJOINキーワードが
 *  現れるのは、ASTベースでJOIN込みのテーブル式をそのまま切り出したときだけ。
 *  正規表現フォールバック版の buildVerifySelect は単一テーブル名しか含めないため
 *  JOINキーワードは現れない）。 */
function verifySelectHasJoin(sql) {
  return !!sql && /\bJOIN\b/i.test(sql);
}

/**
 * 生成した検算SELECTを最終形にする。JOINを含む場合は、件数が「結合行数」であり
 * 更新・削除される行数そのものとは限らないことをSQLコメントとして明示する
 * （UI側の表示ラベル・注記カードは app.js 側で hasJoin フラグを見て別途出す）。
 */
function finalizeVerifySelect(sql) {
  if (!sql) return { sql: null, hasJoin: false };
  const hasJoin = verifySelectHasJoin(sql);
  if (!hasJoin) return { sql, hasJoin: false };
  return { sql: `-- ${VERIFY_SELECT_JOIN_NOTE}\n${sql}`, hasJoin: true };
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

/**
 * `UPDATE (SELECT ... [WHERE ...]) ... SET ...` 形式（Oracleの更新可能結合ビュー）
 * かどうかを判定する。"UPDATE (" の直後が SELECT の場合のみインラインビューと
 * 認識する（単純な `UPDATE (col1, col2) = (...)` のような他構文との誤認を避けるため）。
 *
 * hasOwnWhere は、そのインラインビュー自身が（外側のUPDATE文とは別に）自分の
 * WHERE句を持っているかどうか。Oracleの更新可能結合ビューでは、行の絞り込みは
 * 外側のUPDATEのWHERE句ではなく、このインラインビュー側のWHERE句で行われるのが
 * 典型的なパターンのため、外側にWHEREが無くてもこれだけで「全行対象」と決めつけると
 * 誤検知（false danger）になる。
 */
function detectInlineViewUpdate(masked) {
  const bodyStart = findCteBodyStart(masked);
  const s = masked.slice(bodyStart).replace(/^\s+/, '');
  const m = s.match(/^UPDATE\s*\(/i);
  if (!m) return { isInlineView: false, hasOwnWhere: false };
  const openIdx = m[0].length - 1;
  const closeIdx = extractParenGroupEnd(s, openIdx);
  if (closeIdx === -1) return { isInlineView: false, hasOwnWhere: false };
  const inner = s.slice(openIdx + 1, closeIdx);
  if (!/^\s*SELECT\b/i.test(inner)) return { isInlineView: false, hasOwnWhere: false };
  const hasOwnWhere = topLevelSearch(inner, ['WHERE'], 0) !== null;
  return { isInlineView: true, hasOwnWhere };
}

/** MySQLのマルチテーブルUPDATE（`UPDATE t1, t2 SET ...` / `UPDATE t1 JOIN t2 ... SET ...`）かどうか。
 *  MySQLではこの形のUPDATEにLIMITを付けられないため、mysql-no-limitの対象から除外する。 */
function isMysqlMultiTableUpdate(masked) {
  const head = getUpdateHeadClause(masked);
  if (!head) return false;
  if (/,/.test(head)) return true;
  return /\b(JOIN|INNER|LEFT|RIGHT|FULL|CROSS)\b/i.test(head);
}

/** MySQLのマルチテーブルDELETE（`DELETE a FROM a JOIN b ...` / `DELETE FROM a, b USING ...`）かどうか。
 *  MySQLではこの形のDELETEにもLIMITを付けられないため、mysql-no-limitの対象から除外する
 *  （UPDATEは isMysqlMultiTableUpdate で対応済みだったが、DELETEが漏れていたための追加）。 */
function isMysqlMultiTableDelete(masked) {
  const bodyStart = findCteBodyStart(masked);
  const s = masked.slice(bodyStart).replace(/^\s+/, '');
  const m = s.match(/^DELETE\s+/i);
  if (!m) return false;
  const rest = s.slice(m[0].length);

  const fromHit = topLevelSearch(rest, ['FROM'], 0);
  if (!fromHit) return false;

  // `DELETE a, b FROM ...` / `DELETE a FROM a JOIN b ...` のように FROM の前に
  // テーブル（別名）指定があれば、それだけでマルチテーブル DELETE と判断できる。
  const beforeFrom = rest.slice(0, fromHit.index).trim();
  if (beforeFrom.length > 0) return true;

  // `DELETE FROM a, b USING ...` / `DELETE FROM a JOIN b ... WHERE ...` のように
  // FROM の後ろ（WHERE 等の前まで）にカンマ区切りや JOIN/USING があるかを見る。
  const after = rest.slice(fromHit.index + fromHit.length);
  const endWords = ['WHERE'].concat(WHERE_END_WORDS);
  const e = topLevelSearchValidated(after, endWords, 0, isValidWhereEndMatch);
  const head = e ? after.slice(0, e.index) : after;
  if (/,/.test(head)) return true;
  return /\b(JOIN|INNER|LEFT|RIGHT|FULL|CROSS|USING)\b/i.test(head);
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
// PL/SQL ユニットの検出と埋め込みDMLの抽出（Oracle対応 Phase 1）
// ---------------------------------------------------------------------------
//
// 経緯:
//   `BEGIN ... END; / ` のようなPL/SQLブロックを通常のセミコロン分割にかけると、
//   ブロック内の `UPDATE ... WHERE ...;` が独立した1文として切り出されるのでは
//   なく、ブロック全体が「BEGIN」で始まる1文として getStatementKind() に渡り、
//   kind=BEGIN_TX（トランザクション開始）に誤判定されてしまう。その結果、
//   ブロック内のUPDATEのWHERE漏れ等が一切チェックされないまま無警告で素通り
//   する事故が起きた。v2 ではこれを「ブロック全体を1文として扱い、中身は解析
//   せず必ず警告を出す」ことで塞いだ。
//
//   しかし現場のOracleスクリプトはそのほとんどがPL/SQLパッケージ／プロシージャの
//   形をしており、「丸ごと解析対象外」では実質的に使えない、という指摘を受けた。
//   そこで Phase 1 として「中のDMLは抽出して個別にチェックする」に格上げする。
//
// 実装:
//   抽出そのものは js/plsql-extract.js（SQLMeganePlsqlExtract）が担当する。
//   ここではその結果を既存の1文解析（analyzeStatement）に流し込み、
//   PL/SQLユニット1件＝1つの文カード（中に抽出DMLのサブカード）として返す。
//
//   制御フロー（IF / LOOP / EXCEPTION / カーソル制御）は**解析しない**。
//   解析していないことは必ず finding（info）として明示する。
//
// ユニット認識のヒューリスティックは意図的に保守的にしてある。`/` 終端行が
// 無い限りユニットとは認識しないため、通常の `BEGIN TRAN ... COMMIT` のような
// T-SQLの複数文スクリプトを誤ってユニット扱いにすることは無い。

const PLSQL_CONTROL_FLOW_NOTE_TITLE = 'PL/SQLの制御フローは解析していません';
const PLSQL_CONTROL_FLOW_NOTE_MESSAGE =
  'PL/SQLの制御フロー（ループ・分岐・例外処理）は解析していません。抽出したDML単位の簡易チェックです。'
  + 'どのDMLが実際に何回実行されるか、例外時に何がロールバックされるかは判断していません。';

/**
 * PL/SQLユニット1件を解析する。
 * 中の埋め込みDMLを抽出し、それぞれを通常の1文解析にかけてサブ結果として返す。
 */
function analyzePlsqlUnit(unitText, dialect) {
  const P = globalThis.SQLMeganePlsqlExtract;
  const scanned = P ? P.maskPlsql(unitText) : scan(unitText, dialect);
  const { plain, masked } = scanned;

  if (!P) {
    // 抽出モジュールが読み込まれていない場合は、従来どおり「丸ごと解析対象外」。
    return {
      kind: 'PLSQL_UNIT',
      findings: [mkUnanalyzed('none', 'PL/SQLブロックの中身は解析していません。')],
      verifySelect: null,
      verifySelectHasJoin: false,
      masked, plain, summary: null, ast: null,
      parse: { mode: 'plsql-unit', error: null, parserDialect: null, usedFallbackDialect: null, primaryError: null },
      plsql: null,
    };
  }

  const info = P.extractPlsqlUnit(unitText);

  const items = info.items.map((item) => {
    const r = analyzeStatement(item.sql, dialect, {});
    const verifySelect = r.verifySelect;
    return {
      label: item.label,
      kind: item.kind,
      cursorName: item.cursorName || null,
      sql: item.sql,
      offset: item.offset,
      analyzedKind: r.kind,
      findings: r.findings,
      verifySelect,
      verifySelectHasJoin: !!r.verifySelectHasJoin,
      // 検算SELECTのWHERE句にPL/SQL変数・バインド変数が残っている場合は、
      // そのままでは実行できないことを利用者に明示する必要がある。
      verifySelectHasRuntimeVariable: P.hasRuntimeVariable(verifySelect),
      summary: r.summary,
      parse: r.parse,
      tables: collectTables(r),
    };
  });

  const findings = [];
  if (items.length === 0 && info.hasExecutableBody) {
    // 実行可能な本体があるのにDMLを1本も切り出せなかった場合だけ、従来どおりの
    // 「解析できませんでした」警告に倒す（沈黙素通りを防ぐのが目的）。
    findings.push(mkUnanalyzed('none', 'PL/SQLブロックからDMLを1本も抽出できませんでした（動的SQLなどの可能性があります）。中身を目視で確認してください。'));
  } else if (items.length === 0) {
    findings.push(mk('info', 'plsql-declaration-only',
      'DMLを含まない宣言部です',
      'このPL/SQLユニットは宣言（プロシージャ／ファンクションの仕様、型定義など）だけで構成されており、実行されるDMLは含まれていません。'));
  }
  findings.push(mk('info', 'plsql-control-flow',
    PLSQL_CONTROL_FLOW_NOTE_TITLE, PLSQL_CONTROL_FLOW_NOTE_MESSAGE));

  return {
    kind: 'PLSQL_UNIT',
    findings,
    verifySelect: null,
    verifySelectHasJoin: false,
    masked,
    plain,
    summary: null,
    ast: null,
    parse: { mode: 'plsql-unit', error: null, parserDialect: null, usedFallbackDialect: null, primaryError: null },
    plsql: {
      header: info.header,
      unitKind: info.unitKind,
      unitName: info.unitName,
      structure: P.buildStructureSummary(info),
      procedureCount: info.procedureCount,
      functionCount: info.functionCount,
      cursorCount: info.cursorCount,
      hasCommit: info.hasCommit,
      hasRollback: info.hasRollback,
      hasExecutableBody: info.hasExecutableBody,
      items,
    },
  };
}

/** PL/SQLユニットの中で検出された finding をすべて平らに集める（集計・表示用） */
function collectPlsqlFindings(stmt) {
  const out = [];
  if (!stmt.plsql) return out;
  for (const item of stmt.plsql.items) out.push(...item.findings);
  return out;
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
function analyzeStatement(rawStmt, dialect, opts) {
  const { plain, masked } = scan(rawStmt, dialect);

  if (opts && opts.isPlsqlUnit) {
    // PL/SQLユニット（パッケージ／プロシージャ／無名ブロック等）。
    // 中の埋め込みDMLを抽出して個別に解析する（詳細は analyzePlsqlUnit 参照）。
    return analyzePlsqlUnit(rawStmt, dialect);
  }

  const kind = getStatementKind(masked);
  const whereInfo = findWhereClause(masked, plain);

  const Ast = globalThis.SQLMeganeSqlAst;
  const AstRules = globalThis.SQLMeganeAstRules;
  const Summarizer = globalThis.SQLMeganeSummarizer;

  const parse = { mode: 'regex-only', error: null, parserDialect: null, usedFallbackDialect: null, primaryError: null };
  let ast = null;

  if (Ast && Ast.isAvailable(dialect)) {
    const result = Ast.parseStatement(rawStmt, dialect);
    if (result.ok) {
      ast = result.ast;
      parse.mode = 'ast';
      parse.parserDialect = result.parserDialect;
      parse.usedFallbackDialect = result.usedFallbackDialect;
      // 別方言（mysql）で再挑戦して成功した場合、選択方言では構文エラーだった
      // という事実を失わずに持ち帰る。UIはこれを「参考表示」ではなく警告として
      // 明示する（選択方言ではこのSQLは実行できない可能性があるため）。
      parse.primaryError = result.primaryError || null;
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
    let verifySelectRaw = null;
    if (kind === 'UPDATE' || kind === 'DELETE') {
      verifySelectRaw = buildVerifySelectFromAst(kind, ast, masked, plain, whereInfo)
        || buildVerifySelect(kind, masked, whereInfo);
    }
    const finalizedVerify = finalizeVerifySelect(verifySelectRaw);
    findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    return {
      kind,
      findings,
      verifySelect: finalizedVerify.sql,
      verifySelectHasJoin: finalizedVerify.hasJoin,
      masked,
      plain,
      summary,
      parse,
      ast,
    };
  }

  return analyzeStatementByRegex(rawStmt, dialect, { plain, masked, kind, whereInfo, summary, parse, ast });
}

/** 従来の正規表現ヒューリスティックによる解析（フォールバック経路） */
function analyzeStatementByRegex(rawStmt, dialect, ctx) {
  const { plain, masked, kind, whereInfo } = ctx;
  const findings = [];

  if (kind === 'UPDATE' && !whereInfo) {
    const inlineView = detectInlineViewUpdate(masked);
    if (inlineView.isInlineView && inlineView.hasOwnWhere) {
      // Oracleの更新可能結合ビュー（UPDATE (SELECT ... WHERE ...) SET ...）。
      // 外側にWHERE句は無いが、インラインビュー自身のWHERE句が行を絞り込んでいる
      // ため「全行が更新される」とは言い切れない。かといって、そのWHERE句の
      // 絞り込みが十分か（key-preservedかどうか等）を正規表現で正しく判定するのは
      // 難しいため、danger誤爆を出すよりは「対象外」であることを明示する。
      findings.push(mk(
        'warning',
        'unanalyzed-statement',
        '⚠ インラインビューを含むUPDATEは簡易チェックの対象外です',
        'UPDATE (SELECT ... ) 形式（Oracleの更新可能結合ビュー）のUPDATEです。行の絞り込みはインラインビュー側のWHERE句で行われているため、このツールのWHERE句有無による危険判定（全行更新の警告）は行っていません。更新対象の行が意図通りに絞り込まれているか、対象テーブルがkey-preservedであるかを含め、目視で確認してください。'
      ));
    } else {
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
      findings.push(mk(
        'info',
        'implicit-conversion',
        '引用符付き数値リテラルとの比較',
        buildImplicitConversionMessage(quotedNumeric)
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
      const multiTableDelete = kind === 'DELETE' && isMysqlMultiTableDelete(masked);
      if (!singleEquality && !multiTableUpdate && !multiTableDelete) {
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

  if (kind === 'MERGE') {
    // MERGEは専用の構文解析・検出ルールを持たない。何も言わずに通すと「レビュー
    // したのに何も指摘がなかった＝安全」と誤解されるのが最悪のため、findingsが
    // 空でも必ず警告を出す（P1: 解析不能文の沈黙素通り対策）。
    // 機能A: 構文解析はできなくても、ON句の有無やSET/WHERE/INSERT部分の式レベル
    // 簡易チェックは必ず併走させる（analyzeMergeStatement）。そのため checkLevel
    // は常に 'basic'（簡易チェックのみ実施）になる。
    findings.push(...analyzeMergeStatement(masked, plain));
    findings.push(mkUnanalyzed('basic', 'MERGE文の解析は未対応です。ON句や各WHEN句のSET/WHERE/INSERT部分には正規表現ベースの簡易チェックを適用しています。'));
  } else if (kind === 'OTHER') {
    // kindがOTHER（＝正規表現でも文種別を特定できなかった）文にも、必ず簡易
    // チェックだけは併走させる（機能A）。文字列リテラル外の「1=1」等の常に真に
    // なる式は、破壊的キーワードの有無に関わらず検出する。
    const tautologyHits = findGenericTautologies(masked, plain);
    if (tautologyHits.length > 0) {
      findings.push(mk(
        'warning',
        'always-true-where',
        '常に真になる式が含まれています',
        `文字列リテラル外に「${tautologyHits[0]}」のように常に真となる式が含まれています。条件式の一部として使われている場合、意図した絞り込みが抜けていないか確認してください。`
      ));
    }

    if (hasUnanalyzedDestructiveKeyword(masked)) {
      // 破壊的な操作を伴いうるキーワード（EXEC/CALL等のプロシージャ実行など）を
      // 含む場合は、上記の簡易チェックを実施した上でも構文解析はできていない旨を
      // 必ず警告する（P1: 解析不能文の沈黙素通り対策）。
      findings.push(mkUnanalyzed(
        'basic',
        'MERGE/EXEC/EXECUTE/SP_EXECUTESQL/CALL等の破壊的なキーワードを含む文です。構文解析はできないため、文字列リテラル外の「1=1」等の式レベル簡易チェックのみを行っています。'
      ));
    }
  }

  let verifySelectRaw = null;
  if (kind === 'UPDATE' || kind === 'DELETE') {
    verifySelectRaw = buildVerifySelect(kind, masked, whereInfo);
  }
  const finalizedVerify = finalizeVerifySelect(verifySelectRaw);

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  return {
    kind,
    findings,
    verifySelect: finalizedVerify.sql,
    verifySelectHasJoin: finalizedVerify.hasJoin,
    masked,
    plain,
    summary: ctx.summary || null,
    parse: ctx.parse || { mode: 'regex-only', error: null, parserDialect: null, usedFallbackDialect: null, primaryError: null },
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

  // PL/SQLユニットは、抽出した各DMLが触るテーブルをまとめて持ち上げる。
  // そうしないとスクリプト全体サマリの「触るテーブル」からPL/SQL内部の
  // テーブルだけが抜け落ちてしまう。
  if (result.plsql) {
    for (const item of result.plsql.items) {
      for (const t of item.tables || []) push(t);
    }
    return names;
  }

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
  const unanalyzedStatements = [];

  for (const s of statements) {
    counts[s.kind] = (counts[s.kind] || 0) + 1;
    for (const t of s.tables || []) {
      if (!tables.some((x) => normalizeIdent(x) === normalizeIdent(t))) tables.push(t);
    }
    // PL/SQLユニットは、自分自身のfindingsではなく中の抽出DMLに危険が出る。
    // 全体サマリの「警告のある文」から漏れないよう、サブDMLのfindingsも見る。
    const allFindings = s.findings.concat(collectPlsqlFindings(s));
    if (allFindings.some((f) => f.severity === 'danger' || f.severity === 'warning')) {
      warnedStatements.push(s.number);
    }
    if (s.parse && s.parse.mode === 'fallback') fallbackStatements.push(s.number);
    // 解析不能文（MERGE / PL/SQLブロック / インラインビューUPDATE / EXEC等）は
    // unanalyzed-statement findingが付く。スクリプト全体サマリで「未解析の文」件数
    // として一覧できるようにする（P1: 沈黙素通り対策の一部）。
    if (s.findings.some((f) => f.code === 'unanalyzed-statement')) {
      unanalyzedStatements.push(s.number);
    }
  }

  const destructive = statements.filter((s) => DESTRUCTIVE_KINDS.has(s.kind)).length;

  return {
    total: statements.length,
    counts,
    destructiveCount: destructive,
    tables,
    warnedStatements,
    fallbackStatements,
    unanalyzedStatements,
  };
}

// ---------------------------------------------------------------------------
// 全体解析（複数文 + トランザクション文脈 + 方言別ルール + 全体まとめ）
// ---------------------------------------------------------------------------

/**
 * splitStatementsWithOffsets() の前段として、入力テキストを `/` だけの行
 * （SQL*Plus のブロック終端）でチャンクに分け、チャンクごとに
 *  - PL/SQLユニット（パッケージ／プロシージャ／無名ブロック等）ならそのまま1文
 *  - そうでなければ従来どおりセミコロン分割
 * とする。
 *
 * パッケージ仕様部と本体が `/` で区切られて並んでいる、という実務で最も普通の
 * 形を扱えるようにするため、チャンクは複数回現れてよい（v2 は先頭の1ブロック
 * しか見ていなかった）。
 *
 * オフセットはすべて元テキスト基準に補正するので、行番号表示は従来通り機能する。
 */
function buildRawStatements(text, dialect) {
  const P = globalThis.SQLMeganePlsqlExtract;
  if (!P) {
    return splitStatementsWithOffsets(text, dialect).map((s) => ({ ...s, isPlsqlUnit: false }));
  }

  const out = [];
  for (const chunk of P.splitSlashChunks(text)) {
    if (P.isPlsqlUnitChunk(chunk.text, chunk.terminatedBySlash)) {
      const lead = chunk.text.length - chunk.text.replace(/^\s+/, '').length;
      out.push({ raw: chunk.text.trim(), start: chunk.start + lead, isPlsqlUnit: true });
      continue;
    }
    for (const s of splitStatementsWithOffsets(chunk.text, dialect)) {
      out.push({ raw: s.raw, start: s.start + chunk.start, isPlsqlUnit: false });
    }
  }
  return out;
}

function analyzeSQL(fullText, dialect) {
  const d = dialect || 'generic';
  const text = fullText || '';
  const rawStatements = buildRawStatements(text, d);
  const isSingleStatementPaste = rawStatements.length === 1;
  const statements = [];
  let txOpen = false;
  let sawDmlInBatch = false;
  let destructiveCount = 0;
  let firstBeginTranIdx = -1;
  let firstDestructiveIdx = -1;
  const noTransactionStatementNumbers = [];

  rawStatements.forEach((entry, idx) => {
    const raw = entry.raw;
    const result = analyzeStatement(raw, d, { isPlsqlUnit: entry.isPlsqlUnit });
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
        if (isSingleStatementPaste) {
          // 単文貼り付け時は従来通り、その文自身にfindingを付ける。
          findings.push(mk(
            'info',
            'no-transaction',
            'トランザクションに包まれていません',
            'この破壊的操作の前にBEGIN（トランザクション開始）が見当たりません。明示的にトランザクションを開始しておくと、結果を確認してからCOMMIT、想定外であればROLLBACKする運用がしやすくなります。'
          ));
        } else {
          // 複数文貼り付け時は文ごとに繰り返し出さず、バッチ全体で1回（globalFindings）
          // に集約する（P2: ノイズ疲れ対策）。対象文の番号だけ集めておき、
          // ループの後でまとめて1件のfindingにする。
          noTransactionStatementNumbers.push(idx + 1);
        }
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

    // usedFallbackDialect が付いている（＝選択方言では構文エラーで、別方言=mysqlの
    // パーサで再挑戦して通った）場合は出さない。選択方言（PostgreSQL）ではそもそも
    // このSQLは構文的に成立していないため、PostgreSQL固有のTipsを添えるのは
    // 誤解を招く（「この形で実行できる」と誤解される）ため。
    const usedFallbackDialect = !!(result.parse && result.parse.usedFallbackDialect);
    if (d === 'postgres' && (kind === 'UPDATE' || kind === 'DELETE') && !usedFallbackDialect
        && !hasTopLevelWord(result.masked, 'RETURNING', 0)) {
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
    // 別方言（mysql）で再挑戦して成功したときの「選択方言では構文エラーだった」
    // 位置も同様に全体テキストでの行番号へ変換する（UIの警告表示用）。
    if (parse && parse.primaryError && parse.primaryError.line != null) {
      parse.primaryError.globalLine = lineNumberAt(text, entry.start) + (parse.primaryError.line - 1);
    }

    statements.push({
      number: idx + 1,
      raw,
      kind,
      findings,
      verifySelect: result.verifySelect,
      verifySelectHasJoin: !!result.verifySelectHasJoin,
      summary: result.summary,
      parse,
      plsql: result.plsql || null,
      tables: collectTables(result),
    });
  });

  const globalFindings = [];
  if (noTransactionStatementNumbers.length > 0) {
    const nums = noTransactionStatementNumbers.map((n) => `#${n}`).join(', ');
    globalFindings.push(mk(
      'info',
      'no-transaction',
      'トランザクションに包まれていない破壊的操作があります',
      `明示的なBEGIN（トランザクション開始）に包まれていない破壊的操作（UPDATE/DELETE/TRUNCATE/DROPなど）が${noTransactionStatementNumbers.length}件あります（${nums}）。結果を確認してからCOMMIT、想定外であればROLLBACKできるよう、明示的にトランザクションを開始しておくことを検討してください。`
    ));
  }
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
  isMysqlMultiTableDelete,
  updateHasJoin,
  splitStatementsWithOffsets,
  lineNumberAt,
  findTableExprRange,
  buildVerifySelectFromAst,
  collectTables,
  buildOverview,
  analyzeStatement,
  analyzePlsqlUnit,
  buildRawStatements,
  SCRIPT_MODE_MIN_STATEMENTS,
  findGenericTautologies,
  analyzeMergeStatement,
  buildClauseExpressionFindings,
  mkUnanalyzed,
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
  collectPlsqlFindings,
  SEVERITY_ORDER,
  SCRIPT_MODE_MIN_STATEMENTS,
  _internal,
};

})();
