import type { SceneId } from "./appearance";
import { useAppearance } from "./appearance";
import { Companion } from "./companion";
import { Link } from "./ui";

const TOOLS = {
  "last-desk": { name: "Lecture stand", action: "Open the lecture" },
  "projection-booth": { name: "Lecture projector", action: "Switch on the source" },
  "study-bench": { name: "Evidence drawer", action: "Pull out the source" },
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
  const tool = TOOLS[scene];
  return <div className="room-tools" data-tool-scene={scene} data-source-open={sourceOpen}>
    <div className="source-stage-art" aria-hidden="true" />
    <button className="source-handle" type="button" aria-expanded={sourceOpen} aria-controls="review-source" onClick={event => onSource(event.currentTarget)}>
      <span className="room-tool-name">{tool.name}</span>
      <span>{sourceOpen ? "Close lecture source" : tool.action}</span>
    </button>
    <div className="scene-foreground">
      {appearance.visible && <Companion id={appearance.companion} activity={activity} />}
      <button type="button" className="recorder-tool" aria-label={listening ? "Stop listening with recorder" : "Speak with recorder"} disabled={!speechAvailable} aria-pressed={listening} onClick={onSpeak}>
        <span className="recorder-art" aria-hidden="true" />
        <span className="physical-tool-label">{listening ? "Stop" : "Speak"}</span>
      </button>
      <div className="journal-tool"><Link to={{ page: "record", reviewId: null }}>
        <span className="journal-art" aria-hidden="true" /><span className="physical-tool-label">My notebook</span>
      </Link></div>
      {!appearance.visible && <span className="quiet-status" role="status">{activity === "idle" ? "Ready when you are" : activity === "waiting" ? "Waiting for a response" : activity === "listening" ? "Listening" : activity === "saving" ? "Saving your record" : "Review paused"}</span>}
    </div>
  </div>;
}
