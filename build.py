#!/usr/bin/env python3
"""
Builds the distributables from src/.

- dist/league-draft.html: src/index.html + src/app.js + src/players.json
  combined into one self-contained file (required for use as a Claude
  artifact, which only renders a single HTML file).
- public/: the same page prepped for a normal static web host (Vercel's
  zero-config "public/" convention) — players.json is inlined the same way,
  but app.js stays a separate file served alongside it.
"""
import pathlib
import shutil

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / "src"
DIST = ROOT / "dist"
PUBLIC = ROOT / "public"

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

def build_web():
    html = (SRC / "index.html").read_text()
    players_json = (SRC / "players.json").read_text()
    html = html.replace("__PLAYERS_JSON__", players_json)

    PUBLIC.mkdir(exist_ok=True)
    (PUBLIC / "index.html").write_text(html)
    shutil.copyfile(SRC / "app.js", PUBLIC / "app.js")
    print(f"Built {PUBLIC / 'index.html'} + {PUBLIC / 'app.js'}")

if __name__ == "__main__":
    build()
    build_web()
