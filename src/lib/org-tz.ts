// The org's IANA timezone, cached module-wide. The status payload carries it
// (and map-range does too), and api.ts writes it here whenever either lands,
// so any modal can read it without its own fetch or prop-drilling through
// screens that never needed it. Undefined until the first status response of
// the session (or forever, against a server that predates the field) — every
// reader must treat that as "compose in the device zone", the pre-org-tz
// behavior. The Clock tab is the app's initial screen and fetches status on
// mount, so in practice the zone is set before any edit modal can open.

let orgTz: string | undefined;

export function setOrgTz(tz: string | null | undefined): void {
  if (tz) orgTz = tz;
}

export function getOrgTz(): string | undefined {
  return orgTz;
}
