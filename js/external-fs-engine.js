
/* ===== js/external-fs-engine.js · 纯子文件夹检测与用户操作文件 (user-data.json) 持久化引擎 ===== */
(function () {
  'use strict';

  function resolveSavedLogoStyle() {
    try {
      const ls = localStorage.getItem('pg_logo_style');
      if (ls === 'dp' || ls === 'chibi') return ls;
      const rawForge = localStorage.getItem('pg_forge_v120');
      if (rawForge) {
        const pf = JSON.parse(rawForge);
        if (pf && pf.settings && (pf.settings.logoStyle === 'dp' || pf.settings.logoStyle === 'chibi')) {
          return pf.settings.logoStyle;
        }
      }
      if (window.__EXT_USER_DATA__ && window.__EXT_USER_DATA__.settings) {
        const uls = window.__EXT_USER_DATA__.settings.logoStyle;
        if (uls === 'dp' || uls === 'chibi') return uls;
      }
    } catch (e) {}
    return 'chibi';
  }

  function applyLogoIconStyle(styleKey) {
    const mode = (styleKey === 'dp') ? 'dp' : 'chibi';
    try { localStorage.setItem('pg_logo_style', mode); } catch (e) {}
    const icoFile = (mode === 'dp') ? 'logo_dp.ico' : 'logo_chibi.ico';
    const fallbackUri = (mode === 'dp')
      ? (window.__DEFAULT_ICO_DATA_URI__ || '')
      : (window.__CHIBI_ICO_DATA_URI__ || window.__DEFAULT_ICO_DATA_URI__ || '');
    const brandImg = document.getElementById('brandLogoImg');
    const favEl = document.getElementById('pageFavicon');
    if (brandImg && fallbackUri) brandImg.src = fallbackUri;
    if (favEl) favEl.href = icoFile;
    const selEl = document.getElementById('setLogoStyle');
    if (selEl && selEl.value !== mode) selEl.value = mode;
    const probe = new Image();
    probe.onload = function () {
      if (brandImg) brandImg.src = icoFile;
    };
    probe.src = icoFile;
  }
  window.applyLogoIconStyle = applyLogoIconStyle;
  window.resolveSavedLogoStyle = resolveSavedLogoStyle;
  try {
    applyLogoIconStyle(resolveSavedLogoStyle());
  } catch (e) {}

  const LAYOUT_LS_KEY = 'dp_layout_order_v121';
  const USER_DATA_LS_KEY = 'dp_user_data_v121';
  const TAG_TREE_LS_KEY = 'dp_tag_tree_mirror_v121';
  const CHAR_TREE_LS_KEY = 'dp_char_tree_mirror_v121';
  try {
    if (localStorage.getItem('dp_v121_clean_init') !== '1') {
      ['pg_forge_v1', 'pg_forge_v115', 'pg_forge_v116', 'pg_saves_v1', 'pg_saves_v116', 'dp_user_data_v114', 'dp_user_data_v115', 'dp_user_data_v116', 'dp_tag_tree_mirror_v114', 'dp_tag_tree_mirror_v115', 'dp_tag_tree_mirror_v116', 'dp_tag_tree_mirror_v120', 'pg_op_log_v1'].forEach(k => localStorage.removeItem(k));
      localStorage.setItem('dp_v121_clean_init', '1');
    }
  } catch (e) {}

  function cloneObj(t) {
    if (typeof structuredClone === 'function') {
      try {
        return structuredClone(t);
      } catch (e) {}
    }
    try {
      return JSON.parse(JSON.stringify(t || []));
    } catch (e) {
      return Array.isArray(t) ? [...t] : Object.assign({}, t);
    }
  }

  function safeId(s) {
    return String(s || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || ('cat_' + Date.now().toString(36));
  }

  function loadExternalScript(src) {
    return new Promise(resolve => {
      const s = document.createElement('script');
      const isHttp = typeof location !== 'undefined' && /^https?:$/.test(location.protocol);
      s.src = isHttp ? (src + (src.indexOf('?') >= 0 ? '&' : '?') + '_t=' + Date.now()) : src;
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
  }

  function flattenTreeToPgTags(majors) {
    const flat = [];
    (majors || []).forEach(m => {
      (m.children || []).forEach(sub => {
        const lines = (sub.tags || []).map(t => (t.zh ? t.en + '|' + t.zh : t.en)).join('\n');
        flat.push({
          id: sub.id,
          name: sub.name,
          icon: sub.icon || '•',
          parentId: m.id,
          parentName: m.name,
          parentIcon: m.icon || '📁',
          file: sub.file || (m.id + '/' + m.id + '_' + sub.id + '.json'),
          tags: lines
        });
      });
    });
    return flat;
  }

  function flattenCharTreeToPgCharacters(charMajors) {
    const flat = [];
    (charMajors || []).forEach(m => {
      const mid = (m && m.id) || 'games';
      (m.children || []).forEach(sub => {
        const subId = (sub && sub.id) || '';
        const subName = (sub && sub.name) || '';
        (sub.characters || []).forEach(c => {
          if (c && c.tag) {
            if (!c.game && subName) c.game = subName;
            flat.push({
              ...c,
              majorId: c.majorId || mid,
              subId: c.subId || subId,
              subName: c.subName || subName
            });
          }
        });
      });
    });
    return flat;
  }

  const engine = {
    mode: 'subfolder',
    serverBase: '',
    majors: [],
    charMajors: [],
    layoutOrder: null,
    userData: null,
    helpMd: '',

    getServerBases() {
      const bases = [];
      const add = (u) => {
        if (!u) return;
        const norm = String(u).replace(/\/+$/, '');
        if (norm && bases.indexOf(norm) < 0) bases.push(norm);
      };
      if (this.serverBase) add(this.serverBase);
      if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) {
        add(location.origin);
      }
      if (window.__ACTIVE_SERVER_BASE__) {
        add(window.__ACTIVE_SERVER_BASE__);
      }
      add('http://127.0.0.1:8177');
      add('http://127.0.0.1:18177');
      return bases;
    },

    async fetchStaticTagTree() {
      try {
        const r = await fetch('tags/index.json', { cache: 'no-store' });
        if (!r.ok) return null;
        const idx = await r.json();
        if (!idx || !Array.isArray(idx.majors)) return null;
        const majors = [];
        for (const mMeta of idx.majors) {
          const mr = await fetch('tags/' + (mMeta.file || (mMeta.id + '/' + mMeta.id + '.json')), { cache: 'no-store' });
          if (!mr.ok) continue;
          const mData = await mr.json();
          const children = [];
          for (const sMeta of (mData.children || [])) {
            const sr = await fetch('tags/' + (sMeta.file || (mData.id + '/' + mData.id + '_' + sMeta.id + '.json')), { cache: 'no-store' });
            if (!sr.ok) continue;
            const sData = await sr.json();
            if (sData && sData.id) children.push(sData);
          }
          majors.push({ ...mData, children });
        }
        return majors;
      } catch (e) {
        return null;
      }
    },

    async fetchStaticCharTree() {
      try {
        const r = await fetch('tags/_characters_/index.json', { cache: 'no-store' });
        if (!r.ok) return null;
        const idx = await r.json();
        if (!idx || !Array.isArray(idx.majors)) return null;
        const majors = [];
        for (const mMeta of idx.majors) {
          const mr = await fetch('tags/_characters_/' + (mMeta.file || (mMeta.id + '.json')), { cache: 'no-store' });
          if (!mr.ok) continue;
          const mData = await mr.json();
          const children = [];
          for (const sMeta of (mData.children || [])) {
            const sr = await fetch('tags/_characters_/' + (sMeta.file || (mData.id + '/' + sMeta.id + '.json')), { cache: 'no-store' });
            if (!sr.ok) continue;
            const sData = await sr.json();
            if (sData && sData.id) children.push(sData);
          }
          majors.push({ ...mData, children });
        }
        return majors;
      } catch (e) {
        return null;
      }
    },

    /* (2.9 Req 3) 清理树结构与排序索引中的冗余/重复分类，并通知服务端删除 tags/ 下冗余分类文件夹 */
    cleanupRedundantInTree() {
      if (!Array.isArray(this.majors)) this.majors = [];
      const seenMajors = new Set();
      const cleanMajors = [];
      for (const m of this.majors) {
        if (!m || !m.id) continue;
        const mid = String(m.id).trim();
        if (!mid || seenMajors.has(mid)) continue;
        seenMajors.add(mid);
        const seenSubs = new Set();
        const cleanSubs = [];
        for (const s of (m.children || [])) {
          if (!s || !s.id) continue;
          const sid = String(s.id).trim();
          if (!sid || seenSubs.has(sid)) continue;
          seenSubs.add(sid);
          s.parentId = mid;
          s.file = `${mid}/${mid}_${sid.startsWith(mid + '_') && sid !== mid ? sid.slice(mid.length + 1) : sid}.json`;
          cleanSubs.push(s);
        }
        m.children = cleanSubs;
        m.file = `${mid}/${mid}.json`;
        m.subDir = mid;
        cleanMajors.push(m);
      }
      this.majors = cleanMajors;

      if (this.layoutOrder && typeof this.layoutOrder === 'object') {
        if (Array.isArray(this.layoutOrder.majorOrder)) {
          this.layoutOrder.majorOrder = this.layoutOrder.majorOrder.filter(id => seenMajors.has(id));
          this.majors.forEach(m => {
            if (this.layoutOrder.majorOrder.indexOf(m.id) < 0) this.layoutOrder.majorOrder.push(m.id);
          });
        }
        if (this.layoutOrder.subOrderByMajor && typeof this.layoutOrder.subOrderByMajor === 'object') {
          Object.keys(this.layoutOrder.subOrderByMajor).forEach(mid => {
            if (!seenMajors.has(mid)) {
              delete this.layoutOrder.subOrderByMajor[mid];
            } else {
              const mObj = this.majors.find(x => x.id === mid);
              const validSids = new Set((mObj && mObj.children || []).map(s => s.id));
              this.layoutOrder.subOrderByMajor[mid] = (this.layoutOrder.subOrderByMajor[mid] || []).filter(sid => validSids.has(sid));
              (mObj && mObj.children || []).forEach(s => {
                if (this.layoutOrder.subOrderByMajor[mid].indexOf(s.id) < 0) {
                  this.layoutOrder.subOrderByMajor[mid].push(s.id);
                }
              });
            }
          });
        }
      }
    },

    async bootExternalData() {
      const optLoad = (src, globalVar) => window[globalVar] ? Promise.resolve(true) : loadExternalScript(src);
      await Promise.all([
        optLoad('tags/aux-loader.js', 'PG_MODELS'),
        optLoad('tags/tags-loader.js', '__EXT_TAG_TREE__'),
        optLoad('tags/_characters_/chars-loader.js', '__EXT_CHAR_TREE__'),
        optLoad('img/img-loader.js', '__EXT_CHAR_IMGS__'),
        optLoad('tags/_offline_db_/alias-loader.js', '__EXT_ALIAS_MAP__'),
        optLoad('tags/_offline_db_/cooc-loader.js', '__EXT_COOC_TOP25__'),
        optLoad('tags/_offline_db_/artist-loader.js', '__EXT_ARTIST_DB__'),
        optLoad('tags/_offline_db_/full-dict-loader.js', '__EXT_FULL_DICT__'),
        optLoad('js/help-loader.js', '__DEFAULT_HELP_MD__'),
        optLoad('js/changelog-loader.js', '__DEFAULT_CHANGELOG_MD__'),
        optLoad('materials/materials-loader.js', '__EXT_MATERIALS__'),
        optLoad('libraries/libraries-loader.js', '__EXT_LIBRARIES_LOADED__'),
        optLoad('js/user-data-loader.js', '__EXT_USER_DATA__')
      ]);
      if (!Array.isArray(window.__EXT_TAG_TREE__)) {
        const staticTags = await this.fetchStaticTagTree();
        if (Array.isArray(staticTags)) window.__EXT_TAG_TREE__ = staticTags;
      }
      if (!Array.isArray(window.__EXT_CHAR_TREE__)) {
        const staticChars = await this.fetchStaticCharTree();
        if (Array.isArray(staticChars)) window.__EXT_CHAR_TREE__ = staticChars;
      }
      try {
        const ru = await fetch('user-data.json', { cache: 'no-store' });
        if (ru.ok) {
          const uo = await ru.json();
          if (uo && typeof uo === 'object') window.__EXT_USER_DATA__ = uo;
        }
      } catch (e) {}
      try {
        const rl = await fetch('layout-order.json', { cache: 'no-store' });
        if (rl.ok) {
          const lo = await rl.json();
          if (lo && Array.isArray(lo.majorOrder)) this.saveLayoutLocalMirror(lo);
        }
      } catch (e) {}
      this.initSync();
    },

    /* (2.9 跨电脑打包防丢补丁) 合并两棵标签树，确保外部文件与本地新增分类/小分类/Tag 双向零丢失 */
    mergeTagTrees(baseMajors, extraMajors) {
      const out = cloneObj(Array.isArray(baseMajors) ? baseMajors : []);
      const majorMap = new Map();
      const globalTagKeys = new Set();
      out.forEach(m => {
        if (m && m.id) majorMap.set(m.id, m);
        (m && m.children || []).forEach(s => {
          (s && s.tags || []).forEach(t => {
            const rawK = String((t && t.en) || '').trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
            const k = (s && s.id === 'artist') ? ('@' + rawK.replace(/^@+/, '')) : rawK;
            if (k) globalTagKeys.add(k);
          });
        });
      });

      (Array.isArray(extraMajors) ? extraMajors : []).forEach(em => {
        if (!em || !em.id) return;
        let tm = majorMap.get(em.id);
        if (!tm) {
          tm = cloneObj(em);
          out.push(tm);
          majorMap.set(tm.id, tm);
          return;
        }
        if (em.name && tm.name === tm.id) tm.name = em.name;
        tm.children = Array.isArray(tm.children) ? tm.children : [];
        const subMap = new Map();
        tm.children.forEach(s => { if (s && s.id) subMap.set(s.id, s); });

        (em.children || []).forEach(es => {
          if (!es || !es.id) return;
          let ts = subMap.get(es.id);
          if (!ts) {
            ts = cloneObj(es);
            tm.children.push(ts);
            subMap.set(ts.id, ts);
            return;
          }
          ts.tags = Array.isArray(ts.tags) ? ts.tags : [];
          const tagKeyMap = new Map();
          ts.tags.forEach((t, idx) => {
            const k = String((t && t.en) || '').trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
            if (k) tagKeyMap.set(k, idx);
          });
          (es.tags || []).forEach(et => {
            if (!et || !et.en) return;
            const rawEt = String(et.en).trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
            const k = (es && es.id === 'artist') ? ('@' + rawEt.replace(/^@+/, '')) : rawEt;
            if (!k) return;
            const cleanK = k.replace(/^@+/, '');
            if (tagKeyMap.has(k)) {
              const exObj = ts.tags[tagKeyMap.get(k)];
              if (et.zh && !exObj.zh) exObj.zh = et.zh;
              if (et.desc && !exObj.desc) exObj.desc = et.desc;
              if (et.kw && !exObj.kw) exObj.kw = et.kw;
              if (et.count && !exObj.count) exObj.count = et.count;
              if (Array.isArray(et.topTags) && !exObj.topTags) exObj.topTags = et.topTags;
              if (!exObj.rating && et.rating) exObj.rating = et.rating;
              if (typeof exObj.nsfw !== 'boolean' && typeof et.nsfw === 'boolean') exObj.nsfw = et.nsfw;
              if (et.isNew) exObj.isNew = true;
            } else if (!globalTagKeys.has(cleanK)) {
              globalTagKeys.add(cleanK);
              tagKeyMap.set(k, ts.tags.length);
              ts.tags.push(cloneObj(et));
            }
          });
        });
      });
      return out;
    },

    initSync() {
      try {
        if (localStorage.getItem('pg_v133_migrated') !== '1') {
          localStorage.removeItem(LAYOUT_LS_KEY);
          localStorage.removeItem(TAG_TREE_LS_KEY);
          localStorage.removeItem(CHAR_TREE_LS_KEY);
          localStorage.removeItem(USER_DATA_LS_KEY);
          const rawAppLs = localStorage.getItem('pg_forge_v120');
          if (rawAppLs) {
            const parsedApp = JSON.parse(rawAppLs);
            if (parsedApp && typeof parsedApp === 'object') {
              delete parsedApp.customTagCats;
              delete parsedApp.custom;
              delete parsedApp.ratingOverrides;
              delete parsedApp.nsfwCustomOn;
              delete parsedApp.nsfwCustomOff;
              parsedApp.recentTags = [];
              parsedApp.history = [];
              parsedApp.recentChars = [];
              parsedApp.recentCharTags = [];
              parsedApp.seenNewTags = [];
              localStorage.setItem('pg_forge_v120', JSON.stringify(parsedApp));
            }
          }
          localStorage.setItem('pg_v133_migrated', '1');
        }
      } catch (e) {}
      const extTree = Array.isArray(window.__EXT_TAG_TREE__) ? cloneObj(window.__EXT_TAG_TREE__) : [];
      const extTs = String(window.__EXT_TAG_TREE_TS__ || '');
      let baseTree = extTree;

      if (extTree.length > 0) {
        try {
          const rawMirror = localStorage.getItem(TAG_TREE_LS_KEY);
          if (rawMirror) {
            const parsedM = JSON.parse(rawMirror);
            if (parsedM && Array.isArray(parsedM.majors) && parsedM.majors.length > 0) {
              if (parsedM.unsynced) {
                // 若有未落盘的离线新增/导入标签，与外部 tags-loader.js 合并，绝不互相覆盖丢失
                baseTree = this.mergeTagTrees(extTree, parsedM.majors);
              } else if (extTs && parsedM.baseTreeTs && extTs !== parsedM.baseTreeTs) {
                // 外部文件夹的 tags-loader.js 已更新（如从另一台电脑打包发来的新文件夹），以外部文件夹为准并合并
                baseTree = this.mergeTagTrees(extTree, []);
              } else {
                baseTree = this.mergeTagTrees(extTree, parsedM.majors);
              }
            }
          }
        } catch (e) {}
      }

      // 若 user-data-loader.js / user-data.json 中带有 tagTreeBackup 冗余备份，一并合并进来（跨电脑双保险）
      const extU = window.__EXT_USER_DATA__;
      if (extU && Array.isArray(extU.tagTreeBackup) && extU.tagTreeBackup.length > 0) {
        baseTree = this.mergeTagTrees(baseTree, extU.tagTreeBackup);
      }

      this.majors = baseTree;
      if (!this.majors.some(m => m && m.id === 'negative')) {
        this.majors.push({
          id: 'negative',
          name: '负面提示词',
          icon: '⛔',
          level: 1,
          order: 99,
          file: 'negative/negative.json',
          subDir: 'negative',
          updatedAt: new Date().toISOString(),
          children: []
        });
      }
      this.cleanupRedundantInTree();
      window.PG_TAGS = flattenTreeToPgTags(this.majors);

      let baseCharTree = Array.isArray(window.__EXT_CHAR_TREE__) ? cloneObj(window.__EXT_CHAR_TREE__) : [];
      if (baseCharTree.length > 0) {
        try {
          const rawCM = localStorage.getItem(CHAR_TREE_LS_KEY);
          if (rawCM) {
            const parsedCM = JSON.parse(rawCM);
            if (parsedCM && Array.isArray(parsedCM.majors) && parsedCM.majors.length > 0 && parsedCM.unsynced) {
              baseCharTree = cloneObj(parsedCM.majors);
            }
          }
        } catch (e) {}
      }
      this.charMajors = baseCharTree;
      window.PG_CHARACTERS = flattenCharTreeToPgCharacters(this.charMajors);

      this.helpMd = window.__DEFAULT_HELP_MD__ || '';
      this.changelogMd = window.__DEFAULT_CHANGELOG_MD__ || '';

      let extUser = (window.__EXT_USER_DATA__ && typeof window.__EXT_USER_DATA__ === 'object') ? window.__EXT_USER_DATA__ : null;
      try {
        const lsUser = localStorage.getItem(USER_DATA_LS_KEY);
        if (lsUser) {
          const parsedU = JSON.parse(lsUser);
          if (parsedU && typeof parsedU === 'object') {
            if (!extUser) {
              extUser = parsedU;
            } else if (parsedU.updatedAt && (!extUser.updatedAt || parsedU.updatedAt > extUser.updatedAt)) {
              // 合并外部文件与本地缓存中的自定义分类与暂存库，确保跨电脑打包与本机均不丢数据
              extUser = {
                ...extUser,
                ...parsedU,
                customTagCats: (Array.isArray(extUser.customTagCats) && extUser.customTagCats.some(c => c.tags && c.tags.length))
                  ? extUser.customTagCats
                  : (parsedU.customTagCats || extUser.customTagCats || []),
                custom: (Array.isArray(extUser.custom) && extUser.custom.length)
                  ? extUser.custom
                  : (parsedU.custom || [])
              };
            }
          }
        }
      } catch (e) {}
      this.userData = extUser;

      try {
        const savedLayout = localStorage.getItem(LAYOUT_LS_KEY);
        if (savedLayout) {
          const parsedL = JSON.parse(savedLayout);
          if (parsedL && typeof parsedL === 'object') this.layoutOrder = parsedL;
        }
      } catch (e) {}
      if (!this.layoutOrder && extUser && extUser.layoutOrder) {
        this.layoutOrder = extUser.layoutOrder;
      }
      if (!this.layoutOrder) {
        this.layoutOrder = {
          majorOrder: this.majors.map(m => m.id),
          subOrderByMajor: Object.fromEntries(this.majors.map(m => [m.id, (m.children || []).map(s => s.id)])),
          allSubOrder: this.majors.flatMap(m => (m.children || []).map(s => s.id)),
          charSubOrderByMode: {}
        };
      }
      this.cleanupRedundantInTree();
      return this.majors;
    },

    saveLocalMirror(markUnsynced) {
      this.cleanupRedundantInTree();
      window.PG_TAGS = flattenTreeToPgTags(this.majors);
      // 重要：当尚未载入完整外部词库（仅含保底 negative 1 个分类）时，绝不覆盖 localStorage 镜像！
      if (this.majors.length <= 1 && (!this.majors[0] || this.majors[0].id === 'negative') && (!this.majors[0].children || !this.majors[0].children.length)) {
        return;
      }
      try {
        let unsynced = false;
        if (typeof markUnsynced === 'boolean') {
          unsynced = markUnsynced;
        } else {
          const prevRaw = localStorage.getItem(TAG_TREE_LS_KEY);
          if (prevRaw) {
            const prev = JSON.parse(prevRaw);
            unsynced = !!(prev && prev.unsynced);
          }
        }
        localStorage.setItem(TAG_TREE_LS_KEY, JSON.stringify({
          updatedAt: new Date().toISOString(),
          baseTreeTs: String(window.__EXT_TAG_TREE_TS__ || ''),
          unsynced,
          majors: this.majors
        }));
      } catch (e) {}
    },

    saveCharLocalMirror(markUnsynced) {
      window.PG_CHARACTERS = flattenCharTreeToPgCharacters(this.charMajors);
      if (!this.charMajors || !this.charMajors.length) return;
      try {
        localStorage.setItem(CHAR_TREE_LS_KEY, JSON.stringify({
          updatedAt: new Date().toISOString(),
          unsynced: !!markUnsynced,
          majors: this.charMajors
        }));
      } catch (e) {}
    },

    saveLayoutLocalMirror(layoutObj) {
      if (layoutObj) this.layoutOrder = layoutObj;
      try {
        localStorage.setItem(LAYOUT_LS_KEY, JSON.stringify(this.layoutOrder));
      } catch (e) {}
    },

    /* (2.9 跨电脑打包落盘保障) 支持通过浏览器 File System Access API 直接写入本地项目文件夹 tags/ 与 user-data.json */
    async writeTextViaDirHandle(relPath, content) {
      if (!this.dirHandle) return false;
      try {
        const parts = String(relPath).replace(/^\/+/, '').split('/').filter(Boolean);
        let curDir = this.dirHandle;
        for (let i = 0; i < parts.length - 1; i++) {
          curDir = await curDir.getDirectoryHandle(parts[i], { create: true });
        }
        const fileHandle = await curDir.getFileHandle(parts[parts.length - 1], { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
        return true;
      } catch (e) {
        return false;
      }
    },

    async syncTreeToBrowserDirHandle() {
      if (!this.dirHandle) return false;
      try {
        const ts = new Date().toISOString();
        window.__EXT_TAG_TREE_TS__ = ts;
        await this.writeTextViaDirHandle(
          'tags/tags-loader.js',
          '/* External Tag Library Loader (auto-synced with tags/<major>/<major>_<sub>.json) */\nwindow.__EXT_TAG_TREE_TS__ = ' + JSON.stringify(ts) + ';\nwindow.__EXT_TAG_TREE__ = ' + JSON.stringify(this.majors) + ';\n'
        );
        const manifest = {
          version: 2.9,
          type: 'tag_tree_manifest',
          updatedAt: ts,
          majors: this.majors.map((m, idx) => ({
            id: m.id,
            name: m.name,
            icon: m.icon || '📁',
            order: m.order || idx + 1,
            file: `${m.id}/${m.id}.json`,
            subDir: m.id
          }))
        };
        await this.writeTextViaDirHandle('tags/index.json', JSON.stringify(manifest, null, 2) + '\n');
        for (let idx = 0; idx < this.majors.length; idx++) {
          const m = this.majors[idx];
          const mid = m.id;
          const childrenMeta = (m.children || []).map((c, cIdx) => {
            const sShort = c.id.startsWith(mid + '_') && c.id !== mid ? c.id.slice(mid.length + 1) : c.id;
            return {
              id: c.id,
              name: c.name || c.id,
              icon: c.icon || '•',
              order: c.order || cIdx + 1,
              file: `${mid}/${mid}_${sShort}.json`
            };
          });
          await this.writeTextViaDirHandle(`tags/${mid}/${mid}.json`, JSON.stringify({
            id: mid,
            name: m.name || mid,
            icon: m.icon || '📁',
            level: 1,
            order: m.order || idx + 1,
            file: `${mid}/${mid}.json`,
            subDir: mid,
            updatedAt: ts,
            children: childrenMeta
          }, null, 2) + '\n');
          for (let cIdx = 0; cIdx < (m.children || []).length; cIdx++) {
            const sub = m.children[cIdx];
            const sShort = sub.id.startsWith(mid + '_') && sub.id !== mid ? sub.id.slice(mid.length + 1) : sub.id;
            await this.writeTextViaDirHandle(`tags/${mid}/${mid}_${sShort}.json`, JSON.stringify({
              id: sub.id,
              name: sub.name || sub.id,
              icon: sub.icon || '•',
              parentId: mid,
              level: 2,
              order: sub.order || cIdx + 1,
              file: `${mid}/${mid}_${sShort}.json`,
              updatedAt: ts,
              children: [],
              tags: sub.tags || []
            }, null, 2) + '\n');
          }
        }
        return true;
      } catch (e) {
        return false;
      }
    },

    async mountBrowserDirectory() {
      if (typeof window.showDirectoryPicker !== 'function') {
        return { ok: false, error: '当前浏览器不支持目录直写，请运行「启动标签库服务.bat」' };
      }
      try {
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        if (!handle) return { ok: false };
        this.dirHandle = handle;
        this.mode = 'browser-fs';
        await this.syncTreeToBrowserDirHandle();
        if (this.userData) {
          await this.writeTextViaDirHandle('user-data.json', JSON.stringify(this.userData, null, 2) + '\n');
          await this.writeTextViaDirHandle('js/user-data-loader.js', '/* Danbooru Prompt · 用户操作数据外置加载器 */\nwindow.__EXT_USER_DATA__ = ' + JSON.stringify(this.userData) + ';\n');
        }
        this.saveLocalMirror(false);
        return { ok: true, mode: 'browser-fs', name: handle.name };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    },

    async persistUserData(uData) {
      if (!uData || typeof uData !== 'object') return;
      const payload = {
        ...uData,
        layoutOrder: this.layoutOrder,
        updatedAt: new Date().toISOString()
      };
      delete payload.undoStack;
      delete payload.redoStack;
      delete payload.tagTreeBackup;
      this.userData = payload;
      try {
        localStorage.setItem(USER_DATA_LS_KEY, JSON.stringify(payload));
      } catch (e) {}
      if (this.dirHandle) {
        await this.writeTextViaDirHandle('user-data.json', JSON.stringify(payload, null, 2) + '\n');
        await this.writeTextViaDirHandle('js/user-data-loader.js', '/* Danbooru Prompt · 用户操作数据外置加载器 */\nwindow.__EXT_USER_DATA__ = ' + JSON.stringify(payload) + ';\n');
      }
      const bases = this.getServerBases();
      for (const base of bases) {
        try {
          const r = await fetch(base + '/api/userdata', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          if (r.ok) {
            this.mode = 'server-fs';
            this.serverBase = base;
            return { ok: true, mode: 'server-fs' };
          }
        } catch (e) {}
      }
      return { ok: true, mode: this.dirHandle ? 'browser-fs' : 'local-mirror' };
    },

    async persistLayoutFile(layoutObj) {
      this.saveLayoutLocalMirror(layoutObj);
      if (this.dirHandle) {
        await this.writeTextViaDirHandle('layout-order.json', JSON.stringify(this.layoutOrder, null, 2) + '\n');
      }
      const bases = this.getServerBases();
      for (const base of bases) {
        try {
          const r = await fetch(base + '/api/layout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(this.layoutOrder)
          });
          if (r.ok) {
            this.mode = 'server-fs';
            this.serverBase = base;
            return { ok: true, mode: 'server-fs' };
          }
        } catch (e) {}
      }
      return { ok: true, mode: this.dirHandle ? 'browser-fs' : 'local-mirror' };
    },

    async syncCharsFromFlatList(flatChars) {
      const gameIps = new Set(['明日方舟','原神','崩坏：星穹铁道','鸣潮','蔚蓝档案','王者荣耀','BanG Dream!','Love Live!','偶像大师','东方Project','Fate','碧蓝航线','赛马娘','崩坏3','妮姬','绝区零','少女前线','VOCALOID','Girls Band Cry','公主连结','战双帕弥什','其他游戏']);
      const vtuberIps = new Set(['hololive']);
      const groups = [
        { id: 'games', name: '🎮 游戏', icon: '🎮', map: new Map() },
        { id: 'anime', name: '📺 番剧', icon: '📺', map: new Map() },
        { id: 'vtuber', name: '🎤 VTuber', icon: '🎤', map: new Map() },
        { id: 'custom', name: '⭐ 自定义角色', icon: '⭐', map: new Map() }
      ];
      const gById = Object.fromEntries(groups.map(g => [g.id, g]));
      (flatChars || []).forEach(c => {
        const gm = c.game || '自定义';
        let mid = c.majorId || 'custom';
        let subName = gm;
        let subId = safeId(c.subId || c.gameTag || gm);
        if (!c.majorId) {
          if (vtuberIps.has(gm)) { mid = 'vtuber'; }
          else if (gameIps.has(gm)) { mid = 'games'; }
          else if (!c.custom) { mid = 'anime'; subName = '热门番剧'; subId = 'hot_anime'; }
        }
        const grp = gById[mid] || gById.games;
        if (!grp.map.has(subId)) {
          grp.map.set(subId, {
            id: subId,
            name: subName,
            parentId: grp.id,
            file: grp.id + '/' + subId + '.json',
            characters: []
          });
        }
        grp.map.get(subId).characters.push({
          game: gm,
          gameTag: c.gameTag || subId,
          name: c.name,
          tag: c.tag,
          charZh: c.charZh || c.name,
            isNew: !!c.isNew,
          auto: Array.isArray(c.auto) ? c.auto.map(a => (a.zh ? a.en + '|' + a.zh : a.en)).join(';') : String(c.auto || '')
        });
      });
      this.charMajors = groups.map((g, idx) => ({
        id: g.id,
        name: g.name,
        icon: g.icon,
        order: idx + 1,
        file: g.id + '.json',
        subDir: g.id,
        children: Array.from(g.map.values())
      }));
      this.saveCharLocalMirror(true);
      const bases = this.getServerBases();
      for (const base of bases) {
        try {
          const r = await fetch(base + '/api/chars/op', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'sync_all', majors: this.charMajors })
          });
          if (r.ok) {
            this.mode = 'server-fs';
            this.serverBase = base;
            this.saveCharLocalMirror(false);
            break;
          }
        } catch (e) {}
      }
    },

    async fetchHelpMd() {
      const candidates = [];
      for (const base of this.getServerBases()) {
        candidates.push(base + '/api/help');
        candidates.push(base + '/help.md');
      }
      for (const u of candidates) {
        try {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 900);
          const r = await fetch(u, { signal: ctl.signal, cache: 'no-store' });
          clearTimeout(timer);
          if (r.ok) {
            if (u.endsWith('/api/help')) {
              const d = await r.json();
              if (d && d.ok && d.md) {
                this.helpMd = d.md;
                return d.md;
              }
            } else {
              const txt = await r.text();
              if (txt && txt.trim()) {
                this.helpMd = txt;
                return txt;
              }
            }
          }
        } catch (e) {}
      }
      return this.helpMd || window.__DEFAULT_HELP_MD__ || '# Danbooru Prompt\n请确保项目目录下存在 `help.md` 文件。';
    },

    async fetchChangelogMd() {
      const candidates = [];
      for (const base of this.getServerBases()) {
        candidates.push(base + '/api/changelog');
        candidates.push(base + '/update.md');
      }
      for (const u of candidates) {
        try {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 900);
          const r = await fetch(u, { signal: ctl.signal, cache: 'no-store' });
          clearTimeout(timer);
          if (r.ok) {
            if (u.endsWith('/api/changelog')) {
              const d = await r.json();
              if (d && d.ok && d.md) {
                this.changelogMd = d.md;
                return d.md;
              }
            } else {
              const txt = await r.text();
              if (txt && txt.trim()) {
                this.changelogMd = txt;
                return txt;
              }
            }
          }
        } catch (e) {}
      }
      return this.changelogMd || window.__DEFAULT_CHANGELOG_MD__ || '# 更新日志\n请确保项目目录下存在 `update.md` 文件。';
    },

    async connectExternalFiles() {
      const candidates = this.getServerBases();

      let unsyncedMirror = null;
      try {
        const rawM = localStorage.getItem(TAG_TREE_LS_KEY);
        if (rawM) {
          const pm = JSON.parse(rawM);
          if (pm && pm.unsynced && Array.isArray(pm.majors) && pm.majors.length > 0) {
            unsyncedMirror = pm.majors;
          }
        }
      } catch (e) {}

      for (const base of candidates) {
        try {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 1500);
          const r = await fetch(base + '/api/tags/tree', { signal: ctl.signal, cache: 'no-store' });
          clearTimeout(timer);
          if (r.ok) {
            const d = await r.json();
            if (d && d.ok && Array.isArray(d.majors)) {
              this.mode = 'server-fs';
              this.serverBase = base;
              let mergedTree = d.majors;
              if (unsyncedMirror) {
                mergedTree = this.mergeTagTrees(d.majors, unsyncedMirror);
                try {
                  const rs = await fetch(base + '/api/tags/op', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'sync_all', majors: mergedTree })
                  });
                  if (rs.ok) {
                    const ds = await rs.json();
                    if (ds && ds.ok && Array.isArray(ds.majors)) mergedTree = ds.majors;
                  }
                } catch (eSync) {}
              }
              this.majors = mergedTree;
              try {
                const rcClean = await fetch(base + '/api/tags/cleanup', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ validMajorIds: this.majors.map(m => m.id) })
                });
                if (rcClean.ok) {
                  const dcClean = await rcClean.json();
                  if (dcClean && dcClean.ok && Array.isArray(dcClean.majors)) {
                    this.majors = dcClean.majors;
                  }
                }
              } catch (eClean) {}
              this.saveLocalMirror(false);
              try {
                const rc = await fetch(base + '/api/chars/tree', { cache: 'no-store' });
                if (rc.ok) {
                  const dc = await rc.json();
                  if (dc && dc.ok && Array.isArray(dc.majors)) {
                    this.charMajors = dc.majors;
                    this.saveCharLocalMirror(false);
                  }
                }
              } catch (e2) {}
              try {
                const rl = await fetch(base + '/api/layout', { cache: 'no-store' });
                if (rl.ok) {
                  const dl = await rl.json();
                  if (dl && dl.ok && dl.layout) {
                    this.saveLayoutLocalMirror(dl.layout);
                  }
                }
              } catch (e3) {}
              try {
                const ru = await fetch(base + '/api/userdata', { cache: 'no-store' });
                if (ru.ok) {
                  const du = await ru.json();
                  if (du && du.ok && du.data) {
                    this.userData = du.data;
                  }
                }
              } catch (e4) {}
              return { ok: true, mode: 'server-fs', base };
            }
          }
        } catch (e) { /* try next */ }
      }
      return { ok: false, mode: this.mode };
    },

    async persistOp(payload) {
      this.saveLocalMirror(true);
      const bases = this.getServerBases();

      for (const base of bases) {
        try {
          const r = await fetch(base + '/api/tags/op', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          if (r.ok) {
            const d = await r.json();
            this.mode = 'server-fs';
            this.serverBase = base;
            if (d && d.ok && Array.isArray(d.majors)) {
              this.majors = d.majors;
            }
            this.saveLocalMirror(false);
            return { ok: true, mode: 'server-fs' };
          }
        } catch (e) {}
      }

      // 若未启动 tag-server.mjs 本地服务，且已挂载浏览器目录句柄，则直接通过 File System Access API 写入项目文件夹
      if (this.dirHandle) {
        const ok = await this.syncTreeToBrowserDirHandle();
        if (ok) {
          this.saveLocalMirror(false);
          return { ok: true, mode: 'browser-fs' };
        }
      }
      return { ok: true, mode: 'local-mirror', unsyncedToDisk: true };
    }
  };

  engine.initSync();
  window.PG_TAG_FS = engine;
})();
