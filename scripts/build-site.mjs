#!/usr/bin/env node
// Gera a pasta dist/ com o site estático (GitHub Pages).
//  1. baixa o catálogo inteiro do skills.sh (a API deles não aceita chamadas do navegador);
//  2. compara com a execução anterior para descobrir o que é novo de verdade;
//  3. copia site/ para dist/, injetando a configuração.
//
// Uso:  node scripts/build-site.mjs [--out dist] [--prev <url|arquivo>] [--cache .cache/crawl.json]
//       [--pages N] [--keywords N]   (as duas últimas servem só para testar rápido)
//       [--reuse]                    (não baixa nada: reaproveita o catálogo já publicado; usado em push de código)
//       [--site <url>]               (endereço onde o site publicado está; padrão: siteUrl do config.json)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : def; };
const OUT = path.resolve(ROOT, arg('out', 'dist'));
const CACHE = arg('cache', null);
const MAX_PAGES = Number(arg('pages', 120));
const MAX_KEYWORDS = Number(arg('keywords', 1000));
const REUSE = process.argv.includes('--reuse');
const PUBLISHED = arg('site', null);

const config = JSON.parse(await fs.readFile(path.join(SITE, 'config.json'), 'utf8'));
const cats = JSON.parse(await fs.readFile(path.join(SITE, 'categories.json'), 'utf8'));
const SOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/(?!\.+$)[A-Za-z0-9_.-]+$/;
const SKILL_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- consulta ao skills.sh, respeitando o limite (~30 por minuto) ----------
const SPACING = 2200;
let lastCall = 0;
async function getJson(url, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const wait = Math.max(0, lastCall + SPACING - Date.now());
    if (wait) await sleep(wait);
    lastCall = Date.now();
    let res;
    try { res = await fetch(url, { headers: { 'User-Agent': 'catalogo-de-skills-build' }, signal: AbortSignal.timeout(30000) }); }
    catch (e) { if (i === tries - 1) throw e; await sleep(4000); continue; }
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after')) || 60;
      console.log(`  limite atingido, aguardando ${ra}s…`);
      await sleep(ra * 1000 + 1500);
      continue;
    }
    if (res.status >= 500) { await sleep(4000); continue; }
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return res.json();
  }
  throw new Error(`Muitas tentativas: ${url}`);
}
const clean = list => (list || []).filter(s => SOURCE_RE.test(s.source) && SKILL_RE.test(s.skillId));
const idOf = s => `${s.source}/${s.skillId}`;

async function crawl() {
  const all = new Map();
  let total = 0;
  console.log('Catálogo completo (all-time)…');
  for (let page = 0; page < MAX_PAGES; page++) {
    const d = await getJson(`https://skills.sh/api/skills/all-time/${page}`);
    total = d.total || total;
    for (const s of clean(d.skills)) all.set(idOf(s), { source: s.source, skillId: s.skillId, installs: s.installs || 0, official: !!s.isOfficial });
    process.stdout.write(`  página ${page + 1} · ${all.size} skills\r`);
    if (!d.hasMore) break;
  }
  console.log(`\n  ${all.size} skills (o site informa ${total})`);

  console.log('Em alta (hot)…');
  const hot = new Map();
  for (let page = 0; page < 3; page++) {
    const d = await getJson(`https://skills.sh/api/skills/hot/${page}`);
    for (const s of clean(d.skills)) hot.set(idOf(s), { installs: s.installs || 0, change: s.change || 0, yesterday: s.installsYesterday ?? null, source: s.source, skillId: s.skillId });
    if (!d.hasMore) break;
  }
  console.log(`  ${hot.size} em alta`);

  const words = [...new Set([...cats.categories.flatMap(c => c.queries || []), ...cats.keywords])].slice(0, MAX_KEYWORDS);
  console.log(`Palavras-chave (${words.length})…`);
  const kw = {};
  let done = 0, failed = 0;
  for (const w of words) {
    try {
      const d = await getJson(`https://skills.sh/api/search?q=${encodeURIComponent(w)}&limit=100`);
      kw[w] = clean(d.skills).map(idOf);
      for (const s of clean(d.skills)) if (!all.has(idOf(s))) all.set(idOf(s), { source: s.source, skillId: s.skillId, installs: s.installs || 0, official: false });
    } catch (e) { failed++; console.log(`\n  falhou "${w}": ${e.message}`); }
    process.stdout.write(`  ${++done}/${words.length}\r`);
  }
  console.log('');
  return { all: [...all.values()], total, hot: [...hot.values()], kw, words: words.length, failed };
}

async function buildData() {
let raw;
if (CACHE) { try { raw = JSON.parse(await fs.readFile(CACHE, 'utf8')); console.log(`(usando o cache ${CACHE})`); } catch {} }
if (!raw) {
  raw = await crawl();
  if (CACHE) { await fs.mkdir(path.dirname(CACHE), { recursive: true }); await fs.writeFile(CACHE, JSON.stringify(raw)); }
}

// Não publica um catálogo incompleto: a versão anterior do site continua no ar.
const fullRun = MAX_PAGES >= 120 && MAX_KEYWORDS >= 1000;
if (fullRun) {
  if (raw.all.length < 1000 || raw.all.length < raw.total * 0.9) throw new Error(`Catálogo incompleto: ${raw.all.length} de ${raw.total}`);
  if (raw.failed > raw.words * 0.2) throw new Error(`Muitas palavras-chave falharam: ${raw.failed}/${raw.words}`);
}

// ---------- o que é novo: compara com a execução anterior ----------
const today = new Date().toISOString().slice(0, 10);
async function loadPrev() {
  const where = arg('prev', `${PUBLISHED || config.siteUrl}data/state.json`);
  try {
    if (/^https?:/.test(where)) {
      const res = await fetch(where, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) return null;
      return await res.json();
    }
    return JSON.parse(await fs.readFile(where, 'utf8'));
  } catch { return null; }
}
const prev = await loadPrev();
const baseline = !prev || !prev.ids;
const state = { v: 1, baselineAt: baseline ? new Date().toISOString() : prev.baselineAt, ids: { ...(baseline ? {} : prev.ids) } };
const hotById = new Map(raw.hot.map(h => [`${h.source}/${h.skillId}`, h]));
const surging = h => h && h.yesterday != null && h.change > 0 && h.yesterday * 10 <= h.installs;
for (const s of raw.all) {
  const id = idOf(s);
  if (id in state.ids) continue;
  // Primeira execução: tudo vira "conhecido" (b), exceto o que está disparando hoje.
  state.ids[id] = baseline ? (surging(hotById.get(id)) ? today : 'b') : today;
}
for (const h of raw.hot) { // quem nasceu hoje e já estava marcado como conhecido na linha de base
  const id = `${h.source}/${h.skillId}`;
  if (state.ids[id] === 'b' && surging(h) && baseline) state.ids[id] = today;
}

// ---------- catálogo compacto ----------
const sorted = [...raw.all].sort((a, b) => b.installs - a.installs || idOf(a).localeCompare(idOf(b)));
const index = new Map(sorted.map((s, i) => [idOf(s), i]));
const cutoff = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
const catalog = {
  v: 1,
  updatedAt: new Date().toISOString(),
  total: sorted.length,
  baseline,
  skills: sorted.map(s => [s.source, s.skillId, s.installs]),
  official: sorted.flatMap((s, i) => (s.official ? [i] : [])),
  hot: raw.hot.filter(h => index.has(`${h.source}/${h.skillId}`)).map(h => [index.get(`${h.source}/${h.skillId}`), h.change, h.yesterday]),
  fresh: Object.entries(state.ids).filter(([id, d]) => d !== 'b' && d >= cutoff && index.has(id)).map(([id, d]) => [index.get(id), d])
    .sort((a, b) => (b[1] < a[1] ? -1 : b[1] > a[1] ? 1 : a[0] - b[0])),
  kw: Object.fromEntries(Object.entries(raw.kw).map(([w, ids]) => [w, ids.filter(id => index.has(id)).map(id => index.get(id))])),
};
return { catalog, state, baseline };
}

// Em push de código não vale a pena baixar 10 mil skills de novo: reaproveita o que já está publicado.
async function reusePublished() {
  try {
    const [c, s] = await Promise.all(['data/catalog.json', 'data/state.json'].map(async f => {
      const res = await fetch(`${PUBLISHED || config.siteUrl}${f}`, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
      return res.json();
    }));
    return { catalog: c, state: s, baseline: !!c.baseline };
  } catch (e) {
    console.log(`Nada publicado para reaproveitar (${e.message}); baixando tudo.`);
    return null;
  }
}
const { catalog, state, baseline } = (REUSE && await reusePublished()) || await buildData();

// ---------- escreve dist/ ----------
await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(path.join(OUT, 'data'), { recursive: true });
for (const f of await fs.readdir(SITE)) {
  if (['config.json'].includes(f)) continue;
  await fs.cp(path.join(SITE, f), path.join(OUT, f), { recursive: true });
}
const build = Date.now().toString(36);
const staticConfig = { ...config, mode: 'static', build };
let html = await fs.readFile(path.join(SITE, 'index.html'), 'utf8');
html = html
  .replace('<!--CATALOGO-CONFIG-->', `<script>window.CATALOGO=${JSON.stringify(staticConfig)}</script>\n<script src="static-api.js?v=${build}"></script>`)
  .replace(/%%SITE_URL%%/g, config.siteUrl).replace(/%%TITLE%%/g, config.title).replace(/%%DESCRIPTION%%/g, config.description);
await fs.writeFile(path.join(OUT, 'index.html'), html);
await fs.writeFile(path.join(OUT, 'data', 'catalog.json'), JSON.stringify(catalog));
await fs.writeFile(path.join(OUT, 'data', 'state.json'), JSON.stringify(state));
await fs.writeFile(path.join(OUT, '.nojekyll'), '');
await fs.writeFile(path.join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${config.siteUrl}sitemap.xml\n`);
await fs.writeFile(path.join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${config.siteUrl}</loc></url></urlset>\n`);

const kb = async f => Math.round((await fs.stat(path.join(OUT, f))).size / 1024);
console.log(`\nSite gerado em ${path.relative(ROOT, OUT)}/`);
console.log(`  ${catalog.total} skills · ${catalog.hot.length} em alta · ${catalog.fresh.length} novidades · ${Object.keys(catalog.kw).length} palavras-chave`);
console.log(`  catalog.json ${await kb('data/catalog.json')} KB · state.json ${await kb('data/state.json')} KB${baseline ? ' · primeira execução (linha de base)' : ''}`);
