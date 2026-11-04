/**
 * @jest-environment @shopify/react-native-skia/jestEnv.js
 */
/// <reference types="jest" />
import { ImageFormat, Skia, type SkCanvas, type SkPaint } from '@shopify/react-native-skia';

import { cropPage, findPage, type Quad } from './crop';

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
  }
  return { File };
});

beforeEach(() => mockFiles.clear());

const W = 900;
const H = 1200;

// A phone photo of a tilted page lying on a surface, with lines of text on it.
function photo(page: Quad, background: string, paper = 'rgb(238,234,222)'): Uint8Array {
  const surface = Skia.Surface.Make(W, H)!;
  const canvas = surface.getCanvas();
  canvas.drawColor(Skia.Color(background));
  // Grain on the surface, so it is not one flat colour.
  const grain = Skia.Paint();
  grain.setColor(Skia.Color('rgba(0,0,0,0.08)'));
  for (let y = 0; y < H; y += 7) canvas.drawRect(Skia.XYWHRect(0, y, W, 2), grain);
  const path = Skia.Path.Polygon(page, true);
  const fill = Skia.Paint();
  fill.setColor(Skia.Color(paper));
  canvas.drawPath(path, fill);
  const ink = Skia.Paint();
  ink.setColor(Skia.Color('rgb(30,30,35)'));
  canvas.save();
  canvas.clipPath(path, 1, true);
  for (let y = 250; y < 1000; y += 40) canvas.drawRect(Skia.XYWHRect(200, y, 500, 10), ink);
  canvas.restore();
  return surface.makeImageSnapshot().encodeToBytes(ImageFormat.JPEG, 92);
}

const tilted: Quad = [
  { x: 170, y: 140 },
  { x: 760, y: 200 },
  { x: 720, y: 1080 },
  { x: 110, y: 1010 },
];

const wholePhoto: Quad = [
  { x: 0, y: 0 },
  { x: W, y: 0 },
  { x: W, y: H },
  { x: 0, y: H },
];

function expectNear(found: Quad, truth: Quad, tolerance: number) {
  found.forEach((p, i) => {
    expect(Math.abs(p.x - truth[i].x)).toBeLessThan(tolerance);
    expect(Math.abs(p.y - truth[i].y)).toBeLessThan(tolerance);
  });
}

it('finds the corners of a tilted page on a dark desk, in photo pixels, clockwise from top-left', async () => {
  mockFiles.set('file:///cache/photo.jpg', photo(tilted, 'rgb(92,70,52)'));

  const found = await findPage('file:///cache/photo.jpg');

  expect(found.width).toBe(W);
  expect(found.height).toBe(H);
  expectNear(found.corners, tilted, 20);
}, 30000);

it('finds a white page on a light grey table', async () => {
  mockFiles.set('file:///cache/photo.jpg', photo(tilted, 'rgb(175,175,170)'));

  expectNear((await findPage('file:///cache/photo.jpg')).corners, tilted, 20);
}, 30000);

it('finds a page that fills nearly the whole photo', async () => {
  const close: Quad = [
    { x: 22, y: 1 },
    { x: 899, y: 20 },
    { x: 880, y: 1199 },
    { x: 1, y: 1180 },
  ];
  mockFiles.set('file:///cache/photo.jpg', photo(close, 'rgb(92,70,52)'));

  expectNear((await findPage('file:///cache/photo.jpg')).corners, close, 15);
}, 30000);

it('falls back to the whole photo when there is no page to find', async () => {
  const surface = Skia.Surface.Make(W, H)!;
  surface.getCanvas().drawColor(Skia.Color('rgb(120,120,120)'));
  mockFiles.set('file:///cache/photo.jpg', surface.makeImageSnapshot().encodeToBytes(ImageFormat.JPEG, 92));

  expectNear((await findPage('file:///cache/photo.jpg')).corners, wholePhoto, 1);
}, 30000);

// Shapes drawn on a dark desk.
function shapes(draw: (canvas: SkCanvas, paint: SkPaint) => void): Uint8Array {
  const surface = Skia.Surface.Make(W, H)!;
  const canvas = surface.getCanvas();
  canvas.drawColor(Skia.Color('rgb(60,50,40)'));
  draw(canvas, Skia.Paint());
  return surface.makeImageSnapshot().encodeToBytes(ImageFormat.JPEG, 92);
}

it('does not take a patch of glare for the page', async () => {
  mockFiles.set(
    'file:///cache/photo.jpg',
    shapes((canvas, paint) => {
      paint.setColor(Skia.Color('rgb(128,128,128)'));
      canvas.drawRect(Skia.XYWHRect(100, 100, 700, 1000), paint);
      paint.setColor(Skia.Color('rgb(250,250,250)'));
      canvas.drawOval(Skia.XYWHRect(150, 150, 600, 800), paint);
    }),
  );

  const { corners } = await findPage('file:///cache/photo.jpg');

  expect(corners[0].x).toBeLessThan(140);
  expect(corners[2].y).toBeGreaterThan(1060);
}, 30000);

it('falls back to the whole photo for a page turned so far its corners are ambiguous', async () => {
  mockFiles.set(
    'file:///cache/photo.jpg',
    shapes((canvas, paint) => {
      paint.setColor(Skia.Color('rgb(238,234,222)'));
      canvas.drawPath(Skia.Path.Polygon([{ x: 450, y: 150 }, { x: 800, y: 500 }, { x: 450, y: 850 }, { x: 100, y: 500 }], true), paint);
    }),
  );

  expectNear((await findPage('file:///cache/photo.jpg')).corners, wholePhoto, 1);
}, 30000);

it('falls back to the whole photo for a bright shape that does not fill its outline', async () => {
  mockFiles.set(
    'file:///cache/photo.jpg',
    shapes((canvas, paint) => {
      paint.setColor(Skia.Color('rgb(238,234,222)'));
      canvas.drawRect(Skia.XYWHRect(100, 100, 700, 150), paint);
      canvas.drawRect(Skia.XYWHRect(100, 100, 150, 1000), paint);
    }),
  );

  expectNear((await findPage('file:///cache/photo.jpg')).corners, wholePhoto, 1);
}, 30000);

function pixel(bytes: Uint8Array, x: number, y: number): number[] {
  const image = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(bytes))!;
  return [...(image.readPixels(x, y, { width: 1, height: 1, colorType: 4, alphaType: 3 }) as Uint8Array).slice(0, 3)];
}

it('straightens the page inside the corners into an upright page as wide and tall as its longest sides', async () => {
  // A red mark by the page's top-left corner and a blue one by its bottom-right.
  const surface = Skia.Surface.Make(W, H)!;
  const canvas = surface.getCanvas();
  canvas.drawColor(Skia.Color('rgb(92,70,52)'));
  const paint = Skia.Paint();
  paint.setColor(Skia.Color('white'));
  canvas.drawPath(Skia.Path.Polygon(tilted, true), paint);
  paint.setColor(Skia.Color('red'));
  canvas.drawCircle(220, 200, 25, paint);
  paint.setColor(Skia.Color('blue'));
  canvas.drawCircle(680, 1020, 25, paint);
  mockFiles.set('file:///cache/photo.jpg', surface.makeImageSnapshot().encodeToBytes(ImageFormat.JPEG, 95));

  await cropPage('file:///cache/photo.jpg', tilted, 'file:///cache/page.jpg');

  const page = mockFiles.get('file:///cache/page.jpg')!;
  const image = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(page))!;
  const bottom = Math.hypot(720 - 110, 1080 - 1010);
  const right = Math.hypot(760 - 720, 200 - 1080);
  expect(image.width()).toBe(Math.round(bottom));
  expect(image.height()).toBe(Math.round(right));
  const [r1, g1, b1] = pixel(page, 50, 60);
  expect(r1).toBeGreaterThan(200);
  expect(g1 + b1).toBeLessThan(120);
  const [r2, , b2] = pixel(page, image.width() - 50, image.height() - 60);
  expect(b2).toBeGreaterThan(200);
  expect(r2).toBeLessThan(60);
  // The desk is cut away: the very corners are page white.
  for (const [x, y] of [[3, 3], [image.width() - 4, 3], [3, image.height() - 4], [image.width() - 4, image.height() - 4]]) {
    expect(Math.min(...pixel(page, x, y))).toBeGreaterThan(200);
  }
}, 30000);

it('rejects a photo it cannot read', async () => {
  mockFiles.set('file:///cache/photo.jpg', new Uint8Array([1, 2, 3]));

  await expect(findPage('file:///cache/photo.jpg')).rejects.toThrow();
});
