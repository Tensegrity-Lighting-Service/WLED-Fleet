(() => {
  const $ = s => document.querySelector(s);
  // ── thème clair / sombre / système : tout en haut pour limiter le flash au chargement ──
  // 'system' = pas d'attribut, la media query prefers-color-scheme décide (style.css) ;
  // un choix explicite pose data-theme sur <html>, qui l'emporte dans les deux sens.
  let theme = 'system'; try { theme = localStorage.getItem('wf.theme') || 'system'; } catch { /* défaut */ }
  function applyTheme(t) {
    theme = t; try { localStorage.setItem('wf.theme', t); } catch { /* ignore */ }
    if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
    document.querySelectorAll('#themeSw button').forEach(b => b.classList.toggle('active', b.dataset.theme === t));
  }
  applyTheme(theme);
  document.querySelectorAll('#themeSw button').forEach(b => b.onclick = () => applyTheme(b.dataset.theme));
  let COLS = [], GROUPS = [], fleet = { nodes: [] }, LED_TYPES = {}, COLOR_ORDERS = {};
  let ledProfilesCache = []; // local library (led-profiles.json), kept in sync for the Sorties/DMX badge and table
  let sortKey = 'name', sortDir = 1, editing = null;
  // manual row order (drag the ⋮⋮ handle): a list of node identities (MAC, else IP), persisted
  const rid = n => (n.info && n.info.mac ? n.info.mac.toLowerCase() : key(n));
  let rowOrder = []; try { rowOrder = JSON.parse(localStorage.getItem('wf.rowOrder') || '[]'); if (localStorage.getItem('wf.sortKey') === 'manual') sortKey = 'manual'; } catch { /* defaults */ }
  const saveRowOrder = () => { try { localStorage.setItem('wf.rowOrder', JSON.stringify(rowOrder)); localStorage.setItem('wf.sortKey', sortKey); } catch { /* ignore */ } };
  const selected = new Set();
  document.addEventListener('contextmenu', e => { if (e.target.closest('input, textarea, [contenteditable]')) return; e.preventDefault(); });
  // staged edits, not yet sent: key "ip|colId" -> {ip, col, value}
  const pending = new Map();
  const pkey = (ip, colId) => ip + '|' + colId;
  // change journal (from /api/changes): cells touched in the last 10 min keep a marker
  let changes = [], lastChangeAt = 0, unseen = 0, journalOpen = false;
  const recentChanges = new Map(); // "ip|col" -> latest event
  const RECENT_MS = 10 * 60 * 1000;
  const changedCls = (ip, colId) => { const c = recentChanges.get(pkey(ip, colId)); return c && Date.now() - c.at < RECENT_MS ? (c.source === 'externe' ? ' chg-ext' : ' chg-us') : ''; };
  const hiddenGroups = new Set(JSON.parse(localStorage.getItem('wf.hiddenGroups') || '[]'));

  // ── helpers ────────────────────────────────────────────────────────────────
  const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
  const fmtDur = s => { if (s == null) return ''; s = Math.round(s); const d = Math.floor(s/86400), h = Math.floor(s%86400/3600), m = Math.floor(s%3600/60); return d ? `${d}j ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s%60}s` : `${s}s`; };
  const fmtBytes = b => b == null ? '' : b > 1048576 ? (b/1048576).toFixed(1)+' MB' : b > 1024 ? Math.round(b/1024)+' kB' : b+' B';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const key = n => n.meta.ip;
  // tooltip text for a column: label, explanation, then how it is read/written
  const helpText = c => `${c.label}\n${c.help || c.title || ''}\n\n${c.write ? `✎ modifiable → ${c.write.target === 'cfg' ? 'cfg.json' : 'état'} : ${c.write.path}${c.reboot ? ' (⟳ redémarrage requis)' : ''}` : 'lecture seule'}\nlu dans ${c.path}`;
  // ── présence & qualité de signal (partie figée) ──────────────────────────────
  // hors ligne officiellement après 2 relevés manqués (serveur) ; ici un 1er
  // relevé manqué se voit déjà (pastille orange qui pulse) au lieu d'attendre
  // en silence le 2e. La jauge (façon téléphone, 0-4 barres) reflète le RSSI
  // Wi-Fi du node — plus parlant que la latence pour le risque de décrochage ;
  // absente pour un node en Ethernet (pas de RSSI).
  function presenceHtml(n) {
    const fails = n.meta.fails || 0;
    const cls = !n.meta.online ? 'bad' : fails >= 1 ? 'warn pulse' : 'ok';
    const rssi = n.info && n.info.wifi && n.info.wifi.rssi != null ? n.info.wifi.rssi : null;
    const status = !n.meta.online
      ? `hors ligne${n.meta.lastSeenAgo != null ? ' depuis ' + fmtDur(n.meta.lastSeenAgo) : ''}`
      : fails >= 1 ? '⚠ 1 relevé manqué : risque de décrochage au prochain'
      : [rssi != null ? `signal ${rssi} dBm` : null, n.meta.latency != null ? `latence ${n.meta.latency} ms` : null].filter(Boolean).join(', ') || 'en ligne';
    let bars = '';
    if (n.meta.online && fails === 0 && rssi != null) {
      const q = rssi >= -55 ? 4 : rssi >= -67 ? 3 : rssi >= -75 ? 2 : 1;
      bars = `<span class="sigbars q${q}" title="signal Wi-Fi : ${rssi} dBm"><i></i><i></i><i></i><i></i></span>`;
    }
    return { cls, status, bars };
  }

  function display(col, v) {
    if (v === undefined || v === null) return '';
    if (col.type === 'bool') return `<span class="${v?'true':'false'}"><span class="b"></span>${v ? 'oui' : 'non'}</span>`;
    if (col.type === 'enum') return esc(col.enum[v] !== undefined ? `${col.enum[v]} (${v})` : v);
    if (col.fmt === 'duration') return fmtDur(v);
    if (col.fmt === 'bytes') return fmtBytes(v);
    if (col.link) return `<a href="http://${esc(v)}/" target="_blank" rel="noopener">${esc(v)}</a>`;
    return esc(v);
  }
  function raw(col, v) {
    if (v === undefined || v === null) return '';
    if (col.type === 'bool') return v ? 'oui' : 'non';
    if (col.type === 'enum') return col.enum[v] !== undefined ? col.enum[v] : String(v);
    if (col.fmt === 'duration') return fmtDur(v);
    return String(v);
  }
  // panels are rebuilt on every poll: remember which <details data-key> are open (and the
  // scroll position) before innerHTML is replaced, and put them back afterwards
  function keepDetails(p) {
    const open = new Map([...p.querySelectorAll('details[data-key]')].map(d => [d.dataset.key, d.open]));
    const scroll = p.scrollTop;
    return { restore() { p.querySelectorAll('details[data-key]').forEach(d => { if (open.has(d.dataset.key)) d.open = open.get(d.dataset.key); }); p.scrollTop = scroll; } };
  }
  // ── confirmation popover: small box next to the click, one coloured action button ──
  // red = destructive (retirer, supprimer, abandonner…), orange = writes / reboots / flashes,
  // green = the rest. Click outside, Escape or « Annuler » cancels. Returns a Promise<boolean>.
  let lastPointer = { x: innerWidth / 2, y: innerHeight / 2 };
  document.addEventListener('mousedown', e => { lastPointer = { x: e.clientX, y: e.clientY }; }, true);
  function confirmBox(msg, opts = {}) {
    return new Promise(resolve => {
      const text = String(msg);
      const first = (text.match(/^[^\s?:!]+/) || ['Confirmer'])[0].replace(/[«»]/g, '');
      const tone = opts.tone || (/retirer|supprimer|abandonner|purger|oublier|effacer|perdus/i.test(text) ? 'red' : /écrire|flasher|redémarr|appliquer|rapatrier|appairer|scanner|coupe|unifier|aligner|envoyer|restaur|importer|allumer|vérifier|mettre|revenir/i.test(text) ? 'orange' : 'green');
      const label = opts.label || (first.length > 1 && first.length < 18 ? first.charAt(0).toUpperCase() + first.slice(1) : 'Confirmer');
      const [head, ...rest] = text.split('\n');
      const box = document.createElement('div'); box.className = 'pop';
      box.innerHTML = `<div class="pop-head">${esc(head)}</div>${rest.join('\n').trim() ? `<div class="pop-body">${esc(rest.join('\n').trim())}</div>` : ''}<div class="pop-actions"><button class="pop-cancel">Annuler</button><button class="pop-act ${tone}">${esc(label)}</button></div>`;
      document.body.appendChild(box);
      const W = box.offsetWidth, H = box.offsetHeight;
      let x = Math.min(Math.max(8, lastPointer.x - 20), innerWidth - W - 8), y = lastPointer.y + 12;
      if (y + H > innerHeight - 8) y = Math.max(8, lastPointer.y - H - 12);
      box.style.left = x + 'px'; box.style.top = y + 'px';
      const done = v => { document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', key, true); box.remove(); resolve(v); };
      const outside = e => { if (!box.contains(e.target)) { e.stopPropagation(); e.preventDefault(); done(false); } };
      const key = e => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } else if (e.key === 'Enter') { e.stopPropagation(); done(true); } };
      setTimeout(() => { document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', key, true); }, 0);
      box.querySelector('.pop-cancel').onclick = () => done(false);
      box.querySelector('.pop-act').onclick = () => done(true);
      box.querySelector('.pop-act').focus();
    });
  }
  function toast(msg, bad, ms) {
    const t = $('#toast'); t.textContent = msg; t.className = bad ? 'bad' : ''; t.style.display = 'block'; t.style.whiteSpace = 'pre-line';
    clearTimeout(t._t); t._t = setTimeout(() => t.style.display = 'none', ms || (bad ? 6000 : 2200));
  }

  // ── app updater (desktop shell only : window.__TAURI__ absent dans un onglet de navigateur) ──
  // Pas d'installateur : main.rs télécharge l'archive signée, l'extrait et remplace les
  // fichiers de code sur place, puis relance l'app. Un seul essai au démarrage, silencieux
  // hors ligne / hors app native / sans manifeste publié.
  async function checkAppUpdate() {
    if (!window.__TAURI__) return;
    try {
      const info = await window.__TAURI__.core.invoke('check_update');
      if (!info) return;
      const notes = (info.notes || '').trim().slice(0, 300);
      const go = await confirmBox(`Mise à jour WLED Fleet ${info.version} disponible${notes ? '\n' + notes : ''}`, { tone: 'green', label: 'Installer' });
      if (!go) return;
      toast('téléchargement et installation de la mise à jour…', false, 15000);
      await window.__TAURI__.core.invoke('install_update'); // l'app relance elle-même une fois prête
    } catch (e) { /* hors ligne, pas de manifeste publié, ou déjà à jour : silencieux */ }
  }

  // ── data ───────────────────────────────────────────────────────────────────
  async function api(path, opts) {
    const r = await fetch(path, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }
  async function loadColumns() {
    const j = await api('/api/columns'); COLS = j.columns; GROUPS = j.groups; LED_TYPES = j.ledTypes || {}; COLOR_ORDERS = j.colorOrders || {}; renderGroupBar(); renderHead();
  }
  // ── LED profiles: local library (led-profiles.json), shared by the Sorties/DMX table and its badge ──
  async function loadLedProfiles() {
    try { ledProfilesCache = (await api('/api/led-profiles')).profiles || []; } catch { /* keep the previous cache */ }
    updateDmxBadge();
    return ledProfilesCache;
  }
  // the node's own stored id (MQTT client id) wins if it still exists locally; otherwise Fleet
  // recognizes a profile whose type/order/pixels match this output exactly
  const profileIdFor = (o, r) => {
    if (o.profile && ledProfilesCache.some(x => x.id === o.profile)) return o.profile;
    const m = ledProfilesCache.find(x => Number(x.type) === Number(r.type) && Number(x.order) === ((r.order || 0) & 0x0f) && Number(x.len) === Number(o.len));
    return m ? m.id : '';
  };
  // every wired, counted output whose type/order/pixels match no profile in the local library
  function unrecognizedOutputs() {
    const list = [];
    for (const n of fleet.nodes) {
      const ins = (n.cfg && n.cfg.hw && n.cfg.hw.led && n.cfg.hw.led.ins) || [];
      const outs = (n.derived && n.derived.dmx && n.derived.dmx.outputs) || [];
      ins.forEach((r, i) => {
        const o = outs[i]; if (!o || o.ignored || !o.len) return;
        if (!profileIdFor(o, r)) list.push({ ip: n.meta.ip, name: (n.info && n.info.name) || n.meta.ip, index: i, pin: (r.pin || []).join('/'), type: r.type, order: (r.order || 0) & 0x0f, len: o.len });
      });
    }
    return list;
  }
  function updateDmxBadge() {
    const n = unrecognizedOutputs().length;
    const b = $('#btnDmx'); if (b) b.innerHTML = `Sorties / DMX${n ? ` <span class="n">${n}</span>` : ''}`;
  }
  async function refresh() {
    if (editing) return; // do not repaint under the user's cursor
    try {
      fleet = await api('/api/fleet');
      $('#liveDot').className = 'dot ok'; $('#liveTxt').textContent = 'à jour ' + new Date(fleet.updated).toLocaleTimeString();
      $('#roBadge').style.display = fleet.readonly ? '' : 'none';
      $('#btnScan').disabled = fleet.scanning; $('#btnScan').textContent = fleet.scanning ? 'scan en cours…' : 'Rescanner le réseau';
      if (fleet.lastScan) $('#lastScan').textContent = `dernier scan ${new Date(fleet.lastScan.at).toLocaleTimeString()} · ${fleet.lastScan.subnets.join(', ')} · ${fleet.lastScan.ms} ms`;
      const on = fleet.nodes.filter(n => n.meta.online).length;
      const px = fleet.nodes.reduce((a, n) => a + ((n.info && n.info.leds && n.info.leds.count) || 0), 0);
      renderSummary(); renderNodeGroups();
      // network sanity: is this PC actually on the fleet subnet?
      const nb = $('#netBadge'); const net = fleet.net;
      if (nb && fleet.maintenance) { nb.textContent = `⏸ ${fleet.maintenance.reason} : relevés en pause, la carte Wi‑Fi est occupée`; nb.className = 'badge ro'; nb.title = 'sur un PC relié en Wi‑Fi seulement, la flotte est injoignable pendant cette opération ; les relevés reprennent automatiquement dès que le PC retrouve le réseau du show'; }
      else if (nb && net) {
        const foreign = fleet.nodes.filter(x => x.meta.foreign).length;
        if (net.onFleetSubnet) { nb.textContent = `PC : ${net.fleetIface.address} (${net.fleetIface.iface})${foreign ? ` · ⚠ ${foreign} node(s) hors réseau` : ''}`; nb.className = 'badge' + (foreign ? ' ro' : ''); nb.title = `interfaces : ${net.ifaces.map(i => `${i.iface} ${i.address}`).join(', ')}${foreign ? `\n${foreign} node(s) répondent sur un autre sous-réseau du PC : bouton « ⇢ rapatrier » sur leur ligne` : ''}`; }
        else { nb.textContent = `⚠ PC hors du réseau ${net.subnets.join(' / ')}.x`; nb.className = 'badge ro'; nb.title = `le PC n'a aucune adresse dans le sous-réseau de la flotte. Interfaces actuelles : ${net.ifaces.map(i => `${i.iface} ${i.address}`).join(', ') || 'aucune'}. Brancher le câble / rejoindre le réseau du show, ou changer "subnet" dans settings.json. Les nodes reviendront seuls.`; }
      }
      renderBody();
      updateDmxBadge();
    } catch (e) {
      $('#liveDot').className = 'dot bad'; $('#liveTxt').textContent = 'serveur injoignable';
    }
  }

  // ── rendering ──────────────────────────────────────────────────────────────
  // name and ip are pinned on the left (always visible while scrolling); the rest is orderable
  const PINNED = ['__check', 'name', 'ip'];
  // essential view by default: columns flagged `adv` in columns.js stay hidden until « toutes les colonnes » is ticked
  let showAdv = false; try { showAdv = localStorage.getItem('wf.showAdv') === '1'; } catch { /* default */ }
  const visibleCols = () => orderedCols().filter(c => c.id !== 'ip' && !hiddenGroups.has(c.group) && (showAdv || !c.adv));

  const GROUP_HELP = { 'Identité': 'qui est ce node : nom, IP, matériel, version', 'Santé': 'est-il vivant et comment va-t-il : latence, uptime, RAM, FPS', 'Réseau': 'comment il est connecté : Wi‑Fi, IP fixe, signal, AP', 'Antenne': 'ce que le point d\'accès MikroTik voit de ce node : radio, canal, signal côté AP, débits, durée d\'association', 'LEDs': 'ce qu\'il pilote : pixels, sorties, limite de courant', 'Live': 'ce que la console lui envoie : E1.31 / Art-Net / DDP, univers, mode DMX', 'Sync': 'synchronisation entre nodes WLED', 'État': 'ce qu\'il fait maintenant : allumé, luminosité, preset', 'Défauts': 'ce qu\'il fait au démarrage', 'MAJ': 'maintenance du firmware : version disponible, dépôt local, verrou OTA' };
  function renderGroupBar() {
    const bar = $('#groupBar'); bar.innerHTML = '<span class="muted" style="font-size:12px" title="clic sur un groupe pour afficher / masquer ses colonnes">Colonnes :</span>';
    const nAdv = COLS.filter(c => c.adv).length, nEss = COLS.length - nAdv;
    const adv = document.createElement('label'); adv.className = 'chip'; adv.innerHTML = `<input type="checkbox" ${showAdv ? 'checked' : ''}> toutes les colonnes`;
    adv.title = `vue essentielle : ${nEss} colonnes utiles au quotidien (identité, santé, réseau, LEDs, univers, état). Cocher pour afficher aussi les ${nAdv} colonnes avancées (mDNS, RAM, débits antenne, ports, gamma…).`;
    adv.querySelector('input').onchange = e => { showAdv = e.target.checked; try { localStorage.setItem('wf.showAdv', showAdv ? '1' : '0'); } catch { /* ignore */ } renderGroupBar(); renderHead(); renderBody(); };
    bar.appendChild(adv);
    GROUPS.forEach(g => {
      const el = document.createElement('span'); el.className = 'chip gk-' + GROUPS.indexOf(g) + (hiddenGroups.has(g) ? ' off' : ''); const nG = COLS.filter(c => c.group === g && (showAdv || !c.adv)).length; el.innerHTML = `${esc(g)} <span class="muted" style="font-size:10px">${nG}</span>`;
      el.title = `${g} : ${GROUP_HELP[g] || ''}\n${hiddenGroups.has(g) ? 'clic pour afficher' : 'clic pour masquer'} ce groupe de colonnes`;
      el.onclick = () => { hiddenGroups.has(g) ? hiddenGroups.delete(g) : hiddenGroups.add(g); localStorage.setItem('wf.hiddenGroups', JSON.stringify([...hiddenGroups])); renderGroupBar(); renderHead(); renderBody(); };
      bar.appendChild(el);
    });
    const rst = document.createElement('button'); rst.className = 'rowbtn'; rst.style.marginLeft = 'auto'; rst.textContent = '↺ colonnes';
    rst.title = 'remettre l\'ordre, les largeurs et les groupes de colonnes par défaut';
    rst.onclick = resetLayout; bar.appendChild(rst);
  }

  // ── column layout: order + widths, Excel-style, persisted per browser ──────
  let colOrder = null, colWidths = {};
  try { colOrder = JSON.parse(localStorage.getItem('wf.colOrder') || 'null'); colWidths = JSON.parse(localStorage.getItem('wf.colWidths') || '{}'); } catch { /* defaults */ }
  const saveLayout = () => { try { localStorage.setItem('wf.colOrder', JSON.stringify(colOrder)); localStorage.setItem('wf.colWidths', JSON.stringify(colWidths)); } catch { /* ignore */ } };
  const widthOf = c => colWidths[c.id] || c.width || 100;
  const ACTIONS_W = () => showAdv ? 120 : 28, CHECK_COL = { id: '__check', width: 68 }; const checkW = () => widthOf(CHECK_COL);
  function orderedCols() {
    if (!colOrder) return COLS;
    const idx = new Map(colOrder.map((id, i) => [id, i]));
    return [...COLS].sort((a, b) => (idx.has(a.id) ? idx.get(a.id) : 1e6 + COLS.indexOf(a)) - (idx.has(b.id) ? idx.get(b.id) : 1e6 + COLS.indexOf(b)));
  }
  function moveColumn(id, beforeId) {
    if (id === beforeId || PINNED.includes(id) || PINNED.includes(beforeId)) return;
    const order = orderedCols().map(c => c.id).filter(x => x !== id);
    const at = beforeId === '__end' ? order.length : order.indexOf(beforeId);
    order.splice(at < 0 ? order.length : at, 0, id);
    colOrder = order; saveLayout(); renderHead(); renderBody();
  }
  async function resetLayout() {
    if (!await confirmBox('Revenir à l\'ordre, aux largeurs et aux groupes de colonnes par défaut ?')) return;
    colOrder = null; colWidths = {}; hiddenGroups.clear();
    saveLayout(); localStorage.setItem('wf.hiddenGroups', '[]');
    renderGroupBar(); renderHead(); renderBody();
  }
  function applyWidths() {
    const cols = visibleCols();
    const cg = $('#grid colgroup');
    if (!cg) return;
    const nameW = widthOf(COLS.find(c => c.id === 'name')), ipW = widthOf(COLS.find(c => c.id === 'ip'));
    const CHECK_W = checkW(); const ws = [CHECK_W, nameW, ipW, ...cols.filter(c => c.id !== 'name').map(widthOf), ACTIONS_W()];
    [...cg.children].forEach((col, i) => col.style.width = ws[i] + 'px');
    $('#grid').style.width = ws.reduce((a, b) => a + b, 0) + 'px';
    $('#grid').style.setProperty('--pin3-left', (CHECK_W + nameW) + 'px'); $('#grid').style.setProperty('--check-w', CHECK_W + 'px'); // the pinned IP column sits right after the name
  }
  // auto-fit: the column takes the width of its widest content (header label included),
  // like a double-click on a separator in Excel
  function fitWidth(id, apply = true) {
    if (id === '__check') return checkW(); // no content to measure
    let probe = $('#fitProbe');
    if (!probe) { probe = document.createElement('div'); probe.id = 'fitProbe'; probe.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;white-space:nowrap;display:inline-block;padding:0 8px'; document.body.appendChild(probe); }
    let w = 0;
    const th = $('#grid thead tr.cols') && $('#grid thead tr.cols').querySelector(`th[data-col="${CSS.escape(id)}"]`);
    if (th) { probe.style.font = getComputedStyle(th).font; const lbl = th.querySelector('.lbl'); probe.innerHTML = lbl ? lbl.innerHTML : th.textContent; w = probe.offsetWidth + 14; }
    const cells = $('#grid tbody').querySelectorAll(`td[data-col="${CSS.escape(id)}"] .cell`);
    if (cells.length) probe.style.font = getComputedStyle(cells[0]).font;
    cells.forEach(c => { probe.innerHTML = c.innerHTML; w = Math.max(w, probe.offsetWidth); });
    w = Math.min(600, Math.max(40, Math.ceil(w) + 4));
    colWidths[id] = w; if (apply) { saveLayout(); applyWidths(); }
    return w;
  }
  function fitAll() { ['name', 'ip', ...visibleCols().map(c => c.id)].forEach(id => fitWidth(id, false)); saveLayout(); applyWidths(); }
  // small context menu (right click), same look as the confirmation popovers.
  // item: { label, act, help?, danger?, checked?, sub?: [items] } or { sep: true } ; a sub opens to the right.
  function menuBox(x, y, items, parent) {
    if (!parent) document.querySelectorAll('.pop.menu').forEach(m => m.remove());
    const box = document.createElement('div'); box.className = 'pop menu';
    box.innerHTML = items.map((it, i) => it.sep ? '<div class="msep"></div>' : `<div class="mi${it.danger ? ' danger' : ''}${it.sub ? ' has-sub' : ''}${it.checked ? ' checked' : ''}" data-i="${i}" title="${esc(it.help || '')}">${esc(it.label)}${it.sub ? '<span class="arrow">▸</span>' : ''}</div>`).join('');
    document.body.appendChild(box);
    const r = box.getBoundingClientRect();
    let left = x; if (left + r.width > innerWidth - 8) left = parent ? parent.rect.left - r.width + 2 : innerWidth - r.width - 8;
    box.style.left = Math.max(4, left) + 'px'; box.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 8)) + 'px';
    let sub = null; const closeSub = () => { if (sub) { sub.close(); sub = null; } };
    const close = () => { closeSub(); document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', key, true); box.remove(); };
    const done = () => { close(); if (parent) parent.done(); };
    const outside = e => { if (!box.contains(e.target) && !(sub && sub.box.contains(e.target))) done(); };
    const key = e => { if (e.key === 'Escape') { e.stopPropagation(); done(); } };
    setTimeout(() => { document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', key, true); }, 0);
    box.querySelectorAll('.mi').forEach(m => {
      const it = items[+m.dataset.i];
      m.onmouseenter = () => { if (sub && sub.item === it) return; closeSub(); if (it.sub) { const rr = m.getBoundingClientRect(); sub = menuBox(rr.right - 2, rr.top - 4, it.sub, { done, rect: rr }); sub.item = it; } };
      m.onclick = () => { if (it.sub) { if (!sub) m.onmouseenter(); return; } done(); it.act(); };
    });
    return { box, close };
  }
  let justResized = false, colDrag = null, justColMoved = false;
  // column drag to reorder, pointer events — same principle as the row ⋮⋮ drag
  // (lift + neighbours slide out of the way) rather than native HTML5 drag/drop,
  // which never actually fired a drop in the desktop shell's webview.
  function colDragStart(th, id, e) {
    if (e.button !== 0 || colDrag || e.target.closest('.rs')) return;
    e.preventDefault();
    try { th.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const row = th.parentElement;
    const ths = [...row.querySelectorAll('th[data-col]')].filter(t => !PINNED.includes(t.dataset.col));
    const from = ths.indexOf(th); if (from < 0) return;
    const d = colDrag = { th, ths, from, to: from, x: e.clientX, startX: e.clientX, lefts: ths.map(t => t.offsetLeft), w: th.offsetWidth };
    th.classList.add('dragging'); document.body.classList.add('col-dragging');
    const place = () => {
      const dx = d.x - d.startX;
      d.th.style.transform = `translateX(${dx}px)`;
      const center = d.lefts[d.from] + d.w / 2 + dx;
      let to = 0; d.ths.forEach((t, i) => { if (i !== d.from && d.lefts[i] + t.offsetWidth / 2 < center) to++; });
      d.to = to;
      d.ths.forEach((t, i) => {
        if (i === d.from) return;
        const s = i > d.from && i <= to ? -d.w : i < d.from && i >= to ? d.w : 0;
        t.style.transform = s ? `translateX(${s}px)` : '';
      });
    };
    const finish = () => {
      if (colDrag !== d) return; colDrag = null;
      th.onpointermove = th.onpointerup = th.onpointercancel = null;
      d.ths.forEach(t => t.style.transform = ''); th.classList.remove('dragging'); document.body.classList.remove('col-dragging');
      if (d.to === d.from) return; // plain click: let th.onclick sort as usual
      justColMoved = true; setTimeout(() => justColMoved = false, 50);
      const seq = d.ths.slice(); const [mv] = seq.splice(d.from, 1); seq.splice(d.to, 0, mv);
      const beforeId = seq[d.to + 1] ? seq[d.to + 1].dataset.col : '__end';
      moveColumn(id, beforeId);
    };
    th.onpointermove = ev => { d.x = ev.clientX; place(); };
    th.onpointerup = finish; th.onpointercancel = finish;
  }
  function attachHeaderBehaviour(th) {
    const id = th.dataset.col;
    // sort on plain click
    th.onclick = () => { if (justResized || justColMoved) { justResized = false; return; } const k = th.dataset.sort; if (!k) return; if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = 1; } saveRowOrder(); renderHead(); renderBody(); };
    // drag to reorder (the pinned name / ip columns stay put)
    if (!PINNED.includes(id)) {
      th.classList.add('draggable');
      th.onpointerdown = e => colDragStart(th, id, e);
    }
    // right click: fit to content, this column or all of them
    th.oncontextmenu = e => {
      e.preventDefault(); e.stopPropagation();
      const col = COLS.find(c => c.id === id);
      const items = col ? [
        { label: `Ajuster « ${col.label} » au contenu`, help: 'largeur = la valeur la plus large de la colonne (comme un double-clic sur le séparateur)', act: () => fitWidth(id) },
        { label: 'Ajuster toutes les colonnes au contenu', act: fitAll },
        { sep: true },
        { label: `Largeur par défaut de « ${col.label} »`, act: () => { delete colWidths[id]; saveLayout(); applyWidths(); } },
        { label: 'Largeurs par défaut pour toutes les colonnes', act: () => { colWidths = {}; saveLayout(); applyWidths(); } },
        { sep: true },
        { label: 'Toutes les colonnes (avancées comprises)', checked: showAdv, act: () => { showAdv = !showAdv; try { localStorage.setItem('wf.showAdv', showAdv ? '1' : '0'); } catch { /* ignore */ } renderGroupBar(); renderHead(); renderBody(); } },
      ] : [{ label: 'Ajuster toutes les colonnes au contenu', act: fitAll }, { label: 'Largeurs par défaut pour toutes les colonnes', act: () => { colWidths = {}; saveLayout(); applyWidths(); } }];
      menuBox(e.clientX, e.clientY, items);
    };
    // resize handle on the right edge ; double-click = fit to content
    const rs = th.querySelector('.rs');
    if (rs) rs.ondblclick = e => { e.preventDefault(); e.stopPropagation(); fitWidth(id); justResized = true; setTimeout(() => justResized = false, 50); };
    if (rs) rs.onmousedown = e => {
      e.preventDefault(); e.stopPropagation();
      const col = COLS.find(c => c.id === id) || CHECK_COL; const x0 = e.clientX, w0 = widthOf(col);
      const mv = ev => { colWidths[id] = Math.max(40, Math.round(w0 + ev.clientX - x0)); applyWidths(); };
      const up = ev => { if (ev && ev.clientX !== undefined) mv(ev); document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); justResized = true; saveLayout(); setTimeout(() => justResized = false, 50); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    };
  }

  function renderHead() {
    const cols = visibleCols();
    const groupsRow = []; let i = 0;
    while (i < cols.length) { let j = i; while (j < cols.length && cols[j].group === cols[i].group) j++; groupsRow.push({ g: cols[i].group, span: j - i }); i = j; }
    const nameCol = COLS.find(c => c.id === 'name');
    const table = $('#grid'); let cg = table.querySelector('colgroup');
    if (!cg) { cg = document.createElement('colgroup'); table.insertBefore(cg, table.firstChild); }
    cg.innerHTML = '<col><col><col>' + cols.filter(c => c.id !== 'name').map(() => '<col>').join('') + '<col>';
    const ipCol = COLS.find(c => c.id === 'ip');
    const thead = $('#grid thead');
    const sortMark = c => sortKey === c.id ? `<span class="sort">${sortDir > 0 ? '▲' : '▼'}</span>` : '';
    const thHtml = c => `<th data-sort="${c.id}" data-col="${c.id}" class="gk-${GROUPS.indexOf(c.group)}" title="${esc(helpText(c))}"><span class="lbl">${esc(c.label)}${c.write ? ' <span class="muted">✎</span>' : ''}${c.reboot ? ' <span class="muted">⟳</span>' : ''}${sortMark(c)}</span><span class="rs" title="glisser pour redimensionner ; double-clic = ajuster au contenu ; clic droit sur l'en-tête = menu"></span></th>`;
    thead.innerHTML = `<tr class="groups"><th class="pin" style="background:var(--panel2)"></th><th class="pin2" style="background:var(--panel2)"></th><th class="pin3" style="background:var(--panel2)"></th>${groupsRow.map(g => `<th colspan="${g.span}" class="gk-${GROUPS.indexOf(g.g)}" title="groupe ${esc(g.g)} — les colonnes se déplacent en glissant leur en-tête, se redimensionnent par leur bord droit">${esc(g.g)}</th>`).join('')}<th></th></tr>` +
      `<tr class="cols"><th class="pin" data-col="__check" title="colonne de la poignée ⋮⋮ et des cases : tirer son bord droit pour l'élargir"><span class="hd"><span id="manualOrder" class="${sortKey === 'manual' ? 'sort' : 'muted'}" style="cursor:pointer" title="${sortKey === 'manual' ? 'ordre manuel actif : glisser les ⋮⋮ pour réordonner ; cliquer un en-tête pour trier autrement' : 'passer en ordre manuel (l\'ordre actuel devient le point de départ, puis glisser les ⋮⋮)'}">≡</span><input type="checkbox" id="selAll" title="cocher / décocher tous les nodes affichés"></span><span class="rs" title="glisser pour redimensionner la colonne des poignées"></span></th>` +
      `<th class="pin2" data-sort="name" data-col="name" title="${esc(helpText(nameCol))}"><span class="lbl">Nom${sortMark(nameCol)}</span><span class="rs" title="glisser pour redimensionner ; double-clic = ajuster au contenu ; clic droit sur l'en-tête = menu"></span></th>` +
      `<th class="pin3" data-sort="ip" data-col="ip" title="${esc(helpText(ipCol))}"><span class="lbl">IP${sortMark(ipCol)}</span><span class="rs" title="glisser pour redimensionner ; double-clic = ajuster au contenu ; clic droit sur l'en-tête = menu"></span></th>` +
      cols.filter(c => c.id !== 'name').map(thHtml).join('') +
      `<th data-col="__end" title="${showAdv ? 'actions par node ; ' : 'clic droit sur une ligne = actions ; '}déposer une colonne ici pour la mettre en dernier">${showAdv ? 'Actions' : ''}</th></tr>`;
    thead.querySelectorAll('th[data-col]').forEach(attachHeaderBehaviour);
    $('#selAll').onchange = e => { rows().forEach(n => e.target.checked ? selected.add(key(n)) : selected.delete(key(n))); renderBody(); };
    $('#manualOrder').onclick = () => { if (sortKey !== 'manual') { rowOrder = rows().map(rid); sortKey = 'manual'; saveRowOrder(); renderHead(); renderBody(); toast('ordre manuel : glisser les ⋮⋮ pour réordonner'); } };
    applyWidths();
  }
  // row drag & drop (⋮⋮ handle, pointer events): the row is lifted and follows the
  // pointer, the other rows slide to make room ; releasing writes the manual order.
  // While a row is in the air, polls do not re-render the grid.
  let rowDrag = null;
  function wireRowDrag(tbody) {
    tbody.querySelectorAll('.grip').forEach(g => g.onpointerdown = e => {
      if (e.button !== 0 || rowDrag || editing) return;
      const tr = g.closest('tr[data-rid]'); const trs = [...tbody.querySelectorAll('tr[data-rid], tr.ghead')];
      const from = trs.indexOf(tr); if (from < 0 || trs.length < 2) return;
      e.preventDefault(); e.stopPropagation(); try { g.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      const wrap = tbody.closest('.gridwrap');
      const d = rowDrag = { tr, trs, from, to: from, y: e.clientY, startY: e.clientY, startScroll: wrap.scrollTop, tops: trs.map(t => t.offsetTop), h: tr.offsetHeight, wrap };
      tr.classList.add('lifting'); document.body.classList.add('row-dragging');
      const place = () => {
        const dy = d.y - d.startY + (d.wrap.scrollTop - d.startScroll);
        d.tr.style.transform = `translateY(${dy}px)`;
        const center = d.tops[d.from] + d.h / 2 + dy;
        let to = 0; d.trs.forEach((t, i) => { if (i !== d.from && d.tops[i] + t.offsetHeight / 2 < center) to++; });
        d.to = to;
        d.trs.forEach((t, i) => {
          if (i === d.from) return;
          const s = i > d.from && i <= to ? -d.h : i < d.from && i >= to ? d.h : 0;
          t.style.transform = s ? `translateY(${s}px)` : '';
        });
      };
      const tick = () => { // auto-scroll near the top / bottom edge of the grid
        if (rowDrag !== d) return;
        const r = d.wrap.getBoundingClientRect(), top = r.top + 70, bottom = r.bottom - 40;
        if (d.y < top) d.wrap.scrollTop -= Math.min(20, (top - d.y) / 3); else if (d.y > bottom) d.wrap.scrollTop += Math.min(20, (d.y - bottom) / 3);
        place(); requestAnimationFrame(tick);
      };
      const finish = () => {
        if (rowDrag !== d) return; rowDrag = null;
        g.onpointermove = g.onpointerup = g.onpointercancel = null;
        d.trs.forEach(t => t.style.transform = ''); d.tr.classList.remove('lifting'); document.body.classList.remove('row-dragging');
        if (d.to === d.from) { renderBody(); return; } // polls were held back meanwhile
        const seq = d.trs.slice(); const [mv] = seq.splice(d.from, 1); seq.splice(d.to, 0, mv);
        let cur = null, newGroup = null; const shown = [];
        for (const t of seq) { if (t.classList.contains('ghead')) { cur = t.dataset.group; continue; } if (t === mv) newGroup = cur; shown.push(t.dataset.rid); }
        const base = sortKey === 'manual' ? rowOrder : fleet.nodes.map(rid);
        rowOrder = shown.concat(base.filter(r => !shown.includes(r))); // hidden (filtered / offline / collapsed) rows keep their relative place after the shown ones
        sortKey = 'manual'; saveRowOrder(); renderHead(); renderBody();
        if (newGroup !== null && newGroup !== groupOf(nodeOf(mv.dataset.ip))) setGroup([mv.dataset.ip], newGroup); // dropped under another group's header
      };
      g.onpointermove = ev => { d.y = ev.clientY; place(); };
      g.onpointerup = finish; g.onpointercancel = finish;
      place(); requestAnimationFrame(tick);
    });
  }

  function renderSummary() {
    const on = fleet.nodes.filter(n => n.meta.online).length;
    const px = fleet.nodes.reduce((a, n) => a + ((n.info && n.info.leds && n.info.leds.count) || 0), 0);
    $('#summary').textContent = `${on}/${fleet.nodes.length} nodes en ligne · ${px} pixels${selected.size ? ` · ${selected.size} ligne(s) cochée(s)` : ''}${cellSel.size > 1 ? ` · ${cellSel.size} cellules` : ''}${cellSel.size || selected.size ? ' · Échap désélectionne' : ''}`;
  }
  // reflect the row checkboxes (`selected`) without a full re-render
  function paintRows() {
    $('#grid tbody').querySelectorAll('tr[data-ip]').forEach(tr => { const on = selected.has(tr.dataset.ip); tr.classList.toggle('selected', on); const cb = tr.querySelector('input.sel'); if (cb) cb.checked = on; });
    $('#grid tbody').querySelectorAll('tr.ghead').forEach(tr => { const all = fleet.nodes.filter(n => groupOf(n) === tr.dataset.group); tr.querySelector('.gsel').checked = all.length > 0 && all.every(n => selected.has(key(n))); });
    renderSummary();
  }
  // ── Excel-like cell selection ─────────────────────────────────────────────
  // cellSel = Set of "ip|colId" ; active = the cell that Enter / F2 / typing edits ;
  // cellAnchor = origin of Shift ranges. Click = one cell, drag / Shift = rectangle,
  // Ctrl = add or remove, arrows move (Shift+arrows extend), double-click edits.
  const cellSel = new Set(); let active = null, cellAnchor = null;
  const selCols = () => ['name', 'ip', ...visibleCols().filter(c => c.id !== 'name').map(c => c.id)];
  function cellRange(a, b) { // rectangle between two cells, in visible row / column order
    const ips = rows().map(key), cols = selCols();
    let r1 = ips.indexOf(a.ip), r2 = ips.indexOf(b.ip), c1 = cols.indexOf(a.col), c2 = cols.indexOf(b.col);
    if (r1 < 0 || r2 < 0 || c1 < 0 || c2 < 0) return [];
    if (r1 > r2) [r1, r2] = [r2, r1]; if (c1 > c2) [c1, c2] = [c2, c1];
    const out = []; for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) out.push(pkey(ips[r], cols[c]));
    return out;
  }
  function paintCells() {
    const ak = active ? pkey(active.ip, active.col) : null;
    $('#grid tbody').querySelectorAll('td[data-col]').forEach(td => { const k = pkey(td.dataset.ip, td.dataset.col); td.classList.toggle('csel', cellSel.has(k)); td.classList.toggle('active', k === ak); });
    renderSummary();
  }
  const cellOf = el => { const td = el && el.closest && el.closest('#grid tbody td[data-col]'); return td && td.dataset.ip ? { ip: td.dataset.ip, col: td.dataset.col, td } : null; };
  const tdOf = c => c && $('#grid tbody').querySelector(`td[data-ip="${CSS.escape(c.ip)}"][data-col="${CSS.escape(c.col)}"]`);
  // ips of the selected cells of one column, in row order: the fill targets of an edit
  const columnTargets = colId => rows().map(key).filter(ip => cellSel.has(pkey(ip, colId)));
  function setRange(from, to, keep) { if (!keep) cellSel.clear(); cellRange(from, to).forEach(k => cellSel.add(k)); }
  function wireMouseSelect() {
    const tbody = $('#grid tbody');
    const inert = el => el.closest('button, a, input, select, textarea, .grip');
    let press = null, dragging = false, suppressClick = false;
    tbody.addEventListener('mousedown', e => {
      if (e.button !== 0 || inert(e.target) || (editing && editing.td.contains(e.target))) return;
      const c = cellOf(e.target); if (!c) return;
      if (editing) { const el = editing.td.querySelector('input,select'); if (el) el.blur(); } // click elsewhere closes the editor
      press = { cell: c, x: e.clientX, y: e.clientY, keep: e.ctrlKey || e.metaKey, base: new Set(cellSel) };
      dragging = false;
      e.preventDefault(); // no browser text selection
    });
    document.addEventListener('mousemove', e => {
      if (!press) return;
      if (!dragging && Math.abs(e.clientX - press.x) < 4 && Math.abs(e.clientY - press.y) < 4) return;
      const c = cellOf(document.elementFromPoint(e.clientX, e.clientY)); if (!c) return;
      if (!dragging && c.ip === press.cell.ip && c.col === press.cell.col) return;
      dragging = true;
      cellSel.clear(); if (press.keep) press.base.forEach(k => cellSel.add(k));
      cellRange(press.cell, c).forEach(k => cellSel.add(k));
      active = press.cell; cellAnchor = press.cell; paintCells();
    });
    document.addEventListener('mouseup', () => { if (!press) return; if (dragging) { suppressClick = true; setTimeout(() => suppressClick = false, 0); } press = null; dragging = false; });
    tbody.addEventListener('click', e => {
      if (suppressClick) { e.stopPropagation(); e.preventDefault(); suppressClick = false; return; }
      if (inert(e.target) || (editing && editing.td.contains(e.target))) return;
      const c = cellOf(e.target); if (!c) return;
      e.stopPropagation(); e.preventDefault();
      const k = pkey(c.ip, c.col);
      if (e.shiftKey) { setRange(cellAnchor || c, c, e.ctrlKey || e.metaKey); if (!cellAnchor) cellAnchor = c; active = c; }
      else if (e.ctrlKey || e.metaKey) { cellSel.has(k) ? cellSel.delete(k) : cellSel.add(k); active = c; cellAnchor = c; }
      else { cellSel.clear(); cellSel.add(k); active = c; cellAnchor = c; }
      paintCells();
    }, true);
    tbody.addEventListener('dblclick', e => { if (inert(e.target) || editing) return; const c = cellOf(e.target); if (c && c.td.classList.contains('rw')) startEdit(c.td); });
    document.addEventListener('keydown', e => {
      if (editing || document.querySelector('.pop') || !$('#grid').offsetParent) return;
      const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Escape') { if (cellSel.size || selected.size || active) { cellSel.clear(); active = null; selected.clear(); paintRows(); paintCells(); } return; }
      if (!active) return;
      const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Tab: [0, e.shiftKey ? -1 : 1] };
      if (arrows[e.key]) {
        e.preventDefault();
        const ips = rows().map(key), cols = selCols();
        const r = Math.min(Math.max(ips.indexOf(active.ip) + arrows[e.key][0], 0), ips.length - 1), c = Math.min(Math.max(cols.indexOf(active.col) + arrows[e.key][1], 0), cols.length - 1);
        const next = { ip: ips[r], col: cols[c] };
        if (e.shiftKey && e.key !== 'Tab') { cellAnchor = cellAnchor || active; setRange(cellAnchor, next, false); active = next; }
        else { cellSel.clear(); cellSel.add(pkey(next.ip, next.col)); active = next; cellAnchor = next; }
        paintCells(); const td = tdOf(next); if (td) td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        return;
      }
      const td = tdOf(active); if (!td) return;
      if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); if (td.classList.contains('rw')) startEdit(td); else toast('cette cellule n\'est pas modifiable'); return; }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && td.classList.contains('rw')) { // typing replaces the content, like Excel
        e.preventDefault(); startEdit(td); const el = td.querySelector('input'); if (el) el.value = e.key;
      }
    });
  }
  // after an edit confirmed with Enter, the active cell moves one row down (Excel)
  function moveActiveDown() {
    if (!active) return; const ips = rows().map(key); const r = ips.indexOf(active.ip);
    if (r < 0 || r + 1 >= ips.length) return; active = { ip: ips[r + 1], col: active.col }; cellAnchor = active; cellSel.clear(); cellSel.add(pkey(active.ip, active.col));
  }

  // ── node groups (Fleet-only label, column « Groupe ») : chips to filter the grid or check a whole group ──
  // ── node groups: tree rows in the grid (one header row per group, nodes below, collapsible) ──
  const groupOf = n => (n.meta && n.meta.group) || '';
  const groupNames = () => (fleet.groups || []).slice(); // declared + used, sorted by the server
  let collapsed = new Set(); try { collapsed = new Set(JSON.parse(localStorage.getItem('wf.collapsed') || '[]')); } catch { /* none */ }
  const saveCollapsed = () => { try { localStorage.setItem('wf.collapsed', JSON.stringify([...collapsed])); } catch { /* ignore */ } };
  function renderNodeGroups() { $('#groupList').innerHTML = groupNames().map(g => `<option value="${esc(g)}">`).join(''); }
  function groupMenu(e, g) {
    const members = fleet.nodes.filter(n => groupOf(n) === g);
    const items = [
      { label: members.every(n => selected.has(key(n))) ? 'Décocher ses nodes' : `Cocher ses ${members.length} node(s)`, act: () => { const all = members.every(n => selected.has(key(n))); members.forEach(n => all ? selected.delete(key(n)) : selected.add(key(n))); paintRows(); } },
      { label: collapsed.has(g) ? 'Déplier' : 'Replier', act: () => { collapsed.has(g) ? collapsed.delete(g) : collapsed.add(g); saveCollapsed(); renderBody(); } },
      { label: 'Tout replier', act: () => { [...groupNames(), ''].forEach(x => collapsed.add(x)); saveCollapsed(); renderBody(); } },
      { label: 'Tout déplier', act: () => { collapsed.clear(); saveCollapsed(); renderBody(); } },
    ];
    if (g) items.push({ sep: true },
      { label: `Renommer « ${g} »…`, act: async () => { const to = prompt(`Nouveau nom du groupe « ${g} » :`, g); if (!to || !to.trim() || to.trim() === g) return; try { await post('/api/groups', { name: to.trim(), rename: g }); } catch (err) { toast(err.message, true); } refresh(); } },
      { label: `Supprimer le groupe « ${g} »`, danger: true, help: 'ses nodes restent dans la liste, sans groupe', act: async () => { if (!await confirmBox(`Supprimer le groupe « ${g} » ? Ses ${members.length} node(s) restent dans la liste, sans groupe.`)) return; try { await api(`/api/groups/${encodeURIComponent(g)}`, { method: 'DELETE' }); } catch (err) { toast(err.message, true); } collapsed.delete(g); refresh(); } });
    menuBox(e.clientX, e.clientY, items);
  }

  // ── grid context menu: on a selection (cells and / or checked rows) or in the void ──
  const nodeOf = ip => fleet.nodes.find(n => key(n) === ip);
  const nameOf = ip => { const n = nodeOf(ip); return (n && n.info && n.info.name) || ip; };
  // Fleet-only fields written straight to the node's MQTT config (group, sorties non
  // utilisées, profils de sortie) : mis en attente (⏳) quand le node est hors ligne.
  const OFFLINE_FIELD_LABEL = { group: 'groupe', ignoredOutputs: 'sorties non utilisées', outputProfiles: 'profils de sortie' };
  async function setGroup(ips, g) {
    let queued = 0;
    for (const ip of ips) { try { const r = await post(`/api/node/${encodeURIComponent(ip)}/group`, { group: g }); if (r.queued) queued++; } catch (e) { toast(`${nameOf(ip)} : ${e.message}`, true); } }
    if (queued) toast(`${queued} node(s) hors ligne : le groupe sera proposé au retour (⏳ sur la ligne)`);
    await refresh(); renderBody();
  }
  function gridMenu(e) {
    e.preventDefault(); e.stopPropagation();
    const c = cellOf(e.target), tr = e.target.closest ? e.target.closest('tr[data-ip]') : null;
    const inSel = ip => selected.has(ip) || [...cellSel].some(k => k.startsWith(ip + '|'));
    if (c) { const k = pkey(c.ip, c.col); if (!cellSel.has(k) && !selected.has(c.ip)) { cellSel.clear(); cellSel.add(k); active = c; cellAnchor = c; paintCells(); } } // a cell outside the selection becomes the selection
    else if (tr && !inSel(tr.dataset.ip)) { cellSel.clear(); active = null; selected.add(tr.dataset.ip); paintRows(); paintCells(); } // handle / actions area of a row
    if (!c && !tr) { // the void
      menuBox(e.clientX, e.clientY, [
        { label: 'Nouveau groupe (vide)…', help: 'une ligne de groupe vide apparaît dans la grille : y glisser des nodes', act: async () => { const g = prompt('Nom du nouveau groupe :'); if (!g || !g.trim()) return; try { await post('/api/groups', { name: g.trim() }); } catch (err) { toast(err.message, true); } refresh(); } },
        { label: 'Ajuster toutes les colonnes au contenu', act: fitAll },
        ...(cellSel.size || selected.size ? [{ sep: true }, { label: 'Tout désélectionner', act: () => { cellSel.clear(); active = null; selected.clear(); paintRows(); paintCells(); } }] : []),
      ]);
      return;
    }
    const ips = rows().map(key).filter(inSel);
    const n = ips.length, lbl = n === 1 ? nameOf(ips[0]) : `${n} nodes`;
    const cur = new Set(ips.map(ip => groupOf(nodeOf(ip)))); const is = g => cur.size === 1 && cur.has(g);
    const groupSub = [
      { label: 'Non groupé', checked: is(''), act: () => setGroup(ips, '') },
      ...(fleet.groups || []).map(g => ({ label: g, checked: is(g), act: () => setGroup(ips, g) })),
      { sep: true },
      { label: 'Nouveau groupe…', act: async () => { const g = prompt(`Nom du nouveau groupe pour ${lbl} :`); if (g && g.trim()) await setGroup(ips, g.trim()); } },
    ];
    const items = [{ label: 'Groupe', sub: groupSub, help: `${lbl} : choisir le groupe (Group topic MQTT du node, écrit tout de suite)` }];
    // right-click the name / mDNS / AP-SSID cell of one node: push that cell's value as
    // the reference into the other two (same server endpoint as the ≡ unifier row button —
    // showAdv only, easy to miss — but any of the three fields can now be the source,
    // not just the name)
    if (c && ['name', 'mdns', 'apssid'].includes(c.col) && !fleet.readonly) {
      const node = nodeOf(c.ip);
      if (node && node.info) {
        const col = COLS.find(x => x.id === c.col);
        const p = pending.get(pkey(c.ip, c.col));
        const value = p ? p.value : (get(node, col.path) ?? (c.col === 'name' ? node.info.name : undefined));
        if (value) {
          items.push({ label: `Renommer « ${nameOf(c.ip)} » d'après cette cellule`, help: `« ${value} » (${col.label}) devient le nom, le mDNS (forme d'hôte) et le SSID de l'AP de ce node — les trois s'alignent dessus. Redémarrage nécessaire, lancé automatiquement.`, act: async () => {
            if (!await confirmBox(`Aligner nom / mDNS / SSID de l'AP de « ${nameOf(c.ip)} » sur « ${value} » ?\n\nRedémarrage immédiat.`)) return;
            try { const r = await post(`/api/node/${encodeURIComponent(c.ip)}/unify`, { name: value, reboot: true }); toast(`${nameOf(c.ip)} : nom / mDNS / AP = ${r.name}, redémarrage`); } catch (e) { toast(e.message, true); }
          } });
        }
      }
    }
    // right-click a cell that's part of a multi-cell selection in one column: offer to
    // align the other selected cells of that column on THIS one (same fillBox as Entrée
    // sur une cellule éditée, juste sans avoir à retaper la valeur)
    if (c) {
      const col = COLS.find(x => x.id === c.col);
      const targets = col ? columnTargets(c.col) : [];
      if (col && col.write && !fleet.readonly && targets.length > 1 && targets.includes(c.ip) && nodeOf(c.ip)) {
        const p = pending.get(pkey(c.ip, col.id));
        const value = p ? p.value : get(nodeOf(c.ip), col.path);
        items.push({ label: `Aligner « ${col.label} » sur « ${nameOf(c.ip)} » (${targets.length} cellules)`, help: `propose la même valeur — ou incrémentale — pour les ${targets.length - 1} autre(s) cellule(s) sélectionnée(s) de cette colonne, à partir de celle-ci ; rien n'est envoyé avant Déployer`, act: async () => {
          const chosen = await fillBox(col, value, c.ip, targets);
          if (!chosen) return;
          if (col.local) {
            for (const { ip: t, value: v } of chosen) { try { await post(`/api/node/${encodeURIComponent(t)}/${col.write.path}`, { [col.write.path]: v }); } catch (e) { toast(`${t} : ${e.message}`, true); } }
            await refresh(); renderBody(); return;
          }
          for (const { ip: t, value: v } of chosen) stageValue(t, col, v);
          updatePendingUI(); renderBody();
        } });
      }
    }
    // documented WLED defaults for the selected cells (columns that carry `def`)
    const cells = [...cellSel].map(k => { const i = k.indexOf('|'); return { ip: k.slice(0, i), col: COLS.find(x => x.id === k.slice(i + 1)) }; }).filter(x => x.col && x.col.def !== undefined && x.col.write && !fleet.readonly && nodeOf(x.ip));
    if (cells.length) {
      const what = [...new Set(cells.map(x => `${x.col.label} = ${raw(x.col, x.col.def)}`))].join(', ');
      items.push({ label: `Valeur par défaut WLED (${cells.length} cellule${cells.length > 1 ? 's' : ''})`, help: `met en attente : ${what} — rien n'est envoyé avant Déployer`, act: () => { cells.forEach(x => stageValue(x.ip, x.col, x.col.def)); updatePendingUI(); renderBody(); } });
    }
    items.push({ sep: true });
    items.push({ label: `Identifier ${lbl} (blanc 3 s)`, act: () => ips.forEach(ip => action('identify', ip)) });
    items.push({ label: `Redémarrer ${lbl}`, help: 'nécessaire après les réglages marqués ⟳ (mDNS, ports, multicast)', act: async () => { if (!await confirmBox(`Redémarrer ${lbl} ?`)) return; for (const ip of ips) { try { await post(`/api/node/${encodeURIComponent(ip)}/reboot`, {}); } catch (err) { toast(`${nameOf(ip)} : ${err.message}`, true); } } toast(`redémarrage envoyé à ${lbl}`); } });
    if (n === 1) items.push({ label: `Télécharger le cfg.json de ${lbl}`, help: 'sauvegarde de toute la configuration de ce node', act: () => { const a = document.createElement('a'); a.href = `/api/node/${encodeURIComponent(ips[0])}/cfg`; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); } });
    items.push({ label: `Retirer ${lbl} de la liste`, danger: true, help: 'oublie la ligne ; le node réapparaît au prochain scan s\'il répond', act: async () => {
      if (!await confirmBox(`Retirer ${lbl} de la liste ? (réapparaît au prochain scan s'il répond)`)) return;
      for (const ip of ips) { try { await api(`/api/nodes/${encodeURIComponent(ip)}`, { method: 'DELETE' }); } catch (err) { toast(`${nameOf(ip)} : ${err.message}`, true); } selected.delete(ip); }
      cellSel.clear(); active = null; refresh();
    } });
    items.push({ sep: true }, { label: 'Tout désélectionner', act: () => { cellSel.clear(); active = null; selected.clear(); paintRows(); paintCells(); } });
    menuBox(e.clientX, e.clientY, items);
  }

  function rows() { // what the grid shows, in order: by group (ungrouped last), then the column sort or the manual order
    let list = rowsFlat();
    const gn = groupNames();
    if (gn.length) { const gi = g => g ? gn.indexOf(g) : gn.length; list = list.filter(n => !collapsed.has(groupOf(n))); list.sort((a, b) => gi(groupOf(a)) - gi(groupOf(b))); }
    return list;
  }
  function rowsFlat() {
    const f = $('#filter').value.trim().toLowerCase();
    const hide = $('#hideOffline').checked;
    let list = fleet.nodes.filter(n => !(hide && !n.meta.online));
    if (f) list = list.filter(n => JSON.stringify([n.meta.ip, n.info && n.info.name, n.info && n.info.mac, n.derived]).toLowerCase().includes(f));
    if (sortKey === 'manual') { // user-defined order; unknown nodes go last, by name
      const idx = new Map(rowOrder.map((r, i) => [r, i]));
      list.sort((a, b) => { const ia = idx.has(rid(a)) ? idx.get(rid(a)) : 1e9, ib = idx.has(rid(b)) ? idx.get(rid(b)) : 1e9; return ia - ib || String((a.info || {}).name || key(a)).localeCompare(String((b.info || {}).name || key(b))); });
      return list;
    }
    const col = COLS.find(c => c.id === sortKey) || COLS[0];
    // IPs sort by octet value (192.168.88.81 before .241), not as text
    const ipNum = s => String(s).split(':')[0].split('.').reduce((a, o) => a * 256 + (+o || 0), 0);
    const val = n => { const v = get(n, col.path); return col.id === 'ip' && v != null ? ipNum(v) : v; };
    list.sort((a, b) => { const va = val(a), vb = val(b); if (va == null) return 1; if (vb == null) return -1; return (va < vb ? -1 : va > vb ? 1 : 0) * sortDir; });
    return list;
  }

  function modes(list, cols) {
    // most common value per column, used to highlight outliers
    const out = {};
    cols.forEach(c => {
      const count = new Map();
      list.forEach(n => { const v = JSON.stringify(get(n, c.path)); if (v !== undefined) count.set(v, (count.get(v) || 0) + 1); });
      let best, bestN = 0; count.forEach((k, v) => { if (k > bestN) { bestN = k; best = v; } });
      out[c.id] = { mode: best, n: bestN, distinct: count.size };
    });
    return out;
  }

  function renderBody() {
    if (rowDrag) return; // a row is being dragged: keep the DOM still, the drop re-renders
    const cols = visibleCols().filter(c => c.id !== 'name');
    const nameCol = COLS.find(c => c.id === 'name');
    const list = rows();
    const diffOn = $('#diffToggle').checked;
    const m = diffOn ? modes(list, cols) : {};
    const tbody = $('#grid tbody');
    const nodeRow = n => {
      const k = key(n);
      const cells = cols.map(c => {
        const live = get(n, c.path);
        const p = pending.get(pkey(k, c.id));
        const v = p ? p.value : live;
        const isDiff = diffOn && !c.nodiff && m[c.id].distinct > 1 && list.length > 2 && JSON.stringify(live) !== m[c.id].mode;
        const cls = ['gk-' + GROUPS.indexOf(c.group), c.write && !fleet.readonly ? 'rw' : '', c.type === 'num' ? 'num' : '', isDiff ? 'diff' : '', p ? 'pending' : ''].filter(Boolean).join(' ') + changedCls(k, c.id);
        const ch = recentChanges.get(pkey(k, c.id));
        const title = (p ? `en attente : ${raw(c, live)} → ${raw(c, v)}\n\n` : ch ? `modifié ${ch.source} à ${new Date(ch.at).toLocaleTimeString()} : ${raw(c, ch.old)} → ${raw(c, ch.new)}\n\n` : '') + helpText(c);
        return `<td class="${cls}" data-ip="${esc(k)}" data-col="${c.id}" title="${esc(title)}"><span class="cell">${display(c, v)}</span></td>`;
      }).join('');
      const pn = pending.get(pkey(k, 'name'));
      const name = pn ? pn.value : (get(n, nameCol.path) ?? (n.info && n.info.name) ?? '');
      const pr = presenceHtml(n);
      const oq = n.meta.offlineQueue;
      const oqWhat = oq ? Object.keys(oq).map(f => OFFLINE_FIELD_LABEL[f] || f).join(', ') : '';
      const nameTitle = [n.meta.err, pr.status, n.derived && n.derived.nameMismatch ? n.derived.nameMismatch + ' — bouton ≡ unifier en bout de ligne' : '', oq ? `⏳ en attente (${oqWhat}) — ${n.meta.online ? 'cliquer pour envoyer ou abandonner' : 'sera proposé au retour du node'}` : ''].filter(Boolean).join('\n');
      return `<tr class="${n.meta.online ? '' : 'offline'}${selected.has(k) ? ' selected' : ''}" data-ip="${esc(k)}" data-rid="${esc(rid(n))}">` +
        `<td class="pin"><span class="cell"><span class="grip" title="glisser pour réordonner les lignes (passe en ordre manuel)"></span><input type="checkbox" class="sel" title="cocher la ligne pour les actions (identifier, préréglage, mise à jour)" ${selected.has(k) ? 'checked' : ''}></span></td>` +
        `<td class="pin2 ${nameCol.write && !fleet.readonly ? 'rw' : ''}${pn ? ' pending' : ''}${changedCls(k, 'name')}" data-ip="${esc(k)}" data-col="name" title="${esc(nameTitle)}"><span class="cell"><span class="dot ${pr.cls}"></span>${pr.bars}<button class="idbtn" data-act="identify" title="identifier : allume ce node en blanc plein 3 s (même sous flux E1.31 / DDP) puis rétablit son état ; rien n'est écrit en mémoire">💡</button>${oq ? `<button class="idbtn" data-act="offline-queue" style="color:var(--warn)" title="${esc(`en attente (${oqWhat}) — ${n.meta.online ? 'cliquer pour envoyer au node ou abandonner' : 'sera proposé dès que le node répond'}`)}">⏳</button>` : ''}${esc(name)}${n.derived && n.derived.nameMismatch ? ' <span style="color:var(--warn)" title="' + esc(n.derived.nameMismatch) + '">≠</span>' : ''}${n.meta.pending ? ' <span class="muted">…</span>' : ''}</span></td>` +
        `<td class="pin3${n.meta.foreign ? ' chg-ext' : ''}" data-ip="${esc(k)}" data-col="ip" title="${esc(helpText(COLS.find(c => c.id === 'ip')))}"><span class="cell">${display(COLS.find(c => c.id === 'ip'), k)}</span></td>` +
        cells +
        (!showAdv ? '<td></td>' : `<td><span class="cell"><a class="rowbtn" href="/api/node/${encodeURIComponent(k)}/cfg" title="télécharger le cfg.json complet de ce node (sauvegarde de toute sa configuration)">⬇ cfg</a>` +
        `${n.meta.foreign ? `<button class="rowbtn" data-act="relocate" style="color:var(--warn)" title="ce node répond sur ${esc(k.split('.').slice(0, 3).join('.'))}.x, hors du réseau de la flotte ${esc((fleet.net && fleet.net.subnets || []).join('/'))}.x. Rapatrier = lui écrire une IP fixe libre dans le bon sous-réseau (même SSID, mot de passe conservé) et le redémarrer.">⇢ rapatrier</button>` : ''}` +
        `${n.derived && n.derived.nameMismatch ? `<button class="rowbtn" data-act="unify" style="color:var(--warn)" title="${esc(n.derived.nameMismatch)}. Unifier = mettre le mDNS et le SSID de l'AP au nom du node (mDNS en forme d'hôte : minuscules, tirets), puis redémarrer.">≡ unifier</button>` : ''}` +
        `<button class="rowbtn" data-act="reboot" title="redémarrer ce node (nécessaire après les réglages marqués ⟳ : mDNS, ports, multicast)">⟳</button><button class="rowbtn danger" data-act="forget" title="retirer ce node de la liste (il réapparaîtra au prochain scan s'il répond)">✕</button></span></td>`) + '</tr>';
    };
    const headerRow = (g, all, shown) => {
      const on = all.filter(n => n.meta.online).length, px = all.reduce((a, n) => a + ((n.info && n.info.leds && n.info.leds.count) || 0), 0);
      const isC = collapsed.has(g), allChecked = all.length > 0 && all.every(n => selected.has(key(n)));
      return `<tr class="ghead${isC ? ' closed' : ''}" data-group="${esc(g)}">` +
        `<td class="pin"><span class="cell"><span class="chev" title="${isC ? 'déplier' : 'replier'} le groupe">${isC ? '▸' : '▾'}</span><input type="checkbox" class="gsel" ${allChecked ? 'checked' : ''} title="cocher / décocher tous les nodes du groupe"></span></td>` +
        `<td class="pin2"><span class="cell gname" title="${g ? 'groupe « ' + esc(g) + ' » — double-clic : replier / déplier ; clic droit : renommer, supprimer ; glisser un node sous cette ligne pour l\'y mettre' : 'nodes sans groupe — glisser un node ici pour le sortir de son groupe'}">${g ? esc(g) : '<i>Sans groupe</i>'}</span></td>` +
        `<td class="pin3"><span class="cell muted">${all.length} node${all.length > 1 ? 's' : ''}</span></td>` +
        `<td colspan="${cols.length + 1}"><span class="cell muted">${all.length ? `${on}/${all.length} en ligne · ${px} px` : 'vide — glisser des nodes ici'}${shown.length < all.length && !isC ? ` · ${all.length - shown.length} masqué(s) par le filtre` : ''}</span></td></tr>`;
    };
    const gn = groupNames(); let html = '';
    if (gn.length) {
      for (const g of [...gn, '']) {
        const all = fleet.nodes.filter(n => groupOf(n) === g);
        if (!g && !all.length) continue; // every node is in a group: no « Sans groupe » row
        html += headerRow(g, all, list.filter(n => groupOf(n) === g)) + list.filter(n => groupOf(n) === g).map(nodeRow).join('');
      }
    } else html = list.map(nodeRow).join('');
    tbody.innerHTML = html;
    tbody.querySelectorAll('tr.ghead').forEach(tr => {
      const g = tr.dataset.group;
      tr.querySelector('.chev').onclick = () => { collapsed.has(g) ? collapsed.delete(g) : collapsed.add(g); saveCollapsed(); renderBody(); };
      tr.querySelector('.gname').ondblclick = () => tr.querySelector('.chev').click();
      tr.querySelector('.gsel').onchange = e => { fleet.nodes.filter(n => groupOf(n) === g).forEach(n => e.target.checked ? selected.add(key(n)) : selected.delete(key(n))); renderBody(); };
      tr.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); groupMenu(e, g); };
    });
    tbody.querySelectorAll('input.sel').forEach(cb => cb.onchange = e => { const ip = cb.closest('tr').dataset.ip; e.target.checked ? selected.add(ip) : selected.delete(ip); renderBody(); });
    wireRowDrag(tbody);
    tbody.querySelectorAll('button[data-act]').forEach(b => b.onclick = () => action(b.dataset.act, b.closest('tr').dataset.ip));
    paintCells();
  }

  // ── editing ────────────────────────────────────────────────────────────────
  function startEdit(td) {
    if (editing && !document.contains(editing.td)) editing = null; // editor lost in a re-render: never stay stuck
    if (editing) return;
    const col = COLS.find(c => c.id === td.dataset.col);
    const node = fleet.nodes.find(n => key(n) === td.dataset.ip);
    const staged = pending.get(pkey(td.dataset.ip, col.id));
    const cur = staged ? staged.value : get(node, col.path);
    editing = { td, col, ip: td.dataset.ip, old: td.innerHTML };
    let el;
    if (col.type === 'bool') { el = document.createElement('select'); el.innerHTML = `<option value="true">oui</option><option value="false">non</option>`; el.value = String(!!cur); }
    else if (col.type === 'enum') { el = document.createElement('select'); el.innerHTML = Object.entries(col.enum).map(([k, v]) => `<option value="${k}">${esc(v)} (${k})</option>`).join(''); el.value = String(cur); }
    else { el = document.createElement('input'); el.type = col.type === 'num' ? 'number' : 'text'; el.value = cur ?? ''; if (col.id === 'group') el.setAttribute('list', 'groupList'); if (col.min !== undefined) el.min = col.min; if (col.max !== undefined) el.max = col.max; }
    td.innerHTML = ''; td.appendChild(el); el.focus(); if (el.select) el.select();
    const cancel = () => { td.innerHTML = editing.old; editing = null; };
    el.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(el.value, true); } else if (e.key === 'Escape') { e.stopPropagation(); cancel(); } };
    el.onblur = () => { if (editing && editing.td === td) cancel(); };
    if (el.tagName === 'SELECT') el.onchange = () => commit(el.value);
  }

  // typed value from the editor -> same JS type as the live value, so that
  // "unchanged" edits can be dropped from the staging area
  function normalize(col, value) {
    if (col.type === 'bool') return value === true || value === 'true';
    if (col.type === 'num' || col.type === 'enum') return Number(value);
    return String(value);
  }

  // Enter in a cell only STAGES the change; nothing reaches a node before Déployer.
  async function commit(value, moveDown) {
    // clear `editing` before touching the DOM: removing the input fires blur,
    // whose handler would otherwise run cancel() on top of this commit
    const { td, col, ip, old } = editing;
    editing = null; td.innerHTML = old;
    // several rows selected: same value for all, or incremental (universes, IPs, numbered names…)
    let plan = [{ ip, value: normalize(col, value) }];
    let targets = columnTargets(col.id); if (!(targets.length > 1 && targets.includes(ip))) targets = selected.has(ip) && selected.size > 1 ? rows().map(key).filter(k => selected.has(k)) : [];
    if (targets.length > 1) {
      const chosen = await fillBox(col, value, ip, targets);
      if (!chosen) return;
      plan = chosen;
    }
    if (col.local) { // Fleet-only label (groupe…) : written to the server now, nothing goes to the node, no Déployer
      for (const { ip: t, value: v } of plan) { try { await post(`/api/node/${encodeURIComponent(t)}/${col.write.path}`, { [col.write.path]: v }); } catch (e) { toast(`${t} : ${e.message}`, true); } }
      if (moveDown && targets.length <= 1) moveActiveDown();
      await refresh(); renderBody(); return;
    }
    for (const { ip: t, value: v } of plan) stageValue(t, col, v);
    if (moveDown && targets.length <= 1) moveActiveDown();
    updatePendingUI();
    renderBody();
  }

  // stage one value for one node / column (dropped if equal to the live value)
  function stageValue(t, col, v) {
    const node = fleet.nodes.find(n => key(n) === t);
    const live = node ? get(node, col.path) : undefined;
    if (JSON.stringify(live) === JSON.stringify(v)) pending.delete(pkey(t, col.id)); // back to the live value
    else if (col.id === 'staticip' && !/^dhcp$/i.test(String(v)) && !/^(\d{1,3}\.){3}\d{1,3}$/.test(String(v))) toast(`${t} : IP fixe attendue (ex. 192.168.88.84) ou DHCP`, true);
    else pending.set(pkey(t, col.id), { ip: t, col, value: v });
  }
  // pixel calculator popover: LEDs / m × length → pixels (and universes for that LED type)
  function calcBox(anchor, pxPerUni, rgbw) {
    return new Promise(resolve => {
      const box = document.createElement('div'); box.className = 'pop';
      const r = anchor.getBoundingClientRect();
      box.innerHTML = `<div class="pop-head">Calcul de pixels ${rgbw ? '(RGBW : 128 px par univers)' : '(RGB : 170 px par univers)'}</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0"><label>LEDs / m <select id="cDens"><option>30</option><option selected>60</option><option>96</option><option>120</option><option>144</option><option value="">autre…</option></select></label><input type="number" id="cDensX" style="width:70px;display:none" placeholder="LEDs/m" min="1"><label>longueur <input type="number" id="cLen" style="width:80px" step="0.1" min="0" placeholder="m"> m</label></div>
        <div id="cOut" class="muted" style="margin-bottom:6px">…</div>
        <div class="pop-actions"><button class="pop-cancel">Annuler</button><button class="pop-act primary" disabled>Utiliser</button></div>`;
      document.body.appendChild(box);
      const bw = box.getBoundingClientRect(); box.style.left = Math.max(4, Math.min(r.left, innerWidth - bw.width - 8)) + 'px'; box.style.top = Math.max(4, Math.min(r.bottom + 4, innerHeight - bw.height - 8)) + 'px';
      const dens = box.querySelector('#cDens'), densX = box.querySelector('#cDensX'), len = box.querySelector('#cLen'), out = box.querySelector('#cOut'), act = box.querySelector('.pop-act');
      let px = null;
      const calc = () => { const dv = dens.value === '' ? Number(densX.value) : Number(dens.value); const lv = Number(len.value); px = dv > 0 && lv > 0 ? Math.round(dv * lv) : null; act.disabled = px == null; out.textContent = px == null ? 'LEDs par mètre × longueur' : `${px} pixels → ${Math.ceil(px / pxPerUni)} univers (${pxPerUni} px par univers)`; };
      dens.onchange = () => { densX.style.display = dens.value === '' ? '' : 'none'; if (dens.value === '') densX.focus(); calc(); }; densX.oninput = calc; len.oninput = calc;
      const done = v => { document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', keyH, true); box.remove(); resolve(v); };
      const outside = e => { if (!box.contains(e.target)) done(null); };
      const keyH = e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } else if (e.key === 'Enter' && px != null) { e.stopPropagation(); done(px); } };
      setTimeout(() => { document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', keyH, true); len.focus(); }, 0);
      box.querySelector('.pop-cancel').onclick = () => done(null); act.onclick = () => done(px);
    });
  }
  // Incremental fill: the edited row is the anchor; selected rows are walked in the
  // grid's current order (manual order = the sequence you want). Returns [{ip, value}] or null.
  function stepValue(col, base, k, step) {
    if (col.id === 'staticip') { const m = /^(\d+\.\d+\.\d+)\.(\d+)$/.exec(String(base)); if (!m) return base; const last = Number(m[2]) + k * step; return last >= 1 && last <= 254 ? `${m[1]}.${last}` : null; }
    if (col.type === 'num' || col.type === 'enum') return Number(base) + k * step;
    const m = /^(.*?)(\d+)$/.exec(String(base)); // "PIXY_LIANA_001" -> "PIXY_LIANA_" + 001
    if (m) { const n = Number(m[2]) + k * step; return n < 0 ? null : m[1] + String(n).padStart(m[2].length, '0'); }
    return base;
  }
  function fillBox(col, value, anchorIp, targets) {
    return new Promise(resolve => {
      const order = targets.slice(); if (!order.includes(anchorIp)) order.unshift(anchorIp);
      const a = order.indexOf(anchorIp);
      const anchorNode = fleet.nodes.find(n => key(n) === anchorIp);
      const canStep = col.id === 'staticip' || col.type === 'num' || /\d+$/.test(String(value));
      const defaultStep = col.id === 'dmxuni' && anchorNode && anchorNode.derived && anchorNode.derived.dmx ? (anchorNode.derived.dmx.universesUsed || 1) : 1;
      const box = document.createElement('div'); box.className = 'pop'; box.style.maxWidth = '520px';
      const preview = (mode, step) => order.map((ip, i) => { const n = fleet.nodes.find(x => key(x) === ip); const v = mode === 'same' ? normalize(col, value) : stepValue(col, normalize(col, value), i - a, step); return { ip, name: (n && n.info && n.info.name) || ip, value: v }; });
      const render = () => {
        const mode = box.querySelector('input[name=fm]:checked').value, step = Number(box.querySelector('#fstep').value) || 1;
        const rows_ = preview(mode, step);
        box.querySelector('.pop-body').innerHTML = rows_.map(r => `${esc(r.name)}${r.ip === anchorIp ? ' (édité)' : ''} → <b>${r.value == null ? '<span class="st-bad">hors plage</span>' : esc(raw(col, r.value))}</b>`).join('\n');
        box.querySelector('.pop-act').disabled = rows_.some(r => r.value == null);
      };
      box.innerHTML = `<div class="pop-head">${esc(col.label)} sur ${order.length} nodes sélectionnés</div>
        <div style="display:flex;gap:12px;align-items:center;margin:4px 0 6px;flex-wrap:wrap">
          <label class="chip"><input type="radio" name="fm" value="same" ${canStep ? '' : 'checked'}> même valeur « ${esc(value)} »</label>
          <label class="chip" ${canStep ? '' : 'style="opacity:.4"'}><input type="radio" name="fm" value="step" ${canStep ? 'checked' : 'disabled'}> incrémental, pas <input type="number" id="fstep" value="${defaultStep}" style="width:60px" title="${col.id === 'dmxuni' ? 'univers consommés par le node édité : les suivants s\'enchaînent sans trou ni chevauchement' : col.id === 'staticip' ? 'dernier octet + pas' : 'valeur + pas, dans l\'ordre des lignes'}"></label>
        </div><div class="pop-body" style="white-space:pre-line"></div>
        <div class="muted" style="font-size:11px">ordre = celui des lignes de la grille (≡ ordre manuel pour le choisir) ; la ligne éditée est l'ancre, les autres s'écartent vers le haut et le bas</div>
        <div class="pop-actions"><button class="pop-cancel">Annuler</button><button class="pop-act green">Mettre en attente</button></div>`;
      document.body.appendChild(box);
      const W = box.offsetWidth, H = box.offsetHeight;
      let x = Math.min(Math.max(8, lastPointer.x - 20), innerWidth - W - 8), y = lastPointer.y + 12; if (y + H > innerHeight - 8) y = Math.max(8, lastPointer.y - H - 12);
      box.style.left = x + 'px'; box.style.top = y + 'px';
      box.querySelectorAll('input').forEach(i => { i.oninput = render; i.onchange = render; });
      render();
      const done = v => { document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', keyH, true); box.remove(); resolve(v); };
      const outside = e => { if (!box.contains(e.target)) { e.preventDefault(); e.stopPropagation(); done(null); } };
      const keyH = e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
      setTimeout(() => { document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', keyH, true); }, 0);
      box.querySelector('.pop-cancel').onclick = () => done(null);
      box.querySelector('.pop-act').onclick = () => { const mode = box.querySelector('input[name=fm]:checked').value, step = Number(box.querySelector('#fstep').value) || 1; done(preview(mode, step).map(r => ({ ip: r.ip, value: r.value }))); };
    });
  }

  function updatePendingUI() {
    const n = pending.size;
    const nodes = new Set([...pending.values()].map(p => p.ip)).size;
    $('#btnDeploy').disabled = n === 0 || fleet.readonly;
    $('#btnDiscard').disabled = n === 0;
    $('#btnDeploy').textContent = n ? `Déployer ${n} changement${n > 1 ? 's' : ''} → ${nodes} node${nodes > 1 ? 's' : ''}` : 'Déployer';
  }

  async function deploy() {
    if (!pending.size) return;
    const items = [...pending.values()];
    const nodes = new Set(items.map(p => p.ip));
    const lines = items.slice(0, 12).map(p => `• ${p.ip} : ${p.col.label} = ${raw(p.col, p.value)}`).join('\n');
    if (!await confirmBox(`Envoyer ${items.length} changement(s) à ${nodes.size} node(s) ?\n\n${lines}${items.length > 12 ? '\n…' : ''}`)) return;
    $('#btnDeploy').disabled = true; $('#btnDiscard').disabled = true;
    let ok = 0, failed = 0; const rebootNodes = new Set(); const errors = [];
    // IP changes go together in ONE batch (write all, then reboot all): swapping two IPs works
    const ipMoves = items.filter(p => p.col.id === 'staticip');
    if (ipMoves.length) {
      try {
        const r = await post('/api/nodes/relocate', { moves: ipMoves.map(p => ({ ip: p.ip, to: String(p.value) })) });
        for (const p of ipMoves) { pending.delete(pkey(p.ip, p.col.id)); selected.delete(p.ip); ok++; }
        toast(`IP écrites, redémarrage groupé : ${r.moved.map(m => `${m.name || m.from} → ${m.to}`).join(', ')}`);
      } catch (e) {
        failed += ipMoves.length; errors.push(`IP : ${e.message}`);
        for (const p of ipMoves) { p.error = e.message; const cell = document.querySelector(`td[data-ip="${CSS.escape(p.ip)}"][data-col="staticip"]`); if (cell) cell.title = `échec : ${e.message}`; }
      }
    }
    for (const p of items.filter(p => p.col.id !== 'staticip')) {
      const cell = document.querySelector(`td[data-ip="${CSS.escape(p.ip)}"][data-col="${p.col.id}"]`);
      try {
        const r = await api(`/api/node/${encodeURIComponent(p.ip)}/cell`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ col: p.col.id, value: p.value }) });
        ok++; if (r.reboot) rebootNodes.add(p.ip);
        if (r.movedTo) { toast(`${p.ip} → ${r.movedTo} : IP écrite, redémarrage, la ligne suit le node`); selected.delete(p.ip); }
        pending.delete(pkey(p.ip, p.col.id));
        if (cell) { cell.classList.remove('pending', 'flash-ok'); void cell.offsetWidth; cell.classList.add('flash-ok'); }
      } catch (e) {
        failed++; errors.push(`${p.ip} · ${p.col.label} : ${e.message}`);
        p.error = e.message; // kept on the pending cell (tooltip) until it succeeds or is discarded
        if (cell) { cell.classList.remove('flash-bad'); void cell.offsetWidth; cell.classList.add('flash-bad'); cell.title = `échec : ${e.message}`; }
      }
    }
    updatePendingUI();
    const msg = `${ok} changement(s) envoyé(s)` + (failed ? `, ${failed} en échec (restent en attente) :\n${errors.join('\n')}` : '') + (rebootNodes.size ? ` — redémarrage requis (⟳) : ${[...rebootNodes].join(', ')}` : '');
    toast(msg, failed > 0, failed ? 12000 : undefined);
    refresh();
  }

  // ── change journal ─────────────────────────────────────────────────────────
  async function pollChanges() {
    try {
      const j = await api('/api/changes?since=' + lastChangeAt);
      if (!j.events.length) return;
      const first = lastChangeAt === 0;
      for (const ev of j.events) {
        changes.push(ev); lastChangeAt = Math.max(lastChangeAt, ev.at);
        if (ev.col) recentChanges.set(pkey(ev.ip, ev.col), ev);
        if (!first && ev.source === 'externe') {
          unseen++;
          const col = COLS.find(c => c.id === ev.col);
          toast(`Modif externe · ${ev.name} · ${col ? col.label : ev.col} : ${col ? raw(col, ev.old) : ev.old} → ${col ? raw(col, ev.new) : ev.new}`, true);
        }
      }
      if (changes.length > 1000) changes = changes.slice(-1000);
      renderJournal(); renderBody();
    } catch { /* server away, refresh() already shows it */ }
  }
  function renderJournal() {
    $('#btnJournal').innerHTML = `Journal${unseen ? ` <span class="n">${unseen}</span>` : ''}`;
    if (!journalOpen) return;
    $('#journalBody').innerHTML = [...changes].reverse().slice(0, 300).map(ev => {
      const col = COLS.find(c => c.id === ev.col);
      const f = v => col ? raw(col, v) : (v == null ? '' : String(v));
      return `<tr><td>${new Date(ev.at).toLocaleTimeString()}</td><td>${esc(ev.name || ev.ip)} <span class="muted">${esc(ev.ip)}</span></td><td>${esc(col ? col.label : ev.col)}</td><td>${esc(f(ev.old))}</td><td><b>${esc(f(ev.new))}</b></td><td><span class="src ${ev.source}">${ev.source}</span></td></tr>`;
    }).join('') || '<tr><td colspan="6" class="muted">aucune modification détectée pour l\'instant</td></tr>';
  }

  // ── Optimisation tab: antenna preset + node preset, real state, actions ───
  let optOpen = false;
  async function renderOpt() {
    const p = $('#optpanel');
    const kept = keepDetails(p);
    let pr = null; try { pr = await api('/api/ap/preset?iface=wifi1'); } catch (e) { pr = { error: e.message, items: [] }; }
    const todo = pr.items.filter(i => i.ok !== true && !i.optional);
    const antenna = `<details class="subbox" data-key="opt-ap" open><summary style="cursor:pointer"><b>Antenne</b> : ${pr.error ? `<span class="st-bad">${esc(pr.error)}</span>` : todo.length ? `<span class="st-warn">${todo.length} réglage(s) proposé(s)</span>` : '<span class="st-ok">réglée</span>'} <span class="muted">— radio ${esc(pr.iface || 'wifi1')} ; cocher puis appliquer, la radio redémarre ~10 s, les nodes se réassocient seuls</span></summary>
      ${pr.error ? '' : `<table><thead><tr><th></th><th>Réglage</th><th>Actuel</th><th>Proposé</th><th>Pourquoi</th></tr></thead><tbody>${pr.items.map(i => `<tr class="${i.ok === true ? 'offline' : ''}"><td><input type="checkbox" data-preset="${esc(i.key)}" ${i.ok === true ? 'disabled' : i.optional ? '' : 'checked'}></td><td><code>${esc(i.key)}</code></td><td>${i.current == null ? '<span class="muted">défaut</span>' : esc(String(i.current))}</td><td><b>${esc(i.want)}</b>${i.ok === true ? ' <span class="st-ok">✓</span>' : ''}</td><td class="muted">${i.optional ? '<span class="tag local" title="préventif : inutile tant que tous les nodes s\'associent sans souci">facultatif</span> ' : ''}${esc(i.why)}</td></tr>`).join('')}</tbody></table>
      <div style="margin-top:6px"><button class="rowbtn primary" id="optApGo" ${todo.length ? '' : 'disabled'}>Appliquer les réglages cochés sur l'antenne</button></div>`}</details>`;
    // nodes: current vs recommended for the three settings that matter under E1.31
    const specs = NODE_PRESET.map(([id, want]) => ({ col: COLS.find(c => c.id === id), want }));
    const nodes = fleet.nodes.filter(n => n.meta.online && n.cfg);
    const rows = nodes.map(n => { const cells = specs.map(s => { const v = get(n, s.col.path); const ok = JSON.stringify(v) === JSON.stringify(s.want); return `<td class="${ok ? 'st-ok' : 'st-warn'}">${ok ? '✓ ' : '▲ '}${esc(raw(s.col, v))}${ok ? '' : ` → ${esc(raw(s.col, s.want))}`}</td>`; }); const allOk = specs.every(s => JSON.stringify(get(n, s.col.path)) === JSON.stringify(s.want)); return `<tr class="${allOk ? 'offline' : ''}"><td><b>${esc(n.info.name || key(n))}</b> <span class="muted">${esc(key(n))}</span></td>${cells.join('')}<td>${n.info.wifi && n.info.wifi.rssi != null ? n.info.wifi.rssi + ' dBm' : ''}</td></tr>`; });
    const nodesTodo = nodes.filter(n => specs.some(s => JSON.stringify(get(n, s.col.path)) !== JSON.stringify(s.want)));
    const nodesHtml = `<details class="subbox" data-key="opt-nodes" open><summary style="cursor:pointer"><b>Nodes</b> : ${nodesTodo.length ? `<span class="st-warn">${nodesTodo.length} node(s) à régler</span>` : `<span class="st-ok">${nodes.length} node(s) au préréglage show</span>`} <span class="muted">— veille Wi‑Fi non (cause n° 1 de trames perdues), puissance TX au maximum, saut des paquets E1.31 hors séquence</span></summary>
      <table><thead><tr><th>Node</th>${specs.map(s => `<th title="${esc(s.col.help || '')}">${esc(s.col.label)}</th>`).join('')}<th title="signal de l'antenne vu par le node">RSSI</th></tr></thead><tbody>${rows.join('') || '<tr><td colspan="5" class="muted">aucun node en ligne</td></tr>'}</tbody></table>
      <div style="margin-top:6px;display:flex;gap:8px;align-items:center"><button class="rowbtn primary" id="optNodesStage" ${nodesTodo.length ? '' : 'disabled'} title="met les valeurs manquantes en attente dans la grille">Mettre en attente (${nodesTodo.length})</button><button class="rowbtn" id="optNodesDeploy" title="déploie les changements en attente de la grille">Déployer maintenant</button><span class="muted">${pending.size ? pending.size + ' changement(s) en attente dans la grille' : ''}</span></div></details>`;
    const physics = `<details class="subbox" data-key="opt-phys"><summary style="cursor:pointer"><b>Ce que les réglages ne remplacent pas</b> <span class="muted">— placement, à lire avant un show</span></summary>
      <ul style="margin:6px 0 0 18px;padding:0;line-height:1.6">
        <li>La puissance est déjà au maximum légal (20 dBm rayonnés en 2,4 GHz, Belgique = Europe) : antenne à 13 dBm + 7 dBi. Ne pas chercher à monter.</li>
        <li>L'antenne en hauteur, vue directe sur les artistes : un corps absorbe 10 à 20 dB. Loin des structures métalliques, des amplis et des gradateurs.</li>
        <li>Côté node, c'est la réception qui limite (asymétrie visible dans Antenne : le node entend l'antenne bien moins fort que l'inverse) : node hors boîtier métallique, antenne PCB dégagée, pas collé au corps.</li>
        <li>Couper le hotspot du téléphone et les appareils non-WLED sur le 2,4 GHz pendant le show ; le 5 GHz est pour eux.</li>
        <li>Après tout changement : onglet Antenne, scanner l'environnement, vérifier canal et taux d'erreurs.</li>
      </ul></details>`;
    p.innerHTML = `<h2>Optimisation <span class="muted" style="text-transform:none;letter-spacing:0" title="état réel de l'antenne et des nodes comparé au préréglage show">rien n'est appliqué sans ton clic</span></h2>${antenna}${nodesHtml}${physics}`;
    kept.restore();
    const go = $('#optApGo'); if (go) go.onclick = async () => {
      const keys = [...p.querySelectorAll('input[data-preset]:checked:not(:disabled)')].map(x => x.dataset.preset);
      if (!keys.length) return toast('rien de coché');
      if (!await confirmBox(`Écrire ${keys.length} réglage(s) sur l'antenne ${pr.iface} ?\n\n${keys.map(k => '• ' + k + ' → ' + pr.items.find(i => i.key === k).want).join('\n')}\n\nLa radio redémarre, les nodes se réassocient (~10 s). Ne pas faire pendant un show.`)) return;
      go.disabled = true; go.textContent = 'application…';
      try { const r = await post('/api/ap/preset', { iface: pr.iface, keys }); toast(`antenne : ${Object.keys(r.after).length} réglage(s) écrit(s)`); } catch (e) { toast(e.message, true); }
      apPresetData = null; setTimeout(renderOpt, 9000);
    };
    const st = $('#optNodesStage'); if (st) st.onclick = () => { $('#btnPreset').click(); setTimeout(renderOpt, 200); };
    const dp = $('#optNodesDeploy'); if (dp) dp.onclick = async () => { if (!pending.size) return toast('rien en attente : cliquer d\'abord « Mettre en attente »'); await deploy(); setTimeout(renderOpt, 1500); };
  }

  // ── DMX plan: universe.address of every output, content of every universe ──
  let dmxOpen = false;
  // « localiser » : allume juste le dernier pixel d'une sortie (blanc, le reste
  // en bleu léger) sur le vrai node, pour compter en direct en ajustant Pixels.
  // Une seule sortie à la fois ; le serveur restaure tout seul après 90 s
  // d'inactivité si on part sans cliquer Arrêter.
  let locating = null; // { ip, index }
  async function stopLocating() {
    if (!locating) return;
    const ip = locating.ip; locating = null;
    try { await api(`/api/node/${encodeURIComponent(ip)}/locate-pixel`, { method: 'DELETE' }); } catch { /* déjà éteint, ou node parti */ }
  }
  async function renderDmx() {
    const p = $('#dmxpanel');
    let d; try { [d] = await Promise.all([api('/api/dmx-plan'), loadLedProfiles()]); } catch (e) { p.innerHTML = `<div class="st-bad">${esc(e.message)}</div>`; return; }
    const CPX = { 4: 3, 5: 3, 6: 4 }; // channels per pixel by DMX mode (Multi RGB, Multi DRGB, Multi RGBW)
    const modeName = m => ({ 4: 'Multi RGB', 5: 'Multi DRGB', 6: 'Multi RGBW' })[m] || (COLS.find(c => c.id === 'dmxmode') || { enum: {} }).enum[m] || m;
    const conflictsHtml = list => list.length ? `<b class="st-bad">✗ Conflit d'univers</b> : ${list.map(c => `univers <b>${c.universe}</b> écouté par ${c.nodes.map(esc).join(' et ')}`).join(' · ')} <span class="muted">— deux nodes sur le même univers affichent les mêmes données : ⚡ Autopatch, ou décaler l'univers de départ de l'un d'eux</span>` : `<span class="muted">aucun conflit d'univers entre nodes</span>`;
    const conflicts = `<div id="dmxConflicts" class="subbox" style="${d.conflicts.length ? 'border-color:var(--bad)' : ''}">${conflictsHtml(d.conflicts)}</div>`;
    // ── cards: one per group (its nodes stacked as if they were one device), ungrouped nodes alone ──
    const order = rows().map(key); const byIp = new Map(d.nodes.map(n => [n.ip, n]));
    const nodesSorted = [...order.filter(ip => byIp.has(ip)).map(ip => byIp.get(ip)), ...d.nodes.filter(n => !order.includes(n.ip))];
    const gCards = [];
    for (const n of nodesSorted) { const g = n.group || ''; if (!g) { gCards.push({ g: '', nodes: [n] }); continue; } let e = gCards.find(x => x.g === g); if (!e) { e = { g, nodes: [] }; gCards.push(e); } e.nodes.push(n); }
    const rgbwTypes = [30, 31, 41, 44, 88];
    const colDmx = { mode: COLS.find(c => c.id === 'dmxmode'), uni: COLS.find(c => c.id === 'dmxuni'), addr: COLS.find(c => c.id === 'dmxaddr'), mA: COLS.find(c => c.id === 'maxpwr') };
    const nodeRec = ip => fleet.nodes.find(x => key(x) === ip);
    const inConflictOf = n => d.conflicts.some(c => c.nodes.includes(n.name || n.ip));
    const alignedOf = pl => pl.outputs.filter(o => o.len).every(o => o.start % pl.pxPerUni === 0);
    // ── one table per group, node cell spanning its output rows (merged-cell look), one Save button for the tab ──
    const sel = (name, map, cur) => `<select data-out="${name}" data-orig="${cur}">${Object.entries(map).map(([v, l]) => `<option value="${v}" ${Number(v) === Number(cur) ? 'selected' : ''}>${esc(l)}</option>`).join('')}${map[cur] === undefined ? `<option value="${cur}" selected>type ${cur}</option>` : ''}</select>`;
    const nodeCell = (n, span) => {
      const pl = n.plan, rec = nodeRec(n.ip); const cur = c => { const st = pending.get(pkey(n.ip, c.id)); return st ? st.value : (rec ? get(rec, c.path) : undefined); };
      const mode = cur(colDmx.mode), uni = cur(colDmx.uni) ?? pl.uni, addr = cur(colDmx.addr) ?? pl.addr, mA = cur(colDmx.mA) ?? '';
      const inConflict = inConflictOf(n), aligned = pl.multi && alignedOf(pl);
      return `<td class="ncell" rowspan="${span}" data-nodecell="${esc(n.ip)}">
        <div class="ncell-name"><b>${esc(n.name || n.ip)}</b></div>
        <div class="muted" style="font-size:11px">${esc(n.ip)}${pl.multi ? ` · univers <b>${pl.firstUni}–${pl.lastUni}</b> · ${pl.total} px` : ''}</div>
        <div class="ncell-st"><span class="st-bad cf" title="un autre node écoute un de ces univers (état des champs à l'écran)" ${inConflict ? '' : 'hidden'}>✗ conflit</span>${pl.multi && !aligned ? ' <span class="st-warn" title="une sortie suivante commence au milieu d\'un univers">▲ à cheval</span>' : ''}${n.live ? ` <span class="st-ok" title="flux temps réel reçu de ${esc(n.lip)}">● ${esc(n.lm)}</span>` : ''}</div>
        <div class="ncell-set">
          <label><span class="lbl">mode</span><select data-nb="dmxmode" data-orig="${esc(String(mode ?? ''))}">${Object.entries(colDmx.mode.enum).map(([v, l]) => `<option value="${v}" ${Number(v) === Number(mode) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
          <label><span class="lbl">univers</span><input type="number" data-nb="dmxuni" data-orig="${esc(String(uni))}" min="1" max="63999" value="${esc(String(uni))}"></label>
          <label><span class="lbl">adresse</span><input type="number" data-nb="dmxaddr" data-orig="${esc(String(addr))}" min="1" max="512" value="${esc(String(addr))}"></label>
          <label><span class="lbl">mA max</span><input type="number" data-nb="maxpwr" data-orig="${esc(String(mA))}" min="0" step="50" value="${esc(String(mA))}"></label>
        </div>${pl.multi && !aligned ? `<button class="rowbtn" data-align="${esc(n.ip)}" title="décale le départ de chaque sortie au début d'un univers (${pl.pxPerUni} px par univers) sans changer son nombre de pixels : les index laissés libres ne pilotent rien. Sauvegarde prise avant.">≡ univers entiers</button>` : ''}</td>`;
    };
    const profileOptions = cur => `<option value="">profil…</option>${ledProfilesCache.map(pr => `<option value="${esc(pr.id)}" ${pr.id === cur ? 'selected' : ''}>${esc(pr.name)}</option>`).join('')}<option value="__new">＋ enregistrer cette ligne comme profil…</option>${ledProfilesCache.length ? '<option value="__manage">gérer les profils…</option>' : ''}`;
    const outRow = (n, o, r, i, first, span) => {
      const pl = n.plan; const next = pl.outputs[i + 1];
      const midNext = next && next.len && pl.multi && ((next.start) % pl.pxPerUni !== 0);
      const uniTxt = !o.len ? '' : o.universes > 1 ? `<span class="${midNext ? 'st-warn' : 'muted'}" title="${midNext ? 'la sortie suivante commence au milieu d\'un univers : à la console, une fixture continue' : 'cette sortie occupe plusieurs univers'}">${o.universes} univers</span>` : '<span class="st-ok">1 univers</span>';
      const pid = profileIdFor(o, r), unknown = !pid && !o.ignored && o.len;
      return `<tr data-outrow="${i}" data-node="${esc(n.ip)}" class="${o.ignored ? 'offline' : ''}${first ? ' first' : ''}">${first ? nodeCell(n, span) : ''}
        <td><label class="chip" title="utilisée = câblée. Décocher une sortie qui existe dans WLED mais n'est pas branchée : grisée, hors conflits. Mémorisé sur le node (marqueur dans son MQTT device topic), rien d'autre n'est écrit."><input type="checkbox" data-ignore="${o.start}" ${o.ignored ? '' : 'checked'}> Sortie ${o.i + 1}</label></td>
        <td class="${unknown ? 'newprof' : ''}"><select data-prof title="${unknown ? 'profil inconnu de la bibliothèque locale : ce type/ordre/pixels ne correspond à aucun profil enregistré ici → ＋ enregistrer cette ligne comme profil pour le retrouver la prochaine fois.' : 'profil de LED : ce qui est branché sur cette sortie ; choisir un profil remplit type, ordre et pixels, et le node s\'en souvient (MQTT client id). Sans choix, Fleet reconnaît un profil quand la ligne y correspond exactement.'}">${profileOptions(pid)}</select></td>
        <td class="muted" title="GPIO de la sortie">${esc(o.pin)}</td>
        <td>${sel('type', LED_TYPES, r.type)}</td>
        <td>${sel('order', COLOR_ORDERS, (r.order || 0) & 0x0f)}</td>
        <td><input type="number" data-out="start" data-orig="${o.start}" value="${o.start}" min="0" title="index du premier pixel de cette sortie dans le node"></td>
        <td><span style="display:inline-flex;align-items:center;gap:4px"><input type="number" data-out="len" data-orig="${o.len}" value="${o.len}" min="1" title="nombre de pixels sur ce câble"><button class="rowbtn" data-calc="1" title="calculer : LEDs par mètre × longueur">📏</button><button class="rowbtn${locating && locating.ip === n.ip && locating.index === i ? ' primary' : ''}" data-locate="1" title="allumer le dernier pixel de cette sortie en blanc (le reste en bleu léger) sur le vrai node, pour compter en changeant Pixels et en regardant où ça s'arrête sur le ruban">📍</button></span></td>
        <td><label class="chip"><input type="checkbox" data-out="rev" data-orig="${r.rev ? 1 : 0}" ${r.rev ? 'checked' : ''}> inversée</label></td>
        <td class="oc-addr"><span class="addr"><b>${esc(o.from || '')}</b> → <b>${esc(o.to || '')}</b></span> <span class="straddle">${uniTxt}</span></td></tr>`;
    };
    const groupTable = gc => {
      const head = `<thead><tr><th>Node</th><th>Sortie</th><th title="profil de LED : type + ordre + pixels mémorisés sous un nom">Profil</th><th>Pin</th><th>Type</th><th>Ordre</th><th title="index du premier pixel dans le node (0 = premier)">Départ</th><th title="pixels sur ce câble ; 📏 = calculateur">Pixels</th><th></th><th title="univers.canal du premier et du dernier pixel : ce qu'il faut patcher à la console (recalculé en direct)">Adresse console (de → à)</th></tr></thead>`;
      const body = gc.nodes.map(n => {
        const pl = n.plan; const rec = nodeRec(n.ip); const rawIns = (rec && rec.cfg && rec.cfg.hw && rec.cfg.hw.led && rec.cfg.hw.led.ins) || [];
        if (!pl.multi) return `<tr data-node="${esc(n.ip)}">${nodeCell(n, 1)}<td colspan="9" class="muted">mode ${esc(modeName(pl.mode))} : ${esc(pl.note)}</td></tr>`;
        const outs = pl.outputs; const span = Math.max(1, outs.length);
        if (!outs.length) return `<tr data-node="${esc(n.ip)}">${nodeCell(n, 1)}<td colspan="9" class="muted">aucune sortie déclarée</td></tr>`;
        return outs.map((o, i) => outRow(n, o, rawIns[i] || {}, i, i === 0, span)).join('');
      }).join('');
      const ns = gc.nodes.filter(n => n.plan.multi);
      const minU = ns.length ? Math.min(...ns.map(n => n.plan.firstUni)) : null, maxU = ns.length ? Math.max(...ns.map(n => n.plan.lastUni)) : null;
      const total = ns.reduce((a, n) => a + n.plan.total, 0), conf = ns.some(inConflictOf);
      const gi = gCards.indexOf(gc);
      const ap = ns.length ? `<button class="rowbtn" data-autopatch="${gi}" title="calcule les départs pour que chaque sortie commence sur un nouvel univers, enchaîne les nodes du groupe sur des univers consécutifs, met l'adresse à 1 et ajuste le mode DMX (RGB / RGBW) au type de LED. Rien n'est écrit : vérifier, puis Enregistrer.">⚡ Autopatch</button>` : '';
      const title = `<div class="gc-title" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">${gc.g ? `<b>${esc(gc.g)}</b> <span class="muted">${gc.nodes.length} node${gc.nodes.length > 1 ? 's' : ''}${ns.length ? ` · univers ${minU}–${maxU} · ${total} px` : ''}</span>` : `<span class="muted">node solo</span>`}<span class="st-bad gcf" data-gi="${gi}" ${conf ? '' : 'hidden'}>✗ conflit</span>${ap}</div>`;
      return `<div class="gtable">${title}<div style="overflow-x:auto"><table class="outs">${head}<tbody>${body}</tbody></table></div></div>`;
    };
    const cards = gCards.map(groupTable).join('');
    const kept = keepDetails(p);
    p.innerHTML = `<h2>Sorties / DMX <span class="muted" style="text-transform:none;letter-spacing:0" title="En mode Multi, WLED enchaîne les pixels sur des univers consécutifs (170 RGB ou 128 RGBW par univers) à partir de l'univers et de l'adresse de départ du node. L'univers d'une sortie découle donc de la longueur des sorties précédentes. Les sorties existent déjà sur les boîtiers : ici on règle ce qui est branché dessus (profil ou type, ordre, pixels) et les réglages DMX du node. ⚡ Autopatch calcule les départs (une sortie = un nouvel univers, nodes d'un groupe à la suite). Un seul bouton enregistre tout ce qui a changé.">ⓘ</span><span class="spacer"></span><button id="dmxSave" class="primary" disabled title="écrit sur chaque node modifié : ses sorties (bloc complet, sauvegarde prise avant) et ses réglages DMX (via la mise en attente et Déployer)">Enregistrer les modifications</button></h2>
      ${conflicts}${cards || '<div class="muted">aucun node avec une config lue</div>'}`;
    kept.restore();
    // live recomputation of universe.address while editing, same arithmetic as the server
    const locateFn = pl => { const cp = pl.chPerPx, per = pl.pxPerUni, dim = pl.mode === 5 ? 1 : 0, first = Math.floor((512 - (pl.addr - 1) - dim) / cp); return px => px < first ? { u: pl.uni, ch: pl.addr + dim + px * cp } : { u: pl.uni + 1 + Math.floor((px - first) / per), ch: 1 + ((px - first) % per) * cp }; };
    const planOf = ip => (d.nodes.find(x => x.ip === ip) || {}).plan;
    const livePlan = ip => {
      const pl = planOf(ip); const cell = p.querySelector(`[data-nodecell="${CSS.escape(ip)}"]`); if (!pl || !cell) return pl;
      const mode = Number(cell.querySelector('[data-nb=dmxmode]').value); const cp = CPX[mode]; if (!cp) return { ...pl, multi: false };
      return { ...pl, multi: true, mode, chPerPx: cp, pxPerUni: Math.floor(512 / cp), uni: Number(cell.querySelector('[data-nb=dmxuni]').value) || 1, addr: Number(cell.querySelector('[data-nb=dmxaddr]').value) || 1 };
    };
    const rowsOf = ip => [...p.querySelectorAll(`tr[data-outrow][data-node="${CSS.escape(ip)}"]`)];
    const recompute = ip => { const pl = livePlan(ip); if (!pl || !pl.multi) return; const loc = locateFn(pl); rowsOf(ip).forEach(tr => {
      const start = Number(tr.querySelector('[data-out=start]').value), len = Number(tr.querySelector('[data-out=len]').value);
      if (!(len > 0) || !(start >= 0)) return;
      const a = loc(start), b = loc(start + len - 1);
      tr.querySelector('.addr').innerHTML = `<b>${a.u}.${a.ch}</b> → <b>${b.u}.${b.ch + pl.chPerPx - 1}</b>`;
      tr.querySelector('.straddle').innerHTML = b.u !== a.u ? `<span class="muted">${b.u - a.u + 1} univers</span>` : '<span class="st-ok">1 univers</span>';
    }); };
    // dirty tracking: anything that differs from its data-orig enables the one Save button
    const changedNodes = () => {
      const set = new Set();
      p.querySelectorAll('[data-out][data-orig],[data-nb][data-orig]').forEach(el => {
        const cur = el.type === 'checkbox' ? (el.checked ? '1' : '0') : String(el.value);
        if (cur !== String(el.dataset.orig)) set.add(el.closest('tr').dataset.node || (el.closest('[data-nodecell]') || {}).dataset.nodecell);
      });
      return [...set].filter(Boolean);
    };
    const liveConflicts = () => {
      const map = new Map();
      for (const n of d.nodes) {
        const pl = livePlan(n.ip); if (!pl || !pl.multi) continue; const loc = locateFn(pl);
        rowsOf(n.ip).forEach(tr => { const ig = tr.querySelector('input[data-ignore]'); if (ig && !ig.checked) return; const start = Number(tr.querySelector('[data-out=start]').value), len = Number(tr.querySelector('[data-out=len]').value); if (!(len > 0) || !(start >= 0)) return; const a = loc(start).u, b = loc(start + len - 1).u; for (let u = a; u <= b; u++) { if (!map.has(u)) map.set(u, new Set()); map.get(u).add(n.name || n.ip); } });
      }
      return [...map].filter(([, x]) => x.size > 1).map(([universe, x]) => ({ universe, nodes: [...x] })).sort((a, b) => a.universe - b.universe);
    };
    const renderConflicts = () => {
      const list = liveConflicts(); const box = $('#dmxConflicts'); if (box) { box.innerHTML = conflictsHtml(list); box.style.borderColor = list.length ? 'var(--bad)' : ''; }
      const bad = new Set(list.flatMap(c => c.nodes));
      p.querySelectorAll('[data-nodecell]').forEach(c => { const n = d.nodes.find(x => x.ip === c.dataset.nodecell); const el = c.querySelector('.cf'); if (el) el.hidden = !(n && bad.has(n.name || n.ip)); });
      p.querySelectorAll('.gcf').forEach(el => { const gc = gCards[Number(el.dataset.gi)]; el.hidden = !gc.nodes.some(n => bad.has(n.name || n.ip)); });
    };
    const refreshDirty = () => { const n = changedNodes().length; const b = $('#dmxSave'); if (b) { b.disabled = !n; b.textContent = n ? `Enregistrer les modifications (${n} node${n > 1 ? 's' : ''})` : 'Enregistrer les modifications'; } };
    p.querySelectorAll('[data-out],[data-nb]').forEach(el => { el.oninput = el.onchange = () => { const tr = el.closest('tr'); if (tr && tr.dataset.node) recompute(tr.dataset.node); refreshDirty(); renderConflicts(); if (tr && (el.dataset.out === 'start' || el.dataset.out === 'len')) sendLocateUpdate(tr); }; });
    // "comptée" checkboxes: Fleet-only, saved at once, conflicts recomputed
    p.querySelectorAll('input[data-ignore]').forEach(cb => cb.onchange = async () => {
      const ip = cb.closest('tr').dataset.node;
      const starts = rowsOf(ip).map(tr => tr.querySelector('input[data-ignore]')).filter(x => !x.checked).map(x => Number(x.dataset.ignore));
      try { const r = await post(`/api/node/${encodeURIComponent(ip)}/outputs-ignore`, { starts }); toast(r.queued ? 'node hors ligne : sera proposé au retour (⏳ sur la ligne)' : (starts.length ? `${starts.length} sortie(s) non utilisée(s), mémorisé sur le node` : 'toutes les sorties utilisées')); }
      catch (e) { toast(e.message, true); cb.checked = !cb.checked; return; }
      cb.closest('tr').classList.toggle('offline', !cb.checked); renderConflicts(); // in place: the unsaved edits of the page stay
    });
    // 📏 pixels = LEDs per metre × length ; universes = ceil(px / pxPerUni) for the row's LED type
    p.querySelectorAll('button[data-calc]').forEach(b => b.onclick = async () => {
      const tr = b.closest('tr');
      const rgbw = rgbwTypes.includes(Number(tr.querySelector('[data-out=type]').value)); const per = rgbw ? 128 : 170;
      const px = await calcBox(b, per, rgbw); if (px == null) return;
      const len = tr.querySelector('[data-out=len]'); len.value = px; len.dispatchEvent(new Event('input'));
    });
    // 📍 localiser : allume le dernier pixel de la sortie (blanc, reste en bleu léger) sur
    // le vrai node ; ajuster Pixels (ci-dessous) déplace le repère en direct, un 2e clic arrête
    let locateTimer = null;
    const sendLocateUpdate = tr => {
      if (!locating || locating.ip !== tr.dataset.node || locating.index !== Number(tr.dataset.outrow)) return;
      const start = Number(tr.querySelector('[data-out=start]').value), len = Number(tr.querySelector('[data-out=len]').value);
      if (!(len > 0) || !(start >= 0)) return;
      clearTimeout(locateTimer);
      locateTimer = setTimeout(() => { post(`/api/node/${encodeURIComponent(locating.ip)}/locate-pixel`, { start, len }).catch(e => toast(e.message, true)); }, 150);
    };
    p.querySelectorAll('button[data-locate]').forEach(b => b.onclick = async () => {
      const tr = b.closest('tr'); const ip = tr.dataset.node, index = Number(tr.dataset.outrow);
      const wasThis = locating && locating.ip === ip && locating.index === index;
      if (locating) {
        const prevBtn = p.querySelector(`tr[data-node="${CSS.escape(locating.ip)}"][data-outrow="${locating.index}"] button[data-locate]`);
        if (prevBtn) prevBtn.classList.remove('primary');
        await stopLocating();
      }
      if (wasThis) return;
      const start = Number(tr.querySelector('[data-out=start]').value), len = Number(tr.querySelector('[data-out=len]').value);
      if (!(len > 0) || !(start >= 0)) { toast('départ / pixels invalides', true); return; }
      locating = { ip, index };
      b.classList.add('primary');
      try { await post(`/api/node/${encodeURIComponent(ip)}/locate-pixel`, { start, len }); toast('sortie repérée : dernier pixel en blanc sur le node — ajuster Pixels pour le déplacer, 📍 pour arrêter'); }
      catch (e) { toast(e.message, true); locating = null; b.classList.remove('primary'); }
    });
    // ⚡ autopatch: every output starts on a fresh universe ; nodes of a group chain on consecutive universes
    p.querySelectorAll('button[data-autopatch]').forEach(b => b.onclick = () => {
      const gc = gCards[Number(b.dataset.autopatch)]; let uni = null; const notes = [];
      for (const n of gc.nodes) {
        const cell = p.querySelector(`[data-nodecell="${CSS.escape(n.ip)}"]`); const rowsN = rowsOf(n.ip); if (!cell || !rowsN.length) continue;
        const modeEl = cell.querySelector('[data-nb=dmxmode]'); let mode = Number(modeEl.value);
        const anyRgbw = rowsN.some(tr => rgbwTypes.includes(Number(tr.querySelector('[data-out=type]').value)));
        const want = anyRgbw ? 6 : (mode === 5 ? 5 : 4);
        if (!CPX[mode] || (anyRgbw && mode !== 6) || (!anyRgbw && mode === 6)) { mode = want; modeEl.value = String(mode); notes.push(`${n.name || n.ip} : mode → ${anyRgbw ? 'Multi RGBW' : 'Multi RGB'}`); }
        const per = Math.floor(512 / CPX[mode]);
        const uniEl = cell.querySelector('[data-nb=dmxuni]'), addrEl = cell.querySelector('[data-nb=dmxaddr]');
        if (uni === null) uni = Number(uniEl.value) || 1; else uniEl.value = String(uni);
        addrEl.value = '1';
        let start = 0;
        const used = rowsN.filter(tr => { const ig = tr.querySelector('input[data-ignore]'); return !ig || ig.checked; }), unused = rowsN.filter(tr => !used.includes(tr));
        for (const tr of used) { const len = Number(tr.querySelector('[data-out=len]').value) || 0; tr.querySelector('[data-out=start]').value = String(start); start += Math.ceil(len / per) * per; }
        const usedSlots = start / per;
        for (const tr of unused) { const len = Number(tr.querySelector('[data-out=len]').value) || 0; tr.querySelector('[data-out=start]').value = String(start); start += Math.ceil(len / per) * per; } // parked after the used ones, they drive nothing
        uni += usedSlots; // the next node starts right after the universes really in use
        recompute(n.ip);
      }
      refreshDirty(); renderConflicts(); toast(`autopatch calculé${notes.length ? ' · ' + notes.join(' · ') : ''} — vérifier, puis Enregistrer`);
    });
    // LED profiles: pick one to fill a row, save a row as a profile, or manage them
    const refreshProfileSelects = async () => {
      await loadLedProfiles();
      p.querySelectorAll('select[data-prof]').forEach(sl => {
        const tr = sl.closest('tr'); const ip = tr.dataset.node, i = Number(tr.dataset.outrow);
        const n = d.nodes.find(x => x.ip === ip); const rec = nodeRec(ip);
        const ins = (rec && rec.cfg && rec.cfg.hw && rec.cfg.hw.led && rec.cfg.hw.led.ins) || [];
        const o = n && n.plan.outputs[i], r = ins[i];
        const pid = o && r ? profileIdFor(o, r) : (ledProfilesCache.some(x => x.id === sl.value) ? sl.value : '');
        sl.innerHTML = profileOptions(pid); sl.value = pid;
        sl.closest('td').classList.toggle('newprof', !!(o && r && !pid && !o.ignored && o.len));
      });
    };
    p.querySelectorAll('select[data-prof]').forEach(sl => sl.onchange = async () => {
      const tr = sl.closest('tr'); const v = sl.value; sl.value = '';
      if (v === '__new') {
        const name = prompt('Nom du profil (ce qui est branché : ex. « Liane 160 px WS2812 GRB ») :'); if (!name || !name.trim()) return;
        let created = null;
        try { created = (await post('/api/led-profiles', { name: name.trim(), type: tr.querySelector('[data-out=type]').value, order: tr.querySelector('[data-out=order]').value, len: tr.querySelector('[data-out=len]').value })).profile; toast(`profil « ${name.trim()} » enregistré`); } catch (e) { toast(e.message, true); }
        await refreshProfileSelects(); if (created) { sl.value = created.id; remember(tr, created.id); } return;
      }
      if (v === '__manage') { const r = sl.getBoundingClientRect(); menuBox(r.left, r.bottom + 2, ledProfilesCache.map(pr => ({ label: `Supprimer « ${pr.name} » (${LED_TYPES[pr.type] || pr.type}, ${COLOR_ORDERS[pr.order] || pr.order}, ${pr.len} px)`, danger: true, act: async () => { try { await api(`/api/led-profiles/${encodeURIComponent(pr.name)}`, { method: 'DELETE' }); } catch (e) { toast(e.message, true); } refreshProfileSelects(); } }))); return; }
      if (v === '') { remember(tr, null); return; }
      const pr = ledProfilesCache.find(x => x.id === v); if (!pr) return;
      const set = (k, val) => { const el = tr.querySelector(`[data-out=${k}]`); el.value = String(val); el.dispatchEvent(new Event('input')); };
      set('type', pr.type); set('order', pr.order); if (pr.len) set('len', pr.len);
      sl.value = v; remember(tr, v);
    });
    // the node remembers the profile of each output (MQTT client id suffix) ; in place, no re-render
    async function remember(tr, id) {
      const ip = tr.dataset.node, index = Number(tr.dataset.outrow);
      try { const r = await post(`/api/node/${encodeURIComponent(ip)}/output-profile`, { index, id }); if (r.queued) toast('node hors ligne : le profil sera proposé au retour (⏳ sur la ligne)'); } catch (e) { toast(`profil non mémorisé sur le node : ${e.message}`, true); }
    }
    // the one Save button: outputs block per changed node (backup first), then the node's DMX settings through pending + deploy
    const sb = $('#dmxSave'); if (sb) sb.onclick = async () => {
      const ips = changedNodes(); if (!ips.length) return;
      await stopLocating();
      const plan = [];
      for (const ip of ips) {
        const n = d.nodes.find(x => x.ip === ip); const rows = rowsOf(ip);
        const outsChanged = rows.some(tr => [...tr.querySelectorAll('[data-out][data-orig]')].some(el => (el.type === 'checkbox' ? (el.checked ? '1' : '0') : String(el.value)) !== String(el.dataset.orig)));
        const ins = outsChanged ? rows.map(tr => { const pl = n.plan; const o = pl.outputs[Number(tr.dataset.outrow)]; return { pin: o.pin, type: Number(tr.querySelector('[data-out=type]').value), order: Number(tr.querySelector('[data-out=order]').value), start: Number(tr.querySelector('[data-out=start]').value), len: Number(tr.querySelector('[data-out=len]').value), rev: tr.querySelector('[data-out=rev]').checked }; }) : null;
        const cell = p.querySelector(`[data-nodecell="${CSS.escape(ip)}"]`); const settings = [];
        for (const [id, col] of [['dmxmode', colDmx.mode], ['dmxuni', colDmx.uni], ['dmxaddr', colDmx.addr], ['maxpwr', colDmx.mA]]) { const el = cell && cell.querySelector(`[data-nb="${id}"]`); if (el && el.value !== '' && String(el.value) !== String(el.dataset.orig)) settings.push({ col, value: normalize(col, el.value) }); }
        plan.push({ ip, name: n.name || ip, ins, settings });
      }
      const lines = plan.map(x => `• ${x.name} : ${[x.ins ? `${x.ins.length} sorties (${x.ins.map(o => o.len).join(' + ')} px)` : '', ...x.settings.map(s => `${s.col.label} = ${raw(s.col, s.value)}`)].filter(Boolean).join(', ')}`).join('\n');
      if (!await confirmBox(`Écrire sur ${plan.length} node(s) ?\n\n${lines}\n\nSorties : bloc complet renvoyé (WLED le reconstruit), sauvegarde de la flotte prise avant. Réglages DMX : envoyés via Déployer.`)) return;
      sb.disabled = true; sb.textContent = 'écriture…';
      let staged = 0;
      for (const x of plan) {
        if (x.ins) { try { await post('/api/snapshots', { name: `avant sorties ${x.name}` }); const r = await post(`/api/node/${encodeURIComponent(x.ip)}/outputs`, { ins: x.ins }); toast(`${x.name} : sorties écrites, ${r.total} px`); } catch (e) { toast(`${x.name} : ${e.message}`, true); } }
        for (const s of x.settings) { stageValue(x.ip, s.col, s.value); staged++; }
      }
      if (staged) { updatePendingUI(); renderBody(); await deploy(); }
      setTimeout(renderDmx, 3000);
    };
    p.querySelectorAll('button[data-align]').forEach(b => b.onclick = async () => {
      const ip = b.dataset.align; const n = d.nodes.find(x => x.ip === ip); const pl = n.plan;
      let st = 0; const preview = pl.outputs.filter(o => o.len).map(o => { const slots = Math.ceil(o.len / pl.pxPerUni); const line = `  sortie ${o.i + 1} (pin ${o.pin}) : ${o.len} px, départ ${o.start} → ${st} = univers ${pl.uni + st / pl.pxPerUni}${slots > 1 ? '-' + (pl.uni + st / pl.pxPerUni + slots - 1) : ''}`; st += slots * pl.pxPerUni; return line; }).join('\n');
      if (!await confirmBox(`Aligner ${n.name || ip} sur « un univers par sortie » ?\n\n${preview}\n\nLe nombre de pixels de chaque sortie ne change pas ; les index laissés libres ne pilotent rien. Une sauvegarde de la flotte est prise avant. Continuer ?`)) return;
      b.disabled = true; b.textContent = 'alignement…';
      try {
        await post('/api/snapshots', { name: `avant alignement ${n.name || ip}` });
        const r = await post(`/api/node/${encodeURIComponent(ip)}/align-outputs`, {});
        toast(`${n.name || ip} : ${r.changes.length} sortie(s) alignée(s), ${r.total} px déclarés`);
      } catch (e) { toast(e.message, true); }
      setTimeout(renderDmx, 4000);
    });
  }

  // ── settings panel (settings.json, restart through the launcher) ───────────
  let setOpen = false;
  async function renderSettings() {
    const p = $('#setpanel');
    let d; try { d = await api('/api/settings'); } catch (e) { p.innerHTML = `<div class="st-bad">${esc(e.message)}</div>`; return; }
    const s = { ...d.effective, ...d.settings };
    const subnets = [...new Set(d.net.ifaces.map(i => i.subnet))];
    const lanIp = (d.net.fleetIface || d.net.ifaces[0] || {}).address;
    p.innerHTML = `<h2>Réglages <span class="muted" style="text-transform:none;letter-spacing:0" title="${esc(d.file)}">settings.json ⓘ</span></h2>
      <div class="setrow">
        <label for="sSubnet">Sous-réseau de la flotte</label>
        <div><input type="text" id="sSubnet" value="${esc(s.subnet || '')}" style="width:220px" placeholder="vide = toutes les cartes"> ${subnets.map(sn => `<button class="rowbtn" data-sub="${esc(sn)}" title="carte ${esc(d.net.ifaces.filter(i => i.subnet === sn).map(i => i.iface + ' ' + i.address).join(', '))}">${esc(sn)}.x</button>`).join('')} <button class="rowbtn" data-sub="">auto</button></div>
        <div class="hint">là où le scan cherche les nodes (/24). Plusieurs : séparés par des virgules. Vide = automatique, toutes les cartes du PC (plus lent, ${subnets.length} sous-réseaux actuellement). Cartes vues : ${esc(d.net.ifaces.map(i => `${i.iface} ${i.address}`).join(' · ') || 'aucune')}.</div>
        <label for="sListen">Accès à cette page</label>
        <div><select id="sListen"><option value="127.0.0.1:${esc(String(s.listen).split(':')[1] || '8792')}" ${String(s.listen).startsWith('127.') ? 'selected' : ''}>ce PC seulement (127.0.0.1)</option><option value="0.0.0.0:${esc(String(s.listen).split(':')[1] || '8792')}" ${String(s.listen).startsWith('0.0.0.0') ? 'selected' : ''}>tout le réseau (0.0.0.0)</option></select>
          port <input type="text" id="sPort" value="${esc(String(s.listen).split(':')[1] || '8792')}" style="width:70px"></div>
        <div class="hint">« tout le réseau » permet d'ouvrir la grille depuis une tablette ou un téléphone du show : http://${esc(lanIp || 'IP-du-PC')}:${esc(String(s.listen).split(':')[1] || '8792')}/ . Sans mot de passe : réservé au réseau du show.</div>
        <label for="sInterval">Relevé état / info</label>
        <div><input type="number" id="sInterval" value="${s.interval}" min="1000" max="60000" step="500" style="width:100px"> ms</div>
        <div class="hint">fréquence d'interrogation de chaque node (latence, RSSI, FPS, état). 3000 par défaut ; plus bas = plus réactif, plus de trafic.</div>
        <label for="sCfg">Relecture de la config</label>
        <div><input type="number" id="sCfg" value="${s.cfgInterval}" min="5000" max="600000" step="1000" style="width:100px"> ms</div>
        <div class="hint">fréquence de relecture de cfg.json (univers, DMX, sorties…). Détermine le délai de détection d'une modif externe. 20000 par défaut.</div>
        <label for="sPar">Mises à jour en parallèle</label>
        <div><input type="number" id="sPar" value="${s.otaParallel}" min="1" max="32" style="width:70px"> node(s) à la fois</div>
        <div class="hint">valeur par défaut du sélecteur du panneau Mises à jour. 1 en Wi‑Fi, plus en Ethernet.</div>
        <label for="sRo">Lecture seule</label>
        <div><label class="chip"><input type="checkbox" id="sRo" ${s.readonly ? 'checked' : ''}> interdire toute écriture</label></div>
        <div class="hint">mode « régie » : aucune cellule modifiable, pas de déploiement, pas d'OTA, pas d'appairage, pas d'écriture sur l'antenne. Pour laisser la grille ouverte sans risque pendant un show.</div>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px;align-items:center">
        <button id="sSave" class="primary" title="écrit settings.json puis ${d.launcher ? 'redémarre le serveur (7 s), la page se reconnecte seule' : 'attend un redémarrage manuel (pas de lanceur)'}">Enregistrer${d.launcher ? ' et redémarrer' : ''}</button>
        ${d.launcher ? '' : '<span class="st-warn">serveur lancé sans WLED-Fleet.cmd : après enregistrement, le relancer à la main</span>'}
      </div>`;
    p.querySelectorAll('button[data-sub]').forEach(b => b.onclick = () => { $('#sSubnet').value = b.dataset.sub; });
    $('#sSave').onclick = async () => {
      const port = $('#sPort').value.trim();
      const body = { subnet: $('#sSubnet').value, listen: $('#sListen').value.split(':')[0] + ':' + port, interval: Number($('#sInterval').value), cfgInterval: Number($('#sCfg').value), otaParallel: Number($('#sPar').value), readonly: $('#sRo').checked };
      if (pending.size && !await confirmBox(`${pending.size} changement(s) en attente seront perdus au redémarrage. Continuer ?`)) return;
      try {
        const r = await post('/api/settings', body);
        toast(r.restarting ? 'réglages enregistrés, redémarrage…' : 'réglages enregistrés (relancer le serveur pour appliquer)');
        if (r.restarting) { const newPort = port; setTimeout(() => { location.href = `http://${location.hostname}:${newPort}/`; }, 5000); }
      } catch (e) { toast(e.message, true); }
    };
  }

  // ── pairing of new nodes through the PC's Wi-Fi card ───────────────────────
  // Deliberately minimal: the list shows WLED access points only, each with a
  // proposed free IP and an « Appairer » button. The show network (SSID +
  // password) comes from the antenna; the node keeps its own name. Nothing
  // else is written.
  let pairOpen = false, pairNets = null, pairPc = null, pairJob = null, pairShow = null, pairAll = false, pairApConfigured = null;
  // radar mode (NetSpot-like): native WlanScan every 8 s while the tab is open, signal history per BSSID
  let pairRadar = false, pairRadarTimer = null, pairScanning = false; const pairHist = new Map();
  const spark = (arr, w = 60, h = 14) => { if (!arr || !arr.length) return ''; const pts = arr.map((v, i) => `${(i / Math.max(1, arr.length - 1)) * w},${h - Math.round((v / 100) * (h - 2)) - 1}`).join(' '); return `<svg width="${w}" height="${h}" style="vertical-align:middle;margin-left:6px"><polyline points="${pts}" fill="none" stroke="var(--info)" stroke-width="1.5"/></svg>`; };
  async function pollPair() {
    if (!pairOpen) return;
    try { const j = await api('/api/pair/status'); pairJob = j.job; } catch { /* server away */ }
    renderPair();
  }
  async function scanPair(deep = false) {
    if (pairScanning) return;
    if (deep && !await confirmBox('Recherche approfondie : le PC coupe son Wi‑Fi une dizaine de secondes pour forcer un vrai scan, puis se reconnecte. À réserver au cas où le scan normal ne voit rien. Continuer ?')) return;
    pairScanning = true;
    const b = $('#pairScan'); if (b) { b.disabled = true; b.textContent = 'scan…'; }
    const b2 = $('#pairDeep'); if (b2) b2.disabled = true;
    try {
      const r = await api('/api/pair/networks' + (deep ? '?deep=1' : '')); pairNets = r.networks; pairPc = r.pc; pairShow = r.show; pairApConfigured = r.apConfigured;
      const now = Date.now();
      for (const n of pairNets) { const k = n.bssid || n.ssid; const h = pairHist.get(k) || { s: [], seen: now }; h.s.push(n.signal ?? 0); if (h.s.length > 15) h.s.shift(); h.seen = now; pairHist.set(k, h); n.hist = h.s; }
    } catch (e) { toast(e.message, true); }
    pairScanning = false;
    renderPair();
  }
  function setRadar(on) {
    pairRadar = on; if (pairRadarTimer) { clearInterval(pairRadarTimer); pairRadarTimer = null; }
    if (on) { scanPair(false); pairRadarTimer = setInterval(() => { if (pairOpen && !(pairJob && pairJob.status === 'running')) scanPair(false); else if (!pairOpen) setRadar(false); }, 8000); }
  }
  function renderPair() {
    const p = $('#pairpanel');
    const nets = pairNets || [];
    const shown = pairAll ? nets : nets.filter(n => n.candidate);
    const running = pairJob && pairJob.status === 'running';
    const keep = (ssid, field) => { const el = p.querySelector(`[data-ssid="${CSS.escape(ssid)}"][data-field="${field}"]`); if (!el) return null; return el.type === 'checkbox' ? (el.checked ? 'on' : 'off') : el.value; };
    const rows = shown.map(n => {
      const ip = keep(n.ssid, 'ip') ?? n.suggestedIp ?? '';
      const key = keep(n.ssid, 'key') ?? n.key ?? '';
      const ident = n.ident === 'wled'
        ? `<span class="tag stable" title="prouvé : /json/info lu à travers cet AP le ${new Date(n.verified.at).toLocaleTimeString()} — ${esc(n.verified.brand || '')} WLED ${esc(n.verified.ver || '')}, MAC ${esc(n.verified.mac || '')}">✓ WLED ${esc(n.verified.ver || '')}</span>`
        : n.knownNode ? `<span class="tag stable" title="le BSSID de cet AP est la MAC + 1 d'un node déjà dans la flotte : c'est son AP de secours, pas un nouveau node">AP de ${esc(n.knownNode)}</span>`
        : n.ident === 'espressif' ? `<span class="tag local" title="préfixe MAC ${esc(n.oui)} enregistré à l'IEEE au nom d'Espressif : puce ESP32/ESP8266, donc WLED possible mais pas prouvé (d'autres objets connectés utilisent ces puces). « Vérifier » lit /json/info à travers l'AP pour en avoir le cœur net.">Espressif · probable</span>`
        : n.ident === 'autre' ? `<span class="muted" title="préfixe MAC ${esc(n.oui)} : pas une puce Espressif, donc pas un WLED, quel que soit le nom">autre appareil</span>`
        : '<span class="muted">BSSID inconnu</span>';
      const tags = [ident, n.nameHint && n.ident !== 'wled' ? '<span class="muted" title="le nom ressemble à un WLED, mais un nom se change : simple indice">nom évocateur</span>' : '', n.via === 'antenne' ? '<span class="muted" title="vu par l\'antenne, pas (encore) par la carte Wi‑Fi du PC">(antenne)</span>' : ''].filter(Boolean).join(' ');
      return `<tr class="${n.candidate ? '' : 'offline'}">
        <td>${n.candidate ? `<b>${esc(n.ssid || '(caché)')}</b>` : esc(n.ssid || '(caché)')} ${tags}<div class="muted" style="font-size:10px">${esc(n.bssid || '')}${n.channel ? ' · canal ' + n.channel : ''}</div></td>
        <td>${n.open ? '<span class="st-warn">ouvert</span>' : esc(n.auth)}</td>
        <td>${n.signal ?? ''} %${spark(n.hist)}${n.stale ? ` <span class="muted" title="absent du dernier scan ; les AP WLED balisent lentement, il peut revenir au suivant">vu il y a ${fmtDur(n.seenAgo)}</span>` : ''}</td>
        <td><input type="text" data-ssid="${esc(n.ssid)}" data-field="key" value="${esc(key)}" style="width:95px" placeholder="(ouvert)" title="clé de l'AP du node : wled1234 par défaut, vide si réseau ouvert"></td>
        <td><input type="text" data-ssid="${esc(n.ssid)}" data-field="ip" value="${esc(ip)}" style="width:125px" placeholder="DHCP" title="IP fixe proposée, libre et dans la suite des nodes existants ; modifiable ; vide = DHCP"></td>
        <td><input type="text" data-ssid="${esc(n.ssid)}" data-field="name" value="${esc(keep(n.ssid, 'name') ?? (n.verified ? n.verified.name : ''))}" style="width:150px" placeholder="${n.verified ? '' : 'inchangé (Vérifier pour le lire)'}" title="nom WLED du node (id.name). Pré-rempli avec le nom d'origine une fois lu par Vérifier ; le modifier renomme le node à l'appairage ; vide = inchangé.">
            <label class="chip" style="margin-left:4px" title="aligne le mDNS (forme d'hôte) et le SSID de l'AP sur le nom, pour que les trois noms concordent"><input type="checkbox" data-ssid="${esc(n.ssid)}" data-field="unify" ${keep(n.ssid, 'unify') === 'off' ? '' : 'checked'}> unifier</label></td>
        <td>${n.ident !== 'wled' && !n.knownNode ? `<button class="rowbtn" data-verify="${esc(n.ssid)}" ${running ? 'disabled' : ''} title="preuve : le PC rejoint cet AP ~20 s, lit /json/info en 4.3.2.1, revient. Rien n'est écrit. Si c'est un WLED, la ligne passe en « ✓ WLED ».">Vérifier</button>` : ''}
            <button class="rowbtn primary" data-pair="${esc(n.ssid)}" data-cand="${n.candidate ? 1 : 0}" ${running || !pairShow ? 'disabled' : ''} title="le PC rejoint l'AP du node, lui envoie le réseau ${esc(pairShow ? pairShow.ssid : 'du show')} et cette IP, le redémarre, puis revient. Nom du node inchangé.${n.candidate ? '' : ' Pas une puce Espressif : ce n\'est pas un WLED, une confirmation supplémentaire sera demandée.'}">Appairer</button></td></tr>`;
    }).join('');
    const pcState = pairPc ? (pairPc.connected ? `sur « ${esc(pairPc.ssid)} »` : (running ? 'déconnectée, appairage en cours' : 'déconnectée')) : '';
    const showTxt = pairShow
      ? `<b>${esc(pairShow.ssid)}</b> ${pairShow.hasPsk ? '(mot de passe lu sur l\'antenne)' : '<span class="st-bad">(mot de passe introuvable sur l\'antenne)</span>'}${pairShow.stale ? ' <span class="st-warn" title="l\'antenne ne répond pas en ce moment (Wi‑Fi du PC coupé ?) : dernière valeur connue utilisée">· antenne injoignable à l\'instant, dernière valeur connue</span>' : ''}`
      : pairApConfigured ? '<span class="st-warn">antenne injoignable en ce moment (Wi‑Fi du PC coupé ?), réessayer dans quelques secondes</span>'
      : '<span class="st-bad">antenne non configurée (onglet Antenne), appairage impossible</span>';
    p.innerHTML = `<h2>Appairage <span class="muted" style="text-transform:none;letter-spacing:0">via la carte Wi‑Fi de ce PC${pcState ? ` (${pcState})` : ''} · réseau du show : ${showTxt}</span>
        <span class="spacer"></span>
        <label class="chip" style="text-transform:none;letter-spacing:0" title="scan natif (WlanScan, comme NetSpot) toutes les 8 s sans couper le Wi‑Fi, avec l'historique du signal de chaque réseau"><input type="checkbox" id="pairRadar" ${pairRadar ? 'checked' : ''}> radar 8 s</label>
        <label class="chip" style="text-transform:none;letter-spacing:0" title="par défaut seuls les appareils à puce Espressif (registre IEEE, 344 préfixes) sont listés : les autres ne peuvent pas être des WLED. Le nom n'est qu'un indice affiché, jamais un critère."><input type="checkbox" id="pairAll" ${pairAll ? 'checked' : ''}> tous les réseaux</label>
        <button id="pairScan" title="scan natif de tous les canaux (~4 s) sans couper le Wi‑Fi, + réseaux vus par l'antenne dans les 15 dernières minutes">Scanner</button>
        <button id="pairDeep" title="en dernier recours seulement : coupe le Wi‑Fi du PC ~10 s pour un scan hors connexion, puis se reconnecte">Scan hors connexion</button></h2>
      ${pairPc && pairPc.ipConfig && !pairPc.ipConfig.dhcp ? `<div class="st-warn" style="margin:4px 0">▲ la carte ${esc(pairPc.ipConfig.name)} est en IP fixe ${esc(pairPc.ipConfig.ip || '')} : elle sera passée en DHCP le temps de l'appairage (Windows demandera une élévation, aller et retour), puis remise à l'identique.</div>` : ''}
      ${shown.length ? `<table><thead><tr><th>AP détecté</th><th>Sécurité</th><th>Signal</th><th>Clé de l'AP</th><th>IP proposée</th><th title="nom WLED du node : lu par Vérifier, modifiable, vide = inchangé ; « unifier » aligne mDNS et SSID de l'AP dessus">Nom du node</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
        : `<div class="muted">${pairNets ? 'aucun WLED probable visible : allumer le node à appairer à portée du PC, puis « Scanner » (ou cocher radar 8 s)' : 'scan en cours…'}</div>`}
      ${pairJob ? `<div class="subbox" style="margin-top:8px"><b class="${pairJob.status === 'done' ? 'st-ok' : pairJob.status === 'error' ? 'st-bad' : 'st-info'}">${pairJob.mode === 'test' ? 'Test' : 'Appairage'} « ${esc(pairJob.ssid)} » : ${esc(pairJob.status)}</b>
        <div class="log">${pairJob.log.map(l => `${new Date(l.at).toLocaleTimeString()}  ${esc(l.m)}`).join('\n')}</div></div>` : ''}`;
    $('#pairScan').onclick = () => scanPair(false); $('#pairDeep').onclick = () => scanPair(true);
    $('#pairAll').onchange = e => { pairAll = e.target.checked; renderPair(); };
    $('#pairRadar').onchange = e => setRadar(e.target.checked);
    p.querySelectorAll('button[data-verify]').forEach(b => b.onclick = async () => {
      const ssid = b.dataset.verify;
      const key = (p.querySelector(`[data-ssid="${CSS.escape(ssid)}"][data-field="key"]`) || {}).value || '';
      if (!await confirmBox(`Vérifier « ${ssid} » ?\n\nLe PC quitte « ${pairPc ? pairPc.ssid : '?'} » ~20 s pour rejoindre cet AP, lit son identité (/json/info), puis revient. Rien n'est écrit.`)) return;
      try { await post('/api/pair/test', { ssid, key }); toast(`vérification de ${ssid} lancée`); } catch (e) { toast(e.message, true); }
      pollPair();
    });
    p.querySelectorAll('button[data-pair]').forEach(b => b.onclick = async () => {
      const ssid = b.dataset.pair;
      if (b.dataset.cand === '0' && !await confirmBox(`« ${ssid} » n'a pas une puce Espressif (préfixe MAC hors registre IEEE Espressif) : ce n'est pas un WLED. Tenter l'appairage quand même ?`)) return;
      const key = (p.querySelector(`[data-ssid="${CSS.escape(ssid)}"][data-field="key"]`) || {}).value || '';
      const ip = ((p.querySelector(`[data-ssid="${CSS.escape(ssid)}"][data-field="ip"]`) || {}).value || '').trim();
      const name = ((p.querySelector(`[data-ssid="${CSS.escape(ssid)}"][data-field="name"]`) || {}).value || '').trim();
      const unify = !!(p.querySelector(`[data-ssid="${CSS.escape(ssid)}"][data-field="unify"]`) || {}).checked;
      const n = nets.find(x => x.ssid === ssid); const orig = n && n.verified ? n.verified.name : null;
      const nameTxt = name && name !== orig ? `le renomme « ${name} »` : 'garde son nom';
      if (!await confirmBox(`Appairer « ${ssid} » ?\n\nLe PC quitte « ${pairPc ? pairPc.ssid : '?'} » ~30 s pour rejoindre l'AP du node, lui envoie le réseau « ${pairShow.ssid} »${ip ? ' en ' + ip : ' (DHCP)'}, ${nameTxt}${unify ? ', aligne mDNS et SSID de l\'AP sur ce nom' : ''}, le redémarre, puis revient.`)) return;
      try { await post('/api/pair', { ssid, key, ip, name, unify }); toast(`appairage de ${ssid} lancé`); } catch (e) { toast(e.message, true); }
      pollPair();
    });
  }
  setInterval(() => { if (pairOpen && pairJob && pairJob.status === 'running') pollPair(); }, 2000);

  // ── fleet snapshots (offline store, export / import / compare / restore) ───
  let snapOpen = false, snapList = [], snapView = null; // snapView = {id, mode:'diff'|'restore', data}
  const post = (u, b) => api(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
  async function pollSnap() {
    if (!snapOpen) return;
    try { snapList = (await api('/api/snapshots')).snapshots; renderSnap(); } catch { /* server away */ }
  }
  // ── showfile: everything the app knows in ONE file (settings, antennas with
  // passwords, node list with last known data, config backups, firmware
  // catalogue, column layout), optionally encrypted with a passphrase
  const layoutForShowfile = () => { try { return { colOrder: JSON.parse(localStorage.getItem('wf.colOrder') || 'null'), colWidths: JSON.parse(localStorage.getItem('wf.colWidths') || '{}'), hiddenGroups: JSON.parse(localStorage.getItem('wf.hiddenGroups') || '[]') }; } catch { return null; } };
  async function exportShowfile() {
    const pass = $('#sfPass').value;
    const body = { passphrase: pass || undefined, include: { journal: $('#sfJournal').checked }, layout: layoutForShowfile() };
    try {
      const doc = await post('/api/showfile', body);
      const name = `WLED-Fleet ${new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', 'h')}.wledfleet`;
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(doc)], { type: 'application/json' })); a.download = name; a.click();
      toast(`showfile exporté${pass ? ' (chiffré)' : ' (en clair : contient les mots de passe)'}`);
    } catch (e) { toast(e.message, true); }
  }
  async function importShowfile(file) {
    let doc; try { doc = JSON.parse(await file.text()); } catch { return toast('fichier illisible', true); }
    const enc = doc.format === 'wledfleet-showfile-encrypted';
    const pass = enc ? prompt('Ce showfile est chiffré. Phrase secrète :') : '';
    if (enc && pass === null) return;
    const what = { settings: $('#sfW_settings').checked, antennas: $('#sfW_antennas').checked, nodes: $('#sfW_nodes').checked, snapshots: $('#sfW_snapshots').checked, firmware: $('#sfW_firmware').checked };
    if (!await confirmBox(`Importer le showfile${doc.exportedAt ? ' du ' + new Date(doc.exportedAt).toLocaleString() : ''} ?\n\nRemplace : ${Object.entries(what).filter(([, v]) => v).map(([k]) => ({ settings: 'réglages', antennas: 'antennes + mots de passe', nodes: 'liste des nodes', snapshots: 'sauvegardes', firmware: 'catalogue firmware' })[k]).join(', ')}${what.settings ? '\n\nLe serveur redémarrera pour appliquer les réglages.' : ''}`)) return;
    try {
      const r = await post('/api/showfile/import', { file: doc, passphrase: pass || undefined, what });
      if (r.layout && $('#sfW_layout').checked) { try { if (r.layout.colOrder) localStorage.setItem('wf.colOrder', JSON.stringify(r.layout.colOrder)); if (r.layout.colWidths) localStorage.setItem('wf.colWidths', JSON.stringify(r.layout.colWidths)); if (r.layout.hiddenGroups) localStorage.setItem('wf.hiddenGroups', JSON.stringify(r.layout.hiddenGroups)); } catch { /* ignore */ } }
      toast(`importé : ${r.done.join(', ')}${r.restarting ? ' · redémarrage…' : ''}`);
      setTimeout(() => location.reload(), r.restarting ? 6000 : 1500);
    } catch (e) { toast(e.message, true); }
  }
  function showfileHtml() {
    return `<div class="subbox" style="margin-bottom:10px"><h2 style="margin-top:0">Showfile <span class="muted" style="text-transform:none;letter-spacing:0" title="un seul fichier .wledfleet avec tout : réglages, antennes et leurs mots de passe, nodes et groupes, sauvegardes de configs, catalogue firmware, disposition des colonnes">tout le show dans un fichier ⓘ</span></h2>
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
        <input type="password" id="sfPass" placeholder="phrase secrète (option)" style="width:190px" title="si renseignée, le fichier est chiffré (AES-256) : à conserver, sans elle le fichier est illisible. Vide = fichier en clair, mots de passe lisibles.">
        <label class="chip" title="ajoute le journal des modifications et l'historique des scans radio (plus gros, utile pour un rapport)"><input type="checkbox" id="sfJournal"> avec le journal</label>
        <button id="sfExport" class="primary" title="télécharge le showfile">⬇ Exporter le showfile</button>
        <span style="width:16px"></span>
        <label class="rowbtn" style="cursor:pointer" title="importer un showfile (.wledfleet) : d'ici ou d'un autre PC">⬆ Importer un showfile <input type="file" id="sfImport" accept=".wledfleet,.json" style="display:none"></label>
        <span class="muted">remplacer :</span>
        <label class="chip"><input type="checkbox" id="sfW_settings" checked> réglages</label>
        <label class="chip"><input type="checkbox" id="sfW_antennas" checked> antennes</label>
        <label class="chip"><input type="checkbox" id="sfW_nodes" checked> nodes</label>
        <label class="chip"><input type="checkbox" id="sfW_snapshots" checked> sauvegardes</label>
        <label class="chip"><input type="checkbox" id="sfW_firmware" checked> catalogue firmware</label>
        <label class="chip"><input type="checkbox" id="sfW_layout" checked> colonnes</label>
      </div></div>`;
  }
  function wireShowfile() {
    $('#sfExport').onclick = exportShowfile;
    $('#sfImport').onchange = () => { const f = $('#sfImport').files[0]; if (f) importShowfile(f); $('#sfImport').value = ''; };
  }

  function renderSnap() {
    const p = $('#snappanel');
    const head = showfileHtml() + `<h2>Sauvegardes de la flotte <span class="muted" style="text-transform:none;letter-spacing:0" title="stockées hors ligne dans wled-fleet/snapshots/ : cfg.json + presets.json de chaque node en ligne">cfg + presets de chaque node ⓘ</span>
      <span class="spacer"></span>
      <input type="text" id="snapName" placeholder="nom (ex. avant tournée)" style="width:180px" title="nom de la sauvegarde ; la date est ajoutée automatiquement">
      <button id="snapNew" class="primary" title="lit cfg.json et presets.json de chaque node en ligne et les enregistre sur ce PC">Sauvegarder la flotte maintenant</button>
      <label class="rowbtn" style="cursor:pointer" title="importer un fichier exporté d'ici (ou d'un autre PC)">⬆ Importer <input type="file" id="snapImport" accept=".json" style="display:none"></label>
    </h2>`;
    const rows = snapList.map(s => `<tr><td><b>${esc(s.name)}</b>${s.imported ? ' <span class="tag local">importée</span>' : ''}<div class="muted">${esc(s.id)}</div></td><td>${new Date(s.createdAt).toLocaleString()}</td><td title="${esc(s.nodeNames.join(', '))}">${s.nodes} node${s.nodes > 1 ? 's' : ''} <span class="muted">${esc(s.nodeNames.slice(0, 4).join(', '))}${s.nodeNames.length > 4 ? '…' : ''}</span></td><td>${fmtSize(s.size)}</td>
      <td><a class="rowbtn" href="/api/snapshots/${encodeURIComponent(s.id)}?download=1" title="exporter en fichier JSON (à garder ailleurs, à importer sur un autre PC)">⬇ Exporter</a>
      <button class="rowbtn" data-snap="diff" data-id="${esc(s.id)}" title="comparer cette sauvegarde avec la configuration actuelle des nodes">Comparer</button>
      <button class="rowbtn" data-snap="restore" data-id="${esc(s.id)}" title="renvoyer cfg.json / presets.json vers les nodes (choix des nodes à l'étape suivante)">Restaurer…</button>
      <button class="rowbtn danger" data-snap="del" data-id="${esc(s.id)}" title="supprimer cette sauvegarde du PC">✕</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">aucune sauvegarde pour l\'instant</td></tr>';
    let detail = '';
    if (snapView && snapView.mode === 'diff') {
      const d = snapView.data;
      detail = `<div class="subbox"><h2 style="margin-top:0">Comparaison « ${esc(snapView.name)} » ↔ maintenant <span class="spacer"></span><button class="rowbtn" data-snap="close">fermer</button></h2>
        <table><thead><tr><th>Node</th><th>Présent</th><th>Différences</th></tr></thead><tbody>${d.nodes.map(n => `<tr><td><b>${esc(n.name || n.ip)}</b> <span class="muted">${esc(n.mac || '')}${n.liveIp && n.liveIp !== n.ip ? ` · IP ${esc(n.ip)} → ${esc(n.liveIp)}` : ''}</span></td><td>${n.present ? (n.online ? '<span class="st-ok">en ligne</span>' : '<span class="st-warn">hors ligne</span>') : '<span class="st-bad">absent de la flotte</span>'}</td><td>${n.present ? (n.changes.length ? n.changes.map(c => `<div><b>${esc(c.label)}</b> : <span class="muted">sauvé</span> ${esc(String(c.saved ?? ''))} → <span class="muted">actuel</span> ${esc(String(c.live ?? ''))}</div>`).join('') : '<span class="st-ok">identique</span>') : ''}</td></tr>`).join('')}</tbody></table></div>`;
    }
    if (snapView && snapView.mode === 'restore') {
      const d = snapView.data;
      detail = `<div class="subbox"><h2 style="margin-top:0">Restaurer « ${esc(snapView.name)} » <span class="spacer"></span><button class="rowbtn" data-snap="close">fermer</button></h2>
        <table><thead><tr><th><input type="checkbox" id="rsAll"></th><th>Node sauvegardé</th><th>Node actuel</th><th>Différences</th></tr></thead><tbody>${d.nodes.map(n => `<tr><td><input type="checkbox" class="rsel" data-key="${esc(n.mac || n.ip)}" ${n.present && n.online ? '' : 'disabled'}></td><td><b>${esc(n.name || n.ip)}</b> <span class="muted">${esc(n.mac || '')}</span></td><td>${n.present ? (n.online ? `<span class="st-ok">${esc(n.liveIp)}</span>` : '<span class="st-warn">hors ligne</span>') : '<span class="st-bad">absent</span>'}</td><td>${n.present ? (n.changes.length ? `${n.changes.length} réglage(s) diffèrent : ${esc(n.changes.map(c => c.label).join(', '))}` : '<span class="muted">identique</span>') : ''}${n.presetsSaved === false ? ' <span class="muted">(pas de presets dans la sauvegarde)</span>' : ''}</td></tr>`).join('')}</tbody></table>
        <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-top:8px">
          <label class="chip" title="renvoie cfg.json : réglages LED, E1.31/DMX, sync, défauts…"><input type="checkbox" id="rsCfg" checked> cfg.json</label>
          <label class="chip" title="renvoie presets.json : tous les presets et playlists"><input type="checkbox" id="rsPresets" checked> presets.json</label>
          <label class="chip" title="conserve le Wi‑Fi / Ethernet / IP fixe actuels du node au lieu de ceux de la sauvegarde (évite de perdre un node en lui poussant un autre réseau)"><input type="checkbox" id="rsKeepNet" checked> garder le réseau du node</label>
          <label class="chip" title="redémarre le node après cfg.json (obligatoire pour qu'il relise sa config)"><input type="checkbox" id="rsReboot" checked> redémarrer après</label>
          <button id="rsGo" class="primary" disabled>Restaurer la sélection</button>
        </div>
        <div id="rsResult" style="margin-top:6px"></div></div>`;
    }
    p.innerHTML = head + `<table><thead><tr><th>Sauvegarde</th><th>Date</th><th>Contenu</th><th>Taille</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>` + detail;
    wireShowfile();
    wireSnap();
  }
  function wireSnap() {
    const p = $('#snappanel');
    $('#snapNew').onclick = async () => {
      const b = $('#snapNew'); b.disabled = true; b.textContent = 'lecture des nodes…';
      try { const r = await post('/api/snapshots', { name: $('#snapName').value.trim() }); toast(`sauvegarde « ${r.name} » : ${r.nodes} node(s)${r.errors.length ? ' — ' + r.errors.join(' ; ') : ''}`, r.errors.length > 0); }
      catch (e) { toast(e.message, true); }
      pollSnap();
    };
    $('#snapImport').onchange = async () => {
      const f = $('#snapImport').files[0]; if (!f) return;
      try { const r = await api('/api/snapshots/import', { method: 'POST', headers: { 'X-Filename': f.name }, body: f }); toast(`importée : « ${r.name} », ${r.nodes} node(s)`); }
      catch (e) { toast(e.message, true); }
      pollSnap();
    };
    p.querySelectorAll('button[data-snap]').forEach(b => b.onclick = async () => {
      const id = b.dataset.id, act = b.dataset.snap, meta = snapList.find(s => s.id === id);
      try {
        if (act === 'close') { snapView = null; renderSnap(); }
        if (act === 'del') { if (!await confirmBox(`Supprimer la sauvegarde « ${meta.name} » ?`)) return; await api(`/api/snapshots/${encodeURIComponent(id)}`, { method: 'DELETE' }); if (snapView && snapView.id === id) snapView = null; pollSnap(); }
        if (act === 'diff' || act === 'restore') { const d = await api(`/api/snapshots/${encodeURIComponent(id)}/diff`); snapView = { id, name: meta.name, mode: act, data: d }; renderSnap(); }
      } catch (e) { toast(e.message, true); }
    });
    const upd = () => { const n = p.querySelectorAll('input.rsel:checked').length; const g = $('#rsGo'); if (g) { g.disabled = !n; g.textContent = n ? `Restaurer ${n} node${n > 1 ? 's' : ''}` : 'Restaurer la sélection'; } };
    p.querySelectorAll('input.rsel').forEach(cb => cb.onchange = upd);
    const all = $('#rsAll'); if (all) all.onchange = e => { p.querySelectorAll('input.rsel:not(:disabled)').forEach(cb => cb.checked = e.target.checked); upd(); };
    const go = $('#rsGo'); if (go) go.onclick = async () => {
      const targets = [...p.querySelectorAll('input.rsel:checked')].map(cb => cb.dataset.key);
      const what = { cfg: $('#rsCfg').checked, presets: $('#rsPresets').checked, keepNetwork: $('#rsKeepNet').checked };
      if (!what.cfg && !what.presets) return toast('rien à restaurer : cocher cfg.json et/ou presets.json', true);
      const names = targets.map(k => (snapView.data.nodes.find(n => (n.mac || n.ip) === k) || {}).name || k);
      if (!await confirmBox(`Restaurer ${what.cfg ? 'cfg.json' : ''}${what.cfg && what.presets ? ' + ' : ''}${what.presets ? 'presets.json' : ''} de « ${snapView.name} » sur ${targets.length} node(s) ?\n\n${names.map(n => '• ' + n).join('\n')}\n\nLes réglages actuels de ces nodes seront écrasés${$('#rsReboot').checked ? ', puis ils redémarreront' : ''}.`)) return;
      go.disabled = true; go.textContent = 'restauration…'; $('#rsResult').innerHTML = '<span class="muted">envoi en cours, un node à la fois…</span>';
      try {
        const r = await post(`/api/snapshots/${encodeURIComponent(snapView.id)}/restore`, { targets, what, reboot: $('#rsReboot').checked });
        $('#rsResult').innerHTML = r.results.map(x => `<div>${x.ok ? '<span class="st-ok">✓</span>' : '<span class="st-bad">✗</span>'} <b>${esc(x.name || x.key)}</b> ${esc(x.ip || '')} : ${x.ok ? esc(x.done.join(' + ')) : esc(x.error)}</div>`).join('');
        toast(`${r.results.filter(x => x.ok).length}/${r.results.length} node(s) restauré(s)`);
      } catch (e) { toast(e.message, true); go.disabled = false; }
    };
  }

  // ── antenna (MikroTik, read-only) ──────────────────────────────────────────
  let apOpen = false, apData = null, apPresetData = null, apPresetLoading = false;
  const sigBar = dbm => { if (dbm == null) return ''; const pct = Math.max(0, Math.min(100, Math.round((dbm + 90) * 2))); const col = dbm >= -60 ? 'var(--accent)' : dbm >= -72 ? 'var(--warn)' : 'var(--bad)'; return `<span class="sig" title="${dbm} dBm"><i style="width:${pct}%;background:${col}"></i></span>`; };
  async function pollAp() {
    try {
      const [a, wz] = await Promise.all([api('/api/ap'), api('/api/wizard').catch(() => null)]);
      apData = a; if (wz) wizData = wz;
      const n = apData.ok ? apData.clients.length : 0;
      $('#btnAp').innerHTML = `Antenne${n ? ` <span class="n">${n}</span>` : ''}${wizData && wizData.state === 'connected' ? ' <span class="n" style="background:var(--accent)" title="WiFiman Wizard connecté">W</span>' : ''}`;
      $('#btnAp').style.color = apData.configured && !apData.ok ? 'var(--bad)' : '';
      if (apOpen) renderAp();
    } catch { /* server away */ }
  }
  function renderAp() {
    const d = apData; if (!d) return;
    const p = $('#appanel');
    // one row per antenna: discovered by MNDP and/or with saved credentials (one credential set per AP, in ap.json)
    const savedBy = Object.fromEntries((d.saved || []).map(s => [s.host, s]));
    const rowsAp = d.discovered.map(x => ({ host: x.ipv4 || x.from, identity: x.identity, board: x.board, version: x.version, mac: x.mac, seenAt: x.seenAt }));
    for (const s of d.saved || []) if (!rowsAp.some(r => r.host === s.host)) rowsAp.push({ host: s.host, identity: '', board: '(hors réseau / non annoncée)', version: '', mac: '', seenAt: null });
    const apBtns = r => {
      const s = savedBy[r.host];
      if (s && s.active && d.ok) return `<span class="st-ok" title="antenne actuellement interrogée, identifiants enregistrés">● connectée (${esc(s.user)})</span> <button class="rowbtn danger" data-apact="forget" data-host="${esc(r.host)}" title="supprimer les identifiants enregistrés pour cette antenne">✕</button>`;
      if (s && s.active) return `<span class="st-bad" title="${esc(d.error || '')}">● refusée (${esc(s.user)})</span> <button class="rowbtn" data-apact="fill" data-host="${esc(r.host)}" title="ressaisir le mot de passe dans le formulaire ci-dessous">Identifiants…</button> <button class="rowbtn danger" data-apact="forget" data-host="${esc(r.host)}" title="supprimer les identifiants enregistrés">✕</button>`;
      if (s) return `<button class="rowbtn" data-apact="connect" data-host="${esc(r.host)}" title="basculer sur cette antenne avec ses identifiants déjà enregistrés (${esc(s.user)})">Connecter</button> <button class="rowbtn danger" data-apact="forget" data-host="${esc(r.host)}" title="supprimer ses identifiants enregistrés">✕</button>`;
      return `<button class="rowbtn" data-apact="fill" data-host="${esc(r.host)}" title="saisir ses identifiants dans le formulaire ci-dessous (enregistrés pour cette antenne uniquement)">Identifiants…</button>`;
    };
    const disc = rowsAp.length ? `<h2>Antennes <span class="muted" style="text-transform:none;letter-spacing:0">(découvertes par MNDP sans identifiants + enregistrées ; un jeu d'identifiants par antenne)</span></h2><table><thead><tr><th>IP</th><th>Identité</th><th>Carte</th><th>RouterOS</th><th>MAC</th><th>Vue il y a</th><th>Identifiants</th></tr></thead><tbody>${rowsAp.map(x => `<tr><td><a href="http://${esc(x.host)}/" target="_blank" rel="noopener">${esc(x.host)}</a></td><td>${esc(x.identity || '')}</td><td>${esc(x.board || '')}</td><td>${esc(x.version || '')}</td><td>${esc(x.mac || '')}</td><td>${x.seenAt ? fmtDur((Date.now() - x.seenAt) / 1000) : '—'}</td><td>${apBtns(x)}</td></tr>`).join('')}</tbody></table>` : '<div class="muted">aucune annonce MNDP reçue pour l\'instant (les MikroTik s\'annoncent toutes les 60 s)</div>';
    const form = (title, msg) => {
      const host = d.host || (d.discovered[0] && (d.discovered[0].ipv4 || d.discovered[0].from)) || '192.168.88.1';
      return `<h2>${title}</h2>${msg ? `<div class="st-bad" style="margin-bottom:6px">${esc(msg)}</div>` : ''}
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
        <input type="text" id="apHost" value="${esc(host)}" style="width:150px" title="IP du routeur MikroTik (pré-remplie avec l'antenne découverte)">
        <input type="text" id="apUser" value="${esc(d.user || 'admin')}" style="width:110px" placeholder="utilisateur" title="utilisateur RouterOS ; un compte du groupe read suffit">
        <input type="password" id="apPass" style="width:170px" placeholder="mot de passe" title="mot de passe RouterOS (étiquette sous l'antenne pour un appareil neuf). Enregistré dans wled-fleet/ap.json, ignoré par git, jamais envoyé ailleurs qu'au routeur.">
        <button id="apSave" class="primary" title="enregistre ap.json et se connecte immédiatement, sans redémarrer le serveur">Enregistrer et connecter</button>
      </div>
      <div class="muted" style="margin-top:6px">Rien n'est écrit sur le routeur : lecture seule des radios et des clients.</div>`;
    };
    const wizBar = `<div class="aprow" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:6px 0 10px">${wizardButton()}</div>`;
    if (!d.configured) { const k = keepDetails(p); p.innerHTML = `${disc}${form('Identifiants de l\'antenne')}${wizBar}${renderWizard()}${wizardExtras()}`; k.restore(); wireApForm(); wireApRows(); wireWizard(); return; }
    if (!d.ok) { const k = keepDetails(p); p.innerHTML = `${disc}${form(`Antenne ${esc(d.host)}`, `Erreur : ${d.error}`)}${wizBar}${renderWizard()}${wizardExtras()}`; k.restore(); wireApForm(); wireApRows(); wireWizard(); return; }
    const s = d.system || {};
    const tiles = `<div class="tiles">
      <div class="tile" title="modèle de carte MikroTik"><div class="k">Antenne</div><div class="v">${esc(s.board || '')}</div></div>
      <div class="tile" title="version RouterOS"><div class="k">RouterOS</div><div class="v">${esc((s.version || '').split(' ')[0])}</div></div>
      <div class="tile" title="temps depuis le dernier démarrage du routeur"><div class="k">Uptime</div><div class="v">${fmtDur(s.uptime)}</div></div>
      <div class="tile" title="charge CPU du routeur (soutenue > 80 % = routeur saturé)"><div class="k">CPU</div><div class="v">${s.cpuLoad ?? '?'} %</div></div>
      <div class="tile" title="mémoire libre / totale"><div class="k">RAM libre</div><div class="v">${fmtBytes(s.freeMemory)}<small class="muted"> / ${fmtBytes(s.totalMemory)}</small></div></div>
      <div class="tile" title="clients Wi‑Fi associés, toutes radios ; dont nodes WLED reconnus par leur MAC"><div class="k">Clients Wi‑Fi</div><div class="v">${d.clients.length}<small class="muted"> dont ${d.clients.filter(c => c.isNode).length} nodes</small></div></div>
    </div>`;
    const radios = `<h2>Radios</h2><table><thead><tr><th title="interface radio RouterOS">Radio</th><th>SSID</th><th title="fréquence / standard / largeur (ex. 2452/ax/Ce)">Canal</th><th title="largeur de canal configurée">Largeur</th><th title="puissance d'émission en dBm">TX dBm</th><th title="clients associés sur cette radio">Clients</th><th>État</th><th>MAC radio</th></tr></thead><tbody>${d.radios.map(r => `<tr><td><b>${esc(r.name)}</b>${r.master ? ` <span class="muted">(virtuel sur ${esc(r.master)})</span>` : ''}</td><td>${esc(r.ssid || '')}</td><td>${esc(r.band || '')}</td><td>${esc(r.width || '')}</td><td>${r.txPower ?? ''}</td><td>${r.clients ?? ''}</td><td class="${r.running ? 'st-ok' : 'st-bad'}">${esc(r.state)}</td><td class="muted">${esc(r.mac || '')}</td></tr>`).join('')}</tbody></table>`;
    const lvl = { bad: ['st-bad', '✗'], warn: ['st-warn', '▲'], info: ['st-info', 'ℹ'], ok: ['st-ok', '✓'] };
    const auditHtml = (d.audit && d.audit.some(a => a.level === 'bad' || a.level === 'warn')) ? `<details class="subbox" data-key="diag" style="margin:6px 0" ${d.audit.some(a => a.level === 'bad') ? 'open' : ''}><summary style="cursor:pointer"><b>Diagnostic</b> : ${d.audit.filter(a => a.level === 'bad').length ? `<span class="st-bad">${d.audit.filter(a => a.level === 'bad').length} ✗</span> · ` : ''}<span class="st-warn">${d.audit.filter(a => a.level === 'warn').length} ▲</span> · <span class="st-info">${d.audit.filter(a => a.level === 'info').length} ℹ</span> <span class="muted">— survoler un point pour le détail</span></summary>
      ${[...d.audit].sort((a, b) => ['bad', 'warn', 'info', 'ok'].indexOf(a.level) - ['bad', 'warn', 'info', 'ok'].indexOf(b.level)).map(a => `<div style="margin:3px 0" title="${esc(a.detail)}${a.fix ? '\n\n→ ' + esc(a.fix) : ''}"><b class="${lvl[a.level][0]}">${lvl[a.level][1]}</b> ${esc(a.title)} <span class="muted">ⓘ</span></div>`).join('')}</details>` : '';
    // RF environment: last scan (neighbouring networks + per-channel occupancy + recommendation)
    const sc = d.lastScan;
    const wizLive = wizData && wizData.running && wizData.state === 'connected' && wizData.snapshot && wizData.snapshot.networks && wizData.snapshot.networks.length ? wizData.snapshot : null;
    const src = wizLive || sc;
    const radio2g = d.radios.find(r => !r.disabled && /2ghz/.test(r.bandCfg || '')) || d.radios.find(r => !r.disabled);
    const actions = `<div class="aprow" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:6px 0 10px">
      <button id="scanBtn" class="primary" ${d.scanning ? 'disabled' : ''} title="la radio quitte son canal pendant la durée du scan : les clients décrochent puis se réassocient seuls (WLED : ~5 s). À ne jamais lancer pendant un show.">${d.scanning ? 'scan en cours…' : 'Scanner l\'environnement'}</button>
      <span style="width:8px"></span>${wizardButton()}
    </div>`;
    let envHtml = `<h2>Environnement radio <span class="muted" style="text-transform:none;letter-spacing:0">${wizLive ? `en direct par le Wizard · ${wizLive.networks.length} réseaux` : sc ? `scan antenne ${new Date(sc.at).toLocaleTimeString()} · ${sc.networks.length} réseaux` : 'pas encore scanné : « Scanner l\'environnement », ou 📡 WiFiman'}</span></h2>`;
    if (src) envHtml += renderRfEnv(src, { apply: true, freqCfg: radio2g ? radio2g.freqCfg : '' });
    const wizHtml = '';
    const nodeName = mac => { const n = fleet.nodes.find(x => x.info && x.info.mac && x.info.mac.toLowerCase() === mac); return n ? (n.info.name || n.meta.ip) : null; };
    const clients = `<h2>Clients Wi‑Fi <span class="muted" style="text-transform:none;letter-spacing:0">en gras = node de la flotte</span></h2><table><thead><tr><th>Appareil</th><th>MAC</th><th>Radio</th><th title="signal du client reçu par l'antenne ; survol = débits de modulation et trafic">Signal</th><th title="durée de l'association">Associé depuis</th></tr></thead><tbody>${[...d.clients].sort((a, b) => (b.isNode - a.isNode) || (b.signal - a.signal)).map(c => { const nm = nodeName(c.mac); return `<tr><td>${c.isNode ? `<b>${esc(nm || 'node WLED')}</b>` : '<span class="muted">autre appareil</span>'}</td><td class="muted">${esc(c.macFmt)}</td><td>${esc(c.iface || '')} <span class="muted">${esc(c.band || '')}</span></td><td title="modulation antenne → client ${c.txRate ?? '?'} Mbit/s, client → antenne ${c.rxRate ?? '?'} Mbit/s (au repos RouterOS retombe à 1-6 Mbit/s, normal) ; trafic réel ${c.txBps != null ? Math.round(c.txBps / 1000) : '?'} kbit/s ; paquets ${c.txPackets ?? '?'} / ${c.rxPackets ?? '?'}">${sigBar(c.signal)}${c.signal ?? ''} dBm</td><td>${fmtDur(c.uptime)}</td></tr>`; }).join('') || '<tr><td colspan="5" class="muted">aucun client associé</td></tr>'}</tbody></table>`;
    const keptAp = keepDetails(p);
    if (!apPresetData && !apPresetLoading) { apPresetLoading = true; api('/api/ap/preset?iface=' + encodeURIComponent(radio2g ? radio2g.name : 'wifi1')).then(r => { apPresetData = r; apPresetLoading = false; apLastKey = ''; renderAp(); }).catch(e => { apPresetData = { error: e.message, items: [] }; apPresetLoading = false; }); }
    const pr = apPresetData; const todo = pr ? pr.items.filter(i => i.ok !== true && !i.optional) : [];
    const presetHtml = `<a class="rowbtn" href="#tab=opt" style="margin-left:auto" title="préréglage show de l'antenne : ${!pr ? 'vérification…' : pr.error ? esc(pr.error) : todo.length ? todo.length + ' réglage(s) proposé(s)' : 'antenne réglée'} — tout se passe dans l'onglet Optimisation">★ Optimisation${!pr ? '' : pr.error ? ' <span class="st-bad">!</span>' : todo.length ? ` <span class="st-warn">${todo.length}</span>` : ' <span class="st-ok">✓</span>'}</a>`;
    const nNodes = d.clients.filter(c => c.isNode).length;
    const head = `<h2>Antenne ${esc(d.host)} <span class="muted" style="text-transform:none;letter-spacing:0">${esc(s.board || '')} · RouterOS ${esc((s.version || '').split(' ')[0])}${radio2g && radio2g.band ? ` · ${esc(radio2g.band)}` : ''} · ${d.clients.length} client${d.clients.length > 1 ? 's' : ''} Wi‑Fi dont ${nNodes} node${nNodes > 1 ? 's' : ''} · relevé ${new Date(d.updatedAt).toLocaleTimeString()}</span></h2>`;
    const more = `<details class="subbox" data-key="apradios"><summary style="cursor:pointer"><b>Radios et clients</b> <span class="muted">— ${d.radios.length} radio${d.radios.length > 1 ? 's' : ''}, ${d.clients.length} client${d.clients.length > 1 ? 's' : ''}</span></summary>${radios}${clients}</details>
      <details class="subbox" data-key="apsys"><summary style="cursor:pointer"><b>Routeur, antennes et identifiants</b></summary>${tiles}${disc}${form('Ajouter une antenne')}</details>`;
    p.innerHTML = `${head}${actions.replace(/<\/div>`?\s*$/, presetHtml + '</div>')}${auditHtml}${envHtml}${wizHtml}${wizardExtras()}${more}`;
    keptAp.restore();
    wireApForm(); wireApRows(); wireWizard();
    p.querySelectorAll('button[data-chan]').forEach(b => b.onclick = async () => {
      const spec = b.dataset.spec, iface = radio2g ? radio2g.name : 'wifi1';
      const what = b.dataset.chan === 'fixed' ? `fixer ${iface} sur ${spec} MHz (canal ${Math.round((Number(spec) - 2407) / 5)})` : `laisser ${iface} choisir parmi 2412 / 2437 / 2462 MHz (canaux 1 / 6 / 11)`;
      if (!await confirmBox(`Écrire sur l'antenne : ${what} ?\n\nLa radio redémarre sur le nouveau canal, tous les clients Wi‑Fi décrochent et se réassocient seuls (~5-10 s). Ne pas faire pendant un show.`)) return;
      b.disabled = true; b.textContent = 'application…';
      try { const r = await post('/api/ap/channel', { iface, spec }); toast(`${r.iface} : channel.frequency ${r.before} → ${r.after}`); }
      catch (e) { toast(e.message, true); }
      setTimeout(() => { apLastKey = ''; pollAp(); }, 7000);
    });
    // show preset (antenna side): data fetched once, rendered like the rest, applied on demand
    const ppGo = $('#apPresetGo'); if (ppGo) ppGo.onclick = async () => {
      const r = apPresetData; const pp = $('#apPreset');
      const keys = [...pp.querySelectorAll('input[data-preset]:checked:not(:disabled)')].map(x => x.dataset.preset);
      if (!keys.length) return toast('rien de coché');
      if (!await confirmBox(`Écrire ${keys.length} réglage(s) sur l'antenne ${r.iface} ?\n\n${keys.map(k => '• ' + k + ' → ' + r.items.find(i => i.key === k).want).join('\n')}\n\nLa radio redémarre, les nodes se réassocient (~10 s). Ne pas faire pendant un show.`)) return;
      ppGo.disabled = true; ppGo.textContent = 'application…';
      try { const res = await post('/api/ap/preset', { iface: r.iface, keys }); toast(`antenne : ${Object.keys(res.after).length} réglage(s) écrit(s)`); }
      catch (e) { toast(e.message, true); }
      apPresetData = null; setTimeout(() => { apLastKey = ''; pollAp(); }, 9000);
    };
    const sb = $('#scanBtn'); if (sb) sb.onclick = async () => {
      const dur = 5;
      if (!await confirmBox(`Scanner l'environnement radio pendant ${dur} s ?\n\nLa radio ${radio2g ? radio2g.name : 'wifi1'} quitte son canal pendant le scan : les nodes Wi‑Fi décrochent et se réassocient seuls (~5 s). Ne pas faire pendant un show.`)) return;
      sb.disabled = true; sb.textContent = 'scan en cours…';
      try { await post('/api/ap/scan', { iface: radio2g ? radio2g.name : 'wifi1', duration: dur }); toast('scan terminé'); }
      catch (e) { toast(e.message, true); }
      apLastKey = ''; pollAp();
    };
  }
  // ── RF environment renderer, shared by the antenna scan and the WiFiman Wizard ──
  // sc = { ours, occupancy, candidates, recommended, networks, iface?, source? } (ap.scan() / wizard snapshot shape)
  // o.apply = show the "apply channel" buttons (antenna only) ; o.freqCfg = the radio's configured range
  function renderRfEnv(sc, o = {}) {
    const wiz = sc.source === 'wizard';
    const recScore = (sc.candidates.find(c => c.channel === sc.recommended) || {}).score;
    const ourScore = (sc.occupancy.find(x => x.channel === sc.ours) || {}).score;
    const candTxt = sc.candidates.map(c => `${c.channel} → ${c.score.toFixed(2)} (${c.networks} réseau${c.networks > 1 ? 'x' : ''}${c.strongest != null ? `, ${c.strongest} dBm` : ''})`).join(' · ');
    const verdict = !sc.ours ? `<span class="st-info">canal le moins chargé : <b>${sc.recommended}</b></span>`
      : sc.recommended === sc.ours ? `<span class="st-ok">✓ ton canal <b>${sc.ours}</b> est le moins chargé</span>`
      : `<span class="st-warn">▲ canal recommandé <b>${sc.recommended}</b> (occupation ${(recScore ?? 0).toFixed(2)}) contre <b>${sc.ours}</b> actuel (${(ourScore ?? 0).toFixed(2)})</span>`;
    const apply = o.apply && sc.recommended && sc.ours && sc.recommended !== sc.ours ? `<button class="rowbtn primary" data-chan="fixed" data-spec="${2407 + 5 * sc.recommended}" title="écrit channel.frequency = ${2407 + 5 * sc.recommended} sur l'antenne : la radio redémarre sur ce canal, les nodes se réassocient en 5-10 s. Sur confirmation.">Passer au canal ${sc.recommended}</button>` : '';
    const showLine = sc.show ? (sc.show.seen ? `<span class="${sc.show.signal >= -60 ? 'st-ok' : sc.show.signal >= -72 ? 'st-warn' : 'st-bad'}" title="signal de l'antenne du show là où le Wizard est posé : même antenne 3 dBi qu'un ESP32, donc à peu près ce qu'un node aurait à cet endroit. ≥ −60 confortable, −60…−72 à surveiller sous charge, < −75 décrochages probables">antenne reçue ici à <b>${sc.show.signal} dBm</b></span>` : `<span class="st-warn" title="depuis une minute le Wizard n'entend pas le réseau du show en 2,4 GHz">▲ antenne non entendue ici</span>`) : '';
    const info = `<span class="muted" style="cursor:help" title="${esc((wiz ? 'Mesuré là où se trouve le Wizard, sur la dernière minute.' : 'Scan de l\'antenne : sa radio coupe 5 s, les nodes se réassocient seuls.') + '\n\nOccupation d\'un canal = réseaux dessus et sur les canaux voisins, pondérés par leur puissance ; vert = libre, rouge = chargé. Cadre bleu = ton canal, cadre vert = recommandé. Le 13 n\'est jamais recommandé (invisible pour beaucoup d\'ESP32).\n\nCandidats non chevauchants : ' + candTxt + '\n\nDans le graphe : chaque réseau à sa fréquence, large comme son canal, haut comme son signal ; le réseau du show en vert ; survoler une forme pour le détail. Wi-Fi uniquement : le bruit non Wi-Fi n\'est pas visible.')}">ⓘ</span>`;
    const netsTable = `<table style="margin-top:6px"><thead><tr><th>Réseau</th><th>Canal</th><th title="${wiz ? 'signal reçu par le Wizard' : 'signal reçu par l\'antenne'}">Signal</th><th>Largeur</th><th>Standard</th><th>${wiz ? 'Vu il y a' : 'Clients'}</th></tr></thead><tbody>${sc.networks.map(n => `<tr>
          <td>${n.isShow ? '<span class="tag stable" title="le réseau du show">antenne</span> ' : ''}${n.ssid ? esc(n.ssid) : '<span class="muted">(caché)</span>'} <span class="muted" style="font-size:10px">${esc(n.bssid)}</span></td><td>${n.channel}</td>
          <td>${sigBar(n.signal)}${n.signal ?? ''} dBm</td><td>${n.width} MHz${n.width === 40 && n.freq < 3000 ? ' <span class="st-warn" title="un réseau 40 MHz en 2,4 GHz occupe deux tiers de la bande">▲</span>' : ''}</td><td class="muted">${esc(n.std || '')}</td><td class="muted num">${wiz ? (n.ago != null ? n.ago + ' s' : '') : (n.stations ?? '')}</td></tr>`).join('')}</tbody></table>`;
    return `<div class="subbox rfenv"><div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center">${verdict}${apply}${showLine}${info}</div>
      ${renderFreqView(sc)}
      <details data-key="rfnets" style="margin-top:4px"><summary style="cursor:pointer"><b>Réseaux voisins</b> <span class="muted">— ${sc.networks.length}</span></summary>${netsTable}</details></div>`;
  }
  // ── Frequency view: every network drawn at its frequency, as wide as its channel, as tall as its RSSI ──
  // one chart per band present (2.4 GHz, 5 GHz); shared by the antenna scan and the Wizard snapshot
  const hueOf = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
  function renderFreqView(sc) {
    const bands = [
      { key: '2g', title: '2,4 GHz', lo: 2400, hi: 2495, H: 150, labels: 10, ticks: [...Array(13)].map((_, i) => [2412 + 5 * i, '']).concat([[2484, '14']]) },
      { key: '5g', title: '5 GHz', lo: 5150, hi: 5875, H: 130, labels: 8, ticks: [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161, 165, 169, 173, 177].map(c => [5000 + 5 * c, [36, 44, 52, 60, 100, 108, 116, 124, 132, 140, 149, 157, 165, 173].includes(c) ? String(c) : '']) },
    ];
    const W = 1000, L = 40, R = 8, B = 20;
    const max = Math.max(0.01, ...(sc.occupancy || []).map(x => x.score));
    const heat = x => { const t = Math.min(1, x.score / max); return `hsl(${Math.round(120 - 120 * t)} 60% 45% / ${(0.2 + 0.6 * t).toFixed(2)})`; };
    let out = '';
    for (const b of bands) {
      const nets = (sc.networks || []).filter(n => n.freq >= b.lo && n.freq <= b.hi && n.signal != null);
      if (!nets.length && b.key === '5g') continue;
      const H = b.H, T = b.key === '2g' ? 40 : 18;
      const yOf = dbm => T + (H - T - B) * (Math.min(-30, Math.max(-100, dbm)) + 30) / -70;   // -30 dBm at the top, -100 at the bottom
      const xOf = f => L + (W - L - R) * (f - b.lo) / (b.hi - b.lo);
      const grid = [-40, -60, -80].map(d => `<line x1="${L}" x2="${W - R}" y1="${yOf(d).toFixed(1)}" y2="${yOf(d).toFixed(1)}" stroke="var(--line)" stroke-dasharray="2 4"/><text x="${L - 4}" y="${(yOf(d) + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--muted)">−${-d}</text>`).join('');
      const ticks = b.ticks.map(([f, lab]) => `<line x1="${xOf(f).toFixed(1)}" x2="${xOf(f).toFixed(1)}" y1="${H - B}" y2="${H - B + 4}" stroke="var(--line2)"/>${lab ? `<text x="${xOf(f).toFixed(1)}" y="${H - B + 14}" text-anchor="middle" font-size="10" fill="var(--muted)">${lab}</text>` : ''}`).join('');
      // 2.4 GHz: the channel occupancy strip sits on top of the chart, on the same frequency axis
      const strip = b.key === '2g' ? (sc.occupancy || []).map(x => { const f = x.freq || 2407 + 5 * x.channel; const x0 = xOf(f - 2.5), x1 = xOf(f + 2.5); const ours = x.channel === sc.ours, rec = x.channel === sc.recommended;
        return `<g><title>canal ${x.channel} : ${x.networks} réseau(x), occupation ${x.score.toFixed(2)}${x.strongest != null ? `, plus fort ${x.strongest} dBm` : ''}${ours ? ' — ton canal' : rec ? ' — recommandé' : ''}</title><rect x="${x0.toFixed(1)}" y="2" width="${(x1 - x0).toFixed(1)}" height="18" rx="3" fill="${heat(x)}" stroke="${ours ? 'var(--info)' : rec ? 'var(--accent)' : 'none'}" stroke-width="2"/><text x="${((x0 + x1) / 2).toFixed(1)}" y="15" text-anchor="middle" font-size="11" font-weight="${ours || rec ? '700' : '500'}" fill="${ours ? 'var(--info)' : rec ? 'var(--accent)' : 'var(--txt)'}">${x.channel}</text></g>`; }).join('') : '';
      const fOurs = b.key === '2g' && sc.ours ? 2407 + 5 * sc.ours : null, fRec = b.key === '2g' && sc.recommended && sc.recommended !== sc.ours ? 2407 + 5 * sc.recommended : null;
      const ours = fOurs ? `<rect x="${xOf(fOurs - 10).toFixed(1)}" y="${T}" width="${(xOf(fOurs + 10) - xOf(fOurs - 10)).toFixed(1)}" height="${H - T - B}" fill="var(--info)" fill-opacity=".08"/>` : '';
      const rec = fRec ? `<line x1="${xOf(fRec).toFixed(1)}" x2="${xOf(fRec).toFixed(1)}" y1="${T}" y2="${H - B}" stroke="var(--accent)" stroke-dasharray="4 3"/>` : '';
      const sorted = [...nets].sort((a, c) => a.signal - c.signal);   // weak first, the strong ones are drawn on top
      const labelled = new Set([...nets].sort((a, c) => c.signal - a.signal).slice(0, b.labels).map(n => n.bssid + n.freq));
      const placed = [];
      const shapes = sorted.map(n => {
        const centre = n.center || n.freq, w = n.width || 20;
        const x0 = xOf(centre - w / 2), x1 = xOf(centre + w / 2), y = yOf(n.signal), yb = H - B, ins = Math.min(12, (x1 - x0) * 0.18);
        const col = n.isShow ? 'var(--accent)' : `hsl(${hueOf(n.bssid)} 65% 55%)`;
        const d = `M${x0.toFixed(1)},${yb} L${(x0 + ins).toFixed(1)},${y.toFixed(1)} L${(x1 - ins).toFixed(1)},${y.toFixed(1)} L${x1.toFixed(1)},${yb} Z`;
        const title = `${n.ssid || '(caché)'} · ${n.bssid} · canal ${n.channel} (${n.freq} MHz, ${w} MHz) · ${n.signal} dBm${n.std ? ' · ' + n.std : ''}${n.security ? ' · ' + n.security : ''}${n.utilization != null ? ` · charge d'air ${Math.round(n.utilization * 100)} %` : ''}${n.stations != null ? ` · ${n.stations} station(s)` : ''}`;
        let lab = '';
        if (labelled.has(n.bssid + n.freq)) {
          const text = (n.ssid || '(caché)').slice(0, 20), lx = (x0 + x1) / 2, lw = text.length * 5.4;
          let ly = y - 3;
          for (let guard = 0; guard < 6; guard++) { const hit = placed.find(p => Math.abs(p.x - lx) < (p.w + lw) / 2 && Math.abs(p.y - ly) < 10); if (!hit) break; ly = hit.y - 10; }
          placed.push({ x: lx, y: ly, w: lw });
          lab = `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-size="9.5" fill="${col}" style="paint-order:stroke;stroke:var(--panel);stroke-width:3px;stroke-linejoin:round">${esc(text)}</text>`;
        }
        return `<g><title>${esc(title)}</title><path d="${d}" fill="${col}" fill-opacity="${n.isShow ? .3 : .16}" stroke="${col}" stroke-width="${n.isShow ? 2 : 1.2}"/>${lab}</g>`;
      }).join('');
      const svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;max-height:${H + 20}px" font-family="inherit">${strip}${grid}${ours}${rec}<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" stroke="var(--line2)"/>${ticks}${shapes}</svg>`;
      if (b.key === '2g') out += `<div style="margin-top:6px">${svg}</div>`;
      else out += `<details data-key="rf5g"><summary style="cursor:pointer"><b>5 GHz</b> <span class="muted">— ${nets.length} réseau${nets.length > 1 ? 'x' : ''}, sans effet sur les nodes (2,4 GHz)</span></summary>${svg}</details>`;
    }
    return out;
  }

  // ── WiFiman Wizard: mobile RF probe (BLE, through tools/wizard/wizard_bridge.py) ──
  let wizData = null, wizDevices = null, wizBusy = false;
  const sparkDbm = (series, w = 180, h = 30) => {
    if (!series || series.length < 2) return '';
    const vals = series.map(x => x[1]); const lo = Math.min(-90, ...vals), hi = Math.max(-30, ...vals);
    const last = vals[vals.length - 1]; const col = last >= -60 ? 'var(--accent)' : last >= -72 ? 'var(--warn)' : 'var(--bad)';
    const pts = series.map((x, i) => `${((i / (series.length - 1)) * w).toFixed(1)},${(h - 1 - ((x[1] - lo) / (hi - lo)) * (h - 2)).toFixed(1)}`).join(' ');
    return `<svg width="${w}" height="${h}" style="vertical-align:middle;margin-left:8px" title="${series.length} échantillons, de ${vals.reduce((a, b) => Math.min(a, b))} à ${vals.reduce((a, b) => Math.max(a, b))} dBm"><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.5"/></svg>`;
  };
  // the WiFiman button: one click = enable, find the Wizard, connect ; one click again = stop. The label is the status.
  function wizardButton() {
    const w = wizData; if (!w) return '';
    const h = w.hint || { level: 'muted', text: '' };
    const on = w.running || w.enabled;
    const cls = { ok: 'st-ok', bad: 'st-bad', warn: 'st-warn', info: 'st-info', muted: 'muted' }[h.level] || 'muted';
    const dev = w.device || {};
    const label = w.state === 'connected' ? `📡 WiFiman ● ${esc(dev.name || 'connecté')}${w.heard ? ` · ${w.heard} réseaux` : ''}` : w.running ? '📡 WiFiman · recherche…' : '📡 WiFiman';
    const title = on ? 'sonde WiFiman Wizard active — clic = arrêter (le Wizard redevient libre pour le téléphone)' : 'WiFiman Wizard : sonde RF mobile reliée en Bluetooth, montre ce qu\'un node entendrait là où le boîtier se trouve. Clic = chercher le Wizard et se connecter (allumer le boîtier, couper le Bluetooth du téléphone)';
    let html = `<button id="wzBtn" class="${on ? 'primary' : ''}" ${wizBusy ? 'disabled' : ''} title="${esc(title)}">${wizBusy ? '📡 WiFiman · …' : label}</button>`;
    if (on && w.state !== 'connected' && h.text) html += `<span class="${cls}" style="font-size:12px">${esc(h.text)}</span>`;
    if (w.deps && !w.deps.ok && (on || w.deps.installing)) html += `<button id="wzInstall" ${w.deps.installing ? 'disabled' : ''} title="installe Python 3 (winget) si besoin et le module Python bleak (pip --user), rien d'autre">${w.deps.installing ? 'installation…' : 'Installer les prérequis'}</button>`;
    return html;
  }
  // the Wizard panel: only while the bridge runs, and only what matters (what it hears here)
  function renderWizard() {
    const w = wizData; if (!w || !w.running) return '';
    const s = w.snapshot || { networks: [] }; const dev = w.device || {};
    const labelVal = ($('#wzLabel') || {}).value || '';
    const nodesSel = `<select id="wzNear" title="le node à côté duquel le Wizard est posé : ses relevés sont étiquetés, et son RSSI est comparé à ce que le Wizard entend au même endroit"><option value="">(pas près d'un node)</option>${fleet.nodes.filter(n => n.info && n.info.mac).map(n => `<option value="${esc(n.info.mac)}" ${w.nearNode && n.info.mac.toLowerCase() === w.nearNode ? 'selected' : ''}>${esc(n.info.name || n.meta.ip)}</option>`).join('')}</select>`;
    let html = `<h2>WiFiman Wizard <span class="muted" style="text-transform:none;letter-spacing:0">${w.state === 'connected' ? `ce qu'il entend là où il est posé · ${w.heard} réseaux sur la dernière minute${dev.battery != null ? ` · batterie ${dev.battery} %` : ''}` : esc((w.hint || {}).text || '')}</span></h2>`;
    if (s.show) html += `<div class="subbox"><b>${s.show.seen ? `Antenne « ${esc(s.show.ssid || s.show.bssid)} » reçue ici à <span class="${s.show.signal >= -60 ? 'st-ok' : s.show.signal >= -72 ? 'st-warn' : 'st-bad'}">${s.show.signal} dBm</span>` : `<span class="st-warn">▲ l'antenne « ${esc(s.show.ssid || s.show.bssid || '')} » n'est pas entendue ici</span>`}</b>${sparkDbm(s.show.series)}<span class="muted" title="même antenne 3 dBi qu'un ESP32 : c'est à peu près le RSSI qu'un node aurait à cet endroit. ≥ −60 confortable, −60…−72 à surveiller sous charge, < −75 décrochages probables"> ⓘ</span></div>`;
    html += s.networks.length ? renderRfEnv(s, { apply: false }) : `<div class="muted subbox">${w.state === 'connected' ? 'en attente des premiers réseaux…' : 'pas encore connecté'}</div>`;
    if (s.networks.length) {
      html += `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0">
        <input type="text" id="wzLabel" style="width:220px" placeholder="libellé du relevé (régie, plateau jardin…)" value="${esc(labelVal)}" title="où se trouve le Wizard en ce moment">
        <button id="wzSurveyGo" class="primary" title="enregistre ce que le Wizard entend depuis une minute (réseaux, occupation, canal recommandé) pour comparer les endroits">Enregistrer le relevé</button>
        <span class="muted">posé près de</span> ${nodesSel}</div>`;
      html += `<details class="subbox" data-key="wzwater"><summary style="cursor:pointer"><b>Cascade temps × canal</b> <span class="muted">— une ligne toutes les 5 s ; un voisin qui s'allume pendant le show apparaît comme une bande qui démarre</span></summary><div id="wzWater" class="muted" style="font-size:11px">chargement…</div></details>`;
    }
    if (w.compare && w.compare.length) html += `<details class="subbox" data-key="wzcmp"><summary style="cursor:pointer"><b>Antenne vs Wizard</b> <span class="muted">— ${w.compare.length} réseau(x) vus des deux côtés : écart = signal ici − signal à l'antenne</span></summary>
      <table style="margin-top:6px"><thead><tr><th>Réseau</th><th>Canal</th><th>À l'antenne</th><th>Ici (Wizard)</th><th>Écart</th></tr></thead><tbody>${w.compare.map(c => `<tr><td>${c.ssid ? esc(c.ssid) : '<span class="muted">(caché)</span>'} <span class="muted">${esc(c.bssid)}</span></td><td>${c.channel}</td><td>${c.antenna} dBm</td><td>${c.wizard} dBm</td><td class="${c.delta >= 6 ? 'st-ok' : c.delta <= -6 ? 'st-warn' : ''}">${c.delta > 0 ? '+' : ''}${c.delta} dB</td></tr>`).join('')}</tbody></table></details>`;
    return html;
  }
  // folded: past surveys, and the options nobody needs every day (another Wizard, simulation, Python)
  function wizardExtras() {
    const w = wizData; if (!w) return '';
    const dev = w.device || {}; const dp = w.deps || {};
    let html = '';
    const depLine = dp.ok ? `Python ${esc(dp.pythonVersion || '')} · bleak ${esc(dp.bleak || '')}` : `<span class="st-warn">${esc(dp.pythonError || dp.bleakError || 'prérequis non vérifiés')}</span>`;
    html += `<details class="subbox" data-key="wzadv"><summary style="cursor:pointer"><b>Options WiFiman Wizard</b> <span class="muted">— appareil enregistré${w.config && w.config.name ? ` ${esc(w.config.name)}` : ''}, autre boîtier, simulation, Python</span></summary>
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:6px">
        <span class="muted">Appareil : ${w.config && w.config.address ? `${esc(w.config.name || '')} <span class="muted">${esc(w.config.address)}</span>${dev.firmware ? ` · fw ${esc(dev.firmware)}` : ''}` : 'aucun enregistré (le bouton WiFiman le cherche tout seul)'}</span>
        <button id="wzSearch" ${wizBusy ? 'disabled' : ''} title="liste les appareils Bluetooth LE autour de ce PC (~6 s) pour choisir un autre Wizard">${wizBusy ? 'recherche…' : 'Chercher un autre Wizard'}</button>
        <button id="wzMock" ${w.running ? 'disabled' : ''} title="lance le bridge en simulation : réseaux fictifs, sans matériel ni Bluetooth">Simulation</button>
        <span class="muted" style="font-size:11px">${depLine}</span>
        ${!dp.ok ? `<button id="wzInstall2" ${dp.installing ? 'disabled' : ''}>${dp.installing ? 'installation…' : 'Installer les prérequis'}</button>` : ''}
      </div>
      ${dp.installLog ? `<div class="log" style="margin-top:6px">${esc(dp.installLog)}</div>` : ''}
      ${!dp.python ? `<div style="display:flex;gap:8px;align-items:center;margin-top:6px"><input type="text" id="wzPython" style="width:260px" placeholder="chemin de python.exe (ou « py -3 »)" value="${esc((w.config || {}).python || '')}"><button id="wzPythonGo">Enregistrer</button></div>` : ''}
      ${w.stderr && w.stderr.length && w.state !== 'connected' ? `<div class="log" style="margin-top:6px">${esc(w.stderr.join('\n'))}</div>` : ''}
      ${wizDevices ? (wizDevices.length ? `<table style="margin-top:8px"><thead><tr><th>Appareil BLE</th><th>Adresse</th><th>Signal</th><th></th></tr></thead><tbody>${wizDevices.map(x => `<tr><td>${x.likely ? '★ ' : ''}${esc(x.name || '(sans nom)')}</td><td class="muted">${esc(x.address)}</td><td>${sigBar(x.rssi)}${x.rssi ?? '?'} dBm</td><td><button class="rowbtn" data-wzconnect="${esc(x.address)}" data-wzname="${esc(x.name || '')}">Utiliser</button></td></tr>`).join('')}</tbody></table><div class="muted" style="font-size:11px">★ = ressemble à un Wizard (adresse Ubiquiti ou service BLE du Wizard)</div>` : '<div class="muted" style="margin-top:6px">aucun appareil Bluetooth vu</div>') : ''}
      <div class="muted" style="font-size:11px;margin-top:6px">Le Wizard n'accepte qu'une connexion Bluetooth à la fois : couper le Bluetooth du téléphone. Après une déconnexion il reste invisible environ une minute ; un appui sur son bouton le réveille.</div>
    </details>`;
    return html;
  }
  // ── Waterfall: time (rows, 5 s each, newest at the bottom) × frequency (5 MHz bins), painted client-side ──
  let waterCache = { at: 0, data: null };
  const waterColor = v => {   // -100 dBm blue-ish and faint … -30 dBm red and solid ; null = transparent
    if (v == null) return [0, 0, 0, 0];
    const t = Math.max(0, Math.min(1, (v + 100) / 70));
    const stops = [[0, [58, 166, 255]], [0.35, [63, 185, 80]], [0.65, [210, 153, 34]], [1, [248, 81, 73]]];
    let i = 1; while (i < stops.length - 1 && stops[i][0] < t) i++;
    const [t0, c0] = stops[i - 1], [t1, c1] = stops[i]; const k = (t - t0) / (t1 - t0);
    return [Math.round(c0[0] + (c1[0] - c0[0]) * k), Math.round(c0[1] + (c1[1] - c0[1]) * k), Math.round(c0[2] + (c1[2] - c0[2]) * k), Math.round(70 + 185 * t)];
  };
  async function drawWaterfall() {
    if (!$('#wzWater')) return;
    try { if (Date.now() - waterCache.at > 4000) waterCache = { at: Date.now(), data: await api('/api/wizard/waterfall?n=360') }; } catch (e) { const b = $('#wzWater'); if (b) b.textContent = e.message; return; }
    const box = $('#wzWater'); const d = waterCache.data;
    if (!box) return;
    if (!d || !d.rows.length) { box.textContent = 'pas encore de données : une ligne toutes les 5 s dès que le Wizard entend des réseaux'; return; }
    const s = (wizData && wizData.snapshot) || {};
    const bands = [['g2', '2,4 GHz', [...Array(13)].map((_, i) => [2412 + 5 * i, i + 1])], ['g5', '5 GHz', [36, 44, 52, 60, 100, 108, 116, 124, 132, 140, 149, 157, 165, 173].map(c => [5000 + 5 * c, c])]];
    let html = '';
    for (const [key, title, ticks] of bands) {
      const [lo, hi] = d.bands[key]; const nb = (hi - lo) / 5; const rows = d.rows;
      if (!rows.some(r => /[0-9a-f]/.test(r[key]))) continue;
      const c = document.createElement('canvas'); c.width = nb; c.height = rows.length;
      const ctx = c.getContext('2d'); const img = ctx.createImageData(nb, rows.length);
      rows.forEach((r, y) => { for (let x = 0; x < nb; x++) { const h = r[key].substr(x * 2, 2); const [R, G, B, A] = waterColor(h === '..' ? null : parseInt(h, 16) - 128); const o = (y * nb + x) * 4; img.data[o] = R; img.data[o + 1] = G; img.data[o + 2] = B; img.data[o + 3] = A; } });
      ctx.putImageData(img, 0, 0);
      const span = (rows[rows.length - 1].t - rows[0].t) / 60000;
      const xPct = f => (100 * (f - lo) / (hi - lo)).toFixed(2) + '%';
      const ourF = key === 'g2' && s.ours ? 2407 + 5 * s.ours : null, recF = key === 'g2' && s.recommended && s.recommended !== s.ours ? 2407 + 5 * s.recommended : null;
      html += `<div style="margin-top:4px"><b>${title}</b> · ${rows.length} ligne${rows.length > 1 ? 's' : ''}, ${span < 1 ? 'moins d\'une minute' : Math.round(span) + ' min'}</div>
        <div style="position:relative;height:150px;background:var(--panel2);border:1px solid var(--line);border-radius:4px;overflow:hidden">
          <img src="${c.toDataURL()}" style="position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated" alt="">
          ${ourF ? `<div style="position:absolute;top:0;bottom:0;left:${xPct(ourF)};border-left:1px solid var(--info);opacity:.8" title="ton canal ${s.ours}"></div>` : ''}
          ${recF ? `<div style="position:absolute;top:0;bottom:0;left:${xPct(recF)};border-left:1px dashed var(--accent);opacity:.9" title="recommandé ${s.recommended}"></div>` : ''}
          <div style="position:absolute;right:4px;top:2px;font-size:10px;color:var(--muted)">↑ il y a ${span < 1 ? '< 1' : Math.round(span)} min</div><div style="position:absolute;right:4px;bottom:2px;font-size:10px;color:var(--muted)">maintenant ↓</div>
        </div>
        <div style="position:relative;height:14px;font-size:10px;color:var(--muted)">${ticks.map(([f, lab]) => `<span style="position:absolute;left:${xPct(f)};transform:translateX(-50%)">${lab}</span>`).join('')}</div>`;
    }
    html += `<div style="margin-top:4px">échelle : <span style="color:#3aa6ff">■</span> −100 dBm · <span style="color:#3fb950">■</span> −75 · <span style="color:#d29922">■</span> −55 · <span style="color:#f85149">■</span> −30 · vide = rien entendu · <span style="color:var(--info)">│</span> ton canal · <span style="color:var(--accent)">┆</span> recommandé</div>`;
    box.innerHTML = html;
  }
  function wireWizard() {
    const p = $('#appanel');
    const again = () => { apLastKey = ''; pollAp(); };
    drawWaterfall();
    const tg = $('#wzBtn'); if (tg) tg.onclick = async () => { wizBusy = true; tg.disabled = true; tg.textContent = '📡 WiFiman · …'; try { const r = await post('/api/wizard/toggle', {}); if (r.running) toast(r.hint && r.hint.text ? `WiFiman : ${r.hint.text}` : 'WiFiman : recherche du Wizard…'); else toast('WiFiman arrêté'); } catch (e) { toast(e.message, true); } wizBusy = false; again(); };
    for (const id of ['#wzInstall', '#wzInstall2']) { const ib = $(id); if (ib) ib.onclick = async () => { ib.disabled = true; ib.textContent = 'installation…'; toast('installation des prérequis (Python / bleak) : une à deux minutes…'); try { const r = await post('/api/wizard/install', {}); toast(`prérequis prêts : Python ${r.pythonVersion} + bleak ${r.bleak}`); } catch (e) { toast(e.message, true); } again(); }; }
    const b = $('#wzSearch'); if (b) b.onclick = async () => { wizBusy = true; b.disabled = true; b.textContent = 'recherche…'; try { wizDevices = (await api('/api/wizard/devices')).devices; if (!wizDevices.length) toast('aucun appareil BLE vu', true); } catch (e) { toast(e.message, true); wizDevices = null; } wizBusy = false; again(); };
    p.querySelectorAll('button[data-wzconnect]').forEach(x => x.onclick = async () => { x.disabled = true; x.textContent = 'connexion…'; try { await post('/api/wizard/config', { enabled: true, autoconnect: true }); await post('/api/wizard/connect', { address: x.dataset.wzconnect }); if (x.dataset.wzname) await post('/api/wizard/config', { address: x.dataset.wzconnect }); wizDevices = null; } catch (e) { toast(e.message, true); } again(); });
    const mk = $('#wzMock'); if (mk) mk.onclick = async () => { mk.disabled = true; try { await post('/api/wizard/connect', { mock: true }); toast('bridge en simulation'); } catch (e) { toast(e.message, true); } again(); };
    const dc = $('#wzDisc'); if (dc) dc.onclick = async () => { dc.disabled = true; try { await post('/api/wizard/disconnect'); } catch (e) { toast(e.message, true); } setTimeout(again, 800); };
    const au = $('#wzAuto'); if (au) au.onchange = async () => { try { await post('/api/wizard/config', { autoconnect: au.checked }); } catch (e) { toast(e.message, true); } };
    const en = $('#wzEnable'); if (en) en.onchange = async () => { try { await post('/api/wizard/config', { enabled: en.checked }); } catch (e) { toast(e.message, true); } setTimeout(again, en.checked ? 0 : 600); };
    const nr = $('#wzNear'); if (nr) nr.onchange = async () => { try { await post('/api/wizard/near', { mac: nr.value }); } catch (e) { toast(e.message, true); } };
    const pg = $('#wzPythonGo'); if (pg) pg.onclick = async () => { try { const r = await post('/api/wizard/config', { python: $('#wzPython').value }); toast(r.python ? `Python ${r.pythonVersion} trouvé` : r.pythonError, !r.python); } catch (e) { toast(e.message, true); } again(); };
    const sg = $('#wzSurveyGo'); if (sg) sg.onclick = async () => { sg.disabled = true; try { const r = await post('/api/wizard/survey', { label: $('#wzLabel').value }); toast(`relevé « ${r.label} » enregistré : canal recommandé ${r.recommended}`); $('#wzLabel').value = ''; } catch (e) { toast(e.message, true); } again(); };
    const lb = $('#wzLabel'); if (lb) lb.onkeydown = e => { if (e.key === 'Enter' && sg) sg.click(); };
    p.querySelectorAll('button[data-wzdel]').forEach(x => x.onclick = async () => { if (!await confirmBox('Supprimer ce relevé ?')) return; try { await api('/api/wizard/survey', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ at: Number(x.dataset.wzdel) }) }); } catch (e) { toast(e.message, true); } again(); });
  }
  function wireApRows() {
    $('#appanel').querySelectorAll('button[data-apact]').forEach(b => b.onclick = async () => {
      const host = b.dataset.host, act = b.dataset.apact;
      try {
        if (act === 'fill') { const h = $('#apHost'); if (h) { h.value = host; $('#apPass').focus(); } return; }
        if (act === 'forget') { if (!await confirmBox(`Oublier les identifiants enregistrés pour ${host} ?`)) return; await api('/api/ap/forget', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host }) }); toast(`${host} oubliée`); }
        if (act === 'connect') { b.disabled = true; b.textContent = 'connexion…'; const r = await api('/api/ap/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host }) }); toast(`antenne ${r.host} connectée`); }
        apLastKey = ''; pollAp();
      } catch (e) { toast(e.message, true); apLastKey = ''; pollAp(); }
    });
  }
  let apFormBusy = false;
  function wireApForm() {
    const btn = $('#apSave'); if (!btn) return;
    const submit = async () => {
      if (apFormBusy) return; apFormBusy = true;
      btn.disabled = true; btn.textContent = 'connexion…';
      try {
        const r = await api('/api/ap/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: $('#apHost').value, user: $('#apUser').value, pass: $('#apPass').value }) });
        toast(`antenne ${r.host} connectée`);
      } catch (e) { toast(e.message, true); }
      apFormBusy = false; pollAp();
    };
    btn.onclick = submit;
    $('#apPass').onkeydown = e => { if (e.key === 'Enter') submit(); };
  }
  // do not repaint the form under the user's fingers: only re-render when the state changed or data is live
  let apLastKey = '';
  const _renderAp = renderAp;
  renderAp = function () {
    const d = apData; const k = d ? `${d.configured}|${d.ok}|${d.error}|${(d.saved || []).map(s => s.host + s.active).join(',')}|${d.discovered.length}|${d.lastScan ? d.lastScan.at : 0}|${d.scanning}|${wizData ? `${wizData.state}|${wizData.events}|${wizData.error}|${(wizData.surveys || []).length}|${wizDevices ? wizDevices.length : -1}|${wizBusy}` : ''}` : '';
    // never repaint while the user is typing in the form
    const typing = document.activeElement && ['apHost', 'apUser', 'apPass', 'wzLabel', 'wzPython'].includes(document.activeElement.id);
    if (!d || typing || (!d.ok && k === apLastKey && $('#apSave'))) return;
    apLastKey = k; _renderAp();
  };

  // ── firmware repository / updates ──────────────────────────────────────────
  let fwOpen = false, fwData = null; const fwSel = new Set();
  const fmtSize = b => b == null ? '' : (b / 1048576).toFixed(2) + ' Mo';
  const fmtDate = s => s ? new Date(s).toLocaleDateString() : '';

  async function pollFw() {
    try {
      fwData = await api('/api/firmware' + ($('#fwAll').checked ? '?all=1' : ''));
      const avail = fwData.nodes.filter(n => n.fw && n.fw.available).length;
      $('#btnFw').innerHTML = `Mises à jour${avail ? ` <span class="n">${avail}</span>` : ''}`;
      if (fwOpen) renderFw();
    } catch { /* server away */ }
  }

  function renderFw() {
    const d = fwData; if (!d) return;
    // overall OTA progress (queued + running + done in the current batch)
    const otas = d.nodes.filter(n => n.ota);
    const running = otas.filter(n => ['queued', 'flash', 'reboot'].includes(n.ota.status)).length;
    const doneN = otas.filter(n => n.ota.status === 'done').length;
    $('#fwProgress').textContent = running ? `mise à jour en cours : ${doneN} terminé(s), ${running} restant(s) (${d.otaParallel > 1 ? d.otaParallel + ' en parallèle' : 'un node à la fois'})` : '';
    $('#fwRepoInfo').textContent = d.refreshedAt ? `catalogue GitHub ${d.repo} du ${new Date(d.refreshedAt).toLocaleString()}` : `catalogue jamais rafraîchi (${d.repo})`;
    $('#fwErr').style.display = d.lastRefreshError ? '' : 'none'; $('#fwErr').textContent = d.lastRefreshError ? `Dernier rafraîchissement en échec (hors ligne ?) : ${d.lastRefreshError}` : '';
    // releases
    // compact by default: latest stable, latest pre-release, and anything already in the store
    const latestStable = d.releases.find(r => !r.prerelease && !r.isLocalTag), latestPre = d.releases.find(r => r.prerelease);
    const shownRel = $('#fwAllRel') && $('#fwAllRel').checked ? d.releases : d.releases.filter(r => r === latestStable || r === latestPre || r.isLocalTag || r.localCount > 0);
    $('#fwRelCount').textContent = shownRel.length === d.releases.length ? `${d.releases.length} releases` : `${shownRel.length} sur ${d.releases.length} releases`;
    $('#fwRel').innerHTML = shownRel.map(r => {
      const kind = r.isLocalTag ? '<span class="tag local">local</span>' : r.prerelease ? '<span class="tag pre">beta/nightly</span>' : '<span class="tag stable">stable</span>';
      const missing = r.assets.filter(a => a.inUse && !a.local && a.url).length;
      const rows = r.assets.map(a => {
        const dl = d.downloads[`${r.tag}/${a.name}`];
        let state;
        if (a.local) state = '<span class="st-ok">✓ hors ligne</span>';
        else if (dl && dl.status === 'downloading') state = `<span class="bar"><i style="width:${Math.round(100 * dl.received / (dl.size || 1))}%"></i></span> ${Math.round(100 * dl.received / (dl.size || 1))}%`;
        else if (dl && dl.status === 'error') state = `<span class="st-bad" title="${esc(dl.error)}">échec</span>`;
        else state = '<span class="muted">—</span>';
        const btn = a.local ? `<button class="rowbtn danger" data-fw="del" data-tag="${esc(r.tag)}" data-asset="${esc(a.name)}" title="supprimer du dépôt">✕</button>`
          : a.url && !(dl && dl.status === 'downloading') ? `<button class="rowbtn" data-fw="dl" data-tag="${esc(r.tag)}" data-asset="${esc(a.name)}">⬇</button>` : '';
        return `<tr><td></td><td></td><td>${esc(a.name)}${a.inUse ? '' : ' <span class="muted">(hors flotte)</span>'}</td><td>${fmtSize(a.size)}</td><td>${state}</td><td>${btn}</td></tr>`;
      }).join('');
      return `<tr><td><b>${esc(r.tag)}</b> ${kind}</td><td>${fmtDate(r.publishedAt)}</td><td class="muted">${r.localCount}/${r.assetCount} fichiers en local</td><td></td><td></td><td>${missing ? `<button class="rowbtn" data-fw="fleet" data-tag="${esc(r.tag)}" title="télécharger les ${missing} firmware(s) des plateformes de la flotte">⬇ pour la flotte (${missing})</button>` : ''}</td></tr>${rows}`;
    }).join('') || '<tr><td colspan="6" class="muted">catalogue vide : cliquer « Rafraîchir depuis GitHub » (internet requis une fois)</td></tr>';
    $('#fwRel').querySelectorAll('button[data-fw]').forEach(b => b.onclick = () => fwAction(b.dataset.fw, b.dataset.tag, b.dataset.asset));
    // target selector: releases that have at least one local asset for the fleet
    const sel = $('#fwTarget'); const cur = sel.value;
    const targets = d.releases.filter(r => r.assets.some(a => a.local));
    sel.innerHTML = targets.map(r => `<option value="${esc(r.tag)}">${esc(r.tag)}${r.prerelease ? ' (beta)' : ''}</option>`).join('') || '<option value="">aucun firmware local</option>';
    if (targets.some(r => r.tag === cur)) sel.value = cur;
    // nodes
    const target = d.releases.find(r => r.tag === sel.value);
    $('#fwNodes').innerHTML = d.nodes.map(n => {
      const fw = n.fw || {};
      const asset = target && target.assets.find(a => a.env === fw.env);
      const can = asset && asset.local && !n.otaLock && n.online;
      const stCls = fw.status === 'à jour' ? 'st-ok' : /prête/.test(fw.status || '') ? 'st-warn' : /télécharger/.test(fw.status || '') ? 'st-info' : 'muted';
      const o = n.ota; let flash = '';
      if (o) {
        const pct = o.total ? Math.round(100 * o.sent / o.total) : 0;
        const secs = Math.round((Date.now() - o.at) / 1000);
        flash = {
          queued: '<span class="muted">⏳ en file d\'attente</span>',
          flash: `<span class="bar"><i style="width:${pct}%"></i></span> <span class="st-info">envoi ${pct}%</span> <span class="muted">${fmtSize(o.sent)} / ${fmtSize(o.total)}</span>`,
          reboot: `<span class="bar"><i style="width:100%;background:var(--warn)"></i></span> <span class="st-warn">redémarrage… ${secs}s</span>`,
          done: `<span class="bar"><i style="width:100%;background:var(--accent)"></i></span> <span class="st-ok">✓ ${esc(o.from)} → ${esc(o.to)}</span>`,
          timeout: '<span class="st-bad">✗ pas revenu après 150 s (vérifier le node)</span>',
          error: `<span class="st-bad" title="${esc(o.msg)}">✗ échec : ${esc((o.msg || '').slice(0, 60))}</span>`,
        }[o.status] || esc(o.status);
      }
      const why = !n.online ? 'hors ligne' : n.otaLock ? 'OTA verrouillé' : !asset ? 'pas de firmware pour cette plateforme dans la cible' : !asset.local ? 'firmware pas encore téléchargé' : '';
      return `<tr title="${esc(why)}"><td><input type="checkbox" class="fwsel" data-ip="${esc(n.ip)}" ${can ? '' : 'disabled'} ${fwSel.has(n.ip) && can ? 'checked' : ''}></td><td>${esc(n.name || n.ip)} <span class="muted">${esc(n.ip)}</span></td><td>${esc(fw.env || '')}${fw.fork ? ` <span class="tag pre" title="firmware d'un fork : ${esc(fw.fork)}">fork</span>` : ''}</td><td>${esc(fw.ver || '')}</td><td>${esc(fw.latest || '?')}${fw.latestLocal ? ' <span class="st-ok" title="dans le dépôt">●</span>' : ''}</td><td class="${stCls}">${esc(fw.status || '')}${n.otaLock ? ' · <span class="st-bad">OTA verrouillé</span>' : ''}</td><td>${flash}</td></tr>`;
    }).join('') || '<tr><td colspan="7" class="muted">aucun node</td></tr>';
    $('#fwNodes').querySelectorAll('input.fwsel').forEach(cb => cb.onchange = () => { cb.checked ? fwSel.add(cb.dataset.ip) : fwSel.delete(cb.dataset.ip); updateFlashBtn(); });
    updateFlashBtn();
  }
  function updateFlashBtn() {
    const n = [...$('#fwNodes').querySelectorAll('input.fwsel:checked')].length;
    $('#fwFlash').disabled = n === 0 || (fwData && fwData.readonly);
    $('#fwFlash').textContent = n ? `Mettre à jour ${n} node${n > 1 ? 's' : ''} → ${$('#fwTarget').value}` : 'Mettre à jour la sélection';
  }
  async function fwAction(act, tag, asset) {
    try {
      if (act === 'dl') await api('/api/firmware/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag, asset }) });
      if (act === 'fleet') { const r = await api('/api/firmware/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag, forFleet: true }) }); toast(`${r.started.length} téléchargement(s) lancé(s)`); }
      if (act === 'del') { if (!await confirmBox(`Supprimer ${asset} du dépôt local ?`)) return; await api('/api/firmware/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag, asset }) }); }
      pollFw();
    } catch (e) { toast(e.message, true); }
  }
  $('#fwRefresh').onclick = async () => {
    $('#fwRefresh').disabled = true; $('#fwRefresh').textContent = 'interrogation de GitHub…';
    try { const r = await api('/api/firmware/refresh', { method: 'POST' }); toast(`catalogue à jour : ${r.releases} releases`); }
    catch (e) { toast(e.message, true); }
    $('#fwRefresh').disabled = false; $('#fwRefresh').textContent = 'Rafraîchir depuis GitHub';
    pollFw();
  };
  $('#fwAll').onchange = pollFw; $('#fwAllRel').onchange = renderFw;
  try { const p = localStorage.getItem('wf.otaParallel'); if (p) $('#fwParallel').value = p; } catch { /* ignore */ }
  $('#fwTarget').onchange = renderFw;
  $('#fwSelAll').onchange = e => { $('#fwNodes').querySelectorAll('input.fwsel:not(:disabled)').forEach(cb => { cb.checked = e.target.checked; cb.checked ? fwSel.add(cb.dataset.ip) : fwSel.delete(cb.dataset.ip); }); updateFlashBtn(); };
  $('#fwFile').onchange = async () => {
    const f = $('#fwFile').files[0]; if (!f) return;
    try { const r = await api('/api/firmware/upload', { method: 'POST', headers: { 'X-Filename': f.name }, body: f }); toast(`${r.name} ajouté au dépôt (${fmtSize(r.size)})`); pollFw(); }
    catch (e) { toast(e.message, true); }
    $('#fwFile').value = '';
  };
  $('#fwFlash').onclick = async () => {
    const tag = $('#fwTarget').value; const target = fwData.releases.find(r => r.tag === tag);
    const ips = [...$('#fwNodes').querySelectorAll('input.fwsel:checked')].map(cb => cb.dataset.ip);
    const plan = ips.map(ip => { const n = fwData.nodes.find(x => x.ip === ip); const a = target.assets.find(x => x.env === n.fw.env); return { ip, name: n.name, from: n.fw.ver, asset: a && a.name }; });
    const parallel = Number($('#fwParallel').value);
    const how = parallel === 1 ? 'un par un' : parallel >= plan.length ? 'tous en même temps' : `${parallel} à la fois`;
    if (!await confirmBox(`Flasher ${plan.length} node(s) avec ${tag} ?\n\n${plan.map(p => `• ${p.name} (${p.ip}) : ${p.from} → ${p.asset}`).join('\n')}\n\nEnvoi ${how}, puis redémarrage de chaque node.`)) return;
    try { localStorage.setItem('wf.otaParallel', String(parallel)); } catch { /* ignore */ }
    let ok = 0;
    for (const p of plan) {
      try { await api(`/api/node/${encodeURIComponent(p.ip)}/update`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag, asset: p.asset, parallel }) }); ok++; }
      catch (e) { toast(`${p.name} : ${e.message}`, true); }
    }
    fwSel.clear();
    if (ok) toast(`${ok} node(s) en file de mise à jour`);
    pollFw();
  };

  async function discard() {
    if (!pending.size) return;
    if (!await confirmBox(`Abandonner ${pending.size} changement(s) en attente ?`)) return;
    pending.clear(); updatePendingUI(); renderBody();
  }

  async function action(act, ip) {
    try {
      if (act === 'unify') {
        const n = fleet.nodes.find(x => key(x) === ip); const cur = n && n.info ? n.info.name : ip;
        const name = prompt(`Unifier nom / mDNS / SSID de l'AP de ${cur}.\n\nNom à utiliser pour les trois (mDNS en minuscules-tirets) :`, cur);
        if (!name) return;
        if (!await confirmBox(`Écrire sur ${ip} :\n  nom  = ${name}\n  mDNS = ${name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')}\n  AP   = ${name}\npuis redémarrer le node ?`)) return;
        try { const r = await post(`/api/node/${encodeURIComponent(ip)}/unify`, { name, reboot: true }); toast(`${ip} : nom / mDNS / AP = ${r.name}, redémarrage`); } catch (e) { toast(e.message, true); }
        refresh(); return;
      }
      if (act === 'offline-queue') {
        const n = fleet.nodes.find(x => key(x) === ip); const q = n && n.meta.offlineQueue;
        if (!q) return;
        const what = Object.keys(q).map(f => OFFLINE_FIELD_LABEL[f] || f).join(', ');
        menuBox(lastPointer.x, lastPointer.y + 8, [
          { label: `Mettre à jour le node (${what})`, help: n.meta.online ? 'envoie ces changements en attente au node maintenant' : 'le node est toujours hors ligne : réessayer à son retour', act: async () => {
            try { const r = await post(`/api/node/${encodeURIComponent(ip)}/offline-queue/apply`, {}); toast(r.applied.length ? `${nameOf(ip)} : ${r.applied.join(', ')} envoyé(s)` : `${nameOf(ip)} : toujours hors ligne`); } catch (e) { toast(e.message, true); } refresh();
          } },
          { label: 'Récupérer depuis le node (abandonner)', danger: true, help: 'jette ces changements en attente ; la config actuelle du node fait foi', act: async () => {
            try { await post(`/api/node/${encodeURIComponent(ip)}/offline-queue/discard`, {}); toast(`${nameOf(ip)} : changements en attente abandonnés`); } catch (e) { toast(e.message, true); } refresh();
          } },
        ]);
        return;
      }
      if (act === 'identify') {
        try { await post(`/api/node/${encodeURIComponent(ip)}/identify`, { ms: 3000 }); toast(`💡 ${ip} en blanc 3 s`); } catch (e) { toast(e.message, true); }
        return;
      }
      if (act === 'relocate') {
        const n = fleet.nodes.find(x => key(x) === ip);
        let sug = null; try { sug = await api('/api/pair/suggest?ssid=' + encodeURIComponent(n && n.info ? n.info.name : '')); } catch { /* optional */ }
        const target = prompt(`Rapatrier ${n && n.info ? n.info.name : ip} (${ip}) dans le réseau de la flotte.\n\nIP fixe à lui donner (libre, vérifiée) :`, sug && sug.ip ? sug.ip : '');
        if (!target) return;
        if (!await confirmBox(`Écrire IP fixe ${target} / passerelle ${target.split('.').slice(0, 3).join('.')}.1 / masque 255.255.255.0 sur ${ip}, même SSID, puis redémarrer ?\n\nLe node réapparaîtra en ${target} dans ~20 s.`)) return;
        try { const r = await post(`/api/node/${encodeURIComponent(ip)}/relocate`, { ip: target }); toast(`${r.from} → ${r.to} : IP écrite, redémarrage`); }
        catch (e) { toast(e.message, true); }
        refresh(); return;
      }
      if (act === 'reboot') { if (!await confirmBox(`Redémarrer ${ip} ?`)) return; await api(`/api/node/${encodeURIComponent(ip)}/reboot`, { method: 'POST' }); toast(`${ip} redémarre`); }
      if (act === 'forget') { if (!await confirmBox(`Retirer ${ip} de la liste ? (réapparaîtra au prochain scan s'il répond)`)) return; await api(`/api/nodes/${encodeURIComponent(ip)}`, { method: 'DELETE' }); selected.delete(ip); refresh(); }
    } catch (e) { toast(e.message, true); }
  }

  // ── export ─────────────────────────────────────────────────────────────────
  function table(sep, quote) {
    const cols = [COLS.find(c => c.id === 'name'), ...visibleCols().filter(c => c.id !== 'name')];
    const q = s => quote ? '"' + String(s).replace(/"/g, '""') + '"' : String(s).replace(/[\t\n]/g, ' ');
    const lines = [cols.map(c => q(c.label)).join(sep)];
    rows().forEach(n => lines.push(cols.map(c => q(raw(c, get(n, c.path)))).join(sep)));
    return lines.join('\n');
  }
  $('#btnTsv').onclick = async () => { try { await navigator.clipboard.writeText(table('\t', false)); toast('grille copiée — coller dans Excel'); } catch { toast('copie refusée par le navigateur', true); } };
  $('#btnCsv').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + table(';', true)], { type: 'text/csv' })); a.download = `wled-fleet-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); };

  // ── wiring ─────────────────────────────────────────────────────────────────
  $('#btnScan').onclick = async () => { await api('/api/scan', { method: 'POST' }); toast('scan lancé'); refresh(); };
  $('#btnAdd').onclick = async () => { const ip = $('#addIp').value.trim(); if (!ip) return; try { await api('/api/nodes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip }) }); $('#addIp').value = ''; toast(`${ip} ajouté`); refresh(); } catch (e) { toast(e.message, true); } };
  $('#addIp').onkeydown = e => { if (e.key === 'Enter') $('#btnAdd').click(); };
  $('#filter').oninput = renderBody; $('#diffToggle').onchange = renderBody; $('#hideOffline').onchange = renderBody;
  $('#btnDeploy').onclick = deploy; $('#btnDiscard').onclick = discard;
  // show preset for nodes: staged as pending cells, deployed by the user
  const NODE_PRESET = [['wifisleep', false], ['txpwr', 78], ['seqskip', true]];
  $('#btnPreset').onclick = () => {
    const targets = (selected.size ? fleet.nodes.filter(n => selected.has(key(n))) : fleet.nodes).filter(n => n.meta.online && n.cfg);
    if (!targets.length) return toast('aucun node en ligne');
    let staged = 0;
    for (const n of targets) for (const [id, v] of NODE_PRESET) {
      const col = COLS.find(c => c.id === id); if (!col) continue;
      const live = get(n, col.path);
      if (JSON.stringify(live) === JSON.stringify(v)) continue;
      pending.set(pkey(key(n), id), { ip: key(n), col, value: v }); staged++;
    }
    updatePendingUI(); renderBody();
    toast(staged ? `${staged} changement(s) mis en attente sur ${targets.length} node(s) : vérifier puis Déployer` : `les ${targets.length} node(s) sont déjà au préréglage show`);
  };
  $('#btnIdentify').onclick = async () => {
    const targets = (selected.size ? fleet.nodes.filter(n => selected.has(key(n))) : fleet.nodes).filter(n => n.meta.online);
    if (!targets.length) return toast('aucun node en ligne à identifier');
    if (!selected.size && !await confirmBox(`Allumer en blanc 3 s les ${targets.length} nodes en ligne ?`)) return;
    let ok = 0;
    await Promise.all(targets.map(async n => { try { await post(`/api/node/${encodeURIComponent(key(n))}/identify`, { ms: 3000 }); ok++; } catch { /* offline */ } }));
    toast(`💡 ${ok} node(s) en blanc 3 s`);
  };
  $('#btnPurge').onclick = async () => {
    const off = fleet.nodes.filter(n => !n.meta.online);
    if (!off.length) return toast('aucun node hors ligne');
    const lbl = off.map(n => `${(n.info && n.info.name) || n.meta.ip} (${n.meta.ip}${n.meta.lastSeenAgo != null ? ', vu il y a ' + fmtDur(n.meta.lastSeenAgo) : ', jamais vu'})`).join('\n');
    if (!await confirmBox(`Retirer ${off.length} node(s) hors ligne de la liste ?\n\n${lbl}\n\nIls réapparaîtront au prochain scan s'ils répondent.`)) return;
    try { const r = await post('/api/nodes/purge', {}); toast(`${r.removed.length} node(s) retiré(s)`); off.forEach(n => selected.delete(n.meta.ip)); refresh(); }
    catch (e) { toast(e.message, true); }
  };
  window.addEventListener('beforeunload', e => { if (pending.size) { e.preventDefault(); e.returnValue = ''; } });

  // about + restart (standalone app: WLED-Fleet.cmd relaunches node on exit code 75)
  api('/api/about').then(a => { $('#about').textContent = `WLED Fleet ${a.version} · ${a.launcher ? 'lanceur' : 'console'} · ${a.dir}`; if (!a.launcher) $('#btnRestart').title += ' (ici : lancé sans le lanceur, bouton inactif)'; $('#btnRestart').disabled = !a.launcher; }).catch(() => {});
  $('#btnRestart').onclick = async () => {
    if (pending.size && !await confirmBox(`${pending.size} changement(s) en attente seront perdus. Redémarrer quand même ?`)) return;
    try { await post('/api/restart', {}); toast('serveur en redémarrage, la page se reconnecte…'); setTimeout(() => location.reload(), 4000); }
    catch (e) { toast(e.message, true); }
  };
  // boot: keep retrying until the server answers (it may still be starting), then poll forever
  (async () => {
    wireMouseSelect();
    $('.gridwrap').addEventListener('contextmenu', e => { if (e.target.closest('thead')) return; gridMenu(e); });
    for (;;) { try { await loadColumns(); break; } catch { $('#liveTxt').textContent = 'serveur injoignable, nouvel essai…'; await new Promise(r => setTimeout(r, 2000)); } }
    await loadLedProfiles();
    await refresh(); pollChanges(); pollFw(); pollAp();
    setTimeout(checkAppUpdate, 4000);
    // the tab controller may have shown a tab before columns / fleet were loaded: render it again with data
    if (typeof showTab === 'function') showTab(currentTab);
    setInterval(refresh, 2000); setInterval(pollChanges, 2000); setInterval(pollFw, 2000); setInterval(pollAp, 3000);
  })();
  // ── tabs: one pane at a time, full height; ⧉ opens the current tab in its own window ──
  const TABS = {
    grid:     { btn: '#btnGrid',     pane: '#tabgrid',   show: () => {} },
    journal:  { btn: '#btnJournal',  pane: '#journal',   show: () => { journalOpen = true; unseen = 0; renderJournal(); } },
    ap:       { btn: '#btnAp',       pane: '#appanel',   show: () => { apOpen = true; apLastKey = ''; pollAp(); } },
    fw:       { btn: '#btnFw',       pane: '#fwpanel',   show: () => { fwOpen = true; pollFw(); } },
    dmx:      { btn: '#btnDmx',      pane: '#dmxpanel',  show: () => { dmxOpen = true; renderDmx(); } },
    opt:      { btn: '#btnOpt',      pane: '#optpanel',  show: () => { optOpen = true; renderOpt(); } },
    pair:     { btn: '#btnPair',     pane: '#pairpanel', show: () => { pairOpen = true; renderPair(); if (!pairNets) scanPair(); pollPair(); if (pairRadar) setRadar(true); } },
    snap:     { btn: '#btnSnap',     pane: '#snappanel', show: () => { snapOpen = true; pollSnap(); } },
    settings: { btn: '#btnSettings', pane: '#setpanel',  show: () => { setOpen = true; renderSettings(); } },
  };
  let currentTab = 'grid';
  function showTab(name) {
    if (!TABS[name]) name = 'grid';
    if (currentTab === 'dmx' && name !== 'dmx') stopLocating();
    currentTab = name;
    journalOpen = apOpen = fwOpen = pairOpen = snapOpen = setOpen = dmxOpen = optOpen = false;
    for (const [k, t] of Object.entries(TABS)) { $(t.pane).classList.toggle('open', k === name); $(t.btn).classList.toggle('active', k === name); }
    TABS[name].show();
    try { localStorage.setItem('wf.tab', name); } catch { /* ignore */ }
    if (location.hash !== '#tab=' + name) history.replaceState(null, '', location.pathname + location.search + '#tab=' + name);
  }
  for (const [k, t] of Object.entries(TABS)) $(t.btn).onclick = () => showTab(k);
  // external links: the native window's WebView cannot spawn windows, the server opens the system browser
  const openExternal = async url => { try { await post('/api/open', { url }); } catch { try { window.open(url, '_blank'); } catch { /* nothing */ } } };
  $('#tabDetach').onclick = () => openExternal(location.origin + location.pathname + '?solo=1#tab=' + currentTab);
  $('#btnBrowser').onclick = () => openExternal(location.origin + location.pathname + '#tab=' + currentTab);
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href^="http"]'); if (!a || a.host === location.host) return;
    e.preventDefault(); openExternal(a.href); // node WLED pages, GitHub, router… -> system browser, never inside the app
  });
  const solo = new URLSearchParams(location.search).get('solo') === '1';
  if (solo) document.body.classList.add('solo');
  const wanted = (/#tab=(\w+)/.exec(location.hash) || [])[1] || (solo ? 'grid' : (() => { try { return localStorage.getItem('wf.tab'); } catch { return null; } })());
  showTab(wanted || 'grid');
  window.addEventListener('hashchange', () => { const t = (/#tab=(\w+)/.exec(location.hash) || [])[1]; if (t && t !== currentTab) showTab(t); });

})();

