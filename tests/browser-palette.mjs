// End-to-end check that a chosen colour code reaches the .asset as
// VoxelBody.palette, and that a stock asset still exports byte-identically.
//     npm i --no-save playwright-core     (and Google Chrome installed)
//     node tests/browser-palette.mjs
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.asset':'text/plain'};
const server = createServer(async (rq,rs)=>{ try{
  let p=decodeURIComponent(new URL(rq.url,'http://x').pathname); if(p==='/')p='/index.html';
  const f=normalize(join(ROOT,p)); if(!f.startsWith(ROOT)) throw 0;
  rs.writeHead(200,{'content-type':MIME[extname(f)]||'application/octet-stream'}); rs.end(await readFile(f));
}catch{ rs.writeHead(404); rs.end(); }});
await new Promise(r=>server.listen(0,r));
const b = await chromium.launch({channel:'chrome',headless:true,args:['--use-angle=swiftshader']});
const ctx = await b.newContext({viewport:{width:1500,height:950},permissions:['clipboard-read','clipboard-write']});
const page = await ctx.newPage();
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
let fail=0; const ck=(n,ok,d)=>{console.log((ok?'  ✓ ':'  ✗ ')+n+(ok||!d?'':' — '+d)); if(!ok)fail++;};
await page.goto('http://localhost:'+server.address().port+'/',{waitUntil:'networkidle'});
await page.waitForTimeout(1500);
await page.click('#btnSample'); await page.waitForTimeout(700);
await page.click('#tabs button[data-tab="model"]'); await page.waitForTimeout(300);

// untouched sample: no palette in the asset, byte-identical export
ck('ship-colours starts off for a stock asset', !(await page.isChecked('#palOwn')));
await page.click('#btnCopy'); await page.waitForTimeout(400);
let y = await page.evaluate(()=>navigator.clipboard.readText());
const orig = await readFile(join(ROOT,'samples/bird.asset'),'utf8');
ck('stock asset exports byte-identical (no palette field)', y === orig);

// pick a colour → the asset gains VoxelBody.palette with that exact hex
await page.locator('#palEdit input[type=color]').nth(2).evaluate(el => {
  el.value = '#00ff00';
  el.dispatchEvent(new Event('input', {bubbles:true}));
});
await page.waitForTimeout(500);
ck('editing a colour turns ship-colours on', await page.isChecked('#palOwn'));
await page.click('#btnCopy'); await page.waitForTimeout(400);
y = await page.evaluate(()=>navigator.clipboard.readText());
ck('asset now carries a palette block', /\n  palette:\n/.test(y));
ck('and the chosen colour code is in it (0,255,0)', /- \{r: 0, g: 255, b: 0, a: 255\}/.test(y),
  (y.match(/palette:[\s\S]{0,200}/)||[''])[0].split('\n').slice(0,4).join(' | '));
ck('voxel grid is still one byte per cell (indices)',
  (y.match(/\n  colours: (\w+)/)||['',''])[1].length === 14**3*2);

// re-import it: the palette comes back and the file is stable
await page.click('#btnPaste'); await page.waitForTimeout(250);
await page.fill('#pasteArea', y);
await page.click('#pasteGo'); await page.waitForTimeout(700);
ck('re-imported asset keeps ship-colours on', await page.isChecked('#palOwn'));
const swatch = await page.locator('#palEdit input[type=color]').nth(2).inputValue();
ck('re-imported palette restores the green swatch', swatch === '#00ff00', swatch);
await page.click('#btnCopy'); await page.waitForTimeout(400);
const y2 = await page.evaluate(()=>navigator.clipboard.readText());
ck('palette asset round-trips byte-identically in the browser', y2 === y);

// untick → back to the shared palette, and the field disappears
await page.uncheck('#palOwn'); await page.waitForTimeout(500);
await page.click('#btnCopy'); await page.waitForTimeout(400);
const y3 = await page.evaluate(()=>navigator.clipboard.readText());
ck('unticking drops the palette field', !/\n  palette:\n/.test(y3));
ck('and restores the game colours', (await page.locator('#palEdit input[type=color]').nth(2).inputValue()) === '#e5484d');
ck('no page errors', errs.length===0, errs.join(' | ').slice(0,200));
await b.close(); server.close();
console.log(fail?`\n${fail} FAILURE(S)`:'\npalette round-trip passed');
process.exit(fail?1:0);
