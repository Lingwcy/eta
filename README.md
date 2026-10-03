# Eta

Eta is a desktop application. Electron's main process owns agent execution, credentials and in-memory sessions; the React renderer reaches it through a narrow preload bridge.

Start the desktop application with renderer hot reload:

```sh
vp run dev
```

Build and launch the desktop client from compiled files:

```sh
vp run build:desktop
node apps/desktop/scripts/start.mjs
```

The app reads model defaults from `~/.pi/agent/settings.json` and credentials from `~/.pi/agent/auth.json`. Provider environment variables can be configured in the repository's `.env` or `apps/desktop/.env`. Model defaults apply to new sessions.

Projects, threads, settings and refreshed OAuth credentials are saved in Electron's application data directory. Packaged builds do not load the repository's `.env` files.

Build a macOS installer on a Mac:

```sh
vp install
vp run package:mac
```

The DMG is written to `apps/desktop/dist/release/`. Open it and drag Eta into Applications. The default build uses an ad-hoc signature for local testing; macOS may require approval under System Settings → Privacy & Security when installing a downloaded copy. Build a specific architecture with `vp run package:mac --arm64` or `vp run package:mac --x64`. The manual **macOS installer** GitHub Actions workflow builds both architectures and uploads DMGs as workflow artifacts. Enable its `signed` option after configuring the Apple secrets below to build signed, notarized installers.

For public distribution, set `ETA_SIGNED_RELEASE=1` and provide a Developer ID Application certificate via `CSC_LINK` and `CSC_KEY_PASSWORD`, plus notarization credentials via `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. Then run the same packaging command. Signed release builds require a valid signing identity and Apple notarization; they fail instead of silently producing an unsigned release. Keep these credentials in the environment or CI secrets, never in the repository.

Agent source lives in `packages/agent` and tracks upstream Pi durable through Git subtree. See [upstream synchronization](scripts/agent-upstream.md) for updates and conflict recovery.
