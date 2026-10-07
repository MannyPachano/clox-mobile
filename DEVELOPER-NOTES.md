# Clox Mobile — Developer Notes

Everything you need to run, test, and ship the employee clock-in app. Skim the headers.

---

## TL;DR — run it
```bash
cd "/Users/manuelpachano/Documents/clox-mobile"
npm install          # first time only
npx expo start       # add -c to clear cache if things act weird
```
Scan the QR with the iPhone **Camera** app (Android: the **Expo Go** app) → it opens in Expo Go → log in → clock in.

Test login: **`brightmindcr8@gmail.com` / `timTTPW1!`**

---

## What this is
- An **Expo / React Native** app for **employees**: clock in/out, breaks, pick project/task, works offline, syncs on reconnect.
- **Managers** do everything else (reports, approvals, scheduling) on the **web app** — `app.getclox.com`.
- It talks to the **same backend** as the website through `/api/mobile/v1/*`, reusing the exact clock-in/out logic, so the rules always match.

```
 iPhone (Expo Go)                      app.getclox.com                  Postgres
 ┌───────────────────┐   Bearer JWT   ┌──────────────────────────┐
 │ Supabase login    │ ─────────────▶ │ /api/mobile/v1/* routes  │ ──▶ same DB
 │ offline queue     │ ◀───────────── │ clockInCore/clockOutCore │     as the website
 └───────────────────┘     JSON       └──────────────────────────┘
```
- **Auth:** the app signs into Supabase directly, gets a token, and sends it on every API call.
- **Offline:** each tap is saved locally with a unique id, then synced when back online. The server dedupes by that id, so re-syncing never creates duplicate punches.

---

## Requirements (one-time)
| Thing | Note |
|---|---|
| **Node** | 22 LTS (≥ 20.19.4). Check `node -v`. You installed it via nvm. |
| **Expo Go** app | On your phone (App Store / Play Store). ⚠️ It only runs **one SDK** — the project must match it (currently **SDK 54**; see the SDK rule below). |
| Xcode / Android Studio | **Not** needed for Expo Go. Only for native builds (EAS does those in the cloud anyway). |

---

## Two ways to run it
| | **Expo Go** (development) | **Native build** (real use) |
|---|---|---|
| For | Day-to-day dev & testing | Crews, App Store / Play, cellular |
| Your Mac must be running Metro | Yes | No — it's standalone |
| Phone on same Wi-Fi as Mac | Yes (or `--tunnel`) | No |
| How | `npx expo start` | EAS Build — see `EAS-BUILD.md` |

> **Key mental model:** in Expo Go, your JavaScript is served live from the Metro server on your Mac. It's a *development* tool — the phone has to reach your Mac. For an app that runs on its own phone anywhere (cellular, no Mac), you build it with EAS.

---

## Daily dev workflow
1. `cd clox-mobile && npx expo start --go` (with `expo-dev-client` installed, plain `npx expo start` opens in development-build mode; press `s` there to switch to Expo Go)
2. Scan the QR → app opens in Expo Go.
3. Edit any file in `src/` and save → **Fast Refresh** updates the phone in ~1s.
4. **Reload:** press `r` in the terminal, or shake the phone → Reload.
5. **Dev menu:** shake the phone (or press `m`).
6. **Fully restart** (`Ctrl+C`, then `npx expo start -c`) when you:
   - changed **`.env`** (env values are baked in at startup),
   - changed **`app.json`** or added a package,
   - hit weird stale-cache behavior.

---

## Pointing the app at an API — the `.env` switch
File: `clox-mobile/.env`, line `EXPO_PUBLIC_API_BASE_URL`.

| Value | When to use |
|---|---|
| `https://app.getclox.com` | **Default / current.** Uses the deployed production API. |
| `http://<your-Mac-LAN-IP>:3000` | When testing backend changes you haven't deployed yet. Run `npm run dev` in the web repo, set this, restart Expo. Your Mac's IP shows in the `expo start` output (`exp://192.168.x.x`). |

After changing `.env`, restart: `Ctrl+C` → `npx expo start -c` (a plain reload won't pick it up).

> ⚠️ **Both point at the production database.** Any clock-in you do is a real entry for that test employee. Fine for the test accounts; don't test with a real crew member's account.

---

## Test accounts
| Role | Login | Use for |
|---|---|---|
| Employee | `brightmindcr8@gmail.com` / `timTTPW1!` | The mobile app |
| Manager | `support@getclox.com` / `timTTPW1!` | The web app, to verify punches landed |

---

## How to test the app

**Happy path**
1. Log in (employee) → clock screen.
2. Pick a project/task if shown → tap **Clock in** → a check draws in the button, the screen turns dark, the timer runs from 0:00:00, and the sync line goes from amber "Saved on this phone" to green "All punches synced".
3. **Take break** → card turns to **ON BREAK** with a break timer → **End break**.
4. **Hold to clock out** until the button fills (1.2 s) → timer stops. Letting go early resets it with "Keep holding". With VoiceOver or TalkBack on it is a plain **Clock out** button.
5. **Verify:** open the web app as the manager → that employee's timesheet shows the shift.
6. **Undo:** clock in again, then tap **Undo clock-in** within 10 seconds (45 with a screen reader on) → back to Not clocked in, and no new shift on the web timesheet. Online, the punch has usually synced by then, so this exercises the server undo (`/undo-clock-in`, needs web PR #19 deployed). In Airplane mode, a clock-in the phone never tried to send is simply taken out of its queue. One whose send had already started stays queued and the phone says it can't undo it offline; try again once online. When a send had started and the phone is online, the punch leaves the queue and the screen waits for the server: done shows the undone note, a refusal or a 404 leaves the server's state on screen with a banner, and no answer at all shows Not clocked in with "The undo isn't confirmed yet" while the phone asks again on each sync.

**Reminders test** (needs the web PR #19 server, whose `/status` carries `preferences`)
1. Account menu → **Reminders**. Against an older server the screen says reminders aren't available yet, and every switch is off and can't be turned on. That is the expected state until PR #19 is deployed.
2. Turn on **Before a scheduled shift**. If notifications are not allowed yet, turning the switch on asks where the phone still allows it, or offers Open Settings (iOS after one refusal). Allow it.
3. As the manager on the web, schedule a shift for this employee that starts about 15 minutes from now, then bring the app to the front (a refresh schedules the reminders). About 5 minutes later: "Your shift starts at h:mm AM." in the **org's** time zone. It opens the Clock screen when tapped.
4. Clock in early for that shift before the reminder fires: the reminder is cancelled. Clock out: reminders for later shifts come back.
5. As the **manager**, turn on **When a shift passes 10 hours**, clock in, then use **Adjust start time** to set the start to 9 hours 55 minutes ago. The refresh moves the reminder: "Still on the clock?" arrives about 5 minutes later, and tells a manager to fix the end time under Recent shifts (an employee's copy says to tap the shift there to ask for a change). Clock out before then and nothing arrives.
6. Deny path: turn notifications off for Clox in the phone's Settings. The Reminders screen says they can't show and offers **Open Settings**. Turning a switch on after a refusal leaves it off, says why and offers **Open Settings** (VoiceOver and TalkBack read the reason). With a reminder on (from the phone or web Settings) and notifications off, the Clock screen says so once per session in its banner; it never asks for permission itself for reminders. (From 1.4.0 on Android it asks once, after a clock-in stands, so the running shift can show on the lock screen: `src/notification-ask.ts`.)
7. Refused clock-in push (EAS build only, it is a remote push): as a manager, turn on **When a punch is refused**, then have a geofenced employee clock in off-site. Tap the push: the **Roster** tab opens, from a cold start, from the background, and after the app lock's PIN screen. For the lock case, set a lock, leave the app in the background for more than a minute, tap the push, enter the PIN, and check that Roster is showing. Repeat once with a lock set up in the same session (App.tsx gives the tap back to the tabs when the lock comes on after they took it).
8. **Sign out**: every reminder is cancelled.
- **Android is not on time.** Android 12 and later can deliver these up to an hour late (longer in Doze or battery saver), because the 1.3.0 build has no `SCHEDULE_EXACT_ALARM`: expo-notifications then falls back to `setAndAllowWhileIdle`. So a shift reminder can land after the shift starts. While the app is in the foreground such a late one is held back (`isLateShiftReminder`, via each reminder's `data.startsAt`); in the background the phone shows it. The Android sublabel says it can sometimes arrive late. On-time delivery needs `SCHEDULE_EXACT_ALARM` in a future store build (and, on Android 14 and later, the person granting it in Settings). iOS is on time.
- A change made off the phone (a shift moved or deleted on the web, a clock-in or clock-out on the web, a kiosk, a manager or the auto-clock-out cron) reaches the reminders only when the app next refreshes. The Reminders screen's footnote says so.
- Local reminders work in Expo Go; only the refused clock-in push needs an EAS build.

**Offline test**
1. Clock in while online (so you have a running shift).
2. Turn on **Airplane mode**.
3. Clock out / take a break → the UI updates instantly and shows "Saved on this phone" in amber ("N punches saved on this phone" for more than one).
4. Turn Wi-Fi back on → it auto-syncs → "All punches synced".
5. Confirm on the web app. Re-syncing the same punch never duplicates (idempotency keys).

> In **Expo Go**, offline only works *after* the app has loaded once (Metro has to have served the bundle). A true cold offline launch needs a native build.

**Lock screen, widget and notification test** (1.4.0 store build, or a development build from EAS; nothing here runs in Expo Go, where the native module is missing and the app behaves as 1.3.0 did)

iOS, through TestFlight on iOS 17 or later (the Dynamic Island needs an iPhone 14 Pro or later):
1. Clock in. A Live Activity appears on the Lock Screen and in the Dynamic Island: "ON THE CLOCK", a timer from 0:00:00, "Project · Task", and "Started h:mm AM" in the **org's** time zone.
2. Lock the phone and tap **Take break** on the card. iOS asks for Face ID or the passcode first. After it, the card reads "Starting your break." and then ON BREAK with the break's own timer and "Your shift started at h:mm AM.". **End break** the same way.
3. Long-press the Dynamic Island and tap **Clock out**. "Sending your clock-out." shows with the timer stopped at the tap, then "Clocked out at h:mm PM." stays on the Lock Screen for about 15 minutes. Open Clox: Not clocked in. On the web the shift ends at the tap time.
4. Background launch: open Clox and clock in, force-quit it, then clock out from the Lock Screen. Same result as step 3. The location arrow must not appear in the status bar (location is read only at a punch made in the app).
5. Airplane mode, then clock out from the Lock Screen: "Saved on this phone. It sends when you're online." Turn Airplane mode off and open Clox: the punch syncs with its tap time.
6. Clock in and tap **Undo clock-in** within 10 seconds: the Live Activity ends at once and nothing reaches the web.
7. Swipe the Live Activity away (or long-press it and remove it). Open Clox: it stays away. Take a break: it comes back. The next shift shows it again too.
8. Settings > Clox > Live Activities off, then clock in: nothing starts and nothing breaks. The widget still works.
9. In an org that requires a project, clock in with none: the card's Clock out opens Clox instead of punching (the server would refuse it).
10. Add the small Clox widget. Clocked out: "You're not clocked in." with **Clock in**, which only opens the Clock screen; the geofence, project and selfie checks run there, and nothing is punched until the Clock in button in the app is used. Clocked in: the timer and **Clock out**. Signed out: "Open Clox to sign in."
11. From Safari, open `clox://clock`: the Clock screen opens and nothing else happens. For a manager on another tab, the Clock tab opens. `clox://clock-in` only opens the app.
12. **Sign out**: the Live Activity and the widget's shift go at once. Sign in as another account: nothing of the first account shows, and a tap saved under it is never sent (the banner says "A lock screen tap from another account was not sent. Check your shift.").
13. App lock (decision 3): set a PIN, leave Clox in the background for more than a minute, unlock the phone and tap Clock out on the card. It sends without the Clox PIN. Opening Clox then asks for the PIN, and Face ID is offered once the app is in front (a background launch never uses up that offer).
14. Clock in on the web kiosk, then open Clox: the Live Activity starts. Clock out on the web, then open Clox: it ends.
15. Leave a shift running past 8 hours once. iOS ends a Live Activity 8 hours after it starts; with Clox open after 7.5 hours a fresh one replaces it, and otherwise the next open starts one.
16. Apple Watch, CarPlay or a Mac, where available: the Live Activity shows the timer only, no buttons. The Home Screen widget is not suggested on a Mac or in CarPlay; it is under "Other" in the widget gallery there, and WidgetKit cannot hide it completely. Added from "Other" anyway, its Clock out runs on the iPhone and needs the iPhone unlocked.
17. With **When a shift passes 10 hours** on, set the start 9 hours 55 minutes ago, force-quit Clox and clock out from the Lock Screen: "Still on the clock?" does not arrive.
18. Clock in on the phone, clock out on the web, then (without opening Clox) tap Clock out on the Lock Screen: it ends with "You're clocked out." and no time, and the web keeps its own end time.
19. Small widget on a break with no project: "Your shift started at h:mm AM." shows in full on two lines.

Android, with the preview APK:
1. Decline notifications at sign-in, then clock in: once the clock-in stands, Clox asks once, "Show your shift on the lock screen?", and never again on that phone. Allow shows the notification at once, also when the clock-in was made in Airplane mode. Someone who had allowed notifications at sign-in is never asked, even after turning them off later.
2. Clocked in: an "On the clock" notification with a running timer, "Project · Task", **Take break** and **Clock out**. It shows on the lock screen, also on a Pixel with silent notifications hidden there.
3. From the locked phone, tap Clock out: Android asks to unlock first. Then "Sending your clock-out.", then "You're clocked out." with "Clocked out at h:mm PM." under it, which goes away by itself.
4. Swipe Clox out of Recents, then clock out from the notification: it still sends (the headless task). Two minutes with no answer shows "Open Clox to send it.", and the tap is sent at the next open with its tap time.
5. Leave Clox in the background (not swiped away), lock the phone for a few minutes, then clock out from the notification: the final line comes within seconds without opening Clox (every tap starts the headless task, which keeps a backgrounded app's timers running). Repeat in Airplane mode: "Saved on this phone. It sends when you're online." comes the same way.
6. Android 14 and later: swipe the notification away. Opening Clox does not bring it back; a break or the next shift does.
7. Restart the phone, or Force stop Clox: the notification comes back the next time Clox opens (there is no boot permission, decision 6).
8. Airplane mode: "You're clocked out." with "Saved on this phone. It sends when you're online." under it, and the punch sends later with its tap time.
9. Notifications turned off: nothing shows and clocking works as before.
10. Clock in on the phone, clock out on the web, then tap Clock out on the notification: "You're clocked out." and no time.

Both: a surface clock-out while the Clock screen is not showing still cancels the long shift reminder, and a punch held after 23 hours still behaves as in the offline test.

---

## Expo Go cheat sheet (terminal keys while `expo start` runs)
| Key | Action |
|---|---|
| `r` | Reload the app |
| `m` | Toggle the dev menu |
| `j` | Open the debugger |
| `c` | Show the QR code again |
| `?` | List all commands |
| `Ctrl+C` | Stop the server |

- `npx expo start -c` — start with a cleared cache (fixes most "stale/weird" issues).
- `npx expo start --tunnel` — let the phone reach Metro over the internet (demo on cellular / different network; slower to load).

---

## Project structure
```
clox-mobile/
  App.tsx              # root — shows Login or Clock screen based on auth state
  index.js             # entry point
  app.json             # Expo config: name, icon, permissions, bundle id (com.getclox.clock)
  eas.json             # native build profiles (development / preview / production)
  .env                 # Supabase keys + API URL  (EXPO_PUBLIC_*)
  src/
    config.ts          # reads the env vars
    supabase.ts        # Supabase client + getAccessToken()
    secure-storage.ts  # keeps the session in iOS Keychain / Android Keystore
    api.ts             # typed calls to /api/mobile/v1/* (getStatus, clockIn, clockOut, breakStart, breakEnd)
    push.ts            # push token registration + the notification permission ask
    reminders.ts       # pure reminder rules (checkable with a plain node script)
    reminder-notifications.ts  # schedules/cancels reminders, caches the preferences
    components/RemindersSheet.tsx  # the Reminders screen (account menu)
    queue.ts           # offline punch queue + sync/drain logic
    shift-surface-state.ts  # pure rules for the Lock Screen, widget and notification (checked by scripts/shift-surface-check.mjs)
    shift-surface.ts   # bridge to modules/clox-shift-surface, the off switch, pushes from the Clock screen
    shift-actions.ts   # Lock Screen, widget and notification taps -> the same queued punches
    notification-ask.ts  # Android: the one-time notification question at the first clock-in
    location.ts        # GPS capture (expo-location)
    uuid.ts            # idempotency-key generator
    theme.ts           # colors
    components/SelectField.tsx   # the project/task picker
    screens/LoginScreen.tsx
    screens/MfaScreen.tsx   # the 6-digit code step for accounts with 2FA on
    lib/mfa.ts         # pure 2FA rules: the mfa_required signal, the token's aal, the words
    mfa-session.ts     # supabase.auth.mfa calls (list factors, verify a code)
    screens/ClockScreen.tsx
  modules/clox-shift-surface/  # Swift (Live Activity, widget taps) and Kotlin (ongoing notification)
  targets/widget/      # the iOS widget extension (Live Activity views, Home Screen widget), built by @bacons/apple-targets
  plugins/with-extension-versions.js  # keeps the widget's version and build number equal to the app's
```

---

## Backend / API (lives in the web repo, `Time Tracking App`)
Routes: `src/app/api/mobile/v1/`
| Endpoint | Method | Purpose |
|---|---|---|
| `/status` | GET | who am I + active shift + on-break + projects/tasks |
| `/clock-in` | POST | start a shift |
| `/clock-out` | POST | end a shift |
| `/break/start` | POST | start a break |
| `/break/end` | POST | end a break |
| `/switch-project` | POST | switch or retag the running shift's project |
| `/undo-clock-in` | POST | undo a clock-in by its idempotency key, within a minute (web PR #19) |
| `/my-schedule` | GET | the employee's own upcoming scheduled shifts (the app reads the next 14 days and reminds for the next 7) |
| `/profile/preferences` | POST | save any of `shiftReminderMinutes` (10 or null), `longShiftHours` (10 or null), `notifyRefusedPunch` (managers only); `/status` returns them as `preferences` (web PR #19) |

- **Auth:** `Authorization: Bearer <supabase access token>` → validated in `src/lib/mobile-auth.ts`.
- **Two-step verification (2FA).** An account with 2FA turned on (web Settings → Account & security) must send an `aal2` token. The server answers a password-only token with HTTP 401 `{ error: "mfa_required" }`, never 403. The app answers it with the 6-digit code step (`src/screens/MfaScreen.tsx`), both right after a password sign-in (App asks `mfa.listFactors()` alongside the status) and whenever any call answers `mfa_required` (a phone signed in before the app asked). It never signs the person out for it: the queue keeps punches on any 401, and after a correct code App sends them before the Clock screen comes back. Recovery codes stay on the web; the code step points to app.getclox.com/signin. The rules live in `src/lib/mfa.ts`; `node scripts/mfa-check.mjs` loads the real `queue.ts` and `api.ts` against a fake server to check that a queued punch survives `mfa_required` and is sent after the code.
- **Deploy backend changes:** commit + push the web repo → Vercel auto-deploys.
- **Verify it's live:**
  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" https://app.getclox.com/api/mobile/v1/status
  # 401 = deployed (rejecting no-token, as designed).  404 = not deployed yet.
  ```

---

## Shipping to real devices (no Mac tether) — see `EAS-BUILD.md` for full steps
- **Android (free, fastest):** `eas build -p android --profile preview` → install the APK link on any Android phone.
- **iOS (needs Apple Developer, $99/yr):** `eas build -p ios --profile production` → `eas submit` → invite testers via TestFlight.
- **OTA JS updates after a build:** `eas update` pushes JS-only fixes without rebuilding the binary. It publishes only to the runtime of the checkout it runs from (runtimeVersion policy `appVersion`). From 1.4.0 on, `main` publishes to 1.4.0, and 1.3.0 phones get fixes only from `release/1.3` (`EAS-BUILD.md`, "1.4.0").
- Before any store build: add a real app icon (`assets/icon.png`, 1024×1024) — it currently uses the Expo default.

---

## ⚠️ The SDK-matching rule (this is what kept breaking — read it)
**Expo Go only runs the exact SDK it was built for.** Your Expo Go is **SDK 54**, so the project is pinned to **SDK 54** (`expo` `~54.0.0`, React Native `0.81.5`, React `19.1`).

- ❌ **Do NOT run `npx expo install expo@latest`.** It jumps to the newest SDK (56), which your Expo Go can't open → "Project is incompatible with this version of Expo Go".
- ✅ To upgrade later: first find which SDK the App Store Expo Go is on, then:
  ```bash
  npx expo install expo@~<that-sdk>.0.0
  npx expo install --fix       # realigns react / react-native / expo-* to that SDK
  rm -rf node_modules package-lock.json && npm install
  ```
- A **native build** bundles its own runtime, so it's not tied to Expo Go's SDK — that's the long-term answer.

---

## Common errors → fixes
| Symptom | Fix |
|---|---|
| "Project is incompatible with this version of Expo Go" | Project SDK ≠ Expo Go SDK. Pin the project to Expo Go's SDK (above). |
| `npm ERR! ERESOLVE` during install | `npm install --legacy-peer-deps` |
| `npm ERR! network ECONNRESET` | Transient — run the same command again. |
| "Node.js is outdated" / `EBADENGINE` | Update Node to 22 (`nvm install --lts`), then **reopen Terminal**. |
| `The required package 'X' cannot be found` at start | `npx expo install X`, then `npx expo start -c`. |
| `.env` change has no effect | Restart: `Ctrl+C` → `npx expo start -c`. |
| Punches stuck "waiting to sync" / can't reach API | Same Wi-Fi as the API? If local: `npm run dev -- -H 0.0.0.0`. Or `npx expo start --tunnel`. Confirm the API with the `curl` above. |
| Red error screen on the phone | Read the message → fix the source file → save (Fast Refresh) or reload. Paste it to me if unclear. |

---

## What's built vs not (v1 scope)
- ✅ Login, clock in/out, breaks, project/task picker, mid-shift project switch, geofence enforcement, selfie-on-punch, GPS capture, offline queue + sync, light/dark theme (user setting), Clox wordmark, live clock when off, recent-shifts history, **push reminders** (pipeline built; needs an EAS build to actually receive).
- 🚧 Nothing major left on the roadmap. Next step is shipping an **EAS build** (`EAS-BUILD.md`) to run on real devices + exercise push.
- **Push:** the app registers its Expo token on launch, but only when notifications are already allowed: it asks for permission only when someone first turns on a switch on the Reminders screen (`src/push.ts` `askForNotifications`). The auto-clock-out cron sends a "we clocked you out" notification to opted-in employees who have a registered token, and the server sends managers who opt in a push when a clock-in is refused (`data.type` "refused_punch", which opens the Roster tab). Remote push only works in an EAS build, not Expo Go.
- **Reminders:** local notifications the phone schedules for itself, no server needed: one before each scheduled shift in the next 7 days and one when a running shift passes 10 hours. The rules are pure in `src/reminders.ts` (identifiers, text, what to schedule and cancel); `src/reminder-notifications.ts` carries them out with expo-notifications on an Android "reminders" channel created at runtime; `src/components/RemindersSheet.tsx` is the screen. All of it uses only what the 1.3.0 store build already has, so it ships to 1.3.0 as an EAS Update, published from `main` before the 1.4.0 version bump lands there (after that, `main` publishes to 1.4.0 only). Once it is live in both stores, flip `PHONE_REMINDERS_IN_STORE_APP` in the web repo's `src/lib/reminder-preferences.ts`.
- **Lock screen, Dynamic Island, widget and Android notification (1.4.0, native: needs the store build, not an OTA).** How it behaves:
  - **One punch path.** A tap on the Live Activity, the widget's Clock out or the notification is saved by the native module (`modules/clox-shift-surface`) and wakes the JavaScript (`src/shift-actions.ts`), which turns it into the same queued punch the Clock screen makes (`buildSimplePunch` + `enqueuePunch`) and sends it with the same drain. Swift and Kotlin never call the server or touch a token. A tap is queued only for the signed-in account it was saved under and at most once (its id is the punch id and the idempotency key); a session that cannot be read keeps it for later, and another account drops it with a banner line.
  - **When the JavaScript runs.** The `onTap` event while the app runs; on iOS a background launch of the app (it registers the listener in `index.js`, and native nudges once for a tap saved before that); on Android the headless task `CloxShiftAction`, which every notification tap starts, in the running app too (in the background React Native pauses the JavaScript timers and Android may freeze the process; a running headless task prevents both); and at every launch and return to the foreground. The pass is single-flight, so the event and the task join one pass. A tap nothing woke up for is sent at the next open, with its tap time. The iOS button waits up to 20 seconds for the send; after 2 minutes without an answer a surface says "Open Clox to send it."
  - **What draws the shift.** The Clock screen pushes it when it changes the shift itself (clock-in, undo, break start and end, project or task switch, clock-out) and when a refresh applies the server's answer, never on every render. A tap's outcome is drawn by `shift-actions.ts`: "Clocked out at 5:02 PM.", "You're clocked out." when the shift had already ended elsewhere (a 409, so the tap's time is not the recorded one), "Saved on this phone. It sends when you're online.", or a refusal line that keeps the shift and turns Clock out into an Open Clox link. The refusal line stays through the Clock screen's refreshes until the shift, its phase or its project changes, or another tap is made. On Android it is the notification's body, since the one-line header cuts off long text. Every native write goes through one line (`runSurfaceOp`), so a push, a tap's outcome and a sign-out never interleave.
  - **Clox app lock (decision 3).** Surface buttons work once the phone itself is unlocked; the Clox PIN is not asked for them. iOS keeps the buttons inactive on a locked phone, Android 12 and later asks to unlock before the action runs, and Android 7 to 11 route the action through an invisible activity so the system asks first. The tap pass does not depend on a screen, so it runs with the PIN screen up. The PIN screen offers Face ID only once the app is in the foreground.
  - **Links.** `clox://clock` (the widget's Clock in, a tap on the Live Activity or the notification) opens the Clock screen and nothing else (decision 2). No link ever punches.
  - **Location** is still read only at a punch made in the app. Surface taps carry none, and the Clock screen's GPS warm-up waits for the foreground, so a background launch never reads it.
  - **Reminders.** A surface clock-out that is sent or saved cancels "Still on the clock?" directly (`cancelLongShiftReminders`), without the Clock screen. Shift reminders held while on the clock come back at the Clock screen's next refresh.
  - **Swipes and the 8 hour end.** Swiping the Live Activity or the notification away keeps it away for that shift and phase; a break starting or ending, or the next shift, shows it again. iOS ends a Live Activity 8 hours after it starts; in the foreground the app replaces it at 7.5 hours, otherwise the next open starts a new one. A clock-out's final line stays up until it times out.
  - **Sign-out and account deletion** end every surface and clear the saved taps. **Re-authentication** from the PIN screen takes the surfaces down but keeps saved taps, like the queue; they are sent once the same person signs in again.
  - **Android** posts the notification only with notification permission; Clox asks once more at the first clock-in for someone who declined at sign-in (decision 4, `src/notification-ask.ts`). After a restart or a Force stop it comes back at the next open (no boot permission, decision 6).
  - **Known limits.** A clock-out or edit made on the web, at a kiosk, by a manager or by the auto-clock-out cron reaches the surfaces only when the app next refreshes (no ActivityKit pushes in this release). Headless JavaScript on Android and the iOS background launch are unproven until the first device test; if either fails, the tap still waits in the inbox and is sent at the next open.
  - **Off switch.** Set `SHIFT_SURFACES_ENABLED` to false in `src/shift-surface.ts` and publish an EAS Update to runtime 1.4.0: the next push ends every surface and native ignores new taps. Taps already saved are still sent.
  - **Checks** (no device needed): `node scripts/shift-surface-check.mjs` (the rules), `node scripts/shift-surface-native-check.mjs` (Swift mirrors), `node scripts/shift-surface-android-check.mjs` (Kotlin mirrors), `node scripts/lock-policy-check.mjs` (the app-lock rules).
- **Theme setting:** dark-on-shift / always-light / always-dark is set on the web (Settings → Profile → On-shift appearance) and read by both apps from `profiles.theme_preference`. Needs migration **0032** applied before deploy.
