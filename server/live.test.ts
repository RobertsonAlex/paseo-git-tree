import assert from "node:assert/strict";
import { test } from "node:test";
import { addListener, notifyChanged, overlaps } from "./live.ts";

test("overlaps matches nesting either way, not siblings with a shared prefix", () => {
  assert.ok(overlaps("/w/app", "/w/app/sub"));
  assert.ok(overlaps("/w/app/sub", "/w/app/"));
  assert.ok(!overlaps("/w/app", "/w/app2"));
});

test("notifyChanged only reaches overlapping listeners; no arg reaches all", () => {
  const hits: string[] = [];
  const offA = addListener("/w/a", () => hits.push("a"));
  const offB = addListener("/w/b", () => hits.push("b"));
  notifyChanged("/w/a/x");
  assert.deepEqual(hits, ["a"]);
  notifyChanged();
  assert.deepEqual(hits, ["a", "a", "b"]);
  offA();
  offB();
  notifyChanged();
  assert.equal(hits.length, 3);
});

test("cache.dropDirs drops only overlapping directories", async () => {
  const { createCache } = await import("./cache.ts");
  const c = createCache<number>();
  c.set("/w/a|x", 1);
  c.set("/w/b|x", 2);
  c.dropDirs((d) => overlaps(d, "/w/a/sub"));
  assert.equal(c.get("/w/a|x"), undefined);
  assert.equal(c.get("/w/b|x"), 2);
});
