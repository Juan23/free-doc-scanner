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
export JAVA_HOME="$(/usr/libexec/java_home -v 17)"
export ANDROID_HOME="$HOME/Library/Android/sdk"
npx expo run:android --device
```

The iOS Simulator has no camera, so scanning on iOS needs a real iPhone. An Android emulator can run the camera screen, but its camera saves black photos.

## This app

- Screens in `App.tsx` (Scans history, a 2-column grid of cards with a floating Scan pill; a scan's detail, and Android's camera screen), switched with state. There is no router. A scan's detail is a 2-column grid of page tiles (the page on a grey tile with a number chip, and an Add pages tile), a hint and a bottom bar with Save PDF and Save JPEG; its top bar has Scans, Select and a `⋯` button whose menu holds Delete scan (the confirmation Alert stays in `Root`). It has a Select mode: `Root` holds the picked page URIs (`picked`, null outside it), and `pagesToSave` in `save.ts` keeps them in page order, or every page when none are picked. Select mode hides the hint, the `⋯` menu and Add pages; its top bar has Cancel (leaves it, changes no file), "N selected" and All, and the bottom bar has one Save or filter pill, disabled until a page is picked, that opens a bottom sheet (`Detail`'s `sheet` state, shown only while `picked` is set) with Save as PDF, Save as JPEG, Filter these pages and Cancel (back to the picks). A save from the sheet runs `onSave` once the sheet has closed on iOS (Modal `onDismiss`), since the PDF folder picker can't present over a closing Modal. Filter these pages swaps the sheet for a dark panel with the page editor's strip (`FilterStrip`, shared) on the first picked page's previews, its filter read with `sharedFilter` in `clean.ts` (none checked when the picked pages differ), and a Done pill; a change goes through `filterPages` to the picked pages only and shows the "N pages changed" toast inside the panel. Tapping a page opens the page editor, a dark full-screen Modal over the detail: swipe between pages, Back and Done close it, Rotate turns the page shown, and holding the page shows its untouched photo (`heldPhoto` in `scans.ts`, the page itself when it has none).
- Scans are kept in the app's document folder (`scans.ts`): one folder per scan, named by its creation time in ms, holding its pages as `p1.jpg`, `p2.jpg`… and each page's untouched photo as `o1.jpg`, `o2.jpg`… (the page after upright turning, before any filter; older scans get one on their first filter change). There is no index file: the name comes from the folder name and the page order from the numbers. A page or original is replaced by writing `<name>.tmp` and moving it over the file, which deletes the old one first; listing a scan puts back a `.tmp` page or original whose file is gone, and deletes every other leftover write. An original's first copy is written as `<name>.part` instead, which listing always deletes and never puts back: it has no old file to move over, so a copy cut short must not pass for the photo.
- Saving is in `save.ts`: PDFs are built from the page JPEGs with `pdf-lib`; JPEGs go to Photos/Gallery. Tests sit next to each file.
- Scanning on iOS is `CameraView.scanDocumentAsync` from `expo-camera` (VisionKit). Android has the app's own camera screen instead, because Google's ML Kit scanner always opens in auto capture: it ignores its capture-mode extra, and also its initial-images extra, so it can't be fed our photos either (both checked on Play services 26.41, 2026-11-04). `crop.ts` finds the page's corners in each photo (the largest bright region on a small copy, its corners along the diagonals; the whole photo when none stands out) and straightens the page inside the corners with a Skia perspective matrix. Its tests run on real pixels like `clean.ts`'s.
- Clean-up is in `clean.ts`: Skia whitens each new page right after it is stored, from its untouched original, replacing the page file. It also whitens what shows past bent or curled page edges: what touches the border, differs from the paper in the middle of the page, stays shallow and bends smoothly like a paper edge. Print the crop cuts into has walls (letters, bands, pictures) or runs straight along a side, so it stays. A `Filter` picks Original, Clean or Grayscale and Light, Normal or Strong; Normal keeps the original numbers. The choice for new scans is JSON in a `filter` file in the document folder; missing it means Clean, Normal, and an old `clean-up-off` file is read once as Original and deleted. `filterImage` does the filtering in memory, at any width, and writes no file: a stored Clean or Grayscale page is it at full size, and a stored Original is a byte copy of the photo it shrinks for a preview, so a small preview of a filter matches the page it would store. It must be given the full untouched photo, not a thumbnail: the paper and ink are measured on a small copy of what it is given. Its tests run on real pixels through Skia's CanvasKit Jest environment.
- Each page keeps the filter it was last given as JSON in `f<N>.json` beside `p<N>.jpg` (`pageFilter` in `clean.ts`; missing or unreadable means none, as for older pages). `cleanPages` writes it after each page changes, so new scans and the strip both record it; `listScans` ignores it. The page editor has a strip of Original, Clean and Grayscale radios under the pager. Their thumbnails are `filterPreviews`: Normal strength, made from the page's full untouched photo (`heldPhoto`), recomputed a moment after the page or its turn count changes (a filter change keeps them), and disposed when replaced or when the editor closes. Tapping another thumbnail filters that page at Normal at once; tapping the selected Clean or Grayscale shows or hides Light, Normal and Strong. The last filter picked in the strip, or used through "Use on all", becomes the default for new scans. A scan with any page that has no untouched photo gets the "keep their clean-up" line under the strip. The page editor's "Use on all N pages" button (hidden for a one-page scan or a page with no recorded filter) applies that page's filter to every page, and toasts "N pages changed" inside the editor.
- Turning pages is in `upright.ts`: `rotatePage` turns a stored page and its untouched original by quarter turns; `uprightPages` turns sideways or upside-down text pages upright. On a small copy it reads which way is up from two things that must agree: Latin text's ascenders and capitals outnumbering its descenders, and full stops and commas sitting on the baseline with a space after them. Strokes alone would turn upright Cyrillic upside down, since its descenders outnumber its ascenders. Some scripts' letters look like full stops (Hebrew's yod hangs from the top of the line like one upside down); such marks also come inside words, alone between wide gaps in a typewriter font, and right-to-left text has its full stops spaced the other way, so where those together reach two thirds of the full stops it leaves the page as it is. So it does where the strokes lean further than Latin ever does (vowel points under every letter), and where the turned letters would be heavier at the bottom than at the top, as Hebrew's are upside down (their bars run along the top). It leaves a page as it is when unsure (no text, capitals only, other scripts, text without full stops): turning an upright page is worse than missing a turned one. Its tests draw real text with CanvasKit's default typeface, and a made-up script of blocks for Hebrew's yod. `App.tsx` runs it on new pages before the chosen filter, whether that keeps the photo or not, and the page editor has a Rotate button. A page edited on screen (turned or filtered) is shown from its URI plus `?v=<n>`, the edit counter: an Image on screen reloads only when its URI changes, Android's Fresco also caches by the whole URI, and both platforms read a `file://` image by its path, ignoring the query.- No accounts, network, cloud or analytics. Don't add any.

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally.
- Prefer recommended Expo modules over third-party libraries. Docs: https://docs.expo.dev/versions/latest/index.md
