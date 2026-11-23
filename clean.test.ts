/**
 * @jest-environment @shopify/react-native-skia/jestEnv.js
 */
/// <reference types="jest" />
import {
  AlphaType, BlurStyle, ColorType, ImageFormat, Skia, type SkImage,
} from '@shopify/react-native-skia';

import { cleanPages, defaultFilter, filterImage, filterPreviews, markDarkBackground, pageFilter, setDefaultFilter, sharedFilter, shrunkCopy, strengthPreview, type Filter } from './clean';
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

it('keeps more faint ink halfway between Light and Normal than at Normal, and less than at Light', () => {
  // Marks at 88% of the paper's brightness, which Normal wipes.
  const photo = decode(faintPage('rgb(207,201,185)'));
  // The darkness left over the line of faint marks.
  const ink = (strength: number) => {
    const out = filterImage(photo, { kind: 'clean', strength });
    const px = readPixels(out);
    out.dispose();
    let sum = 0;
    for (let y = 370; y < 460; y++) for (let x = 140; x < 460; x++) sum += 255 - px[(y * W + x) * 4];
    return sum;
  };
  const [light, half, normal] = [0, 0.5, 1].map(ink);
  photo.dispose();
  // Measured: 390778, 42998 and 0.
  expect(half).toBeLessThan(light);
  expect(half).toBeGreaterThan(normal);
}, 30000);

it('reads an old filter file and records with steps 0, 1 or 2, any strength between, and nothing else', () => {
  const write = (uri: string, text: string) => mockFiles.set(uri, Uint8Array.from(text, (c) => c.charCodeAt(0)));
  write('file:///doc/filter', '{"kind":"gray","strength":1}');
  expect(defaultFilter()).toEqual({ kind: 'gray', strength: 1 });

  const read = (text: string) => {
    write(SIDECAR1, text);
    return pageFilter(PAGE1);
  };
  expect(read('{"kind":"clean","strength":0}')).toEqual({ kind: 'clean', strength: 0 });
  expect(read('{"kind":"clean","strength":0.5}')).toEqual({ kind: 'clean', strength: 0.5 });
  expect(read('{"kind":"clean","strength":2}')).toEqual({ kind: 'clean', strength: 2 });
  expect(read('{"kind":"clean","strength":2.5}')).toBeNull();
  expect(read('{"kind":"clean","strength":-0.5}')).toBeNull();
  expect(read('{"kind":"clean","strength":"1"}')).toBeNull();
});

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

function readPixels(image: SkImage): Uint8Array {
  return image.readPixels(0, 0, { width: image.width(), height: image.height(), colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul }) as Uint8Array;
}

// A fixed-seed random generator in [0, 1), so fixtures repeat.
function seededRandom(seed: number): () => number {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

// The mean of a pixel's colour channels in RGBA bytes W wide.
function channelMean(px: Uint8Array, x: number, y: number): number {
  const i = (y * W + x) * 4;
  return (px[i] + px[i + 1] + px[i + 2]) / 3;
}

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
  const pa = readPixels(a);
  const pb = readPixels(b);
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
      // Cleaned at 500 px then shrunk, a preview sits 0.50 to 0.72 off the stored page, so the bound is 1.
      expect(meanDifference(preview, stored)).toBeLessThan(1);
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

it('Original on an older page records Original and leaves the page as it is', async () => {
  // The older page as stored: its clean-up is already in it.
  const older = photographedPage();
  mockFiles.set(PAGE1, older);
  await cleanPages([PAGE1], { kind: 'clean', strength: 1 });

  await cleanPages([PAGE1], { kind: 'original', strength: 1 });

  expect(pageFilter(PAGE1)).toEqual({ kind: 'original', strength: 1 });
  expect(mockFiles.get(PAGE1)).toEqual(older);
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

it('measures the paper and ink once for the Clean and Grayscale previews of a page', async () => {
  mockFiles.set(PAGE1, photographedPage());
  // The analysis ends by making the past-edge mask; nothing else here makes one.
  const analyses = jest.spyOn(Skia.Image, 'MakeImage');

  try {
    const previews = (await filterPreviews(PAGE1, 150))!;
    for (const p of Object.values(previews)) p.dispose();

    expect(analyses).toHaveBeenCalledTimes(1);
  } finally {
    analyses.mockRestore();
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

const settle = () => new Promise((r) => setTimeout(r, 50));

describe('the strength slider\'s live preview', () => {
  it('filters only the latest of quick moves, and shows the page storing it would give, shrunk to the screen', async () => {
    const photo = photographedPage();
    mockFiles.set(PAGE1, photo);
    const files = new Map(mockFiles);
    const shown: SkImage[] = [];
    const live = strengthPreview(PAGE1, 300, (image) => image && shown.push(image));

    live.preview({ kind: 'clean', strength: 0 });
    live.preview({ kind: 'clean', strength: 0.5 });
    live.preview({ kind: 'gray', strength: 2 });
    while (!shown.length) await settle();
    await settle();

    const source = decode(photo);
    const stored = filterImage(source, { kind: 'gray', strength: 2 });
    const onScreen = shrunkCopy(stored, 300, 400);
    try {
      expect(shown.length).toBe(1);
      expect(shown[0].width()).toBe(300);
      expect(meanDifference(shown[0], onScreen)).toBeLessThan(0.05);
      expect(mockFiles).toEqual(files);
    } finally {
      live.stop();
      for (const image of [source, stored, onScreen, ...shown]) image.dispose();
    }
  }, 30000);

  it('shows nothing once stopped, even for a move asked for just before', async () => {
    mockFiles.set(PAGE1, photographedPage());
    const shown: SkImage[] = [];
    const live = strengthPreview(PAGE1, 300, (image) => image && shown.push(image));

    live.preview({ kind: 'clean', strength: 2 });
    live.stop();
    await settle();
    live.preview({ kind: 'clean', strength: 0 });
    await settle();
    await live.finish({ kind: 'gray', strength: 1 });
    await settle();

    expect(shown.length).toBe(0);
  }, 30000);

  it('warms up without drawing anything, then shows the next move', async () => {
    mockFiles.set(PAGE1, photographedPage());
    const shown: SkImage[] = [];
    const live = strengthPreview(PAGE1, W, (image) => image && shown.push(image));

    live.warm({ kind: 'clean', strength: 1 });
    await settle();
    const afterWarm = shown.length;
    live.preview({ kind: 'clean', strength: 2 });
    while (!shown.length) await settle();
    live.stop();

    expect(afterWarm).toBe(0);
    expect(shown.length).toBe(1);
    for (const image of shown) image.dispose();
  }, 30000);

  it('clears the screen and stops when the photo cannot be read', async () => {
    const shown: (SkImage | null)[] = [];
    const live = strengthPreview(PAGE1, W, (image) => shown.push(image));

    live.preview({ kind: 'clean', strength: 1 });
    await settle();
    live.preview({ kind: 'clean', strength: 2 });
    await settle();

    expect(shown).toEqual([null]);
  }, 30000);

  it('on finish of a warm run that has drawn nothing, still draws the stored strength', async () => {
    const photo = photographedPage();
    mockFiles.set(PAGE1, photo);
    const shown: SkImage[] = [];
    const live = strengthPreview(PAGE1, W, (image) => image && shown.push(image));

    live.warm({ kind: 'clean', strength: 1 });
    await live.finish({ kind: 'clean', strength: 1.2 });
    await settle();

    const source = decode(photo);
    const direct = filterImage(source, { kind: 'clean', strength: 1.2 }, W);
    try {
      expect(shown.length).toBe(1);
      expect(meanDifference(shown[0], direct)).toBeLessThan(0.05);
      expect(live.isStopped()).toBe(true);
    } finally {
      for (const image of [source, direct, ...shown]) image.dispose();
    }
  }, 30000);

  it('on finish with the strength already shown, draws no extra pass', async () => {
    mockFiles.set(PAGE1, photographedPage());
    const shown: SkImage[] = [];
    const live = strengthPreview(PAGE1, W, (image) => image && shown.push(image));

    live.preview({ kind: 'clean', strength: 1.5 });
    while (!shown.length) await settle();
    await live.finish({ kind: 'clean', strength: 1.5 });
    await settle();

    expect(shown.length).toBe(1);
    for (const image of shown) image.dispose();
  }, 30000);

  it('on finish, shows the strength being stored last, then nothing more', async () => {
    const photo = photographedPage();
    mockFiles.set(PAGE1, photo);
    const shown: SkImage[] = [];
    const live = strengthPreview(PAGE1, W, (image) => image && shown.push(image));

    live.preview({ kind: 'clean', strength: 0 });
    await live.finish({ kind: 'gray', strength: 2 });
    live.preview({ kind: 'clean', strength: 1 });
    await settle();

    const source = decode(photo);
    const direct = filterImage(source, { kind: 'gray', strength: 2 }, W);
    try {
      expect(shown.length).toBe(1);
      expect(meanDifference(shown[0], direct)).toBeLessThan(0.05);
    } finally {
      for (const image of [source, direct, ...shown]) image.dispose();
    }
  }, 30000);
});

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
    const px = readPixels(copy);
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
    const px = readPixels(out);
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

  // A 3 px or wider crease is dark in all three pixels, so a darker one (0.4 alpha) goes white too.
  // Measured: 255 at 3 px, 251 at 4 and 5 px (Normal), 255 at 3 px (Strong).
  it('whitens 0.4 alpha creases 3 to 5 px wide at Clean Normal and a 3 px one at Strong', () => {
    const w = 1600;
    const h = 1200;
    const surface = Skia.Surface.Make(w, h)!;
    const canvas = surface.getCanvas();
    canvas.drawColor(Skia.Color('rgb(235,228,210)'));
    const ink = Skia.Paint();
    ink.setColor(Skia.Color('rgb(35,35,40)'));
    for (let y = 100; y < 300; y += 40) canvas.drawRect(Skia.XYWHRect(100, y, 800, 12), ink);
    const faint = Skia.Paint();
    faint.setColor(Skia.Color('rgba(0,0,0,0.4)'));
    const widths = [3, 4, 5];
    widths.forEach((m, i) => canvas.drawRect(Skia.XYWHRect(100, 550 + i * 120, 300, m), faint));
    const photo = surface.makeImageSnapshot();
    const darkest = (strength: 1 | 2) => {
      const out = filterImage(photo, { kind: 'clean', strength });
      const px = readPixels(out);
      out.dispose();
      return widths.map((m, i) => {
        let min = 255;
        for (let y = 550 + i * 120 - 3; y < 550 + i * 120 + m + 3; y++) for (let x = 97; x < 403; x++) min = Math.min(min, px[(y * w + x) * 4]);
        return min;
      });
    };
    expect(darkest(1).every((d) => d > 245)).toBe(true);
    expect(darkest(2)[0]).toBeGreaterThan(245);
    photo.dispose();
    ink.dispose();
    faint.dispose();
    surface.dispose();
  }, 120000);

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
    [1600, 'Normal', 1.1, 1],
    [1600, 'Normal', 1.2, 1],
    [3024, 'Normal', 0.7, 1],
    [3024, 'Strong', 0.9, 2],
    [1600, 'Strong', 0.9, 2],
    [1600, 'Strong', 1.0, 2],
    [1600, 'Strong', 1.2, 2],
  ] as const)('keeps the thin dark grid of a form on a %i px photo at Clean %s with %s px lines', (size, _, width, strength) => {
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

describe('table lines', () => {
  // A 1600 x 2000 table on warm paper: a bar of dark text at the top, then 1400 px lines 1 and 2 px
  // wide at four greys, far from the text.
  const GREYS = [100, 130, 150, 180];
  const lines = GREYS.flatMap((grey, i) => [1, 2].map((width, j) => ({ grey, width, y: 500 + (i * 2 + j) * 160 })));

  function tablePhoto(): SkImage {
    const surface = Skia.Surface.Make(1600, 2000)!;
    const canvas = surface.getCanvas();
    canvas.drawColor(Skia.Color('rgb(230,224,208)'));
    const paint = Skia.Paint();
    paint.setColor(Skia.Color('rgb(35,35,40)'));
    canvas.drawRect(Skia.XYWHRect(100, 200, 1400, 16), paint);
    for (const { grey, width, y } of lines) {
      paint.setColor(Skia.Color(`rgb(${grey},${grey},${grey})`));
      canvas.drawRect(Skia.XYWHRect(100, y, 1400, width), paint);
    }
    return decode(surface.makeImageSnapshot().encodeToBytes(ImageFormat.JPEG, 95));
  }

  // The darkest pixel along each line, from 10 px in from its ends: 255 is gone.
  function darkestAlong(out: SkImage): number[] {
    const px = readPixels(out);
    return lines.map(({ width, y }) => {
      let min = 255;
      for (let yy = y - 3; yy < y + width + 3; yy++) for (let x = 110; x < 1490; x++) min = Math.min(min, px[(yy * 1600 + x) * 4]);
      return min;
    });
  }

  it.each([
    ['clean', 0], ['clean', 1], ['clean', 2], ['gray', 0], ['gray', 1], ['gray', 2],
  ] as const)('keeps printed table lines at %s strength %i', (kind, strength) => {
    const photo = tablePhoto();
    const out = filterImage(photo, { kind, strength });
    const darkest = darkestAlong(out);
    out.dispose();
    photo.dispose();
    // Measured: 37 to 189 for every line at Light and Normal; at Strong 37 to 160 for greys 100 and
    // 130, 255 for 150 and 180. Strong may whiten those, as it does faint pencil.
    const kept = lines.map((l, i) => [l.grey, l.width, strength < 2 || l.grey <= 130 ? darkest[i] <= 200 : true]);
    expect(kept).toEqual(lines.map((l) => [l.grey, l.width, true]));
  }, 60000);

  it('previews pale table lines a narrow screen alone would whiten, as the stored page keeps them', async () => {
    const drawn = tablePhoto();
    const bytes = drawn.encodeToBytes(ImageFormat.JPEG, 95);
    drawn.dispose();
    mockFiles.set(PAGE1, bytes);
    const shown: SkImage[] = [];
    const live = strengthPreview(PAGE1, 400, (image) => image && shown.push(image));
    live.preview({ kind: 'clean', strength: 1 });
    while (!shown.length) await settle();
    live.stop();

    const source = decode(bytes);
    const stored = filterImage(source, { kind: 'clean', strength: 1 });
    const onScreen = shrunkCopy(stored, 400, 500);
    try {
      // Filtering at the screen's 400 px instead whitens every pale line, which pages under 1000 px get.
      expect(meanDifference(shown[0], onScreen)).toBeLessThan(0.05);
    } finally {
      for (const image of [source, stored, onScreen, ...shown]) image.dispose();
    }
  }, 120000);

  // FNV-1a over an image's pixels.
  const hash = (image: SkImage) => readPixels(image).reduce((h, v) => Math.imul(h ^ v, 16777619) >>> 0, 2166136261);

  it('gives the same pixels at strengths 0, 1 and 2 as Light, Normal and Strong did', () => {
    const photo = tablePhoto();
    const got = [0, 1, 2].map((strength) => {
      const out = filterImage(photo, { kind: 'clean', strength });
      const h = hash(out);
      out.dispose();
      return h;
    });
    photo.dispose();
    // Measured before the strength became a number. Skia's own changes can move them: re-measure then.
    expect(got).toEqual([3552159371, 365768292, 1287771065]);
  }, 120000);
});

describe('text in a small preview', () => {
  const CanvasKit = (globalThis as any).CanvasKit;
  const W = 1200;
  const H = 1600;
  const PITCH = 64;
  const FIRST = 120;
  const LINES = 22;
  const TEXT = ['The quick brown fox jumps over', 'the lazy dog while a second', 'sentence follows with five dozen'];

  // Dark text lines on shadowed paper, like a phone photo of an invoice.
  function textPhoto(): SkImage {
    const surface = CanvasKit.MakeSurface(W, H);
    const canvas = surface.getCanvas();
    const paper = new CanvasKit.Paint();
    for (let x = 0; x < W; x += 10) {
      const t = x / W;
      paper.setColor(CanvasKit.Color(Math.round(235 - 40 * t), Math.round(228 - 40 * t), Math.round(210 - 40 * t)));
      canvas.drawRect(CanvasKit.XYWHRect(x, 0, 10, H), paper);
    }
    const ink = new CanvasKit.Paint();
    ink.setColor(CanvasKit.Color(35, 35, 60));
    ink.setAntiAlias(true);
    const font = new CanvasKit.Font(CanvasKit.Typeface.GetDefault(), 30);
    for (let i = 0; i < LINES; i++) canvas.drawText(TEXT[i % 3], 100, FIRST + i * PITCH, ink, font);
    const bytes = surface.makeImageSnapshot().encodeToBytes(CanvasKit.ImageFormat.JPEG, 92);
    font.delete();
    paper.delete();
    ink.delete();
    surface.delete();
    return Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(bytes))!;
  }

  // The share of columns holding ink along each text line, over the columns the line spans.
  function inkShares(preview: SkImage): number[] {
    const w = preview.width();
    const h = preview.height();
    const k = w / W;
    const px = readPixels(preview);
    const shares: number[] = [];
    for (let i = 0; i < LINES; i++) {
      const top = Math.floor((FIRST + i * PITCH - 26) * k);
      const bottom = Math.ceil((FIRST + i * PITCH + 8) * k);
      const rows = (x: number) => Array.from({ length: bottom - top + 1 }, (_, j) => Math.min(h - 1, top + j)).map((y) => px[(y * w + x) * 4 + 1]);
      let paper = 0;
      for (let x = 0; x < w; x++) paper = Math.max(paper, ...rows(x));
      let spans = 0;
      let inked = 0;
      for (let x = Math.floor(100 * k); x < Math.floor(820 * k); x++) {
        spans++;
        if (Math.min(...rows(x)) < 0.75 * paper) inked++;
      }
      shares.push(inked / spans);
    }
    return shares;
  }

  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;

  it.each([
    ['clean', 0], ['clean', 1], ['clean', 2], ['gray', 0], ['gray', 1], ['gray', 2],
  ] as const)('keeps every line of text whole in a 132 px %s thumbnail at strength %i', (kind, strength) => {
    const photo = textPhoto();
    const original = filterImage(photo, { kind: 'original', strength: 1 }, 132);
    const small = filterImage(photo, { kind, strength }, 132);
    const wanted = inkShares(original);
    const got = inkShares(small);
    // Fragmented text keeps 66-77% of its columns on average (worst line 33-48%); whole text keeps
    // 74-100% (worst line 62-86%). Strong cleans the faint edges of thin strokes away.
    expect(mean(got) / mean(wanted)).toBeGreaterThanOrEqual(0.7);
    got.forEach((g, i) => expect(g / wanted[i]).toBeGreaterThanOrEqual(0.55));
    original.dispose();
    small.dispose();
    photo.dispose();
  }, 60000);
});

describe('pale text on a large photo', () => {
  const CanvasKit = (globalThis as any).CanvasKit;
  const W = 3024;
  const PAPER = 220;
  const SIZES = [24, 32, 44];
  const GREYS = [140, 165];
  const PITCH = 110;
  const rows = SIZES.flatMap((size) => GREYS.map((grey) => ({ size, grey })));

  // Lines of small grey print on grey paper, like a printed CV photographed in room light.
  function palePhoto(): SkImage {
    const surface = CanvasKit.MakeSurface(W, rows.length * PITCH + 100);
    const canvas = surface.getCanvas();
    canvas.clear(CanvasKit.Color(PAPER, PAPER, PAPER - 6));
    const ink = new CanvasKit.Paint();
    ink.setAntiAlias(true);
    rows.forEach(({ size, grey }, i) => {
      const font = new CanvasKit.Font(CanvasKit.Typeface.GetDefault(), size);
      ink.setColor(CanvasKit.Color(grey, grey, grey));
      canvas.drawText('Date of Birth : 03/16/1996  To work with a company that can provide growth', 150, 100 + i * PITCH, ink, font);
      font.delete();
    });
    const bytes = surface.makeImageSnapshot().encodeToBytes(CanvasKit.ImageFormat.JPEG, 92);
    ink.delete();
    surface.delete();
    return decode(bytes);
  }

  const CORE_DARKNESS = 0.9;
  const KEPT_CORE_SHARE = 0.9;

  function keptCoreShareByLine(photo: SkImage, out: SkImage): number[] {
    const before = readPixels(photo);
    const after = readPixels(out);
    return rows.map(({ size, grey }, i) => {
      let ink = 0;
      let kept = 0;
      for (let y = 100 + i * PITCH - size; y < 100 + i * PITCH + size / 3; y++) {
        for (let x = 100; x < W - 100; x++) {
          const p = (y * W + x) * 4;
          if (before[p + 1] > PAPER - CORE_DARKNESS * (PAPER - grey)) continue;
          ink++;
          if (after[p + 1] < 250) kept++;
        }
      }
      return kept / ink;
    });
  }

  it.each([['clean', 1], ['clean', 2], ['gray', 1]] as const)('keeps grey 140 and 165 print on grey 220 paper whole at %s strength %i', (kind, strength) => {
    const photo = palePhoto();
    const out = filterImage(photo, { kind, strength });
    const shares = keptCoreShareByLine(photo, out);
    out.dispose();
    photo.dispose();
    expect(rows.map((r, i) => [r.size, r.grey, shares[i] > KEPT_CORE_SHARE])).toEqual(rows.map((r) => [r.size, r.grey, true]));
  }, 120000);
});

describe('paper around text on a large photo', () => {
  const CanvasKit = (globalThis as any).CanvasKit;
  const W = 1200;
  const PAPER = 220;
  const SPECKLE = 0.89;
  const SPECKLE_SHARE = 0.15;
  const LINES = [
    { size: 24, grey: 20 },
    { size: 24, grey: 150 },
    { size: 32, grey: 20 },
  ];
  const PITCH = 100;
  const BASELINE = 80;
  const WHITE_SHARE = 0.95;

  // Printed lines on paper with darker pixels like grain or dust.
  function speckledPage(): { photo: SkImage; speckles: number[] } {
    const H = LINES.length * PITCH + 60;
    const surface = CanvasKit.MakeSurface(W, H);
    const canvas = surface.getCanvas();
    canvas.clear(CanvasKit.Color(PAPER, PAPER, PAPER - 6));
    const ink = new CanvasKit.Paint();
    ink.setAntiAlias(true);
    LINES.forEach(({ size, grey }, i) => {
      const font = new CanvasKit.Font(CanvasKit.Typeface.GetDefault(), size);
      ink.setColor(CanvasKit.Color(grey, grey, grey));
      canvas.drawText('Date of Birth : 03/16/1996  To work with a company that can provide growth', 60, BASELINE + i * PITCH, ink, font);
      font.delete();
    });
    const drawn = decode(surface.makeImageSnapshot().encodeToBytes(CanvasKit.ImageFormat.PNG));
    const rgba = readPixels(drawn);
    drawn.dispose();
    ink.delete();
    surface.delete();
    const speckles: number[] = [];
    let seed = 12345;
    for (let p = 0; p < W * H * 4; p += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const bare = rgba[p] === PAPER && rgba[p + 1] === PAPER && rgba[p + 2] === PAPER - 6;
      if (bare && seed / 2 ** 32 < SPECKLE_SHARE) {
        for (let c = 0; c < 3; c++) rgba[p + c] = Math.round(rgba[p + c] * SPECKLE);
        speckles.push(p);
      }
    }
    const photo = Skia.Image.MakeImage({ width: W, height: H, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul }, Skia.Data.fromBytes(rgba), W * 4)!;
    return { photo, speckles };
  }

  function whiteShareByLine(speckles: number[], out: SkImage): number[] {
    const after = readPixels(out);
    return LINES.map(({ size }, i) => {
      const beside = speckles.filter((p) => {
        const y = Math.floor(p / 4 / W);
        return y > BASELINE + i * PITCH - size && y < BASELINE + i * PITCH + size / 3;
      });
      return beside.filter((p) => after[p + 1] >= 250).length / beside.length;
    });
  }

  it('whitens faint grain among printed lines at Clean Normal', () => {
    const { photo, speckles } = speckledPage();
    const out = filterImage(photo, { kind: 'clean', strength: 1 });
    const shares = whiteShareByLine(speckles, out);
    out.dispose();
    photo.dispose();
    expect(shares.map((s) => s > WHITE_SHARE)).toEqual(LINES.map(() => true));
  }, 120000);
});

describe('dark background', () => {
  type Rect = [number, number, number, number];
  const DARK_TABLE: [number, number, number] = [56, 48, 44];
  const PAGE_20_PERCENT: Rect = [380, 133, 180, 534];

  // A noisy, slightly coloured table with dust, the page on it (rgb 235,232,224) with dark print, and
  // optionally a dark picture on the page with print on it.
  function pageOnTable(table: [number, number, number], page: Rect, picture?: Rect): SkImage {
    const rgba = new Uint8Array(W * H * 4);
    const rand = seededRandom(98765);
    const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
    for (let i = 0; i < W * H * 4; i += 4) {
      const grain = (rand() - 0.5) * 24;
      const dust = rand() < 0.02 ? 45 : 0;
      for (let c = 0; c < 3; c++) rgba[i + c] = byte(table[c] + grain + (rand() - 0.5) * 14 + dust);
      rgba[i + 3] = 255;
    }
    const bg = Skia.Image.MakeImage(
      { width: W, height: H, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul },
      Skia.Data.fromBytes(rgba),
      W * 4,
    )!;
    const surface = Skia.Surface.Make(W, H)!;
    const canvas = surface.getCanvas();
    canvas.drawImage(bg, 0, 0);
    bg.dispose();
    const paint = Skia.Paint();
    paint.setColor(Skia.Color('rgb(235,232,224)'));
    canvas.drawRect(Skia.XYWHRect(...page), paint);
    paint.setColor(Skia.Color('rgb(35,35,40)'));
    const [px, py, pw, ph] = page;
    // Rows stop 160 px above the page's foot, where a picture may sit.
    for (let y = py + 67; y < py + ph - 160; y += 60) canvas.drawRect(Skia.XYWHRect(px + 20, y, pw - 40, 12), paint);
    if (picture) {
      paint.setColor(Skia.Color('rgb(72,76,82)'));
      canvas.drawRect(Skia.XYWHRect(...picture), paint);
      paint.setColor(Skia.Color('rgb(20,22,26)'));
      canvas.drawRect(Skia.XYWHRect(picture[0] + 10, picture[1] + 20, picture[2] - 20, 10), paint);
      canvas.drawRect(Skia.XYWHRect(picture[0] + 10, picture[1] + 60, picture[2] - 20, 10), paint);
    }
    const bytes = surface.makeImageSnapshot().encodeToBytes(ImageFormat.JPEG, 92);
    paint.dispose();
    surface.dispose();
    return decode(bytes);
  }

  // Well-framed page with dark text, a dark picture (360 x 240 px, so 300 x 200 px on a 500 px copy)
  // and a dark band with light text (60 px, 50 on a 500 px copy), and a dark picture bleeding off the
  // top right corner that is 11.7% of the frame.
  function pageWithDarkPicture(): SkImage {
    const surface = Skia.Surface.Make(W, H)!;
    const canvas = surface.getCanvas();
    canvas.drawColor(Skia.Color('rgb(235,228,210)'));
    const paint = Skia.Paint();
    paint.setColor(Skia.Color('rgb(35,35,40)'));
    for (const y of [80, 130]) canvas.drawRect(Skia.XYWHRect(60, y, 320, 12), paint);
    for (const y of [620, 670]) canvas.drawRect(Skia.XYWHRect(60, y, 480, 12), paint);
    paint.setColor(Skia.Color('rgb(60,64,70)'));
    canvas.drawRect(Skia.XYWHRect(60, 520, 480, 60), paint);
    paint.setColor(Skia.Color('rgb(235,228,210)'));
    canvas.drawRect(Skia.XYWHRect(80, 544, 440, 12), paint);
    paint.setColor(Skia.Color('rgb(72,76,82)'));
    canvas.drawRect(Skia.XYWHRect(120, 300, 360, 200), paint);
    canvas.drawRect(Skia.XYWHRect(400, 0, 200, 280), paint);
    paint.setColor(Skia.Color('rgb(20,22,26)'));
    for (let y = 325; y < 480; y += 26) canvas.drawRect(Skia.XYWHRect(140, y, 320, 10), paint);
    for (let y = 40; y < 260; y += 50) canvas.drawRect(Skia.XYWHRect(420, y, 160, 10), paint);
    const bytes = surface.makeImageSnapshot().encodeToBytes(ImageFormat.JPEG, 95);
    paint.dispose();
    surface.dispose();
    return decode(bytes);
  }

  // Filtered `photo` (which this frees); the table's share of white pixels and mean colour spread
  // over x < `tableWidth`, and the output's pixels.
  function cleanedTable(photo: SkImage, tableWidth: number, filter: Filter = { kind: 'clean', strength: 1 }) {
    const out = filterImage(photo, filter);
    const px = readPixels(out);
    let white = 0;
    let spreadSum = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < tableWidth; x++) {
        const i = (y * W + x) * 4;
        if (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2] >= 245) white++;
        spreadSum += Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2]);
      }
    }
    out.dispose();
    photo.dispose();
    return { white: white / (H * tableWidth), spread: spreadSum / (H * tableWidth), px };
  }

  it('turns a dark, noisy, slightly coloured background near white with little colour spread and keeps print', () => {
    const { white, spread, px } = cleanedTable(pageOnTable(DARK_TABLE, PAGE_20_PERCENT), 360);
    expect(white).toBeGreaterThan(0.98);
    expect(spread).toBeLessThan(2);
    expect(channelMean(px, 470, 206)).toBeLessThan(60);
    expect(channelMean(px, 470, 326)).toBeLessThan(60);
    expect(channelMean(px, 470, 230)).toBeGreaterThan(245);
  }, 30000);

  it('whitens a dark background and keeps print at Light, Strong and Grayscale', () => {
    for (const filter of [
      { kind: 'clean', strength: 0 },
      { kind: 'clean', strength: 2 },
      { kind: 'gray', strength: 1 },
    ] as Filter[]) {
      const { white, spread, px } = cleanedTable(pageOnTable(DARK_TABLE, PAGE_20_PERCENT), 360, filter);
      expect(white).toBeGreaterThan(0.98);
      expect(spread).toBeLessThan(2);
      expect(channelMean(px, 470, 206)).toBeLessThan(60);
      expect(channelMean(px, 470, 230)).toBeGreaterThan(245);
    }
  }, 60000);

  it('keeps print inside a dark picture on the page', () => {
    const { px } = cleanedTable(pageOnTable(DARK_TABLE, PAGE_20_PERCENT, [400, 560, 140, 100]), 360);
    expect(channelMean(px, 470, 585)).toBeLessThan(80);
    expect(channelMean(px, 470, 625)).toBeLessThan(80);
  }, 30000);

  // A 180 px strip, deeper than a bent page edge can be.
  it('whitens a background that covers 37% of the frame', () => {
    const { white } = cleanedTable(pageOnTable(DARK_TABLE, [180, 20, 400, 760]), 150);
    expect(white).toBeGreaterThan(0.98);
  }, 30000);

  // Like a receipt running off the photo's right edge, with the table above, below and to its left.
  it('whitens the table round a page that runs off the frame\'s edge', () => {
    const { white, spread, px } = cleanedTable(pageOnTable(DARK_TABLE, [300, 100, 300, 600]), 280);
    expect(white).toBeGreaterThan(0.98);
    expect(spread).toBeLessThan(2);
    expect(channelMean(px, 450, 173)).toBeLessThan(60);
    expect(channelMean(px, 450, 200)).toBeGreaterThan(245);
  }, 30000);

  // A page on the table with a dark green header, a navy band across it and a near-black footer, each
  // holding a row of light text: printed colours, unlike the table's. Each band is probed beside the
  // paper, where Clean keeps even a band it does not mark.
  it('keeps a dark header, footer and band across the page, each with light text', () => {
    const photo = pageOnTable(DARK_TABLE, [150, 100, 300, 600]);
    const surface = Skia.Surface.Make(W, H)!;
    const canvas = surface.getCanvas();
    canvas.drawImage(photo, 0, 0);
    photo.dispose();
    const paint = Skia.Paint();
    // Colour, top and the row beside the paper; the rows of print sit clear of each band.
    const bands: [string, number, number][] = [['rgb(40,80,50)', 100, 132], ['rgb(30,40,90)', 303, 311], ['rgb(25,25,28)', 660, 668]];
    for (const [colour, top] of bands) {
      paint.setColor(Skia.Color(colour));
      canvas.drawRect(Skia.XYWHRect(150, top, 300, 40), paint);
      paint.setColor(Skia.Color('rgb(235,232,224)'));
      canvas.drawRect(Skia.XYWHRect(180, top + 15, 240, 10), paint);
    }
    const banded = decode(surface.makeImageSnapshot().encodeToBytes(ImageFormat.JPEG, 92));
    paint.dispose();
    surface.dispose();
    const { white, px } = cleanedTable(banded, 130);
    expect(white).toBeGreaterThan(0.98);
    for (const [, top, beside] of bands) {
      expect(channelMean(px, 300, beside)).toBeLessThan(110);
      expect(channelMean(px, 300, top + 20) - channelMean(px, 300, beside)).toBeGreaterThan(60);
    }
  }, 30000);

  // A magazine photo with light captions, deeper than print along a page's edge reaches (a quarter of the page's width).
  it.each([
    ['ends on the table', 600, [555, 655]],
    ['runs off the photo', 700, [555, 755]],
  ] as const)('keeps a dark picture bleeding off the foot of a page that %s, however deep', (_, pageHeight, captions) => {
    const photo = pageOnTable(DARK_TABLE, [150, 100, 300, pageHeight]);
    const surface = Skia.Surface.Make(W, H)!;
    const canvas = surface.getCanvas();
    canvas.drawImage(photo, 0, 0);
    photo.dispose();
    const paint = Skia.Paint();
    paint.setColor(Skia.Color('rgb(30,40,90)'));
    canvas.drawRect(Skia.XYWHRect(150, 540, 300, pageHeight - 440), paint);
    paint.setColor(Skia.Color('rgb(235,232,224)'));
    for (const top of captions) canvas.drawRect(Skia.XYWHRect(180, top, 240, 10), paint);
    const pictured = decode(surface.makeImageSnapshot().encodeToBytes(ImageFormat.JPEG, 92));
    paint.dispose();
    surface.dispose();
    const { white, px } = cleanedTable(pictured, 130);
    expect(white).toBeGreaterThan(0.98);
    for (const top of captions) expect(channelMean(px, 300, top + 5) - channelMean(px, 300, top - 7)).toBeGreaterThan(60);
  }, 30000);

  it('whitens a table at 0.32 of the paper', () => {
    expect(cleanedTable(pageOnTable([85, 73, 67], PAGE_20_PERCENT), 360).white).toBeGreaterThan(0.98);
  }, 30000);

  // Like a black book cover photographed on a white table: the table is the frame's paper.
  it('keeps light text on a dark page that joins the border', () => {
    const surface = Skia.Surface.Make(W, H)!;
    const canvas = surface.getCanvas();
    canvas.drawColor(Skia.Color('rgb(40,38,36)'));
    const paint = Skia.Paint();
    paint.setColor(Skia.Color('rgb(235,232,224)'));
    canvas.drawRect(Skia.XYWHRect(0, 700, W, 100), paint);
    paint.setColor(Skia.Color('rgb(200,190,150)'));
    for (let y = 100; y < 650; y += 60) canvas.drawRect(Skia.XYWHRect(60, y, 480, 10), paint);
    const photo = decode(surface.makeImageSnapshot().encodeToBytes(ImageFormat.JPEG, 95));
    paint.dispose();
    surface.dispose();
    const out = filterImage(photo, { kind: 'clean', strength: 1 });
    const px = readPixels(out);
    // Each text row still stands out from the page right beside it.
    for (let y = 100; y < 650; y += 60) expect(channelMean(px, 300, y + 5) - channelMean(px, 300, y - 4)).toBeGreaterThan(60);
    out.dispose();
    photo.dispose();
  }, 30000);

  it('keeps a dark picture inside a well-framed page and one bleeding off its corner', () => {
    const photo = pageWithDarkPicture();
    const out = filterImage(photo, { kind: 'clean', strength: 1 });
    const px = readPixels(out);
    for (const y of [330, 382, 434]) expect(channelMean(px, 300, y)).toBeLessThan(80);
    for (const y of [45, 95, 145, 195, 245]) expect(channelMean(px, 500, y)).toBeLessThan(80);
    expect(channelMean(px, 300, 530)).toBeLessThan(80);
    expect(channelMean(px, 300, 86)).toBeLessThan(60);
    expect(channelMean(px, 300, 200)).toBeGreaterThan(245);
    out.dispose();
    photo.dispose();
  }, 30000);

  it('grows the background 3 px into a page edge', () => {
    const w = 60;
    const h = 20;
    const fine = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const x = i % w;
      const y = (i - x) / w;
      const page = x < w - 1 && y > 0 && y < h - 1;
      fine.fill(!page || x < 30 ? 30 : x < 34 ? 150 : 230, i * 4, i * 4 + 3);
    }
    const out = new Uint8Array(w * h);
    markDarkBackground(out, fine, w, h);
    expect([29, 30, 31, 32, 33].map((x) => out[10 * w + x])).toEqual([255, 255, 255, 255, 0]);
  });

  function rectMask(w: number, h: number, dark: (x: number, y: number) => boolean, level: number, light = 230) {
    const fine = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        fine.fill(dark(x, y) ? level : light, (y * w + x) * 4, (y * w + x) * 4 + 3);
      }
    }
    const out = new Uint8Array(w * h);
    markDarkBackground(out, fine, w, h);
    return out;
  }

  // Dark everywhere but a light page from column `left` to one short of the right border, a row in from top and bottom.
  const besidePage = (w: number, h: number, left: number) => (x: number, y: number) => x < left || x === w - 1 || y === 0 || y === h - 1;

  it('pins the half-paper brightness cutoff', () => {
    expect(rectMask(40, 20, besidePage(40, 20, 20), 114)[10 * 40 + 10]).toBe(255);
    expect(rectMask(40, 20, besidePage(40, 20, 20), 115)[10 * 40 + 10]).toBe(0);
  });

  // 2454 and 2552 of 10000 pixels outside the page.
  it('pins the quarter-frame area gate', () => {
    expect(Math.max(...rectMask(100, 100, besidePage(100, 100, 22), 30))).toBe(0);
    expect(rectMask(100, 100, besidePage(100, 100, 23), 30)[50 * 100 + 10]).toBe(255);
  });

  it('marks nothing when the dark lies on one side of the light only', () => {
    expect(Math.max(...rectMask(100, 100, (x) => x < 40, 30))).toBe(0);
  });

  // A dark band across the page's top joins the table, with light letters reaching down into the page.
  it('keeps a dark band on the page inside the page outline', () => {
    const inPage = (x: number, y: number) => x >= 30 && x < 70 && y >= 30 && y < 80;
    const letter = (x: number, y: number) => y >= 34 && [35, 45, 55].some((l) => x >= l && x < l + 4);
    const out = rectMask(100, 100, (x, y) => !inPage(x, y) || (y < 40 && !letter(x, y)), 30);
    expect(out[38 * 100 + 41]).toBe(0);
    expect(out[10 * 100 + 10]).toBe(255);
  });

  it('leaves a small page under 10% of the frame unchanged', () => {
    // 9% bright paper leaves the 90th percentile on the dark background.
    expect(Math.max(...rectMask(100, 100, (x, y) => !(x >= 35 && x < 65 && y >= 35 && y < 65), 30))).toBe(0);
  });

  type Place = 'inside' | 'off' | 'near' | 'touch' | 'corner' | 'offBoth';
  type Bleed = {
    tilt?: number;
    widen?: number;
    // Px each side flares out by 345 px below the page's top, growing with the square of the depth: a foot curling toward the camera.
    curl?: number;
    place: Place;
    picture?: 'full' | 'left' | 'middle';
    depth?: number;
    colour?: number[];
    carpet?: boolean;
    // Red and blue stripes 20 px wide, upright.
    stripes?: boolean;
    // A second colour over part of the picture.
    accent?: ['right' | 'frame' | 'band' | 'top' | 'inset' | 'strip', number[]];
    // The table right of the page's middle is this many times darker.
    step?: number;
    // The table's colour at (x, y), u across and v down the page from its top left corner, in place of brown, carpet or stripes.
    table?: (x: number, y: number, u: number, v: number) => number[];
    // A band this deep along the page's left side, and for 'corner' along its top too.
    band?: ['corner' | 'side', number, number[]];
    // An object on the table against the page's left or right side, this long from 180 px down it.
    object?: ['left' | 'right', number, number[]];
    // This colour 20 px down both sides of the photo, as light wood, which is not scored.
    rim?: number[];
  };
  const NAVY = [30, 40, 90];
  const NEAR_BLACK = [20, 20, 22];
  const DARK_GREEN = [40, 80, 50];
  const DARK_RED = [100, 25, 25];
  const RED_STRIPE = [90, 35, 35];
  const BLUE_STRIPE = [35, 40, 95];

  const grainAt = (x: number, y: number) => ((x * 7919 + y * 104729) % 23) - 11;
  const brownAt = (x: number, y: number) => [70, 60, 55].map((c) => c + grainAt(x, y));
  const stripes = (width: number, odd = RED_STRIPE, even = BLUE_STRIPE) => (x: number, y: number) =>
    (Math.floor(x / width) % 2 ? odd : even).map((c) => c + grainAt(x, y));
  const brownStripes = (x: number, y: number) => brownAt(x, y).map((c) => Math.round(Math.floor(x / 20) % 2 ? c / 1.6 : c));
  const carpetAt = (x: number, y: number) => [60, 60, 63].map((c) => c + ((x * 7919 + y * 104729) % 41) - 20 + (((x >> 2) * 31 + (y >> 2) * 17) % 9) - 4);

  // Picture, object and table are scored away from their edges (4, 4 and 10 px), where the 3 px grow and soft colour edges belong to neither.
  function bleedingPicture(s: Bleed) {
    const w = 500;
    const h = 667;
    const turn = ((s.tilt ?? 0) * Math.PI) / 180;
    const [cos, sin] = [Math.cos(turn), Math.sin(turn)];
    const widen = (v: number) => ((s.widen ?? 0) * v) / 547 + (s.curl ?? 0) * (v / 345) ** 2;
    const top = s.place === 'offBoth' ? -300 : 0;
    const end = s.place === 'inside' ? 430 : 900;
    let middle = 250;
    const toPage = (x: number, y: number) => [100 + (x - middle) * cos + (y - 120) * sin, (y - 120) * cos - (x - middle) * sin];
    const onPage = ([u, v]: number[]) => v >= top && v <= end && u >= -widen(v) && u <= 200 + widen(v);
    if (s.place === 'near' || s.place === 'touch' || s.place === 'corner') {
      let left = w;
      for (let y = 0; y < h; y++) for (let x = -400; x < left; x++) if (onPage(toPage(x, y))) left = x;
      middle += { near: 2, touch: 0, corner: -40 }[s.place] - left;
    }
    const pictureTop = s.place === 'inside' ? end - (s.depth ?? 200) : (546 - (s.depth ?? 200)) / cos;
    const fine = new Uint8Array(w * h * 4);
    const role = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [u, v] = toPage(x, y);
        const page = onPage([u, v]);
        const [a, b] = s.picture === 'left' ? [-widen(v), 100] : s.picture === 'middle' ? [67, 133] : [-widen(v), 200.5 + widen(v)];
        const inPicture = page && !!s.picture && v >= pictureTop && u >= a && u < b;
        const shade = s.step && x >= middle ? 1 / s.step : 1;
        const tableColour = s.table ? s.table(x, y, u, v) : s.stripes ? stripes(20)(x, y) : s.carpet ? carpetAt(x, y) : brownAt(x, y);
        const table = tableColour.map((c) => Math.round(c * shade));
        const [bandKind, bandDepth = 0, bandColour] = s.band ?? [];
        const inBand = page && !!s.band && (u < -widen(v) + bandDepth || (bandKind === 'corner' && v < top + bandDepth));
        const [objectAt, objectLength = 0, objectColour] = s.object ?? [];
        const inObject = (margin: number) =>
          !!s.object && v >= 180 - margin && v < 180 + objectLength + margin && (objectAt === 'left' ? u < -widen(v) + margin : u > 200 + widen(v) - margin);
        const [kind, accent] = s.accent ?? [];
        const inAccent = {
          right: u >= 100,
          frame: v < pictureTop + 3 || u < a + 3 || u >= b - 3,
          band: v < pictureTop + 10,
          top: v < pictureTop + 60,
          inset: Math.abs(u - 100) < 20 && Math.abs(v - pictureTop - 100) < 20,
          strip: u >= b - 20,
          none: false,
        }[kind ?? 'none'];
        const ink = inAccent ? accent! : (s.colour ?? NAVY);
        const rimOut = (margin: number) => !!s.rim && (x < 20 + margin || x >= w - 20 - margin);
        const off = rimOut(0) ? s.rim! : inObject(0) ? objectColour! : table;
        fine.set([...(inBand ? bandColour! : inPicture ? ink : page ? [233, 230, 222] : off), 255], (y * w + x) * 4);
        if (inPicture && v >= pictureTop + 4 && v <= end - 4 && u >= a + 4 && u < b - 4) role[y * w + x] = 1;
        if (!page && !inObject(10) && !rimOut(10) && (v < top - 10 || v > end + 10 || u < -widen(v) - 10 || u > 210 + widen(v))) role[y * w + x] = 2;
        if (!page && inObject(-4)) role[y * w + x] = 3;
      }
    }
    const out = new Uint8Array(w * h);
    markDarkBackground(out, fine, w, h);
    const share = (r: number) => {
      let all = 0;
      let marked = 0;
      role.forEach((v, i) => v === r && (all++, (marked += out[i] ? 1 : 0)));
      return marked / all;
    };
    return { picture: s.picture ? share(1) : 0, table: share(2), object: s.object ? share(3) : 0 };
  }

  // Where the page reaches a corner of the photo the table may not show on two opposite sides, so only the picture is checked.
  it.each([
    [{ place: 'inside', picture: 'full', colour: NEAR_BLACK, carpet: true }],
    [{ place: 'inside', tilt: 5, picture: 'left', depth: 100, colour: DARK_GREEN, carpet: true }],
    [{ place: 'inside', widen: 8, picture: 'middle', depth: 100, colour: NEAR_BLACK }],
    [{ place: 'off', picture: 'full', depth: 30 }],
    [{ place: 'off', picture: 'left', depth: 100, colour: NEAR_BLACK, carpet: true }],
    [{ place: 'off', tilt: 0.6, picture: 'full', depth: 100, colour: DARK_GREEN }],
    [{ place: 'off', tilt: 2, picture: 'left' }],
    [{ place: 'off', tilt: 5, picture: 'full', colour: NEAR_BLACK, carpet: true }],
    [{ place: 'off', widen: 8, picture: 'full' }],
    [{ place: 'off', picture: 'full', accent: ['right', DARK_GREEN] }],
    [{ place: 'off', picture: 'full', curl: 16 }],
    [{ place: 'off', picture: 'full', curl: 20 }],
    [{ place: 'inside', picture: 'full', depth: 100, colour: NEAR_BLACK, stripes: true }],
    [{ place: 'near', tilt: 0.6, picture: 'middle', carpet: true }],
    [{ place: 'near', widen: 8, picture: 'left', colour: DARK_GREEN, carpet: true }],
    [{ place: 'touch', tilt: 2, picture: 'full', colour: NEAR_BLACK }],
    [{ place: 'touch', picture: 'full' }],
    [{ place: 'corner', tilt: 5, picture: 'full', depth: 100 }],
    [{ place: 'corner', widen: 8, picture: 'left', colour: DARK_GREEN }],
    [{ place: 'offBoth', tilt: 2, picture: 'full', colour: DARK_GREEN }],
    [{ place: 'offBoth', widen: 8, picture: 'left', depth: 100, colour: NEAR_BLACK, carpet: true }],
    [{ place: 'inside', tilt: 5 }],
    [{ place: 'off', tilt: 2, carpet: true }],
    [{ place: 'near', widen: 8 }],
    [{ place: 'offBoth', tilt: 0.6 }],
  ] as [Bleed][])('keeps a dark picture bleeding off a page and whitens the table round it: %j', (scene) => {
    const { picture, table } = bleedingPicture(scene);
    if (scene.picture) expect(picture).toBeLessThan(0.1);
    if (scene.place !== 'touch' && scene.place !== 'corner') expect(table).toBeGreaterThan(0.95);
  });

  it.each([
    [{ place: 'off', picture: 'full', accent: ['frame', NEAR_BLACK] }],
    [{ place: 'off', tilt: 2, picture: 'full', accent: ['band', DARK_GREEN] }],
    [{ place: 'off', widen: 8, picture: 'full', colour: NEAR_BLACK, carpet: true, accent: ['top', DARK_GREEN] }],
    [{ place: 'off', picture: 'full', accent: ['inset', DARK_RED] }],
    [{ place: 'offBoth', tilt: -5, picture: 'full', depth: 100, colour: NEAR_BLACK, accent: ['strip', NAVY] }],
    [{ place: 'inside', step: 2 }],
    [{ place: 'off', step: 3, carpet: true }],
    [{ place: 'near', widen: 8, step: 1.6 }],
  ] as [Bleed][])('keeps every colour of a picture and whitens a table shaded through the page: %j', (scene) => {
    const { picture, table } = bleedingPicture(scene);
    if (scene.picture) expect(picture).toBeLessThan(0.02);
    expect(table).toBeGreaterThan(0.95);
  });

  // A band 40 px deep round the page's top left corner, past the reach of print along one side.
  it.each([
    ['keeps a dark band round a corner of the page', brownAt, NAVY],
    ['keeps a green band round a corner of the page on brown stripes, every other one 1.6 times darker', brownStripes, DARK_GREEN],
    ['keeps a black band round a corner of the page on red and blue stripes 20 px wide', stripes(20), NEAR_BLACK],
    ['keeps a green band round a corner of the page on red and blue stripes 20 px wide', stripes(20), DARK_GREEN],
    ['keeps a black band round a corner of the page on red and blue stripes 40 px wide', stripes(40), NEAR_BLACK],
    ['keeps a green band round a corner of the page on red and blue stripes 40 px wide', stripes(40), DARK_GREEN],
    ['whitens a table of red and blue stripes 20 px wide', stripes(20), null],
    ['whitens a table of brown stripes 20 px wide, every other one 1.6 times darker', brownStripes, null],
    ['whitens a table of red and blue stripes 40 px wide', stripes(40), null],
    ['whitens a table whose half beside the page is a checked cloth', (x: number, y: number) => (x < 250 ? brownAt(x, y) : ((x / 40) ^ (y / 40)) & 1 ? [90, 30, 30] : [30, 30, 70]), null],
    // Blocks too uneven to start a surface, so the half is dark the table turns away.
    ['whitens a table whose half beside the page is dark blocks of many colours', (x: number, y: number) => {
      const k = (Math.floor(x / 5) * 7919 + Math.floor(y / 5) * 104729) % 97;
      return x < 250 ? brownAt(x, y) : [30 + (k % 7) * 9, 25 + ((k >> 1) % 5) * 10, 30 + ((k >> 2) % 6) * 9];
    }, null],
  ] as const)('%s', (_, table, band) => {
    const w = 500;
    const h = 667;
    const fine = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const page = x >= 150 && x < 350 && y >= 120 && y < 550;
        const colour = page && band && (x < 190 || y < 160) ? band : page ? [233, 230, 222] : table(x, y);
        fine.set([...colour, 255], (y * w + x) * 4);
      }
    }
    const out = new Uint8Array(w * h);
    markDarkBackground(out, fine, w, h);
    // The band's left arm 4 px in from its edges, and the table 10 px from the page.
    const share = (scored: (x: number, y: number) => boolean) => {
      let marked = 0;
      let all = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!scored(x, y)) continue;
          all++;
          if (out[y * w + x]) marked++;
        }
      }
      return marked / all;
    };
    if (band) expect(share((x, y) => x >= 154 && x < 186 && y >= 124 && y < 546)).toBe(0);
    expect(share((x, y) => x < 140 || x >= 360 || y < 110 || y >= 560)).toBeGreaterThan(0.95);
  });

  it.each([
    ['whitens the table above and below a page as wide as the photo', [70, 60, 55], 0.95],
    ['keeps a picture bleeding off the foot of a page as wide as the photo', [30, 40, 90], 0],
  ] as const)('%s', (_, below, least) => {
    const w = 500;
    const h = 667;
    const fine = new Uint8Array(w * h * 4);
    for (let p = 0; p < w * h; p++) {
      const y = Math.floor(p / w);
      const grain = ((p * 7919) % 23) - 11;
      const colour = y < 120 ? [70 + grain, 60 + grain, 55 + grain] : y <= 466 ? [233, 230, 222] : below.map((c) => c + (below[0] === 70 ? grain : 0));
      fine.set([...colour, 255], p * 4);
    }
    const out = new Uint8Array(w * h);
    markDarkBackground(out, fine, w, h);
    const marked = (top: number, bottom: number) => out.slice(top * w, bottom * w).filter(Boolean).length / ((bottom - top) * w);
    expect(marked(0, 110)).toBeGreaterThanOrEqual(least);
    if (least) expect(marked(477, h)).toBeGreaterThan(least);
    else expect(marked(471, h)).toBe(0);
  });

  // As in DocUNet 22_1: light wood holds the photo's top corners, so the blanket above the page holds none.
  const navy = (k: number) => [32, 40, 80].map((c) => Math.round(c * k));
  it.each([
    ['in one shade', () => navy(1), () => navy(1)],
    ['lit unevenly, in two parts', (x: number) => navy(x < 250 ? 1 / Math.sqrt(1.7) : Math.sqrt(1.7)), () => navy(1)],
    ['in red and blue stripes 20 px wide', stripes(20), stripes(20)],
  ] as const)('whitens a blanket above and below a page as wide as the photo, with wood across the top: %s', (_, above, below) => {
    const w = 500;
    const h = 667;
    const fine = new Uint8Array(w * h * 4);
    for (let p = 0; p < w * h; p++) {
      const x = p % w;
      const y = (p - x) / w;
      const colour = y < 20 ? [200, 140, 70] : y < 120 ? above(x, y) : y <= 466 ? [233, 230, 222] : below(x, y);
      fine.set([...colour, 255], p * 4);
    }
    const out = new Uint8Array(w * h);
    markDarkBackground(out, fine, w, h);
    const marked = (top: number, bottom: number) => out.slice(top * w, bottom * w).filter(Boolean).length / ((bottom - top) * w);
    expect(marked(30, 110)).toBeGreaterThan(0.95);
    expect(marked(477, h)).toBeGreaterThan(0.95);
  });

  // The share of each region whitened in the 500 x 667 small copy `colourAt` paints.
  function markedShares(colourAt: (x: number, y: number) => number[], ...regions: ((x: number, y: number) => boolean)[]) {
    const w = 500;
    const h = 667;
    const fine = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) fine.set([...colourAt(x, y), 255], (y * w + x) * 4);
    const out = new Uint8Array(w * h);
    markDarkBackground(out, fine, w, h);
    return regions.map((inRegion) => {
      let all = 0;
      let marked = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!inRegion(x, y)) continue;
          all++;
          if (out[y * w + x]) marked++;
        }
      }
      return marked / all;
    });
  }
  const PAPER = [233, 230, 222];
  const checks = (x: number, y: number) => (((x / 40) ^ (y / 40)) & 1 ? [90, 30, 30] : [30, 30, 70]).map((c) => c + grainAt(x, y));

  // The object touches the page and the photo's edge, or the page's foot, and the band reaches past the reach of print.
  it.each([
    [NEAR_BLACK, 60, 'left of', 'brown'],
    [NAVY, 80, 'right of', 'brown'],
    [DARK_GREEN, 120, 'below', 'brown'],
    [NEAR_BLACK, 120, 'right of', 'brown'],
    [NAVY, 60, 'below', 'brown'],
    [DARK_GREEN, 80, 'left of', 'brown'],
    [NEAR_BLACK, 80, 'left of', 'checks'],
    [NEAR_BLACK, 80, 'left of', 'stripes'],
  ] as const)('keeps a %j header band %i px deep beside an object of its colour %s the page on a %s table', (colour, depth, place, tableName) => {
    const [x0, x1, y0, y1] = { 'left of': [0, 150, 300, 360], 'right of': [350, 500, 400, 440], below: [200, 260, 550, 667] }[place];
    const tableAt = { brown: brownAt, checks, stripes: stripes(20) }[tableName];
    const inObject = (x: number, y: number) => x >= x0 && x < x1 && y >= y0 && y < y1;
    const [band, object, table] = markedShares(
      (x, y) => (x >= 150 && x < 350 && y >= 120 && y < 550 ? (y < 120 + depth ? colour : PAPER) : inObject(x, y) ? colour : tableAt(x, y)),
      (x, y) => x >= 154 && x < 346 && y >= 124 && y < 116 + depth,
      (x, y) => x >= x0 + 4 && x < x1 - 4 && y >= y0 + 4 && y < y1 - 4,
      (x, y) => (x < 140 || x >= 360 || y < 110 || y >= 560) && !(x >= x0 - 10 && x < x1 + 10 && y >= y0 - 10 && y < y1 + 10),
    );
    expect(band).toBe(0);
    expect(object).toBeGreaterThan(0.95);
    expect(table).toBeGreaterThan(0.95);
  });

  // The page (x 150 to 349) runs off the photo's top and foot; the picture starts 200 px above the foot.
  it.each([
    ['a black and green picture on red and navy checks', checks, (x: number) => (x < 250 ? NEAR_BLACK : DARK_GREEN), 471, 663],
    // Navy on blue stripes is the table's own colour, so only the black band is checked.
    ['a black band over a navy picture on red and blue stripes', stripes(20), (_: number, y: number) => (y < 487 ? NEAR_BLACK : NAVY), 470, 484],
  ] as const)('keeps %s at the foot of a page running off both ends', (_, table, picture, top, bottom) => {
    const [pictureWhitened, tableWhitened] = markedShares(
      (x, y) => (x >= 150 && x < 350 ? (y >= 467 ? picture(x, y) : PAPER) : table(x, y)),
      (x, y) => x >= 154 && x < 346 && y >= top && y < bottom,
      (x) => x < 140 || x >= 360,
    );
    // Where the band meets the table, its 2 px colour seam and the 3 px grow reach 5 px in.
    expect(pictureWhitened).toBeLessThan(0.01);
    expect(tableWhitened).toBeGreaterThan(0.95);
  });

  const slanting = (x: number, y: number) => (Math.floor((x + y) / 28) % 2 ? RED_STRIPE : BLUE_STRIPE).map((c) => c + grainAt(x, y));
  // A black bar at the photo's edge across a page (x 150 to 349) running off its foot from y 120, or both ends.
  it.each([
    // A footer within reach reaches the photo's foot as an object tied to the table does, but spans the paper's end.
    ['a footer 30 px deep on a page running off the foot, on red and navy checks', checks, 120, [637, 667], [641, 667]],
    // A footer just inside the reach of print (a quarter of the page's width) spans the paper's end too.
    ['a footer 45 px deep on a page running off the foot, on red and navy checks', checks, 120, [622, 667], [626, 667]],
    // A header within reach reaches the photo's top and spans the paper's end.
    ['a header 40 px deep on a page running off both ends, on slanting red and blue stripes', slanting, 0, [0, 40], [0, 36]],
  ] as const)('keeps %s', (_, table, pageTop, [barTop, barBottom], [scoredTop, scoredBottom]) => {
    const [barWhitened, tableWhitened] = markedShares(
      (x, y) => (x >= 150 && x < 350 && y >= pageTop ? (y >= barTop && y < barBottom ? NEAR_BLACK : PAPER) : table(x, y)),
      (x, y) => x >= 154 && x < 346 && y >= scoredTop && y < scoredBottom,
      (x, y) => x < 140 || x >= 360 || y < pageTop - 10,
    );
    expect(barWhitened).toBe(0);
    expect(tableWhitened).toBeGreaterThan(0.95);
  });

  // A footer 30 px deep at the foot of a turned page curling toward the camera and running off the photo's foot.
  it.each([
    ['black', 'slanting red and blue stripes', { tilt: -5, curl: 20, colour: NEAR_BLACK, table: slanting }],
    ['green', 'red and navy checks', { tilt: -4, curl: 18, colour: DARK_GREEN, table: checks }],
  ] as const)('keeps a %s footer at the curled foot of a turned page on %s', (_, __, scene) => {
    // The curl puts table in the footer's hull with the page, which took it for an object under the page's corner.
    const { picture, table } = bleedingPicture({ place: 'off', picture: 'full', depth: 30, ...scene });
    expect(picture).toBeLessThan(0.1);
    expect(table).toBeGreaterThan(0.95);
  });

  // A page turned about its middle on checks, with a black object from the photo's side to just past the page's corner nearest it.
  it.each([
    ['across its lowest corner', 2, [150, 120, 349, 646], [315, 643, 365, 667]],
    ['across its highest corner', 2, [150, 20, 349, 560], [134, 0, 184, 23]],
    ['across its leftmost corner', 5, [40, 120, 239, 560], [0, 525, 27, 575]],
  ] as const)('whitens an object %s on a page turned %i degrees', (_, tilt, [left, top, right, bottom], [x0, y0, x1, y1]) => {
    const turn = (tilt * Math.PI) / 180;
    const [cx, cy] = [(left + right) / 2, (top + bottom) / 2];
    const byPage = (x: number, y: number, margin: number) => {
      const u = cx + (x - cx) * Math.cos(turn) + (y - cy) * Math.sin(turn);
      const v = cy - (x - cx) * Math.sin(turn) + (y - cy) * Math.cos(turn);
      return u >= left - margin && u <= right + margin && v >= top - margin && v <= bottom + margin;
    };
    const inObject = (x: number, y: number, margin: number) => x >= x0 - margin && x < x1 + margin && y >= y0 - margin && y < y1 + margin;
    const [object, table] = markedShares(
      (x, y) => (byPage(x, y, 0) ? PAPER : inObject(x, y, 0) ? NEAR_BLACK : checks(x, y)),
      (x, y) => inObject(x, y, -4) && !byPage(x, y, 10),
      (x, y) => !byPage(x, y, 10) && !inObject(x, y, 10),
    );
    // It spans the paper's nearest corner, which passed it as a footer.
    expect(object).toBeGreaterThan(0.95);
    expect(table).toBeGreaterThan(0.95);
  });

  // The page (x 150 to 349) runs off the photo's foot from y 120; the header is 60 px deep and the picture 100 px.
  it.each([
    // A kept picture adds no surface to its colour, so the object's one surface makes no table colour that takes the header.
    ['black header and picture beside a black object on a brown table', NEAR_BLACK, brownAt, [150, 250], [350, 500]],
    // On carpet too, a navy picture across the foot and a navy object left of the page make no navy table colour.
    ['navy header and picture beside a navy object on a carpet table', NAVY, carpetAt, [150, 350], [0, 150]],
  ] as const)('keeps a %s', (_, colour, table, [pictureLeft, pictureRight], [objectLeft, objectRight]) => {
    const inObject = (x: number, y: number) => x >= objectLeft && x < objectRight && y >= 300 && y < 420;
    const [print, object, tableWhitened] = markedShares(
      (x, y) => {
        if (!(x >= 150 && x < 350 && y >= 120)) return inObject(x, y) ? colour : table(x, y);
        return y < 180 || (y >= 567 && x >= pictureLeft && x < pictureRight) ? colour : PAPER;
      },
      (x, y) => (x >= 154 && x < 346 && y >= 124 && y < 176) || (x >= pictureLeft + 4 && x < pictureRight - 4 && y >= 571),
      (x, y) => x >= objectLeft + 4 && x < objectRight - 4 && y >= 304 && y < 416,
      (x, y) => (x < 140 || x >= 360 || y < 110) && !(x >= objectLeft - 10 && x < objectRight + 10 && y >= 290 && y < 430),
    );
    expect(print).toBe(0);
    expect(object).toBeGreaterThan(0.95);
    expect(tableWhitened).toBeGreaterThan(0.95);
  });

  it.each([
    ["a page touching the photo's side, with a band 20 px deep round its corner, on checks", { place: 'touch', table: checks, band: ['corner', 20, NEAR_BLACK] }],
    [
      "a page within 2 px of the photo's side, with a green band 120 px deep down it and a green object right of it, on checks",
      { place: 'near', table: checks, band: ['side', 120, DARK_GREEN], object: ['right', 120, DARK_GREEN] },
    ],
    [
      "a page within 2 px of the photo's side, with a black picture at its foot and a black object between it and the side, on stripes",
      { place: 'near', tilt: 2, stripes: true, picture: 'full', depth: 60, colour: NEAR_BLACK, object: ['left', 60, NEAR_BLACK] },
    ],
    [
      "a page off the photo's corner, with a navy picture and a shadow 1.6 times darker down its side, on carpet",
      { place: 'corner', picture: 'full', table: (x, y, u, v) => carpetAt(x, y).map((c) => (u > 200 && u <= 220 && v >= 0 ? Math.round(c / 1.6) : c)) },
    ],
    // Each stripe colour starts one surface on each side of the page, as the wood holds the photo's sides.
    [
      'a page running off both ends between wood down both sides, with a black picture at its foot, on red and blue stripes 20 px wide across',
      { place: 'offBoth', picture: 'left', depth: 60, colour: NEAR_BLACK, table: (x, y) => stripes(20)(y, x), rim: [200, 140, 70] },
    ],
    // x 33 is a quarter of the way across the page at half its height.
    [
      "a tilted page off the photo's corner, with a black picture, on brown 1.6 times darker right of x 33",
      { place: 'corner', tilt: -5, picture: 'full', colour: NEAR_BLACK, table: (x, y) => brownAt(x, y).map((c) => (x >= 33 ? Math.round(c / 1.6) : c)) },
    ],
  ] as [string, Bleed][])('whitens the table round %s', (_, scene) => {
    const { picture, table, object } = bleedingPicture(scene);
    if (scene.picture) expect(picture).toBeLessThan(0.1);
    if (scene.object) expect(object).toBeGreaterThan(0.95);
    expect(table).toBeGreaterThan(0.95);
  });
});
