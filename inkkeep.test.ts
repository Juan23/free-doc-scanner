/**
 * @jest-environment @shopify/react-native-skia/jestEnv.js
 */
/// <reference types="jest" />
import { AlphaType, ColorType, Skia, type SkImage } from '@shopify/react-native-skia';
import { cropPage, findPage } from './crop';

/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs') as {
  readdirSync: (p: string) => string[];
  appendFileSync: (p: string, data: string) => void;
};
const path = require('path') as {
  join: (...parts: string[]) => string;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const mockFiles = new Map<string, Uint8Array>();

jest.mock('@shopify/react-native-skia', () =>
  jest.requireActual('@shopify/react-native-skia/lib/module/mock').Mock((globalThis as any).CanvasKit),
);

jest.mock('expo-file-system', () => {
  class File {
    uri: string;
    constructor(...parts: any[]) {
      this.uri = parts.map((p) => p.uri ?? p).join('/');
    }
    get exists() {
      return mockFiles.has(this.uri);
    }
    async bytes() {
      const b = mockFiles.get(this.uri);
      if (b) return b;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return new Uint8Array(require('fs').readFileSync(this.uri));
    }
    async write(b: Uint8Array) {
      mockFiles.set(this.uri, b);
    }
    writeSync(text: string) {
      mockFiles.set(this.uri, Uint8Array.from(text, (c) => c.charCodeAt(0)));
    }
    textSync() {
      return String.fromCharCode(...mockFiles.get(this.uri)!);
    }
  }
  return { File, Paths: { document: { uri: 'file:///doc' } } };
});

type Filter = { kind: 'original' | 'clean' | 'gray'; strength: number };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { filterImage } = require(process.env.CLEAN ?? './clean') as {
  filterImage: (image: SkImage, filter: Filter, width?: number) => SkImage;
};

const DOCUNET_DIR = process.env.DOCUNET;

function readLuma(image: SkImage): Uint8Array {
  const w = image.width();
  const h = image.height();
  const rgba = image.readPixels(0, 0, {
    width: w,
    height: h,
    colorType: ColorType.RGBA_8888,
    alphaType: AlphaType.Unpremul,
  }) as Uint8Array;
  const luma = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < luma.length; i++, j += 4) {
    luma[i] = Math.round(0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]);
  }
  return luma;
}

const BLOCK = 32;
const BORDER = 0.05;

/** Contrast c = local paper level - luma; paper is each 32 px block's 90th-percentile luma, 3x3-smoothed and sampled bilinearly. */
function contrastMap(luma: Uint8Array, w: number, h: number): Float32Array {
  const bw = Math.ceil(w / BLOCK);
  const bh = Math.ceil(h / BLOCK);
  const raw = new Float32Array(bw * bh);
  const hist = new Int32Array(256);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      hist.fill(0);
      let count = 0;
      for (let y = by * BLOCK; y < Math.min(h, (by + 1) * BLOCK); y++) {
        for (let x = bx * BLOCK; x < Math.min(w, (bx + 1) * BLOCK); x++, count++) hist[luma[y * w + x]]++;
      }
      let acc = 0;
      let v = 0;
      while (v < 255 && (acc += hist[v]) < Math.ceil(0.9 * count)) v++;
      raw[by * bw + bx] = v;
    }
  }
  const at = (g: Float32Array, x: number, y: number) =>
    g[Math.max(0, Math.min(bh - 1, y)) * bw + Math.max(0, Math.min(bw - 1, x))];
  const grid = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += at(raw, bx + dx, by + dy);
      grid[by * bw + bx] = sum / 9;
    }
  }
  const c = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.max(0, Math.min(bh - 1, (y + 0.5) / BLOCK - 0.5));
    const y0 = Math.floor(fy);
    for (let x = 0; x < w; x++) {
      const fx = Math.max(0, Math.min(bw - 1, (x + 0.5) / BLOCK - 0.5));
      const x0 = Math.floor(fx);
      const top = at(grid, x0, y0) * (1 - (fx - x0)) + at(grid, x0 + 1, y0) * (fx - x0);
      const bottom = at(grid, x0, y0 + 1) * (1 - (fx - x0)) + at(grid, x0 + 1, y0 + 1) * (fx - x0);
      c[y * w + x] = top * (1 - (fy - y0)) + bottom * (fy - y0) - luma[y * w + x];
    }
  }
  return c;
}

/** True when a paper pixel (c < 8) lies within 5 px on both sides along `step`. */
function paperBothSides(c: Float32Array, idx: number, step: number, room: [number, number]): boolean {
  const side = (dir: number, max: number) => {
    for (let d = 1; d <= Math.min(5, max); d++) if (c[idx + dir * d * step] < 8) return true;
    return false;
  };
  return side(-1, room[0]) && side(1, room[1]);
}

function inputMasks(cIn: Float32Array, w: number, h: number) {
  const x0 = Math.floor(w * BORDER);
  const x1 = Math.ceil(w * (1 - BORDER));
  const y0 = Math.floor(h * BORDER);
  const y1 = Math.ceil(h * (1 - BORDER));
  const stroke = new Uint8Array(w * h);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      if (
        cIn[i] >= 20 &&
        (paperBothSides(cIn, i, 1, [x, w - 1 - x]) || paperBothSides(cIn, i, w, [y, h - 1 - y]))
      ) {
        stroke[i] = 1;
      }
    }
  }
  // Separable 11x11 dilation: the pixels within 5 px of a stroke pixel.
  const near = new Uint8Array(w * h);
  const rows = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (stroke[y * w + x]) rows.fill(1, y * w + Math.max(0, x - 5), y * w + Math.min(w, x + 6));
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rows[y * w + x]) for (let k = Math.max(0, y - 5); k <= Math.min(h - 1, y + 5); k++) near[k * w + x] = 1;
    }
  }
  return { x0, x1, y0, y1, stroke, near };
}

function measure(cIn: Float32Array, m: ReturnType<typeof inputMasks>, lumaOut: Uint8Array, w: number, h: number) {
  const cOut = contrastMap(lumaOut, w, h);
  const n = { pale: 0, paleKept: 0, dark: 0, darkKept: 0, paper: 0, paperClean: 0 };
  for (let y = m.y0; y < m.y1; y++) {
    for (let x = m.x0; x < m.x1; x++) {
      const i = y * w + x;
      if (m.stroke[i]) {
        const kept = cOut[i] >= 15 ? 1 : 0;
        if (cIn[i] < 60) {
          n.pale++;
          n.paleKept += kept;
        } else {
          n.dark++;
          n.darkKept += kept;
        }
      } else if (cIn[i] < 8 && !m.near[i]) {
        n.paper++;
        if (lumaOut[i] >= 235) n.paperClean++;
      }
    }
  }
  const pct = (a: number, b: number) => ((a / (b || 1)) * 100).toFixed(1);
  return [n.pale, pct(n.paleKept, n.pale), n.dark, pct(n.darkKept, n.dark), pct(n.paperClean, n.paper)];
}

/** Files whose index mod n is i-1, for SHARD="i/n". */
function selectShard(files: string[], shard?: string): string[] {
  if (!shard) return files;
  const [i, n] = shard.split('/').map(Number);
  if (!(i >= 1 && i <= n)) throw new Error(`Invalid SHARD "${shard}", expected "i/n"`);
  return files.filter((_, idx) => idx % n === i - 1);
}

(DOCUNET_DIR ? describe : describe.skip)('ink-keep check on real photos', () => {
  it('measures Clean strength 1 and 2', async () => {
    const allFiles = fs
      .readdirSync(DOCUNET_DIR!)
      .filter((f) => /\.(jpe?g|png)$/i.test(f))
      .sort();
    const files = selectShard(allFiles, process.env.SHARD);
    const outPath = process.env.OUT;

    for (const file of files) {
      const filePath = path.join(DOCUNET_DIR!, file);
      const found = await findPage(filePath);
      const memKey = `mem://${file}.jpg`;
      await cropPage(filePath, found.corners, memKey);
      const pageBytes = mockFiles.get(memKey)!;
      mockFiles.delete(memKey);

      const data = Skia.Data.fromBytes(pageBytes);
      const page = Skia.Image.MakeImageFromEncoded(data)!;
      data.dispose();

      try {
        const w = page.width();
        const h = page.height();
        const lumaIn = readLuma(page);
        const cIn = contrastMap(lumaIn, w, h);
        const masks = inputMasks(cIn, w, h);

        for (const strength of [1, 2]) {
          const t0 = performance.now();
          const out = filterImage(page, { kind: 'clean', strength });
          const ms = Math.round(performance.now() - t0);
          try {
            const lumaOut = readLuma(out);
            const r = measure(cIn, masks, lumaOut, w, h);
            const line = [file, strength, ...r, ms].join('\t');
            if (outPath) {
              fs.appendFileSync(outPath, line + '\n');
            } else {
              console.log(line);
            }
          } finally {
            out.dispose();
          }
        }
      } finally {
        page.dispose();
      }
    }
  }, 600000);
});
