import { useEffect, useRef } from "react";
import type { CompanionActivity, CompanionId } from "./appearance";
import { COMPANIONS, useAppearance } from "./appearance";
import { clearCompanionReaction, useCompanionReaction } from "./companion-reaction";
import type { CompanionGesture } from "./companion-reaction";

export function CompanionDrawing({ id, gesture, sequence = 0 }: {
  readonly id: CompanionId;
  readonly gesture?: CompanionGesture | undefined;
  readonly sequence?: number | undefined;
}) {
  const { appearance } = useAppearance();
  const hd = appearance.detail === "hd-pixel";
  return <span className={`companion-drawing companion-raster${hd ? " hd-companion" : ""}`} data-companion={id} data-gesture={gesture} aria-hidden="true">
    {hd && <span key={sequence} className="hd-companion-pose" />}
  </span>;
}
const STATUS: Record<CompanionActivity, string> = { idle: "Ready when you are", listening: "Listening", waiting: "Waiting for a response", paused: "Review paused", saving: "Saving your record" };
export function Companion({ id, activity }: { readonly id: CompanionId; readonly activity: CompanionActivity }) {
  const { appearance } = useAppearance();
  const reaction = useCompanionReaction();
  const skin = `${appearance.scene}/${id}/${appearance.detail}/${appearance.visible}`;
  const previousSkin = useRef(skin);
  useEffect(() => {
    if (previousSkin.current !== skin) clearCompanionReaction();
    previousSkin.current = skin;
  }, [skin]);
  return <div className="study-companion" data-activity={activity} data-reaction={reaction?.kind}>
    <CompanionDrawing id={id} gesture={reaction?.kind} sequence={reaction?.sequence} />
    <div><span className="companion-name">{COMPANIONS[id].name}</span><span className="companion-status" role="status">{STATUS[activity]}</span></div>
  </div>;
}
