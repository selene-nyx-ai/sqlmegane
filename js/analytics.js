// SQL を読み込んで URL から除去した後だけ、任意のアクセス集計を開始する。
(function () {
  let initialized = false;

  function initialize(win, doc, readHash) {
    if (initialized) return false;
    initialized = true;

    function stripHash() {
      try {
        if (win.location.hash) {
          win.history.replaceState(win.history.state, '', win.location.pathname + win.location.search);
        }
        return !win.location.hash;
      } catch (e) {
        // URL を安全にできない環境では beacon を読み込まない。
        return false;
      }
    }

    // 後から付いたハッシュも除去する。SQL の再適用・beacon の再挿入はしない。
    win.addEventListener('hashchange', stripHash);
    let clean;
    try {
      readHash();
    } finally {
      clean = stripHash();
    }
    if (!clean || !win.SQLMEGANE_CF_TOKEN) return false;

    const script = doc.createElement('script');
    script.src = 'https://static.cloudflareinsights.com/beacon.min.js';
    script.async = true;
    script.setAttribute('data-cf-beacon', JSON.stringify({ token: win.SQLMEGANE_CF_TOKEN, spa: false }));
    doc.head.appendChild(script);
    return true;
  }

  globalThis.SQLMeganeAnalytics = { initialize };
})();
