# Unlock objects: slots and source crops

The room grows one painted object for every three topics a learner explains on their own (`TOPICS_PER_UNLOCK` in `src/app/room/progress.ts`). Each room has six fixed slots, listed in `UNLOCK_SLOTS` in `src/app/room/unlocks.ts` in the order they open. The learner cannot move them. Derek decides the objects and the positions. This page is the brief for the art step.

## How the code draws an object

- A slot draws nothing until `UNLOCK_ART` in `src/app/room/unlocks.ts` names its picture. The table is empty until Derek approves the Meshy spend, so today no room shows an object and the Your room panel shows no count toward the next object.
- The stage fetches a picture only once its slot is open, and paints the room without it until it decodes. A picture that fails to load is left out.
- An object is drawn pixelated at one asset pixel per plate pixel, in the slot's box, at the slot's depth among the room's layers.

## How to make one object

1. Start from the slot's crop. Each crop is the stage's own pixels at 1440x900 at plate density, with every word and control hidden and the companion off. It is the slot's box grown on each side by one and a half times its longer edge, clipped to the window.
2. Edit it image to image with Meshy `nano-banana-pro`, asking for the object only, standing where the slot sits, with no text and no characters, in the room's light.
3. Clean it as the companion frames are cleaned (`docs/design/front-row/rooms-v2/provenance.md`). Make the alpha binary, drop specks, and crop to the slot's box size.
4. Add the master under `art/masters/`, build it with `bun run build:art`, record it in `art/manifest.json` with its prompt, task id and credits, and add its bundle URL to `UNLOCK_ART`.

The crops were saved on the machine that made this page, under the session scratchpad at `after/live-room/226-crops/`. They are not committed. "Slot in crop" is the slot box's top left corner in the crop, in plate pixels.

## Rail-side Classroom (`last-desk`)

| Slot | Object | Box in plate pixels | Depth | Crop | Slot in crop |
| --- | --- | --- | --- | --- | --- |
| `last-desk/1` | a pencil cup on the desk | 52 x 74 | on the desk, behind the mat | `226-crops/last-desk-1.png` | 111, 111 |
| `last-desk/2` | a small potted plant on the window sill | 70 x 84 | in front of the background, behind the board | `226-crops/last-desk-2.png` | 126, 126 |
| `last-desk/3` | a short stack of books on the desk | 112 x 52 | on the desk, behind the mat | `226-crops/last-desk-3.png` | 168, 168 |
| `last-desk/4` | an apple on the chalk ledge | 40 x 40 | on the board, with its ledge items | `226-crops/last-desk-4.png` | 60, 60 |
| `last-desk/5` | two books leaning on the window sill | 64 x 70 | in front of the background, behind the board | `226-crops/last-desk-5.png` | 105, 105 |
| `last-desk/6` | a small globe on the desk | 64 x 72 | on the desk, behind the mat | `226-crops/last-desk-6.png` | 108, 108 |

## Harbor Study Terrace (`study-bench`)

| Slot | Object | Box in plate pixels | Depth | Crop | Slot in crop |
| --- | --- | --- | --- | --- | --- |
| `study-bench/1` | a potted herb on the terrace rail | 56 x 64 | in front of the background, behind the board | `226-crops/study-bench-1.png` | 96, 96 |
| `study-bench/2` | a glass of lemonade on the desk | 44 x 64 | on the desk, behind the mat | `226-crops/study-bench-2.png` | 96, 96 |
| `study-bench/3` | a paper lantern hanging from the awning | 52 x 84 | in front of the background, behind the board | `226-crops/study-bench-3.png` | 126, 126 |
| `study-bench/4` | a short stack of books on the desk | 112 x 52 | on the desk, behind the mat | `226-crops/study-bench-4.png` | 168, 168 |
| `study-bench/5` | a seashell on the desk | 60 x 40 | on the desk, behind the mat | `226-crops/study-bench-5.png` | 90, 90 |
| `study-bench/6` | a small bird on the terrace rail | 44 x 40 | in front of the background, behind the board | `226-crops/study-bench-6.png` | 16, 66 |

## Lantern Canal Film Club (`projection-booth`)

| Slot | Object | Box in plate pixels | Depth | Crop | Slot in crop |
| --- | --- | --- | --- | --- | --- |
| `projection-booth/1` | a cup of tea on the desk | 52 x 56 | on the desk, behind the mat | `226-crops/projection-booth-1.png` | 84, 84 |
| `projection-booth/2` | a paper lantern hanging in the window | 50 x 80 | in front of the background, behind the board | `226-crops/projection-booth-2.png` | 120, 120 |
| `projection-booth/3` | a stack of film canisters on the desk | 100 x 56 | on the desk, behind the mat | `226-crops/projection-booth-3.png` | 150, 150 |
| `projection-booth/4` | a wind chime hanging in the window | 40 x 84 | in front of the background, behind the board | `226-crops/projection-booth-4.png` | 110, 126 |
| `projection-booth/5` | a small desk lamp on the desk | 60 x 74 | on the desk, behind the mat | `226-crops/projection-booth-5.png` | 111, 111 |
| `projection-booth/6` | a ticket stub jar on the desk | 48 x 58 | on the desk, behind the mat | `226-crops/projection-booth-6.png` | 87, 87 |

