// The Clox widget extension: the Live Activity for a running shift (Lock
// Screen, Dynamic Island, and the timer-only layout for Apple Watch, CarPlay
// and Mac) and the small Home Screen widget. @bacons/apple-targets 4.0.7
// turns this folder into the target at prebuild.
//
// - deploymentTarget 17.0: buttons in widgets and Live Activities need iOS
//   17 (App Intents). apple-targets' default is 18.0, which would leave iOS 17
//   phones without the widget.
// - The App Group comes from app.json's ios.entitlements, which is how the
//   widget reads the state the app writes. It must be listed here: 4.0.7
//   writes the widget's entitlements (generated.entitlements, at prebuild)
//   only when this config has an `entitlements` object, whatever its README
//   says about mirroring.
// - Info.plist here is complete on purpose: plugins/with-extension-versions
//   turns off Xcode's generated Info.plist so the widget ships at the app's
//   version and build number.
// - _shared/ is compiled into the app too (the buttons' intent runs in the
//   app's process).
/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: "widget",
  name: "widget",
  displayName: "Clox",
  bundleIdentifier: ".widget",
  deploymentTarget: "17.0",
  colors: {
    // Button tint while editing the widget, and the widget's background
    // before its content draws: the brand clay and the dark card surface.
    $accent: "#b84a2c",
    $widgetBackground: "#1c1c1a",
  },
  entitlements: {
    "com.apple.security.application-groups":
      config.ios.entitlements["com.apple.security.application-groups"],
  },
});
