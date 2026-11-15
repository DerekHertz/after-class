# Brief: a live, gamified review room

Settled with the owner in a design session on 2026-11-14.

## What the owner asked for

> "i want to consider revamping the current interface so that it is properly 'gamified' and the rendering is not static images/constrained to whatever it is now."

Standing art direction: "i'd like to keep the art style and pixel resolution if possible" and "i'd rather the interface be made properly than putting a bandaid on it". Earlier: "considering after class is game-ish we should consider video game techniques / is there a better way to generate the scene?" And: "the product needs to be fast or UX is not pleasant."

## Decisions

| Question | Decision | Owner's words |
| --- | --- | --- |
| Renderer | One hand-rolled Canvas 2D stage draws the room's pictures. HTML still draws every word and control on top. No new package. | "canvas 2D for now" |
| PixiJS | Not now. Layout, rig and progression stay separate from drawing, so a later swap replaces only the drawing layer. | asked for the cost, chose Canvas 2D |
| Companion | A livelier tutor that blinks, looks, nods and hops. The stage swaps whole painted frames, each an image-to-image edit of the companion's painted master. There is no cut-out rig and no transform of the painted art. | "yes a more lively tutor would be great" |
| Progression | Saved reviews make the room grow. | "this is a great idea!" |
| Reactions | The room and companion react to the tutor's moves as they stream. | Part of the recommendation, with no separate objection. Confirm at review of the first PR. |
| Art | Keep the painted look of today's rooms and companions, the AI-painted "HD pixel" style at plate density. New art, such as animation frames and unlock objects, uses that same style through image-to-image edits of the existing art. True pixel art was tried and set aside, see "Art: what was tried". | Earlier: "honestly i think making each asset individually as high def (REAL) pixel art will pay off". After the true-pixel pilot, side by side with the approved mockup: "It's still very different than the original". Then, offered the painted look or true pixel art: "Sure ur suggestion for the original" (2026-11-14) |

PixiJS facts, for when it comes back. `pixi.js` 8.22.0 is the newest version older than 7 days (8.23.0 shipped 2026-11-11). A minimal room bundle measured about 176 KB gzipped for all chunks. A browser loads roughly 140 to 150 KB of that, for one renderer. Both numbers come from `bun build --minify` in a scratch folder. PixiJS would add shader effects such as water shimmer, rain on glass and lamp lighting. Each effect also needs new art, such as masks and distortion maps.

## What is true today

- Each room is about ten lossless WebP layers (background, nine-sliced board, desk and mat, extras) that CSS positions. All geometry is `calc()` in `src/app/front-row.css`, fed by custom properties from `roomStyle()` in `src/app/front-row.tsx`.
- The companion is one sheet of three poses (idle, draw, read) in `src/app/assets/companions-v3/`. Reactions swap the pose for 1050 ms (`companion-reaction.ts`). Smooth CSS transforms in `life.css` show activity by rotating and scaling the pixels, which softens them.
- Nothing moves between turns, and nothing in the room changes across reviews.
- The masters are AI-painted art with a pixel look. They have about 130k colours and pixel clusters of about 2.2 plate pixels, with no true pixel grid. Nobody can edit frames pixel by pixel. Image-to-image edits of a master keep a new frame consistent with it (tested 2026-11-14), so frames are generated, not drawn.

## The experience

1. **A living room.** Light from the window drifts, and dust turns in it. A petal crosses the rail classroom, and chalk dust falls as the board writes the question. The room shifts a little with the mouse, at three depths (background, board, desk). Nothing moves enough to pull attention from the question.
2. **A tutor who is present.** The companion idles and blinks. It looks toward the board when the tutor asks a question and toward the mat while the learner types. It nods when the learner shares an answer, and it shows small emote balloons (`?`, `…`, `!`). Different moves get different gestures.
3. **Reactions to what happened, never to whether it was right.** The tutor's move header streams before any words. The moves are `ask_main`, `quick_check`, `ask_followup`, `hint`, `explain`, `diagnose`, `close_thread`, `wrap_up` and the rest of `TurnEvent` in `src/shared/domain.ts`. Reactions use only that header. Nothing assesses the learner during a review, so a "correct!" reaction would invent an assessment.
4. **A room that grows.** Saved reviews add to the room. Notebooks stack on the desk, the vine grows, and lamps and small objects appear. The room is a record of the learner's own explanations.

## Rules the game layer must keep

These rules are quoted verbatim from `docs/flows/after-class.md`:

- R12: "If the tutor helped before my answer, it can't count as independent."
- R13: "A skipped or unanswered question is never counted as understood."
- R14: "A disputed assessment is never counted as a learning gap unless I resolve it that way."
- R18: "A quick check I pass only shows the topic looks fine; it's never recorded as understood the way a main question is."

What this means for progression:

- Only saved observations count. Live turns never award anything.
- Only `independent` grows the room as understanding. The room can show `partial` and `after_help` as effort, but never counts them as understood. `unresolved`, `not_assessed`, `looks_fine` and `disputed` award nothing toward understanding.
- Progress is never lost. There is no streak that breaks, no decay and no "you missed a day". The users are friends who use it now and then.
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

- **HTML stays HTML.** The board text, the answer field, the buttons, the notebook and source objects as buttons, and the dialogs stay DOM, positioned from `layout.ts`. Screen readers, focus, text selection, IME and the single React tree that keeps the draft (see `FrontRowScene`) all keep working.
- **Resolution.** The stage draws the painted layers at plate density, one asset pixel per plate pixel, with the room plate at 1586x992 as today. It scales the composition to the window the way the CSS does now (`u` in `front-row.tsx`), pixelated, so the HD pixel look does not change. HTML text and controls sit over it at full resolution.
- **Motion.** Moving things move in whole plate pixels on stepped timing, 8 fps for idle and 12 fps for gestures. Nothing rotates the painted art. The stage swaps in whole painted frames for companion poses instead of transforming them.
- **Speed.** The prototype draws the whole room in 1 to 3 ms per frame at 1440x900. The stage stops its loop when the tab is hidden, and under reduced motion it redraws only on change. Art keeps the lossless WebP pipeline (`bun run build:art`), the prefetch rules in `test/art-prefetch.test.ts` and its manifest.
- **Reduced motion.** Respect `prefers-reduced-motion` and the existing "Reduce motion" preference. That means no ambient motion, no parallax and no camera moves. Gestures become an instant pose change, and the room still shows progression.
- **Phone.** Below 900x560 the app recomposes the room today. The stage draws the phone composition from `layout.ts` too, with ambient effects off by default to save battery.

## Art pipeline: the painted look

Today's rooms (`art/masters/front-row-v2/`) already have separate painted layers for background, board, desk, mat and extras. They stay. New art uses the same style:

1. **Companion frames.** Each pose is an image-to-image edit of the companion's painted master with Meshy `nano-banana-pro` that changes one thing ("only the eyes, closed"). A frame costs about 9 credits. Frames share the master's canvas, so they line up. Cells that change outside the intended area go back to their idle-frame pixels. Cleanup is mechanical only, as in `docs/design/front-row/rooms-v2/provenance.md`. It sets binary alpha, drops specks and crops to a shared box.
2. **Unlock objects** for progression come from image-to-image edits of a crop of their room, so they carry its light, palette and density. The same cleanup follows.
3. **Light and motion** come from the stage's effects layer (sunbeam, dust, petals, rain, glints), drawn at plate density in each room's colours, never baked into new art.
4. The owner judges each asset in the running app. Masters live in `art/masters/`. `scripts/build-art.ts` ships them, and `art/manifest.json` records them with provenance (prompt, task id, credits).

## Art: what was tried (2026-11-14)

The experiment folders named below stay on the machine that made them (about 50 MB of renders). They are not in the repository.

- **Snapping the painted art onto a grid** (`mockup/snapped/`). The scale was right, but the result had speckle, broken lines and blotchy gradients.
- **3D-to-pixel** (`meshy-test/`). Meshy Pip and a Blender room rendered as pixel art. The owner's verdict was "Oh those look horrible hahaha, we lost a lot of detail. They're very flat".
- **Generated true pixel art** (`gen-pixel/`, then the full `pilot/`). Meshy `nano-banana-pro` drew each piece as pixel art on a 640 grid. A script snapped and assembled the pieces, and claude-pxl lit them. The result was clean and consistent, but it lost the painted dimension. Assembled piece by piece, it also drifted from the approved composition. The owner's verdict was "It's still very different than the original". The pilot's side-by-side is `pilot/out/original-vs-pilot.png`.
- Two findings carry over. Meshy image-to-image edits keep a frame consistent with its source, and a blink changed about 5% of cells, mostly the eyes. Evenly lit art plus a separate light layer stops baked sunbeams from repeating.

## Open questions for the owner

Each question leads with a recommendation. None blocks the first PRs.

1. **What a room level costs.** Recommend a new unlock for every few topics explained on your own, not one per review. That way a short review is not worth less than gaming it.
2. **Can the learner place unlocked objects?** Recommend not in v1. Objects appear in fixed spots per room, and placement is a later feature.
3. **Does effort (`partial`, `after_help`) show at all?** Recommend yes, as a separate, smaller thing that never claims understanding. For example, a notebook stacks for every saved review.
4. **Companion voice lines or sounds?** Not proposed. The tutor already has a voice.

## Other rooms

`mockup/harbor-room.png` and `mockup/canal-room.png` bring the Harbor Study Terrace and the Lantern Canal Film Club up to the Rail mockup's level of life. Each keeps its own light, with midday sun on the terrace and a rainy evening at the canal. They are mockups for the owner's approval, not shipping art. Approved objects become painted layers later (#226).

## Prototype

`prototype/index.html` is throwaway. Serve the folder to open it, for example with `python3 -m http.server 8765 --directory docs/design/live-room/prototype`. It covers the Rail-side Classroom only, with four modes: A today, B living room, C reactive tutor and D progression. The screenshots are `living.png`, `reactive.png` and `progress.png`. Its progression numbers and summary card are mock data and say so. Its unlock art is a placeholder taken from other rooms.

## Issues

Issues DerekHertz/after-class#218 to #226 were filed 2026-11-14 and updated the same day for the painted look:

- #219 draws the painted layers at plate density.
- #220 draws effects at plate density in each room's colours.
- #222 animates the companion from painted frames.
- #223 and #224 make those frames as Meshy edits of each painted master.
- #226 makes unlock objects in each room's painted style.
