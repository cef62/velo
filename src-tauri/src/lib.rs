pub mod crypto;
pub mod index;
pub mod names;
pub mod store;
pub mod text;

pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running velo");
}
