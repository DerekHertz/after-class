/**
 * Fires a second event at a chosen interleaving point inside the first (retro 1, class 2: races).
 *
 *   const il = createInterleave();
 *   il.on("after-snapshot", () => otherActor());     // the second event
 *   codeUnderTest(il);                               // calls il.at("after-snapshot") at that point
 *   expect(il.fired("after-snapshot")).toBe(1);
 *
 * Or in one call, which also fails if the point is never reached (a vacuous race):
 *   const { first, second } = await raceAt("after-snapshot", (il) => codeUnderTest(il), () => otherActor());
 *
 * `at` returns the event's own return value, so an async caller may `await il.at(...)` to hold its
 * first event until the second has finished. Each registered event fires once, at the first hit.
 */
type Interleave = {
  /** Register the event to run when `name` is first hit. */
  on(name: string, event: () => unknown): void;
  /** Call at the interleaving point. Runs the registered event, if any and not yet fired. */
  at<T = void>(name: string): T | undefined;
  /** How many times `name` has fired its event. */
  fired(name: string): number;
};

export function createInterleave(): Interleave {
  const pending = new Map<string, () => unknown>();
  const counts = new Map<string, number>();
  return {
    on: (name, event) => {
      if (pending.has(name)) throw new Error(`interleave point "${name}" already has an event`);
      pending.set(name, event);
    },
    at: <T>(name: string) => {
      const event = pending.get(name);
      if (!event) return undefined;
      pending.delete(name);
      counts.set(name, (counts.get(name) ?? 0) + 1);
      return event() as T;
    },
    fired: (name) => counts.get(name) ?? 0,
  };
}

export async function raceAt<A, B>(
  point: string,
  first: (il: Interleave) => A | Promise<A>,
  second: () => B | Promise<B>,
): Promise<{ readonly first: A; readonly second: B }> {
  const il = createInterleave();
  let secondRun: Promise<B> | null = null;
  il.on(point, () => (secondRun = Promise.resolve(second())));
  const firstResult = await first(il);
  if (secondRun === null) throw new Error(`interleave point "${point}" was never reached`);
  return { first: firstResult, second: await (secondRun as Promise<B>) };
}
