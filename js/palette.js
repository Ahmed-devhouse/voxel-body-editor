// Display palette for colour indices 0–4. Purely cosmetic — exports always
// write indices, never hex — but letting the team match the game's real
// colours makes design much easier. Persisted per browser.

import { EMPTY, emit } from './state.js';

export const DEFAULT_PALETTE = ['#ff5252','#4f8df9','#ffc93c','#4cd07d','#b06ef2'];
const LS_KEY = 'vbe-palette-v1';

export const PALETTE = load();

function load(){
  try{
    if(typeof localStorage === 'undefined') return DEFAULT_PALETTE.slice();
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if(Array.isArray(raw) && raw.length===5 && raw.every(c => /^#[0-9a-fA-F]{6}$/.test(c)))
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
  if(i<0 || i>4 || !/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  PALETTE[i] = hex.toLowerCase();
  save();
  emit('palette');
}
export function resetPalette(){
  for(let i=0;i<5;i++) PALETTE[i] = DEFAULT_PALETTE[i];
  save();
  emit('palette');
}

// null for empty, grey for out-of-range values (e.g. wildcards)
export function colHex(v){
  if(v === EMPTY) return null;
  return v < 5 ? PALETTE[v] : '#9aa2b1';
}
export function hexToRGB(hex){
  return [parseInt(hex.slice(1,3),16)/255, parseInt(hex.slice(3,5),16)/255, parseInt(hex.slice(5,7),16)/255];
}
export function nearestPaletteIndex(r, g, b){ // r,g,b 0..255
  let best = 0, bd = Infinity;
  for(let i=0;i<5;i++){
    const [pr,pg,pb] = hexToRGB(PALETTE[i]);
    const d = (r-pr*255)**2 + (g-pg*255)**2 + (b-pb*255)**2;
    if(d < bd){ bd = d; best = i; }
  }
  return best;
}
