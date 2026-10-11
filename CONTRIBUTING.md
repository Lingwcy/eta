# Contributing to Eta

For using the app, start with the [README](README.md). This guide covers working on Eta itself.

## Run locally

Install [Vite+](https://viteplus.dev/guide/) and use Node.js 24, as CI does. Vite+ manages the runtime and package manager. On macOS, install the Xcode Command Line Tools for the native sandbox helper; Linux builds require a C compiler.

From a checkout of this repository:

```sh
vp install
vp run dev
```

Use `vp run dev`, not `vp dev`: the repository script builds the Electron main process before starting the desktop development environment.

## Verify a change

Run the smallest checks that cover your change. For example:

```sh
vp test run scripts/desktop-release.test.ts
```

Desktop tests use their package's configuration:

```sh
cd apps/desktop
vp test run renderer/src/agent/desktop-tabs.test.ts
```

Run the relevant package's `typecheck` script when changing TypeScript. CI owns the full suite; avoid repository-wide checks for a scoped change. See [AGENTS.md](AGENTS.md) for repository conventions.

## Build installers

On macOS:

```sh
vp run package:mac
```

On Windows, for an x64 installer:

```sh
vp run package:win
```

Both commands save installers to `apps/desktop/dist/release/`: `.dmg` on macOS and `.exe` on Windows. The macOS command targets the host architecture by default. Windows command execution requires [Git for Windows](https://gitforwindows.org/) with Git Bash installed.

For Bot deployment, see the [Bot guide](apps/bot/README.md). For versioning, tags, signing, and publishing, use the [release guide](docs/release.md).
