// Small UI helpers: toasts, modals, tabs, robust file download / clipboard.

const $ = id => document.getElementById(id);

let toastT;
export function toast(msg, err){
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.className = '', 3000);
}

export function openModal(id){ $(id).classList.add('open'); }
export function closeModal(id){ $(id).classList.remove('open'); }
export function initModals(){
  document.querySelectorAll('[data-close]').forEach(b =>
    b.addEventListener('click', () => b.closest('.modal').classList.remove('open')));
  document.querySelectorAll('.modal').forEach(m =>
    m.addEventListener('pointerdown', e => { if(e.target === m) m.classList.remove('open'); }));
  window.addEventListener('keydown', e => {
    if(e.key === 'Escape')
      document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open'));
  });
}

export function initTabs(onShow){
  document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('active', x===b));
    document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('active', p.id === 'tab-'+b.dataset.tab));
    if(onShow) onShow(b.dataset.tab);
  }));
}

/* ---------- robust save / copy (works even in sandboxed hosts) ---------- */
export function tryAnchorDownload(text, fname){
  try{
    const blob = new Blob([text], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
    return true;
  }catch{ return false; }
}
export async function trySavePicker(text, fname, ext){
  if(!window.showSaveFilePicker) return false;
  try{
    const h = await window.showSaveFilePicker({
      suggestedName: fname,
      types: [{ description: 'File', accept: { 'text/plain': [ext || '.asset'] } }],
    });
    const w = await h.createWritable();
    await w.write(text);
    await w.close();
    return true;
  }catch(e){
    if(e && e.name === 'AbortError') return 'abort';
    return false;
  }
}
export async function copyText(text){
  try{ await navigator.clipboard.writeText(text); return true; }catch{ /* fall through */ }
  try{
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }catch{ return false; }
}
export function downloadDataURL(dataURL, fname){
  const a = document.createElement('a');
  a.href = dataURL; a.download = fname;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
