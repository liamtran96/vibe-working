#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Manager, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct NamedCommand {
    label: String,
    command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Repo {
    id: String,
    name: String,
    path: String,
    #[serde(default)]
    commands: Vec<NamedCommand>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    command: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Config {
    repos: Vec<Repo>,
}

struct RunningProcess {
    child: Child,
    label: String,
}

struct AppState {
    running_processes: Mutex<HashMap<String, RunningProcess>>,
}

fn get_config_dir() -> PathBuf {
    let config_dir = directories::ProjectDirs::from("com", "repo-launcher", "RepoLauncher")
        .map(|d| d.config_dir().to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));

    fs::create_dir_all(&config_dir).ok();
    config_dir
}

fn get_config_path() -> PathBuf {
    get_config_dir().join("config.json")
}

fn notes_dir() -> PathBuf {
    let dir = get_config_dir().join("notes");
    fs::create_dir_all(&dir).ok();
    dir
}

fn load_config() -> Config {
    let path = get_config_path();
    let mut config: Config = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    // Migrate legacy single-command repos into the commands list.
    for repo in config.repos.iter_mut() {
        if repo.commands.is_empty() {
            if let Some(cmd) = repo.command.take() {
                repo.commands.push(NamedCommand {
                    label: "run".to_string(),
                    command: cmd,
                });
            }
        } else {
            repo.command = None;
        }
    }

    config
}

fn save_config(config: &Config) -> Result<(), String> {
    let path = get_config_path();
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_repos() -> Vec<Repo> {
    load_config().repos
}

#[tauri::command]
fn add_repo(
    path: String,
    commands: Vec<NamedCommand>,
    name: Option<String>,
) -> Result<Repo, String> {
    let mut config = load_config();

    let derived_name = PathBuf::from(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());

    let repo = Repo {
        id: uuid_simple(),
        name: name.filter(|n| !n.trim().is_empty()).unwrap_or(derived_name),
        path,
        commands,
        command: None,
    };

    config.repos.push(repo.clone());
    save_config(&config)?;

    Ok(repo)
}

#[tauri::command]
fn update_repo_commands(id: String, commands: Vec<NamedCommand>) -> Result<(), String> {
    let mut config = load_config();
    let repo = config.repos.iter_mut().find(|r| r.id == id)
        .ok_or("Repository not found")?;
    repo.commands = commands;
    repo.command = None;
    save_config(&config)
}

#[tauri::command]
fn remove_repo(id: String) -> Result<(), String> {
    let mut config = load_config();
    config.repos.retain(|r| r.id != id);
    save_config(&config)
}

#[tauri::command]
fn run_repo(
    id: String,
    label: String,
    open_vscode: bool,
    state: State<AppState>,
) -> Result<(), String> {
    let config = load_config();
    let repo = config.repos.iter().find(|r| r.id == id)
        .ok_or("Repository not found")?;

    let named = repo.commands.iter().find(|c| c.label == label)
        .ok_or("Command not found")?;

    if named.command.trim().is_empty() {
        return Err("Empty command".to_string());
    }

    let mut processes = state.running_processes.lock().map_err(|e| e.to_string())?;

    if processes.contains_key(&id) {
        return Err("Already running".to_string());
    }

    if open_vscode {
        Command::new("cmd")
            .args(["/C", "code", "--new-window", &repo.path])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok();
    }

    let child = Command::new("cmd")
        .args(["/C"])
        .arg(&named.command)
        .current_dir(&repo.path)
        .spawn()
        .map_err(|e| e.to_string())?;

    processes.insert(id, RunningProcess { child, label: named.label.clone() });
    Ok(())
}

#[tauri::command]
fn run_repo_custom(
    id: String,
    command: String,
    open_vscode: bool,
    state: State<AppState>,
) -> Result<String, String> {
    let mut config = load_config();
    let repo = config.repos.iter_mut().find(|r| r.id == id)
        .ok_or("Repository not found")?;

    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("Empty command".to_string());
    }

    let saved_label = match repo.commands.iter().find(|c| c.command == trimmed) {
        Some(existing) => existing.label.clone(),
        None => {
            let label = next_custom_label(&repo.commands);
            repo.commands.push(NamedCommand {
                label: label.clone(),
                command: trimmed.to_string(),
            });
            label
        }
    };

    let repo_path = repo.path.clone();
    save_config(&config)?;

    let mut processes = state.running_processes.lock().map_err(|e| e.to_string())?;

    if processes.contains_key(&id) {
        return Err("Already running".to_string());
    }

    if open_vscode {
        Command::new("cmd")
            .args(["/C", "code", "--new-window", &repo_path])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok();
    }

    let child = Command::new("cmd")
        .args(["/C"])
        .arg(trimmed)
        .current_dir(&repo_path)
        .spawn()
        .map_err(|e| e.to_string())?;

    processes.insert(id, RunningProcess { child, label: saved_label.clone() });
    Ok(saved_label)
}

fn next_custom_label(commands: &[NamedCommand]) -> String {
    let mut n = 1;
    loop {
        let candidate = format!("custom-{}", n);
        if !commands.iter().any(|c| c.label == candidate) {
            return candidate;
        }
        n += 1;
    }
}

#[tauri::command]
fn running_label(id: String, state: State<AppState>) -> Option<String> {
    let processes = state.running_processes.lock().ok()?;
    processes.get(&id).map(|p| p.label.clone())
}

#[tauri::command]
fn open_vscode(id: String) -> Result<(), String> {
    let config = load_config();
    let repo = config.repos.iter().find(|r| r.id == id)
        .ok_or("Repository not found")?;

    Command::new("cmd")
        .args(["/C", "code", "--new-window", &repo.path])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn close_vscode(id: String) -> Result<(), String> {
    let config = load_config();
    let repo = config.repos.iter().find(|r| r.id == id)
        .ok_or("Repository not found")?;

    let folder_name = PathBuf::from(&repo.path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| repo.name.clone());

    close_window_by_title(&folder_name);
    Ok(())
}

fn close_window_by_title(filter: &str) {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextW, IsWindowVisible, PostMessageW, WM_CLOSE,
    };

    struct State {
        filter: String,
        hwnds: Vec<usize>,
    }

    unsafe extern "system" fn callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state = &mut *(lparam.0 as *mut State);
        if IsWindowVisible(hwnd).as_bool() {
            let mut buf = [0u16; 512];
            let len = GetWindowTextW(hwnd, &mut buf);
            if len > 0 {
                let title = String::from_utf16_lossy(&buf[..len as usize]).to_lowercase();
                if title.contains(&state.filter) {
                    state.hwnds.push(hwnd.0 as usize);
                }
            }
        }
        BOOL(1)
    }

    let mut state = State {
        filter: filter.to_lowercase(),
        hwnds: Vec::new(),
    };

    unsafe {
        let _ = EnumWindows(Some(callback), LPARAM(&mut state as *mut _ as isize));
        for hwnd_val in &state.hwnds {
            let hwnd = HWND(*hwnd_val as *mut _);
            let _ = PostMessageW(hwnd, WM_CLOSE, WPARAM(0), LPARAM(0));
        }
    }
}

#[tauri::command]
fn stop_repo(id: String, state: State<AppState>) -> Result<(), String> {
    let mut processes = state.running_processes.lock().map_err(|e| e.to_string())?;

    if let Some(proc) = processes.remove(&id) {
        let pid = proc.child.id();
        Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .spawn()
            .ok();
    }

    Ok(())
}

#[tauri::command]
fn is_running(id: String, state: State<AppState>) -> bool {
    let mut processes = state.running_processes.lock().unwrap();

    if let Some(proc) = processes.get_mut(&id) {
        match proc.child.try_wait() {
            Ok(Some(_)) => {
                processes.remove(&id);
                false
            }
            Ok(None) => true,
            Err(_) => {
                processes.remove(&id);
                false
            }
        }
    } else {
        false
    }
}

// ============================================================
// Notes
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Note {
    id: String,
    title: String,
    body: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    pinned: bool,
    #[serde(default)]
    created_at: u64,
    updated_at: u64,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn slugify(title: &str) -> String {
    let mut s = String::new();
    let mut last_was_dash = false;
    for c in title.chars() {
        if c.is_alphanumeric() {
            for lc in c.to_lowercase() {
                s.push(lc);
            }
            last_was_dash = false;
        } else if c.is_whitespace() || c == '-' || c == '_' {
            if !last_was_dash && !s.is_empty() {
                s.push('-');
                last_was_dash = true;
            }
        }
    }
    while s.ends_with('-') {
        s.pop();
    }
    if s.len() > 60 {
        s.truncate(60);
        while s.ends_with('-') {
            s.pop();
        }
    }
    if s.is_empty() {
        s.push_str("untitled");
    }
    s
}

fn note_filename(title: &str, id: &str) -> String {
    format!("{}--{}.md", slugify(title), id)
}

// Find an existing note file for `id`. Supports both the new
// `{slug}--{id}.md` layout and legacy `{id}.md` files.
fn find_note_path(id: &str) -> Option<PathBuf> {
    let dir = notes_dir();
    let entries = fs::read_dir(&dir).ok()?;
    let suffix = format!("--{}", id);
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            if stem == id || stem.ends_with(&suffix) {
                return Some(path);
            }
        }
    }
    None
}

fn parse_tags_line(s: &str) -> Vec<String> {
    let trimmed = s.trim();
    let inner = trimmed
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(trimmed);
    inner
        .split(',')
        .map(|t| t.trim().trim_matches('"').trim_matches('\'').to_string())
        .filter(|t| !t.is_empty())
        .collect()
}

fn parse_note_file(path: &Path) -> Option<Note> {
    let content = fs::read_to_string(path).ok()?;
    let mut lines = content.lines();

    if lines.next()?.trim() != "---" {
        return None;
    }

    let mut id = String::new();
    let mut title = String::new();
    let mut tags: Vec<String> = Vec::new();
    let mut pinned = false;
    let mut created_at: u64 = 0;
    let mut updated_at: u64 = 0;
    let mut frontmatter_end = false;

    for line in lines.by_ref() {
        if line.trim() == "---" {
            frontmatter_end = true;
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            let key = key.trim();
            let value = value.trim();
            match key {
                "id" => id = value.to_string(),
                "title" => title = value.to_string(),
                "tags" => tags = parse_tags_line(value),
                "pinned" => pinned = value == "true",
                "created_at" => created_at = value.parse().unwrap_or(0),
                "updated_at" => updated_at = value.parse().unwrap_or(0),
                _ => {}
            }
        }
    }

    if !frontmatter_end || id.is_empty() {
        return None;
    }

    let body: String = lines.collect::<Vec<_>>().join("\n");
    let body = body.strip_prefix('\n').unwrap_or(&body).to_string();

    if created_at == 0 {
        created_at = updated_at;
    }

    Some(Note {
        id,
        title,
        body,
        tags,
        pinned,
        created_at,
        updated_at,
    })
}

fn escape_frontmatter(s: &str) -> String {
    s.replace('\r', "").replace('\n', " ")
}

fn write_note_file(note: &Note, path: &Path) -> Result<(), String> {
    let tags_line = note
        .tags
        .iter()
        .map(|t| t.replace(',', ""))
        .collect::<Vec<_>>()
        .join(", ");

    let contents = format!(
        "---\nid: {}\ntitle: {}\ntags: [{}]\npinned: {}\ncreated_at: {}\nupdated_at: {}\n---\n{}",
        note.id,
        escape_frontmatter(&note.title),
        tags_line,
        note.pinned,
        note.created_at,
        note.updated_at,
        note.body,
    );

    fs::write(path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_notes() -> Vec<Note> {
    let dir = notes_dir();
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    let mut notes: Vec<Note> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("md"))
        .filter_map(|p| parse_note_file(&p))
        .collect();

    notes.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then_with(|| b.updated_at.cmp(&a.updated_at))
    });

    notes
}

#[tauri::command]
fn create_note(title: String) -> Result<Note, String> {
    let now = now_secs();
    let note = Note {
        id: uuid_simple(),
        title: if title.trim().is_empty() {
            "Untitled".to_string()
        } else {
            title
        },
        body: String::new(),
        tags: Vec::new(),
        pinned: false,
        created_at: now,
        updated_at: now,
    };
    let path = notes_dir().join(note_filename(&note.title, &note.id));
    write_note_file(&note, &path)?;
    Ok(note)
}

#[tauri::command]
fn update_note(
    id: String,
    title: String,
    body: String,
    tags: Vec<String>,
    pinned: bool,
) -> Result<Note, String> {
    let existing_path = find_note_path(&id).ok_or("Note not found")?;
    let existing_created = parse_note_file(&existing_path)
        .map(|n| n.created_at)
        .unwrap_or(0);
    let now = now_secs();
    let note = Note {
        id: id.clone(),
        title,
        body,
        tags,
        pinned,
        created_at: if existing_created == 0 { now } else { existing_created },
        updated_at: now,
    };
    let desired_path = notes_dir().join(note_filename(&note.title, &note.id));
    write_note_file(&note, &desired_path)?;
    if existing_path != desired_path {
        let _ = fs::remove_file(&existing_path);
    }
    Ok(note)
}

#[tauri::command]
fn delete_note(id: String) -> Result<(), String> {
    if let Some(path) = find_note_path(&id) {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_notes_folder() -> String {
    notes_dir().to_string_lossy().to_string()
}

#[tauri::command]
fn open_notes_folder() -> Result<(), String> {
    let dir = notes_dir();
    Command::new("explorer")
        .arg(&dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn uuid_simple() -> String {
    let duration = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
    format!("{:x}{:x}", duration.as_secs(), duration.subsec_nanos())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            running_processes: Mutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            get_repos,
            add_repo,
            update_repo_commands,
            remove_repo,
            run_repo,
            run_repo_custom,
            running_label,
            stop_repo,
            is_running,
            open_vscode,
            close_vscode,
            get_notes,
            create_note,
            update_note,
            delete_note,
            get_notes_folder,
            open_notes_folder,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let app_handle = window.app_handle().clone();
                let state = app_handle.state::<AppState>();
                let lock = state.running_processes.lock();
                if let Ok(mut processes) = lock {
                    for (_, proc) in processes.iter() {
                        Command::new("taskkill")
                            .args(["/F", "/T", "/PID", &proc.child.id().to_string()])
                            .spawn()
                            .ok();
                    }
                    processes.clear();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
