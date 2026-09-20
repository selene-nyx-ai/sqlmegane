// SQLMegane（SQLめがね） app.js
// UIとanalyzer.jsを結線するだけの薄い層。解析ロジックは一切ここに書かない。
//
// file:// 直開き時のCORS制限によりESMのimportが機能しないため、通常の
// スクリプトとして読み込み、先に読み込まれた js/analyzer.js が公開する
// globalThis.SQLMeganeAnalyzer から関数を取得する（経緯はREADME.md /
// docs/architecture.md を参照）。index.html側で analyzer.js → app.js の
// 順に読み込むことで、この時点で SQLMeganeAnalyzer が必ず定義済みであることを
// 保証している。

const { analyzeSQL, collectPlsqlFindings } = globalThis.SQLMeganeAnalyzer;
const { detectDialect } = globalThis.SQLMeganeDialectDetect || {};
const DmlBuilder = globalThis.SQLMeganeDmlBuilder;
const Templates = globalThis.SQLMeganeTemplates;
const I18n = globalThis.SQLMeganeI18n;
const t = (key, params) => I18n.t(key, params);

if (I18n.getLocale() === 'en') {
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    const value = t(node.dataset.i18n);
    const attr = node.dataset.i18nAttr;
    if (attr) node.setAttribute(attr, value);
    else if (node.dataset.i18nHtml === 'true') node.innerHTML = value;
    else node.textContent = value;
  });
  document.querySelectorAll('[data-i18n-aria]').forEach((node) => node.setAttribute('aria-label', t(node.dataset.i18nAria)));
}

const els = {
  input: document.getElementById('sql-input'),
  dialect: document.getElementById('dialect-select'),
  analyzeBtn: document.getElementById('analyze-btn'),
  clearBtn: document.getElementById('clear-btn'),
  results: document.getElementById('results'),
  buildDmlBtn: document.getElementById('build-dml-btn'),
  oracleVersion: document.getElementById('oracle-version-select'),
  oracleVersionWrap: document.getElementById('oracle-version-wrap'),
  templateButtons: document.getElementById('template-buttons'),
  templatePreview: document.getElementById('template-preview'),
  templateTitle: document.getElementById('template-title'),
  templateSql: document.getElementById('template-sql'),
  templateCopy: document.getElementById('template-copy'),
};

const KIND_LABELS = {
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
  INSERT: 'INSERT',
  SELECT: 'SELECT',
  MERGE: 'MERGE',
  TRUNCATE_TABLE: 'TRUNCATE TABLE',
  DROP_TABLE: 'DROP TABLE',
  DROP_DATABASE: 'DROP DATABASE',
  DROP_OTHER: 'DROP',
  CREATE: 'CREATE',
  ALTER: 'ALTER',
  BEGIN_TX: t('ui.kind.begin'),
  END_TX: 'COMMIT / ROLLBACK',
  PLSQL_UNIT: t('ui.kind.plsql'),
  OTHER: t('ui.kind.other'),
};

const SEVERITY_LABELS = { danger: t('ui.severity.danger'), warning: t('ui.severity.warning'), info: t('ui.severity.info') };

const DIALECT_LABELS = {
  generic: t('ui.generic'),
  oracle: 'Oracle',
  mssql: 'SQL Server',
  mysql: 'MySQL',
  postgres: 'PostgreSQL',
  auto: t('ui.auto'),
};

const PARSER_LABELS = {
  mysql: 'MySQL',
  postgresql: 'PostgreSQL',
  transactsql: 'SQL Server (T-SQL)',
};

let debounceTimer = null;
let showDmlBuilder = false;
// キー IN 形の選択状態。入力のたびに再描画されても、選んだ表・キーが消えないように保持する
// （しぐれさん要望 2026-09-16「貼ったら勝手に解析してほしい」への対応で自動描画にしたため）。
const byKeyState = { table: null, other: '', outputKey: null, targetKey: '', converted: false };

function el(tag, opts) {
  const node = document.createElement(tag);
  if (!opts) return node;
  if (opts.className) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  }
  return node;
}

function countBySeverity(findings) {
  const counts = { danger: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

function renderSeverityChips(container, counts) {
  const wrap = el('div', { className: 'severity-counts' });
  const order = ['danger', 'warning', 'info'];
  let any = false;
  for (const sev of order) {
    if (counts[sev] > 0) {
      any = true;
      wrap.appendChild(el('span', {
        className: `severity-chip ${sev}`,
        text: `${SEVERITY_LABELS[sev]} ${counts[sev]}`,
      }));
    }
  }
  if (!any) {
    wrap.appendChild(el('span', { className: 'severity-chip ok', text: t('ui.noDanger') }));
  }
  container.appendChild(wrap);
  return wrap;
}

function renderFinding(finding) {
  const card = el('div', { className: `finding ${finding.severity}` });
  const head = el('div', { className: 'finding-head' });
  head.appendChild(el('span', { className: 'sev-label', text: SEVERITY_LABELS[finding.severity] }));
  head.appendChild(el('span', { text: finding.title }));
  card.appendChild(head);
  card.appendChild(el('p', { className: 'finding-message', text: finding.message }));
  return card;
}

async function copyToClipboard(text, btn) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    const original = btn.textContent;
    btn.textContent = t('ui.copied');
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('copied');
    }, 1600);
  } catch (e) {
    btn.textContent = t('ui.copyFailed');
    setTimeout(() => { btn.textContent = t('ui.copy'); }, 1600);
  }
}

/**
 * 検算SELECTのカード。JOINを含む場合（hasJoin）は、表示件数が「結合行数」であり
 * 1対多のJOINでは実際の更新・削除対象の行数より大きくなりうることを、ラベルと
 * 注記の両方で明示する（生成SQL自体にも同内容のコメントが入っている）。
 */
function renderVerifySelect(sql, hasJoin, hasRuntimeVariable) {
  // 既定ロケール: 検算SELECT（実行前に対象件数を確認・JOINのため結合行数です）
  // 既定ロケール: ※JOINを含むため結合行数です。1対多の結合では実際の更新行数より大きくなることがあります。
  const wrap = el('div', { className: 'verify-select' });
  const head = el('div', { className: 'verify-select-head' });
  const labelText = hasJoin ? t('ui.verifyJoin') : t('ui.verify');
  head.appendChild(el('span', { className: 'verify-select-label', text: labelText }));
  const copyBtn = el('button', { className: 'btn btn-copy', text: t('ui.copy'), attrs: { type: 'button' } });
  copyBtn.addEventListener('click', () => copyToClipboard(sql, copyBtn));
  head.appendChild(copyBtn);
  wrap.appendChild(head);
  if (hasJoin) {
    wrap.appendChild(el('p', {
      className: 'verify-select-note',
      text: t('ui.verifyJoinNote'),
    }));
  }
  // PL/SQL内部から抽出したDMLは、WHERE句にPL/SQL変数やバインド変数が残る。
  // そのままでは実行できないので、置き換えが必要なことを明示する。
  if (hasRuntimeVariable) {
    wrap.appendChild(el('p', {
      className: 'verify-select-note',
      text: t('ui.verifyVariable'),
    }));
  }
  const pre = el('pre');
  pre.textContent = sql;
  wrap.appendChild(pre);
  return wrap;
}

// ---------------------------------------------------------------------------
// 日本語要約カード（v2の主役。警告より上に表示する）
// ---------------------------------------------------------------------------

function renderConditionList(items, depth) {
  const ul = el('ul', { className: depth === 0 ? 'summary-conditions' : 'summary-conditions-nested' });
  for (const item of items) {
    const li = el('li');
    li.appendChild(document.createTextNode(item.text));
    if (item.children && item.children.length > 0) {
      li.appendChild(renderConditionList(item.children, depth + 1));
    }
    ul.appendChild(li);
  }
  return ul;
}

function renderSummaryBlock(block) {
  if (block.type === 'list') {
    const wrap = el('div', { className: 'summary-block' });
    if (block.title) wrap.appendChild(el('p', { className: 'summary-list-title', text: `${block.title}:` }));
    wrap.appendChild(renderConditionList(block.items, 0));
    return wrap;
  }
  const cls = block.type === 'alert'
    ? 'summary-line summary-alert'
    : block.type === 'join'
      ? 'summary-line summary-join'
      : 'summary-line';
  return el('p', { className: cls, text: block.text });
}

/**
 * 見出しは一文統合要約。summarizer が headlineParts（強調フラグ付きの断片）を
 * 返す場合はそれを使い、「全行」のような危険な語を <strong> で立たせる。
 * 断片が無い場合（将来の互換）はプレーンな headline をそのまま出す。
 */
function renderHeadline(summary) {
  const p = el('p', { className: 'summary-headline' });
  const parts = Array.isArray(summary.headlineParts) ? summary.headlineParts : null;
  if (!parts || parts.length === 0) {
    p.textContent = summary.headline;
    return p;
  }
  for (const part of parts) {
    if (part.strong) p.appendChild(el('strong', { className: 'summary-emphasis', text: part.text }));
    else p.appendChild(document.createTextNode(part.text));
  }
  return p;
}

function renderSummary(summary) {
  const card = el('div', { className: 'stmt-summary' });
  const head = el('div', { className: 'summary-head' });
  head.appendChild(el('span', { className: 'summary-label', text: t('ui.summaryLabel') }));
  head.appendChild(el('span', { className: 'summary-op', text: summary.op }));
  card.appendChild(head);
  card.appendChild(renderHeadline(summary));
  for (const block of summary.blocks) {
    card.appendChild(renderSummaryBlock(block));
  }
  return card;
}

/** パースに失敗して正規表現の簡易チェックに落ちたことを明示する */
function renderFallbackNotice(parse) {
  const line = parse.error && parse.error.globalLine != null
    ? parse.error.globalLine
    : (parse.error ? parse.error.line : null);
  const where = line != null ? t('ui.position', { line }) : '';
  const note = el('div', { className: 'parse-notice' });
  note.appendChild(el('span', { className: 'parse-notice-badge', text: t('ui.fallbackBadge') }));
  note.appendChild(el('span', {
    text: t('ui.fallbackNotice', { position: where }),
  }));
  return note;
}

/**
 * 別方言（mysql）のパーサで再挑戦して解析に成功したことを明示する。
 * 「参考表示」程度の軽い扱いにすると、選択方言では構文エラーになるSQLでも
 * あたかも正常に解析できたかのように見えてしまうため、選択方言では構文エラー
 * だったという事実を warning として必ず表示する（位置つき）。
 */
function renderParserSwapNotice(parse, dialect) {
  // 既定ロケールでは「⚠ 方言不一致」「選択した方言」「別方言」「参考表示」と案内する。
  // 選択した方言では構文エラーです。このSQLは選択した方言では実行できない可能性があります。
  const selectedLabel = DIALECT_LABELS[dialect] || dialect;
  const fallbackLabel = PARSER_LABELS[parse.parserDialect] || parse.parserDialect;
  const err = parse.primaryError;
  const line = err && err.globalLine != null ? err.globalLine : (err ? err.line : null);
  const where = line != null ? t('ui.position', { line }) : '';
  const note = el('div', { className: 'parse-notice parse-notice-warning' });
  note.appendChild(el('span', { className: 'parse-notice-badge', text: t('ui.dialectMismatch') }));
  note.appendChild(el('span', {
    text: t('ui.parserSwap', { selected: selectedLabel, fallback: fallbackLabel, position: where }),
  }));
  return note;
}

/**
 * 解析できなかった文（MERGE / PL/SQLブロック / インラインビューUPDATE等）は
 * findings が空・要約なしでも「警告なし」に見えないよう、カード自体を危険色系の
 * 縁取りにする（P1: 沈黙素通り対策。「安全に見える」のを防ぐのが目的）。
 *
 * 機能A: 「構文解析はできないが正規表現の簡易チェックは併走させた」文（checkLevel
 * 'basic'。例: MERGE、EXEC等の破壊的キーワードを含むOTHER文）と、「簡易チェックすら
 * 適用できなかった」文（checkLevel 'none'。例: 動的SQLでDMLを1本も抽出できなかった
 * PL/SQLブロック）とで、カードの縁取りの強さを変える。前者はwarning系、後者は
 * 従来通りdanger系で目立たせる。
 */
function unanalyzedCheckLevel(stmt) {
  const f = stmt.findings.find((f) => f.code === 'unanalyzed-statement');
  if (!f) return null;
  return (f.meta && f.meta.checkLevel) || 'none';
}

function isUnanalyzedStatement(stmt) {
  return unanalyzedCheckLevel(stmt) !== null;
}

// ---------------------------------------------------------------------------
// PL/SQLユニット（Oracle対応 Phase 1）
// ---------------------------------------------------------------------------

/** 抽出したDML1本ぶんのサブカード。通常の文カードと同じ内容（findings・検算SELECT）を出す */
function renderPlsqlItem(item, index, stmtNumber) {
  const card = el('div', { className: 'plsql-item', attrs: { id: `stmt-${stmtNumber}-item-${index + 1}` } });

  const headRow = el('div', { className: 'plsql-item-head' });
  const title = el('div', { className: 'stmt-title' });
  title.appendChild(el('span', { className: 'stmt-number', text: t('ui.extracted', { number: index + 1 }) }));
  const labelText = item.cursorName ? `${item.label}: ${item.cursorName}` : item.label;
  title.appendChild(el('span', { className: 'stmt-kind', text: labelText }));
  headRow.appendChild(title);
  renderSeverityChips(headRow, countBySeverity(item.findings));
  card.appendChild(headRow);

  const sqlPre = el('pre', { className: 'stmt-sql' });
  sqlPre.textContent = item.sql;
  card.appendChild(sqlPre);

  if (item.findings.length > 0) {
    const list = el('div', { className: 'findings-list' });
    for (const f of item.findings) list.appendChild(renderFinding(f));
    card.appendChild(list);
  } else {
    const note = el('div', { className: 'no-findings-note' });
    note.appendChild(document.createTextNode(t('ui.noDangerLong')));
    const small = el('small', { text: t('ui.humanReview') });
    note.appendChild(small);
    card.appendChild(note);
  }

  if (item.verifySelect) {
    card.appendChild(renderVerifySelect(
      item.verifySelect,
      !!item.verifySelectHasJoin,
      !!item.verifySelectHasRuntimeVariable
    ));
  }

  return card;
}

/** PL/SQLユニットの構造サマリ（何が何個あって、DMLを何本抽出したか） */
function renderPlsqlStructure(plsql) {
  const wrap = el('div', { className: 'plsql-structure' });
  wrap.appendChild(el('p', { className: 'plsql-structure-head', text: t('ui.plsqlUnit', { header: plsql.header }) }));
  wrap.appendChild(el('p', { className: 'plsql-structure-line', text: plsql.structure }));
  return wrap;
}

function renderStatementCard(stmt, dialect) {
  const checkLevel = unanalyzedCheckLevel(stmt);
  const cardClass = checkLevel === 'none'
    ? 'stmt-card stmt-card-unanalyzed'
    : checkLevel === 'basic'
      ? 'stmt-card stmt-card-unanalyzed-basic'
      : 'stmt-card';
  const card = el('div', { className: cardClass, attrs: { id: `stmt-${stmt.number}` } });

  // PL/SQLユニットは、自分自身のfindings（制御フロー未解析の注記など）だけでなく
  // 抽出したDMLのfindingsも数に入れないと、カード見出しが「危険の検出なし」に
  // 見えてしまう（中のUPDATEがWHERE漏れでも気づけない）。
  const headlineFindings = stmt.plsql
    ? stmt.findings.concat(collectPlsqlFindings(stmt))
    : stmt.findings;

  const headRow = el('div', { className: 'stmt-card-head' });
  const title = el('div', { className: 'stmt-title' });
  title.appendChild(el('span', { className: 'stmt-number', text: t('ui.statement', { number: stmt.number }) }));
  title.appendChild(el('span', { className: 'stmt-kind', text: KIND_LABELS[stmt.kind] || stmt.kind }));
  headRow.appendChild(title);
  renderSeverityChips(headRow, countBySeverity(headlineFindings));
  card.appendChild(headRow);

  if (stmt.plsql) {
    card.appendChild(renderPlsqlStructure(stmt.plsql));
  }

  const sqlPre = el('pre', { className: 'stmt-sql' });
  sqlPre.textContent = stmt.raw;
  card.appendChild(sqlPre);

  if (stmt.parse && stmt.parse.mode === 'fallback') {
    card.appendChild(renderFallbackNotice(stmt.parse));
  } else if (stmt.parse && stmt.parse.usedFallbackDialect) {
    card.appendChild(renderParserSwapNotice(stmt.parse, dialect));
  }

  if (stmt.summary) {
    card.appendChild(renderSummary(stmt.summary));
  }

  if (stmt.findings.length > 0) {
    const list = el('div', { className: 'findings-list' });
    for (const f of stmt.findings) list.appendChild(renderFinding(f));
    card.appendChild(list);
  } else if (!stmt.plsql) {
    const note = el('div', { className: 'no-findings-note' });
    note.appendChild(document.createTextNode(t('ui.noDangerLong')));
    const small = el('small', { text: t('ui.humanReview') });
    note.appendChild(small);
    card.appendChild(note);
  }

  if (stmt.plsql && stmt.plsql.items.length > 0) {
    const list = el('div', { className: 'plsql-items' });
    list.appendChild(el('p', {
      className: 'plsql-items-title',
      text: t('ui.extractedDml', { count: stmt.plsql.items.length }),
    }));
    stmt.plsql.items.forEach((item, i) => list.appendChild(renderPlsqlItem(item, i, stmt.number)));
    card.appendChild(list);
  }

  if (stmt.verifySelect) {
    card.appendChild(renderVerifySelect(stmt.verifySelect, !!stmt.verifySelectHasJoin, false));
  }

  return card;
}

// ---------------------------------------------------------------------------
// 機能B: 方言の自動判定バッジ
// ---------------------------------------------------------------------------
//
// M2の教訓（プロジェクトメモリ）: 自動判定は「当たっていれば便利」だが、外した
// ときに気づけないと事故に直結する。結果の先頭に必ずバッジを出し、判定根拠
// （ヒットしたマーカー最大3個）を添えて、誤っていたら選び直せることを明示する。

/** detectDialectの戻り値から、バッジに表示する「判定根拠」の文言を組み立てる */
function buildAutoDetectReasonText(detection, resolvedLabel) {
  switch (detection.reason) {
    case 'heuristic':
      return t('ui.autoReason.heuristic', { markers: detection.markers.length > 0 ? detection.markers.join(I18n.getLocale() === 'en' ? ', ' : '・') : resolvedLabel });
    case 'parse-success-single':
      return t('ui.autoReason.single', { dialect: resolvedLabel });
    case 'parse-success-ambiguous':
      return t('ui.autoReason.ambiguous');
    case 'undetermined':
    default:
      return t('ui.autoReason.unknown');
  }
}

function renderAutoDialectNotice(detection, resolvedDialect) {
  const label = DIALECT_LABELS[resolvedDialect] || resolvedDialect;
  const reasonText = buildAutoDetectReasonText(detection, label);
  const wrap = el('div', { className: 'auto-dialect-notice' });
  wrap.appendChild(el('span', { className: 'auto-dialect-badge', text: t('ui.autoBadge') }));
  wrap.appendChild(el('span', {
    text: t('ui.autoNotice', { dialect: label, reason: reasonText }),
  }));
  return wrap;
}

// ---------------------------------------------------------------------------
// 解析レベルのバッジ（方言によってASTか簡易チェックかが変わることを明示する）
// ---------------------------------------------------------------------------

function renderAnalysisBadge(result) {
  const wrap = el('div', { className: 'analysis-level' });
  const dialectLabel = DIALECT_LABELS[result.dialect] || result.dialect;

  if (result.analysis && result.analysis.astSupported) {
    wrap.appendChild(el('span', { className: 'analysis-badge ast', text: t('ui.astBadge') }));
    const fb = result.analysis.fallbackStatements;
    wrap.appendChild(el('span', {
      className: 'analysis-note',
      text: fb > 0 ? t('ui.astFallbackNote', { dialect: dialectLabel, count: fb }) : t('ui.astNote', { dialect: dialectLabel }),
    }));
  } else {
    wrap.appendChild(el('span', { className: 'analysis-badge simple', text: t('ui.simpleBadge') }));
    wrap.appendChild(el('span', {
      className: 'analysis-note',
      text: t('ui.simpleNote', { dialect: dialectLabel }),
    }));
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// スクリプトモード（複数文をまとめて貼ったときの全体サマリ）
// ---------------------------------------------------------------------------

const OVERVIEW_KIND_ORDER = ['UPDATE', 'DELETE', 'INSERT', 'MERGE', 'TRUNCATE_TABLE', 'DROP_TABLE', 'DROP_DATABASE', 'DROP_OTHER', 'ALTER', 'CREATE', 'SELECT'];

function overviewCountsText(counts) {
  const parts = [];
  let others = 0;
  for (const [kind, n] of Object.entries(counts)) {
    if (OVERVIEW_KIND_ORDER.includes(kind)) continue;
    others += n;
  }
  for (const kind of OVERVIEW_KIND_ORDER) {
    if (counts[kind]) parts.push(t('ui.count', { label: KIND_LABELS[kind] || kind, count: counts[kind] }));
  }
  if (others > 0) parts.push(t('ui.otherCount', { count: others }));
  return parts.join(' / ');
}

// 危険・注意の件数と該当文の一覧は先頭の判定バナー（renderVerdictBanner）に
// 統合したため、ここでは重複させない。スクリプトモードカードは「触るテーブル
// 一覧・文の内訳」（＋構文解析できなかった文の一覧）に絞る。
function renderOverview(overview) {
  const card = el('div', { className: 'overview-card' });
  card.appendChild(el('h2', { className: 'overview-title', text: t('ui.overviewTitle') }));

  card.appendChild(el('p', {
    className: 'overview-line',
    text: t('ui.overviewLine', { total: overview.total, counts: overviewCountsText(overview.counts), destructive: overview.destructiveCount }),
  }));

  card.appendChild(el('p', {
    className: 'overview-line',
    text: overview.tables.length > 0
      ? t('ui.tables', { tables: overview.tables.join(' / ') })
      : t('ui.tablesUnknown'),
  }));

  if (overview.fallbackStatements.length > 0) {
    card.appendChild(el('p', {
      className: 'overview-line',
      text: t('ui.fallbackStatements', { statements: overview.fallbackStatements.map((n) => `#${n}`).join(', ') }),
    }));
  }

  if (overview.unanalyzedStatements.length > 0) {
    const line = el('p', { className: 'overview-line overview-warned' });
    line.appendChild(document.createTextNode(t('ui.unanalyzedStart', { count: overview.unanalyzedStatements.length })));
    overview.unanalyzedStatements.forEach((num, i) => {
      if (i > 0) line.appendChild(document.createTextNode(', '));
      const a = el('a', { className: 'overview-link', text: `#${num}`, attrs: { href: `#stmt-${num}` } });
      line.appendChild(a);
    });
    line.appendChild(document.createTextNode(t('ui.unanalyzedEnd')));
    card.appendChild(line);
  }

  return card;
}

// ---------------------------------------------------------------------------
// 判定バナー（結果エリア先頭。プロダクトオーナー指摘: スクロールしないと
// 全部見きれないから、冒頭に危険/注意/情報が何件あるかを出すべき。
// ユーザーはできる限りUIを操作したくない設計にする）
// ---------------------------------------------------------------------------
//
// 集計対象は「文それ自身のfindings」「globalFindings（バッチ全体向け）」
// 「PL/SQLユニット内に抽出したDML（plsql.items）のfindings」の3種類すべて。
// PL/SQL内の抽出DMLのfindings（カーソルwarning等）を含めないと、冒頭の件数が
// 実際にレビューすべき件数と食い違ってしまうため必須。

/**
 * 解析結果全体から、判定バナーに必要な「severity別の件数」と「危険・注意の
 * ジャンプ先一覧（文番号ラベル → アンカー）」を1回の走査で組み立てる。
 * globalFindingsは特定の文に紐づかない（＝ジャンプ先アンカーが無い）ため、
 * 件数には数えるがジャンプ一覧には含めない。
 * PL/SQL内の抽出DMLは「文N-抽出M」ラベルで、そのサブカード自身のアンカー
 * （#stmt-N-item-M。renderPlsqlItemが付与）へジャンプする。
 */
function computeVerdict(result) {
  const counts = { danger: 0, warning: 0, info: 0 };
  const dangerJumps = new Map();
  const warningJumps = new Map();

  const addJump = (severity, label, anchor) => {
    if (severity === 'danger') dangerJumps.set(label, anchor);
    else if (severity === 'warning') warningJumps.set(label, anchor);
  };

  for (const stmt of result.statements) {
    for (const f of stmt.findings) {
      counts[f.severity]++;
      addJump(f.severity, t('ui.jumpStatement', { number: stmt.number }), `#stmt-${stmt.number}`);
    }
    if (stmt.plsql) {
      stmt.plsql.items.forEach((item, i) => {
        for (const f of item.findings) {
          counts[f.severity]++;
          addJump(f.severity, t('ui.jumpExtracted', { number: stmt.number, item: i + 1 }), `#stmt-${stmt.number}-item-${i + 1}`);
        }
      });
    }
  }
  for (const f of result.globalFindings) {
    counts[f.severity]++;
  }

  return { counts, dangerJumps, warningJumps };
}

/** 「危険: 文3・文7」のような、ジャンプリンクを「・」区切りで並べた行を作る */
function renderVerdictJumpLine(labelPrefix, jumps) {
  const line = el('p', { className: 'verdict-jump-line' });
  line.appendChild(document.createTextNode(labelPrefix));
  let i = 0;
  for (const [label, anchor] of jumps) {
    if (i > 0) line.appendChild(document.createTextNode(I18n.getLocale() === 'en' ? ', ' : '・'));
    line.appendChild(el('a', { className: 'verdict-jump-link', text: label, attrs: { href: anchor } }));
    i++;
  }
  return line;
}

/**
 * 判定バナー本体。文が1件でも、findingsが0件でも、結果エリアの一番上に
 * 常に表示する（スクロールせず見える設計にするのが目的なので、条件付きで
 * 出し分けたりはしない）。
 */
function renderVerdictBanner(result) {
  const { counts, dangerJumps, warningJumps } = computeVerdict(result);
  const level = counts.danger > 0 ? 'danger' : (counts.warning > 0 ? 'warning' : 'neutral');

  const wrap = el('div', { className: `verdict-banner verdict-${level}`, attrs: { role: 'status' } });

  const headline = el('p', { className: 'verdict-headline' });
  const segs = [];
  if (level === 'danger') {
    segs.push(t('ui.verdictDanger', { count: counts.danger }));
    segs.push(t('ui.verdictWarning', { count: counts.warning }));
    segs.push(t('ui.verdictInfo', { count: counts.info }));
  } else if (level === 'warning') {
    segs.push(t('ui.verdictWarning', { count: counts.warning }));
    segs.push(t('ui.verdictInfo', { count: counts.info }));
  } else {
    segs.push(t('ui.verdictNeutral', { count: counts.info }));
  }
  headline.textContent = segs.join(I18n.getLocale() === 'en' ? ' / ' : ' ／ ');
  wrap.appendChild(headline);

  if (level === 'danger') {
    wrap.appendChild(el('p', {
      className: 'verdict-subtext verdict-subtext-strong',
      text: t('ui.verdictAction'),
    }));
  } else if (level === 'neutral') {
    // 過信防止文言（about-panelのdisclaimerと同じ趣旨をバナー内にも明示する）
    wrap.appendChild(el('p', {
      className: 'verdict-subtext',
      text: t('ui.verdictDisclaimer'),
    }));
  }

  if (dangerJumps.size > 0) wrap.appendChild(renderVerdictJumpLine(`${t('ui.severity.danger')}: `, dangerJumps));
  if (warningJumps.size > 0) wrap.appendChild(renderVerdictJumpLine(`${t('ui.severity.warning')}: `, warningJumps));

  return wrap;
}

function renderGlobalFindings(globalFindings) {
  if (globalFindings.length === 0) return null;
  const wrap = el('div', { className: 'global-findings' });
  for (const f of globalFindings) wrap.appendChild(renderFinding(f));
  return wrap;
}

/** 生成 SQL の 1 行目（コメント行を除く）を短く切ったプレビュー。折りたたんだままでも中身の見当がつくように */
function sqlPreview(sql) {
  const line = String(sql || '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('--')) || '';
  return line.length > 90 ? `${line.slice(0, 90)}…` : line;
}

/**
 * 折りたたみ式の SQL ブロック。見出し行にコピーボタンと 1 行プレビューを置き、開かなくてもコピーできる
 * （変換後の SQL でページが縦長になる、というしぐれさん指摘 2026-09-17。既定は全部閉じる）。
 */
function foldedSqlBlock(label, getSql, enabled, extraBody) {
  const wrap = el('details', { className: 'conversion-step conversion-fold' });
  const head = el('summary', { className: 'conversion-head' });
  head.appendChild(el('strong', { text: label }));
  const preview = el('span', { className: 'conversion-preview', text: sqlPreview(getSql()) });
  head.appendChild(preview);
  const button = el('button', { className: 'btn btn-copy', text: t('ui.copy'), attrs: { type: 'button' } });
  button.disabled = enabled === false;
  button.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); if (enabled !== false) copyToClipboard(getSql(), button); });
  head.appendChild(button); wrap.appendChild(head);
  if (extraBody) wrap.appendChild(extraBody);
  const pre = el('pre', { text: getSql() });
  wrap.appendChild(pre);
  return { wrap, pre, preview };
}

function sqlCopyBlock(label, sql, enabled) {
  return foldedSqlBlock(label, () => sql, enabled).wrap;
}

function appendByKeyChooser(card, sql, dialect, inspection) {
  const section = el('div', { className: 'conversion-step by-key-chooser' });
  section.appendChild(el('h3', { text: t('ui.byKeyTitle') }));
  const outputColumns = inspection.outputColumns.filter((x) => x.name && x.kind !== 'star');
  if (!outputColumns.length) {
    section.appendChild(el('p', { className: 'hint', text: t('ui.byKeyAddKey') }));
    card.appendChild(section); return;
  }
  const groupName = `by-key-target-${Date.now()}-${Math.random()}`;
  const tableField = el('fieldset', { className: 'by-key-field' });
  tableField.appendChild(el('legend', { text: t('ui.byKeyTargetTable') }));
  const radios = [];
  for (const table of inspection.tables) {
    const label = el('label', { className: 'column-choice' });
    const input = el('input', { attrs: { type: 'radio', name: groupName, value: table.name } });
    radios.push(input); label.append(input, document.createTextNode(table.alias ? `${table.name} (${table.alias})` : table.name));
    tableField.appendChild(label);
  }
  const otherLabel = el('label', { className: 'column-choice' });
  const otherRadio = el('input', { attrs: { type: 'radio', name: groupName, value: '__other__' } });
  const otherInput = el('input', { className: 'by-key-text', attrs: { type: 'text', 'aria-label': t('ui.byKeyOtherTable'), placeholder: t('ui.byKeyOtherTable') } });
  radios.push(otherRadio); otherLabel.append(otherRadio, document.createTextNode(t('ui.byKeyOther')), otherInput); tableField.appendChild(otherLabel);
  section.appendChild(tableField);

  const keyField = el('div', { className: 'by-key-field by-key-key-row' });
  const outputLabel = el('label', { text: t('ui.byKeyOutput') });
  const outputSelect = el('select');
  for (const column of outputColumns) outputSelect.appendChild(el('option', { text: column.name, attrs: { value: column.name } }));
  outputLabel.appendChild(outputSelect);
  const targetLabel = el('label', { text: t('ui.byKeyTargetKey') });
  const targetInput = el('input', { attrs: { type: 'text', value: outputSelect.value } });
  targetLabel.appendChild(targetInput); keyField.append(outputLabel, targetLabel); section.appendChild(keyField);
  // 前回の選択を復元（自動再描画で選択が消えないように）
  if (byKeyState.table) {
    const prev = radios.find((x) => x.value === byKeyState.table);
    if (prev) prev.checked = true;
  }
  if (byKeyState.other) otherInput.value = byKeyState.other;
  if (byKeyState.outputKey && outputColumns.some((c) => c.name === byKeyState.outputKey)) outputSelect.value = byKeyState.outputKey;
  targetInput.value = byKeyState.targetKey || outputSelect.value;
  const remember = () => {
    const selected = radios.find((x) => x.checked);
    byKeyState.table = selected ? selected.value : null;
    byKeyState.other = otherInput.value;
    byKeyState.outputKey = outputSelect.value;
    byKeyState.targetKey = targetInput.value.trim();
  };
  outputSelect.addEventListener('change', () => { targetInput.value = outputSelect.value; remember(); });
  otherInput.addEventListener('focus', () => { otherRadio.checked = true; remember(); });
  otherInput.addEventListener('input', remember);
  targetInput.addEventListener('input', remember);
  for (const r of radios) r.addEventListener('change', remember);

  const button = el('button', { className: 'btn btn-primary', text: t('ui.byKeyConvert'), attrs: { type: 'button' } });
  const result = el('div', { className: 'by-key-result' });
  button.addEventListener('click', () => {
    remember();
    byKeyState.converted = true;
    const selected = radios.find((x) => x.checked);
    const targetTable = selected && selected.value === '__other__' ? otherInput.value.trim() : (selected ? selected.value : '');
    if (!targetTable) { result.replaceChildren(el('p', { className: 'conversion-error', text: t('ui.byKeyChooseTable') })); return; }
    const converted = DmlBuilder.convertByKey(sql, {
      dialect, oracleVersion: els.oracleVersion.value, targetTable,
      outputKey: outputSelect.value, targetKey: targetInput.value.trim() || outputSelect.value,
    });
    result.replaceChildren();
    if (converted.status !== 'ok') {
      result.appendChild(el('p', { className: 'conversion-error', text: t(`dml.reason.${converted.reasonCode}`, converted.reasonParams) }));
      return;
    }
    appendConvertedStages(result, converted, dialect);
  });
  section.append(button, result); card.appendChild(section);
  // 一度変換したあとに SELECT を直した（例: 出力にキー列を足した）ときは、選択を保ったまま自動で作り直す
  if (byKeyState.converted && radios.some((x) => x.checked)) button.click();
}

// 生成した DELETE / UPDATE を本体の実行前チェックにかけ、問題があるときだけ最上部に「何が問題か・どう直せば通るか」を出す。
// danger（全行対象など）はコピーを止め、利用者が確認したときだけ有効にする（しぐれさん指摘 2026-09-20: 「危険と言われても直せなければ意味がない」）。
function appendConvertedStages(card, converted, dialect) {
  const checked = analyzeSQL([converted.delete, converted.update].join(String.fromCharCode(10)), dialect, { oracleVersion: els.oracleVersion.value });
  const seen = new Set();
  // `unfilled-placeholder` comes from the tool's own `<column> = <value>` template, not from the user's condition (same exclusion as the CLI).
  const issues = checked.statements.flatMap((s) => s.findings || [])
    .filter((f) => ['danger', 'warning'].includes(f.severity) && f.code !== 'unfilled-placeholder' && !seen.has(f.code) && seen.add(f.code));
  const dangers = issues.filter((f) => f.severity === 'danger');
  // Shared with the backup set below: the same original condition must be acknowledged there too.
  const gate = { dangers, acknowledged: false, listeners: [] };
  converted.dangerGate = gate;
  const body = el('div');
  if (issues.length) {
    const box = el('div', { className: `conversion-issues ${dangers.length ? 'conversion-issues-danger' : 'conversion-issues-warning'}` });
    box.appendChild(el('p', { className: 'conversion-issues-head', text: t(dangers.length ? 'ui.dmlIssuesDanger' : 'ui.dmlIssuesWarning') }));
    for (const f of issues) {
      const item = el('p', { className: 'conversion-issue' });
      item.appendChild(el('strong', { text: f.title }));
      item.appendChild(document.createTextNode(' ' + fixAdvice(f)));
      box.appendChild(item);
    }
    if (dangers.length) {
      const ack = el('label', { className: 'conversion-ack' });
      const input = el('input', { attrs: { type: 'checkbox' } });
      input.addEventListener('change', () => { gate.acknowledged = input.checked; render(); for (const fn of gate.listeners) fn(); });
      ack.append(input, document.createTextNode(t('ui.dmlAck')));
      box.appendChild(ack);
    }
    card.appendChild(box);
  }
  card.appendChild(body);
  function render() { body.replaceChildren(); renderConvertedBody(body, converted, dialect, !dangers.length || gate.acknowledged); }
  render();
  return card;
}

// 指摘コードごとの「こちらで直せないので、元の SELECT をこう直してほしい」の文。無ければ指摘文そのもの。
function fixAdvice(finding) {
  const messages = I18n.messages[I18n.getLocale() === 'en' ? 'en' : 'ja'];
  return messages[`dml.fix.${finding.code}`] || finding.message || messages['dml.fix.default'];
}

function renderConvertedBody(card, converted, dialect, allowed) {
  const proven = converted.equivalence === 'proven' && allowed;
  for (const code of converted.warnings || []) card.appendChild(el('p', { className: 'conversion-warning', text: t(`dml.warning.${code}`) }));
  card.appendChild(sqlCopyBlock(t('ui.stepOriginal'), converted.original, true));
  card.appendChild(sqlCopyBlock(t('ui.stepCount'), converted.countSelect, true));
  card.appendChild(sqlCopyBlock(t('ui.stepDelete'), converted.delete, proven));

  const choices = el('div', { className: 'column-candidates' });
  const selectedColumns = () => [...choices.querySelectorAll('input:checked')].map((x) => x.value);
  let currentUpdate = converted.update;
  const folded = foldedSqlBlock(t('ui.stepUpdate'), () => currentUpdate, proven, choices);
  const updatePre = folded.pre;
  const refreshUpdate = () => {
    currentUpdate = DmlBuilder.applyColumns(converted.update, selectedColumns());
    updatePre.textContent = currentUpdate;
    folded.preview.textContent = sqlPreview(currentUpdate);
  };
  for (const column of converted.columnCandidates) {
    const label = el('label', { className: 'column-choice' });
    const input = el('input', { attrs: { type: 'checkbox', value: column } });
    input.addEventListener('change', refreshUpdate);
    label.append(input, document.createTextNode(column)); choices.appendChild(label);
  }
  // 列候補があるときは UPDATE だけ開いておく（列を選ぶ操作がここにあるため）
  if (converted.columnCandidates.length) folded.wrap.open = true;
  card.appendChild(folded.wrap);

  const syntaxOk = Object.values(converted.syntaxCheck || {}).every((x) => x && x.ok);
  // Only problems are shown: a passing syntax check is not the user's concern.
  if (!syntaxOk) card.appendChild(el('p', { className: 'conversion-warning', text: t(converted.mode === 'by-key' ? 'ui.syntaxCheckWithFailed' : 'ui.syntaxCheckFailed') }));

  const safe = el('div', { className: 'conversion-step safe-actions' });
  // 何をコピーするのかを先に 1 行で（「安全実行の枠付き」では意味が伝わらない、というしぐれさん指摘 2026-09-17）
  safe.appendChild(el('p', { className: 'hint safe-intro', text: t('ui.safeIntro') }));
  const dmlLabel = el('label', { className: 'safe-dml-label', text: t('ui.safeDml') });
  const dmlChoice = el('select', { attrs: { 'aria-label': t('ui.safeDml') } });
  dmlChoice.appendChild(el('option', { text: 'UPDATE', attrs: { value: 'update' } }));
  dmlChoice.appendChild(el('option', { text: 'DELETE', attrs: { value: 'delete' } }));
  dmlLabel.appendChild(dmlChoice);
  safe.appendChild(dmlLabel);
  const client = el('select', { attrs: { 'aria-label': t('ui.client') } });
  for (const [value, key] of [['generic', 'ui.clientGeneric'], ['sqlplus-interactive', 'ui.clientInteractive'], ['sqlplus-batch', 'ui.clientBatch']]) client.appendChild(el('option', { text: t(key), attrs: { value } }));
  client.hidden = dialect !== 'oracle'; safe.appendChild(client);
  const safeText = (commit) => Templates.buildSafeBlock({
    dialect, client: client.value, originalSelect: converted.original, countSelect: converted.countSelect,
    dml: dmlChoice.value === 'delete' ? converted.delete : updatePre.textContent, locale: I18n.getLocale(), commit,
    // 更新する列が条件に含まれると更新後の確認 SELECT が 0 行になるので、列と条件を渡して注記を切り替える
    updatedColumns: dmlChoice.value === 'delete' ? [] : [...choices.querySelectorAll('input:checked')].map((input) => input.value),
    whereText: converted.where,
  });
  const rollbackButton = el('button', { className: 'btn btn-primary', text: t('ui.copySafeRollback'), attrs: { type: 'button' } });
  rollbackButton.disabled = !proven; rollbackButton.addEventListener('click', () => copyToClipboard(safeText(false), rollbackButton)); safe.appendChild(rollbackButton);
  const commitButton = el('button', { className: 'btn btn-ghost', text: t('ui.copySafeCommit'), attrs: { type: 'button' } });
  commitButton.disabled = !proven;
  commitButton.addEventListener('click', () => { if (globalThis.confirm(t('ui.commitConfirm'))) copyToClipboard(safeText(true), commitButton); }); safe.appendChild(commitButton);
  card.appendChild(safe);
  return card;
}

function appendBackupSet(card, sql, dialect, converted) {
  // Same gate as the converted stages: a full-table (or always-true) condition must be acknowledged before copying.
  const gate = converted.dangerGate;
  const allowed = () => !gate || !gate.dangers.length || gate.acknowledged;
  if (gate) gate.listeners.push(() => draw());
  const section = el('details', { className: 'conversion-step backup-set' });
  section.appendChild(el('summary', { className: 'conversion-head', text: t('dml.backup.title') }));
  const form = el('div', { className: 'backup-inputs' });
  const field = (label, input) => { const row = el('label', { className: 'backup-field' }); row.appendChild(el('span', { text: label })); row.appendChild(input); form.appendChild(row); return input; };
  const backupTable = field(t('dml.backup.backupTable'), el('input', { attrs: { type: 'text' } }));
  backupTable.value = DmlBuilder.backupName(converted.target.table, dialect);
  const operation = field(t('ui.safeDml'), el('select'));
  for (const name of ['delete', 'update']) operation.appendChild(el('option', { text: name.toUpperCase(), attrs: { value: name } }));
  const selected = { backupColumns: [], keyColumns: [] };
  for (const kind of ['backupColumns', 'keyColumns']) {
    const group = el('fieldset'); group.appendChild(el('legend', { text: t(`dml.backup.${kind}`) }));
    for (const column of converted.columnCandidates) {
      const label = el('label', { className: 'backup-choice' });
      const input = el('input', { attrs: { type: 'checkbox' } });
      input.addEventListener('change', () => { selected[kind] = [...group.querySelectorAll('input')].filter((x) => x.checked).map((x) => x.value); draw(); });
      input.value = column; label.appendChild(input); label.appendChild(el('span', { text: column })); group.appendChild(label);
    }
    form.appendChild(group);
  }
  const assignments = el('fieldset'); assignments.appendChild(el('legend', { text: t('dml.backup.assignments') }));
  const assignmentInputs = [];
  for (const column of converted.columnCandidates) {
    const row = el('label', { className: 'backup-choice' }), chosen = el('input', { attrs: { type: 'checkbox' } }), value = el('input', { attrs: { type: 'text', 'aria-label': `${column} =` } });
    row.appendChild(chosen); row.appendChild(el('span', { text: `${column} =` })); row.appendChild(value); assignments.appendChild(row);
    assignmentInputs.push({ column, chosen, value }); chosen.addEventListener('change', draw); value.addEventListener('input', draw);
  }
  form.appendChild(assignments); section.appendChild(form);
  const output = el('div'); section.appendChild(output); card.appendChild(section);
  function draw() {
    assignments.hidden = operation.value !== 'update'; output.replaceChildren();
    if (!allowed()) output.appendChild(el('p', { className: 'conversion-warning', text: t('ui.backupBlocked') }));
    output.appendChild(el('p', { className: 'conversion-warning', text: t(`dml.backup.${dialect === 'postgres' ? 'planned' : 'reference'}`) }));
    const r = DmlBuilder.backupSet(sql, { dialect, shape: 'single', backupTable: backupTable.value, ...selected, to: operation.value, assignments: operation.value === 'update' ? assignmentInputs.filter((x) => x.chosen.checked).map((x) => ({ column: x.column, value: x.value.value })) : [], locale: I18n.getLocale() });
    if (r.status !== 'ok') {
      for (const reason of r.reasonCodes) output.appendChild(el('p', { className: 'conversion-error', text: `[${reason}] ${t(`dml.reason.${reason}`)}` }));
      output.appendChild(sqlCopyBlock(t('dml.backup.title'), '', false)); return;
    }
    for (const warning of r.warnings) output.appendChild(el('p', { className: 'hint', text: warning }));
    const append = (parent, stage, commit, always) => {
      // Everything except ROLLBACK is blocked while the original condition's danger is unacknowledged.
      const block = foldedSqlBlock(stage.title, () => stage.sql, always || allowed());
      // The conditions stay visible in the summary without opening the SQL body (shown once, not repeated inside).
      block.wrap.querySelector('summary').appendChild(el('span', { className: 'backup-condition', text: `${stage.passCondition} ${stage.onFail}` }));
      if (commit) block.wrap.querySelector('button').textContent = t(commit === 'comp' ? 'dml.backup.copyCompCommit' : 'dml.backup.copyCommit');
      block.wrap.querySelector('button').addEventListener('click', () => block.wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
      parent.appendChild(block.wrap);
    };
    for (const name of ['prepare', 'precheck', 'backup', 'change']) append(output, r.stages[name]);
    const finish = (parent, stages, kind = 'main') => {
      append(parent, stages.rollback, undefined, true);
      const commit = el('details', { className: 'conversion-step' }); commit.appendChild(el('summary', { className: 'conversion-head', text: t('dml.backup.confirmCommit') }));
      append(commit, stages.commit, kind); parent.appendChild(commit);
    };
    finish(output, r.stages.finish);
    const comp = el('details', { className: 'conversion-step' }); comp.appendChild(el('summary', { className: 'conversion-head', text: t('dml.backup.compensation') }));
    comp.appendChild(el('p', { className: 'conversion-warning', text: t('dml.backup.identity') }));
    append(comp, r.compensation.precheck); append(comp, r.compensation.apply); finish(comp, r.compensation.finish, 'comp'); output.appendChild(comp);
  }
  backupTable.addEventListener('input', draw); operation.addEventListener('change', draw);
  section.addEventListener('toggle', () => { if (section.open) section.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
  draw();
}

function renderDmlBuilder(sql, dialect) {
  const converted = DmlBuilder.convert(sql, { dialect, oracleVersion: els.oracleVersion.value });
  const inspection = DmlBuilder.inspect(sql, { dialect });
  const card = el('details', { className: 'statement-card conversion-card', attrs: { open: '' } });
  card.appendChild(el('summary', { className: 'conversion-title', text: t('ui.buildDml') }));
  const byKeyAvailable = inspection.status === 'ok' && (converted.status !== 'ok' || inspection.tables.length > 1);
  if (converted.status === 'ok') {
    appendConvertedStages(card, converted, dialect);
    appendBackupSet(card, sql, dialect, converted);
    if (byKeyAvailable) appendByKeyChooser(card, sql, dialect, inspection);
    return card;
  }
  const reasonCodes = converted.reasonCodes || [converted.reasonCode];
  if (byKeyAvailable) {
    // 単一テーブル版が使えなくても「キー IN 形」で変換できる。導線を主役にし、使えない理由は折りたたみに降ろす
    // （赤い「変換できません」が先頭にあると非対応に見える、というしぐれさんの指摘 2026-09-16）。
    card.appendChild(el('p', { className: 'conversion-lead', text: t('ui.byKeyLead') }));
    appendByKeyChooser(card, sql, dialect, inspection);
    // 直す必要のない情報なので、折りたたまず・赤くせず、灰色の 1 段落で（折りたたむと「直せ」に見える、というしぐれさん指摘 2026-09-20）
    const why = el('div', { className: 'conversion-step conversion-why' });
    why.appendChild(el('p', { className: 'hint', text: t('ui.singleTableSkipped') }));
    why.appendChild(el('p', { className: 'hint conversion-why-list', text: reasonCodes.map((code) => t(`dml.reason.${code}`, converted.reasonParams)).join(' ') }));
    card.appendChild(why);
    return card;
  }
  // どちらの経路も使えない: 直す必要があるので、赤字で開いたまま出し、どう直すかを添える
  for (const code of reasonCodes) card.appendChild(el('p', { className: 'conversion-error', text: t(`dml.reason.${code}`, converted.reasonParams) }));
  card.appendChild(el('p', { className: 'hint', text: t('dml.hint.singleTableOnly') }));
  return card;
}

function render() {
  const sql = els.input.value;
  const selectedDialect = els.dialect.value;

  els.results.innerHTML = '';

  if (!sql || sql.trim().length === 0) {
    els.results.appendChild(el('p', { className: 'empty-state', text: t('ui.empty') }));
    return;
  }

  // 機能B: セレクタが「自動判定」のときだけ検出を実行し、実際の解析には
  // 検出結果が指す具体的な方言（oracle/mssql/mysql/postgres/generic）を使う。
  // セレクタを手動で具体的な方言に変更した場合は、従来通りその方言をそのまま
  // 使う（自動判定は一切介入しない＝手動優先）。
  let dialect = selectedDialect;
  let autoDetection = null;
  if (selectedDialect === 'auto') {
    autoDetection = typeof detectDialect === 'function' ? detectDialect(sql) : null;
    dialect = (autoDetection && autoDetection.dialect) || 'generic';
  }

  const result = analyzeSQL(sql, dialect, { oracleVersion: els.oracleVersion.value });

  if (result.statements.length === 0) {
    els.results.appendChild(el('p', { className: 'empty-state', text: t('ui.noValidSql') }));
    return;
  }

  if (autoDetection && autoDetection.reason === 'parse-success-ambiguous') {
    // 複数方言のパーサで解析に成功したANSI互換SQLの可能性が高いケース。
    // AST解析のためにmysqlへ解決してはいるが「mysqlだと言い切れる根拠」は
    // 無いため、mysql固有のTips（LIMIT句の案内）だけは表示しない。
    // 判定バナーの件数もこのfindingsを見て集計するため、バナーを組み立てる
    // 前に必ずフィルタしておく。
    for (const stmt of result.statements) {
      stmt.findings = stmt.findings.filter((f) => f.code !== 'mysql-no-limit');
      if (stmt.plsql) {
        for (const item of stmt.plsql.items) {
          item.findings = item.findings.filter((f) => f.code !== 'mysql-no-limit');
        }
      }
    }
  }

  // 判定バナー: 結果エリアの一番先頭（textareaの直下）に常に表示する。
  // プロダクトオーナー指摘「スクロールしないと全部見きれない」への対応で、
  // 危険/注意/情報の件数がスクロールなしで即わかることを最優先する。
  // SELECT 1 文なら「更新文を作る」はボタンを押さなくても自動で出す（貼るだけで次の一手が見える）
  const autoDml = result.statements.length === 1 && result.statements[0].kind === 'SELECT';
  if (showDmlBuilder || autoDml) els.results.appendChild(renderDmlBuilder(sql, dialect));
  els.results.appendChild(renderVerdictBanner(result));

  if (autoDetection) {
    els.results.appendChild(renderAutoDialectNotice(autoDetection, dialect));
  }

  els.results.appendChild(renderAnalysisBadge(result));

  if (result.overview) {
    els.results.appendChild(renderOverview(result.overview));
  }

  const globalNode = renderGlobalFindings(result.globalFindings);
  if (globalNode) els.results.appendChild(globalNode);

  for (const stmt of result.statements) {
    els.results.appendChild(renderStatementCard(stmt, result.dialect));
  }
}

function scheduleAutoAnalyze() {
  showDmlBuilder = false;
  refreshControls();
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(render, 350);
}

els.analyzeBtn.addEventListener('click', render);
els.buildDmlBtn.addEventListener('click', () => {
  showDmlBuilder = true;
  render();
  // 押したらカードまでスクロールする（結果が下にあるのに気づけない、というしぐれさん指摘）
  const card = els.results.querySelector('.conversion-card');
  if (card && typeof card.scrollIntoView === 'function') card.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
function refreshControls() {
  els.oracleVersionWrap.hidden = els.dialect.value !== 'oracle';
  const result = analyzeSQL(els.input.value, els.dialect.value === 'auto' ? 'generic' : els.dialect.value, { oracleVersion: els.oracleVersion.value });
  const enabled = result.statements.length === 1 && result.statements[0].kind === 'SELECT';
  els.buildDmlBtn.disabled = !enabled;
  els.buildDmlBtn.title = enabled ? '' : t('ui.buildDmlDisabled');
}
els.dialect.addEventListener('change', () => { showDmlBuilder = false; refreshControls(); render(); });
els.oracleVersion.addEventListener('change', render);
els.input.addEventListener('input', scheduleAutoAnalyze);
els.clearBtn.addEventListener('click', () => {
  els.input.value = '';
  showDmlBuilder = false;
  refreshControls();
  render();
  els.input.focus();
});
const TEMPLATE_KINDS = ['update', 'delete', 'insert-select', 'upsert', 'merge', 'create-table', 'safe-block', 'backup-table', 'compensate-update', 'compensate-delete'];
for (const kind of TEMPLATE_KINDS) {
  const button = el('button', { className: 'btn btn-ghost', text: t(`ui.template.${kind}`), attrs: { type: 'button' } });
  button.addEventListener('click', () => {
    const dialect = els.dialect.value === 'auto' ? 'generic' : els.dialect.value;
    els.templateTitle.textContent = t(`ui.template.${kind}`);
    els.templateSql.textContent = Templates.get(kind, dialect, { oracleVersion: els.oracleVersion.value, locale: I18n.getLocale() });
    els.templatePreview.hidden = false;
  });
  els.templateButtons.appendChild(button);
}
els.templateCopy.addEventListener('click', () => copyToClipboard(els.templateSql.textContent, els.templateCopy));
// 記事などから「この SQL で試す」リンクで直接結果まで飛べるようにする（#sql=<encodeURIComponent した SQL>&dialect=<方言>）。
// URL のハッシュ部分はサーバーに送られないので、SQL を外部に出さない方針と両立する。値はテキストとして textarea に入れるだけ。
// 初回表示でだけ適用する（hashchange で再適用すると、編集中の SQL が結果内リンクや「戻る」で消えるため）。
const HASH_SQL_MAX = 20000;
function applyHashSql() {
  const hash = (globalThis.location && globalThis.location.hash || '').replace(/^#/, '');
  if (!hash) return false;
  const params = new URLSearchParams(hash);
  const sql = params.get('sql');
  if (sql === null) return false;
  if (sql.length > HASH_SQL_MAX) {
    // 切り詰めず、貼り付けを案内する（長い SQL はリンク向きではない）
    els.input.parentNode.insertBefore(el('p', { className: 'conversion-warning', text: t('ui.hashTooLong', { max: HASH_SQL_MAX }) }), els.input);
    return false;
  }
  // 方言は省略・不正値なら auto に固定し、前の選択を引き継がない（同じリンクは同じ結果になる）
  const dialect = params.get('dialect');
  els.dialect.value = dialect && [...els.dialect.options].some((o) => o.value === dialect) ? dialect : 'auto';
  els.input.value = sql;
  showDmlBuilder = false;
  refreshControls();
  return true;
}
refreshControls();
applyHashSql();
// 初期表示
render();
