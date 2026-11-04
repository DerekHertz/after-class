import type { CompanionActivity, CompanionId } from "./appearance";
import { COMPANIONS } from "./appearance";

export function CompanionDrawing({ id }: { readonly id: CompanionId }) {
  return <span className="companion-drawing companion-raster" data-companion={id} aria-hidden="true" />;
}
const STATUS: Record<CompanionActivity, string> = { idle: "Ready when you are", listening: "Listening", waiting: "Waiting for a response", paused: "Review paused", saving: "Saving your record" };
export function Companion({ id, activity }: { readonly id: CompanionId; readonly activity: CompanionActivity }) {
  return <div className="study-companion" data-activity={activity}>
    <CompanionDrawing id={id} />
    <div><span className="companion-name">{COMPANIONS[id].name}</span><span className="companion-status" role="status">{STATUS[activity]}</span></div>
  </div>;
}
