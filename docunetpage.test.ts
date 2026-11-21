/**
 * @jest-environment @shopify/react-native-skia/jestEnv.js
 */
/// <reference types="jest" />
import { findPage, type Point } from './crop';

// Runs findPage on DocUNet photos 1_1 to 30_2 (DOCUNET=<photo folder>) and compares each frame with a
// hand-checked list made from overlays of the frame on the photo.
// 'right': the frame hugs the page, so the corners must stay within TOLERANCE of the listed ones.
// 'whole': no frame is known to be right, so a new frame is a wrong one until someone checks it.
// 'bad': the frame listed was found and is loose or wrong; whole is better, anything else is worse.

/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('path') as { join: (...parts: string[]) => string };
/* eslint-enable @typescript-eslint/no-require-imports */

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
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return new Uint8Array(require('fs').readFileSync(this.uri));
    }
  }
  return { File };
});

const DOCUNET_DIR = process.env.DOCUNET;
const TOLERANCE = 0.04;

type Expected = 'whole' | ['right' | 'bad', [number, number][]];

const EXPECTED: Record<string, Expected> = {
  '1_1': ['bad', [[1032, 556], [1889, 566], [2091, 2766], [989, 2795]]],
  '1_2': ['right', [[976, 1391], [2058, 1059], [2036, 2658], [973, 2701]]],
  '2_1': 'whole',
  '2_2': ['right', [[848, 539], [1608, 658], [2181, 2860], [1331, 3118]]],
  '3_1': ['right', [[1064, 1160], [1836, 1079], [2064, 2625], [1202, 2717]]],
  '3_2': 'whole',
  '4_1': 'whole',
  '4_2': ['right', [[1255, 1241], [1795, 1135], [1951, 2707], [1360, 2727]]],
  '5_1': ['right', [[1072, 1270], [1915, 1242], [1925, 2688], [1114, 2727]]],
  '5_2': ['right', [[1113, 1013], [2039, 982], [1975, 2730], [1049, 2719]]],
  '6_1': 'whole',
  '6_2': 'whole',
  '7_1': 'whole',
  '7_2': ['right', [[1141, 1460], [1817, 1309], [1756, 2843], [1103, 2831]]],
  '8_1': ['right', [[1007, 1241], [1952, 1198], [1969, 2858], [1148, 2800]]],
  '8_2': 'whole',
  '9_1': ['bad', [[321, 1319], [2513, 1375], [2400, 2596], [410, 2348]]],
  '9_2': ['right', [[850, 1342], [2270, 1355], [2234, 2398], [816, 2572]]],
  '10_1': 'whole',
  '10_2': 'whole',
  '11_1': ['right', [[796, 1348], [2233, 1295], [2361, 2667], [939, 2862]]],
  '11_2': ['right', [[899, 1130], [2064, 1038], [2341, 2518], [614, 2843]]],
  '12_1': ['right', [[1055, 1431], [2088, 1060], [2208, 3158], [1039, 3128]]],
  '12_2': ['right', [[1046, 1399], [1980, 1334], [2114, 2738], [1172, 2860]]],
  '13_1': 'whole',
  '13_2': ['bad', [[961, 754], [3024, 1177], [2402, 4025], [1234, 3675]]],
  '14_1': ['bad', [[1733, 1103], [2381, 1059], [2380, 3051], [1668, 2953]]],
  '14_2': 'whole',
  '15_1': ['right', [[1006, 1270], [2117, 1270], [2117, 2695], [987, 2663]]],
  '15_2': 'whole',
  '16_1': ['right', [[888, 1301], [2097, 1243], [2087, 3030], [875, 2888]]],
  '16_2': ['right', [[1051, 1411], [2157, 1282], [2181, 2710], [1029, 2687]]],
  '17_1': ['right', [[870, 1102], [2107, 1076], [2240, 2511], [725, 2718]]],
  '17_2': ['right', [[650, 1271], [2001, 1297], [2436, 2769], [1123, 2815]]],
  '18_1': ['right', [[777, 1257], [2110, 1226], [2005, 2897], [752, 2940]]],
  '18_2': 'whole',
  '19_1': ['right', [[892, 1140], [2254, 1208], [2021, 2970], [774, 2741]]],
  '19_2': 'whole',
  '20_1': ['bad', [[922, 1025], [1975, 956], [2093, 2544], [1143, 2668]]],
  '20_2': ['bad', [[874, 382], [1953, 416], [2248, 3868], [1155, 3775]]],
  '21_1': ['bad', [[1027, 291], [2070, 149], [2731, 3476], [80, 3571]]],
  '21_2': ['bad', [[282, 2047], [2072, 875], [2923, 2733], [1684, 3881]]],
  '22_1': ['right', [[859, 1221], [2082, 1159], [2123, 2815], [997, 2749]]],
  '22_2': ['right', [[1171, 1326], [2168, 1381], [1997, 2727], [645, 2522]]],
  '23_1': ['right', [[921, 1203], [2016, 1062], [2124, 2717], [921, 2769]]],
  '23_2': ['bad', [[677, 1200], [3024, 1105], [2898, 2975], [890, 3353]]],
  '24_1': 'whole',
  '24_2': 'whole',
  '25_1': ['right', [[1171, 1360], [2056, 1386], [2049, 2446], [965, 2546]]],
  '25_2': ['right', [[961, 1229], [2172, 1189], [2195, 2943], [738, 2863]]],
  '26_1': 'whole',
  '26_2': 'whole',
  '27_1': 'whole',
  '27_2': ['right', [[1009, 1091], [2069, 1021], [2059, 2596], [1049, 2548]]],
  '28_1': 'whole',
  '28_2': 'whole',
  '29_1': ['right', [[1088, 1361], [2060, 1321], [1972, 2707], [991, 2591]]],
  '29_2': 'whole',
  '30_1': 'whole',
  '30_2': 'whole',
};

function distance(found: Point[], listed: [number, number][]): number[] {
  return found.map((p, i) => Math.hypot(p.x - listed[i][0], p.y - listed[i][1]));
}

(DOCUNET_DIR ? it : it.skip)('finds the page on each DocUNet photo, and no wrong frame', async () => {
  const problems: string[] = [];
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const { width, height, corners } = await findPage(path.join(DOCUNET_DIR!, `${name}.jpg`));
    const isWhole = corners[0].x < 1 && corners[0].y < 1 && corners[2].x > width - 1 && corners[2].y > height - 1;
    if (expected === 'whole') {
      if (!isWhole) problems.push(`${name}: a frame where none was known to be right`);
      continue;
    }
    const [kind, listed] = expected;
    if (isWhole) {
      if (kind === 'right') problems.push(`${name}: lost its right frame`);
      continue;
    }
    const worst = Math.max(...distance(corners, listed));
    if (worst > TOLERANCE * Math.hypot(width, height)) problems.push(`${name}: frame moved by ${Math.round(worst)} px`);
  }
  expect(problems).toEqual([]);
}, 600000);
