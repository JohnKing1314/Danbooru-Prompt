#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Danbooru Prompt V1.0 · 外部数据与 JS 加载器同步生成脚本 (script/sync_loaders.py)
负责扫描 tags/、tags/_characters_/、user-data.json、help.md、update.md 并同步生成对应的 JS 加载器文件。
"""

import json
import os
from datetime import datetime, timezone

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TAGS_DIR = os.path.join(ROOT_DIR, "tags")
CHARS_DIR = os.path.join(TAGS_DIR, "_characters_")
JS_DIR = os.path.join(ROOT_DIR, "js")

def scan_char_tree(reconcile_indexes=True):
    if not os.path.exists(CHARS_DIR):
        return []
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    majors = []
    for fn in sorted(os.listdir(CHARS_DIR)):
        if not fn.endswith(".json") or fn in ("index.json", "manifest.json"):
            continue
        m_path = os.path.join(CHARS_DIR, fn)
        if not os.path.isfile(m_path):
            continue
        with open(m_path, "r", encoding="utf-8") as f:
            m_data = json.load(f)
        if not m_data or not m_data.get("id"):
            continue
        mid = m_data["id"]
        sub_rel = m_data.get("subDir") or mid
        sub_dir = os.path.join(CHARS_DIR, sub_rel)
        children = []
        if os.path.isdir(sub_dir):
            for sfn in sorted(os.listdir(sub_dir)):
                if not sfn.endswith(".json"):
                    continue
                s_path = os.path.join(sub_dir, sfn)
                if not os.path.isfile(s_path):
                    continue
                with open(s_path, "r", encoding="utf-8") as f:
                    s_data = json.load(f)
                if s_data and s_data.get("id"):
                    s_data["_diskFile"] = f"{sub_rel}/{sfn}"
                    children.append(s_data)
        children.sort(key=lambda x: (x.get("order", 999), x.get("id", "")))
        children_meta = []
        total_cnt = 0
        for idx, s in enumerate(children, 1):
            disk_file = s.pop("_diskFile", f"{sub_rel}/{s['id']}.json")
            c_len = len(s.get("characters", []))
            total_cnt += c_len
            children_meta.append({
                "id": s["id"],
                "name": s.get("name") or s["id"],
                "order": idx,
                "count": c_len,
                "file": disk_file,
            })
        if reconcile_indexes:
            updated_major = {
                "id": mid,
                "name": m_data.get("name") or mid,
                "icon": m_data.get("icon") or "🎮",
                "order": m_data.get("order", 99),
                "file": fn,
                "subDir": sub_rel,
                "children": children_meta,
                "count": total_cnt,
            }
            if m_data.get("children") != children_meta or m_data.get("count") != total_cnt:
                with open(m_path, "w", encoding="utf-8") as wf:
                    json.dump(updated_major, wf, ensure_ascii=False, indent=2)
                    wf.write("\n")
        m_copy = dict(m_data)
        m_copy["count"] = total_cnt
        m_copy["children"] = children
        majors.append(m_copy)
    majors.sort(key=lambda x: (x.get("order", 99), x.get("id", "")))
    if reconcile_indexes:
        index_majors = [
            {"id": m["id"], "name": m.get("name") or m["id"], "icon": m.get("icon") or "🎮", "order": i + 1, "file": m.get("file") or f"{m['id']}.json"}
            for i, m in enumerate(majors)
        ]
        manifest_majors = [
            {"id": m["id"], "name": m.get("name") or m["id"], "icon": m.get("icon") or "🎮", "order": i + 1, "file": m.get("file") or f"{m['id']}.json", "subCount": len(m.get("children", [])), "count": m.get("count", 0)}
            for i, m in enumerate(majors)
        ]
        with open(os.path.join(CHARS_DIR, "index.json"), "w", encoding="utf-8") as wf:
            json.dump({"app": "Danbooru Prompt", "version": "1.0", "type": "character_tree_manifest", "majors": index_majors}, wf, ensure_ascii=False, indent=2)
            wf.write("\n")
        with open(os.path.join(CHARS_DIR, "manifest.json"), "w", encoding="utf-8") as wf:
            json.dump({"schema": "danbooru-prompt-external-characters-v2", "version": "1.0", "updatedAt": now_iso, "majors": manifest_majors}, wf, ensure_ascii=False, indent=2)
            wf.write("\n")
    return majors

def sync_all_loaders():
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    layout_path = os.path.join(ROOT_DIR, "layout-order.json")
    with open(layout_path, "r", encoding="utf-8") as f:
        layout = json.load(f)

    major_order = layout.get("majorOrder", [])
    sub_order_by_major = layout.get("subOrderByMajor", {})

    majors_tree = []
    for m_idx, mid in enumerate(major_order):
        if mid.startswith("_"):
            continue
        m_dir = os.path.join(TAGS_DIR, mid)
        m_file = os.path.join(m_dir, f"{mid}.json")
        if not os.path.exists(m_file):
            continue
        with open(m_file, "r", encoding="utf-8") as f:
            m_data = json.load(f)
        sub_ids = sub_order_by_major.get(mid, [c["id"] for c in m_data.get("children", [])])
        children = []
        for s_idx, sid in enumerate(sub_ids):
            s_file = os.path.join(m_dir, f"{mid}_{sid}.json")
            if not os.path.exists(s_file):
                continue
            with open(s_file, "r", encoding="utf-8") as f:
                s_data = json.load(f)
            children.append({
                "id": sid,
                "name": s_data.get("name", sid),
                "icon": s_data.get("icon", "•"),
                "parentId": mid,
                "parentName": m_data.get("name", mid),
                "order": s_idx + 1,
                "file": f"{mid}/{mid}_{sid}.json",
                "updatedAt": s_data.get("updatedAt", now_iso),
                "tags": s_data.get("tags", [])
            })
        majors_tree.append({
            "id": mid,
            "name": m_data.get("name", mid),
            "icon": m_data.get("icon", "📁"),
            "order": m_idx + 1,
            "file": f"{mid}/{mid}.json",
            "subDir": mid,
            "updatedAt": m_data.get("updatedAt", now_iso),
            "children": children
        })

    manifest = {
        "schema": "danbooru-prompt-external-tags-v2",
        "version": "1.0",
        "updatedAt": now_iso,
        "majors": [
            {
                "id": m["id"],
                "name": m["name"],
                "icon": m["icon"],
                "order": m["order"],
                "file": m["file"],
                "subDir": m["subDir"],
                "subCount": len(m["children"]),
                "tagCount": sum(len(s["tags"]) for s in m["children"])
            }
            for m in majors_tree
        ]
    }
    with open(os.path.join(TAGS_DIR, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    with open(os.path.join(TAGS_DIR, "index.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")

    tags_js = (
        "/* Danbooru Prompt V1.0 · 外部标签文件夹 (tags/) 同步加载器 */\n"
        f"window.__EXT_TAG_TREE_TS__ = {json.dumps(now_iso)};\n"
        f"window.__EXT_TAG_TREE__ = {json.dumps(majors_tree, ensure_ascii=False)};\n"
    )
    with open(os.path.join(TAGS_DIR, "tags-loader.js"), "w", encoding="utf-8") as f:
        f.write(tags_js)
    with open(os.path.join(JS_DIR, "tag-fs-data.js"), "w", encoding="utf-8") as f:
        f.write("/* Danbooru Prompt V1.0 · 外部标签树桥接器 (共享 tags/tags-loader.js 内存引用) */\nwindow.PG_TAG_FS_DATA = { version: 3, updatedAt: window.__EXT_TAG_TREE_TS__, majors: window.__EXT_TAG_TREE__ || [] };\n")

    # Sync characters in tags/_characters_/
    char_majors = scan_char_tree()
    if os.path.exists(CHARS_DIR):
        chars_js = (
            "/* Danbooru Prompt V1.0 · 外部角色文件夹 (tags/_characters_/) 同步加载器 */\n"
            f"window.__EXT_CHAR_TREE__ = {json.dumps(char_majors, ensure_ascii=False)};\n"
        )
        with open(os.path.join(CHARS_DIR, "chars-loader.js"), "w", encoding="utf-8") as f:
            f.write(chars_js)

    # Sync img/img-loader.js
    img_dir = os.path.join(ROOT_DIR, "img")
    os.makedirs(img_dir, exist_ok=True)
    img_map = {}
    for dp, _dn, fns in os.walk(img_dir):
        for fn in sorted(fns):
            ext = os.path.splitext(fn)[1].lower()
            if ext in (".png", ".jpg", ".jpeg", ".webp", ".gif"):
                base = fn[:-len(ext)].lower()
                rel = os.path.relpath(os.path.join(dp, fn), ROOT_DIR).replace("\\", "/")
                if base not in img_map or ext == ".png":
                    img_map[base] = rel
    with open(os.path.join(img_dir, "img-loader.js"), "w", encoding="utf-8", newline="\n") as f:
        f.write("/* Character Image Folder Index (auto-synced with img/*) */\nwindow.__EXT_CHAR_IMGS__ = " + json.dumps(img_map, ensure_ascii=False) + ";\n")

    # Sync user-data-loader.js
    ud_path = os.path.join(ROOT_DIR, "user-data.json")
    if os.path.exists(ud_path):
        with open(ud_path, "r", encoding="utf-8") as f:
            ud = json.load(f)
        with open(os.path.join(JS_DIR, "user-data-loader.js"), "w", encoding="utf-8") as f:
            f.write("/* Danbooru Prompt V1.0 · 用户操作数据外置加载器 */\nwindow.__EXT_USER_DATA__ = " + json.dumps(ud, ensure_ascii=False) + ";\n")

    # Sync help-loader.js and changelog-loader.js
    help_path = os.path.join(ROOT_DIR, "help.md")
    if os.path.exists(help_path):
        with open(help_path, "r", encoding="utf-8") as f:
            help_md = f.read()
        with open(os.path.join(JS_DIR, "help-loader.js"), "w", encoding="utf-8") as f:
            f.write("/* Danbooru Prompt V1.0 · 使用帮助文档 (help.md) 外置加载器 */\nwindow.__DEFAULT_HELP_MD__ = " + json.dumps(help_md, ensure_ascii=False) + ";\n")

    cl_path = os.path.join(ROOT_DIR, "update.md")
    if os.path.exists(cl_path):
        with open(cl_path, "r", encoding="utf-8") as f:
            cl_md = f.read()
        with open(os.path.join(JS_DIR, "changelog-loader.js"), "w", encoding="utf-8") as f:
            f.write("/* Danbooru Prompt V1.0 · 更新日志 (update.md) 外置加载器 */\nwindow.__DEFAULT_CHANGELOG_MD__ = " + json.dumps(cl_md, ensure_ascii=False) + ";\n")

    total_chars = sum(sum(len(s.get("characters", [])) for s in cm.get("children", [])) for cm in char_majors)
    
    # Sync unified libraries/ (random_schemes, templates, presets) -> libraries/libraries-loader.js
    lib_root = os.path.join(ROOT_DIR, "libraries")
    lib_results = {}
    for kind in ("random_schemes", "templates", "presets"):
        sub_dir = os.path.join(lib_root, kind)
        os.makedirs(sub_dir, exist_ok=True)
        items = []
        for fn in sorted(os.listdir(sub_dir)):
            if fn.endswith(".json") and fn != "index.json":
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
                "items": [{"id": x.get("id") or x.get("key"), "name": x.get("name", ""), "file": f"{x.get('id') or x.get('key')}.json"} for x in items]
            }, f, ensure_ascii=False, indent=2)
        lib_results[kind] = items
    with open(os.path.join(lib_root, "libraries-loader.js"), "w", encoding="utf-8") as f:
        f.write("/* Danbooru Prompt V1.0 · Unified Libraries Loader (libraries/{random_schemes,templates,presets}) */\n")
        f.write("window.__EXT_LIBRARIES_LOADED__ = true;\n")
        f.write("window.__EXT_RANDOM_SCHEMES__ = " + json.dumps(lib_results["random_schemes"], ensure_ascii=False) + ";\n")
        f.write("window.__EXT_TEMPLATES__ = " + json.dumps(lib_results["templates"], ensure_ascii=False) + ";\n")
        f.write("window.__EXT_PRESETS__ = " + json.dumps(lib_results["presets"], ensure_ascii=False) + ";\n")
    print(f"[sync_loaders] Synced {len(majors_tree)} tag majors and {len(char_majors)} character majors ({total_chars} characters).")

if __name__ == "__main__":
    sync_all_loaders()
