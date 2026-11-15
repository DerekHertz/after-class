# Tactile interaction review

User annotations later replaced the whole-device press and drawer treatment below. See the [mechanical-control correction](../mechanical-controls/README.md).

The preview branch `codex/tactile-motion` sits above the reference-fidelity correction. Final visual acceptance stays on base PR #44, and nothing here merges or deploys. To view it, run `bun scripts/preview-ui.ts` and open http://127.0.0.1:8770/?scenario=review&clean=1. The preview makes no live microphone or provider calls.

## Outcome

1. **Review.** The masthead blocked pointer clicks on Pause and Resume. Its empty area now passes pointer events through, and both buttons work by pointer.
2. **Lecture source.** The Study Bench drawer moves its illustrated front and handle, and the content slides in and out. Closed evidence leaves the accessibility tree at once. On mobile, smaller recorder bounds stop the recorder target blocking the drawer. A typed draft survives open and close.
3. **Speak and companion.** The recorder presses down while held by pointer, touch or keyboard and stays down while listening, and Composer Speak follows the same lifecycle. Mascots breathe, lean, shift, tuck and settle with the app state. These move the existing raster body and are not a new character rig. All three rooms were tested.
4. **Notebook.** The book turns its cover around the spine in 380 ms, then the page animates in over 480 ms. Back or another route cancels the pending navigation, and focus lands on My notebook. Connection rationale replaces raw IDs, and citations show real frame and transcript timestamps. Metadata batches hold at most 250 IDs.
5. **Reduced motion and narrow layout.** Reduce motion stops the mascot loop, zeroes the source transition and navigates to the notebook at once. At 390×844 the page is 390px wide, and the source and Speak targets act separately. No console errors appeared.

Screenshots: [before review](01-current-review-full.jpg), [source open](05-source-open.jpg), [listening in Last Desk](last-desk-listening.jpg), [Booth](projection-booth-listening.jpg) and [Bench](study-bench-listening.jpg), [cover turn](07-opening-book.jpg), [notebook](08-notebook.jpg), [mobile](09-mobile-listening.jpg) and the [paired comparison](reference-comparison.jpg). [Browser checks](browser-checks.json) and [room checks](room-checks.json) hold the motion and state results, which screenshots alone cannot show.

## Verification

At code commit `167caaa`, the suite had 941 passed, 4 existing TODOs and 0 failures, and typecheck and all builds passed. After the final citation edits, 49 focused tests and typecheck passed.

Independent code verification ran navigation completion, competing routes, Back cancellation and both animation fallbacks. It found a stale completion edge, fixed by invalidating the pending animation before cancel. The real citation loader with 0, 1, 250, 251, 1000 and 1001 IDs made 0, 1, 1, 2, 4 and 5 requests, each valid against the wire parser. Independent visual review found raw IDs and unlabeled citations, and both were fixed. The parent drove the live browser, since the visual worker could not reach it.

Not resolved or not verified:

- Two P3 items remain. Long histories can start with a partly clipped line, and the page has more than one way to close the source.
- Without a lecture title from the record API, evidence labels use generic provenance.
- Nobody tested a real microphone, provider or captured lecture.
- The user's final visual acceptance is pending.
