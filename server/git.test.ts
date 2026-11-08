import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createCache } from "./cache.ts";
import { countUntracked, runGit } from "./git.ts";
import { git, makeTempRepo } from "./test-helpers.ts";

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

test("runGit disables credential prompts and optional locks", async () => {
  const dir = await makeTempRepo();
  const out = await runGit(dir, ["-c", "alias.e=!env", "e"]);
  for (const line of ["GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=0", "GIT_OPTIONAL_LOCKS=0", "LC_ALL=C"]) {
    assert.ok(out.split(/\r?\n/).includes(line), line);
  }
});

test("runGit keeps non-ASCII branch names and subjects intact", async () => {
  const dir = await makeTempRepo();
  await git(dir, "checkout", "-b", "fünf-✓");
  await git(dir, "commit", "--allow-empty", "-m", "héllo ✓ 日本");
  assert.equal((await runGit(dir, ["log", "-1", "--format=%s"])).trim(), "héllo ✓ 日本");
  assert.equal((await runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(), "fünf-✓");
});

test("runGit rejects with stderr on failure and honours allowExit", async () => {
  const dir = await makeTempRepo();
  await assert.rejects(runGit(dir, ["rev-parse", "--verify", "nope"]), /fatal|nope/);
  assert.equal(await runGit(dir, ["-c", "alias.x=!exit 1", "x"], 15_000, [1]), "");
});

test("runGit timeout settles and kills the whole process tree", async () => {
  const dir = await makeTempRepo();
  // git -> sh -> sleep: the grandchild holds the pipe and would write the marker if it survived.
  const start = Date.now();
  await assert.rejects(runGit(dir, ["-c", "alias.slow=!sleep 3 && echo x > marker", "slow"], 500), /timed out/);
  assert.ok(Date.now() - start < 2500, "settled promptly");
  await new Promise((r) => setTimeout(r, 4000));
  await assert.rejects(access(path.join(dir, "marker")), "helper was killed");
});
