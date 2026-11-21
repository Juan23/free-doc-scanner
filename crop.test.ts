/**
 * @jest-environment @shopify/react-native-skia/jestEnv.js
 */
/// <reference types="jest" />
import { BlurStyle, ImageFormat, Skia, type SkCanvas, type SkPaint } from '@shopify/react-native-skia';

import { contains, cropPage, findPage, isConvex, stopsShort, type Quad } from './crop';

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

const isNear = (a: Quad, b: Quad, tol: number) =>
  a.every((p, i) => Math.abs(p.x - b[i].x) < tol && Math.abs(p.y - b[i].y) < tol);

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

it('finds a page with a dark picture matching the desk', async () => {
  const surface = Skia.Surface.Make(W, H)!;
  const canvas = surface.getCanvas();
  canvas.drawColor(Skia.Color('rgb(92,70,52)'));
  const path = Skia.Path.Polygon(tilted, true);
  const paint = Skia.Paint();
  paint.setColor(Skia.Color('rgb(238,234,222)'));
  canvas.drawPath(path, paint);
  canvas.save();
  canvas.clipPath(path, 1, true);
  paint.setColor(Skia.Color('rgb(88,72,56)'));
  canvas.drawRect(Skia.XYWHRect(240, 620, 360, 280), paint);
  canvas.restore();
  const snapshot = surface.makeImageSnapshot();
  mockFiles.set('file:///cache/photo.jpg', snapshot.encodeToBytes(ImageFormat.JPEG, 92));
  for (const o of [snapshot, surface, path, paint]) o.dispose();

  expectNear((await findPage('file:///cache/photo.jpg')).corners, tilted, 20);
}, 30000);

it('does not cut a page in two at a dark rule across it', async () => {
  const fullPage: Quad = [
    { x: 150, y: 100 },
    { x: 750, y: 100 },
    { x: 750, y: 1100 },
    { x: 150, y: 1100 },
  ];
  const surface = Skia.Surface.Make(W, H)!;
  const canvas = surface.getCanvas();
  canvas.drawColor(Skia.Color('rgb(92,70,52)'));
  const paint = Skia.Paint();
  paint.setColor(Skia.Color('rgb(238,234,222)'));
  canvas.drawRect(Skia.XYWHRect(150, 100, 600, 1000), paint);
  paint.setColor(Skia.Color('rgb(30,30,35)'));
  for (let y = 180; y < 760; y += 40) canvas.drawRect(Skia.XYWHRect(200, y, 500, 8), paint);
  paint.setColor(Skia.Color('rgb(40,40,45)'));
  canvas.drawRect(Skia.XYWHRect(150, 800, 600, 12), paint);
  paint.setColor(Skia.Color('rgb(30,30,35)'));
  for (let y = 860; y < 1060; y += 40) canvas.drawRect(Skia.XYWHRect(200, y, 500, 8), paint);
  const snapshot = surface.makeImageSnapshot();
  mockFiles.set('file:///cache/photo.jpg', snapshot.encodeToBytes(ImageFormat.JPEG, 92));
  for (const o of [snapshot, surface, paint]) o.dispose();

  const { corners } = await findPage('file:///cache/photo.jpg');
  expect(isNear(corners, fullPage, 20) || isNear(corners, wholePhoto, 1)).toBe(true);
}, 30000);

const TEXT_TOP = 0.08;
const TEXT_BOTTOM = 0.95;
const TEXT_STEP = 0.035;
const TEXT_HEIGHT = 0.008;
const TEXT_LEFT = 0.12;
const TEXT_RIGHT = 0.88;
const RULE_TOP = 0.75;
const RULE_GAP = 0.03;

function tiltedTextPage(rule?: { top: number; height: number; gap: number }): Uint8Array {
  const surface = Skia.Surface.Make(W, H)!;
  const canvas = surface.getCanvas();
  canvas.drawColor(Skia.Color('rgb(92,70,52)'));
  const paint = Skia.Paint();
  paint.setColor(Skia.Color('rgb(238,234,222)'));
  canvas.drawPath(Skia.Path.Polygon(tilted, true), paint);
  const lerp = (a: { x: number; y: number }, b: { x: number; y: number }, t: number) => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  });
  const band = (top: number, height: number, left: number, right: number, color: string) => {
    const a0 = lerp(tilted[0], tilted[3], top);
    const b0 = lerp(tilted[1], tilted[2], top);
    const a1 = lerp(tilted[0], tilted[3], top + height);
    const b1 = lerp(tilted[1], tilted[2], top + height);
    paint.setColor(Skia.Color(color));
    canvas.drawPath(
      Skia.Path.Polygon([lerp(a0, b0, left), lerp(a0, b0, right), lerp(a1, b1, right), lerp(a1, b1, left)], true),
      paint,
    );
  };
  for (let k = TEXT_TOP; k < TEXT_BOTTOM; k += TEXT_STEP) {
    if (rule && Math.abs(k - rule.top) <= rule.gap) continue;
    band(k, TEXT_HEIGHT, TEXT_LEFT, TEXT_RIGHT, 'rgb(30,30,35)');
  }
  if (rule) band(rule.top, rule.height, 0, 1, 'rgb(40,40,45)');
  const snapshot = surface.makeImageSnapshot();
  const bytes = snapshot.encodeToBytes(ImageFormat.JPEG, 92);
  for (const o of [snapshot, surface, paint]) o.dispose();
  return bytes;
}

it('does not cut a tilted page at its own dense dark text lines', async () => {
  mockFiles.set('file:///cache/photo.jpg', tiltedTextPage());

  const { corners } = await findPage('file:///cache/photo.jpg');
  expect(isNear(corners, tilted, 20) || isNear(corners, wholePhoto, 1)).toBe(true);
}, 30000);

// The thin rule fails a 4 to 6 px reach, the thick one a 4 to 8 px reach or a 50% paper share.
it.each([0.012, 0.02])('does not cut a tilted page at a dark rule %f high over dense text lines', async (height) => {
  mockFiles.set('file:///cache/photo.jpg', tiltedTextPage({ top: RULE_TOP, height, gap: RULE_GAP }));

  const { corners } = await findPage('file:///cache/photo.jpg');
  expect(isNear(corners, tilted, 20) || isNear(corners, wholePhoto, 1)).toBe(true);
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

// Top and bottom bow in and left and right bow out by 24 px, so no straight run of any side casts many Hough votes.
it('finds a small page whose edges are bent', async () => {
  const small: Quad = [
    { x: 330, y: 400 },
    { x: 600, y: 420 },
    { x: 580, y: 800 },
    { x: 310, y: 780 },
  ];
  const points: { x: number; y: number }[] = [];
  small.forEach((a, i) => {
    const b = small[(i + 1) % 4];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const bow = i % 2 ? 24 : -24;
    for (let k = 0; k < 20; k++) {
      const t = k / 20;
      const off = bow * t * (1 - t);
      points.push({ x: a.x + (b.x - a.x) * t + ((b.y - a.y) / length) * off, y: a.y + (b.y - a.y) * t - ((b.x - a.x) / length) * off });
    }
  });
  const surface = Skia.Surface.Make(W, H)!;
  const canvas = surface.getCanvas();
  canvas.drawColor(Skia.Color('rgb(92,70,52)'));
  const paint = Skia.Paint();
  paint.setColor(Skia.Color('rgb(238,234,222)'));
  canvas.drawPath(Skia.Path.Polygon(points, true), paint);
  mockFiles.set('file:///cache/photo.jpg', surface.makeImageSnapshot().encodeToBytes(ImageFormat.JPEG, 92));

  expectNear((await findPage('file:///cache/photo.jpg')).corners, small, 30);
}, 30000);

// Four drawn lines on one surface: strong edges along all four sides, but the same ground inside and out.
it('falls back to the whole photo for a frame of lines that encloses only ground', async () => {
  const ground = 'rgb(150,120,90)';
  const surface = Skia.Surface.Make(W, H)!;
  const canvas = surface.getCanvas();
  canvas.drawColor(Skia.Color(ground));
  const paint = Skia.Paint();
  paint.setColor(Skia.Color('rgb(40,30,20)'));
  paint.setStrokeWidth(4);
  const frame: Quad = [
    { x: 200, y: 250 },
    { x: 700, y: 280 },
    { x: 670, y: 950 },
    { x: 180, y: 900 },
  ];
  frame.forEach((a, i) => {
    const b = frame[(i + 1) % 4];
    canvas.drawLine(a.x, a.y, b.x, b.y, paint);
  });
  mockFiles.set('file:///cache/photo.jpg', surface.makeImageSnapshot().encodeToBytes(ImageFormat.JPEG, 92));

  expectNear((await findPage('file:///cache/photo.jpg')).corners, wholePhoto, 1);
}, 30000);

// A thick dark border covers the flood-fill edge cells, so seeding must step past them to reach the ground inside.
it('falls back to the whole photo for a thick dark border enclosing only ground', async () => {
  const surface = Skia.Surface.Make(W, H)!;
  const canvas = surface.getCanvas();
  canvas.drawColor(Skia.Color('rgb(150,120,90)'));
  const paint = Skia.Paint();
  paint.setColor(Skia.Color('rgb(30,20,10)'));
  canvas.drawRect(Skia.XYWHRect(196, 246, 508, 708), paint);
  paint.setColor(Skia.Color('rgb(150,120,90)'));
  canvas.drawRect(Skia.XYWHRect(220, 270, 460, 660), paint);
  mockFiles.set('file:///cache/photo.jpg', surface.makeImageSnapshot().encodeToBytes(ImageFormat.JPEG, 92));
  for (const o of [surface, paint]) o.dispose();

  expectNear((await findPage('file:///cache/photo.jpg')).corners, wholePhoto, 1);
}, 30000);

// An oval paper patch fills ~64% of the drawn frame, so ground is far over MAX_BACKGROUND_SHARE.
it('falls back to the whole photo when too much of the frame is ground', async () => {
  const surface = Skia.Surface.Make(W, H)!;
  const canvas = surface.getCanvas();
  canvas.drawColor(Skia.Color('rgb(150,120,90)'));
  const paint = Skia.Paint();
  paint.setColor(Skia.Color('rgb(238,234,222)'));
  canvas.drawOval(Skia.XYWHRect(225, 290, 450, 620), paint);
  paint.setColor(Skia.Color('rgb(40,30,20)'));
  paint.setStrokeWidth(4);
  const frame: Quad = [
    { x: 200, y: 260 },
    { x: 700, y: 260 },
    { x: 700, y: 940 },
    { x: 200, y: 940 },
  ];
  frame.forEach((a, i) => {
    const b = frame[(i + 1) % 4];
    canvas.drawLine(a.x, a.y, b.x, b.y, paint);
  });
  mockFiles.set('file:///cache/photo.jpg', surface.makeImageSnapshot().encodeToBytes(ImageFormat.JPEG, 92));

  expectNear((await findPage('file:///cache/photo.jpg')).corners, wholePhoto, 1);
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

it('tells a page outline from corners dragged past each other', () => {
  expect(isConvex(tilted)).toBe(true);
  expect(isConvex([tilted[1], tilted[0], tilted[2], tilted[3]])).toBe(false);
  expect(isConvex([tilted[0], tilted[1], { x: 300, y: 300 }, tilted[3]])).toBe(false);
});

const box = (left: number, top: number, right: number, bottom: number): Quad => [
  { x: left, y: top },
  { x: right, y: top },
  { x: right, y: bottom },
  { x: left, y: bottom },
];

it('tells a frame inside another from one that pokes out of it', () => {
  const outer = box(0, 0, 100, 100);
  expect(contains(outer, box(10, 10, 90, 90))).toBe(true);
  expect(contains(outer, box(0, 0, 100, 90))).toBe(true);
  expect(contains(outer, box(10, 10, 110, 90))).toBe(false);
});

// Frames that share an edge differ by a pixel or two once their corners are rounded.
it('lets a corner lie up to 2 px outside the frame that holds it, and no further', () => {
  const outer = box(0, 0, 100, 100);
  expect(contains(outer, box(-2, 10, 90, 90))).toBe(true);
  expect(contains(outer, box(-3, 10, 90, 90))).toBe(false);
});

// A page's left side as `edgeMap` sees it: a bright page on its right gives gx = +120 along x = 50.
function leftEdge(from: number, to: number, strength = 120) {
  const gx = new Int16Array(200 * 150);
  const gy = new Int16Array(200 * 150);
  for (let y = from; y <= to; y++) gx[y * 200 + 50] = strength;
  return { gx, gy };
}

describe('a frame that stops short of the page', () => {
  const frame = box(50, 40, 150, 100);

  it('is told by an edge that carries on past a corner with the same contrast', () => {
    const { gx, gy } = leftEdge(10, 100);
    expect(stopsShort(frame, gx, gy, 200, 150)).toBe(true);
  });

  it('is not told for a side whose edge ends at its corner', () => {
    const { gx, gy } = leftEdge(40, 100);
    expect(stopsShort(frame, gx, gy, 200, 150)).toBe(false);
  });

  it('is not told by an edge of the other contrast past the corner', () => {
    const { gx, gy } = leftEdge(40, 100);
    for (let y = 10; y < 40; y++) gx[y * 200 + 50] = -120;
    expect(stopsShort(frame, gx, gy, 200, 150)).toBe(false);
  });
});

const polygon = (points: number[][]) => Skia.Path.Polygon(points.map(([x, y]) => ({ x, y })), true);

// Paper, then ink or the desk, drawn on the dark desk of `photo`.
function scene(draw: (canvas: SkCanvas, paint: SkPaint) => void): Uint8Array {
  return shapes((canvas, paint) => {
    canvas.drawColor(Skia.Color('rgb(92,70,52)'));
    draw(canvas, paint);
  });
}

const PAPER = 'rgb(238,234,222)';

describe('the frame findPage settles on', () => {
  // A torn footer band hangs below the frame that holds the text; the frame round all of it scores a little less.
  it('is the outer one when a band of page hangs below a frame that scores a little higher', async () => {
    mockFiles.set(
      'file:///cache/photo.jpg',
      scene((canvas, paint) => {
        paint.setColor(Skia.Color(PAPER));
        canvas.drawPath(polygon([[150, 100], [750, 100], [750, 1070], [150, 1010]]), paint);
        paint.setColor(Skia.Color('rgb(50,42,38)'));
        canvas.drawPath(polygon([[150, 1010], [550, 1056], [550, 1100], [150, 1100]]), paint);
      }),
    );

    const { corners } = await findPage('file:///cache/photo.jpg');

    expectNear(corners, box(150, 100, 750, 1100), 15);
  }, 30000);

  // The faint line is the page's own mid-page fold (14 grey levels), so the frame ends at it while the sides run on below.
  it('is the whole photo when a faint-lined frame ends where the page sides run on', async () => {
    mockFiles.set(
      'file:///cache/photo.jpg',
      scene((canvas, paint) => {
        paint.setColor(Skia.Color(PAPER));
        canvas.drawRect(Skia.XYWHRect(350, 100, 200, 600), paint);
        paint.setColor(Skia.Color('rgb(227,223,211)'));
        canvas.drawRect(Skia.XYWHRect(350, 700, 200, 500), paint);
      }),
    );

    expectNear((await findPage('file:///cache/photo.jpg')).corners, wholePhoto, 1);
  }, 30000);

  // The bar's top edge lies 8 px inside the page's tilted top edge, close enough for the side fit to slide onto it.
  it('keeps the top side on the page edge when a header bar sits just inside it', async () => {
    mockFiles.set(
      'file:///cache/photo.jpg',
      scene((canvas, paint) => {
        paint.setColor(Skia.Color(PAPER));
        canvas.drawPath(polygon([[150, 100], [750, 90], [750, 1100], [150, 1100]]), paint);
        paint.setColor(Skia.Color('rgb(35,35,45)'));
        canvas.drawRect(Skia.XYWHRect(150, 108, 300, 50), paint);
        for (let y = 300; y < 1000; y += 40) canvas.drawRect(Skia.XYWHRect(200, y, 500, 10), paint);
      }),
    );

    const { corners } = await findPage('file:///cache/photo.jpg');

    expect(corners[0].y).toBeLessThan(106);
  }, 30000);

  // The right edge bulges 48 px out between y 300 and 900, so no straight right side holds the page.
  it('is the whole photo when a side runs inside a bulge of the page', async () => {
    mockFiles.set(
      'file:///cache/photo.jpg',
      scene((canvas, paint) => {
        paint.setColor(Skia.Color(PAPER));
        canvas.drawPath(polygon([[150, 100], [750, 100], [750, 300], [798, 600], [750, 900], [750, 1100], [150, 1100]]), paint);
        paint.setColor(Skia.Color('rgb(30,30,35)'));
        for (let y = 160; y < 1050; y += 40) canvas.drawRect(Skia.XYWHRect(200, y, 450, 10), paint);
      }),
    );

    expectNear((await findPage('file:///cache/photo.jpg')).corners, wholePhoto, 1);
  }, 30000);
});
