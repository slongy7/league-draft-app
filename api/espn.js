// Proxies ESPN's (unofficial, undocumented) fantasy football league API so the
// browser can import team names/roster settings without hitting CORS — and so
// private-league cookies (espn_s2/SWID) are sent as a real Cookie header,
// which `fetch` from a web page is not allowed to set itself.
//
// POST /api/espn  { leagueId, season, espnS2?, swid? }
//   -> { leagueName, numTeams, teams:[{id,name}], roster:{QB,RB,WR,TE,FLEX,DST,K,BN} }
//
// Nothing here is persisted — cookies are forwarded to ESPN for this one
// request only and never written to storage or logs.

const SLOT_MAP = {'0':'QB','2':'RB','4':'WR','6':'TE','23':'FLEX','16':'DST','17':'K','20':'BN'};

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
    const teams = (data.teams || [])
      .map(t => ({
        id: t.id,
        name: t.name || [t.location, t.nickname].filter(Boolean).join(' ') || `Team ${t.id}`,
      }))
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

    return res.status(200).json({
      leagueName: (data.settings && data.settings.name) || 'ESPN League',
      numTeams: teams.length,
      teams,
      roster,
    });
  } catch (e) {
    console.error('espn import error', e);
    return res.status(500).json({ error: 'Could not reach ESPN — try again in a moment.' });
  }
};
