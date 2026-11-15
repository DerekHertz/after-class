# Painted companion frames

Derek chose the painted look on 2026-11-14 ("Sure ur suggestion for the original"). Each frame is a Meshy `nano-banana-pro` image-to-image edit of the idle cell of a companion's painted master, `art/masters/companions-v3/<id>.png`, that asks for one change. These frames are design records for review. The companion animation work (#222) moves approved frames into `art/masters/` with a build rule.

`frames.py` reruns any frame:

    python3 frames.py gen <companion> [frame ...]   # 9 credits a frame; skips frames already downloaded
    python3 frames.py build <companion>

`gen` puts the idle cell on flat magenta and submits one edit per frame, with raw downloads in the local `gen/`. `build` resizes each 1024 px output to the 724 px cell, keys magenta to binary alpha and halves magenta spill on edge pixels, redrawing nothing. It writes each frame and `idle.png` into `<companion>/`, with a contact sheet `frames.png`, a rough `loop.gif` and `provenance.json` (prompt, Meshy task id, credits and the share of the cell changed from idle).

The frames are blink, look-board, look-mat, nod, hop-crouch, hop-air, think, cheer and talk. Companions share prompts, except where a body differs, such as Mote's wings or Lumi's lamp arm.
