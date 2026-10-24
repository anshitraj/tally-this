import test from "node:test";
import assert from "node:assert/strict";
import { isUniqueViolation } from "./dbErrors";

test("a Postgres unique violation is recognised, plain or wrapped by the query layer", () => {
  assert.equal(isUniqueViolation({ code: "23505" }), true);
  assert.equal(isUniqueViolation(Object.assign(new Error("Failed query"), { cause: { code: "23505" } })), true);
  assert.equal(isUniqueViolation({ cause: { cause: { code: "23505" } } }), true);
});

test("other errors are not mistaken for one", () => {
  assert.equal(isUniqueViolation(new Error("duplicate key")), false);
  assert.equal(isUniqueViolation({ code: "23503" }), false);
  assert.equal(isUniqueViolation(null), false);
  assert.equal(isUniqueViolation("23505"), false);
  const loop: { cause?: unknown } = {};
  loop.cause = loop;
  assert.equal(isUniqueViolation(loop), false);
});
