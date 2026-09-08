// Pairing ("appairage") of brand-new WLED nodes.
//
// A WLED node without Wi-Fi credentials opens its own access point
// (SSID "WLED-AP", WPA2 key "wled1234" by default, node at 4.3.2.1). To bring
// it onto the show network we use this PC's Wi-Fi card (Windows, netsh):
//
//   1. remember the Wi-Fi profile the PC is on
//   2. add a temporary profile for the node's AP and connect to it
//   3. wait for http://4.3.2.1/json/info
//   4. POST /json/cfg with the show SSID/password (+ name, static IP) and reboot
//   5. reconnect the PC to its previous Wi-Fi, drop the temporary profile
//
// The fleet server keeps running: the fleet LAN is on the Ethernet card, only
// the Wi-Fi card changes network for ~30 s. One pairing at a time.
'use strict';

const { execFile } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dataFile, codeFile, DATA_DIR, CODE_DIR } = require('./paths');

const NODE_AP_IP = '4.3.2.1';
const run = (args, timeout = 15000) => new Promise((resolve, reject) => {
  execFile('netsh', args, { timeout, windowsHide: true, encoding: 'latin1' }, (err, stdout, stderr) => {
    if (err && !stdout) return reject(new Error((stderr || err.message).trim()));
    resolve(String(stdout || '').replace(/[ÿ ]/g, ' ')); // netsh pads its colons with a non-breaking space (cp850)
  });
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
// netsh output is localized (FR/EN) and code-page encoded: match loosely
const grab = (block, re) => { const m = re.exec(block); return m ? m[1].trim() : null; };

// Visible networks from the PC's Wi-Fi card. Windows barely rescans while
// connected: deep=true disconnects for a few seconds to force a fresh scan,
// then reconnects to the previous profile.
// Native WlanScan (tools/wlan-scan.ps1): a real scan of every channel while
// staying connected, the way NetSpot does. Refreshes the netsh list in ~4 s.
function triggerScan(waitMs = 4000) {
  return new Promise(resolve => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', codeFile('tools', 'wlan-scan.ps1'), '-WaitMs', String(waitMs)], { timeout: 20000, windowsHide: true }, (err, out) => {
      let r = null; try { r = JSON.parse(String(out).trim().split('\n').pop()); } catch { /* ignore */ }
      resolve(!err && r && r.ok);
    });
  });
}

async function wlanNetworks(deep = false, refresh = true) {
  let previous = null;
  if (refresh && !deep) await triggerScan();
  if (deep) {
    hooks.onBegin('recherche Wi‑Fi approfondie');
    const st = await wlanState(); previous = st.connected ? st.profile : null;
    try { await run(['wlan', 'disconnect']); } catch { /* not connected */ }
    await sleep(6000);
  }
  let out = await run(['wlan', 'show', 'networks', 'mode=bssid']);
  if (deep) {
    await sleep(3000); const out2 = await run(['wlan', 'show', 'networks', 'mode=bssid']); if (out2.length > out.length) out = out2;
    if (previous) await reconnect(previous, () => {});
    await hooks.onEnd();
  }
  const nets = [];
  for (const block of out.split(/\r?\n(?=SSID \d+)/)) {
    const ssid = grab(block, /^SSID \d+\s*:\s*(.*)$/m);
    if (ssid === null) continue;
    const auth = grab(block, /Authenti\w+\s*:\s*(.*)$/mi) || '';
    const sig = grab(block, /Signal\s*:\s*(\d+)%/mi);
    const bssid = grab(block, /BSSID 1\s*:\s*([0-9a-f:]{17})/mi);
    const chan = grab(block, /(?:Canal|Channel)\s*:\s*(\d+)/mi);
    const open = /ouvert|open/i.test(auth);
    nets.push({ ssid, auth, open, signal: sig ? Number(sig) : null, bssid, channel: chan ? Number(chan) : null,
      candidate: open || /wled|pixy|liana|tournette|esp/i.test(ssid) }); // refined further by the server (fleet's chip maker, known node APs)
  }
  return nets.sort((a, b) => (b.candidate - a.candidate) || ((b.signal || 0) - (a.signal || 0)));
}

// Current Wi-Fi state of the PC.
async function wlanState() {
  const out = await run(['wlan', 'show', 'interfaces']);
  // 'État' comes out of the OEM code page as one garbage byte + 'tat'; accents in values are mangled too
  const state = grab(out, /^\s*(?:\S{0,2}tat|State)\s*:\s*(.*)$/mi) || '';
  return {
    connected: /^connect/i.test(state) && !/^d.{0,2}s?connect/i.test(state),
    state, ssid: grab(out, /^\s*SSID\s*:\s*(.*)$/mi), profile: grab(out, /^\s*Profil\w*\s*:\s*(.*)$/mi),
  };
}

// ── IP config of the Wi-Fi card: static IP would break the pairing ──────────
// The node's AP hands out 4.3.2.x by DHCP. A card pinned to a static address
// never gets it, so we switch the card to DHCP for the pairing and put the
// static config back afterwards. Changing an address needs elevation: netsh
// is run through PowerShell -Verb RunAs (one UAC prompt each way).
async function wlanIfaceName() {
  const out = await run(['wlan', 'show', 'interfaces']);
  return grab(out, /^\s*(?:Nom|Name)\s*:\s*(.*)$/mi) || 'Wi-Fi';
}
async function wlanIpConfig() {
  const name = await wlanIfaceName();
  const out = await run(['interface', 'ip', 'show', 'config', `name=${name}`]);
  const dhcp = /DHCP[^:\n]*:\s*(Oui|Yes)/i.test(out);
  const ip = grab(out, /(?:Adresse IP|IP Address)\s*:\s*([\d.]+)/i);
  let mask = grab(out, /(?:masque|mask)\s*(?:de sous-r\S+\s*)?:?\s*([\d.]{7,15})/i) || grab(out, /mask\s+([\d.]+)\)/i);
  if (!mask) { const pfx = grab(out, /\/(\d{1,2})\s*\(/); if (pfx) { const n = Number(pfx); mask = [0, 8, 16, 24].map(s => (0xffffffff << (32 - n) >>> s) & 255).reverse().join('.'); } }
  const gw = grab(out, /(?:Passerelle par d\S+|Default Gateway)\s*:\s*([\d.]+)/i);
  return { name, dhcp, ip, mask, gw };
}
function runElevated(argsLine) {
  // PowerShell asks for elevation; the user clicks Yes on the UAC prompt
  return new Promise((resolve, reject) => {
    const ps = `Start-Process -FilePath netsh -ArgumentList '${argsLine.replace(/'/g, "''")}' -Verb RunAs -Wait -WindowStyle Hidden`;
    execFile('powershell', ['-NoProfile', '-Command', ps], { timeout: 90000, windowsHide: true }, (err, so, se) => err ? reject(new Error(/canceled|annul/i.test(String(se)) ? 'élévation refusée (UAC)' : String(se || err.message).trim().slice(0, 200))) : resolve());
  });
}
async function ensureDhcp(log) {
  const c = await wlanIpConfig();
  if (c.dhcp) { log(`carte ${c.name} en DHCP, rien à changer`); return null; }
  log(`carte ${c.name} en IP fixe ${c.ip}/${c.mask}${c.gw ? ` gw ${c.gw}` : ''} : passage temporaire en DHCP (accepter la demande Windows)`);
  await runElevated(`interface ip set address name="${c.name}" source=dhcp`);
  try { await runElevated(`interface ip set dns name="${c.name}" source=dhcp`); } catch { /* dns is optional */ }
  return c; // to restore later
}
async function restoreStatic(c, log) {
  if (!c) return;
  log(`retour de la carte ${c.name} en IP fixe ${c.ip}/${c.mask}${c.gw ? ` gw ${c.gw}` : ''} (accepter la demande Windows)`);
  try { await runElevated(`interface ip set address name="${c.name}" static ${c.ip} ${c.mask}${c.gw ? ' ' + c.gw : ''}`); }
  catch (e) { log(`⚠ IP fixe non restaurée (${e.message}) : la remettre à la main dans Windows : ${c.ip} / ${c.mask}${c.gw ? ' / ' + c.gw : ''}`); }
}

const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function profileXml(ssid, key) {
  const hex = Buffer.from(ssid, 'utf8').toString('hex').toUpperCase();
  const sec = key
    ? `<security><authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption><sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>${xmlEsc(key)}</keyMaterial></sharedKey></security>`
    : `<security><authEncryption><authentication>open</authentication><encryption>none</encryption><useOneX>false</useOneX></authEncryption></security>`;
  return `<?xml version="1.0"?><WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1"><name>${xmlEsc(ssid)}</name><SSIDConfig><SSID><hex>${hex}</hex><name>${xmlEsc(ssid)}</name></SSID><nonBroadcast>false</nonBroadcast></SSIDConfig><connectionType>ESS</connectionType><connectionMode>manual</connectionMode><MSM>${sec}</MSM></WLANProfile>`;
}

async function connectTo(ssid, key, log) {
  const file = path.join(os.tmpdir(), `wled-fleet-${Date.now()}.xml`);
  fs.writeFileSync(file, profileXml(ssid, key));
  try { log(`profil Wi‑Fi temporaire « ${ssid} »`); await run(['wlan', 'add', 'profile', `filename=${file}`, 'user=current']); }
  finally { try { fs.unlinkSync(file); } catch { /* ignore */ } }
  await run(['wlan', 'connect', `name=${ssid}`]);
  for (let i = 0; i < 20; i++) { await sleep(1500); const st = await wlanState(); if (st.connected && st.ssid === ssid) return st; }
  throw new Error(`le PC n'a pas réussi à rejoindre « ${ssid} » (mauvaise clé, ou réseau hors de portée)`);
}
async function forgetProfile(ssid) { try { await run(['wlan', 'delete', 'profile', `name=${ssid}`]); } catch { /* ignore */ } }
async function reconnect(previous, log) {
  if (!previous) return;
  log(`retour du PC sur « ${previous} »`);
  try { await run(['wlan', 'connect', `name=${previous}`]); } catch (e) { log(`reconnexion : ${e.message}`); return; }
  // wait for the association: on a Wi-Fi-only PC this is the fleet link coming back
  for (let i = 0; i < 20; i++) { await sleep(1500); const st = await wlanState(); if (st.connected && st.ssid === previous) { log(`PC de nouveau sur « ${previous} »`); return; } }
  log(`⚠ le PC n'est pas revenu sur « ${previous} » tout seul : vérifier le Wi‑Fi`);
}

// Hooks so the fleet server can pause its polling while the Wi-Fi card is
// away (on a Wi-Fi-only PC every node and the antenna vanish meanwhile).
let hooks = { onBegin: () => {}, onEnd: async () => {} };
const setHooks = h => { hooks = { ...hooks, ...h }; };

function nodeRequest(method, p, body, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: NODE_AP_IP, port: 80, method, path: p, timeout, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {} }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`)); try { resolve(d ? JSON.parse(d) : null); } catch { resolve(d); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
    if (payload) req.write(payload); req.end();
  });
}
async function waitForNode(log) {
  for (let i = 0; i < 15; i++) {
    try { const info = await nodeRequest('GET', '/json/info'); if (info && info.ver) { log(`node joignable : ${info.name || '?'} · WLED ${info.ver} · ${info.release} · MAC ${info.mac}`); return info; } } catch { /* not yet */ }
    await sleep(2000);
  }
  throw new Error(`aucun WLED ne répond en ${NODE_AP_IP} (le PC est-il bien sur l'AP du node ?)`);
}

// ── Job runner (one at a time) ───────────────────────────────────────────────
let job = null; // { status, ssid, log: [], startedAt, result }
// after a restart, rebuild the last job's trace from pairing.log so the panel still shows it
(() => {
  try {
    const lines = fs.readFileSync(dataFile('pairing.log'), 'utf8').trim().split('\n').slice(-60);
    const last = lines.map(l => /^(\S+) \[(\w+) (.*?)\] (.*)$/.exec(l)).filter(Boolean);
    if (!last.length) return;
    const key = last[last.length - 1][3], mode = last[last.length - 1][2];
    const mine = last.filter(m => m[3] === key && m[2] === mode);
    const startIdx = mine.map(m => m[4]).lastIndexOf(mine.find(m => /^PC actuellement/.test(m[4])) ? mine.filter(m => /^PC actuellement/.test(m[4])).pop()[4] : mine[0][4]);
    const seg = mine.slice(startIdx >= 0 ? startIdx : 0);
    const done = seg.some(m => /^terminé/.test(m[4]));
    job = { status: seg.some(m => /^échec/.test(m[4])) ? 'error' : done ? 'done' : 'error', mode, ssid: key, startedAt: Date.parse(seg[0][1]), result: null, restored: true, log: seg.map(m => ({ at: Date.parse(m[1]), m: m[4] })) };
  } catch { /* no log yet */ }
})();
const status = () => job;
// mDNS must be a hostname: WLED 16 rejects underscores and uppercase is pointless
const hostnameSafe = s => String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'wled';
const ipArr = s => { const p = String(s || '').trim().split('.').map(Number); return p.length === 4 && p.every(n => n >= 0 && n <= 255) ? p : null; };

async function start(opts, mode = 'pair') {
  if (job && ['running'].includes(job.status)) throw new Error('un appairage est déjà en cours');
  if (!opts.ssid) throw new Error('SSID du node manquant');
  if (mode === 'pair' && (!opts.target || !opts.target.ssid)) throw new Error('SSID du réseau cible manquant');
  job = { status: 'running', mode, ssid: opts.ssid, log: [], startedAt: Date.now(), result: null };
  // every line also goes to pairing.log: a server restart must not erase the trace of what happened
  const logFile = dataFile('pairing.log');
  const log = m => { job.log.push({ at: Date.now(), m }); console.log(`[appairage] ${m}`); fs.appendFile(logFile, `${new Date().toISOString()} [${mode} ${opts.ssid}] ${m}\n`, () => {}); };
  (async () => {
    let previous = null, staticCfg = null;
    hooks.onBegin(mode === 'test' ? 'test d\'appairage' : `appairage de « ${opts.ssid} »`);
    try {
      const st = await wlanState(); previous = st.profile || null;
      log(`PC actuellement sur « ${previous || 'rien'} »`);
      staticCfg = await ensureDhcp(log);
      await connectTo(opts.ssid, opts.key || '', log);
      log(`PC connecté à « ${opts.ssid} », attente du node…`);
      const info = await waitForNode(log);
      if (mode === 'test') { job.result = { info }; log('test terminé, rien n\'a été écrit sur le node'); }
      else {
        const t = opts.target;
        const ins = { ssid: t.ssid, psk: t.psk || '' };
        const ip = ipArr(t.ip), gw = ipArr(t.gw), sn = ipArr(t.sn || '255.255.255.0');
        if (ip) { ins.ip = ip; ins.gw = gw || [ip[0], ip[1], ip[2], 1]; ins.sn = sn; }
        const cfg = { nw: { ins: [ins] } };
        // name: only if the user typed one (empty = keep). unify: mDNS + AP SSID aligned on the
        // (new or current) name, on explicit request. Nothing else is ever touched.
        const finalName = t.name && t.name !== info.name ? t.name : null;
        if (finalName) cfg.id = { name: finalName };
        if (t.unify) { const base = finalName || info.name; cfg.id = { ...(cfg.id || {}), mdns: hostnameSafe(base) }; cfg.ap = { ssid: base }; }
        log(`envoi réseau « ${t.ssid} »${ip ? ` IP fixe ${t.ip}` : ' (DHCP)'}${finalName ? `, renommé « ${finalName} »` : ', nom inchangé'}${t.unify ? `, mDNS « ${hostnameSafe(finalName || info.name)} » et AP « ${finalName || info.name} » alignés` : ''}`);
        // the exact payload, so nobody has to trust a summary (password masked)
        log(`POST /json/cfg ${JSON.stringify(cfg).replace(/"psk":"[^"]*"/, '"psk":"…"')}`);
        await nodeRequest('POST', '/json/cfg', cfg);
        log('redémarrage du node, il va rejoindre le réseau du show');
        try { await nodeRequest('POST', '/json/state', { rb: true }, 4000); } catch { /* the node drops the AP while rebooting */ }
        job.result = { info, ip: t.ip || null, name: t.name || info.name, mac: info.mac };
      }
      job.status = 'done';
    } catch (e) { job.status = 'error'; log(`échec : ${e.message}`); }
    finally {
      await forgetProfile(opts.ssid);
      await reconnect(previous, log);
      await restoreStatic(staticCfg, log);
      await hooks.onEnd();
      log('terminé');
    }
  })();
  return job;
}

module.exports = { wlanNetworks, wlanState, wlanIpConfig, triggerScan, start, status, setHooks, hostnameSafe, NODE_AP_IP };
