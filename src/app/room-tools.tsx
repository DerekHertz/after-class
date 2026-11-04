import type { SceneId } from "./appearance";
import { RoomDrawing } from "./scene";

const TOOLS = {
  "last-desk": { name: "Lecture stand", action: "Unfold the source" },
  "projection-booth": { name: "Lecture projector", action: "Switch on the source" },
  "study-bench": { name: "Evidence drawer", action: "Pull out the source" },
} as const;

function SourceProp({ scene, open }: { readonly scene: SceneId; readonly open: boolean }) {
  return <svg viewBox="0 0 330 230" className="room-source-drawing" aria-hidden="true" focusable="false">
    <g stroke="#393a34" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round">
      <path d="M35 191L185 223L306 178L159 147Z" fill="#233451" opacity=".2" stroke="none" />
      {scene === "last-desk" && <>
        <path d="M52 171L68 192L221 163L205 143Z" fill="#b3864b" />
        <path d="M68 192L68 199L222 169L221 163Z" fill="#91693e" />
        <path d="M81 172L89 120L101 122L96 169M191 149L177 111L186 107L203 147" fill="#6a7767" />
        <path d="M69 153L72 28L213 16L225 137Z" fill="#dfb66e" />
        <path d="M69 153L61 145L63 25L72 28Z" fill="#aa7d42" />
        <path d="M72 28L63 25L205 12L213 16Z" fill="#f3ce89" />
        <path d="M82 139L84 40L201 30L211 128Z" fill="#fff4d8" />
        <path d="M91 56L184 49M92 65L164 59" stroke="#a5b39e" strokeWidth="2" />
        <path d="M96 86L185 79M97 98L180 91M98 110L162 104" fill="none" stroke="#a5b39e" strokeWidth="2" />
        <path d="M157 80L164 84L157 88M135 108L128 112L136 116" fill="none" stroke="#3e638f" strokeWidth="2" />
        <path d="M94 128L188 120" stroke="#c8bda5" />
        <path d="M94 23Q92 7 101 7Q112 6 111 21M180 17Q178 2 188 2Q199 1 199 15" fill="none" stroke="#6b7366" strokeWidth="5" />
        <circle cx="77" cy="34" r="2.5" fill="#91784a" /><circle cx="211" cy="27" r="2.5" fill="#91784a" /><circle cx="77" cy="144" r="2.5" fill="#91784a" /><circle cx="216" cy="132" r="2.5" fill="#91784a" />
        <path d="M80 177L201 154" stroke="#e7c98e" /><path d="M90 185L213 161" stroke="#8d6339" />
      </>}
      {scene === "projection-booth" && <>
        <path d="M171 18H306V28H171Z" fill="#a89470" /><path d="M178 28H299V132H178Z" fill="#fff0ce" /><path d="M173 132H304V141H173Z" fill="#a89470" />
        <path d="M188 45H279M188 56H258M188 67H273" stroke="#a1b199" strokeWidth="2" />
        <path d="M126 92L244 42L244 124Z" fill="#efc86d" opacity={open ? ".26" : ".06"} stroke="none" />
        <path d="M47 131L104 112L151 130L149 179L92 201L47 181Z" fill="#8da795" />
        <path d="M92 148L151 130L149 179L92 201Z" fill="#c9c5a5" />
        <path d="M47 131L92 148L92 201L47 181Z" fill="#688c78" />
        <path d="M54 153L78 161M54 160L78 168M54 167L78 175" fill="none" stroke="#3d6156" strokeWidth="3" />
        <circle cx="69" cy="87" r="36" fill="#d9cba7" /><circle cx="69" cy="87" r="26" fill="#b9b99b" /><circle cx="69" cy="87" r="8" fill="#6e7765" />
        <path d="M69 64V70M47 87H53M69 104V110M85 87H91" stroke="#6e7765" strokeWidth="5" />
        <circle cx="122" cy="115" r="28" fill="#e2d3b1" /><circle cx="122" cy="115" r="19" fill="#b9b99b" /><circle cx="122" cy="115" r="6" fill="#6e7765" />
        <path d="M64 124L73 138L97 142L113 137" fill="none" stroke="#4f6154" strokeWidth="3" />
        <path d="M143 144L163 138L164 162L144 169Z" fill="#576e66" /><ellipse cx="164" cy="150" rx="7" ry="12" fill={open ? "#e8bf65" : "#c1bda0"} />
        <circle cx="114" cy="170" r="11" fill="#355485" /><circle cx="114" cy="170" r="4" fill="#dfbe73" />
        <path d="M56 184V196L68 200V189M128 187V197L139 193V183" fill="#344c4b" /><path d="M105 151L132 142" stroke="#f5e8c9" />
      </>}
      {scene === "study-bench" && <>
        <path d="M50 75L211 44L280 77L119 112Z" fill="#b5d1b8" />
        <path d="M50 75L119 112L119 176L50 138Z" fill="#7eaa91" />
        <path d="M119 112L280 77L280 141L119 176Z" fill="#94baa0" />
        <path d="M58 88L104 112M58 98L104 122M58 108L104 132" stroke="#537d69" strokeWidth="3" />
        <path d="M144 123L255 98L255 132L144 158Z" fill="#4d7161" />
        <path d={open ? "M144 157L207 190L310 163L255 132Z" : "M144 139L255 114L255 132L144 158Z"} fill="#d5dfc5" />
        <path d={open ? "M144 157L207 190L207 209L144 175Z" : "M144 139L144 158L255 132L255 114Z"} fill="#73977f" />
        {open && <><path d="M207 190L310 163L310 182L207 209Z" fill="#86a88c" /><path d="M166 157L251 138L288 158L204 180Z" fill="#fff1d1" /><path d="M190 157L247 145M200 163L257 151M210 168L267 156" stroke="#b8baa4" /><path d="M247 187L274 180L274 188L247 195Z" fill="#d6be7b" /></>}
        {!open && <path d="M184 139L211 133L211 141L184 148Z" fill="#d6be7b" />}
        <circle cx="98" cy="88" r="14" fill="#355a89" /><circle cx="98" cy="88" r="5" fill="#dbc17c" />
        <path d="M145 82L176 75L188 81L157 89Z" fill="#dc8262" /><path d="M145 82V89L157 96L188 88V81L157 89Z" fill="#b8624d" />
        <path d="M64 145V158L78 165V152M252 148V160L266 156V144" fill="#466c5c" />
        <circle cx="60" cy="82" r="2.5" fill="#e7d7a6" /><circle cx="266" cy="85" r="2.5" fill="#e7d7a6" /><path d="M219 64L251 74" stroke="#e4ecd1" />
      </>}
    </g>
  </svg>;
}

export function RoomTools({ scene, onSource, sourceOpen }: { readonly scene: SceneId; readonly onSource: () => void; readonly sourceOpen: boolean }) {
  const tool = TOOLS[scene];
  return <div className="room-tools" data-tool-scene={scene}>
    <div className="room-tools-setting" aria-hidden="true"><RoomDrawing id={scene} /></div>
    <button className="room-source-tool" type="button" aria-expanded={sourceOpen} aria-controls="review-source" onClick={onSource}>
      <SourceProp scene={scene} open={sourceOpen} />
      <span className="room-tool-name">{tool.name}</span>
      <span className="room-tool-action">{sourceOpen ? "Close lecture source" : tool.action}</span>
    </button>
  </div>;
}
