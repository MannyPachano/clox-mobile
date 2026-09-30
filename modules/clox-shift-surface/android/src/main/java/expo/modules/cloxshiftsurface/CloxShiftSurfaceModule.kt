package expo.modules.cloxshiftsurface

import android.content.Context
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject
import java.lang.ref.WeakReference

// The Expo module the app's JavaScript talks to (src/shift-surface.ts,
// CloxShiftSurfaceModule). Every payload is one JSON string with a `v`; the
// shapes are in src/shift-surface-state.ts. The Swift module of the same name
// does the iOS side; on Android there are no Live Activities, so the
// snapshot always says so, and signalTap does nothing (no intent waits).
class CloxShiftSurfaceModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  companion object {
    private val registryLock = Any()
    private var current: WeakReference<CloxShiftSurfaceModule>? = null
    private var observing = false

    /** Step 4 of a tap, beside the headless task: tell a running JavaScript
     *  that listens for taps. False when none does. */
    fun notifyTap(id: String): Boolean {
      val module = synchronized(registryLock) {
        if (observing) current?.get() else null
      } ?: return false
      return try {
        module.sendEvent("onTap", mapOf("id" to id))
        true
      } catch (e: Exception) {
        false
      }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("CloxShiftSurface")

    Constant("schemaVersion") { SurfaceContract.SCHEMA_VERSION }

    Events("onTap")

    OnCreate {
      synchronized(registryLock) {
        current = WeakReference(this@CloxShiftSurfaceModule)
        observing = false
      }
    }

    OnDestroy {
      synchronized(registryLock) {
        if (current?.get() === this@CloxShiftSurfaceModule) {
          current = null
          observing = false
        }
      }
    }

    // A tap saved before the JavaScript listened (a cold start, or the
    // headless task) gets one nudge once it does. The JavaScript reads the
    // whole inbox either way.
    OnStartObserving("onTap") {
      synchronized(registryLock) {
        if (current?.get() === this@CloxShiftSurfaceModule) observing = true
      }
      val newest = try {
        ShiftSurfaceStore.newestTapId(context)
      } catch (e: Exception) {
        null
      }
      if (newest != null) sendEvent("onTap", mapOf("id" to newest))
    }

    OnStopObserving("onTap") {
      synchronized(registryLock) {
        if (current?.get() === this@CloxShiftSurfaceModule) observing = false
      }
    }

    AsyncFunction<String>("readSnapshot") {
      ShiftSurfaceNative.snapshot(context)
    }

    AsyncFunction("apply") { planJson: String ->
      ShiftSurfaceNative.apply(context, planJson)
    }

    AsyncFunction<String>("readInbox") {
      ShiftSurfaceStore.inboxText(context)
    }

    AsyncFunction("ackTaps") { ids: List<String> ->
      ShiftSurfaceStore.ackTaps(context, ids)
    }

    // iOS: releases a LiveActivityIntent waiting for its tap. Nothing waits
    // on Android: the receiver returns as soon as the tap is saved.
    AsyncFunction("signalTap") { _: String, _: String ->
    }

    AsyncFunction("clearAll") {
      ShiftSurfaceNative.clearAll(context)
    }
  }
}

object ShiftSurfaceNative {
  private fun result(errors: List<String>): String {
    return JSONObject()
      .put("startedActivityId", JSONObject.NULL)
      .put("errors", JSONArray(errors))
      .toString()
  }

  /** NativeSnapshot as JSON. */
  fun snapshot(context: Context): String {
    val snap = JSONObject()
      .put("schemaVersion", SurfaceContract.SCHEMA_VERSION)
      .put("platform", "android")
      .put("activitiesSupported", false)
      .put("activitiesEnabled", false)
      .put("notificationsAllowed", ShiftNotifications.canPost(context))
      .put("notificationShown", ShiftNotifications.isOngoingShown(context))
      .put("activities", JSONArray())
      .put("activityRecord", JSONObject.NULL)
    ShiftSurfaceStore.locked(context) { store ->
      snap.put("state", store.readObject(SurfaceContract.STATE_KEY) ?: JSONObject.NULL)
      snap.put("dismissal", store.readObject(SurfaceContract.DISMISSAL_KEY) ?: JSONObject.NULL)
    }
    return snap.toString()
  }

  /** What apply() wrote, read back under the same lock. */
  private class Written(val state: SurfaceState, val carried: Boolean, val dismissal: JSONObject?)

  /**
   * Carries out a NativeApplyPlan: write the state, save or clear the
   * dismissal, then post, update or cancel the notification. The activity
   * part is iOS's.
   */
  fun apply(context: Context, planJson: String): String {
    val plan = SurfaceJson.parse(planJson) as? JSONObject
    if (plan == null || !SurfaceJson.isVersion(plan.opt("v"))) {
      return result(listOf("plan: unreadable, or another schema version"))
    }
    val now = System.currentTimeMillis()
    val errors = ArrayList<String>()

    val written: Written? = ShiftSurfaceStore.locked(context) { store ->
      val raw = plan.opt("state") as? JSONObject
      val parsed = SurfaceState.parse(raw)
      if (raw == null || parsed == null) {
        null
      } else {
        var next: SurfaceState = parsed
        var carried = false
        // carryPendingTap, done here too, under the lock: a tap saved after
        // the JavaScript read the snapshot keeps its pending look until the
        // JavaScript has seen it. Once it acks the tap, its outcome replaces
        // it.
        val prev = SurfaceState.parse(store.readObject(SurfaceContract.STATE_KEY))
        val tap = prev?.pendingTap
        if (next.pendingTap == null &&
          prev != null &&
          tap != null &&
          tap.id in store.inboxIds() &&
          prev.ownerUserId == next.ownerUserId &&
          (next.status == "on" || next.status == "break") &&
          SurfaceRules.sameShift(prev.shiftStartMs, next.shiftStartMs)
        ) {
          raw.put(
            "pendingTap",
            JSONObject().put("id", tap.id).put("kind", tap.kind).put("tapMs", tap.tapMs.toLong()),
          )
          val withTap = SurfaceState.parse(raw)
          if (withTap != null) {
            next = withTap
            carried = true
          }
        }
        store.write(SurfaceContract.STATE_KEY, raw)
        if (plan.has("dismissal")) {
          store.write(SurfaceContract.DISMISSAL_KEY, plan.opt("dismissal") as? JSONObject)
        }
        Written(next, carried, store.readObject(SurfaceContract.DISMISSAL_KEY) as? JSONObject)
      }
    }
    if (written == null) {
      return result(listOf("state: unreadable, left as it was"))
    }

    val part = plan.optJSONObject("notification")
    val post = part?.opt("post") == true
    val cancel = part?.opt("cancel") == true
    val finalCard = part?.optJSONObject("finalCard")
    val finalText = SurfaceJson.string(finalCard?.opt("text"))

    if (finalText != null) {
      val dismissAt = SurfaceJson.number(finalCard?.opt("dismissAtMs"))?.toLong()
        ?: (now + SurfaceContract.FINAL_CARD_MS)
      // The final line is the body; the title is the state's own copy, so an
      // EAS Update can change it too.
      val title = written.state.text("clockedOut")
      ShiftNotifications.postFinal(context, title, finalText, dismissAt, now, errors)
    } else if (cancel) {
      ShiftNotifications.cancel(context)
    }

    if (post) {
      val state = written.state
      // The JavaScript's view, unless a tap it has not seen is pending: then
      // the pending look, drawn here from the same rules.
      val view = if (written.carried) {
        SurfaceRules.notificationView(state, now.toDouble())
      } else {
        NotificationView.parse(part?.opt("view"))
      }
      // A swipe saved after the JavaScript read the snapshot still counts.
      val dismissed = SurfaceRules.isDismissed(written.dismissal, state.shiftStartMs, SurfaceRules.phaseOf(state))
      if (view != null && !dismissed) ShiftNotifications.postOngoing(context, view, errors)
    }
    return result(errors)
  }

  /** Sign-out, account deletion, re-auth and account switch: take the
   *  notification down and clear the state, the inbox and the dismissal. */
  fun clearAll(context: Context) {
    ShiftNotifications.cancel(context)
    ShiftNotifications.cancelStaleRedraw(context)
    ShiftSurfaceStore.clearAllKeys(context)
  }
}
