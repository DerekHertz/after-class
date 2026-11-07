/**
 * The notebook (#117): lecture → topic in both entry points, honest revisit and disputed views, compact sources and
 * one next step on a first visit. Deterministic UI fixtures only: no providers.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { countsAsGap, focusLectures, notebookLectures, topicName, viewCounts, withDraft } from "../src/app/notebook-view";
import type { NoteDrafts } from "../src/app/notebook-view";
import { loadReviewContext } from "../src/app/observation-view";
import type { ReviewContext } from "../src/app/observation-view";
import { RecordBody } from "../src/app/record";
import type { Observation } from "../src/shared/domain";
import type { NoteId, ReviewId } from "../src/shared/ids";
import { createFixture, ids } from "../scripts/ui-preview/fixtures";
import type { Scenario } from "../scripts/ui-preview/fixtures";

async function notebook(scenario: Scenario = "record-lectures") {
  const fixture = createFixture(scenario);
  const record = await fixture.api.record({});
  const { lectures } = await fixture.api.lectures();
  const contexts = new Map<ReviewId, ReviewContext>();
  for (const id of new Set(record.observations.map((o) => o.reviewId))) contexts.set(id, await loadReviewContext(fixture.api, id));
  return { fixture, record, lectures, contexts };
}

const summary = (lectures: ReturnType<typeof notebookLectures>) =>
  lectures.map((l) => ({ title: l.title, topics: l.topics.map((t) => ({ label: t.label, notes: t.notes.length, observations: t.observations.map((o) => o.status), revisit: t.revisit, disputed: t.disputed })) }));

type BodyProps = Parameters<typeof RecordBody>[0];
const html = (props: Omit<BodyProps, "drafts" | "setDraft"> & Partial<BodyProps>) => renderToStaticMarkup(createElement(RecordBody, { drafts: new Map(), setDraft: () => {}, ...props }));
const run = async (action: () => Promise<void>) => { await action(); };

describe("lecture → topic grouping", () => {
  test("two saved lectures, newest first, each topic holding its own notes and observations", async () => {
    const { record, lectures, contexts } = await notebook();
    expect(summary(notebookLectures(record, lectures, contexts))).toEqual([
      { title: "Locks & deadlocks", topics: [
        { label: "Circular wait", notes: 1, observations: ["disputed"], revisit: false, disputed: true },
        { label: "Resource ordering", notes: 0, observations: ["independent"], revisit: false, disputed: false },
      ] },
      { title: "Deadlock prevention", topics: [
        { label: "Circular wait", notes: 0, observations: ["disputed"], revisit: false, disputed: true },
        { label: "Resource ordering", notes: 1, observations: ["disputed"], revisit: false, disputed: true },
      ] },
    ]);
  });

  test("a review whose context failed keeps its lecture title, and its topics are named by place until Retry", async () => {
    const { fixture, record, lectures, contexts } = await notebook("record-context-error");
    expect(contexts.get(ids.earlierReview)).toEqual({ state: "failed", error: "Fixture review lookup failed. Retry is available." });
    const [current, earlier] = notebookLectures(record, lectures, contexts);
    expect(current!.topics.map((t) => t.label)).toEqual(["Circular wait", "Resource ordering"]);
    expect(earlier!.title).toBe("Deadlock prevention");
    expect(earlier!.topics.map((t, i) => topicName(t, i, false))).toEqual(["Topic 1", "Topic 2"]);
    expect(earlier!.topics.map((t, i) => topicName(t, i, true))).toEqual(["Topic 1 (name loading)", "Topic 2 (name loading)"]);
    contexts.set(ids.earlierReview, await loadReviewContext(fixture.api, ids.earlierReview));
    const retried = notebookLectures(record, lectures, contexts);
    expect(retried.map((l) => l.key)).toEqual([current!.key, earlier!.key]);
    expect(retried[1]!.topics.map((t) => t.label)).toEqual(["Circular wait", "Resource ordering"]);
  });

  test("without the lecture list each review stands alone, untitled, and nothing is dropped", async () => {
    const { record, contexts } = await notebook();
    const alone = notebookLectures(record, null, contexts);
    expect(alone.map((l) => [l.title, l.reviews.map((r) => r.reviewId)])).toEqual([[null, [ids.review]], [null, [ids.earlierReview]]]);
    expect(alone.flatMap((l) => l.topics.flatMap((t) => t.observations)).length).toBe(record.observations.length);
    expect(alone.flatMap((l) => l.topics.flatMap((t) => t.notes)).length).toBe(record.notes.length);
  });

  test("an empty record has no lectures and no topics", async () => {
    const { record, lectures, contexts } = await notebook("record-empty");
    expect(notebookLectures(record, lectures, contexts)).toEqual([]);
  });

  test("an observation that names no concept is kept under its own heading", async () => {
    const { record, lectures, contexts } = await notebook("record");
    const loose = { ...record, observations: record.observations.map((o, i) => (i === 0 ? { ...o, conceptIds: [] } : o)) };
    const topics = notebookLectures(loose, lectures, contexts)[0]!.topics;
    const none = topics.find((t) => t.conceptId === null)!;
    expect(none.observations).toHaveLength(1);
    expect(topicName(none, topics.indexOf(none), false)).toBe("Not tied to one topic");
  });
});

describe("revisit and disputed views", () => {
  const base = (status: Observation["status"], dispute: Observation["dispute"]) => ({ status, dispute });

  test("R14: only a gap status with no dispute, or one the learner settled as their gap, is to revisit", () => {
    expect(countsAsGap(base("partial", { kind: "none" }))).toBe(true);
    expect(countsAsGap(base("unresolved", { kind: "none" }))).toBe(true);
    expect(countsAsGap(base("partial", { kind: "resolved_by_learner", outcome: "it_was_my_gap" }))).toBe(true);
    expect(countsAsGap(base("partial", { kind: "resolved_by_learner", outcome: "learner_was_right" }))).toBe(false);
    expect(countsAsGap(base("unresolved", { kind: "resolved_by_learner", outcome: "learner_was_right" }))).toBe(false);
    expect(countsAsGap(base("disputed", { kind: "unsettled" }))).toBe(false);
    for (const status of ["independent", "after_help", "looks_fine", "not_assessed"] as const) expect(countsAsGap(base(status, { kind: "none" }))).toBe(false);
  });

  test("settling a dispute as supported keeps the tutor's partial status but never lists the topic to revisit", async () => {
    const { fixture, lectures, contexts } = await notebook();
    const [circular, ordering] = (await fixture.api.record({})).observations;
    await fixture.api.resolveDispute(circular!.id, "learner_was_right");
    await fixture.api.resolveDispute(ordering!.id, "it_was_my_gap");
    const after = await fixture.api.record({});
    expect(after.observations.slice(0, 2).map((o) => [o.status, o.dispute])).toEqual([
      ["partial", { kind: "resolved_by_learner", outcome: "learner_was_right" }],
      ["unresolved", { kind: "resolved_by_learner", outcome: "it_was_my_gap" }],
    ]);
    const earlier = notebookLectures(after, lectures, contexts)[1]!;
    expect(earlier.topics.map((t) => [t.label, t.revisit, t.disputed])).toEqual([["Circular wait", false, false], ["Resource ordering", true, false]]);
    expect(focusLectures([earlier], "revisit").flatMap((l) => l.topics.map((t) => t.label))).toEqual(["Resource ordering"]);
  });

  test("the disputed view holds every open dispute, and an empty view is not offered", async () => {
    const { record, lectures, contexts } = await notebook();
    const all = notebookLectures(record, lectures, contexts);
    expect(viewCounts(all)).toEqual({ all: 4, revisit: 0, disputed: 3 });
    expect(focusLectures(all, "disputed").map((l) => [l.title, l.topics.map((t) => t.label)])).toEqual([
      ["Locks & deadlocks", ["Circular wait"]],
      ["Deadlock prevention", ["Circular wait", "Resource ordering"]],
    ]);
    const page = html({ api: createFixture("record-lectures").api, data: record, lectures, run });
    expect(page).toContain('<button type="button" aria-pressed="true">All topics (4)</button>');
    expect(page).toContain('<button type="button" aria-pressed="false">Disputed (3)</button>');
    expect(page).not.toContain("To revisit (");
  });
});

describe("unsaved note edits", () => {
  const typed = "Unsaved integration review draft 117";

  async function circularWaitNote() {
    const { fixture, record: before, lectures, contexts } = await notebook();
    const [current, earlier] = notebookLectures(before, lectures, contexts);
    expect([current!.title, current!.topics[0]!.label]).toEqual(["Locks & deadlocks", "Circular wait"]);
    await fixture.api.resolveDispute(current!.topics[0]!.observations[0]!.id, "learner_was_right");
    const record = await fixture.api.record({});
    expect(focusLectures(notebookLectures(record, lectures, contexts), "disputed").map((l) => l.title)).toEqual(["Deadlock prevention"]);
    return { fixture, record, lectures, note: current!.topics[0]!.notes[0]!.id, other: earlier!.topics[1]!.notes[0]!.id };
  }

  test("#117: an open edit is drawn from drafts held above the views, so it reads the same with or without lecture titles", async () => {
    const { fixture, record, lectures, note } = await circularWaitNote();
    const drafts: NoteDrafts = new Map([[note, typed]]);
    for (const list of [lectures, null]) {
      const page = html({ api: fixture.api, data: record, lectures: list, run, drafts });
      expect(page).toMatch(new RegExp(`Each thread holds something the other needs\\.</p><div><label[^>]*>Your edit</label>.*?<textarea id="[^"]+" rows="4">${typed}</textarea>`));
      expect(page.match(/>Save edit<\/button>/g)).toHaveLength(1);
      expect(page.match(/aria-label="Edit your note on /g)).toHaveLength(1);
    }
  });

  test("with no drafts every note shows Edit, and no textarea", async () => {
    const { fixture, record, lectures } = await circularWaitNote();
    const page = html({ api: fixture.api, data: record, lectures, run });
    expect(page).not.toContain("<textarea");
    expect(page.match(/aria-label="Edit your note on /g)).toHaveLength(2);
  });

  test("starting, typing and closing one note's draft leaves every other note's draft as it was", async () => {
    const { note, other } = await circularWaitNote();
    const opened = withDraft(withDraft(new Map(), note, ""), other, "Kept saved wording");
    const typing = withDraft(opened, note, typed);
    expect([...typing]).toEqual([[note, typed], [other, "Kept saved wording"]]);
    const closed = withDraft(typing, note, null);
    expect([...closed]).toEqual([[other, "Kept saved wording"]]);
    expect(typing.get(note)).toBe(typed);
    expect([...withDraft(closed, "note_missing" as NoteId, null)]).toEqual([...closed]);
  });
});

describe("the rendered notebook", () => {
  test("each topic reads explanation, help, status, then source, with each author labelled", async () => {
    const { fixture, record, lectures } = await notebook("record");
    const page = html({ api: fixture.api, data: record, lectures, run });
    const topic = page.slice(page.indexOf('<article class="notebook-topic"'), page.indexOf("</article>"));
    const at = (s: string) => topic.indexOf(s);
    for (const s of ["<h4>My explanation</h4>", "<h4>Help used</h4>", "<h4>Status</h4>", "<h4>Source</h4>"]) expect(at(s)).toBeGreaterThan(-1);
    expect(at("<h4>My explanation</h4>")).toBeLessThan(at("<h4>Help used</h4>"));
    expect(at("<h4>Help used</h4>")).toBeLessThan(at("<h4>Status</h4>"));
    expect(at("<h4>Status</h4>")).toBeLessThan(at("<h4>Source</h4>"));
    expect(topic).toContain('<p class="author-learner"><strong>You: </strong>Each thread holds something the other needs.</p>');
    expect(topic).toContain('<p class="author-tutor"><strong>Tutor: </strong>Look at the order in which resources are acquired.</p>');
    expect(topic).toContain('<p class="author-source"><strong>Lecture: </strong>Circular wait is one condition for deadlock.</p>');
    expect(at("Status: </strong>Disputed")).toBeLessThan(at("<h4>My explanation</h4>"));
  });

  test("a contents list names every lecture and topic, and each entry moves focus to a focusable topic heading", async () => {
    const { fixture, record, lectures } = await notebook();
    const page = html({ api: fixture.api, data: record, lectures, run });
    const nav = page.slice(page.indexOf('<nav class="notebook-contents"'), page.indexOf("</nav>"));
    expect(nav).toContain("<span>Locks &amp; deadlocks</span>");
    expect(nav).toContain("<span>Deadlock prevention</span>");
    expect(nav.match(/class="notebook-contents-topic"/g)).toHaveLength(4);
    expect(page.match(/<h3 id="[^"]+" tabindex="-1">/g)).toHaveLength(4);
    expect(page.indexOf(">Locks &amp; deadlocks</h2>")).toBeLessThan(page.indexOf(">Deadlock prevention</h2>"));
  });

  test("evidence the learner deleted is marked in its topic's source, never offered", async () => {
    const { fixture, record, lectures } = await notebook();
    const page = html({ api: fixture.api, data: record, lectures, run });
    const earlier = page.slice(page.indexOf(">Deadlock prevention</h2>"));
    expect(earlier).toContain("Taking locks in one order means nobody waits in a circle.");
    expect(earlier).toContain('<span class="muted">[1: deleted by you] </span>');
    expect(earlier).not.toContain("Open transcript");
  });

  test("links between concepts show only when there are some, after the lectures", async () => {
    const { fixture, record, lectures } = await notebook("record");
    const page = html({ api: fixture.api, data: record, lectures, run });
    expect(page.indexOf("Suggested links between concepts")).toBeGreaterThan(page.indexOf('<article class="notebook-topic"'));
    expect(html({ api: fixture.api, data: { ...record, links: [] }, lectures, run })).not.toContain("Suggested links");
  });

  test("rendering the notebook asks for no summary and starts no provider work", async () => {
    for (const scenario of ["record", "record-lectures", "record-context-error", "record-illustrated"] as const) {
      const { fixture, record, lectures } = await notebook(scenario);
      html({ api: fixture.api, data: record, lectures, run });
      expect(fixture.requestLedger.snapshot().split("\n").filter((line) => !line.endsWith(".read"))).toEqual([]);
    }
  });

  test("the room's notebook and the full page mount the same notebook, with no variant", () => {
    const room = readFileSync(new URL("../src/app/review.tsx", import.meta.url), "utf8");
    const page = readFileSync(new URL("../src/app/main.tsx", import.meta.url), "utf8");
    expect(room).toContain("<RecordScreen api={api} reviewId={null} />");
    expect(page).toMatch(/<RecordScreen api=\{api\} reviewId=\{[^}]+\} \/>/);
    expect(room).not.toContain("indexed");
  });
});
