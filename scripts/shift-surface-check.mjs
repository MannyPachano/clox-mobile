// Standalone check of the lock-screen surface rules (src/shift-surface-state.ts)
// and the shared punch builder (src/punch-builders.ts).
// Run: node scripts/shift-surface-check.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSimplePunch } from "../src/punch-builders.ts";
import {
  ACTIVITY_MAX_MS,
  ACTIVITY_REPLACE_AFTER_MS,
  EMPTY_SNAPSHOT,
  FINAL_CARD_MS,
  HANDLED_IDS_CAP,
  MAX_NAME_CHARS,
  PENDING_STALE_MS,
  SURFACE_APP_COPY,
  SURFACE_COPY,
  SURFACE_OPEN_URL,
  allCopyStrings,
  applyTap,
  applyTapOutcome,
  buildSurfaceState,
  carryPendingTap,
  fillTime,
  isDismissed,
  parseActivityRecord,
  parseDismissal,
  parseInbox,
  parseSnapshot,
  parseState,
  planActivity,
  planInbox,
  planNotification,
  planNotificationAsk,
  projectTaskLabel,
  sameShift,
  surfaceView,
  tapApplies,
} from "../src/shift-surface-state.ts";

let pass = 0,
  fail = 0;
const eq = (a, b, msg) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) pass++;
  else {
    fail++;
    console.log("FAIL:", msg, "\n  got ", JSON.stringify(a), "\n  want", JSON.stringify(b));
  }
};
const ok = (cond, msg) => eq(!!cond, true, msg);

const H = 60 * 60_000;
const M = 60_000;
const NOW = Date.UTC(2026, 8, 29, 21, 0, 0);
const START = NOW - 3 * H; // shift began three hours ago
const fmt = (ms) => `T${Math.round((ms - START) / M)}`; // stand-in for clockInZone
const A = "user-a";
const B = "user-b";
const ID1 = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ID2 = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const ID3 = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";

const input = (over = {}) => ({
  enabled: true,
  userId: A,
  shiftStartMs: START,
  breakStartMs: null,
  projectId: "p1",
  projectName: "Service Calls",
  taskName: "Riverside Heights",
  requireProject: false,
  orgTimeZone: "America/New_York",
  ...over,
});
const state = (over = {}, now = NOW) => buildSurfaceState(input(over), now, fmt);
const tap = (over = {}) => ({
  v: 1,
  id: ID1,
  kind: "out",
  tapMs: NOW - 10_000,
  userId: A,
  projectId: "p1",
  source: "live_activity",
  ...over,
});

// ── Copy rules ──────────────────────────────────────────────────────────
const badChars = (s) => /[–—!]/.test(s) || /tech/i.test(s);
for (const s of allCopyStrings()) ok(!badChars(s), `copy rule: ${JSON.stringify(s)}`);
const sentences = [
  "breakShiftSince", "takeBreakA11y", "endBreakA11y", "clockOutA11y", "clockOutOpensA11y", "clockInA11y",
  "notClockedIn", "openToSignIn", "openToSee", "pendingOut", "pendingBreakStart",
  "pendingBreakEnd", "stale", "clockedOutAt", "clockedOut", "savedOffline", "refusedOut",
  "refusedBreakStart", "refusedBreakEnd", "widgetDescriptionFixed", "channelDescriptionFixed",
];
for (const k of sentences) ok(/[.]$/.test(SURFACE_COPY[k]), `complete sentence: ${k}`);
ok(/[.]$/.test(SURFACE_APP_COPY.askMessage), "ask message is a sentence");
ok(/[?]$/.test(SURFACE_APP_COPY.askTitle), "ask title is a question");
ok(/[.]$/.test(SURFACE_APP_COPY.otherAccountTap), "other-account line is a sentence");
eq(fillTime("Started {time}", "9:42 AM"), "Started 9:42 AM", "fillTime fills");
eq(fillTime("Started {time}", null), null, "fillTime without a time drops the line");
eq(fillTime("Clock out", null), "Clock out", "fillTime leaves plain text");

// The pure modules stay pure: type-only imports, no Intl, no clock reads.
const here = dirname(fileURLToPath(import.meta.url));
for (const f of ["src/shift-surface-state.ts", "src/punch-builders.ts"]) {
  const src = readFileSync(join(here, "..", f), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  ok(!/\bIntl\b/.test(code), `${f}: no Intl`);
  ok(!/Date\.now\(/.test(code), `${f}: no Date.now`);
  const imports = code.match(/^import .*$/gm) ?? [];
  ok(imports.every((l) => l.startsWith("import type ")), `${f}: type-only imports`);
}

// ── Labels and building the state ───────────────────────────────────────
eq(projectTaskLabel("Service Calls", "Riverside Heights"), "Service Calls · Riverside Heights", "Project · Task");
eq(projectTaskLabel("Service Calls", null), "Service Calls", "project only");
eq(projectTaskLabel(null, "Riverside"), null, "a task never shows without its project");
eq(projectTaskLabel("  ", "x"), null, "blank project");
const long = "x".repeat(200);
const cutLabel = projectTaskLabel(long, long);
ok(cutLabel.length <= MAX_NAME_CHARS * 2 + 3 && cutLabel.includes("…"), "long names are cut");

const so = state({ userId: null });
eq([so.status, so.ownerUserId, so.shiftStartMs], ["signed_out", null, null], "no user: signed out");
const off = state({ shiftStartMs: null });
eq([off.status, off.ownerUserId, off.label], ["off", A, null], "no shift: off");
const on = state();
eq(
  [on.v, on.status, on.shiftStartMs, on.label, on.startedAtText, on.needsProjectToClockOut, on.pendingTap, on.notice],
  [1, "on", START, "Service Calls · Riverside Heights", "T0", false, null, null],
  "running shift",
);
const brk = state({ breakStartMs: NOW - 5 * M });
eq([brk.status, brk.breakStartMs], ["break", NOW - 5 * M], "on break");
eq(state({ requireProject: true, projectId: null }).needsProjectToClockOut, true, "project required and missing");
eq(state({ requireProject: true }).needsProjectToClockOut, false, "project required and present");
eq(state({ enabled: false }).enabled, false, "off switch carried");

// ── What each surface shows ─────────────────────────────────────────────
let v = surfaceView(so, NOW);
eq([v.activity.show, v.notification.show, v.widget.mode, v.widget.line3], [false, false, "signed_out", SURFACE_COPY.openToSignIn], "signed out view");
v = surfaceView(state({ enabled: false }), NOW);
eq([v.activity.show, v.notification.show, v.widget.mode, v.widget.button], [false, false, "disabled", null], "off switch view");
v = surfaceView(off, NOW);
eq([v.activity.show, v.notification.show, v.widget.mode], [false, false, "off"], "clocked out view");
eq(v.widget.button, { kind: "open", label: "Clock in", a11y: SURFACE_COPY.clockInA11y }, "widget Clock in only opens Clox (decision 2)");
eq(v.widget.openUrl, SURFACE_OPEN_URL, "widget opens the Clock screen");
v = surfaceView(on, NOW);
eq(
  [v.activity.eyebrow, v.activity.timer, v.activity.line2, v.activity.line3, v.activity.buttons.map((b) => b.kind)],
  ["ON THE CLOCK", { startMs: START, pausedAtMs: null }, "Service Calls · Riverside Heights", "Started T0", ["break_start", "out"]],
  "on: live activity",
);
eq([v.widget.mode, v.widget.button.kind], ["on", "out"], "on: widget clock out");
eq(
  [v.notification.title, v.notification.text, v.notification.subText, v.notification.chronometerBaseMs, v.notification.actions.map((a) => a.kind)],
  ["On the clock", "Service Calls · Riverside Heights", "Started T0", START, ["break_start", "out"]],
  "on: notification",
);
v = surfaceView(brk, NOW);
eq(
  [v.activity.eyebrow, v.activity.timer.startMs, v.activity.line3, v.activity.buttons.map((b) => b.kind), v.activity.phase],
  ["ON BREAK", NOW - 5 * M, "Your shift started at T0.", ["break_end", "out"], "break"],
  "break: timer counts the break",
);
v = surfaceView(state({ requireProject: true, projectId: null, projectName: null }), NOW);
eq(v.activity.buttons[1], { kind: "open", label: "Clock out", a11y: SURFACE_COPY.clockOutOpensA11y }, "no project: Clock out opens Clox");
eq(v.notification.actions.map((a) => a.kind), ["break_start"], "no project: no Clock out action on the notification");
eq([v.notification.text, v.notification.subText], ["Started T0", null], "no label: the start line leads");

const pendOut = applyTap(on, { id: ID1, kind: "out", tapMs: NOW - 10_000 }, NOW);
v = surfaceView(pendOut, NOW);
eq(
  [v.activity.eyebrow, v.activity.timer, v.activity.line3, v.activity.buttons, v.activity.staleAtMs, v.activity.staleText],
  ["CLOCKING OUT", { startMs: START, pausedAtMs: NOW - 10_000 }, SURFACE_COPY.pendingOut, [], NOW - 10_000 + PENDING_STALE_MS, SURFACE_COPY.stale],
  "pending clock-out stops the timer at the tap",
);
eq([v.widget.mode, v.widget.button, v.notification.actions, v.notification.chronometerBaseMs], ["pending", null, [], null], "pending: no buttons anywhere");
v = surfaceView(pendOut, NOW - 10_000 + PENDING_STALE_MS);
eq([v.activity.line3, v.widget.line3], [SURFACE_COPY.stale, SURFACE_COPY.stale], "pending past two minutes: Open Clox to send it");
v = surfaceView(applyTap(on, { id: ID1, kind: "break_start", tapMs: NOW - 1000 }, NOW), NOW);
eq([v.activity.phase, v.activity.eyebrow, v.activity.timer.startMs, v.activity.line3], ["break", "ON BREAK", NOW - 1000, SURFACE_COPY.pendingBreakStart], "pending break start");
v = surfaceView(applyTap(brk, { id: ID1, kind: "break_end", tapMs: NOW - 1000 }, NOW), NOW);
eq([v.activity.phase, v.activity.timer.startMs, v.activity.line3], ["on", START, SURFACE_COPY.pendingBreakEnd], "pending break end");
v = surfaceView(null, NOW);
eq(v.widget.mode, "signed_out", "no state: signed out look");
v = surfaceView({ ...on, v: 2 }, NOW);
eq([v.widget.mode, v.activity.show], ["signed_out", false], "unknown schema: ignored");

// No surface state ever offers a clock-in tap, and every "open" goes to the Clock screen.
const allStates = [so, off, on, brk, pendOut, state({ enabled: false }), state({ requireProject: true, projectId: null })];
for (const s of allStates) {
  const view = surfaceView(s, NOW);
  const buttons = [
    ...(view.activity.show ? view.activity.buttons : []),
    ...(view.widget.button ? [view.widget.button] : []),
    ...(view.notification.show ? view.notification.actions : []),
  ];
  ok(buttons.every((b) => ["open", "out", "break_start", "break_end"].includes(b.kind)), `no clock-in tap in ${s.status}`);
  const strings = JSON.stringify(view).match(/"(?:[^"\\]|\\.)*"/g) ?? [];
  ok(strings.every((q) => !badChars(q)), `view strings follow the copy rules (${s.status})`);
}
// A long label keeps the Live Activity payload small (4 KB limit).
v = surfaceView(state({ projectName: long, taskName: long }), NOW);
ok(JSON.stringify(v.activity).length < 1500, "activity payload stays small with long names");

// ── Taps ────────────────────────────────────────────────────────────────
eq(["break_start", "break_end", "out"].map((k) => tapApplies(on, k)), [true, false, true], "on: which taps apply");
eq(["break_start", "break_end", "out"].map((k) => tapApplies(brk, k)), [false, true, true], "break: which taps apply");
for (const s of [so, off, state({ enabled: false }), pendOut]) {
  eq(["break_start", "break_end", "out"].map((k) => tapApplies(s, k)), [false, false, false], `no taps apply (${s.status}${s.pendingTap ? ", pending" : ""}${s.enabled ? "" : ", disabled"})`);
}
eq(tapApplies(state({ requireProject: true, projectId: null }), "out"), false, "no project: clock-out tap does not apply");
eq(tapApplies(null, "out"), false, "no state: nothing applies");
eq([pendOut.pendingTap, pendOut.notice], [{ id: ID1, kind: "out", tapMs: NOW - 10_000 }, null], "applyTap marks pending");

// ── Outcomes ────────────────────────────────────────────────────────────
let r = applyTapOutcome(pendOut, { id: ID1, kind: "out", tapMs: NOW - 10_000 }, "sent", NOW, fmt);
eq([r.state.status, r.state.shiftStartMs, r.state.pendingTap, r.state.label, r.state.ownerUserId], ["off", null, null, null, A], "clock-out sent: clocked out");
eq(r.finalCard, { text: `Clocked out at ${fmt(NOW - 10_000)}.`, dismissAtMs: NOW + FINAL_CARD_MS }, "clock-out sent: final line");
r = applyTapOutcome(pendOut, { id: ID1, kind: "out", tapMs: NOW - 10_000 }, "sent", NOW, () => "");
eq(r.finalCard.text, SURFACE_COPY.clockedOut, "clock-out sent without a time: plain line");
r = applyTapOutcome(pendOut, { id: ID1, kind: "out", tapMs: NOW - 10_000 }, "queued", NOW, fmt);
eq([r.state.status, r.finalCard.text], ["off", SURFACE_COPY.savedOffline], "clock-out queued offline");
r = applyTapOutcome(pendOut, { id: ID1, kind: "out", tapMs: NOW - 10_000 }, "refused", NOW, fmt);
eq([r.state.status, r.state.pendingTap, r.state.notice, r.finalCard], ["on", null, { kind: "out", text: SURFACE_COPY.refusedOut }, null], "clock-out refused: kept, with the notice");
eq(tapApplies(r.state, "out"), false, "after a refused clock-out the button opens Clox");
eq(surfaceView(r.state, NOW).activity.line3, SURFACE_COPY.refusedOut, "refusal notice shows");
eq(surfaceView(r.state, NOW).activity.buttons[1].kind, "open", "refused clock-out: button opens Clox");
v = surfaceView(r.state, NOW);
eq(
  [v.notification.text, v.notification.subText, v.notification.actions.map((a) => a.kind)],
  [SURFACE_COPY.refusedOut, "Service Calls · Riverside Heights", ["break_start"]],
  "refusal notice: the notification's body says it (subText is Android's one-line header)",
);
eq([v.widget.line2, v.widget.button.kind], [SURFACE_COPY.refusedOut, "open"], "refusal notice: the widget's one line says it, over the label");
v = surfaceView({ ...r.state, label: null }, NOW);
eq([v.notification.text, v.notification.subText, v.widget.line2], [SURFACE_COPY.refusedOut, null, SURFACE_COPY.refusedOut], "refusal notice without a label");
v = surfaceView(state({ projectName: null, taskName: null, breakStartMs: NOW - 5 * M }), NOW);
eq([v.notification.text, v.notification.subText, v.widget.line2, v.widget.line3], ["Your shift started at T0.", null, null, "Your shift started at T0."], "break with no label: the start line is the body");
const pendBrk = applyTap(on, { id: ID2, kind: "break_start", tapMs: NOW - 2000 }, NOW);
r = applyTapOutcome(pendBrk, { id: ID2, kind: "break_start", tapMs: NOW - 2000 }, "sent", NOW, fmt);
eq([r.state.status, r.state.breakStartMs, r.state.pendingTap, r.finalCard], ["break", NOW - 2000, null, null], "break start sent");
r = applyTapOutcome(pendBrk, { id: ID2, kind: "break_start", tapMs: NOW - 2000 }, "refused", NOW, fmt);
eq([r.state.status, r.state.notice.text], ["on", SURFACE_COPY.refusedBreakStart], "break start refused");
const pendEnd = applyTap(brk, { id: ID2, kind: "break_end", tapMs: NOW - 2000 }, NOW);
r = applyTapOutcome(pendEnd, { id: ID2, kind: "break_end", tapMs: NOW - 2000 }, "queued", NOW, fmt);
eq([r.state.status, r.state.breakStartMs], ["on", null], "break end queued");
r = applyTapOutcome(pendOut, { id: ID1, kind: "out", tapMs: NOW - 10_000 }, "not_sent", NOW, fmt);
eq([r.state.status, r.state.pendingTap, r.finalCard], ["on", null, null], "not sent: only the pending mark goes");
r = applyTapOutcome(pendOut, { id: ID3, kind: "break_start", tapMs: NOW }, "not_sent", NOW, fmt);
eq(r.state.pendingTap?.id, ID1, "another tap's outcome leaves this pending mark");
r = applyTapOutcome(off, { id: ID2, kind: "break_start", tapMs: NOW }, "sent", NOW, fmt);
eq(r.state.status, "off", "a break outcome never starts a shift");

// ── Inbox → queued punches (owner rule, idempotency) ────────────────────
const q0 = { owner: null, storedCount: 0, ids: [] };
let plan = planInbox({ taps: [tap()], session: { kind: "user", userId: A }, queue: q0, handledIds: [] });
eq(plan.decisions.map((d) => d.action), ["enqueue"], "own tap is queued");
eq(plan.decisions[0].punch, { kind: "out", input: { id: ID1, clientTime: new Date(NOW - 10_000).toISOString(), projectId: "p1" } }, "punch input carries the tap time");
eq(plan.handledIds, [ID1], "handled ids remember it");
const punch = buildSimplePunch(plan.decisions[0].punch.kind, plan.decisions[0].punch.input);
eq(punch, {
  id: ID1, kind: "out", clientTime: new Date(NOW - 10_000).toISOString(), projectId: "p1",
  taskId: null, note: null, selfie: null, latitude: null, longitude: null, accuracyM: null, mocked: null,
}, "the same punch the Clock screen builds, with no location");
eq(buildSimplePunch("break_start", { id: ID2, clientTime: "x", projectId: "p1" }).projectId, null, "a break never carries a project");

plan = planInbox({ taps: [tap({ id: ID1.toUpperCase() })], session: { kind: "user", userId: A }, queue: q0, handledIds: [] });
eq(plan.decisions[0].tap.id, ID1, "uppercase ids are lowercased");
plan = planInbox({ taps: [tap({ kind: "break_start" })], session: { kind: "user", userId: A }, queue: q0, handledIds: [] });
eq(plan.decisions[0].punch.input.projectId, null, "break tap: no project");

// Twice: the second pass does nothing new.
plan = planInbox({ taps: [tap()], session: { kind: "user", userId: A }, queue: { owner: A, storedCount: 1, ids: [ID1] }, handledIds: [] });
eq(plan.decisions, [{ action: "ack", id: ID1, reason: "already_queued" }], "already in the queue: ack only");
plan = planInbox({ taps: [tap()], session: { kind: "user", userId: A }, queue: q0, handledIds: [ID1] });
eq(plan.decisions, [{ action: "ack", id: ID1, reason: "already_handled" }], "queued before and already sent: ack only");
plan = planInbox({ taps: [tap(), tap()], session: { kind: "user", userId: A }, queue: q0, handledIds: [] });
eq(plan.decisions.map((d) => d.action), ["enqueue", "ack"], "the same tap twice in one pass: once");

// Owner rule.
plan = planInbox({ taps: [tap()], session: { kind: "user", userId: B }, queue: q0, handledIds: [] });
eq(plan.decisions, [{ action: "drop", id: ID1, reason: "other_user" }], "another user's tap is dropped, never sent");
plan = planInbox({ taps: [tap()], session: { kind: "unknown" }, queue: q0, handledIds: [] });
eq(plan.decisions, [{ action: "keep", id: ID1, reason: "session_unknown" }], "unreadable session keeps the tap");
eq(plan.handledIds, [], "a kept tap is not marked handled");
plan = planInbox({ taps: [tap()], session: { kind: "signed_out" }, queue: q0, handledIds: [] });
eq(plan.decisions, [{ action: "keep", id: ID1, reason: "signed_out" }], "signed out (re-auth) keeps the tap");
plan = planInbox({ taps: [tap()], session: { kind: "user", userId: A }, queue: { owner: B, storedCount: 2, ids: [] }, handledIds: [] });
eq(plan.decisions, [{ action: "keep", id: ID1, reason: "queue_owned_by_other" }], "queue still holding another account's punches: wait");
plan = planInbox({ taps: [tap()], session: { kind: "user", userId: A }, queue: { owner: B, storedCount: 0, ids: [] }, handledIds: [] });
eq(plan.decisions[0].action, "enqueue", "a stale owner stamp on an empty queue does not block");
plan = planInbox({ taps: [tap()], session: { kind: "user", userId: A }, queue: { owner: null, storedCount: 3, ids: [] }, handledIds: [] });
eq(plan.decisions[0].action, "enqueue", "unstamped queue (older app) does not block");

// Malformed and never-a-clock-in.
const bad = [
  tap({ kind: "in", id: ID2 }),
  tap({ id: "not-a-uuid" }),
  tap({ v: 2, id: ID3 }),
  tap({ userId: "" }),
  tap({ tapMs: Number.NaN }),
  tap({ projectId: 42 }),
  "junk",
  null,
];
plan = planInbox({ taps: bad, session: { kind: "user", userId: A }, queue: q0, handledIds: [] });
eq(plan.decisions.map((d) => [d.action, d.reason]), bad.map(() => ["drop", "malformed"]), "malformed taps (and any clock-in) are dropped");
eq(plan.decisions[0].id, ID2, "a malformed tap keeps its id for the ack");

// Order: oldest tap first.
plan = planInbox({
  taps: [tap({ id: ID2, kind: "out", tapMs: NOW }), tap({ id: ID1, kind: "break_start", tapMs: NOW - 60_000 })],
  session: { kind: "user", userId: A }, queue: q0, handledIds: [],
});
eq(plan.decisions.map((d) => d.tap.id), [ID1, ID2], "taps are queued in tap order");

// The remembered ids are capped, newest last.
const many = Array.from({ length: HANDLED_IDS_CAP }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
plan = planInbox({ taps: [tap()], session: { kind: "user", userId: A }, queue: q0, handledIds: many });
eq([plan.handledIds.length, plan.handledIds.at(-1), plan.handledIds[0]], [HANDLED_IDS_CAP, ID1, many[1]], "handled ids are capped");
eq(parseInbox("not json"), [], "unreadable inbox is empty");
eq(parseInbox(JSON.stringify([tap()])).length, 1, "inbox parses");

// ── Dismissal and the Live Activity lifecycle ───────────────────────────
eq([sameShift(START, START + 90_000), sameShift(START, START + 3 * M), sameShift(null, START)], [true, false, false], "same shift tolerance");
const dis = (over = {}) => ({ v: 1, surface: "live_activity", shiftStartMs: START, phase: "on", atMs: NOW - H, ...over });
eq([isDismissed(dis(), START, "on"), isDismissed(dis(), START, "break"), isDismissed(dis(), START + H, "on"), isDismissed(null, START, "on")], [true, false, false, false], "dismissal is per shift and phase");

const act = (over = {}) => ({ id: "a1", shiftStartMs: START, createdMs: START, state: "active", ...over });
const ctx = (over = {}) => ({
  state: on, activities: [], record: null, dismissal: null, nowMs: NOW, foreground: true, activitiesEnabled: true, ...over,
});
eq(planActivity(ctx({ state: off, activities: [act(), act({ id: "a2", state: "ended" })] })), { endNow: ["a1", "a2"], update: null, start: false, recordDismissal: null }, "clocked out: end everything, including the lingering one");
eq(planActivity(ctx({ state: so, activities: [act()] })).endNow, ["a1"], "signed out: end");
eq(planActivity(ctx({ state: state({ enabled: false }), activities: [act()] })).endNow, ["a1"], "off switch: end");
eq(planActivity(ctx()), { endNow: [], update: null, start: true, recordDismissal: null }, "running, nothing showing: start");
eq(planActivity(ctx({ foreground: false })).start, false, "background: never start");
eq(planActivity(ctx({ activitiesEnabled: false })).start, false, "Live Activities off in Settings: never start");
eq(planActivity(ctx({ state: pendOut })).start, false, "pending tap: never start");
eq(planActivity(ctx({ activities: [act()] })), { endNow: [], update: "a1", start: false, recordDismissal: null }, "live for this shift: update");
eq(planActivity(ctx({ activities: [act({ state: "stale" })] })).update, "a1", "stale is still live: update");
eq(planActivity(ctx({ activities: [act({ createdMs: NOW - ACTIVITY_REPLACE_AFTER_MS })] })), { endNow: ["a1"], update: null, start: true, recordDismissal: null }, "7.5 hours old in the foreground: replace");
eq(planActivity(ctx({ activities: [act({ createdMs: NOW - ACTIVITY_REPLACE_AFTER_MS })], foreground: false })).update, "a1", "old but in the background: update");
eq(planActivity(ctx({ activities: [act({ createdMs: NOW - ACTIVITY_REPLACE_AFTER_MS })], state: pendOut })).update, "a1", "old with a tap pending: update, no replacement");
eq(planActivity(ctx({ activities: [act({ shiftStartMs: START - 24 * H })] })), { endNow: ["a1"], update: null, start: true, recordDismissal: null }, "an earlier shift's activity: end it, start this one");
eq(planActivity(ctx({ activities: [act({ state: "ended", createdMs: NOW - ACTIVITY_MAX_MS - H })] })), { endNow: ["a1"], update: null, start: true, recordDismissal: null }, "8 hour end: the old card goes at once and a new one starts");
eq(planActivity(ctx({ activities: [act({ id: "old", createdMs: START }), act({ id: "new", createdMs: START + H })] })), { endNow: ["old"], update: "new", start: false, recordDismissal: null }, "two for one shift: keep the newest");
eq(planActivity(ctx({ dismissal: dis() })), { endNow: [], update: null, start: false, recordDismissal: null }, "swiped away this shift: stays away on every open");
eq(planActivity(ctx({ dismissal: dis(), activities: [act({ id: "x", state: "ended", shiftStartMs: START - 24 * H })] })).endNow, ["x"], "swiped away: other cards still end");
eq(planActivity(ctx({ dismissal: dis(), state: brk })).start, true, "a break starting shows it again");
eq(planActivity(ctx({ dismissal: dis({ shiftStartMs: START - 24 * H }) })).start, true, "yesterday's dismissal does not count");
const rec = (over = {}) => ({ v: 1, activityId: "a1", shiftStartMs: START, phase: "on", createdMs: NOW - 2 * H, endedByApp: false, ...over });
eq(planActivity(ctx({ record: rec() })), { endNow: [], update: null, start: false, recordDismissal: { v: 1, surface: "live_activity", shiftStartMs: START, phase: "on", atMs: NOW } }, "gone before 8 hours while the app was closed: a swipe");
eq(planActivity(ctx({ record: rec(), activities: [act({ id: "a1", state: "dismissed" })] })).recordDismissal?.phase, "on", "listed as dismissed: a swipe");
eq(planActivity(ctx({ record: rec({ createdMs: NOW - ACTIVITY_MAX_MS - M }) })).start, true, "gone after 8 hours: the system's end, start again");
eq(planActivity(ctx({ record: rec({ endedByApp: true }) })).start, true, "the app ended it: start again");
eq(planActivity(ctx({ record: rec({ phase: "break" }) })).start, true, "recorded in another phase: start");
eq(planActivity(ctx({ record: rec({ shiftStartMs: START - 24 * H }) })).start, true, "recorded for another shift: start");

// Android notification.
eq(planNotification({ state: off, dismissal: null, shown: true, allowed: true }), { post: false, cancel: true }, "clocked out: cancel");
eq(planNotification({ state: off, dismissal: null, shown: false, allowed: true }), { post: false, cancel: false }, "clocked out, nothing showing: nothing");
eq(planNotification({ state: on, dismissal: null, shown: false, allowed: true }), { post: true, cancel: false }, "running: post");
eq(planNotification({ state: on, dismissal: null, shown: true, allowed: false }), { post: false, cancel: false }, "no permission: nothing to post");
eq(planNotification({ state: on, dismissal: dis({ surface: "notification" }), shown: false, allowed: true }), { post: false, cancel: false }, "swiped away: not posted again on open");
eq(planNotification({ state: brk, dismissal: dis({ surface: "notification" }), shown: false, allowed: true }).post, true, "next phase: posted again");

// Permission ask, decision 4.
const ask = (over = {}) => planNotificationAsk({ platform: "android", enabled: true, granted: false, canAskAgain: true, askedBefore: false, ...over });
eq([ask(), ask({ canAskAgain: false }), ask({ granted: true }), ask({ askedBefore: true }), ask({ platform: "ios" }), ask({ enabled: false })], ["ask", "settings", "none", "none", "none", "none"], "ask once, Android only");

// Carrying a pending tap through a push from the app.
eq(carryPendingTap(pendOut, on, [ID1]).pendingTap?.id, ID1, "push keeps a tap still in the inbox");
eq(carryPendingTap(pendOut, on, []).pendingTap, null, "answered tap: the push wins");
eq(carryPendingTap(pendOut, state({ userId: B }), [ID1]).pendingTap, null, "another user: the push wins");
eq(carryPendingTap(pendOut, off, [ID1]).pendingTap, null, "clocked out: the push wins");
eq(carryPendingTap(pendOut, state({ shiftStartMs: START + H }), [ID1]).pendingTap, null, "another shift: the push wins");

// ── Parsing what native hands back ──────────────────────────────────────
eq(parseState(JSON.parse(JSON.stringify(brk))), brk, "state survives the JSON round trip");
eq(parseState(JSON.parse(JSON.stringify(pendOut))), pendOut, "pending state survives the JSON round trip");
eq(parseState({ ...on, v: 2 }), null, "unknown state version ignored");
eq(parseState({ ...on, copy: { clockOut: "Sign out", takeBreak: 5 } }).copy.takeBreak, "Take break", "copy override: strings only");
eq(parseSnapshot("nope"), EMPTY_SNAPSHOT, "unreadable snapshot");
eq(parseSnapshot(JSON.stringify({ schemaVersion: 2 })), EMPTY_SNAPSHOT, "snapshot from another schema");
const snap = parseSnapshot(JSON.stringify({
  schemaVersion: 1, platform: "ios", activitiesSupported: true, activitiesEnabled: true,
  activities: [act(), { id: "bad" }], activityRecord: rec(), dismissal: dis(), state: on,
}));
eq([snap.platform, snap.activities.length, snap.activityRecord?.activityId, snap.dismissal?.phase, snap.state?.status, snap.notificationShown], ["ios", 1, "a1", "on", "on", false], "snapshot parses and drops bad rows");
eq(parseDismissal({ ...dis(), phase: "lunch" }), null, "bad dismissal");
eq(parseActivityRecord({ ...rec(), createdMs: "x" }), null, "bad record");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
