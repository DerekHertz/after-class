/**
 * What a learner reads when a budget holds back a model call (plan phase 7, step 2). The backend uses it for a held
 * wrap-up and the app for a held tutor turn, held preparation and the usage page, so the words are the same everywhere.
 */
import type { BudgetHold } from "./domain";

/** "December 1": the day the month's budget starts again, in UTC because periods are UTC months. */
export function resetDay(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

export function heldMessage(hold: BudgetHold): string {
  switch (hold.reason) {
    case "user_budget":
      return `This month's AI allowance is used up. It resets on ${resetDay(hold.resetsAtMs)}.`;
    case "total_budget":
      return `After Class has used this month's AI allowance for everyone. It resets on ${resetDay(hold.resetsAtMs)}.`;
    case "stopped":
      return "AI features are paused for now. Nothing you have done is lost. Try again later.";
  }
}
