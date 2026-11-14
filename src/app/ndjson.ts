import { z } from "zod";
import type { TurnEvent } from "../shared/domain";
import { turnEventz } from "./decode";

export class StreamError extends Error {
  override readonly name = "StreamError";
}

/** The stream ended inside a line: the connection dropped, which is not the same as the server sending garbage. */
export class TruncatedStream extends Error {
  override readonly name = "TruncatedStream";
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
    if (rest !== "") {
      let value: unknown;
      try {
        value = JSON.parse(rest);
      } catch {
        throw new TruncatedStream(`the connection closed mid-line: ${rest.slice(0, 80)}`);
      }
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

const CUT_OFF: TurnEvent = { type: "turn_failed", error: "The connection closed before the tutor finished.", retryable: true };

/**
 * Validated tutor events. A stream that ends without `turn_complete`,
 * `turn_failed` or `turn_held` is a dropped connection, reported as a retryable
 * failure so the caller never waits on a turn that is gone.
 */
export async function* tutorEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<TurnEvent> {
  try {
    for await (const raw of ndjson(body)) {
      const parsed = turnEventz.safeParse(raw);
      if (!parsed.success) throw new StreamError(`unexpected tutor event: ${z.prettifyError(parsed.error)}`);
      yield parsed.data;
      if (parsed.data.type === "turn_complete" || parsed.data.type === "turn_failed" || parsed.data.type === "turn_held") return;
    }
  } catch (e) {
    if (e instanceof StreamError) throw e;
    if (e instanceof TruncatedStream) {
      yield CUT_OFF;
      return;
    }
    yield { type: "turn_failed", error: e instanceof Error ? e.message : String(e), retryable: true };
    return;
  }
  yield CUT_OFF;
}
