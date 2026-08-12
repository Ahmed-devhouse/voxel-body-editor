// App bootstrap and wiring.

import {
  state, sel, EMPTY, defaultMeta,
  on, emit, pushUndo, undo, redo, setGrid, resizeGrid,
  voxelCount, serialize, deserialize,
} from './state.js';
import { parseAsset, exportAsset } from './asset.js';
import { PALETTE, colHex, setPaletteColour, resetPalette } from './palette.js';
import { setTool, setColour, setSlice, flip, shiftGrid, rotateY, hollow, clearAll } from './tools.js';
import { initSlice } from './slice.js';
import { initEditor3D, screenshot, setSpin, resetView } from './editor3d.js';
import { maskFromImage, voxelize } from './voxelize.js';
import { parseVox, voxToGrid } from './vox.js';
import * as lib from './library.js';
import { initCrates, renderCrates } from './crates.js';
import { initStats, updateStats } from './stats.js';
import {
  toast, openModal, closeModal, initModals, initTabs,
  tryAnchorDownload, trySavePicker, copyText, downloadDataURL,
} from './ui.js';

const $ = id => document.getElementById(id);

/* =====================================================================
   Model loading
===================================================================== */
function applyImported({ N, colours, units, meta }, label){
  pushUndo();
  state.meta = meta;
  setGrid(N, colours, units);
  emit('meta'); emit('model');
  if(label) toast(label);
}
function importAssetText(text){
  try{
    const parsed = parseAsset(text);
    applyImported(parsed, 'Imported "' + parsed.meta.name + '" — ' + voxelCount() + ' voxels, ' + parsed.N + '³ grid');
    return true;
  }catch(err){
    toast('Import failed: ' + err.message, true);
    return false;
  }
}
function newModel(){
  pushUndo();
  state.meta = defaultMeta();
  setGrid(14, new Uint8Array(14*14*14).fill(EMPTY), new Uint8Array(14*14*14));
  emit('meta'); emit('model');
  toast('New model (undo restores the previous one)');
}
async function loadSample(){
  try{
    const res = await fetch('samples/bird.asset');
    if(!res.ok) throw new Error('HTTP ' + res.status);
    importAssetText(await res.text());
  }catch(err){
    toast('Could not load sample: ' + err.message, true);
  }
}

/* =====================================================================
   Top bar
===================================================================== */
function exportFilename(){
  return (state.meta.name.replace(/[^\w\-. ]+/g,'_') || 'VoxelBody') + '.asset';
}
function currentYaml(){ return exportAsset(state); }

function openExportModal(yaml, fname, downloadTried){
  $('expMsg').innerHTML = (downloadTried
    ? 'A download of <b>' + fname + '</b> was attempted. If nothing arrived, use the buttons below.'
    : 'Save or copy <b>' + fname + '</b> below.')
    + ' Put the content into a file with that exact name inside your Unity project’s Assets folder.';
  $('expArea').value = yaml;
  $('expSave').style.display = window.showSaveFilePicker ? '' : 'none';
  openModal('exportModal');
}
async function doExport(){
  const yaml = currentYaml(), fname = exportFilename();
  const picked = await trySavePicker(yaml, fname, '.asset');
  if(picked === true){ toast('Saved ' + fname + ' — ' + voxelCount() + ' voxels'); return; }
  if(picked === 'abort') return;
  const anchored = tryAnchorDownload(yaml, fname);
  if(anchored) toast('Exported ' + fname + ' — check your Downloads folder');
  else openExportModal(yaml, fname, false);
}

// names are written into unquoted YAML scalars — strip characters that would
// change the YAML structure (Unity's importer would reject or truncate them)
function safeYamlScalar(s){
  return s.replace(/[:#{}[\]&*!|>'"%@`\\]/g, '').replace(/\s+/g, ' ');
}
function wireTopbar(){
  $('fName').addEventListener('input', e => {
    state.meta.name = safeYamlScalar(e.target.value).trim() || 'Body';
    emit('meta');
  });
  $('fDisplay').addEventListener('input', e => {
    state.meta.displayName = safeYamlScalar(e.target.value);
    emit('meta');
  });

  $('btnNew').addEventListener('click', newModel);
  $('btnSample').addEventListener('click', loadSample);
  $('btnExport').addEventListener('click', doExport);
  $('btnCopy').addEventListener('click', async () => {
    const yaml = currentYaml();
    if(await copyText(yaml)) toast('YAML copied to clipboard');
    else openExportModal(yaml, exportFilename(), false);
  });
  $('btnShot').addEventListener('click', () => {
    downloadDataURL(screenshot(), (state.meta.name || 'voxel') + '.png');
    toast('Screenshot saved');
  });

  $('btnImportAsset').addEventListener('click', () => $('fileAsset').click());
  $('fileAsset').addEventListener('change', e => {
    const f = e.target.files[0];
    if(!f) return;
    f.text().then(importAssetText).catch(err => toast('Read failed: ' + err.message, true));
    e.target.value = '';
  });

  $('btnPaste').addEventListener('click', () => openModal('pasteModal'));
  $('pasteGo').addEventListener('click', () => {
    const t = $('pasteArea').value;
    closeModal('pasteModal');
    if(t.trim()) importAssetText(t);
  });

  $('btnImportVox').addEventListener('click', () => $('fileVox').click());
  $('fileVox').addEventListener('change', async e => {
    const f = e.target.files[0];
    if(!f) return;
    e.target.value = '';
    try{
      const grid = voxToGrid(parseVox(await f.arrayBuffer()));
      const meta = defaultMeta();
      meta.name = f.name.replace(/\.vox$/i,'').replace(/[^\w\-]+/g,'_') + '_Body';
      meta.displayName = f.name.replace(/\.vox$/i,'');
      meta.depth = grid.N;
      applyImported({ N: grid.N, colours: grid.colours, units: grid.units, meta },
        'Imported ' + grid.voxels + ' voxels from .vox' + (grid.scaled ? ' (scaled down to fit ' + grid.N + '³)' : '') +
        ' — colours mapped to nearest of the 5 game colours');
    }catch(err){
      toast('.vox import failed: ' + err.message, true);
    }
  });

  // export modal buttons
  $('expSave').addEventListener('click', async () => {
    const r = await trySavePicker($('expArea').value, exportFilename(), '.asset');
    if(r === true){ toast('Saved ' + exportFilename()); closeModal('exportModal'); }
    else if(r === false) toast('File picker blocked here — use Copy YAML', true);
  });
  $('expDownload').addEventListener('click', () => {
    tryAnchorDownload($('expArea').value, exportFilename());
    toast('Download attempted — check your Downloads folder');
  });
  $('expCopy').addEventListener('click', async () => {
    if(await copyText($('expArea').value)) toast('YAML copied — paste into ' + exportFilename());
    else{
      $('expArea').focus(); $('expArea').select();
      toast('Clipboard blocked — text selected, press Ctrl/Cmd+C', true);
    }
  });

  $('btnHelp').addEventListener('click', () => openModal('helpModal'));
}

/* =====================================================================
   Tool rail
===================================================================== */
function wireToolRail(){
  document.querySelectorAll('.toolbtn').forEach(b =>
    b.addEventListener('click', () => setTool(b.dataset.tool)));

  const pal = $('palette');
  PALETTE.forEach((hex, i) => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = hex;
    b.title = 'Colour ' + i + ' (key ' + (i+1) + ')';
    b.innerHTML = '<b>' + i + '</b>';
    b.addEventListener('click', () => setColour(i));
    pal.appendChild(b);
  });

  $('unitKind').addEventListener('change', e => {
    sel.unitKind = Math.max(1, parseInt(e.target.value) || 1);
    emit('sel');
  });
  $('chkSymX').addEventListener('click', () => { sel.symX = !sel.symX; emit('sel'); });
  $('chkSymZ').addEventListener('click', () => { sel.symZ = !sel.symZ; emit('sel'); });

  document.querySelectorAll('[data-flip]').forEach(b =>
    b.addEventListener('click', () => flip(b.dataset.flip)));
  document.querySelectorAll('[data-shift]').forEach(b =>
    b.addEventListener('click', () => {
      const [a, d] = b.dataset.shift.split(',');
      shiftGrid(a, parseInt(d));
    }));
  $('btnRotateY').addEventListener('click', rotateY);
  $('btnHollow').addEventListener('click', () => {
    const n = hollow();
    toast(n ? 'Removed ' + n + ' interior voxels' : 'Nothing to hollow');
  });
  $('btnUndo').addEventListener('click', undo);
  $('btnRedo').addEventListener('click', redo);
  $('btnClear').addEventListener('click', () => { clearAll(); toast('Grid cleared (undo restores it)'); });

  on('sel', () => {
    document.querySelectorAll('.toolbtn').forEach(b =>
      b.classList.toggle('active', b.dataset.tool === sel.tool));
    document.querySelectorAll('.swatch').forEach((s, i) =>
      s.classList.toggle('active', i === sel.colour));
    $('chkSymX').classList.toggle('on', sel.symX);
    $('chkSymZ').classList.toggle('on', sel.symZ);
  });
  on('palette', () => {
    document.querySelectorAll('#palette .swatch').forEach((s, i) => s.style.background = PALETTE[i]);
  });
}

/* =====================================================================
   Pane header toggles
===================================================================== */
function wirePaneToggles(){
  $('chkOnion').checked = sel.onion;
  $('chkOnion').addEventListener('change', e => { sel.onion = e.target.checked; emit('sel'); });
  $('chkCoords').addEventListener('change', e => { sel.coords = e.target.checked; emit('sel'); });
  $('chkHiLayer').addEventListener('change', e => { sel.hiLayer = e.target.checked; emit('sel'); });
  $('chkSpin').addEventListener('change', e => setSpin(e.target.checked));
  $('btnResetView').addEventListener('click', resetView);
}

/* =====================================================================
   Inspector: model tab
===================================================================== */
function bindModelFields(){
  const m = state.meta;
  $('fName').value = m.name;
  $('fDisplay').value = m.displayName;
  $('fSize').value = state.N;
  $('fDepth').value = m.depth;
  $('fSmooth').value = m.smoothness;
  $('fAlpha').value = m.alphaThreshold;
  $('fGrey').checked = !!m.greyToWildcard;
  $('fShell').checked = !!m.wrapInShell;
  $('fMisplay').value = m.misplayTolerance;
  $('fGuid').value = m.scriptGuid;
  $('fCustomGrid').checked = !!m.customCrateGrid;
  $('fCrateRows').value = m.crateRows;
}
function wireModelTab(){
  const set = (id, fn, ev) => $(id).addEventListener(ev || 'change', e => { fn(e.target); emit('meta'); });
  set('fDepth', t => state.meta.depth = Math.max(1, parseInt(t.value) || 1));
  set('fSmooth', t => state.meta.smoothness = parseFloat(t.value) || 0);
  set('fAlpha', t => state.meta.alphaThreshold = parseFloat(t.value) || 0);
  set('fGrey', t => state.meta.greyToWildcard = t.checked ? 1 : 0);
  set('fShell', t => state.meta.wrapInShell = t.checked ? 1 : 0);
  set('fMisplay', t => state.meta.misplayTolerance = Math.max(0, parseInt(t.value) || 0));
  set('fGuid', t => state.meta.scriptGuid = t.value.trim() || defaultMeta().scriptGuid, 'input');
  set('fCustomGrid', t => state.meta.customCrateGrid = t.checked ? 1 : 0);
  set('fCrateRows', t => state.meta.crateRows = Math.max(1, parseInt(t.value) || 1));
  $('btnResize').addEventListener('click', () => {
    if(resizeGrid(parseInt($('fSize').value) || state.N))
      toast('Resized to ' + state.N + '³ (content centered)');
    $('fSize').value = state.N;
  });

  // display palette editor
  const pe = $('palEdit');
  for(let i=0; i<5; i++){
    const wrap = document.createElement('div');
    wrap.className = 'pe';
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = PALETTE[i];
    inp.addEventListener('input', () => setPaletteColour(i, inp.value));
    wrap.appendChild(inp);
    wrap.appendChild(Object.assign(document.createElement('span'), { textContent: 'c' + i }));
    pe.appendChild(wrap);
  }
  $('palReset').addEventListener('click', () => {
    resetPalette();
    document.querySelectorAll('#palEdit input').forEach((inp, i) => inp.value = PALETTE[i]);
    toast('Palette reset');
  });
  on('gridsize', () => { $('fSize').value = state.N; });
}

/* =====================================================================
   Inspector: rules tab
===================================================================== */
function colourOptions(v){
  let h = '';
  for(let i=0;i<5;i++) h += `<option value="${i}" ${v===i?'selected':''}>c${i}</option>`;
  return h;
}
function renderRules(){
  const lt = $('layerRulesTbl');
  lt.innerHTML = '<tr><th>layer</th><th>colour</th><th>%</th><th></th></tr>';
  state.meta.layerRules.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input type="number" value="${r.layer}" min="0" data-k="layer"></td>
      <td><select data-k="colour">${colourOptions(r.colour)}</select></td>
      <td><input type="number" value="${r.percent}" min="0" max="100" data-k="percent"></td>
      <td><button class="del" title="Remove">×</button></td>`;
    tr.querySelectorAll('[data-k]').forEach(el =>
      el.addEventListener('change', () => { r[el.dataset.k] = parseInt(el.value) || 0; emit('meta'); }));
    tr.querySelector('.del').addEventListener('click', () => {
      state.meta.layerRules.splice(i,1); renderRules(); emit('meta');
    });
    lt.appendChild(tr);
  });
  const ut = $('unitRulesTbl');
  ut.innerHTML = '<tr><th>layer</th><th>kind</th><th>count</th><th></th></tr>';
  state.meta.unitRules.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input type="number" value="${r.layer}" min="0" data-k="layer"></td>
      <td><input type="number" value="${r.kind}" min="1" data-k="kind"></td>
      <td><input type="number" value="${r.count}" min="0" data-k="count"></td>
      <td><button class="del" title="Remove">×</button></td>`;
    tr.querySelectorAll('[data-k]').forEach(el =>
      el.addEventListener('change', () => { r[el.dataset.k] = parseInt(el.value) || 0; emit('meta'); }));
    tr.querySelector('.del').addEventListener('click', () => {
      state.meta.unitRules.splice(i,1); renderRules(); emit('meta');
    });
    ut.appendChild(tr);
  });
}
function wireRulesTab(){
  $('addLayerRule').addEventListener('click', () => {
    state.meta.layerRules.push({layer: state.meta.layerRules.length, colour:0, percent:100});
    renderRules(); emit('meta');
  });
  $('addUnitRule').addEventListener('click', () => {
    state.meta.unitRules.push({layer: state.meta.unitRules.length, kind:1, count:1});
    renderRules(); emit('meta');
  });
}

/* =====================================================================
   PNG generator modal
===================================================================== */
let srcImg = null;
function previewGen(){
  if(!srcImg) return;
  const scv = $('imgSrcCv'), sx = scv.getContext('2d');
  sx.clearRect(0,0,128,128);
  const s = Math.min(128/srcImg.width, 128/srcImg.height);
  sx.drawImage(srcImg, (128-srcImg.width*s)/2, (128-srcImg.height*s)/2, srcImg.width*s, srcImg.height*s);
  const n = parseInt($('gSize').value);
  const mask = maskFromImage(srcImg, n, $('gAlpha').value/100, parseInt($('gSmooth').value));
  const mcv = $('imgMaskCv'), mx = mcv.getContext('2d');
  mx.clearRect(0,0,128,128);
  const c = 128/n;
  mx.fillStyle = '#ffc93c';
  for(let y=0;y<n;y++) for(let x=0;x<n;x++)
    if(mask[x+y*n]) mx.fillRect(x*c+0.5, y*c+0.5, c-1, c-1);
}
function wireImageModal(){
  $('btnImage').addEventListener('click', () => openModal('imgModal'));
  $('pickImg').addEventListener('click', () => $('fileImage').click());
  $('fileImage').addEventListener('change', e => {
    const f = e.target.files[0];
    if(!f) return;
    e.target.value = '';
    const img = new Image();
    const url = URL.createObjectURL(f);
    img.onload = () => {
      URL.revokeObjectURL(url);
      srcImg = img;
      $('imgName').textContent = f.name;
      $('genGo').disabled = false;
      previewGen();
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast('Could not load image', true); };
    img.src = url;
  });
  ['gSize','gDepth','gAlpha','gSmooth','gRound'].forEach(id =>
    $(id).addEventListener('input', () => {
      $('oSize').textContent = $('gSize').value;
      $('oDepth').textContent = $('gDepth').value;
      $('oAlpha').textContent = ($('gAlpha').value/100).toFixed(2);
      $('oSmooth').textContent = $('gSmooth').value;
      $('oRound').textContent = $('gRound').value;
      previewGen();
    }));
  $('genGo').addEventListener('click', () => {
    if(!srcImg) return;
    const n = parseInt($('gSize').value);
    const mask = maskFromImage(srcImg, n, $('gAlpha').value/100, parseInt($('gSmooth').value));
    const out = voxelize(mask, {
      size: n,
      depth: parseInt($('gDepth').value),
      rounding: $('gRound').value/100,
      layerRules: state.meta.layerRules,
      unitRules: state.meta.unitRules,
      placeUnits: $('gUnits').checked,
    });
    const meta = JSON.parse(JSON.stringify(state.meta));
    meta.depth = Math.min(parseInt($('gDepth').value), n);
    meta.smoothness = parseInt($('gSmooth').value);
    meta.alphaThreshold = parseFloat(($('gAlpha').value/100).toFixed(3));
    const base = $('imgName').textContent.replace(/\.[^.]+$/, '');
    meta.name = (base.replace(/[^\w\-]+/g,'_') || 'Generated') + '_Body';
    meta.displayName = base.replace(/[-_]+/g,' ');
    meta.sourceImageRaw = '{fileID: 0}';
    closeModal('imgModal');
    applyImported({ N: out.N, colours: out.colours, units: out.units, meta },
      'Generated ' + voxelCount() + ' voxels — tune it in the editor');
  });
}

/* =====================================================================
   Library tab
===================================================================== */
async function renderLibrary(){
  const list = $('libList');
  list.innerHTML = '';
  let models = [];
  try{ models = await lib.listModels(); }
  catch{ list.innerHTML = '<p class="note">Library unavailable in this browser (private browsing?).</p>'; return; }
  if(!models.length){ list.innerHTML = '<p class="note">Nothing saved yet — “save current” stores the open model here.</p>'; return; }
  for(const m of models){
    const d = document.createElement('div');
    d.className = 'libItem';
    d.innerHTML = (m.thumb ? `<img src="${m.thumb}" alt="">` : '<span class="noThumb">▦</span>') +
      `<span class="meta"><b>${escapeHtml(m.name)}</b><span>${new Date(m.updatedAt).toLocaleString()}</span></span>
       <button class="load">load</button><button class="del" title="Delete from library">×</button>`;
    d.querySelector('.load').addEventListener('click', async () => {
      try{
        const rec = await lib.getModel(m.id);
        pushUndo();
        deserialize(rec.data);
        toast('Loaded "' + rec.name + '" from library');
      }catch(err){ toast('Load failed: ' + err.message, true); }
    });
    d.querySelector('.del').addEventListener('click', async () => {
      await lib.deleteModel(m.id);
      renderLibrary();
      toast('Deleted "' + m.name + '"');
    });
    list.appendChild(d);
  }
}
async function renderTeam(){
  const list = $('teamList');
  list.innerHTML = '<p class="note">Loading…</p>';
  const levels = await lib.fetchTeamLevels();
  list.innerHTML = '';
  if(!levels.length){
    list.innerHTML = '<p class="note">No team levels found (levels/index.json missing or empty — works once hosted).</p>';
    return;
  }
  for(const lv of levels){
    const d = document.createElement('div');
    d.className = 'libItem';
    d.innerHTML = `<span class="noThumb">⛃</span>
      <span class="meta"><b>${escapeHtml(lv.name)}</b><span>${escapeHtml(lv.path)}</span></span>
      <button class="load">load</button>`;
    d.querySelector('.load').addEventListener('click', async () => {
      try{ importAssetText(await lib.fetchTeamAsset(lv.path)); }
      catch(err){ toast(err.message, true); }
    });
    list.appendChild(d);
  }
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function wireLibrary(){
  $('libSave').addEventListener('click', async () => {
    try{
      await lib.saveModel({ name: state.meta.name, data: serialize(), thumb: screenshot(96) });
      renderLibrary();
      toast('Saved "' + state.meta.name + '" to this browser\'s library');
    }catch(err){ toast('Save failed: ' + err.message, true); }
  });
  $('btnRefreshTeam').addEventListener('click', renderTeam);
}

/* =====================================================================
   Keyboard
===================================================================== */
function wireKeyboard(){
  window.addEventListener('keydown', e => {
    const k = e.key.toLowerCase();
    // Ctrl/Cmd+S always means "export" — even with a field focused, the
    // browser's Save Page dialog would otherwise open (help modal documents it)
    if((e.ctrlKey || e.metaKey) && k === 's'){ e.preventDefault(); doExport(); return; }
    // only text-entry contexts swallow shortcuts; sliders, checkboxes and
    // colour wells keep focus after a click and must not kill the hotkeys
    if(e.target.matches('textarea, select, input[type=text], input[type=number], input[type=search]')) return;
    if((e.ctrlKey || e.metaKey) && k === 'z'){ e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if((e.ctrlKey || e.metaKey) && k === 'y'){ e.preventDefault(); redo(); return; }
    if(e.ctrlKey || e.metaKey) return;
    if(k === 'a') setTool('build');
    else if(k === 'b') setTool('paint');
    else if(k === 'r') setTool('rect');
    else if(k === 'e') setTool('erase');
    else if(k === 'g') setTool('fill');
    else if(k === 'i') setTool('pick');
    else if(k === 'u') setTool('unit');
    else if(k === '[') setSlice(sel.slice - 1);
    else if(k === ']') setSlice(sel.slice + 1);
    else if(k === 'x'){ sel.symX = !sel.symX; emit('sel'); }
    else if(k === 'z'){ sel.symZ = !sel.symZ; emit('sel'); }
    else if(k === '?') openModal('helpModal');
    else if(k >= '1' && k <= '5') setColour(parseInt(k) - 1);
  });
}

/* =====================================================================
   Boot
===================================================================== */
async function boot(){
  initModals();
  initTabs(tab => {
    if(tab === 'stats') updateStats();
    if(tab === 'library'){ renderLibrary(); renderTeam(); }
  });
  wireTopbar();
  wireToolRail();
  wirePaneToggles();
  wireModelTab();
  wireRulesTab();
  wireImageModal();
  wireLibrary();
  wireKeyboard();
  initCrates();
  initStats();
  initSlice();
  initEditor3D();

  on('model', () => { bindModelFields(); renderRules(); renderCrates(); });
  on('gridsize', bindModelFields);

  // autosave: any change persists (debounced) for crash recovery
  const persist = () => lib.scheduleAutosave(serialize);
  on('grid', persist);
  on('meta', persist);

  // restore last session, else load the sample
  let restored = false;
  try{
    const auto = await lib.getAutosave();
    if(auto && auto.data){
      deserialize(auto.data);
      restored = true;
      toast('Restored your last session (File ▸ Sample reloads the bird)');
    }
  }catch{ /* fall through */ }
  if(!restored) await loadSample();

  bindModelFields();
  renderRules();
  renderCrates();
  setSlice(Math.floor(state.N/2));
  emit('sel');
}

boot();
