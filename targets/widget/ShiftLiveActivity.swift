import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

// The running shift's Live Activity: the Lock Screen card, the Dynamic
// Island, and (iOS 18 and later) the timer-only layout that Apple Watch,
// CarPlay and a paired Mac use. The app decides every word and number
// (ShiftActivityContent); these views only draw it. Tapping anywhere outside
// a button opens Clox at the Clock screen.

/// iOS 16.2 through 17: activities started as ShiftAttributes.
struct ShiftLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: ShiftAttributes.self) { context in
      ShiftCardView(content: context.state, isStale: context.isStale)
        .activityBackgroundTint(ShiftStyle.cardTint)
        .activitySystemActionForegroundColor(ShiftStyle.paper)
        .widgetURL(ShiftStyle.openURL)
    } dynamicIsland: { context in
      ShiftIsland.make(content: context.state, isStale: context.isStale)
    }
  }
}

/// iOS 18 and later: activities started as ShiftAttributes18. The same
/// Lock Screen card and Dynamic Island, plus the small layout for Apple
/// Watch, CarPlay and Mac, which shows the timer and no buttons (decision 7).
@available(iOS 18.0, *)
struct ShiftLiveActivity18: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: ShiftAttributes18.self) { context in
      ShiftActivityFamilyView(content: context.state, isStale: context.isStale)
        .activityBackgroundTint(ShiftStyle.cardTint)
        .activitySystemActionForegroundColor(ShiftStyle.paper)
        .widgetURL(ShiftStyle.openURL)
    } dynamicIsland: { context in
      ShiftIsland.make(content: context.state, isStale: context.isStale)
    }
    .supplementalActivityFamilies([.small])
  }
}

@available(iOS 18.0, *)
struct ShiftActivityFamilyView: View {
  @Environment(\.activityFamily) private var family
  let content: ShiftActivityContent
  let isStale: Bool

  var body: some View {
    switch family {
    case .small:
      ShiftSmallActivityView(content: content, isStale: isStale)
    default:
      ShiftCardView(content: content, isStale: isStale)
    }
  }
}

// MARK: - Lock Screen

/// The Lock Screen card: the Clox mark and the status, the timer with
/// "Project · Task" under it and "Started 9:42 AM" beside it, then Take break
/// (or End break) and Clock out. Kept under the 160 point height at which iOS
/// may cut a Live Activity off.
struct ShiftCardView: View {
  let content: ShiftActivityContent
  let isStale: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        CloxMark(size: 18)
        Text("Clox")
          .font(.system(size: 12, weight: .bold))
          .foregroundStyle(ShiftStyle.paper)
        Spacer(minLength: 8)
        if content.finalText == nil {
          ShiftEyebrow(text: content.eyebrow, color: content.accent)
        }
      }
      ShiftCardBody(content: content, isStale: isStale)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 14)
  }
}

/// The card without its header: the Lock Screen card uses it under the mark,
/// the expanded Dynamic Island under its own leading and trailing regions.
struct ShiftCardBody: View {
  let content: ShiftActivityContent
  let isStale: Bool

  var body: some View {
    if let finalText = content.finalText {
      Text(finalText)
        .font(.system(size: 16, weight: .semibold))
        .foregroundStyle(ShiftStyle.paper)
        .lineLimit(2)
        .frame(maxWidth: .infinity, alignment: .leading)
    } else {
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .bottom, spacing: 12) {
          VStack(alignment: .leading, spacing: 4) {
            ShiftTimerText(startMs: content.timerStartMs, pausedAtMs: content.timerPausedAtMs, size: 30)
              .foregroundStyle(ShiftStyle.paper)
              .frame(maxWidth: .infinity, alignment: .leading)
            if let line2 = content.line2.nonEmpty {
              Text(line2)
                .font(.system(size: 13))
                .foregroundStyle(ShiftStyle.muted)
                .lineLimit(1)
            }
          }
          if let line3 = shownLine3 {
            Text(line3)
              .font(.system(size: 12))
              .foregroundStyle(ShiftStyle.faint)
              .multilineTextAlignment(.trailing)
              .lineLimit(2)
              .frame(maxWidth: 136, alignment: .trailing)
          }
        }
        if !content.buttons.isEmpty {
          HStack(spacing: 10) {
            ForEach(content.buttons, id: \.self) { button in
              ShiftActionButton(button: button, source: "live_activity")
            }
          }
        }
      }
    }
  }

  /// A pending tap nobody answered in two minutes says to open Clox.
  private var shownLine3: String? {
    if isStale, let staleText = content.staleText.nonEmpty { return staleText }
    return content.line3.nonEmpty
  }
}

/// A Live Activity button. Take break, End break and Clock out run
/// ShiftActionIntent in the app's process. A Clock out that has to be
/// finished in the app (the org needs a project and the shift has none, or
/// the last clock-out was refused) is a plain link to the Clock screen.
struct ShiftActionButton: View {
  let button: ShiftActivityButton
  let source: String

  var body: some View {
    if button.kind == "open" {
      Link(destination: ShiftStyle.openURL) {
        ShiftButtonLabel(label: button.label, tone: .danger, height: 34)
      }
      .accessibilityLabel(Text(button.a11y))
    } else {
      Button(intent: ShiftActionIntent(action: button.kind, source: source)) {
        ShiftButtonLabel(label: button.label, tone: button.kind == "out" ? .danger : .quiet, height: 34)
      }
      .buttonStyle(.plain)
      .accessibilityLabel(Text(button.a11y))
    }
  }
}

/// How a button reads: Clock out is the danger fill (as in the app), Clock in
/// the brand clay, a break button the quiet outlined one.
enum ShiftButtonTone {
  case danger
  case clay
  case quiet
}

struct ShiftButtonLabel: View {
  let label: String
  let tone: ShiftButtonTone
  let height: CGFloat

  var body: some View {
    Text(label)
      .font(.system(size: 14, weight: .semibold))
      .foregroundStyle(tone == .quiet ? ShiftStyle.paper : ShiftStyle.onDanger)
      .lineLimit(1)
      .frame(maxWidth: .infinity, minHeight: height)
      .background(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(fill)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(tone == .quiet ? ShiftStyle.paper.opacity(0.22) : Color.clear, lineWidth: 1)
      )
  }

  private var fill: Color {
    switch tone {
    case .danger: return ShiftStyle.danger
    case .clay: return ShiftStyle.clay
    case .quiet: return ShiftStyle.paper.opacity(0.1)
    }
  }
}

// MARK: - Apple Watch, CarPlay and Mac

/// The small layout: the status and the timer. No buttons, on purpose
/// (decision 7): a Clock out should not be one tap away on a watch face, a
/// car's screen or a Mac's menu bar. Tapping it opens Clox where the system
/// allows.
struct ShiftSmallActivityView: View {
  let content: ShiftActivityContent
  let isStale: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 6) {
        Circle()
          .fill(content.accent)
          .frame(width: 8, height: 8)
          .accessibilityHidden(true)
        if content.finalText == nil {
          ShiftEyebrow(text: content.eyebrow, color: content.accent, size: 9)
        } else {
          Text("Clox")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(ShiftStyle.paper)
        }
      }
      if let finalText = content.finalText {
        Text(finalText)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ShiftStyle.paper)
          .lineLimit(2)
      } else {
        ShiftTimerText(startMs: content.timerStartMs, pausedAtMs: content.timerPausedAtMs, size: 22)
          .foregroundStyle(ShiftStyle.paper)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
  }
}

// MARK: - Dynamic Island

enum ShiftIsland {
  /// Compact: the status dot and "Clox", then the timer. Minimal: the dot.
  /// Expanded: the Lock Screen card. Only the expanded view has buttons.
  static func make(content: ShiftActivityContent, isStale: Bool) -> DynamicIsland {
    DynamicIsland {
      DynamicIslandExpandedRegion(.leading) {
        HStack(spacing: 6) {
          CloxMark(size: 18)
          Text("Clox")
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(ShiftStyle.paper)
        }
        .padding(.leading, 4)
      }
      DynamicIslandExpandedRegion(.trailing) {
        if content.finalText == nil {
          ShiftEyebrow(text: content.eyebrow, color: content.accent)
            .padding(.trailing, 4)
        }
      }
      DynamicIslandExpandedRegion(.bottom) {
        ShiftCardBody(content: content, isStale: isStale)
          .padding(.horizontal, 4)
      }
    } compactLeading: {
      HStack(spacing: 5) {
        Circle()
          .fill(content.accent)
          .frame(width: 8, height: 8)
          .accessibilityHidden(true)
        Text("Clox")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(ShiftStyle.paper)
      }
    } compactTrailing: {
      // A timer is as wide as it can be in a widget, so it gets a fixed width
      // that fits 10:00:00.
      ShiftTimerText(startMs: content.timerStartMs, pausedAtMs: content.timerPausedAtMs, size: 13)
        .foregroundStyle(ShiftStyle.paper)
        .multilineTextAlignment(.trailing)
        .frame(width: 64, alignment: .trailing)
    } minimal: {
      Circle()
        .fill(content.accent)
        .frame(width: 10, height: 10)
        .accessibilityLabel(Text(ShiftStyle.sentenceCase(content.eyebrow)))
    }
    .widgetURL(ShiftStyle.openURL)
    .keylineTint(content.accent)
  }
}
