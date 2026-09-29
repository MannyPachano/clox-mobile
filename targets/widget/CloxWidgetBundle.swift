import SwiftUI
import WidgetKit

// Everything this extension draws. The iOS 18 Live Activity is added only
// on iOS 18 and later; on iOS 17 the app starts ShiftAttributes activities,
// which ShiftLiveActivity draws (see ShiftAttributes.swift for why there are
// two). `if #available` with no `else` is the form a WidgetBundle allows.
@main
struct CloxWidgetBundle: WidgetBundle {
  var body: some Widget {
    ShiftHomeWidget()
    ShiftLiveActivity()
    if #available(iOS 18.0, *) {
      ShiftLiveActivity18()
    }
  }
}
