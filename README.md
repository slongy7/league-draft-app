# League of Pretty Ordinary Gentlemen — Live Draft Room

A single-page, multiplayer fantasy football draft room. One person creates the
room (becoming commissioner), shares it with the league, and everyone claims
their team and drafts live from their own device. State is synced through
Claude's persistent artifact storage (`window.storage`), so it only runs as a
live Claude artifact — not as a plain downloaded HTML file opened locally.

## Features

- Live multiplayer snake draft with real-time sync across everyone in the room
- Commissioner role (room creator) with sole control over:
  - Draft order (shuffle, or manually reorder teams any time)
  - Keepers (assign a player to a team pre-draft; costs that team's pick in a chosen round)
  - Pick restrictions (block a team from picking in a specific round)
- Configurable roster format (QB/RB/WR/TE/FLEX/DST/K counts, bench size)
- Searchable/filterable player pool (2026 season ADP data, ~258 players)
- Live draft board, per-team roster views, and a downloadable results recap

## Project structure

```
src/
  index.html    # page shell, styles, screen markup (template — has a
                # __PLAYERS_JSON__ placeholder that gets filled in at build time)
  app.js        # all application logic
  players.json  # player pool (name, position, team, bye week, ADP)
dist/
  league-draft.html   # built single-file artifact (generated — do not hand-edit)
build.py               # combines src/ into dist/league-draft.html
```

## Building

The app has to ship as one self-contained HTML file to work as a Claude
artifact. After editing anything in `src/`, rebuild with:

```
python3 build.py
```

This writes `dist/league-draft.html`. That file is what gets uploaded/pasted
in as the Claude artifact.

## Data

`src/players.json` holds the 2026 season player pool compiled from consensus
ADP sources. Each entry: `id`, `name`, `pos`, `team`, `bye`, `adp`, `posRank`.
