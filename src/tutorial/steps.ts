/**
 * One spotlight step. `targetKey` (optional) names a component registered via
 * useTutorialTarget(); when absent the step shows a centered/info card with no
 * highlight. Mirrors the web app's step concept (clox web src/components/
 * tutorial/steps.ts) so the two tours stay conceptually identical.
 */
export type TutorialStep = {
  key: string;
  title: string;
  body: string;
  targetKey?: string;
  /** Highlight the bottom tab bar instead of a measured element. */
  bottomBar?: boolean;
};

export function buildSteps(role: string): TutorialStep[] {
  const steps: TutorialStep[] = [
    {
      key: "clock-in",
      title: "Clock in here",
      body: "Tap this to start your shift. The timer runs until you clock out. It works offline too, and punches sync when you're back on signal.",
      targetKey: "clockIn",
    },
    {
      key: "project",
      title: "Tag a project",
      body: "Pick a project before you clock in so your hours roll up by job. Your manager may require one.",
      targetKey: "project",
    },
    {
      key: "history",
      title: "Your recent shifts",
      body: "Past shifts show here. Tap any one to see the details.",
      targetKey: "history",
    },
  ];
  if (role === "manager") {
    steps.push({
      key: "tabs",
      title: "Your manager tools",
      body: "Use the tabs along the bottom: Roster (who's on the clock), Schedule, and Approvals for timesheets and time off.",
      bottomBar: true,
    });
  }
  return steps;
}
