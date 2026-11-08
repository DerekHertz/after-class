/**
 * The set labeling sheet's page: bundled by scripts/jev-lab-set-sheet.ts into index.html. Vanilla DOM, no network.
 * Everything that came from a transcript, a title, a note or a model's reason is set with textContent or setAttribute,
 * never as markup. What the labels mean and how they are exported is in jev-lab-set-client.ts.
 *
 * A clip's section is built the first time it is opened (its rows, its frames' <img> elements and its cards), so the
 * page opens with 11 headers and one clip, not 400 frames. State changes re-render only the clips that are built.
 */
import { fmtTime, watchUrl } from "./jev-lab-sheet-client";
import { BOUNDARY_TOLERANCE_S, FRAME_FILE, STEP_TOLERANCE_S, agreementOf, disagreements, evaluate, initialState, isMarked, labelJson, makeGroup, placeOf, proposalsLabel, removeItem, removeMember, restoreState, setNote, setSignature, setStatus, storageKey, toggleMark, } from "./jev-lab-set-client";
import type { Group, ItemKey, Mark, Member, SetClip, SetData, SetState, Status } from "./jev-lab-set-client";

type Child = Node | string | null | false;
type Attrs = Record<string, string | number | boolean | undefined>;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== false) el.append(kid);
  return el;
}

function button(label: string, onClick: () => void, attrs: Attrs = {}): HTMLButtonElement {
  const b = h("button", { type: "button", ...attrs }, label);
  b.addEventListener("click", onClick);
  return b;
}

const VISUAL_STEP_RULE = "A visual step is when the actual slide content changes (new text or a new figure shown on screen). The same slide staying up across several transcript passages is not a new step.";

const data = JSON.parse(document.getElementById("sheet-data")!.textContent ?? "null") as SetData;
const { draft, clips, split, proposals } = data;
const captureId = draft.lecture.captureId;
const order = clips.map((c) => c.videoId);
const clipIndex = new Map(order.map((v, i) => [v, i] as const));
const clipOf = (videoId: string): SetClip => clips[clipIndex.get(videoId) ?? 0]!;
const clipNo = (videoId: string) => (clipIndex.get(videoId) ?? 0) + 1;
const KEY = storageKey(captureId, data.inputHash);
const modelCount = proposals.length;
const frameById = new Map(clips.flatMap((c) => c.frames.map((f) => [f.id, { ...f, videoId: c.videoId }] as const)));
const imgSrc = (file: string): string | undefined => (FRAME_FILE.test(file) ? file : undefined);

// ───────────────────────────── state and storage ─────────────────────────────

let storageOk = true;
function readSaved(): SetState | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? null : restoreState(JSON.parse(raw));
  } catch {
    storageOk = false;
    return null;
  }
}
function writeSaved(s: SetState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
    storageOk = true;
  } catch {
    storageOk = false;
  }
}
function clearSaved(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    storageOk = false;
  }
}

const saved = readSaved();
let state: SetState = saved ?? initialState(draft, proposals);
const selected = new Map<string, Member>();
let onlyDisagreements = false;
let query = "";

// ───────────────────────────── header, the rules, the split ─────────────────────────────

const app = document.getElementById("app")!;
const watchLink = (videoId: string, t: number, text = `Watch at ${fmtTime(t)} on YouTube`) => h("a", { href: watchUrl(videoId, t), target: "_blank", rel: "noopener noreferrer", class: "watch" }, text);
const storageNote = h("p", { class: "note", role: "status" });
const restoredNote = saved === null ? null : h("p", { class: "note" }, "Your earlier work in this browser was restored. \"Reset to the draft\" discards it.");

const totalWatched = clips.reduce((a, c) => a + c.watchedS, 0);
const firstHalf = clips.filter((c) => c.half === "first");
const secondHalf = clips.filter((c) => c.half === "second");
const rangeText = (list: readonly SetClip[]) => (list.length === 0 ? "none" : list.length === 1 ? `clip ${clipNo(list[0]!.videoId)}` : `clips ${clipNo(list[0]!.videoId)} to ${clipNo(list.at(-1)!.videoId)}`);
const secs = (n: number) => `${Number(n.toFixed(1))} s`;

const splitBox = h("div", { class: "split" });
if (split.kind === "join") {
  splitBox.append(
    h("p", {}, h("strong", {}, `The split is at the join before clip ${split.joinIndex + 1}. `),
      `The lab totals the watched seconds of every clip (${secs(totalWatched)}), takes half of that (${secs(split.midpointS)}), and splits at the clip join nearest to it: ${secs(split.beforeS)} watched before the join and ${secs(split.afterS)} after. No clip is cut.`),
    h("p", {}, h("strong", {}, `Tuning half (${rangeText(firstHalf)}). `), "The lab may look at these clips, and at your labels for them, while it adjusts the segmentation settings and Jev's thresholds. It may do that in up to 3 rounds."),
    h("p", {}, h("strong", {}, `Held-out half (${rangeText(secondHalf)}). `), "The lab scores these clips once, at the end, after all tuning is finished, and never tunes on them. They measure whether the settings work on clips they were not tuned on."),
    h("p", { class: "meta" }, "Label both halves with the same care. The split join itself starts the held-out half and has nothing before it in that half, so a boundary label there cannot be detected; the lab leaves it out of the recall count, and it is harmless to confirm it. You have not seen any Jev output."),
  );
} else {
  splitBox.append(
    h("p", {}, h("strong", {}, `One clip, split at the midpoint of its labeled span: ${fmtTime(split.midpointS)} (${split.midpointS} s). `), "Before it is the tuning half. After it is the held-out half, scored once."),
  );
}

const proposalMeta = proposals.map((p) =>
  h("li", {}, `${p.origin === "fixture" ? "FIXTURE, not a model: " : ""}${p.proposedBy.model} (effort ${p.proposedBy.effort}), made ${p.createdAt}. ${p.provenance === null ? "No provenance recorded." : `Provenance: ${p.provenance}${/[.!?]$/.test(p.provenance) ? "" : "."}`} It proposed ${p.items.boundaries.length} boundaries, ${p.items.visualSteps.length} visual steps and ${p.items.duplicateGroups.length} duplicate groups.`),
);

app.append(
  h("a", { class: "skip", href: "#export" }, "Skip to the export"),
  h("header", {},
    h("h1", {}, `Labeling sheet: a set of ${clips.length} clip${clips.length === 1 ? "" : "s"}`),
    h("p", { class: "meta" }, `Capture ${captureId}. ${clips.length} clips in watch order, ${secs(totalWatched)} watched in all. Times are media seconds of each clip. Nothing here is sent anywhere.`),
    h("div", { class: "rule", role: "note" },
      h("p", {}, h("strong", {}, "Derek's rule for a visual step (verbatim)")),
      h("p", {}, VISUAL_STEP_RULE),
      h("p", {}, h("strong", {}, "Boundaries are the joins between clips. "), "The product's rule is that a video ending does not close a topic and the next clip's first window decides, so every join is a candidate. There are no boundaries inside a clip unless you mark one."),
    ),
    splitBox,
    proposals.length === 0 ? null : h("div", {}, h("p", { class: "meta" }, "Model proposals are suggestions only. None is confirmed until you confirm it, and the export never says a model's proposal is yours until you do."), h("ul", { class: "meta" }, ...proposalMeta)),
    restoredNote,
    storageNote,
  ),
);

// ───────────────────────────── the toolbar ─────────────────────────────

const search = h("input", { type: "search", id: "search", placeholder: "Search the transcripts" });
const searchCount = h("span", { class: "meta", role: "status" });
const selectionText = h("span", { class: "meta", role: "status" });
const makeGroupBtn = button("Make group", () => {
  commit(makeGroup(state, [...selected.values()], order));
  clearSelection();
});
const clearSelBtn = button("Clear selection", clearSelection);
const onlyBox = h("input", { type: "checkbox", id: "only-dis" });
onlyBox.addEventListener("change", () => {
  onlyDisagreements = onlyBox.checked;
  // a clip is built when opened, so open every clip that holds a disagreement before filtering
  if (onlyDisagreements) {
    const ids = disagreementIds();
    for (const d of disagreements(state, modelCount).entries) if (ids.has(`${d.key}:${d.id}`)) setOpen(views[clipIndex.get(d.videoId) ?? 0]!, true);
  }
  applyFilters();
});
const nextBtn = button("Next unconfirmed", () => nextUnconfirmed());
const openAllBtn = button("Open all clips", () => {
  for (const v of views) setOpen(v, true);
});
const closeAllBtn = button("Close all clips", () => {
  for (const v of views) setOpen(v, false);
});
const resetBtn = button("Reset to the draft", () => {
  let ok = false;
  try {
    ok = window.confirm("Discard every mark, note and confirmation you made on this sheet and go back to the draft and the proposals?");
  } catch {
    ok = false;
  }
  if (!ok) return;
  clearSaved();
  state = initialState(draft, proposals);
  clearSelection();
  nameInput.value = "";
  dateInput.value = "";
  renderAll();
});

app.append(
  h("div", { class: "toolbar" },
    h("label", { for: "search" }, "Search"), search, searchCount,
    modelCount === 0 ? null : h("label", { class: "check" }, onlyBox, "Show only disagreements"),
    nextBtn, openAllBtn, closeAllBtn,
    h("span", { class: "sep" }), selectionText, makeGroupBtn, clearSelBtn,
    h("span", { class: "sep" }), resetBtn,
  ),
);

// ───────────────────────────── the clips table and the timeline of the whole set ─────────────────────────────

app.append(
  h("h2", {}, "The clips, in watch order"),
  h("table", { class: "clips-table" },
    h("thead", {}, h("tr", {}, ...["Clip", "Title", "Labeled span", "Watched", "Half"].map((t) => h("th", { scope: "col" }, t)))),
    h("tbody", {}, ...clips.map((c, i) =>
      h("tr", { class: `half-${c.half}` },
        h("td", {}, String(i + 1)), h("td", {}, c.title === "" ? c.videoId : c.title),
        h("td", {}, `${fmtTime(c.spanS.start)} to ${fmtTime(c.spanS.end)}`), h("td", {}, secs(c.watchedS)),
        h("td", {}, h("span", { class: "pill half" }, c.half === "first" ? "Tuning" : "Held-out")),
      ))),
  ),
);

const totalSpan = clips.reduce((a, c) => a + (c.spanS.end - c.spanS.start), 0);
const offsets = clips.map((_, i) => clips.slice(0, i).reduce((a, c) => a + (c.spanS.end - c.spanS.start), 0));
const pctAt = (videoId: string, t: number) => {
  const i = clipIndex.get(videoId) ?? 0;
  const c = clips[i]!;
  return Math.min(100, Math.max(0, ((offsets[i]! + Math.min(c.spanS.end, Math.max(c.spanS.start, t)) - c.spanS.start) / totalSpan) * 100));
};
const timeline = h("div", { class: "timeline", role: "group", "aria-label": "Timeline of the whole set" });
const markLayer = h("div", { class: "tl-marks" });
{
  const place = (cls: string, from: number, to: number) => {
    const d = h("div", { class: cls });
    d.style.left = `${from}%`;
    d.style.width = `${Math.max(0, to - from)}%`;
    return d;
  };
  const joinPct = split.kind === "join" ? pctAt(clips[split.joinIndex]!.videoId, clips[split.joinIndex]!.spanS.start) : null;
  if (joinPct !== null) timeline.append(place("tl-tune", 0, joinPct), place("tl-held", joinPct, 100));
  clips.forEach((c, i) => {
    for (const [a, b] of c.watched) {
      const w = h("div", { class: "tl-watched", title: `Clip ${i + 1}, watched ${fmtTime(a)} to ${fmtTime(b)}` });
      w.style.left = `${pctAt(c.videoId, a)}%`;
      w.style.width = `${Math.max(0.1, pctAt(c.videoId, b) - pctAt(c.videoId, a))}%`;
      timeline.append(w);
    }
    for (const f of c.frames) {
      const tick = h("div", { class: "tl-frame" });
      tick.style.left = `${pctAt(c.videoId, f.mediaS)}%`;
      timeline.append(tick);
    }
    if (i > 0) {
      const line = h("div", { class: i === split.joinIndex && split.kind === "join" ? "tl-clip tl-mid" : "tl-clip", title: i === split.joinIndex && split.kind === "join" ? `Split: the join before clip ${i + 1}` : `Join before clip ${i + 1}` });
      line.style.left = `${pctAt(c.videoId, c.spanS.start)}%`;
      timeline.append(line);
    }
    const no = h("span", { class: "tl-no" }, String(i + 1));
    no.style.left = `${pctAt(c.videoId, c.spanS.start)}%`;
    timeline.append(no);
  });
  if (joinPct !== null) {
    const l = h("span", { class: "tl-label" }, `split (before clip ${split.joinIndex + 1})`);
    l.style.left = `${joinPct}%`;
    timeline.append(l);
    const a = h("span", { class: "tl-label" }, "tuning");
    a.style.left = `${joinPct / 2}%`;
    const b = h("span", { class: "tl-label" }, "held-out");
    b.style.left = `${(100 + joinPct) / 2}%`;
    timeline.append(a, b);
  }
  timeline.addEventListener("click", (e) => {
    if (e.target !== timeline) return;
    const box = timeline.getBoundingClientRect();
    const at = ((e.clientX - box.left) / box.width) * totalSpan;
    let i = 0;
    offsets.forEach((o, k) => void (o <= at && (i = k)));
    const c = clips[i]!;
    jumpToTime(c.videoId, c.spanS.start + (at - offsets[i]!));
  });
  timeline.append(markLayer);
}
app.append(
  h("section", { "aria-label": "Timeline" },
    h("p", { class: "meta" }, "Timeline of the whole set, each clip as wide as its labeled span: green is watched time, small ticks are frames, thin lines are the joins between clips, the thick line is the split. B is a boundary, V a visual step, D a duplicate group. Faded means rejected, hollow means unconfirmed. Press a marker to jump to it."),
    timeline,
  ),
);

// ───────────────────────────── the disagreements panel ─────────────────────────────

const disPanel = h("section", { class: "dis-panel", "aria-label": "Disagreements between the models", id: "disagreements" });
if (modelCount > 0) app.append(disPanel);

const KIND_TEXT: Record<ItemKey, string> = { boundaries: "Boundary", visualSteps: "Visual step", groups: "Duplicate group" };
const STATUS_TEXT: Record<Status, string> = { unconfirmed: "Unconfirmed", confirmed: "Confirmed", rejected: "Rejected (left out of the export)" };
const cardId = (key: ItemKey, id: string) => `card-${key}-${id}`;

function renderDisagreements(): void {
  if (modelCount === 0) return;
  const { comparable, entries } = disagreements(state, modelCount);
  const names = proposals.map((p) => p.proposedBy.model);
  const line = (d: (typeof entries)[number]) =>
    h("li", {},
      button(`${KIND_TEXT[d.key]}, clip ${clipNo(d.videoId)} at ${fmtTime(d.mediaS)}`, () => jumpToCard(d.key, d.id), { class: "link-button" }),
      ` (${d.by.join(" and ")}; ${STATUS_TEXT[d.status].toLowerCase()})`,
    );
  const section = (title: string, list: typeof entries) => [h("h3", {}, `${title} (${list.length})`), list.length === 0 ? h("p", { class: "meta" }, "None.") : h("ul", { class: "dis-list" }, ...list.map(line))];
  const only = entries.filter((d) => d.agreement === "only");
  const both = entries.filter((d) => d.agreement === "both");
  const parts: Child[] = [
    h("h2", {}, "Disagreements between the models"),
    h("p", { class: "meta" }, `Boundaries count as the same when two models put them within ${BOUNDARY_TOLERANCE_S} s of each other in the same clip, and visual steps within ${STEP_TOLERANCE_S} s (PROPOSED tolerances, not adopted). Two duplicate groups are the same when they share at least 2 frames. Each model's item is one candidate; where both proposed it, it is one candidate with both reasons.`),
  ];
  if (!comparable) parts.push(h("p", { class: "note" }, `Only one proposals file was given (${names[0] ?? ""}), so there is nothing to compare. Its items are listed below as "only" that model.`));
  parts.push(h("p", {}, "Use \"Show only disagreements\" in the toolbar to see only the places where just one model proposed something."));
  for (const p of proposals) {
    const mine = entries.filter((d) => d.by.includes(proposalsLabel(p)));
    parts.push(h("p", { class: "meta" }, `${proposalsLabel(p)} proposed ${mine.length} item(s) in all.`));
  }
  if (comparable) {
    for (const p of proposals) {
      const label = proposalsLabel(p);
      parts.push(...section(`Only ${label} proposed`, only.filter((d) => d.by.length === 1 && d.by[0] === label)));
    }
    parts.push(...section("Both models proposed", both));
  } else parts.push(...section("Proposed by the one model", only));
  disPanel.replaceChildren(...parts.filter((x): x is Node | string => x !== null && x !== false));
}

// ───────────────────────────── the clips: lazily built sections ─────────────────────────────

type Row = { readonly t: number; readonly item: HTMLElement; readonly row: HTMLElement; readonly slot: HTMLElement; readonly text?: string; readonly boundaryBtn?: HTMLButtonElement; readonly stepBtn?: HTMLButtonElement };
type View = {
  readonly clip: SetClip;
  readonly index: number;
  readonly wrap: HTMLElement;
  readonly body: HTMLElement;
  readonly toggle: HTMLButtonElement;
  readonly summary: HTMLElement;
  readonly joinBtn: HTMLButtonElement | null;
  readonly joinSlot: HTMLElement;
  readonly stray: HTMLElement;
  built: boolean;
  open: boolean;
  entries: Row[];
};

const dialog = h("dialog", { class: "lightbox", "aria-label": "Frame" });
const bigImg = h("img", { alt: "" });
const bigCaption = h("p", {});
dialog.append(bigImg, bigCaption, h("form", { method: "dialog" }, h("button", { type: "submit" }, "Close")));
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) dialog.close();
});

const frameCheckboxes = new Map<string, HTMLInputElement>();
const views: View[] = [];

function openFrame(frameId: string): void {
  const f = frameById.get(frameId);
  if (f === undefined) return;
  const src = imgSrc(f.file);
  if (src !== undefined) bigImg.src = src;
  bigCaption.textContent = `Frame ${f.id}, clip ${clipNo(f.videoId)} at ${fmtTime(f.mediaS)} (${f.mediaS} s)`;
  dialog.showModal();
}

function buildClip(v: View): void {
  if (v.built) return;
  v.built = true;
  const { clip } = v;
  for (const p of clip.passages) {
    const slot = h("div", { class: "slot" });
    const boundaryBtn = button("Boundary here", () => commit(toggleMark(state, "boundaries", clip.videoId, p.start, order)), { "aria-pressed": "false" });
    const row = h("div", { class: "row passage", tabindex: -1 },
      h("span", { class: "time" }, fmtTime(p.start)),
      h("p", { class: "text" }, p.text),
      h("div", { class: "actions" }, boundaryBtn, watchLink(clip.videoId, p.start)),
    );
    v.entries.push({ t: p.start, item: h("div", { class: "item" }, row, slot), row, slot, text: p.text.toLowerCase(), boundaryBtn });
  }
  for (const f of clip.frames) {
    const slot = h("div", { class: "slot" });
    const stepBtn = button("Visual step", () => commit(toggleMark(state, "visualSteps", clip.videoId, f.mediaS, order)), { "aria-pressed": "false" });
    const box = h("input", { type: "checkbox" });
    const member: Member = { videoId: clip.videoId, mediaS: f.mediaS, frameId: f.id };
    box.checked = selected.has(f.id);
    box.addEventListener("change", () => {
      if (box.checked) selected.set(f.id, member);
      else selected.delete(f.id);
      renderSelection();
    });
    frameCheckboxes.set(f.id, box);
    const thumb = button("", () => openFrame(f.id), { class: "thumb", "aria-label": `Enlarge the frame at ${fmtTime(f.mediaS)}` });
    thumb.append(h("img", { src: imgSrc(f.file), alt: "", width: 160, loading: "lazy", decoding: "async" }));
    const row = h("div", { class: "row frame", tabindex: -1 },
      thumb,
      h("div", { class: "frame-meta" },
        h("span", { class: "time" }, fmtTime(f.mediaS)),
        h("span", { class: "meta" }, `Frame ${f.id}, ${f.width} x ${f.height}`),
        h("div", { class: "actions" }, stepBtn, h("label", { class: "check" }, box, "Select for duplicate group"), watchLink(clip.videoId, f.mediaS)),
      ),
    );
    v.entries.push({ t: f.mediaS, item: h("div", { class: "item" }, row, slot), row, slot, stepBtn });
  }
  v.entries.sort((a, b) => a.t - b.t);
  v.body.append(v.stray, ...v.entries.map((e) => e.item));
  if (v.entries.length === 0) v.body.append(h("p", {}, "This capture holds no caption passages or frames for this clip."));
}

function setOpen(v: View, open: boolean): void {
  if (open) buildClip(v);
  v.open = open;
  v.body.hidden = !open;
  v.toggle.setAttribute("aria-expanded", String(open));
  v.toggle.textContent = `${open ? "Close" : "Open"} clip ${v.index + 1}`;
  if (open) renderAll();
}

function slotFor(v: View, t: number): HTMLElement {
  let found: Row | undefined;
  for (const e of v.entries) if (e.t <= t + 1e-6) found = e;
  return found?.slot ?? v.entries[0]?.slot ?? v.stray;
}

clips.forEach((clip, index) => {
  const body = h("div", { class: "clip-body", hidden: true });
  const toggle = h("button", { type: "button", "aria-expanded": "false", class: "clip-toggle" }, `Open clip ${index + 1}`);
  const summary = h("span", { class: "meta" });
  const joinSlot = h("div", { class: "slot" });
  const isSplit = split.kind === "join" && index === split.joinIndex;
  const joinBtn = index === 0 ? null : button("Boundary at this join", () => commit(toggleMark(state, "boundaries", clip.videoId, clip.spanS.start, order)), { "aria-pressed": "false" });
  const join = index === 0 ? null : h("div", { class: `join${isSplit ? " is-split" : ""}` },
    h("p", {}, h("strong", {}, `Join: clip ${index} ends, clip ${index + 1} starts. `), "The next clip's first window decides whether a topic starts here, so this join is a boundary candidate. Mark it if the lecturer moves to a new topic when this clip starts."),
    isSplit ? h("p", {}, h("strong", {}, "SPLIT. "), `Above this line is the tuning half, below it the held-out half. This join starts the held-out half, so the lab cannot detect a boundary here and leaves it out of the recall count.`) : null,
    h("div", { class: "actions" }, joinBtn, watchLink(clip.videoId, clip.spanS.start, `Watch clip ${index + 1} from the start on YouTube`)),
  );
  const wrap = h("div", { class: `clipwrap half-${clip.half}`, id: `clip-${index + 1}` },
    join, join === null ? null : joinSlot,
    h("div", { class: "clip-head" },
      h("h2", {}, `Clip ${index + 1}: ${clip.title === "" ? clip.videoId : clip.title}`),
      h("span", { class: "pill half" }, clip.half === "first" ? "Tuning half" : "Held-out half"),
      h("span", { class: "meta" }, `${clip.videoId}. Span ${fmtTime(clip.spanS.start)} to ${fmtTime(clip.spanS.end)}, ${secs(clip.watchedS)} watched, ${clip.passages.length} caption passages, ${clip.frames.length} frames.`),
      toggle, summary,
    ),
    body,
  );
  const v: View = { clip, index, wrap, body, toggle, summary, joinBtn, joinSlot, stray: h("div", { class: "slot" }), built: false, open: false, entries: [] };
  toggle.addEventListener("click", () => setOpen(v, !v.open));
  views.push(v);
});
app.append(h("h2", {}, "Transcript and frames, clip by clip"), h("p", { class: "meta" }, "A clip's transcript and frames are loaded when you open it. Opening is also how you reach a candidate in it: the header shows how many candidates are still unconfirmed."), ...views.map((v) => v.wrap), dialog);

// ───────────────────────────── searching, filtering, jumping ─────────────────────────────

const isDisagreementCard = (key: ItemKey, id: string, byId: ReadonlySet<string>) => byId.has(`${key}:${id}`);

function disagreementIds(): ReadonlySet<string> {
  if (modelCount < 2) return new Set();
  return new Set(disagreements(state, modelCount).entries.filter((d) => d.agreement === "only").map((d) => `${d.key}:${d.id}`));
}

function applyFilters(): void {
  const q = query;
  let shownPassages = 0;
  let total = 0;
  for (const v of views) {
    for (const e of v.entries) {
      if (e.text === undefined) continue;
      total++;
      const hit = q === "" || e.text.includes(q);
      if (hit) shownPassages++;
      e.row.hidden = !hit;
    }
    if (!v.built) total += v.clip.passages.length;
    if (onlyDisagreements) {
      for (const e of v.entries) e.item.hidden = e.slot.querySelector('[data-disagreement="1"]') === null;
      v.stray.hidden = false;
    } else for (const e of v.entries) e.item.hidden = false;
    v.wrap.hidden = onlyDisagreements && v.wrap.querySelector('[data-disagreement="1"]') === null;
  }
  searchCount.textContent = q === "" ? "" : `${shownPassages} of ${total} passages match in the clips that are open`;
}

search.addEventListener("input", () => {
  query = search.value.trim().toLowerCase();
  if (query !== "") for (const v of views) if (v.clip.passages.some((p) => p.text.toLowerCase().includes(query))) setOpen(v, true);
  applyFilters();
});

function scrollTarget(el: HTMLElement | null | undefined): void {
  el?.scrollIntoView({ block: "center" });
  el?.querySelector<HTMLElement>("button, input")?.focus({ preventScroll: true });
}

function jumpToTime(videoId: string, t: number): void {
  const v = views[clipIndex.get(videoId) ?? 0]!;
  setOpen(v, true);
  let target: Row | undefined = v.entries[0];
  for (const e of v.entries) if (e.t <= t + 1e-6) target = e;
  const el = target?.row ?? v.wrap;
  el.scrollIntoView({ block: "center" });
  el.focus?.({ preventScroll: true });
}

function jumpToCard(key: ItemKey, id: string): void {
  const item = (state[key] as readonly (Mark | Group)[]).find((x) => x.id === id);
  if (item === undefined) return;
  const at = placeOf(item, order);
  const v = views[clipIndex.get(at.videoId) ?? 0]!;
  if (onlyDisagreements && !disagreementIds().has(`${key}:${id}`)) {
    onlyDisagreements = false;
    onlyBox.checked = false;
  }
  setOpen(v, true);
  applyFilters();
  scrollTarget(document.getElementById(cardId(key, id)));
}

let nextCursor = -1;
function nextUnconfirmed(): void {
  const all: { key: ItemKey; id: string; videoId: string; t: number }[] = [];
  const add = (key: ItemKey, list: readonly (Mark | Group)[]) => {
    for (const x of list) if (x.status === "unconfirmed") all.push({ key, id: x.id, ...(({ videoId, mediaS }) => ({ videoId, t: mediaS }))(placeOf(x, order)) });
  };
  add("boundaries", state.boundaries);
  add("visualSteps", state.visualSteps);
  add("groups", state.groups);
  all.sort((a, b) => (clipIndex.get(a.videoId) ?? 0) - (clipIndex.get(b.videoId) ?? 0) || a.t - b.t);
  if (all.length === 0) {
    nextBtn.textContent = "Nothing unconfirmed";
    return;
  }
  nextCursor = (nextCursor + 1) % all.length;
  const pick = all[nextCursor]!;
  jumpToCard(pick.key, pick.id);
}

function clearSelection(): void {
  selected.clear();
  for (const box of frameCheckboxes.values()) box.checked = false;
  renderSelection();
}
function renderSelection(): void {
  const clipsIn = [...new Set([...selected.values()].map((m) => clipNo(m.videoId)))].sort((a, b) => a - b);
  selectionText.textContent = `${selected.size} frame(s) selected for a duplicate group${clipsIn.length > 0 ? ` (clip ${clipsIn.join(", ")})` : ""}`;
  makeGroupBtn.disabled = selected.size < 2;
  clearSelBtn.disabled = selected.size === 0;
}

// ───────────────────────────── cards ─────────────────────────────

function proposersBlock(item: Mark | Group): HTMLElement | null {
  if (item.proposers.length === 0) return null;
  const who = agreementOf(item.proposers) === "both" ? "both" : "only";
  const names = [...new Set(item.proposers.map((p) => p.label))];
  return h("div", {},
    h("p", { class: "card-head" },
      h("span", { class: `who ${who}` }, who === "both" ? `Proposed by both: ${names.join(" and ")}` : `Proposed by ${names[0]} only`),
      modelCount >= 2 ? h("span", { class: "meta" }, who === "both" ? "the models agree here" : "the other model did not propose this") : null,
    ),
    h("ul", { class: "proposers" }, ...item.proposers.map((p) => h("li", {}, h("strong", {}, `${p.label} (effort ${p.effort})${p.source === "join" ? ", clip join" : ""}: `), p.reason))),
  );
}

function card(key: ItemKey, item: Mark | Group, dis: ReadonlySet<string>): HTMLElement {
  const at = placeOf(item, order);
  const focusKey = (part: string) => `${key}:${item.id}:${part}`;
  const where = `clip ${clipNo(at.videoId)} at ${fmtTime(at.mediaS)}`;
  const note = h("input", { type: "text", value: item.note, "aria-label": `Note for the ${KIND_TEXT[key].toLowerCase()} at ${where}` });
  note.addEventListener("input", () => {
    state = setNote(state, key, item.id, note.value);
    writeSaved(state);
    renderExport();
  });
  const actions = h("div", { class: "actions" });
  if (item.origin !== "user") {
    actions.append(
      button("Confirm", () => commit(setStatus(state, key, item.id, item.status === "confirmed" ? "unconfirmed" : "confirmed")), { "aria-pressed": String(item.status === "confirmed"), "data-focus": focusKey("confirm") }),
      button("Reject", () => commit(setStatus(state, key, item.id, item.status === "rejected" ? "unconfirmed" : "rejected")), { "aria-pressed": String(item.status === "rejected"), "data-focus": focusKey("reject") }),
    );
  } else actions.append(button(key === "groups" ? "Ungroup" : "Remove", () => commit(removeItem(state, key, item.id)), { "data-focus": focusKey("remove") }));
  actions.append(watchLink(at.videoId, at.mediaS));

  const isDis = isDisagreementCard(key, item.id, dis);
  const from = item.origin === "user" ? "added by you" : item.origin === "proposal" ? "proposed by a model" : item.proposers.length > 0 ? "candidate from the draft, also proposed by a model" : "candidate from the draft";
  const el = h("div", { class: `card ${key} ${item.status}${isDis ? " is-disagreement" : ""}`, id: cardId(key, item.id), "data-disagreement": isDis ? "1" : undefined },
    h("p", { class: "card-head" },
      h("strong", {}, `${KIND_TEXT[key]} at ${where}`),
      h("span", { class: "pill" }, STATUS_TEXT[item.status]),
      h("span", { class: "meta" }, from),
    ),
    item.cue === undefined ? null : h("p", { class: "cue" }, `Why the draft suggested it: ${item.cue}`),
    proposersBlock(item),
    h("label", { class: "note-label" }, "Note ", note),
  );
  if ("frames" in item) {
    const thumbs = h("ul", { class: "members" });
    item.frames.forEach((m, i) => {
      const f = (m.frameId !== undefined ? frameById.get(m.frameId) : undefined) ?? clipOf(m.videoId).frames.find((x) => Math.abs(x.mediaS - m.mediaS) < 0.5);
      const src = f === undefined ? undefined : imgSrc(f.file);
      thumbs.append(h("li", {},
        src === undefined ? null : h("img", { src, alt: "", width: 96, loading: "lazy", decoding: "async" }),
        h("span", { class: "clipno" }, `clip ${clipNo(m.videoId)}`),
        h("span", {}, `${fmtTime(m.mediaS)}${i === 0 ? " (the original)" : ""}`),
        button("Remove from group", () => commit(removeMember(state, item.id, i)), { "aria-label": `Remove the frame of clip ${clipNo(m.videoId)} at ${fmtTime(m.mediaS)} from this group` }),
      ));
    });
    el.append(thumbs);
  }
  el.append(actions);
  return el;
}

const isJoinBoundary = (key: ItemKey, item: Mark | Group, v: View): boolean => key === "boundaries" && v.index > 0 && "mediaS" in item && Math.abs(item.mediaS - v.clip.spanS.start) < 1e-6;

function renderCards(): void {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.focus : undefined;
  const dis = disagreementIds();
  for (const v of views) {
    for (const e of v.entries) e.slot.replaceChildren();
    v.stray.replaceChildren();
    v.joinSlot.replaceChildren();
  }
  const all: { at: { videoId: string; mediaS: number }; order: number; key: ItemKey; item: Mark | Group }[] = [];
  state.boundaries.forEach((m) => all.push({ at: m, order: 0, key: "boundaries", item: m }));
  state.visualSteps.forEach((m) => all.push({ at: m, order: 1, key: "visualSteps", item: m }));
  state.groups.forEach((g) => all.push({ at: placeOf(g, order), order: 2, key: "groups", item: g }));
  all.sort((a, b) => (clipIndex.get(a.at.videoId) ?? 0) - (clipIndex.get(b.at.videoId) ?? 0) || a.at.mediaS - b.at.mediaS || a.order - b.order);
  for (const c of all) {
    const v = views[clipIndex.get(c.at.videoId) ?? -1];
    if (v === undefined) continue;
    if (isJoinBoundary(c.key, c.item, v)) v.joinSlot.append(card(c.key, c.item, dis));
    else if (v.built) slotFor(v, c.at.mediaS).append(card(c.key, c.item, dis));
  }
  if (active !== undefined) document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(active)}"]`)?.focus({ preventScroll: true });
}

function renderRowButtons(): void {
  for (const v of views) {
    for (const e of v.entries) {
      e.boundaryBtn?.setAttribute("aria-pressed", String(isMarked(state, "boundaries", v.clip.videoId, e.t)));
      e.stepBtn?.setAttribute("aria-pressed", String(isMarked(state, "visualSteps", v.clip.videoId, e.t)));
    }
    v.joinBtn?.setAttribute("aria-pressed", String(isMarked(state, "boundaries", v.clip.videoId, v.clip.spanS.start)));
  }
}

function renderSummaries(): void {
  for (const v of views) {
    const mine = (list: readonly (Mark | Group)[]) => list.filter((x) => placeOf(x, order).videoId === v.clip.videoId);
    const items = [...mine(state.boundaries), ...mine(state.visualSteps), ...mine(state.groups)];
    const count = (s: Status) => items.filter((x) => x.status === s).length;
    v.summary.textContent = `Candidates and marks here: ${count("unconfirmed")} unconfirmed, ${count("confirmed")} confirmed, ${count("rejected")} rejected.`;
  }
}

function renderTimeline(): void {
  markLayer.replaceChildren();
  const put = (key: ItemKey, item: Mark | Group, letter: string, lane: number) => {
    const at = placeOf(item, order);
    const b = button(letter, () => jumpToCard(key, item.id), { class: `tl-mark ${item.status}`, "aria-label": `${KIND_TEXT[key]} at clip ${clipNo(at.videoId)} ${fmtTime(at.mediaS)}, ${STATUS_TEXT[item.status].toLowerCase()}`, title: `${KIND_TEXT[key]}, clip ${clipNo(at.videoId)} at ${fmtTime(at.mediaS)}: ${item.status}` });
    b.style.left = `calc(${pctAt(at.videoId, at.mediaS)}% - 9px)`;
    b.style.top = `${lane * 20 + 14}px`;
    markLayer.append(b);
  };
  state.boundaries.forEach((m) => put("boundaries", m, "B", 0));
  state.visualSteps.forEach((m) => put("visualSteps", m, "V", 1));
  state.groups.forEach((g) => put("groups", g, "D", 2));
}

// ───────────────────────────── the export ─────────────────────────────

const nameInput = h("input", { type: "text", id: "signer", autocomplete: "off" });
const dateInput = h("input", { type: "text", id: "signdate", placeholder: "YYYY-MM-DD", autocomplete: "off" });
nameInput.value = state.signedOffBy;
dateInput.value = state.signedOffAt;
const onSign = () => {
  state = setSignature(state, nameInput.value, dateInput.value);
  writeSaved(state);
  renderExport();
};
nameInput.addEventListener("input", onSign);
dateInput.addEventListener("input", onSign);

const exportStatus = h("p", { class: "export-status", role: "status" });
const blockerList = h("ul", { class: "blockers" });
const warningList = h("ul", { class: "warnings" });
const countsText = h("p", { class: "meta" });
const out = h("textarea", { id: "export-json", readonly: true, rows: 22, spellcheck: false, "aria-label": "Label file JSON for the set" });
const copyResult = h("span", { class: "meta", role: "status" });
const FILE_NAME = "labels-set.json";

function copy(): void {
  const text = out.value;
  const fallback = () => {
    out.focus();
    out.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    copyResult.textContent = ok ? "Copied." : "Copy failed: select the text above and copy it yourself.";
  };
  if (navigator.clipboard === undefined) return fallback();
  navigator.clipboard.writeText(text).then(() => void (copyResult.textContent = "Copied."), fallback);
}

function download(): void {
  const url = URL.createObjectURL(new Blob([out.value], { type: "application/json" }));
  const a = h("a", { download: FILE_NAME });
  a.href = url;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  copyResult.textContent = `Download of ${FILE_NAME} started.`;
}

app.append(
  h("section", { id: "export", class: "export", tabindex: -1 },
    h("h2", {}, "Export"),
    h("p", {}, "Sign-off block. Only you can sign off: type your name and the date. Until you do, and until every item is confirmed or rejected, the export is a draft. A model's proposal is in the file only if you confirmed it."),
    h("div", { class: "signoff" },
      h("label", { for: "signer" }, "Your name"), nameInput,
      h("label", { for: "signdate" }, "Date"), dateInput,
    ),
    exportStatus,
    h("p", {}, "What blocks sign-off:"),
    blockerList, warningList, countsText,
    out,
    h("div", { class: "actions" }, button("Copy", copy), button(`Download ${FILE_NAME}`, download), copyResult),
    h("p", { class: "meta" }, `Save the file anywhere (for example docs/experiments/labels/${FILE_NAME}), then check it with: bun run scripts/jev-lab.ts split --data <the data dir> --labels <file>`),
  ),
);

const MAX_BLOCKERS = 30;
function renderExport(): void {
  const result = evaluate(state, draft);
  exportStatus.textContent = result.labels.status === "signed_off"
    ? `The export is SIGNED OFF by ${result.labels.signedOffBy} on ${result.labels.signedOffAt}. Nothing blocks it.`
    : `The export is a DRAFT (status "draft", no name or date) because of ${result.blockers.length} thing(s) below.`;
  exportStatus.className = `export-status ${result.labels.status}`;
  const shown = result.blockers.slice(0, MAX_BLOCKERS).map((b) => h("li", {}, b.message));
  if (result.blockers.length > MAX_BLOCKERS) shown.push(h("li", {}, `... and ${result.blockers.length - MAX_BLOCKERS} more`));
  blockerList.replaceChildren(...(result.blockers.length === 0 ? [h("li", {}, "Nothing blocks sign-off.")] : shown));
  warningList.replaceChildren(...result.warnings.map((w) => h("li", {}, w)));
  const count = (list: readonly { readonly status: Status }[]) => `${list.filter((x) => x.status === "confirmed").length} confirmed, ${list.filter((x) => x.status === "unconfirmed").length} unconfirmed, ${list.filter((x) => x.status === "rejected").length} rejected`;
  countsText.textContent = `Boundaries: ${count(state.boundaries)}. Visual steps: ${count(state.visualSteps)}. Duplicate groups: ${count(state.groups)}.`;
  const json = labelJson(result.labels);
  if (out.value !== json) out.value = json;
  storageNote.textContent = storageOk ? "" : "This browser blocked saving, so your work lives only in this tab. Download the JSON before you close it.";
}

function renderAll(): void {
  renderCards();
  renderRowButtons();
  renderSummaries();
  renderTimeline();
  renderDisagreements();
  renderExport();
  applyFilters();
}

function commit(next: SetState): void {
  state = next;
  writeSaved(state);
  renderAll();
}

setOpen(views[0]!, true);
renderSelection();
renderAll();
