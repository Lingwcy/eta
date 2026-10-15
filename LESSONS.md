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

**Recover filesystem staging before treating a cross-store lifecycle operation as rolled back.**

- Evidence: on 2026-10-13, the scheduled-task `SIGKILL at delete-intent` fixture moved a real session into `.trash` and killed the host before its Catalog replacement. The reopened Catalog still contained the thread, but opening it failed with `StorageCorrupt`. Session removal now journals before renaming and reconciles that journal against Catalog before opening threads; six real archive/delete crash windows pass, including restore-after-archive without restarting plans.
- Check: kill the process after filesystem staging and after Catalog persistence; prove the original transcript remains accessible when the operation did not commit and that committed deletion does not resurrect it. An in-memory rollback callback cannot cover process death.
- Seen: 2026-10-13.

**Map environment entity IDs consistently in admission replies, observations and persisted provenance.**

- Evidence: the 2026-10-13 source audit of `96d54e4` found prefixed cloud snapshot operation IDs paired with raw ordinary submission replies. The chat client acknowledges completion by comparing those identities, so mismatched mapping could leave its admission pending. The controlled SSE regression in `main/bot.test.ts` now drives a real `ThreadAgentClient` through the Bot transport and verifies completion clears the pending admission and preserves message provenance. The risk was found by source inspection; this does not claim a native UI reproduction.
- Check: exercise the ordinary chat path as well as scheduled delivery when changing shared identity mapping. Request IDs, tool-call IDs and content fingerprints remain opaque.
- Seen: 2026-10-13.

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

**Keep provider continuation payloads in runtime storage, out of display snapshots.**

- Evidence: on 2026-10-15, the affected Bot thread returned 2,936,340 bytes, including 1,636,107 bytes of opaque `thinkingSignature` values. The server produced it in about 150 ms, but a client-side transfer received only 476 KB in 25 seconds and exceeded Desktop's 10-second deadline. `apps/bot/src/snapshot.test.ts` and the HTTP history/SSE regression verify the display projection removes continuation signatures without mutating Core history, tool arguments or text phase metadata.
- Check: measure real payload fields, cover initial history and live events, and retain signed originals for subsequent provider calls. Compression alone does not remove incompressible continuation data; SSE compression must flush small events and release producers when cancelled.
- Seen: 2026-10-15.

**Carry snapshot backpressure through the consumer's asynchronous write.**

- Evidence: on 2026-10-14, the Core slow-consumer regression produced 43 deliveries while its first callback was still blocked. Observation coalesced projection work but ignored the Promise returned by Bot's SSE writer. Awaiting delivery keeps one write in progress and only the newest pending view; the real Hono unread-body regression reaches the latest revision within three frames instead of replaying the backlog. Cancellation and rejected delivery tests verify subscriptions release their watches. This reproduces a queue defect; no crash-time heap snapshot was captured on eta-server.
- Check: stall the actual transport reader as well as an asynchronous consumer, verify other subscribers keep progressing, and exercise cancellation and rejected writes.
- Seen: 2026-10-14.

**Do not let a background state machine wake itself on its own bookkeeping writes.**

- Evidence: on 2026-10-13, the scheduled-task dispatcher wrote pending → dispatching → pending on a busy admission and fed both those writes and the resolved admission promise back into its wake queue. Restoring those notifications in `packages/core/test/service/schedules/dispatcher.test.ts`'s steady-busy regression reproduced 243 attempts instead of one; separating dispatcher-origin writes and only waking for late outcomes made it pass. Bot capacity tests also verify a Controller release wakes a queued task without waiting for the retry timer.
- Check: exercise the real background loop under a stable busy condition, not only a single deterministic tick. Keep host capacity and user management notifications active; ensure internal receipt changes still reach client subscribers without retriggering admission.
- Seen: 2026-10-13.

**Cover tool argument generation when mapping model activity to UI status.**

- Evidence: on 2026-10-13, a Desktop session spent about 2 minutes 38 seconds generating a `write` call containing a 284-line plan. The thinking status hid on the streamed tool call, while the tool card only appeared once execution began. The `streaming tool arguments` regression in `renderer/src/agent/thinking-status.test.ts` reproduced the missing indicator and now covers partial arguments, timer continuity, execution and completion.
- Check: treat streamed tool arguments as active model generation; keep execution, approval pauses, retries and deferred responses distinct.
- Seen: 2026-10-13.

**Wait for the observable completion condition, with a bounded timeout that
allows native startup, before checking an operation's result.**

- Why: native worker startup adds latency that an in-process fake may not
  expose. Reading the result too early confuses unfinished work with failure.
- Evidence: `f3a39419c` gave the Core client test's completion poll a 10-second
  timeout before reading `proof.txt`; its commit body calls out native startup.
- Evidence: on 2026-10-14, Linux CI run `38569607843` failed the scheduled-thread integration test because it captured an occurrence before the dispatcher's one-second admission wait completed, then repeatedly queried an undefined operation ID. The test now deliberately holds admission past that window and reconciles the durable receipt before querying completion; the same boundary is checked for manual runs.
- Check: use the operation's completion signal rather than a fixed sleep.
  Inspect initialization, cleanup, and timeout paths. Increasing a timeout
  alone is not evidence that a hang or flake's cause has been resolved.
- Additional evidence: on 2026-10-14, Linux CI diagnostics showed the real Core
  schedule delivery test stuck before `ThreadService.submit`; the occurrence
  remained `dispatching` and no durable receipt existed. Both a global timer and
  Node's timer promise failed to advance under the parallel test suite. The
  regression now holds admission behind a test-controlled promise, verifies
  the initial dispatching state, releases admission, then polls the durable
  receipt and checks exactly one user message. The focused dispatcher test
  then revealed a separate Linux CI constraint: the runner lacks `bwrap`, so
  the default workspace-write mode correctly blocks Core submission with
  `SandboxUnavailable`. Because this integration asserts scheduling and message
  admission rather than sandbox isolation, it explicitly uses full access only
  for its temporary test workspace. Native validation ran outside the
  protected `.codex` worktree directory; inside it the sandbox correctly denied
  loading the development worker.
- Seen: 2026-10-12, 2026-10-14.

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
