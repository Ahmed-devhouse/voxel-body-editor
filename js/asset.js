// Unity VoxelBody .asset (YAML) reader/writer.
// The exporter reproduces the exact field order and formatting of assets
// produced by the Unity tool — verified byte-identical on a round-trip of a
// real asset. Change with care: the Unity importer and this file must agree.

import { EMPTY, DEFAULT_GUID, defaultMeta } from './state.js';

export function parseAsset(text){
  const lines = text.split(/\r?\n/);
  const top = {};   // key -> scalar string or array of objects
  let i = 0;
  while(i < lines.length && !/^MonoBehaviour:/.test(lines[i])) i++;
  if(i >= lines.length) throw new Error('No MonoBehaviour block found — is this a VoxelBody .asset?');
  i++;
  while(i < lines.length){
    const m = lines[i].match(/^  (\w+): ?(.*)$/);
    if(!m){ i++; continue; }
    const key = m[1], rest = m[2];
    if(rest !== ''){ top[key] = rest; i++; continue; }
    const list = [];
    i++;
    while(i < lines.length){
      const it = lines[i].match(/^  - (\w+): ?(.*)$/);
      const cont = lines[i].match(/^    (\w+): ?(.*)$/);
      if(it){ list.push({[it[1]]: it[2]}); i++; }
      else if(cont && list.length){ list[list.length-1][cont[1]] = cont[2]; i++; }
      else break;
    }
    // a key with an empty scalar (e.g. "m_Name:") is an empty string, not a list
    top[key] = list.length ? list : '';
  }
  if(!('colours' in top)) throw new Error('No "colours" field — not a VoxelBody asset.');

  const num = v => { const f = parseFloat(v); return Number.isFinite(f) ? f : 0; };
  const size = Math.round(num(top.size)) || Math.round(Math.cbrt((top.colours||'').length/2));
  if(size < 2 || size > 64) throw new Error('Bad grid size: ' + size);
  const cells = size*size*size;
  const hexToArr = (hex, fillv) => {
    const a = new Uint8Array(cells).fill(fillv);
    if(typeof hex === 'string')
      for(let k=0; k<Math.min(cells, hex.length/2); k++) a[k] = parseInt(hex.substr(k*2,2), 16);
    return a;
  };
  const colours = hexToArr(top.colours, EMPTY);
  const units   = hexToArr(top.units, 0);

  const listNum = (l, keys) => Array.isArray(l)
    ? l.map(o => { const r={}; for(const k of keys) r[k]=num(o[k]); return r; })
    : [];
  const meta = defaultMeta();
  // zero is a legitimate stored value — only fall back when the field is absent,
  // so import → export stays byte-faithful for files that contain zeros.
  meta.name           = (typeof top.m_Name === 'string' && top.m_Name) ? top.m_Name : 'Imported';
  meta.displayName    = (typeof top.displayName === 'string' && top.displayName) ? top.displayName : meta.name;
  meta.depth          = ('depth' in top) ? Math.round(num(top.depth)) : size;
  meta.smoothness     = num(top.smoothness);
  meta.alphaThreshold = num(top.alphaThreshold);
  meta.greyToWildcard = Math.round(num(top.greyToWildcard));
  meta.wrapInShell    = Math.round(num(top.wrapInShell));
  meta.customCrateGrid= Math.round(num(top.customCrateGrid));
  meta.crateRows      = ('crateRows' in top) ? Math.round(num(top.crateRows)) : 10;
  meta.misplayTolerance = Math.round(num(top.misplayTolerance));
  meta.layerRules     = listNum(top.layerRules, ['layer','colour','percent']);
  meta.unitRules      = listNum(top.unitRules, ['layer','kind','count']);
  meta.crateCells     = listNum(top.crateCells, ['colour','rounds','chain','flags']);
  meta.crateRefills   = listNum(top.crateRefills, ['colour','rounds','chain','flags']);
  meta.layerPatterns  = Array.isArray(top.layerPatterns) ? top.layerPatterns : [];
  const g = (top.m_Script||'').match(/guid: (\w+)/);
  meta.scriptGuid = g ? g[1] : DEFAULT_GUID;
  if(typeof top.sourceImage === 'string' && top.sourceImage.startsWith('{')) meta.sourceImageRaw = top.sourceImage;
  if(typeof top.sourceSlice === 'string' && top.sourceSlice.startsWith('{')) meta.sourceSliceRaw = top.sourceSlice;

  return { N: size, colours, units, meta };
}

function fmtNum(v){ return String(v); }

export function exportAsset({N, colours, units, meta}){
  const L = [];
  L.push('%YAML 1.1');
  L.push('%TAG !u! tag:unity3d.com,2011:');
  L.push('--- !u!114 &11400000');
  L.push('MonoBehaviour:');
  L.push('  m_ObjectHideFlags: 0');
  L.push('  m_CorrespondingSourceObject: {fileID: 0}');
  L.push('  m_PrefabInstance: {fileID: 0}');
  L.push('  m_PrefabAsset: {fileID: 0}');
  L.push('  m_GameObject: {fileID: 0}');
  L.push('  m_Enabled: 1');
  L.push('  m_EditorHideFlags: 0');
  L.push('  m_Script: {fileID: 11500000, guid: ' + meta.scriptGuid + ', type: 3}');
  L.push('  m_Name: ' + meta.name);
  L.push('  m_EditorClassIdentifier: Assembly-CSharp::VoxelVolley.VoxelBody');
  L.push('  displayName: ' + meta.displayName);
  L.push('  sourceImage: ' + meta.sourceImageRaw);
  L.push('  sourceSlice: ' + meta.sourceSliceRaw);
  L.push('  size: ' + N);
  L.push('  depth: ' + meta.depth);
  L.push('  smoothness: ' + fmtNum(meta.smoothness));
  L.push('  alphaThreshold: ' + fmtNum(meta.alphaThreshold));
  L.push('  greyToWildcard: ' + meta.greyToWildcard);
  const emitList = (key, arr, keys) => {
    if(!arr.length){ L.push('  ' + key + ': []'); return; }
    L.push('  ' + key + ':');
    for(const o of arr)
      keys.forEach((k, ki) => L.push((ki===0 ? '  - ' : '    ') + k + ': ' + fmtNum(o[k])));
  };
  emitList('layerRules', meta.layerRules, ['layer','colour','percent']);
  if(meta.layerPatterns.length){
    L.push('  layerPatterns:');
    for(const o of meta.layerPatterns){
      const ks = Object.keys(o);
      ks.forEach((k,ki) => L.push((ki===0?'  - ':'    ') + k + ': ' + o[k]));
    }
  } else L.push('  layerPatterns: []');
  emitList('unitRules', meta.unitRules, ['layer','kind','count']);
  L.push('  wrapInShell: ' + meta.wrapInShell);
  L.push('  customCrateGrid: ' + meta.customCrateGrid);
  L.push('  crateRows: ' + meta.crateRows);
  emitList('crateCells', meta.crateCells, ['colour','rounds','chain','flags']);
  emitList('crateRefills', meta.crateRefills, ['colour','rounds','chain','flags']);
  L.push('  misplayTolerance: ' + meta.misplayTolerance);
  const hex = a => Array.from(a, v => v.toString(16).padStart(2,'0')).join('');
  L.push('  colours: ' + hex(colours));
  L.push('  units: ' + hex(units));
  let vc = 0;
  for(let i=0;i<colours.length;i++) if(colours[i]!==EMPTY) vc++;
  L.push('  voxelCount: ' + vc);
  return L.join('\n') + '\n';
}
