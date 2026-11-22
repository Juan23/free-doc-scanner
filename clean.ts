import {
  AlphaType, ColorType, FilterMode, MipmapMode, Skia, TileMode, type SkImage, type SkMatrix, type SkSurface,
} from '@shopify/react-native-skia';
import { File, Paths } from 'expo-file-system';

import type { Disposable } from './liveImages';
import { copyPage, heldPhoto, keepOriginal, originalOf, readPage, replacePage } from './scans';

/**
 * How to treat a page: leave it as photographed, clean it, or clean it to grey. `strength`, from 0
 * to 2, sets how much clean-up keeps: 0 Light, 1 Normal, 2 Strong, and in between, between them.
 */
export type Filter = { kind: 'original' | 'clean' | 'gray'; strength: number };

// How much clean-up keeps, per strength. `whitePoint`: a pixel at this share of the paper's
// brightness turns white. `inkThreshold`: a mark at this share or darker counts as writing. Light
// keeps faint pencil; Strong treats more faint marks as dirt. `paleLine`: how dark, as Light shows
// it, a 1 or 2 px line must be to stay as print (a table line); Strong keeps grey 130 and darker.
const KEEP = [
  { whitePoint: 0.95, inkThreshold: 0.97, paleLine: 0.15 },
  { whitePoint: 0.85, inkThreshold: 0.9, paleLine: 0.15 },
  { whitePoint: 0.8, inkThreshold: 0.87, paleLine: 0.55 },
];

// A strength's KEEP numbers, each straight between the two steps around it; exactly a row at 0, 1 and 2.
function keepAt(strength: number): (typeof KEEP)[number] {
  const i = Math.min(1, Math.floor(strength));
  const t = strength - i;
  const [a, b] = [KEEP[i], KEEP[i + 1]];
  const mix = (k: keyof typeof a) => (1 - t) * a[k] + t * b[k];
  return { whitePoint: mix('whitePoint'), inkThreshold: mix('inkThreshold'), paleLine: mix('paleLine') };
}

const NORMAL: Filter = { kind: 'clean', strength: 1 };
const ORIGINAL: Filter = { kind: 'original', strength: 1 };

// The filter for new scans, as JSON. Older versions turned clean-up off with a separate file
// instead: defaultFilter reads it once, remembers Original and deletes it.
const filterFile = () => new File(Paths.document, 'filter');
const offFile = () => new File(Paths.document, 'clean-up-off');

function parseFilter(text: string): Filter | null {
  try {
    const f = JSON.parse(text);
    const kinds = ['original', 'clean', 'gray'];
    if (kinds.includes(f.kind) && typeof f.strength === 'number' && f.strength >= 0 && f.strength <= 2) return f;
  } catch {}
  return null;
}

/** The filter for new scans: Clean, Normal unless another was chosen. */
export function defaultFilter(): Filter {
  try {
    const f = filterFile();
    if (f.exists) {
      const filter = parseFilter(f.textSync());
      if (filter) return filter;
    }
  } catch {}
  try {
    if (offFile().exists) {
      setDefaultFilter(ORIGINAL);
      offFile().delete();
      return ORIGINAL;
    }
  } catch {}
  return NORMAL;
}

/** Remembers the choice across launches. Never throws: at worst the choice resets at next launch. */
export function setDefaultFilter(filter: Filter): void {
  try {
    filterFile().writeSync(JSON.stringify(filter));
  } catch {}
}

// Two guesses at the paper on the small copy. The coarse one wipes out ink up to about 12 px wide
// but blurs across shadow edges, leaving a grey band along them. The fine one keeps edges sharp
// but also keeps anything over about 11 px wide, ink included. The fine one wins where it looks
// like shadow: 15-65% darker than the coarse one, in nearly the same colour. Darker is ink;
// lighter is usually blurred text, and the coarse guess turns light shadow white anyway.
const paperEffect = Skia.RuntimeEffect.Make(`
uniform shader coarse;
uniform shader fine;
half4 main(float2 xy) {
  half3 c = coarse.eval(xy).rgb;
  half3 f = fine.eval(xy).rgb;
  half3 s = f / max(c, half3(0.05));
  half lo = min(min(s.r, s.g), s.b);
  half grey = 1 - smoothstep(0.15, 0.3, max(max(s.r, s.g), s.b) - lo);
  half shadow = smoothstep(0.35, 0.5, lo) * (1 - smoothstep(0.75, 0.85, lo)) * grey;
  return half4(mix(c, f, shadow), 1);
}`)!;

// Under each pixel of the small copy, from 8 x 8 samples of the photo: the darkest sample where both
// the lightest row and the lightest column are much lighter than it, white unless both are. Letters
// leave both gaps; a straight crease or blank paper leaves at most one.
const lettersEffect = Skia.RuntimeEffect.Make(`
uniform shader page;
uniform float2 cell;
half4 main(float2 xy) {
  half colMin[8];
  for (int j = 0; j < 8; j++) colMin[j] = 1;
  half4 darkest = half4(1);
  half lightest = 0;
  half lightestRow = 0;
  for (int i = 0; i < 8; i++) {
    half rowMin = 1;
    for (int j = 0; j < 8; j++) {
      half4 c = page.eval((floor(xy) + (float2(j, i) + 0.5) / 8) * cell);
      darkest = min(darkest, c);
      half l = min(min(c.r, c.g), c.b);
      lightest = max(lightest, l);
      rowMin = min(rowMin, l);
      colMin[j] = min(colMin[j], l);
    }
    lightestRow = max(lightestRow, rowMin);
  }
  half lightestCol = 0;
  for (int j = 0; j < 8; j++) lightestCol = max(lightestCol, colMin[j]);
  half low = min(min(darkest.r, darkest.g), darkest.b);
  half gaps = (min(lightestRow, lightestCol) - low) / max(lightest, 0.05);
  return half4(mix(half3(1), darkest.rgb, smoothstep(0.08, 0.12, gaps)), 1);
}`)!;

// How much darker than the coarse paper each pixel of the small copy is. Blurred, it shows where
// the writing is. Kept linear so thin, faint strokes still count once shrunk. Not the picked
// paper: that can follow blurred text, which would then pass for dirt.
const inkEffect = Skia.RuntimeEffect.Make(`
uniform shader page;
uniform shader paper;
uniform float inkThreshold;
half4 main(float2 xy) {
  half3 c = page.eval(xy).rgb / max(paper.eval(xy).rgb, half3(0.05));
  return half4(0, 0, 0, saturate(half(inkThreshold) - min(min(c.r, c.g), c.b)));
}`)!;

// The same for the letters' darkest pixels, at full ink 0.05 past inkThreshold: thin pale print hardly darkens the small copy.
const letterInkEffect = Skia.RuntimeEffect.Make(`
uniform shader letters;
uniform shader paper;
uniform float inkThreshold;
half4 main(float2 xy) {
  half3 c = letters.eval(xy).rgb / max(paper.eval(xy).rgb, half3(0.05));
  return half4(0, 0, 0, saturate((half(inkThreshold) - min(min(c.r, c.g), c.b)) / 0.05));
}`)!;

// Rec. 709 weights of a colour's luma.
const LUMA = [0.2126, 0.7152, 0.0722] as const;

// Divides each pixel by the paper's brightness around it, so shadows and tint turn white, and
// stretches the levels so grain goes white and ink dark. Faint marks far from any writing (dirt,
// most creases) go white too; dark marks always stay, so full stops and lines survive.
// Whatever shows past the paper's edges goes white too, and so does a dark table or carpet that
// fills much of the frame (`markDarkBackground`), at every strength.
// A hairline between two pixels is faint in each, and fainter still on the small copy. So a pixel
// also stays on a thin ridge: summed across the line it holds at least `least` and at most a
// hairline's ink, the pixels beside hold little, and the ink runs on 4 px both ways (summed across,
// for a tilted line). A narrow ridge (its lightest of the three pixels across under a third of the
// darkest, such as a 1.2 px line) gets the low `least` and 0.4 more ink at most. Specks, creases 3 px
// or wider (all three pixels dark) and shadow edges fail. A 2 px crease at alpha A has the pixels of
// an (A * 2.3) px line: it stays at Normal from 0.3 alpha, and at Strong from 0.4.
// A pale printed line (a table's grey rules) holds too little ink for that, so on a page at least
// PALE_LINE_WIDTH wide a pixel also stays, as dark as Light shows it, when it is at least
// `paleFloor` dark at Light, no pixel two away and not both beside it are much dark, and the line
// runs on 4 and 8 px both ways. A crease 3 px or wider fails; at Strong the floor sits between a
// 0.35 alpha crease and grey 130.
const cleanEffect = Skia.RuntimeEffect.Make(`
uniform shader page;
uniform shader paper;
uniform shader ink;
uniform shader beyond;
uniform shader letterInk;
uniform float whitePoint;
uniform float grey;
uniform float paleFloor;
half3 levelsAt(float2 xy, half3 p, half white) {
  return saturate((page.eval(xy).rgb / p - (white - 0.6)) / 0.6);
}
half3 levels(float2 xy, half3 p) {
  return levelsAt(xy, p, half(whitePoint));
}
half darkOf(half3 c) {
  return 1 - min(min(c.r, c.g), c.b);
}
half darkAt(float2 xy, half3 p) {
  return darkOf(levels(xy, p));
}
half paleAt(float2 xy, half3 p) {
  return darkOf(levelsAt(xy, p, 0.95));
}
half paleAcross(float2 xy, half3 p, float2 across) {
  return max(paleAt(xy - across, p), max(paleAt(xy, p), paleAt(xy + across, p)));
}
half paleLine(float2 xy, half3 p, float2 across, half b) {
  float2 along = across.yx;
  half side = max(min(paleAt(xy - across, p), paleAt(xy + across, p)), max(paleAt(xy - 2 * across, p), paleAt(xy + 2 * across, p)));
  half runs = min(min(paleAcross(xy - 4 * along, p, across), paleAcross(xy + 4 * along, p, across)),
                  min(paleAcross(xy - 8 * along, p, across), paleAcross(xy + 8 * along, p, across)));
  half f = half(paleFloor);
  return smoothstep(f, f + 0.05, b) * smoothstep(f, f + 0.05, runs) * (1 - smoothstep(0.25, 0.4, side / max(b, 0.01)));
}
half sumAcross(float2 xy, half3 p, float2 across) {
  return darkAt(xy - across, p) + darkAt(xy, p) + darkAt(xy + across, p);
}
half ridge(float2 xy, half3 p, float2 across) {
  float2 along = across.yx;
  half a = darkAt(xy - across, p);
  half b = darkAt(xy, p);
  half c = darkAt(xy + across, p);
  half here = a + b + c;
  half beside = darkAt(xy - 2 * across, p) + darkAt(xy + 2 * across, p);
  half runs = min(sumAcross(xy - 4 * along, p, across), sumAcross(xy + 4 * along, p, across));
  half hairline = 1.34 - (1 - half(whitePoint)) / 0.3;
  half least = 0.38 + 2 * max(0.0, 0.85 - half(whitePoint));
  half narrow = 1 - smoothstep(0.25, 0.4, min(a, min(b, c)) / max(max(a, max(b, c)), 0.01));
  half lower = mix(0.4, least, narrow);
  half width = mix(0.2, 0.08, narrow);
  half limit = hairline + 0.4 * narrow;
  return smoothstep(lower, lower + width, here - 1.5 * beside) * smoothstep(lower, lower + width, runs) * (1 - smoothstep(limit + 0.01, limit + 0.11, here));
}
half4 main(float2 xy) {
  half3 p = max(paper.eval(xy).rgb, half3(0.05));
  half3 c = levels(xy, p);
  half dark = darkOf(c);
  half keep = max(smoothstep(0.45, 0.65, dark), smoothstep(0.02, 0.05, ink.eval(xy).a));
  half text = smoothstep(0.01, 0.04, letterInk.eval(xy).a);
  keep = max(keep, text);
  if (keep < 1 && dark > 0.1) keep = max(keep, max(ridge(xy, p, float2(1, 0)), ridge(xy, p, float2(0, 1))));
  half b = paleAt(xy, p);
  if (keep < 1 && b > half(paleFloor)) {
    half pale = max(paleLine(xy, p, float2(1, 0), b), paleLine(xy, p, float2(0, 1), b));
    c = mix(c, levelsAt(xy, p, 0.95), pale);
    keep = max(keep, pale);
  }
  half3 cleaned = mix(half3(1), c, keep * (1 - beyond.eval(xy).a));
  half greyed = dot(cleaned, half3(${LUMA}));
  return half4(mix(cleaned, half3(greyed), half(grey)), 1);
}`)!;

// Paper and text are found on a copy this wide.
const SMALL_WIDTH = 500;

// Pale lines are kept only on pages at least this wide, as a phone photo always is: there a crease
// spreads over 3 px or more, so a 1 or 2 px pale line is print. On a smaller page a crease can be 1 px.
const PALE_LINE_WIDTH = 1000;

// Past a bent or curled edge, table shows along the borders: never deeper into the page than this
// share of its short side. Anything deeper (a picture printed off the edge, a whole table) stays.
const EDGE_DEPTH = 0.1;

// Seen from the border, a paper edge's depth changes by at most this many pixels from one row or
// column to the next. Print has walls: letters, bands and pictures end abruptly, and so do the
// gaps a logo or white text leaves in them.
const MAX_STEP = 3;

// Print can also run straight along almost a whole side (a frame line, a colour band): this deep or
// more, within a pixel, along this share of the side, ending in a colour or near black. A bent edge
// never runs that straight; shadow along a curled edge can, but in the paper's colour.
const STRAIGHT_DEPTH = 6;
const STRAIGHT_SHARE = 0.75;

// The four neighbours of a pixel, as steps along x and y.
const STEP_X = [1, -1, 0, 0];
const STEP_Y = [0, 0, 1, -1];

/**
 * What shows past the paper's edges on the small copy (RGBA `page`, and `fine` with ink wiped out),
 * as 255s: what touches the border, is darker than the paper in the middle of the page or another
 * colour, stays shallow, and whose inner edge bends smoothly like a paper edge. Writing on what may
 * be paper in shadow stays, with a margin.
 */
function pastEdges(page: Uint8Array, fine: Uint8Array, w: number, h: number): Uint8Array {
  const n = w * h;
  const hist = [0, 1, 2].map(() => new Array(256).fill(0));
  for (let y = h >> 2; y < (3 * h) >> 2; y++) {
    for (let x = w >> 2; x < (3 * w) >> 2; x++) for (let c = 0; c < 3; c++) hist[c][fine[(y * w + x) * 4 + c]]++;
  }
  const half = hist[0].reduce((a, b) => a + b) / 2;
  const paper = hist.map((counts) => {
    let v = 0;
    for (let below = counts[0]; below < half; below += counts[v]) v++;
    return v;
  });
  const paperSum = paper[0] + paper[1] + paper[2] + 1;
  const [paperR, paperG, paperB] = paper.map((v) => v / paperSum);
  // 2: near black, or darker in another colour, so not paper. 1: darker, so maybe paper in shadow,
  // writing and all.
  const other = new Uint8Array(n);
  const ink = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = fine[i * 4];
    const g = fine[i * 4 + 1];
    const b = fine[i * 4 + 2];
    const sum = r + g + b + 1;
    const hue = Math.max(Math.abs(r / sum - paperR), Math.abs(g / sum - paperG), Math.abs(b / sum - paperB));
    other[i] = sum < 0.4 * paperSum || (hue > 0.06 && sum < 0.9 * paperSum) ? 2 : sum < 0.6 * paperSum ? 1 : 0;
    ink[i] = page[i * 4] + page[i * 4 + 1] + page[i * 4 + 2] < 0.7 * sum ? 1 : 0;
  }
  const nearInk = (p: number) => {
    const x = p % w;
    const y = (p - x) / w;
    for (let v = Math.max(0, y - 2); v <= Math.min(h - 1, y + 2); v++) {
      for (let u = Math.max(0, x - 2); u <= Math.min(w - 1, x + 2); u++) if (ink[v * w + u]) return true;
    }
    return false;
  };

  const deepest = EDGE_DEPTH * Math.min(w, h);
  const out = new Uint8Array(n);
  // The region each pixel joined, by its first pixel; -1 for none yet.
  const owner = new Int32Array(n).fill(-1);
  // Each border as its length and the pixel at `s` along it, `k` deep into the page. Its first and
  // last pixels are corners, so `at(0, k)` and `at(len - 1, k)` run down the borders beside it.
  const borders: [number, (s: number, k: number) => number][] = [
    [w, (s, k) => k * w + s],
    [w, (s, k) => (h - 1 - k) * w + s],
    [h, (s, k) => s * w + k],
    [h, (s, k) => s * w + w - 1 - k],
  ];
  const depths = new Int32Array(Math.max(w, h) + 2);
  const cut = new Uint8Array(Math.max(w, h) + 2);

  // Whether region `id` looks printed, from how deep it reaches straight in from each pixel of each
  // border: print has walls or runs straight along most of a side, a paper edge bends smoothly.
  // Past the diagonal from a corner, a region that wraps around it is the other border's: its depth
  // there is cut short, and steps beside a cut depth don't count.
  const printed = (id: number): boolean => {
    for (const [len, at] of borders) {
      for (let s = 0; s < len; s++) {
        const room = Math.min(s, len - 1 - s);
        const corner = s < len / 2 ? 0 : len - 1;
        let k = 0;
        cut[s + 1] = 0;
        while (k <= deepest && owner[at(s, k)] === id) {
          if (k > room && owner[at(corner, k)] === id) {
            cut[s + 1] = 1;
            break;
          }
          k++;
        }
        depths[s + 1] = k;
      }
      // Past the corners.
      depths[0] = depths[len + 1] = 0;
      cut[0] = cut[len + 1] = 1;
      let straight = 0;
      for (let t = 1; t <= len + 1; t++) {
        if (!cut[t - 1] && !cut[t] && Math.abs(depths[t] - depths[t - 1]) > MAX_STEP) return true;
        const d = depths[t];
        if (t > len || cut[t] || d < STRAIGHT_DEPTH || other[at(t - 1, d - 1)] < 2) straight = 0;
        else if (straight && Math.abs(d - depths[t - straight]) <= 1) straight++;
        else straight = 1;
        if (straight >= STRAIGHT_SHARE * len) return true;
      }
    }
    return false;
  };

  for (let start = 0; start < n; start++) {
    const sx = start % w;
    const sy = (start - sx) / w;
    if ((sx > 0 && sx < w - 1 && sy > 0 && sy < h - 1) || !other[start] || owner[start] >= 0) continue;
    owner[start] = start;
    const region = [start];
    let depth = 0;
    for (let i = 0; i < region.length; i++) {
      const p = region[i];
      const x = p % w;
      const y = (p - x) / w;
      depth = Math.max(depth, Math.min(x, y, w - 1 - x, h - 1 - y));
      for (let d = 0; d < 4; d++) {
        const u = x + STEP_X[d];
        const v = y + STEP_Y[d];
        if (u < 0 || v < 0 || u >= w || v >= h) continue;
        const q = v * w + u;
        if (other[q] && owner[q] < 0) {
          owner[q] = start;
          region.push(q);
        }
      }
    }
    if (depth > deepest || printed(start)) continue;
    for (const p of region) if (other[p] === 2 || !nearInk(p)) out[p] = 255;
  }
  return out;
}

// A page in a wide frame has a table or carpet round it; there the paper estimate is the background
// itself, so dividing by it leaves speckle. That background joins at least BACKGROUND_BORDER of the
// border, is darker than BACKGROUND_SHARE of the frame's paper (its PAPER_PERCENTILE of luma) and
// covers over BACKGROUND_AREA of the frame. A dark picture inside the page does not join enough of
// the border (even if a cropped edge grazes it), and one bleeding off an edge covers less.
const BACKGROUND_SHARE = 0.5;
const BACKGROUND_AREA = 0.25;
const BACKGROUND_BORDER = 0.25;
const PAPER_PERCENTILE = 0.9;

// A page's soft edge leaves a ring of pixels this wide beside it: darker than the paper, lighter than the cutoff.
const BACKGROUND_GROW = 3;

/** Sets `out` to 255 on the dark background of `fine`, the small copy with ink wiped out (RGBA), when it covers the frame as above. */
export function markDarkBackground(out: Uint8Array, fine: Uint8Array, w: number, h: number): void {
  const n = w * h;
  const lumas = new Uint8Array(n);
  const hist = new Int32Array(256);
  for (let i = 0; i < n; i++) {
    lumas[i] = Math.round(LUMA[0] * fine[i * 4] + LUMA[1] * fine[i * 4 + 1] + LUMA[2] * fine[i * 4 + 2]);
    hist[lumas[i]]++;
  }
  let paper = 0;
  for (let below = hist[0]; below < PAPER_PERCENTILE * n; ) below += hist[++paper];
  const cutoff = BACKGROUND_SHARE * paper;
  const region: number[] = [];
  const seen = new Uint8Array(n);
  const join = (p: number) => {
    if (!seen[p]) {
      seen[p] = 1;
      region.push(p);
    }
  };
  const around = (p: number, fn: (q: number) => void) => {
    const x = p % w;
    const y = (p - x) / w;
    for (let d = 0; d < 4; d++) {
      const u = x + STEP_X[d];
      const v = y + STEP_Y[d];
      if (u >= 0 && v >= 0 && u < w && v < h) fn(v * w + u);
    }
  };
  for (let p = 0; p < n; p++) {
    const x = p % w;
    const y = (p - x) / w;
    if ((x === 0 || y === 0 || x === w - 1 || y === h - 1) && lumas[p] < cutoff) join(p);
  }
  const perimeter = w <= 1 || h <= 1 ? n : 2 * (w + h - 2);
  if (region.length < BACKGROUND_BORDER * perimeter) return;
  for (let i = 0; i < region.length; i++) around(region[i], (q) => lumas[q] < cutoff && join(q));
  if (region.length <= BACKGROUND_AREA * n) return;
  for (let layer = 0, from = 0; layer < BACKGROUND_GROW; layer++) {
    const to = region.length;
    for (let i = from; i < to; i++) around(region[i], join);
    from = to;
  }
  for (const p of region) out[p] = 255;
}

function withDisposables<T>(fn: (own: <D extends Disposable>(o: D) => D) => T): T {
  const held: Disposable[] = [];
  try {
    return fn((o) => (held.push(o), o));
  } finally {
    held.forEach((o) => o.dispose());
  }
}
type MakeSurface = (width: number, height: number) => SkSurface;
const cpuSurface: MakeSurface = (w, h) => Skia.Surface.Make(w, h)!;
// Without a GPU (the tests' CanvasKit) this is a CPU surface.
const gpuSurface: MakeSurface = (w, h) => Skia.Surface.MakeOffscreen(w, h) ?? cpuSurface(w, h);
const clamp = (img: SkImage, mode: FilterMode, matrix?: SkMatrix, mipmap = MipmapMode.None) =>
  img.makeShaderOptions(TileMode.Clamp, TileMode.Clamp, mode, mipmap, matrix);

/**
 * A new `outW` x `outH` copy of `image`, mipmapped so thin strokes are averaged in, not skipped.
 * A shader, because drawImageRectOptions skipped 1 to 3 px strokes in 1600 to 4032 px photos at 500 px.
 * The caller disposes the result.
 */
export function shrunkCopy(
  image: SkImage,
  outW: number,
  outH: number,
  makeSurface: MakeSurface = cpuSurface,
): SkImage {
  const surface = makeSurface(outW, outH);
  const scale = Skia.Matrix().scale(outW / image.width(), outH / image.height());
  const shader = clamp(image, FilterMode.Linear, scale, MipmapMode.Linear);
  const paint = Skia.Paint();
  paint.setShader(shader);
  surface.getCanvas().drawPaint(paint);
  const copy = surface.makeImageSnapshot();
  scale.dispose();
  shader.dispose();
  paint.dispose();
  surface.dispose();
  return copy;
}

/**
 * `image` is the page's full untouched photo, not a thumbnail: the paper and ink are measured on a
 * small copy of it. A new image `width` pixels wide, as tall as the photo's shape makes it. Writes
 * no file. The caller disposes the result; everything else made here is freed. The paper, ink and
 * past-edge analysis runs on the same small copy at any width, so a preview and the page stored from
 * the photo agree. A width under 500 px is cleaned at 500 px (or the photo's width, if narrower), then
 * shrunk: the final pass per output pixel would break text into fragments. A hairline the full-size
 * pass keeps can still vanish from such a preview (0.8 px grid on a 3024 px photo).
 */
export function filterImage(image: SkImage, filter: Filter, width: number = image.width()): SkImage {
  return filterWith(image, filter, width);
}

/** `filterImage` with a `shared` analysis of `image` in place of a new one; the caller disposes it. */
function filterWith(image: SkImage, filter: Filter, width: number, shared?: Analysis): SkImage {
  const w = image.width();
  const h = image.height();
  const outW = Math.max(1, Math.round(width));
  const outH = Math.max(1, Math.round((outW * h) / w));

  if (filter.kind === 'original') {
    return shrunkCopy(image, outW, outH);
  }

  // Strokes averaged into the final pass's few pixels fall under its darkness gates and the blurred ink mask.
  const middle = Math.min(w, SMALL_WIDTH);
  if (outW < middle) {
    const cleaned = filterWith(image, filter, middle, shared);
    try {
      return shrunkCopy(cleaned, outW, outH);
    } finally {
      cleaned.dispose();
    }
  }

  const analysis = shared ?? analysePage(image);
  try {
    return filterAnalysed(analysis, filter, outW, outH, cpuSurface);
  } finally {
    if (!shared) analysis.dispose();
  }
}

// Its `dispose` frees what it made; the caller owns `image`.
type Analysis = { image: SkImage; sw: number; sh: number; smallPage: SkImage; letters: SkImage; coarse: SkImage; paper: SkImage; beyond: SkImage; dispose: () => void };

function analysePage(image: SkImage): Analysis {
  const w = image.width();
  const h = image.height();
  const scale = Math.min(1, SMALL_WIDTH / w);
  const sw = Math.ceil(w * scale);
  const sh = Math.ceil(h * scale);
  const results: Disposable[] = [];
  const result = <T extends Disposable>(o: T) => (results.push(o), o);
  try {
    return withDisposables((own) => {
      const surface = own(cpuSurface(sw, sh));
      const canvas = surface.getCanvas();
      const smallPage = result(shrunkCopy(image, sw, sh));
      const photoShader = own(clamp(image, FilterMode.Nearest));
      const findLetters = own(Skia.Paint());
      findLetters.setShader(own(lettersEffect.makeShaderWithChildren([w / sw, h / sh], [photoShader])));
      canvas.drawRect(Skia.XYWHRect(0, 0, sw, sh), findLetters);
      const letters = result(surface.makeImageSnapshot());

      const wipeInk = own(Skia.Paint());
      const inkDilate = own(Skia.ImageFilter.MakeDilate(6, 6, null));
      wipeInk.setImageFilter(own(Skia.ImageFilter.MakeBlur(8, 8, TileMode.Clamp, inkDilate)));
      canvas.drawImage(smallPage, 0, 0, wipeInk);
      const coarse = result(surface.makeImageSnapshot());
      const wipeText = own(Skia.Paint());
      const textDilate = own(Skia.ImageFilter.MakeDilate(5, 5, null));
      wipeText.setImageFilter(own(Skia.ImageFilter.MakeErode(5, 5, textDilate)));
      canvas.drawImage(smallPage, 0, 0, wipeText);
      const fine = own(surface.makeImageSnapshot());
      const coarseShader = own(clamp(coarse, FilterMode.Nearest));
      const fineShader = own(clamp(fine, FilterMode.Nearest));
      const pickShader = own(paperEffect.makeShaderWithChildren([], [coarseShader, fineShader]));
      const pickPaper = own(Skia.Paint());
      pickPaper.setShader(pickShader);
      canvas.drawRect(Skia.XYWHRect(0, 0, sw, sh), pickPaper);
      const paper = result(surface.makeImageSnapshot());

      const rgba = { width: sw, height: sh, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul };
      const pagePixels = smallPage.readPixels(0, 0, rgba) as Uint8Array | null;
      const finePixels = fine.readPixels(0, 0, rgba) as Uint8Array | null;
      // Unreadable copies just leave the edges as they are.
      const pastEdgesMask = pagePixels && finePixels ? pastEdges(pagePixels, finePixels, sw, sh) : new Uint8Array(sw * sh);
      if (finePixels) markDarkBackground(pastEdgesMask, finePixels, sw, sh);
      const beyondData = own(Skia.Data.fromBytes(pastEdgesMask));
      const beyondMask = own(Skia.Image.MakeImage({ width: sw, height: sh, colorType: ColorType.Alpha_8, alphaType: AlphaType.Premul }, beyondData, sw)!);
      // Grown a pixel to take in the blurred edge of the paper, and softened.
      const feather = own(Skia.Paint());
      const featherDilate = own(Skia.ImageFilter.MakeDilate(1, 1, null));
      feather.setImageFilter(own(Skia.ImageFilter.MakeBlur(1, 1, TileMode.Clamp, featherDilate)));
      canvas.clear(Skia.Color('transparent'));
      canvas.drawImage(beyondMask, 0, 0, feather);
      const beyond = result(surface.makeImageSnapshot());
      return {
        image, sw, sh, smallPage, letters, coarse, paper, beyond,
        dispose: () => [smallPage, letters, coarse, paper, beyond].forEach((o) => o.dispose()),
      };
    });
  } catch (e) {
    results.forEach((o) => o.dispose());
    throw e;
  }
}

// The ink masks are SMALL_WIDTH wide, so they stay on the CPU even when the final pass runs on the GPU.
function filterAnalysed(
  analysis: Analysis,
  filter: Filter,
  outW: number,
  outH: number,
  makeSurface: MakeSurface,
): SkImage {
  const { image, sw, sh } = analysis;
  const w = image.width();
  const h = image.height();
  const keep = keepAt(filter.strength);
  // A page holds about 100 MB of bitmaps, so free intermediates immediately.
  return withDisposables((own) => {
    const toOut = own(Skia.Matrix().scale(outW / sw, outH / sh));
    const surface = own(cpuSurface(sw, sh));
    const smallPageShader = own(clamp(analysis.smallPage, FilterMode.Nearest));
    const coarseShader = own(clamp(analysis.coarse, FilterMode.Nearest));
    const inkShader = own(inkEffect.makeShaderWithChildren([keep.inkThreshold], [smallPageShader, coarseShader]));
    const spread = (shader: ReturnType<typeof inkEffect.makeShaderWithChildren>) => {
      const paint = own(Skia.Paint());
      paint.setShader(shader);
      paint.setImageFilter(own(Skia.ImageFilter.MakeBlur(6, 6, TileMode.Clamp, null)));
      surface.getCanvas().clear(Skia.Color('transparent'));
      surface.getCanvas().drawRect(Skia.XYWHRect(0, 0, sw, sh), paint);
      return own(surface.makeImageSnapshot());
    };
    const ink = spread(inkShader);
    const lettersShader = own(clamp(analysis.letters, FilterMode.Nearest));
    const letterInk = spread(own(letterInkEffect.makeShaderWithChildren([keep.inkThreshold], [lettersShader, coarseShader])));

    const shrinking = outW < w;
    // Only the final pass is drawn at the output size; a shrunk preview samples the photo mipmapped, as shrunkCopy does.
    const toPage = own(Skia.Matrix().scale(outW / w, outH / h));
    const pageShader = own(clamp(
      image,
      shrinking ? FilterMode.Linear : FilterMode.Nearest,
      toPage,
      shrinking ? MipmapMode.Linear : MipmapMode.None,
    ));
    const paperShader = own(clamp(analysis.paper, FilterMode.Linear, toOut));
    const textShader = own(clamp(ink, FilterMode.Linear, toOut));
    const beyondShader = own(clamp(analysis.beyond, FilterMode.Linear, toOut));
    const letterInkShader = own(clamp(letterInk, FilterMode.Linear, toOut));
    const cleanShader = own(cleanEffect.makeShaderWithChildren(
      [keep.whitePoint, filter.kind === 'gray' ? 1 : 0, outW >= PALE_LINE_WIDTH ? keep.paleLine : 1],
      [pageShader, paperShader, textShader, beyondShader, letterInkShader],
    ));
    const out = own(makeSurface(outW, outH));
    const paint = own(Skia.Paint());
    paint.setShader(cleanShader);
    out.getCanvas().drawPaint(paint);
    return out.makeImageSnapshot();
  });
}

// The filter a page was last given, as JSON beside it: p3.jpg has f3.json. Pages from before this
// have none.
const filterRecord = (uri: string) => {
  const record = uri.replace(/p(\d+)\.jpg$/, 'f$1.json');
  if (record === uri) throw new Error('not a stored page');
  return new File(record);
};

/** The filter the page at `uri` was last given, or null when none is recorded. */
export function pageFilter(uri: string): Filter | null {
  try {
    const f = filterRecord(uri);
    return f.exists ? parseFilter(f.textSync()) : null;
  } catch {
    return null;
  }
}

/** The filter every page in `uris` was last given; null when they differ, any has none, or the list is empty. */
export function sharedFilter(uris: string[]): Filter | null {
  const [first, ...rest] = uris.map(pageFilter);
  return first && rest.every((f) => f && f.kind === first.kind && f.strength === first.strength) ? first : null;
}

const PREVIEW_FILTERS: Filter[] = [ORIGINAL, NORMAL, { kind: 'gray', strength: 1 }];

/**
 * Original, Clean and Grayscale at Normal, `width` pixels wide, from the page's untouched photo
 * (the page itself when it has none). Writes no file. The caller disposes the images. Asks
 * `cancelled` after each yield and, when it says so, frees what it made and returns null.
 */
export async function filterPreviews(
  uri: string,
  width: number,
  cancelled: () => boolean = () => false,
): Promise<Record<Filter['kind'], SkImage> | null> {
  if (cancelled()) return null;
  const photo = await readPage(heldPhoto(uri));
  const previews: Partial<Record<Filter['kind'], SkImage>> = {};
  // Clean and Grayscale measure the same paper and ink, so it is done once.
  let analysis: Analysis | undefined;
  try {
    for (const filter of PREVIEW_FILTERS) {
      // Lets taps and slides through between the heavy steps.
      await new Promise((r) => setTimeout(r, 0));
      if (cancelled()) {
        for (const p of Object.values(previews)) p.dispose();
        return null;
      }
      if (filter.kind !== 'original') analysis ??= analysePage(photo);
      previews[filter.kind] = filterWith(photo, filter, width, analysis);
    }
  } catch (e) {
    for (const p of Object.values(previews)) p.dispose();
    throw e;
  } finally {
    analysis?.dispose();
    photo.dispose();
  }
  return previews as Record<Filter['kind'], SkImage>;
}

export function strengthPreview(uri: string, width: number, show: (image: SkImage | null) => void) {
  const photo = readPage(heldPhoto(uri));
  let next: Filter | null = null;
  let silent = false;
  let running: Promise<void> | null = null;
  let stopped = false;
  // Measured once: only the ink mask and the final pass depend on the strength.
  let analysis: Analysis | null = null;
  const run = async () => {
    try {
      const image = await photo;
      const outW = Math.round(Math.min(image.width(), width));
      const outH = Math.max(1, Math.round((outW * image.height()) / image.width()));
      while (next && !stopped) {
        const filter = next;
        const quiet = silent;
        next = null;
        // Lets the slider move between the heavy steps.
        await new Promise((r) => setTimeout(r, 0));
        if (stopped) break;
        analysis ??= analysePage(image);
        // Full size on the GPU: a narrower pass drops thin strokes the stored page keeps.
        // The screen draws on another thread, so it gets a CPU copy.
        const full = filterAnalysed(analysis, filter, image.width(), image.height(), gpuSurface);
        let drawn: SkImage;
        try {
          drawn = shrunkCopy(full, outW, outH, gpuSurface);
        } finally {
          full.dispose();
        }
        try {
          const copy = quiet ? null : drawn.makeNonTextureImage();
          if (copy) show(copy);
        } finally {
          drawn.dispose();
        }
      }
    } catch {
      // The page is still filtered when stored; the preview just ends.
      if (!stopped) {
        stop();
        show(null);
      }
    } finally {
      running = null;
    }
  };
  // The last strength asked to be drawn: a lift at that strength needs no further pass.
  let lastAsked: Filter | null = null;
  const queue = (filter: Filter, quiet: boolean) => {
    if (stopped) return;
    if (!quiet) lastAsked = filter;
    next = filter;
    silent = quiet;
    running ??= run();
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    photo.then(
      (image) => {
        image.dispose();
        analysis?.dispose();
      },
      () => {},
    );
  };
  return {
    preview: (filter: Filter) => queue(filter, false),
    warm: (filter: Filter) => queue(filter, true),
    stop,
    isStopped: () => stopped,
    async finish(filter: Filter) {
      // Draws unless this run already asked for the same filter.
      if (!lastAsked || lastAsked.kind !== filter.kind || lastAsked.strength !== filter.strength) queue(filter, false);
      await running;
      stop();
    },
  };
}

async function cleanPage(uri: string, filter: Filter): Promise<void> {
  // Every filter starts from the photo as it was before any cleaning, so changes never stack.
  await keepOriginal(uri);
  if (filter.kind === 'original') {
    await copyPage(originalOf(uri), uri);
    return;
  }
  const image = await readPage(originalOf(uri));
  try {
    const filtered = filterImage(image, filter);
    try {
      await replacePage(uri, filtered);
    } finally {
      filtered.dispose();
    }
  } finally {
    image.dispose();
  }
}

/**
 * Whitens the paper of stored page JPEGs (shadows, tint, grain, specks) and darkens the ink,
 * replacing each page. Original puts each page's untouched photo back. A page that can't be
 * cleaned stays as it was. Returns how many pages failed.
 */
export async function cleanPages(pageUris: string[], filter: Filter = NORMAL): Promise<number> {
  let failed = 0;
  // One page at a time: each holds full-size bitmaps in memory.
  for (const uri of pageUris) {
    try {
      // Before cleaning, so a page whose filter can't be recorded is left as it was.
      const record = filterRecord(uri);
      await cleanPage(uri, filter);
      record.writeSync(JSON.stringify(filter));
    } catch {
      failed++;
    }
  }
  return failed;
}
