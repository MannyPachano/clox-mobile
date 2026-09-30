// Checks the iOS side of the lock-screen surfaces against the TypeScript
// spec (src/shift-surface-state.ts). No Xcode needed.
// Run: node scripts/shift-surface-native-check.mjs
//
//   1. The two copies of ShiftSurfaceModel.swift and of ShiftAttributes.swift
//      (the app's module and the widget extension) are byte-identical.
//   2. The Swift contract constants and default copy equal the TypeScript.
//   3. Every string literal in the Swift, the widget's Info.plist and its
//      target config follows the copy rules.
//   4. The module registers what src/shift-surface.ts calls.
//   5. With swiftc on the PATH: every Swift file parses, and the Swift rules
//      (compiled for this Mac with a small driver) give the same answers as
//      the TypeScript for a few hundred states. Without swiftc, 5 is skipped
//      and says so.
import { Buffer } from "node:buffer";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PENDING_STALE_MS,
  SAME_SHIFT_TOLERANCE_MS,
  SURFACE_APP_GROUP,
  SURFACE_COPY,
  SURFACE_KEYS,
  SURFACE_OPEN_URL,
  SURFACE_SCHEMA_VERSION,
  applyTap,
  buildSurfaceState,
  fillTime,
  parseState,
  sameShift,
  surfaceView,
  tapApplies,
} from "../src/shift-surface-state.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_DIR = join(ROOT, "modules/clox-shift-surface");
const POD_DIR = join(MODULE_DIR, "ios");
const WIDGET_DIR = join(ROOT, "targets/widget");

let pass = 0;
let fail = 0;
const canon = (x) =>
  JSON.stringify(x, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
      : v,
  );
const eq = (a, b, msg) => {
  if (canon(a) === canon(b)) pass++;
  else {
    fail++;
    console.log("FAIL:", msg, "\n  got ", canon(a), "\n  want", canon(b));
  }
};
const ok = (cond, msg) => eq(!!cond, true, msg);
const read = (p) => readFileSync(p, "utf8");
const rel = (p) => relative(ROOT, p);

function swiftFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...swiftFiles(p));
    else if (name.endsWith(".swift")) out.push(p);
  }
  return out.sort();
}

/** Swift string literals, with comments skipped. Enough for this code:
 *  escapes and interpolations without nested quotes. */
function swiftStrings(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("//", i)) {
      const end = src.indexOf("\n", i);
      i = end < 0 ? src.length : end;
    } else if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3);
      out.push(src.slice(i + 3, end < 0 ? src.length : end));
      i = end < 0 ? src.length : end + 3;
    } else if (src[i] === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== '"' && src[j] !== "\n") {
        if (src[j] === "\\") {
          s += src.slice(j, j + 2);
          j += 2;
        } else {
          s += src[j++];
        }
      }
      out.push(s);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out;
}

const badCopy = (s) => /[–—!]/.test(s) || /tech/i.test(s);

// ── 1. The shared copies ─────────────────────────────────────────────────
for (const name of ["ShiftSurfaceModel.swift", "ShiftAttributes.swift"]) {
  eq(read(join(WIDGET_DIR, name)) === read(join(POD_DIR, name)), true, `${name}: widget copy equals the module's`);
}

// ── 2. Constants and copy ────────────────────────────────────────────────
const model = read(join(POD_DIR, "ShiftSurfaceModel.swift"));
const constant = (name) => {
  const m = model.match(new RegExp(`static let ${name}(?::[^=]+)? = (.+)$`, "m"));
  if (!m) return undefined;
  const v = m[1].trim();
  if (v.startsWith('"')) return JSON.parse(v);
  if (v.startsWith("[")) return JSON.parse(v);
  return Number(v.replace(/_/g, ""));
};
eq(constant("schemaVersion"), SURFACE_SCHEMA_VERSION, "schema version");
eq(constant("appGroup"), SURFACE_APP_GROUP, "App Group");
eq(constant("stateKey"), SURFACE_KEYS.state, "state key");
eq(constant("inboxKey"), SURFACE_KEYS.inbox, "inbox key");
eq(constant("dismissalKey"), SURFACE_KEYS.dismissal, "dismissal key");
eq(constant("activityKey"), SURFACE_KEYS.activity, "activity key");
eq(constant("openURL"), SURFACE_OPEN_URL, "open URL");
eq(constant("pendingStaleMs"), PENDING_STALE_MS, "pending stale time");
eq(constant("sameShiftToleranceMs"), SAME_SHIFT_TOLERANCE_MS, "same-shift tolerance");
eq(constant("tapKinds"), ["out", "break_start", "break_end"], "tap kinds");
eq(constant("sources"), ["live_activity", "widget", "notification"], "tap sources");

const copyBlock = model.slice(model.indexOf("static let values: [String: String] = ["));
const swiftCopy = {};
for (const m of copyBlock.slice(0, copyBlock.indexOf("\n  ]")).matchAll(/^\s+"(\w+)": "((?:[^"\\]|\\.)*)",$/gm)) {
  swiftCopy[m[1]] = JSON.parse(`"${m[2]}"`);
}
eq(swiftCopy, SURFACE_COPY, "Swift default copy equals SURFACE_COPY");

// ── 3. Copy rules on everything native shows ─────────────────────────────
const nativeSwift = [...swiftFiles(POD_DIR), ...swiftFiles(WIDGET_DIR)];
for (const file of nativeSwift) {
  const bad = swiftStrings(read(file)).filter(badCopy);
  eq(bad, [], `${rel(file)}: string literals follow the copy rules`);
}
const plistStrings = [...read(join(WIDGET_DIR, "Info.plist")).matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
eq(plistStrings.filter(badCopy), [], "widget Info.plist follows the copy rules");
const targetConfig = read(join(WIDGET_DIR, "expo-target.config.js"));
eq(targetConfig.match(/displayName: "([^"]*)"/)?.[1], SURFACE_COPY.widgetNameFixed, "widget display name");
eq(targetConfig.match(/deploymentTarget: "([^"]*)"/)?.[1], "17.0", "widget deployment target 17.0");
eq(targetConfig.match(/bundleIdentifier: "([^"]*)"/)?.[1], ".widget", "widget bundle id is the app's plus .widget");
const widgetSwift = read(join(WIDGET_DIR, "ShiftHomeWidget.swift"));
ok(widgetSwift.includes('SurfaceCopyDefaults.text("widgetNameFixed")'), "widget gallery name comes from the shared copy");
ok(widgetSwift.includes('SurfaceCopyDefaults.text("widgetDescriptionFixed")'), "widget gallery description comes from the shared copy");

// ── 4. The module's surface ──────────────────────────────────────────────
const moduleSwift = read(join(POD_DIR, "CloxShiftSurfaceModule.swift"));
const wrapper = read(join(ROOT, "src/shift-surface.ts"));
const jsName = wrapper.match(/SHIFT_SURFACE_MODULE_NAME = "([^"]+)"/)?.[1];
eq(moduleSwift.match(/Name\("([^"]+)"\)/)?.[1], jsName, "module name matches src/shift-surface.ts");
for (const fn of ["readSnapshot", "apply", "readInbox", "ackTaps", "signalTap", "clearAll"]) {
  ok(new RegExp(`\\b${fn}\\(`).test(wrapper), `src/shift-surface.ts declares ${fn}`);
  ok(moduleSwift.includes(`AsyncFunction("${fn}")`), `module defines ${fn}`);
}
ok(moduleSwift.includes('Constant("schemaVersion")'), "module exports schemaVersion");
ok(moduleSwift.includes('Events("onTap")') && wrapper.includes('"onTap"'), "onTap event on both sides");
const moduleConfig = JSON.parse(read(join(MODULE_DIR, "expo-module.config.json")));
ok(moduleConfig.apple.modules.every((c) => moduleSwift.includes(`class ${c}: Module`)), "expo-module.config.json names the Swift class");
const podspec = read(join(POD_DIR, "CloxShiftSurface.podspec"));
eq(podspec.match(/s\.name\s*=\s*'([^']+)'/)?.[1], "CloxShiftSurface", "pod name (the Swift module the app's intent imports)");
ok(/:ios => '15\.1'/.test(podspec), "pod targets the app's iOS 15.1");
ok(/weak_frameworks = 'ActivityKit', 'AppIntents'/.test(podspec), "ActivityKit and AppIntents are weak-linked");
const intents = read(join(WIDGET_DIR, "_shared/ShiftIntents.swift"));
ok(/#if canImport\(CloxShiftSurface\)/.test(intents), "the intent reaches the module only where it can import it");
ok(intents.includes("CloxShiftSurfaceIntents.handleTap(action: action, source: source)"), "the intent hands the tap to the module");
ok(read(join(POD_DIR, "ShiftSurfaceStore.swift")).includes("public enum CloxShiftSurfaceIntents"), "the tap entry point is public");

// ── 5. Swift parses, and gives the TypeScript's answers ─────────────────
const hasSwiftc = spawnSync("swiftc", ["--version"], { encoding: "utf8" }).status === 0;
if (!hasSwiftc) {
  console.log("SKIP: swiftc is not on the PATH, so the Swift was not parsed or compared.");
} else {
  for (const file of [...nativeSwift, join(ROOT, "scripts/shift-surface-native-driver.swift")]) {
    const r = spawnSync("swiftc", ["-parse", file], { encoding: "utf8" });
    eq(r.status === 0 ? "" : r.stderr.trim(), "", `${rel(file)} parses`);
  }

  const dir = mkdtempSync(join(tmpdir(), "clox-surface-"));
  try {
    copyFileSync(join(POD_DIR, "ShiftSurfaceModel.swift"), join(dir, "ShiftSurfaceModel.swift"));
    copyFileSync(join(ROOT, "scripts/shift-surface-native-driver.swift"), join(dir, "main.swift"));
    execFileSync("swiftc", ["-O", "-o", join(dir, "driver"), join(dir, "ShiftSurfaceModel.swift"), join(dir, "main.swift")], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    compare(join(dir, "driver"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function compare(driver) {
  const H = 60 * 60_000;
  const M = 60_000;
  const NOW = Date.UTC(2026, 8, 29, 21, 0, 0);
  const START = NOW - 3 * H;
  const fmt = (ms) => `T${Math.round((ms - START) / M)}`;
  const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const base = {
    enabled: true,
    userId: "user-a",
    shiftStartMs: START,
    breakStartMs: null,
    projectId: "p1",
    projectName: "Service Calls",
    taskName: "Riverside Heights",
    requireProject: false,
    orgTimeZone: "America/New_York",
  };
  const built = (over = {}) => buildSurfaceState({ ...base, ...over }, NOW, fmt);

  // Hand-picked states, then variations of each.
  const states = [
    null,
    "not an object",
    [],
    {},
    built(),
    built({ userId: null }),
    built({ shiftStartMs: null }),
    built({ enabled: false }),
    built({ breakStartMs: NOW - 5 * M }),
    built({ requireProject: true, projectId: null }),
    built({ projectName: null, taskName: null }),
    built({ taskName: null }),
    { ...built(), startedAtText: null },
    { ...built(), v: 2 },
    { ...built(), v: "1" },
    { ...built(), status: "paused" },
    { ...built(), enabled: 1 },
    { ...built(), enabled: "true" },
    { ...built(), needsProjectToClockOut: 1 },
    { ...built(), shiftStartMs: "123" },
    { ...built(), shiftStartMs: true },
    { ...built(), ownerUserId: "" },
    { ...built(), label: "" },
    { ...built(), copy: { clockOut: "Sign out", takeBreak: 5, started: "" } },
    { ...built(), copy: "nope" },
    { ...built(), copy: undefined },
    { ...built(), notice: { kind: "out", text: "Clock-out didn't go through. Open Clox." } },
    { ...built(), notice: { kind: "break_start", text: "" } },
    { ...built(), notice: { kind: "nope", text: "x" } },
    { ...built(), notice: [] },
    { ...built({ breakStartMs: NOW - 5 * M }), notice: { kind: "break_end", text: "Your break didn't end. Open Clox." } },
  ];
  for (const kind of ["out", "break_start", "break_end"]) {
    for (const ago of [10_000, PENDING_STALE_MS, PENDING_STALE_MS + 1]) {
      states.push(applyTap(built(), { id: ID, kind, tapMs: NOW - ago }, NOW));
      states.push(applyTap(built({ breakStartMs: NOW - 5 * M }), { id: ID, kind, tapMs: NOW - ago }, NOW));
    }
  }
  states.push({ ...built(), pendingTap: { id: ID.toUpperCase(), kind: "out", tapMs: NOW } });
  states.push({ ...built(), pendingTap: { id: "", kind: "out", tapMs: NOW } });
  states.push({ ...built(), pendingTap: { id: ID, kind: "lunch", tapMs: NOW } });
  states.push({ ...built(), pendingTap: { id: ID, kind: "out", tapMs: "soon" } });
  states.push({ ...built({ requireProject: true, projectId: null }), pendingTap: { id: ID, kind: "out", tapMs: NOW } });

  // Seeded variations: flip one or two fields of a known state.
  let seed = 7;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const values = [null, undefined, 0, 1, -1, true, false, "", "x", "off", "on", "break", "signed_out", NOW, START, [], {}];
  const fields = [
    "v", "enabled", "status", "ownerUserId", "shiftStartMs", "breakStartMs", "projectId", "label",
    "startedAtText", "orgTimeZone", "needsProjectToClockOut", "pendingTap", "notice", "updatedMs",
  ];
  const seeds = states.filter((s) => s && typeof s === "object" && !Array.isArray(s) && s.v === 1);
  for (let n = 0; n < 400; n++) {
    const s = { ...seeds[rand(seeds.length)] };
    for (let k = 0; k <= rand(2); k++) s[fields[rand(fields.length)]] = values[rand(values.length)];
    states.push(JSON.parse(JSON.stringify(s)));
  }
  const clean = states.map((s) => (s === undefined ? null : JSON.parse(JSON.stringify(s))));

  const cases = [];
  const want = [];
  for (const raw of clean) {
    cases.push({ op: "parse", raw });
    want.push(parseState(raw));
    for (const nowMs of [NOW, NOW + PENDING_STALE_MS]) {
      cases.push({ op: "view", raw, nowMs });
      const v = surfaceView(parseState(raw), nowMs);
      want.push({ activity: v.activity, widget: v.widget });
    }
    for (const kind of ["out", "break_start", "break_end"]) {
      cases.push({ op: "tapApplies", raw, kind });
      want.push(tapApplies(parseState(raw), kind));
    }
    // Swift is stricter than the TypeScript here, on purpose: the kind comes
    // from an intent parameter, and an unknown one is refused. (The
    // TypeScript's type never allows one.)
    cases.push({ op: "tapApplies", raw, kind: "lunch" });
    want.push(false);
    const parsed = parseState(raw);
    if (parsed) {
      cases.push({ op: "applyTap", raw, id: ID, kind: "out", tapMs: NOW - 1, nowMs: NOW });
      want.push({ parseOf: applyTap(parsed, { id: ID, kind: "out", tapMs: NOW - 1 }, NOW) });
      const activity = surfaceView(parsed, NOW).activity;
      if (activity.show) {
        cases.push({ op: "parseView", raw: activity });
        want.push(activity);
      }
    }
  }
  for (const [template, time] of [["Started {time}", "9:42 AM"], ["Started {time}", null], ["Clock out", null], ["{time} and {time}", "x"]]) {
    cases.push({ op: "fillTime", template, time });
    want.push(fillTime(template, time));
  }
  for (const [a, b] of [[START, START + SAME_SHIFT_TOLERANCE_MS], [START, START + SAME_SHIFT_TOLERANCE_MS + 1], [null, START], [START, "x"]]) {
    cases.push({ op: "sameShift", a, b });
    want.push(sameShift(a, b));
  }

  const out = execFileSync(driver, { input: JSON.stringify(cases), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const got = JSON.parse(out);
  eq(got.length, cases.length, "the driver answered every case");
  let same = 0;
  const firstDiffs = [];
  for (let i = 0; i < cases.length; i++) {
    let g = got[i];
    if (cases[i].op === "applyTap") g = { parseOf: parseState(g) };
    if (canon(g) === canon(want[i])) same++;
    else if (firstDiffs.length < 5) firstDiffs.push({ case: cases[i], got: g, want: want[i] });
  }
  for (const d of firstDiffs) {
    console.log("FAIL: Swift and TypeScript differ\n  case", canon(d.case).slice(0, 400), "\n  got ", canon(d.got), "\n  want", canon(d.want));
  }
  eq(same, cases.length, `Swift rules equal the TypeScript on ${cases.length} cases`);

  // The Live Activity's content stays far under ActivityKit's 4 KB with the
  // longest names the app sends (60 characters each).
  const long = built({ projectName: "P".repeat(60), taskName: "T".repeat(60) });
  const biggest = [surfaceView(long, NOW).activity, surfaceView(applyTap(long, { id: ID, kind: "out", tapMs: NOW }, NOW), NOW).activity];
  const sizes = JSON.parse(
    execFileSync(driver, {
      input: JSON.stringify(biggest.map((raw) => ({ op: "content", raw, finalText: SURFACE_COPY.savedOffline }))),
      encoding: "utf8",
    }),
  ).map((c) => Buffer.byteLength(JSON.stringify(c)));
  ok(sizes.every((n) => n > 0 && n < 2048), `Live Activity content is small (${sizes.join(", ")} bytes)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
