// Test suite — run with: node tests/run.mjs
// No dependencies. Verifies the format round-trip, the .vox parser, module
// syntax, and that every DOM id the JS references exists in index.html.

import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(name, ok, detail){
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok ? '' : (detail ? ' — ' + detail : '')));
  if(!ok) failures++;
}

/* ---------- 1. every JS module parses ---------- */
console.log('module syntax');
for(const f of readdirSync(join(root, 'js'))){
  try{
    execFileSync(process.execPath, ['--check', join(root, 'js', f)], { stdio: 'pipe' });
    check(f, true);
  }catch(e){
    check(f, false, String(e.stderr || e.message).split('\n')[0]);
  }
}

/* ---------- 2. .asset round-trip is byte-identical ---------- */
console.log('asset format');
const { parseAsset, exportAsset } = await import(join(root, 'js/asset.js'));
const original = readFileSync(join(root, 'samples/bird.asset'), 'utf8');
const parsed = parseAsset(original);
check('parses sample (14³, 976 voxels)',
  parsed.N === 14 && parsed.colours.filter(v => v !== 255).length === 976);
const out = exportAsset(parsed);
check('round-trip byte-identical', out === original,
  out.length + ' vs ' + original.length + ' bytes');

// export of a fresh default model parses back
const { defaultMeta, EMPTY } = await import(join(root, 'js/state.js'));
const blank = {
  N: 8,
  colours: new Uint8Array(512).fill(EMPTY),
  units: new Uint8Array(512),
  meta: defaultMeta(),
};
blank.colours[0] = 2;
const blankYaml = exportAsset(blank);
const reparsed = parseAsset(blankYaml);
check('fresh model round-trips', exportAsset(reparsed) === blankYaml);
check('voxelCount written', /voxelCount: 1\n$/.test(blankYaml));

// regression: legitimate zero values must survive import → export unchanged
const zeroYaml = blankYaml.replace('  depth: 11', '  depth: 0').replace('  crateRows: 10', '  crateRows: 0');
const zeroBack = exportAsset(parseAsset(zeroYaml));
check('zero depth/crateRows round-trip', zeroBack === zeroYaml,
  (zeroBack.match(/depth: \d+/)||[])[0] + ', ' + (zeroBack.match(/crateRows: \d+/)||[])[0]);

// regression: empty m_Name must fall back to a string, not an empty array
const noName = parseAsset(blankYaml.replace(/ {2}m_Name: .*/, '  m_Name: '));
check('empty m_Name falls back to string', noName.meta.name === 'Imported', JSON.stringify(noName.meta.name));

// regression: CRLF input still parses
const crlf = parseAsset(original.replace(/\n/g, '\r\n'));
check('CRLF asset parses', crlf.N === 14 && exportAsset(crlf) === original);

/* ---------- 3. .vox parser on a synthetic fixture ---------- */
console.log('vox import');
{
  // build a minimal 2x1x3 vox file with 3 voxels and a custom palette
  const chunks = [];
  const str = s => [...s].map(c => c.charCodeAt(0));
  const u32 = n => [n & 255, (n>>8)&255, (n>>16)&255, (n>>24)&255];
  const chunk = (id, content, children=[]) =>
    [...str(id), ...u32(content.length), ...u32(children.length), ...content, ...children];
  const sizeC = chunk('SIZE', [...u32(2), ...u32(1), ...u32(3)]);
  // voxels: (x,y,z,colorIndex) — palette index 1 and 2
  const xyzi = chunk('XYZI', [...u32(3), 0,0,0,1, 1,0,0,2, 0,0,2,1]);
  const pal = new Array(256*4).fill(0);
  // palette entry 1 (file index 1 → array slot 0 in RGBA chunk): pure red; entry 2: pure blue
  pal[0]=255; pal[1]=0; pal[2]=0; pal[3]=255;
  pal[4]=0; pal[5]=0; pal[6]=255; pal[7]=255;
  const rgba = chunk('RGBA', pal.slice(0, 255*4 + 4));
  const main = chunk('MAIN', [], [...sizeC, ...xyzi, ...rgba]);
  const file = new Uint8Array([...str('VOX '), ...u32(150), ...main]);

  const { parseVox, voxToGrid } = await import(join(root, 'js/vox.js'));
  const p = parseVox(file.buffer);
  check('parses fixture', p.size.x===2 && p.size.y===1 && p.size.z===3 && p.voxels.length===3);
  const g = voxToGrid(p);
  check('grid size clamps to MIN_N', g.N === 3, 'N=' + g.N);
  check('all voxels placed', g.voxels === 3);
  // pure red maps to game R (index 2), pure blue to game B (index 4)
  const solid = [...g.colours].filter(v => v !== 255);
  check('colours mapped to game palette (R=2, B=4)', solid.includes(2) && solid.includes(4), JSON.stringify(solid));

  // vox z-up must land on our y-up: the vz=2 voxel sits at data y=2 (two above the floor)
  const { idx: gIdx } = await import(join(root, 'js/state.js'));
  check('.vox height maps to y-up', g.colours[(0*3 + 2)*3 + 1] !== 255);

  // regression: large flat model (80×80×1) must not lose its height dimension when downscaled
  const flatVox = [];
  for(let x=0;x<80;x+=8) for(let y=0;y<80;y+=8) flatVox.push([x,y,0,1]);
  const gf = voxToGrid({ size:{x:80,y:80,z:1}, voxels: flatVox, palette: p.palette });
  check('flat .vox model imports after downscale', gf.voxels > 0, gf.voxels + ' placed');
}

/* ---------- 3b. axis convention locked to Unity's VoxelCore ---------- */
console.log('unity axis convention');
{
  const stateMod = await import(join(root, 'js/state.js'));
  stateMod.state.N = 14;
  const { idx, sliceIdx } = stateMod;
  // VoxelCore.CellIdx(i,j,k,n) = (i*n + j)*n + k
  check('idx matches CellIdx order', idx(1,8,3) === (1*14+8)*14+3 && idx(0,0,1) === 1 && idx(1,0,0) === 196);
  check('sliceIdx: layer = y, col = x, row = z', sliceIdx(1,3,8) === idx(1,8,3));

  // orientation lock, measured from the real bird asset (verified against the
  // Unity renderer): voxels per height layer, bottom = 26 … top = 46
  const bird = parseAsset(original);
  const perY = [];
  for(let y=0;y<14;y++){
    let n = 0;
    for(let x=0;x<14;x++) for(let z=0;z<14;z++) if(bird.colours[(x*14+y)*14+z] !== 255) n++;
    perY.push(n);
  }
  check('bird bottom layer has 26 voxels', perY[0] === 26, String(perY[0]));
  check('bird top layer has 46 voxels', perY[13] === 46, String(perY[13]));
  check('bird first solid cell is (1,8,3) = R', bird.colours[311] === 2);
}

/* ---------- 3c. every asset in the Unity project round-trips ---------- */
{
  const projDir = '/Users/muhammadahmad/Unity-projects/Voxel_Volley/Assets/VoxelVolley/VoxelBodies';
  let files = [];
  try{
    const walk = d => { for(const e of readdirSync(d, {withFileTypes:true})){
      if(e.isDirectory()) walk(join(d, e.name));
      else if(e.name.endsWith('.asset')) files.push(join(d, e.name));
    }};
    walk(projDir);
  }catch{ files = null; }
  if(files){
    console.log('unity project assets');
    let ok = 0;
    const bad = [];
    for(const f of files){
      const orig = readFileSync(f, 'utf8');
      try{ if(exportAsset(parseAsset(orig)) === orig) ok++; else bad.push(f); }
      catch(e){ bad.push(f + ' (' + e.message + ')'); }
    }
    check(`all ${files.length} project assets round-trip byte-identical`, ok === files.length,
      bad.slice(0,3).map(b => b.split('/').pop()).join(', '));
  }
}

/* ---------- 3d. a freshly authored asset is shaped like a real project one ---------- */
console.log('fresh asset shape');
{
  const N = 6;
  const colours = new Uint8Array(N**3).fill(EMPTY);
  const units = new Uint8Array(N**3);
  const gi = (x,y,z) => (x*N+y)*N+z;
  for(let x=1;x<5;x++) for(let z=1;z<5;z++) for(let y=0;y<3;y++) colours[gi(x,y,z)] = (x+z)%2 ? 2 : 3;
  units[gi(2,1,2)] = 1;
  const meta = defaultMeta();
  meta.name = 'TestCube_Body'; meta.displayName = 'Test Cube'; meta.depth = 4;
  const fresh = exportAsset({N, colours, units, meta});

  const fieldsOf = s => s.split('\n').filter(l => /^ {2}\w+:/.test(l)).map(l => l.split(':')[0].trim());
  const realPath = '/Users/muhammadahmad/Unity-projects/Voxel_Volley/Assets/VoxelVolley/VoxelBodies/Fruits/fruits_0_Body.asset';
  let real = null;
  try{ real = readFileSync(realPath, 'utf8'); }catch{ /* project not present */ }
  if(real)
    check('field sequence identical to a real project asset',
      JSON.stringify(fieldsOf(fresh)) === JSON.stringify(fieldsOf(real)),
      fieldsOf(fresh).join(','));
  check('grids are size³ hex and stable on re-export',
    /colours: (\w+)/.exec(fresh)[1].length === N**3*2 &&
    /units: (\w+)/.exec(fresh)[1].length === N**3*2 &&
    exportAsset(parseAsset(fresh)) === fresh);
  check('script GUID + class id point at VoxelBody',
    /guid: 8154fcdcf86ef414a8a725fd872e9180/.test(fresh) &&
    /Assembly-CSharp::VoxelVolley\.VoxelBody/.test(fresh));
  check('only valid colour/unit bytes, units on solid cells',
    [...colours].every(v => v===255 || v<6) &&
    [...units].every((u,i) => !u || (u===1||u===4) && colours[i]!==255));
}

/* ---------- 4. every DOM id referenced in JS exists in index.html ---------- */
console.log('dom ids');
{
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
  const missing = new Set();
  for(const f of readdirSync(join(root, 'js'))){
    const src = readFileSync(join(root, 'js', f), 'utf8');
    for(const m of src.matchAll(/getElementById\('([^']+)'\)|\$\('([^']+)'\)/g)){
      const id = m[1] || m[2];
      if(id && !htmlIds.has(id)) missing.add(id + ' (' + f + ')');
    }
  }
  check('all referenced ids present', missing.size === 0, [...missing].join(', '));
}

/* ---------- 5. index.html sanity ---------- */
console.log('html');
{
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  check('import map points at vendored three', html.includes('"three": "./vendor/three.module.js"'));
  check('main.js loaded as module', /<script type="module" src="js\/main.js">/.test(html));
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  const dupes = ids.filter((v,i) => ids.indexOf(v) !== i);
  check('no duplicate ids', dupes.length === 0, dupes.join(', '));
}

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nall tests passed');
process.exit(failures ? 1 : 0);
