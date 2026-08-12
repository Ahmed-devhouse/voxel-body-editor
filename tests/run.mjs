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
  check('grid size clamps to MIN_N', g.N === 4);
  check('all voxels placed', g.voxels === 3);
  // red should map to c0 (#ff5252), blue to c1 (#4f8df9) with the default palette
  const solid = [...g.colours].filter(v => v !== 255);
  check('colours mapped to game palette', solid.includes(0) && solid.includes(1));

  // regression: large flat model (80×80×1) must not lose its height dimension when downscaled
  const flatVox = [];
  for(let x=0;x<80;x+=8) for(let y=0;y<80;y+=8) flatVox.push([x,y,0,1]);
  const gf = voxToGrid({ size:{x:80,y:80,z:1}, voxels: flatVox, palette: p.palette });
  check('flat .vox model imports after downscale', gf.voxels > 0, gf.voxels + ' placed');
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
