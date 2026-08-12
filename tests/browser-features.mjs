// Browser test for the editing features: slice axis views, brush size, line tool,
// slice copy/paste/duplicate/fill/clear, isolate, palette add/remove, recolour,
// centre/trim, unknown colour bytes, and export fidelity after a full tour.
//
// Needs a real browser, so it is not part of `npm test`:
//     npm i --no-save playwright-core     (and Google Chrome installed)
//     node tests/browser-features.mjs
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.asset':'text/plain' };
const server = createServer(async (req,res) => {
  try{
    let p = decodeURIComponent(new URL(req.url,'http://x').pathname);
    if(p === '/') p = '/index.html';
    const f = normalize(join(ROOT,p));
    if(!f.startsWith(ROOT)) throw 0;
    res.writeHead(200, {'content-type': MIME[extname(f)] || 'application/octet-stream'});
    res.end(await readFile(f));
  }catch{ res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, r));
const browser = await chromium.launch({ channel:'chrome', headless:true, args:['--use-angle=swiftshader'] });
const ctx = await browser.newContext({ viewport:{width:1500,height:950}, permissions:['clipboard-read','clipboard-write'] });
const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if(m.type()==='error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: '+e.message));

let fail = 0;
const check = (n, ok, d) => { console.log((ok?'  ✓ ':'  ✗ ')+n+(ok||!d?'':' — '+d)); if(!ok) fail++; };
const vox = async () => parseInt((await page.textContent('#voxCount')).trim());

await page.goto('http://localhost:'+server.address().port+'/', { waitUntil:'networkidle' });
await page.waitForTimeout(1500);
await page.click('#btnSample');
await page.waitForTimeout(700);
check('sample loaded', await vox() === 976);

/* ---------- slice axis views ---------- */
const label = () => page.textContent('#sliceLbl');
check('top view by default', (await label()).trim().startsWith('y'));
await page.keyboard.press('8');
await page.waitForTimeout(250);
check('key 8 → front view (z)', (await label()).trim().startsWith('z'),
  (await label()).trim());
check('front view header text', /front view/.test(await page.textContent('#sliceAxisLabel')));
await page.keyboard.press('9');
await page.waitForTimeout(250);
check('key 9 → side view (x)', (await label()).trim().startsWith('x'));
await page.click('[data-axis="y"]');
await page.waitForTimeout(250);
check('axis button → back to top', (await label()).trim().startsWith('y'));

// the three views must show the SAME model, so total voxels never changes
const before = await vox();
await page.keyboard.press('8'); await page.waitForTimeout(200);
check('switching view does not alter the model', await vox() === before);
await page.keyboard.press('7'); await page.waitForTimeout(200);

/* ---------- brush size ---------- */
await page.keyboard.press('b');                     // paint
await page.keyboard.press('=');                     // brush 2
await page.waitForTimeout(150);
const brushOn = await page.locator('.brushBtn.on').getAttribute('data-brush');
check('brush size grows with +', brushOn === '2', brushOn);
// paint on an empty slice with brush 2 → a 3×3 patch (9 voxels)
await page.fill('#sliceRange', '0');
await page.dispatchEvent('#sliceRange', 'input');
await page.waitForTimeout(200);
await page.click('#opClear');                        // start from an empty slice
await page.waitForTimeout(250);
const emptied = await vox();
const sBox = await page.locator('#sliceCanvas').boundingBox();
await page.mouse.click(sBox.x + sBox.width/2, sBox.y + sBox.height/2);
await page.waitForTimeout(250);
check('brush 2 paints a 3×3 patch', await vox() === emptied + 9, `${await vox()} vs ${emptied + 9}`);
await page.keyboard.press('-');                      // back to brush 1
await page.keyboard.press('Meta+z');                 // undo the paint
await page.keyboard.press('Meta+z');                 // undo the slice clear
await page.waitForTimeout(300);
check('paint + clear-slice both undo', await vox() === 976, String(await vox()));

/* ---------- line tool ---------- */
await page.keyboard.press('l');
check('key L selects line', await page.locator('.toolbtn[data-tool="line"]').evaluate(el => el.classList.contains('active')));
const beforeLine = await vox();
const g = await page.locator('#sliceCanvas').boundingBox();
await page.mouse.move(g.x + g.width*0.35, g.y + g.height*0.5);
await page.mouse.down();
await page.mouse.move(g.x + g.width*0.65, g.y + g.height*0.5, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(300);
check('line tool draws a run of voxels', await vox() > beforeLine, `${beforeLine} → ${await vox()}`);
await page.keyboard.press('Meta+z');
await page.waitForTimeout(200);
check('line undoes as one step', await vox() === beforeLine);

/* ---------- slice copy / paste / duplicate ---------- */
await page.fill('#sliceRange', '5');
await page.dispatchEvent('#sliceRange', 'input');
await page.waitForTimeout(200);
await page.click('#opCopy');
await page.waitForTimeout(150);
await page.fill('#sliceRange', '0');
await page.dispatchEvent('#sliceRange', 'input');
await page.waitForTimeout(200);
const beforePaste = await vox();
await page.click('#opPaste');
await page.waitForTimeout(300);
check('paste changes the target slice', await vox() !== beforePaste, `${beforePaste} → ${await vox()}`);
await page.keyboard.press('Meta+z');
await page.waitForTimeout(200);
check('paste undoes', await vox() === beforePaste);

// clipboard is view-scoped: pasting a top slice into the front view is refused
await page.click('#opCopy');
await page.keyboard.press('8');
await page.waitForTimeout(250);
const guard = await vox();
await page.click('#opPaste');
await page.waitForTimeout(300);
check('cross-view paste is refused, not silently wrong', await vox() === guard);
await page.keyboard.press('7');
await page.waitForTimeout(200);

/* ---------- fill / clear slice ---------- */
await page.fill('#sliceRange', '13');
await page.dispatchEvent('#sliceRange', 'input');
await page.waitForTimeout(200);
const beforeFill = await vox();
await page.click('#opFill');
await page.waitForTimeout(300);
check('fill slice fills the whole plane', await vox() > beforeFill);
await page.keyboard.press('Meta+z');
await page.waitForTimeout(250);
check('fill undoes', await vox() === beforeFill);

/* ---------- isolate ---------- */
// from a known-clean model, so the count can be asserted exactly. The bird's
// voxels per height layer are 26,52,74,76,96,96,… so isolating at y=5 must
// show exactly their cumulative sum.
await page.click('#btnSample');
await page.waitForTimeout(700);
check('reset to a clean 976', await vox() === 976, String(await vox()));
await page.fill('#sliceRange', '5');
await page.dispatchEvent('#sliceRange', 'input');
await page.waitForTimeout(250);
await page.check('#chkIsolate');
await page.waitForTimeout(450);
const isoCount = await vox();
check('isolate shows exactly layers 0–5 (420)', isoCount === 420, String(isoCount));
await page.uncheck('#chkIsolate');
await page.waitForTimeout(450);
check('un-isolate restores the whole model', await vox() === 976, String(await vox()));

/* ---------- palette add / remove ---------- */
const swatches = () => page.locator('#palette .swatch').count();
check('6 swatches to start', await swatches() === 6);
await page.click('#palAdd');
await page.waitForTimeout(250);
check('add colour → 7 swatches', await swatches() === 7);
check('new swatch flagged as beyond the game build',
  await page.locator('#palette .swatch.beyond').count() === 1);
check('palette editor grew too', await page.locator('#palEdit .pe').count() === 7);
// a voxel in the extra colour must be reported as unplayable
await page.keyboard.press('b');
await page.mouse.click(g.x + g.width/2, g.y + g.height/2);
await page.waitForTimeout(250);
await page.click('#tabs button[data-tab="stats"]');
await page.waitForTimeout(450);
const valid = await page.textContent('#validList');
check('stats flags the beyond-game colour as uncleavable',
  /colour 6 or above/.test(valid) && /cannot be cleared/.test(valid),
  valid.replace(/\s+/g,' ').slice(0,180));
await page.keyboard.press('Meta+z');
await page.waitForTimeout(200);
await page.click('#palDel');
await page.waitForTimeout(250);
check('remove colour → back to 6', await swatches() === 6);
check('cannot remove the game\'s own six', await page.locator('#palDel').isDisabled());

/* ---------- recolour ---------- */
await page.click('#tabs button[data-tab="model"]');
await page.waitForTimeout(300);
await page.selectOption('#swapFrom', '2');   // R
await page.selectOption('#swapTo', '4');     // B
await page.click('#btnSwap');
await page.waitForTimeout(400);
await page.click('#tabs button[data-tab="stats"]');
await page.waitForTimeout(450);
const tbl = await page.textContent('#statsTbl');
check('swap repainted R into B', /R\s*0\b/.test(tbl.replace(/\s+/g,' ')) || !/\bR\s*46/.test(tbl),
  tbl.replace(/\s+/g,' ').slice(0,120));
await page.keyboard.press('Meta+z');
await page.waitForTimeout(300);

/* ---------- centre / trim ---------- */
await page.click('#btnSample');            // clean slate so counts are exact
await page.waitForTimeout(700);
await page.click('#tabs button[data-tab="model"]');
await page.waitForTimeout(250);
const sizeBefore = await page.inputValue('#fSize');
await page.click('#btnTrim');
await page.waitForTimeout(500);
const sizeAfter = await page.inputValue('#fSize');
check('trim shrinks or reports already tight', +sizeAfter <= +sizeBefore, `${sizeBefore} → ${sizeAfter}`);
check('voxels survive the trim', await vox() === 976, String(await vox()));
await page.keyboard.press('Meta+z');
await page.waitForTimeout(400);
check('trim undoes to the original size', await page.inputValue('#fSize') === sizeBefore);

/* ---------- a colour byte with no palette entry at all ---------- */
// Only reachable by import, so it is built here rather than painted. Every voxel
// uses byte 0x20 (32), well past any palette: the total must still count them and
// validation must not call the model empty.
{
  const n = 3, cells = n*n*n;
  const junk = [
    '%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:', '--- !u!114 &11400000', 'MonoBehaviour:',
    '  m_ObjectHideFlags: 0', '  m_CorrespondingSourceObject: {fileID: 0}',
    '  m_PrefabInstance: {fileID: 0}', '  m_PrefabAsset: {fileID: 0}', '  m_GameObject: {fileID: 0}',
    '  m_Enabled: 1', '  m_EditorHideFlags: 0',
    '  m_Script: {fileID: 11500000, guid: 8154fcdcf86ef414a8a725fd872e9180, type: 3}',
    '  m_Name: JunkColour_Body', '  m_EditorClassIdentifier: Assembly-CSharp::VoxelVolley.VoxelBody',
    '  displayName: Junk', '  sourceImage: {fileID: 0}', '  sourceSlice: {fileID: 0}',
    `  size: ${n}`, '  depth: 3', '  smoothness: 0', '  alphaThreshold: 0.5', '  greyToWildcard: 0',
    '  layerRules: []', '  layerPatterns: []', '  unitRules: []',
    '  wrapInShell: 0', '  customCrateGrid: 0', '  crateRows: 3',
    '  crateCells: []', '  crateRefills: []', '  misplayTolerance: 0',
    '  colours: ' + '20'.repeat(cells), '  units: ' + '00'.repeat(cells),
    `  voxelCount: ${cells}`, '',
  ].join('\n');
  await page.click('#btnPaste');
  await page.waitForTimeout(250);
  await page.fill('#pasteArea', junk);
  await page.click('#pasteGo');
  await page.waitForTimeout(600);
  await page.click('#tabs button[data-tab="stats"]');
  await page.waitForTimeout(500);
  const t = (await page.textContent('#statsTbl')).replace(/\s+/g,' ');
  const v = (await page.textContent('#validList')).replace(/\s+/g,' ');
  check('junk-colour voxels counted in the total', /total\s*27\b/.test(t), t.slice(-60));
  check('junk-colour model is not reported empty', !/Model is empty/.test(v));
  check('junk colour flagged as having no palette entry', /no palette entry/.test(v), v.slice(0,150));
}

/* ---------- export still byte-identical after a tour ---------- */
await page.click('#btnSample');
await page.waitForTimeout(700);
await page.click('#btnCopy');
await page.waitForTimeout(400);
const yaml = await page.evaluate(() => navigator.clipboard.readText());
const orig = await readFile(join(ROOT,'samples/bird.asset'),'utf8');
check('export still byte-identical', yaml === orig, `${(yaml||'').length} vs ${orig.length}`);

check('no console errors throughout', errors.length === 0, errors.join(' | ').slice(0,300));
await page.keyboard.press('8');
await page.waitForTimeout(300);
await page.screenshot({ path:'features.png' });
await browser.close(); server.close();
console.log(fail ? '\n' + fail + ' FAILURE(S)' : '\nfeature test passed');
process.exit(fail ? 1 : 0);
