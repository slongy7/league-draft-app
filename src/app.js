/* ============================================================
   LEAGUE OF PRETTY ORDINARY GENTLEMEN — Live League Draft (multiplayer via window.storage)
   ============================================================ */

const POS_COLOR = {QB:'var(--pos-qb)',RB:'var(--pos-rb)',WR:'var(--pos-wr)',TE:'var(--pos-te)',DST:'var(--pos-dst)',K:'var(--pos-k)'};
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

/* ---------------- storage helpers ---------------- */

function storageAvailable(){
  return typeof window.storage !== 'undefined'
    && typeof window.storage.get === 'function'
    && typeof window.storage.set === 'function';
}

async function storageGet(key, shared){
  try{
    const res = await window.storage.get(key, shared);
    return res ? JSON.parse(res.value) : null;
  }catch(e){ return null; }
}
async function storageSet(key, value, shared){
  try{
    const res = await window.storage.set(key, JSON.stringify(value), shared);
    if(!res){ return {ok:false, error:'Storage write returned empty result.'}; }
    return {ok:true};
  }catch(e){
    console.error('storage set failed', e);
    return {ok:false, error: (e && e.message) ? e.message : String(e)};
  }
}
async function storageDelete(key, shared){
  try{ await window.storage.delete(key, shared); }catch(e){ /* ignore missing key */ }
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

  if(!storageAvailable()){
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
  const savedId = await storageGet(ID_KEY, false);
  if(savedId) IDENTITY = savedId;
  const savedCommish = await storageGet('commissioner_token', false);
  if(savedCommish) COMMISH_TOKEN = savedCommish.token;

  renderLobby();
  showScreen('lobby');
  startPolling();
}

/* ---------------- SETUP screen ---------------- */

function buildSetupForm(){
  renderTeamNameInputs(10);
  document.getElementById('setupNumTeams').value = '10';
  document.getElementById('setupNumTeams').addEventListener('change', (e)=>{
    renderTeamNameInputs(parseInt(e.target.value,10));
  });
  buildRosterConfigInputs();
}

function renderTeamNameInputs(n){
  const wrap = document.getElementById('teamNameList');
  const existing = [...wrap.querySelectorAll('input')].map(i=>i.value);
  wrap.innerHTML = '';
  for(let i=0;i<n;i++){
    const row = document.createElement('div');
    row.className = 'team-name-row';
    row.innerHTML = `<span class="idx">${i+1}</span><input type="text" placeholder="Team ${i+1}" value="${existing[i]||''}">`;
    wrap.appendChild(row);
  }
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

document.getElementById('createRoomBtn').addEventListener('click', async ()=>{
  if(!storageAvailable()){
    toast('Storage isn\'t available — this page needs to be running as a live Claude artifact.');
    return;
  }
  try{
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

    CONFIG = {numTeams, teamNames, roster, baseOrder: base, createdAt: Date.now(), version: 1, commissionerToken: genToken()};
    const res = await storageSet(CFG_KEY, CONFIG, true);
    if(!res.ok){ toast('Could not create room: ' + res.error); return; }
    COMMISH_TOKEN = CONFIG.commissionerToken;
    await storageSet('commissioner_token', {token: COMMISH_TOKEN}, false);
    DRAFT = {status:'lobby', overall:0, picks:[], claims:{}, keepers:[], skips:[], version:1};
    await storageSet(DRAFT_KEY, DRAFT, true);

    renderLobby();
    showScreen('lobby');
    startPolling();
  }catch(e){
    console.error('Create room failed', e);
    toast('Something went wrong creating the room: ' + (e && e.message ? e.message : String(e)));
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
    return `<div class="team-card2 ${isMine?'mine':''}">
      <div class="tname">${escapeHtml(name)}</div>
      ${statusHtml}
      ${btnHtml}
    </div>`;
  }).join('');

  const hint = document.getElementById('lobbyHint');
  const claimedCount = Object.keys(DRAFT.claims).length;
  hint.textContent = `${claimedCount} of ${CONFIG.numTeams} teams claimed. Unclaimed teams can be drafted for by anyone in the room.`;

  renderCommishStatus();
  renderOrderList();
  renderKeeperSkipForms();
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

function renderOrderList(){
  const wrap = document.getElementById('orderList');
  const base = CONFIG.baseOrder || [...Array(CONFIG.numTeams).keys()];
  const canEdit = isCommissioner();
  document.getElementById('shuffleOrderBtn').style.display = canEdit ? 'inline-block' : 'none';
  document.getElementById('resetOrderBtn').style.display = canEdit ? 'inline-block' : 'none';
  const noteHtml = canEdit ? '' : `<div class="kx-empty" style="margin-bottom:8px;">Only the commissioner can reorder teams.</div>`;
  wrap.innerHTML = noteHtml + base.map((teamIdx,pos)=>{
    const claim = DRAFT.claims[teamIdx];
    return `<div class="order-row">
      <span class="opos">${pos+1}.</span>
      <span class="oname">${escapeHtml(CONFIG.teamNames[teamIdx])}</span>
      <span class="obadge">${claim ? escapeHtml(claim) : 'unclaimed'}</span>
      ${canEdit ? `<span class="obtns">
        <button ${pos===0?'disabled':''} onclick="moveOrderItem(${pos},-1)" title="Move up">▲</button>
        <button ${pos===base.length-1?'disabled':''} onclick="moveOrderItem(${pos},1)" title="Move down">▼</button>
      </span>` : ''}
    </div>`;
  }).join('');
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
  if(DRAFT.status==='complete') showScreen('results'), renderResults();
}

document.getElementById('backToLobbyBtn').addEventListener('click', ()=>{
  renderLobby();
  showScreen('lobby');
});
document.getElementById('refreshBtn').addEventListener('click', async ()=>{
  await pollOnce(true);
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
  sel.innerHTML = CONFIG.teamNames.map((n,i)=>`<option value="${i}">${escapeHtml(n)}${IDENTITY.teamIdx===i?' (you)':''}</option>`).join('');
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

  body.innerHTML = list.map(p=>`
    <tr>
      <td class="adp-num">${p.adp}</td>
      <td>${posPill(p.pos)}</td>
      <td><div class="pname">${escapeHtml(p.name)}</div><div class="pmeta">${p.team} · ${p.posRank}</div></td>
      <td class="pmeta">${p.bye}</td>
      <td><button class="btn-draft" ${canPick?'':'disabled'} onclick="userDraft(${p.id})">Draft</button></td>
    </tr>
  `).join('');

  if(!list.length){
    body.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px;">No players match your filters.</td></tr>`;
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
          <span class="pname">${posPill(p.pos)} ${escapeHtml(p.name)}</span>
          <span class="pmeta">${p.team} · Bye ${p.bye} · ADP ${p.adp}</span>
        </div>
      </div>`;
    }
    return `<div class="roster-slot"><div class="slot-tag">${s.slotType}</div><div class="slot-player"><span class="empty">— empty —</span></div></div>`;
  }).join('');
}

function renderBoard(){
  const table = document.getElementById('boardTable');
  let thead = '<thead><tr><th class="rnd">RD</th>';
  for(let i=0;i<CONFIG.numTeams;i++){
    thead += `<th class="${IDENTITY.teamIdx===i?'you':''}">${escapeHtml(CONFIG.teamNames[i])}</th>`;
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
      const teamIdx = col; // each column is a fixed team, independent of draft order
      const keeper = (DRAFT.keepers||[]).find(k=>k.teamIdx===teamIdx && k.round===r+1);
      const skip = (DRAFT.skips||[]).find(k=>k.teamIdx===teamIdx && k.round===r+1);
      const pick = DRAFT.picks.find(pk=>pk.teamIdx===teamIdx && pk.round===r+1);
      const isCurrent = onClockTeam===teamIdx && onClockRound===(r+1);
      if(keeper){
        const p = PLAYERS_RAW.find(pl=>pl.id===keeper.playerId);
        rows += `<td><div class="cell-pick" style="background:rgba(232,163,61,0.08);border-left:3px solid var(--amber)">
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
  updateTopbar();
}

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
  renderLobby();
  showScreen('lobby');
});

boot();
