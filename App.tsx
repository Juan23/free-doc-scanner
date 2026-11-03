import { Camera, CameraView } from 'expo-camera';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Alert,
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { clearScannerCache, discardScan, saveJpegs, savePdf, scanName } from './save';

type Scan = { pages: string[]; pdfUri?: string; name: string };

export default function App() {
  const [scan, setScan] = useState<Scan | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  // State updates are async, so a second tap in the same frame would still see busy=false.
  const inFlight = useRef(false);

  // Scans left behind when the app was killed on the review screen.
  useEffect(() => {
    clearScannerCache();
  }, []);

  // Android reads the live region itself; iOS needs an explicit announcement.
  useEffect(() => {
    if (message && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(message);
  }, [message]);

  // The current scan stays on screen while the scanner is open; it is only replaced on a result.
  async function openScanner() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await CameraView.scanDocumentAsync({ requestPdf: true });
      if (result) {
        if (scan) discardScan(scan.pdfUri ? [...scan.pages, scan.pdfUri] : scan.pages);
        setScan({ pages: result.pages, pdfUri: result.pdfUri, name: scanName() });
        setMessage('');
      }
    } catch (e) {
      // VisionKit fails instead of asking again once camera access was denied. Android's
      // scanner runs in Play services, so the app never holds the camera permission there.
      if (Platform.OS === 'ios' && !(await Camera.getCameraPermissionsAsync()).granted) {
        askForSettings('Camera access needed', 'Allow camera access in Settings to scan.');
      } else {
        Alert.alert('Scan failed', e instanceof Error ? e.message : String(e));
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function save(kind: 'pdf' | 'jpeg') {
    if (!scan || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    try {
      if (kind === 'pdf') {
        if ((await savePdf(scan.pdfUri!, scan.name)) === 'saved') setMessage('PDF saved');
      } else if ((await saveJpegs(scan.pages, scan.name)) === 'saved') {
        setMessage('JPEGs saved to Photos');
      } else {
        askForSettings('Photo access needed', 'Allow photo access in Settings to save JPEGs.');
      }
    } catch (e) {
      Alert.alert('Could not save', e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Free Doc Scanner</Text>
      {scan ? (
        <ScrollView>
          <ScrollView horizontal style={styles.thumbs} contentContainerStyle={styles.thumbsContent}>
            {scan.pages.map((uri, i) => (
              <Image
                key={uri}
                source={{ uri }}
                style={styles.thumb}
                resizeMode="contain"
                accessibilityLabel={`Page ${i + 1}`}
              />
            ))}
          </ScrollView>
          <Text style={styles.info}>
            {scan.pages.length} {scan.pages.length === 1 ? 'page' : 'pages'}
          </Text>
          <Text style={styles.message} accessibilityLiveRegion="polite">
            {message}
          </Text>
          <Button label="Save PDF" disabled={busy || !scan.pdfUri} onPress={() => save('pdf')} />
          <Button label="Save JPEG" disabled={busy} onPress={() => save('jpeg')} />
          <Button label="New scan" secondary disabled={busy} onPress={openScanner} />
        </ScrollView>
      ) : CameraView.isDocumentScannerAvailable ? (
        <View style={styles.center}>
          <Button label="Scan" disabled={busy} onPress={openScanner} />
        </View>
      ) : (
        <View style={styles.center}>
          <Text style={styles.info}>
            This phone can’t run the built-in document scanner. On Android it needs Google Play
            services.
          </Text>
        </View>
      )}
      <StatusBar style="dark" />
    </View>
  );
}

function askForSettings(title: string, message: string) {
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Open Settings', onPress: () => Linking.openSettings() },
  ]);
}

function Button(props: { label: string; onPress: () => void; disabled?: boolean; secondary?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[styles.button, props.secondary && styles.buttonSecondary, props.disabled && styles.disabled]}>
      <Text style={[styles.buttonText, props.secondary && styles.buttonTextSecondary]}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    paddingHorizontal: 24,
    paddingTop: 72,
    paddingBottom: 40,
  },
  title: { fontSize: 28, fontWeight: '700', color: '#111', textAlign: 'center', marginBottom: 24 },
  center: { flex: 1, justifyContent: 'center' },
  thumbs: { flexGrow: 0 },
  thumbsContent: { gap: 12, paddingVertical: 8 },
  thumb: { width: 180, height: 240, borderRadius: 8, backgroundColor: '#f1f1f1' },
  info: { fontSize: 16, color: '#444', textAlign: 'center', marginVertical: 12 },
  message: { fontSize: 16, color: '#1a7f37', textAlign: 'center', minHeight: 24, marginBottom: 12 },
  button: {
    minHeight: 52,
    borderRadius: 12,
    backgroundColor: '#0a63d8',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  buttonSecondary: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#0a63d8' },
  disabled: { opacity: 0.4 },
  buttonText: { fontSize: 18, fontWeight: '600', color: '#fff' },
  buttonTextSecondary: { color: '#0a63d8' },
});
