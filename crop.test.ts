/**
 * @jest-environment @shopify/react-native-skia/jestEnv.js
 */
/// <reference types="jest" />
import { BlurStyle, ImageFormat, Skia, type SkCanvas, type SkPaint } from '@shopify/react-native-skia';

import { cropPage, findPage, isConvex, type Quad } from './crop';

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
function photo(
  page: Quad,
  background: string,
  paper = 'rgb(238,234,222)',
  drawBeforePage?: (canvas: SkCanvas) => void,
  drawOnPage?: (canvas: SkCanvas) => void,
): Uint8Array {
  const surface = Skia.Surface.Make(W, H)!;
  const canvas = surface.getCanvas();
  canvas.drawColor(Skia.Color(background));
  // Grain on the surface, so it is not one flat colour.
  const grain = Skia.Paint();
  grain.setColor(Skia.Color('rgba(0,0,0,0.08)'));
  for (let y = 0; y < H; y += 7) canvas.drawRect(Skia.XYWHRect(0, y, W, 2), grain);
  drawBeforePage?.(canvas);
  const path = Skia.Path.Polygon(page, true);
  const fill = Skia.Paint();
  fill.setColor(Skia.Color(paper));
  canvas.drawPath(path, fill);
  const ink = Skia.Paint();
  ink.setColor(Skia.Color('rgb(30,30,35)'));
  canvas.save();
  canvas.clipPath(path, 1, true);
  for (let y = 250; y < 1000; y += 40) canvas.drawRect(Skia.XYWHRect(200, y, 500, 10), ink);
  drawOnPage?.(canvas);
  canvas.restore();
  const snapshot = surface.makeImageSnapshot();
  const bytes = snapshot.encodeToBytes(ImageFormat.JPEG, 92);
  for (const o of [snapshot, surface, path, grain, fill, ink]) o.dispose();
  return bytes;
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

// A ruled notebook page in a 3024 x 4032 photo: dense rules must not crowd out the page's outer edges.
it('finds a ruled page in a 3024 x 4032 photo', async () => {
  const big: Quad = [
    { x: 560, y: 470 },
    { x: 2530, y: 670 },
    { x: 2400, y: 3600 },
    { x: 370, y: 3370 },
  ];
  const surface = Skia.Surface.Make(3024, 4032)!;
  const canvas = surface.getCanvas();
  canvas.drawColor(Skia.Color('rgb(92,70,52)'));
  const path = Skia.Path.Polygon(big, true);
  const paint = Skia.Paint();
  paint.setColor(Skia.Color('rgb(238,234,222)'));
  canvas.drawPath(path, paint);
  paint.setColor(Skia.Color('rgb(60,70,140)'));
  paint.setAntiAlias(false);
  canvas.save();
  canvas.clipPath(path, 1, true);
  for (let y = 700; y < 3500; y += 40) canvas.drawRect(Skia.XYWHRect(0, y, 3024, 3), paint);
  canvas.restore();
  const snapshot = surface.makeImageSnapshot();
  mockFiles.set('file:///cache/photo.jpg', snapshot.encodeToBytes(ImageFormat.JPEG, 92));
  for (const o of [snapshot, surface, path, paint]) o.dispose();

  // Measured: the corners are within 13 px with the mipmapped copy, but 1566 px off with the old draw.
  expectNear((await findPage('file:///cache/photo.jpg')).corners, big, 40);
}, 60000);

it('finds a white page on a light grey table', async () => {
  mockFiles.set('file:///cache/photo.jpg', photo(tilted, 'rgb(175,175,170)'));

  expectNear((await findPage('file:///cache/photo.jpg')).corners, tilted, 20);
}, 30000);

it('finds a white page on a pale table when a bright glare patch touches the page', async () => {
  mockFiles.set(
    'file:///cache/photo.jpg',
    photo(tilted, 'rgb(180,185,195)', 'rgb(232,229,224)', (canvas) => {
      const glare = Skia.Paint();
      const blur = Skia.MaskFilter.MakeBlur(BlurStyle.Normal, 40, true);
      glare.setColor(Skia.Color('rgb(252,252,255)'));
      glare.setMaskFilter(blur);
      canvas.drawOval(Skia.XYWHRect(480, 620, 400, 560), glare);
      for (const o of [glare, blur]) o.dispose();
    }),
  );

  expectNear((await findPage('file:///cache/photo.jpg')).corners, tilted, 20);
}, 30000);

it('clamps found corners to the photo bounds when an intersection lies just outside', async () => {
  const clipped: Quad = [
    { x: 150, y: -15 },
    { x: 750, y: 120 },
    { x: 700, y: 1050 },
    { x: 100, y: 950 },
  ];
  mockFiles.set('file:///cache/photo.jpg', photo(clipped, 'rgb(92,70,52)'));

  const { corners } = await findPage('file:///cache/photo.jpg');

  for (const p of corners) {
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x).toBeLessThanOrEqual(W);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeLessThanOrEqual(H);
  }
  expectNear(corners, [{ x: 150, y: 0 }, clipped[1], clipped[2], clipped[3]], 20);
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

const upright: Quad = [
  { x: 150, y: 150 },
  { x: 750, y: 150 },
  { x: 750, y: 1050 },
  { x: 150, y: 1050 },
];

// A dark band across the page's whole width, `top` and `depth` in shares of the page's height.
function bandAcross(page: Quad, top: number, depth: number) {
  const [tl, tr, br, bl] = page;
  const at = (a: { x: number; y: number }, b: { x: number; y: number }, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  return (canvas: SkCanvas) => {
    const band = Skia.Path.Polygon([at(tl, bl, top), at(tr, br, top), at(tr, br, top + depth), at(tl, bl, top + depth)], true);
    const paint = Skia.Paint();
    paint.setColor(Skia.Color('rgb(25,25,30)'));
    canvas.drawPath(band, paint);
    for (const o of [band, paint]) o.dispose();
  };
}

// Before #84 the frame ended at the band's edge, cutting the rest of the page off.
describe.each([
  ['upright', upright],
  ['tilted', tilted],
] as const)('a dark band across the %s page', (_, page) => {
  it.each([0.2, 0.5, 0.85].flatMap((top) => [0.05, 0.08, 0.12].map((depth) => [top, depth])))(
    'at %f down, %f of the page deep, gives the whole page or the whole photo',
    async (top, depth) => {
      mockFiles.set('file:///cache/photo.jpg', photo(page, 'rgb(92,70,52)', undefined, undefined, bandAcross(page, top, depth)));

      const { corners } = await findPage('file:///cache/photo.jpg');

      const off = (truth: Quad) => Math.max(...corners.map((p, i) => Math.hypot(p.x - truth[i].x, p.y - truth[i].y)));
      expect(Math.min(off(page), off(wholePhoto))).toBeLessThan(20);
    },
    30000,
  );
});

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

it('tells a page outline from corners dragged past each other', () => {
  expect(isConvex(tilted)).toBe(true);
  expect(isConvex([tilted[1], tilted[0], tilted[2], tilted[3]])).toBe(false);
  expect(isConvex([tilted[0], tilted[1], { x: 300, y: 300 }, tilted[3]])).toBe(false);
});
