// Central state + event bus. Every mutation flows through here so undo,
// autosave and all views stay consistent.

export const EMPTY = 255;
// VoxelBody.size is [Range(3, 24)] in Unity — stay inside the supported envelope
export const MIN_N = 3, MAX_N = 24;
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
  slice: 7,                 // height layer, 0 = bottom
  symX: false, symZ: false,
  onion: true, coords: false, hiLayer: false,
};

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
// layer editor: slice s = height layer y (0 = bottom), viewed from above.
// screen col = x (width), screen row = z (depth)
export const sliceIdx = (cx,cy,s) => (cx*state.N + s)*state.N + cy;
export const inBounds = (x,y,z) => x>=0 && y>=0 && z>=0 && x<state.N && y<state.N && z<state.N;

/* ---------- undo / redo ---------- */
const undoStack = [], redoStack = [];
const MAX_UNDO = 200;
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
  if(undoStack.length > MAX_UNDO) undoStack.shift();
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
export function resizeGrid(nn){
  nn = Math.max(MIN_N, Math.min(MAX_N, nn|0));
  if(nn === state.N) return false;
  pushUndo();
  const on = state.N, oc = state.colours, ou = state.units;
  const nc = new Uint8Array(nn*nn*nn).fill(EMPTY);
  const nu = new Uint8Array(nn*nn*nn);
  const off = Math.floor((nn-on)/2);
  for(let z=0; z<on; z++) for(let y=0; y<on; y++) for(let x=0; x<on; x++){
    const tx=x+off, ty=y+off, tz=z+off;
    if(tx<0||ty<0||tz<0||tx>=nn||ty>=nn||tz>=nn) continue;
    nc[tx+ty*nn+tz*nn*nn] = oc[x+y*on+z*on*on];
    nu[tx+ty*nn+tz*nn*nn] = ou[x+y*on+z*on*on];
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
