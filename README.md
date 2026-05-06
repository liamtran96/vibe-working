# Vibe Working

A small Tauri 2 desktop app for Windows that lets you manage and run multiple local repositories from a single window. Add a folder, attach one or more shell commands to it (e.g. `npm run dev`, `cargo run`, `pnpm test`), and start, stop, or open them in VS Code with a click.

It is intentionally simple: a vanilla-JS frontend, a Rust backend, a single JSON config file, and no database.

## Features

- **Multi-repo dashboard** — keep all your projects in one list with status indicators.
- **Multiple named commands per repo** — store as many commands per repo as you like (e.g. `dev`, `test`, `build`) and pick one when you launch.
- **One-shot custom commands** — type a command on the fly; it gets remembered automatically for next time.
- **Process tracking** — only one command runs per repo at a time. The UI polls liveness so the status stays correct even if the process exits on its own.
- **Clean shutdown** — stopping a repo kills the full process tree (`taskkill /F /T /PID`). Closing the app window terminates every still-running child.
- **VS Code integration** — open a repo in a new VS Code window, or close VS Code windows whose title matches the repo folder name (uses Win32 `EnumWindows` + `WM_CLOSE`).
- **Persistent config** — all repos and commands are stored as JSON in your user config directory. Legacy single-command repos are migrated automatically on load.

## Requirements

- **Windows 10/11** — the backend uses `cmd /C`, `taskkill`, and the Win32 API directly. There is no cross-platform fallback.
- **Node.js 18+** and **npm** for the frontend tooling.
- **Rust toolchain** (stable) and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) — most importantly the WebView2 runtime (preinstalled on modern Windows) and the MSVC build tools.
- **VS Code** with the `code` CLI on `PATH` if you want the "Open in VS Code" button to work.

## Quick start

```bash
# Install JS deps
npm install

# Run in development (hot-reloads frontend, rebuilds Rust on change)
npm run dev

# Produce a release build (.exe + installer in src-tauri/target/release/)
npm run build
```

There are no lint or test commands configured.

## Usage

1. **Add a repo** — click *Add repo*, pick a folder with the native dialog, then type one or more named commands (label + command). The label is just a short tag you'll see on the run button (e.g. `dev`, `test`).
2. **Run** — click a command label to spawn it. The status dot turns green; the running label is highlighted.
3. **Stop** — click stop. The whole child process tree is killed, so things like `npm run dev` actually terminate their child Node processes instead of being orphaned.
4. **Custom command** — type any command into the inline input. It runs immediately and is saved as `custom-1`, `custom-2`, ... for next time. Re-running the same string reuses the existing label.
5. **Open / close VS Code** — open spawns `code --new-window <path>`. Close walks every visible window and posts `WM_CLOSE` to ones whose title contains the repo's folder name.
6. **Quit the app** — any still-running children are killed before exit (`WindowEvent::Destroyed` handler).

## Architecture

Standard Tauri split: vanilla JS frontend in `src/` talks to a Rust backend in `src-tauri/src/main.rs` over Tauri's `invoke()` IPC bridge.

### Frontend — `src/`

- `main.js` — all UI logic. Calls `window.__TAURI__.core.invoke(name, args)` to reach the backend. Polls `is_running` every 2 seconds via `setInterval` to keep status indicators current. State lives in a module-level `repos` array and `runningStatus` map.
- `index.html` + `styles.css` — single-page UI, dark theme.

### Backend — `src-tauri/src/main.rs`

Exposes 11 `#[tauri::command]` functions:

| Command | Purpose |
|---|---|
| `get_repos` | Return the saved repo list |
| `add_repo` | Create a repo from a path + named-commands list |
| `update_repo_commands` | Replace the commands list for a repo |
| `remove_repo` | Delete a repo entry |
| `run_repo` | Spawn a saved command (`cmd /C <command>`) in the repo dir |
| `run_repo_custom` | Spawn an ad-hoc command and persist it as a labelled entry |
| `running_label` | Return the label of the currently running command for a repo, if any |
| `is_running` | Liveness probe; reaps exited children from the running map |
| `stop_repo` | `taskkill /F /T /PID` on the tracked child |
| `open_vscode` | Spawn `code --new-window <path>` |
| `close_vscode` | Win32 `EnumWindows` → match by title → `PostMessageW(WM_CLOSE)` |

**Shared state** — `AppState { running_processes: Mutex<HashMap<String, RunningProcess>> }` tracks live `Child` handles plus the label that started them.

**Config persistence** — repos are written to `{config_dir}/config.json`, where `config_dir` is resolved via the `directories` crate using `("com", "vibe-working", "VibeWorking")`. The file is reloaded on every command and rewritten after every mutation.

**Shutdown hook** — the `on_window_event` handler kills every tracked child on `WindowEvent::Destroyed`, so closing the window won't leave orphaned dev servers.

### Data model

```rust
struct NamedCommand {
    label: String,
    command: String,
}

struct Repo {
    id: String,                // simple time-based hex id
    name: String,              // derived from folder name unless overridden
    path: String,
    commands: Vec<NamedCommand>,
    command: Option<String>,   // legacy single-command field; migrated on load
}
```

Legacy migration: if a repo loaded from disk has an empty `commands` list but a populated `command`, it is converted into `NamedCommand { label: "run", command }` before the first save.

## Tauri configuration

- Window: 760×820, min 520×600, resizable, centered.
- Plugins: `tauri-plugin-dialog` (native folder picker).
- Bundle identifier: `com.vibe-working.app`.
- Release profile: `strip = true`, `lto = true`, `codegen-units = 1` for a small binary.

## Project layout

```
vibe-working/
├── src/                  # Frontend (vanilla JS, HTML, CSS)
│   ├── index.html
│   ├── main.js
│   └── styles.css
├── src-tauri/            # Rust backend
│   ├── src/main.rs
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── icons/
├── package.json
└── README.md
```

## Notes & limitations

- **Windows-only.** `cmd /C`, `taskkill`, and the `windows` crate are used unconditionally.
- **No output streaming.** Spawned processes inherit the launcher's stdio; their output is not piped back into the UI. Run things that log to a file or use `open_vscode` if you need the terminal.
- **Liveness polling is 2 s.** Status flips with up to a 2-second delay after a process exits.
- **`close_vscode` matches by title substring.** A VS Code window titled with the repo's folder name will be closed; if multiple windows match, all of them get `WM_CLOSE`.
- **No auth, no sandboxing.** This is a developer convenience tool for your own machine — it runs whatever shell command you give it.
