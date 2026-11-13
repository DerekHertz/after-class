---
name: verify-review-end
description: Check a change to finishing and saving a review (Finish, the wrap-up, Retry, Retry save, the home link to an unsaved review) against the TLA+ model of that code path. Use when a diff touches controller.ts runTurn, send, retryTurn, save or saveIfEnded, core.ts strandedEndTurn, unansweredLearnerTurn or owedLearnerTurn, review.tsx canRetry, HeaderActions or SaveBanner, home.tsx reviewTarget, main.ts wrapUp, or memo.ts run and clearFailures.
---

# Verify the path from Finish to a saved review

`docs/flows/model/ReviewEnd.tla` models the code that runs after the learner confirms Finish: the end turn, the tutor's wrap-up, the app's own save, Retry, Retry save, and the link back from home. It checks four promises over every order of those steps, with the network or model failing and recovering at any point:

| Rule | Promise, in plain words | Harm if it breaks |
|---|---|---|
| `RetryAlwaysResends` | When the screen offers Retry, pressing it resends something. | The learner presses Retry and nothing happens, forever (#139). |
| `FinishIsNeverSilentlyDropped` | A confirmed Finish is sent, or the learner is told it was not. | The review never ends and nothing says why. |
| `EndedUnsavedIsReachableFromHome` | An ended review that is not saved can be opened from home. | The notes of a finished review are lost from view (#97). |
| `AFinishedReviewEventuallySaves` | Once the trouble is over, a finished review gets saved if the learner keeps retrying. | Retry save returns the same cached failure forever (#95). |

This is a hand model of the code, not a check of the code itself. It is only as true as its mapping, which is why every action in the `.tla` file names the function it describes.

## Does this change touch it?

The model covers these, as of the sync commit below:

- `src/app/controller.ts`: `exclusive`, `runTurn`, `saveIfEnded`, `save`, `send`, `retryTurn`
- `src/app/core.ts`: `unansweredLearnerTurn`, `strandedEndTurn`, `owedLearnerTurn`
- `src/app/review.tsx`: `canRetry`, `HeaderActions`, `EndConfirm`, `SaveBanner`
- `src/app/home.tsx`: `reviewTarget`
- `src/backend/main.ts`: the `wrapUp` dependency
- `src/backend/review/index.ts`: `turn` storing the learner `end`, the wrap-up commit with `markEndedInTx`
- `src/backend/record/index.ts`: `save`, `saveState`
- `src/backend/providers/memo.ts`: `run`, `settled`, `attemptLoop`, `clearFailures`

Sync commit: `e8ee9be`. At that commit the model was read against each function above.

To see what changed since then:

```bash
git diff e8ee9be -- src/app/controller.ts src/app/core.ts src/app/review.tsx src/app/home.tsx src/backend/main.ts src/backend/review/index.ts src/backend/record/index.ts src/backend/providers/memo.ts
```

If none of the listed functions changed, the model still holds for this change and nothing more is needed.

## Run the check

Needs Java 11 or later and `tla2tools.jar` 1.7.4. The script checks the jar's checksum.

```bash
TLA2TOOLS=/path/to/tla2tools.jar docs/flows/model/check-review-end.sh
```

It takes under a minute and prints one line per config. `ReviewEnd.cfg` is the code today and must print `holds`. Each `ReviewEnd-noFix*.cfg` puts one fixed bug back and must break the rule named in the file's first line. All five `ok` lines mean the model is unchanged and still able to fail. The script exits 1 on any other result.

To read a result in plain words, or to see the chart of states, use the pstack `/statechart` skill on `docs/flows/model/ReviewEnd.tla` with the config and the view `docs/flows/model/review-end.view.mjs`. Write its output to `docs/flows/model/out-review-end/`, using a subfolder named after the config for each `noFix` variant. A broken rule comes back as its shortest path, told in the view's step names.

## When the code changed

1. For each covered function that changed, read the matching action in `ReviewEnd.tla`. The comment above each action names its code.
2. If the change alters what an action does, edit the action to match the code. Do not edit a rule to make it pass. Each rule is a promise to the learner.
3. Run the check.
   - `ReviewEnd.cfg` breaks: tell the counterexample as steps in the code's words, using `/statechart`, and report it as a finding with the files and functions involved. Do not change product code unless asked.
   - A `noFix` config now holds: the model can no longer catch that bug. Either the change made that bug impossible another way, in which case say so and retire the config, or the model drifted and needs fixing.
4. Tell a real bug from a modelling error by replaying the counterexample in the real code. The regression tests below drive the same paths with fakes. If the code does not do what a step says, the model is wrong, so fix the model.
5. When the model again matches the code, move the sync commit above to the new commit and refresh `out-review-end/` with `/statechart`. Move it only after you have read every covered function at the new commit.

## Tests that drive the same paths in the real code

- #95: `test/main.test.ts`, "a save retry asks the wrap-up again after a cached terminal failure, across a restart, and saves one record (#95, R15)"
- #97: `test/home.test.ts`, "an ended review whose save failed links to its review screen, and an ended unsaved one stays plain text"
- #139: `test/app-session.test.ts`, "R15: a finish whose wrap-up failed is resent under its own id, from the live failure and after a reload", and `test/app.test.ts`, "a finish the tutor never wrapped up is offered for resend only while the review is active, and a pause is not one"
- Dropped Finish: `test/app-session.test.ts`, "a learner act made while the finished turn is still settling is held visibly and refused with a message, never dropped silently", and the `describe` block "the header actions while a turn settles" in the same file

## What it does not cover

- One review, one `end` act, and wrap-up inputs that do not change between attempts.
- Pause, resume, answers and the rest of the review. Only the path from Finish to saved is modelled.
- What the wrap-up says, whether the saved record is right, and anything the backend does after `saved`.
- Two browser tabs on the same review, and a backend restart in the middle of a save. The #95 test covers a restart, the model does not.
- The approved flow's own rules (R1 to R19). Those are in `Preparation.tla` and `Record.tla`, checked by `check.sh`.
