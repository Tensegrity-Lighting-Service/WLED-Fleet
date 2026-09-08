// Bibliothèque partagée : un dépôt GitHub, plusieurs postes qui écrivent.
//
// ── Le problème ─────────────────────────────────────────────────────────────
// Plusieurs instances de Fleet alimentent le même catalogue, sans se parler et
// souvent sans réseau. Deux d'entre elles peuvent modifier le même produit à
// quelques minutes d'intervalle. Une publication naïve — lire, modifier,
// réécrire — fait perdre le travail de la première sans que personne ne s'en
// aperçoive : c'est la panne à éviter en priorité, parce qu'elle est
// silencieuse.
//
// ── Ce qui rend la chose simple ─────────────────────────────────────────────
// Un produit = un fichier, nommé par son uuid : `products/<uid>.json`. Deux
// postes hors ligne ne peuvent donc pas se disputer un nom de fichier, ni un
// numéro à attribuer — c'était tout l'objet du passage à l'uuid. Il n'y a pas
// d'index à tenir : la liste se lit dans l'arbre git, qui donne du même coup
// le `sha` de chaque fichier.
//
// ── Le garde-fou ────────────────────────────────────────────────────────────
// L'API contents de GitHub accepte un `sha` : celui de la version qu'on croit
// écraser. Si le fichier a changé entre-temps, elle répond **409 et n'écrit
// rien**. C'est exactement le « ne pas écraser » demandé, sans machinerie
// maison — et c'est le serveur qui arbitre, pas nous.
//
// ── Ce qu'on fait du 409 ────────────────────────────────────────────────────
// On ne rend pas la main sur un message d'erreur : on REPREND la version en
// ligne comme base, on y réapplique ses propres modifications, et on repart à
// `rev = celle d'en ligne + 1`. Rien n'est perdu d'un côté ni de l'autre, et
// aucun numéro de révision ne désigne jamais deux contenus différents — ce
// dont dépend tout le reste, puisque c'est le numéro qui dit aux nodes s'ils
// sont à jour.
//
// La lecture passe par l'API contents ou l'arbre git, JAMAIS par
// raw.githubusercontent.com : le raw est servi par un cache CDN d'environ cinq
// minutes, on n'y verrait donc pas sa propre écriture, et le `sha` qu'on
// renverrait ensuite serait périmé.
'use strict';
const https = require('https');
const library = require('./library');
const drivers = require('./drivers');
const psus = require('./psus');

const API = 'api.github.com';

// ── Trois types dans un même dépôt ─────────────────────────────────────────
// Un répertoire par type. Les produits gardent `products/` : changer leur
// chemin invaliderait le `blobSha` mémorisé de chacun, le premier rafraîchi
// retéléchargerait tout, et une publication créerait un doublon au nouveau
// chemin sans supprimer l'ancien.
//
// Le `format` inscrit dans chaque fichier n'est pas décoratif : c'est lui qui
// permet de REFUSER un fichier lu au mauvais endroit. Sans cette vérification,
// un driver passé au normalisateur des produits lèverait « marque ou modèle
// requis », rendrait null, et serait ignoré en silence — une entrée disparue
// sans un mot est exactement ce qu'on ne veut pas d'un catalogue partagé.
const SPACES = {
  products: { dir: 'products', format: 'wled-led-product', collection: 'products', catalog: library.catalog },
  drivers: { dir: 'drivers', format: 'wled-fleet-driver', collection: 'drivers', catalog: drivers.catalog },
  psus: { dir: 'psus', format: 'wled-fleet-psu', collection: 'psus', catalog: psus.catalog },
};
// Par défaut les produits : c'est le seul type qui existait avant, et tout
// appelant qui ne précise rien parle d'eux.
const spaceOf = s => (typeof s === 'string' ? SPACES[s] : s) || SPACES.products;
const catalogOf = space => space.catalog || library.catalog;
const pathFor = (uid, space) => `${spaceOf(space).dir}/${uid}.json`;
const DIR = SPACES.products.dir;

// ── Transport ───────────────────────────────────────────────────────────────
// Un seul endroit qui parle à GitHub, pour que les messages d'erreur soient
// dits une fois pour toutes, en clair.
function request(method, apiPath, { token, body, timeoutMs = 20000 } = {}) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: API, path: apiPath, method, timeout: timeoutMs,
      headers: {
        'User-Agent': 'wled-fleet',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        let json = null; try { json = JSON.parse(d); } catch { /* corps vide ou non-JSON */ }
        const st = res.statusCode;
        if (st >= 200 && st < 300) return resolve({ status: st, json, headers: res.headers });
        resolve({ status: st, json, headers: res.headers, error: explain(st, res.headers, json) });
      });
    });
    req.on('error', e => reject(new Error(`GitHub injoignable : ${e.message}`)));
    req.on('timeout', () => req.destroy(new Error('GitHub : délai dépassé')));
    if (payload) req.write(payload);
    req.end();
  });
}

function explain(status, headers, json) {
  const msg = (json && json.message) || '';
  if (status === 401) return 'jeton GitHub invalide ou expiré';
  if (status === 403 && headers['x-ratelimit-remaining'] === '0') {
    const at = Number(headers['x-ratelimit-reset']) * 1000;
    return `quota GitHub épuisé${at ? ` — retour à ${new Date(at).toLocaleTimeString()}` : ''}`;
  }
  if (status === 403) return `droits insuffisants sur le dépôt : ${msg}`;
  if (status === 404) return 'dépôt ou fichier introuvable (nom du dépôt ? portée du jeton ?)';
  if (status === 409 || status === 422) return 'le fichier a changé en ligne depuis la dernière lecture';
  return `GitHub HTTP ${status}${msg ? ` : ${msg}` : ''}`;
}

// ── Décision de publication, sans réseau ────────────────────────────────────
// Séparé du transport exprès : c'est la partie où une erreur coûte cher, et
// c'est celle qu'on peut éprouver hors ligne, cas par cas.
//
// `mine` = le produit local, `theirs` = ce que le dépôt contient (null si le
// fichier n'existe pas encore).
//
//   'create'   rien en ligne : premier dépôt du fichier
//   'skip'     identique en ligne : ne rien écrire, juste noter le sha
//   'adopt'    en ligne plus récent ET contenu identique au nôtre : se ranger
//              dessus, sans rien publier
//   'publish'  notre version part telle quelle
//   'rebase'   les deux ont changé : on repart de la version en ligne, on y
//              remet nos réglages, et on prend `rev = en ligne + 1`
function decide(mine, theirs, space) {
  const substance = catalogOf(spaceOf(space)).substance;
  if (!theirs) return { action: 'create', product: { ...mine, rev: Math.max(1, mine.rev) } };
  const same = substance(mine) === substance(theirs);
  if (same && mine.rev === theirs.rev) return { action: 'skip', product: theirs };
  if (same) {
    // même contenu, numéros différents : le plus haut gagne, personne ne perd
    // rien et on cesse de se croire en désaccord
    const rev = Math.max(mine.rev, theirs.rev);
    return rev === theirs.rev ? { action: 'adopt', product: { ...theirs, rev } } : { action: 'publish', product: { ...mine, rev } };
  }
  // contenus différents. Si notre révision est strictement au-dessus ET qu'on
  // est parti de la version en ligne, notre écriture est une suite légitime.
  if (mine.rev > theirs.rev && mine.basedOnRev === theirs.rev) return { action: 'publish', product: { ...mine } };
  // sinon les deux ont divergé : on se replace au-dessus de la version en
  // ligne, en gardant NOS réglages. La version d'en face n'est pas perdue —
  // elle reste dans l'historique git, et `basedOnRev` dit d'où l'on part.
  return {
    action: 'rebase',
    product: { ...mine, rev: theirs.rev + 1, basedOnRev: theirs.rev,
      slug: theirs.slug, legacyId: theirs.legacyId || mine.legacyId },
  };
}

// Ce qu'un fichier du dépôt contient : le produit, plus de quoi le situer.
const encode = (product, space) => {
  const sp = spaceOf(space);
  return Buffer.from(JSON.stringify({
    format: sp.format, formatVersion: catalogOf(sp).FORMAT_VERSION,
    ...product, origin: 'library', dirty: false, blobSha: undefined,
  }, (k, v) => (v === undefined ? undefined : v), 2)).toString('base64');
};

// Le `format` est VÉRIFIÉ, pas seulement écrit. Avec trois types dans un même
// dépôt, un fichier lu au mauvais endroit — parce qu'on s'est trompé de
// répertoire, ou parce que quelqu'un a déplacé un fichier à la main — serait
// sinon passé au mauvais normalisateur, qui lèverait sur un champ manquant et
// rendrait null. L'entrée disparaîtrait alors sans un mot du catalogue partagé.
function decodeBlob(b64, space) {
  const sp = spaceOf(space);
  let doc;
  try { doc = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); } catch { return null; }
  if (!doc || typeof doc !== 'object') return null;
  // un fichier sans format est un fichier d'avant la vérification : on le
  // tolère dans son propre répertoire, mais jamais ailleurs
  if (doc.format && doc.format !== sp.format) return null;
  try { return catalogOf(sp).normOne({ ...doc, origin: 'library', dirty: false }); }
  catch { return null; }
}

// ── Opérations en ligne ─────────────────────────────────────────────────────
// Liste le dépôt en UNE requête : l'arbre git donne chemin et sha de chaque
// fichier, donc on sait quoi retélécharger sans interroger fichier par fichier.
// UNE requête pour tout le dépôt, quel que soit le nombre de types : l'arbre
// récursif donne chemin et sha de chaque fichier d'un coup. Filtrer trois
// répertoires ne coûte donc pas une requête de plus.
async function listRemote(repo, opts = {}) {
  const { token, branch = 'main' } = opts;
  const spaces = (opts.spaces || Object.keys(SPACES)).map(spaceOf);
  const r = await request('GET', `/repos/${repo}/git/trees/${branch}?recursive=1`, { token });
  if (r.status === 404) return [];                       // dépôt vide : pas une erreur
  if (r.error) throw new Error(r.error);
  const out = [];
  for (const e of r.json.tree || []) {
    if (e.type !== 'blob' || !e.path.endsWith('.json')) continue;
    const sp = spaces.find(x => e.path.startsWith(`${x.dir}/`));
    if (!sp) continue;
    out.push({ path: e.path, sha: e.sha, uid: e.path.slice(sp.dir.length + 1, -5), space: sp, kind: sp.collection });
  }
  return out;
}

async function getProduct(repo, uid, opts = {}) {
  const { token, branch = 'main' } = opts;
  const sp = spaceOf(opts.space);
  const r = await request('GET', `/repos/${repo}/contents/${pathFor(uid, sp)}?ref=${encodeURIComponent(branch)}`, { token });
  if (r.status === 404) return null;
  if (r.error) throw new Error(r.error);
  return { product: decodeBlob(r.json.content || '', sp), sha: r.json.sha };
}
const getItem = getProduct;

// Publie un produit, en se remettant d'un conflit plutôt qu'en abandonnant.
// Renvoie ce qui a réellement été fait, pour que l'interface puisse le dire.
async function publish(repo, mine, opts = {}) {
  const { token, branch = 'main', message, tries = 3 } = opts;
  if (!token) throw new Error('aucun jeton GitHub enregistré');
  const sp = spaceOf(opts.space);
  let known = await getProduct(repo, mine.uid, opts);
  for (let attempt = 1; attempt <= tries; attempt++) {
    const d = decide(mine, known && known.product, sp);
    if (d.action === 'skip' || d.action === 'adopt') return { ...d, sha: known.sha };
    const r = await request('PUT', `/repos/${repo}/contents/${pathFor(mine.uid, sp)}`, {
      token,
      body: {
        message: message || `${catalogOf(sp).label(d.product)} — rev ${d.product.rev}`,
        content: encode(d.product, sp), branch,
        ...(known && known.sha ? { sha: known.sha } : {}),   // sans sha, GitHub refuse d'écraser
      },
    });
    if (!r.error) return { ...d, sha: r.json.content && r.json.content.sha };
    // 409/422 : quelqu'un a écrit entre notre lecture et notre écriture. On
    // relit et on recommence — c'est le seul cas où réessayer a un sens.
    if (r.status !== 409 && r.status !== 422) throw new Error(r.error);
    known = await getProduct(repo, mine.uid, opts);
    if (attempt === tries) throw new Error('le produit est modifié en ligne plus vite qu\'on ne publie — réessayer plus tard');
  }
  throw new Error('publication impossible');
}

// Tire le dépôt : ne retélécharge que les fichiers dont le sha a bougé.
// `stores` = { products: …, drivers: …, psus: … } ou, pour l'ancien appel, un
// seul magasin de produits. On ne retélécharge que les fichiers dont le sha a
// bougé : c'est ce qui rend un rafraîchissement quotidien gratuit.
async function pull(repo, stores, opts = {}) {
  const byKind = stores && (stores.products || stores.drivers || stores.psus) ? stores : { products: stores };
  const remote = await listRemote(repo, opts);
  const fetched = [], unchanged = [];
  for (const entry of remote) {
    const cat = catalogOf(entry.space);
    const mine = cat.resolve(byKind[entry.kind], entry.uid);
    if (mine && mine.blobSha === entry.sha) { unchanged.push(entry.uid); continue; }
    const got = await getProduct(repo, entry.uid, { ...opts, space: entry.space });
    if (got && got.product) fetched.push({ ...got.product, blobSha: got.sha, kind: entry.kind });
  }
  return { fetched, unchanged, remote };
}

// ── Connexion : le « device flow » ──────────────────────────────────────────
// Se connecter à GitHub depuis une application de bureau sans dépendre d'un
// binaire extérieur ni embarquer de secret. GitHub rend un code court, l'utilisateur
// le tape sur github.com/login/device, et on interroge jusqu'à ce que le jeton
// arrive.
//
// Le `client_id` d'une OAuth App n'est PAS un secret : il est prévu pour être
// distribué avec l'application. Le device flow est justement le mode « client
// public », sans `client_secret` — un secret embarqué dans un installeur
// n'étant de toute façon pas un secret.
//
// Portée demandée : `repo`. GitHub n'offre pas de portée plus fine pour une
// OAuth App ; c'est le prix de l'absence de dépendance. Un jeton à portée
// restreinte reste possible à la main, et le mode « saisie manuelle » existe
// pour ça.
const DEVICE_HOST = 'github.com';

function formPost(host, apiPath, body, timeoutMs = 15000) {
  const payload = Buffer.from(new URLSearchParams(body).toString());
  return new Promise((resolve, reject) => {
    const req = https.request({
      host, path: apiPath, method: 'POST', timeout: timeoutMs,
      headers: { 'User-Agent': 'wled-fleet', Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': payload.length },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(`réponse GitHub illisible (HTTP ${res.statusCode})`)); } });
    });
    req.on('error', e => reject(new Error(`GitHub injoignable : ${e.message}`)));
    req.on('timeout', () => req.destroy(new Error('GitHub : délai dépassé')));
    req.write(payload); req.end();
  });
}

async function deviceStart(clientId, scope = 'repo') {
  if (!clientId) throw new Error('aucune application GitHub configurée (client_id manquant)');
  const r = await formPost(DEVICE_HOST, '/login/device/code', { client_id: clientId, scope });
  if (r.error) throw new Error(r.error_description || r.error);
  return { deviceCode: r.device_code, userCode: r.user_code, url: r.verification_uri, expiresIn: r.expires_in, interval: Math.max(5, r.interval || 5) };
}

// Renvoie {pending:true} tant que l'utilisateur n'a pas validé — ce n'est pas
// une erreur, c'est l'état normal de l'attente.
async function devicePoll(clientId, deviceCode) {
  const r = await formPost(DEVICE_HOST, '/login/oauth/access_token', {
    client_id: clientId, device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  if (r.access_token) return { token: r.access_token, scope: r.scope || '' };
  if (r.error === 'authorization_pending') return { pending: true };
  if (r.error === 'slow_down') return { pending: true, slowDown: (r.interval || 10) };
  if (r.error === 'expired_token') throw new Error('code expiré : recommencer la connexion');
  if (r.error === 'access_denied') throw new Error('connexion refusée dans le navigateur');
  throw new Error(r.error_description || r.error || 'échec de la connexion GitHub');
}

async function whoami(token) {
  const r = await request('GET', '/user', { token });
  if (r.error) throw new Error(r.error);
  return { login: r.json.login, name: r.json.name || '' };
}

module.exports = { request, explain, decide, encode, decodeBlob, listRemote, getProduct, getItem, publish, pull, pathFor, DIR, SPACES, spaceOf, deviceStart, devicePoll, whoami };
