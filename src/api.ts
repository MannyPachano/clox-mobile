import { API_BASE_URL } from "./config";
import { getAttestationForPunch } from "./attestation";
import { setOrgTz } from "./lib/org-tz";
import type { QueuedPunch } from "./queue";

export type Option = { id: string; name: string };

export type StatusResponse = {
  user: { id: string; name: string; role: string };
  organization: {
    id: string;
    name: string;
    requireProject: boolean;
    selfieRequired: boolean;
    /** The org's IANA zone — the truth for shift wall-clock times. Absent
     *  from a server that predates the field; readers fall back to device. */
    timeZone?: string;
  };
  activeEntry: {
    id: string;
    startTime: string;
    /** Shift anchor — drives the on-screen timer. */
    startedAt: string;
    /** Start of the CURRENT entry segment (later than startedAt after a
     *  mid-shift project switch). Prefills the start-time editor. */
    entryStartIso: string;
    projectId: string | null;
    taskId: string | null;
    note: string | null;
  } | null;
  onBreakSince: string | null;
  themePreference: string;
  tutorialCompleted: boolean;
  projects: Option[];
  tasksByProject: Record<string, Option[]>;
  /** Geofence config for the client-side pre-check. `enforced` is false (and
   *  `worksites` empty) when this worker is exempt or unassigned. Advisory: the
   *  server re-checks on the punch and is the authority. */
  geofence: {
    enforced: boolean;
    worksites: { latitude: number; longitude: number; radiusM: number }[];
  };
  /** WiFi-restricted clock-in. When enforced with saved SSIDs, the app blocks
   *  clock-in unless the phone is on one of these networks (exact name match).
   *  Client-side only — the phone is the only party that can see the SSID. */
  wifi: {
    enforced: boolean;
    ssids: string[];
  };
};

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };

async function request<T>(
  path: string,
  token: string,
  method: "GET" | "POST" | "DELETE",
  body?: unknown,
): Promise<ApiResult<T>> {
  // A network failure throws here — the queue treats a thrown request as
  // "still offline, retry later" rather than a terminal failure.
  const res = await fetch(`${API_BASE_URL}/api/mobile/v1/${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty / non-JSON body is fine */
  }

  if (res.ok) return { ok: true, status: res.status, data: data as T };
  const error =
    (data as { error?: string } | null)?.error ?? `http_${res.status}`;
  return { ok: false, status: res.status, error };
}

export async function getStatus(
  token: string,
): Promise<ApiResult<StatusResponse>> {
  const res = await request<StatusResponse>("status", token, "GET");
  // Cache the org zone at the API chokepoint so every screen and modal can
  // read it (lib/org-tz) without prop-drilling or its own fetch.
  if (res.ok) setOrgTz(res.data.organization.timeZone);
  return res;
}

/** Mark the guided tour finished for this user (syncs with the web app). */
export function markTutorialComplete(
  token: string,
): Promise<ApiResult<unknown>> {
  return request("profile/tutorial-complete", token, "POST", {});
}

/**
 * Permanently delete the signed-in user's account (App Store requirement).
 * On `ok:false` the `error` is a code: "is_owner" | "last_manager" |
 * "rate_limited" | "config_missing" | "error".
 */
export function deleteAccount(
  token: string,
): Promise<ApiResult<{ ok: true }>> {
  return request("account/delete", token, "POST", {});
}

export async function clockIn(
  token: string,
  punch: QueuedPunch,
): Promise<ApiResult<unknown>> {
  // Device attestation is generated here, at send time: the app is online while
  // draining the queue, so the token is fresh and the tap stayed fast. It binds
  // to the punch id. Best-effort — returns {} and is simply omitted on failure.
  const attestation = await getAttestationForPunch(punch.id, token);
  return request("clock-in", token, "POST", {
    idempotencyKey: punch.id,
    clientTime: punch.clientTime,
    projectId: punch.projectId,
    taskId: punch.taskId,
    note: punch.note,
    selfie: punch.selfie,
    latitude: punch.latitude,
    longitude: punch.longitude,
    accuracyM: punch.accuracyM,
    mocked: punch.mocked,
    ...attestation,
  });
}

export function clockOut(
  token: string,
  punch: QueuedPunch,
): Promise<ApiResult<unknown>> {
  return request("clock-out", token, "POST", {
    idempotencyKey: punch.id,
    clientTime: punch.clientTime,
    projectId: punch.projectId,
  });
}

export function breakStart(
  token: string,
  punch: QueuedPunch,
): Promise<ApiResult<unknown>> {
  return request("break/start", token, "POST", {
    idempotencyKey: punch.id,
    clientTime: punch.clientTime,
  });
}

export function breakEnd(
  token: string,
  punch: QueuedPunch,
): Promise<ApiResult<unknown>> {
  return request("break/end", token, "POST", {
    idempotencyKey: punch.id,
    clientTime: punch.clientTime,
  });
}

export function switchProject(
  token: string,
  punch: QueuedPunch,
): Promise<ApiResult<unknown>> {
  return request("switch-project", token, "POST", {
    idempotencyKey: punch.id,
    clientTime: punch.clientTime,
    projectId: punch.projectId,
    taskId: punch.taskId,
    // true = retag the CURRENT entry in place (no split); omitted = today's
    // split-at-clientTime behavior.
    ...(punch.applyToShift ? { applyToShift: true } : {}),
  });
}

export type HistoryShift = {
  id: string;
  start: string;
  end: string;
  durationMs: number;
  projectId: string | null;
  project: string | null;
  task: string | null;
  note: string | null;
  /** A manager rejected this shift; the employee needs to correct + resubmit. */
  rejected: boolean;
  /** Why it was rejected — shown to the employee so they know what to fix. */
  rejectionReason: string | null;
};

export function getHistory(
  token: string,
): Promise<ApiResult<{ shifts: HistoryShift[] }>> {
  return request<{ shifts: HistoryShift[] }>("history", token, "GET");
}

/**
 * Employee submits a correction request for one of THEIR OWN shifts. It does
 * not take effect until a manager approves it. requestedProject is the full
 * desired value (omit/keep to leave it unchanged). For a RUNNING shift, omit
 * endIso entirely (the server rejects endIso on a running entry) — approval
 * applies the new start and the shift keeps running. Completed shifts must
 * still send endIso.
 */
export function createEntryEditRequest(
  token: string,
  input: {
    timeEntryId: string;
    startIso: string;
    endIso?: string;
    projectId?: string | null;
    reason?: string | null;
  },
): Promise<ApiResult<{ ok: boolean; requestId: string }>> {
  return request("entry-edit-request", token, "POST", input);
}

export function registerPushToken(
  token: string,
  pushToken: string,
  platform: string,
): Promise<ApiResult<unknown>> {
  return request("register-push-token", token, "POST", {
    token: pushToken,
    platform,
  });
}

export function unregisterPushToken(
  token: string,
  pushToken: string,
): Promise<ApiResult<unknown>> {
  return request("register-push-token", token, "DELETE", { token: pushToken });
}

// ── Manager API ────────────────────────────────────────────────────────────

export type ManagerRosterEntry = {
  userId: string;
  name: string;
  role: string;
  onShift: boolean;
  shiftStartedAt: string | null;
  project: string | null;
  /** Present only while onShift: the running entry's id + its start, so a
   *  manager can adjust the start time without closing the shift. */
  activeEntryId?: string | null;
  activeStartIso?: string | null;
};

export function getManagerRoster(
  token: string,
): Promise<
  ApiResult<{
    roster: ManagerRosterEntry[];
    onShiftCount: number;
    todayLaborCents: number;
    todayWorkedMs: number;
    todayHasRates: boolean;
  }>
> {
  return request("manager/roster", token, "GET");
}

export type PendingTimesheet = {
  id: string;
  employee: string;
  project: string | null;
  projectId: string | null;
  note: string | null;
  start: string;
  end: string;
  durationMs: number;
  source: string;
};

export type PendingLeave = {
  id: string;
  employee: string;
  kind: string;
  startsOn: string;
  endsOn: string;
  notes: string | null;
};

/** A pending employee correction request, for the manager Approvals queue. */
export type EditRequestDto = {
  id: string;
  employee: string;
  reason: string | null;
  originalStart: string;
  originalEnd: string;
  requestedStart: string;
  requestedEnd: string;
  project: string | null;
  createdAt: string;
};

export function getManagerPending(
  token: string,
): Promise<
  ApiResult<{
    timesheets: PendingTimesheet[];
    leave: PendingLeave[];
    editRequests: EditRequestDto[];
  }>
> {
  return request("manager/pending", token, "GET");
}

/**
 * A clocked shift that EditEntryModal can edit. A pending timesheet, a browsed
 * team-member shift, and (in future) an own history row all satisfy this shape.
 */
export type EditableEntry = {
  id: string;
  /** Optional subtitle in the edit sheet (omit for the manager's own shift). */
  employee?: string;
  start: string;
  /** Omitted for a RUNNING entry (start-only edit — the shift has no end yet). */
  end?: string;
  projectId: string | null;
  note: string | null;
};

/** One completed clocked shift for a specific employee (manager browse list). */
export type ManagerEntry = {
  id: string;
  start: string;
  end: string;
  durationMs: number;
  project: string | null;
  projectId: string | null;
  note: string | null;
  source: string;
  /** Approved+locked; editing returns 409 until unlocked on the web. */
  locked: boolean;
  approved: boolean;
};

/** A specific employee's completed clocked shifts in a window (manager only). */
export function getManagerEntries(
  token: string,
  employeeUserId: string,
  fromIso: string,
  toIso: string,
): Promise<ApiResult<{ entries: ManagerEntry[] }>> {
  const qs =
    `employeeUserId=${encodeURIComponent(employeeUserId)}` +
    `&from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`;
  return request(`manager/entries?${qs}`, token, "GET");
}

export function decidePayroll(
  token: string,
  action: "approve" | "reject",
  ids: string[],
  // Rejecting no longer deletes the shift — it marks it rejected with a reason
  // the employee sees, so the server requires a reason on "reject".
  reason?: string,
): Promise<ApiResult<{ ok: boolean; count: number }>> {
  return request("manager/payroll/decide", token, "POST", {
    action,
    ids,
    ...(reason ? { reason } : {}),
  });
}

export function reviewLeave(
  token: string,
  id: string,
  decision: "approved" | "rejected",
): Promise<ApiResult<unknown>> {
  return request("manager/leave/review", token, "POST", { id, decision });
}

/**
 * Manager approves or rejects an employee's clocked-shift correction request.
 * Approve applies the change; reject leaves the original entry untouched.
 */
export function reviewEntryEditRequest(
  token: string,
  id: string,
  decision: "approved" | "rejected",
): Promise<ApiResult<unknown>> {
  return request("manager/edit-request/review", token, "POST", {
    id,
    decision,
  });
}

export function getManagerSummary(
  token: string,
): Promise<
  ApiResult<{
    pendingApprovals: number;
    pendingLeave: number;
    pendingEditRequests: number;
    onShift: number;
  }>
> {
  return request("manager/summary", token, "GET");
}

export function createManagerEntry(
  token: string,
  entry: {
    employeeUserId: string;
    startIso: string;
    endIso: string;
    projectId?: string | null;
    note?: string | null;
  },
): Promise<ApiResult<{ ok: boolean; entryId: string }>> {
  return request("manager/entry", token, "POST", entry);
}

/**
 * endIso omitted = keep the current end, which may still be open (running
 * shift). Start-only edits of a running entry are allowed; the server rejects
 * a startIso at or after now.
 */
export function updateManagerEntry(
  token: string,
  entry: {
    id: string;
    startIso?: string;
    endIso?: string;
    projectId?: string | null;
    taskId?: string | null;
    note?: string | null;
  },
): Promise<ApiResult<unknown>> {
  return request("manager/entry/update", token, "POST", entry);
}

export function closeShift(
  token: string,
  employeeUserId: string,
  projectId?: string | null,
): Promise<ApiResult<unknown>> {
  return request("manager/close-shift", token, "POST", {
    employeeUserId,
    projectId: projectId ?? null,
  });
}

// ── Manager schedule (planned shifts) ───────────────────────────────────────

export type BoardColor =
  | "clay"
  | "moss"
  | "amber"
  | "slate"
  | "plum"
  | "pine"
  | "sand";

export type ScheduledShiftDto = {
  id: string;
  employeeUserId: string;
  employeeName: string;
  startsAt: string;
  endsAt: string;
  isSeries: boolean;
  /** The project the shift is tagged with, if any — powers the day board's
   *  color dot. null when unset or the project has no color. */
  projectName: string | null;
  projectColor: BoardColor | null;
};

export function getManagerSchedule(
  token: string,
  fromIso: string,
  toIso: string,
): Promise<ApiResult<{ shifts: ScheduledShiftDto[]; employees: Option[] }>> {
  const qs = `from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`;
  return request(`manager/schedule?${qs}`, token, "GET");
}

export type MyScheduledShift = {
  id: string;
  startsAt: string;
  endsAt: string;
  isSeries: boolean;
};

/** The signed-in employee's own upcoming scheduled shifts, soonest first. */
export function getMySchedule(
  token: string,
): Promise<ApiResult<{ shifts: MyScheduledShift[]; scheduleEnabled: boolean }>> {
  return request("my-schedule", token, "GET");
}

export function createManagerShift(
  token: string,
  shift: { employeeUserId: string; startIso: string; endIso: string },
): Promise<ApiResult<{ ok: boolean; shiftId: string }>> {
  return request("manager/schedule", token, "POST", shift);
}

// ── Manager roster map (worksites + located punches for a day range) ─────────

export type MapWorksite = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusM: number;
};

export type MapPunch = {
  id: string;
  userId: string;
  displayName: string;
  clockInMs: number;
  /** null while the worker is still on the clock. */
  clockOutMs: number | null;
  projectName: string | null;
  /** Palette token ("clay" | "moss" | ...) for the sheet row's project dot. */
  projectColor: string | null;
  clockInLatitude: number;
  clockInLongitude: number;
};

export type MapRangeData = {
  from: string;
  to: string;
  /** The zone `from`/`to` and every punch's day boundary were resolved in.
   *  The punch-list sheet groups by calendar day in this zone, not the
   *  device's own. */
  timeZone: string;
  worksites: MapWorksite[];
  punches: MapPunch[];
  /** true when the located-punch list hit the server's 400-pin cap. */
  truncated: boolean;
  /** Punches in range with no coordinates (not returned as pins). */
  noLocationCount: number;
};

/**
 * Worksites + located punches for a day range, for the roster map. `from`/`to`
 * are org-timezone day keys (YYYY-MM-DD); equal values mean a single day.
 * Mirrors the web worksites map for the same org and range.
 */
export async function getManagerMapRange(
  token: string,
  fromKey: string,
  toKey: string,
): Promise<ApiResult<MapRangeData>> {
  const qs = `from=${encodeURIComponent(fromKey)}&to=${encodeURIComponent(toKey)}`;
  const res = await request<MapRangeData>(`manager/map-range?${qs}`, token, "GET");
  // Same org-zone cache as getStatus — either payload may land first.
  if (res.ok) setOrgTz(res.data.timeZone);
  return res;
}

export function deleteManagerShift(
  token: string,
  id: string,
): Promise<ApiResult<unknown>> {
  return request("manager/schedule", token, "DELETE", { id });
}

/**
 * Edit ONE scheduled shift (times + optionally the employee). Single occurrence
 * only — the repeating series stays on the web. POST (not PATCH) to match the
 * mobile request() method set and the manager/entry/update convention.
 */
export function updateManagerShift(
  token: string,
  shift: {
    id: string;
    startIso: string;
    endIso: string;
    employeeUserId?: string;
  },
): Promise<ApiResult<unknown>> {
  return request("manager/schedule/update", token, "POST", shift);
}
