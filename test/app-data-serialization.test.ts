import test from "node:test";
import assert from "node:assert/strict";
import { stable } from "../server/generation/types.ts";

test("provider usage serialization preserves absent counters and deterministic valid JSON", () => {
  const usage = {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    thoughtsTokens: undefined,
    cachedInputTokens: undefined,
    completeness: "COMPLETE",
    semantics: "synthetic native-shaped usage",
  };
  const encoded = stable(usage),
    decoded = JSON.parse(encoded);
  assert.equal(Object.hasOwn(decoded, "thoughtsTokens"), false);
  assert.equal(Object.hasOwn(decoded, "cachedInputTokens"), false);
  assert.equal(decoded.totalTokens, 15);
  assert.equal(
    encoded,
    stable(Object.fromEntries(Object.entries(usage).reverse())),
  );
  assert.deepEqual(
    JSON.parse(
      stable({ nested: { missing: undefined }, array: [undefined, 1] }),
    ),
    { array: [null, 1], nested: {} },
  );
});

test("serialization rejects executable getters, cycles and unsupported values without invoking getters", () => {
  let invoked = 0;
  const getter = Object.defineProperty({}, "usage", {
    enumerable: true,
    get() {
      invoked++;
      return 0;
    },
  });
  assert.throws(() => stable(getter), /INVALID_SERIALIZATION/);
  assert.equal(invoked, 0);
  const cycle: any = {};
  cycle.self = cycle;
  assert.throws(() => stable(cycle), /INVALID_SERIALIZATION/);
  for (const value of [
    undefined,
    NaN,
    Infinity,
    () => true,
    Symbol("bad"),
    new Date(),
    { call: () => 0 },
  ])
    assert.throws(() => stable(value), /INVALID_SERIALIZATION/);
});
