/* UnGlutened — front-end controller (vanilla JS, no build step).
   Talks to the same-origin API with credentials. Matches CONTRACT field names exactly. */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Tiny helpers
  // ---------------------------------------------------------------------------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));
  const el = (tag, attrs, kids) => {
    const n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach((k) => {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach((c) => { if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  // API wrapper — always same-origin, cookies included.
  async function api(path, opts) {
    opts = opts || {};
    const init = {
      method: opts.method || 'GET',
      credentials: 'include',
      headers: Object.assign({}, opts.body ? { 'Content-Type': 'application/json' } : {}, opts.headers || {})
    };
    if (opts.body != null) init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    const res = await fetch(path, init);
    if (res.status === 401) { showLogin(); throw new Error('auth required'); }
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.indexOf('application/json') !== -1) { try { data = await res.json(); } catch (e) { data = null; } }
    else { data = await res.text(); }
    if (!res.ok) {
      const msg = (data && data.error) ? data.error : (typeof data === 'string' && data ? data : ('Request failed (' + res.status + ')'));
      throw new Error(msg);
    }
    return data;
  }

  let toastTimer = null;
  function toast(message, kind) {
    const t = $('#toast');
    t.textContent = message;
    t.className = 'toast show' + (kind ? ' ' + kind : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, 2600);
  }

  // datetime helpers ----------------------------------------------------------
  function nowISO() { return new Date().toISOString(); }
  function todayDateStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function localDatetimeValue(d) {
    d = d || new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function datetimeLocalToISO(v) {
    if (!v) return nowISO();
    const d = new Date(v);
    return isNaN(d.getTime()) ? nowISO() : d.toISOString();
  }
  function isoToDatetimeLocal(iso) {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? localDatetimeValue() : localDatetimeValue(d);
  }
  function fmtTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function fmtDate(dateStr) {
    // dateStr is a YYYY-MM-DD (DATE column). Render without timezone shift.
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr));
    if (!m) return String(dateStr || '');
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }
  function dayKeyOfISO(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // Bristol Stool Scale — exact discreet clinical labels from the contract.
  const BRISTOL_LABELS = {
    1: 'Separate hard lumps',
    2: 'Lumpy & firm',
    3: 'Cracked surface',
    4: 'Smooth & soft',
    5: 'Soft blobs',
    6: 'Mushy ragged',
    7: 'Entirely liquid'
  };

  // ---------------------------------------------------------------------------
  // Image processing — resize to JPEG via canvas
  // ---------------------------------------------------------------------------
  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
      img.src = url;
    });
  }
  function resizeToDataUrl(img, maxEdge, quality) {
    let { naturalWidth: w, naturalHeight: h } = img;
    if (!w || !h) { w = img.width; h = img.height; }
    const scale = Math.min(1, maxEdge / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, 0, 0, cw, ch);
    return canvas.toDataURL('image/jpeg', quality);
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    authed: false,
    user: null,
    authMode: 'login', // 'login' | 'signup'
    version: '',
    db: 'unknown',
    correlationWindow: 1,
    gut: { bloating: null, bristol: null, gas: null, cramps: null, energy: null, mood: null, other: [] },
    chatHistory: []
  };

  // ===========================================================================
  // NAVIGATION
  // ===========================================================================
  const VIEWS = ['log', 'gut', 'history', 'insights', 'chat'];
  function showTab(tab) {
    if (VIEWS.indexOf(tab) === -1) tab = 'log';
    VIEWS.forEach((v) => {
      const sec = $('#view-' + v);
      if (sec) sec.classList.toggle('active', v === tab);
    });
    $$('#tabbar button').forEach((b) => {
      if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    if (tab === 'history') loadHistory();
    if (tab === 'insights') loadInsights();
    if (tab === 'chat') scrollChatToEnd();
    try { history.replaceState(null, '', '#' + tab); } catch (e) {}
  }
  function initNav() {
    $$('#tabbar button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
    const initial = (location.hash || '').replace('#', '');
    showTab(VIEWS.indexOf(initial) !== -1 ? initial : 'log');
  }

  // ===========================================================================
  // AUTH
  // ===========================================================================
  // Reflect the current auth mode (login vs signup) in the overlay copy: the
  // intro line, submit button label, and the toggle prompt/link text.
  function applyAuthMode() {
    const signup = state.authMode === 'signup';
    const intro = $('#authIntro');
    const submit = $('#authSubmit');
    const prompt = $('#authTogglePrompt');
    const link = $('#authToggleLink');
    const pwInput = $('#loginPw');
    if (intro) intro.textContent = signup ? 'Create your account to get started.' : 'Log in to continue.';
    if (submit) submit.textContent = signup ? 'Sign up' : 'Log in';
    if (prompt) prompt.textContent = signup ? 'Already have an account?' : 'New here?';
    if (link) link.textContent = signup ? 'Log in' : 'Create an account';
    if (pwInput) pwInput.setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
  }
  function setAuthMode(mode) {
    state.authMode = mode === 'signup' ? 'signup' : 'login';
    if ($('#loginErr')) $('#loginErr').textContent = '';
    applyAuthMode();
  }

  function showLogin() {
    state.authed = false;
    const ov = $('#loginOverlay');
    ov.classList.remove('hidden');
    ov.setAttribute('aria-hidden', 'false');
    setLoginWaking(false);
    applyAuthMode();
    setTimeout(() => { const i = $('#loginEmail'); if (i) i.focus(); }, 50);
  }
  function hideLogin() {
    state.authed = true;
    const ov = $('#loginOverlay');
    ov.classList.add('hidden');
    ov.setAttribute('aria-hidden', 'true');
  }
  // Show/clear a "waking up" state on the auth overlay. The host (Render free
  // tier) spins the server down when idle; the first request then takes ~30-60s
  // to wake and may briefly 404. Rather than fall through to a broken-looking
  // empty app, we surface a friendly waking message and hide the form, retrying.
  function setLoginWaking(on, failed) {
    const ov = $('#loginOverlay');
    const sub = $('#authIntro');
    const emailField = $('#loginEmail').closest('.field');
    const pwField = $('#loginPw').closest('.field');
    const btn = $('#authSubmit');
    const toggle = $('.auth-toggle');
    const setFormHidden = (hidden) => {
      const d = hidden ? 'none' : '';
      if (emailField) emailField.style.display = d;
      if (pwField) pwField.style.display = d;
      if (btn) btn.style.display = hidden ? 'none' : '';
      if (toggle) toggle.style.display = hidden ? 'none' : '';
    };
    if (on) {
      ov.classList.remove('hidden');
      ov.setAttribute('aria-hidden', 'false');
      if (sub) sub.textContent = 'Waking up the server… the first load can take up to a minute.';
      setFormHidden(true);
    } else if (failed) {
      if (sub) sub.textContent = 'Couldn’t reach the server. Please refresh in a moment.';
      setFormHidden(true);
    } else {
      // Restore the normal form; the mode-specific copy is set by applyAuthMode().
      setFormHidden(false);
      applyAuthMode();
    }
  }

  // Returns true if the server responded (auth state known), false if unreachable.
  async function checkAuth() {
    const MAX_RETRIES = 12; // ~12 * 4s ≈ 48s, enough for a free-tier cold start
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const s = await api('/api/auth/status');
        state.authed = !!s.authed;
        state.user = s.user || null;
        setLoginWaking(false);
        if (state.authed) hideLogin();
        else showLogin();
        return true;
      } catch (e) {
        // Server likely cold-starting. Show the waking state and retry.
        if (attempt < MAX_RETRIES) {
          setLoginWaking(true);
          await new Promise((r) => setTimeout(r, 4000));
          continue;
        }
        setLoginWaking(false, true);
        return false;
      }
    }
    return false;
  }
  function initAuthForm() {
    $('#authToggleLink').addEventListener('click', (e) => {
      e.preventDefault();
      setAuthMode(state.authMode === 'signup' ? 'login' : 'signup');
      const i = $('#loginEmail'); if (i) i.focus();
    });

    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = $('#loginEmail').value.trim();
      const pw = $('#loginPw').value;
      const errEl = $('#loginErr');
      errEl.textContent = '';
      if (!email) { errEl.textContent = 'Please enter your email.'; return; }
      if (pw.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; return; }

      const signup = state.authMode === 'signup';
      const path = signup ? '/api/auth/signup' : '/api/auth/login';
      const btn = $('#authSubmit');
      btn.disabled = true;
      try {
        const res = await api(path, { method: 'POST', body: { email: email, password: pw } });
        state.user = (res && res.user) || null;
        $('#loginPw').value = '';
        hideLogin();
        await bootData();
        toast(signup ? 'Welcome to UnGlutened' : 'Welcome back', 'ok');
      } catch (err) {
        // Surface the server-provided message (400/401/409); fall back to generic.
        errEl.textContent = err && err.message ? err.message : 'Something went wrong. Try again.';
      }
      btn.disabled = false;
    });

    $('#logoutBtn').addEventListener('click', async () => {
      try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) {}
      state.user = null;
      closeSettings();
      setAuthMode('login');
      showLogin();
    });
  }

  // ===========================================================================
  // LOG VIEW — photo + manual meal
  // ===========================================================================
  function renderMealResult(meal, opts) {
    opts = opts || {};
    const box = $('#logResult');
    box.innerHTML = '';
    const card = el('div', { class: 'card' });

    if (opts.thumb || meal.thumb) {
      card.appendChild(el('img', { class: 'preview', src: opts.thumb || meal.thumb, alt: 'Your meal' }));
    }
    card.appendChild(el('h2', { text: meal.title || 'Meal' }));
    if (meal.summary) card.appendChild(el('p', { class: 'hint', text: meal.summary }));

    const flags = Array.isArray(meal.irritant_flags) ? meal.irritant_flags : [];
    if (flags.length) {
      const wrap = el('div', { class: 'chips' });
      wrap.appendChild(el('span', { class: 'chip irritant', text: '⚠ Possible irritants' }));
      flags.forEach((f) => wrap.appendChild(el('span', { class: 'chip irritant', text: prettyFlag(f) })));
      card.appendChild(wrap);
    } else if (Array.isArray(meal.ingredients) && meal.ingredients.length) {
      card.appendChild(el('div', { class: 'chips' }, [el('span', { class: 'chip good', text: '✓ No common irritants flagged' })]));
    }

    const ings = Array.isArray(meal.ingredients) ? meal.ingredients : [];
    if (ings.length) {
      const ul = el('ul', { class: 'ingredients' });
      ings.forEach((ig) => {
        const li = el('li', {}, [
          el('span', { class: 'dot' + (ig.irritant ? ' irritant' : '') }),
          el('span', { class: 'name', text: ig.name || 'item' }),
          el('span', { class: 'cat', text: ig.category || '' })
        ]);
        ul.appendChild(li);
      });
      card.appendChild(el('div', { html: '<div style="margin-top:12px;font-weight:600;font-size:13px;color:var(--ink-soft)">Detected ingredients</div>' }));
      card.appendChild(ul);
    }

    // Editable title + time, persisting via PUT.
    const tWrap = el('div', { class: 'field', style: 'margin-top:14px' });
    tWrap.appendChild(el('label', { text: 'Title' }));
    const tIn = el('input', { type: 'text', value: meal.title || '' });
    tWrap.appendChild(tIn);
    card.appendChild(tWrap);

    const dWrap = el('div', { class: 'field' });
    dWrap.appendChild(el('label', { text: 'When' }));
    const dIn = el('input', { type: 'datetime-local', value: isoToDatetimeLocal(meal.eaten_at) });
    dWrap.appendChild(dIn);
    card.appendChild(dWrap);

    const btnRow = el('div', { class: 'btn-row' });
    const saveBtn = el('button', {
      class: 'btn', type: 'button', onclick: async () => {
        saveBtn.disabled = true;
        try {
          const updated = await api('/api/meals/' + meal.id, {
            method: 'PUT', body: { title: tIn.value.trim(), eaten_at: datetimeLocalToISO(dIn.value) }
          });
          toast('Saved', 'ok');
          renderMealResult(updated.meal || updated, { thumb: opts.thumb || (updated.meal || updated).thumb });
        } catch (err) { toast(err.message, 'error'); }
        saveBtn.disabled = false;
      }
    }, ['Save changes']);
    const newBtn = el('button', { class: 'btn ghost', type: 'button', onclick: () => { box.innerHTML = ''; } }, ['Done']);
    btnRow.appendChild(saveBtn); btnRow.appendChild(newBtn);
    card.appendChild(btnRow);

    box.appendChild(card);
  }

  function prettyFlag(f) {
    return String(f || '').replace(/_/g, ' ');
  }

  async function handlePhoto(file) {
    const box = $('#logResult');
    box.innerHTML = '';
    const loadingCard = el('div', { class: 'card' }, [
      el('div', { class: 'loading-row' }, [el('span', { class: 'spinner' }), el('span', { text: 'Reading your photo & spotting ingredients…' })])
    ]);
    box.appendChild(loadingCard);

    try {
      const img = await loadImageFromFile(file);
      const preview = resizeToDataUrl(img, 320, 0.8);
      // Insert a live preview above the spinner.
      loadingCard.insertBefore(el('img', { class: 'preview', src: preview, alt: 'Your meal' }), loadingCard.firstChild);

      const image = resizeToDataUrl(img, 1200, 0.8);
      const thumb = preview; // ≤320px thumbnail
      const result = await api('/api/meals', {
        method: 'POST',
        body: { image: image, thumb: thumb, eaten_at: nowISO() }
      });
      const meal = result.meal || result;
      renderMealResult(meal, { thumb: meal.thumb || thumb });
      toast('Meal logged', 'ok');
    } catch (err) {
      box.innerHTML = '';
      box.appendChild(el('div', { class: 'card' }, [
        el('p', { class: 'err', style: 'color:var(--danger);margin:0', text: 'Could not log that photo: ' + err.message }),
        el('p', { class: 'hint', style: 'margin:8px 0 0', text: 'You can try again, or use “Log without a photo” below.' })
      ]));
      toast('Photo failed', 'error');
    }
  }

  function initLog() {
    // Two ways to add a photo: live camera (capture) and the device gallery.
    ['#photoInputCamera', '#photoInputGallery'].forEach((sel) => {
      const input = $(sel);
      if (!input) return;
      input.addEventListener('change', (e) => {
        const f = e.target.files && e.target.files[0];
        e.target.value = ''; // allow re-selecting the same file
        if (f) handlePhoto(f);
      });
    });

    $('#mealTime').value = localDatetimeValue();

    $('#manualMealForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = $('#mealTitle').value.trim();
      const description = $('#mealDesc').value.trim();
      if (!title && !description) { toast('Add a title or details first', 'error'); return; }
      const btn = $('#manualMealForm button[type=submit]');
      btn.disabled = true;
      try {
        const body = { title: title, description: description, eaten_at: datetimeLocalToISO($('#mealTime').value) };
        const result = await api('/api/meals', { method: 'POST', body: body });
        const meal = result.meal || result;
        $('#mealTitle').value = ''; $('#mealDesc').value = ''; $('#mealTime').value = localDatetimeValue();
        renderMealResult(meal, { thumb: meal.thumb });
        toast('Meal logged', 'ok');
      } catch (err) { toast(err.message, 'error'); }
      btn.disabled = false;
    });
  }

  // ===========================================================================
  // GUT VIEW
  // ===========================================================================
  function buildScale(scaleEl) {
    const key = scaleEl.dataset.scale;
    const min = Number(scaleEl.dataset.min);
    const max = Number(scaleEl.dataset.max);
    const seg = $('.seg', scaleEl);
    const valOut = $('.scale-val', scaleEl);
    const desc = $('.scale-desc', scaleEl);
    const baseDesc = desc.textContent;
    seg.innerHTML = '';
    for (let i = min; i <= max; i++) {
      const b = el('button', { type: 'button', 'aria-pressed': 'false', text: String(i) });
      b.addEventListener('click', () => {
        const already = state.gut[key] === i;
        state.gut[key] = already ? null : i;
        $$('.seg button', scaleEl).forEach((x) => x.setAttribute('aria-pressed', 'false'));
        if (!already) b.setAttribute('aria-pressed', 'true');
        valOut.textContent = state.gut[key] == null ? '—' : String(state.gut[key]);
        if (key === 'bristol') desc.textContent = state.gut[key] == null ? baseDesc : ('Type ' + i + ' — ' + BRISTOL_LABELS[i]);
      });
      seg.appendChild(b);
    }
  }

  function renderGutOtherChips() {
    const wrap = $('#gutOtherChips');
    wrap.innerHTML = '';
    if (!state.gut.other.length) {
      wrap.appendChild(el('span', { class: 'hint', style: 'font-size:13px;color:var(--ink-faint)', text: 'None added.' }));
    }
    state.gut.other.forEach((sym, idx) => {
      const chip = el('span', { class: 'chip removable accent' }, [
        document.createTextNode(sym),
        el('button', { class: 'x', type: 'button', 'aria-label': 'Remove ' + sym, onclick: () => { state.gut.other.splice(idx, 1); renderGutOtherChips(); } }, ['×'])
      ]);
      wrap.appendChild(chip);
    });
  }
  function addGutOther() {
    const inp = $('#gutOtherInput');
    const v = inp.value.trim();
    if (!v) return;
    if (state.gut.other.indexOf(v) === -1) state.gut.other.push(v);
    inp.value = '';
    renderGutOtherChips();
  }
  function resetGutForm() {
    state.gut = { bloating: null, bristol: null, gas: null, cramps: null, energy: null, mood: null, other: [] };
    $('#gutDate').value = todayDateStr();
    $('#gutNotes').value = '';
    $$('#gutForm .scale').forEach((s) => {
      $$('.seg button', s).forEach((b) => b.setAttribute('aria-pressed', 'false'));
      $('.scale-val', s).textContent = '—';
    });
    const bristolDesc = $('#gutForm .scale[data-scale=bristol] .scale-desc');
    if (bristolDesc) bristolDesc.textContent = 'Tap to select. Type 4 is considered ideal.';
    renderGutOtherChips();
  }
  function initGut() {
    $$('#gutForm .scale').forEach(buildScale);
    $('#gutDate').value = todayDateStr();
    renderGutOtherChips();
    $('#gutOtherAdd').addEventListener('click', addGutOther);
    $('#gutOtherInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addGutOther(); } });

    $('#gutForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const g = state.gut;
      const anyVal = ['bloating', 'bristol', 'gas', 'cramps', 'energy', 'mood'].some((k) => g[k] != null) || g.other.length || $('#gutNotes').value.trim();
      if (!anyVal) { toast('Add at least one value', 'error'); return; }
      const body = {
        logged_for: $('#gutDate').value || todayDateStr(),
        bloating: g.bloating, bristol: g.bristol, gas: g.gas, cramps: g.cramps,
        energy: g.energy, mood: g.mood,
        other_symptoms: g.other.slice(),
        notes: $('#gutNotes').value.trim()
      };
      const btn = $('#gutForm button[type=submit]');
      btn.disabled = true;
      try {
        await api('/api/symptoms', { method: 'POST', body: body });
        resetGutForm();
        toast('Check-in saved', 'ok');
      } catch (err) { toast(err.message, 'error'); }
      btn.disabled = false;
    });
  }

  // ===========================================================================
  // HISTORY VIEW
  // ===========================================================================
  function mealRow(meal) {
    const flags = Array.isArray(meal.irritant_flags) ? meal.irritant_flags : [];
    const chips = el('div', { class: 'chips' });
    flags.slice(0, 6).forEach((f) => chips.appendChild(el('span', { class: 'chip irritant', text: prettyFlag(f) })));

    const thumb = meal.thumb
      ? el('img', { class: 'thumb', src: meal.thumb, alt: '' })
      : el('div', { class: 'thumb placeholder', 'aria-hidden': 'true', text: meal.source === 'manual' ? '✎' : '🍽' });

    const body = el('div', { class: 'tl-body' }, [
      el('div', { class: 'tl-time' }, [el('span', { class: 'tl-kind meal', text: 'Meal' }), document.createTextNode(fmtTime(meal.eaten_at))]),
      el('div', { class: 'tl-title', text: meal.title || meal.summary || 'Meal' }),
      meal.summary && meal.title ? el('div', { class: 'hint', style: 'margin:0;font-size:13px', text: meal.summary }) : null,
      flags.length ? chips : null,
      el('div', { class: 'tl-actions' }, [
        el('button', { class: 'btn sm ghost', type: 'button', onclick: () => openEditMeal(meal) }, ['Edit']),
        el('button', { class: 'btn sm danger', type: 'button', onclick: () => confirmDelete('meal', meal.id) }, ['Delete'])
      ])
    ]);
    return el('div', { class: 'tl-item' }, [thumb, body]);
  }

  function symptomBadges(s) {
    const wrap = el('div', { class: 'badges' });
    const add = (label, val, hiBad) => {
      if (val == null) return;
      let cls = 'badge';
      if (hiBad === true && val >= 3) cls += ' hi';
      if (hiBad === false && val >= 4) cls += ' lo';
      wrap.appendChild(el('span', { class: cls, text: label + ' ' + val }));
    };
    add('Bloating', s.bloating, true);
    if (s.bristol != null) wrap.appendChild(el('span', { class: 'badge' + (s.bristol <= 2 || s.bristol >= 6 ? ' hi' : ''), text: 'Bristol ' + s.bristol }));
    add('Gas', s.gas, true);
    add('Cramps', s.cramps, true);
    add('Energy', s.energy, false);
    add('Mood', s.mood, false);
    (Array.isArray(s.other_symptoms) ? s.other_symptoms : []).forEach((o) => wrap.appendChild(el('span', { class: 'badge', text: o })));
    return wrap;
  }

  function symptomRow(s) {
    const body = el('div', { class: 'tl-body' }, [
      el('div', { class: 'tl-time' }, [el('span', { class: 'tl-kind gut', text: 'Gut check-in' }), document.createTextNode(fmtDate(s.logged_for))]),
      symptomBadges(s),
      s.notes ? el('div', { class: 'hint', style: 'margin:8px 0 0;font-size:13px', text: s.notes }) : null,
      el('div', { class: 'tl-actions' }, [
        el('button', { class: 'btn sm ghost', type: 'button', onclick: () => openEditSymptom(s) }, ['Edit']),
        el('button', { class: 'btn sm danger', type: 'button', onclick: () => confirmDelete('symptom', s.id) }, ['Delete'])
      ])
    ]);
    const icon = el('div', { class: 'thumb placeholder', 'aria-hidden': 'true', text: '🫧' });
    return el('div', { class: 'tl-item' }, [icon, body]);
  }

  async function loadHistory() {
    const list = $('#historyList');
    list.innerHTML = '';
    list.appendChild(el('div', { class: 'loading-row' }, [el('span', { class: 'spinner' }), el('span', { text: 'Loading your history…' })]));
    try {
      const [mres, sres] = await Promise.all([api('/api/meals?limit=200'), api('/api/symptoms')]);
      const meals = (mres.meals || []).map((m) => Object.assign({ _t: 'meal', _when: m.eaten_at }, m));
      const symptoms = (sres.symptoms || []).map((s) => Object.assign({ _t: 'symptom', _when: (s.logged_for || '') + 'T12:00:00' }, s));
      const items = meals.concat(symptoms).sort((a, b) => new Date(b._when) - new Date(a._when));

      list.innerHTML = '';
      if (!items.length) {
        list.appendChild(el('div', { class: 'empty' }, [
          el('div', { class: 'glyph', text: '🗒️' }),
          el('p', { text: 'Nothing logged yet. Snap a meal or do a gut check-in to get started.' })
        ]));
        return;
      }
      let lastDay = null;
      items.forEach((it) => {
        const day = it._t === 'meal' ? dayKeyOfISO(it._when) : (it.logged_for || '');
        if (day !== lastDay) {
          lastDay = day;
          const label = it._t === 'meal' ? fmtDate(dayKeyOfISO(it._when)) : fmtDate(it.logged_for);
          list.appendChild(el('div', { class: 'tl-day-label', text: label }));
        }
        list.appendChild(it._t === 'meal' ? mealRow(it) : symptomRow(it));
      });
    } catch (err) {
      list.innerHTML = '';
      list.appendChild(el('div', { class: 'empty' }, [el('p', { text: 'Could not load history: ' + err.message })]));
    }
  }

  function confirmDelete(kind, id) {
    const label = kind === 'meal' ? 'this meal' : 'this gut check-in';
    if (!window.confirm('Delete ' + label + '? This cannot be undone.')) return;
    const path = (kind === 'meal' ? '/api/meals/' : '/api/symptoms/') + id;
    api(path, { method: 'DELETE' })
      .then(() => { toast('Deleted', 'ok'); loadHistory(); })
      .catch((err) => toast(err.message, 'error'));
  }

  // ===========================================================================
  // EDIT MODAL
  // ===========================================================================
  function openEditModal(title, bodyNode) {
    $('#editTitle').textContent = title;
    const body = $('#editBody');
    body.innerHTML = '';
    body.appendChild(bodyNode);
    $('#editBackdrop').classList.add('open');
  }
  function closeEditModal() { $('#editBackdrop').classList.remove('open'); $('#editBody').innerHTML = ''; }

  function openEditMeal(meal) {
    const form = el('form', { class: 'card', novalidate: 'novalidate' });
    const titleIn = el('input', { type: 'text', value: meal.title || '' });
    const descIn = el('textarea', { text: meal.description || '' });
    const timeIn = el('input', { type: 'datetime-local', value: isoToDatetimeLocal(meal.eaten_at) });

    // Editable irritant flags as removable chips + add control.
    let flags = (Array.isArray(meal.irritant_flags) ? meal.irritant_flags : []).slice();
    const chipWrap = el('div', { class: 'chips' });
    const renderFlags = () => {
      chipWrap.innerHTML = '';
      if (!flags.length) chipWrap.appendChild(el('span', { class: 'hint', style: 'font-size:13px;color:var(--ink-faint)', text: 'No irritants flagged.' }));
      flags.forEach((f, i) => chipWrap.appendChild(el('span', { class: 'chip irritant removable' }, [
        document.createTextNode(prettyFlag(f)),
        el('button', { class: 'x', type: 'button', 'aria-label': 'Remove', onclick: () => { flags.splice(i, 1); renderFlags(); } }, ['×'])
      ])));
    };
    renderFlags();
    const flagInput = el('input', { type: 'text', placeholder: 'e.g. gluten' });
    const flagAdd = el('button', { class: 'btn sm', type: 'button', onclick: () => {
      const v = flagInput.value.trim().toLowerCase().replace(/\s+/g, '_');
      if (v && flags.indexOf(v) === -1) flags.push(v);
      flagInput.value = ''; renderFlags();
    } }, ['Add']);

    form.appendChild(field('Title', titleIn));
    form.appendChild(field('Details', descIn));
    form.appendChild(field('When', timeIn));
    const flagField = el('div', { class: 'field' }, [el('label', { text: 'Irritant flags' }), chipWrap, el('div', { class: 'chip-add' }, [flagInput, flagAdd])]);
    form.appendChild(flagField);

    form.appendChild(el('button', { class: 'btn block', type: 'submit' }, ['Save meal']));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/meals/' + meal.id, { method: 'PUT', body: {
          title: titleIn.value.trim(),
          description: descIn.value.trim(),
          eaten_at: datetimeLocalToISO(timeIn.value),
          irritant_flags: flags
        } });
        closeEditModal();
        toast('Meal updated', 'ok');
        loadHistory();
      } catch (err) { toast(err.message, 'error'); }
    });
    openEditModal('Edit meal', form);
  }

  function openEditSymptom(s) {
    const form = el('form', { class: 'card', novalidate: 'novalidate' });
    const dateIn = el('input', { type: 'date', value: (String(s.logged_for || '').slice(0, 10)) || todayDateStr() });
    form.appendChild(field('Date', dateIn));

    // Build editable scales scoped to this symptom.
    const local = {
      bloating: s.bloating, bristol: s.bristol, gas: s.gas, cramps: s.cramps,
      energy: s.energy, mood: s.mood, other: (Array.isArray(s.other_symptoms) ? s.other_symptoms : []).slice()
    };
    const scaleDefs = [
      ['bloating', 'Bloating', 0, 5], ['bristol', 'Stool (Bristol)', 1, 7],
      ['gas', 'Gas', 0, 5], ['cramps', 'Cramps', 0, 5],
      ['energy', 'Energy', 0, 5], ['mood', 'Mood', 0, 5]
    ];
    scaleDefs.forEach((def) => {
      const [key, label, mn, mx] = def;
      const valOut = el('span', { class: 'scale-val', text: local[key] == null ? '—' : String(local[key]) });
      const desc = el('div', { class: 'scale-desc', text: key === 'bristol' ? (local.bristol ? 'Type ' + local.bristol + ' — ' + BRISTOL_LABELS[local.bristol] : 'Tap to select.') : '' });
      const seg = el('div', { class: 'seg' + (key === 'bristol' ? ' small' : '') });
      for (let i = mn; i <= mx; i++) {
        const b = el('button', { type: 'button', 'aria-pressed': local[key] === i ? 'true' : 'false', text: String(i) });
        b.addEventListener('click', () => {
          const already = local[key] === i;
          local[key] = already ? null : i;
          $$('button', seg).forEach((x) => x.setAttribute('aria-pressed', 'false'));
          if (!already) b.setAttribute('aria-pressed', 'true');
          valOut.textContent = local[key] == null ? '—' : String(local[key]);
          if (key === 'bristol') desc.textContent = local.bristol == null ? 'Tap to select.' : ('Type ' + local.bristol + ' — ' + BRISTOL_LABELS[local.bristol]);
        });
        seg.appendChild(b);
      }
      form.appendChild(el('div', { class: 'scale' }, [
        el('div', { class: 'scale-head' }, [el('label', { text: label }), valOut]), seg, desc
      ]));
    });

    // Other symptoms
    const otherWrap = el('div', { class: 'chips' });
    const renderOther = () => {
      otherWrap.innerHTML = '';
      if (!local.other.length) otherWrap.appendChild(el('span', { class: 'hint', style: 'font-size:13px;color:var(--ink-faint)', text: 'None.' }));
      local.other.forEach((o, i) => otherWrap.appendChild(el('span', { class: 'chip removable accent' }, [
        document.createTextNode(o),
        el('button', { class: 'x', type: 'button', 'aria-label': 'Remove', onclick: () => { local.other.splice(i, 1); renderOther(); } }, ['×'])
      ])));
    };
    renderOther();
    const otherInput = el('input', { type: 'text', placeholder: 'Add a symptom…' });
    const otherAdd = el('button', { class: 'btn sm', type: 'button', onclick: () => {
      const v = otherInput.value.trim();
      if (v && local.other.indexOf(v) === -1) local.other.push(v);
      otherInput.value = ''; renderOther();
    } }, ['Add']);
    form.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Other symptoms' }), otherWrap, el('div', { class: 'chip-add' }, [otherInput, otherAdd])]));

    const notesIn = el('textarea', { text: s.notes || '' });
    form.appendChild(field('Notes', notesIn));

    form.appendChild(el('button', { class: 'btn block', type: 'submit' }, ['Save check-in']));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/symptoms/' + s.id, { method: 'PUT', body: {
          logged_for: dateIn.value || todayDateStr(),
          bloating: local.bloating, bristol: local.bristol, gas: local.gas, cramps: local.cramps,
          energy: local.energy, mood: local.mood,
          other_symptoms: local.other, notes: notesIn.value.trim()
        } });
        closeEditModal();
        toast('Check-in updated', 'ok');
        loadHistory();
      } catch (err) { toast(err.message, 'error'); }
    });
    openEditModal('Edit gut check-in', form);
  }

  function field(label, inputNode) {
    return el('div', { class: 'field' }, [el('label', { text: label }), inputNode]);
  }

  // ===========================================================================
  // INSIGHTS VIEW
  // ===========================================================================
  function severityClass(sev) {
    return 'sev-' + (sev === 'protective' ? 'protective' : (sev === 'high' ? 'high' : sev === 'medium' ? 'medium' : 'low'));
  }
  function corrLabel(r) {
    const item = prettyFlag(r.label || r.key);
    if (r.severity === 'protective' || r.badnessDelta < 0) return 'Eating ' + item + ' is associated with better digestion.';
    return 'Eating ' + item + ' is associated with worse digestion.';
  }
  function num(v, digits) {
    if (v == null || isNaN(v)) return '—';
    return Number(v).toFixed(digits == null ? 1 : digits);
  }

  function renderCorrelation(r) {
    const up = (r.badnessDelta || 0) >= 0;
    const card = el('div', { class: 'corr' });
    card.appendChild(el('div', { class: 'corr-top' }, [
      el('span', { class: 'sev-dot ' + severityClass(r.severity) }),
      el('span', { class: 'corr-name', text: prettyFlag(r.label || r.key) }),
      el('span', { class: 'corr-kind', text: r.kind || '' })
    ]));
    card.appendChild(el('p', { class: 'corr-label', text: corrLabel(r) }));
    card.appendChild(el('div', { class: 'corr-stats' }, [
      el('div', { class: 'stat' }, [el('span', { class: 'k', text: 'Exposed' }), el('span', { class: 'v', text: num(r.badnessWith) })]),
      el('div', { class: 'stat' }, [el('span', { class: 'k', text: 'Not exposed' }), el('span', { class: 'v', text: num(r.badnessWithout) })]),
      el('div', { class: 'stat delta' }, [el('span', { class: 'k', text: 'Difference' }),
        el('span', { class: 'v ' + (up ? 'up' : 'down'), text: (up ? '+' : '') + num(r.badnessDelta) })])
    ]));
    card.appendChild(el('div', { class: 'corr-meta', text:
      'Discomfort index (0 best – 10 worst). ' + (r.daysWith != null ? (r.daysWith + ' days with, ' + r.daysWithout + ' without · ') : '') +
      (r.occurrences != null ? (r.occurrences + ' exposures') : '') }));
    return card;
  }

  async function loadInsights() {
    const box = $('#insightsList');
    box.innerHTML = '';
    box.appendChild(el('div', { class: 'loading-row' }, [el('span', { class: 'spinner' }), el('span', { text: 'Crunching your correlations…' })]));
    try {
      const data = await api('/api/correlations?window=' + state.correlationWindow + '&minOccur=3');
      box.innerHTML = '';
      if (!data || data.ready === false) {
        const reason = (data && data.reason) || 'Keep logging meals and gut check-ins — once there’s enough data, patterns will appear here.';
        box.appendChild(el('div', { class: 'empty' }, [
          el('div', { class: 'glyph', text: '🌱' }),
          el('p', { text: reason })
        ]));
        return;
      }
      const results = Array.isArray(data.results) ? data.results : [];
      if (!results.length) {
        box.appendChild(el('div', { class: 'empty' }, [
          el('div', { class: 'glyph', text: '🌱' }),
          el('p', { text: 'No clear associations yet. Keep logging — patterns sharpen with more data.' })
        ]));
        return;
      }
      const head = el('p', { class: 'hint', style: 'margin:0 2px 12px',
        text: 'Based on ' + (data.nMeals || 0) + ' meals and ' + (data.nSymptomDays || 0) + ' gut check-in days.' });
      box.appendChild(head);
      results.forEach((r) => box.appendChild(renderCorrelation(r)));
    } catch (err) {
      box.innerHTML = '';
      box.appendChild(el('div', { class: 'empty' }, [el('p', { text: 'Could not load insights: ' + err.message })]));
    }
  }

  function initInsights() {
    $$('.window-pick button').forEach((b) => b.addEventListener('click', () => {
      state.correlationWindow = Number(b.dataset.window) || 1;
      $$('.window-pick button').forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
      loadInsights();
    }));

    $('#genReport').addEventListener('click', async () => {
      const area = $('#reportArea');
      area.innerHTML = '';
      area.appendChild(el('div', { class: 'loading-row' }, [el('span', { class: 'spinner' }), el('span', { text: 'Building your report…' })]));
      try {
        const data = await api('/api/report?format=md');
        const md = typeof data === 'string' ? data : (data.markdown || '');
        area.innerHTML = '';
        const box = el('div', { class: 'report-box' });
        box.appendChild(el('div', { class: 'report-md', text: md }));
        const row = el('div', { class: 'btn-row', style: 'margin-top:12px' });
        row.appendChild(el('button', { class: 'btn sm secondary', type: 'button', onclick: () => copyText(md) }, ['Copy']));
        row.appendChild(el('button', { class: 'btn sm secondary', type: 'button', onclick: () => downloadMd(md) }, ['Download .md']));
        row.appendChild(el('button', { class: 'btn sm secondary', type: 'button', onclick: () => printReport(md) }, ['Print']));
        box.appendChild(row);
        area.appendChild(box);
      } catch (err) {
        area.innerHTML = '';
        area.appendChild(el('p', { class: 'hint', style: 'color:var(--danger)', text: 'Could not build report: ' + err.message }));
      }
    });
  }

  function copyText(text) {
    const done = () => toast('Copied to clipboard', 'ok');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed', 'error'); }
    document.body.removeChild(ta);
  }
  function downloadMd(text) {
    const blob = new Blob([text], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'unglutened-report-' + todayDateStr() + '.md';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function printReport(md) {
    const w = window.open('', '_blank');
    if (!w) { toast('Allow pop-ups to print', 'error'); return; }
    const safe = esc(md);
    w.document.write('<!DOCTYPE html><html><head><meta charset="utf-8"><title>UnGlutened report</title>' +
      '<style>body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1f2a2e;max-width:720px;margin:32px auto;padding:0 20px}' +
      'pre{white-space:pre-wrap;word-break:break-word;font-family:inherit}</style></head><body><pre>' + safe + '</pre></body></html>');
    w.document.close();
    w.focus();
    setTimeout(() => { try { w.print(); } catch (e) {} }, 250);
  }

  // ===========================================================================
  // CHAT VIEW
  // ===========================================================================
  const CHAT_EXAMPLES = [
    'What did I eat yesterday?',
    'Log that I had oatmeal with banana at 8am',
    'Delete my last meal',
    'What seems to correlate with bloating?'
  ];

  function addChatBubble(role, content) {
    const scroll = $('#chatScroll');
    scroll.appendChild(el('div', { class: 'msg ' + (role === 'user' ? 'user' : 'assistant'), text: content }));
    scrollChatToEnd();
  }
  function addSystemNote(text) {
    const scroll = $('#chatScroll');
    scroll.appendChild(el('div', { class: 'msg system-note', text: text }));
    scrollChatToEnd();
  }
  function scrollChatToEnd() {
    const scroll = $('#chatScroll');
    if (scroll) requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
  }

  function renderChatExamples() {
    const wrap = $('#chatExamples');
    wrap.innerHTML = '';
    CHAT_EXAMPLES.forEach((ex) => {
      wrap.appendChild(el('button', { class: 'chip selectable', type: 'button', onclick: () => { $('#chatInput').value = ex; $('#chatInput').focus(); } }, [ex]));
    });
  }

  async function loadChatHistory() {
    try {
      const data = await api('/api/chat/history');
      state.chatHistory = (data && data.history) || [];
      const scroll = $('#chatScroll');
      scroll.innerHTML = '';
      if (!state.chatHistory.length) {
        addChatBubble('assistant', 'Hi! I can answer questions about your meals and gut symptoms, and I can add, edit, or delete entries when you ask. Try one of the suggestions below.');
      } else {
        state.chatHistory.forEach((m) => addChatBubble(m.role, m.content));
      }
    } catch (e) {
      // leave the default greeting if history fails to load
      if (!$('#chatScroll').children.length) {
        addChatBubble('assistant', 'Hi! Ask me about your logs, or tell me to add, edit, or delete entries.');
      }
    }
  }

  async function sendChat(message) {
    addChatBubble('user', message);
    state.chatHistory.push({ role: 'user', content: message });
    const scroll = $('#chatScroll');
    const thinking = el('div', { class: 'msg assistant' }, [el('span', { class: 'spinner', style: 'display:inline-block;vertical-align:middle' })]);
    scroll.appendChild(thinking); scrollChatToEnd();

    try {
      const data = await api('/api/chat', { method: 'POST', body: { message: message, history: state.chatHistory.slice(0, -1) } });
      scroll.removeChild(thinking);
      const reply = (data && data.reply) || '…';
      addChatBubble('assistant', reply);
      state.chatHistory = (data && data.history) || state.chatHistory.concat([{ role: 'assistant', content: reply }]);

      const actions = (data && data.actions) || [];
      if (actions.length) {
        addSystemNote('✓ Updated your log');
        // Refresh the other views so changes are reflected immediately.
        loadHistory();
        loadInsights();
        refreshSettingsStats();
      }
    } catch (err) {
      if (thinking.parentNode) scroll.removeChild(thinking);
      addChatBubble('assistant', 'Sorry — something went wrong: ' + err.message);
    }
  }

  function initChat() {
    renderChatExamples();
    $('#chatForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = $('#chatInput').value.trim();
      if (!v) return;
      $('#chatInput').value = '';
      sendChat(v);
    });
  }

  // ===========================================================================
  // SETTINGS SHEET
  // ===========================================================================
  function openSettings() { $('#settingsBackdrop').classList.add('open'); $('#settingsSheet').classList.add('open'); refreshSettingsStats(); }
  function closeSettings() { $('#settingsBackdrop').classList.remove('open'); $('#settingsSheet').classList.remove('open'); }

  async function refreshSettingsStats() {
    const emailEl = $('#setEmail');
    if (emailEl) emailEl.textContent = (state.user && state.user.email) ? state.user.email : '—';
    try {
      const [mres, sres] = await Promise.all([api('/api/meals?limit=1'), api('/api/symptoms')]);
      // meals route only returns a page; for an accurate-ish count use lengths where available.
      $('#setMeals').textContent = (mres.meals && mres.meals.length === 1) ? '1+' : String((mres.meals || []).length);
      $('#setSymptoms').textContent = String((sres.symptoms || []).length);
    } catch (e) { /* ignore */ }
  }

  function initSettings() {
    $('#openSettings').addEventListener('click', openSettings);
    $('#closeSettings').addEventListener('click', closeSettings);
    $('#settingsBackdrop').addEventListener('click', closeSettings);
    $('#clearChatBtn').addEventListener('click', async () => {
      if (!window.confirm('Clear your chat history?')) return;
      try {
        await api('/api/chat/history', { method: 'DELETE' });
        state.chatHistory = [];
        $('#chatScroll').innerHTML = '';
        addChatBubble('assistant', 'Chat history cleared. How can I help?');
        toast('Chat cleared', 'ok');
        closeSettings();
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  // ===========================================================================
  // HEALTH / VERSION
  // ===========================================================================
  async function loadHealth() {
    try {
      const h = await api('/healthz');
      const v = h.version ? ('v' + h.version) : '';
      state.version = (v + (h.codename ? ' “' + h.codename + '”' : '')).trim();
      state.db = h.db || 'unknown';
      $('#setVersion').textContent = state.version || '—';
      $('#setDb').textContent = state.db === 'up' ? 'Connected' : (state.db === 'down' ? 'Unavailable' : '—');
    } catch (e) {
      $('#setVersion').textContent = '—';
    }
  }

  // ===========================================================================
  // MODAL / GLOBAL WIRING
  // ===========================================================================
  function initModals() {
    $('#editClose').addEventListener('click', closeEditModal);
    $('#editBackdrop').addEventListener('click', (e) => { if (e.target === $('#editBackdrop')) closeEditModal(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeEditModal(); closeSettings(); }
    });
  }

  // ===========================================================================
  // PWA — register the service worker
  // ===========================================================================
  function registerSW() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => { /* offline support is best-effort */ });
      });
    }
  }

  // ===========================================================================
  // BOOT
  // ===========================================================================
  async function bootData() {
    await Promise.all([loadHealth(), loadChatHistory()]);
  }

  async function init() {
    initNav();
    initAuthForm();
    initLog();
    initGut();
    initInsights();
    initChat();
    initSettings();
    initModals();
    registerSW();

    const reachable = await checkAuth();
    if (!reachable) return; // server unreachable; waking/refresh message already shown
    if (state.authed) {
      await bootData();
    } else {
      // still load health so version shows even pre-login
      loadHealth();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
