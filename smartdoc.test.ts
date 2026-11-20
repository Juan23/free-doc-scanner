/**
 * @jest-environment @shopify/react-native-skia/jestEnv.js
 */
/// <reference types="jest" />
import { findPage, type Point, type Quad } from './crop';

/* eslint-disable @typescript-eslint/no-require-imports */
const { execFileSync } = require('child_process') as {
  execFileSync: (file: string, args: string[]) => Uint8Array;
};
const fs = require('fs') as {
  readFileSync: (p: string, enc: string) => string;
  readdirSync: (p: string) => string[];
  mkdtempSync: (prefix: string) => string;
};
const os = require('os') as { tmpdir: () => string };
const path = require('path') as { join: (...parts: string[]) => string };
/* eslint-enable @typescript-eslint/no-require-imports */

jest.mock('@shopify/react-native-skia', () =>
  jest.requireActual('@shopify/react-native-skia/lib/module/mock').Mock((globalThis as any).CanvasKit),
);

jest.mock('expo-file-system', () => {
  class File {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    async bytes() {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return new Uint8Array(require('fs').readFileSync(this.uri));
    }
  }
  return { File };
});

// The SmartDoc sample folder; the test runs only when it is given.
const DATASET_DIR = process.env.SMARTDOC;
const FRAME_STEP = 5;

function parseGt(xmlPath: string): Map<number, Quad> {
  const xml = fs.readFileSync(xmlPath, 'utf8');
  const map = new Map<number, Quad>();
  const frameRe = /<frame index="(\d+)" rejected="([^"]+)">([\s\S]*?)<\/frame>/g;
  let m: RegExpExecArray | null;
  while ((m = frameRe.exec(xml))) {
    if (m[2] === 'true') continue;
    const idx = Number(m[1]);
    const pts: Record<string, Point> = {};
    const ptRe = /<point name="(bl|tl|tr|br)" x="([^"]+)" y="([^"]+)"\/>/g;
    let pm: RegExpExecArray | null;
    while ((pm = ptRe.exec(m[3]))) {
      pts[pm[1]] = { x: Number(pm[2]), y: Number(pm[3]) };
    }
    if (pts.tl && pts.tr && pts.br && pts.bl) {
      map.set(idx, [pts.tl, pts.tr, pts.br, pts.bl]);
    }
  }
  return map;
}

function isWhole(q: Quad, w: number, h: number): boolean {
  return (
    Math.abs(q[0].x) < 1 &&
    Math.abs(q[0].y) < 1 &&
    Math.abs(q[1].x - w) < 1 &&
    Math.abs(q[1].y) < 1 &&
    Math.abs(q[2].x - w) < 1 &&
    Math.abs(q[2].y - h) < 1 &&
    Math.abs(q[3].x) < 1 &&
    Math.abs(q[3].y - h) < 1
  );
}

function worstCornerPct(found: Quad, gt: Quad, diag: number): number {
  let worst = 0;
  for (let i = 0; i < 4; i++) {
    const d = Math.hypot(found[i].x - gt[i].x, found[i].y - gt[i].y);
    if (d > worst) worst = d;
  }
  return (worst / diag) * 100;
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

(DATASET_DIR ? it : it.skip)('measures findPage on SmartDoc background00 frames', async () => {
  const videos = ['datasheet001', 'letter001', 'magazine001'];
  const vidDir = path.join(DATASET_DIR!, 'input_sample', 'background00');
  const gtDir = path.join(DATASET_DIR!, 'input_sample_groundtruth', 'background00_gt');
  const framesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartdoc-frames-'));

  const allErrors: number[] = [];
  let totalFrames = 0;
  let totalOutlines = 0;
  let totalWithin2 = 0;
  let totalWithin5 = 0;
  let totalMs = 0;

  for (const vid of videos) {
    execFileSync('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-i',
      path.join(vidDir, `${vid}.avi`),
      '-vf',
      `select=not(mod(n\\,${FRAME_STEP}))`,
      '-fps_mode',
      'vfr',
      '-q:v',
      '2',
      path.join(framesDir, `${vid}_%04d.jpg`),
    ]);

    const gt = parseGt(path.join(gtDir, `${vid}.gt.xml`));
    const files = fs
      .readdirSync(framesDir)
      .filter((f) => f.startsWith(`${vid}_`) && f.endsWith('.jpg'))
      .sort();
    expect(files.length).toBe(Math.ceil(Math.max(...gt.keys()) / FRAME_STEP));
    const errors: number[] = [];
    let outlines = 0;
    let within2 = 0;
    let within5 = 0;

    for (let i = 0; i < files.length; i++) {
      const frameIdx = 1 + i * FRAME_STEP;
      const gtQuad = gt.get(frameIdx);
      if (!gtQuad) throw new Error(`Missing GT for ${vid} frame ${frameIdx}`);
      const filePath = path.join(framesDir, files[i]);
      const t0 = performance.now();
      const res = await findPage(filePath);
      totalMs += performance.now() - t0;

      const diag = Math.hypot(res.width, res.height);
      const err = worstCornerPct(res.corners, gtQuad, diag);
      errors.push(err);
      allErrors.push(err);
      if (!isWhole(res.corners, res.width, res.height)) outlines++;
      if (err <= 2) within2++;
      if (err <= 5) within5++;
    }

    totalFrames += files.length;
    totalOutlines += outlines;
    totalWithin2 += within2;
    totalWithin5 += within5;

    console.log(
      `${vid}: n=${files.length}, outline=${outlines}/${files.length} (${((outlines / files.length) * 100).toFixed(1)}%), median=${median(errors).toFixed(1)}%, <=2%=${within2}/${files.length} (${((within2 / files.length) * 100).toFixed(1)}%), <=5%=${within5}/${files.length} (${((within5 / files.length) * 100).toFixed(1)}%)`,
    );
  }

  console.log(
    `ALL: n=${totalFrames}, outline=${totalOutlines}/${totalFrames} (${((totalOutlines / totalFrames) * 100).toFixed(1)}%), median=${median(allErrors).toFixed(1)}%, <=2%=${totalWithin2}/${totalFrames} (${((totalWithin2 / totalFrames) * 100).toFixed(1)}%), <=5%=${totalWithin5}/${totalFrames} (${((totalWithin5 / totalFrames) * 100).toFixed(1)}%), avgMs=${(totalMs / totalFrames).toFixed(1)}ms`,
  );

  expect(totalWithin5 / totalFrames).toBeGreaterThanOrEqual(0.95);
}, 120000);
