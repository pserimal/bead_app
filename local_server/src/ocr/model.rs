//! OCR pipeline — port of `ocr_core.inference.ocr_cells_from_crop` driven by
//! an ONNX Runtime session instead of PyTorch.
//!
//! Input: full-board RGB image + user crop box + rows/cols + vocabulary.
//! Output: per-cell `(code, confidence)` with the exact same math as the
//! Python path (10% cell inset, letterbox 48×48, weighted-area resize,
//! constrained trie decode, free-path confidence, conf-merging). UNMAPPED
//! decisions stay with the caller (the job service), matching include_all=True.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::Deserialize;

use crate::ocr::decode::{build_code_trie, constrained_decode, greedy_conf, log_softmax};
use crate::ocr::preprocess::crop_cell_letterbox;

pub const CELL_SIZE: usize = 48;
pub const BATCH_SIZE: usize = 128;

#[derive(Deserialize)]
struct Manifest {
    input_name: Option<String>,
    output_name: Option<String>,
}

#[derive(Deserialize)]
struct CharsetFile {
    chars: Vec<String>,
}

#[derive(Deserialize)]
struct CodeDictFile {
    codes: Vec<String>,
}

/// Loaded ONNX model + artifact metadata (manifest/charset/code_dict).
pub struct OnnxModel {
    session: ort::session::Session,
    input_name: String,
    output_name: String,
    pub chars: Vec<String>,
    pub char_to_idx: HashMap<char, usize>,
    pub supported_codes: Vec<String>,
    /// Artifact dir name this model was loaded from (e.g. `crnn_color_mard_v8-…`).
    pub artifact_id: String,
}

/// Default intra-op threads for a standalone session (BEAD_ORT_THREADS
/// overrides; the worker pool computes its own per-slot value).
fn ort_threads() -> usize {
    std::env::var("BEAD_ORT_THREADS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|n| *n >= 1 && *n <= 64)
        .unwrap_or(4)
}

impl OnnxModel {
/// Load from an artifact dir (`model.onnx` + `manifest.json` +
    /// `charset.json` + optional `code_dict.json`), as written by
    /// `training/scripts/export_onnx.py`.
    pub fn load(artifact_dir: &Path) -> Result<Self> {
        Self::load_with_threads(artifact_dir, ort_threads())
    }

    /// Load with an explicit intra-op thread count per session (used by the
    /// worker pool so parallel jobs share the machine's cores instead of
    /// each oversubscribing).
    pub fn load_with_threads(artifact_dir: &Path, threads: usize) -> Result<Self> {
        let model_path = artifact_dir.join("model.onnx");
        if !model_path.exists() {
            bail!("model.onnx not found in {artifact_dir:?} (run export_onnx.py first)");
        }
        let manifest: Manifest = serde_json::from_str(
            &std::fs::read_to_string(artifact_dir.join("manifest.json"))
                .context("manifest.json")?,
        )?;
        let charset: CharsetFile = serde_json::from_str(
            &std::fs::read_to_string(artifact_dir.join("charset.json"))
                .context("charset.json")?,
        )?;
        let char_to_idx: HashMap<char, usize> = charset
            .chars
            .iter()
            .enumerate()
            .filter_map(|(i, s)| s.chars().next().map(|ch| (ch, i)))
            .collect();
        let supported_codes: Vec<String> = {
            let p = artifact_dir.join("code_dict.json");
            if p.exists() {
                let cd: CodeDictFile = serde_json::from_str(&std::fs::read_to_string(p)?)?;
                cd.codes
            } else {
                Vec::new()
            }
        };
        let session = ort::session::Session::builder()?
            .with_intra_threads(threads.clamp(1, 64))
            .map_err(|e| anyhow::anyhow!("ort builder: {e}"))?
            .commit_from_file(&model_path)
            .context("onnxruntime failed to load model.onnx")?;
        let artifact_id = artifact_dir
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        Ok(Self {
            session,
            input_name: manifest.input_name.unwrap_or_else(|| "images".into()),
            output_name: manifest.output_name.unwrap_or_else(|| "logits".into()),
            chars: charset.chars,
            char_to_idx,
            supported_codes,
            artifact_id,
        })
    }

    /// Run inference on a batch of preprocessed cells.
    /// `batch` is row-major (B, 3, 48, 48) f32 **already normalized /255**.
    /// Returns logits as (T, B, C) row-major.
    pub fn forward(&mut self, batch: &[f32], b: usize) -> Result<Vec<f32>> {
        let arr = ndarray::Array4::from_shape_vec((b, 3, CELL_SIZE, CELL_SIZE), batch.to_vec())?;
        let value = ort::value::Tensor::from_array(arr)?;
        let outputs = self
            .session
            .run(ort::inputs![&self.input_name => value])
            .context("onnx inference failed")?;
        let (_shape, data) = outputs
            .get(&self.output_name)
            .context("output missing")?
            .try_extract_tensor::<f32>()?;
        Ok(data.to_vec())
    }
}

/// One decoded cell result: (row, col, code, confidence).
pub type CellResult = (usize, usize, String, f32);

/// Port of `ocr_core.inference.ocr_cells_from_crop` (include_all semantics:
/// low-confidence cells are kept; the caller decides UNMAPPED).
///
/// `img_rgb` is row-major (h, w, 3) RGB f32 in [0, 255]. `bbox` is
/// (x, y, width, height) in image pixels. `mard_codes` is the mard brand
/// code list from the color library — the closed training vocabulary.
pub fn ocr_cells_from_crop(
    model: &mut OnnxModel,
    img_rgb: &[f32],
    img_w: usize,
    img_h: usize,
    rows: usize,
    cols: usize,
    bbox: (usize, usize, usize, usize),
    mard_codes: &[String],
    valid_codes: Option<&[String]>,
    // Optional progress callback invoked after each inference batch with
    // the number of cells recognized so far (for live progress display).
    progress: Option<&dyn Fn(usize)>,
) -> Result<Vec<CellResult>> {
    // Closed vocabulary: mard codes (alpha prefix + digit suffix) + BLANK,
    // intersected with the caller's valid_codes (never widened) — same as
    // ocr_core.inference.ocr_cells_from_crop.
    let train_vocab: Vec<String> = mard_codes
        .iter()
        .filter(|c| {
            let mut chars = c.chars();
            let first = chars.next().map(|ch| ch.is_ascii_alphabetic()).unwrap_or(false);
            let rest = c.get(1..).map(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).unwrap_or(false);
            first && rest
        })
        .cloned()
        .collect();
    let mut codes_set: Vec<String> = match valid_codes {
        Some(valid) => train_vocab
            .into_iter()
            .filter(|c| valid.iter().any(|v| v.eq_ignore_ascii_case(c)))
            .collect(),
        None => train_vocab,
    };
    if model.supported_codes.iter().any(|c| c == "BLANK") {
        codes_set.push("BLANK".into());
    }
    let trie = build_code_trie(&codes_set);

    let (x, y, cw, ch) = bbox;
    let x0 = x.min(img_w);
    let y0 = y.min(img_h);
    let x1 = (x + cw).min(img_w);
    let y1 = (y + ch).min(img_h);
    if x0 >= x1 || y0 >= y1 {
        return Ok(Vec::new());
    }
    let cell_w = (x1 - x0) as f64 / cols as f64;
    let cell_h = (y1 - y0) as f64 / rows as f64;

    // Crop all cells (10% inset to skip grid lines — same math as Python).
    let mut cell_imgs: Vec<Vec<f32>> = Vec::with_capacity(rows * cols);
    let mut coords: Vec<(usize, usize)> = Vec::with_capacity(rows * cols);
    for r in 0..rows {
        for c in 0..cols {
            let cy0 = clamp_round(y0 as f64 + r as f64 * cell_h, 0, img_h);
            let cx0 = clamp_round(x0 as f64 + c as f64 * cell_w, 0, img_w);
            let cy1 = clamp_round(y0 as f64 + (r + 1) as f64 * cell_h, 0, img_h);
            let cx1 = clamp_round(x0 as f64 + (c + 1) as f64 * cell_w, 0, img_w);
            let iy = ((cy1 - cy0) as f64 * 0.10).round().max(1.0) as usize;
            let ix = ((cx1 - cx0) as f64 * 0.10).round().max(1.0) as usize;
            cell_imgs.push(crop_cell_letterbox(
                img_rgb, img_w, img_h, cx0 + ix, cy0 + iy, cx1 - ix, cy1 - iy, CELL_SIZE,
            ));
            coords.push((r, c));
        }
    }

    let mut merged: HashMap<(usize, usize), (String, f32)> = HashMap::new();
    for i in (0..cell_imgs.len()).step_by(BATCH_SIZE) {
        let batch = &cell_imgs[i..(i + BATCH_SIZE).min(cell_imgs.len())];
        // (B, 48, 48, 3) → (B, 3, 48, 48) and /255.
        let mut flat = vec![0f32; batch.len() * 3 * CELL_SIZE * CELL_SIZE];
        for (bi, cell) in batch.iter().enumerate() {
            let chw = crate::ocr::preprocess::hwc48_to_chw(cell);
            flat[bi * 3 * CELL_SIZE * CELL_SIZE..(bi + 1) * 3 * CELL_SIZE * CELL_SIZE]
                .copy_from_slice(&chw);
        }
        let logits = model.forward(&flat, batch.len())?; // (T, B, C)
        let t = logits.len() / (batch.len() * model.chars.len());
        let c = model.chars.len();
        let log_probs = log_softmax(&logits, t, batch.len(), c);
        let decoded = constrained_decode(
            &log_probs, t, batch.len(), c, &trie, &model.char_to_idx, 0, 0.0,
        );
        let (greedy_codes, greedy_confs) = greedy_conf(&log_probs, t, batch.len(), c, &model.chars);

        for (j, (code, score)) in decoded.into_iter().enumerate() {
            let (r, cc) = coords[i + j];
            let greedy_code = &greedy_codes[j];
            let mut code = code;
            if !codes_set.contains(&code) && codes_set.contains(greedy_code) {
                code = greedy_code.clone();
            }
            // Drop non-complete prefixes entirely (trie walk stopping mid-code).
            if !codes_set.contains(&code) {
                continue;
            }
            let norm_conf = if greedy_code == &code {
                greedy_confs[j]
            } else {
                (score / t.max(1) as f32).exp()
            };
            // No min-conf filter: every cell is returned (include_all
            // semantics) — UNMAPPED/low-confidence decisions belong to the
            // job service caller, matching the Python worker.
            let prev = merged.get(&(r, cc));
            if prev.is_none() || norm_conf > prev.unwrap().1 {
                merged.insert((r, cc), (code, norm_conf));
            }
        }
        if let Some(f) = progress {
            f((i + batch.len()).min(rows * cols));
        }
    }

    let mut out: Vec<CellResult> = merged
        .into_iter()
        .map(|((r, c), (code, conf))| (r, c, code, conf))
        .collect();
    out.sort_by_key(|(r, c, _, _)| (*r, *c));
    Ok(out)
}

fn clamp_round(v: f64, lo: usize, hi: usize) -> usize {
    v.round().clamp(lo as f64, hi as f64) as usize
}
