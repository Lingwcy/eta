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
