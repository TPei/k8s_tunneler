# k8s tunneler

A macOS menu bar app for managing `kubectl port-forward` connections across
multiple clusters and namespaces. Store your port-forwards once, then start,
stop, and open them in the browser from a small window attached to the menu bar
icon.

<p align="center">
  <img src="docs/screenshots/overview.png" alt="k8s tunneler overview window" width="380" />
</p>

## Why

If you routinely run `kubectl port-forward` against several clusters and
namespaces, you end up juggling long commands and orphaned terminal tabs. k8s
tunneler keeps each forward as a named connection with a play/stop toggle and a
live status indicator, so you can see and control everything from one place.

## Features

- Lives in the menu bar - click the icon to open an attached mini window.
- Store connections with a name and a full `kubectl port-forward` command
  (including the cluster/context and, optionally, the namespace).
- Per-connection status dot (stopped / starting / running / error) and a
  play/stop button to toggle the forward.
- Open-in-browser button that launches the locally forwarded port (the local
  port is detected automatically from the command).
- Add, edit, and delete connections; they persist across restarts.
- The menu bar icon gains a green dot whenever a forward is active.

## Screenshots

### Managing connections

Each row shows the connection name, its status, and quick actions (start/stop,
open in browser, edit). A running forward shows its local address.

<img src="docs/screenshots/overview.png" alt="Connection list" width="380" />

### Adding a connection

Give the connection a name and paste the `kubectl port-forward` command. The
local port is parsed from the command for the open-in-browser action.

<img src="docs/screenshots/new-connection.png" alt="New connection form" width="380" />

## Requirements

- macOS (Apple Silicon or Intel).
- A working `kubectl` on your `PATH` (or at `~/google-cloud-sdk/bin/kubectl`).
  The app resolves `kubectl` and augments `PATH` with common locations
  (Homebrew, `~/google-cloud-sdk/bin`) so cluster auth plugins such as
  `gke-gcloud-auth-plugin` work when launched as a GUI app.
- Node.js and npm (for running from source / building).

## Getting started

```bash
npm install
npm start
```

The app runs as a pure menu bar app (no Dock icon). Click the menu bar icon to
open the window; right-click the icon for a Quit option.

### Adding a connection

1. Click the `+` button.
2. Enter a name and a `kubectl port-forward ...` command, for example:

   ```
   kubectl port-forward -n my-namespace svc/my-app 8080:80
   ```

3. Save, then press play to start the forward. Once it is running, the browser
   button opens `http://localhost:8080`.

## Build a distributable app

```bash
npm run dist
```

This produces an installable `.dmg` in `dist/`. The build is unsigned, so on
first launch you may need to right-click the app and choose **Open** to get past
Gatekeeper.

## How it works

- **Electron main process** owns the connection store and child processes. It
  spawns the system `kubectl` for each active forward and tracks its status by
  watching for the `Forwarding from 127.0.0.1:PORT` line on stdout.
- **Renderer** is a small UI that talks to the main process only through a
  `contextBridge` preload API (context isolation on, node integration off).
- **Storage** uses `electron-store`, persisting connections as JSON in the app's
  data directory.

## Project layout

```
src/
  main.js              Electron main process: tray, window, IPC, tray indicator
  connectionManager.js Store-backed CRUD + kubectl spawn/stop + port parsing
  preload.js           contextBridge API bridging renderer <-> main
  renderer/            Mini window UI (index.html, styles.css, renderer.js)
assets/                Menu bar tray icons (template + active variants)
build/icon.png         Application icon (converted to .icns at build time)
scripts/gen-icon.js    Generates all icon assets
```
