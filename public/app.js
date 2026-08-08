/* ============================================================
   LEAGUE OF PRETTY ORDINARY GENTLEMEN — Live League Draft (multiplayer via window.storage)
   ============================================================ */

const POS_COLOR = {QB:'var(--pos-qb)',RB:'var(--pos-rb)',WR:'var(--pos-wr)',TE:'var(--pos-te)',DST:'var(--pos-dst)',K:'var(--pos-k)'};
const STAT_LABELS = {
  passYds:'Pass Yds', passTD:'Pass TD', rushYds:'Rush Yds', rushTD:'Rush TD',
  rec:'Receptions', recYds:'Rec Yds', recTD:'Rec TD',
  fgMade:'FG Made', fgAtt:'FG Att', sacks:'Sacks', int:'INT', defTD:'Def TD',
};
const PRIMARY_REC_POS = new Set(['RB','WR','TE']);
const CFG_KEY = 'league_config';
const DRAFT_KEY = 'league_draft';
const ID_KEY = 'my_identity';
const POLL_MS = 3000;

let CONFIG = null;   // {numTeams, teamNames[], roster:{QB,RB,WR,TE,FLEX,DST,K,BN}, order:[teamIdx,...], createdAt}
let DRAFT = null;    // {status, overall, picks:[{overall,round,teamIdx,playerId}], claims:{teamIdx:name}, version}
let IDENTITY = {name:null, teamIdx:null};
let COMMISH_TOKEN = null; // this browser's commissioner secret, if it holds one
let posFilter = 'ALL';
let searchTerm = '';
let rosterViewIdx = null;
let pollTimer = null;
let currentScreen = 'loading';
let MOCK = false;          // true while running a local, solo mock draft
let botLoopRunning = false;

function genToken(){
  return 'c_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function isCommissioner(){
  return !!COMMISH_TOKEN && !!CONFIG && CONFIG.commissionerToken === COMMISH_TOKEN;
}

function showScreen(id){
  currentScreen = id;
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById('screen'+id.charAt(0).toUpperCase()+id.slice(1)).classList.add('active');
}

function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>t.classList.remove('show'), 2600);
}

/* ---------------- room code ---------------- */

function genRoomCode(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 ambiguity
  let s = '';
  for(let i=0;i<6;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}

function getRoomCode(){
  const params = new URLSearchParams(location.search);
  let room = params.get('room');
  if(!room){
    room = genRoomCode();
    params.set('room', room);
    history.replaceState(null, '', location.pathname + '?' + params.toString());
  }
  return room;
}

const ROOM_CODE = getRoomCode();

// Absolute so this same app.js works whether it's served from the Vercel
// backend itself or from a separate static host (e.g. GitHub Pages) — either
// way it talks to the one live api/storage.js + Redis instance.
const API_BASE = 'https://league-draft-app.vercel.app';

/* ---------------- storage helpers ----------------
   Shared keys (league_config/league_draft) sync everyone in the room via the
   /api/storage backend. Private keys (identity, commissioner token) never
   leave this browser, so they live in localStorage instead. */

// Mock drafts never touch the network — shared reads/writes are redirected to
// a locally-namespaced key instead, so the exact same render/pick code that
// drives a real room can drive a solo practice draft too.
function mockKey(key){ return 'mock_' + key; }

async function storageGet(key, shared){
  try{
    if(!shared || MOCK){
      const raw = localStorage.getItem(MOCK && shared ? mockKey(key) : key);
      return raw ? JSON.parse(raw) : null;
    }
    const res = await fetch(`${API_BASE}/api/storage?room=${ROOM_CODE}&key=${key}`);
    if(!res.ok) return null;
    const data = await res.json();
    return data.value ? JSON.parse(data.value) : null;
  }catch(e){ return null; }
}
async function storageSet(key, value, shared){
  try{
    if(!shared || MOCK){
      localStorage.setItem(MOCK && shared ? mockKey(key) : key, JSON.stringify(value));
      return {ok:true};
    }
    const res = await fetch(`${API_BASE}/api/storage?room=${ROOM_CODE}&key=${key}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({value: JSON.stringify(value)}),
    });
    if(!res.ok){
      const data = await res.json().catch(()=>({}));
      return {ok:false, error: data.error || `Server returned ${res.status}`};
    }
    return {ok:true};
  }catch(e){
    console.error('storage set failed', e);
    return {ok:false, error: (e && e.message) ? e.message : String(e)};
  }
}
async function storageDelete(key, shared){
  try{
    if(!shared || MOCK){ localStorage.removeItem(MOCK && shared ? mockKey(key) : key); return; }
    await fetch(`${API_BASE}/api/storage?room=${ROOM_CODE}&key=${key}`, {method:'DELETE'});
  }catch(e){ /* ignore missing key */ }
}

async function backendReachable(){
  try{
    const res = await fetch(`${API_BASE}/api/storage?room=${ROOM_CODE}&key=${CFG_KEY}`);
    return res.status < 500;
  }catch(e){ return false; }
}

/* ---------------- roster template / derived state ---------------- */

function buildSlotTemplate(rosterCfg){
  const t = [];
  for(let i=0;i<rosterCfg.QB;i++) t.push('QB');
  for(let i=0;i<rosterCfg.RB;i++) t.push('RB');
  for(let i=0;i<rosterCfg.WR;i++) t.push('WR');
  for(let i=0;i<rosterCfg.TE;i++) t.push('TE');
  for(let i=0;i<rosterCfg.FLEX;i++) t.push('FLEX');
  if(rosterCfg.DST) t.push('DST');
  if(rosterCfg.K) t.push('K');
  for(let i=0;i<rosterCfg.BN;i++) t.push('BN');
  return t;
}

function slotEligible(slotType, pos){
  if(slotType === 'BN') return true;
  if(slotType === 'FLEX') return pos==='RB'||pos==='WR'||pos==='TE';
  return slotType === pos;
}

function computeTeamRoster(teamIdx){
  const template = buildSlotTemplate(CONFIG.roster);
  const roster = template.map(slotType => ({slotType, player:null}));
  const keeperPicks = (DRAFT.keepers||[]).filter(k=>k.teamIdx===teamIdx).sort((a,b)=>a.round-b.round);
  const livePicks = DRAFT.picks.filter(p=>p.teamIdx===teamIdx).sort((a,b)=>a.overall-b.overall);
  const allPlayerIds = [...keeperPicks.map(k=>k.playerId), ...livePicks.map(p=>p.playerId)];
  allPlayerIds.forEach(playerId=>{
    const player = PLAYERS_RAW.find(p=>p.id===playerId);
    if(!player) return;
    let idx = roster.findIndex(s=>!s.player && s.slotType===player.pos);
    if(idx===-1 && (player.pos==='RB'||player.pos==='WR'||player.pos==='TE')){
      idx = roster.findIndex(s=>!s.player && s.slotType==='FLEX');
    }
    if(idx===-1) idx = roster.findIndex(s=>!s.player && s.slotType==='BN');
    if(idx!==-1) roster[idx].player = player;
  });
  return roster;
}

function findOpenSlotIndexForPick(teamIdx, pos){
  const roster = computeTeamRoster(teamIdx);
  let idx = roster.findIndex(s=>!s.player && s.slotType===pos);
  if(idx!==-1) return idx;
  if(pos==='RB'||pos==='WR'||pos==='TE'){
    idx = roster.findIndex(s=>!s.player && s.slotType==='FLEX');
    if(idx!==-1) return idx;
  }
  idx = roster.findIndex(s=>!s.player && s.slotType==='BN');
  return idx;
}

function buildSnakeOrder(baseOrder, rounds){
  const order = [];
  for(let r=0;r<rounds;r++){
    const seq = [...baseOrder];
    if(r % 2 === 1) seq.reverse();
    order.push(...seq);
  }
  return order;
}

function getSkipSet(){
  const s = new Set();
  (DRAFT.keepers||[]).forEach(k=> s.add(k.teamIdx+'-'+k.round));
  (DRAFT.skips||[]).forEach(k=> s.add(k.teamIdx+'-'+k.round));
  return s;
}

// Live pick schedule: one entry per pick that will actually happen in the live draft,
// skipping any (team, round) claimed by a keeper or blocked by a pick restriction.
function buildLiveSchedule(){
  const rounds = totalRounds();
  const skipSet = getSkipSet();
  const base = CONFIG.baseOrder || [...Array(CONFIG.numTeams).keys()];
  const sched = [];
  for(let r=0;r<rounds;r++){
    const seq = [...base];
    if(r % 2 === 1) seq.reverse();
    let pir = 0;
    for(const teamIdx of seq){
      if(!skipSet.has(teamIdx+'-'+(r+1))){
        pir++;
        sched.push({teamIdx, round:r+1, pickInRound:pir});
      }
    }
  }
  return sched;
}

function totalRounds(){ return buildSlotTemplate(CONFIG.roster).length; }
function totalPicks(){ return buildLiveSchedule().length; }

/* ---------------- boot ---------------- */

async function boot(){
  showScreen('loading');

  if(!(await backendReachable())){
    document.getElementById('storageWarning').style.display = 'block';
    document.getElementById('createRoomBtn').disabled = true;
    buildSetupForm();
    showScreen('setup');
    return;
  }

  CONFIG = await storageGet(CFG_KEY, true);
  if(!CONFIG){
    buildSetupForm();
    showScreen('setup');
    return;
  }
  DRAFT = await storageGet(DRAFT_KEY, true);
  if(!DRAFT){
    DRAFT = {status:'lobby', overall:0, picks:[], claims:{}, keepers:[], skips:[], version:1};
    await storageSet(DRAFT_KEY, DRAFT, true);
  }
  if(!DRAFT.keepers) DRAFT.keepers = [];
  if(!DRAFT.skips) DRAFT.skips = [];
  if(!CONFIG.customStats) CONFIG.customStats = {defs:[], values:{}};
  const savedId = await storageGet(ID_KEY, false);
  if(savedId) IDENTITY = savedId;
  const savedCommish = await storageGet('commissioner_token', false);
  if(savedCommish) COMMISH_TOKEN = savedCommish.token;

  if(DRAFT.status==='complete'){
    renderResults();
    showScreen('results');
  } else {
    renderLobby();
    showScreen('lobby');
  }
  startPolling();
}

/* ---------------- SETUP screen ---------------- */

function buildSetupForm(){
  renderTeamNameInputs(10);
  renderMockSlotOptions(10);
  document.getElementById('setupNumTeams').value = '10';
  buildRosterConfigInputs();
  setupKeepers = [];
  setupSkips = [];
  setupCustomStatDefs = [];
  renderSetupKeepers();
  renderSetupSkips();
  renderSetupCustomStats();
}

// Attached once (not inside buildSetupForm, which reruns every time the
// setup screen is (re)entered) so teams/slot options never fall out of sync
// with the selected count, and so listeners don't pile up across visits.
document.getElementById('setupNumTeams').addEventListener('change', (e)=>{
  const n = parseInt(e.target.value,10);
  renderTeamNameInputs(n);
  renderMockSlotOptions(n);
  setupKeepers = setupKeepers.filter(k=>k.teamIdx < n);
  setupSkips = setupSkips.filter(k=>k.teamIdx < n);
  renderSetupKeepers();
  renderSetupSkips();
});

function setupOccupiedSet(){
  const s = new Set();
  setupKeepers.forEach(k=>s.add(k.teamIdx+'-'+k.round));
  setupSkips.forEach(k=>s.add(k.teamIdx+'-'+k.round));
  return s;
}

/* ---------------- setup-screen keepers (staged pre-creation) ---------------- */

let setupKeepers = [];
let setupKeeperSearch = '';

function setupRosterConfig(){
  const roster = {};
  document.querySelectorAll('#rosterConfig select').forEach(sel=>{
    roster[sel.dataset.key] = parseInt(sel.value,10);
  });
  roster.DST = document.getElementById('cfgDST').checked ? 1 : 0;
  roster.K = document.getElementById('cfgK').checked ? 1 : 0;
  return roster;
}

function setupTeamName(i){
  const inputs = [...document.querySelectorAll('#teamNameList input')];
  return (inputs[i] && inputs[i].value.trim()) || `Team ${i+1}`;
}

function renderSetupKeeperTeamOptions(){
  const numTeams = parseInt(document.getElementById('setupNumTeams').value,10);
  const opts = [];
  for(let i=0;i<numTeams;i++) opts.push(`<option value="${i}">${escapeHtml(setupTeamName(i))}</option>`);
  const sel = document.getElementById('setupKeeperTeam');
  const prev = sel.value;
  sel.innerHTML = opts.join('');
  if([...sel.options].some(o=>o.value===prev)) sel.value = prev;
}

function renderSetupKeeperRoundOptions(){
  const rounds = buildSlotTemplate(setupRosterConfig()).length;
  const sel = document.getElementById('setupKeeperRound');
  const prev = sel.value;
  const opts = [];
  for(let r=1;r<=rounds;r++) opts.push(`<option value="${r}">Round ${r}</option>`);
  sel.innerHTML = opts.join('');
  if([...sel.options].some(o=>o.value===prev)) sel.value = prev;
  setupKeepers = setupKeepers.filter(k=>k.round <= rounds);
  setupSkips = setupSkips.filter(k=>k.round <= rounds);
}

function renderSetupKeeperPlayerOptions(){
  const sel = document.getElementById('setupKeeperPlayer');
  const takenIds = new Set(setupKeepers.map(k=>k.playerId));
  let avail = PLAYERS_RAW.filter(p=>!takenIds.has(p.id));
  if(setupKeeperSearch){
    const q = setupKeeperSearch.toLowerCase();
    avail = avail.filter(p=>p.name.toLowerCase().includes(q) || p.team.toLowerCase().includes(q) || p.pos.toLowerCase()===q);
  }
  avail.sort((a,b)=>a.adp-b.adp);
  const prevVal = sel.value;
  avail = avail.slice(0,200);
  sel.innerHTML = avail.length
    ? avail.map(p=>`<option value="${p.id}">${p.adp} · ${p.pos} · ${escapeHtml(p.name)} (${p.team})</option>`).join('')
    : `<option value="" disabled>No players match "${escapeHtml(setupKeeperSearch)}"</option>`;
  if(avail.some(p=>String(p.id)===prevVal)) sel.value = prevVal;
}

function renderSetupKeeperList(){
  const wrap = document.getElementById('setupKeeperList');
  wrap.innerHTML = setupKeepers.length ? setupKeepers.map((k,i)=>{
    const p = PLAYERS_RAW.find(pl=>pl.id===k.playerId);
    return `<div class="kx-row">
      <span class="kx-tag">RD ${k.round}</span>
      <span class="kx-main">${escapeHtml(setupTeamName(k.teamIdx))} — ${p?escapeHtml(p.name):'?'} <span style="color:var(--muted)">${p?p.pos+' · '+p.team:''}</span></span>
      <button class="kx-remove" onclick="removeSetupKeeper(${i})">Remove</button>
    </div>`;
  }).join('') : `<div class="kx-empty">No keepers set yet.</div>`;
}

function renderSetupKeepers(){
  renderSetupKeeperTeamOptions();
  renderSetupKeeperRoundOptions();
  renderSetupKeeperPlayerOptions();
  renderSetupKeeperList();
}

document.getElementById('setupKeeperPlayerSearch').addEventListener('input', (e)=>{
  setupKeeperSearch = e.target.value;
  renderSetupKeeperPlayerOptions();
});

document.getElementById('rosterConfig').addEventListener('change', ()=>{ renderSetupKeepers(); renderSetupSkips(); });
document.getElementById('cfgDST').addEventListener('change', ()=>{ renderSetupKeepers(); renderSetupSkips(); });
document.getElementById('cfgK').addEventListener('change', ()=>{ renderSetupKeepers(); renderSetupSkips(); });

document.getElementById('setupAddKeeperBtn').addEventListener('click', ()=>{
  const teamIdx = parseInt(document.getElementById('setupKeeperTeam').value,10);
  const playerId = parseInt(document.getElementById('setupKeeperPlayer').value,10);
  const round = parseInt(document.getElementById('setupKeeperRound').value,10);
  if(Number.isNaN(teamIdx) || Number.isNaN(playerId) || Number.isNaN(round)){ toast('Fill out all fields.'); return; }
  if(setupOccupiedSet().has(teamIdx+'-'+round)){ toast(`${setupTeamName(teamIdx)} already has round ${round} spoken for.`); return; }
  if(setupKeepers.some(k=>k.playerId===playerId)){ toast('That player is already a keeper.'); return; }
  setupKeepers.push({teamIdx, playerId, round});
  renderSetupKeepers();
  toast('Keeper added.');
});

window.removeSetupKeeper = function(idx){
  setupKeepers.splice(idx,1);
  renderSetupKeepers();
};

/* ---------------- setup-screen pick restrictions (staged pre-creation) ---------------- */

let setupSkips = [];

function renderSetupSkipTeamOptions(){
  const numTeams = parseInt(document.getElementById('setupNumTeams').value,10);
  const opts = [];
  for(let i=0;i<numTeams;i++) opts.push(`<option value="${i}">${escapeHtml(setupTeamName(i))}</option>`);
  const sel = document.getElementById('setupSkipTeam');
  const prev = sel.value;
  sel.innerHTML = opts.join('');
  if([...sel.options].some(o=>o.value===prev)) sel.value = prev;
}

function renderSetupSkipRoundOptions(){
  const rounds = buildSlotTemplate(setupRosterConfig()).length;
  const sel = document.getElementById('setupSkipRound');
  const prev = sel.value;
  const opts = [];
  for(let r=1;r<=rounds;r++) opts.push(`<option value="${r}">Round ${r}</option>`);
  sel.innerHTML = opts.join('');
  if([...sel.options].some(o=>o.value===prev)) sel.value = prev;
  setupSkips = setupSkips.filter(k=>k.round <= rounds);
}

function renderSetupSkipList(){
  const wrap = document.getElementById('setupSkipList');
  wrap.innerHTML = setupSkips.length ? setupSkips.map((k,i)=>`
    <div class="kx-row">
      <span class="kx-tag">RD ${k.round}</span>
      <span class="kx-main">${escapeHtml(setupTeamName(k.teamIdx))} — pick blocked</span>
      <button class="kx-remove" onclick="removeSetupSkip(${i})">Remove</button>
    </div>
  `).join('') : `<div class="kx-empty">No pick restrictions set.</div>`;
}

function renderSetupSkips(){
  renderSetupSkipTeamOptions();
  renderSetupSkipRoundOptions();
  renderSetupSkipList();
}

document.getElementById('setupAddSkipBtn').addEventListener('click', ()=>{
  const teamIdx = parseInt(document.getElementById('setupSkipTeam').value,10);
  const round = parseInt(document.getElementById('setupSkipRound').value,10);
  if(Number.isNaN(teamIdx) || Number.isNaN(round)){ toast('Fill out all fields.'); return; }
  if(setupOccupiedSet().has(teamIdx+'-'+round)){ toast(`${setupTeamName(teamIdx)} already has round ${round} spoken for.`); return; }
  setupSkips.push({teamIdx, round});
  renderSetupSkips();
  toast('Pick blocked.');
});

window.removeSetupSkip = function(idx){
  setupSkips.splice(idx,1);
  renderSetupSkips();
};

/* ---------------- setup-screen custom stats (staged pre-creation) ---------------- */

let setupCustomStatDefs = [];

function slugifyStatKeyAgainst(label, existingDefs){
  const base = label.trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'') || 'stat';
  let key = base, n = 1;
  const existing = new Set(existingDefs.map(d=>d.key));
  while(existing.has(key)) key = `${base}_${++n}`;
  return key;
}

function renderSetupCustomStats(){
  const wrap = document.getElementById('setupCustomStatsList');
  wrap.innerHTML = setupCustomStatDefs.length ? setupCustomStatDefs.map((d,i)=>`
    <div class="cs-def-row">
      <span class="csk">${escapeHtml(d.label)}</span>
      <button class="kx-remove" onclick="removeSetupCustomStat(${i})">Remove</button>
    </div>
  `).join('') : `<div class="kx-empty">No custom stats yet — add one above.</div>`;
}

document.getElementById('setupAddCustomStatBtn').addEventListener('click', ()=>{
  const input = document.getElementById('setupCustomStatName');
  const label = input.value.trim();
  if(!label){ toast('Enter a name for the stat.'); return; }
  if(setupCustomStatDefs.some(d=>d.label.toLowerCase()===label.toLowerCase())){
    toast('That stat already exists.'); return;
  }
  const key = slugifyStatKeyAgainst(label, setupCustomStatDefs);
  setupCustomStatDefs.push({key, label});
  input.value = '';
  renderSetupCustomStats();
  toast('Custom stat added.');
});

window.removeSetupCustomStat = function(idx){
  setupCustomStatDefs.splice(idx,1);
  renderSetupCustomStats();
};

function ordinalSuffix(n){
  const s = ['th','st','nd','rd'], v = n % 100;
  return s[(v-20)%10] || s[v] || s[0];
}

function renderMockSlotOptions(n){
  const sel = document.getElementById('mockSlot');
  const prev = sel.value;
  const opts = ['<option value="random">Random</option>'];
  for(let i=1;i<=n;i++) opts.push(`<option value="${i}">${i}${ordinalSuffix(i)} overall</option>`);
  sel.innerHTML = opts.join('');
  if([...sel.options].some(o=>o.value===prev)) sel.value = prev;
}

function renderTeamNameInputs(n){
  const wrap = document.getElementById('teamNameList');
  const existingRows = [...wrap.querySelectorAll('.team-name-row')];
  const existingValues = existingRows.map(r=>r.querySelector('input').value);
  const existingOwners = existingRows.map(r=>r.dataset.owner||'');
  wrap.innerHTML = '';
  for(let i=0;i<n;i++){
    const row = document.createElement('div');
    row.className = 'team-name-row';
    row.draggable = true;
    const owner = existingOwners[i] || '';
    row.dataset.owner = owner;
    row.innerHTML = `<span class="odrag" title="Drag to set draft order">⠿</span><span class="idx">${i+1}</span><input type="text" placeholder="Team ${i+1}" value="${existingValues[i]||''}">${owner ? `<span class="oowner">${escapeHtml(owner)}</span>` : ''}`;
    wrap.appendChild(row);
  }
  wireTeamNameDragAndDrop();
}

function renumberTeamNameRows(){
  document.querySelectorAll('#teamNameList .team-name-row').forEach((row,i)=>{
    row.querySelector('.idx').textContent = i+1;
    row.querySelector('input').placeholder = `Team ${i+1}`;
  });
}

document.getElementById('applyReorderBtn').addEventListener('click', ()=>{
  const raw = document.getElementById('reorderNamesInput').value;
  const names = raw.split(/[\n,]/).map(s=>s.trim()).filter(Boolean);
  if(!names.length){ toast('Paste at least one name first.'); return; }

  const wrap = document.getElementById('teamNameList');
  const rows = [...wrap.querySelectorAll('.team-name-row')];
  const used = new Set();
  const ordered = [];
  let matched = 0;

  names.forEach(name=>{
    const q = name.toLowerCase();
    let idx = rows.findIndex((r,i)=> !used.has(i) && (r.dataset.owner||'').toLowerCase() === q);
    if(idx===-1) idx = rows.findIndex((r,i)=> !used.has(i) && r.querySelector('input').value.toLowerCase() === q);
    if(idx===-1) idx = rows.findIndex((r,i)=> !used.has(i) && ((r.dataset.owner||'').toLowerCase().includes(q) || r.querySelector('input').value.toLowerCase().includes(q)));
    if(idx!==-1){ used.add(idx); ordered.push(rows[idx]); matched++; }
  });
  rows.forEach((r,i)=>{ if(!used.has(i)) ordered.push(r); });
  ordered.forEach(r=> wrap.appendChild(r));
  renumberTeamNameRows();
  document.getElementById('setupRandomize').checked = false;

  toast(matched===names.length
    ? `Reordered — all ${matched} name(s) matched.`
    : `Reordered — matched ${matched} of ${names.length} name(s). Unmatched rows kept their relative order at the end.`);
});

let dragSrcNameRow = null;

function wireTeamNameDragAndDrop(){
  const wrap = document.getElementById('teamNameList');
  [...wrap.querySelectorAll('.team-name-row')].forEach(row=>{
    row.addEventListener('dragstart', ()=>{
      dragSrcNameRow = row;
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', ()=>{
      row.classList.remove('dragging');
      wrap.querySelectorAll('.team-name-row').forEach(r=>r.classList.remove('drag-over'));
      dragSrcNameRow = null;
    });
    row.addEventListener('dragover', (e)=>{
      if(!dragSrcNameRow || dragSrcNameRow===row) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      wrap.querySelectorAll('.team-name-row').forEach(r=>r.classList.remove('drag-over'));
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', ()=>{
      row.classList.remove('drag-over');
    });
    row.addEventListener('drop', (e)=>{
      e.preventDefault();
      row.classList.remove('drag-over');
      if(!dragSrcNameRow || dragSrcNameRow===row) return;
      const rows = [...wrap.children];
      const srcIdx = rows.indexOf(dragSrcNameRow);
      const targetIdx = rows.indexOf(row);
      if(srcIdx < targetIdx) row.after(dragSrcNameRow);
      else row.before(dragSrcNameRow);
      dragSrcNameRow = null;
      renumberTeamNameRows();
      // Dragging is a deliberate manual order — don't let the (default-on)
      // randomize checkbox silently discard it.
      document.getElementById('setupRandomize').checked = false;
    });
  });
}

function buildRosterConfigInputs(){
  const defs = [
    {key:'QB', label:'QB', opts:[1,2], def:1},
    {key:'RB', label:'RB', opts:[2,3], def:2},
    {key:'WR', label:'WR', opts:[2,3], def:2},
    {key:'TE', label:'TE', opts:[1,2], def:1},
    {key:'FLEX', label:'FLEX', opts:[0,1,2], def:1},
    {key:'BN', label:'Bench', opts:[4,5,6,7,8], def:6},
  ];
  const wrap = document.getElementById('rosterConfig');
  wrap.innerHTML = defs.map(d=>`
    <div class="field roster-mini" style="margin-bottom:0;">
      <label>${d.label}</label>
      <select data-key="${d.key}">
        ${d.opts.map(o=>`<option value="${o}" ${o===d.def?'selected':''}>${o}</option>`).join('')}
      </select>
    </div>
  `).join('');
}

function readSetupForm(){
  const numTeams = parseInt(document.getElementById('setupNumTeams').value,10);
  const nameInputs = [...document.querySelectorAll('#teamNameList input')];
  const teamNames = nameInputs.map((inp,i)=> inp.value.trim() || `Team ${i+1}`);
  const roster = {};
  document.querySelectorAll('#rosterConfig select').forEach(sel=>{
    roster[sel.dataset.key] = parseInt(sel.value,10);
  });
  roster.DST = document.getElementById('cfgDST').checked ? 1 : 0;
  roster.K = document.getElementById('cfgK').checked ? 1 : 0;

  let base = [...Array(numTeams).keys()];
  if(document.getElementById('setupRandomize').checked){
    for(let i=base.length-1;i>0;i--){
      const j = Math.floor(Math.random()*(i+1));
      [base[i],base[j]] = [base[j],base[i]];
    }
  }
  return {numTeams, teamNames, nameInputs, roster, base};
}

document.getElementById('createRoomBtn').addEventListener('click', async ()=>{
  try{
    const {numTeams, teamNames, roster, base} = readSetupForm();

    CONFIG = {numTeams, teamNames, roster, baseOrder: base, createdAt: Date.now(), version: 1, commissionerToken: genToken(), customStats: {defs: setupCustomStatDefs.map(d=>({...d})), values:{}}};
    const res = await storageSet(CFG_KEY, CONFIG, true);
    if(!res.ok){ toast('Could not create room: ' + res.error); return; }
    COMMISH_TOKEN = CONFIG.commissionerToken;
    await storageSet('commissioner_token', {token: COMMISH_TOKEN}, false);
    DRAFT = {status:'lobby', overall:0, picks:[], claims:{}, keepers: setupKeepers.map(k=>({...k})), skips: setupSkips.map(k=>({...k})), version:1};
    await storageSet(DRAFT_KEY, DRAFT, true);

    renderLobby();
    showScreen('lobby');
    startPolling();
  }catch(e){
    console.error('Create room failed', e);
    toast('Something went wrong creating the room: ' + (e && e.message ? e.message : String(e)));
  }
});

/* ---------------- mock draft (solo, local-only) ---------------- */

document.getElementById('mockDraftBtn').addEventListener('click', async ()=>{
  try{
    const {numTeams, teamNames, nameInputs, roster, base} = readSetupForm();
    if(!nameInputs[0] || !nameInputs[0].value.trim()) teamNames[0] = 'You';

    const slotVal = document.getElementById('mockSlot').value;
    const slotPos = slotVal === 'random' ? Math.floor(Math.random()*numTeams) : (parseInt(slotVal,10)-1);
    const curPos = base.indexOf(0);
    [base[curPos], base[slotPos]] = [base[slotPos], base[curPos]];

    MOCK = true;
    CONFIG = {numTeams, teamNames, roster, baseOrder: base, createdAt: Date.now(), version: 1, customStats: {defs: setupCustomStatDefs.map(d=>({...d})), values:{}}};
    await storageSet(CFG_KEY, CONFIG, true);
    DRAFT = {status:'lobby', overall:0, picks:[], claims:{}, keepers: setupKeepers.map(k=>({...k})), skips: setupSkips.map(k=>({...k})), version:1};
    for(let i=0;i<numTeams;i++) DRAFT.claims[i] = i===0 ? teamNames[0] : 'CPU';
    await storageSet(DRAFT_KEY, DRAFT, true);
    IDENTITY = {name: teamNames[0], teamIdx: 0};
    rosterViewIdx = 0;

    enterDraftScreen();
    runBotsUntilUserTurn();
  }catch(e){
    console.error('Mock draft start failed', e);
    toast('Something went wrong starting the mock draft: ' + (e && e.message ? e.message : String(e)));
  }
});

function pickBotPlayer(teamIdx){
  const draftedIds = new Set([...DRAFT.picks.map(p=>p.playerId), ...(DRAFT.keepers||[]).map(k=>k.playerId)]);
  const avail = PLAYERS_RAW.filter(p=>!draftedIds.has(p.id)).sort((a,b)=>a.adp-b.adp);
  const eligible = avail.filter(p=>findOpenSlotIndexForPick(teamIdx, p.pos)!==-1);
  const pool = eligible.length ? eligible : avail;
  if(!pool.length) return null;
  // Best-player-available with a little variance, so mocks don't play out identically every time.
  const top = pool.slice(0,4);
  const weights = [0.5,0.25,0.15,0.10].slice(0,top.length);
  const norm = weights.reduce((a,b)=>a+b,0);
  let r = Math.random()*norm;
  for(let i=0;i<top.length;i++){
    if(r < weights[i]) return top[i];
    r -= weights[i];
  }
  return top[0];
}

async function botDraftOnePick(){
  const sched = buildLiveSchedule();
  if(DRAFT.overall >= sched.length) return false;
  const cur = sched[DRAFT.overall];
  const player = pickBotPlayer(cur.teamIdx);
  if(!player) return false;
  DRAFT.picks.push({overall: DRAFT.overall+1, round: cur.round, pickInRound: cur.pickInRound, teamIdx: cur.teamIdx, playerId: player.id});
  DRAFT.overall++;
  if(DRAFT.overall >= sched.length) DRAFT.status = 'complete';
  DRAFT.version = (DRAFT.version||0)+1;
  await storageSet(DRAFT_KEY, DRAFT, true);
  return true;
}

async function runBotsUntilUserTurn(){
  if(!MOCK || botLoopRunning) return;
  botLoopRunning = true;
  try{
    while(true){
      const sched = buildLiveSchedule();
      if(DRAFT.overall >= sched.length){
        renderResults();
        showScreen('results');
        break;
      }
      const cur = sched[DRAFT.overall];
      if(cur.teamIdx === IDENTITY.teamIdx){ renderAll(); break; }
      renderAll(); // show this pick "on the clock" before it resolves, so nothing skips ahead unseen
      await new Promise(r=>setTimeout(r, 260));
      const ok = await botDraftOnePick();
      if(!ok){
        toast("Ran out of players — your roster settings need more players than the pool has. Try fewer teams, a smaller bench, or reset picks.");
        renderAll();
        break;
      }
      renderAll();
    }
  } finally {
    botLoopRunning = false;
  }
}

async function simulateRestOfMockDraft(){
  if(!MOCK) return;
  let ranOut = false;
  while(DRAFT.overall < buildLiveSchedule().length){
    const ok = await botDraftOnePick();
    if(!ok){ ranOut = true; break; }
  }
  if(DRAFT.status==='complete'){
    renderResults();
    showScreen('results');
  } else {
    renderAll();
    if(ranOut) toast("Ran out of players — your roster settings need more players than the pool has. Try fewer teams, a smaller bench, or reset picks.");
  }
}

document.getElementById('copyInviteBtn').addEventListener('click', async ()=>{
  try{
    await navigator.clipboard.writeText(location.href);
    toast('Invite link copied!');
  }catch(e){
    toast('Could not copy — copy this URL manually: ' + location.href);
  }
});

/* ---------------- LOBBY screen ---------------- */

function renderLobby(){
  document.getElementById('lobbyLeagueTitle').textContent =
    DRAFT.overall > 0 ? 'Draft in progress — jump back in.' : 'Claim your team.';

  const nameInput = document.getElementById('managerName');
  if(IDENTITY.name && !nameInput.value) nameInput.value = IDENTITY.name;

  const wrap = document.getElementById('teamCards');
  wrap.innerHTML = CONFIG.teamNames.map((name,i)=>{
    const claim = DRAFT.claims[i];
    const isMine = IDENTITY.teamIdx === i && IDENTITY.name && claim === IDENTITY.name;
    let statusHtml, btnHtml;
    if(isMine){
      statusHtml = `<div class="claim-status mine">● You're drafting this team</div>`;
      btnHtml = `<button class="btn-ghost" onclick="unclaimTeam(${i})">Release team</button>`;
    } else if(claim){
      statusHtml = `<div class="claim-status taken">● Claimed by ${escapeHtml(claim)}</div>`;
      btnHtml = `<button class="btn-secondary" disabled>Already claimed</button>`;
    } else {
      statusHtml = `<div class="claim-status">○ Open</div>`;
      btnHtml = `<button class="btn-secondary" onclick="claimTeam(${i})">Claim this team</button>`;
    }
    const nameHtml = isMine
      ? `<div class="tname-edit">
          <input type="text" class="tname-input" data-idx="${i}" maxlength="40" value="${escapeHtml(name)}">
          <button class="btn-ghost tname-save" data-idx="${i}">Save</button>
        </div>`
      : `<div class="tname">${escapeHtml(name)}</div>`;
    return `<div class="team-card2 ${isMine?'mine':''}">
      ${nameHtml}
      ${statusHtml}
      ${btnHtml}
    </div>`;
  }).join('');

  wrap.querySelectorAll('.tname-save').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const idx = parseInt(btn.dataset.idx,10);
      const input = wrap.querySelector(`.tname-input[data-idx="${idx}"]`);
      renameMyTeam(idx, input.value);
    });
  });
  wrap.querySelectorAll('.tname-input').forEach(inp=>{
    inp.addEventListener('keydown', (e)=>{
      if(e.key==='Enter'){
        e.preventDefault();
        renameMyTeam(parseInt(inp.dataset.idx,10), inp.value);
      }
    });
  });

  const hint = document.getElementById('lobbyHint');
  const claimedCount = Object.keys(DRAFT.claims).length;
  hint.textContent = `${claimedCount} of ${CONFIG.numTeams} teams claimed. Unclaimed teams can be drafted for by anyone in the room.`;

  renderCommishStatus();
  renderOrderList();
  renderKeeperSkipForms();
  renderCustomStatsAdmin();
  updateTopbar();
}

function renderCommishStatus(){
  const wrap = document.getElementById('commishStatus');
  if(!CONFIG.commissionerToken){
    wrap.innerHTML = `No commissioner set for this room yet. Whoever claims it gets sole control over the draft order and keepers.
      <div style="margin-top:10px;"><button class="btn-secondary" id="claimCommishBtn">👑 Make me the commissioner</button></div>`;
    document.getElementById('claimCommishBtn').addEventListener('click', claimCommissioner);
  } else if(isCommissioner()){
    wrap.innerHTML = `👑 <strong style="color:var(--turf);">You're the commissioner.</strong> Only you can edit the draft order, keepers, and pick restrictions below.`;
  } else {
    wrap.innerHTML = `🔒 The commissioner controls the draft order, keepers, and pick restrictions for this room. Everything else here is open to everyone.`;
  }
}

async function claimCommissioner(){
  DRAFT = await storageGet(DRAFT_KEY, true) || DRAFT;
  CONFIG = await storageGet(CFG_KEY, true) || CONFIG;
  if(CONFIG.commissionerToken){ toast('Someone already claimed commissioner.'); renderLobby(); return; }
  const token = genToken();
  CONFIG.commissionerToken = token;
  CONFIG.version = (CONFIG.version||1) + 1;
  const res = await storageSet(CFG_KEY, CONFIG, true);
  if(!res.ok){ toast('Could not claim commissioner: ' + res.error); return; }
  COMMISH_TOKEN = token;
  await storageSet('commissioner_token', {token}, false);
  renderLobby();
}

function draftStarted(){ return DRAFT.overall > 0; }

let keeperSearch = '';

function renderKeeperPlayerOptions(){
  const sel = document.getElementById('keeperPlayer');
  const takenIds = new Set([...DRAFT.picks.map(p=>p.playerId), ...(DRAFT.keepers||[]).map(k=>k.playerId)]);
  let avail = PLAYERS_RAW.filter(p=>!takenIds.has(p.id));
  if(keeperSearch){
    const q = keeperSearch.toLowerCase();
    avail = avail.filter(p=>p.name.toLowerCase().includes(q) || p.team.toLowerCase().includes(q) || p.pos.toLowerCase()===q);
  }
  avail.sort((a,b)=>a.adp-b.adp);
  const prevVal = sel.value;
  avail = avail.slice(0,200);
  sel.innerHTML = avail.length
    ? avail.map(p=>`<option value="${p.id}">${p.adp} · ${p.pos} · ${escapeHtml(p.name)} (${p.team})</option>`).join('')
    : `<option value="" disabled>No players match "${escapeHtml(keeperSearch)}"</option>`;
  if(avail.some(p=>String(p.id)===prevVal)) sel.value = prevVal;
}

document.getElementById('keeperPlayerSearch').addEventListener('input', (e)=>{
  keeperSearch = e.target.value;
  renderKeeperPlayerOptions();
});

function renderKeeperSkipForms(){
  const locked = draftStarted();
  const notCommish = !isCommissioner();
  const canEdit = !locked && !notCommish;

  document.getElementById('keeperLocked').style.display = (locked || notCommish) ? 'block' : 'none';
  document.getElementById('keeperLocked').textContent = locked
    ? '🔒 Keepers are locked once the draft has started. Reset picks in the draft room to make changes.'
    : (notCommish ? '🔒 Only the commissioner can set keepers.' : '');
  document.getElementById('keeperTeam').disabled = !canEdit;
  document.getElementById('keeperPlayerSearch').disabled = !canEdit;
  document.getElementById('keeperPlayer').disabled = !canEdit;
  document.getElementById('keeperRound').disabled = !canEdit;
  document.getElementById('addKeeperBtn').disabled = !canEdit;

  document.getElementById('skipLocked').style.display = (locked || notCommish) ? 'block' : 'none';
  document.getElementById('skipLocked').textContent = locked
    ? '🔒 Pick restrictions are locked once the draft has started. Reset picks in the draft room to make changes.'
    : (notCommish ? '🔒 Only the commissioner can set pick restrictions.' : '');
  document.getElementById('skipTeam').disabled = !canEdit;
  document.getElementById('skipRound').disabled = !canEdit;
  document.getElementById('addSkipBtn').disabled = !canEdit;

  const rounds = totalRounds();
  const skipSet = getSkipSet();

  // team selects
  const teamOpts = CONFIG.teamNames.map((n,i)=>`<option value="${i}">${escapeHtml(n)}</option>`).join('');
  document.getElementById('keeperTeam').innerHTML = teamOpts;
  document.getElementById('skipTeam').innerHTML = teamOpts;

  renderKeeperPlayerOptions();

  // round selects
  const roundOpts = [];
  for(let r=1;r<=rounds;r++) roundOpts.push(`<option value="${r}">Round ${r}</option>`);
  document.getElementById('keeperRound').innerHTML = roundOpts.join('');
  document.getElementById('skipRound').innerHTML = roundOpts.join('');

  const keeperList = document.getElementById('keeperList');
  const keepers = DRAFT.keepers || [];
  keeperList.innerHTML = keepers.length ? keepers.map((k,i)=>{
    const p = PLAYERS_RAW.find(pl=>pl.id===k.playerId);
    return `<div class="kx-row">
      <span class="kx-tag">RD ${k.round}</span>
      <span class="kx-main">${escapeHtml(CONFIG.teamNames[k.teamIdx])} — ${p?escapeHtml(p.name):'?'} <span style="color:var(--muted)">${p?p.pos+' · '+p.team:''}</span></span>
      ${!canEdit ? '' : `<button class="kx-remove" onclick="removeKeeper(${i})">Remove</button>`}
    </div>`;
  }).join('') : `<div class="kx-empty">No keepers set yet.</div>`;

  const skipList = document.getElementById('skipList');
  const skips = DRAFT.skips || [];
  skipList.innerHTML = skips.length ? skips.map((k,i)=>`
    <div class="kx-row">
      <span class="kx-tag">RD ${k.round}</span>
      <span class="kx-main">${escapeHtml(CONFIG.teamNames[k.teamIdx])} — pick blocked</span>
      ${!canEdit ? '' : `<button class="kx-remove" onclick="removeSkip(${i})">Remove</button>`}
    </div>
  `).join('') : `<div class="kx-empty">No pick restrictions set.</div>`;
}

document.getElementById('addKeeperBtn').addEventListener('click', async ()=>{
  if(!isCommissioner()){ toast('Only the commissioner can set keepers.'); return; }
  DRAFT = await storageGet(DRAFT_KEY, true) || DRAFT;
  if(draftStarted()){ toast('Draft already started — keepers are locked.'); renderKeeperSkipForms(); return; }
  const teamIdx = parseInt(document.getElementById('keeperTeam').value,10);
  const playerId = parseInt(document.getElementById('keeperPlayer').value,10);
  const round = parseInt(document.getElementById('keeperRound').value,10);
  if(Number.isNaN(teamIdx) || Number.isNaN(playerId) || Number.isNaN(round)){ toast('Fill out all fields.'); return; }
  const skipSet = getSkipSet();
  if(skipSet.has(teamIdx+'-'+round)){ toast(`${CONFIG.teamNames[teamIdx]} already has round ${round} spoken for.`); return; }
  const takenIds = new Set([...DRAFT.picks.map(p=>p.playerId), ...(DRAFT.keepers||[]).map(k=>k.playerId)]);
  if(takenIds.has(playerId)){ toast('That player is already taken.'); renderKeeperSkipForms(); return; }
  DRAFT.keepers = DRAFT.keepers || [];
  DRAFT.keepers.push({teamIdx, playerId, round});
  DRAFT.version = (DRAFT.version||0)+1;
  await storageSet(DRAFT_KEY, DRAFT, true);
  renderKeeperSkipForms();
  toast('Keeper added.');
});

window.removeKeeper = async function(idx){
  if(!isCommissioner()){ toast('Only the commissioner can set keepers.'); return; }
  DRAFT = await storageGet(DRAFT_KEY, true) || DRAFT;
  if(draftStarted()){ toast('Draft already started — keepers are locked.'); renderKeeperSkipForms(); return; }
  (DRAFT.keepers||[]).splice(idx,1);
  DRAFT.version = (DRAFT.version||0)+1;
  await storageSet(DRAFT_KEY, DRAFT, true);
  renderKeeperSkipForms();
};

document.getElementById('addSkipBtn').addEventListener('click', async ()=>{
  if(!isCommissioner()){ toast('Only the commissioner can set pick restrictions.'); return; }
  DRAFT = await storageGet(DRAFT_KEY, true) || DRAFT;
  if(draftStarted()){ toast('Draft already started — pick restrictions are locked.'); renderKeeperSkipForms(); return; }
  const teamIdx = parseInt(document.getElementById('skipTeam').value,10);
  const round = parseInt(document.getElementById('skipRound').value,10);
  if(Number.isNaN(teamIdx) || Number.isNaN(round)){ toast('Fill out all fields.'); return; }
  const skipSet = getSkipSet();
  if(skipSet.has(teamIdx+'-'+round)){ toast(`${CONFIG.teamNames[teamIdx]} already has round ${round} spoken for.`); return; }
  DRAFT.skips = DRAFT.skips || [];
  DRAFT.skips.push({teamIdx, round});
  DRAFT.version = (DRAFT.version||0)+1;
  await storageSet(DRAFT_KEY, DRAFT, true);
  renderKeeperSkipForms();
  toast('Pick blocked.');
});

window.removeSkip = async function(idx){
  if(!isCommissioner()){ toast('Only the commissioner can set pick restrictions.'); return; }
  DRAFT = await storageGet(DRAFT_KEY, true) || DRAFT;
  if(draftStarted()){ toast('Draft already started — pick restrictions are locked.'); renderKeeperSkipForms(); return; }
  (DRAFT.skips||[]).splice(idx,1);
  DRAFT.version = (DRAFT.version||0)+1;
  await storageSet(DRAFT_KEY, DRAFT, true);
  renderKeeperSkipForms();
};

/* ---------------- custom stats ---------------- */

function slugifyStatKey(label){
  const base = label.trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'') || 'stat';
  let key = base, n = 1;
  const existing = new Set((CONFIG.customStats.defs||[]).map(d=>d.key));
  while(existing.has(key)) key = `${base}_${++n}`;
  return key;
}

function renderCustomStatsAdmin(){
  const canEdit = isCommissioner();
  document.getElementById('customStatsLocked').style.display = canEdit ? 'none' : 'block';
  document.getElementById('customStatName').disabled = !canEdit;
  document.getElementById('addCustomStatBtn').disabled = !canEdit;

  const defs = (CONFIG.customStats && CONFIG.customStats.defs) || [];
  const wrap = document.getElementById('customStatsList');
  wrap.innerHTML = defs.length ? defs.map((d,i)=>`
    <div class="cs-def-row">
      <span class="csk">${escapeHtml(d.label)}</span>
      ${canEdit ? `<button class="kx-remove" onclick="removeCustomStat(${i})">Remove</button>` : ''}
    </div>
  `).join('') : `<div class="kx-empty">No custom stats yet — add one above.</div>`;
}

document.getElementById('addCustomStatBtn').addEventListener('click', async ()=>{
  if(!isCommissioner()){ toast('Only the commissioner can add custom stats.'); return; }
  const input = document.getElementById('customStatName');
  const label = input.value.trim();
  if(!label){ toast('Enter a name for the stat.'); return; }
  CONFIG = await storageGet(CFG_KEY, true) || CONFIG;
  if(!CONFIG.customStats) CONFIG.customStats = {defs:[], values:{}};
  if((CONFIG.customStats.defs||[]).some(d=>d.label.toLowerCase()===label.toLowerCase())){
    toast('That stat already exists.'); return;
  }
  const key = slugifyStatKey(label);
  CONFIG.customStats.defs = [...(CONFIG.customStats.defs||[]), {key, label}];
  CONFIG.version = (CONFIG.version||1) + 1;
  const res = await storageSet(CFG_KEY, CONFIG, true);
  if(!res.ok){ toast('Could not save: ' + res.error); return; }
  input.value = '';
  renderCustomStatsAdmin();
  toast('Custom stat added.');
});

window.removeCustomStat = async function(idx){
  if(!isCommissioner()){ toast('Only the commissioner can remove custom stats.'); return; }
  CONFIG = await storageGet(CFG_KEY, true) || CONFIG;
  const defs = CONFIG.customStats.defs || [];
  const removed = defs[idx];
  CONFIG.customStats.defs = defs.filter((_,i)=>i!==idx);
  if(removed){
    Object.values(CONFIG.customStats.values||{}).forEach(v=>{ delete v[removed.key]; });
  }
  CONFIG.version = (CONFIG.version||1) + 1;
  await storageSet(CFG_KEY, CONFIG, true);
  renderCustomStatsAdmin();
};

async function setCustomStatValue(playerId, key, value){
  if(!isCommissioner() && !MOCK){ toast('Only the commissioner can edit custom stats.'); return; }
  CONFIG = await storageGet(CFG_KEY, true) || CONFIG;
  if(!CONFIG.customStats) CONFIG.customStats = {defs:[], values:{}};
  if(!CONFIG.customStats.values[playerId]) CONFIG.customStats.values[playerId] = {};
  if(value === ''){ delete CONFIG.customStats.values[playerId][key]; }
  else { CONFIG.customStats.values[playerId][key] = value; }
  CONFIG.version = (CONFIG.version||1) + 1;
  const res = await storageSet(CFG_KEY, CONFIG, true);
  if(!res.ok){ toast('Could not save: ' + res.error); return; }
  toast('Saved.');
}

/* ---------------- player detail modal ---------------- */

let modalPlayerId = null;

window.openPlayerModal = function(playerId){
  modalPlayerId = playerId;
  renderPlayerModal();
  document.getElementById('playerModalOverlay').classList.add('show');
};

window.closePlayerModal = function(){
  document.getElementById('playerModalOverlay').classList.remove('show');
  modalPlayerId = null;
};

document.getElementById('playerModalOverlay').addEventListener('click', (e)=>{
  if(e.target.id === 'playerModalOverlay') closePlayerModal();
});

function renderPlayerModal(){
  const p = PLAYERS_RAW.find(pl=>pl.id===modalPlayerId);
  const card = document.getElementById('playerModalCard');
  if(!p){ card.innerHTML = ''; return; }

  const statRows = Object.entries(p.stats||{}).map(([k,v])=>`
    <div class="sk">${STAT_LABELS[k]||k}</div><div class="sv">${v}</div>
  `).join('');

  const injuries = p.injuries||[];
  const hasRealInjuries = injuries.length && injuries[0] !== 'No major injuries on record';
  const injuryHtml = hasRealInjuries
    ? `<ul class="injury-list">${injuries.map(i=>`<li>🩹 ${escapeHtml(i)}</li>`).join('')}</ul>`
    : `<div class="injury-none">No major injuries on record.</div>`;

  const canEdit = isCommissioner() || MOCK;
  const defs = (CONFIG.customStats && CONFIG.customStats.defs) || [];
  const values = (CONFIG.customStats && CONFIG.customStats.values && CONFIG.customStats.values[p.id]) || {};
  const customHtml = defs.length ? defs.map(d=>`
    <div class="custom-stat-row">
      <span class="csk">${escapeHtml(d.label)}</span>
      <input type="text" value="${escapeHtml(values[d.key]!==undefined?String(values[d.key]):'')}"
        ${canEdit?'':'disabled'} data-stat-key="${d.key}" placeholder="—">
    </div>
  `).join('') : `<div class="injury-none">No custom stats defined yet. Add some from ${MOCK ? 'the setup screen' : 'the lobby'}.</div>`;

  card.innerHTML = `
    <button class="modal-close" onclick="closePlayerModal()">✕</button>
    <div class="modal-title">${posPill(p.pos)} ${escapeHtml(p.name)}</div>
    <div class="modal-sub">${p.team} · ${p.posRank} · Bye ${p.bye} · ADP ${p.adp}${p.age?` · Age ${p.age}`:''}</div>
    <div class="stat-grid">
      <div class="sk">Projected Pts</div><div class="sv">${p.projPts ?? '—'}</div>
      ${statRows}
    </div>
    <div class="modal-section">
      <h4>Injury history</h4>
      ${injuryHtml}
    </div>
    <div class="modal-section">
      <h4>Custom stats</h4>
      ${customHtml}
    </div>
  `;

  if(canEdit){
    card.querySelectorAll('input[data-stat-key]').forEach(inp=>{
      inp.addEventListener('change', ()=> setCustomStatValue(p.id, inp.dataset.statKey, inp.value.trim()));
    });
  }
}

/* ---------------- ESPN league import ---------------- */

document.getElementById('espnImportBtn').addEventListener('click', async ()=>{
  const statusEl = document.getElementById('espnStatus');
  const showStatus = (msg, ok)=>{
    statusEl.textContent = msg;
    statusEl.className = 'espn-status show ' + (ok ? 'ok' : 'err');
  };
  const leagueId = document.getElementById('espnLeagueId').value.trim();
  const season = document.getElementById('espnSeason').value.trim();
  const espnS2 = document.getElementById('espnS2').value.trim();
  const swid = document.getElementById('espnSwid').value.trim();
  if(!leagueId){ showStatus('Enter your ESPN league ID first.', false); return; }

  const btn = document.getElementById('espnImportBtn');
  btn.disabled = true; btn.textContent = 'Importing…';
  try{
    const res = await fetch(`${API_BASE}/api/espn`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({leagueId, season, espnS2, swid}),
    });
    const data = await res.json().catch(()=>({}));
    if(!res.ok){
      showStatus(data.error || `ESPN import failed (${res.status}).`, false);
      return;
    }

    const n = Math.max(2, Math.min(16, data.numTeams || data.teams.length));
    const numTeamsSel = document.getElementById('setupNumTeams');
    if([...numTeamsSel.options].some(o=>o.value===String(n))){
      numTeamsSel.value = String(n);
    }
    renderTeamNameInputs(n);
    renderMockSlotOptions(n);
    const rows = [...document.querySelectorAll('#teamNameList .team-name-row')];
    data.teams.slice(0,n).forEach((t,i)=>{
      const row = rows[i];
      if(!row) return;
      row.querySelector('input').value = t.name;
      row.dataset.owner = t.owner || '';
      let ownerSpan = row.querySelector('.oowner');
      if(t.owner){
        if(!ownerSpan){ ownerSpan = document.createElement('span'); ownerSpan.className = 'oowner'; row.appendChild(ownerSpan); }
        ownerSpan.textContent = t.owner;
      } else if(ownerSpan){
        ownerSpan.remove();
      }
    });

    if(data.roster){
      const r = data.roster;
      document.querySelectorAll('#rosterConfig select').forEach(sel=>{
        const key = sel.dataset.key;
        const val = r[key];
        if(val===undefined) return;
        const opts = [...sel.options].map(o=>o.value);
        const nearest = opts.reduce((best,o)=> Math.abs(o-val) < Math.abs(best-val) ? o : best, opts[0]);
        sel.value = String(nearest);
      });
      document.getElementById('cfgDST').checked = !!r.DST;
      document.getElementById('cfgK').checked = !!r.K;
    }

    showStatus(`✓ Imported "${data.leagueName}" — ${n} teams. Review the settings below, then create the room.`, true);
  }catch(e){
    console.error('ESPN import failed', e);
    showStatus('Could not reach the import service. Try again in a moment.', false);
  }finally{
    btn.disabled = false; btn.textContent = '⬇ Import league';
  }
});

function renderOrderList(){
  const wrap = document.getElementById('orderList');
  const base = CONFIG.baseOrder || [...Array(CONFIG.numTeams).keys()];
  const canEdit = isCommissioner();
  document.getElementById('shuffleOrderBtn').style.display = canEdit ? 'inline-block' : 'none';
  document.getElementById('resetOrderBtn').style.display = canEdit ? 'inline-block' : 'none';
  const noteHtml = canEdit ? '' : `<div class="kx-empty" style="margin-bottom:8px;">Only the commissioner can reorder teams.</div>`;
  wrap.innerHTML = noteHtml + base.map((teamIdx,pos)=>{
    const claim = DRAFT.claims[teamIdx];
    return `<div class="order-row" data-pos="${pos}" ${canEdit ? 'draggable="true"' : ''}>
      ${canEdit ? `<span class="odrag" title="Drag to reorder">⠿</span>` : ''}
      <span class="opos">${pos+1}.</span>
      <span class="oname">${escapeHtml(CONFIG.teamNames[teamIdx])}</span>
      <span class="obadge">${claim ? escapeHtml(claim) : 'unclaimed'}</span>
      ${canEdit ? `<span class="obtns">
        <button ${pos===0?'disabled':''} onclick="moveOrderItem(${pos},-1)" title="Move up">▲</button>
        <button ${pos===base.length-1?'disabled':''} onclick="moveOrderItem(${pos},1)" title="Move down">▼</button>
      </span>` : ''}
    </div>`;
  }).join('');
  if(canEdit) wireOrderDragAndDrop();
}

let dragSrcPos = null;

function wireOrderDragAndDrop(){
  const wrap = document.getElementById('orderList');
  const rows = [...wrap.querySelectorAll('.order-row')];
  rows.forEach(row=>{
    row.addEventListener('dragstart', (e)=>{
      dragSrcPos = parseInt(row.dataset.pos,10);
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(dragSrcPos));
    });
    row.addEventListener('dragend', ()=>{
      row.classList.remove('dragging');
      rows.forEach(r=>r.classList.remove('drag-over'));
      dragSrcPos = null;
    });
    row.addEventListener('dragover', (e)=>{
      if(dragSrcPos===null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if(!row.classList.contains('drag-over')){
        rows.forEach(r=>r.classList.remove('drag-over'));
        row.classList.add('drag-over');
      }
    });
    row.addEventListener('dragleave', ()=>{
      row.classList.remove('drag-over');
    });
    row.addEventListener('drop', async (e)=>{
      e.preventDefault();
      row.classList.remove('drag-over');
      const targetPos = parseInt(row.dataset.pos,10);
      if(dragSrcPos===null || dragSrcPos===targetPos) return;
      const base = [...(CONFIG.baseOrder || [...Array(CONFIG.numTeams).keys()])];
      const [moved] = base.splice(dragSrcPos,1);
      base.splice(targetPos,0,moved);
      dragSrcPos = null;
      await saveOrder(base);
    });
  });
}

async function saveOrder(newBase){
  if(!isCommissioner()){ toast('Only the commissioner can change the draft order.'); return; }
  CONFIG = await storageGet(CFG_KEY, true) || CONFIG;
  CONFIG.baseOrder = newBase;
  CONFIG.version = (CONFIG.version || 1) + 1;
  await storageSet(CFG_KEY, CONFIG, true);
  renderOrderList();
  if(currentScreen==='draft') renderAll();
}

window.moveOrderItem = async function(pos, dir){
  if(!isCommissioner()){ toast('Only the commissioner can change the draft order.'); return; }
  const base = [...(CONFIG.baseOrder || [...Array(CONFIG.numTeams).keys()])];
  const target = pos + dir;
  if(target < 0 || target >= base.length) return;
  [base[pos], base[target]] = [base[target], base[pos]];
  await saveOrder(base);
};

document.getElementById('shuffleOrderBtn').addEventListener('click', async ()=>{
  if(!isCommissioner()){ toast('Only the commissioner can change the draft order.'); return; }
  const base = [...(CONFIG.baseOrder || [...Array(CONFIG.numTeams).keys()])];
  for(let i=base.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [base[i],base[j]] = [base[j],base[i]];
  }
  await saveOrder(base);
});

document.getElementById('resetOrderBtn').addEventListener('click', async ()=>{
  if(!isCommissioner()){ toast('Only the commissioner can change the draft order.'); return; }
  const base = [...Array(CONFIG.numTeams).keys()];
  await saveOrder(base);
});

function escapeHtml(s){
  const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
}

window.claimTeam = async function(teamIdx){
  const name = document.getElementById('managerName').value.trim();
  if(!name){ toast('Enter your name first'); document.getElementById('managerName').focus(); return; }
  DRAFT = await storageGet(DRAFT_KEY, true) || DRAFT;
  if(DRAFT.claims[teamIdx] && DRAFT.claims[teamIdx] !== name){
    toast('That team was just claimed — pick another.');
    renderLobby(); return;
  }
  Object.keys(DRAFT.claims).forEach(k=>{
    if(DRAFT.claims[k] === name && parseInt(k,10) !== teamIdx) delete DRAFT.claims[k];
  });
  DRAFT.claims[teamIdx] = name;
  DRAFT.version = (DRAFT.version||0) + 1;
  await storageSet(DRAFT_KEY, DRAFT, true);
  IDENTITY = {name, teamIdx};
  await storageSet(ID_KEY, IDENTITY, false);
  renderLobby();
};

window.unclaimTeam = async function(teamIdx){
  DRAFT = await storageGet(DRAFT_KEY, true) || DRAFT;
  if(DRAFT.claims[teamIdx]) delete DRAFT.claims[teamIdx];
  DRAFT.version = (DRAFT.version||0) + 1;
  await storageSet(DRAFT_KEY, DRAFT, true);
  IDENTITY = {name: IDENTITY.name, teamIdx: null};
  await storageSet(ID_KEY, IDENTITY, false);
  renderLobby();
};

window.renameMyTeam = async function(teamIdx, newName){
  newName = (newName||'').trim();
  if(!newName){ toast("Team name can't be empty."); renderLobby(); return; }
  if(IDENTITY.teamIdx !== teamIdx){ toast('You can only rename your own team.'); return; }
  DRAFT = await storageGet(DRAFT_KEY, true) || DRAFT;
  if(DRAFT.claims[teamIdx] !== IDENTITY.name){ toast("You don't have this team claimed anymore."); renderLobby(); return; }
  CONFIG = await storageGet(CFG_KEY, true) || CONFIG;
  CONFIG.teamNames[teamIdx] = newName;
  CONFIG.version = (CONFIG.version||1) + 1;
  const res = await storageSet(CFG_KEY, CONFIG, true);
  if(!res.ok){ toast('Could not save: ' + res.error); return; }
  renderLobby();
  if(currentScreen==='draft') renderAll();
  toast('Team name updated!');
};

document.getElementById('enterRoomBtn').addEventListener('click', async ()=>{
  const name = document.getElementById('managerName').value.trim();
  if(name && !IDENTITY.name){ IDENTITY.name = name; await storageSet(ID_KEY, IDENTITY, false); }
  rosterViewIdx = IDENTITY.teamIdx !== null && IDENTITY.teamIdx !== undefined ? IDENTITY.teamIdx : 0;
  enterDraftScreen();
});

document.getElementById('resetRoomBtn').addEventListener('click', async ()=>{
  if(!confirm('This deletes the entire room — teams, claims, and all picks. Everyone will need to set it up again. Continue?')) return;
  await storageDelete(CFG_KEY, true);
  await storageDelete(DRAFT_KEY, true);
  CONFIG = null; DRAFT = null;
  buildSetupForm();
  showScreen('setup');
});

/* ---------------- DRAFT screen ---------------- */

function enterDraftScreen(){
  buildPosTabs();
  buildRosterTeamSelect();
  renderAll();
  showScreen('draft');
  document.getElementById('backToLobbyBtn').textContent = MOCK ? '🎲 New mock draft' : '← Lobby';
  document.getElementById('refreshBtn').style.display = MOCK ? 'none' : 'inline-block';
  document.getElementById('simRestBtn').style.display = MOCK ? 'inline-block' : 'none';
  document.getElementById('renameMyTeamBtn').style.display =
    (IDENTITY.teamIdx!==null && IDENTITY.teamIdx!==undefined) ? 'inline-block' : 'none';
  if(DRAFT.status==='complete') showScreen('results'), renderResults();
}

document.getElementById('renameMyTeamBtn').addEventListener('click', ()=>{
  if(IDENTITY.teamIdx===null || IDENTITY.teamIdx===undefined){ toast('Claim a team first.'); return; }
  const current = CONFIG.teamNames[IDENTITY.teamIdx];
  const next = prompt('Rename your team:', current);
  if(next===null) return; // cancelled
  renameMyTeam(IDENTITY.teamIdx, next);
});

document.getElementById('backToLobbyBtn').addEventListener('click', ()=>{
  if(MOCK){
    MOCK = false;
    buildSetupForm();
    showScreen('setup');
    return;
  }
  renderLobby();
  showScreen('lobby');
});
document.getElementById('refreshBtn').addEventListener('click', async ()=>{
  await pollOnce(true);
});
document.getElementById('simRestBtn').addEventListener('click', async ()=>{
  await simulateRestOfMockDraft();
});

function buildPosTabs(){
  const tabs = ['ALL','QB','RB','WR','TE','FLEX','DST','K'];
  const wrap = document.getElementById('posTabs');
  wrap.innerHTML = tabs.map(t=>`<button class="pos-tab ${t===posFilter?'active':''}" data-pos="${t}">${t}</button>`).join('');
  wrap.querySelectorAll('.pos-tab').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      wrap.querySelectorAll('.pos-tab').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      posFilter = btn.dataset.pos;
      renderPlayerList();
    });
  });
}
document.getElementById('searchBox').addEventListener('input', (e)=>{
  searchTerm = e.target.value;
  renderPlayerList();
});

function buildRosterTeamSelect(){
  const sel = document.getElementById('rosterTeamSelect');
  sel.innerHTML = CONFIG.teamNames.map((n,i)=>`<option value="${i}">${escapeHtml(n)}${IDENTITY.teamIdx===i?' (you)':(MOCK?' (CPU)':'')}</option>`).join('');
  sel.value = rosterViewIdx !== null ? rosterViewIdx : 0;
  sel.onchange = ()=>{ rosterViewIdx = parseInt(sel.value,10); renderRoster(); };
}

function isMyTurn(){
  const sched = buildLiveSchedule();
  if(DRAFT.overall >= sched.length) return false;
  const orderTeam = sched[DRAFT.overall].teamIdx;
  if(IDENTITY.teamIdx === orderTeam) return true;
  if(!DRAFT.claims[orderTeam]) return true; // unclaimed team — anyone can pick
  return false;
}

window.userDraft = async function(playerId){
  if(!IDENTITY.name){ toast('Go back to the lobby and enter your name first.'); return; }
  DRAFT = await storageGet(DRAFT_KEY, true) || DRAFT; // freshest state
  const sched = buildLiveSchedule();
  const total = sched.length;
  if(DRAFT.overall >= total){ toast('Draft is already complete.'); renderAll(); return; }
  const cur = sched[DRAFT.overall];
  const orderTeam = cur.teamIdx;
  const claimant = DRAFT.claims[orderTeam];
  const canAct = (IDENTITY.teamIdx === orderTeam) || !claimant;
  if(!canAct){ toast(`It's ${claimant}'s pick.`); renderAll(); return; }
  if(DRAFT.picks.some(p=>p.playerId===playerId) || (DRAFT.keepers||[]).some(k=>k.playerId===playerId)){
    toast('That player was just taken.'); renderAll(); return;
  }
  const player = PLAYERS_RAW.find(p=>p.id===playerId);
  const slotIdx = findOpenSlotIndexForPick(orderTeam, player.pos);
  if(slotIdx===-1){ toast(`${CONFIG.teamNames[orderTeam]}'s roster has no open spot for ${player.pos}.`); return; }

  const overallIdx = DRAFT.overall;
  DRAFT.picks.push({
    overall: overallIdx+1, round: cur.round, pickInRound: cur.pickInRound,
    teamIdx: orderTeam, playerId
  });
  DRAFT.overall++;
  if(DRAFT.overall >= total) DRAFT.status = 'complete';
  DRAFT.version = (DRAFT.version||0) + 1;
  await storageSet(DRAFT_KEY, DRAFT, true);

  if(DRAFT.status==='complete'){
    renderResults();
    showScreen('results');
  } else {
    renderAll();
    if(MOCK) runBotsUntilUserTurn();
  }
};

/* ---------------- polling ---------------- */

function startPolling(){
  if(pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(()=>pollOnce(false), POLL_MS);
}

async function pollOnce(force){
  if(currentScreen==='loading' || currentScreen==='setup') return;
  const prevDraftVersion = DRAFT ? DRAFT.version : null;
  const prevConfigVersion = CONFIG ? CONFIG.version : null;

  const [freshDraft, freshConfig] = await Promise.all([
    storageGet(DRAFT_KEY, true),
    storageGet(CFG_KEY, true)
  ]);

  let changed = false;
  if(freshDraft && (force || freshDraft.version !== prevDraftVersion)){ DRAFT = freshDraft; changed = true; }
  if(freshConfig && (force || freshConfig.version !== prevConfigVersion)){ CONFIG = freshConfig; changed = true; }
  if(!changed) return;

  if(currentScreen==='lobby'){
    renderLobby();
  } else if(currentScreen==='draft'){
    buildRosterTeamSelect();
    if(DRAFT.status==='complete'){ renderResults(); showScreen('results'); }
    else renderAll();
  } else if(currentScreen==='results'){
    renderResults();
  }
}

/* ---------------- rendering: draft screen ---------------- */

function renderAll(){
  renderClock();
  renderPlayerList();
  renderRoster();
  renderBoard();
  updateTopbar();
}

function updateTopbar(){
  const bar = document.getElementById('topbarStatus');
  const bits = [];
  if(MOCK) bits.push(`<span class="mock-tag">🎲 MOCK DRAFT</span>`);
  if(CONFIG) bits.push(`Pick ${Math.min(DRAFT.overall+1, totalPicks())} of ${totalPicks()}`);
  if(IDENTITY.name){
    const teamLabel = (IDENTITY.teamIdx!==null && IDENTITY.teamIdx!==undefined) ? CONFIG.teamNames[IDENTITY.teamIdx] : 'spectating';
    bits.push(`<span class="you-tag">${escapeHtml(IDENTITY.name)} · ${escapeHtml(teamLabel)}</span>`);
  }
  bar.innerHTML = bits.join(' &nbsp; ');
}

function renderClock(){
  const sched = buildLiveSchedule();
  const total = sched.length;
  const overallIdx = DRAFT.overall;
  if(overallIdx >= total){
    document.getElementById('clockOverall').textContent = '—';
    document.getElementById('clockRound').textContent = 'DONE';
    document.getElementById('clockTeam').textContent = 'Draft complete';
    document.getElementById('clockMeta').textContent = '';
    document.getElementById('upNext').innerHTML = '';
    return;
  }
  const cur = sched[overallIdx];
  const orderTeam = cur.teamIdx;
  const claimant = DRAFT.claims[orderTeam];
  const mine = IDENTITY.teamIdx === orderTeam;
  document.getElementById('clockOverall').textContent = overallIdx+1;
  document.getElementById('clockRound').textContent = `RD ${cur.round} · PICK ${cur.pickInRound}`;
  document.getElementById('clockTeam').textContent = CONFIG.teamNames[orderTeam];
  document.getElementById('clockDot').className = 'dot' + (mine?' you':'');
  document.getElementById('clockMeta').textContent = mine
    ? "You're on the clock — draft a player below"
    : claimant ? `Waiting on ${claimant}…` : 'Unclaimed team — anyone can pick for them';

  const upcoming = [];
  for(let i=overallIdx+1;i<Math.min(overallIdx+6,total);i++){
    const t = sched[i].teamIdx;
    upcoming.push(t===IDENTITY.teamIdx ? 'YOU' : CONFIG.teamNames[t]);
  }
  document.getElementById('upNext').innerHTML = upcoming.length
    ? ('Next: ' + upcoming.map(t=>`<span class="tag">${escapeHtml(t)}</span>`).join(''))
    : '';
}

function posPill(pos){
  return `<span class="pos-pill" style="background:${POS_COLOR[pos]||'#666'}">${pos}</span>`;
}

function renderPlayerList(){
  const body = document.getElementById('plistBody');
  const draftedIds = new Set([
    ...DRAFT.picks.map(p=>p.playerId),
    ...(DRAFT.keepers||[]).map(k=>k.playerId)
  ]);
  const canPick = isMyTurn();
  let list = PLAYERS_RAW.filter(p=>!draftedIds.has(p.id));
  if(posFilter !== 'ALL'){
    if(posFilter==='FLEX') list = list.filter(p=>['RB','WR','TE'].includes(p.pos));
    else list = list.filter(p=>p.pos===posFilter);
  }
  if(searchTerm){
    const q = searchTerm.toLowerCase();
    list = list.filter(p=>p.name.toLowerCase().includes(q) || p.team.toLowerCase().includes(q));
  }
  list.sort((a,b)=>a.adp-b.adp);
  list = list.slice(0,150);

  body.innerHTML = list.map(p=>{
    const hasInjury = (p.injuries||[]).length && p.injuries[0] !== 'No major injuries on record';
    const injuryBadge = hasInjury ? `<span class="injury-tag" title="${escapeHtml(p.injuries.join(' | '))}">🩹</span>` : '';
    const rec = PRIMARY_REC_POS.has(p.pos) && p.stats ? (p.stats.rec ?? '—') : '—';
    return `
    <tr>
      <td class="adp-num">${p.adp}</td>
      <td>${posPill(p.pos)}</td>
      <td><div class="pname pname-link" onclick="openPlayerModal(${p.id})">${escapeHtml(p.name)} ${injuryBadge}</div><div class="pmeta">${p.team} · ${p.posRank}</div></td>
      <td class="pmeta">${p.age ?? '—'}</td>
      <td class="pmeta">${p.projPts ?? '—'}</td>
      <td class="pmeta">${rec}</td>
      <td class="pmeta">${p.bye}</td>
      <td><button class="btn-draft" ${canPick?'':'disabled'} onclick="userDraft(${p.id})">Draft</button></td>
    </tr>
  `;
  }).join('');

  if(!list.length){
    body.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:24px;">No players match your filters.</td></tr>`;
  }
}

function renderRoster(){
  if(rosterViewIdx===null || rosterViewIdx===undefined) rosterViewIdx = IDENTITY.teamIdx!==null && IDENTITY.teamIdx!==undefined ? IDENTITY.teamIdx : 0;
  const roster = computeTeamRoster(rosterViewIdx);
  const body = document.getElementById('rosterBody');
  body.innerHTML = roster.map(s=>{
    if(s.player){
      const p = s.player;
      return `<div class="roster-slot">
        <div class="slot-tag">${s.slotType}</div>
        <div class="slot-player">
          <span class="pname pname-link" onclick="openPlayerModal(${p.id})">${posPill(p.pos)} ${escapeHtml(p.name)}</span>
          <span class="pmeta">${p.team} · Bye ${p.bye} · ADP ${p.adp} · Proj ${p.projPts ?? '—'}</span>
        </div>
      </div>`;
    }
    return `<div class="roster-slot"><div class="slot-tag">${s.slotType}</div><div class="slot-player"><span class="empty">— empty —</span></div></div>`;
  }).join('');
}

function renderBoard(){
  const table = document.getElementById('boardTable');
  // Columns follow the actual configured draft order (round 1, left to right),
  // not raw team-list order, so the board matches what was set on setup/lobby.
  const base = CONFIG.baseOrder || [...Array(CONFIG.numTeams).keys()];
  let thead = '<thead><tr><th class="rnd">RD</th>';
  for(let i=0;i<CONFIG.numTeams;i++){
    const teamIdx = base[i];
    thead += `<th class="${IDENTITY.teamIdx===teamIdx?'you':''}">${escapeHtml(CONFIG.teamNames[teamIdx])}</th>`;
  }
  thead += '</tr></thead>';

  const rounds = totalRounds();
  const sched = buildLiveSchedule();
  const total = sched.length;
  const onClockTeam = DRAFT.overall < total ? sched[DRAFT.overall].teamIdx : null;
  const onClockRound = DRAFT.overall < total ? sched[DRAFT.overall].round : null;
  let rows = '<tbody>';
  for(let r=0;r<rounds;r++){
    rows += `<tr><td class="rnd">${r+1}</td>`;
    for(let col=0; col<CONFIG.numTeams; col++){
      const teamIdx = base[col]; // fixed column per team, ordered by round-1 draft position
      const keeper = (DRAFT.keepers||[]).find(k=>k.teamIdx===teamIdx && k.round===r+1);
      const skip = (DRAFT.skips||[]).find(k=>k.teamIdx===teamIdx && k.round===r+1);
      const pick = DRAFT.picks.find(pk=>pk.teamIdx===teamIdx && pk.round===r+1);
      const isCurrent = onClockTeam===teamIdx && onClockRound===(r+1);
      if(keeper){
        const p = PLAYERS_RAW.find(pl=>pl.id===keeper.playerId);
        rows += `<td><div class="cell-pick" style="background:rgba(108,195,230,0.08);border-left:3px solid var(--steel)">
          <div class="pp">${p?escapeHtml(p.name):'—'}</div><div class="pt">KEEPER · ${p?p.pos:''}</div></div></td>`;
      } else if(skip){
        rows += `<td class="cell-empty" style="color:var(--red);">SKIPPED</td>`;
      } else if(pick){
        const p = PLAYERS_RAW.find(pl=>pl.id===pick.playerId);
        rows += `<td><div class="cell-pick" style="background:rgba(255,255,255,0.03);border-left:3px solid ${POS_COLOR[p.pos]}">
          <div class="pp">${escapeHtml(p.name)}</div><div class="pt">${p.pos} · ${p.team}</div></div></td>`;
      } else {
        rows += `<td class="cell-empty ${isCurrent?'cell-onclock':''}">${isCurrent?'●':'—'}</td>`;
      }
    }
    rows += '</tr>';
  }
  rows += '</tbody>';
  table.innerHTML = thead + rows;
}

document.getElementById('resetPicksBtn').addEventListener('click', async ()=>{
  if(!confirm('Reset all picks and restart this draft? Teams, claims, keepers, and pick restrictions stay put.')) return;
  DRAFT = {status:'lobby', overall:0, picks:[], claims:DRAFT.claims, keepers:DRAFT.keepers||[], skips:DRAFT.skips||[], version:(DRAFT.version||0)+1};
  await storageSet(DRAFT_KEY, DRAFT, true);
  renderAll();
  if(MOCK) runBotsUntilUserTurn();
});

/* ---------------- results ---------------- */

function renderResults(){
  const grid = document.getElementById('teamsGrid');
  grid.innerHTML = CONFIG.teamNames.map((name,i)=>{
    const roster = computeTeamRoster(i);
    const rows = roster.map(s=>{
      const label = s.player ? `${escapeHtml(s.player.name)} <span style="color:var(--muted)">(${s.player.team})</span>` : '<span style="color:var(--muted-2);font-style:italic">empty</span>';
      return `<div class="team-roster-line"><span class="tslot">${s.slotType}</span><span class="tname">${label}</span></div>`;
    }).join('');
    const isMine = IDENTITY.teamIdx===i;
    return `<div class="team-card ${isMine?'you':''}">
      <h3>${escapeHtml(name)} ${isMine?'<span class="you-badge">YOU</span>':''}</h3>
      ${rows}
    </div>`;
  }).join('');
  document.getElementById('newMockFromResultsBtn').style.display = MOCK ? 'inline-block' : 'none';
  updateTopbar();
}

function buildShareText(includeLink){
  const base = CONFIG.baseOrder || [...Array(CONFIG.numTeams).keys()];
  const round1 = base.map((teamIdx,i)=>{
    const pick = DRAFT.picks.find(p=>p.teamIdx===teamIdx && p.round===1)
      || (DRAFT.keepers||[]).find(k=>k.teamIdx===teamIdx && k.round===1);
    const p = pick ? PLAYERS_RAW.find(pl=>pl.id===pick.playerId) : null;
    return `${i+1}. ${CONFIG.teamNames[teamIdx]} — ${p ? p.name : '—'}`;
  }).join('\n');
  let text = `🏈 ${MOCK ? 'Mock draft' : 'League of Pretty Ordinary Gentlemen'} complete — ${CONFIG.numTeams} teams, ${totalPicks()} picks!\n\nRound 1:\n${round1}`;
  if(includeLink && !MOCK) text += `\n\nFull results: ${location.href}`;
  return text;
}

document.getElementById('shareResultsBtn').addEventListener('click', async ()=>{
  if(navigator.share){
    try{
      await navigator.share({
        title: 'Draft Results',
        text: buildShareText(false),
        ...(MOCK ? {} : {url: location.href}),
      });
      return;
    }catch(e){
      if(e && e.name === 'AbortError') return; // user closed the share sheet — not an error
    }
  }
  try{
    await navigator.clipboard.writeText(buildShareText(true));
    toast(MOCK ? 'Results copied to clipboard!' : 'Results copied — paste them anywhere to share!');
  }catch(e){
    toast('Could not copy automatically — select and copy the results manually.');
  }
});

document.getElementById('downloadBtn').addEventListener('click', ()=>{
  let text = 'LEAGUE OF PRETTY ORDINARY GENTLEMEN — Draft Results\n';
  text += `League size: ${CONFIG.numTeams} teams\n\n`;
  CONFIG.teamNames.forEach((name,i)=>{
    const roster = computeTeamRoster(i);
    text += `=== ${name} ===\n`;
    roster.forEach(s=>{
      const label = s.player ? `${s.player.name} (${s.player.pos}, ${s.player.team})` : '—';
      text += `${s.slotType.padEnd(6)} ${label}\n`;
    });
    text += '\n';
  });
  const blob = new Blob([text], {type:'text/plain'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'lopog-draft-results.txt';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

document.getElementById('resetFromResultsBtn').addEventListener('click', async ()=>{
  if(!confirm('Start a brand new draft? This clears all picks (teams, claims, keepers, and pick restrictions stay).')) return;
  DRAFT = {status:'lobby', overall:0, picks:[], claims:DRAFT.claims, keepers:DRAFT.keepers||[], skips:DRAFT.skips||[], version:(DRAFT.version||0)+1};
  await storageSet(DRAFT_KEY, DRAFT, true);
  if(MOCK){
    enterDraftScreen();
    runBotsUntilUserTurn();
  } else {
    renderLobby();
    showScreen('lobby');
  }
});

document.getElementById('newMockFromResultsBtn').addEventListener('click', ()=>{
  MOCK = false;
  buildSetupForm();
  showScreen('setup');
});

boot();
