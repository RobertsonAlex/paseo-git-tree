import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createCache } from "./cache.ts";
import { countUntracked } from "./git.ts";
import { makeTempRepo } from "./test-helpers.ts";

test("countUntracked skips files over maxBytes without reading them", async () => {
  const dir = await makeTempRepo();
  await writeFile(path.join(dir, "big.bin"), Buffer.alloc(2 * 1024 * 1024, 65));
  const start = Date.now();
  const res = await countUntracked(dir, ["big.bin"]);
  assert.deepEqual(res.get("big.bin"), { additions: 0, binary: true });
  assert.ok(Date.now() - start < 500);
});

test("countUntracked counts lines of small text files", async () => {
  const dir = await makeTempRepo();
  await writeFile(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
  const res = await countUntracked(dir, ["a.txt"]);
  assert.deepEqual(res.get("a.txt"), { additions: 3, binary: false });
});

test("countUntracked treats untracked directories as binary", async () => {
  const dir = await makeTempRepo();
  await mkdir(path.join(dir, "sub"));
  const res = await countUntracked(dir, ["sub/"]);
  assert.deepEqual(res.get("sub/"), { additions: 0, binary: true });
});

test("cache drop removes keys by prefix", () => {
  const c = createCache<number>();
  c.set("C:/a|x", 1);
  c.set("C:/a|y", 2);
  c.set("C:/b|x", 3);
  c.drop("C:/a|");
  assert.equal(c.get("C:/a|x"), undefined);
  assert.equal(c.get("C:/a|y"), undefined);
  assert.equal(c.get("C:/b|x"), 3);
});
