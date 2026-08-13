//! Cell crop + letterbox preprocessing — port of `ocr_core.inference._crop_cell`.
//!
//! The resize is a weighted area average that matches OpenCV `INTER_AREA`
//! to < 0.3/255 mean pixel diff on random data for up-, down- and mixed-scale
//! (verified against cv2 in 2026-08-13 probing; one code path covers both
//! zoom directions, mirroring OpenCV's area semantics).

/// Weighted area-average resize — cv2 `INTER_AREA` semantics.
///
/// Each destination pixel averages the source pixels overlapping its mapped
/// source rectangle, weighted by overlap area. `src` is row-major
/// `(src_h, src_w, channels)` f32 in [0, 255]; returns `(dst_h, dst_w, channels)`.
pub fn resize_inter_area(
    src: &[f32],
    src_w: usize,
    src_h: usize,
    dst_w: usize,
    dst_h: usize,
    channels: usize,
) -> Vec<f32> {
    debug_assert_eq!(src.len(), src_w * src_h * channels);
    let mut out = vec![0f32; dst_w * dst_h * channels];
    let xs = src_w as f64 / dst_w as f64;
    let ys = src_h as f64 / dst_h as f64;
    let mut acc = vec![0f64; channels];
    for dy in 0..dst_h {
        let sy0 = dy as f64 * ys;
        let sy1 = (dy + 1) as f64 * ys;
        let syi0 = sy0.floor() as usize;
        let syi1 = (sy1.ceil() as usize).min(src_h);
        for dx in 0..dst_w {
            let sx0 = dx as f64 * xs;
            let sx1 = (dx + 1) as f64 * xs;
            let sxi0 = sx0.floor() as usize;
            let sxi1 = (sx1.ceil() as usize).min(src_w);
            acc.fill(0.0);
            let mut wsum = 0.0f64;
            for sy in syi0..syi1 {
                let wy = ((sy + 1) as f64).min(sy1) - (sy as f64).max(sy0);
                if wy <= 0.0 {
                    continue;
                }
                let row = sy * src_w * channels;
                for sx in sxi0..sxi1 {
                    let wx = ((sx + 1) as f64).min(sx1) - (sx as f64).max(sx0);
                    if wx <= 0.0 {
                        continue;
                    }
                    let w = wx * wy;
                    wsum += w;
                    let off = row + sx * channels;
                    for ch in 0..channels {
                        acc[ch] += src[off + ch] as f64 * w;
                    }
                }
            }
            let dst_off = (dy * dst_w + dx) * channels;
            for ch in 0..channels {
                out[dst_off + ch] = (acc[ch] / wsum) as f32;
            }
        }
    }
    out
}

/// Crop a cell from an RGB image and letterbox it to `size`×`size` on a
/// white canvas — port of `ocr_core.inference._crop_cell` (color path).
///
/// `img` is row-major `(h, w, 3)` RGB f32 in [0, 255]; `(x0, y0, x1, y1)` is
/// the cell rect already 10%-inset (see `ocr_cells_from_crop`). Aspect ratio
/// is preserved, the scaled crop is centered, background is white (255).
pub fn crop_cell_letterbox(
    img: &[f32],
    img_w: usize,
    img_h: usize,
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
    size: usize,
) -> Vec<f32> {
    // Clamp to image bounds — numpy slicing clamps implicitly, Rust slices panic.
    let x0 = x0.min(img_w);
    let y0 = y0.min(img_h);
    let x1 = x1.min(img_w);
    let y1 = y1.min(img_h);
    let w = x1.saturating_sub(x0);
    let h = y1.saturating_sub(y0);
    let mut canvas = vec![255f32; size * size * 3];
    if w == 0 || h == 0 {
        return canvas;
    }
    let scale = (size as f64 / h as f64).min(size as f64 / w as f64);
    let new_h = ((h as f64 * scale).round() as usize).max(1).min(size);
    let new_w = ((w as f64 * scale).round() as usize).max(1).min(size);
    // The cell region is NOT contiguous in the image buffer (row stride is
    // img_w, not w) — copy it row by row into a compact (h, w) buffer.
    let mut cell = vec![0f32; w * h * 3];
    for row in 0..h {
        let src = ((y0 + row) * img_w + x0) * 3;
        let dst = row * w * 3;
        cell[dst..dst + w * 3].copy_from_slice(&img[src..src + w * 3]);
    }
    let resized = resize_inter_area(&cell, w, h, new_w, new_h, 3);
    let yoff = (size - new_h) / 2;
    let xoff = (size - new_w) / 2;
    for dy in 0..new_h {
        let src_off = dy * new_w * 3;
        let dst_off = ((yoff + dy) * size + xoff) * 3;
        canvas[dst_off..dst_off + new_w * 3].copy_from_slice(&resized[src_off..src_off + new_w * 3]);
    }
    canvas
}

/// Convert one letterboxed cell from HWC (48, 48, 3) to CHW (3, 48, 48)
/// and normalize /255 — matches the Python `permute(0, 3, 1, 2) / 255.0`.
///
/// Python feeds **uint8** pixels (cv2 letterbox output) into the network;
/// to match bit-exactly the float letterbox buffer is quantized to uint8
/// first (round + clamp). Skipping this made logits drift ~0.1 (LSTM
/// amplification of 0.002-level input deltas).
pub fn hwc48_to_chw(cell: &[f32]) -> Vec<f32> {
    debug_assert_eq!(cell.len(), 48 * 48 * 3);
    let mut out = vec![0f32; 3 * 48 * 48];
    for y in 0..48 {
        for x in 0..48 {
            let src = (y * 48 + x) * 3;
            for ch in 0..3 {
                let v = (cell[src + ch].round().clamp(0.0, 255.0) as u8) as f32 / 255.0;
                out[ch * 48 * 48 + y * 48 + x] = v;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn area_resize_identity() {
        let mut src = Vec::new();
        for y in 0..16 {
            for x in 0..16 {
                src.extend([x as f32, y as f32, (x + y) as f32]);
            }
        }
        let out = resize_inter_area(&src, 16, 16, 16, 16, 3);
        for i in 0..16 * 16 * 3 {
            assert!((out[i] - src[i]).abs() < 1e-6);
        }
    }

    #[test]
    fn area_resize_downscale_is_box_average() {
        // 48x48 → 24x24 with integer scale = exact 2x2 box average.
        let mut src = vec![0f32; 48 * 48 * 3];
        for i in 0..src.len() {
            src[i] = (i % 251) as f32;
        }
        let out = resize_inter_area(&src, 48, 48, 24, 24, 3);
        for dy in 0..24 {
            for dx in 0..24 {
                for ch in 0..3 {
                    let mut expect = 0f64;
                    for sy in 0..2 {
                        for sx in 0..2 {
                            expect += src[((dy * 2 + sy) * 48 + dx * 2 + sx) * 3 + ch] as f64;
                        }
                    }
                    assert!((out[(dy * 24 + dx) * 3 + ch] - (expect / 4.0) as f32).abs() < 1e-4);
                }
            }
        }
    }

    #[test]
    fn letterbox_white_canvas() {
        // Degenerate empty crop → full white canvas.
        let img = vec![0f32; 20 * 20 * 3];
        let out = crop_cell_letterbox(&img, 20, 20, 5, 5, 5, 5, 48);
        assert!(out.iter().all(|&v| v == 255.0));
    }
}
