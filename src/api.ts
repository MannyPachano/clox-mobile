import { API_BASE_URL } from "./config";
import { getAttestationForPunch } from "./attestation";
import type { QueuedPunch } from "./queue";

export type Option = { id: string; name: string };

export type StatusResponse = {
  user: { id: string; name: string; role: string };
  organization: {
    id: string;
    name: string;
    requireProject: boolean;
    selfieRequired: boolean;
  };
  activeEntry: {
    id: string;
    startTime: string;
    startedAt: string;
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

export function getStatus(token: string): Promise<ApiResult<StatusResponse>> {
  return request<StatusResponse>("status", token, "GET");
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
};

export function getHistory(
  token: string,
): Promise<ApiResult<{ shifts: HistoryShift[] }>> {
  return request<{ shifts: HistoryShift[] }>("history", token, "GET");
}

/**
 * Employee submits a correction request for one of THEIR OWN completed shifts.
 * It does not take effect until a manager approves it. requestedProject is the
 * full desired value (omit/keep to leave it unchanged).
 */
export function createEntryEditRequest(
  token: string,
  input: {
    timeEntryId: string;
    startIso: string;
    endIso: string;
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
  end: string;
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
): Promise<ApiResult<{ ok: boolean; count: number }>> {
  return request("manager/payroll/decide", token, "POST", { action, ids });
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

export function updateManagerEntry(
  token: string,
  entry: {
    id: string;
    startIso?: string;
    endIso?: string;
    projectId?: string | null;
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

export type ScheduledShiftDto = {
  id: string;
  employeeUserId: string;
  employeeName: string;
  startsAt: string;
  endsAt: string;
  isSeries: boolean;
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
