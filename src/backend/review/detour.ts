/**
 * The detour state machine, folded one turn at a time. Pure. tutor.ts reads it
 * for ReviewState; clamp.ts reads it to decide which learner turns belong to the
 * open main thread. One fold means the two cannot disagree about "active".
 * R11: "A detour only starts after I say yes."
 */
import type { ResourceId, TurnId } from "../../shared/ids";
import type { DetourState, LearnerActKind, Turn, TutorMoveKind } from "../../shared/domain";

/** Tutor moves that bring an active detour back to the lecture. */
const RETURNS_TO_LECTURE: ReadonlySet<TutorMoveKind> = new Set(["ask_main", "ask_followup", "diagnose", "close_thread", "wrap_up"]);

/** Learner acts that leave a proposed detour standing. Any other act declines it. */
const KEEPS_PROPOSAL: ReadonlySet<LearnerActKind> = new Set(["pause", "resume", "detour_accept", "detour_decline", "detour_wait", "detour_continue_without_resource"]);

export interface DetourTracker {
  readonly state: DetourState;
  /** Feed turns in seq order. */
  step(t: Turn): void;
}

export function detourTracker(): DetourTracker {
  let detour: DetourState = { kind: "none" };
  let acceptedTurnId: TurnId | null = null;
  const readyResources = new Set<ResourceId>();
  return {
    get state() {
      return detour;
    },
    step(t) {
      if (t.actor === "learner") {
        const act = t.act;
        if (detour.kind === "proposed" && !KEEPS_PROPOSAL.has(act.kind)) detour = { kind: "none" };
        switch (act.kind) {
          case "detour_accept":
            if (detour.kind === "proposed") {
              acceptedTurnId = t.id;
              const needs: ResourceId | null = detour.needsResource;
              detour = needs !== null && !readyResources.has(needs)
                ? { kind: "awaiting_resource", resourceId: needs, topic: detour.topic }
                : { kind: "active", topic: detour.topic, acceptedTurnId: t.id };
            }
            break;
          case "detour_decline":
            if (detour.kind === "proposed") detour = { kind: "none" };
            break;
          case "detour_continue_without_resource":
            if (detour.kind === "awaiting_resource" && acceptedTurnId !== null) detour = { kind: "active", topic: detour.topic, acceptedTurnId };
            break;
          default:
            break;
        }
      } else if (t.actor === "tutor") {
        const move = t.move;
        if (detour.kind === "active" && RETURNS_TO_LECTURE.has(move.kind)) detour = { kind: "none" };
        if (move.kind === "propose_detour") detour = { kind: "proposed", turnId: t.id, topic: move.topic, needsResource: move.needsResource };
      } else if (t.notice.kind === "resource_ready") {
        readyResources.add(t.notice.resourceId);
        if (detour.kind === "awaiting_resource" && detour.resourceId === t.notice.resourceId && acceptedTurnId !== null) {
          detour = { kind: "active", topic: detour.topic, acceptedTurnId };
        }
      }
    },
  };
}
