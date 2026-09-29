import AppIntents
import Foundation

// This file is in _shared, so @bacons/apple-targets compiles it into BOTH
// the app and the widget extension:
//   - the widget extension needs the type to draw Button(intent:);
//   - a LiveActivityIntent runs in the app's process (Apple: "the system runs
//     the app intent in the app's process"), so the app needs it to run
//     perform(). If the app is not running, iOS launches it in the background
//     for the tap.
// Only the app's copy does anything: it hands the tap to the CloxShiftSurface
// module, which saves it and wakes the app's JavaScript. The widget
// extension cannot see that module (it has no pods), so its perform() is
// empty, and it never runs there.
#if canImport(CloxShiftSurface)
import CloxShiftSurface
#elseif canImport(ExpoModulesCore) || canImport(Expo)
// This is the app target, which must see the module. Fail the build rather
// than ship buttons that do nothing.
#error("ShiftIntents.swift: the app target cannot import CloxShiftSurface (modules/clox-shift-surface).")
#endif

/// Take break, End break and Clock out on the Live Activity, and Clock out on
/// the Home Screen widget. The widget's Clock in is a plain link that opens
/// Clox (decision 2) and never uses this intent.
///
/// The static properties are stored constants, not computed ones: Xcode
/// reads an intent's title and flags from the source at build time (App
/// Intents metadata), which needs literal values.
@available(iOS 17.0, *)
struct ShiftActionIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "Update your shift"

  /// Not offered in Shortcuts or Spotlight: it only makes sense on a button
  /// drawn for a running shift.
  static let isDiscoverable: Bool = false

  /// Decision 3: the buttons act once the phone itself is unlocked. iOS
  /// already keeps widget and Live Activity buttons inactive on a locked
  /// phone; this says so for the intent as well. It also means the app's
  /// Keychain session is readable when the tap is turned into a punch.
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

  /// "out", "break_start" or "break_end".
  @Parameter(title: "Action")
  var action: String

  /// "live_activity" or "widget".
  @Parameter(title: "Source")
  var source: String

  init() {}

  init(action: String, source: String) {
    self.action = action
    self.source = source
  }

  func perform() async throws -> some IntentResult {
    #if canImport(CloxShiftSurface)
    await CloxShiftSurfaceIntents.handleTap(action: action, source: source)
    #endif
    return .result()
  }
}
