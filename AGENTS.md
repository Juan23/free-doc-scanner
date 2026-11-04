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

- Screens in `App.tsx` (Scans history, a scan's detail, and Android's camera screen), switched with state. There is no router.
- Scans are kept in the app's document folder (`scans.ts`): one folder per scan, named by its creation time in ms, holding its pages as `p1.jpg`, `p2.jpg`… There is no index file: the name comes from the folder name and the page order from the numbers.
- Saving is in `save.ts`: PDFs are built from the page JPEGs with `pdf-lib`; JPEGs go to Photos/Gallery. Tests sit next to each file.
- Scanning on iOS is `CameraView.scanDocumentAsync` from `expo-camera` (VisionKit). Android has the app's own camera screen instead, because Google's ML Kit scanner always opens in auto capture: it ignores its capture-mode extra, and also its initial-images extra, so it can't be fed our photos either (both checked on Play services 26.41, 2026-11-04). `crop.ts` finds the page's corners in each photo (the largest bright region on a small copy, its corners along the diagonals; the whole photo when none stands out) and straightens the page inside the corners with a Skia perspective matrix. Its tests run on real pixels like `clean.ts`'s.
- Clean-up is in `clean.ts`: Skia whitens each new page right after it is stored, replacing the page file. It also whitens what shows past bent or curled page edges: what touches the border, differs from the paper in the middle of the page and stays shallow. It is on unless a `clean-up-off` file sits in the document folder. Its tests run on real pixels through Skia's CanvasKit Jest environment.
- No accounts, network, cloud or analytics. Don't add any.

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally.
- Prefer recommended Expo modules over third-party libraries. Docs: https://docs.expo.dev/versions/latest/index.md
