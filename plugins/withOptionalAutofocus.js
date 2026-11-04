const { withAndroidManifest } = require('expo/config-plugins');

// Declaring the camera permission makes Google Play require a camera with autofocus unless the
// manifest says otherwise. Fixed-focus cameras can still scan.
module.exports = (config) =>
  withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    const name = 'android.hardware.camera.autofocus';
    const features = (manifest['uses-feature'] ??= []);
    if (!features.some((f) => f.$['android:name'] === name)) {
      features.push({ $: { 'android:name': name, 'android:required': 'false' } });
    }
    return cfg;
  });
