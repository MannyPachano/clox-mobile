// Flat ESLint config for the Expo (SDK 54) app.
// eslint-config-expo bundles the React, React Hooks, and TypeScript rules.
// rules-of-hooks is forced to "error" because a hook declared after an early
// return is exactly what hard-crashed the first TestFlight build on login.
const expoConfig = require("eslint-config-expo/flat");

module.exports = [
  ...expoConfig,
  {
    ignores: ["dist/*", ".expo/*", "node_modules/*", "babel.config.js"],
  },
  {
    rules: {
      // The crash guardrail — a hook after an early return must fail the gate.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // React Compiler-era perf hints: useful signal but not crash-class, and
      // noisy on existing working code. Keep as warnings so they don't block CI.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/use-memo": "warn",
      // tsc already validates module resolution; eslint-plugin-import's resolver
      // can't see Expo's bundled packages (e.g. @expo/vector-icons).
      "import/no-unresolved": "off",
    },
  },
];
