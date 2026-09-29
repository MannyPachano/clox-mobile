package expo.modules.cloxshiftsurface

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build

// The Android ongoing notification for the running shift: a chronometer
// counting from the shift start (from the break start on a break), the
// "Project · Task" line, and Take break or End break plus Clock out.
//
// Built with the platform Notification.Builder (API 24 and later), so it
// needs no particular androidx version. No foreground service: this is an
// ordinary ongoing notification, so Play needs no foreground-service
// declaration, and it never keeps the app running.
//
// The channel is DEFAULT importance with no sound and no vibration. LOW would
// be "silent", which a lock-screen setting can hide and which gets no
// status-bar icon; DEFAULT without sound shows on the lock screen and never
// makes a noise. setOnlyAlertOnce keeps updates quiet too.

object ShiftNotifications {
  /** One tag and id for the running-shift notification and for the final
   *  line that replaces it after a clock-out from here ("Clocked out at
   *  5:02 PM."). Posting either replaces the other in place. The tag keeps
   *  it apart from expo-notifications, which tags by its own identifiers. */
  private const val TAG = "clox.shift"
  private const val ID = 1

  private const val RC_OPEN = 100
  private const val RC_TAP_BASE = 101
  private const val RC_DISMISSED = 110
  private const val RC_STALE = 111

  /** The expo-notifications plugin writes app.json's notification icon as
   *  this drawable (a white mark on transparent). */
  private const val ICON_NAME = "notification_icon"

  /** The app's clay, the same as the expo-notifications color in app.json. */
  private val BRAND_COLOR: Int = 0xFFB84A2C.toInt()

  private fun manager(context: Context): NotificationManager? =
    context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager

  /** NativeSnapshot.notificationsAllowed: the 13+ permission, the app's
   *  notifications switch, and this channel not turned off. */
  fun canPost(context: Context): Boolean {
    val nm = manager(context) ?: return false
    if (!nm.areNotificationsEnabled()) return false
    if (Build.VERSION.SDK_INT >= 33 &&
      context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      return false
    }
    if (Build.VERSION.SDK_INT >= 26) {
      val channel = nm.getNotificationChannel(SurfaceContract.CHANNEL_ID)
      if (channel != null && channel.importance == NotificationManager.IMPORTANCE_NONE) return false
    }
    return true
  }

  /** NativeSnapshot.notificationShown: the ongoing running-shift
   *  notification is up (not the final line, which is not ongoing). */
  fun isOngoingShown(context: Context): Boolean {
    val nm = manager(context) ?: return false
    return try {
      nm.activeNotifications.any { sbn ->
        sbn.id == ID && sbn.tag == TAG && (sbn.notification.flags and Notification.FLAG_ONGOING_EVENT) != 0
      }
    } catch (e: Exception) {
      false
    }
  }

  private fun ensureChannel(nm: NotificationManager) {
    if (Build.VERSION.SDK_INT < 26) return
    val channel = NotificationChannel(
      SurfaceContract.CHANNEL_ID,
      SurfaceCopyDefaults.text("channelNameFixed"),
      NotificationManager.IMPORTANCE_DEFAULT,
    )
    channel.description = SurfaceCopyDefaults.text("channelDescriptionFixed")
    channel.setSound(null, null)
    channel.enableVibration(false)
    channel.enableLights(false)
    channel.setShowBadge(false)
    channel.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    // Creating a channel that exists only updates its name and description.
    nm.createNotificationChannel(channel)
  }

  @SuppressLint("DiscouragedApi")
  private fun smallIcon(context: Context): Int {
    val id = context.resources.getIdentifier(ICON_NAME, "drawable", context.packageName)
    return if (id != 0) id else context.applicationInfo.icon
  }

  /** Every PendingIntent here is explicit and immutable. */
  private val IMMUTABLE: Int = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

  /** Tapping the notification: clox://clock, which opens the Clock screen
   *  and does nothing else. Explicit (the app's launcher activity) and
   *  immutable. */
  private fun openIntent(context: Context): PendingIntent {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(SurfaceContract.OPEN_URL))
    intent.setPackage(context.packageName)
    val launcher = context.packageManager.getLaunchIntentForPackage(context.packageName)?.component
    if (launcher != null) intent.component = launcher
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(context, RC_OPEN, intent, IMMUTABLE)
  }

  /**
   * A Take break, End break or Clock out action (decision 3: it works once
   * the phone itself is unlocked, whether or not the Clox app lock is on).
   *
   * Android 12 and later: a broadcast to ShiftActionReceiver with
   * setAuthenticationRequired, so a tap on the lock screen asks to unlock
   * first and the shade stays open to show "Sending your clock-out."
   * Android 7 to 11 have no such flag and run a broadcast action straight
   * from the lock screen, so there the action opens ShiftActionActivity (no
   * UI): the system asks to unlock before it starts any activity.
   */
  private fun tapIntent(context: Context, kind: String): PendingIntent {
    val code = RC_TAP_BASE + SurfaceContract.TAP_KINDS.indexOf(kind)
    return if (Build.VERSION.SDK_INT >= 31) {
      val intent = Intent(context, ShiftActionReceiver::class.java)
      intent.action = ShiftActions.ACTION_TAP
      intent.putExtra(ShiftActions.EXTRA_KIND, kind)
      PendingIntent.getBroadcast(context, code, intent, IMMUTABLE)
    } else {
      val intent = Intent(context, ShiftActionActivity::class.java)
      intent.action = ShiftActions.ACTION_TAP
      intent.putExtra(ShiftActions.EXTRA_KIND, kind)
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
      PendingIntent.getActivity(context, code, intent, IMMUTABLE)
    }
  }

  private fun receiverIntent(context: Context, action: String, code: Int): PendingIntent {
    val intent = Intent(context, ShiftActionReceiver::class.java)
    intent.action = action
    return PendingIntent.getBroadcast(context, code, intent, IMMUTABLE)
  }

  private fun action(context: Context, a: SurfaceAction): Notification.Action {
    val icon = Icon.createWithResource(context, smallIcon(context))
    val builder = Notification.Action.Builder(icon, a.label, tapIntent(context, a.kind))
    if (Build.VERSION.SDK_INT >= 31) builder.setAuthenticationRequired(true)
    return builder.build()
  }

  @Suppress("DEPRECATION")
  private fun newBuilder(context: Context): Notification.Builder {
    if (Build.VERSION.SDK_INT >= 26) return Notification.Builder(context, SurfaceContract.CHANNEL_ID)
    // Android 7: no channels. Default priority with no sound or vibration
    // set is what the channel gives later versions.
    return Notification.Builder(context)
      .setPriority(Notification.PRIORITY_DEFAULT)
      .setSound(null)
      .setVibrate(null)
  }

  private fun baseBuilder(context: Context, title: String): Notification.Builder {
    return newBuilder(context)
      .setSmallIcon(smallIcon(context))
      .setColor(BRAND_COLOR)
      .setContentTitle(title)
      .setOnlyAlertOnce(true)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setCategory(Notification.CATEGORY_STATUS)
      // Nothing to show on a paired watch (decision 7 for Apple's; the same
      // on Wear OS): the lock screen and the shade only.
      .setLocalOnly(true)
      .setContentIntent(openIntent(context))
  }

  private fun buildOngoing(context: Context, view: NotificationView): Notification {
    val builder = baseBuilder(context, view.title)
      .setContentText(view.text)
      .setSubText(view.subText)
      .setOngoing(true)
      .setAutoCancel(false)
      .setDeleteIntent(receiverIntent(context, ShiftActions.ACTION_DISMISSED, RC_DISMISSED))
    val base = view.chronometerBaseMs
    if (base != null) {
      // The chronometer counts up from `when`. It is elapsed time, so it
      // needs no time zone.
      builder.setWhen(base.toLong()).setShowWhen(true).setUsesChronometer(true)
    } else {
      // A pending clock-out stops the timer. `when` without a chronometer
      // would print a clock time in the phone's zone, not the org's, so it
      // is hidden.
      builder.setShowWhen(false).setUsesChronometer(false)
    }
    for (a in view.actions) builder.addAction(action(context, a))
    return builder.build()
  }

  /** Posts (or updates in place) the running-shift notification. */
  @SuppressLint("MissingPermission")
  fun postOngoing(context: Context, view: NotificationView, errors: MutableList<String>) {
    val nm = manager(context) ?: return
    try {
      ensureChannel(nm)
      if (!canPost(context)) {
        errors.add("notification: not allowed on this phone")
        return
      }
      nm.notify(TAG, ID, buildOngoing(context, view))
    } catch (e: Exception) {
      errors.add("notification: " + e.javaClass.simpleName)
    }
  }

  /** The shift ended from here: the ongoing notification becomes a plain one
   *  with the final line, which goes away by itself at dismissAtMs (Android
   *  8 and later; on 7 it stays until swiped, as a plain notification can
   *  be). The title is one line and is cut off when long, so it is the short
   *  "You're clocked out." and the final line is the body, which can wrap
   *  ("Saved on this phone. It sends when you're online."). */
  @SuppressLint("MissingPermission")
  fun postFinal(
    context: Context,
    title: String,
    text: String,
    dismissAtMs: Long,
    nowMs: Long,
    errors: MutableList<String>,
  ) {
    val nm = manager(context) ?: return
    try {
      ensureChannel(nm)
      if (!canPost(context)) {
        nm.cancel(TAG, ID)
        errors.add("notification: not allowed on this phone")
        return
      }
      val builder = baseBuilder(context, title)
        .setOngoing(false)
        .setAutoCancel(true)
        .setShowWhen(false)
        .setUsesChronometer(false)
      if (text != title) {
        builder.setContentText(text).setStyle(Notification.BigTextStyle().bigText(text))
      }
      if (Build.VERSION.SDK_INT >= 26) {
        val left = dismissAtMs - nowMs
        if (left <= 0L) {
          nm.cancel(TAG, ID)
          return
        }
        builder.setTimeoutAfter(left)
      }
      nm.notify(TAG, ID, builder.build())
    } catch (e: Exception) {
      errors.add("notification: " + e.javaClass.simpleName)
    }
  }

  fun cancel(context: Context) {
    val nm = manager(context) ?: return
    try {
      nm.cancel(TAG, ID)
    } catch (e: Exception) {
      // Nothing to cancel.
    }
  }

  /** A pending tap nobody answered reads "Open Clox to send it." after
   *  PENDING_STALE_MS. A notification cannot change by itself, so an
   *  inexact alarm (no permission needed) redraws it then. */
  fun scheduleStaleRedraw(context: Context, atMs: Long) {
    val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
    try {
      am.set(AlarmManager.RTC, atMs, receiverIntent(context, ShiftActions.ACTION_REDRAW, RC_STALE))
    } catch (e: Exception) {
      // The pending line stays until the app answers or opens.
    }
  }

  fun cancelStaleRedraw(context: Context) {
    val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
    try {
      am.cancel(receiverIntent(context, ShiftActions.ACTION_REDRAW, RC_STALE))
    } catch (e: Exception) {
      // Nothing scheduled.
    }
  }

  /** Redraws the ongoing notification from the saved state, if it is up. A
   *  state that no longer shows a shift takes it down. */
  fun redrawFromState(context: Context, nowMs: Long) {
    if (!isOngoingShown(context)) return
    val state = ShiftSurfaceStore.locked(context) { store ->
      SurfaceState.parse(store.readObject(SurfaceContract.STATE_KEY))
    }
    val view = SurfaceRules.notificationView(state, nowMs.toDouble())
    if (view == null) cancel(context) else postOngoing(context, view, ArrayList())
  }
}
