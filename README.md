# After Class

After Class is a work-in-progress study companion for YouTube lectures. You can recognize every slide and still struggle to explain the idea once the video ends. After Class gives you a place to try while the lecture is fresh, with the exact passage or frame available when you get stuck.

![The pixel study room with the current question on the board, Your thinking on the desk, and clickable source folio and history notebook.](docs/media/study-room-current.jpg)

*The screenshot uses a sample lecture on locks and deadlocks with deterministic fixture data. Room & companion offers three room skins and six companion options.*

## How it works

1. **Watch in Chrome.** Start capture from the extension. It tracks which intervals you play, collects timestamped captions when available, and samples video frames. A section you seek past stays out of the review.
2. **Prepare the evidence.** A local Bun backend groups watched material into concepts. Jev answers narrow questions, such as whether a slide change added a teaching step. Claude reads the selected evidence and uses it to run a short Socratic review.
3. **Explain it in your own words.** Work through the question on the board and write in **Your thinking** on the desk. Click the folio to check lecture evidence or the notebook to revisit earlier exchanges. **Saved notes** opens your saved records. When you finish a review, a notebook page shows its saved results. The record keeps your explanation apart from what the tutor added.

## Engineering decisions

| Decision | Why |
| --- | --- |
| Capture playback, captions, and frames in code | Playback events establish what the learner saw. Timestamps let a review question point back to the moment that supports it. |
| Give Jev small, structured judgments | Deciding whether a frame contains a new equation or just a moving cursor is a narrower task than explaining the equation. Filtering first is meant to cut the material Claude has to read. |
| Store evidence locally and cache model work | SQLite holds capture and review state, frame files live on disk, and the backend reuses cached results. Replay mode lets developers run recorded paths with live model calls turned off. |
| Keep capture and review separate | The extension runs next to the YouTube player. The review runs in its own web view, where lecture evidence, review history, and saved notes open over the room. |

## Hosted beta

A small invite-only beta runs at [useafterclass.com](https://useafterclass.com). It runs the same app on one server, with Clerk sign-in through Google or email. The server holds the model keys, so testers bring no keys of their own. Spending is capped at $5 per user and $50 in total each month. A review that reaches a cap may still finish its wrap-up. The hosted beta uses the browser's voice instead of ElevenLabs. The Chrome extension is not in the Chrome Web Store yet, so testers install a build the maintainer sends them.

Each release is a `v0.x` tag on master. The release workflow builds an image and records its digest, and the maintainer deploys a tag with `scripts/deploy-beta.sh`. The [infrastructure guide](infra/README.md) covers the server, keys, releases and costs.

## Try the study room

Install Bun (development uses 1.4.3), then run these from the repository root.

```sh
bun install --frozen-lockfile
bun run scripts/preview-ui.ts
```

Open [the local fixture preview](http://127.0.0.1:8770/?clean=1). Click the folio for lecture evidence or the notebook for earlier exchanges. Use **Saved notes** to browse saved records and **Room & companion** to choose a room and companion. The preview uses sample data and needs no extension, accounts, or API keys. Stop the preview with Ctrl+C.

## Run with a YouTube lecture

1. Build the extension with `bun run build:ext`. In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `dist/extension`.
2. Copy the extension ID that Chrome shows. In the repository's local `.env` file, set `AFTERCLASS_EXTENSION_ID=<your-extension-id>`.
3. For live review, sign in to the Claude Code CLI and make sure `claude` is on the backend's PATH. Create `~/.config/afterclass` if needed. Put `TYPESAFE_API_KEY=<your-Jev-key>` in `~/.config/afterclass/keys.env` and set its permissions with `chmod 600 ~/.config/afterclass/keys.env`. Live processing uses Jev and Claude for model tasks. For a capture-only trial, skip the provider setup and start with `AFTERCLASS_MODE=replay bun run dev`.
4. For live mode, run `AFTERCLASS_MODE=live bun run dev`. The backend listens on `127.0.0.1:4317` and prints a pairing token. Paste it into the extension's options.
5. Open a YouTube lecture, start capture from the extension, and watch a segment with captions. Use the extension's review action when material is ready. Stop the backend with Ctrl+C.

For a guided capture check, see the [capture probe](docs/experiments/01-capture-probe.md).

## Verification and design

`bun run typecheck` runs the TypeScript checks and `bun test` runs the test suite. Capture reliability, model quality, and learning effectiveness remain open evaluation questions. The [review flow and evaluation criteria](docs/flows/after-class.md) say how the project tests them.

Build both interfaces with `bun run build:app` and `bun run build:ext`. Use `bun run scripts/preview-ui.ts --build-only` to check the fixture build. The [visual review notes](docs/design/pixel-consistency/review.md) record the screens, responsive layouts, and interactions checked for the current design. These checks use fixtures and do not establish live capture or model quality.

- [Product requirements](docs/After%20Class%20-%20MVP%20PRD.md)
- [Architecture and module boundaries](src/MODULES.md)
- [Lifecycle models in TLA+](docs/flows/model/)
- [Current room and companion design](docs/design/front-row/README.md)
