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
 */
import type { LearnerAct, ReviewView } from "../shared/domain";
import type { ReviewId, TurnId } from "../shared/ids";
import { randomId } from "../shared/ids";
import { ApiError } from "./api";
import type { Api } from "./api";
import { reduceLive, startLive, unansweredLearnerTurn } from "./core";
import type { Live } from "./core";
import type { Speaker } from "./speech";
import type { UnsentStore, UnsentTurn } from "./unsent";

export type SessionState = {
  readonly view: ReviewView | null;
  readonly loadError: string | null;
  readonly live: Live | null;
  readonly unsent: readonly UnsentTurn[];
  readonly saving: boolean;
  /** Set while a save is pending: the last attempt failed, or the backend reports `save_pending`. Retry calls the same save. */
  readonly saveError: string | null;
  readonly savedSummary: { readonly notes: number; readonly observations: number; readonly links: number } | null;
};

export type ReviewController = {
  getState(): SessionState;
  subscribe(listener: () => void): () => void;
  load(): Promise<void>;
  send(act: LearnerAct): Promise<void>;
  /** Resend the oldest unsent turn, or the stored turn the tutor never answered. Same id as before. */
  retryTurn(): Promise<void>;
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

export function createReviewController(deps: ControllerDeps): ReviewController {
  const { api, reviewId, speaker, unsent } = deps;
  const mint = deps.mintTurnId ?? (() => randomId("turn"));
  const now = deps.nowMs ?? Date.now;
  let state: SessionState = { view: null, loadError: null, live: null, unsent: [], saving: false, saveError: null, savedSummary: null };
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
    set({ unsent: await unsent.forReview(reviewId) });
  }

  /** One turn at a time, claimed before the first await so a double click cannot start two. */
  async function exclusive(run: () => Promise<void>): Promise<void> {
    if (streaming) return;
    streaming = true;
    try {
      await run();
    } finally {
      streaming = false;
    }
  }

  async function runTurn(turnId: TurnId, act: LearnerAct): Promise<void> {
    speaker.beginTurn();
    set({ live: startLive(turnId) });
    try {
      for await (const event of api.sendTurn(reviewId, turnId, act)) {
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
    await saveIfEnded();
  }

  async function saveIfEnded(): Promise<void> {
    // A reloaded `save_pending` review waits for the learner's Retry; only a fresh end saves on its own.
    if (state.view?.state.phase === "ended" && state.view.saved === "unsaved" && state.saveError === null) await save();
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
      await Promise.all([refreshView(), refreshUnsent()]);
    },
    send: (act) =>
      exclusive(async () => {
        if (act.kind === "pause" || act.kind === "end") speaker.stop();
        const turnId = mint();
        // Persist before any network call: a crash after this line resends the same id.
        await unsent.put({ turnId, reviewId, act, createdAtMs: now() });
        await refreshUnsent();
        await runTurn(turnId, act);
      }),
    retryTurn: () =>
      exclusive(async () => {
        const [oldest] = await unsent.forReview(reviewId);
        if (oldest) return runTurn(oldest.turnId, oldest.act);
        const waiting = state.view ? unansweredLearnerTurn(state.view.turns) : null;
        if (waiting) return runTurn(waiting.id, waiting.act);
      }),
    save,
    learnerSpeaking: () => speaker.stop(),
  };
}
