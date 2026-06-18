import { API_BASE_URL } from "./config";
import { getAccessToken } from "./supabase";

/**
 * Lightweight crash visibility for the beta.
 *
 * There is no native crash SDK wired yet — @sentry/react-native needs an EAS
 * build, not Expo Go — so this catches uncaught JS errors + unhandled
 * rejections, logs them to the Metro console, and best-effort POSTs them to the
 * web backend (`/api/mobile/v1/client-error`), whose logs already flow to the
 * web app's Sentry. That gives remote visibility into beta crashes today,
 * without a native dependency. Swap in @sentry/react-native at EAS-build time
 * for true native-crash capture.
 */

let installed = false;

async function postError(payload: {
  message: string;
  stack: string | null;
  context: string | null;
}): Promise<void> {
  try {
    const token = await getAccessToken().catch(() => null);
    await fetch(`${API_BASE_URL}/api/mobile/v1/client-error`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ ...payload, platform: "mobile" }),
    });
  } catch {
    // Never let error reporting throw — it's best-effort.
  }
}

/** Report a caught error: log it locally and ship it to the backend. */
export function reportError(error: unknown, context?: string): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? (error.stack ?? null) : null;
  // eslint-disable-next-line no-console
  console.error(`[clox] ${context ?? "error"}:`, message);
  void postError({
    message: message.slice(0, 1000),
    stack: stack ? stack.slice(0, 4000) : null,
    context: context ?? null,
  });
}

/** Install a global handler for otherwise-uncaught JS errors. Call once at boot. */
export function installErrorReporting(): void {
  if (installed) return;
  installed = true;
  const g = globalThis as unknown as {
    ErrorUtils?: {
      getGlobalHandler?: () => (e: unknown, isFatal?: boolean) => void;
      setGlobalHandler?: (
        h: (e: unknown, isFatal?: boolean) => void,
      ) => void;
    };
  };
  const prev = g.ErrorUtils?.getGlobalHandler?.();
  g.ErrorUtils?.setGlobalHandler?.((e: unknown, isFatal?: boolean) => {
    reportError(e, isFatal ? "fatal" : "uncaught");
    // Preserve RN's default handler (red-box in dev, graceful exit in prod).
    prev?.(e, isFatal);
  });
}
