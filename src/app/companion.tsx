import { useEffect, useRef } from "react";
import type { CompanionActivity, CompanionId } from "./appearance";
import { COMPANIONS, useAppearance } from "./appearance";
import { clearCompanionReaction, useCompanionReaction } from "./companion-reaction";
import type { CompanionGesture } from "./companion-reaction";

/** The columns of every companion sheet, left to right: at rest, drawing a source card, reading the notebook. */
export const POSES = ["idle", "draw", "read"] as const;
export type Pose = (typeof POSES)[number];

/**
 * Each companion is one transparent sheet in assets/companions-v3, three equal cells wide. `cell` is one cell's size in
 * pixels; the sheet URL lives in hd-companion.css so the bundler resolves it.
 */
export const COMPANION_SPRITES = {
  pip: { cell: { width: 724, height: 724 } },
  mote: { cell: { width: 724, height: 724 } },
  lumi: { cell: { width: 724, height: 724 } },
  "mote-moonlit": { cell: { width: 724, height: 724 } },
  yun: { cell: { width: 724, height: 724 } },
  "mote-pagewing": { cell: { width: 724, height: 724 } },
} as const satisfies Record<CompanionId, { readonly cell: { readonly width: number; readonly height: number } }>;

/** A reaction shows its own pose; with no reaction the companion is at rest. Reduced motion holds the rest pose in CSS. */
export function companionPose(gesture: CompanionGesture | undefined): Pose {
  return gesture ?? "idle";
}

export function CompanionDrawing({ id, gesture, sequence = 0 }: {
  readonly id: CompanionId;
  readonly gesture?: CompanionGesture | undefined;
  readonly sequence?: number | undefined;
}) {
  const { cell } = COMPANION_SPRITES[id];
  const pose = companionPose(gesture);
  return <span className="companion-drawing companion-raster companion-sprite" data-companion={id} data-gesture={gesture} data-pose={pose} aria-hidden="true" style={{ "--cell-aspect": `${cell.width} / ${cell.height}` }}>
    <span key={sequence} className="companion-pose" style={{ "--pose": POSES.indexOf(pose) }} />
  </span>;
}
export const COMPANION_STATUS: Readonly<Record<CompanionActivity, string>> = { idle: "Ready when you are", listening: "Listening", waiting: "Waiting for a response", paused: "Review paused", saving: "Saving your record" };
export function Companion({ id, activity }: { readonly id: CompanionId; readonly activity: CompanionActivity }) {
  const { appearance } = useAppearance();
  const reaction = useCompanionReaction();
  const skin = `${appearance.scene}/${id}/${appearance.visible}`;
  const previousSkin = useRef(skin);
  useEffect(() => {
    if (previousSkin.current !== skin) clearCompanionReaction();
    previousSkin.current = skin;
  }, [skin]);
  return <div className="study-companion" data-activity={activity} data-reaction={reaction?.kind}>
    <CompanionDrawing id={id} gesture={reaction?.kind} sequence={reaction?.sequence} />
    <div><span className="companion-name">{COMPANIONS[id].name}</span><span className="companion-status" role="status">{COMPANION_STATUS[activity]}</span></div>
  </div>;
}
