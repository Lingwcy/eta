<p align="center">
  <img src="apps/desktop/renderer/public/eta-icon.png" width="96" height="96" alt="Eta logo" />
</p>
<h1 align="center">Eta</h1>
<p align="center">A general-purpose agent for your desktop.</p>
<p align="center">English · <a href="README.zh-CN.md">简体中文</a></p>

Eta is a desktop agent for working with files, understanding images, and turning natural-language instructions into actions. Our goal is to make one agent useful across everyday tasks, from exploring a codebase to organizing a workspace.

## What you can do

- **Choose your model.** Connect an AI account or bring your own API key.
- **Give it context.** Work in a local project and attach images for vision-capable models.
- **Let it act.** Read, write, and edit files or run commands. Enable only the tools you want.
- **Keep your work.** Return to saved conversations and continue where you left off.

## Get started

1. Connect a model in Settings.
2. Start a new chat and select a project folder.
3. Describe your task. Attach pictures through `@image-path`, or paste and drag them in.

Use **Settings → Permissions** to control image reading and **Settings → Tools** to enable or disable built-in tools. External tools are not available yet.

Keep chats, settings, and web pages open in the top tab bar. The **+** opens a web tab; enter an address or search in its address bar. **New chat** returns to an existing unsent chat, preserving its draft and project selection. After submitting it, you can start another chat. Closing a chat tab keeps its saved history and lets an admitted task continue. Use **Cmd/Ctrl+W** to close a tab and **Cmd/Ctrl+Shift+T** to reopen it. Switching tabs preserves each chat's draft and project selection.

Use **Settings → Application → Storage** to check session usage and search or sort local sessions. Click a session to locate its folder in your file manager. The page also provides paths to the sessions directory, model settings, and Catalog.

Right-click a saved chat to rename it, change its project grouping, archive or restore it, open it in another Eta window, or permanently delete its local history. Project grouping does not change the execution directory. **Open with** opens the main JSONL transcript in the default or a selected application; use a text editor to inspect it.

## Skills

Place skill folders containing `SKILL.md` in `~/.agents/skills/` for personal use or `.agents/skills/` in a project. Use **Settings → Skills** to view and open skill directories, add custom directories, inspect discovery errors, and enable or disable skills. Opening a missing skill directory creates it. Project skills take precedence when names collide.

Eta first offers the agent skill names and descriptions. The agent loads instructions when relevant and reads supporting files only as needed. Choose a skill from the composer, use **Cmd/Ctrl+Shift+K**, or include `$skill-name` in your request to select it explicitly. The conversation retains activated instructions across restarts and context compaction. Remove a loaded skill in the composer before loading an updated version. Skills use the tools and dependencies already available in your environment.

## Run locally

Install [Vite+](https://viteplus.dev/guide/), then run:

```sh
vp install
vp run dev
```

To build a macOS installer:

```sh
vp run package:mac
```

The `.dmg` is saved to `apps/desktop/dist/release/`.
