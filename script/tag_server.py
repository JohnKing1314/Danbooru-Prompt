#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Danbooru Prompt V1.0 · 本地同步服务 Python 标准库实现 (script/tag_server.py)
零外部依赖，支持：
1. 动态渲染模块化页面外壳 (通过 script/app_shell.py)
2. 托管 tags/、tags/_characters_/、img/、js/、materials/、help.md、update.md、layout-order.json、user-data.json
3. 提供全部双向持久化 API (/api/tags/tree, /api/tags/op, /api/tags/cleanup, /api/chars/tree, /api/chars/op,
   /api/char-img/*, /api/layout, /api/userdata, /api/help, /api/changelog, /api/translate)
4. 端口区间 (18100 ~ 18999) 随机抽取与占用自动避让重抽
"""

import base64
import json
import os
import random
import re
import shutil
import socket
import sys
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

from app_shell import build_app_entry_html
from anima_tag_optimizer import format_anima_tag

TAGS_DIR = os.path.join(ROOT_DIR, "tags")
CHARS_DIR = os.path.join(TAGS_DIR, "_characters_")
IMG_DIR = os.path.join(ROOT_DIR, "img")
LAYOUT_FILE = os.path.join(ROOT_DIR, "layout-order.json")
HELP_FILE = os.path.join(ROOT_DIR, "help.md")
HELP_LOADER_FILE = os.path.join(ROOT_DIR, "js", "help-loader.js")
CHANGELOG_FILE = os.path.join(ROOT_DIR, "update.md")
CHANGELOG_LOADER_FILE = os.path.join(ROOT_DIR, "js", "changelog-loader.js")
USER_DATA_FILE = os.path.join(ROOT_DIR, "user-data.json")
USER_DATA_LOADER_FILE = os.path.join(ROOT_DIR, "js", "user-data-loader.js")

os.makedirs(IMG_DIR, exist_ok=True)
os.makedirs(CHARS_DIR, exist_ok=True)

MIME_MAP = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
}

def safe_id(val):
    return re.sub(r"[^a-zA-Z0-9_-]", "_", str(val or "").strip())

def clean_sub_short_id(mid, sid):
    m = safe_id(mid)
    s = safe_id(sid)
    if s != m and s.startswith(m + "_"):
        s = s[len(m) + 1:]
    return s or "base"

def get_sub_file_name(mid, sid):
    m = safe_id(mid)
    s = clean_sub_short_id(m, sid)
    return f"{m}_{s}.json"

def get_major_rel_file(mid):
    m = safe_id(mid)
    return f"{m}/{m}.json"

def read_json_safe(path):
    try:
        if not os.path.exists(path):
            return None
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None

def write_json_pretty(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")

def get_img_subdir_rel(base_name):
    parts = str(base_name or "").lower().split("_")
    if len(parts) >= 2 and parts[0] in ("game", "anime", "vtuber", "custom"):
        l1 = re.sub(r'[\\/:*?"<>|]+', " ", parts[0]).strip()
        l2 = re.sub(r'[\\/:*?"<>|]+', " ", parts[1]).strip() or "other"
        return os.path.join(l1, l2)
    return "other"

def scan_char_images():
    os.makedirs(IMG_DIR, exist_ok=True)
    valid_exts = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
    img_map = {}
    for rdir, dirs, files in os.walk(IMG_DIR):
        dirs.sort()
        for fn in sorted(files):
            ext = os.path.splitext(fn)[1].lower()
            if ext not in valid_exts:
                continue
            full = os.path.join(rdir, fn)
            rel = os.path.relpath(full, IMG_DIR).replace(os.sep, "/")
            base = fn[:-len(ext)].lower()
            if base not in img_map or ext == ".png":
                img_map[base] = f"img/{rel}"
    try:
        with open(os.path.join(IMG_DIR, "img-loader.js"), "w", encoding="utf-8") as f:
            f.write("/* Character Image Folder Index (auto-synced with img/*) */\nwindow.__EXT_CHAR_IMGS__ = " + json.dumps(img_map, ensure_ascii=False) + ";\n")
    except Exception:
        pass
    return img_map

def is_reserved_tag_dir(name):
    return name == "_characters_" or name == "characters" or name.startswith("_")

def cleanup_redundant_tag_folders(valid_major_ids_opt=None):
    os.makedirs(TAGS_DIR, exist_ok=True)
    index_file = os.path.join(TAGS_DIR, "index.json")
    manifest = read_json_safe(index_file) or read_json_safe(os.path.join(TAGS_DIR, "manifest.json"))
    valid_major_ids = None
    if isinstance(valid_major_ids_opt, list) and valid_major_ids_opt:
        valid_major_ids = {safe_id(x) for x in valid_major_ids_opt}
    elif manifest and isinstance(manifest.get("majors"), list) and manifest["majors"]:
        valid_major_ids = {safe_id(m.get("id")) for m in manifest["majors"]}

    removed_dirs = []
    removed_files = []
    for name in sorted(os.listdir(TAGS_DIR)):
        if is_reserved_tag_dir(name):
            continue
        full = os.path.join(TAGS_DIR, name)
        if os.path.isdir(full):
            mid = name
            m_json = os.path.join(full, f"{mid}.json")
            is_redundant = (valid_major_ids is not None and mid not in valid_major_ids) or not os.path.exists(m_json)
            if is_redundant:
                try:
                    shutil.rmtree(full, ignore_errors=True)
                    removed_dirs.append(mid)
                except Exception:
                    pass
            else:
                m_data = read_json_safe(m_json)
                if m_data and isinstance(m_data.get("children"), list):
                    valid_sub_files = {f"{mid}.json"} | {get_sub_file_name(mid, c.get("id")) for c in m_data["children"]}
                    for sfn in os.listdir(full):
                        sfull = os.path.join(full, sfn)
                        if os.path.isfile(sfull) and sfn.endswith(".json") and sfn not in valid_sub_files:
                            try:
                                os.remove(sfull)
                                removed_files.append(f"{mid}/{sfn}")
                            except Exception:
                                pass
        elif os.path.isfile(full) and name.endswith(".json") and name not in ("index.json", "manifest.json"):
            try:
                os.remove(full)
                removed_files.append(name)
            except Exception:
                pass
    return {"removedDirs": removed_dirs, "removedFiles": removed_files}

def scan_tag_tree():
    os.makedirs(TAGS_DIR, exist_ok=True)
    manifest = read_json_safe(os.path.join(TAGS_DIR, "index.json")) or read_json_safe(os.path.join(TAGS_DIR, "manifest.json")) or {"majors": []}
    major_order_map = {m.get("id"): (m.get("order") or idx + 1) for idx, m in enumerate(manifest.get("majors", []))}

    majors = []
    for mid in sorted(os.listdir(TAGS_DIR)):
        if is_reserved_tag_dir(mid):
            continue
        sub_dir = os.path.join(TAGS_DIR, mid)
        if not os.path.isdir(sub_dir):
            continue
        m_path = os.path.join(sub_dir, f"{mid}.json")
        m_data = read_json_safe(m_path)
        if not m_data or not m_data.get("id"):
            continue
        sub_order_map = {c.get("id"): (c.get("order") or idx + 1) for idx, c in enumerate(m_data.get("children", []))}
        children = []
        for sfn in sorted(os.listdir(sub_dir)):
            if not sfn.endswith(".json") or sfn == f"{mid}.json":
                continue
            s_data = read_json_safe(os.path.join(sub_dir, sfn))
            if not s_data or not s_data.get("id"):
                continue
            children.append({
                "id": s_data["id"],
                "name": s_data.get("name") or s_data["id"],
                "icon": s_data.get("icon") or "•",
                "parentId": mid,
                "level": 2,
                "order": s_data.get("order") or sub_order_map.get(s_data["id"], 999),
                "file": f"{mid}/{sfn}",
                "updatedAt": s_data.get("updatedAt") or datetime.now(timezone.utc).isoformat(),
                "children": s_data.get("children", []),
                "tags": s_data.get("tags", []),
            })
        children.sort(key=lambda x: (x["order"], x["id"]))
        majors.append({
            "id": mid,
            "name": m_data.get("name") or mid,
            "icon": m_data.get("icon") or "📁",
            "level": 1,
            "order": m_data.get("order") or major_order_map.get(mid, 999),
            "file": get_major_rel_file(mid),
            "subDir": mid,
            "updatedAt": m_data.get("updatedAt") or datetime.now(timezone.utc).isoformat(),
            "children": children,
        })
    majors.sort(key=lambda x: (x["order"], x["id"]))
    return majors

def sync_manifest(majors):
    now_iso = datetime.now(timezone.utc).isoformat()
    try:
        js_txt = (
            "/* External Tag Library Loader (auto-synced with tags/<major>/<major>_<sub>.json) */\n"
            f"window.__EXT_TAG_TREE_TS__ = {json.dumps(now_iso)};\n"
            f"window.__EXT_TAG_TREE__ = {json.dumps(majors, ensure_ascii=False)};\n"
        )
        with open(os.path.join(TAGS_DIR, "tags-loader.js"), "w", encoding="utf-8") as f:
            f.write(js_txt)
        with open(os.path.join(ROOT_DIR, "js", "tag-fs-data.js"), "w", encoding="utf-8") as f:
            f.write("/* Danbooru Prompt V1.0 · 外部标签树桥接器 */\nwindow.PG_TAG_FS_DATA = { version: 3, updatedAt: window.__EXT_TAG_TREE_TS__, majors: window.__EXT_TAG_TREE__ || [] };\n")
    except Exception:
        pass
    manifest = {
        "version": "1.0",
        "type": "tag_tree_manifest",
        "updatedAt": now_iso,
        "majors": [
            {
                "id": m["id"],
                "name": m["name"],
                "icon": m.get("icon", "📁"),
                "order": m.get("order", idx + 1),
                "file": get_major_rel_file(m["id"]),
                "subDir": m["id"],
            }
            for idx, m in enumerate(majors)
        ],
    }
    write_json_pretty(os.path.join(TAGS_DIR, "index.json"), manifest)
    write_json_pretty(os.path.join(TAGS_DIR, "manifest.json"), manifest)

def write_sub_file(major_id, sub):
    mid = safe_id(major_id)
    sid = clean_sub_short_id(mid, sub.get("id"))
    sub_dir = os.path.join(TAGS_DIR, mid)
    os.makedirs(sub_dir, exist_ok=True)
    tags_out = []
    for t in sub.get("tags", []):
        if isinstance(t, str):
            parts = t.split("|", 1)
            en = format_anima_tag(parts[0])
            zh = parts[1].strip() if len(parts) > 1 else ""
            if en:
                tags_out.append({"en": en, "zh": zh, "rating": "g", "nsfw": False})
        elif isinstance(t, dict) and t.get("en"):
            en = format_anima_tag(t.get("en"))
            if not en:
                continue
            r = t.get("rating", "g")
            if r not in ("g", "s", "q", "e"):
                r = "e" if t.get("nsfw") else "g"
            item = {
                "en": en,
                "zh": str(t.get("zh") or "").strip(),
                "rating": r,
                "nsfw": (r == "q" or r == "e"),
            }
            if t.get("desc"):
                item["desc"] = str(t["desc"]).strip()
            if t.get("kw"):
                item["kw"] = str(t["kw"]).strip()
            if t.get("count"):
                item["count"] = int(t.get("count") or 0)
            if isinstance(t.get("topTags"), list) and t["topTags"]:
                item["topTags"] = t["topTags"]
            if t.get("isNew"):
                item["isNew"] = True
            tags_out.append(item)
    payload = {
        "id": sid,
        "name": sub.get("name") or sid,
        "icon": sub.get("icon") or "•",
        "parentId": mid,
        "level": 2,
        "order": sub.get("order") or 999,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "tags": tags_out,
    }
    write_json_pretty(os.path.join(sub_dir, get_sub_file_name(mid, sid)), payload)

def write_major_file(major, include_children=False):
    mid = safe_id(major.get("id"))
    sub_dir = os.path.join(TAGS_DIR, mid)
    os.makedirs(sub_dir, exist_ok=True)
    children_list = major.get("children", [])
    payload = {
        "id": mid,
        "name": major.get("name") or mid,
        "icon": major.get("icon") or "📁",
        "level": 1,
        "order": major.get("order") or 999,
        "subDir": mid,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "children": [
            {
                "id": clean_sub_short_id(mid, c.get("id")),
                "name": c.get("name") or c.get("id"),
                "icon": c.get("icon") or "•",
                "order": c.get("order") or idx + 1,
                "file": f"{mid}/{get_sub_file_name(mid, c.get('id'))}",
            }
            for idx, c in enumerate(children_list)
        ],
    }
    write_json_pretty(os.path.join(sub_dir, f"{mid}.json"), payload)
    if include_children:
        for idx, sub in enumerate(children_list):
            s_copy = dict(sub)
            s_copy["order"] = sub.get("order") or idx + 1
            write_sub_file(mid, s_copy)

def reconcile_all_tag_files(majors):
    os.makedirs(TAGS_DIR, exist_ok=True)
    active_ids = {safe_id(m.get("id")) for m in (majors or [])}
    for name in os.listdir(TAGS_DIR):
        if is_reserved_tag_dir(name):
            continue
        full = os.path.join(TAGS_DIR, name)
        if os.path.isdir(full) and name not in active_ids:
            shutil.rmtree(full, ignore_errors=True)
        elif os.path.isfile(full) and name.endswith(".json") and name not in ("index.json", "manifest.json"):
            try:
                os.remove(full)
            except Exception:
                pass
    for idx, m in enumerate(majors or []):
        m_copy = dict(m)
        m_copy["order"] = m.get("order") or idx + 1
        write_major_file(m_copy, True)
    scanned = scan_tag_tree()
    sync_manifest(scanned)
    return scanned

def scan_char_tree():
    os.makedirs(CHARS_DIR, exist_ok=True)
    majors = []
    for fn in sorted(os.listdir(CHARS_DIR)):
        if not fn.endswith(".json") or fn in ("index.json", "manifest.json"):
            continue
        m_path = os.path.join(CHARS_DIR, fn)
        if not os.path.isfile(m_path):
            continue
        m_data = read_json_safe(m_path)
        if not m_data or not m_data.get("id"):
            continue
        mid = m_data["id"]
        sub_dir = os.path.join(CHARS_DIR, m_data.get("subDir") or mid)
        children = []
        if os.path.isdir(sub_dir):
            for sfn in sorted(os.listdir(sub_dir)):
                if not sfn.endswith(".json"):
                    continue
                s_data = read_json_safe(os.path.join(sub_dir, sfn))
                if s_data and s_data.get("id"):
                    children.append(s_data)
        children.sort(key=lambda x: (x.get("order", 999), str(x.get("id", ""))))
        sub_rel = m_data.get("subDir") or mid
        children_meta = [
            {
                "id": s["id"],
                "name": s.get("name") or s["id"],
                "order": s_idx + 1,
                "count": len(s.get("characters", [])),
                "file": f"{sub_rel}/{s['id']}.json",
            }
            for s_idx, s in enumerate(children)
        ]
        total_cnt = sum(c["count"] for c in children_meta)
        if m_data.get("children") != children_meta or m_data.get("count") != total_cnt:
            try:
                write_json_pretty(m_path, {
                    "id": mid,
                    "name": m_data.get("name") or mid,
                    "icon": m_data.get("icon") or "🎮",
                    "order": m_data.get("order", 99),
                    "file": fn,
                    "subDir": sub_rel,
                    "children": children_meta,
                    "count": total_cnt,
                })
            except Exception:
                pass
        m_copy = dict(m_data)
        m_copy["count"] = total_cnt
        m_copy["children"] = children
        majors.append(m_copy)
    majors.sort(key=lambda x: x.get("order", 99))
    return majors

def write_char_tree_all(majors):
    os.makedirs(CHARS_DIR, exist_ok=True)
    manifest_majors = []
    for idx, m in enumerate(majors or []):
        mid = safe_id(m.get("id"))
        sub_dir = os.path.join(CHARS_DIR, mid)
        os.makedirs(sub_dir, exist_ok=True)
        children_meta = []
        for s_idx, s in enumerate(m.get("children", [])):
            sid = safe_id(s.get("id"))
            s_obj = {
                "id": sid,
                "name": s.get("name") or sid,
                "parentId": mid,
                "order": s_idx + 1,
                "file": f"{mid}/{sid}.json",
                "characters": s.get("characters", []),
            }
            write_json_pretty(os.path.join(sub_dir, f"{sid}.json"), s_obj)
            children_meta.append({
                "id": sid,
                "name": s_obj["name"],
                "order": s_idx + 1,
                "count": len(s_obj["characters"]),
                "file": s_obj["file"],
            })
        valid_sub_files = {f"{c['id']}.json" for c in children_meta}
        for sfn in os.listdir(sub_dir):
            if sfn.endswith(".json") and sfn not in valid_sub_files:
                try:
                    os.remove(os.path.join(sub_dir, sfn))
                except Exception:
                    pass
        m_obj = {
            "id": mid,
            "name": m.get("name") or mid,
            "icon": m.get("icon") or "🎮",
            "order": idx + 1,
            "file": f"{mid}.json",
            "subDir": mid,
            "children": children_meta,
        }
        write_json_pretty(os.path.join(CHARS_DIR, f"{mid}.json"), m_obj)
        manifest_majors.append({"id": mid, "name": m_obj["name"], "icon": m_obj["icon"], "order": idx + 1, "file": m_obj["file"]})
    try:
        with open(os.path.join(CHARS_DIR, "chars-loader.js"), "w", encoding="utf-8") as f:
            f.write("/* Danbooru Prompt V1.0 · 外部角色文件夹 (tags/_characters_/) 同步加载器 */\nwindow.__EXT_CHAR_TREE__ = " + json.dumps(scan_char_tree(), ensure_ascii=False) + ";\n")
    except Exception:
        pass
    write_json_pretty(os.path.join(CHARS_DIR, "index.json"), {
        "app": "Danbooru Prompt",
        "version": "1.0",
        "type": "character_tree_manifest",
        "majors": manifest_majors,
    })

ACTIVE_PORT = 18177


LIBRARIES_DIR = os.path.join(ROOT_DIR, "libraries")
VALID_LIB_KINDS = {"random_schemes", "templates", "presets"}

def safe_lib_file_id(raw_id):
    s = re.sub(r"[^a-zA-Z0-9_-]+", "_", str(raw_id or "")).strip("_")
    return s or f"item_{int(time.time())}"

def sync_libraries_loader():
    results = {}
    for kind in ("random_schemes", "templates", "presets"):
        sub_dir = os.path.join(LIBRARIES_DIR, kind)
        os.makedirs(sub_dir, exist_ok=True)
        items = []
        for fn in sorted(os.listdir(sub_dir)):
            if not fn.endswith(".json") or fn == "index.json":
                continue
            try:
                with open(os.path.join(sub_dir, fn), "r", encoding="utf-8") as f:
                    obj = json.load(f)
                if isinstance(obj, dict) and (obj.get("id") or obj.get("key")):
                    items.append(obj)
            except Exception:
                pass
        if kind == "presets":
            def _pk(x):
                k = str(x.get("key") or x.get("id") or "")
                return (0, int(k[1:])) if (k.startswith("p") and k[1:].isdigit()) else (1, k)
            items.sort(key=_pk)
        with open(os.path.join(sub_dir, "index.json"), "w", encoding="utf-8") as f:
            json.dump({
                "version": "1.0",
                "kind": kind,
                "count": len(items),
                "items": [{"id": x.get("id") or x.get("key"), "name": x.get("name", ""), "file": safe_lib_file_id(x.get("id") or x.get("key")) + ".json"} for x in items]
            }, f, ensure_ascii=False, indent=2)
        results[kind] = items
    with open(os.path.join(LIBRARIES_DIR, "libraries-loader.js"), "w", encoding="utf-8") as f:
        f.write("/* Danbooru Prompt V1.0 · Unified Libraries Loader (libraries/{random_schemes,templates,presets}) */\n")
        f.write("window.__EXT_LIBRARIES_LOADED__ = true;\n")
        f.write("window.__EXT_RANDOM_SCHEMES__ = " + json.dumps(results["random_schemes"], ensure_ascii=False) + ";\n")
        f.write("window.__EXT_TEMPLATES__ = " + json.dumps(results["templates"], ensure_ascii=False) + ";\n")
        f.write("window.__EXT_PRESETS__ = " + json.dumps(results["presets"], ensure_ascii=False) + ";\n")
    return results

def save_library_item(kind, item):
    if kind not in VALID_LIB_KINDS:
        raise ValueError(f"Invalid library kind: {kind}")
    if not isinstance(item, dict) or not (item.get("id") or item.get("key")):
        raise ValueError("Missing item id/key")
    fid = safe_lib_file_id(item.get("id") or item.get("key"))
    sub_dir = os.path.join(LIBRARIES_DIR, kind)
    os.makedirs(sub_dir, exist_ok=True)
    with open(os.path.join(sub_dir, fid + ".json"), "w", encoding="utf-8") as f:
        json.dump(item, f, ensure_ascii=False, indent=2)
    return sync_libraries_loader()

def delete_library_item(kind, raw_id):
    if kind not in VALID_LIB_KINDS:
        raise ValueError(f"Invalid library kind: {kind}")
    fid = safe_lib_file_id(raw_id)
    fp = os.path.join(LIBRARIES_DIR, kind, fid + ".json")
    if os.path.exists(fp):
        os.remove(fp)
    return sync_libraries_loader()


_OFFLINE_CACHE = {"alias": None, "cooc": None, "artist": None}

def _load_js_global_json(rel_path):
    p = os.path.join(ROOT_DIR, rel_path)
    if not os.path.isfile(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            raw = f.read()
        eq = raw.find("=")
        if eq < 0:
            return None
        jp = raw[eq + 1:].strip()
        if jp.endswith(";"):
            jp = jp[:-1].strip()
        return json.loads(jp)
    except Exception:
        return None

def get_offline_alias_map():
    if _OFFLINE_CACHE["alias"] is None:
        _OFFLINE_CACHE["alias"] = _load_js_global_json("tags/_offline_db_/alias-loader.js") or {}
    return _OFFLINE_CACHE["alias"]

def get_offline_cooc_map():
    if _OFFLINE_CACHE["cooc"] is None:
        _OFFLINE_CACHE["cooc"] = _load_js_global_json("tags/_offline_db_/cooc-loader.js") or {}
    return _OFFLINE_CACHE["cooc"]

def get_offline_artist_db():
    if _OFFLINE_CACHE["artist"] is None:
        _OFFLINE_CACHE["artist"] = _load_js_global_json("tags/_offline_db_/artist-loader.js") or {"artists": {}, "tagToArtists": {}}
    return _OFFLINE_CACHE["artist"]

class TagServerHandler(BaseHTTPRequestHandler):
    def log_message(self, format_str, *args):
        pass

    def _get_cors_origin(self):
        origin = self.headers.get("Origin") or ""
        if not origin:
            return "*"
        if re.match(r"^https?://(127\.0\.0\.1|localhost)(:\d+)?$", origin):
            return origin
        if origin == "null":
            return "null"
        return "http://127.0.0.1"

    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", self._get_cors_origin())
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send_json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._send_cors_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw) if raw else {}

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        pathname = urllib.parse.unquote(parsed.path)

        if pathname == "/api/libraries/list":
            return self._send_json(200, {"ok": True, "libraries": sync_libraries_loader()})
        if pathname == "/api/health":
            return self._send_json(200, {"ok": True, "version": "1.0", "port": ACTIVE_PORT})

        if pathname == "/api/offline/meta":
            meta = read_json_safe(os.path.join(TAGS_DIR, "_offline_db_", "offline-meta.json")) or {}
            return self._send_json(200, {"ok": True, "version": "1.0", "meta": meta})

        if pathname == "/api/tags/tree":
            cleaned = cleanup_redundant_tag_folders()
            majors = scan_tag_tree()
            sync_manifest(majors)
            return self._send_json(200, {"ok": True, "mode": "server-fs", "tagsDir": TAGS_DIR, "majors": majors, "cleaned": cleaned})

        if pathname == "/api/chars/tree":
            return self._send_json(200, {"ok": True, "majors": scan_char_tree()})

        if pathname == "/api/char-img/list":
            return self._send_json(200, {"ok": True, "map": scan_char_images()})

        if pathname == "/api/layout":
            return self._send_json(200, {"ok": True, "layout": read_json_safe(LAYOUT_FILE) or {}})

        if pathname == "/api/userdata":
            return self._send_json(200, {"ok": True, "data": read_json_safe(USER_DATA_FILE) or {}})

        if pathname == "/api/help":
            md = ""
            if os.path.exists(HELP_FILE):
                with open(HELP_FILE, "r", encoding="utf-8") as f:
                    md = f.read()
            return self._send_json(200, {"ok": True, "md": md})

        if pathname == "/api/changelog":
            md = ""
            if os.path.exists(CHANGELOG_FILE):
                with open(CHANGELOG_FILE, "r", encoding="utf-8") as f:
                    md = f.read()
            return self._send_json(200, {"ok": True, "md": md})

        if pathname in ("/", "/index.html") or pathname.endswith(".html"):
            html_bytes = build_app_entry_html(ACTIVE_PORT).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self._send_cors_headers()
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(html_bytes)))
            self.end_headers()
            self.wfile.write(html_bytes)
            return

        # Serve static files from ROOT_DIR (also redirecting legacy /characters/ requests to /tags/_characters_/)
        rel = pathname.lstrip("/")
        if rel.startswith("characters/"):
            rel = "tags/_characters_/" + rel[len("characters/"):]
        file_path = os.path.normpath(os.path.join(ROOT_DIR, rel))
        if not file_path.startswith(ROOT_DIR + os.sep) and file_path != ROOT_DIR:
            return self._send_json(404, {"ok": False, "error": "Not found"})
        if not os.path.isfile(file_path):
            return self._send_json(404, {"ok": False, "error": "Not found"})

        ext = os.path.splitext(file_path)[1].lower()
        mime = MIME_MAP.get(ext, "application/octet-stream")
        with open(file_path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self._send_cors_headers()
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        pathname = urllib.parse.unquote(parsed.path)
        try:
            body = self._read_body_json()
        except Exception as e:
            return self._send_json(400, {"ok": False, "error": str(e)})

        if pathname == "/api/translate":
            q = str(body.get("q") or "").strip()
            sl = str(body.get("from") or "auto").strip() or "auto"
            tl = str(body.get("to") or "en").strip() or "en"
            if not q:
                return self._send_json(200, {"ok": True, "text": ""})
            eff_from = ("zh-CN" if re.search(r"[\u4e00-\u9fff]", q) else "en") if sl == "auto" else sl
            # 1. 优先使用国内直连免 VPN 的有道翻译接口 (fanyi.youdao.com / aidemo.youdao.com)
            try:
                yd_from = "zh-CHS" if eff_from == "zh-CN" else eff_from
                yd_to = "zh-CHS" if tl == "zh-CN" else tl
                ad_data = urllib.parse.urlencode({"q": q, "from": yd_from, "to": yd_to}).encode("utf-8")
                ad_req = urllib.request.Request(
                    "https://aidemo.youdao.com/trans",
                    data=ad_data,
                    headers={"User-Agent": "Mozilla/5.0", "Content-Type": "application/x-www-form-urlencoded"}
                )
                with urllib.request.urlopen(ad_req, timeout=6) as resp:
                    aj = json.loads(resp.read().decode("utf-8"))
                    if aj and str(aj.get("errorCode")) == "0" and isinstance(aj.get("translation"), list) and aj["translation"]:
                        txt = "\n".join(str(x) for x in aj["translation"]).strip()
                        if txt:
                            return self._send_json(200, {"ok": True, "text": txt, "engine": "有道翻译"})
            except Exception:
                pass
            try:
                type_map = {
                    ("zh-CN", "en"): "ZH_CN2EN",
                    ("en", "zh-CN"): "EN2ZH_CN",
                    ("zh-CN", "ja"): "ZH_CN2JA",
                    ("ja", "zh-CN"): "JA2ZH_CN",
                }
                yd_type = type_map.get((eff_from, tl), "AUTO")
                y_url = f"http://fanyi.youdao.com/translate?&doctype=json&type={yd_type}&i={urllib.parse.quote(q)}"
                req = urllib.request.Request(y_url, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=6) as resp:
                    yj = json.loads(resp.read().decode("utf-8"))
                    if yj and yj.get("errorCode") == 0 and isinstance(yj.get("translateResult"), list):
                        lines_out = []
                        for para in yj["translateResult"]:
                            if isinstance(para, list):
                                lines_out.append("".join(str(seg.get("tgt") or "") for seg in para if isinstance(seg, dict)))
                        txt = "\n".join(lines_out).strip()
                        if txt:
                            return self._send_json(200, {"ok": True, "text": txt, "engine": "有道翻译"})
            except Exception:
                pass
            # 2. 备用免 VPN MyMemory 接口
            try:
                m_url = f"https://api.mymemory.translated.net/get?q={urllib.parse.quote(q)}&langpair={urllib.parse.quote(eff_from + '|' + tl)}"
                req = urllib.request.Request(m_url, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=7) as resp:
                    mj = json.loads(resp.read().decode("utf-8"))
                    mt = (mj.get("responseData") or {}).get("translatedText")
                    if mt:
                        return self._send_json(200, {"ok": True, "text": str(mt).strip(), "engine": "MyMemory"})
            except Exception:
                pass
            return self._send_json(502, {"ok": False, "error": "Translation failed"})

        if pathname == "/api/tags/cleanup":
            valid_ids = body.get("validMajorIds") if isinstance(body.get("validMajorIds"), list) else None
            cleaned = cleanup_redundant_tag_folders(valid_ids)
            majors = scan_tag_tree()
            sync_manifest(majors)
            return self._send_json(200, {"ok": True, "cleaned": cleaned, "majors": majors})

        if pathname == "/api/tags/op":
            action = body.get("action")
            if action == "sync_all":
                majors = reconcile_all_tag_files(body.get("majors", []))
                return self._send_json(200, {"ok": True, "majors": majors})
            if action == "save_sub":
                major_id = body.get("majorId")
                sub = body.get("sub")
                major = body.get("major")
                if not major_id or not sub or not sub.get("id"):
                    return self._send_json(400, {"ok": False, "error": "Missing majorId or sub.id"})
                write_sub_file(major_id, sub)
                if major:
                    write_major_file(major, False)
                majors = scan_tag_tree()
                sync_manifest(majors)
                return self._send_json(200, {"ok": True, "majors": majors})
            if action == "save_major":
                major = body.get("major")
                if not major or not major.get("id"):
                    return self._send_json(400, {"ok": False, "error": "Missing major.id"})
                write_major_file(major, bool(body.get("includeChildren")))
                majors = scan_tag_tree()
                sync_manifest(majors)
                return self._send_json(200, {"ok": True, "majors": majors})
            if action == "delete_sub":
                mid = safe_id(body.get("majorId"))
                sid = safe_id(body.get("subId"))
                s_path = os.path.join(TAGS_DIR, mid, get_sub_file_name(mid, sid))
                if os.path.exists(s_path):
                    os.remove(s_path)
                if body.get("major"):
                    write_major_file(body["major"], False)
                majors = scan_tag_tree()
                sync_manifest(majors)
                return self._send_json(200, {"ok": True, "majors": majors})
            if action == "delete_major":
                mid = safe_id(body.get("majorId"))
                if not is_reserved_tag_dir(mid):
                    shutil.rmtree(os.path.join(TAGS_DIR, mid), ignore_errors=True)
                majors = scan_tag_tree()
                sync_manifest(majors)
                return self._send_json(200, {"ok": True, "majors": majors})
            # Generic fallback: if majors provided, sync all
            if isinstance(body.get("majors"), list):
                majors = reconcile_all_tag_files(body["majors"])
                return self._send_json(200, {"ok": True, "majors": majors})
            majors = scan_tag_tree()
            sync_manifest(majors)
            return self._send_json(200, {"ok": True, "majors": majors})

        if pathname == "/api/chars/op":
            if isinstance(body.get("majors"), list):
                write_char_tree_all(body["majors"])
            return self._send_json(200, {"ok": True, "majors": scan_char_tree()})

        if pathname == "/api/layout":
            write_json_pretty(LAYOUT_FILE, body)
            return self._send_json(200, {"ok": True})

        if pathname == "/api/userdata":
            write_json_pretty(USER_DATA_FILE, body)
            try:
                with open(USER_DATA_LOADER_FILE, "w", encoding="utf-8") as f:
                    f.write("/* Danbooru Prompt V1.0 · 用户操作数据外置加载器 */\nwindow.__EXT_USER_DATA__ = " + json.dumps(body, ensure_ascii=False) + ";\n")
            except Exception:
                pass
            return self._send_json(200, {"ok": True})

        if pathname == "/api/char-img":
            act = str(body.get("action") or "upload").lower()
            base_name = re.sub(r'[\\/:*?"<>|]+', " ", str(body.get("baseName") or "")).strip().lower()
            if not base_name:
                return self._send_json(400, {"ok": False, "error": "Missing baseName"})
            if act == "delete":
                for fn in list(os.listdir(IMG_DIR)):
                    b, _ = os.path.splitext(fn)
                    if b.lower() == base_name:
                        try:
                            os.remove(os.path.join(IMG_DIR, fn))
                        except Exception:
                            pass
                return self._send_json(200, {"ok": True, "map": scan_char_images()})
            data_url = str(body.get("dataUrl") or "")
            m = re.match(r"^data:image/([a-zA-Z0-9+.-]+);base64,(.+)$", data_url, re.S)
            if not m:
                return self._send_json(400, {"ok": False, "error": "Invalid dataUrl"})
            ext = "jpg" if m.group(1).lower() in ("jpeg", "jpg") else ("webp" if m.group(1).lower() == "webp" else "png")
            sub_rel = get_img_subdir_rel(base_name)
            tdir = os.path.join(IMG_DIR, sub_rel)
            os.makedirs(tdir, exist_ok=True)
            out_path = os.path.join(tdir, f"{base_name}.{ext}")
            with open(out_path, "wb") as f:
                f.write(base64.b64decode(m.group(2)))
            rel_posix = sub_rel.replace(os.sep, "/") + f"/{base_name}.{ext}"
            return self._send_json(200, {"ok": True, "path": f"img/{rel_posix}", "map": scan_char_images()})
        if pathname == "/api/char-img/upload":
            base_name = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', " ", str(body.get("baseName") or "").strip()).strip()
            data_url = str(body.get("dataUrl") or "")
            m = re.match(r"^data:image/(png|jpeg|jpg|webp|gif);base64,(.+)$", data_url, re.I)
            if not base_name or not m:
                return self._send_json(400, {"ok": False, "error": "Invalid image payload"})
            ext = ".jpg" if m.group(1).lower() == "jpeg" else f".{m.group(1).lower()}"
            raw_bytes = base64.b64decode(m.group(2))
            for old_ext in (".png", ".jpg", ".jpeg", ".webp", ".gif"):
                old_p = os.path.join(IMG_DIR, base_name + old_ext)
                if os.path.exists(old_p):
                    os.remove(old_p)
            out_file = os.path.join(IMG_DIR, base_name + ext)
            with open(out_file, "wb") as f:
                f.write(raw_bytes)
            img_map = scan_char_images()
            return self._send_json(200, {"ok": True, "path": f"img/{base_name}{ext}", "map": img_map})

        if pathname == "/api/char-img/delete":
            base_name = str(body.get("baseName") or "").strip().lower()
            for fn in os.listdir(IMG_DIR):
                b, ext = os.path.splitext(fn)
                if b.lower() == base_name:
                    try:
                        os.remove(os.path.join(IMG_DIR, fn))
                    except Exception:
                        pass
            return self._send_json(200, {"ok": True, "map": scan_char_images()})

        if pathname == "/api/offline/resolve-alias":
            amap = get_offline_alias_map()
            raw_list = body.get("tags") if isinstance(body.get("tags"), list) else ([body.get("tag")] if body.get("tag") else [])
            results = []
            for raw in raw_list:
                k = re.sub(r"\s+", "_", str(raw or "").strip().lower())
                target = amap.get(k) or amap.get(k.replace("_", " ")) or k
                results.append({"input": raw, "canonical": str(target).replace("_", " "), "aliased": target != k})
            return self._send_json(200, {"ok": True, "results": results})

        if pathname == "/api/offline/recommend":
            cooc = get_offline_cooc_map()
            seeds = body.get("tags") if isinstance(body.get("tags"), list) else []
            top_k = min(50, max(1, int(body.get("topK") or 12)))
            seed_set = {re.sub(r"\s+", "_", str(s or "").strip().lower()) for s in seeds if str(s or "").strip()}
            scores = {}
            for s in seed_set:
                for pair in (cooc.get(s) or []):
                    if not isinstance(pair, list) or len(pair) < 2:
                        continue
                    nb, npmi = pair[0], float(pair[1] or 0)
                    if nb in seed_set:
                        continue
                    rec = scores.get(nb)
                    if rec is None:
                        rec = {"tag": str(nb).replace("_", " "), "raw": 0.0, "hits": 0, "sources": []}
                        scores[nb] = rec
                    rec["raw"] += npmi
                    rec["hits"] += 1
                    if len(rec["sources"]) < 4:
                        rec["sources"].append(s.replace("_", " "))
            recs = [
                {"tag": x["tag"], "score": round(x["raw"] * (1 + 0.25 * (x["hits"] - 1)), 4), "hits": x["hits"], "sources": x["sources"]}
                for x in scores.values()
            ]
            recs.sort(key=lambda x: x["score"], reverse=True)
            return self._send_json(200, {"ok": True, "recommendations": recs[:top_k]})

        if pathname == "/api/offline/recommend-artists":
            adb = get_offline_artist_db()
            seeds = body.get("tags") if isinstance(body.get("tags"), list) else []
            top_k = min(30, max(1, int(body.get("topK") or 12)))
            t2a = adb.get("tagToArtists") or {}
            arts = adb.get("artists") or {}
            am = {}
            for raw in seeds:
                tk = re.sub(r"\s+", "_", str(raw or "").strip().lower())
                for pair in (t2a.get(tk) or []):
                    if not isinstance(pair, list) or len(pair) < 2:
                        continue
                    aname, sc = pair[0], float(pair[1] or 0)
                    prev = am.get(aname)
                    if prev is None:
                        prev = {"artist": "@" + str(aname).replace("_", " "), "raw": 0.0, "hits": 0, "matchedTags": []}
                        am[aname] = prev
                    prev["raw"] += sc
                    prev["hits"] += 1
                    prev["matchedTags"].append(tk.replace("_", " "))
            out = []
            for r in am.values():
                key = r["artist"][1:].replace(" ", "_")
                prof = arts.get(key) or {}
                out.append({
                    "artist": r["artist"],
                    "zh": prof.get("zh", ""),
                    "posts": prof.get("posts", 0),
                    "topTags": prof.get("top", []),
                    "score": round(r["raw"] * (1 + 0.3 * (r["hits"] - 1)), 2),
                    "hits": r["hits"],
                    "matchedTags": r["matchedTags"],
                })
            out.sort(key=lambda x: x["score"], reverse=True)
            return self._send_json(200, {"ok": True, "artists": out[:top_k]})

        if pathname == "/api/libraries/save":
            try:
                res_all = save_library_item(body.get("kind"), body.get("item"))
                return self._send_json(200, {"ok": True, "count": len(res_all.get(body.get("kind"), []))})
            except Exception as e:
                return self._send_json(400, {"ok": False, "error": str(e)})
        if pathname == "/api/libraries/delete":
            try:
                res_all = delete_library_item(body.get("kind"), body.get("id"))
                return self._send_json(200, {"ok": True, "count": len(res_all.get(body.get("kind"), []))})
            except Exception as e:
                return self._send_json(400, {"ok": False, "error": str(e)})
        if pathname == "/api/random-schemes/save":
            try:
                res_all = save_library_item("random_schemes", body.get("scheme") or body.get("item"))
                return self._send_json(200, {"ok": True, "count": len(res_all.get("random_schemes", []))})
            except Exception as e:
                return self._send_json(400, {"ok": False, "error": str(e)})
        if pathname == "/api/random-schemes/delete":
            try:
                res_all = delete_library_item("random_schemes", body.get("id"))
                return self._send_json(200, {"ok": True, "count": len(res_all.get("random_schemes", []))})
            except Exception as e:
                return self._send_json(400, {"ok": False, "error": str(e)})
        return self._send_json(404, {"ok": False, "error": "Unknown endpoint"})

def find_available_port(p_min, p_max, preferred):
    tried = set()
    candidates = [preferred] + [random.randint(p_min, p_max) for _ in range(40)]
    for p in candidates:
        if p in tried:
            continue
        tried.add(p)
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    return preferred

def main():
    global ACTIVE_PORT
    scan_char_images()
    cleanup_redundant_tag_folders()
    sync_manifest(scan_tag_tree())

    p_min = int(os.environ.get("PORT_MIN") or 18100)
    p_max = int(os.environ.get("PORT_MAX") or 18999)
    pref = int(os.environ.get("PORT") or random.randint(p_min, p_max))
    ACTIVE_PORT = find_available_port(p_min, p_max, pref)

    try:
        with open(os.path.join(ROOT_DIR, "js", "server-port.js"), "w", encoding="utf-8") as f:
            f.write(f'window.__ACTIVE_SERVER_BASE__ = "http://127.0.0.1:{ACTIVE_PORT}";\n')
    except Exception:
        pass

    server = ThreadingHTTPServer(("127.0.0.1", ACTIVE_PORT), TagServerHandler)
    url = f"http://127.0.0.1:{ACTIVE_PORT}/"
    print(f"[Danbooru Prompt V1.0 Python 本地模块化服务] 已启动: {url}")
    if os.environ.get("AUTO_OPEN_BROWSER") == "1":
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass

if __name__ == "__main__":
    main()
