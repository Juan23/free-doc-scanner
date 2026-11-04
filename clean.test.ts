/**
 * @jest-environment @shopify/react-native-skia/jestEnv.js
 */
/// <reference types="jest" />
import { ImageFormat, Skia } from '@shopify/react-native-skia';

import { cleanPages } from './clean';

// Real Skia (CanvasKit) does the pixel work; only the files are in memory.
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
      if (!b) throw new Error('not found');
      return b;
    }
    async write(b: Uint8Array) {
      mockFiles.set(this.uri, b);
    }
    async move(dest: File, options?: { overwrite?: boolean }) {
      if (mockFiles.has(dest.uri) && !options?.overwrite) throw new Error('destination exists');
      mockFiles.set(dest.uri, mockFiles.get(this.uri)!);
      mockFiles.delete(this.uri);
    }
  }
  return { File };
});

beforeEach(() => mockFiles.clear());

// Wider than the copy the paper is estimated on, so that downscale is exercised.
const W = 600;
const H = 800;

// A phone photo of a page: warm paper that falls into shadow on the right, a line of ink with a
// faint stroke under it, a full stop, a faint speck and a faint crease.
function photographedPage(): Uint8Array {
  const surface = Skia.Surface.Make(W, H)!;
  const canvas = surface.getCanvas();
  const paper = Skia.Paint();
  for (let x = 0; x < W; x += 10) {
    const t = x / W;
    const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
    paper.setColor(Skia.Color(`rgb(${mix(235, 140)},${mix(228, 135)},${mix(210, 125)})`));
    canvas.drawRect(Skia.XYWHRect(x, 0, 10, H), paper);
  }
  const ink = Skia.Paint();
  ink.setColor(Skia.Color('rgb(35,35,40)'));
  canvas.drawRect(Skia.XYWHRect(60, 200, 480, 16), ink);
  const speck = Skia.Paint();
  speck.setColor(Skia.Color('rgba(0,0,0,0.12)'));
  canvas.drawRect(Skia.XYWHRect(120, 600, 8, 8), speck);
  canvas.drawRect(Skia.XYWHRect(300, 450, 6, 6), ink);
  const crease = Skia.Paint();
  crease.setColor(Skia.Color('rgba(0,0,0,0.35)'));
  canvas.drawRect(Skia.XYWHRect(40, 700, 520, 1), crease);
  canvas.drawRect(Skia.XYWHRect(60, 222, 480, 2), crease);
  return surface.makeImageSnapshot().encodeToBytes(ImageFormat.JPEG, 95);
}

function luma(bytes: Uint8Array, x: number, y: number): number {
  const image = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(bytes))!;
  const px = image.readPixels(x, y, { width: 1, height: 1, colorType: 4, alphaType: 3 }) as Uint8Array;
  return (px[0] + px[1] + px[2]) / 3;
}

it('turns shadowed, tinted paper, specks and creases white and keeps ink dark, in place', async () => {
  mockFiles.set('file:///doc/scans/1/p1.jpg', photographedPage());

  await cleanPages(['file:///doc/scans/1/p1.jpg']);

  expect([...mockFiles.keys()]).toEqual(['file:///doc/scans/1/p1.jpg']);
  const page = mockFiles.get('file:///doc/scans/1/p1.jpg')!;
  expect(luma(page, 30, 400)).toBeGreaterThan(245); // lit paper
  expect(luma(page, 570, 400)).toBeGreaterThan(245); // paper in shadow
  expect(luma(page, 124, 604)).toBeGreaterThan(245); // speck
  expect(luma(page, 300, 700)).toBeGreaterThan(245); // crease
  expect(luma(page, 80, 208)).toBeLessThan(50); // ink in the light
  expect(luma(page, 520, 208)).toBeLessThan(50); // ink in the shadow
  expect(luma(page, 303, 453)).toBeLessThan(80); // full stop
  expect(luma(page, 300, 223)).toBeLessThan(215); // faint stroke next to writing
}, 30000);

it('leaves a page it cannot read as it is, and cleans the rest', async () => {
  const broken = new Uint8Array([1, 2, 3]);
  mockFiles.set('file:///doc/scans/1/p1.jpg', broken);
  mockFiles.set('file:///doc/scans/1/p2.jpg', photographedPage());

  await cleanPages(['file:///doc/scans/1/p1.jpg', 'file:///doc/scans/1/p2.jpg']);

  expect(mockFiles.get('file:///doc/scans/1/p1.jpg')).toBe(broken);
  expect(luma(mockFiles.get('file:///doc/scans/1/p2.jpg')!, 30, 400)).toBeGreaterThan(245);
}, 30000);
