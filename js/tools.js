// All edit operations. Both views (layer editor and 3D editor) funnel edits
// through here so symmetry, undo and events behave identically everywhere.

import {
  state, sel, EMPTY, idx, sliceIdx, inBounds,
  pushUndo, popUndo, emit,
} from './state.js';

export function setTool(t){
  sel.tool = t;
  if(t==='build'||t==='paint'||t==='fill'||t==='rect'||t==='unit') sel.lastColourTool = t;
  emit('sel');
}
export function setColour(v){
  sel.colour = v;
  // choosing a colour must never leave a colour-using tool; only bounce out
  // of erase/pick, back to whichever colour tool was last active
  if(sel.tool==='erase' || sel.tool==='pick') sel.tool = sel.lastColourTool;
  emit('sel');
}
export function setSlice(s){
  sel.slice = Math.max(0, Math.min(state.N-1, s|0));
  emit('sel');
}

/* ---------- symmetry ---------- */
// returns the set of mirrored (x,z) pairs for the enabled symmetry axes
function mirrors(x, z){
  const N = state.N, out = [[x,z]];
  if(sel.symX && (N-1-x)!==x) out.push([N-1-x, z]);
  if(sel.symZ){
    const len = out.length;
    for(let i=0;i<len;i++){
      const [mx,mz] = out[i];
      if((N-1-mz)!==mz) out.push([mx, N-1-mz]);
    }
  }
  return out;
}

/* ---------- primitive cell edits (no undo/emit — callers batch them) ---------- */
function setCell(i, colour){ state.colours[i] = colour; if(colour===EMPTY) state.units[i] = 0; }

/* =====================================================================
   Layer editor actions. (cx, cy) are slice coords: col = x, row = z.
   Returns true if anything changed.
===================================================================== */
export function sliceAction(cx, cy, right){
  const s = sel.slice;
  let changed = false;
  const targets = mirrors(cx, cy);

  if(sel.tool === 'pick'){
    const v = state.colours[sliceIdx(cx, cy, s)];
    if(v !== EMPTY && v < 5) setColour(v);
    return false;
  }
  for(const [tx, tz] of targets){
    const i = sliceIdx(tx, tz, s);
    if(sel.tool === 'build' || sel.tool === 'paint'){
      const v = right ? EMPTY : sel.colour;
      if(state.colours[i] !== v){ setCell(i, v); changed = true; }
    } else if(sel.tool === 'erase'){
      if(state.colours[i] !== EMPTY || state.units[i]){ setCell(i, EMPTY); changed = true; }
    } else if(sel.tool === 'unit'){
      if(right){ if(state.units[i]){ state.units[i]=0; changed = true; } continue; }
      const kind = Math.max(1, sel.unitKind|0);
      const toggleOff = state.units[i] === kind && targets.length === 1;
      const nv = toggleOff ? 0 : kind;
      if(state.units[i] !== nv){ state.units[i] = nv; changed = true; }
      if(!toggleOff && state.colours[i] === EMPTY){ state.colours[i] = sel.colour; changed = true; } // a unit needs a voxel
    } else if(sel.tool === 'fill'){
      const target = state.colours[i];
      const repl = right ? EMPTY : sel.colour;
      if(target === repl) continue;
      const N = state.N, q = [[tx, tz]];
      while(q.length){
        const [qx, qz] = q.pop();
        if(qx<0||qz<0||qx>=N||qz>=N) continue;
        const qi = sliceIdx(qx, qz, s);
        if(state.colours[qi] !== target) continue;
        setCell(qi, repl);
        q.push([qx+1,qz],[qx-1,qz],[qx,qz+1],[qx,qz-1]);
      }
      changed = true;
    }
  }
  return changed;
}

// rectangle fill in the current layer, inclusive corners (rect tool drag)
export function sliceRect(x0, z0, x1, z1, right){
  const [ax, bx] = x0<x1 ? [x0,x1] : [x1,x0];
  const [az, bz] = z0<z1 ? [z0,z1] : [z1,z0];
  let changed = false;
  const v = right ? EMPTY : sel.colour;
  for(let z=az; z<=bz; z++) for(let x=ax; x<=bx; x++){
    for(const [tx,tz] of mirrors(x,z)){
      const i = sliceIdx(tx, tz, sel.slice);
      if(state.colours[i] !== v){ setCell(i, v); changed = true; }
    }
  }
  return changed;
}

/* =====================================================================
   3D editor actions. hit = {cell:[x,y,z], nb:[x,y,z]|null, floor:bool}
   nb = the empty cell adjacent to the clicked face (placement target).
===================================================================== */
export function hit3DAction(hit, right){
  const cell = hit.cell;
  const ci = idx(cell[0], cell[1], cell[2]);

  if(sel.tool === 'pick'){
    if(!hit.floor){
      const v = state.colours[ci];
      if(v !== EMPTY && v < 5) setColour(v);
    }
    return null;
  }

  pushUndo();
  let touched = null;

  const place = (p) => {
    if(!p || !inBounds(p[0],p[1],p[2])) return;
    for(const [mx,mz] of mirrors(p[0], p[2])){
      const ti = idx(mx, p[1], mz);
      if(state.colours[ti] === EMPTY){ state.colours[ti] = sel.colour; touched = [mx,p[1],mz]; }
    }
  };
  const remove = (p) => {
    for(const [mx,mz] of mirrors(p[0], p[2])){
      const ti = idx(mx, p[1], mz);
      if(state.colours[ti] !== EMPTY || state.units[ti]){ setCell(ti, EMPTY); touched = [mx,p[1],mz]; }
    }
  };

  if(sel.tool === 'build'){
    if(right){ if(!hit.floor) remove(cell); }
    else place(hit.floor ? cell : hit.nb);
  } else if(sel.tool === 'paint' || sel.tool === 'rect'){
    if(hit.floor) place(cell);
    else if(right) remove(cell);
    else {
      for(const [mx,mz] of mirrors(cell[0], cell[2])){
        const ti = idx(mx, cell[1], mz);
        if(state.colours[ti] !== EMPTY && state.colours[ti] !== sel.colour){
          state.colours[ti] = sel.colour; touched = [mx,cell[1],mz];
        }
      }
    }
  } else if(sel.tool === 'erase'){
    if(!hit.floor) remove(cell);
  } else if(sel.tool === 'unit'){
    if(!hit.floor){
      const kind = Math.max(1, sel.unitKind|0);
      const turnOff = state.units[ci] === kind;   // toggle decided by the clicked cell
      for(const [mx,mz] of mirrors(cell[0], cell[2])){
        const ti = idx(mx, cell[1], mz);
        if(state.colours[ti] === EMPTY) continue; // units live on voxels only
        const nv = turnOff ? 0 : kind;
        if(state.units[ti] !== nv){ state.units[ti] = nv; touched = [mx, cell[1], mz]; }
      }
    }
  } else if(sel.tool === 'fill'){
    // 3D flood recolour of the connected same-colour region
    if(!hit.floor){
      const target = state.colours[ci];
      if(target !== EMPTY && target !== sel.colour){
        const q = [cell.slice()];
        while(q.length){
          const [x,y,z] = q.pop();
          if(!inBounds(x,y,z)) continue;
          const qi = idx(x,y,z);
          if(state.colours[qi] !== target) continue;
          state.colours[qi] = sel.colour;
          q.push([x+1,y,z],[x-1,y,z],[x,y+1,z],[x,y-1,z],[x,y,z+1],[x,y,z-1]);
        }
        touched = cell.slice();
      }
    }
  }

  if(touched === null){ popUndo(); return null; }
  emit('grid');
  return touched;
}

/* =====================================================================
   Whole-model transforms
===================================================================== */
function remap(fn){
  pushUndo();
  const N = state.N;
  const nc = new Uint8Array(N*N*N).fill(EMPTY);
  const nu = new Uint8Array(N*N*N);
  for(let z=0; z<N; z++) for(let y=0; y<N; y++) for(let x=0; x<N; x++){
    const t = fn(x,y,z);
    if(!t) continue;
    const [tx,ty,tz] = t;
    if(!inBounds(tx,ty,tz)) continue;
    nc[idx(tx,ty,tz)] = state.colours[idx(x,y,z)];
    nu[idx(tx,ty,tz)] = state.units[idx(x,y,z)];
  }
  state.colours = nc; state.units = nu;
  emit('grid');
}
export function flip(axis){
  const N = state.N;
  remap((x,y,z) => axis==='x' ? [N-1-x,y,z] : axis==='y' ? [x,N-1-y,z] : [x,y,N-1-z]);
}
export function shiftGrid(axis, d){
  remap((x,y,z) => axis==='x' ? [x+d,y,z] : axis==='y' ? [x,y+d,z] : [x,y,z+d]);
}
export function rotateY(){
  const N = state.N;
  remap((x,y,z) => [N-1-z, y, x]);   // 90° about the vertical axis
}
export function hollow(){
  pushUndo();
  const N = state.N, c = state.colours;
  const interior = [];
  for(let z=1; z<N-1; z++) for(let y=1; y<N-1; y++) for(let x=1; x<N-1; x++){
    const i = idx(x,y,z);
    if(c[i] === EMPTY) continue;
    if(c[idx(x+1,y,z)]!==EMPTY && c[idx(x-1,y,z)]!==EMPTY &&
       c[idx(x,y+1,z)]!==EMPTY && c[idx(x,y-1,z)]!==EMPTY &&
       c[idx(x,y,z+1)]!==EMPTY && c[idx(x,y,z-1)]!==EMPTY) interior.push(i);
  }
  if(!interior.length){ popUndo(); return 0; }
  for(const i of interior) setCell(i, EMPTY);
  emit('grid');
  return interior.length;
}
export function clearAll(){
  pushUndo();
  state.colours.fill(EMPTY);
  state.units.fill(0);
  emit('grid');
}
