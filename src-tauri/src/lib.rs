use tauri::Manager;
use tauri::State;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use serde::Serialize;

#[derive(Default)]
struct BackendState {
    child: Mutex<Option<Child>>,
}

#[derive(Serialize)]
struct BackendStatus {
    running: bool,
    pid: Option<u32>,
}

#[tauri::command]
fn start_backend(state: State<'_, BackendState>) -> Result<BackendStatus, String> {
    let mut child_guard = state.child.lock().map_err(|_| "backend lock poisoned".to_string())?;
    if let Some(existing) = child_guard.as_mut() {
        match existing.try_wait() {
            Ok(None) => {
                return Ok(BackendStatus {
                    running: true,
                    pid: Some(existing.id()),
                });
            }
            Ok(Some(_)) | Err(_) => {
                *child_guard = None;
            }
        }
    }

    let child = Command::new("bash")
        .arg("-lc")
        .arg("source ~/.bash_profile && bun run src/index.ts")
        .current_dir("..")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn backend: {e}"))?;

    let pid = child.id();
    *child_guard = Some(child);
    Ok(BackendStatus {
        running: true,
        pid: Some(pid),
    })
}

#[tauri::command]
fn stop_backend(state: State<'_, BackendState>) -> Result<BackendStatus, String> {
    let mut child_guard = state.child.lock().map_err(|_| "backend lock poisoned".to_string())?;
    if let Some(mut child) = child_guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(BackendStatus {
        running: false,
        pid: None,
    })
}

#[tauri::command]
fn backend_status(state: State<'_, BackendState>) -> Result<BackendStatus, String> {
    let mut child_guard = state.child.lock().map_err(|_| "backend lock poisoned".to_string())?;
    if let Some(child) = child_guard.as_mut() {
        match child.try_wait() {
            Ok(None) => {
                return Ok(BackendStatus {
                    running: true,
                    pid: Some(child.id()),
                });
            }
            Ok(Some(_)) | Err(_) => {
                *child_guard = None;
            }
        }
    }
    Ok(BackendStatus {
        running: false,
        pid: None,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .manage(BackendState::default())
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_backend,
            stop_backend,
            backend_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
