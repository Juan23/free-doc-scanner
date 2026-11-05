import {
  AlphaType, ColorType, FilterMode, ImageFormat, MipmapMode, Skia, TileMode, type SkImage, type SkMatrix,
} from '@shopify/react-native-skia';
import { File, Paths } from 'expo-file-system';

import { readPage, replacePage } from './scans';

// Clean-up is on unless this file exists.
const offFile = () => new File(Paths.document, 'clean-up-off');

export const cleanUpOn = () => !offFile().exists;

/** Remembers the choice across launches. Never throws: at worst the choice resets at next launch. */
export function setCleanUp(on: boolean): void {
  try {
    const f = offFile();
    if (on && f.exists) f.delete();
    if (!on && !f.exists) f.create();
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

// How much darker than the coarse paper each pixel of the small copy is. Blurred, it shows where
// the writing is. Kept linear so thin, faint strokes still count once shrunk. Not the picked
// paper: that can follow blurred text, which would then pass for dirt.
const inkEffect = Skia.RuntimeEffect.Make(`
uniform shader page;
uniform shader paper;
half4 main(float2 xy) {
  half3 c = page.eval(xy).rgb / max(paper.eval(xy).rgb, half3(0.05));
  return half4(0, 0, 0, saturate(0.9 - min(min(c.r, c.g), c.b)));
}`)!;

// Divides each pixel by the paper's brightness around it, so shadows and tint turn white, and
// stretches the levels so grain goes white and ink dark. Faint marks far from any writing (dirt,
// creases) go white too; dark marks always stay, so full stops and lines survive.
// Whatever shows past the paper's edges goes white too.
const cleanEffect = Skia.RuntimeEffect.Make(`
uniform shader page;
uniform shader paper;
uniform shader ink;
uniform shader beyond;
half4 main(float2 xy) {
  half3 c = saturate((page.eval(xy).rgb / max(paper.eval(xy).rgb, half3(0.05)) - 0.25) / 0.6);
  half dark = 1 - min(min(c.r, c.g), c.b);
  half keep = max(smoothstep(0.45, 0.65, dark), smoothstep(0.02, 0.05, ink.eval(xy).a));
  return half4(mix(half3(1), c, keep * (1 - beyond.eval(xy).a)), 1);
}`)!;

// Paper and text are found on a copy this wide.
const SMALL_WIDTH = 500;

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

async function cleanPage(uri: string): Promise<void> {
  const image = await readPage(uri);
  if (!image) throw new Error('unreadable page');
  const w = image.width();
  const h = image.height();
  const scale = Math.min(1, SMALL_WIDTH / w);
  const sw = Math.ceil(w * scale);
  const sh = Math.ceil(h * scale);
  const toFull = Skia.Matrix().scale(w / sw, h / sh);
  const clamp = (img: SkImage, mode: FilterMode, matrix?: SkMatrix) =>
    img.makeShaderOptions(TileMode.Clamp, TileMode.Clamp, mode, MipmapMode.None, matrix);

  const surface = Skia.Surface.Make(sw, sh)!;
  const canvas = surface.getCanvas();
  // Mipmapped, so shrinking averages thin strokes in instead of skipping them.
  canvas.drawImageRectOptions(image, Skia.XYWHRect(0, 0, w, h), Skia.XYWHRect(0, 0, sw, sh), FilterMode.Linear, MipmapMode.Linear);
  const smallPage = surface.makeImageSnapshot();

  const wipeInk = Skia.Paint();
  wipeInk.setImageFilter(Skia.ImageFilter.MakeBlur(8, 8, TileMode.Clamp, Skia.ImageFilter.MakeDilate(6, 6, null)));
  canvas.drawImage(smallPage, 0, 0, wipeInk);
  const coarse = surface.makeImageSnapshot();
  const wipeText = Skia.Paint();
  wipeText.setImageFilter(Skia.ImageFilter.MakeErode(5, 5, Skia.ImageFilter.MakeDilate(5, 5, null)));
  canvas.drawImage(smallPage, 0, 0, wipeText);
  const fine = surface.makeImageSnapshot();
  const coarseShader = clamp(coarse, FilterMode.Nearest);
  const fineShader = clamp(fine, FilterMode.Nearest);
  const pickShader = paperEffect.makeShaderWithChildren([], [coarseShader, fineShader]);
  const pickPaper = Skia.Paint();
  pickPaper.setShader(pickShader);
  canvas.drawRect(Skia.XYWHRect(0, 0, sw, sh), pickPaper);
  const paper = surface.makeImageSnapshot();

  const smallPageShader = clamp(smallPage, FilterMode.Nearest);
  const inkShader = inkEffect.makeShaderWithChildren([], [smallPageShader, coarseShader]);
  const spreadInk = Skia.Paint();
  spreadInk.setShader(inkShader);
  spreadInk.setImageFilter(Skia.ImageFilter.MakeBlur(6, 6, TileMode.Clamp, null));
  canvas.clear(Skia.Color('transparent'));
  canvas.drawRect(Skia.XYWHRect(0, 0, sw, sh), spreadInk);
  const ink = surface.makeImageSnapshot();

  const rgba = { width: sw, height: sh, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul };
  const pagePixels = smallPage.readPixels(0, 0, rgba) as Uint8Array | null;
  const finePixels = fine.readPixels(0, 0, rgba) as Uint8Array | null;
  // Unreadable copies just leave the edges as they are.
  const beyondData = Skia.Data.fromBytes(pagePixels && finePixels ? pastEdges(pagePixels, finePixels, sw, sh) : new Uint8Array(sw * sh));
  const beyondMask = Skia.Image.MakeImage({ width: sw, height: sh, colorType: ColorType.Alpha_8, alphaType: AlphaType.Premul }, beyondData, sw)!;
  // Grown a pixel to take in the blurred edge of the paper, and softened.
  const feather = Skia.Paint();
  feather.setImageFilter(Skia.ImageFilter.MakeBlur(1, 1, TileMode.Clamp, Skia.ImageFilter.MakeDilate(1, 1, null)));
  canvas.clear(Skia.Color('transparent'));
  canvas.drawImage(beyondMask, 0, 0, feather);
  const beyond = surface.makeImageSnapshot();

  const pageShader = clamp(image, FilterMode.Nearest);
  const paperShader = clamp(paper, FilterMode.Linear, toFull);
  const textShader = clamp(ink, FilterMode.Linear, toFull);
  const beyondShader = clamp(beyond, FilterMode.Linear, toFull);
  const cleanShader = cleanEffect.makeShaderWithChildren([], [pageShader, paperShader, textShader, beyondShader]);
  const out = Skia.Surface.Make(w, h)!;
  const paint = Skia.Paint();
  paint.setShader(cleanShader);
  out.getCanvas().drawPaint(paint);
  const snapshot = out.makeImageSnapshot();
  const bytes = snapshot.encodeToBytes(ImageFormat.JPEG, 90);
  // A page holds about 100 MB of bitmaps: free them now, not whenever the garbage collector runs.
  for (const o of [
    image, surface, smallPage, wipeInk, coarse, wipeText, fine, coarseShader, fineShader, pickShader,
    pickPaper, paper, smallPageShader, inkShader, spreadInk, ink, beyondData, beyondMask, feather, beyond,
    pageShader, paperShader, textShader, beyondShader, cleanShader, out, paint, snapshot,
  ]) {
    o.dispose();
  }
  // Native Skia returns null when encoding fails, whatever the type says.
  if (!bytes?.length) throw new Error('could not encode page');

  await replacePage(uri, bytes);
}

/**
 * Whitens the paper of stored page JPEGs (shadows, tint, grain, specks) and darkens the ink,
 * replacing each page. A page that can't be cleaned stays as it was.
 */
export async function cleanPages(pageUris: string[]): Promise<void> {
  // One page at a time: each holds full-size bitmaps in memory.
  for (const uri of pageUris) {
    try {
      await cleanPage(uri);
    } catch {}
  }
}
