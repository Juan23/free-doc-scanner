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
// The eight directions round a pixel.
const AROUND_X = [1, -1, 0, 0, 1, -1, 1, -1];
const AROUND_Y = [0, 0, 1, -1, 1, -1, -1, 1];

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

// A page in a wide frame has a table or carpet round it; there the paper estimate is the background itself, so dividing by it leaves speckle.
const BACKGROUND_SHARE = 0.5;
const BACKGROUND_AREA = 0.25;
const PAPER_PERCENTILE = 0.9;
// The page is the largest light patch and any a tenth its size clear of the border (paper a band across it cuts off), once they hold half the light.
const PAGE_PART = 0.1;
const PAGE_SHARE = 0.5;
// Print along a page's edge (a header, a banner's curled corner) reaches at most this share of the page's short side past its paper, save a picture bleeding off it.
const EDGE_PRINT = 0.25;
// The table keeps about the chromaticity and brightness of the table pixel it is compared with, where print beside it does not.
const TABLE_HUE = 0.06;
const TABLE_RATIO = 1.5;
// Colours are compared averaged over the dark pixels in (2 * GRAIN + 1)² around, so grain does not count.
const GRAIN = 2;
// So where two table surfaces meet, the seam both refuse is up to this wide along a row or column.
const SEAM = 2 * GRAIN + 3;
// Past reach the reference moves to a pixel drifted this far whose 8 pixels EVEN_STEP away match it: shading is even, print is not.
const DRIFT = 0.5;
const EVEN_STEP = 3;
// Taking print into the page's outline takes in at most this share of its size in table; a dark object beside the page takes in far more.
const OUTLINE_SLACK = 0.25;
// Print beside the page comes this close to its paper; the table can run between them along the paper's soft edge.
const PAGE_GAP = 2;

// Print bleeding off the page completes its outline: their hull takes in at most this share of the print's size in other dark.
const PICTURE_FILL = 0.1;
// Turns round the middle of the page, in equal parts.
const ANGLES = 64;
// A picture lies within the page's sides; table fills the space past two that meet (JUT_TURN apart) out to the photo's edge, over JUT_SHARE of it.
const JUT_SHARE = 0.02;
const JUT_TURN = Math.PI / 4;
// A foot curling toward the camera bends a picture this share of the page's least width past the sides.
const JUT_MARGIN_OF_WIDTH = 0.05;
// The hull's sides are runs of edges turning less than this, at least this share of the page's least width long.
const SIDE_TURN = Math.PI / 6;
const SIDE_LENGTH = 0.1;

// A page's soft edge leaves a ring of pixels this wide beside it: darker than the paper, lighter than the cutoff.
const SOFT_EDGE = 3;

// Pixel states in `markDarkBackground`: print, table, light or inside the hull (the table never spreads there), kept picture.
const NOT_TABLE = 1;
const TABLE = 2;
const BARRED = 3;
const PICTURE = 4;
// How far apart two colours are in `markDarkBackground`: within the drift, within the table's limits, or neither.
const SAME = 0;
const NEAR = 1;
const FAR = 2;
// Bits of the photo's sides that dark beside the page reaches in `markDarkBackground`.
const LEFT_SIDE = 1;
const RIGHT_SIDE = 2;
const TOP_SIDE = 4;
const BOTTOM_SIDE = 8;

/** Calls `fn` with each pixel beside `p`, above, below, left and right, in a `w` wide image of `n` pixels. */
function eachBeside(p: number, w: number, n: number, fn: (q: number) => void): void {
  const x = p % w;
  if (x > 0) fn(p - 1);
  if (x < w - 1) fn(p + 1);
  if (p >= w) fn(p - w);
  if (p < n - w) fn(p + w);
}

/** 1 where `fine` (RGBA) is darker than half of its paper, the frame's 90th percentile luma. */
function darkerThanPaper(fine: Uint8Array, n: number): Uint8Array {
  const lumas = new Uint8Array(n);
  const hist = new Int32Array(256);
  for (let i = 0; i < n; i++) {
    // `| 0` rounds: a Math.round call per pixel took 20 of the pass's 30 ms in Jest.
    lumas[i] = (LUMA[0] * fine[i * 4] + LUMA[1] * fine[i * 4 + 1] + LUMA[2] * fine[i * 4 + 2] + 0.5) | 0;
    hist[lumas[i]]++;
  }
  let paper = 0;
  for (let below = hist[0]; below < PAPER_PERCENTILE * n; ) below += hist[++paper];
  const cutoff = BACKGROUND_SHARE * paper;
  for (let i = 0; i < n; i++) lumas[i] = lumas[i] < cutoff ? 1 : 0;
  return lumas;
}

type Box = { left: number; top: number; right: number; bottom: number };

/**
 * The convex hull of the page's light patches, as 1s and as its corners, its least width and the patches' bounding box;
 * null when they hold under half the light.
 */
function pageHull(dark: Uint8Array, w: number, h: number): { inside: Uint8Array; hull: Point2[]; width: number; box: Box } | null {
  const n = w * h;
  const patch = new Int32Array(n).fill(-1);
  const patches: { size: number; onBorder: boolean; box: Box }[] = [];
  const stack: number[] = [];
  const spread = (q: number) => {
    if (!dark[q] && patch[q] < 0) {
      patch[q] = patches.length;
      stack.push(q);
    }
  };
  for (let s = 0; s < n; s++) {
    if (dark[s] || patch[s] >= 0) continue;
    const found = { size: 0, onBorder: false, box: { left: w, top: h, right: -1, bottom: -1 } };
    patch[s] = patches.length;
    stack.push(s);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w;
      const y = (p - x) / w;
      found.size++;
      if (x === 0 || x === w - 1 || y === 0 || y === h - 1) found.onBorder = true;
      if (x < found.box.left) found.box.left = x;
      if (x > found.box.right) found.box.right = x;
      if (y < found.box.top) found.box.top = y;
      if (y > found.box.bottom) found.box.bottom = y;
      eachBeside(p, w, n, spread);
    }
    patches.push(found);
  }
  const largest = patches.reduce((a, { size }) => Math.max(a, size), 0);
  const isPage = patches.map(({ size, onBorder }) => size === largest || (!onBorder && size >= PAGE_PART * largest));
  let light = 0;
  let pageSize = 0;
  const box = { left: w, top: h, right: -1, bottom: -1 };
  patches.forEach((found, i) => {
    light += found.size;
    if (!isPage[i]) return;
    pageSize += found.size;
    box.left = Math.min(box.left, found.box.left);
    box.top = Math.min(box.top, found.box.top);
    box.right = Math.max(box.right, found.box.right);
    box.bottom = Math.max(box.bottom, found.box.bottom);
  });
  if (!largest || pageSize < PAGE_SHARE * light) return null;
  const rowEnds: Point2[] = [];
  for (let y = box.top; y <= box.bottom; y++) {
    let lo = -1;
    let hi = -1;
    for (let x = box.left; x <= box.right; x++) {
      const id = patch[y * w + x];
      if (id < 0 || !isPage[id]) continue;
      if (lo < 0) lo = x;
      hi = x;
    }
    if (hi >= 0) rowEnds.push([lo, y], [hi, y]);
  }
  const hull = convexHull(rowEnds);
  return { inside: hullMask(rowEnds, hull, w, h), hull, width: leastWidth(hull), box };
}

/** On each pixel outside `inside` that `steps` or fewer steps to a side reach from it, the fewest; 0 elsewhere. */
function stepsFrom(inside: Uint8Array, steps: number, w: number, h: number): Uint16Array {
  const n = w * h;
  const away = new Uint16Array(n);
  let step = 1;
  let next: number[] = [];
  const visit = (q: number) => {
    if (!inside[q] && !away[q]) {
      away[q] = step;
      next.push(q);
    }
  };
  if (steps < 1) return away;
  for (let p = 0; p < n; p++) if (inside[p]) eachBeside(p, w, n, visit);
  for (step = 2; step <= steps && next.length; step++) {
    const front = next;
    next = [];
    for (const p of front) eachBeside(p, w, n, visit);
  }
  return away;
}

/**
 * Sets `out` to 255 on the table round the page in `fine`, the small copy with ink wiped out (RGBA). The table is dark outside the
 * page's convex hull that spreads from the border keeping its colour. It lies round the page, or past two of its sides that meet out
 * to the photo's edge. Dark joined to the paper that completes the page's outline, in one colour or many, is a picture and stays.
 * The table must show on two opposite sides of the page: a light strip beside a dark page, as when a black cover is cropped with the
 * table below it, shows it on one side only.
 */
export function markDarkBackground(out: Uint8Array, fine: Uint8Array, w: number, h: number): void {
  const n = w * h;
  const dark = darkerThanPaper(fine, n);
  let darkCount = 0;
  for (let p = 0; p < n; p++) darkCount += dark[p];
  // A well-framed page stops here, before the costly hull.
  if (darkCount <= BACKGROUND_AREA * n) return;
  const page = pageHull(dark, w, h);
  if (!page) return;
  const { inside, box } = page;
  const tableSide = (q: number) => dark[q] && !inside[q];
  const reach = Math.round(EDGE_PRINT * (page.width + 1));
  const stepsOut = stepsFrom(inside, reach, w, h);
  const near = (p: number) => stepsOut[p] > 0;
  const besidePage = (p: number) => near(p) && stepsOut[p] <= PAGE_GAP;

  const { tint, bright } = meanColours(fine, dark, w, h, GRAIN);
  const driftHue = DRIFT * TABLE_HUE;
  const driftRatio = TABLE_RATIO ** DRIFT;
  const apart = (a: number, b: number) => {
    const brighter = bright[a] > bright[b] ? bright[a] / bright[b] : bright[b] / bright[a];
    let hue = 0;
    for (let c = 0; c < 3; c++) {
      const d = tint[a * 3 + c] - tint[b * 3 + c];
      if (d > hue) hue = d;
      else if (-d > hue) hue = -d;
    }
    if (brighter > TABLE_RATIO || hue > TABLE_HUE) return FAR;
    return brighter > driftRatio || hue > driftHue ? NEAR : SAME;
  };
  // A seed on the photo's border has nothing past it to check; elsewhere a pixel too near the edge cannot show that its colour holds.
  const evenBeside = (q: number, onBorder = false) => {
    const x = q % w;
    const y = (q - x) / w;
    for (let k = 0; k < 8; k++) {
      const ax = x + EVEN_STEP * AROUND_X[k];
      const ay = y + EVEN_STEP * AROUND_Y[k];
      if (ax < 0 || ax >= w || ay < 0 || ay >= h) {
        if (onBorder) continue;
        return false;
      }
      if (!tableSide(ay * w + ax) || apart(ay * w + ax, q) !== SAME) return false;
    }
    return true;
  };

  // One surface at a time spreads from a border pixel beyond reach, each pixel compared with its reference, a pixel of the surface it came by.
  const state = new Uint8Array(n);
  for (let p = 0; p < n; p++) if (!tableSide(p)) state[p] = BARRED;
  const reference = new Int32Array(n);
  const flooded: number[] = [];
  const refused: number[] = [];
  const join = (q: number, from: number) => {
    if (state[q]) return;
    // Within reach the reference is the even pixel just beyond reach it came by, as light may shade the table nearer the page.
    const ref = near(q) && !near(from) && evenBeside(from) ? from : reference[from];
    const gap = apart(q, ref);
    if (gap === FAR) {
      refused.push(q);
      return;
    }
    state[q] = TABLE;
    reference[q] = gap === NEAR && !near(q) && evenBeside(q) ? q : ref;
    flooded.push(q);
  };
  const border: number[] = [];
  for (let x = 0; x < w; x++) border.push(x);
  for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);
  for (let p = n - w; p < n; p++) border.push(p);
  type Surface = { start: number; end: number; beside: boolean; turns: Uint8Array; corner: boolean; table: boolean };
  const surfaces: Surface[] = [];
  for (const seed of border) {
    // A border pixel at an edge of colour averages two colours, so it would lead a surface across that edge.
    if (state[seed] || near(seed) || !evenBeside(seed, true)) continue;
    const start = flooded.length;
    state[seed] = TABLE;
    reference[seed] = seed;
    flooded.push(seed);
    // Here and in the grow below, `eachBeside`'s callback per neighbour makes the whole pass a fifth slower.
    for (let i = start; i < flooded.length; i++) {
      const p = flooded[i];
      const x = p % w;
      if (x > 0) join(p - 1, p);
      if (x < w - 1) join(p + 1, p);
      if (p >= w) join(p - w, p);
      if (p < n - w) join(p + w, p);
    }
    surfaces.push({ start, end: flooded.length, beside: false, turns: new Uint8Array(ANGLES), corner: false, table: false });
  }
  // 1 + the index of the surface a pixel belongs to, or of one whose table colour it has; 0 for none.
  const owner = new Int32Array(n);
  surfaces.forEach(({ start, end }, k) => {
    for (let i = start; i < end; i++) owner[flooded[i]] = k + 1;
  });

  // The table lies round the page: where it meets the page and the photo's border leaves no half turn round the page's middle empty.
  const middleX = (box.left + box.right) / 2;
  const middleY = (box.top + box.bottom) / 2;
  const turnOf = (p: number) => {
    const x = p % w;
    return Math.floor(((Math.atan2((p - x) / w - middleY, x - middleX) / Math.PI + 1) * ANGLES) / 2) % ANGLES;
  };
  const surround = (turns: Uint8Array) => {
    let gap = 0;
    for (let i = 0, run = 0; i < 2 * ANGLES; i++) {
      run = turns[i % ANGLES] ? 0 : run + 1;
      gap = Math.max(gap, run);
    }
    return gap < ANGLES / 2;
  };
  for (let y = Math.max(0, box.top - PAGE_GAP); y <= Math.min(h - 1, box.bottom + PAGE_GAP); y++) {
    for (let p = y * w + Math.max(0, box.left - PAGE_GAP), last = y * w + Math.min(w - 1, box.right + PAGE_GAP); p <= last; p++) {
      if (!owner[p] || !besidePage(p)) continue;
      surfaces[owner[p] - 1].beside = true;
      surfaces[owner[p] - 1].turns[turnOf(p)] = 1;
    }
  }
  for (const p of border) {
    if (!owner[p]) continue;
    surfaces[owner[p] - 1].turns[turnOf(p)] = 1;
    surfaces[owner[p] - 1].corner ||= p === 0 || p === w - 1 || p === n - w || p === n - 1;
  }
  const sides = hullSides(page.hull, SIDE_LENGTH * page.width);
  // Bit masks of two sides that meet at a corner: a pixel past both lies off that corner, where a picture does not reach.
  const cornerPairs: number[] = [];
  sides.forEach((a, i) => sides.forEach((b, j) => j > i && Math.acos(a.nx * b.nx + a.ny * b.ny) >= JUT_TURN && cornerPairs.push((1 << i) | (1 << j))));
  const pastPair = (mask: number) => {
    for (const pair of cornerPairs) if ((mask & pair) === pair) return true;
    return false;
  };
  const jutMargin = JUT_MARGIN_OF_WIDTH * page.width;
  const juts = (part: number[], from = 0, to = part.length) => {
    if (!cornerPairs.length) return false;
    let past = 0;
    let far = false;
    for (let i = from; i < to; i++) {
      const p = part[i];
      const x = p % w;
      const y = (p - x) / w;
      let beyond = 0;
      for (let k = 0; k < sides.length; k++) if (sides[k].nx * x + sides[k].ny * y - sides[k].offset > jutMargin) beyond |= 1 << k;
      const pastOneAtMost = !(beyond & (beyond - 1));
      if (pastOneAtMost || !pastPair(beyond)) continue;
      past++;
      far ||= x === 0 || x === w - 1 || y === 0 || y === h - 1;
    }
    return far && past > JUT_SHARE * (to - from);
  };
  // One that does not come within 2 px of the page is judged later with the dark that joins it to the page.
  for (const s of surfaces) s.table = surround(s.turns) || (s.beside && juts(flooded, s.start, s.end));

  const prefixSums = (marked: Uint8Array) => {
    const before = new Int32Array(n + 1);
    for (let p = 0; p < n; p++) before[p + 1] = before[p] + marked[p];
    return before;
  };
  const markedInOutline = (before: Int32Array, part: number[]) => {
    const { lo, hi } = outlineWith(page.hull, part, w, h);
    let inside = 0;
    for (let y = 0; y < h; y++) {
      const left = Math.max(0, Math.ceil(lo[y]));
      const right = Math.min(w - 1, Math.floor(hi[y]));
      if (right >= left) inside += before[y * w + right + 1] - before[y * w + left];
    }
    return inside;
  };
  // Kept pictures are page; nor does the paper's soft edge count, as a part's own soft edge far off tilts the hull over it.
  const counted = new Uint8Array(n);
  let darkBefore: Int32Array | null = null;
  // Print bleeding off the page, in one colour or many, completes the page's outline: the hull of the two takes in little other dark.
  const completesPage = (part: number[]) => {
    if (!darkBefore) {
      for (let p = 0; p < n; p++) counted[p] = state[p] !== BARRED && state[p] !== PICTURE && !(stepsOut[p] && stepsOut[p] <= SOFT_EDGE) ? 1 : 0;
      darkBefore = prefixSums(counted);
    }
    let other = markedInOutline(darkBefore, part);
    for (const p of part) other -= counted[p];
    return other <= PICTURE_FILL * part.length;
  };
  const colours = new Map<Surface, { tint: number[]; bright: number }>();
  const colourOf = (s: Surface) => {
    if (!colours.has(s)) {
      // Summed over the surface, and over its part within reach.
      const sums = [0, 0, 0, 0, 0, 0, 0, 0];
      for (let i = s.start; i < s.end; i++) {
        const p = flooded[i];
        const at = near(p) ? 4 : 0;
        for (let c = 0; c < 3; c++) sums[at + c] += fine[p * 4 + c];
        sums[at + 3]++;
      }
      const [r, g, b, count] = sums[7] ? sums.slice(4) : sums;
      colours.set(s, { tint: [r, g, b].map((v) => v / (r + g + b + 1)), bright: (LUMA[0] * r + LUMA[1] * g + LUMA[2] * b) / count + 1 });
    }
    return colours.get(s)!;
  };
  const alike = (a: Surface, b: Surface) => {
    const ca = colourOf(a);
    const cb = colourOf(b);
    return Math.max(ca.bright / cb.bright, cb.bright / ca.bright) <= TABLE_RATIO && ca.tint.every((t, c) => Math.abs(t - cb.tint[c]) <= TABLE_HUE);
  };
  const pixelsOf = (s: Surface) => flooded.slice(s.start, s.end);
  const kept: Surface[] = [];
  let unsure: Surface[] = [];
  for (const s of surfaces) if (!s.table) (s.beside && completesPage(pixelsOf(s)) ? kept : unsure).push(s);

  // The owner of the first pixel past loose dark, at most a seam away from `p` in direction `k` (0 right, 1 left, 2 down, 3 up).
  const surfaceToward = (p: number, k: number) => {
    const x = p % w;
    const y = (p - x) / w;
    for (let i = 1; i <= SEAM; i++) {
      const qx = x + i * STEP_X[k];
      const qy = y + i * STEP_Y[k];
      if (qx < 0 || qx >= w || qy < 0 || qy >= h) return 0;
      const q = qy * w + qx;
      if (state[q]) return owner[q];
    }
    return 0;
  };
  // A picture in several colours fails in each alone, as its hull with the page takes in the others.
  const groupOf = surfaces.map((_, k) => k);
  const rootOf = (k: number): number => (groupOf[k] === k ? k : (groupOf[k] = rootOf(groupOf[k])));
  const tableSoFar = surfaces.filter((s) => s.table);
  // Left out: table a shadow or the page cuts, which holds a photo corner, and stubs alike stripes found table.
  const unsureBeside = unsure.filter((s) => s.beside && !s.corner && !tableSoFar.some((t) => alike(s, t)));
  const isUnsureBeside = new Uint8Array(surfaces.length + 1);
  for (const s of unsureBeside) isUnsureBeside[owner[flooded[s.start]]] = 1;
  for (const s of unsureBeside) {
    const id = owner[flooded[s.start]];
    for (let i = s.start; i < s.end; i++) {
      const p = flooded[i];
      for (let k = 0; k < 4; k += 2) {
        // Inside the surface, as most of its pixels are, there is nothing to walk past.
        const next = p + (k ? w : 1);
        if (next < n && owner[next] === id) continue;
        const other = surfaceToward(p, k);
        if (other && other !== id && isUnsureBeside[other]) groupOf[rootOf(other - 1)] = rootOf(id - 1);
      }
    }
  }
  const groups = new Map<number, Surface[]>();
  for (const s of unsureBeside) {
    const root = rootOf(owner[flooded[s.start]] - 1);
    const group = groups.get(root);
    if (group) group.push(s);
    else groups.set(root, [s]);
  }
  for (const group of groups.values()) {
    if (group.length < 2 || group.some((a, i) => group.some((b, j) => j > i && alike(a, b)))) continue;
    const turns = new Uint8Array(ANGLES);
    for (const s of group) s.turns.forEach((v, i) => (turns[i] |= v));
    if (surround(turns) || !completesPage(group.flatMap(pixelsOf))) continue;
    kept.push(...group);
    unsure = unsure.filter((s) => !group.includes(s));
  }

  // A page across the photo cuts table into alike parts that lie round it together, never one alone.
  const tableParts = surfaces.filter((s) => (s.corner || s.table) && !(s.beside && surround(s.turns)));
  // Colours of table parts found here: dark in them that starts no surface is table too.
  const pairColours: number[] = [];
  const seedOf = (id: number) => flooded[surfaces[id - 1].start];
  // Repeated until none is added, so stubs above a page as wide as the photo pass with those below.
  for (let added = true; added; ) {
    added = false;
    for (const a of [...kept, ...unsure]) {
      if (a.table || !a.beside) continue;
      const like = tableParts.filter((b) => b !== a && alike(a, b));
      const turns = a.turns.slice();
      for (const b of like) b.turns.forEach((v, i) => (turns[i] |= v));
      if (!surround(turns)) continue;
      for (const s of [a, ...like]) s.table = true;
      tableParts.push(a);
      const id = surfaces.indexOf(a) + 1;
      if (pairColours.every((k) => apart(seedOf(k), seedOf(id)) === FAR)) pairColours.push(id);
      added = true;
    }
  }
  unsure = unsure.filter((s) => !s.table);

  // Averaging mixes two table surfaces where they meet, as at a shadow's edge; both refuse that seam, so it is table too.
  const tableSurfaceToward = (p: number, k: number) => {
    const id = surfaceToward(p, k);
    return id && surfaces[id - 1].table ? id : 0;
  };
  const between = (p: number, k: number) => {
    const a = tableSurfaceToward(p, k);
    const b = a && tableSurfaceToward(p, k + 1);
    return b && b !== a;
  };
  const seams: number[] = [];
  if (surfaces.filter((s) => s.table).length > 1) for (let p = 0; p < n; p++) if (!state[p] && (between(p, 0) || between(p, 2))) seams.push(p);

  // Those that fail alone may be colours of one picture: they are judged with the dark between them, kept pictures as page.
  for (const s of unsure) {
    for (let i = s.start; i < s.end; i++) state[flooded[i]] = 0;
    refused.push(flooded[s.start]);
  }
  for (const s of kept) if (!s.table) for (let i = s.start; i < s.end; i++) state[flooded[i]] = PICTURE;
  darkBefore = null;
  const region = surfaces.every((s) => s.table) ? flooded : flooded.filter((p) => state[p] === TABLE);

  // Print past the page's paper stays within reach of it, or reaches farther from right beside it and keeps the page's outline convex.
  const makeTable = (p: number) => {
    state[p] = TABLE;
    region.push(p);
  };
  seams.forEach(makeTable);
  const beside: number[][] = [];
  // Dark that starts no surface in pieces that stay or fail is judged by colour at the end.
  const loose = new Uint8Array(n);
  for (let r = 0; r < refused.length; r++) {
    const first = refused[r];
    if (state[first]) continue;
    state[first] = NOT_TABLE;
    const part = [first];
    let nextToPage = false;
    let pastReach = false;
    let open = false;
    const met = new Set<number>();
    const turns = new Uint8Array(ANGLES);
    const add = (q: number) => {
      // A kept picture is page too.
      nextToPage ||= state[q] === PICTURE;
      open ||= state[q] === TABLE;
      if (state[q]) return;
      state[q] = NOT_TABLE;
      part.push(q);
    };
    for (let i = 0, last = 0; i < part.length; i++) {
      const p = part[i];
      const x = p % w;
      const byPage = besidePage(p);
      nextToPage ||= byPage;
      pastReach ||= !near(p);
      if (owner[p] && owner[p] !== last) met.add((last = owner[p]));
      const onBorder = x === 0 || x === w - 1 || p < w || p >= n - w;
      open ||= onBorder;
      if (byPage || onBorder) turns[turnOf(p)] = 1;
      if (x > 0) add(p - 1);
      if (x < w - 1) add(p + 1);
      if (p >= w) add(p - w);
      if (p < n - w) add(p + w);
    }
    // Dark that the page and its pictures shut in, away from the table and the photo's edge, is page too.
    if (nextToPage && !open) continue;
    if (!pastReach) {
      // Print within reach touches the page's paper; a dark speck on the table near the page does not.
      if (!nextToPage) part.forEach(makeTable);
      continue;
    }
    if (!met.size) {
      if (nextToPage) beside.push(part);
      else part.forEach(makeTable);
      continue;
    }
    if (!nextToPage) {
      part.forEach(makeTable);
      continue;
    }
    if (!surround(turns) && !juts(part) && completesPage(part)) {
      // Stripes a floor across the photo's corners cuts off start no surface, so colour judges them.
      for (const p of part) if (!owner[p]) loose[p] = 1;
      continue;
    }
    // Its surfaces are table, so are the seams between them, and the rest is judged anew: stripes' seams would tie a picture to the table.
    for (const p of part) state[p] = 0;
    for (const id of met) {
      surfaces[id - 1].table = true;
      pixelsOf(surfaces[id - 1]).forEach(makeTable);
    }
    part.filter((p) => !state[p] && (between(p, 0) || between(p, 2))).forEach(makeTable);
    for (const p of part) {
      if (state[p]) continue;
      loose[p] = 1;
      refused.push(p);
    }
  }
  // A pattern's colour starts two surfaces or more, and an object beside the page only one.
  const tableColours: { id: number; surfaces: number }[] = [];
  for (const foundTable of [true, false]) {
    surfaces.forEach((s, k) => {
      // Kept pictures and dark away from the page are not table, so they add no surface to a colour.
      if (s.table !== foundTable || (!foundTable && state[flooded[s.start]] !== NOT_TABLE)) return;
      const known = tableColours.find((c) => apart(seedOf(c.id), seedOf(k + 1)) !== FAR);
      if (known) known.surfaces++;
      else if (foundTable) tableColours.push({ id: k + 1, surfaces: 1 });
    });
  }
  const tableColour = (p: number) =>
    pairColours.find((k) => apart(p, seedOf(k)) !== FAR) ?? tableColours.find((c) => c.surfaces > 1 && apart(p, seedOf(c.id)) !== FAR)?.id;
  if (beside.length) {
    const table = new Uint8Array(n);
    for (let p = 0; p < n; p++) table[p] = state[p] === TABLE ? 1 : 0;
    const tableBefore = prefixSums(table);
    const passes = (part: number[]) => !juts(part) && markedInOutline(tableBefore, part) <= OUTLINE_SLACK * part.length;
    const touchesPage = (p: number) => {
      let touches = besidePage(p);
      eachBeside(p, w, n, (q) => (touches ||= state[q] === PICTURE));
      return touches;
    };
    const acrossEnd = (one: number[], sidesMet: number, span: Box) => {
      if (sidesMet & (sidesMet - 1)) return false;
      const alongRows = sidesMet === LEFT_SIDE || sidesMet === RIGHT_SIDE;
      const depth = ([x, y]: Point2) => (sidesMet === LEFT_SIDE ? x : sidesMet === RIGHT_SIDE ? -x : sidesMet === TOP_SIDE ? y : -y);
      const along = ([x, y]: Point2) => (alongRows ? y : x);
      const nearest = Math.min(...page.hull.map(depth));
      const [from, to] = alongRows ? [span.top, span.bottom] : [span.left, span.right];
      const spanned = (corner: Point2) => along(corner) >= from - PAGE_GAP && along(corner) <= to + PAGE_GAP;
      if (!page.hull.every((corner) => depth(corner) > nearest + 1 || spanned(corner))) return false;
      if (completesPage(one)) return true;
      // A curl puts table in a footer's hull with the page, but a footer spans the whole end: out to the paper's farthest points 45 degrees either way.
      const endCorner = (sign: number) => page.hull.reduce((a, b) => (depth(b) + sign * along(b) < depth(a) + sign * along(a) ? b : a));
      return spanned(endCorner(1)) && spanned(endCorner(-1));
    };
    for (const part of beside) {
      // Stripes that wood across the photo's top cuts off from its edge start no surface, so they are judged by colour.
      if (passes(part)) {
        for (const p of part) loose[p] = 1;
        continue;
      }
      const colours = part.map(tableColour);
      if (!colours.some(Boolean)) {
        part.forEach(makeTable);
        continue;
      }
      // Its table-coloured dark goes first, as narrow stripes that start no surface tie bands to the table.
      part.forEach((p, i) => {
        state[p] = 0;
        if (!colours[i]) return;
        owner[p] = colours[i]!;
        makeTable(p);
      });
      part.filter((p) => !state[p] && (between(p, 0) || between(p, 2))).forEach(makeTable);
      for (const first of part) {
        if (state[first]) continue;
        state[first] = NOT_TABLE;
        const one = [first];
        let sidesMet = 0;
        const span: Box = { left: w, top: h, right: -1, bottom: -1 };
        for (let i = 0; i < one.length; i++) {
          const x = one[i] % w;
          const y = (one[i] - x) / w;
          sidesMet |= (x === 0 ? LEFT_SIDE : 0) | (x === w - 1 ? RIGHT_SIDE : 0) | (y === 0 ? TOP_SIDE : 0) | (y === h - 1 ? BOTTOM_SIDE : 0);
          span.left = Math.min(span.left, x);
          span.right = Math.max(span.right, x);
          span.top = Math.min(span.top, y);
          span.bottom = Math.max(span.bottom, y);
          eachBeside(one[i], w, n, (q) => {
            if (state[q]) return;
            state[q] = NOT_TABLE;
            one.push(q);
          });
        }
        // A band, object or strip reaching the photo's edge beside the page is tied to the table there.
        if (one.some(touchesPage) && (one.every(near) || passes(one)) && (!sidesMet || acrossEnd(one, sidesMet, span))) for (const p of one) loose[p] = 1;
        else one.forEach(makeTable);
      }
    }
  }
  // Loose dark in a table colour is table, as a checked cloth's inner squares start no surface.
  const rest: number[] = [];
  for (let p = 0; p < n; p++) {
    if (!loose[p] || state[p] === TABLE) continue;
    const id = tableColour(p);
    if (!id) {
      rest.push(p);
      continue;
    }
    // Owned, so the seams between such squares are table too.
    owner[p] = id;
    makeTable(p);
  }
  // Cleared, as `between` looks past loose dark only.
  for (const p of rest) state[p] = 0;
  const restSeams = rest.filter((p) => between(p, 0) || between(p, 2));
  for (const p of rest) state[p] = NOT_TABLE;
  restSeams.forEach(makeTable);

  const tableIn = (left: number, right: number, top: number, bottom: number) => {
    for (let y = top; y <= bottom; y++) for (let p = y * w + left; p <= y * w + right; p++) if (state[p] === TABLE) return true;
    return false;
  };
  const across = tableIn(0, box.left - 1, box.top, box.bottom) && tableIn(box.right + 1, w - 1, box.top, box.bottom);
  const along = tableIn(box.left, box.right, 0, box.top - 1) && tableIn(box.left, box.right, box.bottom + 1, h - 1);
  if (!across && !along) return;
  if (region.length <= BACKGROUND_AREA * n) return;
  for (let layer = 0, layerStart = 0; layer < SOFT_EDGE; layer++) {
    const layerEnd = region.length;
    for (let i = layerStart; i < layerEnd; i++) {
      const p = region[i];
      const x = p % w;
      if (x > 0 && state[p - 1] !== TABLE) makeTable(p - 1);
      if (x < w - 1 && state[p + 1] !== TABLE) makeTable(p + 1);
      if (p >= w && state[p - w] !== TABLE) makeTable(p - w);
      if (p < n - w && state[p + w] !== TABLE) makeTable(p + w);
    }
    layerStart = layerEnd;
  }
  for (const p of region) out[p] = 255;
}

type Point2 = readonly [number, number];

/** Each row's span inside the convex hull of `hull`'s corners and the pixels of `part`, in a `w` wide image of `h` rows. */
function outlineWith(hull: Point2[], part: number[], w: number, h: number): { lo: Float64Array; hi: Float64Array } {
  const lo = new Int32Array(h).fill(w);
  const hi = new Int32Array(h).fill(-1);
  for (const p of part) {
    const x = p % w;
    const y = (p - x) / w;
    if (x < lo[y]) lo[y] = x;
    if (x > hi[y]) hi[y] = x;
  }
  const points = [...hull];
  hi.forEach((x, y) => x >= 0 && points.push([lo[y], y], [x, y]));
  return hullSpans(points, convexHull(points), h);
}

/** 1 inside `hull`, the convex hull of `points`, which hold each row's leftmost and rightmost point; 0 elsewhere. */
function hullMask(points: Point2[], hull: Point2[], w: number, h: number): Uint8Array {
  const { lo, hi } = hullSpans(points, hull, h);
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = Math.ceil(lo[y]); x <= hi[y]; x++) mask[y * w + x] = 1;
  return mask;
}

/** Each row's least and greatest x inside `hull`, the convex hull of `points`, which hold each row's leftmost and rightmost point. */
function hullSpans(points: Point2[], hull: Point2[], h: number): { lo: Float64Array; hi: Float64Array } {
  const lo = new Float64Array(h).fill(Infinity);
  const hi = new Float64Array(h).fill(-Infinity);
  const extend = (x: number, y: number) => {
    lo[y] = Math.min(lo[y], x);
    hi[y] = Math.max(hi[y], x);
  };
  for (const [x, y] of points) extend(x, y);
  hull.forEach(([ax, ay], i) => {
    const [bx, by] = hull[(i + 1) % hull.length];
    for (let y = Math.min(ay, by) + 1; y < Math.max(ay, by); y++) extend(ax + ((bx - ax) * (y - ay)) / (by - ay), y);
  });
  return { lo, hi };
}

/**
 * The sides of the convex `hull` at least `least` long, as outward normals and offsets (past a side, nx * x + ny * y > offset):
 * runs of edges turning less than SIDE_TURN from the run's first, each taken as the line through its ends.
 */
function hullSides(hull: Point2[], least: number): { nx: number; ny: number; offset: number }[] {
  const count = hull.length;
  const cx = hull.reduce((sum, [x]) => sum + x, 0) / count;
  const cy = hull.reduce((sum, [, y]) => sum + y, 0) / count;
  const heading = (i: number) => {
    const [ax, ay] = hull[i % count];
    const [bx, by] = hull[(i + 1) % count];
    return Math.atan2(by - ay, bx - ax);
  };
  const turn = (a: number, b: number) => Math.abs(((b - a + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
  let start = 0;
  for (let i = 1; i < count; i++) if (turn(heading(i - 1), heading(i)) > turn(heading(start - 1 + count), heading(start))) start = i;
  const sides: { nx: number; ny: number; offset: number }[] = [];
  for (let i = start; i < start + count; ) {
    let j = i + 1;
    while (j < start + count && turn(heading(i), heading(j)) < SIDE_TURN) j++;
    const [ax, ay] = hull[i % count];
    const [bx, by] = hull[j % count];
    const length = Math.hypot(bx - ax, by - ay);
    if (length >= least) {
      const sign = (by - ay) * (cx - ax) - (bx - ax) * (cy - ay) > 0 ? -1 : 1;
      const nx = (sign * (by - ay)) / length;
      const ny = (-sign * (bx - ax)) / length;
      sides.push({ nx, ny, offset: nx * ax + ny * ay });
    }
    i = j;
  }
  return sides;
}

/** The least distance between two parallel lines that hold the convex `hull` between them, one along an edge. */
function leastWidth(hull: Point2[]): number {
  let least = 0;
  hull.forEach(([ax, ay], i) => {
    const [bx, by] = hull[(i + 1) % hull.length];
    const length = Math.hypot(bx - ax, by - ay);
    let widest = 0;
    for (const [x, y] of hull) widest = Math.max(widest, Math.abs((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / length);
    if (!least || widest < least) least = widest;
  });
  return least;
}

/** The convex hull of `points` by the monotone chain. */
function convexHull(points: Point2[]): Point2[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Point2, a: Point2, b: Point2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: Point2[]) => {
    const chain: Point2[] = [];
    for (const p of list) {
      while (chain.length >= 2 && cross(chain[chain.length - 2], chain[chain.length - 1], p) <= 0) chain.pop();
      chain.push(p);
    }
    chain.pop();
    return chain;
  };
  return [...half(sorted), ...half(sorted.reverse())];
}

/**
 * Each `counted` pixel's chromaticity (R, G and B over their sum) and brightness (luma + 1), its RGB in `rgba`
 * averaged over the `counted` pixels in the (2r + 1)² square around it.
 */
function meanColours(rgba: Uint8Array, counted: Uint8Array, w: number, h: number, r: number): { tint: Float32Array; bright: Float32Array } {
  // Sums of R, G, B and the count above and left of each corner of the pixel grid.
  const row = (w + 1) * 4;
  const sums = new Int32Array(row * (h + 1));
  for (let y = 0; y < h; y++) {
    let red = 0;
    let green = 0;
    let blue = 0;
    let count = 0;
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (counted[p]) {
        red += rgba[p * 4];
        green += rgba[p * 4 + 1];
        blue += rgba[p * 4 + 2];
        count++;
      }
      const corner = (y + 1) * row + (x + 1) * 4;
      sums[corner] = sums[corner - row] + red;
      sums[corner + 1] = sums[corner - row + 1] + green;
      sums[corner + 2] = sums[corner - row + 2] + blue;
      sums[corner + 3] = sums[corner - row + 3] + count;
    }
  }
  const tint = new Float32Array(w * h * 3);
  const bright = new Float32Array(w * h);
  // Per column, as Math.min and Math.max per pixel are slow in Jest.
  const lefts = Int32Array.from({ length: w }, (_, x) => Math.max(0, x - r) * 4);
  const rights = Int32Array.from({ length: w }, (_, x) => Math.min(w, x + r + 1) * 4);
  for (let y = 0; y < h; y++) {
    const top = Math.max(0, y - r) * row;
    const bottom = Math.min(h, y + r + 1) * row;
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!counted[p]) continue;
      const a = bottom + rights[x];
      const b = bottom + lefts[x];
      const c = top + rights[x];
      const d = top + lefts[x];
      const count = sums[a + 3] - sums[b + 3] - sums[c + 3] + sums[d + 3];
      const red = (sums[a] - sums[b] - sums[c] + sums[d]) / count;
      const green = (sums[a + 1] - sums[b + 1] - sums[c + 1] + sums[d + 1]) / count;
      const blue = (sums[a + 2] - sums[b + 2] - sums[c + 2] + sums[d + 2]) / count;
      const sum = red + green + blue + 1;
      tint[p * 3] = red / sum;
      tint[p * 3 + 1] = green / sum;
      tint[p * 3 + 2] = blue / sum;
      bright[p] = LUMA[0] * red + LUMA[1] * green + LUMA[2] * blue + 1;
    }
  }
  return { tint, bright };
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
