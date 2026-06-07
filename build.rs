fn main() {
    // Rebuild the Tauri binary whenever the bundled frontend artifacts
    // or their source tree change. The previous path ("ui") no longer
    // existed after the frontend moved to src-ui/, so cargo could keep
    // reusing a stale executable even though src-ui/dist had new assets.
    println!("cargo:rerun-if-changed=src-ui");
    println!("cargo:rerun-if-changed=src-ui/dist");

    tauri_build::build()
}
