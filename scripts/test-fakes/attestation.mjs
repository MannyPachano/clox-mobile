// No device attestation under node: the punch is sent without it, as on a
// phone where attestation is unavailable.
export async function getAttestationForPunch() {
  return {};
}
