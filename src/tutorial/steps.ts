/**
 * One spotlight step. `targetKey` (optional) names a component registered via
 * useTutorialTarget(); when absent the step shows a card with no highlight
 * (the same fallback the web overlay uses for its conceptual steps). Keys
 * keep the web app's `<page>-<thing>` shape so the two tours stay in step.
 */
export type TutorialStep = {
  key: string;
  title: string;
  body: string;
  targetKey?: string;
  /** Highlight the bottom tab bar instead of a measured element. */
  bottomBar?: boolean;
};

const CLOCK_IN: TutorialStep = {
  key: "clock-in",
  title: "Tap in, hold to clock out",
  body: "Tap Clock in to start the timer. To clock out, press and hold the Hold to clock out button until it fills. With VoiceOver or TalkBack on, it is a plain Clock out button instead. Breaks are a tap. No signal is fine: the punch saves on your phone and syncs later.",
  targetKey: "clockIn",
};

const TODAY_PROJECT: TutorialStep = {
  key: "today-project",
  title: "Tag the shift to a job",
  body: "Pick the project before you clock in, or switch it mid-shift without clocking out. A task can go on it too.",
  targetKey: "project",
};

export function buildSteps(role: string): TutorialStep[] {
  if (role === "manager") {
    // The overlay mounts inside the Clock tab, so the Roster, Approvals, and
    // Schedule steps spotlight the tab bar that leads to those screens.
    return [
      CLOCK_IN,
      TODAY_PROJECT,
      {
        key: "today-history",
        title: "Your recent shifts",
        body: "Tap one of your own shifts to edit it. Any change is written to the audit log and sends the shift back for approval.",
        targetKey: "history",
      },
      {
        key: "roster",
        title: "Your crew",
        body: "Tap a person, then a shift, to fix it on the spot. The map shows where punches happened, built from clock-ins, not tracking.",
        bottomBar: true,
      },
      {
        key: "approvals",
        title: "Approvals",
        body: "Timesheets, Time off, and Edit requests, each under its own heading. Rejecting sends a shift back with your reason.",
        bottomBar: true,
      },
      {
        key: "nav-schedule",
        title: "Schedule",
        body: "Add or change one shift at a time here. Recurring series and the week board live in the web app.",
        bottomBar: true,
      },
    ];
  }
  // Employee. The copy of record lists a sixth step, "Time off"; the mobile
  // app has no time-off screen for employees, so it is not included here.
  return [
    CLOCK_IN,
    TODAY_PROJECT,
    {
      key: "today-blocked-note",
      title: "If a punch is blocked",
      body: "Your manager can require the job site's location or its WiFi at clock-in, and a clock-in photo. Get on site and tap again, and tell your foreman the time you started.",
    },
    {
      key: "today-history",
      title: "Your recent shifts",
      body: "Tap a shift to ask for a correction: the exact minutes, the job, and why. Adjust start time under the timer fixes a shift you are still on.",
      targetKey: "history",
    },
    {
      key: "nav-schedule",
      title: "Your schedule",
      body: "The shifts your manager planned for you. If clock-in is tied to the schedule, you can only punch during a scheduled shift.",
      targetKey: "schedule",
    },
  ];
}
