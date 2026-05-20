use std::path::{Path, PathBuf};
#[cfg(debug_assertions)]
use std::process::Child;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::Manager;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// 桌面安装包专用端口，避免与常见开发服务（3000 等）冲突。
pub const BACKEND_PORT: &str = "38473";

struct BackendState {
    child: Mutex<Option<CommandChild>>,
    pid: Mutex<Option<u32>>,
    #[cfg(debug_assertions)]
    dev_child: Mutex<Option<Child>>,
}

impl Default for BackendState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            pid: Mutex::new(None),
            #[cfg(debug_assertions)]
            dev_child: Mutex::new(None),
        }
    }
}

#[derive(Serialize, Clone)]
struct BackendStatus {
    running: bool,
    pid: Option<u32>,
    port: &'static str,
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn backend_url() -> String {
    format!("http://127.0.0.1:{BACKEND_PORT}")
}

fn status_ok(pid: u32) -> BackendStatus {
    BackendStatus {
        running: true,
        pid: Some(pid),
        port: BACKEND_PORT,
        url: backend_url(),
        error: None,
    }
}

fn status_stopped() -> BackendStatus {
    BackendStatus {
        running: false,
        pid: None,
        port: BACKEND_PORT,
        url: backend_url(),
        error: None,
    }
}

fn data_dir_path(handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))
}

fn pid_alive(pid: u32) -> bool {
    Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn migrations_present(root: &Path) -> bool {
    root.join("db/migrations").is_dir()
}

/// 解析只读资源根（含 migrations、python_connectors、content-packs）。
fn resolve_app_root(handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(dir) = handle.path().resource_dir() {
        let bundle = dir.join("bundle");
        if migrations_present(&bundle) {
            return Ok(bundle);
        }
    }

    if let Ok(root) = std::env::var("QUBIT_APP_ROOT") {
        let p = PathBuf::from(root.trim());
        if migrations_present(&p) {
            return Ok(p);
        }
    }

    #[cfg(debug_assertions)]
    {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        for rel in ["../dist/bundle/resources", "../../dist/bundle/resources"] {
            let p = manifest.join(rel);
            if migrations_present(&p) {
                return Ok(p);
            }
        }
    }

    Err(
        "app resources not found (db/migrations missing). Run `bun run build:app` before `tauri build`."
            .to_string(),
    )
}

#[cfg(debug_assertions)]
fn spawn_dev_bun_backend(
    handle: &tauri::AppHandle,
    state: &BackendState,
) -> Result<BackendStatus, String> {
    let mut dev_guard = state
        .dev_child
        .lock()
        .map_err(|_| "backend lock poisoned".to_string())?;

    let app_root = resolve_app_root(handle)?;
    let data_dir = data_dir_path(handle)?;
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("create data_dir: {e}"))?;

    let app_root_str = app_root
        .to_str()
        .ok_or_else(|| "app_root path is not UTF-8".to_string())?
        .to_string();
    let data_dir_str = data_dir
        .to_str()
        .ok_or_else(|| "data_dir path is not UTF-8".to_string())?
        .to_string();

    // sidecar binary 缺失（开发期常态：未跑 `bun run build:app`）时直接拉 `bun run src/index.ts`，
    // 同时通过 QUBIT_APP_ROOT/QUBIT_DATA_DIR 让 dev fallback 复用与 sidecar 模式一致的数据目录，
    // 避免来回切换时看到不同的 chat_session / workflow_run。
    let child = Command::new("bash")
        .arg("-lc")
        .arg(format!(
            "PORT={} HOST=127.0.0.1 QUBIT_APP_ROOT='{}' QUBIT_DATA_DIR='{}' bun run src/index.ts",
            BACKEND_PORT, app_root_str, data_dir_str
        ))
        .current_dir("..")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("dev bun spawn: {e}"))?;

    let pid = child.id();
    *dev_guard = Some(child);
    Ok(status_ok(pid))
}

fn stop_backend_internal(state: &BackendState) -> Result<(), String> {
    let mut child_guard = state
        .child
        .lock()
        .map_err(|_| "backend lock poisoned".to_string())?;
    let mut pid_guard = state
        .pid
        .lock()
        .map_err(|_| "backend lock poisoned".to_string())?;
    if let Some(child) = child_guard.take() {
        let _ = child.kill();
    }
    *pid_guard = None;
    #[cfg(debug_assertions)]
    {
        let mut dev_guard = state
            .dev_child
            .lock()
            .map_err(|_| "backend lock poisoned".to_string())?;
        if let Some(mut dev) = dev_guard.take() {
            let _ = dev.kill();
            let _ = dev.wait();
        }
    }
    Ok(())
}

fn spawn_backend_sidecar(
    handle: &tauri::AppHandle,
    state: &BackendState,
) -> Result<BackendStatus, String> {
    let mut child_guard = state
        .child
        .lock()
        .map_err(|_| "backend lock poisoned".to_string())?;
    let mut pid_guard = state
        .pid
        .lock()
        .map_err(|_| "backend lock poisoned".to_string())?;

    if let Some(pid) = *pid_guard {
        if pid_alive(pid) {
            return Ok(status_ok(pid));
        }
        *child_guard = None;
        *pid_guard = None;
    }

    let app_root = resolve_app_root(handle)?;
    let data_dir = data_dir_path(handle)?;
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("create data_dir: {e}"))?;

    // debug build 期间，预编译 sidecar binary 几乎总是落后于当前源码（每次都得 `bun run build:app` 才能同步），
    // 默认强制 fallback 到 `bun run src/index.ts`，保证开发期改代码立即生效；
    // 如果确实需要在 debug 模式下也测预编译 binary，可以设 QUBIT_USE_SIDECAR_BIN=1。
    #[cfg(debug_assertions)]
    if std::env::var("QUBIT_USE_SIDECAR_BIN").as_deref() != Ok("1") {
        drop(child_guard);
        drop(pid_guard);
        return spawn_dev_bun_backend(handle, state);
    }

    let sidecar = handle.shell().sidecar("qubit");
    let Ok(sidecar) = sidecar else {
        #[cfg(debug_assertions)]
        {
            drop(child_guard);
            drop(pid_guard);
            return spawn_dev_bun_backend(handle, state);
        }
        #[cfg(not(debug_assertions))]
        return Err("qubit sidecar binary missing; run `bun run build:app` before packaging".to_string());
    };

    let app_root_str = app_root
        .to_str()
        .ok_or_else(|| "app_root path is not UTF-8".to_string())?
        .to_string();
    let data_dir_str = data_dir
        .to_str()
        .ok_or_else(|| "data_dir path is not UTF-8".to_string())?
        .to_string();

    let (_rx, child) = sidecar
        .env("QUBIT_APP_ROOT", app_root_str)
        .env("QUBIT_DATA_DIR", data_dir_str)
        .env("PORT", BACKEND_PORT)
        .env("HOST", "127.0.0.1")
        .env("NODE_ENV", "production")
        .spawn()
        .map_err(|e| format!("sidecar spawn: {e}"))?;

    let pid = child.pid();
    *child_guard = Some(child);
    *pid_guard = Some(pid);

    Ok(status_ok(pid))
}

#[tauri::command]
fn start_backend(
    handle: tauri::AppHandle,
    state: tauri::State<'_, BackendState>,
) -> Result<BackendStatus, String> {
    spawn_backend_sidecar(&handle, &state)
}

#[tauri::command]
fn stop_backend(state: tauri::State<'_, BackendState>) -> Result<BackendStatus, String> {
    stop_backend_internal(&state)?;
    Ok(status_stopped())
}

#[tauri::command]
fn restart_backend(
    handle: tauri::AppHandle,
    state: tauri::State<'_, BackendState>,
) -> Result<BackendStatus, String> {
    stop_backend_internal(&state)?;
    std::thread::sleep(Duration::from_millis(400));
    spawn_backend_sidecar(&handle, &state)
}

#[tauri::command]
fn backend_status(state: tauri::State<'_, BackendState>) -> Result<BackendStatus, String> {
    let pid_guard = state
        .pid
        .lock()
        .map_err(|_| "backend lock poisoned".to_string())?;
    if let Some(pid) = *pid_guard {
        if pid_alive(pid) {
            return Ok(status_ok(pid));
        }
    }
    Ok(status_stopped())
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
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }

            let handle = app.handle().clone();
            let state = app.state::<BackendState>();
            match spawn_backend_sidecar(&handle, &state) {
                Ok(s) => eprintln!(
                    "[QUBIT] backend sidecar started pid={:?} url={}",
                    s.pid, s.url
                ),
                Err(e) => eprintln!("[QUBIT] failed to start backend sidecar: {e}"),
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_backend,
            stop_backend,
            restart_backend,
            backend_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
