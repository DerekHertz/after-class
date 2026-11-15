# Painted companion frames

Derek chose the painted look on 2026-11-14 ("Sure ur suggestion for the original"). Each frame is a Meshy `nano-banana-pro` image-to-image edit of a companion's painted master (`art/masters/companions-v3/<id>.png`, idle cell), that asks for one change. These frames are design records for review. The companion animation work (#222) moves approved frames into `art/masters/` with a build rule.

`frames.py` does the whole job, so you can rerun any frame:

    python3 frames.py gen <companion> [frame ...]   # 9 credits a frame; skips frames already downloaded
    python3 frames.py build <companion>

`gen` puts the idle cell on flat magenta and submits one edit per frame. The raw downloads land in `gen/`, which stays local. `build` resizes each 1024 px output to the master's 724 px cell, keys magenta to binary alpha and halves the magenta spill on edge pixels. It redraws nothing. It writes into `<companion>/`:

- one PNG for each frame, plus `idle.png` cut from the master
- `frames.png`, a contact sheet in the order idle, then the frames
- `loop.gif`, a rough loop for judging. The stage will time and lift frames itself.
- `provenance.json`, with each frame's prompt, Meshy task id, credits and the share of the cell that changed from idle

The frames are blink, look-board, look-mat, nod, hop-crouch, hop-air, think, cheer and talk. The companions share prompts. A companion gets its own prompt where its body differs, such as wings for Mote or a lamp arm for Lumi.

An earlier one-off script made the first four Pip frames on 2026-11-14. `frames.py build` reproduces them with identical alpha and colour within 15 levels.
