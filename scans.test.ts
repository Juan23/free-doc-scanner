/// <reference types="jest" />
import { addPages, createScan, deleteScan, listScans } from './scans';
import { scanName } from './save';

// In-memory file system: uri -> directory marker or file text. Moves finish on a later tick.
const mockFs = { nodes: new Map<string, string>(), failMoveAt: 0, moves: 0, failDelete: false };
const DIR = '<dir>';

jest.mock('expo-file-system', () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  const join = (parts: any[]) => parts.map((p) => p.uri ?? p).join('/');
  class Node {
    uri: string;
    constructor(...parts: any[]) {
      this.uri = join(parts);
    }
    get name() {
      return this.uri.split('/').pop()!;
    }
    get exists() {
      return mockFs.nodes.has(this.uri);
    }
    delete() {
      if (!this.exists) throw new Error('not found');
      if (mockFs.failDelete) throw new Error('delete failed');
      for (const k of [...mockFs.nodes.keys()]) {
        if (k === this.uri || k.startsWith(`${this.uri}/`)) mockFs.nodes.delete(k);
      }
    }
  }
  class File extends Node {
    async move(dest: File) {
      await tick();
      if (++mockFs.moves === mockFs.failMoveAt) throw new Error('move failed');
      if (dest.exists) throw new Error('destination exists');
      mockFs.nodes.set(dest.uri, mockFs.nodes.get(this.uri)!);
      mockFs.nodes.delete(this.uri);
    }
    rename(name: string) {
      const to = this.uri.replace(/[^/]+$/, name);
      mockFs.nodes.set(to, mockFs.nodes.get(this.uri)!);
      mockFs.nodes.delete(this.uri);
    }
  }
  class Directory extends Node {
    create(options?: { idempotent?: boolean }) {
      if (this.exists && !options?.idempotent) throw new Error('exists');
      mockFs.nodes.set(this.uri, DIR);
    }
    list() {
      return [...mockFs.nodes.entries()]
        .filter(([k]) => k.startsWith(`${this.uri}/`) && !k.slice(this.uri.length + 1).includes('/'))
        .map(([k, v]) => (v === DIR ? new Directory(k) : new File(k)));
    }
  }
  return { File, Directory, Paths: { document: { uri: 'file:///doc' } } };
});

const ROOT = 'file:///doc/scans';
const put = (uri: string, text = 'x') => mockFs.nodes.set(uri, text);
// A scan folder holding the given page files, e.g. ['p1.jpg'].
const putScan = (id: string, pages: string[] = []) => {
  put(ROOT, DIR);
  put(`${ROOT}/${id}`, DIR);
  for (const p of pages) put(`${ROOT}/${id}/${p}`, `img-${p}`);
};
const scannerPages = (...names: string[]) =>
  names.map((n) => {
    put(`file:///cache/DocumentScanner/${n}`, `img-${n}`);
    return `file:///cache/DocumentScanner/${n}`;
  });

beforeEach(() => {
  mockFs.nodes.clear();
  mockFs.failMoveAt = 0;
  mockFs.moves = 0;
  mockFs.failDelete = false;
  jest.spyOn(Date, 'now').mockReturnValue(1000);
});

it('createScan moves the pages in order as p1..pN', async () => {
  const scan = await createScan(scannerPages('z.jpg', 'a.jpg'));
  expect(scan).toEqual({
    id: '1000',
    name: scanName(new Date(1000)),
    pages: [`${ROOT}/1000/p1.jpg`, `${ROOT}/1000/p2.jpg`],
  });
  expect(mockFs.nodes.get(`${ROOT}/1000/p1.jpg`)).toBe('img-z.jpg');
  expect(mockFs.nodes.get(`${ROOT}/1000/p2.jpg`)).toBe('img-a.jpg');
  expect(mockFs.nodes.has('file:///cache/DocumentScanner/z.jpg')).toBe(false);
});

it('createScan picks the next free id when the clock repeats', async () => {
  const a = await createScan(scannerPages('a.jpg'));
  const b = await createScan(scannerPages('b.jpg'));
  expect([a.id, b.id]).toEqual(['1000', '1001']);
});

it('createScan keeps the pages already moved when a later move fails', async () => {
  mockFs.failMoveAt = 2;
  await expect(createScan(scannerPages('a.jpg', 'b.jpg'))).rejects.toThrow('move failed');
  expect(listScans()[0].pages).toEqual([`${ROOT}/1000/p1.jpg`]);
});

it('createScan removes the folder when the first move fails', async () => {
  mockFs.failMoveAt = 1;
  await expect(createScan(scannerPages('a.jpg'))).rejects.toThrow('move failed');
  expect([...mockFs.nodes.keys()].filter((k) => k.startsWith(`${ROOT}/1000`))).toEqual([]);
});

it('listScans returns newest first and names each scan from its id', () => {
  expect(listScans()).toEqual([]);
  putScan('9', ['p1.jpg']);
  putScan('100', ['p1.jpg']);
  expect(listScans()).toEqual([
    { id: '100', name: scanName(new Date(100)), pages: [`${ROOT}/100/p1.jpg`] },
    { id: '9', name: scanName(new Date(9)), pages: [`${ROOT}/9/p1.jpg`] },
  ]);
});

it('listScans orders pages numerically and skips empty or non-numeric folders', () => {
  putScan('5', ['p10.jpg', 'p2.jpg', 'p1.jpg']);
  putScan('6');
  putScan('abc', ['p1.jpg']);
  put(`${ROOT}/stray.txt`);
  expect(listScans()).toEqual([
    {
      id: '5',
      name: scanName(new Date(5)),
      pages: [`${ROOT}/5/p1.jpg`, `${ROOT}/5/p2.jpg`, `${ROOT}/5/p10.jpg`],
    },
  ]);
});

// A page is replaced by writing p<N>.jpg.tmp, then moving it over the page, which deletes the page first.
it('listScans puts back a page killed mid-replace and drops replacements cut short', () => {
  putScan('5', ['p1.jpg', 'p1.jpg.tmp', 'p2.jpg.tmp']);
  expect(listScans()[0].pages).toEqual([`${ROOT}/5/p1.jpg`, `${ROOT}/5/p2.jpg`]);
  expect(mockFs.nodes.get(`${ROOT}/5/p1.jpg`)).toBe('img-p1.jpg');
  expect(mockFs.nodes.get(`${ROOT}/5/p2.jpg`)).toBe('img-p2.jpg.tmp');
  expect([...mockFs.nodes.keys()].filter((k) => k.endsWith('.tmp'))).toEqual([]);
});

it('listScans still lists a scan whose leftover replacement cannot be removed', () => {
  putScan('5', ['p1.jpg', 'p1.jpg.tmp']);
  mockFs.failDelete = true;
  expect(listScans()[0].pages).toEqual([`${ROOT}/5/p1.jpg`]);
});

it('addPages continues numbering after the highest page and never overwrites', async () => {
  putScan('5', ['p1.jpg', 'p3.jpg', 'p7.jpg']);
  // The caller's copy is stale (no pages), so numbering must come from the folder itself.
  const scan = await addPages({ id: '5', name: 'S', pages: [] }, scannerPages('n.jpg', 'm.jpg'));
  expect(scan.pages).toEqual([
    `${ROOT}/5/p1.jpg`,
    `${ROOT}/5/p3.jpg`,
    `${ROOT}/5/p7.jpg`,
    `${ROOT}/5/p8.jpg`,
    `${ROOT}/5/p9.jpg`,
  ]);
  expect(mockFs.nodes.get(`${ROOT}/5/p3.jpg`)).toBe('img-p3.jpg');
  expect(mockFs.nodes.get(`${ROOT}/5/p8.jpg`)).toBe('img-n.jpg');
  expect(listScans()[0].pages).toEqual(scan.pages);
});

it('addPages keeps the pages already moved when a later move fails', async () => {
  putScan('5', ['p1.jpg']);
  mockFs.failMoveAt = 2;
  await expect(addPages({ id: '5', name: 'S', pages: [] }, scannerPages('a.jpg', 'b.jpg'))).rejects.toThrow(
    'move failed',
  );
  expect(listScans()[0].pages).toEqual([`${ROOT}/5/p1.jpg`, `${ROOT}/5/p2.jpg`]);
});

it('deleteScan removes the folder and its pages', () => {
  putScan('5', ['p1.jpg']);
  deleteScan({ id: '5', name: 'S', pages: [] });
  expect(mockFs.nodes.has(`${ROOT}/5`)).toBe(false);
  expect(mockFs.nodes.has(`${ROOT}/5/p1.jpg`)).toBe(false);
});

it('deleteScan does nothing when the folder is already gone', () => {
  expect(() => deleteScan({ id: '5', name: 'S', pages: [] })).not.toThrow();
});

it('deleteScan lets a delete error reach the caller', () => {
  putScan('5', ['p1.jpg']);
  mockFs.failDelete = true;
  expect(() => deleteScan({ id: '5', name: 'S', pages: [] })).toThrow('delete failed');
});
