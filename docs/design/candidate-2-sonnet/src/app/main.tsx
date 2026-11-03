// app/main.tsx -- entry. Path routing without a router dependency: /review/:captureId -> begin (or resume) -> ReviewScreen;
// /record/:captureId -> RecordScreen; /chunks/:chunkId -> ChunkInspector; /usage -> UsageScreen.
// On /review/:id?begin=now&reviewId=<uuid> it calls api["review.begin"]; started -> ReviewScreen + an initial 'continue' turn (first tutor move),
// processing -> ProcessingPanel, nothing_to_review -> NothingToReview. A PendingSave banner is mounted at the app root from api["review.pendingSaves"].
export function mount(root: HTMLElement): void {
  throw new Error("not implemented");
}
