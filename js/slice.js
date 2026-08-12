// Layer editor: horizontal slices viewed from above, bottom-up.
// Columns = data x, rows = data z. Slice slider + occupancy strip included.

import { state, sel, EMPTY, idx, sliceIdx, on, pushUndo, popUndo, emit } from './state.js';
import { colHex } from './palette.js';
import { sliceAction, sliceRect, setSlice } from './tools.js';

let cv, ctx, rangeEl, lblEl, occEl;
let hoverCell = null;
let painting = false, paintBtn = 0;
let strokeTool = null, strokeChanged = false;  // undo bookkeeping per gesture
let rectStart = null, rectEnd = null;   // rect tool drag state (slice coords)

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
  rangeEl.max = state.N-1;
  rangeEl.value = sel.slice;
  lblEl.textContent = 'y ' + String(sel.slice).padStart(2,'0') + '/' + (state.N-1);
}

export function draw(){
  if(!ctx) return;
  const { cell, ox, oy, dpr, N } = geom();
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,cv.width,cv.height);
  ctx.fillStyle = '#101218';
  ctx.fillRect(ox-2, oy-2, cell*N+4, cell*N+4);

  // onion skin: layer below/above, faint
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
  // current layer
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
  // symmetry guides
  if(sel.symX){
    ctx.strokeStyle = 'rgba(255,201,60,.22)';
    ctx.beginPath(); ctx.moveTo(ox+N*cell/2+.5, oy); ctx.lineTo(ox+N*cell/2+.5, oy+N*cell); ctx.stroke();
  }
  if(sel.symZ){
    ctx.strokeStyle = 'rgba(255,201,60,.22)';
    ctx.beginPath(); ctx.moveTo(ox, oy+N*cell/2+.5); ctx.lineTo(ox+N*cell, oy+N*cell/2+.5); ctx.stroke();
  }
  // coords
  if(sel.coords){
    ctx.fillStyle = 'rgba(139,147,163,.7)'; ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    for(let c=0;c<N;c++) ctx.fillText(c, ox+c*cell+cell/2, oy-8);
    ctx.textAlign='right';
    for(let r=0;r<N;r++) ctx.fillText(r, ox-6, oy+r*cell+cell/2);
  }
  // rect preview
  if(rectStart && rectEnd){
    const [ax,bx] = rectStart.x<rectEnd.x ? [rectStart.x,rectEnd.x] : [rectEnd.x,rectStart.x];
    const [az,bz] = rectStart.z<rectEnd.z ? [rectStart.z,rectEnd.z] : [rectEnd.z,rectStart.z];
    ctx.fillStyle = 'rgba(255,255,255,.15)';
    ctx.fillRect(ox+ax*cell, oy+az*cell, (bx-ax+1)*cell, (bz-az+1)*cell);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.strokeRect(ox+ax*cell+.5, oy+az*cell+.5, (bx-ax+1)*cell-1, (bz-az+1)*cell-1);
  }
  // hover
  if(hoverCell){
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.strokeRect(ox+hoverCell.x*cell+1, oy+hoverCell.z*cell+1, cell-2, cell-2);
    if(sel.symX){
      ctx.strokeStyle = 'rgba(255,255,255,.35)';
      ctx.strokeRect(ox+(N-1-hoverCell.x)*cell+1, oy+hoverCell.z*cell+1, cell-2, cell-2);
    }
    if(sel.symZ){
      ctx.strokeStyle = 'rgba(255,255,255,.35)';
      ctx.strokeRect(ox+hoverCell.x*cell+1, oy+(N-1-hoverCell.z)*cell+1, cell-2, cell-2);
    }
  }
}

function drawOcc(){
  if(!occEl) return;
  occEl.innerHTML = '';
  const N = state.N;
  let max = 1;
  const counts = [];
  for(let s=0; s<N; s++){
    const y = N-1-s;
    let n = 0;
    for(let z=0;z<N;z++) for(let x=0;x<N;x++) if(state.colours[idx(x,y,z)]!==EMPTY) n++;
    counts.push(n); max = Math.max(max, n);
  }
  counts.forEach((n, s) => {
    const b = document.createElement('i');
    b.style.height = Math.max(2, Math.round(n/max*18)) + 'px';
    if(s === sel.slice) b.classList.add('cur');
    b.title = 'layer ' + s + ': ' + n + ' voxels';
    b.addEventListener('click', () => setSlice(s));
    occEl.appendChild(b);
  });
}

function cellFromEvent(e){
  const r = cv.getBoundingClientRect();
  const { cell, ox, oy, N } = geom();
  const x = Math.floor((e.clientX - r.left - ox)/cell);
  const z = Math.floor((e.clientY - r.top - oy)/cell);
  return (x>=0 && x<N && z>=0 && z<N) ? {x, z} : null;
}

// Undo pairing: exactly one snapshot per stroke, pushed at gesture start and
// popped at gesture END if the whole stroke turned out to be a no-op. The tool
// is captured at pointerdown so mid-gesture tool switches (keyboard, or pick's
// own tool bounce) can never unbalance the push/pop.
function onDown(e){
  const c = cellFromEvent(e);
  if(!c) return;
  cv.setPointerCapture(e.pointerId);
  paintBtn = e.button;
  strokeTool = sel.tool;
  if(strokeTool === 'pick'){
    sliceAction(c.x, c.z, false);   // mutates nothing — no undo entry at all
    return;
  }
  painting = true;
  strokeChanged = false;
  if(strokeTool === 'rect'){ rectStart = c; rectEnd = c; draw(); return; }
  pushUndo();
  strokeChanged = sliceAction(c.x, c.z, paintBtn===2);
  emit('grid');
}
function onMove(e){
  const c = cellFromEvent(e);
  hoverCell = c;
  if(painting && c){
    if(strokeTool === 'rect'){ rectEnd = c; draw(); return; }
    if(strokeTool==='paint' || strokeTool==='build' || strokeTool==='erase'){
      if(sliceAction(c.x, c.z, paintBtn===2)){
        strokeChanged = true;
        emit('grid');
      }
      return; // 'grid' listener redraws
    }
  }
  draw();
}
function onUp(){
  if(!painting){ strokeTool = null; return; }
  painting = false;
  if(strokeTool === 'rect'){
    if(rectStart && rectEnd){
      pushUndo();
      if(!sliceRect(rectStart.x, rectStart.z, rectEnd.x, rectEnd.z, paintBtn===2)) popUndo();
      emit('grid');
    }
    rectStart = rectEnd = null;
  } else if(!strokeChanged){
    popUndo();   // entire stroke was a no-op
  }
  strokeTool = null;
  strokeChanged = false;
  draw();
}
