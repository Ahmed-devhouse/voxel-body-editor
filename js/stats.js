// Ammo-balance stats + level validation.
//
// Everything here mirrors semantics read out of the Unity project rather than
// guessed at (VoxelCore.cs, VoxelBody.cs, Core/CratePlan.cs):
//
//  * Clearing a level destroys EVERY voxel (BalanceSim: Cleared ⇔ remaining==0),
//    and when wrapInShell is set the game wraps the body in a checkered shell of
//    Y/O voxels on an (size+4)³ grid — for a 14³ body that is 1736 extra voxels,
//    more than the body itself, so ignoring it makes ammo maths meaningless.
//  * A colour is reachable FOREVER if any column's refill is not Empty and is
//    either demand-weighted or pinned to that colour (CratePlan.CanSupply).
//    Opening cells are a finite bonus on top.
//  * An opening cell inherits from its column's refill whatever it leaves unset
//    (CratePlan.CellAt): colour when not pinned, rounds when <= 0, and FLAGS when
//    Auto — so an Auto cell in a column whose refill is Empty silently becomes a
//    hole. That trap is worth shouting about.
//  * X (5) voxels are destroyed by a bullet of any colour (VoxelCore.Matches).
//  * Baked unit kinds are 1 Armoured and 4 Hidden only; 2/3 are boosters.
//
// The final completability verdict belongs to the Unity generator's probe
// (BalanceSim), which simulates play. This panel reports the numbers and the
// unambiguous structural faults, and says so rather than overclaiming.

import { state, EMPTY, idx, unitCount, on } from './state.js';
import { PALETTE, labelOf, colourCount, CRATE_COLOURS, GAME_COLOURS } from './palette.js';

const $ = id => document.getElementById(id);
const FLAG_AUTO = 0, FLAG_EMPTY = 1 << 3;
const CRATE_COLUMNS = 5;
const SHELL_PAD = 2;          // VoxelCore.ShellPad = 1 + ShellGap

/* ---------- voxel censuses ---------- */
function bodyCounts(){
  const n = Math.max(GAME_COLOURS, colourCount());
  const c = new Array(n).fill(0);
  let other = 0;      // bytes with no palette entry at all
  for(let i=0;i<state.colours.length;i++){
    const v = state.colours[i];
    if(v === EMPTY) continue;
    if(v < n) c[v]++; else other++;
  }
  c.other = other;
  return c;
}
// The shell the game adds around the body: the boundary layer of an
// (size + 2*ShellPad)³ grid, coloured Y when (i+j+k) is odd, else O.
function shellCounts(){
  const n = state.N + 2*SHELL_PAD;
  let y = 0, o = 0;
  for(let i=0;i<n;i++) for(let j=0;j<n;j++) for(let k=0;k<n;k++){
    if(i===0||j===0||k===0||i===n-1||j===n-1||k===n-1)
      ((i+j+k) & 1) ? y++ : o++;
  }
  return { y, o, total: y+o, n };
}
function badUnitKinds(){
  const bad = new Set();
  for(let i=0;i<state.units.length;i++){
    const k = state.units[i];
    if(k !== 0 && k !== 1 && k !== 4) bad.add(k);
  }
  return [...bad];
}
function unitsOnEmpty(){
  let n = 0;
  for(let i=0;i<state.units.length;i++)
    if(state.units[i] > 0 && state.colours[i] === EMPTY) n++;
  return n;
}
function islandCount(){
  const N = state.N, c = state.colours;
  const seen = new Uint8Array(N*N*N);
  let islands = 0;
  for(let start=0; start<c.length; start++){
    if(c[start]===EMPTY || seen[start]) continue;
    islands++;
    const q = [start];
    seen[start] = 1;
    while(q.length){
      const i = q.pop();
      const z = i % N, y = ((i/N)|0) % N, x = (i/(N*N))|0;   // idx = (x*N+y)*N+z
      for(const [dx,dy,dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]){
        const nx=x+dx, ny=y+dy, nz=z+dz;
        if(nx<0||ny<0||nz<0||nx>=N||ny>=N||nz>=N) continue;
        const ni = idx(nx,ny,nz);
        if(c[ni]!==EMPTY && !seen[ni]){ seen[ni]=1; q.push(ni); }
      }
    }
  }
  return islands;
}

/* ---------- crate plan, resolved the way the game resolves it ---------- */
function refillOf(c){
  const r = state.meta.crateRefills[c];
  if(!r) return {colour:-1, rounds:0, chain:0, flags:FLAG_AUTO};
  // CratePlan.RefillOf normalises a junk colour to "any"
  return {...r, colour: (r.colour >= 0 && r.colour < CRATE_COLOURS) ? r.colour : -1};
}
// mirror of CratePlan.CellAt: unset fields inherit from the column's refill
function cellAt(c, r){
  const rows = Math.max(1, state.meta.crateRows|0);
  const refill = refillOf(c);
  const stored = state.meta.crateCells[c*rows + r];
  if(!stored) return {...refill};
  const cell = {...stored};
  const pinned = cell.colour >= 0 && cell.colour < CRATE_COLOURS;
  if(!pinned) cell.colour = refill.colour;
  if(cell.rounds <= 0) cell.rounds = refill.rounds;
  if(cell.flags === FLAG_AUTO) cell.flags = refill.flags;   // ← the silent-hole path
  return cell;
}

export function updateStats(){
  const tbl = $('statsTbl');
  if(!tbl) return;

  const body = bodyCounts();
  const shelled = !!state.meta.wrapInShell;
  const shell = shelled ? shellCounts() : {y:0, o:0, total:0, n:state.N};
  const custom = !!state.meta.customCrateGrid;
  const rows = Math.max(1, state.meta.crateRows|0);

  // targets the player must destroy, per colour
  const need = [0,0,0,0,0];
  for(let i=0;i<CRATE_COLOURS;i++) need[i] = body[i];
  need[0] += shell.y;   // Y
  need[1] += shell.o;   // O
  const wild = body[5];

  // supply — only meaningful when the body authors its own board
  const opening = [0,0,0,0,0];
  let anyOpening = 0;
  const unlimited = [false,false,false,false,false];
  let autoHoles = 0, holes = 0;
  if(custom){
    for(let c=0;c<CRATE_COLUMNS;c++){
      const refill = refillOf(c);
      if(!(refill.flags & FLAG_EMPTY)){
        if(refill.colour < 0) for(let i=0;i<CRATE_COLOURS;i++) unlimited[i] = true;
        else unlimited[refill.colour] = true;
      }
      for(let r=0;r<rows;r++){
        const stored = state.meta.crateCells[c*rows + r];
        const cell = cellAt(c, r);
        if(cell.flags & FLAG_EMPTY){
          holes++;
          if(stored && stored.flags === FLAG_AUTO) autoHoles++;   // inherited the hole
          continue;
        }
        if(cell.colour >= 0 && cell.colour < CRATE_COLOURS) opening[cell.colour] += cell.rounds;
        else anyOpening += cell.rounds;
      }
    }
  }

  /* ---------- table ---------- */
  let html = '<tr><th>colour</th><th>voxels</th>' +
    (shelled ? '<th>+shell</th>' : '') +
    (custom ? '<th>opening</th><th>refill</th>' : '') + '</tr>';
  let totalOpening = 0;
  const swatch = i => (PALETTE[i] ? PALETTE[i].hex : '#ff00ff');
  for(let i=0;i<CRATE_COLOURS;i++){
    totalOpening += opening[i];
    const short = custom && !unlimited[i] && need[i] > opening[i] + anyOpening;
    html += `<tr><td><span class="cswatch" style="background:${swatch(i)}"></span>${labelOf(i)}</td>
      <td>${body[i]}</td>` +
      (shelled ? `<td>${i===0 ? shell.y : i===1 ? shell.o : 0}</td>` : '') +
      (custom ? `<td class="${short?'badA':''}">${opening[i]}</td>
        <td class="${unlimited[i]?'okA':''}">${unlimited[i] ? '∞' : '—'}</td>` : '') +
      '</tr>';
  }
  if(wild > 0)
    html += `<tr><td><span class="cswatch" style="background:${swatch(5)}"></span>${labelOf(5)}</td>
      <td>${wild}</td>${shelled?'<td>0</td>':''}${custom?'<td colspan="2" style="text-align:left;color:var(--mut)">any bullet</td>':''}</tr>`;
  // colours past the game build get their own rows — they are unhittable, so
  // they must never be quietly folded into a total that looks fine
  let beyond = 0;
  for(let i=GAME_COLOURS;i<body.length;i++){
    if(!body[i]) continue;
    beyond += body[i];
    html += `<tr><td><span class="cswatch" style="background:${swatch(i)}"></span>${labelOf(i)}</td>
      <td class="badA">${body[i]}</td>${shelled?'<td>0</td>':''}` +
      (custom ? '<td colspan="2" style="text-align:left" class="badA">no crate can hit this</td>' : '') + '</tr>';
  }
  // body.other counts bytes with no palette entry at all — they are real voxels
  // and must not be dropped from the total, or an all-junk model reads as empty
  const bodyTotal = body[0]+body[1]+body[2]+body[3]+body[4]+wild+beyond+body.other;
  html += `<tr><td><b>total</b></td><td><b>${bodyTotal}</b></td>` +
    (shelled ? `<td><b>${shell.total}</b></td>` : '') +
    (custom ? `<td><b>${totalOpening + anyOpening}</b></td><td></td>` : '') + '</tr>';
  tbl.innerHTML = html;

  /* ---------- validation ---------- */
  const warn = [], info = [];
  const painted = unitCount();
  const ruled = state.meta.unitRules.reduce((s,r) => s+r.count, 0);

  if(bodyTotal === 0) warn.push('Model is empty — nothing to export.');
  if(beyond)
    warn.push(`${beyond} voxel(s) use colour ${GAME_COLOURS} or above. This game build renders those magenta and no crate can ever mint their colour, so the level cannot be cleared. Extend <b>Palette.Colours</b> and <b>Cols</b> in Unity (and <b>CrateColourCount</b> if they should be shootable), then raise GAME_COLOURS in palette.js.`);
  if(body.other)
    warn.push(`${body.other} voxel(s) use a colour byte with no palette entry at all — the game renders those magenta.`);
  const badKinds = badUnitKinds();
  if(badKinds.length)
    warn.push(`Unit kind ${badKinds.join(', ')} found — baked bodies only accept 1 (armoured) and 4 (hidden); 2 bomb / 3 rocket are boosters, never voxels.`);
  const orphans = unitsOnEmpty();
  if(orphans) warn.push(`${orphans} unit(s) sit on empty cells and will never appear in play.`);

  if(shelled)
    info.push(`Shell on: the game wraps this body in an ${shell.n}³ grid, adding <b>${shell.total}</b> checkered voxels (${shell.y} Y + ${shell.o} O) that must also be shot — included in the counts above.`);

  if(!custom){
    info.push('Custom crate grid is off — the game rolls its stock demand-weighted board, which always mints colours something still standing needs, so ammo cannot run dry.');
  } else {
    if(autoHoles)
      warn.push(`${autoHoles} opening crate(s) are on Auto in a column whose refill carries the Empty flag — <b>the game makes them inherit Empty, turning them into holes</b>. Set their flags explicitly (Plain) or clear Empty on that column's refill.`);
    else if(holes)
      info.push(`${holes} authored hole(s) on the opening board.`);
    const refilling = unlimited.filter(Boolean).length;
    if(refilling === 0)
      info.push('No column refills — the opening board is this level\'s entire ammo supply.');
    else
      info.push(`${refilling} colour(s) refill forever and can always be reached; opening rounds are a finite bonus on top.`);

    // per-colour, not gated on "nothing refills": a colour with no refilling
    // column is finite even when other colours refill forever
    const shortList = [];
    for(let i=0;i<CRATE_COLOURS;i++)
      if(!unlimited[i] && need[i] > opening[i] + anyOpening)
        shortList.push(`${labelOf(i)} ${opening[i] + anyOpening}/${need[i]}`);
    if(shortList.length)
      warn.push(`Opening rounds don't cover every voxel of: ${shortList.join(', ')} (rounds/voxels, shell included) and no column refills those colours. Confirm with the Unity generator's balance probe before shipping — it simulates play, this panel only counts.`);

    // X voxels are killed by any colour, so they are charged against the pooled
    // total rather than one colour — only meaningful while supply is finite
    if(refilling === 0){
      const targets = need.reduce((a,b)=>a+b, 0) + wild;
      const supply = totalOpening + anyOpening;
      if(supply < targets)
        warn.push(`Total opening rounds (${supply}) are fewer than total voxels to destroy (${targets}${wild?`, including ${wild} X wildcard`:''}) with nothing refilling — the level cannot be cleared as authored.`);
    }
  }

  if(painted !== ruled)
    warn.push(`Painted units (${painted}) don't match unit rules total (${ruled}). The game builds from the painted grid — rules only describe generator intent.`);
  else if(ruled > 0)
    info.push(`Painted units: ${painted} — matches unit rules.`);
  const isl = bodyTotal > 0 ? islandCount() : 0;
  if(isl > 1) info.push(`Body has ${isl} disconnected islands (fine if intended).`);
  if(anyOpening) info.push(`Demand-weighted opening crates supply ${anyOpening} rounds usable by any colour.`);

  const list = $('validList');
  list.innerHTML =
    warn.map(w => `<li class="vwarn">${w}</li>`).join('') +
    info.map(t => `<li class="vinfo">${t}</li>`).join('') ||
    '<li class="vok">No issues found.</li>';
  $('statsNote').innerHTML = custom
    ? 'Voxels are what must be destroyed to clear the level; “opening” = rounds on the starting board after each cell inherits its column\'s refill, as the game does. A colour marked ∞ can always be reached.'
    : 'Voxels are what must be destroyed to clear the level. Turn on the custom crate grid in the Crates tab to author and check an ammo supply.';
}

export function initStats(){
  // debounced: 'grid' fires per paint stroke and the island/shell scans are O(N³)
  let timer = null;
  const soon = () => { clearTimeout(timer); timer = setTimeout(updateStats, 150); };
  on('grid', soon);
  on('meta', soon);
  on('palette', soon);
  updateStats();
}
