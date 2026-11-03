/**
 * Derek's rules → enforcing mechanism → test. One test per rule, named by rule,
 * all offline (FakeJev / FakeClaude implement Task.attempt from scripted answers).
 * [TLC] rules also stay checked by docs/flows/model/Preparation.tla; these tests
 * pin the code to the same behaviour.
 */
import { describe, test } from "bun:test";

describe("Derek's rules", () => {
  test.todo("R1 passages exist only inside watched spans in active control periods (clipToWatched, watchedMaterial)");
  test.todo("R2 ad facts never contribute material; a span across an ad is split by the tracker (createPlaybackTracker + watchedMaterial)");
  test.todo("R3 ask_main with a non-assessable claim id is rejected (validateMove); assessable() returns null unless supported_by_check");
  test.todo("R4 deriveClaimStatus never yields a second revision; recheck no/uncertain/failed ⇒ unverified");
  test.todo("R5 answering Later leaves preparation.demand() identical (invites not an input)");
  test.todo("R6 options() is ready with resource search pending/failed");
  test.todo("R7 corrections() never adds material; FrozenScope has no update path; delta claims outside scope.material unusable");
  test.todo("R8 late hit after stopEarly cutoff leaves status dropped; outdated input key never selected; save never writes note_edits");
  test.todo("R9 start() leaves CaptureView.status unchanged; stop control fact leaves ReviewView.phase unchanged");
  test.todo("R10 start() with zero assessable claims returns nothing_to_review and creates no review row");
  test.todo("R11 detour_step not in allowedMoves until a learner detour_accept turn");
  test.todo("R12 hint before first answer: clampStatus('independent') ⇒ after_help");
  test.todo("R13 skip / no answer ⇒ not_assessed regardless of proposal");
  test.todo("R14 isLearningGap false for open/unsettled/learner_was_right disputes");
  test.todo("R15 save twice ⇒ identical row counts and IDs");
  test.todo("R16 sweepExpired keeps snapshots cited by any note; deletes after deleteNote + expiry");
  test.todo("R17 every memo.run attempt (ok or error) writes exactly one usage event; Jev cost kind is unknown with usd NULL");
});

describe("module boundaries", () => {
  test.todo("no file outside src/backend/<m>/ imports src/backend/<m>/core.ts (except test/)");
  test.todo("no module's SQL writes another module's tables");
  test.todo("no file but providers/memo.ts calls Task.attempt (R17: no unledgered provider call)");
  test.todo("review/ does not import evidence write APIs; preparation/ and scheduler.ts do not import review/");
});
