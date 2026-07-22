// Dynamic Expo config. It extends the static app.json (passed in as `config`)
// and injects the Android Google Maps API key from an environment variable, so
// the key is never committed in plaintext.
//
// On EAS, provide it as a project secret before building Android:
//   eas secret:create --scope project \
//     --name GOOGLE_MAPS_ANDROID_API_KEY --value <your-android-maps-key>
//
// iOS uses Apple Maps and needs no key. A build without the secret still runs
// everywhere; only the Android map tiles stay blank until the secret is set and
// a new Android build is made. react-native-maps is a native module, so its
// first inclusion requires a fresh EAS build + store submission (Parts B/C/D
// ride the same release).
module.exports = ({ config }) => {
  const key = process.env.GOOGLE_MAPS_ANDROID_API_KEY;
  return {
    ...config,
    android: {
      ...config.android,
      config: {
        ...(config.android && config.android.config),
        ...(key ? { googleMaps: { apiKey: key } } : {}),
      },
    },
  };
};
