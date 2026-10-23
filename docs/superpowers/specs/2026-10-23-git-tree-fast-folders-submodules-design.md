# Git Tree: fast load, folder workspaces, submodules

Date: 2026-10-23. Repo: `RobertsonAlex/paseo-git-tree` (fork of ZFhuang/paseo-git-tree), pinned in
`paseo-config/plugins.json` as `git-tree`.

## Why

Opening Git Tree on the `C:\Dev\pkzip` workspace showed an empty panel for ~30 s. Cause:
`getGitTree` (`server/git-tree.ts`) builds the uncommitted summary inside the same RPC as the graph,
and for every untracked path runs `git diff --no-index --numstat NUL <path>` sequentially. pkzip has
three untracked 523 MB executables (`header`, `detail`, `list`), ~8 s each. The panel renders nothing
while `loading` (`client/git-tree-panel.tsx` ~3362) and swallows RPC failures (~2812), so the user
sees a blank panel with no hint.

Alex also works from folder workspaces (e.g. `C:\Dev`, ~31+ repos, many with worktrees) and with
heavily nested submodules (pkzip -> SDK -> Docs/remote_sign; 3rdparty has 11). Today the panel only
works when the workspace directory is itself a repo, and gives no view of submodules.

## Calls made by the designer, not Alex

- "Expected by parent" = parent's index; extra "committed in parent" mark when HEAD differs.
- Untracked line counting: size threshold + binary skip + small parallelism.
- Cache in daemon memory only, per daemon run; refresh button bypasses it.
- Folder scan stops at each repo root and skips `node_modules`; submodules found via git, not the walk.
- Uninitialised submodules listed but not drillable.

## Goals

1. **Fast load.** The commit graph appears as soon as `git log` returns (~0.3 s on pkzip). Everything
   else fills in afterwards without blocking it.
2. **Submodules (view-only).** From a repo's graph, see each submodule's branch, whether it lines up
   with the commit the parent expects, and whether it is dirty; drill into its graph and branch list
   to decide where the pointer should go.
3. **Folder workspaces.** When the workspace directory is not a git repo, show its repos as cards,
   with each repo's folders (main checkout + worktrees) underneath; drill into any folder's graph, or
   start/open a Paseo workspace for it.

## Non-goals

- No dedicated submodule actions (update to expected commit, re-point, stage pointer). Alex does
  those in a terminal or agent. The panel's existing branch/commit actions (checkout, reset, merge,
  rebase, pull, push, ...) stay fully live in every drilled-in view, submodule and worktree alike;
  they run against the drilled-in directory, and afterwards the parent's lines-up status refreshes.
- "Start workspace" does not launch an agent; it only opens/creates the workspace.
- No OS-level filename index (Everything, Windows Search). A full `.git` search of `C:\Dev` ran >5 min.

## Anti-goals (failure even if it works)

- Any view that can sit blank: loading shows an indicator, failures show a message.
- A huge untracked or binary file making the panel slow again.
- Folder scan descending into repo internals (openssl source trees, `node_modules`) and taking minutes.

## Design

### 1. Fast load and caching

- Split the current `git-tree` RPC. The graph RPC returns rows, heads, remotes, current branch only.
  A new RPC returns the uncommitted summary. The client calls the graph first and renders it, then
  requests the summary (and submodule status, below) and merges results in when they arrive.
- Untracked line counts: run in parallel with a small concurrency cap; skip files above a size
  threshold or detected binary (`--numstat` reports `-`), and report them as binary/large with no line
  count. Untracked directories (porcelain `dir/`) are not diffed as a whole.
  *Builder's call:* threshold value (suggest 1 MB) and concurrency (suggest 4).
- Server keeps an in-memory cache per (directory, scope, path filter, preview) for the graph and per
  directory for the summary/submodule status. The client shows the cached result immediately, then the
  server refreshes and the client swaps in the fresh result. Cache lives for the daemon process;
  explicit refresh button bypasses it. *Builder's call:* how the stale-then-fresh handoff is exposed
  (e.g. a `cached: true` flag plus a second call, or one call that returns cache and the client
  re-requests with `fresh: true`).
- Panel shows a loading indicator when it has nothing to show yet, and an error message (not a blank
  panel) when an RPC rejects or returns `error`.

### 2. Submodules

- When viewing a repo, a **Submodules** strip lists each submodule from `git submodule status`
  (recursive not required; one level per view). Per submodule: path, current branch (or "detached"),
  lines-up flag (`+` prefix in `git submodule status` = checked-out commit differs from the commit the
  parent's HEAD records; `-` = not initialised; `U` = conflict), dirty flag (uncommitted changes inside
  the submodule).
- Clicking a submodule drills into its own graph and branch list (same view as any repo), with a
  breadcrumb/back to the parent. Nested submodules work the same way, one level at a time.
- "Expected by parent" uses the parent's **index** (`git ls-files -s <path>`), matching what
  `git submodule status` compares against, so the strip flag and the graph mark always agree.
  *Designer's call:* if the parent's HEAD records a different commit (a staged, uncommitted pointer
  change), also mark **committed in parent** (`git ls-tree HEAD <path>`).
- In the submodule's graph, mark **expected by parent** and **checked out** (plus **committed in
  parent** when it differs). When they differ, all are visible so the distance and branches between
  them can be judged.
- Uninitialised submodules are listed but cannot be drilled into (nothing on disk).
- Status loads in the background like the uncommitted summary.

### 3. Folder workspaces

- If the workspace directory is not inside a git work tree, the panel shows the **repo list** instead
  of a graph.
- Discovery: walk the folder recursively; a directory containing `.git` (file **or** folder) is a
  repo: record it and do not descend further. Skip `node_modules` and other obvious heavy dirs.
  Submodules are not discovered by walking (they are inside repos); they come from section 2 when
  drilling in. *Builder's call:* skip-list contents and a depth cap as a safety limit.
- Grouping: for each discovered repo, `git worktree list --porcelain` gives the main checkout and its
  worktrees. One card per main repository; worktree folders are listed under it even if they live
  elsewhere on disk. A discovered folder that is a worktree of an already-carded repo is merged into
  that card, not shown twice.
- Each card: repo name. Each folder line under it: folder name/path, branch, diff count (changed files).
  Branch and diff counts load in the background after the cards appear. Submodule lines-up/dirty
  shows as a small badge on the folder line.
- Folder line actions:
  - **Drill in**: show that folder's graph in the panel, with back to the repo list.
  - **Start workspace**: server RPC calls `paseo.workspaces.open({ cwd })` (handler context `paseo`
    API) to open or create the workspace, returns its id; client calls
    `navigation.openWorkspace({ workspaceId })`.
- The discovered repo list is cached per folder for the daemon process; refresh rescans.

## Constraints

- Paseo 0.12.0 plugin API (`@getpaseo/plugin` devDependency pinned to it). The plugin repo has no
  `node_modules` yet: run `npm install` and confirm `PluginHandlerContext.paseo.workspaces.open` and
  `navigation.openWorkspace` signatures in 0.12.0 (both exist in 0.8.0; `openWorkspace` is optional
  there, so hide "Start workspace" when absent). RPC names kebab-case.
  `shared/` holds schemas and plain values only. Panel runs on desktop and mobile; `explorer` location
  is desktop-only.
- Existing behaviour (branch/commit ops, search, compare, diffs) keeps working.
- Never restart the daemon to test; use `paseo plugin reload git-tree --host <ip>:6767`.
- `npm run typecheck` and `npm test` pass; graph logic tests live in `shared/git-tree.test.ts`.
- Rollout: push the fork, update the `git-tree` commit pin in `paseo-config/plugins.json`, render,
  release via `paseo-release`.

## Left to the builder

Visual layout of cards, strip and badges (match existing panel styling); RPC shapes and names; cache
key details and eviction; how the drill-in stack is held in client state; thresholds noted above.
