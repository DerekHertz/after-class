import type { ReactNode } from "react";
import { COMPANIONS, SCENES, useAppearance } from "./appearance";
import type { CompanionId, SceneId } from "./appearance";
import { Companion, CompanionDrawing } from "./companion";
import { Link } from "./ui";
import "./scene.css";

export function RoomDrawing({ id }: { readonly id: SceneId }) {
  return <svg viewBox="0 0 180 112" aria-hidden="true" focusable="false" className="room-drawing">
    <g stroke="#3d3b33" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round">
      <path d="M14 94L112 108L170 78L72 65Z" fill="#273652" opacity=".22" stroke="none" />
      {id === "last-desk" && <>
        <path d="M19 63L19 14L108 7L108 54Z" fill="#8dad97" /><path d="M19 63L108 54L114 59L24 70Z" fill="#c99c62" /><path d="M25 20L101 14L101 48L25 56Z" fill="#648b77" />
        <path d="M27 72L30 101L36 104L36 76M135 62L139 92L145 95L144 64" fill="#547066" /><path d="M17 68L103 48L155 61L70 87Z" fill="#e6bd7d" /><path d="M17 68L70 87L155 61L155 68L70 95L17 76Z" fill="#b98648" />
        <path d="M70 59L95 55L118 62L93 70L69 65Z" fill="#fff1d2" /><path d="M94 56L93 68" fill="none" /><path d="M51 31L76 29M51 37L87 33" stroke="#dce9d4" />
        <path d="M112 53L109 28L131 24L139 51Z" fill="#d8aa58" /><path d="M115 47L113 32L128 29L134 45Z" fill="#f6e9c8" /><path d="M41 74L57 70L72 75L56 81Z" fill="#36558b" /><path d="M57 73L63 75L57 78L51 76Z" fill="#db835b" />
      </>}
      {id === "projection-booth" && <>
        <path d="M19 82L100 66L160 81L77 102Z" fill="#99633f" /><path d="M19 82L77 102L160 81L160 88L77 109L19 90Z" fill="#714c38" />
        <path d="M90 17L160 17L160 71L90 71Z" fill="#f5e6c5" /><path d="M85 14H165V20H85ZM87 71H163V76H87Z" fill="#b59265" /><path d="M123 21L76 55L123 68Z" fill="#e8bc66" opacity=".3" stroke="none" />
        <path d="M31 56L62 50L80 61L78 84L47 92L30 79Z" fill="#88a58c" /><path d="M47 64L77 58L77 83L47 91Z" fill="#d5caab" /><circle cx="47" cy="36" r="17" fill="#d5c4a3" /><circle cx="47" cy="36" r="5" fill="#746652" /><circle cx="65" cy="58" r="13" fill="#d5c4a3" /><circle cx="65" cy="58" r="4" fill="#746652" /><path d="M34 34L42 32M50 23V29M51 43L56 48M57 30L60 26" fill="none" strokeWidth="4" /><path d="M80 64L91 65L91 76L79 78Z" fill="#d9ad57" />
        <path d="M109 34H146M109 43H137M109 52H142" stroke="#a6b6ac" />
      </>}
      {id === "study-bench" && <>
        <path d="M17 78L102 58L161 77L74 101Z" fill="#d5a96c" /><path d="M17 78L74 101L161 77L161 84L74 108L17 85Z" fill="#ac7b45" />
        <path d="M28 58L109 43L145 59L143 82L65 99L28 82Z" fill="#89b39e" /><path d="M65 75L145 59L143 82L65 99Z" fill="#729a85" />
        <path d="M57 68L54 18L112 8L119 55Z" fill="#fff0cd" /><path d="M54 18Q57 8 68 10L112 8Q122 10 120 19L113 21L111 15L60 24" fill="#e7d5ad" />
        <path d="M63 31L105 24M64 42L108 34M65 53L111 45" stroke="#b5bca8" /><path d="M41 69L53 66L59 72L47 76Z" fill="#d97b5c" /><path d="M74 74L96 69L105 74L82 80Z" fill="#36558b" /><circle cx="121" cy="72" r="8" fill="#36558b" /><circle cx="121" cy="72" r="3" fill="#ccb878" /><path d="M31 66L38 69M31 73L38 76" fill="none" /><path d="M133 55L151 51L162 57L145 62Z" fill="#f0e3c2" />
      </>}
    </g>
  </svg>;
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
  return <div className="scene-shell" data-scene={appearance.scene} data-motion={appearance.motion}>
    <header className="scene-masthead">
      <Link to={{ page: "home" }}><svg viewBox="0 0 28 32" aria-hidden="true" focusable="false"><path d="M5 25Q8 21 8 13Q8 4 14 4Q20 4 20 13Q20 21 23 25Z" fill="#e6ba57" stroke="currentColor" strokeWidth="1.7" /><path d="M3 26H25M11 29Q14 33 17 29M14 0V3" fill="none" stroke="currentColor" strokeWidth="1.7" /></svg><span>After Class</span></Link>
      <span className="room-name">{SCENES[appearance.scene].name}</span><AppearancePicker />
    </header>
    <div className="room-atmosphere" aria-hidden="true"><RoomDrawing id={appearance.scene} /></div>
    <div className="scene-content">{children}</div>
    <footer className="scene-footer">
      {appearance.visible ? <Companion id={appearance.companion} activity={activity} /> : <span className="quiet-status">{activity === "idle" ? "Ready when you are" : activity === "waiting" ? "Waiting for a response" : activity === "listening" ? "Listening" : activity === "saving" ? "Saving your record" : "Review paused"}</span>}
      <p>A little space to make sense of what you watched.</p>
    </footer>
  </div>;
}
