import { ImageFormat } from '@shopify/react-native-skia';
import { JpegEmbedder, PDFDocument } from 'pdf-lib';
import { Directory, File, Paths } from 'expo-file-system';
import { Album, Asset, requestPermissionsAsync } from 'expo-media-library';
import { Platform } from 'react-native';

import { shrunkCopy } from './clean';
import { readPage } from './scans';

const ALBUM = 'Free Doc Scanner';
const pad = (n: number) => String(n).padStart(2, '0');

/** "Scan 2026-11-03 19.42": base name for the PDF and the JPEG pages. */
export function scanName(date: Date = new Date()): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `Scan ${day} ${pad(date.getHours())}.${pad(date.getMinutes())}`;
}

/** The picked pages, in page order, or every page when none are picked. */
export const pagesToSave = (pages: string[], picked: string[]) =>
  picked.length ? pages.filter((p) => picked.includes(p)) : pages;

/** The picks after a long press: the page is picked, never unpicked. */
export const pickOnLongPress = (picked: string[] | null, uri: string): string[] =>
  picked === null ? [uri] : picked.includes(uri) ? picked : [...picked, uri];

const A4 = { short: 595.28, long: 841.89 };
// Small print stays as sharp as the page's own pixels at 250 dpi; 150 softens Chinese strokes.
const MAX_DPI = 250;

/**
 * One PDF page per page JPEG, in order: A4, portrait or landscape by the image's shape, the image
 * centred with its aspect kept. An image over twice as tall as wide (a receipt) gets a page of A4
 * width as tall as its shape instead, so its text is not shrunk to fit. A page finer than 250 dpi
 * at its size on the PDF page is shrunk to 250 dpi; any other is embedded as it is.
 */
export async function buildPdf(pages: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  // shortcut: holds every page in memory (~3x the scan size at peak), fine for typical scans; stream pages if 50+ page scans crash
  for (const uri of pages) {
    let bytes: Uint8Array = await new File(uri).bytes();
    const { width: w, height: h } = await JpegEmbedder.for(bytes);
    const size: [number, number] =
      h > 2 * w ? [A4.short, (A4.short * h) / w] : h >= w ? [A4.short, A4.long] : [A4.long, A4.short];
    const scale = Math.min(size[0] / w, size[1] / h);
    const width = w * scale;
    const height = h * scale;
    const maxWidth = Math.round((width / 72) * MAX_DPI);
    if (w > maxWidth) bytes = await shrunkJpeg(uri, maxWidth, Math.round((h * maxWidth) / w));
    const image = await doc.embedJpg(bytes);
    doc.addPage(size).drawImage(image, { x: (size[0] - width) / 2, y: (size[1] - height) / 2, width, height });
  }
  return doc.save();
}

async function shrunkJpeg(uri: string, w: number, h: number): Promise<Uint8Array> {
  const image = await readPage(uri);
  const small = shrunkCopy(image, w, h);
  const bytes = small.encodeToBytes(ImageFormat.JPEG, 90);
  image.dispose();
  small.dispose();
  // Native Skia returns null when encoding fails, whatever the type says.
  if (!bytes?.length) throw new Error('could not encode page');
  return bytes;
}

/** Asks the user for a folder and writes the pages there as `<name>.pdf`, never overwriting. */
export async function savePdf(pages: string[], name: string): Promise<'saved' | 'cancelled'> {
  let dir: Directory;
  try {
    dir = await Directory.pickDirectoryAsync();
  } catch (e) {
    // Both platforms reject on cancel. Android release builds minify the exception class the
    // error code is derived from, so match the message ("…cancelled by the user") as well.
    const { code, message } = e as { code?: string; message?: string };
    if (/cancel/i.test(`${code} ${message}`)) return 'cancelled';
    throw e;
  }
  let fileName = `${name}.pdf`;
  // Android's SAF provider renames a taken name itself; iOS would fail or overwrite.
  for (let n = 2; Platform.OS !== 'android' && new File(dir, fileName).exists; n++) {
    fileName = `${name} (${n}).pdf`;
  }
  const out = dir.createFile(fileName, 'application/pdf');
  try {
    // SAF content:// files can't be opened read-write, so write the bytes in one go.
    await out.write(await buildPdf(pages));
  } catch (e) {
    try {
      out.delete();
    } catch {}
    throw e;
  }
  return 'saved';
}

/** Saves the pages, in order, to Photos / Gallery as `<name> <page file name>`: `<name> p3.jpg` for `.../p3.jpg`. */
export async function saveJpegs(pages: string[], name: string): Promise<'saved' | 'denied'> {
  const { granted } = await requestPermissionsAsync(true);
  if (!granted) return 'denied';
  // Temps live in the scanner's folder so clearScannerCache sweeps them after a kill.
  const dir = new Directory(Paths.cache, 'DocumentScanner');
  dir.create({ idempotent: true });
  const temps = pages.map((page) => new File(dir, `${name} ${page.slice(page.lastIndexOf('/') + 1)}`));
  try {
    for (const [i, tmp] of temps.entries()) {
      if (tmp.exists) tmp.delete();
      await new File(pages[i]).copy(tmp);
    }
    const uris = temps.map((t) => t.uri);
    if (Platform.OS === 'android') {
      // Album.create only writes files, so it needs no read access to the library.
      await Album.create(ALBUM, uris);
    } else {
      // On iOS, albums need full library access, so pages go to the camera roll.
      for (const uri of uris) await Asset.create(uri);
    }
  } finally {
    for (const tmp of temps) {
      try {
        if (tmp.exists) tmp.delete();
      } catch {}
    }
  }
  return 'saved';
}

/** Deletes what an interrupted scan left in the cache: scanner pages and PDFs, and expo-camera photos. Never throws. */
export function clearScannerCache(): void {
  for (const name of ['DocumentScanner', 'Camera']) {
    try {
      const dir = new Directory(Paths.cache, name);
      if (dir.exists) dir.delete();
    } catch {}
  }
}
