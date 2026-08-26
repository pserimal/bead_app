//! Single legend-box (user-selected rect) recognition core.
//!
//! Mirrors `ocr_core/legend_box.py` but in Rust for the release binary.
//! No Python/EasyOCR dependency at runtime.  The OCR engine hook is left as
//! a stub (`recognize_box` returns `model_unavailable` when no engine is
//! wired); the bbox/code/count parsing is fully implemented and tested.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Constants (keep in sync with ocr_core/legend_box.py)
// ---------------------------------------------------------------------------

pub const MIN_BOX_SIZE: f64 = 12.0;
pub const SAFE_MARGIN_RATIO: f64 = 0.03;
pub const SAFE_MARGIN_MIN_PX: f64 = 4.0;
pub const MAX_COUNT: i64 = 20000;
pub const ACCEPT_CODE_CONF: f64 = 0.60;
pub const ACCEPT_COUNT_CONF: f64 = 0.60;

const CONFUSABLE_PAIRS: &[(char, char)] = &[
    ('0', 'O'),
    ('O', '0'),
    ('1', 'I'),
    ('I', '1'),
    ('5', 'S'),
    ('S', '5'),
    ('6', 'G'),
    ('G', '6'),
    ('8', 'B'),
    ('B', '8'),
];

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct LegendBoxBbox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoxWord {
    pub text: String,
    pub confidence: f64,
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

impl BoxWord {
    pub fn x_center(&self) -> f64 {
        (self.x0 + self.x1) / 2.0
    }
    pub fn y_center(&self) -> f64 {
        (self.y0 + self.y1) / 2.0
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegendBoxResult {
    pub code: Option<String>,
    pub count: Option<i64>,
    pub raw_code: Option<String>,
    pub raw_count: Option<String>,
    pub code_confidence: Option<f64>,
    pub count_confidence: Option<f64>,
    pub overall_confidence: f64,
    pub status: String,
    #[serde(default)]
    pub candidates: HashMap<String, Vec<String>>,
    pub bbox: Option<LegendBoxBbox>,
    pub expanded_bbox: Option<LegendBoxBbox>,
    pub diagnostics: Option<String>,
}

// ---------------------------------------------------------------------------
// BBox validation / expansion
// ---------------------------------------------------------------------------

pub fn validate_bbox(bbox: &LegendBoxBbox, img_w: i64, img_h: i64) -> Result<LegendBoxBbox, &'static str> {
    if !bbox.x.is_finite() || !bbox.y.is_finite() || !bbox.width.is_finite() || !bbox.height.is_finite() {
        return Err("INVALID_BBOX_NOT_FINITE");
    }
    if bbox.width <= 0.0 || bbox.height <= 0.0 {
        return Err("INVALID_BBOX_SIZE");
    }
    if bbox.width < MIN_BOX_SIZE || bbox.height < MIN_BOX_SIZE {
        return Err("INVALID_BBOX_TOO_SMALL");
    }
    if img_w <= 0 || img_h <= 0 {
        return Err("INVALID_IMAGE_SIZE");
    }
    let iw = img_w as f64;
    let ih = img_h as f64;
    if bbox.x >= iw || bbox.y >= ih || bbox.x + bbox.width <= 0.0 || bbox.y + bbox.height <= 0.0 {
        return Err("INVALID_BBOX_OUT_OF_BOUNDS");
    }
    // Clamp partially outside
    let nx = bbox.x.clamp(0.0, iw - 1.0);
    let ny = bbox.y.clamp(0.0, ih - 1.0);
    let nw = (iw - nx).min(if bbox.x < 0.0 { bbox.width - (nx - bbox.x) } else { bbox.width }).max(1.0);
    let nh = (ih - ny).min(if bbox.y < 0.0 { bbox.height - (ny - bbox.y) } else { bbox.height }).max(1.0);
    Ok(LegendBoxBbox { x: nx, y: ny, width: nw, height: nh })
}

pub fn expand_bbox(bbox: &LegendBoxBbox, img_w: i64, img_h: i64) -> LegendBoxBbox {
    let pad_x = (bbox.width * SAFE_MARGIN_RATIO).max(SAFE_MARGIN_MIN_PX);
    let pad_y = (bbox.height * SAFE_MARGIN_RATIO).max(SAFE_MARGIN_MIN_PX);
    let iw = img_w as f64;
    let ih = img_h as f64;
    let x0 = (bbox.x - pad_x).max(0.0);
    let y0 = (bbox.y - pad_y).max(0.0);
    let x1 = (bbox.x + bbox.width + pad_x).min(iw);
    let y1 = (bbox.y + bbox.height + pad_y).min(ih);
    LegendBoxBbox { x: x0, y: y0, width: (x1 - x0).max(1.0), height: (y1 - y0).max(1.0) }
}

// ---------------------------------------------------------------------------
// Code / count helpers
// ---------------------------------------------------------------------------

/// Empty-result constructor shared by degrade paths.
pub fn legend_empty_result(
    bbox: Option<LegendBoxBbox>,
    expanded: Option<LegendBoxBbox>,
    status: &str,
    diagnostics: &str,
) -> LegendBoxResult {
    LegendBoxResult {
        code: None,
        count: None,
        raw_code: None,
        raw_count: None,
        code_confidence: None,
        count_confidence: None,
        overall_confidence: 0.0,
        status: status.to_string(),
        candidates: HashMap::new(),
        bbox,
        expanded_bbox: expanded,
        diagnostics: Some(diagnostics.to_string()),
    }
}

fn normalise_code(text: &str) -> String {
    text.to_uppercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect()
}

fn is_count_like(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() { return false; }
    if t.chars().any(|c| c.is_ascii_alphabetic()) { return false; }
    if !t.chars().any(|c| c.is_ascii_digit()) { return false; }
    if t.chars().any(|c| !c.is_ascii_digit() && c != '(' && c != ')' && c != ',' && c != '.' && !c.is_whitespace()) { return false; }
    true
}

fn parse_count(text: &str) -> Option<i64> {
    let digits: String = text.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<i64>().ok().filter(|&v| v > 0)
}

fn weighted_edit_distance(a: &str, b: &str) -> f64 {
    let ac: Vec<char> = a.chars().collect();
    let bc: Vec<char> = b.chars().collect();
    let n = ac.len();
    let m = bc.len();
    let mut dp = vec![vec![0.0; m + 1]; n + 1];
    for i in 0..=n { dp[i][0] = i as f64; }
    for j in 0..=m { dp[0][j] = j as f64; }
    for i in 1..=n {
        for j in 1..=m {
            let replace = if ac[i-1] == bc[j-1] { 0.0 }
            else if CONFUSABLE_PAIRS.contains(&(ac[i-1], bc[j-1])) { 0.15 }
            else { 1.0 };
            dp[i][j] = (dp[i-1][j] + 1.0).min(dp[i][j-1] + 1.0).min(dp[i-1][j-1] + replace);
        }
    }
    dp[n][m]
}

pub fn resolve_mard_code(text: &str, mard_codes: &HashSet<String>) -> Option<String> {
    let raw = normalise_code(text);
    if mard_codes.contains(&raw) {
        return Some(raw);
    }
    if raw.is_empty() {
        return None;
    }
    let mut ranked: Vec<(f64, String)> = mard_codes.iter().map(|c| (weighted_edit_distance(&raw, c), c.clone())).collect();
    ranked.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    if ranked.is_empty() { return None; }
    let (best_d, best) = ranked[0].clone();
    let second_d = ranked.get(1).map(|(d, _)| *d).unwrap_or(f64::INFINITY);
    if best_d <= 0.2 && best_d + 0.1 < second_d {
        Some(best)
    } else {
        None
    }
}

pub(crate) fn code_candidates(text: &str, mard_codes: &HashSet<String>, top_k: usize) -> Vec<(String, f64)> {
    let raw = normalise_code(text);
    if raw.is_empty() { return vec![]; }
    let mut ranked: Vec<(f64, String)> = mard_codes.iter().map(|c| (weighted_edit_distance(&raw, c), c.clone())).collect();
    ranked.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    ranked.into_iter().take(top_k).map(|(d, c)| (c, d)).collect()
}

// ---------------------------------------------------------------------------
// Box parsing (mirrors ocr_core.legend_box.parse_legend_box)
// ---------------------------------------------------------------------------

pub fn parse_legend_box(
    mut words: Vec<BoxWord>,
    mard_codes: &HashSet<String>,
    bbox: Option<LegendBoxBbox>,
    expanded_bbox: Option<LegendBoxBbox>,
) -> LegendBoxResult {
    if words.is_empty() {
        return LegendBoxResult {
            code: None, count: None, raw_code: None, raw_count: None,
            code_confidence: None, count_confidence: None, overall_confidence: 0.0,
            status: "recognition_failed".to_string(), candidates: HashMap::new(),
            bbox, expanded_bbox, diagnostics: Some("no OCR words in box".to_string()),
        };
    }
    words.retain(|w| !w.text.trim().is_empty());
    words.sort_by(|a, b| a.y_center().partial_cmp(&b.y_center()).unwrap().then(a.x_center().partial_cmp(&b.x_center()).unwrap()));

    // Single word containing both parts e.g. "A4(98)"
    if words.len() == 1 {
        let txt = words[0].text.clone();
        // cheap split: find code pattern + number pattern in same string
        let upper = txt.to_uppercase();
        // Try to extract via simple scan: look for code candidate inside txt
        // We do not use regex crate to keep deps minimal; brute force.
        for code in mard_codes.iter() {
            if let Some(pos) = upper.find(code) {
                let after = &upper[pos + code.len()..];
                let digits: String = after.chars().filter(|c| c.is_ascii_digit()).collect();
                if let Ok(cnt) = digits.parse::<i64>() { if cnt > 0 && cnt <= MAX_COUNT {
                    let conf = words[0].confidence;
                    let status = if conf >= ACCEPT_CODE_CONF && conf >= ACCEPT_COUNT_CONF { "accepted" } else { "needs_confirmation" };
                    return LegendBoxResult {
                        code: Some(code.clone()), count: Some(cnt),
                        raw_code: Some(txt.clone()), raw_count: Some(txt.clone()),
                        code_confidence: Some(conf), count_confidence: Some(conf), overall_confidence: conf,
                        status: status.to_string(), candidates: HashMap::new(),
                        bbox, expanded_bbox, diagnostics: None,
                    };
                }}
            }
        }
    }

    // Generic two-word adjacency handling
    if words.len() == 2 {
        let w0 = &words[0];
        let w1 = &words[1];
        let c0 = resolve_mard_code(&w0.text, mard_codes);
        let c1 = resolve_mard_code(&w1.text, mard_codes);
        let n0 = if is_count_like(&w0.text) { parse_count(&w0.text) } else { None };
        let n1 = if is_count_like(&w1.text) { parse_count(&w1.text) } else { None };
        let pairing: Option<(&BoxWord, String, f64, &BoxWord, i64, f64)> = if c0.is_some() && n1.is_some() {
            Some((w0, c0.unwrap(), w0.confidence, w1, n1.unwrap(), w1.confidence))
        } else if c1.is_some() && n0.is_some() {
            Some((w1, c1.unwrap(), w1.confidence, w0, n0.unwrap(), w0.confidence))
        } else { None };
        if let Some((cw, cc, cf, nw, nc, nf)) = pairing {
            let status = if cf < ACCEPT_CODE_CONF || nf < ACCEPT_COUNT_CONF || nc > MAX_COUNT { "needs_confirmation" } else { "accepted" };
            let mut cands = HashMap::new();
            if status != "accepted" {
                let top = code_candidates(&cw.text, mard_codes, 3);
                cands.insert("code".to_string(), top.into_iter().map(|(c, _)| c).collect());
            }
            return LegendBoxResult {
                code: Some(cc), count: Some(nc),
                raw_code: Some(cw.text.clone()), raw_count: Some(nw.text.clone()),
                code_confidence: Some(cf), count_confidence: Some(nf), overall_confidence: (cf + nf)/2.0,
                status: status.to_string(), candidates: cands,
                bbox, expanded_bbox, diagnostics: None,
            };
        }
    }

    // General: collect hits
    let mut code_hits: Vec<(usize, String, f64)> = Vec::new(); // idx, resolved, conf
    let mut count_hits: Vec<(usize, i64, f64)> = Vec::new();
    for (idx, w) in words.iter().enumerate() {
        if let Some(res) = resolve_mard_code(&w.text, mard_codes) {
            code_hits.push((idx, res, w.confidence));
        }
        if is_count_like(&w.text) {
            if let Some(cnt) = parse_count(&w.text) {
                if cnt > 0 { count_hits.push((idx, cnt, w.confidence)); }
            }
        }
    }

    // No valid code
    if code_hits.is_empty() {
        if let Some((_, cnt, cf)) = count_hits.first() {
            let mut cands = HashMap::new();
            // propose candidates from all words
            let mut all: HashMap<String, f64> = HashMap::new();
            for w in &words {
                for (cand, d) in code_candidates(&w.text, mard_codes, 1) {
                    all.entry(cand).and_modify(|e| *e = e.min(d)).or_insert(d);
                }
            }
            let mut sorted: Vec<(String, f64)> = all.into_iter().collect();
            sorted.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
            if !sorted.is_empty() {
                cands.insert("code".to_string(), sorted.into_iter().take(3).map(|(c, _)| c).collect());
                return LegendBoxResult {
                    code: None, count: Some(*cnt),
                    raw_code: Some(words[0].text.clone()), raw_count: Some(words[count_hits[0].0].text.clone()),
                    code_confidence: None, count_confidence: Some(*cf), overall_confidence: cf/2.0,
                    status: "needs_confirmation".to_string(), candidates: cands,
                    bbox, expanded_bbox, diagnostics: Some("no valid MARD code in box".to_string()),
                };
            }
        }
        return LegendBoxResult {
            code: None, count: count_hits.first().map(|(_, c, _)| *c),
            raw_code: None, raw_count: count_hits.first().map(|(idx, _, _)| words[*idx].text.clone()),
            code_confidence: None, count_confidence: count_hits.first().map(|(_, _, f)| *f),
            overall_confidence: 0.0, status: "recognition_failed".to_string(),
            candidates: HashMap::new(), bbox, expanded_bbox,
            diagnostics: Some("no valid MARD code in box".to_string()),
        };
    }

    // Best code by confidence
    code_hits.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap());
    let (best_idx, best_code, best_conf) = code_hits[0].clone();
    let best_word = &words[best_idx];

    // Best count nearest to best code
    let mut best_count: Option<(usize, i64, f64)> = None;
    let mut best_dist = f64::INFINITY;
    for (idx, cnt, cf) in &count_hits {
        if *idx == best_idx && words.len() > 1 { continue; }
        let w = &words[*idx];
        let dist = ((w.x_center() - best_word.x_center()).powi(2) + (w.y_center() - best_word.y_center()).powi(2)).sqrt();
        if dist < best_dist || (dist == best_dist && *cf > best_count.as_ref().map(|(_, _, c)| *c).unwrap_or(0.0)) {
            best_dist = dist;
            best_count = Some((*idx, *cnt, *cf));
        }
    }

    if best_count.is_none() {
        return LegendBoxResult {
            code: Some(best_code.clone()), count: None,
            raw_code: Some(best_word.text.clone()), raw_count: None,
            code_confidence: Some(best_conf), count_confidence: None, overall_confidence: best_conf/2.0,
            status: "needs_confirmation".to_string(), candidates: HashMap::new(),
            bbox, expanded_bbox, diagnostics: Some("no quantity found in box".to_string()),
        };
    }
    let (c_idx, cnt, cf) = best_count.unwrap();
    let status = if best_conf < ACCEPT_CODE_CONF || cf < ACCEPT_COUNT_CONF || cnt > MAX_COUNT { "needs_confirmation" } else { "accepted" };
    let mut cands = HashMap::new();
    if status != "accepted" {
        let top = code_candidates(&best_word.text, mard_codes, 3);
        cands.insert("code".to_string(), top.into_iter().map(|(c, _)| c).collect());
    }
    LegendBoxResult {
        code: Some(best_code), count: Some(cnt),
        raw_code: Some(best_word.text.clone()), raw_count: Some(words[c_idx].text.clone()),
        code_confidence: Some(best_conf), count_confidence: Some(cf), overall_confidence: (best_conf + cf)/2.0,
        status: status.to_string(), candidates: cands,
        bbox, expanded_bbox, diagnostics: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn mard() -> HashSet<String> { ["A4","A6","C13","H7","H12","H18","M5"].iter().map(|s| s.to_string()).collect() }

    #[test]
    fn validate_ok() {
        let b = LegendBoxBbox { x: 10.0, y: 20.0, width: 100.0, height: 80.0 };
        assert!(validate_bbox(&b, 1000, 1000).is_ok());
    }
    #[test]
    fn validate_too_small() {
        let b = LegendBoxBbox { x: 10.0, y: 10.0, width: 5.0, height: 5.0 };
        assert_eq!(validate_bbox(&b, 1000, 1000).unwrap_err(), "INVALID_BBOX_TOO_SMALL");
    }
    #[test]
    fn validate_not_finite() {
        let b = LegendBoxBbox { x: f64::NAN, y: 0.0, width: 100.0, height: 100.0 };
        assert_eq!(validate_bbox(&b, 1000, 1000).unwrap_err(), "INVALID_BBOX_NOT_FINITE");
    }
    #[test]
    fn validate_out_of_bounds() {
        let b = LegendBoxBbox { x: 2000.0, y: 2000.0, width: 100.0, height: 100.0 };
        assert_eq!(validate_bbox(&b, 1000, 1000).unwrap_err(), "INVALID_BBOX_OUT_OF_BOUNDS");
    }
    #[test]
    fn expand_clips() {
        let b = LegendBoxBbox { x: 0.0, y: 0.0, width: 100.0, height: 100.0 };
        let e = expand_bbox(&b, 1000, 1000);
        assert_eq!(e.x, 0.0);
        assert_eq!(e.y, 0.0);
        assert!(e.width > 100.0);
    }
    #[test]
    fn parse_two_words_ok() {
        let words = vec![
            BoxWord { text: "A4".into(), confidence: 0.99, x0: 0.0, y0: 0.0, x1: 20.0, y1: 20.0 },
            BoxWord { text: "(98)".into(), confidence: 0.97, x0: 30.0, y0: 0.0, x1: 60.0, y1: 20.0 },
        ];
        let r = parse_legend_box(words, &mard(), None, None);
        assert_eq!(r.code.as_deref(), Some("A4"));
        assert_eq!(r.count, Some(98));
        assert_eq!(r.status, "accepted");
    }
    #[test]
    fn parse_single_word_merged() {
        let words = vec![
            BoxWord { text: "A4(98)".into(), confidence: 0.95, x0: 0.0, y0: 0.0, x1: 40.0, y1: 20.0 },
        ];
        let r = parse_legend_box(words, &mard(), None, None);
        assert_eq!(r.code.as_deref(), Some("A4"));
        assert_eq!(r.count, Some(98));
    }
    #[test]
    fn parse_needs_confirmation_low_conf() {
        let words = vec![
            BoxWord { text: "H7".into(), confidence: 0.40, x0: 0.0, y0: 0.0, x1: 20.0, y1: 20.0 },
            BoxWord { text: "6227".into(), confidence: 0.40, x0: 30.0, y0: 0.0, x1: 60.0, y1: 20.0 },
        ];
        let r = parse_legend_box(words, &mard(), None, None);
        assert_eq!(r.status, "needs_confirmation");
    }
    #[test]
    fn parse_invalid_code() {
        let words = vec![
            BoxWord { text: "ZZ99".into(), confidence: 0.99, x0: 0.0, y0: 0.0, x1: 20.0, y1: 20.0 },
            BoxWord { text: "12".into(), confidence: 0.99, x0: 30.0, y0: 0.0, x1: 40.0, y1: 20.0 },
        ];
        let r = parse_legend_box(words, &mard(), None, None);
        // ZZ99 not in mard and not confusable -> no valid code
        assert!(r.code.is_none() || r.status != "accepted");
    }
    #[test]
    fn confusable_corrected() {
        // 8 -> B confusion: "8L2" OCR misread of "H12"? Actually test B/8 pair: "8" vs "B"
        // Use code C13 vs "C13" exact vs "CI3" with I/1 etc.
        // Mard contains H12; OCR "HI2" (I for 1) should correct to H12
        let words = vec![
            BoxWord { text: "HI2".into(), confidence: 0.90, x0: 0.0, y0: 0.0, x1: 20.0, y1: 20.0 },
            BoxWord { text: "100".into(), confidence: 0.90, x0: 30.0, y0: 0.0, x1: 50.0, y1: 20.0 },
        ];
        let r = parse_legend_box(words, &mard(), None, None);
        assert_eq!(r.code.as_deref(), Some("H12"));
    }
    #[test]
    fn count_with_comma_and_bracket() {
        let words = vec![
            BoxWord { text: "M5".into(), confidence: 0.95, x0: 0.0, y0: 0.0, x1: 20.0, y1: 20.0 },
            BoxWord { text: "(1,248)".into(), confidence: 0.95, x0: 30.0, y0: 0.0, x1: 60.0, y1: 20.0 },
        ];
        let r = parse_legend_box(words, &mard(), None, None);
        assert_eq!(r.count, Some(1248));
    }
}
