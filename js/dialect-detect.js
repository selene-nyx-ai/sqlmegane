/**
 * SQLMegane（SQLめがね） dialect-detect.js
 *
 * 機能B: 方言の自動判定。
 *
 * 方針:
 *  1. まず正規表現ベースのヒューリスティックでOracle/SQL Server/MySQL/PostgreSQL
 *     それぞれの「その方言らしさ」を示すマーカーの出現数をスコアリングする。
 *     最高スコアの方言が1つに決まれば、それを採用する。
 *  2. スコアが同点（無得点を含む）で1つに決まらない場合は、同梱している
 *     MySQL/PostgreSQL/SQL Server の3方言のASTパーサで実際に試しパースし、
 *     成功した方言を採用する。複数の方言で成功した場合はANSI互換SQLとみなし、
 *     方言固有のTipsを出さないという前提のもとMySQLを採用する。
 *  3. どちらの根拠でも決められない場合は汎用（正規表現の簡易チェックのみ）に
 *     留める。
 *
 * マーカー検出は文字列リテラル・コメントの中身を無害化した上で行う
 * （analyzer.js の scan() をそのまま流用する）。文字列やコメントの中に
 * たまたま方言のキーワードが含まれていても誤判定しないようにするため。
 *
 * file:// 直開き対応のため ESM の export は使わず、末尾で
 * globalThis.SQLMeganeDialectDetect に公開する（他ファイルと同じ方式）。
 */
(function () {

// ---------------------------------------------------------------------------
// ヒューリスティックマーカー定義
// ---------------------------------------------------------------------------
//
// 各マーカーは「文字列・コメントを無害化したテキスト（masked）」に対して判定する。
// キー（oracle/mssql/mysql/postgres）は analyzer.js / app.js の方言セレクタの値と
// 揃えてある。

const MARKERS = {
  oracle: [
    { label: '(+)結合', re: /\(\s*\+\s*\)/ },
    { label: 'ROWNUM', re: /\bROWNUM\b/i },
    { label: 'NVL(', re: /\bNVL\s*\(/i },
    { label: 'SYSDATE', re: /\bSYSDATE\b/i },
    { label: 'DUAL', re: /\bFROM\s+DUAL\b/i },
    { label: '%TYPE/%ROWTYPE', re: /%(?:TYPE|ROWTYPE)\b/i },
    { label: 'MERGE INTO', re: /\bMERGE\s+INTO\b/i },
  ],
  mssql: [
    { label: '@変数', re: /@[A-Za-z_][\w$]*/ },
    { label: '[角括弧識別子]', re: /\[[A-Za-z_][^\]]*\]/ },
    { label: 'TOP n', re: /\bTOP\s+\d+\b/i },
    { label: 'GETDATE()', re: /\bGETDATE\s*\(/i },
    { label: 'ISNULL(', re: /\bISNULL\s*\(/i },
    { label: 'BEGIN TRAN', re: /\bBEGIN\s+TRAN(?:SACTION)?\b/i },
    { label: 'sp_プレフィックス', re: /\bsp_[A-Za-z_]/i },
    { label: 'NOLOCK', re: /\bNOLOCK\b/i },
  ],
  mysql: [
    { label: 'バッククォート', re: /`[^`]+`/ },
    { label: 'LIMIT n', re: /\bLIMIT\s+\d+/i },
    { label: 'NOW()', re: /\bNOW\s*\(/i },
    { label: 'ON DUPLICATE KEY', re: /\bON\s+DUPLICATE\s+KEY\b/i },
    { label: 'AUTO_INCREMENT', re: /\bAUTO_INCREMENT\b/i },
  ],
  postgres: [
    { label: '::キャスト', re: /::[A-Za-z_]/ },
    { label: 'RETURNING', re: /\bRETURNING\b/i },
    { label: 'ILIKE', re: /\bILIKE\b/i },
    { label: 'ON CONFLICT', re: /\bON\s+CONFLICT\b/i },
    { label: 'SERIAL', re: /\bSERIAL\b/i },
    { label: '$n（位置パラメータ）', re: /\$\d+\b/ },
  ],
};

// mysqlの文字列内バックスラッシュエスケープ（例: 'it\'s'）だけは特殊。
// これは「文字列の終端をどう認識するか」自体に関わる方言差なので、無害化前の
// 生テキストに対して素朴なパターンで検出する（マスク済みテキストでは、
// バックスラッシュの意味を知らないと正しく文字列境界を判定できないため）。
const MYSQL_BACKSLASH_ESCAPE_RE = /\\'/;

// ---------------------------------------------------------------------------
// マスク（文字列リテラル・コメントの無害化）
// ---------------------------------------------------------------------------

/**
 * analyzer.js の scan() を流用する。まだ方言が分かっていない時点での判定なので
 * 'generic' 扱い（mysqlのバックスラッシュエスケープは考慮しない）で呼ぶ。
 * 万一 analyzer.js が読み込まれていない場合は、無害化せず生テキストのまま
 * 判定する（フォールバック。誤判定のリスクは上がるが、例外は投げない）。
 */
function maskForDetection(sql) {
  const Analyzer = globalThis.SQLMeganeAnalyzer;
  const scanFn = Analyzer && Analyzer._internal && Analyzer._internal.scan;
  if (typeof scanFn === 'function') {
    return scanFn(sql, 'generic');
  }
  return { plain: sql, masked: sql };
}

// ---------------------------------------------------------------------------
// スコアリング
// ---------------------------------------------------------------------------

function scoreMarkers(masked) {
  const scores = { oracle: 0, mssql: 0, mysql: 0, postgres: 0 };
  const hitMarkers = { oracle: [], mssql: [], mysql: [], postgres: [] };

  for (const dialect of Object.keys(MARKERS)) {
    for (const marker of MARKERS[dialect]) {
      if (marker.re.test(masked)) {
        scores[dialect]++;
        hitMarkers[dialect].push(marker.label);
      }
    }
  }

  return { scores, hitMarkers };
}

/** PL/SQLユニット構造（BEGIN...END;/ や CREATE OR REPLACE PACKAGE ... など）は
 *  正規表現1つでは表せないため、既存の isPlsqlUnitChunk をそのまま流用する。
 *  Oracleらしさの強い根拠になるので見つかれば先頭に積む。 */
function detectPlsqlUnitMarker(sql) {
  const PlsqlExtract = globalThis.SQLMeganePlsqlExtract;
  if (!PlsqlExtract) return false;
  try {
    const chunks = PlsqlExtract.splitSlashChunks(sql);
    return chunks.some((c) => PlsqlExtract.isPlsqlUnitChunk(c.text, c.terminatedBySlash));
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 試しパースによる判定（スコア同点・無得点のときのフォールバック）
// ---------------------------------------------------------------------------

const TRY_PARSE_DIALECTS = ['mysql', 'postgres', 'mssql'];

/**
 * 3方言のASTパーサで試しパースし、選択方言でそのまま（別方言への再挑戦なしで）
 * 成功した方言の一覧を返す。node-sql-parser は複数文をまとめて渡しても配列で
 * 返してくれるため、貼り付けテキスト全体をそのまま渡して構わない。
 */
function tryParseDialects(sql) {
  const Ast = globalThis.SQLMeganeSqlAst;
  if (!Ast) return [];
  const succeeded = [];
  for (const d of TRY_PARSE_DIALECTS) {
    if (!Ast.isAvailable(d)) continue;
    const result = Ast.parseStatement(sql, d);
    if (result.ok && !result.usedFallbackDialect) succeeded.push(d);
  }
  return succeeded;
}

// ---------------------------------------------------------------------------
// 公開API
// ---------------------------------------------------------------------------

/**
 * SQLテキストから方言を自動判定する。
 * 戻り値: { dialect, reason, markers, scores }
 *  - dialect: 'oracle' | 'mssql' | 'mysql' | 'postgres' | 'generic' | null
 *    （null は空入力など判定自体が意味を持たない場合）
 *  - reason : 'heuristic' | 'parse-success-single' | 'parse-success-ambiguous' | 'undetermined'
 *  - markers: 判定根拠として表示するマーカーラベルの配列（最大3個）
 *  - scores : デバッグ・テスト用のマーカー出現数
 */
function detectDialect(sqlText) {
  const sql = sqlText || '';
  if (!sql.trim()) {
    return { dialect: null, reason: 'empty', markers: [], scores: null };
  }

  const { masked, plain } = maskForDetection(sql);
  const { scores, hitMarkers } = scoreMarkers(masked);

  if (MYSQL_BACKSLASH_ESCAPE_RE.test(sql)) {
    scores.mysql++;
    hitMarkers.mysql.push('バックスラッシュエスケープ');
  }

  if (detectPlsqlUnitMarker(sql)) {
    scores.oracle++;
    hitMarkers.oracle.unshift('PL/SQLユニット構造');
  }

  const ranked = Object.keys(scores)
    .map((dialect) => ({ dialect, score: scores[dialect] }))
    .sort((a, b) => b.score - a.score);
  const top = ranked[0];
  const second = ranked[1];

  if (top.score > 0 && top.score > second.score) {
    return {
      dialect: top.dialect,
      reason: 'heuristic',
      markers: hitMarkers[top.dialect].slice(0, 3),
      scores,
    };
  }

  // スコアが同点（無得点含む）で1つに決まらない → 3方言のパーサで試しパース
  const succeeded = tryParseDialects(sql);
  if (succeeded.length === 1) {
    return { dialect: succeeded[0], reason: 'parse-success-single', markers: [], scores };
  }
  if (succeeded.length > 1) {
    // 複数方言で成功 = ANSI互換SQLとみなし、mysqlを採用する（呼び出し側で
    // mysql固有のTips（LIMIT句の案内等）を出さないよう扱うこと）。
    return { dialect: 'mysql', reason: 'parse-success-ambiguous', markers: [], scores };
  }

  // どの根拠でも決められない → 汎用（簡易チェックのみ）に留める
  return { dialect: 'generic', reason: 'undetermined', markers: [], scores };
}

globalThis.SQLMeganeDialectDetect = {
  detectDialect,
};

})();
