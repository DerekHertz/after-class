// backend/main.ts -- `bun run dev`. Runs in WSL. Binds 127.0.0.1 (Windows Chrome reaches it through WSL localhost forwarding;
// if the user's WSL networking mode doesn't forward, set AFTERCLASS_HOST=0.0.0.0 -- the pairing token still gates every call).
//   cfg = defaultConfig(process.env); keys = loadKeys(~/.config/afterclass/keys.env)
//   store = openStore({ dataDir, clock }); providers = AFTERCLASS_REPLAY ? replayProviders(cassette, store.usage, clock)
//                                                   : createProviders(cfg.providers with keys, store.usage, clock)
//   engine = await createEngine({ store, providers, clock, cfg }); serve(engine, cfg, token)
//   serves the built review app (dist/app) statically from the same origin so the app needs no CORS and shares the token cookie
//   SIGINT: stop accepting, abort running jobs (children killed), flush, close store
export async function main(): Promise<void> {
  throw new Error("not implemented");
}
