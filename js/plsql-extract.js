/**
 * SQLMegane（SQLめがね） plsql-extract.js
 *
 * PL/SQL の「構造認識」と「埋め込みDMLの抽出」を担当するモジュール。
 *
 * 背景:
 *   Oracle は業務システムで最も広く使われている一方で、ブラウザに同梱できる
 *   PL/SQL の完全なパーサは（少なくとも実用的な形では）存在しない。
 *   そのため v2 までは `BEGIN 〜 END; /` や `CREATE OR REPLACE PACKAGE ...` を
 *   丸ごと「解析対象外」として警告するだけだった。しかし現場のOracleスクリプトは
 *   そのほとんどが PL/SQL パッケージ／プロシージャの形をしており、「業務でよく
 *   使われるOracleが構文解析できない」＝実質的に使えない、という指摘を受けた。
 *
 * このモジュールの方針:
 *   - PL/SQL を「完全にパースする」ことは狙わない（できないため）。
 *   - 代わりに、文字列リテラル・コメント・q'記法を正しくスキップしながら
 *     トークンを走査し、**文の開始位置に現れる DML だけを切り出す**。
 *   - 切り出したDMLは、既存の analyzer.js の1文解析にそのまま流し込む。
 *     これにより「WHERE句のないUPDATE」等の既存チェックがPL/SQL内部にも効く。
 *   - 制御フロー（IF / LOOP / EXCEPTION / カーソル制御）は**解析しない**。
 *     解析していないことはUIで明示する（黙って安全に見せないため）。
 *
 * file:// 直開き対応のため ESM の export は使わず、末尾で
 * globalThis.SQLMeganePlsqlExtract に公開する（analyzer.js と同じ方式）。
 */
(function () {

// ---------------------------------------------------------------------------
// マスキング: 文字列リテラル / コメント / q'記法 を無害化する
// ---------------------------------------------------------------------------

// q'記法（Oracleの代替引用符）で「開き文字 → 閉じ文字」が変わるペア。
// それ以外の文字（例: q'!...!'）は開き＝閉じ。
const Q_QUOTE_PAIRS = { '[': ']', '{': '}', '(': ')', '<': '>' };

function isIdentChar(ch) {
  return ch !== undefined && /[A-Za-z0-9_$#]/.test(ch);
}

/**
 * PL/SQL テキストを「元のまま (plain)」「構造解析用 (masked)」の同じ長さの
 * 2本に分解する。
 *
 *  - `'...'`（`''` エスケープ対応）: 中身を x でマスク。クォート自体は残す。
 *  - `q'[...]'` / `q'!...!'` 等の代替引用符: **全体を** x でマスクする。
 *    中に `'` や `;` が入っていても構造解析が壊れないようにするため。
 *  - `--` 行コメント / `/* *​/` ブロックコメント: 空白に置き換える。
 *    （コメント内の BEGIN / END; / セミコロンを構造として拾わないため）
 *  - `"..."` 引用符付き識別子: テーブル名・列名なのでマスクせず残す。
 *
 * 改行はどちらの側でも改行のまま残すので、オフセット→行番号の変換は
 * masked / plain / 元テキストのどれでも同じ結果になる。
 */
function maskPlsql(text) {
  let plain = '';
  let masked = '';
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];
    const c2 = i + 1 < n ? text[i + 1] : '';

    // q'...'（代替引用符）
    if ((c === 'q' || c === 'Q') && c2 === "'" && !isIdentChar(text[i - 1])) {
      const open = i + 2 < n ? text[i + 2] : '';
      if (open !== '') {
        const close = Q_QUOTE_PAIRS[open] || open;
        let j = i + 3;
        let end = n; // 閉じられていない場合はテキスト末尾まで
        while (j < n) {
          if (text[j] === close && text[j + 1] === "'") { end = j + 2; break; }
          j++;
        }
        for (let k = i; k < end; k++) {
          const ch = text[k];
          plain += ch;
          masked += (ch === '\n' ? '\n' : 'x');
        }
        i = end;
        continue;
      }
    }

    // 通常の文字列リテラル
    if (c === "'") {
      plain += c; masked += c;
      i++;
      while (i < n) {
        const ch = text[i];
        if (ch === "'" && text[i + 1] === "'") { plain += "''"; masked += 'xx'; i += 2; continue; }
        if (ch === "'") { plain += ch; masked += ch; i++; break; }
        plain += ch; masked += (ch === '\n' ? '\n' : 'x');
        i++;
      }
      continue;
    }

    // 引用符付き識別子（中身はマスクしない）
    if (c === '"') {
      plain += c; masked += c;
      i++;
      while (i < n) {
        const ch = text[i];
        plain += ch; masked += ch;
        i++;
        if (ch === '"') break;
      }
      continue;
    }

    // 行コメント
    if (c === '-' && c2 === '-') {
      while (i < n && text[i] !== '\n') {
        plain += ' '; masked += ' ';
        i++;
      }
      continue;
    }

    // ブロックコメント
    if (c === '/' && c2 === '*') {
      plain += '  '; masked += '  ';
      i += 2;
      while (i < n) {
        if (text[i] === '*' && text[i + 1] === '/') { plain += '  '; masked += '  '; i += 2; break; }
        const ch = text[i];
        plain += (ch === '\n' ? '\n' : ' ');
        masked += (ch === '\n' ? '\n' : ' ');
        i++;
      }
      continue;
    }

    plain += c; masked += c;
    i++;
  }

  return { plain, masked };
}

// ---------------------------------------------------------------------------
// `/` 行によるチャンク分割（SQL*Plus のブロック終端）
// ---------------------------------------------------------------------------

// 行頭（前後の空白のみ許容）が "/" だけの行。
const SLASH_LINE_RE = /^[ \t]*\/[ \t]*\r?(?:\n|$)/gm;

/**
 * テキストを `/` だけの行で区切って複数チャンクに分ける。
 * `/` の検出は masked（文字列・コメントを無害化したもの）に対して行うので、
 * 文字列リテラルやコメント内の `/` 行では分割されない。
 *
 * 返り値の各要素: { text, start, terminatedBySlash }
 *  - text: 元テキストの該当範囲（`/` 行そのものは含まない）
 *  - start: 元テキスト内での開始オフセット
 *  - terminatedBySlash: そのチャンクが `/` 行で閉じられていたか
 */
function splitSlashChunks(text) {
  const { masked } = maskPlsql(text);
  const chunks = [];
  let pos = 0;
  SLASH_LINE_RE.lastIndex = 0;
  let m;
  while ((m = SLASH_LINE_RE.exec(masked))) {
    chunks.push({ text: text.slice(pos, m.index), start: pos, terminatedBySlash: true });
    pos = m.index + m[0].length;
    SLASH_LINE_RE.lastIndex = pos;
  }
  if (pos < text.length) {
    chunks.push({ text: text.slice(pos), start: pos, terminatedBySlash: false });
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// PL/SQL ユニットの認識
// ---------------------------------------------------------------------------

const UNIT_START_RE = new RegExp(
  '^\\s*(?:'
  + 'CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:(?:NON)?EDITIONABLE\\s+)?'
  + '(?:PACKAGE\\s+BODY|PACKAGE|PROCEDURE|FUNCTION|TRIGGER|TYPE\\s+BODY|TYPE)\\b'
  + '|DECLARE\\b|BEGIN\\b'
  + ')', 'i');

// ヘッダから「種別」と「名前」を取り出す
const UNIT_HEADER_RE = new RegExp(
  '^\\s*CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:(?:NON)?EDITIONABLE\\s+)?'
  + '(PACKAGE\\s+BODY|PACKAGE|PROCEDURE|FUNCTION|TRIGGER|TYPE\\s+BODY|TYPE)'
  + '\\s+("[^"]+"|[A-Za-z_][A-Za-z0-9_$#]*(?:\\.(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$#]*))?)', 'i');

// `END pkg_name;` / `END;` の形。「実行可能な本体を持つ塊」であることの根拠にする。
const UNIT_END_RE = /\bEND\b[^;\n]*;/i;

/**
 * チャンクが PL/SQL ユニットかどうかを判定する。
 *
 * 判定は意図的に保守的にしてある。`/` 行で閉じられていることを必須にするのは、
 * 通常の T-SQL スクリプト（`BEGIN TRAN ... COMMIT`）を誤って PL/SQL ユニットと
 * 見なさないため。誤ってユニット扱いにするより、従来通りセミコロン分割される
 * 方がまし、という判断（v2 の detectPlsqlBlockRange から引き継いだ方針）。
 */
function isPlsqlUnitChunk(chunkText, terminatedBySlash) {
  if (!terminatedBySlash) return false;
  // 先頭にコメント（`-- 1. パッケージ仕様部` など）が付いているのが普通なので、
  // 判定は必ずマスク済みテキスト（コメントが空白化されたもの）に対して行う。
  const { masked } = maskPlsql(chunkText);
  if (!UNIT_START_RE.test(masked)) return false;
  return UNIT_END_RE.test(masked);
}

function parseUnitHeader(maskedUnit) {
  const m = maskedUnit.match(UNIT_HEADER_RE);
  if (m) {
    return {
      unitKind: m[1].toUpperCase().replace(/\s+/g, ' '),
      unitName: m[2],
      headerEnd: m.index + m[0].length,
    };
  }
  if (/^\s*DECLARE\b/i.test(maskedUnit)) {
    return { unitKind: '無名ブロック（DECLARE）', unitName: null, headerEnd: 0 };
  }
  return { unitKind: '無名ブロック（BEGIN）', unitName: null, headerEnd: 0 };
}

// ---------------------------------------------------------------------------
// トークン走査
// ---------------------------------------------------------------------------

const TOKEN_RE = /[A-Za-z_][A-Za-z0-9_$#]*|'[^']*'|[();]|\S/g;

function tokenize(masked) {
  const tokens = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(masked))) {
    tokens.push({ text: m[0], upper: m[0].toUpperCase(), index: m.index });
  }
  return tokens;
}

// 直後に「文が始まりうる」キーワード。ここを通過したら「次にDMLが来たら
// それは文の先頭である」と見なす（＝抽出対象にする）。
//
// FORALL / EXECUTE のように、キーワードとDMLの間に語が挟まる構文があるため、
// atStmtStart は「次のセミコロンまで有効なフラグ」として扱う（途中の語では
// 落とさない）。これがないと FORALL i IN 1..n SAVE EXCEPTIONS UPDATE ... を
// 取りこぼす。
const STMT_START_KEYWORDS = new Set([
  'BEGIN', 'THEN', 'ELSE', 'LOOP', 'DECLARE', 'IS', 'AS', 'EXCEPTION',
]);

const DML_KEYWORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'SELECT']);

/** 文の終端（深さ0のセミコロン）を探す。見つからなければテキスト末尾。 */
function findStatementEnd(masked, from) {
  let depth = 0;
  for (let i = from; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(') depth++;
    else if (c === ')') { if (depth > 0) depth--; }
    else if (c === ';' && depth === 0) return i;
  }
  return masked.length;
}

function matchingParen(masked, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < masked.length; i++) {
    if (masked[i] === '(') depth++;
    else if (masked[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** 深さ0に INTO があるか（SELECT ... INTO の判定用） */
function hasTopLevelInto(maskedStmt) {
  let depth = 0;
  const re = /[A-Za-z_][A-Za-z0-9_$#]*|\(|\)/g;
  let m;
  while ((m = re.exec(maskedStmt))) {
    if (m[0] === '(') { depth++; continue; }
    if (m[0] === ')') { depth--; continue; }
    if (depth === 0 && m[0].toUpperCase() === 'INTO') return true;
  }
  return false;
}

/**
 * DMLキーワードがその位置で「本当に文の開始」かどうかの追加ガード。
 * 誤検知（式の一部を文として切り出す）を避けるための保守的なチェック。
 */
function looksLikeStatementStart(keyword, prevUpper, nextUpper) {
  switch (keyword) {
    case 'INSERT':
      return nextUpper === 'INTO';
    case 'MERGE':
      return nextUpper === 'INTO';
    case 'DELETE':
      // DELETE FROM t / DELETE t（Oracleでは FROM 省略可）。
      // `ON DELETE CASCADE` のような制約句を拾わないよう prev を見る。
      return prevUpper !== 'ON';
    case 'UPDATE':
      // `SELECT ... FOR UPDATE` の UPDATE を文として切り出さない。
      return prevUpper !== 'FOR';
    case 'SELECT':
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// 抽出本体
// ---------------------------------------------------------------------------

/**
 * PL/SQL ユニットのテキストから、構造情報と埋め込みDMLを抽出する。
 *
 * 返り値:
 *   {
 *     unitKind, unitName, header,
 *     procedureCount, functionCount, cursorCount,
 *     hasCommit, hasRollback, hasExecutableBody,
 *     items: [{ label, kind, sql, offset, cursorName }]
 *   }
 *
 * items[].offset はユニットテキスト内でのオフセット（呼び出し側で
 * ユニットの開始オフセットを足せば、貼り付けテキスト全体での位置になる）。
 */
function extractPlsqlUnit(unitText) {
  const { plain, masked } = maskPlsql(unitText);
  const header = parseUnitHeader(masked);
  const tokens = tokenize(masked);

  let depth = 0;
  let atStmtStart = true;
  let procedureCount = 0;
  let functionCount = 0;
  let cursorCount = 0;
  let hasCommit = false;
  let hasRollback = false;
  let hasExecutableBody = false;
  let pendingCursorName = null;
  const items = [];

  for (let ti = 0; ti < tokens.length; ti++) {
    const t = tokens[ti];

    if (t.text === '(') {
      // FOR r IN (SELECT ...) LOOP —— カーソルFORループのSELECTも拾う
      if (depth === 0) {
        const p1 = ti >= 1 ? tokens[ti - 1].upper : '';
        const p3 = ti >= 3 ? tokens[ti - 3].upper : '';
        const closeIdx = matchingParen(masked, t.index);
        if (p1 === 'IN' && p3 === 'FOR' && closeIdx !== -1
            && /^\s*SELECT\b/i.test(masked.slice(t.index + 1, closeIdx))) {
          cursorCount++;
          items.push({
            label: 'カーソル定義（FORループ）',
            kind: 'CURSOR',
            cursorName: ti >= 2 ? tokens[ti - 2].text : null,
            sql: plain.slice(t.index + 1, closeIdx).trim(),
            offset: t.index + 1,
          });
        }
      }
      depth++;
      continue;
    }
    if (t.text === ')') { if (depth > 0) depth--; continue; }
    if (t.text === ';') { if (depth === 0) atStmtStart = true; continue; }
    if (depth > 0) continue;

    const u = t.upper;

    if (u === 'BEGIN') {
      hasExecutableBody = true;
      atStmtStart = true;
      pendingCursorName = null;
      continue;
    }
    if (STMT_START_KEYWORDS.has(u)) { atStmtStart = true; continue; }
    if (u === 'COMMIT') { hasCommit = true; continue; }
    if (u === 'ROLLBACK') { hasRollback = true; continue; }

    // ヘッダ部（CREATE OR REPLACE PROCEDURE foo ...）の PROCEDURE/FUNCTION は
    // ユニット自身の宣言なので、内部の副プログラム数としては数えない。
    if (t.index >= header.headerEnd) {
      if (u === 'PROCEDURE') { procedureCount++; continue; }
      if (u === 'FUNCTION') { functionCount++; continue; }
    }

    if (u === 'CURSOR') {
      cursorCount++;
      pendingCursorName = (ti + 1 < tokens.length) ? tokens[ti + 1].text : null;
      continue;
    }

    if (!atStmtStart || !DML_KEYWORDS.has(u)) continue;

    const prevUpper = ti >= 1 ? tokens[ti - 1].upper : '';
    const nextUpper = ti + 1 < tokens.length ? tokens[ti + 1].upper : '';
    if (!looksLikeStatementStart(u, prevUpper, nextUpper)) continue;

    const end = findStatementEnd(masked, t.index);
    const sql = plain.slice(t.index, end).trim();
    if (sql.length === 0) continue;

    let label = u;
    let kind = u;
    let cursorName = null;
    if (u === 'SELECT' && pendingCursorName) {
      label = 'カーソル定義';
      kind = 'CURSOR';
      cursorName = pendingCursorName;
      pendingCursorName = null;
    } else if (u === 'SELECT' && hasTopLevelInto(masked.slice(t.index, end))) {
      label = 'SELECT INTO';
      kind = 'SELECT';
    }

    items.push({ label, kind, cursorName, sql, offset: t.index });

    // 抽出した文の終端まで読み飛ばす
    while (ti + 1 < tokens.length && tokens[ti + 1].index < end) ti++;
    atStmtStart = true;
  }

  return {
    unitKind: header.unitKind,
    unitName: header.unitName,
    header: header.unitName ? `${header.unitKind} ${header.unitName}` : header.unitKind,
    procedureCount,
    functionCount,
    cursorCount,
    hasCommit,
    hasRollback,
    hasExecutableBody,
    items,
  };
}

// ---------------------------------------------------------------------------
// 構造サマリの文言
// ---------------------------------------------------------------------------

const DML_LABEL_ORDER = ['UPDATE', 'DELETE', 'INSERT', 'MERGE', 'SELECT'];

function buildStructureSummary(info) {
  const parts = [];
  if (info.procedureCount > 0) parts.push(`プロシージャ${info.procedureCount}個`);
  if (info.functionCount > 0) parts.push(`ファンクション${info.functionCount}個`);

  const counts = {};
  for (const item of info.items) {
    if (item.kind === 'CURSOR') continue;
    counts[item.kind] = (counts[item.kind] || 0) + 1;
  }
  const dmlParts = [];
  for (const k of DML_LABEL_ORDER) {
    if (counts[k]) dmlParts.push(`${k} ${counts[k]}本`);
  }
  parts.push(dmlParts.length > 0 ? `抽出したDML: ${dmlParts.join('・')}` : '抽出したDML: なし');

  if (info.cursorCount > 0) parts.push(`カーソル${info.cursorCount}個`);

  const tx = [];
  if (info.hasCommit) tx.push('COMMITあり');
  if (info.hasRollback) tx.push('ROLLBACKあり');
  parts.push(tx.length > 0 ? tx.join('・') : 'COMMIT/ROLLBACKなし');

  return parts.join(' / ');
}

// ---------------------------------------------------------------------------
// 実行時に値が決まる変数（バインド変数・PL/SQL変数）の検出
// ---------------------------------------------------------------------------

// 検算SELECTのWHERE句に「そのままでは実行できないもの」が残っているかを見る。
//  - `:name`         : バインド変数
//  - `v_orders(i)`   : コレクションの添字参照
//  - `SQL%ROWCOUNT`  : PL/SQLの属性
//  - `p_ / v_ / l_ / g_ / r_ / c_` 始まりの識別子: PL/SQL変数の慣習的な命名
const RUNTIME_VAR_PATTERNS = [
  /:[A-Za-z_][A-Za-z0-9_$#]*/,
  /[A-Za-z_][A-Za-z0-9_$#]*\s*\(\s*[A-Za-z_][A-Za-z0-9_$#]*\s*\)/,
  /\b[A-Za-z_][A-Za-z0-9_$#]*\s*%\s*[A-Za-z_]/,
  /\b(?:p|v|l|g|r|c)_[A-Za-z0-9_$#]+/i,
];

function hasRuntimeVariable(text) {
  if (!text) return false;
  return RUNTIME_VAR_PATTERNS.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// 公開 API（file:// 直開き対応のため globalThis 経由。analyzer.js と同じ方式）
// ---------------------------------------------------------------------------

globalThis.SQLMeganePlsqlExtract = {
  maskPlsql,
  splitSlashChunks,
  isPlsqlUnitChunk,
  extractPlsqlUnit,
  buildStructureSummary,
  hasRuntimeVariable,
  _internal: {
    tokenize,
    findStatementEnd,
    hasTopLevelInto,
    parseUnitHeader,
    UNIT_START_RE,
  },
};

})();
