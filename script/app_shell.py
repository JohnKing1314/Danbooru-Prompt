#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Danbooru Prompt V1.0 · 零根目录 HTML 动态入口壳生成器 (script/app_shell.py)
由 script/tag_server.py 在内存中动态拼装完整页面并返回给浏览器，集成离线全量词库、别名库、共现推荐与画师特征引擎。
"""

def build_app_entry_html(active_port: int = 8177) -> str:
    server_base_script = f'<script>window.__ACTIVE_SERVER_BASE__ = "http://127.0.0.1:{active_port}";</script>'
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Danbooru Prompt V1.0</title>
<link id="pageFavicon" rel="icon" href="logo_chibi.ico">
<link rel="stylesheet" href="js/app-styles.css">
</head>
<body>
<div id="appRoot"></div>
{server_base_script}
<script src="js/ico-assets.js"></script>
<script src="js/app-layout.js"></script>
<script>
(function(){{
  var root = document.getElementById('appRoot');
  if (root && !document.getElementById('catNav') && window.__APP_LAYOUT_HTML__) {{
    root.outerHTML = window.__APP_LAYOUT_HTML__;
  }}
}})();
</script>
<script src="tags/aux-loader.js"></script>
<script src="tags/tags-loader.js"></script>
<script src="tags/_characters_/chars-loader.js"></script>
<script src="img/img-loader.js"></script>
<script src="tags/_offline_db_/alias-loader.js"></script>
<script src="tags/_offline_db_/cooc-loader.js"></script>
<script src="tags/_offline_db_/artist-loader.js"></script>
<script src="tags/_offline_db_/full-dict-loader.js"></script>
<script src="js/help-loader.js"></script>
<script src="js/changelog-loader.js"></script>
<script src="materials/materials-loader.js"></script>
<script src="libraries/libraries-loader.js"></script>
<script src="js/user-data-loader.js"></script>
<script src="js/tag-fs-data.js"></script>
<script src="js/external-fs-engine.js"></script>
<script src="js/app.js"></script>
</body>
</html>
"""
