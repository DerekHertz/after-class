import { useState } from "react";
import type { ReactNode } from "react";
import { COMPANIONS, SCENES, useAppearance } from "./appearance";
import type { CompanionId, SceneId } from "./appearance";
import { COMPANION_STATUS, Companion, CompanionDrawing } from "./companion";
import { ReviewStageClaim, roomStyle, useFullRoom } from "./front-row";
import { useMotion } from "./room/motion";
import { useReaction } from "./room/reaction-store";
import { RoomStage } from "./room/stage";
import { ShowTutorialAgain, TutorialBubble } from "./tutorial";
import { Link } from "./ui";

export function RoomDrawing({ id }: { readonly id: SceneId }) {
  return <span className="room-drawing room-raster" data-room={id} aria-hidden="true" />;
}
function AppearancePicker() {
  const { appearance, update, persistent, voice, setVoice } = useAppearance();
  return <details className="appearance-picker">
    <summary>Room &amp; companion</summary>
    <div className="appearance-options">
      <p className="appearance-intro">Make yourself at home.</p>
      <fieldset><legend>Your room</legend><div className="room-choices">
        {(Object.entries(SCENES) as [SceneId, typeof SCENES[SceneId]][]).map(([id, scene]) => <button key={id} type="button" className="room-choice" aria-pressed={appearance.scene === id} onClick={() => update({ scene: id })}>
          <RoomDrawing id={id} /><span>{scene.name}</span><small>{scene.detail}</small>
        </button>)}
      </div></fieldset>
      <fieldset><legend>Your companion</legend><div className="companion-choices">
        {(Object.entries(COMPANIONS) as [CompanionId, typeof COMPANIONS[CompanionId]][]).map(([id, companion]) => <button key={id} type="button" className="companion-choice" aria-pressed={appearance.companion === id} onClick={() => update({ companion: id })}>
          <CompanionDrawing id={id} /><span>{companion.name}</span><small>{companion.detail}</small>
        </button>)}
      </div></fieldset>
      <div className="appearance-preferences">
        <label><input type="checkbox" checked={appearance.visible} onChange={e => update({ visible: e.target.checked })} /> Show companion</label>
        <label><input type="checkbox" checked={appearance.motion === "reduced"} onChange={e => update({ motion: e.target.checked ? "reduced" : "system" })} /> Reduce motion</label>
        <label><input type="checkbox" checked={voice} onChange={e => setVoice(e.target.checked)} /> Voice (the tutor speaks, and you can speak back)</label>
      </div>
      <p className="appearance-tutorial"><ShowTutorialAgain /></p>
      <p className="appearance-footnote">Room and companion choices are independent. Your system's reduced-motion setting is always respected. Preferences stay in this browser.</p>
      {!persistent && <p className="appearance-storage-note" role="status">Appearance works for this visit. This browser could not save your preferences.</p>}
    </div>
  </details>;
}
/** `account` is the hosted app's sign-out control, shown after the appearance picker. The local app has none. */
export function SceneShell({ children, account }: { readonly children: ReactNode; readonly account?: ReactNode }) {
  const { appearance, activity } = useAppearance();
  const full = useFullRoom();
  const motion = useMotion(appearance.motion, full ? "full" : "compact");
  const reaction = useReaction();
  const [reviewStage, setReviewStage] = useState(false);
  // Outside a review the room is drawn on the review's own stage, so a page shows the same sharp room and the same
  // blinking companion. A review draws its own, and the phone layout keeps the backdrop picture.
  const companion = appearance.visible ? { id: appearance.companion, activity, gesture: reaction === null ? null : { name: reaction.gesture, at: reaction.at } } : null;
  return <ReviewStageClaim.Provider value={setReviewStage}><div className="scene-shell" data-scene={appearance.scene} data-motion={appearance.motion} data-detail={appearance.detail} style={roomStyle(appearance.scene)}>
    <header className="scene-masthead">
      <Link to={{ page: "home" }}><span className="bell-mark" aria-hidden="true" /><span>After Class</span></Link>
      <AppearancePicker />
      {account}
    </header>
    {full && !reviewStage && <div className="scene-room"><RoomStage scene={appearance.scene} composition="full" motion={motion} companion={companion} /></div>}
    <div className="scene-content">{children}</div>
    <footer className="scene-footer">
      {appearance.visible ? <Companion id={appearance.companion} activity={activity} /> : <span className="quiet-status">{COMPANION_STATUS[activity]}</span>}
      <p>A little space to make sense of what you watched.</p>
    </footer>
    <TutorialBubble />
  </div></ReviewStageClaim.Provider>;
}
