// Oba Eweka 3D Statue — Compressed & Aligned Edition (Ebene 21 = 17x9 Platform)
const palette = [
  ['W', 'Weiße Wolle', 'white_wool', '#e7e3d8'],
  ['K', 'Schwarze Wolle', 'black_wool', '#252529'],
  ['B', 'Braune Wolle', 'brown_wool', '#724728'],
  ['R', 'Rote Terrakotta', 'red_terracotta', '#8e3c2e'],
  ['G', 'Gelbe Terrakotta', 'yellow_terracotta', '#ba8524'],
  ['H', 'Braune Terrakotta', 'brown_terracotta', '#4d3324'],
  ['D', 'Schwarze Terrakotta', 'black_terracotta', '#251710']
];

const vox = new Map();
function put(x, y, z, m) {
  const rx = Math.round(x);
  const ry = Math.round(y);
  const rz = Math.round(z);
  vox.set(rx + ',' + ry + ',' + rz, { x: rx, y: ry, z: rz, m });
}

function ell(cx, cy, cz, rx, ry, rz, m) {
  for (let y = Math.ceil(cy - ry); y <= cy + ry; y++) {
    for (let x = Math.ceil(cx - rx); x <= cx + rx; x++) {
      for (let z = Math.ceil(cz - rz); z <= cz + rz; z++) {
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + ((z - cz) / rz) ** 2 <= 1) {
          put(x, y, z, m);
        }
      }
    }
  }
}

// 1. Lower Robe (y = 0 to 19): 20 tapered layers below Ebene 21
for (let y = 0; y <= 19; y++) {
  const p = y / 20.0;
  const rx = 9.4 - p * 0.9;
  const rz = 5.2 - p * 0.7;
  for (let x = -10; x <= 10; x++) {
    for (let z = -6; z <= 6; z++) {
      if ((x / rx) ** 2 + (z / rz) ** 2 <= 1) {
        const band = y % 5;
        let m = (band < 2) ? 0 : 1;
        const a = Math.atan2(x / rx, -z / rz);
        const motif = ((Math.round(a * 8) % 5) + 5) % 5;
        if (band === 2 && motif === 0) m = 0;
        if (band === 3 && (motif === 0 || motif === 1 || motif === 4)) m = 4;
        if (band === 4 && motif === 0) m = 4;
        put(x, y, z, m);
      }
    }
  }
}

// 2. Ebene 21 (y = 20): EXACT 100% MATCH TO USER SCREENSHOT (17 x 9 Platform)
const e21 = [
  '....KKYYKYYKK....',
  '..KKKWWWWWWWKKKY.',
  'YYWWWWWWWWWWWWWYY',
  'YWWWWWWWWWWWWWWWY',
  'KWWWWWWWWWWWWWWWK',
  'KWWWWWWWWWWWWWWWK',
  'YYYWWWWWWWWWWWYYY',
  '..YYKKKWWWKKKYY..',
  '......KYYYK......'
];
const e21Mat = { 'W': 0, 'K': 1, 'Y': 4 };

for (let r = 0; r < 9; r++) {
  const z = 4 - r;
  for (let c = 0; c < 17; c++) {
    const x = c - 8;
    const ch = e21[r][c];
    if (e21Mat[ch] !== undefined) {
      put(x, 20, z, e21Mat[ch]);
    }
  }
}

// 3. Torso / Woven Jacket (y = 21 to 27) directly on top of Ebene 21 platform
ell(0, 24.5, -0.2, 5.8, 4.2, 3.2, 3);
ell(0, 27.5, -0.2, 4.6, 2.5, 2.8, 3);

// Arms, Sleeves & Resting Hands
for (const s of [-1, 1]) {
  ell(s * 5.2, 25.0, -0.2, 2.0, 3.4, 2.2, 3);
  ell(s * 5.5, 22.5, -1.8, 1.6, 1.8, 1.8, 3);
  ell(s * 4.6, 22.0, -2.8, 1.1, 0.9, 1.1, 2);
  for (let dx = -1; dx <= 1; dx++) {
    put(s * 4.6 + dx, 21.0, -3.2, 4);
  }
}

// Chevron patterns on the woven jacket front
for (let y = 21; y <= 27; y++) {
  for (let x = -4; x <= 4; x++) {
    const zs = [...vox.values()].filter(b => b.x === x && b.y === y).map(b => b.z);
    if (!zs.length) continue;
    const minZ = Math.min(...zs);
    if (Math.abs(Math.abs(x) - Math.round((y - 21) * 0.6)) < 1) {
      put(x, y, minZ, 4);
    } else if (x % 2 === 0 && y < 24) {
      put(x, y, minZ, 5);
    }
  }
}

// 4. Concentric Coral Collar / Neck Rings (y = 27 to 29)
for (let y = 27; y <= 29; y++) {
  const rx = 4.8 - (y - 27) * 0.5;
  const rz = 3.2;
  for (let x = -5; x <= 5; x++) {
    for (let z = -4; z <= 4; z++) {
      if ((x / rx) ** 2 + (z / rz) ** 2 <= 1) {
        put(x, y, z, (y === 27 && x % 2 === 0) ? 4 : 3);
      }
    }
  }
}

// 5. Head & Bronze Face (y = 30 to 35)
ell(0, 32.5, -0.2, 3.2, 3.0, 2.6, 2);
for (let y = 30; y <= 33; y++) {
  for (let x = -2; x <= 2; x++) {
    put(x, y, -2, 2);
  }
}
// Nose
for (let y = 31; y <= 33; y++) put(0, y, -3, 2);
// Eyes and ears
for (const s of [-1, 1]) {
  put(s * 2, 33, -3, 5);
  put(s * 1, 33, -3, 6);
  put(s * 3, 32, 0, 2);
  // Beaded coral strands framing the cheeks
  for (let y = 30; y <= 34; y++) {
    put(s * 3, y, -2, y % 2 === 0 ? 4 : 3);
  }
}

// 6. Rounded Coral Cap (y = 35 to 36)
for (let y = 35; y <= 36; y++) {
  for (let x = -3; x <= 3; x++) {
    for (let z = -3; z <= 3; z++) {
      if ((x / 3.4) ** 2 + (z / 2.8) ** 2 <= 1) {
        put(x, y, z, (y === 35 && (x + z) % 2 === 0) ? 4 : 3);
      }
    }
  }
}

// 7. Central Crown & Side Ornaments (y = 37 to 40)
for (let y = 37; y <= 40; y++) {
  const rad = y < 39 ? 1 : 0;
  for (let x = -1 - rad; x <= -1 + rad; x++) {
    for (let z = -rad; z <= rad; z++) {
      put(x, y, z, (x === -1 && z <= 0) ? 4 : 3);
    }
  }
}
for (const s of [-1, 1]) {
  for (let y = 36; y <= 38; y++) put(s * 3, y, 0, 3);
  put(s * 4, 38, 0, 4);
  put(s * 4, 39, 0, 3);
}

// 8. White Feather Plume (y = 37 to 43)
for (let y = 37; y <= 39; y++) put(2, y, 0, 4);
for (let y = 40; y <= 43; y++) {
  const left = y === 43 ? 2 : 1;
  const right = y === 43 ? 3 : 4;
  for (let x = left; x <= right; x++) put(x, y, 0, 0);
}

// Hollow out interior to save blocks, but preserve Ebene 21 platform intact!
const solidCount = vox.size;
const offsets = [];
for (let dx = -1; dx <= 1; dx++) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx || dy || dz) offsets.push([dx, dy, dz]);
    }
  }
}
const removeKeys = [];
for (const [key, b] of vox) {
  if (b.y !== 20) { // Never remove platform blocks on Ebene 21
    if (offsets.every(([dx, dy, dz]) => vox.has((b.x + dx) + ',' + (b.y + dy) + ',' + (b.z + dz)))) {
      removeKeys.push(key);
    }
  }
}
for (const k of removeKeys) vox.delete(k);

const blocks = [...vox.values()];
const modelInfo = {
  height: 44,
  width: 17,
  depth: 9,
  solidCount,
  saved: solidCount - blocks.length
};

if (typeof module !== 'undefined') module.exports = { blocks, palette, modelInfo };
