/**
 * The two public pages of the hosted site, `/` and `/privacy`. They are plain HTML with one inline stylesheet and no
 * script, so a visitor who is not signed in sees what After Class is before any sign-in widget. The art and the two fonts
 * are files of the built review app, named `<stem>-<8 hash chars>.<ext>` (scripts/build-app.ts), so they are found by
 * stem in the app directory. The 1 MB art loads only from 700px wide up, so a phone gets the text and two fonts.
 * A page built without one of them still reads fine.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

export type PublicPage = "landing" | "privacy";

type Files = {
  readonly plate: string | null;
  readonly heading: string | null;
  readonly sans: string | null;
  readonly icon16: string | null;
  readonly icon32: string | null;
  readonly apple: string | null;
};

/** No script, no frames, no forms and no network beyond this origin. The inline style is the page's own. */
export const PUBLIC_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const stemFile = (names: readonly string[], stem: string, ext: string): string | null => {
  const found = names.find((n) => new RegExp(`^${stem}-[a-z0-9]{8}\\.${ext}$`).test(n));
  return found === undefined ? null : `/app/${found}`;
};

export function appFiles(appDir: string): Files {
  let names: string[] = [];
  try {
    names = readdirSync(appDir);
  } catch {
    // an unbuilt app leaves the pages without art or fonts
  }
  return {
    plate: stemFile(names, "last-desk", "webp"),
    heading: stemFile(names, "press-start-2p", "ttf"),
    sans: stemFile(names, "dm-sans-400", "ttf"),
    icon16: stemFile(names, "favicon-16", "png"),
    icon32: stemFile(names, "favicon-32", "png"),
    apple: stemFile(names, "apple-touch-icon", "png"),
  };
}

/** The built favicon.ico, which browsers ask for at /favicon.ico whatever the page says. Null in an unbuilt app. */
export function faviconIco(appDir: string): string | null {
  try {
    const found = readdirSync(appDir).find((n) => /^favicon-[a-z0-9]{8}\.ico$/.test(n));
    return found === undefined ? null : join(appDir, found);
  } catch {
    return null;
  }
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CSS = `
*{box-sizing:border-box}
body{margin:0;min-height:100vh;font:1.0625rem/1.6 'After Class Sans',system-ui,sans-serif;color:#1c1917;background:#2a2622;display:flex;align-items:center;justify-content:center;padding:24px 16px}
main{max-width:40rem;width:100%;background:#fafaf9;border:3px solid #1c1917;border-radius:10px;padding:32px 28px;box-shadow:0 8px 0 rgba(28,25,23,.35)}
h1,h2{font-family:'After Class Heading',system-ui,sans-serif;font-weight:400;line-height:1.5;margin:0 0 .75em;overflow-wrap:break-word}
h1{font-size:1.5rem}h2{font-size:1rem;margin-top:1.6em}
p,li{margin:0 0 .9em}ul{padding-left:1.2em;margin:0 0 .9em}
.lede{font-size:1.2rem}
.button{display:inline-block;background:#1d4ed8;color:#fff;text-decoration:none;font-weight:700;padding:12px 26px;border-radius:6px;border:2px solid #1c1917}
.button:hover,.button:focus-visible{background:#1e40af}
.muted{color:#6b6560;font-size:.95rem}
a{color:#1d4ed8}
nav{margin-top:1.6em}
@media (min-width:700px){body{background-image:var(--plate);background-position:50% 100%;background-size:cover;background-repeat:no-repeat;background-attachment:fixed}}
@media (max-width:480px){h1{font-size:1rem}main{padding:24px 18px}}
`;

function shell(title: string, description: string, canonical: string, files: Files, body: string): string {
  const fonts = [
    files.heading === null ? "" : `@font-face{font-family:'After Class Heading';src:url('${files.heading}') format('truetype');font-weight:400;font-display:swap}`,
    files.sans === null ? "" : `@font-face{font-family:'After Class Sans';src:url('${files.sans}') format('truetype');font-weight:400;font-display:swap}`,
  ].join("");
  const plate = files.plate === null ? "" : `:root{--plate:url('${files.plate}')}`;
  const preloads = [files.heading, files.sans].flatMap((f) => (f === null ? [] : [`<link rel="preload" href="${f}" as="font" type="font/ttf" crossorigin>`])).join("");
  const icons = [
    files.icon32 === null ? "" : `<link rel="icon" type="image/png" sizes="32x32" href="${files.icon32}">`,
    files.icon16 === null ? "" : `<link rel="icon" type="image/png" sizes="16x16" href="${files.icon16}">`,
    files.apple === null ? "" : `<link rel="apple-touch-icon" href="${files.apple}">`,
  ].join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<meta name="description" content="${escape(description)}">
<link rel="canonical" href="${escape(canonical)}">
<meta name="robots" content="index, follow">
${icons}${preloads}<style>${fonts}${plate}${CSS}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

function landing(origin: string, signIn: string, files: Files): string {
  return shell(
    "After Class: study YouTube lectures by explaining them",
    "After Class is a study companion for YouTube lectures. A Chrome extension captures what you watched, then a Socratic review asks you to explain it in your own words.",
    `${origin}/`,
    files,
    `<h1>After Class</h1>
<p class="lede">A study companion for YouTube lectures.</p>
<p>Watch a lecture as you normally would. The After Class Chrome extension captures what you watched, including the captions and the slides on screen. Afterward, a Socratic review asks you questions and has you explain the lecture in your own words.</p>
<h2>Invite-only beta</h2>
<p>After Class is in a private beta, and only invited people can sign up. To get in, ask the person who invited you.</p>
<p><a class="button" href="${escape(signIn)}">Sign in</a></p>
<nav class="muted"><a href="/privacy">Privacy</a></nav>`,
  );
}

function privacy(origin: string, signIn: string, files: Files): string {
  return shell(
    "After Class privacy",
    "What the After Class beta stores, who processes it, and how to delete it.",
    `${origin}/privacy`,
    files,
    `<h1>Privacy</h1>
<p>After Class is an invite-only beta. This page says what the beta stores and who processes it.</p>
<h2>What it stores</h2>
<ul>
<li>Your sign-in. After Class receives only the account id Clerk assigns you.</li>
<li>What the Chrome extension captures while you watch a lecture on YouTube: the captions, the frames of the video, and the intervals you watched.</li>
<li>Your reviews, with the questions asked, your answers, your notes and their edits.</li>
<li>A record of each AI call made for you, with its cost and its result, and the server's error logs.</li>
</ul>
<h2>Who processes it</h2>
<ul>
<li>Clerk runs sign-in with Google or email. It keeps your sign-in details and session, and sets cookies for them on the sign-in and app pages.</li>
<li>Anthropic, whose Claude model prepares each lecture for review and plays the tutor. It receives the captions and frames it needs, and your answers.</li>
<li>TypeSafe, which runs Jev. Jev answers short yes or no questions about the lecture, such as where one topic ends and whether the evidence supports a claim, and it can receive captions and frames for them.</li>
<li>Your browser, if you answer by voice. The microphone button uses the browser's own speech recognition, which in Chrome can send the audio to Google. After Class receives only the recognized text.</li>
<li>Amazon Web Services. The server and its database run in the us-east-2 region (Ohio). A daily snapshot of the disk keeps the last 7, and server logs are kept for 14 days.</li>
</ul>
<h2>The Chrome extension</h2>
<ul>
<li>It reads YouTube pages only. It captures captions, frames and watched intervals only after you press Start, and stops when you pause or stop capture, when the video ends, or when the tab leaves a YouTube watch page.</li>
<li>It uses Chrome's tab access to know which tab is capturing and to open the app, and its storage to hold captured data until the server has it. It sends that data only to ${escape(origin)}.</li>
<li>It reads no other sites and no browsing history, and it runs no code downloaded from elsewhere.</li>
</ul>
<h2>How long it keeps it</h2>
<p>Captured captions and frames are deleted after 30 days, except what a saved review cites, which stays until you delete it.</p>
<h2>How it is used</h2>
<p>Your data is used only to prepare your lectures and run your reviews. It is not sold, not used for advertising, and not shared with anyone beyond the processors above. Its use of data from Chrome extension APIs follows the Chrome Web Store User Data Policy, including the Limited Use requirements.</p>
<h2>Deleting</h2>
<p>Deleting a note in the app hides it, but the database keeps its text. Deleting a piece of captured evidence removes its frames from the server and from your reviews, but the database keeps its caption text and the AI results made from it. Backup copies can remain until the snapshots containing them rotate out. Full erasure of your data is not built yet.</p>
<h2>This site</h2>
<p>This page and the home page run no script and load nothing from another site.</p>
<nav><a href="/">Back to the home page</a> <span class="muted">&middot;</span> <a href="${escape(signIn)}">Sign in</a></nav>`,
  );
}

export function publicPage(page: PublicPage, origin: string, signIn: string, appDir: string): string {
  const files = appFiles(appDir);
  return page === "landing" ? landing(origin, signIn, files) : privacy(origin, signIn, files);
}
