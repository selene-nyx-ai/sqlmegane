// SQLMegane（SQLめがね） app.js
// UIとanalyzer.jsを結線するだけの薄い層。解析ロジックは一切ここに書かない。
//
// file:// 直開き時のCORS制限によりESMのimportが機能しないため、通常の
// スクリプトとして読み込み、先に読み込まれた js/analyzer.js が公開する
// globalThis.SQLMeganeAnalyzer から関数を取得する（経緯はREADME.md /
// docs/architecture.md を参照）。index.html側で analyzer.js → app.js の
// 順に読み込むことで、この時点で SQLMeganeAnalyzer が必ず定義済みであることを
// 保証している。

const { analyzeSQL } = globalThis.SQLMeganeAnalyzer;

const els = {
  input: document.getElementById('sql-input'),
  dialect: document.getElementById('dialect-select'),
  analyzeBtn: document.getElementById('analyze-btn'),
  clearBtn: document.getElementById('clear-btn'),
  results: document.getElementById('results'),
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
  BEGIN_TX: 'BEGIN / トランザクション開始',
  END_TX: 'COMMIT / ROLLBACK',
  OTHER: 'その他',
};

const SEVERITY_LABELS = { danger: '危険', warning: '注意', info: '情報' };

const DIALECT_LABELS = {
  generic: '汎用',
  oracle: 'Oracle',
  mssql: 'SQL Server',
  mysql: 'MySQL',
  postgres: 'PostgreSQL',
};

const PARSER_LABELS = {
  mysql: 'MySQL',
  postgresql: 'PostgreSQL',
  transactsql: 'SQL Server (T-SQL)',
};

let debounceTimer = null;

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
    wrap.appendChild(el('span', { className: 'severity-chip ok', text: '危険の検出なし' }));
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
    btn.textContent = 'コピーしました';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('copied');
    }, 1600);
  } catch (e) {
    btn.textContent = 'コピーに失敗しました';
    setTimeout(() => { btn.textContent = 'コピー'; }, 1600);
  }
}

/**
 * 検算SELECTのカード。JOINを含む場合（hasJoin）は、表示件数が「結合行数」であり
 * 1対多のJOINでは実際の更新・削除対象の行数より大きくなりうることを、ラベルと
 * 注記の両方で明示する（生成SQL自体にも同内容のコメントが入っている）。
 */
function renderVerifySelect(sql, hasJoin) {
  const wrap = el('div', { className: 'verify-select' });
  const head = el('div', { className: 'verify-select-head' });
  const labelText = hasJoin
    ? '検算SELECT（実行前に対象件数を確認・JOINのため結合行数です）'
    : '検算SELECT（実行前に対象件数を確認）';
  head.appendChild(el('span', { className: 'verify-select-label', text: labelText }));
  const copyBtn = el('button', { className: 'btn btn-copy', text: 'コピー', attrs: { type: 'button' } });
  copyBtn.addEventListener('click', () => copyToClipboard(sql, copyBtn));
  head.appendChild(copyBtn);
  wrap.appendChild(head);
  if (hasJoin) {
    wrap.appendChild(el('p', {
      className: 'verify-select-note',
      text: '※JOINを含むため結合行数です。1対多の結合では実際の更新行数より大きくなることがあります。',
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

function renderSummary(summary) {
  const card = el('div', { className: 'stmt-summary' });
  const head = el('div', { className: 'summary-head' });
  head.appendChild(el('span', { className: 'summary-label', text: 'このSQLがすること' }));
  head.appendChild(el('span', { className: 'summary-op', text: summary.op }));
  card.appendChild(head);
  card.appendChild(el('p', { className: 'summary-headline', text: summary.headline }));
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
  const where = line != null ? `（位置: 行${line}）` : '';
  const note = el('div', { className: 'parse-notice' });
  note.appendChild(el('span', { className: 'parse-notice-badge', text: '簡易チェック' }));
  note.appendChild(el('span', {
    text: `構文解析に失敗したため簡易チェックで表示しています${where}。日本語要約は表示されず、検出も正規表現ベースの簡易判定になります。`,
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
  const selectedLabel = DIALECT_LABELS[dialect] || dialect;
  const fallbackLabel = PARSER_LABELS[parse.parserDialect] || parse.parserDialect;
  const err = parse.primaryError;
  const line = err && err.globalLine != null ? err.globalLine : (err ? err.line : null);
  const where = line != null ? `（位置: 行${line}）` : '';
  const note = el('div', { className: 'parse-notice parse-notice-warning' });
  note.appendChild(el('span', { className: 'parse-notice-badge', text: '⚠ 方言不一致' }));
  note.appendChild(el('span', {
    text: `選択した方言（${selectedLabel}）では構文エラーです${where}。別方言（${fallbackLabel}）として解釈した参考表示です。このSQLは選択した方言では実行できない可能性があります。`,
  }));
  return note;
}

function renderStatementCard(stmt, dialect) {
  const card = el('div', { className: 'stmt-card', attrs: { id: `stmt-${stmt.number}` } });

  const headRow = el('div', { className: 'stmt-card-head' });
  const title = el('div', { className: 'stmt-title' });
  title.appendChild(el('span', { className: 'stmt-number', text: `文 ${stmt.number}` }));
  title.appendChild(el('span', { className: 'stmt-kind', text: KIND_LABELS[stmt.kind] || stmt.kind }));
  headRow.appendChild(title);
  renderSeverityChips(headRow, countBySeverity(stmt.findings));
  card.appendChild(headRow);

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
  } else {
    const note = el('div', { className: 'no-findings-note' });
    note.appendChild(document.createTextNode('明らかな危険は検出されませんでした'));
    const small = el('small', { text: '（検出できない危険もあります。最終判断は必ず人間が行ってください）' });
    note.appendChild(small);
    card.appendChild(note);
  }

  if (stmt.verifySelect) {
    card.appendChild(renderVerifySelect(stmt.verifySelect, !!stmt.verifySelectHasJoin));
  }

  return card;
}

// ---------------------------------------------------------------------------
// 解析レベルのバッジ（方言によってASTか簡易チェックかが変わることを明示する）
// ---------------------------------------------------------------------------

function renderAnalysisBadge(result) {
  const wrap = el('div', { className: 'analysis-level' });
  const dialectLabel = DIALECT_LABELS[result.dialect] || result.dialect;

  if (result.analysis && result.analysis.astSupported) {
    wrap.appendChild(el('span', { className: 'analysis-badge ast', text: '構文解析あり' }));
    const fb = result.analysis.fallbackStatements;
    wrap.appendChild(el('span', {
      className: 'analysis-note',
      text: fb > 0
        ? `${dialectLabel} のパーサでSQLを解析し、日本語で要約しています（${fb}文はパースできず簡易チェックに切り替えました）。`
        : `${dialectLabel} のパーサでSQLを解析し、日本語で要約しています。`,
    }));
  } else {
    wrap.appendChild(el('span', { className: 'analysis-badge simple', text: '簡易チェック（構文解析なし）' }));
    wrap.appendChild(el('span', {
      className: 'analysis-note',
      text: `${dialectLabel} は同梱パーサが対応していないため、正規表現ベースの簡易チェックのみを行います（日本語要約は表示されません）。MySQL / PostgreSQL / SQL Server を選ぶと構文解析付きで確認できます。`,
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
    if (counts[kind]) parts.push(`${KIND_LABELS[kind] || kind} ${counts[kind]}件`);
  }
  if (others > 0) parts.push(`その他 ${others}件`);
  return parts.join(' / ');
}

function renderOverview(overview) {
  const card = el('div', { className: 'overview-card' });
  card.appendChild(el('h2', { className: 'overview-title', text: 'スクリプト全体のサマリ' }));

  card.appendChild(el('p', {
    className: 'overview-line',
    text: `全${overview.total}文（${overviewCountsText(overview.counts)}）。うち破壊的操作は ${overview.destructiveCount}件です。`,
  }));

  card.appendChild(el('p', {
    className: 'overview-line',
    text: overview.tables.length > 0
      ? `触るテーブル: ${overview.tables.join(' / ')}`
      : '触るテーブル: 特定できませんでした',
  }));

  if (overview.warnedStatements.length > 0) {
    const line = el('p', { className: 'overview-line overview-warned' });
    line.appendChild(document.createTextNode('⚠ 警告のある文: '));
    overview.warnedStatements.forEach((num, i) => {
      if (i > 0) line.appendChild(document.createTextNode(', '));
      const a = el('a', { className: 'overview-link', text: `#${num}`, attrs: { href: `#stmt-${num}` } });
      line.appendChild(a);
    });
    card.appendChild(line);
  } else {
    card.appendChild(el('p', { className: 'overview-line', text: '危険・注意レベルの検出があった文はありません（検出できない危険もあります）。' }));
  }

  if (overview.fallbackStatements.length > 0) {
    card.appendChild(el('p', {
      className: 'overview-line',
      text: `構文解析できず簡易チェックになった文: ${overview.fallbackStatements.map((n) => `#${n}`).join(', ')}`,
    }));
  }

  return card;
}

function renderGlobalFindings(globalFindings) {
  if (globalFindings.length === 0) return null;
  const wrap = el('div', { className: 'global-findings' });
  for (const f of globalFindings) wrap.appendChild(renderFinding(f));
  return wrap;
}

function render() {
  const sql = els.input.value;
  const dialect = els.dialect.value;

  els.results.innerHTML = '';

  if (!sql || sql.trim().length === 0) {
    els.results.appendChild(el('p', { className: 'empty-state', text: 'SQLを貼り付けると、ここに解析結果が表示されます。' }));
    return;
  }

  const result = analyzeSQL(sql, dialect);

  if (result.statements.length === 0) {
    els.results.appendChild(el('p', { className: 'empty-state', text: '有効なSQL文が見つかりませんでした。' }));
    return;
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
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(render, 350);
}

els.analyzeBtn.addEventListener('click', render);
els.dialect.addEventListener('change', render);
els.input.addEventListener('input', scheduleAutoAnalyze);
els.clearBtn.addEventListener('click', () => {
  els.input.value = '';
  render();
  els.input.focus();
});
// 初期表示
render();
