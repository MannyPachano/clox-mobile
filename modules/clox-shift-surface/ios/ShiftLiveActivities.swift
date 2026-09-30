import ActivityKit
import Foundation

// Starting, updating, ending and watching the Live Activity. The app targets
// iOS 15.1 and ActivityKit's calls here need 16.2, so everything is gated;
// ActivityKit is weak-linked (CloxShiftSurface.podspec).
//
// The rules for WHICH activity to end, update or start are the app's
// JavaScript (planActivity in src/shift-surface-state.ts); this file carries
// them out and reports what ActivityKit has.

/// One Live Activity of either attribute type (see ShiftAttributes.swift).
@available(iOS 16.2, *)
struct ShiftActivityHandle {
  let id: String
  let shiftStartMs: Double
  let createdMs: Double
  let state: ActivityState
  let content: ShiftActivityContent
  let update: (ActivityContent<ShiftActivityContent>) async -> Void
  let end: (ActivityContent<ShiftActivityContent>?, ActivityUIDismissalPolicy) async -> Void

  var isLive: Bool {
    return state == .active || state == .stale
  }
}

@available(iOS 16.2, *)
enum ShiftLiveActivities {
  static func handle<A: ShiftActivityAttributes>(_ activity: Activity<A>) -> ShiftActivityHandle {
    return ShiftActivityHandle(
      id: activity.id,
      shiftStartMs: activity.attributes.shiftStartMs,
      createdMs: activity.attributes.createdMs,
      state: activity.activityState,
      content: activity.content.state,
      update: { content in await activity.update(content) },
      end: { content, policy in await activity.end(content, dismissalPolicy: policy) }
    )
  }

  /// Every Clox Live Activity ActivityKit still lists, both types, including
  /// ones that ended and still sit on the Lock Screen.
  static func all() -> [ShiftActivityHandle] {
    var list = Activity<ShiftAttributes>.activities.map { handle($0) }
    list += Activity<ShiftAttributes18>.activities.map { handle($0) }
    return list
  }

  /// ActivityInfo["state"], or nil for a state this build does not know.
  static func stateName(_ state: ActivityState) -> String? {
    switch state {
    case .active: return "active"
    case .stale: return "stale"
    case .ended: return "ended"
    case .dismissed: return "dismissed"
    @unknown default: return nil
    }
  }

  /// NativeSnapshot.activities.
  static func snapshotEntries() -> [[String: Any]] {
    return all().compactMap { h -> [String: Any]? in
      guard let name = stateName(h.state) else { return nil }
      return ["id": h.id, "shiftStartMs": h.shiftStartMs, "createdMs": h.createdMs, "state": name]
    }
  }

  static func staleDate(_ view: SurfaceActivityView) -> Date? {
    guard let ms = view.staleAtMs else { return nil }
    return ShiftSurfaceClock.date(ms)
  }

  /// Starts an activity for the running shift. On iOS 18 and later it is the
  /// type whose configuration adds the Watch, CarPlay and Mac layout.
  static func request(view: SurfaceActivityView, shiftStartMs: Double, createdMs: Double) throws -> String {
    let content = ActivityContent(state: ShiftActivityContent(view: view), staleDate: staleDate(view))
    if #available(iOS 18.0, *) {
      let activity = try Activity<ShiftAttributes18>.request(
        attributes: ShiftAttributes18(shiftStartMs: shiftStartMs, createdMs: createdMs),
        content: content,
        pushType: nil
      )
      ShiftActivityWatcher.shared.watch(activity)
      return activity.id
    }
    let activity = try Activity<ShiftAttributes>.request(
      attributes: ShiftAttributes(shiftStartMs: shiftStartMs, createdMs: createdMs),
      content: content,
      pushType: nil
    )
    ShiftActivityWatcher.shared.watch(activity)
    return activity.id
  }

  /// A tap: the running shift's activity shows the pending look at once (the
  /// timer stops at a clock-out tap, and the content goes stale two minutes
  /// later if nothing answers).
  static func showPending(state: SurfaceState, nowMs: Double) async {
    guard let view = SurfaceRules.surfaceView(state, nowMs: nowMs).activity else { return }
    let content = ActivityContent(state: ShiftActivityContent(view: view), staleDate: staleDate(view))
    for h in all() where h.isLive && SurfaceRules.sameShift(h.shiftStartMs, state.shiftStartMs) {
      await h.update(content)
    }
  }

  static func end(_ h: ShiftActivityHandle, finalText: String?, dismissAt: Date?) async {
    ShiftActivityWatcher.shared.markEndedByApp(h.id)
    ShiftSurfaceStore.shared.markRecordEnded(activityId: h.id)
    if let text = finalText {
      var policy = ActivityUIDismissalPolicy.default
      if let date = dismissAt { policy = .after(date) }
      await h.end(ActivityContent(state: h.content.ending(with: text), staleDate: nil), policy)
    } else {
      await h.end(ActivityContent(state: h.content, staleDate: nil), .immediate)
    }
  }

  static func endAll() async {
    for h in all() {
      await end(h, finalText: nil, dismissAt: nil)
    }
  }

  /// The activity part of a NativeApplyPlan: end, then update, then start.
  /// Returns the id of an activity it started, and what it could not do.
  static func apply(
    activity part: [String: Any],
    state: SurfaceState?,
    viewOverride: SurfaceActivityView?,
    allowStart: Bool,
    nowMs: Double
  ) async -> (startedId: String?, errors: [String]) {
    var errors: [String] = []
    let plan = (part["plan"] as? [String: Any]) ?? [:]
    let endNow = ((plan["endNow"] as? [Any]) ?? []).compactMap { $0 as? String }
    let updateId = SurfaceJSON.string(plan["update"])
    let start = SurfaceJSON.isTrue(plan["start"])
    let view = viewOverride ?? SurfaceActivityView.parse(part["view"])

    var finalText: String? = nil
    var dismissAt: Date? = nil
    if let card = part["finalCard"] as? [String: Any], let text = SurfaceJSON.string(card["text"]) {
      finalText = text
      if let ms = SurfaceJSON.number(card["dismissAtMs"]) { dismissAt = ShiftSurfaceClock.date(ms) }
    }

    let handles = all()
    for id in endNow {
      guard let h = handles.first(where: { $0.id == id }) else { continue }
      await end(h, finalText: finalText, dismissAt: dismissAt)
    }

    if let id = updateId {
      if let h = handles.first(where: { $0.id == id }), let view = view {
        await h.update(ActivityContent(state: ShiftActivityContent(view: view), staleDate: staleDate(view)))
        if let s = state {
          ShiftSurfaceStore.shared.updateRecordPhase(activityId: id, phase: SurfaceRules.phaseOf(s))
        }
      } else {
        errors.append("update: the activity or its content is missing")
      }
    }

    var startedId: String? = nil
    if start && allowStart {
      if #unavailable(iOS 17.0) {
        // Nothing would draw it: the widget extension needs iOS 17.
        errors.append("start: Live Activities need iOS 17 in Clox")
      } else if let view = view, let s = state, let shiftStartMs = s.shiftStartMs {
        if ActivityAuthorizationInfo().areActivitiesEnabled {
          do {
            let id = try request(view: view, shiftStartMs: shiftStartMs, createdMs: nowMs)
            ShiftSurfaceStore.shared.saveRecord(
              activityId: id,
              shiftStartMs: shiftStartMs,
              phase: SurfaceRules.phaseOf(s),
              createdMs: nowMs
            )
            startedId = id
          } catch {
            errors.append("start: \(error.localizedDescription)")
          }
        } else {
          errors.append("start: Live Activities are turned off for Clox")
        }
      } else {
        errors.append("start: there is no running shift to show")
      }
    }
    return (startedId, errors)
  }
}

/// Watches every Clox Live Activity while the app's process runs, to tell a
/// swipe from the system's own end: only active or stale straight to
/// dismissed, for an activity the app did not end, is the person swiping it
/// away. Ended then dismissed is the system clearing the Lock Screen after
/// the 8 hour end. A swipe while the app was not running is inferred later
/// from the activity record (planActivity).
@available(iOS 16.2, *)
final class ShiftActivityWatcher {
  static let shared = ShiftActivityWatcher()

  private let lock = NSLock()
  private var started = false
  private var watched = Set<String>()
  private var endedByApp = Set<String>()

  func start() {
    lock.lock()
    let first = !started
    started = true
    lock.unlock()
    guard first else { return }

    for activity in Activity<ShiftAttributes>.activities { watch(activity) }
    for activity in Activity<ShiftAttributes18>.activities { watch(activity) }
    Task {
      for await activity in Activity<ShiftAttributes>.activityUpdates { self.watch(activity) }
    }
    Task {
      for await activity in Activity<ShiftAttributes18>.activityUpdates { self.watch(activity) }
    }
  }

  func watch<A: ShiftActivityAttributes>(_ activity: Activity<A>) {
    lock.lock()
    let isNew = watched.insert(activity.id).inserted
    lock.unlock()
    guard isNew else { return }

    let id = activity.id
    let shiftStartMs = activity.attributes.shiftStartMs
    Task {
      var last = activity.activityState
      for await next in activity.activityStateUpdates {
        if next == .dismissed && (last == .active || last == .stale) && !self.wasEndedByApp(id) {
          ShiftSurfaceStore.shared.saveSwipe(
            shiftStartMs: shiftStartMs,
            contentPhase: activity.content.state.phase,
            nowMs: ShiftSurfaceClock.nowMs()
          )
        }
        last = next
      }
    }
  }

  func markEndedByApp(_ id: String) {
    lock.lock()
    endedByApp.insert(id)
    lock.unlock()
  }

  func wasEndedByApp(_ id: String) -> Bool {
    lock.lock()
    let known = endedByApp.contains(id)
    lock.unlock()
    return known || ShiftSurfaceStore.shared.recordSaysEndedByApp(activityId: id)
  }
}
