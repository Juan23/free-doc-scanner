import { Canvas, Circle, Image as SkiaImage, Path, type SkImage } from '@shopify/react-native-skia';
import { Camera, CameraView } from 'expo-camera';
import { Directory, File, Paths } from 'expo-file-system';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  BackHandler,
  FlatList,
  I18nManager,
  Image,
  Linking,
  Modal,
  type GestureResponderEvent,
  Platform,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  useWindowDimensions,
  type ViewStyle,
  View,
} from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { cleanPages, defaultFilter, filterPreviews, setDefaultFilter, sharedFilter, type Filter } from './clean';
import { cropPage, findPage, isConvex, type FoundPage, type Point, type Quad } from './crop';
import { clearScannerCache, pagesToSave, saveJpegs, savePdf } from './save';
import { addPages, anyOriginalMissing, createScan, deleteScan, heldPhoto, listScans, type Scan } from './scans';
import { rotatePage, uprightPages } from './upright';

const C = {
  text: '#15171C',
  muted: '#5F6673',
  hairline: '#E7E9ED',
  accent: '#2457E6',
  accentSoft: '#EAF0FE',
  tile: '#F2F3F5',
  dashed: '#B9C0CB',
  chevron: '#9AA1AD',
  danger: '#D92D20',
};

const bottomPad = (inset: number) => Math.max(inset + 12, 16);

const PILL_H = 60;

const pagesLabel = (n: number) => `${n} ${n === 1 ? 'page' : 'pages'}`;

const unavailableText = 'This iPhone can’t run the built-in document scanner.';

// Android has its own camera screen in this app: Google's scanner can't open in manual capture.
const scannerAvailable = () => Platform.OS === 'android' || CameraView.isDocumentScannerAvailable;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function App() {
  return (
    <SafeAreaProvider>
      <Root />
    </SafeAreaProvider>
  );
}

function Root() {
  const [scans, setScans] = useState<Scan[]>(() => listScans());
  const [open, setOpen] = useState<Scan | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [onCapturedPages, setOnCapturedPages] = useState<((pages: string[]) => Promise<void>) | null>(null);
  // Pages picked in Select mode, or null outside it.
  const [picked, setPicked] = useState<string[] | null>(null);
  // Edits per page (hand turns and filter changes), added to its URI as a query: Image keeps showing a page it already
  // loaded from the same URI, and both platforms read a file:// image by its path, ignoring the query.
  const [edits, setEdits] = useState<Record<string, number>>({});
  // Turns per page; thumbnails come from the untouched photo, so only a turn changes them.
  const [turns, setTurns] = useState<Record<string, number>>({});
  // State updates are async, so a second tap in the same frame would still see busy=false.
  const inFlight = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Scans left behind when the app was killed mid-scan.
  useEffect(() => {
    clearScannerCache();
    return () => clearTimeout(toastTimer.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // Still consumes the event while busy, so Android back never falls through to closing the app.
      if (inFlight.current) return true;
      if (picked) setPicked(null);
      else setOpen(null);
      return true;
    });
    return () => sub.remove();
  }, [open, picked]);

  const showToast = useCallback((text: string) => {
    setMessage(text);
    // Android reads the live region itself; iOS needs an explicit announcement.
    if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setMessage(''), 2500);
  }, []);

  // Runs one scan/save/delete action at a time.
  async function guarded(task: () => Promise<void>, errorTitle: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await task();
    } catch (e) {
      Alert.alert(errorTitle, errorText(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  // Re-reads the list and the open scan, so pages moved before a failure show up. Its pages changed, so Select mode ends.
  function refresh() {
    const all = listScans();
    setScans(all);
    setPicked(null);
    if (open) setOpen(all.find((s) => s.id === open.id) ?? null);
  }

  function scanPages(onPages: (pages: string[]) => Promise<void>) {
    if (Platform.OS === 'android') {
      return guarded(async () => {
        const { granted, canAskAgain } = await Camera.requestCameraPermissionsAsync();
        if (granted) setOnCapturedPages(() => onPages);
        else if (!canAskAgain) askForSettings('Camera access needed', 'Allow camera access in Settings to scan.');
      }, 'Scan failed');
    }
    return guarded(async () => {
      let result;
      try {
        result = await CameraView.scanDocumentAsync({ quality: 0.8 });
      } catch (e) {
        // VisionKit fails instead of asking again once camera access was denied.
        if (!(await Camera.getCameraPermissionsAsync()).granted) {
          askForSettings('Camera access needed', 'Allow camera access in Settings to scan.');
          return;
        }
        throw e;
      }
      if (result) {
        try {
          await onPages(result.pages);
        } finally {
          refresh();
        }
      }
    }, 'Scan failed');
  }

  function endCapture(pages: string[]) {
    const onPages = onCapturedPages;
    setOnCapturedPages(null);
    if (onPages && pages.length) {
      guarded(async () => {
        try {
          await onPages(pages);
        } finally {
          refresh();
        }
      }, 'Scan failed');
    }
  }

  // Runs once the pages are stored, so a crash mid-way can't lose them. New pages are the scan's last.
  async function finishNewest(scan: Scan, count: number) {
    const pages = scan.pages.slice(-count);
    await uprightPages(pages);
    await cleanPages(pages, defaultFilter());
  }

  const scanNew = () =>
    scanPages(async (pages) => {
      setMessage('');
      const scan = await createScan(pages);
      await finishNewest(scan, pages.length);
      // Opened only after turning and cleaning: Image would keep showing a page it already loaded from the same URI.
      setOpen(scan);
    });

  const addToOpen = () =>
    open &&
    scanPages(async (pages) => {
      await finishNewest(await addPages(open, pages), pages.length);
    });

  const touchPages = (pages: string[]) =>
    setEdits((edits) => {
      const next = { ...edits };
      for (const page of pages) next[page] = (next[page] ?? 0) + 1;
      return next;
    });

  const rotate = (page: string) =>
    guarded(async () => {
      await rotatePage(page, 1);
      setTurns((t) => ({ ...t, [page]: (t[page] ?? 0) + 1 }));
      touchPages([page]);
    }, 'Could not rotate');

  // Pages that did change reload even when another failed. The filter is remembered for new scans only when every page changed.
  const filterPages = (pages: string[], filter: Filter, showCount = false) =>
    guarded(async () => {
      const failed = await cleanPages(pages, filter);
      touchPages(pages);
      const changed = pages.length - failed;
      if (showCount && changed > 0) showToast(`${changed} ${changed === 1 ? 'page' : 'pages'} changed`);
      if (failed) throw new Error(failed === 1 ? 'One page could not be changed.' : `${failed} pages could not be changed.`);
      setDefaultFilter(filter);
    }, 'Could not change filter');

  const shown = (page: string) => (edits[page] ? `${page}?v=${edits[page]}` : page);

  function save(kind: 'pdf' | 'jpeg') {
    if (!open) return;
    const scan = open;
    const pages = pagesToSave(scan.pages, picked ?? []);
    setMessage('');
    guarded(async () => {
      if (kind === 'pdf') {
        if ((await savePdf(pages, scan.name)) === 'saved') showToast('PDF saved');
      } else if ((await saveJpegs(pages, scan.name)) === 'saved') {
        showToast('JPEGs saved to Photos');
      } else {
        askForSettings('Photo access needed', 'Allow photo access in Settings to save JPEGs.');
      }
    }, 'Could not save');
  }

  function confirmDelete() {
    if (!open) return;
    const scan = open;
    Alert.alert('Delete this scan?', 'It’s removed from this app. Files you already saved stay.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () =>
          guarded(async () => {
            try {
              deleteScan(scan);
            } finally {
              setScans(listScans());
              setOpen(null);
            }
          }, 'Could not delete'),
      },
    ]);
  }

  return (
    <View style={styles.screen}>
      {onCapturedPages ? (
        <Capture onEnd={endCapture} />
      ) : open ? (
        <Detail
          scan={open}
          busy={busy}
          message={message}
          picked={picked}
          onPick={setPicked}
          shown={shown}
          turns={turns}
          onBack={() => setOpen(null)}
          onDelete={confirmDelete}
          onAdd={addToOpen}
          onRotate={rotate}
          onFilterPage={(page, filter) => filterPages([page], filter)}
          onFilterPages={(pages, filter) => filterPages(pages, filter, true)}
          onSave={save}
        />
      ) : (
        <Home
          scans={scans}
          busy={busy}
          shown={shown}
          onScan={scanNew}
          onOpen={(s) => { setMessage(''); setPicked(null); setOpen(s); }}
        />
      )}
      <StatusBar style={onCapturedPages ? 'light' : 'dark'} />
    </View>
  );
}

function Home(props: {
  scans: Scan[];
  busy: boolean;
  shown: (page: string) => string;
  onScan: () => void;
  onOpen: (s: Scan) => void;
}) {
  const available = scannerAvailable();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const card = (width - 40 - 14) / 2;
  const pillRoom = PILL_H + bottomPad(insets.bottom);
  const header = (
    <View style={styles.homeHeader}>
      <Text style={styles.homeTitle} accessibilityRole="header">Scans</Text>
      {props.scans.length > 0 && (
        <View style={styles.privacy}>
          <LockIcon />
          <Text style={styles.privacyText}>On this phone only</Text>
        </View>
      )}
    </View>
  );
  let body;
  if (props.scans.length === 0 && !available) {
    body = <Message icon={<InfoIcon />} title="Scanner not available" text={unavailableText} />;
  } else if (props.scans.length === 0) {
    body = (
      <Message
        large
        bottom={pillRoom + 16}
        icon={<FirstRunArt />}
        title="No scans yet"
        text="Photograph a page and it turns into a clean scan you can save as a PDF or JPEG."
      />
    );
  } else {
    body = (
      <FlatList
        style={styles.flex}
        contentContainerStyle={[styles.gridList, { paddingBottom: available ? pillRoom + 24 : 12 }]}
        data={props.scans}
        numColumns={2}
        columnWrapperStyle={styles.homeRow}
        keyExtractor={(s) => s.id}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.name}, ${pagesLabel(item.pages.length)}`}
            accessibilityState={{ disabled: props.busy }}
            disabled={props.busy}
            onPress={() => props.onOpen(item)}
            style={[styles.card, { width: card }, props.busy && styles.disabled]}>
            <View style={styles.tile}>
              <View style={styles.tilePages}>
                {item.pages.length > 1 && <View style={[styles.tilePage, styles.tileBehind]} />}
                <Image source={{ uri: props.shown(item.pages[0]) }} style={styles.tilePage} resizeMode="cover" />
              </View>
            </View>
            <View>
              <Text style={styles.cardName}>{item.name}</Text>
              <Text style={styles.cardSub}>{pagesLabel(item.pages.length)}</Text>
            </View>
          </Pressable>
        )}
      />
    );
  }
  const grid = available && props.scans.length > 0;
  return (
    <View style={[styles.flex, { paddingTop: insets.top + 16 }, !available && { paddingBottom: bottomPad(insets.bottom) }]}>
      {header}
      {body}
      {grid && <View pointerEvents="none" style={[styles.fade, { height: pillRoom + 44 }]} />}
      {available && (
        <View pointerEvents="box-none" style={[styles.pillWrap, { bottom: bottomPad(insets.bottom) }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Scan"
            accessibilityState={{ disabled: props.busy }}
            disabled={props.busy}
            onPress={props.onScan}
            style={[styles.pill, props.busy && styles.disabled]}>
            <ScanIcon />
            <Text style={styles.scanButtonText} maxFontSizeMultiplier={1.5}>Scan</Text>
          </Pressable>
        </View>
      )}
      {!available && props.scans.length > 0 && (
        <View style={styles.scanBar}>
          <Text style={styles.barTitle}>Scanner not available</Text>
          <Text style={styles.messageText}>{unavailableText}</Text>
        </View>
      )}
    </View>
  );
}

const THUMB_W = 66;
const THUMB_H = 88;

const FILTER_KINDS: { kind: Filter['kind']; label: string }[] = [
  { kind: 'original', label: 'Original' },
  { kind: 'clean', label: 'Clean' },
  { kind: 'gray', label: 'Grayscale' },
];

const FILTER_STRENGTHS: { strength: Filter['strength']; label: string }[] = [
  { strength: 0, label: 'Light' },
  { strength: 1, label: 'Normal' },
  { strength: 2, label: 'Strong' },
];

type Cell = { key: string; uri?: string; n?: number };

function Detail(props: {
  scan: Scan;
  busy: boolean;
  message: string;
  picked: string[] | null;
  onPick: (pages: string[] | null) => void;
  shown: (page: string) => string;
  turns: Record<string, number>;
  onBack: () => void;
  onDelete: () => void;
  onAdd: () => void;
  onRotate: (page: string) => void;
  onFilterPage: (page: string, filter: Filter) => void;
  onFilterPages: (pages: string[], filter: Filter) => void;
  onSave: (kind: 'pdf' | 'jpeg') => void;
}) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [editorIndex, setEditorIndex] = useState<number | null>(null);
  const [current, setCurrent] = useState(0);
  const [holding, setHolding] = useState(false);
  const [pagerHeight, setPagerHeight] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [strengthsOpen, setStrengthsOpen] = useState(false);
  // Over the grid while selecting. Closing keeps `panel`, so the fade-out never shows the white rows.
  const [sheetOpen, setSheetOpen] = useState(false);
  const [panel, setPanel] = useState<'actions' | 'filter'>('actions');
  const pendingSave = useRef<'pdf' | 'jpeg' | null>(null);
  // Thumbnails and the page they were made for; another page shows empty boxes until its own arrive.
  const [previews, setPreviews] = useState<{ page: string; images: Record<Filter['kind'], SkImage> | null }>({
    page: '',
    images: null,
  });
  const cell = (width - 40 - 16) / 2;
  const { scan, busy, picked } = props;
  const editing = editorIndex !== null;
  const editedPage = scan.pages[current] as string | undefined;
  const pickedPages = useMemo(() => scan.pages.filter((p) => picked?.includes(p)), [scan.pages, picked]);
  const filtering = sheetOpen && panel === 'filter';
  // The pages the filter strip is about: the edited page, or the picked ones in the filter panel.
  const subject = editing ? (editedPage ? [editedPage] : []) : filtering ? pickedPages : [];
  const previewPage = subject[0] as string | undefined;
  // Changes with every edit of the subject, so what is read below never outlives one.
  const subjectKey = subject.map(props.shown).join('|');
  const recorded = useMemo(
    () => sharedFilter(subject),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-reads on each edit (subjectKey), which the callback does not read
    [subjectKey],
  );
  // Pages scanned before untouched photos were kept have no photo for Original to bring back.
  const olderPage = useMemo(
    () => (editing || filtering) && anyOriginalMissing(filtering ? pickedPages : scan.pages),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-reads on each edit (subjectKey), which the callback does not read
    [editing, filtering, scan.pages, pickedPages, subjectKey],
  );
  const thumbs = previews.page === previewPage ? previews.images : null;
  const turned = previewPage ? props.turns[previewPage] : 0;
  useEffect(() => {
    if (!previewPage) return;
    let stale = false;
    // After the slide has settled, and dropped if the page changes meanwhile.
    const timer = setTimeout(async () => {
      try {
        const images = await filterPreviews(previewPage, THUMB_W * 2, () => stale);
        if (images && stale) Object.values(images).forEach((m) => m.dispose());
        else if (images) setPreviews({ page: previewPage, images });
      } catch {}
    }, 100);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [previewPage, turned]);
  // Runs when the images are replaced, and when the editor or filter panel closes or unmounts.
  useEffect(() => () => Object.values(previews.images ?? {}).forEach((t) => t.dispose()), [previews]);
  const available = scannerAvailable();
  const data: Cell[] = [
    ...scan.pages.map((uri, i) => ({ key: uri, uri, n: i + 1 })),
    ...(available && !picked ? [{ key: 'add' }] : []),
  ];
  const disabled = busy && styles.disabled;
  const releasePreviews = () => {
    setStrengthsOpen(false);
    setPreviews({ page: '', images: null });
  };
  const closeSheet = () => {
    setSheetOpen(false);
    releasePreviews();
  };
  const saveFromSheet = (kind: 'pdf' | 'jpeg') => {
    setSheetOpen(false);
    // The PDF folder picker is a native screen; iOS can't present it over a Modal that is still closing,
    // and only iOS has Modal's onDismiss.
    if (Platform.OS === 'ios') pendingSave.current = kind;
    else props.onSave(kind);
  };
  const closeEditor = () => {
    setEditorIndex(null);
    setHolding(false);
    releasePreviews();
  };
  return (
    <View style={[styles.flex, { paddingTop: insets.top + 8, paddingBottom: bottomPad(insets.bottom) }]}>
      <View style={styles.nav}>
        {picked ? (
          <>
            <View style={styles.navSide}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel selecting"
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={() => props.onPick(null)}
                style={[styles.navButton, disabled]}>
                <Text style={styles.selectText} maxFontSizeMultiplier={1.5}>Cancel</Text>
              </Pressable>
            </View>
            <Text style={styles.navCount} maxFontSizeMultiplier={1.5}>{picked.length} selected</Text>
            <View style={[styles.navSide, styles.navSideEnd]}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Select all pages"
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={() => props.onPick(scan.pages)}
                style={[styles.navButton, disabled]}>
                <Text style={styles.selectText} maxFontSizeMultiplier={1.5}>All</Text>
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Back to Scans"
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={props.onBack}
              style={[styles.back, disabled]}>
              <Chevron color={C.accent} left />
              <Text style={styles.backText} maxFontSizeMultiplier={1.5}>Scans</Text>
            </Pressable>
            <View style={styles.navRight}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Select pages"
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={() => props.onPick([])}
                style={[styles.navButton, disabled]}>
                <Text style={styles.selectText} maxFontSizeMultiplier={1.5}>Select</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="More"
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={() => setMenuOpen(true)}
                style={[styles.navButton, disabled]}>
                <View style={styles.dots}>
                  {[0, 1, 2].map((i) => (
                    <View key={i} style={styles.dot} />
                  ))}
                </View>
              </Pressable>
            </View>
          </>
        )}
      </View>
      <FlatList
        style={styles.flex}
        data={data}
        numColumns={2}
        keyExtractor={(c) => c.key}
        contentContainerStyle={styles.gridContent}
        columnWrapperStyle={styles.gridRow}
        ListHeaderComponent={
          <View style={styles.detailHeader}>
            <Text style={styles.detailTitle} accessibilityRole="header">{scan.name}</Text>
            <Text style={styles.subtitle}>{pagesLabel(scan.pages.length)}</Text>
          </View>
        }
        renderItem={({ item }) => {
          const { uri } = item;
          const size = { width: cell, height: (cell * 4) / 3 };
          if (uri) {
            const on = !!picked?.includes(uri);
            return (
              <Pressable
                accessibilityRole={picked ? 'checkbox' : 'button'}
                accessibilityLabel={picked ? `Page ${item.n}` : `Edit page ${item.n}`}
                accessibilityState={picked ? { checked: on, disabled: busy } : { disabled: busy }}
                disabled={busy}
                onPress={() => {
                  if (picked) return props.onPick(on ? picked.filter((p) => p !== uri) : [...picked, uri]);
                  const i = item.n! - 1;
                  setCurrent(i);
                  setEditorIndex(i);
                }}
                style={[styles.pageTile, size, on && styles.pageTilePicked, disabled]}>
                <Image source={{ uri: props.shown(uri) }} style={styles.pageImage} resizeMode="contain" />
                <View style={styles.numChip}>
                  <Text style={styles.numText} importantForAccessibility="no" accessible={false} maxFontSizeMultiplier={1.5}>
                    {item.n}
                  </Text>
                </View>
                {picked && <View style={[styles.pickMark, on && styles.pickMarkOn]}>{on && <Check />}</View>}
              </Pressable>
            );
          }
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add pages"
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={props.onAdd}
              style={[styles.addTile, size, disabled]}>
              <View style={styles.plus}>
                <View style={[styles.plusBar, styles.plusH]} />
                <View style={[styles.plusBar, styles.plusV]} />
              </View>
              <Text style={styles.addText} maxFontSizeMultiplier={1.5}>Add pages</Text>
            </Pressable>
          );
        }}
      />
      <View style={styles.bottom}>
        <View accessibilityLiveRegion="polite" collapsable={false}>
          {!!props.message && <Toast message={props.message} />}
        </View>
        {!picked && (
          <Text style={styles.hint} maxFontSizeMultiplier={1.5}>Tap a page to filter or rotate it</Text>
        )}
        <View style={styles.saveBar}>
          {picked ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save or filter"
              accessibilityState={{ disabled: busy || !picked.length }}
              disabled={busy || !picked.length}
              onPress={() => {
                setPanel('actions');
                setSheetOpen(true);
              }}
              style={[styles.action, styles.primary, (busy || !picked.length) && styles.disabled]}>
              <Text style={styles.primaryText} maxFontSizeMultiplier={1.5}>Save or filter</Text>
            </Pressable>
          ) : (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Save PDF"
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={() => props.onSave('pdf')}
                style={[styles.action, styles.primary, disabled]}>
                <Text style={styles.primaryText} maxFontSizeMultiplier={1.5}>Save PDF</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Save JPEG"
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={() => props.onSave('jpeg')}
                style={[styles.action, styles.secondary, disabled]}>
                <Text style={styles.secondaryText} maxFontSizeMultiplier={1.5}>Save JPEG</Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
      <Modal
        visible={editorIndex !== null}
        animationType="fade"
        statusBarTranslucent
        onRequestClose={closeEditor}>
        <StatusBar style="light" />
        <View style={[styles.editor, { paddingTop: insets.top + 8, paddingBottom: bottomPad(insets.bottom) }]}>
          <View style={styles.nav}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Back to pages"
              onPress={closeEditor}
              style={styles.back}>
              <Chevron color="#fff" left />
              <Text style={styles.editorAction} maxFontSizeMultiplier={1.5}>Back</Text>
            </Pressable>
            <Text style={styles.editorCount} accessibilityLiveRegion="polite" maxFontSizeMultiplier={1.5}>
              Page {current + 1} of {scan.pages.length}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Rotate page ${current + 1}`}
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={() => props.onRotate(scan.pages[current])}
              style={[styles.navButton, disabled]}>
              <Text style={styles.editorAction} maxFontSizeMultiplier={1.5}>Rotate</Text>
            </Pressable>
          </View>
          <View style={styles.flex}>
            <FlatList
              style={styles.flex}
              onLayout={(e) => setPagerHeight(e.nativeEvent.layout.height)}
              data={scan.pages}
              horizontal
              pagingEnabled
              windowSize={3}
              initialNumToRender={1}
              showsHorizontalScrollIndicator={false}
              keyExtractor={(uri) => uri}
              initialScrollIndex={editorIndex ?? 0}
              getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
              scrollEventThrottle={16}
              // Updated during the slide, not after it: Rotate turns this page and takes taps mid-slide.
              onScroll={(e) => {
                const slid = Math.round(e.nativeEvent.contentOffset.x / width);
                // A horizontal list is mirrored on right-to-left phones, so page 1 sits at the far end.
                const page = I18nManager.isRTL ? scan.pages.length - 1 - slid : slid;
                if (page !== current) {
                  setCurrent(page);
                  setStrengthsOpen(false);
                  setHolding(false);
                  // Android reads the count's live region itself; iOS needs an explicit announcement.
                  if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(`Page ${page + 1} of ${scan.pages.length}`);
                }
              }}
              renderItem={({ item, index }) => (
                <Pressable
                  accessibilityRole="image"
                  accessibilityLabel={`Page ${index + 1} of ${scan.pages.length}`}
                  accessibilityHint="Hold to show the untouched photo"
                  onLongPress={() => setHolding(true)}
                  onPressOut={() => setHolding(false)}
                  style={{ width, height: pagerHeight }}>
                  <Image
                    source={{
                      uri:
                        index === current && holding
                          ? heldPhoto(item) + props.shown(item).slice(item.length)
                          : props.shown(item),
                    }}
                    style={{ width, height: pagerHeight }}
                    resizeMode="contain"
                  />
                </Pressable>
              )}
            />
            {/* Over the pager's top edge, so the pager and strip never move. The grid's toast sits behind this Modal. */}
            <View
              style={styles.editorToastSlot}
              pointerEvents="none"
              accessibilityLiveRegion="polite"
              collapsable={false}>
              {!!props.message && <Toast message={props.message} style={styles.editorToast} />}
            </View>
          </View>
          {editedPage && (
            <FilterStrip
              thumbs={thumbs}
              recorded={recorded}
              busy={busy}
              older={olderPage}
              strengthsOpen={strengthsOpen}
              onStrengths={setStrengthsOpen}
              onFilter={(filter) => props.onFilterPage(editedPage, filter)}
            />
          )}
          <View style={styles.editorDone}>
            {recorded && scan.pages.length > 1 && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Use this page's filter on all ${scan.pages.length} pages`}
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={() => props.onFilterPages(scan.pages, recorded)}
                style={[styles.useOnAll, disabled]}>
                <Text style={styles.useOnAllText} maxFontSizeMultiplier={1.5}>
                  Use on all {scan.pages.length} pages
                </Text>
              </Pressable>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Done"
              onPress={closeEditor}
              style={styles.doneButton}>
              <Text style={styles.doneText} maxFontSizeMultiplier={1.5}>Done</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
      <Modal
        visible={sheetOpen}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={closeSheet}
        onDismiss={() => {
          const kind = pendingSave.current;
          pendingSave.current = null;
          if (kind) props.onSave(kind);
        }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={closeSheet}
          style={[StyleSheet.absoluteFill, styles.backdrop]}
        />
        {panel === 'filter' ? (
          <View style={[styles.sheet, styles.sheetDark, { paddingBottom: bottomPad(insets.bottom) }]}>
            {/* Above the panel's top edge, so the heading and strip never move. */}
            <View
              style={[styles.editorToastSlot, styles.sheetToastSlot]}
              pointerEvents="none"
              accessibilityLiveRegion="polite"
              collapsable={false}>
              {!!props.message && <Toast message={props.message} style={styles.editorToast} />}
            </View>
            <Text style={styles.sheetHeading} accessibilityRole="header" maxFontSizeMultiplier={1.5}>
              Filter {pagesLabel(pickedPages.length)}
            </Text>
            <FilterStrip
              thumbs={thumbs}
              recorded={recorded}
              busy={busy}
              older={olderPage}
              strengthsOpen={strengthsOpen}
              onStrengths={setStrengthsOpen}
              onFilter={(filter) => props.onFilterPages(pickedPages, filter)}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Done"
              onPress={closeSheet}
              style={[styles.doneButton, styles.sheetPill, styles.sheetDone]}>
              <Text style={styles.doneText} maxFontSizeMultiplier={1.5}>Done</Text>
            </Pressable>
          </View>
        ) : (
          <View style={[styles.sheet, { paddingBottom: bottomPad(insets.bottom) }]}>
            <View style={styles.grabber} />
            <Text style={styles.sheetTitle} accessibilityRole="header" maxFontSizeMultiplier={1.5}>
              {pagesLabel(pickedPages.length)}
            </Text>
            <SheetRow
              icon="pdf"
              title="Save as PDF"
              subtitle={`One file with ${pickedPages.length === 2 ? 'both pages' : pagesLabel(pickedPages.length)}`}
              busy={busy}
              onPress={() => saveFromSheet('pdf')}
            />
            <SheetRow
              icon="jpeg"
              title="Save as JPEG"
              subtitle={`${pickedPages.length} ${pickedPages.length === 1 ? 'image' : 'images'} to Photos`}
              busy={busy}
              onPress={() => saveFromSheet('jpeg')}
            />
            <SheetRow
              icon="filter"
              title="Filter these pages"
              subtitle="Original, Clean or Grayscale"
              busy={busy}
              onPress={() => setPanel('filter')}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              onPress={closeSheet}
              style={[styles.sheetPill, styles.sheetCancel]}>
              <Text style={styles.sheetCancelText} maxFontSizeMultiplier={1.5}>Cancel</Text>
            </Pressable>
          </View>
        )}
      </Modal>
      <Modal
        visible={menuOpen}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setMenuOpen(false)}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close menu"
          onPress={() => setMenuOpen(false)}
          style={StyleSheet.absoluteFill}
        />
        <View style={[styles.menu, { top: insets.top + 8 + 44 }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Delete scan"
            onPress={() => {
              setMenuOpen(false);
              props.onDelete();
            }}
            style={styles.menuItem}>
            <Text style={styles.menuText} maxFontSizeMultiplier={1.5}>Delete</Text>
          </Pressable>
        </View>
      </Modal>
    </View>
  );
}

// The filter strip of the page editor and of the Select sheet's filter panel; both sit on a dark background.
function FilterStrip(props: {
  thumbs: Record<Filter['kind'], SkImage> | null;
  recorded: Filter | null;
  busy: boolean;
  older: boolean;
  strengthsOpen: boolean;
  onStrengths: (open: boolean) => void;
  onFilter: (filter: Filter) => void;
}) {
  const { recorded, busy, thumbs } = props;
  const disabled = busy && styles.disabled;
  return (
    <View style={styles.strip}>
      {props.strengthsOpen && recorded && recorded.kind !== 'original' && (
        <View style={styles.strengths} accessibilityRole="radiogroup" accessibilityLabel="Clean-up strength">
          {FILTER_STRENGTHS.map(({ strength, label }) => {
            const checked = recorded.strength === strength;
            return (
              <Pressable
                key={label}
                accessibilityRole="radio"
                accessibilityLabel={label}
                accessibilityState={{ checked, disabled: busy }}
                disabled={busy}
                onPress={() => {
                  if (!checked) props.onFilter({ kind: recorded.kind, strength });
                }}
                style={[styles.strength, checked && styles.strengthOn, disabled]}>
                <Text style={[styles.strengthText, checked && styles.strengthTextOn]} maxFontSizeMultiplier={1.5}>
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
      <View style={styles.thumbs} accessibilityRole="radiogroup" accessibilityLabel="Filter">
        {FILTER_KINDS.map(({ kind, label }) => {
          const checked = recorded?.kind === kind;
          const hasStrengths = checked && kind !== 'original';
          return (
            <Pressable
              key={kind}
              accessibilityRole="radio"
              accessibilityLabel={label}
              accessibilityHint={hasStrengths ? 'Tap again to show or hide the strengths' : undefined}
              accessibilityState={{ checked, disabled: busy }}
              disabled={busy}
              onPress={() => {
                if (hasStrengths) props.onStrengths(!props.strengthsOpen);
                else if (!checked) {
                  props.onStrengths(false);
                  props.onFilter({ kind, strength: 1 });
                }
              }}
              style={[styles.thumb, disabled]}>
              <View style={[styles.thumbBox, checked && styles.thumbBoxOn]}>
                <Canvas style={styles.thumbCanvas}>
                  {thumbs && <SkiaImage image={thumbs[kind]} x={0} y={0} width={THUMB_W} height={THUMB_H} fit="cover" />}
                </Canvas>
              </View>
              <Text
                style={[styles.thumbLabel, checked && styles.thumbLabelOn]}
                maxFontSizeMultiplier={1.5}
                numberOfLines={1}
                adjustsFontSizeToFit>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {props.older && (
        <Text style={styles.stripNote} maxFontSizeMultiplier={1.5}>
          Pages scanned before this version keep their clean-up.
        </Text>
      )}
    </View>
  );
}

function SheetRow(props: { icon: 'pdf' | 'jpeg' | 'filter'; title: string; subtitle: string; busy: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.title}
      accessibilityState={{ disabled: props.busy }}
      disabled={props.busy}
      onPress={props.onPress}
      style={[styles.sheetRow, props.busy && styles.disabled]}>
      <View style={styles.sheetIcon}>
        {props.icon === 'pdf' && (
          <View style={styles.iconDoc}>
            <View style={styles.iconLine} />
            <View style={styles.iconLine} />
          </View>
        )}
        {props.icon === 'jpeg' && (
          <View style={styles.iconPhoto}>
            <View style={styles.iconSun} />
          </View>
        )}
        {props.icon === 'filter' && (
          <View style={styles.iconRings}>
            <View style={styles.iconRing} />
            <View style={[styles.iconRing, styles.iconRingBack]} />
          </View>
        )}
      </View>
      <View style={styles.flex}>
        <Text style={styles.sheetRowTitle} maxFontSizeMultiplier={1.5}>{props.title}</Text>
        <Text style={styles.sheetRowSub} maxFontSizeMultiplier={1.5}>{props.subtitle}</Text>
      </View>
    </Pressable>
  );
}

type Photo = FoundPage & { uri: string };

const deleteQuietly = (uri: string) => {
  try {
    new File(uri).delete();
  } catch {}
};

// Android's scanner. Its photos and pages wait in cache folders that clearScannerCache empties at launch.
function Capture(props: { onEnd: (pages: string[]) => void }) {
  const insets = useSafeAreaInsets();
  const camera = useRef<CameraView>(null);
  const [pages, setPages] = useState<string[]>([]);
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [working, setWorking] = useState(false);
  // State updates are async, so a second tap in the same frame would still see working=false.
  const inFlight = useRef(false);

  async function step(task: () => Promise<void>, errorTitle: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setWorking(true);
    try {
      await task();
    } catch (e) {
      Alert.alert(errorTitle, errorText(e));
    } finally {
      inFlight.current = false;
      setWorking(false);
    }
  }

  const shoot = () =>
    step(async () => {
      const picture = await camera.current?.takePictureAsync({ quality: 0.9, shutterSound: false });
      if (!picture) return;
      try {
        setPhoto({ uri: picture.uri, ...(await findPage(picture.uri)) });
      } catch (e) {
        deleteQuietly(picture.uri);
        throw e;
      }
    }, 'Could not take photo');

  const retake = () => {
    if (inFlight.current || !photo) return;
    deleteQuietly(photo.uri);
    setPhoto(null);
  };

  const keep = (finish: boolean) =>
    step(async () => {
      if (!photo) return;
      const dir = new Directory(Paths.cache, 'DocumentScanner');
      dir.create({ idempotent: true });
      const page = new File(dir, `${Date.now()}.jpg`).uri;
      await cropPage(photo.uri, photo.corners, page);
      deleteQuietly(photo.uri);
      setPhoto(null);
      setPages([...pages, page]);
      if (finish) props.onEnd([...pages, page]);
    }, 'Could not keep page');

  function cancel() {
    if (inFlight.current) return;
    const discard = () => {
      if (photo) deleteQuietly(photo.uri);
      pages.forEach(deleteQuietly);
      props.onEnd([]);
    };
    if (!pages.length) return discard();
    Alert.alert(`Discard ${pagesLabel(pages.length)}?`, 'They haven’t been added yet.', [
      { text: 'Keep scanning', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: discard },
    ]);
  }

  // Back undoes one step: the photo first, then the whole scan. Re-added each render to see the latest state.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      (photo ? retake : cancel)();
      return true;
    });
    return () => sub.remove();
  });

  const pad = { paddingTop: insets.top, paddingBottom: bottomPad(insets.bottom) };
  if (photo) {
    return (
      <View style={[styles.corners, pad]}>
        <View style={styles.cornersBar}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: working }}
            disabled={working}
            onPress={retake}
            style={[styles.cornersSide, working && styles.disabled]}>
            <Text style={styles.retakeText} maxFontSizeMultiplier={1.5}>Retake</Text>
          </Pressable>
          <Text style={styles.cornersTitle} maxFontSizeMultiplier={1.5}>{`Page ${pages.length + 1}`}</Text>
          <View style={styles.cornersSide} />
        </View>
        <PageEditor photo={photo} onChange={(corners) => setPhoto({ ...photo, corners })} />
        <Text style={styles.cornersHint} maxFontSizeMultiplier={1.5}>Drag a corner to the page’s edge</Text>
        <View style={styles.cornersRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: working }}
            disabled={working}
            onPress={() => keep(false)}
            style={[styles.cornersPill, styles.nextPill, working && styles.disabled]}>
            <View style={styles.plus}>
              <View style={[styles.plusBar, styles.plusH, styles.plusWhite]} />
              <View style={[styles.plusBar, styles.plusV, styles.plusWhite]} />
            </View>
            <Text style={styles.pillText} maxFontSizeMultiplier={1.5}>Next page</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: working }}
            disabled={working}
            onPress={() => keep(true)}
            style={[styles.cornersPill, styles.donePill, working && styles.disabled]}>
            <Text style={styles.pillText} maxFontSizeMultiplier={1.5}>Done</Text>
          </Pressable>
        </View>
      </View>
    );
  }
  const last = pages[pages.length - 1];
  return (
    <View style={styles.capture}>
      <View style={styles.flex}>
        <CameraView ref={camera} style={styles.flex} facing="back" animateShutter />
        <View
          style={[StyleSheet.absoluteFill, styles.captureOverlay]}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants">
          <View style={styles.guide} />
        </View>
        <View style={[styles.captureTop, { top: insets.top + 8 }]} pointerEvents="none">
          <Text style={styles.captureChip} maxFontSizeMultiplier={1.5}>{`Page ${pages.length + 1}`}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close camera"
          accessibilityState={{ disabled: working }}
          disabled={working}
          onPress={cancel}
          style={[styles.closeButton, { top: insets.top + 8 }, working && styles.disabled]}>
          <View style={[styles.closeBar, { transform: [{ rotate: '45deg' }] }]} />
          <View style={[styles.closeBar, { transform: [{ rotate: '-45deg' }] }]} />
        </Pressable>
        <View style={styles.captureHold} pointerEvents="none">
          <Text style={styles.captureChip} maxFontSizeMultiplier={1.5}>Hold still</Text>
        </View>
      </View>
      <View style={[styles.captureBar, { paddingBottom: bottomPad(insets.bottom) }]}>
        <View style={styles.captureSlot}>
          {last ? (
            <View accessible accessibilityLabel={`${pagesLabel(pages.length)} taken`} style={styles.camThumbBox}>
              <Image source={{ uri: last }} style={styles.camThumb} resizeMode="cover" />
              <View style={styles.thumbBadge}>
                <Text style={styles.thumbBadgeText} maxFontSizeMultiplier={1.5}>{pages.length}</Text>
              </View>
            </View>
          ) : (
            <View style={styles.camThumbBox} />
          )}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Take photo"
          accessibilityState={{ disabled: working }}
          disabled={working}
          onPress={shoot}
          style={styles.shutter}>
          {working ? <ActivityIndicator color={C.text} /> : <View style={styles.shutterInner} />}
        </Pressable>
        <View style={[styles.captureSlot, styles.captureSlotEnd]}>
          {!!last && (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: working }}
              disabled={working}
              onPress={() => props.onEnd(pages)}
              style={[styles.donePillCam, working && styles.disabled]}>
              <Text style={styles.pillText} maxFontSizeMultiplier={1.5}>Done</Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

// A drag that starts on a corner handle moves that corner.
function PageEditor(props: { photo: Photo; onChange: (corners: Quad) => void }) {
  // Touches use page coordinates: locationX/Y is relative to whichever child view the finger lands on.
  const view = useRef<React.ComponentRef<typeof View>>(null);
  const [box, setBox] = useState({ width: 0, height: 0, pageX: 0, pageY: 0 });
  const { photo } = props;
  // Keeps edge handles whole on screen and, with the editor's 20 margin, 48 from the sides, out of Android's swipe-back zone, which would take the drag.
  const sideMargin = 28;
  const endMargin = 20;
  const scale = Math.max(
    0,
    Math.min((box.width - 2 * sideMargin) / photo.width, (box.height - 2 * endMargin) / photo.height),
  );
  const left = (box.width - photo.width * scale) / 2;
  const top = (box.height - photo.height * scale) / 2;
  const onScreen = photo.corners.map((p) => ({ x: left + p.x * scale, y: top + p.y * scale }));

  const drag = useRef<{ corner: number; startOnScreen: Point; startInPhoto: Point } | null>(null);
  const onGrant = (e: GestureResponderEvent) => {
    const { pageX, pageY } = e.nativeEvent;
    const distances = onScreen.map((p) => Math.hypot(p.x - (pageX - box.pageX), p.y - (pageY - box.pageY)));
    const corner = distances.indexOf(Math.min(...distances));
    drag.current = distances[corner] < 60 ? { corner, startOnScreen: { x: pageX, y: pageY }, startInPhoto: photo.corners[corner] } : null;
  };
  const onMove = (e: GestureResponderEvent) => {
    const d = drag.current;
    if (!d) return;
    const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
    const corners = [...photo.corners] as Quad;
    corners[d.corner] = {
      x: clamp(d.startInPhoto.x + (e.nativeEvent.pageX - d.startOnScreen.x) / scale, photo.width),
      y: clamp(d.startInPhoto.y + (e.nativeEvent.pageY - d.startOnScreen.y) / scale, photo.height),
    };
    // A corner dragged past another would cut out a mirrored or twisted page.
    if (isConvex(corners)) props.onChange(corners);
  };

  const outline = `M ${onScreen.map((p) => `${p.x} ${p.y}`).join(' L ')} Z`;
  return (
    <View
      style={styles.editorArea}
      ref={view}
      onLayout={() => view.current?.measure((_x, _y, width, height, pageX, pageY) => setBox({ width, height, pageX, pageY }))}
      accessible
      accessibilityLabel="Photo with the page outlined"
      onStartShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={onGrant}
      onResponderMove={onMove}
      onResponderRelease={() => (drag.current = null)}>
      {scale > 0 && (
        <>
          <Image
            source={{ uri: photo.uri }}
            style={{ position: 'absolute', left, top, width: photo.width * scale, height: photo.height * scale }}
          />
          <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
            <Path path={outline} color="rgba(76,125,255,0.14)" />
            <Path path={outline} style="stroke" strokeWidth={2.5} color="#6E97FF" />
            {onScreen.map((p, i) => (
              <Circle key={i} cx={p.x} cy={p.y} r={12} color="#fff">
                <Circle cx={p.x} cy={p.y} r={12} style="stroke" strokeWidth={3} color={C.accent} />
              </Circle>
            ))}
          </Canvas>
        </>
      )}
    </View>
  );
}

function Message(props: { icon: React.ReactNode; title: string; text: string; large?: boolean; bottom?: number }) {
  return (
    <View style={[styles.message, props.bottom ? { paddingBottom: props.bottom } : null]}>
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        {props.icon}
      </View>
      <Text style={[styles.messageTitle, props.large && styles.messageTitleLarge]}>{props.title}</Text>
      <Text style={[styles.messageText, props.large && styles.messageTextLarge]}>{props.text}</Text>
    </View>
  );
}

function askForSettings(title: string, message: string) {
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Open Settings', onPress: () => Linking.openSettings().catch(() => {}) },
  ]);
}

// Four L-shaped corners plus a middle bar, drawn from bordered Views.
function Corners(props: { size: number; arm: number; color: string; w: number; bar?: boolean }) {
  const { size, arm, color, w } = props;
  const base = { position: 'absolute', width: arm, height: arm, borderColor: color } as const;
  const r = arm / 3;
  return (
    <View style={{ width: size, height: size }}>
      <View style={[base, { top: 0, left: 0, borderTopWidth: w, borderLeftWidth: w, borderTopLeftRadius: r }]} />
      <View style={[base, { top: 0, right: 0, borderTopWidth: w, borderRightWidth: w, borderTopRightRadius: r }]} />
      <View style={[base, { bottom: 0, right: 0, borderBottomWidth: w, borderRightWidth: w, borderBottomRightRadius: r }]} />
      <View style={[base, { bottom: 0, left: 0, borderBottomWidth: w, borderLeftWidth: w, borderBottomLeftRadius: r }]} />
      {props.bar && (
        <View
          style={{
            position: 'absolute',
            left: size * 0.29,
            right: size * 0.29,
            top: (size - w) / 2,
            height: w,
            borderRadius: w,
            backgroundColor: color,
          }}
        />
      )}
    </View>
  );
}

const ScanIcon = () => <Corners size={22} arm={9} color="#fff" w={2} bar />;

function FirstRunArt() {
  return (
    <View style={styles.art}>
      {[-8, 6].map((deg, i) => (
        <View key={deg} style={[styles.artPage, { transform: [{ rotate: `${deg}deg` }], marginLeft: i ? 16 : -16 }]}>
          {[44, 58, 58, 36].map((w, j) => (
            <View key={j} style={[styles.artLine, { width: w }]} />
          ))}
        </View>
      ))}
    </View>
  );
}

function LockIcon() {
  return (
    <View style={styles.lock}>
      <View style={styles.lockShackle} />
      <View style={styles.lockBody} />
    </View>
  );
}

function InfoIcon() {
  return (
    <View style={styles.info}>
      <View style={styles.infoDot} />
      <View style={styles.infoBar} />
    </View>
  );
}

function Chevron(props: { color: string; left?: boolean }) {
  return (
    <View
      style={{
        width: 10,
        height: 10,
        borderColor: props.color,
        borderTopWidth: 2,
        borderRightWidth: 2,
        borderRadius: 1,
        // Right-to-left phones swap the right border to the left, so the turn runs the other way.
        transform: [{ rotate: `${(props.left ? -135 : 45) * (I18nManager.isRTL ? -1 : 1)}deg` }],
        marginLeft: props.left ? 4 : 0,
      }}
    />
  );
}

function Check() {
  return (
    <View
      style={{
        width: 7,
        height: 12,
        borderColor: '#fff',
        borderRightWidth: 2.4,
        borderBottomWidth: 2.4,
        transform: [{ rotate: '45deg' }, { translateY: -2 }],
        marginHorizontal: 4,
      }}
    />
  );
}

function Toast({ message, style }: { message: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.toast, style]}>
      <Check />
      <Text style={styles.toastText}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: '#fff' },
  disabled: { opacity: 0.4 },
  homeHeader: { paddingHorizontal: 20, paddingBottom: 12 },
  homeTitle: { fontSize: 34, lineHeight: 41, fontWeight: '700', letterSpacing: -0.5, color: C.text },
  subtitle: { marginTop: 4, fontSize: 14, lineHeight: 20, color: C.muted },
  privacy: { marginTop: 2, flexDirection: 'row', alignItems: 'center', gap: 6 },
  privacyText: { fontSize: 13, lineHeight: 18, color: C.muted },
  lock: { width: 10, height: 13, alignItems: 'center' },
  lockShackle: {
    width: 7,
    height: 7,
    borderWidth: 1.5,
    borderBottomWidth: 0,
    borderColor: C.muted,
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
  },
  lockBody: { width: 10, height: 7, marginTop: -1, borderRadius: 2, backgroundColor: C.muted },
  gridList: { paddingHorizontal: 20, paddingTop: 8 },
  homeRow: { gap: 14, marginBottom: 20 },
  card: { gap: 8 },
  tile: { height: 196, borderRadius: 16, backgroundColor: C.tile, alignItems: 'center', justifyContent: 'center' },
  tilePages: { width: 112, height: 150 },
  tilePage: {
    width: 112,
    height: 150,
    borderRadius: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.hairline,
    backgroundColor: '#fff',
  },
  tileBehind: { position: 'absolute', top: 5, left: 5 },
  cardName: { fontSize: 13, lineHeight: 18, fontWeight: '600', color: C.text },
  cardSub: { fontSize: 13, lineHeight: 18, color: C.muted },
  scanBar: { paddingHorizontal: 20, paddingTop: 12 },
  pillWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  pill: {
    minHeight: PILL_H,
    paddingHorizontal: 34,
    borderRadius: PILL_H / 2,
    backgroundColor: C.accent,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    boxShadow: '0 8px 24px rgba(36, 87, 230, 0.35)',
  },
  fade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    experimental_backgroundImage: 'linear-gradient(to bottom, rgba(255, 255, 255, 0), #fff 45%)',
  },
  scanButtonText: { fontSize: 17, fontWeight: '600', color: '#fff' },
  message: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 40,
  },
  messageTitleLarge: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
  messageTextLarge: { fontSize: 16, lineHeight: 23 },
  messageTitle: { marginTop: 8, fontSize: 20, lineHeight: 26, fontWeight: '600', color: C.text, textAlign: 'center' },
  messageText: { fontSize: 15, lineHeight: 22, color: C.muted, textAlign: 'center' },
  barTitle: { fontSize: 15, lineHeight: 22, fontWeight: '600', color: C.muted, textAlign: 'center' },
  art: { width: 150, height: 150, alignItems: 'center', justifyContent: 'center' },
  artPage: {
    position: 'absolute',
    width: 86,
    height: 114,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.dashed,
    backgroundColor: '#fff',
    boxShadow: '0 2px 8px rgba(21, 23, 28, 0.12)',
    paddingTop: 18,
    paddingLeft: 12,
    gap: 9,
  },
  artLine: { height: 4, borderRadius: 2, backgroundColor: '#D5D9DF' },
  info: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 1.5,
    borderColor: C.chevron,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  infoBar: { position: 'absolute', top: 20, width: 2, height: 17, borderRadius: 1, backgroundColor: C.chevron },
  infoDot: { position: 'absolute', bottom: 18, width: 3, height: 3, borderRadius: 2, backgroundColor: C.chevron },
  nav: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 8,
    paddingRight: 12,
  },
  back: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8 },
  backText: { fontSize: 17, fontWeight: '500', color: C.accent },
  navCount: { flexShrink: 0, textAlign: 'center', fontSize: 17, fontWeight: '600', color: C.text },
  // Equal sides keep the count centred whatever the buttons' widths.
  navSide: { flex: 1, flexDirection: 'row' },
  navSideEnd: { justifyContent: 'flex-end' },
  editor: { flex: 1, backgroundColor: C.text },
  editorCount: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600', color: '#fff' },
  editorAction: { fontSize: 16, fontWeight: '500', color: '#fff' },
  strip: { paddingTop: 12, gap: 12 },
  strengths: { flexDirection: 'row', alignSelf: 'center', backgroundColor: '#22252B', borderRadius: 12, padding: 3 },
  strength: { height: 38, minWidth: 84, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  strengthOn: { backgroundColor: '#fff' },
  strengthText: { fontSize: 15, color: '#C9CDD4' },
  strengthTextOn: { fontWeight: '700', color: C.text },
  stripNote: { textAlign: 'center', fontSize: 13, color: '#A9AFBA', marginTop: 8 },
  thumbs: { flexDirection: 'row', justifyContent: 'center', gap: 18 },
  thumb: { width: 84, alignItems: 'center', gap: 6 },
  thumbBox: { padding: 3, borderRadius: 10, borderWidth: 2, borderColor: 'transparent' },
  thumbBoxOn: { borderColor: '#fff' },
  thumbCanvas: { width: THUMB_W, height: THUMB_H },
  thumbLabel: { fontSize: 13, color: '#A9AFBA' },
  thumbLabelOn: { fontWeight: '700', color: '#fff' },
  editorDone: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 12,
    paddingHorizontal: 20,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#22252B',
  },
  useOnAll: { flexShrink: 1, minHeight: 48, justifyContent: 'center' },
  useOnAllText: { fontSize: 15, color: '#C9CDD4' },
  doneButton: {
    marginLeft: 'auto',
    minHeight: 44,
    paddingHorizontal: 26,
    borderRadius: 22,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneText: { fontSize: 16, fontWeight: '600', color: C.text },
  editorToastSlot: { position: 'absolute', top: 8, left: 20, right: 20, alignItems: 'center' },
  editorToast: { backgroundColor: '#2E323A', marginBottom: 0 },
  navRight: { flexDirection: 'row', alignItems: 'center' },
  navButton: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  selectText: { fontSize: 16, fontWeight: '500', color: C.accent },
  detailHeader: { paddingTop: 12, paddingBottom: 20 },
  detailTitle: { fontSize: 24, lineHeight: 30, fontWeight: '700', letterSpacing: -0.24, color: C.text },
  gridContent: { paddingHorizontal: 20 },
  gridRow: { gap: 16, marginBottom: 16 },
  pickMark: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: '#fff',
    backgroundColor: 'rgba(21,23,28,.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickMarkOn: { backgroundColor: C.accent },
  addTile: {
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: C.dashed,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  plus: { width: 26, height: 26, flexShrink: 0, alignItems: 'center', justifyContent: 'center' },
  plusBar: { position: 'absolute', backgroundColor: C.accent, borderRadius: 1 },
  plusH: { width: 14, height: 2 },
  plusV: { width: 2, height: 14 },
  addText: { fontSize: 14, fontWeight: '600', color: C.accent, textAlign: 'center' },
  bottom: { alignItems: 'center' },
  hint: { paddingHorizontal: 20, paddingBottom: 12, fontSize: 13, lineHeight: 18, color: C.muted, textAlign: 'center' },
  saveBar: {
    width: '100%',
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 20,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.hairline,
  },
  pageTile: { borderRadius: 14, borderWidth: 3, borderColor: 'transparent', backgroundColor: C.tile, alignItems: 'center', justifyContent: 'center' },
  pageTilePicked: { borderColor: C.accent },
  pageImage: { width: '79%', height: '79%' },
  numChip: {
    position: 'absolute',
    left: 7,
    bottom: 7,
    minWidth: 24,
    minHeight: 24,
    paddingHorizontal: 6,
    borderRadius: 12,
    backgroundColor: 'rgba(21,23,28,.72)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  numText: { fontSize: 13, fontWeight: '600', color: '#fff' },
  dots: { flexDirection: 'row', gap: 3 },
  dot: { width: 4, height: 4, borderRadius: 2, backgroundColor: C.accent },
  menu: {
    position: 'absolute',
    right: 12,
    minWidth: 160,
    borderRadius: 14,
    backgroundColor: '#fff',
    boxShadow: '0 4px 16px rgba(21,23,28,0.18)',
    overflow: 'hidden',
  },
  menuItem: { minHeight: 44, paddingHorizontal: 16, justifyContent: 'center' },
  menuText: { fontSize: 16, fontWeight: '500', color: C.danger },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 999,
    backgroundColor: C.text,
    marginBottom: 16,
  },
  toastText: { fontSize: 15, lineHeight: 20, fontWeight: '500', color: '#fff' },
  action: { flex: 1, minHeight: 52, paddingVertical: 8, paddingHorizontal: 4, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  primary: { backgroundColor: C.accent },
  secondary: { backgroundColor: C.accentSoft },
  primaryText: { fontSize: 17, fontWeight: '600', color: '#fff', textAlign: 'center' },
  secondaryText: { fontSize: 17, fontWeight: '600', color: C.accent, textAlign: 'center' },
  backdrop: { backgroundColor: 'rgba(21,23,28,.42)' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 20,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    backgroundColor: '#fff',
  },
  sheetDark: { backgroundColor: C.text, paddingHorizontal: 0, paddingTop: 20 },
  grabber: { alignSelf: 'center', width: 36, height: 5, borderRadius: 3, marginTop: 8, backgroundColor: '#D5D9DF' },
  sheetTitle: { paddingTop: 16, paddingBottom: 8, fontSize: 17, fontWeight: '700', color: C.text },
  sheetHeading: { textAlign: 'center', fontSize: 17, fontWeight: '600', color: '#fff' },
  sheetRow: {
    height: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.hairline,
  },
  sheetIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: C.accentSoft, alignItems: 'center', justifyContent: 'center' },
  sheetRowTitle: { fontSize: 16, fontWeight: '700', color: C.text },
  sheetRowSub: { fontSize: 13, color: C.muted },
  iconDoc: { width: 16, height: 20, borderRadius: 3, borderWidth: 2, borderColor: C.accent, justifyContent: 'center', gap: 3, paddingHorizontal: 2 },
  iconLine: { height: 2, borderRadius: 1, backgroundColor: C.accent },
  iconPhoto: { width: 21, height: 16, borderRadius: 3, borderWidth: 2, borderColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  iconSun: { width: 5, height: 5, borderRadius: 3, backgroundColor: C.accent },
  iconRings: { flexDirection: 'row' },
  iconRing: { width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: C.accent },
  iconRingBack: { marginLeft: -6 },
  sheetPill: { minHeight: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  sheetToastSlot: { top: -56 },
  sheetDone: { marginLeft: 20, marginRight: 20 },
  sheetCancel: { backgroundColor: C.tile },
  sheetCancelText: { fontSize: 16, fontWeight: '600', color: C.text },
  capture: { flex: 1, backgroundColor: '#000' },
  captureOverlay: { alignItems: 'center', justifyContent: 'center' },
  guide: { width: '72%', aspectRatio: 3 / 4, borderWidth: 3, borderColor: '#6E97FF', borderRadius: 8, backgroundColor: 'rgba(76,125,255,0.16)' },
  captureTop: { position: 'absolute', left: 0, right: 0, height: 44, alignItems: 'center', justifyContent: 'center' },
  captureHold: { position: 'absolute', left: 0, right: 0, bottom: 16, alignItems: 'center' },
  captureChip: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 14, overflow: 'hidden', backgroundColor: 'rgba(0,0,0,0.5)', fontSize: 13, color: '#fff' },
  closeButton: { position: 'absolute', left: 12, width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  closeBar: { position: 'absolute', width: 18, height: 2, borderRadius: 1, backgroundColor: '#fff' },
  captureBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 28, paddingTop: 16, backgroundColor: '#000' },
  captureSlot: { width: 96 },
  captureSlotEnd: { alignItems: 'flex-end' },
  camThumbBox: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center' },
  camThumb: { width: 42, height: 56, borderRadius: 4 },
  thumbBadge: { position: 'absolute', top: 0, right: 0, minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 5, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  thumbBadgeText: { fontSize: 12, fontWeight: '700', color: '#fff' },
  donePillCam: { height: 48, minWidth: 80, borderRadius: 24, paddingHorizontal: 18, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  pillText: { fontSize: 16, fontWeight: '600', color: '#fff' },
  corners: { flex: 1, backgroundColor: '#0E0F12' },
  cornersBar: { height: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 },
  cornersSide: { width: 88, minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  retakeText: { fontSize: 17, color: '#C9CDD4' },
  cornersTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '600', color: '#fff' },
  editorArea: { flex: 1, borderRadius: 16, overflow: 'hidden', marginTop: 8, marginHorizontal: 20 },
  cornersHint: { marginTop: 16, textAlign: 'center', fontSize: 14, color: '#A9AFBA' },
  cornersRow: { flexDirection: 'row', gap: 10, paddingHorizontal: 20, marginTop: 16 },
  cornersPill: { flex: 1, height: 52, borderRadius: 26, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' },
  nextPill: { backgroundColor: '#22252B' },
  donePill: { backgroundColor: C.accent },
  plusWhite: { backgroundColor: '#fff' },
  shutter: {
    width: 78,
    height: 78,
    borderRadius: 39,
    borderWidth: 4,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: { width: 62, height: 62, borderRadius: 31, backgroundColor: '#fff' },
});
