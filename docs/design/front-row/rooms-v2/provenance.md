# Rooms v2: provenance

Every picture here was generated on 2026-11-13 by Codex CLI 0.163.0 with its built-in image generation tool, on Derek's existing subscription. No paid image API, no new dependency and no code-drawn art were used.

Each run was one `codex exec` call from a scratch folder outside the repo that held the room's current plate as `reference.png` and the prompt as `prompt.md`:

```
codex exec -m gpt-6.1-sol -c model_reasoning_effort='"high"' -s workspace-write --skip-git-repo-check --color never -i reference.png -o final.md - < prompt.md
```

At most two runs were active at a time. There were 18 runs: 15 are used and 3 were rejected. The original paths below are the files Codex's image tool wrote on this machine.

## Edits after generation

All edits are mechanical and are done by `tools/process.py`, driven by `tools/rooms.json`. Nothing was repainted, recoloured, smoothed or retouched.

1. Backgrounds: no pixel was changed. Each was scaled by exactly 2 with nearest neighbour, from 1586x992 to 3172x1984, to meet the 2560x1600 minimum. A plate pixel is therefore a 2x2 block.
2. Transparent assets: the image tool returned real alpha, so no key colour was used or removed. Alpha was made binary (alpha of 128 or more became 255, the rest 0, and the colour of transparent pixels was cleared). This removes the faint alpha-1 residue and soft shadow the tool left around some objects. Opaque specks smaller than 40 pixels that were not connected to the object were dropped.
3. Each asset was cropped to its opaque bounding box. The three sprite sheets (`rail-extras`, `harbor-extras`, `canal-extras`) were cut into their separate props with the crop boxes listed below.
4. Every asset was scaled by exactly 2 with nearest neighbour, so all assets share one density: 2 asset pixels per plate pixel, where a plate pixel is the art pixel of today's 1585x992 plates.

Nine-slice cuts, inner areas and anchors were measured from the cropped art and are recorded in `manifest.json`; they change no pixels.

`preview.html` is written by `tools/make_preview.py` from `manifest.json`, and `tools/screenshots.mjs` takes the screenshots with the repo's Playwright. The preview also shows today's Pip companion, review notebook, source folio and Pixelify Sans font from `src/app/assets`; those files are unchanged and are not part of this delivery.

## Runs

### rail-background

- Reference image attached: `src/app/assets/front-row/last-desk.png`
- Original: `~/.codex/generated_images/01a1d5c2-2ddb-7cd3-8b9e-ccd8563f616a/exec-c64acd08-4e2d-457c-a371-7276b9690348.png` (1586x992)
- Used for `rail-background.png` (3172x1984): cropped to x 0 to 1586, y 0 to 992 of the original, then doubled.

Prompt, as sent:

````
Use your built-in image generation tool (not code, not SVG, not a script) to generate ONE image, using the attached reference image only as the style, palette and pixel-density reference. Save the generated PNG unchanged as `rail-background.png` in the current folder. Do not draw or edit anything with code. In your final message give the saved path, the original path of the generated file, and the image's pixel size.

Image prompt:

A background plate for a cosy anime pixel-art learning game: the empty front wall of a rail-side Japanese classroom, seen perfectly head-on in flat orthographic elevation, landscape 16:10, at the largest size available. Same art style, same palette and exactly the same pixel density as the attached reference: detailed 32-bit anime pixel art with crisp chunky pixel clusters and fine dark outlines, no smoothing, no blur, not vector, not photoreal.

This is ONLY the setting. There is NO chalkboard, NO desk, NO furniture, NO notebook, NO vine, NO pinned paper and NO top bar or border of any kind; those are separate layers added later. The picture runs edge to edge as wall.

Layout, as fractions of the picture:
- The wall is flat matte blue-grey plaster (about #6d90a4) with very subtle pixel grain. The whole left 78% of the picture is plain, continuous, empty wall with nothing on it, evenly lit, so that it can be cropped anywhere.
- A thin pale-wood picture rail runs perfectly horizontally across the full width at about 5% from the top, with slightly darker wall above it up to the top edge.
- From 64% of the height down to the bottom edge is a wainscot of darker blue-grey flat panels (about #557a8f) with a straight horizontal cap rail and evenly spaced straight vertical seams, continuing identically across the full width.
- On the right, one complete classroom window, fully inside the picture: its outer frame spans from 80% to 98% of the width and from 12% to 60% of the height, with a narrow strip of the same wall to its right. It is built like a real window: a rectangular sage-green painted wooden frame with a head, two jambs and a projecting sill, divided by straight, evenly spaced mullions and transoms into a regular grid of 2 columns by 3 rows of equal rectangular glass panes that line up exactly. It is closed, seen exactly head-on with every frame line perfectly vertical or horizontal: no open sash, no tilt, no perspective, no bend, no kink.
- Through the glass, as one continuous view behind the grid: bright afternoon sky with white cumulus clouds, distant pale blue towers, an elevated railway on a green steel viaduct with overhead wires and a red-and-cream commuter train, small shops with a striped awning, green trees and a pink cherry tree in blossom.
- Warm afternoon light comes from the right: the window reveal is lit, and a very faint warm tone falls on the wall next to the window. No hard shadow shapes on the empty wall.

No text, no letters, no numbers, no signs with writing, no UI, no people, no animals, no characters.
````

### rail-board

- Reference image attached: `src/app/assets/front-row/last-desk.png`
- Original: `~/.codex/generated_images/01a1d5c2-2dd0-7b21-9f1c-966c18696255/exec-e9959d01-157f-4b7c-8a72-1d1b88b5608b.png` (1536x1024)
- Used for `rail-board.png` (2946x1688): cropped to x 31 to 1504, y 90 to 934 of the original, then doubled.

Prompt, as sent:

````
Use your built-in image generation tool (not code, not SVG, not a script) to generate ONE image, using the attached reference image only as the style, palette and pixel-density reference (it shows the chalkboard this asset replaces). Save the generated PNG unchanged as `rail-board.png` in the current folder. Do not draw or edit anything with code. In your final message give the saved path, the original path of the generated file, the image's pixel size, and whether the background is truly transparent.

Image prompt:

A production game UI asset: one single empty classroom chalkboard, isolated on a genuinely transparent background (real alpha, nothing outside the object's silhouette, no scene, no wall, no cast shadow). Landscape 3:2 canvas at the largest size available; the object fills about 94% of the canvas width and is centred.

Flat orthographic front view. Every edge perfectly horizontal or vertical, no perspective, no tilt. Same style, palette and exactly the same pixel density as the chalkboard in the attached reference: detailed 32-bit anime pixel art, crisp chunky pixel clusters, fine dark outlines, no smoothing, not vector, not photoreal.

The board: a thin pale honey-wood frame (about #b8875a with lighter highlights), the same thickness on the top, left and right, with a fine dark outline and tiny wood-grain pixels. Along the bottom, a wooden chalk ledge that is slightly thicker than the frame and sticks out a little wider than the frame on both sides, with a lit top face and a darker front edge. The ledge is EMPTY: no eraser, no chalk, nothing on it.

The writing surface: one large plain matte dark green field, colour #18564b, completely even from edge to edge with only an extremely faint pixel grain. No chalk marks, no smudges, no dust, no gradient, no vignette, no highlights, no reflections, no lines. A one-pixel darker inner shadow right against the frame is fine. All ornament and detail stay in the outer frame so the plain middle can be stretched.

No text, no letters, no numbers, no UI, no people, no characters, no vine, no paper.
````

### rail-board-2

- Reference image attached: `src/app/assets/front-row/last-desk.png`
- Original: `~/.codex/generated_images/01a1d5d4-7fa7-7e63-be8e-044b41c1d17d/exec-60042f97-b31f-45d3-b84e-fec2fb0e920c.png` (1536x1024)
- Rejected. A second try for a surface colour closer to #18564b came back with the writing surface transparent, so the first board is kept.

Prompt, as sent:

````
Use your built-in image generation tool (not code, not SVG, not a script) to generate ONE image, using the attached reference image only as the style, palette and pixel-density reference (it shows the chalkboard this asset replaces). Save the generated PNG unchanged as `rail-board-2.png` in the current folder. Do not draw or edit anything with code. In your final message give the saved path, the original path of the generated file, the image's pixel size, and whether the background is truly transparent.

Image prompt:

A production game UI asset: one single empty classroom chalkboard, isolated on a genuinely transparent background (real alpha, nothing outside the object's silhouette, no scene, no wall, no cast shadow). Landscape 3:2 canvas at the largest size available; the object fills about 94% of the canvas width and is centred.

Flat orthographic front view. Every edge perfectly horizontal or vertical, no perspective, no tilt. Same style, palette and exactly the same pixel density as the chalkboard in the attached reference: detailed 32-bit anime pixel art, crisp chunky pixel clusters, fine dark outlines, no smoothing, not vector, not photoreal.

The board: a thin pale honey-wood frame (about #b8875a with lighter highlights), the same thickness on the top, left and right, with a fine dark outline and tiny wood-grain pixels. Along the bottom, a wooden chalk ledge that is slightly thicker than the frame and sticks out a little wider than the frame on both sides, with a lit top face and a darker front edge. The ledge is EMPTY: no eraser, no chalk, nothing on it.

The writing surface: one large plain matte dark green field, colour exactly #18564b (RGB 24, 86, 75), no darker and no bluer than that, completely even from edge to edge with only an extremely faint pixel grain. No chalk marks, no smudges, no dust, no gradient, no vignette, no highlights, no reflections, no lines. A one-pixel darker inner shadow right against the frame is fine. All ornament and detail stay in the outer frame so the plain middle can be stretched.

No text, no letters, no numbers, no UI, no people, no characters, no vine, no paper.
````

### rail-extras

- Reference image attached: `src/app/assets/front-row/last-desk.png`
- Original: `~/.codex/generated_images/01a1d5c6-182b-78d3-b271-94e065ca009d/exec-a0d42000-81b1-4791-bce6-ff5a35dfef84.png` (1585x992)
- Used for `rail-ledge-items.png` (1096x110): cropped to x 759 to 1307, y 581 to 636 of the original, then doubled.
- Used for `rail-vine.png` (522x790): cropped to x 130 to 391, y 251 to 646 of the original, then doubled.

Prompt, as sent:

````
Use your built-in image generation tool (not code, not SVG, not a script) to generate ONE image, using the attached reference image only as the style, palette and pixel-density reference (it shows the eraser, the two chalk pieces and the hanging vine these sprites replace). Save the generated PNG unchanged as `rail-extras.png` in the current folder. Do not draw or edit anything with code. In your final message give the saved path, the original path of the generated file, the image's pixel size, and whether the background is truly transparent.

Image prompt:

A production game sprite sheet: three separate small props from the attached classroom, isolated on a genuinely transparent background (real alpha, nothing outside the object's silhouette, no scene, no wall, no floor, no cast shadow). Canvas the same size and shape as the reference (landscape, about 16:10). The props are drawn at EXACTLY the same pixel size as they appear in the reference, not enlarged, and are spaced far apart with wide transparent gaps so each can be cut out. Flat orthographic front view.

1. Left third of the canvas: the hanging ivy vine from the top-left corner of the reference: a cluster of bright green ivy leaves at the top with one or two leafy strands hanging straight down, about 210 pixels wide and 330 pixels tall, exactly as large as in the reference. Leaves only: no wall, no board, no pot.
2. Middle of the canvas: the chalkboard eraser from the reference: a pale wooden block with a dark navy felt base, about 115 pixels wide and 45 pixels tall, with a flat straight bottom edge.
3. Right of the eraser, on the same baseline with a clear gap: two short white chalk sticks lying flat side by side with a gap between them, each about 70 pixels wide and 16 pixels tall, with flat straight bottom edges.

Same style, palette and exactly the same pixel density as the attached reference: detailed 32-bit anime pixel art, crisp chunky pixel clusters, fine dark outlines, no smoothing, no blur, not vector, not photoreal.

No text, no letters, no numbers, no signs with writing, no UI, no people, no animals, no characters.
````

### rail-desk

- Reference image attached: `src/app/assets/front-row/last-desk.png`
- Original: `~/.codex/generated_images/01a1d5c4-869f-7532-a8e9-fc43e61bf4d0/exec-03b59708-60f0-4966-8b01-3b17ec4f74bc.png` (2172x724)
- Used for `rail-desk.png` (4344x718): cropped to x 0 to 2172, y 365 to 724 of the original, then doubled.

Prompt, as sent:

````
Use your built-in image generation tool (not code, not SVG, not a script) to generate ONE image, using the attached reference image only as the style, palette and pixel-density reference (it shows, along its bottom, the wooden desk this asset replaces). Save the generated PNG unchanged as `rail-desk.png` in the current folder. Do not draw or edit anything with code. In your final message give the saved path, the original path of the generated file, the image's pixel size, and whether the background is truly transparent.

Image prompt:

A production game UI asset: one single empty wooden school desktop, the front-row desk seen from the student's seat, isolated on a genuinely transparent background (real alpha, nothing outside the object's silhouette, no scene, no wall, no floor, no cast shadow). Widest landscape canvas available (about 3:1 if possible). The desk spans the whole canvas width, touching the left and right canvas edges, and touches the bottom canvas edge. Any canvas above the desk is fully transparent.

Same style, palette and exactly the same pixel density as the desk in the attached reference: detailed 32-bit anime pixel art, crisp chunky pixel clusters, fine dark outlines, no smoothing, not vector, not photoreal.

The desk: a warm reddish-brown wooden desktop (about #9f6650, with darker #7a4a3c grain and lighter #c08a68 highlights) seen from slightly above, so we look down onto its top surface. Its far edge is one perfectly straight horizontal line near the top of the object, with a thin lighter highlight along it and a fine dark outline. At the far left and far right ends, the far corners are cut by a short diagonal, exactly like the reference, giving a shallow trapezoid; these two corners sit within the outer 8% of the width. Along the very bottom runs a slightly darker straight front lip. The wood grain is long, calm, horizontal plank streaks, even across the whole width: no knots, no rings, no stains, no plank ends, no single distinctive mark, and no gradient or vignette, so the middle 84% can be stretched or cropped sideways without anyone noticing.

The desktop is completely EMPTY: no paper, no mat, no notebook, no pencil, no objects, no shadows of objects.

No text, no letters, no numbers, no UI, no people, no characters.
````

### rail-mat

- Reference image attached: `src/app/assets/front-row/last-desk.png`
- Original: `~/.codex/generated_images/01a1d5c4-864e-74a3-9a63-ba2c0186e7fc/exec-e4724e7d-386c-4a99-85e4-9ea2b9b0137c.png` (1536x1024)
- Used for `rail-mat.png` (2916x970): cropped to x 39 to 1497, y 267 to 752 of the original, then doubled.

Prompt, as sent:

````
Use your built-in image generation tool (not code, not SVG, not a script) to generate ONE image, using the attached reference image only as the style, palette and pixel-density reference (it shows, on the desk, the cream paper this asset replaces). Save the generated PNG unchanged as `rail-mat.png` in the current folder. Do not draw or edit anything with code. In your final message give the saved path, the original path of the generated file, the image's pixel size, and whether the background is truly transparent.

Image prompt:

A production game UI asset: one single blank sheet of cream writing paper lying flat, isolated on a genuinely transparent background (real alpha, nothing outside the object's silhouette, no desk, no scene). Landscape 3:2 canvas at the largest size available; the sheet is a wide rectangle about 3 times as wide as it is tall, centred, filling about 92% of the canvas width.

Seen exactly from above, flat orthographic: a true rectangle with perfectly horizontal and vertical edges, no perspective, no tilt, no curl. Same style, palette and exactly the same pixel density as the paper in the attached reference: detailed 32-bit anime pixel art, crisp chunky pixel clusters, no smoothing, not vector, not photoreal.

The sheet: plain warm cream paper, colour #fef0e2, completely even from edge to edge with only an extremely faint pixel grain. A fine dark navy (#1e2b45) pixel outline all round, small stepped pixel corners, and a narrow slightly darker cream band just inside the outline on the bottom and right edges to give the paper thickness. A tight two-pixel dark contact shadow hugging the bottom and right outer edge only. All detail stays in the outer border so the plain middle can be stretched.

The paper is completely BLANK: no ruled lines, no margin line, no holes, no writing, no marks, no folds, no stains, no gradient, no vignette.

No text, no letters, no numbers, no UI, no people, no characters.
````

### harbor-background

- Reference image attached: `src/app/assets/front-row/study-bench.png`
- Original: `~/.codex/generated_images/01a1d5c6-1826-7242-99c4-a42d707b25fd/exec-414d86cf-0477-4ee6-9adb-8ff828b7e632.png` (1586x992)
- Used for `harbor-background.png` (3172x1984): cropped to x 0 to 1586, y 0 to 992 of the original, then doubled.

Prompt, as sent:

````
Use your built-in image generation tool (not code, not SVG, not a script) to generate ONE image, using the attached reference image only as the style, palette and pixel-density reference (it shows the harbor terrace this background replaces). Save the generated PNG unchanged as `harbor-background.png` in the current folder. Do not draw or edit anything with code. In your final message give the saved path, the original path of the generated file, the image's pixel size.

Image prompt:

A background plate for a cosy anime pixel-art learning game: the view from an open-air Mediterranean harbor study terrace, landscape 16:10, at the largest size available. Same style, palette and exactly the same pixel density as the attached reference: detailed 32-bit anime pixel art, crisp chunky pixel clusters, fine dark outlines, no smoothing, no blur, not vector, not photoreal.

This is ONLY the setting. There is NO board, NO sign, NO desk, NO table, NO notebook, NO mat, NO lamp, NO awning and NO top bar or border of any kind; those are separate layers added later. The picture runs edge to edge.

Layout, as fractions of the picture:
- Sky: the top 50% is bright blue summer sky with a few white pixel cumulus clouds, continuous across the full width.
- Sea: a calm turquoise-to-deep-blue sea with a perfectly straight, perfectly horizontal horizon at 50% of the height, running the full width. Two or three tiny white sailboats.
- Left 28% of the picture: a sunny hillside harbor town rising above the horizon: cream and pink houses with terracotta roofs, green shutters, cypress trees, a stone bell tower, pink bougainvillea.
- Right 26% of the picture: a green headland with small houses across the bay, and a curving waterfront with terracotta roofs below it.
- The middle 46% is only sky above and open sea below the horizon, calm and continuous, because a board will be placed over it.
- Railing: a teal painted metal terrace railing runs perfectly horizontally across the FULL width, with its top rail at 58% of the height and evenly spaced straight vertical posts, standing on a low stone kerb at 68%. Leafy green shrubs show behind the lower part of the railing.
- Terrace floor: from 68% down to the bottom edge, a floor of warm pale stone paving slabs in straight even rows, continuous across the full width and evenly lit.
- A terracotta pot of purple lavender stands on the floor at the far left by the railing, and a clump of pink geraniums in a stone planter at the far right.

Bright midday light, the same saturated palette as the reference. Seen head-on, with the horizon, the railing and the floor rows all perfectly horizontal.

No text, no letters, no numbers, no signs with writing, no UI, no people, no animals, no characters.
````

### harbor-board

- Reference image attached: `src/app/assets/front-row/study-bench.png`
- Original: `~/.codex/generated_images/01a1d5c7-8474-7ce0-acd2-d771fa4d3714/exec-7350b4ef-8176-4b1a-9c87-dc8cc4ae4895.png` (1536x1024)
- Used for `harbor-board.png` (2892x1660): cropped to x 45 to 1491, y 96 to 926 of the original, then doubled.

Prompt, as sent:

````
Use your built-in image generation tool (not code, not SVG, not a script) to generate ONE image, using the attached reference image only as the style, palette and pixel-density reference (it shows the freestanding learning board this asset replaces). Save the generated PNG unchanged as `harbor-board.png` in the current folder. Do not draw or edit anything with code. In your final message give the saved path, the original path of the generated file, the image's pixel size, and whether the background is truly transparent.

Image prompt:

A production game UI asset: one single empty freestanding outdoor learning board on two wooden legs, isolated on a genuinely transparent background (real alpha, nothing outside the object's silhouette, no scene, no wall, no floor, no cast shadow). Landscape 3:2 canvas at the largest size available; the object fills about 94% of the canvas width and is centred.

Flat orthographic front view. Every edge perfectly horizontal or vertical, no perspective, no tilt. Same style, palette and exactly the same pixel density as the attached reference: detailed 32-bit anime pixel art, crisp chunky pixel clusters, fine dark outlines, no smoothing, no blur, not vector, not photoreal.

The board: a frame of pale weathered driftwood planks (about #a98a62 with lighter sun-bleached highlights), the same thickness on all four sides, with a fine dark outline, tiny wood-grain pixels and one small square iron bracket with a bolt at each of the four corners. NO lamps and nothing else on top of the frame: the top edge is a plain straight beam.

Below the frame, at the far left and far right only, two short sturdy wooden legs of the same driftwood go straight down, each with one diagonal brace running from the leg up to the underside of the frame, like the reference. The legs and braces stay within the outer 14% of the width on each side. Between the legs, below the frame, it is fully transparent.

The writing surface: one large plain matte green field, colour #0f725e, completely even from edge to edge with only an extremely faint pixel grain. No chalk marks, no smudges, no dust, no gradient, no vignette, no highlights, no reflections, no lines. A one-pixel darker inner shadow right against the frame is fine. All ornament and detail stay in the outer frame so the plain middle can be stretched.

No text, no letters, no numbers, no signs with writing, no UI, no people, no animals, no characters.
````

### harbor-board-2

- Reference image attached: `src/app/assets/front-row/study-bench.png`
- Original: `~/.codex/generated_images/01a1d5d4-74e0-7f13-91ef-4046eba6814f/exec-9f3f70f1-3a44-4125-ae7d-d36f5de8623a.png` (1536x1024)
- Rejected. A second try for a surface colour closer to #0f725e came out further away (#0a6151, distance 22 against 17 for the first), so the first board is kept.

Prompt, as sent:

````
Use your built-in image generation tool (not code, not SVG, not a script) to generate ONE image, using the attached reference image only as the style, palette and pixel-density reference (it shows the freestanding learning board this asset replaces). Save the generated PNG unchanged as `harbor-board-2.png` in the current folder. Do not draw or edit anything with code. In your final message give the saved path, the original path of the generated file, the image's pixel size, and whether the background is truly transparent.

Image prompt:

A production game UI asset: one single empty freestanding outdoor learning board on two wooden legs, isolated on a genuinely transparent background (real alpha, nothing outside the object's silhouette, no scene, no wall, no floor, no cast shadow). Landscape 3:2 canvas at the largest size available; the object fills about 94% of the canvas width and is centred.

Flat orthographic front view. Every edge perfectly horizontal or vertical, no perspective, no tilt. Same style, palette and exactly the same pixel density as the attached reference: detailed 32-bit anime pixel art, crisp chunky pixel clusters, fine dark outlines, no smoothing, no blur, not vector, not photoreal.

The board: a frame of pale weathered driftwood planks (about #a98a62 with lighter sun-bleached highlights), the same thickness on all four sides, with a fine dark outline, tiny wood-grain pixels and one small square iron bracket with a bolt at each of the four corners. NO lamps and nothing else on top of the frame: the top edge is a plain straight beam.

Below the frame, at the far left and far right only, two short sturdy wooden legs of the same driftwood go straight down, each with one diagonal brace running from the leg up to the underside of the frame, like the reference. The legs and braces stay within the outer 14% of the width on each side. Between the legs, below the frame, it is fully transparent.

The writing surface: one large plain matte green field, colour exactly #0f725e (RGB 15, 114, 94), no darker and no bluer than that, completely even from edge to edge with only an extremely faint pixel grain. No chalk marks, no smudges, no dust, no gradient, no vignette, no highlights, no reflections, no lines. A one-pixel darker inner shadow right against the frame is fine. All ornament and detail stay in the outer frame so the plain middle can be stretched.

No text, no letters, no numbers, no signs with writing, no UI, no people, no animals, no characters.
````

### harbor-extras

- Reference image attached: `src/app/assets/front-row/study-bench.png`
- Original: `~/.codex/generated_images/01a1d5ca-2130-71b1-9f52-8ff17a3a577d/exec-a759959b-2e49-4db6-aa21-3869e747ffd9.png` (1584x993)
- Used for `harbor-lamp.png` (242x216): cropped to x 191 to 312, y 164 to 272 of the original, then doubled.
- Used for `harbor-awning.png` (614x692): cropped to x 1134 to 1441, y 88 to 434 of the original, then doubled.
- Used for `harbor-cushion.png` (496x246): cropped to x 667 to 915, y 772 to 895 of the original, then doubled.

Prompt, as sent:

````
Use your built-in image generation tool (not code, not SVG, not a script) to generate ONE image, using the attached reference image only as the style, palette and pixel-density reference (it shows the board lamp, the striped awning with ivy and the round green cushion these sprites replace). Save the generated PNG unchanged as `harbor-extras.png` in the current folder. Do not draw or edit anything with code. In your final message give the saved path, the original path of the generated file, the image's pixel size, and whether the background is truly transparent.

Image prompt:

A production game sprite sheet: three separate props from the attached harbor terrace, isolated on a genuinely transparent background (real alpha, nothing outside the object's silhouette, no scene, no wall, no floor, no cast shadow). Canvas the same size and shape as the reference (landscape, about 16:10). The props are drawn at EXACTLY the same pixel size as they appear in the reference, not enlarged, and are spaced far apart with wide transparent gaps so each can be cut out.

1. Top left: ONE gooseneck board lamp, exactly like one of the three lamps on top of the board in the reference: a small square base, a curved dark iron pipe arm and a dark metal shade with a warm glowing underside, about 95 pixels wide and 80 pixels tall, flat front view, with a flat straight bottom edge on its base.
2. Top right: the cream-and-sage striped canvas awning from the top-right corner of the reference, with its scalloped edge, its iron bracket arm and a strand of green ivy hanging from it, about 250 pixels wide and 330 pixels tall. Its right side and top end in clean straight edges, as if it continues beyond the screen corner.
3. Bottom centre: the round green woven cushion from the desk in the reference, seen from the same slightly raised angle, with its yellow stitched rim, about 225 pixels wide and 110 pixels tall. No desk under it.

Same style, palette and exactly the same pixel density as the attached reference: detailed 32-bit anime pixel art, crisp chunky pixel clusters, fine dark outlines, no smoothing, no blur, not vector, not photoreal.

No text, no letters, no numbers, no signs with writing, no UI, no people, no animals, no characters.
````

### harbor-desk

- Reference image attached: `src/app/assets/front-row/study-bench.png`
- Original: `~/.codex/generated_images/01a1d5c8-fd55-7071-a1be-15bd732fa30d/exec-3d0a5d0a-4a1f-4018-be82-9bd591a9dd37.png` (2172x724)
- Rejected. The desk came out 218 pixels deep, too shallow to hold the mat. Replaced by harbor-desk-2.

Prompt, as sent:

````
Use your built-in image generation tool (not code, not SVG, not a script) to generate ONE image, using the attached reference image only as the style, palette and pixel-density reference (it shows, along its bottom, the wooden terrace desk this asset replaces). Save the generated PNG unchanged as `harbor-desk.png` in the current folder. Do not draw or edit anything with code. In your final message give the saved path, the original path of the generated file, the image's pixel size, and whether the background is truly transparent.

Image prompt:

A production game UI asset: one single empty wooden outdoor desktop, the front-row desk seen from the student's seat, isolated on a genuinely transparent background (real alpha, nothing outside the object's silhouette, no scene, no wall, no floor, no cast shadow). Widest landscape canvas available (about 3:1 if possible). The desk spans the whole canvas width, touching the left and right canvas edges, and touches the bottom canvas edge. Any canvas above the desk is fully transparent.

Same style, palette and exactly the same pixel density as the attached reference: detailed 32-bit anime pixel art, crisp chunky pixel clusters, fine dark outlines, no smoothing, no blur, not vector, not photoreal.

The desk: a sunlit honey-orange wooden desktop (about #c27d4d, with darker #9c5f38 grain and lighter #dc9a66 highlights) seen from slightly above, so we look down onto its top surface. Its far edge is one perfectly straight horizontal line near the top of the object, with a thin lighter highlight along it and a fine dark outline. At the far left and far right ends, the far corners are cut by a short diagonal, like the reference, giving a shallow trapezoid; these two corners sit within the outer 8% of the width. Along the very bottom runs a slightly darker straight front lip. The wood grain is long, calm, horizontal plank streaks, even across the whole width: no knots, no rings, no stains, no plank ends, no single distinctive mark, and no gradient or vignette, so the middle 84% can be stretched or cropped sideways without anyone noticing.

The desktop is completely EMPTY: no paper, no mat, no cushion, no notebook, no objects, no shadows of objects.

No text, no letters, no numbers, no signs with writing, no UI, no people, no animals, no characters.
````

### harbor-desk-2

- Reference image attached: `src/app/assets/front-row/study-bench.png`
- Original: `~/.codex/generated_images/01a1d5cc-e87b-7243-a4f8-4f7a443b3a71/exec-36ec9137-6536-4d54-b30a-741a060576ed.png` (2172x724)
- Used for `harbor-desk.png` (4344x724): cropped to x 0 to 2172, y 362 to 724 of the original, then doubled.

Prompt, as sent:

````
Use your built-in image generation tool (not code, not SVG, not a script) to generate ONE image, using the attached reference image only as the style, palette and pixel-density reference (it shows, along its bottom, the wooden terrace desk this asset replaces). Save the generated PNG unchanged as `harbor-desk-2.png` in the current folder. Do not draw or edit anything with code. In your final message give the saved path, the original path of the generated file, the image's pixel size, and whether the background is truly transparent.

Image prompt:

A production game UI asset: one single empty wooden outdoor desktop, the front-row desk seen from the student's seat, isolated on a genuinely transparent background (real alpha, nothing outside the object's silhouette, no scene, no wall, no floor, no cast shadow). Widest landscape canvas available (about 3:1 if possible). The desk spans the whole canvas width, touching the left and right canvas edges, and touches the bottom canvas edge. The desk is deep: its top surface fills the lower half of the canvas, so the far edge sits at about 50% of the canvas height. The canvas above the desk is fully transparent.

Same style, palette and exactly the same pixel density as the attached reference: detailed 32-bit anime pixel art, crisp chunky pixel clusters, fine dark outlines, no smoothing, no blur, not vector, not photoreal.

The desk: a sunlit honey-orange wooden desktop (about #c27d4d, with darker #9c5f38 grain and lighter #dc9a66 highlights) seen from slightly above, so we look down onto its top surface. Its far edge is one perfectly straight horizontal line near the top of the object, with a thin lighter highlight along it and a fine dark outline. At the far left and far right ends, the far corners are cut by a short diagonal, like the reference, giving a shallow trapezoid; these two corners sit within the outer 8% of the width. Along the very bottom runs a slightly darker straight front lip. The wood grain is long, calm, horizontal plank streaks, even across the whole width: fine thin streaks only, no dark blotches, no knots, no rings, no stains, no plank ends, no single distinctive mark, and no gradient or vignette, so the middle 84% can be stretched or cropped sideways without anyone noticing.

The desktop is completely EMPTY: no paper, no mat, no cushion, no notebook, no objects, no shadows of objects.

No text, no letters, no numbers, no signs with writing, no UI, no people, no animals, no characters.
````

### harbor-mat

- Reference image attached: `src/app/assets/front-row/study-bench.png`
- Original: `~/.codex/generated_images/01a1d5ca-2139-78d1-8aec-73031baa67e7/exec-66ea6fe0-22f1-4a4b-a5ae-7387461cea9a.png` (1536x1024)
- Used for `harbor-mat.png` (2872x956): cropped to x 50 to 1486, y 273 to 751 of the original, then doubled.

Prompt, as sent:

````
Use your built-in image generation tool (not code, not SVG, not a script) to generate ONE image, using the attached reference image only as the style, palette and pixel-density reference (it shows, on the desk, the cream paper mat this asset replaces). Save the generated PNG unchanged as `harbor-mat.png` in the current folder. Do not draw or edit anything with code. In your final message give the saved path, the original path of the generated file, the image's pixel size, and whether the background is truly transparent.

Image prompt:

A production game UI asset: one single blank cream paper desk mat lying flat, isolated on a genuinely transparent background (real alpha, nothing outside the object's silhouette, no scene, no wall, no floor, no cast shadow). Landscape 3:2 canvas at the largest size available; the mat is a wide rectangle about 3 times as wide as it is tall, centred, filling about 92% of the canvas width.

Seen exactly from above, flat orthographic: a true rectangle with perfectly horizontal and vertical edges, no perspective, no tilt, no curl. Same style, palette and exactly the same pixel density as the attached reference: detailed 32-bit anime pixel art, crisp chunky pixel clusters, fine dark outlines, no smoothing, no blur, not vector, not photoreal.

The mat: plain warm cream paper, colour #feebcd, completely even from edge to edge with only an extremely faint pixel grain. A fine dark brown (#3a3026) pixel outline all round, small stepped pixel corners, and a narrow slightly darker cream band just inside the outline on the bottom and right edges to give it thickness. A tight two-pixel dark contact shadow hugging the bottom and right outer edge only. All detail stays in the outer border so the plain middle can be stretched.

The mat is completely BLANK: no ruled lines, no margin line, no holes, no writing, no marks, no folds, no stains, no gradient, no vignette.

No text, no letters, no numbers, no signs with writing, no UI, no people, no animals, no characters.
````

### canal-background

- Reference image attached: `src/app/assets/front-row/projection-booth.png`
- Original: `~/.codex/generated_images/01a1d5c7-847a-75b1-b45f-fbde65aba351/exec-632e0dae-762f-4534-a54b-231b2aa7930a.png` (1586x992)
- Used for `canal-background.png` (3172x1984): cropped to x 0 to 1586, y 0 to 992 of the original, then doubled.

Prompt, as sent:

````
Use your built-in image generation tool (not code, not SVG, not a script) to generate ONE image, using the attached reference image only as the style, palette and pixel-density reference (it shows the canal film club room this background replaces). Save the generated PNG unchanged as `canal-background.png` in the current folder. Do not draw or edit anything with code. In your final message give the saved path, the original path of the generated file, the image's pixel size.

Image prompt:

A background plate for a cosy anime pixel-art learning game: the empty front wall of a small lantern-lit canal-side film club room on a rainy evening, seen perfectly head-on in flat orthographic elevation, landscape 16:10, at the largest size available. Same style, palette and exactly the same pixel density as the attached reference: detailed 32-bit anime pixel art, crisp chunky pixel clusters, fine dark outlines, no smoothing, no blur, not vector, not photoreal.

This is ONLY the setting. There is NO projection screen, NO projector, NO desk, NO table, NO shelf, NO notebook, NO mat, NO light beam and NO top bar or border of any kind; those are separate layers added later. The picture runs edge to edge as wall.

Layout, as fractions of the picture:
- The wall is dark navy painted timber (about #353f67 with darker #272e52 seams): straight vertical planks of equal width from the top edge to the bottom edge, continuing identically across the full width. The whole right 76% of the picture is plain, continuous, empty plank wall with nothing on it, evenly lit, so that it can be cropped anywhere.
- A thin dark timber rail runs perfectly horizontally across the full width at about 5% from the top, and a plain darker skirting board runs across the full width along the bottom 5%.
- On the left, one complete window, fully inside the picture: its outer frame spans from 2% to 21% of the width and from 12% to 62% of the height, with a narrow strip of the same plank wall to its left. It is built like a real window: a rectangular dark reddish-brown wooden frame with a head, two jambs and a projecting sill, divided by straight, evenly spaced mullions and transoms into a regular grid of 2 columns by 3 rows of equal rectangular glass panes that line up exactly. It is closed, seen exactly head-on with every frame line perfectly vertical or horizontal: no open sash, no tilt, no perspective, no bend, no kink.
- Through the glass, as one continuous view behind the grid: a rainy blue dusk over a narrow Japanese canal, old wooden townhouses with glowing warm windows and red-orange paper lanterns, an arched stone bridge, a distant pagoda, a weeping willow, lantern light reflected in the water, fine diagonal rain.
- A few dark green leaves hang down inside the top-left corner of the window frame only. A very faint warm glow from the lanterns falls on the window reveal. No hard shadow or light shapes on the empty wall.

No text, no letters, no numbers, no signs with writing, no UI, no people, no animals, no characters.
````

### canal-board

- Reference image attached: `src/app/assets/front-row/projection-booth.png`
- Original: `~/.codex/generated_images/01a1d5c8-fd52-7d62-8727-921e811e4b45/exec-0829c710-5828-43f3-a0a5-2d11ed61a9e7.png` (1536x1024)
- Used for `canal-board.png` (2926x1646): cropped to x 37 to 1500, y 90 to 913 of the original, then doubled.

Prompt, as sent:

````
Use your built-in image generation tool (not code, not SVG, not a script) to generate ONE image, using the attached reference image only as the style, palette and pixel-density reference (it shows the pull-down projection screen this asset replaces). Save the generated PNG unchanged as `canal-board.png` in the current folder. Do not draw or edit anything with code. In your final message give the saved path, the original path of the generated file, the image's pixel size, and whether the background is truly transparent.

Image prompt:

A production game UI asset: one single empty pull-down projection screen, isolated on a genuinely transparent background (real alpha, nothing outside the object's silhouette, no scene, no wall, no floor, no cast shadow). Landscape 3:2 canvas at the largest size available; the object fills about 94% of the canvas width and is centred.

Flat orthographic front view. Every edge perfectly horizontal or vertical, no perspective, no tilt. Same style, palette and exactly the same pixel density as the attached reference: detailed 32-bit anime pixel art, crisp chunky pixel clusters, fine dark outlines, no smoothing, no blur, not vector, not photoreal.

The screen: along the top, a straight horizontal roller case in muted grey-mauve metal (about #8f8597 with lighter highlights and a fine dark outline), slightly wider than the fabric, with a square end cap at each end and one small wall bracket with a bolt above each end, like the reference. Along the bottom, a thinner straight weight bar in the same grey-mauve, slightly wider than the fabric, with small end caps. NO pull tab, ring or handle hanging from the bottom bar: its underside is plain.

Between the two bars hangs the fabric: one large plain matte warm cream field, colour #fbe1c5, completely even from edge to edge with only an extremely faint pixel grain, and a fine darker cream pixel hem down the left and right sides. No projected image, no light cone, no stains, no gradient, no vignette, no dithered corner shading, no folds, no wrinkles, no lines. All ornament and detail stay in the top and bottom bars and the side hems so the plain middle can be stretched.

No text, no letters, no numbers, no signs with writing, no UI, no people, no animals, no characters.
````

### canal-extras

- Reference image attached: `src/app/assets/front-row/projection-booth.png`
- Original: `~/.codex/generated_images/01a1d5cb-6df0-78f2-bbe6-241e64889bb6/exec-83a4ee45-551a-4f4c-a276-700e21fc9ecf.png` (1586x992)
- Used for `canal-pull-tab.png` (98x104): cropped to x 1155 to 1204, y 472 to 524 of the original, then doubled.
- Used for `canal-projector.png` (474x508): cropped to x 289 to 526, y 360 to 614 of the original, then doubled.

Prompt, as sent:

````
Use your built-in image generation tool (not code, not SVG, not a script) to generate ONE image, using the attached reference image only as the style, palette and pixel-density reference (it shows the film projector and the small pull tab under the screen that these sprites replace). Save the generated PNG unchanged as `canal-extras.png` in the current folder. Do not draw or edit anything with code. In your final message give the saved path, the original path of the generated file, the image's pixel size, and whether the background is truly transparent.

Image prompt:

A production game sprite sheet: two separate props from the attached film club room, isolated on a genuinely transparent background (real alpha, nothing outside the object's silhouette, no scene, no wall, no floor, no cast shadow). Canvas the same size and shape as the reference (landscape, about 16:10). The props are drawn at EXACTLY the same pixel size as they appear in the reference, not enlarged, and are spaced far apart with wide transparent gaps so each can be cut out.

1. Left half of the canvas: the vintage film projector from the reference, facing right: a pale grey-beige metal body with vent slots and a small red light, one large film reel on top, a lens at the right with a warm amber glow inside the lens, and small feet with a flat straight bottom edge. About 170 pixels wide and 185 pixels tall, exactly as large as in the reference. NO light beam or cone coming out of the lens, NO table or shelf under it, NO window behind it.
2. Right half of the canvas: the small metal pull tab that hangs under the centre of the projection screen in the reference: a short grey-mauve strap ending in a small rectangular ring, about 36 pixels wide and 40 pixels tall, with a flat straight top edge where it meets the bar.

Same style, palette and exactly the same pixel density as the attached reference: detailed 32-bit anime pixel art, crisp chunky pixel clusters, fine dark outlines, no smoothing, no blur, not vector, not photoreal.

No text, no letters, no numbers, no signs with writing, no UI, no people, no animals, no characters.
````

### canal-desk

- Reference image attached: `src/app/assets/front-row/projection-booth.png`
- Original: `~/.codex/generated_images/01a1d5cb-6df8-7910-a474-023cb4a09b20/exec-d0a8bd27-0d22-4625-b893-fd6f94782dbd.png` (2172x724)
- Used for `canal-desk.png` (4344x820): cropped to x 0 to 2172, y 314 to 724 of the original, then doubled.

Prompt, as sent:

````
Use your built-in image generation tool (not code, not SVG, not a script) to generate ONE image, using the attached reference image only as the style, palette and pixel-density reference (it shows, along its bottom, the dark wooden desk this asset replaces). Save the generated PNG unchanged as `canal-desk.png` in the current folder. Do not draw or edit anything with code. In your final message give the saved path, the original path of the generated file, the image's pixel size, and whether the background is truly transparent.

Image prompt:

A production game UI asset: one single empty wooden desktop, the front-row desk seen from the student's seat, isolated on a genuinely transparent background (real alpha, nothing outside the object's silhouette, no scene, no wall, no floor, no cast shadow). Widest landscape canvas available (about 3:1 if possible). The desk spans the whole canvas width, touching the left and right canvas edges, and touches the bottom canvas edge. Any canvas above the desk is fully transparent.

Same style, palette and exactly the same pixel density as the attached reference: detailed 32-bit anime pixel art, crisp chunky pixel clusters, fine dark outlines, no smoothing, no blur, not vector, not photoreal.

The desk: a dark reddish-brown wooden desktop in dim evening lamplight (about #81494a, with darker #5c3238 grain and warmer #a8613f highlights) seen from slightly above, so we look down onto its top surface. Its far edge is one perfectly straight horizontal line near the top of the object, with a thin warm orange highlight along it and a fine dark outline. At the far left and far right ends, the far corners are cut by a short diagonal, like the reference, giving a shallow trapezoid; these two corners sit within the outer 8% of the width. Along the very bottom runs a slightly darker straight front lip. The wood grain is long, calm, horizontal plank streaks, even across the whole width: no knots, no rings, no stains, no plank ends, no single distinctive mark, and no gradient or vignette, so the middle 84% can be stretched or cropped sideways without anyone noticing.

The desktop is completely EMPTY: no mat, no notebook, no projector, no objects, no shadows of objects.

No text, no letters, no numbers, no signs with writing, no UI, no people, no animals, no characters.
````

### canal-mat

- Reference image attached: `src/app/assets/front-row/projection-booth.png`
- Original: `~/.codex/generated_images/01a1d5cc-d103-7772-a228-094f944b53c6/exec-642d5c98-a8e7-4e97-a352-c89f54e48b9b.png` (1536x1024)
- Used for `canal-mat.png` (2910x866): cropped to x 41 to 1496, y 284 to 717 of the original, then doubled.

Prompt, as sent:

````
Use your built-in image generation tool (not code, not SVG, not a script) to generate ONE image, using the attached reference image only as the style, palette and pixel-density reference (it shows, on the desk, the dark navy desk mat this asset replaces). Save the generated PNG unchanged as `canal-mat.png` in the current folder. Do not draw or edit anything with code. In your final message give the saved path, the original path of the generated file, the image's pixel size, and whether the background is truly transparent.

Image prompt:

A production game UI asset: one single blank dark navy felt desk mat lying flat, isolated on a genuinely transparent background (real alpha, nothing outside the object's silhouette, no scene, no wall, no floor, no cast shadow). Landscape 3:2 canvas at the largest size available; the mat is a wide rectangle about 3 times as wide as it is tall, centred, filling about 92% of the canvas width.

Seen exactly from above, flat orthographic: a true rectangle with perfectly horizontal and vertical edges and small rounded pixel corners, no perspective, no tilt, no curl. Same style, palette and exactly the same pixel density as the attached reference: detailed 32-bit anime pixel art, crisp chunky pixel clusters, fine dark outlines, no smoothing, no blur, not vector, not photoreal.

The mat: plain matte navy felt, colour #2c3a61, completely even from edge to edge with only an extremely faint pixel grain. A fine near-black navy (#161b33) pixel outline all round, and a narrow slightly lighter navy stitched band just inside the outline all round. A tight two-pixel dark contact shadow hugging the bottom and right outer edge only. All detail stays in the outer border so the plain middle can be stretched.

The mat is completely BLANK: no writing, no marks, no logo, no pattern, no folds, no stains, no gradient, no vignette, no highlights.

No text, no letters, no numbers, no signs with writing, no UI, no people, no animals, no characters.
````

## Fixes after review (2026-11-13)

Derek found the canal window's lattice off centre and the desk's Source and Earlier objects blank. Two more runs were made with the same `codex exec` command as above, from a scratch folder, at most two at a time. Both are used. The processing is the same as the edits listed at the top: nearest-neighbour 2x, binary alpha, specks under 40 pixels dropped, crop to the opaque bounding box. No pixel was repainted or recoloured.

### canal-background-2

- Why: the first canal background had its one vertical mullion left of the glass's centre (about 215 of a 65 to 435 glass at 2000 px wide), so the two panes differed in width.
- References attached: `src/app/assets/front-row/projection-booth.png` and the previous background at 1586x992.
- Original: `~/.codex/generated_images/01a1d61c-81e5-7d70-a9d4-8d891988dc9e/exec-f10ba36c-88b1-48a4-9c9d-dad0cd9f4b1e.png` (1586x992)
- Used for `canal-background.png` (3172x1984): not cropped, then doubled. It replaces the file in `src/app/assets/front-row-v2/` too.
- Result: the mullion is now at the glass's horizontal centre, and the window sits at the same place, so the manifest's window feature, safe area and wall span are unchanged. The two transoms are still not exact thirds, with rows of about 190, 162 and 150 plate pixels, the same unevenness as before.

Prompt, as sent:

````
Use your built-in image generation tool (not code, not SVG, not a script) to generate ONE image. Attached: `reference.png` (the old canal film club plate, for palette and style) and `current-1x.png` (the current background, which is nearly right). Save the generated PNG unchanged as `canal-background.png` in the current folder. Do not draw or edit anything with code. In your final message give the saved path, the original path of the generated file, and the image's pixel size.

Image prompt:

Redraw `current-1x.png` almost exactly: the same empty front wall of a small canal-side film club room on a rainy evening, landscape 16:10, at the largest size available, flat orthographic head-on elevation. Same navy vertical wall panels, same picture rail across the top, same dark wainscot band along the bottom, same window position (left side, its frame spanning about 2% to 23% of the width and 13% to 69% of the height), same wooden frame colour and same pixel density and style: detailed 32-bit anime pixel art, crisp chunky pixel clusters, fine dark outlines, no smoothing, not vector, not photoreal. Same view through the glass: a rainy blue dusk over a narrow canal, wooden townhouses with glowing warm windows and red-orange paper lanterns, an arched stone bridge, a distant pagoda, a weeping willow, lantern reflections in the water, fine diagonal rain.

The ONE change: the window must be geometrically regular. It is a plain rectangular wooden frame with a head, two jambs and a sill. Inside it there is exactly ONE vertical mullion, placed EXACTLY at the horizontal centre of the glass, so the left and right panes are the same width. There are exactly TWO horizontal transoms, placed at exactly one third and two thirds of the glass height, so the three rows of panes are the same height. All mullions and transoms are the same thickness, perfectly straight, perfectly vertical or horizontal, crossing at right angles, with the same margin of glass between them and the frame on both sides. The frame is symmetric left to right. No open sash, no tilt, no perspective, no bend.

There is NO chalkboard, NO screen, NO desk, NO furniture, NO notebook and NO top bar. No text, no letters, no numbers, no UI, no people, no characters.
````

### closed-objects

- Why: the desk buttons drew the open frames `source-folio.png` and `review-notebook.png`, whose centres are blank pages.
- References attached: `src/app/assets/front-row/last-desk.png` (its closed navy notebook with the brass moon), the two open frames and `rail-ledge-items.png` for density.
- Original: `~/.codex/generated_images/01a1d61c-81e9-7de3-8eba-a336f148cb48/exec-8c40e0be-540f-47f0-b2e3-eeef93892532.png` (1448x1086, real alpha)
- Used for `closed-notebook.png` (1028x1030, crop x 70 to 584, y 314 to 829) and `closed-folio.png` (1180x976, crop x 817 to 1407, y 297 to 785), then doubled. Both are in `src/app/assets/front-row-v2/` and are drawn by all three rooms. The open frames stay the dialog art.

Prompt, as sent:

````
Use your built-in image generation tool (not code, not SVG, not a script) to generate ONE image. Attached: `reference-plate.png` (an old room plate whose bottom right shows a CLOSED navy notebook lying on a desk), `notebook-open.png` and `folio-open.png` (two open-object frames, for palette only) and `style-ref.png` (a small sprite at the target pixel density). Save the generated PNG unchanged as `closed-objects.png` in the current folder. Do not draw or edit anything with code. In your final message give the saved path, the original path of the generated file, the image's pixel size, and whether the background is truly transparent.

Image prompt:

A production game sprite sheet of two small props, isolated on a genuinely transparent background (real alpha, nothing outside the objects' silhouettes, no desk, no scene, no cast shadow). Landscape canvas. The two props are separate, far apart with a wide transparent gap, each fully inside the canvas, both drawn at the same scale. Same style, palette and pixel density as the attached art: detailed 32-bit anime pixel art, crisp chunky pixel clusters, fine dark outlines, no smoothing, not vector, not photoreal. Both lie flat on a surface seen from above and slightly in front, nearly head-on, with no rotation: every edge is straight and level.

Left prop: a CLOSED hardcover notebook, exactly like the closed navy book in the bottom right of `reference-plate.png`: a navy-blue cover with fine stitched border lines, a brass-yellow crescent moon at the upper centre of the cover, a brass-yellow bookmark ribbon hanging from the bottom edge, cream-amber page edges visible along the bottom and right sides, a dark spine on the left. Landscape proportion about 4:3.

Right prop: a CLOSED lecture folio of the same size and proportion, matching `folio-open.png`: a closed wooden-backed folio with a teal cloth spine on the left (with a small cream wave motif), a warm honey-brown wooden cover with a dark outline and wood-grain pixels, two small brass clips near the top, brass corner caps, and two small amber tabs sticking out of the right edge. Its cover is closed, so no parchment page face is visible.

No text, no letters, no numbers, no UI, no people, no characters.
````
