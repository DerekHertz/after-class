# Front-row review skins

The review screen puts the learner at a front-row desk. The board shows the current question, and the editable Your thinking field lies on the desk mat. The owner chose three skins for issue #129, and the learner picks one in **Room & companion**.

## Selected designs and art

The selected mockups in `selected/` are references only. The app never displays them, and they replace `approved-reference.png`, which nothing uses.

| Saved scene ID | Skin | Reference | Blank plate |
| --- | --- | --- | --- |
| `last-desk` | Rail-side Classroom | `selected/rail-classroom.png` | `src/app/assets/front-row/last-desk.png` |
| `study-bench` | Harbor Study Terrace | `selected/harbor-terrace.png` | `src/app/assets/front-row/study-bench.png` |
| `projection-booth` | Lantern Canal Film Club | `selected/canal-film-club.png` | `src/app/assets/front-row/projection-booth.png` |

The plates are 1585x992 opaque PNGs with no UI text and no companion. The scene IDs predate the skins, and the app keeps them so a saved preference needs no migration.

The companion sheets are in `src/app/assets/companions-v3/`, one per companion: `pip`, `mote`, `lumi`, `yun`, `mote-moonlit` and `mote-pagewing`. Each sheet is a 2172x724 RGBA PNG with three 724x724 cells, in the order idle, draw (source card) and read (notebook).

The owner wrote: "the visual interface should just be the full pixel art, the opaque border is not beneficial". The art fills the window, and navigation sits over it as small chips. Text that needs a backing gets a local surface, such as a chip, the board and mat on a phone, or a panel.

The font is Pixelify Sans, weights 400 to 700, from `src/app/assets/fonts-v2/pixelify-sans.ttf`, with its license in `OFL-PixelifySans.txt` beside it. Its source is <https://github.com/google/fonts/tree/main/ofl/pixelifysans>. The build inlines the font into CSS and adds the license to `asset-notices.txt`, so the page makes no font requests.

## How the code fits together

- `src/app/front-row.tsx` holds `FRONT_ROW_ROOMS`, one typed entry per `SceneId`. Each entry has the sizes, nine-slice cuts and plain inner areas of the board, desk and mat layers, the background position, the room's extras, each surface's tone and ink, and the palette. The `tone` field records that only the canal film club has a light board and a dark mat. `roomStyle()` turns an entry into CSS custom properties, and `FrontRowScene` renders the one shared scene.
- `src/app/front-row.css` holds shared layout rules. The only per-room rules choose the layer images in `src/app/assets/front-row-v2/`. Their source, manifest and composing preview are in `rooms-v2/`, with screenshots in `rooms-v2/app-screenshots/`.
- On windows of at least 900x560, the layers stack back to front. The background covers the window with a per-room anchor. Then come the board as a nine-slice, the board's extras (the rail's vine and ledge items, the harbor's lamps, the canal's pull tab), the desk and the mat. The board's text, Your thinking, the companion, the notebook and the folio take their positions from the same measures. `--fr-b` covers the window's width and reaches behind the desk. `--fr-u` sizes everything else and is the smaller of `--fr-b` and `--fr-u0`, so a tall or wide window does not magnify the desk. No layer is cropped.
- The masthead and review navigation are chips over the art. From 900 to 1359 pixels wide the navigation takes a second row, and it can wrap at any width. `reserveNavSpace()` measures the navigation's bottom edge with a `ResizeObserver` and sets `--fr-nav-reserve`, so the board's text starts 12 pixels below it. The CSS values of 64 and 120 pixels apply only until the first measurement.
- On smaller windows and phones, the app recomposes the scene. The room's background fills the page, and over it stack the board in the art's colours, the desk with Your thinking, and the companion with the notebook.
- A fixed `::before` on `.scene-shell` draws the room's `--fr-plate` behind the whole page, so the art shows behind the source, the history and a phone's companion row. The shell's `isolation` keeps it under the content, and it ignores the pointer. On a phone the recomposed room's image sits in an `::after` that scrolls with the page. The scene itself does not scroll, and its fallback art has no blur.
- `src/app/review.tsx` passes the question, notes and diagram link to the board and the `Composer` to the desk. Show diagram sits in the topic heading's row, and its accessible name is "Show diagram: " plus the topic label. Before the first turn, `TopicChecklist` puts its topic choices on the board and its note and Start button on the desk. Save state, errors and the finished-review summary sit in `.front-row-notices`, under the navigation on a wide window.
- The harbor board box spans 0.24 to 0.572 of the plate's height, inside the green measured from 0.223 to 0.584. The harbor's More ways control sits 2% of the scene's width in from the mat's right edge.
- `src/app/companion.tsx` holds `POSES` and `COMPANION_SPRITES`. A reaction selects a sheet column, and with reduced motion `hd-companion.css` keeps the idle column.
- Switching rooms or companions changes only attributes and custom properties. React keeps the same tree and never remounts the draft.

## The lecture folio and the review notebook

The owner asked: "can we make the source and history feel like part of the room too, instead of these big white panels?" The source opens as a lecture folio and the earlier turns as a navy, ring-bound review notebook, held over the room.

Behavior:

- One state in `ReviewScreen` owns the held object, `Inspecting = "source" | "history" | null` from `src/app/room-object.tsx`. The source selection (pinned or following the current reply) and the focus-return control stay outside it.
- Nothing opens by itself. Citation buttons, Show diagram and the two desk objects open an object only when clicked.
- The owner asked: "can we open source and history by clicking the folio and notebook on the desk, instead of using the buttons at the top?" The top buttons are gone. The `review` variant of `FrontRowLayout` carries `objects: { cited, open }`, and `FrontRowScene` draws `closed-folio.png` and `closed-notebook.png` from `src/app/assets/front-row-v2/` as buttons. The folio sits just above the notebook at 90% of its width. Its tag shows the citation count, such as "Source · 2", and its accessible name is "Open source · 2 cited". The notebook stays on the desk with no history and then shows its empty message. On a phone both are thumbnails beside the companion. Each opens on click, Return or Space, lifts on hover and focus, and gets focus back when put down. Neither is on the desk before the review starts.
- A "Saved notes" chip in the navigation opens the saved-record My notebook, in setup and in the review. Its dialog says Close notebook and returns focus to Saved notes.
- `RoomInspector` renders one native `<dialog>` opened with `showModal()`. Focus moves to the object's heading and stays in the dialog. Escape and the close control (Close source or Hide earlier) return focus to the opening control, or to the current question if that control is gone. Back to the question focuses the question.
- The response field and scene stay mounted under the dialog, so a draft survives, and opening an object does not scroll the page.
- A citation or Show diagram in the notebook turns it into the folio without closing it. A diagram citation in the folio pins that evidence in place. Focus still returns to the control that opened the first object.
- Each object has one scrolling page between its heading row and Back to the question. Evidence loading, Retry, provenance, the diagram, the scope browser, topics and observations reuse the existing components.
- With system motion on, the object rises in once over 260 ms. With reduced motion from the app or the system, it appears with no animation.

Art and styling:

- `src/app/assets/room-objects/source-folio.png` and `review-notebook.png` are 1448x1086 RGBA PNGs with transparent outer corners, drawn as the dialog frame with `border-image`. CSS and SVG redraw none of the object art.
- `ROOM_OBJECTS` records each frame's nine-slice cuts, blank page box and ink. The cuts keep each ornament whole in a corner, the folio's clips, spine motifs and first tab and the notebook's ribbon and moon. The notebook's left edge repeats instead of stretching. Its middle cut, y 130 to 754, holds exactly five rings at a 124.75-pixel pitch.
- On a desktop the object keeps the art's shape at up to 66% of the window's width and 82% of its height. On a phone it takes the window less a 10-pixel margin, with the frame at a fixed scale of 0.22. The text keeps its size.
- The owner asked: "can we update the saved-results summary to match the pixel art style too?" (issue #131). `CompletionPanel` passes `objectStyle("history")` to its section, and `completion.css` draws `review-notebook.png` as its `border-image` at 0.42 on a desktop and 0.2 on a phone. The frame grows with the content. The title, groups and Next block use Pixelify Sans with dashed rules between them. A disputed item has a rule in the error ink. Citations are 44 pixels tall. Open this review in my notebook uses the room's navigation colour. Save pending, Retry save, Saving and errors keep their paper notes, so the notebook page appears only after the backend reports the save.
- Live text and controls are DOM on the parchment in Pixelify Sans. The dialog rebinds the shared colour tokens, so nested evidence and diagram blocks lose their white cards. Transcript quotes use the folio's ink. Watched intervals, gaps and ads keep the plain face with tabular figures, and long text wraps anywhere. Close and Back to the question use the room's navigation colour. The backdrop is a light tint of that colour, with no blur.

## Verification

`bun run typecheck`, `bun test` (1650 pass, 4 todo, 0 fail), `bun run build:app` and `bun scripts/preview-ui.ts --build-only` pass.

- `test/front-row.test.tsx` checks that board and mat ink pass WCAG AA against each layer's plain area, that every layer and extra has its declared size, the saved-ID mapping, and that every room and companion renders the same tree. It also checks both object frames' size and corners, that their inks pass WCAG AA on the parchment (6.1:1 or more), and that the notebook's repeating cut starts and ends at the same point of the ring column.
- `e2e/front-row-layers.spec.ts` checks each room at 1440x900, 1470x1270 and 1920x1080, with the board's text and Your thinking inside their art and nothing overlapping the navigation.
- `test/companion-sprites.test.tsx` checks every sheet's size, alpha, whole poses per cell and shared baseline.
- `test/review-evidence.test.tsx` renders `RoomInspector` empty, with the folio and with the notebook, and checks content, the single scrolling page and focus return.

Codex completed the browser review of the full-art layout and backdrop on commit `494faae7c492f7741171eb56d6687b2084c5d363`. [design-qa.md](../../../design-qa.md) holds its comparisons, screenshots and remaining limits.

Open items:

- No browser has run the folio or the notebook, and the repository has no DOM test environment. Untested are `showModal`, focus moving to and staying in the dialog, Escape, focus return, the draft surviving, the page not scrolling, and a reply's citations not opening anything. Codex owns that review in all three rooms with all six companions at 1440x900, 1676x954 and 390x844.
- Nobody has checked the frames' look, meaning the nine-slice seams, the repeated ring column, the tiled parchment on a phone, the page insets and the folio's stretched tabs on a tall phone frame.
- Focusing the diagram after Show diagram relies on React running the dialog's effect before the next animation frame. A browser should confirm focus lands on the diagram.
- `::backdrop` reads `--fr-bar`. Where a browser does not let the backdrop inherit custom properties, it falls back to the rail classroom's navy.
- The preview has no URL switch that opens an object, so screenshots need a click.
- The masthead chips use fixed reserves of 13rem and 14rem, so a long lecture title can still take a full row.
- On black, some sheet outlines, such as Mote's, show a reddish fringe that needs a check on the real backgrounds.
- Asset folders that only the old rooms use remain, `hd-pixel`, `companions-v2`, `controls-v3` and most of `scenes-v2`.

The [token report](token-report.md) records local Claude token usage per run.
