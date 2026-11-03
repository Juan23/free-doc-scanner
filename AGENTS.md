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

The iOS Simulator has no camera, so scanning on iOS needs a real iPhone. An Android emulator image with Google Play can scan using its virtual camera.

## This app

- Two screens in `App.tsx` (Scans history and a scan's detail), switched with state. There is no router.
- Scans are kept in the app's document folder (`scans.ts`): one folder per scan, named by its creation time in ms, holding its pages as `p1.jpg`, `p2.jpg`… There is no index file: the name comes from the folder name and the page order from the numbers.
- Saving is in `save.ts`: PDFs are built from the page JPEGs with `pdf-lib`; JPEGs go to Photos/Gallery. Tests sit next to each file.
- Scanning is `CameraView.scanDocumentAsync` from `expo-camera`.
- No accounts, network, cloud or analytics. Don't add any.

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally.
- Prefer recommended Expo modules over third-party libraries. Docs: https://docs.expo.dev/versions/latest/index.md
