// Oba Eweka 3D Statue — Three.js & Minecraft Creative Engine
// MinusND Obsidian & Gold Edition

const $ = id => document.getElementById(id);

// ── APP STATE & ISOLATED SESSION ───────────────────────────────────────────
// Jeder Besucher hat eine komplett eigene, isolierte Sitzung im Browser.
// Niemand kann etwas für andere verändern und nichts wird online überschrieben!
const urlParams = new URLSearchParams(window.location.search);
const profileId = (urlParams.get('u') || urlParams.get('id') || urlParams.get('builder') || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
const storageKeyLevel = profileId !== 'default' ? `statue-level-v7-${profileId}` : 'statue-level-v7';
const storageKeyCompleted = profileId !== 'default' ? `statue-completed-v5-${profileId}` : 'statue-completed-v5';

const maxLevel = (typeof modelInfo !== 'undefined' && modelInfo.height) ? (modelInfo.height - 1) : 43;
let level = 20; // Standard: Ebene 21 (Deine 17x9 Plattform)
let mode = 'cut'; // Immer "Bis Schicht" (Abgeschnitten) Modus
let soundEnabled = true;
let completedLayers = new Set();

try {
  const saved = localStorage.getItem(storageKeyLevel);
  if (saved !== null) {
    const parsed = parseInt(saved, 10);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= maxLevel) level = parsed;
  }
} catch (e) {}

// Load persistent data
try {
  completedLayers = new Set(JSON.parse(localStorage.getItem(storageKeyCompleted) || '[]'));
  soundEnabled = localStorage.getItem('statue-sound') !== 'false';
} catch (e) {}

// ── WEB AUDIO SYNTHESIZER ──────────────────────────────────────────────────
let audioCtx = null;
function playBeep(freq, duration = 0.04, type = 'sine', vol = 0.08) {
  if (!soundEnabled) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    gain.gain.setValueAtTime(vol, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch (e) {}
}

function playSuccessChime() {
  if (!soundEnabled) return;
  [587, 740, 880, 1174].forEach((f, i) => {
    setTimeout(() => playBeep(f, 0.12, 'triangle', 0.1), i * 65);
  });
}

function updateAudioUI() {
  const icon = $('audioIcon');
  if (icon) icon.textContent = soundEnabled ? '🔊' : '🔇';
}
updateAudioUI();

// ── TOAST NOTIFICATION ─────────────────────────────────────────────────────
function showToast(msg, icon = '✓') {
  const toast = $('toast');
  const msgEl = $('toastMsg');
  const iconEl = $('toastIcon');
  if (!toast) return;
  msgEl.textContent = msg;
  iconEl.textContent = icon;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2400);
}

// ── LIGHTBOX ───────────────────────────────────────────────────────────────
window.openLightbox = function(src, caption) {
  const modal = $('lightboxModal');
  const img = $('lightboxImg');
  const cap = $('lightboxCaption');
  if (!modal || !img) return;
  img.src = src;
  cap.textContent = caption || '';
  modal.classList.add('open');
};
window.closeLightbox = function() {
  const modal = $('lightboxModal');
  if (modal) modal.classList.remove('open');
};

// ── THREE.JS SETUP ─────────────────────────────────────────────────────────
const canvas = $('threeCanvas');
const viewport = $('viewport3D');

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x050507, 0.006);

const initialW = (viewport && viewport.clientWidth > 0) ? viewport.clientWidth : (window.innerWidth || 800);
const initialH = (viewport && viewport.clientHeight > 0) ? viewport.clientHeight : (window.innerHeight || 600);

const camera = new THREE.PerspectiveCamera(50, initialW / initialH, 0.1, 1000);
camera.position.set(28, 18, 42);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
  alpha: true
});
renderer.setSize(initialW, initialH);
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = false;

// Lighting (Minecraft Sun + Soft Ambience)
const ambientLight = new THREE.AmbientLight(0xffffff, 0.72);
scene.add(ambientLight);

const sunLight = new THREE.DirectionalLight(0xfffaee, 0.85);
sunLight.position.set(30, 50, 40);
scene.add(sunLight);

const rimLight = new THREE.DirectionalLight(0x6080aa, 0.35);
rimLight.position.set(-30, 20, -35);
scene.add(rimLight);

// Ground Build Platform (Plot Outline)
const platformGroup = new THREE.Group();
const plotGeo = new THREE.BoxGeometry(22, 0.2, 14);
const plotMat = new THREE.MeshBasicMaterial({ color: 0x0c0c10 });
const plotMesh = new THREE.Mesh(plotGeo, plotMat);
plotMesh.position.set(0, -22.6, 0);
platformGroup.add(plotMesh);

const plotGrid = new THREE.GridHelper(22, 22, 0xf5c518, 0x222228);
plotGrid.position.set(0, -22.5, 0);
platformGroup.add(plotGrid);

// Corner markers in gold
[-10, 10].forEach(x => {
  [-6, 6].forEach(z => {
    const postGeo = new THREE.BoxGeometry(0.5, 1.2, 0.5);
    const postMat = new THREE.MeshBasicMaterial({ color: 0xf5c518 });
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.set(x, -22.0, z);
    platformGroup.add(post);
  });
});
scene.add(platformGroup);

// ── VOXEL INSTANCED MESHES ─────────────────────────────────────────────────
// Each block in blocks has: { x, y, z, m }
// Palette: 7 materials
const paletteBlocks = palette.map(() => []);
blocks.forEach(b => {
  paletteBlocks[b.m].push(b);
});

const blockGeo = new THREE.BoxGeometry(0.97, 0.97, 0.97);

// Fast block coordinate lookup map (guaranteed available even if vox wasn't global)
const blockMap = (typeof vox !== 'undefined' && vox && vox.get)
  ? vox
  : new Map(blocks.map(b => [`${b.x},${b.y},${b.z}`, b]));

// State for filtering to only build from platform upwards
let onlyFromPlatform = false;
try {
  onlyFromPlatform = localStorage.getItem('statue-platform-only') === 'true';
} catch (e) {}

// Procedural 16x16 Minecraft Block Texture Generator
// Produces beveled highlights/shadows, dark outer seams, and authentic material grain
function createMinecraftTexture(baseHex, mIdx) {
  try {
    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 16;
    const ctx = c.getContext('2d');
    if (!ctx) return null;

    const r0 = parseInt(baseHex.slice(1, 3), 16);
    const g0 = parseInt(baseHex.slice(3, 5), 16);
    const b0 = parseInt(baseHex.slice(5, 7), 16);

    const imgData = ctx.createImageData(16, 16);
    const data = imgData.data;

    let seed = (mIdx + 1) * 7919;
    function rnd() {
      seed = (seed * 16807 + 12345) % 2147483647;
      return (seed % 1000) / 1000;
    }

    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const idx = (y * 16 + x) * 4;

        // Realistic material grain
        let delta = (rnd() - 0.5) * 20;

        // Bevel borders for 3D block clarity:
        const isTop = (y === 0 || y === 1);
        const isLeft = (x === 0 || x === 1);
        const isBottom = (y === 14 || y === 15);
        const isRight = (x === 14 || x === 15);
        const isPerimeter = (x === 0 || y === 0 || x === 15 || y === 15);

        if (isTop || isLeft) delta += 24; // Highlight bevel
        if (isBottom || isRight) delta -= 30; // Shadow bevel
        if (isPerimeter) delta -= 14; // Edge seam

        const r = Math.max(0, Math.min(255, Math.round(r0 + delta)));
        const g = Math.max(0, Math.min(255, Math.round(g0 + delta)));
        const b = Math.max(0, Math.min(255, Math.round(b0 + delta)));

        data[idx] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);

    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  } catch (err) {
    console.warn('Canvas texture fallback:', err);
    return null;
  }
}

const paletteMaterials = palette.map((p, mIdx) => {
  const tex = createMinecraftTexture(p[3], mIdx);
  return new THREE.MeshStandardMaterial({
    color: tex ? 0xffffff : new THREE.Color(p[3]),
    map: tex || null,
    roughness: 0.82,
    metalness: 0.05
  });
});

const instancedMeshes = palette.map((p, mIdx) => {
  const blist = paletteBlocks[mIdx];
  const im = new THREE.InstancedMesh(blockGeo, paletteMaterials[mIdx], blist.length);
  im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(im);
  return im;
});

// Active Layer Golden Wireframe Overlay
let showEdges = true;
const activeLayerBoxGeo = new THREE.BoxGeometry(1.02, 1.02, 1.02);
const activeLayerWireMat = new THREE.MeshBasicMaterial({
  color: 0xf5c518,
  wireframe: true,
  transparent: true,
  opacity: 0.9
});
const activeLayerMesh = new THREE.InstancedMesh(activeLayerBoxGeo, activeLayerWireMat, 400);
activeLayerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
scene.add(activeLayerMesh);

const dummy = new THREE.Object3D();

// Rebuild / Filter layers
function updateVoxelLayers() {
  palette.forEach((p, mIdx) => {
    const im = instancedMeshes[mIdx];
    const blist = paletteBlocks[mIdx];
    blist.forEach((b, i) => {
      let isVisible = true;
      if (mode === 'cut') {
        isVisible = (b.y <= level);
      } else if (mode === 'single') {
        isVisible = (b.y === level);
      }

      // If user enabled "Ab Plattform" filter, hide foundation rows under the white platform (Ebene 21)
      if (onlyFromPlatform && b.y < 20) {
        isVisible = false;
      }

      if (isVisible) {
        dummy.position.set(b.x, b.y - 22, b.z);
        if (b.y === level && (mode === 'cut' || mode === 'single')) {
          dummy.scale.set(1.04, 1.04, 1.04);
        } else {
          dummy.scale.set(1.0, 1.0, 1.0);
        }
      } else {
        dummy.position.set(0, 0, 0);
        dummy.scale.set(0, 0, 0); // invisible
      }
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);
    });
    im.instanceMatrix.needsUpdate = true;
  });

  // Position active layer golden wireframe outlines
  let activeIdx = 0;
  if (showEdges) {
    blocks.forEach(b => {
      if (b.y === level && activeIdx < 400) {
        dummy.position.set(b.x, b.y - 22, b.z);
        dummy.scale.set(1.03, 1.03, 1.03);
        dummy.updateMatrix();
        activeLayerMesh.setMatrixAt(activeIdx++, dummy.matrix);
      }
    });
  }
  for (let i = activeIdx; i < 400; i++) {
    dummy.position.set(0, 0, 0);
    dummy.scale.set(0, 0, 0);
    dummy.updateMatrix();
    activeLayerMesh.setMatrixAt(i, dummy.matrix);
  }
  activeLayerMesh.instanceMatrix.needsUpdate = true;
  activeLayerMesh.visible = showEdges && (activeIdx > 0);
}

// ── CAMERA MODES (ORBIT vs MINECRAFT CREATIVE FLIGHT) ───────────────────────
let cameraMode = 'orbit'; // 'orbit' | 'fly'
let activeTool = 'orbit';  // 'orbit' | 'pan'

// Orbit Camera State
const orbitTarget = new THREE.Vector3(0, 0, 0);
const targetPos = new THREE.Vector3(0, 0, 0);
let orbitRadius = 55;
let targetRadius = 55;
let orbitYaw = 0.55;
let targetYaw = 0.55;
let orbitPitch = 0.28;
let targetPitch = 0.28;

// Minecraft Flight State
const flyPos = new THREE.Vector3(0, 0, 35);
const flyVel = new THREE.Vector3(0, 0, 0);
let flyYaw = 0;
let flyPitch = 0;
let isPointerLocked = false;
let isMouseDownInFly = false;
let lastMouseX = 0;
let lastMouseY = 0;

// Keyboard input state
const keys = {};
window.addEventListener('keydown', e => {
  keys[e.code] = true;

  if (cameraMode === 'fly') {
    if (e.code === 'Escape') {
      exitFlyMode();
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
    }
    return;
  }

  // Normal keyboard shortcuts
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'f' || e.key === 'F') {
    toggleFlyMode();
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    stepLayer(1);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    stepLayer(-1);
  } else if (e.code === 'Space') {
    e.preventDefault();
    stepLayer(1);
  } else if (e.key === 'c' || e.key === 'C') {
    if ($('chkDoneLayer')) {
      $('chkDoneLayer').checked = !$('chkDoneLayer').checked;
      $('chkDoneLayer').dispatchEvent(new Event('change'));
    }
  }
});

window.addEventListener('keyup', e => {
  keys[e.code] = false;
});

// Pointer Lock Listener
function requestLock() {
  if (canvas.requestPointerLock) {
    canvas.requestPointerLock();
  }
}

document.addEventListener('pointerlockchange', () => {
  isPointerLocked = (document.pointerLockElement === canvas);
  if (isPointerLocked) {
    canvas.style.cursor = 'none';
  } else {
    canvas.style.cursor = '';
  }
});

// Enter Minecraft Flight Mode
function enterFlyMode() {
  cameraMode = 'fly';

  // Position camera smoothly from current orbit view
  flyPos.copy(camera.position);

  // Compute initial yaw and pitch from current camera direction
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  flyYaw = Math.atan2(-dir.x, -dir.z);
  flyPitch = Math.asin(Math.max(-0.99, Math.min(0.99, dir.y)));
  flyVel.set(0, 0, 0);

  requestLock();

  if ($('flyCrosshair')) $('flyCrosshair').style.display = 'block';
  if ($('flyHUD')) $('flyHUD').style.display = 'flex';
  if ($('btnExitFly')) $('btnExitFly').style.display = 'inline-flex';
  if ($('btnFlyModeToggle')) $('btnFlyModeToggle').style.display = 'none';
  if ($('flyMobileControls')) $('flyMobileControls').style.display = 'flex';
  if ($('btnToolFly')) $('btnToolFly').classList.add('active');
  if ($('btnToolOrbit')) $('btnToolOrbit').classList.remove('active');
  if ($('btnToolPan')) $('btnToolPan').classList.remove('active');

  showToast('✈ Flugmodus: Button oben rechts zum Beenden', '🎮');
  playBeep(440, 0.08, 'triangle', 0.12);
}

// Exit Minecraft Flight Mode
function exitFlyMode() {
  if (cameraMode !== 'fly') return;
  cameraMode = 'orbit';

  if (document.exitPointerLock) {
    document.exitPointerLock();
  }
  isPointerLocked = false;
  isMouseDownInFly = false;

  if ($('flyCrosshair')) $('flyCrosshair').style.display = 'none';
  if ($('flyHUD')) $('flyHUD').style.display = 'none';
  if ($('btnExitFly')) $('btnExitFly').style.display = 'none';
  if ($('btnFlyModeToggle')) $('btnFlyModeToggle').style.display = 'inline-flex';
  if ($('flyMobileControls')) $('flyMobileControls').style.display = 'none';
  if ($('btnToolFly')) $('btnToolFly').classList.remove('active');
  if ($('btnToolOrbit')) $('btnToolOrbit').classList.add('active');

  // Reset flying keys
  ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space', 'ShiftLeft'].forEach(k => { keys[k] = false; });

  // Sync orbit target so camera doesn't jump
  targetPos.set(0, 0, 0);
  const diff = flyPos.clone().sub(targetPos);
  targetRadius = Math.max(15, Math.min(120, diff.length()));
  targetYaw = Math.atan2(diff.x, diff.z);
  targetPitch = Math.asin(Math.max(-0.9, Math.min(0.9, diff.y / targetRadius)));

  showToast('Flugmodus beendet — Zurück im Orbit', '🏁');
  playBeep(330, 0.06);
}
window.exitFlyMode = exitFlyMode;
window.enterFlyMode = enterFlyMode;

function toggleFlyMode() {
  if (cameraMode === 'fly') {
    exitFlyMode();
  } else {
    enterFlyMode();
  }
}
window.toggleFlyMode = toggleFlyMode;

if ($('btnToolFly')) $('btnToolFly').onclick = toggleFlyMode;
if ($('btnFlyModeToggle')) $('btnFlyModeToggle').onclick = toggleFlyMode;
if ($('btnExitFly')) $('btnExitFly').onclick = exitFlyMode;

// ── MOBILE FLIGHT TOUCH BUTTONS ────────────────────────────────────────────
function wireMobileFlyButtons() {
  const mapBtn = (btnId, key) => {
    const btn = $(btnId);
    if (!btn) return;
    const press = e => {
      e.preventDefault();
      keys[key] = true;
      if (navigator.vibrate) try { navigator.vibrate(8); } catch(err) {}
    };
    const release = e => {
      e.preventDefault();
      keys[key] = false;
    };
    btn.addEventListener('touchstart', press, { passive: false });
    btn.addEventListener('touchend', release, { passive: false });
    btn.addEventListener('touchcancel', release, { passive: false });
    btn.addEventListener('mousedown', press);
    btn.addEventListener('mouseup', release);
    btn.addEventListener('mouseleave', release);
  };
  mapBtn('btnFlyTouchUp', 'Space');
  mapBtn('btnFlyTouchDown', 'ShiftLeft');
  mapBtn('btnFlyTouchFwd', 'KeyW');
  mapBtn('btnFlyTouchBack', 'KeyS');
}
wireMobileFlyButtons();

// ── MOUSE CONTROLS (ORBIT, PAN, FLY LOOK) ──────────────────────────────────
let isDragging = false;
let dragButton = 0;
let dragStartX = 0;
let dragStartY = 0;

canvas.addEventListener('contextmenu', e => e.preventDefault());

canvas.addEventListener('mousedown', e => {
  if (cameraMode === 'fly') {
    if (e.button === 0) {
      isMouseDownInFly = true;
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
      if (!isPointerLocked) {
        requestLock();
      }
    }
    return;
  }

  // Orbit / Pan mode
  isDragging = true;
  dragButton = e.button;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
});

window.addEventListener('mousemove', e => {
  // Minecraft Flight Look
  if (cameraMode === 'fly') {
    if (isPointerLocked) {
      // Real Pointer Lock raw deltas (authentic Minecraft mouse sensitivity)
      const sens = 0.0022;
      flyYaw -= e.movementX * sens;
      flyPitch -= e.movementY * sens;
      const maxP = Math.PI * 0.49;
      flyPitch = Math.max(-maxP, Math.min(maxP, flyPitch));
    } else if (isMouseDownInFly) {
      // Fallback if pointer lock is blocked by iframe security policy
      const dx = e.clientX - lastMouseX;
      const dy = e.clientY - lastMouseY;
      const sens = 0.003;
      flyYaw -= dx * sens;
      flyPitch -= dy * sens;
      const maxP = Math.PI * 0.49;
      flyPitch = Math.max(-maxP, Math.min(maxP, flyPitch));
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
    }
    return;
  }

  // Orbit / Pan Mode
  if (!isDragging) return;
  const dx = e.clientX - dragStartX;
  const dy = e.clientY - dragStartY;
  dragStartX = e.clientX;
  dragStartY = e.clientY;

  const isPan = (dragButton === 2 || dragButton === 1 || e.shiftKey || activeTool === 'pan');

  if (isPan) {
    // Pan: move targetPos relative to camera right and up vectors
    const factor = targetRadius * 0.0016;
    const right = new THREE.Vector3(Math.cos(orbitYaw), 0, -Math.sin(orbitYaw));
    const up = new THREE.Vector3(0, 1, 0);

    targetPos.addScaledVector(right, -dx * factor);
    targetPos.addScaledVector(up, dy * factor);
  } else {
    // Orbit rotate
    targetYaw += dx * 0.007;
    targetPitch = Math.max(-1.1, Math.min(1.4, targetPitch + dy * 0.006));
  }
});

window.addEventListener('mouseup', () => {
  isDragging = false;
  isMouseDownInFly = false;
});

// Smooth Scroll Wheel Zoom
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const zoomFactor = Math.exp(e.deltaY * 0.0012);
  targetRadius = Math.max(12, Math.min(140, targetRadius * zoomFactor));
}, { passive: false });

// ── ROBUST MOBILE TOUCH GESTURES (ORBIT, PAN, PINCH-ZOOM & FLY) ───────────
let touchCount = 0;
let lastTouchX = 0;
let lastTouchY = 0;
let touchPinchDist = 0;
let touchMidX = 0;
let touchMidY = 0;

canvas.addEventListener('touchstart', e => {
  touchCount = e.touches.length;
  if (touchCount === 1) {
    const t = e.touches[0];
    lastTouchX = t.clientX;
    lastTouchY = t.clientY;
  } else if (touchCount === 2) {
    const t1 = e.touches[0];
    const t2 = e.touches[1];
    touchPinchDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
    touchMidX = (t1.clientX + t2.clientX) / 2;
    touchMidY = (t1.clientY + t2.clientY) / 2;
  }
}, { passive: false });

canvas.addEventListener('touchmove', e => {
  e.preventDefault(); // Stop mobile browser pull-to-refresh & drag

  if (cameraMode === 'fly') {
    if (e.touches.length >= 1) {
      const t = e.touches[0];
      const dx = t.clientX - lastTouchX;
      const dy = t.clientY - lastTouchY;
      lastTouchX = t.clientX;
      lastTouchY = t.clientY;
      const sens = 0.0035;
      flyYaw -= dx * sens;
      flyPitch -= dy * sens;
      const maxP = Math.PI * 0.49;
      flyPitch = Math.max(-maxP, Math.min(maxP, flyPitch));
    }
    return;
  }

  // 1 Finger: Orbit rotate (or Pan if activeTool === 'pan')
  if (e.touches.length === 1) {
    const t = e.touches[0];
    const dx = t.clientX - lastTouchX;
    const dy = t.clientY - lastTouchY;
    lastTouchX = t.clientX;
    lastTouchY = t.clientY;

    if (activeTool === 'pan') {
      const factor = targetRadius * 0.0016;
      const right = new THREE.Vector3(Math.cos(orbitYaw), 0, -Math.sin(orbitYaw));
      const up = new THREE.Vector3(0, 1, 0);
      targetPos.addScaledVector(right, -dx * factor);
      targetPos.addScaledVector(up, dy * factor);
    } else {
      targetYaw += dx * 0.007;
      targetPitch = Math.max(-1.1, Math.min(1.4, targetPitch + dy * 0.006));
    }
  } else if (e.touches.length === 2) {
    // 2 Fingers: Pinch-Zoom & Two-Finger Pan
    const t1 = e.touches[0];
    const t2 = e.touches[1];
    const currentDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
    if (touchPinchDist > 0 && currentDist > 0) {
      const ratio = touchPinchDist / currentDist;
      targetRadius = Math.max(12, Math.min(140, targetRadius * ratio));
      touchPinchDist = currentDist;
    }

    const curMidX = (t1.clientX + t2.clientX) / 2;
    const curMidY = (t1.clientY + t2.clientY) / 2;
    const dxMid = curMidX - touchMidX;
    const dyMid = curMidY - touchMidY;
    touchMidX = curMidX;
    touchMidY = curMidY;

    const factor = targetRadius * 0.0016;
    const right = new THREE.Vector3(Math.cos(orbitYaw), 0, -Math.sin(orbitYaw));
    const up = new THREE.Vector3(0, 1, 0);
    targetPos.addScaledVector(right, -dxMid * factor);
    targetPos.addScaledVector(up, dyMid * factor);
  }
}, { passive: false });

canvas.addEventListener('touchend', e => {
  touchCount = e.touches.length;
  if (touchCount === 1) {
    const t = e.touches[0];
    lastTouchX = t.clientX;
    lastTouchY = t.clientY;
  }
}, { passive: true });

canvas.addEventListener('touchcancel', () => {
  touchCount = 0;
}, { passive: true });

// ── TOOLS & PRESETS ────────────────────────────────────────────────────────
if ($('btnToolOrbit')) {
  $('btnToolOrbit').onclick = () => {
    if (cameraMode === 'fly') exitFlyMode();
    activeTool = 'orbit';
    $('btnToolOrbit').classList.add('active');
    if ($('btnToolPan')) $('btnToolPan').classList.remove('active');
    showToast('Modus: 3D Drehen (Orbit)', '🔄');
  };
}

if ($('btnToolPan')) {
  $('btnToolPan').onclick = () => {
    if (cameraMode === 'fly') exitFlyMode();
    activeTool = 'pan';
    $('btnToolPan').classList.add('active');
    if ($('btnToolOrbit')) $('btnToolOrbit').classList.remove('active');
    showToast('Modus: Verschieben (Pan)', '🖐');
  };
}

const edgesBtn = $('btnToggleEdges');
if (edgesBtn) {
  edgesBtn.onclick = () => {
    showEdges = !showEdges;
    edgesBtn.classList.toggle('active', showEdges);
    const lbl = $('edgesBtnLabel');
    if (lbl) lbl.textContent = showEdges ? 'Kanten: An' : 'Kanten: Aus';
    activeLayerMesh.visible = showEdges;
    showToast(showEdges ? 'Schicht-Kanten aktiviert' : 'Kanten deaktiviert', '📐');
    playBeep(showEdges ? 580 : 320, 0.04);
    updateVoxelLayers();
  };
}

if ($('btnFocusLayer')) {
  $('btnFocusLayer').onclick = () => {
    const layerY = level - 22;
    if (cameraMode === 'fly') {
      flyPos.y = layerY;
      showToast(`Kamera auf Ebene ${level + 1} gebracht`, '📍');
    } else {
      targetPos.set(0, layerY, 0);
      showToast(`Fokus auf Ebene ${level + 1}`, '📍');
    }
    playBeep(520, 0.04);
  };
}

if ($('btnResetView')) {
  $('btnResetView').onclick = () => {
    if (cameraMode === 'fly') exitFlyMode();
    targetPos.set(0, 0, 0);
    targetYaw = 0.55;
    targetPitch = 0.28;
    targetRadius = 55;
    showToast('Kamera zentriert & zurückgesetzt', '🎯');
    playBeep(400, 0.05);
  };
}

if ($('btnZoomIn')) {
  $('btnZoomIn').onclick = () => {
    targetRadius = Math.max(12, targetRadius / 1.25);
  };
}
if ($('btnZoomOut')) {
  $('btnZoomOut').onclick = () => {
    targetRadius = Math.min(140, targetRadius * 1.25);
  };
}

// ── MAIN ANIMATION LOOP ────────────────────────────────────────────────────
let clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);

  const dt = Math.min(clock.getDelta(), 0.1);

  if (cameraMode === 'fly') {
    // ── MINECRAFT CREATIVE FLIGHT PHYSICS ──
    const moveDir = new THREE.Vector3(0, 0, 0);

    // Forward direction in full 3D (including pitch!)
    const lookDir = new THREE.Vector3(
      -Math.sin(flyYaw) * Math.cos(flyPitch),
      Math.sin(flyPitch),
      -Math.cos(flyYaw) * Math.cos(flyPitch)
    ).normalize();

    // Horizontal strafe right direction
    const rightDir = new THREE.Vector3(
      Math.cos(flyYaw),
      0,
      -Math.sin(flyYaw)
    ).normalize();

    // Key mapping exactly like Minecraft:
    if (keys['KeyW']) moveDir.add(lookDir);
    if (keys['KeyS']) moveDir.sub(lookDir);
    if (keys['KeyD']) moveDir.add(rightDir);
    if (keys['KeyA']) moveDir.sub(rightDir);
    if (keys['Space']) moveDir.y += 1;
    if (keys['ShiftLeft'] || keys['ShiftRight']) moveDir.y -= 1;

    if (moveDir.lengthSq() > 0.001) {
      moveDir.normalize();
    }

    // Sprinting with Ctrl increases speed from 18 blocks/s to 45 blocks/s
    const isSprinting = keys['ControlLeft'] || keys['ControlRight'];
    const maxSpeed = isSprinting ? 45.0 : 18.0;
    const accel = maxSpeed * 6.0;

    flyVel.x += moveDir.x * accel * dt;
    flyVel.y += moveDir.y * accel * dt;
    flyVel.z += moveDir.z * accel * dt;

    // Apply movement
    flyPos.addScaledVector(flyVel, dt);

    // Minecraft Creative Flight Drag / Friction:
    const friction = Math.pow(0.08, dt);
    flyVel.multiplyScalar(friction);

    // Apply to Three.js camera
    camera.position.copy(flyPos);
    camera.rotation.set(flyPitch, flyYaw, 0, 'YXZ');

    // Update HUD Coordinates
    if ($('hudCoords')) {
      const px = flyPos.x.toFixed(1);
      const py = (flyPos.y + 22).toFixed(1); // relative to ground level
      const pz = flyPos.z.toFixed(1);
      $('hudCoords').textContent = `XYZ: ${px} / ${py} / ${pz}`;
    }
  } else {
    // ── SMOOTH ORBIT CAMERA ──
    orbitYaw += (targetYaw - orbitYaw) * 0.14;
    orbitPitch += (targetPitch - orbitPitch) * 0.14;
    orbitRadius += (targetRadius - orbitRadius) * 0.14;
    orbitTarget.lerp(targetPos, 0.14);

    const cx = orbitTarget.x + orbitRadius * Math.sin(orbitYaw) * Math.cos(orbitPitch);
    const cy = orbitTarget.y + orbitRadius * Math.sin(orbitPitch);
    const cz = orbitTarget.z + orbitRadius * Math.cos(orbitYaw) * Math.cos(orbitPitch);

    camera.position.set(cx, cy, cz);
    camera.lookAt(orbitTarget);
  }

  renderer.render(scene, camera);
}
animate();

// Resize handler
function onWindowResize() {
  if (!viewport || !renderer || !camera) return;
  const w = viewport.clientWidth || window.innerWidth || 800;
  const h = viewport.clientHeight || window.innerHeight || 600;
  if (w <= 0 || h <= 0) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener('resize', onWindowResize);
if (window.ResizeObserver && viewport) {
  new ResizeObserver(onWindowResize).observe(viewport);
}
setTimeout(onWindowResize, 60);
setTimeout(onWindowResize, 300);

// ── VIEW SWITCHER (3D vs SPLIT vs 2D) ──────────────────────────────────────
let currentMainView = '3d'; // '3d' | 'split' | '2d'

window.switchMainView = function(viewMode) {
  if (viewMode !== '3d' && viewMode !== 'split' && viewMode !== '2d') return;
  currentMainView = viewMode;

  const ws = $('mainWorkspace');
  if (ws) {
    ws.classList.remove('view-mode-3d', 'view-mode-split', 'view-mode-2d');
    ws.classList.add(`view-mode-${viewMode}`);
  }

  // Update button active states
  const b3d = $('btnView3D');
  const bSp = $('btnViewSplit');
  const b2d = $('btnView2D');
  if (b3d) b3d.classList.toggle('active', viewMode === '3d');
  if (bSp) bSp.classList.toggle('active', viewMode === 'split');
  if (b2d) b2d.classList.toggle('active', viewMode === '2d');

  setTimeout(() => {
    onWindowResize();
    if (viewMode === 'split' || viewMode === '2d') {
      draw2DBlueprint();
      renderBpLayerMaterials();
    }
  }, 50);

  if (viewMode === '3d') {
    showToast('Modus: Reine 3D-Ansicht', '🧊');
  } else if (viewMode === 'split') {
    showToast('Modus: Geteilter Bildschirm (3D + 2D)', '◫');
  } else {
    showToast('Modus: 2D Schichtplan Draufsicht', '📐');
  }
  playBeep(480, 0.04);
};

// ── DEDICATED 2D BLUEPRINT (SCHICHTPLAN) ──────────────────────────────────
const bpCanvas = $('blueprintCanvas');
const bpCtx = bpCanvas ? bpCanvas.getContext('2d') : null;
let bpSelectedX = null;
let bpSelectedZ = null;
let bpFilterMat = null;
let bpZoom = 1.0;

window.zoomBlueprint = function(factor) {
  bpZoom = Math.max(0.65, Math.min(2.2, bpZoom * factor));
  draw2DBlueprint();
  showToast(`Raster-Zoom: ${Math.round(bpZoom * 100)}%`, '🔍');
};

window.resetBlueprintZoom = function() {
  bpZoom = 1.0;
  draw2DBlueprint();
  showToast('Raster-Zoom zurückgesetzt', '↺');
};

function draw2DBlueprint() {
  if (!bpCtx || !bpCanvas) return;

  const W = bpCanvas.width;
  const H = bpCanvas.height;
  bpCtx.clearRect(0, 0, W, H);

  // Background
  bpCtx.fillStyle = '#08080c';
  bpCtx.fillRect(0, 0, W, H);

  // Grid dimensions: X -12..12 (25), Z -8..8 (17)
  const cols = 25;
  const rows = 17;
  const baseCellSize = 25;
  const cellSize = Math.round(baseCellSize * bpZoom);

  const gridW = cols * cellSize;
  const gridH = rows * cellSize;
  const originX = Math.round((W - gridW) / 2);
  const originY = Math.round((H - gridH) / 2);

  // Compass and direction banners
  bpCtx.textAlign = 'center';
  bpCtx.textBaseline = 'middle';
  bpCtx.font = '700 11px Outfit, sans-serif';

  // Hinten (+Z)
  bpCtx.fillStyle = '#f5c518';
  bpCtx.fillText('▲ HINTEN (+Z / RÜCKSEITE)', W / 2, Math.max(16, originY - 26));

  // Vorne (-Z)
  bpCtx.fillStyle = '#f5c518';
  bpCtx.fillText('▼ VORNE (−Z / GESICHT & BRUST)', W / 2, Math.min(H - 14, originY + gridH + 26));

  // Links (-X)
  bpCtx.save();
  bpCtx.translate(Math.max(16, originX - 32), H / 2);
  bpCtx.rotate(-Math.PI / 2);
  bpCtx.fillStyle = '#a1a1aa';
  bpCtx.fillText('◀ LINKS (−X)', 0, 0);
  bpCtx.restore();

  // Rechts (+X)
  bpCtx.save();
  bpCtx.translate(Math.min(W - 16, originX + gridW + 32), H / 2);
  bpCtx.rotate(Math.PI / 2);
  bpCtx.fillStyle = '#a1a1aa';
  bpCtx.fillText('RECHTS (+X) ▶', 0, 0);
  bpCtx.restore();

  // Draw X-axis coordinate headers
  bpCtx.font = '600 10px JetBrains Mono, monospace';
  for (let x = -12; x <= 12; x++) {
    const colIdx = x + 12;
    const cx = originX + colIdx * cellSize + cellSize / 2;
    if (x % 2 === 0 || cellSize >= 28) {
      bpCtx.fillStyle = (x === 0) ? '#f5c518' : '#71717a';
      bpCtx.fillText(x > 0 ? '+' + x : '' + x, cx, originY - 10);
      bpCtx.fillText(x > 0 ? '+' + x : '' + x, cx, originY + gridH + 10);
    }
  }

  // Draw Z-axis coordinate headers
  for (let z = 8; z >= -8; z--) {
    const rowIdx = 8 - z;
    const cy = originY + rowIdx * cellSize + cellSize / 2;
    if (z % 2 === 0 || cellSize >= 28) {
      bpCtx.fillStyle = (z === 0) ? '#f5c518' : '#71717a';
      bpCtx.fillText(z > 0 ? '+' + z : '' + z, originX - 14, cy);
      bpCtx.fillText(z > 0 ? '+' + z : '' + z, originX + gridW + 14, cy);
    }
  }

  // Draw Grid Cells
  for (let x = -12; x <= 12; x++) {
    const colIdx = x + 12;
    const px = originX + colIdx * cellSize;

    for (let z = -8; z <= 8; z++) {
      const rowIdx = 8 - z;
      const py = originY + rowIdx * cellSize;

      const b = blockMap.get(`${x},${level},${z}`);

      if (b) {
        const isDimmed = (bpFilterMat !== null && b.m !== bpFilterMat);
        const pColor = palette[b.m][3];

        bpCtx.globalAlpha = isDimmed ? 0.22 : 1.0;

        // Block Base fill
        bpCtx.fillStyle = pColor;
        bpCtx.fillRect(px, py, cellSize, cellSize);

        // Minecraft style bevel
        bpCtx.fillStyle = 'rgba(255, 255, 255, 0.28)';
        bpCtx.fillRect(px, py, cellSize, 2);
        bpCtx.fillRect(px, py, 2, cellSize);

        bpCtx.fillStyle = 'rgba(0, 0, 0, 0.4)';
        bpCtx.fillRect(px, py + cellSize - 2, cellSize, 2);
        bpCtx.fillRect(px + cellSize - 2, py, 2, cellSize);

        // 1px Outer dark frame
        bpCtx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
        bpCtx.lineWidth = 1;
        bpCtx.strokeRect(px + 0.5, py + 0.5, cellSize - 1, cellSize - 1);

        // Material Symbol / Letter
        if (cellSize >= 16) {
          const fontSize = Math.max(10, Math.round(cellSize * 0.48));
          bpCtx.font = `800 ${fontSize}px 'JetBrains Mono', monospace`;
          bpCtx.fillStyle = [0, 4].includes(b.m) ? '#111116' : '#ffffff';
          bpCtx.shadowColor = [0, 4].includes(b.m) ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.85)';
          bpCtx.shadowBlur = 3;
          bpCtx.fillText(palette[b.m][0], px + cellSize / 2, py + cellSize / 2);
          bpCtx.shadowBlur = 0;
        }

        bpCtx.globalAlpha = 1.0;
      } else {
        // Empty cell
        bpCtx.fillStyle = '#0c0c11';
        bpCtx.fillRect(px, py, cellSize, cellSize);

        bpCtx.strokeStyle = '#181820';
        bpCtx.lineWidth = 1;
        bpCtx.strokeRect(px + 0.5, py + 0.5, cellSize - 1, cellSize - 1);

        // Center dot on empty cell for easy grid counting
        if (cellSize >= 18) {
          bpCtx.fillStyle = '#22222d';
          bpCtx.fillRect(px + cellSize / 2 - 1, py + cellSize / 2 - 1, 2, 2);
        }
      }

      // Draw Selected cell glowing border
      if (bpSelectedX === x && bpSelectedZ === z) {
        bpCtx.strokeStyle = '#f5c518';
        bpCtx.lineWidth = 3;
        bpCtx.shadowColor = '#f5c518';
        bpCtx.shadowBlur = 10;
        bpCtx.strokeRect(px - 1, py - 1, cellSize + 2, cellSize + 2);
        bpCtx.shadowBlur = 0;
      }
    }
  }

  // Draw Grid Center Axes Lines
  const centerColX = originX + 12 * cellSize + cellSize / 2;
  const centerRowY = originY + 8 * cellSize + cellSize / 2;

  bpCtx.strokeStyle = 'rgba(245, 197, 24, 0.15)';
  bpCtx.lineWidth = 1;
  bpCtx.setLineDash([4, 4]);
  bpCtx.beginPath();
  bpCtx.moveTo(centerColX, originY);
  bpCtx.lineTo(centerColX, originY + gridH);
  bpCtx.moveTo(originX, centerRowY);
  bpCtx.lineTo(originX + gridW, centerRowY);
  bpCtx.stroke();
  bpCtx.setLineDash([]);
}

// 2D Blueprint Click & Touch Interaction
function handleBpInteraction(clientX, clientY) {
  if (!bpCanvas) return;
  const r = bpCanvas.getBoundingClientRect();
  const scaleX = bpCanvas.width / r.width;
  const scaleY = bpCanvas.height / r.height;

  const clickX = (clientX - r.left) * scaleX;
  const clickY = (clientY - r.top) * scaleY;

  const cols = 25;
  const rows = 17;
  const baseCellSize = 25;
  const cellSize = Math.round(baseCellSize * bpZoom);
  const gridW = cols * cellSize;
  const gridH = rows * cellSize;
  const originX = Math.round((bpCanvas.width - gridW) / 2);
  const originY = Math.round((bpCanvas.height - gridH) / 2);

  const colIdx = Math.floor((clickX - originX) / cellSize);
  const rowIdx = Math.floor((clickY - originY) / cellSize);

  if (colIdx < 0 || colIdx >= cols || rowIdx < 0 || rowIdx >= rows) return;

  const x = colIdx - 12;
  const z = 8 - rowIdx;

  bpSelectedX = x;
  bpSelectedZ = z;
  draw2DBlueprint();

  const b = blockMap.get(`${x},${level},${z}`);
  const textEl = $('bpInspectorText');
  const copyBtn = $('btnCopyBpCmd');

  if (b) {
    const p = palette[b.m];
    textEl.innerHTML = `<span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${p[3]};vertical-align:middle;margin-right:6px;"></span>
      <b style="color:#fff;">${p[1]}</b> (${p[0]}) · <b>X:${x}</b> / <b>Y:${level + 1}</b> / <b>Z:${z}</b> · <span style="color:var(--text-muted);font-size:10px;">minecraft:${p[2]}</span>`;

    copyBtn.style.display = 'inline-block';
    copyBtn.onclick = () => {
      const cmd = `/setblock ~${x} ~${level} ~${z} minecraft:${p[2]}`;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(cmd).then(() => {
          showToast(`Befehl kopiert: ${cmd}`, '📋');
          playSuccessChime();
        });
      }
    };
    playBeep(560, 0.04);
  } else {
    textEl.innerHTML = `<span style="color:var(--text-dim);">X:${x} / Y:${level + 1} / Z:${z}</span> → <span style="color:#71717a;">Luft (Freies Feld)</span>`;
    copyBtn.style.display = 'none';
    playBeep(260, 0.03);
  }
}

if (bpCanvas) {
  bpCanvas.addEventListener('click', e => {
    handleBpInteraction(e.clientX, e.clientY);
  });
  bpCanvas.addEventListener('touchend', e => {
    if (e.changedTouches && e.changedTouches.length > 0) {
      const t = e.changedTouches[0];
      handleBpInteraction(t.clientX, t.clientY);
    }
  }, { passive: true });
}

// Render Material Chips under 2D Blueprint
function renderBpLayerMaterials() {
  const container = $('bpLayerMaterials');
  if (!container) return;

  const layerBlocks = blocks.filter(b => b.y === level);
  const counts = palette.map((_, i) => layerBlocks.filter(b => b.m === i).length);

  const chips = [];

  if (bpFilterMat !== null) {
    chips.push(`
      <button class="bp-mat-chip active" onclick="setBpFilter(null)" style="border-color:var(--accent);color:var(--accent);font-weight:800;">
        ✕ Filter aufheben
      </button>
    `);
  }

  palette.forEach((p, i) => {
    const count = counts[i];
    if (count === 0) return;

    const isActive = (bpFilterMat === i);
    chips.push(`
      <button class="bp-mat-chip ${isActive ? 'active' : ''}" onclick="setBpFilter(${i})" title="Klicke um nur diesen Blocktyp im Schichtplan hervorzuheben">
        <span class="bp-mat-swatch" style="background:${p[3]};"></span>
        <span><b>${p[0]}</b> ${p[1]}:</span>
        <span style="font-family:'JetBrains Mono',monospace;font-weight:800;color:var(--accent);">${count}x</span>
      </button>
    `);
  });

  if (chips.length === 0) {
    container.innerHTML = '<span style="color:var(--text-dim);font-size:11px;">Keine Blöcke in dieser Ebene</span>';
  } else {
    container.innerHTML = chips.join('');
  }
}

window.setBpFilter = function(matIdx) {
  bpFilterMat = (bpFilterMat === matIdx) ? null : matIdx;
  draw2DBlueprint();
  renderBpLayerMaterials();
  if (bpFilterMat !== null) {
    showToast(`Hervorgehoben: ${palette[bpFilterMat][1]}`, '🎯');
    playBeep(620, 0.04);
  } else {
    showToast('Alle Materialien eingeblendet', '👁');
    playBeep(420, 0.04);
  }
};



// ── MATERIALS CALCULATOR & DRAWER ──────────────────────────────────────────
let materialScope = 'all'; // 'all' | 'layer'

function renderMaterials() {
  const counts = materialScope === 'all'
    ? palette.map((_, i) => blocks.filter(b => b.m === i).length)
    : palette.map((_, i) => blocks.filter(b => b.y === level && b.m === i).length);

  const searchEl = $('inputMatSearch');
  const query = (searchEl && searchEl.value) ? searchEl.value.toLowerCase().trim() : '';

  const html = palette.map((p, i) => {
    const count = counts[i];
    const stacks = Math.floor(count / 64);
    const rest = count % 64;
    const isMatching = !query || p[1].toLowerCase().includes(query) || p[2].toLowerCase().includes(query);
    if (!isMatching) return '';

    return `
      <div class="material-item" onclick="copyGiveCmd('${p[2]}', ${count || 64})">
        <span class="mat-swatch-box" style="background:${p[3]}">${p[0]}</span>
        <div class="mat-name-box">
          <div class="name">${p[1]}</div>
          <div class="cmd-hint">minecraft:${p[2]}</div>
          <div class="stacks">📦 ${stacks} Stacks + ${rest}</div>
        </div>
        <div class="mat-count-box">${count.toLocaleString('de-DE')}</div>
      </div>
    `;
  }).filter(Boolean);

  $('materialsList').innerHTML = html.length
    ? html.join('')
    : '<div style="color:#71717a; text-align:center; padding:16px;">Keine Materialien gefunden</div>';
}

window.copyGiveCmd = function(blockId, amount) {
  const count = amount > 0 ? amount : 64;
  const cmd = `/give @p minecraft:${blockId} ${count}`;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(cmd).then(() => {
      showToast(`Give-Befehl kopiert: ${cmd}`, '📋');
      playBeep(640, 0.05);
    });
  }
};

$('btnScopeAll').onclick = () => {
  materialScope = 'all';
  $('btnScopeAll').classList.add('active');
  $('btnScopeLayer').classList.remove('active');
  renderMaterials();
};
$('btnScopeLayer').onclick = () => {
  materialScope = 'layer';
  $('btnScopeLayer').classList.add('active');
  $('btnScopeAll').classList.remove('active');
  renderMaterials();
};
$('inputMatSearch').oninput = renderMaterials;

// Export CSV & JSON
$('btnExportCSV').onclick = () => {
  const totalCounts = palette.map((_, i) => blocks.filter(b => b.m === i).length);
  const csv = '\ufeffBlock;Minecraft-ID;Anzahl;Stacks;Rest\n' +
    palette.map((p, i) => `${p[1]};minecraft:${p[2]};${totalCounts[i]};${Math.floor(totalCounts[i]/64)};${totalCounts[i]%64}`).join('\n');
  downloadFile('oba-eweka-statue-materialien.csv', csv, 'text/csv;charset=utf-8');
  showToast('CSV Materialliste heruntergeladen');
};

$('btnExportJSON').onclick = () => {
  const json = JSON.stringify({
    description: 'Oba Eweka Statue — 50 Ebenen, Hohler Kern',
    palette: palette.map(p => 'minecraft:' + p[2]),
    blocks: blocks.map(b => [b.x, b.y, b.z, b.m])
  }, null, 2);
  downloadFile('oba-eweka-statue-bloecke.json', json, 'application/json');
  showToast('JSON Blockdaten heruntergeladen');
};

function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
}

// ── HEADER & DRAWER TOGGLES ────────────────────────────────────────────────
$('btnToggleStats').onclick = () => {
  const bar = $('statsBar');
  const isOpen = bar.classList.toggle('expanded');
  $('btnToggleStats').classList.toggle('active', isOpen);
};

$('btnToggleDrawer').onclick = () => {
  const drawer = $('sideDrawer');
  const isOpen = drawer.classList.toggle('open');
  $('btnToggleDrawer').classList.toggle('active', isOpen);
};

$('btnCloseDrawer').onclick = () => {
  $('sideDrawer').classList.remove('open');
  $('btnToggleDrawer').classList.remove('active');
};

// Drawer tabs
document.querySelectorAll('.drawer-tab').forEach(tabBtn => {
  tabBtn.onclick = () => {
    document.querySelectorAll('.drawer-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.drawer-section').forEach(s => s.classList.remove('active'));

    tabBtn.classList.add('active');
    const tabName = tabBtn.dataset.tab;
    if (tabName === 'materials') $('tabContentMaterials').classList.add('active');
    if (tabName === 'guide') $('tabContentGuide').classList.add('active');
    if (tabName === 'keys') $('tabContentKeys').classList.add('active');
  };
});

// Sound Toggle
$('btnToggleSound').onclick = () => {
  soundEnabled = !soundEnabled;
  try { localStorage.setItem('statue-sound', soundEnabled); } catch (e) {}
  updateAudioUI();
  showToast(soundEnabled ? 'Sound aktiviert' : 'Sound stummgeschaltet', soundEnabled ? '🔊' : '🔇');
  if (soundEnabled) playBeep(600, 0.08);
};

// Fullscreen Toggle
$('btnFullscreen').onclick = () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
};

// ── CONTEXTUAL LAYER TITLES ───────────────────────────────────────────────
function getLayerContext(lvl) {
  const ebene = lvl + 1;
  if (ebene <= 2) return 'Sockel (Weiße Wolle)';
  if (ebene <= 6) return 'Gewand Streifen 1 (Schwarz & Gelb)';
  if (ebene <= 10) return 'Gewand Streifen 2 (Weiß & Schwarz)';
  if (ebene <= 15) return 'Gewand Streifen 3 (Gelb & Schwarz)';
  if (ebene <= 20) return 'Gewand Abschluss (Gelb & Schwarz)';
  if (ebene === 21) return 'Plattform (17×9 Weiße Wolle)';
  if (ebene === 22) return 'Start Oberteil (Rote Terrakotta)';
  if (ebene <= 28) return 'Oberkörper & Arme (Rot)';
  if (ebene <= 30) return 'Korallen-Halskrause & Kragen';
  if (ebene <= 35) return 'Kopf & Gesicht (Augen & Nase)';
  if (ebene <= 37) return 'Korallenkappe (Rot & Gelb)';
  if (ebene <= 41) return 'Krone & Seiten-Haken';
  return 'Weiße Feder (Kronenspitze)';
}

// ── LAYER CONTROLS & STATE UPDATE ──────────────────────────────────────────
window.jumpToLayer = function(targetLevel) {
  level = Math.max(0, Math.min(maxLevel, targetLevel));
  try { localStorage.setItem(storageKeyLevel, level); } catch(e) {}
  if (navigator.vibrate) try { navigator.vibrate(12); } catch(err) {}
  playBeep(440 + level * 5, 0.04);
  updateUI();
};

function stepLayer(delta) {
  const newL = Math.max(0, Math.min(maxLevel, level + delta));
  if (newL !== level) {
    level = newL;
    try { localStorage.setItem(storageKeyLevel, level); } catch(e) {}
    if (navigator.vibrate) try { navigator.vibrate(10); } catch(err) {}
    playBeep(380 + level * 6, 0.03);
    updateUI();
  }
}

if ($('layerSlider')) {
  $('layerSlider').max = maxLevel;
  $('layerSlider').oninput = e => {
    level = +e.target.value;
    try { localStorage.setItem(storageKeyLevel, level); } catch(e) {}
    if (navigator.vibrate) try { navigator.vibrate(5); } catch(err) {}
    playBeep(380 + level * 6, 0.02);
    updateUI();
  };
}

if ($('btnPrevLayer')) $('btnPrevLayer').onclick = () => stepLayer(-1);
if ($('btnNextLayer')) $('btnNextLayer').onclick = () => stepLayer(1);

// Done Checkbox
if ($('chkDoneLayer')) {
  $('chkDoneLayer').onchange = e => {
    if (e.target.checked) {
      completedLayers.add(level);
      playSuccessChime();
      showToast(`Ebene ${level + 1} fertig gebaut! 🎉`);
    } else {
      completedLayers.delete(level);
    }
    try {
      localStorage.setItem(storageKeyCompleted, JSON.stringify([...completedLayers]));
    } catch (err) {}
    updateUI();
  };
}

// Only From Platform Checkbox
if ($('chkOnlyFromPlatform')) {
  $('chkOnlyFromPlatform').checked = onlyFromPlatform;
  $('chkOnlyFromPlatform').onchange = e => {
    onlyFromPlatform = e.target.checked;
    try { localStorage.setItem('statue-platform-only', onlyFromPlatform); } catch (err) {}
    showToast(onlyFromPlatform ? 'Ansicht: Ab deiner Plattform (Ebene 21+)' : 'Ansicht: Gesamte Statue von Sockel ab', '🏗');
    updateUI();
  };
}

// Overall UI state update
function updateUI() {
  const ebene = level + 1;
  const totalLayers = (typeof modelInfo !== 'undefined' && modelInfo.height) ? modelInfo.height : 44;
  if ($('layerSlider')) {
    $('layerSlider').max = totalLayers - 1;
    $('layerSlider').value = level;
  }
  if ($('sliderValDisplay')) $('sliderValDisplay').textContent = `${ebene} / ${totalLayers}`;
  if ($('layerPill')) $('layerPill').textContent = `EBENE ${ebene} / ${totalLayers}`;
  if ($('layerContextText')) $('layerContextText').textContent = getLayerContext(level);
  if ($('chkOnlyFromPlatform')) $('chkOnlyFromPlatform').checked = onlyFromPlatform;
  if ($('chkOnlyPlatformText')) $('chkOnlyPlatformText').textContent = onlyFromPlatform ? '⚡ Ab 21+' : '🏗️ Ab 21+';
  if ($('labelPlatformOnly')) $('labelPlatformOnly').classList.toggle('is-active', onlyFromPlatform);

  // Highlight active quick-jump buttons
  const jOber = $('btnJumpOberteil');
  const jOberBig = $('btnJumpOberteilBig');
  if (jOber) {
    jOber.classList.toggle('active-accent', ebene >= 22);
    if ($('btnJumpOberteilText')) $('btnJumpOberteilText').textContent = ebene >= 22 ? 'Im Oberteil' : 'Ebene 22';
  }
  if (jOberBig) jOberBig.classList.toggle('active-current', ebene === 22);

  const layerBlockCount = blocks.filter(b => b.y === level).length;
  const isDone = completedLayers.has(level);
  if ($('chkDoneLayer')) $('chkDoneLayer').checked = isDone;
  if ($('chkDoneLayerText')) $('chkDoneLayerText').textContent = isDone ? '✓ Gebaut' : '○ Offen';
  if ($('labelDoneLayer')) $('labelDoneLayer').classList.toggle('is-built', isDone);

  // Stats bar updates
  if ($('statTotalBlocks')) $('statTotalBlocks').textContent = blocks.length.toLocaleString('de-DE');
  const stacks = Math.floor(blocks.length / 64);
  const rest = blocks.length % 64;
  if ($('statTotalStacks')) $('statTotalStacks').textContent = `${stacks} Stacks + ${rest}`;
  if ($('statProgressVal')) $('statProgressVal').textContent = `${completedLayers.size} / ${totalLayers}`;
  if ($('statProgressPercent')) $('statProgressPercent').textContent = `${Math.round(completedLayers.size / totalLayers * 100)}% fertig`;

  // 2D Blueprint Header
  if ($('bpLayerTitle')) $('bpLayerTitle').textContent = `Ebene ${ebene} / ${totalLayers} — ${getLayerContext(level)}`;
  if ($('bpLayerSub')) $('bpLayerSub').textContent = `${layerBlockCount} Blöcke in dieser Ebene`;

  updateVoxelLayers();
  draw2DBlueprint();
  renderBpLayerMaterials();
  renderMaterials();
}

// Initial draw
updateUI();

// ── ISOLIERTE LOKALE SITZUNG (Jeder Nutzer hat seine eigene unabhängige Ansicht) ──
// Niemand kann etwas für andere verändern und nichts wird online überschrieben!
window.copyStatueShareUrl = function() {
  const origin = window.location.origin || 'https://minusnd.de';
  const url = origin + '/statue/' + (profileId !== 'default' ? ('?u=' + profileId) : '');
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(url).then(() => {
      showToast('Bauplan-Link kopiert! Jeder hat seine eigene Ansicht.', '📋');
      playSuccessChime();
    }).catch(() => {
      prompt('Bauplan-Link kopieren:', url);
    });
  } else {
    prompt('Bauplan-Link kopieren:', url);
  }
};
