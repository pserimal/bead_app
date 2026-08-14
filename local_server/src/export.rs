//! Corrections export — port of `server/.../service/ImageCropService.kt` +
//! `BlueprintController.exportCorrections`: crop each corrected cell from
//! the original image, extract dominant color + hue, zip with manifest.csv
//! in the label.html annotation format.

use std::io::Write;

use anyhow::Result;
use image::{DynamicImage, RgbImage};

use crate::models::CropBox;

/// Grid cell crop rect with the same 10%-inset math as `ocr_core.inference`
/// (three implementations share this contract: Python, Kotlin, Rust).
pub fn crop_rect(box_: &CropBox, rows: i64, cols: i64, row: i64, col: i64) -> (i64, i64, i64, i64) {
    let cell_w = box_.width as f64 / cols as f64;
    let cell_h = box_.height as f64 / rows as f64;
    let ix = ((cell_w * 0.10).floor() as i64).max(1);
    let iy = ((cell_h * 0.10).floor() as i64).max(1);
    let x0 = (box_.x as f64 + col as f64 * cell_w).floor() as i64 + ix;
    let y0 = (box_.y as f64 + row as f64 * cell_h).floor() as i64 + iy;
    let x1 = (box_.x as f64 + (col + 1) as f64 * cell_w).floor() as i64 - ix;
    let y1 = (box_.y as f64 + (row + 1) as f64 * cell_h).floor() as i64 - iy;
    (x0, y0, (x1 - x0).max(1), (y1 - y0).max(1))
}

pub fn crop_cell(
    img: &RgbImage,
    box_: &CropBox,
    rows: i64,
    cols: i64,
    row: i64,
    col: i64,
) -> RgbImage {
    let (rx, ry, rw, rh) = crop_rect(box_, rows, cols, row, col);
    let (w, h) = (img.width() as i64, img.height() as i64);
    let cx0 = rx.clamp(0, w);
    let cy0 = ry.clamp(0, h);
    let cx1 = (rx + rw).clamp(cx0, w);
    let cy1 = (ry + rh).clamp(cy0, h);
    let cw = (cx1 - cx0).max(1) as u32;
    let ch = (cy1 - cy0).max(1) as u32;
    let mut out = RgbImage::new(cw, ch);
    for y in 0..ch {
        for x in 0..cw {
            out.put_pixel(x, y, *img.get_pixel((cx0 as u32 + x).min(w as u32 - 1), (cy0 as u32 + y).min(h as u32 - 1)));
        }
    }
    out
}

/// Dominant color: downsample to 32×32, quantize to 32 levels, take the
/// mode bucket mean (same idea as board_generator; Kotlin port).
pub fn dominant_color(img: &RgbImage) -> (u8, u8, u8) {
    let small = DynamicImage::ImageRgb8(img.clone()).resize_exact(32, 32, image::imageops::FilterType::Triangle);
    let small = small.to_rgb8();
    use std::collections::HashMap;
    let mut buckets: HashMap<u32, (u64, u64, u64, u64)> = HashMap::new(); // key -> (count, r, g, b)
    for px in small.pixels() {
        let r = px[0] as u32;
        let g = px[1] as u32;
        let b = px[2] as u32;
        let key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        let e = buckets.entry(key).or_default();
        e.0 += 1;
        e.1 += r as u64;
        e.2 += g as u64;
        e.3 += b as u64;
    }
    let best = buckets.values().max_by_key(|e| e.0).unwrap();
    (
        (best.1 / best.0.max(1)) as u8,
        (best.2 / best.0.max(1)) as u8,
        (best.3 / best.0.max(1)) as u8,
    )
}

/// Standard HSV hue in degrees (matches the label tool's _hue, negatives
/// normalized); Kotlin port of ImageCropService.hueOf.
pub fn hue_of(r: u8, g: u8, b: u8) -> i64 {
    let rf = r as f32 / 255.0;
    let gf = g as f32 / 255.0;
    let bf = b as f32 / 255.0;
    let mx = rf.max(gf).max(bf);
    let mn = rf.min(gf).min(bf);
    if (mx - mn).abs() < f32::EPSILON {
        return 0;
    }
    let d = mx - mn;
    let mut h = if mx == rf {
        (gf - bf) / d % 6.0
    } else if mx == gf {
        (bf - rf) / d + 2.0
    } else {
        (rf - gf) / d + 4.0
    };
    h *= 60.0;
    if h < 0.0 {
        h += 360.0;
    }
    h.round() as i64
}

/// Build the corrections zip: manifest.csv (BOM) + one PNG per corrected cell,
/// filenames `CODE_r<row+1>_c<col+1>_h<hue>_v<bri>.png`.
pub fn build_corrections_zip(
    image: &RgbImage,
    box_: &CropBox,
    rows: i64,
    cols: i64,
    cells: &[(i64, i64, String)], // (row, col, corrected_code)
) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let mut manifest = String::from("\u{FEFF}编码,文件名,行,列,色相,亮度\n");
        for (row, col, code) in cells {
            let crop = crop_cell(image, box_, rows, cols, *row, *col);
            let (r, g, b) = dominant_color(&crop);
            let hue = hue_of(r, g, b);
            let bri = (r as i64 + g as i64 + b as i64) / 3;
            let fname = format!("{code}_r{}_c{}_h{hue}_v{bri}.png", row + 1, col + 1);
            let mut png = Vec::new();
            crop.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)?;
            zip.start_file(&fname, zip::write::SimpleFileOptions::default())?;
            zip.write_all(&png)?;
            manifest.push_str(&format!("{code},{fname},{},{},{hue},{bri}\n", row + 1, col + 1));
        }
        zip.start_file("manifest.csv", zip::write::SimpleFileOptions::default())?;
        zip.write_all(manifest.as_bytes())?;
        zip.finish()?;
    }
    Ok(buf)
}
