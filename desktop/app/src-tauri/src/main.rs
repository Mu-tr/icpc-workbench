#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! ICPC 备赛工作台桌面壳：
//! - 启动时拉起同目录的 icpc-core.exe（无窗口核心，ICPC_EMBEDDED=1 不抢浏览器）
//! - 探测核心服务端口（3001-3020），把原生窗口导航到应用页面
//! - 看护循环：核心掉线自动重启并恢复连接；退出时回收核心进程
//! - 单实例：重复启动只聚焦已有窗口

mod discovery;

use std::path::PathBuf;
use std::process::Child;
use std::sync::Mutex;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

// WebviewUrl 仅在建窗（setup）使用，run 回调路径不需要
#[allow(unused_imports)]
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

const PORT_MIN: u16 = 3001;
const PORT_MAX: u16 = 3020;
/// 首次启动等待核心就绪的预算（SEA 核心冷启 1-2s，留足慢盘/杀软扫描余量）
const START_BUDGET: Duration = Duration::from_secs(60);
/// 看护循环间隔
const WATCH_INTERVAL: Duration = Duration::from_secs(10);
/// 掉线后单轮恢复预算
const RECOVER_BUDGET: Duration = Duration::from_secs(30);

/// 核心子进程句柄（退出时 kill）
type CoreHandle = Mutex<Option<Child>>;
/// 当前服务端口（None = 掉线/未就绪）
type PortState = Mutex<Option<u16>>;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(windows)]
const CORE_FILE: &str = "icpc-core.exe";
#[cfg(not(windows))]
const CORE_FILE: &str = "icpc-core";

fn core_path() -> PathBuf {
    exe_dir().join(CORE_FILE)
}

/// 用户主目录：$HOME 优先，缺失时查 getpwuid。
/// GUI 进程的环境变量不一定齐全，而数据目录必须落在应用包外，所以留一层兜底。
#[cfg(target_os = "macos")]
fn home_dir() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("HOME") {
        if !home.is_empty() {
            return Some(PathBuf::from(home));
        }
    }
    // /etc/passwd 查询免依赖；仅在 $HOME 缺失时走到
    let passwd = std::fs::read_to_string("/etc/passwd").ok()?;
    let uid = std::env::var("UID").ok()?;
    passwd
        .lines()
        .find(|line| line.split(':').nth(2) == Some(uid.as_str()))
        .and_then(|line| line.split(':').nth(5))
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
}

/// macOS 用户数据目录：
/// `~/Library/Application Support/icpc-workbench/data`。
///
/// 核心作为 sidecar 位于 `icpc-workbench.app/Contents/MacOS/`，若沿用 Windows 那种
/// 「exe 旁 data/」，用户数据会写进应用包内部——既让 .app 代码签名失效
/// （下次打开报「已损坏」，即 issue #14 的现象之一），又会在覆盖安装新版时丢数据。
/// 所以显式经 ICPC_DATA_DIR 把数据目录挪到应用包外。
#[cfg(target_os = "macos")]
fn macos_data_dir() -> Option<PathBuf> {
    Some(
        home_dir()?
            .join("Library")
            .join("Application Support")
            .join("icpc-workbench")
            .join("data"),
    )
}

/// 给核心子进程指定数据目录（macOS：挪出应用包，见 macos_data_dir 说明）。
/// 主目录彻底取不到时告警而不是静默退回包内目录——那正是要避免的故障。
#[cfg(target_os = "macos")]
fn apply_data_dir(cmd: &mut std::process::Command) {
    match macos_data_dir() {
        Some(dir) => {
            cmd.env("ICPC_DATA_DIR", dir);
        }
        None => eprintln!("[shell] 无法确定用户主目录，核心将退回应用包内数据目录（不推荐）"),
    }
}

/// 给核心子进程指定数据目录（非 macOS 无需指定：Windows 便携版就用 exe 旁 data/）。
#[cfg(not(target_os = "macos"))]
fn apply_data_dir(_cmd: &mut std::process::Command) {}

/// 拉起核心（无窗口、嵌入模式）。若核心进程仍在运行则跳过。
fn spawn_core(app: &tauri::AppHandle) {
    let core: &CoreHandle = app.state::<CoreHandle>().inner();
    let mut guard = match core.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if let Some(child) = guard.as_mut() {
        // 仍在运行 → 无需重启
        if matches!(child.try_wait(), Ok(None)) {
            return;
        }
    }
    let path = core_path();
    if !path.exists() {
        eprintln!("[shell] 未找到核心程序: {}", path.display());
        return;
    }
    let mut cmd = std::process::Command::new(&path);
    cmd.env("ICPC_EMBEDDED", "1");
    // 企业网 TLS 拦截下 Node 内置 CA 校验会失败（更新检查/下载），改走 Windows 系统证书库
    cmd.env("NODE_USE_SYSTEM_CA", "1");
    cmd.current_dir(exe_dir()); // data/ 与壳 exe 同目录，升级替换 exe 数据不丢
    apply_data_dir(&mut cmd);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    match cmd.spawn() {
        Ok(child) => {
            *guard = Some(child);
            println!("[shell] 核心已启动: {}", path.display());
        }
        Err(e) => eprintln!("[shell] 核心启动失败: {e}"),
    }
}

fn kill_core(app: &tauri::AppHandle) {
    let core: &CoreHandle = app.state::<CoreHandle>().inner();
    if let Ok(mut guard) = core.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
            println!("[shell] 核心进程已回收");
        }
    }
}

fn app_abs_url(port: u16) -> tauri::Url {
    format!("http://127.0.0.1:{port}/")
        .parse()
        .expect("合法的应用 URL")
}

fn navigate(app: &tauri::AppHandle, url: tauri::Url) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.navigate(url);
    }
}

fn navigate_loading(app: &tauri::AppHandle) {
    navigate(app, "http://tauri.localhost/loading.html".parse().unwrap());
}

fn navigate_offline(app: &tauri::AppHandle) {
    navigate(app, "http://tauri.localhost/offline.html".parse().unwrap());
}

/// 看护循环：首次启动等待就绪 → 之后每 10s 探活；
/// 掉线自动重启核心并恢复页面；恢复失败停在离线页继续重试。
async fn supervise(app: tauri::AppHandle) {
    // —— 首次启动：拉起核心并等待就绪 ——
    spawn_core(&app);
    let deadline = tokio::time::Instant::now() + START_BUDGET;
    let mut found: Option<u16> = None;
    while tokio::time::Instant::now() < deadline {
        if let Some(p) = discovery::find_server(None).await {
            found = Some(p);
            break;
        }
        // 核心可能启动即失败：补拉
        spawn_core(&app);
        tokio::time::sleep(Duration::from_millis(700)).await;
    }
    match found {
        Some(p) => {
            *app.state::<PortState>().inner().lock().unwrap() = Some(p);
            println!("[shell] 服务就绪: http://127.0.0.1:{p}/");
            navigate(&app, app_abs_url(p));
        }
        None => {
            eprintln!("[shell] 核心启动超时，进入离线页（持续重试）");
            navigate_offline(&app);
        }
    }

    // —— 看护：掉线自动恢复 ——
    loop {
        tokio::time::sleep(WATCH_INTERVAL).await;
        let current = *app.state::<PortState>().inner().lock().unwrap();
        if let Some(p) = current {
            if discovery::check(p).await {
                continue; // 正常
            }
            // 掉线：清端口，走恢复流程
            *app.state::<PortState>().inner().lock().unwrap() = None;
        }
        println!("[shell] 服务掉线，尝试自动恢复…");
        navigate_loading(&app);
        spawn_core(&app); // 已在运行则空操作
        let deadline = tokio::time::Instant::now() + RECOVER_BUDGET;
        let mut recovered: Option<u16> = None;
        while tokio::time::Instant::now() < deadline {
            if let Some(p) = discovery::find_server(None).await {
                recovered = Some(p);
                break;
            }
            spawn_core(&app);
            tokio::time::sleep(Duration::from_millis(900)).await;
        }
        match recovered {
            Some(p) => {
                *app.state::<PortState>().inner().lock().unwrap() = Some(p);
                println!("[shell] 服务已恢复: http://127.0.0.1:{p}/");
                navigate(&app, app_abs_url(p));
            }
            None => {
                navigate_offline(&app);
                eprintln!("[shell] 本轮恢复失败，下轮继续重试");
            }
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .setup(|app| {
            app.manage::<CoreHandle>(Mutex::new(None));
            app.manage::<PortState>(Mutex::new(None));

            // 先建窗显示启动页，再异步拉核心/探活（避免阻塞 setup）
            let win = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("loading.html".into()),
            )
            .title("ICPC 备赛工作台")
            .inner_size(1360.0, 860.0)
            .min_inner_size(960.0, 640.0)
            .build()?;

            let _ = win.set_focus();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                supervise(handle).await;
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关窗 = 退出软件：回收核心子进程（与网页版「关闭窗口即退出」语义一致）
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                kill_core(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                kill_core(app);
            }
        });
}
