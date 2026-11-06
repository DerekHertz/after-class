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

const PHASE_LABEL = { active: "In progress", paused: "Paused", ended: "Ended" } as const;
const CAPTURE_LABEL = (s: Lecture["status"]): string => (s.state === "capturing" ? "Capturing" : s.state === "paused" ? "Capture paused" : "Capture stopped");

/** Where a review in the list leads: open it while it can continue, the record once saved, nowhere when ended unsaved. */
export function reviewTarget(r: Pick<LectureReview, "reviewId" | "phase" | "saved">): Route | null {
  if (r.phase !== "ended") return { page: "review", id: r.reviewId };
  return r.saved === "saved" ? { page: "record", reviewId: r.reviewId } : null;
}

const startedAt = (ms: number): string => new Date(ms).toLocaleString();

function ReviewRow({ review }: { readonly review: LectureReview }) {
  const target = reviewTarget(review);
  const label = `Review started ${startedAt(review.startedMs)}`;
  const saved = review.phase === "ended" ? (review.saved === "saved" ? ", saved" : ", not saved") : "";
  const note = `${PHASE_LABEL[review.phase]}${saved} · ${review.mainQuestions} ${review.mainQuestions === 1 ? "question" : "questions"}`;
  return <li>{target ? <Link to={target}>{label}</Link> : label} <span className="muted">{note}</span></li>;
}

export function HomeBody({ data }: { readonly data: LecturesResponse }) {
  if (data.lectures.length === 0) return <p>{EMPTY_HOME}</p>;
  return (
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
  );
}

export function HomeScreen({ api }: { readonly api: AppApi }) {
  const lectures = useAsync(() => api.lectures(), [api]);
  const [id, setId] = useState("");
  const valid = parseId("cap", id.trim()) !== null;
  return (
    <main>
      <h1>After Class</h1>
      <h2>Your lectures</h2>
      {lectures.error !== null && <ErrorNote error={lectures.error} retry={lectures.reload} />}
      {lectures.data === null && lectures.error === null && <p role="status">Loading...</p>}
      {lectures.data && <HomeBody data={lectures.data} />}
      <p><Link to={{ page: "record", reviewId: null }}>My notebook</Link> · <Link to={{ page: "usage" }}>Usage</Link></p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) navigate({ page: "capture", id: id.trim() });
        }}
      >
        <label className="muted">Or open a capture by id: <input value={id} onChange={(e) => setId(e.target.value)} placeholder="cap_..." /></label>{" "}
        <button type="submit" disabled={!valid}>Open</button>
      </form>
    </main>
  );
}
