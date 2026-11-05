import type { ReactNode } from "react";
import { COMPANIONS, SCENES, useAppearance } from "./appearance";
import type { CompanionId, SceneId } from "./appearance";
import { Companion, CompanionDrawing } from "./companion";
import { Link } from "./ui";

export function RoomDrawing({ id }: { readonly id: SceneId }) {
  return <span className="room-drawing room-raster" data-room={id} aria-hidden="true" />;
}
function AppearancePicker() {
  const { appearance, update, persistent } = useAppearance();
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
      </div>
      <p className="appearance-footnote">Room and companion choices are independent. Your system's reduced-motion setting is always respected. Preferences stay in this browser.</p>
      {!persistent && <p className="appearance-storage-note" role="status">Appearance works for this visit. This browser could not save your preferences.</p>}
    </div>
  </details>;
}
export function SceneShell({ children }: { readonly children: ReactNode }) {
  const { appearance, activity } = useAppearance();
  return <div className="scene-shell" data-scene={appearance.scene} data-motion={appearance.motion} data-detail={appearance.detail}>
    <header className="scene-masthead">
      <Link to={{ page: "home" }}><span className="bell-mark" aria-hidden="true" /><span>After Class</span></Link>
      <span className="room-name">{SCENES[appearance.scene].name}</span><AppearancePicker />
    </header>
    <div className="scene-content">{children}</div>
    <footer className="scene-footer">
      {appearance.visible ? <Companion id={appearance.companion} activity={activity} /> : <span className="quiet-status">{activity === "idle" ? "Ready when you are" : activity === "waiting" ? "Waiting for a response" : activity === "listening" ? "Listening" : activity === "saving" ? "Saving your record" : "Review paused"}</span>}
      <p>A little space to make sense of what you watched.</p>
    </footer>
  </div>;
}
