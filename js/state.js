// Central state + event bus. Every mutation flows through here so undo,
// autosave and all views stay consistent.

export const EMPTY = 255;

/* ---------- grid size ----------
   The asset stores a CUBE of `size`, so the build volume is always size³ —
   non-cubic grids are not expressible in the format.

   MAX_N is a MEMORY ceiling, not a design rule: nothing in the format or in the
   game caps the size (VoxelCore is written for a variable grid), so this is only
   about what a browser tab can hold. The grids are two byte-per-cell arrays, the
   undo history keeps snapshots of them, and an export writes size³ × 2 hex chars
   per grid — at 128³ that is ~4 MB live, and a ~17 MB .asset. Raise it if you
   need to; it is one number.                                                  */
export const MIN_N = 3, MAX_N = 128;
export const DEFAULT_GUID = '8154fcdcf86ef414a8a725fd872e9180';

export function defaultMeta(){
  return {
    name: 'NewBody', displayName: 'New Body',
    depth: 11, smoothness: 47, alphaThreshold: 0.347, greyToWildcard: 1,
    // stock defaults: crate grid off = the game's demand-weighted board;
    // CratePlan.DefaultRows = 3
    wrapInShell: 1, customCrateGrid: 0, crateRows: 3, misplayTolerance: 0,
    scriptGuid: DEFAULT_GUID,
    sourceImageRaw: '{fileID: 0}', sourceSliceRaw: '{fileID: 0}',
    // null = render with the game's shared Palette.cs. An array of
    // {r,g,b,a} means this body carries its own colours (VoxelBody.palette).
    palette: null,
    layerRules: [
      {layer:0, colour:2, percent:100}, {layer:1, colour:3, percent:100},
      {layer:2, colour:4, percent:100}, {layer:3, colour:0, percent:100},
      {layer:4, colour:1, percent:100},
    ],
    layerPatterns: [],
    unitRules: [
      {layer:0, kind:1, count:1}, {layer:1, kind:1, count:1},
      {layer:2, kind:1, count:1}, {layer:3, kind:1, count:1},
    ],
    crateCells: [],
    crateRefills: [
      {colour:-1, rounds:0, chain:0, flags:8}, {colour:-1, rounds:0, chain:0, flags:8},
      {colour:-1, rounds:0, chain:0, flags:8}, {colour:-1, rounds:0, chain:0, flags:8},
      {colour:-1, rounds:0, chain:0, flags:8},
    ],
  };
}

export const state = {
  N: 14,
  colours: new Uint8Array(14*14*14).fill(EMPTY),
  units: new Uint8Array(14*14*14),
  meta: defaultMeta(),
};

// UI selection state (not persisted in the asset)
export const sel = {
  tool: 'build', lastColourTool: 'build', colour: 2, unitKind: 1,
  slice: 7,                 // index along sliceAxis
  sliceAxis: 'y',           // 'y' top view, 'z' front view, 'x' side view
  brush: 1,                 // brush radius in cells: 1 = single cell, 2 = 3×3, 3 = 5×5
  symX: false, symZ: false,
  onion: true, coords: false, hiLayer: false, isolate: false,
  refOpacity: 0.35,         // tracing-image strength in the slice view
};

// Clipboard for layer copy/paste — {axis, n, colours, units}
export const clip = { axis: null, n: 0, colours: null, units: null };

/* ---------- events ---------- */
const bus = new EventTarget();
export function emit(type, detail){ bus.dispatchEvent(new CustomEvent(type, {detail})); }
export function on(type, fn){ bus.addEventListener(type, e => fn(e.detail)); }
// event types:
//  'grid'     voxel/unit data changed
//  'gridsize' N changed (views must rebuild geometry/sliders)
//  'meta'     meta fields changed
//  'sel'      tool/colour/slice/toggles changed
//  'palette'  display palette changed
//  'model'    a whole new model was loaded (name fields etc. need rebinding)

/* ---------- indexing ----------
   Matches Unity's VoxelCore.CellIdx(i,j,k,n) = (i*n + j)*n + k exactly, with the
   axis meanings verified against VoxelBodyGen + the ECS LevelBuilder:
     x = width  (world X, left–right; slowest axis)
     y = height (world Y, UP — y = 0 is the BOTTOM layer)
     z = depth  (world Z, front–back; fastest axis)                         */
export const idx = (x,y,z) => (x*state.N + y)*state.N + z;
export const inBounds = (x,y,z) => x>=0 && y>=0 && z>=0 && x<state.N && y<state.N && z<state.N;

/* ---------- slice views ----------
   The slice editor can cut along any axis. One mapping serves all three, so
   every tool works identically in each view:

     axis 'y'  top view    col = x, row = z,       slice = y   (row 0 = back)
     axis 'z'  front view  col = x, row = N-1-y,   slice = z   (row 0 = top)
     axis 'x'  side view   col = z, row = N-1-y,   slice = x   (row 0 = top)

   'y' keeps the bottom-up stacking the layer editor started with; 'z' and 'x'
   put row 0 at the top of the screen, which is how a front or side elevation
   reads.                                                                  */
export function sliceToCell(col, row, s, axis = sel.sliceAxis){
  const N = state.N;
  if(axis === 'z') return [col, N-1-row, s];
  if(axis === 'x') return [s, N-1-row, col];
  return [col, s, row];                       // 'y'
}
export function cellToSlice(x, y, z, axis = sel.sliceAxis){
  const N = state.N;
  if(axis === 'z') return { col: x, row: N-1-y, s: z };
  if(axis === 'x') return { col: z, row: N-1-y, s: x };
  return { col: x, row: z, s: y };            // 'y'
}
export function sliceIdx(col, row, s, axis = sel.sliceAxis){
  const [x,y,z] = sliceToCell(col, row, s, axis);
  return idx(x,y,z);
}
/** Human label for the current slice axis, used by the view header and slider. */
export function axisInfo(axis = sel.sliceAxis){
  if(axis === 'z') return { letter: 'z', title: 'front view, back → front', cols: 'x', rows: 'y' };
  if(axis === 'x') return { letter: 'x', title: 'side view, left → right',  cols: 'z', rows: 'y' };
  return { letter: 'y', title: 'top view, bottom → up', cols: 'x', rows: 'z' };
}

/* ---------- undo / redo ---------- */
const undoStack = [], redoStack = [];
const MAX_UNDO = 200;
// Snapshots are two byte-per-cell copies of the grid, so a deep history on a big
// grid is what would actually exhaust the tab: 200 × 128³ × 2 would be ~840 MB.
// The history is therefore bounded by BYTES as well as by count — at 14³ that is
// still the full 200 steps, and at 128³ it keeps as many as fit.
const MAX_UNDO_BYTES = 192 * 1024 * 1024;
function snapshotBytes(s){ return s.c.length + s.u.length; }
function trimHistory(){
  if(undoStack.length > MAX_UNDO) undoStack.splice(0, undoStack.length - MAX_UNDO);
  let bytes = 0;
  for(const s of undoStack) bytes += snapshotBytes(s);
  while(undoStack.length > 1 && bytes > MAX_UNDO_BYTES) bytes -= snapshotBytes(undoStack.shift());
}
/** How deep the undo history currently is — surfaced in the UI for big grids. */
export const undoDepth = () => undoStack.length;
// snapshots deep-copy meta too: model-replacing paths (import/new/library load)
// swap state.meta wholesale, and rules/crates mutate it in place — undo must
// restore the full model, not just the voxels.
function snapshot(){
  return {
    c: state.colours.slice(), u: state.units.slice(), n: state.N,
    m: JSON.parse(JSON.stringify(state.meta)),
  };
}
export function pushUndo(){
  undoStack.push(snapshot());
  trimHistory();
  redoStack.length = 0;
}
export function popUndo(){ undoStack.pop(); }     // for no-op edits
function restore(s){
  const sizeChanged = s.n !== state.N;
  state.N = s.n; state.colours = s.c.slice(); state.units = s.u.slice();
  state.meta = JSON.parse(JSON.stringify(s.m));
  if(sel.slice >= state.N) sel.slice = state.N - 1;
  if(sizeChanged) emit('gridsize');
  emit('grid');
  emit('meta'); emit('model');   // rebind name fields, rules/crates panels
}
export function undo(){ if(!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); }
export function redo(){ if(!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); }
export function clearHistory(){ undoStack.length = 0; redoStack.length = 0; }

/* ---------- grid ops ---------- */
export function setGrid(n, colours, units){
  const sizeChanged = n !== state.N;
  state.N = n;
  state.colours = colours;
  state.units = units || new Uint8Array(n*n*n);
  if(sel.slice >= n) sel.slice = n-1;
  if(sizeChanged) emit('gridsize');
  emit('grid');
}
/** Bounding box of the solid voxels in the CURRENT grid, or null when empty. */
export function contentBounds(){
  const N = state.N;
  let x0=N,y0=N,z0=N,x1=-1,y1=-1,z1=-1;
  for(let z=0;z<N;z++) for(let y=0;y<N;y++) for(let x=0;x<N;x++){
    if(state.colours[(x*N+y)*N+z] === EMPTY) continue;
    if(x<x0)x0=x; if(y<y0)y0=y; if(z<z0)z0=z;
    if(x>x1)x1=x; if(y>y1)y1=y; if(z>z1)z1=z;
  }
  return x1 < 0 ? null : {x0,y0,z0,x1,y1,z1};
}
/**
 * Does the model still fit after resizing to `nn`? Only false when the content's
 * own span exceeds the new grid, i.e. when voxels genuinely have to be cut.
 */
export function resizeWouldClip(nn){
  const b = contentBounds();
  if(!b) return false;
  return (b.x1-b.x0+1) > nn || (b.y1-b.y0+1) > nn || (b.z1-b.z0+1) > nn;
}
export function resizeGrid(nn){
  nn = Math.max(MIN_N, Math.min(MAX_N, nn|0));
  if(nn === state.N) return false;
  pushUndo();
  const on = state.N, oc = state.colours, ou = state.units;
  const nc = new Uint8Array(nn*nn*nn).fill(EMPTY);
  const nu = new Uint8Array(nn*nn*nn);

  // Keep the model's position relative to the grid centre, but clamp the shift so
  // content that FITS is never cut. Plain centring loses a model resting on the
  // floor when shrinking (y0 would go negative), which is exactly where bodies sit.
  const b = contentBounds();
  let ox = Math.floor((nn-on)/2), oy = ox, oz = ox;
  if(b){
    const fit = (off, lo, hi) => Math.max(-lo, Math.min(nn-1-hi, off));
    if((b.x1-b.x0+1) <= nn) ox = fit(ox, b.x0, b.x1);
    if((b.y1-b.y0+1) <= nn) oy = fit(oy, b.y0, b.y1);
    if((b.z1-b.z0+1) <= nn) oz = fit(oz, b.z0, b.z1);
  }
  for(let z=0; z<on; z++) for(let y=0; y<on; y++) for(let x=0; x<on; x++){
    const tx=x+ox, ty=y+oy, tz=z+oz;
    if(tx<0||ty<0||tz<0||tx>=nn||ty>=nn||tz>=nn) continue;
    nc[(tx*nn+ty)*nn+tz] = oc[(x*on+y)*on+z];
    nu[(tx*nn+ty)*nn+tz] = ou[(x*on+y)*on+z];
  }
  setGrid(nn, nc, nu);
  return true;
}

export function voxelCount(){
  let n=0;
  for(let i=0;i<state.colours.length;i++) if(state.colours[i]!==EMPTY) n++;
  return n;
}
export function unitCount(){
  let n=0;
  for(let i=0;i<state.units.length;i++) if(state.units[i]>0) n++;
  return n;
}

/* ---------- (de)serialization for the library / autosave ---------- */
function b64FromBytes(a){
  let s='';
  for(let i=0;i<a.length;i+=0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i+0x8000));
  return btoa(s);
}
function bytesFromB64(s){
  const bin = atob(s), a = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) a[i] = bin.charCodeAt(i);
  return a;
}
export function serialize(){
  return {
    v: 1,
    N: state.N,
    colours: b64FromBytes(state.colours),
    units: b64FromBytes(state.units),
    meta: JSON.parse(JSON.stringify(state.meta)),
  };
}
export function deserialize(obj){
  if(!obj || obj.v !== 1 || !obj.N || !obj.colours) throw new Error('Unrecognised saved model');
  const n = obj.N;
  const colours = bytesFromB64(obj.colours);
  const units = obj.units ? bytesFromB64(obj.units) : new Uint8Array(n*n*n);
  if(colours.length !== n*n*n) throw new Error('Saved model is corrupt (grid size mismatch)');
  state.meta = Object.assign(defaultMeta(), obj.meta || {});
  setGrid(n, colours, units.length === n*n*n ? units : new Uint8Array(n*n*n));
  emit('meta'); emit('model');
}
