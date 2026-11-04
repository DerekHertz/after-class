# Reference fidelity QA

final result: passed

This is technical reference QA; Derek's final visual verdict remains pending on PR #44.

## Comparison target and evidence

Source visual truth: `docs/design/component-review-2026-11-03/conversation-and-source.png`, plus approved room boards and `mascot-studies-2026-11-03` in PR #42. Source composition1487×1058px normalized to1440×1024 CSS pixels; implementation1440×1024 at1× browser capture. The small source aspect adjustment is explicit. Both show active Locks & deadlocks with open evidence. All18 independent room/companion choices were exercised.

Full-view combined input: `docs/trail/frontend-v2/comparison-final.png`. Focused combined input: `docs/trail/frontend-v2/focused-comparison.png`. Implementation captures: `last-desk.png`, `projection-booth.png`, `study-bench.png` in that directory. Mobile390×844 capture: `mobile-study-bench.png` (full-page1639px); no mobile reference was supplied, so mobile checks are usability checks.

## Findings and fidelity surfaces

No remaining actionable P0/P1/P2 in final desktop evidence; independent visual verifier concurs.

- Typography: Young Serif display and DM Sans body/control fonts replace generic approximations. Reviewed hierarchy, weights, wrapping and optical scale in the combined focused crop. Native text remains selectable. Source quote/caption sizes were increased after the first comparison.
- Layout: notebook begins near95px and extends to974px at the reference viewport; illustrated evidence occupies left region with character/physical recorder on desk. Actual scroll surfaces constrain overflowing content. Mobile uses notebook-first reading order. All rooms fit390px width; keyboard End reaches remaining dialogue and evidence, confirmed by scroll endpoints.
- Tokens: warm cream paper, ochre trim, cobalt interaction and mint/indigo room palettes follow the source. Shadows preserve object grounding. Disabled empty-answer control stays muted by real action validity.
- Assets: fifteen PNGs replace custom vector room/character approximations. Detail, crop, scale and transparent edges inspected; alpha validated independently. Room-specific microphones and spring key preserve identity. Standard control icons are upstream Feather, with bundled license notices.
- Copy/content: actual API-backed dialogue and provenance remain DOM. Extra fixture explanation changes vertical density; backend does not expose total-question count or follow-up evidence, so these are not invented. The illustrative lecture frame is labeled fixture, not source art. Contract-valid hint/options stay in the existing expandable actions.

## Comparison history

1. Prior implementation used simplified SVG artwork and failed the user's reference expectation. Replaced room/companion art with generated transparent detailed assets informed by approved studies. Initial correction capture: `iteration-1-last-desk.png`; combined evidence: `comparison-iteration-1.png`.
2. First comparison found undersized character/recorder and weak typography hierarchy. Increased asset scale, adjusted title/notebook positioning, sourced fonts, increased type and applied textured paper. `iteration-2-last-desk.png` records intermediate result; final full/focused comparisons record final result.
3. Independent review found P2 Booth source text over projector reel. Shortened source viewport to36.5% and frame to170px. Revised `projection-booth.png` shows caption ending around642px before reel starts around674px. Independent fix-round verified resolution.
4. Production code review found missing shipped MIT attribution. Build now emits original MIT/OFL notices and an absolute license link. Independent real HTTP test returned200 text/plain and preserved notices verbatim. No visual change from this packaging fix.

## Interactions and limits

Actual browser checks: all18 combinations retain draft with no extra API reads; physical prop starts shared simulated speech, Composer stops it; reduced-motion preference honored; all three mobile room widths390px; both scroll endpoints reachable. Console error check returned empty. Previous streaming, retry, source pinning and save recovery evidence remains in `docs/trail/frontend/README.md`.

P3 polish: faint idle companion caption and redundant lower source label at mobile. These do not hide persistent controls. No real microphone/provider/capture run in this fixture session. Layered object hover/press depth is implemented; no claim of full3D or Tinycharts-equivalent scene motion.

## Implementation checklist

- Detailed art, transparent edges and correct room objects: complete.
- Real controls/controller continuity: complete.
- Full and focused post-fix comparison: complete.
- Narrow width and scroll access: complete.
- License output and independent follow-up: complete.
- Final visual acceptance: reserved for Derek on PR #44.
