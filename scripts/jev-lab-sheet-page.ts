/**
 * The labeling sheet's page: bundled by scripts/jev-lab-sheet.ts into each lecture's HTML. Vanilla DOM, no network.
 * Everything that came from a transcript or a title is set with textContent or setAttribute, never as markup.
 * What the labels mean and how they are exported is in jev-lab-sheet-client.ts.
 */
import { evaluate, fmtTime, initialState, isMarked, labelJson, makeGroup, midpointOf, removeItem, removeMember, restoreState, setNote, setSignature, setStatus, storageKey, toggleMark, watchUrl } from "./jev-lab-sheet-client";
import type { Group, ItemKey, Mark, SheetData, SheetState, Status } from "./jev-lab-sheet-client";

type Child = Node | string | null | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | number | boolean | undefined> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== false) el.append(kid);
  return el;
}

function button(label: string, onClick: () => void, attrs: Record<string, string | number | boolean | undefined> = {}): HTMLButtonElement {
  const b = h("button", { type: "button", ...attrs }, label);
  b.addEventListener("click", onClick);
  return b;
}

const data = JSON.parse(document.getElementById("sheet-data")!.textContent ?? "null") as SheetData;
const { draft, videoId } = data;
const span = draft.lecture.spanS;
const midpoint = midpointOf(span);
const KEY = storageKey(draft, data.draftHash);

// ───────────────────────────── state and storage ─────────────────────────────

let storageOk = true;
function readSaved(): SheetState | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? null : restoreState(JSON.parse(raw));
  } catch {
    storageOk = false;
    return null;
  }
}
function writeSaved(s: SheetState): void {
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
let state: SheetState = saved ?? initialState(draft);
const selected = new Map<string, { readonly mediaS: number; readonly frameId: string }>();

// ───────────────────────────── layout ─────────────────────────────

const app = document.getElementById("app")!;
const watchLink = (t: number, text = `Watch at ${fmtTime(t)} on YouTube`) => h("a", { href: watchUrl(videoId, t), target: "_blank", rel: "noopener noreferrer", class: "watch" }, text);

const storageNote = h("p", { class: "note", role: "status" });
const restoredNote = saved === null ? null : h("p", { class: "note" }, "Your earlier work in this browser was restored. \"Reset to the draft\" discards it.");

app.append(
  h("a", { class: "skip", href: "#export" }, "Skip to the export"),
  h("header", {},
    h("h1", {}, draft.lecture.title ?? videoId),
    h("p", { class: "meta" }, `Video ${videoId}. Capture ${draft.lecture.captureId}. Labeled span ${fmtTime(span.start)} to ${fmtTime(span.end)} (${span.start} to ${span.end} s), ${data.passages.length} caption passages and ${data.frames.length} frames.`),
    h("p", { class: "split" },
      h("strong", {}, `Split midpoint: ${fmtTime(midpoint)} (${midpoint} s). `),
      "Before it is the tuning half. After it is the held-out half, scored once. Label honestly across the whole lecture: you have not seen any Jev output.",
    ),
    h("p", { class: "meta" }, "Times are media seconds of the video. Mark what you judge to be true from the transcript and the frames, and write a note when it helps you later. Nothing here is sent anywhere."),
    restoredNote,
    storageNote,
  ),
);

const search = h("input", { type: "search", id: "search", placeholder: "Search the transcript" });
const searchCount = h("span", { class: "meta", role: "status" });
const selectionText = h("span", { class: "meta", role: "status" });
const makeGroupBtn = button("Make group", () => {
  commit(makeGroup(state, [...selected.values()]));
  clearSelection();
});
const clearSelBtn = button("Clear selection", clearSelection);
const resetBtn = button("Reset to the draft", () => {
  let ok = false;
  try {
    ok = window.confirm("Discard every mark, note and confirmation you made on this sheet and go back to the draft?");
  } catch {
    ok = false;
  }
  if (!ok) return;
  clearSaved();
  state = initialState(draft);
  clearSelection();
  nameInput.value = "";
  dateInput.value = "";
  renderAll();
});

app.append(
  h("div", { class: "toolbar" },
    h("label", { for: "search" }, "Search"), search, searchCount,
    h("span", { class: "sep" }), selectionText, makeGroupBtn, clearSelBtn,
    h("span", { class: "sep" }), resetBtn,
  ),
);

const timeline = h("div", { class: "timeline", role: "group", "aria-label": "Timeline of the labeled span" });
const markLayer = h("div", { class: "tl-marks" });
const dur = span.end - span.start;
const pct = (t: number) => Math.min(100, Math.max(0, ((t - span.start) / dur) * 100));
for (const [a, b] of data.watched) {
  const w = h("div", { class: "tl-watched", title: `Watched ${fmtTime(a)} to ${fmtTime(b)}` });
  w.style.left = `${pct(a)}%`;
  w.style.width = `${Math.max(0.2, pct(b) - pct(a))}%`;
  timeline.append(w);
}
for (const f of data.frames) {
  const tick = h("div", { class: "tl-frame" });
  tick.style.left = `${pct(f.mediaS)}%`;
  timeline.append(tick);
}
const midLine = h("div", { class: "tl-mid", title: "Split midpoint" });
midLine.style.left = `${pct(midpoint)}%`;
const mkLabel = (text: string, at: number) => {
  const l = h("span", { class: "tl-label" }, text);
  l.style.left = `${pct(at)}%`;
  return l;
};
timeline.addEventListener("click", (e) => {
  if (e.target !== timeline) return;
  const box = timeline.getBoundingClientRect();
  scrollToTime(span.start + ((e.clientX - box.left) / box.width) * dur);
});
timeline.append(midLine, markLayer, mkLabel(fmtTime(span.start), span.start), mkLabel(`split ${fmtTime(midpoint)}`, midpoint), mkLabel(fmtTime(span.end), span.end));
app.append(
  h("section", { "aria-label": "Timeline" },
    h("p", { class: "meta" }, "Timeline: green is watched time, small ticks are frames, the dashed line is the split. B is a boundary, V a visual step, D a duplicate group. Faded means rejected, hollow means unconfirmed. Press a marker to jump to it."),
    timeline,
  ),
);

// ───────────────────────────── the transcript and frames, in time order ─────────────────────────────

type Row = { readonly t: number; readonly item: HTMLElement; readonly row: HTMLElement; readonly slot: HTMLElement; readonly text?: string; readonly boundaryBtn?: HTMLButtonElement; readonly stepBtn?: HTMLButtonElement };

const dialog = h("dialog", { class: "lightbox", "aria-label": "Frame" });
const bigImg = h("img", { alt: "" });
const bigCaption = h("p", {});
dialog.append(bigImg, bigCaption, h("form", { method: "dialog" }, h("button", { type: "submit" }, "Close")));
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) dialog.close();
});
app.append(dialog);

const frameBySrcId = new Map(data.frames.map((f) => [f.id, f] as const));
const frameCheckboxes = new Map<string, HTMLInputElement>();

const entries: Row[] = [];
for (const p of data.passages) {
  const slot = h("div", { class: "slot" });
  const boundaryBtn = button("Boundary here", () => commit(toggleMark(state, "boundaries", p.start)), { "aria-pressed": "false" });
  const row = h("div", { class: "row passage", tabindex: -1 },
    h("span", { class: "time" }, fmtTime(p.start)),
    h("p", { class: "text" }, p.text),
    h("div", { class: "actions" }, boundaryBtn, watchLink(p.start)),
  );
  entries.push({ t: p.start, item: h("div", { class: "item" }, row, slot), row, slot, text: p.text.toLowerCase(), boundaryBtn });
}
for (const f of data.frames) {
  const slot = h("div", { class: "slot" });
  const stepBtn = button("Visual step", () => commit(toggleMark(state, "visualSteps", f.mediaS)), { "aria-pressed": "false" });
  const box = h("input", { type: "checkbox" });
  box.addEventListener("change", () => {
    if (box.checked) selected.set(f.id, { mediaS: f.mediaS, frameId: f.id });
    else selected.delete(f.id);
    renderSelection();
  });
  frameCheckboxes.set(f.id, box);
  const thumb = button("", () => openFrame(f.id), { class: "thumb", "aria-label": `Enlarge the frame at ${fmtTime(f.mediaS)}` });
  thumb.append(h("img", { src: f.src, alt: "", width: 160 }));
  const row = h("div", { class: "row frame", tabindex: -1 },
    thumb,
    h("div", { class: "frame-meta" },
      h("span", { class: "time" }, fmtTime(f.mediaS)),
      h("span", { class: "meta" }, `Frame ${f.id}, ${f.width} x ${f.height}`),
      h("div", { class: "actions" }, stepBtn, h("label", { class: "check" }, box, "Select for duplicate group"), watchLink(f.mediaS)),
    ),
  );
  entries.push({ t: f.mediaS, item: h("div", { class: "item" }, row, slot), row, slot, stepBtn });
}
entries.sort((a, b) => a.t - b.t);

const strayThumbs = h("div", { class: "slot" });
const body = h("section", { class: "stream", "aria-label": "Transcript and frames in time order" }, strayThumbs, ...entries.map((e) => e.item));
if (entries.length === 0) body.append(h("p", {}, "This capture holds no caption passages or frames for this video."));
app.append(h("h2", {}, "Transcript and frames"), body);

function slotFor(t: number): HTMLElement {
  let found: Row | undefined;
  for (const e of entries) if (e.t <= t + 1e-6) found = e;
  return found?.slot ?? entries[0]?.slot ?? strayThumbs;
}

function openFrame(id: string): void {
  const f = frameBySrcId.get(id);
  if (f === undefined) return;
  bigImg.src = f.src;
  bigCaption.textContent = `Frame ${f.id} at ${fmtTime(f.mediaS)} (${f.mediaS} s)`;
  dialog.showModal();
}

function scrollToTime(t: number): void {
  let target = entries[0];
  for (const e of entries) if (e.t <= t + 1e-6) target = e;
  target?.row.scrollIntoView({ block: "center" });
  target?.row.focus({ preventScroll: true });
}

search.addEventListener("input", () => {
  const q = search.value.trim().toLowerCase();
  let shown = 0;
  for (const e of entries) {
    if (e.text === undefined) continue;
    e.row.hidden = q !== "" && !e.text.includes(q);
    if (!e.row.hidden) shown++;
  }
  searchCount.textContent = q === "" ? "" : `${shown} of ${data.passages.length} passages match`;
});

function clearSelection(): void {
  selected.clear();
  for (const box of frameCheckboxes.values()) box.checked = false;
  renderSelection();
}
function renderSelection(): void {
  selectionText.textContent = `${selected.size} frame(s) selected for a duplicate group`;
  makeGroupBtn.disabled = selected.size < 2;
  clearSelBtn.disabled = selected.size === 0;
}

// ───────────────────────────── marks, as cards after the row they belong to ─────────────────────────────

const STATUS_TEXT: Record<Status, string> = { unconfirmed: "Unconfirmed", confirmed: "Confirmed", rejected: "Rejected (left out of the export)" };
const KIND_TEXT: Record<ItemKey, string> = { boundaries: "Boundary", visualSteps: "Visual step", groups: "Duplicate group" };
const cardId = (key: ItemKey, id: string) => `card-${key}-${id}`;

function card(key: ItemKey, item: Mark | Group): HTMLElement {
  const first = "mediaS" in item ? item.mediaS : Math.min(...item.frames.map((f) => f.mediaS));
  const focusKey = (part: string) => `${key}:${item.id}:${part}`;
  const note = h("input", { type: "text", value: item.note, "aria-label": `Note for the ${KIND_TEXT[key].toLowerCase()} at ${fmtTime(first)}` });
  note.addEventListener("input", () => {
    state = setNote(state, key, item.id, note.value);
    writeSaved(state);
    renderExport();
  });
  const actions = h("div", { class: "actions" });
  if (item.fromDraft) {
    actions.append(
      button("Confirm", () => commit(setStatus(state, key, item.id, item.status === "confirmed" ? "unconfirmed" : "confirmed")), { "aria-pressed": String(item.status === "confirmed"), "data-focus": focusKey("confirm") }),
      button("Reject", () => commit(setStatus(state, key, item.id, item.status === "rejected" ? "unconfirmed" : "rejected")), { "aria-pressed": String(item.status === "rejected"), "data-focus": focusKey("reject") }),
    );
  } else {
    actions.append(button(key === "groups" ? "Ungroup" : "Remove", () => commit(removeItem(state, key, item.id)), { "data-focus": focusKey("remove") }));
  }
  actions.append(watchLink(first));

  const el = h("div", { class: `card ${key} ${item.status}`, id: cardId(key, item.id) },
    h("p", { class: "card-head" },
      h("strong", {}, `${KIND_TEXT[key]} at ${fmtTime(first)}`),
      h("span", { class: "pill" }, STATUS_TEXT[item.status]),
      h("span", { class: "meta" }, item.fromDraft ? "candidate from the draft" : "added by you"),
    ),
    item.cue === undefined ? null : h("p", { class: "cue" }, `Why it was suggested: ${item.cue}`),
    h("label", { class: "note-label" }, "Note ", note),
  );
  if ("frames" in item) {
    const thumbs = h("ul", { class: "members" });
    item.frames.forEach((m, i) => {
      const f = (m.frameId !== undefined ? frameBySrcId.get(m.frameId) : undefined) ?? data.frames.find((x) => Math.abs(x.mediaS - m.mediaS) < 0.5);
      thumbs.append(h("li", {},
        f === undefined ? null : h("img", { src: f.src, alt: "", width: 96 }),
        h("span", {}, `${fmtTime(m.mediaS)}${i === 0 ? " (the original)" : ""}`),
        button("Remove from group", () => commit(removeMember(state, item.id, i)), { "aria-label": `Remove the frame at ${fmtTime(m.mediaS)} from this group` }),
      ));
    });
    el.append(thumbs);
  }
  el.append(actions);
  return el;
}

function renderCards(): void {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.focus : undefined;
  for (const e of entries) e.slot.replaceChildren();
  strayThumbs.replaceChildren();
  const all: { t: number; order: number; el: HTMLElement }[] = [];
  state.boundaries.forEach((m) => all.push({ t: m.mediaS, order: 0, el: card("boundaries", m) }));
  state.visualSteps.forEach((m) => all.push({ t: m.mediaS, order: 1, el: card("visualSteps", m) }));
  state.groups.forEach((g) => all.push({ t: g.frames.length > 0 ? Math.min(...g.frames.map((f) => f.mediaS)) : 0, order: 2, el: card("groups", g) }));
  all.sort((a, b) => a.t - b.t || a.order - b.order);
  for (const c of all) slotFor(c.t).append(c.el);
  if (active !== undefined) document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(active)}"]`)?.focus({ preventScroll: true });
}

function renderRowButtons(): void {
  for (const e of entries) {
    e.boundaryBtn?.setAttribute("aria-pressed", String(isMarked(state, "boundaries", e.t)));
    e.stepBtn?.setAttribute("aria-pressed", String(isMarked(state, "visualSteps", e.t)));
  }
}

function renderTimeline(): void {
  markLayer.replaceChildren();
  const put = (key: ItemKey, item: Mark | Group, letter: string, lane: number) => {
    const t = "mediaS" in item ? item.mediaS : Math.min(...item.frames.map((f) => f.mediaS));
    const b = button(letter, () => {
      const target = document.getElementById(cardId(key, item.id));
      target?.scrollIntoView({ block: "center" });
      target?.querySelector<HTMLElement>("button, input")?.focus({ preventScroll: true });
    }, { class: `tl-mark ${item.status}`, "aria-label": `${KIND_TEXT[key]} at ${fmtTime(t)}, ${STATUS_TEXT[item.status].toLowerCase()}`, title: `${KIND_TEXT[key]} at ${fmtTime(t)}: ${item.status}` });
    b.style.left = `calc(${pct(t)}% - 9px)`;
    b.style.top = `${lane * 20 + 2}px`;
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
const out = h("textarea", { id: "export-json", readonly: true, rows: 22, spellcheck: false, "aria-label": `Label file JSON for ${videoId}` });
const copyResult = h("span", { class: "meta", role: "status" });

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
  const a = h("a", { download: `${videoId}.json` });
  a.href = url;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  copyResult.textContent = `Download of ${videoId}.json started.`;
}

app.append(
  h("section", { id: "export", class: "export", tabindex: -1 },
    h("h2", {}, "Export"),
    h("p", {}, "Sign-off block. Only you can sign off: type your name and the date. Until you do, and until every item is confirmed or rejected, the export is a draft."),
    h("div", { class: "signoff" },
      h("label", { for: "signer" }, "Your name"), nameInput,
      h("label", { for: "signdate" }, "Date"), dateInput,
    ),
    exportStatus,
    h("p", {}, "What blocks sign-off:"),
    blockerList, warningList, countsText,
    out,
    h("div", { class: "actions" }, button("Copy", copy), button(`Download ${videoId}.json`, download), copyResult),
    h("p", { class: "meta" }, `Save the file as docs/experiments/labels/${videoId}.json, or anywhere, then check it with: bun run scripts/jev-lab.ts split --labels <file>`),
  ),
);

function renderExport(): void {
  const result = evaluate(state, draft);
  exportStatus.textContent = result.labels.status === "signed_off"
    ? `The export is SIGNED OFF by ${result.labels.signedOffBy} on ${result.labels.signedOffAt}. Nothing blocks it.`
    : `The export is a DRAFT (status "draft", no name or date) because of ${result.blockers.length} thing(s) below.`;
  exportStatus.className = `export-status ${result.labels.status}`;
  blockerList.replaceChildren(...(result.blockers.length === 0 ? [h("li", {}, "Nothing blocks sign-off.")] : result.blockers.map((b) => h("li", {}, b.message))));
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
  renderTimeline();
  renderExport();
}

function commit(next: SheetState): void {
  state = next;
  writeSaved(state);
  renderAll();
}

renderSelection();
renderAll();
