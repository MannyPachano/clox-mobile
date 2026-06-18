# Getting Clox Mobile onto real phones

Three ways to run the app, in increasing order of effort. Pick by goal.

## What works where

| | Expo Go (dev) | EAS build (dev/preview/prod) |
|---|---|---|
| Clock in/out, GPS, offline, selfie | ✅ | ✅ |
| **Push notifications** | ❌ (removed from Expo Go in SDK 53+) | ✅ (needs `projectId` + credentials, below) |
| Install without a cable | ✅ (QR) | ✅ (link/QR or TestFlight) |
| Apple/Google account needed | ❌ | iOS: $99/yr · Android APK: free |

The one thing you **cannot** test in Expo Go is push. Everything else you can.

---

## 0. Just test on YOUR phone (free, instant — no EAS)
```bash
cd clox-mobile
npm install
npx expo start
```
Install **Expo Go** (App Store / Play Store), scan the QR. Full app except push.

---

## 1. One-time EAS setup
EAS Build compiles the app in Expo's cloud (no Xcode/Android Studio needed).

```bash
npm install -g eas-cli      # or use `npx eas-cli@latest` in place of `eas` below
eas login                   # free Expo account — sign up at expo.dev if needed
cd clox-mobile
eas init                    # creates the project on Expo's servers AND writes
                            # extra.eas.projectId into app.json
```

> **Commit the `app.json` change `eas init` makes.** It adds `extra.eas.projectId`
> — the app reads exactly that field to fetch its push token. **No projectId →
> no push** (the app skips it silently). This is the #1 reason push "doesn't work."

`eas.json` (build profiles: `development` / `preview` / `production`) is already in
the repo, so `eas build:configure` isn't needed. It uses
`appVersionSource: "remote"`, so EAS auto-manages iOS `buildNumber` / Android
`versionCode` in the cloud — you don't set them in `app.json` (only the human
`version`, currently `1.0.0`).

---

## 2. Android — free + fastest distribution (recommended first)
No paid account, no store review. Produces an `.apk` you (or your crew) install directly.
```bash
eas build -p android --profile preview
```
EAS prints a download link + QR. On an Android phone: open it, allow "install
unknown apps," install. (For push on Android, see §4 — it needs an FCM key.)

To put it on the Play Store later: `--profile production` (an `.aab`), then
`eas submit -p android` (needs the $25 one-time Play Developer account).

---

## 3. iOS — TestFlight (needs the Apple Developer Program, $99/yr)
Apple has no standalone distribution without it. EAS manages signing for you.

```bash
eas build -p ios --profile production
# EAS will prompt to set up signing + a Push Notifications key (APNs) — say yes;
# it creates and stores them for you. This is what makes iOS push work.
eas submit -p ios          # uploads the build to App Store Connect → TestFlight
```

Then in **App Store Connect → your app → TestFlight**:
- The build shows as "Processing" for ~5–30 min after submit before it's usable.
- **Internal testers** (up to 100 people on your team, no Apple review) — add them
  and they get the invite immediately once processing finishes. Best for a beta.
- **External testers** (public link, up to 10k) require a one-time Beta App Review
  (a day or so) — only needed when you go wider.

**Your own device only (ad-hoc), skipping TestFlight:**
```bash
eas device:create          # register your iPhone (one-time, follow the link)
eas build -p ios --profile preview
```
Install via the link EAS gives you.

---

## 4. Push notifications — enabling + testing

**The backend is already built** (token registration, the Expo send path with
dead-token pruning, and the manager/employee triggers). Push just needs a
*native build that can get a token*. Checklist to make a push actually arrive:

1. **`projectId` committed** (§1) — without it the app never requests a token.
2. **A native build** (preview or production), not Expo Go.
3. **iOS:** the APNs key from the `eas build -p ios` prompts (§3).
   **Android:** standalone push needs **FCM** credentials. Create a Firebase
   project for `com.getclox.clock`, then run `eas credentials -p android` and
   upload the FCM V1 service-account key (Expo's docs: "Add Android FCM").
   (iOS-only beta? You can skip this.)
4. **Permission granted** — the app asks on first launch after login; the user
   must tap **Allow**. (Denied → no push; they'd re-enable in iOS/Android Settings.)
5. **Backend deployed** — `https://app.getclox.com/api/mobile/v1/register-push-token`
   and the cron/actions that send must be live in prod.

### End-to-end test (real path)
1. Install the native build on a **manager's** phone, log in, tap **Allow** on the
   notification prompt. (This silently registers the device token.)
2. From another device/account, have an **employee request time off**
   (Time off → request). The manager's phone should get
   **"<name> requested time off."**
3. The other live trigger: the **auto-clock-out cron** pushes
   "we clocked you out" to opted-in employees who forgot to clock out.

### Quick test (manual, no waiting on an event)
Temporarily `console.log` the token in `src/push.ts` (`getDeviceToken` returns it),
read it from the device logs, then paste it into the **Expo push tool**
(https://expo.dev/notifications) with a title/body and send. If it arrives,
the device half works; if the real path then fails, the issue is server-side.

### If push doesn't arrive — check in this order
- `extra.eas.projectId` present in the built `app.json`? (most common miss)
- Running a **native build**, not Expo Go?
- Notification permission **granted** on the device?
- iOS: APNs key set during build? Android: FCM key uploaded?
- A row in the `push_tokens` table for that user? (proves registration worked)
- Backend logs: `expo push: ...` lines from `src/lib/push.ts`.

---

## Before a public store release (not needed for internal/TestFlight/Expo Go)
- **App icon + splash.** The app currently uses Expo's default icon — fine for
  internal TestFlight, but the App Store / Play Store **reject** it for public
  release. Add a 1024×1024 `assets/icon.png` (+ an Android adaptive icon) and
  reference them in `app.json` under `expo.icon` / `expo.android.adaptiveIcon` /
  `expo.splash`.
- **Bundle IDs** are set: `com.getclox.clock` (iOS `bundleIdentifier` + Android
  `package`). Change in `app.json` *before* the first build if you want different
  ones — they're hard to change after a store listing exists.

## Fastest path to "my crew is testing it"
1. Deploy the backend (the `/api/mobile/v1/*` routes + migrations 0032/0033).
2. `eas init` and **commit** the `projectId`.
3. `eas build -p android --profile preview` → share the APK link with Android folks.
4. iPhone: `eas build -p ios --profile production` + `eas submit -p ios` → add them
   as TestFlight internal testers. (Or Expo Go + `npx expo start` for a no-push trial.)
