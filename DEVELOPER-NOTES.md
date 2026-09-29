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
6. Deny path: turn notifications off for Clox in the phone's Settings. The Reminders screen says they can't show and offers **Open Settings**. Turning a switch on after a refusal leaves it off, says why and offers **Open Settings** (VoiceOver and TalkBack read the reason). With a reminder on (from the phone or web Settings) and notifications off, the Clock screen says so once per session in its banner; it never asks for permission itself.
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
    location.ts        # GPS capture (expo-location)
    uuid.ts            # idempotency-key generator
    theme.ts           # colors
    components/SelectField.tsx   # the project/task picker
    screens/LoginScreen.tsx
    screens/ClockScreen.tsx
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
- **OTA JS updates after a build:** `eas update` pushes JS-only fixes without rebuilding the binary.
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
- **Reminders:** local notifications the phone schedules for itself, no server needed: one before each scheduled shift in the next 7 days and one when a running shift passes 10 hours. The rules are pure in `src/reminders.ts` (identifiers, text, what to schedule and cancel); `src/reminder-notifications.ts` carries them out with expo-notifications on an Android "reminders" channel created at runtime; `src/components/RemindersSheet.tsx` is the screen. All of it uses only what the 1.3.0 store build already has, so it ships as an EAS Update. Once it is live in both stores, flip `PHONE_REMINDERS_IN_STORE_APP` in the web repo's `src/lib/reminder-preferences.ts`.
- **Theme setting:** dark-on-shift / always-light / always-dark is set on the web (Settings → Profile → On-shift appearance) and read by both apps from `profiles.theme_preference`. Needs migration **0032** applied before deploy.
