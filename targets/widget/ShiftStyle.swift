import SwiftUI
import WidgetKit

// The look of the Live Activity and the Home Screen widget, from the mockup
// (clox-marketing/app-mockups/08-phone-lock-screen.dc.html) and the app's
// dark palette (src/theme.ts). Fixed dark colors: the Lock Screen card has
// its own dark tint and the widget its own dark background, so the text
// stays readable on any wallpaper and in light mode. Numbers use the system
// monospaced font (decision 8).
enum ShiftStyle {
  static let card = hex(0x1c1c1a)
  static let cardTint = hex(0x1c1c1a).opacity(0.92)
  static let paper = hex(0xf3efe7)
  static let paperDot = hex(0xfbf8f3)
  static let muted = hex(0xd8d3c7)
  static let faint = hex(0xa3a39b)
  static let clay = hex(0xb84a2c)
  static let moss = hex(0x9fb08c)
  static let amber = hex(0xe0b15a)
  /// Clock out's fill. #fbf8f3 on it measures 5.26:1.
  static let danger = hex(0xbb3b2a)
  static let onDanger = hex(0xfbf8f3)

  static let openURL = URL(string: SurfaceContract.openURL) ?? URL(fileURLWithPath: "/")

  static func hex(_ value: UInt32) -> Color {
    return Color(
      red: Double((value >> 16) & 0xff) / 255,
      green: Double((value >> 8) & 0xff) / 255,
      blue: Double(value & 0xff) / 255
    )
  }

  static func date(_ ms: Double) -> Date {
    return Date(timeIntervalSince1970: ms / 1000)
  }

  static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
    return .system(size: size, weight: weight, design: .monospaced)
  }

  /// "ON BREAK" read aloud as "On break".
  static func sentenceCase(_ text: String) -> String {
    return text.prefix(1).uppercased() + text.dropFirst().lowercased()
  }

  /// Moss on the clock, amber on a break (the app's ON BREAK card), paper
  /// while a tap is being sent.
  static func accent(phase: String, pending: Bool) -> Color {
    if pending { return paper }
    return phase == "break" ? amber : moss
  }
}

/// The clay square with a paper dot.
struct CloxMark: View {
  let size: CGFloat

  var body: some View {
    RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
      .fill(ShiftStyle.clay)
      .frame(width: size, height: size)
      .overlay(
        Circle()
          .fill(ShiftStyle.paperDot)
          .frame(width: size * 0.3, height: size * 0.3)
      )
      .accessibilityHidden(true)
  }
}

/// A timer that ticks by itself, with no app code running: counts up from
/// the start, or stands still at `pausedAtMs` (a clock-out being sent).
struct ShiftTimerText: View {
  let startMs: Double
  let pausedAtMs: Double?
  let size: CGFloat

  var body: some View {
    let start = min(ShiftStyle.date(startMs), Date.distantFuture)
    Text(
      timerInterval: start...Date.distantFuture,
      pauseTime: pausedAtMs.map { ShiftStyle.date($0) },
      countsDown: false,
      showsHours: true
    )
    .font(ShiftStyle.mono(size))
    .monospacedDigit()
  }
}

/// "ON THE CLOCK", "ON BREAK" or "CLOCKING OUT".
struct ShiftEyebrow: View {
  let text: String
  let color: Color
  var size: CGFloat = 10

  var body: some View {
    Text(text)
      .font(ShiftStyle.mono(size, .bold))
      .tracking(size * 0.14)
      .foregroundStyle(color)
      .lineLimit(1)
      // A small widget on a small iPhone is about 110 points wide inside.
      .minimumScaleFactor(0.75)
  }
}

extension ShiftActivityContent {
  /// A tap is saved and not answered yet: the content carries the stale
  /// line and no buttons.
  var isPending: Bool {
    return finalText == nil && staleText != nil && buttons.isEmpty
  }

  var accent: Color {
    return ShiftStyle.accent(phase: phase, pending: isPending)
  }
}

extension Optional where Wrapped == String {
  /// The text, unless it is missing or empty: an empty line is not drawn.
  var nonEmpty: String? {
    guard let text = self, !text.isEmpty else { return nil }
    return text
  }
}
