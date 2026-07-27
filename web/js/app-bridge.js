/* ============ LOKÁL vs. SERVER — přepínání bez změny jádra ============ */
(function () {
  const _origInit = init;
  const _origHandleLogout = handleLogout;
  const _origHandleLogin = handleLogin;
  const _origGetGeminiKey = getGeminiKey;

  window.NA_RUNTIME = { server: false, session: null, aiProviders: ['gemini'], modulesRev: 0, syncTimer: null, beatTimer: null };

  function naDemoAllowed() {
    if (window.NA_BOOT && window.NA_BOOT.demoMode) return true;
    if (location.protocol === 'file:') return true;
    const host = location.hostname || '';
    return host === 'localhost' || host === '127.0.0.1';
  }

  function naConfigureServerUI() {
    const tile = document.getElementById('geminiKeyTile');
    if (tile) tile.style.display = 'none';
    const _origRenderOb = typeof renderObStep === 'function' ? renderObStep : null;
    if (_origRenderOb) {
      renderObStep = function () {
        _origRenderOb();
        const s2 = document.getElementById('obStep2');
        if (s2) {
          s2.innerHTML = '<div class="conf-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></div>' +
            '<h2 class="conf-t">AI klíče spravuje administrátor</h2>' +
            '<p class="conf-d">Na serveru jsou Gemini, Claude a Grok klíče uloženy jen v administraci (<a href="/admin/" style="color:var(--am2)">/admin/</a> → API klíče). Do aplikace se neukládají.</p>';
        }
      };
    }
    if (typeof obNext === 'function') {
      const _origObNext = obNext;
      obNext = function () {
        if (obStep === 1) { obStep = 3; renderObStep(); return; }
        _origObNext();
      };
    }
    if (typeof obPrev === 'function') {
      const _origObPrev = obPrev;
      obPrev = function () {
        if (obStep === 3) { obStep = 1; renderObStep(); return; }
        _origObPrev();
      };
    }
  }

  function naBlockLocalDemo() {
    handleLogin = function () {
      const err = document.getElementById('loginError');
      if (err) err.textContent = 'Přihlášení vyžaduje server. Kontaktujte administrátora nebo zkuste později.';
    };
    const hint = document.querySelector('.login-beta-hint');
    if (hint) {
      hint.textContent = 'Přihlášení probíhá přes zabezpečený server — použijte účet od administrátora.';
      hint.style.display = '';
    }
  }

  async function naApi(path, opts) {
    opts = opts || {};
    const r = await fetch('/api/' + path, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {}),
      body: opts.body || null
    });
    let data = {};
    try { data = await r.json(); } catch (e) { /* prázdná odpověď */ }
    if (!r.ok) throw new Error(data.error || data.message || ('Chyba serveru (' + r.status + ')'));
    return data;
  }

  async function naServerAvailable() {
    if (location.protocol === 'file:' || !location.hostname) return false;
    try {
      const r = await fetch('/api/ping.php', { credentials: 'same-origin' });
      if (!r.ok) return false;
      const data = await r.json();
      return !!(data && data.ok);
    } catch (e) {
      return false;
    }
  }

  async function ensureLawsFromServer() {
    if (document.getElementById('law-tz')) return;
    try {
      const [tz, tr] = await Promise.all([
        fetch('data/law-tz.json').then(function (r) { return r.json(); }),
        fetch('data/law-tr.json').then(function (r) { return r.json(); })
      ]);
      lawData = { tz: tz, tr: tr };
    } catch (e) {
      console.error('Načtení zákonů selhalo:', e);
      lawData = { tz: [], tr: [] };
    }
  }

  function naCollectUsageStats() {
    const cases = (appData.cases || []).length;
    const clients = (appData.clients || []).length;
    let analyses = 0;
    (appData.cases || []).forEach(function (c) { analyses += (c.analyses || []).length; });
    return { cases: cases, clients: clients, analyses: analyses, page: currentPage || 'dashboard' };
  }

  function naApplyRemoteUser(user, modulesRev, silent) {
    const prev = (currentUser && currentUser.modules) ? currentUser.modules.slice().sort().join(',') : '';
    currentUser = user;
    window.NA_RUNTIME.session = user;
    window.NA_RUNTIME.modules = user.modules || null;
    if (typeof modulesRev === 'number') window.NA_RUNTIME.modulesRev = modulesRev;
    if (typeof applyUserModules === 'function') applyUserModules(user.modules);
    const next = (user.modules || []).slice().sort().join(',');
    if (!silent && prev && prev !== next && typeof toast === 'function') {
      toast('Služby účtu byly aktualizovány administrátorem.');
    }
  }

  async function naSyncSession(silent) {
    if (!window.NA_RUNTIME.server || !currentUser) return;
    try {
      const res = await naApi('auth/me.php');
      if (res.user) naApplyRemoteUser(res.user, res.modules_rev, !!silent);
    } catch (e) {
      if (!silent && typeof toast === 'function') toast('Účet byl deaktivován — odhlašuji.');
      if (typeof handleLogout === 'function') handleLogout();
    }
  }

  async function naSendHeartbeat() {
    if (!window.NA_RUNTIME.server || !currentUser) return;
    try {
      const res = await naApi('usage/heartbeat.php', {
        method: 'POST',
        body: JSON.stringify(naCollectUsageStats())
      });
      if (typeof res.modules_rev === 'number' && res.modules_rev !== window.NA_RUNTIME.modulesRev) {
        await naSyncSession(true);
      }
    } catch (e) { /* tichý fallback */ }
  }

  function naStartRemoteSync() {
    if (window.NA_RUNTIME.syncTimer) clearInterval(window.NA_RUNTIME.syncTimer);
    if (window.NA_RUNTIME.beatTimer) clearInterval(window.NA_RUNTIME.beatTimer);
    naSendHeartbeat();
    window.NA_RUNTIME.syncTimer = setInterval(function () {
      if (document.hidden) return;
      naSyncSession(true);
    }, 45000);
    window.NA_RUNTIME.beatTimer = setInterval(naSendHeartbeat, 180000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) naSyncSession(true);
    });
  }

  function applyLoggedInUser(user, modulesRev) {
    currentUser = user;
    window.NA_RUNTIME.session = user;
    window.NA_RUNTIME.modules = user.modules || null;
    if (typeof modulesRev === 'number') window.NA_RUNTIME.modulesRev = modulesRev;
    else if (user.modules_rev) window.NA_RUNTIME.modulesRev = user.modules_rev;
    const initials = user.name.split(' ').slice(-2).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
    document.getElementById('avatar').textContent = initials;
    const sun = document.getElementById('sidebarUserName');
    if (sun) sun.textContent = user.name.replace(/^JUDr\.?\s*/, '');
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('appWrap').classList.remove('app-hidden');
    document.getElementById('vzhledWrap').style.display = '';
    if (typeof applyUserModules === 'function') applyUserModules(user.modules);
    renderAll();
    maybeShowConfidentialityGate();
    naStartRemoteSync();
  }

  async function naTryRestoreSession() {
    try {
      const res = await naApi('auth/me.php');
      if (res.user) applyLoggedInUser(res.user, res.modules_rev);
      if (res.aiProviders) window.NA_RUNTIME.aiProviders = res.aiProviders;
    } catch (e) { /* nepřihlášen */ }
  }

  function enableServerBridge() {
    handleLogin = async function () {
      const u = document.getElementById('loginUsername').value.trim();
      const p = document.getElementById('loginPassword').value.trim();
      const err = document.getElementById('loginError');
      err.textContent = '';
      try {
        const res = await naApi('auth/login.php', { method: 'POST', body: JSON.stringify({ username: u, password: p }) });
        if (res.redirect) { location.href = res.redirect; return; }
        if (res.aiProviders) window.NA_RUNTIME.aiProviders = res.aiProviders;
        applyLoggedInUser(res.user, res.modules_rev);
      } catch (e) {
        err.textContent = e.message || 'Nesprávné jméno nebo heslo.';
      }
    };

    handleLogout = async function () {
      try { await naApi('auth/logout.php', { method: 'POST', body: '{}' }); } catch (e) { /* ignore */ }
      window.NA_RUNTIME.session = null;
      if (window.NA_RUNTIME.syncTimer) clearInterval(window.NA_RUNTIME.syncTimer);
      if (window.NA_RUNTIME.beatTimer) clearInterval(window.NA_RUNTIME.beatTimer);
      _origHandleLogout();
    };

    getGeminiUrl = function (stream) {
      return '/api/ai/gemini.php' + (stream ? '?stream=1' : '');
    };

    getGeminiKey = function () {
      if (window.NA_RUNTIME.aiProviders.indexOf('gemini') >= 0) return 'server-proxy';
      return '';
    };

    geminiFetch = async function (body, stream) {
      const overloadWaits = [2500, 5000, 10000, 18000, 28000];
      let lastMsg = '';
      for (let attempt = 0; attempt < 8; attempt++) {
        let r;
        try {
          r = await fetch(getGeminiUrl(stream), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: activeGeminiModel(), body: body, stream: !!stream })
          });
        } catch (netErr) {
          lastMsg = 'Síť: ' + netErr.message;
          if (attempt < 7) { toast('Výpadek sítě — zkouším znovu…'); await _sleep(3000); continue; }
          throw new Error(lastMsg);
        }
        if (r.status === 429 || r.status === 503) {
          lastMsg = 'Přetížení AI (' + r.status + ')';
          if (geminiModelIdx < GEMINI_MODELS.length - 1) { geminiModelIdx++; toast('Přepínám na ' + activeGeminiModel() + '…'); }
          await _sleep(overloadWaits[Math.min(attempt, overloadWaits.length - 1)]);
          continue;
        }
        if (!r.ok) {
          let msg = lastMsg;
          try { const j = await r.json(); msg = j.error || msg; } catch (e) { /* */ }
          throw new Error(msg || ('Gemini chyba ' + r.status));
        }
        return r;
      }
      throw new Error(lastMsg || 'Gemini nedostupné');
    };

    // OPRAVA tlačítka: app-core připnul #loginBtn na offline demo handleLogin
    // dřív, než se přepnulo na serverové přihlášení. Tady tlačítko přepneme
    // na aktuální handleLogin (klon smaže starý listener).
    (function () {
      const btn = document.getElementById('loginBtn');
      if (!btn) return;
      const fresh = btn.cloneNode(true);
      btn.parentNode.replaceChild(fresh, btn);
      fresh.addEventListener('click', function () { handleLogin(); });
    })();
  }

  init = async function () {
    await ensureLawsFromServer();
    _origInit();

    const serverOk = await naServerAvailable();
    window.NA_RUNTIME.server = serverOk;

    if (serverOk) {
      enableServerBridge();
      naConfigureServerUI();
      await naTryRestoreSession();
    } else if (naDemoAllowed()) {
      console.info('Advokato: lokální demo režim (advokat / 123456).');
      let hint = document.querySelector('.login-beta-hint');
      if (!hint) {
        hint = document.createElement('div');
        hint.className = 'login-beta-hint';
        const card = document.querySelector('.lcard');
        if (card) card.appendChild(hint);
      }
      hint.innerHTML = 'Demo režim (bez PHP): <code>advokat</code> / <code>123456</code>';
    } else {
      naBlockLocalDemo();
    }
  };
})();