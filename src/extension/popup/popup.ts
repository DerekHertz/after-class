/**
 * Popup (W2). Shows source, caption status, frame health, invites; Start /
 * Pause / Resume / Stop; Review now (always available); the opt-in
 * transcription offer when captions are unusable. Talks only to the SW via
 * PopupRequest; never to the backend directly.
 *
 * `describePopup` is the pure view model (unit-tested); `renderPopup` only draws it.
 */
import type { CaptureView, InviteAnswer, InviteState } from "../../shared/domain";
import { isWatchUrl } from "../worker/control";
import type { PopupRequest, TabCaptureState } from "../worker/service-worker";

export type PopupAction = "start" | "pause" | "resume" | "stop";
/** What a Retry button re-does: the Start request, the content script's observers, or the transcript read. */
export type PopupRetry = "start" | "observe" | "transcript";

export type PopupView = {
  readonly headline: string;
  readonly tone: "ok" | "warn" | "bad" | "neutral";
  readonly actions: readonly PopupAction[];
  readonly hint: string | null;
  readonly source: { readonly title: string; readonly channel: string; readonly videoId: string } | null;
  readonly captions: string;
  readonly offerTranscription: boolean;
  readonly health: readonly { readonly label: string; readonly text: string; readonly tone: "ok" | "warn" | "bad" | "neutral" }[];
  readonly watched: string | null;
  readonly invite: InviteState;
  /** Review now is always first; Later, Wait and Stop early join it while an invite is invited or waiting. */
  readonly inviteAnswers: readonly InviteAnswer[];
  readonly retries: readonly PopupRetry[];
  readonly problem: string | null;
  /** Facts the backend refused and the outbox set aside; each is a logged gap, shown so it is never silent. */
  readonly deadLetters: string | null;
};

const CAPTION_TEXT: Readonly<Record<CaptureView["transcript"], string>> = {
  available: "Captions found",
  unavailable_offer_asr: "No usable captions",
  gap_accepted: "Continuing with a transcript gap",
  asr_running: "Transcribing (opt-in)",
  unknown: "Checking captions",
};

function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min ${Math.round(s % 60)} s`;
}

export function describePopup(state: TabCaptureState | null, tab: { readonly url: string | undefined }, opts: { readonly startFailed?: boolean } = {}): PopupView {
  const onWatch = isWatchUrl(tab.url);
  const capture = state?.lastAck?.capture ?? null;
  const source = capture?.sources.find((s) => s.id === capture.currentSourceId) ?? null;

  let headline = "Not capturing";
  let tone: PopupView["tone"] = "neutral";
  let actions: PopupAction[] = onWatch ? ["start"] : [];
  let hint: string | null = onWatch ? null : "Open a YouTube video to start capture.";
  if (state?.state === "capturing") {
    [headline, tone, actions, hint] = ["Capturing", "ok", ["pause", "stop"], null];
  } else if (state?.state === "paused") {
    const left = state.pauseReason === "left_watch_page";
    headline = left ? "Paused: you left the video page" : "Paused";
    tone = "warn";
    actions = onWatch ? ["resume", "stop"] : ["stop"];
    hint = left && !onWatch ? "Capture stays paused until you come back and press Resume." : null;
  } else if (state?.state === "stopped") {
    headline = "Stopped";
  }

  const health = (capture?.health ?? []).map((h) => ({
    label: h.channel === "frames" ? "Frames" : h.channel === "transcript" ? "Transcript" : "Playback",
    text: h.detail ? `${h.health}: ${h.detail}` : h.health,
    tone: h.health === "ok" ? ("ok" as const) : h.health === "unknown" ? ("neutral" as const) : h.health === "stalled" ? ("warn" as const) : ("bad" as const),
  }));

  const problem = state?.lastError ? `Backend: ${state.lastError}${state.uploadBacklog > 0 ? ` (${state.uploadBacklog} facts waiting)` : ""}` : null;

  const retries: PopupRetry[] = [];
  if (opts.startFailed && onWatch && (state === null || state.state === "stopped")) {
    retries.push("start");
    actions = actions.filter((a) => a !== "start");
  }
  const live = state !== null && state.state !== "stopped";
  const failing = (channels: readonly string[]) => (capture?.health ?? []).some((x) => channels.includes(x.channel) && (x.health === "failed" || x.health === "stalled"));
  const offerTranscription = capture?.transcript === "unavailable_offer_asr" && source !== null;
  if (live && failing(["frames", "playback"])) retries.push("observe");
  if (live && !offerTranscription && failing(["transcript"])) retries.push("transcript");

  const invite: InviteState = state?.lastAck?.invite ?? { state: "none" };
  const inviteAnswers: InviteAnswer[] = invite.state === "invited" || invite.state === "waiting" ? ["review_now", "later", "wait", "stop_early"] : ["review_now"];

  const dead = state?.deadLetters;
  const deadLetters = dead && dead.count > 0 ? `${dead.count} ${dead.count === 1 ? "fact was" : "facts were"} refused by the backend and set aside, logged as a gap${dead.latestReason ? ` (latest: ${dead.latestReason})` : ""}` : null;

  return {
    headline,
    tone,
    actions,
    hint,
    source: source ? { title: source.title, channel: source.channelName, videoId: source.videoId } : null,
    captions: capture ? CAPTION_TEXT[capture.transcript] : state ? "Waiting for the backend" : "",
    offerTranscription,
    health,
    watched: capture && capture.watchedSeconds > 0 ? formatSeconds(capture.watchedSeconds) : null,
    invite,
    inviteAnswers,
    retries,
    problem,
    deadLetters,
  };
}

type Child = Node | string | null;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: { class?: string; text?: string; onclick?: () => void; disabled?: boolean; data?: Record<string, string> } = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.onclick) el.addEventListener("click", props.onclick);
  if (props.disabled) (el as HTMLButtonElement).disabled = true;
  for (const [k, v] of Object.entries(props.data ?? {})) el.dataset[k] = v;
  for (const k of kids) if (k !== null) el.append(k);
  return el;
}

const ACTION_LABEL: Readonly<Record<PopupAction, string>> = { start: "Start capture", pause: "Pause", resume: "Resume", stop: "Stop" };
const ANSWER_LABEL: Readonly<Record<InviteAnswer, string>> = { review_now: "Review now", later: "Later", wait: "Wait", stop_early: "Stop early" };
const RETRY_LABEL: Readonly<Record<PopupRetry, string>> = { start: "Retry start", observe: "Retry frames and playback", transcript: "Retry captions" };
const POLL_MS = 1500;

export function renderPopup(root: HTMLElement, send: (req: PopupRequest) => Promise<TabCaptureState | null>, tab: { readonly id: number; readonly url: string | undefined }): () => void {
  let state: TabCaptureState | null = null;
  let error: string | null = null;
  let busy = false;
  let startFailed = false;
  let lastDrawn = "";

  async function request(req: PopupRequest): Promise<void> {
    if (req.type !== "status") busy = true;
    try {
      state = await send(req);
      error = null;
      if (req.type === "start") startFailed = false;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      if (req.type === "start") startFailed = true;
    }
    busy = false;
    draw();
  }

  const act = (type: PopupAction) => () => void request({ type, tabId: tab.id });
  const retry = (r: PopupRetry) => () => void request(r === "start" ? { type: "start", tabId: tab.id } : r === "observe" ? { type: "retry_observe", tabId: tab.id } : { type: "retry_transcript", tabId: tab.id });
  const answer = (a: InviteAnswer) => () => void request({ type: "invite_answer", tabId: tab.id, answer: a });

  function draw(): void {
    const v = describePopup(state, tab, { startFailed });
    const signature = JSON.stringify([v, error, busy]);
    if (signature === lastDrawn) return;
    lastDrawn = signature;

    const inviteButtons = () => h("div", { class: "row" }, ...v.inviteAnswers.map((a) => h("button", { text: ANSWER_LABEL[a], class: a === "review_now" && v.invite.state === "invited" ? "primary" : "", onclick: answer(a) })));
    const retryButtons = v.retries.length === 0 ? null : h("div", { class: "row" }, ...v.retries.map((r) => h("button", { text: RETRY_LABEL[r], disabled: busy, onclick: retry(r) })));

    const details = h("dl");
    const add = (label: string, text: string, tone = "neutral") => details.append(h("dt", { text: label }), h("dd", { text, data: { tone } }));
    if (v.source) add("Source", `${v.source.title} (${v.source.channel})`);
    if (v.captions) add("Captions", v.captions);
    for (const x of v.health) add(x.label, x.text, x.tone);
    if (v.watched) add("Watched", v.watched);

    const invite =
      v.invite.state === "invited"
        ? h("div", { class: "invite" }, h("div", { text: "A review is ready. Start now, or keep watching?" }), inviteButtons())
        : v.invite.state === "waiting"
          ? h("div", { class: "note", text: "Processing before your review. Review now still works, and you can stop early." })
          : v.invite.state === "later"
            ? h("div", { class: "note", text: "Review postponed. You will be invited at the next stopping point." })
            : null;

    const children: Child[] = [
      h("h1", { text: "After Class" }),
      h("div", { class: "status", text: v.headline, data: { tone: v.tone } }),
      h("div", { class: "row" }, ...v.actions.map((a) => h("button", { text: ACTION_LABEL[a], class: a === "start" || a === "resume" ? "primary" : "", disabled: busy, onclick: act(a) }))),
      v.hint ? h("div", { class: "note", text: v.hint }) : null,
      details.childElementCount > 0 ? details : null,
      v.offerTranscription
        ? h(
            "div",
            { class: "invite" },
            h("div", { text: "These captions are not usable. Transcribe the audio (opt-in), or continue with a visible gap?" }),
            h(
              "div",
              { class: "row" },
              h("button", { text: "Transcribe", onclick: () => void request({ type: "transcription_choice", tabId: tab.id, videoId: v.source!.videoId, choice: "accept_asr" }) }),
              h("button", { text: "Continue with gap", onclick: () => void request({ type: "transcription_choice", tabId: tab.id, videoId: v.source!.videoId, choice: "continue_with_gap" }) }),
              h("button", { text: "Retry captions", onclick: () => void request({ type: "retry_transcript", tabId: tab.id }) }),
            ),
          )
        : null,
      invite,
      v.invite.state === "invited" ? null : inviteButtons(),
      retryButtons,
      v.problem ? h("div", { class: "error", text: v.problem }) : null,
      v.deadLetters ? h("div", { class: "error", text: v.deadLetters }) : null,
      error ? h("div", { class: "error", text: error }) : null,
    ];
    root.replaceChildren(...children.filter((c): c is Node | string => c !== null));
  }

  draw();
  void request({ type: "status", tabId: tab.id });
  const timer = setInterval(() => void request({ type: "status", tabId: tab.id }), POLL_MS);
  return () => clearInterval(timer);
}
