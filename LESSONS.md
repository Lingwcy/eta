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

## Build and runtime boundaries

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

## Promoted lessons

None yet. Eta's existing rules, including “Hit every surface” and focused
verification, continue to apply without fabricated recurrence counts.
