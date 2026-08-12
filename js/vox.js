// MagicaVoxel .vox importer. Reads the first model of a .vox file and maps
// each voxel's palette colour to the nearest of the 5 game colour indices.
// Format: https://github.com/ephtracy/voxel-model/blob/master/MagicaVoxel-file-format-vox.txt

import { EMPTY, MAX_N, MIN_N } from './state.js';
import { PALETTE, hexToRGB } from './palette.js';

// MagicaVoxel's default palette (used when the file has no RGBA chunk).
// Generated the same way MagicaVoxel does: 6-level RGB cube + ramps.
function defaultPalette(){
  const p = [[0,0,0,0]];
  const lv = [255,204,153,102,51,0];
  for(const r of lv) for(const g of lv) for(const b of lv){
    if(r===255 && g===255 && b===255) { p.push([255,255,255,255]); continue; }
    p.push([r,g,b,255]);
  }
  // remaining 40: pure ramps (r, g, b, grey)
  const ramp = [238,221,187,170,136,119,85,68,34,17];
  for(const v of ramp) p.push([v,0,0,255]);
  for(const v of ramp) p.push([0,v,0,255]);
  for(const v of ramp) p.push([0,0,v,255]);
  for(const v of ramp) p.push([v,v,v,255]);
  return p.slice(0,256);
}

export function parseVox(buffer){
  const dv = new DataView(buffer);
  const u32 = o => dv.getUint32(o, true);
  const tag = o => String.fromCharCode(dv.getUint8(o), dv.getUint8(o+1), dv.getUint8(o+2), dv.getUint8(o+3));
  if(buffer.byteLength < 20 || tag(0) !== 'VOX ') throw new Error('Not a .vox file');

  let size = null, xyzi = null, rgba = null;
  let o = 8;                                   // skip 'VOX ' + version
  // walk chunks; take the FIRST model (SIZE+XYZI pair)
  while(o + 12 <= buffer.byteLength){
    const id = tag(o);
    const contentLen = u32(o+4);
    const childLen = u32(o+8);
    const content = o + 12;
    if(id === 'SIZE' && !size){
      size = { x: u32(content), y: u32(content+4), z: u32(content+8) };
    } else if(id === 'XYZI' && !xyzi){
      const n = u32(content);
      xyzi = [];
      for(let i=0;i<n;i++){
        const b = content + 4 + i*4;
        xyzi.push([dv.getUint8(b), dv.getUint8(b+1), dv.getUint8(b+2), dv.getUint8(b+3)]);
      }
    } else if(id === 'RGBA'){
      rgba = [[0,0,0,0]];
      for(let i=0;i<255;i++){
        const b = content + i*4;
        rgba.push([dv.getUint8(b), dv.getUint8(b+1), dv.getUint8(b+2), dv.getUint8(b+3)]);
      }
    }
    // MAIN is a container: descend into it rather than skipping children
    if(id === 'MAIN') o = content;
    else o = content + contentLen + (id === 'MAIN' ? 0 : childLen);
  }
  if(!size || !xyzi) throw new Error('No model found in .vox file');
  return { size, voxels: xyzi, palette: rgba || defaultPalette() };
}

// Map a parsed .vox model into our cubic grid.
// .vox is z-up: vox x → data x, vox y → data z, vox z → height (data y = N-1-h)
export function voxToGrid(parsed){
  const { size, voxels, palette } = parsed;
  const maxDim = Math.max(size.x, size.y, size.z);
  const N = Math.max(MIN_N, Math.min(MAX_N, maxDim));
  const scale = maxDim > MAX_N ? MAX_N / maxDim : 1;

  // never let a dimension round to 0 — flat models (e.g. 60×60×1) are legitimate
  const sx = Math.max(1, Math.round(size.x*scale));
  const sy = Math.max(1, Math.round(size.y*scale));
  const sz = Math.max(1, Math.round(size.z*scale));
  const offX = Math.floor((N - sx)/2);
  const offZ = Math.floor((N - sy)/2);
  const offY = 0;                              // rest on the floor

  // precompute palette index → game colour index
  const mapCache = new Map();
  const gameRGB = PALETTE.map(hexToRGB).map(c => c.map(v => v*255));
  const nearest = (r,g,b) => {
    let best = 0, bd = Infinity;
    for(let i=0;i<5;i++){
      const d = (r-gameRGB[i][0])**2 + (g-gameRGB[i][1])**2 + (b-gameRGB[i][2])**2;
      if(d < bd){ bd = d; best = i; }
    }
    return best;
  };

  const idx = (x,y,z) => x + y*N + z*N*N;
  const colours = new Uint8Array(N*N*N).fill(EMPTY);
  let placed = 0;
  for(const [vx, vy, vz, ci] of voxels){
    const x = offX + Math.min(sx-1, Math.floor(vx*scale));
    const zz = offZ + Math.min(sy-1, Math.floor(vy*scale));
    const h = offY + Math.min(sz-1, Math.floor(vz*scale));  // height above floor
    const y = N-1-h;
    if(x<0||zz<0||y<0||x>=N||zz>=N||y>=N) continue;
    let game = mapCache.get(ci);
    if(game === undefined){
      const p = palette[ci] || [153,153,153,255];
      game = nearest(p[0], p[1], p[2]);
      mapCache.set(ci, game);
    }
    colours[idx(x,y,zz)] = game;
    placed++;
  }
  if(!placed) throw new Error('.vox model was empty after mapping');
  return { N, colours, units: new Uint8Array(N*N*N), voxels: placed, scaled: scale !== 1 };
}
