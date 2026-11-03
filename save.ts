import { Directory, File, Paths } from 'expo-file-system';
import { Album, Asset, requestPermissionsAsync } from 'expo-media-library';
import { Platform } from 'react-native';

const ALBUM = 'Free Doc Scanner';
const pad = (n: number) => String(n).padStart(2, '0');

/** "Scan 2026-11-03 19.42": base name for the PDF and the JPEG pages. */
export function scanName(date: Date = new Date()): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `Scan ${day} ${pad(date.getHours())}.${pad(date.getMinutes())}`;
}

/** Asks the user for a folder and writes `<name>.pdf` there, never overwriting. */
export async function savePdf(pdfUri: string, name: string): Promise<'saved' | 'cancelled'> {
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
    await out.write(await new File(pdfUri).bytes());
  } catch (e) {
    try {
      out.delete();
    } catch {}
    throw e;
  }
  return 'saved';
}

/** Saves the pages, in order, as `<name> p1.jpg`, `<name> p2.jpg`… to Photos / Gallery. */
export async function saveJpegs(pages: string[], name: string): Promise<'saved' | 'denied'> {
  const { granted } = await requestPermissionsAsync(true);
  if (!granted) return 'denied';
  // Temps live in the scanner's folder so clearScannerCache sweeps them after a kill.
  const dir = new Directory(Paths.cache, 'DocumentScanner');
  dir.create({ idempotent: true });
  const temps = pages.map((_, i) => new File(dir, `${name} p${i + 1}.jpg`));
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
    discardScan(temps.map((t) => t.uri));
  }
  return 'saved';
}

/** Deletes the scanner's temporary files. Never throws. */
export function discardScan(uris: string[]): void {
  for (const uri of uris) {
    try {
      const file = new File(uri);
      if (file.exists) file.delete();
    } catch {}
  }
}

/** Deletes the scanner's cache folder (pages and PDFs left by an interrupted scan). Never throws. */
export function clearScannerCache(): void {
  try {
    const dir = new Directory(Paths.cache, 'DocumentScanner');
    if (dir.exists) dir.delete();
  } catch {}
}
