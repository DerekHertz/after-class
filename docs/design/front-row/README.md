# Front-row review skins

The review screen puts the learner at a front-row desk. The current question is written on the board, and the editable Your thinking field lies on the desk mat. Derek selected three skins for issue #129. All three are selectable in **Room & companion**.

## Selected designs and art

The selected mockups are in `selected/`. They are references only, and the app never displays them.

| Saved scene ID | Skin | Reference | Blank plate |
| --- | --- | --- | --- |
| `last-desk` | Rail-side Classroom | `selected/rail-classroom.png` | `src/app/assets/front-row/last-desk.png` |
| `study-bench` | Harbor Study Terrace | `selected/harbor-terrace.png` | `src/app/assets/front-row/study-bench.png` |
| `projection-booth` | Lantern Canal Film Club | `selected/canal-film-club.png` | `src/app/assets/front-row/projection-booth.png` |

The plates are 1585x992 opaque PNGs with no UI text and no companion. Codex generated them from the selected designs. The scene IDs predate the skins, and the app keeps them so that a saved preference opens the matching skin without a migration.

The companion sheets are in `src/app/assets/companions-v3/`, one file per companion: `pip`, `mote`, `lumi`, `yun`, `mote-moonlit` and `mote-pagewing`. Codex generated them too. Each sheet is a 2172x724 RGBA PNG with three 724x724 cells, ordered idle, draw (source card) and read (notebook).

`docs/design/front-row/approved-reference.png` and any handoff that calls these designs unselected are superseded. That reference is not used.

## Full-art correction

After the first browser review, Derek wrote: "the visual interface should just be the full pixel art, the opaque border is not beneficial". This overrides the opaque bars and borders in the selected mockups. The art fills the window. Navigation sits over it as small chips. Text that needs a backing gets a local surface, such as a chip, the board and mat on a phone, or a panel.

## Font

The app uses Pixelify Sans, a variable font with weights 400 to 700, from `src/app/assets/fonts-v2/pixelify-sans.ttf`. Its license is `src/app/assets/fonts-v2/OFL-PixelifySans.txt`, and the source is <https://github.com/google/fonts/tree/main/ofl/pixelifysans>. The app build inlines the font into its CSS and adds the license to `asset-notices.txt`. The page makes no font requests over the network.

## How the code fits together

- `src/app/front-row.tsx` holds `FRONT_ROW_ROOMS`, one typed entry per `SceneId`. Each entry has the measured safe boxes for the board, the mat, the companion and the notebook in plate fractions. It also has the tone and ink of each surface and the room palette. The canal film club is the only room with a light board and a dark mat, and the `tone` field on each surface records that difference. `roomStyle()` turns an entry into CSS custom properties, and `FrontRowScene` renders the one shared scene.
- `src/app/front-row.css` holds layout rules only. Every room shares these rules. The only per-room rules choose the plate image.
- On windows at least 900x560, the scene fills the window. Inside it, `.front-row-stage` is the plate below its painted top bar, sized to cover the window and anchored to the bottom. The board, mat, companion and notebook are placed in stage percentages, so they stay on their art. `CROP_LIMIT` caps the crop. The two sides together may lose 8% of the plate's width, and the companion and notebook slide inward to stay in view. The top may lose the strip above the board plus 6% more, and the board's text then starts below the navigation. Past either limit the plate stops growing, and a blurred copy of it fills the rest of the window.
- The masthead and review navigation are chips over the top of the art. From 900 to 1359 pixels wide, the review navigation takes a second row. At any width the navigation can also wrap, because its width depends on the lecture title and the buttons the phase shows. `reserveNavSpace()` in `front-row.tsx` measures the navigation's bottom edge with a `ResizeObserver` and sets `--fr-nav-reserve`, so the board's text starts 12 pixels below the navigation however many rows it takes. The CSS values of 64 and 120 pixels apply only until the first measurement.
- On smaller windows and phones, the scene is recomposed instead of shrunk. The plate fills the page behind everything. The board in the art's own colours, the desk with Your thinking, and the companion with the notebook stack over it.
- `src/app/review.tsx` passes the question, notes and diagram link to the board and the `Composer` to the desk. Show diagram sits in the row of the topic heading, so it adds no line to the board, and the board names the topic once. The button's accessible name is still "Show diagram: " followed by the topic label. Before the first turn, `TopicChecklist` puts its topic choices on the board and its note and Start button on the desk. Earlier turns and the lecture source open as paper panels below the room, and opening one moves focus to its heading. Save state, errors and the finished-review summary sit in `.front-row-notices`, which floats under the navigation on a wide window.
- `src/app/companion.tsx` holds `POSES` and `COMPANION_SPRITES`. A reaction selects a sheet column, and reduced motion keeps the idle column in `hd-companion.css`.
- Rooms and companions change only attributes and custom properties, so switching either one keeps the same React tree and never remounts the draft.

## Verification

`bun run typecheck`, `bun test`, `bun run build:app` and `bun scripts/preview-ui.ts --build-only` pass. `test/front-row.test.tsx` reads the real plates and checks that board and mat ink pass WCAG AA against the colour painted there. It also checks the room geometry, the saved-ID mapping, and that every room and companion renders the same element tree. It checks that at the crop limits each board keeps at least 75% of its height and the notebook and companion stay over at least half of their art. `test/companion-sprites.test.tsx` reads every sheet and checks its size, alpha, whole poses inside each cell and a shared baseline across poses.

The first browser review by Codex, at 1440x900 and 390x844, found the problems this layout fixes. With the source open, the room shrank and the desk clipped Share and help. Opaque header bands and side gutters framed the art. The canal mat clipped its shortcut line, and on a phone the help buttons fell below the fold. The same review confirmed that drafts survive switching all three rooms and the Mote, Pip and Lumi companions.

A second browser review by Codex at 1440x900 checked the full-art layout. The phone layout at 390x844 passed its checks, and the desktop art kept its size with the source open. Two problems remained, and a follow-up commit addresses them. In the rail classroom the navigation wrapped to two rows over a 64-pixel reserve, so it covered the board heading. The navigation reserve is now measured. In the harbor terrace the ordinary fixture clipped Show diagram at the bottom of the board. Show diagram now shares the topic heading's row. The harbor board box is now 0.24 to 0.572 of the plate's height, up from 0.255 to 0.565, inside the green measured on the plate from 0.223 to 0.584. The harbor's More ways control is inset by 2% of the scene's width from the right edge of the mat. The `bun test` count is 1646 pass and 0 fail.

In a later browser comment at 1676x954, Derek called the blue background around the source and earlier-turn panels distracting. Below the scene, the shell showed its flat `--fr-wall` colour. A fixed `::before` on `.scene-shell` now draws the selected room's `--fr-plate` at full sharpness behind the whole page, so every room's art shows behind the source, the history and a phone's companion row. The shell's `isolation` keeps that layer under the content. It ignores the pointer, and since it is fixed with `inset: 0` it cannot overflow sideways. On a phone, the recomposed room's image now sits in an `::after` that scrolls with the page, and the fixed backdrop shows below it. Nothing animates, so reduced motion needs no change. Board, desk and stage coordinates are unchanged. After this change, `bun run typecheck`, `bun test` (1646 pass, 0 fail), `bun run build:app` and `bun scripts/preview-ui.ts --build-only` pass.

These items are not verified:

- No browser has checked the backdrop change. It needs a scroll through the source and history in all three skins at 1676x954 and 390x844.
- No browser has checked the follow-up commit. Codex owns that review, in all three skins at 1440x900, 1280x900 and 390x844.
- The navigation still places its row between masthead chips that use fixed reserves of 13rem and 14rem. The measured reserve keeps the board below it, but a long lecture title can still take a full row.
- In a preview on black, some sheet outlines, such as Mote's, show a reddish fringe. It needs a check on the real backgrounds.
- Asset folders used only by the old rooms remain: `hd-pixel`, `companions-v2`, `controls-v3` and most of `scenes-v2`.
