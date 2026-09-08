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
  let COLS = [], GROUPS = [], fleet = { nodes: [] }, LED_TYPES = {}, COLOR_ORDERS = {}, WHITE_SWAPS = {}, WHITE_SWAP_TYPES = [];
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
  // ── Quel onglet est ouvert ────────────────────────────────────────────────
  // Les pollers s'en servent pour ne pas travailler dans le vide. Avant, chaque
  // onglet avait son drapeau `xxxOpen`, et showTab() les remettait TOUS à false
  // à la main avant d'allumer le bon : neuf variables à tenir cohérentes, et
  // une de plus à chaque onglet ajouté. L'oubli ne se voyait pas — le panneau
  // continuait simplement à se rafraîchir en arrière-plan.
  //
  // La vérité est déjà dans `currentTab`. Une seule fonction la lit, et il n'y
  // a plus rien à oublier.
  let currentTab = 'grid';
  const isOpen = k => currentTab === k;
  // change journal (from /api/changes): cells touched in the last 10 min keep a marker
  let changes = [], lastChangeAt = 0, unseen = 0;
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
  // même popover que confirmBox, avec un champ. Résout la valeur saisie, ou null
  // si on annule — vide et annulé sont deux réponses différentes.
  function promptBox(head, value = '', body = '') {
    return new Promise(resolve => {
      const box = document.createElement('div'); box.className = 'pop';
      box.innerHTML = `<div class="pop-head">${esc(head)}</div>${body ? `<div class="pop-body">${esc(body)}</div>` : ''}
        <div style="padding:0 10px 8px"><input class="pop-input" value="${esc(value)}" style="width:100%"></div>
        <div class="pop-actions"><button class="pop-cancel">Annuler</button><button class="pop-act green">Appliquer</button></div>`;
      document.body.appendChild(box);
      const W = box.offsetWidth, H = box.offsetHeight;
      box.style.left = Math.min(Math.max(8, lastPointer.x - 20), innerWidth - W - 8) + 'px';
      box.style.top = (lastPointer.y + 12 + H > innerHeight - 8 ? Math.max(8, lastPointer.y - H - 12) : lastPointer.y + 12) + 'px';
      const input = box.querySelector('.pop-input');
      const done = v => { document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', key, true); box.remove(); resolve(v); };
      const outside = e => { if (!box.contains(e.target)) { e.stopPropagation(); e.preventDefault(); done(null); } };
      const key = e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } else if (e.key === 'Enter') { e.stopPropagation(); done(input.value); } };
      setTimeout(() => { document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', key, true); }, 0);
      box.querySelector('.pop-cancel').onclick = () => done(null);
      box.querySelector('.pop-act').onclick = () => done(input.value);
      input.focus(); input.select();
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
  // Le résultat est CONSERVÉ ici, pas jeté : sans lui, « déjà à jour » et « cassé »
  // se ressemblent exactement (aucune popup dans les deux cas), ce qui a fait
  // conclure trois fois à une panne alors que l'app était simplement à jour.
  // Le panneau Réglages l'affiche et permet de revérifier à la demande.
  // Canal de mise à jour. Mémorisé sur le poste, pas compilé dans l'application :
  // basculer de stable à beta ne doit pas demander de réinstaller. GitHub garantit
  // le reste — /releases/latest/ ne résout jamais vers une préversion, donc le
  // canal stable ne peut pas attraper une beta par accident.
  const CHANNELS = { stable: 'Stable', beta: 'Beta — nouveautés en cours d\'essai' };
  let updChannel = (() => { try { return CHANNELS[localStorage.getItem('wf.channel')] ? localStorage.getItem('wf.channel') : 'stable'; } catch { return 'stable'; } })();
  const setChannel = c => { updChannel = CHANNELS[c] ? c : 'stable'; try { localStorage.setItem('wf.channel', updChannel); } catch { /* ignore */ } };
  let updateState = { at: 0, status: 'jamais', version: null, notes: '', error: '', channel: updChannel };
  async function runUpdateCheck() {
    if (!window.__TAURI__) { updateState = { at: Date.now(), status: 'navigateur', version: null, notes: '', error: '' }; return updateState; }
    try {
      const info = await window.__TAURI__.core.invoke('check_update', { channel: updChannel });
      updateState = info
        ? { at: Date.now(), status: 'disponible', version: info.version, notes: (info.notes || '').trim(), error: '' }
        : { at: Date.now(), status: 'ajour', version: null, notes: '', error: '' };
    } catch (e) {
      updateState = { at: Date.now(), status: 'erreur', version: null, notes: '', error: e && e.message ? e.message : String(e) };
    }
    return updateState;
  }
  async function installAppUpdate() {
    toast('téléchargement et installation de la mise à jour…', false, 15000);
    await window.__TAURI__.core.invoke('install_update', { channel: updChannel }); // l'app relance elle-même une fois prête
  }
  // au démarrage : propose seulement s'il y a vraiment quelque chose, sans jamais
  // ouvrir de popup d'erreur au lancement (hors ligne = silencieux, mais consigné)
  async function checkAppUpdate() {
    if (!window.__TAURI__) return;
    const st = await runUpdateCheck();
    if (st.status !== 'disponible') return;
    const notes = st.notes.slice(0, 300);
    const go = await confirmBox(`Mise à jour WLED Fleet ${st.version} disponible${notes ? '\n' + notes : ''}`, { tone: 'green', label: 'Installer' });
    if (!go) return;
    try { await installAppUpdate(); } catch (e) { toast(`mise à jour : ${e.message || e}`, true); }
  }

  // ── data ───────────────────────────────────────────────────────────────────
  async function api(path, opts) {
    const r = await fetch(path, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }
  async function loadColumns() {
    const j = await api('/api/columns'); COLS = j.columns; GROUPS = j.groups; LED_TYPES = j.ledTypes || {}; COLOR_ORDERS = j.colorOrders || {}; WHITE_SWAPS = j.whiteSwaps || {}; WHITE_SWAP_TYPES = j.whiteSwapTypes || []; renderGroupBar(); renderHead();
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
    setBadge('dmx', n ? ` <span class="n">${n}</span>` : '');
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
    setBadge('journal', unseen ? ` <span class="n">${unseen}</span>` : '');
    if (!isOpen('journal')) return;
    $('#journalBody').innerHTML = [...changes].reverse().slice(0, 300).map(ev => {
      const col = COLS.find(c => c.id === ev.col);
      const f = v => col ? raw(col, v) : (v == null ? '' : String(v));
      return `<tr><td>${new Date(ev.at).toLocaleTimeString()}</td><td>${esc(ev.name || ev.ip)} <span class="muted">${esc(ev.ip)}</span></td><td>${esc(col ? col.label : ev.col)}</td><td>${esc(f(ev.old))}</td><td><b>${esc(f(ev.new))}</b></td><td><span class="src ${ev.source}">${ev.source}</span></td></tr>`;
    }).join('') || '<tr><td colspan="6" class="muted">aucune modification détectée pour l\'instant</td></tr>';
  }

  // ── Optimisation tab: antenna preset + node preset, real state, actions ───
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
  // « repérer » : le serveur porte la sortie à une longueur d'exploration et
  // découpe le ruban en trois tons — en dessous du repère, le repère, au-delà —
  // pour compter en direct en ajustant Pixels. Une seule sortie à la fois ; le
  // serveur restaure tout seul après 90 s d'inactivité si on part sans arrêter.
  // Les couleurs vivent dans localStorage : settings.json impose un redémarrage
  // du serveur et réécrit tout le fichier, impensable pour régler une couleur en
  // regardant le ruban.
  const LOC_DEF = { hi: '#ffffff', lo: '#3060ff', over: '#3a0a00', bri: 255, probe: 0 };
  const locPref = (k) => { try { const v = localStorage.getItem('wf.locate' + k); return v === null ? LOC_DEF[k.toLowerCase()] : (k === 'Bri' || k === 'Probe' ? Number(v) : v); } catch { return LOC_DEF[k.toLowerCase()]; } };
  const setLocPref = (k, v) => { try { localStorage.setItem('wf.locate' + k, String(v)); } catch { /* ignore */ } };
  let locOpts = { hi: locPref('Hi'), lo: locPref('Lo'), over: locPref('Over'), bri: locPref('Bri'), probe: locPref('Probe') };
  let locating = null; // { ip, index }
  let locBar = null;   // poignée de la barre flottante (setLen / setProbe)
  // Édition en lot : lignes cochées, clés "ip|outrow". Survit aux re-rendus du
  // panneau, comme `locating`. Modifier un champ sur une ligne cochée applique la
  // même valeur à toutes les autres — sans jamais écrire : c'est « Enregistrer les
  // modifications » qui décide, exactement comme ⚡ Patcher.
  const picks = new Set();
  async function stopLocating() {
    if (!locating) return;
    closeLocBar(); locBar = null;
    const ip = locating.ip; locating = null;
    try { await api(`/api/node/${encodeURIComponent(ip)}/locate-pixel`, { method: 'DELETE' }); } catch { /* déjà éteint, ou node parti */ }
  }
  // Barre du repérage : elle doit survivre pendant qu'on édite le tableau, donc pas
  // un .pop (tous se ferment au premier clic extérieur). Les ± sont le geste
  // principal du mode : on regarde le ruban, pas l'écran.
  function closeLocBar() { const b = $('#locbar'); if (b) b.remove(); }
  function openLocBar(name, outNo, onStep, onOpts, onStop) {
    closeLocBar();
    const bar = document.createElement('div');
    bar.id = 'locbar'; bar.className = 'locbar';
    bar.innerHTML = `<b>📍 ${esc(name)}</b> <span class="muted">sortie ${outNo}</span>
      <span class="locgrp"><button data-step="-10" title="−10 pixels">−10</button><button data-step="-1" title="−1 pixel">−1</button>
        <input type="number" id="locLen" min="1" title="nombre de pixels comptés"><button data-step="1" title="+1 pixel">+1</button><button data-step="10" title="+10 pixels">+10</button></span>
      <span class="locgrp" title="couleurs du repérage, mémorisées pour la prochaine fois">
        <label>repère <input type="color" id="locHi" value="${esc(locOpts.hi)}"></label>
        <label>en dessous <input type="color" id="locLo" value="${esc(locOpts.lo)}"></label>
        <label>au-delà <input type="color" id="locOver" value="${esc(locOpts.over)}"></label></span>
      <label class="locgrp" title="luminosité du node pendant le repérage">lum. <input type="range" id="locBri" min="8" max="255" value="${Number(locOpts.bri) || 255}"></label>
      <label class="locgrp" title="longueur temporairement déclarée sur la sortie pour pouvoir piloter tout le ruban : monter si le ruban est plus long">explorer <input type="number" id="locProbe" min="1" max="2048" style="width:64px"> px</label>
      <span class="spacer"></span><button id="locStop" class="primary">Arrêter</button>`;
    document.body.appendChild(bar);
    const lenEl = bar.querySelector('#locLen');
    bar.querySelectorAll('button[data-step]').forEach(b => {
      let rep = null, timer = null;
      const fire = () => onStep(Number(b.dataset.step));
      b.onmousedown = () => { fire(); timer = setTimeout(() => { rep = setInterval(fire, 90); }, 420); }; // répétition si on maintient
      const stop = () => { clearTimeout(timer); clearInterval(rep); rep = null; };
      b.onmouseup = b.onmouseleave = stop;
    });
    lenEl.oninput = () => onStep(0, Number(lenEl.value));
    const pushOpts = () => {
      locOpts = { hi: bar.querySelector('#locHi').value, lo: bar.querySelector('#locLo').value, over: bar.querySelector('#locOver').value, bri: Number(bar.querySelector('#locBri').value), probe: Number(bar.querySelector('#locProbe').value) || 0 };
      setLocPref('Hi', locOpts.hi); setLocPref('Lo', locOpts.lo); setLocPref('Over', locOpts.over); setLocPref('Bri', locOpts.bri); setLocPref('Probe', locOpts.probe);
      onOpts();
    };
    ['#locHi', '#locLo', '#locOver', '#locBri', '#locProbe'].forEach(s => { bar.querySelector(s).oninput = pushOpts; });
    bar.querySelector('#locStop').onclick = onStop;
    return { setLen: v => { lenEl.value = String(v); }, setProbe: v => { const e = bar.querySelector('#locProbe'); if (document.activeElement !== e) e.value = String(v); } };
  }
  async function renderDmx() {
    const p = $('#dmxpanel');
    let d; try { [d] = await Promise.all([api('/api/dmx-plan'), loadLedProfiles()]); } catch (e) { p.innerHTML = `<div class="st-bad">${esc(e.message)}</div>`; return; }
    const CPX = { 4: 3, 5: 3, 6: 4 }; // channels per pixel by DMX mode (Multi RGB, Multi DRGB, Multi RGBW)
    const modeName = m => ({ 4: 'Multi RGB', 5: 'Multi DRGB', 6: 'Multi RGBW' })[m] || (COLS.find(c => c.id === 'dmxmode') || { enum: {} }).enum[m] || m;
    // conflit = recouvrement AU CANAL PRÈS (voir dmx.js) : deux nodes peuvent partager un
    // univers à des adresses distinctes, c'est même le seul moyen de tasser des nodes courts
    const conflictsHtml = list => list.length ? `<b class="st-bad">✗ Canaux en double</b> : ${list.map(c => `<b>${c.universe}.${c.from}</b> → <b>${c.universe}.${c.to}</b> écoutés par ${c.nodes.map(esc).join(' et ')}`).join(' · ')} <span class="muted">— ces canaux pilotent deux nodes à la fois : ⚡ Patcher, ou décaler l'adresse de l'un d'eux</span>` : `<span class="muted">aucun canal écouté par deux nodes</span>`;
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
    // index du premier pixel de chaque univers : 0, firstUniPx, +pxPerUni… Le premier
    // univers en porte moins dès que l'adresse ≠ 1 (134 à l'adresse 109), donc le test
    // « démarre sur un univers » ne peut pas être un modulo — même calcul que dmx.js.
    const firstUniPxOf = pl => Math.floor((512 - (pl.addr - 1) - (pl.mode === 5 ? 1 : 0)) / pl.chPerPx);
    const startsUniverse = (px, pl) => { if (px === 0) return true; const f = firstUniPxOf(pl); return px >= f && (px - f) % pl.pxPerUni === 0; };
    // « ▲ à cheval » ne concerne QUE les sorties seules qui tombent au milieu d'un univers.
    // Une sortie chaînée est censée reprendre juste après la précédente : c'est le but,
    // pas un défaut — la signaler donnait un avertissement permanent sur une tournette.
    const alignedOf = pl => pl.outputs.every((o, i) => !o.len || i === 0 || chainedTo(pl.outputs, i) || startsUniverse(o.start, pl));
    // ⛓ une sortie est « chaînée » quand ses pixels reprennent exactement là où s'arrête
    // celle du dessus : les deux forment alors une seule fixture continue à la console
    // (tournette int + ext). Rien à mémoriser — c'est le plan de pixels lui-même qui le dit.
    const chainedTo = (outs, i) => i > 0 && outs[i - 1].len > 0 && outs[i].len > 0 && outs[i].start === outs[i - 1].start + outs[i - 1].len;
    // ── one table per group, node cell spanning its output rows (merged-cell look), one Save button for the tab ──
    const sel = (name, map, cur) => `<select data-out="${name}" data-orig="${cur}">${Object.entries(map).map(([v, l]) => `<option value="${v}" ${Number(v) === Number(cur) ? 'selected' : ''}>${esc(l)}</option>`).join('')}${map[cur] === undefined ? `<option value="${cur}" selected>type ${cur}</option>` : ''}</select>`;
    const nodeCell = (n, span) => {
      const pl = n.plan, rec = nodeRec(n.ip); const cur = c => { const st = pending.get(pkey(n.ip, c.id)); return st ? st.value : (rec ? get(rec, c.path) : undefined); };
      const mode = cur(colDmx.mode), uni = cur(colDmx.uni) ?? pl.uni, addr = cur(colDmx.addr) ?? pl.addr, mA = cur(colDmx.mA) ?? '';
      // Le régime ne se lit nulle part : il se DÉDUIT. Limite globale à 0 et au
      // moins une limite par sortie = limiteur par sortie. C'est exactement le
      // discriminant du firmware (bus_manager.cpp:1449), et WLED ne stocke pas
      // sa case à cocher autrement.
      const rawIns0 = (rec && rec.cfg && rec.cfg.hw && rec.cfg.hw.led && rec.cfg.hw.led.ins) || [];
      const ppl = Number(mA) === 0 && rawIns0.some(b => Number(b.maxpwr) > 0);
      const inConflict = inConflictOf(n), aligned = pl.multi && alignedOf(pl);
      // deux lignes, réglages à plat : un node à une seule sortie ne doit pas occuper la
      // hauteur de huit lignes de tableau (2026-09-08)
      return `<td class="ncell" rowspan="${span}" data-nodecell="${esc(n.ip)}">
        <div class="ncell-name" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap"><b>${esc(n.name || n.ip)}</b>
          <span class="ncell-st"><span class="st-bad cf" title="un autre node écoute une partie des mêmes canaux (état des champs à l'écran)" ${inConflict ? '' : 'hidden'}>✗ conflit</span>${pl.multi && !aligned ? ' <span class="st-warn" title="une sortie ne commence pas sur un début d\'univers : à la console, une fixture reste à cheval">▲ à cheval</span>' : ''}${n.live ? ` <span class="st-ok" title="flux temps réel reçu de ${esc(n.lip)}">● ${esc(n.lm)}</span>` : ''}</span>
          <span class="muted" style="font-size:10.5px">${esc(n.ip)}${pl.multi ? ` · ${pl.total} px` : ''}</span></div>
        <div class="ncell-set">
          <select data-nb="dmxmode" data-orig="${esc(String(mode ?? ''))}" title="mode DMX du node">${Object.entries(colDmx.mode.enum).map(([v, l]) => `<option value="${v}" ${Number(v) === Number(mode) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
          <label title="univers de départ"><span class="lbl">u</span><input type="number" data-nb="dmxuni" data-orig="${esc(String(uni))}" min="1" max="63999" value="${esc(String(uni))}"></label>
          <label title="adresse de départ dans cet univers : c'est elle qui permet de loger plusieurs nodes courts dans un même univers"><span class="lbl">adr</span><input type="number" data-nb="dmxaddr" data-orig="${esc(String(addr))}" min="1" max="512" value="${esc(String(addr))}"></label>
          <label title="limite de courant du node (mA) : l'ABL de WLED baisse la luminosité pour ne jamais dépasser ce budget. Il en retire d'abord 120 mA pour l'ESP lui-même."><span class="lbl">mA</span><input type="number" data-nb="maxpwr" data-orig="${esc(String(mA))}" min="0" step="50" value="${esc(String(mA))}"${ppl ? ' disabled' : ''}></label>
          <label class="chip" title="Un budget par sortie au lieu d'un seul pour tout le node. WLED le recommande dès qu'il y a plusieurs sorties : sans ça, une sortie chargée mange la marge des autres. Les deux régimes s'EXCLUENT — cocher met la limite globale à 0, c'est ce qui bascule le firmware. Indispensable quand les sorties sont sur des circuits ou des alimentations différents."><input type="checkbox" data-ppl data-orig="${ppl ? 1 : 0}" ${ppl ? 'checked' : ''}> par sortie</label>
          <span class="ablnote" data-abl></span>
        </div></td>`;
    };
    const profileOptions = cur => `<option value="">profil…</option>${ledProfilesCache.map(pr => `<option value="${esc(pr.id)}" ${pr.id === cur ? 'selected' : ''}>${esc(pr.name)}</option>`).join('')}<option value="__new">＋ enregistrer cette ligne comme profil…</option>${ledProfilesCache.length ? '<option value="__manage">gérer les profils…</option>' : ''}`;
    // Une fixture ne se stocke nulle part en entier : elle se reconstitue en
    // rassemblant les sorties qui portent le même numéro, triées par instance.
    // La pastille est donc l'essentiel de la colonne — c'est elle qui montre, à
    // travers plusieurs nodes et plusieurs groupes, ce qui n'existe qu'en creux.
    const fixField = o => {
      const f = o.fixture;
      const chip = f === null || f === undefined ? '<span class="fixdot none" title="aucune fixture : cette sortie n\'est pas encore déclarée à la console"></span>'
        : `<span class="fixdot" style="background:${fixColor(f)}" title="fixture ${f}, instance ${o.instance || 0}"></span>`;
      // l'instance n'a pas de champ visible : elle se déduit de l'ordre des lignes
      // à l'assignation en lot, et n'a de sens que rapportée aux autres membres
      return `${chip}<input type="number" data-fix="${o.i}" data-orig="${f ?? ''}" value="${f ?? ''}" min="1" max="9999" placeholder="—" title="numéro de fixture à la console. Plusieurs sorties, y compris sur des nodes différents, peuvent porter le même numéro : elles forment alors une seule fixture, dans l'ordre des instances. Mémorisé sur le node."><input type="hidden" data-inst data-orig="${o.instance || 0}" value="${o.instance || 0}">`;
    };
    // teinte stable dérivée du numéro : le même numéro donne toujours la même
    // couleur, sur tous les postes, sans rien à mémoriser. Le pas de 137° est
    // proche du nombre d'or ramené au cercle, donc deux numéros voisins ne se
    // ressemblent jamais.
    const fixColor = f => `hsl(${(Number(f) * 137) % 360} 62% 52%)`;
    const outRow = (n, o, r, i, first, span) => {
      const pl = n.plan;
      const pid = profileIdFor(o, r), unknown = !pid && !o.ignored && o.len;
      const linked = chainedTo(pl.outputs, i);
      const offBoundary = i > 0 && !linked && o.aligned === false; // seule ET au milieu d'un univers
      const uniTxt = !o.len ? '' : o.universes > 1 ? `<span class="${offBoundary ? 'st-warn' : 'muted'}" title="${offBoundary ? 'sortie seule qui commence au milieu d\'un univers : à la console elle reste à cheval' : 'cette sortie occupe plusieurs univers'}">${o.universes} univers</span>` : '<span class="st-ok">1 univers</span>';
      const wsw = (r.order || 0) >> 4, hasW = WHITE_SWAP_TYPES.includes(Number(r.type));
      // la colonne de chaînage passe AVANT la cellule de node (qui porte le rowspan) :
      // l'ordre doit suivre celui des <th>, sinon tout le tableau glisse d'une colonne
      const pk = `${n.ip}|${i}`, picked = picks.has(pk);
      return `<tr data-outrow="${i}" data-node="${esc(n.ip)}" class="${o.ignored ? 'offline' : ''}${first ? ' first' : ''}${linked ? ' chained' : ''}${picked ? ' selected' : ''}">
        <td class="pickcell"><input type="checkbox" data-pick="${esc(pk)}" ${picked ? 'checked' : ''} title="cocher plusieurs lignes, puis modifier un champ sur l'une d'elles : la valeur part sur toutes les lignes cochées"></td>
        <td class="chaincell${linked ? ' linked' : ''}" data-chain="${i}" title="${i === 0 ? 'première sortie du node : rien au-dessus à quoi la chaîner' : linked ? 'chaînée : ses pixels reprennent juste après ceux de la sortie du dessus, les deux forment une seule fixture continue à la console. Cliquer pour la détacher (elle repartira sur un début d\'univers).' : 'sortie seule. Cliquer pour la chaîner à celle du dessus : ses pixels reprendront juste après, sans trou — le cas de deux sorties d\'un même assemblage (tournette int + ext).'}">${i === 0 ? '' : `<span class="chainmark">${linked ? '⛓' : '⊘'}</span>`}</td>
        ${first ? nodeCell(n, span) : ''}
        <td><label class="chip" title="utilisée = câblée. Décocher une sortie qui existe dans WLED mais n'est pas branchée : grisée, et les canaux qu'elle occuperait ne sont plus réservés (hors conflits). Mémorisé sur le node (marqueur dans son MQTT device topic), rien d'autre n'est écrit."><input type="checkbox" data-ignore="${i}" ${o.ignored ? '' : 'checked'}> Sortie ${o.i + 1}</label></td>
        <td class="${unknown ? 'newprof' : ''}"><select data-prof title="${unknown ? 'profil inconnu de la bibliothèque locale : ce type/ordre/pixels ne correspond à aucun profil enregistré ici → ＋ enregistrer cette ligne comme profil pour le retrouver la prochaine fois.' : 'profil de LED : ce qui est branché sur cette sortie ; choisir un profil remplit type, ordre et pixels, et le node s\'en souvient (MQTT client id). Sans choix, Fleet reconnaît un profil quand la ligne y correspond exactement.'}">${profileOptions(pid)}</select></td>
        <td class="muted adv" title="GPIO de la sortie">${esc(o.pin)}</td>
        <td>${sel('type', LED_TYPES, r.type)}</td>
        <td class="adv"><input type="number" data-out="omax" data-orig="${r.maxpwr ?? 0}" value="${r.maxpwr ?? 0}" min="0" max="65000" step="50" title="Budget de courant de CETTE sortie (mA). N'agit que si « par sortie » est coché sur le node : sinon le firmware l'ignore entièrement, et WLED le réécrit tout seul au prorata des pixels à chaque enregistrement — c'est de là que viennent les valeurs bizarres qu'on trouve dans les configs."></td>
        <td class="adv"><input type="number" data-out="ledma" data-orig="${r.ledma ?? 55}" value="${r.ledma ?? 55}" min="0" max="255" title="mA par pixel à pleine luminosité, blanc plein. C'est le chiffre sur lequel WLED calcule son freinage : SOUS-DÉCLARÉ, il freine trop peu, la tension s'effondre et les LEDs se mettent à déconner sans qu'aucune erreur ne s'affiche. Déclarer 55 là où la réalité est 120 laisse passer 2,2 fois le courant prévu. 55 = défaut WLED (WS2812 générique) ; compter par PIXEL et non par LED quand un pixel en contient plusieurs. Plage utile 1 à 254 — 255 n'est pas 255 mA mais bascule sur le modèle WS2815 (12 mA), donc freine MOINS."></td>
        <td>${sel('order', COLOR_ORDERS, (r.order || 0) & 0x0f)}</td>
        <td>${hasW ? sel('wswap', WHITE_SWAPS, wsw) : `<input type="hidden" data-out="wswap" data-orig="${wsw}" value="${wsw}"><span class="muted" title="ce type de LED n'a pas de canal blanc : WLED ne propose l'échange que sur les types numériques RGBW">—</span>`}</td>
        <td><input type="number" data-out="start" data-orig="${o.start}" value="${o.start}" min="0" title="index du premier pixel de cette sortie dans le node (0 = premier)"></td>
        <td><span style="display:inline-flex;align-items:center;gap:4px"><input type="number" data-out="len" data-orig="${o.len}" value="${o.len}" min="1" title="nombre de pixels sur ce câble"><button class="rowbtn" data-calc="1" title="calculer : LEDs par mètre × longueur">📏</button><button class="rowbtn${locating && locating.ip === n.ip && locating.index === i ? ' primary' : ''}" data-locate="1" title="allumer le dernier pixel de cette sortie en blanc (le reste en bleu léger) sur le vrai node, pour compter en changeant Pixels et en regardant où ça s'arrête sur le ruban">📍</button></span></td>
        <td><label class="chip"><input type="checkbox" data-out="rev" data-orig="${r.rev ? 1 : 0}" ${r.rev ? 'checked' : ''}> inversée</label></td>
        <td class="adv"><input type="number" data-out="skip" data-orig="${r.skip || 0}" value="${r.skip || 0}" min="0" title="Skip first LEDs : nombre de LEDs en tête de câble à ignorer (câblées mais non pilotées, ex. avant un connecteur)"></td>
        <td class="adv"><label class="chip"><input type="checkbox" data-out="ref" data-orig="${r.ref ? 1 : 0}" ${r.ref ? 'checked' : ''} title="Off Refresh : force un rafraîchissement du signal même à l'extinction (certaines LEDs/récepteurs en ont besoin pour ne pas clignoter ou perdre leur dernière couleur)"> off refresh</label></td>
        <td class="fixcell">${fixField(o)}</td>
        <td class="oc-addr"><span class="addr"><b>${esc(o.from || '')}</b> → <b>${esc(o.to || '')}</b></span> <span class="straddle">${uniTxt}</span></td></tr>`;
    };
    const groupTable = gc => {
      const head = `<thead><tr><th title="sélection pour l'édition en lot"></th><th title="chaînage : ⛓ pixels collés à la sortie du dessus (une seule fixture), ⊘ sortie seule"></th><th>Node</th><th>Sortie</th><th title="profil de LED : type + ordre + pixels mémorisés sous un nom">Profil</th><th class="adv">Pin</th><th>Type</th><th class="adv" title="budget de courant de cette sortie — n_agit que si « par sortie » est coché sur le node">Limite mA</th><th class="adv" title="Auto Brightness Limiter : mA par pixel à pleine luminosité, pour estimer/limiter la consommation">mA/pixel</th><th>Ordre</th><th title="échange du canal blanc (WLED : Swap) — proposé seulement sur les types numériques à canal blanc">Swap W</th><th title="index du premier pixel dans le node (0 = premier)">Départ</th><th title="pixels sur ce câble ; 📏 = calculateur, 📍 = repérer le dernier pixel">Pixels</th><th title="sens de parcours du ruban">Inv.</th><th class="adv">Skip</th><th class="adv">Off Refresh</th><th title="numéro de fixture à la console. Plusieurs sorties, même sur des nodes différents, peuvent partager un numéro : elles forment alors une seule fixture. La pastille de couleur est dérivée du numéro, pour les repérer d'un coup d'œil.">Fixture</th><th title="univers.canal du premier et du dernier pixel : ce qu'il faut patcher à la console (recalculé en direct)">Adresse console (de → à)</th></tr></thead>`;
      const NCOL = 17; // colonnes après la cellule Node
      const body = gc.nodes.map(n => {
        const pl = n.plan; const rec = nodeRec(n.ip); const rawIns = (rec && rec.cfg && rec.cfg.hw && rec.cfg.hw.led && rec.cfg.hw.led.ins) || [];
        if (!pl.multi) return `<tr data-node="${esc(n.ip)}"><td class="pickcell"></td><td class="chaincell"></td>${nodeCell(n, 1)}<td colspan="${NCOL - 1}" class="muted">mode ${esc(modeName(pl.mode))} : ${esc(pl.note)}</td></tr>`;
        const outs = pl.outputs; const span = Math.max(1, outs.length);
        if (!outs.length) return `<tr data-node="${esc(n.ip)}"><td class="pickcell"></td><td class="chaincell"></td>${nodeCell(n, 1)}<td colspan="${NCOL - 1}" class="muted">aucune sortie déclarée</td></tr>`;
        return outs.map((o, i) => outRow(n, o, rawIns[i] || {}, i, i === 0, span)).join('');
      }).join('');
      const ns = gc.nodes.filter(n => n.plan.multi);
      const minU = ns.length ? Math.min(...ns.map(n => n.plan.firstUni)) : null, maxU = ns.length ? Math.max(...ns.map(n => n.plan.lastUni)) : null;
      const total = ns.reduce((a, n) => a + n.plan.total, 0), conf = ns.some(inConflictOf);
      const gi = gCards.indexOf(gc);
      const ap = ns.length ? `<button class="rowbtn" data-autopatch="${gi}" title="recalcule les départs, les univers et les adresses de ce groupe — et de lui seul. Un récapitulatif node par node s'affiche d'abord : rien n'est modifié tant que tu n'as pas choisi, et rien n'est écrit tant que tu n'as pas cliqué Enregistrer.">⚡ Patcher…</button>` : '';
      const advBtn = `<button class="rowbtn" data-adv="${gi}" title="afficher / masquer les colonnes de réglage rares : pin, mA/LED, skip, off refresh">⚙</button>`;
      // vraie case (et pas un bouton) : elle montre aussi l'état du groupe —
      // cochée = tout, trait = une partie, vide = rien
      const pickBtn = `<label class="chip gpick" title="cocher / décocher toutes les sorties de ce groupe, pour les régler d'un coup"><input type="checkbox" data-pickall="${gi}"> tout</label>`;
      const summary = `<summary><span class="caret">▸</span> ${gc.g ? `<b>${esc(gc.g)}</b> <span class="muted">${gc.nodes.length} node${gc.nodes.length > 1 ? 's' : ''}${ns.length ? ` · univers ${minU}–${maxU} · ${total} px` : ''}</span>` : `<span class="muted">node solo${ns.length ? ` · univers ${minU}–${maxU} · ${total} px` : ''}</span>`} <span class="st-bad gcf" data-gi="${gi}" ${conf ? '' : 'hidden'}>✗ conflit</span> ${ap}${pickBtn}${advBtn}</summary>`;
      return `<div class="gtable"><details data-key="dmx:${esc(gc.g || ('solo:' + gc.nodes[0].ip))}" open>${summary}<div style="overflow-x:auto"><table class="outs noadv" data-gi="${gi}">${head}<tbody>${body}</tbody></table></div></details></div>`;
    };
    const cards = gCards.map(groupTable).join('');
    const kept = keepDetails(p);
    p.innerHTML = `<h2>Sorties / DMX <span class="muted" style="text-transform:none;letter-spacing:0" title="En mode Multi, WLED enchaîne les pixels sur des univers consécutifs (170 RGB ou 128 RGBW par univers) à partir de l'univers et de l'adresse de départ du node. L'univers d'une sortie découle donc de la longueur des sorties précédentes. Les sorties existent déjà sur les boîtiers : ici on règle ce qui est branché dessus (profil ou type, ordre, pixels) et les réglages DMX du node. ⛓ chaîne une sortie à celle du dessus (pixels collés = une seule fixture à la console), ⊘ la laisse seule. ⚡ Patcher recalcule un groupe — et lui seul — après t'avoir montré ce qui change. ⚙ déplie les colonnes rares. Un seul bouton enregistre tout ce qui a changé.">ⓘ</span><span class="spacer"></span><button id="dmxSave" class="primary" disabled title="écrit sur chaque node modifié : ses sorties (bloc complet, sauvegarde prise avant) et ses réglages DMX (via la mise en attente et Déployer)">Enregistrer les modifications</button></h2>
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
    // valeurs d'une ligne, telles qu'affichées (pas celles du dernier relevé)
    const rowVals = tr => ({ start: Number(tr.querySelector('[data-out=start]').value), len: Number(tr.querySelector('[data-out=len]').value), used: (() => { const ig = tr.querySelector('input[data-ignore]'); return !ig || ig.checked; })() });
    const recompute = ip => { const pl = livePlan(ip); if (!pl || !pl.multi) return; const loc = locateFn(pl); const rows = rowsOf(ip);
      rows.forEach((tr, i) => {
        const { start, len } = rowVals(tr);
        // ⛓ l'état de chaînage suit les valeurs à l'écran, pas le dernier relevé
        const prev = i > 0 ? rowVals(rows[i - 1]) : null;
        const linked = !!(prev && prev.len > 0 && len > 0 && start === prev.start + prev.len);
        const cell = tr.querySelector('td.chaincell');
        if (cell && i > 0) { cell.classList.toggle('linked', linked); cell.innerHTML = `<span class="chainmark">${linked ? '⛓' : '⊘'}</span>`; }
        tr.classList.toggle('chained', linked);
        if (!(len > 0) || !(start >= 0)) return;
        const a = loc(start), b = loc(start + len - 1);
        tr.querySelector('.addr').innerHTML = `<b>${a.u}.${a.ch}</b> → <b>${b.u}.${b.ch + pl.chPerPx - 1}</b>`;
        tr.querySelector('.straddle').innerHTML = b.u !== a.u ? `<span class="${startsUniverse(start, pl) ? 'muted' : 'st-warn'}">${b.u - a.u + 1} univers</span>` : '<span class="st-ok">1 univers</span>';
      });
      renderAbl(ip, rows);
    };
    // Ce que la limite de courant autorise réellement, dit en clair sous le
    // champ. L'arithmétique est celle du firmware (bus_manager.cpp:1483-1524,
    // estimateCurrent l.196) : l'ESP se sert de 120 mA en premier, chaque LED
    // compte 1 mA de veille en plus de sa couleur, et si le reste ne couvre pas
    // 1 mA par pixel la luminosité est clouée au minimum. Rien de tout ça n'est
    // visible dans WLED, et c'est ce qui fait qu'une flotte tourne bridée à
    // 43 % sans que personne ne le sache.
    const MA_ESP = 120;
    function renderAbl(ip, rows) {
      const cell = p.querySelector(`[data-nodecell="${CSS.escape(ip)}"]`);
      const box = cell && cell.querySelector('[data-abl]'); if (!box) return;
      const cap = Number(cell.querySelector('[data-nb=maxpwr]').value);
      let px = 0, worst = 0;
      for (const tr of rows) {
        const { len, used } = rowVals(tr); if (!used || !(len > 0)) continue;
        const ma = Number((tr.querySelector('[data-out=ledma]') || {}).value);
        px += len;
        worst += len * ((Number.isFinite(ma) ? ma : 55) + 1);   // +1 mA de veille par LED
      }
      // en régime « par sortie », le budget global vaut 0 par construction :
      // c'est chaque sortie qui porte le sien, et l'ESP est réparti entre elles
      const ppl = cell.querySelector('[data-ppl]');
      if (ppl && ppl.checked) {
        const actives = rows.filter(tr => { const v = rowVals(tr); return v.used && v.len > 0 && Number(tr.querySelector('[data-out=omax]').value) > 0; });
        const part = MA_ESP / Math.max(1, actives.length);
        let pire = 1;
        for (const tr of actives) {
          const { len } = rowVals(tr);
          const ma = Number(tr.querySelector('[data-out=ledma]').value);
          const w = len * ((Number.isFinite(ma) ? ma : 55) + 1);
          const b = Math.max(len, Number(tr.querySelector('[data-out=omax]').value) - part);
          pire = Math.min(pire, b / w);
        }
        if (!actives.length) { box.className = 'ablnote st-warn'; box.textContent = 'par sortie, mais aucune limite renseignée : rien ne bride'; return; }
        box.className = `ablnote ${pire >= 0.9 ? 'muted' : pire >= 0.5 ? 'st-warn' : 'st-bad'}`;
        box.textContent = `par sortie · la plus bridée à ${Math.round(Math.min(1, pire) * 100)} %`;
        box.title = `${actives.length} sortie(s) budgétée(s). Les 120 mA de l'ESP sont divisés entre elles (${Math.round(part)} mA chacune).`;
        return;
      }
      if (!cap) { box.className = 'ablnote st-warn'; box.textContent = 'aucune limite : l\'ABL ne bride rien'; return; }
      if (!px) { box.textContent = ''; return; }
      const utile = cap - MA_ESP;
      if (utile <= px) { box.className = 'ablnote st-bad'; box.textContent = `budget utile ${utile} mA ≤ ${px} px : luminosité clouée au minimum`; return; }
      const part = Math.min(1, utile / worst);
      box.className = `ablnote ${part >= 0.9 ? 'muted' : part >= 0.5 ? 'st-warn' : 'st-bad'}`;
      box.textContent = `blanc plein atteignable à ${Math.round(part * 100)} %`;
      box.title = `Pire cas ${worst} mA (${px} px). Budget ${cap} mA moins 120 mA pour l'ESP = ${utile} mA.`
        + (part < 1 ? ` L'ABL bride donc la luminosité à ${Math.round(part * 100)} % sur du blanc plein.` : '');
    }
    // ── Basculer de régime ────────────────────────────────────────────────
    // Cocher « par sortie » revient à mettre la limite globale à 0 : c'est ce
    // qui bascule le firmware, et c'est exactement ce que fait la case de WLED
    // (settings_leds.htm:164). Décocher rétablit un budget global et
    // redistribue au prorata des pixels, comme WLED le fait de son côté
    // (:204) — sinon les valeurs par sortie resteraient là à ne rien faire, et
    // c'est précisément ce qu'on trouve aujourd'hui dans les configs.
    p.querySelectorAll('[data-ppl]').forEach(cb => cb.onchange = () => {
      const ip = cb.closest('[data-nodecell]').dataset.nodecell;
      const glob = p.querySelector(`[data-nodecell="${CSS.escape(ip)}"] [data-nb=maxpwr]`);
      const rows = rowsOf(ip);
      const budget = Number(glob.dataset.orig) || 0;
      if (cb.checked) {
        // ce qu'on répartit, c'est le budget d'avant, moins ce que l'ESP prend
        const total = rows.reduce((a, tr) => a + (rowVals(tr).len || 0), 0);
        const utile = Math.max(0, budget - MA_ESP);
        rows.forEach(tr => {
          const el = tr.querySelector('[data-out=omax]'); const len = rowVals(tr).len || 0;
          if (Number(el.value) === 0 && total) el.value = String(Math.round(utile * len / total));
        });
        glob.value = '0';
      } else {
        glob.value = String(budget || 850);
        rows.forEach(tr => { tr.querySelector('[data-out=omax]').value = '0'; });
      }
      glob.disabled = cb.checked;
      recompute(ip); refreshDirty();
    });
    // au premier rendu aussi : sinon la note n'apparaît qu'après une première
    // modification, alors que c'est justement à l'ouverture qu'on veut voir
    // qu'un node tourne bridé
    for (const n of d.nodes) if (n.plan && n.plan.multi) renderAbl(n.ip, rowsOf(n.ip));
    // dirty tracking: anything that differs from its data-orig enables the one Save button
    const changedNodes = () => {
      const set = new Set();
      p.querySelectorAll('[data-out][data-orig],[data-nb][data-orig],[data-fix][data-orig],[data-ppl][data-orig]').forEach(el => {
        const cur = el.type === 'checkbox' ? (el.checked ? '1' : '0') : String(el.value);
        if (cur !== String(el.dataset.orig)) set.add(el.closest('tr').dataset.node || (el.closest('[data-nodecell]') || {}).dataset.nodecell);
      });
      return [...set].filter(Boolean);
    };
    // canaux qu'un node réserve vraiment, d'après les champs à l'écran (mêmes règles que
    // dmx.js côté serveur : une sortie décochée ne réserve rien, et le découpage suit la
    // capacité réelle du premier univers)
    const liveOccupancy = ip => {
      const pl = livePlan(ip); if (!pl || !pl.multi) return [];
      const loc = locateFn(pl), out = [];
      for (const tr of rowsOf(ip)) {
        const { start, len, used } = rowVals(tr);
        if (!used || !(len > 0) || !(start >= 0)) continue;
        const a = loc(start), b = loc(start + len - 1);
        for (let u = a.u; u <= b.u; u++) {
          const from = u === a.u ? a.ch : 1;
          // dernier pixel de cette sortie qui tombe dans l'univers u
          const to = u === b.u ? b.ch + pl.chPerPx - 1 : (() => { let px = start + len - 1; while (px > start && loc(px).u > u) px--; return loc(px).ch + pl.chPerPx - 1; })();
          out.push({ u, from, to });
        }
      }
      return out;
    };
    const liveConflicts = () => {
      const byUni = new Map();
      for (const n of d.nodes) for (const iv of liveOccupancy(n.ip)) {
        if (!byUni.has(iv.u)) byUni.set(iv.u, []);
        byUni.get(iv.u).push({ node: n.name || n.ip, from: iv.from, to: iv.to });
      }
      const out = [];
      for (const [u, list] of byUni) {
        const sorted = [...list].sort((a, b) => a.from - b.from || a.to - b.to);
        for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
          const a = sorted[i], b = sorted[j];
          if (a.node === b.node) continue;
          if (b.from > a.to) break;
          const from = b.from, to = Math.min(a.to, b.to);
          const seen = out.find(c => c.universe === u && c.nodes.includes(a.node) && c.nodes.includes(b.node));
          if (seen) { seen.from = Math.min(seen.from, from); seen.to = Math.max(seen.to, to); }
          else out.push({ universe: u, from, to, nodes: [a.node, b.node] });
        }
      }
      return out.sort((a, b) => a.universe - b.universe || a.from - b.from);
    };
    const renderConflicts = () => {
      const list = liveConflicts(); const box = $('#dmxConflicts'); if (box) { box.innerHTML = conflictsHtml(list); box.style.borderColor = list.length ? 'var(--bad)' : ''; }
      const bad = new Set(list.flatMap(c => c.nodes));
      p.querySelectorAll('[data-nodecell]').forEach(c => { const n = d.nodes.find(x => x.ip === c.dataset.nodecell); const el = c.querySelector('.cf'); if (el) el.hidden = !(n && bad.has(n.name || n.ip)); });
      p.querySelectorAll('.gcf').forEach(el => { const gc = gCards[Number(el.dataset.gi)]; el.hidden = !gc.nodes.some(n => bad.has(n.name || n.ip)); });
    };
    const refreshDirty = () => { const n = changedNodes().length; const b = $('#dmxSave'); if (b) { b.disabled = !n; b.textContent = n ? `Enregistrer les modifications (${n} node${n > 1 ? 's' : ''})` : 'Enregistrer les modifications'; } };
    // Allonger une sortie doit pousser celles qui lui sont chaînées : sinon la chaîne se
    // brise en silence et les deux sorties finissent par se recouvrir. On relit la classe
    // .chained AVANT que recompute() ne la recalcule, donc l'état d'avant l'édition.
    const pushChained = tr => {
      const rows = rowsOf(tr.dataset.node), i = rows.indexOf(tr);
      if (i < 0) return;
      let boundary = rowVals(tr).start + rowVals(tr).len;
      for (let j = i + 1; j < rows.length; j++) {
        if (!rows[j].classList.contains('chained')) break;
        const el = rows[j].querySelector('[data-out=start]');
        if (Number(el.value) !== boundary) el.value = String(boundary); // sans redispatch : on descend nous-mêmes
        boundary += rowVals(rows[j]).len;
      }
    };
    // ── édition en lot : la valeur saisie sur une ligne cochée part sur toutes les autres
    // `start` ne se propage JAMAIS (chaque sortie a le sien : c'est le rôle de ⚡ Patcher),
    // ni dmxuni / dmxaddr côté node, pour la même raison.
    const BULK_OUT = ['type', 'ledma', 'omax', 'order', 'wswap', 'len', 'rev', 'skip', 'ref'];
    const BULK_NB = ['dmxmode', 'maxpwr'];
    const pickedRows = () => [...p.querySelectorAll('tr[data-outrow]')].filter(tr => picks.has(`${tr.dataset.node}|${tr.dataset.outrow}`));
    const propagate = (el, tr) => {
      const field = el.dataset.out, nb = el.dataset.nb;
      if (!picks.size) return 0;
      const isCb = el.type === 'checkbox';
      const val = isCb ? el.checked : el.value;
      let n = 0;
      if (field && BULK_OUT.includes(field) && picks.has(`${tr.dataset.node}|${tr.dataset.outrow}`)) {
        for (const other of pickedRows()) {
          if (other === tr) continue;
          const t = other.querySelector(`[data-out=${field}]`); if (!t) continue;
          if (isCb) { if (t.checked === val) continue; t.checked = val; } else { if (String(t.value) === String(val)) continue; t.value = String(val); }
          if (field === 'len') pushChained(other);
          n++;
        }
      } else if (nb && BULK_NB.includes(nb)) {
        const ips = new Set(pickedRows().map(x => x.dataset.node));
        const me = (el.closest('[data-nodecell]') || {}).dataset;
        if (!me || !ips.has(me.nodecell)) return 0;
        for (const ip of ips) {
          if (ip === me.nodecell) continue;
          const t = p.querySelector(`[data-nodecell="${CSS.escape(ip)}"] [data-nb="${nb}"]`); if (!t) continue;
          if (String(t.value) === String(val)) continue;
          t.value = String(val); n++;
        }
      }
      if (n) { for (const ip of new Set(pickedRows().map(x => x.dataset.node))) recompute(ip); toast(`appliqué à ${n + 1} ligne(s)`); }
      return n;
    };
    p.querySelectorAll('[data-out],[data-nb]').forEach(el => { el.oninput = el.onchange = () => {
      const tr = el.closest('tr');
      if (tr && tr.dataset.node && (el.dataset.out === 'len' || el.dataset.out === 'start')) pushChained(tr);
      if (tr) propagate(el, tr);
      if (tr && tr.dataset.node) recompute(tr.dataset.node);
      refreshDirty(); renderConflicts();
      if (tr && (el.dataset.out === 'len' || el.dataset.out === 'rev')) sendLocateUpdate(tr);
    }; });
    // ── Fixtures ────────────────────────────────────────────────────────────
    const allFixRows = () => [...p.querySelectorAll('tr[data-outrow]')];
    const fixOf = tr => { const el = tr.querySelector('[data-fix]'); return el && el.value !== '' ? Number(el.value) : null; };
    const paintFix = tr => {
      const dot = tr.querySelector('.fixdot'); if (!dot) return;
      const f = fixOf(tr), inst = Number(tr.querySelector('[data-inst]').value) || 0;
      dot.classList.toggle('none', f === null);
      dot.style.background = f === null ? '' : fixColor(f);
      dot.title = f === null ? 'aucune fixture : cette sortie n\'est pas encore déclarée à la console' : `fixture ${f}, instance ${inst}`;
    };
    const nextFixture = () => { const used = new Set(allFixRows().map(fixOf).filter(f => f !== null)); let n = 1; while (used.has(n)) n++; return n; };
    p.querySelectorAll('[data-fix]').forEach(el => el.oninput = () => {
      const tr = el.closest('tr');
      // une sortie qu'on sort d'une fixture repart à l'instance 0 : garder un
      // décalage hérité d'un assemblage auquel elle n'appartient plus la ferait
      // patcher à côté
      if (el.value === '') tr.querySelector('[data-inst]').value = '0';
      paintFix(tr); refreshDirty();
    });
    // Assignation en lot : les lignes cochées deviennent UNE fixture, dans leur
    // ordre d'affichage, chaque membre reprenant les pixels du précédent. C'est
    // le seul endroit où les instances se calculent — à la main, on ne saurait
    // pas dire ce que « 36 » veut dire sans compter les autres membres.
    const assignFixture = async () => {
      const rows = pickedRows(); if (!rows.length) return;
      const proposed = nextFixture();
      const cur = [...new Set(rows.map(fixOf).filter(f => f !== null))];
      const nodes = new Set(rows.map(r => r.dataset.node)).size;
      const v = await promptBox(`Numéro de fixture pour ${rows.length} sortie(s)${nodes > 1 ? ` sur ${nodes} nodes` : ''} ?`,
        String(cur.length === 1 ? cur[0] : proposed),
        `Les sorties cochées formeront une seule fixture, dans l'ordre du tableau : la 1re à l'instance 0, les suivantes décalées de la longueur des précédentes. Laisser vide pour les retirer de toute fixture.${cur.length ? `\nActuellement : fixture ${cur.join(', ')}.` : ''}`);
      if (v === null) return;
      const num = String(v).trim() === '' ? null : Number(v);
      if (num !== null && !(num >= 1 && num <= 9999)) return toast('numéro de fixture invalide', true);
      let inst = 0;
      for (const tr of rows) {
        tr.querySelector('[data-fix]').value = num === null ? '' : String(num);
        tr.querySelector('[data-inst]').value = String(num === null ? 0 : inst);
        inst += Number(tr.querySelector('[data-out=len]').value) || 0;
        paintFix(tr);
      }
      refreshDirty();
      toast(num === null ? `${rows.length} sortie(s) retirée(s) de leur fixture` : `fixture ${num} : ${rows.length} sortie(s), ${inst} pixels`);
    };

    // cases de sélection : ligne par ligne, et ☑ par groupe
    const refreshPickBar = () => {
      const rows = pickedRows();
      const bar = $('#pickbar');
      if (!rows.length) { if (bar) bar.remove(); return; }
      const nodes = new Set(rows.map(r => r.dataset.node)).size;
      const html = `<b>☑ ${rows.length} sortie${rows.length > 1 ? 's' : ''}</b> <span class="muted">sur ${nodes} node${nodes > 1 ? 's' : ''} · modifier un champ sur une ligne cochée l'applique à toutes</span><span class="locgrp"><button id="pickFix" title="donner un même numéro de fixture à toutes les lignes cochées : elles formeront une seule fixture à la console, dans l'ordre du tableau, y compris à travers plusieurs nodes">Fixture…</button><button id="pickClear">Tout décocher</button></span>`;
      if (bar) bar.innerHTML = html;
      else { const b2 = document.createElement('div'); b2.id = 'pickbar'; b2.className = 'locbar'; b2.style.bottom = locating ? '62px' : '10px'; b2.innerHTML = html; document.body.appendChild(b2); }
      $('#pickFix').onclick = assignFixture;
      $('#pickClear').onclick = () => { picks.clear(); p.querySelectorAll('input[data-pick]').forEach(c => { c.checked = false; c.closest('tr').classList.remove('selected'); }); syncGroupPicks(); refreshPickBar(); };
    };
    const groupBoxes = gi => { const ips = new Set(gCards[gi].nodes.map(n => n.ip)); return [...p.querySelectorAll('input[data-pick]')].filter(c => ips.has(c.dataset.pick.slice(0, c.dataset.pick.lastIndexOf('|')))); };
    // la case du groupe reflète ses lignes : cochée si toutes le sont, indéterminée si une partie
    const syncGroupPicks = () => p.querySelectorAll('input[data-pickall]').forEach(cb => {
      const boxes = groupBoxes(Number(cb.dataset.pickall));
      const n = boxes.filter(c => c.checked).length;
      cb.checked = boxes.length > 0 && n === boxes.length;
      cb.indeterminate = n > 0 && n < boxes.length;
    });
    p.querySelectorAll('input[data-pick]').forEach(cb => cb.onchange = () => {
      cb.checked ? picks.add(cb.dataset.pick) : picks.delete(cb.dataset.pick);
      cb.closest('tr').classList.toggle('selected', cb.checked);
      syncGroupPicks(); refreshPickBar();
    });
    p.querySelectorAll('input[data-pickall]').forEach(cb => {
      // dans un <summary> : empêcher le repli du groupe, sans preventDefault qui
      // annulerait la coche elle-même
      cb.onclick = e => e.stopPropagation();
      cb.onchange = e => {
        e.stopPropagation();
        const on = cb.checked;
        groupBoxes(Number(cb.dataset.pickall)).forEach(c => {
          c.checked = on; on ? picks.add(c.dataset.pick) : picks.delete(c.dataset.pick);
          c.closest('tr').classList.toggle('selected', on);
        });
        syncGroupPicks(); refreshPickBar();
      };
    });
    syncGroupPicks(); refreshPickBar();
    // "comptée" checkboxes: Fleet-only, saved at once, conflicts recomputed
    p.querySelectorAll('input[data-ignore]').forEach(cb => cb.onchange = async () => {
      const ip = cb.closest('tr').dataset.node;
      // par POSITION : ⚡ Patcher change les départs, un drapeau par index de départ sautait de ligne
      const indexes = rowsOf(ip).map(tr => tr.querySelector('input[data-ignore]')).filter(x => !x.checked).map(x => Number(x.dataset.ignore));
      try { const r = await post(`/api/node/${encodeURIComponent(ip)}/outputs-ignore`, { indexes }); toast(r.queued ? 'node hors ligne : sera proposé au retour (⏳ sur la ligne)' : (indexes.length ? `${indexes.length} sortie(s) non utilisée(s), mémorisé sur le node` : 'toutes les sorties utilisées')); }
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
    // 📍 repérer : le serveur porte la sortie à sa longueur d'exploration une fois, puis
    // ne fait plus que recolorer trois zones (en dessous / repère / au-delà). Ajuster
    // Pixels — au clavier ou avec les ± de la barre — déplace le repère en direct, sans
    // réécrire la config du node. Tout est restauré à l'identique à l'arrêt ; un 2e clic
    // sur 📍 arrête aussi.
    let locateTimer = null;
    const locateRow = () => locating && p.querySelector(`tr[data-node="${CSS.escape(locating.ip)}"][data-outrow="${locating.index}"]`);
    const sendLocateUpdate = tr => {
      if (!locating || locating.ip !== tr.dataset.node || locating.index !== Number(tr.dataset.outrow)) return;
      const len = Number(tr.querySelector('[data-out=len]').value), rev = tr.querySelector('[data-out=rev]').checked;
      if (!(len > 0)) return;
      if (locBar) locBar.setLen(len);
      clearTimeout(locateTimer);
      locateTimer = setTimeout(() => {
        post(`/api/node/${encodeURIComponent(locating.ip)}/locate-pixel`, { index: locating.index, len, rev, ...locOpts })
          .then(r => { if (locBar && r && r.probe) locBar.setProbe(r.probe); })
          .catch(e => toast(e.message, true));
      }, 400);
    };
    // les ± de la barre écrivent dans le champ Pixels et dispatchent un input : tout le
    // reste (chaînage, adresse console, bouton Enregistrer, envoi) suit sans code en double
    const locStep = (delta, absolute) => {
      const tr = locateRow(); if (!tr) return;
      const el = tr.querySelector('[data-out=len]');
      const max = (locOpts.probe && locOpts.probe > 0) ? locOpts.probe : 4096;
      const next = Math.max(1, Math.min(max, absolute !== undefined ? absolute : Number(el.value) + delta));
      if (Number(el.value) === next) return;
      el.value = String(next); el.dispatchEvent(new Event('input'));
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
      const len = Number(tr.querySelector('[data-out=len]').value), rev = tr.querySelector('[data-out=rev]').checked;
      if (!(len > 0)) { toast('pixels invalide', true); return; }
      locating = { ip, index };
      b.classList.add('primary');
      const n = d.nodes.find(x => x.ip === ip);
      locBar = openLocBar((n && n.name) || ip, index + 1,
        (delta, abs) => locStep(delta, abs),
        () => { const t = locateRow(); if (t) sendLocateUpdate(t); },
        () => { b.classList.remove('primary'); stopLocating(); });
      locBar.setLen(len);
      try {
        const r = await post(`/api/node/${encodeURIComponent(ip)}/locate-pixel`, { index, len, rev, ...locOpts });
        if (r && r.probe) { locBar.setProbe(r.probe); locOpts.probe = r.probe; setLocPref('Probe', r.probe); }
        toast('repérage : le ruban entier est piloté — en dessous du repère, le repère, et au-delà en 3ᵉ couleur. Ajuster avec ± ou le champ Pixels.', false, 5000);
      } catch (e) { toast(e.message, true); locating = null; b.classList.remove('primary'); closeLocBar(); locBar = null; }
    });
    // ⚙ colonnes avancées (pin, mA/LED, skip, off refresh) : repliées par défaut
    p.querySelectorAll('button[data-adv]').forEach(b => b.onclick = e => {
      e.preventDefault(); e.stopPropagation(); // dans un <summary> : ne pas replier le groupe
      const t = p.querySelector(`table.outs[data-gi="${b.dataset.adv}"]`); if (t) t.classList.toggle('noadv');
    });
    // ⛓ chaîner / détacher une sortie de celle du dessus. Chaîner = ses pixels reprennent
    // juste après (une seule fixture continue à la console) ; détacher = elle repart sur un
    // début d'univers. Rien n'est écrit : ça ne fait que poser le départ, comme à la main.
    p.querySelectorAll('td.chaincell[data-chain]').forEach(td => td.onclick = () => {
      const i = Number(td.dataset.chain); if (!i) return;
      const tr = td.closest('tr'), ip = tr.dataset.node, rows = rowsOf(ip);
      const pl = livePlan(ip); if (!pl || !pl.multi) return;
      const prev = rowVals(rows[i - 1]); if (!(prev.len > 0)) return toast('la sortie du dessus n\'a pas de pixels', true);
      const cur = rowVals(tr);
      const glued = prev.start + prev.len;
      let next;
      if (cur.start === glued) { // détacher : au prochain début d'univers libre après la précédente
        const f = firstUniPxOf(pl);
        next = glued <= f ? f : f + Math.ceil((glued - f) / pl.pxPerUni) * pl.pxPerUni;
        if (next === glued) next = glued + pl.pxPerUni; // déjà pile dessus : on saute un univers
      } else next = glued;
      const el = tr.querySelector('[data-out=start]'); el.value = String(next); el.dispatchEvent(new Event('input'));
      // les suivantes qui étaient collées à celle-ci suivent le mouvement
      let boundary = cur.start + cur.len, delta = next - cur.start;
      for (let j = i + 1; j < rows.length; j++) {
        const v = rowVals(rows[j]); if (v.start !== boundary) break;
        const e2 = rows[j].querySelector('[data-out=start]'); e2.value = String(v.start + delta); e2.dispatchEvent(new Event('input'));
        boundary = v.start + v.len;
      }
    });
    // ⚡ Patcher : remplace ⚡ Autopatch ET ≡ univers entiers. Ne touche QUE les nodes de sa
    // carte, montre d'abord ce qui va changer node par node, et n'écrit jamais rien
    // directement — c'est « Enregistrer les modifications » qui décide.
    p.querySelectorAll('button[data-autopatch]').forEach(b => b.onclick = async e => {
      e.preventDefault(); e.stopPropagation(); // dans un <summary>
      const gc = gCards[Number(b.dataset.autopatch)];
      const nodesG = gc.nodes.filter(n => p.querySelector(`[data-nodecell="${CSS.escape(n.ip)}"]`) && rowsOf(n.ip).length);
      if (!nodesG.length) return;
      // univers occupés par le RESTE de la flotte : l'ancien autopatch avançait à l'aveugle et
      // pouvait poser le groupe sur les univers d'un autre, qui s'allumaient alors en conflit
      const mine = new Set(nodesG.map(n => n.ip));
      const busy = new Map(); // univers -> dernier canal pris par les autres
      for (const n of d.nodes) { if (mine.has(n.ip)) continue; for (const iv of liveOccupancy(n.ip)) busy.set(iv.u, Math.max(busy.get(iv.u) || 0, iv.to)); }

      const r = b.getBoundingClientRect();
      const strat = await new Promise(resolve => {
        let picked = null;
        menuBox(r.left, r.bottom + 2, [
          { label: '⚡ Serré — tasser au canal près', help: 'plusieurs nodes courts dans un même univers (4 boules de 36 px), sorties chaînées conservées', act: () => { picked = 'tight'; resolve('tight'); } },
          { label: '≡ Une sortie = un univers', help: 'chaque sortie démarre sur un univers neuf : confortable pour les grandes lianes', act: () => { picked = 'uni'; resolve('uni'); } },
        ]);
        setTimeout(() => { const obs = setInterval(() => { if (!document.querySelector('.pop.menu')) { clearInterval(obs); if (!picked) resolve(null); } }, 120); }, 0);
      });
      if (!strat) return;

      // Pose des pixels d'un node : une sortie chaînée reprend juste après la précédente,
      // une sortie seule repart sur un début d'univers (qui dépend de l'adresse du node,
      // d'où le paramètre addr). Les sorties décochées sont parquées à la fin : elles ne
      // pilotent rien et ne doivent pas décaler les autres.
      const layout = (rowsN, cp, addr) => {
        const per = Math.floor(512 / cp), firstCap = Math.floor((512 - (addr - 1)) / cp);
        const nextBoundary = px => px <= firstCap ? firstCap : firstCap + Math.ceil((px - firstCap) / per) * per;
        const used = rowsN.filter(tr => rowVals(tr).used), unused = rowsN.filter(tr => !rowVals(tr).used);
        const starts = new Map(); let px = 0;
        for (let k = 0; k < used.length; k++) {
          const tr = used[k], v = rowVals(tr);
          const prev = k > 0 ? rowVals(used[k - 1]) : null;
          const chained = strat === 'tight' && prev && v.start === prev.start + prev.len;
          if (k > 0 && !chained) px = nextBoundary(px); // sortie seule (ou stratégie « un univers »)
          starts.set(tr, px); px += v.len || 0;
        }
        let parked = nextBoundary(px);
        for (const tr of unused) { starts.set(tr, parked); parked += Math.ceil((rowVals(tr).len || 0) / per) * per; }
        return { starts, px };
      };
      // Cherche la première place libre à partir du curseur, en sautant ce que les AUTRES
      // nodes occupent déjà — l'ancien autopatch avançait sans regarder et pouvait se poser
      // sur eux. busy = univers -> dernier canal pris.
      const place = (cursor, px, cp) => {
        const per = Math.floor(512 / cp);
        for (let guard = 0; guard < 2000; guard++) {
          if (busy.has(cursor.u) && cursor.ch <= busy.get(cursor.u)) cursor.ch = busy.get(cursor.u) + 1;
          if (cursor.ch + cp - 1 > 512) { cursor.u++; cursor.ch = 1; continue; }
          const firstCap = Math.floor((512 - (cursor.ch - 1)) / cp);
          const extraU = Math.max(0, Math.ceil((px - firstCap) / per));
          let clash = false;
          for (let k = 1; k <= extraU; k++) if (busy.has(cursor.u + k)) { clash = true; break; }
          if (clash) { cursor.u++; cursor.ch = 1; continue; } // le débordement tomberait sur un autre node
          const placed = { u: cursor.u, addr: cursor.ch };
          if (extraU === 0) { cursor.ch += px * cp; }
          else { const lastPx = px - firstCap - (extraU - 1) * per; cursor.u += extraU; cursor.ch = 1 + lastPx * cp; }
          if (cursor.ch + cp - 1 > 512) { cursor.u++; cursor.ch = 1; }
          return placed;
        }
        return { u: cursor.u, addr: 1 };
      };

      // simulation : rien n'est posé dans les champs avant confirmation
      const sim = [];
      let cursor = null;
      for (const n of nodesG) {
        const cell = p.querySelector(`[data-nodecell="${CSS.escape(n.ip)}"]`), rowsN = rowsOf(n.ip);
        const modeEl = cell.querySelector('[data-nb=dmxmode]');
        let mode = Number(modeEl.value);
        const anyRgbw = rowsN.some(tr => rgbwTypes.includes(Number(tr.querySelector('[data-out=type]').value)));
        const wantMode = anyRgbw ? 6 : (mode === 5 ? 5 : 4);
        const modeChanged = !CPX[mode] || (anyRgbw && mode !== 6) || (!anyRgbw && mode === 6);
        if (modeChanged) mode = wantMode;
        const cp = CPX[mode];
        const uniEl = cell.querySelector('[data-nb=dmxuni]'), addrEl = cell.querySelector('[data-nb=dmxaddr]');
        if (!cursor) cursor = { u: Number(uniEl.value) || 1, ch: 1 }; // le premier node garde son univers
        if (strat === 'uni' && cursor.ch > 1) { cursor.u++; cursor.ch = 1; }

        // l'adresse dépend de la place trouvée, et les départs dépendent de l'adresse :
        // deux passes suffisent à converger (la 1re sert juste à estimer la taille)
        let myAddr = 1, lay = layout(rowsN, cp, 1), placed = null;
        for (let pass = 0; pass < 2; pass++) {
          const probe = { ...cursor };
          placed = place(probe, lay.px, cp);
          if (placed.addr === myAddr) break;
          myAddr = placed.addr; lay = layout(rowsN, cp, myAddr);
        }
        placed = place(cursor, lay.px, cp); // pose réelle : le curseur avance
        const starts = layout(rowsN, cp, placed.addr).starts;
        const myUni = placed.u; myAddr = placed.addr;

        const before = { uni: Number(uniEl.value) || 1, addr: Number(addrEl.value) || 1, mode: Number(modeEl.value) };
        const startChanges = [...starts].filter(([tr, s]) => s !== rowVals(tr).start).length;
        sim.push({ n, cell, rowsN, mode, modeChanged, uni: myUni, addr: myAddr, starts, before, startChanges,
          changed: myUni !== before.uni || myAddr !== before.addr || modeChanged || startChanges > 0 });
      }

      const touched = sim.filter(s => s.changed);
      if (!touched.length) return toast('déjà patché : rien à changer dans ce groupe');
      const lines = touched.map(s => `• ${s.n.name || s.n.ip} : ${[
        s.uni !== s.before.uni ? `univers ${s.before.uni} → ${s.uni}` : `univers ${s.uni}`,
        s.addr !== s.before.addr ? `adresse ${s.before.addr} → ${s.addr}` : `adresse ${s.addr}`,
        s.modeChanged ? `mode → ${modeName(s.mode)}` : '',
        s.startChanges ? `${s.startChanges} départ(s) de sortie` : '',
      ].filter(Boolean).join(', ')}`).join('\n');
      const untouched = sim.length - touched.length;
      if (!await confirmBox(`⚡ Patcher « ${gc.g || (gc.nodes[0].name || gc.nodes[0].ip)} » — ${strat === 'tight' ? 'serré' : 'une sortie = un univers'}\n\n${touched.length} node(s) modifié(s)${untouched ? `, ${untouched} inchangé(s)` : ''} :\n${lines}\n\nAucun autre groupe n'est touché. Rien n'est écrit maintenant : les champs sont remplis, à toi de vérifier puis d'Enregistrer.`, { tone: 'green', label: 'Remplir les champs' })) return;

      for (const s of touched) {
        if (s.modeChanged) s.cell.querySelector('[data-nb=dmxmode]').value = String(s.mode);
        s.cell.querySelector('[data-nb=dmxuni]').value = String(s.uni);
        s.cell.querySelector('[data-nb=dmxaddr]').value = String(s.addr);
        for (const [tr, st] of s.starts) tr.querySelector('[data-out=start]').value = String(st);
        recompute(s.n.ip);
      }
      refreshDirty(); renderConflicts();
      toast(`${touched.length} node(s) recalculé(s) — vérifier, puis Enregistrer`);
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
        // order et wswap partent séparément : le serveur recompose l'octet
        // ((swap << 4) | ordre) sans écraser le quartet qu'on n'édite pas
        const ins = outsChanged ? rows.map(tr => { const pl = n.plan; const o = pl.outputs[Number(tr.dataset.outrow)]; return { pin: o.pin, type: Number(tr.querySelector('[data-out=type]').value), order: Number(tr.querySelector('[data-out=order]').value), wswap: Number(tr.querySelector('[data-out=wswap]').value) || 0, start: Number(tr.querySelector('[data-out=start]').value), len: Number(tr.querySelector('[data-out=len]').value), rev: tr.querySelector('[data-out=rev]').checked, skip: Number(tr.querySelector('[data-out=skip]').value) || 0, omax: Number(tr.querySelector('[data-out=omax]').value) || 0, ledma: Number(tr.querySelector('[data-out=ledma]').value), ref: tr.querySelector('[data-out=ref]').checked }; }) : null;
        // fixtures : seules les lignes dont le numéro ou l'instance a bougé, pour
        // ne pas réécrire /fleet.json en entier à chaque enregistrement
        const meta = rows.filter(tr => ['[data-fix]', '[data-inst]'].some(s => { const el = tr.querySelector(s); return el && String(el.value) !== String(el.dataset.orig); }))
          .map(tr => ({ i: Number(tr.dataset.outrow),
            fixture: tr.querySelector('[data-fix]').value === '' ? null : Number(tr.querySelector('[data-fix]').value),
            instance: Number(tr.querySelector('[data-inst]').value) || 0 }));
        const cell = p.querySelector(`[data-nodecell="${CSS.escape(ip)}"]`); const settings = [];
        for (const [id, col] of [['dmxmode', colDmx.mode], ['dmxuni', colDmx.uni], ['dmxaddr', colDmx.addr], ['maxpwr', colDmx.mA]]) { const el = cell && cell.querySelector(`[data-nb="${id}"]`); if (el && el.value !== '' && String(el.value) !== String(el.dataset.orig)) settings.push({ col, value: normalize(col, el.value) }); }
        plan.push({ ip, name: n.name || ip, ins, meta, settings });
      }
      const lines = plan.map(x => `• ${x.name} : ${[x.ins ? `${x.ins.length} sorties (${x.ins.map(o => o.len).join(' + ')} px)` : '', x.meta.length ? `${x.meta.length} fixture(s)` : '', ...x.settings.map(s => `${s.col.label} = ${raw(s.col, s.value)}`)].filter(Boolean).join(', ')}`).join('\n');
      // ne décrire que ce qui va réellement se passer : annoncer une réécriture
      // des sorties alors qu'on ne touche qu'un numéro de fixture fait hésiter
      // sur un geste qui ne risque rien
      const how = [
        plan.some(x => x.ins) ? 'Sorties : bloc complet renvoyé (WLED le reconstruit), sauvegarde de la flotte prise avant.' : '',
        plan.some(x => x.meta.length) ? 'Fixtures : écrites dans /fleet.json sur le node, la config LED n\'est pas touchée.' : '',
        plan.some(x => x.settings.length) ? 'Réglages DMX : envoyés via Déployer.' : '',
      ].filter(Boolean).join('\n');
      if (!await confirmBox(`Écrire sur ${plan.length} node(s) ?\n\n${lines}\n\n${how}`)) return;
      sb.disabled = true; sb.textContent = 'écriture…';
      let staged = 0;
      for (const x of plan) {
        // les réglages d'abord, le marqueur ensuite : un échec entre les deux
        // laisse un node sans fixture déclarée, pas un node qui en revendique une
        // qu'il n'a pas
        if (x.ins) {
          try {
            await post('/api/snapshots', { name: `avant sorties ${x.name}` });
            const r = await post(`/api/node/${encodeURIComponent(x.ip)}/outputs`, { ins: x.ins, meta: x.meta });
            toast(`${x.name} : sorties écrites, ${r.total} px`);
            if (r.warn) toast(`${x.name} : ${r.warn}`, true);
          } catch (e) { toast(`${x.name} : ${e.message}`, true); }
        } else if (x.meta.length) {
          try { await post(`/api/node/${encodeURIComponent(x.ip)}/meta`, { outputs: x.meta }); toast(`${x.name} : fixtures enregistrées`); }
          catch (e) { toast(`${x.name} : ${e.message}`, true); }
        }
        for (const s of x.settings) { stageValue(x.ip, s.col, s.value); staged++; }
      }
      if (staged) { updatePendingUI(); renderBody(); await deploy(); }
      setTimeout(renderDmx, 3000);
    };
    // (supprimé 2026-09-08) bouton « ≡ univers entiers » : il écrivait sur le node dès la
    // confirmation, alors que ⚡ Autopatch calculait la même chose sans rien écrire. Le geste
    // est devenu la stratégie « une sortie = un univers » de ⚡ Patcher, qui passe comme tout
    // le reste par « Enregistrer les modifications ».
  }

  // ── onglet Bibliothèque : le catalogue des produits LED ────────────────────
  // Un produit = tout ce qui est vrai du matériel branché, jamais ce qui relève
  // de l'installation (sens, index de départ, univers, adresse). C'est ce qui
  // permet d'appliquer un produit sans jamais casser un patch.
  //
  // Chaque produit porte un uuid frappé à sa création et une révision qui monte
  // dès que ses réglages changent. Le node retient les deux : Fleet sait donc
  // dire « cette sortie a été patchée avec la rev 3, le catalogue est en rev 5 »
  // au lieu de laisser croire qu'un même nom veut dire mêmes réglages.
  let libData = null, libSel = null, libDraft = null;
  const libLabel = p => [p.ref.brand, p.ref.model].filter(Boolean).join(' ') || p.slug;
  const REV_STATE = {
    stale: { cls: 'st-warn', txt: 'patchée avec une révision plus ancienne — réappliquer le produit la mettrait à jour' },
    ahead: { cls: 'st-bad', txt: 'patchée avec une révision que ce poste n\'a pas : la bibliothèque locale est en retard, ne rien réappliquer avant de l\'avoir rafraîchie' },
  };

  // Les trois catalogues partagent un onglet et un patron : liste à gauche,
  // éditeur à droite. Les séparer en trois onglets de premier niveau les
  // éloignerait alors qu'on passe sans cesse de l'un à l'autre — une carte se
  // saisit en regardant ce qu'on branche dessus.
  let libKind = (() => { try { return ['products', 'drivers', 'psus'].includes(localStorage.getItem('wf.libKind')) ? localStorage.getItem('wf.libKind') : 'products'; } catch { return 'products'; } })();
  const LIBKINDS = { products: 'Produits LED', drivers: 'Cartes', psus: 'Alimentations' };
  const libTabs = () => `<nav class="subtabs">${Object.entries(LIBKINDS).map(([k, l]) =>
    `<button data-libkind="${k}" class="${k === libKind ? 'active' : ''}">${esc(l)}</button>`).join('')}</nav>`;
  function wireLibTabs(pane) {
    pane.querySelectorAll('[data-libkind]').forEach(b => b.onclick = () => {
      libKind = b.dataset.libkind; libSel = null; libDraft = null;
      try { localStorage.setItem('wf.libKind', libKind); } catch { /* ignore */ }
      renderLib();
    });
  }
  async function renderLib() {
    if (libKind === 'drivers') return renderCat('drivers');
    if (libKind === 'psus') return renderCat('psus');
    const pane = $('#libpanel');
    try { libData = await api('/api/library'); } catch (e) { pane.innerHTML = `<div class="st-bad">${esc(e.message)}</div>`; return; }
    const d = libData;
    libSig = JSON.stringify([d.products.map(x => [x.uid, x.rev, x.retired]), d.usage]);
    const products = d.products.filter(x => !x.retired);
    if (libSel && !products.some(x => x.uid === libSel)) libSel = null;
    if (!libSel && !libDraft && products.length) libSel = products[0].uid;
    const cur = libDraft || products.find(x => x.uid === libSel) || null;
    const usage = d.usage || {};

    // groupés par marque : une gamme se lit mieux que quarante lignes à plat
    const byBrand = new Map();
    for (const x of products) { const k = x.ref.brand || '(sans marque)'; if (!byBrand.has(k)) byBrand.set(k, []); byBrand.get(k).push(x); }
    const list = [...byBrand.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([brand, items]) => `
      <div class="libbrand">${esc(brand)}</div>
      ${items.map(x => {
        const used = usage[x.uid] || [];
        const behind = used.filter(u => u.revState === 'stale').length;
        const ahead = used.filter(u => u.revState === 'ahead').length;
        const px = x.presets.map(pr => pr.px).join(' / ');
        return `<div class="libitem${x.uid === libSel && !libDraft ? ' sel' : ''}" data-pick="${esc(x.uid)}">
          <div><b>${esc(x.ref.model || x.slug)}</b> <span class="revchip" title="révision du produit : elle monte dès que ses réglages changent">rev ${x.rev}</span></div>
          <div class="muted">${esc(LED_TYPES[x.led.type] || x.led.type)}${px ? ` · ${esc(px)} px` : ' · aucune longueur'}${used.length ? ` · ${used.length} sortie${used.length > 1 ? 's' : ''}` : ''}</div>
          ${behind ? `<div class="st-warn">${behind} sortie${behind > 1 ? 's' : ''} sur une révision plus ancienne</div>` : ''}
          ${ahead ? `<div class="st-bad">${ahead} sortie${ahead > 1 ? 's' : ''} sur une révision inconnue ici</div>` : ''}
        </div>`;
      }).join('')}`).join('') || '<div class="muted" style="padding:10px 2px">aucun produit — « ＋ Nouveau produit » pour commencer</div>';

    // marqueurs lus sur des nodes qui ne désignent aucun produit d'ici : ils ne
    // sont JAMAIS effacés, seulement signalés — le node vient d'un poste dont la
    // bibliothèque est plus complète, et écraser perdrait l'information.
    const known = new Set(d.products.map(x => x.uid));
    const orphans = Object.entries(usage).filter(([k]) => !known.has(k));

    pane.innerHTML = `${libTabs()}<h2>Produits LED <span class="muted">${products.length}</span>
        <span class="spacer"></span>
        <button id="libGuess" class="rowbtn" title="parcourt les sorties de la flotte et propose une fiche par combinaison distincte de type, ordre, mA et longueur. Rien n'est créé sans validation.">Déduire de la flotte…</button>
        <button id="libNew" class="rowbtn">＋ Nouveau produit</button></h2>
      <div class="muted" style="font-size:12px;margin:-4px 0 10px;max-width:900px">Un produit décrit ce qui est branché : type de LED, ordre des couleurs, échange du blanc, mA par LED, LEDs sautées, off refresh, LEDs par mètre, et une ou plusieurs longueurs types. Ce qui dépend de l'installation — sens inversé, index de départ, univers, adresse — n'y est pas : appliquer un produit ne peut donc pas casser un patch existant.</div>
      ${orphans.length ? `<div class="st-warn" style="margin-bottom:10px">${orphans.length} marqueur${orphans.length > 1 ? 's' : ''} lu${orphans.length > 1 ? 's' : ''} sur la flotte ne désigne${orphans.length > 1 ? 'nt' : ''} aucun produit d'ici : ${orphans.map(([k, v]) => `<span class="mono">${esc(k.slice(0, 8))}</span> (${v.length} sortie${v.length > 1 ? 's' : ''})`).join(', ')}. Ces nodes viennent d'un poste dont la bibliothèque est plus complète — leurs marqueurs sont conservés tels quels.</div>` : ''}
      <div class="fwcols">
        <div class="liblist">${list}</div>
        <div id="libEditor">${cur ? editorHtml(cur, usage[cur.uid] || []) : '<div class="muted">choisir un produit à gauche</div>'}</div>
      </div>
      <div id="libremote"></div>
      <div id="libnodes"></div>`;

    wireLibTabs(pane);
    pane.querySelectorAll('[data-pick]').forEach(el => el.onclick = () => { libSel = el.dataset.pick; libDraft = null; renderLib(); });
    $('#libNew').onclick = () => { libDraft = blankProduct(); libSel = null; renderLib(); };
    $('#libGuess').onclick = guessProducts;
    wireLibEditor();
    renderRemote();
    renderNodeLib();
  }

  // ── Le schéma du plateau ──────────────────────────────────────────────────
  // Le module de rendu vit dans graph.js et ne sait rien de l'application : on
  // lui donne les données et deux fonctions de rappel. Tirer un câble depuis
  // une alimentation vers un node écrit sur le NODE, comme partout ailleurs.
  let graphApi = null, graphSig = '';
  async function renderGraph() {
    const pane = $('#graphpanel');
    let d; try { d = await api('/api/power'); } catch (e) { pane.innerHTML = `<div class="st-bad">${esc(e.message)}</div>`; return; }
    if (!pane.querySelector('.gwrap')) {
      pane.innerHTML = `<h2>Schéma
          <span class="muted" style="text-transform:none;letter-spacing:0" title="Alimentations à gauche, nodes au milieu, sorties à droite. La couleur d'un câble est celle du pire constat qui le concerne : le schéma est le rapport de cohérence, en plus lisible qu'un tableau. Molette pour zoomer, glisser le fond pour déplacer la vue, double-clic pour tout revoir.">ⓘ</span>
          <span class="spacer"></span>
          <button id="gFit" class="rowbtn">Tout voir</button>
          <button id="gReset" class="rowbtn" title="oublier les positions déplacées à la main et revenir à la disposition calculée">Replacer</button></h2>
        <div class="gwrap"></div>`;
      graphApi = WF_GRAPH.mount(pane.querySelector('.gwrap'), { onWire: wireNode });
      $('#gFit').onclick = () => graphApi.fit();
      $('#gReset').onclick = () => graphApi.resetPos();
      graphApi.update(d);
      // après la frame : le panneau vient d'être affiché, il n'a pas encore sa taille
      requestAnimationFrame(() => graphApi.fit());
      graphSig = sigOf(d);
      return;
    }
    // ne redessiner que si quelque chose a changé : un rafraîchissement qui
    // reconstruit le schéma sous les doigts pendant qu'on déplace une boîte est
    // insupportable
    const sig = sigOf(d);
    if (sig !== graphSig) { graphSig = sig; graphApi.update(d); }
  }
  const sigOf = d => JSON.stringify([
    (d.psus || []).map(p => [p.uid, p.usedA, p.capA, (p.nodes || []).map(n => n.ip), (p.checks || []).length]),
    (d.orphelins || []).map(o => o.ip),
    (d.nodes || []).map(n => [n.ip, n.budget.maxA, n.budget.ratio, (n.budget.outputs || []).length]),
  ]);

  async function wireNode(psuUid, target) {
    // on ne câble que vers un node, et jamais vers une sortie ou une autre alim
    const n = (powerData && powerData.nodes || []).find(x => x.ip === target)
      || (powerData && powerData.orphelins || []).find(x => x.ip === target);
    if (!target.includes('.') || target.includes('#')) return;
    try {
      await post(`/api/node/${encodeURIComponent(target)}/power`, { psu: psuUid });
      toast('node rattaché');
      graphSig = ''; renderGraph();
    } catch (e) { toast(e.message, true); }
  }

  // ── Onglet Puissance ──────────────────────────────────────────────────────
  // La règle de partage, à tenir : Sorties / DMX répond à « où sont les
  // pixels », Puissance répond à « d'où vient le courant ». Cet onglet ne
  // montre donc AUCUN univers, aucune adresse, aucune fixture — dès qu'on veut
  // savoir « quel univers », on change d'onglet. C'est ce qui empêche les deux
  // pages de devenir deux fois la même.
  let powerData = null, powerSel = null;
  const LVL = { bad: 'st-bad', warn: 'st-warn', info: 'muted' };
  const aFmt = a => (a === null || a === undefined ? '—' : `${a} A`);

  async function renderPower() {
    const pane = $('#powerpanel');
    try { powerData = await api('/api/power'); } catch (e) { pane.innerHTML = `<div class="st-bad">${esc(e.message)}</div>`; return; }
    const d = powerData;
    const graves = d.checks.filter(c => c.level !== 'info');

    const carte = p => {
      const pct = p.chargePct;
      const teinte = pct === null ? '' : pct > 100 ? 'st-bad' : pct > 80 ? 'st-warn' : 'st-ok';
      const cs = p.checks || [];
      return `<div class="gtable"><details data-key="pw:${esc(p.uid || p.label)}" open><summary>
          <span class="caret">▸</span> <b>${esc(p.label || '(sans nom)')}</b>
          <span class="muted">${p.model ? esc([p.model.ref.brand, p.model.ref.model].filter(Boolean).join(' ')) : 'modèle non renseigné'}${p.location ? ` · ${esc(p.location)}` : ''}</span>
          ${p.capA !== null ? `<span class="${teinte}">${p.usedA} A budgétés sur ${p.capA} A${pct !== null ? ` · ${pct} %` : ''}</span>` : '<span class="muted">capacité inconnue</span>'}
          ${cs.some(c => c.level === 'bad') ? '<span class="st-bad">✗</span>' : cs.some(c => c.level === 'warn') ? '<span class="st-warn">▲</span>' : ''}
          <span class="spacer"></span>
          <button class="rowbtn" data-pwedit="${esc(p.uid)}">Modifier</button>
        </summary>
        ${p.capA !== null ? `<div class="pwbar" title="budget utilisable : ${p.budgetA} A (${p.capA} A moins le taux d'usage et la marge)">
          <i style="width:${Math.min(100, pct || 0)}%" class="${teinte}"></i>
          <b style="left:${Math.min(100, Math.round((p.budgetA / p.capA) * 100))}%" title="limite conseillée"></b></div>` : ''}
        ${cs.length ? `<div class="pwchecks">${cs.map(c => `<div class="${LVL[c.level]}">${c.level === 'bad' ? '✗' : c.level === 'warn' ? '▲' : 'ⓘ'} ${esc(c.msg)}</div>`).join('')}</div>` : ''}
        <table class="outs" style="width:auto">
          <thead><tr><th>Node</th><th>Carte</th><th title="ce que l'ABL autorise réellement — c'est ce chiffre qu'on somme, pas le pire cas">Budget</th><th title="blanc plein, toutes sorties : jamais atteint en pratique">Pire cas</th><th title="part du blanc plein réellement atteignable avec ce budget">Blanc</th><th>Tension</th><th></th></tr></thead>
          <tbody>${p.nodes.length ? p.nodes.map(n => ligneNode(n)).join('') : '<tr><td colspan="7" class="muted">aucun node rattaché</td></tr>'}</tbody>
        </table></details></div>`;
    };

    const ligneNode = n => {
      const full = (d.nodes || []).find(x => x.ip === n.ip) || {};
      const b = full.budget || {};
      const r = n.ratio === null || n.ratio === undefined ? null : Math.round(n.ratio * 100);
      return `<tr><td><b>${esc(n.name)}</b></td>
        <td class="muted">${full.driver ? esc([full.driver.ref.brand, full.driver.ref.model].filter(Boolean).join(' ')) : '—'}</td>
        <td>${aFmt(n.maxA)}${b.ablGoverns ? ' <span class="muted" title="le facteur d\'usage dépasse ce budget : c\'est l\'ABL qui décide ici">◂</span>' : ''}</td>
        <td class="muted">${aFmt(n.worstA)}</td>
        <td class="${r === null ? 'muted' : r < 50 ? 'st-warn' : 'muted'}">${r === null ? '—' : `${r} %`}</td>
        <td class="muted">${(b.volts && b.volts.length) ? b.volts.join('/') + ' V' : '—'}</td>
        <td><button class="rowbtn" data-detach="${esc(n.ip)}" title="détacher ce node de cette alimentation">✕</button></td></tr>`;
    };

    pane.innerHTML = `<h2>Puissance
        <span class="muted" style="text-transform:none;letter-spacing:0" title="Cette page répond à « d'où vient le courant ». Sorties / DMX répond à « où sont les pixels » — on n'y trouve donc ici ni univers, ni adresse, ni fixture. Les budgets sommés sont les limites déclarées à WLED (son limiteur automatique), et non les pires cas théoriques : sur une flotte réelle le pire cas dépasse partout le budget, et le sommer produirait une alerte permanente.">ⓘ</span>
        <span class="spacer"></span>
        <button id="pwNew" class="rowbtn">＋ Alimentation</button></h2>
      ${graves.length
    ? `<div class="subbox" style="margin-bottom:10px">${graves.map(c => `<div class="${LVL[c.level]}">${c.level === 'bad' ? '✗' : '▲'} ${c.node ? `<b>${esc(c.node)}</b> — ` : ''}${esc(c.msg)}</div>`).join('')}</div>`
    : '<div class="st-ok" style="margin-bottom:10px">✓ rien à signaler sur la chaîne électrique</div>'}
      <div class="pwtotals subbox">
        <span><span class="k">Capacité installée</span> <b>${d.totals.capaciteA} A</b></span>
        <span><span class="k">Budgets déclarés</span> <b>${d.totals.budgetA} A</b></span>
        <span><span class="k">Pire cas théorique</span> <b class="muted">${d.totals.pireCasA} A</b></span>
        <span><span class="k">Nodes rattachés</span> <b>${d.totals.rattaches} / ${d.totals.nodes}</b></span>
      </div>
      ${d.psus.map(carte).join('') || '<div class="muted">aucune alimentation saisie — « ＋ Alimentation » pour commencer</div>'}
      ${d.orphelins.length ? `<h2 style="margin-top:16px">Non rattachés <span class="muted">${d.orphelins.length}</span></h2>
        <div class="muted" style="font-size:12px;margin-bottom:6px">Ces nodes ne sont reliés à aucune alimentation : impossible de dire si ce qu'ils ont le droit de tirer est couvert.</div>
        <table class="outs" style="width:auto"><tbody>${d.orphelins.map(o => `<tr><td><b>${esc(o.name)}</b></td><td>${aFmt(o.maxA)}</td>
          <td>${d.plan.psus.length ? `<select data-attach="${esc(o.ip)}"><option value="">rattacher à…</option>${d.plan.psus.map(x => `<option value="${esc(x.uid)}">${esc(x.label)}</option>`).join('')}</select>` : '<span class="muted">saisir d\'abord une alimentation</span>'}</td></tr>`).join('')}</tbody></table>` : ''}
      <div id="pwEdit"></div>`;

    keepDetails(pane);
    $('#pwNew').onclick = () => editPsu(null);
    pane.querySelectorAll('[data-pwedit]').forEach(b => b.onclick = () => editPsu(b.dataset.pwedit));
    pane.querySelectorAll('[data-attach]').forEach(sel => sel.onchange = () => attach(sel.dataset.attach, sel.value));
    pane.querySelectorAll('[data-detach]').forEach(b => b.onclick = () => attach(b.dataset.detach, null));
    updatePowerBadge(d);
  }

  function updatePowerBadge(d) {
    const n = (d.checks || []).filter(c => c.level !== 'info').length;
    setBadge('power', n ? ` <span class="n">${n}</span>` : '');
  }

  // Rattacher écrit sur le NODE : c'est lui qui doit se raconter, y compris sur
  // un poste qui n'a jamais vu ce showfile.
  async function attach(ip, psu) {
    try {
      await post(`/api/node/${encodeURIComponent(ip)}/power`, { psu, rail: psu ? undefined : null });
      toast(psu ? 'node rattaché' : 'node détaché');
      renderPower();
    } catch (e) { toast(e.message, true); }
  }

  function editPsu(uid) {
    const cur = uid ? powerData.plan.psus.find(x => x.uid === uid) : null;
    const box = $('#pwEdit');
    box.innerHTML = `<h2 style="margin-top:16px">${cur ? 'Modifier' : 'Nouvelle alimentation'}</h2>
      <div class="setrow" style="max-width:700px">
        <label for="pwLabel">Libellé</label><div><input id="pwLabel" value="${esc(cur ? cur.label : '')}" placeholder="Alim jardin" style="width:220px"></div>
        <div class="hint">le nom qu'on emploie sur le plateau, pas la référence du fabricant</div>
        <label for="pwModel">Modèle</label><div><select id="pwModel"><option value="">— non renseigné —</option>${
  (powerData.catalogue || []).filter(x => !x.retired).map(x => `<option value="${esc(x.uid)}"${cur && cur.model === x.uid ? ' selected' : ''}>${esc([x.ref.brand, x.ref.model].filter(Boolean).join(' '))} · ${x.psu.volt} V${x.psu.amps ? ` ${x.psu.amps} A` : ''}</option>`).join('')}</select></div>
        <div class="hint">pris dans la Bibliothèque → Alimentations. Sans modèle, aucune capacité n'est connue et rien ne peut être vérifié.</div>
        <label for="pwLoc">Emplacement</label><div><input id="pwLoc" value="${esc(cur ? cur.location : '')}" placeholder="sous le praticable jardin" style="width:100%;max-width:330px"></div>
        <div class="hint">ce qu'on cherche quand quelque chose ne s'allume pas, et que personne ne note jamais</div>
      </div>
      <div style="margin-top:8px;display:flex;gap:8px">
        <button id="pwSave" class="rowbtn primary">Enregistrer</button>
        ${cur ? '<button id="pwDel" class="rowbtn">Retirer</button>' : ''}
        <button id="pwCancel" class="rowbtn">Annuler</button>
      </div>`;
    box.scrollIntoView({ block: 'nearest' });
    $('#pwCancel').onclick = () => { box.innerHTML = ''; };
    $('#pwSave').onclick = async () => {
      try {
        await post('/api/power/psu', { uid: cur ? cur.uid : undefined, label: $('#pwLabel').value, model: $('#pwModel').value || null, location: $('#pwLoc').value });
        box.innerHTML = ''; toast('alimentation enregistrée'); renderPower();
      } catch (e) { toast(e.message, true); }
    };
    if ($('#pwDel')) $('#pwDel').onclick = async () => {
      if (!await confirmBox(`Retirer « ${cur.label} » ?\nLes nodes qu'elle nourrit ne seront PAS détachés d'autorité : ils apparaîtront comme non rattachés, à vous de les replacer.`)) return;
      try {
        const r = await api(`/api/power/psu/${encodeURIComponent(cur.uid)}`, { method: 'DELETE' });
        box.innerHTML = '';
        toast(r.orphelins.length ? `retirée — ${r.orphelins.length} node(s) désormais sans alimentation` : 'retirée');
        renderPower();
      } catch (e) { toast(e.message, true); }
    };
  }


  // ── Cartes et alimentations ───────────────────────────────────────────────
  // Même patron que les produits : liste à gauche, éditeur à droite. Ce qui
  // change d'un type à l'autre tient dans deux fonctions — la ligne de liste et
  // le corps du formulaire — le reste est commun.
  let catData = null;
  const VOLT_LIST = [5, 12, 24, 48];
  const voltBoxes = (name, cochees, titre) => `<div class="volts" title="${esc(titre)}">${VOLT_LIST.map(v =>
    `<label class="chip"><input type="checkbox" data-volt="${name}" value="${v}"${(cochees || []).includes(v) ? ' checked' : ''}> ${v} V</label>`).join('')}</div>`;
  const readVolts = name => [...document.querySelectorAll(`[data-volt="${name}"]`)].filter(c => c.checked).map(c => Number(c.value));

  async function renderCat(kind) {
    const pane = $('#libpanel');
    try { catData = await api(`/api/${kind}`); } catch (e) { pane.innerHTML = `<div class="st-bad">${esc(e.message)}</div>`; return; }
    const items = (catData[kind] || []).filter(x => !x.retired);
    const usage = catData.usage || {};
    if (libSel && !items.some(x => x.uid === libSel)) libSel = null;
    if (!libSel && !libDraft && items.length) libSel = items[0].uid;
    const cur = libDraft || items.find(x => x.uid === libSel) || null;

    const byBrand = new Map();
    for (const x of items) { const k = x.ref.brand || '(sans marque)'; if (!byBrand.has(k)) byBrand.set(k, []); byBrand.get(k).push(x); }
    const ligne = x => {
      const n = (usage[x.uid] || []).length;
      const sous = kind === 'drivers'
        ? `${x.board.outputs ? `${x.board.outputs} sortie${x.board.outputs > 1 ? 's' : ''}` : 'sorties non renseignées'}${x.board.maxA ? ` · ${x.board.maxA} A` : ''}${x.board.mcu ? ` · ${esc(x.board.mcu)}` : ''}`
        : `${x.psu.volt} V${x.psu.amps ? ` · ${x.psu.amps} A` : ''}${x.psu.watts ? ` · ${x.psu.watts} W` : ''}${x.psu.rails.length ? ` · ${x.psu.rails.length} rails` : ''}`;
      return `<div class="libitem${x.uid === libSel && !libDraft ? ' sel' : ''}" data-pick="${esc(x.uid)}">
        <div><b>${esc(x.ref.model || x.slug)}</b> <span class="revchip">rev ${x.rev}</span></div>
        <div class="muted">${sous}${n ? ` · ${n} node${n > 1 ? 's' : ''}` : ''}</div></div>`;
    };
    const list = [...byBrand.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([brand, xs]) =>
      `<div class="libbrand">${esc(brand)}</div>${xs.map(ligne).join('')}`).join('')
      || `<div class="muted" style="padding:10px 2px">aucune fiche — « ＋ Nouveau » pour commencer</div>`;

    const titre = kind === 'drivers' ? 'Cartes' : 'Alimentations';
    const intro = kind === 'drivers'
      ? "Une carte décrit un MODÈLE — « QuinLED Dig-Quad » — et non le boîtier accroché au portique : ce qu'un exemplaire a de particulier vit sur le node. Elle apporte ce que le node ne dit pas de lui-même : combien de sorties sont réellement câblées, sur quels GPIO, et ce que le bornier supporte. C'est ce qui permet de dire si un budget de courant est réaliste."
      : "Une alimentation décrit un MODÈLE — « Meanwell LRS-350-24 » — et non l'exemplaire n° 3 du camion : « Alim jardin » ne voudrait rien dire sur un autre poste, et le rattachement vit sur le node. Ampères et watts sont liés par la tension : saisir l'un remplit l'autre.";

    pane.innerHTML = `${libTabs()}<h2>${titre} <span class="muted">${items.length}</span>
        <span class="spacer"></span><button id="catNew" class="rowbtn">＋ Nouveau</button></h2>
      <div class="muted" style="font-size:12px;margin:-4px 0 10px;max-width:900px">${intro}</div>
      <div class="fwcols">
        <div class="liblist">${list}</div>
        <div id="libEditor">${cur ? (kind === 'drivers' ? driverForm(cur, usage[cur.uid] || []) : psuForm(cur, usage[cur.uid] || [])) : '<div class="muted">choisir une fiche à gauche</div>'}</div>
      </div>`;

    wireLibTabs(pane);
    pane.querySelectorAll('[data-pick]').forEach(el => el.onclick = () => { libSel = el.dataset.pick; libDraft = null; renderLib(); });
    $('#catNew').onclick = () => { libDraft = kind === 'drivers' ? blankDriver() : blankPsu(); libSel = null; renderLib(); };
    if (cur) wireCatEditor(kind, cur);
  }

  const blankDriver = () => ({ uid: null, rev: 1, ref: { brand: '', model: '', sku: '', internal: '', note: '' },
    board: { mcu: '', release: '', eth: 0, outputs: 0, pins: [], inputVolts: [], maxA: null, maxAPerOut: null, fused: false, levelShifter: false, psuBuiltin: false, note: '' } });
  const blankPsu = () => ({ uid: null, rev: 1, ref: { brand: '', model: '', sku: '', internal: '', note: '' },
    psu: { volt: 12, amps: null, watts: null, basis: 'amps', rails: [], derate: 0.8, adjustable: false, note: '' } });

  const refRows = x => `
    <label for="cBrand">Marque</label><div><input id="cBrand" value="${esc(x.ref.brand)}" style="width:190px"></div>
    <label for="cModel">Modèle</label><div><input id="cModel" value="${esc(x.ref.model)}" style="width:190px"></div>
    <div class="hint">marque ou modèle obligatoire</div>
    <label for="cSku">Référence</label><div><input id="cSku" value="${esc(x.ref.sku)}" placeholder="fabricant" style="width:150px"> <input id="cInt" value="${esc(x.ref.internal)}" placeholder="interne" style="width:120px"></div>
    <label for="cNote">Note</label><div><input id="cNote" value="${esc(x.ref.note)}" style="width:100%;max-width:330px"></div>
    <div class="hint">corriger un nom ou une note ne fait pas monter la révision</div>`;
  const usedBy = (used, quoi) => used.length
    ? `<h2 style="margin-top:14px">Utilisé par <span class="muted">${used.length} node${used.length > 1 ? 's' : ''}</span></h2>
       <div class="libused">${used.map(u => `${esc(u.name)}${u.rail ? ` · rail ${esc(u.rail)}` : ''}`).join('<br>')}</div>`
    : `<div class="muted" style="margin-top:14px;font-size:12px">Aucun node ne déclare ${quoi} pour l'instant.</div>`;

  function driverForm(x, used) {
    const b = x.board;
    const eth = catData.ethTypes || {};
    return `<h2>${x.uid ? `Modifier <span class="revchip">rev ${x.rev}</span>` : 'Nouvelle carte'}
        <span class="spacer"></span>${x.uid ? '<button id="catDel" class="rowbtn">Retirer</button>' : ''}
        <button id="catSave" class="rowbtn primary">Enregistrer</button></h2>
      <div class="setrow">${refRows(x)}
        <label for="dMcu">Puce attendue</label><div><input id="dMcu" value="${esc(b.mcu)}" placeholder="esp32, ESP32-S3…" style="width:150px">
          <input id="dRelease" value="${esc(b.release)}" placeholder="variante de build" style="width:170px"></div>
        <div class="hint">comparés à ce que le node répond : une carte déclarée ESP32 sur un node qui répond ESP32-C3 est une fiche fausse</div>
        <label for="dEth">Ethernet</label><div><select id="dEth">${Object.entries(eth).map(([v, l]) => `<option value="${v}"${Number(v) === Number(b.eth) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
        <div class="hint">le type Ethernet de WLED nomme déjà de vraies cartes, et il réserve des GPIO</div>
        <label for="dOut">Sorties</label><div><input type="number" id="dOut" value="${b.outputs || ''}" min="0" max="16" placeholder="—" style="width:70px"> <span class="muted">physiquement câblées</span></div>
        <div class="hint">laisser vide tant qu'on ne sait pas : une fiche incomplète doit produire moins de constats, jamais des faux</div>
        <label>Tensions d'entrée</label><div>${voltBoxes('din', b.inputVolts, 'une carte accepte souvent plusieurs tensions')}</div>
        <div class="hint">vide = non renseigné, ce qui ne vaut jamais « c'est bon »</div>
        <label for="dMaxA">Courant admissible</label><div><input type="number" id="dMaxA" value="${b.maxA ?? ''}" min="0" step="0.5" placeholder="—" style="width:70px"> A au total,
          <input type="number" id="dMaxAOut" value="${b.maxAPerOut ?? ''}" min="0" step="0.5" placeholder="—" style="width:70px"> A par sortie</div>
        <div class="hint">ce que le bornier, les pistes et le fusible laissent passer — en ampères, alors que WLED raisonne en milliampères</div>
        <label>Options</label><div>
          <label class="chip"><input type="checkbox" id="dFused"${b.fused ? ' checked' : ''}> fusible</label>
          <label class="chip"><input type="checkbox" id="dShift"${b.levelShifter ? ' checked' : ''}> adaptateur de niveau</label>
          <label class="chip"><input type="checkbox" id="dPsu"${b.psuBuiltin ? ' checked' : ''}> alimentation intégrée</label></div>
        <div class="hint"></div>
      </div>
      <h2 style="margin-top:14px">Brochage <span class="muted">une ligne par sortie physique</span></h2>
      ${b.outputs ? `<table class="outs" style="width:auto"><tbody id="dPins">${Array.from({ length: b.outputs }, (_, i) => {
        const p = b.pins[i] || { gpio: [], label: '', level: '3v3' };
        return `<tr><td class="muted">sortie ${i + 1}</td>
          <td><input type="number" data-pin-gpio value="${p.gpio[0] ?? ''}" min="0" max="48" placeholder="GPIO" style="width:70px"></td>
          <td><input data-pin-label value="${esc(p.label)}" placeholder="repère" style="width:90px"></td>
          <td><select data-pin-level><option value="3v3"${p.level === '3v3' ? ' selected' : ''}>3,3 V</option><option value="5v"${p.level === '5v' ? ' selected' : ''}>5 V adapté</option></select></td></tr>`;
      }).join('')}</tbody></table>
      <div class="hint" style="margin-top:4px">Comparé au GPIO réellement lu sur le node, position par position — c'est ce qui repère une carte mal identifiée ou un câblage qui a bougé.</div>`
    : '<div class="muted">renseigner le nombre de sorties pour saisir le brochage</div>'}
      ${usedBy(used, 'cette carte')}`;
  }

  function psuForm(x, used) {
    const p = x.psu;
    return `<h2>${x.uid ? `Modifier <span class="revchip">rev ${x.rev}</span>` : 'Nouvelle alimentation'}
        <span class="spacer"></span>${x.uid ? '<button id="catDel" class="rowbtn">Retirer</button>' : ''}
        <button id="catSave" class="rowbtn primary">Enregistrer</button></h2>
      <div class="setrow">${refRows(x)}
        <label for="pVolt">Tension</label><div><select id="pVolt">${VOLT_LIST.map(v => `<option value="${v}"${v === p.volt ? ' selected' : ''}>${v} V</option>`).join('')}</select>
          <label class="chip"><input type="checkbox" id="pAdj"${p.adjustable ? ' checked' : ''}> ajustable</label></div>
        <div class="hint">une alimentation délivre UNE tension — c'est ce qui la distingue d'un ruban, qui existe souvent en plusieurs</div>
        <label for="pAmps">Puissance</label><div><input type="number" id="pAmps" value="${p.amps ?? ''}" min="0" step="0.1" placeholder="—" style="width:80px"> A
          &nbsp;ou&nbsp; <input type="number" id="pWatts" value="${p.watts ?? ''}" min="0" step="1" placeholder="—" style="width:80px"> W</div>
        <div class="hint">saisir l'un remplit l'autre, sous la tension choisie. Le champ saisi fait foi : changer la tension recalcule le second.</div>
        <label for="pDerate">Taux d'usage</label><div><input type="number" id="pDerate" value="${Math.round((p.derate || 0.8) * 100)}" min="10" max="100" step="5" style="width:70px"> %</div>
        <div class="hint">80 % est la valeur du métier pour une alim à convection : au-delà elle chauffe, vieillit vite et sa tension s'affaisse — ce qui, sur du LED adressable, corrompt les données bien avant de couper</div>
      </div>
      <h2 style="margin-top:14px">Rails <span class="muted">laisser vide si l'alimentation n'a qu'une sortie</span></h2>
      <table class="outs" style="width:auto"><tbody id="pRails">${(p.rails.length ? p.rails : []).map(railRow).join('')}</tbody></table>
      <button id="pAddRail" class="rowbtn">＋ rail</button>
      <div class="hint" style="margin-top:4px">Chaque rail se budgète séparément : un node branché sur le rail A n'est pas limité par ce que tire le rail B.</div>
      ${usedBy(used, 'cette alimentation')}`;
  }
  const railRow = (r = { id: '', volt: '', amps: '', label: '' }) => `<tr>
    <td><input data-rail-id value="${esc(r.id || '')}" placeholder="A" style="width:44px"></td>
    <td><input type="number" data-rail-amps value="${r.amps ?? ''}" min="0" step="0.1" placeholder="A" style="width:70px"> A</td>
    <td><select data-rail-volt><option value="">même tension</option>${VOLT_LIST.map(v => `<option value="${v}"${Number(r.volt) === v ? ' selected' : ''}>${v} V</option>`).join('')}</select></td>
    <td><input data-rail-label value="${esc(r.label || '')}" placeholder="repère" style="width:110px"></td>
    <td><button class="rowbtn" data-rail-del title="retirer ce rail">✕</button></td></tr>`;

  function wireCatEditor(kind, cur) {
    const save = $('#catSave'); if (!save) return;
    const read = () => {
      const base = { uid: libDraft ? libDraft.uid : libSel,
        ref: { brand: $('#cBrand').value, model: $('#cModel').value, sku: $('#cSku').value, internal: $('#cInt').value, note: $('#cNote').value } };
      if (kind === 'drivers') {
        const outputs = Number($('#dOut').value) || 0;
        return { ...base, board: {
          mcu: $('#dMcu').value, release: $('#dRelease').value, eth: Number($('#dEth').value) || 0, outputs,
          inputVolts: readVolts('din'),
          maxA: $('#dMaxA').value === '' ? null : Number($('#dMaxA').value),
          maxAPerOut: $('#dMaxAOut').value === '' ? null : Number($('#dMaxAOut').value),
          fused: $('#dFused').checked, levelShifter: $('#dShift').checked, psuBuiltin: $('#dPsu').checked,
          pins: [...document.querySelectorAll('#dPins tr')].map(tr => ({
            gpio: tr.querySelector('[data-pin-gpio]').value === '' ? [] : [Number(tr.querySelector('[data-pin-gpio]').value)],
            label: tr.querySelector('[data-pin-label]').value, level: tr.querySelector('[data-pin-level]').value })),
        } };
      }
      return { ...base,
        volt: Number($('#pVolt').value), basis: catBasis,
        amps: $('#pAmps').value === '' ? null : Number($('#pAmps').value),
        watts: $('#pWatts').value === '' ? null : Number($('#pWatts').value),
        derate: Number($('#pDerate').value) / 100, adjustable: $('#pAdj').checked,
        rails: [...document.querySelectorAll('#pRails tr')].map(tr => ({
          id: tr.querySelector('[data-rail-id]').value,
          amps: tr.querySelector('[data-rail-amps]').value === '' ? null : Number(tr.querySelector('[data-rail-amps]').value),
          volt: tr.querySelector('[data-rail-volt]').value || null,
          label: tr.querySelector('[data-rail-label]').value })) };
    };

    if (kind === 'drivers') {
      // changer le nombre de sorties redessine le brochage, en gardant la saisie
      $('#dOut').onchange = () => { libDraft = { ...blankDriver(), ...read() }; renderLib(); };
    } else {
      // Ampères et watts, chacun recalculant l'autre. `catBasis` retient lequel
      // a été saisi : sans ça, changer la tension obligerait à deviner quelle
      // grandeur l'utilisateur voulait conserver.
      const volt = () => Number($('#pVolt').value) || 12;
      const r1 = v => Math.round(v * 10) / 10;
      $('#pAmps').oninput = () => { catBasis = 'amps'; $('#pWatts').value = $('#pAmps').value === '' ? '' : r1(Number($('#pAmps').value) * volt()); };
      $('#pWatts').oninput = () => { catBasis = 'watts'; $('#pAmps').value = $('#pWatts').value === '' ? '' : r1(Number($('#pWatts').value) / volt()); };
      $('#pVolt').onchange = () => {
        if (catBasis === 'watts' && $('#pWatts').value !== '') $('#pAmps').value = r1(Number($('#pWatts').value) / volt());
        else if ($('#pAmps').value !== '') $('#pWatts').value = r1(Number($('#pAmps').value) * volt());
      };
      $('#pAddRail').onclick = () => { $('#pRails').insertAdjacentHTML('beforeend', railRow()); wireCatEditor(kind, cur); };
      document.querySelectorAll('[data-rail-del]').forEach(b => b.onclick = () => { b.closest('tr').remove(); });
    }

    save.onclick = async () => {
      try {
        const r = await post(`/api/${kind}/item`, read());
        libDraft = null; libSel = r.item.uid;
        toast(`« ${[r.item.ref.brand, r.item.ref.model].filter(Boolean).join(' ')} » enregistré, rev ${r.item.rev}`);
        renderLib();
      } catch (e) { toast(e.message, true); }
    };
    const del = $('#catDel');
    if (del) del.onclick = async () => {
      const n = ((catData.usage || {})[libSel] || []).length;
      const quoi = kind === 'drivers' ? 'cette carte' : 'cette alimentation';
      if (!await confirmBox(`Retirer ${quoi} ?${n ? `\n${n} node(s) la déclarent : elle sera marquée retirée, jamais effacée, pour que leurs marqueurs gardent un sens.` : '\nAucun node ne la déclare : elle peut disparaître pour de bon.'}`)) return;
      try { await api(`/api/${kind}/item/${encodeURIComponent(libSel)}`, { method: 'DELETE' }); libSel = null; toast('fiche retirée'); renderLib(); }
      catch (e) { toast(e.message, true); }
    };
  }
  let catBasis = 'amps';

  // ── Déduire les produits de ce qui est déjà branché ───────────────────────
  // Saisir à la main une fiche par ruban quand la flotte les décrit déjà serait
  // du travail pour rien — et une occasion de se tromper. On relève les
  // combinaisons distinctes réellement présentes et on les propose ; rien n'est
  // créé sans validation, et les longueurs deviennent des longueurs types.
  async function guessProducts() {
    let d; try { d = await api('/api/dmx-plan'); } catch (e) { return toast(e.message, true); }
    const sig = new Map();
    for (const n of d.nodes) {
      // la config brute vient de la flotte, pas du plan : c'est elle qui porte
      // le type, l'ordre et les mA — le plan n'en garde que ce qui sert au DMX
      const rec = fleet.nodes.find(x => x.meta.ip === n.ip);
      const ins = (rec && rec.cfg && rec.cfg.hw && rec.cfg.hw.led && rec.cfg.hw.led.ins) || [];
      (n.plan.outputs || []).forEach((o, i) => {
        const r = ins[i]; if (!r || o.ignored) return;
        // une sortie d'un pixel est une sortie désactivée, pas un produit
        if (!(o.len > 1)) return;
        const key = [r.type, (r.order || 0) & 0x0f, (r.order || 0) >> 4, r.ledma ?? 55].join('|');
        if (!sig.has(key)) sig.set(key, { type: r.type, order: (r.order || 0) & 0x0f, wswap: (r.order || 0) >> 4, ledma: r.ledma ?? 55, lens: new Set(), nodes: new Set() });
        const e = sig.get(key); e.lens.add(o.len); e.nodes.add(n.name || n.ip);
      });
    }
    // ce qui correspond déjà à une fiche existante n'a pas à être reproposé
    const connus = new Set((libData ? libData.products : []).map(p => `${p.led.type}|${p.led.order}|${p.led.wswap}|${p.led.ledma}`));
    const neufs = [...sig.values()].filter(x => !connus.has(`${x.type}|${x.order}|${x.wswap}|${x.ledma}`));
    if (!neufs.length) return toast('rien de nouveau : toutes les combinaisons branchées ont déjà une fiche');

    const lignes = neufs.map((x, i) => `<label class="chip" style="display:flex;gap:8px;align-items:flex-start;margin:4px 0">
      <input type="checkbox" data-guess="${i}" checked>
      <span><b>${esc(LED_TYPES[x.type] || x.type)}</b> · ordre ${esc(COLOR_ORDERS[x.order] || x.order)}${x.wswap ? ` · blanc ${esc(WHITE_SWAPS[x.wswap] || x.wswap)}` : ''} · ${x.ledma} mA/pixel
      <br><span class="muted">longueurs : ${[...x.lens].sort((a, b) => a - b).join(', ')} px — ${[...x.nodes].slice(0, 3).join(', ')}${x.nodes.size > 3 ? '…' : ''}</span>
      <br><input data-guessname="${i}" value="${esc([...x.nodes][0].replace(/[_ ].*$/, ''))}" placeholder="nom du produit" style="width:200px;margin-top:3px"></span></label>`).join('');
    const box = document.createElement('div'); box.className = 'pop'; box.style.cssText = 'left:50%;top:12%;transform:translateX(-50%);max-width:560px;max-height:70vh;overflow:auto';
    box.innerHTML = `<div class="pop-head">${neufs.length} combinaison(s) branchée(s) sans fiche</div>
      <div class="pop-body">Chacune correspond à un ruban réellement présent sur la flotte. Les longueurs deviennent des longueurs types ; la tension et les watts restent à renseigner, ils ne sont nulle part dans la configuration des nodes.</div>
      <div style="padding:0 10px">${lignes}</div>
      <div class="pop-actions"><button class="pop-cancel">Annuler</button><button class="pop-act green">Créer</button></div>`;
    document.body.appendChild(box);
    const done = () => box.remove();
    box.querySelector('.pop-cancel').onclick = done;
    box.querySelector('.pop-act').onclick = async () => {
      const choisis = neufs.filter((_, i) => box.querySelector(`[data-guess="${i}"]`).checked);
      let n = 0;
      for (const [i, x] of neufs.entries()) {
        if (!box.querySelector(`[data-guess="${i}"]`).checked) continue;
        const nom = box.querySelector(`[data-guessname="${i}"]`).value.trim() || `Ruban ${x.ledma} mA`;
        try {
          await post('/api/library/product', { ref: { brand: '', model: nom },
            led: { type: x.type, order: x.order, wswap: x.wswap, ledma: x.ledma },
            presets: [...x.lens].sort((a, b) => a - b).map(px => ({ px })) });
          n++;
        } catch (e) { toast(`${nom} : ${e.message}`, true); }
      }
      done();
      toast(`${n} fiche(s) créée(s) sur ${choisis.length}`);
      await loadLedProfiles(); renderLib();
    };
  }


  // ── Connexion GitHub, en une fois ─────────────────────────────────────────
  // GitHub rend un code court à taper sur son site ; on interroge ensuite
  // jusqu'à ce que l'utilisateur ait validé. Aucun logiciel à installer, et
  // le code est affiché en grand parce qu'il se recopie à la main.
  let ghPoll = null;
  async function startGithubLogin() {
    const box = $('#ghDevice'); if (!box) return;
    clearInterval(ghPoll);
    box.innerHTML = '<div class="muted">connexion à GitHub…</div>';
    let d; try { d = await post('/api/library/login/start', {}); }
    catch (e) { box.innerHTML = `<div class="st-bad">${esc(e.message)}</div>`; return; }
    box.innerHTML = `<div class="ghdevice">
        <div>Ouvrir <a href="${esc(d.url)}">${esc(d.url)}</a> et saisir ce code :</div>
        <div class="ghcode" id="ghCode" title="cliquer pour copier">${esc(d.userCode)}</div>
        <div class="muted">le code expire dans ${Math.round(d.expiresIn / 60)} minutes · l'attente se termine toute seule</div>
      </div>`;
    $('#ghCode').onclick = () => { navigator.clipboard.writeText(d.userCode).then(() => toast('code copié'), () => {}); };
    openExternal(d.url);
    const deadline = Date.now() + d.expiresIn * 1000;
    ghPoll = setInterval(async () => {
      if (Date.now() > deadline) { clearInterval(ghPoll); box.innerHTML = '<div class="st-warn">code expiré — recommencer</div>'; return; }
      let r; try { r = await post('/api/library/login/poll', {}); }
      catch (e) { clearInterval(ghPoll); box.innerHTML = `<div class="st-bad">${esc(e.message)}</div>`; return; }
      if (r.pending) return;                       // pas encore validé : c'est normal
      clearInterval(ghPoll); box.innerHTML = '';
      toast(`connecté à GitHub — ${r.login || 'compte lié'}`);
      renderRemote();
    }, Math.max(5, d.interval) * 1000);
  }

  // ── Le dépôt partagé ──────────────────────────────────────────────────────
  // Deux boutons distincts, jamais un « Synchroniser » : un bouton unique cache
  // le sens de circulation des données, et c'est ainsi qu'on écrase le travail
  // d'un collègue sans s'en rendre compte. Rafraîchir tire, Publier pousse.
  async function renderRemote() {
    const box = $('#libremote'); if (!box) return;
    let r; try { r = await api('/api/library/remote'); } catch { box.innerHTML = ''; return; }
    const connecte = r.hasToken;
    box.innerHTML = `<h2 style="margin-top:16px">Dépôt partagé
        <span class="muted">${r.repo ? esc(r.repo) : 'non configuré'}${r.lastSyncAt ? ` · dernière synchro ${new Date(r.lastSyncAt).toLocaleString()}` : ''}</span></h2>
      ${r.lastError ? `<div class="st-bad" style="margin-bottom:8px">${esc(r.lastError)}</div>` : ''}
      <div class="ghauth">
        ${connecte
    ? `<span class="st-ok">● connecté${r.login ? ` — <b>${esc(r.login)}</b>` : ''}</span>
             <span class="muted">${r.source === 'gh' ? 'par GitHub CLI, aucun jeton conservé ici' : r.source === 'device' ? 'connexion gardée, chiffrée pour ce compte Windows' : `jeton saisi à la main ${esc(r.tail)}`} — c'est ce nom qui signe les produits publiés</span>
             <span class="spacer"></span><button id="ghOut" class="rowbtn">Se déconnecter</button>`
    : `<button id="ghIn" class="rowbtn primary">Se connecter à GitHub</button>
             <span class="muted">une seule fois : la connexion est gardée d'un lancement à l'autre, et survit aux mises à jour de l'application</span>`}
      </div>
      <div id="ghDevice"></div>
      <div class="setrow" style="max-width:700px;margin-top:8px">
        <label for="ghRepo">Dépôt</label><div><input id="ghRepo" value="${esc(r.repo)}" placeholder="proprietaire/depot" style="width:260px">
          <input id="ghBranch" value="${esc(r.branch)}" style="width:80px" title="branche">
          <button id="ghSave" class="rowbtn">Enregistrer</button></div>
        <div class="hint">un fichier par produit, nommé par son identifiant — deux postes ne peuvent donc jamais se disputer un nom</div>
        <label for="ghAuto">Synchronisation</label>
        <div><label class="chip"><input type="checkbox" id="ghAuto"${r.auto ? ' checked' : ''}> automatique</label>
          <span class="muted">au démarrage, toutes les 10 min, et après chaque modification</span></div>
        <div class="hint">sans danger uniquement parce qu'une publication ne peut rien écraser : sur collision, la version en ligne devient la base et la nôtre repart au-dessus</div>
      </div>
      <div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button id="ghPull" class="rowbtn"${r.repo ? '' : ' disabled'} title="tire le dépôt. Jamais destructif : un produit modifié ici et pas encore publié n'est pas écrasé.">↓ Rafraîchir</button>
        <button id="ghPush" class="rowbtn"${r.repo && connecte && r.pending ? '' : ' disabled'} title="publie les fiches modifiées ici — produits, drivers et alimentations. Sur collision, la version en ligne devient la base et la nôtre repart au-dessus : rien n'est jamais écrasé.">↑ Publier${r.pending ? ` (${r.pending})` : ''}</button>
        <span class="muted" style="font-size:12px">${r.pending ? `${r.pending} fiche(s) pas encore publiée(s)` : 'tout est publié'}</span>
        <span class="spacer"></span>
        <details class="ghadv"><summary class="muted">autre méthode de connexion</summary>
          <div class="setrow" style="margin-top:6px">
            <label for="ghToken">Jeton personnel</label>
            <div><input id="ghToken" type="password" placeholder="ghp_… portée « Contents: read and write » sur ce seul dépôt" style="width:300px">
              <button id="ghSaveTok" class="rowbtn">Utiliser</button></div>
            <div class="hint">plus restreint qu'une connexion normale, mais à renouveler à la main quand il expire</div>
            <label>GitHub CLI</label>
            <div><button id="ghCli" class="rowbtn">Utiliser la session « gh »</button></div>
            <div class="hint">si GitHub CLI est installé et connecté : rien n'est alors conservé par Fleet, le jeton lui est demandé à chaque usage</div>
          </div>
        </details>
      </div>`;

    const save = async (body, msg) => {
      try { await post('/api/library/remote', body); toast(msg); renderRemote(); }
      catch (e) { toast(e.message, true); }
    };
    $('#ghSave').onclick = () => save({ repo: $('#ghRepo').value, branch: $('#ghBranch').value }, 'dépôt enregistré');
    $('#ghAuto').onchange = () => save({ auto: $('#ghAuto').checked }, $('#ghAuto').checked ? 'synchronisation automatique activée' : 'synchronisation automatique désactivée');
    $('#ghSaveTok').onclick = () => { if (!$('#ghToken').value) return toast('aucun jeton saisi', true); save({ token: $('#ghToken').value }, 'jeton enregistré'); };
    $('#ghCli').onclick = async () => {
      try { await post('/api/library/login/cli', {}); toast('connecté par GitHub CLI'); renderRemote(); }
      catch (e) { toast(e.message, true, 9000); }
    };
    if ($('#ghOut')) $('#ghOut').onclick = async () => {
      if (!await confirmBox('Se déconnecter de GitHub ?\nLe dépôt et les réglages restent, seule l\'identité s\'en va.')) return;
      try { await post('/api/library/logout', {}); toast('déconnecté'); renderRemote(); } catch (e) { toast(e.message, true); }
    };
    if ($('#ghIn')) $('#ghIn').onclick = startGithubLogin;
    $('#ghPull').onclick = async () => {
      try {
        const x = await post('/api/library/pull', {});
        const bits = [x.added.length && `${x.added.length} ajouté(s)`, x.updated.length && `${x.updated.length} mis à jour`, x.unchanged && `${x.unchanged} inchangé(s)`].filter(Boolean);
        toast(bits.join(', ') || 'rien de neuf');
        if (x.kept.length) toast(`gardés tels quels, modifiés ici et pas encore publiés : ${x.kept.join(', ')}`, true, 9000);
        await renderLib(); await loadLedProfiles();
      } catch (e) { toast(e.message, true); }
    };
    $('#ghPush').onclick = async () => {
      if (!await confirmBox(`Publier ${r.pending} fiche(s) vers ${r.repo} ?\nProduits, drivers et alimentations confondus. Rien ne sera écrasé : une fiche modifiée en ligne entre-temps devient la base, et la version d'ici repart au-dessus.`)) return;
      try {
        const x = await post('/api/library/publish', {});
        const reb = x.done.filter(y => y.action === 'rebase');
        toast(`${x.done.length} publié(s)${reb.length ? ` — ${reb.map(y => `« ${y.label} » replacé en rev ${y.rev}`).join(', ')}` : ''}`, false, reb.length ? 9000 : 2500);
        if (x.failed.length) toast(x.failed.map(y => `${y.label} : ${y.error}`).join('\n'), true, 9000);
        await renderLib();
      } catch (e) { toast(e.message, true); }
    };
  }

  // ── Ce que les nodes portent de la bibliothèque ────────────────────────────
  // Chaque node emporte la fiche complète des produits qu'il cite. Un node qui
  // revient d'un hangar, ou d'un poste dont le catalogue était plus avancé, se
  // raconte donc tout seul. Rien n'est recopié sans un clic : c'est ce qui
  // permet de CONSTATER une divergence au lieu de l'effacer.
  const NODELIB = {
    absent: { cls: 'st-warn', txt: 'produit inconnu de ce poste' },
    newer: { cls: 'st-warn', txt: 'le node porte une révision plus récente que la nôtre' },
    older: { cls: 'muted', txt: 'le node porte une révision plus ancienne : il sera remis à jour au prochain enregistrement de sa sortie' },
    diverged: { cls: 'st-bad', txt: 'MÊME révision, réglages DIFFÉRENTS : deux postes ont fait monter le même numéro sur des contenus différents. Le numéro ne départage plus, il faut choisir.' },
  };
  async function renderNodeLib() {
    const box = $('#libnodes'); if (!box) return;
    let d; try { d = await api('/api/library/nodes'); } catch { return; }
    if (!d.nodes.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<h2 style="margin-top:16px">Ce que les nodes portent <span class="muted">${d.nodes.length} node${d.nodes.length > 1 ? 's' : ''} à regarder</span></h2>
      <div class="muted" style="font-size:12px;margin-bottom:8px;max-width:900px">Chaque node emporte la fiche complète des produits que ses sorties citent. Ceux qui ne correspondent pas au catalogue de ce poste sont listés ici — rien n'est repris sans un clic.</div>
      ${d.nodes.map(n => `<div class="libnode"><b>${esc(n.name)}</b> <span class="muted">${n.online ? '' : 'hors ligne · '}copie du ${new Date(n.savedAt).toLocaleDateString()}</span>
        ${n.items.map(it => {
          const s = NODELIB[it.state] || {};
          return `<div class="libnodeitem"><span class="${s.cls || ''}" title="${esc(s.txt || '')}">${esc(it.label)} — rev ${it.rev}${it.mineRev !== null ? ` ici rev ${it.mineRev}` : ''}</span>
            ${it.state === 'older' ? '' : `<button class="rowbtn" data-adopt="${esc(it.uid)}" data-ip="${esc(n.ip)}" title="reprendre cette version dans le catalogue de ce poste, avec sa révision — sans en créer une nouvelle">Reprendre</button>`}</div>`;
        }).join('')}</div>`).join('')}`;
    box.querySelectorAll('[data-adopt]').forEach(b => b.onclick = async () => {
      if (!await confirmBox(`Reprendre ce produit depuis ${esc(b.closest('.libnode').querySelector('b').textContent)} ?\nLa version locale sera remplacée par celle du node, avec sa révision.`)) return;
      try { const r = await post('/api/library/adopt', { ip: b.dataset.ip, uid: b.dataset.adopt }); toast(`« ${libLabel(r.product)} » repris en rev ${r.product.rev}`); await renderLib(); await loadLedProfiles(); }
      catch (e) { toast(e.message, true); }
    });
  }

  // Les usages viennent du sondage de la flotte : ils arrivent APRÈS le premier
  // rendu, et changent quand un node revient ou qu'une sortie est repatchée. On
  // redessine alors, mais jamais sous les doigts de l'utilisateur — une saisie en
  // cours ou un champ actif suspendent le rafraîchissement jusqu'au suivant.
  let libSig = '';
  async function pollLib() {
    if (!isOpen('lib') || libDraft) return;
    const inEditor = document.activeElement && $('#libEditor') && $('#libEditor').contains(document.activeElement);
    if (inEditor) return;
    let d; try { d = await api('/api/library'); } catch { return; }
    const sig = JSON.stringify([d.products.map(p => [p.uid, p.rev, p.retired]), d.usage]);
    if (sig === libSig) return;
    libSig = sig; renderLib();
  }

  const blankProduct = () => ({ uid: null, legacyId: null, rev: 1, slug: '', ref: { brand: '', model: '', sku: '', internal: '', note: '' },
    led: { type: 22, order: 0, wswap: 0, ledma: 55, skip: 0, offRefresh: false, perM: null }, presets: [] });

  function editorHtml(x, used) {
    const d = libData;
    const hasW = (d.whiteSwapTypes || []).includes(Number(x.led.type));
    const opt = (map, cur) => Object.entries(map || {}).map(([v, l]) => `<option value="${v}"${Number(v) === Number(cur) ? ' selected' : ''}>${esc(l)}</option>`).join('');
    return `<h2>${x.uid ? `Modifier <span class="revchip">rev ${x.rev}</span>` : 'Nouveau produit'}
        <span class="spacer"></span>
        ${x.uid ? '<button id="libDel" class="rowbtn">Retirer</button>' : ''}
        <button id="libSave" class="rowbtn primary">Enregistrer</button></h2>
      ${x.uid ? `<div class="muted" style="font-size:11px;margin:-6px 0 8px">identifiant <span class="mono">${esc(x.uid)}</span>${x.legacyId ? ` · ancien marqueur <span class="mono">${esc(x.legacyId)}</span>, toujours reconnu` : ''}</div>` : ''}
      <div class="setrow">
        <label for="lbBrand">Marque</label><div><input id="lbBrand" value="${esc(x.ref.brand)}" style="width:190px"></div>
        <label for="lbModel">Modèle</label><div><input id="lbModel" value="${esc(x.ref.model)}" style="width:190px"></div>
        <div class="hint">marque ou modèle obligatoire${x.slug ? ` · fichier <span class="mono">${esc(x.slug)}.json</span>, figé : renommer ne le change pas` : ''}</div>
        <label for="lbSku">Référence</label><div><input id="lbSku" value="${esc(x.ref.sku)}" placeholder="fabricant" style="width:150px"> <input id="lbInt" value="${esc(x.ref.internal)}" placeholder="interne" style="width:120px"></div>
        <label for="lbNote">Note</label><div><input id="lbNote" value="${esc(x.ref.note)}" style="width:100%;max-width:330px"></div>
        <div class="hint">corriger un nom ou une note ne fait pas monter la révision : les nodes déjà patchés restent à jour</div>

        <label for="lbType">Type de LED</label><div><select id="lbType">${opt(d.ledTypes, x.led.type)}</select></div>
        <label for="lbOrder">Ordre des couleurs</label><div><select id="lbOrder">${opt(d.colorOrders, x.led.order)}</select></div>
        <div class="hint">interne à WLED : le flux DMX reçu reste toujours RGB(W) dans l'ordre naturel</div>
        <label for="lbWswap">Échange du blanc</label>
        <div>${hasW ? `<select id="lbWswap">${opt(d.whiteSwaps, x.led.wswap)}</select>` : '<span class="muted">— ce type n\'a pas de canal blanc</span>'}</div>
        <div class="hint"></div>

        <label for="lbPerM">LEDs par mètre</label><div><input type="number" id="lbPerM" value="${x.led.perM ?? ''}" min="1" placeholder="—" style="width:70px"></div>
        <div class="hint">nomme les longueurs automatiquement et alimente le calculateur 📏</div>
        <label for="lbMaSel">Consommation</label>
        <div><select id="lbMaSel">${(d.ledMaPresets || []).map(([v, l]) => `<option value="${v}"${Number(v) === Number(x.led.ledma) ? ' selected' : ''}>${esc(l)}</option>`).join('')}<option value="__c"${!(d.ledMaPresets || []).some(([v]) => Number(v) === Number(x.led.ledma)) ? ' selected' : ''}>Personnalisé…</option></select>
          <input type="number" id="lbMa" value="${x.led.ledma}" min="0" max="${d.ledMaMax || 255}" style="width:64px;${!(d.ledMaPresets || []).some(([v]) => Number(v) === Number(x.led.ledma)) ? '' : 'display:none'}"> <span id="lbMaU" class="muted"${!(d.ledMaPresets || []).some(([v]) => Number(v) === Number(x.led.ledma)) ? '' : ' hidden'}>mA par pixel</span></div>
        <div class="hint">Le chiffre dépend du <b>type de ruban</b> — c'est pour ça que WLED propose des cas courants plutôt qu'un nombre libre. C'est aussi le chiffre sur lequel il calcule son freinage : sous-déclaré, il freine trop peu, la tension s'effondre et les LEDs déconnent sans qu'aucune erreur ne s'affiche. Déclarer 55 là où la réalité est 120 laisse passer 2,2 fois le courant prévu. Compter par <b>pixel</b>, pas par LED, quand un pixel en contient plusieurs.</div>
        <label for="lbSkip">LEDs sautées</label><div><input type="number" id="lbSkip" value="${x.led.skip}" min="0" style="width:70px"> <span class="muted">en tête de câble</span></div>
        <label for="lbRef">Off refresh</label><div><label class="chip"><input type="checkbox" id="lbRef"${x.led.offRefresh ? ' checked' : ''}> rafraîchir même éteint</label></div>
        <div class="hint"></div>
      </div>
      <h2 style="margin-top:14px">Longueurs types <span class="muted">une par référence de produit fini</span></h2>
      <table class="outs" style="width:auto"><tbody id="lbPresets">${(x.presets.length ? x.presets : [{ label: '', px: '' }]).map(presetRow).join('')}</tbody></table>
      <button id="lbAddPreset" class="rowbtn">＋ longueur</button>
      ${used.length ? `<h2 style="margin-top:14px">Utilisé par <span class="muted">${used.length} sortie${used.length > 1 ? 's' : ''}</span></h2>
        <div class="libused">${used.map(u => {
          const st = REV_STATE[u.revState];
          return `<div${st ? ` class="${st.cls}" title="${esc(st.txt)}"` : ''}>${esc(u.name)} · sortie ${u.index + 1} <span class="mono">${u.len} px</span>${u.rev ? ` · rev ${u.rev}` : ''}</div>`;
        }).join('')}</div>` : ''}`;
  }
  const presetRow = p => `<tr>
    <td><input data-pl value="${esc(p.label || '')}" placeholder="auto" style="width:110px"></td>
    <td><input type="number" data-px value="${p.px ?? ''}" min="1" style="width:70px"> px</td>
    <td><button class="rowbtn" data-rmpreset title="retirer cette longueur">✕</button></td></tr>`;

  function wireLibEditor() {
    const ed = $('#libEditor'); if (!ed || !$('#libSave')) return;
    const read = () => ({
      uid: libDraft ? libDraft.uid : libSel,
      ref: { brand: $('#lbBrand').value, model: $('#lbModel').value, sku: $('#lbSku').value, internal: $('#lbInt').value, note: $('#lbNote').value },
      led: { type: Number($('#lbType').value), order: Number($('#lbOrder').value), wswap: $('#lbWswap') ? Number($('#lbWswap').value) : 0,
        ledma: Number($('#lbMa').value), skip: Number($('#lbSkip').value), offRefresh: $('#lbRef').checked,
        perM: $('#lbPerM').value === '' ? null : Number($('#lbPerM').value) },
      presets: [...ed.querySelectorAll('#lbPresets tr')]
        .map(tr => ({ label: tr.querySelector('[data-pl]').value, px: Number(tr.querySelector('[data-px]').value) }))
        .filter(v => v.px > 0),
    });
    // changer le type fait apparaître ou disparaître l'échange du blanc : on
    // redessine en gardant la saisie en cours plutôt que de la perdre
    $('#lbType').onchange = () => { libDraft = { ...blankProduct(), ...read() }; renderLib(); };
    // le champ libre n'apparaît que si aucun cas courant ne convient
    $('#lbMaSel').onchange = () => {
      const custom = $('#lbMaSel').value === '__c';
      $('#lbMa').style.display = custom ? '' : 'none';
      $('#lbMaU').hidden = !custom;
      if (!custom) $('#lbMa').value = $('#lbMaSel').value;
    };
    $('#lbAddPreset').onclick = () => { $('#lbPresets').insertAdjacentHTML('beforeend', presetRow({ label: '', px: '' })); wireLibEditor(); };
    ed.querySelectorAll('[data-rmpreset]').forEach(b => b.onclick = () => {
      const tb = $('#lbPresets');
      if (tb.rows.length > 1) b.closest('tr').remove();
      else { b.closest('tr').querySelector('[data-px]').value = ''; b.closest('tr').querySelector('[data-pl]').value = ''; }
    });
    $('#libSave').onclick = async () => {
      try {
        const r = await post('/api/library/product', read());
        libDraft = null; libSel = r.product.uid;
        toast(`« ${libLabel(r.product)} » enregistré, rev ${r.product.rev}`);
        await renderLib(); await loadLedProfiles();
      } catch (e) { toast(e.message, true); }
    };
    const del = $('#libDel');
    if (del) del.onclick = async () => {
      const x = libData.products.find(y => y.uid === libSel); if (!x) return;
      const used = (libData.usage || {})[libSel] || [];
      const why = used.length
        ? `\n${used.length} sortie(s) l'utilisent : le produit est marqué retiré, jamais effacé, pour que leurs marqueurs gardent un sens.`
        : '\nAucune sortie ne l\'utilise : il peut disparaître pour de bon.';
      if (!await confirmBox(`Retirer « ${libLabel(x)} » ?${why}`)) return;
      try {
        await api(`/api/library/product/${encodeURIComponent(libSel)}`, { method: 'DELETE' });
        libSel = null; toast('produit retiré');
        await renderLib(); await loadLedProfiles();
      } catch (e) { toast(e.message, true); }
    };
  }

  // ── settings panel (settings.json, restart through the launcher) ───────────
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
      </div>
      <h2 style="margin-top:18px">Application</h2>
      <div class="setrow">
        <label>Version</label>
        <div><b id="sVer">…</b> <span class="muted" style="font-size:11px">· <a href="https://github.com/Tensegrity-Lighting-Service/WLED-Fleet/releases" target="_blank" rel="noopener">releases</a></span></div>
        <div class="hint">dossier de l'app : <span class="mono" id="sDir">…</span></div>
        <label for="sChan">Canal</label>
        <div><select id="sChan">${Object.entries(CHANNELS).map(([v, l]) => `<option value="${v}"${v === updChannel ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
        <div class="hint">La beta reçoit les nouveautés avant qu'elles soient éprouvées : à réserver à un poste qui n'est pas en exploitation. Le canal stable ne peut pas attraper une beta par accident, même plus récente. Changer de canal ne réinstalle rien — la vérification suivante ira simplement voir ailleurs, et vos données ne bougent pas (elles vivent dans Documents).</div>
        <label>Mise à jour</label>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button id="sUpd" class="rowbtn">Vérifier maintenant</button>
          <span id="sUpdMsg" class="muted"></span>
          <button id="sUpdGo" class="rowbtn primary" hidden>Installer</button>
        </div>
        <div class="hint" id="sUpdHint">l'app se vérifie aussi toute seule quelques secondes après son démarrage, et ne propose rien quand elle est déjà à jour.</div>
      </div>`;
    // ── état de la mise à jour : dire explicitement « à jour » plutôt que de ne rien dire
    (async () => {
      try { const a = await api('/api/about'); $('#sVer').textContent = a.version || '?'; $('#sDir').textContent = a.dir || ''; } catch { /* pas grave */ }
    })();
    const showUpdate = st => {
      const msg = $('#sUpdMsg'), go = $('#sUpdGo'); if (!msg) return;
      const when = st.at ? ` (${new Date(st.at).toLocaleTimeString()})` : '';
      go.hidden = st.status !== 'disponible';
      msg.className = st.status === 'erreur' ? 'st-bad' : st.status === 'disponible' ? 'st-ok' : 'muted';
      msg.textContent = {
        jamais: 'pas encore vérifié',
        navigateur: 'ouvert dans un navigateur : la mise à jour n\'existe que dans l\'app native',
        ajour: `à jour${when}`,
        disponible: `version ${st.version} disponible${when}`,
        erreur: `échec : ${st.error}${when}`,
      }[st.status] || '';
    };
    showUpdate(updateState);
    // changer de canal revérifie aussitôt : sans ça on ne sait pas ce qu'on
    // vient de choisir, et il faudrait cliquer « Vérifier » pour le découvrir
    $('#sChan').onchange = async () => {
      setChannel($('#sChan').value);
      showUpdate({ ...updateState, status: 'jamais' });
      showUpdate(await runUpdateCheck());
    };
    $('#sUpd').onclick = async () => {
      const b = $('#sUpd'); b.disabled = true; b.textContent = 'vérification…';
      showUpdate(await runUpdateCheck());
      b.disabled = false; b.textContent = 'Vérifier maintenant';
    };
    $('#sUpdGo').onclick = async () => {
      try { await installAppUpdate(); } catch (e) { toast(`mise à jour : ${e.message || e}`, true); showUpdate({ ...updateState, status: 'erreur', error: e.message || String(e) }); }
    };
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
  let pairNets = null, pairPc = null, pairJob = null, pairShow = null, pairAll = false, pairApConfigured = null;
  // radar mode (NetSpot-like): native WlanScan every 8 s while the tab is open, signal history per BSSID
  let pairRadar = false, pairRadarTimer = null, pairScanning = false; const pairHist = new Map();
  const spark = (arr, w = 60, h = 14) => { if (!arr || !arr.length) return ''; const pts = arr.map((v, i) => `${(i / Math.max(1, arr.length - 1)) * w},${h - Math.round((v / 100) * (h - 2)) - 1}`).join(' '); return `<svg width="${w}" height="${h}" style="vertical-align:middle;margin-left:6px"><polyline points="${pts}" fill="none" stroke="var(--info)" stroke-width="1.5"/></svg>`; };
  async function pollPair() {
    if (!isOpen('pair')) return;
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
    if (on) { scanPair(false); pairRadarTimer = setInterval(() => { if (isOpen('pair') && !(pairJob && pairJob.status === 'running')) scanPair(false); else if (!isOpen('pair')) setRadar(false); }, 8000); }
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
  setInterval(() => { if (isOpen('pair') && pairJob && pairJob.status === 'running') pollPair(); }, 2000);

  // ── fleet snapshots (offline store, export / import / compare / restore) ───
  let snapList = [], snapView = null; // snapView = {id, mode:'diff'|'restore', data}
  const post = (u, b) => api(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
  async function pollSnap() {
    if (!isOpen('snap')) return;
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
    if (!await confirmBox(`Importer le showfile${doc.exportedAt ? ' du ' + new Date(doc.exportedAt).toLocaleString() : ''} ?\n\nRemplace : ${Object.entries(what).filter(([, v]) => v).map(([k]) => ({ settings: 'réglages', antennas: 'antennes + mots de passe', nodes: 'nodes, groupes, bibliothèques et plan d'alimentation', snapshots: 'sauvegardes', firmware: 'catalogue firmware' })[k]).join(', ')}${what.settings ? '\n\nLe serveur redémarrera pour appliquer les réglages.' : ''}`)) return;
    try {
      const r = await post('/api/showfile/import', { file: doc, passphrase: pass || undefined, what });
      if (r.layout && $('#sfW_layout').checked) { try { if (r.layout.colOrder) localStorage.setItem('wf.colOrder', JSON.stringify(r.layout.colOrder)); if (r.layout.colWidths) localStorage.setItem('wf.colWidths', JSON.stringify(r.layout.colWidths)); if (r.layout.hiddenGroups) localStorage.setItem('wf.hiddenGroups', JSON.stringify(r.layout.hiddenGroups)); } catch { /* ignore */ } }
      toast(`importé : ${r.done.join(', ')}${r.restarting ? ' · redémarrage…' : ''}`);
      setTimeout(() => location.reload(), r.restarting ? 6000 : 1500);
    } catch (e) { toast(e.message, true); }
  }
  function showfileHtml() {
    return `<div class="subbox" style="margin-bottom:10px"><h2 style="margin-top:0">Showfile <span class="muted" style="text-transform:none;letter-spacing:0" title="un seul fichier .wledfleet avec tout : réglages, antennes et leurs mots de passe, nodes et groupes, les trois bibliothèques, le plan d'alimentation, sauvegardes de configs, catalogue firmware, disposition des colonnes">tout le show dans un fichier ⓘ</span></h2>
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
        <input type="password" id="sfPass" placeholder="phrase secrète (option)" style="width:190px" title="si renseignée, le fichier est chiffré (AES-256) : à conserver, sans elle le fichier est illisible. Vide = fichier en clair, mots de passe lisibles.">
        <label class="chip" title="ajoute le journal des modifications et l'historique des scans radio (plus gros, utile pour un rapport)"><input type="checkbox" id="sfJournal"> avec le journal</label>
        <button id="sfExport" class="primary" title="télécharge le showfile">⬇ Exporter le showfile</button>
        <span style="width:16px"></span>
        <label class="rowbtn" style="cursor:pointer" title="importer un showfile (.wledfleet) : d'ici ou d'un autre PC">⬆ Importer un showfile <input type="file" id="sfImport" accept=".wledfleet,.json" style="display:none"></label>
        <span class="muted">remplacer :</span>
        <label class="chip"><input type="checkbox" id="sfW_settings" checked> réglages</label>
        <label class="chip"><input type="checkbox" id="sfW_antennas" checked> antennes</label>
        <label class="chip"><input type="checkbox" id="sfW_nodes" checked title="la liste des nodes, leurs groupes, les trois bibliothèques (produits, drivers, alimentations) et le plan d'alimentation — les fiches gardent leurs identifiants, les marqueurs posés sur les nodes continuent donc de désigner la bonne chose"> nodes et bibliothèques</label>
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
  let apData = null, apPresetData = null, apPresetLoading = false;
  const sigBar = dbm => { if (dbm == null) return ''; const pct = Math.max(0, Math.min(100, Math.round((dbm + 90) * 2))); const col = dbm >= -60 ? 'var(--accent)' : dbm >= -72 ? 'var(--warn)' : 'var(--bad)'; return `<span class="sig" title="${dbm} dBm"><i style="width:${pct}%;background:${col}"></i></span>`; };
  async function pollAp() {
    try {
      const [a, wz] = await Promise.all([api('/api/ap'), api('/api/wizard').catch(() => null)]);
      apData = a; if (wz) wizData = wz;
      const n = apData.ok ? apData.clients.length : 0;
      // Une antenne configurée mais injoignable se signalait en teintant le
      // bouton en rouge. Le bouton est maintenant généré et n'existe pas quand
      // on est dans une autre famille : l'écriture directe levait, et le catch
      // ci-dessous avalait l'erreur — le panneau ne se rendait plus du tout.
      // L'état passe donc par la pastille, comme le reste.
      setBadge('ap', `${apData.configured && !apData.ok ? ' <span class="n" style="background:var(--bad)" title="antenne configurée mais injoignable">!</span>' : ''}${n ? ` <span class="n">${n}</span>` : ''}${wizData && wizData.state === 'connected' ? ' <span class="n" style="background:var(--accent)" title="WiFiman Wizard connecté">W</span>' : ''}`);
      if (isOpen('ap')) renderAp();
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
    // which local NIC the PC uses to reach the antenna (REST + MNDP) : le PC peut
    // avoir plusieurs cartes (ex. partage de connexion iPhone) et Windows peut en
    // choisir une autre que celle reliée au kit — on peut forcer la bonne ici.
    const netIf = (fleet.net && fleet.net.ifaces) || [];
    const bindHtml = netIf.length ? `<div class="aprow" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:6px 0">
        <b>Carte réseau vers l'antenne</b>
        <button class="rowbtn${d.bindAddress ? '' : ' primary'}" data-bind="" title="laisser Windows choisir (par défaut)">auto</button>
        ${netIf.map(i => `<button class="rowbtn${d.bindAddress === i.address ? ' primary' : ''}" data-bind="${esc(i.address)}" title="${esc(i.iface)}">${esc(i.iface)} · ${esc(i.address)}</button>`).join('')}
      </div>
      <div class="hint" style="margin-bottom:6px">si l'app se connecte au mauvais réseau (ex. partage de connexion d'un téléphone) au lieu de la carte reliée au kit, fixer la carte ici force les requêtes vers l'antenne (et sa découverte) sur elle.</div>` : '';
    const wizBar = `<div class="aprow" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:6px 0 10px">${wizardButton()}</div>`;
    if (!d.configured) { const k = keepDetails(p); p.innerHTML = `${bindHtml}${disc}${form('Identifiants de l\'antenne')}${wizBar}${renderWizard()}${wizardExtras()}`; k.restore(); wireApForm(); wireApRows(); wireApBind(); wireWizard(); return; }
    if (!d.ok) { const k = keepDetails(p); p.innerHTML = `${bindHtml}${disc}${form(`Antenne ${esc(d.host)}`, `Erreur : ${d.error}`)}${wizBar}${renderWizard()}${wizardExtras()}`; k.restore(); wireApForm(); wireApRows(); wireApBind(); wireWizard(); return; }
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
      <details class="subbox" data-key="apsys"><summary style="cursor:pointer"><b>Routeur, antennes et identifiants</b></summary>${bindHtml}${tiles}${disc}${form('Ajouter une antenne')}</details>`;
    p.innerHTML = `${head}${actions.replace(/<\/div>`?\s*$/, presetHtml + '</div>')}${auditHtml}${envHtml}${wizHtml}${wizardExtras()}${more}`;
    keptAp.restore();
    wireApForm(); wireApRows(); wireApBind(); wireWizard();
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
  function wireApBind() {
    $('#appanel').querySelectorAll('button[data-bind]').forEach(b => b.onclick = async () => {
      const address = b.dataset.bind;
      b.disabled = true;
      try {
        const r = await api('/api/ap/bind', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address }) });
        toast(address ? `carte réseau vers l'antenne : ${address}` : 'sélection automatique de la carte réseau');
        if (r.apOk === false) toast(`antenne toujours inaccessible : ${r.apError}`, true);
      } catch (e) { toast(e.message, true); }
      apLastKey = ''; pollAp();
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
    const d = apData; const k = d ? `${d.configured}|${d.ok}|${d.error}|${d.bindAddress}|${(d.saved || []).map(s => s.host + s.active).join(',')}|${d.discovered.length}|${d.lastScan ? d.lastScan.at : 0}|${d.scanning}|${wizData ? `${wizData.state}|${wizData.events}|${wizData.error}|${(wizData.surveys || []).length}|${wizDevices ? wizDevices.length : -1}|${wizBusy}` : ''}` : '';
    // never repaint while the user is typing in the form
    const typing = document.activeElement && ['apHost', 'apUser', 'apPass', 'wzLabel', 'wzPython'].includes(document.activeElement.id);
    if (!d || typing || (!d.ok && k === apLastKey && $('#apSave'))) return;
    apLastKey = k; _renderAp();
  };

  // ── firmware repository / updates ──────────────────────────────────────────
  let fwData = null; const fwSel = new Set();
  const fmtSize = b => b == null ? '' : (b / 1048576).toFixed(2) + ' Mo';
  const fmtDate = s => s ? new Date(s).toLocaleDateString() : '';

  async function pollFw() {
    try {
      fwData = await api('/api/firmware' + ($('#fwAll').checked ? '?all=1' : ''));
      const avail = fwData.nodes.filter(n => n.fw && n.fw.available).length;
      setBadge('fw', avail ? ` <span class="n">${avail}</span>` : '');
      if (isOpen('fw')) renderFw();
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
    setInterval(refresh, 2000); setInterval(pollChanges, 2000); setInterval(pollFw, 2000); setInterval(pollAp, 3000); setInterval(pollLib, 3000);
  })();
  // ── tabs: one pane at a time, full height; ⧉ opens the current tab in its own window ──
  // ── Les onglets, en deux niveaux ──────────────────────────────────────────
  // Onze onglets sur une ligne, ça ne se lit plus. Ils sont donc rangés par
  // FAMILLE : ce qu'on regarde (Flotte), ce qu'on conçoit (Show), ce qu'on
  // branche (Matériel), ce qui les relie (Réseau).
  //
  // Le libellé et l'infobulle vivent ici et non dans index.html : avant, l'ordre
  // venait du HTML, le libellé aussi, et l'enregistrement d'ici — trois endroits
  // à tenir cohérents pour un seul onglet. La barre du second niveau est
  // maintenant DÉRIVÉE de cette table, il n'y a plus qu'une source.
  const TABS = {
    grid: { pane: '#tabgrid', label: "Grille",
      title: "la grille des nodes : une ligne par node, une colonne par réglage",
      show: () => {} },
    journal: { pane: '#journal', label: "Journal",
      title: "journal des modifications : chaque relevé est comparé au précédent ; toute différence est consignée avec avant / après et sa source (grille = envoyée d'ici, externe = interface WLED ou autre logiciel, statut = node apparu / disparu, maj = mise à jour firmware). Une modif externe déclenche une alerte et un liseré orange sur la cellule pendant 10 min.",
      show: () => { unseen = 0; renderJournal(); } },
    ap: { pane: '#appanel', label: "Antenne",
      title: "antenne Wi‑Fi (MikroTik RouterOS, lecture seule) : radios, canaux, puissance, clients connectés et ce que l'antenne voit de chaque node. Le badge = nombre de clients Wi‑Fi associés.",
      show: () => { apLastKey = ''; pollAp(); } },
    opt: { pane: '#optpanel', label: "Optimisation",
      title: "préréglages d'optimisation de la liaison radio : côté antenne (plage de canaux, fast roaming, options facultatives) et côté nodes (veille Wi‑Fi, puissance TX, paquets hors séquence), avec l'état réel et les actions",
      show: () => { renderOpt(); } },
    dmx: { pane: '#dmxpanel', label: "Sorties / DMX",
      title: "sorties LED de chaque node (pin, type, ordre, départ, longueur, sens) et leur adresse console univers.canal calculée en direct ; contenu de chaque univers ; conflits d'univers entre nodes. Dans WLED l'univers d'une sortie n'est pas un réglage : il découle du point de départ du node et de la longueur des sorties précédentes. Le badge = nombre de sorties dont le profil (type/ordre/pixels) n'est pas encore dans la bibliothèque locale de profils LED.",
      show: () => { renderDmx(); } },
    graph: { pane: '#graphpanel', label: 'Schéma',
      title: "le plateau vu en schéma : quelle alimentation nourrit quel node, et quelle sortie part de quel node. Les câbles prennent la couleur du pire constat qui les concerne — le schéma EST le rapport de cohérence. Tirer un câble depuis le port d'une alimentation rattache un node ; glisser une boîte la déplace, double-clic sur le fond pour tout revoir.",
      show: () => { renderGraph(); } },
    power: { pane: '#powerpanel', label: "Puissance",
      title: "la chaîne électrique : quelle alimentation nourrit quel node, ce que chacun a le droit de tirer, et si ça tient. Répond à « d'où vient le courant » — Sorties / DMX répond à « où sont les pixels ». Le badge = nombre d'anomalies.",
      show: () => { renderPower(); } },
    lib: { pane: '#libpanel', label: "Bibliothèque",
      title: "catalogue des produits LED de la gamme : pour chaque produit, tous ses réglages de sortie (type, ordre des couleurs, échange du blanc, mA/LED, skip, off refresh, LEDs par mètre) et ses longueurs types. Choisir un produit sur une sortie remplit tous ces champs d'un coup. Le badge = produits jamais publiés dans la bibliothèque partagée.",
      show: () => { renderLib(); } },
    fw: { pane: '#fwpanel', label: "Mises à jour",
      title: "dépôt de firmwares hors-ligne (catalogue GitHub mémorisé + .bin téléchargés localement) et mise à jour OTA des nodes depuis ce dépôt. Le badge = nombre de nodes qui ont une version plus récente disponible.",
      show: () => { pollFw(); } },
    pair: { pane: '#pairpanel', label: "Appairage",
      title: "appairage de nouveaux nodes : le PC se connecte à l'AP du node (WLED-AP, ou réseau ouvert), lui envoie le SSID / mot de passe du show, un nom et une IP fixe, puis revient sur son Wi‑Fi. Le node rejoint la flotte tout seul.",
      show: () => { renderPair(); if (!pairNets) scanPair(); pollPair(); if (pairRadar) setRadar(true); } },
    snap: { pane: '#snappanel', label: "Sauvegardes",
      title: "sauvegardes de la configuration de toute la flotte (cfg.json + presets.json de chaque node), stockées hors ligne sur ce PC : exporter en fichier, importer, comparer avec l'état actuel, restaurer vers les nodes",
      show: () => { pollSnap(); } },
    settings: { pane: '#setpanel', label: "⚙ Réglages",
      title: "réglages de l'application : sous-réseau de la flotte, accès local ou réseau, intervalles, lecture seule, parallélisme OTA. Enregistré dans settings.json, le serveur redémarre.",
      show: () => { renderSettings(); } },
  };
  const FAMILIES = [
    { id: 'fleet', label: 'Flotte', tabs: ['grid', 'journal', 'snap'] },
    { id: 'show', label: 'Show', tabs: ['dmx', 'power', 'graph'] },
    { id: 'hw', label: 'Matériel', tabs: ['lib', 'fw', 'pair'] },
    { id: 'net', label: 'Réseau', tabs: ['ap', 'opt'] },
    { id: 'cfg', label: '⚙', tabs: ['settings'] },
  ];
  const famOf = k => FAMILIES.find(f => f.tabs.includes(k)) || FAMILIES[0];

  // Les pastilles passent par un registre plutôt que d'écrire dans un bouton :
  // le bouton d'un onglet d'une autre famille n'existe pas dans le DOM, et
  // l'ancienne écriture directe aurait simplement perdu le compte.
  const badges = {};
  function setBadge(tab, html) { badges[tab] = html || ''; renderTabBar(); }

  function renderTabBar() {
    const fam = famOf(currentTab);
    // niveau 1 : une pastille de famille = la somme de ce que ses onglets
    // signalent, pour qu'un problème dans une famille qu'on ne regarde pas se
    // voie quand même
    for (const f of FAMILIES) {
      const b = document.querySelector(`[data-fam="${f.id}"]`); if (!b) continue;
      const n = f.tabs.reduce((a, k) => a + (Number((badges[k] || '').replace(/<[^>]*>/g, '').trim()) || 0), 0);
      b.innerHTML = `${esc(f.label)}${n && f.id !== fam.id ? ` <span class="n">${n}</span>` : ''}`;
      b.classList.toggle('active', f.id === fam.id);
    }
    const bar = $('#tabs2'); if (!bar) return;
    bar.innerHTML = fam.tabs.map(k => `<button data-tab="${k}" class="${k === currentTab ? 'active' : ''}" title="${esc(TABS[k].title)}">${esc(TABS[k].label)}${badges[k] || ''}</button>`).join('');
    bar.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  }

  function showTab(name) {
    if (!TABS[name]) name = 'grid';
    if (currentTab === 'dmx' && name !== 'dmx') stopLocating();
    currentTab = name;
    for (const [k, t] of Object.entries(TABS)) $(t.pane).classList.toggle('open', k === name);
    renderTabBar();
    TABS[name].show();
    // Deux mémoires : le dernier onglet vu, et le dernier onglet vu DANS CHAQUE
    // famille. Sans la seconde, revenir sur une famille rouvrirait toujours son
    // premier onglet et il faudrait recliquer à chaque aller-retour.
    try {
      localStorage.setItem('wf.tab', name);
      localStorage.setItem(`wf.tab.${famOf(name).id}`, name);
    } catch { /* ignore */ }
    if (location.hash !== '#tab=' + name) history.replaceState(null, '', location.pathname + location.search + '#tab=' + name);
  }
  // Cliquer une famille rouvre ce qu'on y regardait.
  document.querySelectorAll('[data-fam]').forEach(b => b.onclick = () => {
    const f = FAMILIES.find(x => x.id === b.dataset.fam);
    let last = null; try { last = localStorage.getItem(`wf.tab.${f.id}`); } catch { /* ignore */ }
    showTab(f.tabs.includes(last) ? last : f.tabs[0]);
  });
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

