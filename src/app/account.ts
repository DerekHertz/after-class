/**
 * One account's services: its API client, the tutor's voice, speech input and unsent turns. Locally the one user's
 * services live as long as the page. Hosted, `followAccount` makes them per signed-in account, and a sign-out or a
 * change of account disposes them before the next account's exist.
 */
import { createApi } from "./api";
import type { AppApi, Credential } from "./api";
import { accountToken } from "./sign-in";
import type { ClerkClient } from "./sign-in";
import type { Speaker, SpeechInput } from "./speech";
import { accountUnsentDb, clearOtherAccounts, createIndexedDbUnsent } from "./unsent";
import type { UnsentStore } from "./unsent";
import { chooseSpeaker, createElevenLabsSpeaker, gateSpeaker } from "./voice";
import type { Playback } from "./voice";

export type Services = {
  readonly api: AppApi;
  readonly speaker: Speaker;
  readonly speech: SpeechInput;
  readonly unsent: UnsentStore;
  /** Cancels every request and stream in flight, silences the tutor, stops listening and closes the unsent-turn store. Nothing the account started acts afterward. */
  dispose(): void;
};

/** What the browser provides. */
export type Platform = {
  readonly voiceEnabled: () => boolean;
  readonly play: (audio: Blob) => Playback;
  readonly fallback: (text: string) => Playback;
  readonly browserSpeaker: () => Speaker;
  readonly speechInput: () => SpeechInput;
  readonly idb: IDBFactory | undefined;
  readonly fetch?: typeof fetch;
};

export function servicesFor(credential: Credential, unsentDb: string, platform: Platform): Services {
  const life = new AbortController();
  const api = createApi(credential, { signal: life.signal, ...(platform.fetch === undefined ? {} : { fetch: platform.fetch }) });
  /** Chat-first: nothing is spoken (and no voice request is made) unless the voice setting is on. */
  const speaker = gateSpeaker(() => !life.signal.aborted && platform.voiceEnabled(), () => chooseSpeaker(
    api.voiceAvailable().catch(() => false),
    createElevenLabsSpeaker({ fetchAudio: (text, signal) => api.speech(text, signal), play: platform.play, fallback: platform.fallback }),
    platform.browserSpeaker(),
  ));
  const speech = platform.speechInput();
  const unsent = createIndexedDbUnsent(platform.idb, undefined, unsentDb);
  return {
    api,
    speaker,
    speech,
    unsent,
    dispose() {
      life.abort();
      speaker.stop();
      speech.stop();
      unsent.close();
    },
  };
}

export type Account = { readonly userId: string; readonly services: Services };

export type Accounts = {
  current(): Account | null;
  subscribe(listener: () => void): () => void;
};

/**
 * The signed-in Clerk account and its services. When the account changes, the old account's services are disposed
 * before the new account's are made, and every other account's unsent turns are deleted from this browser, the old
 * account's included.
 */
export function followAccount(clerk: ClerkClient, platform: Platform): Accounts {
  const open = (userId: string | null): Account | null =>
    userId === null ? null : { userId, services: servicesFor(() => accountToken(clerk, userId), accountUnsentDb(userId), platform) };
  let current = open(clerk.user?.id ?? null);
  const signedIn = () => current?.userId ?? null;
  void clearOtherAccounts(platform.idb, signedIn, null);
  const listeners = new Set<() => void>();
  clerk.addListener(() => {
    const userId = clerk.user?.id ?? null;
    if (userId === (current?.userId ?? null)) return;
    const left = current;
    left?.services.dispose();
    current = open(userId);
    void clearOtherAccounts(platform.idb, signedIn, left?.userId ?? null);
    for (const listener of listeners) listener();
  });
  return {
    current: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
