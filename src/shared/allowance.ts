/**
 * What a learner reads when a budget holds back a model call (plan phase 7, step 2). The backend uses it for a held
 * wrap-up and the app for a held tutor turn, held preparation and the usage page, so the words are the same everywhere.
 */
import type { BudgetHold } from "./domain";

/** "December 1": the day the month's budget starts again, in UTC because periods are UTC months. */
export function resetDay(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

/** Says "used up" only when spend has reached the budget. Held with money left, it says not enough is left for another step. */
export function heldMessage(hold: BudgetHold): string {
  if (hold.reason === "stopped") return "AI features are paused for now. Nothing you have done is lost. Try again later.";
  const resets = `It resets on ${resetDay(hold.resetsAtMs)}.`;
  if (!hold.usedUp) return `Not enough of this month's AI allowance is left for another AI step. ${resets}`;
  return hold.reason === "user_budget" ? `This month's AI allowance is used up. ${resets}` : `After Class has used this month's AI allowance for everyone. ${resets}`;
}
