#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Danbooru Prompt V1.2.4 · Anima 官方标签规范化与词库优化脚本 (script/anima_tag_optimizer.py)
规则说明：
1. 全部视觉标签使用小写字母 (lowercase)。
2. 常规标签统一使用空格 (spaces) 替代下划线 (_)，仅以下两类保留下划线或特殊符号：
   - 美学评分标签 (Score tags)：如 score_9, score_8_up, score_8, score_7_up, score_7, score_1, score_2, score_3 等。
   - ASCII 颜文字与 Booru 表情符号：如 >_<, _@, +_+, <o>_<o>, ^_^, >_@, +_-, :3, ;d 等。
3. 确保官方推荐的正向基线 (masterpiece, best quality, score_7, safe, nsfw) 与负面基线
   (worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration) 完整存在。
"""

import json
import os
import re
from datetime import datetime, timezone

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TAGS_DIR = os.path.join(ROOT_DIR, "tags")
CHARS_DIR = os.path.join(TAGS_DIR, "_characters_")

T2S_MAP = str.maketrans({
    "髷": "髻",
    "塚": "冢",
    "洩": "泄",
    "紬": "䌷",
    "菓": "果",
    "瑠": "琉",
    "喰": "食",
    "祐": "佑",
    "裡": "里",
})

KAOMOJI_SET = {
    "_@", "+_+", "<o>_<o>", ">_<", "^_^", ">_@", "+_-",
    ";d", ":3", ":d", ":p", ":o", "xd", "^^^", ">:)", ">:(", ":>=", "<3"
}

GARBLED_ZH_FIX_MAP = {
    "slapping breasts": "拍打乳房",
    "bra in mouth": "嘴叼胸罩",
    "radiation symbol-shaped pupils": "辐射标志瞳",
    "diadem": "王冠头饰",
    "tassel necklace": "流苏项链",
    "neck ring": "颈环",
    "turtleneck dress": "高领连衣裙",
}

def to_simp(s, en_key=""):
    if en_key and en_key in GARBLED_ZH_FIX_MAP:
        return GARBLED_ZH_FIX_MAP[en_key]
    if not s:
        return ""
    res = str(s).translate(T2S_MAP).replace("蝴蝶状瞳孔孔", "蝴蝶状瞳孔").replace("\ufffd", "")
    return res

def is_score_tag(s):
    return bool(re.match(r"^score_\d+(_up)?$", s))

def is_kaomoji_tag(s):
    if s in KAOMOJI_SET:
        return True
    if re.match(r"^[+_<>^@:;()=\-03dp]+$", s) and not re.match(r"^[a-z0-9]+$", s):
        return True
    return False

def format_anima_tag(raw_en, is_artist=False):
    s = str(raw_en or "").strip()
    if not s:
        return ""
    if s == "elbo+A4:B23w_gloves":
        s = "elbow gloves"
    elif s == "sex+A4A4:B445":
        s = "sex"
    has_at = s.startswith("@") or is_artist
    body = s.lstrip("@").strip() if has_at else s
    low = body.lower().strip()
    if not low:
        return ""
    if is_kaomoji_tag(low):
        return ("@" + low) if has_at else low
    m_score = re.match(r"^score[_\s]+(\d+)(?:[_\s]+(up))?$", low)
    if m_score:
        return f"score_{m_score.group(1)}" + ("_up" if m_score.group(2) else "")
    clean = re.sub(r"\s+", " ", low.replace("_", " ")).strip()
    return ("@" + clean) if has_at else clean

def optimize_all_tags():
    layout_path = os.path.join(ROOT_DIR, "layout-order.json")
    with open(layout_path, "r", encoding="utf-8") as f:
        layout = json.load(f)

    major_order = layout.get("majorOrder", [])
    sub_order_by_major = layout.get("subOrderByMajor", {})
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")

    global_seen = set()
    total_tags = 0
    dedup_count = 0

    for m_idx, mid in enumerate(major_order):
        if mid.startswith("_"):
            continue
        m_dir = os.path.join(TAGS_DIR, mid)
        m_file = os.path.join(m_dir, f"{mid}.json")
        if not os.path.exists(m_file):
            continue
        with open(m_file, "r", encoding="utf-8") as f:
            m_data = json.load(f)

        sub_ids = sub_order_by_major.get(mid, [])
        m_children_meta = []

        for s_idx, sid in enumerate(sub_ids):
            s_file = os.path.join(m_dir, f"{mid}_{sid}.json")
            if not os.path.exists(s_file):
                continue
            with open(s_file, "r", encoding="utf-8") as f:
                s_data = json.load(f)

            raw_tags = list(s_data.get("tags", []))

            if sid == "style":
                prepend_style = [
                    {"en": "masterpiece", "zh": "杰作", "rating": "g", "nsfw": False},
                    {"en": "best quality", "zh": "最佳质量", "rating": "g", "nsfw": False},
                    {"en": "score_9", "zh": "评分九分", "rating": "g", "nsfw": False},
                    {"en": "score_8_up", "zh": "评分八分以上", "rating": "g", "nsfw": False},
                    {"en": "score_8", "zh": "评分八分", "rating": "g", "nsfw": False},
                    {"en": "score_7_up", "zh": "评分七分以上", "rating": "g", "nsfw": False},
                    {"en": "score_7", "zh": "评分七分", "rating": "g", "nsfw": False},
                    {"en": "safe", "zh": "安全级", "rating": "g", "nsfw": False},
                    {"en": "nsfw", "zh": "成人内容", "rating": "q", "nsfw": True},
                ]
                raw_tags = prepend_style + raw_tags
            elif sid == "expression":
                raw_tags = raw_tags + [
                    {"en": ":3", "zh": "猫嘴表情(:3)", "rating": "g", "nsfw": False},
                    {"en": ";d", "zh": "眨眼吐舌(;d)", "rating": "g", "nsfw": False},
                ]
            elif sid == "negative":
                prepend_neg = [
                    {"en": "worst quality", "zh": "最差质量", "rating": "g", "nsfw": False},
                    {"en": "low quality", "zh": "低质量", "rating": "g", "nsfw": False},
                    {"en": "score_1", "zh": "评分一分(低质)", "rating": "g", "nsfw": False},
                    {"en": "score_2", "zh": "评分二分(低质)", "rating": "g", "nsfw": False},
                    {"en": "score_3", "zh": "评分三分(低质)", "rating": "g", "nsfw": False},
                    {"en": "artist name", "zh": "画师签名水印", "rating": "g", "nsfw": False},
                    {"en": "blurry", "zh": "画面模糊", "rating": "g", "nsfw": False},
                    {"en": "jpeg artifacts", "zh": "压缩痕迹", "rating": "g", "nsfw": False},
                    {"en": "chromatic aberration", "zh": "色差伪影", "rating": "g", "nsfw": False},
                ]
                raw_tags = prepend_neg + raw_tags

            merged = {}
            order_keys = []
            for rt in raw_tags:
                en_fmt = format_anima_tag(rt.get("en", ""), is_artist=(sid == "artist"))
                if not en_fmt:
                    continue
                zh = to_simp(rt.get("zh", ""), en_fmt).strip()
                desc = to_simp(rt.get("desc", "")).strip()
                r = rt.get("rating", "g")
                if r not in ("g", "s", "q", "e"):
                    r = "e" if rt.get("nsfw") else "g"
                if en_fmt not in merged:
                    merged[en_fmt] = {"en": en_fmt, "zh": zh, "desc": desc, "rating": r}
                    order_keys.append(en_fmt)
                else:
                    dedup_count += 1
                    ex = merged[en_fmt]
                    if not ex["zh"] and zh:
                        ex["zh"] = zh
                    if not ex["desc"] and desc:
                        ex["desc"] = desc
                    rank_r = {"g": 0, "s": 1, "q": 2, "e": 3}
                    if rank_r.get(r, 0) > rank_r.get(ex["rating"], 0):
                        ex["rating"] = r

            clean_tags = []
            for k in order_keys:
                if k in global_seen:
                    dedup_count += 1
                    continue
                global_seen.add(k)
                item = merged[k]
                r = item["rating"]
                t_obj = {
                    "en": item["en"],
                    "zh": item["zh"],
                    "rating": r,
                    "nsfw": (r == "q" or r == "e")
                }
                if item["desc"]:
                    t_obj["desc"] = item["desc"]
                clean_tags.append(t_obj)
                total_tags += 1

            s_data["name"] = to_simp(s_data.get("name", sid))
            s_data["order"] = s_idx + 1
            s_data["count"] = len(clean_tags)
            s_data["updatedAt"] = now_iso
            s_data["tags"] = clean_tags
            with open(s_file, "w", encoding="utf-8") as f:
                json.dump(s_data, f, ensure_ascii=False, indent=2)
                f.write("\n")

            m_children_meta.append({
                "id": sid,
                "name": s_data["name"],
                "icon": s_data.get("icon", "•"),
                "order": s_idx + 1,
                "count": len(clean_tags),
                "file": f"{mid}/{mid}_{sid}.json"
            })

        m_data["name"] = to_simp(m_data.get("name", mid))
        m_data["order"] = m_idx + 1
        m_data["count"] = len(m_children_meta)
        m_data["updatedAt"] = now_iso
        m_data["children"] = m_children_meta
        with open(m_file, "w", encoding="utf-8") as f:
            json.dump(m_data, f, ensure_ascii=False, indent=2)
            f.write("\n")

    # Normalize character auto tags inside tags/_characters_/<group>/*.json
    if os.path.exists(CHARS_DIR):
        for c_group in ("games", "anime", "vtuber", "custom"):
            sub_dir = os.path.join(CHARS_DIR, c_group)
            if not os.path.isdir(sub_dir):
                continue
            for fn in sorted(os.listdir(sub_dir)):
                if not fn.endswith(".json"):
                    continue
                s_path = os.path.join(sub_dir, fn)
                with open(s_path, "r", encoding="utf-8") as f:
                    s_data = json.load(f)
                for ch in s_data.get("characters", []):
                    if ch.get("name"):
                        ch["name"] = to_simp(ch["name"])
                    if ch.get("charZh"):
                        ch["charZh"] = to_simp(ch["charZh"])
                    if ch.get("tag"):
                        ch["tag"] = format_anima_tag(ch["tag"])
                    if ch.get("auto"):
                        parts = [p.strip() for p in str(ch["auto"]).split(";") if p.strip()]
                        new_parts = []
                        for p in parts:
                            if "|" in p:
                                en_p, zh_p = p.split("|", 1)
                                new_parts.append(f"{format_anima_tag(en_p)}|{to_simp(zh_p.strip())}")
                            else:
                                new_parts.append(format_anima_tag(p))
                        ch["auto"] = ";".join(new_parts)
                with open(s_path, "w", encoding="utf-8") as f:
                    json.dump(s_data, f, ensure_ascii=False, indent=2)
                    f.write("\n")

    print(f"[anima_tag_optimizer] Done! Total unique tags: {total_tags} (deduped: {dedup_count})")

if __name__ == "__main__":
    optimize_all_tags()
