package expo.modules.cloxshiftsurface

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Bundle
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

// A tap on the notification's Take break, End break or Clock out, from the
// moment Android delivers it to the moment the app's JavaScript has it.
//
// Nothing here sends a punch. The tap is saved (ShiftTaps.record), the
// notification shows it pending, and the JavaScript is woken to turn it into
// the same queued punch the Clock screen makes. If the JavaScript cannot be
// woken, the tap stays in the inbox and is sent the next time Clox opens,
// with its tap time; two minutes after the tap the notification says "Open
// Clox to send it."

object ShiftActions {
  const val ACTION_TAP = "expo.modules.cloxshiftsurface.TAP"
  const val ACTION_DISMISSED = "expo.modules.cloxshiftsurface.DISMISSED"
  const val ACTION_REDRAW = "expo.modules.cloxshiftsurface.REDRAW"
  const val EXTRA_KIND = "kind"
  const val EXTRA_TAP_ID = "id"

  /** Steps 1 to 4 of a tap: save it, show it pending, wake the JavaScript. */
  fun onTap(context: Context, kind: String?) {
    val app = context.applicationContext
    val now = System.currentTimeMillis()
    val tap = if (kind == null) null else ShiftTaps.record(app, kind, "notification", now)
    if (tap == null) {
      // A double tap, a notification left over from another state, or the
      // off switch. Redraw from the saved state in case the notification
      // shows something that is no longer true.
      ShiftNotifications.redrawFromState(app, now)
      return
    }
    val view = SurfaceRules.notificationView(tap.state, now.toDouble())
    if (view != null) ShiftNotifications.postOngoing(app, view, ArrayList())
    ShiftNotifications.scheduleStaleRedraw(app, now + SurfaceContract.PENDING_STALE_MS)
    wakeJs(app, tap.id)
  }

  /**
   * Step 4. Every tap starts the headless task "CloxShiftAction", which runs
   * the inbox pass: in the app's running React instance when there is one,
   * else in a new one without a screen. The service is what makes the pass
   * finish with the phone locked: it keeps the process out of the cached
   * state the system freezes, holds a wake lock, and keeps the JavaScript
   * timers running (React Native pauses them while the app is in the
   * background and no headless task is active, which would stall the pass's
   * time budgets and the session refresh). Android lets an app start a
   * service while it handles a notification action (the system briefly
   * allows it).
   *
   * A JavaScript that listens for taps also gets the onTap event. The pass is
   * single-flight, so the event and the task join one pass; the event covers
   * a task that the service starts but React cannot run. If neither reaches
   * the JavaScript, the tap waits in the inbox for the next open.
   */
  fun wakeJs(context: Context, tapId: String) {
    try {
      val service = Intent(context, ShiftActionTaskService::class.java)
      service.putExtra(EXTRA_TAP_ID, tapId)
      if (context.startService(service) != null) {
        // Keeps the CPU awake until the service runs the task; the service
        // releases it when it stops.
        HeadlessJsTaskService.acquireWakeLockNow(context)
      }
    } catch (e: Exception) {
      // IllegalStateException (a background start refused) or
      // SecurityException. The event below, or the next open, sends it.
    }
    CloxShiftSurfaceModule.notifyTap(tapId)
  }
}

/**
 * The notification's broadcasts: a tap on Android 12 and later (the action
 * asks to unlock first), the person swiping the notification away, and the
 * stale redraw. Not exported: only this app's own PendingIntents reach it.
 */
class ShiftActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val app = context.applicationContext
    when (intent.action) {
      ShiftActions.ACTION_TAP -> ShiftActions.onTap(app, intent.getStringExtra(ShiftActions.EXTRA_KIND))
      ShiftActions.ACTION_DISMISSED -> ShiftSurfaceStore.saveSwipe(app, System.currentTimeMillis())
      ShiftActions.ACTION_REDRAW -> ShiftNotifications.redrawFromState(app, System.currentTimeMillis())
    }
  }
}

/**
 * A tap on Android 7 to 11, where a broadcast action would run straight from
 * the lock screen: an activity action makes the system ask to unlock first
 * (decision 3). It has no UI; it saves the tap and closes. Not exported.
 */
class ShiftActionActivity : Activity() {
  // overridePendingTransition is deprecated from Android 14, where
  // FLAG_ACTIVITY_NO_ANIMATION on the intent already does the same.
  @Suppress("DEPRECATION")
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // A recreated activity (a configuration change before finish) must not
    // record the tap a second time.
    val start = intent
    if (savedInstanceState == null && start != null && start.action == ShiftActions.ACTION_TAP) {
      ShiftActions.onTap(applicationContext, start.getStringExtra(ShiftActions.EXTRA_KIND))
    }
    finish()
    overridePendingTransition(0, 0)
  }
}

/**
 * Runs the JavaScript task "CloxShiftAction" (registered in index.js) for
 * every tap, in the running React instance or a new one without a screen.
 * Never a foreground service: it runs for as long as the task takes, at most
 * HEADLESS_TIMEOUT_MS.
 */
class ShiftActionTaskService : HeadlessJsTaskService() {
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
    val data = Arguments.createMap()
    val id = intent?.getStringExtra(ShiftActions.EXTRA_TAP_ID)
    if (id != null) data.putString("id", id)
    // Allowed in the foreground too: the app may come up while it runs, and
    // React Native otherwise refuses the task (and crashes) in that case.
    return HeadlessJsTaskConfig(
      SurfaceContract.HEADLESS_TASK,
      data,
      SurfaceContract.HEADLESS_TIMEOUT_MS,
      true,
    )
  }
}
