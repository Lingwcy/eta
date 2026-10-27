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

**Separate passive reads and configuration from execution admission.**

- Evidence: on 2026-10-27, a maintainer reported scheduled-task model edits rejected while another task was running. Focused Core controls found that an idle peer already remains editable, but active or recoverable work in the target chat rejects configuration with `Busy`. Agent's generation checkpoint pins each prepared request's model and thinking level; removing the configuration guard lets future requests use the saved settings while the held response completes with its original model and recovery stays paused.
- Additional evidence: #475 on `2dda40a` permits subagent list while recovery is required, then unconditionally resumes the whole Harness. A registered host task commits a checkpoint, survives actual preserve shutdown and reopens paused; listing an empty child set executes its finish phase, writes a real temporary file and commits terminal completion. Skipping resume for list preserves the paused task, and explicit resume still finishes it exactly once. This is a real Core-layer control, not a production write incident or proof of a new model request.
- Check: exercise the edited target separately from the selected chat and a running peer. Verify active requests, subsequent requests and recovery state rather than treating a configuration save or passive query as a new execution. Check actual scheduling and task effects across restart, not only returned metadata or callback counts. The sidebar DOM and Desktop-to-Bot HTTP controls cover their respective paths; they do not reproduce the maintainer's live server state.
- Seen: 2026-10-27.

**Detach observation containers without serializing their large strings.**

- Evidence: on 2026-10-27, a 15-second eta-server CPU profile attributed 2,114 of 3,036 samples to the full snapshot JSON stringify/parse round trip, with another 515 samples in garbage collection. The service had repeated JavaScript heap OOM crashes; this profile identifies the current CPU hotspot, not every historical OOM allocation. A real ObservationService read/subscription fixture containing a 24 MiB image aborts under a 64 MiB heap with the old round trip and passes with container-only copying, including mutation isolation and omitted optional properties.
- Additional evidence: Bot admission monitoring discarded every subscribed snapshot and separately polled durable recovery state every 250 ms. Its queued-input fallback also opened the entire thread on every poll solely to check whether the preceding turn failed. Recovery now derives that condition from the live run and paged receipts; focused regressions cover failed/completed/aborted turns, current work, capacity release and stale admission ownership without full-history reads.
- Check: preserve caller ownership while sharing immutable string values. Consumers that only need recovery state must not subscribe to full transcripts. Exercise both snapshot reads and subscriptions under a constrained heap; increasing a timeout or restarting alone does not prove memory behavior is fixed.
- Seen: 2026-10-27.

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
- Additional evidence: on 2026-10-18, Mobile tool cards independently scanned the full transcript for results, stopped state and nested previews. A synthetic 20,000-entry/30-query fixture performs 1,200,000 history visits in the old nested/status helpers versus 20,000 with a shared snapshot index; this is not a native frame-rate measurement. `apps/mobile/src/conversation.test.ts` counts history visits and verifies unseen nested previews are not decoded, while `components/message.test.ts` covers status priority, live replacement and expanded result updates.
- Check: use a shared tool index, navigate by virtual offsets, and retain expansion outside virtual rows. Decode nested previews only for queried parents and cache them within the observed snapshot; eagerly decoding all historical previews can replace one long-thread bottleneck with another. The real-component `chat-transcript.test.ts` regressions cover bounded mounting, navigation to unmounted history, expansion restoration, bottom follow and reading-position preservation. Keep a changing tail identity when a footer follows the messages, or append detection cannot recognize new output.
- Seen: 2026-10-17, 2026-10-18.

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

**Redact complete URL userinfo without consuming path, query or fragment data.**

- Evidence: on 2026-10-25, #452's real Core/Git controls on `a9208d9` store HTTPS/SSH remotes with an unescaped email-style username. First-`@` redaction leaves the complete fake password in the public repository DTO; separate query/fragment controls instead lose their host. Redact through the last authority separator, bounded by `/`, `?` and `#`, and leave the original Git transport configuration untouched.
- Check: cover raw and percent-encoded userinfo, extra password delimiters, IPv6/ports and non-userinfo `@`. Use fake credentials and real DTO reads; do not infer production leakage, remote authentication success or protection of arbitrary query secrets from these tests.
- Seen: 2026-10-25.

**Check command success before treating machine-readable stdout as a complete observation.**

- Evidence: on 2026-10-25, #448's real Core/Git controls on `c718f7c` corrupt a temporary index or configure an invalid fetch refspec. The corresponding `status`/`remote -v` exits 128, but unchecked stdout still produces `ready`: empty status becomes clean and a failed remote read becomes no remotes. Rejecting the failed read returns `unavailable`; repairing only the fixture restores its dirty-file counts and GitHub selection without losing files.
- Additional evidence: on 2026-10-27, #473's same-size hello/world fixture has a deterministic real-Git counterexample: minimal stat checking, untrusted ctime, a retained file mtime and a rewritten later index yield raw status containing only the untracked file, despite changed README bytes. The actual Core recovery assertion fails with unstaged=0. A different-size marker preserves the dirty-file contract under this controlled schedule; failure-only diagnostics now retain raw status, index cache, configuration, nanosecond file/index stat and content without hiding the original assertion. This proves a fixture assumption, not that historical CI used these settings or that every recurrence is explained.
- Check: command wrappers may resolve nonzero exits rather than throw. Validate the exit code before interpreting empty or partial output; preserve legitimate empty/unborn states and verify recovery after repair. A fixture requiring dirty content must not depend on equal-size stat-cache invalidation; use a deterministic metadata boundary and preserve raw failure evidence before changing production reads. Report the failed stage without blindly copying sensitive repository diagnostics. These are controlled read failures, not evidence that Git deleted user data.
- Seen: 2026-10-25, 2026-10-27.

**Check actual desktop-session ownership before interpreting AX or injecting input.**

- Evidence: on 2026-10-24, both TextEdit and an isolated Electron fixture returned `AXApplication` roots in `AXWindows` with AX success and `AXIsProcessTrusted() == true`. The session dictionary reported `CGSSessionScreenIsLocked == true`; synchronous WindowServer foreground/key ownership was `loginwindow`, while NSWorkspace still reported the previous foreground app. A native observation now reports locked-session non-execution before AX traversal. Six native policy cases cover active, locked, inactive, incomplete-login and unknown sessions without accessing the desktop.
- Check: distinguish locked-session state from permission loss or an unsupported application. Validate the selected AX window's role, process and identity before binding it to a CGWindow; recheck real WindowServer ownership across input. A cached foreground PID cannot prove that input remains in the intended session.
- Additional evidence: on 2026-10-24, the maintainer reported that acceptance interrupted video on another full-screen Space (subsequently clarified from “second screen”). The acceptance fixtures explicitly called BrowserWindow.show/focus at startup and again after setup or before screenshots. Those foreground mutations invalidate a non-interference claim even if the native input adapter never moves the physical cursor. Multi-display user activity remains unverified; tests must not steal or restore the foreground to make an isolation assertion pass.
- Follow-up: source review removed an unconditional foreground AXRaise. Controlled desktop acceptance later proved that AppKit can raise the background target while foreground/key PIDs remain unchanged. The maintainer explicitly approved restoring only the still-current, originally occluding foreground AX window. The new ordering recovery binds its actual AX handle, rechecks foreground/key/window ownership before raising, abandons user switches, and has no app-activation fallback. Thirteen pure ordering controls and actual menu/foreground-typing acceptance support this narrower policy, not zero-frame flicker or physical dual-display non-interference.
- Additional source finding: a human click in a background menu can leave the foreground PID unchanged, so PID equality alone cannot authorize focus recovery. Target-local pointer-downs now distinguish this helper's tagged events from other sources; the original policy revoked the admission across native recovery and subsequent tool calls. On 2026-10-25 the maintainer reported that simply inspecting the target permanently stopped a valid task. Manual interaction now invalidates the observation rather than the submission; native recovery still yields to the user, and a fresh observation drains the old guard before admitting more input. Explicit stop remains terminal. Controlled tests cover takeover during calibration/lookup and release/reacquire retries in Standard and Code mode; actual event delivery and multi-display behavior still need desktop acceptance. AX window identity now comes from its native window ID, with geometry used only to validate that identity; six native controls reject same-position replacements and mismatched owners.
- Native follow-up: the target tap observed SLPS key-window preparation as a pointer-down from the helper's own PID with userData=0, so requiring every own event to carry the CGEvent marker falsely stopped input. Admit that untagged shape only for this helper PID, and retain takeover for foreign sources. The corrected dedicated TextEdit path passed Chinese/emoji typing and selection with foreground/key ownership, cursor, ten overlapping window-order pairs and the active Space unchanged. That result does not establish menu or multi-display isolation. Keyboard routing now binds both recipient PID and AX focused-control identity; ten controlled scope cases cover hosted controls, wrong fields/windows, stale PIDs and bounded ancestry.
- Additional evidence: on 2026-10-24, a full-screen video Space made TextEdit return a successful empty AXWindows list although its dedicated document remained live in AXFocusedWindow/AXMainWindow and CGWindow records. Merging those independently published anchors, followed by the existing role/PID/native-window checks, passed cross-Space capture and hidden-renderer Standard/Code mode acceptance. Empty current-Space discovery is not proof of a closed document; this does not enumerate every unfocused window on other Spaces.
- Acceptance controls: the hidden renderer now requires a completed result file and its requested scenario. A normal run cannot prove stop/permission cancellation. The dedicated scroll fixture initially passed dx/dy to a deltaX/deltaY protocol and therefore sent zero movement; corrected arguments changed the actual visible range. Drag auditing excludes helper-owned untagged SLPS preparation records and counts tagged down/drag/up, proving cancellation after actual selection and a cleanup release. A movement fixture initially awaited only AX position, then found CGWindow still at the previous position; waiting boundedly for both observable records verifies the mutation/restore without weakening native identity checks. Moving during actual text input stops the remaining text and Enter, and a new helper accepts the replacement. These controls do not establish menu visual isolation or physical dual-display coverage.
- Additional acceptance: foreground PID equality also fails within one app. A directed click on the first TextEdit document while the second was foreground transferred its key window; foreground-window admission now rejects before input and preserves the second document's focus. A real system save sheet exposed a host-PID AX proxy for a different native window owner. Validate the AXSheet's host and control ancestry, then resolve the receiver by exact native window ID. optionIncludingWindow returned no entry for that ViewBridge surface while optionAll contained it. Actual Unicode input and Cancel/target exit passed with host 36529 and receiver 36540.
- Further evidence: a foreign window level setter/getter reported success/-1 while a fresh CGWindow record remained layer 0; local readback does not prove rendered order. A menu-opening keyboard burst delivered 49/50 characters despite stable-stage focus checks passing. A later instrumented run passing 50/50 alone was not a fix. A deterministic calibration gate held actual helper key ownership for all 50 inputs: the previous implementation delivered 0/50, while the PID-scoped opaque-event routing delivered 50/50. The actual production helper also passed a full-screen video Space with 50/50 characters, continuing video frames, unchanged foreground/key/Space/cursor, and zero helper HID mouse events. Keyboard protection must preserve event ownership/order and cleanup, without interpreting or logging key content.
- Capture boundary: with an actual off-Space TextEdit menu open, ScreenCaptureKit returned -3811 for automatic child capture and for the menu's exact native window captured alone. Main-window-only capture succeeded at the same time. On macOS 14.2+, off-Space screenshots explicitly exclude children and retain that scope through native JSONL, frame metadata and Standard/Code mode model notes; numbered AX menu actions remain available. A successful screenshot is not evidence that omitted children are closed.
- Presentation follow-up: requested computer-use panels need a separate accessory presentation process. Electron's all-Spaces process-type transformation in the main process hid/switched an existing full-screen window; skipping it in a regular process also switched Space when showing the pointer. The accessory process preserves video Space/foreground/input ownership and only receives images/coordinates; its private stop message revokes the exact admission. Native pointer visibility must ignore non-interactive full-display decoration surfaces: a layer-20 WindowServer surface otherwise hid every cue. Six pure visibility controls and actual overlay/full-screen acceptance cover these defects. A setup-only control also showed Space transitions without any overlay; fixtures now await the target's assigned Space/animation completion rather than assuming foreground PID or an early fullscreen event proves readiness.
- Packaged presentation follow-up: a successful Electron GUI-process exit (code 0) did not emit ChildProcess close while a descendant retained stderr. Observe the exact child's exit, release the inherited pipe and clean its owned profile; keep native-input cleanup on its separate cooperative drain path. Actual packaged preview/stop/exit and isolated ASAR verification passed. Multiple Electron entries now share chunks, so the isolated verifier must scope its Electron shim to transitive synchronous imports rather than mocking only the entry. Native JSONL likewise demultiplexes unsolicited pointer events before resolving operation replies; its interleaved-event test retains the real observation response.
- Status-surface evidence: on 2026-10-25 the maintainer reported that a live FlClashX panel failed observation. Read-only diagnostics identified AXPopover/native layer 25, outside the previous window/sheet and layer-0 policy. Magpie acceptance then identified a MenuBarAgent-hosted control owned by the actual app PID and an AXSystemDialog at layer 101. The icon AX wrapper itself returned AXPress failure; invoking the embedded app-owned button opened the panel. The corrected service/native path captured the icon and panel, switched Allowances and back to Agents, and closed with Escape. Keep ordinary-window admission at layer 0, validate the exact hosted control/window identity, and never substitute a label or position match.
- Menu admission evidence: on 2026-10-25, a clean Chrome `<select>` task repeatedly rejected the next menu action with “前台输入所有权已变化” and did not finish within the three-minute benchmark limit. Activation-notice recovery alone had left the target holding temporary key focus. `FocusRecovery.prepareInput` now reconciles only a menu recorded by the preceding owned input, with the same foreground and an admitted key recipient; seven native controls cover readiness, missing ownership, panels, takeover and failed calibration. The dev task selected Tokyo and saved the expected form values. Re-observation alone cannot repair this focus state, and arbitrary target key ownership must not authorize recovery.
- Seen: 2026-10-24, 2026-10-25.

**Make GUI tool contracts tolerant of key names and precise about partial execution.**

- Evidence: on 2026-10-23, a maintainer-supplied successful computer-use session took 20 model rounds and included three avoidable failures: one omitted frame ID and two `ENTER` key rejections. Business errors also suggested changing Code mode. Focused adapter and real Core/Code mode regressions now accept key aliases, reject an invalid chord before any key-down, preserve the frame on validation failure, and keep parameter recovery separate from sandbox failure. The controlled click/type/submit comparison uses five versus three model rounds with four versus two observations; it is not a real-model latency benchmark.
- Check: describe per-action requirements, normalize the whole chord before native input, and report definite non-execution separately from uncertain native failures. Combine already-decided input steps without skipping observation before an unknown target. A quiet screenshot is not proof that loading or sending finished.
- Additional evidence: on 2026-10-23, an isolated native probe with the window guard deliberately removed delivered `FIRST_ONLY` to the second TextEdit document while the observed first document remained `FIRST_INITIAL`. Per-PID keyboard posting does not bind a window. The production helper retains the actual AX window identity, checks it before each text chunk and submission, and refuses input until a directed click selects that window. Native verification checks selection/text/visible-range changes as well as the foreground app, physical cursor and a concurrently usable foreground input; a successful event-post call alone proves none of those outcomes.
- Additional evidence: on 2026-10-24, a successful maintainer drawing session contained four definite non-executions: missing observe app, redundant click app, an indexed popup without AXPress, and drag durationMs rejected by the tool contract. Matching app hints now validate admitted aliases without retargeting; controls without AXPress choose a validated center click before mutation, never retry an uncertain AX action. Both chat modes cover parameter recovery and a full drag path with one input/final capture. A dedicated native fixture confirms one down/up across all corners and release on cancellation while preserving foreground and cursor. The session also contained a model loop starting later drags at (0,0); accepted events do not establish correct drawing. Continuous paths remove the need for that endpoint loop, but no real-model speedup or drawing-accuracy claim follows from the fixture.
- Additional evidence: on 2026-10-25, the computer-use comparison rejected a user's partial Chrome window title and an input carrying the already-observed windowTitle. Unique app/title aliases now prefer exact matches, exclude accessory helpers from app-name fallback, and reject ambiguity with choices. Matching input hints validate the current frame; a conflicting app/title leaves that frame usable without sending input. Native selection controls and the Standard/Code mode session-parameter tests cover these contracts.
- Additional evidence: on 2026-10-25, #445's service-boundary controls on `1c95c47` send `["return","cmd"]` to both adapters for the valid chord `["Enter","Command"]`. The native loop applies flags only as it encounters modifiers, so preserving caller order can send an unmodified action key. Normalize aliases and validate the whole chord, then stably place modifiers before other keys; retain reverse release order. Service controls and Standard/Code mode Core tests cover the normalized boundary, not actual OS delivery or a production mis-send.
- Seen: 2026-10-23, 2026-10-24, 2026-10-25.
- Promoted on 2026-10-25 to [Verifying](AGENTS.md#verifying).

**Share remote observations by resource while keeping consumer lifetimes independent.**

- Evidence: on 2026-10-22, installed Desktop v0.1.110 independently subscribed the chat, subagent inspector and activity tracker to the same Bot thread. Three read-only history samples returned 19–29 MB of JSON each; SSE used the same full-history projection. `bot.test.ts` now covers one remote stream for multiple consumers, latest-snapshot replay, independent path subscriptions, consumer failures, final-owner cancellation and late old-owner cleanup. These are transport-count controls, not proof of the reported production 502's cause.
- Additional evidence: on 2026-10-22, #403 holds live and replay consumer callbacks across close, disconnect, URL replacement and same-URL token rotation. Eight controls report obsolete errors because clearing the observation Map and aborting readers leaves old consumer membership intact; unsubscribe/current-owner controls retain correct error behavior. Clearing memberships before transport teardown suppresses only stale reports. These are real adapter/stream interactions, not native Electron or production error-state evidence.
- Additional evidence: on 2026-10-22, #406 holds a joining asynchronous consumer in cached replay while a live snapshot arrives. Four public-adapter controls expose concurrent delivery: newer state applies before old replay, or the old error follows the newer snapshot. A per-consumer delivery chain preserves ordering, continues after a reported failure and rechecks membership before queued callbacks begin; accepted callbacks are not forcibly cancelled.
- Check: coalesce at the remote adapter by thread and subagent path, release only the last owner, and clear retained snapshots when the remote identity changes. Revoke consumer membership as well as transport ownership: an already-started async callback can still settle after cancellation. Preserve current consumer failures and independent peers. A UI component's independent subscription should not multiply remote history traffic.
- Seen: 2026-10-22.

**Reuse a filesystem scope only within the operation that verifies and publishes it.**

- Evidence: on 2026-10-20, BDS-06 resolves the same Bot workspace root 17 times while discovering eight existing directories. Reusing its canonical identity reduces those lookups to two in that fixture. A controlled root-symlink switch silently completes in the old scan; checking the root again after alias resolution rejects that refresh and invalidates both ownership maps until a fresh scan succeeds. Three focused regressions fail before the change, and missing checkouts/internal aliases/escaping links retain their behavior. This is an I/O-count proof, not a production benchmark.
- Additional evidence: on 2026-10-20, BDS-06 adds fresh target-only message checks alongside complete scans. Holding an older check after its final root read, then completing a scan or target revocation, lets the old result restore the revoked entry if coordination only tests an in-flight scan. Both controlled cases fail until every ownership publication advances a revision and older checks revalidate; a late old-root check must likewise preserve the newer namespace. A root identity from a previous publication is invalidation metadata, never a permission grant.
- Additional evidence: on 2026-10-21, removing a preliminary Bot project-creation scan must not let cached or coalesced callers borrow the execution owner's post-refresh. BotStore runs only one callback; a request-local completion flag is set only after that callback successfully publishes scope. Holding its reply, joining another request, switching the root and releasing the reply returns 201 instead of 403 if the joiner's own refresh is omitted; a stored replay has the same controlled failure. Keep the owner proof local, and retain the creation method's alias/ownership publication contract.
- Additional evidence: on 2026-10-27, holding one target check while another workspace publishes causes three project reads for two checks on `45d277bce`. Separate workspace revisions retain same-target revocation and whole-root/scan invalidation while the controlled case uses two reads. This proves cross-workspace retry amplification, not the cause of the production high CPU or JavaScript heap exhaustion.
- Check: cache scan-invariant identity only for that scan, revalidate it before publishing, revoke both old ownership maps when a root change is detected, and finish awaited alias work before replacing related maps. Partial updates must coordinate with completed publications as well as currently pending scans; an older check cannot undo a newer revocation or clear a replacement namespace. Do not turn this optimization into a cross-request permission cache or assume missing-path canonicalization performs no additional parent reads.
- Seen: 2026-10-20, 2026-10-27.

**Do not use pathname contents as Git record boundaries.**

- Evidence: on 2026-10-21, #348's real Git/Core branch listing turns a worktree path's second line into a false ref. Explicit NUL record framing fixes that producer/consumer pair. Follow-up #351 separately reproduces valid newline-root repositories reported unavailable and successful managed checkouts reported needs_reconciliation: rev-parse's bundled paths and worktree-list records also used LF as a boundary. POSIX regressions preserve embedded/trailing LF and complete create/list/replay/remove without mocking Git.
- Check: prefer Git's NUL modes for paths and share producer formats with parsers. Where a command has no NUL mode, read ambiguous values independently and remove only its explicit output terminator, never trim pathname whitespace. Keep ordinary-path fast paths and state precisely which parsers were verified; fixing one does not prove every Git path consumer is safe.
- Seen: 2026-10-21.

**Serialize a durable request before its first read, not just its final side effect.**

- Evidence: on 2026-10-21, #344's real Core/Git worktree regressions concurrently submit one creation ID. Identical inputs produce one failure; different branch parameters both succeed, even though sequential reuse already conflicts. Git's repository lock starts after both callers read and write the shared intent, and serial JSON writes alone cannot protect that read-check-write sequence. A service-local request gate makes identical callers replay one ready receipt and rejects the conflicting caller; a failed empty-repository attempt can still retry after the first commit.
- Check: gate the full fingerprint/receipt lookup, intent publication and execution for one logical request. Retain live validation of completed receipts, allow different request IDs to proceed independently, and release gate entries only after their last owner/waiter leaves.
- Seen: 2026-10-21.

**Do not hold a shared mutation lock while waiting for work that its control path must stop.**

- Evidence: on 2026-10-25, #461's real Core controls on `6b73a44` hold a delegated model response and enter external `subagent wait`. Both another thread's rename and the owner's stop remain queued behind ThreadService's shared mutation lock until the fixture releases the model. Excluding only wait from that lock lets rename complete while the child remains pending and lets stop settle the wait without manual model release.
- Check: separate long observation from mutation serialization, preserve writer locks and runtime/target validation, and verify that timeout returns do not cancel work. Active-task archive/removal must still return Busy while a wait is live. This does not prove HTTP disconnect cancellation or a production deadlock.
- Seen: 2026-10-25.

**Do not make a durable creation receipt wait for its derived directory.**

- Evidence: on 2026-10-19, BDS-05 still awaited DesktopBot's library/status refresh after the configured thread was already created. Holding either read blocks the first message in two real DraftThread/HTTP-adapter regressions before the change. Returning the creation first admits the prompt while both held-read and later catalog-publication controls pass. Background failure, an older poll, connection replacement and explicit disposal are covered without a production latency claim.
- Check: separate accepted creation from catalog discovery. Keep a trailing read after an older in-flight poll so the directory eventually includes the new record, and bind that continuation and the creation reply to their original connection generation. Do not use a catalog failure as evidence that creation was rejected.
- Seen: 2026-10-19.

**Bound observation transport silence independently of model output.**

- Evidence: on 2026-10-19, BDS-03's Desktop SSE could wait forever for headers or a body read while the directory remained connected. Controlled stalled-header/body/partial-frame cases fail before the fix; a server heartbeat plus per-attempt complete-frame deadlines recovers a current snapshot without treating an idle model as disconnected. Thread and schedule routes, cancellation, late fetches and a held heartbeat write are covered; this is not an OS TCP or production proxy reproduction.
- Check: bound both connection setup and subsequent complete frames, keep a single in-flight heartbeat under backpressure, and cancel timers and late deliveries with their owning observation. Consumer backpressure is not a transport deadline. Older servers without heartbeats will periodically reconnect during silence; do not claim native or deployment compatibility from stream fixtures alone.

**Authorize from current ownership metadata, not a display projection.**

- Evidence: on 2026-10-19, BDS-06 runs the real Bot HTTP/Core message path and records three full openThread projections before Core.submit. Catalog-only thread metadata removes those admission-time projections while keeping a full history read for GET. Regressions cover idempotent replay, six out-of-scope actions and revocation during receipt lookup; seven fail before the change. This is a call-count reproduction, not a production latency benchmark.
- Additional evidence: on 2026-10-20, BDS-06's status/credential HTTP routes still scanned projects despite not using workspace ownership. Three real HTTP regressions show four unnecessary refreshes, a status request blocked behind a held scan, and administration failing when the workspace root is not a directory. Placing those handlers after global guards but before discovery removes that dependency; scoped routes still scan and existing escaping-symlink tests pass.
- Additional evidence: on 2026-10-20, BDS-06 still discovers unrelated directories on thread history, persisted operation and SSE reads after message admission was scoped. Four real HTTP controls (including automatic HEAD dispatch) register an unrelated project before the change; fresh target validation removes that side effect while the next catalog read still discovers it. Previously readable paths and a new SSE connection reject a replaced checkout before reading history/results or subscribing. Keep the existing snapshot projection, filtering and stream lifetime intact when moving only the discovery boundary.
- Additional evidence: on 2026-10-21, BDS-06's metadata route can scope rename/archive/delete to one thread, but a display-project move also needs fresh destination visibility. Core.move only checks that the project exists. Holding the destination refresh reply, publishing a later real scan that revokes the source, then omitting the second source check returns 200 rather than 403 in the controlled HTTP regression. Validate both resources after the awaited destination refresh; do not confuse the display group with the execution workspace.
- Additional evidence: on 2026-10-21, BDS-06's subagent endpoint still discovers unrelated projects for both listing and spawning. Two real HTTP controls fail on that registration side effect before target scoping. Parent/path lookup and fork stay inside the owning Harness, so the same fresh thread scope applies to commands without changing Controller leases: a held child blocks another thread in the same project, release permits retry, and a foreign parent path is not found in the other thread. Partition discovery by actual resource consumption, not by whether a route runs an agent.
- Additional evidence: on 2026-10-21, BDS-06's workspace consumers have no thread ID but still need the same live project-root/cwd checks. Four HTTP controls discover an unrelated project before scoping creation, skills and Git reads. Creation and removal replays reject after revocation; an inside worktree cannot authorize its escaped project root. Sharing the publication loop preserves cross-entry revocation, with the thread-to-workspace resolver called inside every retry rather than captured before the loop.
- Additional evidence: on 2026-10-21, scoped project consumers must check the exact freshly validated root, not an aggregate of cached worktree grants. Replacing that check with any matching project value returns 200 after the root escapes. Worktree creation also needs a fresh base check before Core's durable-receipt shortcut: omitting it replays 201 after the base escapes. Both controlled variants should reject 403. Missing/multiple root records retain the old full-discovery rule; an optimization must not assume a Catalog invariant that does not exist.
- Check: keep ownership checks separate from display history and attach discovery to its consuming routes, not global administrative guards. Preserve authentication, body limits and shutdown checks for the fast path, and fresh scope checks at admission/on cached replies; never trade them for a cached allowlist just to avoid scans. Test gates target the operation boundary, not incidental snapshot counts.
- Seen: 2026-10-19, 2026-10-20.

**Carry retry policy as data across process boundaries.**

- Evidence: on 2026-10-19, BDS-08's initial Desktop thread read never retried. Bot transport failures were serialized as non-retryable InternalError, and preload-created Error fields cannot be relied on across Electron contextBridge. Returning the command reply DTO and unwrapping in the renderer carries explicit retry policy into bounded read-only retries; focused Bot/IPC, preload and client regressions cover the layers, not native Electron serialization.
- Additional evidence: on 2026-10-19, BDS-02's merged request-identity reuse still classified uncertainty with renderer-side instanceof, while preload threw the error from its own realm. A controlled message-only Error boundary plus real preload/BotStore reproduces duplicate admissions; serialized submit replies decoded in the caller retain one identity for existing threads and drafts, with definite-rejection and successful-next-message controls. These fixtures do not reproduce native Electron itself.
- Additional evidence: on 2026-10-20, BDS-02 still loses identity if IPC itself rejects without delivering a reply DTO. Four real-preload/BotStore controls reject before admission or after committing its receipt for both existing threads and drafts; all fail before classifying the missing reply as unknown. Keeping received DTO errors outside that catch preserves definite rejection, while explicit retry after a lost reply executes once. These controlled failures do not establish native Electron crash/restart persistence.
- Check: classify transient transport errors at the adapter, preserve the classification as a serializable reply, and decode it in the realm that consumes its type/fields. A missing reply is not proof of rejected admission; keep that transport failure distinct from an authoritative failure DTO. Retry only the read owned by the current client lifetime. For writes with unknown admission, preserve the logical request identity for explicit retry rather than applying a read retry loop.
- Seen: 2026-10-19, 2026-10-20.

**Observation failures do not establish an execution outcome.**

- Evidence: on 2026-10-19, BDS-09's Desktop activity watcher removed its running marker and cancelled the reconnecting subscription on a transport error. Three focused regressions fail before the fix; retaining observation through errors allows a later authoritative snapshot to confirm continued activity or completion. Synchronous errors, disposal, interrupted/faulted snapshots and obsolete callbacks are covered without a native network reproduction.
- Check: keep transport uncertainty separate from durable task status. Do not unsubscribe the only recovery path merely because it reports a temporary failure; release on authoritative inactivity or explicit disposal.
- Seen: 2026-10-19.

**Keep a committed connection's client, credentials and cache origin together after later failures.**

- Evidence: on 2026-10-17, #110's MobileStore regression saves Bot B's credentials and URL, then rejects its cache write. The old catch restores only client A; a subsequent public refresh/send uses A's token and writes its directory into B's cache. First-connect and same-URL token-rotation cases also lose the committed client; cache-load and credential-save failures before commit remain on A.
- Check: inject failures before and after the commit point and assert the next real client request destination/credentials and persisted cache namespace, not just a status label. Do not roll back one field of an already committed identity; retain error propagation and late-response ownership guards.
- Seen: 2026-10-17.

**Index stable catalog records once before a bulk traversal.**

- Evidence: on 2026-10-20, BDS-06 searches the entire registered-project array for each directory and allocates/scans its visible project IDs for each workspace. Real Core/filesystem fixtures count 624 rootPath reads at 32 projects before indexing; an upper bound of five reads per project passes afterward. Separate controls preserve newly discovered/missing projects, outside-scope exclusion and canonical duplicate-path first-match behavior. This measures metadata access, not production latency or every filesystem operation.
- Check: build indexes from the current scan, retain the original duplicate-key selection rule, and construct membership sets only after all eligible projects are known. Keep filesystem validation and request freshness unchanged rather than retaining a permission cache across scans.
- Seen: 2026-10-20.

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
- Additional evidence: on 2026-10-25, the maintainer removed a scheduled plan but its interrupted conversation retained the project reservation, leaving a replacement plan waiting behind a blocker absent from the schedule list. Focused schedule and Bot regressions cover stopping before user deletion, clearing Controller reservations, explicit manual restart with missing task definitions, request replay, stale revisions, failed cancellation and uncertain admission. Thread deletion also cancels live and cold persisted work before removing history; the native-tool regression checks process exit before runtime disposal.
- Promoted on 2026-10-25: cancellation and recovery ownership now has a lasting rule in [Verifying](AGENTS.md#verifying). Deployment choices and historical schedule-lineage evidence remain here.
- Seen: 2026-10-16, 2026-10-17, 2026-10-25.

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
- Additional evidence: on 2026-10-22, Desktop's main process sustained about 105% CPU while a remote scheduled thread had a 28,067,653-byte snapshot with 8,054 messages. Replaying that response as one SSE frame in 16 KiB text chunks took 4,786 ms with repeated whole-buffer delimiter searches and 18 ms with chunk-local searches and one final join. This isolates frame assembly, not end-to-end rendering or the original CPU stack's unnamed JavaScript frames. `apps/desktop/src/main/event-stream.test.ts` bounds searched characters for a fragmented large frame and covers delimiter splits; existing Bot tests exercise both stream consumers and cancellation. Mobile's independent line parser still has an analogous growing-buffer scan and was not changed in this Desktop fix.
- Check: feed valid frames across arbitrary byte boundaries, including UTF-8 and line endings, on every consumer of a shared parser. Do not assume a server's usual LF output or a whole-frame mock covers the wire protocol.
- Check large frames too: search only newly arrived text and retain unfinished fragments without repeatedly concatenating and scanning the growing prefix.
- Additional evidence: on 2026-10-22, #373 exercises Mobile's independent readEvents with a real byte stream carrying a 1 MiB snapshot in 1 KiB chunks: repeated growing-prefix newline searches offer 538,428,436 characters to the matcher. Incremental fragment assembly passes a linear search-input bound while preserving every LF/CRLF/CR byte split, UTF-8, incomplete-frame rejection, cancellation and the existing line/data size limits. #371 is independently scoped to Desktop; a shared protocol does not imply a shared parser. This is a deterministic algorithm regression, not a native-phone CPU or OOM measurement. Use constant-space observation: a spy retaining growing call arguments can manufacture a fixture OOM.
- Seen: 2026-10-15, 2026-10-22.

**A process-local runtime cache miss does not establish durable idleness.**

- Evidence: on 2026-10-22, #418 preserves an ordinary input, restarts Core, then deletes/archives its chat or removes its real Git worktree without opening history first. Three cold controls bypass Busy; the same three already-loaded controls refuse. Definition-free storage checks retain files and pending receipts without resuming the model, while idle, stopped and corrupt/missing-history cleanup controls remain valid. Separate persisted-storage cases page past background titles and retain all four live task states.
- Check: use live runtime state when owned, otherwise inspect durable submissions/tasks and close the storage handle. Do not open a Harness merely to check idleness, mistake every background task for a title, or remove the existing unreadable-history maintenance escape hatch. These are public Core/Git/filesystem controls, not native UI or cross-process race evidence.
- Seen: 2026-10-22.

**Recover filesystem staging before treating a cross-store lifecycle operation as rolled back.**

- Evidence: on 2026-10-13, the scheduled-task `SIGKILL at delete-intent` fixture moved a real session into `.trash` and killed the host before its Catalog replacement. The reopened Catalog still contained the thread, but opening it failed with `StorageCorrupt`. Session removal now journals before renaming and reconciles that journal against Catalog before opening threads; six real archive/delete crash windows pass, including restore-after-archive without restarting plans.
- Check: kill the process after filesystem staging and after Catalog persistence; prove the original transcript remains accessible when the operation did not commit and that committed deletion does not resurrect it. An in-memory rollback callback cannot cover process death.
- Seen: 2026-10-13.

**Validate persisted state on both read and write boundaries.**

- Evidence: #427's public Core reconciliation writes an unmanaged, unverified worktree with an empty commonDir, while its reader requires a nonempty identity. A normal history then fails even after restart. The 2026-10-23 follow-up covers both non-repository and externally removed checkouts, preserves unrelated managed receipts and execution, and rejects unknown identities in every managed or verified state. Validating candidate writes before replacement keeps an invalid update from poisoning the next read and leaves the queue usable.
- Additional evidence: on 2026-10-26, #465's real Bot/Hono administrator import accepts JSON numeric overflow as an OAuth expiry and returns 200, but the rewritten file makes the next real startup fail with StorageCorrupt. Number schemas accepted non-finite values that JSON turns into null; migration also lacked source validation. Finite checks at all write ingress preserve old bytes, while real reopen, atomic migration retry, finite expired/fractional values and corrupt-file rejection remain covered. Fake-token fixtures are not production outage evidence.
- Check: validate compatibility with the serialized read contract, not only the in-memory schema. Represent a legitimate unknown identity without inventing one or weakening verified-state invariants. Run the producer through actual persistence and reopen it; reject malformed existing stores rather than silently clearing them, and verify a refused write leaves the previous bytes intact. Schema acceptance is not workspace execution permission.
- Seen: 2026-10-23, 2026-10-26.

**Release local resources even when remote teardown fails.**

- Evidence: on 2026-10-27, #486 injects a rejected DiscordPort.stop into the real DiscordExtension with real SQLite. The normal control closes the handle; the failure control still permits status SQL reads because sequential teardown skips store.close. A finally around transport stop closes the database while preserving the original transport error, and a real reopen retains its cursor. The after-assertion cleanup lets the old implementation terminate without masking the resource postcondition.
- Check: order ingress shutdown before storage release, but do not make independent local cleanup conditional on remote success. Assert actual resource usability and persisted data, not only that a close callback ran. Transport failure is still failure; local cleanup does not prove the remote client disconnected.
- Seen: 2026-10-27.

**Reject preflight configuration errors before allocating durable resources.**

- Evidence: on 2026-10-22, #392 uses public Core with real temporary files and reopens the same data root after rejected projectless creations. Explicit unavailable models, unavailable defaults and an empty model catalog each leave three directories and Catalog workspaces without any thread. Deferring temporary allocation until model validation passes removes these side effects; corrected-model retry/replay and explicit-workspace validation-order controls still pass.
- Check: keep completed-request replay and namespace validation semantics, but perform available preflight checks before mkdir/Catalog publication. Assert both disk and metadata after reopening, not only the error code. A preflight ordering fix is not general rollback, orphan collection or a retention policy for later failures.
- Seen: 2026-10-22.

**Separate readable execution contexts from eligible new-conversation targets.**

- Evidence: on 2026-10-22, #410 connects production MobileStore/BotClient to real Bot HTTP/Core. With only a temporary workspace present, a fresh draft or newThread inherits its hidden ID and creates another thread in the same cwd; a test file from the first chat is visible at the new target. Both controls fail before classifying temporary targets; existing-thread continuation and an explicitly chosen project remain valid.
- Check: apply the client's documented creation policy instead of treating every readable workspace as a selectable project. Do not implicitly reuse a private temporary root or silently choose another project. Keep existing history/continuation and accepted pending identities intact; full projectless creation/discovery is a separate product capability. This is same-authorized-Bot file sharing evidence, not cross-account access or native navigation verification.
- Seen: 2026-10-22.

**Coordinate directory adoption with destructive cleanup across services.**

- Evidence: on 2026-10-22, #377's controlled temporary-workspace tests hold real path validation or removal while registering the same directory or a child. Without shared ownership coordination, all eight project/workspace and admission-order cases fail: registration can succeed while cleanup removes its files. Thread mutation and short Catalog update locks do not cover independent project/workspace registration.
- Additional evidence: on 2026-10-22, #413 uses public Core to adopt a temporary root or child, delete its original chat, and reuse the creation request ID. Both new targets inherit adopted test files because recursive mkdir accepts the surviving deterministic path. Exclusive fresh directory allocation passes both controls while valid receipt replay/restart and ordinary deletion still work; no cross-account access or native retry is claimed.
- Additional evidence: on 2026-10-22, #425 registers a managed checkout or its interior under another project ID. Four physical layouts expose busy, in-flight admission and tombstone checks scoped only to the original workspace ID/cwd; the twenty-case public Core/Git baseline has fifteen failures and five controls. Guard the actual checkout subtree, notify loaded aliases, and retain cancellation/cleanup of unavailable history without restoring execution permission. Controlled model and write-completion gates do not establish production timing or native UI behavior.
- Check: share ownership from path validation through Catalog publication or directory removal. A preserved directory must not be reclaimed merely because its former request ID produces the same pathname: reuse a live Catalog binding, or exclusively allocate a new directory. Test both admission orders, preserve adopted files, and reject registration after removal. `packages/core/test/service/threads/temporary-ownership.test.ts` uses real services and filesystem gates; this reproduces the unmerged feature's race, not a production incident.
- Seen: 2026-10-22.

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

**Treat a transport failure as an unknown durable outcome until it is reconciled.**

- Evidence: the [2026-10-19 Bot/Desktop synchronization audit](docs/issue/bot-desktop-sync-audit-2026-10-19.md) reproduces a committed message whose lost reply is retried with a new request ID, executing twice in the real BotStore. A separate controlled snapshot skips an acknowledged run's completion in favor of a later run, leaving Desktop's admission locked. The same audit reproduces clearing a background running marker on a temporary stream error and discarding a healthy chat view when the independent library poll recovers. These are controlled interleavings, not established causes of the reported production 502.
- Additional evidence: on 2026-10-19, #202 shows a catalog poll failure (independent of the thread stream) disabling a connected cloud chat and, on recovery, rebuilding every mounted client from an empty observation. Keying recovery on the observation's own health keeps history and input while still rebuilding a client that never connected; a cloud draft without an observation stays gated.
- Regression evidence: BDS-01's `renderer/src/agent/client.test.ts` checks the original durable operation after a later snapshot or late invoke reply, keeps queued/running/paused inputs locked, and preserves newer observations. Held lookups cover replacement admissions, disposal and transient read failures; local IPC and real Bot HTTP tests retain access to an earlier receipt after a later turn replaces `lastResult`.
- Check: retain a logical message's request identity across retries, reconcile its durable receipt after uncertain delivery, and distinguish connection health from execution outcome. Independent health signals must not gate or reset each other; a catalog error is not proof that a live session is unusable. A newer snapshot need not retain the particular operation needed to acknowledge an older request; transient observer errors cannot prove completion.
- Seen: 2026-10-19.

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

**Propagate cancellation through every asynchronous stage, not only its waiter.**

- Why: a model timeout alone does not bound context gathering or prevent a late approval. A cancellable operation still blocks shutdown if its owner drains it before reaching cancellation.
- Evidence: the 2026-10-13 sandbox review follow-up found `review.ts` passing its timeout only to the model, while `tools.execute` received the original context. The focused `packages/core/test/service/runtime/review-task.test.ts` now blocks a tool, model availability and the final settings read, and verifies timeout leaves the request pending for the user.
- Additional evidence: on 2026-10-27, #471's real Core-layer controls on `9a2fafc` enter external subagent waits before disposing the service graph. Uninterruptible waits delay disposal until their deadline; removing only that wrapper would leave the underlying gate outside the owner's cancellation. Forward the Effect signal into the actual wait Context and check it before resume. Finite/no-deadline controls verify prompt disposal, aborted owner signal, the exact wait watch stopped, and recoverable child work after reopening. A finally-only test abort keeps the old no-deadline implementation bounded without making the shutdown assertion pass.
- Additional evidence: #478 on `b078397` exercises actual authenticated Bot HTTP waits with finite/no deadline. Controller drains its in-flight reads before application shutdown reaches Core.close, so the Core cancellation capability cannot unblock the host. Both controls fail the close-completion condition on main. A Controller-owned wait signal passed through the local CoreClient aborts the actual Effect before drain; HTTP returns RuntimeClosing, cold Core reopen preserves recovery work, and Bot reopen verifies its writer lock is released. This does not establish TCP/OS-signal or Discord shutdown behavior.
- Check: cancel the actual operation as well as its waiter; retain a non-cancelled context for recording the fallback and cleanup. Cancel owned read waits before draining them, not at a downstream close step that drain itself prevents. Keep atomic writer policy separate from cancellable read waits, and verify resource cleanup and preserved work through actual reopen.
- Seen: 2026-10-13, 2026-10-27.

## Defaults and explicit choices

**Classify bare web addresses from parsed authorities, not raw prefixes.**

- Evidence: on 2026-10-19, #187 enters localhost/port URLs with query or fragment through the real browser panel. Inconsistent delimiters reject valid URLs or send them to search; raw prefixes select the wrong default scheme for uppercase localhost and public lookalikes. Parsed-host classification and consistent boundaries fix both create/navigate while preserving explicit protocols and ports. Native loads are controlled fixtures, not network/TLS or production-leak evidence.
- Check: cover query/fragment without a slash, local casing, lookalike public hosts, explicit/default ports, ordinary search and unsafe-scheme rejection at the actual navigation entry. Reconstruct from original input after choosing the scheme so pre-parsing cannot erase a meaningful port.
- Seen: 2026-10-19.

**Configure guest web permissions independently of renderer sandboxing.**

- Evidence: on 2026-10-18, #174 finds that the isolated Desktop browser session has no permission policy despite sandbox/no-preload flags. Electron 44.4.2 documents default request approval and requires both check and request handlers. SDK-shaped adapter tests exercise denial before first load, main/subframes, devices, shared windows and an untouched default session; they are not native device-access or production-leak proof.
- Check: install explicit checks, request decisions and device policy on the actual guest session before views load. Without consent UI, deny by default; do not reset a shared session when one window closes or change the trusted renderer session. Keep OS, user-gesture and platform verification limits explicit.
- Seen: 2026-10-18.

**Project authoritative configuration consistently when opening and observing a conversation.**

- Evidence: on 2026-10-18, #161 delivers valid Mobile SSE sandbox changes through the real client/parser. The thread snapshot updates, but the model/thinking-only projection retains an old sandbox mode in the priority UI configuration, next draft and cache. Matching the open projection fixes both immediate and coalesced frames; unchanged/missing-mode and no-policy-RPC controls distinguish state synchronization from server permission changes.
- Additional evidence: on 2026-10-18, #168 receives a live Desktop model switch but still renders the open-session model name/window and global selection. Matching provider/model IDs against the correct local/Bot catalog synchronizes metadata; unknown models clear stale capacity, later catalog arrival and real picker selection recover, and matching session-only metadata remains usable.
- Check: cover every configuration field on both ingestion paths, including clearing absent optional fields and downstream inheritance/persistence. A schema accepting the field does not prove the client actually applies it.
- Seen: 2026-10-18.

**An explicit discard must not depend on saving the data being discarded.**

- Evidence: on 2026-10-17, #111's MobileStore forget action fails at a cache-quota error before it can remove independently stored credentials. Skipping that final save lets clear proceed; held-write regressions verify old writes settle before removal even when they reject. Ordinary disconnect still saves drafts, and actual deletion errors remain visible and retryable.
- Additional evidence: on 2026-10-22, #382 holds an accepted clear while real MobileStore/BotClient connect and initialize read old cache/credentials outside the write queue. Successful removal is followed by restored drafts, attachments or pending state. Three controlled regressions require reads to join the same storage order and removal to be queued before notifying reentrant subscribers; prior save/clear rejection controls still pass. This is an adapter interleaving, not native storage or cross-account leakage evidence.
- Check: preserve the distinction between retain and discard. Keep epoch invalidation and serialize reads as well as writes with destructive removal. Test in-flight completion/rejection and exact empty persisted state: matching an empty object as a subset accepts leftover data. Do not swallow a real wipe failure or claim native deletion guarantees from an in-memory fixture.
- Seen: 2026-10-17, 2026-10-22.

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

**Treat external IDs as own data keys on both reads and writes.**

- Promoted on 2026-10-26 to [Verifying](AGENTS.md#verifying).
- Evidence: on 2026-10-21, #361's real Core/Git calls reject toString, constructor and `__proto__` as already-used request IDs because JSON dictionaries inherit Object.prototype. On 2026-10-22, #367 finds the independent scheduler returning a function for an unknown request and rejecting create/propose/approve/manual-run requests for the same keys. Read guards alone are insufficient there: plain assignment to a new `__proto__` key invokes a setter. Real Core close/reopen tests preserve own durable receipts; separate lifecycle controls reject pending requests with these IDs without mistaking inherited names for active lifecycle intentions.
- Additional evidence: on 2026-10-26, #463's real CredentialService controls on `6b73a44` clone inherited provider functions, return a phantom `__proto__` credential and reject direct API-key creation as StorageUnavailable. First-run migration from the real third-party memory store omits its `__proto__` OAuth entry from both export and the actual file. Own-key reads and Object.fromEntries retain those providers through reopen and logout without restoring logged-out entries; fake-token controls do not establish production loss or global prototype pollution.
- Check: test arbitrary IDs through real persistence and replay, distinguish absent entries with own-property checks, and publish data without invoking prototype setters. Check later lifecycle membership tests as well as admission; do not ban valid IDs or claim a prototype-pollution exploit from a false-collision regression.
- Seen: 2026-10-21, 2026-10-22, 2026-10-26.

**Bind asynchronous monitoring and cleanup to an admission, not just its stable thread ID.**

- Evidence: on 2026-10-16, #57 holds a real Core recovery result across stop and resubmit of the same Bot thread. The old successful check releases the replacement's checkout reservation and admits a competing writer; an old failed check marks the replacement blocked. Two native regressions reproduce both outcomes before the fix and verify current completion still releases capacity afterward.
- Additional evidence: on 2026-10-16, #76 preserves real unfinished work, reopens Core, resumes it and explicitly stops it before injecting a late resume failure. The outer recovery queue still re-blocked the idle checkout despite the inner lease guard; another thread received Busy. Reporting superseded ownership before cleanup prevents this, while a current-failure control still reserves the checkout until stop.
- Additional evidence: on 2026-10-17, #113's Mobile persistence gates expose ten stale continuations that restart polling/SSE or issue follow-up requests after dispose. A connection-attempt token spans the pre-epoch cache flush; the original epoch is checked before later nested operations. This prevents stale callers from acquiring a fresh generation without rejecting the latest overlapping connect; ten current-owner controls retain observation and send completion.
- Additional evidence: on 2026-10-22, #385 holds an older ordinary disconnect's cache flush across forget and a later connect. Both different-URL and same-URL/new-token controls finish disconnected because the old continuation acquires a fresh epoch and cancels the replacement. Capturing the disconnect's original attempt before the flush and checking it afterward preserves the new credentials and next real refresh destination/Authorization. This is distinct from #382's storage read/removal ordering; accepted cache writes still settle, and the existing retain/discard/failure controls stay intact. Controlled adapter timing is not native navigation or production incident evidence.
- Additional evidence: on 2026-10-18, #114 adds distinct failure/coalescing cases: the global refresh-busy flag suppresses a committed replacement's request, an old 401 aborts its live stream, and an old queued cache failure marks it failed. Client-scoped occupancy and owner checks reject these effects. The handoff itself invalidates validation-window open/metadata results and aborts old streams; same-URL token rotation and current-failure recovery are covered.
- Additional evidence: on 2026-10-18, #131's real Desktop skill selector switches to project B while the previous A catalog remains clickable, submitting A's enable/disable settings even after B loading fails. Binding the cached catalog to its queried cwd removes those stale actions; same-scope refresh waits and success/error retry controls retain current actions. Cancelling obsolete fetch responses alone did not protect already-rendered controls.
- Additional evidence: on 2026-10-18, #136 holds a Desktop authentication submission or its state read across Escape/close. The stale continuation reopens the cancelled/completed dialog, reports an obsolete error, or clears a new login's busy state. Login ID plus an invalidated submission epoch guards both awaits, errors and finally; API-key/OAuth success/error and completed-before-close refresh controls remain intact. #140 then holds poll/post-answer snapshots inside the same live login: a late old read regresses the prompt/progress or injects an obsolete error. Shared request ordering prevents both directions; current-error, real Select submission and resumed-poll completion controls remain intact.
- Additional evidence: on 2026-10-18, #144 submits a real thread rename/delete, closes it with Escape, then starts another rename. The old successful save clears the parent editor and loses the new draft, including reopening the same thread. Comparing the captured Edit instance preserves the replacement while the original mutation and catalog refresh still complete; current success/error retry and stale-failure controls pass. Unmounting the child does not cancel its callback into a live parent.
- Additional evidence: on 2026-10-18, #171 saves a real scheduled plan, then holds its parent catalog refresh. Escape and reopening a plan leaves the old callback free to close the replacement or navigate back, including the same thread. Capturing a distinct creation intent before refresh and checking it afterward preserves the new draft without cancelling the accepted plan; current/Sidebar completion and foreground-rejection controls retain their behavior.
- Additional evidence: on 2026-10-22, #388 holds Mobile project creation or its final library refresh while the caller starts a new draft (same or different workspace) or opens a thread. Six real Store/BotClient controls lose the newer selection before the fix; two unchanged-owner controls still select the new project. Checking the captured draft intent after the final refresh preserves the active draft/thread while publishing the accepted project records. A stable workspace ID cannot distinguish two drafts; abandoning stale navigation must not cancel an accepted creation. These are controlled HTTP/Store interactions, not native navigation evidence.
- Additional evidence: on 2026-10-18, #148 holds a Desktop library reload failure after a newer read/save/reconnect succeeds, or during a new settings write. Success already checked revision, but the background catch still overwrote the current global error. Binding both outcomes to the read and invalidating prior reads at mutation admission preserves current errors, retries and foreground rejections; gates and a check-phase barrier verify settled fire-and-forget work.
- Additional evidence: on 2026-10-18, #151 holds Desktop library writes/post-write reads across dispose and reconnect. Read revision guards do not prevent old mutation refresh/recovery or release busy for the new lifetime. A separate lifetime guard spans both awaits, catch and finally; disposal releases the old slot and reconnect admits a fresh write. Public-client controls preserve current failures and caller rejection, without claiming to abort accepted server writes or reproduce a production App remount.
- Additional evidence: on 2026-10-18, #184 removes or unmounts an image attachment while file reading or preparation waits. The old read still starts preparation, cancelled failures raise a Toast, and removed queued files block retained siblings. Fresh per-selection IDs guard both awaits and errors; picker/paste/drop and real send controls preserve current work. This does not abort accepted native processing or prove a removed image was sent to a model.
- Additional evidence: on 2026-10-18, #180 holds Mobile autosave/background cache failures across forget or dispose. The storage queue correctly clears credentials/cache, but unguarded caller catches restore an obsolete error or mutate the disposed snapshot. Capturing the connection epoch in both background persistence paths suppresses only stale errors; current errors, retained-draft disconnect and genuine clear rejection stay observable.
- Additional evidence: on 2026-10-18, #154 holds browser hide/capture previews across a newer capture of the same page. The record identity still matches, so the old frame overwrites a newer one or the retained fallback after a new failure. Per-record capture identity protects both entry points without invalidating other pages; current/closed-page and fallback controls pass. FakePage gates verify the async contract, not native GPU arrival frequency or production screenshot leakage.
- Additional evidence: on 2026-10-18, #164 completes an address failure then restores a valid URL through simulated native history events. The Manager still overlays its old error; pending address failures also survive explicit back/forward/reload because only URL loads advance revision. Sharing navigation admission clears old errors and invalidates prior loads, while unavailable-history and new-native-failure controls keep current failures visible. Native guest-initiated navigation and OS behavior remain unverified.
- Additional evidence: on 2026-10-21, #364's real Core/Git queries use controlled GitHub adapter gates to replace authentication after the early guard but during final repository validation. The old successful reply remains ready; a separate old network rejection still carries previously captured cached rows after the shared cache was cleared. Rechecking identity after the final await and suppressing cached data in obsolete failures rejects both replies while the replacement's next query retains its own rows. This is a controlled service contract test, not evidence of a production cross-account disclosure.
- Additional evidence: on 2026-10-22, #422 delays the final execution-claim read after obtaining actual Git metadata. A real worktree removal completes while no execution lease is visible, and the old ready reply then admits and completes a model call in the removed cwd. Publishing the execution lease before that await makes admission/removal mutually exclusive; an injected read rejection verifies same-ID retry and eventual removal without a stuck lease. Other-workspace and dirty-removal controls retain valid execution. This is a controlled Core/Git/filesystem schedule, not a production or native UI incident.
- Check: carry a per-claim identity across awaits, validate it before releasing or changing state, and dispose late subscription setup instead of overwriting a new monitor. Apply this to outer recovery/error queues too, before cleanup erases ownership evidence. Revalidate the original connection/view after persistence as well as network responses, before nested operations capture new ownership. Exercise stop/resubmit while previous work is pending; unsubscribing alone cannot retract an already running callback.
- Additional evidence: on 2026-10-23, the computer tool's real Core/Code mode fixture received a screenshot but rejected its next-round click as stale when ownership used `LiveDoc.run.taskId`: that ID changes during generation handoffs. Binding to the first admitted submission in `run.inputs`, plus a distinct owner instance, preserves the screenshot across model rounds and rejects reuse by a later submission. `test/service/runtime/codemode.test.ts` exercises both outcomes with a controlled adapter; this does not establish real model targeting accuracy.
- Additional evidence: on 2026-10-25, #430's real Core/Git fixtures on `319d644` hold run-grant expiry after a root finishes: separate user/automatic runs commit without a new decision, and releasing old expiry revokes a replacement's fresh grant. Bind requests/grants to the first root `LiveDoc.run.inputs` submission, recheck it in the authorization transaction, and retain current-owner grants during idle cleanup. Seven focused cases cover both expiry orders, legacy grants, root-idle/active children and a real Core reopen; these are controlled schedules, not a production exploit-frequency claim.
- Additional evidence: on 2026-10-25, #454 holds an old GitHub session discovery while a later query publishes another identity and its cache. On `2c4a063`, the old discovery resets the identity, returns ready and evicts the newer cache (three network calls instead of one). Carry query admission across discovery and preserve the highest published order even for an accepted same-key completion. Four public Core controls cover stale discovery, same-key cache reuse, identity switching back and an invalid newer preflight; they do not measure real credential rotation or production disclosure.
- Additional evidence: on 2026-10-25, #459 holds a borrowed subagent writer before actual Core admission, or returns an older idle read after the child is admitted. Both native controls on `6b73a44` release the same checkout lease and admit another thread while both Core runtimes are pending; a controlled old inspection failure instead pollutes blocked state. Pending admissions must retain the lease against monitor release and invalidate earlier observations even when they settle during a read. Controls retain overlapping-writer rejection, current inspection protection, and eventual capacity release; no filesystem conflict or production incident is asserted. After #468 replaces subscriptions with polling-only monitoring, `a246b15` still fails all four borrowed-admission controls. The updated fix keeps recovery/failedTurn polling without history projection; fixtures await actual read settlement and its check-phase continuation. This recheck of the same incident does not add a Seen date.
- Additional evidence: on 2026-10-25, #457's real BotStore/SQLite controls admit a callback after close snapshots in-flight work; the database closes before that callback saves its receipt, producing `ERR_INVALID_STATE`. Parallel closes fail the second native close, and a Hono body held across application close resumes with 500. Close store admission before awaiting the drain and coalesce the terminal close Promise. Controls retain pre-close coalescing and a durable receipt after reopening; this does not establish a complete application shutdown barrier or production data loss.
- Additional evidence: on 2026-10-27, #483 holds actual Hono request bodies across Bot.close. Unknown-length bodies wait inside bodyLimit before routes; declared-length bodies wait in route JSON parsing. All six valid metadata/subagent/schedule cases enter disposed backends and reject with ManagedRuntime disposed on `6d1e250`; malformed input adds distinct parser/error behavior. Recheck application lifetime after both buffering and JSON success/failure, not just at HTTP entry. Eight controls return RuntimeClosing with no late backend entry while active malformed JSON remains InvalidInput. This is HTTP-app evidence, not TCP/OS-signal shutdown or production data loss.
- Additional evidence: #489 on `5dbbd1a` holds an actual Discord/Core recovery result after a real issue completes and is stopped. A newer close commits, but the old resume then restores waiting and accepts a followup into real work. Per-issue in-flight owner tokens reject that stale commit and keep a newer stop and close→stop state round trip intact; a peer-issue control still permits valid resume and followup completion. Clear only the owner that actually settles. This is controlled Bot/SQLite/Gateway-port scheduling, not observed production reactivation or a general ordering guarantee for remote archive calls.
- Additional evidence: #492 on `8f1a044` holds a Discord stop/close return only after actual Controller/Core stop completes. A newer reopen admits a real replacement operation, but the old cleanup then labels its inbox cancelled while Core is still running; after a declared delivery rejection, manual retry is incorrectly denied as cancelled. Rechecking the existing control owner before the cancellation loop preserves admitted work and lets the actual retry finish. This distinct post-stop phase does not establish ordering when Core.stop itself has not completed or remote archive linearization.
- Seen: 2026-10-16, 2026-10-17, 2026-10-18, 2026-10-21, 2026-10-22, 2026-10-23, 2026-10-25, 2026-10-27.
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
- Additional evidence: on 2026-10-24, Desktop package verification only checked that the native helper was executable. An isolated executable reporting `backgroundInput:false` passed the previous verifier (exit 0); actually running its self-test now rejects it (exit 1). The real ad-hoc Apple Silicon app passed deep signature verification, both helper slices and isolated actual-ASAR runtime/Code mode loading. This does not prove fresh macOS permission grants, GUI startup or Developer ID notarization.
- Additional evidence: on 2026-10-24, hiding the new computer-use package's local dist left Bot's build successful but emitted an unresolved external import from Core's computer extension. Include that transitive workspace package in Bot's source aliases and bundling policy even though Bot does not inject a desktop capability. The same cold build then resolves it, and the isolated Bot runtime verifier exercises the packaged entry.
- CI follow-up: #432's Linux Core crash/lifecycle workers import that package through Node, outside Vite's source conditions, and failed with missing `dist/protocol.mjs`. Build and verify the workspace dependency before Core tests in both Desktop and Bot workflows; Vite aliases cannot repair a separate Node process's package exports.
- Check: trace the actual worker/runtime entry and workspace subpath exports.
  Run the affected package verification in a clean build context when changing
  packaging; report separately whether an installed client was exercised.
- Seen: 2026-10-12, 2026-10-15, 2026-10-16, 2026-10-24.

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
- Additional evidence: on 2026-10-22, #377's Linux CI run `39729783493` expires the projectless client test at 5,231 ms. That test combines native execution, a 10-second completion poll, restart and deletion under the default five-second test budget. Separate lifecycle persistence from a controlled-response native-write test, give startup and completion bounded waits, and release the response in `finally`. The CI log does not identify which phase exhausted the original budget.
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
- Additional evidence: on 2026-10-19, PR #212's schedule reconnect fixture asserted publication immediately after the two-second backoff. Holding the replacement HTTP response reproduces that assertion with the second stream already connected, even while the original reader's cancellation cleanup never settles. Releasing the response and boundedly awaiting the listener covers the response/cache-write completion separately; keeping periodic polling real prevents it from faking SSE recovery. This demonstrates a fixture completion assumption, not a transport teardown defect or a native CI timing trace.
- Seen: 2026-10-12, 2026-10-14, 2026-10-15, 2026-10-19.
