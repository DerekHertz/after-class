/**
 * Composition root. The only file that knows every module.
 *
 *   keys      ~/.config/afterclass/keys.env (0600; refuse to start if wider) → TYPESAFE_API_KEY
 *   data      ./data/afterclass.sqlite, ./data/frames/
 *   mode      AFTERCLASS_MODE=live | replay  (replay: memo misses throw; no provider is constructed)
 *
 * Wiring order: db → ledger → memo → providers/tasks → evidence → segmentation
 * → preparation → reviews → record → scheduler → Bun.serve.
 * Every fact write calls scheduler.pump(); a 24 h timer runs evidence.sweepExpired.
 */
export async function main(): Promise<void> {
  throw new Error("not implemented");
}

if (import.meta.main) await main();
