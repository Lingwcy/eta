# Lessons from Eta work

Read this before changing code. Each lesson states a rule, why it matters,
and the commits or reports that support it. Use the relevant rules during
implementation and review.

## Maintaining this file

- Add a lesson when a fix, regression, or review reveals a mistake that could
  recur. Record the preventive rule, the failure it prevents, and a commit,
  issue, test, or report that demonstrates it. A commit title alone is not
  enough: read the diff and relevant source. Distinguish observed failures
  from risks inferred from the source.
- Update a matching lesson rather than adding another version of the same
  rule. Keep evidence short and specific; this is not a changelog.
- `Seen` counts separate dates on which a review found supporting evidence,
  not commits, releases, or repeated reads of the same incident. Count a
  lesson at most once per review date. A later review of an already recorded
  incident does not increase its count.
- At three separate review dates, move the preventive rule into the relevant
  section of [AGENTS.md](AGENTS.md). Keep the evidence here under
  [Promoted lessons](#promoted-lessons), linking to that section. If the rule
  already exists there, strengthen it only if the new evidence adds something.
- Rewrite or remove a rule when its assumptions change. Follow Eta's
  documentation rules before adding architectural or user guidance elsewhere.

## Reviewing a batch of work

A maintainer or agent can run this review after a batch of merged work or as
a daily review. This file does not schedule reviews automatically.

1. Read [AGENTS.md](AGENTS.md), this file, and the relevant guidance. Choose
   an explicit commit range and record its base and head. Inspect the diffs,
   follow-up fixes, and available test or CI results. Check the user's reported
   case, sibling paths, and assumptions made by verification.
2. Record only findings supported by inspected evidence. Use Eta's focused
   validation commands when a finding needs reproduction. Record the command,
   result, and limitations; unavailable CI results or untested platforms remain
   unknown. Browser and computer-use verification still requires explicit
   agreement under AGENTS.md.
3. Update lessons and promote those that meet the recurrence rule. Unresolved
   findings stay explicit; reviewing a change does not authorize merging,
   releasing, closing issues, or creating a PR.
4. After the entire chosen range has been inspected, record a checkpoint below
   with the full base and head hashes, review date, scope, and remaining gaps.
   The next review starts after that head. If the head is no longer an ancestor
   of the branch being reviewed, choose and record a new base rather than
   silently skipping history. A partial review names the inspected commits
   without advancing the checkpoint.

### Review checkpoint

No complete range has been reviewed yet. The initial review on 2026-10-12
inspected `a7972f252`, `d0105c5ea`, `f3a39419c`, and `9da537e31`, with
`8ed84475f` as sandbox introduction context. It was a source review of selected
commits, not a runtime, CI, or release audit. The lessons below do not claim
that the rest of the history has been reviewed or that those fixes pass today.

A partial review on 2026-10-13 inspected the merged PRs #1-#3
(`110cae2`, `13dc9a4`, `3c07177`), PR #5 (`356d298..4c9df92`), and a
full-tree source scan at `da60559`. It was a git-history and source
review, not a CI, runtime, or release audit, and it does not advance
this checkpoint. Its findings are recorded under
[Release and merge discipline](#release-and-merge-discipline).

## UI scope

**Exercise interactive popup content when changing compound UI components.**

- Evidence: on 2026-10-13, opening the worktree branch submenu threw `ComboboxGroupContext is missing` because its `CommandGroupLabel` lacked a `CommandGroup`. Typecheck and renderer build had passed; a DOM interaction test reproduced the exception and now covers opening, searching, selecting and reopening the real picker.
- Check: preserve the library's required parent contexts and test the affected interaction, rather than static markup or callback wiring.
- Seen: 2026-10-13.

**Keep approved UI lifetimes and entry points; covering existing surfaces does not authorize adding new ones.**

- Evidence: on 2026-10-13, the maintainer rejected this branch's persistent composer context after thread creation, worktree management dialog, and new project settings category. The requested worktree configuration belonged in the draft's compact gear menu; these additions were removed.
- The same day's follow-up rejected the wide new-branch form and outlined input. Compact styling must cover naming states as well as the initial menu; naming now uses one borderless menu row. The maintainer explicitly requested the lasting constraints in [AGENTS.md](AGENTS.md#ui).
- Check: compare the final entry points and visibility conditions with the supplied UI reference and maintainer instructions before calling frontend work complete.
- Seen: 2026-10-13.

## Build and runtime boundaries

**Include host system configuration in native sandbox regression fixtures.**

- Evidence: the 2026-10-13 Bot CI runs failed six Git metadata tests on Linux. A container with `/etc/gitconfig` reproduced the same six failures: Git treats denied system configuration reads as fatal. Restricted workers now pass `GIT_CONFIG_NOSYSTEM=1` to child commands; the native sandbox regression grants no access to a fixture's system config and still verifies Git init/status succeed. The focused Linux run passed all 35 Git, sandbox and recovery tests after the fix.
- Check: verify the environment reaches the executed command, not just the launcher; keep unrestricted execution's host configuration behavior.
- Seen: 2026-10-13.

**Exercise the default host configuration in integration tests, not only test overrides.**

- Why: a fixture can bypass an incompatible product default and make a feature appear usable.
- Evidence: the 2026-10-13 Core Git continuation found Desktop's default worktree directory inside the protected data root, while existing worktree fixtures overrode it with an unprotected sibling directory. The native worktree test now uses the default management root and verifies an agent can edit and commit there. The maintainer approved moving new worktrees beside the data directory while retaining its protection.
- Check: cover the actual default root and sandbox policy together; keep existing thread execution directories stable when changing future defaults.
- Seen 1× (2026-10-13).

**Test a new setting through the IPC decoder and persistence, including its reset path.**

- Why: renderer and storage types can accept a setting while the separately maintained IPC patch schema rejects it.
- Evidence: on 2026-10-13, the permission settings screenshot showed “请求参数无效”. `approvalReviewer` existed in the runtime and desktop settings schemas but was absent from `main/ipc.ts`. The `reviewer choices` regression in `main/service/settings/index.test.ts` reproduced that rejection, then verified updates, subscriptions, reopening and resetting after adding the shared field schema.
- Check: send the same payload the renderer uses through `dispatchCommand` into the real settings service; retain rejection tests for malformed values.
- Seen 1× (2026-10-13).

**Verify the runtime entry point and the packaged dependency graph when adding
a dependency. A dev server succeeding does not prove an installed client works.**

- Why: source aliases, prebuilt workspace output, and Node loading TypeScript
  directly impose different requirements. Local build artifacts can hide a
  missing packaged dependency.
- Evidence: `8ed84475f` introduced the sandbox. `f3a39419c` replaced constructor
  parameter properties in `SandboxedExecutionEnv` with erasable TypeScript for
  direct Node loading. `9da537e31` added the missing `@eta/agent/env` source
  alias to the desktop build; its commit body identifies reliance on Agent
  prebuilt output in a clean environment.
- Check: trace the actual worker/runtime entry and workspace subpath exports.
  Run the affected package verification in a clean build context when changing
  packaging; report separately whether an installed client was exercised.
- Seen 1× (2026-10-12).

**Normalize filesystem paths before using them as module names or build keys,
and inspect every build configuration that derives those keys.**

- Why: Windows path separators can produce different alias and entry names
  from the same source tree.
- Evidence: `d0105c5ea` normalized separators in Bot and Desktop workspace
  aliases and Core build entry keys in the same fix.
- Check: cover Windows-style separators at the conversion boundary and inspect
  sibling configurations. A macOS build does not establish Windows packaging
  correctness; state which platform actually ran.
- Seen 1× (2026-10-12).

## Asynchronous verification

**Wait for the observable completion condition, with a bounded timeout that
allows native startup, before checking an operation's result.**

- Why: native worker startup adds latency that an in-process fake may not
  expose. Reading the result too early confuses unfinished work with failure.
- Evidence: `f3a39419c` gave the Core client test's completion poll a 10-second
  timeout before reading `proof.txt`; its commit body calls out native startup.
- Check: use the operation's completion signal rather than a fixed sleep.
  Inspect initialization, cleanup, and timeout paths. Increasing a timeout
  alone is not evidence that a hang or flake's cause has been resolved.
- Seen 1× (2026-10-12).

**Propagate a shared deadline through every asynchronous stage, including tools and the final decision check.**

- Why: a model timeout alone does not bound context gathering or prevent a late approval.
- Evidence: the 2026-10-13 sandbox review follow-up found `review.ts` passing its timeout only to the model, while `tools.execute` received the original context. The focused `packages/core/test/service/runtime/review-task.test.ts` now blocks a tool, model availability and the final settings read, and verifies timeout leaves the request pending for the user.
- Check: cancel the actual operation as well as its waiter; retain a non-cancelled context for recording the fallback and cleanup.
- Seen 1× (2026-10-13).

## Defaults and explicit choices

**A default model fallback must honor enabled and available models; an explicit
model choice must still be validated as an explicit choice.**

- Why: inheriting a parent model can fail when the child's policy forbids it
  or its provider is unavailable. Silent replacement of an explicit choice
  hides a different problem from a missing default.
- Evidence: `a7972f252` added allowed models after the parent in the default
  candidate list. Its tests cover forbidden and unavailable parent models,
  rejection of an explicitly requested unavailable model, and preference for
  an allowed parent over another enabled model.
- Check: test default inheritance, unavailable and forbidden candidates,
  explicit selection, and the case where no candidate is usable.
- Seen 1× (2026-10-12).

## Release and merge discipline

**Update and release sources must belong to the repository owner.**

- Evidence: PR #1's `e9508a1` set the electron-builder publish target to
  `owner: "XiaoMouz"` and `releaseUrl` to
  `https://github.com/XiaoMouz/eta/releases/latest`, so installed
  clients would have updated from a contributor's personal repository.
  PR #3's `6599b6f` corrected both to Lingwcy, after the v0.0.4-v0.0.6
  release commits (`41305c6`, `0938cf3`, `a2c7bac`) had already landed.
  Whether any user installed an update from the wrong source is not
  recorded and remains unknown.
- Check: in any release-facing diff, search for `publish`,
  `releaseUrl`, and `owner`, and search the whole diff for the
  contributor's username. Any update source that is not the repository
  owner blocks the merge.
- Seen 1x (2026-10-13).

**Supply-chain and release PRs need a minimum review: no minute-scale
merges and no author self-merge.**

- Evidence: PR #1 merged about 7 minutes after creation (`110cae2`),
  PR #2 about 3 minutes (`13dc9a4`), and PR #3 about 1 minute; the
  merge commit `3c07177` for PR #3 was authored by the contributor
  themselves. All three touched auto-update, electron-builder, or
  release workflow surfaces.
- Check: before merging, compare the created-to-merged interval and
  the merger's identity. A PR touching `electron-builder.config.*`,
  release workflows, or `updater.*` must be merged by a maintainer who
  is not the author, with a real build result recorded.
- Seen 1x (2026-10-13).

**Toolchain and dependency upgrades must state their reason and a real
build result; an empty body does not merge.**

- Evidence: PR #2's `f5d6a48` raised electron-builder from 26.15.3 to
  26.17.0 with an empty commit body and no test changes, while the
  lockfile left `builder-util` and `electron-publish` at 26.16.0.
- Check: an upgrade PR records why the upgrade is needed and the
  artifacts of one real packaging run (at minimum the produced file
  names), and the reviewer verifies that same-family packages in the
  lockfile moved together.
- Seen 1x (2026-10-13).

**A PR that mixes concerns, or grows past a reviewable size, must be
split before merge.**

- Evidence: PR #5 changed 103 files and +8110 lines
  (`356d298..4c9df92`); its final commit `4c6d7ae` is titled as
  completing worktree configuration and the GitHub sidebar and fixing
  CI - three concerns in one title. PR #1 also mixed an unrelated
  SIGTERM exit fix (`cddb98b`) into the auto-update PR.
- Check: run `git diff --stat <base>...<head>` and group the files by
  area. Touching two or more of core, UI, worktree, GitHub, and CI in
  one PR means splitting it into independently revertible PRs.
- Seen 1x (2026-10-13).

**Do not stack an undocumented mega-commit on top of structured
commits.**

- Evidence: inside PR #5, `9ed4ddd` (no body, 39 files, +1528 lines)
  overlapped 18 files with the six structured commits before it, and
  `4c6d7ae` closed the branch with another 65 files and +2968 lines.
  A regression inside either commit cannot be bisected to a step.
- Check: compare adjacent commits' file sets while reviewing; when a
  later commit rewrites more than roughly a third of an earlier
  commit's files, require the history to be rewritten into bisectable
  steps, each with a body stating the problem and the fix.
- Seen 1x (2026-10-13).

**Every capability word in a PR or commit title must be visible in
the diff.**

- Evidence: PR #1 was titled `add auto update and sign`, but the
  baseline `98cf59c` already contained the signing and notarization
  logic (`signedRelease`, CSC/APPLE handling) and `e9508a1` did not
  change it. Reviewing by title overstates what was verified.
- Check: match each title keyword against `git show --stat`. A
  signing claim additionally requires a signed build's log or
  artifact checksums.
- Seen 1x (2026-10-13).

**Security-sensitive features need an independent reviewer and must
not merge on the night they are proposed.**

- Evidence: PR #5's auto-review pipeline started at `6ed951f`
  (2026-10-12 23:06) and merged at `4c9df92` (2026-10-13 05:32),
  under 7 hours later and 3 minutes after the final push, with no
  non-author review in the git record. The same branch had already
  exposed a missing IPC field and six failing Linux CI tests, showing
  author self-testing was not yet complete.
- Check: a PR that auto-approves sandbox escapes or widens
  permissions records a non-author review, and each failure fallback
  (error, timeout, model unavailable, circuit breaker) names its
  covering test before merge.
- Seen 1x (2026-10-13).

**Do not reuse one feature branch across PRs.**

- Evidence: PR #2's merge `13dc9a4` still came from
  `XiaoMouz/feat/updater`, the same branch as PR #1, although its
  content was an electron-builder upgrade, which makes later history
  archaeology confuse the two changes.
- Check: a new PR gets a fresh branch named for its own concern, and
  the reviewer confirms with `git log <prev-merge>..<head>` that the
  branch carries only this PR's commits.
- Seen 1x (2026-10-13).

## Promoted lessons

None yet. Eta's existing rules, including “Hit every surface” and focused
verification, continue to apply without fabricated recurrence counts.
