fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["open_path", "prune_preview", "prune_apply"]),
    ))
    .expect("failed to run tauri-build");
}
