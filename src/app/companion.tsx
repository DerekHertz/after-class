import type { CompanionActivity, CompanionId } from "./appearance";
import { COMPANIONS } from "./appearance";

function Moth({ variant }: { readonly variant: CompanionId }) {
  const moon = variant === "mote-moonlit", page = variant === "mote-pagewing";
  return <>
    <path d="M62 62C43 17 8 27 15 58C-1 67 9 109 57 105L70 79Z" fill={page ? "#dfc69b" : "#e7d9bd"} />
    <path d="M64 63C39 32 8 56 10 80C15 108 52 108 66 88Z" fill="#fff1cf" />
    <path d="M66 72L13 80M58 55L24 49M62 84L27 99" fill="none" stroke="#bfae90" strokeWidth="1.2" />
    <path d="M36 63C23 80 34 95 48 89C37 89 30 78 36 63Z" fill={moon ? "#68749a" : "#8b9aaa"} stroke="none" />
    <path d="M62 83C48 103 54 116 76 115L101 110L99 79Z" fill={moon || page ? "#f5e5c4" : "#344f80"} />
    {!moon && !page && <path d="M76 82L78 112M67 86L74 95L80 85L89 96L95 84" fill="none" stroke="#c3d0d8" />}
    <path d="M70 111Q60 110 62 121Q75 126 80 117M88 111Q81 118 89 123Q105 126 104 114" fill="#f5e5c4" />
    <path d="M63 47Q64 27 52 19M83 42Q86 19 95 13" fill="none" stroke="#8f5b28" strokeWidth="3" />
    <path d="M52 21C36 21 35 9 43 9Q58 8 55 20M94 15C90 4 101 1 107 7Q113 15 96 19" fill="#e5aa48" />
    <path d="M54 41L58 35L66 36L70 30L76 34L83 30L88 35L96 35L98 41L105 45L103 52L109 57L105 64L107 70L100 74L99 81L91 81L87 87L79 84L72 87L66 83L59 84L56 78L50 76L51 68L46 62L50 56L49 49Z" fill="#f5e5c4" />
    <ellipse cx="76" cy="59" rx="2.5" ry="4.2" fill="#342a27" stroke="none" transform="rotate(-12 76 59)" /><ellipse cx="96" cy="55" rx="2.5" ry="4.2" fill="#342a27" stroke="none" transform="rotate(-12 96 55)" />
    <path d="M85 67q3-3 6-1" fill="none" strokeWidth="1.5" />
    {moon ? <><path d="M58 77Q78 92 100 77L98 89Q79 99 58 88Z" fill="#333b60" /><path d="M65 89L57 117L66 112L73 118L79 91" fill="#3d476c" /></> : <><path d="M93 79L59 109" stroke={page ? "#7b8152" : "#b57a35"} strokeWidth="6" /><path d="M51 97L70 99L68 120L47 117Z" fill={page ? "#7b8152" : "#bd883f"} /><path d="M51 98L69 100L67 108L50 107Z" fill={page ? "#9b9d66" : "#daa45d"} /><path d="M58 105v6" stroke="#e7c363" /></>}
  </>;
}
export function CompanionDrawing({ id }: { readonly id: CompanionId }) {
  return <svg viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" className="companion-drawing">
    <g stroke="#41392f" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round">
      <ellipse cx="70" cy="126" rx="52" ry="7" fill="#243252" opacity=".16" stroke="none" />
      {id.startsWith("mote") && <Moth variant={id} />}
      {id === "pip" && <>
        <path d="M39 28L80 16L105 31L111 102L65 119L43 103Z" fill="#eee1be" /><path d="M39 28L59 40L65 119L43 103Z" fill="#d4c29e" />
        <path d="M39 28Q39 18 50 15L79 7Q88 6 94 13L105 23L106 43L61 57L40 44Z" fill="#e78c72" /><path d="M40 29L60 40L61 57L40 44Z" fill="#c66555" />
        <path d="M63 42L100 29" stroke="#f5b198" /><path d="M47 85L107 66L109 76L49 96Z" fill="#d4a047" />
        <ellipse cx="76" cy="69" rx="2.7" ry="3.5" fill="#352c2a" stroke="none" /><ellipse cx="96" cy="63" rx="2.7" ry="3.5" fill="#352c2a" stroke="none" />
        <path d="M69 107L71 122Q80 129 86 120L83 103M94 100L97 116Q109 121 111 111L107 96" fill="#345888" /><path d="M57 86Q46 80 47 93Q49 104 64 103M98 78Q107 69 111 77Q114 88 102 93" fill="#f5e7c8" />
      </>}
      {id === "lumi" && <>
        <path d="M34 111Q67 94 100 109L109 120Q73 139 33 123Z" fill="#2c4673" /><ellipse cx="69" cy="109" rx="36" ry="12" fill="#46699c" />
        <path d="M64 106L38 65L69 40" stroke="#c5b78e" strokeWidth="10" /><path d="M64 106L38 65L69 40" stroke="#41392f" strokeWidth="1.5" />
        <circle cx="39" cy="65" r="7" fill="#dfbf69" /><circle cx="64" cy="104" r="7" fill="#dfbf69" /><path d="M36 65h6M39 62v6M61 104h6M64 101v6" />
        <path d="M63 29L84 14Q104 19 112 38L128 64Q102 85 75 71L62 48Z" fill="#e7bd56" /><path d="M68 31Q85 14 104 35" stroke="#f6d985" strokeWidth="3" /><ellipse cx="102" cy="65" rx="29" ry="15" transform="rotate(-20 102 65)" fill="#fff0bf" />
        <ellipse cx="94" cy="64" rx="2.2" ry="3.5" fill="#352c2a" stroke="none" /><ellipse cx="111" cy="58" rx="2.2" ry="3.5" fill="#352c2a" stroke="none" /><path d="M101 70q4 3 7-2" strokeWidth="1.5" />
        <path d="M81 23L86 30M90 19L95 27" /><path d="M82 109L91 105L98 109L89 113Z" fill="#dfac43" />
      </>}
      {id === "yun" && <>
        <path d="M36 101Q12 97 19 80Q26 65 41 82Q31 59 46 55L70 78L85 110Z" fill="#93a88f" /><path d="M54 78Q42 90 43 108Q59 129 94 116Q117 104 98 83Z" fill="#efe4ce" />
        <path d="M76 108Q45 89 34 107Q22 123 46 126Q72 132 82 115Q89 104 76 101Q68 102 70 109" fill="#a4b59b" />
        <path d="M42 47Q29 31 45 27Q36 10 54 12Q63 0 77 14Q94 5 101 22Q121 16 120 35Q139 44 126 61Q134 83 115 85Q105 102 89 91Q69 102 62 88Q42 89 43 73Q26 65 42 47Z" fill="#f1e8d5" />
        <path d="M58 28Q44 10 55 6Q65 7 69 30M101 26Q97 9 108 10Q119 16 114 33" fill="#95ab91" />
        <path d="M49 51Q28 41 32 58Q40 70 52 63M120 43Q137 35 135 51Q130 62 120 59" fill="#e3c4b1" />
        <path d="M82 36Q71 28 68 38Q66 48 77 48" stroke="#d3bca0" /><ellipse cx="83" cy="61" rx="3.5" ry="5.5" fill="#33302b" stroke="none" /><ellipse cx="112" cy="56" rx="3.5" ry="5.5" fill="#33302b" stroke="none" />
        <path d="M95 72q3 2 5-1" strokeWidth="1.5" /><path d="M64 84Q87 96 113 82L111 92Q88 105 64 94Z" fill="#b76448" /><path d="M99 95L106 113L115 109L110 92" fill="#c17953" /><path d="M75 101q-8 10-1 16M94 101q-6 9 2 13" fill="#f1e8d5" />
      </>}
    </g>
  </svg>;
}
const STATUS: Record<CompanionActivity, string> = { idle: "Ready when you are", listening: "Listening", waiting: "Waiting for a response", paused: "Review paused", saving: "Saving your record" };
export function Companion({ id, activity }: { readonly id: CompanionId; readonly activity: CompanionActivity }) {
  return <div className="study-companion" data-activity={activity}>
    <CompanionDrawing id={id} />
    <div><span className="companion-name">{COMPANIONS[id].name}</span><span className="companion-status" role="status">{STATUS[activity]}</span></div>
  </div>;
}
