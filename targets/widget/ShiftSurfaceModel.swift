import Foundation

// The running shift outside the app, in Swift: the contract with the app's
// JavaScript and the rules for what the Live Activity and the Home Screen
// widget show. This mirrors src/shift-surface-state.ts, which is the spec.
//
// Two copies of this file exist and must stay byte-identical:
//   modules/clox-shift-surface/ios/ShiftSurfaceModel.swift  (the app: taps)
//   targets/widget/ShiftSurfaceModel.swift                  (the widget: drawing)
// scripts/shift-surface-native-check.mjs checks that they match, that the
// constants and copy match the TypeScript, and (with swiftc) that these rules
// give the same answers as the TypeScript for the same states.
//
// Foundation only, so the check can compile it on a Mac without the iOS SDK.
// Swift 5.8 syntax: no if or switch expressions, no macros.

// MARK: - Contract

enum SurfaceContract {
  /// SURFACE_SCHEMA_VERSION. A blob with any other `v` is ignored.
  static let schemaVersion = 1
  static let appGroup = "group.com.getclox.clock"
  static let stateKey = "clox.surface.state"
  static let inboxKey = "clox.surface.inbox"
  static let dismissalKey = "clox.surface.dismissal"
  static let activityKey = "clox.surface.activity"
  /// Opens the Clock screen and does nothing else.
  static let openURL = "clox://clock"
  /// The Home Screen widget's kind. The app reloads it after every write.
  static let widgetKind = "CloxShiftWidget"
  /// PENDING_STALE_MS: a pending tap with no answer this long shows "Open Clox
  /// to send it".
  static let pendingStaleMs: Double = 120_000
  /// SAME_SHIFT_TOLERANCE_MS.
  static let sameShiftToleranceMs: Double = 120_000
  /// How long a button's intent waits for the app's JavaScript to queue and
  /// send the tap before it returns.
  static let tapWaitMs: Double = 20_000
  static let tapKinds = ["out", "break_start", "break_end"]
  static let sources = ["live_activity", "widget", "notification"]
}

/// SURFACE_COPY. The state carries its own copy (so an EAS Update can fix
/// wording); these fill any key it lacks, and are all the widget has before
/// the app has written a state.
enum SurfaceCopyDefaults {
  static let values: [String: String] = [
    "onEyebrow": "ON THE CLOCK",
    "breakEyebrow": "ON BREAK",
    "clockingOutEyebrow": "CLOCKING OUT",
    "started": "Started {time}",
    "breakShiftSince": "Your shift started at {time}.",
    "takeBreak": "Take break",
    "endBreak": "End break",
    "clockOut": "Clock out",
    "clockIn": "Clock in",
    "takeBreakA11y": "Take a break.",
    "endBreakA11y": "End your break.",
    "clockOutA11y": "Clock out.",
    "clockOutOpensA11y": "Clock out. Opens Clox so you can finish it there.",
    "clockInA11y": "Clock in. Opens Clox.",
    "notClockedIn": "You're not clocked in.",
    "openToSignIn": "Open Clox to sign in.",
    "openToSee": "Open Clox to see your shift.",
    "pendingOut": "Sending your clock-out.",
    "pendingBreakStart": "Starting your break.",
    "pendingBreakEnd": "Ending your break.",
    "stale": "Open Clox to send it.",
    "clockedOutAt": "Clocked out at {time}.",
    "clockedOut": "You're clocked out.",
    "savedOffline": "Saved on this phone. It sends when you're online.",
    "refusedOut": "Clock-out didn't go through. Open Clox.",
    "refusedBreakStart": "Your break didn't start. Open Clox.",
    "refusedBreakEnd": "Your break didn't end. Open Clox.",
    "notificationOnTitle": "On the clock",
    "notificationBreakTitle": "On break",
    "notificationClockingOutTitle": "Clocking out",
    "widgetNameFixed": "Clox",
    "widgetDescriptionFixed": "See your running shift and clock out from here.",
    "channelNameFixed": "Running shift",
    "channelDescriptionFixed": "Shows your running shift and its timer while you're on the clock.",
  ]

  static func text(_ key: String) -> String {
    return values[key] ?? ""
  }
}

// MARK: - JSON helpers (the rules of the TypeScript parsers)

enum SurfaceJSON {
  static func isBool(_ x: Any?) -> Bool {
    guard let n = x as? NSNumber else { return false }
    return CFGetTypeID(n) == CFBooleanGetTypeID()
  }

  /// typeof x === "number" && Number.isFinite(x)
  static func number(_ x: Any?) -> Double? {
    guard let n = x as? NSNumber, !isBool(n) else { return nil }
    let d = n.doubleValue
    return d.isFinite ? d : nil
  }

  /// strOrNull: a non-empty string, or nil.
  static func string(_ x: Any?) -> String? {
    guard let s = x as? String, !s.isEmpty else { return nil }
    return s
  }

  /// x === true
  static func isTrue(_ x: Any?) -> Bool {
    guard isBool(x), let n = x as? NSNumber else { return false }
    return n.boolValue
  }

  static func parse(_ text: String?) -> Any? {
    guard let text = text, !text.isEmpty, let data = text.data(using: .utf8) else { return nil }
    return try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
  }

  static func stringify(_ object: Any) -> String? {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object, options: [])
    else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func orNull(_ x: Any?) -> Any {
    if let x = x { return x }
    return NSNull()
  }
}

// MARK: - The state (SurfaceStateV1)

struct SurfacePendingTap: Equatable {
  var id: String
  var kind: String
  var tapMs: Double
}

struct SurfaceNotice: Equatable {
  var kind: String
  var text: String
}

struct SurfaceState {
  var enabled: Bool
  /// "off", "on", "break" or "signed_out".
  var status: String
  var ownerUserId: String?
  var shiftStartMs: Double?
  var breakStartMs: Double?
  var projectId: String?
  var label: String?
  var startedAtText: String?
  var orgTimeZone: String?
  var needsProjectToClockOut: Bool
  var pendingTap: SurfacePendingTap?
  var notice: SurfaceNotice?
  var copy: [String: String]
  var updatedMs: Double

  func text(_ key: String) -> String {
    return copy[key] ?? SurfaceCopyDefaults.text(key)
  }

  /// parseState: nil for anything that is not a v1 state.
  static func parse(_ raw: Any?) -> SurfaceState? {
    guard let o = raw as? [String: Any],
          SurfaceJSON.number(o["v"]) == Double(SurfaceContract.schemaVersion),
          let status = o["status"] as? String,
          ["off", "on", "break", "signed_out"].contains(status)
    else { return nil }

    var copy = SurfaceCopyDefaults.values
    if let c = o["copy"] as? [String: Any] {
      for key in SurfaceCopyDefaults.values.keys {
        if let value = SurfaceJSON.string(c[key]) { copy[key] = value }
      }
    }

    var pendingTap: SurfacePendingTap? = nil
    if let pt = o["pendingTap"] as? [String: Any],
       let id = pt["id"] as? String,
       let kind = pt["kind"] as? String,
       SurfaceContract.tapKinds.contains(kind),
       let tapMs = SurfaceJSON.number(pt["tapMs"]) {
      pendingTap = SurfacePendingTap(id: id.lowercased(), kind: kind, tapMs: tapMs)
    }

    var notice: SurfaceNotice? = nil
    if let nt = o["notice"] as? [String: Any],
       let kind = nt["kind"] as? String,
       SurfaceContract.tapKinds.contains(kind),
       let text = nt["text"] as? String {
      notice = SurfaceNotice(kind: kind, text: text)
    }

    return SurfaceState(
      enabled: SurfaceJSON.isTrue(o["enabled"]),
      status: status,
      ownerUserId: SurfaceJSON.string(o["ownerUserId"]),
      shiftStartMs: SurfaceJSON.number(o["shiftStartMs"]),
      breakStartMs: SurfaceJSON.number(o["breakStartMs"]),
      projectId: SurfaceJSON.string(o["projectId"]),
      label: SurfaceJSON.string(o["label"]),
      startedAtText: SurfaceJSON.string(o["startedAtText"]),
      orgTimeZone: SurfaceJSON.string(o["orgTimeZone"]),
      needsProjectToClockOut: SurfaceJSON.isTrue(o["needsProjectToClockOut"]),
      pendingTap: pendingTap,
      notice: notice,
      copy: copy,
      updatedMs: SurfaceJSON.number(o["updatedMs"]) ?? 0
    )
  }

  func json() -> [String: Any] {
    var pt: Any = NSNull()
    if let tap = pendingTap { pt = ["id": tap.id, "kind": tap.kind, "tapMs": tap.tapMs] as [String: Any] }
    var nt: Any = NSNull()
    if let n = notice { nt = ["kind": n.kind, "text": n.text] }
    return [
      "v": SurfaceContract.schemaVersion,
      "enabled": enabled,
      "status": status,
      "ownerUserId": SurfaceJSON.orNull(ownerUserId),
      "shiftStartMs": SurfaceJSON.orNull(shiftStartMs),
      "breakStartMs": SurfaceJSON.orNull(breakStartMs),
      "projectId": SurfaceJSON.orNull(projectId),
      "label": SurfaceJSON.orNull(label),
      "startedAtText": SurfaceJSON.orNull(startedAtText),
      "orgTimeZone": SurfaceJSON.orNull(orgTimeZone),
      "needsProjectToClockOut": needsProjectToClockOut,
      "pendingTap": pt,
      "notice": nt,
      "copy": copy,
      "updatedMs": updatedMs,
    ]
  }
}

// MARK: - What each surface shows

struct SurfaceTimer: Equatable {
  var startMs: Double
  /// Stopped at this time (a pending clock-out), or nil to keep running.
  var pausedAtMs: Double?

  func json() -> [String: Any] {
    return ["startMs": startMs, "pausedAtMs": SurfaceJSON.orNull(pausedAtMs)]
  }
}

struct SurfaceButton: Equatable {
  /// "out", "break_start" or "break_end" run the intent; "open" only opens
  /// SurfaceContract.openURL.
  var kind: String
  var label: String
  var a11y: String

  func json() -> [String: Any] {
    return ["kind": kind, "label": label, "a11y": a11y]
  }
}

/// LiveActivityView with show: true.
struct SurfaceActivityView: Equatable {
  var phase: String
  var eyebrow: String
  var timer: SurfaceTimer
  var line2: String?
  var line3: String?
  var buttons: [SurfaceButton]
  var staleAtMs: Double?
  var staleText: String?

  func json() -> [String: Any] {
    return [
      "show": true,
      "phase": phase,
      "eyebrow": eyebrow,
      "timer": timer.json(),
      "line2": SurfaceJSON.orNull(line2),
      "line3": SurfaceJSON.orNull(line3),
      "buttons": buttons.map { $0.json() },
      "staleAtMs": SurfaceJSON.orNull(staleAtMs),
      "staleText": SurfaceJSON.orNull(staleText),
    ]
  }

  /// The `view` of a NativeApplyPlan (surfaceView(state).activity), or nil
  /// for { show: false } and anything unreadable.
  static func parse(_ raw: Any?) -> SurfaceActivityView? {
    guard let o = raw as? [String: Any],
          SurfaceJSON.isTrue(o["show"]),
          let phase = o["phase"] as? String,
          phase == "on" || phase == "break",
          let eyebrow = o["eyebrow"] as? String,
          let t = o["timer"] as? [String: Any],
          let startMs = SurfaceJSON.number(t["startMs"])
    else { return nil }
    var buttons: [SurfaceButton] = []
    if let list = o["buttons"] as? [Any] {
      for item in list {
        guard let b = item as? [String: Any],
              let kind = b["kind"] as? String,
              kind == "open" || SurfaceContract.tapKinds.contains(kind),
              let label = SurfaceJSON.string(b["label"])
        else { continue }
        buttons.append(SurfaceButton(kind: kind, label: label, a11y: SurfaceJSON.string(b["a11y"]) ?? label))
      }
    }
    return SurfaceActivityView(
      phase: phase,
      eyebrow: eyebrow,
      timer: SurfaceTimer(startMs: startMs, pausedAtMs: SurfaceJSON.number(t["pausedAtMs"])),
      line2: o["line2"] as? String,
      line3: o["line3"] as? String,
      buttons: buttons,
      staleAtMs: SurfaceJSON.number(o["staleAtMs"]),
      staleText: o["staleText"] as? String
    )
  }
}

/// WidgetView. mode is "on", "break", "pending", "off", "signed_out" or
/// "disabled".
struct SurfaceWidgetView: Equatable {
  var mode: String
  var eyebrow: String?
  var timer: SurfaceTimer?
  var line2: String?
  var line3: String?
  /// In the "off" mode this is Clock in, which only opens the app.
  var button: SurfaceButton?
  var openUrl: String

  func json() -> [String: Any] {
    var t: Any = NSNull()
    if let timer = timer { t = timer.json() }
    var b: Any = NSNull()
    if let button = button { b = button.json() }
    return [
      "mode": mode,
      "eyebrow": SurfaceJSON.orNull(eyebrow),
      "timer": t,
      "line2": SurfaceJSON.orNull(line2),
      "line3": SurfaceJSON.orNull(line3),
      "button": b,
      "openUrl": openUrl,
    ]
  }
}

struct SurfaceViews {
  /// nil is { show: false }.
  var activity: SurfaceActivityView?
  var widget: SurfaceWidgetView
}

// MARK: - The Live Activity's content (ActivityKit ContentState)

struct ShiftActivityButton: Codable, Hashable {
  var kind: String
  var label: String
  var a11y: String
}

/// What the Live Activity draws. ShiftAttributes.ContentState. Keep it small:
/// ActivityKit's limit is 4 KB for the attributes and the content together.
struct ShiftActivityContent: Codable, Hashable {
  /// "on" or "break".
  var phase: String
  var eyebrow: String
  var timerStartMs: Double
  var timerPausedAtMs: Double?
  var line2: String?
  var line3: String?
  var buttons: [ShiftActivityButton]
  /// Shown in place of line3 once the content is stale (a pending tap nobody
  /// answered).
  var staleText: String?
  /// Set only on the content an activity ends with: the card then shows this
  /// line and nothing else ("Clocked out at 5:02 PM.").
  var finalText: String?

  init(view: SurfaceActivityView) {
    phase = view.phase
    eyebrow = view.eyebrow
    timerStartMs = view.timer.startMs
    timerPausedAtMs = view.timer.pausedAtMs
    line2 = view.line2
    line3 = view.line3
    buttons = view.buttons.map { ShiftActivityButton(kind: $0.kind, label: $0.label, a11y: $0.a11y) }
    staleText = view.staleText
    finalText = nil
  }

  /// The same card with only a final line, no timer and no buttons.
  func ending(with text: String) -> ShiftActivityContent {
    var copy = self
    copy.buttons = []
    copy.staleText = nil
    copy.finalText = text
    return copy
  }
}

// MARK: - The rules (mirrors of the TypeScript functions of the same names)

enum SurfaceRules {
  static func fillTime(_ template: String, _ time: String?) -> String? {
    if !template.contains("{time}") { return template }
    guard let time = time else { return nil }
    return template.replacingOccurrences(of: "{time}", with: time)
  }

  static func sameShift(_ a: Double?, _ b: Double?) -> Bool {
    guard let a = a, let b = b else { return false }
    return abs(a - b) <= SurfaceContract.sameShiftToleranceMs
  }

  static func isShiftShown(_ state: SurfaceState?) -> Bool {
    guard let s = state else { return false }
    return s.enabled && s.ownerUserId != nil && (s.status == "on" || s.status == "break") && s.shiftStartMs != nil
  }

  static func phaseOf(_ state: SurfaceState) -> String {
    return state.status == "break" ? "break" : "on"
  }

  static func surfaceView(_ state: SurfaceState?, nowMs: Double) -> SurfaceViews {
    let open = SurfaceContract.openURL
    guard let state = state else {
      return SurfaceViews(
        activity: nil,
        widget: SurfaceWidgetView(mode: "signed_out", eyebrow: nil, timer: nil, line2: nil,
                                  line3: SurfaceCopyDefaults.text("openToSignIn"), button: nil, openUrl: open)
      )
    }
    if !state.enabled {
      return SurfaceViews(
        activity: nil,
        widget: SurfaceWidgetView(mode: "disabled", eyebrow: nil, timer: nil, line2: nil,
                                  line3: state.text("openToSee"), button: nil, openUrl: open)
      )
    }
    if state.status == "signed_out" || state.ownerUserId == nil {
      return SurfaceViews(
        activity: nil,
        widget: SurfaceWidgetView(mode: "signed_out", eyebrow: nil, timer: nil, line2: nil,
                                  line3: state.text("openToSignIn"), button: nil, openUrl: open)
      )
    }
    guard isShiftShown(state), let shiftStart = state.shiftStartMs else {
      return SurfaceViews(
        activity: nil,
        widget: SurfaceWidgetView(
          mode: "off", eyebrow: nil, timer: nil, line2: nil, line3: state.text("notClockedIn"),
          button: SurfaceButton(kind: "open", label: state.text("clockIn"), a11y: state.text("clockInA11y")),
          openUrl: open
        )
      )
    }

    let onBreak = state.status == "break"
    let breakStart = onBreak ? (state.breakStartMs ?? shiftStart) : shiftStart
    let startedLine = onBreak
      ? fillTime(state.text("breakShiftSince"), state.startedAtText)
      : fillTime(state.text("started"), state.startedAtText)

    if let tap = state.pendingTap {
      let staleAtMs = tap.tapMs + SurfaceContract.pendingStaleMs
      let stale = nowMs >= staleAtMs
      var phase = "on"
      var eyebrow = state.text("onEyebrow")
      var timer = SurfaceTimer(startMs: shiftStart, pausedAtMs: nil)
      var pendingLine = state.text("pendingBreakEnd")
      if tap.kind == "out" {
        phase = onBreak ? "break" : "on"
        eyebrow = state.text("clockingOutEyebrow")
        // The whole shift, stopped at the tap: what the clock-out records.
        timer = SurfaceTimer(startMs: shiftStart, pausedAtMs: tap.tapMs)
        pendingLine = state.text("pendingOut")
      } else if tap.kind == "break_start" {
        phase = "break"
        eyebrow = state.text("breakEyebrow")
        timer = SurfaceTimer(startMs: tap.tapMs, pausedAtMs: nil)
        pendingLine = state.text("pendingBreakStart")
      }
      let line3 = stale ? state.text("stale") : pendingLine
      return SurfaceViews(
        activity: SurfaceActivityView(
          phase: phase, eyebrow: eyebrow, timer: timer, line2: state.label, line3: line3,
          buttons: [], staleAtMs: staleAtMs, staleText: state.text("stale")
        ),
        widget: SurfaceWidgetView(
          mode: "pending", eyebrow: eyebrow, timer: timer, line2: state.label, line3: line3,
          button: nil, openUrl: open
        )
      )
    }

    let clockOutOpens = state.needsProjectToClockOut || state.notice?.kind == "out"
    let clockOut = clockOutOpens
      ? SurfaceButton(kind: "open", label: state.text("clockOut"), a11y: state.text("clockOutOpensA11y"))
      : SurfaceButton(kind: "out", label: state.text("clockOut"), a11y: state.text("clockOutA11y"))
    let breakButton = onBreak
      ? SurfaceButton(kind: "break_end", label: state.text("endBreak"), a11y: state.text("endBreakA11y"))
      : SurfaceButton(kind: "break_start", label: state.text("takeBreak"), a11y: state.text("takeBreakA11y"))
    let timer = SurfaceTimer(startMs: onBreak ? breakStart : shiftStart, pausedAtMs: nil)
    let eyebrow = onBreak ? state.text("breakEyebrow") : state.text("onEyebrow")
    let line3: String? = state.notice?.text ?? startedLine

    return SurfaceViews(
      activity: SurfaceActivityView(
        phase: onBreak ? "break" : "on", eyebrow: eyebrow, timer: timer, line2: state.label, line3: line3,
        buttons: [breakButton, clockOut], staleAtMs: nil, staleText: nil
      ),
      // The small widget has room for one line of copy under its timer (it
      // may wrap to two), so a refusal notice takes the label's place there.
      widget: SurfaceWidgetView(
        mode: onBreak ? "break" : "on", eyebrow: eyebrow, timer: timer, line2: state.notice?.text ?? state.label,
        line3: line3,
        // The small widget has room for one button.
        button: clockOut, openUrl: open
      )
    )
  }

  /// Whether a tap of `kind` may be saved right now. This is what stops a
  /// double tap, a tap on a surface left over from another account, and any
  /// tap while the remote off switch is off.
  static func tapApplies(_ state: SurfaceState?, kind: String) -> Bool {
    guard let s = state, isShiftShown(s), s.pendingTap == nil else { return false }
    if kind == "break_start" { return s.status == "on" }
    if kind == "break_end" { return s.status == "break" }
    if kind == "out" { return !s.needsProjectToClockOut && s.notice?.kind != "out" }
    return false
  }

  /// applyTap, on the stored state as written, so every key it carries is kept.
  static func applyTap(raw: [String: Any], id: String, kind: String, tapMs: Double, nowMs: Double) -> [String: Any] {
    var next = raw
    next["pendingTap"] = ["id": id, "kind": kind, "tapMs": tapMs] as [String: Any]
    next["notice"] = NSNull()
    next["updatedMs"] = nowMs
    return next
  }
}
