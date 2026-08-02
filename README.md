# League of Pretty Ordinary Gentlemen — Live Draft Room

A single-page, multiplayer fantasy football draft room. One person creates the
room (becoming commissioner), shares it with the league, and everyone claims
their team and drafts live from their own device.

This app ships two ways:

- **As a hosted website** (`public/` + `api/`) — sync goes through a small
  serverless API backed by Redis. This is the version to deploy to Vercel; see
  "Hosting on Vercel" below.
- **As a Claude artifact** (`dist/league-draft.html`) — sync goes through
  Claude's persistent artifact storage (`window.storage`) instead, so this
  file only works pasted into claude.ai, not opened locally.

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
api/
  storage.js    # serverless function replacing window.storage for the website
                # build: get/set/delete a key, namespaced by ?room= code,
                # backed by Redis (Upstash, or Vercel's own Storage tab)
public/
  index.html, app.js   # built website output (generated — do not hand-edit)
dist/
  league-draft.html    # built single-file Claude artifact (generated — do not hand-edit)
build.py                # generates both public/ and dist/ from src/
```

## Building

After editing anything in `src/`, rebuild both outputs with:

```
python3 build.py
```

This writes `public/index.html` + `public/app.js` (the website) and
`dist/league-draft.html` (the Claude artifact, still needed as one
self-contained file since that's the only thing Claude's artifact viewer
renders).

## Hosting on Vercel

The website version needs two things beyond static hosting: a Redis-backed
key/value store for `api/storage.js`, and the `public/` + `api/` output built
above. Vercel auto-detects both `public/` (served as the static site root) and
`api/*.js` (deployed as serverless functions) with no config file needed.

1. Push this repo somewhere Vercel can import it (e.g. GitHub), or deploy from
   your machine with the [Vercel CLI](https://vercel.com/docs/cli):
   `npm i -g vercel`, then `vercel login` (opens a browser to sign in/sign up
   — do this yourself, since it's your account).
2. In the Vercel dashboard, add a Redis database to the project from the
   **Storage** tab (Upstash-backed, free tier). This automatically sets the
   `KV_REST_API_URL` / `KV_REST_API_TOKEN` env vars that `api/storage.js`
   reads — no manual config needed. (Alternatively, create your own Upstash
   account directly and set `UPSTASH_REDIS_REST_URL` /
   `UPSTASH_REDIS_REST_TOKEN` instead — `api/storage.js` accepts either pair.)
3. From the project root, run `vercel` for a preview deploy, or `vercel --prod`
   to publish. Rooms are namespaced by a short code Vercel puts in the URL
   (`?room=ABC123`) the first time anyone opens the site — share that exact
   link with your league the same way you'd share a Claude artifact link.

## Also hosted on GitHub Pages

`src/app.js` calls the Vercel API by its absolute URL (`API_BASE` near the top
of the storage-helpers section), not a relative path — so the exact same built
`public/` output can be served from anywhere and it'll still talk to the one
live backend/Redis instance on Vercel. `api/storage.js` sends permissive CORS
headers to allow that (it's a public, unauthenticated, allowlisted endpoint
either way, so this doesn't weaken it).

`.github/workflows/pages.yml` rebuilds `public/` from `src/` and deploys it to
GitHub Pages on every push to `master` (or via manual "Run workflow"). Enable
it once per repo: **Settings → Pages → Build and deployment → Source: GitHub
Actions**.

If you ever repoint `API_BASE` at a different backend deployment, rebuild
(`python3 build.py`) before pushing so both `public/` and `dist/` pick up the
change.

## Data

`src/players.json` holds the 2026 season player pool compiled from consensus
ADP sources. Each entry: `id`, `name`, `pos`, `team`, `bye`, `adp`, `posRank`.
