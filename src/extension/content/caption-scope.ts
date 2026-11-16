// Shared between the page-world tap and the isolated content script. The nonce separates
// successive observations of the same video. It is a lifecycle marker, not a credential.
export const CAPTION_SCOPE_EVENT = "afterclass-caption-scope";
export const MAX_CAPTION_BYTES = 2 * 1024 * 1024;
