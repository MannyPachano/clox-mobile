import ActivityKit
import ExpoModulesCore
import Foundation

// The Expo module the app's JavaScript talks to (src/shift-surface.ts,
// CloxShiftSurfaceModule). Every payload is one JSON string with a `v`; the
// shapes are in src/shift-surface-state.ts.
public final class CloxShiftSurfaceModule: Module {
  private static let registryLock = NSLock()
  private static weak var current: CloxShiftSurfaceModule?

  /// Step 4 of a tap: tell a running JavaScript. Nothing happens when no
  /// module exists yet; the app reads the inbox when it starts.
  static func notifyTap(id: String) {
    registryLock.lock()
    let module = current
    registryLock.unlock()
    guard let module = module else { return }
    DispatchQueue.main.async {
      module.sendEvent("onTap", ["id": id])
    }
  }

  public func definition() -> ModuleDefinition {
    Name("CloxShiftSurface")

    Constant("schemaVersion") { SurfaceContract.schemaVersion }

    Events("onTap")

    OnCreate {
      CloxShiftSurfaceModule.registryLock.lock()
      CloxShiftSurfaceModule.current = self
      CloxShiftSurfaceModule.registryLock.unlock()
      if #available(iOS 16.2, *) {
        ShiftActivityWatcher.shared.start()
      }
    }

    OnDestroy {
      CloxShiftSurfaceModule.registryLock.lock()
      if CloxShiftSurfaceModule.current === self {
        CloxShiftSurfaceModule.current = nil
      }
      CloxShiftSurfaceModule.registryLock.unlock()
    }

    // A tap saved before the JavaScript listened (a cold or background start)
    // gets one nudge once it does. The JavaScript reads the whole inbox
    // either way.
    OnStartObserving("onTap") {
      if let id = ShiftSurfaceStore.shared.newestTapId() {
        self.sendEvent("onTap", ["id": id])
      }
    }

    AsyncFunction("readSnapshot") { () -> String in
      return ShiftSurfaceNative.snapshot()
    }

    AsyncFunction("apply") { (planJson: String) async -> String in
      return await ShiftSurfaceNative.apply(planJson: planJson)
    }

    AsyncFunction("readInbox") { () -> String in
      return ShiftSurfaceStore.shared.inboxText()
    }

    AsyncFunction("ackTaps") { (ids: [String]) in
      ShiftSurfaceStore.shared.ackTaps(ids)
    }

    AsyncFunction("signalTap") { (id: String, stage: String) in
      TapSignals.shared.signal(id: id, stage: stage)
    }

    AsyncFunction("clearAll") { () async in
      await ShiftSurfaceNative.clearAll()
    }
  }
}

enum ShiftSurfaceNative {
  /// NativeSnapshot as JSON.
  static func snapshot() -> String {
    let store = ShiftSurfaceStore.shared
    var snap: [String: Any] = [
      "schemaVersion": SurfaceContract.schemaVersion,
      "platform": "ios",
      "activitiesSupported": false,
      "activitiesEnabled": false,
      "notificationsAllowed": false,
      "notificationShown": false,
      "activities": [Any](),
    ]
    // The widget extension that draws the Live Activity needs iOS 17 (see
    // targets/widget/expo-target.config.js). ActivityKit exists from 16.2,
    // but an activity started there would have nothing to draw it, so iOS 16
    // reports no support and never starts one.
    if #available(iOS 17.0, *) {
      snap["activitiesSupported"] = true
      snap["activitiesEnabled"] = ActivityAuthorizationInfo().areActivitiesEnabled
    }
    if #available(iOS 16.2, *) {
      snap["activities"] = ShiftLiveActivities.snapshotEntries()
    }
    store.locked {
      snap["state"] = store.readObject(SurfaceContract.stateKey) ?? NSNull()
      snap["activityRecord"] = store.readObject(SurfaceContract.activityKey) ?? NSNull()
      snap["dismissal"] = store.readObject(SurfaceContract.dismissalKey) ?? NSNull()
    }
    return SurfaceJSON.stringify(snap) ?? "{}"
  }

  static func result(startedId: String?, errors: [String]) -> String {
    let out: [String: Any] = ["startedActivityId": SurfaceJSON.orNull(startedId), "errors": errors]
    return SurfaceJSON.stringify(out) ?? "{\"startedActivityId\":null,\"errors\":[]}"
  }

  /// Carries out a NativeApplyPlan: write the state (and redraw the widget),
  /// save or clear the dismissal, then end, update or start Live Activities.
  /// The notification part is Android's.
  static func apply(planJson: String) async -> String {
    guard let plan = SurfaceJSON.parse(planJson) as? [String: Any],
          SurfaceJSON.number(plan["v"]) == Double(SurfaceContract.schemaVersion)
    else {
      return result(startedId: nil, errors: ["plan: unreadable, or another schema version"])
    }
    let now = ShiftSurfaceClock.nowMs()
    let store = ShiftSurfaceStore.shared
    let activityPart = (plan["activity"] as? [String: Any]) ?? [:]
    var errors: [String] = []
    var effective: SurfaceState? = nil
    var viewOverride: SurfaceActivityView? = nil
    var allowStart = true

    store.locked {
      guard var raw = plan["state"] as? [String: Any], var next = SurfaceState.parse(raw) else {
        errors.append("state: unreadable, left as it was")
        return
      }
      // carryPendingTap, done here too, under the lock: a tap saved after the
      // JavaScript read the snapshot must keep its pending look until the
      // JavaScript has seen it. Once it acks the tap, its outcome replaces it.
      if next.pendingTap == nil,
         let prev = SurfaceState.parse(store.readObject(SurfaceContract.stateKey)),
         let tap = prev.pendingTap,
         store.inboxIds().contains(tap.id),
         prev.ownerUserId == next.ownerUserId,
         next.status == "on" || next.status == "break",
         SurfaceRules.sameShift(prev.shiftStartMs, next.shiftStartMs) {
        raw["pendingTap"] = ["id": tap.id, "kind": tap.kind, "tapMs": tap.tapMs] as [String: Any]
        next.pendingTap = tap
        viewOverride = SurfaceRules.surfaceView(next, nowMs: now).activity
        // planActivity never starts an activity while a tap is pending.
        allowStart = false
      }
      store.write(SurfaceContract.stateKey, raw)
      effective = next

      if plan.keys.contains("dismissal") {
        store.write(SurfaceContract.dismissalKey, plan["dismissal"] as? [String: Any])
      }
      if let inner = activityPart["plan"] as? [String: Any],
         let recorded = inner["recordDismissal"] as? [String: Any] {
        store.write(SurfaceContract.dismissalKey, recorded)
      }
    }
    ShiftSurfaceWidgets.reload()

    var startedId: String? = nil
    if #available(iOS 16.2, *) {
      let outcome = await ShiftLiveActivities.apply(
        activity: activityPart,
        state: effective,
        viewOverride: viewOverride,
        allowStart: allowStart,
        nowMs: now
      )
      startedId = outcome.startedId
      errors += outcome.errors
    }
    return result(startedId: startedId, errors: errors)
  }

  /// Sign-out, account deletion, re-auth and account switch: end every
  /// activity at once and clear the state, the inbox, the dismissal and the
  /// activity record.
  static func clearAll() async {
    if #available(iOS 16.2, *) {
      await ShiftLiveActivities.endAll()
    }
    ShiftSurfaceStore.shared.clearAllKeys()
    TapSignals.shared.clear()
    ShiftSurfaceWidgets.reload()
  }
}
