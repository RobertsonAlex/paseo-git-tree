import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getGitTree, runCommitOp } from "./git-tree.ts";
import { getStatus } from "./status.ts";
import { git, makeTempRepo } from "./test-helpers.ts";

const trim = async (p: Promise<string>) => (await p).trim();

/** Parent repo with child added as submodule `sub`, committed. */
async function makeParentWithSub() {
  const child = await makeTempRepo();
  const parent = await makeTempRepo();
  await git(parent, "-c", "protocol.file.allow=always", "submodule", "add", child, "sub");
  await git(parent, "commit", "-m", "add sub");
  await git(path.join(parent, "sub"), "config", "user.name", "Test");
  await git(path.join(parent, "sub"), "config", "user.email", "test@example.com");
  await git(path.join(parent, "sub"), "config", "commit.gpgsign", "false");
  return { child, parent };
}

test("status reports ok submodule on its branch, not dirty", async () => {
  const { parent } = await makeParentWithSub();
  const res = await getStatus({ directory: parent, fresh: true });
  assert.equal(res.error, null);
  assert.equal(res.submodules.length, 1);
  const sub = res.submodules[0];
  assert.equal(sub.path, "sub");
  assert.equal(sub.state, "ok");
  assert.equal(sub.dirty, false);
  assert.equal(sub.branch, "main");
  assert.equal(sub.expected, sub.checkedOut);
  assert.equal(sub.expected, sub.committed);
});

test("status reports mismatch after parent HEAD moves", async () => {
  const { parent } = await makeParentWithSub();
  const subDir = path.join(parent, "sub");
  await writeFile(path.join(subDir, "x.txt"), "x\n");
  await git(subDir, "add", "x.txt");
  await git(subDir, "commit", "-m", "x");
  await git(parent, "add", "sub");
  await git(parent, "commit", "-m", "bump");
  await git(parent, "checkout", "HEAD~1");
  const res = await getStatus({ directory: parent, fresh: true });
  const sub = res.submodules[0];
  assert.equal(sub.state, "mismatch");
  assert.notEqual(sub.expected, sub.checkedOut);
});

test("status reports uninitialized submodule", async () => {
  const { parent } = await makeParentWithSub();
  const clone = path.join(await mkdtemp(path.join(tmpdir(), "git-tree-clone-")), "c");
  await git(tmpdir(), "clone", parent, clone);
  const res = await getStatus({ directory: clone, fresh: true });
  const sub = res.submodules[0];
  assert.equal(sub.state, "uninitialized");
  assert.equal(sub.checkedOut, null);
  assert.equal(sub.branch, null);
});

test("status reports committed when pointer is staged but not committed", async () => {
  const { parent } = await makeParentWithSub();
  const subDir = path.join(parent, "sub");
  await writeFile(path.join(subDir, "y.txt"), "y\n");
  await git(subDir, "add", "y.txt");
  await git(subDir, "commit", "-m", "y");
  await git(parent, "add", "sub");
  const res = await getStatus({ directory: parent, fresh: true });
  const sub = res.submodules[0];
  assert.notEqual(sub.committed, sub.expected);
  assert.equal(sub.state, "ok");
});

test("graph includes extraRefs commit not reachable from HEAD", async () => {
  const child = await makeTempRepo();
  await git(child, "checkout", "-b", "side");
  await writeFile(path.join(child, "s.txt"), "s\n");
  await git(child, "add", "s.txt");
  await git(child, "commit", "-m", "side commit");
  const x = await trim(git(child, "rev-parse", "HEAD"));
  await git(child, "checkout", "main");
  const without = await getGitTree({ directory: child, limit: 50, scope: "current", fresh: true });
  assert.ok(!without.rows.some((r) => r.hash === x));
  const res = await getGitTree({ directory: child, limit: 50, scope: "current", extraRefs: [x] });
  assert.equal(res.error, null);
  assert.ok(res.rows.some((r) => r.hash === x));
});

test("getGitTree returns cached: true on second call without fresh", async () => {
  const dir = await makeTempRepo();
  const first = await getGitTree({ directory: dir, limit: 50, scope: "current" });
  const second = await getGitTree({ directory: dir, limit: 50, scope: "current" });
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal((await getGitTree({ directory: dir, limit: 50, scope: "current", fresh: true })).cached, false);
});

test("getGitTree cache distinguishes limit", async () => {
  const dir = await makeTempRepo();
  await writeFile(path.join(dir, "b.txt"), "b\n");
  await git(dir, "add", "b.txt");
  await git(dir, "commit", "-m", "second");
  const one = await getGitTree({ directory: dir, limit: 1, scope: "current" });
  const two = await getGitTree({ directory: dir, limit: 2, scope: "current" });
  assert.equal(one.rows.length, 1);
  assert.equal(two.rows.length, 2);
});

test("extraRefs missing from the object store are dropped and reported, not an error", async () => {
  const child = await makeTempRepo();
  await git(child, "checkout", "-b", "side");
  await writeFile(path.join(child, "s.txt"), "s\n");
  await git(child, "add", "s.txt");
  await git(child, "commit", "-m", "side commit");
  const x = await trim(git(child, "rev-parse", "HEAD"));
  await git(child, "checkout", "main");
  const random = "0123456789abcdef0123456789abcdef01234567";
  const res = await getGitTree({ directory: child, limit: 50, scope: "current", fresh: true, extraRefs: [random, x] });
  assert.equal(res.error, null);
  assert.ok(res.rows.some((r) => r.hash === x));
  assert.deepEqual(res.missingRefs, [random]);
  const plain = await getGitTree({ directory: child, limit: 50, scope: "current", fresh: true });
  assert.deepEqual(plain.missingRefs, []);
});

test("a failed commit op still drops the graph cache", async () => {
  const dir = await makeTempRepo();
  await git(dir, "checkout", "-b", "side");
  await writeFile(path.join(dir, "README.md"), "side\n");
  await git(dir, "commit", "-am", "side");
  const side = await trim(git(dir, "rev-parse", "HEAD"));
  await git(dir, "checkout", "main");
  await writeFile(path.join(dir, "README.md"), "main\n");
  await git(dir, "commit", "-am", "main");
  await getGitTree({ directory: dir, limit: 50, scope: "current" });
  const op = await runCommitOp({ directory: dir, op: "merge", hash: side });
  assert.ok(op.error);
  assert.equal((await getGitTree({ directory: dir, limit: 50, scope: "current" })).cached, false);
});
