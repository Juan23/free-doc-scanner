/**
 * @jest-environment @shopify/react-native-skia/jestEnv.js
 */
/// <reference types="jest" />
import { Skia } from '@shopify/react-native-skia';

import { cropPage, findPage } from './crop';
import * as uprightModule from './upright';
import { turnedImage, type readUpright } from './upright';

// Scores auto-upright on real photos, cropped as the app does, unturned, and turned by 0, 90, 180 and 270 degrees
// (DOCUNET=<photo folder> [FIRST=1 LAST=15] [OUT=<file>]). One tab-separated line per photo and turn:
// file, turn, result (upright, left, wrong), the gates the right reading fails, then that reading's
// lean, deviations, strokes per line, balance, stops and script flag. It fails when an upright page is
// turned or a turned page is put the wrong way up, and on photos 1 to 15 or 16 to 65 when fewer than
// MIN_UPRIGHT of the turned copies come back upright.

/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs') as {
  appendFileSync: (p: string, data: string) => void;
  existsSync: (p: string) => boolean;
  readFileSync: (p: string) => Uint8Array;
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
const SCANS_DIR = process.env.SCANS;
const FIRST = Number(process.env.FIRST ?? 1);
const LAST = Number(process.env.LAST ?? 15);
// Upright copies of the 90 turned copies of photos 1_1 to 15_2, and of the 300 of 16_1 to 65_2.
const MIN_UPRIGHT: Record<string, number> = { '1-15': 15, '16-65': 115 };
// Upright copies of the 192 turned copies of the scans.
const MIN_UPRIGHT_SCANS = 128;

(DOCUNET_DIR ? describe : describe.skip)('auto-upright on real photos', () => {
  it('turns no upright page and puts no turned page the wrong way up', async () => {
    const outPath = process.env.OUT;
    let upright = 0;
    let left = 0;
    const wrong: string[] = [];
    const realRead = uprightModule.readUpright;

    for (let n = FIRST; n <= LAST; n++) {
      for (const side of [1, 2]) {
        const file = `${n}_${side}.jpg`;
        const filePath = path.join(DOCUNET_DIR!, file);
        if (!fs.existsSync(filePath)) continue;
        const found = await findPage(filePath);
        const readings: ReturnType<typeof readUpright>[] = [];
        // Reads the page cropPage hands to readUpright, before its encode, at each turn.
        const spy = jest.spyOn(uprightModule, 'readUpright').mockImplementationOnce((page) => {
          for (const turn of [0, 1, 2, 3]) {
            const copy = turn ? turnedImage(page, turn) : page;
            readings.push(realRead(copy));
            if (turn) copy.dispose();
          }
          return readings[0];
        });
        await cropPage(filePath, found.corners, `mem://${file}`);
        spy.mockRestore();
        expect(readings).toHaveLength(4);
        mockFiles.delete(`mem://${file}`);

        readings.forEach((read, turn) => {
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
        });
      }
    }
    if (outPath) fs.appendFileSync(outPath, `# upright ${upright}, left ${left}, wrong ${wrong.length}\n`);
    expect(wrong).toEqual([]);
    const floor = MIN_UPRIGHT[`${FIRST}-${LAST}`];
    if (floor !== undefined) expect(upright).toBeGreaterThanOrEqual(floor);
  }, 1_800_000);
});

// The same score on the flat DocUNet scans (SCANS=<docunet-scan folder> [OUT=<file>]), read whole at 0, 90,
// 180 and 270 degrees, with the milliseconds each reading took. 64.png (sheet music) is left out, as in the
// count of #109. It fails as above, or when fewer than MIN_UPRIGHT_SCANS come back.
(SCANS_DIR ? describe : describe.skip)('auto-upright on flat scans', () => {
  it('turns no upright scan and puts no turned scan the wrong way up', () => {
    const outPath = process.env.OUT;
    let upright = 0;
    const wrong: string[] = [];
    const times: number[] = [];
    for (let n = 1; n <= 65; n++) {
      const file = `${n}.png`;
      const filePath = path.join(SCANS_DIR!, file);
      if (n === 64 || !fs.existsSync(filePath)) continue;
      const image = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(new Uint8Array(fs.readFileSync(filePath))))!;
      for (const turn of [0, 1, 2, 3]) {
        const copy = turn ? turnedImage(image, turn) : image;
        const start = performance.now();
        const read = uprightModule.readUpright(copy);
        const ms = performance.now() - start;
        times.push(ms);
        if (turn) copy.dispose();
        const needed = (4 - turn) % 4;
        const result = read.turns === needed ? (turn ? 'upright' : 'left') : read.turns === 0 ? 'left' : 'wrong';
        if (turn && result === 'upright') upright++;
        if (result === 'wrong') wrong.push(`${file} turned ${turn * 90}`);
        const failed = needed % 2 ? read.failedTurned : read.failedAsIs;
        if (outPath) fs.appendFileSync(outPath, [file, turn * 90, result, failed.join(',') || '-', Math.round(ms)].join('\t') + '\n');
      }
      image.dispose();
    }
    times.sort((a, b) => a - b);
    if (outPath) fs.appendFileSync(outPath, `# upright ${upright}, wrong ${wrong.length}, median ${Math.round(times[times.length >> 1])} ms, slowest ${Math.round(times[times.length - 1])} ms\n`);
    expect(wrong).toEqual([]);
    expect(upright).toBeGreaterThanOrEqual(MIN_UPRIGHT_SCANS);
  }, 1_800_000);
});
