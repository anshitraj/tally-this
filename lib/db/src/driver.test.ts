import test from "node:test";
import assert from "node:assert/strict";
import { isLoopbackDatabaseUrl } from "./driver.ts";

test("a database on this computer gets the plain driver", () => {
  for (const url of [
    "postgresql://postgres@127.0.0.1:54329/tallythis_test",
    "postgres://user:pass@localhost:5432/db",
    "postgresql://user@[::1]:5432/db",
    "postgres://user@LOCALHOST/db",
    "postgres://user@db.localhost/db",
  ]) {
    assert.equal(isLoopbackDatabaseUrl(url), true, url);
  }
});

test("a real database never does, however its address is written", () => {
  for (const url of [
    "postgresql://user:pass@ep-cool-123.ap-southeast-1.aws.neon.tech/neondb?sslmode=require",
    "postgres://user@localhost.evil.example/db",
    "postgres://localhost@evil.example/db",
    "postgres://user@evil.example/db?host=localhost",
    "postgres://user@127.0.0.1.nip.io/db",
    "postgres://user@10.0.0.5/db",
    "postgres://user@0.0.0.0/db",
    "postgres://user@127.0.0.2.evil.example/db",
    "not a url",
    "",
  ]) {
    assert.equal(isLoopbackDatabaseUrl(url), false, url);
  }
});
