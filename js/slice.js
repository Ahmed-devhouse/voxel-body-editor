// Slice editor: a 2D cut through the model, along any axis.
//
//   top view (y)    stacking layers bottom-up, the way a body is built
//   front view (z)  an elevation — the view a source sprite is drawn in
//   side view (x)   the other elevation
//
// One coordinate mapping in state.js serves all three (sliceToCell), so every
// tool below is axis-agnostic.

import {
  state, sel, EMPTY, sliceIdx, sliceToCell, axisInfo,
  on, pushUndo, popUndo, emit,
} from './state.js';
import { colHex } from './palette.js';
import { sliceAction, sliceRect, sliceLine, setSlice } from './tools.js';

let cv, ctx, rangeEl, lblEl, occEl;
let hoverCell = null;
let painting = false, paintBtn = 0;
let strokeTool = null, strokeChanged = false;   // undo bookkeeping per gesture
let dragStart = null, dragEnd = null;           // rect/line drag state
let refImage = null;                            // tracing image, or null

export function initSlice(){
  cv = document.getElementById('sliceCanvas');
  ctx = cv.getContext('2d');
  rangeEl = document.getElementById('sliceRange');
  lblEl = document.getElementById('sliceLbl');
  occEl = document.getElementById('occ');

  rangeEl.addEventListener('input', e => setSlice(parseInt(e.target.value)));

  cv.addEventListener('pointerdown', onDown);
  cv.addEventListener('pointermove', onMove);
  cv.addEventListener('pointerup', onUp);
  cv.addEventListener('pointerleave', () => { hoverCell = null; draw(); });
  cv.addEventListener('contextmenu', e => e.preventDefault());

  const ro = new ResizeObserver(() => { fit(); draw(); });
  ro.observe(cv.parentElement);

  on('grid', () => { draw(); drawOcc(); });
  on('gridsize', () => { syncRange(); draw(); drawOcc(); });
  on('sel', () => { syncRange(); draw(); drawOcc(); });
  on('palette', draw);

  fit(); syncRange(); draw(); drawOcc();
}

/** A PNG to trace over, shown behind the grid. Pass null to clear it. */
export function setReferenceImage(img){
  refImage = img;
  draw();
}
export const hasReferenceImage = () => refImage !== null;

function fit(){
  const r = cv.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(r.width * dpr));
  cv.height = Math.max(1, Math.round(r.height * dpr));
}
function geom(){
  const dpr = window.devicePixelRatio || 1;
  const w = cv.width/dpr, h = cv.height/dpr, N = state.N;
  const cell = Math.max(4, Math.floor(Math.min(w,h)/(N+2)));
  return { cell, ox: Math.floor((w-cell*N)/2), oy: Math.floor((h-cell*N)/2), dpr, w, h, N };
}
function syncRange(){
  const info = axisInfo();
  rangeEl.max = state.N-1;
  rangeEl.value = sel.slice;
  lblEl.textContent = info.letter + ' ' + String(sel.slice).padStart(2,'0') + '/' + (state.N-1);
  const head = document.getElementById('sliceAxisLabel');
  if(head) head.textContent = info.title;
  document.querySelectorAll('[data-axis]').forEach(b =>
    b.classList.toggle('on', b.dataset.axis === sel.sliceAxis));
}

export function draw(){
  if(!ctx) return;
  const { cell, ox, oy, dpr, N } = geom();
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,cv.width,cv.height);
  ctx.fillStyle = '#101218';
  ctx.fillRect(ox-2, oy-2, cell*N+4, cell*N+4);

  // tracing image behind everything, fitted to the grid square
  if(refImage){
    ctx.globalAlpha = sel.refOpacity;
    const s = Math.min(cell*N/refImage.width, cell*N/refImage.height);
    const w = refImage.width*s, h = refImage.height*s;
    ctx.drawImage(refImage, ox + (cell*N-w)/2, oy + (cell*N-h)/2, w, h);
    ctx.globalAlpha = 1;
  }

  // onion skin: the slices either side, faint
  if(sel.onion){
    for(const ds of [-1,1]){
      const s = sel.slice+ds;
      if(s<0 || s>=N) continue;
      ctx.globalAlpha = 0.16;
      for(let r=0;r<N;r++) for(let c=0;c<N;c++){
        const v = state.colours[sliceIdx(c,r,s)];
        if(v===EMPTY) continue;
        ctx.fillStyle = colHex(v);
        ctx.fillRect(ox+c*cell+cell*0.3, oy+r*cell+cell*0.3, cell*0.4, cell*0.4);
      }
      ctx.globalAlpha = 1;
    }
  }
  // the current slice
  for(let r=0;r<N;r++) for(let c=0;c<N;c++){
    const i = sliceIdx(c,r,sel.slice);
    const v = state.colours[i];
    const px = ox+c*cell, py = oy+r*cell;
    if(v!==EMPTY){
      ctx.fillStyle = colHex(v);
      ctx.fillRect(px+1, py+1, cell-2, cell-2);
      ctx.fillStyle = 'rgba(255,255,255,.14)';
      ctx.fillRect(px+1, py+1, cell-2, Math.max(1, cell*0.18));
    }
    const u = state.units[i];
    if(u>0){
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(px+cell/2, py+cell/2, cell*0.3, 0, 7); ctx.stroke();
      if(cell>=14){
        ctx.fillStyle = '#fff';
        ctx.font = Math.floor(cell*0.38) + 'px ui-monospace, monospace';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(u), px+cell/2, py+cell/2+0.5);
      }
    }
  }
  // grid lines
  ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for(let k=0;k<=N;k++){
    ctx.moveTo(ox+k*cell+.5, oy); ctx.lineTo(ox+k*cell+.5, oy+N*cell);
    ctx.moveTo(ox, oy+k*cell+.5); ctx.lineTo(ox+N*cell, oy+k*cell+.5);
  }
  ctx.stroke();
  // symmetry guides, drawn on whichever screen axis carries x / z in this view
  drawSymmetryGuides(ctx, ox, oy, cell, N);
  // coords
  if(sel.coords){
    const info = axisInfo();
    ctx.fillStyle = 'rgba(139,147,163,.7)'; ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    for(let c=0;c<N;c++) ctx.fillText(c, ox+c*cell+cell/2, oy-8);
    ctx.fillText(info.cols, ox+N*cell+12, oy-8);
    ctx.textAlign='right';
    for(let r=0;r<N;r++) ctx.fillText(r, ox-6, oy+r*cell+cell/2);
    ctx.fillText(info.rows, ox-6, oy+N*cell+12);
  }
  // rect / line preview
  if(dragStart && dragEnd){
    ctx.fillStyle = 'rgba(255,255,255,.15)';
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    if(strokeTool === 'rect'){
      const [ac,bc] = dragStart.col<dragEnd.col ? [dragStart.col,dragEnd.col] : [dragEnd.col,dragStart.col];
      const [ar,br] = dragStart.row<dragEnd.row ? [dragStart.row,dragEnd.row] : [dragEnd.row,dragStart.row];
      ctx.fillRect(ox+ac*cell, oy+ar*cell, (bc-ac+1)*cell, (br-ar+1)*cell);
      ctx.strokeRect(ox+ac*cell+.5, oy+ar*cell+.5, (bc-ac+1)*cell-1, (br-ar+1)*cell-1);
    } else {
      ctx.beginPath();
      ctx.moveTo(ox+dragStart.col*cell+cell/2, oy+dragStart.row*cell+cell/2);
      ctx.lineTo(ox+dragEnd.col*cell+cell/2, oy+dragEnd.row*cell+cell/2);
      ctx.stroke();
    }
  }
  // hover, showing the whole brush footprint
  if(hoverCell) drawHover(ctx, ox, oy, cell, N);
}

function drawSymmetryGuides(ctx, ox, oy, cell, N){
  if(!sel.symX && !sel.symZ) return;
  const info = axisInfo();
  ctx.strokeStyle = 'rgba(255,201,60,.22)';
  const vline = () => { ctx.beginPath(); ctx.moveTo(ox+N*cell/2+.5, oy); ctx.lineTo(ox+N*cell/2+.5, oy+N*cell); ctx.stroke(); };
  const hline = () => { ctx.beginPath(); ctx.moveTo(ox, oy+N*cell/2+.5); ctx.lineTo(ox+N*cell, oy+N*cell/2+.5); ctx.stroke(); };
  if(sel.symX){ if(info.cols === 'x') vline(); else if(info.rows === 'x') hline(); }
  if(sel.symZ){ if(info.cols === 'z') vline(); else if(info.rows === 'z') hline(); }
}

function drawHover(ctx, ox, oy, cell, N){
  const r = sel.brush - 1;
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
  ctx.strokeRect(ox+(hoverCell.col-r)*cell+1, oy+(hoverCell.row-r)*cell+1,
                 (2*r+1)*cell-2, (2*r+1)*cell-2);
  // mirrored footprints, faint
  if(!sel.symX && !sel.symZ) return;
  const info = axisInfo();
  ctx.strokeStyle = 'rgba(255,255,255,.32)';
  const mirrorCol = () => ctx.strokeRect(ox+(N-1-hoverCell.col-r)*cell+1, oy+(hoverCell.row-r)*cell+1, (2*r+1)*cell-2, (2*r+1)*cell-2);
  const mirrorRow = () => ctx.strokeRect(ox+(hoverCell.col-r)*cell+1, oy+(N-1-hoverCell.row-r)*cell+1, (2*r+1)*cell-2, (2*r+1)*cell-2);
  if(sel.symX){ if(info.cols === 'x') mirrorCol(); else if(info.rows === 'x') mirrorRow(); }
  if(sel.symZ){ if(info.cols === 'z') mirrorCol(); else if(info.rows === 'z') mirrorRow(); }
}

function drawOcc(){
  if(!occEl) return;
  occEl.innerHTML = '';
  const N = state.N;
  let max = 1;
  const counts = [];
  for(let s=0; s<N; s++){
    let n = 0;
    for(let r=0;r<N;r++) for(let c=0;c<N;c++) if(state.colours[sliceIdx(c,r,s)]!==EMPTY) n++;
    counts.push(n); max = Math.max(max, n);
  }
  const letter = axisInfo().letter;
  counts.forEach((n, s) => {
    const b = document.createElement('i');
    b.style.height = Math.max(2, Math.round(n/max*18)) + 'px';
    if(s === sel.slice) b.classList.add('cur');
    b.title = letter + ' ' + s + ': ' + n + ' voxels';
    b.addEventListener('click', () => setSlice(s));
    occEl.appendChild(b);
  });
}

function cellFromEvent(e){
  const r = cv.getBoundingClientRect();
  const { cell, ox, oy, N } = geom();
  const col = Math.floor((e.clientX - r.left - ox)/cell);
  const row = Math.floor((e.clientY - r.top - oy)/cell);
  return (col>=0 && col<N && row>=0 && row<N) ? {col, row} : null;
}

// Undo pairing: one snapshot per stroke, pushed at gesture start and popped at
// gesture END if the whole stroke was a no-op. The tool is captured at
// pointerdown so a mid-gesture tool switch cannot unbalance the push/pop.
function onDown(e){
  const c = cellFromEvent(e);
  if(!c) return;
  cv.setPointerCapture(e.pointerId);
  paintBtn = e.button;
  strokeTool = sel.tool;
  if(strokeTool === 'pick'){
    sliceAction(c.col, c.row, false);   // mutates nothing
    return;
  }
  painting = true;
  strokeChanged = false;
  if(strokeTool === 'rect' || strokeTool === 'line'){
    dragStart = c; dragEnd = c; draw();
    return;
  }
  pushUndo();
  strokeChanged = sliceAction(c.col, c.row, paintBtn===2);
  emit('grid');
}
function onMove(e){
  const c = cellFromEvent(e);
  hoverCell = c;
  if(painting && c){
    if(strokeTool === 'rect' || strokeTool === 'line'){ dragEnd = c; draw(); return; }
    if(strokeTool==='paint' || strokeTool==='build' || strokeTool==='erase'){
      if(sliceAction(c.col, c.row, paintBtn===2)){
        strokeChanged = true;
        emit('grid');
      }
      return; // the 'grid' listener redraws
    }
  }
  draw();
}
function onUp(){
  if(!painting){ strokeTool = null; return; }
  painting = false;
  if(strokeTool === 'rect' || strokeTool === 'line'){
    if(dragStart && dragEnd){
      pushUndo();
      const changed = strokeTool === 'rect'
        ? sliceRect(dragStart.col, dragStart.row, dragEnd.col, dragEnd.row, paintBtn===2)
        : sliceLine(dragStart.col, dragStart.row, dragEnd.col, dragEnd.row, paintBtn===2);
      if(!changed) popUndo();
      emit('grid');
    }
    dragStart = dragEnd = null;
  } else if(!strokeChanged){
    popUndo();   // the entire stroke was a no-op
  }
  strokeTool = null;
  strokeChanged = false;
  draw();
}
