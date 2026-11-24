/**
 * @jest-environment @shopify/react-native-skia/jestEnv.js
 */
/// <reference types="jest" />
import { BlurStyle, ImageFormat, Skia, type SkCanvas, type SkPaint } from '@shopify/react-native-skia';

import { cropPage, findPage, isConvex, pageAspect, type Quad } from './crop';

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

const farthest = (found: Quad, truth: Quad) => Math.max(...found.map((p, i) => Math.hypot(p.x - truth[i].x, p.y - truth[i].y)));

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

it('finds a small page on a dark desk, as a patch the desk round it does not reach', async () => {
  // The tilted page shrunk to 40% about the photo's middle: its sides are too short on the search copy for the straight-line vote.
  const small = tilted.map((p) => ({ x: 450 + (p.x - 450) * 0.4, y: 600 + (p.y - 600) * 0.4 })) as Quad;
  mockFiles.set('file:///cache/photo.jpg', photo(small, 'rgb(92,70,52)'));

  expectNear((await findPage('file:///cache/photo.jpg')).corners, small, 20);
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

// A dark band across the page from `left` to `right` of its width, `top` and `depth` in shares of the page's height.
function bandAcross(page: Quad, top: number, depth: number, left = 0, right = 1, colour = 'rgb(45,50,60)') {
  const [tl, tr, br, bl] = page;
  const at = (a: { x: number; y: number }, b: { x: number; y: number }, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const across = (t: number, s: number) => at(at(tl, bl, t), at(tr, br, t), s);
  return (canvas: SkCanvas) => {
    const band = Skia.Path.Polygon([across(top, left), across(top, right), across(top + depth, right), across(top + depth, left)], true);
    const paint = Skia.Paint();
    paint.setColor(Skia.Color(colour));
    canvas.drawPath(band, paint);
    for (const o of [band, paint]) o.dispose();
  };
}

describe.each([
  ['upright', 'a brown desk', upright, 'rgb(92,70,52)'],
  ['tilted', 'a brown desk', tilted, 'rgb(92,70,52)'],
  ['upright', "a desk of the band's colour", upright, 'rgb(50,50,55)'],
  ['tilted', "a desk of the band's colour", tilted, 'rgb(50,50,55)'],
] as const)('a dark band across the %s page on %s', (_, _desk, page, desk) => {
  it.each([0.2, 0.3, 0.5, 0.85].flatMap((top) => [0.05, 0.08, 0.12].map((depth) => [top, depth])))(
    'at %f down, %f of the page deep, gives the whole page or the whole photo',
    async (top, depth) => {
      mockFiles.set('file:///cache/photo.jpg', photo(page, desk, undefined, undefined, bandAcross(page, top, depth)));

      const { corners } = await findPage('file:///cache/photo.jpg');

      expect(Math.min(farthest(corners, page), farthest(corners, wholePhoto))).toBeLessThan(20);
    },
    30000,
  );
});

// Text lines that follow the tilted page, every 0.035 of its height, in place of photo()'s upright ones (#96).
function tiltedText(canvas: SkCanvas) {
  bandAcross(tilted, 0, 1, 0, 1, 'rgb(238,234,222)')(canvas);
  for (let i = 0; i < 26; i++) bandAcross(tilted, 0.05 + 0.035 * i, 0.008, 0.05, 0.95, 'rgb(30,30,35)')(canvas);
}

it('finds a tilted page whose text lines follow its tilt', async () => {
  mockFiles.set('file:///cache/photo.jpg', photo(tilted, 'rgb(92,70,52)', undefined, undefined, tiltedText));

  expectNear((await findPage('file:///cache/photo.jpg')).corners, tilted, 20);
}, 30000);

it.each([
  [0.55, 0.05, 0, 1],
  [0.55, 0.08, 0, 1],
  [0.3, 0.03, 0.08, 0.92],
  [0.3, 0.05, 0.08, 0.92],
  [0.3, 0.08, 0.08, 0.92],
  [0.3, 0.12, 0.08, 0.92],
  [0.55, 0.05, 0.08, 0.92],
  [0.55, 0.08, 0.08, 0.92],
  [0.55, 0.12, 0.08, 0.92],
])('gives a tilted page with text that follows its tilt and a band %f down, %f deep, from %f to %f of its width, whole or the whole photo', async (top, depth, left, right) => {
  mockFiles.set(
    'file:///cache/photo.jpg',
    photo(tilted, 'rgb(92,70,52)', undefined, undefined, (canvas) => {
      tiltedText(canvas);
      bandAcross(tilted, top, depth, left, right)(canvas);
    }),
  );

  const { corners } = await findPage('file:///cache/photo.jpg');

  expect(Math.min(farthest(corners, tilted), farthest(corners, wholePhoto))).toBeLessThan(20);
}, 30000);

// A white sheet `gap` px right of the page, from the page's top to its foot.
function sheetBeside(page: Quad, gap: number, gapColour?: string) {
  const [, tr, br] = page;
  return (canvas: SkCanvas) => {
    const paint = Skia.Paint();
    const area = (g: number) => Skia.Path.Polygon([{ x: tr.x + g, y: tr.y - 50 }, { x: W, y: tr.y - 50 }, { x: W, y: br.y + 50 }, { x: br.x + g, y: br.y + 50 }], true);
    const shadow = area(0);
    const sheet = area(gap);
    if (gapColour) {
      paint.setColor(Skia.Color(gapColour));
      canvas.drawPath(shadow, paint);
    }
    paint.setColor(Skia.Color('rgb(242,240,235)'));
    canvas.drawPath(sheet, paint);
    for (const o of [shadow, sheet, paint]) o.dispose();
  };
}

const SHADOW = 'rgb(110,105,98)';
// The frame may stop at the far edge of the gap or shadow beside the page; the whole photo is 110 px off or more.
const GAP_SLACK = 40;

it.each([30, 60, 100])('finds a page on a dark desk with a second white sheet %i px beside it', async (gap) => {
  mockFiles.set('file:///cache/photo.jpg', photo(tilted, 'rgb(92,70,52)', undefined, sheetBeside(tilted, gap)));

  expectNear((await findPage('file:///cache/photo.jpg')).corners, tilted, GAP_SLACK);
}, 30000);

it('finds a page on a dark desk beside a white sheet with a 20 px shadow between them', async () => {
  mockFiles.set('file:///cache/photo.jpg', photo(upright, 'rgb(92,70,52)', undefined, sheetBeside(upright, 20, SHADOW)));

  expectNear((await findPage('file:///cache/photo.jpg')).corners, upright, GAP_SLACK);
}, 30000);

it.each([20, 28])('finds a page on a near-white table with a %i px shadow round it', async (depth) => {
  const shadow = (canvas: SkCanvas) => {
    const outline = Skia.Path.Polygon(upright, true);
    const paint = Skia.Paint();
    paint.setColor(Skia.Color(SHADOW));
    paint.setStyle(1);
    paint.setStrokeWidth(depth * 2);
    canvas.drawPath(outline, paint);
    for (const o of [outline, paint]) o.dispose();
  };
  mockFiles.set('file:///cache/photo.jpg', photo(upright, 'rgb(225,222,215)', undefined, shadow));

  expectNear((await findPage('file:///cache/photo.jpg')).corners, upright, GAP_SLACK);
}, 30000);

// No table shows past the page's sides to set the shadow apart from a band, so only its paleness keeps the frame.
it('finds a page as wide as the photo on a near-white table with a shadow under its foot', async () => {
  const wide: Quad = [
    { x: 3, y: 150 },
    { x: 897, y: 150 },
    { x: 897, y: 1000 },
    { x: 3, y: 1000 },
  ];
  const shadow = (canvas: SkCanvas) => {
    const paint = Skia.Paint();
    paint.setColor(Skia.Color(SHADOW));
    canvas.drawRect(Skia.XYWHRect(0, 1000, W, 20), paint);
    paint.dispose();
  };
  mockFiles.set('file:///cache/photo.jpg', photo(wide, 'rgb(225,222,215)', undefined, shadow));

  expectNear((await findPage('file:///cache/photo.jpg')).corners, wide, 20);
}, 30000);

// The faint top edge votes less than the first line of text below it (#112).
it('finds a page on a near-white table, not a frame that starts on its first line of text', async () => {
  mockFiles.set('file:///cache/photo.jpg', photo(upright, 'rgb(250,250,250)'));

  expectNear((await findPage('file:///cache/photo.jpg')).corners, upright, 20);
}, 30000);

// DocUNet 35_1: a shadow across the page and a white table under its foot leave the shadow's edge as the frame's foot (#85).
it('gives the whole photo, not a frame whose foot lies across the page with lighter paper past it', async () => {
  const whiteTable = (canvas: SkCanvas) => {
    const paint = Skia.Paint();
    paint.setColor(Skia.Color('rgb(248,247,244)'));
    canvas.drawRect(Skia.XYWHRect(0, 800, W, H - 800), paint);
    paint.dispose();
  };
  const shadow = (canvas: SkCanvas) => {
    const paint = Skia.Paint();
    paint.setColor(Skia.Color('rgba(0,0,0,0.3)'));
    canvas.drawRect(Skia.XYWHRect(0, 0, W, 600), paint);
    paint.dispose();
  };
  mockFiles.set('file:///cache/photo.jpg', photo(upright, 'rgb(92,70,52)', undefined, whiteTable, shadow));

  expect((await findPage('file:///cache/photo.jpg')).corners).toEqual(wholePhoto);
}, 30000);

it.each([
  ['upright', upright],
  ['tilted', tilted],
])('finds a %s page a little greyer than the white table round it', async (_, page) => {
  mockFiles.set('file:///cache/photo.jpg', photo(page, 'rgb(250,250,250)', 'rgb(210,206,196)'));

  expectNear((await findPage('file:///cache/photo.jpg')).corners, page, 20);
}, 30000);

// A table brighter than a header is no lit paper past a shadow (#114).
it.each([
  ['upright', upright, 'grey', 'rgb(140,140,140)', 'wood', 'rgb(205,175,135)', 'rgb(238,234,222)', false],
  ['tilted', tilted, 'grey', 'rgb(120,120,120)', 'light grey', 'rgb(215,215,215)', 'rgb(238,234,222)', true],
  ['tilted', tilted, 'light blue', 'rgb(150,190,230)', 'light grey', 'rgb(215,215,215)', 'rgb(252,252,252)', false],
  ['upright', upright, 'yellow', 'rgb(240,215,90)', 'white', 'rgb(248,248,248)', 'rgb(252,252,252)', true],
] as const)('finds a %s page with a %s header on a %s table, with a footer: %s', async (_, page, _h, header, _t, table, paper, footer) => {
  const bands = (canvas: SkCanvas) => {
    bandAcross(page, 0, 0.12, 0, 1, header)(canvas);
    if (footer) bandAcross(page, 0.88, 0.12, 0, 1, header)(canvas);
  };
  mockFiles.set('file:///cache/photo.jpg', photo(page, table, paper, undefined, bands));

  expectNear((await findPage('file:///cache/photo.jpg')).corners, page, 20);
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

// Where a camera with focal length `f` px, centred on the photo, sees the corners of a page `ratio` times
// as wide as tall, tipped back `pitch` and turned `yaw` radians.
function seen(ratio: number, f: number, pitch: number, yaw: number): Quad {
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sy]) => {
    const [x0, y0] = [(sx * ratio) / 2, sy / 2];
    const [x1, z1] = [x0 * Math.cos(yaw), x0 * Math.sin(yaw)];
    const [y, z] = [y0 * Math.cos(pitch) - z1 * Math.sin(pitch), y0 * Math.sin(pitch) + z1 * Math.cos(pitch) + 2];
    return { x: W / 2 + (f * x1) / z, y: H / 2 + (f * y) / z };
  }) as Quad;
}

it.each([
  ['an A4 page tipped back and turned, its sides all converging', 210 / 297, 1000, 0.6, 0.3],
  ['a landscape page tipped back, its top and bottom parallel', 297 / 210, 864, 0.55, 0],
  ['a page turned, its left and right sides parallel', 0.75, 800, 0, 0.5],
])('keeps the true shape of %s, without shrinking any side', async (_, ratio, f, pitch, yaw) => {
  const corners = seen(ratio, f, pitch, yaw);
  mockFiles.set('file:///cache/photo.jpg', photo(corners, 'rgb(92,70,52)'));

  await cropPage('file:///cache/photo.jpg', corners, 'file:///cache/page.jpg');

  const image = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(mockFiles.get('file:///cache/page.jpg')!))!;
  expect(Math.abs(image.width() / image.height() / ratio - 1)).toBeLessThan(0.02);
  const [tl, tr, br, bl] = corners;
  const length = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  expect(image.width()).toBeGreaterThanOrEqual(Math.floor(Math.max(length(tl, tr), length(bl, br))));
  expect(image.height()).toBeGreaterThanOrEqual(Math.floor(Math.max(length(tl, bl), length(tr, br))));
}, 30000);

it('keeps an A4 shape when 2 px of corner noise reads a much shorter focal length than the camera has', () => {
  // Tipped back, the page's top and bottom stay parallel; the noise tilts them just past 1%.
  const shift = [-2, 2, -2, 2];
  const corners = seen(210 / 297, 0.72 * H, 0.4, 0).map((p, i) => ({ x: p.x + shift[i], y: p.y - shift[(i + 1) % 4] })) as Quad;

  // Read unclamped, the focal length is under 0.4 of the camera's and the page 7% too wide.
  expect(Math.abs(pageAspect(corners, W, H) / (210 / 297) - 1)).toBeLessThan(0.02);
});

it('keeps the photo file itself when the corners are the whole photo', async () => {
  const bytes = photo(tilted, 'rgb(92,70,52)');
  mockFiles.set('file:///cache/photo.jpg', bytes);

  await cropPage('file:///cache/photo.jpg', wholePhoto, 'file:///cache/page.jpg');

  expect(mockFiles.get('file:///cache/page.jpg')).toEqual(bytes);
}, 30000);

it('redraws a whole photo that carries EXIF, as a PDF would show its pixels sideways', async () => {
  const plain = photo(tilted, 'rgb(92,70,52)');
  // An EXIF block saying the pixels are turned a quarter (orientation 6).
  const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0];
  const app1 = [0xff, 0xe1, 0, 2 + 6 + tiff.length, ...[...'Exif'].map((c) => c.charCodeAt(0)), 0, 0, ...tiff];
  const tagged = new Uint8Array([...plain.subarray(0, 2), ...app1, ...plain.subarray(2)]);
  mockFiles.set('file:///cache/photo.jpg', tagged);
  const source = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(tagged))!;

  const [w, h] = [source.width(), source.height()];
  await cropPage('file:///cache/photo.jpg', [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], 'file:///cache/page.jpg');

  const page = mockFiles.get('file:///cache/page.jpg')!;
  expect(page).not.toEqual(tagged);
  const image = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(page))!;
  expect([image.width(), image.height()]).toEqual([w, h]);
}, 30000);

it('straightens the page inside the corners into an upright page', async () => {
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
