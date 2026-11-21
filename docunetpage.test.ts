/**
 * @jest-environment @shopify/react-native-skia/jestEnv.js
 */
/// <reference types="jest" />
import { findPage, type Point } from './crop';

// Runs findPage on DocUNet photos 1_1 to 65_2 (DOCUNET=<photo folder>) and compares each frame with a
// hand-checked list. The labels come from zooming each corner of the frame at full size on an overlay.
// A frame that cuts the page is worse than a loose frame or the whole photo, so a frame passes only when it is
// not worse than the list; the whole photo passes wherever a frame is not 'right'.
// 'right': the frame hugs the page (nothing beyond a thin blank margin outside it), so each corner stays within
//   RIGHT_TOLERANCE of the listed one. 1.5% of the diagonal is 76 px on a 3024 x 4032 photo, over twice the 29 px
//   the right frames moved between the side-fit settings tried.
// 'loose': the frame holds the page with extra around it, so it may only grow: every listed corner stays inside it.
// 'cut': page content lies outside the frame, as on `main`'s frame for the same photo (issue #85); it must not change.
// 'worse': page content lies outside the frame where `main` gives the whole photo; it must not change either, and
//   the fix is the whole photo.
// 'whole': no frame is known to be right, so a frame is a wrong one until someone checks it.

/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('path') as { join: (...parts: string[]) => string };
const fs = require('fs') as { readdirSync: (dir: string) => string[] };
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
const RIGHT_TOLERANCE = 0.015;
const LOOSE_SLACK = 0.003;
const SAME_FRAME = 0.004;

type Expected = 'whole' | ['right' | 'loose' | 'cut' | 'worse', [number, number][]];

const EXPECTED: Record<string, Expected> = {
  '1_1': 'whole',
  '1_2': 'whole',
  '2_1': 'whole',
  '2_2': 'whole',
  '3_1': 'whole',
  '3_2': 'whole',
  '4_1': 'whole',
  '4_2': 'whole',
  '5_1': 'whole',
  '5_2': ['cut', [[1113, 1013], [2039, 982], [1975, 2730], [1049, 2719]]],
  '6_1': 'whole',
  '6_2': 'whole',
  '7_1': 'whole',
  '7_2': ['worse', [[1141, 1460], [1817, 1309], [1756, 2843], [1103, 2831]]],
  '8_1': ['loose', [[1007, 1241], [1952, 1198], [1969, 2858], [1148, 2800]]],
  '8_2': 'whole',
  '9_1': ['loose', [[321, 1319], [2513, 1375], [2400, 2596], [410, 2348]]],
  '9_2': 'whole',
  '10_1': 'whole',
  '10_2': 'whole',
  '11_1': 'whole',
  '11_2': 'whole',
  '12_1': 'whole',
  '12_2': 'whole',
  '13_1': 'whole',
  '13_2': ['loose', [[961, 754], [3024, 1177], [2402, 4025], [1234, 3675]]],
  '14_1': 'whole',
  '14_2': 'whole',
  '15_1': ['cut', [[1006, 1270], [2117, 1270], [2117, 2695], [987, 2663]]],
  '15_2': 'whole',
  '16_1': ['loose', [[889, 1263], [2097, 1263], [2087, 3030], [875, 2888]]],
  '16_2': ['worse', [[1051, 1411], [2157, 1282], [2181, 2710], [1029, 2687]]],
  '17_1': ['worse', [[870, 1103], [2103, 1076], [2480, 2428], [738, 2571]]],
  '17_2': 'whole',
  '18_1': 'whole',
  '18_2': 'whole',
  '19_1': ['cut', [[892, 1140], [2254, 1208], [2021, 2970], [774, 2741]]],
  '19_2': 'whole',
  '20_1': 'whole',
  '20_2': ['loose', [[824, 380], [1953, 416], [2248, 3868], [1181, 3778]]],
  '21_1': 'whole',
  '21_2': 'whole',
  '22_1': 'whole',
  '22_2': 'whole',
  '23_1': 'whole',
  '23_2': ['loose', [[677, 1200], [3024, 1103], [2865, 2981], [890, 3353]]],
  '24_1': 'whole',
  '24_2': 'whole',
  '25_1': 'whole',
  '25_2': ['right', [[961, 1229], [2172, 1189], [2195, 2943], [738, 2863]]],
  '26_1': 'whole',
  '26_2': 'whole',
  '27_1': 'whole',
  '27_2': 'whole',
  '28_1': 'whole',
  '28_2': 'whole',
  '29_1': ['right', [[1059, 1362], [2060, 1321], [1972, 2707], [995, 2592]]],
  '29_2': 'whole',
  '30_1': 'whole',
  '30_2': 'whole',
  '31_1': ['cut', [[0, 830], [2349, 716], [2280, 2647], [475, 3309]]],
  '31_2': ['cut', [[1071, 1337], [2057, 1365], [2054, 2618], [1127, 2706]]],
  '32_1': 'whole',
  '32_2': 'whole',
  '33_1': ['worse', [[1032, 1377], [1973, 1435], [2006, 2643], [1050, 2675]]],
  '33_2': ['cut', [[971, 947], [1921, 785], [2215, 2870], [976, 2765]]],
  '34_1': 'whole',
  '34_2': ['right', [[1005, 1237], [2126, 1194], [2175, 2840], [946, 2839]]],
  '35_1': 'whole',
  '35_2': 'whole',
  '36_1': ['cut', [[875, 1223], [1985, 1220], [2121, 2778], [952, 2783]]],
  '36_2': 'whole',
  '37_1': ['right', [[962, 1257], [2089, 1257], [2109, 2744], [985, 2765]]],
  '37_2': ['cut', [[1046, 1257], [2189, 1255], [2242, 2477], [1083, 2410]]],
  '38_1': 'whole',
  '38_2': ['cut', [[937, 1341], [2257, 1377], [2196, 3138], [909, 3087]]],
  '39_1': 'whole',
  '39_2': ['right', [[949, 1178], [2289, 1178], [2211, 3104], [705, 2932]]],
  '40_1': 'whole',
  '40_2': 'whole',
  '41_1': 'whole',
  '41_2': 'whole',
  '42_1': ['right', [[983, 1333], [2042, 1299], [2029, 2663], [1019, 2684]]],
  '42_2': 'whole',
  '43_1': 'whole',
  '43_2': 'whole',
  '44_1': 'whole',
  '44_2': ['right', [[1000, 1362], [1824, 1478], [1868, 2950], [1002, 2950]]],
  '45_1': 'whole',
  '45_2': 'whole',
  '46_1': ['right', [[1070, 1358], [1941, 1316], [1958, 2646], [1120, 2703]]],
  '46_2': 'whole',
  '47_1': ['loose', [[976, 1140], [3024, 1108], [2726, 3601], [970, 3516]]],
  '47_2': 'whole',
  '48_1': 'whole',
  '48_2': ['loose', [[890, 428], [2267, 144], [2196, 3019], [858, 3019]]],
  '49_1': 'whole',
  '49_2': ['right', [[871, 1319], [2076, 1273], [2129, 2862], [748, 2786]]],
  '50_1': 'whole',
  '50_2': ['worse', [[960, 1304], [2241, 1304], [2255, 2964], [878, 3023]]],
  '51_1': ['loose', [[868, 1366], [2329, 1464], [2392, 3528], [920, 3678]]],
  '51_2': 'whole',
  '52_1': 'whole',
  '52_2': 'whole',
  '53_1': ['right', [[1055, 1215], [2172, 1219], [2220, 2704], [1055, 2725]]],
  '53_2': ['cut', [[951, 286], [2171, 400], [2127, 2884], [971, 2901]]],
  '54_1': 'whole',
  '54_2': ['cut', [[857, 1157], [2197, 1108], [2249, 2852], [917, 2862]]],
  '55_1': 'whole',
  '55_2': 'whole',
  '56_1': 'whole',
  '56_2': 'whole',
  '57_1': ['loose', [[917, 1274], [2165, 1249], [2131, 4032], [498, 3165]]],
  '57_2': ['cut', [[886, 1314], [2082, 1297], [2258, 2897], [851, 2893]]],
  '58_1': ['loose', [[674, 758], [2212, 416], [2146, 3177], [771, 3050]]],
  '58_2': 'whole',
  '59_1': ['loose', [[810, 1228], [2253, 1227], [2319, 3102], [710, 3140]]],
  '59_2': 'whole',
  '60_1': 'whole',
  '60_2': 'whole',
  '61_1': 'whole',
  '61_2': 'whole',
  '62_1': 'whole',
  '62_2': 'whole',
  '63_1': ['loose', [[703, 1171], [2663, 1299], [2285, 3129], [90, 2852]]],
  '63_2': 'whole',
  '64_1': ['loose', [[1240, 576], [3024, 1594], [2341, 2852], [0, 2797]]],
  '64_2': 'whole',
  '65_1': 'whole',
  '65_2': 'whole',
};

function distance(found: Point[], listed: [number, number][]): number[] {
  return found.map((p, i) => Math.hypot(p.x - listed[i][0], p.y - listed[i][1]));
}

/** How far `p` lies outside the clockwise quad `found`, 0 when inside. */
function outsideBy(found: Point[], p: [number, number]): number {
  return Math.max(
    0,
    ...found.map((a, i) => {
      const b = found[(i + 1) % 4];
      return -((b.x - a.x) * (p[1] - a.y) - (b.y - a.y) * (p[0] - a.x)) / Math.hypot(b.x - a.x, b.y - a.y);
    }),
  );
}

(DOCUNET_DIR ? it : it.skip)('finds the page on each DocUNet photo, and no frame that is worse than the list', async () => {
  const files = new Map(fs.readdirSync(DOCUNET_DIR!).map((f) => [f.replace(/\.jpe?g$/i, ''), f]));
  const problems: string[] = [];
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const { width, height, corners } = await findPage(path.join(DOCUNET_DIR!, files.get(name)!));
    const diagonal = Math.hypot(width, height);
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
    if (kind === 'right') {
      const worst = Math.max(...distance(corners, listed));
      if (worst > RIGHT_TOLERANCE * diagonal) problems.push(`${name}: right frame moved by ${Math.round(worst)} px`);
    } else if (kind === 'loose') {
      const worst = Math.max(...listed.map((p) => outsideBy(corners, p)));
      if (worst > LOOSE_SLACK * diagonal) problems.push(`${name}: loose frame moved in by ${Math.round(worst)} px`);
    } else {
      const worst = Math.max(...distance(corners, listed));
      if (worst > SAME_FRAME * diagonal) problems.push(`${name}: ${kind} frame changed by ${Math.round(worst)} px`);
    }
  }
  expect(problems).toEqual([]);
}, 600000);
