#!/usr/bin/env node

import { mergeAgentManifest } from "./merge-agent-manifest.ts";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

export const agentUpstream = {
  repository: "https://github.com/earendil-works/pi.git",
  sourcePrefix: "packages/durable",
  prefix: "packages/agent",
};

interface SyncOptions {
  root: string;
  repository?: string;
  ref?: string;
  initialize?: boolean;
  dryRun?: boolean;
  log?: (message: string) => void;
}

function git(cwd: string, args: string[], input?: string) {
  const result = spawnSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`git ${args[0]} failed:\n${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function optionalRevision(cwd: string, ref: string) {
  const result = spawnSync("git", ["rev-parse", "--verify", ref], { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function latestSplit(root: string) {
  const message = git(root, [
    "log",
    "-1",
    "--first-parent",
    "--format=%B",
    "--no-show-signature",
    `--grep=^git-subtree-dir: ${agentUpstream.prefix}/*$`,
    "HEAD",
  ]);
  return /^git-subtree-split: ([0-9a-f]+)$/m.exec(message)?.[1];
}

function requireClean(root: string) {
  if (git(root, ["status", "--porcelain=v1"]))
    throw new Error("Commit or stash your changes before syncing agent. No files were changed.");
  for (const operation of ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD"]) {
    if (existsSync(resolve(root, git(root, ["rev-parse", "--git-path", operation]))))
      throw new Error("Finish or abort the current Git operation before syncing agent.");
  }
}

/** Attaches a squash baseline without replacing the already-vendored files. */
function adopt(root: string, split: string, upstream: string, repository: string) {
  const head = git(root, ["rev-parse", "HEAD"]);
  const tree = git(root, ["rev-parse", `${head}^{tree}`]);
  const squash = git(
    root,
    ["commit-tree", `${split}^{tree}`],
    `Squashed '${agentUpstream.prefix}/' content from commit ${split}\n\n` +
      `git-subtree-dir: ${agentUpstream.prefix}\ngit-subtree-split: ${split}\n`,
  );
  const commit = git(
    root,
    ["commit-tree", tree, "-p", head, "-p", squash],
    `chore(agent): establish upstream subtree baseline\n\n` +
      `Preserve the existing workspace tree and treat its differences as local changes.\n\n` +
      `agent-upstream-repository: ${repository}\nagent-upstream-commit: ${upstream}\n` +
      `git-subtree-dir: ${agentUpstream.prefix}\ngit-subtree-mainline: ${head}\ngit-subtree-split: ${split}\n`,
  );
  // Compare-and-swap protects a branch that changed while the upstream was fetched.
  requireClean(root);
  git(root, ["update-ref", "-m", "Adopt agent subtree baseline", "HEAD", commit, head]);
}

/** Fetches durable's isolated history, then merges it into the local workspace package. */
export function syncAgent(options: SyncOptions) {
  const root = git(resolve(options.root), ["rev-parse", "--show-toplevel"]);
  const log = options.log ?? console.log;
  const repository = options.repository ?? agentUpstream.repository;
  const ref = options.ref ?? "origin/main";
  if (ref.startsWith("-") || repository.startsWith("-"))
    throw new Error("Invalid upstream repository or ref.");
  if (!options.dryRun) requireClean(root);
  const previous = latestSplit(root);
  if (!previous && !options.initialize)
    throw new Error(
      "Agent has no subtree baseline. Initialize it with --init --ref <copied-upstream-commit>.",
    );
  if (options.initialize && (!options.ref || previous))
    throw new Error(
      "Initialization requires an explicit baseline ref and an uninitialized subtree.",
    );
  if (options.initialize && !git(root, ["ls-tree", "HEAD", "--", agentUpstream.prefix]))
    throw new Error("Initialization requires an existing, committed packages/agent directory.");

  const cache = resolve(root, git(root, ["rev-parse", "--git-path", "eta-upstream/pi"]));
  if (!existsSync(cache)) {
    mkdirSync(resolve(cache, ".."), { recursive: true });
    log("Cloning upstream into Git's local cache…");
    git(root, ["clone", "--single-branch", "--no-checkout", repository, cache]);
  } else if (git(cache, ["remote", "get-url", "origin"]) !== repository) {
    throw new Error("Upstream cache belongs to another repository.");
  }
  log("Fetching upstream main and tags…");
  git(cache, ["fetch", "--tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  const upstream = git(cache, ["rev-parse", "--verify", `${ref}^{commit}`]);
  const cachedUpstream = optionalRevision(cache, "refs/eta/agent/upstream");
  let split =
    cachedUpstream === upstream ? optionalRevision(cache, "refs/eta/agent/split") : undefined;
  if (!split) {
    log(`Splitting ${agentUpstream.sourcePrefix} at ${upstream}…`);
    split = git(cache, ["subtree", "split", `--prefix=${agentUpstream.sourcePrefix}`, upstream]);
    git(cache, ["update-ref", "refs/eta/agent/split", split]);
    git(cache, ["update-ref", "refs/eta/agent/upstream", upstream]);
  }
  log(`Upstream commit: ${upstream}\nDurable split: ${split}`);
  if (previous === split) {
    log("Agent is already at this upstream revision. Local changes are preserved.");
    return { upstream, split, changed: false };
  }
  if (options.dryRun) {
    log(
      `Would ${options.initialize ? "adopt the baseline for" : "merge into"} ${agentUpstream.prefix}. Workspace and history were not changed.`,
    );
    return { upstream, split, changed: false };
  }
  requireClean(root);
  // Squash commits record split IDs as trailers, so a normal clone may not have
  // those objects. Reconstruct the previous split before merging an older ref.
  if (previous && !optionalRevision(root, `${previous}^{commit}`)) {
    const message = git(root, [
      "log",
      "-1",
      "--first-parent",
      "--format=%B",
      "--grep=^agent-upstream-commit:",
      "HEAD",
    ]);
    const baseline = /^agent-upstream-commit: ([0-9a-f]+)$/m.exec(message)?.[1];
    if (!baseline) throw new Error("Cannot recover the previous agent upstream revision.");
    const recovered = git(cache, [
      "subtree",
      "split",
      `--prefix=${agentUpstream.sourcePrefix}`,
      baseline,
    ]);
    if (recovered !== previous)
      throw new Error("Recovered upstream split does not match the recorded baseline.");
    git(root, ["fetch", cache, previous]);
  }
  git(root, ["fetch", cache, "refs/eta/agent/split"]);
  if (options.initialize) {
    adopt(root, split, upstream, repository);
    log("Subtree baseline established. Existing files were preserved byte for byte.");
  } else {
    try {
      git(root, [
        "subtree",
        "merge",
        `--prefix=${agentUpstream.prefix}`,
        "--squash",
        split,
        "-m",
        `chore(agent): sync upstream durable\n\nagent-upstream-repository: ${repository}\nagent-upstream-commit: ${upstream}\n` +
          `git-subtree-dir: ${agentUpstream.prefix}\ngit-subtree-mainline: ${git(root, ["rev-parse", "HEAD"])}\ngit-subtree-split: ${split}\n`,
      ]);
    } catch (error) {
      const manifest = `${agentUpstream.prefix}/package.json`;
      if (
        optionalRevision(root, "MERGE_HEAD") &&
        git(root, ["ls-files", "--unmerged", "--", manifest])
      ) {
        try {
          const versions = [1, 2, 3].map(
            (stage) => JSON.parse(git(root, ["show", `:${stage}:${manifest}`])) as unknown,
          );
          const merged = mergeAgentManifest(versions[0], versions[1], versions[2]);
          writeFileSync(resolve(root, manifest), `${JSON.stringify(merged, null, "\t")}\n`);
          git(root, ["add", "--", manifest]);
          log("Merged independent agent manifest fields, preserving Eta integration settings.");
        } catch (manifestError) {
          log(manifestError instanceof Error ? manifestError.message : String(manifestError));
        }
        if (!git(root, ["ls-files", "--unmerged"])) {
          git(root, ["commit", "--no-edit"]);
          log("Upstream merged. Run vp install and validate desktop before using the update.");
          return { upstream, split, changed: true };
        }
      }
      throw new Error(
        "Agent sync stopped. If Git reports conflicts, resolve them and run git commit, or run git merge --abort. Your local changes were not discarded.",
        { cause: error },
      );
    }
    log("Upstream merged. Run vp install and validate desktop before using the update.");
  }
  return { upstream, split, changed: true };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === "--") args.shift();
    const { values } = parseArgs({
      args,
      options: {
        ref: { type: "string" },
        "dry-run": { type: "boolean" },
        init: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) {
      console.log(
        "Sync upstream packages/durable into packages/agent.\n\nvp run sync:agent [--ref <commit-or-tag>] [--dry-run]\n\nRequires a clean workspace and creates subtree merge commits.\nDry runs may fetch into Git's cache, but do not change workspace files or HEAD.\nFor an existing copy without a baseline: --init --ref <copied-upstream-commit>",
      );
    } else {
      syncAgent({
        root: process.cwd(),
        ref: values.ref,
        dryRun: values["dry-run"],
        initialize: values.init,
      });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.cause instanceof Error) console.error(error.cause.message);
    process.exitCode = 1;
  }
}
