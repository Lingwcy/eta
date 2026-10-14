# Working with Eta

English · [简体中文](desktop.zh-CN.md)

For installation and your first task, see the [README](../../README.md).

## Chats and local data

Keep reference pages alongside your chats: open a web tab with **Cmd/Ctrl+T**, then enter a URL or search in its address bar.

**New chat (新聊天)** returns to an existing unsent chat, keeping its draft and project selection. After submitting it, you can start another chat. Switching tabs preserves each chat's draft; closing a chat tab keeps its history and lets an admitted task continue. Use **Cmd/Ctrl+W** to close a tab and **Cmd/Ctrl+Shift+T** to reopen it.

Use the sidebar bell to find recently opened chats across projects. The list follows your visit order, saves it on this computer, and keeps background task updates from changing that order. Click the bell again to return to projects.

Right-click a saved chat to rename it, change its project grouping, archive or restore it, open it in another Eta window, or permanently delete its local history. Changing project grouping does not change the directory where the agent executes work. **Open with (打开方式)** opens the main JSONL transcript in the default or a selected application; use a text editor to inspect it.

Use **Settings → Application → Storage (设置 → 应用 → 存储)** to check local session usage and locate session folders for inspection or backup.

Back up the entire session directory, not just the main JSONL transcript. Subagents share that transcript, and task recovery also needs the adjacent state files. Reopening unfinished work requires an explicit resume or stop.

## Start in a separate worktree

Before sending the first message in a new chat, open the workspace configuration beside the project and enable “新 worktree”. Use its branch menu to select an existing branch or enter a new branch name. Eta creates the directory when you send; uncommitted changes in the current checkout stay there. If creation or sending fails, the draft is preserved and retries reuse the created workspace. Checked-out branches and remote-tracking branches become the base of a new local branch. Workspace configuration hides after the chat starts.

See the [sandbox guide](./sandbox.md#在-worktree-中提交) for Git approvals and run-scoped grants. Closing a tab or archiving a chat keeps its worktree.

Desktop stores new worktrees in a separate directory beside its protected data directory. Existing chats keep their execution directories.

## Browse GitHub PRs and issues

The right sidebar opens by default when it has available content. Select its GitHub tab, then choose PR or Issues in the header to browse open entries. The options menu retains repository selection, state filters, refresh and access status. The GitHub tab appears when the project has a GitHub remote and its host supports GitHub queries; the subagent tab appears when the current chat has subagents. Entries open in your external browser. Repository context follows the chat’s actual execution workspace. **Alt+←** collapses or restores the current sidebar, including from web and settings tabs.

Public repositories support anonymous access. For private repositories or higher rate limits, run gh auth login locally, or on the server for Bot projects, then refresh the GitHub sidebar. This identity is separate from the model’s GitHub Copilot login. Disconnected Bot caches are marked stale; refresh and writes remain unavailable.

## Skills

Skills give an agent reusable instructions. Put each skill in a folder containing `SKILL.md`:

| Scope    | Directory                            |
| -------- | ------------------------------------ |
| Personal | `~/.agents/skills/`                  |
| Project  | `.agents/skills/` inside the project |

Project skills take precedence when names collide. Use **Settings → Skills (设置 → 技能)** to add custom directories, inspect discovery errors, enable or disable skills, and open their folders. Opening a missing skill directory creates it.

Choose a skill from the composer, use **Cmd/Ctrl+Shift+K**, or name it in your request:

```text
$better-readme Refactor this project's README.
```

This example requires an installed skill named `better-readme`; it is not bundled with Eta.

Eta offers the agent skill names and descriptions first. The agent loads full instructions when relevant and reads supporting files only as needed. Activated instructions stay with the conversation across restarts and context compaction. To load an updated version, remove the loaded skill in the composer first, then select it again. Skills use the tools and dependencies already available in your environment; they do not grant extra permissions.

## Subagents

Subagents let the main agent delegate work to child conversations. Once work is delegated, open the right sidebar with **Alt+←**, then select a task to read its conversation and reported progress. Send a message while it is working to adjust its direction or ask for a summary; messaging a settled or paused task continues the same conversation.

Independent children receive their assigned task and project instructions. Forked children inherit the conversation history at creation.

Use **Settings → Subagents (设置 → 子智能体)** to create presets with instructions, thinking levels, and candidate models. Workers complete their assignments directly by default; enable further delegation for presets that coordinate other agents. The model scope follows the current main model by default; enable other models in the model picker. Nesting depth and concurrency are global settings; the concurrency limit applies separately to each session's agent tree, with extra children queued.

| Mode          | How work is delegated                                                                        |
| ------------- | -------------------------------------------------------------------------------------------- |
| Opportunistic | The main agent delegates when useful.                                                        |
| Orchestrator  | Children execute tools; the main conversation handles discussion, coordination, and results. |

In orchestrator mode, the main conversation remains available between coordinating turns while children keep working. Completion events bring it back to summarize results.

A wait timeout does not stop a child. Stopping cancels work without producing a final answer, but preserves reported progress and history. Stopping the main task stops its entire child tree. To continue unfinished work, explicitly resume it or send a new task after stopping it.

## Scheduled tasks

Open **Scheduled tasks** in the sidebar and create a task with a workspace, prompt and time rule, or choose **Add scheduled task** from an existing chat’s context menu. Plans stay in that chat. Manage them from the task’s sidebar menu: edit, pause, resume, run once or delete. Rules support one-time, intervals of at least five minutes, daily and weekly schedules using your computer’s time zone.

Agents create and manage plans immediately. The tool message shows the result and lets you cancel a plan; all plans remain manageable in the sidebar. Choose the model and permissions in Advanced when creating a task; new task chats default to Full access, and you can select the workspace sandbox instead. Existing chats keep their current permissions unless you change them. Tasks use that chat’s model, workspace and approvals and may change files and consume model usage.

Busy chats finish their current work first. Missed recurring slots coalesce into the latest one within a 24-hour window; failed runs do not retry automatically. Archiving pauses plans, and restoring a chat does not resume them. Closing a chat tab keeps schedules active. Pausing or deleting a plan stops future triggers; stop already-started work in the chat. Pending management requests retain the effective state until their result is confirmed.

Local tasks require Eta to be running and the computer awake. macOS keeps running after windows close. Windows exits by default; enable **Keep running after closing windows** in **Settings → App → About → Background** to keep a visible tray with Open and Quit actions. Explicitly quitting stops local scheduling.

Bot schedules stay on the server and continue while Desktop is disconnected or closed. Offline views show stale cached data and disable changes. Older Bots report this feature as unsupported; tasks never move to this computer. Missing workspaces and recovery requirements block execution until resolved.
