# Brief: a live, gamified review room

Draft, 2026-11-14. Settled with Derek in a design session. Untracked until Derek says to commit it. Nothing in `src/` has changed.

## What Derek asked for

> "i want to consider revamping the current interface so that it is properly 'gamified' and the rendering is not static images/constrained to whatever it is now."

Standing art direction: "i'd like to keep the art style and pixel resolution if possible" and "i'd rather the interface be made properly than putting a bandaid on it". Earlier: "considering after class is game-ish we should consider video game techniques / is there a better way to generate the scene?" And: "the product needs to be fast or UX is not pleasant."

## Decisions

| Question | Decision | Derek |
| --- | --- | --- |
| Renderer | One hand-rolled Canvas 2D stage draws the room's pictures. HTML still draws every word and control on top. No new package. | "canvas 2D for now" |
| PixiJS | Not now. Kept possible by keeping layout, rig and progression separate from drawing, so a later swap replaces only the drawing layer. | asked for the cost, chose Canvas 2D |
| Companion | A livelier tutor that blinks, looks, nods and hops. Whole painted frames, each an image-to-image edit of the companion's painted master, swapped by the stage (no cut-out rig, no transforms of the painted art). | "yes a more lively tutor would be great" |
| Progression | The room grows from saved reviews. | "this is a great idea!" |
| Reactions | The room and companion react to the tutor's moves as they stream. | presented as part of the recommendation; not separately objected to. Confirm when the first PR is reviewed. |
| Art | Keep the painted look of today's rooms and companions (the AI-painted "HD pixel" style at plate density). New art (animation frames, unlock objects) is made in that same style by image-to-image edits of the existing art. True pixel art was tried and set aside, see "Art: what was tried". | Earlier: "honestly i think making each asset individually as high def (REAL) pixel art will pay off". After the true-pixel pilot, side by side with the approved mockup: "It's still very different than the original", then, offered the painted look or true pixel art: "Sure ur suggestion for the original" (2026-11-14) |

PixiJS facts, for whenever it comes back: `pixi.js` 8.22.0 is the newest version older than 7 days (8.23.0 shipped 2026-11-11). A minimal room bundle measured about 176 KB gzipped for all chunks, roughly 140 to 150 KB for what a browser loads (one renderer), measured in a scratch folder with `bun build --minify`. What it would buy is shader effects: water shimmer, rain on glass, lamp lighting. Each also needs new art (masks, distortion maps).

## What is true today

- Each room is about ten lossless WebP layers (background, nine-sliced board, desk and mat, extras) placed by CSS. All geometry is `calc()` in `src/app/front-row.css`, fed by custom properties from `roomStyle()` in `src/app/front-row.tsx`.
- The companion is one sheet of three poses (idle, draw, read) in `src/app/assets/companions-v3/`. Reactions swap the pose for 1050 ms (`companion-reaction.ts`). Activity is shown by smooth CSS transforms that rotate and scale the pixels (`life.css`), which softens them.
- Nothing moves between turns, and nothing in the room changes across reviews.
- The masters are AI-painted pixel-look art: about 130k colours and pixel clusters of about 2.2 plate pixels, with no true pixel grid. Frames cannot be edited pixel by pixel, but image-to-image edits of a master keep a new frame consistent with it (tested 2026-11-14), so frames are generated rather than drawn.

## The experience

1. **A living room.** Light from the window drifts, dust turns in it, a petal crosses the rail classroom, chalk dust falls as the question is written. The room shifts slightly with the mouse (three depths: background, board, desk). Nothing is busy enough to pull attention from the question.
2. **A tutor who is present.** The companion idles, blinks, looks toward the board when a question is asked and toward the mat while the learner types, nods when an answer is shared, and shows small emote balloons (`?`, `…`, `!`). Different moves get different gestures.
3. **Reactions to what happened, never to whether it was right.** The tutor's move header streams before any words (`ask_main`, `quick_check`, `ask_followup`, `hint`, `explain`, `diagnose`, `close_thread`, `wrap_up` and the rest, `TurnEvent` in `src/shared/domain.ts`). Reactions use only that. Nothing is assessed during a review, so a "correct!" reaction would invent an assessment.
4. **A room that grows.** Saved reviews add to the room: notebooks stack on the desk, the vine grows, lamps and small objects appear. The room is a record of the learner's own explanations.

## Rules the game layer must keep

These are Derek's rules, quoted from `docs/flows/after-class.md`:

- R12: "If the tutor helped before my answer, it can't count as independent."
- R13: "A skipped or unanswered question is never counted as understood."
- R14: "A disputed assessment is never counted as a learning gap unless I resolve it that way."
- R18: "A quick check I pass only shows the topic looks fine; it's never recorded as understood the way a main question is."

What this means for progression:

- Only saved observations count. Live turns never award anything.
- Only `independent` grows the room as understanding. `partial` and `after_help` can be shown as effort but are never counted as understood. `unresolved`, `not_assessed`, `looks_fine` and `disputed` award nothing toward understanding.
- Progress is never lost. No streak that breaks, no decay, no "you missed a day". These are friends using it now and then.
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

- **HTML stays HTML.** The board text, the answer field, the buttons, the notebook and source objects as buttons, and the dialogs stay DOM, positioned from `layout.ts`. Screen readers, focus, text selection, IME and the draft-preserving single React tree (see `FrontRowScene`) all keep working.
- **Resolution.** The stage draws the painted layers at plate density (one asset pixel per plate pixel, the room plate 1586x992 as today) and scales the composition to the window as the CSS does now (`u` in `front-row.tsx`), pixelated, so the HD pixel look is unchanged. HTML text and controls are laid over it at full resolution.
- **Motion.** Moving things move in whole plate pixels on stepped timing (8 fps idle, 12 fps gestures). Nothing rotates the painted art. Companion poses are whole painted frames swapped in, not transforms.
- **Speed.** The prototype draws the whole room in 1 to 3 ms per frame at 1440x900. The stage stops its loop when the tab is hidden and redraws only on change under reduced motion. Art keeps the lossless WebP pipeline (`bun run build:art`), the prefetch rules in `test/art-prefetch.test.ts` and its manifest.
- **Reduced motion.** Respect `prefers-reduced-motion` and the existing "Reduce motion" preference: no ambient motion, no parallax, no camera moves; gestures become an instant pose change; progression is still shown.
- **Phone.** Below 900x560 the room is recomposed today. The stage draws the phone composition from `layout.ts` too, with ambient effects off by default to save battery.

## Art pipeline: the painted look

Today's rooms (`art/masters/front-row-v2/`) are already separate painted layers: background, board, desk, mat and extras. They stay. What is new is made in the same style:

1. **Companion frames.** Each pose is an image-to-image edit of the companion's painted master with Meshy `nano-banana-pro` that changes one thing ("only the eyes, closed"). About 9 credits per frame. Frames share the master's canvas, so they line up; cells that change outside the intended area are put back from the idle frame. Cleanup is mechanical only, as in `docs/design/front-row/rooms-v2/provenance.md`: binary alpha, specks dropped, cropped to a shared box.
2. **Unlock objects** for progression: generated image-to-image from a crop of the room they belong in, so they carry its light, palette and density, then cleaned the same way.
3. **Light and motion** come from the stage's effects layer (sunbeam, dust, petals, rain, glints), drawn at plate density in each room's colours, never baked into new art.
4. Derek judges each asset in the running app. Masters in `art/masters/`, shipped by `scripts/build-art.ts`, recorded in `art/manifest.json` with provenance (prompt, task id, credits).

## Art: what was tried (2026-11-14)

The experiment folders named below stay on the machine that made them (about 50 MB of renders) and are not in the repository.

- **Snapping the painted art onto a grid** (`mockup/snapped/`): the scale was right, but speckle, broken lines and blotchy gradients.
- **3D-to-pixel** (`meshy-test/`): Meshy Pip and a Blender room rendered as pixel art. Derek: "Oh those look horrible hahaha, we lost a lot of detail. They're very flat".
- **Generated true pixel art** (`gen-pixel/`, then the full `pilot/`): Meshy `nano-banana-pro` drew each piece as pixel art on a 640 grid, snapped and assembled, then lit by claude-pxl. Clean and consistent, but it lost the painted dimension and, assembled piece by piece, drifted from the approved composition. Derek: "It's still very different than the original". The pilot's side-by-side: `pilot/out/original-vs-pilot.png`.
- What carries over: Meshy image-to-image edits keep a frame consistent with its source (a blink changed about 5% of cells, mostly the eyes), and evenly lit art plus a separate light layer avoids baked sunbeams repeating.

## Open questions for Derek

Recommendations first. None block the first PRs.

1. **What a room level costs.** Recommend: a new unlock for every few topics explained on your own, not per review, so a short review is not worth less effort than gaming it.
2. **Can the learner place unlocked objects?** Recommend: not in v1; they appear in fixed spots per room. Placement is a later feature.
3. **Does effort (`partial`, `after_help`) show at all?** Recommend: yes, as a separate, smaller thing (for example, notebooks stack for every saved review) that never claims understanding.
4. **Companion voice lines or sounds?** Not proposed. Voice already exists for the tutor.

## Prototype

`prototype/index.html` (throwaway; serve the folder, for example `python3 -m http.server 8765 --directory docs/design/live-room/prototype`). Rail-side Classroom only, with four modes: A today, B living room, C reactive tutor, D progression. Screenshots: `living.png`, `reactive.png`, `progress.png`. Its progression numbers and summary card are mock data and say so. Its unlock art is reused from other rooms as a placeholder.

## Issues

Filed 2026-11-14 as DerekHertz/after-class#218 to #226, updated the same day for the painted look: #219 draws the painted layers at plate density, #220 draws effects at plate density in each room's colours, #222 is companion animation from painted frames, #223 and #224 make those frames as Meshy edits of each painted master, and #226 makes unlock objects in each room's painted style.
