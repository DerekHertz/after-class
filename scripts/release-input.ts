// The one check for every outside answer the release tool acts on: a release's image-digest.txt, the server probe's
// output with the recorded digest and the app's /health inside it, the public /health, and the ids aws prints. Each is
// matched as raw bytes, whole, against its exact format, before anything converts, trims or splits it, and only the
// fields the format names come out. Nothing here does I/O. scripts/live-release.ts reads the bytes and calls these.

/** The most bytes any answer may have. Anything longer is rejected, never cut. */
export const MAX_BYTES = 4096;

const DIGEST = "sha256:[0-9a-f]{64}";
const VERSION = "(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)";

/**
 * A format is a pattern over the answer's bytes, one character per byte, anchored at both ends with no flags, and the
 * fields it yields. Each pattern is ASCII, so a NUL, a byte order mark, a CR, a C1 or any byte the pattern does not name
 * fails it. A trailing LF passes only where the pattern says so.
 */
export interface Format<T> {
  readonly name: string;
  readonly pattern: RegExp;
  readonly fields: (match: RegExpExecArray) => T;
}

export type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly why: string };

/** Up to 80 bytes of an answer as printable ASCII, every other byte as \xNN, so a hostile answer cannot drive the terminal. */
export function excerpt(bytes: Uint8Array): string {
  const shown = [...bytes.subarray(0, 80)].map((b) => (b >= 0x20 && b < 0x7f && b !== 0x5c ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, "0")}`));
  return `"${shown.join("")}${bytes.length > 80 ? "..." : ""}"`;
}

export function validate<T>(format: Format<T>, bytes: Uint8Array): Checked<T> {
  if (bytes.length > MAX_BYTES) return { ok: false, why: `${format.name} is longer than ${MAX_BYTES} bytes` };
  // latin1 maps each byte to the code point of the same value, so the pattern sees every byte and no byte is merged or dropped.
  const match = format.pattern.exec(Buffer.from(bytes).toString("latin1"));
  if (!match) return { ok: false, why: `${format.name} is not in its format: ${excerpt(bytes)}` };
  return { ok: true, value: format.fields(match) };
}

/** What the release workflow writes: `commit <sha>\ndigest <digest>\n`. */
export const RECORD: Format<{ readonly commit: string; readonly digest: string }> = {
  name: "image-digest.txt",
  pattern: new RegExp(`^commit ([0-9a-f]{40})\\ndigest (${DIGEST})\\n?$`),
  fields: (m) => ({ commit: m[1]!, digest: m[2]! }),
};

/** What afterclass-deploy writes to /data/afterclass/current-image: the digest and a newline. */
export const CURRENT_IMAGE: Format<string> = {
  name: "/data/afterclass/current-image",
  pattern: new RegExp(`^(${DIGEST})\\n?$`),
  fields: (m) => m[1]!,
};

/** The app's /health body, byte for byte: `{"ok":true}` up to v0.1.4, then with `"version":"<major>.<minor>.<patch>"`. */
export const HEALTH: Format<{ readonly version: string | null }> = {
  name: "the /health answer",
  pattern: new RegExp(`^\\{"ok":true(?:,"version":"(${VERSION})")?\\}$`),
  fields: (m) => ({ version: m[1] ?? null }),
};

/** What `aws ssm get-parameter --output text` prints for the beta's instance id. */
export const INSTANCE_ID: Format<string> = {
  name: "the instance id",
  pattern: /^(i-[0-9a-f]{8,17})\n?$/,
  fields: (m) => m[1]!,
};

/** What `aws ssm send-command --output text` prints for the command id. */
export const COMMAND_ID: Format<string> = {
  name: "the command id",
  pattern: /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\n?$/,
  fields: (m) => m[1]!,
};

/**
 * The commands the server runs. They print `image missing` or `image <bytes> <base64>`, then `health <bytes> <base64>`
 * or `unreachable curl exited <code>`, with no newline after the last line. Base64 carries NUL and every other byte
 * through the shell and SSM, and one more byte than the cap is sent, so an over-long file shows as one.
 */
export const PROBE = [
  ". /etc/afterclass/settings.env",
  `if [ -f /data/afterclass/current-image ]; then printf 'image %s %s\\n' "$(wc -c < /data/afterclass/current-image)" "$(head -c ${MAX_BYTES + 1} /data/afterclass/current-image | base64 -w0)"; else printf 'image missing\\n'; fi`,
  `tmp=$(mktemp) && if curl -sS --max-time 5 --max-filesize ${MAX_BYTES} -o "$tmp" "http://127.0.0.1:\${APP_PORT}/health" 2>/dev/null; then printf 'health %s %s' "$(wc -c < "$tmp")" "$(head -c ${MAX_BYTES + 1} "$tmp" | base64 -w0)"; else printf 'unreachable curl exited %s' "$?"; fi; rm -f "$tmp"`,
];

type Carried = { readonly count: string; readonly base64: string };

/** The probe's output as `aws ssm get-command-invocation --output text` prints it: the probe's lines and at most one LF. */
export const PROBE_OUTPUT: Format<{ readonly image: Carried | null; readonly health: Carried | { readonly unreachable: number } }> = {
  name: "the server's probe output",
  pattern: /^image (?:missing|(0|[1-9][0-9]{0,14}) ([A-Za-z0-9+/]*={0,2}))\n(?:health (0|[1-9][0-9]{0,14}) ([A-Za-z0-9+/]*={0,2})|unreachable curl exited (0|[1-9][0-9]{0,2}))\n?$/,
  fields: (m) => ({
    image: m[1] === undefined ? null : { count: m[1], base64: m[2]! },
    health: m[5] === undefined ? { count: m[3]!, base64: m[4]! } : { unreachable: Number(m[5]) },
  }),
};

/** The bytes the server sent, when the base64 is canonical and holds exactly as many bytes as the server counted. */
function carried({ count, base64 }: Carried, name: string): Checked<Uint8Array> {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64) return { ok: false, why: `${name} is not canonical base64` };
  if (bytes.length !== Number(count)) return { ok: false, why: `${name} has ${bytes.length} bytes, not the ${count} the server counted` };
  return { ok: true, value: bytes };
}

export type Health =
  | { readonly kind: "unreachable"; readonly detail: string }
  | { readonly kind: "invalid"; readonly detail: string }
  | { readonly kind: "valid"; readonly version: string | null };

export function parseHealth(bytes: Uint8Array): Health {
  const body = validate(HEALTH, bytes);
  return body.ok ? { kind: "valid", version: body.value.version } : { kind: "invalid", detail: body.why };
}

export interface ServerRead {
  /** The digest in /data/afterclass/current-image, or null when the file is missing or is not in its format. */
  readonly digest: string | null;
  readonly health: Health;
}

export function parseProbe(output: Uint8Array): ServerRead {
  const probe = validate(PROBE_OUTPUT, output);
  if (!probe.ok) return { digest: null, health: { kind: "invalid", detail: probe.why } };
  const { image, health } = probe.value;
  const file = image === null ? null : carried(image, CURRENT_IMAGE.name);
  const recorded = file?.ok ? validate(CURRENT_IMAGE, file.value) : null;
  const digest = recorded?.ok ? recorded.value : null;
  if ("unreachable" in health) return { digest, health: { kind: "unreachable", detail: `curl exited ${health.unreachable}` } };
  const body = carried(health, HEALTH.name);
  return { digest, health: body.ok ? parseHealth(body.value) : { kind: "invalid", detail: body.why } };
}
