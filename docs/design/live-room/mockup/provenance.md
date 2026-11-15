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
- `harbor-room.png` is 1585 px wide, one pixel short of the 1586 plate.
