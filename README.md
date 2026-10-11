<p align="center">
  <img src="apps/desktop/renderer/public/eta-icon.png" width="96" height="96" alt="Eta logo" />
</p>
<h1 align="center">Eta</h1>
<p align="center">A general-purpose agent for your desktop.</p>
<p align="center">English · <a href="README.zh-CN.md">简体中文</a></p>

Eta turns natural-language instructions into work on your files: explore a codebase, edit documents, or organize a workspace. Connect an AI account or bring your own API key, choose a project folder, and continue the work in saved conversations.

![Eta desktop interface showing a conversation, a completed tool call, and the model picker](docs/assets/image.png)

## Install

Download an installer from [GitHub Releases](https://github.com/Lingwcy/eta/releases).

| Platform              | Installer                     |
| --------------------- | ----------------------------- |
| macOS — Apple Silicon | `Eta-<version>-mac-arm64.dmg` |
| macOS — Intel         | `Eta-<version>-mac-x64.dmg`   |
| Windows — x64         | `Eta-<version>-win-x64.exe`   |

Windows command execution requires [Git for Windows](https://gitforwindows.org/) with Git Bash. To run from source or build an installer, see [Contributing](CONTRIBUTING.md).

## Work with Eta

| Task                                                       | Guide                                                                         |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Continue saved chats, manage projects, or back up sessions | [Chats and local data](docs/user/desktop.md#chats-and-local-data)             |
| Give the agent reusable instructions with `$skill-name`    | [Skills](docs/user/desktop.md#skills)                                         |
| Delegate work and follow child conversations               | [Subagents](docs/user/desktop.md#subagents)                                   |
| Control file, command, and network access                  | [Sandbox policies (中文)](docs/user/sandbox.md)                               |
| Run tasks on a remote Eta Bot                              | [Connect a Bot (中文)](docs/user/bot.md) · [Deploy a Bot](apps/bot/README.md) |

## Before you start

- The agent can modify files and run commands. New chats default to a workspace sandbox; use read-only mode when you only want inspection. On Windows, restricted modes block local tasks; running them requires full access. Read the [sandbox policies (中文)](docs/user/sandbox.md) before choosing it.
- Use **Settings → Tools (设置 → 工具函数)** to enable or disable built-in tools and **Settings → Permissions (设置 → 权限)** to control image reading. External tools are not available yet.
- Installers may trigger operating-system warnings: macOS releases use ad-hoc signing unless Developer ID signing and notarization are enabled; Windows installers are currently unsigned.
- Local and Bot files and conversation histories do not automatically synchronize.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, focused checks, and installer builds. Maintainers publish releases using the [release guide](docs/release.md).

## License

[MIT](LICENSE). Dependencies and bundled assets retain their own licenses.
