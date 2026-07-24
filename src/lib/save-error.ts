// The API returns machine codes on validation failures ({error: "bad_range"}),
// never sentences — so the sentence lives here, one per code, shared by every
// save path. Several distinct server checks share one code (bad_range alone
// covers end-not-after-start, unparseable times, AND a window that strands a
// logged break), so each sentence stays honest about the whole family rather
// than guessing a cause. 409/locked is deliberately absent: each caller keeps
// its own tailored locked copy, which names where to unlock.

const MESSAGES: Record<string, string> = {
  // Deliberately cause-agnostic: routes file several distinct checks under
  // this one code, and they differ per route. Callers that know their
  // route's actual causes say more via `overrides`.
  bad_range: "Those times don't work for this shift.",
  too_long:
    "That runs longer than one shift can. If you meant PM, fix the end time.",
  invalid: "The start of a running shift has to be in the past.",
  bad_project: "That project no longer exists. Pick another.",
  bad_employee: "That person is no longer on the team.",
  // "record", not "entry": the same code covers deleted time entries,
  // scheduled shifts, and already-reviewed requests.
  not_found: "This record no longer exists. Close this and check the list.",
  not_owner: "This shift belongs to someone else.",
  rate_limited: "Too many changes at once. Wait a moment and try again.",
};

/**
 * The sentence for a failed save: the caller's override when it knows its
 * route's causes better, else the shared sentence for the code, else the
 * caller's generic line.
 */
export function saveErrorMessage(
  code: string,
  fallback: string,
  overrides?: Record<string, string>,
): string {
  return overrides?.[code] ?? MESSAGES[code] ?? fallback;
}
