# Clox Mobile — employee clock-in app

A tiny native app (Expo / React Native) for employees to **clock in and out** — works offline and syncs automatically. Managers keep using the web app for reports, approvals, scheduling, etc.

## What you need
- Node.js 18+.
- The **Expo Go** app on your phone (App Store / Play Store), or an iOS Simulator / Android emulator.

## Run it
```bash
cd clox-mobile
npm install
npx expo start
```
Then scan the QR code with Expo Go (Android) or the Camera app (iOS). Sign in with the same email + password you use on the Clox website.

> The Supabase keys are already filled into `.env` (the same public client keys your website ships). Edit `.env` only if they change.

### If Expo Go says the SDK version doesn't match
Your installed Expo Go may be a newer SDK than this project pins. Align everything in one step — the app source doesn't change:
```bash
npx expo install expo@latest && npx expo install --fix
npx expo start -c
```

## Backend requirement
The app calls `https://app.getclox.com/api/mobile/v1/*` (`EXPO_PUBLIC_API_BASE_URL`). Those endpoints live in the main web repo (`src/app/api/mobile/v1/`) and must be **deployed** for login + clocking to work. To test against a local web server, set `EXPO_PUBLIC_API_BASE_URL` to your machine's LAN URL (e.g. `http://192.168.1.50:3000`) and restart with `npx expo start -c`.

## What works
- Email/password sign-in (Supabase); session stored encrypted in the device keychain (chunked SecureStore).
- Clock in / clock out with a live elapsed timer.
- Optional note on clock-in.
- GPS captured on clock-in (asks permission; never blocks the punch).
- **Offline:** punches are saved on the device and replayed in order when you're back online. Idempotency keys mean a replay never double-punches — the same guarantee the web app uses.

## Not yet (next steps)
- Project / task picker (the API already accepts `projectId` / `taskId`).
- Breaks and switch-project.
- Server-side geofence **enforcement** (today GPS is captured, not enforced).
- Orgs that **require a project at clock-out** aren't supported in the app yet (clock-out reports `project_required`).
- App icon / splash (uses Expo defaults until you drop in assets).

## Project layout
```
clox-mobile/
  App.tsx                 app root: shows Login or Clock screen by auth state
  index.js                Expo entry
  app.json                Expo config (name, permissions, plugins)
  package.json
  .env                    Supabase URL + key + API base (pre-filled)
  src/
    config.ts             reads EXPO_PUBLIC_* env
    theme.ts              colors
    supabase.ts           Supabase client + getAccessToken()
    secure-storage.ts     chunked SecureStore adapter (encrypted session)
    uuid.ts               UUID for idempotency keys
    location.ts           best-effort GPS for a punch
    api.ts                typed client for /api/mobile/v1/*
    queue.ts              offline punch queue + sync drain
    screens/
      LoginScreen.tsx
      ClockScreen.tsx
```
