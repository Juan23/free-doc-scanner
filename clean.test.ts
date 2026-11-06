/**
 * @jest-environment @shopify/react-native-skia/jestEnv.js
 */
/// <reference types="jest" />
import { BlurStyle, ImageFormat, Skia } from '@shopify/react-native-skia';

import { cleanPages, defaultFilter, setDefaultFilter } from './clean';

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

it('leaves a page it cannot read as it is, and cleans the rest', async () => {
  const broken = new Uint8Array([1, 2, 3]);
  mockFiles.set('file:///doc/scans/1/p1.jpg', broken);
  mockFiles.set('file:///doc/scans/1/p2.jpg', photographedPage());

  await cleanPages(['file:///doc/scans/1/p1.jpg', 'file:///doc/scans/1/p2.jpg']);

  expect(mockFiles.get('file:///doc/scans/1/p1.jpg')).toBe(broken);
  expect(luma(mockFiles.get('file:///doc/scans/1/p2.jpg')!, 30, 400)).toBeGreaterThan(245);
}, 30000);
