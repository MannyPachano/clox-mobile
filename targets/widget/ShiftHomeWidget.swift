import AppIntents
import SwiftUI
import WidgetKit

// The small Home Screen widget. It reads the state the app writes to the App
// Group and never writes anything itself.
//
//   On the clock or on a break: the running timer, "Project · Task" (or a
//     refusal notice, or the start line) and one button, Clock out, which
//     runs ShiftActionIntent in the app's process.
//   A tap being sent: the timer (stopped for a clock-out) and what is
//     happening, no button.
//   Clocked out: "You're not clocked in." and Clock in. Clock in only opens
//     Clox at the Clock screen (decision 2): the Wi-Fi check, location,
//     geofence, project and selfie all run there as they do today. The widget
//     never clocks anyone in.
//   Signed out, or the feature switched off: a line that says to open Clox.
// Tapping anywhere outside the Clock out button opens the Clock screen.
//
// Decision 7 (Apple Watch, CarPlay and Mac get the timer only, no buttons):
// an iPhone widget can also be put on a Mac desktop (macOS 14 and later) and,
// from iOS 26, on CarPlay's Widgets screen, and a tap on its Clock out there
// runs on the iPhone. WidgetKit cannot keep a widget out of a place, only
// take it out of the widget gallery's suggestions there
// (disfavoredLocations: it moves to the gallery's "Other" section). So this
// widget is disfavored on a Mac and in CarPlay; someone who picks it from
// "Other" anyway still gets the button, and the intent still needs the
// iPhone unlocked (requiresAuthentication).

struct ShiftHomeWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: SurfaceContract.widgetKind, provider: ShiftTimelineProvider()) { entry in
      ShiftWidgetView(entry: entry)
    }
    .configurationDisplayName(SurfaceCopyDefaults.text("widgetNameFixed"))
    .description(SurfaceCopyDefaults.text("widgetDescriptionFixed"))
    .supportedFamilies([.systemSmall])
    .disfavoredLocations(ShiftHomeWidget.disfavored, for: [.systemSmall])
  }

  /// Where the widget is not suggested (decision 7, see above). CarPlay
  /// widgets are iOS 26 and later, and the case exists only in the iOS 26
  /// SDK, which the SDK 54 EAS image (Xcode 26) builds with.
  static var disfavored: [WidgetLocation] {
    var list: [WidgetLocation] = [.iPhoneWidgetsOnMac]
    if #available(iOS 26.0, *) {
      list.append(.carPlay)
    }
    return list
  }
}

struct ShiftWidgetEntry: TimelineEntry {
  let date: Date
  let state: SurfaceState?
}

enum ShiftSurfaceReader {
  static func readState() -> SurfaceState? {
    let text = UserDefaults(suiteName: SurfaceContract.appGroup)?.string(forKey: SurfaceContract.stateKey)
    return SurfaceState.parse(SurfaceJSON.parse(text))
  }

  /// The widget gallery's picture: a shift running for an hour and a quarter,
  /// with nobody's name or project in it.
  static func galleryState(now: Date) -> SurfaceState {
    let nowMs = now.timeIntervalSince1970 * 1000
    return SurfaceState(
      enabled: true,
      status: "on",
      ownerUserId: "gallery",
      shiftStartMs: nowMs - 75 * 60_000,
      breakStartMs: nil,
      projectId: nil,
      label: nil,
      startedAtText: nil,
      orgTimeZone: nil,
      needsProjectToClockOut: false,
      pendingTap: nil,
      notice: nil,
      copy: SurfaceCopyDefaults.values,
      updatedMs: nowMs
    )
  }
}

struct ShiftTimelineProvider: TimelineProvider {
  func placeholder(in context: Context) -> ShiftWidgetEntry {
    let now = Date()
    return ShiftWidgetEntry(date: now, state: ShiftSurfaceReader.galleryState(now: now))
  }

  func getSnapshot(in context: Context, completion: @escaping (ShiftWidgetEntry) -> Void) {
    let now = Date()
    if context.isPreview {
      completion(ShiftWidgetEntry(date: now, state: ShiftSurfaceReader.galleryState(now: now)))
    } else {
      completion(ShiftWidgetEntry(date: now, state: ShiftSurfaceReader.readState()))
    }
  }

  /// One entry for now, and one more when a pending tap goes stale, so the
  /// widget then says to open Clox. The timer needs no entries: it ticks by
  /// itself. The app reloads the timeline whenever it writes the state
  /// (never: no scheduled reloads, which would only spend the budget).
  func getTimeline(in context: Context, completion: @escaping (Timeline<ShiftWidgetEntry>) -> Void) {
    let now = Date()
    let state = ShiftSurfaceReader.readState()
    var entries = [ShiftWidgetEntry(date: now, state: state)]
    if let tap = state?.pendingTap {
      let staleAt = ShiftStyle.date(tap.tapMs + SurfaceContract.pendingStaleMs)
      if staleAt > now {
        entries.append(ShiftWidgetEntry(date: staleAt, state: state))
      }
    }
    completion(Timeline(entries: entries, policy: .never))
  }
}

struct ShiftWidgetView: View {
  let entry: ShiftWidgetEntry

  var body: some View {
    let shown = SurfaceRules.surfaceView(entry.state, nowMs: entry.date.timeIntervalSince1970 * 1000).widget
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 6) {
        CloxMark(size: 18)
        Spacer(minLength: 4)
        if let eyebrow = shown.eyebrow {
          Circle()
            .fill(accent(shown))
            .frame(width: 7, height: 7)
            .accessibilityHidden(true)
          ShiftEyebrow(text: eyebrow, color: accent(shown), size: 9)
        }
      }
      Spacer(minLength: 6)
      if let timer = shown.timer {
        ShiftTimerText(startMs: timer.startMs, pausedAtMs: timer.pausedAtMs, size: 22)
          .foregroundStyle(ShiftStyle.paper)
          .frame(maxWidth: .infinity, alignment: .leading)
        if let line = runningLine(shown) {
          Text(line)
            .font(.system(size: 11))
            .foregroundStyle(ShiftStyle.faint)
            .lineLimit(2)
        }
      } else if let line = shown.line3.nonEmpty {
        Text(line)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ShiftStyle.paper)
          .lineLimit(3)
      }
      if let button = shown.button {
        ShiftWidgetButton(button: button, tone: shown.mode == "off" ? .clay : .danger)
          .padding(.top, 8)
      }
    }
    .containerBackground(for: .widget) {
      ShiftStyle.card
    }
    .widgetURL(ShiftStyle.openURL)
  }

  private func accent(_ shown: SurfaceWidgetView) -> Color {
    return ShiftStyle.accent(phase: shown.mode == "break" ? "break" : "on", pending: shown.mode == "pending")
  }

  /// Under the timer: a refusal notice, else "Project · Task" when there is
  /// one, else the start line; while a tap is being sent, what is happening.
  /// Up to two lines: "Your shift started at 9:42 AM." does not fit one line
  /// of a small widget at 11 points.
  private func runningLine(_ shown: SurfaceWidgetView) -> String? {
    if shown.mode == "pending" { return shown.line3.nonEmpty }
    return shown.line2.nonEmpty ?? shown.line3.nonEmpty
  }
}

/// The widget's one button. Clock out runs the intent. Clock in, and a Clock
/// out that has to be finished in the app, only look like buttons: the tap
/// falls through to the widget's link, which opens the Clock screen.
struct ShiftWidgetButton: View {
  let button: SurfaceButton
  let tone: ShiftButtonTone

  var body: some View {
    if button.kind == "out" {
      Button(intent: ShiftActionIntent(action: "out", source: "widget")) {
        ShiftButtonLabel(label: button.label, tone: tone, height: 30)
      }
      .buttonStyle(.plain)
      .accessibilityLabel(Text(button.a11y))
    } else {
      ShiftButtonLabel(label: button.label, tone: tone, height: 30)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(button.a11y))
        .accessibilityAddTraits(.isButton)
    }
  }
}
