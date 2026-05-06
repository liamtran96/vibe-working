#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod llm;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;
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
    #[serde(default)]
    llm: llm::LlmConfig,
}

struct RunningProcess {
    child: Child,
    label: String,
}

struct AppState {
    running_processes: Mutex<HashMap<String, RunningProcess>>,
}

fn get_config_dir() -> PathBuf {
    let config_dir = directories::ProjectDirs::from("com", "vibe-working", "VibeWorking")
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

fn chats_dir() -> PathBuf {
    let dir = get_config_dir().join("chats");
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
    #[serde(default)]
    folder: String,
}

// Validate a folder path supplied by the frontend or read from frontmatter.
// Rejects absolute paths, traversal segments, empty segments, and bad chars;
// normalises separators to "/". Empty input is the root, which is allowed.
fn sanitize_folder(input: &str) -> Result<String, String> {
    let trimmed = input.trim().replace('\\', "/");
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if trimmed.starts_with('/') {
        return Err("Folder path must be relative".to_string());
    }
    let parts: Vec<&str> = trimmed.split('/').filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return Ok(String::new());
    }
    for p in &parts {
        if *p == ".." || *p == "." {
            return Err("Folder path may not contain . or ..".to_string());
        }
        if p.chars()
            .any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        {
            return Err("Folder name contains an invalid character".to_string());
        }
        if p.starts_with(' ') || p.ends_with(' ') {
            return Err("Folder name may not start or end with a space".to_string());
        }
    }
    Ok(parts.join("/"))
}

// Recursively collect every `.md` file under `dir`.
fn walk_note_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let entries = match fs::read_dir(&d) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let ft = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if ft.is_dir() {
                stack.push(path);
            } else if ft.is_file()
                && path.extension().and_then(|s| s.to_str()) == Some("md")
            {
                out.push(path);
            }
        }
    }
    out
}

// Compute the folder field (relative path with `/` separators) for a note
// file that lives somewhere under `notes_dir`. Returns "" for root.
fn folder_for_path(path: &Path) -> String {
    let root = notes_dir();
    let parent = match path.parent() {
        Some(p) => p,
        None => return String::new(),
    };
    let rel = match parent.strip_prefix(&root) {
        Ok(r) => r,
        Err(_) => return String::new(),
    };
    rel.to_string_lossy().replace('\\', "/")
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

// Find an existing note file for `id` anywhere under notes_dir (any subfolder).
// Supports both `{slug}--{id}.md` and legacy `{id}.md` filenames.
fn find_note_path(id: &str) -> Option<PathBuf> {
    let suffix = format!("--{}", id);
    for path in walk_note_files(&notes_dir()) {
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
    let mut folder_field: Option<String> = None;
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
                "folder" => folder_field = Some(value.to_string()),
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

    // Folder is path-derived by default; honour an explicit frontmatter value
    // if it sanitises cleanly (covers manually-edited or legacy files).
    let folder = match folder_field {
        Some(raw) => sanitize_folder(&raw).unwrap_or_else(|_| folder_for_path(path)),
        None => folder_for_path(path),
    };

    Some(Note {
        id,
        title,
        body,
        tags,
        pinned,
        created_at,
        updated_at,
        folder,
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
        "---\nid: {}\ntitle: {}\ntags: [{}]\npinned: {}\nfolder: {}\ncreated_at: {}\nupdated_at: {}\n---\n{}",
        note.id,
        escape_frontmatter(&note.title),
        tags_line,
        note.pinned,
        escape_frontmatter(&note.folder),
        note.created_at,
        note.updated_at,
        note.body,
    );

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, contents).map_err(|e| e.to_string())
}

// Resolve the on-disk path for a note given its folder + slug + id.
fn note_path_for(folder: &str, title: &str, id: &str) -> PathBuf {
    let mut p = notes_dir();
    if !folder.is_empty() {
        for seg in folder.split('/').filter(|s| !s.is_empty()) {
            p.push(seg);
        }
    }
    p.push(note_filename(title, id));
    p
}

#[tauri::command]
fn get_notes() -> Vec<Note> {
    let mut notes: Vec<Note> = walk_note_files(&notes_dir())
        .into_iter()
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
fn create_note(title: String, folder: Option<String>) -> Result<Note, String> {
    let folder = sanitize_folder(folder.as_deref().unwrap_or(""))?;
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
        folder,
    };
    let path = note_path_for(&note.folder, &note.title, &note.id);
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
    folder: String,
) -> Result<Note, String> {
    let folder = sanitize_folder(&folder)?;
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
        folder,
    };
    let desired_path = note_path_for(&note.folder, &note.title, &note.id);
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

// ---------- Folder management ----------

#[tauri::command]
fn list_folders() -> Vec<String> {
    let root = notes_dir();
    let mut out: Vec<String> = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(d) = stack.pop() {
        let entries = match fs::read_dir(&d) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let ft = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if !ft.is_dir() {
                continue;
            }
            if let Ok(rel) = path.strip_prefix(&root) {
                let s = rel.to_string_lossy().replace('\\', "/");
                if !s.is_empty() {
                    out.push(s);
                }
            }
            stack.push(path);
        }
    }
    out.sort();
    out
}

#[tauri::command]
fn create_folder(path: String) -> Result<(), String> {
    let folder = sanitize_folder(&path)?;
    if folder.is_empty() {
        return Err("Folder name is required".to_string());
    }
    let mut target = notes_dir();
    for seg in folder.split('/').filter(|s| !s.is_empty()) {
        target.push(seg);
    }
    fs::create_dir_all(&target).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_folder(old: String, new: String) -> Result<(), String> {
    let old = sanitize_folder(&old)?;
    let new = sanitize_folder(&new)?;
    if old.is_empty() || new.is_empty() {
        return Err("Folder name is required".to_string());
    }
    if old == new {
        return Ok(());
    }
    let root = notes_dir();
    let mut old_path = root.clone();
    for seg in old.split('/').filter(|s| !s.is_empty()) {
        old_path.push(seg);
    }
    let mut new_path = root.clone();
    for seg in new.split('/').filter(|s| !s.is_empty()) {
        new_path.push(seg);
    }
    if !old_path.exists() {
        return Err("Source folder does not exist".to_string());
    }
    if new_path.exists() {
        return Err("Target folder already exists".to_string());
    }
    if let Some(parent) = new_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(&old_path, &new_path).map_err(|e| e.to_string())?;
    // Rewrite the `folder:` frontmatter line in every note inside the renamed
    // tree so external editors see the updated value too.
    for note_path in walk_note_files(&new_path) {
        if let Some(mut note) = parse_note_file(&note_path) {
            note.folder = folder_for_path(&note_path);
            let _ = write_note_file(&note, &note_path);
        }
    }
    Ok(())
}

#[tauri::command]
fn delete_folder(path: String, mode: String) -> Result<(), String> {
    let folder = sanitize_folder(&path)?;
    if folder.is_empty() {
        return Err("Cannot delete the root folder".to_string());
    }
    let root = notes_dir();
    let mut target = root.clone();
    for seg in folder.split('/').filter(|s| !s.is_empty()) {
        target.push(seg);
    }
    if !target.exists() {
        return Ok(()); // already gone
    }
    match mode.as_str() {
        "move-to-root" => {
            for note_path in walk_note_files(&target) {
                if let Some(mut note) = parse_note_file(&note_path) {
                    note.folder = String::new();
                    let dest = note_path_for("", &note.title, &note.id);
                    write_note_file(&note, &dest)?;
                    if dest != note_path {
                        let _ = fs::remove_file(&note_path);
                    }
                }
            }
            fs::remove_dir_all(&target).map_err(|e| e.to_string())
        }
        "delete" => fs::remove_dir_all(&target).map_err(|e| e.to_string()),
        other => Err(format!("Unknown delete mode: {}", other)),
    }
}

// ---------- Tag management ----------

fn tag_registry_path() -> PathBuf {
    get_config_dir().join("tags.json")
}

fn load_tag_registry() -> Vec<String> {
    fs::read_to_string(tag_registry_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

fn save_tag_registry(tags: &[String]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(tags).map_err(|e| e.to_string())?;
    fs::write(tag_registry_path(), json).map_err(|e| e.to_string())
}

fn case_insensitive_contains(list: &[String], name: &str) -> bool {
    list.iter().any(|t| t.eq_ignore_ascii_case(name))
}

#[tauri::command]
fn list_all_tags() -> Vec<String> {
    let mut set: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for t in load_tag_registry() {
        set.insert(t);
    }
    // Auto-include any tag that already appears on a note so legacy data
    // surfaces in the manager even if it was never explicitly registered.
    for path in walk_note_files(&notes_dir()) {
        if let Some(n) = parse_note_file(&path) {
            for t in n.tags {
                if !set.iter().any(|x| x.eq_ignore_ascii_case(&t)) {
                    set.insert(t);
                }
            }
        }
    }
    set.into_iter().collect()
}

#[tauri::command]
fn create_tag(name: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Tag name is required".to_string());
    }
    let mut registry = load_tag_registry();
    if case_insensitive_contains(&registry, &name) {
        return Err(format!("Tag “{}” already exists", name));
    }
    registry.push(name);
    save_tag_registry(&registry)
}

// Helper: walk every note, apply `mutate` to its tags. If the closure returns
// true (tags changed), bump updated_at and rewrite the file. Returns the
// number of files that actually changed.
fn mutate_all_tags<F>(mut mutate: F) -> Result<usize, String>
where
    F: FnMut(&mut Vec<String>) -> bool,
{
    let now = now_secs();
    let mut count = 0usize;
    for path in walk_note_files(&notes_dir()) {
        if let Some(mut note) = parse_note_file(&path) {
            if mutate(&mut note.tags) {
                note.updated_at = now;
                write_note_file(&note, &path)?;
                count += 1;
            }
        }
    }
    Ok(count)
}

fn dedupe_preserve_order(v: &mut Vec<String>) {
    let mut seen = std::collections::HashSet::new();
    v.retain(|t| seen.insert(t.clone()));
}

#[tauri::command]
fn rename_tag(old: String, new: String) -> Result<usize, String> {
    let old = old.trim().to_string();
    let new = new.trim().to_string();
    if old.is_empty() || new.is_empty() {
        return Err("Tag name is required".to_string());
    }
    if old == new {
        return Ok(0);
    }
    let count = mutate_all_tags(|tags| {
        if !tags.iter().any(|t| t == &old) {
            return false;
        }
        for t in tags.iter_mut() {
            if *t == old {
                *t = new.clone();
            }
        }
        dedupe_preserve_order(tags);
        true
    })?;
    let mut registry = load_tag_registry();
    let mut changed = false;
    for t in registry.iter_mut() {
        if *t == old {
            *t = new.clone();
            changed = true;
        }
    }
    if !case_insensitive_contains(&registry, &new) {
        registry.push(new);
        changed = true;
    }
    if changed {
        dedupe_preserve_order(&mut registry);
        save_tag_registry(&registry)?;
    }
    Ok(count)
}

#[tauri::command]
fn delete_tag(name: String) -> Result<usize, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Tag name is required".to_string());
    }
    let count = mutate_all_tags(|tags| {
        let before = tags.len();
        tags.retain(|t| t != &name);
        tags.len() != before
    })?;
    let mut registry = load_tag_registry();
    let before = registry.len();
    registry.retain(|t| t != &name);
    if registry.len() != before {
        save_tag_registry(&registry)?;
    }
    Ok(count)
}

#[tauri::command]
fn merge_tags(from: String, into: String) -> Result<usize, String> {
    let from = from.trim().to_string();
    let into = into.trim().to_string();
    if from.is_empty() || into.is_empty() {
        return Err("Tag name is required".to_string());
    }
    if from == into {
        return Ok(0);
    }
    let count = mutate_all_tags(|tags| {
        if !tags.iter().any(|t| t == &from) {
            return false;
        }
        for t in tags.iter_mut() {
            if *t == from {
                *t = into.clone();
            }
        }
        dedupe_preserve_order(tags);
        true
    })?;
    let mut registry = load_tag_registry();
    let before_len = registry.len();
    registry.retain(|t| t != &from);
    if !case_insensitive_contains(&registry, &into) {
        registry.push(into);
    }
    if registry.len() != before_len {
        save_tag_registry(&registry)?;
    }
    Ok(count)
}

#[tauri::command]
fn count_notes_with_tag(name: String) -> usize {
    let name = name.trim().to_string();
    if name.is_empty() {
        return 0;
    }
    walk_note_files(&notes_dir())
        .into_iter()
        .filter_map(|p| parse_note_file(&p))
        .filter(|n| n.tags.iter().any(|t| t == &name))
        .count()
}

fn uuid_simple() -> String {
    let duration = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
    format!("{:x}{:x}", duration.as_secs(), duration.subsec_nanos())
}

// ============================================================
// LLM (Gemma via llama.cpp)
// ============================================================

#[tauri::command]
fn get_llm_config() -> llm::LlmConfig {
    load_config().llm
}

#[tauri::command]
fn set_llm_config(config: llm::LlmConfig) -> Result<(), String> {
    let mut cfg = load_config();
    cfg.llm = config;
    save_config(&cfg)
}

#[tauri::command]
async fn chat_completion(
    messages: Vec<llm::ChatMessage>,
    opts: Option<llm::ChatOpts>,
    on_event: Channel<llm::ChatEvent>,
) -> Result<String, String> {
    let config = load_config().llm;
    llm::chat_completion_impl(config, on_event, messages, opts).await
}

#[tauri::command]
async fn llm_health() -> bool {
    let config = load_config().llm;
    llm::llm_health_impl(config).await
}

// ============================================================
// Chats (conversation persistence)
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Chat {
    id: String,
    title: String,
    #[serde(default)]
    messages: Vec<llm::ChatMessage>,
    #[serde(default)]
    created_at: u64,
    updated_at: u64,
}

fn chat_path(id: &str) -> PathBuf {
    chats_dir().join(format!("{}.json", id))
}

// Lightweight projection of `Chat` for the sidebar list — skips the (potentially
// large) `messages` array so opening the Chat view doesn't deserialize every
// conversation in full.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChatMeta {
    id: String,
    title: String,
    #[serde(default)]
    message_count: usize,
    #[serde(default)]
    created_at: u64,
    updated_at: u64,
}

#[derive(Deserialize)]
struct ChatMetaRaw {
    id: String,
    #[serde(default)]
    title: String,
    // IgnoredAny skips the message contents while still counting array entries —
    // avoids allocating String/role/content for every message just to render the count.
    #[serde(default)]
    messages: Vec<serde::de::IgnoredAny>,
    #[serde(default)]
    created_at: u64,
    #[serde(default)]
    updated_at: u64,
}

#[tauri::command]
fn list_chats() -> Vec<ChatMeta> {
    let entries = match fs::read_dir(chats_dir()) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    let mut chats: Vec<ChatMeta> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("json"))
        .filter_map(|p| {
            let raw: ChatMetaRaw = fs::read_to_string(&p)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())?;
            Some(ChatMeta {
                id: raw.id,
                title: raw.title,
                message_count: raw.messages.len(),
                created_at: raw.created_at,
                updated_at: raw.updated_at,
            })
        })
        .collect();

    chats.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    chats
}

#[tauri::command]
fn get_chat(id: String) -> Result<Chat, String> {
    let path = chat_path(&id);
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_chat(title: Option<String>) -> Result<Chat, String> {
    let now = now_secs();
    let chat = Chat {
        id: uuid_simple(),
        title: title
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| "New chat".to_string()),
        messages: Vec::new(),
        created_at: now,
        updated_at: now,
    };
    save_chat_to_disk(&chat)?;
    Ok(chat)
}

#[tauri::command]
fn save_chat(chat: Chat) -> Result<Chat, String> {
    let mut chat = chat;
    chat.updated_at = now_secs();
    if chat.created_at == 0 {
        chat.created_at = chat.updated_at;
    }
    save_chat_to_disk(&chat)?;
    Ok(chat)
}

#[tauri::command]
fn delete_chat(id: String) -> Result<(), String> {
    match fs::remove_file(chat_path(&id)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn save_chat_to_disk(chat: &Chat) -> Result<(), String> {
    let path = chat_path(&chat.id);
    let json = serde_json::to_string_pretty(chat).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
            list_folders,
            create_folder,
            rename_folder,
            delete_folder,
            list_all_tags,
            create_tag,
            rename_tag,
            delete_tag,
            merge_tags,
            count_notes_with_tag,
            get_llm_config,
            set_llm_config,
            chat_completion,
            llm_health,
            list_chats,
            get_chat,
            create_chat,
            save_chat,
            delete_chat,
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
