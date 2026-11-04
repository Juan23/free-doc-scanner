/**
 * @jest-environment @shopify/react-native-skia/jestEnv.js
 */
/// <reference types="jest" />
import { ImageFormat, Skia } from '@shopify/react-native-skia';

import { rotatePage } from './upright';

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

const PAGE = 'file:///doc/scans/1/p1.jpg';

const decode = (bytes: Uint8Array) => Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(bytes))!;

// A 300 x 200 picture, white with a red square in its top-left corner.
function marked(): Uint8Array {
  const surface = Skia.Surface.Make(300, 200)!;
  const canvas = surface.getCanvas();
  canvas.drawColor(Skia.Color('white'));
  const paint = Skia.Paint();
  paint.setColor(Skia.Color('red'));
  canvas.drawRect(Skia.XYWHRect(0, 0, 40, 40), paint);
  return surface.makeImageSnapshot().encodeToBytes(ImageFormat.JPEG, 95);
}

const isRed = (bytes: Uint8Array, x: number, y: number) => {
  const image = decode(bytes);
  const [r, g, b] = image.readPixels(x, y, { width: 1, height: 1, colorType: 4, alphaType: 3 }) as Uint8Array;
  return r > 200 && g < 60 && b < 60;
};

it.each([
  [1, 200, 300, [180, 20]],
  [2, 300, 200, [280, 180]],
  [3, 200, 300, [20, 280]],
  [-1, 200, 300, [20, 280]],
  [5, 200, 300, [180, 20]],
])('turns a page %i quarter turns clockwise, in place', async (turns, width, height, [x, y]) => {
  mockFiles.set(PAGE, marked());

  await rotatePage(PAGE, turns);

  expect([...mockFiles.keys()]).toEqual([PAGE]);
  const page = mockFiles.get(PAGE)!;
  expect([decode(page).width(), decode(page).height()]).toEqual([width, height]);
  expect(isRed(page, x, y)).toBe(true);
  expect(isRed(page, 20, 20)).toBe(false);
});

it('does not rewrite a page turned by whole turns', async () => {
  const page = marked();
  mockFiles.set(PAGE, page);

  await rotatePage(PAGE, 0);
  await rotatePage(PAGE, 4);

  expect(mockFiles.get(PAGE)).toBe(page);
});

it('rejects a page it cannot read, leaving it as it is', async () => {
  const broken = new Uint8Array([1, 2, 3]);
  mockFiles.set(PAGE, broken);

  await expect(rotatePage(PAGE, 1)).rejects.toThrow();
  expect(mockFiles.get(PAGE)).toBe(broken);
});
