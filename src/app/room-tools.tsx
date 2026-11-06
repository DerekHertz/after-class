import { useEffect, useRef, useState } from "react";
import type { SceneId } from "./appearance";
import { useAppearance } from "./appearance";
import { Companion } from "./companion";
import { Link, navigate } from "./ui";
import { HDRoomStage } from "./hd-room";
import { clearCompanionReaction, reactToCompanion } from "./companion-reaction";

const TOOLS = {
  "last-desk": { name: "Lecture stand", action: "Open the lecture" },
  "projection-booth": { name: "Lecture projector", action: "Switch on the source" },
  "study-bench": { name: "Lecture paper feed", action: "Unroll lecture source" },
} as const;

export function RoomTools({ scene, onNotebook, onSource, sourceOpen, onSpeak, showSpeak = true, speechAvailable = false, listening = false }: {
  readonly scene: SceneId;
  readonly onNotebook?: () => void;
  readonly onSource: (origin?: HTMLButtonElement) => void;
  readonly sourceOpen: boolean;
  readonly onSpeak?: () => void;
  /** Whether the Speak controls exist at all; the review shows them only when the voice setting is on. */
  readonly showSpeak?: boolean;
  readonly speechAvailable?: boolean;
  readonly listening?: boolean;
}) {
  const { appearance, activity } = useAppearance();
  const [held, setHeld] = useState(false);
  const notebookTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearCompanionReaction();
    return () => { clearTimeout(notebookTimer.current); };
  }, [scene, appearance.companion, appearance.detail, appearance.visible]);
  function openNotebook() {
    clearTimeout(notebookTimer.current);
    reactToCompanion("read");
    const reduced = appearance.motion === "reduced" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const open = onNotebook ?? (() => navigate({ page: "record", reviewId: null }));
    if (reduced || !appearance.visible) open();
    else notebookTimer.current = setTimeout(open, 500);
  }
  useEffect(() => { if (!speechAvailable) setHeld(false); }, [speechAvailable]);
  const tool = TOOLS[scene];
  if (appearance.detail === "hd-pixel") {
    return <div className="hd-room-tools" data-tool-scene={scene}><HDRoomStage scene={scene}>
      <button className="hd-room-hotspot hd-card" type="button" aria-label={sourceOpen ? "Close lecture source" : "Draw a source card"} aria-expanded={sourceOpen} aria-controls="review-source" onClick={event => {
        if (!sourceOpen) reactToCompanion("draw");
        onSource(event.currentTarget);
      }}><span>{sourceOpen ? "Close source" : "Draw source card"}</span></button>
      <button className="hd-room-hotspot hd-stand" type="button" aria-label={sourceOpen ? "Close lecture source on stand" : "Open lecture source on stand"} aria-expanded={sourceOpen} aria-controls="review-source" onClick={event => { if (!sourceOpen) reactToCompanion("draw"); onSource(event.currentTarget); }}><span>Lecture source</span></button>
      <button className="hd-room-hotspot hd-journal" type="button" onClick={openNotebook}><span>My notebook</span></button>
      {showSpeak && <button className="hd-room-hotspot hd-recorder" type="button" aria-label={listening ? "Stop listening with recorder" : "Speak with recorder"} disabled={!speechAvailable} aria-pressed={listening} onClick={onSpeak}><span>{listening ? "Stop listening" : "Speak"}</span></button>}
      {appearance.visible && <div className="hd-room-friend"><Companion id={appearance.companion} activity={activity} /></div>}
      {!appearance.visible && <span className="hd-quiet-status" role="status">{activity === "idle" ? "Ready when you are" : activity === "waiting" ? "Waiting for a response" : activity === "listening" ? "Listening" : activity === "saving" ? "Saving your record" : "Review paused"}</span>}
    </HDRoomStage>
      <div className="hd-mobile-tools" aria-label="Study desk tools">
        <button type="button" aria-expanded={sourceOpen} aria-controls="review-source" onClick={event => { if (!sourceOpen) reactToCompanion("draw"); onSource(event.currentTarget); }}>{sourceOpen ? "Close source" : "Draw source card"}</button>
        <button type="button" onClick={openNotebook}>My notebook</button>
        {showSpeak && <button type="button" disabled={!speechAvailable} aria-pressed={listening} onClick={onSpeak}>{listening ? "Stop listening" : "Speak"}</button>}
      </div>
    </div>;
  }
  return <div className="room-tools" data-tool-scene={scene} data-source-open={sourceOpen}>
    <div className="source-stage-art" aria-hidden="true" />
    {scene === "study-bench" && <>
      <div className="source-paper-track" aria-hidden="true"><div className="source-paper-art" /><div className="source-paper-grain" /></div>
    </>}
    <button className="source-handle" type="button" aria-label={scene === "study-bench" ? sourceOpen ? "Roll up lecture source" : "Unroll lecture source" : undefined} aria-expanded={sourceOpen} aria-controls="review-source" onClick={event => { if (!sourceOpen) reactToCompanion("draw"); onSource(event.currentTarget); }}>
      <span className="room-tool-name">{tool.name}</span>
      <span>{scene === "study-bench" ? "Lecture source" : sourceOpen ? "Close lecture source" : tool.action}</span>
    </button>
    <div className="scene-foreground">
      {appearance.visible && <Companion id={appearance.companion} activity={activity} />}
      {showSpeak && <div className="recorder-tool" data-depressed={speechAvailable && (held || listening)}><span className="recorder-art" aria-hidden="true" />
      {scene === "projection-booth" && <span className="recorder-legend" aria-hidden="true">Voice</span>}
      <button type="button" className="recorder-key" aria-label={listening ? "Stop listening with recorder" : "Speak with recorder"} disabled={!speechAvailable} aria-pressed={listening}
        onPointerDown={event => { if (speechAvailable && event.button === 0) setHeld(true); }}
        onPointerUp={() => setHeld(false)} onPointerCancel={() => setHeld(false)} onPointerLeave={() => setHeld(false)}
        onKeyDown={event => {
          if (event.repeat) { event.preventDefault(); return; }
          if (speechAvailable && (event.key === " " || event.key === "Enter")) setHeld(true);
        }}
        onKeyUp={() => setHeld(false)} onBlur={() => setHeld(false)} onClick={onSpeak}>
        <span className="recorder-key-art" aria-hidden="true" />
        <span className="physical-tool-label">{listening ? "Stop" : "Speak"}</span>
      </button></div>}
      <div className="journal-tool" onClickCapture={() => reactToCompanion("read")}><Link to={{ page: "record", reviewId: null }}>
        <span className="journal-art" aria-hidden="true" /><span className="physical-tool-label">My notebook</span>
      </Link></div>
      {!appearance.visible && <span className="quiet-status" role="status">{activity === "idle" ? "Ready when you are" : activity === "waiting" ? "Waiting for a response" : activity === "listening" ? "Listening" : activity === "saving" ? "Saving your record" : "Review paused"}</span>}
    </div>
  </div>;
}
