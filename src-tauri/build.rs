// build.rs
fn main() {
    // println!("cargo:rustc-link-arg=/MD");           // Force dynamic CRT
    // println!("cargo:rustc-link-arg=/NODEFAULTLIB:libcmt.lib");
    // println!("cargo:rustc-link-arg=/NODEFAULTLIB:libcmtd.lib");

    // // Optional: disable buffer security check (sometimes needed)
    // // println!("cargo:rustc-link-arg=/GS-");
    tauri_build::build()

    // println!("cargo:rerun-if-changed=build.rs");
}