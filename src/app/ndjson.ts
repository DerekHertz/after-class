import { z } from "zod";
import type { TurnEvent } from "../shared/domain";
import { turnEventz } from "./decode";

export class StreamError extends Error {
  override readonly name = "StreamError";
}

/** Splits a byte stream into JSON values, one per line. A multi-byte character or a line may be cut at any chunk boundary. */
export async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (line: string): unknown => {
    try {
      return JSON.parse(line);
    } catch {
      throw new StreamError(`malformed NDJSON line: ${line.slice(0, 80)}`);
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line !== "") yield parse(line);
        newline = buffer.indexOf("\n");
      }
      if (done) break;
    }
    const rest = buffer.trim();
    if (rest !== "") yield parse(rest);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

const CUT_OFF: TurnEvent = { type: "turn_failed", error: "The connection closed before the tutor finished.", retryable: true };

/**
 * Validated tutor events. A stream that ends without `turn_complete` or
 * `turn_failed` is a dropped connection, reported as a retryable failure so the
 * caller never waits on a turn that is gone.
 */
export async function* tutorEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<TurnEvent> {
  try {
    for await (const raw of ndjson(body)) {
      const parsed = turnEventz.safeParse(raw);
      if (!parsed.success) throw new StreamError(`unexpected tutor event: ${z.prettifyError(parsed.error)}`);
      yield parsed.data;
      if (parsed.data.type === "turn_complete" || parsed.data.type === "turn_failed") return;
    }
  } catch (e) {
    if (e instanceof StreamError) throw e;
    yield { type: "turn_failed", error: e instanceof Error ? e.message : String(e), retryable: true };
    return;
  }
  yield CUT_OFF;
}
