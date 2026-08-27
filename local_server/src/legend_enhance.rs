//! Text-line extraction + parse-aware fusion for legend card crops.
//!
//! Direct port of the validated Python prototype
//! (`.scratch/analyze_7_v11.py`, 2026-08-27): the raw card crop fed straight
//! into rec starves the CTC decoder for time frames (T = input width / 8)
//! when the crop is a colored pill with the text occupying only its middle
//! band — e.g. "H7(1153)" on a 163×55 pill decodes to hallucinations at
//! T≈17. The fix tightens the crop to the actual text band before
//! preprocessing and fuses several views behind the mard-vocabulary parser.
//!
//! Channels (in evaluation order, early-stopped on agreement):
//! 1. `pill_band`  — locate the colored pill (saturation|dark, largest
//!    connected component), inset, background-median contrast mask,
//!    row/column projections → text band slice.
//! 2. `otsu`       — Otsu minority-polarity normalization (handles light
//!    pills with dark text) + ink projections → text band slice.
//! 3. `doc_band`   — plain dark-text mask over the whole crop (white pill
//!    cards where the pill is invisible against the page).
//! 4. `baseline`   — the untouched crop (legacy behavior, always present).
//!
//! Fusion: code = confidence-weighted vote (letter-noise views demoted,
//! baseline reading protected by a 1.25× override margin); count =
//! code-conditional vote (coherent readings first, junk-superset readings
//! can only inherit half weight) + a focused right-half re-read when the
//! count is missing or contested.
//!
//! All geometry runs on u8 buffers with no external dependencies; the only
//! reused primitive is `ocr::preprocess::resize_inter_area` (area upscale to
//! h=48 validated 9/9 on the failure set).

use std::collections::HashSet;

use crate::legend_ocr::{parse_card_text, CardParse, REC_H, REC_W};
use crate::ocr::preprocess::resize_inter_area;

// ---------------------------------------------------------------------------
// Tunables (locked by the 2026-08-27 prototype run: 9/9 on samples/7.jpg,
// 111/114 on the bake-off set vs 110 baseline)
// ---------------------------------------------------------------------------

/// Pill = saturated or non-page pixels; largest 8-connected component must
/// cover at least this fraction of the crop to count as a pill card.
const PILL_MIN_AREA_FRAC: f64 = 0.30;
/// Pill inset fractions (drops the rounded corners before contrast work).
const PILL_INSET_H: f64 = 0.13;
const PILL_INSET_W: f64 = 0.04;
/// |gray − background| threshold for the text-contrast mask.
const CONTRAST_THRESHOLD: i16 = 36;
/// Otsu ramp half-width / slope for the minority-polarity normalization.
const OTSU_RAMP_OFF: f32 = 16.0;
const OTSU_RAMP_SLOPE: f32 = 20.0;
/// Demotion for code votes whose post-code text contains stray letters.
const NOISE_CODE_WEIGHT: f64 = 0.4;
/// Margin required to override the baseline (production) code reading.
const BASELINE_OVERRIDE_MARGIN: f64 = 1.1;

// ---------------------------------------------------------------------------
// Small geometry helpers
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x0: usize,
    pub y0: usize,
    pub x1: usize,
    pub y1: usize,
}

impl Rect {
    pub fn width(&self) -> usize {
        self.x1.saturating_sub(self.x0)
    }
    pub fn height(&self) -> usize {
        self.y1.saturating_sub(self.y0)
    }
}

/// Rec-weight grayscale (cv2 BGR2GRAY, rounded).
fn gray_of(crop: &[u8]) -> Vec<u8> {
    crop.chunks_exact(3)
        .map(|px| {
            let b = px[0] as f32;
            let g = px[1] as f32;
            let r = px[2] as f32;
            (0.114 * b + 0.587 * g + 0.299 * r).round().clamp(0.0, 255.0) as u8
        })
        .collect()
}

fn gray_slice(gray: &[u8], w: usize, r: Rect) -> Vec<u8> {
    let mut out = Vec::with_capacity(r.width() * r.height());
    for y in r.y0..r.y1.min(gray.len() / w.max(1)) {
        out.extend_from_slice(&gray[y * w + r.x0..y * w + r.x1]);
    }
    out
}

// ---------------------------------------------------------------------------
// Binary morphology (cv2 border semantics: dilate pads 0, erode pads set)
// ---------------------------------------------------------------------------

fn dilate(mask: &[bool], w: usize, h: usize, kw: usize, kh: usize) -> Vec<bool> {
    let px = kw / 2;
    let py = kh / 2;
    let mut out = vec![false; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut acc = false;
            'outer: for dy in 0..kh {
                let sy = y + dy;
                if sy < py || sy >= py + h {
                    continue;
                }
                for dx in 0..kw {
                    let sx = x + dx;
                    if sx < px || sx >= px + w {
                        continue;
                    }
                    if mask[(sy - py) * w + (sx - px)] {
                        acc = true;
                        break 'outer;
                    }
                }
            }
            out[y * w + x] = acc;
        }
    }
    out
}

fn erode(mask: &[bool], w: usize, h: usize, kw: usize, kh: usize) -> Vec<bool> {
    let px = kw / 2;
    let py = kh / 2;
    let mut out = vec![true; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut acc = true;
            'outer: for dy in 0..kh {
                let sy = y + dy;
                if sy < py || sy >= py + h {
                    continue;
                }
                for dx in 0..kw {
                    let sx = x + dx;
                    if sx < px || sx >= px + w {
                        continue;
                    }
                    if !mask[(sy - py) * w + (sx - px)] {
                        acc = false;
                        break 'outer;
                    }
                }
            }
            out[y * w + x] = acc;
        }
    }
    out
}

fn morph_close(mask: &[bool], w: usize, h: usize, kw: usize, kh: usize) -> Vec<bool> {
    let d = dilate(mask, w, h, kw, kh);
    erode(&d, w, h, kw, kh)
}

fn morph_open(mask: &[bool], w: usize, h: usize, kw: usize, kh: usize) -> Vec<bool> {
    let e = erode(mask, w, h, kw, kh);
    dilate(&e, w, h, kw, kh)
}

/// Largest 8-connected component of a binary mask → `(area, bbox)` or `None`.
fn largest_cc(mask: &[bool], w: usize, h: usize) -> Option<(usize, Rect)> {
    let mut visited = vec![false; w * h];
    let mut stack: Vec<(usize, usize)> = Vec::new();
    let mut best: Option<(usize, Rect)> = None;
    for sy in 0..h {
        for sx in 0..w {
            if !mask[sy * w + sx] || visited[sy * w + sx] {
                continue;
            }
            let mut area = 0usize;
            let (mut x0, mut y0, mut x1, mut y1) = (sx, sy, sx, sy);
            visited[sy * w + sx] = true;
            stack.push((sx, sy));
            while let Some((x, y)) = stack.pop() {
                area += 1;
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
                for dy in -1i64..=1 {
                    for dx in -1i64..=1 {
                        let nx = x as i64 + dx;
                        let ny = y as i64 + dy;
                        if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 {
                            continue;
                        }
                        let (nx, ny) = (nx as usize, ny as usize);
                        if mask[ny * w + nx] && !visited[ny * w + nx] {
                            visited[ny * w + nx] = true;
                            stack.push((nx, ny));
                        }
                    }
                }
            }
            let rect = Rect { x0, y0, x1: x1 + 1, y1: y1 + 1 };
            if best.map_or(true, |(ba, _)| area > ba) {
                best = Some((area, rect));
            }
        }
    }
    best
}

// ---------------------------------------------------------------------------
// Pill location + normalization
// ---------------------------------------------------------------------------

/// Locate the colored pill: pixels that are saturated (>30 spread) or darker
/// than the page (<228), closed 5×5; largest component. Returns bbox + area
/// fraction, or `None` when the crop has no ink at all.
fn locate_pill(crop: &[u8], gray: &[u8], w: usize, h: usize) -> Option<(Rect, f64)> {
    let mut mask = vec![false; w * h];
    for i in 0..w * h {
        let b = crop[i * 3] as i16;
        let g = crop[i * 3 + 1] as i16;
        let r = crop[i * 3 + 2] as i16;
        let sat = (b.max(g).max(r) - b.min(g).min(r)) > 30;
        mask[i] = sat || gray[i] < 228;
    }
    let mask = morph_close(&mask, w, h, 5, 5);
    let (area, rect) = largest_cc(&mask, w, h)?;
    Some((rect, area as f64 / (w * h) as f64))
}

fn inset_rect(r: Rect) -> Rect {
    let ih = (((r.height() as f64) * PILL_INSET_H) as usize).max(1);
    let iw = (((r.width() as f64) * PILL_INSET_W) as usize).max(1);
    Rect {
        x0: r.x0 + iw.min(r.width().saturating_sub(1)),
        y0: r.y0 + ih.min(r.height().saturating_sub(1)),
        x1: r.x1.saturating_sub(iw).max(r.x0 + 1),
        y1: r.y1.saturating_sub(ih).max(r.y0 + 1),
    }
}

/// 256-bin Otsu threshold (mirrors the prototype loop exactly).
pub fn otsu_threshold(gray: &[u8]) -> usize {
    let mut hist = [0f64; 256];
    for &v in gray {
        hist[v as usize] += 1.0;
    }
    let total = gray.len() as f64;
    let sum_all: f64 = hist.iter().enumerate().map(|(v, c)| v as f64 * c).sum();
    let (mut sum_b, mut w_b, mut best_th, mut best_var) = (0f64, 0f64, 0usize, -1f64);
    for th in 0..256usize {
        w_b += hist[th];
        if w_b == 0.0 {
            continue;
        }
        let w_f = total - w_b;
        if w_f == 0.0 {
            break;
        }
        sum_b += th as f64 * hist[th];
        let m_b = sum_b / w_b;
        let m_f = (sum_all - sum_b) / w_f;
        let var = w_b * w_f * (m_b - m_f) * (m_b - m_f);
        if var > best_var {
            best_var = var;
            best_th = th;
        }
    }
    best_th
}

/// Otsu minority-polarity normalization: text → 0 (black), background → 255,
/// smooth ramp against JPEG noise. `None` when the split is degenerate.
pub fn otsu_normalize(gray: &[u8]) -> Option<Vec<u8>> {
    let th = otsu_threshold(gray);
    // `otsu_threshold` splits low = g <= th (matching the cv2 `src > th`
    // high-class convention); counting lo the same way keeps pixels at the
    // threshold value on the correct side of the ramp.
    let lo = gray.iter().filter(|&&v| (v as usize) <= th).count();
    let hi = gray.len() - lo;
    if lo.min(hi) < 10 {
        return None;
    }
    let dark_is_text = lo <= hi;
    Some(
        gray.iter()
            .map(|&v| {
                let vf = v as f32;
                let t = th as f32;
                let n = if dark_is_text {
                    ((t - OTSU_RAMP_OFF - vf) / OTSU_RAMP_SLOPE).clamp(0.0, 1.0)
                } else {
                    1.0 - ((vf - (t + OTSU_RAMP_OFF)) / OTSU_RAMP_SLOPE).clamp(0.0, 1.0)
                };
                (n * 255.0).round() as u8
            })
            .collect(),
    )
}

/// Sample median (even counts interpolate, mirroring `np.median`).
pub fn median_u8(values: &[u8]) -> Option<u8> {
    if values.is_empty() {
        return None;
    }
    let mut hist = [0u32; 256];
    for &v in values {
        hist[v as usize] += 1;
    }
    let n = values.len();
    if n % 2 == 1 {
        let k = (n / 2) as u32;
        let mut acc = 0u32;
        for v in 0..256usize {
            acc += hist[v];
            if acc > k {
                return Some(v as u8);
            }
        }
        Some(255)
    } else {
        let k = (n / 2) as u32;
        let mut acc = 0u32;
        let (mut lo_v, mut hi_v) = (None, None);
        for v in 0..256usize {
            acc += hist[v];
            if lo_v.is_none() && acc >= k {
                lo_v = Some(v);
            }
            if acc >= k + 1 {
                hi_v = Some(v);
                break;
            }
        }
        let lo = lo_v.unwrap_or(255) as u32;
        let hi = hi_v.unwrap_or(255) as u32;
        Some(((lo + hi) as f64 / 2.0).round() as u8)
    }
}

// ---------------------------------------------------------------------------
// Projections → band rects
// ---------------------------------------------------------------------------

/// Background-median contrast band (colored pills): |gray − bg| > thr,
/// open 2×2, close 3×9, then row/col projection spans.
/// `bg` is the estimated background gray (255 = white page for doc mode).
fn contrast_band_rect(gray: &[u8], w: usize, h: usize, bg: u8) -> Option<Rect> {
    let mut mask = vec![false; w * h];
    for (i, &v) in gray.iter().enumerate() {
        mask[i] = (v as i16 - bg as i16).abs() > CONTRAST_THRESHOLD;
    }
    let mask = morph_open(&mask, w, h, 2, 2);
    let mask = morph_close(&mask, w, h, 9, 3);

    let mut row_ink = vec![0f64; h];
    for y in 0..h {
        let cnt = mask[y * w..(y + 1) * w].iter().filter(|&&m| m).count();
        row_ink[y] = cnt as f64 / w as f64;
    }
    let max = row_ink.iter().cloned().fold(0.0, f64::max);
    if max < 0.05 {
        return None;
    }
    let thr = max * 0.18;
    let rows: Vec<usize> = (0..h).filter(|&y| row_ink[y] >= thr).collect();
    if rows.is_empty() {
        return None;
    }
    let (rt, rb) = (*rows.first().unwrap(), *rows.last().unwrap());
    if rb.saturating_sub(rt) < 6 {
        return None;
    }
    let mut col_ink = vec![0f64; w];
    let band_h = (rb - rt + 1) as f64;
    for y in rt..=rb {
        for (x, m) in mask[y * w..(y + 1) * w].iter().enumerate() {
            if *m {
                col_ink[x] += 1.0 / band_h;
            }
        }
    }
    let cols: Vec<usize> = (0..w).filter(|&x| col_ink[x] >= 0.05).collect();
    if cols.len() < 3 {
        return None;
    }
    let (cl, cr) = (*cols.first().unwrap(), *cols.last().unwrap());
    Some(Rect {
        x0: cl.saturating_sub(6),
        y0: rt.saturating_sub(4),
        x1: (cr + 7).min(w),
        y1: (rb + 5).min(h),
    })
}

/// Ink-projection trim on a normalized (text=dark) buffer, used by the Otsu
/// channel: rows profiled over the central 88% of columns.
fn trim_text_rect(norm: &[u8], w: usize, h: usize) -> Option<Rect> {
    let ink = |v: u8| v < 128;
    let cx0 = (w * 6) / 100;
    let cx1 = (w * 94) / 100;
    let mut row_ink = vec![0f64; h];
    for y in 0..h {
        let span = cx1.saturating_sub(cx0);
        if span == 0 {
            return None;
        }
        let cnt = (cx0..cx1).filter(|&x| ink(norm[y * w + x])).count();
        row_ink[y] = cnt as f64 / span as f64;
    }
    let rows: Vec<usize> = (0..h).filter(|&y| row_ink[y] > 0.04).collect();
    if rows.len() < 4 {
        return None;
    }
    let rt = rows.first().unwrap().saturating_sub(2);
    let rb = (*rows.last().unwrap() + 3).min(h);
    if rb <= rt {
        return None;
    }
    let mut col_ink = vec![0f64; w];
    let band_h = (rb - rt) as f64;
    for y in rt..rb {
        for (x, &v) in norm[y * w..(y + 1) * w].iter().enumerate() {
            if ink(v) {
                col_ink[x] += 1.0 / band_h;
            }
        }
    }
    let cols: Vec<usize> = (0..w).filter(|&x| col_ink[x] > 0.02).collect();
    if cols.len() < 2 {
        return None;
    }
    let cl = cols.first().unwrap().saturating_sub(4);
    let cr = (*cols.last().unwrap() + 5).min(w);
    Some(Rect { x0: cl, y0: rt, x1: cr, y1: rb })
}

// ---------------------------------------------------------------------------
// View planning
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ViewKind {
    PillBand,
    Otsu,
    DocBand,
    Baseline,
}

/// One recognition view: a feed crop ready for `preprocess_rec` (band views
/// are already upscaled to h=48) plus, for bands, the slice rect in crop
/// coordinates (used by the focused count re-read).
#[derive(Debug, Clone)]
pub struct ViewPlan {
    pub kind: ViewKind,
    pub rect: Option<Rect>,
    pub feed: Vec<u8>,
    pub feed_w: usize,
    pub feed_h: usize,
}

/// Slice `rect` from `crop` (w = crop width) and area-upscale to h=48.
fn band_feed(crop: &[u8], w: usize, rect: Rect) -> (Vec<u8>, usize) {
    let tw = rect.width();
    let th = rect.height();
    let upw = ((tw as f64 * REC_H as f64 / th.max(1) as f64).round() as usize).clamp(16, REC_W);
    let mut src = vec![0f32; tw * th * 3];
    for row in 0..th {
        let s = ((rect.y0 + row) * w + rect.x0) * 3;
        let d = row * tw * 3;
        for i in 0..tw * 3 {
            src[d + i] = crop[s + i] as f32;
        }
    }
    let resized = resize_inter_area(&src, tw, th, upw, REC_H, 3);
    let out = resized
        .iter()
        .map(|&v| v.round().clamp(0.0, 255.0) as u8)
        .collect();
    (out, upw)
}

/// Plan the recognition views for a legend card crop.
pub fn plan_views(crop: &[u8], w: usize, h: usize) -> Vec<ViewPlan> {
    let mut plans: Vec<ViewPlan> = Vec::new();
    if w == 0 || h == 0 {
        return plans;
    }
    let gray = gray_of(crop);
    let pill = locate_pill(crop, &gray, w, h);
    let pill_ok = pill.map_or(false, |(_, frac)| frac >= PILL_MIN_AREA_FRAC);
    let inner = pill.filter(|_| pill_ok).map(|(r, _)| inset_rect(r));

    // 1) pill_band — bg-median contrast inside the pill interior
    if let Some(ir) = inner {
        if ir.width() >= 20 && ir.height() >= 10 {
            let ig = gray_slice(&gray, w, ir);
            if let Some(bg) = median_u8(&ig) {
                if let Some(r) = contrast_band_rect(&ig, ir.width(), ir.height(), bg) {
                    let g = Rect {
                        x0: ir.x0 + r.x0,
                        y0: ir.y0 + r.y0,
                        x1: ir.x0 + r.x1,
                        y1: ir.y0 + r.y1,
                    };
                    if g.height() >= 7 && g.width() >= 20 {
                        let (feed, fw) = band_feed(crop, w, g);
                        plans.push(ViewPlan {
                            kind: ViewKind::PillBand,
                            rect: Some(g),
                            feed,
                            feed_w: fw,
                            feed_h: REC_H,
                        });
                    }
                }
            }
        }
    }

    // 2) otsu — minority-polarity normalization on the inner rect (or the
    //    whole crop for non-pill cards), then ink trim
    let work = inner.unwrap_or(Rect { x0: 0, y0: 0, x1: w, y1: h });
    if work.width() >= 24 && work.height() >= 12 {
        let wg = gray_slice(&gray, w, work);
        if let Some(norm) = otsu_normalize(&wg) {
            if let Some(r) = trim_text_rect(&norm, work.width(), work.height()) {
                let g = Rect {
                    x0: work.x0 + r.x0,
                    y0: work.y0 + r.y0,
                    x1: work.x0 + r.x1,
                    y1: work.y0 + r.y1,
                };
                if g.height() >= 6 && g.width() >= 24 {
                    // feed from the normalized buffer (gray → 3ch)
                    let mut norm_crop = Vec::with_capacity(g.width() * g.height() * 3);
                    for y in g.y0..g.y1 {
                        for x in g.x0..g.x1 {
                            let v = norm[(y - work.y0) * work.width() + (x - work.x0)];
                            norm_crop.extend_from_slice(&[v, v, v]);
                        }
                    }
                    let (feed, fw) = band_feed(&norm_crop, g.width(), Rect {
                        x0: 0,
                        y0: 0,
                        x1: g.width(),
                        y1: g.height(),
                    });
                    plans.push(ViewPlan {
                        kind: ViewKind::Otsu,
                        rect: Some(g),
                        feed,
                        feed_w: fw,
                        feed_h: REC_H,
                    });
                }
            }
        }
    }

    // 3) doc_band — dark-text mask over the whole crop (white pill cards)
    if let Some(r) = contrast_band_rect(&gray, w, h, 255) {
        if r.height() >= 7 && r.width() >= 20 {
            let (feed, fw) = band_feed(crop, w, r);
            plans.push(ViewPlan {
                kind: ViewKind::DocBand,
                rect: Some(r),
                feed,
                feed_w: fw,
                feed_h: REC_H,
            });
        }
    }

    // 4) baseline — the untouched crop (legacy behavior)
    plans.push(ViewPlan {
        kind: ViewKind::Baseline,
        rect: None,
        feed: crop.to_vec(),
        feed_w: w,
        feed_h: h,
    });
    plans
}

/// Build the focused count re-read feed: the right half of the best band
/// slice (band views whose parsed code matches the fused winner first, then
/// by confidence). Count digits sit at the line end, so a half-width crop
/// doubles their effective resolution.
pub fn focused_count_feed(
    crop: &[u8],
    w: usize,
    reads: &[ViewRead],
    fused: &Fused,
) -> Option<(Vec<u8>, usize)> {
    let Some(code) = &fused.code else { return None };
    let best = reads
        .iter()
        .filter(|r| r.rect.is_some())
        .max_by(|a, b| {
            let a_match = a.parse.code.as_deref() == Some(code.as_str());
            let b_match = b.parse.code.as_deref() == Some(code.as_str());
            b_match.cmp(&a_match).then(a.conf.partial_cmp(&b.conf).unwrap())
        })?;
    let rect = best.rect?;
    let mid = (rect.x0 + rect.x1) / 2;
    let right = Rect { x0: mid, y0: rect.y0, x1: rect.x1, y1: rect.y1 };
    if right.width() < 12 || right.height() < 7 {
        return None;
    }
    Some(band_feed(crop, w, right))
}

// ---------------------------------------------------------------------------
// Parse-aware fusion
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ViewRead {
    pub kind: ViewKind,
    pub text: String,
    pub conf: f64,
    pub parse: CardParse,
    pub rect: Option<Rect>,
}

#[derive(Debug, Clone)]
pub struct Fused {
    pub text: String,
    pub conf: f64,
    pub code: Option<String>,
    pub count: Option<i64>,
    /// Count pool is empty or contested — run the focused re-read.
    pub needs_focus: bool,
}

fn rest_has_letters(p: &CardParse) -> bool {
    // `code_end` is a CHAR offset (see parse_card_text) — slicing by bytes
    // would panic on multi-byte noise like '个'.
    p.raw_text.chars().skip(p.code_end).any(char::is_alphabetic)
}

/// Longest digit run of `s` as a string (needed to score '14' vs '4').
fn digit_run(s: &str) -> Option<String> {
    let (mut best, mut cur) = (String::new(), String::new());
    for c in s.chars() {
        if c.is_ascii_digit() {
            cur.push(c);
        } else {
            if cur.len() > best.len() {
                best = cur.clone();
            }
            cur.clear();
        }
    }
    if cur.len() > best.len() {
        best = cur;
    }
    if best.is_empty() {
        None
    } else {
        Some(best)
    }
}

/// Fuse view reads into a single (text, conf) answer.
///
/// `focused` is the right-half count re-read: `(raw_text, conf)`; it may only
/// contribute a digit run (never a code).
pub fn fuse(reads: &[ViewRead], mard: &HashSet<String>, focused: Option<(&str, f64)>) -> Fused {
    // parse all reads
    let mut parsed: Vec<(ViewKind, String, f64, CardParse, bool)> = Vec::new();
    for r in reads {
        let p = parse_card_text(&r.text, mard);
        let coherent = !rest_has_letters(&p);
        parsed.push((r.kind, r.text.clone(), r.conf, p, coherent));
    }

    // --- code vote: conf-weighted, letter-noise views demoted ---
    let mut code_score: Vec<(String, f64, usize, f64)> = Vec::new(); // (code, score, views, max_conf)
    for (_, _, conf, p, coherent) in &parsed {
        if let Some(code) = &p.code {
            let w = if *coherent { 1.0 } else { NOISE_CODE_WEIGHT };
            match code_score.iter_mut().find(|(c, ..)| c == code) {
                Some(entry) => {
                    entry.1 += conf * w;
                    entry.2 += 1;
                    entry.3 = entry.3.max(*conf);
                }
                None => code_score.push((code.clone(), conf * w, 1, *conf)),
            }
        }
    }
    let mut gcode: Option<String> = None;
    if !code_score.is_empty() {
        let best = code_score.iter().map(|(_, s, ..)| *s).fold(0.0f64, f64::max);
        let mut cands: Vec<&(String, f64, usize, f64)> =
            code_score.iter().filter(|(_, s, ..)| *s > best - 1e-9).collect();
        cands.sort_by(|a, b| {
            b.2.cmp(&a.2)
                .then(b.3.partial_cmp(&a.3).unwrap())
                .then(a.0.cmp(&b.0))
        });
        gcode = Some(cands[0].0.clone());

        // conservatism: the baseline view is today's production behavior —
        // only override its code with a decisive margin.
        if let Some((_, _, _, bp, _)) = parsed.iter().find(|(k, ..)| *k == ViewKind::Baseline) {
            if let Some(bc) = &bp.code {
                if gcode.as_deref() != Some(bc.as_str()) {
                    let wscore = |c: &str| {
                        code_score.iter().find(|(x, ..)| x == c).map(|(_, s, ..)| *s).unwrap_or(0.0)
                    };
                    if wscore(&gcode.clone().unwrap()) < BASELINE_OVERRIDE_MARGIN * wscore(bc) {
                        gcode = Some(bc.clone());
                    }
                }
            }
        }
    }

    // --- count votes (code-conditional; coherent readings first) ---
    let mut votes: Vec<(String, f64, bool)> = Vec::new();
    if let Some(code) = &gcode {
        for (_, _, conf, p, coherent) in &parsed {
            if p.code.as_deref() == Some(code.as_str()) {
                let rest: String = p.raw_text.chars().skip(p.code_end).collect();
                if let Some(run) = digit_run(&rest) {
                    if let Ok(v) = run.parse::<i64>() {
                        if v > 0 && v <= 20000 {
                            votes.push((run, *conf, *coherent));
                        }
                    }
                }
            }
        }
    }
    if let Some((ftext, fconf)) = focused {
        if gcode.is_some() {
            let norm = ftext.to_uppercase();
            if let Some(run) = digit_run(&norm) {
                if let Ok(v) = run.parse::<i64>() {
                    if v > 0 && v <= 20000 {
                        votes.push((run, fconf, true));
                    }
                }
            }
        }
    }
    let coherent_pool: Vec<&(String, f64, bool)> = votes.iter().filter(|(_, _, c)| *c).collect();
    let pool: Vec<&(String, f64, bool)> = if coherent_pool.is_empty() {
        votes.iter().collect()
    } else {
        coherent_pool
    };

    let needs_focus = gcode.is_some()
        && focused.is_none()
        && (pool.is_empty() || {
            let mut distinct: Vec<&String> = pool.iter().map(|(s, ..)| s).collect();
            distinct.sort();
            distinct.dedup();
            distinct.len() > 1
        });

    // --- count scoring: direct majority, substring explanations half weight ---
    let mut gcnt_str: Option<String> = None;
    if !pool.is_empty() {
        let mut cands: Vec<String> = pool.iter().map(|(s, ..)| s.clone()).collect();
        cands.sort();
        cands.dedup();
        let score = |s: &str| -> f64 {
            let direct = pool.iter().filter(|(v, ..)| v == s).count() as f64;
            let explained =
                pool.iter().filter(|(v, ..)| *v != s && s.contains(v.as_str())).count() as f64;
            direct + 0.5 * explained
        };
        gcnt_str = cands
            .into_iter()
            .max_by(|a, b| {
                let sa = score(a);
                let sb = score(b);
                sa.partial_cmp(&sb)
                    .unwrap()
                    .then_with(|| {
                        let ca: f64 =
                            pool.iter().filter(|(v, ..)| v == a).map(|(_, c, _)| *c).sum();
                        let cb: f64 =
                            pool.iter().filter(|(v, ..)| v == b).map(|(_, c, _)| *c).sum();
                        ca.partial_cmp(&cb).unwrap()
                    })
                    .then_with(|| a.len().cmp(&b.len()))
            })
    }
    let gcount = gcnt_str.as_deref().and_then(|s| s.parse::<i64>().ok());

    // --- output text + confidence ---
    let (text, conf) = if let (Some(code), Some(cnt)) = (&gcode, &gcount) {
        let sup: Vec<f64> = parsed
            .iter()
            .filter(|(_, _, _, p, _)| {
                p.code.as_deref() == Some(code.as_str())
                    && match &p.count {
                        None => true,
                        Some(pc) => {
                            let pcs = pc.to_string();
                            gcnt_str.as_deref().map_or(false, |gs| {
                                pcs == gs || gs.contains(pcs.as_str()) || pcs.contains(gs)
                            })
                        }
                    }
            })
            .map(|(_, _, c, ..)| *c)
            .collect();
        let mut sup = sup;
        if let Some((_, fconf)) = focused {
            sup.push(fconf);
        }
        let conf = if sup.is_empty() { 0.0 } else { sup.iter().sum::<f64>() / sup.len() as f64 };
        (format!("{code}({cnt})"), conf)
    } else if let Some(code) = &gcode {
        let best = parsed
            .iter()
            .filter(|(_, _, _, p, _)| p.code.as_deref() == Some(code.as_str()))
            .max_by(|a, b| a.2.partial_cmp(&b.2).unwrap())
            .expect("winner code has supporters");
        (best.1.clone(), best.2)
    } else {
        let best = parsed.iter().max_by(|a, b| a.2.partial_cmp(&b.2).unwrap());
        match best {
            Some((_, text, conf, _, _)) => (text.clone(), *conf),
            None => (String::new(), 0.0),
        }
    };

    Fused { text, conf, code: gcode, count: gcount, needs_focus }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn mard() -> HashSet<String> {
        [
            "A2", "A4", "B25", "C1", "C11", "E2", "E10", "E11", "E21", "F2", "F5", "F7", "F10",
            "F23", "H2", "H5", "H7", "H22",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    }

    fn read(kind: ViewKind, text: &str, conf: f64) -> ViewRead {
        let parse = parse_card_text(text, &mard());
        ViewRead { kind, text: text.to_string(), conf, parse, rect: None }
    }

    #[test]
    fn median_u8_odd_and_even() {
        assert_eq!(median_u8(&[5, 1, 3]), Some(3));
        // even: np.median interpolates -> round((1+3)/2) = 2
        assert_eq!(median_u8(&[1, 1, 3, 3]), Some(2));
        assert_eq!(median_u8(&[]), None);
    }

    #[test]
    fn otsu_bimodal_split() {
        // Bimodal with a small mid-tone population (antialiasing/JPEG noise,
        // as in real crops) so the Otsu peak lands strictly inside the gap.
        let mut g = Vec::new();
        for i in 0..500 {
            g.push(20u8.saturating_add((i % 3) as u8));
        }
        for i in 0..40 {
            g.push(100u8.saturating_add((i % 11) as u8));
        }
        for i in 0..500 {
            g.push(220u8.saturating_add((i % 3) as u8));
        }
        let th = otsu_threshold(&g);
        assert!((30..200).contains(&th), "th={th}");
        let norm = otsu_normalize(&g).unwrap();
        // Dark-minority branch: the validated prototype emits an inverted
        // ramp (rec reads either polarity) — text goes bright, bg goes dark.
        let text_max = *norm[..500].iter().max().unwrap();
        let bg_min = *norm[540..].iter().min().unwrap();
        assert!(text_max > 200, "text_max={text_max}");
        assert!(bg_min < 100, "bg_min={bg_min}");
    }

    #[test]
    fn otsu_normalize_bright_minority_is_non_inverted() {
        // White text on dark pill: bright minority stays on the black-text
        // (document-style) polarity, like the prototype's bright branch.
        let mut g = Vec::new();
        for i in 0..500 {
            g.push(30u8.saturating_add((i % 3) as u8));
        }
        for i in 0..40 {
            g.push(120u8.saturating_add((i % 11) as u8));
        }
        for i in 0..60 {
            g.push(230u8.saturating_add((i % 3) as u8));
        }
        let norm = otsu_normalize(&g).expect("healthy bimodal split");
        let text_max = *norm[540..].iter().max().unwrap();
        let bg_max = *norm[..500].iter().max().unwrap();
        assert!(text_max < 100, "text_max={text_max}");
        assert!(bg_max > 200, "bg_max={bg_max}");
    }

    #[test]
    fn otsu_degenerate_returns_none() {
        let g = vec![128u8; 1000];
        assert!(otsu_normalize(&g).is_none());
    }

    #[test]
    fn morphology_close_fills_gaps() {
        // 5x5 with a vertical 1px gap in the middle row of ones
        let w = 5usize;
        let h = 3usize;
        let mut m = vec![false; w * h];
        for y in 0..h {
            m[y * w] = true;
            m[y * w + 4] = true;
        }
        let closed = morph_close(&m, w, h, 5, 1);
        // close with a wide kernel bridges the horizontal gap
        assert!(closed.iter().all(|&v| v));
    }

    #[test]
    fn largest_cc_picks_bigger_blob() {
        let w = 10usize;
        let h = 10usize;
        let mut m = vec![false; w * h];
        // big blob 6x6 at (0,0), small blob 2x2 at (8,8)
        for y in 0..6 {
            for x in 0..6 {
                m[y * w + x] = true;
            }
        }
        for y in 8..10 {
            for x in 8..10 {
                m[y * w + x] = true;
            }
        }
        let (area, rect) = largest_cc(&m, w, h).unwrap();
        assert_eq!(area, 36);
        assert_eq!(rect, Rect { x0: 0, y0: 0, x1: 6, y1: 6 });
    }

    #[test]
    fn contrast_band_finds_text_rows() {
        // 120x60 white page, dark text band rows 20..34, cols 10..100
        let w = 120usize;
        let h = 60usize;
        let mut g = vec![255u8; w * h];
        for y in 20..34 {
            for x in 10..100 {
                g[y * w + x] = 40;
            }
        }
        let r = contrast_band_rect(&g, w, h, 255).unwrap();
        assert!(r.y0 <= 20 && r.y1 >= 34, "rect={r:?}");
        assert!(r.x0 <= 10 && r.x1 >= 100, "rect={r:?}");
        // band should NOT cover the whole height
        assert!(r.height() < h / 2);
    }

    #[test]
    fn trim_text_rect_trims_padding() {
        // normalized buffer: text rows 5..20 in a 80x40 buffer
        let w = 80usize;
        let h = 40usize;
        let mut n = vec![255u8; w * h];
        for y in 5..20 {
            for x in 8..70 {
                n[y * w + x] = 0;
            }
        }
        let r = trim_text_rect(&n, w, h).unwrap();
        assert!(r.y0 <= 5 && r.y1 >= 20);
        assert!(r.height() <= 22, "rect={r:?}");
    }

    // ---- fusion scenarios (observed reads from samples/7.jpg + bake-off) ----

    #[test]
    fn fuse_rescues_f2_from_f23_prefix_trap() {
        // baseline/doc misreads glue code+count: '[F238' resolves as F23(8);
        // clean band views read F2(38) — consensus + margin must pick F2.
        let reads = vec![
            read(ViewKind::PillBand, "F2(38)", 0.77),
            read(ViewKind::Otsu, "F2 (38)", 0.85),
            read(ViewKind::DocBand, "[F238", 0.47),
            read(ViewKind::Baseline, "[F238", 0.47),
        ];
        let f = fuse(&reads, &mard(), None);
        assert_eq!(f.code.as_deref(), Some("F2"));
        assert_eq!(f.count, Some(38));
        assert_eq!(f.text, "F2(38)");
    }

    #[test]
    fn fuse_baseline_margin_keeps_e10_over_f10() {
        // bake-off img1_r02_c01: doc_band slice clipped the E into an F.
        let reads = vec![
            read(ViewKind::DocBand, "F10 98)", 0.68),
            read(ViewKind::Baseline, "E10 (98)", 0.64),
        ];
        let f = fuse(&reads, &mard(), None);
        assert_eq!(f.code.as_deref(), Some("E10"));
        assert_eq!(f.count, Some(98));
    }

    #[test]
    fn fuse_rejects_junk_superset_count() {
        // bake-off img4_r04_c07: doc_band misread the fullwidth paren as '4'
        // giving 4279; baseline+otsu agree on 279 — direct support wins.
        let reads = vec![
            read(ViewKind::Otsu, "H2 (279)", 0.69),
            read(ViewKind::DocBand, "H24279）", 0.87),
            read(ViewKind::Baseline, "H2（279）", 0.89),
        ];
        let f = fuse(&reads, &mard(), None);
        assert_eq!(f.code.as_deref(), Some("H2"));
        assert_eq!(f.count, Some(279));
    }

    #[test]
    fn fuse_ignores_letter_noise_code_votes() {
        // samples/7.jpg card 0: only otsu reads cleanly; the other views'
        // junk ('a2aaee' → A2, '[a28l' → A2(8)) must not outvote B25.
        let reads = vec![
            read(ViewKind::PillBand, "a2aaee", 0.34),
            read(ViewKind::Otsu, "B25 (28)", 0.83),
            read(ViewKind::DocBand, "[2528", 0.61),
            read(ViewKind::Baseline, "[a28l", 0.41),
        ];
        let f = fuse(&reads, &mard(), None);
        assert_eq!(f.code.as_deref(), Some("B25"));
        assert_eq!(f.count, Some(28));
    }

    #[test]
    fn fuse_white_card_via_doc_band() {
        // samples/7.jpg card 6: white pill, black text — only doc_band reads.
        let reads = vec![
            read(ViewKind::Otsu, "H2 (4Z)", 0.70),
            read(ViewKind::DocBand, "H2 (427)", 0.86),
            read(ViewKind::Baseline, "aaa", 0.33),
        ];
        let f = fuse(&reads, &mard(), None);
        assert_eq!(f.code.as_deref(), Some("H2"));
        assert_eq!(f.count, Some(427));
    }

    #[test]
    fn fuse_single_baseline_read_is_passthrough() {
        // No band views at all → fused result equals the legacy parse.
        let reads = vec![read(ViewKind::Baseline, "A4（53)", 0.95)];
        let f = fuse(&reads, &mard(), None);
        assert_eq!(f.text, "A4(53)");
        assert!(f.conf > 0.9);
    }

    #[test]
    fn fuse_focus_vote_breaks_count_conflict() {
        // bake-off img2_r03_c03-style: full reads conflict on the count;
        // the focused right-half re-read contributes (14).
        let reads = vec![
            read(ViewKind::DocBand, "E11(4)]", 0.60),
            read(ViewKind::Baseline, "c11(14", 0.50),
        ];
        let f = fuse(&reads, &mard(), Some(("(14)", 0.76)));
        assert_eq!(f.code.as_deref(), Some("E11"));
        assert_eq!(f.count, Some(14));
    }

    #[test]
    fn fuse_all_junk_stays_failed() {
        let reads = vec![
            read(ViewKind::PillBand, "三1098", 0.87),
            read(ViewKind::Otsu, "三10 (98）", 0.81),
        ];
        let f = fuse(&reads, &mard(), None);
        assert_eq!(f.code, None);
        assert_eq!(f.count, None);
    }
}
