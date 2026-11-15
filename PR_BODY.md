Title: docs(license): reserve all rights and credit Meshy for the companion frames

## Why

The repository is public but had no license. Derek chose all rights reserved. The companion frames came from Meshy's free plan, which licenses output under CC BY 4.0, so the app and repo must credit Meshy.

## What changed

- `LICENSE` reserves all rights and lists each third-party license, and the README links it.
- `src/app/assets/meshy-CC-BY-4.0.txt` gives the Meshy credit, the license link and the changes made, and the app's `asset-notices.txt` ships it.
- The build now reads which npm packages it bundled from Bun's metafile and ships each one's license. Today that is React, React DOM, Scheduler and Zod, whose MIT notices were missing before.
- The two design copies of Pixelify Sans now carry the OFL text, and `package.json` says `UNLICENSED`.

## Scope

- This covers licensing text and the shipped notices only. No app behavior changes.
- It does not decide whether the repo should later move to an open license.

## Blast Radius

Every visitor to the public repo now sees an explicit all rights reserved notice. The served `asset-notices.txt` gains one entry.

## Verification

- `bun test test/build-app.test.ts test/art.test.ts test/companion-frames.test.ts` pass. The notices test fails when the Meshy entry or the bundled package loop is removed from `scripts/build-app.ts`.
- `bun run typecheck` and `bun run lint` pass.
- Meshy's free plan terms come from its help center. This is not legal advice.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
