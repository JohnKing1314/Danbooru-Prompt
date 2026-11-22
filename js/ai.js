
/* ===== js/ai.js ===== */
/* =====================================================================
   ai.js · 浏览器里的「AI 选词」工具循环
   ---------------------------------------------------------------------
   和 server.mjs 里的 chatWithTools 是同一套逻辑，区别只在于：
   这里直接由浏览器 POST 到 OpenAI 兼容接口（DeepSeek 允许 file:// 的
   跨域请求，Origin: null），所以不需要本地服务也能用。
   ===================================================================== */
(function () {
  'use strict';

  const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

  /* ---------------- 1. 把页面里已经载入的标签库整理成检索用的结构 ---------------- */

  let LIB = null;

  function buildLibrary() {
    if (LIB) return LIB;
    const tags = [];
    const seen = new Set();
    const cats = [];
    (window.PG_TAGS || []).forEach(cat => {
      cats.push({ id: cat.id, name: cat.name, icon: cat.icon });
      String(cat.tags || '').split('\n').forEach(line => {
        const t = line.trim();
        if (!t) return;
        const i = t.indexOf('|');
        const en = (i < 0 ? t : t.slice(0, i)).trim();
        const zh = i < 0 ? '' : t.slice(i + 1).trim();
        const k = norm(en);
        if (!en || seen.has(k)) return;
        seen.add(k);
        tags.push({ en, zh, key: k, cat: cat.id, catName: cat.name });
      });
    });
    const chars = (window.PG_CHARACTERS || []).map(c => ({
      name: c.name, tag: c.tag, zh: c.charZh || c.name, game: c.game,
      auto: String(c.auto || '').split(';').map(s => s.trim()).filter(Boolean)
    }));
    LIB = {
      tags, chars, cats,
      byKey: new Map(tags.map(t => [t.key, t])),
      charByKey: new Map(chars.filter(c => c.tag).map(c => [norm(c.tag), c]))
    };
    return LIB;
  }

  /* 每个分类抽几个代表作，让模型知道库里有什么，又不至于烧 token */
  function catalogSummary(perCat) {
    const L = buildLibrary();
    const map = new Map();
    L.tags.forEach(t => {
      if (!map.has(t.cat)) map.set(t.cat, { name: t.catName, items: [] });
      const b = map.get(t.cat);
      if (b.items.length < (perCat || 14)) b.items.push(t.en);
    });
    return [...map.entries()].map(([, b]) => `- ${b.name}：${b.items.join('、')}`).join('\n');
  }

  function systemPrompt(opts) {
    const online = !(opts && opts.online === false);
    const L = buildLibrary();
    const head = `你是一个动漫绘图提示词（prompt）助手，服务于本地标签库工具 Prompt Forge。

标签库共 ${L.tags.length} 条标签，分为这些分类：
${catalogSummary()}

你的工作方式：
1. 用户用中文描述想要的画面。先用 search_tags 检索（可以换关键词、换分类），但**整轮最多调用 6 次**：查到能用的标签就停下来，直接进入 finish，不要为了同一个意思反复换词。
2. 选够 10~22 个标签，覆盖：质量/风格、画师（可选）、角色、人物外貌、服装、表情、姿势、场景、光影、镜头构图。用户没提的细节你可以合理补全，但不要与用户描述矛盾。
3. 标签必须来自 search_tags 的返回结果，尽量使用英文原样。如果用户点名了标签库里没有的角色或元素，可以把该英文词直接写进结果。
4. 全部想清楚后，调用 finish 工具提交：positive 为正向标签数组（按 质量→画师→角色→外貌→服装→姿势→场景→光影→镜头 排列），negative 为负面标签数组（可留空），reply 用中文简短说明你选了什么、为什么。
5. 不要调用 finish 之外的任何工具；也不要输出 JSON 文本给用户，用户只看 finish 里的 reply。
6. 如果用户对你的选词提出修改（加/减/换风格），在上一轮结果基础上调整，然后再次调用 finish。
7. 标签库覆盖不了的细节，必须补成自然英文短句放进 finish 的 text_prompts：例如「双手举高比耶」这种复合动作、具体的叙事场景、服装的细微动态。每条是 {en, zh}：en 是不超过 18 个词的自然英文短句（句子内部不要用逗号、括号），zh 是它的中文翻译。宁可多写两条，也不要漏掉用户描述的动作或细节；标签库里有现成标签的一律优先用标签，只在确实缺失时才写文本。
`;

    if (!online) {
      return head + `

【快速模式 · 不联网】
- 这次不允许联网、也没有查证工具：不要调用 lookup_character（它不存在），也不要尝试任何网络查询。
- 最多调用 2 次 search_tags 就必须 finish，不要反复换词检索；能一次说清的就只查一次。
- 用户点名的角色如果库里没有，就直接用用户给的名字（或你确定的英文写法）写进 positive，不要编造发色、瞳色、服装等外观细节；reply 里一句话说明「这个角色库里没有，外观按你的描述来」。
- reply 控制在 60 字以内，不要解释过程。`;
    }

    return head + `

8. 【角色】用户点名了某个具体角色时：
   · 先用 search_tags 查（query 填角色名，category 填 character）看本地角色库有没有 —— 库里有就直接用库里的角色标签和外观标签，不要再联网。
   · 库里没有，就调用 lookup_character：name 填角色名（中文、英文都行），aliases 再给 0~3 个备选拼写，game 填作品名。它会依次试 本地库 → 百度百科（拿官方立绘+简介+信息框）→ AniList → Danbooru（能连上就算），然后**把拿到的图片交给视觉模型直接识图**，把外观说成英文标签。哪个源连不上它自己会跳过，不用你操心。
   · 拿到资料后：角色标签用返回里的规范写法（例如 amiya (arknights)）；外观标签从返回的「可用的外观标签池」里挑 6~14 个，顺序 角色 → 发色 → 发型 → 瞳色 → 服装 → 配饰；池子里没有同义标签的，直接把英文原词写进 positive 也行。
   · **查不到也照样交稿**：百科和图站都没给料时，按你自己对这个角色的理解写 —— 发色、发型、瞳色、服装都可以推断，不要空着、不要让用户再等。推断出来的项在 reply 里用「（推断）」标一下，让用户知道哪些是查到的、哪些是猜的。
   · 用户对角色外观有明确描述时，以用户的描述为准，覆盖推断。
9. 只要这一轮用过 lookup_character，reply 末尾用一句短话说明来源，例如「外观照百度百科的角色立绘认图来的」「百科没资料，外观是我推断的」。
10. 别因为查证卡住整轮：lookup_character 最多调 2 次，查完不管结果如何都要 finish。`;
  }

  /* ---------------- 2. 检索 ---------------- */

  function scoreTag(t, q, parts) {
    const en = t.key;
    const zh = t.zh || '';
    let s = 0;
    if (en === q) s = 200;
    else if (en.startsWith(q)) s = 120;
    else if (en.includes(q)) s = 80;
    if (zh) {
      if (zh === q) s = Math.max(s, 190);
      else if (zh.includes(q)) s = Math.max(s, 110);
    }
    if (!s && parts.length) {
      let hit = 0;
      parts.forEach(p => {
        if (p.length < 2) return;
        if (en.includes(p) || zh.includes(p)) hit++;
      });
      if (hit) s = 30 + hit * 10;
    }
    return s;
  }

  function fmtTagList(list, q) {
    if (!list.length) return `没有找到与「${q || ''}」匹配的标签，换一个关键词或去掉 category 限制再试。`;
    return `共 ${list.length} 条：\n` + list.map(t => `${t.en} ｜ ${t.zh || '(无中文)'} ｜ ${t.catName}`).join('\n')
      + '\n（够用就直接 finish；同一个意思不要反复换关键词查）';
  }

  function toolSearchTags(args) {
    const L = buildLibrary();
    const q = norm(args && args.query);
    const cat = args && args.category ? String(args.category) : '';
    const limit = Math.min(Math.max(Number(args && args.limit) || 30, 5), 60);
    const parts = q.split(/[\s,，、/]+/).filter(Boolean);

    /* 角色库也算「标签库」的一部分：以前只搜 L.tags，所以模型压根看不见库里有什么角色 */
    const wantChar = /^(character|char|characters|角色|角色库)$/.test(norm(cat));
    const charHits = [];
    if (q) {
      L.chars.forEach(c => {
        const fields = [c.name, c.zh, c.tag, c.game].map(norm).filter(Boolean);
        let sc = 0;
        parts.forEach(p => {
          if (p.length < 2) return;
          fields.forEach(f => {
            if (f === p) sc = Math.max(sc, 100);
            else if (f.indexOf(p) === 0) sc = Math.max(sc, 70);
            else if (f.indexOf(p) >= 0) sc = Math.max(sc, 40);
          });
        });
        if (sc) charHits.push({ c: c, s: sc });
      });
      charHits.sort((a, b) => b.s - a.s);
    }

    const charBlock = () => {
      if (!charHits.length) return '';
      return '【角色库命中】' + charHits.slice(0, 6).map(x =>
        x.c.name + '（' + x.c.tag + '，' + x.c.game + '）外观 ' + x.c.auto.length + ' 项：' + x.c.auto.slice(0, 10).join('、')
      ).join(NL) + NL + '用法：角色标签原样照抄（例如 amiya (arknights) 这种写法）；外观直接取上面的项，不用再联网查。' + NL;
    };

    if (wantChar) {
      if (!charHits.length) return '角色库里没有匹配「' + (args && args.query ? args.query : '') + '」的角色，可以用 lookup_character 上网查，或直接按你的理解写。';
      return charBlock();
    }

    let pool = L.tags;
    if (cat) {
      const f = pool.filter(t => t.cat === cat || t.catName === cat);
      if (f.length) pool = f;
    }
    if (!q) {
      const out = [];
      const byCat = new Map();
      for (const t of pool) {
        const n = byCat.get(t.cat) || 0;
        if (n >= Math.ceil(limit / 6)) continue;
        byCat.set(t.cat, n + 1);
        out.push(t);
        if (out.length >= limit) break;
      }
      return fmtTagList(out);
    }
    const scored = [];
    pool.forEach(t => {
      const s = scoreTag(t, q, parts);
      if (s > 0) scored.push({ t, s });
    });
    scored.sort((a, b) => b.s - a.s || a.t.en.length - b.t.en.length);
    const picked = scored.slice(0, limit).map(x => x.t);
    /* 角色库已经命中了，就别再叠一句「没找到标签」，模型会以为查证失败 */
    if (charHits.length && !picked.length) return charBlock();
    const body = fmtTagList(picked, q);
    return charBlock() + body;
  }

  /* ---------------- 3. 结果归一到标签库写法 ---------------- */

  /* 剥掉 (tag:1.2) / [[tag]] / \(tag\) 这类包装，但角色名自带的括号必须留下 */
  /* ---------------- 2.5 角色资料查证 ----------------
     不再把某个维基当成必经步骤，改成「谁连得上就用谁」：
       0) 本地角色库        ← 零网络，命中直接用
       1) 百度百科开放接口  ← JSONP 绕开 CORS，给「官方立绘图 + 简介 + 信息框」
       2) AniList GraphQL   ← 开放 CORS，给「角色图 + 简介」
       3) biligame 维基     ← 默认关掉（要开就设 window.__PG_USE_BILIGAME__ = true）
       4) Danbooru 图站     ← 连得上才统计外观标签，连不上直接跳过
       5) 视觉模型          ← 直接看上面拿到的图，把外观说成英文标签
       6) 全都没有          ← 明确允许模型按自己的理解补（不再禁止推断）
     任何一个源挂掉只损失自己那一行，不阻塞整体，也不把"查不到"当成结论。 */

  const NL = String.fromCharCode(10);
  const DANBOORU = 'https://danbooru.donmai.us';
  const ANILIST = 'https://graphql.anilist.co';
  const KITSU = 'https://kitsu.io/api/edge/characters';
  const BILIGAME = 'https://wiki.biligame.com/';
  const BAIKE = 'https://baike.baidu.com/api/openapi/BaikeLemmaCardApi';
  const CACHE_KEY = 'pg_char_lookup_v2';

  const GAME_HINTS = [
    { re: /星穹|崩铁|崩坏|star ?rail|hsr/i, copy: 'honkai:_star_rail', name: '崩坏：星穹铁道', wiki: 'sr' },
    { re: /原神|genshin/i, copy: 'genshin_impact', name: '原神', wiki: 'ys' },
    { re: /方舟|arknights/i, copy: 'arknights', name: '明日方舟', wiki: 'ak' },
    { re: /鸣潮|wuthering/i, copy: 'wuthering_waves', name: '鸣潮', wiki: 'mc' },
    { re: /蔚蓝档案|blue ?archive/i, copy: 'blue_archive', name: '蔚蓝档案', wiki: 'ba' },
    { re: /绝区零|zenless/i, copy: 'zenless_zone_zero', name: '绝区零', wiki: 'zzz' },
    { re: /崩坏3|honkai ?impact/i, copy: 'honkai_impact_3rd', name: '崩坏3', wiki: 'bh3' }
  ];

  const META_TAGS = new Set(('1girl 1boy 2girls 3girls multiple_girls solo solo_focus official_art dated '
    + 'signature artist_name watermark commentary english_commentary highres absurdres lowres '
    + 'simple_background white_background transparent_background grey_background '
    + 'alternate_costume official_alternate_costume character_request looking_at_viewer '
    + 'looking_away pov from_side from_behind hug').split(' '));

  let lookupSources = [];
  let lastWikiErr = '';
  let lastDbrErr = '';
  let lastBaikeErr = '';
  let lastAiErr = '';
  let lastVisErr = '';

  /* 视觉模型配置：由 app.js（或 server.mjs）在每轮开始前塞进来。
     model 留空就用主模型；主模型不支持看图时，识图这一步会被自动跳过。 */
  let visionCfg = { base: '', model: '', key: '' };

  function setVision(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    visionCfg = {
      base: String(cfg.base || '').replace(/\/+$/, ''),
      model: String(cfg.model || ''),
      key: String(cfg.key || '')
    };
  }

  function hasCJK(v) {
    const s = String(v || '');
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0x4e00 && c <= 0x9fff) return true;
    }
    return false;
  }

  function slugifyName(v) {
    return String(v || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ():_-]/g, '')
      .trim()
      .replace(/ +/g, '_');
  }

  function prettyTag(t) {
    return String(t || '').replace(/_/g, ' ');
  }

  function stripComments(s) {
    let out = String(s || '');
    for (let i = 0; i < 40; i++) {
      const a = out.indexOf('<!--');
      if (a < 0) break;
      const b = out.indexOf('-->', a);
      if (b < 0) { out = out.slice(0, a); break; }
      out = out.slice(0, a) + out.slice(b + 3);
    }
    return out;
  }

  function stripTemplates(s) {
    let out = String(s || '');
    for (let i = 0; i < 60; i++) {
      const a = out.indexOf('{{');
      if (a < 0) break;
      const b = out.indexOf('}}', a);
      if (b < 0) break;
      out = out.slice(0, a) + out.slice(b + 2);
    }
    return out;
  }

  function stripLinks(s) {
    let out = String(s || '');
    for (let i = 0; i < 60; i++) {
      const a = out.indexOf('[[');
      if (a < 0) break;
      const b = out.indexOf(']]', a);
      if (b < 0) break;
      const inner = out.slice(a + 2, b);
      const bar = inner.indexOf('|');
      out = out.slice(0, a) + (bar >= 0 ? inner.slice(bar + 1) : inner) + out.slice(b + 2);
    }
    return out;
  }

  function cleanWiki(s) {
    let out = stripLinks(stripTemplates(stripComments(s)));
    out = out.split('<br>').join(' ').split('<br />').join(' ').split('<br/>').join(' ');
    out = out.split('&nbsp;').join(' ').split('</').join(' ');
    for (let i = 0; i < 20; i++) {
      const a = out.indexOf('<');
      if (a < 0) break;
      const b = out.indexOf('>', a);
      if (b < 0) break;
      out = out.slice(0, a) + ' ' + out.slice(b + 1);
    }
    return out.split(String.fromCharCode(39) + String.fromCharCode(39)).join('').replace(/ +/g, ' ').trim();
  }

  /* 维基信息框是按行写的，逐行取比正则稳 */
  function infoboxFields(w) {
    const map = {};
    String(w || '').split(NL).forEach(line => {
      const t = line.trim();
      if (!t || t.charAt(0) !== '|') return;
      const eq = t.indexOf('=');
      if (eq < 3) return;
      const k = t.slice(1, eq).trim();
      if (!k || k.indexOf('{') >= 0 || k.length > 12) return;
      map[k] = t.slice(eq + 1).trim();
    });
    return map;
  }

  /* 浏览器里 fetch 不允许改 User-Agent；Node 里靠 window.__PG_AI_HEADERS__ 注入 */
  function extraHeaders() {
    const h = window.__PG_AI_HEADERS__;
    return h && typeof h === 'object' ? Object.assign({}, h) : {};
  }

  function sleep(ms) {
    return new Promise(function (ok) { setTimeout(ok, ms); });
  }

  async function apiJsonOnce(url, timeoutMs) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs || 12000) : null;
    try {
      const opt = { headers: Object.assign({ Accept: 'application/json, text/plain, */*' }, extraHeaders()) };
      if (ctl) opt.signal = ctl.signal;
      const r = await fetch(url, opt);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function apiJson(url, timeoutMs) {
    try {
      return await apiJsonOnce(url, timeoutMs);
    } catch (e) {
      if (!/HTTP (429|5\d\d)/.test(String(e && e.message))) throw e;
      await sleep(700);
      return await apiJsonOnce(url, timeoutMs);
    }
  }

  async function postJson(url, body, timeoutMs) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs || 12000) : null;
    try {
      const headers = Object.assign({ 'Content-Type': 'application/json' }, extraHeaders());
      const opt = { method: 'POST', headers: headers, body: JSON.stringify(body) };
      if (ctl) opt.signal = ctl.signal;
      const r = await fetch(url, opt);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function postJsonAuth(url, body, key, timeoutMs) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs || 45000) : null;
    try {
      const opt = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (key || '') },
        body: JSON.stringify(body)
      };
      if (ctl) opt.signal = ctl.signal;
      const r = await fetch(url, opt);
      const raw = await r.text();
      if (!r.ok) {
        let msg = raw;
        try { msg = JSON.parse(raw).error.message || raw; } catch (e) { /* 原样 */ }
        throw new Error('HTTP ' + r.status + ' ' + String(msg).slice(0, 160));
      }
      return JSON.parse(raw);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /* 从一段可能带 ``` 围栏的文本里抠出 JSON */
  function pickJson(text) {
    const s = String(text || '').trim();
    if (!s) return null;
    const tries = [s];
    const fence = s.match(/```(?:json)?([\s\S]*?)```/i);
    if (fence) tries.push(fence[1]);
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) tries.push(s.slice(a, b + 1));
    for (const t of tries) {
      try {
        const v = JSON.parse(t);
        if (v && typeof v === 'object') return v;
      } catch (e) { /* 下一个 */ }
    }
    return null;
  }

  /* ---------------- 百度百科 ----------------
     开放接口支持 callback= 参数，用 <script> 注入即可绕过 CORS（<script> 不受同源限制）。
     Node 里没有 document，就直接 fetch JSON。 */
  let baikeSeq = 0;

  function baikeRequest(url, timeoutMs) {
    const ms = timeoutMs || 9000;
    if (typeof document === 'undefined' || !document.createElement) {
      return apiJsonOnce(url, ms);
    }
    return new Promise(function (ok, fail) {
      const cb = 'pgb' + (++baikeSeq);
      const script = document.createElement('script');
      let done = false;
      const timer = setTimeout(function () { finish(new Error('百度百科超时')); }, ms);
      function cleanup() {
        clearTimeout(timer);
        try { delete window[cb]; } catch (e) { window[cb] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      }
      function finish(err, data) {
        if (done) return;
        done = true;
        cleanup();
        if (err) fail(err); else ok(data);
      }
      window[cb] = function (data) { finish(null, data); };
      script.onerror = function () { finish(new Error('百度百科没连上')); };
      script.src = url + '&callback=' + cb;
      (document.head || document.documentElement).appendChild(script);
    });
  }

  function baikeCardMap(card) {
    const out = {};
    (Array.isArray(card) ? card : []).forEach(it => {
      if (!it || !it.name) return;
      const v = (it.value || it.format || []).map(x => cleanWiki(String(x))).filter(Boolean).join(' / ');
      if (v) out[String(it.name)] = v;
    });
    return out;
  }

  /* 百度百科：中文名一次就能拿到图 + 简介 + 信息框，是最省事的一站 */
  async function baikeLookup(name, timeoutMs) {
    const url = BAIKE + '?scope=103&format=json&appid=379020&bk_length=1200&bk_key='
      + encodeURIComponent(name);
    let d = null;
    try {
      d = await baikeRequest(url, timeoutMs);
    } catch (e) {
      lastBaikeErr = String((e && e.message) || e);
      return null;
    }
    if (!d || !d.title || !d.key) {
      lastBaikeErr = lastBaikeErr || '没有这个词条';
      return null;
    }
    const card = baikeCardMap(d.card);
    const image = String(d.image || d.customImg || '');
    return {
      title: cleanWiki(d.title),
      key: cleanWiki(d.key),
      desc: cleanWiki(d.desc || ''),
      abstract: cleanWiki(d.abstract || '').slice(0, 900),
      card: card,
      image: /^https?:\/\//.test(image) ? image : '',
      imageW: Number(d.imageWidth) || 0,
      imageH: Number(d.imageHeight) || 0,
      url: String(d.url || '')
    };
  }

  /* ---------------- 其它源 ---------------- */

  async function wikiLookup(name, game) {
    const hint = GAME_HINTS.find(g => g.re.test(game || '')) || null;
    const subs = hint ? [hint.wiki] : ['sr', 'ys', 'ak', 'mc'];
    for (const sub of subs) {
      let list = null;
      try {
        list = await apiJson(BILIGAME + sub + '/api.php?action=query&list=search&srsearch='
          + encodeURIComponent(name) + '&srlimit=5&format=json&origin=*', 6000);
      } catch (e) { lastWikiErr = String((e && e.message) || e); continue; }
      const hits = (list && list.query && list.query.search) || [];
      const hit = hits.find(h => h && h.title === name) || hits[0];
      if (!hit || !hit.title) continue;
      let page = null;
      try {
        page = await apiJson(BILIGAME + sub + '/api.php?action=parse&page='
          + encodeURIComponent(hit.title) + '&prop=wikitext&format=json&origin=*', 7000);
      } catch (e) { lastWikiErr = String((e && e.message) || e); continue; }
      const wt = page && page.parse && page.parse.wikitext && page.parse.wikitext['*'];
      if (!wt) continue;
      const f = infoboxFields(wt);
      const intro = cleanWiki(f['角色详细'] || f['简介'] || f['介绍'] || f['卷首语'] || '');
      return {
        wiki: sub,
        title: hit.title,
        en: cleanWiki(f['外文名'] || f['英文名'] || ''),
        fullName: cleanWiki(f['全名'] || ''),
        title2: cleanWiki(f['称号'] || ''),
        sex: cleanWiki(f['性别'] || ''),
        body: cleanWiki(f['体型'] || ''),
        race: cleanWiki(f['种族'] || ''),
        intro: intro.slice(0, 400),
        url: BILIGAME + sub + '/wiki/' + encodeURIComponent(hit.title)
      };
    }
    return null;
  }

  function aggregateTags(posts) {
    const count = new Map();
    let n = 0;
    (posts || []).forEach(p => {
      if (!p || !p.tag_string_general) return;
      n++;
      String(p.tag_string_general).split(' ').forEach(t => {
        if (!t || META_TAGS.has(t)) return;
        if (t.indexOf('_(cosplay)') >= 0) return;
        count.set(t, (count.get(t) || 0) + 1);
      });
    });
    return { total: n, list: [...count.entries()].sort((a, b) => b[1] - a[1]) };
  }

  async function danbooruSearch(queries) {
    const cands = new Map();
    for (const q of queries.slice(0, 3)) {
      let rows = null;
      try {
        rows = await apiJson(DANBOORU + '/tags.json?search%5Bname_matches%5D=' + encodeURIComponent(q)
          + '*&search%5Bcategory%5D=4&search%5Border%5D=count&limit=12', 6000);
      } catch (e) {
        rows = null;
        lastDbrErr = String((e && e.message) || e);
        /* 403 / Cloudflare / 超时：这一轮就别再拿别名硬撞了，纯粹是白等 */
        if (/403|429|abort|timeout|fetch|network|Failed/i.test(lastDbrErr)) break;
      }
      (rows || []).forEach(r => {
        if (!r || !r.name || cands.has(r.name)) return;
        cands.set(r.name, { tag: r.name, posts: Number(r.post_count) || 0 });
      });
    }
    return cands;
  }

  async function anilistCharacter(name) {
    const query = 'query ($s: String) { Character(search: $s) { name { full native alternative } '
      + 'description(asHtml: false) gender age image { large } siteUrl '
      + 'media(perPage: 2, sort: POPULARITY_DESC) { nodes { title { romaji native } } } } }';
    const d = await postJson(ANILIST, { query: query, variables: { s: name } }, 9000);
    const ch = d && d.data && d.data.Character;
    if (!ch) return null;
    const desc = cleanWiki(String(ch.description || ''));
    const media = (ch.media && ch.media.nodes) || [];
    const from = media.map(m => (m && m.title && (m.title.native || m.title.romaji)) || '').filter(Boolean)[0] || '';
    return {
      name: (ch.name && ch.name.full) || name,
      native: (ch.name && ch.name.native) || '',
      desc: desc,
      gender: ch.gender || '',
      age: ch.age || '',
      image: (ch.image && ch.image.large) || '',
      from: from,
      url: ch.siteUrl || ''
    };
  }

  async function kitsuCharacter(name) {
    const d = await apiJson(KITSU + '?filter%5Bname%5D=' + encodeURIComponent(name) + '&page%5Blimit%5D=2', 8000);
    const first = d && d.data && d.data[0];
    if (!first) return null;
    const at = first.attributes || {};
    return {
      name: at.canonicalName || name,
      desc: cleanWiki(at.description || ''),
      image: (at.image && (at.image.original || at.image.medium)) || ''
    };
  }

  /* ---------------- 视觉模型：看图说话 ----------------

     图片由模型服务端去拉（这里只递 URL），所以不受浏览器 CORS 限制；
     万一服务端拉不动，再把图转成 base64 塞进去试一次。 */
  async function imageToDataUrl(url) {
    if (typeof document === 'undefined') return '';
    try {
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctl ? setTimeout(function () { ctl.abort(); }, 12000) : null;
      const opt = { mode: 'cors' };
      if (ctl) opt.signal = ctl.signal;
      const r = await fetch(url, opt);
      if (timer) clearTimeout(timer);
      if (!r.ok) return '';
      const blob = await r.blob();
      if (!blob || blob.size > 6 * 1024 * 1024) return '';
      return await new Promise(function (ok) {
        const fr = new FileReader();
        fr.onload = function () { ok(String(fr.result || '')); };
        fr.onerror = function () { ok(''); };
        fr.readAsDataURL(blob);
      });
    } catch (e) { return ''; }
  }

  const VISION_SYS = [
    '你是动漫角色外观取证员。用户会给你一张角色图，你要只描述「眼睛能看到的」外观事实。',
    '输出 JSON，字段：',
    '{',
    '  "subject": "画面主体是什么（角色立绘/截图/同人图）",',
    '  "hair": "发色+发型，例如 银色长直发、双马尾",',
    '  "eyes": "瞳色",',
    '  "outfit": ["服装单品的中文描述，2~5 条"],',
    '  "accessories": ["配饰：兽耳/角/机器人部件/武器/帽子/丝带 等"],',
    '  "tags": ["英文 danbooru 风格标签，小写下划线，12~18 个，覆盖 发色 发型 瞳色 发型细节 服装 配饰 体型 表情"],',
    '  "palette": "整体配色一句话",',
    '  "note": "一句话中文概述"',
    '}',
    '规则：tags 只用英文小写下划线；不要写画风词、不要写质量词（masterpiece、best quality 之类）、不要写角色名；看不清的字段留空，不要猜。'
  ].join(NL);

  async function visionDescribe(imageUrl, hintText) {
    if (!imageUrl) return null;
    if (!visionCfg || !visionCfg.key || !visionCfg.base) {
      lastVisErr = '没有配置视觉模型';
      return null;
    }
    const model = visionCfg.model || 'gpt-4o-mini';
    const ask = '看看这张图里角色的外观，按约定输出 JSON。' + (hintText ? NL + '参考信息：' + hintText : '');

    const tryOnce = async (imgValue) => {
      const body = {
        model: model,
        temperature: 0.2,
        max_tokens: 800,
        messages: [
          { role: 'system', content: VISION_SYS },
          { role: 'user', content: [
            { type: 'text', text: ask },
            { type: 'image_url', image_url: { url: imgValue } }
          ] }
        ]
      };
      const d = await postJsonAuth(visionCfg.base + '/chat/completions', body, visionCfg.key, 50000);
      const msg = d && d.choices && d.choices[0] && d.choices[0].message;
      const content = msg ? msg.content : '';
      return pickJson(content);
    };

    let j = null;
    try {
      j = await tryOnce(imageUrl);
    } catch (e) {
      lastVisErr = String((e && e.message) || e);
    }
    if (!j) {
      const local = await imageToDataUrl(imageUrl);
      if (local) {
        try { j = await tryOnce(local); }
        catch (e) { lastVisErr = String((e && e.message) || e); }
      }
    }
    if (!j) return null;
    const arr = (list) => (Array.isArray(list) ? list : [list]).map(x => String(x || '').trim()).filter(Boolean);
    const tags = arr(j.tags).map(t => t.toLowerCase().replace(/\s+/g, '_')).filter(t => /^[a-z0-9_()]+$/.test(t));
    return {
      subject: String(j.subject || ''),
      hair: String(j.hair || ''),
      eyes: String(j.eyes || ''),
      outfit: arr(j.outfit),
      accessories: arr(j.accessories),
      tags: tags,
      palette: String(j.palette || ''),
      note: String(j.note || ''),
      model: model
    };
  }

  /* ---------------- 本地角色库 ----------------
     先看库里有没有，有就一分钱网络都不用花 */
  function charMatch(name, aliases, game) {
    const L = buildLibrary();
    const want = [];
    const push = v => {
      const s = norm(v);
      if (s && s.length > 1 && want.indexOf(s) < 0) want.push(s);
    };
    push(name);
    (Array.isArray(aliases) ? aliases : []).forEach(push);
    if (!want.length) return [];
    const g = norm(game);
    const strip = s => String(s || '').replace(/\([^)]*\)/g, '').trim();
    const scored = [];
    L.chars.forEach(c => {
      const fields = [c.tag, c.name, c.zh, strip(c.tag), strip(c.name)].map(norm).filter(Boolean);
      let sc = 0;
      want.forEach(w => {
        fields.forEach(f => {
          if (!f) return;
          if (f === w) sc = Math.max(sc, 100);
          else if (f.indexOf(w) === 0 || w.indexOf(f) === 0) sc = Math.max(sc, 70);
          else if (f.indexOf(w) >= 0 || w.indexOf(f) >= 0) sc = Math.max(sc, 45);
        });
      });
      if (!sc) return;
      if (g) {
        const cg = norm(c.game);
        if (cg && (cg.indexOf(g) >= 0 || g.indexOf(cg) >= 0)) sc += 30;
        else sc -= 10;
      }
      scored.push({ c: c, score: sc });
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.filter(x => x.score >= 45).slice(0, 3).map(x => x.c);
  }

  /* ---------------- 缓存 ---------------- */
  function cacheGet(key) {
    try {
      const raw = window.localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const map = JSON.parse(raw);
      const it = map[key];
      if (!it) return null;
      if (Date.now() - it.at > 7 * 24 * 3600 * 1000) return null;
      return it;
    } catch (e) { return null; }
  }

  function cachePut(key, value) {
    try {
      const raw = window.localStorage.getItem(CACHE_KEY);
      const map = raw ? JSON.parse(raw) : {};
      map[key] = Object.assign({ at: Date.now() }, value);
      window.localStorage.setItem(CACHE_KEY, JSON.stringify(map));
    } catch (e) { /* 存不了就算了 */ }
  }

  /* ---------------- 主查证流程 ---------------- */
  async function toolLookupCharacter(args) {
    const name = String((args && args.name) || '').trim();
    const game = String((args && args.game) || '').trim();
    const aliases = (Array.isArray(args && args.aliases) ? args.aliases : []).map(String).filter(Boolean);
    if (!name) return '没有给角色名，没法查。';

    const lines = [];
    let charTag = '';
    let autoTags = [];

    /* 0) 本地角色库：命中就是最权威的（这是用户自己维护的库） */
    const locals = charMatch(name, aliases, game);
    if (locals.length) {
      const c = locals[0];
      charTag = c.tag;
      autoTags = c.auto.slice();
      lines.push('【本地角色库 · 命中】' + c.name + '（' + c.tag + '，' + c.game + '）'
        + (c.zh && c.zh !== c.name ? ' 中文名：' + c.zh : ''));
      lines.push('外观标签（库里已整理好，直接用）：' + autoTags.join('、'));
      lines.push('用法：角色标签 「' + c.tag + '」 原样写进 positive，再从这里挑需要的项，不需要联网补。');
      lookupSources.push({ type: 'local', tag: c.name, posts: 0, total: autoTags.length, url: '' });
      const text0 = lines.join(NL);
      cachePut((slugifyName(name) || name) + '|' + slugifyName(game), { text: text0 });
      return text0;
    }

    const ck = (slugifyName(name) || name) + '|' + (slugifyName(game) || '');
    const cached = cacheGet(ck);
    if (cached && cached.text) return cached.text + NL + '（7 天内查过的缓存；换个别名可以强制重查）';

    /* 并行去拿「图 + 简介」：百度百科（中文名最准）和 AniList（英文名最准） */
    const hasCn = hasCJK(name);
    let baike = null;
    let ani = null;
    const jobs = [];
    if (hasCn) {
      jobs.push(baikeLookup(name).then(v => { baike = v; }).catch(() => { baike = null; }));
    } else {
      const cnGuess = aliases.find(a => hasCJK(a));
      jobs.push(baikeLookup(cnGuess || name).then(v => { baike = v; }).catch(() => { baike = null; }));
    }
    const latin = hasCn ? (aliases.find(a => !hasCJK(a)) || '') : name;
    if (latin) {
      jobs.push(anilistCharacter(latin).then(v => { ani = v; }).catch(() => { ani = null; }));
    }
    await Promise.all(jobs.map(p => p.catch(() => null)));

    /* 1) 百度百科 */
    if (baike) {
      lines.push('【百度百科 · ' + baike.title + '】' + (baike.desc ? baike.desc : ''));
      if (baike.abstract) lines.push('简介：' + baike.abstract);
      const keep = ['中文名', '外文名', '别名', '配音', '性别', '生日', '身高', '体重', '种族', '所属作品', '职业', '出身', '画师', '登场作品'];
      const cardBits = [];
      keep.forEach(k => { if (baike.card[k]) cardBits.push(k + '：' + baike.card[k]); });
      if (cardBits.length) lines.push('信息框：' + cardBits.join('；'));
      if (baike.image) lines.push('角色图：' + baike.image);
      lookupSources.push({ type: 'baike', tag: baike.title, posts: 0, total: 0, url: baike.url });
    }

    /* 2) AniList */
    if (ani && (ani.desc || ani.image)) {
      lines.push('【AniList · ' + ani.name + (ani.native ? '（' + ani.native + '）' : '') + '】'
        + (ani.from ? '作品：' + ani.from : ''));
      if (ani.gender) lines.push('性别：' + ani.gender + (ani.age ? '；年龄：' + ani.age : ''));
      if (ani.desc) lines.push('简介：' + ani.desc.slice(0, 800));
      if (ani.image) lines.push('角色图：' + ani.image);
      lookupSources.push({ type: 'anilist', tag: ani.name, posts: 0, total: 0, url: ani.url });
    }

    /* 3) biligame 维基：默认不查。
       用户的诉求很明确——这站经常连不上，白等一轮超时还什么都拿不到；
       真要用就把 window.__PG_USE_BILIGAME__ 设成 true（或在设置里开）。 */
    const useWiki = typeof window !== 'undefined' && !!window.__PG_USE_BILIGAME__;
    if (useWiki && hasCn) {
      let wiki = null;
      try { wiki = await wikiLookup(name, game); } catch (e) { wiki = null; }
      if (wiki) {
        const bits = [wiki.title, wiki.en ? '（' + wiki.en + '）' : '', wiki.title2 ? ' · ' + wiki.title2 : ''].join('');
        const tags2 = [wiki.sex, wiki.body, wiki.race].filter(Boolean).join(' / ');
        lines.push('【biligame 维基 · ' + bits + '】' + (tags2 ? '（' + tags2 + '）' : ''));
        if (wiki.fullName && wiki.fullName !== wiki.title) lines.push('全名：' + wiki.fullName);
        if (wiki.intro) lines.push('设定：' + wiki.intro);
        lookupSources.push({ type: 'biligame', tag: wiki.title, posts: 0, total: 0, url: wiki.url });
      }
    }

    /* 4) Danbooru（图站，连不上就跳过，不报错） */
    const queries = [];
    [chartagFromHint(name, game), name].concat(aliases).forEach(v => {
      const q = slugifyName(v);
      if (q && q.length > 1 && queries.indexOf(q) < 0) queries.push(q);
      const q2 = slugifyName(String(v).replace(/[()]/g, ''));
      if (q2 && q2.length > 1 && queries.indexOf(q2) < 0) queries.push(q2);
    });
    let dbrTags = [];
    const hint = GAME_HINTS.find(g => g.re.test(game) || g.re.test(name)) || null;
    if (queries.length) {
      let cands = new Map();
      try { cands = await danbooruSearch(queries); } catch (e) { cands = new Map(); }
      const scored = [...cands.values()].map(c => {
        let sc = Math.min(c.posts, 3000);
        if (hint && c.tag.indexOf(hint.copy) >= 0) sc += 5000;
        if (queries.some(q => c.tag.indexOf(q) === 0)) sc += 200;
        return Object.assign({ score: sc }, c);
      }).sort((a, b) => b.score - a.score);
      if (scored.length) {
        const best = scored[0];
        if (!charTag) charTag = prettyTag(best.tag);
        let posts = null;
        try {
          posts = await apiJson(DANBOORU + '/posts.json?tags=' + encodeURIComponent(best.tag)
            + '&limit=40&only=tag_string_general', 8000);
        } catch (e) { posts = null; }
        const agg = aggregateTags(posts);
        lines.push('【Danbooru · ' + prettyTag(best.tag) + '】站内 ' + best.posts + ' 张图');
        lookupSources.push({ type: 'danbooru', tag: prettyTag(best.tag), posts: best.posts, total: agg.total });
        if (agg.list.length) {
          dbrTags = agg.list.slice(0, 36);
          lines.push('图站标签统计（出现次数 / ' + agg.total + ' 张图）：'
            + dbrTags.map(it => {
              const spaced = prettyTag(it[0]);
              const r = resolveTag(spaced);
              return spaced + (r && r.zh ? '(' + r.zh + ')' : '') + ' ×' + it[1];
            }).join('、'));
        }
      }
    }

    /* 5) 视觉模型看图：这是「直接识别图片再给提示词」那一步 */
    const img = (baike && baike.image) || (ani && ani.image) || '';
    let vis = null;
    if (img) {
      const hintText = [baike && baike.key, baike && baike.desc, ani && ani.name, game].filter(Boolean).join(' / ');
      try { vis = await visionDescribe(img, hintText); } catch (e) { vis = null; }
      if (vis) {
        lines.push('【视觉模型识图 · ' + vis.model + '】看的是上面那张角色图');
        if (vis.subject) lines.push('画面：' + vis.subject);
        const look = [vis.hair ? '发色/发型：' + vis.hair : '', vis.eyes ? '瞳色：' + vis.eyes : '',
          vis.outfit.length ? '服装：' + vis.outfit.join('、') : '',
          vis.accessories.length ? '配饰：' + vis.accessories.join('、') : '',
          vis.palette ? '配色：' + vis.palette : ''].filter(Boolean);
        if (look.length) lines.push(look.join('；'));
        if (vis.tags.length) lines.push('识图得到的英文外观标签：' + vis.tags.join('、'));
        lookupSources.push({ type: 'vision', tag: vis.model, posts: 0, total: vis.tags.length, url: img });
      } else if (lastVisErr) {
        lines.push('【视觉模型没看成】' + lastVisErr + '（这不影响下面按理解补）');
      }
    }

    /* 6) 汇总：怎么用 */
    if (lines.length) {
      lines.push('——');
      if (charTag) lines.push('角色标签写法：' + charTag);
      const pool = [];
      (vis && vis.tags ? vis.tags : []).forEach(t => pool.push(t));
      dbrTags.forEach(it => pool.push(prettyTag(it[0])));
      autoTags.forEach(t => pool.push(t));
      const uniq = [];
      pool.forEach(t => {
        const k = norm(t);
        if (k && uniq.indexOf(k) < 0) uniq.push(k);
      });
      if (uniq.length) {
        lines.push('可用的外观标签池（挑 6~14 个，顺序 发色→发型→瞳色→服装→配饰；'
          + '库里没有同义写法就直接用英文原词）：' + uniq.slice(0, 40).join('、'));
      }
      lines.push('用法：用 search_tags 把上面这些中/英描述换成标签库里的规范写法能换成多少算多少；'
        + '剩下换不出来的，只要是上面资料里明确写到的（简介、信息框、识图结果），就直接用英文写进 positive。');
      if (!uniq.length) {
        lines.push('注意：这次没拿到外观细节，但**允许你按对这个角色的理解补**：发色、发型、瞳色、服装都可以给，'
          + '推断出来的项在 reply 里用「（推断）」标一下就行，不要因为查不到就空着。');
      }
    } else {
      const why = [];
      if (lastBaikeErr) why.push('百度百科 ' + lastBaikeErr);
      if (useWiki && lastWikiErr) why.push('biligame ' + lastWikiErr);
      if (lastDbrErr) why.push('Danbooru ' + lastDbrErr);
      lines.push('【几个百科这次都没给出资料】' + (why.length ? '（' + why.join('；') + '）' : ''));
      lines.push('没关系，**按你自己的理解把这个角色写出来**：角色标签用你能确定的最通用写法（例如 '
        + (name ? slugifyName(name) || name : '角色名') + '），外观（发色/发型/瞳色/服装/配饰）按你的理解补 6~10 个，'
        + '再用 search_tags 找库里对应的标签；reply 里用「（推断）」说明这些是推断的。');
      if (vis && vis.tags) lines.push('识图标签：' + vis.tags.join('、'));
    }

    const text = lines.join(NL);
    cachePut(ck, { text: text });
    return text;
  }

  /* Danbooru 角色标签的常见后缀：先按「名字 (作品)」猜一次 */
  function chartagFromHint(name, game) {
    const hint = GAME_HINTS.find(g => g.re.test(game) || g.re.test(name)) || null;
    const base = slugifyName(name);
    if (!base) return '';
    return hint ? base + ' (' + hint.copy.replace(/_/g, ' ').replace(/:/g, '') + ')' : '';
  }

  /* 收集本轮查证过的来源（服务端要把它带回前端显示） */
  function takeSources() {
    const out = lookupSources.slice();
    lookupSources.length = 0;
    return out;
  }

  function unwrapTag(raw) {
    let s = String(raw || '').trim();
    s = s.replace(/\\([()\[\]{}])/g, '$1');
    for (let i = 0; i < 3; i++) {
      if (!/^[([{][\s\S]*[)\]}]$/.test(s)) break;
      let depth = 0;
      let ok = true;
      for (const ch of s) {
        if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) depth--;
        if (depth < 0) { ok = false; break; }
      }
      if (!ok || depth !== 0) break;
      s = s.slice(1, -1).replace(/:\s*[\d.]+$/, '').trim();
    }
    return s;
  }

  function resolveTag(raw) {
    const L = buildLibrary();
    const s = unwrapTag(raw);
    if (!s) return null;
    const k = norm(s);

    if (L.byKey.has(k)) { const t = L.byKey.get(k); return { en: t.en, zh: t.zh }; }
    if (L.charByKey.has(k)) { const c = L.charByKey.get(k); return { en: c.tag, zh: c.zh }; }

    const alt = k.replace(/[_\s]+/g, ' ').replace(/:\s*[\d.]+$/, '').trim();
    if (L.byKey.has(alt)) { const t = L.byKey.get(alt); return { en: t.en, zh: t.zh }; }
    const noS = alt.replace(/(\w)s$/, '$1');
    if (L.byKey.has(noS)) { const t = L.byKey.get(noS); return { en: t.en, zh: t.zh }; }

    for (const c of L.chars) {
      const ck = norm(c.tag);
      const flat = ck.replace(/\s+/g, '');
      const kf = k.replace(/\s+/g, '');
      if (ck === k || ck.startsWith(k + ' (') || (kf.length > 3 && flat.startsWith(kf + '('))) {
        return { en: c.tag, zh: c.zh };
      }
    }
    for (const t of L.tags) {
      if (t.key === k) return { en: t.en, zh: t.zh };
      if (t.key.startsWith(k + ' ') || t.key.startsWith(k + ' (')) return { en: t.en, zh: t.zh };
    }
    return { en: s, zh: '' };
  }

  function dedupeTags(arr) {
    const out = [];
    const seen = new Set();
    (arr || []).forEach(raw => {
      const r = resolveTag(raw);
      if (!r || !r.en) return;
      const k = norm(r.en);
      if (seen.has(k)) return;
      seen.add(k);
      out.push(r);
    });
    return out;
  }

  function toolFinish(args) {
    const texts = [];
    const seen = new Set();
    (args.text_prompts || []).forEach(x => {
      const en = String((x && x.en) || '').replace(/[,\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (!en) return;
      const k = en.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      texts.push({ en, zh: String((x && x.zh) || '').trim() });
    });
    return {
      reply: String((args && args.reply) || '已经按你的描述选好了标签。'),
      note: args.note ? String(args.note) : '',
      positive: dedupeTags(args.positive),
      negative: dedupeTags(args.negative),
      texts: texts.slice(0, 14)
    };
  }

  /* ---------------- 4. 工具声明 ---------------- */

  const TOOLS = [
    {
      type: 'function',
      function: {
        name: 'search_tags',
        description: '在本地动漫提示词标签库中检索。返回「英文标签 ｜ 中文 ｜ 分类」列表。可以多次调用。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '检索关键词，中文或英文均可，例如「银发」「night street」「和服」' },
            category: { type: 'string', description: '可选，限定分类 id（style/artist/base/body/hair/face/expression/clothing/accessory/pose/props/environment/weather/lighting/camera/composition/text/negative）' },
            limit: { type: 'integer', description: '返回条数，默认 30，最大 60' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'lookup_character',
        description: '查一个角色的资料与外观，链条是「本地角色库 → 百度百科（官方立绘 + 简介 + 信息框）→ AniList → Danbooru 图站 → 视觉模型直接看拿到的角色图」，连不上的自动跳过（biligame 默认不查），最后总会给你可用的外观标签或「按理解补」的许可。用于本地角色库里没有的角色。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '角色名，中文或英文都行，例如 风堇、hyacine、流萤' },
            aliases: { type: 'array', items: { type: 'string' }, description: '备选拼写或别名，最多 3 个，例如 fengjin / feng jin' },
            game: { type: 'string', description: '所属作品，中文或英文都行，例如 崩坏：星穹铁道 / honkai: star rail' }
          },
          required: ['name']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'finish',
        description: '提交最终的提示词选择。调用后本次对话结束。',
        parameters: {
          type: 'object',
          properties: {
            positive: { type: 'array', items: { type: 'string' }, description: '正向标签，英文原样，按语义顺序' },
            negative: { type: 'array', items: { type: 'string' }, description: '负面标签，可留空' },
            text_prompts: {
              type: 'array',
              description: '标签库表达不了的细节，补成自然英文短句；没有可省略',
              items: {
                type: 'object',
                properties: {
                  en: { type: 'string', description: '自然英文短句，内部不要用逗号和括号' },
                  zh: { type: 'string', description: '该短句的中文翻译' }
                },
                required: ['en', 'zh']
              }
            },
            reply: { type: 'string', description: '用中文简短说明选了什么、为什么' },
            note: { type: 'string', description: '可选补充说明' }
          },
          required: ['positive', 'reply']
        }
      }
    }
  ];

  /* 不联网时把查证工具整个拿掉：模型连调用的机会都没有 */
  const TOOLS_FAST = TOOLS.filter(t => t.function.name !== 'lookup_character');

  /* ---------------- 5. 对话循环 ---------------- */

  async function chatWithTools(opts) {
    const o = opts || {};
    const apiKey = String(o.apiKey || '').trim();
    const base = String(o.base || 'https://api.deepseek.com').replace(/\/+$/, '');
    const model = o.model || 'deepseek-chat';
    const online = o.online !== false;
    if (!apiKey) throw new Error('还没填 API Key：点设置里的「API Key」，或者改用本地服务模式。');

    const convo = [{ role: 'system', content: systemPrompt({ online }) }].concat(o.messages || []);
    const toolList = online ? TOOLS : TOOLS_FAST;
    let searches = 0;
    let lookups = 0;
    lookupSources = [];

    const usage = { prompt: 0, completion: 0, total: 0, rounds: 0 };
    const maxRounds = online ? 12 : 5;      // 轮次上限（一次请求 = 一轮）
    const maxCalls = online ? 18 : 8;       // 工具调用总次数上限，防止一轮里塞很多次
    let toolCalls = 0;
    const asked = Object.create(null);      // 记下查过的关键词，重复查时提醒模型别绕圈

    const done = (fin, extra) => Object.assign(fin, {
      searches, lookups, sources: lookupSources.slice(), usage, online
    }, extra || {});

    function trackUsage(data, round) {
      usage.rounds = round + 1;
      if (data && data.usage) {
        const pIn = Number(data.usage.prompt_tokens) || 0;
        const pOut = Number(data.usage.completion_tokens) || 0;
        usage.prompt += pIn;
        usage.completion += pOut;
        usage.total += Number(data.usage.total_tokens) || (pIn + pOut);
      }
    }

    /* 发一次请求。tool_choice 被接口拒绝（某些兼容实现只认 auto/none）时自动退回 auto */
    async function callModel(msgs, choice, rounds) {
      const body = {
        model,
        messages: msgs,
        tools: toolList,
        tool_choice: choice || 'auto',
        temperature: 0.4,
        max_tokens: online ? 2000 : 1400
      };
      const send = async () => fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify(body)
      });
      let resp = await send();
      let raw = await resp.text();
      if (!resp.ok && typeof choice === 'object') {
        /* 不支持强制指定工具：退回 auto，同时靠提示词催它提交 */
        body.tool_choice = 'auto';
        resp = await send();
        raw = await resp.text();
      }
      if (!resp.ok) {
        let msg = raw;
        try { msg = JSON.parse(raw).error.message || raw; } catch (e) { /* 原样 */ }
        throw new Error(`模型接口返回 ${resp.status}：${String(msg).slice(0, 300)}`);
      }
      let data = null;
      try { data = JSON.parse(raw); } catch (e) { throw new Error('模型返回的不是 JSON'); }
      trackUsage(data, rounds);
      return data;
    }

    /* 轮次/次数用完时的最后一搏：只给 finish 一个工具，逼它交稿 */
    async function finalPush() {
      const lastUser = convo.filter(m => m.role === 'user').slice(-2);
      const msgs = [{ role: 'system', content: systemPrompt({ online }) }]
        .concat(lastUser)
        .concat([{
          role: 'user',
          content: '不要再检索了，现在就用已有的了解直接调用 finish：把最合适的标签放进 positive（10~22 个），reply 说明你选了什么。'
        }]);
      const onlyFinish = toolList.filter(t => t.function.name === 'finish');
      try {
        const resp = await fetch(base + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
          body: JSON.stringify({
            model,
            messages: msgs,
            tools: onlyFinish,
            tool_choice: { type: 'function', function: { name: 'finish' } },
            temperature: 0.3,
            max_tokens: online ? 2000 : 1400
          })
        });
        const raw = await resp.text();
        if (!resp.ok) return null;
        const data = JSON.parse(raw);
        trackUsage(data, maxRounds);
        const msg = data.choices && data.choices[0] && data.choices[0].message;
        const calls = (msg && msg.tool_calls) || [];
        for (const call of calls) {
          if (call.function && call.function.name === 'finish') {
            let args = {};
            try { args = JSON.parse(call.function.arguments || '{}'); } catch (e) { args = {}; }
            const fin = toolFinish(args);
            if (fin.positive.length || fin.texts.length) return done(fin, { note: '（检索轮次用完了，按已有信息直接提交）' });
          }
        }
        return null;
      } catch (e) {
        return null;
      }
    }

    for (let round = 0; round < maxRounds; round++) {
      const left = maxRounds - round;
      /* 快用完了就明说，别让模型自己猜还剩几轮 */
      if (left === 2 && !asked.__nudged) {
        asked.__nudged = true;
        convo.push({
          role: 'user',
          content: '（系统提醒）检索轮次快用完了。现在请立刻调用 finish 提交你目前最好的选择，不要再查新关键词。'
        });
      }
      const forceFinish = left === 1;

      const data = await callModel(convo, forceFinish ? { type: 'function', function: { name: 'finish' } } : 'auto', round);
      const msg = data.choices && data.choices[0] && data.choices[0].message;
      if (!msg) throw new Error('模型返回为空');

      const calls = msg.tool_calls || [];
      if (!calls.length) {
        const text = String(msg.content || '').trim();
        return done({
          reply: text || '（模型没有返回内容）',
          positive: [], negative: [], texts: [],
          note: '模型这次没有调用选词工具，可以再描述得具体一些。'
        });
      }

      convo.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });

      for (const call of calls) {
        const name = call.function && call.function.name;
        let args = {};
        try { args = JSON.parse((call.function && call.function.arguments) || '{}'); } catch (e) { args = {}; }

        if (name === 'finish') {
          const fin = toolFinish(args);
          /* 空提交时催它补一次；但如果它是在如实说「没查到」，就别逼它，否则等于鼓励编造 */
          const honest = /没查到|查不到|没找到|无法确认|不确定|没有可靠/.test(fin.reply || '');
          if (!fin.positive.length && !fin.texts.length && !honest && round < maxRounds - 1) {
            convo.push({
              role: 'tool', tool_call_id: call.id,
              content: '你提交的 positive 是空的。请至少给出 10 个标签，再调用一次 finish。'
            });
            continue;
          }
          return done(fin);
        }

        toolCalls++;
        let result;
        if (name === 'search_tags') {
          const q = norm(args.query);
          const key = q + '|' + (args.category || '');
          searches++;
          result = toolSearchTags(args);
          if (asked[key]) {
            result = '（提示：这个关键词刚刚已经查过了，结果和上次一样，不要再重复检索；请直接挑标签然后 finish）\n' + result;
          } else {
            asked[key] = true;
          }
        } else if (name === 'lookup_character') {
          lookups++;
          try {
            result = await toolLookupCharacter(args);
          } catch (e) {
            result = '查证失败（网络问题）：' + String((e && e.message) || e) + '。请如实告诉用户没查到，不要编造。';
          }
        } else if (name === 'finish') {
          result = '同上';
        } else {
          result = '未知工具：' + name + '。只能用 search_tags / lookup_character / finish。';
        }
        convo.push({ role: 'tool', tool_call_id: call.id, content: result });

        /* 工具调用次数超了：这一轮跑完就不再给新机会，直接走最后提交 */
        if (toolCalls >= maxCalls) break;
      }
      if (toolCalls >= maxCalls && round < maxRounds - 1) {
        const fin = await finalPush();
        if (fin) return fin;
        break;
      }
    }

    /* 走到这里说明模型一直在检索、始终不交稿：兜底交一份，别把用户卡死在报错上 */
    const pushed = await finalPush();
    if (pushed) return pushed;

    return done({
      reply: '这次检索次数有点多，我先把能确定的部分给你；如果不够贴切，把要求再说细一点（人物、场景、动作、光线），我重新挑一遍。',
      positive: [], negative: [], texts: [],
      note: '工具调用到达上限，已停止（模型反复检索但没有提交选词，建议把描述写得更具体）。'
    });
  }

  function resetLibrary() { LIB = null; return buildLibrary(); }
  const API = {
    chatWithTools, buildLibrary, resetLibrary, resolveTag, toolSearchTags, toolFinish, systemPrompt, unwrapTag,
    toolLookupCharacter, takeSources, slugifyName, aggregateTags,
    setVision, baikeLookup, visionDescribe, charMatch, anilistCharacter
  };
  window.PG_AI = API;
  /* 测试与某些沙箱里 window 不是全局对象，再挂一份到 globalThis */
  try { if (typeof globalThis !== 'undefined' && globalThis !== window) globalThis.PG_AI = API; } catch (e) { /* ignore */ }
})();
