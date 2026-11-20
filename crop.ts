import { AlphaType, ColorType, FilterMode, ImageFormat, MipmapMode, Skia, TileMode } from '@shopify/react-native-skia';
import { File } from 'expo-file-system';

import { shrunkCopy } from './clean';
import { readPage } from './scans';

export type Point = { x: number; y: number };
/** Page corners in photo pixels: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Point, Point, Point, Point];
/** A photo's size and the corners of the page in it. */
export type FoundPage = { width: number; height: number; corners: Quad };

const whole = (w: number, h: number): Quad => [
  { x: 0, y: 0 },
  { x: w, y: 0 },
  { x: w, y: h },
  { x: 0, y: h },
];

/** True when the corners go round the outline in order without crossing or folding in. */
export function isConvex(q: Quad): boolean {
  const turns = q.map((p, i) => {
    const a = q[(i + 1) % 4];
    const b = q[(i + 2) % 4];
    return (a.x - p.x) * (b.y - a.y) - (a.y - p.y) * (b.x - a.x);
  });
  return turns.every((t) => t > 0) || turns.every((t) => t < 0);
}

const SEARCH_LONG_SIDE = 300;
const MIN_EDGE = 24;
const THETA_BINS = 180;
const COS = new Float32Array(THETA_BINS);
const SIN = new Float32Array(THETA_BINS);
for (let t = 0; t < THETA_BINS; t++) {
  const rad = (t * Math.PI) / THETA_BINS;
  COS[t] = Math.cos(rad);
  SIN[t] = Math.sin(rad);
}

type Line = { theta: number; rho: number; votes: number };

const area = (q: Quad) =>
  Math.abs(q.reduce((s, p, i) => s + p.x * q[(i + 1) % 4].y - q[(i + 1) % 4].x * p.y, 0)) / 2;

/** 3x3 Gaussian-smoothed luma and Sobel gradient magnitude / components. */
function edgeMap(rgba: Uint8Array, w: number, h: number) {
  const n = w * h;
  const luma = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    luma[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
  }
  const blur = new Uint8Array(luma);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      blur[p] =
        (luma[p - w - 1] + 2 * luma[p - w] + luma[p - w + 1] +
          2 * luma[p - 1] + 4 * luma[p] + 2 * luma[p + 1] +
          luma[p + w - 1] + 2 * luma[p + w] + luma[p + w + 1]) >> 4;
    }
  }
  const gx = new Int16Array(n);
  const gy = new Int16Array(n);
  const mag = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const dx =
        blur[p - w + 1] + 2 * blur[p + 1] + blur[p + w + 1] -
        (blur[p - w - 1] + 2 * blur[p - 1] + blur[p + w - 1]);
      const dy =
        blur[p + w - 1] + 2 * blur[p + w] + blur[p + w + 1] -
        (blur[p - w - 1] + 2 * blur[p - w] + blur[p - w + 1]);
      gx[p] = dx;
      gy[p] = dy;
      mag[p] = Math.hypot(dx, dy);
    }
  }
  // Thin edges to 1-px ridges so broad glare gradients do not accumulate votes.
  const nms = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const m = mag[p];
      if (m < MIN_EDGE) continue;
      const ax = Math.abs(gx[p]);
      const ay = Math.abs(gy[p]);
      let m1: number;
      let m2: number;
      if (ax > 2.414 * ay) {
        m1 = mag[p - 1];
        m2 = mag[p + 1];
      } else if (ay > 2.414 * ax) {
        m1 = mag[p - w];
        m2 = mag[p + w];
      } else if ((gx[p] > 0) === (gy[p] > 0)) {
        m1 = mag[p - w - 1];
        m2 = mag[p + w + 1];
      } else {
        m1 = mag[p - w + 1];
        m2 = mag[p + w - 1];
      }
      if (m >= m1 && m >= m2) nms[p] = m;
    }
  }
  return { gx, gy, nms };
}

/** Top straight lines found by oriented Hough voting on thinned edges. */
function houghLines(gx: Int16Array, gy: Int16Array, nms: Float32Array, w: number, h: number): Line[] {
  const maxRho = Math.ceil(Math.hypot(w, h));
  const numRho = maxRho * 2 + 1;
  const acc = new Float32Array(THETA_BINS * numRho);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (nms[p] < MIN_EDGE) continue;
      let deg = Math.round((Math.atan2(gy[p], gx[p]) * 180) / Math.PI);
      if (deg < 0) deg += 180;
      if (deg >= 180) deg -= 180;
      for (let dt = -2; dt <= 2; dt++) {
        let t = deg + dt;
        let flip = 1;
        if (t < 0) {
          t += 180;
          flip = -1;
        } else if (t >= 180) {
          t -= 180;
          flip = -1;
        }
        const r = Math.round((x * COS[t] + y * SIN[t]) * flip) + maxRho;
        if (r >= 0 && r < numRho) acc[t * numRho + r] += Math.min(1, nms[p] / 80);
      }
    }
  }

  const minVotes = Math.max(14, Math.round(0.10 * Math.min(w, h)));
  const peaks: Line[] = [];
  for (let t = 0; t < THETA_BINS; t++) {
    for (let r = 0; r < numRho; r++) {
      const v = acc[t * numRho + r];
      if (v < minVotes) continue;
      let best = true;
      for (let dt = -5; dt <= 5 && best; dt++) {
        let tt = t + dt;
        let mirror = false;
        if (tt < 0) {
          tt += 180;
          mirror = true;
        } else if (tt >= 180) {
          tt -= 180;
          mirror = true;
        }
        const rrCenter = mirror ? numRho - 1 - r : r;
        for (let dr = -8; dr <= 8; dr++) {
          if (dt === 0 && dr === 0) continue;
          const rr = rrCenter + dr;
          if (rr < 0 || rr >= numRho) continue;
          const nv = acc[tt * numRho + rr];
          if (nv > v || (nv === v && (tt < t || (tt === t && rr < r)))) {
            best = false;
            break;
          }
        }
      }
      if (best) peaks.push({ theta: (t * Math.PI) / THETA_BINS, rho: r - maxRho, votes: v });
    }
  }
  peaks.sort((a, b) => b.votes - a.votes);
  // Cap peaks per 6-degree sector so dense text or ruled lines cannot crowd out perpendicular edges.
  const sectorCount = new Uint8Array(30);
  const selected: Line[] = [];
  for (const line of peaks) {
    const sector = Math.min(29, Math.floor(((line.theta * 180) / Math.PI) / 6));
    if (sectorCount[sector] >= 2) continue;
    sectorCount[sector]++;
    selected.push(line);
    if (selected.length >= 24) break;
  }
  return selected;
}

function intersect(a: Line, b: Line): Point | null {
  const ca = Math.cos(a.theta);
  const sa = Math.sin(a.theta);
  const cb = Math.cos(b.theta);
  const sb = Math.sin(b.theta);
  const det = ca * sb - sa * cb;
  if (Math.abs(det) < 0.25) return null;
  return {
    x: (a.rho * sb - b.rho * sa) / det,
    y: (ca * b.rho - cb * a.rho) / det,
  };
}

function angleDiffDeg(a: number, b: number): number {
  let d = (Math.abs(a - b) * 180) / Math.PI;
  if (d > 90) d = 180 - d;
  return d;
}

/** Order 4 convex points clockwise starting from top-left; null if corners are ~45° ambiguous. */
function orderCorners(pts: Quad): Quad | null {
  const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
  const sorted = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)) as Quad;
  if (!isConvex(sorted)) return null;
  const sums = sorted.map((p) => p.x + p.y);
  let tlIdx = 0;
  for (let i = 1; i < 4; i++) {
    if (sums[i] < sums[tlIdx]) tlIdx = i;
  }
  const ordered = [0, 1, 2, 3].map((i) => sorted[(tlIdx + i) % 4]) as Quad;
  const minSide = Math.min(
    ...[0, 1, 2, 3].map((i) => Math.hypot(ordered[(i + 1) % 4].x - ordered[i].x, ordered[(i + 1) % 4].y - ordered[i].y)),
  );
  const tlSum = ordered[0].x + ordered[0].y;
  const trSum = ordered[1].x + ordered[1].y;
  const blSum = ordered[3].x + ordered[3].y;
  if (Math.min(trSum - tlSum, blSum - tlSum) < 0.05 * minSide) return null;
  return ordered;
}

/** Fraction of sample points along segment AB that have a perpendicular gradient edge within +-2 px. */
function sideSupport(
  a: Point,
  b: Point,
  gx: Int16Array,
  gy: Int16Array,
  w: number,
  h: number,
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 10) return 0;
  const nx = -dy / len;
  const ny = dx / len;
  const steps = 32;
  let hits = 0;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const sx = a.x + dx * t;
    const sy = a.y + dy * t;
    let best = 0;
    for (let d = -2; d <= 2; d++) {
      const ix = Math.max(1, Math.min(w - 2, Math.round(sx + nx * d)));
      const iy = Math.max(1, Math.min(h - 2, Math.round(sy + ny * d)));
      const p = iy * w + ix;
      const g = Math.abs(gx[p] * nx + gy[p] * ny);
      if (g > best) best = g;
    }
    if (best >= MIN_EDGE) hits++;
  }
  return hits / (steps - 1);
}

/** Fit a sub-pixel line to the strongest perpendicular-gradient pixels near segment AB. */
function refineLine(a: Point, b: Point, gx: Int16Array, gy: Int16Array, w: number, h: number): Line | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 10) return null;
  const nx = -dy / len;
  const ny = dx / len;
  const steps = Math.max(16, Math.round(len));
  const pts: { x: number; y: number; weight: number }[] = [];
  let sumW = 0;
  let mx = 0;
  let my = 0;

  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const sx = a.x + dx * t;
    const sy = a.y + dy * t;
    let bestG = 0;
    let bx = 0;
    let by = 0;
    for (let d = -2; d <= 2; d++) {
      const ix = Math.max(1, Math.min(w - 2, Math.round(sx + nx * d)));
      const iy = Math.max(1, Math.min(h - 2, Math.round(sy + ny * d)));
      const p = iy * w + ix;
      const g = Math.abs(gx[p] * nx + gy[p] * ny);
      if (g > bestG) {
        bestG = g;
        bx = ix + 0.5;
        by = iy + 0.5;
      }
    }
    if (bestG >= MIN_EDGE) {
      pts.push({ x: bx, y: by, weight: bestG });
      sumW += bestG;
      mx += bestG * bx;
      my += bestG * by;
    }
  }
  if (pts.length < 8 || sumW === 0) return null;
  mx /= sumW;
  my /= sumW;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const pt of pts) {
    const px = pt.x - mx;
    const py = pt.y - my;
    sxx += pt.weight * px * px;
    syy += pt.weight * py * py;
    sxy += pt.weight * px * py;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy) + Math.PI / 2;
  return { theta, rho: mx * Math.cos(theta) + my * Math.sin(theta), votes: pts.length };
}

/** The page's corners in a small RGBA copy, or null when no page stands out from what is around it. */
function pageCorners(rgba: Uint8Array, w: number, h: number): Quad | null {
  const { gx, gy, nms } = edgeMap(rgba, w, h);
  const lines = houghLines(gx, gy, nms, w, h);
  if (lines.length < 4) return null;

  const minGap = 0.15 * Math.min(w, h);
  const margin = 8;
  const minArea = 0.04 * w * h;
  const cx = w / 2;
  const cy = h / 2;
  const distFromCenter = (l: Line) => cx * Math.cos(l.theta) + cy * Math.sin(l.theta) - l.rho;
  const pairGap = (a: Line, b: Line) => {
    const sameDir = Math.cos(a.theta) * Math.cos(b.theta) + Math.sin(a.theta) * Math.sin(b.theta) >= 0;
    return Math.abs(distFromCenter(a) - (sameDir ? 1 : -1) * distFromCenter(b));
  };
  let bestQuad: Quad | null = null;
  let bestScore = 0;

  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      if (angleDiffDeg(lines[i].theta, lines[j].theta) > 30) continue;
      if (pairGap(lines[i], lines[j]) < minGap) continue;

      for (let k = i + 1; k < lines.length; k++) {
        if (k === j) continue;
        if (angleDiffDeg(lines[i].theta, lines[k].theta) < 40) continue;
        for (let l = k + 1; l < lines.length; l++) {
          if (l === j) continue;
          if (angleDiffDeg(lines[k].theta, lines[l].theta) > 30) continue;
          if (pairGap(lines[k], lines[l]) < minGap) continue;

          const p0 = intersect(lines[i], lines[k]);
          const p1 = intersect(lines[i], lines[l]);
          const p2 = intersect(lines[j], lines[l]);
          const p3 = intersect(lines[j], lines[k]);
          if (!p0 || !p1 || !p2 || !p3) continue;

          const raw: Quad = [p0, p1, p2, p3];
          if (raw.some((p) => p.x < -margin || p.x > w + margin || p.y < -margin || p.y > h + margin)) continue;
          const q = orderCorners(raw);
          if (!q || area(q) < minArea) continue;
          const sides = [0, 1, 2, 3].map((s) => Math.hypot(q[(s + 1) % 4].x - q[s].x, q[(s + 1) % 4].y - q[s].y));
          if (Math.max(...sides) > 3.5 * Math.min(...sides)) continue;

          let score = 0;
          let ok = true;
          for (let s = 0; s < 4; s++) {
            const a = q[s];
            const b = q[(s + 1) % 4];
            const sup = sideSupport(a, b, gx, gy, w, h);
            if (sup < 0.45) {
              ok = false;
              break;
            }
            score += sup * Math.hypot(b.x - a.x, b.y - a.y);
          }
          if (ok && score > bestScore) {
            bestScore = score;
            bestQuad = q;
          }
        }
      }
    }
  }

  if (!bestQuad) return null;
  const refinedLines = [0, 1, 2, 3].map((s) => refineLine(bestQuad[s], bestQuad[(s + 1) % 4], gx, gy, w, h));
  if (refinedLines.every((l) => l !== null)) {
    const r0 = intersect(refinedLines[3]!, refinedLines[0]!);
    const r1 = intersect(refinedLines[0]!, refinedLines[1]!);
    const r2 = intersect(refinedLines[1]!, refinedLines[2]!);
    const r3 = intersect(refinedLines[2]!, refinedLines[3]!);
    if (r0 && r1 && r2 && r3) {
      const rq = orderCorners([r0, r1, r2, r3]);
      if (rq && area(rq) >= minArea) return rq;
    }
  }
  return bestQuad;
}

/** When no page stands out, the corners are the whole photo's. */
export async function findPage(uri: string): Promise<FoundPage> {
  const image = await readPage(uri);
  const width = image.width();
  const height = image.height();
  const scale = Math.min(1, SEARCH_LONG_SIDE / Math.max(width, height));
  const sw = Math.round(width * scale);
  const sh = Math.round(height * scale);
  const small = shrunkCopy(image, sw, sh);
  const rgba = small.readPixels(0, 0, { width: sw, height: sh, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul }) as Uint8Array | null;
  for (const o of [image, small]) o.dispose();
  if (!rgba) throw new Error('unreadable page');

  const found = pageCorners(rgba, sw, sh);
  const corners = found ? (found.map((p) => ({ x: (p.x * width) / sw, y: (p.y * height) / sh })) as Quad) : whole(width, height);
  return { width, height, corners };
}

/** The 3x3 matrix, row by row, that moves each `from` point onto the matching `to` point. */
function perspective(from: Quad, to: Quad): number[] {
  // Eight equations in the matrix's eight unknowns (the ninth is 1), solved by elimination.
  const rows: number[][] = [];
  from.forEach(({ x, y }, i) => {
    const { x: u, y: v } = to[i];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  });
  for (let c = 0; c < 8; c++) {
    const pivot = rows.slice(c).reduce((b, r, i) => (Math.abs(r[c]) > Math.abs(rows[b][c]) ? c + i : b), c);
    [rows[c], rows[pivot]] = [rows[pivot], rows[c]];
    if (Math.abs(rows[c][c]) < 1e-12) throw new Error('corners are in a line');
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = rows[r][c] / rows[c][c];
      for (let k = c; k < 9; k++) rows[r][k] -= f * rows[c][k];
    }
  }
  return [...rows.map((r, i) => r[8] / r[i]), 1];
}

/** Cuts the page inside `corners` out of the photo, straightens it and writes it to `dest` as a JPEG. */
export async function cropPage(uri: string, corners: Quad, dest: string): Promise<void> {
  const [tl, tr, br, bl] = corners;
  const length = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const w = Math.max(1, Math.round(Math.max(length(tl, tr), length(bl, br))));
  const h = Math.max(1, Math.round(Math.max(length(tl, bl), length(tr, br))));
  const image = await readPage(uri);
  const matrix = Skia.Matrix(perspective(corners, whole(w, h)));
  const shader = image.makeShaderOptions(TileMode.Clamp, TileMode.Clamp, FilterMode.Linear, MipmapMode.None, matrix);
  const paint = Skia.Paint();
  paint.setShader(shader);
  const surface = Skia.Surface.Make(w, h)!;
  surface.getCanvas().drawPaint(paint);
  const page = surface.makeImageSnapshot();
  const bytes = page.encodeToBytes(ImageFormat.JPEG, 90);
  for (const o of [image, matrix, shader, paint, surface, page]) o.dispose();
  // Native Skia returns null when encoding fails, whatever the type says.
  if (!bytes?.length) throw new Error('could not encode page');
  await new File(dest).write(bytes);
}
