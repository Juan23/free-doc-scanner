import { AlphaType, ColorType, FilterMode, MipmapMode, Skia, TileMode, type SkImage } from '@shopify/react-native-skia';
import { File } from 'expo-file-system';

import { originalOf, readPage, replacePage } from './scans';

// Text is looked for on a copy this long, where body text is still 5-10 px high.
const SMALL_LONG_SIDE = 1000;
// Unsure there, it reads this share of the page's middle again on a copy this long: a phone photo's
// text is too small on the first copy, and the middle holds the least table round a whole-photo crop.
const CLOSE_LONG_SIDE = 2000;
const CLOSE_PART = 0.5;
const BILINEAR_MIN_SCALE = 0.4;
// The paper's brightness is the brightest pixel in the 3 x 3 blocks of this size around a pixel.
const BLOCK = 8;

/**
 * Which pixels of a small copy of the page, `long` px on its long side, are ink: clearly darker than
 * the paper around them, with the copy's luma. Only the middle `part` of the page's width and height is copied.
 */
function findInk(image: SkImage, long: number, part = 1) {
  const width = image.width();
  const height = image.height();
  const scale = Math.min(1, long / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale * part));
  const h = Math.max(1, Math.round(height * scale * part));
  const surface = Skia.Surface.Make(w, h);
  if (!surface) throw new Error('no surface');
  const matrix = Skia.Matrix().scale(scale, scale).translate((-width * (1 - part)) / 2, (-height * (1 - part)) / 2);
  const paint = Skia.Paint();
  // Bilinear alone skips pixels when shrinking over 2.5 times; one mipmap level costs a fifth of blending two.
  const mip = scale < BILINEAR_MIN_SCALE ? MipmapMode.Nearest : MipmapMode.None;
  const shader = image.makeShaderOptions(TileMode.Clamp, TileMode.Clamp, FilterMode.Linear, mip, matrix);
  paint.setShader(shader);
  surface.getCanvas().drawPaint(paint);
  const small = surface.makeImageSnapshot();
  for (const o of [surface, paint, shader, matrix]) o.dispose();
  const rgba = small.readPixels(0, 0, { width: w, height: h, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul }) as Uint8Array | null;
  small.dispose();
  if (!rgba) throw new Error('unreadable page');

  // The per-pixel loops run on Hermes, which interprets them: index work and calls are kept out of them.
  const luma = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) luma[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
  return { ink: inkOf(luma, w, h), w, h, luma };
}

/** Which pixels of `luma` (w × h) are ink: clearly darker than the paper around them. */
function inkOf(luma: Uint8Array, w: number, h: number): Uint8Array {
  const bw = Math.ceil(w / BLOCK);
  const bh = Math.ceil(h / BLOCK);
  const column = new Int32Array(w);
  for (let x = 0; x < w; x++) column[x] = (x / BLOCK) | 0;
  const brightest = new Uint8Array(bw * bh);
  for (let y = 0, i = 0; y < h; y++) {
    const row = ((y / BLOCK) | 0) * bw;
    for (let x = 0; x < w; x++, i++) if (luma[i] > brightest[row + column[x]]) brightest[row + column[x]] = luma[i];
  }
  // Ink is clearly darker than the paper p: below both 0.75 p and p - 25.
  const below = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let p = 0;
      const lastY = Math.min(bh - 1, by + 1);
      const lastX = Math.min(bw - 1, bx + 1);
      for (let y = Math.max(0, by - 1); y <= lastY; y++) {
        for (let x = Math.max(0, bx - 1); x <= lastX; x++) if (brightest[y * bw + x] > p) p = brightest[y * bw + x];
      }
      below[by * bw + bx] = Math.min(0.75 * p, p - 25);
    }
  }
  const ink = new Uint8Array(w * h);
  for (let y = 0, i = 0; y < h; y++) {
    const row = ((y / BLOCK) | 0) * bw;
    for (let x = 0; x < w; x++, i++) ink[i] = luma[i] < below[row + column[x]] ? 1 : 0;
  }
  return ink;
}

/** Whether most of the page (`luma`) is far darker than its light parts, as under light text on a dark card. */
function lightOnDark(luma: Uint8Array): boolean {
  const counts = new Int32Array(256);
  for (let i = 0; i < luma.length; i++) counts[luma[i]]++;
  const n = luma.length;
  let median = -1;
  let light = -1;
  for (let v = 0, seen = 0; v < 256; v++) {
    seen += counts[v];
    if (median < 0 && seen >= n / 2) median = v;
    if (light < 0 && seen >= 0.99 * n) light = v;
  }
  return median < light / 2;
}

/** `ink` (w × h) turned a quarter turn clockwise, so h × w. */
function turnClockwise(ink: Uint8Array, w: number, h: number): Uint8Array {
  const turned = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) turned[x * h + h - 1 - y] = ink[y * w + x];
  return turned;
}

// Lines are read in upright strips this wide, narrow enough that a skewed or curled line is nearly
// straight within one.
const STRIP = 60;
// A row is part of a line's lowercase letters when it holds at least half the ink of the inkiest
// row this near.
const NEARBY = 15;
// Below this x-height (the height of lowercase letters) ascenders can't be told from noise.
const MIN_X_HEIGHT = 4;
// A column sticks out of a line when it passes the line's edge by this share of the x-height.
const STICK_OUT = 0.3;
// In a line of text, most columns start at the x-line and end at the baseline, within this share
// of the x-height. Not so for pictures, or for the ragged line ends of a text column seen sideways.
const ALIGNED = 0.2;
// A full stop or comma is a mark at most this many x-heights tall and wide, on its own in its columns...
const MARK = 0.6;
// ...with its middle this far down from the x-line (0) towards the baseline (1)...
const STOP_FROM = 0.65;
const STOP_TO = 1.25;
// ...and a space at least this many x-heights wide after it, wider than most between letters,
// and at least MIN_SPACE pixels: narrower, it can't be told from the gap between small letters.
const SPACE = 0.45;
const MIN_SPACE = 3;
// Spaces are measured up to this many times SPACE.
const FAR = 4;
// With spaces on both sides, the wider counts only when this many times the other: a typewriter
// font's full stop has a wide gap before it, but its space after is wider still.
const WIDER = 3;
// From this many times up to WIDER, a mark with spaces on both sides tells nothing: a comma after a y
// has a 4 px gap before it and 11 after, in 36 px type on a 3024 px photo, as another script's mark can.
const NEUTRAL = 2;
// A digit's column runs at least this share of the digit's height.
const FULL_COLUMN = 0.75;

function median(values: number[]): number {
  const sorted = values.sort((a, b) => a - b);
  const m = sorted.length >> 1;
  // Taking either middle value of an even count would lean every edge one way.
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

/** A line's top or bottom edge at each column of a strip: straight through the medians of the strip's halves, so it follows a sloping line. */
function edge(columns: number[], at: Int32Array): (x: number) => number {
  const middle = median(columns.map((x) => at[x]));
  const left = columns.filter((x) => x < STRIP / 2);
  const right = columns.filter((x) => x >= STRIP / 2);
  if (left.length < STRIP / 8 || right.length < STRIP / 8) return () => middle;
  const rise = median(right.map((x) => at[x])) - median(left.map((x) => at[x]));
  const slope = rise / Math.max(1, median(right) - median(left));
  return (x) => middle + slope * (x - STRIP / 2);
}

/**
 * Stop-sized marks along one edge of the lines, by the side their space is on, reading the edge as
 * the baseline (at the x-line, read upside down, "after" is to the left).
 */
type Marks = {
  ltr: number; // space only after, as full stops of left-to-right text have
  rtl: number; // space only before, as those of right-to-left text have
  inWord: number; // letters close on both sides
  alone: number; // spaces on both sides, neither NEUTRAL times the other: a speck, or a typewriter font's letter
};

/**
 * Counts the strokes that stick up above lines of text running across `ink`, those that hang down
 * below them, and the lines (one strip wide) read. Latin text is upright when far more stick up:
 * ascenders, capitals and digits (b d f h k l t, A-Z, 0-9) outnumber descenders (g j p q y). Lines
 * running the other way and pictures give about as many of each; capitals only, few.
 *
 * Also counts the stop-sized marks on the baseline (`low`) and at the x-line (`high`), where full
 * stops and commas sit upright and upside down, and the ink in the top and bottom thirds of the
 * lines' lowercase letters (`inkTop`, `inkBottom`).
 */
function strokes(ink: Uint8Array, w: number, h: number) {
  let up = 0;
  let down = 0;
  let inkTop = 0;
  let inkBottom = 0;
  let lines = 0;
  const low: Marks = { ltr: 0, rtl: 0, inWord: 0, alone: 0 };
  const high: Marks = { ltr: 0, rtl: 0, inWord: 0, alone: 0 };
  const rows = new Float32Array(h);
  const smooth = new Float32Array(h);
  const lowercase = new Uint8Array(h);
  const tops = new Int32Array(STRIP);
  const bottoms = new Int32Array(STRIP);
  for (let left = 0; left + STRIP <= w; left += STRIP) {
    for (let y = 0; y < h; y++) {
      let n = 0;
      for (let x = left; x < left + STRIP; x++) n += ink[y * w + x];
      rows[y] = n;
    }
    for (let y = 1; y + 1 < h; y++) smooth[y] = (rows[y - 1] + 2 * rows[y] + rows[y + 1]) / 4;
    for (let y = 0; y < h; y++) {
      let most = 0;
      // The busiest loop: calls kept out of it, as in findInk.
      const last = Math.min(h - 1, y + NEARBY);
      for (let k = Math.max(0, y - NEARBY); k <= last; k++) if (smooth[k] > most) most = smooth[k];
      lowercase[y] = most > 3 && smooth[y] >= most / 2 ? 1 : 0;
    }
    // Each band of lowercase rows is a line, reaching out to the emptiest rows between it and its neighbours.
    const bands: [number, number][] = [];
    for (let y = 0; y < h; y++) {
      if (lowercase[y] && (y === 0 || !lowercase[y - 1])) bands.push([y, y]);
      if (lowercase[y]) bands[bands.length - 1][1] = y + 1;
    }
    bands.forEach(([top, bottom], i) => {
      let from = i > 0 ? bands[i - 1][1] : 0;
      for (let y = from; y < top; y++) if (smooth[y] <= smooth[from]) from = y;
      let to = i + 1 < bands.length ? bands[i + 1][0] - 1 : h - 1;
      for (let y = to; y >= bottom; y--) if (smooth[y] <= smooth[to]) to = y;

      const columns: number[] = [];
      for (let x = 0; x < STRIP; x++) {
        tops[x] = -1;
        for (let y = from; y <= to; y++) {
          if (ink[y * w + left + x]) {
            if (tops[x] < 0) tops[x] = y;
            bottoms[x] = y;
          }
        }
        if (tops[x] >= 0) columns.push(x);
      }
      if (columns.length < STRIP / 3) return;
      const xLine = edge(columns, tops);
      const baseline = edge(columns, bottoms);
      const xHeight = baseline(STRIP / 2) - xLine(STRIP / 2);
      if (xHeight < MIN_X_HEIGHT || xHeight > 3 * (bottom - top)) return;
      const near = Math.max(1, ALIGNED * xHeight);
      const onXLine = columns.filter((x) => Math.abs(tops[x] - xLine(x)) <= near).length;
      const onBaseline = columns.filter((x) => Math.abs(bottoms[x] - baseline(x)) <= near).length;
      if (Math.min(onXLine, onBaseline) < 0.4 * columns.length) return;
      lines++;

      for (let x = 0; x < STRIP; x++) {
        const upper = xLine(x);
        const lower = baseline(x);
        const third = (lower - upper) / 3;
        const last = Math.min(h - 1, Math.round(lower));
        for (let y = Math.max(0, Math.round(upper)); y <= last; y++) {
          if (!ink[y * w + left + x]) continue;
          if (y < upper + third) inkTop++;
          if (y > lower - third) inkBottom++;
        }
      }

      const reach = Math.max(1.5, STICK_OUT * xHeight);
      // A run of sticking-out columns is one stroke.
      let wasUp = false;
      let wasDown = false;
      for (let x = 0; x < STRIP; x++) {
        const isUp = tops[x] >= 0 && tops[x] < xLine(x) - reach;
        const isDown = tops[x] >= 0 && bottoms[x] > baseline(x) + reach;
        if (isUp && !wasUp) up++;
        if (isDown && !wasDown) down++;
        wasUp = isUp;
        wasDown = isDown;
      }

      // Each run of inked columns with blank ones either side is a mark when it is small enough.
      const mark = Math.max(2, MARK * xHeight);
      const space = Math.max(MIN_SPACE, SPACE * xHeight);
      for (let a = 1; a < STRIP - 1; a++) {
        if (tops[a] < 0 || tops[a - 1] >= 0) continue;
        let b = a;
        let markTop = tops[a];
        let markBottom = bottoms[a];
        for (; b + 1 < STRIP && tops[b + 1] >= 0; b++) {
          markTop = Math.min(markTop, tops[b + 1]);
          markBottom = Math.max(markBottom, bottoms[b + 1]);
        }
        if (b === STRIP - 1 || b - a + 1 > mark || markBottom - markTop + 1 > mark) continue;
        const middle = (a + b) / 2;
        const at = ((markTop + markBottom) / 2 - xLine(middle)) / xHeight;
        const isStop = at >= STOP_FROM && at <= STOP_TO;
        if (!isStop && (at < 1 - STOP_TO || at > 1 - STOP_FROM)) continue;
        const xRow = Math.max(0, Math.round(xLine(middle)));
        const baseRow = Math.min(h - 1, Math.round(baseline(middle)));
        // How many columns from x on, stepping by `step`, are blank between the x-line and the baseline,
        // up to FAR spaces.
        const blank = (x: number, step: number) => {
          let n = 0;
          for (; n < FAR * space; n++, x += step) {
            if (x < 0 || x >= w) return FAR * space;
            for (let y = xRow; y <= baseRow; y++) if (ink[y * w + x]) return n;
          }
          return n;
        };
        // The nearest inked run from x within the strip, stepping by `step`: where it starts and ends, its
        // extent, and whether it sticks out past the line on the mark's near side.
        const run = (x: number, step: number) => {
          for (; x >= 0 && x < STRIP && tops[x] < 0; x += step);
          const start = x;
          let top = h;
          let bottom = -1;
          let near = false;
          for (; x >= 0 && x < STRIP && tops[x] >= 0; x += step) {
            near ||= isStop ? bottoms[x] > baseline(x) + reach : tops[x] < xLine(x) - reach;
            top = Math.min(top, tops[x]);
            bottom = Math.max(bottom, bottoms[x]);
          }
          return { start, end: x - step, width: Math.abs(x - start), top, bottom, near };
        };
        type Run = ReturnType<typeof run>;
        const isMark = (r: Run) => r.width > 0 && r.width <= mark && r.bottom - r.top + 1 <= mark && Math.abs(r.top - markTop) <= Math.max(1, ALIGNED * xHeight);
        // A digit is taller than the x-height, sticks out on one side only, and most of its columns run
        // most of its height; a letter that sticks out does so by a stem.
        const isDigit = (r: Run) => {
          const height = r.bottom - r.top + 1;
          if (!r.width || r.near || height < xHeight + reach) return false;
          let full = 0;
          for (let x = Math.min(r.start, r.end); x <= Math.max(r.start, r.end); x++) if (bottoms[x] - tops[x] + 1 >= FULL_COLUMN * height) full++;
          return full >= r.width / 2;
        };
        const gap = (from: number, r: Run) => Math.abs(r.start - from) - 1;
        // A dot leader is 3 or more marks a row, evenly spaced; a pair of marks is not one.
        const inLeader = () => {
          const left1 = run(a - 1, -1);
          const right1 = run(b + 1, 1);
          const gapLeft = gap(a, left1);
          const gapRight = gap(b, right1);
          if (isMark(left1) && isMark(right1)) return Math.abs(gapLeft - gapRight) <= 1;
          const left2 = run(left1.end - 1, -1);
          const right2 = run(right1.end + 1, 1);
          if (isMark(left1) && isMark(left2)) return Math.abs(gap(left1.end, left2) - gapLeft) <= 1;
          if (isMark(right1) && isMark(right2)) return Math.abs(gap(right1.end, right2) - gapRight) <= 1;
          return false;
        };
        const after = blank(left + b + 1, 1);
        const before = blank(left + a - 1, -1);
        const marks = isStop ? low : high;
        const ltr = isStop ? after : before;
        const rtl = isStop ? before : after;
        if (ltr >= space && (rtl < space || ltr >= WIDER * rtl)) marks.ltr++;
        else if (rtl >= space && (ltr < space || rtl >= WIDER * ltr)) marks.rtl++;
        else {
          // A decimal point between digits or a dot leader's dot is no other script's mark, so it is not counted.
          if ((isDigit(run(a - 1, -1)) && isDigit(run(b + 1, 1))) || inLeader()) continue;
          if (ltr < space) marks.inWord++;
          else if (ltr < NEUTRAL * rtl && rtl < NEUTRAL * ltr) marks.alone++;
        }
      }
    });
  }
  return { up, down, inkTop, inkBottom, lines, low, high };
}

// Upright Latin text leans about 0.5 to the up side (sticking up minus hanging down, over both) on a
// flat scan. The DocUNet photos that turn upright lean 0.28 to 0.58, but a page read across its lines
// leans up to 1.0 on a handful of strokes, so the lean alone rules out little: the gates below do.
const SURE_LEAN = 0.2;
// About a third of Latin letters stick up and some hang down, so it never leans past about 0.7.
// Further, the strokes are something else: vowel points under every letter, a script's long tails.
const MAX_LEAN = 0.7;
// The lean must also hold over enough strokes that chance can't explain it: it is this many
// standard deviations from even, (up - down) / √(up + down). On 130 DocUNet photos turned four ways,
// a page read across its lines passes every other gate at up to 3.7, and a reading that turns the
// page right starts at 5.2.
const SURE_DEVIATIONS = 4.5;
// Lowercase text has an ascender or capital in nearly every word: at least this many per line in a strip.
// Text in capitals sticks out only at stray marks (commas, Q), which don't show reliably which way is up.
const SURE_PER_LINE = 0.8;
// Strokes alone can't tell upright Cyrillic (or another script heavy in descenders) from
// upside-down Latin, so the full stops and commas must agree: on the side the strokes say is up,
// those on the baseline must outnumber those hanging from the x-line by this many standard
// deviations, (stops - hanging) / √(stops + hanging).
const SURE_STOPS = 1.5;
// Some scripts' letters leave stop-sized marks too: Hebrew's yod hangs from the top of the line, so
// upside down one ending a word sits like a full stop. Such marks also come inside words, or alone
// between wide gaps in a typewriter font, and right-to-left text turned the other way up has its
// own full stops on the other edge, with the space on the other side. Latin has few such marks, so
// they must stay below this share of the full stops.
const MAX_SCRIPT_MARKS = 2 / 3;
// A few such marks tell nothing: on a short page, two broken letters reach two thirds of its three full stops.
const MIN_SCRIPT_MARKS = 4;
// Latin letters hold about as much ink at the top of the x-height as at the bottom, or more: n, m
// and h arch there, a, c, e and s close there. Hebrew's hold far more at the top, in the bars across
// ב ד ה כ ר ת, so upside down, the way Latin would read them as upright, they are heavy at the
// bottom. The top third of the letters must hold at least this share of the bottom third's ink.
const MIN_BALANCE = 0.95;

function lean({ up, down, inkTop, inkBottom, lines, low, high }: ReturnType<typeof strokes>) {
  const [stops, hanging] = up >= down ? [low, high] : [high, low];
  const scriptMarks = stops.inWord + stops.alone + hanging.rtl;
  return {
    lean: (up - down) / (up + down || 1),
    deviations: (up - down) / Math.sqrt(up + down || 1),
    perLine: Math.max(up, down) / (lines || 1),
    balance: up >= down ? inkTop / (inkBottom || 1) : inkBottom / (inkTop || 1),
    stops: (stops.ltr - hanging.ltr) / Math.sqrt(stops.ltr + hanging.ltr || 1),
    script: scriptMarks >= MIN_SCRIPT_MARKS && scriptMarks >= MAX_SCRIPT_MARKS * stops.ltr,
  };
}

type Reading = ReturnType<typeof lean>;

/** The gates reading `a` fails as the way the text runs, with `b` the page read the other way. */
function failedGates(a: Reading, b: Reading): string[] {
  const gates: [string, boolean][] = [
    ['lean', Math.abs(a.lean) >= SURE_LEAN],
    ['maxLean', Math.abs(a.lean) <= MAX_LEAN],
    ['deviations', Math.abs(a.deviations) >= SURE_DEVIATIONS],
    ['perLine', a.perLine >= SURE_PER_LINE],
    ['balance', a.balance >= MIN_BALANCE],
    ['stops', a.stops >= SURE_STOPS],
    ['script', !a.script],
    // Text lines run one way only, so read the other way the page must lean far less surely.
    ['other', Math.abs(b.deviations) <= Math.abs(a.deviations) / 2],
  ];
  return gates.filter(([, holds]) => !holds).map(([name]) => name);
}

/** `turns` (clockwise quarter turns to stand the text upright) is 0 also when unsure: no clear text, or no clear up. */
export function readUpright(image: SkImage) {
  const first = findInk(image, SMALL_LONG_SIDE);
  const whole = readInk(first);
  const sure = whole.turns || !whole.failedAsIs.length;
  // Held back by another script's marks alone, the page is not looked at again: its middle may hold too few of them.
  const heldByScriptOnly = [whole.failedAsIs, whole.failedTurned].some((failed) => failed.length === 1 && failed[0] === 'script');
  // A page this small is read at full size already, so a closer look sees nothing new.
  const fullSize = Math.max(image.width(), image.height()) <= SMALL_LONG_SIDE;
  const read = sure || heldByScriptOnly || fullSize ? whole : readInk(findInk(image, CLOSE_LONG_SIDE, CLOSE_PART));
  // Light text on a dark card is gaps in the ink, so an unsure page that is mostly dark is read again as its
  // negative; not one held back by another script's marks, which the negative cannot see.
  if (read.turns || !read.failedAsIs.length || heldByScriptOnly || !lightOnDark(first.luma)) return read;
  const flipped = new Uint8Array(first.luma.length);
  for (let i = 0; i < flipped.length; i++) flipped[i] = 255 - first.luma[i];
  const negative = readInk({ ink: inkOf(flipped, first.w, first.h), w: first.w, h: first.h });
  return negative.turns ? negative : read;
}

function readInk({ ink, w, h }: { ink: Uint8Array; w: number; h: number }) {
  const asIs = lean(strokes(ink, w, h));
  const turned = lean(strokes(turnClockwise(ink, w, h), h, w));
  const failedAsIs = failedGates(asIs, turned);
  const failedTurned = failedGates(turned, asIs);
  const turns = !failedAsIs.length ? (asIs.lean > 0 ? 0 : 2) : !failedTurned.length ? (turned.lean > 0 ? 1 : 3) : 0;
  return { turns: turns as 0 | 1 | 2 | 3, asIs, turned, failedAsIs, failedTurned };
}

/** `image` turned clockwise by 1-3 quarter turns. */
export function turnedImage(image: SkImage, turns: number): SkImage {
  const w = image.width();
  const h = image.height();
  const [tw, th] = turns % 2 ? [h, w] : [w, h];
  const surface = Skia.Surface.Make(tw, th)!;
  const canvas = surface.getCanvas();
  canvas.translate(tw / 2, th / 2);
  canvas.rotate(turns * 90, 0, 0);
  canvas.drawImage(image, -w / 2, -h / 2);
  const turned = surface.makeImageSnapshot();
  surface.dispose();
  return turned;
}

/** Turns `image` clockwise by 1-3 quarter turns and stores it over the page at `uri`. */
async function storeTurned(image: SkImage, turns: number, uri: string): Promise<void> {
  const turned = turnedImage(image, turns);
  try {
    await replacePage(uri, turned);
  } finally {
    turned.dispose();
  }
}

/**
 * Turns the stored page JPEG at `uri` clockwise by `quarterTurns` × 90°, replacing it and its
 * untouched original alike so a later filter change keeps the turn.
 */
export async function rotatePage(uri: string, quarterTurns: number): Promise<void> {
  const turns = ((quarterTurns % 4) + 4) % 4;
  if (!turns) return;
  const image = await readPage(uri);
  try {
    const original = originalOf(uri);
    const hasOriginal = original !== uri && new File(original).exists;
    // Read both before writing either, so a page that can't be read leaves the pair as it was.
    const originalImage = hasOriginal ? await readPage(original) : null;
    try {
      if (originalImage) await storeTurned(originalImage, turns, original);
      await storeTurned(image, turns, uri);
    } finally {
      originalImage?.dispose();
    }
  } finally {
    image.dispose();
  }
}
