/**
 * @jest-environment @shopify/react-native-skia/jestEnv.js
 */
/// <reference types="jest" />
import {
  AlphaType, BlurStyle, ColorType, ImageFormat, Skia, type SkImage,
} from '@shopify/react-native-skia';

import { cleanPages, defaultFilter, filterImage, filterPreviews, pageFilter, setDefaultFilter, sharedFilter, shrunkCopy, type Filter } from './clean';
import { rotatePage } from './upright';

// Real Skia (CanvasKit) does the pixel work; only the files are in memory.
const mockFiles = new Map<string, Uint8Array>();

jest.mock('@shopify/react-native-skia', () =>
  jest.requireActual('@shopify/react-native-skia/lib/module/mock').Mock((globalThis as any).CanvasKit),
);

jest.mock('expo-file-system', () => {
  // Text files hold their bytes as characters, as the JSON filter file is ASCII.
  const encode = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
  const decode = (bytes: Uint8Array) => String.fromCharCode(...bytes);
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
      if (!b) throw new Error('not found');
      return b;
    }
    async write(b: Uint8Array) {
      mockFiles.set(this.uri, b);
    }
    writeSync(text: string) {
      mockFiles.set(this.uri, encode(text));
    }
    textSync() {
      return decode(mockFiles.get(this.uri)!);
    }
    create() {
      mockFiles.set(this.uri, new Uint8Array());
    }
    delete() {
      mockFiles.delete(this.uri);
    }
    async move(dest: File, options?: { overwrite?: boolean }) {
      if (mockFiles.has(dest.uri) && !options?.overwrite) throw new Error('destination exists');
      mockFiles.set(dest.uri, mockFiles.get(this.uri)!);
      mockFiles.delete(this.uri);
    }
  }
  return { File, Paths: { document: { uri: 'file:///doc' } } };
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

function pixel(bytes: Uint8Array, x: number, y: number): Uint8Array {
  const image = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(bytes))!;
  return image.readPixels(x, y, { width: 1, height: 1, colorType: 4, alphaType: 3 }) as Uint8Array;
}

function luma(bytes: Uint8Array, x: number, y: number): number {
  const px = pixel(bytes, x, y);
  return (px[0] + px[1] + px[2]) / 3;
}

it('turns shadowed, tinted paper, specks and creases white and keeps ink dark, in place', async () => {
  mockFiles.set('file:///doc/scans/1/p1.jpg', photographedPage());

  await cleanPages(['file:///doc/scans/1/p1.jpg']);

  expect([...mockFiles.keys()].sort()).toEqual([
    'file:///doc/scans/1/f1.json',
    'file:///doc/scans/1/o1.cleaned',
    'file:///doc/scans/1/o1.jpg',
    'file:///doc/scans/1/p1.jpg',
  ]);
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

// A page of text lines, half of it under a hard-edged shadow (a phone under a ceiling lamp) and
// crossed lower down by a thin shadow strand (blinds, a plant).
function sharplyShadowedPage(): Uint8Array {
  const surface = Skia.Surface.Make(1200, 1600)!;
  const canvas = surface.getCanvas();
  canvas.drawColor(Skia.Color('rgb(235,228,210)'));
  const ink = Skia.Paint();
  ink.setColor(Skia.Color('rgb(35,35,40)'));
  for (let y = 100; y < 1600; y += 60) {
    for (let x = 40; x < 1160; x += 70) canvas.drawRect(Skia.XYWHRect(x, y, 50, 8), ink);
  }
  const shade = Skia.Paint();
  shade.setColor(Skia.Color('rgba(20,15,10,0.5)'));
  shade.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, 1.5, true));
  canvas.drawRect(Skia.XYWHRect(700, -50, 600, 850), shade);
  canvas.drawRect(Skia.XYWHRect(300, 900, 30, 800), shade);
  return surface.makeImageSnapshot().encodeToBytes(ImageFormat.JPEG, 95);
}

it('turns paper under hard-edged shadows and thin shadow strands white, up to the edge', async () => {
  mockFiles.set('file:///doc/scans/1/p1.jpg', sharplyShadowedPage());

  await cleanPages(['file:///doc/scans/1/p1.jpg']);

  const page = mockFiles.get('file:///doc/scans/1/p1.jpg')!;
  for (const x of [690, 704, 712, 724, 740, 800]) expect(luma(page, x, 430)).toBeGreaterThan(240); // across the hard edge
  expect(luma(page, 315, 1030)).toBeGreaterThan(240); // inside the strand
  expect(luma(page, 325, 1004)).toBeLessThan(60); // ink inside the strand
  expect(luma(page, 710, 404)).toBeLessThan(60); // ink just inside the hard edge
  expect(luma(page, 900, 404)).toBeLessThan(60); // ink deep in the shadow
}, 30000);

// A straightened photo of a bent page. A corner curled up, so a triangle of table shows at the top
// right; the left edge was not straight, so a wavy strip of table runs along it, with text a few
// pixels away; a wedge of speckled grey desk shows along the right edge. The bottom edge curls
// away from the light, so the paper darkens there, text included.
const bentEdge = (y: number) => 16 + 8 * Math.sin(y / 70);

function bentPage(): Uint8Array {
  const surface = Skia.Surface.Make(W, H)!;
  const canvas = surface.getCanvas();
  canvas.drawColor(Skia.Color('rgb(235,228,210)'));
  const shade = Skia.Paint();
  for (let y = 720; y < H; y += 4) {
    shade.setColor(Skia.Color(`rgba(20,15,10,${(0.6 * (y - 720)) / (H - 720)})`));
    canvas.drawRect(Skia.XYWHRect(0, y, W, 4), shade);
  }
  const ink = Skia.Paint();
  ink.setColor(Skia.Color('rgb(35,35,40)'));
  // The text bends with the page, so it keeps 4 px from the edge.
  for (let y = 60; y < 760; y += 14) canvas.drawRect(Skia.XYWHRect(bentEdge(y) + 4, y, 420, 7), ink);
  canvas.drawRect(Skia.XYWHRect(60, 784, 420, 6), ink);
  const table = Skia.Paint();
  table.setColor(Skia.Color('rgb(80,58,42)'));
  const strip = [{ x: 0, y: 0 }];
  for (let y = 0; y <= H; y += 10) strip.push({ x: bentEdge(y), y });
  strip.push({ x: 0, y: H });
  canvas.drawPath(Skia.Path.Polygon(strip, true), table);
  canvas.drawPath(Skia.Path.Polygon([{ x: 500, y: 0 }, { x: W, y: 0 }, { x: W, y: 100 }], true), table);
  const desk = Skia.Paint();
  desk.setColor(Skia.Color('rgb(50,48,50)'));
  canvas.drawPath(Skia.Path.Polygon([{ x: W, y: 260 }, { x: W - 28, y: 450 }, { x: W, y: 640 }], true), desk);
  desk.setColor(Skia.Color('rgb(120,117,112)'));
  for (let y = 380; y < 520; y += 30) canvas.drawRect(Skia.XYWHRect(W - 10, y, 6, 8), desk);
  return surface.makeImageSnapshot().encodeToBytes(ImageFormat.JPEG, 95);
}

it('turns table showing past the bent edges of a page white and keeps text near them', async () => {
  mockFiles.set('file:///doc/scans/1/p1.jpg', bentPage());

  await cleanPages(['file:///doc/scans/1/p1.jpg']);

  const page = mockFiles.get('file:///doc/scans/1/p1.jpg')!;
  for (const y of [20, 50, 80]) {
    for (const x of [500 + y + 3, 500 + y + 8]) expect(luma(page, x, y)).toBeGreaterThan(240); // curled corner
  }
  for (const y of [100, 250, 400, 640]) {
    const edge = bentEdge(y);
    for (const x of [2, edge / 2, edge - 2]) expect(luma(page, Math.round(x), y)).toBeGreaterThan(240); // strip
  }
  for (const [x, y] of [[W - 7, 414], [W - 2, 450], [W - 20, 450]]) expect(luma(page, x, y)).toBeGreaterThan(240); // speckled desk
  for (const y of [63, 245, 427, 609]) expect(luma(page, Math.round(bentEdge(y) + 7), y)).toBeLessThan(80); // text by the strip
  expect(luma(page, 200, 787)).toBeLessThan(80); // text in the darkened bottom
  expect(luma(page, 200, 796)).toBeGreaterThan(240); // darkened paper
}, 30000);

// A page printed off its edges: a dark heading band along the top with white letters in it, and
// a dark picture with light details off the right edge.
function pageWithPrintOffEdges(): Uint8Array {
  const surface = Skia.Surface.Make(W, H)!;
  const canvas = surface.getCanvas();
  canvas.drawColor(Skia.Color('rgb(235,228,210)'));
  const dark = Skia.Paint();
  dark.setColor(Skia.Color('rgb(40,60,40)'));
  canvas.drawRect(Skia.XYWHRect(0, 0, W, 45), dark);
  canvas.drawRect(Skia.XYWHRect(380, 250, 220, 300), dark);
  const light = Skia.Paint();
  light.setColor(Skia.Color('rgb(235,235,235)'));
  for (let x = 40; x < 400; x += 18) canvas.drawRect(Skia.XYWHRect(x, 10, 10, 25), light);
  for (let y = 270; y < 550; y += 25) canvas.drawRect(Skia.XYWHRect(380, y, 220, 3), light);
  return surface.makeImageSnapshot().encodeToBytes(ImageFormat.JPEG, 95);
}

it('keeps print that runs off the edges of the page', async () => {
  mockFiles.set('file:///doc/scans/1/p1.jpg', pageWithPrintOffEdges());

  await cleanPages(['file:///doc/scans/1/p1.jpg']);

  const page = mockFiles.get('file:///doc/scans/1/p1.jpg')!;
  for (const x of [54, 126, 198]) expect(luma(page, x, 22)).toBeLessThan(100); // between letters
  expect(luma(page, 130, 4)).toBeLessThan(100); // above them
  for (const x of [596, 590, 560]) expect(luma(page, x, 377)).toBeLessThan(100); // picture
}, 30000);

// Print a tight crop cuts into: a bold title against the top edge, a frame line down the whole
// right edge, a coloured footer band with white text and a logo in it, and a dark box by the top
// left corner, just below the top edge.
function pageWithPrintAtEdges(): Uint8Array {
  const surface = Skia.Surface.Make(W, H)!;
  const canvas = surface.getCanvas();
  canvas.drawColor(Skia.Color('rgb(235,228,210)'));
  const paint = (colour: string) => {
    const p = Skia.Paint();
    p.setColor(Skia.Color(colour));
    return p;
  };
  const ink = paint('rgb(30,30,35)');
  for (let x = 150; x < 450; x += 80) {
    canvas.drawRect(Skia.XYWHRect(x, 0, 60, 18), ink);
    canvas.drawRect(Skia.XYWHRect(x + 21, 0, 18, 54), ink);
  }
  canvas.drawRect(Skia.XYWHRect(W - 18, 0, 18, H), paint('rgb(20,40,120)'));
  canvas.drawRect(Skia.XYWHRect(0, H - 24, W - 60, 24), paint('rgb(120,20,60)'));
  const white = paint('rgb(245,245,245)');
  for (let x = 30; x < 200; x += 14) canvas.drawRect(Skia.XYWHRect(x, H - 18, 8, 12), white);
  canvas.drawRect(Skia.XYWHRect(420, H - 20, 50, 16), white);
  canvas.drawRect(Skia.XYWHRect(0, 8, 60, 20), paint('rgb(60,60,65)'));
  return surface.makeImageSnapshot().encodeToBytes(ImageFormat.JPEG, 95);
}

it('keeps bold letters, frame lines, bands and boxes that a tight crop cuts into', async () => {
  mockFiles.set('file:///doc/scans/1/p1.jpg', pageWithPrintAtEdges());

  await cleanPages(['file:///doc/scans/1/p1.jpg']);

  const page = mockFiles.get('file:///doc/scans/1/p1.jpg')!;
  for (const [x, y] of [[180, 10], [180, 45], [340, 10]]) expect(luma(page, x, y)).toBeLessThan(80); // title
  for (const y of [20, 400, 780]) expect(luma(page, W - 9, y)).toBeLessThan(100); // frame line
  for (const x of [10, 300, 500]) expect(luma(page, x, H - 12)).toBeLessThan(160); // footer band
  expect(luma(page, 30, 18)).toBeLessThan(80); // box
}, 30000);

it('defaults to Clean Normal and keeps a chosen filter across launches', () => {
  expect(defaultFilter()).toEqual({ kind: 'clean', strength: 1 });

  setDefaultFilter({ kind: 'gray', strength: 0 });
  expect(defaultFilter()).toEqual({ kind: 'gray', strength: 0 });

  setDefaultFilter({ kind: 'clean', strength: 2 });
  expect(defaultFilter()).toEqual({ kind: 'clean', strength: 2 });
});

it('turns an old clean-up-off file into Original once, then deletes it', () => {
  mockFiles.set('file:///doc/clean-up-off', new Uint8Array());

  expect(defaultFilter()).toEqual({ kind: 'original', strength: 1 });
  expect(mockFiles.has('file:///doc/clean-up-off')).toBe(false);
  expect(defaultFilter()).toEqual({ kind: 'original', strength: 1 });
});

it('ignores an unreadable filter file', () => {
  mockFiles.set('file:///doc/filter', Uint8Array.from('{"kind":"sepia","strength":1}', (c) => c.charCodeAt(0)));
  expect(defaultFilter()).toEqual({ kind: 'clean', strength: 1 });
});

// Pencil, or faded print: a line of letter-sized marks. The default marks are at about 92% of the
// paper's brightness.
function faintPage(colour = 'rgb(216,210,193)', width = 16): Uint8Array {
  const surface = Skia.Surface.Make(W, H)!;
  const canvas = surface.getCanvas();
  canvas.drawColor(Skia.Color('rgb(235,228,210)'));
  const faint = Skia.Paint();
  faint.setColor(Skia.Color(colour));
  for (let x = 150; x < 450; x += 24) canvas.drawRect(Skia.XYWHRect(x, 380, width, 70), faint);
  return surface.makeImageSnapshot().encodeToBytes(ImageFormat.JPEG, 95);
}

it('keeps faint grey text at Light and wipes it at Normal', async () => {
  const PAGE = 'file:///doc/scans/1/p1.jpg';
  mockFiles.set(PAGE, faintPage());

  await cleanPages([PAGE], { kind: 'clean', strength: 0 });
  expect(luma(mockFiles.get(PAGE)!, 158, 415)).toBeLessThan(250);
  expect(luma(mockFiles.get(PAGE)!, 30, 400)).toBeGreaterThan(245); // paper

  await cleanPages([PAGE], { kind: 'clean', strength: 1 });
  expect(luma(mockFiles.get(PAGE)!, 158, 415)).toBeGreaterThan(253);
}, 30000);

it('wipes at Strong what Normal keeps', async () => {
  const PAGE = 'file:///doc/scans/1/p1.jpg';
  // Narrow strokes, so the paper estimate stays the paper among them.
  mockFiles.set(PAGE, faintPage('rgb(193,187,172)', 8));

  await cleanPages([PAGE], { kind: 'clean', strength: 1 });
  expect(luma(mockFiles.get(PAGE)!, 154, 415)).toBeLessThan(252);

  await cleanPages([PAGE], { kind: 'clean', strength: 2 });
  expect(luma(mockFiles.get(PAGE)!, 154, 415)).toBeGreaterThan(254);
}, 30000);

it('turns the cleaned page grey, not hard black and white', async () => {
  const PAGE = 'file:///doc/scans/1/p1.jpg';
  mockFiles.set(PAGE, photographedPage());

  await cleanPages([PAGE], { kind: 'gray', strength: 1 });

  const page = mockFiles.get(PAGE)!;
  for (const [x, y] of [[80, 208], [303, 453], [30, 400]]) {
    const [r, g, b] = pixel(page, x, y);
    expect([r, g, b]).toEqual([r, r, r]);
  }
}, 30000);

it('cleans a page the same way twice as once, from its untouched original', async () => {
  const PAGE = 'file:///doc/scans/1/p1.jpg';
  mockFiles.set(PAGE, photographedPage());

  await cleanPages([PAGE]);
  const once = mockFiles.get(PAGE)!;
  await cleanPages([PAGE]);

  expect(mockFiles.get(PAGE)).toEqual(once);
}, 30000);

it('puts back the untouched photo for Original', async () => {
  const PAGE = 'file:///doc/scans/1/p1.jpg';
  const photo = photographedPage();
  mockFiles.set(PAGE, photo);

  await cleanPages([PAGE]);
  expect(mockFiles.get(PAGE)).not.toEqual(photo);
  await cleanPages([PAGE], { kind: 'original', strength: 1 });

  expect(mockFiles.get(PAGE)).toEqual(photo);
}, 30000);

it('leaves a page it cannot read as it is, cleans the rest, and counts the failure', async () => {
  const broken = new Uint8Array([1, 2, 3]);
  mockFiles.set('file:///doc/scans/1/p1.jpg', broken);
  mockFiles.set('file:///doc/scans/1/p2.jpg', photographedPage());

  const failed = await cleanPages(['file:///doc/scans/1/p1.jpg', 'file:///doc/scans/1/p2.jpg']);

  expect(failed).toBe(1);
  expect(mockFiles.get('file:///doc/scans/1/p1.jpg')).toBe(broken);
  expect(luma(mockFiles.get('file:///doc/scans/1/p2.jpg')!, 30, 400)).toBeGreaterThan(245);
}, 30000);

function decode(bytes: Uint8Array): SkImage {
  return Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(bytes))!;
}

// An encoded page drawn small the way a preview of it is: with shrunkCopy, as filterImage does.
function shrunk(bytes: Uint8Array, width: number): SkImage {
  const image = decode(bytes);
  const out = shrunkCopy(image, width, Math.round((width * image.height()) / image.width()));
  image.dispose();
  return out;
}

// The mean difference per colour channel, 0-255.
function meanDifference(a: SkImage, b: SkImage): number {
  const pixels = { width: a.width(), height: a.height(), colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul };
  const pa = a.readPixels(0, 0, pixels) as Uint8Array;
  const pb = b.readPixels(0, 0, pixels) as Uint8Array;
  let sum = 0;
  for (let i = 0; i < pa.length; i += 4) {
    sum += Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]);
  }
  return sum / ((pa.length / 4) * 3);
}

const KIND_STRENGTHS: Filter[] = (['original', 'clean', 'gray'] as const).flatMap((kind) =>
  ([0, 1, 2] as const).map((strength) => ({ kind, strength })));

it('makes a small filtered copy at every kind and strength without writing a file', () => {
  const photo = decode(photographedPage());

  try {
    for (const filter of KIND_STRENGTHS) {
      const preview = filterImage(photo, filter, 150);
      expect([filter, preview.width(), preview.height()]).toEqual([filter, 150, 200]);
      preview.dispose();
    }
  } finally {
    photo.dispose();
  }
  expect(mockFiles.size).toBe(0);
}, 30000);

it('previews the page that storing the same filter gives, shrunk', async () => {
  const PAGE = 'file:///doc/scans/1/p1.jpg';
  mockFiles.set(PAGE, photographedPage());
  // keepOriginal stores these bytes untouched, so this is the photo a preview starts from.
  const photo = decode(mockFiles.get(PAGE)!);
  const previews: SkImage[] = [];
  let cleanNormal: SkImage | undefined;

  try {
    for (const filter of KIND_STRENGTHS) {
      await cleanPages([PAGE], filter);
      const stored = shrunk(mockFiles.get(PAGE)!, 150);
      const preview = filterImage(photo, filter, 150);
      expect(meanDifference(preview, stored)).toBeLessThan(0.5);
      stored.dispose();
      previews.push(preview);
      if (filter.kind === 'clean' && filter.strength === 1) cleanNormal = preview;
    }
    // A different filter differs far more than a preview does from its stored page.
    const untouched = filterImage(photo, { kind: 'original', strength: 1 }, 150);
    expect(meanDifference(untouched, cleanNormal!)).toBeGreaterThan(10);
    untouched.dispose();
  } finally {
    photo.dispose();
    for (const preview of previews) preview.dispose();
  }
}, 30000);

const PAGE1 = 'file:///doc/scans/1/p1.jpg';
const SIDECAR1 = 'file:///doc/scans/1/f1.json';

it('records each page\'s filter so pageFilter reads it back, at every kind and strength', async () => {
  mockFiles.set(PAGE1, photographedPage());

  for (const filter of KIND_STRENGTHS) {
    await cleanPages([PAGE1], filter);
    expect([filter, pageFilter(PAGE1)]).toEqual([filter, filter]);
  }
}, 60000);

it('reads null for a page with no filter record or an unreadable one', () => {
  mockFiles.set(PAGE1, photographedPage());
  expect(pageFilter(PAGE1)).toBeNull();

  for (const text of ['garbage', '{"kind":"sepia","strength":1}']) {
    mockFiles.set(SIDECAR1, Uint8Array.from(text, (c) => c.charCodeAt(0)));
    expect(pageFilter(PAGE1)).toBeNull();
  }
});

it('reads the filter every given page shares, and null when they differ or one has none', () => {
  const record = (n: number, text: string) =>
    mockFiles.set(`file:///doc/scans/1/f${n}.json`, Uint8Array.from(text, (c) => c.charCodeAt(0)));
  const pages = [1, 2, 3].map((n) => `file:///doc/scans/1/p${n}.jpg`);
  record(1, '{"kind":"gray","strength":2}');
  record(2, '{"kind":"gray","strength":2}');
  expect(sharedFilter(pages.slice(0, 2))).toEqual({ kind: 'gray', strength: 2 });

  record(2, '{"kind":"gray","strength":1}');
  expect(sharedFilter(pages.slice(0, 2))).toBeNull();

  record(2, '{"kind":"gray","strength":2}');
  expect(sharedFilter(pages)).toBeNull();
  expect(sharedFilter([])).toBeNull();
});

it('keeps the earlier filter record and page when a page cannot be filtered', async () => {
  const broken = new Uint8Array([1, 2, 3]);
  mockFiles.set(PAGE1, broken);
  mockFiles.set('file:///doc/scans/1/o1.jpg', broken);
  mockFiles.set(SIDECAR1, Uint8Array.from('{"kind":"gray","strength":2}', (c) => c.charCodeAt(0)));

  expect(await cleanPages([PAGE1], { kind: 'clean', strength: 0 })).toBe(1);

  expect(pageFilter(PAGE1)).toEqual({ kind: 'gray', strength: 2 });
  expect(mockFiles.get(PAGE1)).toBe(broken);
});

it('records the default filter a new scan gets', async () => {
  mockFiles.set(PAGE1, photographedPage());
  setDefaultFilter({ kind: 'gray', strength: 0 });

  await cleanPages([PAGE1], defaultFilter());

  expect(pageFilter(PAGE1)).toEqual({ kind: 'gray', strength: 0 });
}, 30000);

it('keeps a turn when the turned page is filtered, and its filter record', async () => {
  mockFiles.set(PAGE1, photographedPage());
  await cleanPages([PAGE1], { kind: 'gray', strength: 1 });

  await rotatePage(PAGE1, 1);
  await cleanPages([PAGE1], { kind: 'clean', strength: 2 });

  const page = decode(mockFiles.get(PAGE1)!);
  expect([page.width(), page.height()]).toEqual([H, W]);
  // The ink bar (x 60-540, y 200-216) is dark after a clockwise turn at x = H - 216..H - 200, y = 60..540.
  expect(luma(mockFiles.get(PAGE1)!, H - 208, 300)).toBeLessThan(50);
  expect(luma(mockFiles.get(PAGE1)!, 100, 300)).toBeGreaterThan(245);
  page.dispose();
  expect(pageFilter(PAGE1)).toEqual({ kind: 'clean', strength: 2 });
}, 60000);

it('filters an older page with no original and no record, and records it', async () => {
  mockFiles.set(PAGE1, photographedPage());
  expect(pageFilter(PAGE1)).toBeNull();

  expect(await cleanPages([PAGE1], { kind: 'clean', strength: 1 })).toBe(0);

  expect(pageFilter(PAGE1)).toEqual({ kind: 'clean', strength: 1 });
}, 30000);

it('marks an already-stored page that has no original, and not a new page or one with an original', async () => {
  const MARK = 'file:///doc/scans/1/o1.cleaned';
  mockFiles.set(PAGE1, photographedPage());
  await cleanPages([PAGE1], { kind: 'clean', strength: 1 }, true);
  expect(mockFiles.has(MARK)).toBe(false);
  mockFiles.clear();

  mockFiles.set(PAGE1, photographedPage());
  await cleanPages([PAGE1], { kind: 'clean', strength: 1 });
  expect(mockFiles.has(MARK)).toBe(true);
  mockFiles.clear();

  mockFiles.set(PAGE1, photographedPage());
  mockFiles.set('file:///doc/scans/1/o1.jpg', photographedPage());
  await cleanPages([PAGE1], { kind: 'clean', strength: 1 });
  expect(mockFiles.has(MARK)).toBe(false);
}, 60000);

it('Original on a marked page records Original and leaves the page as it is', async () => {
  // The older page as stored: its clean-up is already in it.
  const older = photographedPage();
  mockFiles.set(PAGE1, older);
  await cleanPages([PAGE1], { kind: 'clean', strength: 1 });

  await cleanPages([PAGE1], { kind: 'original', strength: 1 });

  expect(pageFilter(PAGE1)).toEqual({ kind: 'original', strength: 1 });
  expect(mockFiles.get(PAGE1)).toEqual(older);
  expect(mockFiles.has('file:///doc/scans/1/o1.cleaned')).toBe(true);
}, 60000);

it('never overwrites a page whose address is not p<N>.jpg with its filter record', async () => {
  const odd = 'file:///doc/scans/1/page.jpg';
  const before = photographedPage();
  mockFiles.set(odd, before);

  expect(await cleanPages([odd], { kind: 'clean', strength: 1 })).toBe(1);

  expect(mockFiles.get(odd)).toEqual(before);
  expect(pageFilter(odd)).toBeNull();
}, 30000);

it('stops previewing when cancelled, makes no further image and writes no file', async () => {
  mockFiles.set(PAGE1, photographedPage());
  const files = new Map(mockFiles);
  let calls = 0;

  // Asked before decoding, then once after each yield: true on the third means one image was made.
  const previews = await filterPreviews(PAGE1, 150, () => ++calls >= 3);

  expect(previews).toBeNull();
  expect(calls).toBe(3);
  expect(mockFiles).toEqual(files);
}, 30000);

it('previews Original, Clean and Grayscale Normal from the untouched photo, writing no file', async () => {
  const photo = photographedPage();
  mockFiles.set(PAGE1, photo);
  await cleanPages([PAGE1], { kind: 'gray', strength: 2 });
  const files = new Map(mockFiles);
  const source = decode(photo);

  const previews = (await filterPreviews(PAGE1, 150))!;

  try {
    expect(Object.values(previews).map((p) => [p.width(), p.height()])).toEqual([[150, 200], [150, 200], [150, 200]]);
    const expected = [
      { kind: 'original', strength: 1 },
      { kind: 'clean', strength: 1 },
      { kind: 'gray', strength: 1 },
    ] as const;
    expected.forEach((filter) => {
      const direct = filterImage(source, filter, 150);
      expect(meanDifference(previews[filter.kind], direct)).toBeLessThan(0.5);
      direct.dispose();
    });
    expect(mockFiles).toEqual(files);
  } finally {
    source.dispose();
    for (const p of Object.values(previews)) p.dispose();
  }
}, 30000);

it('previews a page that has no original from the page itself', async () => {
  mockFiles.set(PAGE1, photographedPage());

  const previews = (await filterPreviews(PAGE1, 150))!;

  expect(Object.keys(previews).sort()).toEqual(['clean', 'gray', 'original']);
  expect(Object.values(previews).map((p) => p.width())).toEqual([150, 150, 150]);
  for (const p of Object.values(previews)) p.dispose();
  expect([...mockFiles.keys()]).toEqual([PAGE1]);
}, 30000);

describe('using one page\'s filter on every page', () => {
  const pages = [1, 2, 3].map((n) => `file:///doc/scans/1/p${n}.jpg`);
  const grayStrong: Filter = { kind: 'gray', strength: 2 };

  it('makes every page read and look like the edited page', async () => {
    pages.forEach((p) => mockFiles.set(p, photographedPage()));
    await cleanPages([pages[1]], grayStrong);

    expect(await cleanPages(pages, pageFilter(pages[1])!)).toBe(0);

    for (const p of pages) {
      expect(pageFilter(p)).toEqual(grayStrong);
      const [r, g, b] = pixel(mockFiles.get(p)!, 80, 208);
      expect([r, g, b]).toEqual([r, r, r]);
    }
  }, 60000);

  it('changes the other pages and returns the count when one fails', async () => {
    mockFiles.set(pages[0], photographedPage());
    mockFiles.set(pages[1], new Uint8Array([1, 2, 3]));
    mockFiles.set(pages[2], photographedPage());

    expect(await cleanPages(pages, grayStrong)).toBe(1);

    expect([pageFilter(pages[0]), pageFilter(pages[1]), pageFilter(pages[2])]).toEqual([grayStrong, null, grayStrong]);
  }, 60000);
});

describe('thin strokes on a large photo', () => {
  // 1 to 3 px black strokes at every phase of the shrink: horizontal in the top half, vertical in the bottom.
  function strokedPhoto(w: number) {
    const h = (w * 3) / 4;
    const surface = Skia.Surface.Make(w, h)!;
    const canvas = surface.getCanvas();
    canvas.clear(Skia.Color('white'));
    const black = Skia.Paint();
    black.setColor(Skia.Color('black'));
    black.setAntiAlias(false);
    const horizontal: { at: number; t: number }[] = [];
    const vertical: { at: number; t: number }[] = [];
    for (let at = 30, i = 0; at < h / 2 - 10; i++, at += 53 + ((i * 13) % 11)) {
      const t = (i % 3) + 1;
      horizontal.push({ at, t });
      canvas.drawRect(Skia.XYWHRect(0, at, w, t), black);
    }
    for (let at = 30, i = 0; at < w - 10; i++, at += 53 + ((i * 13) % 11)) {
      const t = (i % 3) + 1;
      vertical.push({ at, t });
      canvas.drawRect(Skia.XYWHRect(at, h / 2 + 10, t, h / 2 - 20), black);
    }
    const image = surface.makeImageSnapshot();
    black.dispose();
    surface.dispose();
    return { image, w, h, horizontal, vertical };
  }

  // How much darkness one stroke leaves in `copy`, as a share of what its area average would: 1 is exact.
  function residues(copy: SkImage, photo: ReturnType<typeof strokedPhoto>) {
    const sw = copy.width();
    const sh = copy.height();
    const k = sw / photo.w;
    const px = copy.readPixels(0, 0, { width: sw, height: sh, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul }) as Uint8Array;
    const grey = (x: number, y: number) => px[(y * sw + x) * 4];
    const around = (at: number, t: number, read: (i: number) => number) => {
      let dark = 0;
      const c = Math.floor((at + t / 2) * k);
      for (let d = -2; d <= 2; d++) dark += (255 - read(c + d)) / 255;
      return dark / (t * k);
    };
    return [
      ...photo.horizontal.map((s) => around(s.at, s.t, (y) => grey(sw >> 1, y))),
      ...photo.vertical.map((s) => around(s.at, s.t, (x) => grey(x, sh - (sh >> 2)))),
    ];
  }

  it.each([1600, 3024, 4032])('keeps every thin stroke in the small copy of a %i px photo', (w) => {
    const photo = strokedPhoto(w);
    const copy = shrunkCopy(photo.image, 500, Math.ceil((photo.h * 500) / w));
    const all = residues(copy, photo);
    // The area average is 1; a skipped stroke is 0. Measured worst case: 0.5 to 1.5.
    expect(Math.min(...all)).toBeGreaterThan(0.4);
    expect(Math.max(...all)).toBeLessThan(2);
    copy.dispose();
    photo.image.dispose();
  });

  it('treats identical faint strokes alike in the finished page of a 3024 px photo', () => {
    // 2 px strokes of one grey on off-white paper, 30 to 34 px apart, so they land at every phase of the
    // shrink. Clean at Light keeps faint marks only near writing, and that is found on the small copy.
    const w = 3024;
    const h = (w * 3) / 4;
    const surface = Skia.Surface.Make(w, h)!;
    const canvas = surface.getCanvas();
    canvas.clear(Skia.Color('rgb(246,244,238)'));
    const faint = Skia.Paint();
    faint.setColor(Skia.Color('rgb(160,160,160)'));
    faint.setAntiAlias(false);
    const ys: number[] = [];
    for (let i = 0, y = 100; y < h - 100; i++, y += 30 + ((i * 7) % 5)) {
      ys.push(y);
      canvas.drawRect(Skia.XYWHRect(w * 0.1, y, w * 0.8, 2), faint);
    }
    const photo = surface.makeImageSnapshot();
    const out = filterImage(photo, { kind: 'clean', strength: 0 });
    const px = out.readPixels(0, 0, { width: w, height: h, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul }) as Uint8Array;
    const midColumn = w >> 1;
    const darkest = ys.map((y) => Math.min(...[-2, -1, 0, 1, 2, 3, 4].map((d) => px[((y + d) * w + midColumn) * 4])));
    // Measured: each stroke lands at 236 with the mipmapped copy.
    expect(Math.max(...darkest)).toBeLessThan(250);
    expect(Math.max(...darkest) - Math.min(...darkest)).toBeLessThan(10);
    out.dispose();
    photo.dispose();
    faint.dispose();
    surface.dispose();
  }, 60000);

  function readPixels(out: SkImage): Uint8Array {
    return out.readPixels(0, 0, { width: out.width(), height: out.height(), colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul }) as Uint8Array;
  }

  // Specks and creases of 0.35 alpha black, far from the lines of writing at the top. A mark's
  // darkest pixel in the finished page is read.
  it('whitens faint specks and wide creases away from writing on a 1600 px photo at Clean Normal', () => {
    const w = 1600;
    const h = 1200;
    const surface = Skia.Surface.Make(w, h)!;
    const canvas = surface.getCanvas();
    canvas.drawColor(Skia.Color('rgb(235,228,210)'));
    const ink = Skia.Paint();
    ink.setColor(Skia.Color('rgb(35,35,40)'));
    for (let y = 100; y < 300; y += 40) canvas.drawRect(Skia.XYWHRect(100, y, 800, 12), ink);
    const faint = Skia.Paint();
    faint.setColor(Skia.Color('rgba(0,0,0,0.35)'));
    const marks: Record<string, [number, number, number, number]> = { crease3: [100, 700, 300, 3], crease6: [100, 800, 300, 6], speck3: [800, 600, 3, 3], speck8: [800, 800, 8, 8] };
    for (const [x, y, a, b] of Object.values(marks)) canvas.drawRect(Skia.XYWHRect(x, y, a, b), faint);
    const photo = surface.makeImageSnapshot();
    const out = filterImage(photo, { kind: 'clean', strength: 1 });
    const px = readPixels(out);
    const darkest = (x: number, y: number, a: number, b: number) => {
      let min = 255;
      for (let yy = y - 3; yy < y + b + 3; yy++) for (let xx = x - 3; xx < x + a + 3; xx++) min = Math.min(min, px[(yy * w + xx) * 4]);
      return min;
    };
    // Measured: all 255 but the 6 px crease, at about 228.
    expect(darkest(...marks.speck3)).toBeGreaterThan(245);
    expect(darkest(...marks.speck8)).toBeGreaterThan(245);
    expect(darkest(...marks.crease3)).toBeGreaterThan(245);
    expect(darkest(...marks.crease6)).toBeGreaterThan(225);
    out.dispose();
    photo.dispose();
    ink.dispose();
    faint.dispose();
    surface.dispose();
  }, 60000);

  // A form: warm paper under a grid of dark lines `width` px wide (0.8 gives each of the two pixel
  // rows or columns a line sits between about 40% ink). `size` is the photo's width; it is 4:3.
  function gridPage(size: number, width = 0.8): Uint8Array {
    const h = (size * 4) / 3;
    const surface = Skia.Surface.Make(size, h)!;
    const canvas = surface.getCanvas();
    canvas.drawColor(Skia.Color('rgb(235,228,210)'));
    const ink = Skia.Paint();
    ink.setColor(Skia.Color('rgb(35,35,40)'));
    for (let x = 100; x < size; x += 100) canvas.drawRect(Skia.XYWHRect(x + 1 - width / 2, 0, width, h), ink);
    for (let y = 100; y < h; y += 100) canvas.drawRect(Skia.XYWHRect(0, y + 1 - width / 2, size, width), ink);
    return surface.makeImageSnapshot().encodeToBytes(ImageFormat.JPEG, 95);
  }

  // Walks the line pixel pairs (the darker of the two a line sits between, along every line,
  // crossings included): the share darker than `limit`, and how many within 6 px of a crossing are not.
  function gridPairs(out: SkImage, size: number, limit: number) {
    const h = out.height();
    const px = readPixels(out);
    const at = (x: number, y: number) => (px[(y * size + x) * 4] + px[(y * size + x) * 4 + 1] + px[(y * size + x) * 4 + 2]) / 3;
    const near = (v: number) => v % 100 < 7 || v % 100 > 93;
    let dark = 0;
    let total = 0;
    let brokenAtCrossings = 0;
    const count = (pair: number, atCrossing: boolean) => {
      total++;
      if (pair < limit) dark++;
      else if (atCrossing) brokenAtCrossings++;
    };
    for (let x = 100; x < size; x += 100) for (let y = 0; y < h; y++) count(Math.min(at(x, y), at(x + 1, y)), near(y));
    for (let y = 100; y < h; y += 100) for (let x = 0; x < size; x++) count(Math.min(at(x, y), at(x, y + 1)), near(x));
    return { share: dark / total, brokenAtCrossings };
  }

  it.each([
    [1600, 'Normal', 0.8, 1],
    [3024, 'Normal', 0.8, 1],
    [1600, 'Light', 0.8, 0],
    [1600, 'Normal', 0.7, 1],
    [1600, 'Normal', 1.0, 1],
    [1600, 'Strong', 0.9, 2],
    [1600, 'Strong', 1.0, 2],
  ] as const)('keeps the thin dark grid of a form on a %i px photo at Clean %s with %f px lines', (size, _, width, strength) => {
    const photo = decode(gridPage(size, width));
    const out = filterImage(photo, { kind: 'clean', strength });
    try {
      // A line reads as unbroken when nearly every pixel along it stays grey or darker, and none at a crossing is lost.
      const { share, brokenAtCrossings } = gridPairs(out, size, 200);
      expect(share).toBeGreaterThan(0.97);
      expect(brokenAtCrossings).toBe(0);
    } finally {
      photo.dispose();
      out.dispose();
    }
  }, 60000);

  // A 2 px crease at 0.35 alpha has the pixels of a 0.8 px line, so Normal keeps it too (170); Strong's
  // lines must be 0.9 px or more, which keeps this one away.
  it('whitens a faint 2 px crease away from writing on a 1600 px photo at Clean Strong', () => {
    const w = 1600;
    const h = 1200;
    const surface = Skia.Surface.Make(w, h)!;
    const canvas = surface.getCanvas();
    canvas.drawColor(Skia.Color('rgb(235,228,210)'));
    const faint = Skia.Paint();
    faint.setColor(Skia.Color('rgba(0,0,0,0.35)'));
    canvas.drawRect(Skia.XYWHRect(100, 700, 300, 2), faint);
    const photo = surface.makeImageSnapshot();
    const out = filterImage(photo, { kind: 'clean', strength: 2 });
    const px = readPixels(out);
    let min = 255;
    for (let y = 697; y < 705; y++) for (let x = 97; x < 403; x++) min = Math.min(min, px[(y * w + x) * 4]);
    // Measured: 252.
    expect(min).toBeGreaterThan(225);
    out.dispose();
    photo.dispose();
    faint.dispose();
    surface.dispose();
  }, 60000);

  it('keeps a thin dark line tilted 2 degrees on a 1600 px photo at Clean Normal', () => {
    const w = 1600;
    const h = 1200;
    const surface = Skia.Surface.Make(w, h)!;
    const canvas = surface.getCanvas();
    canvas.drawColor(Skia.Color('rgb(235,228,210)'));
    const ink = Skia.Paint();
    ink.setColor(Skia.Color('rgb(35,35,40)'));
    ink.setAntiAlias(true);
    canvas.translate(100, 500);
    canvas.rotate(2, 0, 0);
    canvas.drawRect(Skia.XYWHRect(0, 0, 1400, 0.8), ink);
    const photo = surface.makeImageSnapshot();
    const out = filterImage(photo, { kind: 'clean', strength: 1 });
    const px = readPixels(out);
    // From a few pixels in from the ends, as a line is not kept right up to its end.
    let kept = 0;
    let total = 0;
    for (let x = 110; x < 1480; x++) {
      const y = Math.round(500 + (x - 100) * Math.tan((2 * Math.PI) / 180));
      total++;
      if (Math.min(...[-1, 0, 1, 2].map((d) => px[((y + d) * w + x) * 4])) < 200) kept++;
    }
    expect(kept / total).toBeGreaterThan(0.97);
    out.dispose();
    photo.dispose();
    ink.dispose();
    surface.dispose();
  }, 60000);
});
