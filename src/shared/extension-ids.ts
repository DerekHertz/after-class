/**
 * AFTERCLASS_EXTENSION_ID names the extension ids the server accepts, as one id or a comma-separated list. The first is
 * the primary id, the one the Chrome Web Store link names. Later ids are older builds still in use, such as the unpacked
 * hosted build, whose id comes from its manifest key.
 */
const ID = /^[a-p]{32}$/;

/** Splits a list, trims it and drops empty entries. Does not validate. */
export function splitExtensionIds(value: string | null | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
}

/** The server's startup parse: every id must be 32 letters from a to p, and a bad one throws. Unset or empty is no ids. */
export function parseExtensionIds(value: string | undefined): string[] {
  const ids = splitExtensionIds(value);
  const bad = ids.find((id) => !ID.test(id));
  if (bad !== undefined) throw new Error(`AFTERCLASS_EXTENSION_ID must list extension ids of 32 letters from a to p, separated by commas, got "${bad}"`);
  return [...new Set(ids)];
}

/** Whether a request Origin is `chrome-extension://<id>` for one of the listed ids. */
export function isExtensionOrigin(origin: string | null, ids: string | null | undefined): boolean {
  if (origin === null) return false;
  return splitExtensionIds(ids).some((id) => origin === `chrome-extension://${id}`);
}
