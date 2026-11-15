# Brief: a live, gamified review room

Settled with the owner in a design session on 2026-11-14.

## What the owner asked for

> "i want to consider revamping the current interface so that it is properly 'gamified' and the rendering is not static images/constrained to whatever it is now."

Standing art direction: "i'd like to keep the art style and pixel resolution if possible" and "i'd rather the interface be made properly than putting a bandaid on it". Earlier: "considering after class is game-ish we should consider video game techniques / is there a better way to generate the scene?" And: "the product needs to be fast or UX is not pleasant."

## Decisions

| Question | Decision | Owner's words |
| --- | --- | --- |
| Renderer | One hand-rolled Canvas 2D stage draws the room's pictures. HTML draws every word and control on top. No new package. | "canvas 2D for now" |
| PixiJS | Not now. Drawing stays separate from layout, rig and progression, so a swap replaces only the drawing layer. | asked for the cost, chose Canvas 2D |
| Companion | A livelier tutor that blinks, looks, nods and hops. The stage swaps whole painted frames, each an image-to-image edit of the companion's painted master. No cut-out rig and no transform of the painted art. | "yes a more lively tutor would be great" |
| Progression | Saved reviews make the room grow. | "this is a great idea!" |
| Reactions | The room and companion react to the tutor's moves as they stream. | Part of the recommendation, with no separate objection. Confirm at review of the first PR. |
| Art | Keep the painted "HD pixel" look of today's rooms and companions at plate density. New art, such as animation frames and unlock objects, comes from image-to-image edits of the existing art. True pixel art was tried and set aside. | Earlier: "honestly i think making each asset individually as high def (REAL) pixel art will pay off". After the true-pixel pilot, side by side with the approved mockup: "It's still very different than the original". Then, offered the painted look or true pixel art: "Sure ur suggestion for the original" (2026-11-14) |

If PixiJS comes back, `pixi.js` 8.22.0 was the newest version older than 7 days, and a minimal room loaded about 140 to 150 KB gzipped. Its shader effects each need new masks or distortion maps.

## What is true today

Each room is about ten lossless WebP layers placed by CSS `calc()`. The companion is one three-pose sheet in `src/app/assets/companions-v3/`, swapped for 1050 ms per reaction (`companion-reaction.ts`) and softened by CSS transforms in `life.css`. Nothing moves between turns or changes across reviews. The painted masters have about 130k colours and no true pixel grid, so new frames are image-to-image edits, which stay consistent with their master (tested 2026-11-14).

## The experience

1. **A living room.** Window light drifts with dust in it, a petal crosses the rail classroom, and chalk dust falls as the board writes. The room shifts a little with the mouse at three depths (background, board, desk), never enough to pull attention from the question.
2. **A tutor who is present.** The companion blinks, looks toward the board when the tutor asks and toward the mat while the learner types, nods at a shared answer and shows emote balloons (`?`, `…`, `!`).
3. **Reactions to what happened, never to whether it was right.** The tutor's move header streams before any words. The moves are `ask_main`, `quick_check`, `ask_followup`, `hint`, `explain`, `diagnose`, `close_thread`, `wrap_up` and the rest of `TurnEvent` in `src/shared/domain.ts`. Reactions use only that header, since nothing assesses the learner during a review.
4. **A room that grows.** Saved reviews stack notebooks on the desk, grow the vine, and add lamps and small objects.

## Rules the game layer must keep

These rules are quoted verbatim from `docs/flows/after-class.md`:

- R12: "If the tutor helped before my answer, it can't count as independent."
- R13: "A skipped or unanswered question is never counted as understood."
- R14: "A disputed assessment is never counted as a learning gap unless I resolve it that way."
- R18: "A quick check I pass only shows the topic looks fine; it's never recorded as understood the way a main question is."

For progression:

- Only saved observations count. Live turns never award anything.
- Only `independent` grows the room as understanding. The room can show `partial` and `after_help` as effort but never counts them as understood. `unresolved`, `not_assessed`, `looks_fine` and `disputed` award nothing toward understanding.
- Progress is never lost. No streak, no decay and no "you missed a day".
- Every number shown is a real count from the record and says what it counts.

## Architecture

```
src/app/room/
  layout.ts      Pure. Window size + room → rectangles for every layer, text area and object, in screen pixels.
                 Replaces the calc() geometry in front-row.css. Unit-tested over a grid of windows.
  stage.tsx      One <canvas> behind the existing HTML. Owns the frame loop, device-pixel sizing, pausing when
                 hidden, and reduced motion. Draws whatever the scene graph says.
  scene.ts       Pure. Builds the draw list (layers, extras, unlocks, companion parts, effects) from layout,
                 room, progression and time. Renderer-independent: a Pixi port replaces only stage.tsx.
  fx.ts          Effects drawn at plate density in the room's colours: light shaft, motes, petals, chalk dust,
                 emote balloons, confetti.
  companion.ts   Companion animation: drawn frame sequences per gesture, plus overlay parts (eyes, mouth) where
                 that saves frames. Named gestures on stepped timing.
  reactions.ts   TurnEvent / app event → gesture + effect. Replaces companion-reaction.ts.
  progress.ts    Pure. Saved record → counts and room unlocks. Unit-tested against R12, R13, R14, R18.
```

- **HTML stays HTML.** Board text, the answer field, buttons, the notebook and source objects, and dialogs stay DOM, positioned from `layout.ts`. Screen readers, focus, IME and the single React tree that keeps the draft (`FrontRowScene`) keep working.
- **Resolution.** Painted layers draw at plate density on the 1586x992 plate, scaled pixelated as `u` in `front-row.tsx` does now.
- **Motion.** Things move in whole plate pixels at 8 fps for idle and 12 fps for gestures. Nothing rotates the painted art.
- **Speed.** The prototype draws the room in 1 to 3 ms per frame at 1440x900. The loop stops in a hidden tab and, under reduced motion, redraws only on change. Art keeps `bun run build:art`, the rules in `test/art-prefetch.test.ts` and the manifest.
- **Reduced motion.** `prefers-reduced-motion` and the "Reduce motion" preference turn off ambient motion, parallax and camera moves. Gestures become an instant pose change, and progression still shows.
- **Phone.** Below 900x560 the stage draws the phone composition from `layout.ts`, with ambient effects off by default.

## Art pipeline: the painted look

The painted layers in `art/masters/front-row-v2/` stay, and new art matches them:

1. **Companion frames.** Each pose is a Meshy `nano-banana-pro` image-to-image edit of the painted master that changes one thing ("only the eyes, closed"), at about 9 credits a frame, on the master's canvas. Cells that change outside the intended area revert to the idle frame. Cleanup is mechanical only, as in `docs/design/front-row/rooms-v2/provenance.md`.
2. **Unlock objects** are image-to-image edits of a crop of their room, with the same cleanup.
3. **Light and motion** come from the effects layer in each room's colours, never baked into art. Evenly lit art avoids repeated baked sunbeams.
4. The owner judges each asset in the running app. Masters live in `art/masters/`, `scripts/build-art.ts` ships them, and `art/manifest.json` records their prompt, task id and credits.

Grid-snapped painted art, 3D-to-pixel renders and generated true pixel art were rejected on 2026-11-14. Of the 3D renders the owner said "Oh those look horrible hahaha, we lost a lot of detail. They're very flat".

## Open questions for the owner

None blocks the first PRs.

1. **What a room level costs.** Recommend an unlock for every few topics explained on your own, not one per review.
2. **Can the learner place unlocked objects?** Recommend not in v1. Objects appear in fixed spots per room.
3. **Does effort (`partial`, `after_help`) show at all?** Recommend yes, as a smaller thing that never claims understanding, such as a notebook per saved review.
4. **Companion voice lines or sounds?** Not proposed. The tutor already has a voice.

## Other rooms and prototype

`mockup/harbor-room.png` (midday sun) and `mockup/canal-room.png` (rainy evening) are mockups for approval. Approved objects become painted layers in #226.

`prototype/index.html` is a throwaway Rail-side Classroom demo. Serve it with `python3 -m http.server 8765 --directory docs/design/live-room/prototype`. Its four modes are A today, B living room, C reactive tutor and D progression. Its progression numbers are labeled mock data, and its unlock art is a placeholder.

## Issues

Issues DerekHertz/after-class#218 to #226 track this work. #219 draws painted layers and #220 effects at plate density, #222 animates the companion from painted frames, #223 and #224 make those frames as Meshy edits, and #226 makes unlock objects.
