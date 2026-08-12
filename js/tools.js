// All edit operations. Both views (slice editor and 3D editor) funnel edits
// through here so symmetry, brush size, undo and events behave identically
// everywhere.

import {
  state, sel, clip, EMPTY, MIN_N, MAX_N, idx, sliceIdx, sliceToCell, cellToSlice, inBounds,
  pushUndo, popUndo, emit,
} from './state.js';
import { colourCount } from './palette.js';

export function setTool(t){
  sel.tool = t;
  if(t==='build'||t==='paint'||t==='fill'||t==='rect'||t==='line'||t==='unit') sel.lastColourTool = t;
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
export function setSliceAxis(axis){
  if(axis === sel.sliceAxis) return;
  sel.sliceAxis = axis;
  if(sel.slice >= state.N) sel.slice = state.N-1;
  emit('sel');
}
export function setBrush(n){
  sel.brush = Math.max(1, Math.min(4, n|0));
  emit('sel');
}

/* ---------- symmetry ---------- */
// mirrored (x,z) pairs for the enabled symmetry axes
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
/** Symmetry applies in world space, so map cell → mirrors → cells. */
function mirroredCells(x, y, z){
  return mirrors(x, z).map(([mx,mz]) => [mx, y, mz]);
}

/* ---------- brush ---------- */
// Offsets covering the brush footprint, in slice-view space so a brush is
// always a square patch of the plane you are looking at.
function brushOffsets(){
  const r = sel.brush - 1;
  const out = [];
  for(let dr=-r; dr<=r; dr++) for(let dc=-r; dc<=r; dc++) out.push([dc, dr]);
  return out;
}

function setCell(i, colour){ state.colours[i] = colour; if(colour===EMPTY) state.units[i] = 0; }

/* =====================================================================
   Slice editor actions. (col, row) are slice-view coords.
   Returns true if anything changed.
===================================================================== */
export function sliceAction(col, row, right){
  const s = sel.slice, N = state.N;
  let changed = false;

  if(sel.tool === 'pick'){
    const v = state.colours[sliceIdx(col, row, s)];
    if(v !== EMPTY && v < colourCount()) setColour(v);
    return false;
  }

  // fill is an area operation — the brush does not apply, and it works on the
  // slice plane rather than the 3D region
  if(sel.tool === 'fill'){
    const target = state.colours[sliceIdx(col, row, s)];
    const repl = right ? EMPTY : sel.colour;
    if(target === repl) return false;
    // Flood against a snapshot of the plane. Testing the live grid would let the
    // mirror writes below dam the flood at cells symmetry had already painted,
    // stopping short of the clicked region's real edge — and leaving a result
    // that is not even symmetric.
    const plane = new Uint8Array(N*N);
    for(let r=0;r<N;r++) for(let c=0;c<N;c++) plane[c + r*N] = state.colours[sliceIdx(c, r, s)];
    const q = [[col,row]];
    const seen = new Uint8Array(N*N);
    while(q.length){
      const [qc,qr] = q.pop();
      if(qc<0||qr<0||qc>=N||qr>=N) continue;
      const k = qc + qr*N;
      if(seen[k]) continue;
      seen[k] = 1;
      if(plane[k] !== target) continue;
      const [x,y,z] = sliceToCell(qc, qr, s);
      for(const [mx,my,mz] of mirroredCells(x,y,z)) setCell(idx(mx,my,mz), repl);
      changed = true;
      q.push([qc+1,qr],[qc-1,qr],[qc,qr+1],[qc,qr-1]);
    }
    return changed;
  }

  // Units mark one voxel at a time: they are individual gameplay pieces, not
  // paint, and stamping a brush-worth of them (and materialising a voxel under
  // each) is never what a click means. Matches hit3DAction's unit branch.
  if(sel.tool === 'unit'){
    const [ux,uy,uz] = sliceToCell(col, row, s);
    const kind = Math.max(1, sel.unitKind|0);
    const targets = mirroredCells(ux,uy,uz);
    const clicked = idx(ux,uy,uz);
    if(right){
      for(const [mx,my,mz] of targets){
        const i = idx(mx,my,mz);
        if(state.units[i]){ state.units[i] = 0; changed = true; }
      }
      return changed;
    }
    const turnOff = state.units[clicked] === kind;   // toggle decided by the clicked cell
    for(const [mx,my,mz] of targets){
      const i = idx(mx,my,mz);
      const nv = turnOff ? 0 : kind;
      if(state.units[i] !== nv){ state.units[i] = nv; changed = true; }
      if(nv !== 0 && state.colours[i] === EMPTY){ state.colours[i] = sel.colour; changed = true; }
    }
    return changed;
  }

  for(const [dc,dr] of brushOffsets()){
    const c = col+dc, r = row+dr;
    if(c<0||r<0||c>=N||r>=N) continue;
    const [x,y,z] = sliceToCell(c, r, s);
    for(const [mx,my,mz] of mirroredCells(x,y,z)){
      const i = idx(mx,my,mz);
      if(sel.tool === 'build' || sel.tool === 'paint'){
        const v = right ? EMPTY : sel.colour;
        if(state.colours[i] !== v){ setCell(i, v); changed = true; }
      } else if(sel.tool === 'erase'){
        if(state.colours[i] !== EMPTY || state.units[i]){ setCell(i, EMPTY); changed = true; }
      }
    }
  }
  return changed;
}

/** Rectangle fill in the current slice, inclusive corners (rect tool drag). */
export function sliceRect(c0, r0, c1, r1, right){
  const [ac, bc] = c0<c1 ? [c0,c1] : [c1,c0];
  const [ar, br] = r0<r1 ? [r0,r1] : [r1,r0];
  const v = right ? EMPTY : sel.colour;
  let changed = false;
  for(let r=ar; r<=br; r++) for(let c=ac; c<=bc; c++){
    const [x,y,z] = sliceToCell(c, r, sel.slice);
    for(const [mx,my,mz] of mirroredCells(x,y,z)){
      const i = idx(mx,my,mz);
      if(state.colours[i] !== v){ setCell(i, v); changed = true; }
    }
  }
  return changed;
}

/** Straight line between two slice cells (line tool drag), brush-thick. */
export function sliceLine(c0, r0, c1, r1, right){
  const steps = Math.max(Math.abs(c1-c0), Math.abs(r1-r0));
  const v = right ? EMPTY : sel.colour;
  let changed = false;
  const N = state.N;
  for(let k=0; k<=steps; k++){
    const t = steps === 0 ? 0 : k/steps;
    const cc = Math.round(c0 + (c1-c0)*t), rr = Math.round(r0 + (r1-r0)*t);
    for(const [dc,dr] of brushOffsets()){
      const c = cc+dc, r = rr+dr;
      if(c<0||r<0||c>=N||r>=N) continue;
      const [x,y,z] = sliceToCell(c, r, sel.slice);
      for(const [mx,my,mz] of mirroredCells(x,y,z)){
        const i = idx(mx,my,mz);
        if(state.colours[i] !== v){ setCell(i, v); changed = true; }
      }
    }
  }
  return changed;
}

/* =====================================================================
   3D editor actions. hit = {cell:[x,y,z], nb:[x,y,z]|null, floor:bool}
===================================================================== */
export function hit3DAction(hit, right){
  const cell = hit.cell;
  const ci = idx(cell[0], cell[1], cell[2]);

  if(sel.tool === 'pick'){
    if(!hit.floor){
      const v = state.colours[ci];
      if(v !== EMPTY && v < colourCount()) setColour(v);
    }
    return null;
  }

  pushUndo();
  let touched = null;

  // Brush footprint in the plane of the CLICKED FACE, not of the 2D view's axis:
  // a brush on a wall should spread across that wall, and one on the floor across
  // the floor, regardless of which slice view happens to be open.
  const faceAxis = (() => {
    if(hit.floor || !hit.nb) return 'y';                     // ground plane
    const dx = Math.abs(hit.nb[0] - cell[0]);
    const dy = Math.abs(hit.nb[1] - cell[1]);
    const dz = Math.abs(hit.nb[2] - cell[2]);
    return dy ? 'y' : dx ? 'x' : 'z';                        // spread ⟂ the face normal
  })();
  const patch = (p) => {
    if(sel.brush === 1) return [p];
    const { col, row, s } = cellToSlice(p[0], p[1], p[2], faceAxis);
    const out = [];
    const N = state.N;
    for(const [dc,dr] of brushOffsets()){
      const c = col+dc, r = row+dr;
      if(c<0||r<0||c>=N||r>=N) continue;
      out.push(sliceToCell(c, r, s, faceAxis));
    }
    return out;
  };
  const place = (p) => {
    if(!p || !inBounds(p[0],p[1],p[2])) return;
    for(const q of patch(p))
      for(const [mx,my,mz] of mirroredCells(q[0], q[1], q[2])){
        if(!inBounds(mx,my,mz)) continue;
        const ti = idx(mx,my,mz);
        if(state.colours[ti] === EMPTY){ state.colours[ti] = sel.colour; touched = [mx,my,mz]; }
      }
  };
  const remove = (p) => {
    for(const q of patch(p))
      for(const [mx,my,mz] of mirroredCells(q[0], q[1], q[2])){
        if(!inBounds(mx,my,mz)) continue;
        const ti = idx(mx,my,mz);
        if(state.colours[ti] !== EMPTY || state.units[ti]){ setCell(ti, EMPTY); touched = [mx,my,mz]; }
      }
  };

  if(sel.tool === 'build'){
    if(right){ if(!hit.floor) remove(cell); }
    else place(hit.floor ? cell : hit.nb);
  } else if(sel.tool === 'paint' || sel.tool === 'rect' || sel.tool === 'line'){
    if(hit.floor) place(cell);
    else if(right) remove(cell);
    else {
      for(const q of patch(cell))
        for(const [mx,my,mz] of mirroredCells(q[0], q[1], q[2])){
          if(!inBounds(mx,my,mz)) continue;
          const ti = idx(mx,my,mz);
          if(state.colours[ti] !== EMPTY && state.colours[ti] !== sel.colour){
            state.colours[ti] = sel.colour; touched = [mx,my,mz];
          }
        }
    }
  } else if(sel.tool === 'erase'){
    if(!hit.floor) remove(cell);
  } else if(sel.tool === 'unit'){
    if(!hit.floor){
      const kind = Math.max(1, sel.unitKind|0);
      const turnOff = state.units[ci] === kind;   // toggle decided by the clicked cell
      for(const [mx,my,mz] of mirroredCells(cell[0], cell[1], cell[2])){
        const ti = idx(mx,my,mz);
        if(state.colours[ti] === EMPTY) continue; // units live on voxels only
        const nv = turnOff ? 0 : kind;
        if(state.units[ti] !== nv){ state.units[ti] = nv; touched = [mx,my,mz]; }
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
   Slice-level operations — the everyday shortcuts of building by layers
===================================================================== */
function readSlice(s){
  const N = state.N;
  const colours = new Uint8Array(N*N), units = new Uint8Array(N*N);
  for(let r=0;r<N;r++) for(let c=0;c<N;c++){
    const i = sliceIdx(c, r, s);
    colours[c + r*N] = state.colours[i];
    units[c + r*N] = state.units[i];
  }
  return { colours, units };
}
function writeSlice(s, data){
  const N = state.N;
  for(let r=0;r<N;r++) for(let c=0;c<N;c++){
    const i = sliceIdx(c, r, s);
    state.colours[i] = data.colours[c + r*N];
    state.units[i] = data.units[c + r*N];
  }
}

export function copySlice(){
  const d = readSlice(sel.slice);
  clip.axis = sel.sliceAxis; clip.n = state.N;
  clip.colours = d.colours; clip.units = d.units;
  emit('sel');
  return true;
}
export function pasteSlice(){
  if(!clip.colours) return 'nothing copied yet';
  if(clip.n !== state.N) return `clipboard is ${clip.n}³, this model is ${state.N}³`;
  if(clip.axis !== sel.sliceAxis) return 'clipboard came from the ' + clip.axis + ' view';
  pushUndo();
  writeSlice(sel.slice, clip);
  emit('grid');
  return null;
}
/** Copies the current slice onto its neighbour and moves there — extruding by hand. */
export function duplicateSlice(dir){
  const target = sel.slice + (dir < 0 ? -1 : 1);
  if(target < 0 || target >= state.N) return 'no slice that way';
  pushUndo();
  writeSlice(target, readSlice(sel.slice));
  sel.slice = target;
  emit('grid'); emit('sel');
  return null;
}
export function clearSlice(){
  const N = state.N;
  const empty = { colours: new Uint8Array(N*N).fill(EMPTY), units: new Uint8Array(N*N) };
  const before = readSlice(sel.slice);
  if(before.colours.every(v => v === EMPTY)) return 'slice is already empty';
  pushUndo();
  writeSlice(sel.slice, empty);
  emit('grid');
  return null;
}
export function fillSlice(){
  const N = state.N;
  let changed = false;
  pushUndo();
  for(let r=0;r<N;r++) for(let c=0;c<N;c++){
    const i = sliceIdx(c, r, sel.slice);
    if(state.colours[i] !== sel.colour){ setCell(i, sel.colour); changed = true; }
  }
  if(!changed){ popUndo(); return 'slice is already that colour'; }
  emit('grid');
  return null;
}

/* =====================================================================
   Whole-model operations
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

/** Bounding box of the solid voxels, or null when the model is empty. */
export function bounds(){
  const N = state.N;
  let x0=N,y0=N,z0=N,x1=-1,y1=-1,z1=-1;
  for(let z=0;z<N;z++) for(let y=0;y<N;y++) for(let x=0;x<N;x++){
    if(state.colours[idx(x,y,z)] === EMPTY) continue;
    if(x<x0)x0=x; if(y<y0)y0=y; if(z<z0)z0=z;
    if(x>x1)x1=x; if(y>y1)y1=y; if(z>z1)z1=z;
  }
  return x1 < 0 ? null : {x0,y0,z0,x1,y1,z1};
}
/**
 * Centres the model horizontally and drops it onto the floor. The body sits on
 * y = 0 because that is what the game builds around, and off-centre bodies
 * frame badly once the shell is wrapped on.
 */
export function centreModel(){
  const b = bounds();
  if(!b) return 'model is empty';
  const N = state.N;
  const dx = Math.floor((N - 1 - (b.x1 + b.x0)) / 2);
  const dz = Math.floor((N - 1 - (b.z1 + b.z0)) / 2);
  const dy = -b.y0;
  if(dx === 0 && dy === 0 && dz === 0) return 'already centred on the floor';
  remap((x,y,z) => [x+dx, y+dy, z+dz]);
  return null;
}
/**
 * Shrinks the grid to the smallest cube that still holds the model (plus an
 * optional margin). Finer voxels are wasted resolution — every body spans the
 * same world size, so a tight grid means bigger, cleaner cubes in play.
 */
export function trimToContent(margin = 0){
  const b = bounds();
  if(!b) return 'model is empty';
  const span = Math.max(b.x1-b.x0, b.y1-b.y0, b.z1-b.z0) + 1 + 2*Math.max(0, margin);
  const nn = Math.max(MIN_N, Math.min(MAX_N, span));
  if(nn === state.N) return 'already tight';

  pushUndo();
  const on = state.N, oc = state.colours, ou = state.units;
  const nc = new Uint8Array(nn*nn*nn).fill(EMPTY);
  const nu = new Uint8Array(nn*nn*nn);
  // keep the model centred horizontally and on the floor in the new grid
  const offX = Math.floor((nn - (b.x1-b.x0+1))/2) - b.x0;
  const offZ = Math.floor((nn - (b.z1-b.z0+1))/2) - b.z0;
  const offY = -b.y0;
  for(let z=0;z<on;z++) for(let y=0;y<on;y++) for(let x=0;x<on;x++){
    const v = oc[(x*on+y)*on+z];
    if(v === EMPTY) continue;
    const tx=x+offX, ty=y+offY, tz=z+offZ;
    if(tx<0||ty<0||tz<0||tx>=nn||ty>=nn||tz>=nn) continue;
    nc[(tx*nn+ty)*nn+tz] = v;
    nu[(tx*nn+ty)*nn+tz] = ou[(x*on+y)*on+z];
  }
  state.N = nn; state.colours = nc; state.units = nu;
  if(sel.slice >= nn) sel.slice = nn-1;
  emit('gridsize'); emit('grid');
  return null;
}

/** Swaps every voxel of one colour for another. Returns how many changed. */
export function replaceColour(from, to){
  let n = 0;
  pushUndo();
  for(let i=0;i<state.colours.length;i++)
    if(state.colours[i] === from){ state.colours[i] = to; n++; }
  if(!n){ popUndo(); return 0; }
  emit('grid');
  return n;
}
/** Deletes every voxel of one colour. Returns how many went. */
export function deleteColour(c){
  let n = 0;
  pushUndo();
  for(let i=0;i<state.colours.length;i++)
    if(state.colours[i] === c){ setCell(i, EMPTY); n++; }
  if(!n){ popUndo(); return 0; }
  emit('grid');
  return n;
}
