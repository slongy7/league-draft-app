/* Cheat Sheet Generator — all logic lives here. Data comes from window.__PLAYERS__
   (inlined at build time from src/players.json — see build.py). */
(function(){
'use strict';

const PLAYERS = window.__PLAYERS__ || [];
const API_BASE = 'https://league-draft-app.vercel.app';

// Points-per-unit scoring. K/DST aren't included — their season totals here are
// aggregate (no FG-distance or points-allowed tiers), so there's nothing to
// recompute; their projection stays fixed regardless of these settings.
const DEFAULT_SCORING = {
  reception: 0.5,
  passYdPt: 0.04, passTD: 4,
  rushYdPt: 0.1, rushTD: 6,
  recYdPt: 0.1, recTD: 6,
};

const POS_ORDER = ['QB','RB','WR','TE','DST','K'];
const POS_STATS = {
  QB:  [['passYds','Pass Yd'],['passTD','Pass TD'],['rushYds','Rush Yd'],['rushTD','Rush TD']],
  RB:  [['rushYds','Rush Yd'],['rushTD','Rush TD'],['rec','Rec'],['recYds','Rec Yd'],['recTD','Rec TD']],
  WR:  [['rec','Rec'],['recYds','Rec Yd'],['recTD','Rec TD'],['rushYds','Rush Yd']],
  TE:  [['rec','Rec'],['recYds','Rec Yd'],['recTD','Rec TD']],
  DST: [['sacks','Sacks'],['int','INT'],['defTD','Def TD']],
  K:   [['fgMade','FG Made'],['fgAtt','FG Att']],
};

const STRATEGIES = {
  bpa: {
    name: 'Best Player Available', short: 'BPA',
    desc: 'Draft the highest-ranked player on the board every round regardless of position. The safest, most flexible approach — lets the draft come to you instead of forcing positions.',
    rules: [],
  },
  heroRB: {
    name: 'Hero RB', short: 'Hero RB',
    desc: 'Lock in one true workhorse RB in the first two rounds, then pivot hard to WR/TE for the next several rounds while RB depth is bad. Circle back for high-upside RB flyers in the middle rounds.',
    rules: [
      {pos:['RB'], min:1, max:2, tag:'priority'},
      {pos:['RB'], min:3, max:6, tag:'fade'},
      {pos:['WR','TE'], min:2, max:6, tag:'priority'},
      {pos:['RB'], min:7, max:10, tag:'priority'},
    ],
  },
  zeroRB: {
    name: 'Zero RB', short: 'Zero RB',
    desc: 'Avoid RB entirely for the first five or so rounds — bank the safer, more predictable WR/TE/elite-QB production instead — then buy the RB dip once starting jobs and volume shake out.',
    rules: [
      {pos:['RB'], min:1, max:5, tag:'fade'},
      {pos:['WR','TE','QB'], min:1, max:5, tag:'priority'},
      {pos:['RB'], min:6, max:10, tag:'priority'},
    ],
  },
  robustRB: {
    name: 'Robust RB', short: 'Robust RB',
    desc: 'Draft RB with two or three of your first three picks to build an overwhelming positional advantage at the scarcest position, then pivot hard to WR once the backfield is set.',
    rules: [
      {pos:['RB'], min:1, max:3, tag:'priority'},
      {pos:['WR'], min:1, max:3, tag:'fade'},
      {pos:['WR'], min:4, max:8, tag:'priority'},
    ],
  },
  zeroWR: {
    name: 'Zero WR', short: 'Zero WR',
    desc: 'A rarer contrarian build: hammer RB and elite TE early since WR is the deepest position, then mine WR value in the middle rounds after the run settles.',
    rules: [
      {pos:['WR'], min:1, max:4, tag:'fade'},
      {pos:['RB','TE'], min:1, max:4, tag:'priority'},
      {pos:['WR'], min:5, max:9, tag:'priority'},
    ],
  },
  lateQB: {
    name: 'Late-Round QB', short: 'Late QB',
    desc: 'Treat QB as replaceable — wait until round nine or later for your starter — and use the saved early picks to stack RB/WR value instead.',
    rules: [
      {pos:['QB'], min:1, max:8, tag:'fade'},
      {pos:['QB'], min:9, max:99, tag:'priority'},
    ],
  },
  streamDstK: {
    name: 'Stream DST/K', short: 'Stream D/K',
    desc: 'Ignore kicker and defense entirely until the final couple rounds — week-to-week variance swamps any perceived skill gap, so there is no value in reaching early.',
    rules: [
      {pos:['DST','K'], min:1, max:14, tag:'fade'},
      {pos:['DST','K'], min:15, max:99, tag:'priority'},
    ],
  },
};

const LS_PREFIX = 'cheatsheet_';
const LS = {
  removed: LS_PREFIX+'removed_v1',
  customStats: LS_PREFIX+'custom_stats_v1',
  customValues: LS_PREFIX+'custom_values_v1',
  strategy: LS_PREFIX+'strategy_v1',
  numTeams: LS_PREFIX+'num_teams_v1',
  expertRank: LS_PREFIX+'expert_rank_v1',
  scoring: LS_PREFIX+'scoring_v1',
};

function loadJSON(key, fallback){
  try{ const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch(e){ return fallback; }
}
function saveJSON(key, val){ try{ localStorage.setItem(key, JSON.stringify(val)); }catch(e){} }

const state = {
  removed: new Set(loadJSON(LS.removed, [])),
  customStats: loadJSON(LS.customStats, []), // [{key,label}]
  customValues: loadJSON(LS.customValues, {}), // {playerId: {statKey: value}}
  strategy: loadJSON(LS.strategy, 'bpa'),
  numTeams: loadJSON(LS.numTeams, 12),
  expertRank: loadJSON(LS.expertRank, {}), // {playerId: rank} — commissioner-entered Draft Sharks (or any expert) rank
  scoring: Object.assign({}, DEFAULT_SCORING, loadJSON(LS.scoring, {})),
  search: '',
  pos: 'ALL',
  team: 'ALL',
  showRemoved: false,
  sortKey: 'adp',
  sortDir: 'asc',
  expanded: null,
  selected: new Set(),
  tab: 'players',
};

function persistRemoved(){ saveJSON(LS.removed, Array.from(state.removed)); }
function persistCustomStats(){ saveJSON(LS.customStats, state.customStats); }
function persistCustomValues(){ saveJSON(LS.customValues, state.customValues); }
function persistStrategy(){ saveJSON(LS.strategy, state.strategy); }
function persistNumTeams(){ saveJSON(LS.numTeams, state.numTeams); }
function persistExpertRank(){ saveJSON(LS.expertRank, state.expertRank); }
function persistScoring(){ saveJSON(LS.scoring, state.scoring); }

function esc(s){
  return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmt(n){
  if(n==null || n==='') return '—';
  const num = Number(n);
  if(Number.isNaN(num)) return esc(n);
  return num % 1 === 0 ? num.toLocaleString() : num.toFixed(1);
}

/* ---------------- derived data ---------------- */

function round1(n){ return Math.round(n*10)/10; }

// Recomputes season points from the raw stat line using state.scoring, so the
// PPR value (and anything imported from ESPN) is reflected everywhere. K/DST
// have no per-unit breakdown available (aggregate FG/points-allowed only), so
// their baked-in projection is used as-is.
function computeProjPts(p){
  const s = p.stats || {};
  const sc = state.scoring;
  if(p.pos === 'QB'){
    return round1((s.passYds||0)*sc.passYdPt + (s.passTD||0)*sc.passTD + (s.rushYds||0)*sc.rushYdPt + (s.rushTD||0)*sc.rushTD);
  }
  if(p.pos === 'RB'){
    return round1((s.rushYds||0)*sc.rushYdPt + (s.rushTD||0)*sc.rushTD + (s.rec||0)*sc.reception + (s.recYds||0)*sc.recYdPt + (s.recTD||0)*sc.recTD);
  }
  if(p.pos === 'WR'){
    return round1((s.rec||0)*sc.reception + (s.recYds||0)*sc.recYdPt + (s.recTD||0)*sc.recTD + (s.rushYds||0)*sc.rushYdPt);
  }
  if(p.pos === 'TE'){
    return round1((s.rec||0)*sc.reception + (s.recYds||0)*sc.recYdPt + (s.recTD||0)*sc.recTD);
  }
  return p.projPts;
}

// Tier colors run a single hue (the Corten rust) from bright/saturated at
// tier 1 down to dark/muted at the deepest tier, so the ramp itself reads as
// "talent fading out" rather than an arbitrary rainbow.
function tierHsl(tier){
  const idx = Math.max(0, tier-1);
  return {
    hue: Math.max(0, 30 - idx*3),
    sat: Math.max(35, 70 - idx*4),
    light: Math.max(30, 62 - idx*4),
  };
}
function tierColor(tier){ const c = tierHsl(tier); return `hsl(${c.hue},${c.sat}%,${c.light}%)`; }
function tierColorAlpha(tier, a){ const c = tierHsl(tier); return `hsla(${c.hue},${c.sat}%,${c.light}%,${a})`; }

// 1D k-means over point value (not rank) — real drop-offs pull into their own
// cluster, and near-linear stretches (this dataset's late-round formula
// curves are close to linear) still split into evenly-spaced tiers instead
// of collapsing into one, which a pure gap-threshold approach would do.
function kmeansTiers(pts, k){
  const n = pts.length;
  k = Math.max(1, Math.min(k, n));
  if(k <= 1) return pts.map(() => 1);
  const min = Math.min(...pts), max = Math.max(...pts);
  let centroids = Array.from({length:k}, (_,i) => max - (i+0.5)*(max-min)/k);
  let assign = new Array(n).fill(0);
  for(let iter=0; iter<40; iter++){
    let changed = false;
    for(let i=0;i<n;i++){
      let best = 0, bestDist = Infinity;
      for(let c=0;c<k;c++){
        const d = Math.abs(pts[i]-centroids[c]);
        if(d < bestDist){ bestDist = d; best = c; }
      }
      if(assign[i] !== best){ assign[i] = best; changed = true; }
    }
    const sums = new Array(k).fill(0), counts = new Array(k).fill(0);
    for(let i=0;i<n;i++){ sums[assign[i]] += pts[i]; counts[assign[i]]++; }
    for(let c=0;c<k;c++){ if(counts[c] > 0) centroids[c] = sums[c]/counts[c]; }
    if(!changed) break;
  }
  const order = centroids.map((c,i) => ({c,i})).sort((a,b) => b.c-a.c);
  const clusterToTier = {};
  order.forEach((o,rank) => { clusterToTier[o.i] = rank+1; });
  return pts.map((_,i) => clusterToTier[assign[i]]);
}

function computeTiers(players){
  const byPos = {};
  players.forEach(p => { (byPos[p.pos] = byPos[p.pos]||[]).push(p); });
  const tierMap = {};
  Object.keys(byPos).forEach(pos => {
    const list = byPos[pos].slice().sort((a,b)=>computeProjPts(b)-computeProjPts(a));
    const pts = list.map(computeProjPts);
    const k = Math.max(2, Math.min(8, Math.round(list.length/9) || 2));
    const tiers = kmeansTiers(pts, k);
    list.forEach((p,i) => { tierMap[p.id] = tiers[i]; });
  });
  return tierMap;
}

function gradeForRank(rank, n){
  const pct = rank/n;
  if(pct<=0.0625) return 'A+';
  if(pct<=0.15625) return 'A';
  if(pct<=0.25) return 'A-';
  if(pct<=0.34375) return 'B+';
  if(pct<=0.4375) return 'B';
  if(pct<=0.53125) return 'B-';
  if(pct<=0.625) return 'C+';
  if(pct<=0.71875) return 'C';
  if(pct<=0.8125) return 'C-';
  if(pct<=0.875) return 'D+';
  if(pct<=0.9375) return 'D';
  if(pct<=0.96875) return 'D-';
  return 'F';
}
function gradeColorVar(grade){
  if(grade[0]==='A') return 'var(--grade-a)';
  if(grade[0]==='B') return 'var(--grade-b)';
  if(grade[0]==='C') return 'var(--grade-c)';
  return 'var(--grade-d)';
}

let offenseGrades = {}; // team -> {rank, score, grade, core:[players]}
function computeOffenseGrades(players){
  const byTeam = {};
  players.forEach(p => {
    if(p.pos==='DST' || p.pos==='K') return;
    (byTeam[p.team] = byTeam[p.team]||[]).push(p);
  });
  const rows = Object.keys(byTeam).map(team => {
    const list = byTeam[team];
    const qb = list.filter(p=>p.pos==='QB').sort((a,b)=>computeProjPts(b)-computeProjPts(a))[0];
    const rbs = list.filter(p=>p.pos==='RB').sort((a,b)=>computeProjPts(b)-computeProjPts(a)).slice(0,2);
    const wrs = list.filter(p=>p.pos==='WR').sort((a,b)=>computeProjPts(b)-computeProjPts(a)).slice(0,3);
    const te = list.filter(p=>p.pos==='TE').sort((a,b)=>computeProjPts(b)-computeProjPts(a))[0];
    const core = [qb, ...rbs, ...wrs, te].filter(Boolean);
    const score = core.reduce((s,p)=>s+computeProjPts(p),0);
    return {team, score, core};
  });
  rows.sort((a,b)=>b.score-a.score);
  const n = rows.length;
  const grades = {};
  rows.forEach((r,i) => {
    const rank = i+1;
    grades[r.team] = {rank, score:r.score, grade:gradeForRank(rank,n), core:r.core};
  });
  return grades;
}

function impliedRound(adp, numTeams){
  return Math.max(1, Math.ceil(adp / numTeams));
}
function strategyFit(player, strategyKey, numTeams){
  const strat = STRATEGIES[strategyKey];
  if(!strat || !strat.rules.length) return null;
  const round = impliedRound(player.adp, numTeams);
  for(const rule of strat.rules){
    if(rule.pos.includes(player.pos) && round >= rule.min && round <= rule.max){
      return {tag: rule.tag, round};
    }
  }
  return {tag:'neutral', round};
}

let tierMap = {};
offenseGrades = computeOffenseGrades(PLAYERS);

// Positive diff = ADP later than the expert rank (market undervaluing = a value).
// Negative diff = ADP earlier than the expert rank (market overvaluing = a reach).
function adpDiff(p){
  const rank = state.expertRank[p.id];
  if(rank==null || rank==='') return null;
  const n = Number(rank);
  if(Number.isNaN(n)) return null;
  return p.adp - n;
}

/* ---------------- filtering / sorting ---------------- */

function visiblePlayers(){
  let list = PLAYERS.filter(p => state.showRemoved ? true : !state.removed.has(p.id));
  if(!state.showRemoved) {} // removed already excluded above unless toggle on
  if(state.pos !== 'ALL') list = list.filter(p => p.pos === state.pos);
  if(state.team !== 'ALL') list = list.filter(p => p.team === state.team);
  if(state.search.trim()){
    const q = state.search.trim().toLowerCase();
    list = list.filter(p => p.name.toLowerCase().includes(q));
  }
  const dir = state.sortDir === 'asc' ? 1 : -1;
  list = list.slice().sort((a,b) => {
    let av, bv;
    if(state.sortKey === 'rec'){ av = (a.stats.rec||0); bv = (b.stats.rec||0); }
    else if(state.sortKey === 'projPts'){ av = computeProjPts(a); bv = computeProjPts(b); }
    else if(state.sortKey === 'expertRank'){ av = Number(state.expertRank[a.id]) || 0; bv = Number(state.expertRank[b.id]) || 0; }
    else if(state.sortKey === 'adpDiff'){ av = adpDiff(a) || 0; bv = adpDiff(b) || 0; }
    else if(state.sortKey.startsWith('custom:')){
      const key = state.sortKey.slice(7);
      av = Number((state.customValues[a.id]||{})[key]) || 0;
      bv = Number((state.customValues[b.id]||{})[key]) || 0;
    }
    else { av = a[state.sortKey]; bv = b[state.sortKey]; }
    if(typeof av === 'string') return av.localeCompare(bv) * dir;
    return ((av||0) - (bv||0)) * dir;
  });
  return list;
}

/* ---------------- rendering: players tab ---------------- */

function posBadgeStyle(pos){
  return `background:var(--pos-${pos.toLowerCase()})`;
}

function renderHead(){
  const tr = document.getElementById('theadRow');
  const cols = [
    {key:'stripe', label:''},
    {key:'sel', label:''},
    {key:'rank', label:'#'},
    {key:'tier', label:'Tier'},
    {key:'name', label:'Player'},
    {key:'pos', label:'Pos'},
    {key:'bye', label:'Bye'},
    {key:'projPts', label:'Proj Pts'},
    {key:'rec', label:'Rec'},
    {key:'offense', label:'Off Grade'},
    {key:'fit', label:'Fit'},
    {key:'expertRank', label:'DS Rk'},
    {key:'adpDiff', label:'Diff'},
  ];
  let html = cols.map(c => {
    if(c.key==='stripe') return `<th style="width:4px;padding:0;"></th>`;
    if(c.key==='sel') return `<th style="width:26px;"></th>`;
    const sorted = state.sortKey===c.key || (c.key==='rank' && state.sortKey==='adp');
    const title = c.key==='expertRank' ? ' title="Draft Sharks (or any expert source) rank — edit inline, or use Import Draft Sharks ranks"'
      : c.key==='adpDiff' ? ' title="ADP minus Draft Sharks rank. Positive = value (ADP later than expert rank), negative = reach."' : '';
    return `<th data-sort="${c.key}" class="${sorted?'sorted':''}"${title}>${esc(c.label)}</th>`;
  }).join('');
  state.customStats.forEach(cs => {
    html += `<th data-sort="custom:${esc(cs.key)}" class="${state.sortKey==='custom:'+cs.key?'sorted':''}">${esc(cs.label)}<span class="rm-col" data-remove-stat="${esc(cs.key)}" title="Remove this stat column"> ×</span></th>`;
  });
  html += `<th></th>`;
  tr.innerHTML = html;
}

function renderRow(p, idx){
  const gradeInfo = offenseGrades[p.team];
  const fit = state.strategy!=='bpa' ? strategyFit(p, state.strategy, state.numTeams) : null;
  const tier = tierMap[p.id];
  const isSelected = state.selected.has(p.id);
  const isRemoved = state.removed.has(p.id);
  const tColor = tierColor(tier);
  let row = `<tr data-id="${p.id}" class="${state.expanded===p.id?'expanded':''}">`;
  row += `<td class="tier-stripe" style="background:${tColor};"></td>`;
  row += `<td><input type="checkbox" class="rowcheck" data-id="${p.id}" ${isSelected?'checked':''}></td>`;
  row += `<td class="mono">${idx+1}</td>`;
  row += `<td><span class="tier-badge" style="color:${tColor};border-color:${tColor};" title="Tier ${tier} — grouped by where ${esc(p.pos)} talent drops off">T${tier}</span></td>`;
  row += `<td><div class="player-cell" data-toggle="${p.id}"><span class="pname">${esc(p.name)}${isRemoved?' <span style="color:var(--bad);font-size:11px;">(kept)</span>':''}</span><span class="pmeta">${esc(p.team)} · Bye ${p.bye} · ${esc(p.posRank)} · ADP ${p.adp}</span></div></td>`;
  row += `<td><span class="pos-badge" style="${posBadgeStyle(p.pos)}">${esc(p.pos)}</span></td>`;
  row += `<td class="mono">${p.bye}</td>`;
  row += `<td class="num mono">${fmt(computeProjPts(p))}</td>`;
  row += `<td class="num mono">${p.stats.rec!=null ? fmt(p.stats.rec) : '—'}</td>`;
  if(gradeInfo){
    row += `<td><span class="grade-badge" style="color:${gradeColorVar(gradeInfo.grade)};border:1px solid ${gradeColorVar(gradeInfo.grade)};" title="Rank #${gradeInfo.rank} of 32 projected offenses">${gradeInfo.grade}</span></td>`;
  } else {
    row += `<td>—</td>`;
  }
  if(fit && fit.tag!=='neutral'){
    row += `<td><span class="fit-badge fit-${fit.tag}" title="Round ${fit.round} pick (ADP ${p.adp})">${fit.tag==='priority'?'Priority':'Fade'}</span></td>`;
  } else if(fit){
    row += `<td><span class="fit-badge fit-neutral">—</span></td>`;
  } else {
    row += `<td>—</td>`;
  }
  row += `<td><input type="number" class="mono expert-input" style="width:56px;" data-id="${p.id}" value="${esc(state.expertRank[p.id]==null?'':state.expertRank[p.id])}" placeholder="—"></td>`;
  const diff = adpDiff(p);
  if(diff==null){
    row += `<td>—</td>`;
  } else {
    const tag = diff>3 ? 'priority' : diff<-3 ? 'fade' : 'neutral';
    const sign = diff>0 ? '+' : '';
    row += `<td><span class="fit-badge fit-${tag}" title="ADP ${p.adp} vs Draft Sharks rank ${state.expertRank[p.id]}">${sign}${diff}</span></td>`;
  }
  state.customStats.forEach(cs => {
    const val = (state.customValues[p.id]||{})[cs.key];
    row += `<td><input type="text" class="mono custom-input" style="width:70px;" data-id="${p.id}" data-stat="${esc(cs.key)}" value="${esc(val==null?'':val)}"></td>`;
  });
  row += `<td><button class="kept-btn" data-toggle-kept="${p.id}">${isRemoved?'Restore':'Mark kept'}</button></td>`;
  row += `</tr>`;
  if(state.expanded === p.id){
    row += renderDetailRow(p);
  }
  return row;
}

function renderDetailRow(p){
  const statDefs = POS_STATS[p.pos] || [];
  let stats = statDefs.map(([key,label]) => `
    <div class="detail-stat"><span class="dlabel">${esc(label)}</span><span class="dval">${fmt(p.stats[key])}</span></div>
  `).join('');
  stats += `<div class="detail-stat"><span class="dlabel">Age</span><span class="dval">${p.age||'—'}</span></div>`;
  stats += `<div class="detail-stat"><span class="dlabel">Proj Pts</span><span class="dval">${fmt(computeProjPts(p))}</span></div>`;
  const injuries = (p.injuries && p.injuries.length) ? p.injuries.join('; ') : 'No notable injury history on record.';
  const diff = adpDiff(p);
  const ranking = `<div class="detail-custom"><div class="dlabel" style="margin-bottom:8px;">Draft Sharks (or any expert) rank</div>
    <div class="cfield"><label>ADP</label><span class="mono" style="color:var(--muted);">${p.adp}</span></div>
    <div class="cfield"><label>Expert rank</label><input type="number" class="mono expert-input" data-id="${p.id}" value="${esc(state.expertRank[p.id]==null?'':state.expertRank[p.id])}" placeholder="—"></div>
    <div class="cfield"><label>ADP diff</label><span class="mono" style="color:${diff==null?'var(--muted-2)':diff>3?'var(--good)':diff<-3?'var(--bad)':'var(--muted)'};">${diff==null?'—':(diff>0?'+':'')+diff}</span></div>
  </div>`;
  let custom = '';
  if(state.customStats.length){
    custom = `<div class="detail-custom"><div class="dlabel" style="margin-bottom:8px;">Custom stats</div>` +
      state.customStats.map(cs => {
        const val = (state.customValues[p.id]||{})[cs.key];
        return `<div class="cfield"><label>${esc(cs.label)}</label><input type="text" class="mono custom-input" data-id="${p.id}" data-stat="${esc(cs.key)}" value="${esc(val==null?'':val)}"></div>`;
      }).join('') + `</div>`;
  }
  return `<tr class="detail-row"><td colspan="40">
    <div class="detail-grid">${stats}</div>
    <div class="detail-injuries"><strong style="color:var(--muted-2);">Injury notes:</strong> ${esc(injuries)}</div>
    ${ranking}
    ${custom}
  </td></tr>`;
}

function renderPosChips(){
  const el = document.getElementById('posChips');
  const positions = ['ALL', ...POS_ORDER];
  el.innerHTML = positions.map(p => `<button class="chip ${state.pos===p?'active':''}" data-pos="${p}">${p}</button>`).join('');
}

function renderTeamFilter(){
  const el = document.getElementById('teamFilter');
  const teams = Array.from(new Set(PLAYERS.map(p=>p.team))).sort();
  el.innerHTML = `<option value="ALL">All Teams</option>` + teams.map(t=>`<option value="${t}" ${state.team===t?'selected':''}>${t}</option>`).join('');
}

function renderRemovedSection(){
  const removedPlayers = PLAYERS.filter(p => state.removed.has(p.id)).sort((a,b)=>a.adp-b.adp);
  document.getElementById('removedCount').textContent = removedPlayers.length;
  document.getElementById('removedList').innerHTML = removedPlayers.length ? removedPlayers.map(p => `
    <div class="removed-row">
      <span class="rname">${esc(p.name)} <span class="mono" style="color:var(--muted-2);">${esc(p.pos)} · ${esc(p.team)}</span></span>
      <button class="btn-ghost" data-toggle-kept="${p.id}">Restore</button>
    </div>
  `).join('') : `<div class="empty-state">No players marked kept/unavailable yet.</div>`;
}

function renderBulkBar(){
  const bar = document.getElementById('bulkBar');
  if(state.selected.size === 0){ bar.hidden = true; return; }
  bar.hidden = false;
  document.getElementById('bulkCount').textContent = state.selected.size;
}

function renderTierDivider(tier, list){
  const inTier = list.filter(p => tierMap[p.id] === tier).map(computeProjPts);
  const lo = Math.min(...inTier), hi = Math.max(...inTier);
  return `<tr class="tier-divider"><td colspan="40" style="border-left:4px solid ${tierColor(tier)};background:${tierColorAlpha(tier,0.12)};">Tier ${tier}<span class="trange">${fmt(lo)}–${fmt(hi)} pts</span></td></tr>`;
}

function renderPlayersTab(){
  tierMap = computeTiers(PLAYERS);
  renderPosChips();
  renderTeamFilter();
  renderHead();
  const list = visiblePlayers();
  const tbody = document.getElementById('tbody');
  if(!list.length){
    tbody.innerHTML = `<tr><td colspan="40"><div class="empty-state">No players match these filters.</div></td></tr>`;
  } else {
    const showDividers = state.pos !== 'ALL' && (state.sortKey === 'adp' || state.sortKey === 'projPts');
    let html = '';
    let lastTier = null;
    list.forEach((p,i) => {
      const t = tierMap[p.id];
      if(showDividers && t !== lastTier){
        html += renderTierDivider(t, list);
        lastTier = t;
      }
      html += renderRow(p,i);
    });
    tbody.innerHTML = html;
  }
  renderRemovedSection();
  renderBulkBar();
}

/* ---------------- offense tab ---------------- */

function renderOffenseTab(){
  offenseGrades = computeOffenseGrades(PLAYERS);
  const rows = Object.keys(offenseGrades).map(team => ({team, ...offenseGrades[team]}));
  rows.sort((a,b) => a.rank - b.rank);
  document.getElementById('offenseTbody').innerHTML = rows.map(r => `
    <tr>
      <td class="mono">${r.rank}</td>
      <td><strong>${esc(r.team)}</strong></td>
      <td><span class="grade-badge" style="color:${gradeColorVar(r.grade)};border:1px solid ${gradeColorVar(r.grade)};">${r.grade}</span></td>
      <td class="num mono">${fmt(r.score)}</td>
      <td class="core-list">${r.core.map(p=>esc(p.name)+' ('+p.pos+')').join(', ')}</td>
    </tr>
  `).join('');
}

/* ---------------- strategy tab ---------------- */

function renderStrategyTab(){
  const grid = document.getElementById('strategyGrid');
  grid.innerHTML = Object.keys(STRATEGIES).map(key => {
    const s = STRATEGIES[key];
    const active = state.strategy === key;
    return `<div class="strategy-card ${active?'active':''}" data-strategy="${key}">
      <h4>${esc(s.name)}</h4>
      <p>${esc(s.desc)}</p>
      <button class="btn-secondary apply-btn" data-strategy-apply="${key}">${active?'Active on Players tab':'Apply to Players tab'}</button>
    </div>`;
  }).join('');
}

/* ---------------- render all ---------------- */

function render(){
  if(state.tab==='players') renderPlayersTab();
  else if(state.tab==='offense') renderOffenseTab();
  else if(state.tab==='strategy') renderStrategyTab();
}

/* ---------------- events ---------------- */

function toggleKept(id){
  id = Number(id);
  if(state.removed.has(id)) state.removed.delete(id);
  else state.removed.add(id);
  persistRemoved();
  render();
}

function addCustomStat(){
  const label = prompt('New stat column name (e.g. "Target Share", "Strength of Schedule"):');
  if(!label || !label.trim()) return;
  const key = 'c_' + label.trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'') + '_' + Date.now().toString(36).slice(-4);
  state.customStats.push({key, label: label.trim()});
  persistCustomStats();
  render();
}

function removeCustomStat(key){
  if(!confirm('Remove this custom stat column and all its values?')) return;
  state.customStats = state.customStats.filter(cs => cs.key !== key);
  Object.keys(state.customValues).forEach(pid => { delete state.customValues[pid][key]; });
  persistCustomStats();
  persistCustomValues();
  render();
}

function setCustomValue(id, key, value){
  id = Number(id);
  if(!state.customValues[id]) state.customValues[id] = {};
  state.customValues[id][key] = value;
  persistCustomValues();
}

/* ---------------- Draft Sharks import ---------------- */

function normalizeName(s){
  return String(s||'').toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[.''`]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

let playerIndex = null;
function getPlayerIndex(){
  if(!playerIndex) playerIndex = PLAYERS.map(p => ({p, norm: normalizeName(p.name)}));
  return playerIndex;
}

function matchPlayerByName(namePart){
  const norm = normalizeName(namePart);
  if(!norm) return null;
  const index = getPlayerIndex();
  let hit = index.find(x => x.norm === norm);
  if(hit) return hit.p;
  const prefixMatches = index.filter(x => norm === x.norm || norm.startsWith(x.norm + ' '));
  if(prefixMatches.length){
    prefixMatches.sort((a,b) => b.norm.length - a.norm.length);
    return prefixMatches[0].p;
  }
  const looseMatches = index.filter(x => x.norm.length > 3 && norm.includes(x.norm));
  if(looseMatches.length === 1) return looseMatches[0].p;
  return null;
}

function parseDraftSharksText(text){
  const lines = text.split(/\r?\n/);
  const matched = [];
  const unmatched = [];
  lines.forEach(raw => {
    const line = raw.trim();
    if(!line) return;
    let rank, namePart;
    let m = line.match(/^#?\s*(\d{1,3})[.\)\-:,]?\s+(.+)$/);
    if(m){ rank = parseInt(m[1],10); namePart = m[2]; }
    else {
      m = line.match(/^(.+?)[\s,]+#?(\d{1,3})\s*$/);
      if(m){ namePart = m[1]; rank = parseInt(m[2],10); }
    }
    if(!rank || !namePart){ unmatched.push(raw); return; }
    const player = matchPlayerByName(namePart);
    if(player) matched.push({id: player.id, rank});
    else unmatched.push(raw);
  });
  return {matched, unmatched};
}

function importDraftSharksText(text){
  const {matched, unmatched} = parseDraftSharksText(text);
  matched.forEach(m => { state.expertRank[m.id] = m.rank; });
  persistExpertRank();
  render();
  let msg = `Imported ${matched.length} of ${matched.length + unmatched.length} lines.`;
  if(unmatched.length){
    msg += `\n\nCouldn't match:\n${unmatched.slice(0,15).join('\n')}${unmatched.length>15 ? '\n…' : ''}`;
  }
  alert(msg);
}

/* ---------------- ESPN league import ---------------- */

async function importEspnLeague(){
  const statusEl = document.getElementById('espnStatus2');
  const overlay = document.getElementById('espnModalOverlay');
  const leagueId = document.getElementById('espnLeagueId2').value.trim();
  const season = document.getElementById('espnSeason2').value.trim() || '2026';
  const espnS2 = document.getElementById('espnS2b').value.trim();
  const swid = document.getElementById('espnSwidB').value.trim();
  const setStatus = (msg, color) => { statusEl.textContent = msg; statusEl.style.color = color; };

  if(!leagueId){ setStatus('Enter your ESPN league ID first.', 'var(--bad)'); return; }

  const btn = document.getElementById('espnSubmitBtn2');
  btn.disabled = true; btn.textContent = 'Importing…';
  setStatus('Contacting ESPN…', 'var(--muted)');
  try{
    const res = await fetch(`${API_BASE}/api/espn`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({leagueId, season, espnS2, swid}),
    });
    const data = await res.json().catch(() => ({}));
    if(!res.ok){
      setStatus(data.error || `ESPN import failed (${res.status}).`, 'var(--bad)');
      return;
    }

    if(data.numTeams){
      state.numTeams = Math.min(16, Math.max(8, data.numTeams));
      persistNumTeams();
      document.getElementById('numTeams').value = state.numTeams;
    }
    const sc = data.scoring || {};
    Object.keys(sc).forEach(k => { if(typeof sc[k] === 'number') state.scoring[k] = sc[k]; });
    persistScoring();
    document.getElementById('pprInput').value = state.scoring.reception;
    render();

    const parts = [];
    if(sc.reception != null) parts.push(`${sc.reception} PPR`);
    if(data.roster){
      const r = data.roster;
      const rosterStr = ['QB','RB','WR','TE','FLEX','DST','K','BN'].filter(k => r[k]).map(k => `${r[k]}${k}`).join('/');
      if(rosterStr) parts.push(rosterStr);
    }
    setStatus(`Imported "${data.leagueName}" — ${state.numTeams} teams${parts.length ? ', ' + parts.join(', ') : ''}. Scoring ESPN didn't report keeps this app's current value.`, 'var(--good)');
    setTimeout(() => { overlay.hidden = true; }, 2600);
  }catch(e){
    setStatus('Could not reach the import service. Try again in a moment.', 'var(--bad)');
  }finally{
    btn.disabled = false; btn.textContent = 'Import';
  }
}

function setExpertRank(id, value){
  id = Number(id);
  const v = value.trim();
  if(v === '') delete state.expertRank[id];
  else state.expertRank[id] = Number(v);
  persistExpertRank();
  render();
}

function exportCsv(){
  const list = visiblePlayers();
  const headers = ['Rank','Tier','Name','Pos','Team','Bye','ProjPts','Rec','OffenseGrade','DraftSharksRank','ADPDiff', ...state.customStats.map(cs=>cs.label)];
  const rows = list.map((p,i) => {
    const grade = offenseGrades[p.team] ? offenseGrades[p.team].grade : '';
    const custom = state.customStats.map(cs => (state.customValues[p.id]||{})[cs.key] || '');
    const diff = adpDiff(p);
    return [i+1, tierMap[p.id], p.name, p.pos, p.team, p.bye, computeProjPts(p), p.stats.rec||'', grade, state.expertRank[p.id]||'', diff==null?'':diff, ...custom];
  });
  const csv = [headers, ...rows].map(r => r.map(v => {
    const s = String(v==null?'':v);
    return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s;
  }).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'cheat-sheet.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function attachEvents(){
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      state.tab = btn.dataset.tab;
      document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active', b===btn));
      document.querySelectorAll('.tabpanel').forEach(p=>p.classList.remove('active'));
      document.getElementById('tab'+btn.dataset.tab[0].toUpperCase()+btn.dataset.tab.slice(1)).classList.add('active');
      render();
    });
  });

  document.getElementById('numTeams').addEventListener('change', e => {
    let v = parseInt(e.target.value,10);
    if(Number.isNaN(v)) v = 12;
    v = Math.min(16, Math.max(8, v));
    e.target.value = v;
    state.numTeams = v;
    persistNumTeams();
    render();
  });
  document.getElementById('numTeams').value = state.numTeams;

  document.getElementById('pprInput').addEventListener('change', e => {
    let v = parseFloat(e.target.value);
    if(Number.isNaN(v)) v = 0.5;
    v = Math.min(2, Math.max(0, v));
    e.target.value = v;
    state.scoring.reception = v;
    persistScoring();
    render();
  });
  document.getElementById('pprInput').value = state.scoring.reception;

  document.getElementById('searchInput').addEventListener('input', e => {
    state.search = e.target.value;
    renderPlayersTab();
  });
  document.getElementById('teamFilter').addEventListener('change', e => {
    state.team = e.target.value;
    renderPlayersTab();
  });
  document.getElementById('showRemoved').addEventListener('change', e => {
    state.showRemoved = e.target.checked;
    renderPlayersTab();
  });
  document.getElementById('addStatBtn').addEventListener('click', addCustomStat);
  document.getElementById('exportCsvBtn').addEventListener('click', exportCsv);
  document.getElementById('printBtn').addEventListener('click', () => window.print());
  document.getElementById('resetRemovedBtn').addEventListener('click', () => {
    if(!state.removed.size) return;
    if(!confirm('Restore all kept/unavailable players back to the pool?')) return;
    state.removed.clear();
    persistRemoved();
    render();
  });
  document.getElementById('clearExpertBtn').addEventListener('click', () => {
    if(!Object.keys(state.expertRank).length) return;
    if(!confirm('Clear all Draft Sharks ranks?')) return;
    state.expertRank = {};
    persistExpertRank();
    render();
  });

  const importOverlay = document.getElementById('importModalOverlay');
  const importTextarea = document.getElementById('importTextarea');
  document.getElementById('importDsBtn').addEventListener('click', () => {
    importTextarea.value = '';
    importOverlay.hidden = false;
    importTextarea.focus();
  });
  document.getElementById('importCancelBtn').addEventListener('click', () => { importOverlay.hidden = true; });
  importOverlay.addEventListener('click', e => { if(e.target === importOverlay) importOverlay.hidden = true; });
  document.getElementById('importSubmitBtn').addEventListener('click', () => {
    const text = importTextarea.value;
    if(!text.trim()){ importOverlay.hidden = true; return; }
    importOverlay.hidden = true;
    importDraftSharksText(text);
  });

  const espnOverlay = document.getElementById('espnModalOverlay');
  document.getElementById('importEspnBtn').addEventListener('click', () => {
    document.getElementById('espnStatus2').textContent = '';
    espnOverlay.hidden = false;
  });
  document.getElementById('espnCancelBtn2').addEventListener('click', () => { espnOverlay.hidden = true; });
  espnOverlay.addEventListener('click', e => { if(e.target === espnOverlay) espnOverlay.hidden = true; });
  document.getElementById('espnPrivate2').addEventListener('change', e => {
    document.getElementById('espnPrivateFields2').hidden = !e.target.checked;
  });
  document.getElementById('espnSubmitBtn2').addEventListener('click', importEspnLeague);

  document.getElementById('posChips').addEventListener('click', e => {
    const btn = e.target.closest('[data-pos]');
    if(!btn) return;
    state.pos = btn.dataset.pos;
    renderPlayersTab();
  });

  document.getElementById('bulkKeepBtn').addEventListener('click', () => {
    state.selected.forEach(id => state.removed.add(id));
    state.selected.clear();
    persistRemoved();
    render();
  });
  document.getElementById('bulkClearBtn').addEventListener('click', () => {
    state.selected.clear();
    render();
  });

  document.getElementById('strategyGrid').addEventListener('click', e => {
    const applyBtn = e.target.closest('[data-strategy-apply]');
    const card = e.target.closest('[data-strategy]');
    const key = applyBtn ? applyBtn.dataset.strategyApply : (card ? card.dataset.strategy : null);
    if(!key) return;
    state.strategy = key;
    persistStrategy();
    renderStrategyTab();
  });

  // delegated events inside the players table (rebuilt on every render)
  document.getElementById('app').addEventListener('click', e => {
    const theadSort = e.target.closest('th[data-sort]');
    if(theadSort && theadSort.closest('#playersTable')){
      const key = theadSort.dataset.sort;
      if(e.target.closest('[data-remove-stat]')) return;
      const actualKey = key === 'rank' ? 'adp' : key;
      if(!['adp','name','pos','bye','projPts','rec','expertRank','adpDiff'].includes(actualKey) && !actualKey.startsWith('custom:')) return;
      if(state.sortKey === actualKey) state.sortDir = state.sortDir==='asc' ? 'desc' : 'asc';
      else { state.sortKey = actualKey; state.sortDir = actualKey==='name'||actualKey==='pos' ? 'asc' : 'desc'; if(actualKey==='adp'||actualKey==='expertRank') state.sortDir='asc'; }
      renderPlayersTab();
      return;
    }
    const theadSortOffense = e.target.closest('th[data-sort]');
    if(theadSortOffense && theadSortOffense.closest('#offenseTable')){
      const key = theadSortOffense.dataset.sort;
      const rows = Array.from(document.querySelectorAll('#offenseTbody tr'));
      // simple client resort via re-render with a temp comparator
      const teams = Object.keys(offenseGrades);
      teams.sort((a,b) => {
        if(key==='team') return a.localeCompare(b);
        if(key==='grade') return offenseGrades[a].grade.localeCompare(offenseGrades[b].grade);
        if(key==='score') return offenseGrades[b].score - offenseGrades[a].score;
        return offenseGrades[a].rank - offenseGrades[b].rank;
      });
      document.getElementById('offenseTbody').innerHTML = teams.map(team => {
        const r = offenseGrades[team];
        return `<tr>
          <td class="mono">${r.rank}</td>
          <td><strong>${esc(team)}</strong></td>
          <td><span class="grade-badge" style="color:${gradeColorVar(r.grade)};border:1px solid ${gradeColorVar(r.grade)};">${r.grade}</span></td>
          <td class="num mono">${fmt(r.score)}</td>
          <td class="core-list">${r.core.map(p=>esc(p.name)+' ('+p.pos+')').join(', ')}</td>
        </tr>`;
      }).join('');
      return;
    }

    const removeStat = e.target.closest('[data-remove-stat]');
    if(removeStat){ removeCustomStat(removeStat.dataset.removeStat); return; }

    const toggleKeptBtn = e.target.closest('[data-toggle-kept]');
    if(toggleKeptBtn){ toggleKept(toggleKeptBtn.dataset.toggleKept); return; }

    const playerCell = e.target.closest('[data-toggle]');
    if(playerCell){
      const id = Number(playerCell.dataset.toggle);
      state.expanded = state.expanded === id ? null : id;
      renderPlayersTab();
      return;
    }
  });

  document.getElementById('app').addEventListener('change', e => {
    if(e.target.classList.contains('rowcheck')){
      const id = Number(e.target.dataset.id);
      if(e.target.checked) state.selected.add(id); else state.selected.delete(id);
      renderBulkBar();
      return;
    }
    if(e.target.classList.contains('custom-input')){
      setCustomValue(e.target.dataset.id, e.target.dataset.stat, e.target.value);
      return;
    }
    if(e.target.classList.contains('expert-input')){
      setExpertRank(e.target.dataset.id, e.target.value);
      return;
    }
  });
}

attachEvents();
render();

})();
