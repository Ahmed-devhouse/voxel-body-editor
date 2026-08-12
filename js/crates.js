// Crate economy editor: the crate cells / refills a level feeds the player.

import { state, emit, colourCounts } from './state.js';
import { colHex, PALETTE } from './palette.js';
import { toast } from './ui.js';

const $ = id => document.getElementById(id);

function colourOptions(selVal, allowAny){
  let h = allowAny ? `<option value="-1" ${selVal===-1?'selected':''}>any (−1)</option>` : '';
  for(let i=0;i<5;i++) h += `<option value="${i}" ${selVal===i?'selected':''}>c${i}</option>`;
  return h;
}

function crateCard(cell, list, i){
  const d = document.createElement('div');
  d.className = 'crateCell';
  const sw = cell.colour>=0 && cell.colour<5 ? PALETTE[cell.colour] : '#5b6272';
  d.innerHTML = `<span class="idx">#${i}</span>
    <div class="row"><label>colour</label><select data-k="colour">${colourOptions(cell.colour,true)}</select><span class="cswatch" style="background:${sw}"></span></div>
    <div class="row"><label>rounds</label><input type="number" value="${cell.rounds}" min="0" data-k="rounds"></div>
    <div class="row"><label>chain</label><input type="number" value="${cell.chain}" min="0" data-k="chain"></div>
    <div class="row"><label>flags</label><input type="number" value="${cell.flags}" min="0" data-k="flags"></div>
    <button class="kill" title="Remove this cell">remove</button>`;
  d.querySelectorAll('[data-k]').forEach(el => el.addEventListener('change', () => {
    cell[el.dataset.k] = parseInt(el.value) || 0;
    if(el.dataset.k === 'colour') renderCrates();
    emit('meta');
  }));
  d.querySelector('.kill').addEventListener('click', () => {
    list.splice(i,1);
    renderCrates();
    emit('meta');
  });
  return d;
}

export function renderCrates(){
  const cc = $('crateCells');
  if(!cc) return;
  cc.innerHTML = '';
  state.meta.crateCells.forEach((c,i) => cc.appendChild(crateCard(c, state.meta.crateCells, i)));
  const cr = $('crateRefills');
  cr.innerHTML = '';
  state.meta.crateRefills.forEach((c,i) => cr.appendChild(crateCard(c, state.meta.crateRefills, i)));
}

export function initCrates(){
  $('addCrate').addEventListener('click', () => {
    const cells = state.meta.crateCells;
    const last = cells[cells.length-1];
    cells.push(last ? {...last} : {colour:0, rounds:50, chain:0, flags:1});
    renderCrates(); emit('meta');
  });
  $('addRefill').addEventListener('click', () => {
    state.meta.crateRefills.push({colour:-1, rounds:0, chain:0, flags:8});
    renderCrates(); emit('meta');
  });
  $('autoCrates').addEventListener('click', () => {
    const counts = colourCounts();
    const cells = [];
    for(let ci=0; ci<5; ci++){
      let need = counts[ci];
      while(need > 0){
        const r = Math.min(need, 55);
        cells.push({colour:ci, rounds:r, chain:0, flags:1});
        need -= r;
      }
    }
    if(!cells.length){ toast('No voxels to base crates on', true); return; }
    cells.sort((a,b) => (a.rounds%7)-(b.rounds%7) || a.colour-b.colour);  // interleave colours
    state.meta.crateCells = cells;
    renderCrates(); emit('meta');
    toast('Generated ' + cells.length + ' crate cells from voxel counts');
  });
}
