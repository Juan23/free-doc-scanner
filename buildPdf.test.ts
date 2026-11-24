/**
 * @jest-environment @shopify/react-native-skia/jestEnv.js
 */
/// <reference types="jest" />
import { ImageFormat, Skia } from '@shopify/react-native-skia';
import { decodePDFRawStream, PDFArray, PDFDocument, PDFName, PDFNumber, PDFRawStream, type PDFPage } from 'pdf-lib';

import { buildPdf } from './save';

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
      return mockFiles.get(this.uri)!;
    }
  }
  return { File, Directory: class {}, Paths: {} };
});
jest.mock('expo-media-library', () => ({}));

function page(uri: string, w: number, h: number): Uint8Array {
  const surface = Skia.Surface.Make(w, h)!;
  surface.getCanvas().clear(Skia.Color('white'));
  const bytes = surface.makeImageSnapshot().encodeToBytes(ImageFormat.JPEG, 90);
  mockFiles.set(uri, bytes);
  return bytes;
}

/** Where the page draws its image, [width, height, x, y]: pdf-lib moves, turns, then scales. */
function drawn(p: PDFPage): number[] {
  const text = String.fromCharCode(...decodePDFRawStream((p.node.Contents() as PDFArray).lookup(0, PDFRawStream)).decode());
  const [move, , scale] = [...text.matchAll(/(\S+) (\S+) (\S+) (\S+) (\S+) (\S+) cm/g)].map((m) => m.slice(1).map(Number));
  return [scale[0], scale[3], move[4], move[5]];
}

const near = (...ns: number[]) => ns.map((n) => expect.closeTo(n, 2));

function images(doc: PDFDocument): { width: number; height: number; bytes: Uint8Array }[] {
  return doc.context
    .enumerateIndirectObjects()
    .map(([, o]) => o)
    .filter((o): o is PDFRawStream => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'))
    .map((o) => ({
      width: (o.dict.get(PDFName.of('Width')) as PDFNumber).asNumber(),
      height: (o.dict.get(PDFName.of('Height')) as PDFNumber).asNumber(),
      bytes: o.contents,
    }));
}

it('gives each JPEG, in order, an A4 page turned to its shape, the image centred with its aspect kept', async () => {
  page('file:///wide.jpg', 800, 400);
  page('file:///tall.jpg', 1000, 1600);
  const bytes = await buildPdf(['file:///wide.jpg', 'file:///tall.jpg']);
  const [wide, tall] = (await PDFDocument.load(bytes)).getPages();

  expect([wide.getWidth(), wide.getHeight()]).toEqual([841.89, 595.28]);
  expect(drawn(wide)).toEqual(near(841.89, 420.945, 0, 87.1675));

  expect([tall.getWidth(), tall.getHeight()]).toEqual([595.28, 841.89]);
  expect(drawn(tall)).toEqual(near(526.181, 841.89, 34.549, 0));
});

it('puts a receipt on a page of A4 width as tall as its shape, with its own pixels', async () => {
  const receipt = page('file:///receipt.jpg', 400, 2000);
  const doc = await PDFDocument.load(await buildPdf(['file:///receipt.jpg']));
  const p = doc.getPage(0);

  expect([p.getWidth(), p.getHeight()]).toEqual([595.28, expect.closeTo(2976.4, 2)]);
  expect(drawn(p)).toEqual(near(595.28, 2976.4, 0, 0));
  expect(images(doc)).toEqual([{ width: 400, height: 2000, bytes: receipt }]);
});

it('shrinks a page finer than 250 dpi at its size on the PDF page to 250 dpi', async () => {
  page('file:///photo.jpg', 3024, 4032);
  const doc = await PDFDocument.load(await buildPdf(['file:///photo.jpg']));

  expect(images(doc).map(({ width, height }) => [width, height])).toEqual([[2067, 2756]]);
  expect(drawn(doc.getPage(0))).toEqual(near(595.28, 793.707, 0, 24.092));
});
