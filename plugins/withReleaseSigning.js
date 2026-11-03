const { withAppBuildGradle } = require('expo/config-plugins');

const MARK = '// fds-release-signing';
const SIGNING = `
        release {
            ${MARK}
            if (findProperty('FDS_UPLOAD_STORE_FILE')) {
                storeFile file(findProperty('FDS_UPLOAD_STORE_FILE'))
                storePassword findProperty('FDS_UPLOAD_STORE_PASSWORD')
                keyAlias findProperty('FDS_UPLOAD_KEY_ALIAS')
                keyPassword findProperty('FDS_UPLOAD_KEY_PASSWORD')
            }
        }`;

module.exports = (config) =>
  withAppBuildGradle(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (src.includes(MARK)) return cfg;
    // Add release signingConfig after the debug one, then pick it for release when the key is configured.
    src = src.replace(/(signingConfigs \{\s*debug \{[^}]*\})/, `$1${SIGNING}`);
    src = src.replace(
      /(buildTypes \{[^]*?release \{[^]*?)signingConfig signingConfigs\.debug/,
      (m, head) =>
        `${head}signingConfig findProperty('FDS_UPLOAD_STORE_FILE') ? signingConfigs.release : signingConfigs.debug`
    );
    cfg.modResults.contents = src;
    return cfg;
  });
