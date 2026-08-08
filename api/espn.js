// Proxies ESPN's (unofficial, undocumented) fantasy football league API so the
// browser can import team names/roster/scoring settings without hitting CORS
// — and so private-league cookies (espn_s2/SWID) are sent as a real Cookie
// header, which `fetch` from a web page is not allowed to set itself.
//
// POST /api/espn  { leagueId, season, espnS2?, swid? }
//   -> { leagueName, numTeams, teams:[{id,name,owner}], roster:{QB,RB,WR,TE,FLEX,DST,K,BN},
//        scoring:{reception?,passYdPt?,passTD?,rushYdPt?,rushTD?,recYdPt?,recTD?} }
//
// `owner` is the team's primary manager's real name if ESPN reports one
// (falls back to their ESPN display name, then null if neither is present —
// some leagues/privacy settings omit both).
//
// `scoring` is derived from ESPN's scoringItems (statId -> points-per-unit),
// keyed by a handful of well-known-but-unofficial stat IDs — only the keys
// ESPN actually reported are included, so callers should treat missing keys
// as "unknown" rather than zero. Nothing here is persisted — cookies are
// forwarded to ESPN for this one request only and never written to storage
// or logs.

const SLOT_MAP = {'0':'QB','2':'RB','4':'WR','6':'TE','23':'FLEX','16':'DST','17':'K','20':'BN'};

// Reverse-engineered from public ESPN fantasy API documentation projects —
// undocumented and best-effort, like the rest of this integration.
const SCORING_STAT_MAP = {
  '3': 'passYdPt', '4': 'passTD',
  '24': 'rushYdPt', '25': 'rushTD',
  '42': 'recYdPt', '43': 'recTD',
  '53': 'reception',
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  try {
    const body = req.body || {};
    const leagueId = String(body.leagueId || '').trim();
    const season = String(body.season || '').trim();
    const espnS2 = typeof body.espnS2 === 'string' ? body.espnS2.trim() : '';
    const swid = typeof body.swid === 'string' ? body.swid.trim() : '';

    if (!/^\d{3,12}$/.test(leagueId)) {
      return res.status(400).json({ error: 'Enter a valid numeric ESPN league ID.' });
    }
    if (!/^20\d\d$/.test(season)) {
      return res.status(400).json({ error: 'Enter a valid season year, e.g. 2026.' });
    }

    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=mSettings&view=mTeam`;
    const headers = { Accept: 'application/json' };
    if (espnS2 && swid) {
      const swidVal = swid.startsWith('{') ? swid : `{${swid}}`;
      headers.Cookie = `espn_s2=${espnS2}; SWID=${swidVal}`;
    }

    const espnRes = await fetch(url, { headers });

    if (espnRes.status === 401 || espnRes.status === 403) {
      return res.status(403).json({
        error: 'ESPN says this league is private. Add your espn_s2 and SWID cookies (from a browser logged into that league) and try again.',
      });
    }
    if (espnRes.status === 404) {
      return res.status(404).json({ error: 'No ESPN league found with that ID and season.' });
    }
    if (!espnRes.ok) {
      return res.status(502).json({ error: `ESPN returned an unexpected error (${espnRes.status}).` });
    }

    const data = await espnRes.json();

    const memberNameById = {};
    (data.members || []).forEach(m => {
      const full = [m.firstName, m.lastName].filter(Boolean).join(' ').trim();
      memberNameById[m.id] = full || m.displayName || null;
    });

    const teams = (data.teams || [])
      .map(t => {
        const ownerId = (Array.isArray(t.owners) && t.owners[0]) || t.primaryOwner || null;
        return {
          id: t.id,
          name: t.name || [t.location, t.nickname].filter(Boolean).join(' ') || `Team ${t.id}`,
          owner: ownerId ? (memberNameById[ownerId] || null) : null,
        };
      })
      .sort((a, b) => a.id - b.id);

    if (!teams.length) {
      return res.status(502).json({ error: "ESPN didn't return any teams for that league — double check the league ID and season." });
    }

    const slotCounts = (data.settings && data.settings.rosterSettings && data.settings.rosterSettings.lineupSlotCounts) || {};
    const roster = { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, DST: 0, K: 0, BN: 0 };
    Object.entries(slotCounts).forEach(([slotId, count]) => {
      const key = SLOT_MAP[slotId];
      if (key && count > 0) roster[key] = count;
    });

    const scoringItems = (data.settings && data.settings.scoringSettings && data.settings.scoringSettings.scoringItems) || [];
    const scoring = {};
    scoringItems.forEach(item => {
      const key = SCORING_STAT_MAP[String(item.statId)];
      if (key && typeof item.points === 'number') scoring[key] = item.points;
    });

    return res.status(200).json({
      leagueName: (data.settings && data.settings.name) || 'ESPN League',
      numTeams: teams.length,
      teams,
      roster,
      scoring,
    });
  } catch (e) {
    console.error('espn import error', e);
    return res.status(500).json({ error: 'Could not reach ESPN — try again in a moment.' });
  }
};
