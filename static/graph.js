// Le schéma du plateau : alimentations, nodes, sorties, et les câbles entre eux.
//
// ── Pourquoi un fichier à part ─────────────────────────────────────────────
// app.js fait déjà 3 600 lignes et un seul IIFE fermé. Y ajouter une vue
// interactive complète serait le vrai risque de ce chantier. Ce module expose
// window.WF_GRAPH et reçoit ses données en paramètre : il ne sait rien de
// l'application, elle ne sait rien de lui.
//
// ── Pourquoi du SVG, et pas du canvas ──────────────────────────────────────
// Le hit-testing est gratuit — chaque boîte est un élément qui reçoit ses
// propres événements — le thème suit les variables CSS comme le reste de
// l'application, et le texte reste net à tous les zooms. À une soixantaine de
// boîtes, la performance n'entre pas en ligne de compte.
//
// Mais en createElementNS et non en chaînes de caractères, contrairement au
// reste de l'application : une vue interactive se met à jour en DÉPLAÇANT un
// nœud, et réécrire innerHTML à chaque pointermove casserait la capture du
// pointeur — exactement comme un re-rendu casserait un glisser de ligne dans
// la grille.
//
// ── Pourquoi aucune bibliothèque ───────────────────────────────────────────
// Le projet n'a aucune dépendance front. Les candidates sérieuses supposent un
// bundler ou React ; celles utilisables en balise <script> nue apportent leur
// CSS, qui ne suivrait pas le thème. Surtout, le vrai risque est le pointeur
// dans la webview du shell : le drag&drop HTML5 natif n'y déclenche jamais
// (voir app.js), donc toute bibliothèque qui s'appuie sur dragstart/drop
// échouerait — et on ne le découvrirait qu'après installation.
'use strict';
window.WF_GRAPH = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (n, attrs = {}) => { const e = document.createElementNS(NS, n); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };

  const W_PSU = 190, W_NODE = 200, W_OUT = 150, H = 46, GAP_Y = 14, GAP_X = 130, H_OUT = 30;

  // Les positions déplacées à la main vivent dans le navigateur, pas sur les
  // nodes : une coordonnée d'écran n'est pas une information de terrain.
  const load = () => { try { return JSON.parse(localStorage.getItem('wf.graph.pos') || '{}'); } catch { return {}; } };
  const loadCollapsed = () => { try { return JSON.parse(localStorage.getItem('wf.graph.collapsed') || '{}'); } catch { return {}; } };

  function mount(host, opts = {}) {
    host.innerHTML = '';
    const svg = el('svg', { class: 'gsvg' });
    const world = el('g');
    const gEdges = el('g'), gNodes = el('g');
    world.append(gEdges, gNodes);
    svg.append(world);
    host.append(svg);

    let model = { boxes: [], edges: [] };
    let tx = 20, ty = 20, k = 1;
    let pos = load();                        // positions déplacées à la main
    let collapsed = loadCollapsed();
    const applyView = () => world.setAttribute('transform', `translate(${tx},${ty}) scale(${k})`);
    const savePos = () => { try { localStorage.setItem('wf.graph.pos', JSON.stringify(pos)); } catch { /* ignore */ } };
    // « Replacer » : on oublie les positions à la main et on revient à la
    // disposition calculée, qui est déterministe.
    const resetPos = () => { pos = {}; savePos(); update(model.data); fit(); };

    // écran -> monde. Une seule transformation, sur un seul groupe : tout le
    // reste raisonne en coordonnées du modèle.
    const toWorld = (cx, cy) => { const r = svg.getBoundingClientRect(); return { x: (cx - r.left - tx) / k, y: (cy - r.top - ty) / k }; };

    // ── Pan et zoom ────────────────────────────────────────────────────────
    // Zoom par transform et non par viewBox : le viewBox mettrait aussi à
    // l'échelle l'épaisseur des traits et la taille du texte, et les libellés
    // deviendraient illisibles au dézoom.
    svg.addEventListener('wheel', e => {
      e.preventDefault();
      const p = toWorld(e.clientX, e.clientY);
      const k2 = Math.min(3, Math.max(0.25, k * Math.pow(1.1, -e.deltaY / 100)));
      tx += p.x * (k - k2); ty += p.y * (k - k2); k = k2;
      applyView();
    }, { passive: false });

    let drag = null;
    svg.addEventListener('pointerdown', e => {
      const port = e.target.closest('[data-port]');
      const box = e.target.closest('[data-id]');
      if (port && opts.onWire) drag = { kind: 'wire', from: port.dataset.port, ghost: ghostPath() };
      else if (box && !opts.readonly) {
        const b = boxOf(box.dataset.id);
        drag = { kind: 'box', id: box.dataset.id, g: box, start: toWorld(e.clientX, e.clientY), orig: b, fromX: b ? b.x : 0, fromY: b ? b.y : 0 };
      }
      else drag = { kind: 'pan', x: e.clientX - tx, y: e.clientY - ty };
      svg.setPointerCapture(e.pointerId);
      svg.classList.add('dragging');
    });
    svg.addEventListener('pointermove', e => {
      if (!drag) return;
      if (drag.kind === 'pan') { tx = e.clientX - drag.x; ty = e.clientY - drag.y; applyView(); return; }
      const p = toWorld(e.clientX, e.clientY);
      if (drag.kind === 'wire') {
        const a = portOf(drag.from);
        drag.ghost.setAttribute('d', bezier(a.x, a.y, p.x, p.y));
        return;
      }
      // déplacement d'une boîte : on met à jour SON transform et ses seuls
      // câbles. Tout redessiner à chaque pointermove casserait la capture du
      // pointeur, et ferait clignoter le reste du schéma pour rien.
      const b = drag.orig; if (!b) return;
      b.x = drag.fromX + (p.x - drag.start.x);
      b.y = drag.fromY + (p.y - drag.start.y);
      drag.g.setAttribute('transform', `translate(${b.x},${b.y})`);
      redrawEdgesOf(b.id);
    });
    svg.addEventListener('pointerup', e => {
      if (!drag) return;
      svg.classList.remove('dragging');
      if (drag.kind === 'wire') {
        drag.ghost.remove();
        const target = e.target.closest('[data-id]');
        if (target && opts.onWire) opts.onWire(drag.from, target.dataset.id);
      } else if (drag.kind === 'box') {
        const b = boxOf(drag.id);
        if (b) { pos[drag.id] = { x: Math.round(b.x), y: Math.round(b.y) }; savePos(); }
      }
      drag = null;
    });
    svg.addEventListener('dblclick', () => fit());

    function ghostPath() { const p = el('path', { class: 'gghost' }); gEdges.append(p); return p; }
    const boxOf = id => model.boxes.find(b => b.id === id);
    const portOf = id => { const b = boxOf(id); return b ? { x: b.x + b.w, y: b.y + H / 2 } : { x: 0, y: 0 }; };

    return { update, fit, toggle, resetPos };

    function toggle(id) {
      collapsed[id] = !collapsed[id];
      try { localStorage.setItem('wf.graph.collapsed', JSON.stringify(collapsed)); } catch { /* ignore */ }
      update(model.data);
    }

    function update(data) {
      model = build(data, pos, collapsed);
      model.data = data;
      draw();
    }

    // ── Le rendu ───────────────────────────────────────────────────────────
    function draw() {
      gEdges.innerHTML = ''; gNodes.innerHTML = '';
      for (const e2 of model.edges) e2.path = drawEdge(e2);
      for (const b of model.boxes) gNodes.append(drawBox(b));
    }

    function drawEdge(e2) {
      const a = boxOf(e2.from), b = boxOf(e2.to);
      if (!a || !b) return null;
      const p = el('path', { class: `gedge ${e2.level || ''}`, d: bezier(a.x + a.w, a.y + H / 2, b.x, b.y + H / 2) });
      if (e2.title) { const t = el('title'); t.textContent = e2.title; p.append(t); }
      gEdges.append(p);
      return p;
    }
    function redrawEdgesOf(id) {
      for (const e2 of model.edges) {
        if (e2.from !== id && e2.to !== id) continue;
        const a = boxOf(e2.from), b = boxOf(e2.to);
        if (e2.path && a && b) e2.path.setAttribute('d', bezier(a.x + a.w, a.y + H / 2, b.x, b.y + H / 2));
      }
    }

    function drawBox(b) {
      const g = el('g', { 'data-id': b.id, class: `gbox ${b.kind} ${b.level || ''}`, transform: `translate(${b.x},${b.y})` });
      b.x0 = b.x; b.y0 = b.y;   // point de départ d'un éventuel déplacement
      g.append(el('rect', { width: b.w, height: b.h, rx: 7 }));
      const t1 = el('text', { x: 10, y: 19, class: 'gt1' }); t1.textContent = b.label; g.append(t1);
      if (b.sub) { const t2 = el('text', { x: 10, y: 34, class: 'gt2' }); t2.textContent = b.sub; g.append(t2); }
      // un port à droite : c'est de là qu'on tire un câble
      if (b.kind === 'psu') g.append(el('circle', { cx: b.w, cy: H / 2, r: 5, class: 'gport', 'data-port': b.id }));
      if (b.badge) {
        const bd = el('text', { x: b.w - 10, y: 19, class: 'gbadge', 'text-anchor': 'end' });
        bd.textContent = b.badge; g.append(bd);
      }
      if (b.title) { const t = el('title'); t.textContent = b.title; g.append(t); }
      if (b.collapsible) {
        const c = el('text', { x: b.w - 10, y: 34, class: 'gcaret', 'text-anchor': 'end' });
        c.textContent = collapsed[b.id] ? '▸' : '▾';
        c.addEventListener('click', ev => { ev.stopPropagation(); toggle(b.id); });
        g.append(c);
      }
      return g;
    }

    // tout tenir à l'écran : double-clic sur le fond, ou premier affichage
    function fit() {
      if (!model.boxes.length) return;
      const r0 = svg.getBoundingClientRect();
      // Le panneau vient peut-être d'être rendu visible : sans taille, le
      // facteur d'échelle sortirait à zéro et le schéma disparaîtrait. On
      // réessaie à la frame suivante plutôt que de dessiner faux.
      if (r0.width < 20 || r0.height < 20) { requestAnimationFrame(fit); return; }
      const xs = model.boxes.map(b => b.x), ys = model.boxes.map(b => b.y);
      const x2 = Math.max(...model.boxes.map(b => b.x + b.w)), y2 = Math.max(...model.boxes.map(b => b.y + b.h));
      const w = x2 - Math.min(...xs), h = y2 - Math.min(...ys);
      const r = r0;
      k = Math.max(0.25, Math.min(1, Math.min((r.width - 40) / Math.max(1, w), (r.height - 40) / Math.max(1, h))));
      tx = 20 - Math.min(...xs) * k; ty = 20 - Math.min(...ys) * k;
      applyView();
    }
  }

  // Bézier horizontale, sans évitement d'obstacles : c'est là que les heures
  // partent, pour un gain nul sur un graphe en couches où les câbles se
  // croisent peu.
  function bezier(x1, y1, x2, y2) {
    const d = Math.min(140, Math.max(30, Math.abs(x2 - x1) / 2));
    return `M ${x1} ${y1} C ${x1 + d} ${y1}, ${x2 - d} ${y2}, ${x2} ${y2}`;
  }

  // ── La disposition ─────────────────────────────────────────────────────
  // En couches et DÉTERMINISTE, jamais force-directed : le même jeu de données
  // doit toujours donner la même image, sinon deux postes ne voient pas la même
  // chose et un simple rafraîchissement fait tout bouger sous les yeux.
  //
  // Les sorties sont repliées par défaut : 4 467 pixels répartis sur 30 sorties
  // donneraient trente boîtes de plus, et le schéma ne tiendrait plus.
  function build(data, pos, collapsed) {
    const boxes = [], edges = [];
    const at = (id, x, y) => (pos[id] ? { x: pos[id].x, y: pos[id].y } : { x, y });
    let y = 0;

    const worst = cs => (cs || []).reduce((a, c) => (c.level === 'bad' ? 'bad' : c.level === 'warn' && a !== 'bad' ? 'warn' : a), '');

    for (const p of data.psus || []) {
      const py = y;
      const lvl = worst(p.checks);
      const p1 = at(p.uid, 0, py);
      boxes.push({ id: p.uid, kind: 'psu', ...p1, w: W_PSU, h: H, level: lvl,
        label: p.label || '(sans nom)',
        sub: p.capA !== null ? `${p.usedA} A / ${p.capA} A` : 'capacité inconnue',
        badge: p.chargePct !== null ? `${p.chargePct} %` : '',
        title: [p.model ? [p.model.ref.brand, p.model.ref.model].filter(Boolean).join(' ') : 'modèle non renseigné',
          p.location, ...(p.checks || []).map(c => `• ${c.msg}`)].filter(Boolean).join('\n') });

      let ny = py;
      for (const n of p.nodes || []) {
        const full = (data.nodes || []).find(x => x.ip === n.ip) || {};
        const b = full.budget || {};
        const nlvl = worst(b.checks);
        const n1 = at(n.ip, W_PSU + GAP_X, ny);
        boxes.push({ id: n.ip, kind: 'node', ...n1, w: W_NODE, h: H, level: nlvl,
          label: n.name, sub: `${n.maxA} A · ${n.ratio === null ? '—' : `${Math.round(n.ratio * 100)} % blanc`}`,
          collapsible: (b.outputs || []).some(o => !o.ignored && o.len > 0),
          title: [(full.driver ? [full.driver.ref.brand, full.driver.ref.model].filter(Boolean).join(' ') : 'carte non renseignée'),
            `pire cas ${n.worstA} A`, ...(b.checks || []).map(c => `• ${c.msg}`)].filter(Boolean).join('\n') });
        edges.push({ from: p.uid, to: n.ip, level: nlvl || lvl, title: `${p.label} → ${n.name}` });

        let oy = ny;
        if (!collapsed[n.ip]) {
          for (const o of (b.outputs || []).filter(x => !x.ignored && x.len > 0)) {
            const oid = `${n.ip}#${o.i}`;
            const o1 = at(oid, W_PSU + GAP_X + W_NODE + GAP_X, oy);
            boxes.push({ id: oid, kind: 'out', ...o1, w: W_OUT, h: H_OUT,
              label: `Sortie ${o.i + 1}`, sub: `${o.len} px · ${o.ledma} mA`,
              title: o.product ? [o.product.ref.brand, o.product.ref.model].filter(Boolean).join(' ') : 'produit non renseigné' });
            edges.push({ from: n.ip, to: oid, title: `${n.name} → sortie ${o.i + 1}` });
            oy += H_OUT + 8;
          }
        }
        ny = Math.max(ny + H + GAP_Y, oy);
      }
      y = Math.max(py + H + GAP_Y, ny) + 10;
    }

    // les non rattachés en bas, dans leur propre couche : c'est justement ce
    // qu'on veut voir en premier sur un plateau qu'on découvre
    for (const o of data.orphelins || []) {
      const p1 = at(o.ip, W_PSU + GAP_X, y);
      boxes.push({ id: o.ip, kind: 'node orphan', ...p1, w: W_NODE, h: H, level: 'warn',
        label: o.name, sub: `${o.maxA} A · sans alimentation`,
        title: 'Aucune alimentation déclarée : impossible de vérifier ce que ce node a le droit de tirer.' });
      y += H + GAP_Y;
    }
    return { boxes, edges };
  }
  // Le retour EN DERNIER : un return placé plus haut sortirait de la fonction
  // englobante et les const déclarées après ne seraient jamais initialisées.
  return { mount };
})();
