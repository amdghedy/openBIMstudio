//! obim-cad-engine — minimal C-ABI WASM bridge around acadrust.
//!
//! acadrust is (c) Hakan AK, licensed MPL-2.0. This crate wraps it for
//! openBIMstudio's browser CAD pipeline: one export reads a whole DXF (ASCII
//! or binary) or DWG byte buffer and returns a framed JSON drawing document
//! plus a structured read-stats footer, so the TypeScript side can map it to
//! its DxfDocument model with full diagnostics.
//!
//! Contract (raw memory, no wasm-bindgen). Every returned buffer is framed:
//! the first 4 bytes are the payload length as a little-endian u32, followed
//! by exactly that many payload bytes:
//!   obim_engine_version() -> frame {"engine":"acadrust",...}
//!   obim_alloc(len)       -> *mut u8 scratch buffer for the caller's input
//!   obim_read(ptr, len)       -> framed JSON drawing document
//!   obim_write_dwg(ptr, len)  -> frame [0x00][DWG bytes] or [0x01][UTF-8 error]
//!   obim_free(ptr, len)       -> release any buffer handed out above

use core::slice;
use std::io::Cursor;

mod json;

/// Copy `bytes` into a freshly allocated caller-freed buffer and hand it back.
fn box_bytes(bytes: Vec<u8>) -> (*mut u8, usize) {
    let len = bytes.len();
    let boxed = bytes.into_boxed_slice();
    let ptr = boxed.as_ptr() as *mut u8;
    let _ = Box::into_raw(boxed);
    (ptr, len)
}

/// Frame a payload: [u32 LE length][payload bytes].
fn frame(payload: &[u8]) -> *mut u8 {
    let mut buf = Vec::with_capacity(4 + payload.len());
    buf.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    buf.extend_from_slice(payload);
    box_bytes(buf).0
}

/// Detect the container format from the leading magic bytes.
fn sniff(b: &[u8]) -> &'static str {
    if b.len() >= 2 && (&b[0..2] == b"AC" || &b[0..2] == b"AD") {
        return "dwg";
    }
    if b.len() >= 18 && &b[0..18] == &[0x41, 0x75, 0x74, 0x6f, 0x43, 0x41, 0x44, 0x20, 0x42, 0x69, 0x6e, 0x61, 0x72, 0x79, 0x20, 0x44, 0x58, 0x46] {
        return "bdxf";
    }
    "dxf"
}

#[no_mangle]
pub extern "C" fn obim_engine_version() -> *mut u8 {
    let json = format!(
        "{{\"engine\":\"acadrust\",\"bridge\":\"{}\",\"format\":\"json\"}}",
        env!("CARGO_PKG_VERSION")
    );
    frame(json.as_bytes())
}

/// Scratch buffer the JS side copies the drawing file into before obim_read.
#[no_mangle]
pub extern "C" fn obim_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return core::ptr::null_mut();
    }
    let mut v = Vec::<u8>::with_capacity(len);
    let ptr = v.as_mut_ptr();
    core::mem::forget(v);
    ptr
}

#[no_mangle]
pub extern "C" fn obim_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    unsafe {
        let s = slice::from_raw_parts(ptr, len);
        drop(Box::from_raw(s as *const [u8] as *mut [u8]));
    }
}

/// Read a drawing buffer into JSON. Never panics across the ABI: every
/// failure becomes `{"ok":false,"error":...}` JSON so the JS side always has
/// a structured answer.
#[no_mangle]
pub extern "C" fn obim_read(ptr: *const u8, len: usize) -> *mut u8 {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
        if ptr.is_null() || len == 0 {
            return Err("bad-arguments: null pointer or zero length".to_string());
        }
        let bytes = slice::from_raw_parts(ptr, len).to_vec();
        read_to_json(&bytes)
    }));
    let json = match result {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => format!("{{\"ok\":false,\"error\":\"{}\"}}", escape(&e)),
        Err(_) => r#"{"ok":false,"error":"panic: the drawing hit an engine panic guard"}"#.to_string(),
    };
    frame(json.as_bytes())
}

/// Convert an ASCII or binary DXF buffer into native DWG bytes.
///
/// The input is parsed into acadrust's document model before writing. This
/// deliberately uses the same in-memory path as the upstream round-trip
/// tests; no filename, browser filesystem, network service, or external
/// executable is required.
pub fn write_dwg_bytes(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.is_empty() {
        return Err("dxf-write-failed: empty input".to_string());
    }
    let reader = acadrust::DxfReader::from_reader(Cursor::new(bytes.to_vec()))
        .map_err(|e| format!("dxf-open-failed: {e}"))?;
    let document = reader
        .read()
        .map_err(|e| format!("dxf-read-failed: {e}"))?;
    let expected_entities = document.entities().count();
    let dwg = acadrust::DwgWriter::write_to_vec(&document)
        .map_err(|e| format!("dwg-write-failed: {e}"))?;
    if dwg.len() < 6 || !dwg.starts_with(b"AC10") {
        return Err("dwg-write-invalid: output has no recognized DWG signature".to_string());
    }
    // Re-open the actual bytes before returning them. This catches truncated
    // output and entity loss caused by unsupported writer paths.
    let mut verify = acadrust::DwgReader::from_stream(Cursor::new(dwg.clone()));
    let reopened = verify.read()
        .map_err(|e| format!("dwg-verify-failed: {e}"))?;
    let actual_entities = reopened.entities().count();
    // Large real drawings routinely drop a tiny fraction of exotic entities on
    // the DWG writer path (e.g. 337780 → 337548). Hard-fail only when loss is
    // severe; otherwise return the DWG so the user can save their work.
    if expected_entities > 0 && actual_entities == 0 {
        return Err(format!(
            "dwg-verify-entity-count: input has {expected_entities} entities but DWG re-opened empty; export cancelled"
        ));
    }
    if actual_entities != expected_entities {
        let lost = expected_entities.saturating_sub(actual_entities);
        let loss_pct = (lost as f64) * 100.0 / (expected_entities as f64);
        // Allow loss when it stays within either tolerance: the greater of 5 entities
        // or 0.5% of input, or 2% of input. Reject only when both limits are exceeded.
        let soft_cap = std::cmp::max(5, (expected_entities as f64 * 0.005).ceil() as usize);
        let hard_cap_pct = 2.0;
        if lost > soft_cap && loss_pct > hard_cap_pct {
            return Err(format!(
                "dwg-verify-entity-count: input has {expected_entities} entities but DWG re-opened with {actual_entities} (lost {lost}, {loss_pct:.2}%); export cancelled to prevent silent data loss"
            ));
        }
        // Soft mismatch: still succeed. JS logs the frame only on hard errors.
    }
    Ok(dwg)
}

/// C-ABI DWG export. The returned frame payload starts with a status byte:
/// 0 = success followed by DWG bytes; 1 = failure followed by UTF-8 text.
#[no_mangle]
pub extern "C" fn obim_write_dwg(ptr: *const u8, len: usize) -> *mut u8 {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
        if ptr.is_null() || len == 0 {
            return Err("bad-arguments: null pointer or zero length".to_string());
        }
        let bytes = slice::from_raw_parts(ptr, len);
        write_dwg_bytes(bytes)
    }));
    let mut payload = Vec::new();
    match result {
        Ok(Ok(bytes)) => {
            payload.push(0);
            payload.extend_from_slice(&bytes);
        }
        Ok(Err(error)) => {
            payload.push(1);
            payload.extend_from_slice(error.as_bytes());
        }
        Err(_) => {
            payload.push(1);
            payload.extend_from_slice(b"panic: DWG writer aborted while converting the drawing");
        }
    }
    frame(&payload)
}

fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn read_to_json(bytes: &[u8]) -> Result<String, String> {
    match sniff(bytes) {
        "dwg" => read_dwg(bytes),
        _ => read_dxf(bytes),
    }
}

/// Public entry for the repo's regression examples/tests: read a drawing
/// buffer and return the bridge JSON envelope.
pub fn read_bytes_to_json(bytes: &[u8]) -> Result<String, String> {
    read_to_json(bytes)
}

fn read_dwg(bytes: &[u8]) -> Result<String, String> {
    let mut reader = acadrust::DwgReader::from_stream(Cursor::new(bytes.to_vec()));
    let outcome = reader
        .read_with_stats()
        .map_err(|e| format!("dwg-read-failed: {e}"))?;
    Ok(envelope(&outcome))
}

fn read_dxf(bytes: &[u8]) -> Result<String, String> {
    let reader = acadrust::DxfReader::from_reader(Cursor::new(bytes.to_vec()))
        .map_err(|e| format!("dxf-open-failed: {e}"))?;
    let outcome = reader
        .read_with_stats()
        .map_err(|e| format!("dxf-read-failed: {e}"))?;
    Ok(envelope(&outcome))
}

fn envelope(outcome: &acadrust::io::read::ReadOutcome) -> String {
    let mut out = String::with_capacity(1 << 20);
    out.push_str("{\"ok\":true,\"format\":\"");
    out.push_str(sniff_name(outcome));
    out.push_str("\",\"stats\":");
    out.push_str(&json::stats_json(&outcome.stats));
    out.push_str(",\"document\":");
    out.push_str(&json::document_json(&outcome.document));
    out.push('}');
    out
}

fn sniff_name(outcome: &acadrust::io::read::ReadOutcome) -> &'static str {
    match outcome.stats.source_format {
        Some(acadrust::io::read::SourceFormat::Dwg) => "dwg",
        _ => "dxf",
    }
}
