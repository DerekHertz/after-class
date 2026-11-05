# After Class

After Class is a work-in-progress study companion for YouTube lectures. You can recognize every slide and still struggle to explain the idea once the video ends. After Class gives you a place to try while the lecture is fresh, with the exact passage or frame available when you get stuck.

![A source card opens lecture evidence over the pixel-art desk, then the notebook opens to an index and a saved note.](docs/media/study-room-demo.gif)

*The demo uses a sample lecture on locks and deadlocks. It shows the review interface with fixture data.*

## How it works

1. **Watch in Chrome.** Start capture from the extension. It tracks which intervals you actually play, collects timestamped captions when available, and samples video frames. Seeking past a section keeps it outside the review.
2. **Prepare the evidence.** A local Bun backend groups watched material into concepts. Jev answers narrow questions, such as whether a slide change added a teaching step. Claude interprets the selected evidence and uses it to guide a short Socratic review.
3. **Explain it in your own words.** Tutor replies stream into the review UI. You can open a source card to check the lecture, answer a follow-up, and revisit saved notes in the room’s notebook. The record distinguishes your explanation from tutor contributions.

## Engineering decisions

| Decision | Why |
| --- | --- |
| Capture playback, captions, and frames in code | Playback events establish what the learner saw. Timestamps let a review question point back to the moment that supports it. |
| Give Jev small, structured judgments | Deciding whether a frame contains a new equation or just a moving cursor is a narrower task than explaining the equation. Filtering first is intended to reduce the material Claude needs to interpret. |
| Store evidence locally and cache model work | SQLite holds capture and review state, frame files live on disk, and cached results can be reused. Replay mode lets developers exercise recorded paths with live model calls disabled. |
| Keep capture and review separate | The extension works alongside the YouTube player. The review runs in its own web view, where evidence and notebook pages open over the desk. |

## Try the study room

From the repository root, with Bun installed (development version 1.4.3):

```sh
bun install --frozen-lockfile
bun run scripts/preview-ui.ts
```

Open [the local fixture preview](http://127.0.0.1:8770/?clean=1). Click the card box for lecture evidence or the notebook for saved notes. This path uses sample data and needs no extension, accounts, or API keys. Stop the preview with Ctrl+C.

## Run with a YouTube lecture

1. Build the extension with `bun run build:ext`. In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `dist/extension`.
2. Copy the extension ID shown by Chrome. In the repository’s local `.env` file, set `AFTERCLASS_EXTENSION_ID=<your-extension-id>`.
3. For live review, sign in to the Claude Code CLI and make sure `claude` is on the backend’s PATH. Put `TYPESAFE_API_KEY=<your-Jev-key>` in `~/.config/afterclass/keys.env` and set its permissions with `chmod 600 ~/.config/afterclass/keys.env`. Live processing uses Jev and Claude for model tasks. For a capture-only trial, skip the provider setup and start with `AFTERCLASS_MODE=replay bun run dev`.
4. For live mode, run `AFTERCLASS_MODE=live bun run dev`. The backend listens on `127.0.0.1:4317` and prints a pairing token. Paste it into the extension’s options.
5. Open a YouTube lecture, start capture from the extension, and watch a segment with captions. Use the extension’s review action when material is ready. Stop the backend with Ctrl+C.

For a guided capture check, see the [capture probe](docs/experiments/01-capture-probe.md).

## Verification and design

Run `bun run typecheck` and `bun test` for the TypeScript checks and test suite. Capture reliability, model quality, and learning effectiveness remain open evaluation questions. The [review flow and evaluation criteria](docs/flows/after-class.md) describe how the project tests those assumptions.

- [Product requirements](docs/After%20Class%20-%20MVP%20PRD.md)
- [Architecture and module boundaries](src/MODULES.md)
- [Lifecycle models in TLA+](docs/flows/model/)
- [Room and companion design handoff](docs/design/IMPLEMENTATION-HANDOFF.md)
