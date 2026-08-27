//! Legend engine acceptance bench — mirrors `bench_acceptance.rs` for the
//! board CRNN: runs the PP-OCRv5 rec engine over the cropped legend-card
//! sample set (`training/samples/stand/图例块/`) and reports code/count/full
//! exact-match rates against the labels embedded in the filenames
//! (`img{N}_r{R}_C{C}_{CODE}_{COUNT}.png`, produced by the bake-off pipeline;
//! labels are the user-approved EasyOCR+vocab-parse outputs).
//!
//! Usage:
//!   ORT_DYLIB_PATH=<onnxruntime.dll> cargo run --release --bin legend_bench [-- <crops-dir>]
//!
//! Model resolution mirrors the server: `local_server/models/` or
//! `BEAD_LEGEND_MODEL_DIR`.

use std::collections::HashSet;
use std::path::PathBuf;

fn main() -> anyhow::Result<()> {
    let crops_dir = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("../training/samples/stand/图例块"));

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let models_dir = std::env::var("BEAD_LEGEND_MODEL_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| manifest_dir.join("models"));

    println!("[legend_bench] crops={}", crops_dir.display());
    println!("[legend_bench] models={}", models_dir.display());

    let t0 = std::time::Instant::now();
    let mut model = bead_local_server::legend_ocr::LegendRecModel::load(&models_dir)?;
    println!(
        "[legend_bench] model loaded ({:.1}s), dict chars={}",
        t0.elapsed().as_secs_f32(),
        model.chars.len()
    );

    // mard vocabulary from the color library (same source as main.rs)
    let library_path = std::env::var("BEAD_LIBRARY_PATH")
        .unwrap_or_else(|_| "../artifacts/colors/library.json".to_string());
    let lib_raw = std::fs::read_to_string(&library_path)?;
    let mard: HashSet<String> = serde_json::from_str::<Vec<serde_json::Value>>(&lib_raw)?
        .into_iter()
        .filter(|v| v.get("brand").and_then(|b| b.as_str()) == Some("mard"))
        .filter_map(|v| v.get("code").and_then(|c| c.as_str()).map(String::from))
        .collect();
    println!("[legend_bench] mard codes={}", mard.len());

    // GT from filenames
    let gt_re = |name: &str| -> Option<(String, String)> {
        // img{N}_r{R}_c{C}_{CODE}_{COUNT}.png
        let stem = name.strip_suffix(".png")?;
        let mut it = stem.rsplitn(3, '_');
        let count = it.next()?.to_string();
        let code = it.next()?.to_string();
        let prefix = it.next()?;
        if !prefix.starts_with("img") || !code.chars().all(|c| c.is_ascii_alphanumeric()) {
            return None;
        }
        if !count.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        Some((code, count))
    };

    let mut files: Vec<PathBuf> = std::fs::read_dir(&crops_dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("img") && n.ends_with(".png"))
                .unwrap_or(false)
        })
        .collect();
    files.sort();
    if files.is_empty() {
        anyhow::bail!("no img*.png crops under {}", crops_dir.display());
    }

    let mut rows: Vec<String> = Vec::new();
    let mut ok_code = 0usize;
    let mut ok_count = 0usize;
    let mut ok_both = 0usize;
    // legacy (single-shot) counters for the before/after comparison
    let mut leg_ok_code = 0usize;
    let mut leg_ok_count = 0usize;
    let mut leg_ok_both = 0usize;

    for path in &files {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let Some((gcode, gcount)) = gt_re(&name) else { continue };
        let img = image::open(path)?.to_rgb8();
        let (w, h) = (img.width() as usize, img.height() as usize);
        // engine expects BGR channel order (parity with cv2.imread in the
        // validated Python reference) — swap from the decoded RGB.
        let mut raw_img = img.into_raw();
        for px in raw_img.chunks_exact_mut(3) {
            px.swap(0, 2);
        }
        let (text, conf) = model.recognize(&raw_img, w, h, 0, 0, w, h, &mard)?;
        // legacy path for comparison: plain crop → preprocess → rec
        let leg_text = {
            let chw = bead_local_server::legend_ocr::preprocess_rec(&raw_img, w, h);
            let arr = ndarray::Array4::from_shape_vec((1, 3, 48, 320), chw).unwrap();
            let (t, _) = model.infer_chw(arr)?;
            t
        };
        let parsed = bead_local_server::legend_ocr::parse_card_text(&text, &mard);
        let code_ok = parsed.code.as_deref() == Some(gcode.as_str());
        let count_ok = parsed.count.map(|c| c.to_string()) == Some(gcount.clone());
        ok_code += code_ok as usize;
        ok_count += count_ok as usize;
        ok_both += (code_ok && count_ok) as usize;
        let leg_parsed = bead_local_server::legend_ocr::parse_card_text(&leg_text, &mard);
        let lcode_ok = leg_parsed.code.as_deref() == Some(gcode.as_str());
        let lcount_ok = leg_parsed.count.map(|c| c.to_string()) == Some(gcount.clone());
        leg_ok_code += lcode_ok as usize;
        leg_ok_count += lcount_ok as usize;
        leg_ok_both += (lcode_ok && lcount_ok) as usize;
        if !(code_ok && count_ok) {
            let pc = parsed.code.clone().unwrap_or_default();
            let pn = parsed.count.map(|c| c.to_string()).unwrap_or_default();
            rows.push(format!(
                "{name}\tgt={gcode}/{gcount}\tparsed={pc}/{pn}\traw={text:?}\tconf={conf:.3}"
            ));
        }
        if (lcode_ok && lcount_ok) && !(code_ok && count_ok) {
            rows.push(format!("  [regression] {name} legacy=OK enhanced=MISS"));
        }
    }

    let n = files.len();
    let pct = |k: usize| format!("{:.1}%", k as f64 * 100.0 / n as f64);
    println!("\ncards={n}");
    println!("enhanced code  {}  ({ok_code}/{n})", pct(ok_code));
    println!("enhanced count {}  ({ok_count}/{n})", pct(ok_count));
    println!("enhanced both  {}  ({ok_both}/{n})", pct(ok_both));
    println!("legacy   code  {}  ({leg_ok_code}/{n})", pct(leg_ok_code));
    println!("legacy   count {}  ({leg_ok_count}/{n})", pct(leg_ok_count));
    println!("legacy   both  {}  ({leg_ok_both}/{n})", pct(leg_ok_both));
    if !rows.is_empty() {
        println!("\nfailures:");
        for r in rows {
            println!("  {r}");
        }
    }
    Ok(())
}
