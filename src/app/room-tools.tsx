import { useEffect, useState } from "react";
import type { SceneId } from "./appearance";
import { useAppearance } from "./appearance";
import { Companion } from "./companion";
import { Link } from "./ui";

const TOOLS = {
  "last-desk": { name: "Lecture stand", action: "Open the lecture" },
  "projection-booth": { name: "Lecture projector", action: "Switch on the source" },
  "study-bench": { name: "Lecture paper feed", action: "Unroll lecture source" },
} as const;

export function RoomTools({ scene, onSource, sourceOpen, onSpeak, speechAvailable = false, listening = false }: {
  readonly scene: SceneId;
  readonly onSource: (origin?: HTMLButtonElement) => void;
  readonly sourceOpen: boolean;
  readonly onSpeak?: () => void;
  readonly speechAvailable?: boolean;
  readonly listening?: boolean;
}) {
  const { appearance, activity } = useAppearance();
  const [held, setHeld] = useState(false);
  useEffect(() => { if (!speechAvailable) setHeld(false); }, [speechAvailable]);
  const tool = TOOLS[scene];
  return <div className="room-tools" data-tool-scene={scene} data-source-open={sourceOpen}>
    <div className="source-stage-art" aria-hidden="true" />
    {scene === "study-bench" && <>
      <div className="source-paper-track" aria-hidden="true"><div className="source-paper-art" /><div className="source-paper-grain" /></div>
    </>}
    <button className="source-handle" type="button" aria-label={scene === "study-bench" ? sourceOpen ? "Roll up lecture source" : "Unroll lecture source" : undefined} aria-expanded={sourceOpen} aria-controls="review-source" onClick={event => onSource(event.currentTarget)}>
      <span className="room-tool-name">{tool.name}</span>
      <span>{scene === "study-bench" ? "Lecture source" : sourceOpen ? "Close lecture source" : tool.action}</span>
    </button>
    <div className="scene-foreground">
      {appearance.visible && <Companion id={appearance.companion} activity={activity} />}
      <div className="recorder-tool" data-depressed={speechAvailable && (held || listening)}><span className="recorder-art" aria-hidden="true" />
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
      </button></div>
      <div className="journal-tool"><Link to={{ page: "record", reviewId: null }}>
        <span className="journal-art" aria-hidden="true" /><span className="physical-tool-label">My notebook</span>
      </Link></div>
      {!appearance.visible && <span className="quiet-status" role="status">{activity === "idle" ? "Ready when you are" : activity === "waiting" ? "Waiting for a response" : activity === "listening" ? "Listening" : activity === "saving" ? "Saving your record" : "Review paused"}</span>}
    </div>
  </div>;
}
