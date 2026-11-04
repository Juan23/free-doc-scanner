import { ImageFormat, Skia, type SkImage } from '@shopify/react-native-skia';
import { File } from 'expo-file-system';

async function decode(uri: string): Promise<SkImage> {
  const data = Skia.Data.fromBytes(await new File(uri).bytes());
  const image = Skia.Image.MakeImageFromEncoded(data);
  data.dispose();
  if (!image) throw new Error('unreadable page');
  return image;
}

/** Turns `image` clockwise by 1-3 quarter turns and stores it over the page at `uri`. */
async function storeTurned(image: SkImage, turns: number, uri: string): Promise<void> {
  const w = image.width();
  const h = image.height();
  const [tw, th] = turns % 2 ? [h, w] : [w, h];
  const surface = Skia.Surface.Make(tw, th)!;
  const canvas = surface.getCanvas();
  canvas.translate(tw / 2, th / 2);
  canvas.rotate(turns * 90, 0, 0);
  canvas.drawImage(image, -w / 2, -h / 2);
  const turned = surface.makeImageSnapshot();
  const bytes = turned.encodeToBytes(ImageFormat.JPEG, 90);
  for (const o of [surface, turned]) o.dispose();
  // Native Skia returns null when encoding fails, whatever the type says.
  if (!bytes?.length) throw new Error('could not encode page');

  // Swapping in a finished file means a crash mid-write can't leave a broken page.
  const tmp = new File(`${uri}.tmp`);
  await tmp.write(bytes);
  await tmp.move(new File(uri), { overwrite: true });
}

/** Turns the stored page JPEG at `uri` clockwise by `quarterTurns` × 90°, replacing it. */
export async function rotatePage(uri: string, quarterTurns: number): Promise<void> {
  const turns = ((quarterTurns % 4) + 4) % 4;
  if (!turns) return;
  const image = await decode(uri);
  try {
    await storeTurned(image, turns, uri);
  } finally {
    image.dispose();
  }
}
