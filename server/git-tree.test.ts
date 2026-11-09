import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseLocalHeads } from "../shared/git-tree.ts";
import { getGitTree, runBranchOp } from "./git-tree.ts";
import { git, makeTempRepo } from "./test-helpers.ts";

const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();

/** Repo on `main` plus a linked worktree with `feature` checked out. */
async function repoWithWorktree() {
  const dir = await makeTempRepo();
  await git(dir, "branch", "idle");
  const wt = path.join(await mkdtemp(path.join(tmpdir(), "git-tree-wt-")), "feature-wt");
  await git(dir, "worktree", "add", "-b", "feature", wt);
  return { dir, wt: await realpath(wt) };
}

test("parseLocalHeads: worktree path only for branches checked out elsewhere", () => {
  const heads = parseLocalHeads(
    "main\taaa\t*\tC:/r\r\nfeature\tbbb\t \tC:/wt/feature\nidle\tccc\t \t\n",
    "main",
  );
  assert.deepEqual(heads, [
    { name: "main", hash: "aaa", isCurrent: true, remote: false, worktreePath: null },
    { name: "feature", hash: "bbb", isCurrent: false, remote: false, worktreePath: "C:/wt/feature" },
    { name: "idle", hash: "ccc", isCurrent: false, remote: false, worktreePath: null },
  ]);
});

test("getGitTree reports the worktree a local branch is checked out in", async () => {
  const { dir, wt } = await repoWithWorktree();
  const out = await getGitTree({ directory: dir, limit: 50, scope: "local", fresh: true });
  assert.equal(out.error, null);
  const byName = new Map(out.heads.map((h) => [h.name, h]));
  assert.equal(byName.get("main")?.worktreePath, null);
  assert.equal(byName.get("idle")?.worktreePath, null);
  assert.equal(norm(byName.get("feature")?.worktreePath ?? ""), norm(wt));
});

test("checkout of a branch checked out in another worktree skips git and returns its path", async () => {
  const { dir, wt } = await repoWithWorktree();
  const res = await runBranchOp({ directory: dir, op: "checkout", name: "feature" });
  assert.equal(res.error, null);
  assert.equal(norm(res.checkedOutAt ?? ""), norm(wt));
  assert.equal((await git(dir, "rev-parse", "--abbrev-ref", "HEAD")).trim(), "main");

  const ok = await runBranchOp({ directory: dir, op: "checkout", name: "idle" });
  assert.deepEqual(ok, { error: null, checkedOutAt: null });
  assert.equal((await git(dir, "rev-parse", "--abbrev-ref", "HEAD")).trim(), "idle");
});
