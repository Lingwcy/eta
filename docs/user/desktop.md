# Working with Eta

English · [简体中文](desktop.zh-CN.md)

For installation and your first task, see the [README](../../README.md).

## Interface language

Use **Settings → Application → Appearance → 语言 / Language** to choose **简体中文** or **English**. Changes apply immediately to all Eta windows and persist after restarting. This changes the interface language; existing chat content and the agent's response language are unaffected.

## Chats and local data

Keep reference pages alongside your chats: open a web tab with **Cmd/Ctrl+T**, then enter a URL or search in its address bar.

**New chat (新聊天)** inherits the current chat's workspace and reuses an unsent chat for that workspace when available, preserving its draft. From web or settings tabs, it uses the most recent chat context. Switching tabs preserves each chat's draft; closing a chat tab keeps its history and lets an admitted task continue. Use **Cmd/Ctrl+W** to close a tab and **Cmd/Ctrl+Shift+T** to reopen it.

You can send a message while **Choose a project** is shown. Eta creates a separate temporary workspace for that chat and keeps its files across restarts until the chat is permanently deleted. Before the first message, hover over the project name to change it, or use its clear action or **Work without a project** in the project menu. Clearing the project preserves your draft and attachments. New chats from a chat without a project also start without one.

Use the sidebar bell to find chats across projects by their latest successfully sent input. The order is saved on this computer; opening chats and background task updates leave it unchanged. Click the bell again to return to projects.

Right-click a saved chat to rename it, change its project grouping, archive or restore it, open it in another Eta window, or permanently delete its local history. Deleting first stops the chat and its child tasks, then removes the history. Changing project grouping does not change the directory where the agent executes work. **Open with (打开方式)** opens the main JSONL transcript in the default or a selected application; use a text editor to inspect it.

Use **Settings → Application → Storage (设置 → 应用 → 存储)** to check local session usage and locate session folders for inspection or backup.

Back up the entire session directory, not just the main JSONL transcript. Subagents share that transcript, and task recovery also needs the adjacent state files. Reopening unfinished work requires an explicit resume or stop.

## Add instructions while Eta is working

Keep typing while a reply or tool is running. The existing stop action becomes send again when you enter a new message. **Enter** or send adds a steering message at the next safe boundary, after the current request and tool round finish. **Cmd+Enter** sends a follow-up that waits until the current work and all steering messages finish. **Shift+Enter** still inserts a newline. Neither mode cancels an active request, tool, or approval wait; steering messages take priority even over earlier follow-ups.

Your message appears in the conversation immediately using the existing message style, and becomes the same saved message when it takes effect. Stopping cancels current work and pending messages; unexecuted messages are not silently sent again.

A chat can hold up to 32 pending messages, subject to an attachment-size limit. If the queue is full, wait; rejected sends keep your draft. Remote chats require a Bot that supports input queues; older Bots keep the previous running-time restriction. Context compaction and interrupted work still require waiting or explicit recovery.

## Start in a separate worktree

Before sending the first message in a new chat, open the workspace configuration beside the project and enable **New worktree**. Use its branch menu to select an existing branch or enter a new branch name. Eta creates the directory when you send; uncommitted changes in the current checkout stay there. If creation or sending fails, the draft is preserved and retries reuse the created workspace. Checked-out branches and remote-tracking branches become the base of a new local branch. Workspace configuration hides after the chat starts.

See the [sandbox guide](./sandbox.md#在-worktree-中提交) for Git approvals and run-scoped grants. Closing a tab or archiving a chat keeps its worktree.

Desktop stores new worktrees in a separate directory beside its protected data directory. Existing chats keep their execution directories.

## Review code changes

**Code diff** appears in the right sidebar when the current chat’s execution workspace has Git changes. The file list compares HEAD with the working tree and includes untracked files. Ignored files are excluded. A file can have staged and unstaged changes even when its overall difference is empty. This viewer is read-only.

Choose **View modification** beside a recorded file operation in chat to see that operation’s saved difference, then select a file in the tree to inspect its current state. Saved differences do not change when the file is edited again, committed or deleted. Recording covers Eta’s edit and write tools, including Code mode and subagents. Shell commands and external editors affect the workspace view but do not have an individually attributed history. Older operations may not have a saved difference; unavailable, binary and oversized content is identified rather than reconstructed from today’s files. A non-Git workspace can still show recorded modifications.

Drag the divider at the left edge of the right sidebar to adjust its width; the divider also supports arrow keys. Each sidebar feature remembers its own width across restarts, while keeping space for the main area. The changed-file tree has its own divider and width; resizing the sidebar changes the code area, not the tree.

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

Choose the tool calling mode in **Settings → App → Permissions → Agent mode**. Code mode is the default: the agent combines enabled tools in JavaScript. Standard mode lets the model call tools directly. Both share tool permissions, approvals and the system sandbox. Changes apply to the next new task in any chat; running and recoverable tasks keep their original mode, including their subagents. If Code mode cannot run, switch to Standard mode and start a new task.

## Experimental desktop control

On macOS 14 or later, enable desktop control in **Settings → Permissions → Computer use** to let the main agent read app controls and operate apps in local chats, without restarting Eta. Enabling it also allows image access. For first use, follow the permission links to allow screen recording and accessibility in macOS System Settings, then select a model that accepts images. macOS may require restarting Eta to apply system permissions. Ask the main agent to operate the desktop; both Standard mode and Code mode are supported. The agent reads the selected app’s available controls first and uses screenshots when visual context is needed. No separate target-location model is required. Screenshots show the selected window, including when another app covers it. Input is directed to that window without moving the system cursor; a purple cursor in screenshots marks the agent’s position. A draggable preview appears during computer use and updates with observations and action results; click its × to stop desktop control for this task. A purple pointer and brief click feedback also appear where the target is visible, without moving your system cursor. Stopping the task or revoking permission removes the preview and screen indicators. When the target is on another Space, screenshots may omit menus and child windows; the agent receives a scope notice and uses their accessibility controls. Keep macOS logged in and unlocked while using desktop control. Background input support varies by app, so check the result of important actions. Apps that expose few controls may need more screenshot-based interaction. Stop the task to cancel desktop operations and release its held keys and mouse buttons.

You can also ask the agent to operate menu-bar apps. It selects the app’s status icon and opens its menu or panel, which may appear on your current desktop. Viewing or interacting with the app does not permanently stop the task; the agent observes the changed interface before continuing.

If you are using another window of the same app in the foreground, Eta stops input to avoid redirecting your keyboard focus. Desktop actions can affect other applications and are outside the workspace file sandbox. Only the main agent of a local Desktop thread can control the computer, including in orchestrator mode; other threads receive a busy result while it holds control.

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

Agents create and manage plans immediately. The tool message shows the result and lets you cancel a plan; all plans remain manageable in the sidebar. Choose the model and permissions in Advanced when creating a task; new task chats default to Full access, and you can select the workspace sandbox instead. Existing chats keep their current permissions unless you change them. When editing a plan, you can save its model and thinking level while tasks are running. The new configuration applies to subsequent model requests; requests already sent keep their original configuration. Tasks use that chat’s model, workspace and approvals and may change files and consume model usage.

Busy chats finish their current work first. Missed recurring slots coalesce into the latest one within a 24-hour window; failed runs do not retry automatically. Archiving pauses plans, and restoring a chat does not resume them. Closing a chat tab keeps schedules active. Pausing a plan stops future triggers. Deleting a plan yourself first stops its chat and child tasks, then removes the plan. Pending management requests retain the effective state until their result is confirmed.

**Run now** queues a run and opens its chat, where its status and any waiting reason appear above the input. If that chat is interrupted, it ends the unfinished turn and starts a new run with the current plan, preserving history and scheduled times. An interrupted chat can block other tasks in the same project: open that chat and resume or stop its unfinished task to free the project.

Local tasks require Eta to be running and the computer awake. macOS keeps running after windows close. Windows exits by default; enable **Keep running after closing windows** in **Settings → App → About → Background** to keep a visible tray with Open and Quit actions. Explicitly quitting stops local scheduling.

Bot schedules stay on the server and continue while Desktop is disconnected or closed. Offline views show stale cached data and disable changes. Older Bots report this feature as unsupported; tasks never move to this computer. Missing workspaces and recovery requirements block execution until resolved.
