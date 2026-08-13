//! bead-local-server library crate — OCR core (P1).
//!
//! Pipeline: board image → per-cell 10%-inset crop → letterbox 48×48
//! (cv2-INTER_AREA-equivalent resize) → ONNX Runtime CRNN → constrained
//! trie decode + free-path confidence. Parity with the Python/PyTorch path
//! is gated by `training/scripts/eval_acceptance.py` (ONNX candidates) and
//! by `tests/parity.rs`.

pub mod ocr;
