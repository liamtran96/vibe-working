# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

**Repo Launcher** is a Tauri 2 desktop app for Windows that lets developers manage and run multiple repositories from a single UI. Users can add repos, assign shell commands (e.g. `npm run main`), start/stop processes, and open repos in VS Code.

## Commands

```bash
# Start development (hot-reloads frontend, rebuilds Rust on change)
npm run dev

# Build release binary
npm run build
```

No lint or test commands are currently configured.

## Architecture

The project follows the standard Tauri split: vanilla JS frontend in `src/` communicates with a Rust backend in `src-tauri/src/main.rs` via Tauri's `invoke()` IPC bridge.

### Frontend (`src/`)

- `main.js` — all application logic. Calls `window.__TAURI__.core.invoke(commandName, args)` to reach the backend. Polls `is_running(id)` every 2 seconds via `setInterval` to update status indicators. State lives in a module-level `repos` array and `runningStatus` map.
- `index.html` + `styles.css` — single-page UI with a dark theme.

### Backend (`src-tauri/src/main.rs`)

Exposes 11 `#[tauri::command]` functions. Key ones:

| Command | Purpose |
|---|---|
| `get_repos` / `add_repo` / `remove_repo` / `update_repo` | CRUD for the repo list |
| `scan_root_folder` | Auto-discovers repos that contain `package.json` |
| `run_repo` | Spawns `cmd /C <command>` as a detached child process |
| `stop_repo` | Kills the process tree with `taskkill /F /T /PID` |
| `is_running` | Checks if a stored `Child` process is still alive |
| `open_vscode` | Runs `code <path>` |
| `select_folder` | Opens a native folder-picker dialog |

**Shared state** (`AppState`) uses `Mutex<HashMap<String, Child>>` to track live processes across commands.

**Config persistence** — repos are stored as JSON at `{config_dir}/config.json`, resolved via the `directories` crate (`com.repo-launcher.RepoLauncher`). Loaded on startup, written after every mutation.

### Data Model

```rust
struct Repo {
    id: String,       // UUID
    name: String,     // Derived from folder name
    path: String,
    command: String,  // Shell command to run
}
```

### Tauri Configuration

- Window: 500×600 px, resizable, centered
- Permissions: `core:default`, `dialog:default`, `dialog:allow-open`
- Bundle identifier: `com.repo-launcher.app`
