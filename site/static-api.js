// Camada de dados do site estático (GitHub Pages).
// Responde, no próprio navegador, às chamadas /api/* que a interface faz no modo local:
// catálogo e busca (data/catalog.json), GitHub (direto), tradução, favoritas, perfil e
// a pasta de skills (File System Access API). Só roda quando window.CATALOGO.mode === 'static'.
(() => {
  'use strict';
  const CFG = window.CATALOGO || {};
  if (CFG.mode !== 'static') return;

  const realFetch = window.fetch.bind(window);
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const fail = (message, status = 500, extra = {}) => json({ error: message, ...extra }, status);
  const SOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/(?!\.+$)[A-Za-z0-9_.-]+$/;
  const SKILL_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
  const HOUR = 36e5;

  const store = {
    get(key, def) { try { const v = localStorage.getItem(key); return v == null ? def : JSON.parse(v); } catch { return def; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
  };

  /* ---------- catálogo (gerado pela tarefa agendada) ---------- */
  let catalogPromise = null, catalog = null, cats = null;

  function prepare(c) {
    const skills = c.skills.map(([source, skillId, installs], i) => ({
      i, id: `${source}/${skillId}`, source, skillId, name: skillId, installs,
      hay: `${skillId} ${source}`.toLowerCase(), tags: [],
    }));
    for (const [word, ids] of Object.entries(c.kw || {})) for (const i of ids) if (skills[i]) skills[i].tags.push(word);
    const official = new Set(c.official || []);
    const hot = new Map((c.hot || []).map(([i, change, yesterday]) => [i, { change, yesterday }]));
    const fresh = new Map((c.fresh || []).map(([i, date]) => [i, date]));
    return { raw: c, skills, official, hot, fresh };
  }

  async function loadCatalog(reload = false) {
    if (!catalogPromise || reload) {
      catalogPromise = (async () => {
        const [c, k] = await Promise.all([
          realFetch('data/catalog.json', { cache: reload ? 'reload' : 'no-cache' }).then(r => { if (!r.ok) throw new Error('Não consegui carregar o catálogo. Tente de novo em instantes.'); return r.json(); }),
          cats ? cats : realFetch('categories.json').then(r => r.json()),
        ]);
        cats = k;
        catalog = prepare(c);
        return catalog;
      })().catch(e => { catalogPromise = null; throw e; });
    }
    return catalogPromise;
  }

  const item = (s, extra = {}) => ({
    id: s.id, source: s.source, skillId: s.skillId, name: s.name, installs: s.installs,
    isNew: catalog.fresh.has(s.i), official: catalog.official.has(s.i),
    ...(catalog.hot.has(s.i) ? { change: catalog.hot.get(s.i).change } : {}), ...extra,
  });

  const byInstalls = (a, b) => b.installs - a.installs;

  function listCategory(id) {
    const { skills, hot, fresh } = catalog;
    if (id === 'populares') return skills.slice(0, 200).map(s => item(s));
    if (id === 'em-alta') return [...hot].sort((a, b) => b[1].change - a[1].change).map(([i]) => item(skills[i])).slice(0, 200);
    if (id === 'novidades') {
      return [...fresh].map(([i, d]) => ({ s: skills[i], d }))
        .sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : b.s.installs - a.s.installs)).map(x => item(x.s));
    }
    const cat = cats.categories.find(c => c.id === id);
    if (!cat) throw new Error('Categoria inválida');
    const ids = new Set();
    for (const q of cat.queries || []) for (const i of catalog.raw.kw[q] || []) ids.add(i);
    return [...ids].map(i => skills[i]).sort(byInstalls).slice(0, 200).map(s => item(s));
  }

  function search(query) {
    const norm = query.toLowerCase().trim();
    const dash = norm.replace(/\s+/g, '-'); // "code review" também casa com o nome "code-review"
    const tokens = norm.split(/\s+/).filter(Boolean);
    const phrase = new Set(catalog.raw.kw[norm] || []);
    const scored = [];
    for (const s of catalog.skills) {
      let ok = phrase.has(s.i);
      if (!ok) ok = tokens.every(t => s.hay.includes(t) || (t.length >= 3 && s.tags.some(tag => tag === t || tag.startsWith(t))));
      if (!ok) continue;
      const id = s.skillId.toLowerCase();
      const inName = tokens.filter(t => id.includes(t)).length;
      const score = (id === norm || id === dash ? 1000 : 0) + (id.startsWith(dash) ? 300 : 0) + (id.includes(dash) ? 150 : 0)
        + inName * 60 + (s.hay.includes(norm) ? 40 : 0) + (phrase.has(s.i) ? 25 : 0) + Math.log10(s.installs + 1) * 10;
      scored.push([score, s]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, 60).map(([, s]) => item(s));
  }

  /* ---------- GitHub (chamado direto do navegador) ---------- */
  // A API do GitHub dá só 60 consultas por hora por computador. Depois que estoura, para de tentar e usa o jsDelivr.
  let apiBlockedUntil = 0;
  const rateError = () => {
    const mins = Math.max(1, Math.ceil((apiBlockedUntil - Date.now()) / 60000));
    return Object.assign(new Error(`O GitHub limitou as consultas deste computador por agora. Volta em cerca de ${mins} minuto${mins > 1 ? 's' : ''}.`), { rate: true });
  };
  async function gh(path) {
    if (Date.now() < apiBlockedUntil) throw rateError();
    const res = await realFetch(`https://api.github.com${path}`, { headers: { Accept: 'application/vnd.github+json' } });
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      apiBlockedUntil = reset ? reset * 1000 : Date.now() + 10 * 60000;
      throw rateError();
    }
    if (!res.ok) throw Object.assign(new Error(`O GitHub respondeu ${res.status}.`), { status: res.status });
    return res.json();
  }
  const rawUrl = (source, file) => `https://raw.githubusercontent.com/${source}/HEAD/${file.split('/').map(encodeURIComponent).join('/')}`;

  function cachedLS(key, ttl, fn) {
    const hit = store.get(key, null);
    if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.v);
    return fn().then(v => {
      store.set(key, { at: Date.now(), v });
      return v;
    });
  }

  // Reserva sem limite de consultas: o jsDelivr lista os arquivos de qualquer repositório público do GitHub.
  async function jsdelivrTree(source) {
    const res = await realFetch(`https://data.jsdelivr.com/v1/packages/gh/${source}@HEAD?structure=flat`);
    if (res.status === 403) throw Object.assign(new Error('O repositório é grande demais para o jsDelivr.'), { tooBig: true });
    if (!res.ok) throw Object.assign(new Error(`Não consegui ler o repositório (${res.status}).`), { status: res.status });
    const d = await res.json();
    return (d.files || []).map(f => ({ path: String(f.name).replace(/^\//, ''), type: 'blob', size: f.size || 0, mode: '100644' }));
  }

  // Lista os arquivos do repositório. Primeiro pelo jsDelivr, que não limita consultas; só o que é grande demais
  // para ele (~50 MB) vai para a API do GitHub, que libera 60 consultas por hora por conexão.
  const trees = new Map();
  async function getTree(source) {
    if (!trees.has(source)) {
      trees.set(source, (async () => {
        let jsErr;
        try { return { entries: await jsdelivrTree(source), from: 'jsdelivr' }; } catch (e) { jsErr = e; }
        try {
          const d = await gh(`/repos/${source}/git/trees/HEAD?recursive=1`);
          return { entries: d.tree || [], from: 'github', truncated: !!d.truncated };
        } catch (e) {
          if (e.rate) throw Object.assign(new Error(`${jsErr.tooBig ? 'Este repositório é grande, e para ler ele o site precisa da API do GitHub, que libera 60 consultas por hora por conexão. ' : ''}${e.message}`), { code: 'ratelimit', status: 429 });
          throw e;
        }
      })().catch(e => { trees.delete(source); throw e; }));
    }
    return trees.get(source);
  }

  function findSkillPath(paths, skillId) {
    return paths.filter(p => /(^|\/)SKILL\.md$/.test(p) && p.split('/').slice(-2, -1)[0] === skillId).sort((a, b) => a.length - b.length)[0];
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

  const details = new Map();
  async function skillDetail(source, skillId) {
    const key = `${source}/${skillId}`;
    if (details.has(key)) return details.get(key);
    const p = (async () => {
      let candidates;
      try {
        const paths = await cachedLS(`catalogo.sp.${source}`, 6 * HOUR, async () => (await getTree(source)).entries.filter(e => e.type === 'blob' && /(^|\/)SKILL\.md$/.test(e.path)).map(e => e.path));
        const found = findSkillPath(paths, skillId);
        candidates = found ? [found] : [`skills/${skillId}/SKILL.md`, `${skillId}/SKILL.md`, `.claude/skills/${skillId}/SKILL.md`];
      } catch (e) {
        if (e.status === 400) throw e; // sem a lista de arquivos: tenta os caminhos mais comuns
        candidates = [`skills/${skillId}/SKILL.md`, `${skillId}/SKILL.md`, `.claude/skills/${skillId}/SKILL.md`, 'SKILL.md']; // sem a API: tenta os caminhos comuns
      }
      for (const file of candidates) {
        const res = await realFetch(rawUrl(source, file));
        if (!res.ok) continue;
        const text = await res.text();
        const fm = parseFrontmatter(text);
        return {
          source, skillId, name: fm.name || skillId, description: fm.description || '(sem descrição no SKILL.md)',
          content: text.slice(0, 20000), githubUrl: `https://github.com/${source}/blob/HEAD/${file}`,
        };
      }
      throw new Error('Não encontrei o SKILL.md desta skill no repositório.');
    })().catch(e => { details.delete(key); throw e; });
    details.set(key, p);
    return p;
  }

  async function repoInfo(source) {
    const base = { source, url: `https://github.com/${source}`, ownerUrl: `https://github.com/${source.split('/')[0]}`, stats: null };
    try {
      return await cachedLS(`catalogo.repo.${source}`, 6 * HOUR, async () => {
        const d = await gh(`/repos/${source}`);
        return {
          ...base,
          stats: {
            stars: d.stargazers_count, forks: d.forks_count, language: d.language || null,
            license: d.license && d.license.spdx_id !== 'NOASSERTION' ? d.license.spdx_id : null,
            pushedAt: d.pushed_at, archived: !!d.archived, description: d.description || null,
          },
        };
      });
    } catch (e) { return { ...base, limited: !!e.rate }; }
  }

  const MAX_FILES = 1000, MAX_BYTES = 64 * 1024 * 1024;
  function bytesToB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  const tooBigError = () => Object.assign(new Error('Este repositório é grande demais para o navegador listar os arquivos.'), { code: 'toobig' });
  const keep = e => e.type === 'blob' && e.mode !== '120000' && !/(^|\/)(\.git|node_modules)\//.test(e.path);
  async function skillFiles(source, skillId) {
    const { entries: tree, from, truncated } = await getTree(source);
    const md = findSkillPath(tree.filter(e => e.type === 'blob').map(e => e.path), skillId);
    if (!md) throw truncated ? tooBigError() : new Error('Skill não encontrada dentro do repositório.');
    const dir = md.includes('/') ? md.slice(0, md.lastIndexOf('/') + 1) : '';
    let entries = tree.filter(e => keep(e) && e.path.startsWith(dir));
    if (truncated) { // a lista do GitHub veio cortada: pede só a pasta da skill, que vem inteira
      const node = dir && tree.find(e => e.type === 'tree' && e.path === dir.slice(0, -1));
      if (!node) throw tooBigError();
      const sub = await gh(`/repos/${source}/git/trees/${node.sha}?recursive=1`);
      entries = (sub.tree || []).filter(keep).map(e => ({ ...e, path: dir + e.path }));
    }
    // baixa da mesma fonte da lista (mesma versão); o jsDelivr recusa arquivos acima de 20 MB, que vêm do GitHub
    const cdnUrl = file => `https://cdn.jsdelivr.net/gh/${source}@HEAD/${file.split('/').map(encodeURIComponent).join('/')}`;
    const bytes = entries.reduce((n, e) => n + (e.size || 0), 0);
    if (entries.length > MAX_FILES || bytes > MAX_BYTES) {
      throw new Error(`Esta skill é grande demais para instalar pelo navegador (limite: ${MAX_FILES} arquivos e ${MAX_BYTES / 1048576} MB).`);
    }
    const files = new Array(entries.length);
    let next = 0;
    const worker = async () => {
      while (next < entries.length) {
        const i = next++;
        let res = await realFetch(from === 'jsdelivr' ? cdnUrl(entries[i].path) : rawUrl(source, entries[i].path));
        if (!res.ok && from === 'jsdelivr') res = await realFetch(rawUrl(source, entries[i].path));
        if (!res.ok) throw new Error(`Não consegui baixar ${entries[i].path} (${res.status}).`);
        files[i] = { path: entries[i].path.slice(dir.length), data: bytesToB64(await res.arrayBuffer()) };
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, entries.length) }, worker));
    return { source, skillId, files };
  }

  /* ---------- tradução de reserva (MyMemory, direto do navegador) ---------- */
  const decodeEntities = s => s.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const byteLen = s => new TextEncoder().encode(s).length;
  function splitSegments(text, maxBytes = 420) {
    const parts = text.split(/(?<=[.!?。！？])\s+|\n+/).filter(Boolean);
    const out = [];
    for (let part of parts) {
      while (byteLen(part) > maxBytes) {
        let cut = part.length;
        while (byteLen(part.slice(0, cut)) > maxBytes) cut = Math.floor(cut * 0.8);
        out.push(part.slice(0, cut)); part = part.slice(cut);
      }
      const last = out[out.length - 1];
      if (last && byteLen(`${last} ${part}`) <= maxBytes) out[out.length - 1] = `${last} ${part}`;
      else out.push(part);
    }
    return out;
  }
  async function myMemory(segment, target) {
    const res = await realFetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(segment)}&langpair=${encodeURIComponent(`Autodetect|${target}`)}`);
    const d = await res.json().catch(() => ({}));
    const text = (d.responseData && d.responseData.translatedText) || '';
    if (d.quotaFinished || /MYMEMORY WARNING/i.test(text) || res.status === 429) {
      throw new Error('A cota gratuita de tradução de hoje acabou. Volte amanhã ou use o Chrome, que traduz sem limite.');
    }
    if (/DISTINCT LANGUAGES/i.test(text) || /DISTINCT LANGUAGES/i.test(d.responseDetails || '')) return segment;
    if (Number(d.responseStatus) !== 200 || !text) throw new Error('O serviço de tradução não respondeu. Tente de novo em instantes.');
    return decodeEntities(text);
  }
  async function translate(code, texts) {
    if (!Array.isArray(texts) || texts.length > 40 || texts.some(t => typeof t !== 'string' || t.length > 3000)) throw new Error('Textos inválidos');
    const cache = store.get('catalogo.mm', {});
    const out = [];
    for (const t of texts) {
      if (!t.trim()) { out.push(t); continue; }
      const key = `${code}|${t.slice(0, 80)}|${t.length}`;
      if (cache[key]) { out.push(cache[key]); continue; }
      const parts = [];
      for (const seg of splitSegments(t)) parts.push(await myMemory(seg, code));
      cache[key] = parts.join(' ');
      out.push(cache[key]);
    }
    const keys = Object.keys(cache);
    if (keys.length > 200) keys.slice(0, keys.length - 200).forEach(k => delete cache[k]);
    store.set('catalogo.mm', cache);
    return out;
  }

  /* ---------- favoritas e perfil (guardados no navegador) ---------- */
  const readLists = () => ({ favorites: store.get('catalogo.favorites', []) });
  const sameSkill = (a, b) => a.source === b.source && a.skillId === b.skillId;
  function toggleFavorite({ source, skillId, name, installs }) {
    if (!SOURCE_RE.test(source || '') || !SKILL_RE.test(skillId || '')) throw new Error('Skill inválida');
    const list = readLists().favorites;
    const idx = list.findIndex(s => sameSkill(s, { source, skillId }));
    if (idx >= 0) list.splice(idx, 1);
    else list.unshift({ source, skillId, name: String(name || skillId).slice(0, 120), installs: Number(installs) || 0, at: new Date().toISOString() });
    store.set('catalogo.favorites', list);
    return { on: idx < 0, lists: { favorites: list } };
  }
  function importFavorites(items) {
    if (!Array.isArray(items) || items.length > 2000) throw new Error('Arquivo inválido');
    const list = readLists().favorites;
    let added = 0;
    for (const s of items) {
      if (!s || !SOURCE_RE.test(s.source || '') || !SKILL_RE.test(s.skillId || '')) continue;
      if (list.some(x => sameSkill(x, s))) continue;
      list.push({ source: s.source, skillId: s.skillId, name: String(s.name || s.skillId).slice(0, 120), installs: Number(s.installs) || 0, at: new Date().toISOString() });
      added++;
    }
    store.set('catalogo.favorites', list);
    return { added, lists: { favorites: list } };
  }

  /* ---------- pasta de skills do computador (File System Access API) ---------- */
  const FS_OK = 'showDirectoryPicker' in window;
  const idb = () => new Promise((res, rej) => {
    const r = indexedDB.open('catalogo', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const idbGet = async k => { try { const db = await idb(); return await new Promise(res => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => res(null); }); } catch { return null; } };
  const idbSet = async (k, v) => { try { const db = await idb(); await new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); } catch {} };

  let handle = null;
  const ready = FS_OK ? idbGet('claudeDir').then(h => { if (h && h.kind === 'directory') handle = h; }) : Promise.resolve();

  async function hasPermission(h, request) {
    try {
      let p = await h.queryPermission({ mode: 'readwrite' });
      if (p !== 'granted' && request) p = await h.requestPermission({ mode: 'readwrite' });
      return p === 'granted';
    } catch { return false; }
  }

  async function connect() { // precisa ser chamado por um clique
    const h = await showDirectoryPicker({ id: 'claude-dir', mode: 'readwrite' });
    if (h.name !== '.claude' && h.name !== 'skills') throw new Error(`Você escolheu "${h.name}". Escolha a pasta .claude (ou a pasta skills dentro dela).`);
    handle = h; await idbSet('claudeDir', h);
    return h;
  }

  // Devolve a pasta liberada. Com ask:true pede a permissão ou abre a janela de escolha da pasta.
  async function folder({ ask = false } = {}) {
    await ready;
    if (handle && await hasPermission(handle, ask)) return handle;
    if (!ask) return null;
    if (window.CATUI && window.CATUI.askFolder) return window.CATUI.askFolder();
    return connect();
  }

  const skillsDirOf = async (h, create) => (h.name === 'skills' ? h : h.getDirectoryHandle('skills', { create }));
  const b64ToBytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const safePath = p => p.split('/').every(seg => seg && seg !== '.' && seg !== '..' && !/[\\:]/.test(seg));

  // diz em qual passo o navegador recusou (o erro dele sozinho não informa)
  const step = async (label, fn) => { try { return await fn(); } catch (e) { throw Object.assign(new Error(`${label} → ${e.name || 'erro'}: ${e.message}`), { name: e.name }); } };
  // grava em pedaços de 1 MB: arquivos grandes de uma vez só falham em alguns navegadores
  async function writeFile(dir, name, bytes) {
    const fh = await step('criar o arquivo', () => dir.getFileHandle(name, { create: true }));
    const w = await step('abrir para gravar', () => fh.createWritable());
    try {
      for (let i = 0; i < bytes.length || i === 0; i += 1 << 20) await step('gravar o conteúdo', () => w.write(bytes.subarray(i, i + (1 << 20))));
      await step('fechar o arquivo', () => w.close());
    } catch (e) { await w.abort().catch(() => {}); throw e; }
  }
  async function writeSkill(h, skillId, source, files) {
    const skills = await step('abrir a pasta skills', () => skillsDirOf(h, true));
    try { await skills.getDirectoryHandle(skillId); throw Object.assign(new Error(`"${skillId}" já existe nessa pasta.`), { code: 'exists' }); }
    catch (e) { if (e.name !== 'NotFoundError') throw e; }
    for (const f of files) if (!safePath(f.path)) throw new Error(`Caminho de arquivo inválido: ${f.path}`);
    const root = await step(`criar a pasta ${skillId}`, () => skills.getDirectoryHandle(skillId, { create: true }));
    const skipped = [];
    try {
      // SKILL.md e arquivos de texto primeiro: se o essencial não grava, a instalação é desfeita
      const essential = f => /(^|\/)SKILL\.md$/i.test(f.path);
      const ordered = [...files].sort((x, y) => essential(y) - essential(x));
      for (const f of ordered) {
        const parts = f.path.split('/');
        const put = async () => {
          let dir = root;
          for (const seg of parts.slice(0, -1)) { const d = dir; dir = await step(`criar a subpasta ${seg}`, () => d.getDirectoryHandle(seg, { create: true })); }
          await writeFile(dir, parts[parts.length - 1], b64ToBytes(f.data));
        };
        try { await put(); }
        catch (err) {
          try { await new Promise(r => setTimeout(r, 300)); await put(); } // uma segunda tentativa resolve travas passageiras
          catch (err2) {
            if (essential(f)) throw new Error(`Não consegui gravar "${f.path}" (${err2.name || 'erro'}: ${err2.message}).`);
            skipped.push({ path: f.path, reason: `${err2.name || 'erro'}: ${err2.message}` });
          }
        }
      }
      if (skipped.length > files.length / 2) throw new Error(`Muitos arquivos falharam (${skipped.length} de ${files.length}). Primeiro: "${skipped[0].path}" (${skipped[0].reason}).`);
      const mark = await (await root.getFileHandle('.catalogo-skill.json', { create: true })).createWritable();
      await mark.write(JSON.stringify({ source, skillId, installedAt: new Date().toISOString(), via: 'site' }, null, 2)); await mark.close();
    } catch (e) {
      await skills.removeEntry(skillId, { recursive: true }).catch(() => {}); // não deixa uma instalação pela metade
      throw e;
    }
    return skipped;
  }

  // Navegadores isolados (snap/flatpak no Linux) recebem a pasta escolhida só para leitura.
  // Testa antes de baixar a skill, para a tela mostrar o passo a passo em vez de um erro no meio da instalação.
  async function assertWritable(h) {
    try {
      const skills = await skillsDirOf(h, true);
      const probe = '.catalogo-teste-gravacao';
      const w = await (await skills.getFileHandle(probe, { create: true })).createWritable();
      await w.write('ok'); await w.close();
      await skills.removeEntry(probe);
    } catch (e) {
      if (e.name !== 'NoModificationAllowedError') throw Object.assign(new Error(e.message), { name: e.name, code: 'write' }); // outro erro de gravação: a tela roda o teste
      throw Object.assign(new Error('O sistema entregou a pasta ao navegador só para leitura.'), { status: 403, code: 'readonly', folder: h.name });
    }
  }
  async function checkWritable() { // true, false (só leitura) ou null (nenhuma pasta conectada)
    const h = await folder();
    if (!h) return null;
    try { await assertWritable(h); return true; } catch (e) { if (e.code === 'readonly') return false; throw e; }
  }

  async function installSkill(source, skillId) {
    if (!FS_OK) throw new Error('Este navegador não consegue gravar na sua pasta. Use o Chrome ou o Edge.');
    const h = await folder({ ask: true }); // antes de qualquer espera: precisa do clique
    await assertWritable(h);
    const { files } = await skillFiles(source, skillId);
    let skipped;
    try { skipped = await writeSkill(h, skillId, source, files); }
    catch (e) { throw Object.assign(new Error(e.message), { name: e.name, code: typeof e.code === 'string' ? e.code : 'write' }); }
    return { ok: true, files: files.length - skipped.length, skipped };
  }

  async function removeSkill(skillId) {
    const h = await folder({ ask: true });
    const skills = await skillsDirOf(h, false);
    try { await skills.getDirectoryHandle(skillId); } catch { throw new Error(`"${skillId}" não está na pasta de skills.`); }
    await skills.removeEntry(skillId, { recursive: true });
    return { ok: true, removed: 'pasta' };
  }

  async function listInstalled() {
    const base = { dir: '~/.claude/skills', skills: [], supported: FS_OK, connected: !!handle };
    const h = await folder();
    if (!h) return base;
    let skills;
    try { skills = await skillsDirOf(h, false); } catch { return { ...base, granted: true }; }
    const out = [];
    for await (const [name, entry] of skills.entries()) {
      if (entry.kind !== 'directory' || name.startsWith('.')) continue;
      try {
        const file = await (await entry.getFileHandle('SKILL.md')).getFile();
        const fm = parseFrontmatter((await file.text()).slice(0, 4000));
        let source = null, at = null;
        try { const m = JSON.parse(await (await (await entry.getFileHandle('.catalogo-skill.json')).getFile()).text()); source = m.source || null; at = m.installedAt || null; } catch {}
        out.push({ skillId: name, source, description: fm.description || '', installedAt: at || new Date(file.lastModified).toISOString() });
      } catch { /* pasta sem SKILL.md: não é uma skill */ }
    }
    out.sort((a, b) => b.installedAt.localeCompare(a.installedAt));
    return { ...base, granted: true, skills: out };
  }

  async function localSkill(skillId) {
    const h = await folder();
    if (!h) throw new Error('Conecte a pasta de skills para ler esta skill.');
    const dir = await (await skillsDirOf(h, false)).getDirectoryHandle(skillId);
    const text = await (await (await dir.getFileHandle('SKILL.md')).getFile()).text();
    const fm = parseFrontmatter(text);
    return { skillId, name: fm.name || skillId, description: fm.description || '(sem descrição no SKILL.md)', content: text.slice(0, 20000) };
  }

  // Teste de gravação: roda quando a instalação falha e diz o que o navegador aceita ou recusa nessa pasta.
  async function diagnose() {
    const out = [];
    const h = await folder();
    if (!h) return ['pasta: nenhuma pasta conectada'];
    out.push(`pasta escolhida: ${h.name}`);
    try { out.push(`permissão: ${await h.queryPermission({ mode: 'readwrite' })}`); } catch (e) { out.push(`permissão: ${e.name}`); }
    let skills;
    try { skills = await skillsDirOf(h, true); out.push(`pasta skills: ok (${skills.name})`); }
    catch (e) { out.push(`pasta skills: ${e.name}: ${e.message}`); return out; }
    let total = 0, failed = 0;
    const probe = async (label, fn) => { total++; try { await fn(); out.push(`${label}: ok`); } catch (e) { failed++; out.push(`${label}: ${e.name}: ${e.message}`); } };
    const put = async (dir, name, text) => { const w = await (await dir.getFileHandle(name, { create: true })).createWritable(); await w.write(text); await w.close(); };
    await probe('gravar arquivo comum', async () => { await put(skills, 'catalogo-teste.txt', 'x'); await skills.removeEntry('catalogo-teste.txt'); });
    await probe('gravar arquivo oculto (.nome)', async () => { await put(skills, '.catalogo-teste', 'x'); await skills.removeEntry('.catalogo-teste'); });
    await probe('criar subpasta e gravar dentro', async () => { const d = await skills.getDirectoryHandle('catalogo-teste-dir', { create: true }); await put(d, 'a.txt', 'x'); await skills.removeEntry('catalogo-teste-dir', { recursive: true }); });
    await probe('gravar arquivo de 3 MB', async () => { const w = await (await skills.getFileHandle('catalogo-teste.bin', { create: true })).createWritable(); await w.write(new Uint8Array(3 << 20)); await w.close(); await skills.removeEntry('catalogo-teste.bin'); });
    out.allDenied = total > 0 && failed === total; // nada grava: o navegador está sem acesso à pasta (ex.: isolado por snap/flatpak)
    return out;
  }

  window.CAT = { supported: FS_OK, connect, folder, diagnose, checkWritable, folderName: () => handle && handle.name, hasHandle: () => !!handle, ready, loadCatalog: () => loadCatalog(), lookup: ids => ids.map(id => (catalog && catalog.skills.find(s => s.id === id)) || null) };

  /* ---------- roteador das chamadas /api/* ---------- */
  let langs = null;
  async function route(path, query, method, body) {
    switch (`${method} ${path}`) {
      case 'GET /api/categories': await loadCatalog(); return cats.categories.map(({ id, label }) => ({ id, label }));
      case 'GET /api/langs': langs ||= await realFetch('langs.json').then(r => r.json()); return { langs };
      case 'GET /api/skills': {
        await loadCatalog();
        const q = (query.get('q') || '').trim().slice(0, 80);
        return q ? search(q) : listCategory(query.get('category') || 'populares');
      }
      case 'GET /api/lookup': {
        await loadCatalog();
        const ids = (query.get('ids') || '').split(',').slice(0, 400);
        return { skills: ids.map(id => { const s = catalog.skills.find(x => x.id === id); return s ? item(s) : null; }) };
      }
      case 'GET /api/skill': {
        const source = query.get('source') || '', skillId = query.get('skillId') || '';
        if (!SOURCE_RE.test(source) || !SKILL_RE.test(skillId)) throw Object.assign(new Error('Parâmetros inválidos'), { status: 400 });
        return skillDetail(source, skillId);
      }
      case 'GET /api/repo': {
        const source = query.get('source') || '';
        if (!SOURCE_RE.test(source)) throw Object.assign(new Error('Parâmetros inválidos'), { status: 400 });
        return repoInfo(source);
      }
      case 'GET /api/status': { await loadCatalog(); return { refreshedAt: catalog.raw.updatedAt, newCount: catalog.fresh.size }; }
      case 'POST /api/refresh': {
        await loadCatalog(true);
        const known = new Set(store.get('catalogo.seenFresh', []));
        const ids = [...catalog.fresh.keys()].map(i => catalog.skills[i].id);
        const newCount = ids.filter(id => !known.has(id)).length;
        store.set('catalogo.seenFresh', ids.slice(0, 500));
        return { newCount, totalNew: ids.length, refreshedAt: catalog.raw.updatedAt, firstRun: false };
      }
      case 'POST /api/translate': return { translations: await translate(body.lang, body.texts) };
      case 'GET /api/lists': return readLists();
      case 'POST /api/lists/toggle': return toggleFavorite(body);
      case 'POST /api/lists/import': return importFavorites(body.favorites);
      case 'GET /api/me': return { configured: true, user: store.get('catalogo.profile', null) };
      case 'GET /api/installed': return listInstalled();
      case 'GET /api/local-skill': return localSkill(query.get('skillId') || '');
      case 'POST /api/install': {
        if (!SOURCE_RE.test(body.source || '') || !SKILL_RE.test(body.skillId || '')) throw Object.assign(new Error('Parâmetros inválidos'), { status: 400 });
        return installSkill(body.source, body.skillId);
      }
      case 'POST /api/uninstall': {
        if (!SKILL_RE.test(body.skillId || '')) throw Object.assign(new Error('Parâmetros inválidos'), { status: 400 });
        return removeSkill(body.skillId);
      }
      default: throw Object.assign(new Error('Não encontrado'), { status: 404 });
    }
  }

  window.fetch = async (input, init = {}) => {
    const raw = typeof input === 'string' ? input : input.url;
    let url;
    try { url = new URL(raw, location.href); } catch { return realFetch(input, init); }
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
    try {
      let body = {};
      if (init.body) { try { body = JSON.parse(init.body); } catch {} }
      return json(await route(url.pathname, url.searchParams, (init.method || 'GET').toUpperCase(), body));
    } catch (e) {
      return fail(e.message || 'Erro inesperado', e.status || 500, typeof e.code === 'string' ? { code: e.code, folder: e.folder } : {});
    }
  };
})();
