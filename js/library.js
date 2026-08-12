// Model library: IndexedDB persistence per browser, plus autosave/crash
// recovery and shared "team levels" fetched from the repo itself
// (levels/index.json → .asset files committed to git).

const DB_NAME = 'voxel-body-editor';
const STORE = 'models';
const AUTOSAVE_ID = '__autosave__';

let dbPromise = null;
function db(){
  if(dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if(!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB unavailable'));
  });
  return dbPromise;
}
function tx(mode, fn){
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const out = fn(store);
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  }));
}

export async function saveModel({ id, name, data, thumb }){
  const rec = {
    id: id || 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2,7),
    name: name || 'Untitled',
    data, thumb: thumb || null,
    updatedAt: Date.now(),
  };
  await tx('readwrite', s => s.put(rec));
  return rec.id;
}
export async function listModels(){
  const all = await tx('readonly', s => s.getAll());
  return (all || [])
    .filter(r => r.id !== AUTOSAVE_ID)
    .sort((a,b) => b.updatedAt - a.updatedAt);
}
export async function getModel(id){
  return tx('readonly', s => s.get(id));
}
export async function deleteModel(id){
  return tx('readwrite', s => s.delete(id));
}

/* ---------- autosave ---------- */
let autosaveTimer = null;
export function scheduleAutosave(getData){
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(async () => {
    try{
      await tx('readwrite', s => s.put({ id: AUTOSAVE_ID, name: 'autosave', data: getData(), updatedAt: Date.now() }));
    }catch{ /* private browsing / quota — non-fatal */ }
  }, 800);
}
export async function getAutosave(){
  try{ return await getModel(AUTOSAVE_ID); }catch{ return null; }
}
export async function clearAutosave(){
  try{ await deleteModel(AUTOSAVE_ID); }catch{ /* ignore */ }
}

/* ---------- team levels (shared via the git repo) ---------- */
// levels/index.json format: [{ "name": "Bird", "path": "samples/bird.asset" }, ...]
export async function fetchTeamLevels(){
  try{
    const res = await fetch('levels/index.json', { cache: 'no-cache' });
    if(!res.ok) return [];
    const list = await res.json();
    return Array.isArray(list)
      ? list.filter(e => e && typeof e.name === 'string' && typeof e.path === 'string')
      : [];
  }catch{ return []; }
}
export async function fetchTeamAsset(path){
  const res = await fetch(path, { cache: 'no-cache' });
  if(!res.ok) throw new Error('Could not load ' + path + ' (' + res.status + ')');
  return res.text();
}
