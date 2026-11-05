/**
 * @jest-environment @shopify/react-native-skia/jestEnv.js
 */
/// <reference types="jest" />
import { ImageFormat, Skia, TileMode } from '@shopify/react-native-skia';

import { rotatePage, uprightPages } from './upright';

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

// The wrapped Skia API has no font in Jest, but CanvasKit's own default typeface draws real text.
const CanvasKit = (globalThis as any).CanvasKit;

const W = 1200;
const H = 1600;

const LETTER = `Dear Ms Holloway,

Thank you for your letter of the third of June and for the copies of the
signed lease. I have checked them against the draft we agreed in May, and
apart from the date of the first payment everything is as it should be.
The keys can be collected from our office on Friday morning, or we can post
them to you by recorded delivery if that would be more convenient.

Please note that the boiler was serviced last month and the certificate is
enclosed. The meter readings were taken on the day the previous tenants left
and are shown on the attached sheet. If anything in the flat is not working
when you move in, write to us or telephone the office and we will arrange a
repair as quickly as we can.

The deposit has been placed with the protection scheme, which will write to
you directly within thirty days. Keep that letter safe, as you will need the
reference number when the tenancy comes to an end.

We hope you will be happy in your new home, and we look forward to hearing
from you.

Yours sincerely,

Jonathan Fairbanks
Lettings Manager`;

/** A photographed letter, turned clockwise by `turns` quarter turns: tinted paper, a little shadow at one side. */
function letter(turns = 0, text = LETTER): Uint8Array {
  const [w, h] = turns % 2 ? [H, W] : [W, H];
  const surface = CanvasKit.MakeSurface(w, h);
  const canvas = surface.getCanvas();
  canvas.translate(w / 2, h / 2);
  canvas.rotate(turns * 90, 0, 0);
  canvas.translate(-W / 2, -H / 2);
  const paper = new CanvasKit.Paint();
  for (let x = 0; x < W; x += 10) {
    const shade = Math.round((36 * x) / W);
    paper.setColor(CanvasKit.Color(236 - shade, 230 - shade, 214 - shade));
    canvas.drawRect(CanvasKit.XYWHRect(x, 0, 10, H), paper);
  }
  const ink = new CanvasKit.Paint();
  ink.setColor(CanvasKit.Color(30, 30, 40));
  ink.setAntiAlias(true);
  const font = new CanvasKit.Font(CanvasKit.Typeface.GetDefault(), 22);
  text.split('\n').forEach((line, i) => canvas.drawText(line, 110, 160 + i * 36, ink, font));
  return surface.makeImageSnapshot().encodeToBytes(CanvasKit.ImageFormat.JPEG, 92);
}

/** A photo with no writing in it: sky, a sun and dark hills. */
function landscape(): Uint8Array {
  const surface = Skia.Surface.Make(W, H)!;
  const canvas = surface.getCanvas();
  const sky = Skia.Paint();
  for (let y = 0; y < H; y += 10) {
    const t = y / H;
    sky.setColor(Skia.Color(`rgb(${Math.round(120 + 120 * t)},${Math.round(170 + 60 * t)},${Math.round(230 - 30 * t)})`));
    canvas.drawRect(Skia.XYWHRect(0, y, W, 10), sky);
  }
  const blob = Skia.Paint();
  blob.setImageFilter(Skia.ImageFilter.MakeBlur(12, 12, TileMode.Clamp, null));
  blob.setColor(Skia.Color('rgb(250,220,120)'));
  canvas.drawCircle(850, 400, 120, blob);
  blob.setColor(Skia.Color('rgb(40,90,50)'));
  canvas.drawOval(Skia.XYWHRect(-300, 900, 1100, 900), blob);
  blob.setColor(Skia.Color('rgb(30,60,40)'));
  canvas.drawOval(Skia.XYWHRect(400, 1000, 1200, 900), blob);
  return surface.makeImageSnapshot().encodeToBytes(ImageFormat.JPEG, 92);
}

const decode = (bytes: Uint8Array) => Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(bytes))!;

// The page still holds these very bytes, so it was not rewritten. (A failing toBe would print a whole page.)
const untouched = (bytes: Uint8Array) => mockFiles.get(PAGE) === bytes;

function luma(bytes: Uint8Array): { width: number; height: number; at: (x: number, y: number) => number } {
  const image = decode(bytes);
  const width = image.width();
  const height = image.height();
  const px = image.readPixels(0, 0, { width, height, colorType: 4, alphaType: 3 }) as Uint8Array;
  return { width, height, at: (x, y) => (px[(y * width + x) * 4] + px[(y * width + x) * 4 + 1] + px[(y * width + x) * 4 + 2]) / 3 };
}

/** Mean brightness difference per pixel between two pictures of the same size. */
function difference(a: Uint8Array, b: Uint8Array): number {
  const la = luma(a);
  const lb = luma(b);
  expect([la.width, la.height]).toEqual([lb.width, lb.height]);
  let sum = 0;
  for (let y = 0; y < la.height; y += 2) for (let x = 0; x < la.width; x += 2) sum += Math.abs(la.at(x, y) - lb.at(x, y));
  return sum / ((la.width / 2) * (la.height / 2));
}

it.each([1, 2, 3])('turns a letter photographed %i quarter turns clockwise upright, in place', async (turns) => {
  mockFiles.set(PAGE, letter(turns));

  await uprightPages([PAGE]);

  expect([...mockFiles.keys()]).toEqual([PAGE]);
  expect(difference(mockFiles.get(PAGE)!, letter())).toBeLessThan(3);
}, 30000);

it('leaves an upright letter untouched', async () => {
  const page = letter();
  mockFiles.set(PAGE, page);

  await uprightPages([PAGE]);

  expect(untouched(page)).toBe(true);
}, 30000);

// Capitals all stand on the baseline and reach the same height, so only stray marks such as commas
// stick out, and they don't show reliably which way is up.
const LIST = Array.from({ length: 30 }, (_, i) => `ITEM ${i}: SALT, RICE, OATS, MILK, TEA, SOAP, CORN, OIL, NUTS, EGGS, HAM,`).join('\n');

it.each([0, 1, 2, 3])('leaves a list in capitals as it is, however it is turned (%i)', async (turns) => {
  const page = letter(turns, LIST);
  mockFiles.set(PAGE, page);

  await uprightPages([PAGE]);

  expect(untouched(page)).toBe(true);
}, 30000);

// Upright Russian has more descenders (р у д ц щ ф) than ascenders, so it leans the way upside-down
// Latin does. CanvasKit's default typeface has Cyrillic.
const RUSSIAN = Array.from({ length: 38 }, (_, i) => [
  'Мы получили ваше письмо и благодарим за интерес к нашей работе. К сожалению, в',
  'этом году мы не сможем принять участие в выставке, потому что наша группа',
  'занята подготовкой нового проекта. Однако мы будем рады встретиться с вами в',
  'другое время и обсудить возможное сотрудничество. Пожалуйста, сообщите, какие',
  'дни вам удобны, и мы постараемся найти подходящее время для встречи в нашем',
][i % 5]).join('\n');

it.each([0, 1, 2, 3])('never turns a page of Russian text the wrong way (%i)', async (turns) => {
  const page = letter(turns, RUSSIAN);
  mockFiles.set(PAGE, page);

  await uprightPages([PAGE]);

  expect(untouched(page) || difference(mockFiles.get(PAGE)!, letter(0, RUSSIAN)) < 3).toBe(true);
}, 30000);

// Every line runs flush from margin to margin, so the line ends can't tell which way is up: the
// full stops sitting on the baseline must.
const NOTICE = `The office will be closed on Monday for the bank holiday. Post that arrives on that day will be
handled on Tuesday morning. Rent paid by standing order will leave your account as usual. If you pay by
cheque, please post it by Thursday so that it reaches us in time. The car park will be locked from
Saturday evening until Tuesday. Residents can still use the side gate with their own key. The lift
engineer is booked for Wednesday. The lift will be out of use from nine until about noon. We are sorry
for the trouble. Bins will be collected a day late that week. Please leave them out on Tuesday night
rather than on Monday. The cleaners will come on Friday as usual. Parcels left with the porter can be
picked up from Tuesday. Bring the card that was put through your door. If you have any questions, ring
the office or send us a note. Our phone number is on the board in the hall. We will reply as soon as we
can. Thank you for your patience. We hope you all have a good break. The next newsletter will come out
at the end of the month. It will have the dates for the summer fair. Volunteers for the fair can give
their names to the porter. The garden committee meets on the first Thursday of each month.`;

const flushFont = new CanvasKit.Font(CanvasKit.Typeface.GetDefault(), 22);
const width = (word: string): number => flushFont.getGlyphWidths(flushFont.getGlyphIDs(word)).reduce((a: number, b: number) => a + b, 0);

/** `text` drawn like `letter`, its words wrapped and spread so every line is 980 wide; the last, partly filled line left out. */
function justified(turns: number, text: string, eachGap?: (canvas: any, x: number, y: number) => void): Uint8Array {
  const [w, h] = turns % 2 ? [H, W] : [W, H];
  const surface = CanvasKit.MakeSurface(w, h);
  const canvas = surface.getCanvas();
  canvas.clear(CanvasKit.Color(236, 230, 214));
  canvas.translate(w / 2, h / 2);
  canvas.rotate(turns * 90, 0, 0);
  canvas.translate(-W / 2, -H / 2);
  const ink = new CanvasKit.Paint();
  ink.setColor(CanvasKit.Color(30, 30, 40));
  ink.setAntiAlias(true);
  const space = width(' ');
  const lines: string[][] = [[]];
  let used = 0;
  for (const word of text.split(/\s+/)) {
    if (used + width(word) > 980) {
      lines.push([]);
      used = 0;
    }
    lines[lines.length - 1].push(word);
    used += width(word) + space;
  }
  lines.slice(0, -1).forEach((words, i) => {
    const y = 160 + i * 36;
    const gap = (980 - words.reduce((sum, word) => sum + width(word), 0)) / (words.length - 1);
    let x = 110;
    for (const word of words) {
      canvas.drawText(word, x, y, ink, flushFont);
      x += width(word) + gap;
      eachGap?.(canvas, x - gap / 2, y);
    }
  });
  return surface.makeImageSnapshot().encodeToBytes(CanvasKit.ImageFormat.JPEG, 92);
}

it.each([1, 2, 3])('turns a page of flush lines %i quarter turns clockwise upright', async (turns) => {
  mockFiles.set(PAGE, justified(turns, NOTICE));

  await uprightPages([PAGE]);

  expect(difference(mockFiles.get(PAGE)!, justified(0, NOTICE))).toBeLessThan(3);
}, 30000);

// Its strokes lean like upside-down Latin, while its full stops sit on the baseline: the two disagree.
const RUSSIAN_NOTICE = `Офис будет закрыт в понедельник по случаю праздника. Почта, которая придёт в этот день, будет
разобрана во вторник утром. Плата за аренду по поручению уйдёт с вашего счёта как обычно. Если вы
платите чеком, отправьте его до четверга, чтобы он успел дойти. Стоянка будет закрыта с вечера
субботы до вторника. Жильцы могут пользоваться боковой калиткой со своим ключом. Мастер по лифтам
придёт в среду. Лифт не будет работать с девяти часов примерно до полудня. Просим прощения за
неудобства. Мусор в ту неделю вывезут на день позже. Пожалуйста, выставляйте баки во вторник
вечером, а не в понедельник. Уборщицы придут в пятницу как обычно. Посылки, оставленные у
консьержа, можно забрать со вторника. Возьмите с собой карточку, которую вам опустили в ящик.
Если у вас есть вопросы, позвоните в офис или оставьте записку. Наш телефон есть на доске в
холле. Мы ответим как можно скорее. Спасибо за терпение. Желаем всем хорошо отдохнуть. Следующий
выпуск новостей выйдет в конце месяца. В нём будут даты летней ярмарки. Добровольцы для ярмарки
могут оставить свои имена у консьержа. Садовый комитет собирается в первый четверг каждого месяца.`;

// Three times over, to fill the page.
const RUSSIAN_PAGE = Array(3).fill(RUSSIAN_NOTICE).join(' ');

it.each([0, 1, 2, 3])('never turns a page of flush Russian lines the wrong way (%i)', async (turns) => {
  const page = justified(turns, RUSSIAN_PAGE);
  mockFiles.set(PAGE, page);

  await uprightPages([PAGE]);

  expect(untouched(page) || difference(mockFiles.get(PAGE)!, justified(0, RUSSIAN_PAGE)) < 3).toBe(true);
}, 30000);

// Hebrew's yod hangs from the top of its line like an upside-down full stop, in nearly every word.
// Marks that common belong to the script, so they mustn't count as full stops: here they hang from
// the x-line of Russian text, whose strokes already lean like upside-down Latin.
function withYods(turns: number): Uint8Array {
  const xHeight = -flushFont.getGlyphBounds(flushFont.getGlyphIDs('x'))[1];
  const yod = new CanvasKit.Paint();
  yod.setColor(CanvasKit.Color(30, 30, 40));
  return justified(turns, RUSSIAN_PAGE, (canvas, x, y) => canvas.drawRect(CanvasKit.XYWHRect(x - 2, y - xHeight, 4, 4), yod));
}

it.each([0, 1, 2, 3])('never takes marks in nearly every word for full stops (%i)', async (turns) => {
  const page = withYods(turns);
  mockFiles.set(PAGE, page);

  await uprightPages([PAGE]);

  expect(untouched(page) || difference(mockFiles.get(PAGE)!, withYods(0)) < 3).toBe(true);
}, 30000);

/** A folded card: its top lines upright, its bottom lines upside down, all turned by `turns`. */
function card(turns: number): Uint8Array {
  const lines = LETTER.split('\n').filter((line) => line.length > 40);
  const [w, h] = turns % 2 ? [H, W] : [W, H];
  const surface = CanvasKit.MakeSurface(w, h);
  const canvas = surface.getCanvas();
  canvas.clear(CanvasKit.Color(236, 230, 214));
  canvas.translate(w / 2, h / 2);
  canvas.rotate(turns * 90, 0, 0);
  const ink = new CanvasKit.Paint();
  ink.setColor(CanvasKit.Color(30, 30, 40));
  ink.setAntiAlias(true);
  const font = new CanvasKit.Font(CanvasKit.Typeface.GetDefault(), 22);
  lines.forEach((line, i) => canvas.drawText(line, -490, -720 + i * 36, ink, font));
  canvas.rotate(180, 0, 0);
  lines.slice(0, 8).forEach((line, i) => canvas.drawText(line, -490, -720 + i * 36, ink, font));
  return surface.makeImageSnapshot().encodeToBytes(CanvasKit.ImageFormat.JPEG, 92);
}

// Most lines say one way up, but a third say the other: the lines disagree, so the page stays as it is.
it.each([0, 1, 2, 3])('leaves a card with lines both ways up as it is (%i)', async (turns) => {
  const page = card(turns);
  mockFiles.set(PAGE, page);

  await uprightPages([PAGE]);

  expect(untouched(page)).toBe(true);
}, 30000);

it.each([0, 1, 2, 3])('leaves a photo with no writing untouched, however it is turned (%i)', async (turns) => {
  mockFiles.set(PAGE, landscape());
  await rotatePage(PAGE, turns);
  const page = mockFiles.get(PAGE)!;

  await uprightPages([PAGE]);

  expect(untouched(page)).toBe(true);
}, 30000);

it('leaves a page it cannot read as it is, and turns the rest', async () => {
  const broken = new Uint8Array([1, 2, 3]);
  mockFiles.set('file:///doc/scans/1/p1.jpg', broken);
  mockFiles.set('file:///doc/scans/1/p2.jpg', letter(2));

  await uprightPages(['file:///doc/scans/1/p1.jpg', 'file:///doc/scans/1/p2.jpg']);

  expect(mockFiles.get('file:///doc/scans/1/p1.jpg')).toBe(broken);
  expect(difference(mockFiles.get('file:///doc/scans/1/p2.jpg')!, letter())).toBeLessThan(3);
}, 30000);

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
