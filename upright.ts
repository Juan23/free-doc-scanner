import { FilterMode, ImageFormat, MipmapMode, Skia, type SkImage } from '@shopify/react-native-skia';
import { File } from 'expo-file-system';

async function decode(uri: string): Promise<SkImage> {
  const data = Skia.Data.fromBytes(await new File(uri).bytes());
  const image = Skia.Image.MakeImageFromEncoded(data);
  data.dispose();
  if (!image) throw new Error('unreadable page');
  return image;
}

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
  const rgba = small.readPixels(0, 0, { width: w, height: h, colorType: 4, alphaType: 3 }) as Uint8Array | null;
  for (const o of [surface, small]) o.dispose();
  if (!rgba) throw new Error('unreadable page');

  const luma = new Uint8Array(w * h);
  for (let i = 0; i < luma.length; i++) luma[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
  const bw = Math.ceil(w / BLOCK);
  const bh = Math.ceil(h / BLOCK);
  const brightest = new Uint8Array(bw * bh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const b = ((y / BLOCK) | 0) * bw + ((x / BLOCK) | 0);
      if (luma[y * w + x] > brightest[b]) brightest[b] = luma[y * w + x];
    }
  }
  const paper = new Uint8Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      for (let y = Math.max(0, by - 1); y <= Math.min(bh - 1, by + 1); y++) {
        for (let x = Math.max(0, bx - 1); x <= Math.min(bw - 1, bx + 1); x++) {
          paper[by * bw + bx] = Math.max(paper[by * bw + bx], brightest[y * bw + x]);
        }
      }
    }
  }
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = paper[((y / BLOCK) | 0) * bw + ((x / BLOCK) | 0)];
      const v = luma[y * w + x];
      ink[y * w + x] = v < 0.75 * p && p - v > 25 ? 1 : 0;
    }
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
// A gap this many x-heights wide ends a line: wider than a word space, narrower than most column gaps.
const LINE_GAP = 4;
// A line ends short, or starts late, when a line within NEIGHBOURS x-heights above or below it
// reaches SHORT x-heights further: more than a paragraph's indent (1.25 cm is about 7 x-heights of
// 10 pt type).
const NEIGHBOURS = 6;
const SHORT = 10;

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
 * Counts the strokes that stick up above lines of text running across `ink`, those that hang down
 * below them, and the lines (one strip wide) read. Latin text is upright when far more stick up:
 * ascenders, capitals and digits (b d f h k l t, A-Z, 0-9) outnumber descenders (g j p q y). Lines
 * running the other way and pictures give about as many of each; capitals only, few. Other scripts
 * vary: upright Cyrillic has more descenders, so it leans like upside-down Latin.
 *
 * Also counts the whole lines that end short of the lines around them and those that start late.
 * Text starting at the left, in any left-to-right script, ends short far more often: ragged right
 * edges and paragraphs' last lines.
 */
function strokes(ink: Uint8Array, w: number, h: number): { up: number; down: number; lines: number; short: number; late: number } {
  let up = 0;
  let down = 0;
  let lines = 0;
  // Whole lines, each once: first and last inked column, middle row, x-height.
  const found: [number, number, number, number][] = [];
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
      for (let k = Math.max(0, y - NEARBY); k <= Math.min(h - 1, y + NEARBY); k++) most = Math.max(most, smooth[k]);
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

      // The first strip with ink of a line not yet followed follows it out both ways along its
      // lowercase rows, until a gap no word space is as wide as.
      const inked = (x: number) => {
        for (let y = top; y < bottom; y++) if (ink[y * w + x]) return true;
        return false;
      };
      let first = left;
      while (first < left + STRIP && !inked(first)) first++;
      const middle = (top + bottom) / 2;
      if (first < left + STRIP && !found.some(([s, e, y]) => s <= first && first <= e && Math.abs(y - middle) < xHeight)) {
        const gap = Math.max(6, LINE_GAP * xHeight);
        let start = first;
        let end = first;
        for (let x = first - 1; x >= 0 && start - x <= gap; x--) if (inked(x)) start = x;
        for (let x = first + 1; x < w && x - end <= gap; x++) if (inked(x)) end = x;
        found.push([start, end, middle, xHeight]);
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
    });
  }
  let short = 0;
  let late = 0;
  for (const [start, end, y, xHeight] of found) {
    // Lines just above and below, side by side with this one (not those of the next column).
    const near = found.filter(([s, e, y2]) => Math.abs(y2 - y) <= NEIGHBOURS * xHeight && s <= end && e >= start);
    if (near.length < 2) continue;
    if (end < Math.max(...near.map(([, e]) => e)) - SHORT * xHeight) short++;
    if (start > Math.min(...near.map(([s]) => s)) + SHORT * xHeight) late++;
  }
  return { up, down, lines, short, late };
}

// Upright Latin text leans about 0.5 to the up side (sticking up minus hanging down, over both).
// Lines running the other way and pictures lean less than about 0.25 either way.
const SURE_LEAN = 0.3;
// The lean must also hold over enough strokes that chance can't explain it: it is this many
// standard deviations from even, (up - down) / √(up + down).
const SURE_DEVIATIONS = 6;
// Lowercase text has an ascender or capital in nearly every word: more than one per line in a strip.
// Text in capitals sticks out only at stray marks (commas, Q), which don't show reliably which way is up.
const SURE_PER_LINE = 0.8;
// Strokes alone can't tell upright Cyrillic (or another script heavy in descenders) from
// upside-down Latin, so the line ends must agree: short ones must outnumber late ones on the side
// the strokes say is up by this many standard deviations, (short - late) / √(short + late).
const SURE_MARGINS = 1.5;

function lean({ up, down, lines, short, late }: ReturnType<typeof strokes>) {
  return {
    lean: (up - down) / (up + down || 1),
    deviations: (up - down) / Math.sqrt(up + down || 1),
    perLine: Math.max(up, down) / (lines || 1),
    margins: (short - late) / Math.sqrt(short + late || 1),
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
    Math.abs(a.deviations) >= SURE_DEVIATIONS &&
    a.perLine >= SURE_PER_LINE &&
    a.margins * Math.sign(a.lean) >= SURE_MARGINS &&
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
  const bytes = turned.encodeToBytes(ImageFormat.JPEG, 90);
  for (const o of [surface, turned]) o.dispose();
  // Native Skia returns null when encoding fails, whatever the type says.
  if (!bytes?.length) throw new Error('could not encode page');

  // Swapping in a finished file means a crash mid-write can't leave a broken page.
  const tmp = new File(`${uri}.tmp`);
  await tmp.write(bytes);
  await tmp.move(new File(uri), { overwrite: true });
}

/** Turns the stored page JPEG at `uri` clockwise by `quarterTurns` × 90°, replacing it. */
export async function rotatePage(uri: string, quarterTurns: number): Promise<void> {
  const turns = ((quarterTurns % 4) + 4) % 4;
  if (!turns) return;
  const image = await decode(uri);
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
      const image = await decode(uri);
      try {
        const turns = quarterTurnsToUpright(image);
        if (turns) await storeTurned(image, turns, uri);
      } finally {
        image.dispose();
      }
    } catch {}
  }
}
