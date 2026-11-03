/**
 * The review app's response decoders. The schemas live in `src/shared/wire.ts`, shared with the backend's `ROUTES`
 * table, so a change to a response shape cannot drift between the two sides. This file only keeps the app's local names.
 */
export {
  captureResponse as captureResponsez,
  evidenceBundleResponse as evidenceBundlez,
  encodeMaterial,
  materialWire as materialz,
  recordViewResponse as recordViewz,
  reviewOptionsResponse as reviewOptionsz,
  reviewViewResponse as reviewViewz,
  saveResponse as saveResultz,
  startReviewResponse as startResultz,
  tutorStreamEvent as turnEventz,
  usageResponse as usageSummaryz,
} from "../shared/wire";
export type { CaptureResponse } from "../shared/wire";
