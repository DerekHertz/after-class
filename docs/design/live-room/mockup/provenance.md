# Live room mockup: provenance

Generated 2026-11-14 by Codex CLI 0.163.0 with its built-in image generation tool on Derek's subscription, at Derek's request ("you can start a codex session to render the true pixel art version"). No paid image API, no new dependency, nothing drawn in code.

Command, one run per image, from a scratch folder:

    codex exec -m gpt-6.1-sol -c model_reasoning_effort='"high"' -s workspace-write --skip-git-repo-check --color never -i <refs> -o final.md - < prompt.md

| File | References attached | Prompt | Original |
| --- | --- | --- | --- |
| `live-room.png` (1586x992) | `docs/design/front-row/review/rail-final-desktop.jpg`, `art/masters/companions-v3/pip.png` | `prompt-room.md` | `~/.codex/generated_images/01a1dcda-de8e-7870-a1d0-9c94cb4ebb44/exec-2cb70155-5bfd-40af-9dd3-a127af27ed97.png` |
| `pip-expressions.png` (2172x724) | `art/masters/companions-v3/pip.png` | `prompt-pip.md` | `~/.codex/generated_images/01a1dcda-de8e-7883-b30b-6baebf537ba4/exec-3f993073-b897-42bf-a2e2-4d3cf0596f63.png` |

Both are saved unchanged. `mockup-with-ui.png` is `live-room.png` with today's review UI laid over it as HTML (`mock.html`, Pixelify Sans), screenshotted with Playwright. The UI text is sample content, not from a real review. Mockup only: none of this is shipping art.

Findings:
- Blink pose vs. idle pose: 20% of pixels differ (the whole figure shifts), so generated poses are not swap-ready frames. Rig parts must be cut and aligned (#223).
- The grown vine reaches into the board's text area; the layout must keep text clear of unlocked objects (#226).
- The sun beam crosses the board's right side; check text contrast if the shaft is drawn over the board (#220).
