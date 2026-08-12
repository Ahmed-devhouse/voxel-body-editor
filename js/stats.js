// Ammo-balance stats + level validation warnings.

import { state, EMPTY, idx, colourCounts, unitCount, on } from './state.js';
import { PALETTE } from './palette.js';

const $ = id => document.getElementById(id);

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
      const x = i % N, y = ((i/N)|0) % N, z = (i/(N*N))|0;
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

export function updateStats(){
  const tbl = $('statsTbl');
  if(!tbl) return;
  const counts = colourCounts();
  const ammo = [0,0,0,0,0], crateN = [0,0,0,0,0];
  let anyAmmo = 0;
  for(const cell of state.meta.crateCells){
    if(cell.colour>=0 && cell.colour<5){ ammo[cell.colour]+=cell.rounds; crateN[cell.colour]++; }
    else anyAmmo += cell.rounds;
  }
  let html = '<tr><th>colour</th><th>voxels</th><th>crates</th><th>ammo</th><th>ratio</th></tr>';
  let tv=0, ta=0;
  for(let i=0;i<5;i++){
    tv+=counts[i]; ta+=ammo[i];
    const ratio = counts[i] ? ammo[i]/counts[i] : 0;
    const cls = counts[i]===0 ? '' : ratio>=1 ? 'okA' : 'badA';
    html += `<tr><td><span class="cswatch" style="background:${PALETTE[i]}"></span>c${i}</td>
      <td>${counts[i]}</td><td>${crateN[i]}</td><td>${ammo[i]}</td>
      <td class="${cls}">${counts[i] ? ratio.toFixed(2)+'×' : '—'}</td></tr>`;
  }
  html += `<tr><td><b>total</b></td><td><b>${tv}</b></td><td>${state.meta.crateCells.length}</td><td><b>${ta}</b></td>
    <td>${tv ? (ta/tv).toFixed(2)+'×' : '—'}</td></tr>`;
  tbl.innerHTML = html;

  /* ---------- validation ---------- */
  const warnings = [], infos = [];
  const painted = unitCount();
  const ruled = state.meta.unitRules.reduce((s,r) => s+r.count, 0);

  if(tv === 0) warnings.push('Model is empty — nothing to export.');
  if(counts.other) warnings.push(counts.other + ' voxel(s) use colour values outside 0–4 (wildcard?). The game must know how to handle these.');
  for(let i=0;i<5;i++){
    if(counts[i] > 0 && ammo[i] + anyAmmo < counts[i])
      warnings.push(`Colour c${i}: only ${ammo[i]+anyAmmo} rounds for ${counts[i]} voxels — level may be uncompletable.`);
    if(counts[i] === 0 && crateN[i] > 0)
      infos.push(`Crates supply colour c${i} but the model has no c${i} voxels.`);
  }
  if(painted !== ruled)
    warnings.push(`Painted units (${painted}) don't match unit rules total (${ruled}).`);
  else if(ruled > 0)
    infos.push(`Painted units: ${painted} — matches unit rules.`);
  const isl = tv > 0 ? islandCount() : 0;
  if(isl > 1) infos.push(`Model has ${isl} disconnected islands (fine if intended).`);
  if(anyAmmo) infos.push(`Wildcard crates supply ${anyAmmo} extra rounds (counted for every colour above).`);
  if(state.meta.crateCells.length === 0 && tv > 0)
    warnings.push('No crate cells defined — use auto-fill in the Crates tab as a starting point.');

  const list = $('validList');
  list.innerHTML =
    warnings.map(w => `<li class="vwarn">${w}</li>`).join('') +
    infos.map(t => `<li class="vinfo">${t}</li>`).join('') ||
    '<li class="vok">No issues found.</li>';
  const note = $('statsNote');
  note.textContent = 'Ratio = crate ammo ÷ voxels of that colour. Under 1.00× means the player cannot clear that colour without refills.';
}

export function initStats(){
  // debounced: 'grid' fires per paint stroke and the island scan is O(N³)
  let timer = null;
  const soon = () => { clearTimeout(timer); timer = setTimeout(updateStats, 150); };
  on('grid', soon);
  on('meta', soon);
  on('palette', soon);
  updateStats();
}
