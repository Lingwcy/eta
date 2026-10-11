# Working with Eta

English · [简体中文](desktop.zh-CN.md)

For installation and your first task, see the [README](../../README.md).

## Chats and local data

Keep reference pages alongside your chats: open a web tab with **Cmd/Ctrl+T**, then enter a URL or search in its address bar.

**New chat (新聊天)** returns to an existing unsent chat, keeping its draft and project selection. After submitting it, you can start another chat. Switching tabs preserves each chat's draft; closing a chat tab keeps its history and lets an admitted task continue. Use **Cmd/Ctrl+W** to close a tab and **Cmd/Ctrl+Shift+T** to reopen it.

Right-click a saved chat to rename it, change its project grouping, archive or restore it, open it in another Eta window, or permanently delete its local history. Changing project grouping does not change the directory where the agent executes work. **Open with (打开方式)** opens the main JSONL transcript in the default or a selected application; use a text editor to inspect it.

Use **Settings → Application → Storage (设置 → 应用 → 存储)** to check local session usage and locate session folders for inspection or backup.

Back up the entire session directory, not just the main JSONL transcript. Subagents share that transcript, and task recovery also needs the adjacent state files. Reopening unfinished work requires an explicit resume or stop.

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
