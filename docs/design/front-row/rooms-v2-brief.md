# Brief: remake the three review rooms as layered art

For a Claude Fable session. Draft for Derek's approval. Nothing has been generated from it yet.

## What Derek asked for

Derek, 2026-11-13, after seeing the current rooms and an attempt to extend them:

> "remake the three rooms. It should closely resemble what's already made, and also be the same high-def pixel resolution, but now there's like way too much space above the chalkboard, so the chalkboard isn't like the main focus, and the windows are not actually structurally standard-looking windows."

> "it's probably better if it's not just a flat image, that way those little pixelated components that are on the screen that the user will interact with can be moved around freely. I think the only thing that should be a static image may be like purely the background."

Earlier, on the current rooms: "the visual interface should just be the full pixel art, the opaque border is not beneficial".

And on the screen as it is: "what should be the case is the chalkboard is on the wall, but like the setting is just the whole screen. The chalkboard is centered on the wall, the window is fully there, and it's not like some picture overlaid on the color."

## The problem you are fixing

Each room today is one flat 1585x992 picture. The page scales it to cover the window, and every interactive part (the board text, the answer mat, the companion, the notebook) is placed over the spot where it is painted. A window shaped differently from the picture leaves a gap that the page fills with a dimmed copy of the same picture, so a second chalkboard shows above the first. An attempt to outpaint the old pictures taller made the problem visible in a different way, and Derek rejected it.

The fix is to split each room into a background that can be cropped freely and separate objects that the page places by layout rules.

## Read first

- `docs/design/front-row/README.md`: how the rooms work today, Derek's earlier decisions, and the folio and notebook objects.
- `src/app/front-row.tsx`: `FRONT_ROW_ROOMS`, with the board, mat, companion and notebook boxes and each room's palette. `CROP_LIMIT` and `topCropLimit` show the current cropping rules.
- `src/app/front-row.css`: the layout at 900x560 and wider, and the phone layout below it.
- The three current plates in `src/app/assets/front-row/`: `last-desk.png` (Rail-side Classroom), `study-bench.png` (Harbor Study Terrace) and `projection-booth.png` (Lantern Canal Film Club). Also the selected mockups in `docs/design/front-row/selected/`.
- `docs/design/front-row/room-object-art.md`: how the folio and notebook were generated, with their prompts. They and the companion sheets in `src/app/assets/companions-v3/` stay as they are.

Look at every current plate at full size before you write a prompt. The new rooms must be recognisably the same three places.

## What to keep

- Each room's identity, palette, light and mood. The rail classroom keeps its green chalkboard, blue-grey wall, afternoon light from the right and a window onto the elevated railway and city. The harbor terrace keeps its open-air board above the sea. The canal film club keeps its cream screen, rain and canal.
- The look: anime pixel art with crisp, chunky pixel clusters and fine dark outlines, at the same pixel density as today's plates. One art pixel cluster should be about the same size on screen as it is now when a room fills a 1440x900 window. No smoothing, no vector look, no photoreal.
- No text, letters, UI, people or characters in any asset. The companions are separate and stay unchanged.

## What to change

- **The board is the focus.** In each room the board, or the screen in the canal, sits centred on the wall and fills most of the width of a 1440x900 window. Only a modest band of wall shows above it, enough to read as a wall and not as empty space.
- **Windows are built like real windows.** A rectangular frame with a head, jambs and a sill, mullions and transoms that are straight and evenly spaced, and glass panes that line up. Seen nearly head-on, with the same perspective as the wall, not bent or kinked.
- **No painted top bar.** Today's plates have a flat bar along the top that the page crops off. The new backgrounds have none.

## The layers

Only the background is a single static picture. Everything a learner looks at or uses is its own image, so the page can move and size it.

1. **Background, one per room.** The wall, ceiling line, windows or open view, floor and anything else that is pure setting. It must hold up when cropped to any window from 4:3 to 21:9 and on a tall 1100x1300 window, so paint it wide and tall with the important things near the centre and plain, continuous setting toward the edges. Opaque PNG, at least 2560x1600. Mark a safe area in the manifest that is never cropped on any desktop window.
2. **Board, one per room.** The chalkboard, learning board or projection screen with its frame and ledge, as a transparent PNG drawn for nine-slice stretching: ornaments and corners in the outer border, and a plain writing surface in the middle that can stretch without visible repetition. The board's writing surface colour must stay close to today's `board.fill` in `FRONT_ROW_ROOMS`, because the text ink was checked for contrast against it.
3. **Board ledge items.** The eraser and chalk pieces, or the room's equivalent, as one small transparent PNG that sits on the ledge.
4. **Desk, one per room.** The front-row desktop the learner sits at, as a transparent PNG that spans the bottom of the screen and can stretch sideways by nine-slice. It must leave a clear area for the answer mat.
5. **Answer mat, one per room.** The paper or mat that holds Your thinking, as a transparent nine-slice PNG with a plain centre. Its centre colour stays close to today's `mat.fill`.
6. **Room extras that overlap the frame edge,** such as the rail classroom's vine, as separate transparent PNGs if they would otherwise be cut off when the background is cropped.

The notebook on the desk and the source folio are already separate assets and stay. Note where on the desk each room's notebook should sit.

## Deliverables

Put everything in `docs/design/front-row/rooms-v2/` on a new branch from `origin/master`, in a git worktree. Do not change app code, and do not push or open a PR.

- The PNG assets above for all three rooms, with names like `rail-background.png` and `rail-board.png`.
- `manifest.json`, giving for each asset its size, its nine-slice cuts in pixels, its plain inner area, and for each room the background's safe area and a suggested anchor for each object, such as "board: centred horizontally, top edge at 14% of the window height, width 70% of the window up to 1400 pixels".
- `preview.html`, a static page that composes each room from its layers with CSS only, using the manifest's anchors, and shows it at 1440x900, 1470x1270, 1100x1300, 1920x1080 and 2560x1080. Put sample text on the board and the mat so the composition can be judged. Screenshots of each room at each size, taken with the repo's Playwright (`node_modules/playwright`, already installed), saved next to it.
- `provenance.md`: the tool used for each asset, every prompt, the original generated file paths, and every edit made after generation.
- A short report: what you made, what does not yet look right, and any asset you would regenerate.

## How to make the images

You cannot paint a raster image directly. The current rooms were made with Codex's built-in image tool, and that is available here: run `codex exec` with `-i` to attach reference images and ask it to use its image generation tool, then copy the generated files out of its working folder. One model run per asset or per small group of assets keeps the prompts specific. Then use Python with Pillow, which is installed, only for mechanical steps: cropping, removing a flat key colour to make transparency, scaling with nearest neighbour to bring all assets of a room to one pixel density, and checking sizes. Do not repaint art with code.

Generate the background and board of one room first, compose them in the preview and look at the result at every size before you make the rest. If a generated window or board is crooked or kinked, regenerate it rather than patch it.

## Checks before you report

- Every transparent asset has clean edges: no halo, no stray semi-transparent pixels and no leftover key colour.
- Nine-slice middles stretch without visible seams or repeats in the preview at 2560x1080.
- Nothing contains text or characters.
- The board and mat centre colours are within a small distance of today's `board.fill` and `mat.fill`, and you state the distance.
- Each preview screenshot shows one continuous room with no gap, no second copy of anything and no visible join.

## Limits

- Use only Codex's image tool on Derek's existing subscription. No paid image API, no new dependency and no network calls other than those Codex makes.
- Do not touch `src/`, the current plates or Derek's data under `data/` or `~/afterclass-data`.
- Stop and report if the image tool is not available, rather than drawing the rooms in code.
