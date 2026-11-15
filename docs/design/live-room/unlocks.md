# Unlock objects: slots and source crops

The room grows one painted object for every three topics a learner explains on their own (`TOPICS_PER_UNLOCK` in `src/app/room/progress.ts`). Each room has six fixed slots, listed in `UNLOCK_SLOTS` in `src/app/room/unlocks.ts` in the order they open. The learner cannot move them. The objects and positions are a product call, settled in the design brief. This page is the brief for the art step and the record of how each object was made.

## How the code draws an object

- A slot draws nothing until `UNLOCK_ART` in `src/app/room/art.ts` names its picture. Every slot of every room has one.
- The stage fetches a picture only once its slot is open, and paints the room without it until it decodes. A picture that fails to load is left out.
- An object is drawn pixelated at one asset pixel per plate pixel, in the slot's box, at the slot's depth among the room's layers.

## How to make one object

`unlocks/objects.py` does every step, so any object can be rerun.

    python3 objects.py gen <slot> [hint]   # one more take of a slot, about 9 credits
    python3 objects.py build [slot ...]    # key each slot's chosen take into art/masters/unlock-objects/
    bun run build:art                      # ship the masters as lossless WebP and record them in art/manifest.json

1. The slot's crop is in `unlocks/crops/`. Each is the stage's own pixels at 1440x900 at plate density, with every word and control hidden and the companion off. It is the slot's box grown on each side by one and a half times its longer edge, clipped to the window. "Slot in crop" below is the box's top left corner in the crop, in plate pixels.
2. `gen` cuts the largest square of the crop around the box, enlarges it by a whole number to at least 1024 px with nearest neighbour, and asks Meshy `nano-banana-pro` to add only the object where the box is, in the room's light, with no cast shadow, no text and no characters.
3. `build` shrinks the edit back to the square's size and keys the object out by differencing it against the crop. The object is the largest change and anything touching it, grown into weaker change next to it and filled solid. Its alpha is binary. If it is larger than the box it is shrunk to fit, with its colour premultiplied so the room behind it does not bleed in. It stands on the box's bottom edge. A lantern or a chime hangs from the box's top edge. The script prints how much of the room outside the object the edit moved. For the takes used it was 0% for fourteen objects, 0.3% for the harbor lantern, 3.3% for the canal lamp and 21% for the canal tea cup, where the edit repainted the wall's top strip far from the cup. The cup itself is clean, because only the change in and around the box is kept.
4. `build` writes the master and its `provenance.json` under `art/masters/unlock-objects/<room>/`. The provenance holds each object's prompt, task id and credits, and the takes that were not used. It also writes a local `gen/sheet.png` that shows each slot's crop, the edit and the object at three times plate density. `choices.json` names the take used where it is not the latest.

The model rarely puts the object exactly in the box, and it draws it at its own size. Neither matters, because the object is cut out and fitted to the box. Raw downloads stay local in `unlocks/gen/`.

## Rail-side Classroom (`last-desk`)

| Slot | Object | Box in plate pixels | Depth | Crop | Slot in crop |
| --- | --- | --- | --- | --- | --- |
| `last-desk/1` | a pencil cup on the desk | 52 x 74 | on the desk, behind the mat | `crops/last-desk-1.png` | 111, 111 |
| `last-desk/2` | a small potted plant on the window sill | 70 x 84 | in front of the background, behind the board | `crops/last-desk-2.png` | 126, 126 |
| `last-desk/3` | a short stack of books on the desk | 112 x 52 | on the desk, behind the mat | `crops/last-desk-3.png` | 168, 168 |
| `last-desk/4` | an apple on the chalk ledge | 40 x 40 | on the board, with its ledge items | `crops/last-desk-4.png` | 60, 60 |
| `last-desk/5` | two books leaning on the window sill | 64 x 70 | in front of the background, behind the board | `crops/last-desk-5.png` | 105, 105 |
| `last-desk/6` | a small globe on the desk | 64 x 72 | on the desk, behind the mat | `crops/last-desk-6.png` | 108, 108 |

## Harbor Study Terrace (`study-bench`)

| Slot | Object | Box in plate pixels | Depth | Crop | Slot in crop |
| --- | --- | --- | --- | --- | --- |
| `study-bench/1` | a potted herb on the terrace rail | 56 x 64 | in front of the background, behind the board | `crops/study-bench-1.png` | 96, 96 |
| `study-bench/2` | a glass of lemonade on the desk | 44 x 64 | on the desk, behind the mat | `crops/study-bench-2.png` | 96, 96 |
| `study-bench/3` | a paper lantern hanging from the awning | 52 x 84 | in front of the background, behind the board | `crops/study-bench-3.png` | 126, 126 |
| `study-bench/4` | a short stack of books on the desk | 112 x 52 | on the desk, behind the mat | `crops/study-bench-4.png` | 168, 168 |
| `study-bench/5` | a seashell on the desk | 60 x 40 | on the desk, behind the mat | `crops/study-bench-5.png` | 90, 90 |
| `study-bench/6` | a small bird on the terrace rail | 44 x 40 | in front of the background, behind the board | `crops/study-bench-6.png` | 16, 66 |

## Lantern Canal Film Club (`projection-booth`)

| Slot | Object | Box in plate pixels | Depth | Crop | Slot in crop |
| --- | --- | --- | --- | --- | --- |
| `projection-booth/1` | a cup of tea on the desk | 52 x 56 | on the desk, behind the mat | `crops/projection-booth-1.png` | 84, 84 |
| `projection-booth/2` | a paper lantern hanging in the window | 50 x 80 | in front of the background, behind the board | `crops/projection-booth-2.png` | 120, 120 |
| `projection-booth/3` | a stack of film canisters on the desk | 100 x 56 | on the desk, behind the mat | `crops/projection-booth-3.png` | 150, 150 |
| `projection-booth/4` | a wind chime hanging in the window | 40 x 84 | in front of the background, behind the board | `crops/projection-booth-4.png` | 110, 126 |
| `projection-booth/5` | a small desk lamp on the desk | 60 x 74 | on the desk, behind the mat | `crops/projection-booth-5.png` | 111, 111 |
| `projection-booth/6` | a ticket stub jar on the desk | 48 x 58 | on the desk, behind the mat | `crops/projection-booth-6.png` | 87, 87 |

