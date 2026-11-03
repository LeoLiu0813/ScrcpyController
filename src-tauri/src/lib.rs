pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("无法启动安卓控制台");
}
