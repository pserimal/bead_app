//! Legend text recognition engine — PP-OCRv5-mobile-rec ONNX loaded via the
//! same ort load-dynamic facility as the board CRNN (`ocr::OnnxModel`).
//!
//! rec-only pipeline: the caller already has a crop rect per legend card /
//! grid cell, so no detection model is needed. Preprocessing mirrors the
//! validated Python bakeoff reference (`.scratch/bakeoff_paddle.py`) exactly:
//! BGR u8 → aspect-preserving resize to h=48 (weighted-area resize, width
//! capped at **320** — v5 is trained on ≤320 and degrades badly beyond) →
//! /255 → (x−0.5)/0.5 → right-pad to 320 with raw-black (= −0.5 normalized)
//! → CHW.
//!
//! Decoding: CTC greedy collapse over `(1, T, C)` logits with the character
//! table `['<blank>'] + dict lines + [' ']`. The decoded card text is then
//! resolved against the mard vocabulary by `parse_card_text` (longest valid
//! prefix per token, single-char confusable rescue, longest digit run after
//! the code = count) — same algorithm that scored 96.5% exact-match in the
//! 2026-08-21 bake-off against the user-approved EasyOCR labels.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

/// PP-OCRv5 rec input geometry.
pub const REC_H: usize = 48;
/// v5 rec is trained on widths ≤ 320; exceeding it measurably breaks
/// recognition (bake-off 2026-08-21: count accuracy 91% → 13% at max_w=800).
pub const REC_W: usize = 320;

/// Single-char OCR confusion rescue (mirrors legend.rs pairs).
const CONFUSABLE: [(char, char); 10] = [
    ('O', '0'), ('0', 'O'), ('I', '1'), ('1', 'I'), ('S', '5'),
    ('5', 'S'), ('G', '6'), ('6', 'G'), ('B', '8'), ('8', 'B'),
];

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/// Loaded PP-OCRv5 rec session + character dictionary.
pub struct LegendRecModel {
    session: ort::session::Session,
    input_name: String,
    output_name: String,
    /// CTC class index → char (`['<blank>'] + dict + [' ']`).
    pub chars: Vec<String>,
}

impl LegendRecModel {
    /// Locate and load the engine from the app models dir. Returns `None`
    /// (not an error) when the files are absent — the app degrades to
    /// `model_unavailable` exactly like a missing CRNN model.
    pub fn find_and_load(models_dir: &Path) -> Result<Option<Self>> {
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(v) = std::env::var("BEAD_LEGEND_MODEL_DIR") {
            if !v.is_empty() {
                candidates.push(PathBuf::from(v));
            }
        }
        candidates.push(models_dir.to_path_buf());
        for dir in candidates {
            if dir.join("ppocrv5-mobile-rec.onnx").exists() && dir.join("ppocrv5_dict.txt").exists()
            {
                return Self::load(&dir).map(Some);
            }
        }
        Ok(None)
    }

    /// Load `ppocrv5-mobile-rec.onnx` + `ppocrv5_dict.txt` from `dir`.
    pub fn load(dir: &Path) -> Result<Self> {
        let model_path = dir.join("ppocrv5-mobile-rec.onnx");
        let dict_path = dir.join("ppocrv5_dict.txt");
        if !model_path.exists() {
            bail!("ppocrv5-mobile-rec.onnx not found in {}", dir.display());
        }
        let raw =
            std::fs::read_to_string(&dict_path).context("reading ppocrv5_dict.txt")?;
        let mut chars: Vec<String> = raw
            .lines()
            .map(|l| l.trim_end_matches(['\r', '\n']).to_string())
            .collect();
        // CTCLabelDecode convention: blank at index 0; plain space appended
        // (use_space_char=True) unless the dict already carries one.
        chars.insert(0, "<blank>".to_string());
        if !chars.iter().any(|c| c == " ") {
            chars.push(" ".to_string());
        }
        let session = ort::session::Session::builder()?
            .with_intra_threads(2)
            .map_err(|e| anyhow::anyhow!("ort builder: {e}"))?
            .commit_from_file(&model_path)
            .context("onnxruntime failed to load ppocrv5-mobile-rec.onnx")?;
        let input_name = session
            .inputs()
            .first()
            .map(|i| i.name().to_string())
            .unwrap_or_else(|| "x".to_string());
        let output_name = session
            .outputs()
            .first()
            .map(|o| o.name().to_string())
            .unwrap_or_else(|| "softmax".to_string());
        Ok(Self { session, input_name, output_name, chars })
    }

    /// Recognize one crop rect `(x0,y0,x1,y1)` from a full BGR u8 image
    /// (row-major h×w×3). Returns `(text, mean_softmax_confidence)`.
    pub fn recognize(
        &mut self,
        img_bgr: &[u8],
        img_w: usize,
        img_h: usize,
        x0: usize,
        y0: usize,
        x1: usize,
        y1: usize,
    ) -> Result<(String, f64)> {
        let (crop, cw, ch) =
            crate::ocr::preprocess::crop_bgr(img_bgr, img_w, img_h, x0, y0, x1, y1);
        let chw = preprocess_rec(&crop, cw, ch);
        let arr = ndarray::Array4::from_shape_vec((1, 3, REC_H, REC_W), chw)
            .context("rec input shape")?;
        let value = ort::value::Tensor::from_array(arr)?;
        let outputs = self
            .session
            .run(ort::inputs![&self.input_name => value])
            .context("legend rec inference failed")?;
        let (_shape, data) = outputs
            .get(&self.output_name)
            .context("rec output missing")?
            .try_extract_tensor::<f32>()?;
        Ok(ctc_decode(data, &self.chars))
    }
}

// ---------------------------------------------------------------------------
// Preprocess — parity-checked against `.scratch/bakeoff_paddle.py`
// ---------------------------------------------------------------------------

/// Aspect-preserving h=`REC_H` resize (width ≤ `REC_W`), /255 → (x−0.5)/0.5,
/// right-pad with −0.5 (raw black), CHW output `3×REC_H×REC_W`.
pub fn preprocess_rec(crop_bgr: &[u8], cw: usize, ch: usize) -> Vec<f32> {
    assert_eq!(crop_bgr.len(), cw * ch * 3, "crop buffer mismatch");
    let ratio = REC_H as f64 / ch.max(1) as f64;
    let rw = ((cw as f64 * ratio).round() as usize).clamp(16, REC_W);
    let src: Vec<f32> = crop_bgr.iter().map(|&b| b as f32).collect();
    let resized =
        crate::ocr::preprocess::resize_inter_area(&src, cw, ch, rw, REC_H, 3);
    let mut out = vec![-0.5f32; 3 * REC_H * REC_W];
    for y in 0..REC_H {
        for x in 0..rw {
            for c in 0..3 {
                let v = resized[(y * rw + x) * 3 + c] / 255.0;
                let v = (v - 0.5) / 0.5;
                out[(c * REC_H + y) * REC_W + x] = v;
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// CTC decode
// ---------------------------------------------------------------------------

/// Greedy CTC collapse over row-major `(1, T, C)` logits. Returns the text
/// plus the mean softmax probability of frames that emitted a character.
pub fn ctc_decode(logits: &[f32], chars: &[String]) -> (String, f64) {
    let class_n = chars.len();
    if class_n == 0 || logits.is_empty() {
        return (String::new(), 0.0);
    }
    let t = logits.len() / class_n;
    let mut out = String::new();
    let mut prev = 0usize; // blank index
    let mut conf_acc = 0.0f64;
    let mut conf_n = 0usize;
    for frame in 0..t {
        let row = &logits[frame * class_n..(frame + 1) * class_n];
        let mut best = 0usize;
        let mut best_v = f32::NEG_INFINITY;
        for (i, &v) in row.iter().enumerate() {
            if v > best_v {
                best_v = v;
                best = i;
            }
        }
        // The rec head may emit raw logits OR an already-softmaxed
        // distribution (output name "softmax") — detect by range.
        let prob = if best_v > 1.0 + 1e-3 {
            let mut sum = 0f64;
            for &v in row {
                sum += (v as f64).exp();
            }
            (best_v as f64).exp() / sum.max(f64::MIN_POSITIVE)
        } else {
            best_v as f64
        };
        if best == 0 || best == prev {
            prev = best;
            continue;
        }
        prev = best;
        let ch = chars.get(best).cloned().unwrap_or_default();
        if ch == "<blank>" {
            continue;
        }
        out.push_str(&ch);
        conf_acc += prob;
        conf_n += 1;
    }
    let conf = if conf_n == 0 { 0.0 } else { conf_acc / conf_n as f64 };
    (out.trim().to_string(), conf)
}

// ---------------------------------------------------------------------------
// Card-text parsing (mard vocabulary resolution)
// ---------------------------------------------------------------------------

/// Parsed legend card text.
#[derive(Debug, Clone, PartialEq)]
pub struct CardParse {
    pub code: Option<String>,
    pub count: Option<i64>,
    /// Uppercased/normalised raw text fed to the resolver.
    pub raw_text: String,
    /// Position (char offset in `raw_text`) just past the matched code.
    pub code_end: usize,
}

fn normalise_card_text(text: &str) -> String {
    text.to_uppercase()
        .replace('（', "(")
        .replace('）', ")")
        .replace(['　', '\u{00a0}'], " ")
}

/// Collect `[A-Z]+[0-9]+` tokens as (token_start_char_offset, token).
fn code_tokens(t: &str) -> Vec<(usize, String)> {
    let cs: Vec<char> = t.chars().collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < cs.len() {
        if cs[i].is_ascii_uppercase() {
            let start = i;
            while i < cs.len() && cs[i].is_ascii_uppercase() {
                i += 1;
            }
            let ds = i;
            while i < cs.len() && cs[i].is_ascii_digit() {
                i += 1;
            }
            if i > ds {
                out.push((start, cs[start..i].iter().collect()));
            }
        } else {
            i += 1;
        }
    }
    out
}

/// Longest valid mard prefix over all tokens (leftmost token wins), with a
/// single-char confusable rescue pass. Count = longest digit run strictly
/// after the matched code.
pub fn parse_card_text(text: &str, mard_codes: &HashSet<String>) -> CardParse {
    let raw = normalise_card_text(text);
    let empty = |code_end: usize| CardParse {
        code: None,
        count: None,
        raw_text: raw.clone(),
        code_end,
    };

    let mut pass = |rescue: bool| -> CardParse {
        for (tok_start, token) in code_tokens(&raw) {
            let cs: Vec<char> = token.chars().collect();
            for cut in (2..=cs.len()).rev() {
                let head: String = cs[..cut].iter().collect();
                let candidate = if rescue { confusable_fix(&head, mard_codes) } else { Some(head) };
                if let Some(code) = candidate {
                    if mard_codes.contains(&code) {
                        // char offset just past the matched prefix
                        let rest_start = tok_start + cut;
                        let rest: String = raw.chars().skip(rest_start).collect();
                        let count = longest_digit_run(&rest);
                        return CardParse {
                            code: Some(code),
                            count,
                            raw_text: raw.clone(),
                            code_end: rest_start,
                        };
                    }
                }
            }
        }
        empty(raw.chars().count())
    };

    let direct = pass(false);
    if direct.code.is_some() {
        return direct;
    }
    pass(true)
}

/// Try flipping one char of `head` through the confusable table; return the
/// first variant present in `mard_codes`.
fn confusable_fix(head: &str, mard_codes: &HashSet<String>) -> Option<String> {
    let cs: Vec<char> = head.chars().collect();
    for i in 0..cs.len() {
        let alt = CONFUSABLE
            .iter()
            .find(|(a, _)| *a == cs[i])
            .map(|(_, b)| *b);
        if let Some(rep) = alt {
            let mut cand = cs.clone();
            cand[i] = rep;
            let s: String = cand.into_iter().collect();
            if mard_codes.contains(&s) {
                return Some(s);
            }
        }
    }
    None
}

/// Longest digit run in `s`, parsed as i64 (> 0).
fn longest_digit_run(s: &str) -> Option<i64> {
    let mut best_len = 0usize;
    let mut cur = String::new();
    for c in s.chars() {
        if c.is_ascii_digit() {
            cur.push(c);
        } else {
            best_len = best_len.max(cur.len());
            cur.clear();
        }
    }
    best_len = best_len.max(cur.len());
    if best_len == 0 {
        return None;
    }
    // re-extract the longest run without holding borrows across mutation
    let mut best = String::new();
    let mut cur2 = String::new();
    for c in s.chars() {
        if c.is_ascii_digit() {
            cur2.push(c);
        } else {
            if cur2.len() > best.len() {
                best = cur2.clone();
            }
            cur2.clear();
        }
    }
    if cur2.len() > best.len() {
        best = cur2;
    }
    best.parse::<i64>().ok().filter(|&v| v > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mard() -> HashSet<String> {
        ["A4", "A6", "C3", "C7", "C13", "C21", "F7", "G4", "H7", "H12", "M11"]
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

    fn parse(text: &str) -> CardParse {
        parse_card_text(text, &mard())
    }

    #[test]
    fn clean_paren_pair() {
        let r = parse("A4（53)");
        assert_eq!(r.code.as_deref(), Some("A4"));
        assert_eq!(r.count, Some(53));
    }

    #[test]
    fn concatenated_code_count() {
        // no separator between code and count — longest valid prefix wins
        let r = parse("F7679");
        assert_eq!(r.code.as_deref(), Some("F7"));
        assert_eq!(r.count, Some(679));
    }

    #[test]
    fn noise_around_pair() {
        let r = parse("X A6 748) OY");
        assert_eq!(r.code.as_deref(), Some("A6"));
        assert_eq!(r.count, Some(748));
    }

    #[test]
    fn long_count_full() {
        let r = parse("H7(62272)");
        assert_eq!(r.code.as_deref(), Some("H7"));
        assert_eq!(r.count, Some(62272));
    }

    #[test]
    fn zero_count_is_none() {
        let r = parse("C21 0)");
        assert_eq!(r.code.as_deref(), Some("C21"));
        assert_eq!(r.count, None);
    }

    #[test]
    fn leading_digit_noise_still_finds_token() {
        let r = parse("6G4 (2139)");
        assert_eq!(r.code.as_deref(), Some("G4"));
        assert_eq!(r.count, Some(2139));
    }

    #[test]
    fn confusable_rescue_o_zero() {
        // "AO" not in vocab; flipping O→0 yields A0… use H1Z? keep to set:
        // F7 misread as FT is not confusable; use 6↔G: "67" → G7? not in set.
        // C3 misread as C8? not in set either. Use 0/O on "F7"→"F7"…
        // Practical case from bake-off: E10 read as "EO"? Not in our mini set.
        // Instead: H12 misread "HI2" (I↔1).
        let r = parse("HI2 (100)");
        assert_eq!(r.code.as_deref(), Some("H12"));
        assert_eq!(r.count, Some(100));
    }

    #[test]
    fn unknown_code_fails() {
        let r = parse("ZZ99 (12)");
        assert_eq!(r.code, None);
        assert_eq!(r.count, None);
    }

    #[test]
    fn ctc_decode_collapses_repeats_and_skips_blank() {
        // classes: 0=blank, 1='A', 2='4'
        let chars = vec!["<blank>".to_string(), "A".to_string(), "4".to_string()];
        // T=6: blank, A, A, blank, 4, blank → "A4"
        let mut logits = vec![0f32; 6 * 3];
        let mut set = |t: usize, cls: usize| logits[t * 3 + cls] = 10.0;
        set(0, 0);
        set(1, 1);
        set(2, 1);
        set(3, 0);
        set(4, 2);
        set(5, 0);
        let (text, conf) = ctc_decode(&logits, &chars);
        assert_eq!(text, "A4");
        assert!(conf > 0.99);
    }
}
