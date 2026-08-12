// Crate economy editor. Mirrors the game's CratePlan exactly:
//   - the board is 5 columns (CratePlan.DefaultColumns) × crateRows rows,
//     stored column-major: index = column * crateRows + row; row 0 = the
//     front (tappable) crate of its column
//   - crateRefills = one template per column, applied forever once the
//     opening board runs out; the Empty flag (1<<3) = that column never refills
//   - flags: 0 Auto, 1 Plain, 2 Concealed, 4 Chained, 8 Empty (bit field)
//   - crates carry colours 0–4 (Y O R G B) or −1 = demand-weighted

import { state, emit, EMPTY } from './state.js';
import { PALETTE, COLOUR_LABELS, CRATE_COLOURS } from './palette.js';
import { toast } from './ui.js';

const $ = id => document.getElementById(id);
export const CRATE_COLUMNS = 5;
const FLAG_BITS = [
  ['P', 1, 'Plain — explicitly no concealment or chain'],
  ['C', 2, 'Concealed — colour hidden until the crate reaches the front row'],
  ['K', 4, 'Chained — untappable until chains break (strength = chain field)'],
  ['E', 8, 'Empty — an authored hole; for a refill: this column never refills'],
];
const autoCell = () => ({colour:-1, rounds:0, chain:0, flags:0});

function colourOptions(selVal){
  let h = `<option value="-1" ${selVal===-1?'selected':''}>any</option>`;
  for(let i=0;i<CRATE_COLOURS;i++)
    h += `<option value="${i}" ${selVal===i?'selected':''}>${COLOUR_LABELS[i]}</option>`;
  return h;
}

function ensureLength(list, n){
  while(list.length < n) list.push(autoCell());
  return list;
}

// crateRows changed: the array stride changes, so remap column contents to the
// new stride instead of letting every crate silently shift columns
export function remapRows(oldRows, newRows){
  if(oldRows === newRows) return;
  const old = state.meta.crateCells;
  if(!old.length) return;   // nothing authored — nothing to remap
  const next = [];
  for(let c=0; c<CRATE_COLUMNS; c++)
    for(let r=0; r<newRows; r++){
      const i = c*oldRows + r;
      next.push(r < oldRows && i < old.length ? old[i] : autoCell());
    }
  state.meta.crateCells = next;
}

// A slot beyond the stored array renders as Auto and is only written into the
// asset when actually edited — a pure import → export stays byte-identical
// even when the stored board is shorter than columns × rows.
function slotCard(list, i, rowLabel){
  const stored = i < list.length;
  const cell = stored ? list[i] : autoCell();
  const commit = () => { if(list[i] !== cell){ ensureLength(list, i); list[i] = cell; } };
  const d = document.createElement('div');
  d.className = 'crateCell';
  const sw = cell.colour>=0 && cell.colour<CRATE_COLOURS ? PALETTE[cell.colour] : '#5b6272';
  d.innerHTML = `<span class="idx">${rowLabel}</span>
    <div class="row"><span class="cswatch" style="background:${sw}"></span><select data-k="colour" title="Crate colour">${colourOptions(cell.colour)}</select></div>
    <div class="row"><label>rnd</label><input type="number" value="${cell.rounds}" min="0" data-k="rounds" title="Rounds this crate carries; 0 = game default"></div>
    <div class="row"><label>chn</label><input type="number" value="${cell.chain}" min="0" data-k="chain" title="Chain strength when Chained; 0 = rolled"></div>
    <div class="flagRow">${FLAG_BITS.map(([l,b,t]) =>
      `<button class="fbit${cell.flags & b ? ' on':''}" data-bit="${b}" title="${t}">${l}</button>`).join('')}</div>
    <button class="kill" title="Reset this slot to Auto">reset</button>`;
  d.querySelectorAll('[data-k]').forEach(el => el.addEventListener('change', () => {
    commit();
    cell[el.dataset.k] = parseInt(el.value) || 0;
    if(el.dataset.k === 'colour') renderCrates();
    emit('meta');
  }));
  d.querySelectorAll('.fbit').forEach(el => el.addEventListener('click', () => {
    commit();
    cell.flags ^= parseInt(el.dataset.bit);
    el.classList.toggle('on', !!(cell.flags & parseInt(el.dataset.bit)));
    emit('meta');
  }));
  d.querySelector('.kill').addEventListener('click', () => {
    // test the array live: commit() may have materialised this slot since render
    if(i < list.length){ Object.assign(list[i], autoCell()); emit('meta'); }
    renderCrates();
  });
  return d;
}

export function renderCrates(){
  const cc = $('crateCells');
  if(!cc) return;
  cc.innerHTML = '';
  if(!state.meta.customCrateGrid){
    cc.innerHTML = '<p class="note" style="grid-column:1/-1;margin:0">Custom crate grid is off — the game rolls the stock demand-weighted board. Turn it on above (or use auto-fill) to author crates.</p>';
    $('crateRefills').innerHTML = '';
    return;
  }
  const rows = Math.max(1, state.meta.crateRows|0);
  for(let c=0; c<CRATE_COLUMNS; c++){
    const col = document.createElement('div');
    col.className = 'crateCol';
    col.innerHTML = `<div class="colHead">col ${c+1}</div>`;
    for(let r=0; r<rows; r++)
      col.appendChild(slotCard(state.meta.crateCells, c*rows + r, r===0 ? 'front' : 'r'+r));
    cc.appendChild(col);
  }
  const cr = $('crateRefills');
  cr.innerHTML = '';
  for(let c=0; c<CRATE_COLUMNS; c++){
    const col = document.createElement('div');
    col.className = 'crateCol';
    col.innerHTML = `<div class="colHead">col ${c+1}</div>`;
    col.appendChild(slotCard(state.meta.crateRefills, c, '∞'));
    cr.appendChild(col);
  }
}

export function initCrates(){
  $('autoCrates').addEventListener('click', () => {
    state.meta.customCrateGrid = 1;   // authoring a board implies using it
    const fCG = $('fCustomGrid');
    if(fCG) fCG.checked = true;
    const rows = Math.max(1, state.meta.crateRows|0);
    const total = CRATE_COLUMNS * rows;
    // demand per colour: own voxels + an even share of the X wildcards
    const counts = [0,0,0,0,0];
    let wild = 0;
    for(let i=0;i<state.colours.length;i++){
      const v = state.colours[i];
      if(v === EMPTY) continue;
      if(v < CRATE_COLOURS) counts[v]++;
      else if(v === 5) wild++;
    }
    const need = counts.map(n => n + wild/CRATE_COLOURS);
    const totalNeed = need.reduce((a,b)=>a+b, 0);
    if(totalNeed <= 0){ toast('No voxels to base crates on', true); return; }
    // give each present colour at least one crate, distribute the rest by share
    const slots = need.map(n => n > 0 ? 1 : 0);
    let used = slots.reduce((a,b)=>a+b, 0);
    // hand each extra slot to whichever colour currently carries the most
    // rounds per crate — evens out the per-crate load across colours
    while(used < total){
      let best = 0, bd = -1;
      for(let i=0;i<CRATE_COLOURS;i++){
        const score = slots[i] ? need[i]/slots[i] : need[i];
        if(score > bd){ bd = score; best = i; }
      }
      slots[best]++; used++;
    }
    const cells = [];
    for(let i=0;i<CRATE_COLOURS;i++){
      if(!slots[i]) continue;
      const per = Math.ceil(need[i]/slots[i]);
      // Plain, never Auto: CratePlan.CellAt makes an Auto cell inherit its
      // column refill's flags, and a refill carrying Empty would turn every
      // generated crate into a hole. CratePlanGenerator writes Plain too.
      for(let s=0;s<slots[i];s++) cells.push({colour:i, rounds:per, chain:0, flags:1});
    }
    // interleave colours so no column is one colour top to bottom
    cells.sort((a,b) => (a.rounds%7)-(b.rounds%7) || a.colour-b.colour);
    state.meta.crateCells = cells.slice(0, total);
    ensureLength(state.meta.crateCells, total);
    renderCrates(); emit('meta');
    toast('Filled ' + total + ' crates from voxel demand (flags left on Auto)');
  });
}
