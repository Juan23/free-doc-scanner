import { AlphaType, ColorType, FilterMode, ImageFormat, MipmapMode, Skia, TileMode } from '@shopify/react-native-skia';
import { File } from 'expo-file-system';

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

/** The brightness that best splits the photo into a dark and a light group (Otsu's method), or -1 when all of it is one brightness. */
function splitLevel(luma: Uint8Array): number {
  const hist = new Array(256).fill(0);
  for (const v of luma) hist[v]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let best = 0;
  let level = -1;
  let darkCount = 0;
  let darkSum = 0;
  for (let t = 0; t < 256; t++) {
    darkCount += hist[t];
    darkSum += t * hist[t];
    const lightCount = luma.length - darkCount;
    if (!darkCount || !lightCount) continue;
    const gap = darkSum / darkCount - (sum - darkSum) / lightCount;
    const score = darkCount * lightCount * gap * gap;
    if (score > best) {
      best = score;
      level = t;
    }
  }
  return level;
}

/** Indexes of the largest connected group of pixels that are set in `mask`. */
function largestRegion(mask: Uint8Array, w: number, h: number): number[] {
  const seen = new Uint8Array(mask.length);
  let largest: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const region = [start];
    seen[start] = 1;
    for (let i = 0; i < region.length; i++) {
      const p = region[i];
      const x = p % w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q >= 0 && q < mask.length && mask[q] && !seen[q]) {
          seen[q] = 1;
          region.push(q);
        }
      }
    }
    if (region.length > largest.length) largest = region;
  }
  return largest;
}

const area = (q: Quad) =>
  Math.abs(q.reduce((s, p, i) => s + p.x * q[(i + 1) % 4].y - q[(i + 1) % 4].x * p.y, 0)) / 2;

/** The page's corners in a small RGBA copy, or null when no page stands out from what is around it. */
function pageCorners(rgba: Uint8Array, w: number, h: number): Quad | null {
  const luma = new Uint8Array(w * h);
  for (let i = 0; i < luma.length; i++) {
    luma[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
  }
  // On a light table the first split can part ink from paper and table, so the "page" is nearly
  // the whole photo. Splitting the light side again then parts paper from table; if it finds no
  // smaller page, the page does fill the photo.
  let filling: Quad | null = null;
  let level = splitLevel(luma);
  for (let tries = 0; tries < 3 && level >= 0; tries++) {
    const corners = brightPage(luma, level, w, h);
    if (corners && area(corners) < 0.95 * w * h) return corners;
    filling ??= corners;
    level = splitLevel(luma.filter((v) => v > level));
  }
  return filling;
}

/** The corners of the largest region brighter than `level`, if it looks like a page. */
function brightPage(luma: Uint8Array, level: number, w: number, h: number): Quad | null {
  const region = largestRegion(luma.map((v) => (v > level ? 1 : 0)), w, h);
  // The corners are the region's furthest points along the two diagonals.
  const corners: Quad = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];
  const best = [Infinity, -Infinity, -Infinity, Infinity];
  for (const p of region) {
    const x = (p % w) + 0.5;
    const y = Math.floor(p / w) + 0.5;
    const along = [x + y, x - y, x + y, x - y];
    along.forEach((v, i) => {
      if (i === 0 || i === 3 ? v < best[i] : v > best[i]) {
        best[i] = v;
        corners[i] = { x, y };
      }
    });
  }
  // A page fills its outline, text gaps included (so each row counts edge to edge), and nothing
  // of it lies outside. A rounded blob of glare spills past its outline, and so does a page
  // turned about 45 degrees, whose corners along the diagonals are ambiguous.
  const left = new Array(h).fill(Infinity);
  const right = new Array(h).fill(-Infinity);
  for (const p of region) {
    const y = Math.floor(p / w);
    left[y] = Math.min(left[y], p % w);
    right[y] = Math.max(right[y], p % w);
  }
  const filled = left.reduce((s, l, y) => (l === Infinity ? s : s + right[y] - l + 1), 0);
  const outline = area(corners);
  if (outline < 0.1 * w * h || filled < 0.9 * outline || outline < 0.9 * filled) return null;
  return corners;
}

/** When no page stands out, the corners are the whole photo's. */
export async function findPage(uri: string): Promise<FoundPage> {
  const image = await readPage(uri);
  const width = image.width();
  const height = image.height();
  const scale = Math.min(1, SEARCH_LONG_SIDE / Math.max(width, height));
  const sw = Math.round(width * scale);
  const sh = Math.round(height * scale);
  const surface = Skia.Surface.Make(sw, sh)!;
  surface
    .getCanvas()
    .drawImageRectOptions(image, Skia.XYWHRect(0, 0, width, height), Skia.XYWHRect(0, 0, sw, sh), FilterMode.Linear, MipmapMode.Linear);
  const small = surface.makeImageSnapshot();
  const rgba = small.readPixels(0, 0, { width: sw, height: sh, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul }) as Uint8Array | null;
  for (const o of [image, surface, small]) o.dispose();
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
