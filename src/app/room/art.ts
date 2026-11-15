import type { SceneId } from "../appearance";
import type { FRONT_ROW_ROOMS } from "./rooms";
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
