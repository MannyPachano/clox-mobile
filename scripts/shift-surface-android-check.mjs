// Checks the Android side of the lock-screen surfaces against the TypeScript
// spec (src/shift-surface-state.ts). No Android SDK, Gradle or Kotlin
// compiler needed, and none is used: the Kotlin is read as text, so this
// catches drift and rule breaks, not compile errors. The first Android EAS
// build is the compile check.
// Run: node scripts/shift-surface-android-check.mjs
//
//   1. The Kotlin contract constants and default copy equal the TypeScript.
//   2. Every string literal in the Kotlin follows the copy rules.
//   3. The module registers what src/shift-surface.ts calls, and autolinking
//      names a class that exists.
//   4. The manifest: nothing exported, no boot permission (decision 6), no
//      foreground service, POST_NOTIFICATIONS and WAKE_LOCK declared, and
//      every component it names exists.
//   5. The Kotlin keeps the plan's rules: explicit immutable PendingIntents,
//      unlock before an action runs (decision 3), a DEFAULT channel with no
//      sound or vibration, public on the lock screen, a chronometer, no
//      java.time, no network, no foreground service.
//   6. Brackets balance in every Kotlin file, each file is in the module's
//      package, and every Object.member it uses from this module exists.
//   7. The notification icon exists, is a 96 px PNG, and app.json uses it.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FINAL_CARD_MS,
  PENDING_STALE_MS,
  SAME_SHIFT_TOLERANCE_MS,
  SURFACE_ANDROID_PREFS,
  SURFACE_COPY,
  SURFACE_KEYS,
  SURFACE_OPEN_URL,
  SURFACE_SCHEMA_VERSION,
} from "../src/shift-surface-state.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_DIR = join(ROOT, "modules/clox-shift-surface");
const ANDROID_DIR = join(MODULE_DIR, "android");
const PACKAGE = "expo.modules.cloxshiftsurface";
const SRC_DIR = join(ANDROID_DIR, "src/main/java", ...PACKAGE.split("."));

let pass = 0;
let fail = 0;
const eq = (a, b, msg) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else {
    fail++;
    console.log("FAIL:", msg, "\n  got ", JSON.stringify(a), "\n  want", JSON.stringify(b));
  }
};
const ok = (cond, msg) => eq(!!cond, true, msg);
const read = (p) => readFileSync(p, "utf8");
const rel = (p) => relative(ROOT, p);

function kotlinFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...kotlinFiles(p));
    else if (name.endsWith(".kt")) out.push(p);
  }
  return out.sort();
}

/**
 * Splits Kotlin source into its string literals and the code with strings,
 * characters and comments blanked out. Enough for this code: escapes,
 * ${...} templates (without quotes inside), raw strings, nested block
 * comments and character literals.
 */
function scanKotlin(src) {
  const strings = [];
  let code = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("//", i)) {
      const end = src.indexOf("\n", i);
      i = end < 0 ? src.length : end;
    } else if (src.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < src.length && depth > 0) {
        if (src.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (src.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      code += " ";
    } else if (src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3);
      strings.push(src.slice(i + 3, end < 0 ? src.length : end));
      i = end < 0 ? src.length : end + 3;
      code += '""';
    } else if (src[i] === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== '"' && src[j] !== "\n") {
        if (src[j] === "\\") {
          s += src.slice(j, j + 2);
          j += 2;
        } else if (src.startsWith("${", j)) {
          let depth = 0;
          while (j < src.length) {
            if (src[j] === "{") depth++;
            if (src[j] === "}") {
              depth--;
              if (depth === 0) {
                j++;
                break;
              }
            }
            j++;
          }
        } else {
          s += src[j++];
        }
      }
      strings.push(s);
      i = j + 1;
      code += '""';
    } else if (src[i] === "'" && /^'(\\.|[^\\'])'/.test(src.slice(i, i + 4))) {
      const m = src.slice(i).match(/^'(\\.|[^\\'])'/);
      i += m[0].length;
      code += "' '";
    } else {
      code += src[i++];
    }
  }
  return { strings, code };
}

const badCopy = (s) => /[–—!]/.test(s) || /tech/i.test(s);

const files = kotlinFiles(SRC_DIR);
const sources = Object.fromEntries(files.map((f) => [f, read(f)]));
const scanned = Object.fromEntries(files.map((f) => [f, scanKotlin(sources[f])]));
const allCode = files.map((f) => scanned[f].code).join("\n");
const fileNamed = (name) => sources[join(SRC_DIR, name)] ?? "";

ok(files.length >= 5, `the module has its Kotlin files (${files.map((f) => rel(f)).join(", ")})`);

// ── 1. Constants and copy ────────────────────────────────────────────────
const model = fileNamed("ShiftSurfaceModel.kt");
const constant = (name) => {
  const m = model.match(new RegExp(`(?:const )?val ${name}(?::[^=]+)? = (.+)$`, "m"));
  if (!m) return undefined;
  const v = m[1].trim();
  if (v.startsWith('"')) return JSON.parse(v);
  if (v.startsWith("listOf(")) return JSON.parse(`[${v.slice("listOf(".length, -1)}]`);
  return Number(v.replace(/_/g, "").replace(/L$/, ""));
};
const shiftSurfaceTs = read(join(ROOT, "src/shift-surface.ts"));
const jsTaskName = shiftSurfaceTs.match(/SHIFT_ACTION_TASK_NAME = "([^"]+)"/)?.[1];
eq(constant("SCHEMA_VERSION"), SURFACE_SCHEMA_VERSION, "schema version");
eq(constant("PREFS_FILE"), SURFACE_ANDROID_PREFS, "SharedPreferences file");
eq(constant("STATE_KEY"), SURFACE_KEYS.state, "state key");
eq(constant("INBOX_KEY"), SURFACE_KEYS.inbox, "inbox key");
eq(constant("DISMISSAL_KEY"), SURFACE_KEYS.dismissal, "dismissal key");
eq(constant("ACTIVITY_KEY"), SURFACE_KEYS.activity, "activity key");
eq(constant("OPEN_URL"), SURFACE_OPEN_URL, "open URL");
eq(constant("PENDING_STALE_MS"), PENDING_STALE_MS, "pending stale time");
eq(constant("SAME_SHIFT_TOLERANCE_MS"), SAME_SHIFT_TOLERANCE_MS, "same-shift tolerance");
eq(constant("FINAL_CARD_MS"), FINAL_CARD_MS, "final card time");
eq(constant("HEADLESS_TASK"), jsTaskName, "headless task name matches SHIFT_ACTION_TASK_NAME");
eq(constant("TAP_KINDS"), ["out", "break_start", "break_end"], "tap kinds");
eq(constant("SOURCES"), ["live_activity", "widget", "notification"], "tap sources");
eq(constant("STATUSES"), ["off", "on", "break", "signed_out"], "statuses");
ok(constant("HEADLESS_TIMEOUT_MS") > 0 && constant("HEADLESS_TIMEOUT_MS") <= 60_000, "the headless task has a timeout of a minute or less");

const copyBlock = model.slice(model.indexOf("val values: Map<String, String> = linkedMapOf("));
const kotlinCopy = {};
for (const m of copyBlock.slice(0, copyBlock.indexOf("\n  )")).matchAll(/^\s+"(\w+)" to "((?:[^"\\]|\\.)*)",$/gm)) {
  kotlinCopy[m[1]] = JSON.parse(`"${m[2]}"`);
}
eq(kotlinCopy, SURFACE_COPY, "Kotlin default copy equals SURFACE_COPY");

// ── 2. Copy rules on every Kotlin string ─────────────────────────────────
for (const f of files) {
  eq(scanned[f].strings.filter(badCopy), [], `${rel(f)}: string literals follow the copy rules`);
}
const notifications = fileNamed("ShiftNotifications.kt");
ok(notifications.includes('SurfaceCopyDefaults.text("channelNameFixed")'), "channel name comes from the shared copy");
ok(notifications.includes('SurfaceCopyDefaults.text("channelDescriptionFixed")'), "channel description comes from the shared copy");

// ── 3. The module's surface ──────────────────────────────────────────────
const moduleKt = fileNamed("CloxShiftSurfaceModule.kt");
const jsName = shiftSurfaceTs.match(/SHIFT_SURFACE_MODULE_NAME = "([^"]+)"/)?.[1];
eq(moduleKt.match(/Name\("([^"]+)"\)/)?.[1], jsName, "module name matches src/shift-surface.ts");
for (const fn of ["readSnapshot", "apply", "readInbox", "ackTaps", "signalTap", "clearAll"]) {
  ok(new RegExp(`\\b${fn}\\(`).test(shiftSurfaceTs), `src/shift-surface.ts declares ${fn}`);
  ok(new RegExp(`AsyncFunction(<[^>]+>)?\\("${fn}"\\)`).test(moduleKt), `module defines ${fn}`);
}
ok(moduleKt.includes('Constant("schemaVersion")'), "module exports schemaVersion");
ok(moduleKt.includes('Events("onTap")') && shiftSurfaceTs.includes('"onTap"'), "onTap event on both sides");
ok(/"platform", "android"/.test(moduleKt), "the snapshot says android");
const moduleConfig = JSON.parse(read(join(MODULE_DIR, "expo-module.config.json")));
ok(moduleConfig.platforms.includes("android") && moduleConfig.platforms.includes("apple"), "expo-module.config.json lists both platforms");
for (const fq of moduleConfig.android?.modules ?? []) {
  const cls = fq.split(".").pop();
  eq(fq.slice(0, fq.lastIndexOf(".")), PACKAGE, `${fq} is in the module's package`);
  ok(new RegExp(`class ${cls} : Module\\(\\)`).test(moduleKt), `expo-module.config.json names ${cls}, which exists`);
}
ok((moduleConfig.android?.modules ?? []).length === 1, "one Android module class");

// ── 4. The manifest ──────────────────────────────────────────────────────
const manifest = read(join(ANDROID_DIR, "src/main/AndroidManifest.xml"));
const manifestNoComments = manifest.replace(/<!--[\s\S]*?-->/g, "");
const components = [...manifestNoComments.matchAll(/<(receiver|service|activity)\b([^>]*)>/g)];
ok(components.length === 3, "manifest declares a receiver, an activity and a service");
for (const [, kind, attrs] of components) {
  const name = attrs.match(/android:name="([^"]+)"/)?.[1] ?? "";
  eq(attrs.match(/android:exported="([^"]+)"/)?.[1], "false", `${kind} ${name} is not exported`);
  ok(!/<intent-filter/.test(attrs), `${kind} ${name} has no intent filter`);
  const cls = name.split(".").pop();
  eq(name.slice(0, name.lastIndexOf(".")), PACKAGE, `${kind} ${name} is in the module's package`);
  ok(new RegExp(`class ${cls} : `).test(allCode), `${kind} ${cls} exists in the Kotlin`);
}
ok(!/<intent-filter/.test(manifestNoComments), "no intent filters at all");
ok(!/RECEIVE_BOOT_COMPLETED|BOOT_COMPLETED/.test(manifestNoComments), "no boot permission or boot receiver (decision 6)");
ok(!/FOREGROUND_SERVICE|foregroundServiceType/.test(manifestNoComments), "no foreground service");
ok(!/POST_PROMOTED_NOTIFICATIONS/.test(manifestNoComments), "no Android 16 promoted notification permission (decision 5: later)");
ok(/android\.permission\.POST_NOTIFICATIONS/.test(manifestNoComments), "declares POST_NOTIFICATIONS");
ok(/android\.permission\.WAKE_LOCK/.test(manifestNoComments), "declares WAKE_LOCK (HeadlessJsTaskService takes a wake lock outside any try)");
ok(/Theme\.Translucent\.NoTitleBar/.test(manifestNoComments) && /android:noHistory="true"/.test(manifestNoComments), "the tap activity has no UI and no history");
const gradle = read(join(ANDROID_DIR, "build.gradle"));
ok(new RegExp(`namespace "${PACKAGE.replace(/\./g, "\\.")}"`).test(gradle), "gradle namespace is the package");
ok(/id 'expo-module-gradle-plugin'/.test(gradle), "gradle applies the Expo module plugin");
ok(/implementation 'com\.facebook\.react:react-android'/.test(gradle), "gradle depends on react-android (headless JS)");

// ── 5. The plan's rules in the Kotlin ────────────────────────────────────
ok(!/java\.time|ZonedDateTime|LocalDateTime|DateTimeFormatter/.test(allCode), "no java.time (minSdk 24)");
ok(!/java\.net|HttpURLConnection|okhttp|OkHttpClient|fetch\(/i.test(allCode), "no network: native never calls the server");
ok(!/SecureStore|access_token|Keychain|Keystore/i.test(allCode), "native never touches the session");
ok(!/startForeground|startForegroundService|FOREGROUND_SERVICE/.test(allCode), "never a foreground service");
ok(!/FLAG_MUTABLE/.test(allCode), "no mutable PendingIntent");
const pendingCalls = [...allCode.matchAll(/PendingIntent\.get(Activity|Broadcast|Service)\(([^)]*)\)/g)];
ok(pendingCalls.length >= 3, "PendingIntents found");
for (const [call, , args] of pendingCalls) {
  ok(/IMMUTABLE\s*$/.test(args.trim()), `${call.slice(0, 40)}... is immutable`);
}
ok(/private val IMMUTABLE: Int = PendingIntent\.FLAG_UPDATE_CURRENT or PendingIntent\.FLAG_IMMUTABLE/.test(notifications), "IMMUTABLE is FLAG_IMMUTABLE");
ok(/Intent\(context, ShiftActionReceiver::class\.java\)/.test(notifications), "action broadcasts name the receiver explicitly");
ok(/Intent\(context, ShiftActionActivity::class\.java\)/.test(notifications), "Android 7 to 11 taps name the activity explicitly");
ok(/if \(launcher != null\) intent\.component = launcher/.test(notifications) && /intent\.setPackage\(context\.packageName\)/.test(notifications), "the open intent stays in this app");
ok(/Uri\.parse\(SurfaceContract\.OPEN_URL\)/.test(notifications), "the open intent is always clox://clock, never a URL from the state");
ok(/if \(Build\.VERSION\.SDK_INT >= 31\) builder\.setAuthenticationRequired\(true\)/.test(notifications), "actions need an unlocked phone on 12+ (decision 3)");
ok(/return if \(Build\.VERSION\.SDK_INT >= 31\) \{\s*val intent = Intent\(context, ShiftActionReceiver/.test(notifications), "12+ taps are broadcasts, older ones the activity");
ok(/NotificationManager\.IMPORTANCE_DEFAULT/.test(notifications) && !/IMPORTANCE_(LOW|MIN|HIGH)/.test(notifications), "the channel is DEFAULT importance");
ok(/channel\.setSound\(null, null\)/.test(notifications) && /channel\.enableVibration\(false\)/.test(notifications), "the channel has no sound and no vibration");
ok(/channel\.lockscreenVisibility = Notification\.VISIBILITY_PUBLIC/.test(notifications) && /\.setVisibility\(Notification\.VISIBILITY_PUBLIC\)/.test(notifications), "public on the lock screen");
ok(/\.setOngoing\(true\)/.test(notifications) && /\.setOnlyAlertOnce\(true\)/.test(notifications), "ongoing, alerts once");
ok(/setWhen\(base\.toLong\(\)\)\.setShowWhen\(true\)\.setUsesChronometer\(true\)/.test(notifications), "a chronometer from the shift or break start");
ok(/\.setDeleteIntent\(/.test(notifications), "a swipe is recorded (deleteIntent)");
ok(/SurfaceContract\.CHANNEL_ID/.test(notifications), "posts on the running-shift channel");
const actionsKt = fileNamed("ShiftActions.kt");
ok(/HeadlessJsTaskConfig\(\s*SurfaceContract\.HEADLESS_TASK,\s*data,\s*SurfaceContract\.HEADLESS_TIMEOUT_MS,\s*true,/.test(actionsKt), "the headless task is allowed in the foreground and has the timeout");
const wakeJs = actionsKt.slice(actionsKt.indexOf("fun wakeJs("), actionsKt.indexOf("\n  }\n", actionsKt.indexOf("fun wakeJs(")));
ok(wakeJs.length > 0 && !/\breturn\b/.test(wakeJs), "wakeJs never returns early: every tap starts the service");
ok(wakeJs.indexOf("context.startService(service)") >= 0 && wakeJs.indexOf("context.startService(service)") < wakeJs.indexOf("CloxShiftSurfaceModule.notifyTap(tapId)"), "the service starts first, then a listening JavaScript also gets the event");
ok(/if \(context\.startService\(service\) != null\) \{\s*(\/\/[^\n]*\n\s*)*HeadlessJsTaskService\.acquireWakeLockNow\(context\)/.test(actionsKt), "the wake lock is taken only once the service is on its way");
ok(/savedInstanceState == null/.test(actionsKt), "a recreated tap activity does not tap twice");
ok(/fun postFinal\(\s*context: Context,\s*title: String,\s*text: String,/.test(notifications) && /baseBuilder\(context, title\)/.test(notifications), "the final notification's title is short (the state's clockedOut copy)");
ok(/setContentText\(text\)\.setStyle\(Notification\.BigTextStyle\(\)\.bigText\(text\)\)/.test(notifications), "the final line is the body, which can wrap");
ok(/written\.state\.text\("clockedOut"\)/.test(moduleKt), "the final title comes from the state's copy");
ok(/text = notice\?\.text \?: state\.label \?: startedLine/.test(model) && /subText = if \(notice != null\) state\.label else if \(state\.label != null\) startedLine else null/.test(model), "a refusal notice is the notification's body, never the one-line header (as surfaceView)");
const storeKt = fileNamed("ShiftSurfaceStore.kt");
ok(/editor\.commit\(\)/.test(storeKt) && !/\.apply\(\)/.test(storeKt), "SharedPreferences writes are synchronous (commit)");
ok(/SurfaceRules\.tapApplies\(state, kind\)/.test(storeKt), "a tap is checked before it is saved");
ok(/UUID\.randomUUID\(\)\.toString\(\)\.lowercase\(Locale\.ROOT\)/.test(storeKt), "tap ids are lowercase UUIDs");
ok(/\.put\("userId", owner\)/.test(storeKt), "a tap is stamped with the state's owner");

// ── 6. Structure ─────────────────────────────────────────────────────────
for (const f of files) {
  const { code } = scanned[f];
  const count = (ch) => code.split(ch).length - 1;
  eq([count("("), count("{"), count("[")], [count(")"), count("}"), count("]")], `${rel(f)}: brackets balance`);
  ok(new RegExp(`^package ${PACKAGE.replace(/\./g, "\\.")}$`, "m").test(sources[f]), `${rel(f)}: package ${PACKAGE}`);
  ok(!/;\s*$/m.test(code.replace(/for \([^)]*\)/g, "")), `${rel(f)}: no stray semicolons`);
}
// Names declared anywhere in this module, and Object.member uses of this
// module's objects: a typo in a member name shows up here.
const declared = new Set([...allCode.matchAll(/\b(?:fun|val|var|class|object)\s+(?:<[^>]+>\s*)?([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]));
const objects = [...allCode.matchAll(/\bobject\s+([A-Z][A-Za-z0-9_]*)/g)].map((m) => m[1]);
ok(objects.length >= 6, `module objects found (${objects.join(", ")})`);
const missing = [];
for (const obj of [...objects, "CloxShiftSurfaceModule", "NotificationView", "SurfaceState"]) {
  for (const m of allCode.matchAll(new RegExp(`\\b${obj}\\.([A-Za-z_][A-Za-z0-9_]*)`, "g"))) {
    if (!declared.has(m[1])) missing.push(`${obj}.${m[1]}`);
  }
}
eq([...new Set(missing)], [], "every Object.member this module uses is declared");
// Imports: each one is used in its file.
for (const f of files) {
  const unused = [...sources[f].matchAll(/^import ([\w.]+)$/gm)]
    .map((m) => m[1])
    .filter((imp) => {
      const name = imp.split(".").pop();
      const body = scanned[f].code.replace(/^import .*$/gm, "");
      return !new RegExp(`\\b${name}\\b`).test(body);
    });
  eq(unused, [], `${rel(f)}: every import is used`);
}

// ── 7. The notification icon ─────────────────────────────────────────────
const appJson = JSON.parse(read(join(ROOT, "app.json")));
const notifPlugin = appJson.expo.plugins.find((p) => Array.isArray(p) && p[0] === "expo-notifications");
const iconPath = notifPlugin?.[1]?.icon;
eq(iconPath, "./assets/notification-icon.png", "expo-notifications has the monochrome icon");
const png = readFileSync(join(ROOT, iconPath ?? "missing"));
eq(png.subarray(1, 4).toString("latin1"), "PNG", "icon is a PNG");
eq([png.readUInt32BE(16), png.readUInt32BE(20)], [96, 96], "icon is 96 x 96 (24 dp at xxxhdpi)");
eq(png[25], 6, "icon has an alpha channel (RGBA)");
ok(/"notification_icon"/.test(notifications), "the notification looks up the drawable expo-notifications writes");

// ── Notes for the JavaScript wiring (not failures) ───────────────────────
const indexJs = read(join(ROOT, "index.js"));
if (!indexJs.includes("SHIFT_ACTION_TASK_NAME") && !indexJs.includes(jsTaskName)) {
  console.log(`NOTE: index.js does not register the "${jsTaskName}" headless task yet (the JavaScript wiring does).`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
