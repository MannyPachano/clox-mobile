export const reported = [];
export function reportError(err, context) {
  reported.push({ err, context });
}
