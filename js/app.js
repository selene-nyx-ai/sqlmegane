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

function renderVerifySelect(sql) {
  const wrap = el('div', { className: 'verify-select' });
  const head = el('div', { className: 'verify-select-head' });
  head.appendChild(el('span', { className: 'verify-select-label', text: '検算SELECT（実行前に対象件数を確認）' }));
  const copyBtn = el('button', { className: 'btn btn-copy', text: 'コピー', attrs: { type: 'button' } });
  copyBtn.addEventListener('click', () => copyToClipboard(sql, copyBtn));
  head.appendChild(copyBtn);
  wrap.appendChild(head);
  const pre = el('pre');
  pre.textContent = sql;
  wrap.appendChild(pre);
  return wrap;
}

function renderStatementCard(stmt) {
  const card = el('div', { className: 'stmt-card' });

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
    card.appendChild(renderVerifySelect(stmt.verifySelect));
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

  const globalNode = renderGlobalFindings(result.globalFindings);
  if (globalNode) els.results.appendChild(globalNode);

  for (const stmt of result.statements) {
    els.results.appendChild(renderStatementCard(stmt));
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
