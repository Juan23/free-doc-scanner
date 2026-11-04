/// <reference types="jest" />
import { Directory } from 'expo-file-system';
import { Album, Asset, requestPermissionsAsync } from 'expo-media-library';
import { Platform } from 'react-native';

import { clearScannerCache, saveJpegs, savePdf, scanName } from './save';

// In-memory file system. Writes and copies finish on a later tick, like the native module.
const mockFs = {
  existing: new Set<string>(),
  finished: new Set<string>(),
  written: new Map<string, Uint8Array>(),
  created: [] as { name: string; mime: string; file: unknown }[],
  deleted: [] as string[],
  failWrite: false,
  failDelete: false,
};

function resetFs() {
  mockFs.existing.clear();
  mockFs.finished.clear();
  mockFs.written.clear();
  mockFs.created.length = 0;
  mockFs.deleted.length = 0;
  mockFs.failWrite = false;
  mockFs.failDelete = false;
}

jest.mock('expo-file-system', () => {
  const mockTick = () => new Promise<void>((r) => setTimeout(r, 0));
  const join = (parts: any[]) => parts.map((p) => p.uri ?? p).join('/');
  const remove = (uri: string) => {
    mockFs.deleted.push(uri);
    if (mockFs.failDelete) throw new Error('delete failed');
    mockFs.existing.delete(uri);
  };
  class File {
    uri: string;
    constructor(...parts: any[]) {
      this.uri = join(parts);
    }
    get exists() {
      return mockFs.existing.has(this.uri);
    }
    async bytes() {
      await mockTick();
      return new Uint8Array([1, 2]);
    }
    async write(data: Uint8Array) {
      await mockTick();
      if (mockFs.failWrite) throw new Error('disk full');
      mockFs.written.set(this.uri, data);
      mockFs.existing.add(this.uri);
      mockFs.finished.add(this.uri);
    }
    async copy(dest: File) {
      await mockTick();
      mockFs.written.set(dest.uri, mockFs.written.get(this.uri)!);
      mockFs.existing.add(dest.uri);
      mockFs.finished.add(dest.uri);
    }
    delete() {
      remove(this.uri);
    }
  }
  class Directory {
    uri: string;
    static pickDirectoryAsync = jest.fn();
    constructor(...parts: any[]) {
      this.uri = join(parts);
    }
    get exists() {
      return mockFs.existing.has(this.uri);
    }
    delete() {
      remove(this.uri);
    }
    create() {
      mockFs.existing.add(this.uri);
    }
    createFile(name: string, mime: string) {
      const file = new File(this.uri, name);
      mockFs.created.push({ name, mime, file });
      return file;
    }
  }
  return { File, Directory, Paths: { cache: { uri: 'file:///cache' } } };
});
// buildPdf is covered with real pdf-lib in buildPdf.test.ts; here it only has to yield bytes.
jest.mock('pdf-lib', () => ({
  PDFDocument: {
    create: async () => ({
      embedJpg: async () => ({ width: 1, height: 1 }),
      addPage: () => ({ drawImage: () => {} }),
      save: async () => new Uint8Array([1, 2]),
    }),
  },
}));
jest.mock('expo-media-library', () => ({
  Asset: { create: jest.fn() },
  Album: { create: jest.fn() },
  requestPermissionsAsync: jest.fn(),
}));

const pickFolder = () =>
  (Directory.pickDirectoryAsync as jest.Mock).mockResolvedValue(new Directory('file:///picked'));

beforeEach(() => {
  jest.clearAllMocks();
  resetFs();
  Platform.OS = 'ios';
});

it('formats the scan name in local time', () => {
  expect(scanName(new Date(2026, 10, 3, 9, 5))).toBe('Scan 2026-11-03 09.05');
});

it('writes <name>.pdf into the picked folder and resolves only after the bytes land', async () => {
  pickFolder();
  expect(await savePdf(['file:///cache/a.jpg'], 'Scan X')).toBe('saved');
  expect(mockFs.created).toEqual([
    expect.objectContaining({ name: 'Scan X.pdf', mime: 'application/pdf' }),
  ]);
  expect(mockFs.finished.has('file:///picked/Scan X.pdf')).toBe(true);
  expect(mockFs.written.get('file:///picked/Scan X.pdf')).toEqual(new Uint8Array([1, 2]));
});

it('deletes the half-written PDF and rejects when the write fails', async () => {
  pickFolder();
  mockFs.failWrite = true;
  await expect(savePdf(['file:///cache/a.jpg'], 'Scan X')).rejects.toThrow('disk full');
  expect(mockFs.deleted).toEqual(['file:///picked/Scan X.pdf']);
});

it('rethrows a picker error that is not a cancel', async () => {
  (Directory.pickDirectoryAsync as jest.Mock).mockRejectedValue(
    Object.assign(new Error('picker broke'), { code: 'ERR_SOMETHING' })
  );
  await expect(savePdf(['file:///cache/a.jpg'], 'Scan X')).rejects.toThrow('picker broke');
});

it('rejects with the write error when the cleanup delete also throws', async () => {
  pickFolder();
  mockFs.failWrite = true;
  mockFs.failDelete = true;
  await expect(savePdf(['file:///cache/a.jpg'], 'Scan X')).rejects.toThrow('disk full');
});

it('on iOS picks "(2)" when <name>.pdf is taken', async () => {
  pickFolder();
  mockFs.existing.add('file:///picked/Scan X.pdf');
  await savePdf(['file:///cache/a.jpg'], 'Scan X');
  expect(mockFs.created[0]).toEqual(expect.objectContaining({ name: 'Scan X (2).pdf' }));
});

it('on Android does not probe for a taken name', async () => {
  Platform.OS = 'android';
  pickFolder();
  mockFs.existing.add('file:///picked/Scan X.pdf');
  await savePdf(['file:///cache/a.jpg'], 'Scan X');
  expect(mockFs.created[0]).toEqual(expect.objectContaining({ name: 'Scan X.pdf' }));
});

it('returns cancelled when the picker is cancelled', async () => {
  (Directory.pickDirectoryAsync as jest.Mock).mockRejectedValue(
    Object.assign(new Error('cancelled'), { code: 'ERR_PICKER_CANCELLED' })
  );
  expect(await savePdf(['file:///cache/a.jpg'], 'Scan X')).toBe('cancelled');
});

it('returns cancelled when only the message says so (minified Android release)', async () => {
  (Directory.pickDirectoryAsync as jest.Mock).mockRejectedValue(
    Object.assign(new Error('Call to function rejected. Caused by: The file picker was cancelled by the user'), {
      code: 'ERR_A',
    })
  );
  expect(await savePdf(['file:///cache/a.jpg'], 'Scan X')).toBe('cancelled');
});

it('on iOS saves pages in order as p1..pN, each after its copy finished', async () => {
  (requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
  mockFs.written.set('file:///a.jpg', new Uint8Array([1]));
  mockFs.written.set('file:///b.jpg', new Uint8Array([2]));
  const finishedAtCreate: boolean[] = [];
  const contents: Uint8Array[] = [];
  (Asset.create as jest.Mock).mockImplementation(async (uri: string) => {
    finishedAtCreate.push(mockFs.finished.has(uri));
    contents.push(mockFs.written.get(uri)!);
  });
  expect(await saveJpegs(['file:///a.jpg', 'file:///b.jpg'], 'Scan X')).toBe('saved');
  expect((Asset.create as jest.Mock).mock.calls.map((c) => c[0])).toEqual([
    'file:///cache/DocumentScanner/Scan X p1.jpg',
    'file:///cache/DocumentScanner/Scan X p2.jpg',
  ]);
  expect(contents).toEqual([new Uint8Array([1]), new Uint8Array([2])]);
  expect(finishedAtCreate).toEqual([true, true]);
  expect(mockFs.deleted).toEqual([
    'file:///cache/DocumentScanner/Scan X p1.jpg',
    'file:///cache/DocumentScanner/Scan X p2.jpg',
  ]);
});

it('on Android puts all pages in one album, in order, after the copies finished', async () => {
  Platform.OS = 'android';
  (requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
  mockFs.written.set('file:///a.jpg', new Uint8Array([1]));
  mockFs.written.set('file:///b.jpg', new Uint8Array([2]));
  let finishedAtCreate: boolean[] = [];
  let contents: (Uint8Array | undefined)[] = [];
  (Album.create as jest.Mock).mockImplementation(async (_name: string, uris: string[]) => {
    finishedAtCreate = uris.map((u) => mockFs.finished.has(u));
    contents = uris.map((u) => mockFs.written.get(u));
  });
  expect(await saveJpegs(['file:///a.jpg', 'file:///b.jpg'], 'Scan X')).toBe('saved');
  expect(Album.create).toHaveBeenCalledWith('Free Doc Scanner', [
    'file:///cache/DocumentScanner/Scan X p1.jpg',
    'file:///cache/DocumentScanner/Scan X p2.jpg',
  ]);
  expect(contents).toEqual([new Uint8Array([1]), new Uint8Array([2])]);
  expect(finishedAtCreate).toEqual([true, true]);
  expect(Asset.create).not.toHaveBeenCalled();
});

it('returns denied without permission', async () => {
  (requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
  expect(await saveJpegs(['file:///a.jpg'], 'Scan X')).toBe('denied');
  expect(Asset.create).not.toHaveBeenCalled();
});

it('clearScannerCache deletes the DocumentScanner and Camera folders and never throws', () => {
  clearScannerCache();
  expect(mockFs.deleted).toEqual([]);
  mockFs.existing.add('file:///cache/DocumentScanner');
  mockFs.existing.add('file:///cache/Camera');
  clearScannerCache();
  expect(mockFs.deleted).toEqual(['file:///cache/DocumentScanner', 'file:///cache/Camera']);
  mockFs.existing.add('file:///cache/DocumentScanner');
  mockFs.failDelete = true;
  expect(() => clearScannerCache()).not.toThrow();
});
