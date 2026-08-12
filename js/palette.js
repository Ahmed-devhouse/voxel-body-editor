// The colour palette.
//
// Colour indices are what the .asset stores, so the palette is not merely
// cosmetic — index 0 IS the game's Y. The first six entries mirror the Unity
// project exactly (Cols / Palette.cs):
//
//   0 Y yellow  1 O orange  2 R red  3 G green  4 B blue  5 X grey wildcard
//
// Indices 0-4 are the crate colours (Cols.CrateColourCount); X is destroyed by
// a bullet of any colour (VoxelCore.Matches).
//
// You can add colours past those six here, and the editor will let you paint
// and export them — but the CURRENT game build cannot: Palette.Of renders
// anything >= 6 magenta, and since crates only ever mint 0-4 such a voxel can
// never be shot, which makes the level unwinnable. So extra colours are marked
// "beyond the game build" and the Stats tab reports them as an error until the
// Unity side is extended (Palette.Colours, Cols, and CrateColourCount if the
// new colour should be shootable). GAME_COLOURS below is the one number to
// raise once that happens.

import { EMPTY, emit, state } from './state.js';

/** How many colours the shipped game understands. Raise once Unity is extended. */
export const GAME_COLOURS = 6;
/** Colours crates can carry: Cols.CrateColourCount. */
export const CRATE_COLOURS = 5;
/** 255 is "empty", so an index can never reach it. */
export const MAX_COLOURS = 32;

const STOCK = [
  { hex: '#e8c93a', label: 'Y', name: 'yellow' },
  { hex: '#f5920b', label: 'O', name: 'orange' },
  { hex: '#e5484d', label: 'R', name: 'red' },
  { hex: '#46c93c', label: 'G', name: 'green' },
  { hex: '#3a7bf0', label: 'B', name: 'blue' },
  { hex: '#9a9a9a', label: 'X', name: 'grey wildcard' },
];
const LS_KEY = 'vbe-palette-v3';

/** Live palette: array of {hex, label, name}. Index === the exported colour byte. */
export const PALETTE = load();

function clean(e, i){
  const hex = /^#[0-9a-fA-F]{6}$/.test(e && e.hex) ? e.hex.toLowerCase() : '#888888';
  const label = (e && typeof e.label === 'string' && e.label.trim())
    ? e.label.trim().slice(0, 3) : 'c' + i;
  const name = (e && typeof e.name === 'string' && e.name.trim()) ? e.name.trim() : label;
  return { hex, label, name };
}
function load(){
  try{
    if(typeof localStorage === 'undefined') return STOCK.map(e => ({...e}));
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if(Array.isArray(raw) && raw.length >= GAME_COLOURS && raw.length <= MAX_COLOURS)
      return raw.map(clean);
  }catch{ /* ignore */ }
  return STOCK.map(e => ({...e}));
}
function save(){
  try{
    if(typeof localStorage !== 'undefined') localStorage.setItem(LS_KEY, JSON.stringify(PALETTE));
  }catch{ /* ignore */ }
}

export const colourCount = () => PALETTE.length;
export const labelOf = i => (PALETTE[i] ? PALETTE[i].label : 'c' + i);
export const nameOf = i => (PALETTE[i] ? PALETTE[i].name : 'colour ' + i);
/** True for a colour this game build cannot render or hit. */
export const isBeyondGame = i => i >= GAME_COLOURS;

/* ---------- the palette travels with the model ----------
   A voxel stores a colour INDEX, because that index is what a bullet matches on
   (VoxelCore.Matches) and what crates are minted in — it can never be an RGB
   value. What each index LOOKS like is a separate question, and the asset answers
   it: VoxelBody.palette holds one Color32 per index, so the colours a designer
   picks here ship with the body instead of needing an edit to Palette.cs.

   meta.palette stays null until a colour is actually customised. That keeps every
   asset that uses the shared art palette exporting byte-for-byte as imported. */
const hexToRGB255 = hex => ({
  r: parseInt(hex.slice(1,3),16), g: parseInt(hex.slice(3,5),16),
  b: parseInt(hex.slice(5,7),16), a: 255,
});
const rgbToHex = c => '#' +
  [c.r,c.g,c.b].map(v => Math.max(0, Math.min(255, v|0)).toString(16).padStart(2,'0')).join('');

/** Writes the live palette onto the model, so an export carries it. */
export function commitPaletteToModel(){
  state.meta.palette = PALETTE.map(e => hexToRGB255(e.hex));
  emit('meta');
}
/** True when this model carries its own colours rather than the game's defaults. */
export const modelCarriesPalette = () => Array.isArray(state.meta.palette) && state.meta.palette.length > 0;

/** Adopts the loaded model's palette, or falls back to the stock six. */
export function adoptModelPalette(){
  const p = state.meta.palette;
  PALETTE.length = 0;
  if(Array.isArray(p) && p.length){
    p.forEach((c, i) => PALETTE.push(clean({
      hex: rgbToHex(c),
      label: (STOCK[i] && STOCK[i].label) || ('c' + i),
    }, i)));
  } else {
    for(const e of STOCK) PALETTE.push({...e});
  }
  emit('palette');
}
/** Drops the model's own palette; it renders with the game's Palette.cs again. */
export function clearModelPalette(){
  state.meta.palette = null;
  adoptModelPalette();
  emit('meta');
}

export function setPaletteColour(i, hex){
  if(i < 0 || i >= PALETTE.length || !/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  PALETTE[i].hex = hex.toLowerCase();
  save();
  commitPaletteToModel();       // a hand-picked colour is part of the model now
  emit('palette');
}
export function setPaletteLabel(i, label){
  if(i < 0 || i >= PALETTE.length) return;
  const t = String(label || '').trim().slice(0, 3);
  PALETTE[i].label = t || ('c' + i);
  PALETTE[i].name = PALETTE[i].label;
  save(); emit('palette');
}
/** Appends a colour and returns its index, or -1 when the cap is reached. */
export function addPaletteColour(hex){
  if(PALETTE.length >= MAX_COLOURS) return -1;
  const i = PALETTE.length;
  PALETTE.push(clean({ hex: hex || spread(i), label: 'c' + i }, i));
  save();
  commitPaletteToModel();       // an extra colour only exists if the asset says so
  emit('palette');
  return i;
}
/**
 * Drops the last colour. Only ever the last one, and only past the stock six:
 * removing from the middle would renumber every later index and silently
 * repaint every voxel that used them.
 */
export function removeLastPaletteColour(){
  if(PALETTE.length <= GAME_COLOURS) return false;
  PALETTE.pop();
  save();
  if(modelCarriesPalette()) commitPaletteToModel();
  emit('palette');
  return true;
}
/** Back to the game's six, and back to rendering with the shared Palette.cs. */
export function resetPalette(){
  PALETTE.length = 0;
  for(const e of STOCK) PALETTE.push({...e});
  save();
  state.meta.palette = null;
  emit('meta'); emit('palette');
}

/** A readable default for a new swatch: evenly spaced hues, mid saturation. */
function spread(i){
  const h = (i * 47) % 360, s = 0.62, l = 0.55;
  const c = (1 - Math.abs(2*l - 1)) * s;
  const x = c * (1 - Math.abs(((h/60) % 2) - 1));
  const m = l - c/2;
  const [r,g,b] = h<60?[c,x,0]:h<120?[x,c,0]:h<180?[0,c,x]:h<240?[0,x,c]:h<300?[x,0,c]:[c,0,x];
  const hx = v => Math.round((v+m)*255).toString(16).padStart(2,'0');
  return '#' + hx(r) + hx(g) + hx(b);
}

/** null for empty; magenta for a byte with no palette entry (mirrors Palette.Of). */
export function colHex(v){
  if(v === EMPTY) return null;
  return (v < PALETTE.length) ? PALETTE[v].hex : '#ff00ff';
}
export function hexToRGB(hex){
  return [parseInt(hex.slice(1,3),16)/255, parseInt(hex.slice(3,5),16)/255, parseInt(hex.slice(5,7),16)/255];
}
/**
 * Nearest palette index for an r,g,b (0-255) — used by the .vox importer.
 * Only ever maps into colours the game supports, and sends low-saturation
 * colours to X (index 5) the way the Unity baker's greyToWildcard does.
 */
export function nearestPaletteIndex(r, g, b){
  const mx = Math.max(r,g,b), mn = Math.min(r,g,b);
  if(mx - mn < 28 && GAME_COLOURS > 5) return 5;
  let best = 0, bd = Infinity;
  for(let i=0;i<Math.min(CRATE_COLOURS, PALETTE.length);i++){
    const [pr,pg,pb] = hexToRGB(PALETTE[i].hex);
    const d = (r-pr*255)**2 + (g-pg*255)**2 + (b-pb*255)**2;
    if(d < bd){ bd = d; best = i; }
  }
  return best;
}
