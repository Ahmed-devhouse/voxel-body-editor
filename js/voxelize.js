// PNG → voxel body generator. Approximates the Unity voxelizer pipeline:
// threshold + blur the alpha channel, extrude through the depth with rounded
// ends, then colour voxels by onion-peel layer using the layer rules.

import { EMPTY } from './state.js';

export function sampleImageAlpha(img, n){
  const cv = document.createElement('canvas');
  cv.width = n; cv.height = n;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const s = Math.min(n/img.width, n/img.height);
  const w = img.width*s, h = img.height*s;
  cx.drawImage(img, (n-w)/2, (n-h)/2, w, h);
  const d = cx.getImageData(0,0,n,n).data;
  const alpha = new Float32Array(n*n);
  for(let i=0;i<n*n;i++) alpha[i] = d[i*4+3]/255;
  return alpha;
}

function blur(a, n, passes){
  let src = a;
  for(let p=0; p<passes; p++){
    const out = new Float32Array(n*n);
    for(let y=0;y<n;y++) for(let x=0;x<n;x++){
      let s=0, c=0;
      for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){
        const xx=x+dx, yy=y+dy;
        if(xx<0||yy<0||xx>=n||yy>=n) continue;
        s += src[xx+yy*n]; c++;
      }
      out[x+y*n] = s/c;
    }
    src = out;
  }
  return src;
}

export function maskFromImage(img, n, alphaThreshold, smoothness){
  let alpha = sampleImageAlpha(img, n);
  const passes = Math.round(smoothness/25);
  if(passes > 0) alpha = blur(alpha, n, passes);
  const mask = new Uint8Array(n*n);
  for(let i=0;i<n*n;i++) mask[i] = alpha[i] > alphaThreshold ? 1 : 0;
  return mask;
}

// chamfer distance-to-edge in cell units (2D)
function distanceField(mask, N){
  const INF = 1e9;
  const d2 = new Float32Array(N*N);
  for(let i=0;i<N*N;i++) d2[i] = mask[i] ? INF : 0;
  for(let y=0;y<N;y++) for(let x=0;x<N;x++){
    const i=x+y*N; if(!mask[i]) continue;
    let m = INF;
    if(x>0) m=Math.min(m,d2[i-1]+1); else m=Math.min(m,1);
    if(y>0) m=Math.min(m,d2[i-N]+1); else m=Math.min(m,1);
    if(x>0&&y>0) m=Math.min(m,d2[i-N-1]+1.4);
    if(x<N-1&&y>0) m=Math.min(m,d2[i-N+1]+1.4);
    d2[i]=Math.min(d2[i],m);
  }
  for(let y=N-1;y>=0;y--) for(let x=N-1;x>=0;x--){
    const i=x+y*N; if(!mask[i]) continue;
    let m = d2[i];
    if(x<N-1) m=Math.min(m,d2[i+1]+1); else m=Math.min(m,1);
    if(y<N-1) m=Math.min(m,d2[i+N]+1); else m=Math.min(m,1);
    if(x<N-1&&y<N-1) m=Math.min(m,d2[i+N+1]+1.4);
    if(x>0&&y<N-1) m=Math.min(m,d2[i+N-1]+1.4);
    d2[i]=m;
  }
  return d2;
}

export function voxelize(mask, opts){
  const N = opts.size;
  const depth = Math.min(opts.depth, N);
  const rounding = opts.rounding;          // 0..1
  const layerRules = opts.layerRules || [];
  const unitRules = opts.placeUnits ? (opts.unitRules || []) : [];

  const idx = (x,y,z) => x + y*N + z*N*N;
  const colours = new Uint8Array(N*N*N).fill(EMPTY);
  const units = new Uint8Array(N*N*N);
  const d2 = distanceField(mask, N);

  // extrude with rounded ends, centered in the cube
  const zc = (N-1)/2, halfD = depth/2;
  for(let z=0; z<N; z++){
    const dz = Math.abs(z-zc);
    if(dz > halfD) continue;
    const t = halfD > 0.01 ? dz/halfD : 0;
    const inset = rounding * (1 - Math.sqrt(Math.max(0, 1-t*t))) * halfD;
    for(let y=0;y<N;y++) for(let x=0;x<N;x++){
      if(!mask[x+y*N]) continue;
      if(d2[x+y*N] - 0.5 < inset) continue;
      colours[idx(x,y,z)] = 0;   // placeholder, coloured below
    }
  }

  // onion-peel layers: BFS depth-from-surface
  const layer = new Int16Array(N*N*N).fill(-1);
  const q = [];
  for(let z=0;z<N;z++) for(let y=0;y<N;y++) for(let x=0;x<N;x++){
    const i = idx(x,y,z);
    if(colours[i] === EMPTY) continue;
    const edge = x===0||y===0||z===0||x===N-1||y===N-1||z===N-1;
    const surf = edge ||
      colours[idx(x+1,y,z)]===EMPTY || colours[idx(x-1,y,z)]===EMPTY ||
      colours[idx(x,y+1,z)]===EMPTY || colours[idx(x,y-1,z)]===EMPTY ||
      colours[idx(x,y,z+1)]===EMPTY || colours[idx(x,y,z-1)]===EMPTY;
    if(surf){ layer[i]=0; q.push([x,y,z]); }
  }
  let head = 0;
  while(head < q.length){
    const [x,y,z] = q[head++];
    const l = layer[idx(x,y,z)];
    for(const [dx,dy,dz2] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]){
      const nx=x+dx, ny=y+dy, nz=z+dz2;
      if(nx<0||ny<0||nz<0||nx>=N||ny>=N||nz>=N) continue;
      const ni = idx(nx,ny,nz);
      if(colours[ni]===EMPTY || layer[ni]!==-1) continue;
      layer[ni] = l+1;
      q.push([nx,ny,nz]);
    }
  }
  const ruleFor = l => {
    let best = null;
    for(const r of layerRules) if(r.layer<=l && (!best || r.layer>best.layer)) best = r;
    return best || {colour:0};
  };
  for(let i=0;i<colours.length;i++)
    if(colours[i]!==EMPTY) colours[i] = ruleFor(Math.max(0, layer[i])).colour;

  // deterministic unit placement per unit rule
  let seed = 1234567;
  const rnd = () => { seed = (seed*1103515245 + 12345) & 0x7fffffff; return seed/0x7fffffff; };
  for(const r of unitRules){
    const cand = [];
    for(let i=0;i<colours.length;i++) if(colours[i]!==EMPTY && layer[i]===r.layer) cand.push(i);
    for(let k=0; k<r.count && cand.length; k++){
      const pickI = cand.splice(Math.floor(rnd()*cand.length), 1)[0];
      units[pickI] = r.kind;
    }
  }

  return { N, colours, units };
}
