import ActivityKit
import Foundation

// The Live Activity's ActivityKit types.
//
// Two copies of this file exist and must stay byte-identical:
//   modules/clox-shift-surface/ios/ShiftAttributes.swift  (the app starts, updates and ends)
//   targets/widget/ShiftAttributes.swift                  (the widget extension draws)
// ActivityKit matches the app's type and the extension's by name, and decodes
// the content with the extension's copy, so a change to either file without
// the other breaks the Live Activity. scripts/shift-surface-native-check.mjs
// checks that they match. The content type, ShiftActivityContent, lives in
// ShiftSurfaceModel.swift, which has the same rule.
//
// There are two attribute types with the same shape because the Watch,
// CarPlay and Mac layout (a timer and no buttons, decision 7) needs
// .supplementalActivityFamilies([.small]), which exists only on iOS 18. A
// widget extension that also runs on iOS 17 cannot apply that modifier to
// one configuration conditionally, so each type gets its own configuration:
//   ShiftAttributes     started on iOS 16.2 through 17, Lock Screen and
//                       Dynamic Island only.
//   ShiftAttributes18   started on iOS 18 and later, which adds the small
//                       layout. Its configuration is registered only there.
// The app starts one or the other and lists, updates and ends both.

@available(iOS 16.1, *)
protocol ShiftActivityAttributes: ActivityAttributes where ContentState == ShiftActivityContent {
  /// The shift anchor, epoch ms. An activity belongs to one shift.
  var shiftStartMs: Double { get }
  /// When this activity started, epoch ms. ActivityKit ends it 8 hours later.
  var createdMs: Double { get }
  init(shiftStartMs: Double, createdMs: Double)
}

@available(iOS 16.1, *)
struct ShiftAttributes: ShiftActivityAttributes {
  typealias ContentState = ShiftActivityContent
  var shiftStartMs: Double
  var createdMs: Double
}

@available(iOS 16.1, *)
struct ShiftAttributes18: ShiftActivityAttributes {
  typealias ContentState = ShiftActivityContent
  var shiftStartMs: Double
  var createdMs: Double
}
