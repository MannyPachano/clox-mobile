package expo.modules.cloxshiftsurface

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import java.util.UUID

// The SharedPreferences store and the tap path.
//
// Only this module writes the shared keys (SurfaceContract). Nothing here
// calls the server or touches a token: a tap is saved, then the app's
// JavaScript turns it into the same queued punch the Clock screen makes
// (src/queue.ts is the one punch path).
//
// The receiver, the tap activity, the headless service and the module all run
// in the app's one process, so one JVM lock keeps every read-modify-write of
// a key whole. Writes use commit(): a tap must be on disk before the
// JavaScript is woken, and before the process can be killed.

object ShiftSurfaceStore {
  private val lock = Any()

  class Prefs(private val sp: SharedPreferences) {
    fun readText(key: String): String? {
      return try {
        sp.getString(key, null)
      } catch (e: ClassCastException) {
        null
      }
    }

    fun readObject(key: String): Any? = SurfaceJson.parse(readText(key))

    /** Writes one JSON value under `key`, or removes the key for null. */
    fun write(key: String, value: Any?): Boolean {
      val editor = sp.edit()
      if (value == null || value === JSONObject.NULL) {
        editor.remove(key)
      } else {
        editor.putString(key, value.toString())
      }
      return editor.commit()
    }

    fun inbox(): JSONArray = readObject(SurfaceContract.INBOX_KEY) as? JSONArray ?: JSONArray()

    fun inboxIds(): List<String> {
      val list = inbox()
      val ids = ArrayList<String>()
      for (i in 0 until list.length()) {
        val o = list.opt(i) as? JSONObject ?: continue
        val id = o.opt("id") as? String ?: continue
        ids.add(id.lowercase())
      }
      return ids
    }
  }

  /** Runs `body` with the store locked. Nothing called inside `body` may
   *  lock again (the lock is re-entrant in the JVM, but a nested
   *  read-modify-write would be a bug). */
  fun <T> locked(context: Context, body: (Prefs) -> T): T {
    val sp = context.applicationContext.getSharedPreferences(SurfaceContract.PREFS_FILE, Context.MODE_PRIVATE)
    return synchronized(lock) { body(Prefs(sp)) }
  }

  /** The inbox as JSON text for readInbox(): the saved taps not yet acked,
   *  oldest first. */
  fun inboxText(context: Context): String = locked(context) { store ->
    val text = store.readText(SurfaceContract.INBOX_KEY)
    if (text != null && store.readObject(SurfaceContract.INBOX_KEY) is JSONArray) text else "[]"
  }

  /** The id of the newest saved tap, to nudge JavaScript that starts
   *  listening after the tap was saved. */
  fun newestTapId(context: Context): String? = locked(context) { store -> store.inboxIds().lastOrNull() }

  /** Removes these taps (queued, or dropped for good). An entry without an
   *  id can never be queued or acked, so it goes too. */
  fun ackTaps(context: Context, ids: List<String>) {
    val gone = ids.map { it.lowercase() }.toSet()
    locked(context) { store ->
      val list = store.inbox()
      val kept = JSONArray()
      for (i in 0 until list.length()) {
        val o = list.opt(i) as? JSONObject ?: continue
        val id = o.opt("id") as? String ?: continue
        if (id.lowercase() !in gone) kept.put(o)
      }
      store.write(SurfaceContract.INBOX_KEY, if (kept.length() == 0) null else kept)
    }
  }

  /** The person swiped the notification away (its deleteIntent; the app
   *  cancelling it never sends one). It stays away for this shift and phase
   *  (SurfaceDismissalV1). */
  fun saveSwipe(context: Context, nowMs: Long) {
    locked(context) { store ->
      val state = SurfaceState.parse(store.readObject(SurfaceContract.STATE_KEY))
      val start = state?.shiftStartMs
      if (state != null && start != null && SurfaceRules.isShiftShown(state)) {
        val dismissal = JSONObject()
          .put("v", SurfaceContract.SCHEMA_VERSION)
          .put("surface", "notification")
          .put("shiftStartMs", start.toLong())
          .put("phase", SurfaceRules.phaseOf(state))
          .put("atMs", nowMs)
        store.write(SurfaceContract.DISMISSAL_KEY, dismissal)
      }
    }
  }

  /** Sign-out, account deletion, re-auth and account switch. */
  fun clearAllKeys(context: Context) {
    locked(context) { store ->
      store.write(SurfaceContract.STATE_KEY, null)
      store.write(SurfaceContract.INBOX_KEY, null)
      store.write(SurfaceContract.DISMISSAL_KEY, null)
      store.write(SurfaceContract.ACTIVITY_KEY, null)
    }
  }
}

/** A tap that was saved: its id and the state right after it (pending). */
class RecordedTap(val id: String, val state: SurfaceState)

object ShiftTaps {
  /**
   * Steps 1 to 3 of a tap (shift-surface-state.ts, "What native does at a
   * tap"): check the state, save the tap to the inbox, and mark the state
   * pending. Null when the tap does not apply (a double tap, a stale
   * notification, the off switch) or nothing could be saved.
   */
  fun record(context: Context, kind: String, source: String, nowMs: Long): RecordedTap? {
    if (kind !in SurfaceContract.TAP_KINDS) return null
    val src = if (source in SurfaceContract.SOURCES) source else "notification"
    return ShiftSurfaceStore.locked(context) { store ->
      val raw = store.readObject(SurfaceContract.STATE_KEY) as? JSONObject
      val state = SurfaceState.parse(raw)
      val owner = state?.ownerUserId
      if (raw == null || state == null || owner == null || !SurfaceRules.tapApplies(state, kind)) {
        null
      } else {
        val id = UUID.randomUUID().toString().lowercase(Locale.ROOT)
        val tap = JSONObject()
          .put("v", SurfaceContract.SCHEMA_VERSION)
          .put("id", id)
          .put("kind", kind)
          .put("tapMs", nowMs)
          .put("userId", owner)
          .put("projectId", state.projectId ?: JSONObject.NULL)
          .put("source", src)
        val inbox = store.inbox()
        inbox.put(tap)
        if (!store.write(SurfaceContract.INBOX_KEY, inbox)) {
          null
        } else {
          val nextRaw = SurfaceRules.applyTap(raw, id, kind, nowMs, nowMs)
          store.write(SurfaceContract.STATE_KEY, nextRaw)
          val next = SurfaceState.parse(nextRaw)
          if (next == null) null else RecordedTap(id, next)
        }
      }
    }
  }
}
