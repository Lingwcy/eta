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

**A previous turn cannot prove that the current stream has been saved.**

- Evidence: on 2026-10-18, #126's valid Mobile snapshots lose the current reply when any older assistant shares its timestamp/provider/model, even after a later user message. Missing optional metadata has the same failure. Matching the latest conversation entry retains the stream; JSON reparse/save controls keep one row, and an orphan result still stays visible. Desktop's existing latest-entry boundary passes the equivalent control.
- Check: treat timestamps as metadata, not globally unique ownership. Cover an intervening user turn, colliding or missing metadata, actual save handoff, and orphan tool results; do not claim a full tool-call identity solution from this narrower deduplication fix.
- Seen: 2026-10-18.

**Keep PR-only visual evidence in GitHub review artifacts, not the source tree.**

- Existing rule: [Pull requests](AGENTS.md#pull-requests) requires UI evidence but prohibits committing PR-only screenshots/assets.
- Evidence: on 2026-10-18, #123 verifies that main 2b77de9 contains 20 review-only files from #28/#109 (16 PNGs and four fixture/revision comparison notes), despite the rule. Their immutable commit links preserve reviewability when the current tree is cleaned; product code and user documentation do not reference them.
- Check: distinguish review material from runtime icons and product documentation images, include legacy review folders, and pin historical evidence before deletion. Removing current-tree files neither erases history nor shrinks an existing full Git clone; do not rewrite history to claim otherwise.
- Seen: 2026-10-18.

**Bound mounted transcript rows and index tools once per observation.**

- Evidence: on 2026-10-17, the maintainer reported slow opening and client-wide lag in a long-running scheduled thread. Source inspection found every historical message mounted, with every message rebuilding and scanning the full tool index. An isolated Chrome fixture with 200 runs and 2,000 transcript records mounted about 22,000 DOM nodes before virtualization and about 750 afterward; this is synthetic evidence, not a profile of the reported thread.
- Check: use a shared tool index, navigate by virtual offsets, and retain expansion outside virtual rows. The real-component `chat-transcript.test.ts` regressions cover bounded mounting, navigation to unmounted history, expansion restoration, bottom follow and reading-position preservation. Keep a changing tail identity when a footer follows the messages, or append detection cannot recognize new output.
- Seen: 2026-10-17.

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

**Keep a committed connection's client, credentials and cache origin together after later failures.**

- Evidence: on 2026-10-17, #110's MobileStore regression saves Bot B's credentials and URL, then rejects its cache write. The old catch restores only client A; a subsequent public refresh/send uses A's token and writes its directory into B's cache. First-connect and same-URL token-rotation cases also lose the committed client; cache-load and credential-save failures before commit remain on A.
- Check: inject failures before and after the commit point and assert the next real client request destination/credentials and persisted cache namespace, not just a status label. Do not roll back one field of an already committed identity; retain error propagation and late-response ownership guards.
- Seen: 2026-10-17.

**Validate update metadata against actual asset bytes, not only a matching digest.**

- Evidence: on 2026-10-17, #103 accepts a Mac ZIP with the correct hash but wrong declared size, or an empty ZIP with its matching hash and zero size. Both split and combined feeds pass; the real release CLI with fake GitHub publishes the inconsistent feed. The current Mac updater uses that declared size for its local ZIP proxy Content-Length; Windows already checks size.
- Check: require nonempty assets and exact byte lengths for each architecture before creating or editing a release draft. Keep digest-failure controls, valid feed merging and published-release rerun behavior. Distinguish a controlled corrupt artifact from an actually broken published version.
- Seen: 2026-10-17.

**Resolve optional summaries from the latest call instead of inheriting an earlier cache hit.**

- Evidence: on 2026-10-17, #91 runs two real write turns with the same provider call ID. Both files are correct, but the second legacy call inherits the first summary. Five further regressions cover an unmarked or removed declaration, empty or invalid text, and a partial streamed call; all fail before clearing that ID before checking the latest call.
- Check: provider call IDs need not be globally unique across turns. Preserve unrelated history and valid replacement summaries, and exercise the shared projection in a suite actually run by CI; the current Bot/Desktop workflows build Agent but do not run its unit suite.
- Seen: 2026-10-17.

**Classify header-decided HTTP failures before reading an unused body.**

- Evidence: on 2026-10-17, #84's controlled Response streams show Desktop and Mobile consuming a stalled 401 body before rejecting authentication; Mobile's event subscription cannot reach its fatal-auth path while that body remains open. Handling the status first and cancelling the unused stream makes both clients reject without a body pull, including when cancellation fails.
- Check: cover ordinary requests and streaming entry points on sibling clients. Do not let optional diagnostics or cleanup replace an already authoritative authentication error; preserve non-auth server diagnostics and existing body-read deadlines.
- Seen: 2026-10-17.

**End failed turns without treating a temporary provider limit as a permanent scheduling block.**

- Evidence: on 2026-10-17, eta-server's reviewer exhausted its model usage window at 01:52 UTC. Its scheduled receipt was failed and all tasks had settled, but two queued child-report wakeups kept `RecoveryState.pending` true, reserving the checkout for over seven hours. Real Bot regressions reproduce the same block with scheduled and ordinary input, then verify failed-turn cleanup admits a peer, repeated quota errors retain the recurring plan, and a later automatic slot succeeds with the same model after availability returns.
- Check: distinguish queued submissions from executing tasks using one durable inspection. Preserve the failure and delegated output, end stale wakeups before releasing capacity, keep the reservation if cleanup fails, and guard asynchronous cleanup with the admission's identity. Do not disable recurring plans or hard-code a provider's usage-window duration.
- Seen: 2026-10-17.

**Treat deployment policy changes as explicit choices and recover scheduled interruptions without replaying unsafe tools.**

- Evidence: on 2026-10-16, eta-server's v0.1.23 deployment passed `ENABLE_FULL_ACCESS=false`, removing an existing permission while three stored conversations retained full access. The same deployment interrupted the reviewer while it watched that deployment's workflow; its nested Bash checkpoint required unsafe replay, so recovery reserved the checkout and left sibling schedules busy despite healthy HTTP and systemd status. The deployment CLI regression preserves the original config by default; real Bot restart tests cancel the interrupted scheduled operation, retain its recurring plan and admit queued work without replaying the tool.
- Additional evidence: on 2026-10-17, the v0.1.25 deployment interrupted `subagent-report:10946` after its originating scheduled receipt `10887` had succeeded. Exact matching against in-flight schedule receipts missed this autonomous follow-up and reserved the checkout again. Restart regressions cover automatic/manual scheduled origins and nested Code mode; ordinary origins keep manual recovery. The spawning task's durable creation ID lies between its owner's input and answer entries, allowing old sessions to be attributed without relying on a request prefix or an earlier schedule in the chat alone.
- Check: distinguish an omitted deployment choice from explicit enable/disable. Match interrupted work to its durable schedule origin, including the dispatching receipt gap and completed inputs that spawned later autonomous reports. Reject missing or ambiguous lineage; preserve manual recovery for ordinary work and missing definitions, and retain checkout blocking if cancellation fails.
- Additional queue evidence: on 2026-10-17, the live status API showed no active threads, a reviewer blocked on recovery after v0.1.25 deployment, and a pending manual scan waiting for that checkout. The ordinary-turn restart regression now checks the explicit project blocker and that stopping it wakes the queued task. Waiting until its first blocked pass exposed a missing capacity notification: a recovery-only reservation has no live admission lease to release, so its queue otherwise sleeps until the periodic retry.
- Check: display queued work and recovery blockers separately from execution, including the chat and cached offline views. Notify scheduler capacity changes when clearing recovery reservations, not only live admission leases.
- Seen: 2026-10-16, 2026-10-17.

**Distinguish structured tool values from display content using the admitted contract.**

- Evidence: on 2026-10-16, #72's native Code mode regression executes ten valid JSON values through a declared structured tool. The script receives the original values, but nested previews drop scalars and arrays or misinterpret records containing `type` as display blocks. Reading the persisted run's structured-tool declarations preserves JSON values while retaining schema-less text/image handling.
- Check: cover falsy values, arrays and content-like business records, not only object-shaped success results. Use the durable declaration rather than a current registration that may have changed after admission; preserve preview budgets and keep image payloads out of schema-less text previews.
- Seen: 2026-10-16.

**Validate SDK compatibility separately from frozen dependency resolution.**

- Evidence: #29 and #54 failed Mobile CI at Expo's compatibility gate despite successful frozen installs. On 2026-10-15, main `ff2545b` reproduces the expected Expo `~57.0.30` / Router `~57.0.28` mismatch; the release commit only changes Desktop/root versions. Expo CLI reads its native-module recommendations from an online SDK API, so a lockfile does not freeze that contract. Aligning these patches makes the compatibility check pass; this does not establish that the old native app was broken.
- Check: preserve the compatibility gate, verify the SDK's required toolchain together, and export both platforms. Keep release-age exceptions restricted to required exact versions and verify unrelated workspace importers remain unchanged; do not disable policy or force offline metadata merely to turn CI green.
- Seen: 2026-10-15.

**Parse streaming protocols independently of transport read boundaries.**

- Evidence: on 2026-10-15, byte-split LF frames passed Desktop's thread and schedule subscriptions, but valid split CRLF and bare-CR frames produced six failures: no completed thread observation or schedule revision arrived. The shared Desktop parser normalized each chunk separately, losing CRLF boundaries split across reads. Incremental line-ending normalization makes all 18 Bot transport tests pass, including UTF-8, admission acknowledgement, reconnect and cancellation; Mobile's existing independent parser passes its four boundary tests unchanged. This is a controlled protocol reproduction, not a production incident or an explanation of unrelated CI failures.
- Check: feed valid frames across arbitrary byte boundaries, including UTF-8 and line endings, on every consumer of a shared parser. Do not assume a server's usual LF output or a whole-frame mock covers the wire protocol.
- Seen: 2026-10-15.

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

**Merge dependency versions, the lockfile, and installation policy together.**

- Evidence: on 2026-10-15, PR #60's merge `7abce4c9e` kept the Expo lockfile updates from `d7950fd7e` but restored older release-age exceptions. Bot, Desktop and Mobile CI all stopped during installation; `vp install --frozen-lockfile` reproduced rejection of `@expo/cli@57.0.31` and `@expo/router-server@57.0.13` locally. Restoring main's exact-version exceptions preserves both the Expo update and Pi 1.3.0.
- Check: after resolving dependency merges, compare the manifest, lockfile and exact-version exceptions from both parents, then run the frozen installation used by CI. A successful install before the merge does not validate the merged graph.
- Seen: 2026-10-15.

## Asynchronous verification

**Make shared publication decisions at their remote commit boundary, not from an earlier listing.**

- Evidence: on 2026-10-17, #105's release CLI overwrites a higher Latest version that appears during upload or immediately before finalization. Both controlled interleavings fail even though the pre-existing-newer-version control passes. GitHub's documented make_latest=legacy mode lets the server choose by its version/date policy when publishing, instead of a client forcing a stale choice.
- Check: cover state changes after the initial read and at the final request, normal advancement, publication failure/retry and immutable published reruns. A late refresh alone does not remove TOCTOU; do not claim a mock proves the service's internal concurrency implementation.
- Seen: 2026-10-17.

**Keep provider continuation payloads in runtime storage, out of display snapshots.**

- Evidence: on 2026-10-15, the affected Bot thread returned 2,936,340 bytes, including 1,636,107 bytes of opaque `thinkingSignature` values. The server produced it in about 150 ms, but a client-side transfer received only 476 KB in 25 seconds and exceeded Desktop's 10-second deadline. `apps/bot/src/snapshot.test.ts` and the HTTP history/SSE regression verify the display projection removes continuation signatures without mutating Core history, tool arguments or text phase metadata.
- Additional evidence: on 2026-10-17, #100's real HTTP operation-polling regression returns 220,582 bytes for a short answer because this route bypasses the history/SSE display projection. Reusing the assistant display filter removes the continuation fields while preserving Core answers, receipt/origin identities, text phases and business payloads.
- Check: measure real payload fields, cover history, live events and operation-result polling, and retain signed originals for subsequent provider calls. Compression or client-side schema stripping does not remove the transfer/decoding cost; SSE compression must flush small events and release producers when cancelled.
- Seen: 2026-10-15, 2026-10-17.

**Keep deadlines that become due during an asynchronous pass in the next wake calculation.**

- Evidence: on 2026-10-16, the controlled dispatcher regression advances its clock after discovery but before sleep calculation. Filtering out the now-due schedule leaves no wake deadline and delays delivery by the 60-second idle fallback. Keeping that deadline lets the existing one-second minimum trigger automatic delivery without a new notification. The delayed-arming Bot integration exercises the same boundary with a real Controller; the original #81 CI failure did not record enough timing to identify its exact boundary.
- Check: move time across a deadline inside a pass, drain pre-existing notifications, and verify delivery without manually ticking or publishing a new event. Preserve the minimum polling delay so due deadlines cannot create a busy loop.
- Seen: 2026-10-16.

**Arm automatic-delivery fixtures after planning and worker startup have completed.**

- Evidence: on 2026-10-15, PR #28's container verification failed with no schedule occurrence. Delaying submission by six seconds in the main native verifier reproduced that error: its five-second interval anchor had passed before creation, so the next slot moved five minutes ahead. The verifier and Bot tool integration now create an active agent plan safely in the future, then re-arm it after the planning turn is idle and delivery responses are installed. The same injected delay passes after this change; the CI failure's original timing remains unknown without a stored schedule diagnostic.
- Additional evidence: on 2026-10-16, PR #81's Bot CI failed the root-tool automatic-delivery poll. Holding re-arming until its selected slot passes reproduces a `nextRunAt` exactly five minutes later. Freezing the schedule clock only until the arm is durably persisted, restoring it in `finally`, and checking the exact slot lets both immediate and delayed arming retain real automatic Controller delivery. Re-arming itself has latency; merely moving it after planning does not make a short interval anchor deterministic. The original CI run did not record the slot, so its precise timing remains unknown.
- Check: keep automatic delivery and real sandbox work in the proof; do not replace them with a manual run or merely extend the completion timeout.
- Seen: 2026-10-15, 2026-10-16.

**Carry snapshot backpressure through the consumer's asynchronous write.**

- Evidence: on 2026-10-14, the Core slow-consumer regression produced 43 deliveries while its first callback was still blocked. Observation coalesced projection work but ignored the Promise returned by Bot's SSE writer. Awaiting delivery keeps one write in progress and only the newest pending view; the real Hono unread-body regression reaches the latest revision within three frames instead of replaying the backlog. Cancellation and rejected delivery tests verify subscriptions release their watches. This reproduces a queue defect; no crash-time heap snapshot was captured on eta-server.
- Evidence: on 2026-10-15, holding Desktop's first asynchronous SSE consumer with two frames already buffered reproduced a second callback after unsubscribe, close, disconnect or switching Bots. All four controlled cases failed before guarding the inner frame-drain loop and pass afterward. Waiting for reader cancellation proves the assertion covers the resumed drain rather than a premature callback count; no in-flight consumer is forcibly interrupted.
- Check: stall the actual transport reader as well as an asynchronous consumer, verify other subscribers keep progressing, and exercise cancellation and rejected writes. Check cancellation before draining already-read frames, not only before the next read.
- Seen: 2026-10-14, 2026-10-15.

**Do not let a background state machine wake itself on its own bookkeeping writes.**

- Evidence: on 2026-10-13, the scheduled-task dispatcher wrote pending → dispatching → pending on a busy admission and fed both those writes and the resolved admission promise back into its wake queue. Restoring those notifications in `packages/core/test/service/schedules/dispatcher.test.ts`'s steady-busy regression reproduced 243 attempts instead of one; separating dispatcher-origin writes and only waking for late outcomes made it pass. Bot capacity tests also verify a Controller release wakes a queued task without waiting for the retry timer.
- Check: exercise the real background loop under a stable busy condition, not only a single deterministic tick. Keep host capacity and user management notifications active; ensure internal receipt changes still reach client subscribers without retriggering admission.
- Seen: 2026-10-13.

**Keep pending work visible through every asynchronous stage.**

- Evidence: on 2026-10-13, a Desktop session spent about 2 minutes 38 seconds generating a `write` call containing a 284-line plan. The thinking status hid on the streamed tool call, while the tool card only appeared once execution began. The `streaming tool arguments` regression in `renderer/src/agent/thinking-status.test.ts` reproduced the missing indicator and now covers partial arguments, timer continuity, execution and completion.
- Evidence: on 2026-10-15, the maintainer reported no visible response after a Bot schedule's manual run. The sidebar only disabled its menu, and Desktop ignored the existing schedule event stream in favor of 15-second polling. The `manual run shows submission immediately` DOM regression now holds the request open and checks submission, queuing, execution, success and failure; `schedule events refresh immediately` covers push updates, an overlapping stale read, reconnect and cleanup.
- Check: treat streamed tool arguments as active model generation; distinguish submission and queuing from admitted execution. Keep approval pauses, retries and deferred responses visible, and consume available state notifications instead of waiting for a polling interval.
- Seen: 2026-10-13, 2026-10-15.

**Propagate a shared deadline through every asynchronous stage, including tools and the final decision check.**

- Why: a model timeout alone does not bound context gathering or prevent a late approval.
- Evidence: the 2026-10-13 sandbox review follow-up found `review.ts` passing its timeout only to the model, while `tools.execute` received the original context. The focused `packages/core/test/service/runtime/review-task.test.ts` now blocks a tool, model availability and the final settings read, and verifies timeout leaves the request pending for the user.
- Check: cancel the actual operation as well as its waiter; retain a non-cancelled context for recording the fallback and cleanup.
- Seen 1× (2026-10-13).

## Defaults and explicit choices

**Project authoritative configuration consistently when opening and observing a conversation.**

- Evidence: on 2026-10-18, #161 delivers valid Mobile SSE sandbox changes through the real client/parser. The thread snapshot updates, but the model/thinking-only projection retains an old sandbox mode in the priority UI configuration, next draft and cache. Matching the open projection fixes both immediate and coalesced frames; unchanged/missing-mode and no-policy-RPC controls distinguish state synchronization from server permission changes.
- Additional evidence: on 2026-10-18, #168 receives a live Desktop model switch but still renders the open-session model name/window and global selection. Matching provider/model IDs against the correct local/Bot catalog synchronizes metadata; unknown models clear stale capacity, later catalog arrival and real picker selection recover, and matching session-only metadata remains usable.
- Check: cover every configuration field on both ingestion paths, including clearing absent optional fields and downstream inheritance/persistence. A schema accepting the field does not prove the client actually applies it.
- Seen: 2026-10-18.

**An explicit discard must not depend on saving the data being discarded.**

- Evidence: on 2026-10-17, #111's MobileStore forget action fails at a cache-quota error before it can remove independently stored credentials. Skipping that final save lets clear proceed; held-write regressions verify old writes settle before removal even when they reject. Ordinary disconnect still saves drafts, and actual deletion errors remain visible and retryable.
- Check: preserve the distinction between retain and discard. Keep epoch invalidation and the serialized storage barrier, test in-flight completion/rejection, and do not swallow a real wipe failure or claim native deletion guarantees from an in-memory fixture.
- Seen: 2026-10-17.

**Editing schedules must preserve stored timing semantics, not reconstruct unchanged values from lossy UI fields.**

- Evidence: on 2026-10-14, reviewing PR #19 found that `6937c42` replaced the existing daily/weekly timezone with the machine timezone. The `editing a daily/weekly plan preserves its timezone through real IPC` regressions in `renderer/src/components/schedules/schedules.test.ts` failed before the fix: renaming a plan changed `Asia/Shanghai` to `UTC`. They now check the persisted rule and next run remain unchanged; the existing creation test still verifies the machine-timezone default.
- Evidence: on 2026-10-15, the adjacent once-rule edit path still round-tripped epoch milliseconds through an HH:mm display. The `editing a once plan preserves its exact instant unless rescheduled` IPC regression failed because a title edit changed 09:15:42.987 to 09:15:00. Existing instants now survive metadata-only edits, while choosing a new time still reschedules.
- Check: edit plans created by an agent or another client through the real form and persistence boundary, including non-minute timestamps and a different timezone. Cover explicit rescheduling as well as preservation; creation-only tests cannot establish that edits retain meaning.
- Seen: 2026-10-14, 2026-10-15.

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

**Bind asynchronous monitoring and cleanup to an admission, not just its stable thread ID.**

- Evidence: on 2026-10-16, #57 holds a real Core recovery result across stop and resubmit of the same Bot thread. The old successful check releases the replacement's checkout reservation and admits a competing writer; an old failed check marks the replacement blocked. Two native regressions reproduce both outcomes before the fix and verify current completion still releases capacity afterward.
- Additional evidence: on 2026-10-16, #76 preserves real unfinished work, reopens Core, resumes it and explicitly stops it before injecting a late resume failure. The outer recovery queue still re-blocked the idle checkout despite the inner lease guard; another thread received Busy. Reporting superseded ownership before cleanup prevents this, while a current-failure control still reserves the checkout until stop.
- Additional evidence: on 2026-10-17, #113's Mobile persistence gates expose ten stale continuations that restart polling/SSE or issue follow-up requests after dispose. A connection-attempt token spans the pre-epoch cache flush; the original epoch is checked before later nested operations. This prevents stale callers from acquiring a fresh generation without rejecting the latest overlapping connect; ten current-owner controls retain observation and send completion.
- Additional evidence: on 2026-10-18, #114 adds distinct failure/coalescing cases: the global refresh-busy flag suppresses a committed replacement's request, an old 401 aborts its live stream, and an old queued cache failure marks it failed. Client-scoped occupancy and owner checks reject these effects. The handoff itself invalidates validation-window open/metadata results and aborts old streams; same-URL token rotation and current-failure recovery are covered.
- Additional evidence: on 2026-10-18, #131's real Desktop skill selector switches to project B while the previous A catalog remains clickable, submitting A's enable/disable settings even after B loading fails. Binding the cached catalog to its queried cwd removes those stale actions; same-scope refresh waits and success/error retry controls retain current actions. Cancelling obsolete fetch responses alone did not protect already-rendered controls.
- Additional evidence: on 2026-10-18, #136 holds a Desktop authentication submission or its state read across Escape/close. The stale continuation reopens the cancelled/completed dialog, reports an obsolete error, or clears a new login's busy state. Login ID plus an invalidated submission epoch guards both awaits, errors and finally; API-key/OAuth success/error and completed-before-close refresh controls remain intact. #140 then holds poll/post-answer snapshots inside the same live login: a late old read regresses the prompt/progress or injects an obsolete error. Shared request ordering prevents both directions; current-error, real Select submission and resumed-poll completion controls remain intact.
- Additional evidence: on 2026-10-18, #144 submits a real thread rename/delete, closes it with Escape, then starts another rename. The old successful save clears the parent editor and loses the new draft, including reopening the same thread. Comparing the captured Edit instance preserves the replacement while the original mutation and catalog refresh still complete; current success/error retry and stale-failure controls pass. Unmounting the child does not cancel its callback into a live parent.
- Additional evidence: on 2026-10-18, #148 holds a Desktop library reload failure after a newer read/save/reconnect succeeds, or during a new settings write. Success already checked revision, but the background catch still overwrote the current global error. Binding both outcomes to the read and invalidating prior reads at mutation admission preserves current errors, retries and foreground rejections; gates and a check-phase barrier verify settled fire-and-forget work.
- Additional evidence: on 2026-10-18, #151 holds Desktop library writes/post-write reads across dispose and reconnect. Read revision guards do not prevent old mutation refresh/recovery or release busy for the new lifetime. A separate lifetime guard spans both awaits, catch and finally; disposal releases the old slot and reconnect admits a fresh write. Public-client controls preserve current failures and caller rejection, without claiming to abort accepted server writes or reproduce a production App remount.
- Additional evidence: on 2026-10-18, #154 holds browser hide/capture previews across a newer capture of the same page. The record identity still matches, so the old frame overwrites a newer one or the retained fallback after a new failure. Per-record capture identity protects both entry points without invalidating other pages; current/closed-page and fallback controls pass. FakePage gates verify the async contract, not native GPU arrival frequency or production screenshot leakage.
- Additional evidence: on 2026-10-18, #164 completes an address failure then restores a valid URL through simulated native history events. The Manager still overlays its old error; pending address failures also survive explicit back/forward/reload because only URL loads advance revision. Sharing navigation admission clears old errors and invalidates prior loads, while unavailable-history and new-native-failure controls keep current failures visible. Native guest-initiated navigation and OS behavior remain unverified.
- Check: carry a per-claim identity across awaits, validate it before releasing or changing state, and dispose late subscription setup instead of overwriting a new monitor. Apply this to outer recovery/error queues too, before cleanup erases ownership evidence. Revalidate the original connection/view after persistence as well as network responses, before nested operations capture new ownership. Exercise stop/resubmit while previous work is pending; unsubscribing alone cannot retract an already running callback.
- Seen: 2026-10-16, 2026-10-17, 2026-10-18.
- Promoted on 2026-10-18 to [Verifying](AGENTS.md#verifying).

**Verify the runtime entry point and the packaged dependency graph when adding
a dependency. A dev server succeeding does not prove an installed client works.**

- Promoted on 2026-10-16 to [Verifying](AGENTS.md#verifying).
- Why: source aliases, prebuilt workspace output, and Node loading TypeScript
  directly impose different requirements. Local build artifacts can hide a
  missing packaged dependency.
- Evidence: `8ed84475f` introduced the sandbox. `f3a39419c` replaced constructor
  parameter properties in `SandboxedExecutionEnv` with erasable TypeScript for
  direct Node loading. `9da537e31` added the missing `@eta/agent/env` source
  alias to the desktop build; its commit body identifies reliance on Agent
  prebuilt output in a clean environment.
- Additional evidence: on 2026-10-15, PR #60's Desktop CI reached tests after installing Pi 1.3.0 but three integration suites failed to import `@earendil-works/chord/output`. Desktop's existing aliases sent published Chord to `dist` but omitted the new subpath; builds and typechecks had passed. The same five failing suites reproduce the omissions locally and cover the fix.
- Additional evidence: on 2026-10-16, PR #70's Desktop CI failed to import `@earendil-works/pi-codemode` in the schedules DOM integration suite. Its `source` condition pointed at files absent from the published package, while Node tests and packaged builds passed. The same failure reproduces locally; resolving the package and its used subpaths to published `dist` entries lets the existing real-service DOM tests load.
- Additional evidence: on 2026-10-16, PR #81's Bot build failed because its Desktop integration imports `DraftThread`, whose new localized error import used a renderer-only `@/` alias. Bot typecheck reproduces TS2307 even though Desktop CI passes. Importing the shared error contract directly avoids pulling renderer translation initialization into the reused draft logic; verify both host builds and the Desktop/Bot integration when changing such imports.
- Check: trace the actual worker/runtime entry and workspace subpath exports.
  Run the affected package verification in a clean build context when changing
  packaging; report separately whether an installed client was exercised.
- Seen: 2026-10-12, 2026-10-15, 2026-10-16.

**Wait for the observable completion condition, with a bounded timeout that
allows native startup, before checking an operation's result.**

- Promoted on 2026-10-15 to [Verifying](AGENTS.md#verifying).
- Why: native worker startup adds latency that an in-process fake may not
  expose. Reading the result too early confuses unfinished work with failure.
- Evidence: `f3a39419c` gave the Core client test's completion poll a 10-second
  timeout before reading `proof.txt`; its commit body calls out native startup.
- Evidence: on 2026-10-14, Linux CI run `38569607843` failed the scheduled-thread integration test because it captured an occurrence before the dispatcher's one-second admission wait completed, then repeatedly queried an undefined operation ID. The test now deliberately holds admission past that window and reconciles the durable receipt before querying completion; the same boundary is checked for manual runs.
- Evidence: on 2026-10-15, PR #60 CI run `38844172790` exposed the same stale receipt in the SIGKILL `pending` recovery test. Holding reopened admission behind a controlled promise reproduces `InvalidInput` locally; reconciling and re-reading the occurrence before polling its operation fixes the failure. Both `pending` and `dispatching` recovery now exercise delayed admission.
- Check: use the operation's completion signal rather than a fixed sleep.
  Inspect initialization, cleanup, and timeout paths. Increasing a timeout
  alone is not evidence that a hang or flake's cause has been resolved.
- Additional evidence: on 2026-10-16, PR #81's Linux CI failed the normal-shutdown test while waiting for a native child's PID with the default poll deadline. Injecting 1.5 seconds of model latency reproduces that assertion; bounded native-startup and process-exit waits pass the same delayed case while retaining the real child, shutdown and durable aborted-receipt checks. Disposal now runs in `finally` when startup assertions fail. This demonstrates the fixture's short readiness assumption, not the unrecorded startup timing of the original CI failure.
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
- Additional evidence: on 2026-10-15, issue #38's parent-cancellation fixture timed out before its child tool started. Injecting 1.5 seconds of child-model latency reproduced the false precondition failure and a cleanup hook timeout. Separating the controlled child response from tool readiness and moving startup inside `try/finally` lets the same delayed case pass. An injected startup assertion failure now reports only that assertion, without a cleanup timeout. This reproduces a fixture defect; the original CI run did not record enough timing to prove it was the sole cause.
- Additional evidence: on 2026-10-15, #41 was reproduced by holding `Submission.wait` after its durable terminal receipt was visible. The dispatcher integration's immediate deletion then failed with `Busy`. PR #43 verifies deletion stays blocked while the supervisor lease is held, releases the controlled gate, and waits for running/recovery/foreground-work to clear before deleting. This proves a fixture assumption is invalid without weakening production deletion guards; it does not identify every historical CI failure's timing.
- Seen: 2026-10-12, 2026-10-14, 2026-10-15.
