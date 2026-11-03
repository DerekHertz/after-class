import { describe, expect, test } from "bun:test";
import { canonicalJson, ID_KINDS, parseId, randomId, stableId } from "../src/shared/ids";

describe("stableId", () => {
  test("is a pure function of kind and parts", () => {
    expect(stableId("clm", "a", 1, { x: [true, null] })).toBe(stableId("clm", "a", 1, { x: [true, null] }));
    expect(stableId("clm", "a")).not.toBe(stableId("clm", "b"));
    expect(stableId("clm", "a").slice(4)).not.toBe(stableId("cpt", "a").slice(4));
  });

  test("ignores object key order but not array order", () => {
    expect(stableId("key", { a: 1, b: 2 })).toBe(stableId("key", { b: 2, a: 1 }));
    expect(stableId("key", [1, 2])).not.toBe(stableId("key", [2, 1]));
  });

  test("has the kind prefix and parses back as that kind", () => {
    for (const kind of ID_KINDS) {
      const id = stableId(kind, "x");
      expect(id.startsWith(`${kind}_`)).toBe(true);
      expect(parseId(kind, id)).toBe(id);
    }
  });

  test("refuses inputs JSON would silently change", () => {
    expect(() => stableId("key", Number.NaN)).toThrow();
    expect(() => stableId("key", Number.POSITIVE_INFINITY)).toThrow();
    expect(() => stableId("key", { a: undefined } as never)).toThrow();
    expect(stableId("key", -0)).toBe(stableId("key", 0));
  });
});

describe("canonicalJson", () => {
  test("sorts keys at every depth with no whitespace", () => {
    expect(canonicalJson({ b: { d: 1, c: 2 }, a: [{ z: 1, y: 2 }] })).toBe('{"a":[{"y":2,"z":1}],"b":{"c":2,"d":1}}');
  });
});

describe("randomId and parseId", () => {
  test("client-minted ids are unique and parse", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => randomId("turn")));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(parseId("turn", id)).toBe(id);
    expect(parseId("rvw", randomId("rvw"))).not.toBeNull();
    expect(parseId("cap", randomId("cap"))).not.toBeNull();
  });

  test("rejects other kinds, wrong shapes and non-strings", () => {
    const id = randomId("rvw");
    expect(parseId("turn", id)).toBeNull();
    expect(parseId("rvw", `${id}x`)).toBeNull();
    expect(parseId("rvw", id.toUpperCase())).toBeNull();
    expect(parseId("rvw", "rvw_short")).toBeNull();
    expect(parseId("rvw", 42)).toBeNull();
  });
});
