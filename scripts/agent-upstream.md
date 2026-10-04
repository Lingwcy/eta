# Updating the agent package

`packages/agent` is a workspace package vendored from [Pi's `packages/durable`](https://github.com/earendil-works/pi/tree/main/packages/durable). It keeps local changes, including the `@eta/agent` name. Desktop continues to use the local `workspace:*` dependency.

Commit or stash your work, then run:

```sh
vp run sync:agent
vp install
vp run --no-cache @eta/desktop#typecheck
vp run --no-cache build:desktop
```

Synchronization fetches upstream main, extracts durable's Git history, and creates a squash subtree merge commit. The Vite task disables caching so every invocation checks upstream. Updating to the same durable revision creates no commit. Dependency and desktop API changes may need follow-up work.

To preview an update or choose a specific upstream commit or tag:

```sh
vp run sync:agent -- --dry-run
vp run sync:agent -- --ref <upstream-commit-or-tag>
```

A dry run can populate Git's local upstream cache, but does not change workspace files or HEAD. The cache lives under Git's `eta-upstream/pi` directory, is not committed, and is recreated when missing. Sync metadata is recorded in commits; other maintainers can sync from an ordinary clone of Eta without a submodule or a separate mirror repository.

If a merge conflicts, resolve the files and run `git commit`, or use `git merge --abort` to return to the previous local version. Do not delete and recopy the package. Keep Eta integration changes in separate commits from upstream updates when possible.

The initial migration attached upstream commit `7fbbd5f4a1d982bb02d63472dde0774fa639f99b` without changing the existing workspace tree. Differences from that upstream snapshot are treated as local changes. Eta retains its package name, image-reading adapter and build configuration. Vendored files retain upstream formatting and are excluded from Eta formatting and lint passes. Independent package.json field changes are merged automatically; conflicting changes to the same value still require review.

For an existing copy in a different repository with no subtree metadata, use `--init --ref <copied-upstream-commit>` once. Initialization preserves the files and attaches the chosen upstream baseline through a Git merge commit. Verify that the supplied commit is the version the copy came from before initializing; an incorrect baseline makes later merges unreliable.
