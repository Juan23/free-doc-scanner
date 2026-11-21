/**
 * @jest-environment @shopify/react-native-skia/jestEnv.js
 */
/// <reference types="jest" />
import { Skia, type SkImage } from '@shopify/react-native-skia';
import { cropPage, findPage } from './crop';
import { readUpright } from './upright';

// Scores auto-upright on real photos, cropped as the app does and turned by 0, 90, 180 and 270 degrees
// (DOCUNET=<photo folder> [FIRST=1 LAST=15] [OUT=<file>] [CROPS=<folder>]). One tab-separated line per
// photo and turn: file, turn, result (upright, left, wrong), the gates the right reading fails, then
// that reading's lean, deviations, lines and balance. It fails when an upright page is turned or a
// turned page is put the wrong way up.

/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs') as {
  appendFileSync: (p: string, data: string) => void;
  writeFileSync: (p: string, data: Uint8Array) => void;
  existsSync: (p: string) => boolean;
};
const path = require('path') as { join: (...parts: string[]) => string };
/* eslint-enable @typescript-eslint/no-require-imports */

const mockFiles = new Map<string, Uint8Array>();

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
      const b = mockFiles.get(this.uri);
      if (b) return b;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return new Uint8Array(require('fs').readFileSync(this.uri));
    }
    async write(b: Uint8Array) {
      mockFiles.set(this.uri, b);
    }
  }
  return { File };
});

const DOCUNET_DIR = process.env.DOCUNET;
const FIRST = Number(process.env.FIRST ?? 1);
const LAST = Number(process.env.LAST ?? 15);

/** `image` turned clockwise by `turns` quarter turns. */
function turnedBy(image: SkImage, turns: number): SkImage {
  const w = image.width();
  const h = image.height();
  const [tw, th] = turns % 2 ? [h, w] : [w, h];
  const surface = Skia.Surface.Make(tw, th)!;
  const canvas = surface.getCanvas();
  canvas.translate(tw / 2, th / 2);
  canvas.rotate(turns * 90, 0, 0);
  canvas.drawImage(image, -w / 2, -h / 2);
  const out = surface.makeImageSnapshot();
  surface.dispose();
  return out;
}

(DOCUNET_DIR ? describe : describe.skip)('auto-upright on real photos', () => {
  it('turns no upright page and puts no turned page the wrong way up', async () => {
    const outPath = process.env.OUT;
    const cropsDir = process.env.CROPS;
    let upright = 0;
    let left = 0;
    const wrong: string[] = [];

    for (let n = FIRST; n <= LAST; n++) {
      for (const side of [1, 2]) {
        const file = `${n}_${side}.jpg`;
        const filePath = path.join(DOCUNET_DIR!, file);
        if (!fs.existsSync(filePath)) continue;
        const found = await findPage(filePath);
        const memKey = `mem://${file}`;
        await cropPage(filePath, found.corners, memKey);
        const bytes = mockFiles.get(memKey)!;
        mockFiles.delete(memKey);
        if (cropsDir) fs.writeFileSync(path.join(cropsDir, file), bytes);
        const data = Skia.Data.fromBytes(bytes);
        const page = Skia.Image.MakeImageFromEncoded(data)!;
        data.dispose();

        for (const turn of [0, 1, 2, 3]) {
          const copy = turn ? turnedBy(page, turn) : page;
          const read = readUpright(copy);
          if (turn) copy.dispose();
          // Turned by `turn`, the page needs 4 - turn more; text runs along the as-is reading when that is even.
          const needed = (4 - turn) % 4;
          const reading = needed % 2 ? 'turned' : 'asIs';
          const failed = reading === 'asIs' ? read.failedAsIs : read.failedTurned;
          const m = read[reading];
          const result = read.turns === needed ? (turn ? 'upright' : 'left') : read.turns === 0 ? 'left' : 'wrong';
          if (turn && result === 'upright') upright++;
          if (turn && result === 'left') left++;
          if (result === 'wrong') wrong.push(`${file} turned ${turn * 90}`);
          if (outPath) {
            fs.appendFileSync(
              outPath,
              [file, turn * 90, result, failed.join(',') || '-', m.lean.toFixed(2), m.deviations.toFixed(1), m.perLine.toFixed(2), m.balance.toFixed(2), m.stops.toFixed(1), m.script].join('\t') + '\n',
            );
          }
        }
        page.dispose();
      }
    }
    if (outPath) fs.appendFileSync(outPath, `# upright ${upright}, left ${left}, wrong ${wrong.length}\n`);
    expect(wrong).toEqual([]);
  }, 1_800_000);
});
