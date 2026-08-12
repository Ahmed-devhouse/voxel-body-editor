// App bootstrap and wiring.

import {
  state, sel, EMPTY, MIN_N, MAX_N, defaultMeta, resizeWouldClip,
  on, emit, pushUndo, undo, redo, setGrid, resizeGrid,
  voxelCount, serialize, deserialize,
} from './state.js';
import { parseAsset, exportAsset } from './asset.js';
import {
  PALETTE, GAME_COLOURS, MAX_COLOURS, colourCount, labelOf, isBeyondGame,
  setPaletteColour, setPaletteLabel, addPaletteColour, removeLastPaletteColour, resetPalette,
  adoptModelPalette, commitPaletteToModel, clearModelPalette, modelCarriesPalette,
} from './palette.js';
import {
  setTool, setColour, setSlice, setSliceAxis, setBrush,
  flip, shiftGrid, rotateY, hollow, clearAll,
  copySlice, pasteSlice, duplicateSlice, clearSlice, fillSlice,
  centreModel, trimToContent, replaceColour, deleteColour,
} from './tools.js';
import { initSlice, setReferenceImage } from './slice.js';
import { initEditor3D, screenshot, setSpin, resetView } from './editor3d.js';
import { maskFromImage, voxelize } from './voxelize.js';
import { parseVox, voxToGrid } from './vox.js';
import * as lib from './library.js';
import { initCrates, renderCrates, remapRows } from './crates.js';
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
        ' — colours mapped to the game palette (near-greys → X wildcard)');
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

  renderSwatches();
  $('palAdd').addEventListener('click', addColour);
  $('palDel').addEventListener('click', dropColour);

  $('unitKind').addEventListener('change', e => {
    sel.unitKind = Math.max(1, parseInt(e.target.value) || 1);
    emit('sel');
  });
  $('chkSymX').addEventListener('click', () => { sel.symX = !sel.symX; emit('sel'); });
  $('chkSymZ').addEventListener('click', () => { sel.symZ = !sel.symZ; emit('sel'); });
  document.querySelectorAll('[data-brush]').forEach(b =>
    b.addEventListener('click', () => setBrush(parseInt(b.dataset.brush))));

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
  $('btnCentre').addEventListener('click', () => {
    const err = centreModel();
    toast(err || 'Centred on the floor', !!err);
  });
  $('btnTrim').addEventListener('click', () => {
    const before = state.N;
    const err = trimToContent(0);
    toast(err || `Trimmed ${before}³ → ${state.N}³ — coarser, cleaner voxels in play`, !!err);
  });
  $('btnUndo').addEventListener('click', undo);
  $('btnRedo').addEventListener('click', redo);
  $('btnClear').addEventListener('click', () => { clearAll(); toast('Grid cleared (undo restores it)'); });

  on('sel', () => {
    document.querySelectorAll('.toolbtn').forEach(b =>
      b.classList.toggle('active', b.dataset.tool === sel.tool));
    document.querySelectorAll('#palette .swatch').forEach((s, i) =>
      s.classList.toggle('active', i === sel.colour));
    document.querySelectorAll('[data-brush]').forEach(b =>
      b.classList.toggle('on', parseInt(b.dataset.brush) === sel.brush));
    $('chkSymX').classList.toggle('on', sel.symX);
    $('chkSymZ').classList.toggle('on', sel.symZ);
  });
  // 'palette' fires on every colour-well input tick, and renderCrates rebuilds up
  // to 5×64 cards, so the heavier panels are debounced the way stats.js is.
  let palTimer = null;
  on('palette', () => {
    renderSwatches(); renderPaletteEditor(); renderColourSelects();
    clearTimeout(palTimer);
    palTimer = setTimeout(() => { renderRules(); renderCrates(); }, 120);
  });
}

/* ---------- build grid size ---------- */
function syncSizeUI(){
  const s = $('fSize'), r = $('fSizeRange');
  if(!s) return;
  s.value = state.N;
  if(r) r.value = state.N;
  document.querySelectorAll('[data-size]').forEach(b => {
    const n = parseInt(b.dataset.size);
    b.classList.toggle('on', n === state.N);
  });
  updateSizeNote(state.N);
}
function updateSizeNote(n){
  const el = $('sizeNote');
  if(!el) return;
  const cells = n*n*n;
  const shellN = state.meta.wrapInShell ? n + 4 : n;
  const shell = state.meta.wrapInShell ? shellN**3 - (shellN-2)**3 : 0;
  let msg = `<b>${n}³</b> = ${cells.toLocaleString()} cells`;
  if(shell) msg += `; shelled, the level grid is ${shellN}³ and the shell alone adds ` +
    `${shell.toLocaleString()} voxels to shoot`;
  msg += '. Every body spans the same world size, so a bigger grid means finer voxels, not a bigger model.';
  // measured: 128³ exports in ~230 ms to an 8 MB asset, so only really large
  // grids are worth a word — 64³ is comfortable
  if(cells > 500000)
    msg += ` <span class="warnA">${cells.toLocaleString()} cells: rebuilds get slower, the undo history` +
           ` gets shallower (it is memory-bounded) and the .asset will be around` +
           ` ${Math.round(cells*4/1048576)} MB.</span>`;
  el.innerHTML = msg;
}

/* ---------- palette ---------- */
function syncPaletteOwnership(){
  const own = $('palOwn');
  if(own) own.checked = modelCarriesPalette();
}
function renderSwatches(){
  const pal = $('palette');
  pal.innerHTML = '';
  PALETTE.forEach((entry, i) => {
    const b = document.createElement('button');
    b.className = 'swatch' + (i === sel.colour ? ' active' : '') + (isBeyondGame(i) ? ' beyond' : '');
    b.style.background = entry.hex;
    // only 1–6 select colours; 7/8/9 switch the slice view
    b.title = entry.label + ' — ' + entry.name + (i < 6 ? ' (key ' + (i+1) + ')' : '') +
      (isBeyondGame(i) ? ' — beyond this game build' : '');
    b.innerHTML = '<b>' + escapeHtml(entry.label) + '</b>';
    b.addEventListener('click', () => setColour(i));
    pal.appendChild(b);
  });
  $('palDel').disabled = colourCount() <= GAME_COLOURS;
  $('palAdd').disabled = colourCount() >= MAX_COLOURS;
}
function addColour(){
  const i = addPaletteColour();
  if(i < 0){ toast('Palette is full (' + MAX_COLOURS + ' colours)', true); return; }
  setColour(i);
  toast('Added colour ' + i + ' — the game build only renders 0–' + (GAME_COLOURS-1) +
        ', so extend Palette.cs and Cols before shipping it', true);
}
function dropColour(){
  const last = colourCount() - 1;
  let used = 0;
  for(let k=0;k<state.colours.length;k++) if(state.colours[k] === last) used++;
  if(used && !confirm(`${used} voxel(s) use colour ${last}. Removing it leaves them showing as unknown. Remove anyway?`)) return;
  if(!removeLastPaletteColour()){ toast('The first ' + GAME_COLOURS + ' colours are the game\'s own', true); return; }
  if(sel.colour >= colourCount()) setColour(colourCount()-1);
  toast('Removed the last colour');
}
function renderPaletteEditor(){
  const pe = $('palEdit');
  if(!pe) return;
  syncPaletteOwnership();      // before the in-place fast path below returns
  // Refresh in place when the row count is unchanged. A full rebuild would
  // detach the very colour well being dragged — its own 'input' event fires
  // 'palette', and replacing the live input kills the drag after one tick.
  // Adding, dropping or resetting changes the count and still rebuilds.
  const rows = pe.querySelectorAll('.pe');
  if(rows.length === PALETTE.length){
    rows.forEach((wrap, i) => {
      const entry = PALETTE[i];
      wrap.classList.toggle('beyond', isBeyondGame(i));
      const col = wrap.querySelector('input[type=color]');
      const lab = wrap.querySelector('input[type=text]');
      if(col && col !== document.activeElement && col.value !== entry.hex) col.value = entry.hex;
      if(lab && lab !== document.activeElement && lab.value !== entry.label) lab.value = entry.label;
    });
    return;
  }
  pe.innerHTML = '';
  PALETTE.forEach((entry, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'pe' + (isBeyondGame(i) ? ' beyond' : '');
    const inp = document.createElement('input');
    inp.type = 'color'; inp.value = entry.hex;
    inp.title = 'Colour ' + i + ' — ' + entry.name;
    inp.addEventListener('input', () => setPaletteColour(i, inp.value));
    const lab = document.createElement('input');
    lab.type = 'text'; lab.value = entry.label; lab.maxLength = 3;
    lab.title = 'Short label for colour ' + i;
    lab.addEventListener('change', () => setPaletteLabel(i, lab.value));
    const num = document.createElement('span');
    num.className = 'idxLbl'; num.textContent = i;
    wrap.append(inp, lab, num);
    pe.appendChild(wrap);
  });
  const note = $('palNote');
  if(note) note.innerHTML =
    'A voxel stores a colour <b>index</b>, never a hex code — the index is what a bullet matches on and ' +
    'what crates are minted in, so it cannot be an arbitrary RGB value. What each index <i>looks like</i> ' +
    'is the palette, and with the box above ticked it is written into the asset as <b>VoxelBody.palette</b>, ' +
    'so the game renders exactly these colours for this body. Unticked, the body uses the shared ' +
    '<b>Palette.cs</b> and the swatches here are only a preview. Colours 0\u20134 are the crate colours, ' +
    '5 is the X wildcard any bullet clears; anything past ' + (GAME_COLOURS-1) + ' still needs <b>Cols</b> ' +
    'extended in Unity before a crate can hit it.';
}
function renderColourSelects(){
  const opts = PALETTE.map((e,i) =>
    `<option value="${i}">${i} ${escapeHtml(e.label)}${isBeyondGame(i) ? ' ⚠' : ''}</option>`).join('');
  for(const id of ['swapFrom','swapTo','delColour']){
    const el = $(id);
    if(!el) continue;
    const keep = el.value;
    el.innerHTML = opts;
    if(keep !== '' && +keep < colourCount()) el.value = keep;
  }
  const sf = $('swapFrom'), st = $('swapTo');
  if(sf && st && sf.value === st.value && colourCount() > 1) st.value = String((+sf.value + 1) % colourCount());
}

/* =====================================================================
   Pane header toggles
===================================================================== */
function wirePaneToggles(){
  $('chkOnion').checked = sel.onion;
  $('chkOnion').addEventListener('change', e => { sel.onion = e.target.checked; emit('sel'); });
  $('chkCoords').addEventListener('change', e => { sel.coords = e.target.checked; emit('sel'); });
  $('chkHiLayer').addEventListener('change', e => { sel.hiLayer = e.target.checked; emit('sel'); });
  $('chkIsolate').addEventListener('change', e => {
    sel.isolate = e.target.checked;
    emit('sel'); emit('grid');   // the 3D mesh has to be rebuilt, not just recoloured
  });
  $('chkSpin').addEventListener('change', e => setSpin(e.target.checked));
  $('btnResetView').addEventListener('click', resetView);

  // slice axis
  document.querySelectorAll('[data-axis]').forEach(b =>
    b.addEventListener('click', () => setSliceAxis(b.dataset.axis)));

  // slice operations
  const op = (id, fn) => $(id).addEventListener('click', fn);
  op('opCopy', () => { copySlice(); toast('Slice copied'); });
  op('opPaste', () => { const e = pasteSlice(); toast(e || 'Slice pasted', !!e); });
  op('opDupUp', () => { const e = duplicateSlice(1); toast(e || 'Duplicated upward', !!e); });
  op('opDupDown', () => { const e = duplicateSlice(-1); toast(e || 'Duplicated downward', !!e); });
  op('opFill', () => { const e = fillSlice(); toast(e || 'Slice filled', !!e); });
  op('opClear', () => { const e = clearSlice(); toast(e || 'Slice cleared', !!e); });

  // tracing image
  $('btnRefImg').addEventListener('click', () => {
    if(hasRef){ setReferenceImage(null); hasRef = false; $('btnRefImg').classList.remove('on'); toast('Tracing image removed'); }
    else $('fileRef').click();
  });
  $('fileRef').addEventListener('change', e => {
    const f = e.target.files[0];
    e.target.value = '';
    if(!f) return;
    const img = new Image();
    const url = URL.createObjectURL(f);
    img.onload = () => {
      URL.revokeObjectURL(url);
      setReferenceImage(img);
      hasRef = true;
      $('btnRefImg').classList.add('on');
      toast('Tracing ' + f.name + ' — try the front view (key 8) for a side-on sprite');
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast('Could not load that image', true); };
    img.src = url;
  });
  $('refOpacity').addEventListener('input', e => {
    sel.refOpacity = Math.max(0.05, Math.min(0.9, parseInt(e.target.value)/100));
    emit('sel');
  });
}
let hasRef = false;

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
  set('fSmooth', t => state.meta.smoothness =
    Math.min(100, Math.max(0, parseInt(t.value) || 0)));   // [Range(0, 100)] int
  set('fAlpha', t => state.meta.alphaThreshold = parseFloat(t.value) || 0);
  set('fGrey', t => state.meta.greyToWildcard = t.checked ? 1 : 0);
  set('fShell', t => state.meta.wrapInShell = t.checked ? 1 : 0);
  set('fMisplay', t => state.meta.misplayTolerance =
    Math.min(0.5, Math.max(0, parseFloat(t.value) || 0)));   // float share of taps, [Range(0, 0.5)]
  set('fGuid', t => state.meta.scriptGuid = t.value.trim() || defaultMeta().scriptGuid, 'input');
  set('fCustomGrid', t => { state.meta.customCrateGrid = t.checked ? 1 : 0; renderCrates(); });
  set('fCrateRows', t => {
    const raw = parseInt(t.value);
    if(!Number.isFinite(raw)){ t.value = state.meta.crateRows; return; }  // don't collapse the board on a blank field
    const next = Math.min(64, Math.max(1, raw));                          // CratePlan.MaxRows = 64
    t.value = next;                                                       // show what was actually stored
    if(next === state.meta.crateRows) return;
    if(next < state.meta.crateRows) pushUndo();   // shrinking discards rows — make it undoable
    remapRows(state.meta.crateRows, next);        // keep columns intact when the stride changes
    state.meta.crateRows = next;
    renderCrates();
  });
  /* ---------- build grid size ---------- */
  const applySize = n => {
    const want = Math.max(MIN_N, Math.min(MAX_N, n|0));
    if(want === state.N){ syncSizeUI(); return; }
    // only warn when voxels genuinely have to be cut — resizeGrid clamps the
    // shift so anything that fits survives
    if(resizeWouldClip(want) && !confirm(
      `The model is bigger than ${want}³ and part of it will be cut off. ` +
      `"trim" resizes to fit without losing anything. Continue?`)){
      syncSizeUI();
      return;
    }
    if(resizeGrid(want)) toast('Build grid is now ' + state.N + '³ (content centred)');
    syncSizeUI();
  };
  $('btnResize').addEventListener('click', () => applySize(parseInt($('fSize').value) || state.N));
  $('fSize').addEventListener('keydown', e => { if(e.key === 'Enter') applySize(parseInt($('fSize').value) || state.N); });
  // the slider previews the number live and applies on release, so a drag does
  // not rebuild the grid dozens of times
  $('fSizeRange').addEventListener('input', e => {
    $('fSize').value = e.target.value;
    updateSizeNote(parseInt(e.target.value));
  });
  $('fSizeRange').addEventListener('change', e => applySize(parseInt(e.target.value)));
  document.querySelectorAll('[data-size]').forEach(b =>
    b.addEventListener('click', () => applySize(parseInt(b.dataset.size))));

  renderPaletteEditor();
  renderColourSelects();
  $('palAdd2').addEventListener('click', addColour);
  $('palOwn').addEventListener('change', e => {
    if(e.target.checked){
      commitPaletteToModel();
      toast('These colours now ship in the .asset — VoxelBody.palette overrides Palette.cs for this body');
    }else{
      clearModelPalette();
      toast('Back to the game\'s shared palette; the asset no longer carries colours');
    }
  });
  $('palReset').addEventListener('click', () => {
    resetPalette();
    if(sel.colour >= colourCount()) setColour(colourCount()-1);
    toast('Palette reset to the game\'s six colours');
  });

  // recolour
  $('btnSwap').addEventListener('click', () => {
    const from = +$('swapFrom').value, to = +$('swapTo').value;
    if(from === to){ toast('Pick two different colours', true); return; }
    const n = replaceColour(from, to);
    toast(n ? `Repainted ${n} voxel(s) ${labelOf(from)} → ${labelOf(to)}` : `No ${labelOf(from)} voxels to repaint`, !n);
  });
  $('btnDelColour').addEventListener('click', () => {
    const c = +$('delColour').value;
    const n = deleteColour(c);
    toast(n ? `Deleted ${n} ${labelOf(c)} voxel(s)` : `No ${labelOf(c)} voxels`, !n);
  });

  on('gridsize', syncSizeUI);
  syncSizeUI();
}

/* =====================================================================
   Inspector: rules tab
===================================================================== */
function colourOptions(v){
  // layer rules may use any voxel colour, X wildcard included (Range(0,5) in Unity)
  let h = '';
  for(let i=0;i<colourCount();i++) h += `<option value="${i}" ${v===i?'selected':''}>${labelOf(i)}</option>`;
  // a stored colour outside the palette keeps its own option, so the select can
  // never silently display 0 while the asset still holds something else
  if(!(v >= 0 && v < colourCount())) h += `<option value="${v}" selected>colour ${v} ⚠</option>`;
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
      <td><select data-k="kind"><option value="1" ${r.kind===1?'selected':''}>armoured</option><option value="4" ${r.kind===4?'selected':''}>hidden</option>${r.kind!==1&&r.kind!==4?`<option value="${r.kind}" selected>kind ${r.kind}?</option>`:''}</select></td>
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
    if((e.ctrlKey || e.metaKey) && k === 'c'){ e.preventDefault(); copySlice(); toast('Slice copied'); return; }
    if((e.ctrlKey || e.metaKey) && k === 'v'){
      e.preventDefault();
      const err = pasteSlice();
      toast(err || 'Slice pasted', !!err);
      return;
    }
    if(e.ctrlKey || e.metaKey) return;
    if(k === 'a') setTool('build');
    else if(k === 'b') setTool('paint');
    else if(k === 'r') setTool('rect');
    else if(k === 'l') setTool('line');
    else if(k === 'e') setTool('erase');
    else if(k === 'g') setTool('fill');
    else if(k === 'i') setTool('pick');
    else if(k === 'u') setTool('unit');
    else if(k === '[') setSlice(sel.slice - 1);
    else if(k === ']') setSlice(sel.slice + 1);
    else if(k === 'x'){ sel.symX = !sel.symX; emit('sel'); }
    else if(k === 'z'){ sel.symZ = !sel.symZ; emit('sel'); }
    else if(k === 'h'){
      sel.isolate = !sel.isolate;
      $('chkIsolate').checked = sel.isolate;
      emit('sel'); emit('grid');
    }
    else if(k === '-' || k === '_') setBrush(sel.brush - 1);
    else if(k === '+' || k === '=') setBrush(sel.brush + 1);
    else if(k === '7') setSliceAxis('y');
    else if(k === '8') setSliceAxis('z');
    else if(k === '9') setSliceAxis('x');
    else if(k === '?') openModal('helpModal');
    else if(k >= '1' && k <= '6') setColour(Math.min(colourCount()-1, parseInt(k) - 1));
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

  on('model', () => { adoptModelPalette(); bindModelFields(); renderRules(); renderCrates(); });
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
