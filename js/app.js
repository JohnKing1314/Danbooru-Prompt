
/* ===== js/app.js ===== */
/* Prompt Forge — 动漫提示词生成器 */
(function () {
  'use strict';
  try { document.title = 'Danbooru Prompt V1.0'; } catch (e) {}
  var state;

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const KAOMOJI_EXACT_SET = new Set(['_@', '+_+', '<o>_<o>', '>_<', '^_^', '>_@', '+_-', ';d', ':3', ':d', ':p', ':o', 'xd', '^^^', '>:)', '>:(', ':>=', '<3']);
  function isAnimaEmoteOrScore(s) {
    const low = String(s || '').trim().toLowerCase();
    if (KAOMOJI_EXACT_SET.has(low)) return true;
    if (/^[+_<>^@:;()=\-03dp]+$/.test(low) && !/^[a-z0-9]+$/.test(low)) return true;
    return false;
  }
  function formatAnimaTagEn(rawEn) {
    const s = String(rawEn || '').trim();
    if (!s) return '';
    const hasAt = s.startsWith('@');
    const body = hasAt ? s.replace(/^@+/, '').trim() : s;
    const low = body.toLowerCase();
    if (isAnimaEmoteOrScore(low)) return hasAt ? ('@' + low) : low;
    const mScore = low.match(/^score[_\s]+(\d+)(?:[_\s]+(up))?$/);
    if (mScore) {
      return 'score_' + mScore[1] + (mScore[2] ? '_up' : '');
    }
    const clean = low.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    return hasAt ? ('@' + clean) : clean;
  }
  const _normCache = new Map();
  const norm = s => {
    const str = String(s || '');
    const hit = _normCache.get(str);
    if (hit !== undefined) return hit;
    const raw = str.trim().toLowerCase();
    let res;
    if (!raw) res = '';
    else if (isAnimaEmoteOrScore(raw)) res = raw;
    else {
      const mScore = raw.match(/^score[_\s]+(\d+)(?:[_\s]+(up))?$/);
      if (mScore) res = 'score_' + mScore[1] + (mScore[2] ? '_up' : '');
      else res = raw.replace(/_/g, ' ').replace(/\s+/g, ' ');
    }
    if (_normCache.size > 40000) _normCache.clear();
    _normCache.set(str, res);
    return res;
  };
  const normDedupKey = s => norm(cleanArtistEn(s)).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const esc = s => (s == null ? '' : String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const RATING_META = {
    g: { code: 'g', name: 'General (全年龄)', short: '全年龄', icon: '🔵', cls: 'rating-g' },
    s: { code: 's', name: 'Sensitive (敏感/擦边)', short: '敏感', icon: '🟡', cls: 'rating-s' },
    q: { code: 'q', name: 'Questionable (存疑/软色情)', short: '存疑', icon: '🟠', cls: 'rating-q' },
    e: { code: 'e', name: 'Explicit (限制级/成人)', short: '成人', icon: '🔴', cls: 'rating-e' }
  };
  /* ---------- 翻译记忆（英文 → 中文，本机持久保存） ----------
     存的是词库没覆盖、靠联网翻出来或人工改过的释义。
     优先级：手动 > 自动 > 内置词库，改过的译文不会被再次翻译盖掉。 */
  const TR_KEY = 'pg_tr_mem_v1';
  const TRMEM = new Map();   // norm(en) -> { zh, manual }
  (function loadTrMem() {
    try {
      const d = JSON.parse(localStorage.getItem(TR_KEY) || '{}');
      Object.keys(d || {}).forEach(k => {
        const v = d[k];
        if (!v) return;
        const zh = typeof v === 'string' ? v : (v.zh || '');
        if (!zh) return;
        TRMEM.set(k, { zh: String(zh), manual: !!(v && v.manual) });
      });
    } catch (e) { /* ignore */ }
  })();
  let trSaveTimer = null;
  function trSaveMem() {
    clearTimeout(trSaveTimer);
    trSaveTimer = setTimeout(() => {
      const o = {};
      TRMEM.forEach((v, k) => { o[k] = { zh: v.zh, manual: !!v.manual }; });
      try { localStorage.setItem(TR_KEY, JSON.stringify(o)); } catch (e) { /* ignore */ }
    }, 260);
  }
  function trGet(en) {
    const k = norm(en);
    if (!k) return '';
    const v = TRMEM.get(k);
    return v ? v.zh : '';
  }
  function trSet(en, zh, manual) {
    const k = norm(en);
    zh = String(zh || '').trim();
    if (!k) return false;
    if (!zh) { TRMEM.delete(k); trSaveMem(); return true; }
    const old = TRMEM.get(k);
    if (old && old.manual && !manual) return false;
    TRMEM.set(k, { zh: zh, manual: !!manual || !!(old && old.manual) });
    trSaveMem();
    return true;
  }
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  let _confirmCb = null;
  function askConfirmModal(msg, onOk, title) {
    const m = document.getElementById('modalConfirm');
    if (!m) { if (onOk) onOk(); return; }
    const tEl = document.getElementById('confirmModalTitle');
    const msgEl = document.getElementById('confirmModalMsg');
    if (tEl) tEl.textContent = title || '⚠️ 确认删除';
    if (msgEl) msgEl.textContent = msg || '确定要执行此操作吗？';
    _confirmCb = onOk || null;
    m.hidden = false;
  }

  const LS_KEY = 'pg_forge_v120';

  /* =====================================================================
     1. 数据层
     ===================================================================== */

  function parsePair(s) {
    const i = s.indexOf('|');
    if (i < 0) return { en: s.trim(), zh: '' };
    return { en: s.slice(0, i).trim(), zh: s.slice(i + 1).trim() };
  }

  const CATS = [];
  const MAJORS = [];
  const SEEN = new Set();
  const TAG_OBJ_LOOKUP = new Map();
  const TAG_SUB_OBJ_LOOKUP = new Map();

  function getLayoutOrder() {
    const fs = window.PG_TAG_FS;
    if (fs && fs.layoutOrder) return fs.layoutOrder;
    return { majorOrder: [], subOrderByMajor: {}, allSubOrder: [] };
  }

  function sortByIdArray(list, idArr) {
    if (!Array.isArray(idArr) || !idArr.length) return list;
    const posMap = new Map();
    idArr.forEach((id, idx) => posMap.set(id, idx));
    return list.slice().sort((a, b) => {
      const pa = posMap.has(a.id) ? posMap.get(a.id) : 9999;
      const pb = posMap.has(b.id) ? posMap.get(b.id) : 9999;
      return pa - pb;
    });
  }

  function rebuildCatsFromTree() {
    CATS.length = 0;
    MAJORS.length = 0;
    SEEN.clear();
    TAG_OBJ_LOOKUP.clear();
    TAG_SUB_OBJ_LOOKUP.clear();
    const tree = (window.PG_TAG_FS && window.PG_TAG_FS.majors) || [];
    const layout = getLayoutOrder();
    const orderedTree = sortByIdArray(tree, layout.majorOrder);

    orderedTree.forEach((m, mIdx) => {
      const majorNode = {
        id: m.id,
        name: m.name,
        icon: m.icon || '📁',
        order: mIdx + 1,
        file: m.file || (m.id + '/' + m.id + '.json'),
        subDir: m.subDir || m.id,
        children: []
      };
      const subOrderIds = (layout.subOrderByMajor && layout.subOrderByMajor[m.id]) || [];
      const orderedSubs = sortByIdArray(m.children || [], subOrderIds);
      orderedSubs.forEach((sub, sIdx) => {
        const tags = [];
        const subSeen = new Set();
        const isNsfwMajor = (m.id === 'nsfw_group' || /nsfw|成人/i.test(m.name || ''));
        (sub.tags || []).forEach(rawTag => {
          const p = typeof rawTag === 'string' ? parsePair(rawTag) : { en: String(rawTag.en || '').trim(), zh: String(rawTag.zh || '').trim() };
          if (!p.en) return;
          const k = norm(p.en);
          if (subSeen.has(k)) return;
          subSeen.add(k);
          SEEN.add(k);
          const tItem = { en: formatAnimaTagEn(p.en), zh: p.zh };
          if (rawTag && typeof rawTag === 'object') {
            if (rawTag.desc) tItem.desc = String(rawTag.desc).trim();
            if (rawTag.kw) tItem.kw = String(rawTag.kw).trim();
            if (rawTag.count) tItem.count = Number(rawTag.count) || 0;
            if (Array.isArray(rawTag.topTags) && rawTag.topTags.length) tItem.topTags = rawTag.topTags;
          }
          const ovRate = (typeof state !== 'undefined' && state && state.ratingOverrides && state.ratingOverrides[k]) ? state.ratingOverrides[k] : '';
          if (ovRate && RATING_META[ovRate]) {
            tItem.rating = ovRate;
          } else if (rawTag && typeof rawTag === 'object' && rawTag.rating && RATING_META[rawTag.rating]) {
            tItem.rating = rawTag.rating;
          } else {
            tItem.rating = 'g';
          }
          tItem.nsfw = (tItem.rating === 'q' || tItem.rating === 'e');
          const seenNewSet = (typeof state !== 'undefined' && state && state.seenNewTagsSet instanceof Set) ? state.seenNewTagsSet : null;
          if (rawTag && typeof rawTag === 'object' && rawTag.isNew && !(seenNewSet && seenNewSet.has(k))) {
            tItem.isNew = true;
          }
          tags.push(tItem);
          const refObj = { tag: (rawTag && typeof rawTag === 'object') ? rawTag : tItem, sub, major: m, catItem: tItem };
          if (!TAG_OBJ_LOOKUP.has(k)) TAG_OBJ_LOOKUP.set(k, refObj);
          TAG_SUB_OBJ_LOOKUP.set(sub.id + '::' + k, refObj);
        });
        const catObj = {
          id: sub.id,
          name: sub.name,
          icon: sub.icon || '•',
          parentId: m.id,
          parentName: m.name,
          parentIcon: m.icon || '📁',
          order: sIdx + 1,
          file: sub.file || (m.id + '/' + m.id + '_' + sub.id + '.json'),
          tags
        };
        CATS.push(catObj);
        majorNode.children.push(catObj);
      });
      MAJORS.push(majorNode);
    });

    if (Array.isArray(layout.allSubOrder) && layout.allSubOrder.length) {
      const sortedAll = sortByIdArray(CATS, layout.allSubOrder);
      CATS.length = 0;
      sortedAll.forEach(c => CATS.push(c));
    }
  }
  rebuildCatsFromTree();

  const CHARS = [];
  const PRESETS = [];

  function rebuildCharsAndPresetsFromWindow() {
    CHARS.length = 0;
    (window.PG_CHARACTERS || []).forEach((c, i) => {
      if (!c || !c.tag) return;
      const gm = c.game || '';
      let majorId = c.majorId || '';
      if (!majorId) {
        if (gm === 'hololive') majorId = 'vtuber';
        else if (['明日方舟','原神','崩坏：星穹铁道','鸣潮','蔚蓝档案','王者荣耀','BanG Dream!','Love Live!','偶像大师','东方Project','Fate','碧蓝航线','赛马娘','崩坏3','妮姬','绝区零','少女前线','VOCALOID','Girls Band Cry','公主连结','战双帕弥什','其他游戏'].indexOf(gm) >= 0) majorId = 'games';
        else majorId = 'anime';
      }
      CHARS.push({
        key: 'c' + i,
        majorId: majorId,
        subId: c.subId || '',
        subName: c.subName || gm,
        game: gm,
        gameTag: c.gameTag || (c.subId ? String(c.subId).replace(/_/g, ' ') : gm),
        name: c.name || '',
        tag: c.tag || '',
        charZh: c.charZh || c.name || '',
        isNew: !!c.isNew,
        auto: String(c.auto || '').split(';').map(s => s.trim()).filter(Boolean).map(parsePair)
      });
    });
    const extPresetsSource = (Array.isArray(window.__EXT_PRESETS__) && window.__EXT_PRESETS__.length)
      ? window.__EXT_PRESETS__
      : (Array.isArray(window.PG_PRESETS) ? window.PG_PRESETS : []);
    if (!PRESETS.length && extPresetsSource.length) {
      extPresetsSource.forEach((p, i) => {
        const rawTags = Array.isArray(p.tags)
          ? p.tags.map(t => (typeof t === 'string' ? parsePair(t) : { en: t.en || '', zh: t.zh || '' })).filter(t => t.en)
          : String(p.tags || '').split(/[;\r\n]+/).map(s => s.trim()).filter(Boolean).map(parsePair);
        PRESETS.push({
          key: p.key || p.id || ('p' + i),
          name: p.name || '预设',
          desc: p.desc || '',
          cat: p.cat || (window.PG_PRESET_CAT_MAP || {})[p.name] || '场景',
          tags: rawTags,
          custom: !!p.custom
        });
      });
    }
  }
  rebuildCharsAndPresetsFromWindow();

  /* ---------- 用户自定义：预设与角色（存在 localStorage） ---------- */

  const CUSTOM_KEY = 'pg_custom_v1';

  function readCustom() {
    const empty = { presets: [], presetEdit: {}, presetDel: [], chars: [], charEdit: {}, charDel: [] };
    try {
      const d = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '{}');
      return {
        presets: Array.isArray(d.presets) ? d.presets : [],
        presetEdit: d.presetEdit && typeof d.presetEdit === 'object' ? d.presetEdit : {},
        presetDel: Array.isArray(d.presetDel) ? d.presetDel : [],
        chars: Array.isArray(d.chars) ? d.chars : [],
        charEdit: d.charEdit && typeof d.charEdit === 'object' ? d.charEdit : {},
        charDel: Array.isArray(d.charDel) ? d.charDel : []
      };
    } catch (e) { return empty; }
  }

  const CUSTOM = readCustom();

  function saveCustom() {
    try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(CUSTOM)); } catch (e) { /* 存储满时忽略 */ }
  }

  /* 一批标签 -> 多行文本（编辑框用） */
  function tagText(list) {
    return list.map(t => (t.zh ? t.en + '|' + t.zh : t.en)).join(String.fromCharCode(10));
  }

  /* 多行文本 -> 标签数组；逗号也当分隔符，省得用户手误 */
  function parseTagText(text) {
    const out = [];
    String(text || '').split(/[\r\n;]+/).forEach(line => {
      line = line.trim();
      if (!line) return;
      out.push(parsePair(line));
    });
    return out.filter(t => t.en);
  }

  function applyCustom() {
    CUSTOM.presetDel.forEach(k => {
      const i = PRESETS.findIndex(x => x.key === k);
      if (i >= 0) PRESETS.splice(i, 1);
    });
    Object.keys(CUSTOM.presetEdit).forEach(k => {
      const item = PRESETS.find(x => x.key === k);
      if (!item) return;
      const e = CUSTOM.presetEdit[k] || {};
      if (e.name) item.name = e.name;
      if (typeof e.desc === 'string') item.desc = e.desc;
      if (e.tags) item.tags = parseTagText(e.tags);
      if (e.cat) item.cat = e.cat;
      item.custom = true;
    });
    CUSTOM.presets.forEach(u => {
      if (!u || !u.key || !u.name) return;
      PRESETS.push({
        key: u.key, name: u.name, desc: u.desc || '',
        tags: parseTagText(u.tags || ''), custom: true, cat: u.cat || '其他'
      });
    });

    CUSTOM.charDel.forEach(k => {
      const i = CHARS.findIndex(x => x.key === k);
      if (i >= 0) CHARS.splice(i, 1);
    });
    Object.keys(CUSTOM.charEdit).forEach(k => {
      const c = CHARS.find(x => x.key === k);
      if (!c) return;
      const e = CUSTOM.charEdit[k] || {};
      if (e.name) c.name = e.name;
      if (e.tag) c.tag = e.tag;
      if (typeof e.game === 'string' && e.game) c.game = e.game;
      if (e.charZh) c.charZh = e.charZh;
      if (e.auto) c.auto = parseTagText(e.auto);
      c.custom = true;
    });
    CUSTOM.chars.forEach(u => {
      if (!u || !u.key || !u.tag) return;
      CHARS.push({
        key: u.key, game: u.game || '自定义', name: u.name || u.tag, tag: u.tag,
        charZh: u.charZh || u.name || u.tag, auto: parseTagText(u.auto || ''), custom: true
      });
    });
  }

  applyCustom();

  let GAMES = [...new Set(CHARS.map(c => c.game))].filter(Boolean);

  function refreshGamesFromChars() {
    GAMES = [...new Set(CHARS.map(c => c.game).filter(Boolean))];
  }

  let TOTAL_TAGS = CATS.reduce((n, c) => n + c.tags.length, 0);

    /* =====================================================================
     (2.5 Req 7) 10 段生成铁律排序引擎（Section 1：标签顺序 10 段，严格按序排列，缺段跳过）
     1. 质量：masterpiece, best quality
     2. 美学：score_9, score_8（Anima 官方美学分）
     3. 时代：如 year 2025, newest
     4. Meta：highres, official art 等
     5. 安全：{safe, sensitive, nsfw, explicit}（如实；不确定时按更严的报）
     6. 人数：如 1girl, 2girls
     7. 角色名：完整角色名（如 gotoh hitori）
     8. 系列名：完整作品名（如 bocchi the rock!, kessoku band）
     9. 画师标签：一律 @ 前缀（如 @abpart）；无指定画师可省略
     10. 通用标签：视觉细节（发型/眼睛/服装/姿势/背景/动作）
     ===================================================================== */
  const CHAR_NAME_SET = new Set([
    'gotoh hitori', 'ijichi nijika', 'yamada ryo', 'kita ikuyo', 'hiroi kikuri', 'ijichi seika',
    'frieren', 'fern', 'stark', 'himmel', 'aura', 'ubel', 'serie',
    'hatsune miku', 'kagamine rin', 'kagamine len', 'megurine luka', 'kasane teto', 'luo tianyi',
    'hakurei reimu', 'kirisame marisa', 'remilia scarlet', 'flandre scarlet', 'izayoi sakuya', 'konpaku youmu', 'koishi komeiji', 'satori komeiji',
    'lumine', 'aether', 'paimon', 'furina', 'nahida', 'raiden shogun', 'hu tao', 'ganyu', 'keqing', 'yae miko', 'navia', 'arlecchino', 'nilou', 'shenhe',
    'kafka', 'firefly', 'silver wolf', 'march 7th', 'stelle', 'caelus', 'acheron', 'black swan', 'sparkle', 'robin', 'feixiao',
    'amiya', 'texas', 'lappland', 'skadi', 'surtr', 'w', 'kal\'tsit', 'mudrock', 'chen', 'exusiai',
    'hoshino', 'shiroko', 'arona', 'plana', 'yuuka', 'noa', 'rio', 'asuna', 'karin', 'alice', 'toki', 'mika', 'hina', 'kisaki', 'mari',
    'artoria pendragon', 'jeanne d\'arc', 'jeanne d\'arc alter', 'mash kyrielight', 'ishtar', 'ereshkigal', 'morgan', 'castoria',
    '2b', 'a2', '9s', 'makima', 'power', 'reze', 'asa mitaka', 'anya forger', 'yor forger', 'loid forger',
    'hoshino ai', 'hoshino ruby', 'hoshino aquamarin', 'arima kana', 'kurokawa akane',
    'nishikigi chisato', 'inoue takina', 'rem', 'ram', 'emilia', 'echidna', 'megumin', 'aqua', 'darkness',
    'ayanami rei', 'asuka langley', 'souryuu asuka langley', 'shikinami asuka langley', 'misato katsuragi', 'mari illustrious makinami',
    'kaname madoka', 'akemi homura', 'miki sayaka', 'tomoe mami', 'sakura kyouko',
    'violet evergarden', 'zero two', 'elaina', 'holo', 'kitagawa marin', 'shiina mahiru', 'tokisaki kurumi',
    'hirasawa yui', 'akiyama mio', 'tainaka ritsu', 'kotobuki tsumugi', 'nakano azusa',
    'iseri nina', 'kawaragi momoka', 'awa subaru', 'ebizuka tomo', 'rupa',
    'takamatsu tomori', 'chihaya anon', 'kaname raana', 'nagasaki soyo', 'shiina taki', 'togawa sakiko', 'wakaba mutsumi', 'misumi uika', 'yahata umiri', 'nyamu yuutenji'
  ]);

  const SERIES_NAME_SET = new Set([
    'bocchi the rock!', 'kessoku band', 'sick hack', 'sideros',
    'genshin impact', 'honkai: star rail', 'honkai impact 3rd', 'honkai (series)', 'zenless zone zero', 'wuthering waves',
    'blue archive', 'arknights', 'azur lane', 'fate/grand order', 'fate/stay night', 'fate (series)',
    'girls\' frontline', 'girls\' frontline 2: exilium', 'goddess of victory: nikke', 'nikke',
    'umamusume', 'uma musume pretty derby', 'touhou', 'touhou project', 'vocaloid', 'project sekai',
    'hololive', 'hololive english', 'nijisanji', 'vspo!', 'indie virtual youtuber',
    'bang dream!', 'bang dream! it\'s mygo!!!!!', 'mygo!!!!!', 'ave mujica', 'roselia', 'poppin\'party',
    'girls band cry', 'togenashi togeari', 'diamond dust',
    'love live!', 'love live! school idol project', 'love live! sunshine!!', 'love live! nijigasaki high school idol club', 'love live! superstar!!', 'hasunosora girls\' high school idol club',
    'idolmaster', 'the idolmaster', 'the idolmaster cinderella girls', 'the idolmaster shiny colors', 'gakuen idolmaster',
    'princess connect!', 'princess connect! re:dive', 'punishing: gray raven', 'honor of kings',
    'sousou no frieren', 'frieren: beyond journey\'s end', 'chainsaw man', 'spy x family', 'oshi no ko', 'lycoris recoil',
    're:zero', 're:zero kara hajimeru isekai seikatsu', 'konosuba', 'sword art online',
    'neon genesis evangelion', 'evangelion', 'rebuild of evangelion', 'mahou shoujo madoka magica', 'puella magi madoka magica',
    'k-on!', 'houkago tea time', 'violet evergarden', 'nier:automata', 'nier (series)', 'cyberpunk: edgerunners', 'cyberpunk 2077',
    'persona 5', 'persona (series)', 'elden ring', 'dark souls', 'final fantasy', 'final fantasy vii', 'final fantasy xiv',
    'pokemon', 'league of legends', 'arcane', 'overwatch', 'valorant', 'splatoon', 'fire emblem', 'xenoblade chronicles',
    'guilty gear', 'street fighter', 'granblue fantasy', 'kantai collection', 'kancolle',
    'majo no tabitabi', 'sono bisque doll wa koi wo suru', 'date a live', 'otonari no tenshi-sama', 'roshidere', 'dandadan',
    'bleach', 'naruto', 'one piece', 'jujutsu kaisen', 'kimetsu no yaiba', 'attack on titan', 'kill la kill', 'gurren lagann', 'code geass', 'steins;gate', 'monogatari (series)'
  ]);

  /* =====================================================================
     (V1.2.1 Anima Official Priority Rules)
     Base Prefix: masterpiece, best quality, score_7, safe (or nsfw), [Meta/Year]
     Visual Priority:
       1. Subject count (1girl, solo, chibi, base)
       2. Identity and series (+ @artist)
       3. Defining appearance (hair, eyes, expression/emotes :3 >_<, body, clothing/outfit)
       4. Action and pose (pose, head/mouth/hand/foot action, interaction, props)
       5. Camera and framing (composition: upper body, from above; camera: depth of field)
       6. Environment (indoor, nature: simple background, urban, fantasy_scifi, weather_time)
       7. Lighting and style (lighting, style: anime coloring, natural language text)
     Negative Baseline:
       worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration
     ===================================================================== */
  const GEN_SUB_RANK_MAP = {
    base: 68,
    occupation: 105,
    species: 106,
    animals: 108,
    hair_color: 108,
    hair_style: 110,
    hair: 110,
    ears: 112,
    head: 114,
    eyes: 115,
    nose: 115,
    face: 115,
    mouth: 116,
    expression: 118,
    body: 120,
    skin: 121,
    breasts: 122,
    ass: 123,
    wings: 124,
    tail: 124,
    pussy: 125,
    penis: 125,
    legs: 126,
    feet: 127,
    body_parts: 128,
    nsfwbody: 124,
    headwear: 129,
    eyewear: 130,
    neckwear: 130,
    handwear: 131,
    shoulderwear: 131,
    chestwear: 132,
    upper_body: 132,
    lower_body: 133,
    underwear: 134,
    hipwear: 134,
    legwear: 135,
    pattern: 135,
    footwear: 135,
    clothing: 132,
    nsfwcloth: 132,
    accessory: 136,
    pose: 140,
    head_action: 142,
    mouth_action: 143,
    hand_action: 144,
    foot_action: 145,
    interaction: 146,
    nsfwact: 146,
    food: 148,
    items: 149,
    tools: 150,
    restraints: 151,
    sex_toys: 152,
    props: 149,
    nsfwplay: 151,
    composition: 156,
    camera: 158,
    indoor: 162,
    nature: 164,
    urban: 165,
    fantasy_scifi: 166,
    weather_time: 168,
    environment: 164,
    weather: 168,
    lighting: 172,
    style: 178,
    text: 185,
    moss: 188,
    uncategorized: 190,
    negative: 25
  };

  const NEG_BASELINE_ORDER_MAP = {
    'worst quality': 1,
    'low quality': 2,
    'score_1': 3,
    'score 1': 3,
    'score_2': 4,
    'score 2': 4,
    'score_3': 5,
    'score 3': 5,
    'artist name': 6,
    'blurry': 7,
    'jpeg artifacts': 8,
    'chromatic aberration': 9
  };

  const RANK = new Map();
  const TAG_SUB_LOOKUP = new Map();

  /* V1.2.3 Req 2: 精准小分类标签徽章映射表（彻底修复物品标成动作、表情标成外貌、服饰标成外貌等错乱问题） */
  const SUB_BADGE_LABEL_MAP = {
    base: '人物基础',
    occupation: '身份·职业',
    species: '种族',
    hair_color: '发色',
    hair_style: '发型',
    hair: '发型·发色',
    ears: '耳朵·角',
    head: '头部·脸型',
    eyes: '眼部·瞳色',
    nose: '鼻子',
    face: '五官',
    mouth: '嘴部',
    expression: '表情',
    body: '体型',
    skin: '肤色·体表',
    breasts: '胸部',
    ass: '臀部',
    wings: '翅膀',
    tail: '尾巴',
    pussy: '私密部位',
    penis: '私密部位',
    legs: '腿部',
    feet: '脚部',
    body_parts: '身体部位',
    nsfwbody: '身体部位',
    headwear: '服饰·头饰',
    eyewear: '服饰·眼饰',
    neckwear: '服饰·颈饰',
    handwear: '服饰·手饰',
    shoulderwear: '服饰·肩部',
    chestwear: '服饰·胸衣',
    upper_body: '服饰·上装',
    lower_body: '服饰·下装',
    underwear: '服饰·内衣',
    hipwear: '服饰·臀胯',
    legwear: '服饰·腿袜',
    pattern: '服饰·纹饰',
    footwear: '服饰·鞋靴',
    clothing: '服饰',
    nsfwcloth: '服饰',
    accessory: '服饰·饰品',
    pose: '动作·姿势',
    head_action: '动作·头部',
    mouth_action: '动作·嘴部',
    hand_action: '动作·手部',
    foot_action: '动作·腿脚',
    interaction: '动作·互动',
    nsfwact: '动作·互动',
    food: '道具·食品',
    items: '道具·物品',
    tools: '道具·工具',
    restraints: '道具·束缚',
    sex_toys: '道具·玩具',
    props: '道具·物品',
    nsfwplay: '道具',
    composition: '构图',
    background: '构图·背景',
    camera: '镜头·视角',
    indoor: '场景·室内',
    nature: '场景·自然',
    urban: '场景·城市',
    fantasy_scifi: '场景·奇幻',
    weather_time: '场景·天气',
    environment: '场景·环境',
    weather: '场景·天气',
    lighting: '光影',
    style: '画风·风格',
    artist: '画师',
    text: '自然语句',
    moss: '自然语句',
    uncategorized: '未分类',
    negative: '负面词'
  };

  function rebuildRanks() {
    TOTAL_TAGS = CATS.reduce((n, c) => n + c.tags.length, 0);
    RANK.clear();
    TAG_SUB_LOOKUP.clear();

    CATS.forEach(c => {
      c.tags.forEach(t => {
        const k = norm(t.en);
        const kSp = k.replace(/_/g, ' ');
        const kUn = k.replace(/\s+/g, '_');
        const kClean = norm(String(t.en || '').replace(/^@+/, ''));
        if (k && !TAG_SUB_LOOKUP.has(k)) TAG_SUB_LOOKUP.set(k, c.id);
        if (kSp && !TAG_SUB_LOOKUP.has(kSp)) TAG_SUB_LOOKUP.set(kSp, c.id);
        if (kUn && !TAG_SUB_LOOKUP.has(kUn)) TAG_SUB_LOOKUP.set(kUn, c.id);
        if (kClean && !TAG_SUB_LOOKUP.has(kClean)) TAG_SUB_LOOKUP.set(kClean, c.id);
      });
    });

    CHARS.forEach(c => {
      if (!c || !c.tag) return;
      const fullK = norm(c.tag);
      CHAR_NAME_SET.add(fullK);
      CHAR_NAME_SET.add(fullK.replace(/_/g, ' '));
      const m = String(c.tag).match(/^(.+?)\s*\(([^)]+)\)\s*$/);
      if (m) {
        const bareChar = norm(m[1]);
        const seriesName = norm(m[2]);
        if (bareChar) {
          CHAR_NAME_SET.add(bareChar);
          CHAR_NAME_SET.add(bareChar.replace(/_/g, ' '));
        }
        if (seriesName) {
          SERIES_NAME_SET.add(seriesName);
          SERIES_NAME_SET.add(seriesName.replace(/_/g, ' '));
        }
      }
      if (c.gameTag && !/^(anime|games|vtuber|custom)$/i.test(c.gameTag)) {
        const gt = norm(c.gameTag);
        SERIES_NAME_SET.add(gt);
        SERIES_NAME_SET.add(gt.replace(/_/g, ' '));
      }
    });
  }

  function resolveSubIdForTag(rawEn, explicitSubId) {
    if (explicitSubId && SUB_BADGE_LABEL_MAP[explicitSubId]) return explicitSubId;
    const clean = String(rawEn || '').trim().replace(/^@+/, '').replace(/\\([()[\]])/g, '$1');
    const k = norm(clean);
    const kSp = k.replace(/_/g, ' ');
    const kUn = k.replace(/\s+/g, '_');
    const hit = TAG_SUB_LOOKUP.get(k) || TAG_SUB_LOOKUP.get(kSp) || TAG_SUB_LOOKUP.get(kUn) || explicitSubId || '';
    if (hit) return hit;
    if (typeof state !== 'undefined' && state) {
      if (Array.isArray(state.customTagCats)) {
        for (const cc of state.customTagCats) {
          if (cc && Array.isArray(cc.tags) && cc.tags.some(t => norm(t.en) === k || norm(t.en).replace(/_/g, ' ') === kSp)) {
            return '__custom__';
          }
        }
      }
      if (Array.isArray(state.custom) && state.custom.some(t => norm(t.en) === k || norm(t.en).replace(/_/g, ' ') === kSp)) {
        return '__custom__';
      }
    }
    return '';
  }

  function getPromptSegmentInfo(it) {
    if (!it) return { seg: 10, label: '自由词', rank: 184 };
    if (typeof it === 'object' && it.kind === 'text') {
      return { seg: 11, label: '自然语句', rank: 186 };
    }
    const raw = String((typeof it === 'object' ? it.en : it) || '').trim();
    const rawSubId = (typeof it === 'object' && it.subId) ? it.subId : '';
    const k = norm(raw);
    const kSpace = k.replace(/_/g, ' ');
    const cleanK = norm(raw.replace(/^@+/, '').replace(/\\([()[\]])/g, '$1'));
    const cleanKSpace = cleanK.replace(/_/g, ' ');

    // 负面模式或负面分类词条
    if (NEG_BASELINE_ORDER_MAP[k] || NEG_BASELINE_ORDER_MAP[kSpace]) {
      const nRank = NEG_BASELINE_ORDER_MAP[k] || NEG_BASELINE_ORDER_MAP[kSpace];
      if ((typeof state !== 'undefined' && state && state.mode === 'neg') || rawSubId === 'negative') {
        return { seg: 0, label: '负面·基线', rank: nRank };
      }
    }
    if ((typeof state !== 'undefined' && state && state.mode === 'neg') || rawSubId === 'negative') {
      const cidNeg = resolveSubIdForTag(raw, rawSubId);
      if (cidNeg === 'negative' || (typeof state !== 'undefined' && state && state.mode === 'neg')) {
        return { seg: 0, label: '负面词', rank: 25 };
      }
    }

    // Base Prefix 1. 质量：masterpiece, best quality 等
    if (kSpace === 'masterpiece') return { seg: 1, label: '质量', rank: 10 };
    if (kSpace === 'best quality') return { seg: 1, label: '质量', rank: 11 };
    if (/^(amazing quality|great quality|good quality|high quality|ultra-detailed|ultra detailed|extremely detailed|intricate details|detailed|hyperdetailed|flawless|perfection)$/.test(kSpace)) {
      return { seg: 1, label: '质量', rank: 15 };
    }

    // Base Prefix 2. 评分与美学：score_9, score_8, score_7
    if (k === 'score_9' || kSpace === 'score 9') return { seg: 2, label: '评分', rank: 20 };
    if (k === 'score_8_up' || kSpace === 'score 8 up') return { seg: 2, label: '评分', rank: 21 };
    if (k === 'score_8' || kSpace === 'score 8') return { seg: 2, label: '评分', rank: 22 };
    if (k === 'score_7_up' || kSpace === 'score 7 up') return { seg: 2, label: '评分', rank: 23 };
    if (k === 'score_7' || kSpace === 'score 7') return { seg: 2, label: '评分', rank: 24 };
    if (/^score[_ ]\d+(_up|\s+up)?$/.test(k)) return { seg: 2, label: '评分', rank: 25 };
    if (/^(very aesthetic|aesthetic|masterpiece aesthetic|beautiful and aesthetic)$/.test(kSpace)) {
      return { seg: 2, label: '美学', rank: 26 };
    }

    // Base Prefix 3. 安全分级：{safe, sensitive, nsfw, explicit}
    if (kSpace === 'safe' || k === 'rating:safe' || k === 'rating:general' || kSpace === 'general') return { seg: 3, label: '安全分级', rank: 30 };
    if (kSpace === 'sensitive' || k === 'rating:sensitive') return { seg: 3, label: '安全分级', rank: 31 };
    if (kSpace === 'nsfw' || kSpace === 'questionable' || k === 'rating:questionable') return { seg: 3, label: '安全分级', rank: 32 };
    if (kSpace === 'explicit' || k === 'rating:explicit') return { seg: 3, label: '安全分级', rank: 33 };

    // Base Prefix 4. Meta 与年代：highres, official art, year 2025 等
    if (kSpace === 'highres' || kSpace === 'high resolution') return { seg: 4, label: '画质·Meta', rank: 40 };
    if (kSpace === 'absurdres') return { seg: 4, label: '画质·Meta', rank: 41 };
    if (kSpace === 'incredibly absurdres' || kSpace === 'ultra highres') return { seg: 4, label: '画质·Meta', rank: 42 };
    if (kSpace === '4k' || kSpace === '8k' || kSpace === 'uhd') return { seg: 4, label: '画质·Meta', rank: 43 };
    if (kSpace === 'official art') return { seg: 4, label: '画质·Meta', rank: 44 };
    if (/^(game cg|promotional art|key visual|cover page|concept art|illustration|anime screenshot|wallpaper|commission|original|official style)$/.test(kSpace)) {
      return { seg: 4, label: '画质·Meta', rank: 46 };
    }
    if (/^year[_ ]\d{4}$/.test(k)) return { seg: 4, label: '年代', rank: 48 };
    if (kSpace === 'newest') return { seg: 4, label: '年代', rank: 49 };
    if (/^(recent|late|mid|early|old|retro|vintage|19[789]0s|20[012]0s)$/.test(kSpace)) {
      return { seg: 4, label: '年代', rank: 50 };
    }

    // Priority 1. 人数与主体 (1girl, solo, chibi)
    if (kSpace === '1girl') return { seg: 5, label: '人数', rank: 60 };
    if (kSpace === '2girls') return { seg: 5, label: '人数', rank: 61 };
    if (/^([3-9]|\d+\+)\s*girls$|^multiple girls$/.test(kSpace)) return { seg: 5, label: '人数', rank: 62 };
    if (kSpace === '1boy') return { seg: 5, label: '人数', rank: 63 };
    if (/^([2-9]|\d+\+)\s*boys$|^multiple boys$/.test(kSpace)) return { seg: 5, label: '人数', rank: 64 };
    if (/^(\d+\+?\s*(other|others)|multiple others|no humans)$/.test(kSpace)) return { seg: 5, label: '人数', rank: 65 };
    if (kSpace === 'solo') return { seg: 5, label: '人数', rank: 66 };
    if (/^(solo focus|female focus|male focus|couple|group|everyone|duo|trio)$/.test(kSpace)) return { seg: 5, label: '人数', rank: 67 };
    if (kSpace === 'chibi') return { seg: 5, label: '人物基础', rank: 68 };

    // Priority 2. 角色 / 作品系列 / 画师
    const cid = resolveSubIdForTag(raw, rawSubId);
    if (raw.startsWith('@') || cid === 'artist') {
      return { seg: 6, label: '画师', rank: 90 };
    }
    const catObj = CATS.find(c => c.id === cid);
    if (catObj && /画师|artist/i.test(catObj.name || '')) {
      return { seg: 6, label: '画师', rank: 90 };
    }
    if (rawSubId === 'series' || SERIES_NAME_SET.has(k) || SERIES_NAME_SET.has(kSpace) || SERIES_NAME_SET.has(cleanK) || SERIES_NAME_SET.has(cleanKSpace)) {
      return { seg: 6, label: '作品·系列', rank: 80 };
    }
    if (rawSubId === 'char' || CHAR_NAME_SET.has(k) || CHAR_NAME_SET.has(kSpace) || CHAR_NAME_SET.has(cleanK) || CHAR_NAME_SET.has(cleanKSpace)) {
      return { seg: 6, label: '角色', rank: 70 };
    }

    // Priority 3 ~ 7: 颜文字与常规标签精准匹配所属小分类
    if (isAnimaEmoteOrScore(k) && !/^score_/.test(k)) {
      return { seg: 7, label: '表情', rank: 118 };
    }

    if (cid === '__custom__') {
      return { seg: 10, label: '自定义', rank: 182 };
    }

    if (cid && SUB_BADGE_LABEL_MAP[cid]) {
      const exactRank = GEN_SUB_RANK_MAP[cid] || 150;
      const segNum = exactRank < 70 ? 5 : (exactRank < 129 ? 7 : (exactRank < 140 ? 7 : (exactRank < 155 ? 8 : (exactRank < 160 ? 9 : (exactRank < 170 ? 10 : 11)))));
      return { seg: segNum, label: SUB_BADGE_LABEL_MAP[cid], rank: exactRank };
    }

    if (catObj && catObj.name) {
      const fallbackRank = GEN_SUB_RANK_MAP[cid] || 150;
      return { seg: 10, label: catObj.name, rank: fallbackRank };
    }

    // 未在词库分类中命中的常见固定表达兜底
    if (/^(looking at viewer|looking away|looking back|looking down|looking up|eye contact|facing viewer|looking to the side)$/.test(kSpace)) {
      return { seg: 8, label: '动作·头部', rank: 142 };
    }
    if (/^(upper body|lower body|cowboy shot|full body|close-up|extreme close-up|wide shot|medium shot|from above|from below|from behind|from side|from front|dutch angle|pov)$/.test(kSpace)) {
      return { seg: 9, label: '镜头·构图', rank: 156 };
    }
    if (/^(simple background|white background|black background|colorful background|gradient background|transparent background|blurry background|detailed background)$/.test(kSpace)) {
      return { seg: 10, label: '场景·背景', rank: 164 };
    }

    return { seg: 10, label: '自由词', rank: 184 };
  }

  rebuildRanks();

  const rankOf = it => getPromptSegmentInfo(it).rank;
/* =====================================================================
     2. 状态
     ===================================================================== */

  state = {
    sel: [],
    neg: [],
    mode: 'pos',
    cat: 'all',
    q: '',
    showZh: true,
    showNsfw: true,
    ratingOverrides: {},
    escape: true,
    syntax: 'sd',
    chars: [],
    custom: [],
    randomScene: 'portrait',
    randomN: 8,
    randomNsfw: false,
    autosave: false,
    autoOrder: true,
    online: true,
    forceOnline: false,
    autoTr: true,
    highlight: null,
    model: 'anima',
    modelPrefix: false,
    batchSelectMode: false,
    batchSelectedMap: new Map(),
    batchLastClickedKey: '',
    batchAnchorKey: '',
    negNavOpen: false,
    customNavOpen: false,
    nsfwNavOpen: false,
    theme: 'dark',
    logoStyle: 'chibi',
    customChars: [],
    customCharCats: [],
    customTagCats: [],
    charCustomSubs: [],
    charDescMap: {},
    nsfwCustomOn: new Set(),
    nsfwCustomOff: new Set(),
    presetCat: 'all',
    favTags: [],
    recentTags: [],
    favChars: [],
    recentChars: [],
    history: [],
    outLock: false,
    mossMode: false,
    rightSidebarOpen: true,
    layoutDirty: false,
    randCfg: {
      fixedTags: 'masterpiece, best quality, score_7, safe, 1girl, solo',
      randWeight: false,
      nsfwMinCount: 2,
      switches: [
        { id: 'sw_quality', name: '含质量词', enabled: true, tagType: 'sfw', intervals: [{ id: 'style', count: 2 }], activeIntervalIdx: 0, catIds: ['style'], catId: 'style', count: 2, prob: 100, fixedTags: '', prefixAt: false, builtin: true },
        { id: 'sw_artist', name: '含画师', enabled: true, tagType: 'sfw', intervals: [{ id: 'artist', count: 1 }], activeIntervalIdx: 0, catIds: ['artist'], catId: 'artist', count: 1, prob: 100, fixedTags: '', prefixAt: true, builtin: true },
        { id: 'sw_char', name: '含角色', enabled: false, tagType: 'char', intervals: [{ id: 'char:library', count: 1 }], activeIntervalIdx: 0, catIds: ['char:library'], catId: 'char:library', count: 1, prob: 100, fixedTags: '', prefixAt: false, builtin: true, isCharSwitch: true },
        { id: 'sw_nsfw', name: '含nsfw', enabled: false, tagType: 'nsfw', intervals: [{ id: 'nsfw_mapped:all', count: 2 }], activeIntervalIdx: 0, catIds: ['nsfw_mapped:all'], catId: 'nsfw_mapped:all', count: 2, minNsfwCount: 2, prob: 100, fixedTags: '', prefixAt: false, builtin: true }
      ],
      drawRules: [
        { id: 'dr_base', targetId: 'base', mode: 'fixed', count: 1, prob: 100, nsfwProb: 30 },
        { id: 'dr_hair_color', targetId: 'hair_color', mode: 'fixed', count: 1, prob: 100, nsfwProb: 20 },
        { id: 'dr_hair_style', targetId: 'hair_style', mode: 'fixed', count: 1, prob: 100, nsfwProb: 20 },
        { id: 'dr_eyes', targetId: 'eyes', mode: 'prob', count: 1, prob: 85, nsfwProb: 25 },
        { id: 'dr_mouth', targetId: 'mouth', mode: 'prob', count: 1, prob: 60, nsfwProb: 35 },
        { id: 'dr_expression', targetId: 'expression', mode: 'prob', count: 1, prob: 85, nsfwProb: 40 },
        { id: 'dr_body', targetId: 'body', mode: 'prob', count: 1, prob: 65, nsfwProb: 45 },
        { id: 'dr_upper_body', targetId: 'upper_body', mode: 'fixed', count: 1, prob: 100, nsfwProb: 45 },
        { id: 'dr_lower_body', targetId: 'lower_body', mode: 'prob', count: 1, prob: 75, nsfwProb: 45 },
        { id: 'dr_legwear', targetId: 'legwear', mode: 'prob', count: 1, prob: 65, nsfwProb: 35 },
        { id: 'dr_footwear', targetId: 'footwear', mode: 'prob', count: 1, prob: 60, nsfwProb: 20 },
        { id: 'dr_accessory', targetId: 'accessory', mode: 'prob', count: 1, prob: 60, nsfwProb: 25 },
        { id: 'dr_pose', targetId: 'pose', mode: 'fixed', count: 1, prob: 100, nsfwProb: 50 },
        { id: 'dr_hand_action', targetId: 'hand_action', mode: 'prob', count: 1, prob: 70, nsfwProb: 50 },
        { id: 'dr_indoor', targetId: 'indoor', mode: 'prob', count: 1, prob: 50, nsfwProb: 30 },
        { id: 'dr_nature', targetId: 'nature', mode: 'prob', count: 1, prob: 65, nsfwProb: 15 },
        { id: 'dr_weather_time', targetId: 'weather_time', mode: 'prob', count: 1, prob: 45, nsfwProb: 15 },
        { id: 'dr_lighting', targetId: 'lighting', mode: 'prob', count: 1, prob: 75, nsfwProb: 15 },
        { id: 'dr_camera', targetId: 'camera', mode: 'prob', count: 1, prob: 70, nsfwProb: 20 },
        { id: 'dr_composition', targetId: 'composition', mode: 'prob', count: 1, prob: 55, nsfwProb: 20 }
      ],
      charRule: { enabled: false, prob: 100, count: 1, withAuto: true }
    },
    recentCharTags: [],
    charNavOpen: false,
    posNavOpen: false,
    nsfwNavOpen: false,
    histPick: [],
    expandedSubs: [],
    undoStack: [],
    redoStack: [],
    editingMajorId: '',
    editingSubId: '',
    seenNewTags: [],
    seenNewTagsSet: new Set(),
    seenNewChars: [],
    seenNewCharsSet: new Set(),
    customTpls: [],
    deletedTplIds: []
  };

  let stateCharTags = [];

  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (Array.isArray(d.sel)) state.sel = d.sel.filter(x => x && x.en).map(fixItem);
      if (Array.isArray(d.neg)) state.neg = d.neg.filter(x => x && x.en).map(fixItem);
      if (Array.isArray(d.custom)) state.custom = d.custom.filter(x => x && x.en).map(x => ({ en: x.en, zh: x.zh || '', desc: x.desc || '' }));
      if (Array.isArray(d.customCharCats)) state.customCharCats = d.customCharCats;
      if (Array.isArray(d.customChars)) state.customChars = d.customChars;
      if (Array.isArray(d.customTagCats)) state.customTagCats = d.customTagCats;
      if (Array.isArray(d.customTpls)) state.customTpls = d.customTpls;
      if (Array.isArray(d.deletedTplIds)) state.deletedTplIds = d.deletedTplIds;
      if (Array.isArray(d.seenNewTags)) {
        state.seenNewTags = d.seenNewTags;
        state.seenNewTagsSet = new Set(d.seenNewTags);
      }
      if (Array.isArray(d.seenNewChars)) {
        state.seenNewChars = d.seenNewChars;
        state.seenNewCharsSet = new Set(d.seenNewChars);
      }
      if (Array.isArray(d.charCustomSubs)) state.charCustomSubs = d.charCustomSubs;
      if (Array.isArray(d.charDeletedSubs)) state.charDeletedSubs = d.charDeletedSubs;
      if (typeof d._custTagCatsInited === 'boolean') state._custTagCatsInited = d._custTagCatsInited;
      if (d.charDescMap && typeof d.charDescMap === 'object') state.charDescMap = d.charDescMap;
      if (d.settings) {
        const s = d.settings;
        if (typeof s.showZh === 'boolean') state.showZh = s.showZh;
        if (typeof s.showNsfw === 'boolean') state.showNsfw = s.showNsfw;
        if (typeof s.stickySubHead === 'boolean') state.stickySubHead = s.stickySubHead;
        if (s.ratingOverrides && typeof s.ratingOverrides === 'object') state.ratingOverrides = Object.assign({}, state.ratingOverrides || {}, s.ratingOverrides);
        if (typeof s.escape === 'boolean') state.escape = s.escape;
        if (s.syntax) state.syntax = s.syntax;
        if (typeof s.randomN === 'number') state.randomN = clamp(s.randomN, 2, 20);
        if (typeof s.randomNsfw === 'boolean') state.randomNsfw = s.randomNsfw;
        if (s.theme === 'light' || s.theme === 'dark') { state.theme = s.theme; try { localStorage.setItem('pg_theme', s.theme); } catch (e) {} document.documentElement.setAttribute('data-theme', s.theme); }
        if (s.logoStyle === 'dp' || s.logoStyle === 'chibi') { state.logoStyle = s.logoStyle; try { localStorage.setItem('pg_logo_style', s.logoStyle); } catch (e) {} if (typeof window.applyLogoIconStyle === 'function') window.applyLogoIconStyle(s.logoStyle); }
        if (typeof s.autosave === 'boolean' && Number(s.settingsVersion || 0) >= 2.9) state.autosave = s.autosave; else state.autosave = false;
        if (typeof s.autoOrder === 'boolean') state.autoOrder = s.autoOrder;
        if (typeof s.online === 'boolean') state.online = s.online;
        if (typeof s.forceOnline === 'boolean') state.forceOnline = s.forceOnline;
        if (typeof s.autoTr === 'boolean') state.autoTr = s.autoTr;
        if (s.model === 'moss' || s.model === 'anima') state.model = s.model;
      if (typeof s.mossMode === 'boolean') { state.mossMode = s.mossMode; state.model = s.mossMode ? 'moss' : 'anima'; }
      if (typeof s.rightSidebarOpen === 'boolean') state.rightSidebarOpen = s.rightSidebarOpen;
      if (s.randCfg && typeof s.randCfg === 'object') state.randCfg = Object.assign(state.randCfg, s.randCfg);
        if (typeof s.modelPrefix === 'boolean') state.modelPrefix = s.modelPrefix;
        if (Number(s.settingsVersion || 0) >= 3.4) {
          if (Array.isArray(s.nsfwCustomOn)) state.nsfwCustomOn = new Set(s.nsfwCustomOn);
          if (Array.isArray(s.nsfwCustomOff)) state.nsfwCustomOff = new Set(s.nsfwCustomOff);
        }
        if (Array.isArray(s.favTags)) state.favTags = s.favTags.filter(Boolean).slice(0, 300);
        if (Array.isArray(s.recentTags)) state.recentTags = s.recentTags.filter(Boolean).slice(0, 48);
        if (Array.isArray(s.favChars)) state.favChars = s.favChars.filter(Boolean).slice(0, 300);
        if (Array.isArray(s.recentChars)) state.recentChars = s.recentChars.filter(Boolean).slice(0, 40);
        if (Array.isArray(s.recentCharTags)) state.recentCharTags = s.recentCharTags.filter(Boolean).slice(0, 80);
        // 左侧导航栏（角色库、正向提示词、NSFW 等）每次启动默认收起不展开
        state.charNavOpen = false;
        state.posNavOpen = false;
        state.nsfwNavOpen = false;
        state.negNavOpen = false;
        state.customNavOpen = false;
        if (Array.isArray(s.history)) state.history = s.history.filter(x => x && x.t && Array.isArray(x.pos)).slice(0, 40);
        if (typeof s.outLock === 'boolean') state.outLock = s.outLock;
      }
      /* 老存档是单角色 char，新存档是多角色 chars；两种都读 */
      if (Array.isArray(d.chars)) state.chars = d.chars.filter(c => c && c.key);
      else if (d.char && d.char.key) state.chars = [d.char];
    } catch (e) { /* ignore */ }
  }

  function fixItem(x) {
    const it = { key: norm(x.en), en: x.en, zh: x.zh || '', w: typeof x.w === 'number' ? x.w : 1 };
    if (x.desc) it.desc = String(x.desc).trim();
    if (x.kind) it.kind = x.kind;
    if (x.locked) it.locked = true;
    if (x.fromCharKey) it.fromCharKey = x.fromCharKey;
    if (x.subId) it.subId = x.subId;
    return it;
  }

  let saveTimer = null;
  function persistStateAndSettingsNow(includeWorkspace) {
    try {
      const saveWorkspace = (typeof includeWorkspace === 'boolean') ? includeWorkspace : !!state.autosave;
      const curTheme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
      state.theme = curTheme;
      localStorage.setItem('pg_theme', curTheme);

      let prevSel = [], prevNeg = [], prevChars = [];
      if (!saveWorkspace) {
        try {
          const rawPrev = localStorage.getItem(LS_KEY);
          if (rawPrev) {
            const p = JSON.parse(rawPrev);
            if (p && Array.isArray(p.sel)) prevSel = p.sel;
            if (p && Array.isArray(p.neg)) prevNeg = p.neg;
            if (p && Array.isArray(p.chars)) prevChars = p.chars;
          }
        } catch (e) {}
      }

      const selToSave = saveWorkspace ? state.sel : prevSel;
      const negToSave = saveWorkspace ? state.neg : prevNeg;
      const charsToSave = saveWorkspace ? state.chars : prevChars;

      localStorage.setItem(LS_KEY, JSON.stringify({
        sel: selToSave, neg: negToSave, custom: state.custom,
        customTpls: state.customTpls || [],
        deletedTplIds: state.deletedTplIds || [],
        seenNewTags: Array.from(state.seenNewTagsSet || state.seenNewTags || []),
      seenNewChars: Array.from(state.seenNewCharsSet || state.seenNewChars || []),
        seenNewChars: Array.from(state.seenNewCharsSet || state.seenNewChars || []),
        customChars: state.customChars, customCharCats: state.customCharCats, customTagCats: state.customTagCats,
        charCustomSubs: state.charCustomSubs, charDeletedSubs: state.charDeletedSubs || [], _custTagCatsInited: !!state._custTagCatsInited, charDescMap: state.charDescMap,
        chars: charsToSave,
        settings: {
          settingsVersion: 3.5,
          theme: curTheme,
          logoStyle: state.logoStyle || (localStorage.getItem('pg_logo_style') === 'dp' ? 'dp' : 'chibi'),
          showZh: state.showZh, showNsfw: state.showNsfw, stickySubHead: state.stickySubHead !== false, ratingOverrides: state.ratingOverrides || {},
          randCfg: state.randCfg,
          escape: state.escape, syntax: state.syntax,
          randomN: state.randomN, randomNsfw: state.randomNsfw, autosave: !!state.autosave, autoOrder: state.autoOrder,
          online: state.online, forceOnline: state.forceOnline,
          autoTr: state.autoTr, model: state.model, modelPrefix: state.modelPrefix,
          favTags: state.favTags, recentTags: state.recentTags,
          nsfwCustomOn: Array.from(state.nsfwCustomOn || []), nsfwCustomOff: Array.from(state.nsfwCustomOff || []),
          favChars: state.favChars, recentChars: state.recentChars, recentCharTags: state.recentCharTags,
          charNavOpen: state.charNavOpen, posNavOpen: state.posNavOpen, negNavOpen: state.negNavOpen, customNavOpen: state.customNavOpen,
          history: state.history, outLock: state.outLock
        }
      }));
      if (includeWorkspace === 'sync_tree' && window.PG_TAG_FS && typeof window.PG_TAG_FS.saveLocalMirror === 'function') {
        window.PG_TAG_FS.saveLocalMirror();
      }
      syncUserDataToExternalFile(saveWorkspace);
    } catch (e) {}
  }
  window.persistStateAndSettingsNow = persistStateAndSettingsNow;

  function save(forceWorkspace) {
    // (2.9 Req 2) 自动保存默认关闭仅控制右侧临时已选工作台，绝不阻断大分类、小分类、Tag、角色库、收藏与设置的持久化写入
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      persistStateAndSettingsNow(state.autosave || !!forceWorkspace);
    }, 80);
  }

  /* =====================================================================
     3. 提示词索引 / 中英词典
     ===================================================================== */

  const INDEX = new Map();      // en(lower) -> {en, zh, desc}
  const DICT = new Map();       // zh -> en
  const REV = new Map();        // en(lower) -> zh
  const DESC_MAP = new Map();   // en(lower) -> desc

  function idxAdd(en, zh, desc) {
    const k = norm(en);
    if (!k) return;
    const dStr = desc ? String(desc).trim() : '';
    if (!INDEX.has(k)) INDEX.set(k, { en, zh: zh || '', desc: dStr });
    else {
      const cur = INDEX.get(k);
      if (!cur.zh && zh) cur.zh = zh;
      if (dStr) cur.desc = dStr;
    }
    if (zh && !REV.has(k)) REV.set(k, zh);
    if (dStr) DESC_MAP.set(k, dStr);
    if (k.startsWith('@')) {
      const bare = k.replace(/^@+/, '').trim();
      if (bare) {
        if (zh && !REV.has(bare)) REV.set(bare, zh);
        if (dStr && !DESC_MAP.has(bare)) DESC_MAP.set(bare, dStr);
      }
    }
  }

  function descLookup(en, subId) {
    const clean = cleanArtistEn(en);
    const k = norm(clean);
    if (!k) return '';
    if (DESC_MAP.has(k)) return DESC_MAP.get(k);
    if (subId) {
      const hit = TAG_SUB_OBJ_LOOKUP.get(subId + '::' + k) || TAG_OBJ_LOOKUP.get(k);
      if (hit && hit.tag && hit.tag.desc) return String(hit.tag.desc).trim();
    }
    const idxItem = INDEX.get(k);
    if (idxItem && idxItem.desc) return idxItem.desc;
    return '';
  }

  function getArtistProfile(en) {
    const rawDb = window.__EXT_ARTIST_DB__;
    const adb = rawDb && (rawDb.profiles || rawDb.artists);
    if (!adb) return null;
    const clean = cleanArtistEn(en);
    const k1 = norm(clean);
    const k2 = k1.replace(/\s+/g, '_');
    return adb[k1] || adb[k2] || null;
  }

  function getTagHoverTip(t, subId) {
    let en = '';
    let baseTip = '';
    let cnt = 0;
    let topTags = null;
    if (t && typeof t === 'object') {
      en = String(t.en || '');
      const k = norm(cleanArtistEn(en));
      const ref = TAG_OBJ_LOOKUP.get(k);
      const srcTag = (ref && ref.tag) ? ref.tag : t;
      cnt = Number(t.count || srcTag.count || 0);
      topTags = t.topTags || srcTag.topTags || null;
      baseTip = String(t.desc || srcTag.desc || DESC_MAP.get(k) || t.zh || trGet(en) || zhLookup(en) || en || '').trim();
    } else {
      en = String(t || '');
      const k = norm(cleanArtistEn(en));
      const ref = TAG_OBJ_LOOKUP.get(k);
      if (ref && ref.tag) {
        cnt = Number(ref.tag.count || 0);
        topTags = ref.tag.topTags || null;
      }
      baseTip = descLookup(en, subId) || trGet(en) || zhLookup(en) || en;
    }
    if (!topTags && (subId === 'artist' || String(en).startsWith('@'))) {
      const prof = getArtistProfile(en);
      if (prof) {
        if (!cnt && (prof.count || prof.posts)) cnt = Number(prof.count || prof.posts) || 0;
        if (Array.isArray(prof.topTags) && prof.topTags.length) topTags = prof.topTags;
        else if (Array.isArray(prof.top) && prof.top.length) topTags = prof.top;
      }
    }
    if (!cnt && window.__EXT_FULL_DICT__) {
      const fk = norm(cleanArtistEn(en)).replace(/\s+/g, '_');
      const fd = window.__EXT_FULL_DICT__[fk];
      if (Array.isArray(fd)) {
        if (fd[2]) cnt = Number(fd[2]) || 0;
        if (fd[3] && (!baseTip || baseTip === en)) baseTip = fd[3];
      }
    }
    const extraParts = [];
    if (cnt > 0) extraParts.push(`🔥 热度: ${cnt.toLocaleString()}`);
    if (Array.isArray(topTags) && topTags.length) {
      extraParts.push(`🎨 代表特征: ${topTags.slice(0, 6).map(x => {
        if (x && typeof x === 'object') {
          const enStr = String(x.en || '').replace(/_/g, ' ');
          return x.zh ? `${enStr}(${x.zh})` : enStr;
        }
        return String(x).replace(/_/g, ' ');
      }).join(', ')}`);
    }
    if (!extraParts.length) return baseTip;
    return baseTip ? `${baseTip} ｜ ${extraParts.join(' ｜ ')}` : extraParts.join(' ｜ ');
  }

  function getCharHoverTip(c) {
    if (!c) return '';
    const key = c.key || '';
    const customDesc = (state.charDescMap && key && state.charDescMap[key]) ? String(state.charDescMap[key]).trim() : '';
    const rawDesc = String(c.desc || customDesc || '').replace(/\s+/g, ' ').trim();
    if (rawDesc) return rawDesc;
    return String(c.charZh || c.name || c.tag || '').replace(/\s+/g, ' ').trim();
  }

  function ensureCustomCategoriesStructure() {
    if (!Array.isArray(state.customChars)) state.customChars = [];
    if (!state.charDescMap || typeof state.charDescMap !== 'object') state.charDescMap = {};
    if (!Array.isArray(state.charCustomSubs)) state.charCustomSubs = [];

    // Migrate any characters from legacy state.customCharCats into state.customChars
    if (Array.isArray(state.customCharCats) && state.customCharCats.length) {
      const existingKeys = new Set(state.customChars.map(x => x.key));
      state.customCharCats.forEach(cc => {
        (cc.chars || []).forEach(ch => {
          const k = ch.key || ('custchar_' + norm(ch.tag || ch.name));
          if (!existingKeys.has(k)) {
            existingKeys.add(k);
            state.customChars.push({
              key: k,
              name: ch.name || ch.tag || '自定义角色',
              game: '自定义角色',
              tag: ch.tag || '',
              charZh: ch.charZh || ch.name || '',
              desc: ch.desc || '',
              auto: Array.isArray(ch.auto) ? ch.auto : String(ch.autoRaw || ch.auto || '').split(/[;\n]+/).map(s => parsePair(s.trim())).filter(x => x.en)
            });
          }
        });
      });
      state.customCharCats = [];
    }

    if (!Array.isArray(state.customTagCats)) state.customTagCats = [];
    if (!Array.isArray(state.charDeletedSubs)) state.charDeletedSubs = [];
    if (!state._custTagCatsInited) {
      state._custTagCatsInited = true;
      if (!state.customTagCats.length) {
        state.customTagCats.push({
          id: 'cust_tag_1',
          name: '新增分类1',
          icon: '🏷',
          tags: Array.isArray(state.custom) ? state.custom.map(t => ({ en: t.en, zh: t.zh || '', desc: t.desc || '', nsfw: t.nsfw })) : []
        });
      }
    } else {
      // Rename legacy default name '默认自定义标签' to '新增分类1' per Req 5 ("名称默认为新增分类xx")
      state.customTagCats.forEach((tc, idx) => {
        if (tc.name === '默认自定义标签') tc.name = '新增分类' + (idx + 1);
      });
      // (V1.2.9 Req 4) 自动清理自定义分类中与主词库重复的标签（下划线_与空格统一识别）
      const seenDedup = new Set();
      CATS.forEach(cat => (cat.tags || []).forEach(t => seenDedup.add(normDedupKey(t.en))));
      state.customTagCats.forEach(c => {
        const subSeen = new Set();
        c.tags = (c.tags || []).filter(t => {
          if (!t || !t.en) return false;
          t.en = formatAnimaTagEn(t.en);
          const dk = normDedupKey(t.en);
          if (!dk || seenDedup.has(dk) || subSeen.has(dk)) return false;
          subSeen.add(dk);
          seenDedup.add(dk);
          return true;
        });
      });
      state.custom = [];
      state.customTagCats.forEach(c => {
        (c.tags || []).forEach(t => state.custom.push({ en: t.en, zh: t.zh || '', desc: t.desc || '' }));
      });
    }
    syncFlatCustomFromTagCats();
    if (!Array.isArray(state.expandedSubs)) state.expandedSubs = [];
    if (!state._custExpInited) {
      if (state.expandedSubs.indexOf('cust_char_sec') < 0) state.expandedSubs.push('cust_char_sec');
      state.customTagCats.forEach(tc => {
        if (state.expandedSubs.indexOf(tc.id) < 0) state.expandedSubs.push(tc.id);
      });
      state._custExpInited = true;
    }
  }

  function syncFlatCustomFromTagCats() {
    const flat = [];
    const seen = new Set();
    (state.customTagCats || []).forEach(c => {
      (c.tags || []).forEach(t => {
        const k = norm(t.en);
        if (!k || seen.has(k)) return;
        seen.add(k);
        flat.push({ en: t.en, zh: t.zh || '', desc: t.desc || '', nsfw: t.nsfw });
      });
    });
    state.custom = flat;
  }

  function syncCustomCharsIntoGlobalChars() {
    // Keep custom descriptions synced on CHARS
    if (state.charDescMap && typeof state.charDescMap === 'object') {
      CHARS.forEach(c => {
        if (state.charDescMap[c.key] !== undefined) {
          c.desc = state.charDescMap[c.key];
        }
      });
    }
  }

  function findCustomCharByKey(key) {
    ensureCustomCategoriesStructure();
    const ch = (state.customChars || []).find(x => x.key === key);
    if (!ch) return null;
    const autoArr = Array.isArray(ch.auto)
      ? ch.auto
      : String(ch.autoRaw || ch.auto || '').split(/[;\n]+/).map(s => parsePair(s.trim())).filter(x => x.en);
    return {
      key: ch.key,
      name: ch.name,
      game: ch.game || '自定义角色',
      tag: ch.tag || '',
      charZh: ch.charZh || ch.name,
      desc: ch.desc || (state.charDescMap && state.charDescMap[ch.key]) || '',
      auto: autoArr,
      _isCustomChar: true,
      _custRaw: ch
    };
  }
DESC_MAP.clear();
  CATS.forEach(c => c.tags.forEach(t => idxAdd(t.en, t.zh, t.desc)));
  CHARS.forEach(c => {
    idxAdd(c.tag, c.charZh);
    c.auto.forEach(a => idxAdd(a.en, a.zh));
  });
  PRESETS.forEach(p => p.tags.forEach(t => idxAdd(t.en, t.zh)));

  function resolveOfficialAliasKey(rawStr) {
    const amap = window.__EXT_ALIAS_MAP__;
    if (!amap) return '';
    const kSpace = norm(rawStr);
    const kUnder = kSpace.replace(/\s+/g, '_');
    const hit = amap[kUnder] || amap[kSpace] || '';
    return hit ? String(hit).replace(/_/g, ' ').trim() : '';
  }

  function lookupFullOfflineDict(rawStr) {
    const fdict = window.__EXT_FULL_DICT__;
    if (!fdict) return null;
    const kSpace = norm(cleanArtistEn(rawStr));
    const kUnder = kSpace.replace(/\s+/g, '_');
    const row = fdict[kUnder] || fdict[kSpace];
    if (!Array.isArray(row)) return null;
    return {
      en: kUnder.replace(/_/g, ' '),
      zh: row[0] || '',
      cat: row[1] || 0,
      count: row[2] || 0,
      desc: row[3] || '',
      kw: row[4] || ''
    };
  }

  function zhLookup(en) {
    const k = norm(en);
    if (!k) return '';
    const t = TRMEM.get(k);
    if (t && t.zh) return t.zh;
    if (REV.has(k)) return REV.get(k);
    if (INDEX.has(k)) return INDEX.get(k).zh;
    const fd = lookupFullOfflineDict(k);
    if (fd && fd.zh) return fd.zh;
    const aliasTarget = resolveOfficialAliasKey(k);
    if (aliasTarget) {
      const ak = norm(aliasTarget);
      if (REV.has(ak)) return REV.get(ak);
      if (INDEX.has(ak)) return INDEX.get(ak).zh;
      const afd = lookupFullOfflineDict(ak);
      if (afd && afd.zh) return afd.zh;
    }
    return '';
  }

  const PARTICLES = /^[的了着地得之吧呢啊呀哦和与及在是有个]+$/;

  function dictAdd(zh, en) {
    zh = String(zh || '').trim();
    en = String(en || '').trim();
    if (!zh || !en) return;
    if (zh.length > 16) return;
    if (!DICT.has(zh)) DICT.set(zh, en.toLowerCase());
  }

  function splitZh(zh) {
    return String(zh).split(/[、/；;，,()（）]/).map(s => s.trim()).filter(Boolean);
  }

  CATS.forEach(c => c.tags.forEach(t => {
    if (!t.zh) return;
    dictAdd(t.zh, t.en);
    splitZh(t.zh).forEach(z => dictAdd(z, t.en));
  }));
  CHARS.forEach(c => {
    dictAdd(c.name, c.tag);
    dictAdd(c.name + '（' + c.game + '）', c.tag);
    dictAdd(c.name + '(' + c.game + ')', c.tag);
  });
  /* 这两个词库是「中文|english」顺序，和标签的「english|中文」相反 */
  function zhPair(line) {
    const i = line.indexOf('|');
    if (i < 0) return null;
    return { zh: line.slice(0, i).trim(), en: line.slice(i + 1).trim() };
  }

  (window.PG_EXTRA_ZH || '').split('\n').forEach(l => {
    l = l.trim(); if (!l) return;
    const p = zhPair(l); if (p) dictAdd(p.zh, p.en);
  });
  (window.PG_ZH_SYNONYM || '').split('\n').forEach(l => {
    l = l.trim(); if (!l) return;
    const p = zhPair(l); if (p) dictAdd(p.zh, p.en);
  });
  state.custom.forEach(t => dictAdd(t.zh, t.en));

  let DICT_KEYS = [...DICT.keys()].sort((a, b) => b.length - a.length);
  function rebuildDictKeys() { DICT_KEYS = [...DICT.keys()].sort((a, b) => b.length - a.length); }

  const MAX_KEY = 12;

  /* =====================================================================
     4. 渲染
     ===================================================================== */

  const el = {
    catNav: $('#catNav'),
    catTitle: $('#catTitle'),
    grid: $('#tagGrid'),
    empty: $('#emptyState'),
    resultCount: $('#resultCount'),
    libStat: $('#libStat'),
    selList: $('#selectedList'),
    output: $('#output'),
    outStat: $('#outStat'),
    warn: $('#warn'),
    charChip: $('#charChip'),
    search: $('#search')
  };

  function currentList() { return state.mode === 'pos' ? state.sel : state.neg; }

  function modelCfg() {
    const M = window.PG_MODELS || {};
    return M[state.model] || M.anima || { name: 'Anima', hiddenCats: [], prefix: '', negative: '', params: '', tip: '', sep: ', ' };
  }
  function catVisible(c) {
    return !!c;
  }
  function visibleCats() { return CATS.filter(catVisible); }

  /* ===== 拼音搜索 ===== */
  const PY_MAP = window.PG_PINYIN || {};
  const PY_CACHE = new Map();
  function pyOf(str) {
    const key = String(str || '');
    if (PY_CACHE.has(key)) return PY_CACHE.get(key);
    let full = '';
    let ini = '';
    for (const ch of key) {
      if (/[a-z0-9]/i.test(ch)) { full += ch.toLowerCase(); ini += ch.toLowerCase(); continue; }
      const p = PY_MAP[ch];
      if (!p) continue;
      const first = String(p).split(',')[0];
      full += first;
      ini += first.charAt(0);
    }
    const out = { full: full, ini: ini };
    PY_CACHE.set(key, out);
    return out;
  }
  function pyHit(str, q) {
    if (!str || !q || q.length < 2) return false;
    if (!/^[a-z0-9]+$/.test(q)) return false;
    const t = pyOf(str);
    return (t.full && t.full.indexOf(q) >= 0) || (t.ini && t.ini.indexOf(q) >= 0);
  }


  /* ===== 优化包：收藏 / 最近 / 历史 / MOSS 成句 ===== */
  let _tagCat = null;
  function tagCatOf(en) {
    if (!_tagCat) {
      _tagCat = new Map();
      CATS.forEach(c => c.tags.forEach(t => _tagCat.set(norm(t.en), c.id)));
    }
    return _tagCat.get(norm(en)) || '';
  }
  function touchRecent(en) {
    const k = norm(en);
    if (!k) return;
    state.recentTags = [k].concat(state.recentTags.filter(x => x !== k)).slice(0, 48);
  }
  let _favSetCache = { len: -1, first: '', last: '', set: new Set() };
  function isFavTag(en) {
    const arr = state.favTags || [];
    const first = arr[0] || '';
    const last = arr[arr.length - 1] || '';
    if (_favSetCache.len !== arr.length || _favSetCache.first !== first || _favSetCache.last !== last) {
      _favSetCache = { len: arr.length, first, last, set: new Set(arr.map(norm)) };
    }
    return _favSetCache.set.has(norm(en));
  }
  function toggleFavTag(en) {
    const k = norm(en);
    if (!k) return;
    const i = state.favTags.indexOf(k);
    if (i >= 0) state.favTags.splice(i, 1); else state.favTags.unshift(k);
    state.favTags = state.favTags.slice(0, 300);
    renderNav();
    renderGrid();
    save();
    toast(i >= 0 ? '已取消收藏' : '已收藏该标签 ★');
  }
  function findCharByKeyOrTag(k) {
    if (!k) return null;
    const nk = norm(k);
    return CHARS.find(c => c.key === k || norm(c.tag) === nk || norm(c.name) === nk) || null;
  }
  function getFavCharsList() {
    const out = [];
    const seen = new Set();
    (state.favChars || []).forEach(k => {
      const c = findCharByKeyOrTag(k);
      if (c && !seen.has(c.key)) {
        seen.add(c.key);
        out.push(c);
      }
    });
    return out;
  }
  function getRecentCharsList() {
    const out = [];
    const seen = new Set();
    (state.recentChars || []).forEach(k => {
      const c = findCharByKeyOrTag(k);
      if (c && !seen.has(c.key)) {
        seen.add(c.key);
        out.push(c);
      }
    });
    return out;
  }
  function isFavChar(key) {
    const c = findCharByKeyOrTag(key);
    const targetTag = c ? norm(c.tag) : '';
    return (state.favChars || []).some(k => k === key || (c && (k === c.key || norm(k) === targetTag)));
  }
  function toggleFavChar(key) {
    const c = findCharByKeyOrTag(key);
    const canonicalKey = c ? c.key : key;
    const targetTag = c ? norm(c.tag) : '';
    const idx = (state.favChars || []).findIndex(k => k === key || k === canonicalKey || (targetTag && norm(k) === targetTag));
    if (idx >= 0) {
      state.favChars.splice(idx, 1);
    } else {
      state.favChars.unshift(canonicalKey);
    }
    state.favChars = state.favChars.slice(0, 300);
    renderNav();
    renderGrid();
    if ($('#modalChar') && !$('#modalChar').hidden) renderCharGrid();
    save();
    toast(idx >= 0 ? '已取消收藏角色' : '已收藏该角色 ★');
  }
  function touchRecentCharTag(en) {
    const k = norm(cleanArtistEn(en));
    if (!k) return;
    state.recentCharTags = [k].concat((state.recentCharTags || []).filter(x => x !== k)).slice(0, 80);
  }
  function pushHistory() {
    if (!state.sel.length) return;
    const snap = {
      t: Date.now(),
      model: state.model,
      pos: state.sel.map(x => x.en),
      neg: state.neg.map(x => x.en),
      chars: state.chars.map(x => x.key)
    };
    const sig = h => h.pos.join('|') + '#' + h.neg.join('|');
    state.history = [snap].concat(state.history.filter(h => sig(h) !== sig(snap))).slice(0, 40);
    save();
  }
  function loadHistory(idx) {
    const h = state.history[idx];
    if (!h) return;
    recordHistorySnapshot('载入提示词历史');
    const mk = en => {
      const hit = INDEX.get(norm(en));
      return { key: norm(en), en: en, zh: hit ? hit.zh : '', w: 1 };
    };
    state.sel = (h.pos || []).map(mk);
    state.neg = (h.neg || []).map(mk);
    state.chars = (h.chars || []).map(k => CHARS.find(c => c.key === k)).filter(Boolean)
      .map(c => ({ key: c.key, name: c.name, tag: c.tag, charZh: c.charZh,
        tags: [norm(c.tag)].concat(c.auto.map(a => norm(a.en))) }));
    syncCharTags();
    closeModal('modalHistory');
    renderAll();
    save();
    toast('已载入历史提示词');
  }
  function renderHistory() {
    const box = $('#historyList');
    if (!box) return;
    const st = $('#historyStat');
    if (st) st.textContent = state.history.length + ' 条 · 点一条载入';
    if (!state.history.length) {
      box.innerHTML = '<div class="muted" style="padding:20px">还没有历史。复制一次提示词后会自动记下来。</div>';
      return;
    }
    const p2 = n => (n < 10 ? '0' + n : '' + n);
    const picks = state.histPick || [];
    const idxOrder = state.history.map((h, i) => i).sort((a, b) => (state.history[b].pin ? 1 : 0) - (state.history[a].pin ? 1 : 0) || a - b);
    box.innerHTML = idxOrder.map(i => {
      const h = state.history[i];
      const d = new Date(h.t);
      const when = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
      const txt = (h.pos || []).join(', ');
      const picked = picks.indexOf(i) >= 0;
      return '<div class="hist-item' + (h.pin ? ' pinned' : '') + (picked ? ' picked' : '') + '" data-hist="' + i + '">'
        + '<div class="hist-top"><span>' + (h.pin ? '📌 ' : '') + when + ' · ' + (h.model === 'moss' ? 'MOSS' : 'Anima') + '</span>'
        + '<span class="hist-tools">'
        + '<button class="mini" data-hpick="' + i + '" title="勾选后可与另一条对比（最多 2 条）">' + (picked ? '☑' : '☐') + '</button>'
        + '<button class="mini" data-hpin="' + i + '" title="置顶这条历史">' + (h.pin ? '📌' : '📍') + '</button>'
        + '<button class="mini" data-hdiff="' + i + '" title="与当前提示词对比">对比</button>'
        + '<button class="mini danger" data-hdel="' + i + '" title="删除此条历史记录（无需二次确认）">🗑 删除</button>'
        + '</span></div>'
        + '<div class="hist-txt">' + esc(txt.slice(0, 240)) + (txt.length > 240 ? '…' : '') + '</div></div>';
    }).join('');
    const bar = $('#histCompareBar');
    if (bar) {
      bar.hidden = picks.length < 2;
      bar.innerHTML = picks.length >= 2 ? '<span class="muted">已选 2 条</span><span class="spacer"></span><button id="btnHistCompare" class="primary">对比这两条</button><button id="btnHistPickClear" class="ghost">取消选择</button>' : '';
      const bc = $('#btnHistCompare');
      if (bc && !bc._bound) { bc._bound = true; bc.addEventListener('click', () => renderDiffPair(picks[0], picks[1])); }
      const cl = $('#btnHistPickClear');
      if (cl && !cl._bound) { cl._bound = true; cl.addEventListener('click', () => { state.histPick = []; renderHistory(); }); }
    }
    if (!box._bound) {
      box.addEventListener('click', e => {
        const hdel = e.target.closest('[data-hdel]');
        if (hdel) {
          e.stopPropagation();
          const i = Number(hdel.getAttribute('data-hdel'));
          if (state.history[i]) {
            recordHistorySnapshot('删除一条提示词历史');
            state.history.splice(i, 1);
            state.histPick = [];
            renderHistory();
            save();
            toast('已删除该条历史记录');
          }
          return;
        }
        const df = e.target.closest('[data-hdiff]');
        if (df) { e.stopPropagation(); renderDiff(Number(df.getAttribute('data-hdiff'))); return; }
        const pin = e.target.closest('[data-hpin]');
        if (pin) {
          e.stopPropagation();
          const i = Number(pin.getAttribute('data-hpin'));
          if (state.history[i]) { state.history[i].pin = !state.history[i].pin; renderHistory(); save(); toast(state.history[i].pin ? '已置顶' : '已取消置顶'); }
          return;
        }
        const pk = e.target.closest('[data-hpick]');
        if (pk) {
          e.stopPropagation();
          const i = Number(pk.getAttribute('data-hpick'));
          const arr = state.histPick || [];
          const at = arr.indexOf(i);
          if (at >= 0) arr.splice(at, 1);
          else { if (arr.length >= 2) arr.shift(); arr.push(i); }
          state.histPick = arr;
          renderHistory();
          return;
        }
        const it = e.target.closest('[data-hist]');
        if (it) loadHistory(Number(it.getAttribute('data-hist')));
      });
      box._bound = true;
    }
  }
  function buildMossCaption() {
    if (state.mode !== 'pos') return '';
    const pos = viewList(currentList());
    if (!pos.length) return '';
    const g = {};
    pos.forEach(t => { const c = tagCatOf(t.en) || 'extra'; (g[c] = g[c] || []).push(t.en); });
    const take = (...ids) => ids.reduce((a, id) => a.concat(g[id] || []), []);
    const base = take('base');
    const who = base.indexOf('1girl') >= 0 ? 'a girl' : base.indexOf('1boy') >= 0 ? 'a boy'
      : base.indexOf('2girls') >= 0 ? 'two girls' : base.indexOf('2boys') >= 0 ? 'two boys' : 'a character';
    const hair = take('hair'), face = take('face'), body = take('body');
    const cloth = take('clothing', 'accessory');
    const expr = take('expression'), pose = take('pose'), props = take('props');
    const scene = take('environment'), weather = take('weather');
    const light = take('lighting'), cam = take('camera', 'composition');
    const style = take('style', 'moss', 'text', 'extra')
      .filter(x => !/^(score_|masterpiece|best quality|highres|absurdres|sensitive|nsfw|explicit|safe|rating)/i.test(x));
    const tpl = ($('#mossTpl') && $('#mossTpl').value) || 'general';
    const preMap = {
      general: 'A detailed anime illustration of ',
      character: 'An anime character reference sheet of ',
      film: 'A cinematic anime film still of ',
      poster: 'An anime poster illustration of ',
      info: 'A clean infographic illustration of '
    };
    let s = (preMap[tpl] || preMap.general) + who;
    const attrs = hair.concat(face, body);
    if (attrs.length) s += ' with ' + attrs.join(', ');
    const parts = [];
    const push = (arr, pre) => { if (arr.length) parts.push((pre || '') + arr.join(', ')); };
    push(cloth, 'wearing '); push(expr); push(pose); push(props, 'holding ');
    push(scene, 'in '); push(weather); push(light); push(cam);
    push(style, 'in the style of ');
    if (parts.length) s += ', ' + parts.join(', ');
    if (tpl === 'poster') s += ', with clean negative space for the headline';
    if (tpl === 'character') s += ', plain white background';
    if (tpl === 'info') s += ', flat vector style with clear section separators';
    s = s.replace(/\s+/g, ' ').trim();
    if (!/[.!?]$/.test(s)) s += '.';
    return s;
  }
  function updateMossCaption() {
    const box = $('#mossBox');
    if (!box) return;
    box.hidden = state.model !== 'moss';
    if (box.hidden) return;
    const out = $('#mossText');
    if (out) out.value = buildMossCaption();
  }

  /* ===== 优化包 4：预设组合 / 体检 / 生图参数 ===== */
  let presetPick = [];
  function presetComboToggle(key) {
    const i = presetPick.indexOf(key);
    if (i >= 0) presetPick.splice(i, 1); else presetPick.push(key);
    Array.prototype.forEach.call(document.querySelectorAll('[data-preset]'), card => {
      card.classList.toggle('picked', presetPick.indexOf(card.getAttribute('data-preset')) >= 0);
    });
    updatePresetCombo();
  }
  function updatePresetCombo() {
    const bar = $('#presetCombo');
    if (!bar) return;
    bar.hidden = !presetPick.length;
    const info = $('#comboInfo');
    if (info) {
      const names = presetPick.map(k => { const p = PRESETS.find(x => x.key === k); return p ? p.name : ''; }).filter(Boolean);
      info.textContent = '已选 ' + presetPick.length + ' 个：' + names.join(' + ');
    }
  }
  function applyPresetCombo() {
    if (!presetPick.length) { toast('先点预设卡片上的 ＋ 加入组合'); return; }
    recordHistorySnapshot('组合套用预设 (' + presetPick.length + ' 项)');
    let n = 0;
    const order = window.PG_PRESET_CATS || [];
    presetPick.slice().sort((a, b) => {
      const pa = PRESETS.find(x => x.key === a), pb = PRESETS.find(x => x.key === b);
      const ia = order.indexOf(pa ? pa.cat : ''), ib = order.indexOf(pb ? pb.cat : '');
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    }).forEach(k => {
      const p = PRESETS.find(x => x.key === k);
      if (!p) return;
      p.tags.forEach(t => { if (addTag(t.en, t.zh, 1)) n++; });
    });
    presetPick = [];
    state.mode = 'pos';
    syncModeSeg();
    closeModal('modalPreset');
    renderSelected();
    renderGrid();
    save();
    toast('组合叠加完成，新增 ' + n + ' 个标签');
  }
  function renderCheck() {
    const box = $('#checkList');
    if (!box) return;
    const pos = state.sel.map(x => x.en);
    const keys = new Set(state.sel.map(x => x.key));
    const negKeys = new Set(state.neg.map(x => x.key));
    const items = [];
    const add = (lv, title, desc, fix) => items.push({ lv: lv, title: title, desc: desc, fix: fix || '' });
    if (!pos.length) add('bad', '正向为空', '还没有选任何正向标签，先挑几个再复制。', '');
    const hasBase = pos.some(x => tagCatOf(x) === 'base');
    if (pos.length && !hasBase) add('warn', '缺少人物基础', '没有 1girl / 1boy / solo 这类主语，模型可能自由决定人数与构图。', 'add:1girl');
    const hasStyle = pos.some(x => tagCatOf(x) === 'style');
    if (pos.length && !hasStyle) add('warn', '缺少质量/风格词', '建议在「质量与风格」里补 1~2 个，例如 masterpiece / best quality。', 'add:masterpiece');
    CONFLICTS.forEach(c => {
      if (keys.has(norm(c[0])) && keys.has(norm(c[1]))) add('bad', '标签冲突', c[2] + '（' + c[0] + ' / ' + c[1] + '）', 'rm:' + c[1]);
    });
    pos.forEach(x => { if (negKeys.has(norm(x))) add('bad', '正负重复', '「' + x + '」同时出现在正向和负面里，建议只留一边。', 'rmneg:' + x); });
    const own = new Set();
    state.sel.forEach(x => { if (own.has(x.key)) add('warn', '重复标签', '「' + x.en + '」在正向里出现了多次。', 'dup:' + x.en); own.add(x.key); });
    if (pos.length && pos.length < 4) add('warn', '标签太少', '只有 ' + pos.length + ' 个标签，画面容易失控。', '');
    if (pos.length > 70) add('warn', '标签过多', '当前 ' + pos.length + ' 个，超过 70 时靠后的词容易被忽略。', '');
    if (state.model === 'moss' && pos.length) add('tip', 'MOSS 模式', 'MOSS 更吃自然语言，右栏的「MOSS 自然语言草稿」可以直接复制使用。', '');
    if (!items.length) add('ok', '没发现问题', '结构完整，可以直接复制。', '');
    const icon = { bad: '❌', warn: '⚠️', tip: '💡', ok: '✅' };
    box.innerHTML = items.map((it, i) =>
      '<div class="check-item ' + it.lv + '">'
      + '<div class="check-title">' + icon[it.lv] + ' ' + esc(it.title) + '</div>'
      + '<div class="check-desc">' + esc(it.desc) + '</div>'
      + (it.fix ? '<button class="mini" data-checkfix="' + esc(it.fix) + '">修复</button>' : '')
      + '</div>').join('');
    const st = $('#checkStat');
    if (st) st.textContent = '正向 ' + state.sel.length + ' · 负面 ' + state.neg.length + ' · ' + items.filter(x => x.lv !== 'ok').length + ' 个待处理';
    if (!box._bound) {
      box.addEventListener('click', e => {
        const b = e.target.closest('[data-checkfix]');
        if (!b) return;
        const f = b.getAttribute('data-checkfix');
        const m = f.match(/^([a-z]+):(.*)$/);
        if (!m) return;
        const act = m[1], val = m[2];
        if (act === 'add') addTag(val, zhLookup(val), 1);
        else if (act === 'rmneg') state.neg = state.neg.filter(x => norm(x.en) !== norm(val));
        else if (act === 'rm') state.sel = state.sel.filter(x => norm(x.en) !== norm(val));
        else if (act === 'dup') { let seen = false; state.sel = state.sel.filter(x => { if (norm(x.en) !== norm(val)) return true; if (seen) return false; seen = true; return true; }); }
        renderCheck();
        renderSelected();
        renderGrid();
        save();
        toast('已修复一项，可继续体检');
      });
      box._bound = true;
    }
    return items;
  }



  function renderDiffPair(i, j) {
    const a = state.history[i], b = state.history[j];
    const box = $('#diffList');
    if (!a || !b || !box) return;
    const A = a.pos || [], B = b.pos || [];
    const ak = new Set(A.map(norm)), bk = new Set(B.map(norm));
    const onlyA = A.filter(x => !bk.has(norm(x)));
    const onlyB = B.filter(x => !ak.has(norm(x)));
    const same = A.filter(x => bk.has(norm(x))).length;
    box.innerHTML = ''
      + '<div class="diff-head">版本 A ' + A.length + ' 个 · 版本 B ' + B.length + ' 个 · 相同 ' + same + ' 个</div>'
      + (onlyA.length ? '<div class="diff-group"><div class="diff-title del">− 只在 A 里的（' + onlyA.length + '）</div><div class="diff-chips">' + onlyA.map(x => '<span class="diff-chip del">' + esc(x) + '</span>').join('') + '</div></div>' : '')
      + (onlyB.length ? '<div class="diff-group"><div class="diff-title add">＋ 只在 B 里的（' + onlyB.length + '）</div><div class="diff-chips">' + onlyB.map(x => '<span class="diff-chip add">' + esc(x) + '</span>').join('') + '</div></div>' : '')
      + (!onlyA.length && !onlyB.length ? '<div class="diff-empty">两条完全一样</div>' : '');
    const st = $('#diffStat');
    if (st) st.textContent = 'A 独有 ' + onlyA.length + ' · B 独有 ' + onlyB.length;
    openModal('modalDiff');
  }

  function renderDiff(idx) {
    const h = state.history[idx];
    const box = $('#diffList');
    if (!h || !box) return;
    const cur = state.sel.map(x => x.en);
    const old = h.pos || [];
    const ck = new Set(cur.map(norm)), ok = new Set(old.map(norm));
    const added = cur.filter(x => !ok.has(norm(x)));
    const removed = old.filter(x => !ck.has(norm(x)));
    const same = cur.filter(x => ok.has(norm(x))).length;
    document.querySelectorAll('#diffList [data-diff]').forEach(() => {});
    box.innerHTML = ''
      + '<div class="diff-head">当前 ' + cur.length + ' 个 · 该历史 ' + old.length + ' 个 · 相同 ' + same + ' 个</div>'
      + (added.length ? '<div class="diff-group"><div class="diff-title add">＋ 当前多出的（' + added.length + '）</div><div class="diff-chips">' + added.map(x => '<span class="diff-chip add">' + esc(x) + '</span>').join('') + '</div></div>' : '')
      + (removed.length ? '<div class="diff-group"><div class="diff-title del">− 历史里有、当前没有的（' + removed.length + '）</div><div class="diff-chips">' + removed.map(x => '<span class="diff-chip del">' + esc(x) + '</span>').join('') + '</div></div>' : '')
      + (!added.length && !removed.length ? '<div class="diff-empty">两边完全一样</div>' : '');
    const st = $('#diffStat');
    if (st) st.textContent = '新增 ' + added.length + ' · 移除 ' + removed.length;
    openModal('modalDiff');
  }


  /* ===== 优化包 6：MOSS 布局 JSON 生成器 ===== */
  function layCellRect(W, H, margin, gap, cols, rows, idx) {
    const cw = (W - margin * 2 - gap * (cols - 1)) / cols;
    const ch = (H - margin * 2 - gap * (rows - 1)) / rows;
    const c = idx % cols;
    const r = Math.floor(idx / cols);
    return [Math.round(margin + c * (cw + gap)), Math.round(margin + r * (ch + gap)), Math.round(cw), Math.round(ch)];
  }
  function layToCenter(W, H, x, y, w, h) {
    return [Math.round(y - H / 2), Math.round(x - W / 2), Math.round(y + h - H / 2), Math.round(x + w - W / 2)];
  }
  function genLayoutJson() {
    const out = $('#layOut');
    if (!out) return;
    const size = String($('#laySize').value || '1024x1024').split('x');
    const W = Math.max(64, parseInt(size[0], 10) || 1024);
    const H = Math.max(64, parseInt(size[1], 10) || 1024);
    const tpl = $('#layTpl').value || 'quad';
    const title = String($('#layTitle').value || '').trim();
    const sub = String($('#laySub').value || '').trim();
    const info = String($('#layInfo').value || '').trim();
    const sel = state.sel.map(x => x.en);
    const visual = sel.filter(t => {
      const c = tagCatOf(t);
      return c && c !== 'style' && c !== 'text' && c !== 'negative'
        && !/^(masterpiece|best quality|score_|safe|nsfw|explicit|highres|absurdres)/i.test(t);
    });
    const style = sel.filter(t => tagCatOf(t) === 'style');
    const charDesc = visual.length ? visual.join(', ') : 'an anime character';
    const items = [];
    const addObj = (label, caption, rect) => items.push({ label: label, caption: caption, bbox: layToCenter(W, H, rect[0], rect[1], rect[2], rect[3]) });
    const addText = (caption, text, rect) => items.push({ label: 'text', caption: caption, text: text, bbox: layToCenter(W, H, rect[0], rect[1], rect[2], rect[3]) });
    if (tpl === 'quad') {
      for (let i = 0; i < 4; i++) {
        addObj(i === 0 ? 'character' : 'object',
          'Panel ' + (i + 1) + ' of a four-panel manga page, thin black border, clean white gutter, ' + charDesc + ', different expression and gesture from the other panels',
          layCellRect(W, H, 32, 16, 2, 2, i));
      }
    } else if (tpl === 'strip') {
      for (let i = 0; i < 4; i++) {
        addObj(i === 0 ? 'character' : 'object',
          'Panel ' + (i + 1) + ' of a vertical four-panel strip, thin black border, ' + charDesc + ', different expression from the other panels',
          layCellRect(W, H, 24, 12, 1, 4, i));
      }
    } else if (tpl === 'magazine') {
      addText('Huge cream serif masthead across the top, cropped by both edges', title || 'MOSS', [0, 40, W, Math.round(H * 0.18)]);
      addObj('character', charDesc + ', three-quarter body, studio lighting, centered in the lower two thirds', [Math.round(W * 0.16), Math.round(H * 0.24), Math.round(W * 0.68), Math.round(H * 0.52)]);
      addText('Small left-aligned cover line block', sub || 'ISSUE 01', [60, Math.round(H * 0.82), Math.round(W * 0.5), Math.round(H * 0.08)]);
      if (info) addText('Tiny right-aligned issue label', info, [Math.round(W * 0.55), Math.round(H * 0.9), Math.round(W * 0.38), Math.round(H * 0.05)]);
    } else if (tpl === 'poster') {
      addText('Left-aligned bold Chinese headline, tight line spacing', title || '标题文字', [Math.round(W * 0.06), Math.round(H * 0.08), Math.round(W * 0.88), Math.round(H * 0.16)]);
      addObj('character', charDesc + ', full scene illustration, centered', [Math.round(W * 0.06), Math.round(H * 0.28), Math.round(W * 0.88), Math.round(H * 0.42)]);
      addText('Left-aligned three-line info block', sub || '时间 \\n 地点 \\n 门票', [Math.round(W * 0.06), Math.round(H * 0.76), Math.round(W * 0.5), Math.round(H * 0.16)]);
      if (info) addText('Right-aligned call to action', info, [Math.round(W * 0.58), Math.round(H * 0.82), Math.round(W * 0.36), Math.round(H * 0.1)]);
    } else {
      addObj('character', charDesc + ', full frame composition', [24, 24, W - 48, H - 48]);
    }
    const summary = (style.length ? style.join(', ') + '. ' : '') + 'Anime illustration in a clean editorial layout';
    const data = { summary: { caption: summary }, items: items, bbox_coord_space: 'abs_centralized', bbox_format: 'yxyx' };
    out.value = JSON.stringify(data);
    toast(tpl === 'quad' || tpl === 'strip'
      ? '已生成 ' + items.length + ' 个分格，画布 ' + W + '×' + H
      : '已生成 ' + items.length + ' 个元素，画布 ' + W + '×' + H);
  }


  /* ===== 统一外部库读写助手 (libraries/random_schemes, libraries/templates, libraries/presets) ===== */
  function persistLibraryItemToFolder(kind, item) {
    if (!kind || !item || !(item.id || item.key)) return;
    const base = window.__ACTIVE_SERVER_BASE__ || '';
    fetch(base + '/api/libraries/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, item })
    }).catch(() => {});
  }
  function deleteLibraryItemFromFolder(kind, id) {
    if (!kind || !id) return;
    const base = window.__ACTIVE_SERVER_BASE__ || '';
    fetch(base + '/api/libraries/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, id })
    }).catch(() => {});
  }
  function exportLibraryJsonFile(filenameBase, obj, toastText) {
    if (!obj) return;
    const payload = JSON.stringify(obj, null, 2);
    const blob = new Blob([payload], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = String(filenameBase || 'export').replace(/[\\/:*?"<>|]+/g, '_') + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (toastText) toast(toastText);
  }

  /* ===== 优化包 7：模板库（V1.3.8 升级：修复打开弹窗Bug、接入 libraries/templates/、支持导入/导出/增删改与 Ctrl+Z 撤回） ===== */
  let selectedTplId = '';
  let editTplId = '';

  function getEffectiveTpls() {
    const base = (Array.isArray(window.__EXT_TEMPLATES__) && window.__EXT_TEMPLATES__.length)
      ? window.__EXT_TEMPLATES__
      : (Array.isArray(window.PG_TPLS) ? window.PG_TPLS : []);
    const customMap = new Map();
    (Array.isArray(state.customTpls) ? state.customTpls : []).forEach(t => {
      if (t && t.id) customMap.set(t.id, t);
    });
    const delSet = new Set(Array.isArray(state.deletedTplIds) ? state.deletedTplIds : []);
    const out = [];
    base.forEach(t => {
      if (!t || !t.id || delSet.has(t.id)) return;
      out.push(customMap.has(t.id) ? customMap.get(t.id) : t);
      customMap.delete(t.id);
    });
    customMap.forEach(t => {
      if (!delSet.has(t.id)) out.push(t);
    });
    return out;
  }

  function openTplEditor(id) {
    const panel = $('#tplEdit');
    if (!panel) return;
    const isNew = !id;
    const t = isNew ? { id: '', name: '', icon: '📄', desc: '', tags: '', layout: null } : getEffectiveTpls().find(x => x.id === id);
    if (!t) return;
    editTplId = isNew ? '__new' : t.id;
    if ($('#tplEditTitle')) $('#tplEditTitle').textContent = isNew ? '＋ 新增模板' : ('✎ 编辑模板：' + t.name);
    if ($('#tplEditHint')) $('#tplEditHint').textContent = isNew ? '创建后自动保存至 libraries/templates/ 目录' : '修改后自动同步至 libraries/templates/ 目录';
    if ($('#teName')) $('#teName').value = t.name || '';
    if ($('#teIcon')) $('#teIcon').value = t.icon || '📄';
    if ($('#teDesc')) $('#teDesc').value = t.desc || '';
    if ($('#teTags')) $('#teTags').value = String(t.tags || '').split(';').filter(Boolean).join('\n');
    if ($('#teLayTpl')) $('#teLayTpl').value = (t.layout && t.layout.tpl) || '';
    if ($('#teLaySize')) $('#teLaySize').value = (t.layout && t.layout.size) || '1024x1024';
    if ($('#teDelete')) $('#teDelete').hidden = isNew;
    panel.hidden = false;
    const modalCard = $('#modalTpl .modal-card');
    if (modalCard) modalCard.classList.add('editing');
  }

  function closeTplEditor() {
    const panel = $('#tplEdit');
    if (panel) panel.hidden = true;
    const modalCard = $('#modalTpl .modal-card');
    if (modalCard) modalCard.classList.remove('editing');
    editTplId = '';
  }

  function saveTplEditor() {
    const name = ($('#teName') && $('#teName').value || '').trim();
    if (!name) { toast('请填写模板名称'); return; }
    const icon = ($('#teIcon') && $('#teIcon').value || '').trim() || '📄';
    const desc = ($('#teDesc') && $('#teDesc').value || '').trim();
    const rawLines = ($('#teTags') && $('#teTags').value || '').split(/[\r\n;,，]+/).map(s => s.trim()).filter(Boolean);
    const normPairs = rawLines.map(line => {
      if (line.indexOf('|') >= 0) return line;
      const zh = zhLookup(line) || '';
      return zh ? (line + '|' + zh) : (line + '|');
    }).join(';');
    const layTpl = ($('#teLayTpl') && $('#teLayTpl').value) || '';
    const laySize = ($('#teLaySize') && $('#teLaySize').value) || '1024x1024';
    const layout = layTpl ? { tpl: layTpl, size: laySize, title: name, sub: '', info: '' } : null;

    const isNew = !(editTplId && editTplId !== '__new');
    recordHistorySnapshot((isNew ? '新增模板: ' : '编辑模板: ') + name);

    if (!Array.isArray(state.customTpls)) state.customTpls = [];
    if (!Array.isArray(state.deletedTplIds)) state.deletedTplIds = [];
    const targetId = isNew ? ('tpl_custom_' + Date.now().toString(36)) : editTplId;
    const newObj = { id: targetId, name, icon, desc, tags: normPairs, layout };
    const exIdx = state.customTpls.findIndex(x => x && x.id === targetId);
    if (exIdx >= 0) state.customTpls[exIdx] = newObj;
    else state.customTpls.push(newObj);
    state.deletedTplIds = state.deletedTplIds.filter(x => x !== targetId);
    selectedTplId = targetId;
    persistLibraryItemToFolder('templates', newObj);
    save();
    closeTplEditor();
    renderTplModal();
    toast('✅ 已保存模板「' + name + '」至 libraries/templates/');
  }

  function deleteTplById(id) {
    const t = getEffectiveTpls().find(x => x.id === id);
    if (!t) return;
    askConfirmModal(`确定删除模板「${t.name}」吗？（可按 Ctrl+Z 撤销，内置模板也可点「恢复默认」找回）`, () => {
      recordHistorySnapshot('删除模板: ' + t.name);
      if (!Array.isArray(state.deletedTplIds)) state.deletedTplIds = [];
      if (state.deletedTplIds.indexOf(id) < 0) state.deletedTplIds.push(id);
      if (Array.isArray(state.customTpls)) state.customTpls = state.customTpls.filter(x => x && x.id !== id);
      if (selectedTplId === id) selectedTplId = '';
      if (editTplId === id) closeTplEditor();
      deleteLibraryItemFromFolder('templates', id);
      save();
      renderTplModal();
      toast('🗑 已删除模板「' + t.name + '」（可按 Ctrl+Z 撤销）');
    });
  }

  function renderTplModal() {
    const box = $('#tplGrid');
    if (!box) return;
    const list = getEffectiveTpls();
    const st = $('#tplStat');
    if (st) st.textContent = list.length + ' 个模板 · 左键选中，右键可编辑/导出/删除，点「套用」直接加入提示词';
    if (selectedTplId && !list.some(x => x.id === selectedTplId)) selectedTplId = '';

    box.innerHTML = list.map(t => {
      const selCls = (selectedTplId === t.id) ? ' selected' : '';
      return '<div class="tpl-card' + selCls + '" data-tpl-card="' + esc(t.id) + '" title="左键选中 · 右键可编辑、导出或删除此模板">'
      + '<div class="tpl-head"><b>' + (t.icon || '📄') + ' ' + esc(t.name) + '</b></div>'
      + '<p class="tpl-desc">' + esc(t.desc || '') + '</p>'
      + '<div class="tpl-meta">' + String(t.tags || '').split(';').filter(Boolean).length + ' 个标签 · '
      + (t.layout ? esc(t.layout.tpl) + ' · ' + esc(t.layout.size) : '无布局') + '</div>'
      + '<div class="tpl-actions">'
      + '<button type="button" class="mini" data-tpl="' + esc(t.id) + '">套用</button>'
      + (t.layout ? '<button type="button" class="mini primary" data-tpl-layout="' + esc(t.id) + '">套用+布局</button>' : '')
      + '<button type="button" class="mini" data-tpl-edit="' + esc(t.id) + '" title="编辑模板">✎</button>'
      + '<button type="button" class="mini danger" data-tpl-del="' + esc(t.id) + '" title="删除模板">🗑</button>'
      + '</div></div>';
    }).join('');

    if (!box._bound) {
      const bindEl = (sel, ev, fn) => { const n = $(sel); if (n) n.addEventListener(ev, fn); };
      box.addEventListener('click', e => {
        const l = e.target.closest('[data-tpl-layout]');
        if (l) { applyTpl(l.getAttribute('data-tpl-layout'), true); return; }
        const b = e.target.closest('[data-tpl]');
        if (b) { applyTpl(b.getAttribute('data-tpl'), false); return; }
        const ed = e.target.closest('[data-tpl-edit]');
        if (ed) { openTplEditor(ed.getAttribute('data-tpl-edit')); return; }
        const dl = e.target.closest('[data-tpl-del]');
        if (dl) { deleteTplById(dl.getAttribute('data-tpl-del')); return; }
        const card = e.target.closest('[data-tpl-card]');
        if (card) {
          const cid = card.getAttribute('data-tpl-card');
          selectedTplId = (selectedTplId === cid) ? '' : cid;
          renderTplModal();
        }
      });
      box.addEventListener('contextmenu', e => {
        const card = e.target.closest('[data-tpl-card]');
        if (!card) return;
        e.preventDefault();
        e.stopPropagation();
        const tid = card.getAttribute('data-tpl-card');
        const tObj = getEffectiveTpls().find(x => x.id === tid);
        if (!tObj) return;
        selectedTplId = tid;
        renderTplModal();
        placeContextMenu(e.clientX, e.clientY, `
          <div class="ctx-menu-head">📄 模板：${esc(tObj.name)}</div>
          <button type="button" data-ctx-tpl="apply" data-tid="${esc(tid)}">📋 套用此模板</button>
          <button type="button" data-ctx-tpl="edit" data-tid="${esc(tid)}">✎ 编辑模板</button>
          <button type="button" data-ctx-tpl="export" data-tid="${esc(tid)}">📤 导出模板 (.json)</button>
          <button type="button" class="danger" data-ctx-tpl="delete" data-tid="${esc(tid)}">🗑 删除模板</button>
        `);
      });
      bindEl('#btnTplNew', 'click', () => openTplEditor(''));
      bindEl('#btnTplImport', 'click', () => {
        const fi = $('#fileImportTpl');
        if (!fi) return;
        fi.value = '';
        fi.onchange = async ev => {
          const file = ev.target.files && ev.target.files[0];
          if (!file) return;
          try {
            const parsed = JSON.parse(await file.text());
            const listIn = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.templates) ? parsed.templates : [parsed]);
            let added = 0;
            if (!Array.isArray(state.customTpls)) state.customTpls = [];
            if (!Array.isArray(state.deletedTplIds)) state.deletedTplIds = [];
            recordHistorySnapshot('导入模板文件');
            listIn.forEach(raw => {
              if (!raw || typeof raw !== 'object' || !raw.name) return;
              const nid = raw.id ? String(raw.id) : ('tpl_imp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5));
              const newObj = {
                id: nid,
                name: String(raw.name).trim(),
                icon: raw.icon || '📄',
                desc: raw.desc || '',
                tags: Array.isArray(raw.tags) ? raw.tags.join(';') : String(raw.tags || ''),
                layout: raw.layout || null
              };
              const idx = state.customTpls.findIndex(x => x && x.id === nid);
              if (idx >= 0) state.customTpls[idx] = newObj;
              else state.customTpls.push(newObj);
              state.deletedTplIds = state.deletedTplIds.filter(x => x !== nid);
              persistLibraryItemToFolder('templates', newObj);
              added++;
            });
            if (added > 0) {
              save();
              renderTplModal();
              toast('📥 成功导入 ' + added + ' 个模板并保存至 libraries/templates/');
            } else {
              toast('未检测到有效的模板 JSON');
            }
          } catch (err) {
            toast('导入失败：模板 JSON 格式无效');
          }
        };
        fi.click();
      });
      bindEl('#btnTplReset', 'click', () => {
        askConfirmModal('确定恢复所有内置模板吗？（你新增的自定义模板会保留）', () => {
          recordHistorySnapshot('恢复内置默认模板');
          state.deletedTplIds = [];
          const builtinList = Array.isArray(window.PG_TPLS) ? window.PG_TPLS : [];
          const builtinIds = new Set(builtinList.map(x => x.id));
          state.customTpls = (state.customTpls || []).filter(x => x && !builtinIds.has(x.id));
          builtinList.forEach(bt => persistLibraryItemToFolder('templates', { ...bt, builtin: true }));
          save();
          renderTplModal();
          toast('已恢复所有内置模板');
        });
      });
      bindEl('#teSave', 'click', saveTplEditor);
      bindEl('#teCancel', 'click', closeTplEditor);
      bindEl('#teBack', 'click', closeTplEditor);
      bindEl('#teDelete', 'click', () => { if (editTplId && editTplId !== '__new') deleteTplById(editTplId); });
      bindEl('#teFromSel', 'click', () => {
        const lines = (state.sel || []).map(it => it.en + '|' + (it.zh || zhLookup(it.en) || ''));
        if ($('#teTags')) $('#teTags').value = lines.join('\n');
        toast('已填入当前右侧 ' + lines.length + ' 个已选提示词');
      });
      box._bound = true;
    }
  }
  function applyTpl(id, withLayout) {
    const t = getEffectiveTpls().find(x => x.id === id);
    if (!t) return;
    recordHistorySnapshot('套用模板: ' + t.name);
    let n = 0;
    String(t.tags || '').split(';').forEach(pair => {
      const i = pair.indexOf('|');
      if (i < 0) return;
      const en = pair.slice(0, i).trim(), zh = pair.slice(i + 1).trim();
      if (addTag(en, zh || zhLookup(en), 1)) n++;
    });
    state.mode = 'pos';
    syncModeSeg();
    renderSelected();
    renderGrid();
    save();
    if (withLayout && t.layout) {
      $('#layTpl').value = t.layout.tpl || 'single';
      $('#laySize').value = t.layout.size || '1024x1024';
      $('#layTitle').value = t.layout.title || '';
      $('#laySub').value = t.layout.sub || '';
      $('#layInfo').value = t.layout.info || '';
      closeModal('modalTpl');
      genLayoutJson();
      openModal('modalLayout');
      toast('已套用「' + t.name + '」，布局 JSON 也生成好了（可按 Ctrl+Z 撤销）');
      return;
    }
    closeModal('modalTpl');
    toast('已套用模板「' + t.name + '」，新增 ' + n + ' 个标签（可按 Ctrl+Z 撤销）');
  }


  /* ===== 优化包 9：帮助 / 最近角色 / 渐进渲染 ===== */
  function touchRecentChar(key) {
    if (!key) return;
    const c = findCharByKeyOrTag(key);
    const canonicalKey = c ? c.key : key;
    const targetTag = c ? norm(c.tag) : '';
    state.recentChars = [canonicalKey].concat((state.recentChars || []).filter(k => k !== key && k !== canonicalKey && (!targetTag || norm(k) !== targetTag))).slice(0, 40);
  }


  /* ===== 反向标签生成 ===== */
  const NEG_RULES = [
    [['1girl'], ['1boy', 'male']],
    [['1boy'], ['1girl', 'female']],
    [['solo'], ['multiple girls', 'multiple boys', '2girls', '2boys']],
    [['multiple girls', '2girls', '2boys', 'multiple boys'], ['solo']],
    [['day'], ['night']],
    [['night'], ['day']],
    [['indoors'], ['outdoors']],
    [['outdoors'], ['indoors']],
    [['summer'], ['winter']],
    [['winter'], ['summer']],
    [['full body'], ['close-up']],
    [['close-up'], ['full body']],
    [['from above'], ['from below']],
    [['from below'], ['from above']],
    [['looking at viewer'], ['looking away']],
    [['looking away'], ['looking at viewer']],
    [['closed eyes'], ['open eyes']],
    [['open eyes'], ['closed eyes']],
    [['long hair'], ['short hair']],
    [['short hair'], ['long hair']],
    [['open mouth'], ['closed mouth']],
    [['closed mouth'], ['open mouth']],
    [['smile'], ['crying', 'sad']],
    [['standing'], ['sitting', 'lying']],
    [['sitting'], ['standing']],
    [['lying'], ['standing']],
    [['front view'], ['from behind']],
    [['from behind'], ['front view']],
    [['portrait'], ['full body']],
    [['upper body'], ['full body']]
  ];

  const NEG_HUMAN = ['bad anatomy', 'bad hands', 'poorly drawn hands', 'missing fingers', 'extra fingers', 'fused fingers', 'too many fingers', 'mutated hands', 'deformed hands', 'bad feet', 'extra toes', 'missing toes', 'fused toes', 'bad teeth', 'poorly drawn face', 'bad face', 'deformed face', 'asymmetric eyes', 'cross-eyed', 'bad eyes', 'extra eyes', 'missing eyes', 'extra ears', 'missing ears', 'long neck', 'twisted body', 'disfigured', 'floating limbs', 'disconnected limbs', 'malformed limbs', 'missing arms', 'missing legs', 'extra arms', 'extra legs', 'extra heads', 'two heads', 'missing head', 'wrong anatomy', 'bad proportions'];
  const NEG_CORE = ['lowres', 'worst quality', 'low quality', 'blurry', 'jpeg artifacts', 'bad anatomy', 'bad hands', 'missing fingers', 'extra fingers', 'mutated hands', 'poorly drawn face', 'watermark', 'signature', 'logo', 'username', 'cropped', 'out of frame', 'bad proportions', 'extra limbs'];
  const NEG_COMPOSE = ['bad composition', 'bad perspective', 'multiple views', 'multiple panels', 'border', 'frame', 'white border', 'letterboxed', 'cluttered', 'messy'];
  const NEG_TEXT = ['text', 'subtitles', 'caption', 'text box', 'ui', 'watermark', 'signature', 'username', 'logo', 'web address', 'timestamp', 'dated', 'patreon'];
  const NEG_LIGHT = ['overexposed', 'underexposed', 'harsh lighting', 'harsh shadow', 'bad shadow', 'bloom', 'vignetting', 'lens flare'];
  const NEG_QUALITY = ['lowres', 'worst quality', 'low quality', 'less detailed', 'unfinished', 'sketch', 'rough sketch', 'washed out', 'oversaturated', 'undersaturated', 'noise', 'grain', 'pixelated', 'compression artifacts', 'chromatic aberration', 'motion blur', 'smudged', 'low contrast'];
  const STYLE_GUARDS = [
    { when: /watercolor|gouache|ink wash|sumi-e|painterly|visible brushstrokes|paper texture|storybook|picture book/i,
      drop: ['grain', 'noise', 'smudged', 'less detailed', 'low contrast', 'washed out', 'pixelated', 'compression artifacts', 'sketch', 'rough sketch', 'unfinished', 'aliasing', 'blurry', 'smudged'] },
    { when: /pixel art|pixelated|8-bit|16-bit|retro game|voxel/i,
      drop: ['pixelated', 'aliasing', 'noise', 'grain', 'compression artifacts', 'motion blur'] },
    { when: /sketch|rough sketch|lineart|clean lineart|monochrome|sumi-e/i,
      drop: ['sketch', 'rough sketch', 'unfinished', 'less detailed', 'low contrast', 'washed out', 'smudged'] },
    { when: /film|vintage|retro|analog|35mm|polaroid|disposable camera|film grain/i,
      drop: ['grain', 'noise', 'chromatic aberration', 'vignetting', 'lens flare', 'motion blur', 'compression artifacts', 'jpeg artifacts'] },
    { when: /flat color|flat design|minimalist|vector art|graphic design|print design/i,
      drop: ['flat color', 'less detailed', 'low contrast', 'washed out', 'noise', 'grain', 'smudged', 'oversaturated'] },
    { when: /high contrast|vivid colors|saturated|neon|glowing/i,
      drop: ['oversaturated', 'low contrast', 'washed out', 'undersaturated', 'desaturated'] },
    { when: /3d|octane|blender|render|cgi|claymation/i,
      drop: ['cluttered', 'messy', 'noise', 'grain'] },
    { when: /cyberpunk|science fiction|steampunk|post-apocalyptic/i,
      drop: ['cluttered', 'messy'] }
  ];

  const NEG_BY_CAT = {
    base: NEG_HUMAN, body: NEG_HUMAN, hair: NEG_HUMAN, face: NEG_HUMAN,
    expression: ['poorly drawn face', 'bad face', 'deformed face', 'bad eyes', 'asymmetric eyes', 'cross-eyed'],
    pose: NEG_HUMAN,
    props: ['bad hands', 'poorly drawn hands', 'extra fingers', 'missing fingers'],
    environment: ['bad composition', 'bad perspective', 'out of frame', 'cropped'],
    weather: ['bad composition', 'bad perspective'],
    lighting: NEG_LIGHT,
    camera: NEG_COMPOSE,
    composition: NEG_COMPOSE,
    style: NEG_QUALITY,
    text: NEG_TEXT,
    clothing: ['bad hands'],
    accessory: ['bad hands'],
    monster: ['bad anatomy', 'wrong anatomy', 'alien anatomy', 'body horror'],
    moss: ['bad anatomy', 'bad hands', 'poorly drawn face']
  };
  const NEG_EXTRA = ['lowres', 'less detailed', 'unfinished', 'sketch', 'rough sketch', 'washed out', 'oversaturated', 'undersaturated', 'noise', 'grain', 'pixelated', 'compression artifacts', 'chromatic aberration', 'motion blur', 'smudged', 'low contrast', 'oversaturated', 'bad composition', 'bad perspective', 'multiple views', 'multiple panels', 'border', 'frame', 'white border', 'letterboxed', 'cluttered', 'messy', 'subtitles', 'caption', 'text box', 'ui', 'web address', 'timestamp', 'dated', 'patreon', 'overexposed', 'underexposed', 'harsh lighting', 'harsh shadow', 'bad shadow', 'bloom', 'vignetting', 'lens flare', 'extra arms', 'extra legs', 'missing arms', 'missing legs', 'malformed limbs', 'floating limbs', 'disconnected limbs', 'extra heads', 'two heads', 'missing head', 'bad feet', 'extra toes', 'missing toes', 'fused toes', 'bad teeth', 'extra eyes', 'missing eyes', 'extra ears', 'missing ears', 'twisted body', 'disfigured', 'wrong anatomy', 'aliasing', 'color banding', 'sharpening artifacts', 'double image', 'distorted', 'scan artifacts'];

  function negFromPositive(full) {
    if (!state.sel.length) { toast('先选几个正向标签'); return; }
    const cfg = modelCfg();
    const posSet = new Set(state.sel.map(x => norm(x.en)));
    const nsfwPos = posSet.has('nsfw') || posSet.has('explicit') || posSet.has('sensitive');
    /* 画风守卫：正向用了某画风时，负面不要再压制该画风的特征（例如水彩时不加 grain/noise/sketch） */
    const posText = state.sel.map(x => String(x.en || '').toLowerCase()).join(', ');
    const dropSet = new Set();
    STYLE_GUARDS.forEach(g => {
      if (g.when.test(posText)) g.drop.forEach(x => dropSet.add(norm(x)));
    });
    /* 生成前先清空负面列表，避免旧反向词越堆越多 */
    state.neg = [];
    const negSet = new Set();
    const added = [];
    const add = en => {
      const k = norm(en);
      if (!k || posSet.has(k) || negSet.has(k) || dropSet.has(k)) return;
      if (nsfwPos && /^(nsfw|explicit|sensitive|safe|questionable|general)$/i.test(k)) return;
      negSet.add(k);
      added.push({ key: k, en: String(en).trim(), zh: zhLookup(en), w: 1 });
    };

    /* 1) 模型官方负向基线 */
    String(cfg.negative || '').split(',').forEach(t => add(t.trim()));

    /* 2) 通用核心负向 */
    NEG_CORE.forEach(add);

    /* 3) 按正向标签分类主题映射 */
    const seenCat = new Set();
    state.sel.forEach(it => {
      const cid = tagCatOf(it.en) || 'extra';
      if (seenCat.has(cid)) return;
      seenCat.add(cid);
      (NEG_BY_CAT[cid] || []).forEach(add);
    });
    if (state.chars.length) NEG_HUMAN.forEach(add);

    /* 4) 冲突表双向补 */
    CONFLICTS.forEach(c => {
      if (posSet.has(norm(c[0])) && !posSet.has(norm(c[1]))) add(c[1]);
      else if (posSet.has(norm(c[1])) && !posSet.has(norm(c[0]))) add(c[0]);
    });

    /* 5) 语义规则对 */
    NEG_RULES.forEach(pair => {
      if (pair[0].some(a => posSet.has(norm(a)))) pair[1].forEach(add);
    });

    /* 6) 质量词反推 */
    if (posSet.has('masterpiece') || posSet.has('best quality')) {
      ['worst quality', 'low quality', 'score_1', 'score_2', 'score_3'].forEach(add);
    }

    /* 7) 全量模式补齐 */
    if (full) NEG_EXTRA.forEach(add);

    if (!added.length) { toast('反向已覆盖，无需补充'); return; }
    state.neg = added;
    state.mode = 'neg';
    syncModeSeg();
    renderSelected();
    renderOutput();
    save();
    toast('已清空负面并生成 ' + added.length + ' 个反向标签' + (full ? '（全量）' : '') + (dropSet.size ? '，已按画风避开 ' + dropSet.size + ' 个冲突词' : ''));
  }


  /* ===== 一键清空正反提示词 ===== */
  function clearAllPrompts() {
    const has = state.sel.length || state.neg.length || (state.chars || []).length;
    if (!has) { toast('正向和负面列表已经是空的'); return; }
    askConfirmModal('确定清空全部正向和负面提示词吗？（含已套用角色，可按 Ctrl+Z 撤销）', () => {
      recordHistorySnapshot(`清空全部已选 (${state.sel.length + state.neg.length} 项)`);
      state.sel = [];
      state.neg = [];
      state.chars = [];
      stateCharTags = [];
      state.mode = 'pos';
      syncModeSeg();
      renderAll();
      renderOutput();
      save();
      toast('已清空正向和负面提示词（可按 Ctrl+Z 撤销）');
    });
  }

  function initOptimize() {
    const bh = $('#btnHistory');
    if (bh) bh.addEventListener('click', () => { renderHistory(); openModal('modalHistory'); });
    const bc = $('#btnHistoryClear');
    if (bc) bc.addEventListener('click', () => {
      if (!state.history.length) return;
      recordHistorySnapshot(`清空提示词历史 (${state.history.length} 条)`);
      state.history = [];
      state.histPick = [];
      renderHistory();
      save();
      toast('已清空提示词历史');
    });
    const bm = $('#btnMossCopy');
    if (bm) bm.addEventListener('click', () => {
      const t = $('#mossText');
      if (t && t.value) copyText(t.value);
    });
    const br = $('#btnCharRandom');
    if (br) br.addEventListener('click', () => {
      const pool = CHARS.filter(c => !state.chars.some(x => x.key === c.key));
      if (!pool.length) { toast('角色库都套用过了'); return; }
      const pick = pool[Math.floor(Math.random() * pool.length)];
      applyCharacter(pick.key);
    });
    const bhelp = $('#btnHelp');
    if (bhelp) bhelp.addEventListener('click', () => openModal('modalHelp'));
    const btpl = $('#btnTpl');
    if (btpl) btpl.addEventListener('click', () => { closeTplEditor(); renderTplModal(); openModal('modalTpl'); });
    const bca2 = $('#btnClearAll');
    if (bca2) bca2.addEventListener('click', clearAllPrompts);
    const bna = $('#btnNegAuto');
    if (bna) bna.addEventListener('click', e => negFromPositive(!!e.shiftKey));
    const blay = $('#btnLayout');
    if (blay) blay.addEventListener('click', () => { openModal('modalLayout'); genLayoutJson(); });
    const blg = $('#btnLayGen');
    if (blg) blg.addEventListener('click', genLayoutJson);
    const blc = $('#btnLayCopy');
    if (blc) blc.addEventListener('click', () => { const o = $('#layOut'); if (o && o.value) copyText(o.value); });
    const mt = $('#mossTpl');
    if (mt) mt.addEventListener('change', updateMossCaption);
    
    const bws = $('#btnWeightSyntax');
    const syncWeightSyntaxBtnUI = () => {
      if (!bws) return;
      const syn = state.syntax || 'sd';
      if (syn === 'nai') {
        bws.textContent = '⚖ NovelAI';
        bws.title = '当前权重语法：NovelAI {tag} / [tag]（点击切换至 Anima）';
      } else if (syn === 'anima') {
        bws.textContent = '⚖ Anima';
        bws.title = '当前权重语法：Anima (tag:1.2)（点击切换至 WebUI）';
      } else {
        bws.textContent = '⚖ WebUI';
        bws.title = '当前权重语法：WebUI (tag:1.2)（点击切换至 NovelAI）';
      }
    };
    syncWeightSyntaxBtnUI();
    if (bws) {
      bws.addEventListener('click', () => {
        const order = ['sd', 'nai', 'anima'];
        const curIdx = order.indexOf(state.syntax || 'sd');
        state.syntax = order[(curIdx + 1) % order.length];
        syncWeightSyntaxBtnUI();
        renderOutput();
        save();
        const names = { sd: 'WebUI (tag:1.2)', nai: 'NovelAI {tag}', anima: 'Anima (tag:1.2)' };
        toast('⚖ 已切换权重语法：' + (names[state.syntax] || state.syntax));
      });
    }
    const bfix = $('#btnCheckFixAll');
    if (bfix) bfix.addEventListener('click', () => {
      const items = renderCheck() || [];
      items.forEach(it => {
        const f = it.fix || '';
        const m = f.match(/^([a-z]+):(.*)$/);
        if (!m) return;
        if (m[1] === 'add') addTag(m[2], zhLookup(m[2]), 1);
        else if (m[1] === 'rmneg') state.neg = state.neg.filter(x => norm(x.en) !== norm(m[2]));
        else if (m[1] === 'rm') state.sel = state.sel.filter(x => norm(x.en) !== norm(m[2]));
        else if (m[1] === 'dup') { let seen = false; state.sel = state.sel.filter(x => { if (norm(x.en) !== norm(m[2])) return true; if (seen) return false; seen = true; return true; }); }
      });
      renderCheck(); renderSelected(); renderGrid(); save();
    });
    const bca = $('#btnComboApply');
    if (bca) bca.addEventListener('click', applyPresetCombo);
    const bcc = $('#btnComboClear');
    if (bcc) bcc.addEventListener('click', () => { presetPick = []; renderPresetModal(); });
    updateMossCaption();
    document.addEventListener('keydown', e => {
      const meta = e.ctrlKey || e.metaKey;
      const tag = (e.target && e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable);
      if (meta && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        const s = $('#search');
        if (s) { s.focus(); s.select(); }
        return;
      }
      if (meta && e.key === 'Enter') {
        e.preventDefault();
        const b = $('#btnCopy');
        if (b) b.click();
        return;
      }
      /* Escape handled centrally in unified top-layer keydown listener */
    });
  }

  function otherList() { return state.mode === 'pos' ? state.neg : state.sel; }

  function selectedSet() {
    const s = new Set();
    currentList().forEach(i => {
      s.add(i.key);
      s.add(norm(cleanArtistEn(i.en)));
    });
    return s;
  }

  function visibleMajors() {
    return MAJORS.map(m => ({
      ...m,
      children: (m.children || []).filter(catVisible)
    }));
  }

  /* ===== 2.0 角色库图片管理（子文件夹 img/ 读写，命名：一级_二级_英文名称，如 game_genshin impact_lisa） ===== */
  const CHAR_IMG_MEM = new Map(); // baseName(lower) -> imgSrc (url or dataUrl)
  const CHAR_IMG_DB_NAME = 'pg_char_img_db_v2';
  let _charImgDbPromise = null;
  let _uploadingCharKey = '';

  function getCharImgDb() {
    if (_charImgDbPromise) return _charImgDbPromise;
    _charImgDbPromise = new Promise(resolve => {
      try {
        const req = indexedDB.open(CHAR_IMG_DB_NAME, 1);
        req.onupgradeneeded = e => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('imgs')) db.createObjectStore('imgs');
        };
        req.onsuccess = e => resolve(e.target.result);
        req.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
    return _charImgDbPromise;
  }

  async function loadCharImgCacheFromIdb() {
    if (window.__EXT_CHAR_IMGS__ && typeof window.__EXT_CHAR_IMGS__ === 'object') {
      Object.keys(window.__EXT_CHAR_IMGS__).forEach(k => {
        CHAR_IMG_MEM.set(String(k).toLowerCase(), window.__EXT_CHAR_IMGS__[k]);
      });
    }
    const fs = window.PG_TAG_FS;
    const base = (fs && fs.serverBase) || '';
    if (base || (typeof location !== 'undefined' && /^https?:$/.test(location.protocol))) {
      try {
        const r = await fetch((base || '') + '/api/char-img/list');
        if (r.ok) {
          const d = await r.json();
          if (d && d.ok && d.map) {
            Object.keys(d.map).forEach(k => CHAR_IMG_MEM.set(String(k).toLowerCase(), d.map[k]));
          }
        }
      } catch (e) {}
    }
    const db = await getCharImgDb();
    if (!db) return;
    await new Promise(resolve => {
      try {
        const tx = db.transaction('imgs', 'readonly');
        const store = tx.objectStore('imgs');
        const req = store.openCursor();
        req.onsuccess = e => {
          const cursor = e.target.result;
          if (cursor) {
            const k = String(cursor.key).toLowerCase();
            if (!CHAR_IMG_MEM.has(k) && cursor.value) CHAR_IMG_MEM.set(k, cursor.value);
            cursor.continue();
          } else {
            resolve();
          }
        };
        req.onerror = () => resolve();
      } catch (e) {
        resolve();
      }
    });
  }

  async function saveCharImgToIdb(baseName, dataUrl) {
    const k = String(baseName || '').toLowerCase();
    if (!k) return;
    if (dataUrl) CHAR_IMG_MEM.set(k, dataUrl);
    else CHAR_IMG_MEM.delete(k);
    const db = await getCharImgDb();
    if (!db) return;
    try {
      const tx = db.transaction('imgs', 'readwrite');
      const store = tx.objectStore('imgs');
      if (dataUrl) store.put(dataUrl, k);
      else store.delete(k);
    } catch (e) {}
  }

  function getCharLevel1Prefix(c) {
    if (!c) return 'game';
    const mid = String(c.majorId || '').toLowerCase();
    if (mid === 'games' || mid === 'game') return 'game';
    if (mid === 'anime') return 'anime';
    if (mid === 'vtuber') return 'vtuber';
    const gm = String(c.game || '');
    if (gm === 'hololive') return 'vtuber';
    if (['明日方舟','原神','崩坏：星穹铁道','鸣潮','蔚蓝档案','王者荣耀','BanG Dream!','Love Live!','偶像大师','东方Project','Fate','碧蓝航线','赛马娘','崩坏3','妮姬','绝区零','少女前线','VOCALOID','Girls Band Cry','公主连结','战双帕弥什','其他游戏'].indexOf(gm) >= 0) return 'game';
    return 'anime';
  }

  function getCharImgBaseName(c) {
    if (!c) return '';
    const l1 = getCharLevel1Prefix(c);
    const rawL2 = String(c.gameTag || (c.subId ? String(c.subId).replace(/_/g, ' ') : '') || c.game || 'default').trim().toLowerCase();
    const l2 = rawL2.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'default';
    const rawEn = String(c.tag || '').replace(/\\([()\[\]])/g, '$1').replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
    const enName = rawEn.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'character';
    return `${l1}_${l2}_${enName}`;
  }

  function hydrateCharCardImages() {
    if (!el.grid) return;
    const cards = el.grid.querySelectorAll('.char-big-card[data-char-img-base]');
    cards.forEach(card => {
      const baseName = card.getAttribute('data-char-img-base') || '';
      if (!baseName) return;
      const key = baseName.toLowerCase();
      const imgEl = card.querySelector('.cbc-img');
      const phEl = card.querySelector('.cbc-placeholder');
      if (!imgEl) return;

      const applySrc = src => {
        imgEl.src = src;
        imgEl.hidden = false;
        if (phEl) phEl.hidden = true;
      };

      if (CHAR_IMG_MEM.has(key)) {
        applySrc(CHAR_IMG_MEM.get(key));
        return;
      }
      if (key.startsWith('anime_')) {
        const lastUs = key.lastIndexOf('_');
        const fallbackAnimeKey = lastUs > 6 ? ('anime_anime_' + key.slice(lastUs + 1)) : '';
        if (fallbackAnimeKey && CHAR_IMG_MEM.has(fallbackAnimeKey)) {
          applySrc(CHAR_IMG_MEM.get(fallbackAnimeKey));
          return;
        }
      }

      // 自动探测子文件夹 img/ 下是否存在对应命名图片 (默认无图片，下次点击自动读取 img 图片)
      const encoded = encodeURIComponent(baseName);
      const exts = ['.png', '.jpg', '.webp', '.jpeg'];
      let idx = 0;
      const tryNext = () => {
        if (idx >= exts.length) return;
        const candidate = 'img/' + encoded + exts[idx++];
        const probe = new Image();
        probe.onload = () => {
          CHAR_IMG_MEM.set(key, candidate);
          applySrc(candidate);
        };
        probe.onerror = tryNext;
        probe.src = candidate;
      };
      tryNext();
    });
  }

  async function handleCharImgUpload(charKey, file) {
    const c = CHARS.find(x => x.key === charKey);
    if (!c || !file) return;
    if (!/^image\//i.test(file.type || '') && !/\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name || '')) {
      toast('请选择有效的图片文件');
      return;
    }
    const baseName = getCharImgBaseName(c);
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const im = new Image();
        im.onload = () => {
          const maxSide = 720;
          let w = im.naturalWidth || im.width || 400;
          let h = im.naturalHeight || im.height || 400;
          const sc = Math.min(1, maxSide / Math.max(w, h));
          w = Math.max(1, Math.round(w * sc));
          h = Math.max(1, Math.round(h * sc));
          const cv = document.createElement('canvas');
          cv.width = w;
          cv.height = h;
          const ctx = cv.getContext('2d');
          ctx.drawImage(im, 0, 0, w, h);
          URL.revokeObjectURL(url);
          resolve(cv.toDataURL('image/png'));
        };
        im.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error('图片读取失败'));
        };
        im.src = url;
      });

      await saveCharImgToIdb(baseName, dataUrl);

      let savedToDisk = false;
      const fs = window.PG_TAG_FS;
      const serverBase = (fs && fs.serverBase) || '';
      const basesToTry = [];
      if (serverBase) basesToTry.push(serverBase);
      if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) basesToTry.push(location.origin);
      basesToTry.push((window.__ACTIVE_SERVER_BASE__ || (typeof location !== 'undefined' && /^https?:$/.test(location.protocol) ? location.origin : 'http://127.0.0.1:18177')));

      for (const b of basesToTry) {
        try {
          const r = await fetch(b + '/api/char-img', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'save', baseName, dataUrl, preferPng: true })
          });
          if (r.ok) {
            const d = await r.json();
            if (d && d.ok) {
              savedToDisk = true;
              if (d.path) CHAR_IMG_MEM.set(baseName.toLowerCase(), d.path + '?t=' + Date.now());
              break;
            }
          }
        } catch (e) {}
      }

      renderGrid();
      toast(savedToDisk
        ? `已保存图片至 img/${baseName}.png`
        : `已保存图片「${baseName}.png」（本机已缓存，开启服务自动写入 img/）`);
    } catch (err) {
      toast(String((err && err.message) || err));
    }
  }

  function charBigCardHTML(c, opts = {}) {
    const isOn = state.chars.some(x => x.key === c.key);
    const isFav = isFavChar(c.key);
    const hit = state.highlight && state.highlight.has(norm(c.tag));
    const baseName = getCharImgBaseName(c);
    const cachedSrc = CHAR_IMG_MEM.get(baseName.toLowerCase()) || '';
    const firstChar = String(c.name || c.tag || '角').trim().charAt(0);
    const listMode = opts.listMode || '';
    const removeBtn = listMode === 'recent_char'
      ? `<button type="button" class="cbc-remove-btn" data-del-char-recent="${esc(c.key)}" title="从最近角色中移除「${esc(c.name)}」">×</button>`
      : (listMode === 'fav_char'
        ? `<button type="button" class="cbc-remove-btn" data-del-char-fav="${esc(c.key)}" title="从收藏角色中移除「${esc(c.name)}」">×</button>`
        : '');
    const allPrompts = (c.tag ? [{ en: c.tag, zh: c.charZh || c.name || '', main: true }] : []).concat(
      (c.auto || []).map(a => ({ en: a.en, zh: a.zh || zhLookup(a.en) || '', main: false }))
    );
    const promptsHtml = allPrompts.map(p =>
      `<span class="cbc-prompt-pill${p.main ? ' main-tag' : ''}" data-en="${esc(p.en)}">${esc(p.en)}${(state.showZh && p.zh) ? `<span class="p-zh">(${esc(p.zh)})</span>` : ''}</span>`
    ).join('');
    const hoverTip = getCharHoverTip(c);
    const showCharNew = Boolean(c && c.isNew && !(state.seenNewCharsSet && state.seenNewCharsSet.has(c.key)));
    const charNewDot = showCharNew ? '<span class="char-new-dot" title="新增或修改过设定的角色"></span>' : '';
    return `<div class="char-big-card${isOn ? ' on' : ''}${hit ? ' locate-flash' : ''}" data-char="${esc(c.key)}" data-char-img-base="${esc(baseName)}" data-hover-tip="${esc(hoverTip)}" title="${esc(hoverTip)}">
      ${charNewDot}
      <div class="cbc-img-box">
        ${isOn ? `<span class="cbc-on-badge">已套用</span>` : ''}
        ${isFav ? `<span class="cbc-fav-badge" title="已收藏角色">★</span>` : ''}
        ${removeBtn}
        <img class="cbc-img" src="${esc(cachedSrc)}" alt="${esc(c.name)}" ${cachedSrc ? '' : 'hidden'}>
        <div class="cbc-placeholder" ${cachedSrc ? 'hidden' : ''}>
          <span class="cbc-ph-avatar">${esc(firstChar)}</span>
        </div>
        <button type="button" class="cbc-upload-btn" data-char-upload="${esc(c.key)}" title="上传角色图片（自动保存在 img/${esc(baseName)}.png）">📷 上传</button>
      </div>
      <div class="cbc-body">
        <div class="cbc-name">${esc(c.name)}</div>
        <div class="cbc-tag">${esc(c.tag)}</div>
        <div class="cbc-meta">${esc(c.game || '角色')} · 共 ${allPrompts.length} 项提示词</div>
        <div class="cbc-prompts-box" title="完整保留该角色全部提示词">${promptsHtml}</div>
      </div>
    </div>`;
  }

  function getMappedNsfwSubcategories() {
    const subs = [];
    (MAJORS || []).forEach(m => {
      if (m.id === 'negative') return;
      (m.children || []).forEach(s => {
        if (s.id === 'negative') return;
        const nsfwTags = (s.tags || []).filter(t => isNsfwTag(t.en, s.id, t));
        if (nsfwTags.length > 0) {
          subs.push({
            id: s.id,
            name: s.name,
            icon: s.icon || '🔞',
            parentId: m.id,
            parentName: m.name,
            tags: nsfwTags,
            totalRealCount: (s.tags || []).length
          });
        }
      });
    });
    return subs;
  }

  function getMappedNsfwMajors() {
    const majors = [];
    (MAJORS || []).forEach(m => {
      if (m.id === 'negative') return;
      const mSubs = [];
      let totalTags = 0;
      (m.children || []).forEach(s => {
        if (s.id === 'negative') return;
        const nsfwTags = (s.tags || []).filter(t => isNsfwTag(t.en, s.id, t));
        if (nsfwTags.length > 0) {
          mSubs.push({
            id: s.id,
            name: s.name,
            icon: s.icon || '🔞',
            parentId: m.id,
            parentName: m.name,
            tags: nsfwTags,
            totalRealCount: (s.tags || []).length
          });
          totalTags += nsfwTags.length;
        }
      });
      if (mSubs.length > 0) {
        majors.push({
          id: m.id,
          name: m.name,
          icon: m.icon || '📁',
          subs: mSubs,
          totalTags
        });
      }
    });
    return majors;
  }

  function getCollapsibleSubIdsForCurrentView() {
    ensureCustomCategoriesStructure();
    if (state.q.trim()) {
      return ['search_char_sec', 'search_tag_sec'];
    }
    if (state.cat === 'custom') {
      return ['cust_char_sec'].concat((state.customTagCats || []).map(c => c.id));
    }
    if (state.cat === 'nsfw_all') {
      return getMappedNsfwSubcategories().map(s => 'nsfw_map_' + s.id);
    }
    if (String(state.cat).indexOf('nsfw_major:') === 0) {
      const targetMid = String(state.cat).slice(11);
      return getMappedNsfwSubcategories().filter(s => s.parentId === targetMid).map(s => 'nsfw_map_' + s.id);
    }
    if (String(state.cat).indexOf('nsfw_sub:') === 0) {
      return ['nsfw_map_' + String(state.cat).slice(9)];
    }
    if (state.cat === 'fav' || state.cat === 'char:fav') {
      return ['fav_char_sec', 'fav_tag_sec'];
    }
    if (state.cat === 'recent' || state.cat === 'char:recent') {
      return ['recent_char_sec', 'recent_tag_sec'];
    }
    if (state.cat === 'char:games' || state.cat === 'char:anime' || state.cat === 'char:vtuber') {
      return getCharSubSections(state.cat.slice(5)).map(s => s.secId);
    }
    if (String(state.cat).indexOf('major:') === 0) {
      const m = visibleMajors().find(x => x.id === String(state.cat).slice(6));
      return m ? m.children.map(c => c.id) : [];
    }
    if (state.cat === 'all') {
      return visibleCats().map(c => c.id);
    }
    const c = visibleCats().find(x => x.id === state.cat);
    return c ? [c.id] : visibleCats().map(x => x.id);
  }

  function syncToggleAllSubsBtn() {
    const btn = $('#btnToggleAllSubs');
    if (!btn) return;
    const subs = getCollapsibleSubIdsForCurrentView();
    if (!subs.length) {
      btn.disabled = true;
      btn.classList.remove('is-all-open');
      btn.innerHTML = '▾ 展开/收起小类';
      return;
    }
    btn.disabled = false;
    const expSet = new Set(state.expandedSubs || []);
    const openCount = subs.filter(id => expSet.has(id)).length;
    const allOpen = openCount === subs.length;
    btn.classList.toggle('is-all-open', allOpen);
    if (allOpen) {
      btn.innerHTML = `▴ 收起全部小类 (${subs.length})`;
    } else if (openCount > 0) {
      btn.innerHTML = `▾ 展开全部小类 (${openCount}/${subs.length})`;
    } else {
      btn.innerHTML = `▾ 展开全部小类 (${subs.length})`;
    }
  }

  function getCharSubSections(l1Mode) {
    ensureCustomCategoriesStructure();
    const mode = l1Mode || 'games';
    const prefix = mode === 'anime' ? 'anime' : (mode === 'vtuber' ? 'vtuber' : 'game');
    const fs = window.PG_TAG_FS;
    const charMajor = (fs && Array.isArray(fs.charMajors)) ? fs.charMajors.find(m => m.id === mode) : null;
    const deletedSet = new Set(Array.isArray(state.charDeletedSubs) ? state.charDeletedSubs : []);
    const isSubDeleted = (sid, sname) => deletedSet.has(`${mode}::${sid}`) || deletedSet.has(`${mode}::${sname}`);
    const map = new Map();

    if (charMajor && Array.isArray(charMajor.children)) {
      charMajor.children.forEach(sub => {
        if (!sub || !sub.name) return;
        const sid = sub.id || safeId(sub.name);
        if (isSubDeleted(sid, sub.name)) return;
        map.set(sub.name, {
          secId: `char_${prefix}_${sid}`,
          id: sid,
          name: sub.name,
          l1Mode: mode,
          chars: []
        });
      });
    }

    (state.charCustomSubs || []).filter(s => s && s.l1Mode === mode).forEach(sub => {
      if (isSubDeleted(sub.id, sub.name)) return;
      if (!map.has(sub.name)) {
        map.set(sub.name, {
          secId: `char_${prefix}_${sub.id}`,
          id: sub.id,
          name: sub.name,
          l1Mode: mode,
          isCustomSub: true,
          chars: []
        });
      }
    });

    CHARS.filter(c => getCharLevel1Prefix(c) === prefix).forEach(c => {
      const fallbackName = mode === 'anime' ? '热门番剧' : (mode === 'vtuber' ? 'hololive' : '其他游戏');
      const gName = c.subName || c.game || fallbackName;
      const sid = c.subId || gName.toLowerCase().replace(/[^a-z0-9]+/g, '_') || ('sub_' + map.size);
      if (isSubDeleted(sid, gName)) return;
      if (!map.has(gName)) {
        map.set(gName, {
          secId: `char_${prefix}_${sid}`,
          id: sid,
          name: gName,
          l1Mode: mode,
          chars: []
        });
      }
      map.get(gName).chars.push(c);
    });

    const list = Array.from(map.values());
    const charOrder = (fs && fs.layoutOrder && fs.layoutOrder.charSubOrderByMode && fs.layoutOrder.charSubOrderByMode[mode]) || [];
    if (Array.isArray(charOrder) && charOrder.length) {
      const rankMap = new Map();
      charOrder.forEach((secId, idx) => rankMap.set(secId, idx));
      list.sort((a, b) => {
        const ra = rankMap.has(a.secId) ? rankMap.get(a.secId) : (rankMap.has(a.id) ? rankMap.get(a.id) : 99999);
        const rb = rankMap.has(b.secId) ? rankMap.get(b.secId) : (rankMap.has(b.id) ? rankMap.get(b.id) : 99999);
        return ra - rb;
      });
    }
    // 二级分类默认保持收起状态
    return list;
  }

  function getGameSubSections() {
    return getCharSubSections('games');
  }

  function renderNav() {
    ensureCustomCategoriesStructure();
    const cs = selectedSet();
    const vCats = visibleCats();
    let html = `<button type="button" class="cat-item ${state.cat === 'all' ? 'active' : ''}" data-cat="all">
      <span class="ico">▦</span><span class="nm">全部</span><span class="ct">${vCats.reduce((n, c) => n + c.tags.length, 0)}</span></button>`;

    const charActive = state.cat === 'char:games' || state.cat === 'char:anime' || state.cat === 'char:vtuber';
    const gameCharCount = CHARS.filter(c => getCharLevel1Prefix(c) === 'game').length;
    const animeCharCount = CHARS.filter(c => getCharLevel1Prefix(c) === 'anime').length;
    const vtuberCharCount = CHARS.filter(c => getCharLevel1Prefix(c) === 'vtuber').length;
    const favTotalCount = getFavCharsList().length + (state.favTags ? state.favTags.length : 0);
    const recentTotalCount = getRecentCharsList().length + (state.recentTags ? state.recentTags.length : 0);

    html += `<button type="button" id="btnChar" class="cat-item char-root-btn ${state.charNavOpen ? 'open' : ''} ${charActive ? 'active' : ''}" data-toggle-char-nav="1" title="点击展开/收起角色库二级分类（游戏 / 番剧 / VTuber）">
      <span class="ico">🧝</span><span class="nm">角色库</span>
      <span class="char-caret">▾</span>
      <span class="ct">${CHARS.length}</span>
    </button>`;

    html += `<div class="char-subnav" ${state.charNavOpen ? '' : 'hidden'}>
      <button type="button" class="cat-item char-sub-item ${state.cat === 'char:games' ? 'active' : ''}" data-cat="char:games">
        <span class="ico">🎮</span><span class="nm">游戏</span><span class="ct">${gameCharCount}</span>
      </button>
      <button type="button" class="cat-item char-sub-item ${state.cat === 'char:anime' ? 'active' : ''}" data-cat="char:anime">
        <span class="ico">📺</span><span class="nm">番剧</span><span class="ct">${animeCharCount}</span>
      </button>
      <button type="button" class="cat-item char-sub-item ${state.cat === 'char:vtuber' ? 'active' : ''}" data-cat="char:vtuber">
        <span class="ico">🎤</span><span class="nm">VTuber</span><span class="ct">${vtuberCharCount}</span>
      </button>
    </div>`;

    html += `<button type="button" class="cat-item ${(state.cat === 'fav' || state.cat === 'char:fav') ? 'active' : ''}" data-cat="fav" title="收藏（角色 / tag）· 右键可清空收藏">
      <span class="ico">★</span><span class="nm">收藏</span><span class="ct">${favTotalCount}</span>
    </button>`;
    html += `<button type="button" class="cat-item ${(state.cat === 'recent' || state.cat === 'char:recent') ? 'active' : ''}" data-cat="recent" title="最近（角色 / tag）· 右键可清空最近记录">
      <span class="ico">🕘</span><span class="nm">最近</span><span class="ct">${recentTotalCount}</span>
    </button>`;

    html += '<div class="cat-sep"></div>';

    const allVisMajors = visibleMajors();
    const isNegMajor = m => m && (m.id === 'negative' || m.isNegative || /^neg_/i.test(m.id));
    const posMajors = allVisMajors.filter(m => !isNegMajor(m));
    const negMajors = allVisMajors.filter(m => isNegMajor(m));

    const posTotalCount = posMajors.reduce((sum, m) => sum + m.children.reduce((n, c) => n + c.tags.length, 0), 0);
    const posOnCount = posMajors.reduce((sum, m) => sum + m.children.reduce((n, c) => n + c.tags.filter(t => cs.has(norm(t.en))).length, 0), 0);
    const posActive = state.cat === 'pos_root' || posMajors.some(m => state.cat === 'major:' + m.id);
    const isPosOpen = !!state.posNavOpen;

    html += `<button type="button" id="btnPosNav" class="cat-item char-root-btn ${isPosOpen ? 'open' : ''} ${posActive ? 'active' : ''}" data-toggle-pos-nav="1" title="点击展开/收起正向提示词下属全部大分类">
      <span class="ico">✨</span><span class="nm">正向提示词</span>
      <span class="char-caret">▾</span>
      <span class="ct">${posOnCount ? posOnCount + '/' : ''}${posTotalCount}</span>
    </button>`;

    html += `<div class="char-subnav pos-subnav" ${isPosOpen ? '' : 'hidden'}>`;
    posMajors.forEach(m => {
      const majorKey = 'major:' + m.id;
      const mTotal = m.children.reduce((n, c) => n + c.tags.length, 0);
      const mOn = m.children.reduce((n, c) => n + c.tags.filter(t => cs.has(norm(t.en))).length, 0);
      const isActive = state.cat === majorKey;
      const isEditing = state.editingMajorId === m.id;

      if (isEditing) {
        html += `<div class="cat-item char-sub-item active" data-major="${esc(m.id)}">
          <span class="ico">${esc(m.icon)}</span>
          <input type="text" class="inline-rename-input" id="inlineMajorInput" data-mid="${esc(m.id)}" value="${esc(m.name)}" maxlength="30">
        </div>`;
      } else {
        html += `<button type="button" class="cat-item char-sub-item ${isActive ? 'active' : ''}" draggable="true" data-major="${esc(m.id)}" title="${esc(m.name)}（左键查看 · 右键管理大分类 · 拖动调整排序）">
          <span class="drag-grip" title="按住拖动排序">⋮⋮</span>
          <span class="ico">${esc(m.icon)}</span>
          <span class="nm">${esc(m.name)}</span>
          <span class="ct" data-major-ct="${esc(m.id)}">${mOn ? mOn + '/' : ''}${mTotal}</span>
        </button>`;
      }
    });
    html += `<button type="button" id="btnQuickAddMajor" class="btn-add-major-inline" title="在正向提示词下新增分类">
      <span>＋</span><span>新增分类</span>
    </button>`;
    html += `</div>`;

    // (2.7 Req 7) 左侧负面提示词取消展开功能，直接作为一级大分类按钮展示（与正向提示词、NSFW 并列）
    const negM = negMajors[0] || { id: 'negative', name: '负面提示词', icon: '⛔', children: [] };
    const negTotalCount = negMajors.reduce((sum, m) => sum + m.children.reduce((n, c) => n + c.tags.length, 0), 0);
    const negOnCount = negMajors.reduce((sum, m) => sum + m.children.reduce((n, c) => n + c.tags.filter(t => cs.has(norm(t.en))).length, 0), 0);
    const isNegActive = state.cat === 'major:' + negM.id || negMajors.some(m => state.cat === 'major:' + m.id);

    html += `<button type="button" id="btnNegNav" class="cat-item ${isNegActive ? 'active' : ''}" data-major="${esc(negM.id)}" title="${esc(negM.name)}（左键查看负面提示词 · 右键管理大分类）">
      <span class="ico">${esc(negM.icon || '⛔')}</span>
      <span class="nm">${esc(negM.name || '负面提示词')}</span>
      <span class="ct" data-major-ct="${esc(negM.id)}">${negOnCount ? negOnCount + '/' : ''}${negTotalCount}</span>
    </button>`;

    // (V1.1.1) NSFW 映射大分类：默认收起，展开后仅显示一级大分类（点击某一大分类后在中间展示该大分类下属的 NSFW 小分类）
    const nsfwMappedMajors = getMappedNsfwMajors();
    const nsfwTotalCount = nsfwMappedMajors.reduce((sum, m) => sum + m.totalTags, 0);
    const nsfwOnCount = nsfwMappedMajors.reduce((sum, m) => sum + m.subs.reduce((sn, s) => sn + s.tags.filter(t => cs.has(norm(t.en))).length, 0), 0);
    const isNsfwRootActive = state.cat === 'nsfw_all' || String(state.cat).indexOf('nsfw_major:') === 0 || String(state.cat).indexOf('nsfw_sub:') === 0;
    const isNsfwOpen = !!state.nsfwNavOpen;

    html += `<button type="button" id="btnNsfwNav" class="cat-item char-root-btn ${isNsfwOpen ? 'open' : ''} ${(state.cat === 'nsfw_all' || isNsfwRootActive) ? 'active' : ''}" data-toggle-nsfw-nav="1" title="NSFW 映射分区（展开仅显示所属一级大分类，默认不展开）">
      <span class="ico">🔞</span>
      <span class="nm">NSFW</span>
      <span class="char-caret">▾</span>
      <span class="ct">${nsfwOnCount ? nsfwOnCount + '/' : ''}${nsfwTotalCount}</span>
    </button>`;

    html += `<div class="char-subnav nsfw-subnav" ${isNsfwOpen ? '' : 'hidden'}>`;
    nsfwMappedMajors.forEach(m => {
      const nMajorKey = 'nsfw_major:' + m.id;
      const mOn = m.subs.reduce((sn, s) => sn + s.tags.filter(t => cs.has(norm(t.en))).length, 0);
      html += `<button type="button" class="cat-item char-sub-item ${state.cat === nMajorKey ? 'active' : ''}" data-nsfw-major="${esc(m.id)}" title="NSFW › ${esc(m.name)}（${m.subs.length} 个小分类 · ${m.totalTags} 个标签）">
        <span class="ico">${esc(m.icon)}</span>
        <span class="nm">${esc(m.name)}</span>
        <span class="ct">${mOn ? mOn + '/' : ''}${m.totalTags}</span>
      </button>`;
    });
    html += `</div>`;

    html += '<div class="cat-sep"></div>';

    // (2.7 Req 5) 左侧自定义大分类入口，点击后在中间区域展示「自定义角色」与「自定义小分类」
    const custCharTotal = (state.customChars || []).length;
    const custTagTotal = (state.customTagCats || []).reduce((a, c) => a + (c.tags ? c.tags.length : 0), 0);
    const custTotal = custCharTotal + custTagTotal;
    const isCustActive = state.cat === 'custom';

    html += `<button type="button" id="btnCustomNav" class="cat-item ${isCustActive ? 'active' : ''}" data-cat="custom" title="自定义（中间第一行显示自定义角色，第二行起显示自定义小分类）">
      <span class="ico">⭐</span><span class="nm">自定义</span>
      <span class="ct">${custTotal}</span>
    </button>`;

    el.catNav.innerHTML = html;

    if (state.editingMajorId) {
      const inp = document.getElementById('inlineMajorInput');
      if (inp) {
        setTimeout(() => { inp.focus(); inp.select(); }, 10);
      }
    }
  }

  function ensureBatchState() {
    if (!(state.batchSelectedMap instanceof Map)) state.batchSelectedMap = new Map();
    if (!(state.nsfwCustomOn instanceof Set)) state.nsfwCustomOn = new Set(Array.isArray(state.nsfwCustomOn) ? state.nsfwCustomOn : []);
    if (!(state.nsfwCustomOff instanceof Set)) state.nsfwCustomOff = new Set(Array.isArray(state.nsfwCustomOff) ? state.nsfwCustomOff : []);
  }

  function isNsfwSubId(sid) {
    if (!sid) return false;
    if (/^nsfw/i.test(sid)) return true;
    const hit = typeof findTreeSub === 'function' ? findTreeSub(sid) : null;
    if (hit && hit.major && (hit.major.id === 'nsfw_group' || /nsfw|成人/i.test(hit.major.name || ''))) return true;
    return false;
  }

  function findTagObjInTree(en, subId) {
    const k = norm(cleanArtistEn(en));
    if (!k) return null;
    if (subId) {
      const subHit = TAG_SUB_OBJ_LOOKUP.get(subId + '::' + k);
      if (subHit) return subHit;
    }
    const fastHit = TAG_OBJ_LOOKUP.get(k);
    if (fastHit) return fastHit;
    return null;
  }

  function isNsfwRating(r) {
    return r === 'q' || r === 'e';
  }

  function getTagRating(en, subId, tagObj) {
    ensureBatchState();
    if (!state.ratingOverrides || typeof state.ratingOverrides !== 'object') state.ratingOverrides = {};
    const clean = cleanArtistEn(en);
    const k = norm(clean);
    if (!k) return 'g';
    if (state.ratingOverrides[k] && RATING_META[state.ratingOverrides[k]]) {
      return state.ratingOverrides[k];
    }
    if (tagObj && tagObj.rating && RATING_META[tagObj.rating]) return tagObj.rating;
    const found = findTagObjInTree(clean, subId);
    if (found && found.tag && found.tag.rating && RATING_META[found.tag.rating]) {
      return found.tag.rating;
    }
    if (state.nsfwCustomOff && state.nsfwCustomOff.has(k)) return 'g';
    if (state.nsfwCustomOn && state.nsfwCustomOn.has(k)) return 'e';
    if (tagObj && tagObj.nsfw === true) return 'e';
    if (found && found.tag && found.tag.nsfw === true) return 'e';
    if (en && /^(nsfw|explicit)$/i.test(String(en).trim())) return 'e';
    if (en && /^sensitive$/i.test(String(en).trim())) return 's';
    if (en && /^questionable$/i.test(String(en).trim())) return 'q';
    return 'g';
  }

  // (V1.2.1 Req 4) NSFW 映射仅包含橙色 (q: 存疑) 和红色 (e: 限制级) 两种标签
  function isNsfwTag(en, subId, tagObj) {
    const r = getTagRating(en, subId, tagObj);
    return r === 'q' || r === 'e';
  }

  async function setTagsRatingState(items, targetRating) {
    ensureBatchState();
    const r = RATING_META[targetRating] ? targetRating : 'g';
    const isNsfw = (r === 'q' || r === 'e');
    const list = Array.isArray(items) ? items : [];
    if (!list.length) {
      toast('请先选择要设置分级颜色的标签');
      return;
    }
    if (!state.ratingOverrides || typeof state.ratingOverrides !== 'object') state.ratingOverrides = {};
    const meta = RATING_META[r];
    recordHistorySnapshot(`设置分级为 ${meta.name} (${list.length} 个标签)`, true);
    const touchedSubs = new Map();
    const fs = window.PG_TAG_FS;
    list.forEach(item => {
      const clean = cleanArtistEn(typeof item === 'string' ? item : item.en);
      const k = norm(clean);
      if (!k) return;
      state.ratingOverrides[k] = r;
      if (isNsfw) {
        state.nsfwCustomOn.add(k);
        state.nsfwCustomOff.delete(k);
      } else {
        state.nsfwCustomOff.add(k);
        state.nsfwCustomOn.delete(k);
      }
      if (fs && Array.isArray(fs.majors)) {
        fs.majors.forEach(m => {
          (m.children || []).forEach(s => {
            (s.tags || []).forEach(t => {
              if (norm(t.en) === k) {
                t.rating = r;
                t.nsfw = isNsfw;
                touchedSubs.set(s.id, { major: m, sub: s });
              }
            });
          });
        });
      }
      (state.customTagCats || []).forEach(tc => {
        (tc.tags || []).forEach(t => {
          if (norm(t.en) === k) {
            t.rating = r;
            t.nsfw = isNsfw;
          }
        });
      });
      (state.custom || []).forEach(t => {
        if (norm(t.en) === k) {
          t.rating = r;
          t.nsfw = isNsfw;
        }
      });
    });
    // 立即同步内存分类树并刷新左侧 NSFW 计数与中间网格
    refreshAllFromTree();
    save();
    toast(`${meta.icon} 已将 ${list.length} 个标签设为「${meta.name}」`);
    if (fs && touchedSubs.size > 0) {
      const nowIso = new Date().toISOString();
      touchedSubs.forEach(({ sub }) => { sub.updatedAt = nowIso; });
      if (touchedSubs.size === 1) {
        const only = Array.from(touchedSubs.values())[0];
        await fs.persistOp({ action: 'save_sub', majorId: only.major.id, sub: only.sub, major: only.major });
      } else {
        await fs.persistOp({ action: 'sync_all', majors: fs.majors });
      }
      refreshAllFromTree();
    }
  }

  async function setTagsNsfwRedState(items, enableRed) {
    return setTagsRatingState(items, enableRed ? 'e' : 'g');
  }

  function isBatchSelected(en) {
    ensureBatchState();
    return state.batchSelectedMap.has(norm(cleanArtistEn(en)));
  }

  function syncBatchSelectBarUI(keepBarHiddenDuringDrag) {
    ensureBatchState();
    const btn = $('#btnBatchSelectMode');
    const bar = $('#batchActionBar');
    const cnt = $('#batchSelCount');
    const items = Array.from(state.batchSelectedMap.values());
    const n = items.length;
    if (btn) {
      btn.classList.toggle('active', !!state.batchSelectMode);
      btn.textContent = state.batchSelectMode ? `☑ 选择中 (${n})` : '☑ 选择';
    }
    if (bar && !keepBarHiddenDuringDrag) bar.hidden = !state.batchSelectMode;
    if (cnt) cnt.textContent = String(n);
  }

  let _dismissNewTimer = null;
  function markTagObjectAsNew(tagObj, enStr) {
    if (tagObj && typeof tagObj === 'object') {
      tagObj.isNew = true;
    }
    const k = norm(cleanArtistEn(enStr || (tagObj && tagObj.en) || ''));
    if (k) {
      if (state.seenNewTagsSet instanceof Set) {
        state.seenNewTagsSet.delete(k);
        state.seenNewTags = Array.from(state.seenNewTagsSet);
      } else if (Array.isArray(state.seenNewTags)) {
        state.seenNewTags = state.seenNewTags.filter(x => x !== k);
      }
    }
  }
  function isTagNewDotVisible(t, k) {
    if (!t || typeof t !== 'object') return false;
    if (state.seenNewTagsSet instanceof Set && state.seenNewTagsSet.has(k)) return false;
    if (t.isNew) return true;
    const ref = TAG_OBJ_LOOKUP.get(k);
    return !!(ref && ref.tag && ref.tag.isNew);
  }
  function dismissNewTagBadge(en, chipEl) {
    const k = norm(cleanArtistEn(en));
    if (!k) return;
    if (!(state.seenNewTagsSet instanceof Set)) state.seenNewTagsSet = new Set(state.seenNewTags || []);
    state.seenNewTagsSet.add(k);
    state.seenNewTags = Array.from(state.seenNewTagsSet);
    const ref = TAG_OBJ_LOOKUP.get(k);
    if (ref) {
      if (ref.tag) delete ref.tag.isNew;
      if (ref.catItem) delete ref.catItem.isNew;
    }
    (state.customTagCats || []).forEach(c => {
      (c.tags || []).forEach(ct => {
        if (norm(cleanArtistEn(ct.en)) === k) delete ct.isNew;
      });
    });
    if (chipEl) {
      chipEl.removeAttribute('data-is-new');
      const dot = chipEl.querySelector('.chip-new-dot');
      if (dot) dot.remove();
    }
    clearTimeout(_dismissNewTimer);
    _dismissNewTimer = setTimeout(() => { save(); }, 350);
  }

  function chipHTML(t, opts = {}) {
    const k = norm(t.en);
    const on = opts.forceOn || currentSelectedSetHas(k);
    const hit = state.highlight && state.highlight.has(k);
    const zh = state.showZh ? trSpan(t.en, t.zh) : '';
    const sid = opts.subId || tagCatOf(t.en) || '';
    const rating = !opts.char ? getTagRating(t.en, sid, t) : 'g';
    const nsfw = !opts.char && (rating !== 'g');
    const bSel = !opts.char && state.batchSelectMode && isBatchSelected(t.en);
    const showNew = !opts.char && isTagNewDotVisible(t, k);
    const hoverTip = opts.char ? (t.charZh || t.name || t.en) : getTagHoverTip(t, sid);
    const listAttr = opts.listMode ? ` data-list-mode="${esc(opts.listMode)}"` : '';
    const newAttr = showNew ? ' data-is-new="1"' : '';
    const attr = opts.char ? `data-char="${esc(t.key)}"` : `data-en="${esc(t.en)}" data-sub="${esc(sid)}" data-rating="${esc(rating)}" data-hover-tip="${esc(hoverTip)}"${listAttr}${newAttr}`;
    const rateCls = !opts.char ? ` rating-${rating}` : '';
    const extra = (opts.char ? ' char-chip-btn' : '') + rateCls + (nsfw ? ' nsfw-chip' : '') + (bSel ? ' batch-sel' : '') + (hit ? ' locate-flash' : '');
    const star = isFavTag(t.en) ? '<span class="fav-star">★</span>' : '';
    const newDot = showNew ? '<span class="chip-new-dot" title="新增/修改词条（鼠标触碰后自动消失）"></span>' : '';
    const delRecentBtn = (opts.listMode === 'recent')
      ? `<span class="x chip-del-x" data-del-recent-tag="${esc(t.en)}" title="从最近中移除此标签">×</span>`
      : '';
    return `<button class="chip${on ? ' on' : ''}${hit ? ' hit' : ''}${extra}" ${attr} title="${esc(hoverTip)}">${newDot}${star}${esc(t.en)}${zh}${delRecentBtn}</button>`;
  }

  let _selCache = { key: '', set: new Set() };
  function currentSelectedSetHas(k) {
    const list = currentList();
    const tag = state.mode + ':' + list.length + ':' + (list[0] ? list[0].key : '') + ':' + (list[list.length - 1] ? list[list.length - 1].key : '');
    if (_selCache.key !== tag) {
      const s = new Set();
      list.forEach(i => {
        s.add(i.key);
        s.add(norm(cleanArtistEn(i.en)));
      });
      _selCache = { key: tag, set: s };
    }
    return _selCache.set.has(k) || _selCache.set.has(norm(cleanArtistEn(k)));
  }

  function matchingChars(q) {
    const s = norm(q);
    if (!s) return [];
    return CHARS.filter(c =>
      norm(c.name).includes(s) || norm(c.game).includes(s) || norm(c.tag).includes(s) ||
      norm(c.charZh).includes(s) || String(c.name).includes(q) || pyHit(c.name, s) || pyHit(c.charZh, s)
    ).slice(0, 24);
  }

  const SUB_RENDER_PAGE_SIZE = 240;

  function sortTagsForView(tagsArr) {
    const mode = state.tagSortMode || 'default';
    if (!Array.isArray(tagsArr) || mode === 'default') return tagsArr || [];
    const copy = tagsArr.slice();
    if (mode === 'pop') {
      copy.sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0) || String(a.en).localeCompare(String(b.en)));
    } else if (mode === 'alpha') {
      copy.sort((a, b) => String(a.en).localeCompare(String(b.en)));
    }
    return copy;
  }

  function renderSubTagsWithPagination(tagsArr, subId, isCustom) {
    if (!state._subShowLimit) state._subShowLimit = {};
    const limit = state._subShowLimit[subId] || SUB_RENDER_PAGE_SIZE;
    const sorted = sortTagsForView(tagsArr);
    const filtered = [];
    for (let i = 0; i < sorted.length; i++) {
      const t = sorted[i];
      if (state.showNsfw === false && isNsfwTag(t.en, subId, t)) continue;
      filtered.push(t);
    }
    let out = '';
    /* V1.3.2 Req 4: 画师风格推荐已移至右侧侧边栏与关联推荐并列双行折叠 */
    const sliceEnd = Math.min(filtered.length, limit);
    for (let i = 0; i < sliceEnd; i++) {
      out += chipHTML(filtered[i], { subId, custom: !!isCustom });
    }
    if (filtered.length > sliceEnd) {
      const rem = filtered.length - sliceEnd;
      out += `<button type="button" class="chip sub-more-btn" data-sub-load-more="${esc(subId)}" title="点击继续展开此小分类剩余标签">▾ 展开更多标签（剩余 ${rem} / 共 ${filtered.length} 个）</button>`;
    }
    return out;
  }

  function buildArtistRecBarHTML() {
    const adb = window.__EXT_ARTIST_DB__;
    if (!adb || !adb.tagToArtists) return '';
    const profiles = adb.profiles || adb.artists || {};
    const t2a = adb.tagToArtists;

    // Collect candidate tags from both state.sel and selected characters (state.chars)
    const rawSeeds = [];
    const seenSeed = new Set();
    const pushSeed = (enRaw, weight) => {
      if (!enRaw) return;
      const clean = norm(String(enRaw).replace(/^@+/, ''));
      if (!clean || String(enRaw).trim().startsWith('@')) return;
      if (/^(1girl|1boy|solo|masterpiece|best quality|best_quality|high quality|highres|absurdres|incredibly absurdres|very aesthetic|aesthetic|safe|nsfw|sensitive|questionable|explicit|general)$/.test(clean)) return;
      if (!seenSeed.has(clean)) {
        seenSeed.add(clean);
        rawSeeds.push({ spaceKey: clean, underKey: clean.replace(/\s+/g, '_'), weight: weight || 1.0 });
      }
    };

    (state.sel || []).forEach(it => {
      if (it && it.en && !String(it.en).trim().startsWith('@')) pushSeed(it.en, 1.0);
    });
    (state.chars || []).forEach(ch => {
      if (ch && ch.tag) pushSeed(ch.tag, 1.15);
      (ch && ch.tags || []).forEach(ct => pushSeed(ct, 0.85));
    });

    if (!rawSeeds.length) {
      return `<div class="artist-rec-bar">
        <div class="artist-rec-top">
          <span class="artist-rec-title">✨ 按画面推荐画师 <span class="muted small">（先在其它分类勾选几个角色外观/服饰/光影标签，这里会自动计算最契合的画师！）</span></span>
        </div>
      </div>`;
    }

    const artistMap = new Map();
    const addCandList = (candList, labelTag, weight) => {
      if (!Array.isArray(candList)) return false;
      candList.forEach(entry => {
        const artName = entry[0];
        const score = Number(entry[1]) || 0;
        if (!artName) return;
        const cleanArt = String(artName).replace(/_/g, ' ');
        let rec = artistMap.get(cleanArt);
        if (!rec) {
          rec = { name: cleanArt, rawScore: 0, hits: 0, matchedTags: [] };
          artistMap.set(cleanArt, rec);
        }
        rec.rawScore += score * weight;
        if (rec.matchedTags.indexOf(labelTag) < 0) {
          rec.hits += 1;
          rec.matchedTags.push(labelTag);
        }
      });
      return candList.length > 0;
    };

    rawSeeds.forEach(sd => {
      let matched = addCandList(t2a[sd.spaceKey] || t2a[sd.underKey], sd.spaceKey, sd.weight);
      if (!matched) {
        const aliasKey = resolveOfficialAliasKey(sd.spaceKey);
        if (aliasKey) {
          const alSpace = norm(aliasKey);
          const alUnder = alSpace.replace(/\s+/g, '_');
          matched = addCandList(t2a[alSpace] || t2a[alUnder], sd.spaceKey, sd.weight * 0.95);
        }
      }
      if (!matched && sd.spaceKey.indexOf(' ') > 0) {
        // Fallback to head word / sub-tokens of compound tags (e.g., 'blue bikini' -> 'bikini')
        const parts = sd.spaceKey.split(/\s+/);
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i];
          if (p && p.length >= 3 && t2a[p]) {
            addCandList(t2a[p], `${sd.spaceKey}→${p}`, sd.weight * 0.65);
            break;
          }
        }
      }
    });

    if (!artistMap.size) {
      return `<div class="artist-rec-bar">
        <div class="artist-rec-top">
          <span class="artist-rec-title">✨ 按画面推荐画师 <span class="muted small">（当前已选标签暂无特定画师共现偏好，试试加入画风、光影或服饰细节词）</span></span>
        </div>
      </div>`;
    }

    const ranked = Array.from(artistMap.values()).map(r => {
      const bonus = 1.0 + 0.3 * Math.max(0, r.hits - 1);
      return { ...r, finalScore: r.rawScore * bonus };
    }).sort((a, b) => b.finalScore - a.finalScore).slice(0, 12);

    const chipsHtml = ranked.map(r => {
      const enTag = '@' + r.name.replace(/_/g, ' ');
      const k = norm(enTag);
      const on = currentSelectedSetHas(k);
      const prof = profiles[r.name] || profiles[r.name.replace(/\s+/g, '_')] || {};
      const zh = (prof.zh || zhLookup(enTag) || '').trim();
      const rawTop = Array.isArray(prof.topTags) ? prof.topTags : (Array.isArray(prof.top) ? prof.top : []);
      const topStr = rawTop.length ? rawTop.slice(0, 6).map(x => {
        if (x && typeof x === 'object') {
          const enS = String(x.en || '').replace(/_/g, ' ');
          return x.zh ? `${enS}(${x.zh})` : enS;
        }
        return String(x).replace(/_/g, ' ');
      }).join(', ') : '';
      const postCnt = prof.count || prof.posts || 0;
      const tip = `命中画面词: [${r.matchedTags.join(', ')}] (综合契合度 ${r.finalScore.toFixed(2)})${postCnt ? ' ｜ 作品数: ' + postCnt : ''}${topStr ? ' ｜ 代表特征: ' + topStr : ''}`;
      return `<button type="button" class="artist-rec-chip${on ? ' on' : ''}" data-en="${esc(enTag)}" data-sub="artist" title="${esc(tip)}">
        <span>🎨 ${esc(enTag)}</span>
        ${zh ? `<span class="muted small">(${esc(zh)})</span>` : ''}
        <span class="artist-rec-badge">${r.hits}词共鸣</span>
      </button>`;
    }).join('');

    return `<div class="artist-rec-bar">
      <div class="artist-rec-top">
        <span class="artist-rec-title">✨ 按当前已选画面智能推荐画师 <span class="muted small">（基于离线 tag_artist_cooc 多词共鸣加权：命中 ${artistMap.size} 位候选画师，展示 Top ${ranked.length}）</span></span>
      </div>
      <div class="artist-rec-list">${chipsHtml}</div>
    </div>`;
  }

  function renderSidebarArtistRecommendations() {
    const box = document.getElementById('artistRecBox');
    const body = document.getElementById('artistRecBody');
    const stat = document.getElementById('artistRecStat');
    if (!box || !body) return;
    const adb = window.__EXT_ARTIST_DB__;
    if (!adb || !adb.tagToArtists || state.mode !== 'pos') {
      box.hidden = true;
      return;
    }
    const profiles = adb.profiles || adb.artists || {};
    const t2a = adb.tagToArtists;

    const rawSeeds = [];
    const seenSeed = new Set();
    const pushSeed = (enRaw, weight) => {
      if (!enRaw) return;
      const clean = norm(String(enRaw).replace(/^@+/, ''));
      if (!clean || String(enRaw).trim().startsWith('@')) return;
      if (/^(1girl|1boy|solo|masterpiece|best quality|best_quality|high quality|highres|absurdres|incredibly absurdres|very aesthetic|aesthetic|safe|nsfw|sensitive|questionable|explicit|general)$/.test(clean)) return;
      if (!seenSeed.has(clean)) {
        seenSeed.add(clean);
        rawSeeds.push({ spaceKey: clean, underKey: clean.replace(/\s+/g, '_'), weight: weight || 1.0 });
      }
    };
    (state.sel || []).forEach(it => {
      if (it && it.en && !String(it.en).trim().startsWith('@')) pushSeed(it.en, 1.0);
    });
    (state.chars || []).forEach(ch => {
      if (ch && ch.tag) pushSeed(ch.tag, 1.15);
      (ch && ch.tags || []).forEach(ct => pushSeed(ct, 0.85));
    });

    if (!rawSeeds.length) {
      box.hidden = true;
      return;
    }

    const artistMap = new Map();
    const addCandList = (candList, labelTag, weight) => {
      if (!Array.isArray(candList)) return false;
      candList.forEach(entry => {
        const artName = entry[0];
        const score = Number(entry[1]) || 0;
        if (!artName) return;
        const cleanArt = String(artName).replace(/_/g, ' ');
        let rec = artistMap.get(cleanArt);
        if (!rec) {
          rec = { name: cleanArt, rawScore: 0, hits: 0, matchedTags: [] };
          artistMap.set(cleanArt, rec);
        }
        rec.rawScore += score * weight;
        if (rec.matchedTags.indexOf(labelTag) < 0) {
          rec.hits += 1;
          rec.matchedTags.push(labelTag);
        }
      });
      return candList.length > 0;
    };

    rawSeeds.forEach(sd => {
      let matched = addCandList(t2a[sd.spaceKey] || t2a[sd.underKey], sd.spaceKey, sd.weight);
      if (!matched) {
        const aliasKey = resolveOfficialAliasKey(sd.spaceKey);
        if (aliasKey) {
          const alSpace = norm(aliasKey);
          const alUnder = alSpace.replace(/\s+/g, '_');
          matched = addCandList(t2a[alSpace] || t2a[alUnder], sd.spaceKey, sd.weight * 0.95);
        }
      }
      if (!matched && sd.spaceKey.indexOf(' ') > 0) {
        const parts = sd.spaceKey.split(/\s+/);
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i];
          if (p && p.length >= 3 && t2a[p]) {
            addCandList(t2a[p], `${sd.spaceKey}→${p}`, sd.weight * 0.65);
            break;
          }
        }
      }
    });

    if (!artistMap.size) {
      box.hidden = true;
      return;
    }

    const ranked = Array.from(artistMap.values()).map(r => {
      const bonus = 1.0 + 0.3 * Math.max(0, r.hits - 1);
      return { ...r, finalScore: r.rawScore * bonus };
    }).sort((a, b) => b.finalScore - a.finalScore).slice(0, 25);

    box.hidden = false;
    if (typeof state._recOpenPanel === 'undefined') state._recOpenPanel = 'cooc';
    box.classList.toggle('collapsed', state._recOpenPanel !== 'artist');
    if (stat) stat.textContent = `（Top ${ranked.length}）`;

    body.innerHTML = ranked.map(r => {
      const enTag = '@' + r.name.replace(/_/g, ' ');
      const k = norm(enTag);
      const on = currentSelectedSetHas(k);
      const prof = profiles[r.name] || profiles[r.name.replace(/\s+/g, '_')] || {};
      const zh = (prof.zh || zhLookup(enTag) || '').trim();
      const matchedReadable = r.matchedTags.map(mt => {
        const mz = zhLookup(mt.split('→')[0]);
        return mz ? `${mt}(${mz})` : mt;
      }).join('、');
      const rawTop = Array.isArray(prof.topTags) ? prof.topTags : (Array.isArray(prof.top) ? prof.top : []);
      const topStr = rawTop.length ? rawTop.slice(0, 5).map(x => {
        if (x && typeof x === 'object') {
          const enS = String(x.en || '').replace(/_/g, ' ');
          return x.zh ? `${enS}(${x.zh})` : enS;
        }
        return String(x).replace(/_/g, ' ');
      }).join(', ') : '';
      const tip = `对应画面词 (${r.hits}个): ${matchedReadable} ｜ 契合度: ${r.finalScore.toFixed(2)}${topStr ? ' ｜ 代表特征: ' + topStr : ''}`;
      return `<button type="button" class="artist-rec-chip${on ? ' on' : ''}" data-side-artist="${esc(enTag)}" data-hover-tip="${esc(tip)}" title="${esc(tip)}">
        <span>🎨 ${esc(enTag)}</span>
        ${state.showZh && zh ? `<span class="muted small">(${esc(zh)})</span>` : ''}
        <span class="artist-rec-badge">${r.hits}词</span>
      </button>`;
    }).join('');
  }

  function renderCoocRecommendations() {
    renderSidebarArtistRecommendations();
    const box = document.getElementById('coocRecBox');
    const body = document.getElementById('coocRecBody');
    const stat = document.getElementById('coocRecStat');
    if (!box || !body) return;
    const coocDb = window.__EXT_COOC_TOP25__;
    if (!coocDb || state.mode !== 'pos') {
      box.hidden = true;
      return;
    }
    const selList = state.sel || [];
    if (!selList.length) {
      box.hidden = true;
      return;
    }
    const selKeysUnder = new Set();
    const selKeysSpace = new Set();
    selList.forEach(it => {
      const k = norm(cleanArtistEn(it.en));
      if (k) {
        selKeysSpace.add(k);
        selKeysUnder.add(k.replace(/\s+/g, '_'));
      }
    });

    const candScores = new Map();
    selList.forEach(it => {
      const seedSpace = norm(cleanArtistEn(it.en));
      const seedUnder = seedSpace.replace(/\s+/g, '_');
      const neighbors = coocDb[seedUnder] || coocDb[seedSpace];
      if (!Array.isArray(neighbors)) return;
      neighbors.forEach(([nbTag, npmi]) => {
        const nbSpace = norm(String(nbTag).replace(/_/g, ' '));
        if (!nbSpace || selKeysSpace.has(nbSpace) || selKeysUnder.has(nbTag)) return;
        const sid = tagCatOf(nbSpace) || '';
        if (state.showNsfw === false && isNsfwTag(nbSpace, sid)) return;
        let entry = candScores.get(nbSpace);
        if (!entry) {
          entry = { en: nbSpace, rawScore: 0, hits: 0, sources: [] };
          candScores.set(nbSpace, entry);
        }
        entry.rawScore += Number(npmi) || 0;
        entry.hits += 1;
        if (entry.sources.length < 4) entry.sources.push(seedSpace);
      });
    });

    if (!candScores.size) {
      box.hidden = true;
      return;
    }

    const topRecs = Array.from(candScores.values())
      .map(e => ({ ...e, finalScore: e.rawScore * (1 + 0.25 * (e.hits - 1)) }))
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, 25);

    box.hidden = false;
    if (typeof state._recOpenPanel === 'undefined') state._recOpenPanel = 'cooc';
    box.classList.toggle('collapsed', state._recOpenPanel !== 'cooc');
    if (stat) stat.textContent = `（Top ${topRecs.length}）`;

    body.innerHTML = topRecs.map(r => {
      const zh = zhLookup(r.en) || '';
      const tip = `与已选 [${r.sources.join(', ')}] 高频共现 (NPMI 关联度 ${r.finalScore.toFixed(2)}) · 点击直接加入正向提示词`;
      return `<button type="button" class="cooc-chip" data-cooc-add="${esc(r.en)}" title="${esc(tip)}">
        <span class="cooc-plus">＋</span>
        <span class="cooc-en">${esc(r.en)}</span>
        ${state.showZh && zh ? `<span class="cooc-zh">(${esc(zh)})</span>` : ''}
      </button>`;
    }).join('');
  }

  function renderGrid() {
    state._lazySeq = (state._lazySeq || 0) + 1;
    const q = state.q.trim();
    const lower = norm(q);
    let html = '';
    let count = 0;

    if (q) {
      // (2.4 Req 3) 搜索后显示的 tag 分为两个可展开/收起的分类：角色库 和 提示词
      if (!state._searchSecsInited) {
        state._searchSecsInited = true;
        state.expandedSubs = state.expandedSubs || [];
        if (state.expandedSubs.indexOf('search_char_sec') < 0) state.expandedSubs.push('search_char_sec');
        if (state.expandedSubs.indexOf('search_tag_sec') < 0) state.expandedSubs.push('search_tag_sec');
        if (state.expandedSubs.indexOf('search_ext_sec') < 0) state.expandedSubs.push('search_ext_sec');
      }
      const chars = matchingChars(q);
      const aliasTarget = resolveOfficialAliasKey(q);
      const aliasNorm = aliasTarget ? norm(aliasTarget) : '';
      const hits = [];
      const hitKeys = new Set();
      visibleCats().forEach(c => c.tags.forEach(t => {
        const k = norm(t.en);
        const kwStr = String(t.kw || '').toLowerCase();
        if (
          k.includes(lower) ||
          (aliasNorm && k === aliasNorm) ||
          String(t.zh).includes(q) ||
          (kwStr && (kwStr.includes(lower) || kwStr.includes(q))) ||
          pyHit(t.zh, lower)
        ) {
          hits.push({ t, cat: c.name, subId: c.id });
          hitKeys.add(k);
        }
      }));
      state.custom.forEach(t => {
        const k = norm(t.en);
        if (k.includes(lower) || String(t.zh).includes(q) || pyHit(t.zh, lower)) {
          hits.push({ t, cat: '自定义', subId: '__custom__' });
          hitKeys.add(k);
        }
      });
      const scoreSearchRel = (enRaw, zhRaw, kwRaw, cntRaw) => {
        const k = norm(cleanArtistEn(enRaw));
        const z = String(zhRaw || '').trim();
        let sc = 0;
        if (k === lower || (aliasNorm && k === aliasNorm) || z === q) sc = 1000;
        else if (k.startsWith(lower + ' ') || k.startsWith(lower + '_') || z.startsWith(q)) sc = 820;
        else if (k.endsWith(' ' + lower) || k.endsWith('_' + lower) || z.endsWith(q)) sc = 700;
        else if (lower && new RegExp('(^|[\\s_\\-(])' + lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[\\s_\\-)])').test(k)) sc = 560;
        else if (k.startsWith(lower)) sc = 480;
        else if (k.includes(lower) || (z && z.includes(q))) sc = 320;
        else sc = 160;
        return sc;
      };
      if (state.tagSortMode === 'pop') {
        hits.sort((a, b) => {
          const exA = (norm(cleanArtistEn(a.t.en)) === lower || String(a.t.zh || '').trim() === q) ? 1 : 0;
          const exB = (norm(cleanArtistEn(b.t.en)) === lower || String(b.t.zh || '').trim() === q) ? 1 : 0;
          if (exB !== exA) return exB - exA;
          return (Number(b.t.count) || 0) - (Number(a.t.count) || 0);
        });
      } else if (state.tagSortMode === 'alpha') {
        hits.sort((a, b) => String(a.t.en).localeCompare(String(b.t.en)));
      } else {
        hits.sort((a, b) => {
          const sa = scoreSearchRel(a.t.en, a.t.zh, a.t.kw, a.t.count);
          const sb = scoreSearchRel(b.t.en, b.t.zh, b.t.kw, b.t.count);
          if (sb !== sa) return sb - sa;
          const la = String(a.t.en || '').length;
          const lb = String(b.t.en || '').length;
          if (la !== lb) return la - lb;
          return (Number(b.t.count) || 0) - (Number(a.t.count) || 0);
        });
      }

      // Search 336,171-entry Full Offline Dictionary (tags/_offline_db_/full-dict-loader.js)
      // V1.3.1 Fix Bug 6: 支持单字（如单个汉字「猫」「鼻」「剑」或单字符）全库及离线大词典查询
      const extHits = [];
      const fdict = window.__EXT_FULL_DICT__;
      if (fdict && q.length >= 1) {
        const qUnder = lower.replace(/\s+/g, '_');
        const aliasUnder = aliasNorm ? aliasNorm.replace(/\s+/g, '_') : '';
        const isSingleAscii = (q.length === 1 && /^[\x00-\x7f]$/.test(q));
        // Check exact & alias first
        for (const candKey of [qUnder, aliasUnder]) {
          if (candKey && fdict[candKey]) {
            const sp = candKey.replace(/_/g, ' ');
            if (!hitKeys.has(sp) && !hitKeys.has('@' + sp)) {
              const row = fdict[candKey];
              const enOut = row[1] === 1 ? ('@' + sp) : sp;
              const rLv = (typeof getTagRating === 'function') ? getTagRating(enOut) : 'g';
              if (!state.nsfw && (rLv === 'q' || rLv === 'e')) continue;
              extHits.push({ en: enOut, zh: row[0] || '', count: row[2] || 0, desc: row[3] || '', kw: row[4] || '', rating: rLv });
              hitKeys.add(sp);
            }
          }
        }
        // Scan for additional matches up to 60 items
        for (const fk in fdict) {
          if (extHits.length >= 60) break;
          const row = fdict[fk];
          const zhStr = row[0] || '';
          const kwStr = row[4] || '';
          const matchEn = isSingleAscii ? (fk === qUnder || fk.startsWith(qUnder + '_')) : (qUnder && fk.includes(qUnder));
          const matchZh = Boolean(zhStr && zhStr.includes(q));
          const matchKw = Boolean(!isSingleAscii && kwStr && (kwStr.includes(q) || (lower && kwStr.includes(lower))));
          if (matchEn || matchZh || matchKw) {
            const sp = fk.replace(/_/g, ' ');
            if (hitKeys.has(sp) || hitKeys.has('@' + sp)) continue;
            hitKeys.add(sp);
            const enOut = row[1] === 1 ? ('@' + sp) : sp;
            const rLv = (typeof getTagRating === 'function') ? getTagRating(enOut) : 'g';
            if (!state.nsfw && (rLv === 'q' || rLv === 'e')) continue;
            extHits.push({ en: enOut, zh: zhStr, count: row[2] || 0, desc: row[3] || '', kw: kwStr, rating: rLv });
          }
        }
      }

      if (extHits.length > 1) {
        extHits.sort((a, b) => {
          const sa = scoreSearchRel(a.en, a.zh, a.kw, a.count);
          const sb = scoreSearchRel(b.en, b.zh, b.kw, b.count);
          if (sb !== sa) return sb - sa;
          const la = String(a.en || '').length;
          const lb = String(b.en || '').length;
          if (la !== lb) return la - lb;
          return (Number(b.count) || 0) - (Number(a.count) || 0);
        });
      }
      count = chars.length + hits.length + extHits.length;

      const isCharExp = (state.expandedSubs || []).indexOf('search_char_sec') >= 0;
      const isTagExp = (state.expandedSubs || []).indexOf('search_tag_sec') >= 0;
      const isExtExp = (state.expandedSubs || []).indexOf('search_ext_sec') >= 0;

      html += `<div class="sub-section${isCharExp ? ' expanded' : ''}" data-sub-sec="search_char_sec">
        <div class="sub-sec-head" data-toggle-sub="search_char_sec" title="点击展开/收起搜索到的角色库结果">
          <span class="caret">▾</span>
          <span class="sub-ico">🧝</span>
          <span class="sub-nm">角色库</span>
          <span class="sub-meta">${chars.length} 个匹配角色</span>
        </div>`;
      if (isCharExp) {
        html += `<div class="sub-sec-body">`;
        if (!chars.length) {
          html += `<div class="muted" style="padding:10px 4px">没有匹配的角色</div>`;
        } else {
          html += `<div class="char-big-grid">`;
          chars.forEach(c => { html += charBigCardHTML(c); });
          html += `</div>`;
        }
        html += `</div>`;
      }
      html += `</div>`;

      html += `<div class="sub-section${isTagExp ? ' expanded' : ''}" data-sub-sec="search_tag_sec">
        <div class="sub-sec-head" data-toggle-sub="search_tag_sec" title="点击展开/收起搜索到的提示词结果">
          <span class="caret">▾</span>
          <span class="sub-ico">🏷</span>
          <span class="sub-nm">提示词</span>
          <span class="sub-meta">${hits.length} 个匹配标签</span>
        </div>`;
      if (isTagExp) {
        html += `<div class="sub-sec-body">`;
        const visibleHits = state.showNsfw !== false ? hits : hits.filter(h => !isNsfwTag(h.t.en, h.subId, h.t));
        if (!visibleHits.length) {
          html += `<div class="muted" style="padding:10px 4px">${hits.length ? '已隐藏 NSFW (橙/红) 标签' : '没有匹配的提示词'}</div>`;
        } else {
          visibleHits.slice(0, 300).forEach(h => { html += chipHTML(h.t, { subId: h.subId, custom: h.subId === '__custom__' }); });
          if (visibleHits.length > 300) {
            html += `<div class="muted small" style="width:100%;padding:6px 4px">已展示前 300 条分类词库匹配（共 ${visibleHits.length} 条），可进一步细化关键词</div>`;
          }
        }
        html += `</div>`;
      }
      html += `</div>`;

      html += `<div class="sub-section${isExtExp ? ' expanded' : ''}" data-sub-sec="search_ext_sec">
        <div class="sub-sec-head" data-toggle-sub="search_ext_sec" title="点击展开/收起本地 33.6 万全量离线扩展词典匹配结果">
          <span class="caret">▾</span>
          <span class="sub-ico">📚</span>
          <span class="sub-nm">离线扩展词库（33.6万全量词典）</span>
          <span class="sub-meta">${extHits.length}${extHits.length >= 60 ? '+' : ''} 个扩展匹配</span>
        </div>`;
      if (isExtExp) {
        html += `<div class="sub-sec-body">`;
        if (!extHits.length) {
          html += `<div class="muted" style="padding:10px 4px">无额外扩展词条（已全部收录于上方主分类词库中）</div>`;
        } else {
          extHits.forEach(et => { html += chipHTML(et, { subId: '' }); });
        }
        html += `</div>`;
      }
      html += `</div>`;
    } else if (state.cat === 'char:games' || state.cat === 'char:anime' || state.cat === 'char:vtuber') {
      // (2.7 Req 6) 角色库（游戏 / 番剧 / VTuber）：每个小分类标题栏右侧放置「＋ 新增」按钮，最后一个小分类左下方仅保留「＋ 新增小分类」按钮
      const l1Mode = state.cat.slice(5);
      const l1Icon = l1Mode === 'anime' ? '📺' : (l1Mode === 'vtuber' ? '🎤' : '🎮');
      const charSubs = getCharSubSections(l1Mode);
      charSubs.forEach(g => {
        const isExp = (state.expandedSubs || []).indexOf(g.secId) >= 0;
        const isEditingSub = state.editingSubId === g.secId;
        const onCount = g.chars.filter(c => state.chars.some(x => x.key === c.key)).length;
        count += g.chars.length;
        html += `<div class="sub-section${isExp ? ' expanded' : ''}" data-sub-sec="${esc(g.secId)}" data-char-l1="${esc(l1Mode)}" data-char-sub-id="${esc(g.id)}">
          <div class="sub-sec-head" draggable="${isEditingSub ? 'false' : 'true'}" data-toggle-sub="${esc(g.secId)}" title="点击展开/收起 · 右键管理小分类 · 按住标题栏拖动排序">
            <span class="sub-grip" title="按住拖动排序">⋮⋮</span>
            <span class="caret">▾</span>
            <span class="sub-ico">${l1Icon}</span>`;
        if (isEditingSub) {
          html += `<input type="text" class="inline-rename-input" id="inlineSubInput" data-sub-id="${esc(g.secId)}" value="${esc(g.name)}" maxlength="30">`;
        } else {
          html += `<span class="sub-nm">${esc(g.name)}</span>`;
        }
        html += `<span class="sub-meta">${onCount ? `已套用 ${onCount} / ` : ''}${g.chars.length} 个角色</span>
            <button type="button" class="sub-head-btn" data-char-sub-add="${esc(g.id)}" data-char-sub-name="${esc(g.name)}" data-char-l1="${esc(l1Mode)}" title="在「${esc(g.name)}」小分类下新增人物">＋ 新增</button>
            <button type="button" class="sub-head-btn danger" data-char-sub-del="${esc(g.id)}" data-char-sub-name="${esc(g.name)}" data-char-l1="${esc(l1Mode)}" title="删除小分类「${esc(g.name)}」">🗑 删除</button>
          </div>`;
        if (isExp) {
          html += `<div class="sub-sec-body">`;
          if (!g.chars.length) {
            html += `<div class="muted" style="padding:10px 4px">暂无角色，点击本行右侧「＋ 新增」即可在此小分类下添加人物</div>`;
          } else {
            html += `<div class="char-big-grid">`;
            g.chars.forEach(c => { html += charBigCardHTML(c); });
            html += `</div>`;
          }
          html += `</div>`;
        }
        html += `</div>`;
      });
      html += `<div class="content-foot-bar">
        <button type="button" class="btn-add-sub-bottom" data-char-add-sub="${esc(l1Mode)}" title="在当前角色库下新增一个二级小分类">
          <span>＋</span><span>新增小分类</span>
        </button>
      </div>`;
      count = Math.max(count, 1);
    } else if (state.cat === 'fav' || state.cat === 'char:fav') {
      // (2.2 Req 2 & Req 3) 收藏：角色与 tag 两个子分类均配备独立清除按钮；角色完整保留单个角色所有提示词到一个框内，与角色库显示相同
      const favCharsList = getFavCharsList();
      const favTagItems = (state.favTags || []).map(k => INDEX.get(k) || { en: k, zh: zhLookup(k) }).filter(Boolean);
      const isCharExp = (state.expandedSubs || []).indexOf('fav_char_sec') >= 0;
      const isTagExp = (state.expandedSubs || []).indexOf('fav_tag_sec') >= 0;

      html += `<div class="sub-section${isCharExp ? ' expanded' : ''}" data-sub-sec="fav_char_sec">
        <div class="sub-sec-head" data-toggle-sub="fav_char_sec" title="点击展开/收起收藏的角色 · 右侧按钮或右键可单独清除">
          <span class="caret">▾</span>
          <span class="sub-ico">🧝</span>
          <span class="sub-nm">角色</span>
          <span class="sub-meta">${favCharsList.length} 个收藏角色</span>
          <button type="button" class="sub-sec-clear-btn" data-clear-sub-sec="fav_char" title="单独清除收藏的角色">🗑 清除</button>
        </div>`;
      if (isCharExp) {
        html += `<div class="sub-sec-body">`;
        if (!favCharsList.length) {
          html += `<div class="muted" style="padding:10px 4px">还没有收藏的角色（在角色卡片上点击右键可整卡收藏 ★）</div>`;
        } else {
          html += `<div class="char-big-grid">`;
          favCharsList.forEach(c => { html += charBigCardHTML(c, { listMode: 'fav_char' }); });
          html += `</div>`;
        }
        html += `</div>`;
      }
      html += `</div>`;

      html += `<div class="sub-section${isTagExp ? ' expanded' : ''}" data-sub-sec="fav_tag_sec">
        <div class="sub-sec-head" data-toggle-sub="fav_tag_sec" title="点击展开/收起收藏的常规 Tag · 右侧按钮或右键可单独清除">
          <span class="caret">▾</span>
          <span class="sub-ico">🏷</span>
          <span class="sub-nm">tag</span>
          <span class="sub-meta">${favTagItems.length} 个收藏标签</span>
          <button type="button" class="sub-sec-clear-btn" data-clear-sub-sec="fav_tag" title="单独清除收藏的 tag">🗑 清除</button>
        </div>`;
      if (isTagExp) {
        html += `<div class="sub-sec-body">`;
        const visibleFavTags = state.showNsfw !== false ? favTagItems : favTagItems.filter(t => !isNsfwTag(t.en, tagCatOf(t.en), t));
        if (!visibleFavTags.length) {
          html += `<div class="muted" style="padding:10px 4px">${favTagItems.length ? '已隐藏 NSFW (橙/红) 标签' : '还没有收藏的常规标签（在任意标签上点击右键可收藏 ★）'}</div>`;
        } else {
          visibleFavTags.forEach(t => { html += chipHTML(t, { subId: tagCatOf(t.en), listMode: 'fav' }); });
        }
        html += `</div>`;
      }
      html += `</div>`;
      count = Math.max(favCharsList.length + favTagItems.length, 1);
    } else if (state.cat === 'recent' || state.cat === 'char:recent') {
      // (2.2 Req 2 & Req 3) 最近：角色与 tag 两个子分类均配备独立清除按钮；角色完整保留单个角色所有提示词到一个框内，与角色库显示相同；tag 右侧带删除小按钮
      const recentCharsList = getRecentCharsList();
      const regTagKeys = state.recentTags || [];
      const regTagItems = regTagKeys.map(k => INDEX.get(k) || { en: k, zh: zhLookup(k) }).filter(Boolean);
      const isCharExp = (state.expandedSubs || []).indexOf('recent_char_sec') >= 0;
      const isTagExp = (state.expandedSubs || []).indexOf('recent_tag_sec') >= 0;

      html += `<div class="sub-section${isCharExp ? ' expanded' : ''}" data-sub-sec="recent_char_sec">
        <div class="sub-sec-head" data-toggle-sub="recent_char_sec" title="点击展开/收起最近使用的角色 · 右侧按钮或右键可单独清除">
          <span class="caret">▾</span>
          <span class="sub-ico">🧝</span>
          <span class="sub-nm">角色</span>
          <span class="sub-meta">${recentCharsList.length} 个最近角色</span>
          <button type="button" class="sub-sec-clear-btn" data-clear-sub-sec="recent_char" title="单独清除最近的角色">🗑 清除</button>
        </div>`;
      if (isCharExp) {
        html += `<div class="sub-sec-body">`;
        if (!recentCharsList.length) {
          html += `<div class="muted" style="padding:10px 4px">还没有最近套用的角色（点击角色卡片套用后自动记录在此）</div>`;
        } else {
          html += `<div class="char-big-grid">`;
          recentCharsList.forEach(c => { html += charBigCardHTML(c, { listMode: 'recent_char' }); });
          html += `</div>`;
        }
        html += `</div>`;
      }
      html += `</div>`;

      html += `<div class="sub-section${isTagExp ? ' expanded' : ''}" data-sub-sec="recent_tag_sec">
        <div class="sub-sec-head" data-toggle-sub="recent_tag_sec" title="点击展开/收起最近使用的常规 Tag · 右侧按钮或右键可单独清除">
          <span class="caret">▾</span>
          <span class="sub-ico">🏷</span>
          <span class="sub-nm">tag</span>
          <span class="sub-meta">${regTagItems.length} 个最近标签</span>
          <button type="button" class="sub-sec-clear-btn" data-clear-sub-sec="recent_tag" title="单独清除最近的 tag">🗑 清除</button>
        </div>`;
      if (isTagExp) {
        html += `<div class="sub-sec-body">`;
        const visibleRecTags = state.showNsfw !== false ? regTagItems : regTagItems.filter(t => !isNsfwTag(t.en, tagCatOf(t.en), t));
        if (!visibleRecTags.length) {
          html += `<div class="muted" style="padding:10px 4px">${regTagItems.length ? '已隐藏 NSFW (橙/红) 标签' : '还没有最近使用的常规标签'}</div>`;
        } else {
          visibleRecTags.forEach(t => { html += chipHTML(t, { subId: tagCatOf(t.en), listMode: 'recent' }); });
        }
        html += `</div>`;
      }
      html += `</div>`;
      count = Math.max(recentCharsList.length + regTagItems.length, 1);
    } else if (state.cat === 'custom' || String(state.cat || '').indexOf('cust_sub:') === 0) {
      // (2.7 Req 5) 自定义大分类中间部分套用其他大分类的 UI 格式：
      // 第一行：自定义角色（右侧显示「＋ 新增人物」和「🗑 删除」，下方显示自定义角色大图标）
      // 第二行起：自定义小分类（默认名称为「新增分类xx」，右侧显示「🗑 删除」，点击展开内部所有 tag，无 tag 时只显示「＋ 新增」按钮，最后一个小分类左下方显示「＋ 新增分类」）
      ensureCustomCategoriesStructure();
      const cs = selectedSet();
      const custChars = (state.customChars || []).map(ch => ({
        key: ch.key,
        name: ch.name,
        game: ch.game || '自定义角色',
        gameTag: 'custom',
        majorId: 'custom',
        subId: 'cust_char_sec',
        subName: '自定义角色',
        tag: ch.tag || '',
        charZh: ch.charZh || ch.name,
        desc: ch.desc || '',
        auto: Array.isArray(ch.auto) ? ch.auto : String(ch.autoRaw || ch.auto || '').split(/[;\n]+/).map(s => parsePair(s.trim())).filter(x => x.en)
      }));
      const isCharExp = (state.expandedSubs || []).indexOf('cust_char_sec') >= 0;
      const onCharCount = custChars.filter(c => state.chars.some(x => x.key === c.key)).length;
      count += custChars.length;

      html += `<div class="sub-section${isCharExp ? ' expanded' : ''}" data-sub-sec="cust_char_sec">
        <div class="sub-sec-head" data-toggle-sub="cust_char_sec" title="点击展开/收起自定义角色大图标">
          <span class="caret">▾</span>
          <span class="sub-ico">🧝</span>
          <span class="sub-nm">自定义角色</span>
          <span class="sub-meta">${onCharCount ? `已套用 ${onCharCount} / ` : ''}${custChars.length} 个角色</span>
          <button type="button" class="sub-head-btn" data-cust-char-act="add" title="新增自定义人物">＋ 新增人物</button>
          <button type="button" class="sub-head-btn danger" data-cust-char-act="clear" title="删除全部自定义角色">🗑 删除</button>
        </div>`;
      if (isCharExp) {
        html += `<div class="sub-sec-body">`;
        if (!custChars.length) {
          html += `<div class="muted" style="padding:10px 4px">暂无自定义人物，点击本行右侧「＋ 新增人物」即可创建</div>`;
        } else {
          html += `<div class="char-big-grid">`;
          custChars.forEach(c => { html += charBigCardHTML(c, { listMode: 'custom_char' }); });
          html += `</div>`;
        }
        html += `</div>`;
      }
      html += `</div>`;

      (state.customTagCats || []).forEach(tc => {
        const isExp = (state.expandedSubs || []).indexOf(tc.id) >= 0;
        const isEditing = state.editingSubId === tc.id;
        const onCount = (tc.tags || []).filter(t => cs.has(norm(t.en))).length;
        count += (tc.tags || []).length;

        html += `<div class="sub-section${isExp ? ' expanded' : ''}" data-sub-sec="${esc(tc.id)}" data-cust-tag-cat="${esc(tc.id)}">
          <div class="sub-sec-head" data-toggle-sub="${esc(tc.id)}" title="点击展开/收起 · 双击或右键可重命名">
            <span class="caret">▾</span>
            <span class="sub-ico">${esc(tc.icon || '🏷')}</span>`;
        if (isEditing) {
          html += `<input type="text" class="inline-rename-input" id="inlineSubInput" data-sub-id="${esc(tc.id)}" value="${esc(tc.name)}" maxlength="30">`;
        } else {
          html += `<span class="sub-nm">${esc(tc.name)}</span>`;
        }
        html += `<span class="sub-meta">${onCount ? `已选 ${onCount} / ` : ''}${(tc.tags || []).length} 个标签</span>
            <button type="button" class="sub-head-btn danger" data-cust-tag-del="${esc(tc.id)}" title="删除此自定义小分类">🗑 删除</button>
          </div>`;
        if (isExp) {
          html += `<div class="sub-sec-body">`;
          (tc.tags || []).forEach(t => {
            if (state.showNsfw === false && isNsfwTag(t.en, tc.id, t)) return;
            html += chipHTML(t, { custom: true, subId: tc.id });
          });
          html += `<button type="button" class="chip chip-add" data-sub-add-tag="${esc(tc.id)}" title="在此小分类末尾新增提示词">＋ 新增</button>`;
          html += `</div>`;
        }
        html += `</div>`;
      });

      html += `<div class="content-foot-bar">
        <button type="button" id="btnAddCustomSubBottom" class="btn-add-sub-bottom" data-cust-act="add-tag-cat" title="在最后一个小分类下方新增自定义小分类">
          <span>＋</span><span>新增分类</span>
        </button>
      </div>`;
      count = Math.max(count, 1);
    } else {
      let subsToShow = [];
      let currentMajorId = '';
      const isNsfwMappedView = (state.cat === 'nsfw_all' || String(state.cat).indexOf('nsfw_major:') === 0 || String(state.cat).indexOf('nsfw_sub:') === 0);
      if (state.cat === 'nsfw_all') {
        subsToShow = getMappedNsfwSubcategories();
        currentMajorId = 'nsfw_mapped';
      } else if (String(state.cat).indexOf('nsfw_major:') === 0) {
        const targetMid = String(state.cat).slice(11);
        subsToShow = getMappedNsfwSubcategories().filter(x => x.parentId === targetMid);
        currentMajorId = 'nsfw_mapped';
      } else if (String(state.cat).indexOf('nsfw_sub:') === 0) {
        const targetSid = String(state.cat).slice(9);
        const mapped = getMappedNsfwSubcategories().find(x => x.id === targetSid);
        subsToShow = mapped ? [mapped] : [];
        currentMajorId = 'nsfw_mapped';
      } else if (state.cat === 'all') {
        subsToShow = visibleCats();
        currentMajorId = (MAJORS[0] && MAJORS[0].id) || '';
      } else if (String(state.cat).indexOf('major:') === 0) {
        currentMajorId = String(state.cat).slice(6);
        const m = visibleMajors().find(x => x.id === currentMajorId);
        subsToShow = m ? m.children : [];
      } else {
        const c = visibleCats().find(x => x.id === state.cat);
        if (c) {
          subsToShow = [c];
          currentMajorId = c.parentId || '';
        } else {
          subsToShow = visibleCats();
        }
      }

      const cs = selectedSet();
      subsToShow.forEach(c => {
        const expKey = isNsfwMappedView ? ('nsfw_map_' + c.id) : c.id;
        const isExp = (state.expandedSubs || []).indexOf(expKey) >= 0;
        const onCount = c.tags.filter(t => cs.has(norm(t.en))).length;
        const isEditingSub = state.editingSubId === c.id;
        count += c.tags.length;

        html += `<div class="sub-section${isExp ? ' expanded' : ''}" data-sub-sec="${esc(c.id)}" data-exp-key="${esc(expKey)}" data-parent-mid="${esc(c.parentId || '')}">
          <div class="sub-sec-head" draggable="${(isNsfwMappedView || isEditingSub) ? 'false' : 'true'}" data-toggle-sub="${esc(expKey)}" data-sub-ctx="${esc(c.id)}" title="点击展开/收起 · 右键管理小分类">
            ${isNsfwMappedView ? '' : '<span class="sub-grip" title="按住拖动排序">⋮⋮</span>'}
            <span class="caret">▾</span>
            <span class="sub-ico">${esc(c.icon)}</span>`;
        if (isEditingSub) {
          html += `<input type="text" class="inline-rename-input" id="inlineSubInput" data-sid="${esc(c.id)}" value="${esc(c.name)}" maxlength="30" style="max-width:240px">`;
        } else {
          html += `<span class="sub-nm">${(state.cat === 'all' || isNsfwMappedView) && c.parentName ? `<span class="muted" style="font-weight:400">${esc(c.parentName)} › </span>` : ''}${esc(c.name)}</span>`;
        }
        html += `<span class="sub-meta">${onCount ? `已选 ${onCount} / ` : ''}${c.tags.length} 个标签</span>
          </div>`;
        if (isExp) {
          html += `<div class="sub-sec-body">`;
          html += renderSubTagsWithPagination(c.tags, c.id, false);
          html += `<button type="button" class="chip chip-add" data-sub-add-tag="${esc(c.id)}" title="在此小分类末尾新增单个提示词（同步写入原属小分类）">＋ 新增</button>`;
          html += `</div>`;
        }
        html += `</div>`;
      });

      if (state.cat !== 'all' && !isNsfwMappedView) {
        html += `<div class="content-foot-bar">
          <button type="button" id="btnAddSubBottom" class="btn-add-sub-bottom" data-parent-mid="${esc(currentMajorId)}" title="在当前大分类下新增一个二级小分类">
            <span>＋</span><span>新增小分类</span>
          </button>
        </div>`;
      }
      count = Math.max(count, 1);
    }

    el.grid.innerHTML = html;
    el.empty.hidden = count > 0;
    let totalShownTags = TOTAL_TAGS;
    if (state.cat === 'fav' || state.cat === 'char:fav') {
      totalShownTags = getFavCharsList().length + (state.favTags ? state.favTags.length : 0);
    } else if (state.cat === 'recent' || state.cat === 'char:recent') {
      totalShownTags = getRecentCharsList().length + (state.recentTags ? state.recentTags.length : 0);
    } else if (String(state.cat).indexOf('major:') === 0) {
      const m = visibleMajors().find(x => x.id === String(state.cat).slice(6));
      totalShownTags = m ? (m.children || []).reduce((n, s) => n + (s.tags ? s.tags.length : 0), 0) : 0;
    } else if (state.cat === 'custom') {
      totalShownTags = state.custom.length;
    } else if (state.cat === 'nsfw_all') {
      totalShownTags = getMappedNsfwSubcategories().reduce((n, s) => n + s.tags.length, 0);
    } else if (String(state.cat).indexOf('nsfw_major:') === 0) {
      const targetMid = String(state.cat).slice(11);
      totalShownTags = getMappedNsfwSubcategories().filter(x => x.parentId === targetMid).reduce((n, s) => n + s.tags.length, 0);
    }
    el.resultCount.textContent = state.q.trim() ? `${count} 项` : `共 ${totalShownTags} 项`;

    let title = '';
    if (state.q.trim()) title = `搜索：${state.q.trim()}`;
    else if (state.cat === 'custom') title = `⭐ 自定义（${state.custom.length} 个标签）`;
    else if (state.cat === 'nsfw_all') title = `🔞 NSFW 映射分区（${totalShownTags} 个标签）`;
    else if (String(state.cat).indexOf('nsfw_major:') === 0) {
      const targetMid = String(state.cat).slice(11);
      const mObj = getMappedNsfwMajors().find(x => x.id === targetMid);
      title = mObj ? `🔞 NSFW › ${mObj.icon} ${mObj.name}` : '🔞 NSFW';
    }
    else if (String(state.cat).indexOf('nsfw_sub:') === 0) {
      const mSub = getMappedNsfwSubcategories().find(x => x.id === String(state.cat).slice(9));
      title = mSub ? `🔞 NSFW › ${mSub.parentName} › ${mSub.name}（${mSub.tags.length} 个标签）` : '🔞 NSFW';
    }
    else if (state.cat === 'all') title = `全部（${TOTAL_TAGS} 个标签）`;
    else if (state.cat === 'char:games') title = `🧝 角色库 › 🎮 游戏（${ getGameSubSections().length } 个游戏分类）`;
    else if (state.cat === 'char:anime') title = `🧝 角色库 › 📺 番剧`;
    else if (state.cat === 'char:vtuber') title = `🧝 角色库 › 🎤 VTuber`;
    else if (state.cat === 'fav' || state.cat === 'char:fav') title = `★ 收藏（${getFavCharsList().length} 个角色 / ${(state.favTags || []).length} 个 tag）`;
    else if (state.cat === 'recent' || state.cat === 'char:recent') title = `🕘 最近（${getRecentCharsList().length} 个角色 / ${(state.recentTags || []).length} 个 tag）`;
    else if (String(state.cat).indexOf('major:') === 0) {
      const m = visibleMajors().find(x => x.id === String(state.cat).slice(6)) || MAJORS.find(x => x.id === String(state.cat).slice(6));
      const mTagTotal = m ? (m.children || []).reduce((n, s) => n + (s.tags ? s.tags.length : 0), 0) : 0;
      title = m ? `${m.icon} ${m.name}` : '';
    } else {
      const c = CATS.find(x => x.id === state.cat);
      title = c ? `${c.parentName ? c.parentName + ' › ' : ''}${c.name}（${(c.tags || []).length} 个标签）` : '';
    }
    el.catTitle.textContent = title;

    if (state.editingSubId) {
      const inp = document.getElementById('inlineSubInput');
      if (inp) {
        setTimeout(() => { inp.focus(); inp.select(); }, 10);
      }
    }

    syncToggleAllSubsBtn();
    hydrateCharCardImages();
    autoTrScan();
  }

  function fmtW(w) {
    const n = Number(Number(w || 1).toFixed(2));
    return Number.isInteger(n) ? n.toFixed(1) : n.toString();
  }

  /* 按语义顺序排好的视图（不改动原始数组，勾选先后仍被保留） */
  function viewList(list) {
    if (!state.autoOrder) return list;
    return list
      .map((it, i) => ({ it, i }))
      .sort((a, b) => rankOf(a.it) - rankOf(b.it) || a.i - b.i)
      .map(x => x.it);
  }

  /* (Req 6) 拖动后按显示顺序写回原始列表，并自动取消语义排序 */
  function reorderSelItem(fromKey, toKey, after) {
    const list = currentList();
    const ordered = viewList(list).slice();
    const fi = ordered.findIndex(x => x.key === fromKey);
    if (fi < 0) return;
    const [moved] = ordered.splice(fi, 1);
    const targetItem = ordered.find(x => x.key === toKey);
    if (state.mode === 'pos' && Array.isArray(state.chars) && state.chars.length) {
      const findOwner = it => {
        if (!it) return null;
        return state.chars.find(ch => it.fromCharKey === ch.key || (ch.tags || []).some(t => norm(t) === it.key || norm(t) === norm(cleanArtistEn(it.en)))) || null;
      };
      const fromOwner = findOwner(moved);
      const toOwner = findOwner(targetItem);
      if (fromOwner && (!toOwner || toOwner.key !== fromOwner.key)) {
        delete moved.fromCharKey;
        fromOwner.tags = (fromOwner.tags || []).filter(t => norm(t) !== moved.key && norm(t) !== norm(cleanArtistEn(moved.en)));
        if (toOwner) {
          moved.fromCharKey = toOwner.key;
          if (!(toOwner.tags || []).some(t => norm(t) === moved.key)) {
            toOwner.tags = (toOwner.tags || []).concat([moved.en || moved.key]);
          }
        }
      }
    }
    let ti = ordered.findIndex(x => x.key === toKey);
    if (ti < 0) { ordered.push(moved); }
    else { if (after) ti += 1; ordered.splice(ti, 0, moved); }
    state.autoOrder = false;
    if ($('#chkOrder')) $('#chkOrder').checked = false;
    list.length = 0;
    ordered.forEach(x => list.push(x));
  }

  function normalizeSafetyInList(list, mMode, forceAllowNsfw) {
    if (mMode !== 'pos' || !Array.isArray(list) || !list.length) return list;
    const safetyRank = { safe: 1, 'rating:safe': 1, general: 1, 'rating:general': 1, sensitive: 2, 'rating:sensitive': 2, nsfw: 3, questionable: 3, 'rating:questionable': 3, explicit: 4, 'rating:explicit': 4 };
    let hasSafetyItem = false;
    let hasNsfwContent = false;
    list.forEach(it => {
      const k = norm(it && it.en).replace(/_/g, ' ');
      if (safetyRank[k]) {
        hasSafetyItem = true;
      } else if (typeof isNsfwTag === 'function' && isNsfwTag(it && it.en, it && it.subId)) {
        hasNsfwContent = true;
      }
    });
    if (!hasSafetyItem) return list;
    // (V1.2.1 Official Anima Rule) 仅在开启 nsfw 开关或列表中含 NSFW 标签时选择 nsfw，否则一律选择 safe
    const useNsfw = (typeof forceAllowNsfw === 'boolean') ? forceAllowNsfw : hasNsfwContent;
    const targetSafetyEn = useNsfw ? 'nsfw' : 'safe';
    let safetyEmitted = false;
    const out = [];
    list.forEach(it => {
      const k = norm(it && it.en).replace(/_/g, ' ');
      if (safetyRank[k]) {
        if (!safetyEmitted) {
          safetyEmitted = true;
          const zhMap = { safe: '安全级', sensitive: '敏感级', nsfw: '成人内容', explicit: '露骨内容' };
          out.push({ ...it, en: targetSafetyEn, key: targetSafetyEn, zh: zhMap[targetSafetyEn] || it.zh });
        }
      } else {
        out.push(it);
      }
    });
    return out;
  }

  function buildText(list, modeOverride) {
    const cfg = modelCfg();
    const activeOnly = (list || []).filter(it => it && !it.disabled);
    if (!activeOnly.length) return '';
    const mMode = modeOverride || state.mode;
    let pre = '';
    let items = normalizeSafetyInList(activeOnly, mMode);
    if (mMode === 'pos' && state.modelPrefix && cfg.prefix) {
      const preTokens = String(cfg.prefix).split(',').map(x => x.trim()).filter(Boolean);
      const existKeys = new Set(items.map(it => norm(it.en)));
      const extraPre = [];
      preTokens.forEach(tok => {
        const k = norm(tok);
        if (k && !existKeys.has(k)) {
          existKeys.add(k);
          extraPre.push({ en: tok, key: k, zh: zhLookup(tok) || '', w: 1 });
        }
      });
      items = normalizeSafetyInList(extraPre.concat(items), mMode);
      if (state.autoOrder) {
        items = items.map((it, i) => ({ it, i })).sort((a, b) => rankOf(a.it) - rankOf(b.it) || a.i - b.i).map(x => x.it);
      }
    }
    const body = items.map(it => {
      let en = formatRightEn(it.en, '', mMode);
      if (cfg.plainSyntax || state.syntax === 'plain') return en;
      if (state.syntax === 'nai') {
        const w = it.w || 1;
        if (w > 1.001) {
          const n = clamp(Math.round((w - 1) / 0.05), 1, 8);
          return '{'.repeat(n) + en + '}'.repeat(n);
        }
        if (w < 0.999) {
          const n = clamp(Math.round((1 - w) / 0.05), 1, 8);
          return '['.repeat(n) + en + ']'.repeat(n);
        }
        return en;
      }
      if (state.syntax === 'anima') {
        if (it.w && Math.abs(it.w - 1) > 0.001) return '(' + en + ':' + fmtW(it.w) + ')';
        return en;
      }
      if (state.escape) en = en.replace(/[()[\]]/g, m => '\\' + m);
      if (it.w && Math.abs(it.w - 1) > 0.001) return '(' + en + ':' + fmtW(it.w) + ')';
      return en;
    }).join(cfg.sep || ', ');
    return pre + body;
  }

  function renderSelected() {
    const list = viewList(currentList());
    const isPos = (state.mode === 'pos');
    const activeChars = isPos ? (state.chars || []) : [];

    if (!list.length && !activeChars.length) {
      el.selList.innerHTML = `<div class="sel-empty">${isPos
        ? '还没有选择提示词<br>点左侧标签即可加入（Shift+点击 = 权重 1.2）'
        : '负面提示词为空<br>切到「负面」后可以挑选禁忌项'}</div>`;
    } else {
      const lockSvgOn = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7.2" width="9" height="6.8" rx="1.6"/><path d="M5.2 7.2V5a2.8 2.8 0 0 1 5.6 0v2.2"/><circle cx="8" cy="10.6" r="0.9" fill="currentColor" stroke="none"/></svg>';
      const lockSvgOff = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7.2" width="9" height="6.8" rx="1.6"/><path d="M5.2 7.2V5a2.8 2.8 0 0 1 5.3-1.2"/></svg>';

      // (2.6 Req 3) 将属于已套用角色的 tag 归入角色整体条目内展示（支持单击展开/收起，角色可上锁，子 tag 不可单独上锁）
      const charOwnedKeys = new Set();
      const charGroupsMap = new Map();
      activeChars.forEach(ch => {
        const cKeySet = new Set((ch.tags || []).map(k => norm(k)));
        const children = list.filter(it => it.fromCharKey === ch.key || cKeySet.has(it.key) || cKeySet.has(norm(cleanArtistEn(it.en))));
        children.forEach(it => charOwnedKeys.add(it.key));
        charGroupsMap.set(ch.key, { charObj: ch, children });
      });

      const renderCharGroupHTML = ch => {
        const bundle = charGroupsMap.get(ch.key);
        const children = (bundle && bundle.children) || [];
        const hitC = CHARS.find(x => x.key === ch.key) || findCustomCharByKey(ch.key);
        const catLabel = ch.game || (hitC && hitC.game) || '角色';
        const charName = ch.name || (hitC && hitC.name) || ch.key;
        const fullTitle = `${catLabel} ${charName}`.trim();
        const isExp = !!ch.expanded;
        const isLocked = !!ch.locked;

        const childrenHtml = children.map(it => {
          const rCode = getTagRating(it.en, it.subId);
          const isNsfw = (rCode !== 'g');
          const dispEn = formatRightEn(it.en, it.subId, state.mode);
          const zhSpan = state.showZh ? trSpan(it.en, it.zh) : '';
          const childTip = getTagHoverTip(it, it.subId);
          return `<div class="sel-item sel-char-child rating-${rCode} ${isNsfw ? 'nsfw-sel-item' : ''}${it.disabled ? ' is-disabled' : ''}" draggable="true" data-key="${esc(it.key)}" data-parent-char="${esc(ch.key)}" data-hover-tip="${esc(childTip)}" title="${esc(childTip)}">
            <span class="sel-grip">⋮⋮</span>
            <span class="sel-txt"><span class="en">${esc(dispEn)}</span>${zhSpan}</span>
            ${it.w && Math.abs(it.w - 1) > 0.001 ? `<span class="sel-w">×${fmtW(it.w)}</span>` : ''}
            <button type="button" data-act="dec" title="权重 -0.05">−</button>
            <button type="button" data-act="inc" title="权重 +0.05">＋</button>
            <button type="button" class="del" data-act="del" title="移除此条角色标签">×</button>
          </div>`;
        }).join('');

        const charHover = getCharHoverTip(hitC || ch) || fullTitle;
        return `<div class="sel-char-wrap" data-char-group="${esc(ch.key)}">
          <div class="sel-item sel-char-head ${isLocked ? 'is-locked' : ''}" data-char-toggle="${esc(ch.key)}" data-hover-tip="${esc(charHover)}" title="${esc(charHover)}">
            <span class="sel-char-caret">${isExp ? '▾' : '▸'}</span>
            <span class="sel-seg-badge">角色</span>
            <span class="sel-txt"><span class="en">${esc(fullTitle)}</span></span>
            <span class="sel-char-count">${children.length} 项</span>
            <button type="button" class="lock ${isLocked ? 'lock-on' : ''}" data-char-act-row="lock" data-ckey="${esc(ch.key)}" title="${isLocked ? '已锁定角色整体：清空或快捷抽词时保留该角色；点击取消上锁' : '上锁该角色整体（角色可上锁，所属子标签不可单独上锁）'}">${isLocked ? lockSvgOn : lockSvgOff}</button>
            <button type="button" class="del" data-char-act-row="del" data-ckey="${esc(ch.key)}" title="移除角色「${esc(fullTitle)}」及其所属标签">×</button>
          </div>
          <div class="sel-char-children" ${isExp ? '' : 'hidden'}>
            ${childrenHtml || '<div class="muted small" style="padding:4px 6px">暂无子标签</div>'}
          </div>
        </div>`;
      };

      const renderNormalItemHTML = it => {
        const rCode = state.mode !== 'neg' ? getTagRating(it.en, it.subId) : 'g';
        const isNsfw = state.mode !== 'neg' && (rCode !== 'g');
        const dispEn = formatRightEn(it.en, it.subId, state.mode);
        const zhSpan = state.showZh ? trSpan(it.en, it.zh) : '';
        const itemHover = getTagHoverTip(it, it.subId);
        return `<div class="sel-item ${state.mode === 'neg' ? 'neg' : 'rating-' + rCode}${isNsfw ? ' nsfw-sel-item' : ''}${it.kind === 'text' ? ' text-item' : ''}${it.locked ? ' is-locked' : ''}${it.disabled ? ' is-disabled' : ''}" draggable="true" data-key="${esc(it.key)}" data-hover-tip="${esc(itemHover)}" title="${esc(itemHover)}">
          <span class="sel-grip">⋮⋮</span>
          <span class="sel-txt">${it.kind === 'text' ? '<span class="txt-badge">📝</span>' : ''}<span class="sel-seg-badge">${esc(getPromptSegmentInfo(it).label)}</span><span class="en">${esc(dispEn)}</span>${zhSpan}</span>
          ${it.w && Math.abs(it.w - 1) > 0.001 ? `<span class="sel-w">×${fmtW(it.w)}</span>` : ''}
          <button type="button" data-act="dec" title="权重 -0.05">−</button>
          <button type="button" data-act="inc" title="权重 +0.05">＋</button>
          <button type="button" class="lock ${it.locked ? 'lock-on' : ''}" data-act="lock" title="${it.locked ? '已固定：随机抽取时自动扣减所属分类抽取名额；点击取消固定' : '固定该标签：随机抽取时自动扣减所属分类抽取名额，避免重复抽取同分类'}">${it.locked ? lockSvgOn : lockSvgOff}</button>
          <button type="button" class="del" data-act="del" title="移除">×</button>
        </div>`;
      };

      const standaloneList = list.filter(it => !charOwnedKeys.has(it.key));
      let htmlRows = [];
      let charsInserted = false;

      standaloneList.forEach(it => {
        if (isPos && !charsInserted && activeChars.length && rankOf(it) > 79) {
          activeChars.forEach(ch => htmlRows.push(renderCharGroupHTML(ch)));
          charsInserted = true;
        }
        htmlRows.push(renderNormalItemHTML(it));
      });
      if (isPos && !charsInserted && activeChars.length) {
        activeChars.forEach(ch => htmlRows.push(renderCharGroupHTML(ch)));
      }

      el.selList.innerHTML = htmlRows.join('');
    }
    renderOutput();
    renderNav();
    renderCoocRecommendations();
  }

  function renderOutput() {
    const list = viewList(currentList());
    const text = buildText(list);
    if (document.activeElement !== el.output) el.output.value = text;
    if ($('#rightSidebarBadge')) $('#rightSidebarBadge').textContent = String((state.sel ? state.sel.length : 0) + (state.neg ? state.neg.length : 0));
    el.outStat.textContent = `${list.length} 个标签`;
    updateWarn();
    updateMossCaption();
  }

  const CONFLICTS = [
    ['1girl', '1boy', '同时选了 1girl 与 1boy'],
    ['1girl', '2boys', '同时选了 1girl 与 2boys'],
    ['solo', 'multiple girls', 'solo 与 multiple girls 冲突'],
    ['closed eyes', 'looking at viewer', '闭眼与看向观者通常矛盾'],
    ['day', 'night', '白天与夜晚冲突'],
    ['indoors', 'outdoors', '室内与室外冲突'],
    ['summer', 'winter', '夏天与冬天冲突'],
    ['full body', 'close-up', '全身与特写冲突']
  ];

  function updateWarn() {
    const set = new Set(state.sel.map(i => i.key));
    const hits = CONFLICTS.filter(([a, b]) => set.has(norm(a)) && set.has(norm(b))).map(c => c[2]);
    el.warn.hidden = hits.length === 0;
    el.warn.textContent = hits.length ? '⚠ ' + hits.join('；') : '';
  }

  function renderCharChip() {
    // (2.6 Req 3) 角色已在右侧列表中作为整体折叠条目显示（所属大分类+名称），不再在上方重复渲染小胶囊
    if (el.charChip) {
      el.charChip.hidden = true;
      el.charChip.innerHTML = '';
    }
    return;
    el.charChip.hidden = false;
    const chips = state.chars.map(c => {
      const hit = CHARS.find(x => x.key === c.key);
      const nm = hit ? hit.name : (c.name || c.key);
      return '<span class="char-chip" data-cchar="' + esc(c.key) + '" title="点一下移除「' + esc(nm) + '」">🧝 ' + esc(nm) + ' ⨯</span>';
    });
    if (state.chars.length > 1) {
      chips.push('<span class="char-chip chip-all" data-cchar="__all" title="解除全部角色联动">全部解除</span>');
    }
    el.charChip.innerHTML = chips.join('');
  }

  /* =====================================================================
     5. 操作
     ===================================================================== */

  function addTag(en, zh, weight, kind, subId, recentMode) {
    const list = currentList();
    const clean = cleanArtistEn(en);
    const k = norm(clean);
    if (!k) return false;
    if (list.some(i => i.key === k || norm(cleanArtistEn(i.en)) === k)) return false;
    const outEn = formatRightEn(en, subId, state.mode);
    const it = { key: k, en: outEn, zh: zh || zhLookup(clean) || zhLookup(en), w: weight || 1 };
    if (kind) it.kind = kind;
    list.push(it);
    if (recentMode === 'char-auto') {
      touchRecentCharTag(clean);
    } else if (recentMode !== 'skip') {
      touchRecent(clean);
    }
    queueTr(clean);
    return true;
  }

  function toggleTag(en, shift, subId) {
    const list = currentList();
    const clean = cleanArtistEn(en);
    const k = norm(clean);
    const i = list.findIndex(x => x.key === k || norm(cleanArtistEn(x.en)) === k);
    if (i >= 0) {
      recordHistorySnapshot(`取消勾选: ${list[i].en}`);
      list.splice(i, 1);
    } else {
      const outEn = formatRightEn(en, subId, state.mode);
      recordHistorySnapshot(`勾选提示词: ${outEn}`);
      list.push({ key: k, en: outEn, zh: zhLookup(clean) || zhLookup(en), w: shift ? 1.2 : 1 });
      touchRecent(clean);
      queueTr(clean);
    }
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), 1600);
  }

  async function copyText(text) {
    if (!text) { toast('还没有内容可以复制'); return; }
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制到剪贴板');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('已复制到剪贴板'); }
      catch (e2) { toast('复制失败，请手动选中文本'); }
      document.body.removeChild(ta);
    }
  }

  /* ---------- 角色 ---------- */

  /* 把角色本体 + 其服饰/发饰/体型标签一起放进已选，
     返回实际新增的自动标签条数。手动点角色和 AI 选词都走这里。 */
  /* 所有角色自带的标签并集（给别处判断"这个标签是角色带进来的"用） */
  function syncCharTags() {
    const s = new Set();
    (state.chars || []).forEach(c => (c.tags || []).forEach(t => s.add(t)));
    stateCharTags = [...s];
    return stateCharTags;
  }

  /* 同一个角色重复套用只留一份；不同角色可以同时存在，标签是叠加的 */
  function expandCharacter(c) {
    if (!c || (!c.tag && (!c.auto || !c.auto.length) && !c.name)) return 0;
    state.chars = state.chars.filter(x => x.key !== c.key);
    const tags = [];
    let added = 0;
    touchRecentChar(c.key);
    const addCharSubTag = (en, zh, subHint) => {
      const clean = cleanArtistEn(en);
      const k = norm(clean);
      if (!k) return;
      tags.push(k);
      const existing = state.sel.find(i => i.key === k || norm(cleanArtistEn(i.en)) === k);
      if (existing) {
        if (!existing.fromCharKey) existing.fromCharKey = c.key;
      } else {
        addTag(en, zh, 1, '', subHint || '', 'skip');
        const newlyAdded = state.sel.find(i => i.key === k || norm(cleanArtistEn(i.en)) === k);
        if (newlyAdded) newlyAdded.fromCharKey = c.key;
        added++;
      }
    };
    if (c.tag && String(c.tag).trim()) addCharSubTag(c.tag, c.charZh, 'char');
    (c.auto || []).forEach(a => {
      addCharSubTag(a.en, a.zh, '');
    });
    state.chars.push({
      key: c.key,
      name: c.name,
      game: c.game || c.subName || '角色',
      tag: c.tag,
      charZh: c.charZh,
      tags: tags,
      expanded: false,
      locked: false
    });
    syncCharTags();
    return added;
  }

  /* 只摘掉一个角色：它带进来的标签要收走，但别的角色也在用的标签留着 */
  function removeCharacter(key) {
    const i = state.chars.findIndex(x => x.key === key);
    if (i < 0) return;
    recordHistorySnapshot('移除已套用角色');
    const c = state.chars[i];
    const gone = new Set(c.tags || []);
    state.chars.splice(i, 1);
    const keep = new Set();
    state.chars.forEach(x => (x.tags || []).forEach(t => keep.add(t)));
    gone.forEach(t => {
      if (keep.has(t)) return;
      state.sel = state.sel.filter(it => it.key !== t);
      state.neg = state.neg.filter(it => it.key !== t);
    });
    syncCharTags();
    renderSelected();
    renderGrid();
    renderCharChip();
    save();
    toast('已移除角色「' + (c.name || key) + '」');
  }

  function markCharAsSeen(charKey) {
    if (!charKey) return;
    if (!(state.seenNewCharsSet instanceof Set)) state.seenNewCharsSet = new Set(state.seenNewChars || []);
    if (state.seenNewCharsSet.has(charKey)) return;
    state.seenNewCharsSet.add(charKey);
    state.seenNewChars = Array.from(state.seenNewCharsSet);
    const c = (CHARS || []).find(x => x && x.key === charKey);
    if (c) delete c.isNew;
    try {
      $$('.char-big-card[data-char="' + CSS.escape(charKey) + '"] .char-new-dot').forEach(dot => dot.remove());
    } catch (e) {
      $$('.char-big-card .char-new-dot').forEach(dot => {
        const card = dot.closest('.char-big-card');
        if (card && card.getAttribute('data-char') === charKey) dot.remove();
      });
    }
    save();
  }

  function applyCharacter(key) {
    const c = CHARS.find(x => x.key === key) || findCustomCharByKey(key);
    if (!c) return;
    markCharAsSeen(key);
    if (state.chars.some(x => x.key === key)) {
      removeCharacter(key);
      return;
    }
    recordHistorySnapshot(`套用角色: ${c.name}`);

    expandCharacter(c);
    state.mode = 'pos';
    syncModeSeg();
    closeModal('modalChar');
    renderSelected();
    renderGrid();
    renderCharChip();
    save();
    const total = state.chars.length;
    toast(`已套用「${c.name}」及其 ${c.auto.length} 项外观标签`
      + (total > 1 ? `（现在同时有 ${total} 个角色）` : ''));
  }

  function clearCharacter() {
    if (!state.chars.length) return;
    recordHistorySnapshot('解除全部角色');
    const old = new Set(stateCharTags);
    state.sel = state.sel.filter(it => !old.has(it.key));
    state.chars = [];
    stateCharTags = [];
    renderSelected();
    renderGrid();
    renderCharChip();
    save();
    toast('已解除全部角色联动');
  }

  /* ---------- 预设 ---------- */

  function applyPreset(key) {
    const p = PRESETS.find(x => x.key === key);
    if (!p) return;
    recordHistorySnapshot(`套用预设: ${p.name}`);
    let n = 0;
    p.tags.forEach(t => { if (addTag(t.en, t.zh, 1)) n++; });
    state.mode = 'pos';
    syncModeSeg();
    closeModal('modalPreset');
    renderSelected();
    renderGrid();
    save();
    toast(`已应用预设「${p.name}」，新增 ${n} 个标签`);
  }

  /* ---------- 提示词存档（V7 重做：支持新增自定义存档、编辑、搜索、载入与带二次确认的删除，并同步至 user-data.json） ---------- */

  const SAVES_KEY = 'pg_saves_v120';

  function readSaves() {
    try {
      const extU = window.PG_TAG_FS && window.PG_TAG_FS.userData;
      if (extU && Array.isArray(extU.saves) && extU.saves.length) {
        return extU.saves.filter(x => x && x.id);
      }
      const d = JSON.parse(localStorage.getItem(SAVES_KEY) || '[]');
      return Array.isArray(d) ? d.filter(x => x && x.id) : [];
    } catch (e) { return []; }
  }

  const SAVES = readSaves();

  function syncUserDataToExternalFile(saveWorkspace) {
    if (!window.PG_TAG_FS || typeof window.PG_TAG_FS.persistUserData !== 'function') return;
    const includeWs = (typeof saveWorkspace === 'boolean') ? saveWorkspace : !!state.autosave;
    const prevUd = (window.PG_TAG_FS && window.PG_TAG_FS.userData) || {};
    window.PG_TAG_FS.persistUserData({
      nsfwCustomOn: Array.from(state.nsfwCustomOn || []),
      nsfwCustomOff: Array.from(state.nsfwCustomOff || []),
      favTags: state.favTags || [],
      recentTags: state.recentTags || [],
      favChars: state.favChars || [],
      recentChars: state.recentChars || [],
      recentCharTags: state.recentCharTags || [],
      history: state.history || [],
      saves: SAVES || [],
      custom: state.custom || [],
      customCharCats: state.customCharCats || [],
      customTagCats: state.customTagCats || [],
      seenNewTags: Array.from(state.seenNewTagsSet || state.seenNewTags || []),
      sel: includeWs ? (state.sel || []) : (prevUd.sel || []),
      neg: includeWs ? (state.neg || []) : (prevUd.neg || []),
      chars: includeWs ? (state.chars || []) : (prevUd.chars || []),
      randCfg: state.randCfg || {},
      ratingOverrides: state.ratingOverrides || {},
      customChars: state.customChars || [],
      charCustomSubs: state.charCustomSubs || [],
      charDeletedSubs: state.charDeletedSubs || [],
      _custTagCatsInited: !!state._custTagCatsInited,
      charDescMap: state.charDescMap || {},
      impStage: (typeof _impStage !== 'undefined' && _impStage) ? _impStage : { groups: [] },
      settings: {
        settingsVersion: 3.5,
        theme: document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : (state.theme || 'dark'),
        logoStyle: state.logoStyle || (localStorage.getItem('pg_logo_style') === 'dp' ? 'dp' : 'chibi'),
        autosave: state.autosave,
        autoTr: state.autoTr,
        showZh: state.showZh,
        showNsfw: state.showNsfw,
        autoOrder: state.autoOrder,
        mossMode: state.mossMode,
        rightSidebarOpen: state.rightSidebarOpen,
        online: state.online,
        forceOnline: state.forceOnline
      }
    });
  }

  function persistSaves() {
    try { localStorage.setItem(SAVES_KEY, JSON.stringify(SAVES)); }
    catch (e) { toast('存档太多，浏览器存不下了'); }
    syncUserDataToExternalFile();
  }

  function nowText() {
    const d = new Date();
    const p2 = n => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) +
      ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }

  function copyItems(list) {
    return (list || []).map(x => {
      const it = { en: x.en, zh: x.zh || '', w: typeof x.w === 'number' ? x.w : 1 };
      if (x.kind) it.kind = x.kind;
      return it;
    });
  }

  function parsePromptTextToItems(rawText) {
    const res = [];
    const seen = new Set();
    String(rawText || '').split(/[,，\n]+/).map(s => s.trim()).filter(Boolean).forEach(seg => {
      let s = seg;
      let w = 1;
      const m = s.match(/^\\((.+):(-?\\d+(?:\\.\\d+)?)\\)$/);
      if (m) {
        s = m[1].trim();
        w = clamp(parseFloat(m[2]) || 1, 0.1, 2);
      }
      const clean = cleanArtistEn(s);
      const k = norm(clean || s);
      if (!k || seen.has(k)) return;
      seen.add(k);
      res.push({
        key: k,
        en: s,
        zh: zhLookup(clean) || zhLookup(s) || '',
        w
      });
    });
    return res;
  }

  function saveSummary(s) {
    const n = (s.sel || []).length;
    const m = (s.neg || []).length;
    const names = (Array.isArray(s.chars) ? s.chars : (s.char ? [s.char] : [])).map(x => x && x.name).filter(Boolean);
    const c = names.length ? ' · 角色: ' + names.join(' + ') : '';
    return n + ' 个正向' + (m ? ' / ' + m + ' 个负面' : '') + c;
  }

  function renderSaves() {
    const list = $('#saveList');
    if (!list) return;
    const q = norm(($('#saveSearch') && $('#saveSearch').value) || '');
    const filtered = SAVES.filter(s => {
      if (!q) return true;
      const posTxt = (s.sel || []).map(x => x.en + ' ' + (x.zh || '')).join(' ');
      const negTxt = (s.neg || []).map(x => x.en).join(' ');
      return norm(s.name || '').includes(q) || norm(s.note || '').includes(q) || norm(posTxt).includes(q) || norm(negTxt).includes(q);
    });

    if (!filtered.length) {
      list.innerHTML = `<div class="save-empty">${SAVES.length ? '没有匹配的存档' : '还没有存档。可点右侧栏右上角「💾 保存」、上方「💾 保存当前已选」或「＋ 新增自定义存档」。'}</div>`;
    } else {
      list.innerHTML = filtered.map(s => {
        const posPreview = (s.sel || []).map(x => (x.w && x.w !== 1 ? `(${x.en}:${fmtW(x.w)})` : x.en)).join(', ');
        const negPreview = (s.neg || []).map(x => x.en).join(', ');
        return `<div class="save-item" style="flex-direction:column;align-items:stretch;gap:8px;padding:12px 14px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
            <div class="sv-main" data-sload="${esc(s.id)}" title="点击载入此存档" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <span class="sv-name" style="font-size:13.5px">${esc(s.name)}</span>
              ${s.isCustom ? '<span class="precheck-badge ok">自定义</span>' : ''}
              <span class="sv-meta" style="margin:0">${esc(saveSummary(s))} · ${esc(s.at || '')}</span>
            </div>
            <div class="sv-acts">
              <button type="button" class="mini primary" data-sload="${esc(s.id)}" title="载入此存档">⤵ 载入</button>
              <button type="button" class="mini" data-scopy="${esc(s.id)}" title="复制此存档的正向提示词">📋 复制</button>
              <button type="button" class="mini" data-sedit="${esc(s.id)}" title="编辑此存档">✎ 编辑</button>
              <button type="button" class="mini danger" data-sdel="${esc(s.id)}" title="删除此存档（需二次确认）">🗑 删除</button>
            </div>
          </div>
          ${s.note ? `<div class="muted small">备注：${esc(s.note)}</div>` : ''}
          <div style="padding:8px 10px;border-radius:8px;background:var(--field);border:1px solid var(--line);font-size:12px;line-height:1.55;color:var(--txt);word-break:break-word">
            <div><b style="color:var(--pos)">正向：</b>${esc(posPreview.slice(0, 260))}${posPreview.length > 260 ? '…' : ''}</div>
            ${negPreview ? `<div style="margin-top:4px;color:var(--muted)"><b style="color:var(--neg)">负面：</b>${esc(negPreview.slice(0, 160))}${negPreview.length > 160 ? '…' : ''}</div>` : ''}
          </div>
        </div>`;
      }).join('');
    }
    const footStat = $('#saveFootStat');
    if (footStat) {
      footStat.textContent = `共 ${SAVES.length} 份存档 · 已同步保存至用户操作文件 user-data.json`;
    }
  }

  function saveCurrent() {
    if (!state.sel.length && !state.neg.length) {
      toast('当前还没有选择任何提示词，请先挑选标签或使用「＋ 新增自定义存档」');
      return;
    }
    const nameEl = $('#saveName');
    const typed = nameEl ? String(nameEl.value || '').trim() : '';
    const name = typed || ('存档 ' + (SAVES.length + 1) + ' · ' + nowText());
    SAVES.unshift({
      id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      name,
      at: nowText(),
      sel: copyItems(state.sel),
      neg: copyItems(state.neg),
      chars: state.chars.map(c => ({ key: c.key, name: c.name, tag: c.tag, charZh: c.charZh }))
    });
    persistSaves();
    if (nameEl) nameEl.value = '';
    renderSaves();
    toast('💾 已保存到存档「' + name + '」');
  }

  function openCustomSaveEditor(editId) {
    const box = $('#saveCustomBox');
    if (!box) return;
    box.hidden = false;
    const item = editId ? SAVES.find(x => x.id === editId) : null;
    if ($('#saveCustomTitle')) $('#saveCustomTitle').textContent = item ? `✎ 编辑存档：${item.name}` : '＋ 新增自定义存档';
    if ($('#scEditId')) $('#scEditId').value = item ? item.id : '';
    if ($('#scName')) $('#scName').value = item ? (item.name || '') : '';
    if ($('#scNote')) $('#scNote').value = item ? (item.note || '') : '';
    if ($('#scPos')) $('#scPos').value = item ? (item.sel || []).map(x => (x.w && x.w !== 1 ? `(${x.en}:${fmtW(x.w)})` : x.en)).join(', ') : '';
    if ($('#scNeg')) $('#scNeg').value = item ? (item.neg || []).map(x => x.en).join(', ') : '';
    setTimeout(() => { if ($('#scName')) $('#scName').focus(); }, 20);
  }

  function closeCustomSaveEditor() {
    const box = $('#saveCustomBox');
    if (box) box.hidden = true;
    if ($('#scEditId')) $('#scEditId').value = '';
  }

  function commitCustomSave() {
    const editId = ($('#scEditId') && $('#scEditId').value) || '';
    const name = ($('#scName') && $('#scName').value || '').trim();
    const note = ($('#scNote') && $('#scNote').value || '').trim();
    const posRaw = ($('#scPos') && $('#scPos').value || '').trim();
    const negRaw = ($('#scNeg') && $('#scNeg').value || '').trim();
    if (!name) {
      toast('请填写存档名称');
      if ($('#scName')) $('#scName').focus();
      return;
    }
    const selItems = parsePromptTextToItems(posRaw);
    const negItems = parsePromptTextToItems(negRaw);
    if (!selItems.length && !negItems.length) {
      toast('请至少填写一条正向或负面提示词');
      if ($('#scPos')) $('#scPos').focus();
      return;
    }
    if (editId) {
      const idx = SAVES.findIndex(x => x.id === editId);
      if (idx >= 0) {
        SAVES[idx] = {
          ...SAVES[idx],
          name,
          note,
          at: nowText(),
          sel: selItems,
          neg: negItems
        };
        persistSaves();
        closeCustomSaveEditor();
        renderSaves();
        toast(`已更新存档「${name}」`);
        return;
      }
    }
    SAVES.unshift({
      id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      name,
      note,
      isCustom: true,
      at: nowText(),
      sel: selItems,
      neg: negItems,
      chars: []
    });
    persistSaves();
    closeCustomSaveEditor();
    renderSaves();
    toast(`💾 已新增自定义存档「${name}」`);
  }

  function loadSave(id) {
    const item = SAVES.find(x => x.id === id);
    if (!item) return;
    recordHistorySnapshot(`载入存档: ${item.name}`);
    state.sel = (item.sel || []).filter(x => x && x.en).map(fixItem);
    state.neg = (item.neg || []).filter(x => x && x.en).map(fixItem);
    state.chars = Array.isArray(item.chars)
      ? item.chars.filter(c => c && c.key)
      : (item.char && item.char.key ? [item.char] : []);
    state.chars = state.chars.map(c => {
      const hit = CHARS.find(x => x.key === c.key);
      const tags = hit ? [norm(hit.tag)].concat(hit.auto.map(a => norm(a.en))) : (c.tags || []);
      return Object.assign({}, c, { tags: tags });
    });
    syncCharTags();
    renderCharChip();
    state.highlight = null;
    state.mode = 'pos';
    syncModeSeg();
    closeModal('modalSaves');
    renderSelected();
    renderGrid();
    renderOutput();
    updateWarn();
    save();
    toast('已载入存档「' + item.name + '」，共 ' + state.sel.length + ' 个正向标签');
  }

  function deleteSave(id) {
    const item = SAVES.find(x => x.id === id);
    if (!item) return;
    askConfirmModal('确定删除存档「' + item.name + '」吗？', () => {
      SAVES.splice(SAVES.indexOf(item), 1);
      persistSaves();
      renderSaves();
      toast('已删除存档「' + item.name + '」');
    });
  }

  function deleteAllSaves() {
    if (!SAVES.length) { toast('现在没有存档'); return; }
    askConfirmModal('确定删掉全部 ' + SAVES.length + ' 份存档吗？', () => {
      SAVES.length = 0;
      persistSaves();
      renderSaves();
      toast('全部存档已清空');
    });
  }

  /* ---------- 随机生成 ---------- */

  const SCENES = {
    portrait: { name: '角色特写', cats: ['base', 'body', 'hair_color', 'hair_style', 'eyes', 'mouth', 'expression', 'upper_body', 'accessory', 'lighting', 'camera', 'composition'] },
    full: { name: '全身立绘', cats: ['base', 'body', 'hair_color', 'hair_style', 'eyes', 'expression', 'pose', 'upper_body', 'lower_body', 'legwear', 'footwear', 'accessory', 'lighting', 'camera', 'composition'] },
    scenery: { name: '场景插画', cats: ['base', 'body', 'hair_color', 'hair_style', 'eyes', 'expression', 'pose', 'upper_body', 'indoor', 'nature', 'weather_time', 'lighting', 'items'] }
  };

  const RAND_DENY = /\b(nsfw|explicit|questionable|sensitive|nude|topless|bottomless|rating)\b/i;

  const rand = arr => arr[Math.floor(Math.random() * arr.length)];
  const chance = p => Math.random() < p;

  function pickTag(catId) {
    const c = CATS.find(x => x.id === catId);
    if (!c) return null;
    const pool = c.tags.filter(t => !RAND_DENY.test(t.en));
    if (!pool.length) return null;
    return rand(pool);
  }

  function getSwitchIntervals(sw) {
    if (!sw) return [];
    if (Array.isArray(sw.intervals) && sw.intervals.length) {
      return sw.intervals.filter(it => it && it.id);
    }
    const defCnt = clamp(Number(sw.count ?? (sw.id === 'sw_quality' ? 2 : 1)), 0, 15);
    if (sw.id === 'sw_char' || sw.isCharSwitch) {
      sw.intervals = [{ id: 'char:library', count: Math.max(1, defCnt) }];
      return sw.intervals;
    }
    const legacyIds = Array.isArray(sw.catIds) && sw.catIds.length ? sw.catIds.filter(Boolean) : (sw.catId ? [sw.catId] : []);
    sw.intervals = legacyIds.map(id => ({ id, count: defCnt }));
    return sw.intervals;
  }

  function getSwitchCatIds(sw) {
    return getSwitchIntervals(sw).map(it => it.id);
  }

  const LEGACY_TARGET_MIGRATION = {
    hair: 'hair_style',
    face: 'eyes',
    clothing: 'upper_body',
    environment: 'nature',
    weather: 'weather_time',
    props: 'items',
    nsfwbody: 'nsfw_mapped:all',
    nsfwcloth: 'nsfw_mapped:all',
    nsfwact: 'nsfw_mapped:all',
    nsfwplay: 'nsfw_mapped:all',
    'major:nsfw_group': 'nsfw_mapped:all',
    'major:nsfw_adult': 'nsfw_mapped:all',
    'major:character': 'major:character_base',
    'major:outfit': 'major:outfit_group',
    'major:action': 'major:action_group',
    'major:scene': 'major:scene_group',
    'major:style': 'major:style_group',
    'major:art_style': 'major:style_group',
    'nsfw_major:art_style': 'nsfw_major:style_group',
    'art_style': 'major:style_group'
  };

  function migrateTargetIntervalId(tid) {
    if (!tid) return tid;
    if (LEGACY_TARGET_MIGRATION[tid]) return LEGACY_TARGET_MIGRATION[tid];
    return tid;
  }

  /* V1.2.1 Req 5: 库区间按钮支持全部大分类、小分类、自定义及 NSFW 映射板块 */
  function formatTargetIntervalShortName(targetId) {
    const tid = migrateTargetIntervalId(targetId);
    if (!tid) return '未选区间';
    if (tid === 'nsfw_mapped:all') return '🔞 NSFW 全库(橙+红)';
    if (String(tid).indexOf('nsfw_major:') === 0) {
      const mid = String(tid).slice(11);
      const m = MAJORS.find(x => x.id === mid);
      return m ? `🔞 ${m.name}` : `🔞 ${mid}`;
    }
    if (String(tid).indexOf('nsfw_sub:') === 0) {
      const sid = String(tid).slice(9);
      const c = CATS.find(x => x.id === sid);
      return c ? `🔞 ${c.name}` : `🔞 ${sid}`;
    }
    if (tid === 'char:library') return '🧝 角色库';
    if (tid === 'char:custom') return '⭐ 自定义的角色';
    if (tid === 'major:custom' || tid === 'custom') return '⭐ 自定义';
    if (String(tid).indexOf('major:') === 0) {
      const mid = String(tid).slice(6);
      if (mid === 'custom') return '⭐ 自定义';
      const m = MAJORS.find(x => x.id === mid);
      return m ? `${m.icon || '📁'} ${m.name}` : mid;
    }
    ensureCustomCategoriesStructure();
    const custSub = (state.customTagCats || []).find(c => c.id === tid);
    if (custSub) return `${custSub.icon || '🏷'} ${custSub.name}`;
    const hit = findTreeSub(tid);
    if (hit) return `${hit.sub.icon || '•'} ${hit.sub.name}`;
    const c = CATS.find(x => x.id === tid);
    return c ? `${c.icon || '•'} ${c.name}` : tid;
  }

  function formatTargetIntervalName(targetId) {
    return formatTargetIntervalShortName(targetId);
  }

  function formatSwitchCatsLabel(catIds) {
    const ids = Array.isArray(catIds) ? catIds.filter(Boolean) : [];
    if (!ids.length) return '仅固定词';
    const names = ids.map(cid => formatTargetIntervalShortName(cid));
    if (names.length <= 2) return names.join(' + ');
    return `${names.slice(0, 2).join(' + ')} (${names.length})`;
  }

  /* V1.2.2 Req 2: 含角色开关默认禁止的 30 个人物基础与服饰区间（保留表情 expression、体型 body、女性生殖器 pussy、男性生殖器 penis） */
  const CHAR_FORBIDDEN_SUB_LIST = [
    'base', 'occupation', 'species', 'hair_color', 'hair_style', 'ears', 'head', 'eyes', 'nose', 'mouth',
    'skin', 'breasts', 'ass', 'wings', 'tail', 'legs', 'feet', 'body_parts',
    'headwear', 'eyewear', 'neckwear', 'handwear', 'shoulderwear', 'chestwear',
    'upper_body', 'lower_body', 'underwear', 'hipwear', 'legwear', 'footwear', 'accessory', 'pattern'
  ];
  const CHAR_EXCLUDED_SUB_IDS = new Set(CHAR_FORBIDDEN_SUB_LIST);
  function isSubExcludedByCharRule(subId) {
    if (!subId) return false;
    if (subId === 'expression' || subId === 'body' || subId === 'pussy' || subId === 'penis') return false;
    if (subId === 'props' || subId === 'food' || subId === 'items' || subId === 'tools') return false;
    if (CHAR_EXCLUDED_SUB_IDS.has(subId)) return true;
    return false;
  }

  function matchTagByTypeFilter(t, subId, tagTypeFilter) {
    if (!t || !t.en) return false;
    const r = getTagRating(t.en, subId, t);
    const mode = tagTypeFilter || 'sfw';
    if (mode === 'nsfw') return r === 'q' || r === 'e';
    if (mode === 'sfw') return (r === 'g' || r === 's') && !RAND_DENY.test(t.en);
    if (mode === 'g' || mode === 's' || mode === 'q' || mode === 'e') return r === mode;
    if (mode === 'all') return true;
    return (r === 'g' || r === 's');
  }

  function pickTagFromTarget(targetId, charEnabled, excludeSet, tagTypeFilter) {
    const tid = migrateTargetIntervalId(targetId);
    if (!tid) return null;
    ensureCustomCategoriesStructure();
    const isNsfwTarget = (tid === 'nsfw_mapped:all' || String(tid).indexOf('nsfw_major:') === 0 || String(tid).indexOf('nsfw_sub:') === 0);
    const effType = tagTypeFilter || (isNsfwTarget ? 'nsfw' : 'sfw');

    if (tid === 'major:custom' || tid === 'custom') {
      const validCust = (state.customTagCats || []).filter(c => c.tags && c.tags.length);
      if (!validCust.length) return null;
      const allCand = [];
      validCust.forEach(c => {
        (c.tags || []).forEach(t => {
          if (excludeSet && excludeSet.has(norm(cleanArtistEn(t.en)))) return;
          if (!matchTagByTypeFilter(t, c.id, effType)) return;
          allCand.push({ tag: t, subId: c.id });
        });
      });
      if (!allCand.length) return null;
      return rand(allCand);
    }
    const custSub = (state.customTagCats || []).find(c => c.id === tid);
    if (custSub) {
      const pool = (custSub.tags || []).filter(t => (!excludeSet || !excludeSet.has(norm(cleanArtistEn(t.en)))) && matchTagByTypeFilter(t, custSub.id, effType));
      if (!pool.length) return null;
      return { tag: rand(pool), subId: custSub.id };
    }
    if (tid === 'nsfw_mapped:all') {
      const mapped = getMappedNsfwSubcategories().filter(s => !charEnabled || !isSubExcludedByCharRule(s.id));
      if (!mapped.length) return null;
      const allNsfwCand = [];
      mapped.forEach(s => {
        (s.tags || []).forEach(t => {
          if (excludeSet && excludeSet.has(norm(cleanArtistEn(t.en)))) return;
          if (!matchTagByTypeFilter(t, s.id, effType)) return;
          allNsfwCand.push({ tag: t, subId: s.id });
        });
      });
      if (!allNsfwCand.length) return null;
      return rand(allNsfwCand);
    }
    if (String(tid).indexOf('nsfw_major:') === 0) {
      const mid = String(tid).slice(11);
      const mapped = getMappedNsfwSubcategories().filter(s => s.parentId === mid && (!charEnabled || !isSubExcludedByCharRule(s.id)));
      if (!mapped.length) return null;
      const allNsfwCand = [];
      mapped.forEach(s => {
        (s.tags || []).forEach(t => {
          if (excludeSet && excludeSet.has(norm(cleanArtistEn(t.en)))) return;
          if (!matchTagByTypeFilter(t, s.id, effType)) return;
          allNsfwCand.push({ tag: t, subId: s.id });
        });
      });
      if (!allNsfwCand.length) return null;
      return rand(allNsfwCand);
    }
    if (String(tid).indexOf('nsfw_sub:') === 0) {
      const sid = String(tid).slice(9);
      if (charEnabled && isSubExcludedByCharRule(sid)) return null;
      const c = CATS.find(x => x.id === sid);
      if (!c || !c.tags || !c.tags.length) return null;
      const pool = c.tags.filter(t => (!excludeSet || !excludeSet.has(norm(cleanArtistEn(t.en)))) && matchTagByTypeFilter(t, sid, effType));
      if (!pool.length) return null;
      return { tag: rand(pool), subId: sid };
    }
    if (String(tid).indexOf('major:') === 0) {
      const mid = String(tid).slice(6);
      if (charEnabled && (mid === 'character' || mid === 'character_base')) return null;
      const m = MAJORS.find(x => x.id === mid);
      if (!m || !Array.isArray(m.children) || !m.children.length) return null;
      const validSubs = m.children.filter(s => {
        if (s.id === 'negative' || !s.tags || !s.tags.length) return false;
        if (charEnabled && isSubExcludedByCharRule(s.id)) return false;
        return true;
      });
      if (!validSubs.length) return null;
      const allCand = [];
      validSubs.forEach(s => {
        (s.tags || []).forEach(t => {
          if (excludeSet && excludeSet.has(norm(cleanArtistEn(t.en)))) return;
          if (!matchTagByTypeFilter(t, s.id, effType)) return;
          allCand.push({ tag: t, subId: s.id });
        });
      });
      if (!allCand.length) return null;
      return rand(allCand);
    }
    if (charEnabled && isSubExcludedByCharRule(tid)) return null;
    const c = CATS.find(x => x.id === tid);
    if (!c || !c.tags || !c.tags.length) return null;
    let pool = c.tags.filter(t => (!excludeSet || !excludeSet.has(norm(cleanArtistEn(t.en)))) && matchTagByTypeFilter(t, tid, effType));
    if (tid === 'base') {
      pool = pool.filter(t => !/(\b(boy|boys|man|men|male|multiple|crowd|everyone|lineup|no humans|crossdressing|gender transitioning)\b|^\d+\+?\s*(girls|boys|others|people))/i.test(t.en));
    } else if (tid === 'style') {
      pool = pool.filter(t => !/^(masterpiece|best quality|score_\d+(_up)?|safe|sensitive|nsfw|explicit)$/i.test(t.en));
    }
    if (!pool.length) return null;
    return { tag: rand(pool), subId: tid };
  }

  /* =====================================================================
     V1.2.3 随机抽取规则引擎（支持大分类折叠展开所属小分类概率权重和=1、抽取数量区间、调低道具与不常用概率、多开关规则合并）
     ===================================================================== */
  const MAJOR_DEFAULT_SUBWEIGHTS = {
    'major:scene_group': [
      { subId: 'nature', weight: 0.40 },
      { subId: 'indoor', weight: 0.35 },
      { subId: 'weather_time', weight: 0.15 },
      { subId: 'urban', weight: 0.05 },
      { subId: 'fantasy_scifi', weight: 0.05 }
    ],
    'major:props_group': [
      { subId: 'items', weight: 0.65 },
      { subId: 'food', weight: 0.35 }
    ],
    'major:action_group': [
      { subId: 'hand_action', weight: 0.55 },
      { subId: 'head_action', weight: 0.30 },
      { subId: 'mouth_action', weight: 0.15 }
    ],
    'major:outfit_group': [
      { subId: 'legwear', weight: 0.40 },
      { subId: 'footwear', weight: 0.35 },
      { subId: 'accessory', weight: 0.25 }
    ],
    'major:style_group': [
      { subId: 'lighting', weight: 0.42 },
      { subId: 'camera', weight: 0.38 },
      { subId: 'composition', weight: 0.20 }
    ],
    'major:character_base': [
      { subId: 'eyes', weight: 0.32 },
      { subId: 'expression', weight: 0.32 },
      { subId: 'body', weight: 0.16 },
      { subId: 'mouth', weight: 0.10 },
      { subId: 'ears', weight: 0.05 },
      { subId: 'tail', weight: 0.05 }
    ]
  };

  const NSFW_MAJOR_SUBWEIGHTS = {
    'major:action_group': [
      { subId: 'interaction', weight: 0.28 },
      { subId: 'pose', weight: 0.22 },
      { subId: 'hand_action', weight: 0.18 },
      { subId: 'mouth_action', weight: 0.14 },
      { subId: 'head_action', weight: 0.10 },
      { subId: 'foot_action', weight: 0.08 }
    ],
    'major:character_base': [
      { subId: 'breasts', weight: 0.16 },
      { subId: 'pussy', weight: 0.16 },
      { subId: 'expression', weight: 0.14 },
      { subId: 'body', weight: 0.12 },
      { subId: 'ass', weight: 0.12 },
      { subId: 'penis', weight: 0.08 },
      { subId: 'body_parts', weight: 0.08 },
      { subId: 'base', weight: 0.05 },
      { subId: 'species', weight: 0.03 },
      { subId: 'hair_style', weight: 0.03 },
      { subId: 'wings', weight: 0.03 }
    ],
    'major:outfit_group': [
      { subId: 'underwear', weight: 0.22 },
      { subId: 'chestwear', weight: 0.16 },
      { subId: 'upper_body', weight: 0.14 },
      { subId: 'lower_body', weight: 0.14 },
      { subId: 'hipwear', weight: 0.10 },
      { subId: 'legwear', weight: 0.08 },
      { subId: 'neckwear', weight: 0.05 },
      { subId: 'accessory', weight: 0.04 },
      { subId: 'handwear', weight: 0.03 },
      { subId: 'headwear', weight: 0.02 },
      { subId: 'eyewear', weight: 0.02 }
    ],
    'major:props_group': [
      { subId: 'sex_toys', weight: 0.45 },
      { subId: 'restraints', weight: 0.35 },
      { subId: 'food', weight: 0.20 }
    ],
    'major:style_group': [
      { subId: 'style', weight: 0.55 },
      { subId: 'composition', weight: 0.45 }
    ]
  };

  function normalizeSubWeightsList(list, majorTargetId) {
    if (!Array.isArray(list)) list = [];
    const seen = new Set();
    const cleaned = [];
    list.forEach(it => {
      if (!it || !it.subId) return;
      const sid = String(it.subId);
      if (seen.has(sid)) return;
      seen.add(sid);
      cleaned.push({
        subId: sid,
        weight: Math.max(0, Number(it.weight ?? 0))
      });
    });
    if (majorTargetId) {
      const mid = String(majorTargetId).replace(/^(nsfw_)?major:/, '');
      const m = MAJORS.find(x => x.id === mid) || (window.PG_TAG_FS && Array.isArray(window.PG_TAG_FS.majors) ? window.PG_TAG_FS.majors.find(x => x.id === mid) : null);
      if (m && Array.isArray(m.children)) {
        m.children.forEach(s => {
          if (s && s.id && !seen.has(s.id)) {
            seen.add(s.id);
            cleaned.push({ subId: s.id, weight: 0 });
          }
        });
      }
    }
    if (!cleaned.length) return [];
    let sum = cleaned.reduce((acc, x) => acc + x.weight, 0);
    if (sum <= 0.0001) {
      const eq = Number((1 / cleaned.length).toFixed(4));
      cleaned.forEach((x, idx) => {
        x.weight = idx === cleaned.length - 1
          ? Number(Math.max(0, 1 - eq * (cleaned.length - 1)).toFixed(4))
          : eq;
      });
      return cleaned;
    }
    let lastPosIdx = -1;
    cleaned.forEach((x, idx) => { if (x.weight > 0.0001) lastPosIdx = idx; });
    let running = 0;
    cleaned.forEach((x, idx) => {
      if (x.weight <= 0.0001) {
        x.weight = 0;
      } else if (idx === lastPosIdx) {
        x.weight = Number(Math.max(0, 1 - running).toFixed(2));
      } else {
        x.weight = Number((x.weight / sum).toFixed(2));
        running += x.weight;
      }
    });
    return cleaned;
  }

  function rebalanceSubWeightsOnEdit(subWeights, editedIdx, newWeightRaw) {
    if (!Array.isArray(subWeights) || !subWeights[editedIdx]) return;
    const n = subWeights.length;
    if (n === 1) {
      subWeights[0].weight = 1;
      return;
    }
    const targetW = clamp(Number(newWeightRaw || 0), 0, 1);
    subWeights[editedIdx].weight = Number(targetW.toFixed(2));
    const remainTotal = Math.max(0, Number((1 - subWeights[editedIdx].weight).toFixed(4)));
    const posOthers = subWeights.filter((it, i) => i !== editedIdx && Number(it.weight || 0) > 0.0001);
    const pool = posOthers.length ? posOthers : subWeights.filter((_, i) => i !== editedIdx);
    const otherSum = pool.reduce((a, x) => a + Math.max(0, Number(x.weight || 0)), 0);
    let acc = subWeights[editedIdx].weight;
    let seenPool = 0;
    subWeights.forEach((item, idx) => {
      if (idx === editedIdx) return;
      if (posOthers.length && Number(item.weight || 0) <= 0.0001) {
        item.weight = 0;
        return;
      }
      seenPool++;
      if (seenPool === pool.length) {
        item.weight = Number(Math.max(0, 1 - acc).toFixed(2));
      } else if (otherSum > 0.0001) {
        const w = Number(((Math.max(0, Number(item.weight || 0)) / otherSum) * remainTotal).toFixed(2));
        item.weight = w;
        acc += w;
      } else {
        const w = Number((remainTotal / pool.length).toFixed(2));
        item.weight = w;
        acc += w;
      }
    });
  }

  function getDefaultSubWeightsForMajor(majorTargetId, level) {
    const tid = migrateTargetIntervalId(String(majorTargetId || ''));
    const normTid = tid.replace(/^nsfw_major:/, 'major:');
    let baseList = [];
    if (level === 'nsfw' && NSFW_MAJOR_SUBWEIGHTS[normTid]) {
      baseList = JSON.parse(JSON.stringify(NSFW_MAJOR_SUBWEIGHTS[normTid]));
    } else if (MAJOR_DEFAULT_SUBWEIGHTS[normTid]) {
      baseList = JSON.parse(JSON.stringify(MAJOR_DEFAULT_SUBWEIGHTS[normTid]));
    } else if (normTid.indexOf('major:') === 0) {
      const mid = normTid.slice(6);
      const m = MAJORS.find(x => x.id === mid) || (window.PG_TAG_FS && Array.isArray(window.PG_TAG_FS.majors) ? window.PG_TAG_FS.majors.find(x => x.id === mid) : null);
      if (m && Array.isArray(m.children) && m.children.length) {
        baseList = m.children.map(s => ({ subId: s.id, weight: 1 / m.children.length }));
      }
    }
    return normalizeSubWeightsList(baseList, normTid);
  }

  function buildBuiltinSwitchRules(swId) {
    if (swId === 'sw_quality') {
      return [
        { id: 'sr_qual_style', attr: 'add', targetId: 'style', isMajorGroup: false, expanded: false, mode: 'fixed', level: 'sfw', count: 1, minCount: 1, maxCount: 1, prob: 100 }
      ];
    }
    if (swId === 'sw_artist') {
      return [
        { id: 'sr_art_artist', attr: 'add', targetId: 'artist', isMajorGroup: false, expanded: false, mode: 'fixed', level: 'sfw', count: 1, minCount: 1, maxCount: 1, prob: 100 }
      ];
    }
    if (swId === 'sw_char') {
      const rules = [
        { id: 'sr_char_lib', attr: 'add', targetId: 'char:library', isMajorGroup: false, expanded: false, mode: 'fixed', level: 'sfw', count: 1, minCount: 1, maxCount: 1, prob: 100 },
        { id: 'sr_char_expression', attr: 'add', targetId: 'expression', isMajorGroup: false, expanded: false, mode: 'prob', level: 'sfw', count: 1, minCount: 1, maxCount: 1, prob: 75 },
        { id: 'sr_char_camera', attr: 'add', targetId: 'camera', isMajorGroup: false, expanded: false, mode: 'prob', level: 'sfw', count: 1, minCount: 1, maxCount: 1, prob: 70 },
        { id: 'sr_char_body', attr: 'add', targetId: 'body', isMajorGroup: false, expanded: false, mode: 'prob', level: 'sfw', count: 1, minCount: 1, maxCount: 1, prob: 25 }
      ];
      CHAR_FORBIDDEN_SUB_LIST.forEach(sid => {
        rules.push({
          id: 'sr_char_forbid_' + sid,
          attr: 'forbid',
          targetId: sid,
          isMajorGroup: false,
          expanded: false,
          mode: 'fixed',
          level: 'sfw',
          count: 1,
          minCount: 1,
          maxCount: 1,
          prob: 100
        });
      });
      return rules;
    }
    if (swId === 'sw_nsfw') {
      return [
        {
          id: 'sr_nsfw_char_major',
          attr: 'add',
          targetId: 'major:character_base',
          isMajorGroup: true,
          expanded: false,
          mode: 'prob',
          level: 'nsfw',
          prob: 65,
          count: 1,
          minCount: 1,
          maxCount: 1,
          subWeights: [
            { subId: 'breasts', weight: 0.40 },
            { subId: 'pussy', weight: 0.35 },
            { subId: 'ass', weight: 0.25 },
            { subId: 'expression', weight: 0 },
            { subId: 'penis', weight: 0 },
            { subId: 'base', weight: 0 }
          ]
        },
        {
          id: 'sr_nsfw_outfit_major',
          attr: 'add',
          targetId: 'major:outfit_group',
          isMajorGroup: true,
          expanded: false,
          mode: 'prob',
          level: 'nsfw',
          prob: 60,
          count: 1,
          minCount: 1,
          maxCount: 1,
          subWeights: [
            { subId: 'underwear', weight: 0.45 },
            { subId: 'chestwear', weight: 0.30 },
            { subId: 'legwear', weight: 0.25 },
            { subId: 'upper_body', weight: 0 },
            { subId: 'lower_body', weight: 0 },
            { subId: 'hipwear', weight: 0 },
            { subId: 'neckwear', weight: 0 },
            { subId: 'accessory', weight: 0 },
            { subId: 'handwear', weight: 0 },
            { subId: 'headwear', weight: 0 },
            { subId: 'eyewear', weight: 0 }
          ]
        },
        {
          id: 'sr_nsfw_action_major',
          attr: 'add',
          targetId: 'major:action_group',
          isMajorGroup: true,
          expanded: false,
          mode: 'prob',
          level: 'nsfw',
          prob: 50,
          count: 1,
          minCount: 1,
          maxCount: 1,
          subWeights: [
            { subId: 'hand_action', weight: 0.35 },
            { subId: 'mouth_action', weight: 0.30 },
            { subId: 'interaction', weight: 0.25 },
            { subId: 'foot_action', weight: 0.10 },
            { subId: 'head_action', weight: 0 },
            { subId: 'pose', weight: 0 }
          ]
        },
        {
          id: 'sr_nsfw_props_major',
          attr: 'add',
          targetId: 'major:props_group',
          isMajorGroup: true,
          expanded: false,
          mode: 'prob',
          level: 'nsfw',
          prob: 20,
          count: 1,
          minCount: 1,
          maxCount: 1,
          subWeights: [
            { subId: 'sex_toys', weight: 0.60 },
            { subId: 'restraints', weight: 0.40 },
            { subId: 'food', weight: 0 },
            { subId: 'items', weight: 0 },
            { subId: 'tools', weight: 0 }
          ]
        },
        {
          id: 'sr_nsfw_forbid_lower_body',
          attr: 'forbid',
          targetId: 'lower_body',
          isMajorGroup: false,
          expanded: false,
          mode: 'fixed',
          level: 'sfw',
          count: 1,
          minCount: 1,
          maxCount: 1,
          prob: 100
        }
      ];
    }
    return [];
  }

  /* V1.2.3 Req 1: 默认抽取规则（调优防撕裂黄金法则，整合景别机位、质感光影、单人纯化与服装防穿模） */
  function buildDefaultDrawRulesV122() {
    return [
          {
                "id": "dr_base",
                "attr": "add",
                "targetId": "base",
                "isMajorGroup": false,
                "expanded": false,
                "mode": "prob",
                "level": "sfw",
                "count": 1,
                "minCount": 1,
                "maxCount": 1,
                "prob": 25
          },
          {
                "id": "dr_hair_color",
                "attr": "add",
                "targetId": "hair_color",
                "isMajorGroup": false,
                "expanded": false,
                "mode": "fixed",
                "level": "sfw",
                "count": 1,
                "minCount": 1,
                "maxCount": 1,
                "prob": 100
          },
          {
                "id": "dr_hair_style",
                "attr": "add",
                "targetId": "hair_style",
                "isMajorGroup": false,
                "expanded": false,
                "mode": "fixed",
                "level": "sfw",
                "count": 1,
                "minCount": 1,
                "maxCount": 1,
                "prob": 100
          },
          {
                "id": "dr_eyes",
                "attr": "add",
                "targetId": "eyes",
                "isMajorGroup": false,
                "expanded": false,
                "mode": "prob",
                "level": "sfw",
                "count": 1,
                "minCount": 1,
                "maxCount": 1,
                "prob": 80
          },
          {
                "id": "dr_expression",
                "attr": "add",
                "targetId": "expression",
                "isMajorGroup": false,
                "expanded": false,
                "mode": "prob",
                "level": "sfw",
                "count": 1,
                "minCount": 1,
                "maxCount": 1,
                "prob": 75
          },
          {
                "id": "dr_upper_body",
                "attr": "add",
                "targetId": "upper_body",
                "isMajorGroup": false,
                "expanded": false,
                "mode": "fixed",
                "level": "sfw",
                "count": 1,
                "minCount": 1,
                "maxCount": 1,
                "prob": 100
          },
          {
                "id": "dr_lower_body",
                "attr": "add",
                "targetId": "lower_body",
                "isMajorGroup": false,
                "expanded": false,
                "mode": "prob",
                "level": "sfw",
                "count": 1,
                "minCount": 1,
                "maxCount": 1,
                "prob": 45
          },
          {
                "id": "dr_major_outfit_acc",
                "attr": "add",
                "targetId": "major:outfit_group",
                "isMajorGroup": true,
                "expanded": false,
                "mode": "prob",
                "level": "sfw",
                "prob": 45,
                "count": 1,
                "minCount": 1,
                "maxCount": 1,
                "subWeights": [
                      {
                            "subId": "legwear",
                            "weight": 0.5
                      },
                      {
                            "subId": "footwear",
                            "weight": 0.3
                      },
                      {
                            "subId": "accessory",
                            "weight": 0.2
                      },
                      {
                            "subId": "headwear",
                            "weight": 0
                      },
                      {
                            "subId": "eyewear",
                            "weight": 0
                      },
                      {
                            "subId": "neckwear",
                            "weight": 0
                      },
                      {
                            "subId": "handwear",
                            "weight": 0
                      },
                      {
                            "subId": "shoulderwear",
                            "weight": 0
                      },
                      {
                            "subId": "chestwear",
                            "weight": 0
                      },
                      {
                            "subId": "upper_body",
                            "weight": 0
                      },
                      {
                            "subId": "lower_body",
                            "weight": 0
                      },
                      {
                            "subId": "underwear",
                            "weight": 0
                      },
                      {
                            "subId": "hipwear",
                            "weight": 0
                      },
                      {
                            "subId": "pattern",
                            "weight": 0
                      }
                ]
          },
          {
                "id": "dr_pose",
                "attr": "add",
                "targetId": "pose",
                "isMajorGroup": false,
                "expanded": false,
                "mode": "fixed",
                "level": "sfw",
                "count": 1,
                "minCount": 1,
                "maxCount": 1,
                "prob": 100
          },
          {
                "id": "dr_camera",
                "attr": "add",
                "targetId": "camera",
                "isMajorGroup": false,
                "expanded": false,
                "mode": "prob",
                "level": "sfw",
                "count": 1,
                "minCount": 1,
                "maxCount": 1,
                "prob": 70
          },
          {
                "id": "dr_major_action",
                "attr": "add",
                "targetId": "major:action_group",
                "isMajorGroup": true,
                "expanded": false,
                "mode": "prob",
                "level": "sfw",
                "prob": 35,
                "count": 1,
                "minCount": 1,
                "maxCount": 1,
                "subWeights": [
                      {
                            "subId": "hand_action",
                            "weight": 0.7
                      },
                      {
                            "subId": "head_action",
                            "weight": 0.2
                      },
                      {
                            "subId": "mouth_action",
                            "weight": 0.1
                      },
                      {
                            "subId": "pose",
                            "weight": 0
                      },
                      {
                            "subId": "foot_action",
                            "weight": 0
                      },
                      {
                            "subId": "interaction",
                            "weight": 0
                      }
                ]
          },
          {
                "id": "dr_major_scene",
                "attr": "add",
                "targetId": "major:scene_group",
                "isMajorGroup": true,
                "expanded": false,
                "mode": "prob",
                "level": "sfw",
                "prob": 70,
                "count": 1,
                "minCount": 1,
                "maxCount": 1,
                "subWeights": [
                      {
                            "subId": "nature",
                            "weight": 0.4
                      },
                      {
                            "subId": "indoor",
                            "weight": 0.35
                      },
                      {
                            "subId": "weather_time",
                            "weight": 0.15
                      },
                      {
                            "subId": "urban",
                            "weight": 0.05
                      },
                      {
                            "subId": "fantasy_scifi",
                            "weight": 0.05
                      }
                ]
          },
          {
                "id": "dr_lighting",
                "attr": "add",
                "targetId": "lighting",
                "isMajorGroup": false,
                "expanded": false,
                "mode": "prob",
                "level": "sfw",
                "count": 1,
                "minCount": 1,
                "maxCount": 1,
                "prob": 50
          }
    ];
  }

  function getSwitchRuleSummaryText(sw) {
    if (!sw) return '';
    const rules = Array.isArray(sw.rules) ? sw.rules : [];
    const addList = rules.filter(r => r && r.attr !== 'forbid');
    const forbidList = rules.filter(r => r && r.attr === 'forbid');
    if (sw.id === 'sw_quality') {
      const r0 = addList[0];
      const cnt = r0 ? clamp(Number(r0.maxCount || r0.count || 1), 1, 15) : 1;
      return `在默认抽取基础上，固定添加「质量与风格」${cnt} 个蓝黄（普通）标签，并自动带出官方质量前缀。`;
    }
    if (sw.id === 'sw_artist') {
      const r0 = addList[0];
      const cnt = r0 ? clamp(Number(r0.maxCount || r0.count || 1), 1, 15) : 1;
      return `在默认抽取基础上，固定添加「画师风格」${cnt} 个蓝黄（普通）画师标签（词库内画师均自带 @ 前缀）。`;
    }
    if (sw.id === 'sw_char') {
      return `固定抽取「角色库」1 个角色（含角色外观），概率抽取「表情 (75%)」、「机位景别 (70%)」与「体型 (25%)」，并严禁其余 ${forbidList.length || 30} 个人物基础与服饰小分类（防角色穿模）。`;
    }
    if (sw.id === 'sw_nsfw') {
      const minC = clamp(Number((state && state.randCfg && state.randCfg.nsfwMinCount) ?? 2), 0, 15);
      return `按大分类权重规则抽取橙红（限制）标签（胸部/私密/情趣内衣/微露），自动屏蔽下装长裤，并保底抽出 ${minC} 个敏感标签。`;
    }
    if (!rules.length) {
      return '自定义开关：可在「🎲 随机抽取」面板中选择此开关，自由配置需要添加或禁止的大分类/小分类规则。';
    }
    const addNames = addList.slice(0, 3).map(r => formatTargetIntervalShortName(r.targetId)).join('、');
    const forbidNames = forbidList.slice(0, 3).map(r => formatTargetIntervalShortName(r.targetId)).join('、');
    const parts = [];
    if (addList.length) parts.push(`添加 ${addList.length} 项（${addNames}${addList.length > 3 ? '等' : ''}）`);
    if (forbidList.length) parts.push(`禁止 ${forbidList.length} 项（${forbidNames}${forbidList.length > 3 ? '等' : ''}）`);
    return `在默认抽取基础上：${parts.join('；')}。`;
  }

  function buildDefaultRandCfgV10() {
    return {
      _v122RuleEngine: true,
      _v123MajorSubEngine: true,
      fixedTags: 'masterpiece, best quality, score_7, safe, 1girl, solo',
      randWeight: false,
      nsfwMinCount: 2,
      activeRuleScope: 'default',
      charRule: { enabled: false, prob: 100, count: 1, withAuto: true },
      switches: [
        {
          id: 'sw_quality',
          name: '含质量词',
          enabled: true,
          tagType: 'sfw',
          rules: buildBuiltinSwitchRules('sw_quality'),
          intervals: [{ id: 'style', count: 2 }],
          activeIntervalIdx: 0,
          catIds: ['style'],
          catId: 'style',
          count: 2,
          prob: 100,
          fixedTags: '',
          prefixAt: false,
          builtin: true
        },
        {
          id: 'sw_artist',
          name: '含画师',
          enabled: true,
          tagType: 'sfw',
          rules: buildBuiltinSwitchRules('sw_artist'),
          intervals: [{ id: 'artist', count: 1 }],
          activeIntervalIdx: 0,
          catIds: ['artist'],
          catId: 'artist',
          count: 1,
          prob: 100,
          fixedTags: '',
          prefixAt: true,
          builtin: true
        },
        {
          id: 'sw_char',
          name: '含角色',
          enabled: false,
          tagType: 'char',
          rules: buildBuiltinSwitchRules('sw_char'),
          intervals: [{ id: 'char:library', count: 1 }],
          activeIntervalIdx: 0,
          catIds: ['char:library'],
          catId: 'char:library',
          count: 1,
          prob: 100,
          fixedTags: '',
          prefixAt: false,
          builtin: true,
          isCharSwitch: true
        },
        {
          id: 'sw_nsfw',
          name: '含nsfw',
          enabled: false,
          tagType: 'nsfw',
          rules: buildBuiltinSwitchRules('sw_nsfw'),
          intervals: [{ id: 'nsfw_mapped:all', count: 2 }],
          activeIntervalIdx: 0,
          catIds: ['nsfw_mapped:all'],
          catId: 'nsfw_mapped:all',
          count: 2,
          minNsfwCount: 2,
          prob: 100,
          fixedTags: '',
          prefixAt: false,
          builtin: true
        }
      ],
      drawRules: buildDefaultDrawRulesV122()
    };
  }

  function snapshotRandSchemeData(rcfg) {
    return JSON.parse(JSON.stringify({
      _v122RuleEngine: true,
      _v123MajorSubEngine: true,
      fixedTags: typeof rcfg.fixedTags === 'string' ? rcfg.fixedTags : 'masterpiece, best quality, score_7, safe, 1girl, solo',
      randWeight: !!rcfg.randWeight,
      nsfwMinCount: clamp(Number(rcfg.nsfwMinCount ?? 2), 0, 15),
      activeRuleScope: rcfg.activeRuleScope || 'default',
      charRule: rcfg.charRule || { enabled: false, prob: 100, count: 1, withAuto: true },
      switches: rcfg.switches || [],
      drawRules: rcfg.drawRules || []
    }));
  }

  function normalizeRuleItem(r, defaultLevel) {
    if (!r || !r.targetId) return null;
    const tid = (r.targetId === 'char:library' || r.targetId === 'char:custom')
      ? r.targetId
      : migrateTargetIntervalId(r.targetId);
    if (!tid) return null;
    const attr = (r.attr === 'forbid') ? 'forbid' : 'add';
    const mode = (r.mode === 'fixed') ? 'fixed' : 'prob';
    const level = (r.level === 'nsfw') ? 'nsfw' : (defaultLevel || 'sfw');
    const isMajorGroup = !!(r.isMajorGroup || String(tid).indexOf('major:') === 0);
    const minCount = clamp(Number(r.minCount ?? r.count ?? 1), 1, 15);
    const maxCount = clamp(Number(r.maxCount ?? r.count ?? minCount), minCount, 15);
    const count = maxCount;
    const prob = clamp(Number(r.prob ?? 70), 1, 100);
    const out = {
      id: r.id || ('rl_' + tid + '_' + Math.random().toString(36).slice(2, 6)),
      attr,
      targetId: tid,
      isMajorGroup,
      expanded: !!r.expanded,
      mode,
      level,
      count,
      minCount,
      maxCount,
      prob
    };
    if (isMajorGroup && attr !== 'forbid') {
      out.subWeights = (Array.isArray(r.subWeights) && r.subWeights.length)
        ? normalizeSubWeightsList(r.subWeights)
        : getDefaultSubWeightsForMajor(tid, level);
    }
    return out;
  }

  function ensureRandCfgStructure() {
    const def = buildDefaultRandCfgV10();
    if (!state.randCfg || typeof state.randCfg !== 'object') {
      state.randCfg = JSON.parse(JSON.stringify(def));
    }
    const isMigratingToV123 = !state.randCfg._v123MajorSubEngine;
    if (typeof state.randCfg.fixedTags !== 'string' || state.randCfg.fixedTags.trim() === '1girl, solo' || state.randCfg.fixedTags.trim() === 'masterpiece, best quality, 1girl, solo') {
      state.randCfg.fixedTags = def.fixedTags;
    }
    if (typeof state.randCfg.nsfwMinCount !== 'number' || isNaN(state.randCfg.nsfwMinCount)) {
      const nSw = (state.randCfg.switches || []).find(s => s && s.id === 'sw_nsfw');
      state.randCfg.nsfwMinCount = clamp(Number((nSw && nSw.count) ?? 2), 0, 15);
    } else {
      state.randCfg.nsfwMinCount = clamp(Number(state.randCfg.nsfwMinCount), 0, 15);
    }
    if (!state.randCfg.activeRuleScope) {
      state.randCfg.activeRuleScope = 'default';
    }
    if (!state.randCfg.charRule || typeof state.randCfg.charRule !== 'object') {
      state.randCfg.charRule = { enabled: false, prob: 100, count: 1, withAuto: true };
    }
    const cr = state.randCfg.charRule;
    if (typeof cr.enabled !== 'boolean') cr.enabled = false;
    if (typeof cr.prob !== 'number') cr.prob = 100;
    if (typeof cr.count !== 'number') cr.count = 1;
    if (typeof cr.withAuto !== 'boolean') cr.withAuto = true;

    if (!Array.isArray(state.randCfg.switches) || !state.randCfg.switches.length) {
      state.randCfg.switches = JSON.parse(JSON.stringify(def.switches));
    }

    const requiredBuiltins = ['sw_quality', 'sw_artist', 'sw_char', 'sw_nsfw'];
    requiredBuiltins.forEach((reqId, reqIdx) => {
      let found = state.randCfg.switches.find(s => s && (s.id === reqId || (reqId === 'sw_char' && s.name === '含角色') || (reqId === 'sw_nsfw' && /^含\s*nsfw$/i.test(s.name || ''))));
      if (!found) {
        found = JSON.parse(JSON.stringify(def.switches[reqIdx]));
        state.randCfg.switches.splice(Math.min(reqIdx, state.randCfg.switches.length), 0, found);
      }
      found.id = reqId;
      found.builtin = true;
    });

    state.randCfg.switches.forEach(sw => {
      if (sw.id === 'sw_quality') {
        if (!sw._customNamed) sw.name = '含质量词';
        sw.builtin = true;
        if (isMigratingToV123 || !Array.isArray(sw.rules) || !sw.rules.length) {
          sw.rules = buildBuiltinSwitchRules('sw_quality');
        } else {
          sw.rules = sw.rules.map(r => normalizeRuleItem(r, 'sfw')).filter(Boolean);
        }
      } else if (sw.id === 'sw_artist') {
        if (!sw._customNamed) sw.name = '含画师';
        sw.prefixAt = true;
        sw.builtin = true;
        if (isMigratingToV123 || !Array.isArray(sw.rules) || !sw.rules.length) {
          sw.rules = buildBuiltinSwitchRules('sw_artist');
        } else {
          sw.rules = sw.rules.map(r => normalizeRuleItem(r, 'sfw')).filter(Boolean);
        }
      } else if (sw.id === 'sw_char' || sw.isCharSwitch) {
        sw.id = 'sw_char';
        if (!sw._customNamed) sw.name = '含角色';
        sw.isCharSwitch = true;
        sw.builtin = true;
        if (isMigratingToV123 || !Array.isArray(sw.rules) || !sw.rules.length) {
          sw.rules = buildBuiltinSwitchRules('sw_char');
        } else {
          sw.rules = sw.rules.map(r => normalizeRuleItem(r, 'sfw')).filter(Boolean);
        }
        cr.enabled = !!sw.enabled;
      } else if (sw.id === 'sw_nsfw') {
        if (!sw._customNamed) sw.name = '含nsfw';
        sw.builtin = true;
        if (isMigratingToV123 || !Array.isArray(sw.rules) || !sw.rules.length) {
          sw.rules = buildBuiltinSwitchRules('sw_nsfw');
        } else {
          sw.rules = sw.rules.map(r => normalizeRuleItem(r, 'nsfw')).filter(Boolean);
        }
      } else {
        sw.builtin = false;
        if (!Array.isArray(sw.rules) || !sw.rules.length) {
          sw.rules = [normalizeRuleItem({ attr: 'add', targetId: 'style', mode: 'fixed', level: 'sfw', count: 1, minCount: 1, maxCount: 1, prob: 100 }, 'sfw')];
        } else {
          sw.rules = sw.rules.map(r => normalizeRuleItem(r, 'sfw')).filter(Boolean);
        }
      }
      sw.desc = getSwitchRuleSummaryText(sw);
    });

    if (isMigratingToV123 || !Array.isArray(state.randCfg.drawRules) || !state.randCfg.drawRules.length) {
      state.randCfg.drawRules = buildDefaultDrawRulesV122();
    } else {
      state.randCfg.drawRules = state.randCfg.drawRules.map(r => normalizeRuleItem(r, 'sfw')).filter(Boolean);
    }

    state.randCfg._v122RuleEngine = true;
    state.randCfg._v123MajorSubEngine = true;

    if (state.randCfg.activeRuleScope !== 'default' && !state.randCfg.switches.some(s => s && s.id === state.randCfg.activeRuleScope)) {
      state.randCfg.activeRuleScope = 'default';
    }

    if (!Array.isArray(state.randCfg.schemes)) {
      state.randCfg.schemes = [];
    }
    if (Array.isArray(window.__EXT_RANDOM_SCHEMES__) && window.__EXT_RANDOM_SCHEMES__.length && !state.randCfg._extSchemesMerged) {
      const exIds = new Set(state.randCfg.schemes.map(s => s && s.id));
      window.__EXT_RANDOM_SCHEMES__.forEach(sc => {
        if (sc && sc.id && !exIds.has(sc.id)) {
          state.randCfg.schemes.push(JSON.parse(JSON.stringify(sc)));
          exIds.add(sc.id);
        }
      });
      state.randCfg._extSchemesMerged = true;
    }
    if (!state.randCfg.activeSchemeId) {
      state.randCfg.activeSchemeId = 'default';
    }
    if (state.randCfg.activeSchemeId !== 'default' && !state.randCfg.schemes.some(s => s && s.id === state.randCfg.activeSchemeId)) {
      state.randCfg.activeSchemeId = 'default';
    }
    return state.randCfg;
  }

  function ensureEditableSchemeOnModify() {
    const rcfg = ensureRandCfgStructure();
    if (rcfg.activeSchemeId === 'default') {
      let s1 = (rcfg.schemes || []).find(s => s && s.name === '方案1');
      if (!s1) {
        s1 = {
          id: 'scheme_1_' + Date.now().toString(36),
          name: '方案1',
          data: snapshotRandSchemeData(rcfg)
        };
        rcfg.schemes.push(s1);
      } else {
        s1.data = snapshotRandSchemeData(rcfg);
      }
      rcfg.activeSchemeId = s1.id;
      persistRandSchemeToFolder(s1);
      syncSchemeLabelUI();
    } else {
      const cur = (rcfg.schemes || []).find(s => s && s.id === rcfg.activeSchemeId);
      if (cur) {
        cur.data = snapshotRandSchemeData(rcfg);
        schedulePersistRandScheme(cur);
      }
    }
  }

  let _persistSchemeTimer = null;
  function schedulePersistRandScheme(sc) {
    if (!sc || !sc.id) return;
    if (_persistSchemeTimer) clearTimeout(_persistSchemeTimer);
    _persistSchemeTimer = setTimeout(() => {
      _persistSchemeTimer = null;
      persistRandSchemeToFolder(sc);
    }, 280);
  }

  function syncActiveSchemeSnapshot() {
    const rcfg = ensureRandCfgStructure();
    if (rcfg.activeSchemeId && rcfg.activeSchemeId !== 'default') {
      const cur = (rcfg.schemes || []).find(s => s && s.id === rcfg.activeSchemeId);
      if (cur) {
        cur.data = snapshotRandSchemeData(rcfg);
        schedulePersistRandScheme(cur);
      }
    }
    syncSchemeLabelUI();
  }

  function syncSchemeLabelUI() {
    const rcfg = ensureRandCfgStructure();
    const lbl = $('#rsCurSchemeLabel');
    if (!lbl) return;
    if (!rcfg.activeSchemeId || rcfg.activeSchemeId === 'default') {
      lbl.textContent = '默认方案';
    } else {
      const cur = (rcfg.schemes || []).find(s => s && s.id === rcfg.activeSchemeId);
      lbl.textContent = cur ? cur.name : '默认方案';
    }
  }

  function applyRandSchemeById(schemeId) {
    const rcfg = ensureRandCfgStructure();
    if (schemeId === 'default') {
      const def = buildDefaultRandCfgV10();
      rcfg._v122RuleEngine = true;
      rcfg._v123MajorSubEngine = true;
      rcfg.fixedTags = def.fixedTags;
      rcfg.randWeight = def.randWeight;
      rcfg.nsfwMinCount = def.nsfwMinCount;
      rcfg.charRule = JSON.parse(JSON.stringify(def.charRule));
      rcfg.switches = JSON.parse(JSON.stringify(def.switches));
      rcfg.drawRules = JSON.parse(JSON.stringify(def.drawRules));
      rcfg.activeSchemeId = 'default';
    } else {
      const target = (rcfg.schemes || []).find(s => s && s.id === schemeId);
      if (!target || !target.data) return false;
      const d = JSON.parse(JSON.stringify(target.data));
      rcfg._v122RuleEngine = true;
      rcfg._v123MajorSubEngine = true;
      rcfg.fixedTags = typeof d.fixedTags === 'string' ? d.fixedTags : 'masterpiece, best quality, score_7, safe, 1girl, solo';
      rcfg.randWeight = !!d.randWeight;
      rcfg.nsfwMinCount = clamp(Number(d.nsfwMinCount ?? 2), 0, 15);
      rcfg.charRule = d.charRule || { enabled: false, prob: 100, count: 1, withAuto: true };
      rcfg.switches = d.switches || [];
      rcfg.drawRules = d.drawRules || [];
      rcfg.activeSchemeId = target.id;
    }
    ensureRandCfgStructure();
    syncSchemeLabelUI();
    renderFixedTagsChipsUI();
    renderRsSwitchesTable();
    renderRsCatRulesTable();
    const rsModal = document.getElementById('modalRandomSettings');
    if (!rsModal || rsModal.hidden) {
      renderRandSwitchBar();
      save();
    }
    return true;
  }

  function resolveFixedTagFromLibrary(rawToken) {
    let s = String(rawToken || '').trim();
    if (!s) return null;
    if (/[一-鿿]/.test(s) && DICT.has(s)) {
      s = DICT.get(s);
    }
    const clean = cleanArtistEn(s);
    const k = norm(clean);
    if (!k) return null;
    let hitEn = clean;
    let hitZh = zhLookup(clean) || '';
    let hitSub = tagCatOf(clean) || '';
    if (INDEX.has(k)) {
      const idxObj = INDEX.get(k);
      if (idxObj.en) hitEn = idxObj.en;
      if (idxObj.zh) hitZh = idxObj.zh;
    }
    const isArt = (hitSub === 'artist') || s.startsWith('@') || isArtistTag(hitEn, hitSub);
    const finalEn = isArt ? ('@' + String(hitEn || '').replace(/^@+/, '').trim()) : hitEn;
    return { en: finalEn, key: k, zh: hitZh, subId: hitSub };
  }

  function renderRandSwitchBar() {
    const bar = $('#randSwitchBar');
    if (!bar) return;
    const rcfg = ensureRandCfgStructure();
    bar.innerHTML = (rcfg.switches || []).map(sw => {
      return `<label class="rand-sw-chip" title="${esc(getSwitchRuleSummaryText(sw))}">
        <input type="checkbox" data-rand-sw="${esc(sw.id)}" ${sw.enabled ? 'checked' : ''}>
        <span>${esc(sw.name)}</span>
      </label>`;
    }).join('');
  }

  function countSidebarLockedForTarget(targetId) {
    if (!targetId) return 0;
    ensureCustomCategoriesStructure();
    if (targetId === 'char:library') {
      return (state.chars || []).filter(c => c && c.locked && !findCustomCharByKey(c.key)).length;
    }
    if (targetId === 'char:custom') {
      return (state.chars || []).filter(c => c && c.locked && !!findCustomCharByKey(c.key)).length;
    }
    const lockedItems = (state.sel || []).concat(state.neg || []).filter(it => it && it.locked);
    if (!lockedItems.length) return 0;
    if (targetId === 'major:custom' || targetId === 'custom') {
      const custSet = new Set();
      (state.customTagCats || []).forEach(c => (c.tags || []).forEach(t => custSet.add(norm(cleanArtistEn(t.en)))));
      return lockedItems.filter(it => custSet.has(norm(cleanArtistEn(it.en)))).length;
    }
    const custSub = (state.customTagCats || []).find(c => c.id === targetId);
    if (custSub) {
      const subSet = new Set((custSub.tags || []).map(t => norm(cleanArtistEn(t.en))));
      return lockedItems.filter(it => subSet.has(norm(cleanArtistEn(it.en)))).length;
    }
    const tid = migrateTargetIntervalId(targetId);
    if (tid === 'nsfw_mapped:all') {
      return lockedItems.filter(it => isNsfwTag(cleanArtistEn(it.en), it.subId)).length;
    }
    if (String(tid).indexOf('nsfw_major:') === 0) {
      const mid = String(tid).slice(11);
      const m = MAJORS.find(x => x.id === mid);
      if (!m) return 0;
      const subIds = new Set((m.children || []).map(s => s.id));
      return lockedItems.filter(it => {
        const clean = cleanArtistEn(it.en);
        const sid = it.subId || tagCatOf(clean);
        return subIds.has(sid) && isNsfwTag(clean, sid);
      }).length;
    }
    if (String(tid).indexOf('nsfw_sub:') === 0) {
      const sid = String(tid).slice(9);
      return lockedItems.filter(it => {
        const clean = cleanArtistEn(it.en);
        return (it.subId || tagCatOf(clean)) === sid && isNsfwTag(clean, sid);
      }).length;
    }
    const resolveItemSub = it => {
      const clean = cleanArtistEn(it.en);
      if (it.subId && SUB_BADGE_LABEL_MAP[it.subId]) return it.subId;
      return tagCatOf(clean) || it.subId || '';
    };
    if (String(tid).indexOf('major:') === 0) {
      const mid = String(tid).slice(6);
      const m = MAJORS.find(x => x.id === mid);
      if (!m) return 0;
      const subIds = new Set((m.children || []).map(s => s.id));
      return lockedItems.filter(it => subIds.has(resolveItemSub(it))).length;
    }
    return lockedItems.filter(it => resolveItemSub(it) === tid).length;
  }

  /* 按权重不放回随机抽取 k 个不同子分类 (小分类抽取概率和为 1) */
  function sampleWeightedSubcategoriesWithoutReplacement(subWeights, k, forbiddenSet) {
    const pool = (subWeights || [])
      .filter(sw => sw && sw.subId && (!forbiddenSet || !forbiddenSet.has(sw.subId)) && Number(sw.weight ?? 0) > 0)
      .map(sw => ({ subId: sw.subId, weight: Math.max(0.0001, Number(sw.weight)) }));
    const picked = [];
    const targetK = Math.min(k, pool.length);
    for (let step = 0; step < targetK && pool.length > 0; step++) {
      const totalW = pool.reduce((a, x) => a + x.weight, 0);
      let r = Math.random() * totalW;
      let chosenIdx = pool.length - 1;
      for (let i = 0; i < pool.length; i++) {
        r -= pool[i].weight;
        if (r <= 0) {
          chosenIdx = i;
          break;
        }
      }
      picked.push(pool.splice(chosenIdx, 1)[0].subId);
    }
    return picked;
  }

  function rollRuleQuantity(rule) {
    const lo = clamp(Number(rule.minCount ?? rule.count ?? 1), 1, 15);
    const hi = clamp(Number(rule.maxCount ?? rule.count ?? lo), lo, 15);
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }

  /* V1.2.3 核心：支持大分类加权子分类抽取 + 合并默认抽取与所有启用开关的添加/禁止规则 */
  function generateRandom(forSidebarRoll) {
    const isSidebar = (forSidebarRoll === true);
    const rcfg = ensureRandCfgStructure();
    renderRandSwitchBar();

    let out = [];
    const seen = new Set();
    (state.sel || []).concat(state.neg || []).forEach(it => {
      if (it && it.locked && it.en) {
        seen.add(norm(cleanArtistEn(it.en)));
      }
    });

    const push = (t, subId, forceAt) => {
      if (!t || !t.en) return;
      const clean = cleanArtistEn(t.en);
      const k = norm(clean);
      if (!k || seen.has(k)) return;
      seen.add(k);
      const resolvedSub = subId || tagCatOf(clean) || '';
      const isArt = !!forceAt || (resolvedSub === 'artist') || isArtistTag(clean, resolvedSub);
      const finalEn = isArt ? ('@' + String(clean || '').replace(/^@+/, '').trim()) : clean;
      let w = 1;
      if (rcfg.randWeight && !isArt) {
        const steps = [0.9, 0.95, 1, 1, 1.05, 1.1, 1.15, 1.2];
        w = steps[Math.floor(Math.random() * steps.length)];
      }
      out.push({
        en: finalEn,
        key: k,
        zh: t.zh || zhLookup(clean) || zhLookup(t.en) || '',
        subId: resolvedSub,
        w
      });
    };

    const nsfwSw = (rcfg.switches || []).find(s => s && s.id === 'sw_nsfw');
    const allowNsfw = !!(nsfwSw && nsfwSw.enabled);
    state.randomNsfw = allowNsfw;

    // 1) 常驻固定必出提示词
    if (rcfg.fixedTags) {
      String(rcfg.fixedTags).split(/[,，]+/).map(s => s.trim()).filter(Boolean).forEach(rawTok => {
        let tok = rawTok;
        if (/^(safe|nsfw)$/i.test(tok)) {
          tok = allowNsfw ? 'nsfw' : 'safe';
        }
        const matched = resolveFixedTagFromLibrary(tok);
        if (matched) {
          push({ en: matched.en, zh: matched.zh }, matched.subId, matched.en.startsWith('@'));
        }
      });
    }

    const qualSw = (rcfg.switches || []).find(s => s && s.id === 'sw_quality');
    if (qualSw && qualSw.enabled) {
      ['masterpiece', 'best quality', 'score_7', allowNsfw ? 'nsfw' : 'safe'].forEach(en => {
        push({ en, zh: zhLookup(en) }, 'style', false);
      });
    }

    const charSwObj = (rcfg.switches || []).find(s => s && (s.id === 'sw_char' || s.isCharSwitch));
    const lockedCharsAll = (state.chars || []).filter(c => c && c.locked);
    if (rcfg.charRule) rcfg.charRule.enabled = !!(charSwObj && charSwObj.enabled);
    state.randomRolledCharKeys = [];

    // 2) 收集所有已启用开关中的「禁止 (forbid)」区间
    const forbiddenSet = new Set();
    const expandForbidTarget = tid => {
      if (!tid) return;
      forbiddenSet.add(tid);
      if (String(tid).indexOf('major:') === 0) {
        const mid = String(tid).slice(6);
        const m = MAJORS.find(x => x.id === mid);
        if (m && Array.isArray(m.children)) {
          m.children.forEach(s => forbiddenSet.add(s.id));
        }
      }
    };
    (rcfg.drawRules || []).forEach(r => {
      if (r && r.targetId && r.attr === 'forbid') expandForbidTarget(r.targetId);
    });
    (rcfg.switches || []).forEach(sw => {
      if (!sw || !sw.enabled) return;
      (sw.rules || []).forEach(r => {
        if (r && r.targetId && r.attr === 'forbid') expandForbidTarget(r.targetId);
      });
    });
    if (isSidebar && lockedCharsAll.length > 0 && !(charSwObj && charSwObj.enabled)) {
      CHAR_FORBIDDEN_SUB_LIST.forEach(sid => forbiddenSet.add(sid));
    }

    // 3) 建立基础「添加 (add)」规则合并表
    const mergedAddMap = new Map();
    (rcfg.drawRules || []).forEach(r => {
      if (!r || !r.targetId || r.attr === 'forbid' || r.mode === 'off') return;
      if (forbiddenSet.has(r.targetId)) return;
      mergedAddMap.set(r.targetId, Object.assign({}, r, { _source: 'default' }));
    });

    (rcfg.switches || []).forEach(sw => {
      if (!sw || !sw.enabled || sw.id === 'sw_nsfw') return;
      (sw.rules || []).forEach(r => {
        if (!r || !r.targetId || r.attr === 'forbid' || r.mode === 'off') return;
        if (forbiddenSet.has(r.targetId)) return;
        mergedAddMap.set(r.targetId, Object.assign({}, r, {
          _source: sw.id,
          _prefixAt: !!(sw.prefixAt || r.targetId === 'artist')
        }));
      });
    });

    // 4) 若开启了「含nsfw (sw_nsfw)」，建立 NSFW 规则映射（包含大分类规则与子分类条件概率）
    const nsfwMajorRuleMap = new Map();
    const nsfwSubProbMap = new Map();
    if (allowNsfw && nsfwSw && Array.isArray(nsfwSw.rules)) {
      nsfwSw.rules.forEach(nr => {
        if (!nr || !nr.targetId || nr.attr === 'forbid') return;
        if (forbiddenSet.has(nr.targetId)) return;
        if (nr.isMajorGroup || String(nr.targetId).indexOf('major:') === 0) {
          nsfwMajorRuleMap.set(nr.targetId, nr);
          const baseP = (nr.mode === 'fixed') ? 100 : clamp(Number(nr.prob ?? 55), 0, 100);
          (nr.subWeights || []).forEach(sw => {
            if (sw && sw.subId && !forbiddenSet.has(sw.subId)) {
              nsfwSubProbMap.set(sw.subId, baseP);
            }
          });
        } else {
          nsfwSubProbMap.set(nr.targetId, (nr.mode === 'fixed') ? 100 : clamp(Number(nr.prob ?? 50), 0, 100));
        }
      });
    }

    let remainingCharLockSub = lockedCharsAll.length;
    const alreadyCharKeys = new Set(lockedCharsAll.map(c => c.key));
    const evaluatedNsfwSubs = new Set();

    const rollCharacterTarget = (targetId, wantCnt, isFixed) => {
      ensureCustomCategoriesStructure();
      let actualCnt = clamp(Number(wantCnt || 1), 1, 10);
      if (remainingCharLockSub > 0) {
        const deduct = Math.min(actualCnt, remainingCharLockSub);
        remainingCharLockSub = Math.max(0, remainingCharLockSub - deduct);
        actualCnt = Math.max(0, actualCnt - deduct);
      }
      if (actualCnt <= 0) return;
      let pool = [];
      if (targetId === 'char:custom') {
        pool = (state.customChars || []).map(c => findCustomCharByKey(c.key)).filter(Boolean);
      } else {
        pool = CHARS.slice();
      }
      pool = pool.filter(c => c && c.tag && !alreadyCharKeys.has(c.key));
      for (let i = 0; i < actualCnt && pool.length > 0; i++) {
        const pickIdx = Math.floor(Math.random() * pool.length);
        const ch = pool.splice(pickIdx, 1)[0];
        if (!ch || !ch.tag) continue;
        alreadyCharKeys.add(ch.key);
        state.randomRolledCharKeys.push(ch.key);
        const prevLen = out.length;
        push({ en: ch.tag, zh: ch.charZh || ch.name || '' }, '', false);
        if ((!rcfg.charRule || rcfg.charRule.withAuto !== false) && Array.isArray(ch.auto)) {
          ch.auto.forEach(a => { if (a && a.en) push(a, '', false); });
        }
        for (let j = prevLen; j < out.length; j++) {
          out[j].fromCharKey = ch.key;
        }
      }
    };

    const drawSingleSubInterval = (sid, countToDraw, baseLevel, prefixAt) => {
      if (!sid || forbiddenSet.has(sid) || sid === 'negative') return;
      if (allowNsfw && nsfwSubProbMap.has(sid)) {
        evaluatedNsfwSubs.add(sid);
        const nsfwP = clamp(Number(nsfwSubProbMap.get(sid) ?? 50), 0, 100) / 100;
        if (chance(nsfwP)) {
          for (let i = 0; i < countToDraw; i++) {
            let res = pickTagFromTarget(sid, false, seen, 'nsfw');
            if (!res || !res.tag) res = pickTagFromTarget(sid, false, seen, baseLevel || 'sfw');
            if (res && res.tag) push(res.tag, res.subId, !!prefixAt || res.subId === 'artist');
          }
          return;
        }
      }
      const wantLevel = (!allowNsfw && baseLevel === 'nsfw') ? 'sfw' : (baseLevel || 'sfw');
      for (let i = 0; i < countToDraw; i++) {
        let res = pickTagFromTarget(sid, false, seen, wantLevel);
        if ((!res || !res.tag) && allowNsfw && wantLevel === 'sfw') {
          res = pickTagFromTarget(sid, false, seen, 'nsfw');
        }
        if (res && res.tag) push(res.tag, res.subId, !!prefixAt || res.subId === 'artist');
      }
    };

    // 5) 执行合并后的基础抽取规则（支持大分类按子分类概率和=1不放回抽样 K 个小分类，每个小分类各抽 1 个）
    mergedAddMap.forEach((rule, tid) => {
      if (forbiddenSet.has(tid) || tid === 'negative') return;
      const isFixed = (rule.mode === 'fixed');
      const prob = isFixed ? 1 : (clamp(Number(rule.prob ?? 70), 1, 100) / 100);
      if (!chance(prob)) {
        if (nsfwSubProbMap.has(tid)) evaluatedNsfwSubs.add(tid);
        return;
      }

      if (tid === 'char:library' || tid === 'char:custom') {
        rollCharacterTarget(tid, rollRuleQuantity(rule), isFixed);
        return;
      }

      if (rule.isMajorGroup || String(tid).indexOf('major:') === 0) {
        const subWeights = (Array.isArray(rule.subWeights) && rule.subWeights.length)
          ? rule.subWeights
          : getDefaultSubWeightsForMajor(tid, rule.level || 'sfw');
        const kSubs = rollRuleQuantity(rule);
        // 统计该大分类下属候选小分类（未单独配置独立抽取规则或当前权重>0的小分类）中已锁定的标签数量并扣减
        const mid = String(tid).replace(/^major:/, '');
        const mObj = MAJORS.find(x => x.id === mid);
        const allMajSubIds = (mObj && Array.isArray(mObj.children)) ? mObj.children.map(s => s.id) : subWeights.map(sw => sw && sw.subId).filter(Boolean);
        const dedicatedSubIds = new Set(Array.from(mergedAddMap.keys()).filter(k => String(k).indexOf('major:') !== 0));
        const activeWeightSet = new Set(subWeights.filter(sw => sw && sw.subId && Number(sw.weight ?? 0) > 0).map(sw => sw.subId));
        const managedSubIds = allMajSubIds.filter(sid => activeWeightSet.has(sid) || !dedicatedSubIds.has(sid));
        const lockedInMajor = managedSubIds.reduce((sum, sid) => sum + countSidebarLockedForTarget(sid), 0);
        const effKSubs = Math.max(0, kSubs - lockedInMajor);
        if (effKSubs <= 0) return;
        // 排除已有锁定标签的小分类，防止同一小分类重复抽取
        const unlockedSubWeights = subWeights.filter(sw => sw && sw.subId && countSidebarLockedForTarget(sw.subId) <= 0);
        const chosenSubIds = sampleWeightedSubcategoriesWithoutReplacement(unlockedSubWeights, effKSubs, forbiddenSet);
        chosenSubIds.forEach(sid => {
          drawSingleSubInterval(sid, 1, rule.level || 'sfw', rule._prefixAt);
        });
        return;
      }

      const rawCnt = rollRuleQuantity(rule);
      const lockedCnt = countSidebarLockedForTarget(tid);
      const effCnt = Math.max(0, rawCnt - lockedCnt);
      if (effCnt <= 0) {
        if (nsfwSubProbMap.has(tid)) evaluatedNsfwSubs.add(tid);
        return;
      }
            // 防连身裙穿模检测：若当前抽取下装 (lower_body)，但前面已抽得连身裙/连体服/长袍，则自动跳过下装
      if (tid === 'lower_body') {
        const hasOnePiece = out.some(it => {
          const sub = it.subId || tagCatOf(it.en);
          if (sub !== 'upper_body') return false;
          return /\b(dress|robe|kimono|yukata|bodysuit|cheongsam|one-piece|bitchsuit|haori)\b/i.test(it.en);
        });
        if (hasOnePiece) return;
      }
      drawSingleSubInterval(tid, effCnt, rule.level || 'sfw', rule._prefixAt);
    });

    // 6) 若开启了「含nsfw」开关，执行 NSFW 大分类规则抽取（例如动作大分类最多抽取 2 个小分类）并保证达到最低抽取数量
    if (allowNsfw) {
      nsfwMajorRuleMap.forEach((nRule, mTid) => {
        if (forbiddenSet.has(mTid)) return;
        const isFixed = (nRule.mode === 'fixed');
        const prob = isFixed ? 1 : (clamp(Number(nRule.prob ?? 60), 1, 100) / 100);
        if (!chance(prob)) return;
        const kSubs = rollRuleQuantity(nRule);
        const normMajorId = 'nsfw_major:' + String(mTid).replace(/^(nsfw_)?major:/, '');
        const lockedNsfwInMajor = countSidebarLockedForTarget(normMajorId);
        const effKSubs = Math.max(0, kSubs - lockedNsfwInMajor);
        if (effKSubs <= 0) return;
        // 过滤掉被禁止或已有锁定标签的小分类
        const availWeights = (nRule.subWeights || []).filter(sw => sw && sw.subId && !forbiddenSet.has(sw.subId) && countSidebarLockedForTarget(sw.subId) <= 0);
        const chosenSubs = sampleWeightedSubcategoriesWithoutReplacement(availWeights, effKSubs, forbiddenSet);
        chosenSubs.forEach(sid => {
          const res = pickTagFromTarget(sid, false, seen, 'nsfw');
          if (res && res.tag) {
            push(res.tag, res.subId, res.subId === 'artist');
          }
        });
      });

      // 检查已抽出的橙红（限制）标签数是否达到「最低抽取数量 (nsfwMinCount)」
      const nsfwSwMin = clamp(Number(rcfg.nsfwMinCount ?? 2), 0, 15);
      const lockedNsfwCnt = countSidebarLockedForTarget('nsfw_mapped:all');
      const targetMinNsfw = Math.max(0, nsfwSwMin - lockedNsfwCnt);
      let curNsfwCnt = out.filter(it => isNsfwTag(it.en, it.subId)).length;
      const allowedNsfwPoolTids = Array.from(nsfwSubProbMap.keys()).filter(sid => !forbiddenSet.has(sid));
      let guard = 0;
      while (curNsfwCnt < targetMinNsfw && guard < 50) {
        guard++;
        let res = null;
        if (allowedNsfwPoolTids.length) {
          const rTid = rand(allowedNsfwPoolTids);
          res = pickTagFromTarget(rTid, false, seen, 'nsfw');
        }
        if (!res || !res.tag) {
          res = pickTagFromTarget('nsfw_mapped:all', false, seen, 'nsfw');
        }
        if (res && res.tag && !forbiddenSet.has(res.subId)) {
          const beforeLen = out.length;
          push(res.tag, res.subId, res.subId === 'artist');
          if (out.length > beforeLen) curNsfwCnt++;
        }
      }
    }

    // 7) 按 Anima 官方优先级铁律排序
    out = normalizeSafetyInList(out, 'pos', allowNsfw);
    out = out.map((it, i) => ({ it, i })).sort((a, b) => rankOf(a.it) - rankOf(b.it) || a.i - b.i).map(x => x.it);

    state.randomSet = out;
    renderRandom();
    if (!out.length && !isSidebar) toast('当前随机规则未抽出词条，可在「⚙ 设置」中开启区间或开关');
  }

  function renderRandom() {
    let list = state.randomSet || [];
    if (list.length) {
      list = list.map((it, i) => ({ it, i })).sort((a, b) => rankOf(a.it) - rankOf(b.it) || a.i - b.i).map(x => x.it);
      state.randomSet = list;
    }
    $('#randChips').innerHTML = list.map((t, i) => {
      const segInfo = getPromptSegmentInfo(t);
      return `<span class="pill" data-i="${i}" title="第 ${segInfo.label} 段 · 点击移除">${esc(t.en)}${(state.showZh && t.zh) ? `<span class="zh">(${esc(t.zh)})</span>` : ''}</span>`;
    }).join('');
    const text = list.map(t => t.en).join(', ');
    $('#randOutput').value = text;
    $('#randStat').textContent = `${list.length} 个标签（已按 10 段排序）`;
  }

  /* ---------- 翻译 ---------- */

  function normalizeEn(s) {
    return String(s).toLowerCase().replace(/[.!?。！？]+$/g, '').replace(/\s+/g, ' ').trim();
  }

  function isChinese(s) { return /[\u4e00-\u9fff]/.test(s); }

  /* 中文虚词：跳过但不当作未识别，保证「站在雨中的天台」也能拆出 rain rooftop */
  const SKIP_CH = new Set('的了着地得之在是中上里外内边下把被和与及或些');

  function translateSegment(seg) {
    const parts = [];
    const miss = [];
    let i = 0;
    let unknown = '';
    const flush = () => {
      if (!unknown) return;
      if (!PARTICLES.test(unknown)) miss.push(unknown);
      unknown = '';
    };
    while (i < seg.length) {
      const ch = seg[i];
      if (SKIP_CH.has(ch)) { flush(); i++; continue; }
      let hit = null;
      const maxL = Math.min(MAX_KEY, seg.length - i);
      for (let L = maxL; L >= 1; L--) {
        const k = seg.substr(i, L);
        if (DICT.has(k)) { hit = { v: DICT.get(k), L }; break; }
      }
      if (hit) {
        flush();
        if (hit.v) parts.push(hit.v);
        i += hit.L;
      } else {
        unknown += ch;
        i++;
      }
    }
    flush();
    return { en: normalizeEn(dedupeWords(parts.join(' '))), miss };
  }

  function dedupeWords(s) {
    const out = [];
    String(s).split(/\s+/).forEach(w => {
      if (!w) return;
      if (out.length && out[out.length - 1] === w) return;
      out.push(w);
    });
    return out.join(' ');
  }

  function translateText(text) {
    const segs = String(text).split(/[\n,，、;；/|]+/).map(s => s.trim()).filter(Boolean);
    const items = [];
    segs.forEach(seg => {
      if (!isChinese(seg)) {
        items.push({ en: normalizeEn(seg), zh: translateToZh(seg), miss: [], raw: seg });
        return;
      }
      const r = translateSegment(seg);
      items.push({ en: r.en, zh: seg, miss: r.miss, raw: seg });
    });
    return items;
  }

  /* ---------- 联网翻译 ----------
     优先走本地服务 /api/translate（可用大模型，质量最好），
     服务没开或失败时直连 MyMemory。两者都失败才抛错。
     长文本按句切块，避免 MyMemory 的 500 字节限制。 */
  function cleanTranslated(t, to) {
    let s = String(t || '').replace(/\s+/g, ' ').trim();
    s = s.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
    s = s.replace(/[。.]+$/g, '').trim();
    if (to === 'en') {
      s = s.replace(/[，、；;]+/g, ', ').replace(/\s*,\s*/g, ', ').trim();
      if (/^[A-Z]/.test(s) && !/^[A-Z]{2,}/.test(s)) s = s.charAt(0).toLowerCase() + s.slice(1);
    } else {
      s = s.replace(/,\s*/g, '，').trim();
    }
    return s;
  }

  function splitForApi(text, max) {
    const whole = String(text).trim();
    if (whole.length <= max) return [whole];
    const chunks = [];
    let buf = '';
    whole.split(/(?<=[。！？.!?\n])/).forEach(seg => {
      if ((buf + seg).length > max && buf) { chunks.push(buf); buf = seg; }
      else buf += seg;
    });
    if (buf) chunks.push(buf);
    return chunks.filter(Boolean);
  }

  /* 只有配置里填的是本机服务地址时才走 /api/translate，
     填的是模型接口（或留空）就直连 MyMemory，别把中文 POST 给模型域名 */
  function translateEndpoint() {
    try {
      if (typeof aiCfg !== 'undefined' && aiCfg && aiCfg.base && aiIsServer()) return aiCfg.base;
      if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) return location.origin;
    } catch (e) { /* ignore */ }
    return '';
  }

  async function fetchT(url, opts, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try { return await fetch(url, Object.assign({}, opts || {}, { signal: ctl.signal })); }
    finally { clearTimeout(timer); }
  }

  async function serverTranslate(text, from, to) {
    // MyMemory 单次上限 500 字节：中文按 150 字切
    const chunks = splitForApi(text, from === 'zh-CN' ? 150 : 400);
    const parts = [];
    for (const chunk of chunks) {
      parts.push(await translateChunk(chunk, from, to));
    }
    return parts.join(to === 'en' ? ', ' : '');
  }

  async function translateChunk(q, from, to) {
    const sl = (!from || from === 'auto') ? 'auto' : from;
    const tl = to || 'en';
    const base = translateEndpoint();
    if (base) {
      try {
        const r = await fetchT(base + '/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            q, from: sl, to: tl,
            apiKey: (typeof aiCfg !== 'undefined' && aiCfg.key) || '',
            model: (typeof aiCfg !== 'undefined' && aiCfg.model) || ''
          })
        }, 9000);
        if (r.ok) {
          const d = await r.json();
          if (d && d.text) return cleanTranslated(d.text, tl);
        }
      } catch (e) { /* 服务未启动，继续走直连 */ }
    }
    // 优先使用国内免 VPN 直连的有道翻译接口 (aidemo.youdao.com)
    try {
      const effFrom = sl === 'auto' ? (isChinese(q) ? 'zh-CHS' : 'en') : (sl === 'zh-CN' ? 'zh-CHS' : sl);
      const effTo = tl === 'zh-CN' ? 'zh-CHS' : tl;
      const bodyStr = 'q=' + encodeURIComponent(q) + '&from=' + encodeURIComponent(effFrom) + '&to=' + encodeURIComponent(effTo);
      const ydRes = await fetchT('https://aidemo.youdao.com/trans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: bodyStr
      }, 6000);
      if (ydRes.ok) {
        const ydJson = await ydRes.json();
        if (ydJson && String(ydJson.errorCode) === '0' && Array.isArray(ydJson.translation) && ydJson.translation.length) {
          const joined = ydJson.translation.join('\n').trim();
          if (joined) return cleanTranslated(joined, tl);
        }
      }
    } catch (e) { /* fallback to MyMemory */ }
    const mmFrom = sl === 'auto' ? (isChinese(q) ? 'zh-CN' : 'en') : sl;
    const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(q) +
      '&langpair=' + encodeURIComponent(mmFrom + '|' + tl);
    const res = await fetchT(url, {}, 9000);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const t = j && j.responseData && j.responseData.translatedText;
    if (!t || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(String(t))) throw new Error('在线翻译暂无结果');
    return cleanTranslated(t, tl);
  }

  async function onlineTranslate(q) { return serverTranslate(q, 'zh-CN', 'en'); }

  /* ---------- 英 → 中（反向翻译） ----------
     先用本地词典逐词查，查不到才回退到在线接口。 */
  function zhOf(en) {
    const k = norm(en);
    if (!k) return '';
    if (REV.has(k)) return REV.get(k);
    if (INDEX.has(k)) return INDEX.get(k).zh || '';
    const bare = k.replace(/^\(+|\)+$/g, '');
    if (REV.has(bare)) return REV.get(bare);
    return '';
  }

  /* 去掉 SD 权重括号，只留下裸标签：((silver hair:1.2)) → silver hair */
  function stripWeight(t) { return t.replace(/:\s*\d*\.?\d+\s*$/, '').trim(); }

  function bareToken(s) {
    let t = String(s).trim().replace(/\\\(/g, '(').replace(/\\\)/g, ')');
    const alt = t.match(/^\[([^\[\]]+):([^\[\]]+):[\d.]+\]$/);
    if (alt) t = alt[2].trim();
    t = stripWeight(t);
    for (let i = 0; i < 4; i++) {
      if (!(/^[(\[{]/.test(t) && /[)\]}]$/.test(t))) break;
      t = stripWeight(t.slice(1, -1));
    }
    return t;
  }

  function translateToZh(text) {
    const segs = String(text).split(/[\n,;|]+/).map(s => s.trim()).filter(Boolean);
    const out = [];
    segs.forEach(seg => {
      const whole = zhOf(bareToken(seg));
      if (whole) { out.push(whole); return; }
      const words = bareToken(seg).split(/\s+/).filter(Boolean);
      const parts = [];
      let i = 0;
      while (i < words.length) {
        let hit = '';
        for (let L = Math.min(4, words.length - i); L >= 1; L--) {
          const z = zhOf(words.slice(i, i + L).join(' '));
          if (z) { hit = z; i += L; break; }
        }
        if (hit) parts.push({ t: hit, zh: true });
        else { parts.push({ t: words[i], zh: false }); i++; }
      }
      let s = '';
      parts.forEach((p, idx) => {
        if (idx > 0 && !(p.zh && parts[idx - 1].zh)) s += ' ';
        s += p.t;
      });
      out.push(s);
    });
    return out.join('，');
  }

  /* 英→中：先 Google 免费端点，挂了再 MyMemory，两个都挂才认输 */
  async function gTranslate(q) {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=' +
      encodeURIComponent(q);
    const res = await fetchT(url, {}, 9000);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const seg = (Array.isArray(j) && Array.isArray(j[0])) ? j[0].map(x => (x && x[0]) || '').join('') : '';
    if (!seg) throw new Error('无结果');
    return String(seg).trim();
  }

  async function mmTranslate(q) {
    const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(q) + '&langpair=en|zh-CN';
    const res = await fetchT(url, {}, 9000);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const t = j && j.responseData && j.responseData.translatedText;
    if (!t || /MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID/i.test(String(t))) throw new Error('无结果');
    return String(t).trim();
  }

  async function onlineTranslateToZh(q) {
    const text = String(q || '').trim();
    if (!text) return '';
    let lastErr = null;
    for (const fn of [mmTranslate, gTranslate]) {
      try {
        const t = await fn(text);
        if (t) return t;
      } catch (e) { lastErr = e; }
    }
    throw (lastErr || new Error('在线翻译暂无结果'));
  }

  function renderPreview(items, box) {
    box.innerHTML = items.map(it => {
      if (!it.en) return '';
      const bad = it.miss && it.miss.length;
      const zh = it.zh || zhLookup(it.en);
      return `<span class="pill${bad ? ' bad' : ''}" title="${bad ? '未识别：' + esc(it.miss.join('、')) : ''}">${esc(it.en)}${(state.showZh && zh) ? `<span class="zh">(${esc(zh)})</span>` : ''}${bad ? ' ⚠' : ''}</span>`;
    }).join('');
  }

  /* =====================================================================
     5.5 逆向识别：把一整段现成提示词还原成「已勾选」状态
     ===================================================================== */

  const CHAR_BY_TAG = new Map();
  CHARS.forEach(c => CHAR_BY_TAG.set(norm(c.tag), c));
  /* 去空格索引：hu tao (genshin impact) 也能被 hutao 命中 */
  const CHAR_FLAT = new Map();
  CHARS.forEach(c => CHAR_FLAT.set(norm(c.tag).replace(/\s+/g, ''), c));

  const PLURAL_RE = /(?:es|s)$/;

  /* 把单个片段清洗成 { s, w }：
     支持 (tag:1.2)、{{tag}}、[tag]、[a:b:0.5]、\( 转义、<lora:…>、下划线写法 */
  function cleanToken(raw) {
    let s = String(raw)
      .replace(/\\\(/g, '(').replace(/\\\)/g, ')')
      .replace(/\\\[/g, '[').replace(/\\\]/g, ']')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\bBREAK\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    let w = 1;

    const mw = s.match(/^\((.+?):\s*([0-9]*\.?[0-9]+)\s*\)$/);
    if (mw) { s = mw[1].trim(); w = clamp(parseFloat(mw[2]) || 1, 0.1, 3); }

    for (let g = 0; g < 8; g++) {
      if (/^\{\{[\s\S]*\}\}$/.test(s)) { s = s.slice(2, -2).trim(); w *= 1.1; continue; }
      if (/^\{[^{}]*\}$/.test(s)) { s = s.slice(1, -1).trim(); w *= 1.05; continue; }
      if (/^\[\[[\s\S]*\]\]$/.test(s)) { s = s.slice(2, -2).trim(); w /= 1.1; continue; }
      if (/^\[[^\[\]]*\]$/.test(s)) {
        const inner = s.slice(1, -1).trim();
        const seg = inner.split(':');
        /* [from:to:when] 这种 prompt editing 取 to */
        s = (seg.length >= 2 && seg[1].trim()) ? seg[1].trim() : inner;
        w /= 1.05;
        continue;
      }
      /* SD 的 (tag) 权重写法；只在括号包住整段时剥离，避免拆坏 suzuran (arknights) */
      if (wrapsWhole(s)) { s = s.slice(1, -1).trim(); w *= 1.1; continue; }
      break;
    }
    return { s: s.replace(/\s+/g, ' ').trim(), w: Number(w.toFixed(2)) };
  }

  function wrapsWhole(s) {
    if (s[0] !== '(' || s[s.length - 1] !== ')') return false;
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') {
        depth--;
        if (depth === 0) return i === s.length - 1;
      }
    }
    return false;
  }

  /* 把一个英文/中文片段匹配回标签库，尽量宽容 */
  function resolveOne(name, fuzzy) {
    const cands = [name];
    const push = v => { if (v && !cands.includes(v)) cands.push(v); };
    const unesc = v => v.replace(/\\([()\[\]{}])/g, '$1');   // 还原 \( \) 转义
    push(unesc(name));              // encore \(wuthering waves\)
    const a = name.replace(/_/g, ' ');
    if (a !== name) cands.push(a);
    const b = name.replace(/[.。,，!！?？~～:：]+$/g, '').trim();
    if (b && b !== name) cands.push(b);
    const c3 = name.replace(/\s*\((?!.*\))/g, ' (').trim();
    if (c3 !== name) cands.push(c3);

    const hit = (k, extraMeta) => {
      if (!k) return null;
      if (INDEX.has(k)) return Object.assign({ en: INDEX.get(k).en, zh: INDEX.get(k).zh, key: k, char: CHAR_BY_TAG.get(k) || null }, extraMeta || {});
      const atK = k.startsWith('@') ? k.replace(/^@+/, '@') : ('@' + k);
      if (INDEX.has(atK)) return Object.assign({ en: INDEX.get(atK).en, zh: INDEX.get(atK).zh, key: atK, char: null }, extraMeta || {});
      if (CHAR_BY_TAG.has(k)) { const c = CHAR_BY_TAG.get(k); return Object.assign({ en: c.tag, zh: c.charZh, key: k, char: c }, extraMeta || {}); }
      return null;
    };

    const hitOrFullDict = (k, extraMeta) => {
      const r = hit(k, extraMeta);
      if (r) return r;
      const fd = lookupFullOfflineDict(k);
      if (fd) {
        const outEn = (fd.cat === 1 && !fd.en.startsWith('@')) ? ('@' + fd.en) : fd.en;
        return Object.assign({
          en: outEn,
          zh: fd.zh || '',
          key: norm(outEn),
          char: CHAR_BY_TAG.get(norm(fd.en)) || null,
          fromFullDict: true
        }, extraMeta || {});
      }
      return null;
    };

    // Stage 1 & 2: Exact & Normalized match in main library
    for (const c of cands) {
      const r = hit(norm(c));
      if (r) return r;
    }
    // Stage 3: Official Danbooru Alias resolution (198,486 aliases in alias-loader.js)
    for (const c of cands) {
      const aliasTarget = resolveOfficialAliasKey(c);
      if (aliasTarget && norm(aliasTarget) !== norm(c)) {
        const r = hitOrFullDict(norm(aliasTarget), { aliasFrom: c });
        if (r) return r;
      }
    }
    // Stage 3.5: Direct match in 336,171-entry Full Offline Dictionary
    for (const c of cands) {
      const fdHit = hitOrFullDict(norm(c));
      if (fdHit) return fdHit;
    }
    /* 悬空左括号被截断：encore (wuthering waves */
    for (const c of cands) {
      const fixed = c.replace(/\s*\([^)]*$/, '').trim();
      if (fixed && fixed !== c) { const r = hit(norm(fixed)); if (r) return r; }
    }
    /* 去空格 / 去掉悬空括号再比一次：hutao -> hu tao (genshin impact) */
    for (const c of cands) {
      const f = norm(unesc(c).replace(/\s*\([^)]*$/, '')).replace(/\s+/g, '');
      if (f.length < 4) continue;
      if (CHAR_FLAT.has(f)) {
        const ch = CHAR_FLAT.get(f);
        return { en: ch.tag, zh: ch.charZh, key: norm(ch.tag), char: ch };
      }
      let found = null;
      for (const [k, ch] of CHAR_FLAT) {
        if (k.startsWith(f + '(')) { found = ch; break; }
      }
      if (found) return { en: found.tag, zh: found.charZh, key: norm(found.tag), char: found };
    }
    if (!fuzzy) return null;

    /* 复数 / 单数（含 ies <-> y 与 es/s 双向归一） */
    for (const c of cands) {
      const k = norm(c);
      if (k.endsWith('ies') && k.length > 4) {
        const r = hit(k.slice(0, -3) + 'y');
        if (r) return r;
      } else if (k.endsWith('y') && k.length > 3) {
        const r = hit(k.slice(0, -1) + 'ies');
        if (r) return r;
      }
      if (PLURAL_RE.test(k)) {
        const r = hit(k.replace(PLURAL_RE, '')) || hit(k.replace(/s$/, ''));
        if (r) return r;
      } else {
        const r = hit(k + 's') || hit(k + 'es');
        if (r) return r;
      }
    }
    /* 连字符与空格紧凑归一匹配（如 high-leg <-> highleg, one piece <-> one-piece） */
    for (const c of cands) {
      const comp = norm(c).replace(/[-_\s]+/g, '');
      if (comp.length < 4) continue;
      for (const [key, v] of INDEX) {
        if (key.replace(/[-_\s]+/g, '') === comp) {
          return { en: v.en, zh: v.zh, key, char: CHAR_BY_TAG.get(key) || null };
        }
      }
    }
    /* 省略了括号后缀：suzuran → suzuran (arknights) */
    for (const c of cands) {
      const k = norm(c);
      if (!k || k.includes('(')) continue;
      for (const [key, v] of INDEX) {
        if (key.startsWith(k + ' (') || key.startsWith(k + '(')) {
          return { en: v.en, zh: v.zh, key, char: CHAR_BY_TAG.get(key) || null };
        }
      }
    }
    /* 中文片段先翻译再匹配 */
    if (isChinese(name)) {
      const t = translateSegment(name);
      if (t.en) {
        const k = norm(t.en);
        const r = hitOrFullDict(k);
        if (r) return r;
        if (t.en.split(/\s+/).length > 1) {
          const first = hitOrFullDict(norm(t.en.replace(/\s+\S+$/, '')));
          if (first) return first;
        }
      }
    }
    /* Stage 6: 轻量编辑距离容错（针对长度 >= 6 的拼写微瑕词，距离 <= 1） */
    const qNorm = norm(name);
    if (qNorm.length >= 6 && /^[a-z0-9_\s-]+$/.test(qNorm)) {
      const qLen = qNorm.length;
      for (const [key, v] of INDEX) {
        if (Math.abs(key.length - qLen) > 1 || key[0] !== qNorm[0]) continue;
        // 1-edit distance check
        let diffs = 0, i = 0, j = 0;
        while (i < qLen && j < key.length) {
          if (qNorm[i] === key[j]) { i++; j++; }
          else {
            diffs++;
            if (diffs > 1) break;
            if (qLen > key.length) i++;
            else if (qLen < key.length) j++;
            else { i++; j++; }
          }
        }
        diffs += (qLen - i) + (key.length - j);
        if (diffs === 1) {
          return { en: v.en, zh: v.zh, key, char: CHAR_BY_TAG.get(key) || null, aliasFrom: name };
        }
      }
    }
    return null;
  }

  function splitPromptTokens(text) {
    return String(text)
      .replace(/<[^>]*>/g, ' ')
      .split(/[,\n，、;；|]+/)
      .map(s => s.trim())
      .filter(Boolean);
  }

  /* 自动区分正/负面段落，并丢掉 WebUI 的生成参数尾巴 */
  function splitPromptSections(text) {
    let src = String(text);
    const cut = src.search(/(?:^|\n)\s*(?:steps|sampler|cfg scale|seed|size|model|model hash|denoising strength|clip skip|version)\s*:/i);
    if (cut >= 0) src = src.slice(0, cut);
    const m = src.match(/(?:negative\s*prompt|负面提示词|反向提示词|负向提示词)\s*[:：]?/i);
    if (!m) return { pos: src, neg: '' };
    return { pos: src.slice(0, m.index), neg: src.slice(m.index + m[0].length) };
  }

  function analyzePrompt(text, opts) {
    const sections = opts.smart ? splitPromptSections(text) : { pos: text, neg: '' };

    const side = t => {
      const matched = [];
      const unknown = [];
      const seen = new Map();
      splitPromptTokens(t).forEach(raw => {
        const c = cleanToken(raw);
        if (!c.s || c.s.length < 2) return;
        const r = resolveOne(c.s, opts.fuzzy);
        if (!r) { if (!unknown.includes(c.s)) unknown.push(c.s); return; }
        const prev = seen.get(r.key);
        if (prev) { prev.w = Math.max(prev.w, c.w); return; }
        const item = { en: r.en, zh: r.zh, key: r.key, w: c.w, char: r.char, raw: c.s, aliasFrom: r.aliasFrom || '', fromFullDict: !!r.fromFullDict };
        seen.set(r.key, item);
        matched.push(item);
      });
      return { matched, unknown };
    };

    return { pos: side(sections.pos), neg: side(sections.neg) };
  }

  function detectPreset(res) {
    const keys = new Set(res.pos.matched.map(i => i.key));
    let best = null;
    PRESETS.forEach(p => {
      if (!p.tags.length) return;
      const hit = p.tags.filter(t => keys.has(norm(t.en))).length;
      const ratio = hit / p.tags.length;
      if (ratio >= 0.75 && (!best || ratio > best.ratio)) best = { p, ratio, hit };
    });
    return best;
  }

  /* 把识别结果真正写进 已选 / 负面 */
  function applyParsed(res, opts) {
    if (opts.wipe) {
      state.sel = [];
      state.neg = [];
      state.chars = [];
      stateCharTags = [];
    }

    let added = 0;
    let chars = 0;

    const put = (list, it) => {
      const k = it.key || norm(it.en);
      const exist = list.find(x => x.key === k);
      if (exist) {
        if ((it.w || 1) > (exist.w || 1)) exist.w = it.w;
        return false;
      }
      list.push({ key: k, en: it.en, zh: it.zh || zhLookup(it.en), w: it.w || 1 });
      return true;
    };

    const applyChar = c => {
      const tags = [];
      if (put(state.sel, { en: c.tag, zh: c.charZh, key: norm(c.tag), w: 1 })) tags.push(norm(c.tag));
      c.auto.forEach(a => {
        if (put(state.sel, { en: a.en, zh: a.zh, key: norm(a.en), w: 1 })) tags.push(norm(a.en));
      });
      state.chars = state.chars.filter(x => x.key !== c.key);
      state.chars.push({ key: c.key, name: c.name, tag: c.tag, charZh: c.charZh, tags: tags });
      syncCharTags();
      chars++;
    };

    res.pos.matched.forEach(it => {
      if (it.char) applyChar(it.char);
      else if (put(state.sel, it)) added++;
    });
    res.neg.matched.forEach(it => {
      if (!it.char && put(state.neg, it)) added++;
    });

    let custom = 0;
    if (opts.addUnknown) {
      const addUnknown = (en, list) => {
        if (!en || en.length > 60) return;
        if (!state.custom.some(t => norm(t.en) === norm(en))) {
          state.custom.push({ en, zh: zhLookup(en) || trGet(en) });
          idxAdd(en, zhLookup(en) || trGet(en));
          custom++;
          queueTr(en);
        }
        if (list && put(list, { en, zh: zhLookup(en) || trGet(en), key: norm(en), w: 1 })) added++;
      };
      res.pos.unknown.forEach(en => addUnknown(en, state.sel));
      res.neg.unknown.forEach(en => addUnknown(en, state.neg));
      /* 粘完就开始翻，不等界面渲染 */
      const pend = [...res.pos.unknown, ...res.neg.unknown].filter(w => w && !trGet(w) && !zhOf(w));
      if (pend.length) queueTr(pend);
    }

    state.mode = 'pos';
    syncModeSeg();
    if (opts.wipe) state.cat = 'all';
    state.highlight = new Set(res.pos.matched.map(i => i.key));
    clearTimeout(state._hlTimer);
    state._hlTimer = setTimeout(() => { state.highlight = null; renderGrid(); }, 9000);
    renderAll();
    save();
    return { added, chars, custom };
  }

  function renderParsePreview(res) {
    const meta = detectPreset(res);
    const unkPos = res.pos.unknown || [];
    const unkNeg = res.neg.unknown || [];
    const unkAll = [...unkPos, ...unkNeg];
    const showZh = $('#parseShowZh') ? !!$('#parseShowZh').checked : state.showZh;

    const renderMatchedPill = it => {
      const zh = it.zh || zhLookup(it.en) || trGet(it.en) || '';
      const aliasBadge = it.aliasFrom
        ? `<span class="alias-badge" title="已通过官方别名库自动归一：${esc(it.aliasFrom)} → ${esc(it.en)}">🔄 别名:${esc(it.aliasFrom)}</span>`
        : (it.fromFullDict ? `<span class="alias-badge full-dict-badge" title="命中本地 33.6 万全量离线扩展词库">📚 扩展库</span>` : '');
      return `<span class="pill" title="已识别标签：${esc(it.en)}${zh ? ' (' + esc(zh) + ')' : ''}${it.aliasFrom ? ' [原输入: ' + esc(it.aliasFrom) + ']' : ''}">
        <span class="en">${esc(it.en)}</span>
        ${showZh && zh ? `<span class="zh">(${esc(zh)})</span>` : ''}
        ${it.w !== 1 ? `<b>:${it.w}</b>` : ''}
        ${it.char ? ' <i>角色</i>' : ''}
        ${aliasBadge}
      </span>`;
    };

    const renderUnknownHighlightedPill = (u, isNegSide) => {
      const z = trGet(u) || zhOf(u) || zhLookup(u) || '';
      const autoTrOn = $('#parseAutoTr') ? !!$('#parseAutoTr').checked : true;
      return `<span class="pill parse-unrec-hl" data-tr="${esc(u)}" title="未识别提示词（已高亮显示，点击可手动修改中文释义）">
        <span class="en">${esc(u)}</span>
        ${showZh ? (z ? `<span class="zh">(${esc(z)})</span>` : (autoTrOn ? `<i class="tr-miss" style="font-size:11px;opacity:0.85;margin-left:3px">翻译中…</i>` : '')) : ''}
        <span class="unrec-tag-badge">${isNegSide ? '⚠ 未识别·负面' : '⚠ 未识别'}</span>
      </span>`;
    };

    const parts = [];
    if (res.pos.matched.length || unkPos.length) {
      parts.push(
        res.pos.matched.map(renderMatchedPill).join('') +
        unkPos.map(u => renderUnknownHighlightedPill(u, false)).join('')
      );
    }
    if (res.neg.matched.length || unkNeg.length) {
      parts.push(
        '<span class="parse-sep">负面</span>' +
        res.neg.matched.map(renderMatchedPill).join('') +
        unkNeg.map(u => renderUnknownHighlightedPill(u, true)).join('')
      );
    }
    $('#parseChips').innerHTML = parts.join('') || '<span class="muted">没有识别到任何提示词</span>';

    const box = $('#parseUnknownBox');
    if (box) {
      box.hidden = true;
      box.innerHTML = '';
    }

    const totalMatched = res.pos.matched.length + res.neg.matched.length;
    $('#parseStat').innerHTML =
      `已识别 <b>${totalMatched}</b> 个库内标签` +
      (res.neg.matched.length ? `（含负面 ${res.neg.matched.length} 个）` : '') +
      (unkAll.length ? ` · <span style="color:#f59e0b;font-weight:600">⚠ 未识别 ${unkAll.length} 个（已高亮显示）</span>` : ' · <span style="color:#34d399">全部命中词库</span>') +
      (meta ? ` · 接近预设「${esc(meta.p.name)}」` : '');

    if ($('#btnParseImportCustom')) {
      $('#btnParseImportCustom').disabled = !unkAll.length;
    }
    if ($('#btnParseApply')) {
      $('#btnParseApply').disabled = !(totalMatched || unkAll.length);
    }
  }

  let lastParsed = null;

  function importUnknownTagsToCustomCategory(unkList) {
    if (!Array.isArray(unkList) || !unkList.length) return 0;
    ensureCustomCategoriesStructure();
    if (!state.customTagCats.length) {
      state.customTagCats.push({ id: 'cust_tag_1', name: '新增分类1', icon: '🏷', tags: [] });
    }
    const targetCat = state.customTagCats[0];
    targetCat.tags = targetCat.tags || [];
    let addedCustom = 0;
    unkList.forEach(rawEn => {
      const en = formatAnimaTagEn(rawEn);
      const k = norm(en);
      if (!en || en.length > 80 || !k) return;
      const zh = trGet(en) || zhOf(en) || zhLookup(en) || '';
      if (!targetCat.tags.some(t => norm(t.en) === k)) {
        const newObj = { en, zh, isNew: true };
        markTagObjectAsNew(newObj, en);
        targetCat.tags.push(newObj);
        addedCustom++;
      }
      if (!state.custom.some(t => norm(t.en) === k)) {
        state.custom.push({ en, zh });
      }
      idxAdd(en, zh);
    });
    if (addedCustom > 0) {
      syncFlatCustomFromTagCats();
    }
    return addedCustom;
  }

  function runParse(apply) {
    const text = $('#parseInput').value.trim();
    if (!text) { toast('请先粘贴一段提示词'); return null; }
    const opts = {
      smart: $('#parseSmart') ? $('#parseSmart').checked : true,
      fuzzy: $('#parseFuzzy') ? $('#parseFuzzy').checked : true,
      wipe: $('#parseWipe') ? $('#parseWipe').checked : true,
      addUnknown: $('#parseUnknown') ? $('#parseUnknown').checked : true,
      autoTr: $('#parseAutoTr') ? $('#parseAutoTr').checked : true
    };
    const res = analyzePrompt(text, opts);
    lastParsed = { res, opts };
    renderParsePreview(res);

    const unkAll = [...res.pos.unknown, ...res.neg.unknown];
    if (opts.autoTr && unkAll.length) {
      queueTr(unkAll);
    }

    if (apply) {
      recordHistorySnapshot('逆向识别并应用提示词');
      let importedCust = 0;
      if (opts.addUnknown && unkAll.length) {
        importedCust = importUnknownTagsToCustomCategory(unkAll);
      }
      const s = applyParsed(res, opts);
      closeModal('modalParse');
      toast(`已解析并应用 ${s.added} 个标签${s.chars ? '（含角色联动）' : ''}${importedCust ? `，已将 ${importedCust} 个未识别词导入「自定义」` : ''}`);
    } else {
      // 点击「🔍 解析」即刻将已识别词条同步至右侧工作台，保持窗口开启供查看高亮未识别词、导入自定义或直接退出
      recordHistorySnapshot('逆向识别解析提示词');
      const s = applyParsed(res, Object.assign({}, opts, { addUnknown: false }));
      toast(`🔍 解析完成：已同步 ${res.pos.matched.length + res.neg.matched.length} 个已收录词条${unkAll.length ? `，高亮 ${unkAll.length} 个未识别词（可点「导入自定义」或直接退出）` : ''}`);
    }
    return res;
  }

  /* =====================================================================
     5.7 图片解析：把图片里藏着的生成参数挖出来
         ① ComfyUI / WebUI / NovelAI 出图时会把提示词写进 PNG tEXt、JPEG EXIF
         ② 没有元数据时，交给视觉模型看图猜标签
     ===================================================================== */

  const NUL = String.fromCharCode(0);
  const NUL_RE = new RegExp(NUL + '+$');
  let imgResult = null;      // { engine, text, res }
  let imgFileObj = null;

  function bytesToText(u8) {
    try { return new TextDecoder('utf-8').decode(u8); } catch (e) { /* 老浏览器 */ }
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return s;
  }

  function utf16be(u8) {
    try { return new TextDecoder('utf-16be').decode(u8); } catch (e) { /* 兜底 */ }
    let s = '';
    for (let i = 0; i + 1 < u8.length; i += 2) s += String.fromCharCode((u8[i] << 8) | u8[i + 1]);
    return s;
  }

  function tidyText(s) {
    return String(s || '').replace(NUL_RE, '').trim();
  }

  /* ---------- PNG：tEXt / iTXt 文本块 ---------- */

  function pngRawChunks(buf) {
    const dv = new DataView(buf);
    if (buf.byteLength < 8 || dv.getUint32(0) !== 0x89504e47) return null;
    const out = [];
    let off = 8;
    while (off + 8 <= buf.byteLength) {
      const len = dv.getUint32(off);
      const type = bytesToText(new Uint8Array(buf, off + 4, 4));
      const start = off + 8;
      const end = start + len;
      if (end > buf.byteLength) break;
      if (type === 'tEXt' || type === 'iTXt') out.push({ type: type, u8: new Uint8Array(buf, start, len) });
      if (type === 'IEND') break;
      off = end + 4;
    }
    return out;
  }

  function parsePngMeta(buf) {
    const chunks = pngRawChunks(buf);
    if (!chunks || !chunks.length) return null;
    const pairs = [];
    chunks.forEach(c => {
      const u8 = c.u8;
      const z = u8.indexOf(0);
      if (z <= 0) return;
      const key = bytesToText(u8.subarray(0, z));
      if (c.type === 'tEXt') {
        pairs.push({ key: key, val: bytesToText(u8.subarray(z + 1)) });
        return;
      }
      /* iTXt：keyword NUL flag NUL method NUL lang NUL translated NUL text */
      let p = z + 1;
      if (p + 2 > u8.length) return;
      const flag = u8[p];
      p += 2;
      for (let i = 0; i < 2; i++) {
        const n = u8.indexOf(0, p);
        if (n < 0) return;
        p = n + 1;
      }
      if (flag === 1) return;      // 压缩块，极少见，跳过
      pairs.push({ key: key, val: bytesToText(u8.subarray(p)) });
    });
    return pairs.length ? pairs : null;
  }

  /* ---------- JPEG / WebP：EXIF 里的 UserComment / ImageDescription ---------- */

  function exifText(u8) {
    if (u8.length > 8) {
      const head = bytesToText(u8.subarray(0, 8));
      if (head.indexOf('UNICODE') === 0) return tidyText(utf16be(u8.subarray(8)));
      if (head.indexOf('ASCII') === 0 || head.indexOf('JIS') === 0) return tidyText(bytesToText(u8.subarray(8)));
    }
    return tidyText(bytesToText(u8));
  }

  function readTiff(buf, base) {
    if (base + 8 > buf.byteLength) return null;
    const dv = new DataView(buf);
    const bo = bytesToText(new Uint8Array(buf, base, 2));
    const le = bo === 'II';
    const u16 = o => dv.getUint16(o, le);
    const u32 = o => dv.getUint32(o, le);
    if (u16(base) !== 0x002a) return null;
    const ifd = base + u32(base + 4);
    if (ifd + 2 > buf.byteLength) return null;
    const n = u16(ifd);
    const cells = {};
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > buf.byteLength) break;
      const tag = u16(e);
      const type = u16(e + 2);
      const cnt = u32(e + 4);
      if (tag !== 0x9286 && tag !== 0x010e) continue;
      const size = (type === 2 || type === 7) ? cnt : 0;
      if (!size) continue;
      const p = size <= 4 ? e + 8 : base + u32(e + 8);
      if (p + size > buf.byteLength) continue;
      cells[tag] = exifText(new Uint8Array(buf, p, size));
    }
    const text = cells[0x9286] || cells[0x010e] || '';
    return text ? { engine: 'EXIF', text: text } : null;
  }

  function readJpegExif(buf) {
    const dv = new DataView(buf);
    if (dv.getUint16(0) !== 0xffd8) return null;
    let off = 2;
    while (off + 4 <= buf.byteLength) {
      if (dv.getUint8(off) !== 0xff) { off++; continue; }
      const marker = dv.getUint8(off + 1);
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
      if (marker === 0xda) break;
      const len = dv.getUint16(off + 2);
      if (marker === 0xe1 && off + 8 < buf.byteLength) {
        const head = bytesToText(new Uint8Array(buf, off + 4, 4));
        if (head === 'Exif') {
          const r = readTiff(buf, off + 10);
          if (r) return r;
        }
      }
      off += 2 + len;
    }
    return null;
  }

  function readWebpExif(buf) {
    if (bytesToText(new Uint8Array(buf, 0, 4)) !== 'RIFF') return null;
    const dv = new DataView(buf);
    let off = 12;
    while (off + 8 <= buf.byteLength) {
      const four = bytesToText(new Uint8Array(buf, off, 4));
      const size = dv.getUint32(off + 4, true);
      if (four === 'EXIF') {
        let p = off + 8;
        if (p + 6 <= buf.byteLength && bytesToText(new Uint8Array(buf, p, 4)) === 'Exif') p += 6;
        return readTiff(buf, p);
      }
      off += 8 + size + (size % 2);
    }
    return null;
  }

  /* ---------- 把元数据翻译成提示词 ---------- */

  /* ComfyUI 的 prompt 是 API 格式 JSON：顺着 KSampler 的 positive/negative 连线找文本。
     连线可能穿过一串「透明」节点（PreviewAny / PrimitiveNode / Reroute…），所以逐层往下走。 */
  const SIDE_KEYS = ['text', 'prompt', 'value', 'string', 'on_false', 'on_true', 'source',
    'conditioning', 'positive', 'negative', 'text_g', 'text_l', 'text_positive', 'text_negative'];

  function sideText(json, v, which, depth) {
    if (depth > 12 || v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (!Array.isArray(v) || !v.length) return '';
    const node = json[String(v[0])];
    if (!node) return '';
    const inp = node.inputs || {};

    /* 同一个节点同时给出正负两路文本（TextEncodeQwenImage21 这一类） */
    if (inp.prompt !== undefined || inp.negative_prompt !== undefined) {
      let own;
      if (which === 'negative') own = inp.negative_prompt !== undefined ? inp.negative_prompt : inp.prompt;
      else own = inp.prompt !== undefined ? inp.prompt : inp.negative_prompt;
      return sideText(json, own, which, depth + 1);
    }

    for (let i = 0; i < SIDE_KEYS.length; i++) {
      const k = SIDE_KEYS[i];
      if (inp[k] === undefined) continue;
      /* positive / negative 这个键只在对应侧用，避免读到对面的文本 */
      if (k === 'positive' && which === 'negative') continue;
      if (k === 'negative' && which !== 'negative') continue;
      const one = sideText(json, inp[k], which, depth + 1);
      if (tidyText(one)) return one;
    }
    return '';
  }

  function comfyFromJson(str) {
    let j;
    try { j = JSON.parse(str); } catch (e) { return null; }
    if (!j || typeof j !== 'object') return null;
    let sampler = null;
    Object.keys(j).forEach(k => {
      const n = j[k] || {};
      if (sampler) return;
      if (/sampler/i.test(String(n.class_type || '')) && n.inputs) sampler = n;
    });
    let pos = '';
    let neg = '';
    if (sampler) {
      pos = sideText(j, sampler.inputs.positive, 'positive', 0) || '';
      neg = sideText(j, sampler.inputs.negative, 'negative', 0) || '';
    }
    if (!tidyText(pos)) {
      /* 连线太绕（开关节点、文本生成节点）时退一步：把所有像提示词的字符串捞出来，长的当正向 */
      const seen = {};
      const texts = [];
      Object.keys(j).forEach(k => {
        const n = j[k] || {};
        const inp = n.inputs || {};
        Object.keys(inp).forEach(kk => {
          const v = inp[kk];
          if (typeof v !== 'string' || v.length < 6) return;
          if (/(^|_)(name|prefix|image|images|format|scheduler|system_prompt|type|device)$/i.test(kk)) return;
          if (/\.(safetensors|ckpt|png|jpe?g|webp|pt|bin)$/i.test(v)) return;
          if (seen[v]) return;
          seen[v] = 1;
          texts.push(v);
        });
      });
      texts.sort((a, b) => b.length - a.length);
      if (texts.length) {
        pos = texts[0];
        /* 剩下那些里只认明显是负面词的，别把别的字符串当负面 */
        neg = texts.slice(1).find(t => /lowres|worst quality|bad anatomy|bad hands|watermark|nsfw|blurry/i.test(t)) || '';
      }
    }
    if (!tidyText(pos)) return null;
    return {
      engine: 'ComfyUI 元数据',
      text: pos + (tidyText(neg) ? '\nNegative prompt: ' + neg : '')
    };
  }

  function comfyWorkflowPrompts(str) {
    let j;
    try { j = JSON.parse(str); } catch (e) { return null; }
    if (!j || !Array.isArray(j.nodes)) return null;
    const posArr = [];
    const negArr = [];
    j.nodes.forEach(n => {
      const type = String((n && n.type) || '');
      const title = String((n && n.title) || '').toLowerCase();
      const w = (n && Array.isArray(n.widgets_values)) ? n.widgets_values : [];
      if (/CLIPTextEncode|TextEncode|Prompt/i.test(type) && w.length) {
        const txt = tidyText(String(w[0] || ''));
        if (!txt) return;
        if (/neg|负面|负向|反向/i.test(title) || /lowres|worst quality|bad anatomy|bad hands|watermark/i.test(txt)) {
          negArr.push(txt);
        } else {
          posArr.push(txt);
        }
      }
    });
    if (!posArr.length && !negArr.length) return null;
    const pos = posArr.join(', ');
    const neg = negArr.join(', ');
    return {
      engine: 'ComfyUI 工作流',
      pos,
      neg,
      text: pos + (neg ? '\nNegative prompt: ' + neg : '')
    };
  }

  function metaFromPairs(pairs) {
    const map = {};
    pairs.forEach(p => { map[String(p.key || '').toLowerCase()] = String(p.val || ''); });

    let rawJsonObj = null;
    if (map['prompt'] && map['prompt'].trim().startsWith('{')) {
      try { rawJsonObj = JSON.parse(map['prompt']); } catch (e) {}
    } else if (map['workflow'] && map['workflow'].trim().startsWith('{')) {
      try { rawJsonObj = JSON.parse(map['workflow']); } catch (e) {}
    } else if (map['comment'] && map['comment'].trim().startsWith('{')) {
      try { rawJsonObj = JSON.parse(map['comment']); } catch (e) {}
    }

    const comfy = map['prompt'];
    if (comfy && comfy.charAt(0) === '{') {
      const r = comfyFromJson(comfy);
      if (r) {
        r.rawJson = rawJsonObj ? JSON.stringify(rawJsonObj, null, 2) : comfy;
        return r;
      }
    }

    if (map['workflow'] && map['workflow'].charAt(0) === '{') {
      const rw = comfyWorkflowPrompts(map['workflow']);
      if (rw) {
        rw.rawJson = rawJsonObj ? JSON.stringify(rawJsonObj, null, 2) : map['workflow'];
        return rw;
      }
    }

    const comment = map['comment'];
    if (comment && comment.charAt(0) === '{') {
      try {
        const j = JSON.parse(comment);
        if (j && j.prompt) {
          return {
            engine: 'NovelAI 元数据',
            pos: String(j.prompt || ''),
            neg: String(j.negative_prompt || j.uc || ''),
            rawJson: JSON.stringify(j, null, 2),
            text: j.prompt + (j.negative_prompt ? '\nNegative prompt: ' + j.negative_prompt : '')
          };
        }
      } catch (e) { /* 不是 JSON 就继续往下 */ }
    }

    const params = map['parameters'] || map['sd-metadata'];
    if (params && tidyText(params)) {
      return {
        engine: 'WebUI 元数据',
        text: params,
        rawJson: rawJsonObj ? JSON.stringify(rawJsonObj, null, 2) : JSON.stringify({ parameters: params }, null, 2)
      };
    }

    if (rawJsonObj) {
      return {
        engine: 'ComfyUI JSON',
        text: '',
        rawJson: JSON.stringify(rawJsonObj, null, 2)
      };
    }

    return null;
  }

  function readImageMeta(buf) {
    if (buf.byteLength < 12) return null;
    const dv = new DataView(buf);
    if (dv.getUint32(0) === 0x89504e47) {
      const pairs = parsePngMeta(buf);
      return pairs ? metaFromPairs(pairs) : null;
    }
    if (dv.getUint16(0) === 0xffd8) return readJpegExif(buf);
    if (bytesToText(new Uint8Array(buf, 0, 4)) === 'RIFF') return readWebpExif(buf);
    return null;
  }

  /* ---------- 底模 / LoRA / 采样参数 ----------
     ① WebUI（A1111 / Forge / Fooocus）把参数写在末尾那行 "Steps: …, Model: …"
     ② ComfyUI 的 API JSON 走 CheckpointLoader / LoraLoader 节点
     ③ ComfyUI 的 UI workflow JSON 走 nodes[].widgets_values
     ④ NovelAI 走 Comment JSON 里的 model 字段
     全都有则合并：同一个底模只留一条，LoRA 按名字去重并按权重排序。 */

  const LORA_TAG_RE = /<(lora|lyco|loha|hypernet):([^:>]+?)(?::([-\d.]+))?(?::([-\d.]+))?>/gi;

  const MODEL_FAMILIES = [
    [/pony|pny| autismmix/i, 'Pony 系（SDXL，需要 score_9 那套正面词）'],
    [/illustrious|noobai|noob-?ai|\bwai[-\s_]|ani-?illustrious/i, 'Illustrious / NoobAI 系（SDXL 动漫，纯标签式）'],
    [/animagine|anything|abyssorange|meina|counterfeit|aam|dapano|andromeda|dreamshaper|anime ?(?:style|mix)|cuteyukimix|nailong/i, 'SD1.5 动漫模型'],
    [/realistic|photo|chilloutmix|majicmix|epicrealism|juggernaut|cyberrealistic|ultrareal|chillmix|mixin|perfectdeliberate|realvis|leosam|dreamshaperxl|wildcardx|haders ?xl/i, '写实系底模'],
    [/flux/i, 'FLUX'],
    [/sd3|sd_?3|stable.?diffusion.?3/i, 'SD3 / SD3.5'],
    [/sdxl|xl[_-]?1\.0|pony|illustrious|noob/i, 'SDXL'],
    [/nai|novelai|diffusion-?3|diffusion-?4/i, 'NovelAI 官方模型'],
    [/v1-?5|sd-?1\.?5|sd15|1\.5/i, 'SD1.5 官方底模'],
    [/v2-?1|sd-?2\.?1|768-v/i, 'SD2.1 官方底模']
  ];

  function trimExt(s) {
    return String(s || '').replace(/^[\s"']+|[\s"']+$/g, '').replace(/\.(safetensors|ckpt|pt|pth|bin|gguf|onnx)$/i, '');
  }

  function modelFamily(name) {
    const s = String(name || '');
    for (let i = 0; i < MODEL_FAMILIES.length; i++) {
      if (MODEL_FAMILIES[i][0].test(s)) return MODEL_FAMILIES[i][1];
    }
    return '';
  }

  function newGenInfo() {
    return { base: [], loras: [], vae: '', hash: '', hashes: [], settings: [], engine: '', note: '' };
  }

  function pushBase(info, name, tag, guessed) {
    const n = trimExt(name);
    if (!n) return;
    if (info.base.some(b => b.name.toLowerCase() === n.toLowerCase())) return;
    info.base.push({ name: n, tag: tag || '', guessed: !!guessed });
  }

  function pushLora(info, name, weight, hash, guessed) {
    const n = trimExt(name);
    if (!n) return;
    const hit = info.loras.find(l => l.name.toLowerCase() === n.toLowerCase());
    if (hit) {
      if (weight !== undefined && weight !== null && weight !== '') hit.weight = weight;
      if (hash) hit.hash = hash;
      return;
    }
    info.loras.push({ name: n, weight: weight === 0 || weight ? String(weight) : '', hash: hash || '', guessed: !!guessed });
  }

  function pushSetting(info, k, v) {
    if (v === undefined || v === null || v === '') return;
    const s = String(v).trim();
    if (!s) return;
    if (info.settings.some(x => x.k === k)) {
      info.settings = info.settings.map(x => (x.k === k ? { k: k, v: s } : x));
      return;
    }
    info.settings.push({ k: k, v: s });
  }

  function safeJson(str) {
    try { return JSON.parse(str); } catch (e) { return null; }
  }

  /* A1111 的参数行：Key: value, Key: "value, with comma", … */
  function splitParams(line) {
    const out = {};
    const s = String(line || '');
    let i = 0;
    while (i < s.length) {
      const j = s.indexOf(':', i);
      if (j < 0) break;
      const key = s.slice(i, j).replace(/^[,\s]+/, '').trim();
      i = j + 1;
      while (s[i] === ' ') i++;
      let val = '';
      if (s[i] === '"') {
        i++;
        while (i < s.length && s[i] !== '"') { val += s[i]; i++; }
        i++;
        while (s[i] === ' ') i++;
        if (s[i] === ',') i++;
      } else {
        let k = s.indexOf(',', i);
        if (k < 0) k = s.length;
        val = s.slice(i, k).trim();
        i = k + 1;
      }
      if (key) out[key.toLowerCase()] = val;
    }
    return out;
  }

  function findParamLine(text) {
    const lines = String(text || '').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (/(^|,\s*)(steps|sampler|cfg scale|model|seed|size)\s*:/i.test(l)) return l;
    }
    return '';
  }

  function collectLoraTags(text, info) {
    let m;
    LORA_TAG_RE.lastIndex = 0;
    while ((m = LORA_TAG_RE.exec(String(text || ''))) !== null) {
      const w = m[4] !== undefined ? m[4] : m[3];
      pushLora(info, m[2], w);
    }
  }

  function parseWebuiText(text, info) {
    collectLoraTags(text, info);
    const p = splitParams(findParamLine(text));
    if (!Object.keys(p).length) return false;
    if (p['model'] || p['modelname']) pushBase(info, p['model'] || p['modelname']);
    if (p['model hash'] || p['modelhash']) {
      info.hash = p['model hash'] || p['modelhash'];
      info.hashes.push({ name: p['model'] || '', hash: info.hash });
    }
    if (p['vae']) info.vae = trimExt(p['vae']);
    pushSetting(info, '采样器', p['sampler']);
    pushSetting(info, '调度器', p['schedule type'] || p['scheduler']);
    pushSetting(info, '步数', p['steps']);
    pushSetting(info, 'CFG', p['cfg scale']);
    pushSetting(info, '种子', p['seed']);
    pushSetting(info, '尺寸', p['size']);
    pushSetting(info, 'Clip skip', p['clip skip']);
    pushSetting(info, '降噪', p['denoising strength']);
    pushSetting(info, '版本', p['version']);
    if (p['lora hashes']) {
      String(p['lora hashes']).split(/,\s*/).forEach(pair => {
        const k = pair.lastIndexOf(':');
        if (k < 0) return;
        const nm = pair.slice(0, k).trim();
        const hs = pair.slice(k + 1).trim();
        if (nm) pushLora(info, nm, '', hs);
      });
    }
    info.engine = info.engine || 'WebUI 元数据';
    return true;
  }

  /* ComfyUI：API 格式 JSON（prompt chunk） */
  function parseComfyApi(j, info) {
    const nodes = j && typeof j === 'object' ? j : {};
    Object.keys(nodes).forEach(k => {
      const n = nodes[k] || {};
      const type = String(n.class_type || '');
      const inp = n.inputs || {};
      const pick = (arr) => {
        for (let i = 0; i < arr.length; i++) {
          const v = inp[arr[i]];
          if (typeof v === 'string' && v) return v;
        }
        return '';
      };
      if (/checkpoint|unet|diffusion.?model|gguf|checkpointloader/i.test(type)) {
        pushBase(info, pick(['ckpt_name', 'unet_name', 'model_name', 'ckpt']));
      }
      if (/lora/i.test(type)) {
        pushLora(info, pick(['lora_name', 'lora', 'name']), inp.strength_model !== undefined ? inp.strength_model : inp.strength);
      }
      if (/vae/i.test(type) && !/lora/i.test(type)) {
        const v = pick(['vae_name', 'vae']);
        if (v && !info.vae) info.vae = trimExt(v);
      }
      if (/sampler/i.test(type)) {
        pushSetting(info, '采样器', pick(['sampler_name']));
        pushSetting(info, '调度器', pick(['scheduler']));
        pushSetting(info, '步数', inp.steps);
        pushSetting(info, 'CFG', inp.cfg);
        pushSetting(info, '种子', inp.seed !== undefined ? inp.seed : inp.noise_seed);
        if (inp.width && inp.height) pushSetting(info, '尺寸', inp.width + 'x' + inp.height);
        if (inp.denoise !== undefined) pushSetting(info, '降噪', inp.denoise);
      }
      if (/cliptextencode|lora|text/i.test(type)) return;
    });
    if (info.base.length || info.loras.length) info.engine = info.engine || 'ComfyUI 元数据';
    return info.base.length || info.loras.length;
  }

  /* ComfyUI：UI 格式 workflow JSON（workflow chunk） */
  function parseComfyUi(j, info) {
    const nodes = (j && j.nodes) || [];
    nodes.forEach(n => {
      const type = String(n.type || '');
      const w = n.widgets_values;
      if (!Array.isArray(w)) return;
      if (/CheckpointLoader|UNETLoader|UnetLoader|DiffusionModelLoader|GGUF/i.test(type)) {
        pushBase(info, w[0]);
      }
      if (/^LoraLoader/i.test(type)) {
        pushLora(info, w[0], w[1]);
      }
      if (/VAELoader/i.test(type)) {
        if (w[0] && !info.vae) info.vae = trimExt(w[0]);
      }
      if (/KSampler|SamplerCustom/i.test(type)) {
        pushSetting(info, '步数', w[2]);
        pushSetting(info, 'CFG', w[3]);
        pushSetting(info, '采样器', w[4]);
        pushSetting(info, '调度器', w[5]);
        pushSetting(info, '种子', w[0]);
      }
    });
    if (info.base.length || info.loras.length) info.engine = info.engine || 'ComfyUI 工作流';
    return info.base.length || info.loras.length;
  }

  /* NovelAI：Comment JSON */
  function parseNaiMeta(j, info) {
    if (!j || typeof j !== 'object') return false;
    if (j.model) {
      const m = String(j.model);
      const nice = /nai-diffusion-3/.test(m) ? 'NovelAI Diffusion V3'
        : /nai-diffusion-4/.test(m) ? 'NovelAI Diffusion V4'
          : /nai-diffusion-furry/.test(m) ? 'NovelAI Diffusion Furry'
            : /nai-diffusion/.test(m) ? 'NovelAI Diffusion V2'
              : m;
      info.base.push({ name: nice, tag: 'NovelAI 官方模型', guessed: false, raw: m });
    }
    pushSetting(info, '采样器', j.sampler);
    pushSetting(info, '调度器', j.noise_schedule);
    pushSetting(info, '步数', j.steps);
    pushSetting(info, 'CFG', j.scale);
    pushSetting(info, '种子', j.seed);
    pushSetting(info, '尺寸', j.width && j.height ? j.width + 'x' + j.height : '');
    if (j.uc !== undefined) pushSetting(info, 'uc', '有');
    info.engine = info.engine || 'NovelAI 元数据';
    return !!j.model;
  }

  /* InvokeAI：sd-metadata */
  function parseInvokeMeta(j, info) {
    if (!j || typeof j !== 'object') return false;
    const img = j.image || {};
    const w = img.model_weights || j.model_weights || '';
    if (w) pushBase(info, w);
    const mh = img.model_hash || j.model_hash;
    if (mh) { info.hash = mh; info.hashes.push({ name: w, hash: mh }); }
    pushSetting(info, '步数', img.steps);
    pushSetting(info, 'CFG', img.cfg_scale);
    pushSetting(info, '采样器', img.scheduler);
    pushSetting(info, '种子', img.seed);
    info.engine = info.engine || 'InvokeAI 元数据';
    return !!(w || mh);
  }

  function imageGenInfo(buf) {
    const info = newGenInfo();
    const dv = new DataView(buf);
    try {
      if (buf.byteLength >= 8 && dv.getUint32(0) === 0x89504e47) {
        const pairs = parsePngMeta(buf) || [];
        const map = {};
        pairs.forEach(p => { map[String(p.key || '').toLowerCase()] = String(p.val || ''); });
        if (map['parameters']) parseWebuiText(map['parameters'], info);
        if (map['sd-metadata']) {
          const j = safeJson(map['sd-metadata']);
          if (j) parseInvokeMeta(j, info);
        }
        if (map['prompt'] && map['prompt'].charAt(0) === '{') {
          const j = safeJson(map['prompt']);
          if (j) parseComfyApi(j, info);
        }
        if (map['workflow'] && map['workflow'].charAt(0) === '{') {
          const j = safeJson(map['workflow']);
          if (j) parseComfyUi(j, info);
        }
        if (map['comment']) {
          const j = safeJson(map['comment']);
          if (j) parseNaiMeta(j, info);
        }
        if (map['software'] && !info.engine) info.note = trimExt(map['software']);
      } else {
        const ex = (function () {
          try { return readImageMeta(buf); } catch (e) { return null; }
        })();
        if (ex && ex.text) parseWebuiText(ex.text, info);
        if (ex && ex.engine && !info.engine) info.engine = ex.engine;
      }
    } catch (e) { /* 元数据千奇百怪，读崩了就当没有 */ }
    /* 底模未知时用 hash 兜一下 */
    return info;
  }

  /* Civitai 查证链接：有 hash 走 by-hash（AutoV2 前 10 位），否则按名字搜 */
  function civitaiHashUrl(hash) {
    return 'https://civitai.com/api/v1/model-versions/by-hash/' + encodeURIComponent(String(hash).trim());
  }
  function civitaiSearchUrl(name) {
    return 'https://civitai.com/search/models?query=' + encodeURIComponent(String(name).trim());
  }

  function genInfoText(info) {
    const lines = [];
    lines.push('底模：' + (info.base.length ? info.base.map(b => b.name).join(' / ') : '未识别'));
    if (info.hash) lines.push('底模 Hash：' + info.hash);
    lines.push('LoRA：' + (info.loras.length
      ? info.loras.map(l => l.name + (l.weight ? '(' + l.weight + ')' : '')).join(' / ')
      : '无'));
    if (info.vae) lines.push('VAE：' + info.vae);
    if (info.settings.length) lines.push(info.settings.map(s => s.k + ' ' + s.v).join(' · '));
    return lines.join('\n');
  }

  function renderGenInfo(info) {
    const box = $('#imgModelBox');
    if (!box) return;
    box.hidden = false;
    const has = info && (info.base.length || info.loras.length || info.vae || info.hash || info.settings.length);
    if (!has) {
      if ($('#imgBaseModel')) $('#imgBaseModel').innerHTML = '<span class="im-none">未识别</span>';
      if ($('#imgSampler')) $('#imgSampler').innerHTML = '<span class="im-none">—</span>';
      if ($('#imgModelFrom')) $('#imgModelFrom').textContent = '';
      return;
    }
    $('#imgModelFrom').textContent = info.engine || (info.note ? '文件信息：' + info.note : '');

    /* 底模 */
    const baseEl = $('#imgBaseModel');
    if (info.base.length) {
      baseEl.innerHTML = info.base.map(b => {
        const fam = b.tag || modelFamily(b.name);
        return '<span class="im-tag base">' + esc(b.name) + (b.guessed ? '<em>推测</em>' : '') + '</span>' +
          (fam ? '<span class="im-tag">' + esc(fam) + '</span>' : '');
      }).join(' ') + (info.hash
        ? ' <a class="im-link" data-civitai-hash="' + esc(info.hash) + '">用 hash 查 Civitai</a>'
        : ' <a class="im-link" data-civitai-name="' + esc(info.base[0].name) + '">按名字搜 Civitai</a>');
    } else if (info.hash) {
      baseEl.innerHTML = '<span class="im-none">只有 hash：</span><code>' + esc(info.hash) + '</code> ' +
        '<a class="im-link" data-civitai-hash="' + esc(info.hash) + '">查 Civitai</a>';
    } else {
      baseEl.innerHTML = '<span class="im-none">未识别（图里没写底模，或写在不支持的字段里）</span>';
    }

    /* LoRA */
    const loraEl = $('#imgLoraList');
    if (info.loras.length) {
      loraEl.innerHTML = info.loras.map(l =>
        '<span class="im-tag" title="点右边的放大镜去 Civitai 找同款">' + esc(l.name) +
        (l.weight ? '<em>×' + esc(l.weight) + '</em>' : '') +
        '</span><a class="im-link" data-civitai-name="' + esc(l.name) + '">🔍</a> '
      ).join('');
    } else {
      loraEl.innerHTML = '<span class="im-none">没发现 LoRA 标签（&lt;lora:名字:权重&gt;）</span>';
    }

    /* VAE */
    $('#imgVae').innerHTML = info.vae ? '<code>' + esc(info.vae) + '</code>' : '<span class="im-none">—</span>';

    /* 采样参数 */
    $('#imgSampler').innerHTML = info.settings.length
      ? info.settings.map(s => '<span class="im-tag">' + esc(s.k) + ' <em>' + esc(s.v) + '</em></span>').join(' ')
      : '<span class="im-none">—</span>';

    /* 查证入口 */
    const lu = [];
    if (info.hash) lu.push('<a class="im-link" data-civitai-hash="' + esc(info.hash) + '">底模 hash 反查</a>');
    info.base.forEach(b => { if (b.raw) return; lu.push('<a class="im-link" data-civitai-name="' + esc(b.name) + '">搜底模</a>'); });
    info.loras.slice(0, 6).forEach(l => lu.push('<a class="im-link" data-civitai-name="' + esc(l.name) + '">搜 ' + esc(l.name) + '</a>'));
    $('#imgLookup').innerHTML = lu.length ? lu.join(' · ') : '<span class="im-none">没有可用于查证的字段</span>';

    const copyBtn = $('#btnImgCopyModel');
    if (copyBtn) copyBtn.disabled = false;
  }

  /* ---------- 视觉模型兜底 ---------- */

  const VISION_SYS = [
    '你是动漫/游戏插图的反向工程器：既要还原提示词，也要判断这张图大概是哪类底模和 LoRA 画出来的。',
    '输出严格 JSON：{"positive":["..."],"negative":["..."],"texts":["..."],"base_model":"底模名或空",',
    '"model_family":"SD1.5动漫 / SDXL动漫 / Illustrious / NoobAI / Pony / 写实SDXL / FLUX / NovelAI / 未知",',
    '"loras":["可能用到的 LoRA 或画风关键词"],"reply":"一句中文说明"}',
    'positive 8~16 条，按 人数/角色/头发/眼睛/表情/服装/姿势/镜头/场景/光影 覆盖；',
    'texts 放 0~3 条自然英文短句，补足标签说不清的细节（例如双手比耶的具体样子）；',
    'base_model 只在画风特征非常典型时才写具体名字，拿不准就留空；',
    'loras 最多 3 条，例如 "角色 LoRA: 某个角色的立绘"、"画风 LoRA: 厚涂/赛璐璐"；',
    '不要输出权重、不要括号、不要中文标签。'
  ];

  function axiosJson(text) {
    let s = String(text || '').trim();
    const fence = s.indexOf('```');
    if (fence >= 0) {
      s = s.slice(fence + 3);
      if (s.charAt(0) === 'j' || s.charAt(0) === 'J') s = s.slice(4);
      const end = s.indexOf('```');
      if (end >= 0) s = s.slice(0, end);
    }
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a < 0 || b < a) return null;
    try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
  }

  function downscaleImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const max = 1024;
        let w = img.naturalWidth || img.width;
        let h = img.naturalHeight || img.height;
        const scale = Math.min(1, max / Math.max(w, h));
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
        const cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        const ctx = cv.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        try { resolve(cv.toDataURL('image/jpeg', 0.86)); }
        catch (e) { reject(new Error('这张图读不出来（可能不是图片文件）')); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('这张图打不开（格式不支持或已损坏）')); };
      img.src = url;
    });
  }

  async function visionInterrogate(dataUrl) {
    if (!aiCfg.key) {
      throw new Error('这张图里没有生成参数。要看图反推，得先在「AI 选词」里填 API Key 和视觉模型（例如 gpt-4o-mini）。');
    }
    const base = aiBaseUrl();
    const resp = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + aiCfg.key },
      body: JSON.stringify({
        model: aiCfg.model || 'deepseek-chat',
        messages: [
          { role: 'system', content: VISION_SYS },
          { role: 'user', content: [
            { type: 'text', text: '反推这张图用了什么提示词。' },
            { type: 'image_url', image_url: { url: dataUrl } }
          ] }
        ],
        temperature: 0.3,
        max_tokens: 900
      })
    });
    const raw = await resp.text();
    if (!resp.ok) {
      let detail = raw;
      try { detail = JSON.parse(raw).error.message || raw; } catch (e) { /* 原样 */ }
      const m = String(detail).slice(0, 200);
      if (/image|vision|multimodal|does not support/i.test(m)) {
        throw new Error('当前模型不支持看图：' + m + '\n换一个视觉模型（gpt-4o-mini / qwen-vl-max 之类）再试。');
      }
      throw new Error('视觉模型返回 HTTP ' + resp.status + '：' + m);
    }
    let content = '';
    try { content = JSON.parse(raw).choices[0].message.content || ''; } catch (e) { /* 忽略 */ }
    const j = axiosJson(content);
    if (!j) throw new Error('视觉模型没有返回可解析的 JSON，再试一次或换个模型。');
    const pos = (j.positive || j.tags || []).map(String).filter(Boolean);
    const neg = (j.negative || []).map(String).filter(Boolean);
    const texts = (j.texts || []).map(String).filter(Boolean);
    if (!pos.length && !texts.length) throw new Error('视觉模型没认出内容，换张清楚的图试试。');
    const lines = pos.slice();
    if (texts.length) lines.push(texts.join(', '));
    return {
      engine: '视觉模型（' + (aiCfg.model || 'deepseek-chat') + '）',
      text: lines.join(', ') + (neg.length ? '\nNegative prompt: ' + neg.join(', ') : ''),
      base: String(j.base_model || '').trim(),
      family: String(j.model_family || '').trim(),
      loras: (j.loras || []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 3)
    };
  }

  /* ---------- 主流程 ---------- */

  function renderImgResult(res, engine, text, rawJsonStr, rawPos, rawNeg) {
    const n = res.pos.matched.length;
    const nn = res.neg.matched.length;
    const un = res.pos.unknown.length + res.neg.unknown.length;
    const sec = splitPromptSections(text || '');
    const posStr = tidyText(rawPos !== undefined && rawPos !== '' ? rawPos : (sec.pos || ''));
    const negStr = tidyText(rawNeg !== undefined && rawNeg !== '' ? rawNeg : (sec.neg || ''));

    if ($('#imgPosText')) $('#imgPosText').value = posStr;
    if ($('#imgNegText')) $('#imgNegText').value = negStr;
    if ($('#imgJsonRaw')) {
      $('#imgJsonRaw').textContent = rawJsonStr || JSON.stringify({
        engine: engine || 'Image Metadata',
        positive_prompt: posStr,
        negative_prompt: negStr
      }, null, 2);
    }
    if ($('#imgJsonBox')) {
      $('#imgJsonBox').open = false; // (Req 7) JSON 数据默认不展开
    }
    $('#imgRaw').textContent = text || '';
    $('#btnImgApply').disabled = !(n || nn || un || posStr || negStr);
  }

  function resetImg() {
    imgResult = null;
    imgFileObj = null;
    $('#imgStatus').textContent = '等待拖入或选择图片…';
    if ($('#imgBaseModel')) $('#imgBaseModel').innerHTML = '<span class="im-none">未识别</span>';
    if ($('#imgSampler')) $('#imgSampler').innerHTML = '<span class="im-none">—</span>';
    if ($('#imgModelFrom')) $('#imgModelFrom').textContent = '';
    if ($('#imgPosText')) $('#imgPosText').value = '';
    if ($('#imgNegText')) $('#imgNegText').value = '';
    if ($('#imgJsonRaw')) $('#imgJsonRaw').textContent = '暂无 JSON 数据';
    if ($('#imgJsonBox')) $('#imgJsonBox').open = false;
    $('#imgPreview').hidden = true;
    $('#imgPreview').removeAttribute('src');
    if ($('#imgDrop')) $('#imgDrop').classList.remove('has-img');
    $('#btnImgApply').disabled = true;
    const cb = $('#btnImgCopyModel');
    if (cb) cb.disabled = true;
  }

  async function handleImage(file) {
    if (!file) return;
    if (!/^image\//.test(file.type || '') && !/\.(png|jpe?g|webp|bmp|gif)$/i.test(file.name || '')) {
      $('#imgStatus').textContent = '这不是有效的图片文件。';
      return;
    }
    imgFileObj = file;
    imgResult = null;
    $('#btnImgApply').disabled = true;
    $('#imgPreview').src = URL.createObjectURL(file);
    $('#imgPreview').hidden = false;
    if ($('#imgDrop')) $('#imgDrop').classList.add('has-img');
    $('#imgStatus').textContent = '正在检测 ' + (file.name || '图片') + ' 的 ComfyUI 标签与生成信息…';

    try {
      const buf = await file.arrayBuffer();
      let meta = null;
      try { meta = readImageMeta(buf); } catch (e) { meta = null; }
      let info = null;
      try { info = imageGenInfo(buf); } catch (e) { info = null; }
      if (!info) info = newGenInfo();

      // 提取原始 ComfyUI JSON（prompt 或 workflow）
      let rawJsonStr = (meta && meta.rawJson) || '';
      if (!rawJsonStr && buf.byteLength >= 8 && new DataView(buf).getUint32(0) === 0x89504e47) {
        const pairs = parsePngMeta(buf) || [];
        const pMap = {};
        pairs.forEach(p => { pMap[String(p.key || '').toLowerCase()] = String(p.val || ''); });
        const rawCandidate = pMap['prompt'] || pMap['workflow'] || pMap['comment'] || pMap['sd-metadata'] || '';
        if (rawCandidate) {
          try { rawJsonStr = JSON.stringify(JSON.parse(rawCandidate), null, 2); }
          catch (e) { rawJsonStr = rawCandidate; }
        }
      }

      let engine = '';
      let text = '';
      if (meta && (tidyText(meta.text) || rawJsonStr)) {
        engine = meta.engine || 'ComfyUI 元数据';
        text = meta.text || '';
        $('#imgStatus').textContent = '✅ 已自动检测出 ' + engine + '（左侧预览图片，右侧查看底模/采样/正负向提示词与 JSON）';
      } else {
        $('#imgStatus').textContent = '未在图片内检测到内嵌 ComfyUI / WebUI 元数据';
        renderGenInfo(info);
        renderImgResult({ pos: { matched: [], unknown: [] }, neg: { matched: [], unknown: [] } }, '无内嵌元数据', '', '', '', '');
        return;
      }

      const res = analyzePrompt(text, { smart: true, fuzzy: true });
      imgResult = { engine: engine, text: text, res: res, info: info, rawJson: rawJsonStr };
      renderGenInfo(info);
      if ($('#imgModelBox')) $('#imgModelBox').hidden = false;
      renderImgResult(res, engine, text, rawJsonStr, meta.pos, meta.neg);
    } catch (err) {
      $('#imgStatus').textContent = String((err && err.message) || err);
    }
  }

  function applyImg() {
    if (!imgResult) return;
    const s = applyParsed(imgResult.res, {
      wipe: $('#imgWipe').checked,
      addUnknown: $('#imgApplyUnknown').checked
    });
    closeModal('modalImg');
    toast('已还原 ' + s.added + ' 个标签' + (s.chars ? '，含角色联动' : '') +
      (s.custom ? '，新收录 ' + s.custom + ' 个词' : ''));
  }

  /* 测试钩子：无浏览器时直接调这些函数 */
  try {
    if (typeof window !== 'undefined') {
      window.__PG_IMG__ = {
        readImageMeta: readImageMeta, comfyFromJson: comfyFromJson,
        handleImage: handleImage, applyImg: applyImg, resetImg: resetImg,
        imageGenInfo: imageGenInfo, genInfoText: genInfoText, renderGenInfo: renderGenInfo,
        modelFamily: modelFamily
      };
    }
  } catch (e) { /* ignore */ }

  /* =====================================================================
     5.8 AI 选词：默认浏览器直连模型接口（无需本地服务）
         接口填成 http://127.0.0.1:8787 这类本机地址时，改走 server.mjs
     ===================================================================== */

  const AI_CFG_KEY = 'pg_ai_cfg_v2';
  const AI_CFG_KEY_OLD = 'pg_ai_cfg_v1';
  const AI_DEFAULT_BASE = 'https://api.deepseek.com';
  const aiCfg = { base: '', model: 'deepseek-chat', visionModel: '', key: '', online: true };
  let aiMsgs = [];        // 对话历史 {role, content}
  let aiLast = null;      // 最近一次选词结果 {positive:[{en,zh}], negative:[...]}
  let aiBusy = false;

  function loadAiCfg() {
    try {
      let d = JSON.parse(localStorage.getItem(AI_CFG_KEY) || 'null');
      if (!d) {
        /* 老版本默认把接口指到本地服务，直接搬过来会让新用户一上来就 Failed to fetch，
           所以只保留模型名和 Key，接口地址重新决定 */
        const old = JSON.parse(localStorage.getItem(AI_CFG_KEY_OLD) || 'null');
        if (old) d = { model: old.model, key: old.key, base: '' };
      }
      if (!d) return;
      if (d.base) aiCfg.base = String(d.base).replace(/\/+$/, '');
      if (d.model) aiCfg.model = String(d.model);
      if (d.visionModel) aiCfg.visionModel = String(d.visionModel);
      if (d.key) aiCfg.key = String(d.key);
      if (d.online === false) aiCfg.online = false;
    } catch (e) { /* ignore */ }
  }

  /* 填的是本机服务地址就走 server.mjs，否则浏览器直连模型 */
  function aiIsServer() {
    return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/i.test(aiCfg.base || '');
  }

  function aiBaseUrl() {
    return (aiCfg.base || AI_DEFAULT_BASE).replace(/\/+$/, '');
  }

  function saveAiCfg() {
    try { localStorage.setItem(AI_CFG_KEY, JSON.stringify(aiCfg)); } catch (e) { /* ignore */ }
  }

  /* ------------------- token 统计 ------------------- */
  const USAGE_KEY = 'pg_token_usage_v1';

  function todayKey() {
    const d = new Date();
    const p2 = n => (n < 10 ? '0' + n : String(n));
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  }

  function emptyUsage() {
    return { date: todayKey(), total: 0, prompt: 0, completion: 0, calls: 0 };
  }

  function loadUsage() {
    try {
      const d = JSON.parse(localStorage.getItem(USAGE_KEY) || 'null');
      /* 跨天自动清零：只保留「今天」的那一份 */
      if (d && d.date === todayKey()) {
        return {
          date: d.date,
          total: Number(d.total) || 0,
          prompt: Number(d.prompt) || 0,
          completion: Number(d.completion) || 0,
          calls: Number(d.calls) || 0
        };
      }
    } catch (e) { /* ignore */ }
    return emptyUsage();
  }

  let usageToday = loadUsage();

  function saveUsage() {
    try { localStorage.setItem(USAGE_KEY, JSON.stringify(usageToday)); } catch (e) { /* ignore */ }
  }

  function addUsage(u) {
    const total = Number(u && u.total) || 0;
    if (!total) return;
    if (usageToday.date !== todayKey()) usageToday = emptyUsage();
    usageToday.total += total;
    usageToday.prompt += Number(u.prompt) || 0;
    usageToday.completion += Number(u.completion) || 0;
    usageToday.calls += 1;
    saveUsage();
    renderUsage(u);
  }

  function num(n) {
    return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /* 一次请求的消耗 + 今天的累计 */
  function renderUsage(last) {
    const el = $('#aiUsage');
    if (!el) return;
    loadUsage();
    el.textContent = usageToday.calls ? ('今日调用 ' + usageToday.calls + ' 次') : '';
  }

  /* 调试/测试用：能读到当前 AI 配置 */
  try { if (typeof window !== 'undefined') window.__PG_AI_CFG__ = aiCfg; } catch (e) { /* ignore */ }

  function aiLogEl(role, text) {
    const log = $('#aiLog');
    const hint = log.querySelector('.ai-hint');
    if (hint) hint.remove();
    const div = document.createElement('div');
    div.className = 'ai-msg ' + role;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  function renderAiLog() {
    const log = $('#aiLog');
    log.innerHTML = '';
    if (!aiMsgs.length) {
      log.innerHTML = `<div class="ai-hint">先在下面「接口 / Key」里填上你的模型地址与 Key（如 <code>https://api.deepseek.com</code> + 自己的 Key），然后用中文描述想要的画面。<br>模型会自动检索标签库，把选好的标签直接放进「已选」；不想填 Key 也可以填 <code>http://127.0.0.1:8787</code> 改用本地服务。</div>`;
      return;
    }
    aiMsgs.forEach(m => aiLogEl(m.role === 'assistant' ? 'assistant' : 'user', m.content));
    if (aiLast) renderAiResult(aiLast);
  }

  function renderAiResult(res) {
    aiLast = res;
    if (res && res.usage) renderUsage(res.usage);
    const pos = (res && res.positive) || [];
    const neg = (res && res.negative) || [];
    const texts = (res && res.texts) || [];
    $('#aiCount').textContent = String(pos.length);
    $('#aiNote').textContent = neg.length ? `负面 ${neg.length} 个` : '';
    $('#aiChips').innerHTML = pos.map(it =>
      `<span class="pchip">${esc(it.en)}<span class="zh">(${esc(it.zh || '')})</span></span>`
    ).join('') + (neg.length ? `<span class="parse-sep">负面</span>` + neg.map(it =>
      `<span class="pchip neg">${esc(it.en)}<span class="zh">(${esc(it.zh || '')})</span></span>`
    ).join('') : '');
    $('#aiTexts').innerHTML = texts.length
      ? `<div class="ai-sec">补充文本 <span class="muted">标签库表达不了的细节，已展开成自然英文短句</span></div>` +
      texts.map(it => `<span class="pchip text">${esc(it.en)}<span class="zh">(${esc(it.zh || '')})</span></span>`).join('')
      : '';
    $('#aiSrc').innerHTML = sourceLine(res);
    $('#aiResult').hidden = pos.length + neg.length + texts.length === 0;
  }

  /* 查证过程要能看见：用了哪个源、查到的角色标签、样本量 */
  function sourceLine(res) {
    const list = (res && res.sources) || [];
    if (!list.length) {
      return (res && res.lookups) ? '<div class="ai-src">本轮查过网，百科这次没给资料 —— 外观是模型按自己的理解推断的（回复里会标「推断」）</div>' : '';
    }
    const NAME = {
      local: '本地角色库', baike: '百度百科', anilist: 'AniList',
      biligame: 'biligame 维基', danbooru: 'Danbooru',
      vision: '视觉识图', kitsu: 'Kitsu'
    };
    const parts = list.map(s => {
      const nm = NAME[s.type] || s.type;
      if (s.type === 'danbooru') {
        const extra = s.total ? `（站内 ${s.posts} 张图 · 取了 ${s.total} 张统计外观）` : `（站内 ${s.posts} 张图）`;
        return `<a href="https://danbooru.donmai.us/wiki_pages/${encodeURIComponent(String(s.tag).replace(/ /g, '_'))}" target="_blank" rel="noreferrer">${esc(nm)}</a> · ${esc(s.tag)}${extra}`;
      }
      if ((s.type === 'biligame' || s.type === 'baike') && s.url) {
        return `<a href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(nm)}</a> · ${esc(s.tag)}`;
      }
      if (s.type === 'vision') {
        return `${esc(nm)} · ${esc(s.tag)}${s.total ? '（识别出 ' + s.total + ' 个外观标签）' : ''}`;
      }
      return `${esc(nm)} · ${esc(s.tag || '')}`;
    });
    return `<div class="ai-src">查证来源：${parts.join('　|　')}</div>`;
  }

  function aiBody() {
    return {
      model: aiCfg.model || 'deepseek-chat',
      apiKey: aiCfg.key || '',
      online: aiCfg.online !== false,
      /* 识图用的模型：留空就跟主模型一样。服务端会优先用这个配置 */
      vision: {
        base: aiCfg.base || '',
        model: aiCfg.visionModel || aiCfg.model || 'deepseek-chat',
        key: aiCfg.key || ''
      },
      messages: aiMsgs.slice(-12)
    };
  }

  async function aiSend() {
    if (aiBusy) return;
    const box = $('#aiMsg');
    const text = String(box.value || '').trim();
    if (!text) { toast('先说一句你想要什么'); return; }

    aiMsgs.push({ role: 'user', content: text });
    box.value = '';
    aiLogEl('user', text);
    const pending = aiLogEl('assistant', '思考中…');
    pending.classList.add('pending');

    aiBusy = true;
    $('#aiSend').disabled = true;
    try {
      const data = await aiCall();
      pending.remove();
      const reply = String(data.reply || '（模型没有返回文字）');
      aiMsgs.push({ role: 'assistant', content: reply });
      aiLogEl('assistant', reply);
      const u = data.usage || null;
      if (u) addUsage(u);
      renderAiResult({
        usage: u,
        online: data.online,
        positive: (data.positive || []).map(x => ({ en: x.en, zh: x.zh || zhLookup(x.en) })),
        negative: (data.negative || []).map(x => ({ en: x.en, zh: x.zh || zhLookup(x.en) })),
        texts: (data.texts || []).map(x => ({ en: x.en, zh: x.zh || translateToZh(x.en) })),
        sources: data.sources || [],
        lookups: Number(data.lookups) || 0
      });
      if (data.note) $('#aiNote').textContent = data.note;
    } catch (err) {
      pending.remove();
      aiLogEl('error', aiErrorText(err));
      toast('AI 请求失败');
    } finally {
      aiBusy = false;
      $('#aiSend').disabled = false;
    }
  }

  /* 网络层失败（跨域被挡、服务没开、断网）在这里区分开，好给具体建议 */
  function isNetErr(e) {
    const s = String((e && e.message) || e);
    return (e instanceof TypeError) ||
      s.indexOf('Failed to fetch') >= 0 ||
      s.indexOf('NetworkError') >= 0 ||
      s.indexOf('Load failed') >= 0;
  }

  function aiErrorText(err) {
    const msg = String((err && err.message) || err);
    if (msg.indexOf('还没填') >= 0 || msg.indexOf('API Key') >= 0) return msg;
    if (isNetErr(err)) {
      return '连不上：Failed to fetch\n' +
        (aiIsServer()
          ? '当前是「本地服务」模式，但 ' + aiBaseUrl() + ' 没有响应。\n两个办法：① 把「接口」改成 https://api.deepseek.com 用浏览器直连；② 先把本地服务开起来。'
          : '当前是「浏览器直连」模式，' + aiBaseUrl() + ' 没能访问。\n可能是：接口地址写错、网络不通、或者浏览器拦了跨域请求。点上面的「测试连接」能看到更具体的原因。');
    }
    return '出错了：' + msg;
  }

  /* 服务模式：POST 给 server.mjs；直连模式：浏览器自己跟模型说话 */
  async function aiCall() {
    if (aiIsServer()) {
      try {
        return await aiCallServer();
      } catch (e) {
        /* 服务没开但手里有 Key —— 自动降级成直连，别让用户卡在这 */
        if (isNetErr(e) && aiCfg.key) {
          aiLogEl('assistant', '本地服务没连上，自动改用浏览器直连…');
          aiCfg.base = '';
          saveAiCfg();
          return await aiCallDirect();
        }
        throw e;
      }
    }
    return await aiCallDirect();
  }

  async function aiCallServer() {
    const resp = await fetch(aiBaseUrl() + '/api/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(aiBody())
    });
    let srv = null;
    try { srv = await resp.json(); } catch (e) { /* 非 JSON */ }
    if (!resp.ok || !srv || srv.error) {
      throw new Error((srv && srv.error) || ('本地服务返回 HTTP ' + resp.status));
    }
    return srv;
  }

  async function aiCallDirect() {
    if (typeof PG_AI === 'undefined' && !(window.PG_AI)) throw new Error('页面里没有加载 js/ai.js，无法直连模型');
    const api = (window.PG_AI || PG_AI);
    /* 把视觉模型塞进 ai.js：查角色时它会拿百科/AniList 的角色图直接识图 */
    if (api.setVision) {
      api.setVision({ base: aiBaseUrl(), model: aiCfg.visionModel || aiCfg.model || '', key: aiCfg.key || '' });
    }
    return await api.chatWithTools({
      messages: aiMsgs.slice(-12),
      apiKey: aiCfg.key,
      base: aiBaseUrl(),
      model: aiCfg.model || 'deepseek-chat',
      online: aiCfg.online !== false
    });
  }

  /* 「测试连接」：不发真实的选词请求，只探一下网络与鉴权到底通不通 */
  async function aiTest() {
    const line = aiLogEl('assistant', '测试连接中…');
    const url = aiBaseUrl();
    try {
      if (aiIsServer()) {
        const r = await fetch(url + '/api/health', { method: 'GET' });
        const j = await r.json().catch(() => null);
        line.textContent = r.ok
          ? '本地服务在线：' + (j ? (j.tags + ' 个标签，模型 ' + j.model + (j.hasKey ? '，服务端已有 Key' : '，服务端没有 Key')) : 'ok')
          : '本地服务返回 HTTP ' + r.status;
        return;
      }
      const r = await fetch(url + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (aiCfg.key || '') },
        body: JSON.stringify({
          model: aiCfg.model || 'deepseek-chat',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1
        })
      });
      const txt = await r.text();
      if (r.ok) { line.textContent = '直连成功：' + url + '（模型 ' + (aiCfg.model || 'deepseek-chat') + '）'; return; }
      let detail = txt;
      try { detail = JSON.parse(txt).error.message || txt; } catch (e) { /* 原样 */ }
      line.textContent = '接口能连上，但返回 HTTP ' + r.status + '：' + String(detail).slice(0, 200) +
        (r.status === 401 ? '\nKey 不对或已失效。' : '');
    } catch (e) {
      line.textContent = aiErrorText(e);
    }
  }

  function applyAi(mode) {
    if (!aiLast) { toast('还没有可应用的选词结果'); return; }
    const pos = aiLast.positive || [];
    const neg = aiLast.negative || [];
    const texts = aiLast.texts || [];
    if (!pos.length && !neg.length && !texts.length) { toast('这次没有选中任何标签'); return; }
    if (mode === 'replace') { state.sel = []; state.neg = []; state.chars = []; stateCharTags = []; }
    // 先切到正向，否则 addTag 会写进负面列表
    state.mode = 'pos';
    syncModeSeg();
    const beforeSel = state.sel.length;
    const beforeNeg = state.neg.length;

    /* 角色联动：AI 选到角色名（含省略括号、大小写不一致等宽容写法）时，
       和手动点角色一样，把它自带的服饰 / 发饰 / 体型一并选上 */
    const charHits = [];
    const charKeys = new Set();
    const charItems = new Set();
    for (const it of pos) {
      const r = resolveOne(it.en, true);
      if (r && r.char && !charKeys.has(r.char.key)) {
        charKeys.add(r.char.key);
        charHits.push(r.char);
        charItems.add(it);
      }
    }
    let autoAdded = 0;
    charHits.forEach(c => { autoAdded += expandCharacter(c); });

    pos.forEach(it => {
      // 角色本体已由 expandCharacter 加入，别重复
      if (charItems.has(it)) return;
      /* 模型可能给出 \( 转义、被截断的括号、大小写不一致，先复位成标签库里的写法 */
      const r = resolveOne(it.en, true);
      let en = r ? r.en : it.en;
      if (!r) { const ct = cleanToken(it.en); if (ct && ct.s) en = ct.s; }
      addTag(en, (r && r.zh) || it.zh, 1);
    });
    texts.forEach(it => { addTag(it.en, it.zh, 1, 'text'); });
    neg.forEach(it => {
      const k = norm(it.en);
      if (!k) return;
      if (state.neg.some(x => x.key === k)) return;
      state.neg.push({ key: k, en: it.en, zh: it.zh || zhLookup(it.en), w: 1 });
    });

    const n = (state.sel.length - beforeSel) + (state.neg.length - beforeNeg);
    state.mode = 'pos';
    syncModeSeg();
    closeModal('modalAI');
    renderSelected();
    renderGrid();
    renderCharChip();
    save();
    toast(charHits.length
      ? 'AI 已选好 ' + n + ' 个标签，并套用「' + charHits.map(c => c.name).join('、') + '」的 ' + autoAdded + ' 项外观标签'
      : 'AI 已选好 ' + n + ' 个标签');
  }

  /* =====================================================================
     5.9 中英双向翻译
     ===================================================================== */

  function hasLatin(s) { return /[A-Za-z]/.test(String(s)); }

  /* 判断方向：有中文 → 出英文；纯英文 → 出中文 */
  function transDirection(src) { return isChinese(src) ? 'toEn' : (hasLatin(src) ? 'toZh' : 'toEn'); }

  async function translateZhToEn(src, online) {
    const items = translateText(src);
    const missAll = [];
    const ens = [];
    for (const it of items) {
      let en = it.en;
      if (!en && online && it.raw) {
        try { en = await onlineTranslate(it.raw); } catch (e) { /* 联网失败就用原文 */ }
      }
      if (it.miss && it.miss.length) missAll.push(...it.miss);
      if (en) ens.push(en);
    }
    return { out: ens.join(', '), miss: missAll };
  }

  async function translateEnToZh(src, online) {
    const local = translateToZh(src);
    if (!online) return { out: local, miss: [] };
    // 逐段检查：还留着整片英文的段，交给在线接口
    const segs = String(src).split(/[\n,;|]+/).map(s => s.trim()).filter(Boolean);
    const out = [];
    for (const seg of segs) {
      const z = translateToZh(seg);
      if (isChinese(z) && !/[a-z]{3,}/i.test(z)) { out.push(z); continue; }
      try { out.push(await onlineTranslateToZh(bareToken(seg))); }
      catch (e) { out.push(z); }
    }
    return { out: out.join('，'), miss: [] };
  }

  function forceOnlineOn() {
    const el = $('#transForce');
    return !!(el && el.checked);
  }

  let _gtSrcLang = 'auto'; // 'auto' | 'zh-CN' | 'en' | 'ja' (日文需自选)
  let _gtTgtLang = 'en';   // 'zh-CN' | 'en' | 'ja'
  let _gtLiveTimer = null;

  function syncGtLangTabsUI() {
    $$('#gtSrcLangTabs [data-gt-src]').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-gt-src') === _gtSrcLang);
    });
    $$('#gtTgtLangTabs [data-gt-tgt]').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-gt-tgt') === _gtTgtLang);
    });
    if ($('#transTarget')) {
      $('#transTarget').value = _gtTgtLang === 'zh-CN' ? 'zh' : _gtTgtLang;
    }
  }

  async function runTranslate(silentEmpty) {
    const srcEl = $('#transSrc');
    const src = String((srcEl && srcEl.value) || '').trim();
    if ($('#transCharCount')) $('#transCharCount').textContent = `${(srcEl && srcEl.value ? srcEl.value.length : 0)} / 5000`;
    if (!src) {
      if ($('#transOut')) $('#transOut').value = '';
      if ($('#transStat')) $('#transStat').textContent = '准备就绪';
      if (!silentEmpty) toast('请先输入或粘贴要翻译的内容');
      return;
    }
    const online = $('#transOnline') ? $('#transOnline').checked : true;
    const force = forceOnlineOn();
    const stat = $('#transStat');

    // 自动检测仅在 简体中文 (zh-CN) 与 英文 (en) 之间判断；日文 (ja) 需手动自选
    let effSrc = _gtSrcLang;
    let effTgt = _gtTgtLang;
    if (effSrc === 'auto') {
      effSrc = isChinese(src) ? 'zh-CN' : 'en';
      // 若未手动选日文，且源语言与目标语言相同，自动互换中/英目标方向
      if (effTgt !== 'ja' && effSrc === effTgt) {
        effTgt = (effSrc === 'zh-CN') ? 'en' : 'zh-CN';
        _gtTgtLang = effTgt;
        syncGtLangTabsUI();
      }
    }

    if (effSrc === effTgt) {
      if ($('#transOut')) $('#transOut').value = src;
      if (stat) stat.textContent = '源语言与目标语言相同';
      return;
    }

    if (stat) stat.textContent = '正在联网翻译…';
    let out = '';
    let engine = '';

    if (effSrc === 'zh-CN' && effTgt === 'en') {
      const items = translateText(src);
      const local = items.filter(it => it.en).map(it => it.en).join(', ');
      const covered = items.length > 0 && items.every(it => it.en && !(it.miss && it.miss.length));
      if (covered && !force) {
        out = local;
        engine = '本地词库';
      } else if (online || force) {
        try { out = await serverTranslate(src, 'zh-CN', 'en'); engine = '在线翻译(有道)'; }
        catch (e) { out = ''; }
        if (!out || !hasLatin(out)) { out = local; engine = '本地词库'; }
      } else {
        out = local;
        engine = '本地词库';
      }
    } else if (effSrc === 'en' && effTgt === 'zh-CN') {
      if (online || force) {
        try {
          const t = await serverTranslate(src, 'en', 'zh-CN');
          if (t && /[\u4e00-\u9fff]/.test(t)) { out = t; engine = '在线翻译(有道)'; }
        } catch (e) {}
        if (!out) { out = translateToZh(src); engine = '本地词库'; }
      } else {
        out = translateToZh(src);
        engine = '本地词库';
      }
    } else {
      // 涉及日文 (ja) 的自选翻译（中↔日、英↔日）
      if (online || force) {
        try {
          out = await serverTranslate(src, effSrc, effTgt);
          engine = '在线翻译(有道)';
        } catch (e) { out = ''; }
      } else {
        stat.textContent = '日文翻译需开启「联网翻译」';
        return;
      }
    }

    if (!out) {
      if (stat) {
        stat.textContent = online
          ? '在线翻译暂不可用，且本地词库未命中'
          : '词库未覆盖，请勾选「联网翻译」重试';
      }
      if ($('#transOut')) $('#transOut').value = '';
      return;
    }
    if ($('#transOut')) $('#transOut').value = out;
    if (stat) {
      const langNames = { 'zh-CN': '简体中文', 'en': '英文', 'ja': '日文' };
      stat.textContent = `${langNames[effSrc] || effSrc} → ${langNames[effTgt] || effTgt} · ${engine}`;
    }
  }

  function transAddToSel() {
    const out = String($('#transOut').value || '').trim();
    if (!out) { toast('结果还是空的'); return; }
    if (isChinese(out)) { toast('结果是中文，先翻译成英文再加'); return; }
    recordHistorySnapshot('从翻译窗口加入提示词');
    const parts = out.split(/[\n,;|]+/).map(s => s.trim()).filter(Boolean);
    let n = 0;
    parts.forEach(p => { if (addTag(bareToken(p), translateToZh(p), 1)) n++; });
    renderSelected(); renderGrid(); save();
    toast(n ? `加入 ${n} 个` : '都已经在已选里了');
  }

  /* =====================================================================
     6. 弹窗
     ===================================================================== */

  const _CHILD_MODALS = new Set([
    'modalRandomSettings', 'modalRsMultiCat', 'modalConfirm', 'modalStageEdit',
    'modalQuickEditTag', 'modalMoveTag', 'modalMoveSub', 'modalSubAddTag', 'modalDiff'
  ]);
  const _modalStack = [];

  function syncBodyModalClass() {
    const hasOpen = _modalStack.some(id => {
      const elM = document.getElementById(id);
      return elM && !elM.hidden;
    });
    document.body.classList.toggle('has-open-modal', hasOpen);
  }

  function openModal(id, keepParent) {
    const m = document.getElementById(id);
    if (!m) return;
    const isChild = keepParent || _CHILD_MODALS.has(id);
    if (!isChild) {
      $$('.modal').forEach(x => { if (x !== m) x.hidden = true; });
      _modalStack.length = 0;
    }
    m.hidden = false;
    const idx = _modalStack.indexOf(id);
    if (idx >= 0) _modalStack.splice(idx, 1);
    _modalStack.push(id);
    syncBodyModalClass();
  }
  let _rsSavedBackup = null;
  let _rsCommittedSave = false;

  function revertUnsavedRandomSettingsIfNeeded(closingModalId) {
    if (closingModalId !== 'modalRandomSettings') return;
    if (typeof closeRsPopovers === 'function') closeRsPopovers();
    if (!_rsCommittedSave && _rsSavedBackup) {
      state.randCfg = JSON.parse(JSON.stringify(_rsSavedBackup));
      ensureRandCfgStructure();
      if (typeof syncSchemeLabelUI === 'function') syncSchemeLabelUI();
      if (typeof renderRandSwitchBar === 'function') renderRandSwitchBar();
    }
    _rsCommittedSave = false;
  }

  function closeModal(id) {
    if (typeof hideContextMenu === 'function') hideContextMenu();
    const m = document.getElementById(id);
    if (m && !m.hidden) {
      revertUnsavedRandomSettingsIfNeeded(id);
    }
    if (m) m.hidden = true;
    const idx = _modalStack.indexOf(id);
    if (idx >= 0) _modalStack.splice(idx, 1);
    syncBodyModalClass();
  }
  function closeTopModal() {
    for (let i = _modalStack.length - 1; i >= 0; i--) {
      const id = _modalStack[i];
      const m = document.getElementById(id);
      if (m && !m.hidden) {
        revertUnsavedRandomSettingsIfNeeded(id);
        m.hidden = true;
        _modalStack.splice(i, 1);
        syncBodyModalClass();
        return true;
      }
    }
    const visible = $$('.modal').filter(m => !m.hidden);
    if (visible.length) {
      const topM = visible[visible.length - 1];
      revertUnsavedRandomSettingsIfNeeded(topM.id);
      topM.hidden = true;
      syncBodyModalClass();
      return true;
    }
    return false;
  }
  function closeAll() {
    closeTopModal();
  }

  let CHAR_POOL_COUNT = 0;

  function charGroup() {
    const list = window.PG_CHAR_GROUPS || [];
    return list.find(g => g.id === (state._group || '全部')) || list[0] || { id: '全部', ips: null };
  }

function ipMergeMap() { return window.PG_IP_MERGE || {}; }
  function ipMembers(name) {
    const m = ipMergeMap();
    return m[name] ? m[name] : [name];
  }
  function matchGame(c, name) {
    if (!name || name === '全部') return true;
    if (!c) return false;
    if (c.game === name) return true;
    const mem = ipMergeMap()[name];
    return !!(mem && mem.indexOf(c.game) >= 0);
  }
  function ipChildGames() {
    const set = new Set();
    const m = ipMergeMap();
    Object.keys(m).forEach(k => m[k].forEach(x => set.add(x)));
    return set;
  }
  function charGroupCount(g) {
    if (g.id === '全部') return CHARS.length;
    if (g.id === '收藏') return state.favChars.length;
    if (g.id === '最近') return (state.recentChars || []).length;
    return CHARS.filter(c => (g.ips || []).some(ip => matchGame(c, ip))).length;
  }

  function renderCharModal() {
    const groups = window.PG_CHAR_GROUPS || [{ id: '全部', name: '全部', ips: null }];
    const cur = charGroup();
    $('#groupTabs').innerHTML = groups.map(g =>
      `<button data-cgroup="${esc(g.id)}" class="${g.id === cur.id ? 'active' : ''}">${esc(g.name)} ${charGroupCount(g)}</button>`
    ).join('');
    const inGroup = ip => cur.id === '全部' ? true
      : (cur.id === '收藏' || cur.id === '最近' ? true : (cur.ips || []).some(x => matchGame({ game: ip }, x) || x === ip));
    const child = ipChildGames();
    let games = GAMES.filter(g => !child.has(g) && inGroup(g));
    Object.keys(ipMergeMap()).forEach(k => {
      if (GAMES.indexOf(k) < 0 && ipMembers(k).some(x => GAMES.indexOf(x) >= 0) && inGroup(k)) games.push(k);
    });
    const hotIdx = games.indexOf('热门番剧');
    if (hotIdx > 0) { games.splice(hotIdx, 1); games.unshift('热门番剧'); }
    const poolCount = CHARS.filter(c => cur.id === '全部' ? true
      : (cur.id === '收藏' ? isFavChar(c.key) : (cur.id === '最近' ? (state.recentChars || []).indexOf(c.key) >= 0
        : (cur.ips || []).some(ip => matchGame(c, ip))))).length;
    const tabs = ['全部', ...games];
    $('#gameTabs').innerHTML = tabs.map((g, i) =>
      `<button data-game="${esc(g)}" class="${(i === 0 && (!state._game || state._game === '全部')) || state._game === g ? 'active' : ''}">${esc(g)}${g === '全部' ? ' ' + poolCount : ' ' + CHARS.filter(c => matchGame(c, g)).length}</button>`
    ).join('');
    renderCharGrid();
  }

  function renderCharGrid() {
    const q = norm($('#charSearch').value || '');
    const game = state._game || '全部';
    const grp = charGroup();
    const inGroup = c => grp.id === '全部' ? true
      : (grp.id === '收藏' ? isFavChar(c.key) : (grp.id === '最近' ? (state.recentChars || []).indexOf(c.key) >= 0 : (grp.ips || []).some(ip => matchGame(c, ip))));
    const pool = CHARS.filter(inGroup);
    CHAR_POOL_COUNT = pool.length;
    const list = pool.filter(c => {
      if (game !== '全部' && !matchGame(c, game)) return false;
      if (!q) return true;
      return norm(c.name).includes(q) || norm(c.tag).includes(q) ||
        norm(c.game).includes(q) || String(c.name).includes($('#charSearch').value.trim()) ||
        pyHit(c.name, q) || pyHit(c.charZh, q) || pyHit(c.game, q);
    });
    if (!list.length) {
      $('#charGrid').innerHTML = `<div class="muted" style="padding:20px">没有匹配的角色</div>`;
      return;
    }
    list.sort((a, b) => (isFavChar(b.key) ? 1 : 0) - (isFavChar(a.key) ? 1 : 0));
    $('#charGrid').innerHTML = list.map(c => `
      <div class="char-card${state.chars.some(x => x.key === c.key) ? ' on' : ''}" data-char="${esc(c.key)}">
        <span class="pc-tools">
          <button class="mini" data-cfav="${esc(c.key)}" title="收藏角色">${isFavChar(c.key) ? '★' : '☆'}</button>
          <button class="mini" data-cedit="${esc(c.key)}" title="改外观">✎</button>
          <button class="mini" data-cdel="${esc(c.key)}" title="删除">🗑</button>
        </span>
        <div class="cn">${esc(c.name)}</div>
        <div class="eg">${esc(c.tag)}</div>
        <div class="gm">${esc(c.game)} · ${c.auto.length} 项外观${c.custom ? ' · 已改' : ''}</div>
      </div>`).join('');
  }

  function presetCardHtml(p) {
    return `
      <div class="preset-card${presetPick.indexOf(p.key) >= 0 ? ' picked' : ''}" data-preset="${esc(p.key)}">
        <div class="pc-head">
          <b>${esc(p.name)}</b>
          <span class="pc-tools">
            <button class="mini" data-padd="${esc(p.key)}" title="加入组合，可多个预设叠加">＋</button>
            <button class="mini" data-pedit="${esc(p.key)}" title="编辑">✎</button>
            <button class="mini" data-pexp="${esc(p.key)}" title="导出预设 (.json)">📤</button>
            <button class="mini" data-pdel="${esc(p.key)}" title="删除">🗑</button>
          </span>
        </div>
        <p>${esc(p.desc)}</p>
        <p class="pc-meta">${esc(p.cat || '其他')} · ${p.tags.length} 个标签${p.custom ? ' · 已改' : ''}</p>
      </div>`;
  }

  function renderPresetModal() {
    const qEl = $('#presetSearch');
    const q = norm(qEl ? qEl.value : '');
    const CATS_P = window.PG_PRESET_CATS || [];
    const cur = state.presetCat || 'all';
    const counts = {};
    PRESETS.forEach(p => { const c = p.cat || '其他'; counts[c] = (counts[c] || 0) + 1; });
    const catsEl = $('#presetCats');
    if (catsEl) {
      let chips = '<button class="pcat' + (cur === 'all' ? ' active' : '') + '" data-pcat="all">全部 <span>' + PRESETS.length + '</span></button>';
      CATS_P.forEach(c => {
        if (!counts[c]) return;
        chips += '<button class="pcat' + (cur === c ? ' active' : '') + '" data-pcat="' + esc(c) + '">' + esc(c) + ' <span>' + counts[c] + '</span></button>';
      });
      if (counts['其他']) {
        chips += '<button class="pcat' + (cur === '其他' ? ' active' : '') + '" data-pcat="其他">其他 <span>' + counts['其他'] + '</span></button>';
      }
      catsEl.innerHTML = chips;
      if (!catsEl._bound) {
        catsEl.addEventListener('click', ev => {
          const b = ev.target && ev.target.closest ? ev.target.closest('[data-pcat]') : null;
          if (!b) return;
          state.presetCat = b.getAttribute('data-pcat');
          renderPresetModal();
        });
        catsEl._bound = true;
      }
    }
    let list = PRESETS.filter(p => !q || norm(p.name).includes(q) || norm(p.desc).includes(q)
      || norm(p.cat || '').includes(q) || pyHit(p.name, q) || pyHit(p.desc, q));
    if (cur !== 'all') list = list.filter(p => (p.cat || '其他') === cur);
    if (!list.length) {
      $('#presetList').innerHTML = '<div class="muted" style="padding:20px">没有匹配的预设</div>';
      return;
    }
    const order = CATS_P.slice();
    list = list.slice().sort((a, b) => {
      const ia = order.indexOf(a.cat || '其他');
      const ib = order.indexOf(b.cat || '其他');
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    let last = null;
    $('#presetList').innerHTML = list.map(p => {
      const c = p.cat || '其他';
      let head = '';
      if (c !== last) { last = c; head = '<div class="preset-group">' + esc(c) + '</div>'; }
      return head + presetCardHtml(p);
    }).join('');
    updatePresetCombo();
  }

  /* ---------- 编辑区折叠（默认收起，点 ✎ / 新增 才展开） ---------- */

  function setFold(sel, folded) {
    const panel = $(sel);
    const btn = $(sel === '#presetEdit' ? '#peFold' : '#ceFold');
    const card = $(sel === '#presetEdit' ? '#modalPreset .modal-card' : '#modalChar .modal-card');
    if (!panel) return;
    panel.classList.toggle('folded', !!folded);
    /* 编辑时整个弹窗切成「编辑模式」：列表隐藏，编辑区占满，输入框自然变高 */
    if (card) card.classList.toggle('editing', !folded && !panel.hidden);
    if (btn) {
      btn.textContent = folded ? '▸' : '▾';
      btn.title = folded ? '展开编辑区' : '收起编辑区';
    }
  }

  /* ---------- 预设编辑器 ---------- */

  let editPresetKey = null;

  function openPresetEditor(key) {
    const isNew = !key;
    const p = isNew ? { name: '', desc: '', tags: [] } : PRESETS.find(x => x.key === key);
    if (!p) return;
    editPresetKey = isNew ? '__new' : key;
    $('#presetEdit').hidden = false;
    setFold('#presetEdit', false);
    $('#presetEditTitle').textContent = isNew ? '新增预设' : '编辑预设';
    $('#presetEditHint').textContent = isNew
      ? '写一个自己的预设，之后能随时点开用'
      : (p.custom ? '这是你改过的预设，可以再改回去' : '这是内置预设，改完会另存一份，不影响原始数据');
    $('#peName').value = p.name;
    $('#peDesc').value = p.desc;
    $('#peTags').value = tagText(p.tags);
    const catSel = $('#peCat');
    if (catSel) {
      const catsP = window.PG_PRESET_CATS || [];
      catSel.innerHTML = catsP.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
      catSel.value = p.cat || '场景';
      if (!catSel.value) catSel.value = catsP[0] || '场景';
    }
    $('#peDelete').hidden = isNew;
    try { $('#peName').focus(); } catch (e) { /* ignore */ }
  }

  function closePresetEditor() {
    editPresetKey = null;
    setFold('#presetEdit', true);
    $('#presetEdit').hidden = true;
  }

  function savePresetEditor() {
    const name = String($('#peName').value || '').trim();
    const desc = String($('#peDesc').value || '').trim();
    const tags = parseTagText($('#peTags').value);
    if (!name) { toast('先给预设起个名字'); return; }
    if (!tags.length) { toast('至少写一个标签（英文|中文）'); return; }
    const cat = String(($('#peCat') && $('#peCat').value) || '场景');

    recordHistorySnapshot((editPresetKey === '__new' ? '新增预设: ' : '编辑预设: ') + name);
    let savedKey = editPresetKey;
    if (editPresetKey === '__new') {
      const key = 'u' + Date.now().toString(36);
      savedKey = key;
      CUSTOM.presets.push({ key, name, desc, tags: tagText(tags), cat });
      PRESETS.push({ key, name, desc, tags, cat, custom: true });
    } else {
      const p = PRESETS.find(x => x.key === editPresetKey);
      if (!p) return;
      p.name = name; p.desc = desc; p.tags = tags; p.cat = cat; p.custom = true;
      if (p.key.charAt(0) === 'u') {
        const u = CUSTOM.presets.find(x => x.key === p.key);
        if (u) { u.name = name; u.desc = desc; u.tags = tagText(tags); u.cat = cat; }
      } else {
        CUSTOM.presetEdit[p.key] = { name, desc, tags: tagText(tags), cat };
      }
    }
    persistLibraryItemToFolder('presets', {
      key: savedKey,
      id: savedKey,
      name,
      desc,
      cat,
      tags: tags.map(t => (t.zh ? t.en + '|' + t.zh : t.en)).join(';'),
      custom: true
    });
    tags.forEach(t => idxAdd(t.en, t.zh));
    saveCustom();
    closePresetEditor();
    renderPresetModal();
    toast('✅ 预设已保存至 libraries/presets/');
  }

  function deletePreset(key) {
    const p = PRESETS.find(x => x.key === key);
    if (!p) return;
    askConfirmModal('确定删除预设「' + p.name + '」吗？', () => {
      recordHistorySnapshot('删除预设: ' + p.name);
      const i = PRESETS.indexOf(p);
      if (i >= 0) PRESETS.splice(i, 1);
      if (key.charAt(0) === 'u') {
        CUSTOM.presets = CUSTOM.presets.filter(x => x.key !== key);
      } else {
        if (CUSTOM.presetDel.indexOf(key) < 0) CUSTOM.presetDel.push(key);
        delete CUSTOM.presetEdit[key];
      }
      deleteLibraryItemFromFolder('presets', key);
      saveCustom();
      if (editPresetKey === key) closePresetEditor();
      renderPresetModal();
      toast('🗑 预设已删除');
    });
  }

  function resetPresets() {
    if (!Object.keys(CUSTOM.presetEdit).length && !CUSTOM.presetDel.length) {
      toast('内置预设都是原样的');
      return;
    }
    askConfirmModal('把改过、删过的内置预设恢复原样？（你自己新增的预设会保留）', () => {
      CUSTOM.presetEdit = {};
      CUSTOM.presetDel = [];
      saveCustom();
      location.reload();
    });
  }

  /* ---------- 角色编辑器 ---------- */

  let editCharKey = null;

  function openCharEditor(key) {
    const isNew = !key;
    const c = isNew ? { name: '', game: '', tag: '', charZh: '', auto: [] } : CHARS.find(x => x.key === key);
    if (!c) return;
    editCharKey = isNew ? '__new' : key;
    $('#charEdit').hidden = false;
    setFold('#charEdit', false);
    $('#charEditTitle').textContent = isNew ? '新增角色' : '编辑角色';
    $('#charEditHint').textContent = isNew
      ? '角色标签要写全，例如 amiya (arknights)'
      : '外观标签会在选中这个角色时一起带上';
    $('#ceName').value = c.name;
    $('#ceGame').value = c.game;
    $('#ceTag').value = c.tag;
    $('#ceZh').value = c.charZh;
    $('#ceAuto').value = tagText(c.auto);
    $('#ceDelete').hidden = isNew;
    try { $('#ceName').focus(); } catch (e) { /* ignore */ }
  }

  function closeCharEditor() {
    editCharKey = null;
    setFold('#charEdit', true);
    $('#charEdit').hidden = true;
  }

  function saveCharEditor() {
    const name = String($('#ceName').value || '').trim();
    const game = String($('#ceGame').value || '').trim() || '自定义';
    const tag = String($('#ceTag').value || '').trim();
    const charZh = String($('#ceZh').value || '').trim() || (name ? name + '（' + game + '）' : '');
    const auto = parseTagText($('#ceAuto').value);
    if (!name) { toast('先填角色名'); return; }
    if (!tag) { toast('提示词标签不能空，例如 amiya (arknights)'); return; }

    let touchedCharKey = editCharKey;
    if (editCharKey === '__new') {
      const key = 'u' + Date.now().toString(36);
      touchedCharKey = key;
      CUSTOM.chars.push({ key, name, game, tag, charZh, auto: tagText(auto), isNew: true });
      CHARS.push({ key, name, game, tag, charZh, auto, custom: true, isNew: true });
    } else {
      const c = CHARS.find(x => x.key === editCharKey);
      if (!c) return;
      c.name = name; c.game = game; c.tag = tag; c.charZh = charZh;
      c.auto = auto; c.custom = true; c.isNew = true;
      if (c.key.charAt(0) === 'u') {
        const u = CUSTOM.chars.find(x => x.key === c.key);
        if (u) { u.name = name; u.game = game; u.tag = tag; u.charZh = charZh; u.auto = tagText(auto); }
      } else {
        CUSTOM.charEdit[c.key] = { name, game, tag, charZh, auto: tagText(auto) };
      }
    }
    idxAdd(tag, charZh);
    auto.forEach(t => idxAdd(t.en, t.zh));
    if (touchedCharKey && state.seenNewCharsSet instanceof Set) {
      state.seenNewCharsSet.delete(touchedCharKey);
      state.seenNewChars = Array.from(state.seenNewCharsSet);
    }
    saveCustom();
    save();
    if (window.PG_TAG_FS && window.PG_TAG_FS.syncCharsFromFlatList) window.PG_TAG_FS.syncCharsFromFlatList(CHARS);
    refreshGamesFromChars();
    closeCharEditor();
    renderCharModal();
    renderGrid();
    const hitIdx = state.chars.findIndex(x => x.key === editCharKey);
    if (hitIdx >= 0) {
      const c = CHARS.find(x => x.key === editCharKey);
      if (c) {
        state.chars[hitIdx] = Object.assign({}, state.chars[hitIdx], { name: c.name, tag: c.tag, charZh: c.charZh });
        renderCharChip();
        renderSelected();
      }
    }
    toast('角色已保存');
  }

  function deleteChar(key) {
    const c = CHARS.find(x => x.key === key) || findCustomCharByKey(key);
    if (!c) return;
    const curGrp = state._group || '全部';
    if (curGrp === '收藏') {
      recordHistorySnapshot(`从角色收藏移除: ${c.name}`);
      state.favChars = (state.favChars || []).filter(k => k !== key);
      renderCharModal();
      save();
      toast(`已从「收藏」移除角色「${c.name}」（角色库内保留）`);
      return;
    }
    if (curGrp === '最近') {
      recordHistorySnapshot(`从角色最近记录移除: ${c.name}`);
      state.recentChars = (state.recentChars || []).filter(k => k !== key);
      renderCharModal();
      save();
      toast(`已从「最近」移除角色「${c.name}」（角色库内保留）`);
      return;
    }
    askConfirmModal('确定从角色库删除角色「' + c.name + '」吗？已经选进提示词里的标签不会动。', () => {
      const i = CHARS.indexOf(c);
      if (i >= 0) CHARS.splice(i, 1);
      if (key.charAt(0) === 'u') {
        CUSTOM.chars = CUSTOM.chars.filter(x => x.key !== key);
      } else {
        if (CUSTOM.charDel.indexOf(key) < 0) CUSTOM.charDel.push(key);
        delete CUSTOM.charEdit[key];
      }
      saveCustom();
      if (window.PG_TAG_FS && window.PG_TAG_FS.syncCharsFromFlatList) window.PG_TAG_FS.syncCharsFromFlatList(CHARS);
      refreshGamesFromChars();
      if (editCharKey === key) closeCharEditor();
      if (state.chars.some(x => x.key === key)) removeCharacter(key);
      renderCharModal();
      toast('角色已删除并同步外部角色库');
    });
  }

  function resetChars() {
    if (!Object.keys(CUSTOM.charEdit).length && !CUSTOM.charDel.length) {
      toast('内置角色都是原样的');
      return;
    }
    askConfirmModal('把改过、删过的内置角色恢复原样？（你自己新增的角色会保留）', () => {
      CUSTOM.charEdit = {};
      CUSTOM.charDel = [];
      saveCustom();
      location.reload();
    });
  }

  function fillPresetFromSelection() {
    const list = currentList().filter(t => t.kind !== 'text');
    if (!list.length) { toast('还没选标签'); return; }
    $('#peTags').value = tagText(list.map(t => ({ en: t.en, zh: t.zh || zhLookup(t.en) })));
    toast('已填入 ' + list.length + ' 个标签');
  }

  /* =====================================================================
     7. 导入导出
     ===================================================================== */

  function exportData() {
    const data = {
      app: 'Prompt Forge', version: 1, exportedAt: new Date().toISOString(),
      sel: state.sel, neg: state.neg, custom: state.custom,
      presets: CUSTOM.presets, presetEdit: CUSTOM.presetEdit, presetDel: CUSTOM.presetDel,
      chars: CUSTOM.chars, charEdit: CUSTOM.charEdit, charDel: CUSTOM.charDel,
      history: state.history,
      settings: {
        showZh: state.showZh, escape: state.escape, syntax: state.syntax, randomN: state.randomN, randomNsfw: state.randomNsfw,
        autosave: state.autosave, autoOrder: state.autoOrder, online: state.online,
        forceOnline: state.forceOnline, autoTr: state.autoTr,
        model: state.model, mossMode: state.mossMode, rightSidebarOpen: state.rightSidebarOpen, randCfg: state.randCfg, modelPrefix: state.modelPrefix, presetCat: state.presetCat,
        favTags: state.favTags, recentTags: state.recentTags, favChars: state.favChars
      }
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'prompt-forge-backup.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('已导出 JSON 备份');
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const d = JSON.parse(String(reader.result));
        if (!d || typeof d !== 'object' || (!Array.isArray(d.sel) && !Array.isArray(d.neg) && !Array.isArray(d.custom) && !Array.isArray(d.presets) && !Array.isArray(d.chars) && !d.settings)) {
          const extra = extractTagsFromUnknownContent(String(reader.result || ''));
          if (extra.length) {
            saveUnknownTagsToCustom(extra, 'merge');
            toast(`已将未知文件的 ${extra.length} 个提示词默认存放至「自定义」`);
            return;
          }
        }
        if (Array.isArray(d.sel)) state.sel = d.sel.filter(x => x && x.en).map(fixItem);
        if (Array.isArray(d.neg)) state.neg = d.neg.filter(x => x && x.en).map(fixItem);
        if (Array.isArray(d.custom)) {
          state.custom = d.custom.filter(x => x && x.en).map(x => ({ en: x.en, zh: x.zh || '' }));
          state.custom.forEach(t => { idxAdd(t.en, t.zh); dictAdd(t.zh, t.en); });
          rebuildDictKeys();
        }
        /* 备份里如果带了自定义预设 / 角色，就合并进来（不是覆盖，防止互相冲掉） */
        let mergedPresets = 0;
        let mergedChars = 0;
        if (Array.isArray(d.presets)) {
          d.presets.forEach(u => {
            if (!u || !u.key) return;
            if (CUSTOM.presets.some(x => x.key === u.key)) return;
            CUSTOM.presets.push(u);
            mergedPresets++;
          });
        }
        if (d.presetEdit && typeof d.presetEdit === 'object') {
          Object.keys(d.presetEdit).forEach(k => { CUSTOM.presetEdit[k] = d.presetEdit[k]; });
        }
        if (Array.isArray(d.presetDel)) {
          d.presetDel.forEach(k => { if (CUSTOM.presetDel.indexOf(k) < 0) CUSTOM.presetDel.push(k); });
        }
        if (Array.isArray(d.chars)) {
          d.chars.forEach(u => {
            if (!u || !u.key) return;
            if (CUSTOM.chars.some(x => x.key === u.key)) return;
            CUSTOM.chars.push(u);
            mergedChars++;
          });
        }
        if (d.charEdit && typeof d.charEdit === 'object') {
          Object.keys(d.charEdit).forEach(k => { CUSTOM.charEdit[k] = d.charEdit[k]; });
        }
        if (Array.isArray(d.charDel)) {
          d.charDel.forEach(k => { if (CUSTOM.charDel.indexOf(k) < 0) CUSTOM.charDel.push(k); });
        }
        if (d.settings && typeof d.settings === 'object') {
          const s2 = d.settings;
          ['showZh', 'escape', 'autosave', 'autoOrder', 'online', 'forceOnline', 'autoTr', 'modelPrefix'].forEach(k => {
            if (typeof s2[k] === 'boolean') state[k] = s2[k];
          });
          if (s2.syntax) state.syntax = s2.syntax;
          if (typeof s2.randomN === 'number') state.randomN = clamp(s2.randomN, 2, 20);
          if (s2.model === 'anima' || s2.model === 'moss') state.model = s2.model;
          if (s2.presetCat) state.presetCat = s2.presetCat;
          if (Array.isArray(s2.favTags)) state.favTags = s2.favTags.filter(Boolean).slice(0, 300);
          if (Array.isArray(s2.recentTags)) state.recentTags = s2.recentTags.filter(Boolean).slice(0, 48);
          if (Array.isArray(s2.favChars)) state.favChars = s2.favChars.filter(Boolean).slice(0, 300);
        }
        if (Array.isArray(d.history)) {
          d.history.forEach(h => {
            if (!h || !h.t || !Array.isArray(h.pos)) return;
            if (!state.history.some(x => x.t === h.t)) state.history.push(h);
          });
          state.history = state.history.slice(0, 40);
        }
        const hasCustom = mergedPresets || mergedChars || d.presetEdit || d.charEdit || d.presetDel || d.charDel;
        if (hasCustom) {
          saveCustom();
          state.chars = [];
          stateCharTags = [];
          applyCustom();
          renderAll();
          save();
          toast('导入成功，自定义预设与角色已合并（刷新后全部生效）');
        } else {
          state.chars = [];
          stateCharTags = [];
          renderAll();
          save();
          toast('导入成功');
        }
      } catch (e) {
        toast('文件格式不正确');
      }
    };
    reader.readAsText(file, 'utf-8');
  }

  /* =====================================================================
     8. 事件绑定
     ===================================================================== */

  function syncModeSeg() {
    $$('#modeSeg button').forEach(b => b.classList.toggle('active', b.dataset.mode === state.mode));
  }

  function renderAll() {
    renderNav();
    renderGrid();
    renderSelected();
    renderCharChip();
    renderRandom();
  }

  /* (Req 9) 右侧侧边栏双击提示词自动定位到其所属小分类 */
  function locateTagInCategory(rawEn) {
    const clean = cleanArtistEn(rawEn);
    const k = norm(clean);
    if (!k) return;

    // 1. 优先在标签分类树 (CATS) 中查找所属小分类
    let hitCat = null;
    for (let i = 0; i < CATS.length; i++) {
      const c = CATS[i];
      if (c.tags && c.tags.some(t => norm(t.en) === k)) {
        hitCat = c;
        break;
      }
    }

    if (hitCat) {
      if (hitCat.id === 'moss' && !state.mossMode) {
        state.mossMode = true;
        state.model = 'moss';
        if ($('#chkMossMode')) $('#chkMossMode').checked = true;
      }
      state.q = '';
      if (el.search) el.search.value = '';
      state.cat = hitCat.parentId ? ('major:' + hitCat.parentId) : hitCat.id;
      if (state.expandedSubs.indexOf(hitCat.id) < 0) {
        state.expandedSubs.push(hitCat.id);
      }
      if (!state._subShowLimit) state._subShowLimit = {};
      state._subShowLimit[hitCat.id] = Math.max(state._subShowLimit[hitCat.id] || 0, (hitCat.tags ? hitCat.tags.length : 0) + 50);
      state.highlight = new Set([k]);
      clearTimeout(state._hlTimer);
      state._hlTimer = setTimeout(() => { state.highlight = null; }, 3200);
      renderNav();
      renderGrid();
      requestAnimationFrame(() => {
        const subSec = el.grid.querySelector(`.sub-section[data-sub-sec="${CSS.escape(hitCat.id)}"]`);
        const chips = el.grid.querySelectorAll('.chip[data-en]');
        let targetChip = null;
        for (let i = 0; i < chips.length; i++) {
          if (norm(chips[i].getAttribute('data-en')) === k) {
            targetChip = chips[i];
            break;
          }
        }
        const scrollEl = targetChip || subSec;
        if (scrollEl) {
          scrollEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          scrollEl.classList.add('locate-flash');
        }
        if (subSec) subSec.classList.add('locate-flash');
      });
      toast(`📍 已定位到「${hitCat.parentName ? hitCat.parentName + ' › ' : ''}${hitCat.name}」：${clean}`);
      return;
    }

    // 2. 检查是否为角色本体标签
    const hitChar = CHARS.find(c => norm(c.tag) === k);
    if (hitChar) {
      state.q = '';
      if (el.search) el.search.value = '';
      state.charNavOpen = true;
      const l1 = getCharLevel1Prefix(hitChar);
      if (l1 === 'game') {
        state.cat = 'char:games';
        const gameSub = getGameSubSections().find(g => g.chars.some(x => x.key === hitChar.key));
        if (gameSub && state.expandedSubs.indexOf(gameSub.secId) < 0) {
          state.expandedSubs.push(gameSub.secId);
        }
      } else if (l1 === 'vtuber') {
        state.cat = 'char:vtuber';
      } else {
        state.cat = 'char:anime';
      }
      state.highlight = new Set([k]);
      clearTimeout(state._hlTimer);
      state._hlTimer = setTimeout(() => { state.highlight = null; }, 3200);
      renderNav();
      renderGrid();
      requestAnimationFrame(() => {
        const card = el.grid.querySelector(`.char-big-card[data-char="${CSS.escape(hitChar.key)}"]`);
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          card.classList.add('locate-flash');
        }
      });
      toast(`📍 已定位到角色「${hitChar.name} (${hitChar.game})」`);
      return;
    }

    // 3. 检查是否在自定义分类中
    if (state.custom.some(t => norm(t.en) === k)) {
      state.q = '';
      if (el.search) el.search.value = '';
      state.cat = 'custom';
      state.highlight = new Set([k]);
      clearTimeout(state._hlTimer);
      state._hlTimer = setTimeout(() => { state.highlight = null; }, 3200);
      renderNav();
      renderGrid();
      requestAnimationFrame(() => {
        const chips = el.grid.querySelectorAll('.chip[data-en]');
        for (let i = 0; i < chips.length; i++) {
          if (norm(chips[i].getAttribute('data-en')) === k) {
            chips[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
            chips[i].classList.add('locate-flash');
            break;
          }
        }
      });
      toast(`📍 已定位到「⭐ 自定义」：${clean}`);
      return;
    }

    toast(`未在分类库中找到「${clean}」所属小分类`);
  }

  function bind() {
    /* 右键菜单：提示词芯片右键、角色大图标右键 & 小分类头部右键 (Req 3 & Req 8) */
    let _charHoverSeenTimer = null;
    el.grid.addEventListener('mouseover', e => {
      const card = e.target && e.target.closest ? e.target.closest('.char-big-card[data-char]') : null;
      if (!card || !card.querySelector('.char-new-dot')) return;
      const ck = card.getAttribute('data-char');
      if (!ck) return;
      if (_charHoverSeenTimer) clearTimeout(_charHoverSeenTimer);
      _charHoverSeenTimer = setTimeout(() => { markCharAsSeen(ck); }, 300);
    });
    el.grid.addEventListener('mouseout', e => {
      const card = e.target && e.target.closest ? e.target.closest('.char-big-card[data-char]') : null;
      if (card && _charHoverSeenTimer) { clearTimeout(_charHoverSeenTimer); _charHoverSeenTimer = null; }
    });

    el.grid.addEventListener('contextmenu', e => {
      const pill = e.target.closest('.cbc-prompt-pill[data-en]');
      if (pill && pill.dataset.en) {
        e.preventDefault();
        e.stopPropagation();
        clearCtxHighlight();
        pill.classList.add('ctx-active');
        openTagContextMenu(e.clientX, e.clientY, pill.dataset.en, tagCatOf(pill.dataset.en), '');
        return;
      }
      const charCard = e.target.closest('.char-big-card[data-char]');
      if (charCard) {
        e.preventDefault();
        e.stopPropagation();
        clearCtxHighlight();
        charCard.classList.add('ctx-active');
        openCharContextMenu(e.clientX, e.clientY, charCard.getAttribute('data-char'));
        return;
      }
      const chip = e.target.closest('.chip');
      if (chip && chip.dataset.en) {
        e.preventDefault();
        e.stopPropagation();
        clearCtxHighlight();
        chip.classList.add('ctx-active');
        openTagContextMenu(e.clientX, e.clientY, chip.dataset.en, chip.dataset.sub || tagCatOf(chip.dataset.en), chip.getAttribute('data-list-mode') || '');
        return;
      }
      const subHead = e.target.closest('.sub-sec-head[data-toggle-sub]');
      if (subHead) {
        e.preventDefault();
        e.stopPropagation();
        clearCtxHighlight();
        subHead.classList.add('ctx-active');
        openSubContextMenu(e.clientX, e.clientY, subHead.getAttribute('data-toggle-sub'));
        return;
      }
    });

    /* (Req 3) 左侧大分类导航右键菜单与右键视觉反馈 */
    el.catNav.addEventListener('contextmenu', e => {
      const majorBtn = e.target.closest('.cat-item[data-major]');
      if (majorBtn) {
        e.preventDefault();
        e.stopPropagation();
        clearCtxHighlight();
        majorBtn.classList.add('ctx-active');
        openMajorContextMenu(e.clientX, e.clientY, majorBtn.getAttribute('data-major'));
        return;
      }
      const favOrRecBtn = e.target.closest('.cat-item[data-cat="fav"], .cat-item[data-cat="char:fav"], .cat-item[data-cat="recent"], .cat-item[data-cat="char:recent"]');
      if (favOrRecBtn) {
        e.preventDefault();
        e.stopPropagation();
        clearCtxHighlight();
        favOrRecBtn.classList.add('ctx-active');
        const cType = favOrRecBtn.getAttribute('data-cat').indexOf('fav') >= 0 ? 'fav' : 'recent';
        openFavRecentContextMenu(e.clientX, e.clientY, cType);
        return;
      }
    });

    /* 分类导航左键点击（含正向提示词折叠与手机端抽屉自动收起） */
    el.catNav.addEventListener('click', e => {
      if (e.target.closest('#inlineMajorInput')) return;
      const posToggle = e.target.closest('[data-toggle-pos-nav]');
      if (posToggle) {
        e.stopPropagation();
        state.posNavOpen = !state.posNavOpen;
        renderNav();
        save();
        return;
      }
      const negToggle = e.target.closest('[data-toggle-neg-nav]');
      if (negToggle) {
        e.stopPropagation();
        state.negNavOpen = !state.negNavOpen;
        const negM = findTreeMajor('negative');
        if (negM) {
          state.cat = 'major:negative';
          renderGrid();
        }
        renderNav();
        save();
        return;
      }
      const nsfwToggle = e.target.closest('[data-toggle-nsfw-nav]');
      if (nsfwToggle) {
        e.stopPropagation();
        state.nsfwNavOpen = !state.nsfwNavOpen;
        state.cat = 'nsfw_all';
        renderNav();
        renderGrid();
        save();
        return;
      }
      const nsfwMajorBtn = e.target.closest('[data-nsfw-major]');
      if (nsfwMajorBtn) {
        e.stopPropagation();
        const mid = nsfwMajorBtn.getAttribute('data-nsfw-major');
        state.cat = 'nsfw_major:' + mid;
        state.q = '';
        el.search.value = '';
        document.body.classList.remove('mobile-nav-open');
        renderNav();
        renderGrid();
        save();
        return;
      }
      const nsfwSubBtn = e.target.closest('[data-nsfw-sub]');
      if (nsfwSubBtn) {
        e.stopPropagation();
        const sid = nsfwSubBtn.getAttribute('data-nsfw-sub');
        state.cat = 'nsfw_sub:' + sid;
        const expKey = 'nsfw_map_' + sid;
        if ((state.expandedSubs || []).indexOf(expKey) < 0) {
          state.expandedSubs = state.expandedSubs || [];
          state.expandedSubs.push(expKey);
        }
        renderNav();
        renderGrid();
        save();
        return;
      }
      const custToggle = e.target.closest('[data-toggle-custom-nav]');
      if (custToggle) {
        e.stopPropagation();
        if (state.cat === 'custom') {
          state.customNavOpen = !(state.customNavOpen !== false);
        } else {
          state.cat = 'custom';
          state.customNavOpen = true;
        }
        state.q = '';
        el.search.value = '';
        renderNav();
        renderGrid();
        save();
        return;
      }
      const charToggle = e.target.closest('[data-toggle-char-nav]');
      if (charToggle) {
        e.stopPropagation();
        state.charNavOpen = !state.charNavOpen;
        renderNav();
        save();
        return;
      }
      const addMajorBtn = e.target.closest('#btnQuickAddMajor');
      if (addMajorBtn) {
        e.stopPropagation();
        quickCreateMajorInline();
        return;
      }
      const addNegSubBtn = e.target.closest('#btnQuickAddNegSub');
      if (addNegSubBtn) {
        e.stopPropagation();
        quickCreateSubInline('negative');
        return;
      }
      const addCustSubBtn = e.target.closest('#btnQuickAddCustomSub');
      if (addCustSubBtn) {
        e.stopPropagation();
        createNewCustomTagCategory();
        return;
      }
      const majorBtn = e.target.closest('[data-major]');
      if (majorBtn) {
        const mid = majorBtn.getAttribute('data-major');
        state.cat = 'major:' + mid;
        state.q = '';
        el.search.value = '';
        document.body.classList.remove('mobile-nav-open');
        renderNav();
        renderGrid();
        return;
      }
      const b = e.target.closest('.cat-item');
      if (!b || !b.dataset.cat) return;
      state.cat = b.dataset.cat;
      state.q = '';
      el.search.value = '';
      document.body.classList.remove('mobile-nav-open');
      renderNav();
      renderGrid();
    });

    /* 中间内容区点击（含子分类单独清除、最近 tag 删除小按钮、角色大图标上传、角色套用、小分类展开收起） */
    el.grid.addEventListener('click', e => {
      if (e.target.closest('#inlineSubInput')) return;
      const loadMoreBtn = e.target.closest('[data-sub-load-more]');
      if (loadMoreBtn) {
        e.preventDefault();
        e.stopPropagation();
        const sid = loadMoreBtn.getAttribute('data-sub-load-more') || '';
        if (!state._subShowLimit) state._subShowLimit = {};
        state._subShowLimit[sid] = (state._subShowLimit[sid] || SUB_RENDER_PAGE_SIZE) + 400;
        const secEl = loadMoreBtn.closest('.sub-section');
        const bodyEl = secEl && secEl.querySelector('.sub-sec-body');
        const isNsfwMappedView = (state.cat === 'nsfw_all' || String(state.cat).indexOf('nsfw_major:') === 0 || String(state.cat).indexOf('nsfw_sub:') === 0);
        const cObj = isNsfwMappedView
          ? getMappedNsfwSubcategories().find(x => x.id === sid)
          : visibleCats().find(x => x.id === sid);
        if (bodyEl && cObj) {
          bodyEl.innerHTML = renderSubTagsWithPagination(cObj.tags || [], cObj.id, false) + `<button type="button" class="chip chip-add" data-sub-add-tag="${esc(cObj.id)}" title="在此小分类末尾新增单个提示词（同步写入原属小分类）">＋ 新增</button>`;
        } else {
          renderGrid();
        }
        return;
      }
      const artRecChip = e.target.closest('.artist-rec-chip[data-en]');
      if (artRecChip) {
        e.preventDefault();
        e.stopPropagation();
        const en = artRecChip.getAttribute('data-en');
        if (en) {
          toggleTag(en, e.altKey, 'artist');
          renderSelected();
          artRecChip.classList.toggle('on');
          save();
        }
        return;
      }
      const clearSubSecBtn = e.target.closest('[data-clear-sub-sec]');
      if (clearSubSecBtn) {
        e.preventDefault();
        e.stopPropagation();
        clearFavOrRecentSub(clearSubSecBtn.getAttribute('data-clear-sub-sec'));
        return;
      }
      const delRecentTagBtn = e.target.closest('[data-del-recent-tag]');
      if (delRecentTagBtn) {
        e.preventDefault();
        e.stopPropagation();
        removeTagFromFavOrRecent('recent', delRecentTagBtn.getAttribute('data-del-recent-tag'));
        return;
      }
      const delCharRecentBtn = e.target.closest('[data-del-char-recent]');
      if (delCharRecentBtn) {
        e.preventDefault();
        e.stopPropagation();
        removeCharFromFavOrRecent('recent_char', delCharRecentBtn.getAttribute('data-del-char-recent'));
        return;
      }
      const delCharFavBtn = e.target.closest('[data-del-char-fav]');
      if (delCharFavBtn) {
        e.preventDefault();
        e.stopPropagation();
        removeCharFromFavOrRecent('fav_char', delCharFavBtn.getAttribute('data-del-char-fav'));
        return;
      }
      const uploadBtn = e.target.closest('[data-char-upload]');
      if (uploadBtn) {
        e.stopPropagation();
        _uploadingCharKey = uploadBtn.getAttribute('data-char-upload') || '';
        const inp = $('#charImgUploadInput');
        if (inp) { inp.value = ''; inp.click(); }
        return;
      }
      const charActBtn = e.target.closest('[data-char-act]');
      if (charActBtn) {
        e.stopPropagation();
        const act = charActBtn.getAttribute('data-char-act');
        if (act === 'new') {
          openModal('modalChar');
          openCharEditor(null);
        } else if (act === 'random') {
          const pool = CHARS.filter(c => !state.chars.some(x => x.key === c.key));
          if (!pool.length) { toast('角色库都套用过了'); return; }
          const pick = pool[Math.floor(Math.random() * pool.length)];
          applyCharacter(pick.key);
        }
        return;
      }
      const charCard = e.target.closest('.char-big-card[data-char]');
      if (charCard) {
        markCharAsSeen(charCard.getAttribute('data-char'));
        applyCharacter(charCard.getAttribute('data-char'));
        return;
      }
      const toggleSub = e.target.closest('[data-toggle-sub]');
      if (toggleSub) {
        const sid = toggleSub.getAttribute('data-toggle-sub');
        const secEl = toggleSub.closest('.sub-section');
        const gridRect = el.grid.getBoundingClientRect();
        const headRectBefore = toggleSub.getBoundingClientRect();
        const offsetFromGridTop = headRectBefore.top - gridRect.top;
        const idx = state.expandedSubs.indexOf(sid);
        if (idx >= 0) {
          state.expandedSubs.splice(idx, 1);
          if (secEl) {
            const secRect = secEl.getBoundingClientRect();
            secEl.classList.remove('expanded');
            // 若该小分类此前处于吸顶滚动状态，收起后将滚动条对齐回该小分类标题处，防止页面瞬移跳空
            if (secRect.top < gridRect.top) {
              el.grid.scrollTop = Math.max(0, secEl.offsetTop - 10);
            } else {
              const headRectAfter = toggleSub.getBoundingClientRect();
              el.grid.scrollTop += (headRectAfter.top - headRectBefore.top);
            }
            syncToggleAllSubsBtn();
            return;
          }
        } else {
          state.expandedSubs.push(sid);
          // 若是常规提示词小分类或自定义小分类，直接在当前节点内就地插入 .sub-sec-body，不重建整页 DOM，彻底消除展开瞬移
          if (secEl && !secEl.querySelector('.sub-sec-body')) {
            const rawSubId = secEl.getAttribute('data-sub-sec') || '';
            const custId = secEl.getAttribute('data-cust-tag-cat') || '';
            let bodyHtml = '';
            if (custId) {
              const tc = (state.customTagCats || []).find(x => x.id === custId);
              if (tc) {
                bodyHtml = '<div class="sub-sec-body">';
                (tc.tags || []).forEach(t => {
                  if (state.showNsfw === false && isNsfwTag(t.en, tc.id, t)) return;
                  bodyHtml += chipHTML(t, { custom: true, subId: tc.id });
                });
                bodyHtml += `<button type="button" class="chip chip-add" data-sub-add-tag="${esc(tc.id)}" title="在此小分类末尾新增提示词">＋ 新增</button></div>`;
              }
            } else if (rawSubId) {
              const isNsfwMappedView = (state.cat === 'nsfw_all' || String(state.cat).indexOf('nsfw_major:') === 0 || String(state.cat).indexOf('nsfw_sub:') === 0);
              const cObj = isNsfwMappedView
                ? getMappedNsfwSubcategories().find(x => x.id === rawSubId)
                : visibleCats().find(x => x.id === rawSubId);
              if (cObj) {
                bodyHtml = '<div class="sub-sec-body">' + renderSubTagsWithPagination(cObj.tags || [], cObj.id, false) + `<button type="button" class="chip chip-add" data-sub-add-tag="${esc(cObj.id)}" title="在此小分类末尾新增单个提示词（同步写入原属小分类）">＋ 新增</button></div>`;
              }
            }
            if (bodyHtml) {
              secEl.insertAdjacentHTML('beforeend', bodyHtml);
              secEl.classList.add('expanded');
              const headRectAfter = toggleSub.getBoundingClientRect();
              el.grid.scrollTop += (headRectAfter.top - (gridRect.top + offsetFromGridTop));
              // 若展开的小分类位于视口偏下方，自动微调滚动使其展开的标签内容直接呈现在眼前
              const updatedHeadRect = toggleSub.getBoundingClientRect();
              if (updatedHeadRect.bottom > gridRect.bottom - 90) {
                el.grid.scrollBy({ top: Math.min(200, updatedHeadRect.top - gridRect.top - 16), behavior: 'smooth' });
              }
              syncToggleAllSubsBtn();
              return;
            }
          } else if (secEl && secEl.querySelector('.sub-sec-body')) {
            secEl.classList.add('expanded');
            const headRectAfter = toggleSub.getBoundingClientRect();
            el.grid.scrollTop += (headRectAfter.top - (gridRect.top + offsetFromGridTop));
            syncToggleAllSubsBtn();
            return;
          }
        }
        renderGrid();
        const newToggle = el.grid.querySelector(`.sub-sec-head[data-toggle-sub="${CSS.escape ? CSS.escape(sid) : sid}"]`);
        if (newToggle) {
          const newRect = newToggle.getBoundingClientRect();
          el.grid.scrollTop += (newRect.top - (gridRect.top + offsetFromGridTop));
        }
        return;
      }
      const addSubBottom = e.target.closest('#btnAddSubBottom');
      if (addSubBottom) {
        e.stopPropagation();
        quickCreateSubInline(addSubBottom.getAttribute('data-parent-mid'));
        return;
      }
      const subAddTagBtn = e.target.closest('[data-sub-add-tag]');
      if (subAddTagBtn) {
        e.stopPropagation();
        openMiniAddTag(subAddTagBtn.getAttribute('data-sub-add-tag'));
        return;
      }
      if (window._justMarqueeEnded) {
        window._justMarqueeEnded = false;
        return;
      }
      const chip = e.target.closest('.chip');
      if (!chip) {
        // 电脑文件夹操作：在空白区域单击（未按 Ctrl/Shift）自动清空当前批量选中项
        if (!e.ctrlKey && !e.metaKey && !e.shiftKey && state.batchSelectedMap && state.batchSelectedMap.size > 0) {
          if (!e.target.closest('.sub-sec-head, .char-big-card, .content-foot-bar, button, input, select, textarea')) {
            state.batchSelectedMap.clear();
            el.grid.querySelectorAll('.chip.batch-sel').forEach(c => c.classList.remove('batch-sel'));
            syncBatchSelectBarUI();
          }
        }
        return;
      }
      if (chip.dataset.char) { applyCharacter(chip.dataset.char); return; }
      const en = chip.dataset.en;
      if (!en) return;
      const isCtrl = !!(e.ctrlKey || e.metaKey);
      const isShift = !!e.shiftKey;
      // 电脑文件夹式操作：按住 Ctrl/Cmd 点击或按住 Shift 点击直接进入多选/区间连选模式
      if (state.batchSelectMode || isCtrl || isShift) {
        e.preventDefault();
        e.stopPropagation();
        if (!state.batchSelectMode) {
          state.batchSelectMode = true;
          // 若此前曾普通点击过某个锚点标签且当前是首次 Shift 连选或 Ctrl 加选，自动将锚点纳入初始选择
          if (state.batchAnchorKey && state.batchSelectedMap.size === 0 && isShift) {
            const anchorChip = Array.from(el.grid.querySelectorAll('.chip[data-en]')).find(
              c => norm(cleanArtistEn(c.dataset.en || '')) === state.batchAnchorKey
            );
            if (anchorChip) {
              const aEn = cleanArtistEn(anchorChip.dataset.en || '');
              state.batchSelectedMap.set(state.batchAnchorKey, {
                en: aEn,
                subId: anchorChip.dataset.sub || tagCatOf(aEn) || ''
              });
              anchorChip.classList.add('batch-sel');
            }
          }
        }
        handleBatchChipClick(chip, isShift, isCtrl);
        return;
      }
      // 普通左键点击：记录文件夹式锚点（方便后续直接 Shift+点击连选），并切换右侧已选状态（Alt+点击可赋 1.2 权重）
      const cleanK = norm(cleanArtistEn(en));
      if (cleanK) {
        state.batchAnchorKey = cleanK;
        state.batchLastClickedKey = cleanK;
      }
      toggleTag(en, e.altKey, chip.dataset.sub);
      renderSelected();
      chip.classList.toggle('on');
      save();
    });

    /* (V1.2.5 Req 1) 鼠标触碰带右上角新增小点的标签时自动消除小点 */
    el.grid.addEventListener('mouseover', e => {
      const chip = e.target.closest('.chip[data-is-new="1"]');
      if (chip && chip.dataset.en) {
        dismissNewTagBadge(chip.dataset.en, chip);
      }
    });

    /* 支持直接将图片拖拽到角色大图标卡片上上传并存入 img/ (Req 8) */
    el.grid.addEventListener('dragover', e => {
      if (window._internalDragging || _dragNodeType) return;
      const charCard = e.target.closest('.char-big-card[data-char]');
      if (charCard && e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0) {
        e.preventDefault();
        e.stopPropagation();
        charCard.classList.add('ctx-active');
      }
    });
    el.grid.addEventListener('dragleave', e => {
      const charCard = e.target.closest('.char-big-card[data-char]');
      if (charCard) charCard.classList.remove('ctx-active');
    });
    el.grid.addEventListener('drop', e => {
      if (window._internalDragging || _dragNodeType) return;
      const charCard = e.target.closest('.char-big-card[data-char]');
      if (!charCard) return;
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length && /^image\//i.test(files[0].type || '')) {
        e.preventDefault();
        e.stopPropagation();
        document.body.classList.remove('dragging-file');
        charCard.classList.remove('ctx-active');
        handleCharImgUpload(charCard.getAttribute('data-char'), files[0]);
      }
    });

    const charImgInp = $('#charImgUploadInput');
    if (charImgInp) {
      charImgInp.addEventListener('change', () => {
        const f = charImgInp.files && charImgInp.files[0];
        if (f && _uploadingCharKey) {
          handleCharImgUpload(_uploadingCharKey, f);
        }
        charImgInp.value = '';
      });
    }

    /* 已选列表操作（含 2.6 Req 3 角色整体单击展开/收起、角色整体上锁/删除、子标签操作） */
    el.selList.addEventListener('click', e => {
      const charActBtn = e.target.closest('button[data-char-act-row]');
      if (charActBtn) {
        e.stopPropagation();
        const act = charActBtn.getAttribute('data-char-act-row');
        const ckey = charActBtn.getAttribute('data-ckey');
        const ch = (state.chars || []).find(x => x.key === ckey);
        if (!ch) return;
        if (act === 'lock') {
          recordHistorySnapshot(`${ch.locked ? '取消上锁' : '上锁'}角色: ${ch.name}`);
          ch.locked = !ch.locked;
          const cKeySet = new Set((ch.tags || []).map(k => norm(k)));
          state.sel.forEach(it => {
            if (it.fromCharKey === ch.key || cKeySet.has(it.key)) {
              it.locked = ch.locked;
            }
          });
          renderSelected();
          save();
        } else if (act === 'del') {
          removeCharacter(ckey);
        }
        return;
      }
      const charHead = e.target.closest('[data-char-toggle]');
      if (charHead && !e.target.closest('button')) {
        const ckey = charHead.getAttribute('data-char-toggle');
        const ch = (state.chars || []).find(x => x.key === ckey);
        if (ch) {
          ch.expanded = !ch.expanded;
          renderSelected();
          save();
        }
        return;
      }
      const btn = e.target.closest('button[data-act]');
      if (!btn) {
        const rowHit = e.target.closest('.sel-item[data-key]');
        if (rowHit && !e.target.closest('button, .sel-grip')) {
          const rk = rowHit.dataset.key;
          const rlist = currentList();
          const ri = rlist.findIndex(x => x.key === rk);
          if (ri >= 0) {
            recordHistorySnapshot((rlist[ri].disabled ? '重新启用标签: ' : '临时禁用标签: ') + rlist[ri].en);
            rlist[ri].disabled = !rlist[ri].disabled;
            renderSelected();
            save();
          }
        }
        return;
      }
      const row = btn.closest('.sel-item');
      if (!row) return;
      const key = row.dataset.key;
      const list = currentList();
      const i = list.findIndex(x => x.key === key);
      if (i < 0) return;
      const act = btn.dataset.act;
      if (act === 'del') {
        const targetItem = list[i];
        recordHistorySnapshot(`移除已选: ${targetItem.en}`);
        list.splice(i, 1);
        const parentCharKey = row.getAttribute('data-parent-char') || targetItem.fromCharKey;
        if (parentCharKey) {
          const ch = (state.chars || []).find(x => x.key === parentCharKey);
          if (ch && Array.isArray(ch.tags)) {
            ch.tags = ch.tags.filter(tk => norm(tk) !== key);
            if (!ch.tags.length) {
              state.chars = state.chars.filter(x => x.key !== parentCharKey);
            }
          }
          syncCharTags();
        }
        renderSelected();
        renderGrid();
        save();
        return;
      }
      else if (act === 'lock') {
        recordHistorySnapshot(`${list[i].locked ? '取消固定' : '固定'}标签: ${list[i].en}`);
        list[i].locked = !list[i].locked;
      }
      else if (act === 'inc') {
        recordHistorySnapshot(`增加权重: ${list[i].en}`);
        list[i].w = clamp(Number(((list[i].w || 1) + 0.05).toFixed(2)), 0.1, 2);
      }
      else if (act === 'dec') {
        recordHistorySnapshot(`减小权重: ${list[i].en}`);
        list[i].w = clamp(Number(((list[i].w || 1) - 0.05).toFixed(2)), 0.1, 2);
      }
      renderSelected();
      renderGrid();
      save();
    });

    /* V1.3.8 Req 4: 仅当鼠标位于右侧四个按钮（- + 锁 ×）左侧的调权热区（约 68px 宽，含权重数字区域）时，滚轮才调整权重；其余区域正常上下滚动列表 */
    let _wheelUndoStamp = 0;
    let _wheelUndoKey = '';
    el.selList.addEventListener('wheel', e => {
      const row = e.target && e.target.closest ? e.target.closest('.sel-item[data-key]') : null;
      if (!row) return;
      const firstRightBtn = row.querySelector('button[data-act="dec"]') || row.querySelector('button[data-act]');
      if (!firstRightBtn) return;
      const btnRect = firstRightBtn.getBoundingClientRect();
      const inWeightZone = Boolean(
        (e.target && e.target.closest && e.target.closest('.sel-w')) ||
        (e.clientX >= btnRect.left - 68 && e.clientX <= btnRect.left + 4)
      );
      if (!inWeightZone) return;
      const key = row.dataset.key;
      const list = currentList();
      const idx = list.findIndex(x => x.key === key);
      if (idx < 0) return;
      e.preventDefault();
      const step = e.shiftKey ? 0.1 : 0.05;
      const delta = e.deltaY < 0 ? step : -step;
      const prevW = Number(list[idx].w || 1);
      const nextW = clamp(Number((prevW + delta).toFixed(2)), 0.1, 2);
      if (nextW === prevW) return;
      const now = Date.now();
      if (_wheelUndoKey !== key || now - _wheelUndoStamp > 650) {
        recordHistorySnapshot(`滚轮调整权重: ${list[idx].en}`);
      }
      _wheelUndoStamp = now;
      _wheelUndoKey = key;
      list[idx].w = nextW;
      renderSelected();
      save();
    }, { passive: false });

    /* 右侧侧边栏标签支持右键菜单（含复制英文） */
    el.selList.addEventListener('contextmenu', e => {
      const row = e.target.closest('.sel-item[data-key]');
      if (!row) return;
      const item = currentList().find(x => x.key === row.dataset.key);
      if (!item || !item.en) return;
      e.preventDefault();
      e.stopPropagation();
      clearCtxHighlight();
      row.classList.add('ctx-active');
      openTagContextMenu(e.clientX, e.clientY, item.en, tagCatOf(item.en), '');
    });

    /* (Req 9) 在右侧侧边栏双击某个提示词自动定位到其所属小分类 */
    el.selList.addEventListener('dblclick', e => {
      if (e.target.closest('button[data-act]')) return;
      const row = e.target.closest('.sel-item[data-key]');
      if (!row) return;
      const key = row.dataset.key;
      const item = currentList().find(x => x.key === key);
      if (item && item.en) {
        locateTagInCategory(item.en);
      }
    });

    /* (Req 6) 右侧侧边栏标签拖动排序；拖动后自动取消语义排序 */
    let _selDragKey = '';
    el.selList.addEventListener('dragstart', e => {
      const row = e.target.closest('.sel-item[data-key]');
      if (!row) return;
      _selDragKey = row.dataset.key;
      row.classList.add('dragging-node');
      window._internalDragging = true;
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', _selDragKey); } catch (err) {}
      }
    });
    el.selList.addEventListener('dragover', e => {
      if (!_selDragKey) return;
      const over = e.target.closest('.sel-item[data-key]');
      if (!over) return;
      e.preventDefault();
      const rect = over.getBoundingClientRect();
      const after = (e.clientY - rect.top) > rect.height / 2;
      $$('.sel-item', el.selList).forEach(n => n.classList.remove('drag-over-top', 'drag-over-bottom'));
      over.classList.add(after ? 'drag-over-bottom' : 'drag-over-top');
    });
    el.selList.addEventListener('dragleave', e => {
      const over = e.target.closest('.sel-item[data-key]');
      if (over) over.classList.remove('drag-over-top', 'drag-over-bottom');
    });
    el.selList.addEventListener('drop', e => {
      if (!_selDragKey) return;
      e.preventDefault();
      e.stopPropagation();
      const over = e.target.closest('.sel-item[data-key]');
      $$('.sel-item', el.selList).forEach(n => n.classList.remove('drag-over-top', 'drag-over-bottom', 'dragging-node'));
      if (over && over.dataset.key && over.dataset.key !== _selDragKey) {
        const r = over.getBoundingClientRect();
        const after = (e.clientY - r.top) > r.height / 2;
        recordHistorySnapshot('拖动调整已选标签排序');
        reorderSelItem(_selDragKey, over.dataset.key, after);
        renderSelected();
        renderGrid();
        save();
      }
      _selDragKey = '';
      window._internalDragging = false;
    });
    el.selList.addEventListener('dragend', () => {
      _selDragKey = '';
      window._internalDragging = false;
      $$('.sel-item', el.selList).forEach(n => n.classList.remove('drag-over-top', 'drag-over-bottom', 'dragging-node'));
    });

    /* 正向 / 负面切换 */
    $('#modeSeg').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      state.mode = b.dataset.mode;
      syncModeSeg();
      renderSelected();
      renderGrid();
    });

    /* (Req 5 & Req 6) 右侧侧边栏清空按钮取消二次验证，直接清空并支持撤回 */
    $('#btnClear').addEventListener('click', () => {
      const list = currentList();
      if (!list.length) {
        toast(`当前${state.mode === 'pos' ? '正向' : '负面'}列表已经是空的`);
        return;
      }
      recordHistorySnapshot(`清空${state.mode === 'pos' ? '正向' : '负面'}列表 (${list.length} 项)`);
      if (state.mode === 'pos') {
        const lockedChars = (state.chars || []).filter(c => c.locked);
        const lockedCharTagSet = new Set();
        lockedChars.forEach(c => (c.tags || []).forEach(t => lockedCharTagSet.add(norm(t))));
        const kept = list.filter(it => it.locked || lockedCharTagSet.has(it.key) || (it.fromCharKey && lockedChars.some(c => c.key === it.fromCharKey)));
        list.length = 0;
        kept.forEach(it => list.push(it));
        state.chars = lockedChars;
        syncCharTags();
      } else {
        const kept = list.filter(it => it.locked);
        list.length = 0;
        kept.forEach(it => list.push(it));
      }
      renderAll();
      save();
      toast('已清空当前列表（可按 Ctrl+Z 撤回）');
    });

    /* 搜索（V1.3.1 Fix Bug 6：完整支持单字输入、中文输入法 IME 合成事件与即时清空） */
    let st = null;
    let isComposingSearch = false;
    const triggerSearchUpdate = (immediate) => {
      clearTimeout(st);
      const run = () => {
        state.q = el.search.value;
        renderGrid();
      };
      if (immediate) run();
      else st = setTimeout(run, 100);
    };
    el.search.addEventListener('compositionstart', () => {
      isComposingSearch = true;
    });
    el.search.addEventListener('compositionend', () => {
      isComposingSearch = false;
      triggerSearchUpdate(true);
    });
    el.search.addEventListener('input', () => {
      if (isComposingSearch) return;
      triggerSearchUpdate(false);
    });
    el.search.addEventListener('search', () => {
      isComposingSearch = false;
      triggerSearchUpdate(true);
    });
    el.search.addEventListener('change', () => {
      if (!isComposingSearch && state.q !== el.search.value) {
        triggerSearchUpdate(true);
      }
    });

    /* 输出控制 */
    if ($('#chkMossMode')) {
      $('#chkMossMode').addEventListener('change', e => {
        toggleRightMossMode(e.target.checked);
      });
    }
    $('#chkZh').addEventListener('change', e => {
      state.showZh = e.target.checked;
      renderGrid();
      renderSelected();
      renderRandom();
      save();
    });
    if ($('#chkShowNsfw')) {
      $('#chkShowNsfw').addEventListener('change', e => {
        state.showNsfw = !!e.target.checked;
        renderGrid();
        save();
      });
    }

    $('#btnCopy').addEventListener('click', () => { pushHistory(); copyText(el.output.value); });

    /* 顶部按钮 */
    /* #btnChar 已移至左侧 #catNav 全部下方并通过 data-toggle-char-nav 展开二级分类 (Req 8) */
    $('#btnPreset').addEventListener('click', () => { renderPresetModal(); openModal('modalPreset'); });
    const btnPresetImp = $('#btnPresetImport');
    if (btnPresetImp) {
      btnPresetImp.addEventListener('click', () => {
        const fi = $('#fileImportPreset');
        if (!fi) return;
        fi.value = '';
        fi.onchange = async ev => {
          const file = ev.target.files && ev.target.files[0];
          if (!file) return;
          try {
            const parsed = JSON.parse(await file.text());
            const listIn = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.presets) ? parsed.presets : [parsed]);
            let added = 0;
            listIn.forEach(raw => {
              if (!raw || typeof raw !== 'object' || !raw.name) return;
              const key = raw.key || raw.id || ('u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5));
              const tags = Array.isArray(raw.tags)
                ? raw.tags.map(t => (typeof t === 'string' ? parsePair(t) : { en: t.en || '', zh: t.zh || '' })).filter(t => t.en)
                : parseTagText(String(raw.tags || '').replace(/;/g, '\n'));
              if (!tags.length) return;
              const cat = raw.cat || '场景';
              const desc = raw.desc || '';
              const ex = PRESETS.find(x => x.key === key);
              if (ex) { ex.name = raw.name; ex.desc = desc; ex.cat = cat; ex.tags = tags; ex.custom = true; }
              else PRESETS.push({ key, name: raw.name, desc, cat, tags, custom: true });
              const cIdx = CUSTOM.presets.findIndex(x => x.key === key);
              const cObj = { key, name: raw.name, desc, tags: tagText(tags), cat };
              if (cIdx >= 0) CUSTOM.presets[cIdx] = cObj; else CUSTOM.presets.push(cObj);
              persistLibraryItemToFolder('presets', { key, id: key, name: raw.name, desc, cat, tags: tags.map(t => (t.zh ? t.en + '|' + t.zh : t.en)).join(';'), custom: true });
              added++;
            });
            if (added > 0) {
              saveCustom();
              renderPresetModal();
              toast('📥 成功导入 ' + added + ' 个预设并保存至 libraries/presets/');
            } else {
              toast('未检测到有效的预设 JSON');
            }
          } catch (err) {
            toast('导入失败：预设 JSON 格式无效');
          }
        };
        fi.click();
      });
    }
    $('#btnSaves').addEventListener('click', () => { renderSaves(); openModal('modalSaves'); });
    if ($('#btnAdd')) $('#btnAdd').addEventListener('click', () => {
      $('#addInput').value = '';
      $('#addResult').value = '';
      $('#addPreview').innerHTML = '';
      if ($('#addTransStat')) $('#addTransStat').textContent = '';
      openModal('modalAdd');
      $('#addInput').focus();
    });
    $('#btnRandom').addEventListener('click', () => {
      openModal('modalRandom');
      generateRandom();
    });
    $('#btnAI').addEventListener('click', () => {
      $('#aiBase').value = aiCfg.base || '';
      $('#aiModel').value = aiCfg.model;
      $('#aiKey').value = aiCfg.key;
      const vEl = $('#aiVision');
      if (vEl) vEl.value = aiCfg.visionModel || '';
      const chk = $('#aiOnline');
      if (chk) chk.checked = aiCfg.online !== false;
      renderUsage();
      renderAiLog();
      openModal('modalAI');
      $('#aiMsg').focus();
    });
    $('#btnAiSave').addEventListener('click', () => {
      aiCfg.base = (($('#aiBase').value || '').trim()).replace(/\/+$/, '');
      aiCfg.model = ($('#aiModel').value || 'deepseek-chat').trim();
      aiCfg.key = $('#aiKey').value.trim();
      const vEl2 = $('#aiVision');
      aiCfg.visionModel = vEl2 ? vEl2.value.trim() : '';
      saveAiCfg();
      toast('接口设置已保存' + (aiIsServer() ? '（本地服务模式）' : '（浏览器直连模式）'));
    });
    const btnAiTest = $('#btnAiTest');
    if (btnAiTest) btnAiTest.addEventListener('click', aiTest);
    const aiOnline = $('#aiOnline');
    if (aiOnline) {
      aiOnline.checked = aiCfg.online !== false;
      aiOnline.addEventListener('change', () => {
        aiCfg.online = !!aiOnline.checked;
        saveAiCfg();
        toast(aiCfg.online ? '联网查证：开（点名角色会上网核对）' : '快速模式：关（不联网，直接选词）');
      });
    }
    $('#btnAiClear').addEventListener('click', () => {
      aiMsgs = [];
      aiLast = null;
      $('#aiResult').hidden = true;
      renderAiLog();
    });
    $('#aiSend').addEventListener('click', aiSend);
    $('#aiMsg').addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); aiSend(); }
    });
    $('#aiApply').addEventListener('click', () => applyAi('replace'));
    $('#aiAppend').addEventListener('click', () => applyAi('append'));
    $('#btnTrans').addEventListener('click', () => {
      if ($('#transOnline')) $('#transOnline').checked = state.online;
      syncGtLangTabsUI();
      openModal('modalTrans');
      setTimeout(() => { if ($('#transSrc')) $('#transSrc').focus(); }, 20);
    });
    $('#btnTransRun').addEventListener('click', () => runTranslate(false));
    if ($('#btnTransClear')) {
      $('#btnTransClear').addEventListener('click', () => {
        if ($('#transSrc')) $('#transSrc').value = '';
        if ($('#transOut')) $('#transOut').value = '';
        if ($('#transCharCount')) $('#transCharCount').textContent = '0 / 5000';
        if ($('#transStat')) $('#transStat').textContent = '准备就绪';
        if ($('#transSrc')) $('#transSrc').focus();
      });
    }
    if ($('#gtSrcLangTabs')) {
      $('#gtSrcLangTabs').addEventListener('click', e => {
        const b = e.target.closest('[data-gt-src]');
        if (!b) return;
        _gtSrcLang = b.getAttribute('data-gt-src') || 'auto';
        if (_gtSrcLang !== 'auto' && _gtSrcLang === _gtTgtLang) {
          _gtTgtLang = (_gtSrcLang === 'zh-CN') ? 'en' : 'zh-CN';
        }
        syncGtLangTabsUI();
        if ($('#transSrc') && $('#transSrc').value.trim()) runTranslate(true);
      });
    }
    if ($('#gtTgtLangTabs')) {
      $('#gtTgtLangTabs').addEventListener('click', e => {
        const b = e.target.closest('[data-gt-tgt]');
        if (!b) return;
        _gtTgtLang = b.getAttribute('data-gt-tgt') || 'en';
        if (_gtSrcLang !== 'auto' && _gtSrcLang === _gtTgtLang) {
          _gtSrcLang = (_gtTgtLang === 'zh-CN') ? 'en' : 'zh-CN';
        }
        syncGtLangTabsUI();
        if ($('#transSrc') && $('#transSrc').value.trim()) runTranslate(true);
      });
    }
    if ($('#transSrc')) {
      $('#transSrc').addEventListener('input', () => {
        const v = $('#transSrc').value || '';
        if ($('#transCharCount')) $('#transCharCount').textContent = `${v.length} / 5000`;
        clearTimeout(_gtLiveTimer);
        if (!v.trim()) {
          if ($('#transOut')) $('#transOut').value = '';
          if ($('#transStat')) $('#transStat').textContent = '准备就绪';
          return;
        }
        _gtLiveTimer = setTimeout(() => { runTranslate(true); }, 420);
      });
    }
    $('#btnTransSwap').addEventListener('click', () => {
      const a = $('#transSrc').value;
      $('#transSrc').value = $('#transOut').value;
      $('#transOut').value = a;
      if (_gtSrcLang === 'auto') {
        const prevTgt = _gtTgtLang;
        _gtSrcLang = prevTgt;
        _gtTgtLang = (prevTgt === 'zh-CN') ? 'en' : 'zh-CN';
      } else {
        const tmp = _gtSrcLang;
        _gtSrcLang = _gtTgtLang;
        _gtTgtLang = tmp;
      }
      syncGtLangTabsUI();
      if ($('#transSrc').value.trim()) runTranslate(true);
    });
    $('#btnTransCopy').addEventListener('click', () => {
      const v = $('#transOut').value.trim();
      if (v) copyText(v); else toast('没有可复制的结果');
    });
    $('#btnTransSel').addEventListener('click', transAddToSel);
    $('#transSrc').addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runTranslate(); }
    });
    ['#chkOnline', '#transOnline'].forEach(sel => {
      $(sel).addEventListener('change', e => {
        state.online = !!e.target.checked;
        $('#chkOnline').checked = state.online;
        $('#transOnline').checked = state.online;
        save();
      });
    });
    $('#transForce').addEventListener('change', e => {
      state.forceOnline = !!e.target.checked;
      save();
    });
    $('#chkOrder').addEventListener('change', e => {
      state.autoOrder = e.target.checked;
      if (state.autoOrder) {
        const list = currentList();
        if (list.length) {
          const sorted = list.map((it, i) => ({ it, i })).sort((a, b) => rankOf(a.it) - rankOf(b.it) || a.i - b.i).map(x => x.it);
          list.length = 0;
          sorted.forEach(x => list.push(x));
        }
      }
      renderSelected();
      save();
    });
    $('#btnParse').addEventListener('click', () => {
      $('#parseStat').textContent = '等待识别…';
      $('#parseChips').innerHTML = '';
      $('#parseUnknownBox').hidden = true;
      $('#btnParseApply').disabled = !$('#parseInput').value.trim();
      openModal('modalParse');
      setTimeout(() => $('#parseInput').focus(), 30);
    });
    $('#btnParseRun').addEventListener('click', () => runParse(false));
    $('#btnParseApply').addEventListener('click', () => runParse(true));

    /* ---------- 图片解析 ---------- */
    const btnImg = $('#btnImg');
    if (btnImg) btnImg.addEventListener('click', () => { resetImg(); openModal('modalImg'); });
    const imgDrop = $('#imgDrop');
    const imgFileEl = $('#imgFile');
    if (imgDrop && imgFileEl) {
      imgDrop.addEventListener('click', e => { if (e.target !== imgFileEl) imgFileEl.click(); });
      imgFileEl.addEventListener('change', () => {
        const f = imgFileEl.files && imgFileEl.files[0];
        if (f) handleImage(f);
      });
      imgDrop.addEventListener('dragover', e => { e.preventDefault(); imgDrop.classList.add('over'); });
      imgDrop.addEventListener('dragleave', () => imgDrop.classList.remove('over'));
      imgDrop.addEventListener('drop', e => {
        e.preventDefault();
        imgDrop.classList.remove('over');
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) handleImage(f);
      });
    }
    document.addEventListener('paste', e => {
      const box = $('#modalImg');
      if (!box || box.hidden) return;
      const items = (e.clipboardData && e.clipboardData.items) || [];
      for (let i = 0; i < items.length; i++) {
        if (String(items[i].type || '').indexOf('image/') === 0) {
          const f = items[i].getAsFile();
          if (f) { e.preventDefault(); handleImage(f); return; }
        }
      }
    });
    const btnImgApply = $('#btnImgApply');
    if (btnImgApply) btnImgApply.addEventListener('click', applyImg);
    const btnImgCopyRaw = $('#btnImgCopyRaw');
    if (btnImgCopyRaw) btnImgCopyRaw.addEventListener('click', () => {
      const posVal = ($('#imgPosText') && $('#imgPosText').value) || '';
      const negVal = ($('#imgNegText') && $('#imgNegText').value) || '';
      const combined = posVal + (negVal ? '\nNegative prompt: ' + negVal : '');
      copyText(combined || String($('#imgRaw').textContent || ''));
    });
    const btnImgCopyPos = $('#btnImgCopyPos');
    if (btnImgCopyPos) btnImgCopyPos.addEventListener('click', () => {
      copyText(($('#imgPosText') && $('#imgPosText').value) || '');
    });
    const btnImgCopyNeg = $('#btnImgCopyNeg');
    if (btnImgCopyNeg) btnImgCopyNeg.addEventListener('click', () => {
      copyText(($('#imgNegText') && $('#imgNegText').value) || '');
    });
    const btnImgCopyJson = $('#btnImgCopyJson');
    if (btnImgCopyJson) btnImgCopyJson.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      copyText(($('#imgJsonRaw') && $('#imgJsonRaw').textContent) || '');
    });
    const btnImgCopyModel = $('#btnImgCopyModel');
    if (btnImgCopyModel) btnImgCopyModel.addEventListener('click', () => {
      const info = imgResult && imgResult.info;
      if (!info) return;
      copyText(genInfoText(info));
      toast('底模 / 采样信息已复制');
    });
    const modelBox = $('#imgModelBox');
    if (modelBox) modelBox.addEventListener('click', e => {
      const a = e.target.closest('a[data-civitai-hash],a[data-civitai-name]');
      if (!a) return;
      e.preventDefault();
      const h = a.getAttribute('data-civitai-hash');
      const n = a.getAttribute('data-civitai-name');
      const url = h ? civitaiHashUrl(h) : civitaiSearchUrl(n);
      if (url) window.open(url, '_blank', 'noopener');
    });
    $('#parseInput').addEventListener('input', () => {
      $('#btnParseApply').disabled = !$('#parseInput').value.trim();
    });
    $('#parseInput').addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runParse(true); }
    });
    ['#parseSmart', '#parseFuzzy', '#parseUnknown', '#parseShowZh', '#parseAutoTr'].forEach(s => {
      const elOpt = $(s);
      if (elOpt) elOpt.addEventListener('change', () => { if (lastParsed) renderParsePreview(lastParsed.res); });
    });
    if ($('#btnParseImportCustom')) {
      $('#btnParseImportCustom').addEventListener('click', () => {
        if (!lastParsed || !lastParsed.res) {
          runParse(false);
        }
        if (!lastParsed || !lastParsed.res) return;
        const unkAll = [...(lastParsed.res.pos.unknown || []), ...(lastParsed.res.neg.unknown || [])];
        if (!unkAll.length) {
          toast('当前没有未收录的提示词需要导入');
          return;
        }
        recordHistorySnapshot(`逆向识别导入自定义 (${unkAll.length} 项)`);
        const cnt = importUnknownTagsToCustomCategory(unkAll);
        refreshAllFromTree();
        save();
        // 重新解析使刚导入自定义的词条变为已识别状态
        runParse(false);
        toast(`📥 已将 ${cnt || unkAll.length} 个未识别提示词导入「⭐ 自定义」分类`);
      });
    }
    $('#btnSettings').addEventListener('click', () => {
      if ($('#setSyntax')) $('#setSyntax').value = state.syntax || 'sd';
      if ($('#setEscape')) $('#setEscape').checked = !!state.escape;
      if ($('#setModelPrefix')) $('#setModelPrefix').checked = !!state.modelPrefix;
      if ($('#setShowZh')) $('#setShowZh').checked = !!state.showZh;
      if ($('#setAutoOrder')) $('#setAutoOrder').checked = !!state.autoOrder;
      $('#setRandom').value = state.randomN;
      $('#setAutosave').checked = state.autosave;
      if ($('#setAutoTr')) $('#setAutoTr').checked = !!state.autoTr;
      if ($('#setLogoStyle')) $('#setLogoStyle').value = state.logoStyle || (localStorage.getItem('pg_logo_style') === 'dp' ? 'dp' : 'chibi');
      openModal('modalSettings');
    });

    /* (Req 1) 弹窗关闭：仅关闭当前点击的窗口本身，保留下层父窗口 */
    $$('.modal').forEach(m => {
      m.addEventListener('click', e => {
        if (e.target === m || e.target.closest('[data-close]')) {
          e.stopPropagation();
          closeModal(m.id);
        }
      });
    });

    /* 角色弹窗：分组 + IP */
    $('#groupTabs').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      state._group = b.dataset.cgroup;
      state._game = '全部';
      renderCharModal();
    });
    $('#gameTabs').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      state._game = b.dataset.game;
      $$('#gameTabs button').forEach(x => x.classList.toggle('active', x === b));
      renderCharGrid();
    });
    $('#charSearch').addEventListener('input', renderCharGrid);
    const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };

    $('#charGrid').addEventListener('click', e => {
      const cfav = e.target.closest('[data-cfav]');
      if (cfav) { e.stopPropagation(); toggleFavChar(cfav.dataset.cfav); return; }
      const edit = e.target.closest('[data-cedit]');
      if (edit) { e.stopPropagation(); openCharEditor(edit.dataset.cedit); return; }
      const del = e.target.closest('[data-cdel]');
      if (del) { e.stopPropagation(); deleteChar(del.dataset.cdel); return; }
      const card = e.target.closest('[data-char]');
      if (card) applyCharacter(card.dataset.char);
    });
    on('#btnCharNew', 'click', () => openCharEditor(null));
    on('#btnCharReset', 'click', resetChars);
    on('#ceSave', 'click', saveCharEditor);
    on('#ceCancel', 'click', closeCharEditor);
    on('#ceDelete', 'click', () => { if (editCharKey && editCharKey !== '__new') deleteChar(editCharKey); });

    /* 预设弹窗 */
    $('#presetList').addEventListener('click', e => {
      const padd = e.target.closest('[data-padd]');
      if (padd) { e.stopPropagation(); presetComboToggle(padd.dataset.padd); return; }
      const edit = e.target.closest('[data-pedit]');
      if (edit) { e.stopPropagation(); openPresetEditor(edit.dataset.pedit); return; }
      const exBtn = e.target.closest('[data-pexp]');
      if (exBtn) {
        e.stopPropagation();
        const pk = exBtn.dataset.pexp;
        const pObj = PRESETS.find(x => x.key === pk);
        if (pObj) {
          exportLibraryJsonFile(pObj.name || pObj.key, {
            key: pObj.key, id: pObj.key, name: pObj.name, desc: pObj.desc || '', cat: pObj.cat || '场景',
            tags: (pObj.tags || []).map(t => (t.zh ? t.en + '|' + t.zh : t.en)).join(';')
          }, '📤 已导出预设：' + pObj.name + '.json');
        }
        return;
      }
      const del = e.target.closest('[data-pdel]');
      if (del) { e.stopPropagation(); deletePreset(del.dataset.pdel); return; }
      const card = e.target.closest('[data-preset]');
      if (card) applyPreset(card.dataset.preset);
    });
    $('#presetList').addEventListener('contextmenu', e => {
      const card = e.target.closest('[data-preset]');
      if (!card) return;
      e.preventDefault();
      e.stopPropagation();
      const pk = card.dataset.preset;
      const pObj = PRESETS.find(x => x.key === pk);
      if (!pObj) return;
      placeContextMenu(e.clientX, e.clientY, `
        <div class="ctx-menu-head">✨ 预设：${esc(pObj.name)}</div>
        <button type="button" data-ctx-preset="apply" data-pkey="${esc(pk)}">📋 套用此预设</button>
        <button type="button" data-ctx-preset="edit" data-pkey="${esc(pk)}">✎ 编辑预设</button>
        <button type="button" data-ctx-preset="export" data-pkey="${esc(pk)}">📤 导出预设 (.json)</button>
        <button type="button" class="danger" data-ctx-preset="delete" data-pkey="${esc(pk)}">🗑 删除预设</button>
      `);
    });
    on('#btnSaveNow', 'click', saveCurrent);
    on('#btnSaveWipe', 'click', deleteAllSaves);
    on('#saveList', 'click', e => {
      const del = e.target.closest('[data-sdel]');
      if (del) { deleteSave(del.dataset.sdel); return; }
      const load = e.target.closest('[data-sload]');
      if (load) loadSave(load.dataset.sload);
    });
    on('#btnPresetNew', 'click', () => openPresetEditor(null));
    on('#btnPresetReset', 'click', resetPresets);
    on('#presetSearch', 'input', renderPresetModal);
    on('#peFold', 'click', () => {
      const panel = $('#presetEdit');
      if (panel && !panel.classList.contains('folded')) closePresetEditor();
      else openPresetEditor(editPresetKey && editPresetKey !== '__new' ? editPresetKey : null);
    });
    on('#ceFold', 'click', () => {
      const panel = $('#charEdit');
      if (panel && !panel.classList.contains('folded')) closeCharEditor();
      else openCharEditor(editCharKey && editCharKey !== '__new' ? editCharKey : null);
    });
    on('#peSave', 'click', savePresetEditor);
    on('#peCancel', 'click', closePresetEditor);
    on('#peFromSel', 'click', fillPresetFromSelection);
    on('#peDelete', 'click', () => { if (editPresetKey && editPresetKey !== '__new') deletePreset(editPresetKey); });

    /* 角色 chip 解除 */
    el.charChip.addEventListener('click', ev => {
      const chip = ev.target && ev.target.closest ? ev.target.closest('[data-cchar]') : null;
      if (!chip) return;
      if (chip.dataset.cchar === '__all') clearCharacter();
      else removeCharacter(chip.dataset.cchar);
    });

    /* 随机弹窗 */
    $('#btnReroll').addEventListener('click', generateRandom);
    if ($('#randSwitchBar')) {
      $('#randSwitchBar').addEventListener('change', e => {
        const chk = e.target.closest('input[data-rand-sw]');
        if (!chk) return;
        const swId = chk.getAttribute('data-rand-sw');
        const rcfg = ensureRandCfgStructure();
        const sw = (rcfg.switches || []).find(s => s.id === swId);
        if (sw) {
          ensureEditableSchemeOnModify();
          const curSw = (ensureRandCfgStructure().switches || []).find(s => s.id === swId);
          if (curSw) {
            curSw.enabled = !!chk.checked;
            if (curSw.id === 'sw_char' || curSw.isCharSwitch) {
              ensureRandCfgStructure().charRule.enabled = !!chk.checked;
            }
          }
          syncActiveSchemeSnapshot();
          save();
          generateRandom();
        }
      });
    }
    $('#randChips').addEventListener('click', e => {
      const p = e.target.closest('.pill');
      if (!p) return;
      state.randomSet.splice(Number(p.dataset.i), 1);
      renderRandom();
    });
    $('#btnRandCopy').addEventListener('click', () => copyText($('#randOutput').value));
    $('#btnRandApply').addEventListener('click', () => {
      const list = state.randomSet || [];
      if (!list.length) { toast('先生成一组标签'); return; }
      recordHistorySnapshot(`应用随机组合 (${list.length} 项)`);
      const had = state.sel.length + (state.chars || []).length;
      const lockedChars = (state.chars || []).filter(c => c && c.locked);
      const lockedCharTagSet = new Set();
      lockedChars.forEach(c => (c.tags || []).forEach(t => lockedCharTagSet.add(norm(t))));
      state.sel = (state.sel || []).filter(x => x && (x.locked || lockedCharTagSet.has(x.key) || (x.fromCharKey && lockedChars.some(c => c.key === x.fromCharKey))));
      state.chars = lockedChars.slice();
      stateCharTags = [];
      syncCharTags();
      state.mode = 'pos';
      syncModeSeg();
      (state.randomRolledCharKeys || []).forEach(ck => {
        const ch = CHARS.find(x => x.key === ck) || findCustomCharByKey(ck);
        if (ch && !state.chars.some(x => x.key === ch.key)) {
          touchRecentChar(ch.key);
          state.chars.push({
            key: ch.key, name: ch.name, tag: ch.tag, charZh: ch.charZh,
            tags: [norm(ch.tag)].concat((ch.auto || []).map(a => norm(a.en)))
          });
        }
      });
      syncCharTags();
      let n = 0;
      list.forEach(t => {
        if (addTag(t.en, t.zh, t.w || 1, '', t.subId || '', t.fromCharKey ? 'skip' : undefined)) n++;
      });
      const rcfgNow = ensureRandCfgStructure();
      const qualSw = (rcfgNow.switches || []).find(s => s && s.id === 'sw_quality');
      if (qualSw && qualSw.enabled) {
        ensureOfficialNegBaselineInNegList();
      }
      closeModal('modalRandom');
      renderSelected();
      renderCharChip();
      renderGrid();
      renderOutput();
      save();
      toast(had ? `已清空旧提示词，填入 ${n} 个随机标签` : `已填入 ${n} 个随机标签`);
    });

    /* 新增 / 翻译 */
    $('#btnTranslate').addEventListener('click', doTranslate);
    $('#addInput').addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doTranslate(); }
    });
    $('#btnSaveCustom').addEventListener('click', () => {
      const items = collectAddItems();
      if (!items.length) { toast('没有可保存的标签'); return; }
      let n = 0;
      items.forEach(it => {
        if (!it.en) return;
        if (state.custom.some(t => norm(t.en) === norm(it.en))) return;
        const newCustObj = { en: it.en, zh: it.zh || zhLookup(it.en), isNew: true };
        markTagObjectAsNew(newCustObj, it.en);
        state.custom.push(newCustObj);
        idxAdd(it.en, it.zh); dictAdd(it.zh, it.en); n++;
      });
      if (n) { rebuildDictKeys(); save(); toast(`已保存 ${n} 个自定义标签`); }
      else toast('这些标签已经在库里了');
    });
    $('#btnAddToSel').addEventListener('click', () => {
      const items = collectAddItems();
      if (!items.length) { toast('没有可加入的标签'); return; }
      let n = 0;
      items.forEach(it => { if (it.en && addTag(it.en, it.zh, 1)) n++; });
      state.mode = 'pos';
      syncModeSeg();
      closeModal('modalAdd');
      renderSelected();
      renderGrid();
      save();
      toast(`已加入 ${n} 个标签`);
    });
    $('#addResult').addEventListener('input', () => {
      const items = resultItems();
      renderPreview(items, $('#addPreview'));
    });

    /* 设置 (Req 1：补全所有开关事件监听) */
    if ($('#setSyntax')) $('#setSyntax').addEventListener('change', e => {
      state.syntax = e.target.value || 'sd';
      renderSelected();
      save();
    });
    if ($('#setEscape')) $('#setEscape').addEventListener('change', e => {
      state.escape = !!e.target.checked;
      renderSelected();
      save();
    });
    if ($('#setModelPrefix')) $('#setModelPrefix').addEventListener('change', e => {
      state.modelPrefix = !!e.target.checked;
      renderSelected();
      save();
    });
    if ($('#setShowZh')) $('#setShowZh').addEventListener('change', e => {
      state.showZh = !!e.target.checked;
      if ($('#chkZh')) $('#chkZh').checked = state.showZh;
      renderGrid();
      renderSelected();
      renderRandom();
      save();
    });
    if ($('#setAutoOrder')) $('#setAutoOrder').addEventListener('change', e => {
      state.autoOrder = !!e.target.checked;
      if ($('#chkOrder')) $('#chkOrder').checked = state.autoOrder;
      renderSelected();
      save();
    });
    if ($('#btnExportBackup')) $('#btnExportBackup').addEventListener('click', exportData);
    if ($('#btnImportBackup')) $('#btnImportBackup').addEventListener('click', () => {
      if ($('#fileImport')) $('#fileImport').click();
    });
    $('#setRandom').addEventListener('change', e => {
      state.randomN = clamp(parseInt(e.target.value, 10) || 8, 2, 20);
      save();
    });
    $('#setAutosave').addEventListener('change', e => {
      state.autosave = !!e.target.checked;
      persistStateAndSettingsNow();
    });
    if ($('#fileImport')) $('#fileImport').addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      if (f) importData(f);
      e.target.value = '';
    });

    /* 键盘 */
    document.addEventListener('keydown', e => {
      /* Escape handled centrally (closes only top layer, never closeAll) */
      if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
        e.preventDefault();
        el.search.focus();
      }
    });
  }

  /* ---------- 新增提示词相关 ---------- */

  function resultItems() {
    const text = $('#addResult').value;
    return String(text).split(/[\n,，、;；|]+/).map(s => s.trim()).filter(Boolean).map(en => ({
      en: norm(en), zh: zhLookup(en), miss: []
    }));
  }

  function collectAddItems() {
    return resultItems();
  }

  async function doTranslate() {
    const raw = $('#addInput').value.trim();
    if (!raw) { toast('请先输入中文或英文'); return; }
    let items = translateText(raw);
    const stat = $('#addTransStat') || $('#transStat');
    stat.textContent = '翻译中…';

    const missSegs = items.filter(it => it.miss && it.miss.length).map(it => it.miss.join(''));
    if (missSegs.length && $('#chkOnline').checked) {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it.miss || !it.miss.length) continue;
        try {
          const zh = it.miss.join('');
          const en = await onlineTranslate(zh);
          if (en) {
            it.en = normalizeEn((it.en + ' ' + en).trim());
            it.miss = [];
          }
        } catch (err) { /* 保持未识别 */ }
      }
    }
    items = items.filter(it => it.en);
    $('#addResult').value = items.map(it => it.en).join(', ');
    renderPreview(items, $('#addPreview'));
    const bad = items.filter(it => it.miss && it.miss.length);
    const unknownChars = [...new Set(bad.flatMap(it => it.miss))].join('、');
    stat.textContent = bad.length
      ? `${items.length - bad.length}/${items.length} 已翻译，未识别：${unknownChars}`
      : `已翻译 ${items.length} 项`;
    if (bad.length && !$('#chkOnline').checked) {
      toast('部分词条未收录，可勾选「联网翻译」或手动补全英文');
    }
  }

  try {
    window.__PG_EDIT__ = {
      PRESETS, CHARS, CUSTOM, tagText, parseTagText, applyCustom, saveCustom,
      openPresetEditor, savePresetEditor, deletePreset, resetPresets,
      openCharEditor, saveCharEditor, deleteChar, resolveOne, applyCharacter, removeCharacter, clearCharacter,
      saves: () => SAVES, saveCurrent, loadSave, deleteSave, deleteAllSaves, renderSaves,
      trSpan, trGet, trSet, queueTr, autoTrScan, openTrQuick, renderTrList, TRMEM, trPump, trFetchOne, trAllWords,
      applyTrToCustom, queueTrAllMissing, trOne, gTranslate, mmTranslate,
      state, renderAll, renderSelected, renderGrid, setFold
    };
  } catch (e) { /* ignore */ }

  /* =====================================================================
     8.5 翻译记忆：自动翻译未译词 + 就地改译文 + 记忆管理
     ===================================================================== */

  /* 标签上的中文：有记忆/词库就显示，没有就显示待译记号（可点击去填） */
  /* V1.2.4：词库内所有画师标签已统一自带 @ 前缀（如 @wlop），cleanArtistEn 保留单个 @ 前缀并消除重复 @@ */
  function cleanArtistEn(en, subId) {
    const s = String(en || '').trim();
    if (!s) return '';
    if (s.startsWith('@') || subId === 'artist') {
      const body = s.replace(/^@+/, '').trim();
      return body ? ('@' + body) : '';
    }
    if (typeof TAG_SUB_LOOKUP !== 'undefined' && TAG_SUB_LOOKUP.get(norm(s)) === 'artist') {
      return '@' + s;
    }
    return s;
  }
  function isArtistTag(en, subId) {
    const raw = String(en || '').trim();
    if (!raw) return false;
    if (raw.startsWith('@') && !isAnimaEmoteOrScore(raw)) return true;
    const bare = raw.replace(/^@+/, '').trim();
    const cid = subId || tagCatOf(raw) || tagCatOf('@' + bare) || tagCatOf(bare);
    if (cid === 'artist') return true;
    const catObj = CATS.find(c => c.id === cid);
    if (catObj && /画师|artist/i.test(catObj.name || '')) return true;
    return false;
  }
  const OFFICIAL_NEG_BASELINE = [
    { en: 'worst quality', zh: '最差质量' },
    { en: 'low quality', zh: '低质量' },
    { en: 'score_1', zh: '评分一分(低质)' },
    { en: 'score_2', zh: '评分二分(低质)' },
    { en: 'score_3', zh: '评分三分(低质)' },
    { en: 'artist name', zh: '画师签名水印' },
    { en: 'blurry', zh: '画面模糊' },
    { en: 'jpeg artifacts', zh: '压缩痕迹' },
    { en: 'chromatic aberration', zh: '色差伪影' }
  ];

  function ensureOfficialNegBaselineInNegList() {
    if (!Array.isArray(state.neg)) state.neg = [];
    const existing = new Set(state.neg.map(x => norm(x.en)));
    OFFICIAL_NEG_BASELINE.forEach(item => {
      const k = norm(item.en);
      if (!existing.has(k)) {
        existing.add(k);
        state.neg.push({ key: k, en: item.en, zh: item.zh, subId: 'negative', w: 1 });
      }
    });
  }

  function formatRightEn(en, subId, mode) {
    const raw = String(en || '').trim();
    if (!raw) return '';
    const m = mode || state.mode;
    if (m === 'pos' && isArtistTag(raw, subId)) {
      return '@' + formatAnimaTagEn(raw.replace(/^@+/, '').trim());
    }
    // Natural language sentences (>= 5 words with capital or punctuation) keep capitalization; visual tags use formatAnimaTagEn
    if (raw.split(/\s+/).length >= 5 && /[A-Z,.!]/.test(raw)) return raw;
    return formatAnimaTagEn(raw);
  }
  function trSpan(en, zh) {
    const rawKey = String(en || '').trim();
    const key = cleanArtistEn(rawKey) || rawKey;
    if (!key) return '';
    const z = trGet(key) || trGet(rawKey) || (zh ? String(zh).trim() : '') || zhLookup(key) || zhLookup(rawKey);
    if (z) return `<span class="zh">(${esc(z)})</span>`;
    if (TRQ.seen.has(norm(key))) {
      return `<span class="zh tr-miss">(译中…)</span>`;
    }
    return '';
  }

  const trSleep = ms => new Promise(r => setTimeout(r, ms));

  /* 取一个英文词的中文：先本地词库，再联网 */
  async function trFetchOne(word) {
    const w = bareToken(String(word || '')).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!w) return '';
    const local = zhOf(w);
    if (local) return local;
    try {
      const t = await onlineTranslateToZh(w);
      const s = String(t || '').replace(/\s+/g, ' ').trim();
      if (!s) return '';
      if (/MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID/i.test(s)) return '';
      /* 原样吐回来 = 没翻出来（还全是英文），当成失败，别把英文当译文存下来 */
      const flat = x => String(x).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
      if (flat(s) === flat(w)) return '';
      if (!/[\u4e00-\u9fa5]/.test(s) && /[a-z]/i.test(w)) return '';
      return s;
    } catch (e) { return ''; }
  }

  /* 并发队列：同时 3 个词，每批间隔 120ms；单个词重试 2 轮，连续 8 个词全挂才收手 */
  const TRQ = { q: [], seen: new Set(), busy: false, fail: 0, ok: 0 };
  const TR_CONC = 3;
  let trUiTimer = null;

  function trPingUi() {
    clearTimeout(trUiTimer);
    trUiTimer = setTimeout(() => {
      renderGrid();
      renderSelected();
      const m = $('#modalTr');
      if (m && !m.hidden) renderTrList();
      const mp = $('#modalParse');
      if (mp && !mp.hidden && lastParsed) renderParsePreview(lastParsed.res);
    }, 260);
  }

  /* 翻到一个就立刻写回「自定义 / 已选 / 负面」并落盘，绝不停在待译 */
  function applyTrToCustom(k, zh) {
    if (!k || !zh) return;
    let hit = false;
    const fill = list => (list || []).forEach(t => {
      if (t && norm(t.en) === k && !(t.zh && String(t.zh).trim())) { t.zh = zh; hit = true; }
    });
    fill(state.custom);
    fill(state.sel);
    fill(state.neg);
    if (hit) { try { save(); } catch (e) { /* ignore */ } }
  }

  function queueTr(list) {
    if (!state.autoTr) return;
    const arr = Array.isArray(list) ? list : [list];
    let added = 0;
    arr.forEach(x => {
      const en = String(x || '').trim();
      if (!en) return;
      const k = norm(bareToken(en));
      if (!k || TRQ.seen.has(k)) return;
      if (k.split(/\s+/).length > 9) return;
      if (trGet(k) || zhOf(k)) return;
      if (TRQ.seen.has(k)) return;
      TRQ.q.push(k); TRQ.seen.add(k); added++;
    });
    if (added) trPump();
  }

  async function trPump() {
    if (TRQ.busy || !state.autoTr) return;
    TRQ.busy = true;
    try {
      while (TRQ.q.length) {
        const batch = TRQ.q.splice(0, TR_CONC);
        await Promise.all(batch.map(k => trOne(k)));
        if (!TRQ.q.length) break;
        await trSleep(120);
      }
    } finally {
      TRQ.busy = false;
      trPingUi();
      if (TRQ.ok) {
        const n = TRQ.ok;
        TRQ.ok = 0;
        toast('自动翻译完成：' + n + ' 个词已存进自定义');
      }
    }
  }

  async function trOne(k) {
    if (trGet(k) || zhOf(k)) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      const zh = await trFetchOne(k);
      if (zh) {
        trSet(k, zh, false);
        applyTrToCustom(k, zh);
        TRQ.fail = 0;
        trPingUi();
        return;
      }
      await trSleep(160 + attempt * 200);
    }
    TRQ.fail++;
    if (TRQ.fail >= 8) {
      TRQ.q.length = 0;
      toast('联网翻译暂时连不上，先停一下');
    }
  }

  /* 一次性把全库还没有中文的词排进队（后台慢慢翻，不挡操作） */
  function queueTrAllMissing() {
    if (!state.autoTr) return;
    const out = [];
    CATS.forEach(c => (c.tags || []).forEach(t => { if (!t.zh) out.push(t.en); }));
    [].concat(state.sel, state.neg, state.custom).forEach(t => { if (t && !t.zh) out.push(t.en); });
    if (out.length) queueTr(out);
  }

  /* 画面上可见、但还没有中文的标签，每次最多补 24 个 */
  function autoTrScan() {
    if (!state.autoTr) return;
    const box = el.grid;
    if (!box) return;
    const out = [];
    const miss = box.querySelectorAll('.zh.tr-miss[data-tr]');
    for (let i = 0; i < miss.length && out.length < 24; i++) out.push(miss[i].getAttribute('data-tr'));
    if (!state.showZh) {
      const chips = box.querySelectorAll('.chip[data-en]');
      for (let i = 0; i < chips.length && out.length < 24; i++) out.push(chips[i].getAttribute('data-en'));
    }
    if (out.length) queueTr(out);
  }

  /* ---------- 就地改译文 ---------- */
  let trQuickEn = '';
  function openTrQuick(en) {
    en = String(en || '').trim();
    if (!en) return;
    trQuickEn = en;
    const rec = TRMEM.get(norm(en));
    $('#trPopupEn').textContent = en;
    const inp = $('#trPopupIn');
    inp.value = (rec && rec.zh) || zhLookup(en) || '';
    $('#trPopupDel').hidden = !(rec && rec.zh);
    $('#trPopup').hidden = false;
    inp.focus(); inp.select();
  }
  function closeTrQuick() { $('#trPopup').hidden = true; trQuickEn = ''; }
  function saveTrQuick() {
    if (!trQuickEn) return;
    const v = $('#trPopupIn').value.trim();
    const en = trQuickEn;
    trSet(en, v, true);
    closeTrQuick();
    trPingUi();
    toast(v ? '已记住：' + en + ' → ' + v : '已清掉这条释义');
  }

  /* ---------- 记忆管理 ---------- */
  function trAllWords() {
    const map = new Map();
    CATS.forEach(c => c.tags.forEach(t => { const k = norm(t.en); if (k && !map.has(k)) map.set(k, t.en); }));
    state.custom.forEach(c => { const k = norm(c.en); if (k && !map.has(k)) map.set(k, c.en); });
    [].concat(state.sel, state.neg).forEach(t => { const k = norm(t.en); if (k && !map.has(k)) map.set(k, t.en); });
    TRMEM.forEach((v, k) => { if (!map.has(k)) map.set(k, k); });
    return Array.from(map.values());
  }

  function renderTrList() {
    const box = $('#trList');
    if (!box) return;
    const q = norm($('#trSearch').value.trim());
    const onlyMiss = $('#trOnlyMiss').checked;
    const all = $('#trAll').checked;
    const words = trAllWords();
    $('#trStat').textContent = '已记忆 ' + TRMEM.size + ' 条 · 候选词 ' + words.length + ' 个';

    const mine = new Set();
    [].concat(state.sel, state.neg, state.custom).forEach(t => mine.add(norm(t.en)));

    const rows = [];
    words.forEach(en => {
      const k = norm(en);
      const rec = TRMEM.get(k);
      const zh = (rec && rec.zh) || zhLookup(en) || '';
      if (!all && !rec && !mine.has(k)) return;
      if (onlyMiss && zh) return;
      if (q && !norm(en).includes(q) && !norm(zh).includes(q)) return;
      rows.push({ en: en, zh: zh, manual: !!(rec && rec.manual), auto: !!(rec && !rec.manual) });
    });
    rows.sort((a, b) => (b.manual ? 1 : 0) - (a.manual ? 1 : 0) || a.en.localeCompare(b.en));
    const shown = rows.slice(0, 800);
    if (!shown.length) {
      box.innerHTML = '<div class="tr-empty">这里空着 —— 关掉「只看未翻译」，或者先粘贴一段提示词做逆向识别</div>';
      return;
    }
    box.innerHTML = shown.map(r => `
      <div class="tr-row" data-en="${esc(r.en)}">
        <span class="en" title="${esc(r.en)}">${esc(r.en)}</span>
        <span class="src${r.manual ? ' manual' : ''}">${r.manual ? '手动' : (r.auto ? '自动' : '词库')}</span>
        <input value="${esc(r.zh)}" placeholder="填中文释义…" spellcheck="false">
        <button class="mini" data-act="trsave" title="保存这条">存</button>
      </div>`).join('');
  }

  function autoTrAll() {
    const miss = trAllWords().filter(en => !trGet(en) && !zhOf(en));
    if (!miss.length) { toast('没有需要翻的词了'); return; }
    TRQ.seen = new Set();
    TRQ.q.length = 0;
    queueTr(miss);
    toast('开始自动翻译 ' + miss.length + ' 个词，慢慢来…');
    setTimeout(renderTrList, 400);
  }

  /* ---------- 统一绑定 ---------- */
  function bindExtra() {
    const on = (sel, ev, fn) => { const n = $(sel); if (n) n.addEventListener(ev, fn); };

    /* V1.3.0: 标签排序切换器 (#selTagSort) 与 NPMI 智能关联推荐栏交互 */
    const selSortEl = $('#selTagSort');
    if (selSortEl) {
      selSortEl.value = state.tagSortMode || 'default';
      selSortEl.addEventListener('change', () => {
        state.tagSortMode = selSortEl.value || 'default';
        state._subShowLimit = {};
        renderGrid();
        const labelMap = { default: '默认排序', pop: '🔥 Danbooru 热度降序', alpha: '🔤 字母序' };
        toast('已切换标签排序：' + (labelMap[state.tagSortMode] || '默认排序'));
      });
    }
    on('#coocRecToggle', 'click', () => {
      state._recOpenPanel = (state._recOpenPanel === 'cooc') ? '' : 'cooc';
      const cBox = $('#coocRecBox');
      const aBox = $('#artistRecBox');
      if (cBox) cBox.classList.toggle('collapsed', state._recOpenPanel !== 'cooc');
      if (aBox) aBox.classList.toggle('collapsed', state._recOpenPanel !== 'artist');
    });
    on('#artistRecToggle', 'click', () => {
      state._recOpenPanel = (state._recOpenPanel === 'artist') ? '' : 'artist';
      const cBox = $('#coocRecBox');
      const aBox = $('#artistRecBox');
      if (cBox) cBox.classList.toggle('collapsed', state._recOpenPanel !== 'cooc');
      if (aBox) aBox.classList.toggle('collapsed', state._recOpenPanel !== 'artist');
    });
    const artRecBody = $('#artistRecBody');
    if (artRecBody) {
      artRecBody.addEventListener('click', e => {
        const btn = e.target.closest('[data-side-artist]');
        if (!btn) return;
        const en = btn.getAttribute('data-side-artist');
        if (!en) return;
        recordHistorySnapshot('画师推荐切换: ' + en);
        toggleTag(en, e.altKey, 'artist');
        renderSelected();
        renderGrid();
        save();
      });
    }
    const coocBody = $('#coocRecBody');
    if (coocBody) {
      coocBody.addEventListener('click', e => {
        const btn = e.target.closest('[data-cooc-add]');
        if (!btn) return;
        const en = btn.getAttribute('data-cooc-add');
        if (!en) return;
        const sid = tagCatOf(en) || '';
        recordHistorySnapshot('智能推荐加入: ' + en);
        if (addTag(en, zhLookup(en), e.altKey ? 1.2 : 1, '', sid)) {
          renderSelected();
          renderGrid();
          save();
          toast('🔗 已加入关联推荐词：' + en);
        }
      });
    }

    /* 翻译记忆 */
    const applyStickySubSetting = () => {
      const onSticky = state.stickySubHead !== false;
      document.body.setAttribute('data-sticky-sub', onSticky ? '1' : '0');
      const chk = $('#setStickySubHead');
      if (chk) chk.checked = onSticky;
    };
    applyStickySubSetting();
    on('#setStickySubHead', 'change', () => {
      state.stickySubHead = !!$('#setStickySubHead').checked;
      applyStickySubSetting();
      save();
      toast(state.stickySubHead ? '已开启：展开小分类浏览时标题保持在顶部' : '已关闭：小分类标题吸顶展示');
    });
    on('#setAutoTr', 'change', () => {
      state.autoTr = !!$('#setAutoTr').checked;
      persistStateAndSettingsNow();
      if (state.autoTr) {
        queueTr([].concat(state.sel, state.neg, state.custom).map(x => x.en));
        autoTrScan();
      }
    });
    on('#btnTrMgr', 'click', () => {
      openModal('modalTr');
      $('#trSearch').value = '';
      renderTrList();
      queueTr([].concat(state.sel, state.neg, state.custom).map(x => x.en));
    });
    on('#trSearch', 'input', renderTrList);
    on('#trOnlyMiss', 'change', renderTrList);
    on('#trAll', 'change', renderTrList);
    on('#btnTrAuto', 'click', autoTrAll);
    on('#btnTrClearAuto', 'click', () => {
      let n = 0;
      Array.from(TRMEM.keys()).forEach(k => {
        const v = TRMEM.get(k);
        if (v && !v.manual) { TRMEM.delete(k); n++; }
      });
      trSaveMem();
      renderTrList();
      trPingUi();
      toast(n ? '清掉 ' + n + ' 条自动翻译' : '没有自动翻译的记录');
    });
    on('#btnTrExport', 'click', () => {
      const o = {};
      TRMEM.forEach((v, k) => { o[k] = { zh: v.zh, manual: !!v.manual }; });
      const blob = new Blob([JSON.stringify(o, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'pg-translate-memory.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    });
    on('#btnTrImport', 'click', () => $('#trFile').click());
    on('#trFile', 'change', () => {
      const f = $('#trFile').files && $('#trFile').files[0];
      if (!f) return;
      const fr = new FileReader();
      fr.onload = () => {
        try {
          const d = JSON.parse(String(fr.result || '{}'));
          let n = 0;
          Object.keys(d || {}).forEach(k => {
            const v = d[k];
            const zh = typeof v === 'string' ? v : (v && v.zh);
            if (!zh) return;
            TRMEM.set(k, { zh: String(zh), manual: !!(v && v.manual) });
            n++;
          });
          trSaveMem();
          renderTrList();
          trPingUi();
          toast('导入了 ' + n + ' 条');
        } catch (e) { toast('导入失败：JSON 不对'); }
      };
      fr.readAsText(f);
      $('#trFile').value = '';
    });

    const list = $('#trList');
    if (list) {
      list.addEventListener('click', e => {
        const b = e.target.closest('button[data-act="trsave"]');
        if (!b) return;
        const row = b.closest('.tr-row');
        const en = row.getAttribute('data-en');
        const v = row.querySelector('input').value.trim();
        trSet(en, v, true);
        trPingUi();
        toast(v ? '已保存' : '已清空');
      });
      list.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        const inp = e.target.closest('input');
        if (!inp) return;
        e.preventDefault();
        const row = inp.closest('.tr-row');
        trSet(row.getAttribute('data-en'), inp.value.trim(), true);
        trPingUi();
        toast('已保存');
      });
    }

    /* 就地编辑浮层 */
    on('#trPopupSave', 'click', saveTrQuick);
    on('#trPopupCancel', 'click', closeTrQuick);
    on('#trPopupDel', 'click', () => {
      if (trQuickEn) { trSet(trQuickEn, '', true); toast('已清掉这条释义'); }
      closeTrQuick();
      trPingUi();
    });
    on('#trPopupIn', 'keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); saveTrQuick(); }
      if (e.key === 'Escape') closeTrQuick();
    });

    /* 中文对照开关关掉时也温和地停一下队列 */
    on('#chkZh', 'change', () => { if (state.showZh) autoTrScan(); });

    /* 点别处关掉就地编辑浮层 */
    document.addEventListener('mousedown', e => {
      const pop = document.getElementById('trPopup');
      if (!pop || pop.hidden) return;
      if (pop.contains(e.target)) return;
      if (e.target.closest && e.target.closest('[data-tr]')) return;
      closeTrQuick();
    }, true);
  }

  /* =====================================================================
     9. 启动
     ===================================================================== */


  function initModelSwitch() {
    const lib = $('#libStat');
    if (lib) {
      const cs = visibleCats();
      const n = cs.reduce((a, c) => a + c.tags.length, 0);
      lib.textContent = `${n} 个标签 · ${MAJORS.length} 大类 / ${cs.length} 小类 · ${CHARS.length} 个角色 · ${PRESETS.length} 个预设`;
    }
  }


  /* =====================================================================
     8.8 V5 迭代升级：独立随机高级设置弹窗、自定义随机开关、右侧持久侧边栏、
         右上角灯泡切换昼夜毛玻璃主题、外部数据动态挂载与拖拽排序持久化
     ===================================================================== */

  /* ---------- 1. 全量操作撤回与重做 (Ctrl+Z / Ctrl+Y) ---------- */
  function captureCurrentSnapshot(includeTree) {
    ensureBatchState();
    const fs = window.PG_TAG_FS;
    return {
      includeTree: !!includeTree,
      majors: includeTree ? JSON.parse(JSON.stringify((fs && fs.majors) || [])) : null,
      charMajors: includeTree ? JSON.parse(JSON.stringify((fs && fs.charMajors) || [])) : null,
      layoutOrder: JSON.parse(JSON.stringify((fs && fs.layoutOrder) || {})),
      ratingOverrides: JSON.parse(JSON.stringify(state.ratingOverrides || {})),
      nsfwCustomOn: Array.from(state.nsfwCustomOn || []),
      nsfwCustomOff: Array.from(state.nsfwCustomOff || []),
      sel: JSON.parse(JSON.stringify(state.sel || [])),
      neg: JSON.parse(JSON.stringify(state.neg || [])),
      chars: JSON.parse(JSON.stringify(state.chars || [])),
      custom: JSON.parse(JSON.stringify(state.custom || [])),
      favTags: (state.favTags || []).slice(),
      recentTags: (state.recentTags || []).slice(),
      favChars: (state.favChars || []).slice(),
      recentChars: (state.recentChars || []).slice(),
      recentCharTags: (state.recentCharTags || []).slice(),
      customChars: JSON.parse(JSON.stringify(state.customChars || [])),
      customTagCats: JSON.parse(JSON.stringify(state.customTagCats || [])),
      charCustomSubs: JSON.parse(JSON.stringify(state.charCustomSubs || [])),
      charDeletedSubs: (state.charDeletedSubs || []).slice(),
      charDel: (CUSTOM.charDel || []).slice(),
      customLibChars: JSON.parse(JSON.stringify(CUSTOM.chars || [])),
      saves: JSON.parse(JSON.stringify(SAVES || [])),
      randCfg: JSON.parse(JSON.stringify(state.randCfg || {})),
      seenNewTags: Array.from(state.seenNewTagsSet || state.seenNewTags || []),
      seenNewChars: Array.from(state.seenNewCharsSet || state.seenNewChars || []),
      customTpls: JSON.parse(JSON.stringify(state.customTpls || [])),
      deletedTplIds: (state.deletedTplIds || []).slice(),
      customPresets: JSON.parse(JSON.stringify(CUSTOM.presets || [])),
      customPresetEdit: JSON.parse(JSON.stringify(CUSTOM.presetEdit || {})),
      customPresetDel: (CUSTOM.presetDel || []).slice(),
      presetsSnap: JSON.parse(JSON.stringify(PRESETS || [])),
      history: JSON.parse(JSON.stringify(state.history || [])),
      autoOrder: !!state.autoOrder,
      mossMode: !!state.mossMode,
      mode: state.mode || 'pos',
      cat: state.cat,
      expandedSubs: (state.expandedSubs || []).slice(),
      charNavOpen: !!state.charNavOpen,
      posNavOpen: !!state.posNavOpen,
      nsfwNavOpen: !!state.nsfwNavOpen
    };
  }

  async function applyHistorySnapshot(snap) {
    if (!snap) return;
    ensureBatchState();
    const fs = window.PG_TAG_FS;
    if (fs && Array.isArray(snap.majors) && snap.majors.length) {
      fs.majors = JSON.parse(JSON.stringify(snap.majors));
      await fs.persistOp({ action: 'sync_all', majors: fs.majors });
    }
    if (fs && Array.isArray(snap.charMajors) && snap.charMajors.length) {
      fs.charMajors = JSON.parse(JSON.stringify(snap.charMajors));
    }
    if (snap.ratingOverrides && typeof snap.ratingOverrides === 'object') {
      state.ratingOverrides = JSON.parse(JSON.stringify(snap.ratingOverrides));
    }
    if (Array.isArray(snap.nsfwCustomOn)) state.nsfwCustomOn = new Set(snap.nsfwCustomOn);
    if (Array.isArray(snap.nsfwCustomOff)) state.nsfwCustomOff = new Set(snap.nsfwCustomOff);
    if (Array.isArray(snap.recentCharTags)) state.recentCharTags = snap.recentCharTags.slice();
    if (fs && snap.layoutOrder && typeof snap.layoutOrder === 'object') {
      fs.layoutOrder = JSON.parse(JSON.stringify(snap.layoutOrder));
      fs.persistLayoutFile(fs.layoutOrder);
    }
    state.sel = JSON.parse(JSON.stringify(snap.sel || []));
    state.neg = JSON.parse(JSON.stringify(snap.neg || []));
    state.chars = JSON.parse(JSON.stringify(snap.chars || []));
    if (Array.isArray(snap.custom)) state.custom = JSON.parse(JSON.stringify(snap.custom));
    state.favTags = (snap.favTags || []).slice();
    state.recentTags = (snap.recentTags || []).slice();
    if (Array.isArray(snap.favChars)) state.favChars = snap.favChars.slice();
    if (Array.isArray(snap.recentChars)) state.recentChars = snap.recentChars.slice();
    if (Array.isArray(snap.customChars)) state.customChars = JSON.parse(JSON.stringify(snap.customChars));
    if (Array.isArray(snap.customTagCats)) state.customTagCats = JSON.parse(JSON.stringify(snap.customTagCats));
    if (Array.isArray(snap.charCustomSubs)) state.charCustomSubs = JSON.parse(JSON.stringify(snap.charCustomSubs));
    if (Array.isArray(snap.charDeletedSubs)) state.charDeletedSubs = snap.charDeletedSubs.slice();
    if (Array.isArray(snap.charDel)) CUSTOM.charDel = snap.charDel.slice();
    if (Array.isArray(snap.customLibChars)) {
      CUSTOM.chars = JSON.parse(JSON.stringify(snap.customLibChars));
      saveCustom();
    }
    if (Array.isArray(snap.saves)) {
      SAVES = JSON.parse(JSON.stringify(snap.saves));
      saveSaves();
      if (typeof renderSaves === 'function') renderSaves();
    }
    if (snap.randCfg && typeof snap.randCfg === 'object') {
      const prevSchemeIds = new Set(((state.randCfg && state.randCfg.schemes) || []).map(x => x && x.id).filter(Boolean));
      state.randCfg = JSON.parse(JSON.stringify(snap.randCfg));
      ensureRandCfgStructure();
      const nextSchemes = (state.randCfg && state.randCfg.schemes) || [];
      const nextSchemeIds = new Set(nextSchemes.map(x => x && x.id).filter(Boolean));
      nextSchemes.forEach(sc => { if (sc && sc.id) persistLibraryItemToFolder('random_schemes', sc); });
      prevSchemeIds.forEach(id => { if (!nextSchemeIds.has(id)) deleteLibraryItemFromFolder('random_schemes', id); });
      if (typeof syncSchemeLabelUI === 'function') syncSchemeLabelUI();
      if (typeof renderRandSwitchBar === 'function') renderRandSwitchBar();
    }
    if (Array.isArray(snap.seenNewTags)) {
      state.seenNewTags = snap.seenNewTags.slice();
      state.seenNewTagsSet = new Set(state.seenNewTags);
    }
    if (Array.isArray(snap.seenNewChars)) {
      state.seenNewChars = snap.seenNewChars.slice();
      state.seenNewCharsSet = new Set(state.seenNewChars);
    }
    if (Array.isArray(snap.customTpls) || Array.isArray(snap.deletedTplIds)) {
      const prevTpls = (typeof getEffectiveTpls === 'function') ? getEffectiveTpls() : [];
      const prevTplMap = new Map(prevTpls.map(t => [t.id, JSON.stringify(t)]));
      if (Array.isArray(snap.customTpls)) state.customTpls = JSON.parse(JSON.stringify(snap.customTpls));
      if (Array.isArray(snap.deletedTplIds)) state.deletedTplIds = snap.deletedTplIds.slice();
      const nextTpls = (typeof getEffectiveTpls === 'function') ? getEffectiveTpls() : [];
      const nextTplIds = new Set(nextTpls.map(t => t.id));
      nextTpls.forEach(t => {
        if (!prevTplMap.has(t.id) || prevTplMap.get(t.id) !== JSON.stringify(t)) {
          persistLibraryItemToFolder('templates', t);
        }
      });
      prevTplMap.forEach((_, tid) => {
        if (!nextTplIds.has(tid)) deleteLibraryItemFromFolder('templates', tid);
      });
      if (typeof renderTplModal === 'function') renderTplModal();
    }
    if (Array.isArray(snap.presetsSnap)) {
      const prevPresetMap = new Map(PRESETS.map(p => [p.key, p]));
      if (Array.isArray(snap.customPresets)) CUSTOM.presets = JSON.parse(JSON.stringify(snap.customPresets));
      if (snap.customPresetEdit && typeof snap.customPresetEdit === 'object') CUSTOM.presetEdit = JSON.parse(JSON.stringify(snap.customPresetEdit));
      if (Array.isArray(snap.customPresetDel)) CUSTOM.presetDel = snap.customPresetDel.slice();
      saveCustom();
      PRESETS.length = 0;
      snap.presetsSnap.forEach(p => PRESETS.push(JSON.parse(JSON.stringify(p))));
      const nextPresetIds = new Set(PRESETS.map(p => p.key));
      PRESETS.forEach(p => {
        const prev = prevPresetMap.get(p.key);
        if (!prev || JSON.stringify(prev) !== JSON.stringify(p)) {
          persistLibraryItemToFolder('presets', {
            key: p.key, id: p.key, name: p.name, desc: p.desc || '', cat: p.cat || '场景',
            tags: (p.tags || []).map(t => (t.zh ? t.en + '|' + t.zh : t.en)).join(';'),
            custom: !!p.custom
          });
        }
      });
      prevPresetMap.forEach((_, pk) => {
        if (!nextPresetIds.has(pk)) deleteLibraryItemFromFolder('presets', pk);
      });
      if (typeof renderPresetModal === 'function') renderPresetModal();
    }
    if (Array.isArray(snap.history)) state.history = JSON.parse(JSON.stringify(snap.history));
    if (typeof snap.autoOrder === 'boolean') {
      state.autoOrder = snap.autoOrder;
      if ($('#chkOrder')) $('#chkOrder').checked = state.autoOrder;
    }
    if (typeof snap.mossMode === 'boolean') {
      state.mossMode = snap.mossMode;
      state.model = state.mossMode ? 'moss' : 'anima';
      if ($('#chkMossMode')) $('#chkMossMode').checked = state.mossMode;
      if ($('#mossBox')) $('#mossBox').hidden = !state.mossMode;
    }
    if (snap.mode) {
      state.mode = snap.mode;
      syncModeSeg();
    }
    if (snap.cat) state.cat = snap.cat;
    if (Array.isArray(snap.expandedSubs)) state.expandedSubs = snap.expandedSubs.slice();
    if (typeof snap.charNavOpen === 'boolean') state.charNavOpen = snap.charNavOpen;
    if (typeof snap.posNavOpen === 'boolean') state.posNavOpen = snap.posNavOpen;
    if (typeof snap.nsfwNavOpen === 'boolean') state.nsfwNavOpen = snap.nsfwNavOpen;
    _selCache = { key: '', set: new Set() };
    syncCharTags();
    refreshAllFromTree();
    renderSelected();
    renderOutput();
    renderHistory();
    save(true);
  }

  function recordHistorySnapshot(label, includeTree) {
    const entry = {
      id: 'op_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5),
      label: String(label || '页面操作'),
      at: new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      snap: captureCurrentSnapshot(!!includeTree)
    };
    state.undoStack = [entry].concat(state.undoStack || []).slice(0, 20);
    state.redoStack = [];
  }

  async function undoLastAction(targetOpId) {
    const uList = state.undoStack || [];
    if (!uList.length) {
      toast('没有可撤销的操作');
      return;
    }
    let idx = 0;
    if (targetOpId) {
      const found = uList.findIndex(x => x.id === targetOpId);
      if (found >= 0) idx = found;
    }
    let lastUndoneLabel = '';
    for (let step = 0; step <= idx; step++) {
      const curEntry = state.undoStack.shift();
      if (!curEntry) break;
      lastUndoneLabel = curEntry.label;
      state.redoStack = [{
        id: 'redo_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5),
        label: curEntry.label,
        at: new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        snap: captureCurrentSnapshot(true)
      }].concat(state.redoStack || []).slice(0, 20);
      await applyHistorySnapshot(curEntry.snap);
    }
    toast(`⏪ 已撤销：${lastUndoneLabel}`);
  }

  async function redoLastAction(targetRedoId) {
    const rList = state.redoStack || [];
    if (!rList.length) {
      toast('没有可重做的操作');
      return;
    }
    let idx = 0;
    if (targetRedoId) {
      const found = rList.findIndex(x => x.id === targetRedoId);
      if (found >= 0) idx = found;
    }
    let lastRedoneLabel = '';
    for (let step = 0; step <= idx; step++) {
      const curEntry = state.redoStack.shift();
      if (!curEntry) break;
      lastRedoneLabel = curEntry.label;
      state.undoStack = [{
        id: 'op_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5),
        label: curEntry.label,
        at: new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        snap: captureCurrentSnapshot(true)
      }].concat(state.undoStack || []).slice(0, 20);
      await applyHistorySnapshot(curEntry.snap);
    }
    toast(`⏩ 已重做：${lastRedoneLabel}`);
  }


  /* ---------- 2. 随机组合独立高级设置窗口（V1.2.2：简化开关窗口 + 右键重命名/删除新增开关 + 区间抽取规则范围选择与添加/禁止合并） ---------- */
  let _rsActiveTab = 'switches';

  function switchRsTab(tabName) {
    _rsActiveTab = (tabName === 'rules') ? 'rules' : 'switches';
    const bSw = $('#btnRsTabSwitches');
    const bRl = $('#btnRsTabRules');
    const pSw = $('#rsTabPanelSwitches');
    const pRl = $('#rsTabPanelRules');
    if (bSw) bSw.classList.toggle('active', _rsActiveTab === 'switches');
    if (bRl) bRl.classList.toggle('active', _rsActiveTab === 'rules');
    if (pSw) pSw.hidden = (_rsActiveTab !== 'switches');
    if (pRl) pRl.hidden = (_rsActiveTab !== 'rules');
    closeRsPopovers();
  }

  function closeRsPopovers() {
    ['#rsCascadePopover', '#rsIntervalListPopover', '#rsSchemePopover', '#rsRuleScopePopover', '#rsFixedSuggestPopover', '#stMajorSwitchPopover'].forEach(q => {
      const el = $(q);
      if (el) el.hidden = true;
    });
    if (typeof hideContextMenu === 'function') hideContextMenu();
  }

  function getFixedTagsArray() {
    const rcfg = ensureRandCfgStructure();
    return String(rcfg.fixedTags || '')
      .split(/[,，]+/)
      .map(s => s.trim())
      .filter(Boolean);
  }

  function setFixedTagsArray(arr) {
    const rcfg = ensureRandCfgStructure();
    const seen = new Set();
    const cleanArr = [];
    (arr || []).forEach(raw => {
      const resolved = resolveFixedTagFromLibrary(raw);
      if (!resolved) return;
      if (seen.has(resolved.key)) return;
      seen.add(resolved.key);
      cleanArr.push(resolved.en);
    });
    rcfg.fixedTags = cleanArr.join(', ');
    if ($('#rsFixedTags')) $('#rsFixedTags').value = rcfg.fixedTags;
  }

  function renderFixedTagsChipsUI() {
    const wrap = $('#rsFixedChipsWrap');
    const hiddenInp = $('#rsFixedTags');
    const rcfg = ensureRandCfgStructure();
    if (hiddenInp) hiddenInp.value = rcfg.fixedTags || '';
    if (!wrap) return;
    const items = getFixedTagsArray();
    wrap.innerHTML = items.map((tok, idx) => {
      const info = resolveFixedTagFromLibrary(tok) || { en: tok, zh: '' };
      return `<span class="rs-fixed-pill" data-fixed-idx="${idx}" title="${esc(info.en)}${info.zh ? ' · ' + esc(info.zh) : ''}（点击 × 移除）">
        <span class="en">${esc(info.en)}</span>
        ${info.zh ? `<span class="zh">${esc(info.zh)}</span>` : ''}
        <button type="button" class="rs-fixed-del" data-fixed-del="${idx}">×</button>
      </span>`;
    }).join('');
  }

  function addFixedTagToken(rawText) {
    const parts = String(rawText || '').split(/[,，]+/).map(s => s.trim()).filter(Boolean);
    if (!parts.length) return;
    ensureEditableSchemeOnModify();
    const cur = getFixedTagsArray();
    parts.forEach(p => {
      const resolved = resolveFixedTagFromLibrary(p);
      if (resolved) cur.push(resolved.en);
    });
    setFixedTagsArray(cur);
    syncActiveSchemeSnapshot();
    renderFixedTagsChipsUI();
  }

  function openFixedTagSuggestPopover(queryStr, inputEl) {
    const pop = $('#rsFixedSuggestPopover');
    if (!pop || !inputEl) return;
    const q = String(queryStr || '').trim().toLowerCase();
    if (!q) {
      pop.hidden = true;
      return;
    }
    const matches = [];
    const seen = new Set(getFixedTagsArray().map(x => norm(cleanArtistEn(x))));
    for (const c of CATS) {
      for (const t of (c.tags || [])) {
        const k = norm(cleanArtistEn(t.en));
        if (!k || seen.has(k)) continue;
        if (t.en.toLowerCase().includes(q) || (t.zh && t.zh.toLowerCase().includes(q))) {
          matches.push({ en: t.en, zh: t.zh || '', catName: c.name });
          if (matches.length >= 8) break;
        }
      }
      if (matches.length >= 8) break;
    }
    if (!matches.length) {
      pop.hidden = true;
      return;
    }
    pop.innerHTML = matches.map(m => `
      <div class="rs-iv-item" data-fixed-sug="${esc(m.en)}">
        <span><b>${esc(m.en)}</b> ${m.zh ? `<span class="muted">(${esc(m.zh)})</span>` : ''}</span>
        <span class="muted small">${esc(m.catName)}</span>
      </div>
    `).join('');
    const boxEl = document.getElementById('rsFixedChipBox') || inputEl;
    const boxRect = boxEl.getBoundingClientRect();
    const inpRect = inputEl.getBoundingClientRect();
    pop.style.maxHeight = '200px';
    pop.style.overflowY = 'auto';
    pop.hidden = false;
    const popH = pop.offsetHeight || Math.min(200, matches.length * 36 + 16);
    const leftPos = Math.min(window.innerWidth - 270, Math.max(8, inpRect.left || boxRect.left));
    const topPos = Math.max(8, boxRect.top - popH - 8);
    pop.style.left = leftPos + 'px';
    pop.style.top = topPos + 'px';
    pop.style.bottom = 'auto';
    pop.onclick = e => {
      e.stopPropagation();
      const item = e.target.closest('[data-fixed-sug]');
      if (!item) return;
      const en = item.getAttribute('data-fixed-sug');
      inputEl.value = '';
      pop.hidden = true;
      addFixedTagToken(en);
    };
  }

  function openRandomSettingsModal(preferTab) {
    ensureRandCfgStructure();
    _rsSavedBackup = JSON.parse(JSON.stringify(state.randCfg));
    _rsCommittedSave = false;
    syncSchemeLabelUI();
    renderFixedTagsChipsUI();
    openModal('modalRandomSettings');
    const targetTab = preferTab || _rsActiveTab || 'switches';
    switchRsTab(targetTab);
    if (targetTab === 'switches') renderRsSwitchesTable();
    else renderRsCatRulesTable();
    const body = $('#modalRandomSettings .modal-body');
    if (body) body.scrollLeft = 0;
  }

  /* V1.2.2 Req 2: 简化后的开关列表（仅显示开关名称与开关介绍，支持右键重命名与删除新增开关） */
  function renderRsSwitchesTable() {
    const tbody = $('#rsSwitchesBody');
    if (!tbody) return;
    const rcfg = ensureRandCfgStructure();

    tbody.innerHTML = (rcfg.switches || []).map((sw, idx) => {
      const descText = getSwitchRuleSummaryText(sw);
      sw.desc = descText;
      const badgeHtml = sw.builtin
        ? `<span class="rs-sw-badge">默认</span>`
        : `<span class="rs-sw-badge" style="background:rgba(52,211,153,0.16);color:#34d399">自定义</span>`;
      return `<tr data-sw-idx="${idx}" data-sw-id="${esc(sw.id)}" title="右键此开关可重命名${sw.builtin ? '' : '或删除'}；点击右侧可在「随机抽取」中编辑其区间规则">
        <td>
          <label class="chk rs-sw-name-wrap" onclick="event.stopPropagation()">
            <input type="checkbox" data-rs-sw-field="enabled" ${sw.enabled ? 'checked' : ''}>
            <span class="rs-sw-name-txt">${esc(sw.name)}</span>
            ${badgeHtml}
          </label>
        </td>
        <td class="rs-sw-desc-cell" data-rs-sw-jump="${esc(sw.id)}">
          <span>${esc(descText)}</span>
        </td>
      </tr>`;
    }).join('');
  }

  function getActiveRuleScopeList(rcfg) {
    const scope = rcfg.activeRuleScope || 'default';
    if (scope === 'default') {
      if (!Array.isArray(rcfg.drawRules)) rcfg.drawRules = buildDefaultDrawRulesV122();
      return rcfg.drawRules;
    }
    const sw = (rcfg.switches || []).find(s => s && s.id === scope);
    if (!sw) {
      rcfg.activeRuleScope = 'default';
      return rcfg.drawRules;
    }
    if (!Array.isArray(sw.rules)) sw.rules = [];
    return sw.rules;
  }

  function getScopeDisplayName(rcfg, scopeId) {
    const sc = scopeId || rcfg.activeRuleScope || 'default';
    if (sc === 'default') return '📌 默认抽取';
    const sw = (rcfg.switches || []).find(s => s && s.id === sc);
    return sw ? `🎛 ${sw.name}` : '📌 默认抽取';
  }

  function openRsRuleScopePopover(anchorEl) {
    closeRsPopovers();
    const pop = $('#rsRuleScopePopover');
    if (!pop || !anchorEl) return;
    const rcfg = ensureRandCfgStructure();
    const curScope = rcfg.activeRuleScope || 'default';

    const itemsHtml = [
      `<div class="rs-iv-item ${curScope === 'default' ? 'active' : ''}" data-rule-scope-pick="default" title="原本默认就要抽取的 24 个基础区间">
        <span>📌 默认抽取 <span class="muted small">(${(rcfg.drawRules || []).length}项)</span></span>
        ${curScope === 'default' ? '<span style="color:var(--accent2)">✓</span>' : ''}
      </div>`
    ].concat((rcfg.switches || []).map(sw => {
      const isAct = (curScope === sw.id);
      const rLen = Array.isArray(sw.rules) ? sw.rules.length : 0;
      return `<div class="rs-iv-item ${isAct ? 'active' : ''}" data-rule-scope-pick="${esc(sw.id)}" title="${esc(getSwitchRuleSummaryText(sw))}">
        <span>🎛 ${esc(sw.name)} <span class="muted small">(${rLen}项${sw.enabled ? ' · 已开启' : ''})</span></span>
        ${isAct ? '<span style="color:var(--accent2)">✓</span>' : ''}
      </div>`;
    })).join('');

    pop.innerHTML = itemsHtml;
    const rect = anchorEl.getBoundingClientRect();
    pop.hidden = false;
    pop.style.minWidth = '210px';
    pop.style.left = Math.min(window.innerWidth - 230, Math.max(8, rect.left)) + 'px';
    pop.style.top = Math.min(window.innerHeight - 280, rect.bottom + 4) + 'px';

    pop.onclick = e => {
      e.stopPropagation();
      const item = e.target.closest('[data-rule-scope-pick]');
      if (!item) return;
      syncRandomSettingsFromDOM(false);
      const nextScope = item.getAttribute('data-rule-scope-pick') || 'default';
      rcfg.activeRuleScope = nextScope;
      closeRsPopovers();
      renderRsCatRulesTable();
    };
  }

  /* 级联分类选择器（支持角色库 + 6大正向分类 + NSFW映射 + 自定义） */
  function openRsCascadePopover(anchorEl, options) {
    closeRsPopovers();
    const pop = $('#rsCascadePopover');
    if (!pop || !anchorEl) return;
    ensureCustomCategoriesStructure();
    const onlyChar = !!(options && options.onlyChar);
    const onPick = options && options.onPick;

    if (onlyChar) {
      pop.innerHTML = `
        <div class="rs-cascade-majors" style="min-width:165px">
          <button type="button" class="rs-cas-item" data-cas-pick="char:library"><span>🧝 角色库</span><span class="muted">(${CHARS.length})</span></button>
          <button type="button" class="rs-cas-item" data-cas-pick="char:custom"><span>⭐ 自定义的角色</span><span class="muted">(${(state.customChars || []).length})</span></button>
        </div>
      `;
    } else {
      const majorList = [
        {
          id: 'char_group_cas',
          pickId: 'char:library',
          name: '角色库',
          icon: '🧝',
          subs: [
            { id: 'char:library', name: '角色库', icon: '🧝', count: CHARS.length },
            { id: 'char:custom', name: '自定义的角色', icon: '⭐', count: (state.customChars || []).length }
          ]
        }
      ];
      MAJORS.filter(m => m.id !== 'negative').forEach(m => {
        majorList.push({
          id: m.id,
          pickId: 'major:' + m.id,
          name: m.name,
          icon: m.icon || '📁',
          subs: (m.children || []).filter(s => s.id !== 'negative').map(s => ({
            id: s.id,
            name: s.name,
            icon: s.icon || '•',
            count: (s.tags || []).length
          }))
        });
      });
      const nsfwMajors = getMappedNsfwMajors();
      const nsfwSubs = getMappedNsfwSubcategories();
      const totalNsfwCount = nsfwSubs.reduce((sum, s) => sum + s.tags.length, 0);
      const nsfwCasSubs = [
        { id: 'nsfw_mapped:all', name: '全部 NSFW (橙+红)', icon: '🔞', count: totalNsfwCount }
      ];
      nsfwMajors.forEach(nm => {
        nsfwCasSubs.push({
          id: 'nsfw_major:' + nm.id,
          name: `${nm.name} (NSFW大类)`,
          icon: nm.icon || '📁',
          count: nm.totalTags
        });
      });
      nsfwSubs.forEach(ns => {
        nsfwCasSubs.push({
          id: 'nsfw_sub:' + ns.id,
          name: `${ns.parentName} › ${ns.name}`,
          icon: ns.icon || '•',
          count: ns.tags.length
        });
      });
      majorList.push({
        id: 'nsfw_mapped',
        pickId: 'nsfw_mapped:all',
        name: 'NSFW (橙+红)',
        icon: '🔞',
        subs: nsfwCasSubs
      });
      majorList.push({
        id: 'custom',
        pickId: 'major:custom',
        name: '自定义',
        icon: '⭐',
        subs: (state.customTagCats || []).map(c => ({
          id: c.id,
          name: c.name,
          icon: c.icon || '🏷',
          count: (c.tags || []).length
        }))
      });

      const renderSubsOfMajor = (mid) => {
        const mObj = majorList.find(x => x.id === mid);
        if (!mObj || !mObj.subs.length) return '';
        return mObj.subs.map(s => `
          <button type="button" class="rs-cas-item" data-cas-pick="${esc(s.id)}">
            <span>${esc(s.icon)} ${esc(s.name)}</span>
            <span class="muted">${s.count}</span>
          </button>
        `).join('');
      };

      pop.innerHTML = `
        <div class="rs-cascade-wrap">
          <div class="rs-cascade-majors" id="rsCasMajorsCol">
            ${majorList.map(m => `
              <button type="button" class="rs-cas-item" data-cas-major="${esc(m.id)}" data-cas-pick="${esc(m.pickId)}">
                <span>${esc(m.icon)} ${esc(m.name)}</span>
                <span class="muted">▸</span>
              </button>
            `).join('')}
          </div>
          <div class="rs-cascade-subs" id="rsCasSubsCol" hidden></div>
        </div>
      `;

      const majorsCol = pop.querySelector('#rsCasMajorsCol');
      const subsCol = pop.querySelector('#rsCasSubsCol');
      if (majorsCol && subsCol) {
        majorsCol.addEventListener('mouseover', e => {
          const mBtn = e.target.closest('[data-cas-major]');
          if (!mBtn) return;
          const mid = mBtn.getAttribute('data-cas-major');
          majorsCol.querySelectorAll('.rs-cas-item').forEach(b => b.classList.toggle('active', b === mBtn));
          const subHtml = renderSubsOfMajor(mid);
          if (subHtml) {
            subsCol.innerHTML = subHtml;
            subsCol.hidden = false;
          } else {
            subsCol.innerHTML = '';
            subsCol.hidden = true;
          }
        });
      }
    }

    const rect = anchorEl.getBoundingClientRect();
    pop.hidden = false;
    pop.style.left = Math.min(window.innerWidth - 380, Math.max(8, rect.left)) + 'px';
    pop.style.top = Math.min(window.innerHeight - 340, Math.max(8, rect.bottom + 4)) + 'px';

    pop.onclick = e => {
      e.stopPropagation();
      const pickBtn = e.target.closest('[data-cas-pick]');
      if (!pickBtn) return;
      const chosenId = pickBtn.getAttribute('data-cas-pick');
      closeRsPopovers();
      if (typeof onPick === 'function' && chosenId) {
        onPick(chosenId);
      }
    };
  }

  /* 点击「📂 方案」按钮展开已有方案（默认方案 + 用户方案 + 新增方案按钮），支持右键重命名和删除 */
  function persistRandSchemeToFolder(sc) {
    persistLibraryItemToFolder('random_schemes', sc);
  }
  function deleteRandSchemeFromFolder(id) {
    deleteLibraryItemFromFolder('random_schemes', id);
  }
  function exportRandSchemeJson(sc) {
    if (!sc) return;
    const payload = JSON.stringify(sc, null, 2);
    const blob = new Blob([payload], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (String(sc.name || sc.id || 'scheme').replace(/[\\/:*?"<>|]+/g, '_')) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('📤 已导出随机组合方案：' + (sc.name || sc.id) + '.json');
  }

  function openRsSchemePopover(anchorEl) {
    closeRsPopovers();
    const pop = $('#rsSchemePopover');
    if (!pop || !anchorEl) return;
    const rcfg = ensureRandCfgStructure();
    const actId = rcfg.activeSchemeId || 'default';

    const buildSchemeHtml = () => {
      const schemes = rcfg.schemes || [];
      return `
        <div class="rs-iv-item ${actId === 'default' ? 'active' : ''}" data-scheme-pick="default" title="点击切换到默认方案（修改默认方案会自动新建并保存至方案1）">
          <span>📌 默认方案</span>
          ${actId === 'default' ? '<span style="color:var(--accent2)">✓</span>' : ''}
        </div>
        ${schemes.map(sc => `
          <div class="rs-iv-item ${actId === sc.id ? 'active' : ''}" data-scheme-pick="${esc(sc.id)}" data-scheme-id="${esc(sc.id)}" title="左键切换方案 · 右键可重命名或删除此方案">
            <span>📄 ${esc(sc.name)}</span>
            ${actId === sc.id ? '<span style="color:var(--accent2)">✓</span>' : ''}
          </div>
        `).join('')}
        <div style="border-top:1px solid var(--line);margin-top:4px;padding-top:4px;display:flex;gap:4px">
          <button type="button" class="rs-cas-item" id="btnRsCreateSchemeNow" style="flex:1;justify-content:center;color:var(--accent2);font-weight:600">＋ 新增方案</button>
          <button type="button" class="rs-cas-item" id="btnRsImportSchemeNow" style="flex:1;justify-content:center;color:var(--pos);font-weight:600" title="从外部导入 .json 随机组合方案并保存至 libraries/libraries/random_schemes/ 文件夹">📥 导入方案</button>
        </div>
      `;
    };

    pop.innerHTML = buildSchemeHtml();
    const rect = anchorEl.getBoundingClientRect();
    pop.hidden = false;
    pop.style.left = Math.min(window.innerWidth - 230, Math.max(8, rect.left)) + 'px';
    pop.style.top = Math.min(window.innerHeight - 260, rect.bottom + 4) + 'px';

    pop.onclick = e => {
      e.stopPropagation();
      if (e.target.closest('#btnRsCreateSchemeNow')) {
        let idx = 1;
        const existingNames = new Set((rcfg.schemes || []).map(s => s.name));
        while (existingNames.has('方案' + idx)) idx++;
        const newName = '方案' + idx;
        const newSc = {
          id: 'scheme_' + idx + '_' + Date.now().toString(36),
          name: newName,
          data: snapshotRandSchemeData(rcfg)
        };
        rcfg.schemes.push(newSc);
        rcfg.activeSchemeId = newSc.id;
        persistRandSchemeToFolder(newSc);
        syncSchemeLabelUI();
        save();
        closeRsPopovers();
        toast(`✅ 已新建并保存方案「${newName}」至 libraries/random_schemes/`);
        return;
      }
      if (e.target.closest('#btnRsImportSchemeNow')) {
        const fi = $('#fileImportRandScheme');
        if (fi) {
          fi.value = '';
          fi.onchange = async ev => {
            const file = ev.target.files && ev.target.files[0];
            if (!file) return;
            try {
              const txt = await file.text();
              const parsed = JSON.parse(txt);
              const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.schemes) ? parsed.schemes : [parsed]);
              let added = 0;
              list.forEach(rawSc => {
                if (!rawSc || typeof rawSc !== 'object') return;
                const scData = rawSc.data || rawSc;
                const baseName = String(rawSc.name || file.name.replace(/\.json$/i, '') || '导入方案').trim();
                const newId = 'scheme_imp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5);
                const newSc = { id: newId, name: baseName, data: JSON.parse(JSON.stringify(scData)) };
                rcfg.schemes.push(newSc);
                persistRandSchemeToFolder(newSc);
                rcfg.activeSchemeId = newId;
                added++;
              });
              if (added > 0) {
                applyRandSchemeById(rcfg.activeSchemeId);
                syncSchemeLabelUI();
                save();
                closeRsPopovers();
                toast(`📥 成功导入 ${added} 个随机组合方案并保存至 libraries/random_schemes/`);
              } else {
                toast('未检测到有效的随机组合方案 JSON');
              }
            } catch (err) {
              toast('导入失败：JSON 文件格式无效');
            }
          };
          fi.click();
        }
        return;
      }
      const pickEl = e.target.closest('[data-scheme-pick]');
      if (pickEl) {
        const sid = pickEl.getAttribute('data-scheme-pick');
        applyRandSchemeById(sid);
        closeRsPopovers();
        toast(`已切换到方案：${sid === 'default' ? '默认方案' : ((rcfg.schemes.find(x => x.id === sid) || {}).name || '')}`);
      }
    };

    pop.oncontextmenu = e => {
      const item = e.target.closest('[data-scheme-id]');
      if (!item) return;
      e.preventDefault();
      e.stopPropagation();
      const sid = item.getAttribute('data-scheme-id');
      const sc = (rcfg.schemes || []).find(x => x.id === sid);
      if (!sc) return;
      placeContextMenu(e.clientX, e.clientY, `
        <div class="ctx-menu-head">📂 方案：${esc(sc.name)}</div>
        <button type="button" data-ctx-scheme="export" data-sid="${esc(sid)}">📤 导出方案 (.json)</button>
        <button type="button" data-ctx-scheme="rename" data-sid="${esc(sid)}">✎ 重命名方案</button>
        <button type="button" class="danger" data-ctx-scheme="delete" data-sid="${esc(sid)}">🗑 删除方案</button>
      `);
    };
  }

  /* V1.2.3 Req 1: 6列区间抽取规则表格渲染（支持点击大分类展开所属小分类概率设置，概率和恒为 1.00，支持抽取数量区间 minCount~maxCount） */
  function renderRsCatRulesTable() {
    const tbody = $('#rsCatRulesBody');
    if (!tbody) return;
    const rcfg = ensureRandCfgStructure();
    const curScope = rcfg.activeRuleScope || 'default';
    const rules = getActiveRuleScopeList(rcfg);

    const scopeLbl = $('#rsRuleScopeLabel');
    if (scopeLbl) scopeLbl.textContent = getScopeDisplayName(rcfg, curScope);

    const nsfwMinWrap = $('#rsNsfwMinCountWrap');
    if (nsfwMinWrap) {
      nsfwMinWrap.hidden = (curScope !== 'sw_nsfw');
    }
    if ($('#rsNsfwMinCountInput')) {
      $('#rsNsfwMinCountInput').value = clamp(Number(rcfg.nsfwMinCount ?? 2), 0, 15);
    }

    const hintBar = $('#rsRuleScopeHintBar');
    if (hintBar) {
      if (curScope === 'default') {
        hintBar.textContent = '📌 默认抽取：已调低道具及不常用项概率，环境大分类 70% 概率最多抽取 1 个小分类。点击任意带「▾/▸」的大分类行可展开设置其所属小分类抽取概率（小分类概率和恒为 1.00）。';
      } else {
        const sw = (rcfg.switches || []).find(s => s && s.id === curScope);
        hintBar.textContent = sw ? `🎛 当前编辑开关「${sw.name}」：${getSwitchRuleSummaryText(sw)}` : '';
      }
    }

    const rowsHtml = [];
    rules.forEach((r, idx) => {
      const isForbid = (r.attr === 'forbid');
      const isFixed = (r.mode === 'fixed');
      const curLv = (r.level === 'nsfw') ? 'nsfw' : 'sfw';
      const isMajor = !!(r.isMajorGroup || String(r.targetId || '').indexOf('major:') === 0);
      if (isMajor && !isForbid && (!Array.isArray(r.subWeights) || !r.subWeights.length)) {
        r.subWeights = getDefaultSubWeightsForMajor(r.targetId, curLv);
      }
      const label = formatTargetIntervalShortName(r.targetId);
      const minC = clamp(Number(r.minCount ?? r.count ?? 1), 1, 15);
      const maxC = clamp(Number(r.maxCount ?? r.count ?? minC), minC, 15);

      const attrSelectHtml = `<select data-rs-rule-field="attr" class="${isForbid ? 'rs-attr-forbid' : 'rs-attr-add'}" style="width:82px">
        <option value="add" ${!isForbid ? 'selected' : ''}>添加</option>
        <option value="forbid" ${isForbid ? 'selected' : ''}>禁止</option>
      </select>`;

      const modeHtml = isForbid
        ? `<span class="muted">—</span>`
        : `<select data-rs-rule-field="mode" style="width:104px">
            <option value="fixed" ${isFixed ? 'selected' : ''}>固定抽取</option>
            <option value="prob" ${!isFixed ? 'selected' : ''}>概率抽取</option>
          </select>`;

      const levelHtml = isForbid
        ? `<span class="muted">—</span>`
        : `<select data-rs-rule-field="level" style="width:116px">
            <option value="sfw" ${curLv === 'sfw' ? 'selected' : ''}>蓝黄（普通）</option>
            <option value="nsfw" ${curLv === 'nsfw' ? 'selected' : ''}>橙红（限制）</option>
          </select>`;

      let valInputHtml = `<span class="muted">—</span>`;
      if (!isForbid) {
        const rangeInputs = isMajor
          ? `<span class="muted small" title="抽取的小分类数量区间（每个抽中的小分类各抽取1个标签）">抽</span>
             <input type="number" data-rs-rule-field="minCount" min="1" max="15" value="${minC}" style="width:42px" title="最少抽取小分类数">
             <span class="muted small">~</span>
             <input type="number" data-rs-rule-field="maxCount" min="1" max="15" value="${maxC}" style="width:42px" title="最多抽取小分类数">
             <span class="muted small">类</span>`
          : `<input type="number" data-rs-rule-field="count" min="1" max="15" value="${maxC}" style="width:50px"><span class="muted small">个</span>`;

        if (isFixed) {
          valInputHtml = `<div style="display:flex;align-items:center;gap:4px;flex-wrap:nowrap">${rangeInputs}</div>`;
        } else {
          valInputHtml = `<div style="display:flex;align-items:center;gap:4px;flex-wrap:nowrap">
            <input type="number" data-rs-rule-field="prob" min="1" max="100" step="5" value="${clamp(Number(r.prob ?? 70), 1, 100)}" style="width:52px" title="触发抽取的概率"><span class="muted small">%</span>
            ${rangeInputs}
          </div>`;
        }
      }

      const intervalCellHtml = (isMajor && !isForbid)
        ? `<div style="display:flex;align-items:center;gap:5px">
            <button type="button" class="rs-major-expand-btn" data-rs-major-toggle="${idx}" title="点击展开/收起所属小分类抽取概率设置（小分类概率和为 1）">
              <span>${r.expanded ? '▾' : '▸'}</span>
              <span>${esc(label)}</span>
              <span class="muted small">(${(r.subWeights || []).length}子类·和=1)</span>
            </button>
            <button type="button" class="mini ghost" data-rs-rule-pick="${idx}" title="更换大分类或小分类" style="padding:3px 6px">更换</button>
          </div>`
        : `<button type="button" class="rs-multi-trigger rs-iv-only-btn" data-rs-rule-pick="${idx}" title="点击切换此行区间（若选择大分类则可展开设置所属小分类权重）">
            <span class="rmt-label">${esc(label)}</span>
          </button>`;

      rowsHtml.push(`<tr data-rule-idx="${idx}" class="${isForbid ? 'is-forbid-row' : ''}">
        <td>${attrSelectHtml}</td>
        <td>${intervalCellHtml}</td>
        <td>${modeHtml}</td>
        <td>${levelHtml}</td>
        <td>${valInputHtml}</td>
        <td>
          <button type="button" class="mini danger" data-rs-rule-del="${idx}" title="删除此区间规则">删除</button>
        </td>
      </tr>`);

      if (isMajor && !isForbid) {
        r.subWeights = normalizeSubWeightsList(Array.isArray(r.subWeights) && r.subWeights.length ? r.subWeights : getDefaultSubWeightsForMajor(r.targetId, curLv), r.targetId);
      }
      if (isMajor && !isForbid && r.expanded) {
        const subWeights = r.subWeights || [];
        const sumVal = subWeights.reduce((a, x) => a + Number(x.weight || 0), 0).toFixed(2);
        const subCardsHtml = subWeights.map((sw, sIdx) => {
          const sName = formatTargetIntervalShortName(sw.subId);
          return `<div class="rs-subweight-card">
            <span style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(sName)}">${esc(sName)}</span>
            <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
              <input type="number" step="0.05" min="0" max="1" value="${Number(sw.weight ?? 0).toFixed(2)}" data-rs-subw-idx="${idx}" data-rs-subw-sidx="${sIdx}" style="width:62px;text-align:right" title="修改此小分类概率后，其余小分类将自动归一化以保持概率总和为 1.00">
              <span class="muted small">(${Math.round(Number(sw.weight ?? 0) * 100)}%)</span>
            </div>
          </div>`;
        }).join('');

        rowsHtml.push(`<tr class="rs-subweight-drawer-row" data-parent-rule-idx="${idx}">
          <td colspan="6">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
              <span class="small"><b>📂 ${esc(label)} · 所属小分类抽取权重</b> <span class="muted">（当前概率总和：<b>${sumVal}</b> = 1；抽取时按权重不放回随机抽取 ${minC === maxC ? minC : (minC + '~' + maxC)} 个小分类，每个小分类各抽 1 个）</span></span>
              <button type="button" class="mini ghost" data-rs-subw-equal="${idx}" title="将所属小分类概率平均分配（总和为 1.00）">⚖️ 平均分配概率</button>
            </div>
            <div class="rs-subweight-grid">${subCardsHtml}</div>
          </td>
        </tr>`);
      }
    });

    tbody.innerHTML = rowsHtml.join('');
  }

  function syncRandomSettingsFromDOM(isUserModify) {
    if (isUserModify) {
      ensureEditableSchemeOnModify();
    }
    const rcfg = ensureRandCfgStructure();
    if ($('#rsFixedTags')) rcfg.fixedTags = $('#rsFixedTags').value.trim();

    const minNsfwInp = $('#rsNsfwMinCountInput');
    if (minNsfwInp && minNsfwInp.value !== '') {
      rcfg.nsfwMinCount = clamp(Number(minNsfwInp.value || 0), 0, 15);
      const nSw = (rcfg.switches || []).find(s => s && s.id === 'sw_nsfw');
      if (nSw) {
        nSw.count = rcfg.nsfwMinCount;
        nSw.minNsfwCount = rcfg.nsfwMinCount;
      }
    }

    const swRows = $$('#rsSwitchesBody tr[data-sw-idx]');
    if (swRows.length) {
      swRows.forEach(tr => {
        const idx = Number(tr.getAttribute('data-sw-idx'));
        const sw = rcfg.switches[idx];
        if (!sw) return;
        const enEl = tr.querySelector('[data-rs-sw-field="enabled"]');
        if (enEl) sw.enabled = !!enEl.checked;
        if (sw.id === 'sw_char' || sw.isCharSwitch) {
          rcfg.charRule.enabled = !!sw.enabled;
        }
        sw.desc = getSwitchRuleSummaryText(sw);
      });
    }

    const activeRules = getActiveRuleScopeList(rcfg);
    const ruleRows = $$('#rsCatRulesBody tr[data-rule-idx]');
    if (ruleRows.length && Array.isArray(activeRules)) {
      ruleRows.forEach(tr => {
        const idx = Number(tr.getAttribute('data-rule-idx'));
        const rule = activeRules[idx];
        if (!rule) return;
        const attrEl = tr.querySelector('[data-rs-rule-field="attr"]');
        const modeEl = tr.querySelector('[data-rs-rule-field="mode"]');
        const lvlEl = tr.querySelector('[data-rs-rule-field="level"]');
        const cntEl = tr.querySelector('[data-rs-rule-field="count"]');
        const minCntEl = tr.querySelector('[data-rs-rule-field="minCount"]');
        const maxCntEl = tr.querySelector('[data-rs-rule-field="maxCount"]');
        const prbEl = tr.querySelector('[data-rs-rule-field="prob"]');
        if (attrEl) rule.attr = (attrEl.value === 'forbid') ? 'forbid' : 'add';
        if (modeEl) rule.mode = (modeEl.value === 'fixed') ? 'fixed' : 'prob';
        if (lvlEl) rule.level = (lvlEl.value === 'nsfw') ? 'nsfw' : 'sfw';
        if (minCntEl && maxCntEl) {
          const lo = clamp(Number(minCntEl.value || 1), 1, 15);
          const hi = clamp(Number(maxCntEl.value || lo), lo, 15);
          rule.minCount = lo;
          rule.maxCount = hi;
          rule.count = hi;
        } else if (cntEl) {
          const c = clamp(Number(cntEl.value || 1), 1, 15);
          rule.count = c;
          rule.minCount = c;
          rule.maxCount = c;
        }
        if (prbEl) rule.prob = clamp(Number(prbEl.value ?? 70), 1, 100);
      });
    }
    (rcfg.switches || []).forEach(sw => {
      if (sw) sw.desc = getSwitchRuleSummaryText(sw);
    });
    syncActiveSchemeSnapshot();
  }

  /* ---------- 3. 右侧常驻侧边栏展开/收起按钮与右侧快捷骰子抽词 (V1.0 Req 6 & Req 7(1)-(5)) ---------- */
  function syncRightSidebarUI() {
    const layoutEl = document.querySelector('.layout');
    const isOpen = !!state.rightSidebarOpen;
    if (layoutEl) {
      layoutEl.classList.toggle('right-open', isOpen);
    }
    const edgeBtn = $('#btnRightEdgeToggle');
    if (edgeBtn) {
      edgeBtn.classList.toggle('open', isOpen);
      edgeBtn.title = isOpen ? '点击收起右侧提示词栏' : '点击展开右侧提示词栏';
    }
    const arrowEl = $('#rightEdgeArrow');
    if (arrowEl) arrowEl.textContent = isOpen ? '▶' : '◀';
    const txtEl = $('#rightEdgeText');
    if (txtEl) txtEl.textContent = isOpen ? '收起' : '提示词栏';
    if ($('#rightSidebarBadge')) {
      $('#rightSidebarBadge').textContent = String((state.sel ? state.sel.length : 0) + (state.neg ? state.neg.length : 0));
    }
  }

  function toggleRightSidebar(forceState) {
    state.rightSidebarOpen = typeof forceState === 'boolean' ? forceState : !state.rightSidebarOpen;
    syncRightSidebarUI();
    save();
  }

  function quickRollToSidebar(appendMode) {
    if (state.mode === 'neg') {
      recordHistorySnapshot('套用 Anima 官方负面基线');
      if (!appendMode) {
        state.neg = (state.neg || []).filter(x => x && x.locked);
      }
      ensureOfficialNegBaselineInNegList();
      renderAll();
      renderOutput();
      save();
      toast('📌 已填入 Anima 官方负面基线提示词');
      return;
    }
    // Pass forSidebarRoll = true so switch intervals & fixed draw rules automatically deduct locked sidebar counts!
    generateRandom(true);
    const drawn = state.randomSet || [];
    if (!drawn.length && !(state.chars && state.chars.some(c => c.locked))) {
      toast('未抽出提示词，请在「🎲 随机组合 → ⚙ 设置」中检查开关或区间规则');
      return;
    }
    recordHistorySnapshot(appendMode ? `右侧骰子追加抽取 (${drawn.length} 项)` : `右侧骰子快捷抽词 (${drawn.length} 项)`);
    const prevMode = state.mode;
    state.mode = 'pos';
    const lockedChars = (state.chars || []).filter(c => c.locked);
    const lockedCharTagSet = new Set();
    lockedChars.forEach(c => (c.tags || []).forEach(t => lockedCharTagSet.add(norm(t))));

    if (!appendMode) {
      /* 非追加模式清空时保留已固定标签与已上锁的角色整体 */
      state.sel = state.sel.filter(x => x.locked || lockedCharTagSet.has(x.key) || (x.fromCharKey && lockedChars.some(c => c.key === x.fromCharKey)));
      state.chars = lockedChars.slice();
      syncCharTags();
    }
    (state.randomRolledCharKeys || []).forEach(ck => {
      const ch = CHARS.find(x => x.key === ck) || findCustomCharByKey(ck);
      if (ch) {
        touchRecentChar(ch.key);
        if (!state.chars.some(x => x.key === ch.key)) {
          state.chars.push({
            key: ch.key, name: ch.name, tag: ch.tag, charZh: ch.charZh,
            tags: [norm(ch.tag)].concat((ch.auto || []).map(a => norm(a.en)))
          });
        }
      }
    });
    syncCharTags();
    drawn.forEach(t => addTag(t.en, t.zh, t.w || 1, '', t.subId || '', t.fromCharKey ? 'skip' : undefined));
    const rcfgNow = ensureRandCfgStructure();
    const qualSw = (rcfgNow.switches || []).find(s => s && s.id === 'sw_quality');
    if (qualSw && qualSw.enabled && (!state.neg || !state.neg.length)) {
      ensureOfficialNegBaselineInNegList();
    }
    state.mode = prevMode;
    syncModeSeg();
    renderAll();
    renderOutput();
    save();
    toast(appendMode
      ? `🎲 已追加随机抽取 ${drawn.length} 个提示词（Ctrl+Z 可撤销）`
      : `🎲 已快捷抽取 ${drawn.length} 个提示词（按住 Shift 点击可追加，Ctrl+Z 可撤销）`);
  }

  /* ---------- 4. 大分类与小分类自由拖拽排序 + layout-order.json 持久化 ---------- */
  let _dragNodeType = '';
  let _dragNodeId = '';

  function syncAndSaveLayoutOrder() {
    const fs = window.PG_TAG_FS;
    if (!fs) return;
    const lo = fs.layoutOrder || { majorOrder: [], subOrderByMajor: {}, allSubOrder: [] };
    lo.majorOrder = MAJORS.map(m => m.id);
    lo.subOrderByMajor = lo.subOrderByMajor || {};
    MAJORS.forEach(m => {
      lo.subOrderByMajor[m.id] = (m.children || []).map(s => s.id);
    });
    lo.allSubOrder = CATS.map(c => c.id);
    state.layoutDirty = true;
    fs.persistLayoutFile(lo);
  }

  function reorderArrayItem(arr, fromId, toId, placeAfter) {
    const res = arr.slice();
    const fromIdx = res.indexOf(fromId);
    if (fromIdx < 0) return res;
    res.splice(fromIdx, 1);
    let toIdx = res.indexOf(toId);
    if (toIdx < 0) {
      res.push(fromId);
      return res;
    }
    if (placeAfter) toIdx += 1;
    res.splice(toIdx, 0, fromId);
    return res;
  }

  /* ---------- 5. 右侧 MOSS 模式与 #output 直接编辑、禁中文、中文逗号转英文、自动排序 ---------- */
  let _isComposingOutput = false;

  function toggleRightMossMode(enabled) {
    state.mossMode = !!enabled;
    state.model = state.mossMode ? 'moss' : 'anima';
    if ($('#chkMossMode')) $('#chkMossMode').checked = state.mossMode;
    if ($('#mossBox')) $('#mossBox').hidden = !state.mossMode;
    if (!state.mossMode && el.output) {
      sanitizeOutputWhenMossOff(false);
      parseAndSortEditedOutput();
    } else {
      renderAll();
      renderOutput();
    }
    save();
    toast(state.mossMode ? '已开启 MOSS 模式：支持输入中文语句与中文逗号' : '已关闭 MOSS 模式：仅允许英文提示词，中文逗号自动转为英文逗号');
  }

  function sanitizeOutputWhenMossOff(showWarnToast) {
    if (!el.output || state.mossMode) return;
    const orig = el.output.value;
    if (!orig) return;
    const start = el.output.selectionStart;
    let next = orig.replace(/[，、]/g, ', ');
    const hadChinese = /[\u4e00-\u9fff]/.test(next);
    if (hadChinese) {
      next = next.replace(/[\u4e00-\u9fff]+/g, '');
      if (showWarnToast) {
        toast('当前未开启 MOSS 模式，无法输入中文（请先勾选「MOSS 模式」）');
      }
    }
    if (next !== orig) {
      el.output.value = next;
      try {
        const pos = Math.min(next.length, Math.max(0, start));
        el.output.setSelectionRange(pos, pos);
      } catch (e) {}
    }
  }

  function parseOneEditedToken(rawSeg) {
    let s = String(rawSeg || '').trim();
    if (!s) return null;
    s = s.replace(/\\([()[\]])/g, '$1');
    let w = 1;
    const mSd = s.match(/^\((.+):(-?\d+(?:\.\d+)?)\)$/);
    if (mSd) {
      s = mSd[1].trim();
      w = clamp(parseFloat(mSd[2]) || 1, 0.1, 2);
    }
    if (!s) return null;
    const clean = cleanArtistEn(s);
    const k = norm(clean || s);
    if (!k) return null;
    const isArt = state.mode === 'pos' && (s.startsWith('@') || isArtistTag(clean));
    const finalEn = isArt ? ('@' + String(clean || '').replace(/^@+/, '').trim()) : s;
    const isText = state.mossMode && /[\u4e00-\u9fff]/.test(finalEn);
    return {
      key: k,
      en: finalEn,
      zh: zhLookup(clean) || zhLookup(s) || '',
      w,
      ...(isText ? { kind: 'text' } : {})
    };
  }

  function parseAndSortEditedOutput() {
    if (!el.output) return;
    if (!state.mossMode) {
      sanitizeOutputWhenMossOff(false);
    }
    const raw = String(el.output.value || '').trim();
    const cfg = modelCfg();
    const pre = (state.mode === 'pos' && state.modelPrefix && cfg.prefix) ? cfg.prefix : '';
    const preSet = new Set(String(pre).split(',').map(x => norm(x)).filter(Boolean));

    const sepRe = state.mossMode ? /[,，]+/ : /,+/;
    const segs = raw.split(sepRe).map(s => s.trim()).filter(Boolean);

    const newList = [];
    const seen = new Set();
    const oldMap = new Map();
    currentList().forEach(it => oldMap.set(it.key, it));

    segs.forEach(seg => {
      const parsed = parseOneEditedToken(seg);
      if (!parsed) return;
      if (preSet.has(parsed.key) && !oldMap.has(parsed.key)) return;
      if (seen.has(parsed.key)) return;
      seen.add(parsed.key);
      const prev = oldMap.get(parsed.key);
      if (prev) {
        newList.push({
          ...prev,
          en: parsed.en,
          w: parsed.w !== 1 ? parsed.w : (prev.w || 1)
        });
      } else {
        newList.push(parsed);
      }
    });

    if (state.autoOrder) {
      newList.sort((a, b) => rankOf(a) - rankOf(b));
    }
    const prevKeys = currentList().map(x => x.en + ':' + (x.w || 1)).join('|');
    const nextKeys = newList.map(x => x.en + ':' + (x.w || 1)).join('|');
    if (prevKeys !== nextKeys) {
      recordHistorySnapshot('编辑并排序提示词');
    }
    if (state.mode === 'neg') state.neg = newList;
    else state.sel = newList;

    renderSelected();
    const sortedList = viewList(currentList());
    let finalText = buildText(sortedList);
    if (state.mossMode && raw.indexOf('，') >= 0 && raw.indexOf(',') < 0) {
      finalText = finalText.replace(/,\s*/g, '，');
    }
    el.output.value = finalText;
    renderGrid();
    save();
  }

  /* ---------- 6. 独立 help.md 与 update.md 渲染器 ---------- */
  function renderMarkdownToHtml(md) {
    const lines = String(md || '').split(/\r?\n/);
    let html = '';
    let inUl = false;
    let inOl = false;
    const closeUl = () => { if (inUl) { html += '</ul>'; inUl = false; } };
    const closeOl = () => { if (inOl) { html += '</ol>'; inOl = false; } };
    const closeLists = () => { closeUl(); closeOl(); };
    const inlineFmt = s => esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');

    lines.forEach(rawLine => {
      const line = rawLine.trim();
      if (!line) {
        // 空行仅闭合无序子列表，保留有序列表上下文，同时配合 <li value="N"> 确保序号连续准确
        closeUl();
        return;
      }
      const mHead = line.match(/^(#{1,4})\s+(.+)$/);
      if (mHead) {
        closeLists();
        const lvl = mHead[1].length;
        const text = mHead[2];
        const tag = lvl === 1 ? 'h2' : (lvl === 2 ? 'h3' : 'h4');
        html += `<${tag}>${inlineFmt(text)}</${tag}>`;
        return;
      }
      const mTopOl = rawLine.match(/^\s{0,1}(\d+)\.\s+(.+)$/);
      const mSubOl = !mTopOl ? rawLine.match(/^\s{2,}(\d+)\.\s+(.+)$/) : null;
      if (mTopOl) {
        closeUl();
        if (!inOl) { html += '<ol>'; inOl = true; }
        const num = parseInt(mTopOl[1], 10) || 1;
        html += `<li value="${num}">${inlineFmt(mTopOl[2])}</li>`;
      } else if (mSubOl) {
        if (!inUl) { html += '<ul>'; inUl = true; }
        html += `<li style="list-style-type:none"><b>${esc(mSubOl[1])}.</b> ${inlineFmt(mSubOl[2])}</li>`;
      } else if (/^[-*]\s+/.test(line)) {
        if (!inUl) { html += '<ul>'; inUl = true; }
        html += `<li>${inlineFmt(line.replace(/^[-*]\s+/, ''))}</li>`;
      } else {
        closeLists();
        html += `<p>${inlineFmt(line)}</p>`;
      }
    });
    closeLists();
    return html;
  }

  async function loadAndRenderHelpMd(showToast) {
    const box = $('#helpMdContainer');
    if (!box) return;
    const fs = window.PG_TAG_FS;
    const md = fs ? await fs.fetchHelpMd() : (window.__DEFAULT_HELP_MD__ || '');
    box.innerHTML = renderMarkdownToHtml(md);
    if (showToast) toast('已从外部 help.md 重新加载帮助文档');
  }

  async function loadAndRenderChangelogMd() {
    const box = $('#changelogMdContainer');
    if (!box) return;
    const fs = window.PG_TAG_FS;
    const md = (fs && fs.fetchChangelogMd) ? await fs.fetchChangelogMd() : (window.__DEFAULT_CHANGELOG_MD__ || '');
    box.innerHTML = renderMarkdownToHtml(md);
  }

  /* ---------- 7. 收藏与最近列表：单项无感移除、子分类单独清除 & 全部清除 ---------- */
  function removeTagFromFavOrRecent(which, en) {
    const k = norm(cleanArtistEn(en));
    if (!k) return;
    const isFav = which === 'fav' || which === 'char:fav';
    recordHistorySnapshot(`从${isFav ? '收藏' : '最近'}移除: ${en}`);
    if (isFav) {
      state.favTags = (state.favTags || []).filter(x => x !== k && x !== norm(en));
    } else if (which === 'recent_char') {
      state.recentCharTags = (state.recentCharTags || []).filter(x => x !== k && x !== norm(en));
    } else {
      state.recentTags = (state.recentTags || []).filter(x => x !== k && x !== norm(en));
      state.recentCharTags = (state.recentCharTags || []).filter(x => x !== k && x !== norm(en));
    }
    renderNav();
    renderGrid();
    save();
    toast(`已从${isFav ? '收藏' : '最近'}移除「${en}」（词库内提示词保留，可按 Ctrl+Z 撤销）`);
  }

  function removeCharFromFavOrRecent(which, charKey) {
    const c = findCharByKeyOrTag(charKey);
    const nm = c ? c.name : charKey;
    const targetTag = c ? norm(c.tag) : '';
    const isFav = which === 'fav_char' || which === 'fav';
    recordHistorySnapshot(`从${isFav ? '收藏角色' : '最近角色'}移除: ${nm}`);
    if (isFav) {
      state.favChars = (state.favChars || []).filter(k => k !== charKey && (!c || (k !== c.key && norm(k) !== targetTag)));
    } else {
      state.recentChars = (state.recentChars || []).filter(k => k !== charKey && (!c || (k !== c.key && norm(k) !== targetTag)));
    }
    renderNav();
    renderGrid();
    save();
    toast(`已从${isFav ? '收藏角色' : '最近角色'}移除「${nm}」（可按 Ctrl+Z 撤销）`);
  }

  function clearFavOrRecentSub(subType) {
    if (subType === 'fav_char') {
      const cnt = getFavCharsList().length;
      if (!cnt) { toast('收藏的角色列表已经是空的'); return; }
      recordHistorySnapshot(`清除收藏的角色 (${cnt} 项)`);
      state.favChars = [];
      renderNav();
      renderGrid();
      save();
      toast(`🗑 已单独清除收藏的角色（共 ${cnt} 项，可按 Ctrl+Z 撤销）`);
      return;
    }
    if (subType === 'fav_tag') {
      const cnt = (state.favTags || []).length;
      if (!cnt) { toast('收藏的 tag 列表已经是空的'); return; }
      recordHistorySnapshot(`清除收藏的 tag (${cnt} 项)`);
      state.favTags = [];
      renderNav();
      renderGrid();
      save();
      toast(`🗑 已单独清除收藏的 tag（共 ${cnt} 项，可按 Ctrl+Z 撤销）`);
      return;
    }
    if (subType === 'recent_char') {
      const cnt = getRecentCharsList().length;
      if (!cnt && !(state.recentCharTags && state.recentCharTags.length)) { toast('最近的角色列表已经是空的'); return; }
      recordHistorySnapshot(`清除最近的角色 (${cnt} 项)`);
      state.recentChars = [];
      state.recentCharTags = [];
      renderNav();
      renderGrid();
      save();
      toast(`🗑 已单独清除最近的角色（共 ${cnt} 项，可按 Ctrl+Z 撤销）`);
      return;
    }
    if (subType === 'recent_tag') {
      const cnt = (state.recentTags || []).length;
      if (!cnt) { toast('最近的 tag 列表已经是空的'); return; }
      recordHistorySnapshot(`清除最近的 tag (${cnt} 项)`);
      state.recentTags = [];
      renderNav();
      renderGrid();
      save();
      toast(`🗑 已单独清除最近的 tag（共 ${cnt} 项，可按 Ctrl+Z 撤销）`);
      return;
    }
  }

  function clearFavOrRecent(which) {
    if (which === 'fav_char' || which === 'fav_tag' || which === 'recent_char' || which === 'recent_tag') {
      clearFavOrRecentSub(which);
      return;
    }
    const isFav = which === 'fav' || which === 'char:fav';
    const count = isFav
      ? (getFavCharsList().length + (state.favTags ? state.favTags.length : 0))
      : (getRecentCharsList().length + (state.recentTags ? state.recentTags.length : 0));
    if (!count) {
      toast(isFav ? '收藏列表已经是空的' : '最近使用列表已经是空的');
      return;
    }
    askConfirmModal(`确定清除全部${isFav ? '收藏（含收藏角色与标签）' : '最近使用记录（含最近角色与标签）'}共 ${count} 项吗？（不影响词库，可按 Ctrl+Z 撤销）`, () => {
      recordHistorySnapshot(`清除${isFav ? '收藏' : '最近'} (${count} 项)`);
      if (isFav) {
        state.favTags = [];
        state.favChars = [];
      } else {
        state.recentTags = [];
        state.recentCharTags = [];
        state.recentChars = [];
      }
      renderNav();
      renderGrid();
      save();
      toast(`已清除${isFav ? '收藏' : '最近使用'}列表（可按 Ctrl+Z 撤销）`);
    });
  }

  /* ---------- 8. 轻量化修改提示词弹窗 ---------- */
  function openQuickEditTagModal(subId, tagEn) {
    ensureCustomCategoriesStructure();
    const clean = cleanArtistEn(tagEn);
    const sid = subId || tagCatOf(clean) || tagCatOf(tagEn) || '';
    const hit = sid && sid !== '__custom__' ? findTreeSub(sid) : null;
    const custSub = (state.customTagCats || []).find(c => c.id === sid);
    let curZh = '';
    let curDesc = '';
    if (custSub) {
      const cItem = (custSub.tags || []).find(t => norm(t.en) === norm(clean) || norm(t.en) === norm(tagEn));
      if (cItem) { curZh = cItem.zh || ''; curDesc = cItem.desc || ''; }
    } else if (sid === '__custom__') {
      const cItem = state.custom.find(t => norm(t.en) === norm(clean) || norm(t.en) === norm(tagEn));
      if (cItem) { curZh = cItem.zh || ''; curDesc = cItem.desc || ''; }
    } else if (hit) {
      const tObj = (hit.sub.tags || []).find(t => norm(t.en) === norm(clean) || norm(t.en) === norm(tagEn));
      if (tObj) { curZh = tObj.zh || ''; curDesc = tObj.desc || ''; }
    }
    if (!curZh) curZh = trGet(clean) || zhLookup(clean) || zhLookup(tagEn) || '';
    if (!curDesc) curDesc = descLookup(clean, sid) || '';

    if ($('#qeSubId')) $('#qeSubId').value = sid;
    if ($('#qeOrigEn')) $('#qeOrigEn').value = clean || tagEn || '';
    if ($('#qeTagEn')) $('#qeTagEn').value = clean || tagEn || '';
    if ($('#qeTagZh')) $('#qeTagZh').value = curZh;
    if ($('#qeTagDesc')) $('#qeTagDesc').value = curDesc;
    openModal('modalQuickEditTag');
    setTimeout(() => {
      const inp = $('#qeTagEn');
      if (inp) { inp.focus(); inp.select(); }
    }, 20);
  }

  async function saveQuickEditTag() {
    ensureCustomCategoriesStructure();
    const sid = ($('#qeSubId') && $('#qeSubId').value) || '';
    const origEn = ($('#qeOrigEn') && $('#qeOrigEn').value || '').trim();
    const newEn = cleanArtistEn(($('#qeTagEn') && $('#qeTagEn').value || '').trim(), sid);
    const newZh = ($('#qeTagZh') && $('#qeTagZh').value || '').trim();
    const newDesc = ($('#qeTagDesc') && $('#qeTagDesc').value || '').trim();
    if (!newEn) {
      toast('提示词不能为空');
      return;
    }
    recordHistorySnapshot(`修改提示词: ${origEn} → ${newEn}`, true);
    const origKey = norm(origEn);
    const newKey = norm(newEn);
    const custSub = (state.customTagCats || []).find(c => c.id === sid);

    if (custSub) {
      custSub.tags = custSub.tags || [];
      const idx = custSub.tags.findIndex(t => norm(t.en) === origKey);
      const nextItem = { ...(idx >= 0 ? custSub.tags[idx] : {}), en: newEn, zh: newZh, isNew: true };
      markTagObjectAsNew(nextItem, newEn);
      if (newDesc) nextItem.desc = newDesc;
      else delete nextItem.desc;
      if (idx >= 0) custSub.tags[idx] = nextItem;
      else custSub.tags.push(nextItem);
      syncFlatCustomFromTagCats();
    } else if (sid === '__custom__') {
      const defCust = state.customTagCats[0];
      if (defCust) {
        const idx = (defCust.tags || []).findIndex(t => norm(t.en) === origKey);
        const nextItem = { en: newEn, zh: newZh };
        if (newDesc) nextItem.desc = newDesc;
        if (idx >= 0) defCust.tags[idx] = nextItem;
        else defCust.tags.push(nextItem);
        syncFlatCustomFromTagCats();
      }
    } else {
      const hit = findTreeSub(sid) || findTreeSub(tagCatOf(origEn));
      if (hit) {
        const idx = (hit.sub.tags || []).findIndex(t => norm(t.en) === origKey);
        const prevObj = idx >= 0 ? hit.sub.tags[idx] : {};
        const nextItem = { ...prevObj, en: newEn, zh: newZh, isNew: true };
        markTagObjectAsNew(nextItem, newEn);
        if (newDesc) nextItem.desc = newDesc;
        else delete nextItem.desc;
        if (idx >= 0) {
          hit.sub.tags[idx] = nextItem;
        } else {
          hit.sub.tags.push(nextItem);
        }
        hit.sub.updatedAt = new Date().toISOString();
        if (newDesc) DESC_MAP.set(newKey, newDesc);
        else DESC_MAP.delete(newKey);
        refreshAllFromTree();
        window.PG_TAG_FS.persistOp({ action: 'save_sub', majorId: hit.major.id, sub: hit.sub, major: hit.major });
      }
    }

    if (newDesc) DESC_MAP.set(newKey, newDesc);
    else DESC_MAP.delete(newKey);
    if (newZh) trSet(newEn, newZh, true);

    [state.sel, state.neg].forEach((list, mIdx) => {
      const modeName = mIdx === 0 ? 'pos' : 'neg';
      list.forEach(item => {
        if (item.key === origKey || norm(cleanArtistEn(item.en)) === origKey) {
          item.key = newKey;
          item.en = formatRightEn(newEn, sid, modeName);
          item.zh = newZh;
        }
      });
    });

    closeModal('modalQuickEditTag');
    refreshAllFromTree();
    save();
    toast(`已更新提示词「${newEn}」`);
  }

  /* ---------- 9. 自定义右键菜单（含大分类、小分类、角色大图标、标签芯片右键菜单 - Req 3 & Req 8） ---------- */
  function clearCtxHighlight() {
    $$('.ctx-active').forEach(n => n.classList.remove('ctx-active'));
  }

  function hideContextMenu() {
    const m = $('#ctxMenu');
    if (m) m.hidden = true;
    clearCtxHighlight();
  }

  function placeContextMenu(x, y, html) {
    const m = $('#ctxMenu');
    if (!m) return;
    m.innerHTML = html;
    m.hidden = false;
    const rect = m.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 10;
    const maxY = window.innerHeight - rect.height - 10;
    m.style.left = Math.max(8, Math.min(x, maxX)) + 'px';
    m.style.top = Math.max(8, Math.min(y, maxY)) + 'px';
  }

  function openMajorContextMenu(x, y, majorId) {
    const m = findTreeMajor(majorId);
    if (!m) return;
    const html = `
      <div class="ctx-menu-head">大分类：${esc(m.icon || '📁')} ${esc(m.name)}</div>
      <button type="button" data-ctx-major="add-sub" data-mid="${esc(majorId)}">＋ 新增小分类</button>
      <button type="button" data-ctx-major="demote-to-sub" data-mid="${esc(majorId)}">⬇️ 移动到其他大分类成为小分类</button>
      <button type="button" data-ctx-major="rename" data-mid="${esc(majorId)}">✎ 重命名大分类</button>
      <button type="button" data-ctx-major="export" data-mid="${esc(majorId)}">📤 导出此大分类</button>
      <button type="button" class="danger" data-ctx-major="del" data-mid="${esc(majorId)}">🗑 删除大分类</button>
    `;
    placeContextMenu(x, y, html);
  }

  function openFavRecentContextMenu(x, y, which, subId) {
    const isFav = which === 'fav';
    let subBtn = '';
    if (subId === 'fav_char_sec') {
      subBtn = `<button type="button" data-ctx-favrec="clear" data-which="fav_char">🗑 单独清除「收藏 › 角色」</button>`;
    } else if (subId === 'fav_tag_sec') {
      subBtn = `<button type="button" data-ctx-favrec="clear" data-which="fav_tag">🗑 单独清除「收藏 › tag」</button>`;
    } else if (subId === 'recent_char_sec') {
      subBtn = `<button type="button" data-ctx-favrec="clear" data-which="recent_char">🗑 单独清除「最近 › 角色」</button>`;
    } else if (subId === 'recent_tag_sec') {
      subBtn = `<button type="button" data-ctx-favrec="clear" data-which="recent_tag">🗑 单独清除「最近 › tag」</button>`;
    } else if (isFav) {
      subBtn = `<button type="button" data-ctx-favrec="clear" data-which="fav_char">🗑 单独清除收藏角色</button>
      <button type="button" data-ctx-favrec="clear" data-which="fav_tag">🗑 单独清除收藏 tag</button>`;
    } else {
      subBtn = `<button type="button" data-ctx-favrec="clear" data-which="recent_char">🗑 单独清除最近角色</button>
      <button type="button" data-ctx-favrec="clear" data-which="recent_tag">🗑 单独清除最近 tag</button>`;
    }
    const html = `
      <div class="ctx-menu-head">${isFav ? '★ 收藏管理' : '🕘 最近记录管理'}</div>
      ${subBtn}
      <button type="button" class="danger" data-ctx-favrec="clear" data-which="${esc(which)}">🗑 清空全部${isFav ? '收藏' : '最近记录'}</button>
    `;
    placeContextMenu(x, y, html);
  }

  function openCharContextMenu(x, y, charKey) {
    const c = CHARS.find(it => it.key === charKey) || findCustomCharByKey(charKey);
    if (!c) return;
    const isFav = isFavChar(c.key);
    const isOn = state.chars.some(it => it.key === c.key);
    const baseName = getCharImgBaseName(c);
    const hasImg = CHAR_IMG_MEM.has(baseName.toLowerCase());
    const html = `
      <div class="ctx-menu-head">角色：${esc(c.name)} (${esc(c.game)})</div>
      <button type="button" data-ctx-char="apply" data-ckey="${esc(c.key)}">${isOn ? '⨯ 取消套用角色' : '✓ 套用此角色'}</button>
      <button type="button" data-ctx-char="fav" data-ckey="${esc(c.key)}">${isFav ? '★ 取消收藏角色' : '☆ 收藏角色（整卡收藏）'}</button>
      <button type="button" data-ctx-char="upload" data-ckey="${esc(c.key)}">📷 上传图片 (img/${esc(baseName)})</button>
      ${hasImg ? `<button type="button" data-ctx-char="del-img" data-ckey="${esc(c.key)}">🖼 移除角色图片</button>` : ''}
      <button type="button" data-ctx-char="edit" data-ckey="${esc(c.key)}">✎ 编辑角色信息</button>
      <button type="button" class="danger" data-ctx-char="del" data-ckey="${esc(c.key)}">🗑 删除角色</button>
    `;
    placeContextMenu(x, y, html);
  }

  function openTagContextMenu(x, y, tagEn, subId, listMode) {
    const clean = cleanArtistEn(tagEn);
    const sid = subId || tagCatOf(clean) || '';
    const fav = isFavTag(clean);
    const curNsfw = isNsfwTag(clean, sid);
    const inFav = (state.cat === 'fav' || state.cat === 'char:fav' || listMode === 'fav');
    const inRec = (state.cat === 'recent' || state.cat === 'char:recent' || listMode === 'recent' || listMode === 'recent_char');
    const delLabel = inFav ? '🗑 从收藏中移除' : (inRec ? '🗑 从最近中移除' : '🗑 删除提示词');

    const html = `
      <div class="ctx-menu-head">提示词：${esc(clean)}</div>
      <button type="button" data-ctx-tag="copy" data-en="${esc(clean)}">📋 复制英文标签</button>
      <div class="ctx-rate-row" style="display:flex;gap:4px;padding:4px 6px">
        <button type="button" data-ctx-rate="g" data-en="${esc(clean)}" data-sub="${esc(sid)}" title="设为 General 全年龄(蓝)">🔵</button>
        <button type="button" data-ctx-rate="s" data-en="${esc(clean)}" data-sub="${esc(sid)}" title="设为 Sensitive 敏感(黄)">🟡</button>
        <button type="button" data-ctx-rate="q" data-en="${esc(clean)}" data-sub="${esc(sid)}" title="设为 Questionable 存疑(橙)">🟠</button>
        <button type="button" data-ctx-rate="e" data-en="${esc(clean)}" data-sub="${esc(sid)}" title="设为 Explicit 成人(红)">🔴</button>
      </div>
      <button type="button" data-ctx-tag="fav" data-en="${esc(clean)}" data-sub="${esc(sid)}">${fav ? '★ 取消收藏' : '☆ 收藏提示词'}</button>
      <button type="button" data-ctx-tag="edit" data-en="${esc(clean)}" data-sub="${esc(sid)}">✎ 修改（提示词与译文）</button>
      ${sid && sid !== '__custom__' ? `<button type="button" data-ctx-tag="move" data-en="${esc(clean)}" data-sub="${esc(sid)}">⇄ 移动到其他分类</button>` : ''}
      <button type="button" class="danger" data-ctx-tag="del" data-en="${esc(clean)}" data-sub="${esc(sid)}" data-lmode="${esc(listMode || '')}">${delLabel}</button>
    `;
    placeContextMenu(x, y, html);
  }

  function openSubContextMenu(x, y, subId) {
    if (subId === 'fav_char_sec' || subId === 'fav_tag_sec') {
      openFavRecentContextMenu(x, y, 'fav', subId);
      return;
    }
    if (subId === 'recent_char_sec' || subId === 'recent_tag_sec') {
      openFavRecentContextMenu(x, y, 'recent', subId);
      return;
    }
    if (String(subId).indexOf('char_game_') === 0 || String(subId).indexOf('char_anime_') === 0 || String(subId).indexOf('char_vtuber_') === 0) {
      const l1Mode = String(subId).indexOf('char_anime_') === 0 ? 'anime' : (String(subId).indexOf('char_vtuber_') === 0 ? 'vtuber' : 'games');
      const charSub = getCharSubSections(l1Mode).find(g => g.secId === subId || g.id === subId);
      const rawId = charSub ? charSub.id : subId;
      const sName = charSub ? charSub.name : subId;
      const html = `
        <div class="ctx-menu-head">小分类：${esc(sName)}</div>
        <button type="button" data-ctx-sub="promote-char-sub" data-sid="${esc(subId)}" data-rawid="${esc(rawId)}" data-sname="${esc(sName)}" data-l1="${esc(l1Mode)}">⬆️ 分类到左侧成为大分类</button>
        <button type="button" data-ctx-sub="move-char-sub" data-sid="${esc(subId)}" data-rawid="${esc(rawId)}" data-sname="${esc(sName)}" data-l1="${esc(l1Mode)}">⇄ 移动到其他大分类</button>
        <button type="button" data-ctx-sub="new-char" data-sid="${esc(subId)}" data-rawid="${esc(rawId)}" data-sname="${esc(sName)}" data-l1="${esc(l1Mode)}">＋ 新增人物</button>
        <button type="button" data-ctx-sub="rename" data-sid="${esc(subId)}">✎ 重命名小分类</button>
        <button type="button" data-ctx-sub="export-char-sub" data-sid="${esc(subId)}" data-rawid="${esc(rawId)}" data-sname="${esc(sName)}" data-l1="${esc(l1Mode)}">📤 导出此小分类</button>
        <button type="button" class="danger" data-ctx-sub="del-char-sub" data-sid="${esc(rawId)}" data-sname="${esc(sName)}" data-l1="${esc(l1Mode)}">🗑 删除小分类</button>
      `;
      placeContextMenu(x, y, html);
      return;
    }
    const custTagCat = (state.customTagCats || []).find(x => x.id === subId);
    if (custTagCat) {
      const html = `
        <div class="ctx-menu-head">自定义小分类：${esc(custTagCat.name)}</div>
        <button type="button" data-ctx-sub="add-cust-tag" data-sid="${esc(subId)}">＋ 新增提示词</button>
        <button type="button" data-ctx-sub="rename" data-sid="${esc(subId)}">✎ 重命名小分类</button>
        <button type="button" class="danger" data-ctx-sub="del-cust-sub" data-sid="${esc(subId)}">🗑 删除小分类</button>
      `;
      placeContextMenu(x, y, html);
      return;
    }
    const hit = findTreeSub(subId);
    if (!hit) return;
    const html = `
      <div class="ctx-menu-head">小分类：${esc(hit.sub.name)}</div>
      <button type="button" data-ctx-sub="promote-to-major" data-sid="${esc(subId)}">⬆️ 分类到左侧成为大分类</button>
      <button type="button" data-ctx-sub="move" data-sid="${esc(subId)}">⇄ 移动到其他大分类</button>
      <button type="button" data-ctx-sub="add-tag" data-sid="${esc(subId)}">＋ 新增提示词</button>
      <button type="button" data-ctx-sub="rename" data-sid="${esc(subId)}">✎ 重命名小分类</button>
      <button type="button" data-ctx-sub="export" data-sid="${esc(subId)}">📤 导出此小分类</button>
      <button type="button" class="danger" data-ctx-sub="del" data-sid="${esc(subId)}">🗑 删除小分类</button>
    `;
    placeContextMenu(x, y, html);
  }

  function openMoveTagModal(fromSubId, tagEn) {
    const clean = cleanArtistEn(tagEn);
    const sid = fromSubId || tagCatOf(clean);
    const hit = findTreeSub(sid);
    if (!hit) {
      toast('仅分类库内的提示词支持跨小分类移动');
      return;
    }
    if ($('#mvTagFromSub')) $('#mvTagFromSub').value = hit.sub.id;
    if ($('#mvTagEn')) $('#mvTagEn').value = clean;
    if ($('#mvTagInfo')) $('#mvTagInfo').textContent = `当前提示词「${clean}」位于：${hit.major.name} › ${hit.sub.name}`;

    const mSel = $('#mvTagMajorSel');
    const majors = window.PG_TAG_FS.majors || [];
    if (mSel) {
      mSel.innerHTML = majors.map(m => `<option value="${esc(m.id)}">${esc(m.icon || '📁')} ${esc(m.name)}</option>`).join('');
      mSel.value = hit.major.id;
    }
    syncMoveTagSubOptions(hit.major.id, hit.sub.id);
    openModal('modalMoveTag');
  }

  function syncMoveTagSubOptions(majorId, preferSubId) {
    const sSel = $('#mvTagSubSel');
    if (!sSel) return;
    const m = findTreeMajor(majorId) || (window.PG_TAG_FS.majors && window.PG_TAG_FS.majors[0]);
    const subs = (m && m.children) || [];
    sSel.innerHTML = subs.map(s => `<option value="${esc(s.id)}">${esc(s.icon || '•')} ${esc(s.name)} (${(s.tags || []).length})</option>`).join('');
    if (preferSubId && subs.some(s => s.id === preferSubId)) sSel.value = preferSubId;
  }

  async function confirmMoveTag() {
    const fromSid = ($('#mvTagFromSub') && $('#mvTagFromSub').value) || '';
    const toSid = ($('#mvTagSubSel') && $('#mvTagSubSel').value) || '';
    const tagEn = ($('#mvTagEn') && $('#mvTagEn').value) || '';
    if (!fromSid || !toSid || !tagEn) return;
    if (fromSid === toSid) {
      toast('目标小分类与当前小分类相同');
      closeModal('modalMoveTag');
      return;
    }
    const fromHit = findTreeSub(fromSid);
    const toHit = findTreeSub(toSid);
    if (!fromHit || !toHit) return;

    recordHistorySnapshot(`移动提示词: ${tagEn} → ${toHit.sub.name}`, true);
    const k = norm(tagEn);
    const idx = (fromHit.sub.tags || []).findIndex(t => norm(t.en) === k);
    let tagObj = { en: tagEn, zh: zhLookup(tagEn) || '' };
    if (idx >= 0) {
      tagObj = fromHit.sub.tags.splice(idx, 1)[0];
    }
    toHit.sub.tags = toHit.sub.tags || [];
    if (!toHit.sub.tags.some(t => norm(t.en) === k)) {
      toHit.sub.tags.push(tagObj);
    }
    fromHit.sub.updatedAt = new Date().toISOString();
    toHit.sub.updatedAt = new Date().toISOString();
    await window.PG_TAG_FS.persistOp({
      action: 'move_tag',
      fromMajorId: fromHit.major.id,
      fromSub: fromHit.sub,
      toMajorId: toHit.major.id,
      toSub: toHit.sub
    });
    if (state.expandedSubs.indexOf(toSid) < 0) state.expandedSubs.push(toSid);
    closeModal('modalMoveTag');
    refreshAllFromTree();
    toast(`已将「${tagEn}」移至「${toHit.major.name} › ${toHit.sub.name}」`);
  }

  function openMoveSubModal(subId) {
    if (String(subId).indexOf('char_game_') === 0 || String(subId).indexOf('char_anime_') === 0 || String(subId).indexOf('char_vtuber_') === 0) {
      const l1Mode = String(subId).indexOf('char_anime_') === 0 ? 'anime' : (String(subId).indexOf('char_vtuber_') === 0 ? 'vtuber' : 'games');
      const charSub = getCharSubSections(l1Mode).find(g => g.secId === subId || g.id === subId);
      if (!charSub) return;
      if ($('#mvSubId')) $('#mvSubId').value = `charsub::${l1Mode}::${charSub.id}::${charSub.name}`;
      const l1Title = l1Mode === 'anime' ? '📺 番剧' : (l1Mode === 'vtuber' ? '🎤 VTuber' : '🎮 游戏');
      if ($('#mvSubInfo')) $('#mvSubInfo').textContent = `当前角色库小分类「${charSub.name}」所属分组：角色库 › ${l1Title}`;
      const sel = $('#mvSubTargetMajorSel');
      const majors = window.PG_TAG_FS.majors || [];
      if (sel) {
        const charGroupOpts = [
          `<option value="char_l1:games">🧝 角色库 › 🎮 游戏</option>`,
          `<option value="char_l1:anime">🧝 角色库 › 📺 番剧</option>`,
          `<option value="char_l1:vtuber">🧝 角色库 › 🎤 VTuber</option>`
        ].join('');
        const tagMajorOpts = majors.map(m => `<option value="${esc(m.id)}">${esc(m.icon || '📁')} ${esc(m.name)}</option>`).join('');
        sel.innerHTML = charGroupOpts + tagMajorOpts;
        sel.value = 'char_l1:' + l1Mode;
      }
      openModal('modalMoveSub');
      return;
    }
    const hit = findTreeSub(subId);
    if (!hit) return;
    if ($('#mvSubId')) $('#mvSubId').value = hit.sub.id;
    if ($('#mvSubInfo')) $('#mvSubInfo').textContent = `当前小分类「${hit.sub.name}」所属大分类：${hit.major.name}`;
    const sel = $('#mvSubTargetMajorSel');
    const majors = window.PG_TAG_FS.majors || [];
    if (sel) {
      sel.innerHTML = majors.map(m => `<option value="${esc(m.id)}">${esc(m.icon || '📁')} ${esc(m.name)}</option>`).join('');
      sel.value = hit.major.id;
    }
    openModal('modalMoveSub');
  }

  async function confirmMoveSub() {
    const sid = ($('#mvSubId') && $('#mvSubId').value) || '';
    const targetMid = ($('#mvSubTargetMajorSel') && $('#mvSubTargetMajorSel').value) || '';
    if (String(sid).indexOf('charsub::') === 0) {
      const parts = sid.split('::');
      const fromMode = parts[1] || 'games';
      const rawId = parts[2] || '';
      const subName = parts.slice(3).join('::') || rawId;
      const charSub = getCharSubSections(fromMode).find(g => g.id === rawId || g.name === subName);
      const charsToMove = charSub ? (charSub.chars || []) : [];

      if (String(targetMid).indexOf('char_l1:') === 0) {
        const toMode = targetMid.slice(8);
        if (toMode === fromMode) {
          toast('该小分类已在当前角色库分组下');
          closeModal('modalMoveSub');
          return;
        }
        recordHistorySnapshot(`移动角色库小分类: ${subName}`, true);
        charsToMove.forEach(c => {
          c.majorId = toMode;
          c.subId = rawId;
          c.subName = subName;
          c.game = subName;
          if (c.key.charAt(0) === 'u') {
            const u = (CUSTOM.chars || []).find(x => x.key === c.key);
            if (u) { u.majorId = toMode; u.subId = rawId; u.game = subName; }
          } else {
            CUSTOM.charEdit[c.key] = Object.assign({}, CUSTOM.charEdit[c.key] || {}, {
              name: c.name, game: subName, majorId: toMode, subId: rawId, tag: c.tag, charZh: c.charZh, auto: tagText(c.auto)
            });
          }
        });
        saveCustom();
        state.charCustomSubs = (state.charCustomSubs || []).filter(s => !(s.l1Mode === fromMode && (s.id === rawId || s.name === subName)));
        if (!state.charCustomSubs.some(s => s.l1Mode === toMode && s.name === subName)) {
          state.charCustomSubs.push({ id: rawId, name: subName, l1Mode: toMode });
        }
        if (!Array.isArray(state.charDeletedSubs)) state.charDeletedSubs = [];
        state.charDeletedSubs.push(`${fromMode}::${rawId}`, `${fromMode}::${subName}`);
        state.charDeletedSubs = state.charDeletedSubs.filter(tok => tok !== `${toMode}::${rawId}` && tok !== `${toMode}::${subName}`);
        if (window.PG_TAG_FS && window.PG_TAG_FS.syncCharsFromFlatList) {
          await window.PG_TAG_FS.syncCharsFromFlatList(CHARS);
        }
        state.cat = 'char:' + toMode;
        closeModal('modalMoveSub');
        refreshAllFromTree();
        save();
        toast(`已将小分类「${subName}」移动至角色库新分组`);
        return;
      }

      const targetMajor = findTreeMajor(targetMid);
      if (targetMajor) {
        recordHistorySnapshot(`角色小分类移入大分类: ${subName} → ${targetMajor.name}`, true);
        const convertedTags = [];
        const seenT = new Set();
        charsToMove.forEach(c => {
          if (c.tag && !seenT.has(norm(c.tag))) {
            seenT.add(norm(c.tag));
            convertedTags.push({ en: c.tag, zh: c.charZh || c.name || '' });
          }
        });
        let newSid = safeId(rawId);
        if (findTreeSub(newSid)) newSid = `${targetMajor.id}_${newSid}_${Date.now().toString(36).slice(-3)}`;
        const newSub = {
          id: newSid,
          name: subName,
          icon: '🧝',
          parentId: targetMajor.id,
          level: 2,
          order: (targetMajor.children || []).length + 1,
          file: `${targetMajor.id}/${targetMajor.id}_${newSid}.json`,
          updatedAt: new Date().toISOString(),
          children: [],
          tags: convertedTags
        };
        targetMajor.children = targetMajor.children || [];
        targetMajor.children.push(newSub);
        await window.PG_TAG_FS.persistOp({ action: 'save_sub', majorId: targetMajor.id, sub: newSub, major: targetMajor });
        if (typeof window.deleteCharLibrarySub === 'function') {
          state.charCustomSubs = (state.charCustomSubs || []).filter(s => !(s.l1Mode === fromMode && (s.id === rawId || s.name === subName)));
          if (!Array.isArray(state.charDeletedSubs)) state.charDeletedSubs = [];
          state.charDeletedSubs.push(`${fromMode}::${rawId}`, `${fromMode}::${subName}`);
        }
        state.cat = 'major:' + targetMajor.id;
        closeModal('modalMoveSub');
        refreshAllFromTree();
        save();
        toast(`已将「${subName}」移动至大分类「${targetMajor.name}」`);
        return;
      }
      return;
    }
    const hit = findTreeSub(sid);
    const targetMajor = findTreeMajor(targetMid);
    if (!hit || !targetMajor) return;
    if (hit.major.id === targetMajor.id) {
      toast('该小分类已在当前大分类下');
      closeModal('modalMoveSub');
      return;
    }
    recordHistorySnapshot(`移动小分类: ${hit.sub.name} → ${targetMajor.name}`, true);
    const oldMajor = hit.major;
    const sub = hit.sub;
    oldMajor.children = (oldMajor.children || []).filter(s => s.id !== sid);
    sub.parentId = targetMajor.id;
    sub.file = `${targetMajor.id}/${sub.id}.json`;
    sub.updatedAt = new Date().toISOString();
    targetMajor.children = targetMajor.children || [];
    targetMajor.children.push(sub);

    const fs = window.PG_TAG_FS;
    await fs.persistOp({ action: 'delete_sub', majorId: oldMajor.id, subId: sid, major: oldMajor });
    await fs.persistOp({ action: 'save_sub', majorId: targetMajor.id, sub, major: targetMajor });
    state.cat = 'major:' + targetMajor.id;
    closeModal('modalMoveSub');
    refreshAllFromTree();
    /* (Req 3) 移动后同步并落盘 layout-order.json，避免重进后分类位置丢失/错位 */
    if (fs.layoutOrder) {
      fs.layoutOrder.subOrderByMajor = fs.layoutOrder.subOrderByMajor || {};
      const oldList = fs.layoutOrder.subOrderByMajor[oldMajor.id] || [];
      fs.layoutOrder.subOrderByMajor[oldMajor.id] = oldList.filter(x => x !== sid);
      const newList = fs.layoutOrder.subOrderByMajor[targetMajor.id] || [];
      if (!newList.includes(sid)) newList.push(sid);
      fs.layoutOrder.subOrderByMajor[targetMajor.id] = newList;
    }
    syncAndSaveLayoutOrder();
    toast(`已将小分类「${sub.name}」移动至大分类「${targetMajor.name}」`);
  }

  /* ---------- 10. 原位新增大分类与小分类 ---------- */
  async function quickCreateMajorInline() {
    recordHistorySnapshot('新增大分类: 新建分类', true);
    const fs = window.PG_TAG_FS;
    const id = 'major_' + Date.now().toString(36);
    const defaultName = '新建分类';
    const newMajor = {
      id,
      name: defaultName,
      icon: '📁',
      level: 1,
      order: (fs.majors || []).length + 1,
      file: id + '.json',
      subDir: id,
      updatedAt: new Date().toISOString(),
      children: []
    };
    fs.majors.push(newMajor);
    if (fs.layoutOrder && Array.isArray(fs.layoutOrder.majorOrder)) {
      if (fs.layoutOrder.majorOrder.indexOf(id) < 0) fs.layoutOrder.majorOrder.push(id);
      fs.persistLayoutFile(fs.layoutOrder);
    }
    state.cat = 'major:' + id;
    state.editingMajorId = id;
    await fs.persistOp({ action: 'save_major', major: newMajor, includeChildren: false });
    refreshAllFromTree();
    save();
  }

  async function finishInlineMajorRename(mid, newNameRaw) {
    if (!state.editingMajorId) return;
    state.editingMajorId = '';
    const m = findTreeMajor(mid);
    if (!m) { renderNav(); return; }
    const trimmed = String(newNameRaw || '').trim();
    if (!trimmed || trimmed === m.name) {
      renderNav();
      renderGrid();
      return;
    }
    recordHistorySnapshot(`重命名大分类: ${m.name} → ${trimmed}`, true);
    m.name = trimmed;
    m.updatedAt = new Date().toISOString();
    await window.PG_TAG_FS.persistOp({ action: 'save_major', major: m, includeChildren: false });
    refreshAllFromTree();
    toast(`已重命名大分类为「${trimmed}」`);
  }

  async function quickCreateSubInline(preferMajorId) {
    const fs = window.PG_TAG_FS;
    let mid = preferMajorId;
    if (!mid && String(state.cat).indexOf('major:') === 0) mid = String(state.cat).slice(6);
    if (!mid) {
      const hit = findTreeSub(state.cat);
      if (hit) mid = hit.major.id;
    }
    const major = findTreeMajor(mid) || fs.majors[0];
    if (!major) { toast('请先在左侧创建一个大分类'); return; }
    recordHistorySnapshot(`新增小分类 (${major.name})`, true);
    const id = 'sub_' + Date.now().toString(36);
    const defaultName = '新建小分类';
    const newSub = {
      id,
      name: defaultName,
      icon: '•',
      parentId: major.id,
      level: 2,
      order: (major.children || []).length + 1,
      file: `${major.id}/${id}.json`,
      updatedAt: new Date().toISOString(),
      children: [],
      tags: []
    };
    major.children = major.children || [];
    major.children.push(newSub);
    if (fs.layoutOrder) {
      fs.layoutOrder.subOrderByMajor = fs.layoutOrder.subOrderByMajor || {};
      fs.layoutOrder.subOrderByMajor[major.id] = fs.layoutOrder.subOrderByMajor[major.id] || [];
      if (fs.layoutOrder.subOrderByMajor[major.id].indexOf(id) < 0) fs.layoutOrder.subOrderByMajor[major.id].push(id);
      fs.layoutOrder.allSubOrder = fs.layoutOrder.allSubOrder || [];
      if (fs.layoutOrder.allSubOrder.indexOf(id) < 0) fs.layoutOrder.allSubOrder.push(id);
      fs.persistLayoutFile(fs.layoutOrder);
    }
    if (state.expandedSubs.indexOf(id) < 0) state.expandedSubs.push(id);
    state.editingSubId = id;
    await fs.persistOp({ action: 'save_sub', majorId: major.id, sub: newSub, major });
    refreshAllFromTree();
    save();
  }

  async function finishInlineSubRename(sid, newNameRaw) {
    if (!state.editingSubId) return;
    state.editingSubId = '';
    const trimmed = String(newNameRaw || '').trim();
    if (String(sid).indexOf('char_game_') === 0 || String(sid).indexOf('char_anime_') === 0 || String(sid).indexOf('char_vtuber_') === 0) {
      const l1Mode = String(sid).indexOf('char_anime_') === 0 ? 'anime' : (String(sid).indexOf('char_vtuber_') === 0 ? 'vtuber' : 'games');
      const charSub = getCharSubSections(l1Mode).find(g => g.secId === sid || g.id === sid);
      if (charSub && trimmed && trimmed !== charSub.name) {
        const oldName = charSub.name;
        const rawId = charSub.id;
        const custSub = (state.charCustomSubs || []).find(x => x.l1Mode === l1Mode && (x.id === rawId || x.name === oldName));
        if (custSub) custSub.name = trimmed;
        else {
          state.charCustomSubs = state.charCustomSubs || [];
          state.charCustomSubs.push({ id: rawId, name: trimmed, l1Mode });
        }
        (charSub.chars || []).forEach(c => {
          c.game = trimmed;
          c.subName = trimmed;
          if (c.key.charAt(0) === 'u') {
            const u = (CUSTOM.chars || []).find(x => x.key === c.key);
            if (u) u.game = trimmed;
          } else {
            CUSTOM.charEdit[c.key] = Object.assign({}, CUSTOM.charEdit[c.key] || {}, {
              name: c.name, game: trimmed, tag: c.tag, charZh: c.charZh, auto: tagText(c.auto)
            });
          }
        });
        saveCustom();
        const fs = window.PG_TAG_FS;
        if (fs && Array.isArray(fs.charMajors)) {
          const cm = fs.charMajors.find(m => m.id === l1Mode);
          const child = cm && (cm.children || []).find(c => c.id === rawId || c.name === oldName);
          if (child) child.name = trimmed;
          if (fs.syncCharsFromFlatList) await fs.syncCharsFromFlatList(CHARS);
        }
        refreshAllFromTree();
        save();
        toast(`已重命名角色库小分类为「${trimmed}」`);
      } else {
        renderGrid();
      }
      return;
    }
    const custCharCat = (state.customCharCats || []).find(x => x.id === sid);
    if (custCharCat) {
      if (trimmed && trimmed !== custCharCat.name) {
        custCharCat.name = trimmed;
        refreshAllFromTree();
        save();
        toast(`已重命名角色分类为「${trimmed}」`);
      } else {
        renderGrid();
      }
      return;
    }
    const custTagCat = (state.customTagCats || []).find(x => x.id === sid);
    if (custTagCat) {
      if (trimmed && trimmed !== custTagCat.name) {
        custTagCat.name = trimmed;
        refreshAllFromTree();
        save();
        toast(`已重命名自定义小分类为「${trimmed}」`);
      } else {
        renderGrid();
      }
      return;
    }
    const hit = findTreeSub(sid);
    if (!hit) { renderGrid(); return; }
    if (!trimmed || trimmed === hit.sub.name) {
      renderGrid();
      return;
    }
    recordHistorySnapshot(`重命名小分类: ${hit.sub.name} → ${trimmed}`, true);
    hit.sub.name = trimmed;
    hit.sub.updatedAt = new Date().toISOString();
    await window.PG_TAG_FS.persistOp({ action: 'save_sub', majorId: hit.major.id, sub: hit.sub, major: hit.major });
    refreshAllFromTree();
    toast(`已重命名小分类为「${trimmed}」`);
  }

  /* ---------- 11. 小分类末尾「＋ 新增」按钮：单条录入 + Excel 表格粘贴自动解析预检 ---------- */
  let _parsedBatchItems = [];

  function openSubAddTagModal(subId) {
    const hit = findTreeSub(subId) || (CATS[0] ? findTreeSub(CATS[0].id) : null);
    if (!hit) { toast('未找到目标小分类'); return; }
    const sel = $('#subAddTargetSel');
    if (sel) {
      let opts = '';
      MAJORS.forEach(m => (m.children || []).forEach(s => {
        opts += `<option value="${esc(s.id)}">${esc(m.name)} › ${esc(s.icon || '•')} ${esc(s.name)} (tags/${esc(m.id)}/${esc(m.id)}_${esc(s.id)}.json)</option>`;
      }));
      sel.innerHTML = opts;
      sel.value = hit.sub.id;
    }
    if ($('#subAddModalTitle')) $('#subAddModalTitle').textContent = `＋ 新增提示词到「${hit.major.name} › ${hit.sub.name}」`;
    if ($('#subAddSingleEn')) $('#subAddSingleEn').value = '';
    if ($('#subAddSingleZh')) $('#subAddSingleZh').value = '';
    if ($('#subAddSingleDesc')) $('#subAddSingleDesc').value = '';
    if ($('#subAddSingleStat')) $('#subAddSingleStat').textContent = '';
    if ($('#subAddBatchInput')) $('#subAddBatchInput').value = '';
    if ($('#subAddPrecheckStat')) $('#subAddPrecheckStat').textContent = '等待输入或粘贴 Excel 表格内容…';
    if ($('#subAddPrecheckWrap')) $('#subAddPrecheckWrap').hidden = true;
    _parsedBatchItems = [];
    openModal('modalSubAddTag');
    setTimeout(() => { if ($('#subAddSingleEn')) $('#subAddSingleEn').focus(); }, 20);
  }

  function checkTagDuplication(en, targetSubId) {
    ensureCustomCategoriesStructure();
    const k = normDedupKey(en);
    if (!k) return { status: 'empty', inSame: false, otherSubs: [] };
    let inSame = false;
    const otherSubs = [];
    const fs = window.PG_TAG_FS;
    (fs.majors || []).forEach(m => {
      (m.children || []).forEach(s => {
        const found = (s.tags || []).some(t => normDedupKey(t.en) === k);
        if (found) {
          if (s.id === targetSubId) inSame = true;
          else otherSubs.push(`${m.name} › ${s.name}`);
        }
      });
    });
    (state.customTagCats || []).forEach(c => {
      const found = (c.tags || []).some(t => normDedupKey(t.en) === k);
      if (found) {
        if (c.id === targetSubId) inSame = true;
        else otherSubs.push(`自定义 › ${c.name}`);
      }
    });
    return { status: inSame ? 'same' : (otherSubs.length ? 'other' : 'ok'), inSame, otherSubs };
  }

  function parseExcelOrTextLines(rawText, targetSubId) {
    const lines = String(rawText || '').split(/\r?\n/);
    const rows = [];
    const seenInBatch = new Set();

    lines.forEach(line => {
      const t = line.trim();
      if (!t) return;
      let en = '', zh = '', desc = '';
      if (t.indexOf('\t') >= 0) {
        const parts = t.split('\t').map(s => s.trim());
        en = parts[0] || '';
        zh = parts[1] || '';
        desc = parts.slice(2).filter(Boolean).join(' ') || '';
      } else if (t.indexOf('|') >= 0) {
        const parts = t.split('|').map(s => s.trim());
        en = parts[0] || '';
        zh = parts[1] || '';
        desc = parts.slice(2).filter(Boolean).join(' ') || '';
      } else if (t.indexOf('，') >= 0 || t.indexOf(',') >= 0) {
        const parts = t.split(/[,，]/);
        if (parts.length === 2 && /[a-zA-Z]/.test(parts[0]) && /[\u4e00-\u9fff]/.test(parts[1])) {
          en = parts[0].trim();
          zh = parts[1].trim();
        } else {
          en = t;
        }
      } else {
        en = t;
      }
      if (/^(英文|提示词|tag|prompt|english)$/i.test(en) && /^(中文|释义|翻译|zh|chinese)$/i.test(zh)) return;
      if (!en) return;
      const k = norm(cleanArtistEn(en));
      const batchDup = seenInBatch.has(k);
      seenInBatch.add(k);
      const dupInfo = checkTagDuplication(en, targetSubId);
      rows.push({
        en: cleanArtistEn(en),
        zh: zh || zhLookup(en) || '',
        desc: desc || descLookup(en, targetSubId) || '',
        key: k,
        batchDup,
        inSame: dupInfo.inSame,
        otherSubs: dupInfo.otherSubs
      });
    });
    return rows;
  }

  function runSubAddPrecheck() {
    const targetSubId = ($('#subAddTargetSel') && $('#subAddTargetSel').value) || '';
    const raw = ($('#subAddBatchInput') && $('#subAddBatchInput').value) || '';
    const defaultMoveOther = !$('#subAddMoveOtherDup') || $('#subAddMoveOtherDup').checked;
    _parsedBatchItems = parseExcelOrTextLines(raw, targetSubId).map(r => ({
      ...r,
      moveFromOther: r.otherSubs.length > 0 ? defaultMoveOther : false
    }));
    const wrap = $('#subAddPrecheckWrap');
    const tbody = $('#subAddPrecheckBody');
    const stat = $('#subAddPrecheckStat');
    if (!_parsedBatchItems.length) {
      if (wrap) wrap.hidden = true;
      if (stat) stat.textContent = '等待输入或粘贴 Excel 表格内容…';
      return;
    }
    let okCount = 0, sameCount = 0, otherCount = 0, batchDupCount = 0;
    const htmlRows = _parsedBatchItems.map((r, idx) => {
      let badge = '';
      if (r.batchDup) {
        batchDupCount++;
        badge = `<span class="precheck-badge same">粘贴内容内部重复</span>`;
      } else if (r.inSame) {
        sameCount++;
        badge = `<span class="precheck-badge same">⚠ 当前小分类已存在</span>` + (r.otherSubs.length ? ` <span class="precheck-badge other">同时存在于：${esc(r.otherSubs.join('、'))}</span>` : '');
      } else if (r.otherSubs.length) {
        otherCount++;
        badge = `<span class="precheck-badge other">⚠ 其他小分类已存在（${esc(r.otherSubs.join('、'))}）</span> ` +
          `<label class="imp-move-chk"><input type="checkbox" data-subadd-move-row="${idx}" ${r.moveFromOther ? 'checked' : ''}> ⇄ 移动至目标分类</label>`;
      } else {
        okCount++;
        badge = `<span class="precheck-badge ok">✅ 无重复，可新增</span>`;
      }
      return `<tr>
        <td>${idx + 1}</td>
        <td><code>${esc(r.en)}</code></td>
        <td>${esc(r.zh || '—')}</td>
        <td><input type="text" data-subadd-desc-row="${idx}" value="${esc(r.desc || '')}" placeholder="默认留空" style="width:100%"></td>
        <td>${badge}</td>
      </tr>`;
    }).join('');
    if (tbody) tbody.innerHTML = htmlRows;
    if (wrap) wrap.hidden = false;
    if (stat) {
      stat.textContent = `共解析 ${_parsedBatchItems.length} 条：✅ 全新 ${okCount} 条 · ⚠ 当前小分类重复 ${sameCount} 条 · ⚠ 其他小分类重复 ${otherCount} 条` + (batchDupCount ? ` · 粘贴内容内重复 ${batchDupCount} 条` : '');
    }
  }

  async function commitSubAddSingle() {
    const targetSubId = ($('#subAddTargetSel') && $('#subAddTargetSel').value) || '';
    const en = cleanArtistEn(($('#subAddSingleEn') && $('#subAddSingleEn').value || '').trim(), targetSubId);
    const zh = ($('#subAddSingleZh') && $('#subAddSingleZh').value || '').trim();
    const desc = ($('#subAddSingleDesc') && $('#subAddSingleDesc').value || '').trim();
    const moveOther = !$('#subAddSingleMoveOther') || $('#subAddSingleMoveOther').checked;
    const stat = $('#subAddSingleStat');
    if (!en) { toast('请输入英文提示词'); return; }
    const dup = checkTagDuplication(en, targetSubId);
    if (dup.otherSubs.length && !moveOther) {
      if (stat) stat.innerHTML = `<span style="color:#fbbf24">⚠ 「${esc(en)}」已在 ${esc(dup.otherSubs.join('、'))} 存在，已按要求仅保留原分类（跳过本次新增）</span>`;
      toast(`「${en}」已在其他分类存在，已保留原分类（仅保留一个）`);
      return;
    }
    if (dup.inSame) {
      if (stat) stat.innerHTML = `<span style="color:var(--neg)">⚠ 当前小分类中已存在「${esc(en)}」，已为你更新中文释义（仅保留一个）</span>`;
    } else if (dup.otherSubs.length) {
      if (stat) stat.innerHTML = `<span style="color:var(--pos)">✅ 已将「${esc(en)}」从 ${esc(dup.otherSubs.join('、'))} 移动至当前目标小分类（全库仅保留一个）</span>`;
    } else {
      if (stat) stat.innerHTML = `<span style="color:var(--pos)">✅ 已成功添加「${esc(en)}」</span>`;
    }
    recordHistorySnapshot(`新增提示词: ${en}`, true);
    await addTagToSubFile(targetSubId, en, zh, true, desc);
    if (state.expandedSubs.indexOf(targetSubId) < 0) state.expandedSubs.push(targetSubId);
    renderGrid();
    $('#subAddSingleEn').value = '';
    $('#subAddSingleZh').value = '';
    toast(dup.otherSubs.length ? `已将「${en}」从原分类移动至目标小分类（仅保留一个）` : `已添加「${en}」到小分类文件（可按 Ctrl+Z 撤销）`);
  }

  async function commitSubAddBatch() {
    const targetSubId = ($('#subAddTargetSel') && $('#subAddTargetSel').value) || '';
    const hit = findTreeSub(targetSubId);
    if (!hit) { toast('请选择目标小分类'); return; }
    if (!_parsedBatchItems.length) runSubAddPrecheck();
    if (!_parsedBatchItems.length) {
      if ($('#subAddSingleEn') && $('#subAddSingleEn').value.trim()) {
        await commitSubAddSingle();
        closeModal('modalSubAddTag');
        return;
      }
      toast('请先粘贴要导入的 Excel 表格内容或输入单个提示词');
      return;
    }
    const modeEl = document.querySelector('input[name="subAddDupMode"]:checked');
    const dupMode = modeEl ? modeEl.value : 'skip';
    const skipOther = !!($('#subAddSkipOtherDup') && $('#subAddSkipOtherDup').checked);
    const globalMoveOther = !$('#subAddMoveOtherDup') || $('#subAddMoveOtherDup').checked;
    const isNsfwDest = isNsfwSubId(hit.sub.id) || hit.major.id === 'nsfw_group';

    recordHistorySnapshot(`批量新增提示词 (${hit.sub.name})`, true);
    const touchedMap = new Map();
    let added = 0, updated = 0, skipped = 0, moved = 0;
    hit.sub.tags = hit.sub.tags || [];
    for (const item of _parsedBatchItems) {
      if (item.batchDup) { skipped++; continue; }
      if (skipOther && item.otherSubs.length && !item.moveFromOther) { skipped++; continue; }
      if (item.otherSubs.length && (item.moveFromOther || globalMoveOther)) {
        moved += removeTagFromOtherSubsInTree(item.en, hit.sub.id, touchedMap);
      }
      const ex = hit.sub.tags.find(t => norm(t.en) === item.key);
      if (ex) {
        if (dupMode === 'overwrite') {
          if (item.zh) ex.zh = item.zh;
          if (item.desc) ex.desc = item.desc;
          markTagObjectAsNew(ex, ex.en);
          updated++;
        } else {
          if (item.desc && !ex.desc) ex.desc = item.desc;
          skipped++;
        }
        if (isNsfwDest && ex.nsfw !== false) ex.nsfw = true;
      } else {
        const newTag = { en: item.en, zh: item.zh || '', isNew: true }; markTagAsNew(item.en, newTag);
        if (item.desc) newTag.desc = item.desc;
        if (isNsfwDest) newTag.nsfw = true;
        markTagObjectAsNew(newTag, item.en);
        hit.sub.tags.push(newTag);
        added++;
      }
    }
    hit.sub.updatedAt = new Date().toISOString();
    touchedMap.set(hit.sub.id, { major: hit.major, sub: hit.sub });
    await window.PG_TAG_FS.persistOp({ action: 'sync_all', majors: window.PG_TAG_FS.majors });
    if (state.expandedSubs.indexOf(targetSubId) < 0) state.expandedSubs.push(targetSubId);
    refreshAllFromTree();
    save();
    closeModal('modalSubAddTag');
    toast(`批量导入完成：新增 ${added} 条，更新 ${updated} 条` + (moved ? `，跨类移动 ${moved} 条` : '') + `，跳过重复 ${skipped} 条`);
  }

  const IMP_STAGE_KEY = 'pg_imp_stage_v25';
  let _impStep = 1;
  let _impGrid = [];
  let _impColPairs = [];
  let _impLongMap = { en: 0, zh: 1, desc: -1, grp: -1 };
  let _impPrecheck = [];
  let _impPrevPage = 0;
  const IMP_PAGE_SIZE = 120;
  let _impStage = loadImpStageFromLocal();
  let _impExpandedMajors = new Set();
  let _impExpandedGroups = new Set();
  let _stageSelectMode = false;
  let _stageSelectedTags = new Set(); // Set of "${subId}::${tagIndex}"
  let _stageSelectedSubs = new Set(); // Set of subId
  let _stageSelectedMajors = new Set(); // Set of majorId
  let _miniSubId = '';

  const IMP_HEADER_HINT_MAP = {
    '画风': 'style', '质量': 'style', '风格': 'style', '质量风格': 'style',
    '画师': 'artist', '艺术家': 'artist',
    '人物': 'base', '角色': 'base', '基础': 'base', '人数': 'base', '职业': 'occupation', '种族': 'species',
    '头发': 'hair_style', '发色': 'hair_color', '发型': 'hair_style', '头发颜色': 'hair_color', '发型发色': 'hair_style',
    '五官': 'eyes', '眼睛': 'eyes', '瞳色': 'eyes', '鼻子': 'nose', '鼻部': 'nose', '脸型': 'head', '面部': 'head', '嘴部': 'mouth', '耳朵': 'ears',
    '表情': 'expression', '神态': 'expression', '情绪': 'expression', '神态表情': 'expression',
    '身体': 'body', '身材': 'body', '体型': 'body', '肤色': 'skin', '身体特征': 'body', '尾巴': 'tail', '翅膀': 'wings',
    '服装': 'upper_body', '穿搭': 'upper_body', '衣服': 'upper_body', '服饰': 'upper_body', '上装': 'upper_body', '下装': 'lower_body', '内衣': 'underwear', '鞋袜': 'legwear', '袜子': 'legwear', '鞋子': 'footwear',
    '配饰': 'accessory', '饰品': 'accessory', '道具': 'items', '食物': 'food', '工具': 'tools', '束缚': 'restraints', '性玩具': 'sex_toys',
    '动作': 'pose', '姿势': 'pose', '姿态': 'pose', '视线': 'head_action', '手部动作': 'hand_action', '嘴部动作': 'mouth_action', '腿脚动作': 'foot_action', '互动': 'interaction',
    '场景': 'nature', '背景': 'nature', '环境': 'nature', '室内': 'indoor', '城市': 'urban', '奇幻': 'fantasy_scifi',
    '天气': 'weather_time', '季节': 'weather_time', '时间': 'weather_time', '自然': 'nature', '天气时刻': 'weather_time',
    '光影': 'lighting', '光线': 'lighting', '灯光': 'lighting', '氛围': 'lighting', '光影氛围': 'lighting',
    '镜头': 'camera', '视角': 'camera', '景别': 'camera', '机位': 'camera', '镜头视角': 'camera',
    '构图': 'composition', '特效': 'composition', '画面': 'composition', '构图特效': 'composition',
    '负面': 'negative', '负向': 'negative', '反向': 'negative', '负面提示词': 'negative'
  };

  function loadImpStageFromLocal() {
    try {
      const raw = localStorage.getItem(IMP_STAGE_KEY) || localStorage.getItem('pg_imp_stage_v23');
      if (raw) {
        const d = JSON.parse(raw);
        if (d && Array.isArray(d.groups)) return d;
      }
    } catch (e) {}
    return { groups: [] };
  }

  function saveImpStageToLocal() {
    try {
      localStorage.setItem(IMP_STAGE_KEY, JSON.stringify(_impStage));
    } catch (e) {}
    updateImpStepBadges();
  }

  function totalImpStageTags() {
    return (_impStage.groups || []).reduce((acc, g) => acc + (g.tags ? g.tags.length : 0), 0);
  }

  function updateImpStepBadges() {
    const bp = $('#tsBadgePrev');
    if (bp) bp.textContent = String(_impPrecheck.length);
    const bs = $('#tsBadgeStage');
    const sc = $('#impStashCount');
    const n = totalImpStageTags();
    if (bs) bs.textContent = String(n);
    if (sc) sc.textContent = String(n);
  }

  function switchImpStep(step) {
    _impStep = Math.min(3, Math.max(1, Number(step) || 1));
    $$('#tsSteps button[data-ts-step]').forEach(b => {
      b.classList.toggle('on', Number(b.getAttribute('data-ts-step')) === _impStep);
    });
    for (let i = 1; i <= 3; i++) {
      const p = $('#tsPanel' + i);
      if (p) p.classList.toggle('on', i === _impStep);
    }
    updateImpStepBadges();
    if (_impStep === 2) renderImpPrecheck();
    else if (_impStep === 3) renderImpStash();
  }

  function buildMajorOptionsHtml(selectedMajorId, includeCustom) {
    ensureCustomCategoriesStructure();
    let html = '';
    MAJORS.forEach(m => {
      const sel = (m.id === selectedMajorId) ? ' selected' : '';
      html += `<option value="${esc(m.id)}"${sel}>${esc(m.icon || '📁')} ${esc(m.name)}</option>`;
    });
    if (includeCustom) {
      const sel = (selectedMajorId === 'custom') ? ' selected' : '';
      html += `<option value="custom"${sel}>⭐ 自定义</option>`;
    }
    return html;
  }

  function buildSubOptionsForMajorHtml(majorId, selectedSubId) {
    ensureCustomCategoriesStructure();
    if (majorId === 'custom') {
      const custs = state.customTagCats || [];
      return custs.map(c => {
        const sel = (c.id === selectedSubId) ? ' selected' : '';
        return `<option value="${esc(c.id)}"${sel}>${esc(c.icon || '🏷')} ${esc(c.name)}</option>`;
      }).join('');
    }
    const m = findTreeMajor(majorId) || MAJORS[0];
    if (!m) return '';
    return (m.children || []).map(s => {
      const sel = (s.id === selectedSubId) ? ' selected' : '';
      return `<option value="${esc(s.id)}"${sel}>${esc(s.icon || '•')} ${esc(s.name)}</option>`;
    }).join('');
  }

  function resolveMajorIdForSub(subId, includeCustom) {
    ensureCustomCategoriesStructure();
    if (includeCustom && (state.customTagCats || []).some(c => c.id === subId)) {
      return 'custom';
    }
    const hit = findTreeSub(subId);
    if (hit && hit.major) return hit.major.id;
    return (MAJORS[0] && MAJORS[0].id) || 'visual';
  }

  /* V1.0.1 Req 5: 解析当前主界面所选的大分类与小分类，供点击「导入」「导出」按钮自动定位目标大分类 */
  function resolveCurrentActiveMajorAndSub(preferSubId) {
    ensureCustomCategoriesStructure();
    if (preferSubId) {
      if ((state.customTagCats || []).some(c => c.id === preferSubId)) {
        return { majorId: 'custom', subId: preferSubId };
      }
      const hitP = findTreeSub(preferSubId);
      if (hitP) return { majorId: hitP.major.id, subId: hitP.sub.id };
    }
    const curCat = String(state.cat || 'all');
    if (curCat === 'custom') {
      const firstCust = (state.customTagCats && state.customTagCats[0] && state.customTagCats[0].id) || 'cust_tag_1';
      return { majorId: 'custom', subId: firstCust };
    }
    if (curCat === 'negative') {
      return { majorId: 'negative', subId: 'negative' };
    }
    if (curCat.indexOf('nsfw_major:') === 0) {
      const mid = curCat.slice(11);
      const m = findTreeMajor(mid);
      if (m) {
        const firstSub = (m.children && m.children[0] && m.children[0].id) || 'style';
        return { majorId: m.id, subId: firstSub };
      }
    }
    if (curCat.indexOf('major:') === 0) {
      const mid = curCat.slice(6);
      const m = findTreeMajor(mid);
      if (m) {
        const firstSub = (m.children && m.children[0] && m.children[0].id) || 'style';
        return { majorId: m.id, subId: firstSub };
      }
    }
    const hit = findTreeSub(curCat);
    if (hit) {
      return { majorId: hit.major.id, subId: hit.sub.id };
    }
    const defMajor = (MAJORS && MAJORS[0]) || { id: 'visual', children: [{ id: 'style' }] };
    return {
      majorId: defMajor.id,
      subId: (defMajor.children && defMajor.children[0] && defMajor.children[0].id) || 'style'
    };
  }

  function buildSubGroupOptionsHtml(selectedId, includeCustom) {
    ensureCustomCategoriesStructure();
    let html = '';
    MAJORS.forEach(m => {
      (m.children || []).forEach(s => {
        const sel = (s.id === selectedId) ? ' selected' : '';
        html += `<option value="${esc(s.id)}"${sel}>${esc(m.name)} › ${esc(s.icon || '•')} ${esc(s.name)}</option>`;
      });
    });
    if (includeCustom !== false) {
      (state.customTagCats || []).forEach(c => {
        const sel = (c.id === selectedId) ? ' selected' : '';
        html += `<option value="${esc(c.id)}"${sel}>⭐ 自定义 › ${esc(c.icon || '🏷')} ${esc(c.name)}</option>`;
      });
    }
    return html;
  }

  function syncDualSelectPair(majorSelEl, subSelEl, preferSubId, includeCustom, explicitMajorId) {
    if (!majorSelEl || !subSelEl) return;
    const defSub = preferSubId || (CATS[0] && CATS[0].id) || 'style';
    let majId = explicitMajorId || resolveMajorIdForSub(defSub, includeCustom);
    if (!includeCustom && majId === 'custom') {
      majId = (MAJORS[0] && MAJORS[0].id) || 'visual';
    }
    majorSelEl.innerHTML = buildMajorOptionsHtml(majId, includeCustom);
    majorSelEl.value = majId;
    subSelEl.innerHTML = buildSubOptionsForMajorHtml(majId, defSub);
    if (Array.prototype.some.call(subSelEl.options, o => o.value === defSub)) {
      subSelEl.value = defSub;
    }
  }

  function fillImpTargetSel(preferId, preferMajorId) {
    ensureCustomCategoriesStructure();
    const resolved = resolveCurrentActiveMajorAndSub(preferId);
    const majId = preferMajorId || resolved.majorId;
    const defId = preferId || resolved.subId;
    syncDualSelectPair($('#impTargetMajorSel2'), $('#impTargetSubSel2'), defId, true, majId);
    syncDualSelectPair($('#stageEditMajorSel'), $('#stageEditSubSel'), defId, true, majId);
    ['#batchMoveTargetSubSel'].forEach(q => {
      const sel = $(q);
      if (!sel) return;
      sel.innerHTML = buildSubGroupOptionsHtml(defId, true);
      if (defId && Array.prototype.some.call(sel.options, o => o.value === defId)) sel.value = defId;
    });
  }

  function guessSubIdFromTitle(rawTitle, fallbackId) {
    const s = String(rawTitle || '').trim();
    const fb = fallbackId || ($('#impTargetSubSel2') && $('#impTargetSubSel2').value) || (CATS[0] && CATS[0].id) || 'style';
    if (!s) return fb;
    const clean = s.replace(/^[0-9一二三四五六七八九十]+[、.．\s-]*/, '').trim();
    const low = clean.toLowerCase();
    ensureCustomCategoriesStructure();
    for (const c of (state.customTagCats || [])) {
      if (c.id.toLowerCase() === low || c.name === clean) return c.id;
    }
    for (const c of CATS) {
      if (c.id.toLowerCase() === low || c.name === clean || clean.includes(c.name) || c.name.includes(clean)) {
        return c.id;
      }
    }
    if (IMP_HEADER_HINT_MAP[clean]) return IMP_HEADER_HINT_MAP[clean];
    for (const [k, v] of Object.entries(IMP_HEADER_HINT_MAP)) {
      if (clean.includes(k)) return v;
    }
    return fb;
  }

  /* V1.0.1 Req 4: 支持保留暂存库中来自 JSON 的大分类与小分类名称/归属，不被默认画面与镜头覆盖 */
  function getSubDisplayInfo(subId, groupMetaHint) {
    ensureCustomCategoriesStructure();
    const g = groupMetaHint || (_impStage && Array.isArray(_impStage.groups) ? _impStage.groups.find(x => x && x.id === subId) : null);

    // If group has an explicit majorId assigned (e.g. from JSON import or user clicking「⇄ 切换」on major header)
    if (g && g.majorId) {
      if (g.majorId === 'custom') {
        const custSub = (state.customTagCats || []).find(c => c.id === subId);
        const sName = (custSub && custSub.name) || g.name || subId;
        return {
          id: subId,
          name: sName,
          majorId: 'custom',
          majorName: '自定义',
          majorIcon: '⭐',
          icon: (custSub && custSub.icon) || g.icon || '🏷',
          fullName: `自定义 › ${sName}`
        };
      }
      const explicitMaj = findTreeMajor(g.majorId);
      const hitSub = findTreeSub(subId);
      const mId = explicitMaj ? explicitMaj.id : g.majorId;
      const mName = explicitMaj ? explicitMaj.name : (g.majorName || g.majorId);
      const mIcon = explicitMaj ? (explicitMaj.icon || '📁') : (g.majorIcon || '📁');
      const sName = g.name || (hitSub && hitSub.sub.name) || subId;
      const sIcon = g.icon || (hitSub && hitSub.sub.icon) || '🏷';
      return {
        id: subId,
        name: sName,
        majorId: mId,
        majorName: mName,
        majorIcon: mIcon,
        icon: sIcon,
        fullName: `${mName} › ${sName}`
      };
    }

    const custSub = (state.customTagCats || []).find(c => c.id === subId);
    if (custSub) {
      return {
        id: custSub.id,
        name: custSub.name,
        majorId: 'custom',
        majorName: '自定义',
        majorIcon: '⭐',
        icon: custSub.icon || '🏷',
        fullName: `自定义 › ${custSub.name}`
      };
    }
    const hit = findTreeSub(subId);
    if (hit) {
      return {
        id: hit.sub.id,
        name: hit.sub.name,
        majorId: hit.major.id,
        majorName: hit.major.name,
        majorIcon: hit.major.icon || '📁',
        icon: hit.sub.icon || hit.major.icon || '🏷',
        fullName: `${hit.major.name} › ${hit.sub.name}`
      };
    }
    const curActive = resolveCurrentActiveMajorAndSub();
    const fbMajor = findTreeMajor(curActive.majorId) || (MAJORS && MAJORS[0]) || { id: 'visual', name: '画面与镜头', icon: '🎬' };
    return {
      id: subId || 'style',
      name: (g && g.name) || subId || '未分类',
      majorId: fbMajor.id,
      majorName: fbMajor.name,
      majorIcon: fbMajor.icon || '📁',
      icon: (g && g.icon) || '🏷',
      fullName: `${fbMajor.name} › ${(g && g.name) || subId || '未分类'}`
    };
  }

  function openImportStudio(preferSubId) {
    ensureCustomCategoriesStructure();
    const resolved = resolveCurrentActiveMajorAndSub(preferSubId);
    if ($('#impTitleRow')) $('#impTitleRow').value = '0';
    if ($('#impDataStart')) $('#impDataStart').value = '1';
    openModal('modalTagImport');
    fillImpTargetSel(resolved.subId, resolved.majorId);
    switchImpStep(1);
    renderImpPrecheck();
    renderImpStash();
    setTimeout(() => { if ($('#impInput')) $('#impInput').focus(); }, 20);
  }

  /* V1.0.1 Req 4: 修复 JSON 识别导入暂存库（完整保留 JSON 内部的大分类与小分类层级结构，支持所有常见 JSON 分类格式） */
  function matchMajorByHint(hintIdOrName, fallbackMajorObj) {
    if (hintIdOrName) {
      const s = String(hintIdOrName).trim();
      const low = s.toLowerCase();
      if (low === 'custom' || s === '自定义') {
        return { id: 'custom', name: '自定义', icon: '⭐' };
      }
      for (const m of MAJORS) {
        if (m.id.toLowerCase() === low || m.name === s || s.includes(m.name) || m.name.includes(s)) {
          return { id: m.id, name: m.name, icon: m.icon || '📁' };
        }
      }
    }
    return fallbackMajorObj;
  }

  function matchSubByHint(subIdOrName, majorObj) {
    const s = String(subIdOrName || '').trim();
    if (!s) return null;
    const low = s.toLowerCase();
    if (majorObj && majorObj.id === 'custom') {
      const cHit = (state.customTagCats || []).find(c => c.id.toLowerCase() === low || c.name === s);
      if (cHit) return { id: cHit.id, name: cHit.name, icon: cHit.icon || '🏷', major: majorObj };
    }
    if (majorObj && majorObj.id !== 'custom') {
      const mTree = findTreeMajor(majorObj.id);
      if (mTree && Array.isArray(mTree.children)) {
        const sHit = mTree.children.find(ch => ch.id.toLowerCase() === low || ch.name === s);
        if (sHit) return { id: sHit.id, name: sHit.name, icon: sHit.icon || '🏷', major: { id: mTree.id, name: mTree.name, icon: mTree.icon || '📁' } };
      }
    }
    for (const m of MAJORS) {
      for (const ch of (m.children || [])) {
        if (ch.id.toLowerCase() === low || ch.name === s) {
          return { id: ch.id, name: ch.name, icon: ch.icon || '🏷', major: { id: m.id, name: m.name, icon: m.icon || '📁' } };
        }
      }
    }
    return null;
  }

  function importJsonToStaging(rawJsonText, sourceLabel) {
    const trimmed = String(rawJsonText || '').trim();
    if (!trimmed) {
      toast('JSON 内容为空，请先选择或粘贴导出的 JSON 文件');
      return false;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      toast('❌ JSON 格式校验失败：不是合法的 JSON 文件或数据');
      return false;
    }

    ensureCustomCategoriesStructure();
    const curSelMajId = ($('#impTargetMajorSel2') && $('#impTargetMajorSel2').value) || resolveCurrentActiveMajorAndSub().majorId;
    const curSelSubId = ($('#impTargetSubSel2') && $('#impTargetSubSel2').value) || resolveCurrentActiveMajorAndSub().subId;
    const defaultMajorObj = matchMajorByHint(curSelMajId, { id: 'visual', name: '画面与镜头', icon: '🎬' });
    const stagedBuckets = new Map();

    const ensureBucket = (rawSubId, rawSubName, rawSubIcon, majorHintObj) => {
      const matched = matchSubByHint(rawSubId || rawSubName, majorHintObj || defaultMajorObj);
      let finalSubId = matched ? matched.id : String(rawSubId || rawSubName || curSelSubId).trim();
      let finalSubName = matched ? matched.name : String(rawSubName || rawSubId || finalSubId).trim();
      let finalSubIcon = (rawSubIcon && rawSubIcon !== '•') ? rawSubIcon : ((matched && matched.icon) || '🏷');
      let finalMajor = (majorHintObj && majorHintObj.id) ? majorHintObj : ((matched && matched.major) || defaultMajorObj);

      if (!finalSubId) finalSubId = curSelSubId;
      // Ensure unique bucket per (majorId, subId)
      const bucketKey = `${finalMajor.id}::${finalSubId}`;
      if (!stagedBuckets.has(bucketKey)) {
        stagedBuckets.set(bucketKey, {
          id: finalSubId,
          name: finalSubName,
          majorId: finalMajor.id,
          majorName: finalMajor.name || finalMajor.id,
          majorIcon: finalMajor.icon || '📁',
          icon: finalSubIcon,
          tags: []
        });
      }
      return stagedBuckets.get(bucketKey);
    };

    const pushTagToBucket = (bucket, t) => {
      if (!t) return;
      if (typeof t === 'string') {
        const p = parsePair(t.trim());
        if (!p.en) return;
        bucket.tags.push({ en: cleanArtistEn(p.en), zh: p.zh || zhLookup(p.en) || '', moveFromOther: true });
        return;
      }
      const en = cleanArtistEn(String(t.en || t.tag || t.name || t.prompt || '').trim());
      const zh = String(t.zh || t.cn || t.translation || zhLookup(en) || '').trim();
      const desc = String(t.desc || '').trim();
      if (!en) return;
      const item = { en, zh, moveFromOther: true };
      if (desc) item.desc = desc;
      bucket.tags.push(item);
    };

    const ingestSubObj = (sc, parentMajObj) => {
      if (!sc || typeof sc !== 'object') return;
      const sId = sc.id || sc.subId || sc.key || sc.name || sc.title || '';
      const sName = sc.name || sc.title || sc.label || sId || '导入小分类';
      const mHint = sc.parentId ? matchMajorByHint(sc.parentId, parentMajObj) : parentMajObj;
      const b = ensureBucket(sId, sName, sc.icon, mHint);
      const tagList = sc.tags || sc.items || sc.list || sc.data || [];
      if (Array.isArray(tagList)) {
        tagList.forEach(t => pushTagToBucket(b, t));
      } else if (tagList && typeof tagList === 'object') {
        Object.entries(tagList).forEach(([k, v]) => {
          if (typeof v === 'string') pushTagToBucket(b, { en: k, zh: v });
          else if (v && typeof v === 'object') pushTagToBucket(b, { en: v.en || k, zh: v.zh || '' });
        });
      }
    };

    const ingestMajorObj = (mj) => {
      if (!mj || typeof mj !== 'object') return;
      const mId = mj.id || mj.majorId || mj.key || ('maj_' + norm(mj.name || 'import'));
      const mName = mj.name || mj.title || mId;
      const mIcon = mj.icon || '📁';
      const majObj = matchMajorByHint(mId, { id: mId, name: mName, icon: mIcon });
      // Preserve JSON's own major name if it's a custom/new major in JSON
      const effectiveMaj = findTreeMajor(majObj.id) || majObj.id === 'custom'
        ? majObj
        : { id: mId, name: mName, icon: mIcon };
      const subs = mj.children || mj.subcategories || mj.subs || mj.groups || [];
      if (Array.isArray(subs) && subs.length) {
        subs.forEach(sc => ingestSubObj(sc, effectiveMaj));
      } else if (Array.isArray(mj.tags)) {
        ingestSubObj(mj, effectiveMaj);
      }
    };

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.scope === 'sub' && parsed.subcategory) {
        const pMaj = parsed.parentMajor
          ? matchMajorByHint(parsed.parentMajor.id || parsed.parentMajor.name, { id: parsed.parentMajor.id || defaultMajorObj.id, name: parsed.parentMajor.name || defaultMajorObj.name, icon: parsed.parentMajor.icon || '📁' })
          : defaultMajorObj;
        ingestSubObj(parsed.subcategory, pMaj);
      } else if (parsed.scope === 'major' && parsed.major) {
        ingestMajorObj(parsed.major);
      } else if (Array.isArray(parsed.majors)) {
        parsed.majors.forEach(mj => ingestMajorObj(mj));
      } else if (Array.isArray(parsed.children) || Array.isArray(parsed.subcategories) || Array.isArray(parsed.subs) || Array.isArray(parsed.groups)) {
        ingestMajorObj(parsed);
      } else if (Array.isArray(parsed.tags)) {
        const pMaj = parsed.parentId ? matchMajorByHint(parsed.parentId, defaultMajorObj) : defaultMajorObj;
        ingestSubObj(parsed, pMaj);
      } else {
        // Check if root object is { "大分类或小分类名": [...] or { "小分类名": [...] } }
        let handledStructured = false;
        Object.entries(parsed).forEach(([key, val]) => {
          if (/^(app|packageType|version|scope|exportedAt|updatedAt)$/i.test(key)) return;
          if (Array.isArray(val)) {
            handledStructured = true;
            const b = ensureBucket(key, key, '🏷', defaultMajorObj);
            val.forEach(t => pushTagToBucket(b, t));
          } else if (val && typeof val === 'object') {
            if (Array.isArray(val.tags) || Array.isArray(val.children) || Array.isArray(val.subcategories)) {
              handledStructured = true;
              if (Array.isArray(val.children) || Array.isArray(val.subcategories)) {
                ingestMajorObj({ id: val.id || key, name: val.name || key, icon: val.icon, children: val.children || val.subcategories });
              } else {
                ingestSubObj({ id: val.id || key, name: val.name || key, icon: val.icon, tags: val.tags }, defaultMajorObj);
              }
            } else {
              // Could be { "大分类名": { "小分类名": [tags...] } } or { "小分类名": { "en": "zh" } }
              const childEntries = Object.entries(val);
              const hasSubArrays = childEntries.some(([, cv]) => Array.isArray(cv) || (cv && typeof cv === 'object' && Array.isArray(cv.tags)));
              if (hasSubArrays) {
                handledStructured = true;
                const majHint = matchMajorByHint(key, { id: key, name: key, icon: '📁' });
                childEntries.forEach(([subKey, subVal]) => {
                  if (Array.isArray(subVal)) {
                    const b = ensureBucket(subKey, subKey, '🏷', majHint);
                    subVal.forEach(t => pushTagToBucket(b, t));
                  } else if (subVal && typeof subVal === 'object' && Array.isArray(subVal.tags)) {
                    ingestSubObj({ id: subVal.id || subKey, name: subVal.name || subKey, icon: subVal.icon, tags: subVal.tags }, majHint);
                  }
                });
              } else if (childEntries.length && childEntries.every(([, cv]) => typeof cv === 'string')) {
                handledStructured = true;
                const b = ensureBucket(key, key, '🏷', defaultMajorObj);
                childEntries.forEach(([enKey, zhVal]) => pushTagToBucket(b, { en: enKey, zh: zhVal }));
              }
            }
          }
        });
        if (!handledStructured) {
          const extracted = extractTagsFromUnknownContent(trimmed);
          if (extracted.length) {
            const b = ensureBucket(curSelSubId, null, '🏷', defaultMajorObj);
            extracted.forEach(t => pushTagToBucket(b, t));
          }
        }
      }
    } else if (Array.isArray(parsed)) {
      const hasSubObjs = parsed.some(it => it && typeof it === 'object' && (Array.isArray(it.tags) || Array.isArray(it.children)));
      if (hasSubObjs) {
        parsed.forEach(it => {
          if (Array.isArray(it.children)) ingestMajorObj(it);
          else if (Array.isArray(it.tags)) ingestSubObj(it, defaultMajorObj);
        });
      } else {
        parsed.forEach(t => {
          if (t && typeof t === 'object' && (t.subId || t.subcategory || t.category || t.group)) {
            const subHint = t.subId || t.subcategory || t.group || t.category;
            const majHint = t.majorId || t.major ? matchMajorByHint(t.majorId || t.major, defaultMajorObj) : defaultMajorObj;
            const b = ensureBucket(subHint, subHint, '🏷', majHint);
            pushTagToBucket(b, t);
          } else {
            const b = ensureBucket(curSelSubId, null, '🏷', defaultMajorObj);
            pushTagToBucket(b, t);
          }
        });
      }
    }

    let addedTotal = 0;
    let mergedTotal = 0;
    stagedBuckets.forEach(bucket => {
      if (!bucket.tags.length) return;
      let g = (_impStage.groups || []).find(x => x.id === bucket.id && x.majorId === bucket.majorId);
      if (!g) {
        g = {
          id: bucket.id,
          name: bucket.name,
          majorId: bucket.majorId,
          majorName: bucket.majorName,
          majorIcon: bucket.majorIcon,
          icon: bucket.icon,
          tags: []
        };
        _impStage.groups.push(g);
      } else {
        g.name = bucket.name || g.name;
        g.majorId = bucket.majorId || g.majorId;
        g.majorName = bucket.majorName || g.majorName;
        g.majorIcon = bucket.majorIcon || g.majorIcon;
      }
      bucket.tags.forEach(it => {
        const k = norm(it.en);
        if (!k) return;
        const ex = g.tags.find(x => norm(x.en) === k);
        if (ex) {
          if (it.zh && !ex.zh) ex.zh = it.zh;
          if (it.desc && !ex.desc) ex.desc = it.desc;
          ex.moveFromOther = true;
          mergedTotal++;
        } else {
          g.tags.push(it);
          addedTotal++;
        }
      });
      _impExpandedMajors.add(g.majorId);
      _impExpandedGroups.add(g.id);
    });

    if (!addedTotal && !mergedTotal) {
      toast('⚠ 未能从该 JSON 中识别出有效标签数据');
      return false;
    }

    saveImpStageToLocal();
    updateImpStepBadges();
    renderImpStash();
    switchImpStep(3);
    if ($('#impPasteInfo')) {
      $('#impPasteInfo').textContent = `✅ JSON 识别成功（${sourceLabel || 'JSON'}）：存入暂存库 ${addedTotal} 条` + (mergedTotal ? `（合并 ${mergedTotal} 条）` : '');
    }
    toast(`✅ JSON 已存入暂存库：共 ${stagedBuckets.size} 个小分类，新增 ${addedTotal} 条` + (mergedTotal ? `，合并 ${mergedTotal} 条` : ''));
    return true;
  }
  window.importJsonToStaging = importJsonToStaging;

  function parseImpRawTextToGrid(text) {
    let s = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (!s.trim()) return [];
    const lines = s.split('\n').filter(l => l.trim().length > 0);
    if (!lines.length) return [];
    const first = lines[0];
    let sep = '\t';
    if (first.includes('\t')) sep = '\t';
    else if (first.includes('|') && !first.includes(',')) sep = '|';
    else if ((first.match(/,/g) || []).length >= 1) sep = ',';

    const parseLine = line => {
      if (sep === '\t') return line.split('\t').map(c => c.trim());
      if (sep === '|') return line.split('|').map(c => c.trim());
      const out = [];
      let cur = '', inQ = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
          else inQ = !inQ;
        } else if (ch === sep && !inQ) {
          out.push(cur.trim());
          cur = '';
        } else {
          cur += ch;
        }
      }
      out.push(cur.trim());
      return out;
    };

    const rows = lines.map(parseLine);
    while (rows.length && rows[rows.length - 1].every(c => !c)) rows.pop();
    const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
    rows.forEach(r => { while (r.length < maxCols) r.push(''); });
    return rows;
  }

  function looksEnglishCell(s) {
    s = String(s || '').trim();
    if (!s) return false;
    if (/[\u4e00-\u9fff]/.test(s)) return false;
    return /[a-zA-Z0-9_()\-]/.test(s);
  }

  function colIndexToLetter(idx) {
    let s = '', n = idx + 1;
    while (n > 0) {
      const r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function getImpColRoles() {
    return [
      ($('#impColRole1') && $('#impColRole1').value) || 'en',
      ($('#impColRole2') && $('#impColRole2').value) || 'zh',
      ($('#impColRole3') && $('#impColRole3').value) || 'none'
    ];
  }

  function extractCellsByColRoles(row, baseColIdx, roles, maxRoles) {
    const res = { en: '', zh: '', desc: '', grp: '' };
    if (!row || !Array.isArray(row)) return res;
    const limit = Math.min(roles.length, maxRoles || roles.length);
    for (let i = 0; i < limit; i++) {
      const role = roles[i];
      if (!role || role === 'none') continue;
      const cIdx = baseColIdx + i;
      const val = (cIdx >= 0 && cIdx < row.length) ? String(row[cIdx] || '').trim() : '';
      if (!val) continue;
      if (role === 'en') res.en = res.en ? (res.en + ', ' + val) : val;
      else if (role === 'zh') res.zh = res.zh ? (res.zh + '，' + val) : val;
      else if (role === 'desc') res.desc = res.desc ? (res.desc + ' ' + val) : val;
      else if (role === 'grp') res.grp = val;
    }
    return res;
  }

  function detectAndSetupImpGrid() {
    const raw = ($('#impInput') && $('#impInput').value) || '';
    _impGrid = parseImpRawTextToGrid(raw);
    const info = $('#impPasteInfo');
    if (!_impGrid.length) {
      if (info) info.textContent = '等待粘贴或载入数据…';
      _impColPairs = [];
      renderImpLayoutCfg();
      return false;
    }
    const nRows = _impGrid.length;
    const nCols = _impGrid[0].length;
    if (info) info.textContent = `已识别 ${nRows} 行 × ${nCols} 列`;

    if ($('#impSelLayout')) {
      const curLayout = $('#impSelLayout').value;
      if (!curLayout) {
        $('#impSelLayout').value = nCols <= 3 ? 'custom' : 'wide';
      } else if (curLayout === 'wide' && nCols <= 3) {
        $('#impSelLayout').value = 'custom';
      }
    }
    if ($('#impTitleRow') && $('#impTitleRow').value === '') $('#impTitleRow').value = '0';
    if ($('#impDataStart') && $('#impDataStart').value === '') $('#impDataStart').value = '1';
    rebuildImpLayoutPairs();
    return true;
  }

  function rebuildImpLayoutPairs() {
    if (!_impGrid.length) {
      renderImpLayoutCfg();
      return;
    }
    const layout = ($('#impSelLayout') && $('#impSelLayout').value) || 'custom';
    const titleRow = parseInt(($('#impTitleRow') && $('#impTitleRow').value) || '0', 10) || 0;
    const nCols = _impGrid[0].length;
    const tRow = titleRow >= 1 && titleRow <= _impGrid.length ? _impGrid[titleRow - 1] : [];
    const fallbackId = ($('#impTargetSubSel2') && $('#impTargetSubSel2').value) || (CATS[0] && CATS[0].id) || 'style';

    if (layout === 'wide' || layout === 'wide3') {
      const step = layout === 'wide3' ? 3 : 2;
      _impColPairs = [];
      for (let c = 0; c < nCols; c += step) {
        const rawTitle = (tRow[c] || tRow[c + 1] || (step === 3 ? tRow[c + 2] : '') || '').trim();
        const hasAny = _impGrid.some((r, idx) => idx !== titleRow - 1 && ((r[c] || '').trim() || (r[c + 1] || '').trim() || (step === 3 && (r[c + 2] || '').trim())));
        const subId = rawTitle ? guessSubIdFromTitle(rawTitle, fallbackId) : fallbackId;
        _impColPairs.push({
          enCol: c,
          zhCol: c + 1,
          descCol: step === 3 ? c + 2 : -1,
          rawTitle: rawTitle || (step === 3 ? `第 ${c + 1}/${c + 2}/${c + 3} 列` : `第 ${c + 1}/${c + 2} 列`),
          subId,
          enabled: hasAny
        });
      }
    } else if (layout === 'long') {
      const roles = getImpColRoles();
      _impLongMap = {
        en: roles.indexOf('en'),
        zh: roles.indexOf('zh'),
        desc: roles.indexOf('desc'),
        grp: roles.indexOf('grp')
      };
    }
    renderImpLayoutCfg();
  }

  function renderImpLayoutCfg() {
    const layout = ($('#impSelLayout') && $('#impSelLayout').value) || 'custom';
    const wideBox = $('#impCfgWide');
    const longBox = $('#impCfgLong');
    const colRoleRow = $('#impColRoleRow');
    if (colRoleRow) colRoleRow.hidden = (layout === 'long');
    if (wideBox) wideBox.hidden = (layout !== 'wide' && layout !== 'wide3');
    if (longBox) longBox.hidden = (layout !== 'long');

    if ((layout === 'wide' || layout === 'wide3') && wideBox) {
      if (!_impColPairs.length) {
        wideBox.innerHTML = '';
        return;
      }
      wideBox.innerHTML = _impColPairs.map((p, idx) => {
        const majId = resolveMajorIdForSub(p.subId, true);
        return `
        <div class="ts-pair">
          <label class="chk"><input type="checkbox" data-imp-pair-on="${idx}" ${p.enabled ? 'checked' : ''}> <span class="ts-col-lbl">列 ${colIndexToLetter(p.enCol)}+${colIndexToLetter(p.zhCol)}</span></label>
          <span class="muted small" title="原表头名称"><b>${esc(p.rawTitle)}</b></span>
          <div style="display:flex;gap:6px;flex:1;min-width:220px">
            <select data-imp-pair-major="${idx}" style="flex:1;min-width:110px" title="左边：大分类（含自定义）">${buildMajorOptionsHtml(majId, true)}</select>
            <select data-imp-pair-sub="${idx}" style="flex:1;min-width:120px" title="右边：小分类">${buildSubOptionsForMajorHtml(majId, p.subId)}</select>
          </div>
        </div>
      `;
      }).join('');
    } else if (layout === 'long' && longBox) {
      const nCols = (_impGrid[0] && _impGrid[0].length) || 3;
      const colOpts = (selIdx, allowNone) => {
        let h = allowNone ? `<option value="-1">（无）</option>` : '';
        for (let c = 0; c < nCols; c++) {
          h += `<option value="${c}" ${c === selIdx ? 'selected' : ''}>第 ${c + 1} 列 (${colIndexToLetter(c)})</option>`;
        }
        return h;
      };
      longBox.innerHTML = `
        <div class="ts-rowline">
          <span class="ts-lb">英文列</span>
          <select id="impLongEnCol" style="width:130px">${colOpts(_impLongMap.en, true)}</select>
          <span class="ts-lb">中文列</span>
          <select id="impLongZhCol" style="width:130px">${colOpts(_impLongMap.zh, true)}</select>
          <span class="ts-lb">介绍列</span>
          <select id="impLongDescCol" style="width:130px">${colOpts(_impLongMap.desc, true)}</select>
          <span class="ts-lb">分组列</span>
          <select id="impLongGrpCol" style="width:130px">${colOpts(_impLongMap.grp, true)}</select>
        </div>
      `;
    }
  }

  function normImpTagKey(en) {
    return normDedupKey(en);
  }

  function splitMultiCellPair(enRaw, zhRaw, doSplit) {
    let en = String(enRaw || '').trim();
    let zh = String(zhRaw || '').trim();
    if (!en && zh && (zh.includes('|') || zh.includes('\t'))) {
      const p = zh.split(/[|\t]/);
      en = (p[0] || '').trim();
      zh = (p.slice(1).join(' ') || '').trim();
    } else if (en && !zh && en.includes('|')) {
      const i = en.indexOf('|');
      zh = en.slice(i + 1).trim();
      en = en.slice(0, i).trim();
    }
    if (!doSplit) return [{ en, zh }];
    const enParts = en.split(/[,，\n；;]+/).map(s => s.trim()).filter(Boolean);
    if (enParts.length <= 1) return [{ en: enParts[0] || en, zh }];
    const zhParts = zh.split(/[,，、\n；;]+/).map(s => s.trim()).filter(Boolean);
    if (zhParts.length === enParts.length) {
      return enParts.map((e, i) => ({ en: e, zh: zhParts[i] }));
    }
    return enParts.map(e => ({ en: e, zh }));
  }

  function buildExistingTagLookup(strict) {
    ensureCustomCategoriesStructure();
    const map = new Map();
    const fs = window.PG_TAG_FS;
    (fs.majors || []).forEach(m => {
      (m.children || []).forEach(s => {
        (s.tags || []).forEach(t => {
          const k = normImpTagKey(cleanArtistEn(t.en), strict);
          if (!k) return;
          if (!map.has(k)) map.set(k, []);
          map.get(k).push({ subId: s.id, majorId: m.id, subName: `${m.name} › ${s.name}`, zh: t.zh || '', en: t.en });
        });
      });
    });
    (state.customTagCats || []).forEach(c => {
      (c.tags || []).forEach(t => {
        const k = normImpTagKey(cleanArtistEn(t.en), strict);
        if (!k) return;
        if (!map.has(k)) map.set(k, []);
        map.get(k).push({ subId: c.id, majorId: 'custom', subName: `自定义 › ${c.name}`, zh: t.zh || '', en: t.en });
      });
    });
    return map;
  }

  function buildImpPrecheckList() {
    if (!_impGrid.length) {
      if (!detectAndSetupImpGrid()) {
        toast('请先在文本框中粘贴 Excel 表格或文本数据');
        return false;
      }
    }
    const layout = ($('#impSelLayout') && $('#impSelLayout').value) || 'wide';
    const dataStart = Math.max(1, parseInt(($('#impDataStart') && $('#impDataStart').value) || '1', 10) || 1);
    const fallbackSubId = ($('#impTargetSubSel2') && $('#impTargetSubSel2').value) || (CATS[0] && CATS[0].id) || 'style';
    const strategy = ($('#impSelStrategy') && $('#impSelStrategy').value) || 'skip';
    const joiner = ($('#impSelJoin') && $('#impSelJoin').value) || '，';
    const doSplit = !!($('#impChkSplit') && $('#impChkSplit').checked);
    const strict = !!($('#impChkStrict') && $('#impChkStrict').checked);
    const defaultMoveOther = !$('#impChkMoveOtherDup') || $('#impChkMoveOtherDup').checked;

    const rawItems = [];
    const colRoles = getImpColRoles();
    if (layout === 'custom') {
      for (let r = dataStart - 1; r < _impGrid.length; r++) {
        const row = _impGrid[r];
        const extracted = extractCellsByColRoles(row, 0, colRoles, 3);
        const eCell = extracted.en;
        const zCell = extracted.zh;
        const dCell = extracted.desc;
        const gCell = extracted.grp;
        if (!eCell && !zCell) continue;
        const subId = gCell ? guessSubIdFromTitle(gCell, fallbackSubId) : fallbackSubId;
        splitMultiCellPair(eCell, zCell, doSplit).forEach(pair => {
          if (!pair.en && !pair.zh) return;
          rawItems.push({ en: pair.en, zh: pair.zh, desc: dCell, subId, srcRow: r + 1 });
        });
      }
    } else if (layout === 'wide' || layout === 'wide3') {
      const step = layout === 'wide3' ? 3 : 2;
      for (let r = dataStart - 1; r < _impGrid.length; r++) {
        const row = _impGrid[r];
        _impColPairs.forEach(p => {
          if (!p.enabled) return;
          const extracted = extractCellsByColRoles(row, p.enCol, colRoles, step);
          const eCell = extracted.en;
          const zCell = extracted.zh;
          const dCell = extracted.desc;
          const gCell = extracted.grp;
          if (!eCell && !zCell) return;
          const rowSubId = gCell ? guessSubIdFromTitle(gCell, p.subId || fallbackSubId) : (p.subId || fallbackSubId);
          splitMultiCellPair(eCell, zCell, doSplit).forEach(pair => {
            if (!pair.en && !pair.zh) return;
            rawItems.push({ en: pair.en, zh: pair.zh, desc: dCell, subId: rowSubId, srcRow: r + 1 });
          });
        });
      }
    } else {
      const enC = $('#impLongEnCol') ? parseInt($('#impLongEnCol').value, 10) : _impLongMap.en;
      const zhC = $('#impLongZhCol') ? parseInt($('#impLongZhCol').value, 10) : _impLongMap.zh;
      const dsC = $('#impLongDescCol') ? parseInt($('#impLongDescCol').value, 10) : _impLongMap.desc;
      const grC = $('#impLongGrpCol') ? parseInt($('#impLongGrpCol').value, 10) : _impLongMap.grp;
      for (let r = dataStart - 1; r < _impGrid.length; r++) {
        const row = _impGrid[r];
        const eCell = (enC >= 0 && enC < row.length) ? String(row[enC] || '').trim() : '';
        const zCell = (zhC >= 0 && zhC < row.length) ? String(row[zhC] || '').trim() : '';
        const dCell = (dsC >= 0 && dsC < row.length) ? String(row[dsC] || '').trim() : '';
        const gCell = (grC >= 0 && grC < row.length) ? String(row[grC] || '').trim() : '';
        if (!eCell && !zCell) continue;
        const subId = gCell ? guessSubIdFromTitle(gCell, fallbackSubId) : fallbackSubId;
        splitMultiCellPair(eCell, zCell, doSplit).forEach(pair => {
          if (!pair.en && !pair.zh) return;
          rawItems.push({ en: pair.en, zh: pair.zh, desc: dCell, subId, srcRow: r + 1 });
        });
      }
    }

    const existMap = buildExistingTagLookup(strict);
    const seenBatch = new Map();
    const list = [];

    rawItems.forEach((it, idx) => {
      const en = cleanArtistEn(String(it.en || '').trim());
      let zh = String(it.zh || '').trim();
      let desc = String(it.desc || '').trim();
      const subId = it.subId || fallbackSubId;
      if (/^(英文|提示词|tag|prompt|english)$/i.test(en) && /^(中文|释义|翻译|zh|chinese)$/i.test(zh)) return;

      if (!en) {
        return;
      }
      if (/^[\u4e00-\u9fff]+$/.test(en)) {
        list.push({ id: idx, en, zh, subId, status: 'bad', reason: '英文列填入纯中文', checked: false, otherSubs: [], moveFromOther: false });
        return;
      }
      if (!zh) zh = zhLookup(en) || '';

      const key = normImpTagKey(en, strict);
      if (seenBatch.has(key)) {
        const first = seenBatch.get(key);
        if (zh && first.zh && !first.zh.includes(zh)) first.zh = first.zh + joiner + zh;
        else if (zh && !first.zh) first.zh = zh;
        list.push({ id: idx, en, zh, subId, status: 'selfdup', reason: `与第 ${first.srcRow} 行重复（仅保留首条）`, checked: false, otherSubs: [], moveFromOther: false });
        return;
      }

      const hits = existMap.get(key) || [];
      const inSameHit = hits.find(h => h.subId === subId);
      const otherSubs = hits.filter(h => h.subId !== subId).map(h => h.subName);

      if (hits.length) {
        const refHit = inSameHit || hits[0];
        let finalZh = zh || refHit.zh;
        let checked = false;
        let moveFromOther = false;
        let note = '';

        if (!inSameHit && otherSubs.length) {
          moveFromOther = !!defaultMoveOther;
          checked = moveFromOther;
          note = `其他分类已存在：${otherSubs.join('、')}`;
          if (strategy === 'merge' && zh && refHit.zh && !refHit.zh.includes(zh)) {
            finalZh = refHit.zh + joiner + zh;
          }
        } else if (strategy === 'skip') {
          checked = false;
          note = '当前分类已存在';
        } else if (strategy === 'merge') {
          if (zh && refHit.zh && !refHit.zh.includes(zh)) {
            finalZh = refHit.zh + joiner + zh;
            checked = true;
            note = `合并更新原译文「${refHit.zh}」`;
          } else if (zh && !refHit.zh) {
            finalZh = zh;
            checked = true;
            note = '补全空译文';
          } else {
            finalZh = refHit.zh || zh;
            checked = false;
            note = '译文相同';
          }
        } else if (strategy === 'over') {
          finalZh = zh || refHit.zh;
          checked = !!zh && zh !== refHit.zh;
          note = checked ? `覆盖原译文「${refHit.zh || '空'}」` : '与原译文一致';
        } else if (strategy === 'fill') {
          if (!refHit.zh && zh) {
            finalZh = zh;
            checked = true;
            note = '自动补全';
          } else {
            finalZh = refHit.zh || zh;
            checked = false;
            note = `保留原译文`;
          }
        }
        const rowObj = {
          id: idx, en, zh: finalZh, desc, subId,
          status: inSameHit ? 'same' : 'other',
          reason: note,
          checked,
          inSame: !!inSameHit,
          otherSubs,
          moveFromOther,
          srcRow: it.srcRow
        };
        seenBatch.set(key, rowObj);
        list.push(rowObj);
        return;
      }

      const rowObj = {
        id: idx, en, zh, desc, subId,
        status: 'new',
        reason: '✅ 全新标签',
        checked: true,
        inSame: false,
        otherSubs: [],
        moveFromOther: false,
        srcRow: it.srcRow
      };
      seenBatch.set(key, rowObj);
      list.push(rowObj);
    });

    _impPrecheck = list;
    _impPrevPage = 0;
    updateImpStepBadges();
    renderImpPrecheck();
    return true;
  }

  function parseImport() {
    const raw = (($('#impInput') && $('#impInput').value) || '').trim();
    if (raw.startsWith('{') || raw.startsWith('[')) {
      if (importJsonToStaging(raw, '粘贴 JSON')) return;
    }
    if (!detectAndSetupImpGrid()) {
      toast('请先粘贴 Excel 表格或文本内容');
      return;
    }
    if (buildImpPrecheckList()) {
      switchImpStep(2);
      toast(`解析完成：共识别 ${_impPrecheck.length} 条记录`);
    }
  }

  function impBadge(r) {
    if (r.status === 'new') return `<span class="studio-badge new">✅ 新增</span>`;
    if (r.status === 'same') return `<span class="studio-badge dup" title="${esc(r.reason || '')}">已存在</span>`;
    if (r.status === 'other') {
      return `<span class="studio-badge existing" title="${esc(r.reason || '')}">重复 (${esc((r.otherSubs || []).slice(0, 2).join('、'))})</span>` +
        `<label class="imp-move-chk" title="勾选则移至当前目标分类并从原分类移除；取消勾选则保留在原分类"><input type="checkbox" data-imp-move-other="${r.id}" ${r.moveFromOther ? 'checked' : ''}> ⇄ 移入</label>`;
    }
    if (r.status === 'selfdup') return `<span class="studio-badge dup" title="${esc(r.reason || '')}">表内重复</span>`;
    return `<span class="studio-badge dup">${esc(r.reason || '无效')}</span>`;
  }

  function getFilteredImpPrecheck() {
    const f = ($('#impSelFilter') && $('#impSelFilter').value) || 'all';
    const q = (($('#impPrevSearch') && $('#impPrevSearch').value) || '').trim().toLowerCase();
    return _impPrecheck.filter(r => {
      if (f === 'new' && r.status !== 'new') return false;
      if (f === 'dup' && r.status !== 'same' && r.status !== 'other' && r.status !== 'selfdup') return false;
      if (f === 'bad' && r.status !== 'bad') return false;
      if (f === 'sel' && !r.checked) return false;
      if (q && !(String(r.en || '').toLowerCase().includes(q) || String(r.zh || '').toLowerCase().includes(q))) return false;
      return true;
    });
  }

  function renderImpPrecheck() {
    const tbody = $('#impPrecheckBody');
    const stat = $('#impPrecheckStat');
    const pager = $('#impPrevPager');
    if (!tbody) return;

    const cNew = _impPrecheck.filter(x => x.status === 'new').length;
    const cDup = _impPrecheck.filter(x => x.status === 'same' || x.status === 'other').length;
    const cOther = _impPrecheck.filter(x => x.status === 'other').length;
    const cSelf = _impPrecheck.filter(x => x.status === 'selfdup').length;
    const cBad = _impPrecheck.filter(x => x.status === 'bad').length;
    const cSel = _impPrecheck.filter(x => x.checked).length;

    if (stat) {
      if (!_impPrecheck.length) {
        stat.innerHTML = `<span>等待在「1 · 解析」中粘贴数据并点击解析…</span>`;
      } else {
        stat.innerHTML = `
          <span>总计 <b>${_impPrecheck.length}</b></span>
          <span>✅ 新增 <b>${cNew}</b></span>
          <span>⚠ 重复 <b>${cDup}</b>（跨类 <b>${cOther}</b>）</span>
          <span>表内重复 <b>${cSelf}</b></span>
          <span>无效 <b>${cBad}</b></span>
          <span>已选 <b>${cSel}</b></span>
        `;
      }
    }

    const filtered = getFilteredImpPrecheck();
    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="muted" style="text-align:center;padding:22px">暂无符合筛选条件的预检记录</td></tr>`;
      if (pager) pager.innerHTML = '';
      return;
    }

    const pages = Math.max(1, Math.ceil(filtered.length / IMP_PAGE_SIZE));
    if (_impPrevPage >= pages) _impPrevPage = pages - 1;
    if (_impPrevPage < 0) _impPrevPage = 0;
    const slice = filtered.slice(_impPrevPage * IMP_PAGE_SIZE, (_impPrevPage + 1) * IMP_PAGE_SIZE);

    tbody.innerHTML = slice.map(r => {
      const majId = resolveMajorIdForSub(r.subId, true);
      return `
      <tr class="${r.status === 'same' ? 'existing' : ''}${r.status === 'selfdup' || r.status === 'bad' ? 'dup' : ''}">
        <td><input type="checkbox" data-imp-check="${r.id}" ${r.checked ? 'checked' : ''} ${r.status === 'bad' ? 'disabled' : ''}></td>
        <td><input type="text" data-imp-en="${r.id}" value="${esc(r.en)}" autocomplete="off"></td>
        <td><input type="text" data-imp-zh="${r.id}" value="${esc(r.zh || '')}" autocomplete="off"></td>
        <td><input type="text" data-imp-desc="${r.id}" value="${esc(r.desc || '')}" placeholder="默认留空" autocomplete="off"></td>
        <td>
          <div style="display:flex;gap:4px">
            <select data-imp-grp-major="${r.id}" style="width:96px" title="大分类（含自定义）">${buildMajorOptionsHtml(majId, true)}</select>
            <select data-imp-grp="${r.id}" style="width:105px" title="小分类">${buildSubOptionsForMajorHtml(majId, r.subId)}</select>
          </div>
        </td>
        <td>${impBadge(r)}</td>
        <td><button type="button" class="icon" data-imp-del="${r.id}" title="移出预检">×</button></td>
      </tr>
    `;
    }).join('');

    if (pager) {
      if (pages <= 1) {
        pager.innerHTML = `<span class="muted small">共显示 ${filtered.length} 条</span>`;
      } else {
        pager.innerHTML = `
          <button type="button" class="mini" data-imp-page="-1" ${_impPrevPage === 0 ? 'disabled' : ''}>‹ 上一页</button>
          <span class="muted small">第 ${_impPrevPage + 1} / ${pages} 页（共 ${filtered.length} 条）</span>
          <button type="button" class="mini" data-imp-page="1" ${_impPrevPage >= pages - 1 ? 'disabled' : ''}>下一页 ›</button>
        `;
      }
    }
  }

  function addImpToStash() {
    const picked = _impPrecheck.filter(r => r.checked && r.status !== 'bad' && String(r.en || '').trim());
    if (!picked.length) {
      toast('请先勾选要加入暂存库的条目');
      return;
    }
    const joiner = ($('#impSelJoin') && $('#impSelJoin').value) || '，';
    const strict = !!($('#impChkStrict') && $('#impChkStrict').checked);
    let added = 0, merged = 0;

    picked.forEach(r => {
      const en = cleanArtistEn(String(r.en || '').trim());
      const zh = String(r.zh || '').trim();
      const desc = String(r.desc || '').trim();
      const subId = r.subId || (CATS[0] && CATS[0].id) || 'style';
      if (!en) return;
      const info = getSubDisplayInfo(subId);
      let g = (_impStage.groups || []).find(x => x.id === info.id);
      if (!g) {
        g = {
          id: info.id,
          name: info.name,
          majorId: info.majorId,
          majorName: info.majorName,
          majorIcon: info.majorIcon,
          icon: info.icon,
          tags: []
        };
        _impStage.groups.push(g);
      } else {
        g.majorId = info.majorId;
        g.majorName = info.majorName;
        g.majorIcon = info.majorIcon;
      }
      const k = normImpTagKey(en, strict);
      const ex = g.tags.find(t => normImpTagKey(t.en, strict) === k);
      if (ex) {
        if (zh && ex.zh && !ex.zh.includes(zh)) {
          ex.zh = ex.zh + joiner + zh;
          merged++;
        } else if (zh && !ex.zh) {
          ex.zh = zh;
          merged++;
        }
        ex.moveFromOther = true;
      } else {
        const stItem = { en, zh, moveFromOther: true };
        if (desc) stItem.desc = desc;
        g.tags.push(stItem);
        added++;
      }
      _impExpandedMajors.add(info.majorId);
      _impExpandedGroups.add(g.id);
    });

    _impPrecheck = _impPrecheck.filter(r => !r.checked);
    saveImpStageToLocal();
    renderImpPrecheck();
    renderImpStash();
    if ($('#impCommitInfo')) {
      $('#impCommitInfo').textContent = `✅ 已加入暂存库：新增 ${added} 条，合并 ${merged} 条`;
    }
    toast(`已加入暂存库：新增 ${added} 条` + (merged ? `，合并 ${merged} 条` : ''));
    switchImpStep(3);
  }

  /* =====================================================================
     (V1.0.1 Req 4) 暂存库：保留 JSON 原生大小分类、重复 tag 标识、大分类「切换」下拉、小分类无编辑按钮、框选支持、上下自由滑动
     ===================================================================== */
  function getStageTreeByMajor() {
    const groups = (_impStage.groups || []).filter(g => g && Array.isArray(g.tags) && g.tags.length > 0);
    const byMajor = new Map();
    groups.forEach(g => {
      const info = getSubDisplayInfo(g.id, g);
      g.name = g.name || info.name;
      g.icon = g.icon || info.icon;
      g.majorId = g.majorId || info.majorId;
      g.majorName = g.majorName || info.majorName;
      g.majorIcon = g.majorIcon || info.majorIcon;
      if (!byMajor.has(g.majorId)) {
        byMajor.set(g.majorId, {
          id: g.majorId,
          name: g.majorName,
          icon: g.majorIcon || '📁',
          subs: []
        });
      }
      byMajor.get(g.majorId).subs.push(g);
    });
    return Array.from(byMajor.values());
  }

  function isStageTagSelected(subId, ti) {
    if (_stageSelectedTags.has(`${subId}::${ti}`)) return true;
    if (_stageSelectedSubs.has(subId)) return true;
    const g = (_impStage.groups || []).find(x => x.id === subId);
    const info = getSubDisplayInfo(subId, g);
    if (_stageSelectedMajors.has(info.majorId)) return true;
    return false;
  }

  function isStageSubSelected(subId) {
    if (_stageSelectedSubs.has(subId)) return true;
    const g = (_impStage.groups || []).find(x => x.id === subId);
    const info = getSubDisplayInfo(subId, g);
    if (_stageSelectedMajors.has(info.majorId)) return true;
    if (!g || !g.tags || !g.tags.length) return false;
    return g.tags.every((_, ti) => _stageSelectedTags.has(`${subId}::${ti}`));
  }

  function isStageMajorSelected(majorId) {
    if (_stageSelectedMajors.has(majorId)) return true;
    const tree = getStageTreeByMajor();
    const m = tree.find(x => x.id === majorId);
    if (!m || !m.subs.length) return false;
    return m.subs.every(s => isStageSubSelected(s.id));
  }

  function toggleStageMajorSelect(majorId, forceState) {
    const tree = getStageTreeByMajor();
    const m = tree.find(x => x.id === majorId);
    if (!m) return;
    const next = typeof forceState === 'boolean' ? forceState : !isStageMajorSelected(majorId);
    if (next) _stageSelectedMajors.add(majorId);
    else _stageSelectedMajors.delete(majorId);
    m.subs.forEach(s => {
      if (next) _stageSelectedSubs.add(s.id);
      else _stageSelectedSubs.delete(s.id);
      (s.tags || []).forEach((_, ti) => {
        if (next) _stageSelectedTags.add(`${s.id}::${ti}`);
        else _stageSelectedTags.delete(`${s.id}::${ti}`);
      });
    });
    renderImpStash();
  }

  function toggleStageSubSelect(subId, forceState) {
    const g = (_impStage.groups || []).find(x => x.id === subId);
    if (!g) return;
    const info = getSubDisplayInfo(subId, g);
    const next = typeof forceState === 'boolean' ? forceState : !isStageSubSelected(subId);
    if (next) _stageSelectedSubs.add(subId);
    else {
      _stageSelectedSubs.delete(subId);
      _stageSelectedMajors.delete(info.majorId);
    }
    (g.tags || []).forEach((_, ti) => {
      if (next) _stageSelectedTags.add(`${subId}::${ti}`);
      else _stageSelectedTags.delete(`${subId}::${ti}`);
    });
    renderImpStash();
  }

  function toggleStageTagSelect(subId, ti, forceState) {
    const key = `${subId}::${ti}`;
    const g = (_impStage.groups || []).find(x => x.id === subId);
    const info = getSubDisplayInfo(subId, g);
    const cur = isStageTagSelected(subId, ti);
    const next = typeof forceState === 'boolean' ? forceState : !cur;
    if (cur && !next) {
      if (_stageSelectedMajors.has(info.majorId)) {
        _stageSelectedMajors.delete(info.majorId);
        const m = getStageTreeByMajor().find(x => x.id === info.majorId);
        if (m) {
          m.subs.forEach(s => {
            _stageSelectedSubs.add(s.id);
            (s.tags || []).forEach((_, idx) => _stageSelectedTags.add(`${s.id}::${idx}`));
          });
        }
      }
      if (_stageSelectedSubs.has(subId)) {
        _stageSelectedSubs.delete(subId);
        if (g) (g.tags || []).forEach((_, idx) => _stageSelectedTags.add(`${subId}::${idx}`));
      }
      _stageSelectedTags.delete(key);
    } else if (!cur && next) {
      _stageSelectedTags.add(key);
    }
    renderImpStash();
  }

  function countStageSelectedTags() {
    let n = 0;
    (_impStage.groups || []).forEach(g => {
      (g.tags || []).forEach((_, ti) => {
        if (isStageTagSelected(g.id, ti)) n++;
      });
    });
    return n;
  }

  /* V1.0.1 Req 4: 暂存库大分类右侧「切换」按钮：点击展开所有大分类，可一键切换该暂存大分类归属 */
  function openStageMajorSwitchPopover(sourceMajorId, anchorEl) {
    closeRsPopovers();
    const pop = $('#stMajorSwitchPopover');
    if (!pop || !anchorEl) return;
    ensureCustomCategoriesStructure();

    const options = MAJORS.map(m => ({
      id: m.id,
      name: m.name,
      icon: m.icon || '📁'
    })).concat([{ id: 'custom', name: '自定义', icon: '⭐' }]);

    pop.innerHTML = options.map(opt => `
      <div class="rs-iv-item ${opt.id === sourceMajorId ? 'active' : ''}" data-st-switch-maj="${esc(opt.id)}">
        <span>${esc(opt.icon)} ${esc(opt.name)}</span>
        ${opt.id === sourceMajorId ? '<span style="color:var(--accent2)">✓</span>' : ''}
      </div>
    `).join('');

    const rect = anchorEl.getBoundingClientRect();
    pop.hidden = false;
    pop.style.left = Math.min(window.innerWidth - 220, Math.max(8, rect.left)) + 'px';
    pop.style.top = Math.min(window.innerHeight - 280, rect.bottom + 4) + 'px';

    pop.onclick = e => {
      e.stopPropagation();
      const item = e.target.closest('[data-st-switch-maj]');
      if (!item) return;
      const targetMajId = item.getAttribute('data-st-switch-maj');
      closeRsPopovers();
      switchStagedMajorTo(sourceMajorId, targetMajId);
    };
  }

  function switchStagedMajorTo(fromMajorId, toMajorId) {
    if (!fromMajorId || !toMajorId || fromMajorId === toMajorId) return;
    ensureCustomCategoriesStructure();
    let targetMeta = null;
    if (toMajorId === 'custom') {
      targetMeta = { id: 'custom', name: '自定义', icon: '⭐' };
    } else {
      const m = findTreeMajor(toMajorId);
      if (!m) return;
      targetMeta = { id: m.id, name: m.name, icon: m.icon || '📁' };
    }

    let changedSubs = 0;
    (_impStage.groups || []).forEach(g => {
      const info = getSubDisplayInfo(g.id, g);
      if ((g.majorId || info.majorId) === fromMajorId) {
        g.majorId = targetMeta.id;
        g.majorName = targetMeta.name;
        g.majorIcon = targetMeta.icon;
        changedSubs++;
      }
    });

    if (changedSubs > 0) {
      _impExpandedMajors.delete(fromMajorId);
      _impExpandedMajors.add(targetMeta.id);
      saveImpStageToLocal();
      renderImpStash();
      toast(`✅ 已将该组下 ${changedSubs} 个小分类切换至大分类「${targetMeta.icon} ${targetMeta.name}」`);
    }
  }

  function renderImpStash() {
    const box = $('#impStash');
    const stat = $('#impStageStat');
    updateImpStepBadges();
    if (!box) return;

    const selCount = countStageSelectedTags();
    const hasSel = _stageSelectMode || selCount > 0;
    const btnSelMode = $('#btnStageSelectMode');
    const btnSelAll = $('#btnStageSelAll');
    const btnSelNone = $('#btnStageSelNone');
    const btnBatchImp = $('#btnStageBatchImport');
    const btnBatchDel = $('#btnStageBatchDelete');
    if (btnSelMode) {
      btnSelMode.classList.toggle('primary', hasSel);
      btnSelMode.textContent = hasSel ? `☑ 选择中 (${selCount})` : '☑ 选择';
    }
    if (btnSelAll) btnSelAll.hidden = !hasSel;
    if (btnSelNone) btnSelNone.hidden = !hasSel;
    if (btnBatchImp) btnBatchImp.hidden = !(hasSel && selCount > 0);
    if (btnBatchDel) btnBatchDel.hidden = !(hasSel && selCount > 0);

    const majorTree = getStageTreeByMajor();
    const total = totalImpStageTags();
    const subCount = (_impStage.groups || []).filter(g => g.tags && g.tags.length).length;

    // Build existing tag lookup & intra-staging duplicate frequency map (V1.2.5 Req 2: unify '_' and ' ')
    const existMap = buildExistingTagLookup(true);
    const stageFreq = new Map();
    (_impStage.groups || []).forEach(g => {
      (g.tags || []).forEach(t => {
        const k = normImpTagKey(t.en);
        if (k) stageFreq.set(k, (stageFreq.get(k) || 0) + 1);
      });
    });
    let dupTotal = 0;
    const seenInStage = new Set();
    (_impStage.groups || []).forEach(g => {
      (g.tags || []).forEach(t => {
        const k = normImpTagKey(t.en);
        const libHits = (existMap.get(k) || []).slice();
        const isIntraDup = (stageFreq.get(k) || 0) > 1;
        const isExtraIntraCopy = seenInStage.has(k);
        seenInStage.add(k);
        if (isIntraDup && !libHits.some(h => h.subId === '__stage_dup__')) {
          libHits.push({ subId: '__stage_dup__', majorId: 'stage', subName: '暂存库 › 内部重复' });
        }
        t._isExtraIntraCopy = isExtraIntraCopy;
        if (libHits.length > 0) {
          dupTotal++;
          t._dupHits = libHits;
        } else {
          delete t._dupHits;
        }
      });
    });

    if (stat) {
      stat.innerHTML = `
        <span>大分类 <b>${majorTree.length}</b></span>
        <span>小分类 <b>${subCount}</b></span>
        <span>暂存标签 <b>${total}</b></span>
        <span style="${dupTotal > 0 ? 'color:#fbbf24' : ''}">库内重复 <b>${dupTotal}</b></span>
        ${hasSel ? `<span>当前已选 <b>${selCount}</b></span>` : ''}
      `;
    }

    if (!majorTree.length) {
      box.innerHTML = `<div class="muted" style="text-align:center;padding:32px">暂存库为空 · 请在「1 · 解析」中粘贴数据解析或点击右上角「📦 JSON 识别」导入</div>`;
      return;
    }

    box.innerHTML = majorTree.map(m => {
      const mExp = _impExpandedMajors.has(m.id);
      const mTotal = m.subs.reduce((s, g) => s + (g.tags ? g.tags.length : 0), 0);
      const mChecked = isStageMajorSelected(m.id);

      const subsHtml = mExp ? `<div class="ts-major-body">${m.subs.map(g => {
        const gExp = _impExpandedGroups.has(g.id);
        const gChecked = isStageSubSelected(g.id);
        const tagsHtml = gExp ? `<div class="ts-sub-body"><div class="ts-tag-grid">${(g.tags || []).map((t, ti) => {
          const tChecked = isStageTagSelected(g.id, ti);
          const dupHits = t._dupHits || [];
          const isDup = dupHits.length > 0;
          const dupLocs = isDup ? dupHits.map(h => h.subName).join('、') : '';
          return `<div class="ts-tag-card ${tChecked ? 'selected st-selected' : ''} ${isDup ? 'is-dup-tag' : ''}" data-st-tag="${esc(g.id)}::${ti}" data-sid="${esc(g.id)}" data-ti="${ti}" title="${esc(t.en)}${t.zh ? ' · ' + esc(t.zh) : ''}${isDup ? ' · ⚠ 库内已存在: ' + esc(dupLocs) : ''}（点击编辑，右键可导入/删除，支持拖拽框选）">
            ${hasSel ? `<input type="checkbox" class="st-chk" data-st-chk-tag="${esc(g.id)}::${ti}" ${tChecked ? 'checked' : ''}>` : ''}
            <span class="en">${esc(t.en)}</span>
            ${t.zh ? `<span class="zh">${esc(t.zh)}</span>` : ''}
            ${isDup ? `<span class="st-dup-badge" title="已在库内存在：${esc(dupLocs)}">重·${esc(dupHits[0].subName.split('›').pop().trim())}</span>` : ''}
          </div>`;
        }).join('')}</div></div>` : '';

        // V1.0.1 Req 4: 小分类右侧删除「编辑」按钮，仅保留「导入」与「删除」
        return `<div class="ts-sub-group ${gExp ? 'open' : ''} ${gChecked ? 'selected st-selected' : ''}" data-st-sub="${esc(g.id)}">
          <div class="ts-sub-head" data-st-sub-toggle="${esc(g.id)}" title="点击展开/收起小分类 · 右键可导入或删除">
            ${hasSel ? `<input type="checkbox" class="st-chk" data-st-chk-sub="${esc(g.id)}" ${gChecked ? 'checked' : ''}>` : ''}
            <span class="ts-caret">${gExp ? '▾' : '▸'}</span>
            <span class="ts-sub-title">${esc(g.icon || '🏷')} ${esc(g.name)}</span>
            <span class="ts-cnt">${(g.tags || []).length} 条</span>
            <div class="ts-inline-acts" style="margin-left:auto;display:inline-flex;gap:6px">
              <button type="button" class="mini primary" data-st-act="import-sub" data-sid="${esc(g.id)}">导入</button>
              <button type="button" class="mini danger" data-st-act="del-sub" data-sid="${esc(g.id)}">删除</button>
            </div>
          </div>
          ${tagsHtml}
        </div>`;
      }).join('')}</div>` : '';

      // V1.0.1 Req 4: 大分类右侧「编辑」按钮改为「切换」按钮，点击展开所有大分类可直接选择切换
      return `<div class="ts-major-group ${mExp ? 'open' : ''} ${mChecked ? 'selected st-selected' : ''}" data-st-major="${esc(m.id)}">
        <div class="ts-major-head" data-st-major-toggle="${esc(m.id)}" title="点击展开/收起大分类 · 右侧「切换」可更改所属大分类">
          ${hasSel ? `<input type="checkbox" class="st-chk" data-st-chk-major="${esc(m.id)}" ${mChecked ? 'checked' : ''}>` : ''}
          <span class="ts-caret">${mExp ? '▾' : '▸'}</span>
          <span class="ts-major-title">${esc(m.icon)} ${esc(m.name)}</span>
          <span class="ts-cnt">${m.subs.length} 个小分类 · 共 ${mTotal} 条</span>
          <div class="ts-inline-acts" style="margin-left:auto;display:inline-flex;gap:6px">
            <button type="button" class="mini primary" data-st-act="import-major" data-mid="${esc(m.id)}">导入整大类</button>
            <button type="button" class="mini" data-st-act="switch-major" data-mid="${esc(m.id)}" title="点击切换该组所属的一级大分类">⇄ 切换</button>
            <button type="button" class="mini danger" data-st-act="del-major" data-mid="${esc(m.id)}">删除</button>
          </div>
        </div>
        ${subsHtml}
      </div>`;
    }).join('');
  }

  function openStageItemContextMenu(x, y, type, id1, id2) {
    let html = '';
    const selCnt = countStageSelectedTags();
    const selExtra = selCnt > 0 ? `
      <div style="border-top:1px solid var(--line);margin:4px 0"></div>
      <button type="button" data-ctx-stage="import-selected">📥 导入已选 (${selCnt} 条)</button>
      <button type="button" class="danger" data-ctx-stage="del-selected">🗑 删除已选 (${selCnt} 条)</button>
    ` : '';
    if (type === 'major') {
      const m = getStageTreeByMajor().find(x => x.id === id1);
      if (!m) return;
      html = `
        <div class="ctx-head">📁 暂存大分类：${esc(m.name)}</div>
        <button type="button" data-ctx-stage="import-major" data-mid="${esc(m.id)}">📥 导入此大分类全部暂存</button>
        <button type="button" class="danger" data-ctx-stage="del-major" data-mid="${esc(m.id)}">🗑 删除此大分类暂存</button>
        ${selExtra}
      `;
    } else if (type === 'sub') {
      const g = (_impStage.groups || []).find(x => x.id === id1);
      if (!g) return;
      html = `
        <div class="ctx-head">🏷 暂存小分类：${esc(g.name)} (${(g.tags || []).length} 条)</div>
        <button type="button" data-ctx-stage="import-sub" data-sid="${esc(g.id)}">📥 导入此小分类</button>
        <button type="button" class="danger" data-ctx-stage="del-sub" data-sid="${esc(g.id)}">🗑 删除此小分类暂存</button>
        ${selExtra}
      `;
    } else if (type === 'tag') {
      const g = (_impStage.groups || []).find(x => x.id === id1);
      const ti = Number(id2);
      const t = g && g.tags && g.tags[ti];
      if (!t) return;
      html = `
        <div class="ctx-head">🏷 暂存标签：${esc(t.en)}</div>
        <button type="button" data-ctx-stage="import-tag" data-sid="${esc(id1)}" data-ti="${ti}">📥 导入此标签</button>
        <button type="button" data-ctx-stage="edit-tag" data-sid="${esc(id1)}" data-ti="${ti}">✎ 编辑此标签</button>
        <button type="button" class="danger" data-ctx-stage="del-tag" data-sid="${esc(id1)}" data-ti="${ti}">🗑 删除此标签暂存</button>
        ${selExtra}
      `;
    }
    if (html) placeContextMenu(x, y, html);
  }

  function removeTagFromOtherSubsInTree(en, targetSubId, touchedMap) {
    ensureCustomCategoriesStructure();
    const k = norm(cleanArtistEn(en));
    if (!k) return 0;
    let movedCount = 0;
    const fs = window.PG_TAG_FS;
    (fs.majors || []).forEach(m => {
      (m.children || []).forEach(s => {
        if (s.id === targetSubId) return;
        const before = (s.tags || []).length;
        if (!before) return;
        const nextTags = s.tags.filter(t => norm(cleanArtistEn(t.en)) !== k);
        if (nextTags.length !== before) {
          s.tags = nextTags;
          s.updatedAt = new Date().toISOString();
          movedCount += (before - nextTags.length);
          if (touchedMap) touchedMap.set(s.id, { major: m, sub: s });
        }
      });
    });
    (state.customTagCats || []).forEach(c => {
      if (c.id === targetSubId) return;
      const before = (c.tags || []).length;
      if (!before) return;
      const nextTags = c.tags.filter(t => norm(cleanArtistEn(t.en)) !== k);
      if (nextTags.length !== before) {
        c.tags = nextTags;
        movedCount += (before - nextTags.length);
      }
    });
    syncFlatCustomFromTagCats();
    return movedCount;
  }

  async function executeStageSubsetImport(filterFn, labelDesc) {
    ensureCustomCategoriesStructure();
    const globalMoveOther = !$('#impStageMoveOtherDup') || $('#impStageMoveOtherDup').checked;
    const groups = (_impStage.groups || []).filter(g => g && Array.isArray(g.tags) && g.tags.length);
    if (!groups.length) {
      toast('暂存库为空，请先解析并加入暂存库');
      return;
    }

    const toImportBySub = new Map();
    let matchTotal = 0;
    groups.forEach(g => {
      const matched = [];
      const remained = [];
      (g.tags || []).forEach((t, ti) => {
        if (!filterFn || filterFn(g, t, ti)) {
          matched.push(t);
          matchTotal++;
        } else {
          remained.push(t);
        }
      });
      if (matched.length) {
        toImportBySub.set(`${g.majorId || ''}::${g.id}`, { groupMeta: g, tags: matched });
      }
      g._remained = remained;
    });

    if (!matchTotal) {
      toast('没有可导入的暂存条目');
      return;
    }

    recordHistorySnapshot(`暂存库导入 (${labelDesc || (matchTotal + ' 条')})`, true);
    const touchedMap = new Map();
    let added = 0, updated = 0, moved = 0, skippedDup = 0;

    for (const [, bundle] of toImportBySub.entries()) {
      const gMeta = bundle.groupMeta;
      const subId = gMeta.id;
      const targetMajId = gMeta.majorId;

      // If targeting Custom major category (or a custom subcategory)
      let custSub = (state.customTagCats || []).find(c => c.id === subId || (targetMajId === 'custom' && c.name === gMeta.name));
      if (!custSub && targetMajId === 'custom') {
        custSub = {
          id: subId.startsWith('cust_') ? subId : ('cust_tag_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 100)),
          name: gMeta.name || subId,
          icon: gMeta.icon || '🏷',
          tags: []
        };
        state.customTagCats.push(custSub);
      }

      if (custSub) {
        custSub.tags = custSub.tags || [];
        bundle.tags.forEach(item => {
          const en = cleanArtistEn(String(item.en || '').trim());
          const zh = String(item.zh || '').trim();
          const desc = String(item.desc || '').trim();
          if (!en) return;
          const k = norm(en);
          const dup = checkTagDuplication(en, custSub.id);
          if (dup.otherSubs.length) {
            if (globalMoveOther || item.moveFromOther) {
              moved += removeTagFromOtherSubsInTree(en, custSub.id, touchedMap);
            } else {
              skippedDup++;
              return;
            }
          }
          const ex = custSub.tags.find(t => norm(cleanArtistEn(t.en)) === k);
          if (ex) {
            if (zh && ex.zh !== zh) { ex.zh = zh; updated++; }
            if (desc) ex.desc = desc;
            markTagObjectAsNew(ex, en);
          } else {
            const newTagObj = { en, zh, isNew: true };
            if (desc) newTagObj.desc = desc;
            markTagObjectAsNew(newTagObj, en);
            custSub.tags.push(newTagObj);
            added++;
          }
        });
        if (state.expandedSubs.indexOf(custSub.id) < 0) state.expandedSubs.push(custSub.id);
        continue;
      }

      // Resolve target Major in PG_TAG_FS.majors
      let targetMajor = targetMajId ? findTreeMajor(targetMajId) : null;
      let hit = findTreeSub(subId);

      if (hit && targetMajor && hit.major.id !== targetMajor.id) {
        // User switched the major category of this staged subcategory -> find or create under targetMajor
        let subInTarget = (targetMajor.children || []).find(s => s.id === subId || s.name === gMeta.name);
        if (!subInTarget) {
          const newSid = (findTreeSub(subId) ? `${targetMajor.id}_${subId}` : subId);
          subInTarget = {
            id: newSid,
            name: gMeta.name || subId,
            icon: gMeta.icon || '🏷',
            parentId: targetMajor.id,
            level: 2,
            order: (targetMajor.children || []).length + 1,
            file: `${targetMajor.id}/${targetMajor.id}_${newSid}.json`,
            updatedAt: new Date().toISOString(),
            children: [],
            tags: []
          };
          targetMajor.children = targetMajor.children || [];
          targetMajor.children.push(subInTarget);
        }
        hit = { major: targetMajor, sub: subInTarget };
      } else if (!hit) {
        if (!targetMajor) {
          if (targetMajId && gMeta.majorName) {
            // Create the new Major Category from the JSON file!
            targetMajor = {
              id: targetMajId,
              name: gMeta.majorName,
              icon: gMeta.majorIcon || '📁',
              level: 1,
              order: (window.PG_TAG_FS.majors || []).length + 1,
              file: `${targetMajId}/${targetMajId}.json`,
              subDir: targetMajId,
              children: []
            };
            window.PG_TAG_FS.majors.push(targetMajor);
          } else {
            targetMajor = (window.PG_TAG_FS.majors || [])[0];
          }
        }
        if (!targetMajor) continue;
        const newSub = {
          id: subId,
          name: gMeta.name || subId,
          icon: gMeta.icon || '🏷',
          parentId: targetMajor.id,
          level: 2,
          order: (targetMajor.children || []).length + 1,
          file: `${targetMajor.id}/${targetMajor.id}_${subId}.json`,
          updatedAt: new Date().toISOString(),
          children: [],
          tags: []
        };
        targetMajor.children = targetMajor.children || [];
        targetMajor.children.push(newSub);
        hit = { major: targetMajor, sub: newSub };
      }

      const isNsfwDest = isNsfwSubId(hit.sub.id) || hit.major.id === 'nsfw_group';
      hit.sub.tags = hit.sub.tags || [];

      bundle.tags.forEach(item => {
        const en = cleanArtistEn(String(item.en || '').trim());
        const zh = String(item.zh || '').trim();
        const desc = String(item.desc || '').trim();
        if (!en) return;
        const k = norm(en);
        const dup = checkTagDuplication(en, hit.sub.id);
        if (dup.otherSubs.length) {
          if (globalMoveOther || item.moveFromOther) {
            moved += removeTagFromOtherSubsInTree(en, hit.sub.id, touchedMap);
          } else {
            skippedDup++;
            return;
          }
        }

        const ex = hit.sub.tags.find(t => norm(cleanArtistEn(t.en)) === k);
        if (ex) {
          if (zh && ex.zh !== zh) { ex.zh = zh; updated++; }
          if (desc) ex.desc = desc;
          if (isNsfwDest && ex.nsfw !== false) ex.nsfw = true;
          markTagObjectAsNew(ex, en);
        } else {
          const newTagObj = { en, zh, isNew: true };
          if (desc) newTagObj.desc = desc;
          if (isNsfwDest) newTagObj.nsfw = true;
          markTagObjectAsNew(newTagObj, en);
          hit.sub.tags.push(newTagObj);
          added++;
        }
      });

      hit.sub.updatedAt = new Date().toISOString();
      touchedMap.set(hit.sub.id, { major: hit.major, sub: hit.sub });
      if (state.expandedSubs.indexOf(hit.sub.id) < 0) state.expandedSubs.push(hit.sub.id);
    }

    syncFlatCustomFromTagCats();

    _impStage.groups = (_impStage.groups || []).map(g => {
      if (Array.isArray(g._remained)) {
        g.tags = g._remained;
        delete g._remained;
      }
      return g;
    }).filter(g => g.tags && g.tags.length > 0);

    _stageSelectedTags.clear();
    _stageSelectedSubs.clear();
    _stageSelectedMajors.clear();
    if (!_impStage.groups.length) _stageSelectMode = false;
    saveImpStageToLocal();

    await window.PG_TAG_FS.persistOp({ action: 'sync_all', majors: window.PG_TAG_FS.majors });

    renderImpStash();
    refreshAllFromTree();
    save();
    toast(`✅ 导入完成：新增 ${added} 条` + (updated ? `，更新 ${updated} 条` : '') + (moved ? `，跨分类移入 ${moved} 条` : '') + (skippedDup ? `，跳过重复 ${skippedDup} 条` : ''));
  }

  function deleteStageSubset(filterFn, toastMsg) {
    let removed = 0;
    _impStage.groups = (_impStage.groups || []).map(g => {
      const kept = [];
      (g.tags || []).forEach((t, ti) => {
        if (filterFn(g, t, ti)) removed++;
        else kept.push(t);
      });
      g.tags = kept;
      return g;
    }).filter(g => g.tags && g.tags.length > 0);

    _stageSelectedTags.clear();
    _stageSelectedSubs.clear();
    _stageSelectedMajors.clear();
    if (!_impStage.groups.length) _stageSelectMode = false;
    saveImpStageToLocal();
    renderImpStash();
    if (toastMsg) toast(toastMsg);
    else toast(`🗑 已从暂存库删除 ${removed} 条标签`);
  }

  function openStageEditModal(mode, ref1, ref2) {
    $('#stageEditMode').value = mode;
    $('#stageEditRef').value = ref2 !== undefined ? `${ref1}::${ref2}` : String(ref1 || '');
    const enWrap = $('#stageEditEnWrap');
    const zhWrap = $('#stageEditZhWrap');
    const titleEl = $('#stageEditTitle');
    const majSel = $('#stageEditMajorSel');
    const subSel = $('#stageEditSubSel');

    let initSubId = (CATS[0] && CATS[0].id) || 'style';
    let initMajId = '';

    if (mode === 'tag') {
      const g = (_impStage.groups || []).find(x => x.id === ref1);
      const t = g && g.tags && g.tags[Number(ref2)];
      if (!t) return;
      if (titleEl) titleEl.textContent = `✎ 编辑暂存标签「${t.en}」`;
      if (enWrap) enWrap.hidden = false;
      if (zhWrap) zhWrap.hidden = false;
      if ($('#stageEditDescWrap')) $('#stageEditDescWrap').hidden = false;
      if ($('#stageEditEn')) $('#stageEditEn').value = t.en || '';
      if ($('#stageEditZh')) $('#stageEditZh').value = t.zh || '';
      if ($('#stageEditDesc')) $('#stageEditDesc').value = t.desc || '';
      initSubId = g.id;
      initMajId = g.majorId || '';
    }
    syncDualSelectPair(majSel, subSel, initSubId, true, initMajId);
    openModal('modalStageEdit', true);
  }

  function moveStagedTagsToSub(itemsToMove, targetSubId) {
    const info = getSubDisplayInfo(targetSubId);
    let targetGroup = (_impStage.groups || []).find(x => x.id === info.id);
    if (!targetGroup) {
      targetGroup = {
        id: info.id,
        name: info.name,
        majorId: info.majorId,
        majorName: info.majorName,
        majorIcon: info.majorIcon,
        icon: info.icon,
        tags: []
      };
      _impStage.groups.push(targetGroup);
    }
    itemsToMove.forEach(it => {
      const k = norm(it.en);
      if (!k) return;
      const ex = targetGroup.tags.find(x => norm(x.en) === k);
      if (ex) {
        if (it.zh) ex.zh = it.zh;
        if (it.moveFromOther) ex.moveFromOther = true;
      } else {
        targetGroup.tags.push({ en: it.en, zh: it.zh || '', moveFromOther: !!it.moveFromOther });
      }
    });
    _impExpandedMajors.add(info.majorId);
    _impExpandedGroups.add(info.id);
  }

  function saveStageEditModal() {
    const mode = $('#stageEditMode').value;
    const ref = $('#stageEditRef').value;
    const targetSubId = ($('#stageEditSubSel') && $('#stageEditSubSel').value) || 'style';

    if (mode === 'tag') {
      const [sid, tiStr] = ref.split('::');
      const ti = Number(tiStr);
      const g = (_impStage.groups || []).find(x => x.id === sid);
      const t = g && g.tags && g.tags[ti];
      if (!t) return;
      const newEn = cleanArtistEn(($('#stageEditEn') && $('#stageEditEn').value || '').trim());
      const newZh = ($('#stageEditZh') && $('#stageEditZh').value || '').trim();
      const newDesc = ($('#stageEditDesc') && $('#stageEditDesc').value || '').trim();
      if (!newEn) { toast('英文提示词不能为空'); return; }
      t.en = newEn;
      t.zh = newZh;
      if (newDesc) t.desc = newDesc;
      else delete t.desc;
      if (targetSubId !== sid) {
        const [removed] = g.tags.splice(ti, 1);
        moveStagedTagsToSub([removed], targetSubId);
      }
    }

    _impStage.groups = (_impStage.groups || []).filter(g => g.tags && g.tags.length > 0);
    saveImpStageToLocal();
    renderImpStash();
    closeModal('modalStageEdit');
    toast('✅ 已更新暂存标签');
  }

  /* (Req 9 & 2.5 Req 4) 二级分类末尾「＋新增」精简小窗（支持跨分类重复移动） */
  function openMiniAddTag(subId) {
    ensureCustomCategoriesStructure();
    const custSub = (state.customTagCats || []).find(c => c.id === subId);
    const hit = custSub ? null : (findTreeSub(subId) || (CATS[0] ? findTreeSub(CATS[0].id) : null));
    if (!custSub && !hit) { toast('未找到目标小分类'); return; }
    _miniSubId = custSub ? custSub.id : hit.sub.id;
    const title = $('#miniAddTitle');
    if (title) title.textContent = custSub ? `＋ 新增到「⭐ 自定义 › ${custSub.name}」` : `＋ 新增到「${hit.major.name} › ${hit.sub.name}」`;
    if ($('#miniEn')) $('#miniEn').value = '';
    if ($('#miniZh')) $('#miniZh').value = '';
    if ($('#miniDesc')) $('#miniDesc').value = '';
    if ($('#miniStat')) $('#miniStat').textContent = '';
    openModal('modalMiniAddTag');
    setTimeout(() => { if ($('#miniEn')) $('#miniEn').focus(); }, 20);
  }

  async function commitMiniAdd() {
    ensureCustomCategoriesStructure();
    const en = cleanArtistEn(($('#miniEn') && $('#miniEn').value || '').trim(), _miniSubId);
    const zh = ($('#miniZh') && $('#miniZh').value || '').trim();
    const desc = ($('#miniDesc') && $('#miniDesc').value || '').trim();
    const moveDup = !$('#miniMoveOtherDup') || $('#miniMoveOtherDup').checked;
    const stat = $('#miniStat');
    if (!en) { if (stat) stat.textContent = '请输入英文提示词'; return; }
    const dup = checkTagDuplication(en, _miniSubId);
    // V1.0 Req 5: 如果在其他分类重复，只能选择保留一个（若不勾选移至当前分类，则保留原分类并跳过本次新增）
    if (dup.otherSubs.length && !moveDup) {
      if (stat) stat.innerHTML = `<span style="color:#fbbf24">⚠ 「${esc(en)}」已在 ${esc(dup.otherSubs.join('、'))} 存在，已按要求仅保留原分类（跳过本次新增）</span>`;
      toast(`「${en}」已在其他分类存在，已保留原分类（仅保留一个）`);
      return;
    }
    recordHistorySnapshot(`新增提示词: ${en}`, true);
    const ok = await addTagToSubFile(_miniSubId, en, zh, true, desc);
    if (ok) {
      if (state.expandedSubs.indexOf(_miniSubId) < 0) state.expandedSubs.push(_miniSubId);
      renderGrid();
      if ($('#miniEn')) $('#miniEn').value = '';
      if ($('#miniZh')) $('#miniZh').value = '';
      if ($('#miniDesc')) $('#miniDesc').value = '';
      if (dup.otherSubs.length) {
        if (stat) stat.innerHTML = `<span style="color:var(--pos)">✅ 已将「${esc(en)}」从 ${esc(dup.otherSubs.join('、'))} 移动至当前分类（全库仅保留一个）</span>`;
        toast(`已将「${en}」从原分类移动至当前小分类（仅保留一个）`);
      } else {
        if (stat) stat.innerHTML = `<span style="color:var(--pos)">✅ 已添加「${esc(en)}」</span>`;
        toast(`已添加「${en}」到小分类（可按 Ctrl+Z 撤销）`);
      }
      if ($('#miniEn')) $('#miniEn').focus();
    }
  }

  function refreshAllFromTree() {
    rebuildCharsAndPresetsFromWindow();
    refreshGamesFromChars();
    rebuildCatsFromTree();
    rebuildRanks();
    _tagCat = null;
    INDEX.clear();
    REV.clear();
    DESC_MAP.clear();
  CATS.forEach(c => c.tags.forEach(t => idxAdd(t.en, t.zh, t.desc)));
    CHARS.forEach(c => {
      idxAdd(c.tag, c.charZh);
      c.auto.forEach(a => idxAdd(a.en, a.zh));
    });
    PRESETS.forEach(p => p.tags.forEach(t => idxAdd(t.en, t.zh)));
    ensureCustomCategoriesStructure();
    state.custom.forEach(t => idxAdd(t.en, t.zh, t.desc));
    CATS.forEach(c => c.tags.forEach(t => {
      if (!t.zh) return;
      dictAdd(t.zh, t.en);
      splitZh(t.zh).forEach(z => dictAdd(z, t.en));
    }));
    String(window.PG_EXTRA_ZH || '').split('\n').forEach(line => {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      const i = line.indexOf('|');
      if (i < 0) return;
      dictAdd(line.slice(0, i).trim(), line.slice(i + 1).trim());
    });
    rebuildDictKeys();
    if (window.PG_AI && typeof window.PG_AI.resetLibrary === 'function') {
      window.PG_AI.resetLibrary();
    }
    populateAddTargetSubSelect();
    renderRandSwitchBar();
    renderAll();
    syncRightSidebarUI();
    syncBatchSelectBarUI();
    updateFsBadge();
  }

  function updateFsBadge() {
    const fs = window.PG_TAG_FS;
    if (!fs) return;
    const dot = $('#fsDot');
    const txt = $('#fsText');
    if (dot) {
      dot.className = 'dot ' + (fs.mode === 'server-fs' ? 'ok' : (fs.mode === 'browser-fs' ? 'local' : ''));
    }
    const label = fs.mode === 'server-fs'
      ? `已连本地文件服务 (${fs.serverBase})`
      : (fs.mode === 'browser-fs'
        ? `已挂载目录 (${(fs.dirHandle && fs.dirHandle.name) || 'tags'})`
        : `外置词库联动 (${MAJORS.length}大类/${CATS.length}小类)`);
    if (txt) txt.textContent = label;
  }

  function populateAddTargetSubSelect() {
    const sel = $('#addTargetSub');
    if (!sel) return;
    const cur = sel.value || 'style';
    let html = '';
    MAJORS.forEach(m => {
      (m.children || []).forEach(s => {
        html += `<option value="${esc(s.id)}">写入文件：${esc(m.name)} › ${esc(s.name)} (tags/${esc(m.id)}/${esc(m.id)}_${esc(s.id)}.json)</option>`;
      });
    });
    sel.innerHTML = html;
    if (cur && Array.prototype.some.call(sel.options, o => o.value === cur)) sel.value = cur;
  }

  function findTreeMajor(mid) {
    const fs = window.PG_TAG_FS;
    return (fs.majors || []).find(m => m.id === mid) || null;
  }

  function findTreeSub(sid) {
    const fs = window.PG_TAG_FS;
    for (const m of (fs.majors || [])) {
      const sub = (m.children || []).find(s => s.id === sid);
      if (sub) return { major: m, sub };
    }
    return null;
  }

  function deleteMajorCategory(targetMid) {
    const fs = window.PG_TAG_FS;
    const mid = targetMid;
    const m = findTreeMajor(mid);
    if (!m) return;
    if (fs.majors.length <= 1) { toast('至少保留一个一级大分类'); return; }
    const totalTags = (m.children || []).reduce((acc, s) => acc + ((s.tags && s.tags.length) || 0), 0);
    const doDelete = async () => {
      recordHistorySnapshot(`删除大分类: ${m.name}`, true);
      fs.majors = fs.majors.filter(x => x.id !== mid);
      if (state.cat === 'major:' + mid || (m.children || []).some(s => s.id === state.cat)) {
        state.cat = 'all';
      }
      await fs.persistOp({ action: 'delete_major', majorId: mid });
      refreshAllFromTree();
      toast(`已删除大分类「${m.name}」及对应外部文件夹（可按 Ctrl+Z 撤销）`);
    };
    if (totalTags === 0) {
      doDelete();
    } else {
      askConfirmModal(`确定删除一级大分类「${m.name}」及其外部文件夹 tags/${m.id}/ 下属全部文件吗？（可按 Ctrl+Z 撤销）`, doDelete);
    }
  }

  function deleteSubCategory(targetSid) {
    const fs = window.PG_TAG_FS;
    const sid = targetSid;
    const hit = findTreeSub(sid);
    if (!hit) return;
    const tagCount = (hit.sub.tags && hit.sub.tags.length) || 0;
    const doDelete = async () => {
      recordHistorySnapshot(`删除小分类: ${hit.sub.name}`, true);
      hit.major.children = (hit.major.children || []).filter(s => s.id !== sid);
      if (state.cat === sid) state.cat = 'all';
      await fs.persistOp({ action: 'delete_sub', majorId: hit.major.id, subId: sid, major: hit.major });
      refreshAllFromTree();
      toast(`已删除小分类「${hit.sub.name}」（可按 Ctrl+Z 撤销）`);
    };
    if (tagCount === 0) {
      doDelete();
    } else {
      askConfirmModal(`确定删除小分类「${hit.sub.name}」及其数据文件 tags/${hit.major.id}/${hit.major.id}_${hit.sub.id}.json 吗？（可按 Ctrl+Z 撤销）`, doDelete);
    }
  }

  async function addTagToSubFile(subId, en, zh, moveFromOther = false, desc = '') {
    ensureCustomCategoriesStructure();
    const fs = window.PG_TAG_FS;
    en = cleanArtistEn(String(en || '').trim(), subId);
    zh = String(zh || '').trim();
    desc = String(desc || '').trim();
    if (!en) return false;
    const k = norm(en);

    // Check if target is a custom tag subcategory
    const custSub = (state.customTagCats || []).find(c => c.id === subId);
    if (custSub) {
      const touchedCustom = new Map();
      if (moveFromOther) {
        removeTagFromOtherSubsInTree(en, custSub.id, touchedCustom);
      }
      custSub.tags = custSub.tags || [];
      const ex = custSub.tags.find(t => norm(cleanArtistEn(t.en)) === k);
      if (ex) {
        if (zh) ex.zh = zh;
        if (desc) ex.desc = desc;
        markTagObjectAsNew(ex, en);
      } else {
        const newTag = { en, zh, isNew: true };
        if (desc) newTag.desc = desc;
        markTagObjectAsNew(newTag, en);
        custSub.tags.push(newTag);
      }
      for (const { major, sub } of touchedCustom.values()) {
        await fs.persistOp({ action: 'save_sub', majorId: major.id, sub, major });
      }
      syncFlatCustomFromTagCats();
      refreshAllFromTree();
      save();
      return true;
    }

    const hit = findTreeSub(subId);
    if (!hit) return false;
    const touchedMap = new Map();

    if (moveFromOther) {
      removeTagFromOtherSubsInTree(en, hit.sub.id, touchedMap);
    }

    const isNsfwContext = isNsfwSubId(hit.sub.id) || hit.major.id === 'nsfw_group' || state.cat === 'nsfw_all' || String(state.cat).indexOf('nsfw_major:') === 0 || String(state.cat).indexOf('nsfw_sub:') === 0;
    hit.sub.tags = hit.sub.tags || [];
    const ex = hit.sub.tags.find(t => norm(t.en) === k);
    if (ex) {
      if (zh) ex.zh = zh;
      if (desc) ex.desc = desc;
      if (isNsfwContext && (!ex.rating || ex.rating === 'g')) {
        ex.rating = 's';
        ex.nsfw = true;
      }
      markTagObjectAsNew(ex, en);
    } else {
      const newTag = { en, zh, rating: isNsfwContext ? 's' : 'g', nsfw: !!isNsfwContext, isNew: true };
      if (desc) newTag.desc = desc;
      markTagObjectAsNew(newTag, en);
      hit.sub.tags.push(newTag);
    }
    hit.sub.updatedAt = new Date().toISOString();
    touchedMap.set(hit.sub.id, { major: hit.major, sub: hit.sub });

    for (const { major, sub } of touchedMap.values()) {
      await fs.persistOp({ action: 'save_sub', majorId: major.id, sub, major });
    }
    refreshAllFromTree();
    save();
    return true;
  }

  function deleteTagFromSub(subId, tagEn) {
    const fs = window.PG_TAG_FS;
    const clean = cleanArtistEn(tagEn);
    const sid = subId || tagCatOf(clean);
    const hit = findTreeSub(sid);
    if (!hit) return;
    const k = norm(clean);
    if (!k) return;
    const tagIdx = (hit.sub.tags || []).findIndex(t => norm(t.en) === k);
    if (tagIdx < 0) {
      toast('当前小分类中未找到该标签');
      return;
    }
    const targetTag = hit.sub.tags[tagIdx];
    askConfirmModal(`确定从小分类「${hit.sub.name}」中删除提示词「${targetTag.en}${targetTag.zh ? ' (' + targetTag.zh + ')' : ''}」吗？（可按 Ctrl+Z 撤销）`, async () => {
      recordHistorySnapshot(`删除提示词: ${targetTag.en} (${hit.sub.name})`, true);
      hit.sub.tags.splice(tagIdx, 1);
      state.sel = state.sel.filter(t => t.key !== k && norm(cleanArtistEn(t.en)) !== k);
      state.neg = state.neg.filter(t => t.key !== k && norm(cleanArtistEn(t.en)) !== k);
      hit.sub.updatedAt = new Date().toISOString();
      await fs.persistOp({ action: 'save_sub', majorId: hit.major.id, sub: hit.sub, major: hit.major });
      refreshAllFromTree();
      toast(`已删除「${targetTag.en}」（可按 Ctrl+Z 撤销）`);
    });
  }

  /* (2.5 Req 3) 右键小分类分类到左侧成为大分类 & 右键大分类移动到其他大分类成为小分类（同步创建/删除外部文件夹与 JSON） */
  async function promoteSubToMajor(subId) {
    const fs = window.PG_TAG_FS;
    const hit = findTreeSub(subId);
    if (!hit) { toast('未找到该小分类'); return; }
    const oldMajor = hit.major;
    const sub = hit.sub;

    let newMid = sub.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (findTreeMajor(newMid)) {
      newMid = newMid + '_major';
      let seq = 2;
      while (findTreeMajor(newMid)) { newMid = `${sub.id}_major_${seq++}`; }
    }
    let childSid = sub.id;
    if (childSid === newMid) childSid = 'base';

    recordHistorySnapshot(`小分类升格为大分类: ${sub.name}`, true);

    oldMajor.children = (oldMajor.children || []).filter(s => s.id !== sub.id);
    oldMajor.updatedAt = new Date().toISOString();

    const now = new Date().toISOString();
    const newChildSub = {
      id: sub.id,
      name: sub.name,
      icon: sub.icon || '🏷',
      parentId: newMid,
      level: 2,
      order: 1,
      file: `${newMid}/${newMid}_${childSid}.json`,
      updatedAt: now,
      children: [],
      tags: Array.isArray(sub.tags) ? sub.tags.slice() : []
    };
    const newMajor = {
      id: newMid,
      name: sub.name,
      icon: sub.icon && sub.icon !== '•' ? sub.icon : '📁',
      level: 1,
      order: (fs.majors || []).length + 1,
      file: `${newMid}/${newMid}.json`,
      subDir: newMid,
      updatedAt: now,
      children: [newChildSub]
    };
    fs.majors.push(newMajor);

    if (fs.layoutOrder) {
      fs.layoutOrder.majorOrder = fs.layoutOrder.majorOrder || [];
      if (fs.layoutOrder.majorOrder.indexOf(newMid) < 0) fs.layoutOrder.majorOrder.push(newMid);
      fs.layoutOrder.subOrderByMajor = fs.layoutOrder.subOrderByMajor || {};
      if (Array.isArray(fs.layoutOrder.subOrderByMajor[oldMajor.id])) {
        fs.layoutOrder.subOrderByMajor[oldMajor.id] = fs.layoutOrder.subOrderByMajor[oldMajor.id].filter(id => id !== sub.id);
      }
      fs.layoutOrder.subOrderByMajor[newMid] = [newChildSub.id];
      fs.saveLayoutLocalMirror(fs.layoutOrder);
    }

    await fs.persistOp({
      action: 'promote_sub_to_major',
      oldMajorId: oldMajor.id,
      subId: sub.id,
      updatedOldMajor: oldMajor,
      newMajor
    });
    await fs.persistOp({ action: 'sync_all', majors: fs.majors });

    state.cat = 'major:' + newMid;
    if (state.expandedSubs.indexOf(newChildSub.id) < 0) state.expandedSubs.push(newChildSub.id);
    refreshAllFromTree();
    save();
    toast(`⬆️ 已将小分类「${sub.name}」分类到左侧成为一级大分类（已同步创建外部文件夹 tags/${newMid}/）`);
  }

  function openDemoteMajorModal(majorId) {
    const fs = window.PG_TAG_FS;
    const m = findTreeMajor(majorId);
    if (!m) return;
    const others = (fs.majors || []).filter(x => x.id !== majorId);
    if (!others.length) {
      toast('至少需要保留一个目标一级大分类');
      return;
    }
    if ($('#demoteSourceMajorId')) $('#demoteSourceMajorId').value = majorId;
    const tagCount = (m.children || []).reduce((a, s) => a + (s.tags ? s.tags.length : 0), 0);
    if ($('#demoteMajorInfo')) {
      $('#demoteMajorInfo').textContent = `当前大分类「${m.icon || '📁'} ${m.name}」包含 ${(m.children || []).length} 个小分类、共 ${tagCount} 个标签。`;
    }
    const sel = $('#demoteTargetMajorSel');
    if (sel) {
      sel.innerHTML = others.map(o => `<option value="${esc(o.id)}">${esc(o.icon || '📁')} ${esc(o.name)} (tags/${esc(o.id)}/)</option>`).join('');
      sel.value = others[0].id;
    }
    openModal('modalDemoteMajor');
  }

  async function confirmDemoteMajor() {
    const fs = window.PG_TAG_FS;
    const sourceMid = ($('#demoteSourceMajorId') && $('#demoteSourceMajorId').value) || '';
    const targetMid = ($('#demoteTargetMajorSel') && $('#demoteTargetMajorSel').value) || '';
    const mode = ($('#demoteModeSel') && $('#demoteModeSel').value) || 'single';
    const sourceMajor = findTreeMajor(sourceMid);
    const targetMajor = findTreeMajor(targetMid);
    if (!sourceMajor || !targetMajor || sourceMid === targetMid) {
      toast('请选择有效的目标大分类');
      return;
    }

    recordHistorySnapshot(`大分类转为小分类: ${sourceMajor.name} → ${targetMajor.name}`, true);
    const now = new Date().toISOString();
    targetMajor.children = targetMajor.children || [];
    const isNsfwDest = (targetMajor.id === 'nsfw_group');

    if (mode === 'keep_children' && (sourceMajor.children || []).length > 0) {
      sourceMajor.children.forEach(s => {
        let newSid = s.id;
        if (findTreeSub(newSid) && findTreeSub(newSid).major.id !== sourceMid) {
          newSid = `${sourceMid}_${s.id}`;
        }
        const tags = (s.tags || []).map(t => {
          const item = { en: t.en, zh: t.zh || '' };
          if (isNsfwDest || t.nsfw === true) item.nsfw = true;
          else if (t.nsfw === false) item.nsfw = false;
          return item;
        });
        const movedSub = {
          id: newSid,
          name: s.name || newSid,
          icon: s.icon || sourceMajor.icon || '🏷',
          parentId: targetMajor.id,
          level: 2,
          order: targetMajor.children.length + 1,
          file: `${targetMajor.id}/${targetMajor.id}_${newSid}.json`,
          updatedAt: now,
          children: [],
          tags
        };
        targetMajor.children.push(movedSub);
        if (state.expandedSubs.indexOf(movedSub.id) < 0) state.expandedSubs.push(movedSub.id);
      });
    } else {
      const mergedTags = [];
      const seen = new Set();
      (sourceMajor.children || []).forEach(s => {
        (s.tags || []).forEach(t => {
          const k = norm(t.en);
          if (!k || seen.has(k)) return;
          seen.add(k);
          const item = { en: t.en, zh: t.zh || '' };
          if (isNsfwDest || t.nsfw === true) item.nsfw = true;
          else if (t.nsfw === false) item.nsfw = false;
          mergedTags.push(item);
        });
      });
      let newSid = sourceMajor.id;
      const exHit = findTreeSub(newSid);
      if (exHit && exHit.major.id !== sourceMid) {
        newSid = `${sourceMajor.id}_sub`;
      }
      const newSub = {
        id: newSid,
        name: sourceMajor.name,
        icon: sourceMajor.icon || '🏷',
        parentId: targetMajor.id,
        level: 2,
        order: targetMajor.children.length + 1,
        file: `${targetMajor.id}/${targetMajor.id}_${newSid}.json`,
        updatedAt: now,
        children: [],
        tags: mergedTags
      };
      targetMajor.children.push(newSub);
      if (state.expandedSubs.indexOf(newSub.id) < 0) state.expandedSubs.push(newSub.id);
    }

    targetMajor.updatedAt = now;
    fs.majors = (fs.majors || []).filter(m => m.id !== sourceMid);

    if (fs.layoutOrder) {
      if (Array.isArray(fs.layoutOrder.majorOrder)) {
        fs.layoutOrder.majorOrder = fs.layoutOrder.majorOrder.filter(id => id !== sourceMid);
      }
      if (fs.layoutOrder.subOrderByMajor) {
        delete fs.layoutOrder.subOrderByMajor[sourceMid];
        fs.layoutOrder.subOrderByMajor[targetMajor.id] = targetMajor.children.map(s => s.id);
      }
      fs.saveLayoutLocalMirror(fs.layoutOrder);
    }

    await fs.persistOp({
      action: 'demote_major_to_sub',
      oldMajorId: sourceMid,
      targetMajor
    });
    await fs.persistOp({ action: 'sync_all', majors: fs.majors });

    state.cat = 'major:' + targetMajor.id;
    closeModal('modalDemoteMajor');
    refreshAllFromTree();
    save();
    toast(`⬇️ 已将大分类「${sourceMajor.name}」移入「${targetMajor.name}」成为小分类（已同步清理外部文件夹 tags/${sourceMid}/）`);
  }

  function handleMajorQuickAct(act, mid) {
    if (act === 'add-sub') {
      state.cat = 'major:' + mid;
      quickCreateSubInline(mid);
      return;
    }
    if (act === 'demote-to-sub') {
      openDemoteMajorModal(mid);
      return;
    }
    if (act === 'rename') {
      state.editingMajorId = mid;
      renderNav();
      return;
    }
    if (act === 'export') {
      openTagPkgModal('major', mid);
      return;
    }
    if (act === 'del') {
      deleteMajorCategory(mid);
      return;
    }
  }

  function handleSubQuickAct(act, sid) {
    if (act === 'promote-to-major') {
      promoteSubToMajor(sid);
      return;
    }
    if (act === 'add-tag') {
      openSubAddTagModal(sid);
      return;
    }
    if (act === 'move') {
      openMoveSubModal(sid);
      return;
    }
    if (act === 'rename') {
      state.editingSubId = sid;
      renderGrid();
      return;
    }
    if (act === 'export') {
      openTagPkgModal('sub', sid);
      return;
    }
    if (act === 'del') {
      deleteSubCategory(sid);
      return;
    }
  }

  /* =====================================================================
     (2.5 Req 1) 主界面批量选择、Shift 区间连选、鼠标拖拽矩形框选、批量移动与批量删除
     ===================================================================== */
  function toggleBatchSelectMode(forceVal) {
    ensureBatchState();
    state.batchSelectMode = typeof forceVal === 'boolean' ? forceVal : !state.batchSelectMode;
    if (!state.batchSelectMode) {
      state.batchSelectedMap.clear();
      state.batchLastClickedKey = '';
    }
    syncBatchSelectBarUI();
    renderGrid();
  }

  function handleBatchChipClick(chipEl, isShift, isCtrl) {
    ensureBatchState();
    const en = cleanArtistEn(chipEl.dataset.en || '');
    const subId = chipEl.dataset.sub || tagCatOf(en) || '';
    const k = norm(en);
    if (!k) return;

    const allChips = Array.from(el.grid.querySelectorAll('.chip[data-en]'));
    const anchorKey = state.batchAnchorKey || state.batchLastClickedKey;

    // 电脑文件夹式 Shift 区间连选：选中锚点 tag 与当前点击 tag 之间的所有可见 tag（保持初始锚点不变；配合 Ctrl+Shift 则叠加区间）
    if (isShift && allChips.length > 0) {
      let i1 = anchorKey ? allChips.findIndex(c => norm(cleanArtistEn(c.dataset.en)) === anchorKey) : 0;
      if (i1 < 0) i1 = 0;
      const i2 = allChips.indexOf(chipEl);
      if (i2 >= 0) {
        const start = Math.min(i1, i2);
        const end = Math.max(i1, i2);
        if (!isCtrl) {
          state.batchSelectedMap.clear();
          allChips.forEach(c => c.classList.remove('batch-sel'));
        }
        for (let i = start; i <= end; i++) {
          const c = allChips[i];
          const cEn = cleanArtistEn(c.dataset.en || '');
          const cKey = norm(cEn);
          if (cKey) {
            state.batchSelectedMap.set(cKey, { en: cEn, subId: c.dataset.sub || tagCatOf(cEn) || '' });
            c.classList.add('batch-sel');
          }
        }
        if (!state.batchAnchorKey && allChips[i1]) {
          state.batchAnchorKey = norm(cleanArtistEn(allChips[i1].dataset.en || ''));
        }
        state.batchLastClickedKey = k;
        syncBatchSelectBarUI();
        return;
      }
    }

    // Ctrl+点击 或 批量选择模式下的单击：切换当前项选中状态，并更新锚点
    if (state.batchSelectedMap.has(k)) {
      state.batchSelectedMap.delete(k);
      chipEl.classList.remove('batch-sel');
    } else {
      state.batchSelectedMap.set(k, { en, subId });
      chipEl.classList.add('batch-sel');
    }
    state.batchAnchorKey = k;
    state.batchLastClickedKey = k;
    syncBatchSelectBarUI();
  }

  function selectAllVisibleTagsInGrid() {
    ensureBatchState();
    // (V1.1.3 Req 2) Ctrl+A 不是选择进右侧侧边栏，而是仅在中间页面选择当前所有已展开小分类内的 tag（不自动展开未展开的小分类）
    const expandedSubSecs = Array.from(el.grid.querySelectorAll('.sub-section.expanded'));
    let allChips = [];
    if (expandedSubSecs.length > 0) {
      expandedSubSecs.forEach(sec => {
        sec.querySelectorAll('.chip[data-en]').forEach(c => allChips.push(c));
      });
    } else if (!el.grid.querySelector('.sub-section')) {
      allChips = Array.from(el.grid.querySelectorAll('.chip[data-en]'));
    }
    if (!allChips.length) {
      toast('请先在中间页面展开小分类，再按 Ctrl+A 全选已展开小分类内的标签');
      return;
    }
    state.batchSelectMode = true;
    state.batchSelectedMap.clear();
    el.grid.querySelectorAll('.chip.batch-sel').forEach(c => c.classList.remove('batch-sel'));
    allChips.forEach(c => {
      const cEn = cleanArtistEn(c.dataset.en || '');
      const cKey = norm(cEn);
      if (cKey) {
        state.batchSelectedMap.set(cKey, { en: cEn, subId: c.dataset.sub || tagCatOf(cEn) || '' });
        c.classList.add('batch-sel');
      }
    });
    const firstEn = cleanArtistEn(allChips[0].dataset.en || '');
    const lastEn = cleanArtistEn(allChips[allChips.length - 1].dataset.en || '');
    state.batchAnchorKey = norm(firstEn);
    state.batchLastClickedKey = norm(lastEn);
    syncBatchSelectBarUI();
    toast(`☑ 已全选中间页面已展开小分类内的 ${state.batchSelectedMap.size} 个标签`);
  }

  function invertVisibleTagsInGrid() {
    ensureBatchState();
    const allChips = Array.from(el.grid.querySelectorAll('.chip[data-en]'));
    if (!allChips.length) {
      toast('请先展开小分类再执行反选');
      return;
    }
    state.batchSelectMode = true;
    allChips.forEach(c => {
      const cEn = cleanArtistEn(c.dataset.en || '');
      const cKey = norm(cEn);
      if (!cKey) return;
      if (state.batchSelectedMap.has(cKey)) {
        state.batchSelectedMap.delete(cKey);
        c.classList.remove('batch-sel');
      } else {
        state.batchSelectedMap.set(cKey, { en: cEn, subId: c.dataset.sub || tagCatOf(cEn) || '' });
        c.classList.add('batch-sel');
      }
    });
    syncBatchSelectBarUI();
    toast(`🔄 已反选当前视图标签（当前选中 ${state.batchSelectedMap.size} 个）`);
  }

  function clearBatchSelectionOnly() {
    ensureBatchState();
    state.batchSelectedMap.clear();
    el.grid.querySelectorAll('.chip.batch-sel').forEach(c => c.classList.remove('batch-sel'));
    syncBatchSelectBarUI();
  }

  function batchAddSelectedToPrompt() {
    ensureBatchState();
    const items = Array.from(state.batchSelectedMap.values());
    if (!items.length) {
      toast('请先选择要加入右侧的标签');
      return;
    }
    const list = currentList();
    const existingSet = new Set(list.map(x => norm(cleanArtistEn(x.en))));
    const allAlreadyIn = items.every(it => existingSet.has(norm(cleanArtistEn(it.en))));
    if (allAlreadyIn) {
      recordHistorySnapshot(`批量从已选移除 ${items.length} 个标签`);
      const removeKeys = new Set(items.map(it => norm(cleanArtistEn(it.en))));
      if (state.mode === 'neg') {
        state.neg = state.neg.filter(x => !removeKeys.has(norm(cleanArtistEn(x.en))));
      } else {
        state.sel = state.sel.filter(x => !removeKeys.has(norm(cleanArtistEn(x.en))));
      }
      renderSelected();
      renderGrid();
      save();
      toast(`➖ 已将所选 ${items.length} 个标签从右侧列表移除`);
      return;
    }
    recordHistorySnapshot(`批量加入已选 (${items.length} 个标签)`);
    let added = 0;
    items.forEach(it => {
      if (addTag(it.en, zhLookup(cleanArtistEn(it.en)), 1, '', it.subId)) added++;
    });
    renderSelected();
    renderGrid();
    save();
    toast(`➕ 已将 ${added} 个标签加入右侧${state.mode === 'neg' ? '负面' : '正向'}列表`);
  }

  function copyBatchSelectedTags() {
    ensureBatchState();
    const items = Array.from(state.batchSelectedMap.values());
    if (!items.length) {
      toast('请先选择要复制的标签');
      return;
    }
    const text = items.map(it => it.en).join(', ');
    copyText(text);
    toast(`📋 已复制 ${items.length} 个选中标签`);
  }

  function navigateGridChipByKey(key, isShift, isCtrl) {
    ensureBatchState();
    const allChips = Array.from(el.grid.querySelectorAll('.chip[data-en]'));
    if (!allChips.length) return false;
    const curKey = state.batchLastClickedKey || state.batchAnchorKey;
    let curIdx = curKey ? allChips.findIndex(c => norm(cleanArtistEn(c.dataset.en || '')) === curKey) : -1;
    let nextIdx = 0;
    if (key === 'Home') {
      nextIdx = 0;
    } else if (key === 'End') {
      nextIdx = allChips.length - 1;
    } else if (curIdx < 0) {
      nextIdx = 0;
    } else if (key === 'ArrowRight') {
      nextIdx = Math.min(allChips.length - 1, curIdx + 1);
    } else if (key === 'ArrowLeft') {
      nextIdx = Math.max(0, curIdx - 1);
    } else if (key === 'ArrowDown' || key === 'ArrowUp') {
      const curRect = allChips[curIdx].getBoundingClientRect();
      const curCx = curRect.left + curRect.width / 2;
      const curCy = curRect.top + curRect.height / 2;
      let bestIdx = curIdx;
      let bestDist = Infinity;
      for (let i = 0; i < allChips.length; i++) {
        if (i === curIdx) continue;
        const r = allChips[i].getBoundingClientRect();
        const cy = r.top + r.height / 2;
        const cx = r.left + r.width / 2;
        if (key === 'ArrowDown' && cy <= curCy + 8) continue;
        if (key === 'ArrowUp' && cy >= curCy - 8) continue;
        const dy = Math.abs(cy - curCy);
        const dx = Math.abs(cx - curCx);
        const score = dy * 3.5 + dx;
        if (score < bestDist) {
          bestDist = score;
          bestIdx = i;
        }
      }
      nextIdx = bestIdx;
    }
    const targetChip = allChips[nextIdx];
    if (!targetChip) return false;
    state.batchSelectMode = true;
    const tEn = cleanArtistEn(targetChip.dataset.en || '');
    const tKey = norm(tEn);
    if (isShift) {
      if (!state.batchAnchorKey && curIdx >= 0) {
        state.batchAnchorKey = norm(cleanArtistEn(allChips[curIdx].dataset.en || ''));
      }
      handleBatchChipClick(targetChip, true, isCtrl);
    } else {
      if (!isCtrl) {
        state.batchSelectedMap.clear();
        allChips.forEach(c => c.classList.remove('batch-sel'));
      }
      state.batchSelectedMap.set(tKey, { en: tEn, subId: targetChip.dataset.sub || tagCatOf(tEn) || '' });
      targetChip.classList.add('batch-sel');
      state.batchAnchorKey = tKey;
      state.batchLastClickedKey = tKey;
      syncBatchSelectBarUI();
    }
    try { targetChip.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {}
    return true;
  }

  function boxSelectTagsInRect(x1, y1, x2, y2, append = false, keepBarHiddenDuringDrag = false, baseSelectedMap = null) {
    ensureBatchState();
    if (!state.batchSelectMode) {
      state.batchSelectMode = true;
    }
    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    const top = Math.min(y1, y2);
    const bottom = Math.max(y1, y2);
    state.batchSelectedMap.clear();
    if (append && baseSelectedMap instanceof Map) {
      baseSelectedMap.forEach((v, k) => state.batchSelectedMap.set(k, v));
    }

    const chips = Array.from(el.grid.querySelectorAll('.chip[data-en]'));
    let hitCount = 0;
    let lastHitKey = '';
    chips.forEach(c => {
      const r = c.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const intersects = !(r.right < left || r.left > right || r.bottom < top || r.top > bottom);
      const cEn = cleanArtistEn(c.dataset.en || '');
      const cKey = norm(cEn);
      if (intersects && cKey) {
        state.batchSelectedMap.set(cKey, { en: cEn, subId: c.dataset.sub || tagCatOf(cEn) || '' });
        c.classList.add('batch-sel');
        lastHitKey = cKey;
        hitCount++;
      } else if (cKey && state.batchSelectedMap.has(cKey)) {
        c.classList.add('batch-sel');
      } else {
        c.classList.remove('batch-sel');
      }
    });
    if (lastHitKey) {
      state.batchLastClickedKey = lastHitKey;
      if (!state.batchAnchorKey) state.batchAnchorKey = lastHitKey;
    }
    syncBatchSelectBarUI(keepBarHiddenDuringDrag);
    return hitCount;
  }
  window.boxSelectTagsInRect = boxSelectTagsInRect;

  function openBatchMoveModal() {
    ensureBatchState();
    const count = state.batchSelectedMap.size;
    if (!count) { toast('请先点击或拖拽框选要移动的标签'); return; }
    fillImpTargetSel();
    if ($('#batchMoveInfo')) $('#batchMoveInfo').textContent = `当前已选 ${count} 个提示词，请选择要移入的目标二级小分类：`;
    openModal('modalBatchMoveTags');
  }

  async function confirmBatchMoveTags() {
    ensureBatchState();
    const items = Array.from(state.batchSelectedMap.values());
    if (!items.length) { toast('未选择任何标签'); return; }
    const targetSubId = ($('#batchMoveTargetSubSel') && $('#batchMoveTargetSubSel').value) || '';
    const targetHit = findTreeSub(targetSubId);
    if (!targetHit) { toast('未找到目标小分类'); return; }

    recordHistorySnapshot(`批量移动 ${items.length} 个标签至 ${targetHit.sub.name}`, true);
    const touchedMap = new Map();
    const isNsfwDest = isNsfwSubId(targetHit.sub.id) || targetHit.major.id === 'nsfw_group';
    targetHit.sub.tags = targetHit.sub.tags || [];
    let moved = 0;

    items.forEach(it => {
      const clean = cleanArtistEn(it.en);
      const k = norm(clean);
      const zh = zhLookup(clean) || '';
      if (!k) return;
      removeTagFromOtherSubsInTree(clean, targetHit.sub.id, touchedMap);
      const ex = targetHit.sub.tags.find(t => norm(t.en) === k);
      if (!ex) {
        const newTag = { en: clean, zh, isNew: true };
        if (isNsfwDest) newTag.nsfw = true;
        targetHit.sub.tags.push(newTag);
        markTagAsNew(clean, newTag);
        moved++;
      } else {
        ex.isNew = true;
        if (isNsfwDest && ex.nsfw !== false) ex.nsfw = true;
        markTagAsNew(clean, ex);
      }
    });

    targetHit.sub.updatedAt = new Date().toISOString();
    touchedMap.set(targetHit.sub.id, { major: targetHit.major, sub: targetHit.sub });

    for (const { major, sub } of touchedMap.values()) {
      await window.PG_TAG_FS.persistOp({ action: 'save_sub', majorId: major.id, sub, major });
    }

    state.batchSelectedMap.clear();
    closeModal('modalBatchMoveTags');
    refreshAllFromTree();
    toast(`✅ 已将 ${items.length} 个标签移动至「${targetHit.major.name} › ${targetHit.sub.name}」`);
  }

  function confirmBatchDeleteTags() {
    ensureBatchState();
    const items = Array.from(state.batchSelectedMap.values());
    if (!items.length) { toast('请先点击或拖拽框选要删除的标签'); return; }
    askConfirmModal(`确定批量删除已选的 ${items.length} 个提示词吗？（可按 Ctrl+Z 撤销）`, async () => {
      recordHistorySnapshot(`批量删除 ${items.length} 个提示词`, true);
      const touchedMap = new Map();
      const delKeys = new Set(items.map(it => norm(cleanArtistEn(it.en))));
      const fs = window.PG_TAG_FS;
      (fs.majors || []).forEach(m => {
        (m.children || []).forEach(s => {
          const before = (s.tags || []).length;
          if (!before) return;
          const next = s.tags.filter(t => !delKeys.has(norm(t.en)));
          if (next.length !== before) {
            s.tags = next;
            s.updatedAt = new Date().toISOString();
            touchedMap.set(s.id, { major: m, sub: s });
          }
        });
      });
      state.custom = (state.custom || []).filter(t => !delKeys.has(norm(t.en)));
      state.sel = (state.sel || []).filter(t => !delKeys.has(t.key) && !delKeys.has(norm(cleanArtistEn(t.en))));
      state.neg = (state.neg || []).filter(t => !delKeys.has(t.key) && !delKeys.has(norm(cleanArtistEn(t.en))));

      for (const { major, sub } of touchedMap.values()) {
        await fs.persistOp({ action: 'save_sub', majorId: major.id, sub, major });
      }
      state.batchSelectedMap.clear();
      refreshAllFromTree();
      save();
      toast(`🗑 已批量删除 ${items.length} 个提示词（可按 Ctrl+Z 撤销）`);
    });
  }

  /* =====================================================================
     8.9 带范围选择的标签库导出与导入
     ===================================================================== */

  function downloadJsonBlob(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function syncExpSubOptionsByMajor(majorId, preferSubId) {
    const expSubSel = $('#expSubSel');
    if (!expSubSel) return;
    const m = findTreeMajor(majorId) || (window.PG_TAG_FS.majors && window.PG_TAG_FS.majors[0]);
    const subs = (m && m.children) || [];
    expSubSel.innerHTML = subs.map(s => `<option value="${esc(s.id)}">${esc(s.icon || '•')} ${esc(s.name)}（${(s.tags || []).length} 个标签）</option>`).join('');
    if (preferSubId && subs.some(s => s.id === preferSubId)) {
      expSubSel.value = preferSubId;
    }
  }

  function openTagPkgModal(preferScope, targetId) {
    const fs = window.PG_TAG_FS;
    const majors = fs.majors || [];
    const expSubMajorSel = $('#expSubMajorSel');
    const expMajorSel = $('#expMajorSel');

    const majorOpts = majors.map(m => `<option value="${esc(m.id)}">${esc(m.icon || '📁')} ${esc(m.name)}（${(m.children || []).length} 个小分类）</option>`).join('');
    if (expSubMajorSel) expSubMajorSel.innerHTML = majorOpts;
    if (expMajorSel) expMajorSel.innerHTML = majorOpts;

    // V1.0.1 Req 5: 主界面中间右上角导出按钮点击自动将目标位置改为当前所选的大分类
    const curResolved = resolveCurrentActiveMajorAndSub(preferScope === 'sub' ? targetId : '');
    const defaultMajorId = (preferScope === 'major' && targetId)
      ? targetId
      : (findTreeMajor(curResolved.majorId) ? curResolved.majorId : ((majors[0] && majors[0].id) || 'visual'));

    if (expSubMajorSel) expSubMajorSel.value = defaultMajorId;
    if (expMajorSel) expMajorSel.value = defaultMajorId;

    if (preferScope === 'major') {
      const r = document.querySelector('input[name="expScope"][value="major"]');
      if (r) r.checked = true;
      syncExpSubOptionsByMajor(defaultMajorId);
    } else if (preferScope === 'sub') {
      const r = document.querySelector('input[name="expScope"][value="sub"]');
      if (r) r.checked = true;
      const hit = findTreeSub(targetId || curResolved.subId);
      if (hit && expSubMajorSel) {
        expSubMajorSel.value = hit.major.id;
        if (expMajorSel) expMajorSel.value = hit.major.id;
        syncExpSubOptionsByMajor(hit.major.id, hit.sub.id);
      } else {
        syncExpSubOptionsByMajor(defaultMajorId, targetId || curResolved.subId);
      }
    } else {
      syncExpSubOptionsByMajor(defaultMajorId, curResolved.subId);
    }
    syncExpScopeUI();
    openModal('modalTagPkg');
  }

  function syncExpScopeUI() {
    const r = document.querySelector('input[name="expScope"]:checked');
    const scope = r ? r.value : 'sub';
    if ($('#expSubWrap')) $('#expSubWrap').hidden = scope !== 'sub';
    if ($('#expMajorWrap')) $('#expMajorWrap').hidden = scope !== 'major';
    const hint = $('#expStatHint');
    if (!hint) return;
    if (scope === 'sub') {
      const sid = $('#expSubSel') && $('#expSubSel').value;
      const hit = findTreeSub(sid);
      hint.textContent = hit
        ? `当前选择：选项 A（单小分类）· 大分类「${hit.major.name}」 › 小分类「${hit.sub.name}」 · 共 ${(hit.sub.tags || []).length} 个标签`
        : '';
    } else {
      const mid = $('#expMajorSel') && $('#expMajorSel').value;
      const m = findTreeMajor(mid);
      const total = m ? (m.children || []).reduce((n, s) => n + (s.tags || []).length, 0) : 0;
      hint.textContent = m
        ? `当前选择：选项 B（整大分类）· 包含主文件 tags/${m.id}.json 及下属 ${(m.children || []).length} 个小分类文件 · 共 ${total} 个标签`
        : '';
    }
  }

  function exportScopedTagPackage() {
    const r = document.querySelector('input[name="expScope"]:checked');
    const scope = r ? r.value : 'sub';
    const now = new Date().toISOString();

    if (scope === 'sub') {
      const sid = $('#expSubSel') && $('#expSubSel').value;
      const hit = findTreeSub(sid);
      if (!hit) { toast('请选择要导出的小分类'); return; }
      const pkg = {
        app: 'Danbooru Prompt',
        packageType: 'DanbooruPromptTagPackage',
        version: 2,
        scope: 'sub',
        exportedAt: now,
        parentMajor: { id: hit.major.id, name: hit.major.name, icon: hit.major.icon || '📁' },
        subcategory: {
          id: hit.sub.id,
          name: hit.sub.name,
          icon: hit.sub.icon || '•',
          parentId: hit.major.id,
          level: 2,
          file: hit.sub.file || `${hit.major.id}/${hit.sub.id}.json`,
          tags: (hit.sub.tags || []).map(t => ({ en: t.en, zh: t.zh || '' }))
        }
      };
      downloadJsonBlob(pkg, `tagpkg-sub-${hit.sub.id}.json`);
      toast(`已导出单小分类数据包：${hit.sub.name}（${pkg.subcategory.tags.length} 个标签）`);
    } else {
      const mid = $('#expMajorSel') && $('#expMajorSel').value;
      const m = findTreeMajor(mid);
      if (!m) { toast('请选择要导出的大分类'); return; }
      const pkg = {
        app: 'Danbooru Prompt',
        packageType: 'DanbooruPromptTagPackage',
        version: 2,
        scope: 'major',
        exportedAt: now,
        major: {
          id: m.id,
          name: m.name,
          icon: m.icon || '📁',
          level: 1,
          file: `${m.id}/${m.id}.json`,
          subDir: m.id,
          children: (m.children || []).map((s, idx) => ({
            id: s.id,
            name: s.name,
            icon: s.icon || '•',
            parentId: m.id,
            level: 2,
            order: idx + 1,
            file: `${m.id}/${m.id}_${s.id}.json`,
            tags: (s.tags || []).map(t => ({ en: t.en, zh: t.zh || '' }))
          }))
        }
      };
      const total = pkg.major.children.reduce((n, s) => n + s.tags.length, 0);
      downloadJsonBlob(pkg, `tagpkg-major-${m.id}.json`);
      toast(`已导出完整大分类数据包：${m.name}（${pkg.major.children.length} 个小分类 / ${total} 个标签）`);
    }
  }

  function extractTagsFromUnknownContent(rawText) {
    const out = [];
    const seen = new Set();
    const pushPair = (en, zh) => {
      const cEn = cleanArtistEn(String(en || '').trim());
      if (!cEn || cEn.length > 120) return;
      const k = norm(cEn);
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push({ en: cEn, zh: String(zh || zhLookup(cEn) || '').trim() });
    };

    const walkObj = node => {
      if (!node) return;
      if (typeof node === 'string') {
        node.split(/\r?\n/).forEach(line => {
          const p = parsePair(line.trim());
          if (p.en) pushPair(p.en, p.zh);
        });
        return;
      }
      if (Array.isArray(node)) {
        node.forEach(item => {
          if (typeof item === 'string') {
            const p = parsePair(item);
            if (p.en) pushPair(p.en, p.zh);
          } else if (item && typeof item === 'object') {
            if (item.en || item.tag || item.name || item.prompt) {
              pushPair(item.en || item.tag || item.name || item.prompt, item.zh || item.cn || item.translation || item.meaning || '');
            } else {
              walkObj(item);
            }
          }
        });
        return;
      }
      if (typeof node === 'object') {
        Object.keys(node).forEach(k => {
          const v = node[k];
          if (typeof v === 'string' && !/^(id|name|icon|scope|version|app|packageType|exportedAt|updatedAt|file|subDir|parentId)$/i.test(k)) {
            if (/[a-zA-Z]/.test(k)) pushPair(k, v);
            else if (/[a-zA-Z]/.test(v)) pushPair(v, k);
          } else if (Array.isArray(v) || (v && typeof v === 'object')) {
            walkObj(v);
          }
        });
      }
    };

    try {
      const parsed = JSON.parse(String(rawText || '').trim());
      walkObj(parsed);
    } catch (e) {
      const rows = parseExcelOrTextLines(rawText, '');
      rows.forEach(r => pushPair(r.en, r.zh));
    }
    return out;
  }

  function validateTagPackage(rawText) {
    const trimmed = String(rawText || '').trim();
    if (!trimmed) return { ok: false, error: '导入内容为空' };

    const forceScope = ($('#impScopeSel') && $('#impScopeSel').value) || 'auto';
    if (forceScope === 'custom') {
      const tags = extractTagsFromUnknownContent(trimmed);
      if (!tags.length) return { ok: false, error: '未能从文件中提取到有效提示词' };
      return {
        ok: true,
        scope: 'unknown_custom',
        tags,
        summary: `已提取 ${tags.length} 个提示词，将默认存放至「自定义」`
      };
    }

    let data = null;
    try {
      data = JSON.parse(trimmed);
    } catch (e) {
      const tags = extractTagsFromUnknownContent(trimmed);
      if (tags.length) {
        return {
          ok: true,
          scope: 'unknown_custom',
          tags,
          summary: `识别为外部文本/未知格式文件（共 ${tags.length} 个标签），将默认存放至「自定义」`
        };
      }
      return { ok: false, error: '文件解析失败：未识别到有效 JSON 或提示词内容' };
    }

    const cleanTags = arr => {
      if (!Array.isArray(arr)) return null;
      const out = [];
      for (const item of arr) {
        if (typeof item === 'string') {
          const p = parsePair(item);
          if (p.en) out.push(p);
        } else if (item && typeof item === 'object' && item.en) {
          out.push({ en: String(item.en).trim(), zh: String(item.zh || '').trim() });
        }
      }
      return out;
    };

    if (data && typeof data === 'object' && !Array.isArray(data)) {
      if (data.scope === 'sub' || data.subcategory || (data.level === 2 && Array.isArray(data.tags)) || (!data.children && Array.isArray(data.tags) && data.id && data.name)) {
        const subRaw = data.subcategory || data;
        const tags = cleanTags(subRaw.tags);
        if (subRaw.id && subRaw.name && tags) {
          return {
            ok: true,
            scope: 'sub',
            parentMajor: data.parentMajor || (subRaw.parentId ? { id: subRaw.parentId } : null),
            sub: {
              id: String(subRaw.id).trim().replace(/[^a-zA-Z0-9_-]/g, '_'),
              name: String(subRaw.name).trim(),
              icon: String(subRaw.icon || '•').trim(),
              parentId: subRaw.parentId || '',
              tags
            },
            summary: `校验通过：单小分类数据包「${subRaw.name} (${subRaw.id})」，包含 ${tags.length} 个有效标签`
          };
        }
      }

      if (data.scope === 'major' || data.major || (data.level === 1 && Array.isArray(data.children) && data.id && data.name)) {
        const mRaw = data.major || data;
        if (mRaw.id && mRaw.name && Array.isArray(mRaw.children)) {
          const subs = [];
          let totalTags = 0;
          for (const c of mRaw.children) {
            if (!c || !c.id || !c.name) continue;
            const tags = cleanTags(c.tags || []) || [];
            totalTags += tags.length;
            subs.push({
              id: String(c.id).trim().replace(/[^a-zA-Z0-9_-]/g, '_'),
              name: String(c.name).trim(),
              icon: String(c.icon || '•').trim(),
              tags
            });
          }
          if (subs.length) {
            return {
              ok: true,
              scope: 'major',
              major: {
                id: String(mRaw.id).trim().replace(/[^a-zA-Z0-9_-]/g, '_'),
                name: String(mRaw.name).trim(),
                icon: String(mRaw.icon || '📁').trim(),
                children: subs
              },
              summary: `校验通过：完整大分类数据包「${mRaw.name} (${mRaw.id})」，含 ${subs.length} 个小分类、共 ${totalTags} 个标签`
            };
          }
        }
      }

      if (data.scope === 'tree' || Array.isArray(data.majors)) {
        const list = data.majors;
        if (Array.isArray(list) && list.length) {
          return {
            ok: true,
            scope: 'tree',
            majors: list,
            summary: `校验通过：二级标签树数据包，含 ${list.length} 个大分类`
          };
        }
      }
    }

    const fallbackTags = extractTagsFromUnknownContent(trimmed);
    if (fallbackTags.length) {
      return {
        ok: true,
        scope: 'unknown_custom',
        tags: fallbackTags,
        summary: `识别为未知格式文件（提取到 ${fallbackTags.length} 个提示词），将默认存放至「自定义」`
      };
    }

    return { ok: false, error: '无法从该文件中提取到任何有效提示词' };
  }

  function mergeSubTags(existingTags, incomingTags, strategy) {
    if (strategy === 'overwrite') {
      return incomingTags.slice();
    }
    const out = (existingTags || []).map(t => ({ en: t.en, zh: t.zh || '' }));
    const map = new Map();
    out.forEach((t, idx) => map.set(norm(t.en), idx));
    incomingTags.forEach(inc => {
      const k = norm(inc.en);
      if (!k) return;
      if (map.has(k)) {
        if (strategy === 'merge' && inc.zh) {
          out[map.get(k)].zh = inc.zh;
        }
      } else {
        map.set(k, out.length);
        out.push({ en: inc.en, zh: inc.zh || '' });
      }
    });
    return out;
  }

  function saveUnknownTagsToCustom(tags, strategy) {
    ensureCustomCategoriesStructure();
    recordHistorySnapshot(`导入未知文件到自定义 (${tags.length} 项)`, true);
    if (!Array.isArray(state.customTagCats) || !state.customTagCats.length) {
      state.customTagCats = [{ id: 'cust_tag_1', name: '新增分类1', icon: '🏷', tags: [] }];
    }
    const targetCat = state.customTagCats[0];
    if (strategy === 'overwrite') {
      targetCat.tags = tags.map(t => ({ en: t.en, zh: t.zh || '', desc: t.desc || '' }));
    } else {
      targetCat.tags = Array.isArray(targetCat.tags) ? targetCat.tags : [];
      const map = new Map();
      targetCat.tags.forEach((t, idx) => map.set(norm(t.en), idx));
      tags.forEach(inc => {
        const k = norm(inc.en);
        if (!k) return;
        if (map.has(k)) {
          if (strategy === 'merge' && inc.zh) targetCat.tags[map.get(k)].zh = inc.zh;
          if (inc.desc) targetCat.tags[map.get(k)].desc = inc.desc;
        } else {
          map.set(k, targetCat.tags.length);
          targetCat.tags.push({ en: inc.en, zh: inc.zh || '', desc: inc.desc || '' });
        }
      });
    }
    if (state.expandedSubs.indexOf(targetCat.id) < 0) state.expandedSubs.push(targetCat.id);
    syncFlatCustomFromTagCats();
    state.cat = 'custom';
    refreshAllFromTree();
    save();
  }

  async function executeScopedTagImport() {
    const raw = ($('#impPkgRawText') && $('#impPkgRawText').value) || '';
    const v = validateTagPackage(raw);
    const stat = $('#impCheckStat');
    if (!v.ok) {
      if (stat) stat.textContent = '❌ ' + v.error;
      toast(v.error);
      return;
    }
    const stratEl = document.querySelector('input[name="impStrategy"]:checked');
    const strategy = stratEl ? stratEl.value : 'merge';
    const fs = window.PG_TAG_FS;
    const now = new Date().toISOString();

    if (v.scope === 'unknown_custom') {
      saveUnknownTagsToCustom(v.tags, strategy);
      closeModal('modalTagPkg');
      toast(`已将未知文件的 ${v.tags.length} 个提示词默认存放至「自定义」`);
      return;
    }

    if (v.scope === 'sub') {
      const selMid = ($('#impTargetMajorSel') && $('#impTargetMajorSel').value) || '';
      const parentMid = (v.parentMajor && v.parentMajor.id) || '';
      let major = null;
      if (selMid && selMid !== '__custom__') {
        major = findTreeMajor(selMid);
      } else if (parentMid) {
        major = findTreeMajor(parentMid);
      }
      if (!major && (selMid === '__custom__' || !parentMid)) {
        saveUnknownTagsToCustom(v.sub.tags || [], strategy);
        closeModal('modalTagPkg');
        toast(`已将「${v.sub.name}」的 ${(v.sub.tags || []).length} 个提示词默认存放至「自定义」`);
        return;
      }
      if (!major) major = fs.majors[0];

      recordHistorySnapshot(`导入小分类: ${v.sub.name}`, true);
      const existingHit = findTreeSub(v.sub.id);
      if (existingHit) {
        existingHit.sub.name = strategy === 'overwrite' ? v.sub.name : existingHit.sub.name;
        existingHit.sub.icon = strategy === 'overwrite' ? v.sub.icon : existingHit.sub.icon;
        if (!$('#pkgMoveOtherDup') || $('#pkgMoveOtherDup').checked) {
          const touched = new Map();
          (v.sub.tags || []).forEach(t => removeTagFromOtherSubsInTree(t.en, existingHit.sub.id, touched));
          for (const { major: m, sub: s } of touched.values()) {
            await fs.persistOp({ action: 'save_sub', majorId: m.id, sub: s, major: m });
          }
        }
        existingHit.sub.tags = mergeSubTags(existingHit.sub.tags, v.sub.tags, strategy);
        existingHit.sub.updatedAt = now;
        await fs.persistOp({ action: 'save_sub', majorId: existingHit.major.id, sub: existingHit.sub, major: existingHit.major });
      } else {
        const newSub = {
          id: v.sub.id,
          name: v.sub.name,
          icon: v.sub.icon || '•',
          parentId: major.id,
          level: 2,
          order: (major.children || []).length + 1,
          file: `${major.id}/${major.id}_${v.sub.id}.json`,
          updatedAt: now,
          children: [],
          tags: v.sub.tags
        };
        major.children.push(newSub);
        await fs.persistOp({ action: 'save_sub', majorId: major.id, sub: newSub, major });
      }
      refreshAllFromTree();
      closeModal('modalTagPkg');
      toast(`已导入单小分类「${v.sub.name}」并同步写入外部文件`);
      return;
    }

    if (v.scope === 'major') {
      recordHistorySnapshot(`导入大分类: ${v.major.name}`, true);
      const incM = v.major;
      let major = findTreeMajor(incM.id);
      if (!major) {
        major = {
          id: incM.id,
          name: incM.name,
          icon: incM.icon || '📁',
          level: 1,
          order: fs.majors.length + 1,
          file: `${incM.id}.json`,
          subDir: incM.id,
          updatedAt: now,
          children: incM.children.map((s, idx) => ({
            id: s.id,
            name: s.name,
            icon: s.icon || '•',
            parentId: incM.id,
            level: 2,
            order: idx + 1,
            file: `${incM.id}/${s.id}.json`,
            updatedAt: now,
            children: [],
            tags: s.tags || []
          }))
        };
        fs.majors.push(major);
      } else {
        if (strategy === 'overwrite') {
          major.name = incM.name;
          major.icon = incM.icon || major.icon;
        }
        incM.children.forEach((incSub, idx) => {
          const exSub = (major.children || []).find(s => s.id === incSub.id);
          if (exSub) {
            if (strategy === 'overwrite') {
              exSub.name = incSub.name;
              exSub.icon = incSub.icon || exSub.icon;
            }
            exSub.tags = mergeSubTags(exSub.tags, incSub.tags || [], strategy);
            exSub.updatedAt = now;
          } else {
            major.children.push({
              id: incSub.id,
              name: incSub.name,
              icon: incSub.icon || '•',
              parentId: major.id,
              level: 2,
              order: (major.children || []).length + idx + 1,
              file: `${major.id}/${incSub.id}.json`,
              updatedAt: now,
              children: [],
              tags: incSub.tags || []
            });
          }
        });
      }
      await fs.persistOp({ action: 'save_major', major, includeChildren: true });
      state.cat = 'major:' + major.id;
      refreshAllFromTree();
      closeModal('modalTagPkg');
      toast(`已导入完整大分类「${major.name}」并生成对应分类文件`);
      return;
    }

    if (v.scope === 'tree') {
      recordHistorySnapshot('导入整套标签树', true);
      if (strategy === 'overwrite') {
        fs.majors = v.majors;
      } else {
        v.majors.forEach(incM => {
          let exM = findTreeMajor(incM.id);
          if (!exM) {
            fs.majors.push(incM);
          } else {
            (incM.children || []).forEach(incS => {
              const exS = (exM.children || []).find(s => s.id === incS.id);
              if (exS) exS.tags = mergeSubTags(exS.tags, incS.tags || [], strategy);
              else exM.children.push(incS);
            });
          }
        });
      }
      await fs.persistOp({ action: 'sync_all', majors: fs.majors });
      refreshAllFromTree();
      closeModal('modalTagPkg');
      toast('已导入二级标签树并同步外部文件');
    }
  }

  function bindTreeAndPkgEvents() {
    const on = (sel, ev, fn) => { const n = $(sel); if (n) n.addEventListener(ev, fn); };

    /* 二次确认弹窗按钮 */
    on('#btnConfirmOk', 'click', () => {
      const m = $('#modalConfirm');
      if (m) m.hidden = true;
      if (typeof _confirmCb === 'function') {
        const cb = _confirmCb;
        _confirmCb = null;
        cb();
      }
    });
    const closeConfirm = () => {
      const m = $('#modalConfirm');
      if (m) m.hidden = true;
      _confirmCb = null;
    };
    on('#btnConfirmCancel', 'click', closeConfirm);
    on('#btnConfirmClose', 'click', closeConfirm);

    /* (Req 6) 右上角灯泡按钮切换深色/白天高透亮模式 */
    on('#btnThemeBulb', 'click', () => {
      const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
      const next = cur === 'light' ? 'dark' : 'light';
      applyTheme(next);
      const st = $('#setTheme');
      if (st) st.value = next;
      const hr = new Date().getHours();
      const isDay = hr >= 6 && hr < 19;
      toast(next === 'light'
        ? `☀️ 已切换为白天高透毛玻璃模式（当前时段 ${isDay ? '06:00-19:00 日间' : '夜间'}）`
        : '🌙 已切换为夜间深邃毛玻璃模式');
    });

    /* (Req 3, Req 4, Req 5, Req 14) 右侧常驻展开/收起按钮 + 右侧侧边栏快捷骰子按钮 + 右上角保存按钮 */
    on('#btnRightEdgeToggle', 'click', () => {
      toggleRightSidebar();
    });
    on('#btnSidebarSave', 'click', () => {
      saveCurrent();
    });
    on('#btnSidebarQuickDice', 'click', e => {
      quickRollToSidebar(!!e.shiftKey);
    });
    on('#btnSaveToggleCustom', 'click', () => {
      const box = $('#saveCustomBox');
      if (box && !box.hidden && !($('#scEditId') && $('#scEditId').value)) {
        closeCustomSaveEditor();
      } else {
        openCustomSaveEditor('');
      }
    });
    on('#btnScClose', 'click', closeCustomSaveEditor);
    on('#btnScCancel', 'click', closeCustomSaveEditor);
    on('#btnScCommit', 'click', commitCustomSave);
    on('#saveSearch', 'input', renderSaves);
    on('#saveList', 'click', e => {
      const cp = e.target.closest('[data-scopy]');
      if (cp) {
        e.stopPropagation();
        const item = SAVES.find(x => x.id === cp.getAttribute('data-scopy'));
        if (item) {
          const txt = (item.sel || []).map(x => (x.w && x.w !== 1 ? `(${x.en}:${fmtW(x.w)})` : x.en)).join(', ');
          copyText(txt);
        }
        return;
      }
      const ed = e.target.closest('[data-sedit]');
      if (ed) {
        e.stopPropagation();
        openCustomSaveEditor(ed.getAttribute('data-sedit'));
        return;
      }
    });


    /* 全局快捷键：撤销/重做 + 中间标签区电脑文件夹式全套快捷键操作 */
    document.addEventListener('keydown', e => {
      const active = document.activeElement;
      const nonTextInputTypes = ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'file', 'color', 'image'];
      const inEditable = active && (
        (active.tagName === 'INPUT' && !active.readOnly && nonTextInputTypes.indexOf(String(active.type || '').toLowerCase()) < 0) ||
        (active.tagName === 'TEXTAREA' && !active.readOnly && active.id !== 'output') ||
        active.isContentEditable
      );
      const anyModalOpen = Array.from(document.querySelectorAll('.modal')).some(m => !m.hidden);

      if (e.key === 'Escape') {
        const ctxEl = document.getElementById('ctxMenu');
        if (ctxEl && !ctxEl.hidden) {
          e.preventDefault();
          hideContextMenu();
          return;
        }
        const openPop = ['#rsCascadePopover', '#rsIntervalListPopover', '#rsSchemePopover', '#rsRuleScopePopover', '#rsFixedSuggestPopover', '#stMajorSwitchPopover'].some(q => {
          const n = document.querySelector(q);
          return n && !n.hidden;
        });
        if (openPop) {
          e.preventDefault();
          if (typeof closeRsPopovers === 'function') closeRsPopovers();
          return;
        }
        const tplEd = document.getElementById('tplEdit');
        if (tplEd && !tplEd.hidden && document.getElementById('modalTpl') && !document.getElementById('modalTpl').hidden) {
          e.preventDefault();
          closeTplEditor();
          return;
        }
        const preEd = document.getElementById('presetEdit');
        if (preEd && !preEd.hidden && document.getElementById('modalPreset') && !document.getElementById('modalPreset').hidden) {
          e.preventDefault();
          closePresetEditor();
          return;
        }
        const chrEd = document.getElementById('charEdit');
        if (chrEd && !chrEd.hidden && document.getElementById('modalChar') && !document.getElementById('modalChar').hidden) {
          e.preventDefault();
          closeCharEditor();
          return;
        }
        if (anyModalOpen) {
          e.preventDefault();
          closeTopModal();
          return;
        }
        if (!inEditable && (state.batchSelectMode || (state.batchSelectedMap && state.batchSelectedMap.size > 0))) {
          e.preventDefault();
          toggleBatchSelectMode(false);
          toast('已退出批量选择');
          return;
        }
        hideContextMenu();
      }

      if (inEditable) return;

      const isMod = e.ctrlKey || e.metaKey;
      const k = String(e.key || '').toLowerCase();

      // 1. 撤销 (Ctrl+Z) 与 重做 (Ctrl+Y / Ctrl+Shift+Z)
      if (isMod && k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undoLastAction();
        return;
      }
      if (isMod && (k === 'y' || (k === 'z' && e.shiftKey))) {
        e.preventDefault();
        redoLastAction();
        return;
      }

      if (anyModalOpen) return;

      // 2. 电脑文件夹式全选 (Ctrl+A)
      if (isMod && k === 'a') {
        e.preventDefault();
        selectAllVisibleTagsInGrid();
        return;
      }

      // 3. 取消全选 (Ctrl+D)
      if (isMod && k === 'd') {
        if (state.batchSelectMode || (state.batchSelectedMap && state.batchSelectedMap.size > 0)) {
          e.preventDefault();
          clearBatchSelectionOnly();
          toast('已取消全选');
        }
        return;
      }

      // 4. 反选当前视图标签 (Ctrl+I)
      if (isMod && k === 'i' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        invertVisibleTagsInGrid();
        return;
      }

      // 5. 复制已选标签英文 (Ctrl+C)
      if (isMod && k === 'c' && !e.shiftKey) {
        const selTxt = window.getSelection ? String(window.getSelection().toString() || '').trim() : '';
        if (!selTxt && state.batchSelectMode && state.batchSelectedMap && state.batchSelectedMap.size > 0) {
          e.preventDefault();
          copyBatchSelectedTags();
          return;
        }
      }

      // 6. 剪切/移动已选标签到其他分类 (Ctrl+X)
      if (isMod && k === 'x' && !e.shiftKey) {
        if (state.batchSelectMode && state.batchSelectedMap && state.batchSelectedMap.size > 0) {
          e.preventDefault();
          openBatchMoveModal();
          return;
        }
      }

      // 7. 删除已选标签 (Delete / Backspace)
      if (!isMod && (e.key === 'Delete' || e.key === 'Backspace')) {
        if (state.batchSelectMode && state.batchSelectedMap && state.batchSelectedMap.size > 0) {
          e.preventDefault();
          confirmBatchDeleteTags();
          return;
        }
      }

      // (V1.1.3 Req 2) 批量选择仅用于中间页面标签管理（移动/删除/分级/复制），不通过快捷键自动塞入右侧侧边栏

      // 9. 批量选择模式下数字键 1/2/3/4 快速设置四级安全分级 (g/s/q/e)
      if (!isMod && !e.altKey && state.batchSelectMode && state.batchSelectedMap && state.batchSelectedMap.size > 0) {
        const rateMap = { '1': 'g', '2': 's', '3': 'q', '4': 'e' };
        if (rateMap[e.key]) {
          e.preventDefault();
          setTagsRatingState(Array.from(state.batchSelectedMap.values()), rateMap[e.key]);
          syncBatchSelectBarUI();
          return;
        }
      }

      // 10. 方向键与 Home/End 在网格标签间移动焦点（配合 Shift 区间连选）
      if (!isMod && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].indexOf(e.key) >= 0) {
        if (state.batchSelectMode || state.batchAnchorKey || state.batchLastClickedKey) {
          e.preventDefault();
          navigateGridChipByKey(e.key, e.shiftKey, isMod);
        }
      }
    });

    /* 左侧大分类拖拽排序 & 中间小分类拖拽排序 + layout-order.json */
    el.catNav.addEventListener('mousedown', e => {
      if (e.target.closest('.inline-rename-input, input, textarea')) e.stopPropagation();
    });
    el.catNav.addEventListener('dragstart', e => {
      if (state.editingMajorId || e.target.closest('.inline-rename-input, input, textarea')) {
        e.preventDefault();
        return;
      }
      const item = e.target.closest('.cat-item[data-major]');
      if (!item) return;
      _dragNodeType = 'major';
      _dragNodeId = item.getAttribute('data-major');
      window._internalDragging = true;
      item.classList.add('dragging-node');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', _dragNodeId); } catch (err) {}
      }
    });
    el.catNav.addEventListener('dragover', e => {
      if (_dragNodeType !== 'major' || !_dragNodeId) return;
      const overItem = e.target.closest('.cat-item[data-major]');
      if (!overItem) return;
      e.preventDefault();
      const targetId = overItem.getAttribute('data-major');
      if (targetId === _dragNodeId) return;
      const rect = overItem.getBoundingClientRect();
      const after = (e.clientY - rect.top) > rect.height / 2;
      $$('.cat-item[data-major]', el.catNav).forEach(n => n.classList.remove('drag-over-top', 'drag-over-bottom'));
      overItem.classList.add(after ? 'drag-over-bottom' : 'drag-over-top');
    });
    el.catNav.addEventListener('dragleave', e => {
      const overItem = e.target.closest('.cat-item[data-major]');
      if (overItem) overItem.classList.remove('drag-over-top', 'drag-over-bottom');
    });
    el.catNav.addEventListener('drop', e => {
      if (_dragNodeType !== 'major' || !_dragNodeId) return;
      e.preventDefault();
      e.stopPropagation();
      const overItem = e.target.closest('.cat-item[data-major]');
      $$('.cat-item[data-major]', el.catNav).forEach(n => n.classList.remove('drag-over-top', 'drag-over-bottom', 'dragging-node'));
      if (!overItem) return;
      const targetId = overItem.getAttribute('data-major');
      if (!targetId || targetId === _dragNodeId) return;
      const rect = overItem.getBoundingClientRect();
      const after = (e.clientY - rect.top) > rect.height / 2;
      recordHistorySnapshot('拖拽调整大分类排序');
      const fs = window.PG_TAG_FS;
      const curOrder = MAJORS.map(m => m.id);
      fs.layoutOrder = fs.layoutOrder || {};
      fs.layoutOrder.majorOrder = reorderArrayItem(curOrder, _dragNodeId, targetId, after);
      _dragNodeType = '';
      _dragNodeId = '';
      window._internalDragging = false;
      rebuildCatsFromTree();
      syncAndSaveLayoutOrder();
      renderNav();
      renderGrid();
      toast('已调整大分类排序（已同步保存至 layout-order.json）');
    });
    el.catNav.addEventListener('dragend', () => {
      _dragNodeType = '';
      _dragNodeId = '';
      window._internalDragging = false;
      $$('.cat-item[data-major]', el.catNav).forEach(n => n.classList.remove('drag-over-top', 'drag-over-bottom', 'dragging-node'));
    });

    el.grid.addEventListener('mousedown', e => {
      if (e.target.closest('.inline-rename-input, input, textarea')) e.stopPropagation();
    });
    el.grid.addEventListener('dragstart', e => {
      if (state.editingSubId || e.target.closest('.inline-rename-input, textarea')) {
        return;
      }
      if (e.target.closest('.sub-sec-body') || e.target.closest('.chip') || e.target.closest('button') || e.target.closest('input')) {
        if (e.target.closest('.sub-section')) e.preventDefault();
        return;
      }
      const head = e.target.closest('.sub-sec-head[data-toggle-sub]');
      if (!head) return;
      const sec = head.closest('.sub-section[data-sub-sec]');
      if (!sec) return;
      _dragNodeType = 'sub';
      _dragNodeId = sec.getAttribute('data-sub-sec');
      window._internalDragging = true;
      sec.classList.add('dragging-node');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', _dragNodeId); } catch (err) {}
      }
    });
    el.grid.addEventListener('dragover', e => {
      if (_dragNodeType !== 'sub' || !_dragNodeId) return;
      const overSec = e.target.closest('.sub-section[data-sub-sec]');
      if (!overSec) return;
      e.preventDefault();
      const targetId = overSec.getAttribute('data-sub-sec');
      if (targetId === _dragNodeId) return;
      const rect = overSec.getBoundingClientRect();
      const after = (e.clientY - rect.top) > rect.height / 2;
      $$('.sub-section[data-sub-sec]', el.grid).forEach(n => n.classList.remove('drag-over-top', 'drag-over-bottom'));
      overSec.classList.add(after ? 'drag-over-bottom' : 'drag-over-top');
    });
    el.grid.addEventListener('dragleave', e => {
      const overSec = e.target.closest('.sub-section[data-sub-sec]');
      if (overSec) overSec.classList.remove('drag-over-top', 'drag-over-bottom');
    });
    el.grid.addEventListener('drop', e => {
      if (_dragNodeType !== 'sub' || !_dragNodeId) return;
      e.preventDefault();
      e.stopPropagation();
      const overSec = e.target.closest('.sub-section[data-sub-sec]');
      $$('.sub-section[data-sub-sec]', el.grid).forEach(n => n.classList.remove('drag-over-top', 'drag-over-bottom', 'dragging-node'));
      if (!overSec) return;
      const targetId = overSec.getAttribute('data-sub-sec');
      if (!targetId || targetId === _dragNodeId) return;
      const rect = overSec.getBoundingClientRect();
      const after = (e.clientY - rect.top) > rect.height / 2;

      recordHistorySnapshot('拖拽调整小分类排序');
      const fs = window.PG_TAG_FS;
      fs.layoutOrder = fs.layoutOrder || { majorOrder: [], subOrderByMajor: {}, allSubOrder: [], charSubOrderByMode: {} };
      if (state.cat === 'char:games' || state.cat === 'char:anime' || state.cat === 'char:vtuber' || String(_dragNodeId).indexOf('char_') === 0) {
        const l1Mode = state.cat === 'char:anime' ? 'anime' : (state.cat === 'char:vtuber' ? 'vtuber' : 'games');
        const curSecs = getCharSubSections(l1Mode);
        const curSecIds = curSecs.map(s => s.secId);
        fs.layoutOrder.charSubOrderByMode = fs.layoutOrder.charSubOrderByMode || {};
        const nextOrder = reorderArrayItem(curSecIds, _dragNodeId, targetId, after);
        fs.layoutOrder.charSubOrderByMode[l1Mode] = nextOrder;
        if (Array.isArray(fs.charMajors)) {
          const cm = fs.charMajors.find(m => m.id === l1Mode);
          if (cm && Array.isArray(cm.children)) {
            const rankMap = new Map();
            nextOrder.forEach((secId, idx) => rankMap.set(secId, idx));
            const prefix = l1Mode === 'anime' ? 'anime' : (l1Mode === 'vtuber' ? 'vtuber' : 'game');
            cm.children.sort((a, b) => {
              const ra = rankMap.has(`char_${prefix}_${a.id}`) ? rankMap.get(`char_${prefix}_${a.id}`) : 9999;
              const rb = rankMap.has(`char_${prefix}_${b.id}`) ? rankMap.get(`char_${prefix}_${b.id}`) : 9999;
              return ra - rb;
            });
            cm.children.forEach((c, idx) => { c.order = idx + 1; });
          }
        }
        _dragNodeType = '';
        _dragNodeId = '';
        window._internalDragging = false;
        syncAndSaveLayoutOrder();
        renderGrid();
        save();
        toast('已调整角色库小分类排序（已同步保存至 layout-order.json）');
        return;
      }
      if (String(state.cat).indexOf('major:') === 0) {
        const mid = String(state.cat).slice(6);
        const m = MAJORS.find(x => x.id === mid);
        const curIds = m ? m.children.map(s => s.id) : [];
        fs.layoutOrder.subOrderByMajor = fs.layoutOrder.subOrderByMajor || {};
        fs.layoutOrder.subOrderByMajor[mid] = reorderArrayItem(curIds, _dragNodeId, targetId, after);
      } else {
        const curAll = CATS.map(c => c.id);
        fs.layoutOrder.allSubOrder = reorderArrayItem(curAll, _dragNodeId, targetId, after);
        const hitA = findTreeSub(_dragNodeId);
        const hitB = findTreeSub(targetId);
        if (hitA && hitB && hitA.major.id === hitB.major.id) {
          const mid = hitA.major.id;
          const m = MAJORS.find(x => x.id === mid);
          const curIds = m ? m.children.map(s => s.id) : [];
          fs.layoutOrder.subOrderByMajor = fs.layoutOrder.subOrderByMajor || {};
          fs.layoutOrder.subOrderByMajor[mid] = reorderArrayItem(curIds, _dragNodeId, targetId, after);
        }
      }
      _dragNodeType = '';
      _dragNodeId = '';
      window._internalDragging = false;
      rebuildCatsFromTree();
      syncAndSaveLayoutOrder();
      renderGrid();
      toast('已调整小分类排序（已同步保存至 layout-order.json）');
    });
    el.grid.addEventListener('dragend', () => {
      _dragNodeType = '';
      _dragNodeId = '';
      window._internalDragging = false;
      $$('.sub-section[data-sub-sec]', el.grid).forEach(n => n.classList.remove('drag-over-top', 'drag-over-bottom', 'dragging-node'));
    });

    window.addEventListener('beforeunload', () => {
      const fs = window.PG_TAG_FS;
      if (!fs || !fs.layoutOrder) return;
      fs.saveLayoutLocalMirror(fs.layoutOrder);
      if (fs.serverBase && navigator.sendBeacon) {
        try {
          const blob = new Blob([JSON.stringify(fs.layoutOrder)], { type: 'application/json' });
          navigator.sendBeacon(fs.serverBase + '/api/layout', blob);
        } catch (err) {}
      }
    });

    /* 右侧 #output 开启前后均可直接编辑 + 未开 MOSS 禁中文/中文逗号自动转英文 + 编辑后自动排序 */
    if (el.output) {
      el.output.addEventListener('compositionstart', () => {
        _isComposingOutput = true;
      });
      el.output.addEventListener('compositionend', () => {
        _isComposingOutput = false;
        if (!state.mossMode) {
          sanitizeOutputWhenMossOff(true);
        }
      });
      el.output.addEventListener('input', () => {
        if (_isComposingOutput) return;
        if (!state.mossMode) {
          sanitizeOutputWhenMossOff(true);
        }
      });
      el.output.addEventListener('change', () => {
        parseAndSortEditedOutput();
      });
      el.output.addEventListener('blur', () => {
        parseAndSortEditedOutput();
      });
      el.output.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          parseAndSortEditedOutput();
          el.output.blur();
          toast('已按语义顺序自动排序提示词');
        }
      });
    }

    /* (V1.0.1 Req 1/2/3/6) 随机抽取高级设置窗口事件（开关 / 随机抽取 / 方案 / 保存设置 + 常驻固定词标签化） */
    on('#btnRandSettings', 'click', () => {
      openRandomSettingsModal('switches');
    });
    on('#btnRsTabSwitches', 'click', () => {
      syncRandomSettingsFromDOM(false);
      switchRsTab('switches');
      renderRsSwitchesTable();
    });
    on('#btnRsTabRules', 'click', () => {
      syncRandomSettingsFromDOM(false);
      switchRsTab('rules');
      renderRsCatRulesTable();
    });
    on('#btnRsSchemeMenu', 'click', e => {
      e.stopPropagation();
      syncRandomSettingsFromDOM(false);
      openRsSchemePopover(e.currentTarget || $('#btnRsSchemeMenu'));
    });
    on('#btnRsRuleScopeMenu', 'click', e => {
      e.stopPropagation();
      syncRandomSettingsFromDOM(false);
      openRsRuleScopePopover(e.currentTarget || $('#btnRsRuleScopeMenu'));
    });
    on('#btnRsSaveAndRoll', 'click', () => {
      const fInp = $('#rsFixedTagInput');
      if (fInp && fInp.value.trim()) {
        addFixedTagToken(fInp.value.trim());
        fInp.value = '';
      }
      syncRandomSettingsFromDOM(false);
      syncActiveSchemeSnapshot();
      _rsCommittedSave = true;
      _rsSavedBackup = JSON.parse(JSON.stringify(state.randCfg));
      renderRandSwitchBar();
      save();
      generateRandom(false);
      closeRsPopovers();
      closeModal('modalRandomSettings');
      toast('💾 已保存随机抽取设置');
    });

    // 常驻固定词标签化交互
    on('#rsFixedChipBox', 'click', e => {
      const delBtn = e.target.closest('[data-fixed-del]');
      if (delBtn) {
        e.stopPropagation();
        ensureEditableSchemeOnModify();
        const idx = Number(delBtn.getAttribute('data-fixed-del'));
        const cur = getFixedTagsArray();
        cur.splice(idx, 1);
        setFixedTagsArray(cur);
        syncActiveSchemeSnapshot();
        renderFixedTagsChipsUI();
        return;
      }
      const inp = $('#rsFixedTagInput');
      if (inp && e.target !== inp) inp.focus();
    });
    const fixedInpEl = $('#rsFixedTagInput');
    if (fixedInpEl) {
      fixedInpEl.addEventListener('input', () => {
        const val = fixedInpEl.value;
        if (val.includes(',') || val.includes('，')) {
          addFixedTagToken(val);
          fixedInpEl.value = '';
          closeRsPopovers();
          return;
        }
        openFixedTagSuggestPopover(val, fixedInpEl);
      });
      fixedInpEl.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (fixedInpEl.value.trim()) {
            addFixedTagToken(fixedInpEl.value.trim());
            fixedInpEl.value = '';
            closeRsPopovers();
          }
        } else if (e.key === 'Backspace' && !fixedInpEl.value) {
          const cur = getFixedTagsArray();
          if (cur.length) {
            ensureEditableSchemeOnModify();
            cur.pop();
            setFixedTagsArray(cur);
            syncActiveSchemeSnapshot();
            renderFixedTagsChipsUI();
          }
        }
      });
      fixedInpEl.addEventListener('blur', () => {
        setTimeout(() => {
          if (fixedInpEl.value.trim()) {
            addFixedTagToken(fixedInpEl.value.trim());
            fixedInpEl.value = '';
          }
        }, 150);
      });
    }

    on('#rsSwitchesBody', 'change', () => {
      syncRandomSettingsFromDOM(true);
      renderRsSwitchesTable();
    });
    on('#rsSwitchesBody', 'click', e => {
      const jumpCell = e.target.closest('[data-rs-sw-jump]');
      if (jumpCell) {
        const swId = jumpCell.getAttribute('data-rs-sw-jump');
        if (swId) {
          syncRandomSettingsFromDOM(false);
          const rcfg = ensureRandCfgStructure();
          rcfg.activeRuleScope = swId;
          switchRsTab('rules');
          renderRsCatRulesTable();
        }
      }
    });
    const swBodyEl = $('#rsSwitchesBody');
    if (swBodyEl) {
      swBodyEl.addEventListener('contextmenu', e => {
        const tr = e.target.closest('tr[data-sw-idx]');
        if (!tr) return;
        e.preventDefault();
        e.stopPropagation();
        const idx = Number(tr.getAttribute('data-sw-idx'));
        const rcfg = ensureRandCfgStructure();
        const sw = rcfg.switches[idx];
        if (!sw) return;
        placeContextMenu(e.clientX, e.clientY, `
          <div class="ctx-head">🎛 开关：${esc(sw.name)}</div>
          <button type="button" data-ctx-rsw="rename" data-sw-idx="${idx}">✎ 重命名开关</button>
          <button type="button" data-ctx-rsw="edit-rules" data-sw-idx="${idx}">🎲 查看/配置该开关抽取区间</button>
          ${!sw.builtin ? `<button type="button" class="danger" data-ctx-rsw="delete" data-sw-idx="${idx}">🗑 删除新增开关</button>` : ''}
        `);
      });
    }

    on('#btnRsAddSwitch', 'click', () => {
      syncRandomSettingsFromDOM(false);
      ensureEditableSchemeOnModify();
      const rcfg = ensureRandCfgStructure();
      const custIdx = rcfg.switches.filter(s => !s.builtin).length + 1;
      const defSub = (CATS[0] && CATS[0].id) || 'style';
      const newSw = {
        id: 'sw_cust_' + Date.now().toString(36),
        name: `自定义开关${custIdx}`,
        _customNamed: true,
        enabled: true,
        tagType: 'sfw',
        rules: [
          {
            id: 'sr_cust_' + Date.now().toString(36),
            attr: 'add',
            targetId: defSub,
            mode: 'fixed',
            level: 'sfw',
            count: 1,
            prob: 100
          }
        ],
        builtin: false
      };
      newSw.desc = getSwitchRuleSummaryText(newSw);
      rcfg.switches.push(newSw);
      syncActiveSchemeSnapshot();
      renderRsSwitchesTable();
      toast(`＋ 已新增「${newSw.name}」（右键可重命名或删除，可在「随机抽取」中配置其区间规则）`);
    });

    on('#rsCatRulesBody', 'change', e => {
      const subwInp = e.target.closest('input[data-rs-subw-idx]');
      if (subwInp) {
        ensureEditableSchemeOnModify();
        const rIdx = Number(subwInp.getAttribute('data-rs-subw-idx'));
        const sIdx = Number(subwInp.getAttribute('data-rs-subw-sidx'));
        const rcfg = ensureRandCfgStructure();
        const activeRules = getActiveRuleScopeList(rcfg);
        const rule = activeRules[rIdx];
        if (rule && Array.isArray(rule.subWeights)) {
          rebalanceSubWeightsOnEdit(rule.subWeights, sIdx, subwInp.value);
          syncActiveSchemeSnapshot();
          renderRsCatRulesTable();
        }
        return;
      }
      const sel = e.target.closest('select[data-rs-rule-field]');
      if (sel) {
        const field = sel.getAttribute('data-rs-rule-field');
        const tr = sel.closest('tr[data-rule-idx]');
        if (tr) {
          ensureEditableSchemeOnModify();
          const idx = Number(tr.getAttribute('data-rule-idx'));
          const rcfg = ensureRandCfgStructure();
          const activeRules = getActiveRuleScopeList(rcfg);
          const rule = activeRules[idx];
          if (rule) {
            if (field === 'attr') rule.attr = (sel.value === 'forbid') ? 'forbid' : 'add';
            else if (field === 'mode') rule.mode = (sel.value === 'fixed') ? 'fixed' : 'prob';
            else if (field === 'level') {
              rule.level = (sel.value === 'nsfw') ? 'nsfw' : 'sfw';
              if (rule.isMajorGroup) {
                rule.subWeights = getDefaultSubWeightsForMajor(rule.targetId, rule.level);
              }
            }
            syncActiveSchemeSnapshot();
            renderRsCatRulesTable();
            renderRsSwitchesTable();
            return;
          }
        }
      }
      syncRandomSettingsFromDOM(true);
    });
    on('#rsCatRulesBody', 'input', e => {
      if (e.target.closest('[data-rs-rule-field="count"], [data-rs-rule-field="minCount"], [data-rs-rule-field="maxCount"], [data-rs-rule-field="prob"]')) {
        syncRandomSettingsFromDOM(true);
      }
    });
    on('#rsNsfwMinCountInput', 'input', () => {
      syncRandomSettingsFromDOM(true);
    });
    on('#rsNsfwMinCountInput', 'change', () => {
      syncRandomSettingsFromDOM(true);
      renderRsSwitchesTable();
      renderRsCatRulesTable();
    });
    on('#rsCatRulesBody', 'click', e => {
      const majToggle = e.target.closest('[data-rs-major-toggle]');
      if (majToggle) {
        e.stopPropagation();
        syncRandomSettingsFromDOM(false);
        const idx = Number(majToggle.getAttribute('data-rs-major-toggle'));
        const rcfg = ensureRandCfgStructure();
        const activeRules = getActiveRuleScopeList(rcfg);
        if (activeRules[idx]) {
          activeRules[idx].expanded = !activeRules[idx].expanded;
          renderRsCatRulesTable();
        }
        return;
      }
      const eqBtn = e.target.closest('[data-rs-subw-equal]');
      if (eqBtn) {
        e.stopPropagation();
        ensureEditableSchemeOnModify();
        const idx = Number(eqBtn.getAttribute('data-rs-subw-equal'));
        const rcfg = ensureRandCfgStructure();
        const activeRules = getActiveRuleScopeList(rcfg);
        const rule = activeRules[idx];
        if (rule && Array.isArray(rule.subWeights) && rule.subWeights.length) {
          rule.subWeights.forEach(sw => { sw.weight = 1; });
          rule.subWeights = normalizeSubWeightsList(rule.subWeights);
          syncActiveSchemeSnapshot();
          renderRsCatRulesTable();
          toast('⚖️ 已将该大分类所属小分类概率平均分配（总和 = 1.00）');
        }
        return;
      }
      const pickBtn = e.target.closest('[data-rs-rule-pick]');
      if (pickBtn) {
        e.stopPropagation();
        syncRandomSettingsFromDOM(false);
        const idx = Number(pickBtn.getAttribute('data-rs-rule-pick'));
        const rcfg = ensureRandCfgStructure();
        const activeRules = getActiveRuleScopeList(rcfg);
        if (!activeRules[idx]) return;
        openRsCascadePopover(pickBtn, {
          onlyChar: false,
          onPick: chosenId => {
            ensureEditableSchemeOnModify();
            const curRules = getActiveRuleScopeList(ensureRandCfgStructure());
            const targetRule = curRules[idx];
            if (!targetRule) return;
            targetRule.targetId = chosenId;
            targetRule.isMajorGroup = String(chosenId).indexOf('major:') === 0;
            if (targetRule.isMajorGroup) {
              targetRule.subWeights = getDefaultSubWeightsForMajor(chosenId, targetRule.level || 'sfw');
              targetRule.expanded = true;
            } else {
              delete targetRule.subWeights;
              targetRule.expanded = false;
            }
            syncActiveSchemeSnapshot();
            renderRsCatRulesTable();
            renderRsSwitchesTable();
          }
        });
        return;
      }
      const delBtn = e.target.closest('[data-rs-rule-del]');
      if (delBtn) {
        ensureEditableSchemeOnModify();
        const idx = Number(delBtn.getAttribute('data-rs-rule-del'));
        const rcfg = ensureRandCfgStructure();
        const activeRules = getActiveRuleScopeList(rcfg);
        activeRules.splice(idx, 1);
        syncActiveSchemeSnapshot();
        renderRsCatRulesTable();
        renderRsSwitchesTable();
        toast('已删除该区间规则');
      }
    });

    on('#btnRsAddDrawRule', 'click', e => {
      syncRandomSettingsFromDOM(false);
      const btn = e.currentTarget || $('#btnRsAddDrawRule');
      openRsCascadePopover(btn, {
        onlyChar: false,
        onPick: chosenId => {
          ensureEditableSchemeOnModify();
          const rcfg = ensureRandCfgStructure();
          const curScope = rcfg.activeRuleScope || 'default';
          const activeRules = getActiveRuleScopeList(rcfg);
          const isNsfwScope = (curScope === 'sw_nsfw' || String(chosenId).indexOf('nsfw_') === 0);
          const isMajorChosen = String(chosenId).indexOf('major:') === 0;
          const lv = isNsfwScope ? 'nsfw' : 'sfw';
          activeRules.push({
            id: 'dr_' + Date.now().toString(36),
            attr: 'add',
            targetId: chosenId,
            isMajorGroup: isMajorChosen,
            expanded: isMajorChosen,
            mode: (curScope === 'sw_quality' || curScope === 'sw_artist' || chosenId === 'char:library') ? 'fixed' : 'prob',
            level: lv,
            count: 1,
            minCount: 1,
            maxCount: 1,
            prob: isNsfwScope ? 50 : 70,
            ...(isMajorChosen ? { subWeights: getDefaultSubWeightsForMajor(chosenId, lv) } : {})
          });
          syncActiveSchemeSnapshot();
          renderRsCatRulesTable();
          renderRsSwitchesTable();
          toast(`＋ 已在「${getScopeDisplayName(rcfg, curScope)}」新增区间：${formatTargetIntervalShortName(chosenId)}`);
        }
      });
    });

    document.addEventListener('click', e => {
      const ctxRswBtn = e.target.closest('[data-ctx-rsw]');
      if (ctxRswBtn) {
        const act = ctxRswBtn.getAttribute('data-ctx-rsw');
        const idx = Number(ctxRswBtn.getAttribute('data-sw-idx'));
        hideContextMenu();
        const rcfg = ensureRandCfgStructure();
        const sw = rcfg.switches[idx];
        if (!sw) return;
        if (act === 'rename') {
          const nextName = window.prompt('请输入新的开关名称：', sw.name);
          if (nextName && nextName.trim()) {
            ensureEditableSchemeOnModify();
            sw.name = nextName.trim();
            sw._customNamed = true;
            syncActiveSchemeSnapshot();
            renderRsSwitchesTable();
            renderRsCatRulesTable();
            renderRandSwitchBar();
            save();
            toast(`已重命名开关为「${sw.name}」`);
          }
        } else if (act === 'edit-rules') {
          rcfg.activeRuleScope = sw.id;
          switchRsTab('rules');
          renderRsCatRulesTable();
        } else if (act === 'delete') {
          if (sw.builtin) {
            toast('内置开关不可删除');
            return;
          }
          askConfirmModal(`确定删除新增开关「${sw.name}」吗？`, () => {
            ensureEditableSchemeOnModify();
            const curRcfg = ensureRandCfgStructure();
            const delId = sw.id;
            curRcfg.switches.splice(idx, 1);
            if (curRcfg.activeRuleScope === delId) {
              curRcfg.activeRuleScope = 'default';
            }
            syncActiveSchemeSnapshot();
            renderRsSwitchesTable();
            renderRsCatRulesTable();
            renderRandSwitchBar();
            save();
            toast(`🗑 已删除新增开关「${sw.name}」`);
          });
        }
        return;
      }
      const ctxPreBtn = e.target.closest('[data-ctx-preset]');
      if (ctxPreBtn) {
        const act = ctxPreBtn.getAttribute('data-ctx-preset');
        const pk = ctxPreBtn.getAttribute('data-pkey');
        hideContextMenu();
        if (act === 'apply') applyPreset(pk);
        else if (act === 'edit') openPresetEditor(pk);
        else if (act === 'export') {
          const pObj = PRESETS.find(x => x.key === pk);
          if (pObj) {
            exportLibraryJsonFile(pObj.name || pObj.key, {
              key: pObj.key, id: pObj.key, name: pObj.name, desc: pObj.desc || '', cat: pObj.cat || '场景',
              tags: (pObj.tags || []).map(t => (t.zh ? t.en + '|' + t.zh : t.en)).join(';')
            }, '📤 已导出预设：' + pObj.name + '.json');
          }
        }
        else if (act === 'delete') deletePreset(pk);
        return;
      }
      const ctxTplBtn = e.target.closest('[data-ctx-tpl]');
      if (ctxTplBtn) {
        const act = ctxTplBtn.getAttribute('data-ctx-tpl');
        const tid = ctxTplBtn.getAttribute('data-tid');
        hideContextMenu();
        if (act === 'apply') applyTpl(tid, false);
        else if (act === 'edit') openTplEditor(tid);
        else if (act === 'export') {
          const tObj = getEffectiveTpls().find(x => x.id === tid);
          if (tObj) exportLibraryJsonFile(tObj.name || tObj.id, tObj, '📤 已导出模板：' + (tObj.name || tObj.id) + '.json');
        }
        else if (act === 'delete') deleteTplById(tid);
        return;
      }
      const ctxSchemeBtn = e.target.closest('[data-ctx-scheme]');
      if (ctxSchemeBtn) {
        const act = ctxSchemeBtn.getAttribute('data-ctx-scheme');
        const sid = ctxSchemeBtn.getAttribute('data-sid');
        hideContextMenu();
        const rcfg = ensureRandCfgStructure();
        const scIdx = (rcfg.schemes || []).findIndex(x => x.id === sid);
        if (scIdx < 0) return;
        const sc = rcfg.schemes[scIdx];
        const popEl = $('#rsSchemePopover');
        const wasPopOpen = !!(popEl && !popEl.hidden);
        if (act === 'export') {
          exportRandSchemeJson(sc);
        } else if (act === 'rename') {
          const nextName = window.prompt('请输入新的方案名称：', sc.name);
          if (nextName && nextName.trim()) {
            recordHistorySnapshot('重命名随机方案: ' + sc.name + ' → ' + nextName.trim());
            sc.name = nextName.trim();
            persistRandSchemeToFolder(sc);
            syncSchemeLabelUI();
            save();
            if (wasPopOpen && $('#btnRsSchemeMenu')) openRsSchemePopover($('#btnRsSchemeMenu'));
            toast(`已重命名方案为「${sc.name}」`);
          }
        } else if (act === 'delete') {
          recordHistorySnapshot('删除随机方案: ' + sc.name);
          rcfg.schemes.splice(scIdx, 1);
          deleteRandSchemeFromFolder(sid);
          if (rcfg.activeSchemeId === sid) {
            applyRandSchemeById('default');
          } else {
            syncSchemeLabelUI();
            save();
          }
          if (wasPopOpen && $('#btnRsSchemeMenu')) openRsSchemePopover($('#btnRsSchemeMenu'));
          toast(`🗑 已删除方案「${sc.name}」（可按 Ctrl+Z 撤销）`);
        }
        return;
      }
      if (!e.target.closest('#rsCascadePopover, #rsIntervalListPopover, #rsSchemePopover, #rsRuleScopePopover, #rsFixedSuggestPopover, #stMajorSwitchPopover, [data-rs-rule-pick], #btnRsAddDrawRule, #btnRsSchemeMenu, #btnRsRuleScopeMenu, [data-st-act="switch-major"]')) {
        closeRsPopovers();
      }
    });

    /* 帮助窗口与更新日志窗口打开时读取渲染独立 help.md / update.md (Req 7 & Req 8) */
    on('#btnHelp', 'click', () => {
      loadAndRenderHelpMd(false);
    });
    on('#btnChangelog', 'click', () => {
      openModal('modalChangelog');
      loadAndRenderChangelogMd();
    });

    /* 全局捕获阶段点击关闭右键菜单（即使子浮层/弹窗内 stopPropagation 也能立即关闭，消除右键残留 Bug） */
    document.addEventListener('mousedown', e => {
      const cm = $('#ctxMenu');
      if (cm && !cm.hidden && !e.target.closest('#ctxMenu')) {
        hideContextMenu();
      }
    }, true);
    window.addEventListener('blur', () => hideContextMenu());

    /* 全局点击关闭右键菜单与历史记录浮层（注意：右侧提示词侧边栏绝不因点击外部而回退！） */
    document.addEventListener('click', e => {
      if (!e.target.closest('#ctxMenu')) hideContextMenu();
    });

    /* 右键菜单点击动作（含大分类、小分类、角色卡片、标签芯片、收藏/最近清空 - Req 3 & Req 8） */
    on('#ctxMenu', 'click', async e => {
      const stAct = e.target.closest('button[data-ctx-stage]');
      if (stAct) {
        const act = stAct.getAttribute('data-ctx-stage');
        const mid = stAct.getAttribute('data-mid');
        const sid = stAct.getAttribute('data-sid');
        const ti = Number(stAct.getAttribute('data-ti'));
        hideContextMenu();
        if (act === 'import-major') executeStageSubsetImport(g => getSubDisplayInfo(g.id, g).majorId === mid, `大分类 ${mid}`);
        else if (act === 'del-major') deleteStageSubset(g => getSubDisplayInfo(g.id, g).majorId === mid);
        else if (act === 'import-sub') executeStageSubsetImport(g => g.id === sid, `小分类 ${sid}`);
        else if (act === 'del-sub') deleteStageSubset(g => g.id === sid);
        else if (act === 'import-tag') executeStageSubsetImport((g, _, idx) => g.id === sid && idx === ti, '单条标签');
        else if (act === 'edit-tag') openStageEditModal('tag', sid, ti);
        else if (act === 'del-tag') deleteStageSubset((g, _, idx) => g.id === sid && idx === ti);
        else if (act === 'import-selected') executeStageSubsetImport((g, _, idx) => isStageTagSelected(g.id, idx), '已选条目');
        else if (act === 'del-selected') deleteStageSubset((g, _, idx) => isStageTagSelected(g.id, idx), '🗑 已删除选中的暂存条目');
        return;
      }
      const mBtn = e.target.closest('[data-ctx-major]');
      if (mBtn) {
        const act = mBtn.getAttribute('data-ctx-major');
        const mid = mBtn.getAttribute('data-mid');
        hideContextMenu();
        handleMajorQuickAct(act, mid);
        return;
      }
      const frBtn = e.target.closest('[data-ctx-favrec]');
      if (frBtn) {
        const which = frBtn.getAttribute('data-which');
        hideContextMenu();
        clearFavOrRecent(which);
        return;
      }
      const cBtn = e.target.closest('[data-ctx-char]');
      if (cBtn) {
        const act = cBtn.getAttribute('data-ctx-char');
        const ckey = cBtn.getAttribute('data-ckey');
        hideContextMenu();
        if (act === 'apply') {
          applyCharacter(ckey);
        } else if (act === 'fav') {
          toggleFavChar(ckey);
        } else if (act === 'upload') {
          _uploadingCharKey = ckey;
          const inp = $('#charImgUploadInput');
          if (inp) { inp.value = ''; inp.click(); }
        } else if (act === 'del-img') {
          const c = CHARS.find(x => x.key === ckey);
          if (c) {
            const baseName = getCharImgBaseName(c);
            await saveCharImgToIdb(baseName, '');
            const fs = window.PG_TAG_FS;
            const b = (fs && fs.serverBase) || (window.__ACTIVE_SERVER_BASE__ || (typeof location !== 'undefined' && /^https?:$/.test(location.protocol) ? location.origin : 'http://127.0.0.1:18177'));
            try {
              await fetch(b + '/api/char-img', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'delete', baseName })
              });
            } catch (err) {}
            renderGrid();
            toast(`已移除「${c.name}」的图片`);
          }
        } else if (act === 'edit') {
          const custHit = findCustomCharByKey(ckey);
          openUnifiedCharEditor({
            scope: custHit ? 'custom' : 'library',
            editKey: ckey
          });
        } else if (act === 'del') {
          const custHit = findCustomCharByKey(ckey);
          if (custHit) {
            askConfirmModal(`确定删除自定义人物「${custHit.name}」吗？`, () => {
              state.customChars = (state.customChars || []).filter(x => x.key !== ckey);
              if (state.chars.some(x => x.key === ckey)) removeCharacter(ckey);
              refreshAllFromTree();
              save();
              toast(`已删除人物「${custHit.name}」`);
            });
          } else {
            deleteChar(ckey);
          }
        }
        return;
      }
      const rateBtn = e.target.closest('[data-ctx-rate]');
      if (rateBtn) {
        const r = rateBtn.getAttribute('data-ctx-rate');
        const en = rateBtn.getAttribute('data-en');
        const subId = rateBtn.getAttribute('data-sub');
        hideContextMenu();
        ensureBatchState();
        const k = norm(cleanArtistEn(en));
        if (state.batchSelectMode && state.batchSelectedMap && state.batchSelectedMap.size > 1 && state.batchSelectedMap.has(k)) {
          await setTagsRatingState(Array.from(state.batchSelectedMap.values()), r);
          syncBatchSelectBarUI();
        } else {
          await setTagsRatingState([{ en, subId }], r);
        }
        return;
      }
      const tBtn = e.target.closest('[data-ctx-tag]');
      if (tBtn) {
        const act = tBtn.getAttribute('data-ctx-tag');
        const en = tBtn.getAttribute('data-en');
        const subId = tBtn.getAttribute('data-sub');
        const lmode = tBtn.getAttribute('data-lmode');
        hideContextMenu();
        if (act === 'copy') {
          copyText(en);
          toast(`📋 已复制英文提示词：${en}`);
          return;
        }
        if (act === 'toggle-nsfw') {
          const cur = isNsfwTag(en, subId);
          await setTagsRatingState([{ en, subId }], cur ? 'g' : 'e');
          return;
        }
        if (act === 'fav') {
          recordHistorySnapshot(`${isFavTag(en) ? '取消收藏' : '收藏'}: ${en}`);
          toggleFavTag(en);
        } else if (act === 'edit') {
          openQuickEditTagModal(subId, en);
        } else if (act === 'move') {
          openMoveTagModal(subId, en);
        } else if (act === 'del') {
          if (state.cat === 'fav' || state.cat === 'char:fav' || lmode === 'fav') {
            removeTagFromFavOrRecent('fav', en);
          } else if (state.cat === 'recent' || state.cat === 'char:recent' || lmode === 'recent' || lmode === 'recent_char') {
            removeTagFromFavOrRecent(lmode || 'recent', en);
          } else if (subId === '__custom__' || state.cat === 'custom') {
            askConfirmModal(`确定删除自定义提示词「${en}」吗？`, () => {
              recordHistorySnapshot(`删除自定义词: ${en}`);
              state.custom = state.custom.filter(t => norm(t.en) !== norm(en));
              renderAll();
              save();
            });
          } else {
            deleteTagFromSub(subId, en);
          }
        }
        return;
      }
      const sBtn = e.target.closest('[data-ctx-sub]');
      if (sBtn) {
        const act = sBtn.getAttribute('data-ctx-sub');
        const sid = sBtn.getAttribute('data-sid');
        hideContextMenu();
        if (act === 'toggle-exp') {
          const idx = state.expandedSubs.indexOf(sid);
          if (idx >= 0) state.expandedSubs.splice(idx, 1);
          else state.expandedSubs.push(sid);
          renderGrid();
          return;
        }
        if (act === 'new-char') {
          openUnifiedCharEditor({
            scope: 'library',
            subId: sBtn.getAttribute('data-rawid') || sid,
            subName: sBtn.getAttribute('data-sname') || '',
            l1Mode: sBtn.getAttribute('data-l1') || 'games'
          });
          return;
        }
        if (act === 'promote-char-sub') {
          const l1 = sBtn.getAttribute('data-l1') || 'games';
          const rawId = sBtn.getAttribute('data-rawid') || sid;
          const sName = sBtn.getAttribute('data-sname') || rawId;
          const charSub = getCharSubSections(l1).find(g => g.id === rawId || g.name === sName);
          const charsList = charSub ? (charSub.chars || []) : [];
          const fs = window.PG_TAG_FS;
          let newMid = safeId(rawId);
          if (findTreeMajor(newMid)) newMid = `${newMid}_major_${Date.now().toString(36).slice(-3)}`;
          const convertedTags = [];
          const seenT = new Set();
          charsList.forEach(c => {
            if (c.tag && !seenT.has(norm(c.tag))) {
              seenT.add(norm(c.tag));
              convertedTags.push({ en: c.tag, zh: c.charZh || c.name || '' });
            }
          });
          const now = new Date().toISOString();
          const newChildSub = {
            id: `${newMid}_base`,
            name: sName,
            icon: '🧝',
            parentId: newMid,
            level: 2,
            order: 1,
            file: `${newMid}/${newMid}_base.json`,
            updatedAt: now,
            children: [],
            tags: convertedTags
          };
          const newMajor = {
            id: newMid,
            name: sName,
            icon: '🧝',
            level: 1,
            order: (fs.majors || []).length + 1,
            file: `${newMid}/${newMid}.json`,
            subDir: newMid,
            updatedAt: now,
            children: [newChildSub]
          };
          recordHistorySnapshot(`角色小分类升格为大分类: ${sName}`, true);
          fs.majors.push(newMajor);
          if (fs.layoutOrder && Array.isArray(fs.layoutOrder.majorOrder)) {
            fs.layoutOrder.majorOrder.push(newMid);
            fs.persistLayoutFile(fs.layoutOrder);
          }
          await fs.persistOp({ action: 'save_major', major: newMajor, includeChildren: true });
          state.cat = 'major:' + newMid;
          if (state.expandedSubs.indexOf(newChildSub.id) < 0) state.expandedSubs.push(newChildSub.id);
          refreshAllFromTree();
          save();
          toast(`⬆️ 已将「${sName}」分类到左侧成为一级大分类`);
          return;
        }
        if (act === 'move-char-sub') {
          openMoveSubModal(sid);
          return;
        }
        if (act === 'export-char-sub') {
          const l1 = sBtn.getAttribute('data-l1') || 'games';
          const rawId = sBtn.getAttribute('data-rawid') || sid;
          const sName = sBtn.getAttribute('data-sname') || rawId;
          const charSub = getCharSubSections(l1).find(g => g.id === rawId || g.name === sName);
          const pkg = {
            app: 'Danbooru Prompt',
            version: 2.9,
            scope: 'char_sub',
            exportedAt: new Date().toISOString(),
            l1Mode: l1,
            subcategory: {
              id: rawId,
              name: sName,
              characters: (charSub ? charSub.chars : []).map(c => ({
                name: c.name,
                game: c.game || sName,
                tag: c.tag,
                charZh: c.charZh || c.name,
                desc: c.desc || '',
                auto: c.auto || []
              }))
            }
          };
          downloadJsonBlob(pkg, `charpkg-sub-${rawId}.json`);
          toast(`📤 已导出角色小分类「${sName}」`);
          return;
        }
        if (act === 'del-char-sub') {
          if (typeof window.deleteCharLibrarySub === 'function') {
            window.deleteCharLibrarySub(sid, sBtn.getAttribute('data-sname') || '', sBtn.getAttribute('data-l1') || 'games');
          }
          return;
        }
        if (act === 'add-cust-tag') {
          openMiniAddTag(sid);
          return;
        }
        if (act === 'del-cust-sub') {
          if (typeof window.deleteCustomTagSub === 'function') {
            window.deleteCustomTagSub(sid);
          }
          return;
        }
        handleSubQuickAct(act, sid);
      }
    });

    on('#btnQeTagSave', 'click', saveQuickEditTag);
    ['#qeTagEn', '#qeTagZh', '#qeTagDesc'].forEach(sel => {
      on(sel, 'keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          saveQuickEditTag();
        }
      });
    });

    on('#mvTagMajorSel', 'change', e => syncMoveTagSubOptions(e.target.value));
    on('#btnMvTagConfirm', 'click', confirmMoveTag);
    on('#btnMvSubConfirm', 'click', confirmMoveSub);

    el.catNav.addEventListener('keydown', e => {
      const inp = e.target.closest('#inlineMajorInput');
      if (!inp) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        finishInlineMajorRename(inp.getAttribute('data-mid'), inp.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        state.editingMajorId = '';
        renderNav();
      }
    });
    el.catNav.addEventListener('focusout', e => {
      const inp = e.target.closest('#inlineMajorInput');
      if (!inp) return;
      const mid = inp.getAttribute('data-mid');
      const val = inp.value;
      setTimeout(() => {
        if (state.editingMajorId === mid) finishInlineMajorRename(mid, val);
      }, 120);
    });

    el.grid.addEventListener('keydown', e => {
      const inp = e.target.closest('#inlineSubInput');
      if (!inp) return;
      const sid = inp.getAttribute('data-sid') || inp.getAttribute('data-sub-id');
      if (e.key === 'Enter') {
        e.preventDefault();
        finishInlineSubRename(sid, inp.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        state.editingSubId = '';
        renderGrid();
      }
    });
    el.grid.addEventListener('focusout', e => {
      const inp = e.target.closest('#inlineSubInput');
      if (!inp) return;
      const sid = inp.getAttribute('data-sid') || inp.getAttribute('data-sub-id');
      const val = inp.value;
      setTimeout(() => {
        if (state.editingSubId === sid) finishInlineSubRename(sid, val);
      }, 120);
    });
    document.addEventListener('mousedown', e => {
      if (state.editingMajorId && !e.target.closest('#inlineMajorInput')) {
        const inp = document.getElementById('inlineMajorInput');
        if (inp) {
          const mid = inp.getAttribute('data-mid') || state.editingMajorId;
          finishInlineMajorRename(mid, inp.value);
        }
      }
      if (state.editingSubId && !e.target.closest('#inlineSubInput')) {
        const inp = document.getElementById('inlineSubInput');
        if (inp) {
          const sid = inp.getAttribute('data-sid') || inp.getAttribute('data-sub-id') || state.editingSubId;
          finishInlineSubRename(sid, inp.value);
        }
      }
    }, true);

    on('#btnToggleAllSubs', 'click', () => {
      const btn = $('#btnToggleAllSubs');
      if (btn) {
        btn.classList.remove('btn-feedback-pulse');
        void btn.offsetWidth;
        btn.classList.add('btn-feedback-pulse');
      }
      const subs = getCollapsibleSubIdsForCurrentView();
      if (!subs.length) {
        toast('当前视图没有可展开/收起的小分类');
        return;
      }
      const allOpen = subs.every(id => state.expandedSubs.indexOf(id) >= 0);
      if (allOpen) {
        state.expandedSubs = state.expandedSubs.filter(id => subs.indexOf(id) < 0);
      } else {
        subs.forEach(id => { if (state.expandedSubs.indexOf(id) < 0) state.expandedSubs.push(id); });
      }
      renderGrid();
      toast(allOpen ? `📁 已收起当前视图全部 ${subs.length} 个小分类` : `📂 已展开当前视图全部 ${subs.length} 个小分类`);
    });

    on('#fsBadge', 'click', async () => {
      const res = await window.PG_TAG_FS.mountBrowserDirectory();
      if (res.ok) {
        refreshAllFromTree();
        toast(`已挂载本地目录「${res.name || 'tags'}」，页面修改将实时同步到本地文件`);
      } else {
        const conn = await window.PG_TAG_FS.connectExternalFiles();
        if (conn && conn.ok) {
          refreshAllFromTree();
          toast(`已连接本地文件服务 (${conn.base})`);
        } else {
          toast('当前处于外置文件联动模式；如需直写磁盘，请运行「启动标签库服务.bat」或授权本地目录');
        }
      }
    });

    on('#btnTagPkg', 'click', () => openTagPkgModal());

    /* (2.3 Req 6) 手机版屏幕适配：顶部抽屉导航开关与背景遮罩联动（不影响电脑端布局） */
    const closeMobileNav = () => {
      document.body.classList.remove('mobile-nav-open');
      const mb = $('#mobileBackdrop');
      if (mb) mb.hidden = true;
    };
    if (window.innerWidth <= 820) {
      state.rightSidebarOpen = false;
      syncRightSidebarUI();
    }
    let _wasMobileViewport = window.innerWidth <= 820;
    window.addEventListener('resize', () => {
      const isMob = window.innerWidth <= 820;
      if (isMob && !_wasMobileViewport) {
        state.rightSidebarOpen = false;
        syncRightSidebarUI();
      } else if (!isMob && _wasMobileViewport) {
        closeMobileNav();
        state.rightSidebarOpen = true;
        syncRightSidebarUI();
      }
      _wasMobileViewport = isMob;
    });
    on('#btnMobileNavToggle', 'click', () => {
      const open = !document.body.classList.contains('mobile-nav-open');
      if (open && window.innerWidth <= 820 && state.rightSidebarOpen) {
        state.rightSidebarOpen = false;
        syncRightSidebarUI();
      }
      document.body.classList.toggle('mobile-nav-open', open);
      const mb = $('#mobileBackdrop');
      if (mb) mb.hidden = !open;
    });
    on('#btnRightEdgeToggle', 'click', () => {
      if (window.innerWidth <= 820 && state.rightSidebarOpen) {
        closeMobileNav();
      }
    });
    on('#mobileBackdrop', 'click', closeMobileNav);
    if (el.catNav) {
      el.catNav.addEventListener('click', e => {
        const item = e.target.closest('.cat-item[data-cat]');
        if (item && window.innerWidth <= 820) {
          closeMobileNav();
        }
      });
    }


    /* (2.5 & 2.8 Req 3) 主界面多选、合并添加/取消红底、移动与删除事件绑定 */
    on('#btnBatchSelectMode', 'click', () => toggleBatchSelectMode());
    on('#btnBatchExit', 'click', () => toggleBatchSelectMode(false));
    on('#btnBatchSelAll', 'click', () => selectAllVisibleTagsInGrid());
    on('#btnBatchSelInvert', 'click', () => invertVisibleTagsInGrid());
    on('#btnBatchAddToPrompt', 'click', () => batchAddSelectedToPrompt());
    on('#btnBatchCopyEn', 'click', () => copyBatchSelectedTags());
    on('#btnBatchSelClear', 'click', () => clearBatchSelectionOnly());
    $$('#batchActionBar [data-batch-rate]').forEach(btn => {
      btn.addEventListener('click', () => {
        ensureBatchState();
        const items = Array.from(state.batchSelectedMap.values());
        if (!items.length) {
          toast('请先点击或拖拽框选提示词');
          return;
        }
        const r = btn.getAttribute('data-batch-rate');
        setTagsRatingState(items, r);
        syncBatchSelectBarUI();
      });
    });
    on('#btnBatchMove', 'click', openBatchMoveModal);
    on('#btnBatchMoveConfirm', 'click', confirmBatchMoveTags);
    on('#btnBatchDelete', 'click', confirmBatchDeleteTags);
    on('#btnDemoteMajorConfirm', 'click', confirmDemoteMajor);

    /* (2.7 & 2.8 Req 4, 5, 6) 自定义角色与小分类、角色库小分类增删、空分类免二次确认删除、统一人物双列编辑器 */
    function createNewCustomTagCategory() {
      ensureCustomCategoriesStructure();
      let seq = state.customTagCats.length + 1;
      let defaultName = '新增分类' + seq;
      while (state.customTagCats.some(c => c.name === defaultName)) {
        seq++;
        defaultName = '新增分类' + seq;
      }
      const id = 'cust_tag_' + Date.now().toString(36) + '_' + seq;
      state.customTagCats.push({
        id,
        name: defaultName,
        icon: '🏷',
        tags: []
      });
      if (state.expandedSubs.indexOf(id) < 0) state.expandedSubs.push(id);
      state.cat = 'custom';
      state.editingSubId = id;
      refreshAllFromTree();
      save();
      setTimeout(() => {
        const inp = document.getElementById('inlineSubInput');
        if (inp) { inp.focus(); inp.select(); }
      }, 20);
    }
    window.createNewCustomTagCategory = createNewCustomTagCategory;

    function deleteCustomTagSub(tid) {
      ensureCustomCategoriesStructure();
      const tc = (state.customTagCats || []).find(x => x.id === tid);
      if (!tc) return;
      const tagCount = (tc.tags && tc.tags.length) || 0;
      const doDelete = () => {
        recordHistorySnapshot(`删除自定义小分类: ${tc.name}`, true);
        state.customTagCats = state.customTagCats.filter(x => x.id !== tid);
        syncFlatCustomFromTagCats();
        refreshAllFromTree();
        save();
        toast(`已删除自定义小分类「${tc.name}」（可按 Ctrl+Z 撤销）`);
      };
      if (tagCount === 0) {
        doDelete();
      } else {
        askConfirmModal(`确定删除自定义小分类「${tc.name}」及其内部 ${tagCount} 个标签吗？（可按 Ctrl+Z 撤销）`, doDelete);
      }
    }
    window.deleteCustomTagSub = deleteCustomTagSub;

    async function createNewCharLibrarySub(l1Mode) {
      ensureCustomCategoriesStructure();
      const mode = l1Mode || 'games';
      const prefix = mode === 'anime' ? 'anime' : (mode === 'vtuber' ? 'vtuber' : 'game');
      const existingSubs = getCharSubSections(mode);
      let seq = existingSubs.length + 1;
      let defaultName = '新增分类' + seq;
      while (existingSubs.some(s => s.name === defaultName)) {
        seq++;
        defaultName = '新增分类' + seq;
      }
      const id = 'charsub_' + Date.now().toString(36);
      const secId = `char_${prefix}_${id}`;
      if (Array.isArray(state.charDeletedSubs)) {
        state.charDeletedSubs = state.charDeletedSubs.filter(tok => tok !== `${mode}::${id}` && tok !== `${mode}::${defaultName}`);
      }
      state.charCustomSubs.push({ id, name: defaultName, l1Mode: mode });

      const fs = window.PG_TAG_FS;
      if (fs && Array.isArray(fs.charMajors)) {
        let cm = fs.charMajors.find(m => m.id === mode);
        if (!cm) {
          cm = { id: mode, name: mode, icon: '🎮', children: [] };
          fs.charMajors.push(cm);
        }
        cm.children = cm.children || [];
        cm.children.push({ id, name: defaultName, parentId: mode, order: cm.children.length + 1, characters: [] });
        if (fs.mode === 'server-fs' && fs.serverBase) {
          try {
            await fetch(fs.serverBase + '/api/chars/op', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ majors: fs.charMajors })
            });
          } catch (e) {}
        }
      }

      if (state.expandedSubs.indexOf(secId) < 0) state.expandedSubs.push(secId);
      state.editingSubId = secId;
      refreshAllFromTree();
      save();
      setTimeout(() => {
        const inp = document.getElementById('inlineSubInput');
        if (inp) { inp.focus(); inp.select(); }
      }, 20);
    }

    function deleteCharLibrarySub(sid, subName, l1Mode) {
      ensureCustomCategoriesStructure();
      const mode = l1Mode || (state.cat === 'char:anime' ? 'anime' : (state.cat === 'char:vtuber' ? 'vtuber' : 'games'));
      const secs = getCharSubSections(mode);
      const hitSec = secs.find(s => s.id === sid || s.secId === sid || (subName && s.name === subName));
      const finalSid = hitSec ? hitSec.id : sid;
      const finalName = hitSec ? hitSec.name : (subName || sid);
      const charsInSub = hitSec ? (hitSec.chars || []) : [];

      const doDelete = async () => {
        recordHistorySnapshot(`删除角色库小分类: ${finalName}`, true);
        state.charCustomSubs = (state.charCustomSubs || []).filter(s => !(s.l1Mode === mode && (s.id === finalSid || s.name === finalName)));
        if (!Array.isArray(state.charDeletedSubs)) state.charDeletedSubs = [];
        const tok1 = `${mode}::${finalSid}`;
        const tok2 = `${mode}::${finalName}`;
        if (state.charDeletedSubs.indexOf(tok1) < 0) state.charDeletedSubs.push(tok1);
        if (state.charDeletedSubs.indexOf(tok2) < 0) state.charDeletedSubs.push(tok2);

        if (charsInSub.length) {
          const delKeys = new Set(charsInSub.map(c => c.key));
          for (let i = CHARS.length - 1; i >= 0; i--) {
            if (delKeys.has(CHARS[i].key)) {
              const ck = CHARS[i].key;
              CHARS.splice(i, 1);
              if (ck.charAt(0) === 'u') {
                CUSTOM.chars = (CUSTOM.chars || []).filter(x => x.key !== ck);
              } else {
                if (CUSTOM.charDel.indexOf(ck) < 0) CUSTOM.charDel.push(ck);
                delete CUSTOM.charEdit[ck];
              }
              if (state.chars.some(x => x.key === ck)) removeCharacter(ck);
            }
          }
          saveCustom();
        }

        const fs = window.PG_TAG_FS;
        if (fs && Array.isArray(fs.charMajors)) {
          const cm = fs.charMajors.find(m => m.id === mode);
          if (cm && Array.isArray(cm.children)) {
            cm.children = cm.children.filter(c => c.id !== finalSid && c.name !== finalName);
          }
          if (fs.syncCharsFromFlatList) {
            await fs.syncCharsFromFlatList(CHARS);
          } else if (fs.mode === 'server-fs' && fs.serverBase) {
            try {
              await fetch(fs.serverBase + '/api/chars/op', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ majors: fs.charMajors })
              });
            } catch (e) {}
          }
        }
        refreshAllFromTree();
        save();
        toast(`🗑 已删除角色库小分类「${finalName}」（可按 Ctrl+Z 撤销）`);
      };

      // (2.8 Req 4) 内部无角色/无标签时免二次确认直接删除
      if (charsInSub.length === 0) {
        doDelete();
      } else {
        askConfirmModal(`确定删除角色库小分类「${finalName}」及其下属 ${charsInSub.length} 个角色吗？（可按 Ctrl+Z 撤销）`, doDelete);
      }
    }
    window.deleteCharLibrarySub = deleteCharLibrarySub;

    function renderUcAutoTagRows(rowsData) {
      const box = $('#custCharAutoList');
      if (!box) return;
      const list = Array.isArray(rowsData) && rowsData.length ? rowsData.slice() : [{ en: '', zh: '' }, { en: '', zh: '' }, { en: '', zh: '' }];
      while (list.length < 3) list.push({ en: '', zh: '' });
      box.innerHTML = list.map((r, idx) => `
        <div class="uc-tag-row" data-uc-row="${idx}">
          <input type="text" class="input uc-row-en" value="${esc(r.en || '')}" placeholder="英文提示词（如 brown hair）" autocomplete="off" spellcheck="false">
          <span class="uc-row-sep"></span>
          <input type="text" class="input uc-row-zh" value="${esc(r.zh || '')}" placeholder="中文释义（如 棕发）" autocomplete="off">
          <button type="button" class="uc-row-del" data-uc-del-row="${idx}" title="删除此行">×</button>
        </div>
      `).join('');
    }

    function appendUcAutoTagRow(en = '', zh = '') {
      const box = $('#custCharAutoList');
      if (!box) return;
      const div = document.createElement('div');
      div.className = 'uc-tag-row';
      div.innerHTML = `
        <input type="text" class="input uc-row-en" value="${esc(en)}" placeholder="英文提示词（如 brown hair）" autocomplete="off" spellcheck="false">
        <span class="uc-row-sep"></span>
        <input type="text" class="input uc-row-zh" value="${esc(zh)}" placeholder="中文释义（如 棕发）" autocomplete="off">
        <button type="button" class="uc-row-del" data-uc-del-row="1" title="删除此行">×</button>
      `;
      box.appendChild(div);
      const enInp = div.querySelector('.uc-row-en');
      if (enInp) enInp.focus();
    }

    function collectUcAutoTagRows() {
      const box = $('#custCharAutoList');
      if (!box) return [];
      const rows = Array.from(box.querySelectorAll('.uc-tag-row'));
      const out = [];
      rows.forEach(r => {
        const en = String((r.querySelector('.uc-row-en') && r.querySelector('.uc-row-en').value) || '').trim();
        const zh = String((r.querySelector('.uc-row-zh') && r.querySelector('.uc-row-zh').value) || '').trim();
        if (en) out.push({ en, zh: zh || zhLookup(en) || '' });
      });
      return out;
    }

    function openUnifiedCharEditor(opts = {}) {
      ensureCustomCategoriesStructure();
      const editKey = opts.editKey || '';
      const existingChar = editKey ? (findCustomCharByKey(editKey) || CHARS.find(x => x.key === editKey)) : null;
      const scope = opts.scope || (existingChar && existingChar._isCustomChar ? 'custom' : (existingChar ? 'library' : 'custom'));
      const subId = opts.subId || (existingChar ? (existingChar.subId || '') : '');
      const subName = opts.subName || (existingChar ? (existingChar.game || existingChar.subName || '') : (scope === 'custom' ? '自定义角色' : ''));

      if ($('#custCharEditKey')) $('#custCharEditKey').value = existingChar ? existingChar.key : '';
      if ($('#custCharTargetScope')) $('#custCharTargetScope').value = scope;
      if ($('#custCharTargetSubId')) $('#custCharTargetSubId').value = subId;
      if ($('#custCharTargetSubName')) $('#custCharTargetSubName').value = subName;

      if ($('#custCharModalTitle')) {
        if (existingChar) {
          $('#custCharModalTitle').textContent = `✎ 编辑角色信息：${existingChar.name}`;
        } else if (scope === 'library' && subName) {
          $('#custCharModalTitle').textContent = `🧝 新增人物到「${subName}」`;
        } else {
          $('#custCharModalTitle').textContent = '🧝 新增自定义人物';
        }
      }
      if ($('#custCharName')) $('#custCharName').value = existingChar ? (existingChar.name || '') : '';
      if ($('#custCharTag')) $('#custCharTag').value = existingChar ? (existingChar.tag || '') : '';
      if ($('#custCharDesc')) {
        const curDesc = existingChar ? (existingChar.desc || (state.charDescMap && state.charDescMap[existingChar.key]) || '') : '';
        $('#custCharDesc').value = curDesc;
      }

      const autoList = existingChar && Array.isArray(existingChar.auto)
        ? existingChar.auto.map(a => ({ en: a.en || '', zh: a.zh || zhLookup(a.en) || '' }))
        : [];
      renderUcAutoTagRows(autoList);

      openModal('modalCustomCharEditor');
      setTimeout(() => { if ($('#custCharName')) $('#custCharName').focus(); }, 20);
    }
    window.openUnifiedCharEditor = openUnifiedCharEditor;

    function saveUnifiedCharFromModal() {
      ensureCustomCategoriesStructure();
      const editKey = ($('#custCharEditKey') && $('#custCharEditKey').value || '').trim();
      const scope = ($('#custCharTargetScope') && $('#custCharTargetScope').value) || 'custom';
      const subId = ($('#custCharTargetSubId') && $('#custCharTargetSubId').value) || '';
      const subName = ($('#custCharTargetSubName') && $('#custCharTargetSubName').value) || '自定义角色';
      const name = ($('#custCharName') && $('#custCharName').value || '').trim();
      const tag = ($('#custCharTag') && $('#custCharTag').value || '').trim();
      const desc = ($('#custCharDesc') && $('#custCharDesc').value || '').replace(/\s+/g, ' ').trim();
      const auto = collectUcAutoTagRows();

      if (!name) { toast('请输入角色名称'); return; }

      if (scope === 'custom') {
        const key = editKey || ('custchar_' + Date.now().toString(36));
        const idx = state.customChars.findIndex(x => x.key === key);
        const charObj = {
          key,
          name,
          game: '自定义角色',
          tag,
          charZh: name,
          desc,
          auto
        };
        if (idx >= 0) state.customChars[idx] = charObj;
        else state.customChars.push(charObj);
        if (desc) state.charDescMap[key] = desc;
        else delete state.charDescMap[key];
        if (state.expandedSubs.indexOf('cust_char_sec') < 0) state.expandedSubs.push('cust_char_sec');
      } else {
        const l1Mode = (state.cat === 'char:anime' ? 'anime' : (state.cat === 'char:vtuber' ? 'vtuber' : 'games'));
        const prefix = l1Mode === 'anime' ? 'anime' : (l1Mode === 'vtuber' ? 'vtuber' : 'game');
        if (editKey) {
          const c = CHARS.find(x => x.key === editKey);
          if (c) {
            c.name = name;
            c.tag = tag;
            c.charZh = `${name}（${c.game || subName}）`;
            c.desc = desc;
            c.auto = auto;
            c.isNew = true;
            if (state.seenNewCharsSet instanceof Set) {
              state.seenNewCharsSet.delete(c.key);
              state.seenNewChars = Array.from(state.seenNewCharsSet);
            }
            if (desc) state.charDescMap[c.key] = desc;
            else delete state.charDescMap[c.key];
            if (c.key.charAt(0) === 'u') {
              const u = CUSTOM.chars.find(x => x.key === c.key);
              if (u) { u.name = name; u.tag = tag; u.charZh = c.charZh; desc && (u.desc = desc); u.auto = tagText(auto); }
            } else {
              CUSTOM.charEdit[c.key] = { name, game: c.game, tag, charZh: c.charZh, desc, auto: tagText(auto) };
            }
            saveCustom();
          }
        } else {
          const key = 'u' + Date.now().toString(36);
          const gameLabel = subName || '其他游戏';
          const charZh = `${name}（${gameLabel}）`;
          const newChar = {
            key,
            name,
            game: gameLabel,
            gameTag: subId || gameLabel,
            majorId: l1Mode,
            subId: subId || safeId(gameLabel),
            subName: gameLabel,
            tag,
            charZh,
            desc,
            auto,
            custom: true,
            isNew: true
          };
          if (desc) state.charDescMap[key] = desc;
          if (Array.isArray(state.charDeletedSubs)) {
            state.charDeletedSubs = state.charDeletedSubs.filter(tok => tok !== `${l1Mode}::${newChar.subId}` && tok !== `${l1Mode}::${gameLabel}`);
          }
          CUSTOM.chars.push({ key, name, game: gameLabel, majorId: l1Mode, subId: newChar.subId, tag, charZh, desc, auto: tagText(auto) });
          CHARS.push(newChar);
          saveCustom();
          const secId = `char_${prefix}_${newChar.subId}`;
          if (state.expandedSubs.indexOf(secId) < 0) state.expandedSubs.push(secId);
        }
        if (window.PG_TAG_FS && window.PG_TAG_FS.syncCharsFromFlatList) {
          window.PG_TAG_FS.syncCharsFromFlatList(CHARS);
        }
      }

      if (tag) idxAdd(tag, name, desc);
      auto.forEach(t => idxAdd(t.en, t.zh));

      if (editKey) {
        const hitIdx = (state.chars || []).findIndex(x => x.key === editKey);
        if (hitIdx >= 0) {
          state.chars[hitIdx].name = name;
          state.chars[hitIdx].tag = tag;
        }
      }

      closeModal('modalCustomCharEditor');
      refreshAllFromTree();
      save();
      toast(`✅ 已保存角色「${name}」`);
    }

    on('#btnCustCharSave', 'click', saveUnifiedCharFromModal);
    on('#btnUcAddTagRow', 'click', () => appendUcAutoTagRow('', ''));
    on('#custCharAutoList', 'click', e => {
      const delBtn = e.target.closest('[data-uc-del-row]');
      if (!delBtn) return;
      const row = delBtn.closest('.uc-tag-row');
      const box = $('#custCharAutoList');
      if (row && box) {
        if (box.querySelectorAll('.uc-tag-row').length <= 1) {
          row.querySelectorAll('input').forEach(inp => { inp.value = ''; });
        } else {
          row.remove();
        }
      }
    });

    // Custom & Character Library section events in el.grid
    el.grid.addEventListener('click', e => {
      const custCharAct = e.target.closest('[data-cust-char-act]');
      if (custCharAct) {
        e.stopPropagation();
        const act = custCharAct.getAttribute('data-cust-char-act');
        if (act === 'add') {
          openUnifiedCharEditor({ scope: 'custom' });
        } else if (act === 'clear') {
          if (!state.customChars || !state.customChars.length) {
            toast('当前暂无自定义角色');
            return;
          }
          askConfirmModal(`确定清空全部 ${state.customChars.length} 个自定义角色吗？`, () => {
            recordHistorySnapshot('清空自定义角色');
            state.customChars = [];
            refreshAllFromTree();
            save();
            toast('已清空自定义角色');
          });
        }
        return;
      }
      const custAct = e.target.closest('[data-cust-act]');
      if (custAct) {
        e.stopPropagation();
        const act = custAct.getAttribute('data-cust-act');
        if (act === 'add-tag-cat') createNewCustomTagCategory();
        return;
      }
      const delTagCatBtn = e.target.closest('[data-cust-tag-del]');
      if (delTagCatBtn) {
        e.stopPropagation();
        deleteCustomTagSub(delTagCatBtn.getAttribute('data-cust-tag-del'));
        return;
      }
      const charSubAddBtn = e.target.closest('[data-char-sub-add]');
      if (charSubAddBtn) {
        e.stopPropagation();
        openUnifiedCharEditor({
          scope: 'library',
          subId: charSubAddBtn.getAttribute('data-char-sub-add'),
          subName: charSubAddBtn.getAttribute('data-char-sub-name'),
          l1Mode: charSubAddBtn.getAttribute('data-char-l1')
        });
        return;
      }
      const charSubDelBtn = e.target.closest('[data-char-sub-del]');
      if (charSubDelBtn) {
        e.stopPropagation();
        deleteCharLibrarySub(
          charSubDelBtn.getAttribute('data-char-sub-del'),
          charSubDelBtn.getAttribute('data-char-sub-name') || '',
          charSubDelBtn.getAttribute('data-char-l1') || 'games'
        );
        return;
      }
      const charAddSubBottom = e.target.closest('[data-char-add-sub]');
      if (charAddSubBottom) {
        e.stopPropagation();
        createNewCharLibrarySub(charAddSubBottom.getAttribute('data-char-add-sub'));
        return;
      }
    });

    // Double-click custom or character subcategory header to rename
    el.grid.addEventListener('dblclick', e => {
      const head = e.target.closest('.sub-sec-head[data-toggle-sub]');
      if (!head) return;
      const sid = head.getAttribute('data-toggle-sub');
      if (sid && (sid.indexOf('cust_tag_') === 0 || sid.indexOf('char_') === 0)) {
        e.stopPropagation();
        state.editingSubId = sid;
        renderGrid();
        setTimeout(() => { const inp = $('#inlineSubInput'); if (inp) { inp.focus(); inp.select(); } }, 20);
      }
    });

    /* (2.6 Req 6 & 2.7 Req 3, Req 5) 鼠标停留在中间 tag、侧边栏 tag、以及角色库/自定义角色大图标上显示介绍或中文 */
    (function initTagHoverTooltip() {
      const tipEl = $('#tagHoverTooltip');
      if (!tipEl) return;
      const showTipForTarget = (targetEl) => {
        if (!targetEl) {
          tipEl.hidden = true;
          return;
        }
        let text = '';
        if (targetEl.classList.contains('chip') && targetEl.dataset.en) {
          text = getTagHoverTip({ en: targetEl.dataset.en }, targetEl.dataset.sub || '');
        } else if (targetEl.classList.contains('char-big-card') && targetEl.dataset.char) {
          const c = CHARS.find(x => x.key === targetEl.dataset.char) || findCustomCharByKey(targetEl.dataset.char);
          text = getCharHoverTip(c);
        } else if (targetEl.dataset.hoverTip) {
          text = targetEl.dataset.hoverTip;
        }
        text = String(text || '').replace(/\s+/g, ' ').trim();
        if (!text) {
          tipEl.hidden = true;
          return;
        }
        targetEl.title = text;
        tipEl.textContent = text;
        tipEl.hidden = false;
        const r = targetEl.getBoundingClientRect();
        const left = Math.max(8, Math.min(r.left, window.innerWidth - 360));
        const top = (r.top > 42) ? (r.top - 34) : (r.bottom + 6);
        tipEl.style.left = left + 'px';
        tipEl.style.top = top + 'px';
      };

      [el.grid, el.selList].forEach(container => {
        if (!container) return;
        container.addEventListener('mouseover', e => {
          if (e.target.closest('button[data-act], button[data-char-act-row], .sub-head-btn, .cbc-remove-btn')) {
            tipEl.hidden = true;
            return;
          }
          const hit = e.target.closest('.chip[data-en], .char-big-card[data-char], .sel-item[data-hover-tip]');
          showTipForTarget(hit);
        });
        container.addEventListener('mouseout', e => {
          const hit = e.target.closest('.chip[data-en], .char-big-card[data-char]');
          if (hit && !hit.contains(e.relatedTarget)) {
            tipEl.hidden = true;
          }
        });
        container.addEventListener('scroll', () => { tipEl.hidden = true; }, { passive: true });
      });
    })();


    /* ===== V1.3.8 Req 4: a1111-sd-webui-tagcomplete 风格实时联想补全与 Danbooru 别名自动规范化 ===== */
    (function initTagCompleteAutocomplete() {
      const dd = $('#acDropdown');
      if (!dd) return;
      const targetSels = ['#search', '#output', '#addIn', '#subAddSingleEn'];
      let activeInput = null;
      let acItems = [];
      let acIdx = 0;

      const hideAc = () => {
        dd.hidden = true;
        acItems = [];
        acIdx = 0;
      };

      const getTokenBounds = (inp) => {
        const val = String(inp.value || '');
        const pos = typeof inp.selectionStart === 'number' ? inp.selectionStart : val.length;
        if (inp.id === 'search' || inp.id === 'subAddSingleEn') {
          return { start: 0, end: val.length, token: val.trim() };
        }
        const before = val.slice(0, pos);
        const lastSep = Math.max(before.lastIndexOf(','), before.lastIndexOf('，'), before.lastIndexOf('\n'));
        const start = lastSep + 1;
        const after = val.slice(pos);
        const nextComma = after.search(/[,，\n]/);
        const end = nextComma >= 0 ? (pos + nextComma) : val.length;
        return { start, end, token: val.slice(start, pos).trim() };
      };

      const queryAc = (rawTok) => {
        const tok = String(rawTok || '').trim();
        if (tok.length < 2) return [];
        const lower = tok.toLowerCase();
        const under = lower.replace(/\s+/g, '_');
        const amap = window.__EXT_ALIAS_MAP__ || {};
        const fdict = window.__EXT_FULL_DICT__ || {};
        const out = [];
        const seen = new Set();

        const pushItem = (en, zh, cnt, aliasFrom) => {
          const k = en.toLowerCase();
          if (seen.has(k)) return;
          const rLv = (typeof getTagRating === 'function') ? getTagRating(en) : 'g';
          if (!state.nsfw && (rLv === 'q' || rLv === 'e')) return;
          seen.add(k);
          out.push({ en, zh: zh || zhLookup(en) || '', cnt: Number(cnt) || 0, aliasFrom: aliasFrom || '' });
        };

        // 1. Exact Danbooru alias check (e.g. twintail -> twintails)
        const canonRaw = amap[under] || amap[lower];
        if (canonRaw && String(canonRaw).toLowerCase() !== under) {
          const canonEn = String(canonRaw).replace(/_/g, ' ');
          const frow = fdict[canonRaw] || fdict[canonEn.replace(/\s+/g, '_')];
          pushItem(canonEn, frow ? frow[0] : '', frow ? frow[2] : 999999, tok);
        }

        // 2. Exact match in full dict
        if (fdict[under]) {
          const row = fdict[under];
          pushItem(row[1] === 1 ? ('@' + under.replace(/_/g, ' ')) : under.replace(/_/g, ' '), row[0], row[2], '');
        }

        // 3. Full relevance-ranked candidates (matching search relevance: exact > prefix/head-noun > whole word > substring, shorter & higher-count first)
        const acScore = (enStr, zhStr, kwStr, cntNum) => {
          const eL = String(enStr || '').toLowerCase().replace(/^@/, '');
          const zL = String(zhStr || '').toLowerCase();
          const kL = String(kwStr || '').toLowerCase();
          const qL = lower;
          const cntBonus = Math.min(40, Math.log10((Number(cntNum) || 0) + 1) * 6);
          if (eL === qL || zL === qL) return 10000 + cntBonus;
          if (eL.startsWith(qL + ' ') || eL.startsWith(qL + '_')) return 8500 - eL.length * 4 + cntBonus;
          if (eL.endsWith(' ' + qL) || eL.endsWith('_' + qL)) return 8000 - eL.length * 4 + cntBonus;
          if (eL.startsWith(qL)) return 7000 - eL.length * 4 + cntBonus;
          const words = eL.split(/[\s_()/-]+/).filter(Boolean);
          if (words.indexOf(qL) >= 0) return 6200 - eL.length * 3 + cntBonus;
          if (zL && zL.startsWith(qL)) return 5800 - zL.length * 4 + cntBonus;
          if (zL && zL.includes(qL)) return 4800 - zL.length * 3 + cntBonus;
          if (eL.includes(qL)) return 3600 - eL.length * 2 + cntBonus;
          if (kL && kL.includes(qL)) return 2400 + cntBonus;
          return 1000 + cntBonus;
        };

        const cands = [];
        const isAscii = /^[\x00-\x7f]+$/.test(lower);
        // Also scan local curated TAG_INDEX first so core library terms are never missed
        if (typeof TAG_INDEX !== 'undefined' && TAG_INDEX && TAG_INDEX.forEach) {
          TAG_INDEX.forEach((v, k) => {
            const enStr = (v && v.en) || k;
            const zhStr = (v && v.zh) || '';
            const eL = enStr.toLowerCase();
            const match = isAscii ? eL.includes(lower) : (zhStr && zhStr.includes(tok));
            if (match) {
              const fk = eL.replace(/\s+/g, '_');
              const frow = fdict[fk];
              cands.push({ en: enStr, zh: zhStr || (frow ? frow[0] : ''), kw: frow ? (frow[4] || '') : '', cnt: frow ? (Number(frow[2]) || 0) : 5000 });
            }
          });
        }
        for (const fk in fdict) {
          const row = fdict[fk];
          const zhStr = row[0] || '';
          const match = isAscii
            ? (fk === under || fk.startsWith(under) || fk.endsWith('_' + under) || (under.length >= 3 && fk.includes(under)))
            : (zhStr && zhStr.includes(tok));
          if (match) {
            const sp = fk.replace(/_/g, ' ');
            const enOut = row[1] === 1 ? ('@' + sp) : sp;
            cands.push({ en: enOut, zh: zhStr, kw: row[4] || '', cnt: Number(row[2]) || 0 });
            if (cands.length >= 1200) break;
          }
        }
        cands.forEach(c => { c._sc = acScore(c.en, c.zh, c.kw, c.cnt); });
        cands.sort((a, b) => (b._sc - a._sc) || (a.en.length - b.en.length) || (b.cnt - a.cnt));
        for (const c of cands) {
          if (out.length >= 12) break;
          pushItem(c.en, c.zh, c.cnt, '');
        }
        return out;
      };

      const renderAc = () => {
        if (!activeInput || !acItems.length) { hideAc(); return; }
        const rect = activeInput.getBoundingClientRect();
        dd.innerHTML = acItems.map((it, idx) => `
          <div class="ac-item${idx === acIdx ? ' active' : ''}" data-ac-idx="${idx}">
            <span class="ac-en">${esc(it.en)}</span>
            ${it.aliasFrom ? `<span class="ac-alias">${esc(it.aliasFrom)} → 标准词</span>` : ''}
            <span class="ac-zh">${esc(it.zh)}</span>
            ${it.cnt > 0 ? `<span class="ac-cnt">${it.cnt >= 1000 ? (it.cnt / 1000).toFixed(1) + 'k' : it.cnt}</span>` : ''}
          </div>
        `).join('');
        dd.hidden = false;
        const ddW = Math.min(420, Math.max(260, rect.width));
        dd.style.width = ddW + 'px';
        dd.style.left = Math.min(window.innerWidth - ddW - 10, Math.max(8, rect.left)) + 'px';
        const belowSpace = window.innerHeight - rect.bottom;
        if (belowSpace < 220 && rect.top > 240) {
          dd.style.top = Math.max(8, rect.top - Math.min(290, dd.scrollHeight) - 6) + 'px';
        } else {
          dd.style.top = (rect.bottom + 4) + 'px';
        }
      };

      const acceptAcItem = (idx) => {
        const it = acItems[idx];
        if (!it || !activeInput) return;
        const b = getTokenBounds(activeInput);
        const val = String(activeInput.value || '');
        if (activeInput.id === 'search' || activeInput.id === 'subAddSingleEn') {
          activeInput.value = it.en;
        } else {
          const prefix = val.slice(0, b.start);
          const pad = (prefix && !/[\s\n]$/.test(prefix)) ? ' ' : '';
          const suffix = val.slice(b.end);
          activeInput.value = prefix + pad + it.en + (suffix ? suffix : ', ');
        }
        if (it.aliasFrom) {
          toast(`✨ 别名已规范化：${it.aliasFrom} → ${it.en}`);
        }
        hideAc();
        activeInput.dispatchEvent(new Event('input', { bubbles: true }));
        activeInput.focus();
      };

      dd.addEventListener('mousedown', e => {
        const row = e.target.closest('[data-ac-idx]');
        if (!row) return;
        e.preventDefault();
        acceptAcItem(Number(row.getAttribute('data-ac-idx')));
      });

      let acTimer = null;
      targetSels.forEach(sel => {
        const inp = $(sel);
        if (!inp || inp._acBound) return;
        inp._acBound = true;
        inp.addEventListener('input', () => {
          activeInput = inp;
          if (acTimer) clearTimeout(acTimer);
          acTimer = setTimeout(() => {
            const b = getTokenBounds(inp);
            acItems = queryAc(b.token);
            acIdx = 0;
            renderAc();
          }, 90);
        });
        inp.addEventListener('keydown', e => {
          if (dd.hidden || !acItems.length) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            acIdx = (acIdx + 1) % acItems.length;
            renderAc();
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            acIdx = (acIdx - 1 + acItems.length) % acItems.length;
            renderAc();
          } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.ctrlKey && !e.metaKey)) {
            e.preventDefault();
            acceptAcItem(acIdx);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            hideAc();
          }
        });
        inp.addEventListener('blur', () => {
          setTimeout(() => {
            if (document.activeElement !== inp) hideAc();
          }, 140);
        });
      });

      document.addEventListener('mousedown', e => {
        if (!dd.hidden && !e.target.closest('#acDropdown') && e.target !== activeInput) hideAc();
      }, true);
    })();

    /* (2.8 Req 2 & 2.7 Req 8) 鼠标左键拖拽矩形框选：修复框选失效，严格限制在中间 #tagGrid 范围内且全程禁止选中文字 */
    (function initMarqueeSelection() {
      let isDown = false;
      let isDragging = false;
      let wasBatchModeBeforeDrag = false;
      let startX = 0, startY = 0, startScrollTop = 0;
      let lastClientX = 0, lastClientY = 0;
      let appendMode = false;
      let preDragSelectedMap = null;
      let autoScrollRaf = 0;

      const getBoxEl = () => {
        let b = document.getElementById('tagMarqueeBox');
        if (!b) {
          b = document.createElement('div');
          b.id = 'tagMarqueeBox';
          b.className = 'tag-marquee-box';
          b.hidden = true;
          document.body.appendChild(b);
        }
        return b;
      };

      const stopAutoScroll = () => {
        if (autoScrollRaf) {
          cancelAnimationFrame(autoScrollRaf);
          autoScrollRaf = 0;
        }
      };

      const updateMarqueeRectAndHitTest = () => {
        if (!isDragging) return;
        const bounds = el.grid.getBoundingClientRect();
        const curX = clamp(lastClientX, bounds.left, bounds.right);
        const curY = clamp(lastClientY, bounds.top, bounds.bottom);
        const scrollDelta = el.grid.scrollTop - startScrollTop;
        const anchorY = startY - scrollDelta;
        const visStartY = clamp(anchorY, bounds.top, bounds.bottom);
        const cStartX = clamp(startX, bounds.left, bounds.right);

        const left = Math.min(cStartX, curX);
        const right = Math.max(cStartX, curX);
        const visTop = Math.min(visStartY, curY);
        const visBottom = Math.max(visStartY, curY);

        const boxEl = getBoxEl();
        if (boxEl) {
          boxEl.hidden = false;
          boxEl.style.left = left + 'px';
          boxEl.style.top = visTop + 'px';
          boxEl.style.width = Math.max(0, right - left) + 'px';
          boxEl.style.height = Math.max(0, visBottom - visTop) + 'px';
        }

        // Hit-test using full scrolled range (anchorY .. curY) so tags scrolled past remain selected!
        const hitTop = Math.min(anchorY, curY);
        const hitBottom = Math.max(anchorY, curY);
        const barEl = document.getElementById('batchActionBar');
        const deferBar = !!(barEl && barEl.hidden);
        boxSelectTagsInRect(left, hitTop, right, hitBottom, appendMode, deferBar, preDragSelectedMap);
      };

      const autoScrollTick = () => {
        if (!isDown || !isDragging) {
          autoScrollRaf = 0;
          return;
        }
        const bounds = el.grid.getBoundingClientRect();
        const edgeZone = 52;
        let delta = 0;
        if (lastClientY >= bounds.bottom - edgeZone) {
          const dist = Math.min(80, lastClientY - (bounds.bottom - edgeZone) + 6);
          delta = Math.max(4, Math.ceil(dist * 0.35));
        } else if (lastClientY <= bounds.top + edgeZone && el.grid.scrollTop > 0) {
          const dist = Math.min(80, (bounds.top + edgeZone) - lastClientY + 6);
          delta = -Math.max(4, Math.ceil(dist * 0.35));
        }
        if (delta !== 0) {
          const prev = el.grid.scrollTop;
          el.grid.scrollTop += delta;
          if (el.grid.scrollTop !== prev) {
            updateMarqueeRectAndHitTest();
          }
        }
        autoScrollRaf = requestAnimationFrame(autoScrollTick);
      };

      el.grid.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        if (e.target.closest('.sub-sec-head, .char-big-card, .chip-add, .chip-del-x, [data-clear-sub-sec], .content-foot-bar, input, select, textarea, button:not(.chip)')) return;
        const bounds = el.grid.getBoundingClientRect();
        if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) return;
        isDown = true;
        isDragging = false;
        wasBatchModeBeforeDrag = !!state.batchSelectMode;
        startX = clamp(e.clientX, bounds.left, bounds.right);
        startY = clamp(e.clientY, bounds.top, bounds.bottom);
        startScrollTop = el.grid.scrollTop;
        lastClientX = e.clientX;
        lastClientY = e.clientY;
        appendMode = !!(e.shiftKey || e.ctrlKey || e.metaKey);
        preDragSelectedMap = appendMode ? new Map(state.batchSelectedMap) : null;
      });

      window.addEventListener('mousemove', e => {
        if (!isDown) return;
        lastClientX = e.clientX;
        lastClientY = e.clientY;
        const bounds = el.grid.getBoundingClientRect();
        const curX = clamp(e.clientX, bounds.left, bounds.right);
        const curY = clamp(e.clientY, bounds.top, bounds.bottom);
        const dx = curX - startX;
        const dy = curY - startY;
        if (!isDragging && Math.hypot(dx, dy) > 5) {
          isDragging = true;
          document.body.classList.add('is-marquee-dragging');
          if (!autoScrollRaf) autoScrollRaf = requestAnimationFrame(autoScrollTick);
        }
        if (!isDragging) return;
        e.preventDefault();
        if (window.getSelection) {
          try { window.getSelection().removeAllRanges(); } catch (err) {}
        }
        updateMarqueeRectAndHitTest();
      });

      window.addEventListener('mouseup', () => {
        if (!isDown) return;
        isDown = false;
        stopAutoScroll();
        document.body.classList.remove('is-marquee-dragging');
        if (isDragging) {
          isDragging = false;
          const boxEl = getBoxEl();
          if (boxEl) boxEl.hidden = true;
          if (window.getSelection) {
            try { window.getSelection().removeAllRanges(); } catch (err) {}
          }
          window._justMarqueeEnded = true;
          setTimeout(() => { window._justMarqueeEnded = false; }, 80);
          // V1.0 Req 3: 框选没有选中不进入选择模式
          if (state.batchSelectedMap.size > 0) {
            state.batchSelectMode = true;
            syncBatchSelectBarUI(false);
          } else if (!wasBatchModeBeforeDrag) {
            state.batchSelectMode = false;
            syncBatchSelectBarUI(false);
          } else {
            syncBatchSelectBarUI(false);
          }
        }
      });
    })();

    /* (2.5 Req 4 & Req 5) 标签导入工坊 3 步工作台与暂存库事件绑定 */
    on('#btnTagImport', 'click', () => openImportStudio());
    on('#tsSteps', 'click', e => {
      const btn = e.target.closest('button[data-ts-step]');
      if (!btn) return;
      switchImpStep(Number(btn.getAttribute('data-ts-step')) || 1);
    });
    on('#impInput', 'input', () => {
      detectAndSetupImpGrid();
    });
    /* (V1.0 Req 1) 右上角「📦 JSON 识别」按钮与文件选择事件 */
    on('#btnImpJsonDetect', 'click', () => {
      const raw = (($('#impInput') && $('#impInput').value) || '').trim();
      if (raw && (raw.startsWith('{') || raw.startsWith('['))) {
        importJsonToStaging(raw, '粘贴 JSON 数据');
        return;
      }
      const fInp = $('#fImpJsonPkg');
      if (fInp) fInp.click();
    });
    on('#fImpJsonPkg', 'change', e => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        const txt = String(r.result || '');
        if ($('#impInput')) $('#impInput').value = txt;
        importJsonToStaging(txt, f.name);
      };
      r.readAsText(f, 'utf-8');
      e.target.value = '';
    });
    on('#impFallbackMajorSel', 'change', e => {
      const majId = e.target.value;
      const subSel = $('#impFallbackSel');
      if (subSel) {
        subSel.innerHTML = buildSubOptionsForMajorHtml(majId, '');
      }
      rebuildImpLayoutPairs();
    });
    on('#impTargetMajorSel2', 'change', e => {
      const majId = e.target.value;
      const subSel = $('#impTargetSubSel2');
      if (subSel) {
        subSel.innerHTML = buildSubOptionsForMajorHtml(majId, '');
      }
      const newSub = subSel ? subSel.value : '';
      if (newSub && _impColPairs.length) {
        _impColPairs.forEach(p => { p.subId = newSub; });
        renderImpLayoutCfg();
      }
    });
    on('#impTargetSubSel2', 'change', e => {
      const newSub = e.target.value;
      if (newSub && _impColPairs.length) {
        _impColPairs.forEach(p => { p.subId = newSub; });
        renderImpLayoutCfg();
      }
    });
    on('#btnImpApplyTargetAll', 'click', () => {
      const targetSub = ($('#impTargetSubSel2') && $('#impTargetSubSel2').value) || '';
      if (!targetSub) return;
      _impColPairs.forEach(p => { p.subId = targetSub; });
      renderImpLayoutCfg();
      toast(`已将全部列目标分类设为：${ getSubDisplayInfo(targetSub).fullName }`);
    });
    on('#stageEditMajorSel', 'change', e => {
      const majId = e.target.value;
      const subSel = $('#stageEditSubSel');
      if (subSel) {
        subSel.innerHTML = buildSubOptionsForMajorHtml(majId, '');
      }
    });
    ['#impSelLayout', '#impColRole1', '#impColRole2', '#impColRole3', '#impTitleRow', '#impDataStart', '#impFallbackSel'].forEach(q => {
      on(q, 'change', rebuildImpLayoutPairs);
    });
    on('#impCfgWide', 'change', e => {
      const onChk = e.target.closest('[data-imp-pair-on]');
      if (onChk) {
        const idx = +onChk.getAttribute('data-imp-pair-on');
        if (_impColPairs[idx]) _impColPairs[idx].enabled = onChk.checked;
      }
      const majSel = e.target.closest('[data-imp-pair-major]');
      if (majSel) {
        const idx = +majSel.getAttribute('data-imp-pair-major');
        const majId = majSel.value;
        const rowEl = majSel.closest('.ts-pair');
        const subSel = rowEl && rowEl.querySelector('[data-imp-pair-sub]');
        if (subSel) {
          subSel.innerHTML = buildSubOptionsForMajorHtml(majId, '');
          if (_impColPairs[idx]) _impColPairs[idx].subId = subSel.value;
        }
        return;
      }
      const subSel = e.target.closest('[data-imp-pair-sub]');
      if (subSel) {
        const idx = +subSel.getAttribute('data-imp-pair-sub');
        if (_impColPairs[idx]) _impColPairs[idx].subId = subSel.value;
      }
    });
    on('#btnImpParse', 'click', parseImport);
    on('#btnImpGoPreview', 'click', parseImport);

    on('#impSelFilter', 'change', () => { _impPrevPage = 0; renderImpPrecheck(); });
    on('#impPrevSearch', 'input', () => { _impPrevPage = 0; renderImpPrecheck(); });
    on('#btnImpSelAll', 'click', () => {
      getFilteredImpPrecheck().forEach(r => { if (r.status !== 'bad') r.checked = true; });
      renderImpPrecheck();
    });
    on('#btnImpSelNone', 'click', () => {
      getFilteredImpPrecheck().forEach(r => { r.checked = false; });
      renderImpPrecheck();
    });
    on('#btnImpMoveAllOther', 'click', () => {
      let c = 0;
      _impPrecheck.forEach(r => {
        if (r.status === 'other') {
          r.moveFromOther = true;
          r.checked = true;
          c++;
        }
      });
      renderImpPrecheck();
      toast(`已将 ${c} 条跨分类重复标签设为移动至目标分类`);
    });
    on('#impPrevPager', 'click', e => {
      const b = e.target.closest('button[data-imp-page]');
      if (!b) return;
      _impPrevPage += Number(b.getAttribute('data-imp-page')) || 0;
      renderImpPrecheck();
    });
    on('#btnImpToStash', 'click', addImpToStash);

    const impBody = $('#impPrecheckBody');
    if (impBody) {
      impBody.addEventListener('change', e => {
        const ck = e.target.closest('[data-imp-check]');
        if (ck) {
          const id = +ck.getAttribute('data-imp-check');
          const row = _impPrecheck.find(x => x.id === id);
          if (row) row.checked = ck.checked;
          renderImpPrecheck();
          return;
        }
        const mvCk = e.target.closest('[data-imp-move-other]');
        if (mvCk) {
          const id = +mvCk.getAttribute('data-imp-move-other');
          const row = _impPrecheck.find(x => x.id === id);
          if (row) {
            row.moveFromOther = mvCk.checked;
            if (mvCk.checked) row.checked = true;
          }
          renderImpPrecheck();
          return;
        }
        const grpMaj = e.target.closest('[data-imp-grp-major]');
        if (grpMaj) {
          const id = +grpMaj.getAttribute('data-imp-grp-major');
          const majId = grpMaj.value;
          const tr = grpMaj.closest('tr');
          const subSel = tr && tr.querySelector('[data-imp-grp]');
          if (subSel) {
            subSel.innerHTML = buildSubOptionsForMajorHtml(majId, '');
            const row = _impPrecheck.find(x => x.id === id);
            if (row) row.subId = subSel.value;
          }
          return;
        }
        const grp = e.target.closest('[data-imp-grp]');
        if (grp) {
          const id = +grp.getAttribute('data-imp-grp');
          const row = _impPrecheck.find(x => x.id === id);
          if (row) row.subId = grp.value;
        }
      });
      impBody.addEventListener('input', e => {
        const enInp = e.target.closest('[data-imp-en]');
        const zhInp = e.target.closest('[data-imp-zh]');
        if (enInp) {
          const id = +enInp.getAttribute('data-imp-en');
          const row = _impPrecheck.find(x => x.id === id);
          if (row) row.en = enInp.value;
        }
        if (zhInp) {
          const id = +zhInp.getAttribute('data-imp-zh');
          const row = _impPrecheck.find(x => x.id === id);
          if (row) row.zh = zhInp.value;
        }
        const descInp = e.target.closest('[data-imp-desc]');
        if (descInp) {
          const id = +descInp.getAttribute('data-imp-desc');
          const row = _impPrecheck.find(x => x.id === id);
          if (row) row.desc = descInp.value;
        }
      });
      impBody.addEventListener('click', e => {
        const del = e.target.closest('[data-imp-del]');
        if (!del) return;
        const id = +del.getAttribute('data-imp-del');
        _impPrecheck = _impPrecheck.filter(x => x.id !== id);
        updateImpStepBadges();
        renderImpPrecheck();
      });
    }

    on('#btnStageSelectMode', 'click', () => {
      _stageSelectMode = !_stageSelectMode;
      if (!_stageSelectMode) {
        _stageSelectedTags.clear();
        _stageSelectedSubs.clear();
        _stageSelectedMajors.clear();
      }
      renderImpStash();
    });
    on('#btnStageSelAll', 'click', () => {
      _stageSelectMode = true;
      (_impStage.groups || []).forEach(g => {
        const info = getSubDisplayInfo(g.id, g);
        _stageSelectedMajors.add(info.majorId);
        _stageSelectedSubs.add(g.id);
        (g.tags || []).forEach((_, ti) => _stageSelectedTags.add(`${g.id}::${ti}`));
      });
      renderImpStash();
    });
    on('#btnStageSelNone', 'click', () => {
      _stageSelectedTags.clear();
      _stageSelectedSubs.clear();
      _stageSelectedMajors.clear();
      renderImpStash();
    });
    on('#btnStageSelDups', 'click', () => {
      const existMap = buildExistingTagLookup(true);
      const stageFreq = new Map();
      (_impStage.groups || []).forEach(g => {
        (g.tags || []).forEach(t => {
          const k = normImpTagKey(t.en);
          if (k) stageFreq.set(k, (stageFreq.get(k) || 0) + 1);
        });
      });
      _stageSelectMode = true;
      _stageSelectedTags.clear();
      _stageSelectedSubs.clear();
      _stageSelectedMajors.clear();
      let picked = 0;
      const seenIntra = new Set();
      (_impStage.groups || []).forEach(g => {
        const info = getSubDisplayInfo(g.id, g);
        let groupHasDup = false;
        (g.tags || []).forEach((t, ti) => {
          const k = normImpTagKey(t.en);
          if (!k) return;
          const inLib = (existMap.get(k) || []).length > 0;
          const inStageDup = (stageFreq.get(k) || 0) > 1 && seenIntra.has(k);
          seenIntra.add(k);
          if (inLib || inStageDup || (t._dupHits && t._dupHits.length > 0)) {
            _stageSelectedTags.add(`${g.id}::${ti}`);
            groupHasDup = true;
            picked++;
          }
        });
        if (groupHasDup) {
          _impExpandedMajors.add(info.majorId);
          _impExpandedGroups.add(g.id);
        }
      });
      renderImpStash();
      if (picked > 0) {
        toast(`🔁 已一键选中 ${picked} 个重复暂存标签（含_与空格统一识别）`);
      } else {
        toast('✅ 当前暂存库内未检测到重复标签');
      }
    });
    on('#btnStageBatchImport', 'click', async () => {
      const selCount = countStageSelectedTags();
      if (selCount > 0) {
        await executeStageSubsetImport((g, _, ti) => isStageTagSelected(g.id, ti), `已选 ${selCount} 条`);
      }
    });
    on('#btnStageBatchDelete', 'click', () => {
      const selCount = countStageSelectedTags();
      if (selCount > 0) {
        deleteStageSubset((g, _, ti) => isStageTagSelected(g.id, ti), `🗑 已删除选中的 ${selCount} 条暂存标签`);
      }
    });
    on('#btnStageEditSave', 'click', saveStageEditModal);

    const impStashBox = $('#impStash');
    if (impStashBox) {
      // V1.0.1 Req 4: 将主界面的框选功能套用进暂存库 (#impStash)，支持框选与上下边缘自动滑动
      (function initStageMarqueeSelection() {
        let isDown = false;
        let isDragging = false;
        let wasStageSelBefore = false;
        let startX = 0, startY = 0, startScrollTop = 0;
        let lastClientX = 0, lastClientY = 0;
        let appendMode = false;
        let autoScrollRaf = 0;

        const getBoxEl = () => {
          let b = document.getElementById('tagMarqueeBox');
          if (!b) {
            b = document.createElement('div');
            b.id = 'tagMarqueeBox';
            b.className = 'tag-marquee-box';
            b.hidden = true;
            document.body.appendChild(b);
          }
          return b;
        };

        const stopAutoScroll = () => {
          if (autoScrollRaf) {
            cancelAnimationFrame(autoScrollRaf);
            autoScrollRaf = 0;
          }
        };

        const updateStageMarquee = () => {
          if (!isDragging) return;
          const bounds = impStashBox.getBoundingClientRect();
          const curX = clamp(lastClientX, bounds.left, bounds.right);
          const curY = clamp(lastClientY, bounds.top, bounds.bottom);
          const scrollDelta = impStashBox.scrollTop - startScrollTop;
          const anchorY = startY - scrollDelta;
          const visStartY = clamp(anchorY, bounds.top, bounds.bottom);
          const cStartX = clamp(startX, bounds.left, bounds.right);

          const left = Math.min(cStartX, curX);
          const right = Math.max(cStartX, curX);
          const visTop = Math.min(visStartY, curY);
          const visBottom = Math.max(visStartY, curY);

          const boxEl = getBoxEl();
          if (boxEl) {
            boxEl.hidden = false;
            boxEl.style.left = left + 'px';
            boxEl.style.top = visTop + 'px';
            boxEl.style.width = Math.max(0, right - left) + 'px';
            boxEl.style.height = Math.max(0, visBottom - visTop) + 'px';
          }

          const hitTop = Math.min(anchorY, curY);
          const hitBottom = Math.max(anchorY, curY);
          if (!appendMode) {
            _stageSelectedTags.clear();
            _stageSelectedSubs.clear();
            _stageSelectedMajors.clear();
          }
          const cards = impStashBox.querySelectorAll('.ts-tag-card[data-st-tag]');
          cards.forEach(card => {
            const r = card.getBoundingClientRect();
            const hit = !(r.right < left || r.left > right || r.bottom < hitTop || r.top > hitBottom);
            const key = card.getAttribute('data-st-tag');
            if (hit && key) {
              _stageSelectedTags.add(key);
              card.classList.add('selected', 'st-selected');
            } else if (!appendMode && key) {
              card.classList.remove('selected', 'st-selected');
            }
          });
        };

        const autoScrollTick = () => {
          if (!isDown || !isDragging) {
            autoScrollRaf = 0;
            return;
          }
          const bounds = impStashBox.getBoundingClientRect();
          const edgeZone = 44;
          let delta = 0;
          if (lastClientY >= bounds.bottom - edgeZone) {
            delta = Math.max(4, Math.ceil((lastClientY - (bounds.bottom - edgeZone) + 6) * 0.35));
          } else if (lastClientY <= bounds.top + edgeZone && impStashBox.scrollTop > 0) {
            delta = -Math.max(4, Math.ceil(((bounds.top + edgeZone) - lastClientY + 6) * 0.35));
          }
          if (delta !== 0) {
            const prev = impStashBox.scrollTop;
            impStashBox.scrollTop += delta;
            if (impStashBox.scrollTop !== prev) updateStageMarquee();
          }
          autoScrollRaf = requestAnimationFrame(autoScrollTick);
        };

        impStashBox.addEventListener('mousedown', e => {
          if (e.button !== 0) return;
          if (e.target.closest('.ts-major-head, .ts-sub-head, button, input, select')) return;
          const bounds = impStashBox.getBoundingClientRect();
          if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) return;
          isDown = true;
          isDragging = false;
          wasStageSelBefore = !!_stageSelectMode;
          startX = clamp(e.clientX, bounds.left, bounds.right);
          startY = clamp(e.clientY, bounds.top, bounds.bottom);
          startScrollTop = impStashBox.scrollTop;
          lastClientX = e.clientX;
          lastClientY = e.clientY;
          appendMode = !!(e.shiftKey || e.ctrlKey || e.metaKey);
        });

        window.addEventListener('mousemove', e => {
          if (!isDown) return;
          lastClientX = e.clientX;
          lastClientY = e.clientY;
          const dx = e.clientX - startX;
          const dy = e.clientY - startY;
          if (!isDragging && Math.hypot(dx, dy) > 5) {
            isDragging = true;
            document.body.classList.add('is-marquee-dragging');
            if (!autoScrollRaf) autoScrollRaf = requestAnimationFrame(autoScrollTick);
          }
          if (!isDragging) return;
          e.preventDefault();
          updateStageMarquee();
        });

        window.addEventListener('mouseup', () => {
          if (!isDown) return;
          isDown = false;
          stopAutoScroll();
          document.body.classList.remove('is-marquee-dragging');
          if (isDragging) {
            isDragging = false;
            const boxEl = getBoxEl();
            if (boxEl) boxEl.hidden = true;
            window._justStageMarqueeEnded = true;
            setTimeout(() => { window._justStageMarqueeEnded = false; }, 80);
            const cnt = countStageSelectedTags();
            if (cnt > 0) {
              _stageSelectMode = true;
            } else if (!wasStageSelBefore) {
              _stageSelectMode = false;
            }
            renderImpStash();
          }
        });
      })();

      impStashBox.addEventListener('click', async e => {
        if (window._justStageMarqueeEnded) return;
        const actBtn = e.target.closest('[data-st-act]');
        if (actBtn) {
          e.stopPropagation();
          const act = actBtn.getAttribute('data-st-act');
          const mid = actBtn.getAttribute('data-mid');
          const sid = actBtn.getAttribute('data-sid');
          const ti = Number(actBtn.getAttribute('data-ti'));
          if (act === 'import-major') await executeStageSubsetImport(g => getSubDisplayInfo(g.id, g).majorId === mid, `大分类 ${mid}`);
          else if (act === 'switch-major') openStageMajorSwitchPopover(mid, actBtn);
          else if (act === 'del-major') deleteStageSubset(g => getSubDisplayInfo(g.id, g).majorId === mid);
          else if (act === 'import-sub') await executeStageSubsetImport(g => g.id === sid, `小分类 ${sid}`);
          else if (act === 'del-sub') deleteStageSubset(g => g.id === sid);
          else if (act === 'import-tag') await executeStageSubsetImport((g, _, idx) => g.id === sid && idx === ti, '单条标签');
          else if (act === 'edit-tag') openStageEditModal('tag', sid, ti);
          else if (act === 'del-tag') deleteStageSubset((g, _, idx) => g.id === sid && idx === ti);
          return;
        }

        const chkMajor = e.target.closest('[data-st-chk-major]');
        if (chkMajor) {
          e.stopPropagation();
          toggleStageMajorSelect(chkMajor.getAttribute('data-st-chk-major'), chkMajor.checked);
          return;
        }
        const chkSub = e.target.closest('[data-st-chk-sub]');
        if (chkSub) {
          e.stopPropagation();
          toggleStageSubSelect(chkSub.getAttribute('data-st-chk-sub'), chkSub.checked);
          return;
        }
        const chkTag = e.target.closest('[data-st-chk-tag]');
        if (chkTag) {
          e.stopPropagation();
          const [sid, tiStr] = chkTag.getAttribute('data-st-chk-tag').split('::');
          toggleStageTagSelect(sid, Number(tiStr), chkTag.checked);
          return;
        }

        const tagCard = e.target.closest('.ts-tag-card[data-st-tag]');
        if (tagCard) {
          const sid = tagCard.getAttribute('data-sid');
          const ti = Number(tagCard.getAttribute('data-ti'));
          if (_stageSelectMode) {
            toggleStageTagSelect(sid, ti);
          } else {
            openStageEditModal('tag', sid, ti);
          }
          return;
        }

        const subHead = e.target.closest('[data-st-sub-toggle]');
        if (subHead) {
          const sid = subHead.getAttribute('data-st-sub-toggle');
          if (_impExpandedGroups.has(sid)) _impExpandedGroups.delete(sid);
          else _impExpandedGroups.add(sid);
          renderImpStash();
          return;
        }

        const majorHead = e.target.closest('[data-st-major-toggle]');
        if (majorHead) {
          const mid = majorHead.getAttribute('data-st-major-toggle');
          if (_impExpandedMajors.has(mid)) _impExpandedMajors.delete(mid);
          else _impExpandedMajors.add(mid);
          renderImpStash();
          return;
        }
      });

      impStashBox.addEventListener('contextmenu', e => {
        const tagCard = e.target.closest('.ts-tag-card[data-st-tag]');
        if (tagCard) {
          e.preventDefault();
          e.stopPropagation();
          openStageItemContextMenu(e.clientX, e.clientY, 'tag', tagCard.getAttribute('data-sid'), tagCard.getAttribute('data-ti'));
          return;
        }
        const subHead = e.target.closest('[data-st-sub-toggle]');
        if (subHead) {
          e.preventDefault();
          e.stopPropagation();
          openStageItemContextMenu(e.clientX, e.clientY, 'sub', subHead.getAttribute('data-st-sub-toggle'));
          return;
        }
        const majorHead = e.target.closest('[data-st-major-toggle]');
        if (majorHead) {
          e.preventDefault();
          e.stopPropagation();
          openStageItemContextMenu(e.clientX, e.clientY, 'major', majorHead.getAttribute('data-st-major-toggle'));
          return;
        }
      });
    }

    on('#miniEn', 'input', () => {
      const en = cleanArtistEn(($('#miniEn') && $('#miniEn').value || '').trim(), _miniSubId);
      const stat = $('#miniStat');
      if (!stat) return;
      if (!en) { stat.textContent = ''; return; }
      const dup = checkTagDuplication(en, _miniSubId);
      if (dup.inSame) {
        stat.innerHTML = `<span style="color:var(--neg)">⚠ 当前小分类已存在「${esc(en)}」</span>`;
      } else if (dup.otherSubs.length) {
        stat.innerHTML = `<span style="color:#fbbf24">⚠ 已在其他分类（${esc(dup.otherSubs.join('、'))}）重复，勾选上方选项可将其移入当前分类</span>`;
      } else {
        stat.innerHTML = `<span style="color:var(--pos)">✅ 全新提示词，可安全添加</span>`;
      }
    });

    on('#subAddPrecheckBody', 'change', e => {
      const ck = e.target.closest('[data-subadd-move-row]');
      if (!ck) return;
      const idx = +ck.getAttribute('data-subadd-move-row');
      if (_parsedBatchItems[idx]) _parsedBatchItems[idx].moveFromOther = ck.checked;
    });
    on('#subAddPrecheckBody', 'input', e => {
      const dInp = e.target.closest('[data-subadd-desc-row]');
      if (!dInp) return;
      const idx = +dInp.getAttribute('data-subadd-desc-row');
      if (_parsedBatchItems[idx]) _parsedBatchItems[idx].desc = dInp.value;
    });

    /* (V1.0 Req 4) 右上角「🔍 查重」按钮与全库重复标签唯一保留清理系统 */
    let _dedupGroups = []; // [{ key, en, zh, keepIdx: 0, occurrences: [{ subId, majorId, label, tagIdx, isCustom }] }]

    function scanAllDuplicateTags() {
      ensureCustomCategoriesStructure();
      const map = new Map();
      const fs = window.PG_TAG_FS;
      (fs.majors || []).forEach(m => {
        (m.children || []).forEach(s => {
          (s.tags || []).forEach((t, idx) => {
            const en = cleanArtistEn(String(t.en || '').trim());
            const k = normDedupKey(en);
            if (!k) return;
            if (!map.has(k)) map.set(k, { key: k, en, zh: t.zh || '', keepIdx: 0, occurrences: [] });
            const entry = map.get(k);
            if (!entry.zh && t.zh) entry.zh = t.zh;
            entry.occurrences.push({
              subId: s.id,
              majorId: m.id,
              label: `${m.name} › ${s.name}`,
              tagIdx: idx,
              zh: t.zh || '',
              isCustom: false
            });
          });
        });
      });
      (state.customTagCats || []).forEach(c => {
        (c.tags || []).forEach((t, idx) => {
          const en = cleanArtistEn(String(t.en || '').trim());
          const k = normDedupKey(en);
          if (!k) return;
          if (!map.has(k)) map.set(k, { key: k, en, zh: t.zh || '', keepIdx: 0, occurrences: [] });
          const entry = map.get(k);
          if (!entry.zh && t.zh) entry.zh = t.zh;
          entry.occurrences.push({
            subId: c.id,
            majorId: 'custom',
            label: `⭐ 自定义 › ${c.name}`,
            tagIdx: idx,
            zh: t.zh || '',
            isCustom: true
          });
        });
      });
      const dups = [];
      map.forEach(val => {
        if (val.occurrences.length > 1) {
          dups.push(val);
        }
      });
      return dups;
    }

    function renderDedupModal() {
      const stat = $('#dedupStatBar');
      const tbody = $('#dedupTableBody');
      const btnClean = $('#btnConfirmDedupClean');
      if (!tbody) return;
      if (!_dedupGroups.length) {
        if (stat) stat.innerHTML = `<span style="color:var(--pos)">✅ 全库共检索完毕：未发现任何重复标签（每个标签均为唯一保留）！</span>`;
        tbody.innerHTML = `<tr><td colspan="3" class="muted" style="text-align:center;padding:28px">🎉 当前标签库无任何重复标签</td></tr>`;
        if (btnClean) btnClean.disabled = true;
        return;
      }
      if (btnClean) btnClean.disabled = false;
      const totalExtra = _dedupGroups.reduce((s, g) => s + (g.occurrences.length - 1), 0);
      if (stat) {
        stat.innerHTML = `<span>🔍 共发现 <b>${_dedupGroups.length}</b> 组重复标签（共 <b>${totalExtra}</b> 个多余副本待清理 · 每组仅可保留一个）</span>`;
      }
      tbody.innerHTML = _dedupGroups.map((g, gi) => `
        <tr data-dedup-gi="${gi}">
          <td><code>${esc(g.en)}</code></td>
          <td>${esc(g.zh || '—')}</td>
          <td>
            <div class="dedup-loc-list">
              ${g.occurrences.map((occ, oi) => `
                <label class="dedup-loc-opt ${oi === g.keepIdx ? 'keep' : ''}">
                  <input type="radio" name="dedup_keep_${gi}" data-dedup-radio="${gi}" value="${oi}" ${oi === g.keepIdx ? 'checked' : ''}>
                  <span>保留：<b>${esc(occ.label)}</b></span>
                </label>
              `).join('')}
            </div>
          </td>
        </tr>
      `).join('');
    }

    function openTagDedupModal() {
      _dedupGroups = scanAllDuplicateTags();
      renderDedupModal();
      openModal('modalTagDedup');
    }

    async function executeTagDedupClean() {
      if (!_dedupGroups.length) {
        toast('当前没有需要清理的重复标签');
        closeModal('modalTagDedup');
        return;
      }
      recordHistorySnapshot(`全局查重清理 (${_dedupGroups.length} 组重复标签)`, true);
      // Map of key -> chosen occurrence { subId, tagIdx, isCustom }
      const keepChoiceMap = new Map();
      _dedupGroups.forEach(g => {
        const chosen = g.occurrences[g.keepIdx] || g.occurrences[0];
        keepChoiceMap.set(g.key, chosen);
      });

      let removedTotal = 0;
      const seenKeptKeys = new Set();
      const fs = window.PG_TAG_FS;

      (fs.majors || []).forEach(m => {
        (m.children || []).forEach(s => {
          const before = (s.tags || []).length;
          if (!before) return;
          s.tags = (s.tags || []).filter((t, idx) => {
            const k = normDedupKey(t.en);
            if (!keepChoiceMap.has(k)) return true;
            const chosen = keepChoiceMap.get(k);
            if (!chosen.isCustom && chosen.subId === s.id && chosen.tagIdx === idx && !seenKeptKeys.has(k)) {
              seenKeptKeys.add(k);
              return true;
            }
            removedTotal++;
            return false;
          });
          if (s.tags.length !== before) {
            s.updatedAt = new Date().toISOString();
          }
        });
      });

      (state.customTagCats || []).forEach(c => {
        const before = (c.tags || []).length;
        if (!before) return;
        c.tags = (c.tags || []).filter((t, idx) => {
          const k = normDedupKey(t.en);
          if (!keepChoiceMap.has(k)) return true;
          const chosen = keepChoiceMap.get(k);
          if (chosen.isCustom && chosen.subId === c.id && chosen.tagIdx === idx && !seenKeptKeys.has(k)) {
            seenKeptKeys.add(k);
            return true;
          }
          removedTotal++;
          return false;
        });
      });

      syncFlatCustomFromTagCats();
      await fs.persistOp({ action: 'sync_all', majors: fs.majors });
      refreshAllFromTree();
      save();
      _dedupGroups = scanAllDuplicateTags();
      renderDedupModal();
      toast(`✅ 查重清理完成：已移除 ${removedTotal} 个重复标签副本，每个标签仅保留唯一一个！`);
    }

    on('#btnDedupCheck', 'click', openTagDedupModal);
    on('#dedupTableBody', 'change', e => {
      const r = e.target.closest('input[data-dedup-radio]');
      if (!r) return;
      const gi = Number(r.getAttribute('data-dedup-radio'));
      const oi = Number(r.value);
      if (_dedupGroups[gi]) {
        _dedupGroups[gi].keepIdx = oi;
        renderDedupModal();
      }
    });
    on('#btnConfirmDedupClean', 'click', executeTagDedupClean);

    /* (Req 9) 精简新增小窗 */
    on('#btnMiniAdd', 'click', commitMiniAdd);
    ['#miniEn', '#miniZh', '#miniDesc'].forEach(sel => {
      const el = $(sel);
      if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commitMiniAdd(); } });
    });

    on('#btnSaveToSub', 'click', async () => {
      const items = collectAddItems();
      if (!items.length) { toast('没有可写入的标签'); return; }
      const sid = ($('#addTargetSub') && $('#addTargetSub').value) || 'style';
      recordHistorySnapshot(`批量写入小分类 (${items.length} 项)`, true);
      let n = 0;
      for (const it of items) {
        if (it.en && await addTagToSubFile(sid, it.en, it.zh || zhLookup(it.en))) n++;
      }
      const hit = findTreeSub(sid);
      toast(`已写入 ${n} 个标签到「${hit ? hit.sub.name : sid}」外部文件`);
    });

    on('#subAddTargetSel', 'change', () => {
      const sid = $('#subAddTargetSel').value;
      const hit = findTreeSub(sid);
      if (hit && $('#subAddModalTitle')) {
        $('#subAddModalTitle').textContent = `＋ 新增提示词到「${hit.major.name} › ${hit.sub.name}」`;
      }
      if ($('#subAddBatchInput') && $('#subAddBatchInput').value.trim()) runSubAddPrecheck();
    });
    on('#btnSubAddSingleCheck', 'click', () => {
      const targetSubId = ($('#subAddTargetSel') && $('#subAddTargetSel').value) || '';
      const en = ($('#subAddSingleEn') && $('#subAddSingleEn').value || '').trim();
      const stat = $('#subAddSingleStat');
      if (!en) { toast('请先输入英文提示词'); return; }
      const dup = checkTagDuplication(en, targetSubId);
      if (dup.inSame) {
        stat.innerHTML = `<span style="color:var(--neg)">⚠ 预检结果：「${esc(en)}」在当前小分类中已存在！</span>`;
      } else if (dup.otherSubs.length) {
        stat.innerHTML = `<span style="color:#fbbf24">⚠ 预检结果：「${esc(en)}」在其他小分类（${esc(dup.otherSubs.join('、'))}）中已存在！</span>`;
      } else {
        stat.innerHTML = `<span style="color:var(--pos)">✅ 预检通过：「${esc(en)}」未在任何小分类中重复，可安全添加。</span>`;
      }
    });
    on('#subAddSingleEn', 'input', () => {
      const en = ($('#subAddSingleEn').value || '').trim();
      if (!en) { if ($('#subAddSingleStat')) $('#subAddSingleStat').textContent = ''; return; }
      const targetSubId = ($('#subAddTargetSel') && $('#subAddTargetSel').value) || '';
      const dup = checkTagDuplication(en, targetSubId);
      const stat = $('#subAddSingleStat');
      if (!stat) return;
      if (dup.inSame) stat.innerHTML = `<span style="color:var(--neg)">⚠ 当前小分类已存在该词</span>`;
      else if (dup.otherSubs.length) stat.innerHTML = `<span style="color:#fbbf24">⚠ 其他小分类已存在（${esc(dup.otherSubs.join('、'))}）</span>`;
      else stat.innerHTML = `<span style="color:var(--pos)">✅ 无重复</span>`;
    });
    on('#btnSubAddSingleSubmit', 'click', commitSubAddSingle);
    on('#subAddBatchInput', 'input', runSubAddPrecheck);
    on('#btnSubAddBatchParse', 'click', runSubAddPrecheck);
    on('#btnSubAddBatchCommit', 'click', commitSubAddBatch);

    $$('input[name="expScope"]').forEach(r => r.addEventListener('change', syncExpScopeUI));
    on('#expSubMajorSel', 'change', e => {
      syncExpSubOptionsByMajor(e.target.value);
      syncExpScopeUI();
    });
    on('#expSubSel', 'change', syncExpScopeUI);
    on('#expMajorSel', 'change', syncExpScopeUI);
    on('#btnDoScopeExport', 'click', exportScopedTagPackage);
    on('#btnDoScopeExportMajor', 'click', exportScopedTagPackage);

    on('#btnPickTagPkgFile', 'click', () => $('#fileTagPkgImport').click());
    on('#fileTagPkgImport', 'change', e => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        const txt = String(reader.result || '');
        if ($('#impPkgRawText')) $('#impPkgRawText').value = txt;
        const v = validateTagPackage(txt);
        const stat = $('#impCheckStat');
        if (stat) stat.textContent = v.ok ? ('✅ ' + v.summary) : ('❌ ' + v.error);
        if (v.ok && v.scope === 'sub' && v.parentMajor && v.parentMajor.id && $('#impTargetMajorSel')) {
          const sel = $('#impTargetMajorSel');
          if (Array.prototype.some.call(sel.options, o => o.value === v.parentMajor.id)) {
            sel.value = v.parentMajor.id;
          } else {
            sel.value = '__custom__';
          }
        }
      };
      reader.readAsText(f, 'utf-8');
      e.target.value = '';
    });
    on('#btnValidatePkg', 'click', () => {
      const txt = ($('#impPkgRawText') && $('#impPkgRawText').value) || '';
      const v = validateTagPackage(txt);
      const stat = $('#impCheckStat');
      if (stat) stat.textContent = v.ok ? ('✅ ' + v.summary) : ('❌ ' + v.error);
      toast(v.ok ? v.summary : v.error);
    });
    on('#btnExecutePkgImport', 'click', executeScopedTagImport);

    /* V1.2.9 Req 10: 全局拖拽图片解析（防卡死置顶遮罩保护：一旦鼠标取消拖拽、移出窗口或恢复普通移动立即清除遮罩，且任何拖入界面的图片统一进入「图片解析」） */
    let _dragLeaveWatchdog = null;
    const clearDraggingFileOverlay = () => {
      if (_dragLeaveWatchdog) {
        clearTimeout(_dragLeaveWatchdog);
        _dragLeaveWatchdog = null;
      }
      if (document.body.classList.contains('dragging-file')) {
        document.body.classList.remove('dragging-file');
      }
    };
    const scheduleDragOverlayWatchdog = () => {
      if (_dragLeaveWatchdog) clearTimeout(_dragLeaveWatchdog);
      _dragLeaveWatchdog = setTimeout(() => {
        clearDraggingFileOverlay();
      }, 160);
    };
    const hasImageDrag = e => {
      if (window._internalDragging || _dragNodeType) return false;
      if (!e || !e.dataTransfer) return false;
      const items = e.dataTransfer.items;
      if (items && items.length) {
        for (let i = 0; i < items.length; i++) {
          if (items[i].kind === 'file' && (!items[i].type || /^image\//i.test(items[i].type))) return true;
        }
        return false;
      }
      return Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0;
    };

    window.addEventListener('dragenter', e => {
      if (!hasImageDrag(e)) return;
      e.preventDefault();
      document.body.classList.add('dragging-file');
      scheduleDragOverlayWatchdog();
    });
    window.addEventListener('dragover', e => {
      if (!hasImageDrag(e)) return;
      e.preventDefault();
      document.body.classList.add('dragging-file');
      scheduleDragOverlayWatchdog();
    });
    window.addEventListener('dragleave', e => {
      if (!e.relatedTarget || e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
        clearDraggingFileOverlay();
      } else {
        scheduleDragOverlayWatchdog();
      }
    });
    window.addEventListener('dragend', clearDraggingFileOverlay);
    window.addEventListener('blur', clearDraggingFileOverlay);
    window.addEventListener('mousemove', clearDraggingFileOverlay, { passive: true });
    window.addEventListener('mousedown', clearDraggingFileOverlay, { passive: true });
    window.addEventListener('pointerdown', clearDraggingFileOverlay, { passive: true });
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape') clearDraggingFileOverlay();
    });
    window.addEventListener('drop', e => {
      clearDraggingFileOverlay();
      if (window._internalDragging) return;
      const files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      let imgFile = null;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (/^image\//i.test(f.type || '') || /\.(png|jpe?g|webp|bmp|gif)$/i.test(f.name || '')) {
          imgFile = f;
          break;
        }
      }
      if (imgFile) {
        e.preventDefault();
        e.stopPropagation();
        const modalImg = $('#modalImg');
        if (modalImg && modalImg.hidden) {
          openModal('modalImg');
        }
        handleImage(imgFile);
      }
    });
  }

  function init() {
    // V1.3.1 Fix Bug 3: 防御性清理可能重复挂载的 .app 或右侧收起按钮
    const dupApps = document.querySelectorAll('.app');
    if (dupApps.length > 1) {
      for (let i = 1; i < dupApps.length; i++) dupApps[i].remove();
    }
    const dupRightBtns = document.querySelectorAll('#btnRightEdgeToggle');
    if (dupRightBtns.length > 1) {
      for (let i = 1; i < dupRightBtns.length; i++) dupRightBtns[i].remove();
    }
    load();
    if (state.chars && state.chars.length) {
      state.chars = state.chars.map(c => {
        const hit = CHARS.find(x => x.key === c.key);
        if (!hit) return Object.assign({}, c, { tags: c.tags || [] });
        return Object.assign({}, c, { name: c.name, tag: c.tag, charZh: c.charZh,
          tags: [norm(hit.tag)].concat(hit.auto.map(a => norm(a.en))) });
      });
    }
    syncCharTags();
    el.search.value = '';
    if ($('#chkZh')) $('#chkZh').checked = state.showZh;
    if ($('#chkShowNsfw')) $('#chkShowNsfw').checked = state.showNsfw !== false;
    if ($('#chkOrder')) $('#chkOrder').checked = state.autoOrder;
    if ($('#chkMossMode')) $('#chkMossMode').checked = !!state.mossMode;
    if ($('#chkOnline')) $('#chkOnline').checked = state.online;
    if ($('#transOnline')) $('#transOnline').checked = state.online;
    if ($('#transForce')) $('#transForce').checked = state.forceOnline;
    if ($('#setAutoTr')) $('#setAutoTr').checked = !!state.autoTr;
    loadAiCfg();
    $('#libStat').textContent =
      `${TOTAL_TAGS} 个标签 · ${CATS.length} 个分类 · ${CHARS.length} 个游戏角色 · ${PRESETS.length} 个预设`;
    state.randomSet = [];
    bind();
    bindExtra();
    bindTreeAndPkgEvents();
    populateAddTargetSubSelect();
    initModelSwitch();
    initOptimize();
    syncModeSeg();
    syncRightSidebarUI();
    if ($('#mossBox')) $('#mossBox').hidden = !state.mossMode;
    renderRandSwitchBar();
    renderAll();
    loadAndRenderHelpMd(false);
    loadAndRenderChangelogMd();
    updateFsBadge();
    state.undoStack = [];
    state.redoStack = [];
    function hydrateFromExternalUserData(u) {
      if (!u || typeof u !== 'object') return;
      if (Array.isArray(u.nsfwCustomOn) && u.nsfwCustomOn.length && (!state.nsfwCustomOn || !state.nsfwCustomOn.size)) state.nsfwCustomOn = new Set(u.nsfwCustomOn);
      if (Array.isArray(u.nsfwCustomOff) && u.nsfwCustomOff.length && (!state.nsfwCustomOff || !state.nsfwCustomOff.size)) state.nsfwCustomOff = new Set(u.nsfwCustomOff);
      if (Array.isArray(u.favTags) && u.favTags.length && !state.favTags.length) state.favTags = u.favTags.slice(0, 300);
      if (Array.isArray(u.recentTags) && u.recentTags.length && !state.recentTags.length) state.recentTags = u.recentTags.slice(0, 48);
      if (Array.isArray(u.favChars) && u.favChars.length && !state.favChars.length) state.favChars = u.favChars.slice(0, 300);
      if (Array.isArray(u.recentChars) && u.recentChars.length && !state.recentChars.length) state.recentChars = u.recentChars.slice(0, 40);
      if (Array.isArray(u.recentCharTags) && u.recentCharTags.length && !state.recentCharTags.length) state.recentCharTags = u.recentCharTags.slice(0, 80);
      if (Array.isArray(u.history) && u.history.length && !state.history.length) state.history = u.history.slice(0, 40);
      if (Array.isArray(u.seenNewTags) && u.seenNewTags.length) {
        if (!(state.seenNewTagsSet instanceof Set)) state.seenNewTagsSet = new Set(state.seenNewTags || []);
        u.seenNewTags.forEach(k => state.seenNewTagsSet.add(k));
        state.seenNewTags = Array.from(state.seenNewTagsSet);
      }
      if (Array.isArray(u.seenNewChars) && u.seenNewChars.length) {
        if (!(state.seenNewCharsSet instanceof Set)) state.seenNewCharsSet = new Set(state.seenNewChars || []);
        u.seenNewChars.forEach(k => state.seenNewCharsSet.add(k));
        state.seenNewChars = Array.from(state.seenNewCharsSet);
      }
      if (Array.isArray(u.customTagCats) && u.customTagCats.length) {
        const curHasTags = Array.isArray(state.customTagCats) && state.customTagCats.some(c => c && Array.isArray(c.tags) && c.tags.length > 0);
        if (!curHasTags || state.customTagCats.length < u.customTagCats.length) {
          state.customTagCats = JSON.parse(JSON.stringify(u.customTagCats));
        }
      }
      if (Array.isArray(u.custom) && u.custom.length) {
        if (!Array.isArray(state.customTagCats) || !state.customTagCats.length) {
          state.customTagCats = [{ id: 'cust_tag_1', name: '新增分类1', icon: '🏷', tags: [] }];
        }
        const existingKeys = new Set();
        state.customTagCats.forEach(c => (c.tags || []).forEach(t => existingKeys.add(norm(t.en))));
        u.custom.forEach(t => {
          if (t && t.en && !existingKeys.has(norm(t.en))) {
            existingKeys.add(norm(t.en));
            state.customTagCats[0].tags.push({ en: t.en, zh: t.zh || '', desc: t.desc || '' });
          }
        });
        syncFlatCustomFromTagCats();
      }
      if (u.impStage && Array.isArray(u.impStage.groups) && u.impStage.groups.length && (!totalImpStageTags())) {
        _impStage = JSON.parse(JSON.stringify(u.impStage));
        saveImpStageToLocal();
      }
      if (Array.isArray(u.tagTreeBackup) && u.tagTreeBackup.length && window.PG_TAG_FS && typeof window.PG_TAG_FS.mergeTagTrees === 'function') {
        window.PG_TAG_FS.majors = window.PG_TAG_FS.mergeTagTrees(window.PG_TAG_FS.majors, u.tagTreeBackup);
        window.PG_TAG_FS.saveLocalMirror();
      }
      if (Array.isArray(u.saves) && u.saves.length && !SAVES.length) {
        u.saves.forEach(s => { if (s && s.id) SAVES.push(s); });
      }
      if (Array.isArray(u.customChars) && u.customChars.length && (!state.customChars || !state.customChars.length)) state.customChars = u.customChars;
      if (Array.isArray(u.charCustomSubs) && u.charCustomSubs.length && (!state.charCustomSubs || !state.charCustomSubs.length)) state.charCustomSubs = u.charCustomSubs;
      if (u.charDescMap && typeof u.charDescMap === 'object') state.charDescMap = Object.assign({}, u.charDescMap, state.charDescMap || {});
      if (u.settings && typeof u.settings === 'object') {
        const us = u.settings;
        let hasLocalSettings = false;
        try { hasLocalSettings = !!localStorage.getItem(LS_KEY); } catch (e) {}
        if (!hasLocalSettings) {
          if (typeof us.autosave === 'boolean' && Number(us.settingsVersion || 0) >= 2.9) state.autosave = us.autosave; else state.autosave = false;
          if (typeof us.autoTr === 'boolean') state.autoTr = us.autoTr;
          if (typeof us.showZh === 'boolean') state.showZh = us.showZh;
          if (typeof us.showNsfw === 'boolean') state.showNsfw = us.showNsfw;
          if (typeof us.autoOrder === 'boolean') state.autoOrder = us.autoOrder;
          if (us.theme === 'light' || us.theme === 'dark') {
            state.theme = us.theme;
            if (typeof window.applyTheme === 'function') window.applyTheme(us.theme, true);
          }
        }
        if (us.logoStyle === 'dp' || us.logoStyle === 'chibi') {
          let hasLsLogo = false;
          try {
            const rawLs = localStorage.getItem(LS_KEY);
            if (rawLs) {
              const pLs = JSON.parse(rawLs);
              if (pLs && pLs.settings && (pLs.settings.logoStyle === 'dp' || pLs.settings.logoStyle === 'chibi')) {
                hasLsLogo = true;
              }
            }
          } catch (e) {}
          if (!hasLsLogo) {
            state.logoStyle = us.logoStyle;
            try { localStorage.setItem('pg_logo_style', us.logoStyle); } catch (e) {}
          }
        }
        const effLogo = state.logoStyle || (localStorage.getItem('pg_logo_style') === 'dp' ? 'dp' : 'chibi');
        if (typeof window.applyLogoIconStyle === 'function') window.applyLogoIconStyle(effLogo);
        if ($('#setLogoStyle')) $('#setLogoStyle').value = effLogo;
        if ($('#chkZh')) $('#chkZh').checked = !!state.showZh;
        if ($('#chkShowNsfw')) $('#chkShowNsfw').checked = state.showNsfw !== false;
        if ($('#setAutosave')) $('#setAutosave').checked = !!state.autosave;
        if ($('#setAutoTr')) $('#setAutoTr').checked = !!state.autoTr;
        if ($('#setTheme')) $('#setTheme').value = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
      }
      if (u.ratingOverrides && typeof u.ratingOverrides === 'object') {
        state.ratingOverrides = Object.assign({}, u.ratingOverrides, state.ratingOverrides || {});
      }
      let hasLocalRandCfg = false;
      try {
        const rawLs = localStorage.getItem(LS_KEY);
        if (rawLs) {
          const parsedLs = JSON.parse(rawLs);
          if (parsedLs && parsedLs.settings && parsedLs.settings.randCfg) hasLocalRandCfg = true;
        }
      } catch (e) {}
      if (!hasLocalRandCfg && u.randCfg && typeof u.randCfg === 'object') {
        state.randCfg = Object.assign(state.randCfg, u.randCfg);
      }
    }
    loadCharImgCacheFromIdb().then(() => { hydrateCharCardImages(); });
    if (window.PG_TAG_FS) {
      window.PG_TAG_FS.bootExternalData().then(() => {
        hydrateFromExternalUserData(window.PG_TAG_FS.userData);
        loadCharImgCacheFromIdb().then(() => { hydrateCharCardImages(); });
        refreshAllFromTree();
        renderSaves();
        renderHistory();
        loadAndRenderHelpMd(false);
    loadAndRenderChangelogMd();
        return window.PG_TAG_FS.connectExternalFiles();
      }).then(res => {
        if (res && res.ok) {
          hydrateFromExternalUserData(window.PG_TAG_FS.userData);
          refreshAllFromTree();
          renderSaves();
          renderHistory();
        }
      });
    }
    queueTr([].concat(state.sel, state.neg, state.custom).map(x => x.en));
    setTimeout(queueTrAllMissing, 2500);
  }

  /* ===== 界面主题 ===== */
  const THEME_KEY = 'pg_theme';
  function currentTheme() {
    try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; } catch (e) { return 'dark'; }
  }
  function applyTheme(t, skipPersist) {
    const v = t === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', v);
    if (document.body) document.body.classList.toggle('light', v === 'light');
    try { localStorage.setItem(THEME_KEY, v); } catch (e) { /* ignore */ }
    const sel = $('#setTheme');
    if (sel) sel.value = v;
    const bulbImg = document.getElementById('themeBulbImg');
    if (bulbImg) {
      bulbImg.src = v === 'light' ? 'materials/btn_theme_light.svg' : 'materials/btn_theme_dark.svg';
    }
    if (!skipPersist && typeof window.persistStateAndSettingsNow === 'function') {
      window.persistStateAndSettingsNow();
    }
  }
  window.applyTheme = applyTheme;
  applyTheme(currentTheme(), true);
  const selTheme = $('#setTheme');
  if (selTheme) selTheme.addEventListener('change', e => applyTheme(e.target.value));
  const selLogo = $('#setLogoStyle');
  if (selLogo) {
    try {
      const initLogo = (typeof window.resolveSavedLogoStyle === 'function')
        ? window.resolveSavedLogoStyle()
        : (localStorage.getItem('pg_logo_style') === 'dp' ? 'dp' : 'chibi');
      state.logoStyle = initLogo;
      selLogo.value = initLogo;
      if (typeof window.applyLogoIconStyle === 'function') window.applyLogoIconStyle(initLogo);
    } catch (e) {}
    selLogo.addEventListener('change', e => {
      const nextStyle = (e.target.value === 'dp') ? 'dp' : 'chibi';
      state.logoStyle = nextStyle;
      if (typeof window.applyLogoIconStyle === 'function') {
        window.applyLogoIconStyle(nextStyle);
      }
      if (typeof window.persistStateAndSettingsNow === 'function') {
        window.persistStateAndSettingsNow();
      }
      toast(nextStyle === 'chibi' ? '🧝 已切换并保存为 Q版动漫图标（默认）' : '✨ 已切换并保存为 DP 字母图标');
    });
  }
  const btnSet = $('#btnSettings');
  if (btnSet) btnSet.addEventListener('click', () => { const s = $('#setTheme'); if (s) s.value = currentTheme(); });


  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
