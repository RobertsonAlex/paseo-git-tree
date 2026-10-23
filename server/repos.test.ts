import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findRepos, getFolderStatus, getProbe, getRepos, openWorkspace } from "./repos.ts";
import { git, makeTempRepo } from "./test-helpers.ts";

const scratch = () => mkdtemp(path.join(tmpdir(), "git-tree-walk-"));
async function initRepo(dir: string) {
  await mkdir(dir, { recursive: true });
  await git(dir, "init", "-b", "main");
}
const norm = (xs: string[]) => xs.map((x) => path.relative("", x)).sort();

test("findRepos finds top-level and one-deeper repos and stops at repo roots", async () => {
  const root = await scratch();
  await initRepo(path.join(root, "a"));
  await initRepo(path.join(root, "a", "inner"));
  await initRepo(path.join(root, "group", "b"));
  const found = await findRepos(root);
  assert.deepEqual(norm(found), norm([path.join(root, "a"), path.join(root, "group", "b")]));
});

test("findRepos skips node_modules and dot dirs", async () => {
  const root = await scratch();
  await initRepo(path.join(root, "node_modules", "x"));
  await initRepo(path.join(root, ".hidden", "y"));
  await initRepo(path.join(root, "ok"));
  assert.deepEqual(await findRepos(root), [path.join(root, "ok")]);
});

test("findRepos does not follow junctions/symlinks", async () => {
  const root = await scratch();
  await initRepo(path.join(root, "r"));
  await mkdir(path.join(root, "g"));
  await symlink(root, path.join(root, "g", "loop"), "junction");
  assert.deepEqual(await findRepos(root), [path.join(root, "r")]);
});

test("probe reports repo for a subfolder of a repo", async () => {
  const repo = await makeTempRepo();
  await mkdir(path.join(repo, "sub"));
  const sub = await getProbe({ directory: path.join(repo, "sub") });
  assert.equal(sub.kind, "repo");
  assert.ok(sub.root);
  const none = await getProbe({ directory: await scratch() });
  assert.deepEqual(none, { kind: "folder", root: null });
});

test("repos groups a worktree under its main repo", async () => {
  const root = await scratch();
  const main = path.join(root, "app");
  await initRepo(main);
  await git(main, "config", "user.name", "T");
  await git(main, "config", "user.email", "t@e.x");
  await git(main, "commit", "--allow-empty", "-m", "i");
  await git(main, "worktree", "add", "../wt");
  const res = await getRepos({ directory: root, fresh: true });
  assert.equal(res.error, null);
  assert.equal(res.repos.length, 1);
  assert.equal(res.repos[0].name, "app");
  assert.equal(res.repos[0].folders.length, 2);
  assert.equal(res.repos[0].folders[0].isMain, true);
  assert.equal((await getRepos({ directory: root })).cached, true);
});

test("folder-status reports branch, changed count and submodulesOk", async () => {
  const child = await makeTempRepo();
  const parent = await makeTempRepo();
  const plain = await makeTempRepo();
  await git(parent, "-c", "protocol.file.allow=always", "submodule", "add", child, "sub");
  await git(parent, "commit", "-m", "sub");
  await writeFile(path.join(plain, "x.txt"), "x");
  await git(plain, "checkout", "--detach");
  await writeFile(path.join(parent, "sub", "dirty.txt"), "x");
  await git(path.join(parent, "sub"), "checkout", "--detach");
  await git(path.join(parent, "sub"), "config", "user.name", "T");
  await git(path.join(parent, "sub"), "config", "user.email", "t@e.x");
  await git(path.join(parent, "sub"), "commit", "--allow-empty", "-m", "move");
  const { statuses } = await getFolderStatus({ directories: [parent, plain, path.join(plain, "nope")] });
  assert.equal(statuses[0].branch, "main");
  assert.equal(statuses[0].submodulesOk, false);
  assert.equal(statuses[1].branch, null);
  assert.equal(statuses[1].changed, 1);
  assert.equal(statuses[1].submodulesOk, null);
  assert.ok(statuses[2].error);
});

test("open-workspace passes a native-separator cwd and returns the handle id", async () => {
  const seen: string[] = [];
  const paseo = { workspaces: { open: async (i: { cwd: string }) => (seen.push(i.cwd), { id: "ws-1" }) } };
  const native = path.join(tmpdir(), "a", "b");
  const res = await openWorkspace({ directory: native.replaceAll("\\", "/") }, { paseo });
  assert.deepEqual(res, { workspaceId: "ws-1", error: null });
  assert.equal(seen[0], native);
  if (process.platform === "win32") assert.ok(!seen[0].includes("/"));
});

test("open-workspace reports a failure as an error", async () => {
  const paseo = { workspaces: { open: async () => Promise.reject(new Error("nope")) } };
  const res = await openWorkspace({ directory: tmpdir() }, { paseo });
  assert.equal(res.workspaceId, null);
  assert.match(res.error ?? "", /nope/);
});

test("folder-status marks a dirty (but not moved) submodule as not ok", async () => {
  const child = await makeTempRepo();
  const parent = await makeTempRepo();
  await git(parent, "-c", "protocol.file.allow=always", "submodule", "add", child, "sub");
  await git(parent, "commit", "-m", "sub");
  const clean = (await getFolderStatus({ directories: [parent] })).statuses[0];
  assert.equal(clean.submodulesOk, true);
  assert.equal(clean.changed, 0);
  await writeFile(path.join(parent, "sub", "README.md"), "edited\n");
  const dirty = (await getFolderStatus({ directories: [parent] })).statuses[0];
  assert.equal(dirty.submodulesOk, false);
  assert.equal(dirty.changed, 1);
});

test("folder-status reports the branch of a repo with no commits", async () => {
  const dir = await scratch();
  await initRepo(dir);
  const s = (await getFolderStatus({ directories: [dir] })).statuses[0];
  assert.equal(s.error, null);
  assert.equal(s.branch, "main");
});
