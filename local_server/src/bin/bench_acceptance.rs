//! Acceptance-benchmark runner for the Rust OCR core — mirrors
//! `training/scripts/eval_acceptance.py` on the same fixed benchmark sets
//! (same full-library trie, same 128-batch inference, same metric math).
//!
//! Usage (from local_server/)::
//!
//!     ORT_DYLIB_PATH=<onnxruntime.dll> cargo run --release --bin bench_acceptance
//!
//! Each set's blank_acc/code_acc/overall must stay within TOLERANCE (0.005)
//! of the Python/ONNX reference numbers recorded in docs/acceptance.md,
//! otherwise the Rust runtime is not deployed (exit 1).

use std::path::{Path, PathBuf};

use bead_local_server::ocr::decode::{build_code_trie, constrained_decode, greedy_conf, log_softmax};
use bead_local_server::ocr::preprocess::{crop_cell_letterbox, hwc48_to_chw};
use bead_local_server::ocr::OnnxModel;

const TOLERANCE: f64 = 0.005;
const REPO_ROOT: &str = "D:/projects/python/ai_dou";
const BATCH: usize = 128;

/// Port of `eval_acceptance.label_of` — code from a filename across all
/// annotation naming conventions.
fn label_of(name: &str) -> Option<String> {
    let stem = name.split('.').next().unwrap_or(name);
    let lower = stem.to_ascii_lowercase();
    if lower.starts_with("blank_") || lower.starts_with("empty_") || stem.starts_with("BLANK_") {
        return Some("BLANK".into());
    }
    let parts: Vec<&str> = stem.split('_').collect();
    if parts.len() >= 5 && parts[1].starts_with('r') && parts[2].starts_with('c') {
        return Some(parts[0].to_ascii_uppercase()); // CODE_r.._c.._h.._v..
    }
    if parts.len() >= 3 && parts[0].starts_with('r') && parts[1].starts_with('c') {
        return Some(parts[2].to_ascii_uppercase());
    }
    let cand = parts.first().map(|p| p.to_ascii_uppercase())?;
    if cand.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
        Some(cand)
    } else {
        None
    }
}

fn load_dir(cells_dir: &Path) -> Vec<(PathBuf, String)> {
    let mut items = Vec::new();
    for entry in std::fs::read_dir(cells_dir).unwrap() {
        let p = entry.unwrap().path();
        if p.extension().and_then(|e| e.to_str()) != Some("png") {
            continue;
        }
        if let Some(lab) = label_of(p.file_name().unwrap().to_str().unwrap()) {
            items.push((p, lab));
        }
    }
    items.sort_by(|a, b| a.0.cmp(&b.0));
    items
}

/// Port of `eval_cell_baseline._prep_cell` (color path) — crop whole cell,
/// letterbox 48×48.
fn prep_cell(path: &Path) -> Vec<f32> {
    let img = image::ImageReader::open(path).unwrap().decode().unwrap().to_rgb8();
    let (w, h) = (img.width() as usize, img.height() as usize);
    let mut rgb = vec![0f32; w * h * 3];
    for (i, px) in img.pixels().enumerate() {
        rgb[i * 3] = px[0] as f32;
        rgb[i * 3 + 1] = px[1] as f32;
        rgb[i * 3 + 2] = px[2] as f32;
    }
    let cell = crop_cell_letterbox(&rgb, w, h, 0, 0, w, h, 48);
    hwc48_to_chw(&cell)
}

fn main() {
    // bean-mard-v10 = 原 crnn_color_mard_v8（参考指标硬编码值来自该模型）。
    let artifact = PathBuf::from("D:/projects/python/ai_dou/artifacts/models/bean-mard-v10-2026-08-09T04-30-00Z");
    let sets = [
        PathBuf::from("D:/projects/python/ai_dou/training/samples/标注数据/1_标注结果_2026-07-29"),
        PathBuf::from("D:/projects/python/ai_dou/training/samples/标注数据/5_标注结果_2026-08-08"),
        PathBuf::from("D:/projects/python/ai_dou/training/samples/标注数据/corrections-fdaa77a1-2026-08-09"),
        PathBuf::from("D:/projects/python/ai_dou/training/samples/标注数据/4_标注结果_2026-08-08"),
    ];

    let mut model = OnnxModel::load(&artifact).expect("model load failed");
    let chars = model.chars.clone();
    let char_to_idx = model.char_to_idx.clone();

    // Full-library trie + BLANK — same as eval_acceptance.build_full_trie.
    let lib = Path::new(REPO_ROOT).join("artifacts/colors/library.json");
    let entries: Vec<serde_json::Value> =
        serde_json::from_str(&std::fs::read_to_string(lib).unwrap()).unwrap();
    let mut codes: Vec<String> = entries
        .iter()
        .filter_map(|e| e.get("code").and_then(|c| c.as_str()).map(String::from))
        .collect();
    codes.push("BLANK".into());
    codes.sort();
    codes.dedup();
    let trie = build_code_trie(&codes);

    let mut failures: Vec<String> = Vec::new();
    for set in &sets {
        let items = load_dir(set);
        if items.is_empty() {
            eprintln!("[warn] {set:?}: no labeled cells");
            continue;
        }
        let preps: Vec<Vec<f32>> = items.iter().map(|(p, _)| prep_cell(p)).collect();

        let mut blank_ok = 0u64;
        let mut code_ok = 0u64;
        let mut n_blank = 0u64;
        let mut n_code = 0u64;
        let mut blank_conf_sum = 0.0f64;
        let mut code_conf_sum = 0.0f64;
        let n_classes = chars.len();

        for i in (0..preps.len()).step_by(BATCH) {
            let batch = &preps[i..(i + BATCH).min(preps.len())];
            let mut flat = vec![0f32; batch.len() * 3 * 48 * 48];
            for (bi, prep) in batch.iter().enumerate() {
                flat[bi * 3 * 48 * 48..(bi + 1) * 3 * 48 * 48].copy_from_slice(prep);
            }
            let logits = model.forward(&flat, batch.len()).unwrap(); // (T, B, C)
            let t = logits.len() / (batch.len() * n_classes);
            let log_probs = log_softmax(&logits, t, batch.len(), n_classes);
            let decoded = constrained_decode(&log_probs, t, batch.len(), n_classes, &trie, &char_to_idx, 0, 0.0);
            let (greedy_codes, greedy_confs) = greedy_conf(&log_probs, t, batch.len(), n_classes, &chars);

            for j in 0..batch.len() {
                let (_, label) = &items[i + j];
                let code = &decoded[j].0;
                let conf = greedy_confs[j] as f64;
                if label == "BLANK" {
                    n_blank += 1;
                    if code == "BLANK" {
                        blank_ok += 1;
                    }
                    blank_conf_sum += conf;
                } else {
                    n_code += 1;
                    if code == label {
                        code_ok += 1;
                    }
                    code_conf_sum += conf;
                }
            }
        }
        let blank_acc = blank_ok as f64 / n_blank.max(1) as f64;
        let code_acc = code_ok as f64 / n_code.max(1) as f64;
        let overall = (blank_ok + code_ok) as f64 / items.len() as f64;
        let bconf = blank_conf_sum / n_blank.max(1) as f64;
        let cconf = code_conf_sum / n_code.max(1) as f64;
        let name = set.file_name().unwrap().to_str().unwrap();
        println!(
            "[{name}] n={} blank={blank_acc:.4} code={code_acc:.4} overall={overall:.4} bconf={bconf:.3} cconf={cconf:.3}",
            items.len()
        );
        // Reference numbers (Python/ONNX 1.23.2, 2026-08-13 gate run).
        let (ref_blank, ref_code, ref_overall) = match name {
            "1_标注结果_2026-07-29" => (0.0, 0.9903, 0.9903),
            "5_标注结果_2026-08-08" => (1.0, 1.0, 1.0),
            "corrections-fdaa77a1-2026-08-09" => (0.9459, 0.9957, 0.9797),
            "4_标注结果_2026-08-08" => (0.9756, 0.9846, 0.9825),
            _ => continue,
        };
        for (metric, val, refv) in [
            ("blank_acc", blank_acc, ref_blank),
            ("code_acc", code_acc, ref_code),
            ("overall", overall, ref_overall),
        ] {
            let delta = val - refv;
            if delta < -TOLERANCE {
                failures.push(format!("{name}.{metric}: {delta:+.4}"));
            }
        }
    }
    if failures.is_empty() {
        println!("GATE: PASS");
    } else {
        println!("GATE: FAIL");
        for f in &failures {
            println!("  - {f}");
        }
        std::process::exit(1);
    }
}
