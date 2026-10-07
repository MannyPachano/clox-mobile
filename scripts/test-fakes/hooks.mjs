// Module hooks for the node checks that load real app modules (queue.ts,
// api.ts). React Native and Expo modules can't run under node, so the few
// the queue reaches are swapped for the fakes in this folder, and the app's
// extensionless relative imports resolve to their .ts files.
const FAKES = {
  "@react-native-async-storage/async-storage": "./async-storage.mjs",
  "./config": "./config.mjs",
  "./attestation": "./attestation.mjs",
  "./error-reporting": "./error-reporting.mjs",
};

export async function resolve(specifier, context, next) {
  const fromApp = context.parentURL?.includes("/src/") ?? false;
  const fake = FAKES[specifier];
  if (fake && (fromApp || specifier.startsWith("@"))) {
    return { url: new URL(fake, import.meta.url).href, shortCircuit: true };
  }
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    !/\.[cm]?[jt]sx?$/.test(specifier) &&
    fromApp
  ) {
    return next(`${specifier}.ts`, context);
  }
  return next(specifier, context);
}
