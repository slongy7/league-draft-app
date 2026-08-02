#!/usr/bin/env python3
"""
Builds the single-file distributable from src/.

Combines src/index.html + src/app.js + src/players.json into one
self-contained HTML file at dist/league-draft.html (required for use
as a Claude artifact, which only renders a single HTML file).
"""
import pathlib

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / "src"
DIST = ROOT / "dist"

def build():
    html = (SRC / "index.html").read_text()
    players_json = (SRC / "players.json").read_text()
    app_js = (SRC / "app.js").read_text()

    html = html.replace("__PLAYERS_JSON__", players_json)
    html = html.replace(
        '<script src="app.js"></script>',
        f"<script>\n{app_js}\n</script>",
    )

    DIST.mkdir(exist_ok=True)
    out_path = DIST / "league-draft.html"
    out_path.write_text(html)
    print(f"Built {out_path} ({len(html):,} bytes)")

if __name__ == "__main__":
    build()
