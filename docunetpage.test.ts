/**
 * @jest-environment @shopify/react-native-skia/jestEnv.js
 */
/// <reference types="jest" />
import { findPage, type Point } from './crop';

// Runs findPage on DocUNet photos 1_1 to 65_2 (DOCUNET=<photo folder>) and compares each frame with a
// hand-checked list made from overlays of the frames on the photos. A frame that cuts the page is worse than
// a loose frame or the whole photo, so only a frame that is not worse than the list passes.
// 'right': the frame hugs the page, so the corners must stay within TOLERANCE of the listed ones.
// 'loose': the listed frame holds the page with extra around it; it or the whole photo passes, any other frame fails.
// 'cut': the listed frame cuts the page (issue #85); it or the whole photo passes, and a better frame means updating the list.
// 'whole': no frame is known to be right, so a new frame is a wrong one until someone checks it.

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
const TOLERANCE = 0.04;

type Expected = 'whole' | ['right' | 'loose' | 'cut', [number, number][]];

const EXPECTED: Record<string, Expected> = {
  '1_1': ['loose', [[1032, 556], [1889, 566], [2091, 2766], [989, 2795]]],
  '1_2': 'whole',
  '2_1': 'whole',
  '2_2': ['cut', [[824, 467], [1565, 454], [2066, 2457], [1239, 2584]]],
  '3_1': ['right', [[1064, 1160], [1836, 1079], [2064, 2625], [1202, 2717]]],
  '3_2': 'whole',
  '4_1': 'whole',
  '4_2': 'whole',
  '5_1': ['right', [[1072, 1270], [1915, 1242], [1925, 2688], [1114, 2727]]],
  '5_2': ['right', [[1113, 1013], [2039, 982], [1975, 2730], [1049, 2719]]],
  '6_1': 'whole',
  '6_2': 'whole',
  '7_1': 'whole',
  '7_2': ['right', [[1141, 1460], [1817, 1309], [1756, 2843], [1103, 2831]]],
  '8_1': ['right', [[1007, 1241], [1952, 1198], [1969, 2858], [1148, 2800]]],
  '8_2': 'whole',
  '9_1': ['loose', [[321, 1319], [2513, 1375], [2400, 2596], [410, 2348]]],
  '9_2': ['right', [[850, 1342], [2270, 1355], [2234, 2398], [816, 2572]]],
  '10_1': 'whole',
  '10_2': 'whole',
  '11_1': ['right', [[796, 1348], [2233, 1295], [2361, 2667], [939, 2862]]],
  '11_2': ['right', [[899, 1130], [2064, 1038], [2341, 2518], [614, 2843]]],
  '12_1': 'whole',
  '12_2': ['right', [[1046, 1399], [1980, 1334], [2114, 2738], [1172, 2860]]],
  '13_1': 'whole',
  '13_2': ['loose', [[961, 754], [3024, 1177], [2402, 4025], [1234, 3675]]],
  '14_1': ['cut', [[1715, 1499], [2382, 1410], [2389, 3648], [1654, 3392]]],
  '14_2': 'whole',
  '15_1': ['right', [[1006, 1270], [2117, 1270], [2117, 2695], [987, 2663]]],
  '15_2': 'whole',
  '16_1': ['loose', [[888, 1301], [2097, 1243], [2087, 3030], [875, 2888]]],
  '16_2': ['right', [[1051, 1411], [2157, 1282], [2181, 2710], [1029, 2687]]],
  '17_1': ['loose', [[870, 1103], [2103, 1076], [2480, 2428], [738, 2571]]],
  '17_2': ['right', [[650, 1271], [2001, 1297], [2436, 2769], [1123, 2815]]],
  '18_1': ['right', [[777, 1256], [2012, 1228], [2094, 2894], [752, 2939]]],
  '18_2': 'whole',
  '19_1': ['right', [[892, 1140], [2254, 1208], [2021, 2970], [774, 2741]]],
  '19_2': 'whole',
  '20_1': 'whole',
  '20_2': ['loose', [[874, 382], [1953, 416], [2248, 3868], [1155, 3775]]],
  '21_1': ['loose', [[1027, 291], [2070, 149], [2731, 3476], [80, 3571]]],
  '21_2': ['cut', [[70, 1763], [2283, 1376], [2906, 2666], [778, 2699]]],
  '22_1': ['right', [[859, 1221], [2082, 1159], [2123, 2815], [997, 2749]]],
  '22_2': ['right', [[1171, 1326], [2168, 1381], [1997, 2727], [645, 2522]]],
  '23_1': ['right', [[921, 1203], [2016, 1062], [2124, 2717], [921, 2769]]],
  '23_2': ['loose', [[677, 1200], [3024, 1105], [2898, 2975], [890, 3353]]],
  '24_1': 'whole',
  '24_2': 'whole',
  '25_1': 'whole',
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
  '31_1': ['loose', [[0, 830], [2349, 716], [2280, 2647], [475, 3309]]],
  '31_2': ['right', [[1071, 1337], [2057, 1365], [2054, 2618], [1127, 2706]]],
  '32_1': ['loose', [[543, 1000], [2039, 1239], [2673, 2809], [705, 2748]]],
  '32_2': ['right', [[1038, 1360], [2130, 1277], [2170, 2719], [1063, 2759]]],
  '33_1': ['right', [[1032, 1377], [1973, 1435], [2006, 2643], [1050, 2675]]],
  '33_2': ['loose', [[971, 947], [1921, 785], [2215, 2870], [976, 2765]]],
  '34_1': 'whole',
  '34_2': ['right', [[1005, 1237], [2126, 1194], [2175, 2840], [946, 2839]]],
  '35_1': ['cut', [[928, 1270], [1974, 1270], [2074, 2108], [968, 2161]]],
  '35_2': 'whole',
  '36_1': ['right', [[875, 1223], [1985, 1220], [2121, 2778], [952, 2783]]],
  '36_2': ['right', [[1309, 1234], [2280, 1287], [1891, 2816], [906, 2513]]],
  '37_1': ['right', [[962, 1257], [2089, 1257], [2109, 2744], [985, 2765]]],
  '37_2': ['cut', [[1046, 1257], [2189, 1255], [2242, 2477], [1083, 2410]]],
  '38_1': ['right', [[786, 1199], [2200, 1219], [2160, 2978], [846, 3073]]],
  '38_2': ['right', [[937, 1341], [2257, 1377], [2196, 3138], [909, 3087]]],
  '39_1': 'whole',
  '39_2': ['right', [[949, 1178], [2289, 1178], [2211, 3104], [705, 2932]]],
  '40_1': 'whole',
  '40_2': 'whole',
  '41_1': ['loose', [[926, 833], [2017, 1007], [2178, 2947], [998, 3025]]],
  '41_2': ['right', [[798, 1201], [2354, 1241], [2154, 2997], [885, 2960]]],
  '42_1': ['right', [[983, 1333], [2042, 1299], [2029, 2663], [1019, 2684]]],
  '42_2': 'whole',
  '43_1': 'whole',
  '43_2': 'whole',
  '44_1': 'whole',
  '44_2': ['right', [[1000, 1389], [1824, 1474], [1868, 2950], [1002, 2950]]],
  '45_1': 'whole',
  '45_2': ['cut', [[449, 1312], [2521, 1275], [3024, 2241], [1393, 3115]]],
  '46_1': ['right', [[1070, 1358], [1941, 1316], [1958, 2646], [1120, 2703]]],
  '46_2': 'whole',
  '47_1': ['loose', [[976, 1140], [3024, 1108], [2726, 3601], [970, 3516]]],
  '47_2': ['right', [[975, 1428], [2094, 1324], [2073, 3072], [1004, 3094]]],
  '48_1': ['cut', [[419, 262], [2443, 228], [2320, 2981], [726, 2575]]],
  '48_2': ['loose', [[890, 428], [2267, 144], [2196, 3019], [858, 3019]]],
  '49_1': ['right', [[852, 1195], [2172, 1218], [2092, 2872], [839, 3123]]],
  '49_2': ['right', [[871, 1319], [2076, 1273], [2129, 2862], [748, 2786]]],
  '50_1': ['loose', [[816, 1334], [2460, 1357], [2505, 3908], [941, 3903]]],
  '50_2': ['right', [[959, 1339], [2240, 1278], [2255, 2964], [878, 3023]]],
  '51_1': ['loose', [[868, 1366], [2329, 1464], [2392, 3528], [920, 3678]]],
  '51_2': 'whole',
  '52_1': ['right', [[873, 1160], [2151, 1162], [1955, 2800], [831, 2882]]],
  '52_2': 'whole',
  '53_1': ['right', [[1055, 1215], [2172, 1219], [2220, 2704], [1055, 2725]]],
  '53_2': ['loose', [[951, 286], [2140, 397], [2157, 2884], [971, 2901]]],
  '54_1': ['right', [[745, 1227], [2178, 1298], [2359, 3205], [700, 3232]]],
  '54_2': ['right', [[857, 1157], [2197, 1108], [2249, 2852], [917, 2862]]],
  '55_1': 'whole',
  '55_2': 'whole',
  '56_1': ['right', [[975, 1236], [2084, 1165], [2183, 2652], [867, 2655]]],
  '56_2': ['right', [[1046, 1281], [2054, 1340], [2169, 2787], [963, 2803]]],
  '57_1': ['loose', [[917, 1274], [2165, 1249], [2131, 4032], [498, 3165]]],
  '57_2': ['right', [[886, 1314], [2082, 1297], [2258, 2897], [851, 2893]]],
  '58_1': ['loose', [[674, 758], [2212, 416], [2146, 3177], [771, 3050]]],
  '58_2': ['cut', [[1278, 1541], [2186, 1525], [2050, 3059], [321, 2947]]],
  '59_1': ['right', [[803, 1228], [2253, 1227], [2319, 3102], [738, 3140]]],
  '59_2': ['right', [[804, 1060], [2343, 898], [2394, 3271], [705, 3318]]],
  '60_1': ['cut', [[801, 1055], [1786, 1017], [2085, 2871], [660, 3147]]],
  '60_2': 'whole',
  '61_1': 'whole',
  '61_2': 'whole',
  '62_1': ['loose', [[601, 1118], [2243, 1072], [2128, 3216], [781, 3582]]],
  '62_2': ['cut', [[570, 812], [2323, 777], [2196, 1837], [699, 1836]]],
  '63_1': ['loose', [[703, 1171], [2663, 1299], [2285, 3129], [90, 2852]]],
  '63_2': ['right', [[735, 862], [2182, 859], [2264, 2643], [886, 2637]]],
  '64_1': ['loose', [[1240, 576], [3024, 1594], [2341, 2852], [0, 2797]]],
  '64_2': ['loose', [[857, 1311], [2113, 1316], [2659, 3690], [1042, 3771]]],
  '65_1': 'whole',
  '65_2': 'whole',
};

function distance(found: Point[], listed: [number, number][]): number[] {
  return found.map((p, i) => Math.hypot(p.x - listed[i][0], p.y - listed[i][1]));
}

(DOCUNET_DIR ? it : it.skip)('finds the page on each DocUNet photo, and no wrong frame', async () => {
  // The photos are .jpg up to 37_2 and .JPG after.
  const files = new Map(fs.readdirSync(DOCUNET_DIR!).map((f) => [f.replace(/\.jpe?g$/i, ''), f]));
  const problems: string[] = [];
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const { width, height, corners } = await findPage(path.join(DOCUNET_DIR!, files.get(name)!));
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
