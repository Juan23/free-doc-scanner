import { Canvas, Circle, Path } from '@shopify/react-native-skia';
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
  Image,
  Linking,
  Modal,
  type GestureResponderEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { cleanPages, defaultFilter, setDefaultFilter, type Filter } from './clean';
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
  tile: '#F7F8FA',
  dashed: '#B9C0CB',
  chevron: '#9AA1AD',
};

const bottomPad = (inset: number) => Math.max(inset + 12, 16);

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
  const [filter, setFilterState] = useState<Filter>(defaultFilter);
  const [onCapturedPages, setOnCapturedPages] = useState<((pages: string[]) => Promise<void>) | null>(null);
  // Pages picked in Select mode, or null outside it.
  const [picked, setPicked] = useState<string[] | null>(null);
  // Edits per page (hand turns and filter changes), added to its URI as a query: Image keeps showing a page it already
  // loaded from the same URI, and both platforms read a file:// image by its path, ignoring the query.
  const [edits, setEdits] = useState<Record<string, number>>({});
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

  // Remembers the choice for new scans.
  function chooseFilter(chosen: Filter) {
    setFilterState(chosen);
    setDefaultFilter(chosen);
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
      touchPages([page]);
    }, 'Could not rotate');

  // Applies to the picked pages, or every page when none are picked.
  const applyFilter = (filter: Filter) => {
    if (!open) return;
    const scan = open;
    guarded(async () => {
      const pages = pagesToSave(scan.pages, picked ?? []);
      const failed = await cleanPages(pages, filter);
      // Pages that did change must reload even when another failed.
      touchPages(pages);
      if (failed) throw new Error(failed === 1 ? 'One page could not be changed.' : `${failed} pages could not be changed.`);
    }, 'Could not change filter');
  };

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
          onBack={() => setOpen(null)}
          onDelete={confirmDelete}
          onAdd={addToOpen}
          onRotate={rotate}
          onApplyFilter={applyFilter}
          onSave={save}
        />
      ) : (
        <Home
          scans={scans}
          busy={busy}
          shown={shown}
          filter={filter}
          onFilter={chooseFilter}
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
  filter: Filter;
  onFilter: (filter: Filter) => void;
  onScan: () => void;
  onOpen: (s: Scan) => void;
}) {
  const available = scannerAvailable();
  const insets = useSafeAreaInsets();
  const header = (
    <View style={styles.homeHeader}>
      <Text style={styles.title} accessibilityRole="header">Scans</Text>
      <Text style={styles.subtitle}>Kept on this phone only</Text>
    </View>
  );
  let body;
  if (props.scans.length === 0 && !available) {
    body = <Message icon={<InfoIcon />} title="Scanner not available" text={unavailableText} />;
  } else if (props.scans.length === 0) {
    body = (
      <Message
        icon={<EmptyArt />}
        title="No scans yet"
        text="Scan a document and it shows up here, ready to save as a PDF or JPEG."
      />
    );
  } else {
    body = (
      <FlatList
        style={styles.flex}
        contentContainerStyle={styles.listContent}
        data={props.scans}
        keyExtractor={(s) => s.id}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.name}, ${pagesLabel(item.pages.length)}`}
            accessibilityState={{ disabled: props.busy }}
            disabled={props.busy}
            onPress={() => props.onOpen(item)}
            style={[styles.row, props.busy && styles.disabled]}>
            <Image source={{ uri: props.shown(item.pages[0]) }} style={styles.rowThumb} resizeMode="cover" />
            <View style={styles.rowText}>
              <Text style={styles.rowName}>{item.name}</Text>
              <Text style={styles.rowSub}>{pagesLabel(item.pages.length)}</Text>
            </View>
            <View style={styles.chevronBox}>
              <Chevron color={C.chevron} />
            </View>
          </Pressable>
        )}
      />
    );
  }
  return (
    <View style={[styles.flex, { paddingTop: insets.top + 16, paddingBottom: bottomPad(insets.bottom) }]}>
      {header}
      {body}
      {available && (
        <View style={styles.scanBar}>
          <View style={styles.filterBlock}>
            <Text style={styles.rowName}>Filter for new scans</Text>
            <Text style={styles.rowSub}>Clean whitens paper and removes shadows and dirt. Original keeps the photos.</Text>
            <FilterChoices filter={props.filter} onChange={props.onFilter} disabled={props.busy} />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Scan"
            accessibilityState={{ disabled: props.busy }}
            disabled={props.busy}
            onPress={props.onScan}
            style={[styles.scanButton, props.busy && styles.disabled]}>
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

/** One radio button of a filter choice. */
function Choice(props: { label: string; checked: boolean; disabled?: boolean; onPress: () => void }) {
  const { label, checked, disabled } = props;
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={props.onPress}
      style={[styles.choice, checked && styles.choiceOn, disabled && styles.disabled]}>
      <Text style={[styles.choiceText, checked && styles.choiceTextOn]} maxFontSizeMultiplier={1.5}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Original / Clean / Grayscale, and Light / Normal / Strong for the two clean-ups. */
function FilterChoices(props: { filter: Filter; onChange: (filter: Filter) => void; disabled?: boolean }) {
  const { filter, onChange, disabled } = props;
  return (
    <View style={styles.filterChoices}>
      <View style={styles.choices} accessibilityRole="radiogroup" accessibilityLabel="Filter">
        {FILTER_KINDS.map(({ kind, label }) => (
          <Choice
            key={kind}
            label={label}
            checked={filter.kind === kind}
            disabled={disabled}
            onPress={() => onChange({ ...filter, kind })}
          />
        ))}
      </View>
      {filter.kind !== 'original' && (
        <View style={styles.choices} accessibilityRole="radiogroup" accessibilityLabel="Clean-up strength">
          {FILTER_STRENGTHS.map(({ strength, label }) => (
            <Choice
              key={label}
              label={label}
              checked={filter.strength === strength}
              disabled={disabled}
              onPress={() => onChange({ ...filter, strength })}
            />
          ))}
        </View>
      )}
    </View>
  );
}

type Cell = { key: string; uri?: string; n?: number };

function Detail(props: {
  scan: Scan;
  busy: boolean;
  message: string;
  picked: string[] | null;
  onPick: (pages: string[] | null) => void;
  shown: (page: string) => string;
  onBack: () => void;
  onDelete: () => void;
  onAdd: () => void;
  onRotate: (page: string) => void;
  onApplyFilter: (filter: Filter) => void;
  onSave: (kind: 'pdf' | 'jpeg') => void;
}) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [current, setCurrent] = useState(0);
  const [holding, setHolding] = useState(false);
  const [pagerHeight, setPagerHeight] = useState(0);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>(defaultFilter);
  const cell = (width - 40 - 28) / 3;
  const { scan, busy, picked } = props;
  const available = scannerAvailable();
  const data: Cell[] = [
    ...scan.pages.map((uri, i) => ({ key: uri, uri, n: i + 1 })),
    ...(available && !picked ? [{ key: 'add' }] : []),
  ];
  // Pages scanned before untouched photos were kept have no photo to put back.
  const hasMissingPhoto = useMemo(
    () => filterOpen && anyOriginalMissing(pagesToSave(scan.pages, picked ?? [])),
    [filterOpen, scan.pages, picked],
  );
  const disabled = busy && styles.disabled;
  const closePreview = () => {
    setPreviewIndex(null);
    setHolding(false);
  };
  return (
    <View style={[styles.flex, { paddingTop: insets.top + 8, paddingBottom: bottomPad(insets.bottom) }]}>
      <View style={styles.nav}>
        {picked ? (
          <Text style={styles.navCount} maxFontSizeMultiplier={1.5}>
            {picked.length ? `${picked.length} of ${scan.pages.length} selected` : 'Pick pages to save'}
          </Text>
        ) : (
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
        )}
        <View style={styles.navRight}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={picked ? 'Cancel selecting' : 'Select pages'}
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={() => props.onPick(picked ? null : [])}
            style={[styles.navButton, disabled]}>
            <Text style={styles.selectText} maxFontSizeMultiplier={1.5}>{picked ? 'Cancel' : 'Select'}</Text>
          </Pressable>
          {/* Hidden while selecting, so it can't be mistaken for deleting the picked pages. */}
          {!picked && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Delete scan"
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={props.onDelete}
              style={[styles.navButton, disabled]}>
              <Text style={styles.deleteText} maxFontSizeMultiplier={1.5}>Delete</Text>
            </Pressable>
          )}
        </View>
      </View>
      <FlatList
        style={styles.flex}
        data={data}
        numColumns={3}
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
          if (uri) {
            const on = !!picked?.includes(uri);
            const image = (
              <Image
                source={{ uri: props.shown(uri) }}
                accessible={!picked}
                accessibilityLabel={`Page ${item.n}`}
                style={[styles.page, { width: cell, height: (cell * 4) / 3 }, on && styles.pagePicked]}
                resizeMode="contain"
              />
            );
            // The cell stays a View so a corner button can sit beside the picking Pressable, not inside it.
            return (
              <View style={[styles.cell, { width: cell }]}>
                {picked ? (
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityLabel={`Page ${item.n}`}
                    accessibilityState={{ checked: on, disabled: busy }}
                    disabled={busy}
                    onPress={() => props.onPick(on ? picked.filter((p) => p !== uri) : [...picked, uri])}
                    style={disabled}>
                    {image}
                    <View style={[styles.pickMark, on && styles.pickMarkOn]}>{on && <Check />}</View>
                  </Pressable>
                ) : (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Preview page ${item.n}`}
                    accessibilityState={{ disabled: busy }}
                    disabled={busy}
                    onPress={() => {
                      const i = item.n! - 1;
                      setCurrent(i);
                      setPreviewIndex(i);
                    }}
                    style={disabled}>
                    {image}
                  </Pressable>
                )}
                <View style={styles.pageBar}>
                  <Text style={styles.pageNum} importantForAccessibility="no" accessible={false} maxFontSizeMultiplier={1.5}>
                    {item.n}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Rotate page ${item.n}`}
                    accessibilityState={{ disabled: busy }}
                    disabled={busy}
                    onPress={() => props.onRotate(uri)}
                    style={[styles.rotate, disabled]}>
                    <Text style={styles.rotateText} maxFontSizeMultiplier={1.5}>Rotate</Text>
                  </Pressable>
                </View>
              </View>
            );
          }
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add pages"
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={props.onAdd}
              style={[styles.addTile, { width: cell, minHeight: (cell * 4) / 3 }, disabled]}>
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
          {!!props.message && (
            <View style={styles.toast}>
              <Check />
              <Text style={styles.toastText}>{props.message}</Text>
            </View>
          )}
        </View>
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Filter pages"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={() => setFilterOpen(true)}
            style={[styles.action, styles.secondary, disabled]}>
            <Text style={styles.secondaryText} maxFontSizeMultiplier={1.5}>Filter</Text>
          </Pressable>
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
        </View>
      </View>
      <Modal
        visible={previewIndex !== null}
        animationType="fade"
        statusBarTranslucent
        onRequestClose={closePreview}>
        <StatusBar style="light" />
        <View style={[styles.preview, { paddingTop: insets.top + 8, paddingBottom: bottomPad(insets.bottom) }]}>
          <View style={styles.nav}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Back to pages"
              onPress={closePreview}
              style={styles.back}>
              <Chevron color="#fff" left />
              <Text style={styles.previewAction} maxFontSizeMultiplier={1.5}>Back</Text>
            </Pressable>
            <Text style={styles.previewCount} accessibilityLiveRegion="polite" maxFontSizeMultiplier={1.5}>
              Page {current + 1} of {scan.pages.length}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Rotate page ${current + 1}`}
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={() => props.onRotate(scan.pages[current])}
              style={[styles.navButton, busy && styles.disabled]}>
              <Text style={styles.previewAction} maxFontSizeMultiplier={1.5}>Rotate</Text>
            </Pressable>
          </View>
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
            initialScrollIndex={previewIndex ?? 0}
            extraData={[props.shown, holding]}
            getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
            onMomentumScrollEnd={(e) => {
              setCurrent(Math.round(e.nativeEvent.contentOffset.x / width));
              setHolding(false);
            }}
            renderItem={({ item, index }) => (
              <Pressable
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
          <View style={styles.previewDone}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Done"
              onPress={closePreview}
              style={[styles.action, styles.primary]}>
              <Text style={styles.primaryText} maxFontSizeMultiplier={1.5}>Done</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
      <Modal
        visible={filterOpen}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setFilterOpen(false)}>
        <View style={styles.sheetBackdrop}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close filter"
            onPress={() => setFilterOpen(false)}
            style={StyleSheet.absoluteFill}
          />
          <View
            accessibilityViewIsModal
            style={[styles.sheet, { paddingBottom: bottomPad(insets.bottom) }]}>
            <Text style={styles.sheetTitle} accessibilityRole="header">Filter</Text>
            <Text style={styles.rowSub}>
              {picked?.length ? 'Applies to the picked pages.' : 'Applies to every page.'}
            </Text>
            {hasMissingPhoto && (
              <Text style={styles.rowSub}>Pages scanned before this version keep their clean-up.</Text>
            )}
            <FilterChoices filter={filter} onChange={setFilter} disabled={busy} />
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel filter"
                onPress={() => setFilterOpen(false)}
                style={[styles.action, styles.secondary]}>
                <Text style={styles.secondaryText} maxFontSizeMultiplier={1.5}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Apply filter"
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={() => {
                  props.onApplyFilter(filter);
                  setFilterOpen(false);
                }}
                style={[styles.action, styles.primary, disabled]}>
                <Text style={styles.primaryText} maxFontSizeMultiplier={1.5}>Apply</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
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
      <View style={[styles.capture, pad]}>
        <Text style={styles.captureHint}>Drag the corners to the page’s edges</Text>
        <PageEditor photo={photo} onChange={(corners) => setPhoto({ ...photo, corners })} />
        <View style={styles.captureBar}>
          <CaptureButton label="Retake" disabled={working} onPress={retake} />
          <CaptureButton label="Next page" disabled={working} onPress={() => keep(false)} />
          <CaptureButton label="Done" primary disabled={working} onPress={() => keep(true)} />
        </View>
      </View>
    );
  }
  return (
    <View style={[styles.capture, pad]}>
      <CameraView ref={camera} style={styles.flex} facing="back" animateShutter />
      <View style={styles.captureBar}>
        <CaptureButton label="Cancel" disabled={working} onPress={cancel} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Take photo"
          accessibilityState={{ disabled: working }}
          disabled={working}
          onPress={shoot}
          style={styles.shutter}>
          {working ? <ActivityIndicator color={C.text} /> : <View style={styles.shutterInner} />}
        </Pressable>
        <CaptureButton
          label={pages.length ? `Done (${pages.length})` : 'Done'}
          hidden={!pages.length}
          disabled={working}
          onPress={() => props.onEnd(pages)}
        />
      </View>
    </View>
  );
}

function CaptureButton(props: { label: string; onPress: () => void; disabled: boolean; primary?: boolean; hidden?: boolean }) {
  if (props.hidden) return <View style={styles.captureButton} />;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[styles.captureButton, props.primary && styles.captureButtonPrimary, props.disabled && styles.disabled]}>
      <Text style={styles.captureButtonText} maxFontSizeMultiplier={1.5}>{props.label}</Text>
    </Pressable>
  );
}

// A drag that starts on a corner handle moves that corner.
function PageEditor(props: { photo: Photo; onChange: (corners: Quad) => void }) {
  // Touches use page coordinates: locationX/Y is relative to whichever child view the finger lands on.
  const view = useRef<React.ComponentRef<typeof View>>(null);
  const [box, setBox] = useState({ width: 0, height: 0, pageX: 0, pageY: 0 });
  const { photo } = props;
  // Keeps edge handles whole on screen and, at the sides, out of Android's swipe-back zone, which would take the drag.
  const sideMargin = 48;
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
      style={styles.flex}
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
            <Path path={outline} style="stroke" strokeWidth={2} color={C.accent} />
            {onScreen.map((p, i) => (
              <Circle key={i} cx={p.x} cy={p.y} r={14} color="rgba(36,87,230,0.35)">
                <Circle cx={p.x} cy={p.y} r={14} style="stroke" strokeWidth={3} color="#fff" />
              </Circle>
            ))}
          </Canvas>
        </>
      )}
    </View>
  );
}

function Message(props: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <View style={styles.message}>
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        {props.icon}
      </View>
      <Text style={styles.messageTitle}>{props.title}</Text>
      <Text style={styles.messageText}>{props.text}</Text>
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

function EmptyArt() {
  return (
    <View style={styles.art}>
      <Corners size={68} arm={22} color={C.accent} w={4} />
      <View style={styles.artPage}>
        {[18, 24, 24, 14].map((w, i) => (
          <View key={i} style={[styles.artLine, { width: w }]} />
        ))}
      </View>
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
        transform: [{ rotate: props.left ? '-135deg' : '45deg' }],
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

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: '#fff' },
  disabled: { opacity: 0.4 },
  homeHeader: { paddingHorizontal: 20, paddingBottom: 8 },
  title: { fontSize: 32, lineHeight: 40, fontWeight: '700', letterSpacing: -0.64, color: C.text },
  subtitle: { marginTop: 4, fontSize: 14, lineHeight: 20, color: C.muted },
  listContent: { paddingHorizontal: 20 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minHeight: 64,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.hairline,
  },
  rowThumb: {
    width: 44,
    height: 58,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: C.hairline,
    backgroundColor: '#fff',
  },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowName: { fontSize: 16, lineHeight: 22, fontWeight: '500', color: C.text },
  rowSub: { fontSize: 14, lineHeight: 20, color: C.muted },
  chevronBox: { width: 20, alignItems: 'center' },
  scanBar: { paddingHorizontal: 20, paddingTop: 12 },
  filterBlock: { marginBottom: 12, gap: 8 },
  filterChoices: { gap: 8 },
  choices: { flexDirection: 'row', gap: 8 },
  choice: {
    flex: 1,
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.hairline,
    backgroundColor: C.tile,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  choiceOn: { borderColor: C.accent, backgroundColor: C.accent },
  choiceText: { fontSize: 15, fontWeight: '600', color: C.text },
  choiceTextOn: { color: '#fff' },
  scanButton: {
    minHeight: 56,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: C.accent,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  scanButtonText: { fontSize: 17, fontWeight: '600', color: '#fff' },
  message: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 40,
  },
  messageTitle: { marginTop: 8, fontSize: 20, lineHeight: 26, fontWeight: '600', color: C.text, textAlign: 'center' },
  messageText: { fontSize: 15, lineHeight: 22, color: C.muted, textAlign: 'center' },
  barTitle: { fontSize: 15, lineHeight: 22, fontWeight: '600', color: C.muted, textAlign: 'center' },
  art: { width: 96, height: 96, alignItems: 'center', justifyContent: 'center' },
  artPage: {
    position: 'absolute',
    width: 40,
    height: 52,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: '#C9CED6',
    paddingTop: 10,
    paddingLeft: 6,
    gap: 6,
  },
  artLine: { height: 3, borderRadius: 2, backgroundColor: '#D5D9DF' },
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
  navCount: { flexShrink: 1, paddingHorizontal: 8, fontSize: 17, fontWeight: '600', color: C.text },
  preview: { flex: 1, backgroundColor: C.text },
  previewCount: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600', color: '#fff' },
  previewAction: { fontSize: 16, fontWeight: '500', color: '#fff' },
  previewDone: { flexDirection: 'row', paddingHorizontal: 20, paddingTop: 12 },
  navRight: { flexDirection: 'row', alignItems: 'center' },
  navButton: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  selectText: { fontSize: 16, fontWeight: '500', color: C.accent },
  deleteText: { fontSize: 16, fontWeight: '500', color: C.muted },
  detailHeader: { paddingTop: 12, paddingBottom: 20 },
  detailTitle: { fontSize: 24, lineHeight: 30, fontWeight: '700', letterSpacing: -0.24, color: C.text },
  gridContent: { paddingHorizontal: 20 },
  gridRow: { gap: 14, marginBottom: 14 },
  cell: { alignItems: 'center' },
  pageBar: { alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  page: { borderWidth: 1, borderColor: C.hairline, borderRadius: 8, backgroundColor: '#fff' },
  pagePicked: { borderWidth: 2, borderColor: C.accent },
  // Top-left, like Google Photos, leaving the other corners free.
  pickMark: {
    position: 'absolute',
    top: 6,
    left: 6,
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1.5,
    borderColor: C.chevron,
    backgroundColor: 'rgba(255,255,255,0.9)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickMarkOn: { borderColor: C.accent, backgroundColor: C.accent },
  pageNum: { fontSize: 13, lineHeight: 18, color: C.muted, paddingLeft: 4 },
  rotate: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  rotateText: { fontSize: 14, fontWeight: '600', color: C.accent },
  addTile: {
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: C.dashed,
    borderRadius: 8,
    backgroundColor: C.tile,
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
  bottom: { paddingHorizontal: 20, paddingTop: 12, alignItems: 'center' },
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
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(21,23,28,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 20,
    gap: 12,
  },
  sheetTitle: { fontSize: 22, lineHeight: 28, fontWeight: '700', color: C.text },
  actions: { width: '100%', flexDirection: 'row', gap: 12 },
  action: { flex: 1, minHeight: 54, paddingVertical: 8, paddingHorizontal: 4, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  primary: { backgroundColor: C.accent },
  secondary: { backgroundColor: C.accentSoft },
  primaryText: { fontSize: 17, fontWeight: '600', color: '#fff', textAlign: 'center' },
  secondaryText: { fontSize: 17, fontWeight: '600', color: C.accent, textAlign: 'center' },
  capture: { flex: 1, backgroundColor: '#000' },
  captureHint: { paddingVertical: 12, paddingHorizontal: 20, fontSize: 15, lineHeight: 20, color: '#fff', textAlign: 'center' },
  captureBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  captureButton: { flex: 1, minHeight: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  captureButtonPrimary: { backgroundColor: C.accent },
  captureButtonText: { fontSize: 17, fontWeight: '600', color: '#fff', textAlign: 'center' },
  shutter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: { width: 60, height: 60, borderRadius: 30, backgroundColor: '#fff' },
});
