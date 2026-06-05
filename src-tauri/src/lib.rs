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

/// 桌面安装包专用端口。
/// 选 17385 而非 49152+ 范围：macOS 临时端口范围默认 49152-65535，
/// 落在该区间的固定端口会被其它进程（如 Cursor 派生的 npx mcp 工具）随机抢占，
/// 出现「端口被占但 health check 误判为 connected」的故障。
pub const BACKEND_PORT: &str = "17385";

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
    // 直接走 libc::kill(pid, 0)：signal 0 只检查 pid 存在性 + 调用方权限，不投递信号、不 fork。
    // 早先实现 `Command::new("kill").arg("-0").status()` 虽然 Command::status() 内部会 waitpid 不留 zombie，
    // 但每次健康轮询都白白 fork 一个 `kill` 子进程，是无谓的进程创建。
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
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

    // 关键 zombie 修复：
    // 旧实现里 `*dev_guard = Some(new_child)` 会直接 drop 原来的 Option<Child>，
    // 而 std::process::Child::drop 文档明确不会 wait()，所以每次重复 spawn 都会留下一个
    // defunct bash —— 配合前端 backend_status 在 dev 模式恒返回 stopped、每 15s 触发
    // start_backend，导致 zombie 线性堆积、最终撞穿 RLIMIT_NPROC。
    //
    // 修复策略：
    //   1. 如果旧 child 还活着，直接复用（避免重复 fork bash → bun → 端口冲突 → exit）。
    //   2. 如果旧 child 已退出，先 try_wait / wait 把内核 zombie entry 收掉再继续。
    if let Some(mut old) = dev_guard.take() {
        match old.try_wait() {
            Ok(None) => {
                let pid = old.id();
                *dev_guard = Some(old);
                // 同步刷新 state.pid，让 backend_status 能查到 dev 后端（详见下方 pid mirror）。
                if let Ok(mut pid_guard) = state.pid.lock() {
                    *pid_guard = Some(pid);
                }
                return Ok(status_ok(pid));
            }
            Ok(Some(_)) => { /* 已退出且 try_wait 已 reap，丢弃 */ }
            Err(_) => {
                let _ = old.kill();
                let _ = old.wait();
            }
        }
    }

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

    // sidecar binary 缺失（开发期常态：未跑 `bun run build:app`）时直接拉 `bun --watch run src/index.ts`，
    // 同时通过 QUBIT_APP_ROOT/QUBIT_DATA_DIR 让 dev fallback 复用与 sidecar 模式一致的数据目录，
    // 避免来回切换时看到不同的 chat_session / workflow_run。
    //
    // **关键**：用 `bun --watch`，src/** 任何 ts 改动 → bun 自己 graceful restart，
    // 开发期不再需要"改完代码 → 手动 kill 17385 → 等 Tauri respawn"。
    // - QUBIT_BUN_WATCH=1：让后端 `/api/v1/_meta/build-info` 能告知调用方"我跑在 watch 模式"
    // - 退出 watch 模式需求：env 设 QUBIT_DEV_NO_WATCH=1 即可（hot-reload 引起 in-memory
    //   状态丢失或不希望频繁重连的场景，比如长时间跑 backtest 时）
    //
    // 把 stdout/stderr 重定向到日志文件，方便定位 bun 启动失败（之前 piped to /dev/null
    // 导致 seed 阶段崩溃时只能看到 UI 的「重启失败」无任何细节）。
    let log_path = data_dir.join("dev-backend.log");
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("open dev-backend log: {e}"))?;
    let log_file_err = log_file
        .try_clone()
        .map_err(|e| format!("clone dev-backend log: {e}"))?;

    let no_watch = std::env::var("QUBIT_DEV_NO_WATCH")
        .map(|v| v == "1" || v == "true")
        .unwrap_or(false);
    let bun_cmd = if no_watch { "bun run" } else { "bun --watch run" };
    let watch_flag = if no_watch { "0" } else { "1" };

    let child = Command::new("bash")
        .arg("-lc")
        .arg(format!(
            "PORT={} HOST=127.0.0.1 QUBIT_APP_ROOT='{}' QUBIT_DATA_DIR='{}' QUBIT_BUN_WATCH={} {} src/index.ts",
            BACKEND_PORT, app_root_str, data_dir_str, watch_flag, bun_cmd
        ))
        .current_dir("..")
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_file_err))
        .spawn()
        .map_err(|e| format!("dev bun spawn: {e}"))?;

    let pid = child.id();
    *dev_guard = Some(child);
    // Bug B 修复：dev 模式也要把 pid 镜像到 state.pid，
    // 否则 backend_status 看不到 dev 后端 → 前端 probeHealth 认为后端没起 →
    // 每 15s 都会再调一次 start_backend → 走到上面的 dev_guard.take() 分支重复入循环。
    if let Ok(mut pid_guard) = state.pid.lock() {
        *pid_guard = Some(pid);
    }
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
