import assert from "node:assert/strict";
import test from "node:test";
import { KeyPool, keyFingerprint, parseKeys } from "../src/key-pool.js";
import { parseRetryAfter } from "../src/upstream.js";

test("parseKeys ignores comments, blanks, and duplicates", () => {
  assert.deepEqual(parseKeys("# keys\n tvly-one \n\ntvly-two\ntvly-one\n"), ["tvly-one", "tvly-two"]);
});

test("keyFingerprint is stable and does not expose the key", () => {
  const fingerprint = keyFingerprint("tvly-secret-value");
  assert.equal(fingerprint, keyFingerprint("tvly-secret-value"));
  assert.equal(fingerprint.length, 8);
  assert.equal(fingerprint.includes("secret"), false);
});

test("KeyPool distributes selections in round-robin order", () => {
  const pool = new KeyPool([
    { id: "a", value: 1 },
    { id: "b", value: 2 },
    { id: "c", value: 3 },
  ]);

  assert.deepEqual(Array.from({ length: 6 }, () => pool.next()?.id), ["a", "b", "c", "a", "b", "c"]);
});

test("KeyPool adds only novel entries at runtime", () => {
  const pool = new KeyPool([{ id: "a", value: 1 }]);

  const added = pool.add([
    { id: "a", value: 99 },
    { id: "b", value: 2 },
  ]);

  assert.equal(added, 1);
  assert.deepEqual(Array.from({ length: 4 }, () => pool.next()?.id), ["a", "b", "a", "b"]);
});

test("KeyPool re-enables a key after cooldown", () => {
  let now = 1_000;
  const pool = new KeyPool([{ id: "a", value: 1 }], () => now);
  const entry = pool.next();
  assert.ok(entry);

  pool.markCooldown(entry, 500);
  assert.equal(pool.next(), undefined);
  assert.equal(pool.retryAfterMs(), 500);

  now = 1_500;
  assert.equal(pool.next()?.id, "a");
});

test("disabled state wins over concurrent success and cooldown updates", () => {
  const pool = new KeyPool([{ id: "a", value: 1 }]);
  const entry = pool.next();
  assert.ok(entry);

  pool.markDisabled(entry);
  pool.markReady(entry);
  pool.markCooldown(entry, 500);

  assert.equal(entry.state, "disabled");
  assert.equal(pool.next(), undefined);
});

test("parseRetryAfter supports seconds and HTTP dates", () => {
  assert.equal(parseRetryAfter("2"), 2_000);
  assert.equal(parseRetryAfter("Thu, 01 Jan 1970 00:00:02 GMT", 1_000), 1_000);
  assert.equal(parseRetryAfter("invalid"), undefined);
});
