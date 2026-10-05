#!/usr/bin/env node
// Catálogo de Skills — servidor local (sem dependências, Node >= 18).
// Busca no skills.sh, lê descrições do GitHub, instala em ~/.claude/skills,
// faz login com GitHub (device flow), guarda favoritas por perfil e traduz
// as descrições (não os nomes) sem gastar tokens: o navegador traduz no próprio
// computador e este servidor só faz o serviço gratuito de reserva.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');

const PORT = Number(process.env.PORT) || 4173;
const HOST = '127.0.0.1';
const SKILLS_DIR = process.env.SKILLS_DIR || path.join(os.homedir(), '.claude', 'skills');
const MARKER = '.catalogo-skill.json';
const UA = { 'User-Agent': 'catalogo-de-skills' };
const CONFIG_DIR = process.env.CATALOGO_CONFIG_DIR || path.join(os.homedir(), '.config', 'catalogo-de-skills');
const GH_WEB = process.env.GH_WEB || 'https://github.com';
const GH_API = process.env.GH_API || 'https://api.github.com';

const SOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/(?!\.+$)[A-Za-z0-9_.-]+$/; // dono/repositório, sem '..'
const SKILL_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{10,60}$/;
const LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/;
const LIST_NAMES = ['favorites'];

const SITE_DIR = path.join(__dirname, 'site');
const SITE_CONFIG = JSON.parse(fs.readFileSync(path.join(SITE_DIR, 'config.json'), 'utf8'));
// As categorias e as palavras-chave vivem em site/categories.json, que o site estático também usa.
const CATEGORIES = JSON.parse(fs.readFileSync(path.join(SITE_DIR, 'categories.json'), 'utf8'))
  .categories.map(c => ({ queries: [], ...c }));

const LANGS = JSON.parse(fs.readFileSync(path.join(__dirname, 'site', 'langs.json'), 'utf8'));

// ---------- utilidades ----------

const memo = new Map();
async function cached(key, ttlMs, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  memo.set(key, { at: Date.now(), value });
  return value;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120000, ...opts }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout));
  });
}

function tildify(p) {
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

function readJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let [, key, val] = kv;
    if (/^[>|][+-]?$/.test(val)) {
      const parts = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      val = parts.join(' ');
    }
    out[key] = val.replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

function installedMap() {
  const map = new Map();
  let entries = [];
  try { entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }); } catch { return map; }
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (!fs.existsSync(path.join(SKILLS_DIR, e.name, 'SKILL.md'))) continue;
    let source = null, at = null;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, e.name, MARKER), 'utf8'));
      source = m.source; at = m.installedAt || null;
    } catch {}
    if (!at) { // instalada à mão: usa a data em que a pasta foi criada (ou alterada)
      try { const st = fs.lstatSync(path.join(SKILLS_DIR, e.name)); at = new Date(st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs).toISOString(); } catch {}
    }
    map.set(e.name, { source, at });
  }
  return map;
}

// ---------- skills.sh ----------

// O skills.sh aceita ~30 consultas por minuto no total: um balde de fichas espaça as chamadas.
const bucket = { tokens: 12, at: Date.now() };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function takeToken() {
  for (;;) {
    const now = Date.now();
    bucket.tokens = Math.min(12, bucket.tokens + (now - bucket.at) * 0.42 / 1000);
    bucket.at = now;
    if (bucket.tokens >= 1) { bucket.tokens -= 1; return; }
    await sleep((1 - bucket.tokens) / 0.42 * 1000 + 50);
  }
}
async function skillsSh(urlPath) {
  await takeToken();
  const res = await fetch(`https://skills.sh${urlPath}`, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (res.status === 429) {
    const wait = Number(res.headers.get('retry-after')) || 60;
    throw Object.assign(new Error(`O skills.sh limita as consultas. Tente de novo em ${wait} segundos.`), { status: 429 });
  }
  if (!res.ok) throw new Error(`skills.sh respondeu ${res.status}`);
  return res.json();
}
const cleanList = skills => (skills || []).filter(s => SOURCE_RE.test(s.source) && SKILL_RE.test(s.skillId)).map(s => ({
  id: `${s.source}/${s.skillId}`, source: s.source, skillId: s.skillId, name: s.name || s.skillId,
  installs: s.installs, installsYesterday: s.installsYesterday, change: s.change,
}));

async function searchSkills(q, limit = 24) {
  const data = await skillsSh(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`);
  return (data.skills || []).filter(s => SOURCE_RE.test(s.source) && SKILL_RE.test(s.skillId));
}

async function listCategory(id) {
  const cat = CATEGORIES.find(c => c.id === id);
  if (!cat) throw new Error('Categoria inválida');
  if (id === 'em-alta') return fetchHot();
  if (id === 'populares') return fetchAllTime();
  if (id === 'novidades') return freshList();
  return cached(`cat:${id}`, 3600e3, async () => {
    const queries = cat.queries;
    const results = await Promise.allSettled(queries.map(q => searchSkills(q)));
    const merged = new Map();
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      for (const s of r.value) merged.set(s.id, s);
    }
    if (!merged.size) throw new Error('Não consegui buscar skills (sem internet?)');
    return [...merged.values()].sort((a, b) => b.installs - a.installs);
  });
}

// ---------- novidades: em alta + comparação com o que já foi visto ----------

const SEEN_FILE = path.join(CONFIG_DIR, 'seen.json');
const DAY = 864e5;
const readSeen = () => { const d = readJsonFile(SEEN_FILE, null); return d && d.ids ? d : { ids: {}, baselineAt: null, refreshedAt: null }; };

// A busca ordena por instalações, então skill nova some. A lista "hot" do skills.sh
// traz o crescimento das últimas 24h e mostra o que acabou de surgir.
async function fetchHot() {
  return cached('hot', 15 * 60e3, async () => cleanList((await skillsSh('/api/skills/hot/0')).skills));
}
async function fetchAllTime() {
  return cached('alltime', 3600e3, async () => cleanList((await skillsSh('/api/skills/all-time/0')).skills));
}

// Novidade = apareceu depois da primeira varredura (ou nasceu hoje) e tem menos de 7 dias.
function freshList() {
  const cutoff = Date.now() - 7 * DAY;
  return Object.entries(readSeen().ids)
    .filter(([, v]) => v.fresh && new Date(v.at).getTime() > cutoff)
    .map(([id, v]) => ({ id, source: v.source, skillId: v.skillId, name: v.name, installs: v.installs, at: v.at }))
    .sort((a, b) => b.at.localeCompare(a.at) || b.installs - a.installs);
}

let sweeping = null;
function refreshCatalog() {
  if (sweeping) return sweeping;
  sweeping = (async () => {
    try {
      for (const k of [...memo.keys()]) if (k.startsWith('cat:') || k === 'hot' || k === 'alltime') memo.delete(k);
      // ~13 consultas no total, dentro do limite do skills.sh
      const firstQueries = CATEGORIES.filter(c => c.queries.length).map(c => searchSkills(c.queries[0], 100));
      const settled = await Promise.allSettled([fetchHot(), fetchAllTime(), ...firstQueries]);
      const ok = settled.filter(r => r.status === 'fulfilled');
      if (!ok.length) throw new Error(settled[0].reason && settled[0].reason.message || 'Não consegui falar com o skills.sh (sem internet?)');
      const seen = readSeen(), baselined = !!seen.baselineAt, now = new Date().toISOString();
      const complete = ok.length === settled.length; // só vale como ponto de partida se tudo respondeu
      let found = 0;
      for (const r of ok) {
        for (const raw of r.value) {
          const s = raw.id ? raw : { ...raw, id: `${raw.source}/${raw.skillId}` };
          // "Nova" de verdade: quase todas as instalações são de hoje (ou é pequena e inédita para o catálogo).
          const surging = s.installsYesterday != null && s.change > 0 && s.installsYesterday * 10 <= s.installs;
          const prev = seen.ids[s.id];
          if (!prev) {
            const fresh = surging || (baselined && s.installs < 500);
            seen.ids[s.id] = { at: now, fresh, source: s.source, skillId: s.skillId, name: s.name, installs: s.installs };
            if (fresh) found++;
          } else prev.installs = s.installs;
        }
      }
      const firstRun = !baselined;
      if (firstRun && complete) seen.baselineAt = now;
      seen.refreshedAt = now;
      writeJsonFile(SEEN_FILE, seen);
      return { newCount: found, totalNew: freshList().length, refreshedAt: now, firstRun };
    } finally { sweeping = null; }
  })();
  return sweeping;
}

// ---------- GitHub ----------

async function repoSkillPaths(source) {
  return cached(`tree:${source}`, 6 * 3600e3, async () => {
    try {
      const res = await fetch(`https://api.github.com/repos/${source}/git/trees/HEAD?recursive=1`,
        { headers: UA, signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      const data = await res.json();
      return (data.tree || []).filter(n => n.type === 'blob' && /(^|\/)SKILL\.md$/.test(n.path)).map(n => n.path);
    } catch { return null; }
  });
}

async function rawFile(source, file) {
  const res = await fetch(`https://raw.githubusercontent.com/${source}/HEAD/${file}`,
    { headers: UA, signal: AbortSignal.timeout(15000) });
  return res.ok ? res.text() : null;
}

async function repoInfo(source) {
  return cached(`repo:${source}`, 6 * 3600e3, async () => {
    const base = { source, url: `https://github.com/${source}`, ownerUrl: `https://github.com/${source.split('/')[0]}`, stats: null };
    try {
      const res = await fetch(`${GH_API}/repos/${source}`, { headers: UA, signal: AbortSignal.timeout(15000) });
      if (!res.ok) return base; // sem limite de requisições ou repositório removido: mostra só os links
      const d = await res.json();
      return {
        ...base,
        stats: {
          stars: d.stargazers_count, forks: d.forks_count, language: d.language || null,
          license: d.license && d.license.spdx_id !== 'NOASSERTION' ? d.license.spdx_id : null,
          pushedAt: d.pushed_at, archived: !!d.archived, description: d.description || null,
        },
      };
    } catch { return base; }
  });
}

async function skillDetail(source, skillId) {
  return cached(`detail:${source}/${skillId}`, 6 * 3600e3, async () => {
    const tree = await repoSkillPaths(source);
    let candidates;
    if (tree) {
      candidates = tree.filter(p => path.posix.basename(path.posix.dirname(p)) === skillId)
        .sort((a, b) => a.length - b.length);
    } else {
      candidates = [`skills/${skillId}/SKILL.md`, `${skillId}/SKILL.md`,
        `.claude/skills/${skillId}/SKILL.md`, 'SKILL.md'];
    }
    for (const file of candidates) {
      const text = await rawFile(source, file);
      if (text == null) continue;
      const fm = parseFrontmatter(text);
      return {
        source, skillId,
        name: fm.name || skillId,
        description: fm.description || '(sem descrição no SKILL.md)',
        content: text.slice(0, 20000),
        githubUrl: `https://github.com/${source}/blob/HEAD/${file}`,
      };
    }
    throw new Error('Não encontrei o SKILL.md desta skill no repositório');
  });
}

// ---------- instalação ----------

function findSkillDir(root, skillId) {
  const stack = [root];
  const found = [];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    if (entries.some(e => e.isFile() && e.name === 'SKILL.md')) {
      const nameOk = path.basename(dir) === skillId ||
        parseFrontmatter(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).name === skillId;
      if (nameOk) found.push(dir);
    }
    for (const e of entries) {
      if (e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules') stack.push(path.join(dir, e.name));
    }
  }
  return found.sort((a, b) => a.length - b.length)[0];
}

async function installSkill(source, skillId) {
  const dest = path.join(SKILLS_DIR, skillId);
  if (fs.existsSync(dest)) throw new Error(`"${skillId}" já existe em ${SKILLS_DIR}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalogo-'));
  try {
    await run('git', ['clone', '--depth', '1', '--quiet', `https://github.com/${source}.git`, tmp],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    const src = findSkillDir(tmp, skillId);
    if (!src) throw new Error('Skill não encontrada dentro do repositório');
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    fs.cpSync(src, dest, {
      recursive: true,
      filter: p => path.basename(p) !== '.git' && !fs.lstatSync(p).isSymbolicLink(),
    });
    fs.writeFileSync(path.join(dest, MARKER),
      JSON.stringify({ source, skillId, installedAt: new Date().toISOString() }, null, 2));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function uninstallSkill(skillId) {
  const dest = path.join(SKILLS_DIR, skillId);
  let stat;
  try { stat = fs.lstatSync(dest); } catch { throw new Error(`"${skillId}" não está em ${tildify(SKILLS_DIR)}`); }
  if (!fs.existsSync(path.join(dest, 'SKILL.md'))) throw new Error(`"${skillId}" não parece ser uma skill`);
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(dest); // só o atalho; o original continua onde estava
    return { removed: 'atalho' };
  }
  fs.rmSync(dest, { recursive: true, force: true });
  return { removed: 'pasta' };
}

// ---------- login com GitHub (device flow) ----------

const SESSION_FILE = path.join(CONFIG_DIR, 'session.json');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
let pending = null; // { deviceCode, interval, expiresAt }

const getClientId = () => process.env.GITHUB_CLIENT_ID || readJsonFile(CONFIG_FILE, {}).clientId || null;

function currentUser() {
  const s = readJsonFile(SESSION_FILE, null);
  return s && LOGIN_RE.test(s.login || '') ? s : null;
}

async function ghPost(urlPath, body) {
  const res = await fetch(`${GH_WEB}${urlPath}`, {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { ...UA, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function authStart() {
  const clientId = getClientId();
  if (!clientId) throw new Error('Informe o Client ID do GitHub antes de entrar');
  const d = await ghPost('/login/device/code', { client_id: clientId, scope: '' });
  if (!d.device_code) throw new Error(d.error_description || 'O GitHub recusou o pedido de login');
  pending = { deviceCode: d.device_code, interval: d.interval || 5, expiresAt: Date.now() + d.expires_in * 1000 };
  return { userCode: d.user_code, verificationUri: d.verification_uri, interval: pending.interval, expiresIn: d.expires_in };
}

async function authPoll() {
  if (!pending || Date.now() > pending.expiresAt) { pending = null; return { status: 'expired' }; }
  const d = await ghPost('/login/oauth/access_token', {
    client_id: getClientId(), device_code: pending.deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  if (d.error === 'authorization_pending') return { status: 'pending', interval: pending.interval };
  if (d.error === 'slow_down') { pending.interval = d.interval || pending.interval + 5; return { status: 'pending', interval: pending.interval }; }
  if (d.error === 'expired_token') { pending = null; return { status: 'expired' }; }
  if (d.error === 'access_denied') { pending = null; return { status: 'denied' }; }
  if (d.error || !d.access_token) throw new Error(d.error_description || 'Resposta inesperada do GitHub');
  // O token só serve para ler o nome público; não é guardado.
  const res = await fetch(`${GH_API}/user`, {
    headers: { ...UA, Accept: 'application/vnd.github+json', Authorization: `Bearer ${d.access_token}` },
    signal: AbortSignal.timeout(15000),
  });
  const u = await res.json();
  if (!LOGIN_RE.test(u.login || '')) throw new Error('Não consegui ler o seu perfil no GitHub');
  const user = {
    login: u.login, name: u.name || u.login,
    avatar: typeof u.avatar_url === 'string' && u.avatar_url.startsWith('https://') ? u.avatar_url : '',
  };
  writeJsonFile(SESSION_FILE, user);
  // Primeiro login desta conta: leva junto o que já estava salvo neste computador.
  const mine = path.join(CONFIG_DIR, `lists-gh-${user.login.toLowerCase()}.json`);
  const local = path.join(CONFIG_DIR, 'lists-local.json');
  if (!fs.existsSync(mine) && fs.existsSync(local)) fs.copyFileSync(local, mine);
  pending = null;
  return { status: 'ok', user };
}

// ---------- favoritas e salvas (por perfil) ----------

function listsFile() {
  const u = currentUser();
  return path.join(CONFIG_DIR, u ? `lists-gh-${u.login.toLowerCase()}.json` : 'lists-local.json');
}

function readLists() {
  const d = readJsonFile(listsFile(), {});
  const favorites = Array.isArray(d.favorites) ? [...d.favorites] : [];
  // A antiga lista "Para testar" (saved) foi unida às favoritas.
  for (const s of Array.isArray(d.saved) ? d.saved : []) {
    if (!favorites.some(f => f.source === s.source && f.skillId === s.skillId)) favorites.push(s);
  }
  return { favorites };
}

function importFavorites(items) {
  if (!Array.isArray(items) || items.length > 2000) throw new Error('Arquivo inválido');
  const lists = readLists();
  let added = 0;
  for (const s of items) {
    if (!s || !SOURCE_RE.test(s.source || '') || !SKILL_RE.test(s.skillId || '')) continue;
    if (lists.favorites.some(x => x.source === s.source && x.skillId === s.skillId)) continue;
    lists.favorites.push({ source: s.source, skillId: s.skillId, name: String(s.name || s.skillId).slice(0, 120), installs: Number(s.installs) || 0, at: new Date().toISOString() });
    added++;
  }
  writeJsonFile(listsFile(), lists);
  return { added, lists };
}

function toggleList(list, { source, skillId, name, installs }) {
  if (!LIST_NAMES.includes(list)) throw new Error('Lista inválida');
  if (!SOURCE_RE.test(source || '') || !SKILL_RE.test(skillId || '')) throw new Error('Skill inválida');
  const lists = readLists();
  const idx = lists[list].findIndex(s => s.source === source && s.skillId === skillId);
  if (idx >= 0) lists[list].splice(idx, 1);
  else lists[list].unshift({
    source, skillId, name: String(name || skillId).slice(0, 120),
    installs: Number(installs) || 0, at: new Date().toISOString(),
  });
  writeJsonFile(listsFile(), lists);
  return { on: idx < 0, lists };
}

// ---------- tradução das descrições (reserva gratuita) ----------
// O navegador traduz sozinho quando tem o tradutor embutido. Quando não tem,
// este servidor usa o MyMemory (gratuito, com cota diária) e guarda tudo em cache.

const TRANSLATIONS_FILE = path.join(CONFIG_DIR, 'translations.json');
let translationCache = null;
const cacheKey = text => crypto.createHash('sha1').update(text).digest('hex').slice(0, 20);

const decodeEntities = s => s.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// O MyMemory aceita ~500 bytes por pedido: quebra o texto em frases e agrupa.
function splitSegments(text, maxBytes = 420) {
  const parts = text.split(/(?<=[.!?。！？])\s+|\n+/).filter(Boolean);
  const out = [];
  for (let part of parts) {
    while (Buffer.byteLength(part) > maxBytes) { // frase gigante: corta por caracteres
      let cut = part.length;
      while (Buffer.byteLength(part.slice(0, cut)) > maxBytes) cut = Math.floor(cut * 0.8);
      out.push(part.slice(0, cut)); part = part.slice(cut);
    }
    const last = out[out.length - 1];
    if (last && Buffer.byteLength(last + ' ' + part) <= maxBytes) out[out.length - 1] = last + ' ' + part;
    else out.push(part);
  }
  return out;
}

async function myMemory(segment, target) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(segment)}&langpair=${encodeURIComponent('Autodetect|' + target)}`;
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  const d = await res.json().catch(() => ({}));
  const text = (d.responseData && d.responseData.translatedText) || '';
  if (d.quotaFinished || /MYMEMORY WARNING/i.test(text) || res.status === 429) {
    throw Object.assign(new Error('A cota gratuita de tradução de hoje acabou. Volte amanhã ou use o Chrome, que traduz sem limite.'), { status: 429 });
  }
  if (/DISTINCT LANGUAGES/i.test(text) || /DISTINCT LANGUAGES/i.test(d.responseDetails || '')) return segment; // já está no idioma
  if (Number(d.responseStatus) !== 200 || !text) throw new Error('O serviço de tradução não respondeu. Tente de novo em instantes.');
  return decodeEntities(text);
}

async function translateTexts(code, texts) {
  const lang = LANGS.find(l => l.code === code);
  if (!lang) throw new Error('Idioma inválido');
  if (!Array.isArray(texts) || texts.length > 40 || texts.some(t => typeof t !== 'string' || t.length > 3000)) throw new Error('Textos inválidos');
  if (!translationCache) translationCache = readJsonFile(TRANSLATIONS_FILE, {});
  const bucket = translationCache[code] || (translationCache[code] = {});
  const missing = [...new Set(texts.filter(t => t.trim() && !(cacheKey(t) in bucket)))];
  for (const t of missing) {
    const parts = [];
    for (const seg of splitSegments(t)) parts.push(await myMemory(seg, code));
    bucket[cacheKey(t)] = parts.join(' ');
    writeJsonFile(TRANSLATIONS_FILE, translationCache);
  }
  return texts.map(t => (t.trim() ? bucket[cacheKey(t)] : t));
}

// ---------- HTTP ----------

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 200000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('JSON inválido')); } });
  });
}

function trustedRequest(req) {
  // Bloqueia DNS rebinding e requisições vindas de outros sites.
  const allowed = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
  if (!allowed.includes(req.headers.host)) return false;
  const origin = req.headers.origin;
  return !origin || allowed.some(h => origin === `http://${h}`);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!trustedRequest(req)) return send(res, 403, { error: 'Origem não permitida' });
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/') {
      const html = fs.readFileSync(path.join(SITE_DIR, 'index.html'), 'utf8')
        .replace('<!--CATALOGO-CONFIG-->', `<script>window.CATALOGO=${JSON.stringify({ ...SITE_CONFIG, mode: 'local' })}</script>`)
        .replace(/%%SITE_URL%%/g, SITE_CONFIG.siteUrl).replace(/%%TITLE%%/g, SITE_CONFIG.title).replace(/%%DESCRIPTION%%/g, SITE_CONFIG.description);
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/api/categories') {
      return send(res, 200, CATEGORIES.map(({ id, label }) => ({ id, label })));
    }
    if (req.method === 'GET' && url.pathname === '/api/installed') {
      const skills = [...installedMap()].map(([skillId, v]) => {
        let description = '';
        try { description = parseFrontmatter(fs.readFileSync(path.join(SKILLS_DIR, skillId, 'SKILL.md'), 'utf8')).description || ''; } catch {}
        return { skillId, source: v.source, description, installedAt: v.at };
      }).sort((a, b) => (b.installedAt || '').localeCompare(a.installedAt || '')); // a mais recente primeiro
      return send(res, 200, { dir: tildify(SKILLS_DIR), skills });
    }
    if (req.method === 'GET' && url.pathname === '/api/local-skill') {
      const skillId = url.searchParams.get('skillId') || '';
      if (!SKILL_RE.test(skillId)) return send(res, 400, { error: 'Parâmetros inválidos' });
      const text = fs.readFileSync(path.join(SKILLS_DIR, skillId, 'SKILL.md'), 'utf8');
      const fm = parseFrontmatter(text);
      return send(res, 200, { skillId, name: fm.name || skillId, description: fm.description || '(sem descrição no SKILL.md)', content: text.slice(0, 20000) });
    }
    if (req.method === 'GET' && url.pathname === '/api/langs') {
      return send(res, 200, { langs: LANGS });
    }
    if (req.method === 'POST' && url.pathname === '/api/translate') {
      const { lang, texts } = await readJson(req);
      return send(res, 200, { translations: await translateTexts(lang, texts) });
    }
    if (req.method === 'GET' && url.pathname === '/api/me') {
      return send(res, 200, { configured: !!getClientId(), user: currentUser() });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/config') {
      const { clientId } = await readJson(req);
      if (!CLIENT_ID_RE.test(clientId || '')) return send(res, 400, { error: 'Esse Client ID não parece válido' });
      writeJsonFile(CONFIG_FILE, { ...readJsonFile(CONFIG_FILE, {}), clientId });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/start') return send(res, 200, await authStart());
    if (req.method === 'POST' && url.pathname === '/api/auth/poll') return send(res, 200, await authPoll());
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      pending = null;
      fs.rmSync(SESSION_FILE, { force: true });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/lists') {
      return send(res, 200, readLists());
    }
    if (req.method === 'POST' && url.pathname === '/api/lists/import') {
      const body = await readJson(req);
      return send(res, 200, importFavorites(body.favorites));
    }
    if (req.method === 'POST' && url.pathname === '/api/lists/toggle') {
      const body = await readJson(req);
      return send(res, 200, toggleList(body.list, body));
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return send(res, 200, { refreshedAt: readSeen().refreshedAt, newCount: freshList().length });
    }
    if (req.method === 'POST' && url.pathname === '/api/refresh') {
      return send(res, 200, await refreshCatalog());
    }
    if (req.method === 'GET' && url.pathname === '/api/skills') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
      const list = q ? await searchSkills(q, 48) : await listCategory(url.searchParams.get('category') || 'populares');
      const installed = installedMap();
      const lists = readLists();
      const freshIds = new Set(freshList().map(s => s.id));
      const has = (name, s) => lists[name].some(x => x.source === s.source && x.skillId === s.skillId);
      return send(res, 200, list.map(s => ({
        favorite: has('favorites', s), isNew: freshIds.has(s.id || `${s.source}/${s.skillId}`), change: s.change,
        source: s.source, skillId: s.skillId, name: s.name, installs: s.installs,
        installed: installed.has(s.skillId) &&
          (!installed.get(s.skillId).source || installed.get(s.skillId).source === s.source),
      })));
    }
    if (req.method === 'GET' && url.pathname === '/api/repo') {
      const source = url.searchParams.get('source') || '';
      if (!SOURCE_RE.test(source)) return send(res, 400, { error: 'Parâmetros inválidos' });
      return send(res, 200, await repoInfo(source));
    }
    if (req.method === 'GET' && url.pathname === '/api/skill') {
      const source = url.searchParams.get('source') || '';
      const skillId = url.searchParams.get('skillId') || '';
      if (!SOURCE_RE.test(source) || !SKILL_RE.test(skillId)) return send(res, 400, { error: 'Parâmetros inválidos' });
      return send(res, 200, await skillDetail(source, skillId));
    }
    if (req.method === 'POST' && (url.pathname === '/api/install' || url.pathname === '/api/uninstall')) {
      const { source, skillId } = await readJson(req);
      if (!SKILL_RE.test(skillId || '') || (url.pathname === '/api/install' && !SOURCE_RE.test(source || ''))) {
        return send(res, 400, { error: 'Parâmetros inválidos' });
      }
      const result = url.pathname === '/api/install' ? await installSkill(source, skillId) : uninstallSkill(skillId);
      return send(res, 200, { ok: true, ...(result || {}) });
    }
    send(res, 404, { error: 'Não encontrado' });
  } catch (err) {
    send(res, err.status || 500, { error: err.message });
  }
});

// Abre o navegador na página do catálogo (desligue com --no-open ou NO_OPEN=1).
function openBrowser(url) {
  if (process.argv.includes('--no-open') || process.env.NO_OPEN) return;
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {}); // sem navegador padrão: o endereço já está no terminal
    child.unref();
  } catch {}
}

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`A porta ${PORT} já está em uso. Se o catálogo já está aberto, acesse http://localhost:${PORT}.`);
    console.error(`Para usar outra porta: PORT=${PORT + 1} node server.js`);
  } else console.error(err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  if (!fs.existsSync(SEEN_FILE)) refreshCatalog().catch(() => {}); // guarda o ponto de partida para detectar novidades depois
  const url = `http://localhost:${PORT}`;
  console.log(`Catálogo de Skills em ${url}`);
  console.log(`Instalando em: ${SKILLS_DIR}`);
  console.log('Para encerrar: Ctrl+C');
  openBrowser(url);
});
