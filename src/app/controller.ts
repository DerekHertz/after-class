/**
 * One review session's client-side state machine, as a plain external store
 * (subscribe / getState) so React reads it with useSyncExternalStore and tests
 * drive it without a DOM.
 *
 * Turn flow, which keeps a resend the same request (R15):
 *   mint turnId once per act → keep {turnId, act} in the unsent store →
 *   stream → `learner_turn_stored` removes it from the store.
 * A turn that failed before it was stored is resent from the store with its
 * original id. A stored turn the tutor never answered is resent from the
 * review view, again with its original id.
 *
 * While an unsent turn exists, `send` is refused: the oldest unsent turn must
 * be resent first, so turns reach the backend in the order the learner made
 * them. An act the backend would reject is refused before it is stored.
 */
import { z } from "zod";
import type { LearnerAct, ReviewView } from "../shared/domain";
import type { ReviewId, TurnId } from "../shared/ids";
import { randomId } from "../shared/ids";
import { learnerAct } from "../shared/wire";
import { ApiError } from "./api";
import type { Api } from "./api";
import { owedLearnerTurn, reduceLive, startLive, unansweredLearnerTurn } from "./core";
import type { Live } from "./core";
import type { Speaker } from "./speech";
import type { UnsentStore, UnsentTurn } from "./unsent";

export type SessionState = {
  readonly view: ReviewView | null;
  readonly loadError: string | null;
  readonly live: Live | null;
  readonly unsent: readonly UnsentTurn[];
  /** The browser would not keep unsent turns (IndexedDB missing, blocked or failing): they live in this page only. */
  readonly storageDegraded: boolean;
  /** Why the last `send` was refused, or null. */
  readonly sendError: string | null;
  readonly saving: boolean;
  /** Set while a save is pending: the last attempt failed, or the backend reports `save_pending`. Retry calls the same save. */
  readonly saveError: string | null;
  readonly savedSummary: { readonly notes: number; readonly observations: number; readonly links: number } | null;
};

export type ReviewController = {
  getState(): SessionState;
  subscribe(listener: () => void): () => void;
  load(): Promise<void>;
  /** True when the act was accepted and sent; false when it was refused (invalid, or an earlier turn is unsent) or ignored. */
  send(act: LearnerAct): Promise<boolean>;
  /** Resend the oldest unsent turn, the stored turn the tutor never answered, or the one whose chain stopped part-way. Same id as before. */
  retryTurn(): Promise<void>;
  /**
   * Drop every unsent turn and the failure it left. The backend never stored them, so nothing is counted for them
   * (R13: "A skipped or unanswered question is never counted as understood.").
   */
  discardUnsent(): Promise<void>;
  save(): Promise<void>;
  /** The learner started speaking: the tutor goes quiet. */
  learnerSpeaking(): void;
};

export type ControllerDeps = {
  readonly api: Api;
  readonly reviewId: ReviewId;
  readonly speaker: Speaker;
  readonly unsent: UnsentStore;
  readonly mintTurnId?: () => TurnId;
  readonly nowMs?: () => number;
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Flow D: "[code]  Show the topics in the frozen scope as a checklist."
 * True for a loaded, active review with no turns, nothing unsent and nothing streaming: the learner has not started it yet.
 * The review no longer begins by itself; the learner marks topics and starts it (a `begin` act with `fuzzy` and `note`).
 */
export function needsChecklist(state: SessionState): boolean {
  return state.view !== null && state.view.state.phase === "active" && state.view.turns.length === 0 && state.unsent.length === 0 && state.live === null;
}

/**
 * True for a loaded, active review whose tutor owes a move (a request stopped after a disclosure or a closed thread),
 * with nothing unsent and nothing streaming.
 */
export function needsResume(state: SessionState): boolean {
  return state.view !== null && owedLearnerTurn(state.view) !== null && state.unsent.length === 0 && state.live === null;
}

/** Resends the learner turn the tutor still owes a move for, at most once per call of this factory. A second failure leaves the Retry button. */
export function resumeOnce(controller: Pick<ReviewController, "retryTurn">): (state: SessionState) => void {
  let sent = false;
  return (state) => {
    if (sent || !needsResume(state)) return;
    sent = true;
    void controller.retryTurn();
  };
}

export function createReviewController(deps: ControllerDeps): ReviewController {
  const { api, reviewId, speaker, unsent } = deps;
  const mint = deps.mintTurnId ?? (() => randomId("turn"));
  const now = deps.nowMs ?? Date.now;
  let state: SessionState = { view: null, loadError: null, live: null, unsent: [], storageDegraded: false, sendError: null, saving: false, saveError: null, savedSummary: null };
  const listeners = new Set<() => void>();
  let streaming = false;

  const set = (patch: Partial<SessionState>) => {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  };

  async function refreshView(): Promise<void> {
    try {
      const view = await api.review(reviewId);
      set({ view, loadError: null, ...(view.saved === "saved" ? { saveError: null } : {}) });
    } catch (e) {
      set({ loadError: message(e) });
    }
  }

  async function refreshUnsent(): Promise<void> {
    const turns = await unsent.forReview(reviewId);
    set({ unsent: turns, storageDegraded: unsent.degraded });
  }

  /** One turn at a time, claimed before the first await so a double click cannot start two. */
  async function exclusive<T>(run: () => Promise<T>): Promise<T | undefined> {
    if (streaming) return undefined;
    streaming = true;
    try {
      return await run();
    } finally {
      streaming = false;
    }
  }

  async function runTurn(turnId: TurnId, act: LearnerAct): Promise<void> {
    speaker.beginTurn();
    set({ live: startLive(turnId) });
    let wrappedUp = false;
    try {
      for await (const event of api.sendTurn(reviewId, turnId, act)) {
        if (event.type === "move" && event.move.kind === "wrap_up") wrappedUp = true;
        if (event.type === "learner_turn_stored") {
          await unsent.remove(turnId);
          await refreshUnsent();
        } else if (event.type === "sentence") {
          speaker.speak(event.text);
        }
        set({ live: reduceLive(state.live ?? startLive(turnId), event) });
      }
    } catch (e) {
      const retryable = e instanceof ApiError ? e.retryable : false;
      set({ live: reduceLive(state.live ?? startLive(turnId), { type: "turn_failed", error: message(e), retryable }) });
    }
    await refreshView();
    if (state.live?.status === "complete") set({ live: null });
    await saveIfEnded(wrappedUp);
  }

  async function saveIfEnded(wrappedUp: boolean): Promise<void> {
    // A reloaded `save_pending` review waits for the learner's Retry; only a fresh end saves on its own.
    // The backend marks the save pending in the same transaction that ends the review (#138), so a turn that wrapped up saves either way.
    const saved = state.view?.saved;
    if (state.view?.state.phase === "ended" && (saved === "unsaved" || (wrappedUp && saved === "save_pending")) && state.saveError === null) await save();
  }

  async function save(): Promise<void> {
    if (state.saving) return;
    set({ saving: true });
    try {
      const result = await api.save(reviewId);
      if (result.kind === "saved") {
        set({ saving: false, saveError: null, savedSummary: { notes: result.notes, observations: result.observations, links: result.links } });
        await refreshView();
      } else {
        set({ saving: false, saveError: result.error });
      }
    } catch (e) {
      set({ saving: false, saveError: message(e) });
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async load() {
      // Unsent turns first, so a loaded view never shows before the unsent store is known (the review opens by checking both).
      await refreshUnsent();
      await refreshView();
    },
    send: async (act) =>
      (await exclusive(async () => {
        const parsed = learnerAct.safeParse(act);
        if (!parsed.success) {
          set({ sendError: `Not sent. ${z.prettifyError(parsed.error)}` });
          return false;
        }
        if ((await unsent.forReview(reviewId)).length > 0) {
          await refreshUnsent();
          set({ sendError: "Your earlier message was not delivered yet. Retry it before sending another." });
          return false;
        }
        set({ sendError: null });
        if (act.kind === "pause" || act.kind === "end") speaker.stop();
        const turnId = mint();
        // Persist before any network call: a crash after this line resends the same id.
        await unsent.put({ turnId, reviewId, act, createdAtMs: now() });
        await refreshUnsent();
        await runTurn(turnId, act);
        return true;
      })) ?? false,
    retryTurn: () =>
      exclusive(async () => {
        const [oldest] = await unsent.forReview(reviewId);
        if (oldest) return runTurn(oldest.turnId, oldest.act);
        const waiting = state.view ? unansweredLearnerTurn(state.view.turns) : null;
        if (waiting) return runTurn(waiting.id, waiting.act);
        const owed = state.view ? owedLearnerTurn(state.view) : null;
        if (owed) return runTurn(owed.id, owed.act);
      }),
    discardUnsent: async () => {
      await exclusive(async () => {
        for (const t of await unsent.forReview(reviewId)) await unsent.remove(t.turnId);
        set({ live: state.live?.status === "failed" ? null : state.live, sendError: null });
        await refreshUnsent();
      });
    },
    save,
    learnerSpeaking: () => speaker.stop(),
  };
}
