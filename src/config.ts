// Expo exposes EXPO_PUBLIC_* env vars to the app bundle. These are the same
// public client values the website uses (Supabase project URL + publishable
// key) plus the base URL of the mobile API.

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";
const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL ?? "https://app.getclox.com";

if (
  (!SUPABASE_URL || !SUPABASE_ANON_KEY) &&
  process.env.NODE_ENV !== "production"
) {
  // Loud in the Metro logs (dev only) so a missing/empty .env is obvious.
  console.warn(
    "[clox] Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY. " +
      "Copy .env.example to .env, fill them in, then restart: npx expo start -c",
  );
}

export { SUPABASE_URL, SUPABASE_ANON_KEY, API_BASE_URL };
