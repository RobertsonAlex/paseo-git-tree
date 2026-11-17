import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  getCommitCompare,
  getCommitCompareDiff,
  getCommitDetail,
  getCommitDiff,
  dropCachesFor,
  getGitTree,
  runBranchOp,
  runCommitOp,
} from "./server/git-tree";
import { dropRepoCache, dropRepoCacheFor, getFolderStatus, getProbe, getRepos, openWorkspace } from "./server/repos";
import { addListener, notifyChanged } from "./server/live";
import { getStatus } from "./server/status";
import {
  commitCompare,
  commitCompareDiff,
  commitDetail,
  commitDiff,
  gitBranchOp,
  gitCommitOp,
  gitFolderStatus,
  gitOpenWorkspace,
  gitProbe,
  gitRepos,
  gitStatus,
  gitTree,
  repoChanged,
} from "./shared/git-tree";

export default function contribute(server: PluginServerContext) {
  server.handle(gitTree, getGitTree);
  server.handle(gitStatus, getStatus);
  server.handle(commitDetail, getCommitDetail);
  server.handle(commitDiff, getCommitDiff);
  server.handle(commitCompare, getCommitCompare);
  server.handle(commitCompareDiff, getCommitCompareDiff);
  server.handle(gitBranchOp, runBranchOp);
  server.handle(gitCommitOp, runCommitOp);
  server.handle(gitProbe, getProbe);
  server.handle(gitRepos, getRepos);
  server.handle(gitFolderStatus, getFolderStatus);
  server.handle(gitOpenWorkspace, openWorkspace);
  server.handle(repoChanged, ({ directory }, { push, signal }) => {
    const off = addListener(directory, () => void push({ type: "changed" }));
    signal.addEventListener("abort", off, { once: true });
  });

  const dropAll = async () => {
    dropRepoCache();
    notifyChanged();
  };
  // agent.turn.after / agent.archive.after are non-waiting notifications; scope the drop to the agent's directory.
  const dropFor = async ({ agent }: { agent: { cwd: string } }) => {
    dropRepoCacheFor(agent.cwd);
    dropCachesFor(agent.cwd);
    notifyChanged(agent.cwd);
  };
  const removers = [
    server.addHook("worktree.create.after", dropAll),
    server.addHook("workspace.archive.after", dropAll),
    server.addHook("agent.turn.after", dropFor),
    server.addHook("agent.archive.after", dropFor),
  ];
  return () => {
    for (const remove of removers.splice(0)) remove();
  };
}
