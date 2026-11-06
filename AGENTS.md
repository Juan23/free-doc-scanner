This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — check the docs for this SDK

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Read the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`, or the installed source in `node_modules`.

## Commands

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint, typecheck and `npm test` before declaring any task done.

## Building

Builds run locally from the project root. Use these two commands:

```bash
npx expo run:ios --device
```

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
npx expo run:android --device
```

The iOS Simulator has no camera, so scanning on iOS needs a real iPhone. An Android emulator can run the camera screen, but its camera saves black photos.

## This app

- Screens in `App.tsx` (Scans history, a scan's detail, and Android's camera screen), switched with state. There is no router. A scan's detail has a Select mode: `Root` holds the picked page URIs (`picked`, null outside it), and `pagesToSave` in `save.ts` keeps them in page order, or every page when none are picked.
- Scans are kept in the app's document folder (`scans.ts`): one folder per scan, named by its creation time in ms, holding its pages as `p1.jpg`, `p2.jpg`… There is no index file: the name comes from the folder name and the page order from the numbers. A page is replaced by writing `p<N>.jpg.tmp` and moving it over the page, which deletes the page first; listing a scan puts back a `.tmp` whose page is gone and deletes any other.
- Saving is in `save.ts`: PDFs are built from the page JPEGs with `pdf-lib`; JPEGs go to Photos/Gallery. Tests sit next to each file.
- Scanning on iOS is `CameraView.scanDocumentAsync` from `expo-camera` (VisionKit). Android has the app's own camera screen instead, because Google's ML Kit scanner always opens in auto capture: it ignores its capture-mode extra, and also its initial-images extra, so it can't be fed our photos either (both checked on Play services 26.41, 2026-11-04). `crop.ts` finds the page's corners in each photo (the largest bright region on a small copy, its corners along the diagonals; the whole photo when none stands out) and straightens the page inside the corners with a Skia perspective matrix. Its tests run on real pixels like `clean.ts`'s.
- Clean-up is in `clean.ts`: Skia whitens each new page right after it is stored, replacing the page file. It also whitens what shows past bent or curled page edges: what touches the border, differs from the paper in the middle of the page, stays shallow and bends smoothly like a paper edge. Print the crop cuts into has walls (letters, bands, pictures) or runs straight along a side, so it stays. It is on unless a `clean-up-off` file sits in the document folder. Its tests run on real pixels through Skia's CanvasKit Jest environment.
- Turning pages is in `upright.ts`: `rotatePage` turns a stored page by quarter turns; `uprightPages` turns sideways or upside-down text pages upright. On a small copy it reads which way is up from two things that must agree: Latin text's ascenders and capitals outnumbering its descenders, and full stops and commas sitting on the baseline with a space after them. Strokes alone would turn upright Cyrillic upside down, since its descenders outnumber its ascenders. Some scripts' letters look like full stops (Hebrew's yod hangs from the top of the line like one upside down); such marks also come inside words, alone between wide gaps in a typewriter font, and right-to-left text has its full stops spaced the other way, so where those together reach two thirds of the full stops it leaves the page as it is. So it does where the strokes lean further than Latin ever does (vowel points under every letter), and where the turned letters would be heavier at the bottom than at the top, as Hebrew's are upside down (their bars run along the top). It leaves a page as it is when unsure (no text, capitals only, other scripts, text without full stops): turning an upright page is worse than missing a turned one. Its tests draw real text with CanvasKit's default typeface, and a made-up script of blocks for Hebrew's yod. `App.tsx` runs it on new pages before clean-up, whether clean-up is on or not, and each page in a scan has a Rotate button. A turned page is shown from its URI plus `?turned=<n>`: an Image on screen reloads only when its URI changes, Android's Fresco also caches by the whole URI, and both platforms read a `file://` image by its path, ignoring the query. Picks keep the plain URI, so they survive a turn.
- No accounts, network, cloud or analytics. Don't add any.

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally.
- Prefer recommended Expo modules over third-party libraries. Docs: https://docs.expo.dev/versions/latest/index.md
