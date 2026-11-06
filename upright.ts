import { AlphaType, ColorType, FilterMode, MipmapMode, Skia, type SkImage } from '@shopify/react-native-skia';

import { readPage, replacePage } from './scans';

// Text is looked for on a copy this long, where body text is still 5-10 px high.
const SMALL_LONG_SIDE = 1000;
// The paper's brightness is the brightest pixel in the 3 x 3 blocks of this size around a pixel.
const BLOCK = 8;

/** Which pixels of a small copy of the page are ink: clearly darker than the paper around them. */
function findInk(image: SkImage): { ink: Uint8Array; w: number; h: number } {
  const width = image.width();
  const height = image.height();
  const scale = Math.min(1, SMALL_LONG_SIDE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const surface = Skia.Surface.Make(w, h)!;
  // Mipmapped, so shrinking averages thin strokes in instead of skipping them.
  surface
    .getCanvas()
    .drawImageRectOptions(image, Skia.XYWHRect(0, 0, width, height), Skia.XYWHRect(0, 0, w, h), FilterMode.Linear, MipmapMode.Linear);
  const small = surface.makeImageSnapshot();
  const rgba = small.readPixels(0, 0, { width: w, height: h, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul }) as Uint8Array | null;
  for (const o of [surface, small]) o.dispose();
  if (!rgba) throw new Error('unreadable page');

  // The per-pixel loops run on Hermes, which interprets them: index work and calls are kept out of them.
  const bw = Math.ceil(w / BLOCK);
  const bh = Math.ceil(h / BLOCK);
  const column = new Int32Array(w);
  for (let x = 0; x < w; x++) column[x] = (x / BLOCK) | 0;
  const luma = new Uint8Array(w * h);
  const brightest = new Uint8Array(bw * bh);
  for (let y = 0, i = 0; y < h; y++) {
    const row = ((y / BLOCK) | 0) * bw;
    for (let x = 0; x < w; x++, i++) {
      const v = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
      luma[i] = v;
      if (v > brightest[row + column[x]]) brightest[row + column[x]] = v;
    }
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
  return { ink, w, h };
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
  alone: number; // spaces on both sides, neither WIDER times the other: a speck, or a typewriter font's letter
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
        const after = blank(left + b + 1, 1);
        const before = blank(left + a - 1, -1);
        const marks = isStop ? low : high;
        const ltr = isStop ? after : before;
        const rtl = isStop ? before : after;
        if (ltr >= space && (rtl < space || ltr >= WIDER * rtl)) marks.ltr++;
        else if (rtl >= space && (ltr < space || rtl >= WIDER * ltr)) marks.rtl++;
        else if (ltr >= space) marks.alone++;
        else marks.inWord++;
      }
    });
  }
  return { up, down, inkTop, inkBottom, lines, low, high };
}

// Upright Latin text leans about 0.5 to the up side (sticking up minus hanging down, over both).
// Lines running the other way and pictures lean less than about 0.25 either way.
const SURE_LEAN = 0.3;
// About a third of Latin letters stick up and some hang down, so it never leans past about 0.7.
// Further, the strokes are something else: vowel points under every letter, a script's long tails.
const MAX_LEAN = 0.7;
// The lean must also hold over enough strokes that chance can't explain it: it is this many
// standard deviations from even, (up - down) / √(up + down).
const SURE_DEVIATIONS = 6;
// Lowercase text has an ascender or capital in nearly every word: at least this many per line in a strip.
// Text in capitals sticks out only at stray marks (commas, Q), which don't show reliably which way is up.
const SURE_PER_LINE = 0.8;
// Strokes alone can't tell upright Cyrillic (or another script heavy in descenders) from
// upside-down Latin, so the full stops and commas must agree: on the side the strokes say is up,
// those on the baseline must outnumber those hanging from the x-line by this many standard
// deviations, (stops - hanging) / √(stops + hanging).
const SURE_STOPS = 2;
// Some scripts' letters leave stop-sized marks too: Hebrew's yod hangs from the top of the line, so
// upside down one ending a word sits like a full stop. Such marks also come inside words, or alone
// between wide gaps in a typewriter font, and right-to-left text turned the other way up has its
// own full stops on the other edge, with the space on the other side. Latin has few such marks, so
// they must stay below this share of the full stops.
const MAX_SCRIPT_MARKS = 2 / 3;
// Latin letters hold about as much ink at the top of the x-height as at the bottom, or more: n, m
// and h arch there, a, c, e and s close there. Hebrew's hold far more at the top, in the bars across
// ב ד ה כ ר ת, so upside down, the way Latin would read them as upright, they are heavy at the
// bottom. The top third of the letters must hold at least this share of the bottom third's ink.
const MIN_BALANCE = 0.95;

function lean({ up, down, inkTop, inkBottom, lines, low, high }: ReturnType<typeof strokes>) {
  const [stops, hanging] = up >= down ? [low, high] : [high, low];
  return {
    lean: (up - down) / (up + down || 1),
    deviations: (up - down) / Math.sqrt(up + down || 1),
    perLine: Math.max(up, down) / (lines || 1),
    balance: up >= down ? inkTop / (inkBottom || 1) : inkBottom / (inkTop || 1),
    stops: (stops.ltr - hanging.ltr) / Math.sqrt(stops.ltr + hanging.ltr || 1),
    script: stops.inWord + stops.alone + hanging.rtl >= MAX_SCRIPT_MARKS * stops.ltr,
  };
}

/**
 * The clockwise quarter turns (0-3) that would stand the page's text upright. 0 also when unsure:
 * when the page has no clear text, or its text has no clear up.
 */
export function quarterTurnsToUpright(image: SkImage): 0 | 1 | 2 | 3 {
  const { ink, w, h } = findInk(image);
  const asIs = lean(strokes(ink, w, h));
  const turned = lean(strokes(turnClockwise(ink, w, h), h, w));
  // Text lines run one way only, so read the other way the page must lean far less surely.
  const clear = (a: typeof asIs, b: typeof asIs) =>
    Math.abs(a.lean) >= SURE_LEAN &&
    Math.abs(a.lean) <= MAX_LEAN &&
    Math.abs(a.deviations) >= SURE_DEVIATIONS &&
    a.perLine >= SURE_PER_LINE &&
    a.balance >= MIN_BALANCE &&
    a.stops >= SURE_STOPS &&
    !a.script &&
    Math.abs(b.deviations) <= Math.abs(a.deviations) / 2;
  if (clear(asIs, turned)) return asIs.lean > 0 ? 0 : 2;
  if (clear(turned, asIs)) return turned.lean > 0 ? 1 : 3;
  return 0;
}

/** Turns `image` clockwise by 1-3 quarter turns and stores it over the page at `uri`. */
async function storeTurned(image: SkImage, turns: number, uri: string): Promise<void> {
  const w = image.width();
  const h = image.height();
  const [tw, th] = turns % 2 ? [h, w] : [w, h];
  const surface = Skia.Surface.Make(tw, th)!;
  const canvas = surface.getCanvas();
  canvas.translate(tw / 2, th / 2);
  canvas.rotate(turns * 90, 0, 0);
  canvas.drawImage(image, -w / 2, -h / 2);
  const turned = surface.makeImageSnapshot();
  try {
    await replacePage(uri, turned);
  } finally {
    for (const o of [surface, turned]) o.dispose();
  }
}

/** Turns the stored page JPEG at `uri` clockwise by `quarterTurns` × 90°, replacing it. */
export async function rotatePage(uri: string, quarterTurns: number): Promise<void> {
  const turns = ((quarterTurns % 4) + 4) % 4;
  if (!turns) return;
  const image = await readPage(uri);
  try {
    await storeTurned(image, turns, uri);
  } finally {
    image.dispose();
  }
}

/**
 * Turns stored page JPEGs whose text is sideways or upside down upright, replacing each such page.
 * Pages without clear text, and pages that can't be read, stay as they were.
 */
export async function uprightPages(pageUris: string[]): Promise<void> {
  // One page at a time: each holds a full-size bitmap in memory.
  for (const uri of pageUris) {
    try {
      const image = await readPage(uri);
      try {
        const turns = quarterTurnsToUpright(image);
        if (turns) await storeTurned(image, turns, uri);
      } finally {
        image.dispose();
      }
    } catch {}
  }
}
