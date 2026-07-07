use std::net::SocketAddr;
use std::time::Duration;

/// Where the firehosed local API lives (docs/contracts.md, `daemon_addr`).
/// The frontend uses the same constant; keep them in sync.
pub const DAEMON_ADDR: &str = "127.0.0.1:4517";

/// True when something is listening on the daemon address. Used to decide
/// whether to spawn the bundled firehosed sidecar: a daemon the user runs
/// themselves (CLI, launchd, another shell instance) always wins.
pub fn daemon_reachable(addr: &str) -> bool {
    let Ok(sock): Result<SocketAddr, _> = addr.parse() else {
        return false;
    };
    std::net::TcpStream::connect_timeout(&sock, Duration::from_millis(300)).is_ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if daemon_reachable(DAEMON_ADDR) {
                return Ok(());
            }
            // Spawn the bundled engine. The UI stays usable immediately —
            // its health poll shows "waiting for firehosed" until the
            // sidecar answers. Note: sidecars spawned this way are cleaned
            // up when the app exits; capture then falls back to adapters'
            // direct spool appends, so no events are lost either way.
            use tauri_plugin_shell::ShellExt;
            match app.shell().sidecar("firehosed") {
                Ok(cmd) => {
                    if let Err(err) = cmd.spawn() {
                        eprintln!("firehose: could not spawn firehosed sidecar: {err}");
                    }
                }
                Err(err) => eprintln!("firehose: sidecar unavailable: {err}"),
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::daemon_reachable;
    use std::net::TcpListener;

    #[test]
    fn reachable_when_listening() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr").to_string();
        assert!(daemon_reachable(&addr));
    }

    #[test]
    fn unreachable_when_nothing_listens() {
        // Bind then drop to get a port that was just freed.
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr").to_string();
        drop(listener);
        assert!(!daemon_reachable(&addr));
    }

    #[test]
    fn garbage_addr_is_unreachable() {
        assert!(!daemon_reachable("not an address"));
    }
}
