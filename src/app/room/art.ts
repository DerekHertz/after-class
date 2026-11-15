import type { SceneId } from "../appearance";
import type { FRONT_ROW_ROOMS } from "./rooms";
import type { UnlockId } from "./progress";
import railBackground from "../assets/front-row-v2/rail-background.webp";
import railBoard from "../assets/front-row-v2/rail-board.webp";
import railDesk from "../assets/front-row-v2/rail-desk.webp";
import railMat from "../assets/front-row-v2/rail-mat.webp";
import railLedgeItems from "../assets/front-row-v2/rail-ledge-items.webp";
import railVine from "../assets/front-row-v2/rail-vine.webp";
import harborBackground from "../assets/front-row-v2/harbor-background.webp";
import harborBoard from "../assets/front-row-v2/harbor-board.webp";
import harborDesk from "../assets/front-row-v2/harbor-desk.webp";
import harborMat from "../assets/front-row-v2/harbor-mat.webp";
import harborLamp from "../assets/front-row-v2/harbor-lamp.webp";
import harborAwning from "../assets/front-row-v2/harbor-awning.webp";
import harborCushion from "../assets/front-row-v2/harbor-cushion.webp";
import canalBackground from "../assets/front-row-v2/canal-background.webp";
import canalBoard from "../assets/front-row-v2/canal-board.webp";
import canalDesk from "../assets/front-row-v2/canal-desk.webp";
import canalMat from "../assets/front-row-v2/canal-mat.webp";
import canalPullTab from "../assets/front-row-v2/canal-pull-tab.webp";
import canalProjector from "../assets/front-row-v2/canal-projector.webp";
import rail1 from "../assets/unlock-objects/last-desk/1.webp";
import rail2 from "../assets/unlock-objects/last-desk/2.webp";
import rail3 from "../assets/unlock-objects/last-desk/3.webp";
import rail4 from "../assets/unlock-objects/last-desk/4.webp";
import rail5 from "../assets/unlock-objects/last-desk/5.webp";
import rail6 from "../assets/unlock-objects/last-desk/6.webp";
import harbor1 from "../assets/unlock-objects/study-bench/1.webp";
import harbor2 from "../assets/unlock-objects/study-bench/2.webp";
import harbor3 from "../assets/unlock-objects/study-bench/3.webp";
import harbor4 from "../assets/unlock-objects/study-bench/4.webp";
import harbor5 from "../assets/unlock-objects/study-bench/5.webp";
import harbor6 from "../assets/unlock-objects/study-bench/6.webp";
import canal1 from "../assets/unlock-objects/projection-booth/1.webp";
import canal2 from "../assets/unlock-objects/projection-booth/2.webp";
import canal3 from "../assets/unlock-objects/projection-booth/3.webp";
import canal4 from "../assets/unlock-objects/projection-booth/4.webp";
import canal5 from "../assets/unlock-objects/projection-booth/5.webp";
import canal6 from "../assets/unlock-objects/projection-booth/6.webp";

type ExtraName<S extends SceneId> = (typeof FRONT_ROW_ROOMS)[S]["extras"][number]["name"];

/** A room's painted layers as bundle URLs, one file per layer, each stored at plate density. */
export type RoomArt<S extends SceneId = SceneId> = {
  readonly background: string;
  readonly board: string;
  readonly desk: string;
  readonly mat: string;
  readonly extras: Readonly<Record<ExtraName<S>, string>>;
};

/**
 * The files the stage draws for each room. The bundler names each `<stem>-<hash>.webp`, which is how scripts/build-app.ts
 * finds them for the page's preload and prefetch table.
 */
export const ROOM_LAYER_ART: { readonly [S in SceneId]: RoomArt<S> } = {
  "last-desk": { background: railBackground, board: railBoard, desk: railDesk, mat: railMat, extras: { "ledge-items": railLedgeItems, vine: railVine } },
  "study-bench": { background: harborBackground, board: harborBoard, desk: harborDesk, mat: harborMat, extras: { lamp: harborLamp, awning: harborAwning, cushion: harborCushion } },
  "projection-booth": { background: canalBackground, board: canalBoard, desk: canalDesk, mat: canalMat, extras: { "pull-tab": canalPullTab, projector: canalProjector } },
};

/**
 * The painted picture of each unlocked object, as a bundle URL. Each is cut at its slot's box in plate pixels from a Meshy edit
 * of the room (docs/design/live-room/unlocks.md) and recorded in art/manifest.json. It lives here, apart from the slots in
 * unlocks.ts, so code that only lays the room out never imports a picture.
 */
export const UNLOCK_ART: Readonly<Record<UnlockId, string>> = {
  "last-desk/1": rail1, "last-desk/2": rail2, "last-desk/3": rail3, "last-desk/4": rail4, "last-desk/5": rail5, "last-desk/6": rail6,
  "study-bench/1": harbor1, "study-bench/2": harbor2, "study-bench/3": harbor3, "study-bench/4": harbor4, "study-bench/5": harbor5, "study-bench/6": harbor6,
  "projection-booth/1": canal1, "projection-booth/2": canal2, "projection-booth/3": canal3, "projection-booth/4": canal4, "projection-booth/5": canal5, "projection-booth/6": canal6,
};
