// backend/server/http.ts -- Bun.serve plumbing, GENERIC over shared/api/contract.routes. No per-route code.
//   match method + path template -> merge :params and query/JSON body -> route.req.parse (zod, 400 on failure) -> engine[key](req, ctx)
//   rpc: JSON response            stream: text/event-stream (one `data:` line per item; AbortSignal from request.signal => cancels the tutor child)
//   bytes_in: body -> Uint8Array  bytes_out: raw response with immutable cache headers (frames are content-addressed)
//   errors: DomainError -> 4xx with { code, message }; anything else -> 500 and logged. Never leaks stack traces or key material.
import type { Engine } from "../../shared/api/contract";
import type { AppConfig } from "../config";

export interface Running { readonly url: string; stop(): Promise<void> }
export function serve(engine: Engine, cfg: AppConfig, token: string): Running {
  throw new Error("not implemented");
}
