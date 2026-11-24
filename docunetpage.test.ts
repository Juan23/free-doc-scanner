/**
 * @jest-environment @shopify/react-native-skia/jestEnv.js
 */
/// <reference types="jest" />
import { findPage, type Point } from './crop';

// Each DocUNet photo (DOCUNET=<photo folder>) must get its recorded frame or the whole photo, as a cut frame is worse than either.

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
// Px each corner may move and still be the recorded frame.
const SAME_FRAME = 1;
// Share of the diagonal a corner may move out while the frame holds the recorded one: the fit can pull a side inside the page.
const MOVED_OUT = 0.02;

// 'right' hugs the page, so it must stay; 'other' is loose or cut, so the whole photo may replace it.
type RecordedFrame = 'whole' | ['right' | 'other', [number, number][]];

const RECORDED: Record<string, RecordedFrame> = {
  '1_1': ['other', [[1032, 556], [1889, 566], [2091, 2766], [989, 2795]]],
  '1_2': 'whole',
  '2_1': 'whole',
  '2_2': ['other', [[824, 467], [1565, 454], [2066, 2457], [1239, 2584]]],
  '3_1': 'whole',
  '3_2': 'whole',
  '4_1': 'whole',
  '4_2': 'whole',
  '5_1': 'whole',
  '5_2': ['other', [[1113, 1013], [2039, 982], [1975, 2730], [1049, 2719]]],
  '6_1': 'whole',
  '6_2': 'whole',
  '7_1': 'whole',
  '7_2': 'whole',
  '8_1': 'whole',
  '8_2': 'whole',
  '9_1': ['other', [[144, 1313], [2752, 1382], [2605, 2622], [243, 2326]]],
  '9_2': 'whole',
  '10_1': 'whole',
  '10_2': 'whole',
  '11_1': 'whole',
  '11_2': 'whole',
  '12_1': 'whole',
  '12_2': 'whole',
  '13_1': 'whole',
  '13_2': ['other', [[371, 640], [3024, 1177], [2402, 4025], [6, 3306]]],
  '14_1': ['other', [[1715, 1499], [2382, 1410], [2389, 3648], [1654, 3392]]],
  '14_2': 'whole',
  '15_1': ['other', [[1006, 1270], [2117, 1270], [2117, 2695], [987, 2663]]],
  '15_2': 'whole',
  '16_1': ['other', [[890, 1071], [2098, 1208], [2087, 3030], [875, 2888]]],
  '16_2': 'whole',
  '17_1': 'whole',
  '17_2': 'whole',
  '18_1': 'whole',
  '18_2': 'whole',
  '19_1': ['other', [[1681, 1177], [2254, 1207], [2021, 2971], [1453, 2866]]],
  '19_2': ['other', [[862, 1375], [2850, 1319], [2699, 4022], [1088, 3699]]],
  '20_1': 'whole',
  '20_2': ['other', [[874, 382], [1953, 416], [2248, 3868], [1155, 3775]]],
  '21_1': 'whole',
  '21_2': ['other', [[66, 1758], [1856, 1456], [3024, 2669], [776, 2697]]],
  '22_1': ['other', [[817, 686], [2065, 494], [2139, 3409], [1030, 3189]]],
  '22_2': ['other', [[226, 1367], [2024, 41], [2034, 2943], [1035, 3375]]],
  '23_1': ['right', [[921, 1203], [2016, 1062], [2124, 2717], [921, 2769]]],
  '23_2': 'whole',
  '24_1': 'whole',
  '24_2': ['other', [[976, 1096], [2147, 1079], [2209, 3840], [813, 3814]]],
  '25_1': 'whole',
  '25_2': ['other', [[1061, 495], [2752, 403], [2990, 3252], [706, 3095]]],
  '26_1': 'whole',
  '26_2': 'whole',
  '27_1': 'whole',
  '27_2': ['other', [[1011, 1091], [2091, 1018], [2392, 3507], [1067, 3618]]],
  '28_1': 'whole',
  '28_2': 'whole',
  '29_1': ['other', [[1123, 846], [2100, 643], [1928, 3434], [940, 3313]]],
  '29_2': 'whole',
  '30_1': 'whole',
  '30_2': 'whole',
  '31_1': ['other', [[0, 830], [2349, 716], [2280, 2647], [475, 3309]]],
  '31_2': ['other', [[1071, 1336], [2968, 1391], [2931, 2533], [1127, 2706]]],
  '32_1': 'whole',
  '32_2': ['other', [[1038, 1360], [2130, 1277], [2170, 2719], [1063, 2759]]],
  '33_1': 'whole',
  '33_2': ['other', [[971, 947], [1921, 785], [2215, 2870], [976, 2765]]],
  '34_1': 'whole',
  '34_2': 'whole',
  '35_1': 'whole',
  '35_2': ['other', [[340, 517], [2133, 0], [2294, 3042], [759, 2999]]],
  '36_1': ['other', [[852, 748], [1930, 590], [2121, 2778], [952, 2783]]],
  '36_2': 'whole',
  '37_1': ['other', [[961, 1257], [2088, 1257], [2117, 3177], [1001, 3606]]],
  '37_2': ['other', [[1046, 1257], [2189, 1255], [2242, 2477], [1083, 2410]]],
  '38_1': ['other', [[786, 1199], [2200, 1219], [2160, 2978], [846, 3073]]],
  '38_2': ['other', [[937, 1341], [2257, 1377], [2196, 3138], [909, 3087]]],
  '39_1': ['other', [[808, 257], [2205, 541], [2145, 2976], [204, 2931]]],
  '39_2': ['right', [[949, 1178], [2289, 1178], [2211, 3104], [705, 2932]]],
  '40_1': 'whole',
  '40_2': 'whole',
  '41_1': ['other', [[901, 85], [1945, 236], [2180, 2947], [998, 3025]]],
  '41_2': 'whole',
  '42_1': 'whole',
  '42_2': 'whole',
  '43_1': 'whole',
  '43_2': 'whole',
  '44_1': 'whole',
  '44_2': 'whole',
  '45_1': ['other', [[977, 1519], [1653, 1351], [2415, 3041], [1332, 2797]]],
  '45_2': ['other', [[449, 1312], [2521, 1275], [3024, 2241], [1393, 3115]]],
  '46_1': ['right', [[1070, 1358], [1941, 1316], [1958, 2646], [1120, 2703]]],
  '46_2': 'whole',
  '47_1': 'whole',
  '47_2': 'whole',
  '48_1': ['other', [[419, 262], [2443, 228], [2320, 2981], [726, 2575]]],
  '48_2': ['other', [[890, 428], [2267, 144], [2196, 3019], [858, 3019]]],
  '49_1': ['other', [[850, 1195], [2620, 1226], [2269, 3300], [843, 2895]]],
  '49_2': ['other', [[172, 1345], [2076, 1273], [2129, 2862], [242, 2758]]],
  '50_1': 'whole',
  '50_2': 'whole',
  '51_1': ['other', [[553, 0], [2311, 221], [2391, 3666], [418, 3888]]],
  '51_2': ['other', [[720, 821], [2228, 695], [2227, 2363], [633, 2372]]],
  '52_1': ['other', [[873, 37], [2259, 143], [1959, 2799], [838, 2882]]],
  '52_2': 'whole',
  '53_1': ['right', [[1055, 1215], [2172, 1219], [2220, 2704], [1055, 2725]]],
  '53_2': ['other', [[952, 286], [2140, 397], [2163, 3761], [976, 3645]]],
  '54_1': ['other', [[745, 1227], [2178, 1298], [2359, 3205], [700, 3232]]],
  '54_2': ['other', [[857, 1157], [2197, 1108], [2249, 2852], [917, 2862]]],
  '55_1': ['other', [[1338, 139], [2742, 300], [1114, 3684], [0, 3511]]],
  '55_2': ['other', [[890, 743], [2110, 706], [2091, 1477], [737, 1405]]],
  '56_1': ['other', [[975, 1236], [2084, 1165], [2183, 2652], [867, 2655]]],
  '56_2': 'whole',
  '57_1': ['other', [[917, 1274], [2165, 1249], [2131, 4032], [498, 3165]]],
  '57_2': ['other', [[886, 1314], [2082, 1297], [2258, 2897], [851, 2893]]],
  '58_1': ['other', [[674, 758], [2212, 416], [2146, 3177], [771, 3050]]],
  '58_2': ['other', [[1278, 1541], [2186, 1525], [2050, 3059], [321, 2947]]],
  '59_1': ['other', [[803, 1228], [2253, 1227], [2319, 3102], [738, 3140]]],
  '59_2': ['other', [[190, 2605], [2381, 2592], [2401, 3271], [443, 3325]]],
  '60_1': 'whole',
  '60_2': ['other', [[874, 1189], [2607, 1325], [2840, 3025], [923, 3303]]],
  '61_1': 'whole',
  '61_2': 'whole',
  '62_1': ['other', [[562, 554], [2267, 611], [2116, 3457], [760, 3330]]],
  '62_2': 'whole',
  '63_1': ['other', [[703, 1171], [2659, 1298], [2161, 3763], [0, 3398]]],
  '63_2': ['other', [[735, 862], [2182, 859], [2264, 2643], [886, 2637]]],
  '64_1': ['other', [[1338, 626], [3024, 1595], [1862, 3623], [244, 3125]]],
  '64_2': ['other', [[553, 765], [2035, 982], [2659, 3689], [0, 3827]]],
  '65_1': 'whole',
  '65_2': 'whole',
};

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

(DOCUNET_DIR ? it : it.skip)('gives the recorded frame or the whole photo on each DocUNet photo, never another frame', async () => {
  const files = new Map(fs.readdirSync(DOCUNET_DIR!).map((f) => [f.replace(/\.jpe?g$/i, ''), f]));
  const problems: string[] = [];
  for (const [name, recorded] of Object.entries(RECORDED)) {
    const { width, height, corners } = await findPage(path.join(DOCUNET_DIR!, files.get(name)!));
    const isWhole = corners[0].x < 1 && corners[0].y < 1 && corners[2].x > width - 1 && corners[2].y > height - 1;
    if (recorded === 'whole') {
      if (!isWhole) problems.push(`${name}: a frame where the whole photo is recorded`);
      continue;
    }
    const [kind, listed] = recorded;
    if (isWhole) {
      if (kind === 'right') problems.push(`${name}: lost the right frame`);
      continue;
    }
    const moved = Math.max(...corners.map((p, i) => Math.hypot(p.x - listed[i][0], p.y - listed[i][1])));
    const holdsRecorded = Math.max(...listed.map((p) => outsideBy(corners, p))) <= SAME_FRAME;
    if (moved > SAME_FRAME && !(holdsRecorded && moved <= MOVED_OUT * Math.hypot(width, height))) {
      problems.push(`${name}: a frame that is not the recorded one, off by ${Math.round(moved)} px`);
    }
  }
  expect(problems).toEqual([]);
}, 600000);
