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

// regression: legitimate zero values must survive import → export unchanged.
// match by pattern, not by the current default's literal value — pinning "10"
// here silently turned this half of the check into a no-op once the default moved.
const zeroYaml = blankYaml.replace(/ {2}depth: \d+/, '  depth: 0')
                          .replace(/ {2}crateRows: \d+/, '  crateRows: 0');
check('substitution actually applied', /depth: 0\n/.test(zeroYaml) && /crateRows: 0\n/.test(zeroYaml));
const zeroBack = exportAsset(parseAsset(zeroYaml));
check('zero depth/crateRows round-trip', zeroBack === zeroYaml,
  (zeroBack.match(/depth: \d+/)||[])[0] + ', ' + (zeroBack.match(/crateRows: \d+/)||[])[0]);

// regression: misplayTolerance is a float [Range(0,0.5)] — rounding it destroys
// every legal value, and no project asset stores a non-zero one to catch it
for(const v of ['0.1','0.25','0.3','0.5','0.30000001']){
  const y = blankYaml.replace(/ {2}misplayTolerance: [\d.]+/, '  misplayTolerance: ' + v);
  const p = parseAsset(y);
  check('misplayTolerance ' + v + ' survives round-trip',
    p.meta.misplayTolerance === parseFloat(v) && exportAsset(p) === y,
    'parsed ' + p.meta.misplayTolerance);
}

// regression: an absent crateRows must fall back to Unity's field initializer
// (CratePlan.DefaultRows = 3), not the bird sample's authored 10
{
  const noRows = blankYaml.replace(/ {2}crateRows: \d+\n/, '');
  check('absent crateRows falls back to 3', parseAsset(noRows).meta.crateRows === 3,
    String(parseAsset(noRows).meta.crateRows));
}

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

/* ---------- 3b-bis. slice-view axis mapping is a bijection in all three views ---------- */
console.log('slice axis mapping');
{
  const st = await import(join(root, 'js/state.js'));
  const { state, sel, idx, sliceToCell, cellToSlice, sliceIdx } = st;
  let allOk = true, inverseOk = true, agreeOk = true;
  for(const n of [3, 4, 7, 14, 24]){
    state.N = n;
    for(const axis of ['y','z','x']){
      sel.sliceAxis = axis;
      const seen = new Set();
      for(let s=0; s<n; s++) for(let row=0; row<n; row++) for(let col=0; col<n; col++){
        const [x,y,z] = sliceToCell(col, row, s);
        if(x<0||y<0||z<0||x>=n||y>=n||z>=n){ allOk = false; continue; }
        const i = idx(x,y,z);
        if(seen.has(i)) allOk = false;      // two slice coords hitting one cell
        seen.add(i);
        const back = cellToSlice(x,y,z);
        if(back.col!==col || back.row!==row || back.s!==s) inverseOk = false;
        if(sliceIdx(col,row,s) !== i) agreeOk = false;
      }
      if(seen.size !== n*n*n) allOk = false;   // must cover every cell exactly once
    }
  }
  check('every slice coord maps to a distinct cell, covering the grid', allOk);
  check('cellToSlice inverts sliceToCell in all views', inverseOk);
  check('sliceIdx agrees with idx(sliceToCell(...))', agreeOk);

  // the y view must keep its documented meaning: slice = height, row = depth
  state.N = 14; sel.sliceAxis = 'y';
  check('top view: slice is height, row is depth',
    JSON.stringify(sliceToCell(1,3,8)) === JSON.stringify([1,8,3]));
  // the front view must put row 0 at the TOP of the screen (highest y)
  sel.sliceAxis = 'z';
  check('front view: row 0 is the top of the model',
    sliceToCell(0,0,0)[1] === 13 && sliceToCell(0,13,0)[1] === 0);
  sel.sliceAxis = 'y';
}

/* ---------- 3b-ter. slice ops and model ops ---------- */
console.log('slice + model ops');
{
  const st = await import(join(root, 'js/state.js'));
  const tools = await import(join(root, 'js/tools.js'));
  const { state, sel, idx, EMPTY: E } = st;

  const build = (n, fn) => {
    state.N = n;
    state.colours = new Uint8Array(n*n*n).fill(E);
    state.units = new Uint8Array(n*n*n);
    for(let z=0;z<n;z++) for(let y=0;y<n;y++) for(let x=0;x<n;x++){
      const v = fn(x,y,z);
      if(v !== undefined) state.colours[idx(x,y,z)] = v;
    }
    st.clearHistory();
  };
  const count = () => state.colours.reduce((a,v) => a + (v!==E?1:0), 0);

  // copy a slice, paste it elsewhere, and confirm it landed verbatim
  build(6, (x,y,z) => y === 0 ? 2 : undefined);      // a floor plate
  sel.sliceAxis = 'y'; sel.slice = 0;
  tools.copySlice();
  sel.slice = 3;
  check('paste onto an empty slice', tools.pasteSlice() === null);
  let plate = true;
  for(let z=0;z<6;z++) for(let x=0;x<6;x++) if(state.colours[idx(x,3,z)] !== 2) plate = false;
  check('pasted slice matches the source exactly', plate);

  // a paste from another view is refused rather than silently transposed
  sel.sliceAxis = 'z';
  check('cross-view paste refused', typeof tools.pasteSlice() === 'string');
  sel.sliceAxis = 'y';

  // duplicate follows the slice it wrote
  build(6, (x,y,z) => y === 2 ? 3 : undefined);
  sel.slice = 2;
  check('duplicate upward succeeds', tools.duplicateSlice(1) === null);
  check('duplicate moved the cursor with it', sel.slice === 3);
  check('duplicate copied the content', state.colours[idx(0,3,0)] === 3);
  check('duplicate past the top is refused', (sel.slice = 5, typeof tools.duplicateSlice(1) === 'string'));

  // trim: a 4³ blob inside a 14³ grid should shrink to 4³ and keep every voxel
  build(14, (x,y,z) => (x>=5&&x<9 && y>=6&&y<10 && z>=5&&z<9) ? 1 : undefined);
  const before = count();
  check('trim reports success', tools.trimToContent(0) === null);
  check('trim shrank the grid to fit', state.N === 4, 'N=' + state.N);
  check('trim kept every voxel', count() === before, `${count()} vs ${before}`);
  check('trim dropped the model onto the floor', state.colours[idx(0,0,0)] === 1);

  // centre: an off-centre blob lands centred and on the floor
  build(8, (x,y,z) => (x<2 && y>=4&&y<6 && z<2) ? 4 : undefined);
  check('centre reports success', tools.centreModel() === null);
  const b = tools.bounds();
  check('centre put it on the floor', b.y0 === 0, 'y0=' + b.y0);
  check('centre balanced x', b.x0 === 7 - b.x1, `x ${b.x0}..${b.x1}`);
  check('centre balanced z', b.z0 === 7 - b.z1, `z ${b.z0}..${b.z1}`);

  // replace / delete colour
  build(4, () => 2);
  check('replaceColour reports the count', tools.replaceColour(2, 3) === 64);
  check('replaceColour actually repainted', state.colours.every(v => v === 3));
  check('replaceColour on an absent colour is a no-op', tools.replaceColour(0, 1) === 0);
  check('deleteColour empties them', tools.deleteColour(3) === 64 && count() === 0);

  // brush footprint: a 3×3 patch on an empty slice
  build(6, () => undefined);
  sel.sliceAxis = 'y'; sel.slice = 0; sel.tool = 'paint'; sel.colour = 1;
  sel.brush = 2; sel.symX = false; sel.symZ = false;
  tools.sliceAction(2, 2, false);
  check('brush 2 covers 3×3', count() === 9, String(count()));
  sel.brush = 1;

  // brush clips at the grid edge rather than wrapping
  build(6, () => undefined);
  sel.brush = 3;
  tools.sliceAction(0, 0, false);
  check('brush clips at the edge', count() === 9, String(count()));   // quarter of 5×5
  sel.brush = 1;

  // symmetry is world-space: mirroring X in the top view must mirror columns
  build(6, () => undefined);
  sel.symX = true;
  tools.sliceAction(1, 2, false);
  check('mirror X paints both sides', state.colours[idx(1,0,2)] === 1 && state.colours[idx(4,0,2)] === 1);
  sel.symX = false;

  /* regressions for bugs the feature suite could not see */

  // A mirrored flood fill must not dam itself on cells symmetry already painted.
  // An L-shaped empty channel makes this visible: the only way into the leg is
  // through (col 5, row 2), which is the mirror of the clicked (col 0, row 2) and
  // so gets painted before the flood arrives. Testing the live grid then stops
  // there and the leg is never reached.
  build(6, (x,y,z) => {
    if(y !== 0) return undefined;
    const onBar = z === 2;                       // row 2, every column
    const onLeg = x === 5 && z >= 3;             // and down the far side
    return (onBar || onLeg) ? undefined : 2;     // channel empty, rest solid
  });
  sel.tool = 'fill'; sel.colour = 1; sel.symX = true; sel.slice = 0; sel.sliceAxis = 'y';
  tools.sliceAction(0, 2, false);                // click the near end of the bar
  check('mirrored flood fill reaches past its own mirror writes',
    state.colours[idx(5,0,3)] === 1 && state.colours[idx(5,0,5)] === 1,
    `leg cells: ${state.colours[idx(5,0,3)]}, ${state.colours[idx(5,0,5)]}`);
  sel.symX = false; sel.tool = 'paint';

  // the unit tool marks ONE voxel however big the brush is
  build(6, () => 2);
  sel.tool = 'unit'; sel.unitKind = 1; sel.brush = 4; sel.slice = 0;
  tools.sliceAction(3, 3, false);
  const unitsPlaced = state.units.reduce((a,v) => a + (v?1:0), 0);
  check('unit tool ignores brush size', unitsPlaced === 1, String(unitsPlaced));
  tools.sliceAction(3, 3, false);
  check('unit toggles off on a second click', state.units.every(v => v === 0));
  sel.brush = 1; sel.tool = 'paint';

  // a 3D brush spreads across the plane of the clicked FACE, not of the 2D view.
  // Clicking the top face of a floor voxel must lay a horizontal plate even
  // while the front view is open.
  build(6, (x,y,z) => y === 0 ? 2 : undefined);
  sel.sliceAxis = 'z'; sel.brush = 2; sel.tool = 'build'; sel.colour = 1;
  const beforePatch = count();
  tools.hit3DAction({ cell:[2,0,2], nb:[2,1,2], floor:false }, false);
  const added = count() - beforePatch;
  check('3D brush follows the clicked face, not the view axis', added === 9, String(added));
  let flat = true;
  for(let z=1;z<4;z++) for(let x=1;x<4;x++) if(state.colours[idx(x,1,z)] !== 1) flat = false;
  check('the 3D patch is a horizontal plate', flat);
  sel.brush = 1; sel.sliceAxis = 'y'; sel.tool = 'paint';
}

/* ---------- 3b-quater. a 3D edit follows the slice axis ---------- */
console.log('3D edit ↔ slice sync');
{
  const st = await import(join(root, 'js/state.js'));
  const { state, sel, cellToSlice } = st;
  state.N = 14;
  // touched is a world cell; the slice cursor must move to its index along the
  // CURRENT axis, which is y only in the top view
  const touched = [3, 9, 4];
  sel.sliceAxis = 'y';
  check('top view syncs to y', cellToSlice(...touched).s === 9);
  sel.sliceAxis = 'z';
  check('front view syncs to z, not y', cellToSlice(...touched).s === 4);
  sel.sliceAxis = 'x';
  check('side view syncs to x, not y', cellToSlice(...touched).s === 3);
  sel.sliceAxis = 'y';
  const src = readFileSync(join(root, 'js/editor3d.js'), 'utf8');
  check('editor3d uses cellToSlice for the sync, not touched[1]',
    /setSlice\(cellToSlice\(touched\[0\], touched\[1\], touched\[2\]\)\.s\)/.test(src) &&
    !/setSlice\(touched\[1\]\)/.test(src));
  check('isolate re-cuts the mesh when the slice or axis moves',
    /cutNeedsRebuild\(\)/.test(src) && /if\(cutNeedsRebuild\(\)\) rebuild\(\)/.test(src));
  check('unit markers honour the isolate cut',
    /rebuildUnits[\s\S]{0,600}sel\.isolate && cellToSlice\(x,y,z\)\.s > sel\.slice/.test(src));
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
