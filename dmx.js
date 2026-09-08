// Arithmétique du patch DMX — extraite de server.js le 2026-09-08 pour être testable
// (test/dmx.test.js), parce que c'est là que se logeaient les deux bugs de calcul :
// conflits comparés au numéro d'univers seul, et capacité du premier univers supposée
// pleine même quand l'adresse de départ n'est pas 1.
//
// Modes « Multi » de WLED : les pixels sont pris dans l'ordre sur des univers
// consécutifs (170 en RGB = 510 canaux, 128 en RGBW = 512), à partir de dmx.uni /
// dmx.addr. Une sortie (un ruban) est donc le plus souvent à cheval sur deux univers.
// On en déduit, pour chaque sortie, l'univers.canal de son premier et de son dernier
// pixel — ce qu'il faut patcher à la console — au lieu de le deviner.
'use strict';

const MODES_PX = { 4: 3, 5: 3, 6: 4 }; // Multi RGB, Multi DRGB (1 canal de dimmer en tête), Multi RGBW
const RGBW_TYPES = [30, 31, 41, 44, 88];

// px -> {u, ch}. Le PREMIER univers ne porte pas forcément pxPerUni pixels : les
// canaux avant `addr` sont déjà pris, il en contient donc moins. Tout le reste du
// calcul (alignement, « à cheval », univers occupés) doit partir de firstUniPx, pas
// de pxPerUni — c'est l'erreur que faisait la page.
function locator(mode, uni, addr) {
  const chPerPx = MODES_PX[mode];
  if (!chPerPx) return null;
  const pxPerUni = Math.floor(512 / chPerPx);
  const dim = mode === 5 ? 1 : 0;
  const firstUniPx = Math.floor((512 - (addr - 1) - dim) / chPerPx);
  const locate = px => px < firstUniPx
    ? { u: uni, ch: addr + dim + px * chPerPx }
    : { u: uni + 1 + Math.floor((px - firstUniPx) / pxPerUni), ch: 1 + ((px - firstUniPx) % pxPerUni) * chPerPx };
  return { chPerPx, pxPerUni, firstUniPx, hasDimmer: !!dim, locate };
}

// index du premier pixel de chaque univers, dans l'ordre : 0, firstUniPx,
// firstUniPx + pxPerUni, … Sert au test « cette sortie démarre-t-elle bien sur un
// début d'univers ? », qui ne peut pas se réduire à un modulo.
function universeStarts(mode, addr, upTo) {
  const L = locator(mode, 1, addr); if (!L) return [];
  const out = [0];
  for (let px = L.firstUniPx; px <= upTo; px += L.pxPerUni) out.push(px);
  return out;
}
const startsUniverse = (px, mode, addr) => px === 0 || universeStarts(mode, addr, px).includes(px);

// plan complet d'un node. `ins` = hw.led.ins, `ignored` = POSITIONS (0-based) des
// sorties déclarées non câblées, `profiles` = id de profil par position.
function plan({ mode, uni, addr, ins, ignored = [], profiles = [] }) {
  mode = Number(mode); uni = Number(uni) || 1; addr = Number(addr) || 1;
  const ig = new Set(ignored);
  const outs = (ins || []).map((b, i) => ({
    i, profile: profiles[i] || null, pin: (b.pin || []).join('/'), start: b.start, len: b.len,
    rgbw: RGBW_TYPES.includes(b.type), ignored: ig.has(i),
  }));
  const total = outs.reduce((a, o) => Math.max(a, o.start + o.len), 0);
  const L = locator(mode, uni, addr);
  if (!L) return { mode, uni, addr, total, outputs: outs, multi: false, note: 'mode DMX non « Multi » : pas de mapping pixel par pixel' };
  const { chPerPx, pxPerUni, firstUniPx, hasDimmer, locate } = L;

  for (const o of outs) {
    if (!o.len) continue;
    const a = locate(o.start), b = locate(o.start + o.len - 1);
    o.from = `${a.u}.${a.ch}`; o.to = `${b.u}.${b.ch + chPerPx - 1}`;
    o.uFrom = a.u; o.chFrom = a.ch; o.uTo = b.u; o.chTo = b.ch + chPerPx - 1;
    o.universes = b.u - a.u + 1; o.straddles = b.u !== a.u;
    o.aligned = startsUniverse(o.start, mode, addr);
  }
  const lastU = total ? locate(total - 1).u : uni;

  // Canaux réellement occupés, univers par univers, par les seules sorties COMPTÉES :
  // c'est là-dessus que se calculent les conflits entre nodes. Une sortie « non
  // utilisée » ne réserve rien, exactement comme avant.
  const universes = [], occupancy = [];
  for (let u = uni; u <= lastU; u++) {
    const pxStart = u === uni ? 0 : firstUniPx + (u - uni - 1) * pxPerUni;
    const pxEnd = Math.min(total, u === uni ? firstUniPx : pxStart + pxPerUni) - 1;
    const carrying = outs.filter(o => o.len && o.start <= pxEnd && o.start + o.len - 1 >= pxStart);
    for (const o of carrying) {
      if (o.ignored) continue;
      const a = locate(Math.max(o.start, pxStart)), b = locate(Math.min(o.start + o.len - 1, pxEnd));
      occupancy.push({ u, from: a.ch, to: b.ch + chPerPx - 1, out: o.i });
    }
    universes.push({
      u, pxStart, pxEnd, px: pxEnd - pxStart + 1,
      channels: (pxEnd - pxStart + 1) * chPerPx + (u === uni && hasDimmer ? 1 : 0),
      carries: carrying.map(o => `sortie ${o.i + 1} (pin ${o.pin})${o.ignored ? ' (non comptée)' : ''}`),
      ignored: carrying.length > 0 && carrying.every(o => o.ignored),
    });
  }
  // en Multi DRGB le canal de dimmer, juste avant le premier pixel, est à nous aussi
  if (hasDimmer) { const f = occupancy.find(x => x.u === uni); if (f) f.from = Math.min(f.from, addr); }

  return {
    mode, chPerPx, pxPerUni, firstUniPx, uni, addr, total, universesUsed: universes.length,
    firstUni: uni, lastUni: lastU, outputs: outs, universes, occupancy, multi: true, hasDimmer,
  };
}

// Conflit = deux nodes qui se marchent dessus AU CANAL PRÈS, pas seulement sur le même
// numéro d'univers. Partager un univers à des adresses distinctes est le seul moyen de
// tasser des nodes courts (4 boules de 36 px tiennent dans un univers) et c'est
// parfaitement légitime : la version « par univers » l'interdisait de fait.
// nodes = [{ name, plan }] -> [{ universe, from, to, nodes: [a, b] }]
function conflicts(nodes) {
  const byUni = new Map();
  for (const n of nodes) {
    for (const iv of (n.plan && n.plan.occupancy) || []) {
      if (!byUni.has(iv.u)) byUni.set(iv.u, []);
      byUni.get(iv.u).push({ node: n.name, from: iv.from, to: iv.to });
    }
  }
  const out = [];
  for (const [u, list] of byUni) {
    const sorted = [...list].sort((a, b) => a.from - b.from || a.to - b.to);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i], b = sorted[j];
        if (a.node === b.node) continue;
        if (b.from > a.to) break; // trié par début : plus rien ne peut recouvrir a
        const from = b.from, to = Math.min(a.to, b.to);
        const seen = out.find(c => c.universe === u && c.nodes.includes(a.node) && c.nodes.includes(b.node));
        if (seen) { seen.from = Math.min(seen.from, from); seen.to = Math.max(seen.to, to); }
        else out.push({ universe: u, from, to, nodes: [a.node, b.node] });
      }
    }
  }
  return out.sort((a, b) => a.universe - b.universe || a.from - b.from);
}

module.exports = { plan, conflicts, locator, universeStarts, startsUniverse, MODES_PX, RGBW_TYPES };
