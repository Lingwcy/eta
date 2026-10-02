# Eta

Eta is a desktop application. Electron's main process owns agent execution, credentials and in-memory sessions; the React renderer reaches it through a narrow preload bridge.

Start the desktop application with renderer hot reload:

```sh
vp run dev:desktop
```

Build and launch the desktop client from compiled files:

```sh
vp run build:desktop
vp run start:desktop
```

The app reads model defaults from `~/.pi/agent/settings.json` and credentials from `~/.pi/agent/auth.json`. Provider environment variables can be configured in the repository's `.env` or `apps/desktop/.env`. Model defaults apply to new sessions.

Sessions and refreshed OAuth credentials currently live in memory. A new session starts empty, and restarting Eta discards its sessions. Desktop builds currently run from the workspace; installer packaging is not configured.

Agent source lives in `packages/agent` and tracks upstream Pi durable through Git subtree. See [upstream synchronization](scripts/agent-upstream.md) for updates and conflict recovery.
