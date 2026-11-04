import { FilterMode, ImageFormat, MipmapMode, Skia, TileMode, type SkImage, type SkMatrix } from '@shopify/react-native-skia';
import { File, Paths } from 'expo-file-system';

// Clean-up is on unless this file exists.
const offFile = () => new File(Paths.document, 'clean-up-off');

export const cleanUpOn = () => !offFile().exists;

/** Remembers the choice across launches. Never throws: at worst the choice resets at next launch. */
export function setCleanUp(on: boolean): void {
  try {
    const f = offFile();
    if (on && f.exists) f.delete();
    if (!on && !f.exists) f.create();
  } catch {}
}

// How much darker than its paper each pixel of the small copy is. Blurred, it shows where the
// writing is. Kept linear so thin, faint strokes still count once shrunk.
const inkEffect = Skia.RuntimeEffect.Make(`
uniform shader page;
uniform shader paper;
half4 main(float2 xy) {
  half3 c = page.eval(xy).rgb / max(paper.eval(xy).rgb, half3(0.05));
  return half4(0, 0, 0, saturate(0.9 - min(min(c.r, c.g), c.b)));
}`)!;

// Divides each pixel by the paper's brightness around it, so shadows and tint turn white, and
// stretches the levels so grain goes white and ink dark. Faint marks far from any writing (dirt,
// creases) go white too; dark marks always stay, so full stops and lines survive.
const cleanEffect = Skia.RuntimeEffect.Make(`
uniform shader page;
uniform shader paper;
uniform shader ink;
half4 main(float2 xy) {
  half3 c = saturate((page.eval(xy).rgb / max(paper.eval(xy).rgb, half3(0.05)) - 0.25) / 0.6);
  half dark = 1 - min(min(c.r, c.g), c.b);
  half keep = max(smoothstep(0.45, 0.65, dark), smoothstep(0.02, 0.05, ink.eval(xy).a));
  return half4(mix(half3(1), c, keep), 1);
}`)!;

// Paper and text are found on a copy this wide: dilating wipes out the ink, blurring smooths the rest.
const SMALL_WIDTH = 500;

async function cleanPage(uri: string): Promise<void> {
  const data = Skia.Data.fromBytes(await new File(uri).bytes());
  const image = Skia.Image.MakeImageFromEncoded(data);
  if (!image) throw new Error('unreadable page');
  const w = image.width();
  const h = image.height();
  const scale = Math.min(1, SMALL_WIDTH / w);
  const sw = Math.ceil(w * scale);
  const sh = Math.ceil(h * scale);
  const toFull = Skia.Matrix().scale(w / sw, h / sh);
  const clamp = (img: SkImage, mode: FilterMode, matrix?: SkMatrix) =>
    img.makeShaderOptions(TileMode.Clamp, TileMode.Clamp, mode, MipmapMode.None, matrix);

  const surface = Skia.Surface.Make(sw, sh)!;
  const canvas = surface.getCanvas();
  // Mipmapped, so shrinking averages thin strokes in instead of skipping them.
  canvas.drawImageRectOptions(image, Skia.XYWHRect(0, 0, w, h), Skia.XYWHRect(0, 0, sw, sh), FilterMode.Linear, MipmapMode.Linear);
  const smallPage = surface.makeImageSnapshot();

  const wipeInk = Skia.Paint();
  wipeInk.setImageFilter(Skia.ImageFilter.MakeBlur(8, 8, TileMode.Clamp, Skia.ImageFilter.MakeDilate(6, 6, null)));
  canvas.drawImage(smallPage, 0, 0, wipeInk);
  const paper = surface.makeImageSnapshot();

  const smallPageShader = clamp(smallPage, FilterMode.Nearest);
  const smallPaperShader = clamp(paper, FilterMode.Nearest);
  const inkShader = inkEffect.makeShaderWithChildren([], [smallPageShader, smallPaperShader]);
  const spreadInk = Skia.Paint();
  spreadInk.setShader(inkShader);
  spreadInk.setImageFilter(Skia.ImageFilter.MakeBlur(6, 6, TileMode.Clamp, null));
  canvas.clear(Skia.Color('transparent'));
  canvas.drawRect(Skia.XYWHRect(0, 0, sw, sh), spreadInk);
  const ink = surface.makeImageSnapshot();

  const pageShader = clamp(image, FilterMode.Nearest);
  const paperShader = clamp(paper, FilterMode.Linear, toFull);
  const textShader = clamp(ink, FilterMode.Linear, toFull);
  const cleanShader = cleanEffect.makeShaderWithChildren([], [pageShader, paperShader, textShader]);
  const out = Skia.Surface.Make(w, h)!;
  const paint = Skia.Paint();
  paint.setShader(cleanShader);
  out.getCanvas().drawPaint(paint);
  const snapshot = out.makeImageSnapshot();
  const bytes = snapshot.encodeToBytes(ImageFormat.JPEG, 90);
  // A page holds about 100 MB of bitmaps: free them now, not whenever the garbage collector runs.
  for (const o of [
    data, image, surface, smallPage, wipeInk, paper, smallPageShader, smallPaperShader, inkShader, spreadInk,
    ink, pageShader, paperShader, textShader, cleanShader, out, paint, snapshot,
  ]) {
    o.dispose();
  }
  // Native Skia returns null when encoding fails, whatever the type says.
  if (!bytes?.length) throw new Error('could not encode page');

  // Swapping in a finished file means a crash mid-write can't leave a broken page.
  const tmp = new File(`${uri}.tmp`);
  await tmp.write(bytes);
  await tmp.move(new File(uri), { overwrite: true });
}

/**
 * Whitens the paper of stored page JPEGs (shadows, tint, grain, specks) and darkens the ink,
 * replacing each page. A page that can't be cleaned stays as it was.
 */
export async function cleanPages(pageUris: string[]): Promise<void> {
  // One page at a time: each holds full-size bitmaps in memory.
  for (const uri of pageUris) {
    try {
      await cleanPage(uri);
    } catch {}
  }
}
