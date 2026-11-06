import { ImageFormat, Skia, type SkImage } from '@shopify/react-native-skia';
import { Directory, File, Paths } from 'expo-file-system';

import { scanName } from './save';

/** A scan kept in the app's storage. `pages` are file:// URIs of the page JPEGs, in order. */
export type Scan = { id: string; name: string; pages: string[] };

const root = () => new Directory(Paths.document, 'scans');
const PAGE = /^p(\d+)\.jpg$/;
// A page or original is replaced by writing <name>.tmp, then moving it over the file, which deletes
// the old one first. An original's first copy goes through <name>.part instead: it has no file to
// move over, so a copy cut short must never be renamed into place.
const REPLACEMENT = /^([po]\d+\.jpg)\.tmp$/;
const PART = /^o\d+\.jpg\.part$/;

/** The page's image. Throws when the file is not a readable image. */
export async function readPage(uri: string): Promise<SkImage> {
  const data = Skia.Data.fromBytes(await new File(uri).bytes());
  const image = Skia.Image.MakeImageFromEncoded(data);
  data.dispose();
  if (!image) throw new Error('unreadable page');
  return image;
}

/** The untouched photo of the page at `uri`: the page after upright turning, before any filter. */
export function originalOf(uri: string): string {
  return uri.replace(/p(\d+\.jpg)$/, 'o$1');
}

/** Whether any of `pages` has no untouched photo, as pages scanned before originals were kept do. */
export function anyOriginalMissing(pages: string[]): boolean {
  return pages.some((page) => {
    const original = originalOf(page);
    return original !== page && !new File(original).exists;
  });
}

/** Keeps the page at `uri` as its untouched original, once: an original already there stays. */
export async function keepOriginal(uri: string): Promise<void> {
  const original = originalOf(uri);
  if (original === uri || new File(original).exists) return;
  // Nothing is there to move the copy over, so it goes through .part: listing drops a copy cut
  // short instead of keeping half a photo as the original.
  const part = new File(`${original}.part`);
  await part.write(await new File(uri).bytes());
  // No overwrite: an original that appeared meanwhile is older, so it wins.
  await part.move(new File(original));
}

/** Copies the page at `from` over the page at `to`, as a page write, so a crash mid-copy can't leave a broken page. */
export async function copyPage(from: string, to: string): Promise<void> {
  const tmp = new File(`${to}.tmp`);
  await tmp.write(await new File(from).bytes());
  await tmp.move(new File(to), { overwrite: true });
}

/** Replaces the page at `uri` with `image` as a JPEG. Swapping in a finished file means a crash mid-write can't leave a broken page. */
export async function replacePage(uri: string, image: SkImage): Promise<void> {
  const bytes = image.encodeToBytes(ImageFormat.JPEG, 90);
  // Native Skia returns null when encoding fails, whatever the type says.
  if (!bytes?.length) throw new Error('could not encode page');
  const tmp = new File(`${uri}.tmp`);
  await tmp.write(bytes);
  await tmp.move(new File(uri), { overwrite: true });
}

/** The folder's page files, sorted by number so p2 comes before p10. */
function pagesIn(dir: Directory): { n: number; name: string }[] {
  const entries = dir.list();
  const names = new Set(entries.map((f) => f.name));
  const pages: { n: number; name: string }[] = [];
  for (const f of entries) {
    let name = f.name;
    if (f instanceof File && PART.test(name)) {
      // A first copy of an original: with no whole file behind it, it can never be the photo.
      try {
        f.delete();
      } catch {}
      continue;
    }
    const replaced = REPLACEMENT.exec(name);
    if (replaced && f instanceof File) {
      const target = replaced[1];
      try {
        if (!names.has(target)) {
          // The app died mid-move, after the old file was deleted, so the replacement is whole:
          // put it back, page or original.
          f.rename(target);
          name = target;
        } else {
          // With its file still there, the write was cut short, so the replacement goes.
          f.delete();
        }
      } catch {}
    }
    const m = PAGE.exec(name);
    if (m) pages.push({ n: Number(m[1]), name });
  }
  return pages.sort((a, b) => a.n - b.n);
}

// Nothing is stored beyond the pages: the name comes from the folder's creation time.
const toScan = (dir: Directory): Scan => ({
  id: dir.name,
  name: scanName(new Date(Number(dir.name))),
  pages: pagesIn(dir).map((p) => new File(dir, p.name).uri),
});

/** Moves the pages into `dir` as p<first>.jpg onwards. File.move refuses to overwrite a page. */
async function movePages(dir: Directory, pageUris: string[], first: number): Promise<void> {
  for (const [i, uri] of pageUris.entries()) {
    await new File(uri).move(new File(dir, `p${first + i}.jpg`));
  }
}

/** All kept scans, newest first. A folder with no pages never got its first page, so it is not a scan. */
export function listScans(): Scan[] {
  const dir = root();
  if (!dir.exists) return [];
  const scans: Scan[] = [];
  for (const entry of dir.list()) {
    if (entry instanceof Directory && /^\d+$/.test(entry.name)) {
      // One unreadable folder must not crash the app at launch.
      try {
        const scan = toScan(entry);
        if (scan.pages.length) scans.push(scan);
      } catch {}
    }
  }
  return scans.sort((a, b) => Number(b.id) - Number(a.id));
}

/** Moves the scanner's page images into app storage as a new scan. */
export async function createScan(pageUris: string[]): Promise<Scan> {
  root().create({ idempotent: true, intermediates: true });
  let id = Date.now();
  while (new Directory(root(), String(id)).exists) id++;
  const dir = new Directory(root(), String(id));
  dir.create();
  try {
    await movePages(dir, pageUris, 1);
    return toScan(dir);
  } catch (e) {
    // Pages moved before the failure make a valid partial scan, so only an empty folder goes.
    try {
      if (!pagesIn(dir).length) dir.delete();
    } catch {}
    throw e;
  }
}

/** Moves more scanned pages into an existing scan, after its current pages. Pages moved before a failure stay. */
export async function addPages(scan: Scan, pageUris: string[]): Promise<Scan> {
  const dir = new Directory(root(), scan.id);
  const first = Math.max(0, ...pagesIn(dir).map((p) => p.n)) + 1;
  await movePages(dir, pageUris, first);
  return toScan(dir);
}

/** Removes a scan and its pages from app storage. Files already saved elsewhere stay. Errors reach the caller. */
export function deleteScan(scan: Scan): void {
  const dir = new Directory(root(), scan.id);
  if (dir.exists) dir.delete();
}
