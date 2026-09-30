package expo.modules.cloxshiftsurface

import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import kotlin.math.abs

// The running shift outside the app, in Kotlin: the contract with the app's
// JavaScript and the rules for what the Android notification shows. This
// mirrors src/shift-surface-state.ts, which is the spec (the Swift mirror is
// modules/clox-shift-surface/ios/ShiftSurfaceModel.swift).
//
// scripts/shift-surface-android-check.mjs checks that the constants and the
// copy here equal the TypeScript. No Kotlin compiler was available where
// this was written, so the rules are kept to what Android needs (a tap, the
// pending look, the stale line) and follow the TypeScript line by line.
//
// Times are epoch milliseconds. Nothing here reads java.time (minSdk 24), and
// Android never formats a wall-clock time itself: "Started 9:42 AM" and
// "Clocked out at 5:02 PM." arrive formatted by the app's JavaScript in the
// org's zone.

object SurfaceContract {
  /** SURFACE_SCHEMA_VERSION. A blob with any other `v` is ignored. */
  const val SCHEMA_VERSION = 1
  /** SURFACE_ANDROID_PREFS: the SharedPreferences file (MODE_PRIVATE). */
  const val PREFS_FILE = "clox.shift_surface"
  const val STATE_KEY = "clox.surface.state"
  const val INBOX_KEY = "clox.surface.inbox"
  const val DISMISSAL_KEY = "clox.surface.dismissal"
  /** iOS only. Cleared here too, so clearAll leaves nothing behind. */
  const val ACTIVITY_KEY = "clox.surface.activity"
  /** SURFACE_OPEN_URL: opens the Clock screen and does nothing else. */
  const val OPEN_URL = "clox://clock"
  /** PENDING_STALE_MS. */
  const val PENDING_STALE_MS = 120_000L
  /** SAME_SHIFT_TOLERANCE_MS. */
  const val SAME_SHIFT_TOLERANCE_MS = 120_000L
  /** FINAL_CARD_MS, used when a plan's final card has no dismissAtMs. */
  const val FINAL_CARD_MS = 900_000L
  /** SHIFT_ACTION_TASK_NAME in src/shift-surface.ts: the headless task a
   *  Clock out or break tap starts when the app's JavaScript is not running.
   *  index.js registers it with AppRegistry.registerHeadlessTask. */
  const val HEADLESS_TASK = "CloxShiftAction"
  /** The longest the headless task may run before the service stops. */
  const val HEADLESS_TIMEOUT_MS = 30_000L
  /** The "Running shift" channel. DEFAULT importance, no sound, no
   *  vibration, public on the lock screen. Android lets only the person
   *  change a channel once it exists. */
  const val CHANNEL_ID = "running_shift"
  val TAP_KINDS = listOf("out", "break_start", "break_end")
  val SOURCES = listOf("live_activity", "widget", "notification")
  val STATUSES = listOf("off", "on", "break", "signed_out")
}

/**
 * SURFACE_COPY. The state carries its own copy (so an EAS Update can fix
 * wording); these fill any key it lacks, and name the channel.
 */
object SurfaceCopyDefaults {
  val values: Map<String, String> = linkedMapOf(
    "onEyebrow" to "ON THE CLOCK",
    "breakEyebrow" to "ON BREAK",
    "clockingOutEyebrow" to "CLOCKING OUT",
    "started" to "Started {time}",
    "breakShiftSince" to "Your shift started at {time}.",
    "takeBreak" to "Take break",
    "endBreak" to "End break",
    "clockOut" to "Clock out",
    "clockIn" to "Clock in",
    "takeBreakA11y" to "Take a break.",
    "endBreakA11y" to "End your break.",
    "clockOutA11y" to "Clock out.",
    "clockOutOpensA11y" to "Clock out. Opens Clox so you can finish it there.",
    "clockInA11y" to "Clock in. Opens Clox.",
    "notClockedIn" to "You're not clocked in.",
    "openToSignIn" to "Open Clox to sign in.",
    "openToSee" to "Open Clox to see your shift.",
    "pendingOut" to "Sending your clock-out.",
    "pendingBreakStart" to "Starting your break.",
    "pendingBreakEnd" to "Ending your break.",
    "stale" to "Open Clox to send it.",
    "clockedOutAt" to "Clocked out at {time}.",
    "clockedOut" to "You're clocked out.",
    "savedOffline" to "Saved on this phone. It sends when you're online.",
    "refusedOut" to "Clock-out didn't go through. Open Clox.",
    "refusedBreakStart" to "Your break didn't start. Open Clox.",
    "refusedBreakEnd" to "Your break didn't end. Open Clox.",
    "notificationOnTitle" to "On the clock",
    "notificationBreakTitle" to "On break",
    "notificationClockingOutTitle" to "Clocking out",
    "widgetNameFixed" to "Clox",
    "widgetDescriptionFixed" to "See your running shift and clock out from here.",
    "channelNameFixed" to "Running shift",
    "channelDescriptionFixed" to "Shows your running shift and its timer while you're on the clock.",
  )

  fun text(key: String): String = values[key] ?: ""
}

// ── JSON helpers (the rules of the TypeScript parsers) ───────────────────

object SurfaceJson {
  /** typeof x === "number" && Number.isFinite(x). A Boolean is not a Number
   *  in Kotlin, so true never reads as 1. */
  fun number(x: Any?): Double? {
    if (x !is Number) return null
    val d = x.toDouble()
    return if (d.isFinite()) d else null
  }

  /** strOrNull: a non-empty string, or null. */
  fun string(x: Any?): String? {
    val s = x as? String ?: return null
    return if (s.isEmpty()) null else s
  }

  /** x === true */
  fun isTrue(x: Any?): Boolean = x == true

  /** JSON.parse that never throws. JSONObject.NULL for "null". */
  fun parse(text: String?): Any? {
    if (text.isNullOrEmpty()) return null
    return try {
      JSONTokener(text).nextValue()
    } catch (e: Exception) {
      null
    }
  }

  fun isVersion(x: Any?): Boolean = number(x) == SurfaceContract.SCHEMA_VERSION.toDouble()
}

// ── The state (SurfaceStateV1) ───────────────────────────────────────────

data class SurfacePendingTap(val id: String, val kind: String, val tapMs: Double)

data class SurfaceNotice(val kind: String, val text: String)

data class SurfaceState(
  val enabled: Boolean,
  /** "off", "on", "break" or "signed_out". */
  val status: String,
  val ownerUserId: String?,
  val shiftStartMs: Double?,
  val breakStartMs: Double?,
  val projectId: String?,
  val label: String?,
  val startedAtText: String?,
  val orgTimeZone: String?,
  val needsProjectToClockOut: Boolean,
  val pendingTap: SurfacePendingTap?,
  val notice: SurfaceNotice?,
  val copy: Map<String, String>,
  val updatedMs: Double,
) {
  fun text(key: String): String = copy[key] ?: SurfaceCopyDefaults.text(key)

  companion object {
    /** parseState: null for anything that is not a v1 state. */
    fun parse(raw: Any?): SurfaceState? {
      val o = raw as? JSONObject ?: return null
      if (!SurfaceJson.isVersion(o.opt("v"))) return null
      val status = o.opt("status") as? String ?: return null
      if (status !in SurfaceContract.STATUSES) return null

      val copy = HashMap(SurfaceCopyDefaults.values)
      val c = o.opt("copy") as? JSONObject
      if (c != null) {
        for (key in SurfaceCopyDefaults.values.keys) {
          val value = SurfaceJson.string(c.opt(key))
          if (value != null) copy[key] = value
        }
      }

      var pendingTap: SurfacePendingTap? = null
      val pt = o.opt("pendingTap") as? JSONObject
      if (pt != null) {
        val id = pt.opt("id") as? String
        val kind = pt.opt("kind") as? String
        val tapMs = SurfaceJson.number(pt.opt("tapMs"))
        if (id != null && kind != null && kind in SurfaceContract.TAP_KINDS && tapMs != null) {
          pendingTap = SurfacePendingTap(id.lowercase(), kind, tapMs)
        }
      }

      var notice: SurfaceNotice? = null
      val nt = o.opt("notice") as? JSONObject
      if (nt != null) {
        val kind = nt.opt("kind") as? String
        val text = nt.opt("text") as? String
        if (kind != null && kind in SurfaceContract.TAP_KINDS && text != null) {
          notice = SurfaceNotice(kind, text)
        }
      }

      return SurfaceState(
        enabled = SurfaceJson.isTrue(o.opt("enabled")),
        status = status,
        ownerUserId = SurfaceJson.string(o.opt("ownerUserId")),
        shiftStartMs = SurfaceJson.number(o.opt("shiftStartMs")),
        breakStartMs = SurfaceJson.number(o.opt("breakStartMs")),
        projectId = SurfaceJson.string(o.opt("projectId")),
        label = SurfaceJson.string(o.opt("label")),
        startedAtText = SurfaceJson.string(o.opt("startedAtText")),
        orgTimeZone = SurfaceJson.string(o.opt("orgTimeZone")),
        needsProjectToClockOut = SurfaceJson.isTrue(o.opt("needsProjectToClockOut")),
        pendingTap = pendingTap,
        notice = notice,
        copy = copy,
        updatedMs = SurfaceJson.number(o.opt("updatedMs")) ?: 0.0,
      )
    }
  }
}

// ── What the notification shows (NotificationView with show: true) ──────

/** A notification action. Only tap kinds: tapping the notification itself is
 *  what opens the app. */
data class SurfaceAction(val kind: String, val label: String)

data class NotificationView(
  val title: String,
  val text: String?,
  val subText: String?,
  /** setUsesChronometer + setWhen from here, or null for no running timer. */
  val chronometerBaseMs: Double?,
  val actions: List<SurfaceAction>,
) {
  companion object {
    /** The `view` of a NativeApplyPlan's notification part, or null for
     *  { show: false } and anything unreadable. */
    fun parse(raw: Any?): NotificationView? {
      val o = raw as? JSONObject ?: return null
      if (!SurfaceJson.isTrue(o.opt("show"))) return null
      val title = SurfaceJson.string(o.opt("title")) ?: return null
      val actions = ArrayList<SurfaceAction>()
      val list = o.opt("actions") as? JSONArray
      if (list != null) {
        for (i in 0 until list.length()) {
          val b = list.opt(i) as? JSONObject ?: continue
          val kind = b.opt("kind") as? String ?: continue
          if (kind !in SurfaceContract.TAP_KINDS) continue
          val label = SurfaceJson.string(b.opt("label")) ?: continue
          actions.add(SurfaceAction(kind, label))
        }
      }
      return NotificationView(
        title = title,
        text = o.opt("text") as? String,
        subText = o.opt("subText") as? String,
        chronometerBaseMs = SurfaceJson.number(o.opt("chronometerBaseMs")),
        actions = actions,
      )
    }
  }
}

// ── The rules (mirrors of the TypeScript functions of the same names) ────

object SurfaceRules {
  fun fillTime(template: String, time: String?): String? {
    if (!template.contains("{time}")) return template
    if (time.isNullOrEmpty()) return null
    return template.replace("{time}", time)
  }

  fun sameShift(a: Double?, b: Double?): Boolean {
    if (a == null || b == null) return false
    return abs(a - b) <= SurfaceContract.SAME_SHIFT_TOLERANCE_MS.toDouble()
  }

  fun isShiftShown(state: SurfaceState?): Boolean {
    if (state == null) return false
    return state.enabled &&
      state.ownerUserId != null &&
      (state.status == "on" || state.status == "break") &&
      state.shiftStartMs != null
  }

  fun phaseOf(state: SurfaceState): String = if (state.status == "break") "break" else "on"

  /** Whether a tap of `kind` may be saved right now. This is what stops a
   *  double tap (a pending tap blocks the next one), a tap on a notification
   *  left over from another account, and any tap while the remote off switch
   *  is off. */
  fun tapApplies(state: SurfaceState?, kind: String): Boolean {
    if (state == null || !isShiftShown(state) || state.pendingTap != null) return false
    return when (kind) {
      "break_start" -> state.status == "on"
      "break_end" -> state.status == "break"
      "out" -> !state.needsProjectToClockOut && state.notice?.kind != "out"
      else -> false
    }
  }

  /** applyTap, on the stored state as written, so every key it carries is
   *  kept. Returns a new object. */
  fun applyTap(raw: JSONObject, id: String, kind: String, tapMs: Long, nowMs: Long): JSONObject {
    val next = JSONObject(raw.toString())
    next.put("pendingTap", JSONObject().put("id", id).put("kind", kind).put("tapMs", tapMs))
    next.put("notice", JSONObject.NULL)
    next.put("updatedMs", nowMs)
    return next
  }

  /** isDismissed: the person swiped the notification away for this shift
   *  and phase. */
  fun isDismissed(dismissal: JSONObject?, shiftStartMs: Double?, phase: String): Boolean {
    if (dismissal == null || !SurfaceJson.isVersion(dismissal.opt("v"))) return false
    return dismissal.opt("phase") == phase &&
      sameShift(SurfaceJson.number(dismissal.opt("shiftStartMs")), shiftStartMs)
  }

  /** surfaceView(state, nowMs).notification. Null is { show: false }. */
  fun notificationView(state: SurfaceState?, nowMs: Double): NotificationView? {
    if (state == null || !state.enabled) return null
    if (state.status == "signed_out" || state.ownerUserId == null) return null
    if (!isShiftShown(state)) return null
    val shiftStart = state.shiftStartMs ?: return null

    val onBreak = state.status == "break"
    val breakStart = if (onBreak) (state.breakStartMs ?: shiftStart) else shiftStart
    val startedLine = if (onBreak) {
      fillTime(state.text("breakShiftSince"), state.startedAtText)
    } else {
      fillTime(state.text("started"), state.startedAtText)
    }

    val tap = state.pendingTap
    if (tap != null) {
      val stale = nowMs >= tap.tapMs + SurfaceContract.PENDING_STALE_MS.toDouble()
      val title: String
      val pendingLine: String
      val chronometerBaseMs: Double?
      when (tap.kind) {
        "out" -> {
          title = state.text("notificationClockingOutTitle")
          pendingLine = state.text("pendingOut")
          chronometerBaseMs = null
        }
        "break_start" -> {
          title = state.text("notificationBreakTitle")
          pendingLine = state.text("pendingBreakStart")
          chronometerBaseMs = tap.tapMs
        }
        else -> {
          title = state.text("notificationOnTitle")
          pendingLine = state.text("pendingBreakEnd")
          chronometerBaseMs = shiftStart
        }
      }
      return NotificationView(
        title = title,
        text = if (stale) state.text("stale") else pendingLine,
        subText = state.label,
        chronometerBaseMs = chronometerBaseMs,
        actions = emptyList(),
      )
    }

    val clockOutOpens = state.needsProjectToClockOut || state.notice?.kind == "out"
    val breakAction = if (onBreak) {
      SurfaceAction("break_end", state.text("endBreak"))
    } else {
      SurfaceAction("break_start", state.text("takeBreak"))
    }
    // A clock-out that has to open the app is left off: an action that only
    // opens the app is what tapping the notification already does.
    val actions = if (clockOutOpens) {
      listOf(breakAction)
    } else {
      listOf(breakAction, SurfaceAction("out", state.text("clockOut")))
    }
    // Android draws subText in the one-line header, next to "Clox" and the
    // timer, where a long line is cut off. A refusal notice is the line that
    // matters, so it takes the body and the label moves up.
    val notice = state.notice
    return NotificationView(
      title = if (onBreak) state.text("notificationBreakTitle") else state.text("notificationOnTitle"),
      text = notice?.text ?: state.label ?: startedLine,
      subText = if (notice != null) state.label else if (state.label != null) startedLine else null,
      chronometerBaseMs = if (onBreak) breakStart else shiftStart,
      actions = actions,
    )
  }
}
