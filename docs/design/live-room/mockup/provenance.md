# Live room mockup: provenance

Generated 2026-11-14 by Codex CLI 0.163.0 with its built-in image generation tool on Derek's subscription, at Derek's request ("you can start a codex session to render the true pixel art version"). No paid image API, no new dependency, nothing drawn in code.

Command, one run per image, from a scratch folder:

    codex exec -m gpt-6.1-sol -c model_reasoning_effort='"high"' -s workspace-write --skip-git-repo-check --color never -i <refs> -o final.md - < prompt.md

| File | References attached | Prompt | Original |
| --- | --- | --- | --- |
| `live-room.png` (1586x992) | `docs/design/front-row/review/rail-final-desktop.jpg`, `art/masters/companions-v3/pip.png` | `prompt-room.md` | `~/.codex/generated_images/01a1dcda-de8e-7870-a1d0-9c94cb4ebb44/exec-2cb70155-5bfd-40af-9dd3-a127af27ed97.png` |
| `pip-expressions.png` (2172x724) | `art/masters/companions-v3/pip.png` | `prompt-pip.md` | `~/.codex/generated_images/01a1dcda-de8e-7883-b30b-6baebf537ba4/exec-3f993073-b897-42bf-a2e2-4d3cf0596f63.png` |
| `harbor-room.png` (1585x992) | `docs/design/front-row/review/harbor-final-desktop.jpg`, `live-room.png`, `art/masters/companions-v3/mote.png` | `prompt-harbor.md` | `~/.codex/generated_images/01a1ddb4-e5bd-7d60-9e7b-c8528a8712bc/exec-2d409893-48fc-4335-b3a7-81a609e9977a.png` |
| `canal-room.png` (1586x992) | `docs/design/front-row/review/canal-final-desktop.jpg`, `live-room.png`, `art/masters/companions-v3/mote-pagewing.png` | `prompt-canal.md` | `~/.codex/generated_images/01a1ddb4-e5b5-7ae0-a61d-1ddb9f91900f/exec-66abd6a3-adb0-4c11-a868-419d16ec825a.png` |

All four are saved unchanged. The Harbor and Canal mockups were made on 2026-11-14 with the same command, at Derek's request to "maybe revamp the other 2 rooms". Each takes the Rail mockup as its reference for life and finish, and keeps its own room's light. `mockup-with-ui.png` is `live-room.png` with today's review UI laid over it as HTML (`mock.html`, Pixelify Sans), screenshotted with Playwright. The UI text is sample content, not from a real review. Mockup only: none of this is shipping art.

Findings:
- Blink pose vs. idle pose: 20% of pixels differ (the whole figure shifts), so generated poses are not swap-ready frames. Rig parts must be cut and aligned (#223).
- The grown vine reaches into the board's text area; the layout must keep text clear of unlocked objects (#226).
- The sun beam crosses the board's right side; check text contrast if the shaft is drawn over the board (#220).
- Harbor and Canal place new objects at the desk ends. Today the companion sits at the left end and the notebook button sits at the right end. The layout must keep both clear of unlocked objects (#226).
- The Canal mockup moved the two posters between the window and the screen, and its navy mat lost the stitched edge of today's mat. The Harbor mat lost its torn-paper edge. The shipped mats stay as they are unless Derek wants the new ones.
- The first Canal mockup copied today's window lattice, which has a slanting top bar and uneven panes. Derek asked to fix it. Codex redrew the lattice from the first mockup with `prompt-canal-window.md` (original `~/.codex/generated_images/01a1ddb9-9457-7ba1-9ae9-02be956b198a/exec-53b03ff0-470b-4904-a164-90613f168d5f.png`, 1561x1008). `align_window.py` fitted its scale and offset to the first mockup, a uniform 0.984 scale. Only the window, the box from (0, 0) to (324, 583), was pasted back with a 2 px soft edge. The rest of `canal-room.png` is the first mockup, unchanged. The pasted window is resampled, so it is a little softer than the rest. Today's shipped Canal background has the same broken lattice.
- The upright bar then sat 50 px left of the glass centre. Derek pointed it out. A second Codex pass with `prompt-canal-mullion.md` (original `~/.codex/generated_images/01a1ddd5-02c7-7ff3-ac76-28ad0df17171/exec-d756c50c-317c-463a-b38f-1ada739696ea.png`, 1585x992) moved it, and the same box was aligned and pasted back. The bar now covers x 156 to 165 on glass from x 14 to 301, 3 px right of true centre, so the pane columns are 142 and 136 px wide.
- The popcorn box floated in front of the wall past the end of the projector shelf. A third Codex pass with `prompt-canal-popcorn.md` (original `~/.codex/generated_images/01a1ddde-d01b-71c3-b86c-6457921a6ff2/exec-14bfbebb-9e3f-4b57-b6d6-145a6606ae8e.png`, 1561x1007) removed it there and stood it on the desk beside the film canisters. The two boxes from (150, 530) to (250, 640) and from (1320, 690) to (1420, 880) were aligned and pasted back.
- An object-placement audit of all three mockups on 2026-11-14 found no other floating or misaligned objects. Every object rests on the desk, a shelf, a ledge, the floor or a wall hook.
- `harbor-room.png` is 1585 px wide, one pixel short of the 1586 plate.
