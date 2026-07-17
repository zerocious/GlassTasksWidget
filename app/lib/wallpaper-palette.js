'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { nativeImage } = require('electron');

/**
 * Resolve the current Windows desktop wallpaper path.
 * Prefers HKCU WallPaper, then TranscodedWallpaper cache.
 * @returns {string | null}
 */
function resolveWallpaperPath() {
  const candidates = [];

  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'reg',
        ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'WallPaper'],
        { encoding: 'utf8', windowsHide: true, timeout: 4000, maxBuffer: 64 * 1024 }
      );
      const m = out.match(/WallPaper\s+REG_\w+\s+(.+)/i);
      if (m) {
        const p = m[1].trim().replace(/^"(.*)"$/, '$1');
        if (p && !/^\(value not set\)$/i.test(p)) candidates.push(p);
      }
    } catch {
      // registry unavailable — fall through to cache paths
    }

    const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(
      path.join(roaming, 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper'),
      path.join(local, 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper')
    );
  }

  for (const p of candidates) {
    if (!p) continue;
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch {
      // skip unreadable paths
    }
  }
  return null;
}

/**
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {string}
 */
function rgbToHex(r, g, b) {
  const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

/**
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {{ h: number, s: number, l: number }}
 */
function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h, s, l };
}

/**
 * @param {number} h
 * @param {number} s
 * @param {number} l
 * @returns {{ r: number, g: number, b: number }}
 */
function hslToRgb(h, s, l) {
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const hue2rgb = (p, q, t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  };
}

/**
 * Tune sampled color into a usable UI accent (enough chroma, mid lightness).
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {string}
 */
function boostForAccent(r, g, b) {
  const { h, s, l } = rgbToHsl(r, g, b);
  const nextS = Math.max(0.42, Math.min(0.88, s < 0.2 ? 0.55 : s * 1.15));
  const nextL = Math.max(0.32, Math.min(0.52, l < 0.28 ? 0.38 : l > 0.62 ? 0.45 : l));
  const rgb = hslToRgb(h, nextS, nextL);
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

/**
 * Load wallpaper via Electron nativeImage (no extra deps).
 * @param {string} filePath
 * @returns {Electron.NativeImage}
 */
function loadWallpaperImage(filePath) {
  let img = nativeImage.createFromPath(filePath);
  if (!img.isEmpty()) return img;

  // TranscodedWallpaper often has no extension — try buffer decode
  const buf = fs.readFileSync(filePath);
  img = nativeImage.createFromBuffer(buf);
  if (!img.isEmpty()) return img;

  // Hint JPEG for extensionless cache files
  img = nativeImage.createFromBuffer(buf, { format: 'jpeg' });
  if (!img.isEmpty()) return img;

  img = nativeImage.createFromBuffer(buf, { format: 'png' });
  return img;
}

/**
 * Sample a vivid accent from BGRA bitmap (Electron getBitmap on Windows).
 * @param {Buffer} bitmap
 * @param {number} width
 * @param {number} height
 * @returns {string}
 */
function sampleBitmapAccent(bitmap, width, height) {
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let wSum = 0;
  let bestScore = -1;
  let bestR = 196;
  let bestG = 18;
  let bestB = 46;

  const stride = Math.max(1, Math.floor((width * height) / 512));
  let px = 0;

  for (let i = 0; i + 3 < bitmap.length; i += 4, px++) {
    if (px % stride !== 0) continue;
    const b = bitmap[i];
    const g = bitmap[i + 1];
    const r = bitmap[i + 2];
    const a = bitmap[i + 3];
    if (a < 128) continue;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (luma < 28 || luma > 235) continue;
    const sat = max === 0 ? 0 : (max - min) / max;
    if (sat < 0.1) continue;

    const weight = 0.35 + sat * 1.4;
    rSum += r * weight;
    gSum += g * weight;
    bSum += b * weight;
    wSum += weight;

    const score = sat * (1 - Math.abs(luma / 255 - 0.45));
    if (score > bestScore) {
      bestScore = score;
      bestR = r;
      bestG = g;
      bestB = b;
    }
  }

  if (wSum <= 0) {
    // Fallback: plain average of a coarse grid
    let n = 0;
    rSum = gSum = bSum = 0;
    for (let i = 0; i + 3 < bitmap.length; i += 16) {
      rSum += bitmap[i + 2];
      gSum += bitmap[i + 1];
      bSum += bitmap[i];
      n++;
    }
    if (n === 0) return '#C4122E';
    return boostForAccent(rSum / n, gSum / n, bSum / n);
  }

  const ar = rSum / wSum;
  const ag = gSum / wSum;
  const ab = bSum / wSum;
  const r = ar * 0.4 + bestR * 0.6;
  const g = ag * 0.4 + bestG * 0.6;
  const b = ab * 0.4 + bestB * 0.6;
  return boostForAccent(r, g, b);
}

/**
 * Read the desktop wallpaper and return a UI accent hex.
 * @returns {{ accent: string, path: string }}
 */
function sampleWallpaperPalette() {
  const wallpaperPath = resolveWallpaperPath();
  if (!wallpaperPath) {
    throw new Error('Обои рабочего стола не найдены');
  }

  const img = loadWallpaperImage(wallpaperPath);
  if (img.isEmpty()) {
    throw new Error('Не удалось декодировать обои');
  }

  const size = img.getSize();
  const target = 48;
  const scale = Math.min(1, target / Math.max(size.width, size.height, 1));
  const w = Math.max(8, Math.round(size.width * scale));
  const h = Math.max(8, Math.round(size.height * scale));
  const small = img.resize({ width: w, height: h, quality: 'better' });
  const bitmap = small.getBitmap();
  const { width, height } = small.getSize();
  const accent = sampleBitmapAccent(bitmap, width, height);

  return { accent, path: wallpaperPath };
}

module.exports = {
  resolveWallpaperPath,
  sampleWallpaperPalette,
};
