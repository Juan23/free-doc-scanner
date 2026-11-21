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

type Line = { theta: number; rho: number };

const area = (q: Quad) =>
  Math.abs(q.reduce((s, p, i) => s + p.x * q[(i + 1) % 4].y - q[(i + 1) % 4].x * p.y, 0)) / 2;

/** Sobel gradients of a 3x3-blurred luma copy, plus the gradient magnitude thinned to 1-px ridges. */
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
  // tan(67.5°): splits gradient directions into horizontal, vertical, and the two diagonals.
  const TAN_67_5 = 2.414;
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
      if (ax > TAN_67_5 * ay) {
        m1 = mag[p - 1];
        m2 = mag[p + 1];
      } else if (ay > TAN_67_5 * ax) {
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

// Cap peaks per 6-degree sector so dense text or ruled lines cannot crowd out perpendicular edges.
const MAX_LINES_PER_SECTOR = 2;
// Cap total Hough lines kept so the 4-line search stays bounded.
const MAX_HOUGH_LINES = 24;
// Bent or faint page sides cast few votes, so the floor is low; `backgroundShare` turns away the false frames it lets in.
const MIN_VOTES = 14;

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
        if (t < 0) t += 180;
        else if (t >= 180) t -= 180;
        const r = Math.round((x + 0.5) * COS[t] + (y + 0.5) * SIN[t]) + maxRho;
        if (r >= 0 && r < numRho) acc[t * numRho + r] += Math.min(1, nms[p] / 80);
      }
    }
  }

  const peaks: (Line & { votes: number })[] = [];
  for (let t = 0; t < THETA_BINS; t++) {
    for (let r = 0; r < numRho; r++) {
      const v = acc[t * numRho + r];
      if (v < MIN_VOTES) continue;
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
  const sectorCount = new Uint8Array(30);
  const selected: Line[] = [];
  for (const { theta, rho } of peaks) {
    const sector = Math.min(29, Math.floor(((theta * 180) / Math.PI) / 6));
    if (sectorCount[sector] >= MAX_LINES_PER_SECTOR) continue;
    sectorCount[sector]++;
    selected.push({ theta, rho });
    if (selected.length >= MAX_HOUGH_LINES) break;
  }
  return selected;
}

// sin(~14.5°): rejects nearly parallel lines whose intersection is unstable.
const MIN_INTERSECT_DET = 0.25;

function intersect(a: Line, b: Line): Point | null {
  const ca = Math.cos(a.theta);
  const sa = Math.sin(a.theta);
  const cb = Math.cos(b.theta);
  const sb = Math.sin(b.theta);
  const det = ca * sb - sa * cb;
  if (Math.abs(det) < MIN_INTERSECT_DET) return null;
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

// Rejects diamond-shaped quads (~45° rotated) where top-left vs adjacent corners are ambiguous.
const MIN_CORNER_SUM_GAP = 0.05;

/** Order 4 points clockwise from top-left; null when they are not convex or the corners are ~45° ambiguous. */
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
  if (Math.min(trSum - tlSum, blSum - tlSum) < MIN_CORNER_SUM_GAP * minSide) return null;
  return ordered;
}

type EdgeSample = { x: number; y: number; weight: number };

/** Strongest perpendicular-gradient pixels within +-2 px of segment AB, sampled at `steps` points. */
function sampleSide(
  a: Point,
  b: Point,
  gx: Int16Array,
  gy: Int16Array,
  w: number,
  h: number,
  steps: number,
): EdgeSample[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 10) return [];
  const nx = -dy / len;
  const ny = dx / len;
  const samples: EdgeSample[] = [];
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const sx = a.x + dx * t;
    const sy = a.y + dy * t;
    let bestG = 0;
    let bx = 0;
    let by = 0;
    for (let d = -2; d <= 2; d++) {
      const ix = Math.max(1, Math.min(w - 2, Math.floor(sx + nx * d)));
      const iy = Math.max(1, Math.min(h - 2, Math.floor(sy + ny * d)));
      const p = iy * w + ix;
      const g = Math.abs(gx[p] * nx + gy[p] * ny);
      if (g > bestG) {
        bestG = g;
        bx = ix + 0.5;
        by = iy + 0.5;
      }
    }
    if (bestG >= MIN_EDGE) samples.push({ x: bx, y: by, weight: bestG });
  }
  return samples;
}

/** Fraction of sample points along segment AB that have a perpendicular gradient edge within +-2 px. */
function sideSupport(a: Point, b: Point, gx: Int16Array, gy: Int16Array, w: number, h: number): number {
  const steps = 32;
  return sampleSide(a, b, gx, gy, w, h, steps).length / (steps - 1);
}

/** Fit a sub-pixel line to the strongest perpendicular-gradient pixels near segment AB. */
function refineLine(a: Point, b: Point, gx: Int16Array, gy: Int16Array, w: number, h: number): Line | null {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const pts = sampleSide(a, b, gx, gy, w, h, Math.max(16, Math.round(len)));
  let sumW = 0;
  let mx = 0;
  let my = 0;
  for (const pt of pts) {
    sumW += pt.weight;
    mx += pt.weight * pt.x;
    my += pt.weight * pt.y;
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
  return { theta, rho: mx * Math.cos(theta) + my * Math.sin(theta) };
}

// Rejects pages longer than 3.5:1, e.g. receipts or thin strips.
const MAX_SIDE_RATIO = 3.5;
// Minimum fraction of a candidate side that must sit on a real edge.
const MIN_SIDE_SUPPORT = 0.45;

// A frame is not the page when more of its inside than this looks like the ground just outside it.
const MAX_BACKGROUND_SHARE = 0.15;
// Ground inside a frame costs it score, so a frame hugging the page beats one spanning ground beside it.
const BACKGROUND_PENALTY = 2;
// Two colours count as alike when their red, green and blue differences add up to less than this.
const ALIKE_COLOR = 25;
// Distances outside a side, in search-copy px, where its outside colour is read; past the edge's blur.
const OUTSIDE_PX = [4, 5, 6];

const medianColor = (channels: number[][]) =>
  channels.map((v) => v.sort((m, n) => m - n)[v.length >> 1]);

const colorDiff = (c: number[], r: number, g: number, b: number) =>
  Math.abs(c[0] - r) + Math.abs(c[1] - g) + Math.abs(c[2] - b);

function outwardNormal(q: Quad, s: number): { nx: number; ny: number } {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  const a = q[s];
  const b = q[(s + 1) % 4];
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  let nx = (b.y - a.y) / len;
  let ny = -(b.x - a.x) / len;
  if (nx * ((a.x + b.x) / 2 - cx) + ny * ((a.y + b.y) / 2 - cy) < 0) {
    nx = -nx;
    ny = -ny;
  }
  return { nx, ny };
}

/** True when side `s` sits on a continuous dark seam (like a book gutter) darker than `paper`. */
function hasDarkGutter(q: Quad, s: number, paper: number[], rgba: Uint8Array, w: number, h: number): boolean {
  const { nx, ny } = outwardNormal(q, s);
  const a = q[s];
  const b = q[(s + 1) % 4];
  const steps = 32;
  const sums: number[] = [];
  for (let i = 4; i < steps - 3; i++) {
    for (const d of [1, 2]) {
      const x = Math.max(0, Math.min(w - 1, Math.round(a.x + ((b.x - a.x) * i) / steps + nx * d)));
      const y = Math.max(0, Math.min(h - 1, Math.round(a.y + ((b.y - a.y) * i) / steps + ny * d)));
      const o = (y * w + x) * 4;
      sums.push(rgba[o] + rgba[o + 1] + rgba[o + 2]);
    }
  }
  sums.sort((m, n) => m - n);
  return paper[0] + paper[1] + paper[2] - sums[sums.length >> 1] >= ALIKE_COLOR * 6;
}

/** The median colour a few px outside each side of the frame, as [r, g, b] per side. */
function outsideColors(q: Quad, rgba: Uint8Array, w: number, h: number): number[][] {
  const steps = 32;
  return [0, 1, 2, 3].map((s) => {
    const a = q[s];
    const b = q[(s + 1) % 4];
    const { nx, ny } = outwardNormal(q, s);
    const channels: number[][] = [[], [], []];
    // The ends are skipped: they sit at corners, where the neighbouring side is.
    for (let i = 4; i < steps - 3; i++) {
      for (const d of OUTSIDE_PX) {
        const x = Math.max(0, Math.min(w - 1, Math.round(a.x + ((b.x - a.x) * i) / steps + nx * d)));
        const y = Math.max(0, Math.min(h - 1, Math.round(a.y + ((b.y - a.y) * i) / steps + ny * d)));
        for (let c = 0; c < 3; c++) channels[c].push(rgba[(y * w + x) * 4 + c]);
      }
    }
    return medianColor(channels);
  });
}

/** Share of the frame's inside connected to its border that matches the ground outside a non-paper side. */
function backgroundShare(q: Quad, rgba: Uint8Array, w: number, h: number): number {
  const outside = outsideColors(q, rgba, w, h);
  const grid = 24;
  const n = grid * grid;
  const offset = new Int32Array(n).fill(-1);
  const channels: number[][] = [[], [], []];
  let counted = 0;
  for (let i = 0; i < grid; i++) {
    const u = (i + 0.5) / grid;
    const topX = q[0].x + (q[1].x - q[0].x) * u;
    const topY = q[0].y + (q[1].y - q[0].y) * u;
    const bottomX = q[3].x + (q[2].x - q[3].x) * u;
    const bottomY = q[3].y + (q[2].y - q[3].y) * u;
    for (let j = 0; j < grid; j++) {
      const v = (j + 0.5) / grid;
      const x = Math.round(topX + (bottomX - topX) * v);
      const y = Math.round(topY + (bottomY - topY) * v);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const o = (y * w + x) * 4;
      offset[i * grid + j] = o;
      counted++;
      for (let c = 0; c < 3; c++) channels[c].push(rgba[o + c]);
    }
  }
  if (!counted) return 1;

  const paper = medianColor(channels);
  const nonPaper = outside.filter((c) => colorDiff(c, paper[0], paper[1], paper[2]) >= ALIKE_COLOR);
  const spine = outside.findIndex((c) => colorDiff(c, paper[0], paper[1], paper[2]) < ALIKE_COLOR);
  // A real open-book spine has a dark gutter and three non-paper sides; other interior matches are false cuts.
  const isBookSpine =
    nonPaper.length === 3 &&
    nonPaper.every((c) => colorDiff(c, paper[0], paper[1], paper[2]) >= ALIKE_COLOR * 3) &&
    hasDarkGutter(q, spine, paper, rgba, w, h);
  const ground = isBookSpine ? nonPaper : outside;

  const matchesGround = new Uint8Array(n);
  // Textured ground varies past ALIKE_COLOR across speckles, so flood connectivity uses a 3x band.
  const nearGround = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const o = offset[k];
    if (o < 0) continue;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    if (ground.some((c) => colorDiff(c, r, g, b) < ALIKE_COLOR)) {
      matchesGround[k] = 1;
      nearGround[k] = 1;
    } else if (ground.some((c) => colorDiff(c, r, g, b) < ALIKE_COLOR * 3)) {
      nearGround[k] = 1;
    }
  }

  const visited = new Uint8Array(n);
  const queue: number[] = [];
  const seed = (k: number) => {
    if (nearGround[k] && !visited[k]) {
      visited[k] = 1;
      queue.push(k);
    }
  };
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      if (i !== 0 && i !== grid - 1 && j !== 0 && j !== grid - 1) continue;
      const k = i * grid + j;
      seed(k);
      const o = offset[k];
      // Step past an edge cell on a dark seam or text line, but never past a paper margin.
      if (o >= 0 && !nearGround[k] && colorDiff(paper, rgba[o], rgba[o + 1], rgba[o + 2]) >= ALIKE_COLOR * 2) {
        const ni = i === 0 ? 1 : i === grid - 1 ? grid - 2 : i;
        const nj = j === 0 ? 1 : j === grid - 1 ? grid - 2 : j;
        seed(ni * grid + nj);
      }
    }
  }

  let alike = 0;
  for (let head = 0; head < queue.length; head++) {
    const k = queue[head];
    if (matchesGround[k]) alike++;
    const i = Math.floor(k / grid);
    const j = k % grid;
    for (const [ni, nj] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]]) {
      if (ni < 0 || ni >= grid || nj < 0 || nj >= grid) continue;
      const nk = ni * grid + nj;
      if (nearGround[nk] && !visited[nk]) {
        visited[nk] = 1;
        queue.push(nk);
      }
    }
  }
  return alike / counted;
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
          if (Math.max(...sides) > MAX_SIDE_RATIO * Math.min(...sides)) continue;

          let score = 0;
          let ok = true;
          for (let s = 0; s < 4; s++) {
            const a = q[s];
            const b = q[(s + 1) % 4];
            const sup = sideSupport(a, b, gx, gy, w, h);
            if (sup < MIN_SIDE_SUPPORT) {
              ok = false;
              break;
            }
            score += sup * Math.hypot(b.x - a.x, b.y - a.y);
          }
          if (!ok) continue;
          const share = backgroundShare(q, rgba, w, h);
          if (share > MAX_BACKGROUND_SHARE) continue;
          const weighted = score * (1 - BACKGROUND_PENALTY * share);
          if (weighted > bestScore) {
            bestScore = weighted;
            bestQuad = q;
          }
        }
      }
    }
  }

  if (!bestQuad) return null;
  const refined = [0, 1, 2, 3].map((s) => refineLine(bestQuad[s], bestQuad[(s + 1) % 4], gx, gy, w, h));
  const allLines = (ls: (Line | null)[]): ls is Line[] => ls.every((l) => l !== null);
  if (allLines(refined)) {
    const r0 = intersect(refined[3], refined[0]);
    const r1 = intersect(refined[0], refined[1]);
    const r2 = intersect(refined[1], refined[2]);
    const r3 = intersect(refined[2], refined[3]);
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

  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
  const found = pageCorners(rgba, sw, sh);
  const corners = found
    ? (found.map((p) => ({
        x: clamp((p.x * width) / sw, width),
        y: clamp((p.y * height) / sh, height),
      })) as Quad)
    : whole(width, height);
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
