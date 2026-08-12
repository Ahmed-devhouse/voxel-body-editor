// 3D editor pane. Three.js WebGL renderer with an InstancedMesh for voxels,
// raycast picking for cube-by-cube building, OrbitControls for the camera,
// ghost placement preview, unit markers and per-layer highlighting.

import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { state, sel, EMPTY, idx, on } from './state.js';
import { colHex } from './palette.js';
import { hit3DAction, setSlice } from './tools.js';

let container, renderer, scene, camera, controls;
let voxMesh = null, voxCapacity = 0;
let cellOfInstance = new Int32Array(0);
let ghost, hoverBox, floorPick, gridHelper, shadowPlane, dirLight;
let unitSprites = [];
const unitTexCache = new Map();
const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();
let hoverTarget = null;          // [x,y,z] ghost cell (build tool)
let hoverCell = null;            // [x,y,z] outlined cell (other tools)
let down = null;                 // {x, y, button}

// data axes match world axes directly: x = world X, y = world Y (up, 0 = bottom
// layer resting on the ground plane), z = world Z (depth)
const center = () => (state.N-1)/2;
const worldFromData = (x,y,z) => new THREE.Vector3(x-center(), y+0.5, z-center());

export function initEditor3D(){
  container = document.getElementById('viewPane');
  renderer = new THREE.WebGLRenderer({ antialias:true, preserveDrawingBuffer:true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.id = 'viewCanvas';
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color('#111319');

  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  controls.maxPolarAngle = Math.PI * 0.55;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3f4a, 1.1));
  dirLight = new THREE.DirectionalLight(0xffffff, 1.7);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(1024, 1024);
  scene.add(dirLight);

  // ground: shadow catcher + grid + invisible raycast plane
  shadowPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(1,1),
    new THREE.ShadowMaterial({ opacity: 0.28 })
  );
  shadowPlane.rotation.x = -Math.PI/2;
  shadowPlane.receiveShadow = true;
  scene.add(shadowPlane);

  floorPick = new THREE.Mesh(
    new THREE.PlaneGeometry(1,1),
    new THREE.MeshBasicMaterial({ transparent:true, opacity:0, depthWrite:false })
  );
  floorPick.rotation.x = -Math.PI/2;
  scene.add(floorPick);

  // ghost placement preview
  ghost = new THREE.Mesh(
    new THREE.BoxGeometry(1.001, 1.001, 1.001),
    new THREE.MeshBasicMaterial({ transparent:true, opacity:0.55, depthWrite:false })
  );
  ghost.visible = false;
  scene.add(ghost);

  // hover outline for paint/erase/fill/unit/pick
  hoverBox = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1.04, 1.04, 1.04)),
    new THREE.LineBasicMaterial({ color: 0xffffff })
  );
  hoverBox.visible = false;
  scene.add(hoverBox);

  const el = renderer.domElement;
  el.addEventListener('pointerdown', e => { down = { x:e.clientX, y:e.clientY, button:e.button }; });
  el.addEventListener('pointermove', onHover);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointerleave', () => setHover(null, null));
  el.addEventListener('contextmenu', e => e.preventDefault());
  // no dblclick-to-reset: rapid click-building fires dblclick and would yank
  // the camera mid-build — the "reset view" button covers it.

  const ro = new ResizeObserver(resize);
  ro.observe(container);

  on('grid', rebuild);
  on('gridsize', () => { layoutWorld(); rebuild(); });
  on('palette', recolour);
  on('sel', () => { recolour(); refreshGhostColour(); });

  layoutWorld(true);
  rebuild();
  resize();
  animate();
}

function layoutWorld(placeCamera){
  const N = state.N;
  shadowPlane.geometry.dispose();
  shadowPlane.geometry = new THREE.PlaneGeometry(N*4, N*4);
  floorPick.geometry.dispose();
  floorPick.geometry = new THREE.PlaneGeometry(N, N);
  if(gridHelper){
    scene.remove(gridHelper);
    gridHelper.geometry.dispose();
    gridHelper.material.dispose();
  }
  gridHelper = new THREE.GridHelper(N, N, 0x4a5163, 0x2a2f3a);
  gridHelper.position.y = 0.001;
  scene.add(gridHelper);
  dirLight.position.set(-N*0.7, N*1.6, -N*0.9);
  const s = dirLight.shadow.camera;
  s.left = -N; s.right = N; s.top = N; s.bottom = -N; s.far = N*6;
  s.updateProjectionMatrix();
  controls.target.set(0, N*0.35, 0);
  if(placeCamera || camera.position.length() < 1)
    camera.position.set(N*1.1, N*0.95, N*1.55);
  controls.update();
}

export function resetView(){
  const N = state.N;
  controls.target.set(0, N*0.35, 0);
  camera.position.set(N*1.1, N*0.95, N*1.55);
  controls.update();
}

/* ---------- voxel instances ---------- */
function makeCubeMaterial(){
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0,0,64,64);
  g.strokeStyle = 'rgba(0,0,0,0.22)'; g.lineWidth = 4;
  g.strokeRect(2,2,60,60);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.78, metalness: 0.0 });
}
let cubeMaterial = null;

function ensureCapacity(){
  const need = state.N ** 3;
  if(voxMesh && voxCapacity >= need) return;
  if(voxMesh){ scene.remove(voxMesh); voxMesh.dispose(); }
  if(!cubeMaterial) cubeMaterial = makeCubeMaterial();
  voxMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1), cubeMaterial, need);
  voxMesh.castShadow = true;
  voxMesh.receiveShadow = true;
  voxMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  voxCapacity = need;
  cellOfInstance = new Int32Array(need);
  scene.add(voxMesh);
}

const _m = new THREE.Matrix4();
const _col = new THREE.Color();

function rebuild(){
  ensureCapacity();
  const N = state.N, c = state.colours;
  let count = 0;
  for(let z=0; z<N; z++) for(let y=0; y<N; y++) for(let x=0; x<N; x++){
    const i = idx(x,y,z);
    if(c[i] === EMPTY) continue;
    _m.makeTranslation(x-center(), y+0.5, z-center());
    voxMesh.setMatrixAt(count, _m);
    cellOfInstance[count] = i;
    count++;
  }
  voxMesh.count = count;
  voxMesh.instanceMatrix.needsUpdate = true;
  applyColours(count);
  voxMesh.computeBoundingSphere();
  rebuildUnits();
  const badge = document.getElementById('voxCount');
  if(badge) badge.textContent = count + ' vox';
}

function applyColours(count){
  const N = state.N;
  for(let k=0; k<count; k++){
    const i = cellOfInstance[k];
    const y = ((i / N) | 0) % N;   // idx = (x*N + y)*N + z, so middle digit is y
    _col.set(colHex(state.colours[i]) || '#888888');
    if(sel.hiLayer && y !== sel.slice) _col.multiplyScalar(0.32);
    voxMesh.setColorAt(k, _col);
  }
  if(voxMesh.instanceColor) voxMesh.instanceColor.needsUpdate = true;
}
function recolour(){ if(voxMesh) applyColours(voxMesh.count); }

/* ---------- unit markers ---------- */
function unitTexture(kind){
  if(unitTexCache.has(kind)) return unitTexCache.get(kind);
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(10,12,16,0.72)';
  g.beginPath(); g.arc(32,32,26,0,7); g.fill();
  g.strokeStyle = '#fff'; g.lineWidth = 4;
  g.beginPath(); g.arc(32,32,26,0,7); g.stroke();
  g.fillStyle = '#fff';
  g.font = 'bold 30px ui-monospace, monospace';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(kind), 32, 34);
  const tex = new THREE.CanvasTexture(c);
  unitTexCache.set(kind, tex);
  return tex;
}
function rebuildUnits(){
  for(const s of unitSprites) s.visible = false;
  const N = state.N;
  let used = 0;
  for(let z=0; z<N; z++) for(let y=0; y<N; y++) for(let x=0; x<N; x++){
    const i = idx(x,y,z);
    const u = state.units[i];
    if(!u || state.colours[i] === EMPTY) continue;
    let sp = unitSprites[used];
    if(!sp){
      // depthTest off + high renderOrder: markers sit at cube centres, so with
      // depth testing they would be fully occluded by their own cube. Designers
      // also need to see units embedded in inner layers.
      sp = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, transparent: true }));
      sp.renderOrder = 999;
      sp.scale.set(0.85, 0.85, 1);
      unitSprites.push(sp);
      scene.add(sp);
    }
    sp.material.map = unitTexture(u);
    sp.material.needsUpdate = true;
    sp.position.copy(worldFromData(x,y,z));
    sp.visible = true;
    used++;
  }
}

/* ---------- picking ---------- */
function pick(e){
  const r = renderer.domElement.getBoundingClientRect();
  pointerNDC.x = ((e.clientX - r.left)/r.width)*2 - 1;
  pointerNDC.y = -((e.clientY - r.top)/r.height)*2 + 1;
  raycaster.setFromCamera(pointerNDC, camera);
  const targets = [floorPick];
  if(voxMesh && voxMesh.count > 0) targets.unshift(voxMesh);
  const hits = raycaster.intersectObjects(targets, false);
  if(!hits.length) return null;
  const h = hits[0];
  const N = state.N;
  if(h.object === voxMesh){
    const i = cellOfInstance[h.instanceId];
    // idx = (x*N + y)*N + z
    const z = i % N, y = ((i/N)|0) % N, x = (i/(N*N))|0;
    // face normal is axis-aligned in world space (instances are unrotated) and
    // data axes equal world axes, so the neighbour is a straight offset
    const n = h.face.normal;
    const nb = [x + Math.round(n.x), y + Math.round(n.y), z + Math.round(n.z)];
    return { cell:[x,y,z], nb, floor:false };
  }
  // floor: place on the bottom layer (y = 0)
  const gx = Math.floor(h.point.x + N/2);
  const gz = Math.floor(h.point.z + N/2);
  if(gx<0 || gz<0 || gx>=N || gz>=N) return null;
  const cell = [gx, 0, gz];
  return { cell, nb: cell, floor:true };
}

function setHover(target, cell){
  const tKey = target ? target.join(',') : '';
  const cKey = cell ? cell.join(',') : '';
  if(tKey === (hoverTarget?hoverTarget.join(','):'') && cKey === (hoverCell?hoverCell.join(','):'')) return;
  hoverTarget = target;
  hoverCell = cell;
  if(target){
    ghost.position.copy(worldFromData(target[0], target[1], target[2]));
    refreshGhostColour();
    ghost.visible = true;
  } else ghost.visible = false;
  if(cell){
    hoverBox.position.copy(worldFromData(cell[0], cell[1], cell[2]));
    hoverBox.visible = true;
  } else hoverBox.visible = false;
}
function refreshGhostColour(){
  ghost.material.color.set(colHex(sel.colour) || '#ffffff');
  if(sel.tool !== 'build') { ghost.visible = false; hoverTarget = null; }
}

function onHover(e){
  if(down){ setHover(null, null); return; }   // dragging the camera
  const h = pick(e);
  if(!h){ setHover(null, null); return; }
  if(sel.tool === 'build'){
    const t = h.floor ? h.cell : h.nb;
    const N = state.N;
    const ok = t && t.every(v => v>=0 && v<N) && state.colours[idx(t[0],t[1],t[2])] === EMPTY;
    setHover(ok ? t : null, null);
  } else if(!h.floor){
    setHover(null, h.cell);
  } else setHover(null, null);
}

function onUp(e){
  if(!down) return;
  const wasClick = Math.abs(e.clientX-down.x) + Math.abs(e.clientY-down.y) < 6;
  const button = down.button;
  down = null;
  if(!wasClick || (button !== 0 && button !== 2)) return;
  const h = pick(e);
  if(!h) return;
  const touched = hit3DAction(h, button === 2);
  if(touched) setSlice(touched[1]);  // sync layer editor to build height (y = layer)
  setHover(null, null);
}

/* ---------- frame loop / misc ---------- */
function resize(){
  const w = container.clientWidth, h = container.clientHeight;
  if(w < 2 || h < 2) return;
  renderer.setSize(w, h, false);
  camera.aspect = w/h;
  camera.updateProjectionMatrix();
}
function animate(){
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

export function setSpin(v){
  controls.autoRotate = v;
  controls.autoRotateSpeed = 1.2;
}

// PNG capture of the current view (used for library thumbnails & screenshots)
export function screenshot(size){
  renderer.render(scene, camera);
  const src = renderer.domElement;
  if(!size) return src.toDataURL('image/png');
  const c = document.createElement('canvas');
  const s = Math.min(size/src.width, size/src.height);
  c.width = Math.round(src.width*s); c.height = Math.round(src.height*s);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}
