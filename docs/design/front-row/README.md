# Front-row review skins

The review screen puts the learner at a front-row desk. The board shows the current question, and the editable Your thinking field lies on the desk mat. Issue #129 chose three skins, and the learner can pick any of them in **Room & companion**.

## Selected designs and art

The selected mockups are in `selected/`. They are references only, and the app never displays them.

| Saved scene ID | Skin | Reference | Blank plate |
| --- | --- | --- | --- |
| `last-desk` | Rail-side Classroom | `selected/rail-classroom.png` | `src/app/assets/front-row/last-desk.png` |
| `study-bench` | Harbor Study Terrace | `selected/harbor-terrace.png` | `src/app/assets/front-row/study-bench.png` |
| `projection-booth` | Lantern Canal Film Club | `selected/canal-film-club.png` | `src/app/assets/front-row/projection-booth.png` |

The plates are 1585x992 opaque PNGs with no UI text and no companion. Codex generated them from the selected designs. The scene IDs are older than the skins. The app keeps them so that a saved preference opens the matching skin without a migration.

The companion sheets are in `src/app/assets/companions-v3/`, one file per companion. The companions are `pip`, `mote`, `lumi`, `yun`, `mote-moonlit` and `mote-pagewing`, and Codex generated their sheets too. Each sheet is a 2172x724 RGBA PNG with three 724x724 cells, in the order idle, draw (source card) and read (notebook).

These designs replace `docs/design/front-row/approved-reference.png` and any handoff that calls them unselected. Nothing uses that reference.

## Full-art correction

After the first browser review, the owner wrote: "the visual interface should just be the full pixel art, the opaque border is not beneficial". This overrides the opaque bars and borders in the selected mockups. The art fills the window, and navigation sits over it as small chips. Text that needs a backing gets a local surface, such as a chip, the board and mat on a phone, or a panel.

## Font

The app uses Pixelify Sans, a variable font with weights 400 to 700, from `src/app/assets/fonts-v2/pixelify-sans.ttf`. Its license is `src/app/assets/fonts-v2/OFL-PixelifySans.txt`, and its source is <https://github.com/google/fonts/tree/main/ofl/pixelifysans>. The app build inlines the font into its CSS and adds the license to `asset-notices.txt`. The page makes no font requests over the network.

## How the code fits together

- `src/app/front-row.tsx` holds `FRONT_ROW_ROOMS`, one typed entry per `SceneId`. Each entry has the sizes, nine-slice cuts and plain inner areas of the room's board, desk and mat layers. It also has the background's position, the room's extras, the tone and ink of each surface and the room palette. The canal film club is the only room with a light board and a dark mat, and the `tone` field on each surface records that difference. `roomStyle()` turns an entry into CSS custom properties, and `FrontRowScene` renders the one shared scene.
- `src/app/front-row.css` holds layout rules only, and every room shares them. The only per-room rules choose the layer images, which live in `src/app/assets/front-row-v2/`. Their source, their manifest and the preview that composes them are in `rooms-v2/`. Screenshots of the real review screen are in `rooms-v2/app-screenshots/`.
- On windows of at least 900x560, the scene fills the window and stacks its layers back to front. The background covers the window, with a per-room anchor. Next come the board as a nine-slice on the wall, the board's extras (the rail's vine and ledge items, the harbor's lamps, the canal's pull tab), the desk across the bottom, and the mat on the desk. The board's text, Your thinking, the companion, the notebook and the folio take their positions from the same measures, so each stays on its art at every window size. Two scales apply. `--fr-b` covers the window's width and reaches down behind the desk. `--fr-u` sizes everything else. It is the smaller of `--fr-b` and `--fr-u0`, so a tall or very wide window does not magnify the desk and objects. The code crops no layer to fit, so the old crop limits and the dimmed fill behind the plate are gone.
- The masthead and review navigation are chips over the top of the art. From 900 to 1359 pixels wide, the review navigation takes a second row. At any width the navigation can also wrap, because its width depends on the lecture title and on the buttons the phase shows. `reserveNavSpace()` in `front-row.tsx` measures the navigation's bottom edge with a `ResizeObserver` and sets `--fr-nav-reserve`. The board's text then starts 12 pixels below the navigation however many rows it takes. The CSS values of 64 and 120 pixels apply only until the first measurement.
- On smaller windows and phones, the app recomposes the scene instead of shrinking it. The room's background fills the page behind everything. Over it stack the board in the art's own colours, the desk with Your thinking, and the companion with the notebook.
- `src/app/review.tsx` passes the question, notes and diagram link to the board and the `Composer` to the desk. Show diagram sits in the row of the topic heading, so it adds no line to the board, and the board names the topic once. The button's accessible name is still "Show diagram: " followed by the topic label. Before the first turn, `TopicChecklist` puts its topic choices on the board and its note and Start button on the desk. The lecture source and earlier turns open over the room as objects, as the next section describes. Save state, errors and the finished-review summary sit in `.front-row-notices`, which floats under the navigation on a wide window.
- `src/app/companion.tsx` holds `POSES` and `COMPANION_SPRITES`. A reaction selects a sheet column, and with reduced motion `hd-companion.css` keeps the idle column.
- Switching rooms or companions changes only attributes and custom properties. React keeps the same tree and never remounts the draft.

## The lecture folio and the review notebook

The owner asked: "can we make the source and history feel like part of the room too, instead of these big white panels?" The source now opens as a lecture folio lifted from the desk. The earlier turns open as a navy, ring-bound review notebook. The learner holds each object over the room, and the room stays in view around it.

Behavior:

- One state in `ReviewScreen` owns the held object. It is `Inspecting = "source" | "history" | null`, from `src/app/room-object.tsx`, so only one object can be open. The source selection (pinned or following the current reply) and the control that focus returns to stay outside that state.
- Nothing opens by itself. Before this change, a reply that cited evidence opened the source over the question. That effect is gone. The citation buttons under each line, Show diagram and the two objects on the desk open an object only when clicked.
- The owner then asked: "can we open source and history by clicking the folio and notebook on the desk, instead of using the buttons at the top?" The two top buttons are gone. During a review the `review` variant of `FrontRowLayout` carries `objects: { cited, open }`, and `FrontRowScene` draws two buttons from it. The folio is the closed folio sprite `closed-folio.png`, and the notebook is `closed-notebook.png`, both in `src/app/assets/front-row-v2/`. The folio sits on the desk just above the notebook, at 90% of the notebook's width. Its tag shows the citation count, for example "Source · 2", and its accessible name is "Open source · 2 cited". The notebook on the desk opens Earlier in this review. It stays on the desk when there is no history yet, and then the notebook shows its empty message. On a phone both objects are thumbnails of the same closed sprites beside the companion. Each object opens at once on click, Return or Space. It lifts on hover and focus, and it gets focus back when the learner puts the object down. Before the review starts, neither object is on the desk.
- The painted notebook used to open the saved-record My notebook after the companion glanced at it for 500 ms. A "Saved notes" chip in the review navigation now opens it, in setup and in the review. Its dialog still says Close notebook, and closing it returns focus to Saved notes.
- `RoomInspector` renders a single native `<dialog>` opened with `showModal()`. Focus moves to the object's heading and stays inside the dialog while it is open. Escape and the close control (Close source or Hide earlier) put the object down and return focus to the control that opened it. If that control is gone, focus goes to the current question. Back to the question puts the object down and focuses the question.
- The response field and the rest of the scene stay mounted under the dialog, so a draft survives. Opening an object does not scroll the page or move the room, because the dialog sits in the top layer.
- One dialog serves both objects. A citation in the notebook turns it into the folio without closing it, and a Show diagram in the notebook's topic list does the same. A diagram citation in the folio pins that evidence in the same folio. Focus still returns to the control that opened the first object.
- Each object has one scrolling page between its heading row and Back to the question. The history list and the diagram no longer scroll on their own. Evidence loading, errors with Retry, provenance lines, the diagram, the scope browser, topics and observations use the same components as before.
- When system motion is on, the object rises in once over 260 ms. With reduced motion, from the app setting or the system, it appears with no animation.

Art and styling:

- `src/app/assets/room-objects/source-folio.png` (wood backing, brass clips, teal spine, amber parchment) and `review-notebook.png` (navy cover, brass rings, bookmark ribbon, amber parchment) are 1448x1086 RGBA PNGs with transparent outer corners. Codex generated both for this iteration. The app draws them as the dialog's frame with `border-image`. CSS and SVG redraw none of the object art.
- `ROOM_OBJECTS` records each frame's nine-slice cuts, its blank page box and its ink. The cuts keep each ornament whole in a corner. For the folio these are the clips, the spine motifs and the first tab, and for the notebook the ribbon and the moon. The notebook's left edge repeats instead of stretching. Its middle cut, y 130 to 754, holds exactly five rings at their measured 124.75-pixel pitch, so the rings stay round on a tall phone frame.
- On a desktop the object keeps the art's shape at up to 66% of the window's width and 82% of its height. On a phone it takes the window less a 10-pixel margin, and the app draws the frame at a fixed scale of 0.22 so the page keeps nearly all the width. The text keeps its size.
- The owner asked: "can we update the saved-results summary to match the pixel art style too?" (issue #131). The review notebook's page now carries the saved-results summary. `CompletionPanel` passes `objectStyle("history")` to its section, so it uses the same nine-slice cuts, page insets and ink as the held notebook. `completion.css` draws `review-notebook.png` as the section's `border-image` at a fixed scale of 0.42 on a desktop and 0.2 on a phone. The frame grows with the content, and the room stays in view around it. The title, the groups and the Next block are in Pixelify Sans, with dashed rules between them. A disputed item has a rule in the error ink. Citations are 44 pixels tall. Open this review in my notebook uses the room's navigation colour, like Back to the question. Save pending, Retry save, Saving and errors keep their paper notes, so the notebook page appears only after the backend reports the save. On a desktop the notices keep their bounded scroll, and the whole page scrolls with them.
- Live text and controls are DOM on the parchment, set in Pixelify Sans. The dialog rebinds the shared colour tokens, so the nested evidence and diagram blocks lose their white cards and borders. Transcript quotes use the folio's ink. Watched intervals, gaps and ads keep the plain face with tabular figures, and long text wraps anywhere. Close and Back to the question use the room's navigation colour, so the objects match each of the three rooms. The backdrop is a light tint of that same colour, with no blur.

## Verification

`bun run typecheck`, `bun test`, `bun run build:app` and `bun scripts/preview-ui.ts --build-only` pass. `test/front-row.test.tsx` reads the real layers. It checks that board and mat ink pass WCAG AA against the colour in each layer's plain area, and that every layer and extra has the size its room declares. It also checks the saved-ID mapping and that every room and companion renders the same element tree. `e2e/front-row-layers.spec.ts` checks each room at 1440x900, 1470x1270 and 1920x1080. It confirms that the board's text and Your thinking lie inside their art and that nothing overlaps the navigation. `test/companion-sprites.test.tsx` reads every sheet and checks its size, its alpha, whole poses inside each cell and a shared baseline across poses.

Codex ran the first browser review at 1440x900 and 390x844 and found the problems this layout fixes. With the source open, the room shrank and the desk clipped Share and help. Opaque header bands and side gutters framed the art. The canal mat clipped its shortcut line, and on a phone the help buttons fell below the fold. The same review confirmed that drafts survive switching all three rooms and the Mote, Pip and Lumi companions.

Codex ran a second browser review of the full-art layout at 1440x900. The phone layout at 390x844 passed its checks, and the desktop art kept its size with the source open. Two problems remained, and a follow-up commit addresses them. In the rail classroom the navigation wrapped to two rows over a 64-pixel reserve and covered the board heading. The app now measures the navigation reserve. In the harbor terrace the ordinary fixture clipped Show diagram at the bottom of the board. Show diagram now shares the topic heading's row. The harbor board box now spans 0.24 to 0.572 of the plate's height, up from 0.255 to 0.565, inside the green measured on the plate from 0.223 to 0.584. The harbor's More ways control sits 2% of the scene's width in from the right edge of the mat. `bun test` reports 1646 pass and 0 fail.

In a later browser comment at 1676x954, the owner called the blue background around the source and earlier-turn panels distracting. Below the scene, the shell showed its flat `--fr-wall` colour. A fixed `::before` on `.scene-shell` now draws the selected room's `--fr-plate` at full sharpness behind the whole page. Every room's art now shows behind the source, the history and a phone's companion row. The shell's `isolation` keeps that layer under the content. The layer ignores the pointer, and because it is fixed with `inset: 0` it cannot overflow sideways. On a phone, the recomposed room's image now sits in an `::after` that scrolls with the page, and the fixed backdrop shows below it. Nothing animates, so reduced motion needs no change. Board, desk and stage coordinates are unchanged. After this change, `bun run typecheck`, `bun test` (1646 pass, 0 fail), `bun run build:app` and `bun scripts/preview-ui.ts --build-only` pass.

These items are not verified:

- No browser has checked the backdrop change. It needs a scroll through the source and history in all three skins at 1676x954 and 390x844.
- No browser has checked the follow-up commit. Codex owns that review, in all three skins at 1440x900, 1280x900 and 390x844.
- The navigation still places its row between masthead chips that use fixed reserves of 13rem and 14rem. The measured reserve keeps the board below the navigation, but a long lecture title can still take a full row.
- In a preview on black, some sheet outlines, such as Mote's, show a reddish fringe. They need a check on the real backgrounds.
- Asset folders that only the old rooms use remain. They are `hd-pixel`, `companions-v2`, `controls-v3` and most of `scenes-v2`.

## Independent browser review

Codex completed the browser review on product-code commit `494faae7c492f7741171eb56d6687b2084c5d363`. The final review replaces the pending-browser notes above. See [design-qa.md](../../../design-qa.md) for comparisons, fixes, screenshots, tested behavior and remaining limits. The final correction stops the scene itself from scrolling and removes the blur from its fallback art. All three rooms keep the selected artwork around the source and history. The PR stays a draft without merge authorization.

### Folio and notebook checks

After the folio and notebook change, `bun run typecheck`, `bun test` (1650 pass, 4 todo, 0 fail), `bun run build:app` and `bun scripts/preview-ui.ts --build-only` pass. The built CSS resolves both frame images. `test/front-row.test.tsx` reads both frames. It checks their size and transparent corners. It checks that ink, soft ink, link and error colours pass WCAG AA against each page's parchment (6.1:1 or more). It also checks that the notebook's repeating cut starts and ends at the same point of the ring column. With that check in place, shifting the span to 640 pixels fails it. `test/review-evidence.test.tsx` renders `RoomInspector` with nothing held, with the folio and with the notebook. It checks that nothing held renders an empty dialog and that only the held object's content shows. It checks that each object has one scrolling page between its heading and Back to the question, and where focus returns.

These items are not verified:

- No browser has run the folio or the notebook. The repository has no DOM test environment, so these behaviors are untested:
  - `showModal`
  - focus moving to the heading and staying in the dialog
  - Escape
  - focus returning to the control that opened the object
  - the draft surviving
  - page scroll staying put
  - a reply's citations not opening anything

  Codex owns that review, in all three rooms with all six companions, at 1440x900, 1676x954 and 390x844.
- Nobody has checked the frame's look. That covers the nine-slice seams, the repeated ring column and the tiled parchment on a phone, the fit of the safe page insets, and the folio's stretched tabs on a tall phone frame.
- Focusing the diagram after Show diagram relies on React running the dialog's effect before the next animation frame. A browser should confirm that focus lands on the diagram, not the heading.
- `::backdrop` reads the room's `--fr-bar`. Where a browser does not let the backdrop inherit custom properties, it falls back to the rail classroom's navy.
- The preview has no URL switch that opens an object, so screenshots need a click first.

The [token report](token-report.md) records local Claude token usage per run.
