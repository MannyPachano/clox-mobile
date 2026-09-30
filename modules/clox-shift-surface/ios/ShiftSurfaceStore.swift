import Foundation
import WidgetKit

// The App Group store, the tap path and the wait for the app's JavaScript.
//
// Only this module writes the shared keys (see SurfaceContract). The widget
// extension only reads the state. Nothing here calls the server or touches a
// token: a tap is saved, then the app's JavaScript turns it into the same
// queued punch the Clock screen makes (src/queue.ts is the one punch path).

final class ShiftSurfaceStore {
  static let shared = ShiftSurfaceStore()

  private let lock = NSLock()
  private let defaults: UserDefaults?

  private init() {
    defaults = UserDefaults(suiteName: SurfaceContract.appGroup)
  }

  /// Runs `body` with the store locked. Every read-modify-write of a key
  /// happens inside one call, so a tap and an apply() never interleave. The
  /// lock is not recursive: nothing called inside `body` may lock again.
  @discardableResult
  func locked<T>(_ body: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try body()
  }

  // The primitives below expect the caller to hold the lock when it reads a
  // key and then writes it back.

  func readText(_ key: String) -> String? {
    return defaults?.string(forKey: key)
  }

  func readObject(_ key: String) -> Any? {
    return SurfaceJSON.parse(readText(key))
  }

  /// Writes one JSON value under `key`, or removes the key for nil or null.
  @discardableResult
  func write(_ key: String, _ object: Any?) -> Bool {
    guard let defaults = defaults else { return false }
    guard let object = object, !(object is NSNull) else {
      defaults.removeObject(forKey: key)
      return true
    }
    guard let text = SurfaceJSON.stringify(object) else { return false }
    defaults.set(text, forKey: key)
    return true
  }

  // MARK: The tap inbox

  func inboxText() -> String {
    return locked { () -> String in
      guard let text = readText(SurfaceContract.inboxKey), readObject(SurfaceContract.inboxKey) is [Any] else {
        return "[]"
      }
      return text
    }
  }

  func inboxIds() -> [String] {
    let list = (readObject(SurfaceContract.inboxKey) as? [Any]) ?? []
    return list.compactMap { item in
      guard let o = item as? [String: Any], let id = o["id"] as? String else { return nil }
      return id.lowercased()
    }
  }

  /// The id of the newest saved tap, to nudge JavaScript that starts
  /// listening after the tap was saved.
  func newestTapId() -> String? {
    return locked { () -> String? in inboxIds().last }
  }

  /// Removes these taps (queued, or dropped for good). An entry without an
  /// id can never be queued or acked, so it goes too.
  func ackTaps(_ ids: [String]) {
    let gone = Set(ids.map { $0.lowercased() })
    locked {
      let list = (readObject(SurfaceContract.inboxKey) as? [Any]) ?? []
      let kept = list.filter { item in
        guard let o = item as? [String: Any], let id = o["id"] as? String else { return false }
        return !gone.contains(id.lowercased())
      }
      if kept.isEmpty {
        write(SurfaceContract.inboxKey, nil)
      } else {
        write(SurfaceContract.inboxKey, kept)
      }
    }
  }

  // MARK: The activity record and the dismissal

  /// ActivityRecordV1 for an activity this module just started.
  func saveRecord(activityId: String, shiftStartMs: Double, phase: String, createdMs: Double) {
    let record: [String: Any] = [
      "v": SurfaceContract.schemaVersion,
      "activityId": activityId,
      "shiftStartMs": shiftStartMs,
      "phase": phase,
      "createdMs": createdMs,
      "endedByApp": false,
    ]
    locked { write(SurfaceContract.activityKey, record) }
  }

  /// Keeps the record's phase current (the state's phase, which is what
  /// planActivity compares it with).
  func updateRecordPhase(activityId: String, phase: String) {
    locked {
      guard var record = readObject(SurfaceContract.activityKey) as? [String: Any],
            record["activityId"] as? String == activityId
      else { return }
      record["phase"] = phase
      write(SurfaceContract.activityKey, record)
    }
  }

  func markRecordEnded(activityId: String) {
    locked {
      guard var record = readObject(SurfaceContract.activityKey) as? [String: Any],
            record["activityId"] as? String == activityId
      else { return }
      record["endedByApp"] = true
      write(SurfaceContract.activityKey, record)
    }
  }

  func recordSaysEndedByApp(activityId: String) -> Bool {
    return locked { () -> Bool in
      guard let record = readObject(SurfaceContract.activityKey) as? [String: Any],
            record["activityId"] as? String == activityId
      else { return false }
      return SurfaceJSON.isTrue(record["endedByApp"])
    }
  }

  /// The person swiped the Live Activity away: it stays away for this shift
  /// and phase (SurfaceDismissalV1).
  func saveSwipe(shiftStartMs: Double, contentPhase: String, nowMs: Double) {
    locked {
      var phase = contentPhase
      if let state = SurfaceState.parse(readObject(SurfaceContract.stateKey)),
         SurfaceRules.sameShift(state.shiftStartMs, shiftStartMs) {
        phase = SurfaceRules.phaseOf(state)
      }
      let dismissal: [String: Any] = [
        "v": SurfaceContract.schemaVersion,
        "surface": "live_activity",
        "shiftStartMs": shiftStartMs,
        "phase": phase,
        "atMs": nowMs,
      ]
      write(SurfaceContract.dismissalKey, dismissal)
    }
  }

  /// Sign-out, account deletion, re-auth and account switch.
  func clearAllKeys() {
    locked {
      write(SurfaceContract.stateKey, nil)
      write(SurfaceContract.inboxKey, nil)
      write(SurfaceContract.dismissalKey, nil)
      write(SurfaceContract.activityKey, nil)
    }
  }
}

enum ShiftSurfaceClock {
  /// Epoch ms, whole, like Date.now() in JavaScript.
  static func nowMs() -> Double {
    return (Date().timeIntervalSince1970 * 1000).rounded()
  }

  static func date(_ ms: Double) -> Date {
    return Date(timeIntervalSince1970: ms / 1000)
  }
}

enum ShiftSurfaceWidgets {
  static func reload() {
    WidgetCenter.shared.reloadTimelines(ofKind: SurfaceContract.widgetKind)
  }
}

// MARK: - A tap

struct RecordedTap {
  let id: String
  /// The state right after the tap: pending.
  let state: SurfaceState
}

enum ShiftTaps {
  /// Steps 1 to 3 of a tap (shift-surface-state.ts, "What native does at a
  /// tap"): check the state, save the tap to the inbox, and mark the state
  /// pending. Nil when the tap does not apply (a double tap, a stale surface,
  /// the off switch) or nothing could be saved.
  static func record(kind: String, source: String, nowMs: Double) -> RecordedTap? {
    let store = ShiftSurfaceStore.shared
    return store.locked { () -> RecordedTap? in
      guard let raw = store.readObject(SurfaceContract.stateKey) as? [String: Any],
            let state = SurfaceState.parse(raw),
            SurfaceRules.tapApplies(state, kind: kind),
            let owner = state.ownerUserId
      else { return nil }

      let id = UUID().uuidString.lowercased()
      let tap: [String: Any] = [
        "v": SurfaceContract.schemaVersion,
        "id": id,
        "kind": kind,
        "tapMs": nowMs,
        "userId": owner,
        "projectId": SurfaceJSON.orNull(state.projectId),
        "source": source,
      ]
      var inbox = (store.readObject(SurfaceContract.inboxKey) as? [Any]) ?? []
      inbox.append(tap)
      guard store.write(SurfaceContract.inboxKey, inbox) else { return nil }

      let nextRaw = SurfaceRules.applyTap(raw: raw, id: id, kind: kind, tapMs: nowMs, nowMs: nowMs)
      store.write(SurfaceContract.stateKey, nextRaw)
      guard let next = SurfaceState.parse(nextRaw) else { return nil }
      return RecordedTap(id: id, state: next)
    }
  }
}

/// JavaScript reports each tap twice through signalTap(id, stage): "queued"
/// once the punch is in the queue, "done" once the drain that sends it has
/// finished. A button's intent waits for "done" before it returns, because
/// iOS may suspend the app as soon as perform() returns.
final class TapSignals {
  static let shared = TapSignals()

  private let lock = NSLock()
  private var stages: [String: String] = [:]

  func signal(id: String, stage: String) {
    lock.lock()
    defer { lock.unlock() }
    let key = id.lowercased()
    if stages[key] == "done" { return }
    // Signals for taps no intent is waiting on (a tap saved before the app
    // restarted) are never collected, so the list is kept short.
    if stages.count >= 64 && stages[key] == nil { stages.removeAll() }
    stages[key] = stage
  }

  func isDone(_ id: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return stages[id.lowercased()] == "done"
  }

  func forget(_ id: String) {
    lock.lock()
    defer { lock.unlock() }
    stages.removeValue(forKey: id.lowercased())
  }

  func clear() {
    lock.lock()
    defer { lock.unlock() }
    stages.removeAll()
  }

  func waitUntilDone(id: String, timeoutMs: Double) async {
    let deadline = Date().addingTimeInterval(timeoutMs / 1000)
    while !isDone(id) && Date() < deadline {
      try? await Task.sleep(nanoseconds: 250_000_000)
    }
    forget(id)
  }
}

/// The entry point for the Live Activity and widget buttons. ShiftActionIntent
/// (targets/widget/_shared/ShiftIntents.swift) is compiled into the app and
/// the widget extension; iOS runs a LiveActivityIntent in the app's process,
/// where it calls this. The widget extension's copy never calls it.
public enum CloxShiftSurfaceIntents {
  public static func handleTap(action: String, source: String) async {
    guard SurfaceContract.tapKinds.contains(action) else { return }
    let src = SurfaceContract.sources.contains(source) ? source : "live_activity"
    let now = ShiftSurfaceClock.nowMs()
    guard let tap = ShiftTaps.record(kind: action, source: src, nowMs: now) else {
      // Nothing to do, but redraw the widget in case it showed a state that
      // is no longer true.
      ShiftSurfaceWidgets.reload()
      return
    }
    if #available(iOS 16.2, *) {
      await ShiftLiveActivities.showPending(state: tap.state, nowMs: now)
    }
    ShiftSurfaceWidgets.reload()
    // Step 4: wake the JavaScript. If it is not running yet (iOS launched the
    // app in the background for this tap), it reads the inbox when it starts.
    CloxShiftSurfaceModule.notifyTap(id: tap.id)
    // Step 5: give it time to queue and send the punch. A tap nothing answers
    // stays in the inbox and is sent at the next open, with its tap time.
    await TapSignals.shared.waitUntilDone(id: tap.id, timeoutMs: SurfaceContract.tapWaitMs)
  }
}
