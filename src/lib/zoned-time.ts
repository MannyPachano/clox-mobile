// Org-timezone wall-clock helpers. The org's zone is the truth for every
// shift: the server resolves ranges in it, the web app displays in it, and a
// manager describing a shift ("7:09 to 5:19") means the site's clock, not
// their phone's. These helpers convert both ways between instants and org
// wall-clock so pickers can seed and compose in the org zone. `tz` undefined
// (payload predates the field, or the zone is unknown to this device's ICU)
// falls back to the device zone — the previous behavior, not a crash.

// Formatter cache: constructing an Intl.DateTimeFormat is the expensive part
// (the format call itself is cheap), and list rows call the formatting
// helpers several times per row per render. The cache stays tiny: a handful
// of shapes times the handful of org zones one device ever sees.
const dtfCache = new Map<string, Intl.DateTimeFormat>();

export function zonedFormat(
  shape: string,
  locale: string,
  opts: Intl.DateTimeFormatOptions,
  tz: string | undefined,
  ms: number,
): string {
  return cachedFormatter(shape, locale, opts, tz).format(new Date(ms));
}

function cachedFormatter(
  shape: string,
  locale: string,
  opts: Intl.DateTimeFormatOptions,
  tz: string | undefined,
): Intl.DateTimeFormat {
  const key = `${shape}|${tz ?? "device"}`;
  let f = dtfCache.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, { ...opts, timeZone: tz });
    } catch {
      // An org zone this device's ICU has never heard of — the picker
      // validates against the SERVER's tzdata, and e.g. "Europe/Kyiv" only
      // exists in tzdata 2022b+, which old Android phones may predate.
      // ECMA-402 says unknown timeZone THROWS, and these run inside render,
      // so without the catch one stale phone takes the whole app down.
      // Device zone beats a crash; the web repo guards this same
      // constructor (isFormattableZone) for the same reason.
      f = new Intl.DateTimeFormat(locale, opts);
    }
    dtfCache.set(key, f);
  }
  return f;
}

/** A wall-clock reading: what a clock on the wall in some zone shows. */
export type WallParts = {
  y: number;
  mo: number; // 1-12
  d: number;
  h: number; // 0-23
  mi: number;
};

/** The wall-clock an instant shows in `tz` (device zone when undefined). */
export function wallPartsInZone(
  ms: number,
  tz: string | undefined,
): WallParts {
  const parts = cachedFormatter(
    "wall",
    "en-US",
    {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    },
    tz,
  ).formatToParts(new Date(ms));
  const get = (t: string) =>
    Number(parts.find((p) => p.type === t)?.value ?? NaN);
  return {
    y: get("year"),
    mo: get("month"),
    d: get("day"),
    // Some ICU builds report midnight as "24" even under h23; normalize.
    h: get("hour") % 24,
    mi: get("minute"),
  };
}

/**
 * The instant at which `tz` shows the given wall-clock — the inverse of
 * wallPartsInZone. Guess the instant as if the wall time were UTC, read what
 * that instant actually shows in `tz`, and correct by the difference, twice:
 * one pass lands exactly everywhere except within a DST transition, and the
 * second settles those. A wall time that does not exist in `tz` (the
 * spring-forward gap) resolves to a nearby real instant instead of failing;
 * an ambiguous one (the fall-back hour) resolves to one of its two instants,
 * deterministically. Both are the same trade every timezone library makes.
 */
export function zonedWallToUtc(w: WallParts, tz: string | undefined): number {
  if (!tz) {
    return new Date(w.y, w.mo - 1, w.d, w.h, w.mi, 0, 0).getTime();
  }
  const want = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  let utc = want;
  for (let i = 0; i < 2; i++) {
    const shown = wallPartsInZone(utc, tz);
    const shownUtc = Date.UTC(shown.y, shown.mo - 1, shown.d, shown.h, shown.mi);
    utc += want - shownUtc;
  }
  return utc;
}

/**
 * A Date whose DEVICE-local fields carry the wall-clock `iso` shows in `tz` —
 * for seeding native time pickers. The picker reads and writes only wall
 * fields (getHours/getMinutes), so stuffing the org wall-clock into a device
 * Date makes the picker DISPLAY org time and hand back picks whose fields ARE
 * org wall values, ready for zonedWallToUtc. Never treat this Date as an
 * instant — its getTime() is meaningless by design.
 */
export function pickerDateInZone(iso: string, tz: string | undefined): Date {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return new Date();
  if (!tz) return new Date(ms);
  const w = wallPartsInZone(ms, tz);
  return new Date(w.y, w.mo - 1, w.d, w.h, w.mi, 0, 0);
}

/** True when two picker shells carry the same wall-clock fields. Callers use
 *  this to detect an UNTOUCHED picker and send the entry's original ISO
 *  instead of recomposing: wall fields alone cannot distinguish the two
 *  instants of a fall-back hour (recomposing collapses the second onto the
 *  first), and a wall time inside the DEVICE zone's spring-forward gap
 *  cannot even be represented by the shell (the Date constructor normalizes
 *  it an hour off). Preserving the original whenever nothing changed keeps
 *  both DST edges from silently rewriting a stored instant. */
export function sameWallFields(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate() &&
    a.getHours() === b.getHours() &&
    a.getMinutes() === b.getMinutes()
  );
}

/** The "YYYY-MM-DD" calendar day an instant falls on in `tz`. */
export function ymdInZone(ms: number, tz: string | undefined): string {
  return zonedFormat(
    "dayKey",
    "en-CA",
    { year: "numeric", month: "2-digit", day: "2-digit" },
    tz,
    ms,
  );
}

// ── Shared display formatters. Every screen that shows a shift's time uses
//    these with the ORG zone, so what a list says always matches what the
//    edit modal seeded from the same instant (and what the web app shows).
//    tz undefined formats in the device zone — that is deliberate for the
//    one surface describing the PHONE (the live clock card), and the
//    fallback for payloads that predate the org-zone field.

/** "3:05 PM" — the wall-clock an instant shows in `tz`. */
export function clockInZone(ms: number, tz: string | undefined): string {
  if (Number.isNaN(ms)) return "—:—";
  return zonedFormat(
    "clock",
    "en-US",
    { hour: "numeric", minute: "2-digit", hour12: true },
    tz,
    ms,
  );
}

/** "Jul 14" in `tz`. */
export function shortDateInZone(ms: number, tz: string | undefined): string {
  if (Number.isNaN(ms)) return "—";
  return zonedFormat(
    "shortDate",
    "en-US",
    { month: "short", day: "numeric" },
    tz,
    ms,
  );
}

/** "Wed, Jul 23" in `tz`. */
export function weekdayDateInZone(ms: number, tz: string | undefined): string {
  if (Number.isNaN(ms)) return "—";
  return zonedFormat(
    "weekdayDate",
    "en-US",
    { weekday: "short", month: "short", day: "numeric" },
    tz,
    ms,
  );
}

/** "3:05 PM" when `ms` falls on the same `tz` day as `refMs`, else
 *  "Jul 14, 3:05 PM". The date is what keeps an overnight end (or a
 *  days-old running start) from reading as this morning's. */
export function clockWithDayInZone(
  ms: number,
  refMs: number,
  tz: string | undefined,
): string {
  // Same degradation as the sibling formatters: Intl.format(new Date(NaN))
  // THROWS, and this must never turn a malformed timestamp into a render
  // crash. A NaN ref just drops the date suffix.
  if (Number.isNaN(ms)) return clockInZone(ms, tz);
  if (Number.isNaN(refMs)) return clockInZone(ms, tz);
  if (ymdInZone(ms, tz) === ymdInZone(refMs, tz)) return clockInZone(ms, tz);
  return `${shortDateInZone(ms, tz)}, ${clockInZone(ms, tz)}`;
}
