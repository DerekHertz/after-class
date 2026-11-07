import { useState } from "react";
import type { LecturesResponse } from "../shared/wire";
import { parseId } from "../shared/ids";
import type { AppApi } from "./api";
import { formatDuration, lectureHeading } from "./core";
import type { Route } from "./core";
import { ErrorNote, Link, navigate, useAsync } from "./ui";

type Lecture = LecturesResponse["lectures"][number];
type LectureReview = Lecture["reviews"][number];

export const EMPTY_HOME = "No lectures captured yet. Start capture from the extension while watching a lecture.";

/** The first-capture steps an empty home shows. They name the extension's own buttons, so they match what the learner sees. */
export const FIRST_CAPTURE_STEPS = [
  "Open a YouTube lecture in Chrome and turn on its captions.",
  "Click the After Class extension and choose Start capture.",
  "Watch the part you want to review. When material is ready, the extension offers a review, or choose Open the review page.",
] as const;

const CAPTURE_LABEL = (s: Lecture["status"]): string => (s.state === "capturing" ? "Capturing" : s.state === "paused" ? "Capture paused" : "Capture stopped");

/** Where a review in the list leads: open it while it can continue, the record once saved, nowhere when ended unsaved. */
export function reviewTarget(r: Pick<LectureReview, "reviewId" | "phase" | "saved">): Route | null {
  if (r.phase !== "ended") return { page: "review", id: r.reviewId };
  return r.saved === "saved" ? { page: "record", reviewId: r.reviewId } : null;
}

/** What a review row offers, named for the action rather than the date. The destination always comes from `reviewTarget`. */
export function reviewAction(r: Pick<LectureReview, "reviewId" | "phase" | "saved">): { readonly label: string; readonly target: Route | null } {
  const target = reviewTarget(r);
  if (r.phase !== "ended") return { label: "Continue review", target };
  if (r.saved === "saved") return { label: "Open saved notes", target };
  if (r.saved === "save_pending") return { label: target ? "Retry saving notes" : "Notes not saved yet", target };
  return { label: "Ended, not saved", target };
}

/** Reviews that can still continue, newest first, each with its lecture. */
export function resumable(data: LecturesResponse): { readonly lecture: Lecture; readonly review: LectureReview }[] {
  return data.lectures
    .flatMap((lecture) => lecture.reviews.filter((r) => r.phase !== "ended").map((review) => ({ lecture, review })))
    .sort((a, b) => b.review.startedMs - a.review.startedMs);
}

const startedAt = (ms: number): string => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const questions = (n: number): string => `${n} ${n === 1 ? "question" : "questions"}`;

function ContinueCard({ lecture, review }: { readonly lecture: Lecture; readonly review: LectureReview }) {
  const { title } = lectureHeading(lecture.sourceTitles);
  const { label, target } = reviewAction(review);
  return (
    <article className="home-continue">
      <p className="page-kicker">{review.phase === "paused" ? "Paused review" : "Review in progress"}</p>
      <h3>{title}</h3>
      <p className="muted">{questions(review.mainQuestions)} so far · started {startedAt(review.startedMs)}</p>
      {target && <p className="home-primary"><Link to={target}>{label}<span className="visually-hidden">: {title}</span></Link></p>}
    </article>
  );
}

function ReviewRow({ review }: { readonly review: LectureReview }) {
  const { label, target } = reviewAction(review);
  const status = review.phase === "paused" ? "Paused · " : review.phase === "active" ? "In progress · " : "";
  return (
    <li>
      {target ? <Link to={target}>{label}</Link> : label}{" "}
      <span className="muted">{status}{questions(review.mainQuestions)} · started {startedAt(review.startedMs)}</span>
    </li>
  );
}

function FirstCapture() {
  return (
    <section className="record-section home-empty" aria-labelledby="home-empty-heading">
      <h2 id="home-empty-heading">Capture your first lecture</h2>
      <p>{EMPTY_HOME}</p>
      <ol>{FIRST_CAPTURE_STEPS.map((step) => <li key={step}>{step}</li>)}</ol>
      <p className="muted">
        The After Class backend answered this page, so it is running. This page can't tell whether the extension is connected to it.
        If the extension says it can't reach the backend, open the extension's options, paste the pairing token the backend printed, and choose Save and test.
      </p>
    </section>
  );
}

export function HomeBody({ data }: { readonly data: LecturesResponse }) {
  if (data.lectures.length === 0) return <FirstCapture />;
  const open = resumable(data);
  return (
    <>
      {open.length > 0 && (
        <section className="record-section" aria-labelledby="home-continue-heading">
          <h2 id="home-continue-heading">Pick up where you left off</h2>
          {open.map(({ lecture, review }) => <ContinueCard key={review.reviewId} lecture={lecture} review={review} />)}
        </section>
      )}
      <section className="record-section" aria-labelledby="home-lectures-heading">
        <h2 id="home-lectures-heading">Your lectures</h2>
        <ul className="lecture-list">
          {data.lectures.map((l) => {
            const h = lectureHeading(l.sourceTitles);
            return (
              <li key={l.captureId}>
                <Link to={{ page: "capture", id: l.captureId }}>{h.title}</Link>{" "}
                <span className="muted">
                  {[h.detail ?? (l.videos === 1 ? "1 video" : `${l.videos} videos`), `${formatDuration(l.watchedSeconds)} watched`, CAPTURE_LABEL(l.status)].join(" · ")}
                </span>
                {l.reviews.length > 0 && <ul>{l.reviews.map((r) => <ReviewRow key={r.reviewId} review={r} />)}</ul>}
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}

/** Opening a capture by its ID is for troubleshooting, so it stays folded away under the lecture list. */
export function OpenById() {
  const [id, setId] = useState("");
  const valid = parseId("cap", id.trim()) !== null;
  return (
    <details className="home-troubleshoot">
      <summary>Troubleshooting: open a capture by ID</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) navigate({ page: "capture", id: id.trim() });
        }}
      >
        <label>Capture ID <input value={id} onChange={(e) => setId(e.target.value)} placeholder="cap_..." /></label>{" "}
        <button type="submit" disabled={!valid}>Open</button>
      </form>
    </details>
  );
}

export function HomeScreen({ api }: { readonly api: AppApi }) {
  const lectures = useAsync(() => api.lectures(), [api]);
  return (
    <main className="notebook-page home-page">
      <header className="page-heading">
        <div><p className="page-kicker">After Class</p><h1>Your lectures</h1></div>
        <nav aria-label="Home navigation"><Link to={{ page: "record", reviewId: null }}>My notebook</Link><Link to={{ page: "usage" }}>Usage</Link></nav>
      </header>
      {lectures.error !== null && <ErrorNote error={lectures.error} retry={lectures.reload} />}
      {lectures.data === null && lectures.error === null && <p className="page-loading" role="status">Loading your lectures...</p>}
      {lectures.data && <HomeBody data={lectures.data} />}
      <OpenById />
    </main>
  );
}
