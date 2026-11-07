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

## Font

The app uses Pixelify Sans, a variable font with weights 400 to 700, from `src/app/assets/fonts-v2/pixelify-sans.ttf`. Its license is `src/app/assets/fonts-v2/OFL-PixelifySans.txt`, and the source is <https://github.com/google/fonts/tree/main/ofl/pixelifysans>. The app build inlines the font into its CSS and adds the license to `asset-notices.txt`. The page makes no font requests over the network.

## How the code fits together

- `src/app/front-row.tsx` holds `FRONT_ROW_ROOMS`, one typed entry per `SceneId`. Each entry has the measured safe boxes for the board, the mat, the companion and the notebook in plate fractions. It also has the tone and ink of each surface and the room palette. The canal film club is the only room with a light board and a dark mat, and the `tone` field on each surface records that difference. `roomStyle()` turns an entry into CSS custom properties, and `FrontRowScene` renders the one shared scene.
- `src/app/front-row.css` holds layout rules only. Every room shares these rules. The only per-room rules choose the plate image.
- On windows at least 900x560, the plate fills the space under the review bar, and the real controls sit in its safe boxes. On smaller windows and phones, the scene is recomposed instead of shrunk: a strip of the plate's scenery, the board drawn in the art's own colours, the desk with Your thinking, then the companion and the notebook.
- `src/app/review.tsx` passes the question, notes and diagram link to the board and the `Composer` to the desk. Before the first turn, `TopicChecklist` puts its topic choices on the board and its note and Start button on the desk. Earlier turns and the lecture source open as panels beside the scene, or below it on a phone.
- `src/app/companion.tsx` holds `POSES` and `COMPANION_SPRITES`. A reaction selects a sheet column, and reduced motion keeps the idle column in `hd-companion.css`.
- Rooms and companions change only attributes and custom properties, so switching either one keeps the same React tree and never remounts the draft.

## Verification

`bun run typecheck`, `bun test`, `bun run build:app` and `bun scripts/preview-ui.ts --build-only` pass. `test/front-row.test.tsx` reads the real plates and checks that board and mat ink pass WCAG AA against the colour painted there. It also checks the room geometry, the saved-ID mapping, and that every room and companion renders the same element tree. `test/companion-sprites.test.tsx` reads every sheet and checks its size, alpha, whole poses inside each cell and a shared baseline across poses.

These items are not verified:

- No browser check has run. Codex owns the review at 1440x900 and 390x844 in all three skins. That review covers long content, switching room and companion with a draft, source and notebook panels, setup, help, completion, reduced motion and all six companions.
- In a preview on black, some sheet outlines, such as Mote's, show a reddish fringe. It needs a check on the real backgrounds.
- `src/app/room-tools.tsx`, `src/app/hd-room.tsx`, `src/app/room-tools.css` and `src/app/mechanics.css` are no longer imported or linked. Deleting them needed a permission this session did not have, so they still need removing. Asset folders used only by the old rooms also remain: `hd-pixel`, `companions-v2`, `controls-v3` and most of `scenes-v2`.
