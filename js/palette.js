// Display palette for the game's colour indices. These defaults are the
// art-approved palette from the Unity project (Palette.cs, spec §3):
//   0 Y yellow, 1 O orange, 2 R red, 3 G green, 4 B blue, 5 X grey wildcard.
// Editing them here is purely cosmetic — exports always write indices —
// but matching the game makes design honest. Persisted per browser.

import { EMPTY, emit } from './state.js';

export const DEFAULT_PALETTE = ['#e8c93a','#f5920b','#e5484d','#46c93c','#3a7bf0','#9a9a9a'];
export const COLOUR_LABELS = ['Y','O','R','G','B','X'];
export const COLOUR_NAMES = ['yellow','orange','red','green','blue','grey wildcard'];
export const COLOUR_COUNT = 6;      // paintable voxel colours (X included)
export const CRATE_COLOURS = 5;     // crates carry Y O R G B only (Cols.CrateColourCount)
const LS_KEY = 'vbe-palette-v2';

export const PALETTE = load();

function load(){
  try{
    if(typeof localStorage === 'undefined') return DEFAULT_PALETTE.slice();
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if(Array.isArray(raw) && raw.length===COLOUR_COUNT && raw.every(c => /^#[0-9a-fA-F]{6}$/.test(c)))
      return raw.slice();
  }catch{ /* ignore */ }
  return DEFAULT_PALETTE.slice();
}
function save(){
  try{
    if(typeof localStorage !== 'undefined') localStorage.setItem(LS_KEY, JSON.stringify(PALETTE));
  }catch{ /* ignore */ }
}

export function setPaletteColour(i, hex){
  if(i<0 || i>=COLOUR_COUNT || !/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  PALETTE[i] = hex.toLowerCase();
  save();
  emit('palette');
}
export function resetPalette(){
  for(let i=0;i<COLOUR_COUNT;i++) PALETTE[i] = DEFAULT_PALETTE[i];
  save();
  emit('palette');
}

// null for empty; magenta-ish fallback for unknown values (mirrors Palette.Of)
export function colHex(v){
  if(v === EMPTY) return null;
  return v < COLOUR_COUNT ? PALETTE[v] : '#ff00ff';
}
export function hexToRGB(hex){
  return [parseInt(hex.slice(1,3),16)/255, parseInt(hex.slice(3,5),16)/255, parseInt(hex.slice(5,7),16)/255];
}
// nearest paintable colour for an r,g,b (0..255); near-grey pixels snap to X
export function nearestPaletteIndex(r, g, b){
  const mx = Math.max(r,g,b), mn = Math.min(r,g,b);
  if(mx - mn < 28) return 5;                 // low saturation → grey wildcard
  let best = 0, bd = Infinity;
  for(let i=0;i<CRATE_COLOURS;i++){
    const [pr,pg,pb] = hexToRGB(DEFAULT_PALETTE[i]);
    const d = (r-pr*255)**2 + (g-pg*255)**2 + (b-pb*255)**2;
    if(d < bd){ bd = d; best = i; }
  }
  return best;
}
