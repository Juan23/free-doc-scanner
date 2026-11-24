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
  '2_2': 'whole',
  '3_1': ['right', [[1065, 1160], [1831, 1078], [2094, 2621], [1201, 2717]]],
  '3_2': 'whole',
  '4_1': 'whole',
  '4_2': 'whole',
  '5_1': ['right', [[1075, 1234], [1902, 1245], [1931, 2686], [1113, 2728]]],
  '5_2': ['right', [[1104, 1014], [2027, 982], [1980, 2719], [1048, 2723]]],
  '6_1': 'whole',
  '6_2': 'whole',
  '7_1': 'whole',
  '7_2': 'whole',
  '8_1': 'whole',
  '8_2': 'whole',
  '9_1': ['right', [[620, 1326], [2514, 1375], [2400, 2592], [671, 2405]]],
  '9_2': 'whole',
  '10_1': 'whole',
  '10_2': 'whole',
  '11_1': ['right', [[797, 1358], [2230, 1256], [2361, 2669], [940, 2863]]],
  '11_2': 'whole',
  '12_1': ['other', [[1063, 808], [2085, 909], [2226, 3591], [1035, 3351]]],
  '12_2': 'whole',
  '13_1': 'whole',
  '13_2': ['other', [[371, 640], [3024, 1177], [2402, 4025], [6, 3306]]],
  '14_1': 'whole',
  '14_2': 'whole',
  '15_1': ['right', [[1006, 1270], [2117, 1270], [2117, 2699], [986, 2710]]],
  '15_2': 'whole',
  '16_1': ['other', [[890, 1071], [2098, 1208], [2087, 3030], [875, 2888]]],
  '16_2': 'whole',
  '17_1': 'whole',
  '17_2': 'whole',
  '18_1': 'whole',
  '18_2': ['right', [[1019, 1276], [2246, 1226], [2271, 2719], [1058, 2719]]],
  '19_1': 'whole',
  '19_2': ['other', [[862, 1375], [2850, 1319], [2699, 4022], [1088, 3699]]],
  '20_1': 'whole',
  '20_2': ['other', [[874, 382], [1953, 416], [2248, 3868], [1155, 3775]]],
  '21_1': ['other', [[1027, 292], [2101, 143], [1960, 3506], [81, 3570]]],
  '21_2': ['other', [[66, 1758], [1856, 1456], [3024, 2669], [776, 2697]]],
  '22_1': ['other', [[817, 686], [2065, 494], [2139, 3409], [1030, 3189]]],
  '22_2': ['other', [[226, 1367], [2024, 41], [2034, 2943], [1035, 3375]]],
  '23_1': ['right', [[921, 1203], [2016, 1062], [2124, 2717], [921, 2769]]],
  '23_2': 'whole',
  '24_1': 'whole',
  '24_2': ['other', [[976, 1096], [2147, 1079], [2209, 3840], [813, 3814]]],
  '25_1': 'whole',
  '25_2': ['right', [[960, 1229], [2172, 1189], [2195, 2943], [738, 2863]]],
  '26_1': 'whole',
  '26_2': 'whole',
  '27_1': 'whole',
  '27_2': ['other', [[1011, 1091], [2091, 1018], [2392, 3507], [1067, 3618]]],
  '28_1': 'whole',
  '28_2': 'whole',
  '29_1': ['right', [[1116, 1360], [2070, 1319], [1972, 2708], [981, 2590]]],
  '29_2': 'whole',
  '30_1': 'whole',
  '30_2': 'whole',
  '31_1': 'whole',
  '31_2': ['other', [[1071, 1336], [2968, 1391], [2931, 2533], [1127, 2706]]],
  '32_1': 'whole',
  '32_2': ['right', [[1066, 1271], [2147, 1304], [2162, 2718], [976, 2763]]],
  '33_1': ['right', [[1030, 1378], [1973, 1435], [2005, 2642], [1045, 2677]]],
  '33_2': ['right', [[972, 1287], [2005, 1302], [2161, 2866], [976, 2766]]],
  '34_1': 'whole',
  '34_2': 'whole',
  '35_1': 'whole',
  '35_2': ['other', [[340, 517], [2133, 0], [2294, 3042], [759, 2999]]],
  '36_1': ['right', [[885, 1221], [1984, 1223], [2121, 2779], [927, 2784]]],
  '36_2': 'whole',
  '37_1': ['other', [[961, 1257], [2088, 1257], [2117, 3177], [1001, 3606]]],
  '37_2': ['other', [[1046, 1257], [2189, 1255], [2242, 2477], [1083, 2410]]],
  '38_1': ['other', [[786, 1199], [2200, 1219], [2160, 2978], [846, 3073]]],
  '38_2': ['right', [[922, 1341], [2257, 1376], [2196, 3147], [908, 3089]]],
  '39_1': ['other', [[808, 257], [2205, 541], [2145, 2976], [204, 2931]]],
  '39_2': ['right', [[949, 1178], [2289, 1178], [2211, 3104], [705, 2932]]],
  '40_1': ['right', [[727, 1204], [1952, 1032], [2254, 2506], [1065, 2774]]],
  '40_2': 'whole',
  '41_1': ['other', [[901, 85], [1945, 236], [2180, 2947], [998, 3025]]],
  '41_2': 'whole',
  '42_1': ['right', [[1003, 1340], [2043, 1283], [2028, 2657], [897, 2698]]],
  '42_2': 'whole',
  '43_1': 'whole',
  '43_2': ['right', [[728, 1316], [2181, 1307], [2092, 3051], [854, 3007]]],
  '44_1': 'whole',
  '44_2': ['right', [[999, 1428], [1823, 1458], [1868, 2949], [1002, 2951]]],
  '45_1': ['other', [[977, 1519], [1653, 1351], [2415, 3041], [1332, 2797]]],
  '45_2': 'whole',
  '46_1': ['right', [[1070, 1358], [1941, 1316], [1958, 2646], [1120, 2703]]],
  '46_2': 'whole',
  '47_1': ['other', [[445, 1147], [3024, 1108], [2726, 3600], [306, 3486]]],
  '47_2': ['right', [[979, 1352], [2094, 1344], [2073, 3072], [1001, 3093]]],
  '48_1': ['other', [[419, 262], [2443, 228], [2320, 2981], [726, 2575]]],
  '48_2': ['right', [[878, 1343], [2237, 1388], [2196, 3018], [859, 3020]]],
  '49_1': ['other', [[850, 1195], [2620, 1226], [2269, 3300], [843, 2895]]],
  '49_2': ['right', [[870, 1319], [2076, 1272], [2129, 2863], [746, 2785]]],
  '50_1': ['other', [[477, 264], [2466, 246], [2499, 3908], [477, 3902]]],
  '50_2': ['right', [[955, 1348], [2259, 1278], [2252, 2967], [883, 3022]]],
  '51_1': ['other', [[553, 0], [2311, 221], [2391, 3666], [418, 3888]]],
  '51_2': ['right', [[587, 817], [2238, 765], [2206, 2837], [734, 2627]]],
  '52_1': ['other', [[873, 37], [2259, 143], [1959, 2799], [838, 2882]]],
  '52_2': 'whole',
  '53_1': ['right', [[1055, 1215], [2172, 1219], [2220, 2704], [1055, 2725]]],
  '53_2': ['right', [[958, 1298], [2141, 1357], [2174, 2884], [971, 2902]]],
  '54_1': 'whole',
  '54_2': ['right', [[837, 1174], [2191, 1106], [2251, 2852], [890, 2862]]],
  '55_1': 'whole',
  '55_2': 'whole',
  '56_1': ['right', [[980, 1233], [2192, 1163], [2173, 2652], [864, 2655]]],
  '56_2': 'whole',
  '57_1': ['other', [[917, 1274], [2165, 1249], [2131, 4032], [498, 3165]]],
  '57_2': ['other', [[886, 1314], [2082, 1297], [2258, 2897], [851, 2893]]],
  '58_1': ['other', [[674, 758], [2212, 416], [2146, 3177], [771, 3050]]],
  '58_2': ['other', [[1278, 1541], [2186, 1525], [2050, 3059], [321, 2947]]],
  '59_1': ['other', [[803, 1228], [2253, 1227], [2319, 3102], [738, 3140]]],
  '59_2': 'whole',
  '60_1': 'whole',
  '60_2': ['other', [[658, 1161], [2094, 1290], [2103, 2505], [920, 2648]]],
  '61_1': 'whole',
  '61_2': 'whole',
  '62_1': ['other', [[562, 554], [2267, 611], [2116, 3457], [760, 3330]]],
  '62_2': 'whole',
  '63_1': 'whole',
  '63_2': ['other', [[735, 862], [2182, 859], [2264, 2643], [886, 2637]]],
  '64_1': ['other', [[1338, 626], [3024, 1595], [1862, 3623], [244, 3125]]],
  '64_2': ['other', [[553, 765], [2035, 982], [2659, 3689], [0, 3827]]],
  '65_1': 'whole',
  '65_2': ['other', [[239, 990], [1768, 863], [1805, 3873], [175, 3755]]],
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
