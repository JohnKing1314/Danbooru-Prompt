#!/usr/bin/env node
/**
 * Danbooru Prompt V1.0 · 标签库、角色库、角色图片(img/)、排序布局与帮助文档本地同步服务 (零依赖 Node.js 标准库实现)
 * 作用：
 * 1. 托管 danbooru_prompt.html、logo.ico、help.md、update.md、layout-order.json、tags/、characters/ 与 img/ 外部目录
 * 2. 提供 REST API 扫描与实时更新 tags/<major>/<major>.json 及 tags/<major>/<major>_<sub>.json 二级标签库、
 *    支持小分类升格为大分类（创建新文件夹）与大分类降格为小分类（迁移文件并删除原大分类文件夹）
 * 3. 用户也可直接手动编辑 tags/、characters/、img/、help.md、update.md、layout-order.json 或替换 logo.ico，刷新立即生效
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { buildAppEntryHtml } from './js/app-shell.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8177);
const TAGS_DIR = path.join(__dirname, 'tags');
const CHARS_DIR = path.join(__dirname, 'tags', '_characters_');
const IMG_DIR = path.join(__dirname, 'img');
const LAYOUT_FILE = path.join(__dirname, 'layout-order.json');
const HELP_FILE = path.join(__dirname, 'help.md');
const HELP_LOADER_FILE = path.join(__dirname, 'js', 'help-loader.js');
const CHANGELOG_FILE = path.join(__dirname, 'update.md');
const CHANGELOG_LOADER_FILE = path.join(__dirname, 'js', 'changelog-loader.js');
const USER_DATA_FILE = path.join(__dirname, 'user-data.json');
const USER_DATA_LOADER_FILE = path.join(__dirname, 'js', 'user-data-loader.js');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

ensureDir(IMG_DIR);

function safeId(id) {
  return String(id || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
}

function cleanSubShortId(mid, sid) {
  const m = safeId(mid);
  let s = safeId(sid);
  if (s !== m && s.startsWith(m + '_')) {
    s = s.slice(m.length + 1);
  }
  return s || 'base';
}

function getSubFileName(mid, sid) {
  const m = safeId(mid);
  const s = cleanSubShortId(m, sid);
  return `${m}_${s}.json`;
}

function getSubRelFile(mid, sid) {
  const m = safeId(mid);
  return `${m}/${getSubFileName(m, sid)}`;
}

function getMajorRelFile(mid) {
  const m = safeId(mid);
  return `${m}/${m}.json`;
}

function safeImgBaseName(name) {
  return String(name || '')
    .trim()
    .replace(/\.\.+/g, '_')
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    return null;
  }
}

function writeJsonPretty(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * 扫描 img/ 文件夹，建立 角色图片命名 -> 相对路径 映射，并同步 img/img-loader.js
 */


// ===== V1.0 统一库目录管理 (libraries/random_schemes, libraries/templates, libraries/presets) =====
const LIBRARIES_DIR = path.join(__dirname, 'libraries');
const VALID_LIB_KINDS = new Set(['random_schemes', 'templates', 'presets']);

function safeLibFileId(rawId) {
  return String(rawId || '').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || ('item_' + Date.now().toString(36));
}

function syncLibrariesLoader() {
  const results = { random_schemes: [], templates: [], presets: [] };
  for (const kind of VALID_LIB_KINDS) {
    const dir = path.join(LIBRARIES_DIR, kind);
    fs.mkdirSync(dir, { recursive: true });
    const items = [];
    for (const fn of fs.readdirSync(dir).sort()) {
      if (!fn.endsWith('.json') || fn === 'index.json') continue;
      try {
        const obj = JSON.parse(fs.readFileSync(path.join(dir, fn), 'utf-8'));
        if (obj && typeof obj === 'object' && (obj.id || obj.key)) items.push(obj);
      } catch (e) {}
    }
    if (kind === 'presets') {
      items.sort((a, b) => {
        const ka = String(a.key || a.id || ''), kb = String(b.key || b.id || '');
        const na = /^p(\d+)$/.exec(ka), nb = /^p(\d+)$/.exec(kb);
        if (na && nb) return Number(na[1]) - Number(nb[1]);
        if (na) return -1;
        if (nb) return 1;
        return ka.localeCompare(kb);
      });
    }
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
      version: '1.0',
      kind,
      count: items.length,
      items: items.map(x => ({ id: x.id || x.key, name: x.name || '', file: safeLibFileId(x.id || x.key) + '.json' }))
    }, null, 2), 'utf-8');
    results[kind] = items;
  }
  const loaderText = [
    '/* Danbooru Prompt V1.0 · Unified Libraries Loader (libraries/{random_schemes,templates,presets}) */',
    'window.__EXT_LIBRARIES_LOADED__ = true;',
    'window.__EXT_RANDOM_SCHEMES__ = ' + JSON.stringify(results.random_schemes) + ';',
    'window.__EXT_TEMPLATES__ = ' + JSON.stringify(results.templates) + ';',
    'window.__EXT_PRESETS__ = ' + JSON.stringify(results.presets) + ';'
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(LIBRARIES_DIR, 'libraries-loader.js'), loaderText, 'utf-8');
  return results;
}

function saveLibraryItem(kind, item) {
  if (!VALID_LIB_KINDS.has(kind)) throw new Error('Invalid library kind: ' + kind);
  if (!item || typeof item !== 'object') throw new Error('Invalid item payload');
  const rawId = item.id || item.key;
  if (!rawId) throw new Error('Missing item id/key');
  const fid = safeLibFileId(rawId);
  const dir = path.join(LIBRARIES_DIR, kind);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fid + '.json'), JSON.stringify(item, null, 2), 'utf-8');
  return syncLibrariesLoader();
}

function deleteLibraryItem(kind, rawId) {
  if (!VALID_LIB_KINDS.has(kind)) throw new Error('Invalid library kind: ' + kind);
  const fid = safeLibFileId(rawId);
  const fp = path.join(LIBRARIES_DIR, kind, fid + '.json');
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  return syncLibrariesLoader();
}

// ===== V1.0 离线数据库缓存与 ComfyUI 联动接口 (/api/offline/*) =====
let _offlineCache = { alias: null, cooc: null, artist: null, meta: null };
let _offlineMtime = { alias: 0, cooc: 0, artist: 0, meta: 0 };

function loadJsGlobalJson(relFile, cacheKey) {
  try {
    const p = path.join(__dirname, relFile);
    if (!fs.existsSync(p)) return null;
    const stat = fs.statSync(p);
    if (cacheKey && _offlineCache[cacheKey] && _offlineMtime[cacheKey] === stat.mtimeMs) {
      return _offlineCache[cacheKey];
    }
    const raw = fs.readFileSync(p, 'utf-8');
    const m = raw.match(/window\.\w+\s*=\s*([\s\S]+?)\s*;?\s*$/);
    let jsonPart;
    if (m) {
      jsonPart = m[1].trim();
    } else {
      const eqIdx = raw.indexOf('=');
      if (eqIdx < 0) return null;
      jsonPart = raw.slice(eqIdx + 1).trim();
    }
    if (jsonPart.endsWith(';')) jsonPart = jsonPart.slice(0, -1).trim();
    const data = JSON.parse(jsonPart);
    if (cacheKey) {
      _offlineCache[cacheKey] = data;
      _offlineMtime[cacheKey] = stat.mtimeMs;
    }
    return data;
  } catch (e) {
    return (cacheKey && _offlineCache[cacheKey]) || null;
  }
}
function getOfflineAliasMap() {
  return loadJsGlobalJson('tags/_offline_db_/alias-loader.js', 'alias') || {};
}
function getOfflineCoocMap() {
  return loadJsGlobalJson('tags/_offline_db_/cooc-loader.js', 'cooc') || {};
}
function getOfflineArtistDb() {
  return loadJsGlobalJson('tags/_offline_db_/artist-loader.js', 'artist') || { artists: {}, tagToArtists: {} };
}

function getImgSubDirRel(baseName) {
  const parts = String(baseName || '').toLowerCase().split('_');
  if (parts.length >= 2 && ['game', 'anime', 'vtuber', 'custom'].includes(parts[0])) {
    const l1 = parts[0].replace(/[\\/:*?"<>|]+/g, ' ').trim();
    const l2 = parts[1].replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'other';
    return path.join(l1, l2);
  }
  return 'other';
}

function walkCharImages(dir, relPrefix, map, validExts) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = relPrefix ? (relPrefix + '/' + e.name) : e.name;
    if (e.isDirectory()) {
      walkCharImages(full, rel, map, validExts);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (!validExts.has(ext)) continue;
      const base = e.name.slice(0, e.name.length - ext.length);
      const key = base.toLowerCase();
      if (!map[key] || ext === '.png') {
        map[key] = 'img/' + rel;
      }
    }
  }
}

function scanCharImages() {
  ensureDir(IMG_DIR);
  const map = {};
  const validExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
  walkCharImages(IMG_DIR, '', map, validExts);
  try {
    fs.writeFileSync(
      path.join(IMG_DIR, 'img-loader.js'),
      '/* Character Image Folder Index (auto-synced with img/*) */\nwindow.__EXT_CHAR_IMGS__ = ' + JSON.stringify(map) + ';\n',
      'utf-8'
    );
  } catch (e) {}
  return map;
}

scanCharImages();
cleanupRedundantTagFolders();
syncManifest(scanTagTree());

/**
 * 扫描 tags/ 文件夹，读取各主分类文件夹 tags/<mid>/<mid>.json 与 tags/<mid>/<mid>_<sid>.json，返回完整二级树
 */
/**
 * (2.9 Req 3) 检查 tags/ 下是否存在冗余分类文件夹或孤立 JSON 文件并自动删除
 */
function cleanupRedundantTagFolders(validMajorIdsOpt = null) {
  ensureDir(TAGS_DIR);
  const indexFile = path.join(TAGS_DIR, 'index.json');
  const manifest = readJsonSafe(indexFile);
  let validMajorIds = null;
  if (Array.isArray(validMajorIdsOpt) && validMajorIdsOpt.length > 0) {
    validMajorIds = new Set(validMajorIdsOpt.map(id => safeId(id)));
  } else if (manifest && Array.isArray(manifest.majors) && manifest.majors.length > 0) {
    validMajorIds = new Set(manifest.majors.map(m => safeId(m.id)));
  }

  const removedDirs = [];
  const removedFiles = [];
  const entries = fs.readdirSync(TAGS_DIR, { withFileTypes: true });

  for (const e of entries) {
    if (e.isDirectory()) {
      const mid = e.name;
      if (mid === '_characters_' || mid === 'characters' || mid.startsWith('_')) continue;
      const mJsonPath = path.join(TAGS_DIR, mid, `${mid}.json`);
      const isRedundant = (validMajorIds && !validMajorIds.has(mid)) || !fs.existsSync(mJsonPath);
      if (isRedundant) {
        try {
          fs.rmSync(path.join(TAGS_DIR, mid), { recursive: true, force: true });
          removedDirs.push(mid);
        } catch (err) {}
      } else {
        // 检查该大分类文件夹内是否有不在 children 列表中的冗余小分类文件
        const mData = readJsonSafe(mJsonPath);
        if (mData && Array.isArray(mData.children)) {
          const validSubFiles = new Set([
            `${mid}.json`,
            ...mData.children.map(c => getSubFileName(mid, c.id))
          ]);
          const subEntries = fs.readdirSync(path.join(TAGS_DIR, mid), { withFileTypes: true });
          for (const se of subEntries) {
            if (se.isFile() && se.name.endsWith('.json') && !validSubFiles.has(se.name)) {
              try {
                fs.unlinkSync(path.join(TAGS_DIR, mid, se.name));
                removedFiles.push(`${mid}/${se.name}`);
              } catch (err) {}
            }
          }
        }
      }
    } else if (e.isFile() && e.name.endsWith('.json') && e.name !== 'index.json') {
      try {
        fs.unlinkSync(path.join(TAGS_DIR, e.name));
        removedFiles.push(e.name);
      } catch (err) {}
    }
  }
  return { removedDirs, removedFiles };
}

function scanTagTree() {
  ensureDir(TAGS_DIR);
  const indexFile = path.join(TAGS_DIR, 'index.json');
  const manifest = readJsonSafe(indexFile) || { version: '1.0', majors: [] };
  const majorOrderMap = new Map();
  (manifest.majors || []).forEach((m, idx) => majorOrderMap.set(m.id, m.order || idx + 1));

  const entries = fs.readdirSync(TAGS_DIR, { withFileTypes: true });
  const subDirs = entries.filter(e => e.isDirectory() && e.name !== '_characters_' && e.name !== 'characters' && !e.name.startsWith('_'));

  const majors = [];
  for (const dirEntry of subDirs) {
    const mid = dirEntry.name;
    const subDir = path.join(TAGS_DIR, mid);
    let mPath = path.join(subDir, `${mid}.json`);
    if (!fs.existsSync(mPath)) {
      const legacyPath = path.join(TAGS_DIR, `${mid}.json`);
      if (fs.existsSync(legacyPath)) mPath = legacyPath;
    }
    const mData = readJsonSafe(mPath);
    if (!mData || !mData.id) continue;

    const subOrderMap = new Map();
    (mData.children || []).forEach((c, idx) => subOrderMap.set(c.id, c.order || idx + 1));

    const children = [];
    const subFiles = fs.readdirSync(subDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.json') && e.name !== `${mid}.json`);

    for (const sf of subFiles) {
      const sPath = path.join(subDir, sf.name);
      const sData = readJsonSafe(sPath);
      if (!sData || !sData.id) continue;
      children.push({
        id: sData.id,
        name: sData.name || sData.id,
        icon: sData.icon || '•',
        parentId: mid,
        level: 2,
        order: sData.order || subOrderMap.get(sData.id) || 999,
        file: `${mid}/${sf.name}`,
        updatedAt: sData.updatedAt || new Date().toISOString(),
        children: Array.isArray(sData.children) ? sData.children : [],
        tags: Array.isArray(sData.tags) ? sData.tags : []
      });
    }
    children.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
    majors.push({
      id: mid,
      name: mData.name || mid,
      icon: mData.icon || '📁',
      level: 1,
      order: mData.order || majorOrderMap.get(mid) || 999,
      file: getMajorRelFile(mid),
      subDir: mid,
      updatedAt: mData.updatedAt || new Date().toISOString(),
      children
    });
  }
  majors.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
  return majors;
}

function syncTagLoaderJs(majors) {
  try {
    const loaderPath = path.join(TAGS_DIR, 'tags-loader.js');
    const ts = new Date().toISOString();
    fs.writeFileSync(
      loaderPath,
      '/* External Tag Library Loader (auto-synced with tags/<major>/<major>_<sub>.json) */\nwindow.__EXT_TAG_TREE_TS__ = ' + JSON.stringify(ts) + ';\nwindow.__EXT_TAG_TREE__ = ' + JSON.stringify(majors) + ';\n',
      'utf-8'
    );
  } catch (e) {}
}

function syncManifest(majors) {
  syncTagLoaderJs(majors);
  const indexFile = path.join(TAGS_DIR, 'index.json');
  const manifest = {
    version: '1.0',
    type: 'tag_tree_manifest',
    updatedAt: new Date().toISOString(),
    majors: majors.map((m, idx) => ({
      id: m.id,
      name: m.name,
      icon: m.icon || '📁',
      order: m.order || idx + 1,
      file: getMajorRelFile(m.id),
      subDir: m.id
    }))
  };
  writeJsonPretty(indexFile, manifest);
}

function writeSubFile(majorId, sub) {
  const mid = safeId(majorId);
  const sid = safeId(sub.id);
  const subDir = path.join(TAGS_DIR, mid);
  ensureDir(subDir);
  const relFile = getSubRelFile(mid, sid);
  const fileName = getSubFileName(mid, sid);
  const isNsfwMajor = (mid === 'nsfw_group');

  const normTags = Array.isArray(sub.tags)
    ? sub.tags.map(t => {
        const en = String(t.en || '').trim();
        const zh = String(t.zh || '').trim();
        const desc = String(t.desc || '').trim();
        if (!en) return null;
        const item = { en, zh };
        if (desc) item.desc = desc;
        if (t.kw) item.kw = String(t.kw).trim();
        if (t.count) item.count = Number(t.count) || 0;
        if (Array.isArray(t.topTags) && t.topTags.length) item.topTags = t.topTags;
        const rating = ['g', 's', 'q', 'e'].includes(t.rating) ? t.rating : ((t.nsfw === true || (isNsfwMajor && t.nsfw !== false)) ? 'e' : 'g');
        item.rating = rating;
        item.nsfw = (rating === 'q' || rating === 'e');
        if (t.isNew) item.isNew = true;
        return item;
      }).filter(Boolean)
    : [];

  const subObj = {
    id: sid,
    name: sub.name || sid,
    icon: sub.icon || '•',
    parentId: mid,
    level: 2,
    order: sub.order || 99,
    file: relFile,
    updatedAt: new Date().toISOString(),
    children: Array.isArray(sub.children) ? sub.children : [],
    tags: normTags
  };
  writeJsonPretty(path.join(subDir, fileName), subObj);
  // 清理旧版未加前缀的同名文件（如 tags/character/base.json）
  const legacyPath = path.join(subDir, `${sid}.json`);
  if (fileName !== `${sid}.json` && fs.existsSync(legacyPath) && `${sid}.json` !== `${mid}.json`) {
    try { fs.unlinkSync(legacyPath); } catch (e) {}
  }
}

function writeMajorFile(major, includeChildrenFiles = false) {
  const mid = safeId(major.id);
  const subDir = path.join(TAGS_DIR, mid);
  ensureDir(subDir);
  const now = new Date().toISOString();
  const childrenMeta = (major.children || []).map((c, idx) => {
    const sid = safeId(c.id);
    return {
      id: sid,
      name: c.name || sid,
      icon: c.icon || '•',
      order: c.order || idx + 1,
      file: getSubRelFile(mid, sid)
    };
  });
  const majorObj = {
    id: mid,
    name: major.name || mid,
    icon: major.icon || '📁',
    level: 1,
    order: major.order || 99,
    file: getMajorRelFile(mid),
    subDir: mid,
    updatedAt: now,
    children: childrenMeta
  };
  writeJsonPretty(path.join(subDir, `${mid}.json`), majorObj);
  // 清理旧版根目录下遗留的 tags/<mid>.json
  const legacyTopMajor = path.join(TAGS_DIR, `${mid}.json`);
  if (fs.existsSync(legacyTopMajor)) {
    try { fs.unlinkSync(legacyTopMajor); } catch (e) {}
  }
  if (Array.isArray(major.children)) {
    const validFiles = new Set([`${mid}.json`]);
    major.children.forEach((sub, idx) => {
      const sid = safeId(sub.id);
      validFiles.add(getSubFileName(mid, sid));
      if (includeChildrenFiles || Array.isArray(sub.tags)) {
        writeSubFile(mid, { ...sub, order: sub.order || idx + 1 });
      }
    });
    // 清理该大分类文件夹下已被移走或删除的小分类 JSON 文件
    const existing = fs.readdirSync(subDir, { withFileTypes: true });
    for (const e of existing) {
      if (e.isFile() && e.name.endsWith('.json') && !validFiles.has(e.name)) {
        try { fs.unlinkSync(path.join(subDir, e.name)); } catch (err) {}
      }
    }
  }
}

function reconcileAllTagFiles(majors) {
  ensureDir(TAGS_DIR);
  const activeMajorIds = new Set((majors || []).map(m => safeId(m.id)));
  const entries = fs.readdirSync(TAGS_DIR, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory() && e.name !== '_characters_' && e.name !== 'characters' && !e.name.startsWith('_') && !activeMajorIds.has(e.name)) {
      try { fs.rmSync(path.join(TAGS_DIR, e.name), { recursive: true, force: true }); } catch (err) {}
    } else if (e.isFile() && e.name.endsWith('.json') && e.name !== 'index.json') {
      try { fs.unlinkSync(path.join(TAGS_DIR, e.name)); } catch (err) {}
    }
  }
  (majors || []).forEach((m, idx) => {
    writeMajorFile({ ...m, order: m.order || idx + 1 }, true);
  });
  const scanned = scanTagTree();
  syncManifest(scanned);
  return scanned;
}

/**
 * 扫描 characters/ 文件夹，读取外部角色库树
 */
function scanCharTree() {
  ensureDir(CHARS_DIR);
  const entries = fs.readdirSync(CHARS_DIR, { withFileTypes: true });
  const majorFiles = entries.filter(e => e.isFile() && e.name.endsWith('.json') && e.name !== 'index.json');
  const majors = [];
  for (const mf of majorFiles) {
    const mData = readJsonSafe(path.join(CHARS_DIR, mf.name));
    if (!mData || !mData.id) continue;
    const mid = mData.id;
    const subDir = path.join(CHARS_DIR, mData.subDir || mid);
    const children = [];
    if (fs.existsSync(subDir) && fs.statSync(subDir).isDirectory()) {
      const subFiles = fs.readdirSync(subDir, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.json'));
      for (const sf of subFiles) {
        const sData = readJsonSafe(path.join(subDir, sf.name));
        if (sData && sData.id) children.push(sData);
      }
    }
    children.sort((a, b) => (a.order || 999) - (b.order || 999) || String(a.id || '').localeCompare(String(b.id || '')));
    const subRel = mData.subDir || mid;
    const childrenMeta = children.map((s, sIdx) => ({
      id: s.id,
      name: s.name || s.id,
      order: sIdx + 1,
      count: Array.isArray(s.characters) ? s.characters.length : 0,
      file: `${subRel}/${s.id}.json`
    }));
    const totalCount = childrenMeta.reduce((acc, c) => acc + c.count, 0);
    if (JSON.stringify(mData.children || []) !== JSON.stringify(childrenMeta) || mData.count !== totalCount) {
      try {
        writeJsonPretty(path.join(CHARS_DIR, ent.name), {
          id: mid,
          name: mData.name || mid,
          icon: mData.icon || '🎮',
          order: mData.order || 99,
          file: ent.name,
          subDir: subRel,
          children: childrenMeta,
          count: totalCount
        });
      } catch (e) {}
    }
    majors.push({ ...mData, count: totalCount, children });
  }
  majors.sort((a, b) => (a.order || 99) - (b.order || 99));
  return majors;
}

function writeCharTreeAll(majors) {
  ensureDir(CHARS_DIR);
  const manifestMajors = [];
  (majors || []).forEach((m, idx) => {
    const mid = safeId(m.id);
    const subDir = path.join(CHARS_DIR, mid);
    ensureDir(subDir);
    const childrenMeta = [];
    (m.children || []).forEach((s, sIdx) => {
      const sid = safeId(s.id);
      const sObj = {
        id: sid,
        name: s.name || sid,
        parentId: mid,
        order: sIdx + 1,
        file: `${mid}/${sid}.json`,
        characters: Array.isArray(s.characters) ? s.characters : []
      };
      writeJsonPretty(path.join(subDir, `${sid}.json`), sObj);
      childrenMeta.push({ id: sid, name: sObj.name, order: sIdx + 1, count: sObj.characters.length, file: sObj.file });
    });
    const validCharSubFiles = new Set(childrenMeta.map(c => `${c.id}.json`));
    for (const se of fs.readdirSync(subDir, { withFileTypes: true })) {
      if (se.isFile() && se.name.endsWith(".json") && !validCharSubFiles.has(se.name)) {
        try { fs.unlinkSync(path.join(subDir, se.name)); } catch (e) {}
      }
    }
    const mObj = {
      id: mid,
      name: m.name || mid,
      icon: m.icon || '🎮',
      order: idx + 1,
      file: `${mid}.json`,
      subDir: mid,
      children: childrenMeta
    };
    writeJsonPretty(path.join(CHARS_DIR, `${mid}.json`), mObj);
    manifestMajors.push({ id: mid, name: mObj.name, icon: mObj.icon, order: idx + 1, file: mObj.file });
  });
  try { fs.writeFileSync(path.join(CHARS_DIR, 'chars-loader.js'), 'window.__EXT_CHAR_TREE__ = ' + JSON.stringify(scanCharTree()) + ';\n', 'utf-8'); } catch (e) {}
  writeJsonPretty(path.join(CHARS_DIR, 'index.json'), {
    app: 'Danbooru Prompt',
    version: '1.0',
    type: 'character_tree_manifest',
    majors: manifestMajors
  });
}

const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml'
};

function corsOrigin(req) {
  const origin = req && req.headers && req.headers.origin;
  if (!origin) return '*';
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return origin;
  if (origin === 'null') return 'null';
  return 'http://127.0.0.1';
}

function sendJson(res, status, obj, req) {
  const r = req || res.req;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': corsOrigin(r),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLen = 0;
    let destroyed = false;
    req.on('data', chunk => {
      if (destroyed) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalLen += buf.length;
      if (totalLen > 35 * 1024 * 1024) {
        destroyed = true;
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (destroyed) return;
      try {
        const data = Buffer.concat(chunks).toString('utf-8');
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', (err) => { if (!destroyed) reject(err); });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': corsOrigin(req),
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    // 1. 获取整棵外部文件标签树（每次打开时自动检查并清理 tags/ 内冗余分类文件夹 - 2.9 Req 3）
    if (pathname === '/api/translate' && req.method === 'POST') {
      const body = await readBody(req);
      const q = String(body.q || '').trim();
      const sl = String(body.from || 'auto').trim() || 'auto';
      const tl = String(body.to || 'en').trim() || 'en';
      if (!q) return sendJson(res, 200, { ok: true, text: '' });
      const effFrom = sl === 'auto' ? (/[\u4e00-\u9fff]/.test(q) ? 'zh-CN' : 'en') : sl;

      // 1. 优先调用国内直连免 VPN 的有道翻译接口 (aidemo.youdao.com & fanyi.youdao.com)
      try {
        const ydFrom = effFrom === 'zh-CN' ? 'zh-CHS' : effFrom;
        const ydTo = tl === 'zh-CN' ? 'zh-CHS' : tl;
        const params = new URLSearchParams({ q, from: ydFrom, to: ydTo });
        const ar = await fetch('https://aidemo.youdao.com/trans', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
          body: params.toString(),
          signal: AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined
        });
        if (ar.ok) {
          const aj = await ar.json();
          if (aj && String(aj.errorCode) === '0' && Array.isArray(aj.translation) && aj.translation.length) {
            const txt = aj.translation.join('\n').trim();
            if (txt) return sendJson(res, 200, { ok: true, text: txt, engine: '有道翻译' });
          }
        }
      } catch (eYd1) {}

      try {
        const typeKey = `${effFrom}->${tl}`;
        const typeMap = {
          'zh-CN->en': 'ZH_CN2EN',
          'en->zh-CN': 'EN2ZH_CN',
          'zh-CN->ja': 'ZH_CN2JA',
          'ja->zh-CN': 'JA2ZH_CN'
        };
        const ydType = typeMap[typeKey] || 'AUTO';
        const yUrl = `http://fanyi.youdao.com/translate?&doctype=json&type=${ydType}&i=${encodeURIComponent(q)}`;
        const yr = await fetch(yUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined
        });
        if (yr.ok) {
          const yj = await yr.json();
          if (yj && yj.errorCode === 0 && Array.isArray(yj.translateResult)) {
            const txt = yj.translateResult
              .map(para => Array.isArray(para) ? para.map(seg => (seg && seg.tgt) || '').join('') : '')
              .join('\n')
              .trim();
            if (txt) return sendJson(res, 200, { ok: true, text: txt, engine: '有道翻译' });
          }
        }
      } catch (eYd2) {}

      // 2. 备用免 VPN MyMemory 接口
      try {
        const mUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=${encodeURIComponent(effFrom + '|' + tl)}`;
        const mr = await fetch(mUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined
        });
        if (mr.ok) {
          const mj = await mr.json();
          const mt = mj && mj.responseData && mj.responseData.translatedText;
          if (mt && !/MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(String(mt))) {
            return sendJson(res, 200, { ok: true, text: String(mt).trim(), engine: 'MyMemory' });
          }
        }
      } catch (eMm) {}
      return sendJson(res, 502, { ok: false, error: 'Translation failed' });
    }

    if (pathname === '/api/tags/tree' && req.method === 'GET') {
      const cleaned = cleanupRedundantTagFolders();
      const majors = scanTagTree();
      syncManifest(majors);
      return sendJson(res, 200, { ok: true, mode: 'server-fs', tagsDir: TAGS_DIR, majors, cleaned });
    }

    if (pathname === '/api/tags/cleanup' && req.method === 'POST') {
      const body = await readBody(req);
      const cleaned = cleanupRedundantTagFolders(Array.isArray(body.validMajorIds) ? body.validMajorIds : null);
      const majors = scanTagTree();
      syncManifest(majors);
      return sendJson(res, 200, { ok: true, cleaned, majors });
    }

    // 2. 标签双向联动持久化操作接口
    if (pathname === '/api/tags/op' && req.method === 'POST') {
      const body = await readBody(req);
      const { action } = body;

      if (action === 'save_major') {
        const { major, includeChildren } = body;
        if (!major || !major.id) return sendJson(res, 400, { ok: false, error: '缺少 major.id' });
        writeMajorFile(major, !!includeChildren);
        const majors = scanTagTree();
        syncManifest(majors);
        return sendJson(res, 200, { ok: true, majors });
      }

      if (action === 'rename_major') {
        const { oldId, newId, name, icon, major } = body;
        const oId = safeId(oldId);
        const nId = safeId(newId || oldId);
        const oldDir = path.join(TAGS_DIR, oId);
        let tempBackup = null;
        if (oId !== nId && fs.existsSync(oldDir)) {
          tempBackup = oldDir + '__backup_' + Date.now();
          fs.renameSync(oldDir, tempBackup);
        }
        try {
          if (major) {
            writeMajorFile({ ...major, id: nId, name: name || major.name, icon: icon || major.icon }, true);
          }
          // 写入成功，删除备份
          if (tempBackup && fs.existsSync(tempBackup)) {
            fs.rmSync(tempBackup, { recursive: true, force: true });
          }
        } catch (writeErr) {
          // 写入失败，恢复备份
          if (tempBackup && fs.existsSync(tempBackup)) {
            try { fs.renameSync(tempBackup, oldDir); } catch (e) {}
          }
          throw writeErr;
        }
        const majors = scanTagTree();
        syncManifest(majors);
        return sendJson(res, 200, { ok: true, majors });
      }

      if (action === 'delete_major') {
        const mid = safeId(body.majorId);
        const mDir = path.join(TAGS_DIR, mid);
        const legacyFile = path.join(TAGS_DIR, `${mid}.json`);
        if (fs.existsSync(legacyFile)) fs.unlinkSync(legacyFile);
        if (fs.existsSync(mDir)) fs.rmSync(mDir, { recursive: true, force: true });
        const majors = scanTagTree();
        syncManifest(majors);
        return sendJson(res, 200, { ok: true, majors });
      }

      if (action === 'save_sub') {
        const { majorId, sub, major } = body;
        if (!majorId || !sub || !sub.id) return sendJson(res, 400, { ok: false, error: '缺少 majorId 或 sub.id' });
        writeSubFile(majorId, sub);
        if (major) writeMajorFile(major, false);
        const majors = scanTagTree();
        syncManifest(majors);
        return sendJson(res, 200, { ok: true, majors });
      }

      if (action === 'rename_sub') {
        const { majorId, oldSubId, sub, major } = body;
        const mid = safeId(majorId);
        const oSid = safeId(oldSubId);
        const nSid = safeId(sub.id);
        if (oSid !== nSid) {
          const oldPath = path.join(TAGS_DIR, mid, getSubFileName(mid, oSid));
          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }
        writeSubFile(mid, sub);
        if (major) writeMajorFile(major, false);
        const majors = scanTagTree();
        syncManifest(majors);
        return sendJson(res, 200, { ok: true, majors });
      }

      if (action === 'delete_sub') {
        const { majorId, subId, major } = body;
        const mid = safeId(majorId);
        const sid = safeId(subId);
        const sPath = path.join(TAGS_DIR, mid, getSubFileName(mid, sid));
        if (fs.existsSync(sPath)) fs.unlinkSync(sPath);
        if (major) writeMajorFile(major, false);
        const majors = scanTagTree();
        syncManifest(majors);
        return sendJson(res, 200, { ok: true, majors });
      }

      if (action === 'move_sub') {
        const { fromMajorId, toMajorId, subId, fromMajor, toMajor, sub } = body;
        if (fromMajorId && subId) {
          const fMid = safeId(fromMajorId);
          const oldSubPath = path.join(TAGS_DIR, fMid, getSubFileName(fMid, subId));
          if (fs.existsSync(oldSubPath)) fs.unlinkSync(oldSubPath);
        }
        if (fromMajor) writeMajorFile(fromMajor, false);
        if (toMajorId && sub) writeSubFile(toMajorId, sub);
        if (toMajor) writeMajorFile(toMajor, false);
        const majors = scanTagTree();
        syncManifest(majors);
        return sendJson(res, 200, { ok: true, majors });
      }

      if (action === 'promote_sub_to_major') {
        const { oldMajorId, subId, updatedOldMajor, newMajor } = body;
        if (oldMajorId && subId) {
          const oMid = safeId(oldMajorId);
          const oldSubPath = path.join(TAGS_DIR, oMid, getSubFileName(oMid, subId));
          if (fs.existsSync(oldSubPath)) fs.unlinkSync(oldSubPath);
        }
        if (updatedOldMajor) writeMajorFile(updatedOldMajor, false);
        if (newMajor) writeMajorFile(newMajor, true);
        const majors = scanTagTree();
        syncManifest(majors);
        return sendJson(res, 200, { ok: true, majors });
      }

      if (action === 'demote_major_to_sub') {
        const { oldMajorId, targetMajor } = body;
        if (oldMajorId) {
          const oMid = safeId(oldMajorId);
          const oldDir = path.join(TAGS_DIR, oMid);
          if (fs.existsSync(oldDir)) fs.rmSync(oldDir, { recursive: true, force: true });
        }
        if (targetMajor) writeMajorFile(targetMajor, true);
        const majors = scanTagTree();
        syncManifest(majors);
        return sendJson(res, 200, { ok: true, majors });
      }

      if (action === 'move_tag') {
        const { fromMajorId, fromSub, toMajorId, toSub } = body;
        if (fromMajorId && fromSub) writeSubFile(fromMajorId, fromSub);
        if (toMajorId && toSub) writeSubFile(toMajorId, toSub);
        const majors = scanTagTree();
        syncManifest(majors);
        return sendJson(res, 200, { ok: true, majors });
      }

      if (action === 'sync_all') {
        const { majors } = body;
        if (!Array.isArray(majors)) return sendJson(res, 400, { ok: false, error: 'majors 必须是数组' });
        const scanned = reconcileAllTagFiles(majors);
        return sendJson(res, 200, { ok: true, majors: scanned });
      }

      return sendJson(res, 400, { ok: false, error: '未知操作: ' + action });
    }

    // 3. 角色库外部文件树读取与同步接口
    if (pathname === '/api/chars/tree' && req.method === 'GET') {
      const majors = scanCharTree();
      return sendJson(res, 200, { ok: true, majors });
    }

    if (pathname === '/api/chars/op' && req.method === 'POST') {
      const body = await readBody(req);
      if (Array.isArray(body.majors)) {
        writeCharTreeAll(body.majors);
      }
      return sendJson(res, 200, { ok: true, majors: scanCharTree() });
    }

    // 3.5 角色图片子文件夹 img/ 读取与上传保存接口
    if (pathname === '/api/char-img/list' && req.method === 'GET') {
      const map = scanCharImages();
      return sendJson(res, 200, { ok: true, map });
    }

    if (pathname === '/api/char-img' && req.method === 'POST') {
      const body = await readBody(req);
      const baseName = safeImgBaseName(body.baseName);
      if (!baseName) return sendJson(res, 400, { ok: false, error: '缺少有效的图片命名 baseName' });
      ensureDir(IMG_DIR);
      const subDirRel = getImgSubDirRel(baseName);
      const targetDir = path.join(IMG_DIR, subDirRel);
      ensureDir(targetDir);
      const exts = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
      for (const dirToClean of [IMG_DIR, targetDir]) {
        for (const ext of exts) {
          const oldPath = path.join(dirToClean, baseName + ext);
          if (fs.existsSync(oldPath)) {
            try { fs.unlinkSync(oldPath); } catch (e) {}
          }
        }
      }
      if (body.action === 'delete') {
        const map = scanCharImages();
        return sendJson(res, 200, { ok: true, deleted: true, map });
      }
      const dataUrl = String(body.dataUrl || '');
      const m = dataUrl.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
      if (!m) return sendJson(res, 400, { ok: false, error: '无效的图片 dataUrl' });
      let subtype = m[1].toLowerCase();
      let ext = '.png';
      if (subtype === 'jpeg' || subtype === 'jpg') ext = '.jpg';
      else if (subtype === 'webp') ext = '.webp';
      else if (subtype === 'gif') ext = '.gif';
      if (body.preferPng) ext = '.png';
      const buf = Buffer.from(m[2], 'base64');
      const relPosix = subDirRel.split(path.sep).join('/') + '/' + baseName + ext;
      const relPath = 'img/' + relPosix;
      fs.writeFileSync(path.join(targetDir, baseName + ext), buf);
      const map = scanCharImages();
      return sendJson(res, 200, { ok: true, path: relPath, baseName, map });
    }

    // 4. 拖拽自定义排序布局文件 layout-order.json 读取与写入接口
    if (pathname === '/api/layout' && req.method === 'GET') {
      const layout = readJsonSafe(LAYOUT_FILE);
      return sendJson(res, 200, { ok: !!layout, layout });
    }

    if (pathname === '/api/layout' && req.method === 'POST') {
      const body = await readBody(req);
      const layoutObj = {
        app: 'Danbooru Prompt',
        version: '1.0',
        type: 'layout_order',
        note: '仅影响页面大分类与小分类展示排序，不修改标签库数据文件',
        updatedAt: new Date().toISOString(),
        majorOrder: Array.isArray(body.majorOrder) ? body.majorOrder : [],
        subOrderByMajor: (body.subOrderByMajor && typeof body.subOrderByMajor === 'object') ? body.subOrderByMajor : {},
        allSubOrder: Array.isArray(body.allSubOrder) ? body.allSubOrder : [],
        charSubOrderByMode: (body.charSubOrderByMode && typeof body.charSubOrderByMode === 'object') ? body.charSubOrderByMode : {}
      };
      writeJsonPretty(LAYOUT_FILE, layoutObj);
      return sendJson(res, 200, { ok: true, layout: layoutObj });
    }

    // 5. 帮助文档 help.md 与更新日志 update.md 读取接口
    if (pathname === '/api/help' && req.method === 'GET') {
      const md = fs.existsSync(HELP_FILE) ? fs.readFileSync(HELP_FILE, 'utf-8') : '';
      if (md) {
        try {
          fs.mkdirSync(path.dirname(HELP_LOADER_FILE), { recursive: true });
          fs.writeFileSync(HELP_LOADER_FILE, '/* External Help Markdown Loader (synced with help.md) */\nwindow.__DEFAULT_HELP_MD__ = ' + JSON.stringify(md) + ';\n', 'utf-8');
        } catch (e) {}
      }
      return sendJson(res, 200, { ok: true, md });
    }
    if (pathname === '/api/changelog' && req.method === 'GET') {
      const md = fs.existsSync(CHANGELOG_FILE) ? fs.readFileSync(CHANGELOG_FILE, 'utf-8') : '';
      if (md) {
        try {
          fs.mkdirSync(path.dirname(CHANGELOG_LOADER_FILE), { recursive: true });
          fs.writeFileSync(CHANGELOG_LOADER_FILE, '/* External Changelog Markdown Loader (synced with update.md) */\nwindow.__DEFAULT_CHANGELOG_MD__ = ' + JSON.stringify(md) + ';\n', 'utf-8');
        } catch (e) {}
      }
      return sendJson(res, 200, { ok: true, md });
    }

    // 5.5 用户操作数据文件 user-data.json 读取与写入接口
    if (pathname === '/api/userdata' && req.method === 'GET') {
      const udata = readJsonSafe(USER_DATA_FILE);
      return sendJson(res, 200, { ok: !!udata, data: udata });
    }

    if (pathname === '/api/userdata' && req.method === 'POST') {
      const body = await readBody(req);
      const uObj = {
        app: 'Danbooru Prompt',
        version: '1.0',
        type: 'user_operation_data',
        note: '保存用户的收藏、最近使用、提示词历史、存档、自定义词条、NSFW红底标记、随机组合规则与排序布局',
        updatedAt: new Date().toISOString(),
        ...body
      };
      delete uObj.undoStack;
      delete uObj.redoStack;
      delete uObj.tagTreeBackup;
      writeJsonPretty(USER_DATA_FILE, uObj);
      try {
        fs.mkdirSync(path.dirname(USER_DATA_LOADER_FILE), { recursive: true });
        fs.writeFileSync(USER_DATA_LOADER_FILE, '/* Danbooru Prompt · 用户操作数据外置加载器 */\nwindow.__EXT_USER_DATA__ = ' + JSON.stringify(uObj) + ';\n', 'utf-8');
      } catch (e) {}
      return sendJson(res, 200, { ok: true, data: uObj });
    }

    // 5.8 V1.0 离线智能引擎与 ComfyUI 联动接口 (/api/offline/*)
    if (pathname === '/api/offline/meta' && req.method === 'GET') {
      const meta = readJsonSafe(path.join(TAGS_DIR, '_offline_db_', 'offline-meta.json')) || {};
      return sendJson(res, 200, { ok: true, version: '1.3.0', meta });
    }
    if (pathname === '/api/offline/resolve-alias' && req.method === 'POST') {
      const body = await readBody(req);
      const amap = getOfflineAliasMap();
      const list = Array.isArray(body.tags) ? body.tags : (body.tag ? [body.tag] : []);
      const results = list.map(raw => {
        const k = String(raw || '').trim().toLowerCase().replace(/\s+/g, '_');
        const target = amap[k] || amap[k.replace(/_/g, ' ')] || k;
        return { input: raw, canonical: target.replace(/_/g, ' '), aliased: target !== k };
      });
      return sendJson(res, 200, { ok: true, results });
    }
    if (pathname === '/api/offline/recommend' && req.method === 'POST') {
      const body = await readBody(req);
      const cooc = getOfflineCoocMap();
      const seeds = Array.isArray(body.tags) ? body.tags : [];
      const topK = Math.min(50, Math.max(1, Number(body.topK) || 12));
      const seedSet = new Set(seeds.map(s => String(s || '').trim().toLowerCase().replace(/\s+/g, '_')));
      const scores = new Map();
      for (const s of seedSet) {
        const nbs = cooc[s] || [];
        for (const [nb, npmi] of nbs) {
          if (seedSet.has(nb)) continue;
          const prev = scores.get(nb) || { tag: nb.replace(/_/g, ' '), raw: 0, hits: 0, sources: [] };
          prev.raw += Number(npmi) || 0;
          prev.hits += 1;
          if (prev.sources.length < 4) prev.sources.push(s.replace(/_/g, ' '));
          scores.set(nb, prev);
        }
      }
      const recommendations = Array.from(scores.values())
        .map(x => ({ tag: x.tag, score: Number((x.raw * (1 + 0.25 * (x.hits - 1))).toFixed(4)), hits: x.hits, sources: x.sources }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      return sendJson(res, 200, { ok: true, recommendations });
    }
    if (pathname === '/api/offline/recommend-artists' && req.method === 'POST') {
      const body = await readBody(req);
      const adb = getOfflineArtistDb();
      const seeds = Array.isArray(body.tags) ? body.tags : [];
      const topK = Math.min(30, Math.max(1, Number(body.topK) || 12));
      const artistMap = new Map();
      for (const raw of seeds) {
        const tk = String(raw || '').trim().toLowerCase().replace(/\s+/g, '_');
        const cands = (adb.tagToArtists && adb.tagToArtists[tk]) || [];
        for (const [artName, sc] of cands) {
          const prev = artistMap.get(artName) || { artist: '@' + artName.replace(/_/g, ' '), raw: 0, hits: 0, matchedTags: [] };
          prev.raw += Number(sc) || 0;
          prev.hits += 1;
          prev.matchedTags.push(tk.replace(/_/g, ' '));
          artistMap.set(artName, prev);
        }
      }
      const artists = Array.from(artistMap.values())
        .map(r => {
          const key = r.artist.slice(1).replace(/\s+/g, '_');
          const prof = (adb.artists && adb.artists[key]) || {};
          return {
            artist: r.artist,
            zh: prof.zh || '',
            posts: prof.posts || 0,
            topTags: prof.top || [],
            score: Number((r.raw * (1 + 0.3 * (r.hits - 1))).toFixed(2)),
            hits: r.hits,
            matchedTags: r.matchedTags
          };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      return sendJson(res, 200, { ok: true, artists });
    }


    // 5.9 V1.0 统一库文件夹读写接口 (/api/libraries/* 及兼容 /api/random-schemes/*)
    if (pathname === '/api/libraries/list' && req.method === 'GET') {
      const all = syncLibrariesLoader();
      return sendJson(res, 200, { ok: true, libraries: all });
    }
    if (pathname === '/api/libraries/save' && req.method === 'POST') {
      const body = await readBody(req);
      const all = saveLibraryItem(body.kind, body.item);
      return sendJson(res, 200, { ok: true, count: (all[body.kind] || []).length });
    }
    if (pathname === '/api/libraries/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const all = deleteLibraryItem(body.kind, body.id);
      return sendJson(res, 200, { ok: true, count: (all[body.kind] || []).length });
    }
    if (pathname === '/api/random-schemes/save' && req.method === 'POST') {
      const body = await readBody(req);
      const all = saveLibraryItem('random_schemes', body.scheme || body.item);
      return sendJson(res, 200, { ok: true, count: all.random_schemes.length });
    }
    if (pathname === '/api/random-schemes/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const all = deleteLibraryItem('random_schemes', body.id);
      return sendJson(res, 200, { ok: true, count: all.random_schemes.length });
    }

    // 6. 版本对比工具路由 (/diff) 与 动态模块化主页渲染 (/ 或 /danbooru_prompt.html，无需根目录下存在 html 文件)
    if (pathname === '/' || pathname === '/index.html' || pathname === '/danbooru_prompt.html') {
      const htmlOut = buildAppEntryHtml(activeBoundPort);
      const headers = {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': corsOrigin(req)
      };
      const acceptEncoding = req.headers['accept-encoding'] || '';
      if (/\bgzip\b/.test(acceptEncoding)) {
        headers['Content-Encoding'] = 'gzip';
        res.writeHead(200, headers);
        return zlib.gzip(Buffer.from(htmlOut, 'utf-8'), (err, buf) => {
          if (err) return res.end(htmlOut, 'utf-8');
          res.end(buf);
        });
      }
      res.writeHead(200, headers);
      return res.end(htmlOut, 'utf-8');
    }

    const filePath = path.resolve(__dirname, pathname.replace(/^\/+/, ''));
    if (!filePath.startsWith(__dirname + path.sep) && filePath !== __dirname) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Forbidden');
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const isCompressible = /\.(js|mjs|json|css|html|md|svg)$/.test(ext);
      const acceptEncoding = req.headers['accept-encoding'] || '';
      const headers = {
        'Content-Type': MIME_MAP[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': corsOrigin(req)
      };
      if (isCompressible && /\bgzip\b/.test(acceptEncoding)) {
        headers['Content-Encoding'] = 'gzip';
        res.writeHead(200, headers);
        return fs.createReadStream(filePath).pipe(zlib.createGzip()).pipe(res);
      }
      res.writeHead(200, headers);
      return fs.createReadStream(filePath).pipe(res);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (err) {
    const msg = String(err && err.message || err);
    const code = /Invalid JSON body|Request body too large/.test(msg) ? 400 : 500;
    if (!res.headersSent) {
      sendJson(res, code, { ok: false, error: msg });
    }
  }
});

// (V1.0 Req 6) 端口区间随机抽取与冲突自动避让重抽机制 (默认区间 18100 ~ 18999)
const PORT_MIN = Number(process.env.PORT_MIN || 18100);
const PORT_MAX = Number(process.env.PORT_MAX || 18999);
const triedPorts = new Set();

function pickRandomPortInRange() {
  const span = Math.max(1, PORT_MAX - PORT_MIN + 1);
  for (let i = 0; i < 100; i++) {
    const candidate = PORT_MIN + Math.floor(Math.random() * span);
    if (!triedPorts.has(candidate)) return candidate;
  }
  return 0;
}

let activeBoundPort = (PORT && PORT >= 1024 && PORT <= 65535 && PORT !== 8177)
  ? PORT
  : pickRandomPortInRange();

function startServerWithRetry(portToTry, attempt = 1) {
  triedPorts.add(portToTry);

  const onError = (err) => {
    server.removeListener('error', onError);
    if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && attempt < 50) {
      const nextPort = pickRandomPortInRange();
      console.log(`[端口 ${portToTry} 已被占用] 正在从区间 ${PORT_MIN}-${PORT_MAX} 重新随机抽取端口: ${nextPort} ...`);
      startServerWithRetry(nextPort, attempt + 1);
    } else {
      console.error('服务启动失败:', err);
      process.exit(1);
    }
  };
  server.on('error', onError);

  server.listen(portToTry, '127.0.0.1', () => {
    server.removeListener('error', onError);
    const addr = server.address();
    activeBoundPort = (addr && typeof addr === 'object' && addr.port) ? addr.port : portToTry;
    const url = `http://127.0.0.1:${activeBoundPort}`;
    try {
      fs.writeFileSync(
        path.join(__dirname, 'js', 'server-port.js'),
        `window.__ACTIVE_SERVER_BASE__ = ${JSON.stringify(url)};
`,
        'utf-8'
      );
    } catch (e) {}
    console.log(`================================================================`);
    console.log(`[Danbooru Prompt V1.0 本地模块化服务] 已启动: ${url}`);
    console.log(`[随机端口区间]: ${PORT_MIN} - ${PORT_MAX} (当前绑定端口: ${activeBoundPort})`);
    console.log(`[标签库存储目录]: ${TAGS_DIR}`);
    console.log(`================================================================`);
    if (process.env.AUTO_OPEN_BROWSER === '1' && process.platform === 'win32') {
      execFile('cmd', ['/c', 'start', '', url], () => {});
    }
  });
}

startServerWithRetry(activeBoundPort);
