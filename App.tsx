import { Camera, CameraView } from 'expo-camera';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Alert,
  BackHandler,
  FlatList,
  Image,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { clearScannerCache, saveJpegs, savePdf } from './save';
import { addPages, createScan, deleteScan, listScans, type Scan } from './scans';

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

const unavailableText =
  'This phone can’t run the built-in document scanner. On Android it needs Google Play services.';

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
      if (!inFlight.current) setOpen(null);
      return true;
    });
    return () => sub.remove();
  }, [open]);

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
      Alert.alert(errorTitle, e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  // Re-reads the list and the open scan, so pages moved before a failure show up.
  function refresh() {
    const all = listScans();
    setScans(all);
    if (open) setOpen(all.find((s) => s.id === open.id) ?? null);
  }

  function scanPages(onPages: (pages: string[]) => Promise<void>) {
    return guarded(async () => {
      let result;
      try {
        result = await CameraView.scanDocumentAsync({ quality: 0.8 });
      } catch (e) {
        // VisionKit fails instead of asking again once camera access was denied. Android's
        // scanner runs in Play services, so the app never holds the camera permission there.
        if (Platform.OS === 'ios' && !(await Camera.getCameraPermissionsAsync()).granted) {
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

  const scanNew = () =>
    scanPages(async (pages) => {
      setMessage('');
      setOpen(await createScan(pages));
    });

  const addToOpen = () =>
    open &&
    scanPages(async (pages) => {
      await addPages(open, pages);
    });

  function save(kind: 'pdf' | 'jpeg') {
    if (!open) return;
    const scan = open;
    setMessage('');
    guarded(async () => {
      if (kind === 'pdf') {
        if ((await savePdf(scan.pages, scan.name)) === 'saved') showToast('PDF saved');
      } else if ((await saveJpegs(scan.pages, scan.name)) === 'saved') {
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
      {open ? (
        <Detail
          scan={open}
          busy={busy}
          message={message}
          onBack={() => setOpen(null)}
          onDelete={confirmDelete}
          onAdd={addToOpen}
          onSave={save}
        />
      ) : (
        <Home scans={scans} busy={busy} onScan={scanNew} onOpen={(s) => { setMessage(''); setOpen(s); }} />
      )}
      <StatusBar style="dark" />
    </View>
  );
}

function Home(props: { scans: Scan[]; busy: boolean; onScan: () => void; onOpen: (s: Scan) => void }) {
  const available = CameraView.isDocumentScannerAvailable;
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
            <Image source={{ uri: item.pages[0] }} style={styles.rowThumb} resizeMode="cover" />
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

type Cell = { key: string; uri?: string; n?: number };

function Detail(props: {
  scan: Scan;
  busy: boolean;
  message: string;
  onBack: () => void;
  onDelete: () => void;
  onAdd: () => void;
  onSave: (kind: 'pdf' | 'jpeg') => void;
}) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const cell = (width - 40 - 28) / 3;
  const { scan, busy } = props;
  const available = CameraView.isDocumentScannerAvailable;
  const data: Cell[] = [
    ...scan.pages.map((uri, i) => ({ key: uri, uri, n: i + 1 })),
    ...(available ? [{ key: 'add' }] : []),
  ];
  const disabled = busy && styles.disabled;
  return (
    <View style={[styles.flex, { paddingTop: insets.top + 8, paddingBottom: bottomPad(insets.bottom) }]}>
      <View style={styles.nav}>
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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Delete scan"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={props.onDelete}
          style={[styles.deleteButton, disabled]}>
          <Text style={styles.deleteText} maxFontSizeMultiplier={1.5}>Delete</Text>
        </Pressable>
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
        renderItem={({ item }) =>
          item.uri ? (
            <View style={[styles.cell, { width: cell }]}>
              <Image
                source={{ uri: item.uri }}
                accessible
                accessibilityLabel={`Page ${item.n}`}
                style={[styles.page, { width: cell, height: (cell * 4) / 3 }]}
                resizeMode="contain"
              />
              <Text style={styles.pageNum} importantForAccessibility="no" accessible={false}>
                {item.n}
              </Text>
            </View>
          ) : (
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
          )
        }
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
  deleteButton: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  deleteText: { fontSize: 16, fontWeight: '500', color: C.muted },
  detailHeader: { paddingTop: 12, paddingBottom: 20 },
  detailTitle: { fontSize: 24, lineHeight: 30, fontWeight: '700', letterSpacing: -0.24, color: C.text },
  gridContent: { paddingHorizontal: 20 },
  gridRow: { gap: 14, marginBottom: 14 },
  cell: { alignItems: 'center', gap: 6 },
  page: { borderWidth: 1, borderColor: C.hairline, borderRadius: 8, backgroundColor: '#fff' },
  pageNum: { fontSize: 13, lineHeight: 18, color: C.muted },
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
  actions: { width: '100%', flexDirection: 'row', gap: 12 },
  action: { flex: 1, minHeight: 54, paddingVertical: 8, paddingHorizontal: 4, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  primary: { backgroundColor: C.accent },
  secondary: { backgroundColor: C.accentSoft },
  primaryText: { fontSize: 17, fontWeight: '600', color: '#fff', textAlign: 'center' },
  secondaryText: { fontSize: 17, fontWeight: '600', color: C.accent, textAlign: 'center' },
});
