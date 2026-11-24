import { AlphaType, ColorType, ImageFormat, Skia, TileMode, type SkImage } from '@shopify/react-native-skia';
import { File } from 'expo-file-system';

import { shrunkCopy } from './clean';
import { decodePage, readPage } from './scans';
import { readUpright, turnedImage } from './upright';

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

const SECTOR_DEG = 6;
// Cap peaks per sector so dense text or ruled lines cannot crowd out perpendicular edges.
const MAX_LINES_PER_SECTOR = 2;
// Cap total Hough lines kept so the 4-line search stays bounded.
const MAX_HOUGH_LINES = 24;

/** Top straight lines found by oriented Hough voting on thinned edges, and every peak, strongest first. */
function houghLines(gx: Int16Array, gy: Int16Array, nms: Float32Array, w: number, h: number): { lines: Line[]; peaks: Line[] } {
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

  const minVotes = Math.max(14, Math.round(0.10 * Math.min(w, h)));
  const peaks: (Line & { votes: number })[] = [];
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
  const sectorCount = new Uint8Array(30);
  const selected: Line[] = [];
  for (const { theta, rho } of peaks) {
    const sector = Math.min(29, Math.floor(((theta * 180) / Math.PI) / SECTOR_DEG));
    if (sectorCount[sector] >= MAX_LINES_PER_SECTOR) continue;
    sectorCount[sector]++;
    selected.push({ theta, rho });
    if (selected.length >= MAX_HOUGH_LINES) break;
  }
  return { lines: selected, peaks };
}

/** The line through a and b, its angle in [0, 180) degrees as Hough gives it. */
function lineThrough(a: Point, b: Point): Line {
  const theta = Math.atan2(b.x - a.x, -(b.y - a.y));
  const rho = a.x * Math.cos(theta) + a.y * Math.sin(theta);
  return theta < 0 ? { theta: theta + Math.PI, rho: -rho } : theta >= Math.PI ? { theta: theta - Math.PI, rho: -rho } : { theta, rho };
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

// Search-copy px past a side to look for paper: past a dark band 12% of a page that fills the copy, and its blur.
const BAND_REACH = 40;
// Search-copy px past a side that must not be paper: a band, not the blur of the side's own edge.
const MIN_BAND = 6;
// A band's far edge runs along the side, so the paper past it starts within this many px of the typical distance.
const BAND_EVEN = 2;
// Two colours are the same when their red, green and blue differences add up to less than this.
const SAME_COLOUR = 40;
// Share of a side's points with paper past a band that makes the side a band's edge, not the page's.
const MIN_PAPER_BEYOND = 0.6;
// A band is at most this share of the paper's brightness: black print is under it, a shadow on a pale table above it.
const BAND_DARK = 0.4;
// Search-copy px either side of a neighbouring side's line where paper is looked for, past its edge's blur.
const BESIDE = [3, 4, 5];
// Search-copy px into the paper past a band that are read, within the thinnest strip a band leaves (3% of a page that fills the copy).
const PAST_BAND = [0, 1, 2];

// Search-copy px past a side where paper means a line of text: past its edge's blur, closer than a band's MIN_BAND.
const CUT_REACH = [3, 4, 5];

// Share of the way up the frame's colours where its paper is read.
const PAPER_SHARE = 0.75;

const brightness = (c: number[]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const sameColour = (c: number[], d: number[]) => Math.abs(c[0] - d[0]) + Math.abs(c[1] - d[1]) + Math.abs(c[2] - d[2]) < SAME_COLOUR;

/** The frame's paper colour and its sides, each with its outward normal and points along it, in a small RGBA copy. */
function framePaper(q: Quad, rgba: Uint8Array, w: number, h: number) {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  const at = (x: number, y: number) => {
    const ix = Math.round(x);
    const iy = Math.round(y);
    return ix < 0 || iy < 0 || ix >= w || iy >= h ? -1 : (iy * w + ix) * 4;
  };
  // Per-channel value this share of the way up the pixels at these offsets, null when none is in the photo.
  const colourAt = (offsets: number[], share: number) => {
    const inPhoto = offsets.filter((o) => o >= 0);
    if (!inPhoto.length) return null;
    return [0, 1, 2].map((c) => inPhoto.map((o) => rgba[o + c]).sort((m, n) => m - n)[Math.floor(inPhoto.length * share)]);
  };
  const medianColour = (offsets: number[]) => colourAt(offsets, 0.5);
  // The frame's paper, on the lines from its middle to its corners; past the median, so text and a band crossing them do not darken it.
  const paper = colourAt(q.flatMap((p) => [1, 2, 3, 4, 5, 6, 7, 8].map((k) => at(cx + ((p.x - cx) * k) / 10, cy + ((p.y - cy) * k) / 10))), PAPER_SHARE)!;
  const isPaper = (o: number) => o >= 0 && sameColour([rgba[o], rgba[o + 1], rgba[o + 2]], paper);

  const steps = 32;
  const along = Array.from({ length: steps - 7 }, (_, j) => (j + 4) / steps);
  const sides = [0, 1, 2, 3].map((s) => {
    const a = q[s];
    const b = q[(s + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    let nx = (b.y - a.y) / len;
    let ny = -(b.x - a.x) / len;
    if (nx * ((a.x + b.x) / 2 - cx) + ny * ((a.y + b.y) / 2 - cy) < 0) [nx, ny] = [-nx, -ny];
    // Points along the side; the ends are skipped, as they sit at corners.
    return { nx, ny, points: along.map((t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })) };
  });
  return { at, medianColour, paper, isPaper, sides };
}

/** True when most of side s has paper closer past it than a band leaves: the side is a line of text on the page, not its edge. */
function cutsPaper(q: Quad, s: number, rgba: Uint8Array, w: number, h: number): boolean {
  const { at, isPaper, sides } = framePaper(q, rgba, w, h);
  const { nx, ny, points } = sides[s];
  const cut = points.filter(({ x, y }) => CUT_REACH.some((d) => isPaper(at(x + nx * d, y + ny * d))));
  return cut.length >= MIN_PAPER_BEYOND * points.length;
}

/** True when most of a side runs along a dark band of even depth with paper past it that shows just inside its neighbouring sides' lines carried on, not just outside, where another sheet would spill past them or stop short. */
function endsAtBand(q: Quad, rgba: Uint8Array, w: number, h: number): boolean {
  const { at, medianColour, paper, isPaper, sides } = framePaper(q, rgba, w, h);

  // shortcut: a second sheet in line with both neighbouring sides, or past which they leave the photo (a page cut by three photo edges), gives the whole photo, upgrade when a real photo shows one.
  const carriesOnPage = (s: number, from: number) =>
    [
      { k: (s + 3) % 4, corner: q[s], far: q[(s + 3) % 4] },
      { k: (s + 1) % 4, corner: q[(s + 1) % 4], far: q[(s + 2) % 4] },
    ].every(({ k, corner, far }) => {
      const len = Math.hypot(corner.x - far.x, corner.y - far.y);
      const ux = (corner.x - far.x) / len;
      const uy = (corner.y - far.y) / len;
      // Px along the neighbouring side's line for each px away from side s.
      const stretch = 1 / (ux * sides[s].nx + uy * sides[s].ny);
      let inside = 0;
      let outside = 0;
      for (const t of PAST_BAND) {
        const x = corner.x + ux * (from + t) * stretch;
        const y = corner.y + uy * (from + t) * stretch;
        for (const e of BESIDE) {
          if (isPaper(at(x - sides[k].nx * e, y - sides[k].ny * e))) inside++;
          if (isPaper(at(x + sides[k].nx * e, y + sides[k].ny * e))) outside++;
        }
      }
      const probes = PAST_BAND.length * BESIDE.length;
      return 2 * inside > probes && 2 * outside < probes;
    });

  return sides.some(({ nx, ny, points }, s) => {
    // Px from (x, y) to the first paper outward (dir 1) or inward (dir -1), 0 when none is within reach.
    const paperFrom = (x: number, y: number, dir: number) => {
      for (let d = 3; d <= BAND_REACH; d++) if (isPaper(at(x + dir * nx * d, y + dir * ny * d))) return d;
      return 0;
    };
    // Paper past a band outside the side, or, when the side is the band's far edge, a band inside it and paper right outside; `past` is where that paper starts.
    type Mark = { x: number; y: number; d: number; dir: number; past: number };
    const outside: Mark[] = [];
    const inside: Mark[] = [];
    for (const { x, y } of points) {
      const out = paperFrom(x, y, 1);
      if (out >= MIN_BAND) outside.push({ x, y, d: out, dir: 1, past: out });
      else if (out > 0) inside.push({ x, y, d: paperFrom(x, y, -1), dir: -1, past: out });
    }
    const isBand = (marks: Mark[]) => {
      const band = marks.filter((m) => m.d >= MIN_BAND).sort((m, n) => m.d - n.d);
      const typical = band[band.length >> 1]?.d;
      const even = band.filter((m) => Math.abs(m.d - typical) <= BAND_EVEN);
      if (even.length < MIN_PAPER_BEYOND * points.length) return false;
      const colour = medianColour(even.map((m) => at(m.x + (m.dir * nx * m.d) / 2, m.y + (m.dir * ny * m.d) / 2)))!;
      const past = even.map((m) => m.past).sort((m, n) => m - n)[even.length >> 1];
      return brightness(colour) < BAND_DARK * brightness(paper) && carriesOnPage(s, past);
    };
    return isBand(outside) || isBand(inside);
  });
}

/** The page's corners in a small RGBA copy, or null when no page stands out from what is around it. */
function pageCorners(rgba: Uint8Array, w: number, h: number): Quad | null {
  const { gx, gy, nms } = edgeMap(rgba, w, h);
  const { lines, peaks } = houghLines(gx, gy, nms, w, h);
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
  // The corners in clockwise order and their score (side length weighted by edge support), or null when they make no page.
  const frame = (raw: Quad): { q: Quad; score: number } | null => {
    if (raw.some((p) => p.x < -margin || p.x > w + margin || p.y < -margin || p.y > h + margin)) return null;
    const q = orderCorners(raw);
    if (!q || area(q) < minArea) return null;
    const sides = [0, 1, 2, 3].map((s) => Math.hypot(q[(s + 1) % 4].x - q[s].x, q[(s + 1) % 4].y - q[s].y));
    if (Math.max(...sides) > MAX_SIDE_RATIO * Math.min(...sides)) return null;
    let score = 0;
    for (let s = 0; s < 4; s++) {
      const sup = sideSupport(q[s], q[(s + 1) % 4], gx, gy, w, h);
      if (sup < MIN_SIDE_SUPPORT) return null;
      score += sup * sides[s];
    }
    return { q, score };
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

          const found = frame([p0, p1, p2, p3]);
          if (found && found.score > bestScore) {
            bestScore = found.score;
            bestQuad = found.q;
          }
        }
      }
    }
  }
  if (!bestQuad) return null;

  // Lines of text parallel to a side can crowd the page's own edge out of the kept lines, so a side on one moves out to the first line past it that does not cut the paper.
  for (let s = 0; s < 4; s++) {
    if (!cutsPaper(bestQuad, s, rgba, w, h)) continue;
    const q: Quad = bestQuad;
    const side = lineThrough(q[s], q[(s + 1) % 4]);
    const before = lineThrough(q[(s + 3) % 4], q[s]);
    const after = lineThrough(q[(s + 1) % 4], q[(s + 2) % 4]);
    const mx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
    const my = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
    const { nx, ny } = framePaper(q, rgba, w, h).sides[s];
    // Distance from the frame's middle to where the line crosses the side's outward normal.
    const reach = (l: Line) => (l.rho - mx * Math.cos(l.theta) - my * Math.sin(l.theta)) / (nx * Math.cos(l.theta) + ny * Math.sin(l.theta));
    const past = peaks
      .filter((l) => angleDiffDeg(l.theta, side.theta) <= SECTOR_DEG && reach(l) > reach(side))
      .sort((a, b) => reach(a) - reach(b));
    for (const l of past) {
      const a = intersect(before, l);
      const b = intersect(l, after);
      if (!a || !b) continue;
      const moved = [...q] as Quad;
      moved[s] = a;
      moved[(s + 1) % 4] = b;
      const found = frame(moved);
      if (!found || cutsPaper(moved, s, rgba, w, h)) continue;
      // Keeps the corner order the later sides' indices rely on.
      bestQuad = moved;
      break;
    }
  }

  // A frame that ends at a band is turned away, never swapped for another: a cut page is worse than the whole photo.
  if (endsAtBand(bestQuad, rgba, w, h)) return null;
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

// A phone's main camera has a focal length of about 0.72 of the photo's long side (24 to 28 mm equivalent);
// a cropped photo keeps that side.
const FOCAL_PER_LONG_SIDE = 0.72;
// How far the focal length read from the corners may stray from that: it is noisy on a page seen nearly flat.
const FOCAL_SPREAD = 1.25;

type Vec = [number, number, number];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Width over height of the rectangle whose photo is `corners`, from the camera's perspective
 * (Zhang and He, "Whiteboard scanning and image enhancement", 2007). NaN when the corners are in a line.
 */
export function pageAspect([tl, tr, br, bl]: Quad, width: number, height: number): number {
  const [m1, m2, m3, m4] = [tl, tr, bl, br].map(({ x, y }): Vec => [x - width / 2, y - height / 2, 1]);
  const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3);
  const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
  const n2 = m2.map((v, i) => k2 * v - m1[i]);
  const n3 = m3.map((v, i) => k3 * v - m1[i]);
  const prior = FOCAL_PER_LONG_SIDE * Math.max(width, height);
  // Two sides that are parallel, or within 1% of it, leave the focal length unknown.
  const parallel = Math.abs(k2 - 1) < 0.01 || Math.abs(k3 - 1) < 0.01;
  const f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]);
  const f = !parallel && f2 > 0 ? Math.min(prior * FOCAL_SPREAD, Math.max(prior / FOCAL_SPREAD, Math.sqrt(f2))) : prior;
  return Math.sqrt(((n2[0] ** 2 + n2[1] ** 2) / f ** 2 + n2[2] ** 2) / ((n3[0] ** 2 + n3[1] ** 2) / f ** 2 + n3[2] ** 2));
}

/** Whether a JPEG has no EXIF block: a PDF shows EXIF-turned pixels sideways. */
function isPlainJpeg(b: Uint8Array): boolean {
  if (b[0] !== 0xff || b[1] !== 0xd8) return false;
  for (let i = 2; i + 9 < b.length && b[i] === 0xff; i += 2 + ((b[i + 2] << 8) | b[i + 3])) {
    const marker = b[i + 1];
    if (marker === 0xe1) return false;
    // Start-of-frame markers, all but DHT (c4), JPG (c8) and DAC (cc).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return true;
  }
  return false;
}

const isWhole = (corners: Quad, width: number, height: number) =>
  whole(width, height).every((p, i) => p.x === corners[i].x && p.y === corners[i].y);

/**
 * Cuts the page inside `corners` out of the photo, straightens it, stands its text upright and writes
 * it to `dest` as a JPEG: one encode in all, none for an upright whole photo with no EXIF block.
 */
export async function cropPage(uri: string, corners: Quad, dest: string): Promise<void> {
  const photo = await new File(uri).bytes();
  const image = decodePage(photo);
  const page = isWhole(corners, image.width(), image.height()) ? image : straightened(image, corners);
  if (page !== image) image.dispose();
  const { turns } = readUpright(page);
  if (!turns && page === image && isPlainJpeg(photo)) {
    page.dispose();
    return new File(dest).write(photo);
  }
  const upright = turns ? turnedImage(page, turns) : page;
  const bytes = upright.encodeToBytes(ImageFormat.JPEG, 90);
  if (upright !== page) upright.dispose();
  page.dispose();
  await writeJpeg(dest, bytes);
}

function straightened(image: SkImage, corners: Quad): SkImage {
  const [tl, tr, br, bl] = corners;
  const length = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const across = Math.max(length(tl, tr), length(bl, br));
  const down = Math.max(length(tl, bl), length(tr, br));
  const found = pageAspect(corners, image.width(), image.height());
  const aspect = found > 0 && Number.isFinite(found) ? found : across / down;
  // Tall enough that neither side is shrunk, but no more pixels than the photo has.
  const tall = Math.min(Math.max(down, across / aspect), Math.sqrt((image.width() * image.height()) / aspect));
  const w = Math.max(1, Math.round(tall * aspect));
  const h = Math.max(1, Math.round(tall));
  const matrix = Skia.Matrix(perspective(corners, whole(w, h)));
  // Catmull-Rom: on pages enlarged from tilted photos it came 21% nearer the true print than bilinear (#101).
  const shader = image.makeShaderCubic(TileMode.Clamp, TileMode.Clamp, 0, 1 / 2, matrix);
  const paint = Skia.Paint();
  paint.setShader(shader);
  const surface = Skia.Surface.Make(w, h)!;
  surface.getCanvas().drawPaint(paint);
  const page = surface.makeImageSnapshot();
  for (const o of [matrix, shader, paint, surface]) o.dispose();
  return page;
}

async function writeJpeg(dest: string, bytes: Uint8Array | null) {
  // Native Skia returns null when encoding fails, whatever the type says.
  if (!bytes?.length) throw new Error('could not encode page');
  await new File(dest).write(bytes);
}
