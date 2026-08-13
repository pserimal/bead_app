//! OCR core — Rust port of `ocr_core/` (Python) for the local-server runtime.
//!
//! Pipeline: board image → per-cell 10%-inset crop → letterbox 48×48
//! (cv2-INTER_AREA-equivalent resize) → ONNX Runtime CRNN → constrained
//! trie decode + free-path confidence. Parity with the Python/PyTorch path
//! is gated by `training/scripts/eval_acceptance.py` (ONNX candidates) and
//! by the parity tests in `tests/`.

pub mod decode;
pub mod model;
pub mod preprocess;

pub use model::{ocr_cells_from_crop, CellResult, OnnxModel};
