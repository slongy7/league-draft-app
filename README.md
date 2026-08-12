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
- Claim a team and rename it to whatever you want — no need to wait on the commissioner
- Mock drafts: practice solo against auto-picking bots, entirely on your device — no
  invite link, no other players needed (see "Mock drafts" below)
- Commissioner role (room creator) with sole control over:
  - Draft order (shuffle, or manually reorder teams any time)
  - Keepers (assign a player to a team pre-draft; costs that team's pick in a chosen round —
    can be set right on the setup screen before creating the room, or added later from the
    lobby; also works for mock drafts, which skip the lobby entirely)
  - Pick restrictions (block a team from picking in a specific round — can also be set on
    the setup screen before creating the room, or added later from the lobby; works for
    mock drafts too)
  - Custom stat columns (add any stat you want tracked, then fill in a value per player from
    that player's detail popup — columns can be defined on the setup screen before creating
    the room, or added later from the lobby; also works for mock drafts, where you can edit
    values yourself since there's no separate commissioner)
- Configurable roster format (QB/RB/WR/TE/FLEX/DST/K counts, bench size)
- Searchable/filterable player pool (2026 season ADP data, ~258 players) with age, injury
  history, projected season points, and a full stat line (including receptions for RBs) —
  click any player's name to see the details
- Import from an existing ESPN fantasy league (team names, count, roster format) — public
  or private leagues, via `api/espn.js`
- Import your own cheat sheet (CSV) to sort the available-players list by your rankings
  instead of ADP — works for both mock and live drafts (see "Cheat sheet import" below)
- Live draft board, per-team roster views, and a downloadable results recap
- Share results with one tap (native share sheet on mobile, clipboard copy on
  desktop) — a round-1 recap plus a link that opens straight to the results
  screen, no extra clicks

## Cheat Sheet Generator

A standalone companion tool for pre-draft prep — `dist/cheat-sheet-generator.html`
(Claude artifact) or `public/cheatsheet.html` (hosted website). Built from
`src/cheatsheet/`, sharing the same `src/players.json` pool as the draft room,
but otherwise fully independent (no room, no live sync — everything is kept
in that browser's `localStorage`).

- **Players tab**: searchable/filterable/sortable player list with tiers
  (auto-clustered by projected points within each position — a color ramp
  from bright to muted marks each tier, with divider bars showing the point
  range when a single position is filtered), season projected points, and
  receptions called out for every RB/WR/TE. Click a player to expand their
  full stat line, age, and injury notes.
- **Scoring**: defaults to half-PPR (0.5 pts/reception); the PPR field next
  to League size recomputes every RB/WR/TE/QB projection, tier, and offense
  grade live. K/DST projections don't move — the season stats here are
  aggregate totals with no FG-distance or points-allowed tiers to rescale.
- **Keeper leagues**: mark any player "kept" (individually or in bulk via
  checkboxes) to pull them out of the pool — they collapse into a "Kept /
  unavailable" section and can be restored any time.
- **Custom stats**: add any stat column you want tracked (e.g. target share,
  strength of schedule) and fill in values inline; stored alongside the
  built-in stats and included in CSV export.
- **FantasyPros (or any expert) rank vs. ADP**: enter a player's expert rank
  one at a time, or paste in a whole ranked list at once ("Import FantasyPros
  ranks"). FantasyPros' Expert Consensus Rankings (100+ experts blended) are
  free to view, no subscription — but this app still doesn't ship with them
  pre-loaded, since redistributing their compiled rankings isn't ours to do;
  you copy the list from fantasypros.com and paste it in. Either way, an
  "ADP Diff" column shows ADP minus expert rank: positive means the market
  is drafting them later than the expert has them (a value/sleeper),
  negative means earlier (a reach).
- **Import league rules from ESPN**: pulls team count, roster format, and
  scoring (points per reception/yard/touchdown) from an existing ESPN league
  via `api/espn.js` — same best-effort proxy the draft room uses, public or
  private (with `espn_s2`/`SWID` cookies). Any scoring value ESPN doesn't
  report is left at its current setting rather than being reset.
- **Team Offense tab**: all 32 teams graded A+ through F from the combined
  season projection of their likely starting core (QB1, top 2 RBs, top 3
  WRs, TE1) — a gut-check for skill-position depth, streaming a QB/DST, or
  picking a stack.
- **Draft Strategy tab**: pick a strategy (Best Player Available, Hero RB,
  Zero RB, Robust RB, Zero WR, Late-Round QB, Stream DST/K) and it flags
  players on the Players tab as a round-based "Priority" or "Fade" fit for
  that build.
- Export the current view to CSV, or print a clean black-and-white sheet.

## Project structure

```
src/
  index.html    # page shell, styles, screen markup (template — has a
                # __PLAYERS_JSON__ placeholder that gets filled in at build time)
  app.js        # all application logic
  players.json  # player pool (name, position, team, bye week, ADP)
  cheatsheet/
    index.html  # Cheat Sheet Generator page shell + styles (same template
                # pattern, reuses src/players.json)
    app.js      # Cheat Sheet Generator logic
api/
  storage.js    # serverless function replacing window.storage for the website
                # build: get/set/delete a key, namespaced by ?room= code,
                # backed by Redis (Upstash, or Vercel's own Storage tab)
  espn.js       # proxies ESPN's fantasy API so the browser can import a
                # league without hitting CORS, and so private-league cookies
                # can be sent as a real Cookie header
scripts/
  enrich_players.py  # (re-)generates the age/injury/projections/stats fields
                     # in src/players.json — see "Data" below
public/
  index.html, app.js        # built website output (generated — do not hand-edit)
  cheatsheet.html, cheatsheet.js  # built Cheat Sheet Generator (generated)
dist/
  league-draft.html         # built single-file Claude artifact (generated — do not hand-edit)
  cheat-sheet-generator.html  # built single-file Cheat Sheet Generator artifact (generated)
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

## Mock drafts

From the setup screen, "🎲 Start mock draft" skips the shared room entirely —
config and picks are kept in `localStorage` only (`mock_`-prefixed keys), so
it works even if the backend is unreachable and never touches another user's
data. Pick your draft slot (or "Random"), and every other team drafts for
itself: best player available by ADP, honoring roster needs, with a little
randomness so mocks don't play out identically every time. The draft
auto-advances through bot picks and stops on your turn; "⏩ Simulate rest"
finishes out the whole draft (including your remaining picks) instantly if
you just want to see a finished board. "Start a new draft" on the results
screen re-runs the same settings; "New mock draft" changes them.

## ESPN league import

On the setup screen, the commissioner can pull team count/names/roster format
straight from an existing ESPN league instead of typing them in by hand.
Public leagues only need the numeric league ID (visible in the ESPN URL).
Private leagues also need the `espn_s2` and `SWID` cookies from a browser
logged into that league (DevTools → Application → Cookies → espn.com) — these
are sent to `api/espn.js` for that one request only and never stored.
ESPN's league API is unofficial and undocumented, so treat this as best-effort:
if it fails, the error message explains why and you can still fill in the
form manually.

## Cheat sheet import

On the setup screen, upload a cheat sheet CSV to sort the available-players list by
your own rankings instead of ADP. It accepts the export from this app's own
[Cheat Sheet Generator](#cheat-sheet-generator) directly, or any CSV with at least
`Name` and `Rank` columns — `Pos`/`Team` disambiguate players who share a name, and
`Tier` (if present) shows next to the rank. Players are matched by exact name.

Once a cheat sheet is loaded, both mock and live drafts show a "My cheat sheet / ADP"
toggle above the player list (defaulting to your cheat sheet) and a Rank column —
switch back to ADP any time without losing the upload. Rooms created without a cheat
sheet don't show the toggle at all.

## Data

`src/players.json` holds the 2026 season player pool compiled from consensus
ADP sources. Each entry: `id`, `name`, `pos`, `team`, `bye`, `adp`, `posRank`,
`age`, `injuries` (array of notes, `["No major injuries on record"]` if none
known), `projPts` (projected season fantasy points), and `stats` — a
position-appropriate stat line (e.g. `rushYds`/`rec`/`recYds`/`recTD` for
RBs, so PPR-relevant receptions are tracked for every running back).

Age and injury notes are hand-curated for the ~120 most-drafted players from
public reporting; everyone else gets a formula-based estimate as a starting
point. All of it — plus league-specific stats you define yourself — can be
edited from each player's detail popup in the draft room (commissioner only)
via the "Custom stats" card in the lobby. To regenerate the built-in fields
after updating the base player list, run `python3 scripts/enrich_players.py`
then `python3 build.py`.
