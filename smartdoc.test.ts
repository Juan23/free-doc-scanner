/**
 * @jest-environment @shopify/react-native-skia/jestEnv.js
 */
/// <reference types="jest" />
import { findPage, pageAspect, type Point, type Quad } from './crop';

/* eslint-disable @typescript-eslint/no-require-imports */
const { execFileSync } = require('child_process') as {
  execFileSync: (file: string, args: string[]) => Uint8Array;
};
const fs = require('fs') as {
  readFileSync: (p: string, enc: string) => string;
  readdirSync: (p: string) => string[];
  mkdtempSync: (prefix: string) => string;
  rmSync: (p: string, opts: { recursive: boolean; force: boolean }) => void;
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

const SMARTDOC_SAMPLE_DIR = process.env.SMARTDOC;
const FRAME_STEP = 5;
const VIDEOS = ['datasheet001', 'letter001', 'magazine001'];
// SmartDoc's frames are 1920 x 1080 and its pages A4.
const FRAME_WIDTH = 1920;
const FRAME_HEIGHT = 1080;
const A4_ASPECT = 210 / 297;

/** How far `aspect` (width over height) is from A4, as a share of A4. */
const a4Error = (aspect: number) => Math.abs(aspect - A4_ASPECT) / A4_ASPECT;

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

let framesDir = '';
afterAll(() => {
  if (framesDir) fs.rmSync(framesDir, { recursive: true, force: true });
});

(SMARTDOC_SAMPLE_DIR ? it : it.skip)('measures findPage on SmartDoc background00 frames', async () => {
  const videos = VIDEOS;
  const vidDir = path.join(SMARTDOC_SAMPLE_DIR!, 'input_sample', 'background00');
  const gtDir = path.join(SMARTDOC_SAMPLE_DIR!, 'input_sample_groundtruth', 'background00_gt');
  framesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartdoc-frames-'));

  const allErrors: number[] = [];
  let totalFrames = 0;
  let totalOutlines = 0;
  let totalWithin2 = 0;
  let totalWithin5 = 0;
  let totalMs = 0;
  let aspectWithin5 = 0;
  let aspectWithin8 = 0;

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
      if (!isWhole(res.corners, res.width, res.height)) {
        outlines++;
        const off = a4Error(pageAspect(res.corners, res.width, res.height));
        if (off <= 0.05) aspectWithin5++;
        if (off <= 0.08) aspectWithin8++;
      }
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

  console.log(`page shape on found outlines: <=5% of A4=${aspectWithin5}/${totalOutlines}, <=8%=${aspectWithin8}/${totalOutlines}`);

  expect(totalWithin5 / totalFrames).toBeGreaterThanOrEqual(0.95);
}, 120000);

(SMARTDOC_SAMPLE_DIR ? it : it.skip)('reads an A4 shape from the true corners of SmartDoc background00 frames', () => {
  const gtDir = path.join(SMARTDOC_SAMPLE_DIR!, 'input_sample_groundtruth', 'background00_gt');
  const quads = VIDEOS.flatMap((vid) => [...parseGt(path.join(gtDir, `${vid}.gt.xml`)).values()]);
  const errors = quads.map((q) => a4Error(pageAspect(q, FRAME_WIDTH, FRAME_HEIGHT)));
  const within2 = errors.filter((e) => e <= 0.02).length;
  const within5 = errors.filter((e) => e <= 0.05).length;
  console.log(`page shape on true corners: <=2% of A4=${within2}/${quads.length}, <=5%=${within5}/${quads.length}`);
  expect(quads.length).toBe(588);
  // Within 5% holds with any focal clamp from 1.1 times up; within 2% drops without the clamp (349) or at 1.4 times (350).
  expect(within2).toBeGreaterThanOrEqual(367);
  expect(within5).toBeGreaterThanOrEqual(561);
});
