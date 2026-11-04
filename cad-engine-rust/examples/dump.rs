//! Dump a DXF/DWG file to the bridge JSON (stdout) — used by the repo's
//! regression scripts and for local schema checks.
use std::io::Read;

fn main() {
    let path = std::env::args().nth(1).expect("usage: dump <file> [max-chars]");
    let max: usize = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(4000);
    let mut bytes = Vec::new();
    std::fs::File::open(&path)
        .and_then(|mut f| f.read_to_end(&mut bytes))
        .expect("read file");
    match obim_cad_engine::read_bytes_to_json(&bytes) {
        Ok(json) => {
            let mut n = max.min(json.len());
            while !json.is_char_boundary(n) {
                n += 1;
            }
            println!("{}", &json[..n]);
            if let Some(i) = json.find(r#""stats":"#) {
                if i > max {
                    let tail = &json[i..];
                    println!("...{}", &tail[..tail.len().min(420)]);
                }
            }
        }
        Err(e) => println!("ERROR: {e}"),
    }
}
