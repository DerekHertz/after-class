import type { SceneId } from "../appearance";
import type { UnlockId } from "./progress";
import railWide from "../assets/room-plates/rail-wide.webp";
import harborWide from "../assets/room-plates/harbor-wide.webp";
import canalWide from "../assets/room-plates/canal-wide.webp";
import railBackground from "../assets/front-row-v2/rail-background.webp";
import harborBackground from "../assets/front-row-v2/harbor-background.webp";
import canalBackground from "../assets/front-row-v2/canal-background.webp";
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

/** A room's pictures as bundle URLs: the wide plate the full room is drawn from, and the background a phone is drawn over. */
export type RoomArt = { readonly plate: string; readonly background: string };

/**
 * The files the stage draws for each room. The bundler names each `<stem>-<hash>.webp`, which is how scripts/build-app.ts
 * finds them for the page's preload and prefetch table.
 */
export const ROOM_LAYER_ART: { readonly [S in SceneId]: RoomArt } = {
  "last-desk": { plate: railWide, background: railBackground },
  "study-bench": { plate: harborWide, background: harborBackground },
  "projection-booth": { plate: canalWide, background: canalBackground },
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
