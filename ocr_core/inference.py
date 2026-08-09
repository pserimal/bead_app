"""Runtime inference entrypoint for the CRNN user-crop path.

010 决议：从 `backend/app/services/bead_ocr_crnn_inference.py` 移植，去掉 `app.config`
依赖，改为显式注入；011 F1：修复置信度归一化（按平均每步 log-prob，而非 len(code)）。
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from ocr_core.bead_ocr_crnn import CRNN, build_code_trie, constrained_decode, load_checkpoint
from ocr_core.charset import CHAR_TO_IDX
from ocr_core.code_library import load_codes


def _greedy_conf(log_probs: torch.Tensor, chars: list[str]) -> tuple[list[str], list[float]]:
    """CTC collapse decode + confidence from the free (non-trie) path.

    Confidence is the mean per-step log-probability of the frames that
    actually emit a character, mapped to 0-1 via exp.  A long label such as
    BLANK gets the same treatment as a short code — the trie-forced low-
    probability frames no longer drag the score down.
    """
    preds = log_probs.argmax(dim=2).transpose(0, 1).cpu().numpy()  # (B, T)
    out: list[str] = []
    confs: list[float] = []
    for b in range(preds.shape[0]):
        chars_emitted: list[str] = []
        steps: list[float] = []
        prev = -1
        for t in range(preds.shape[1]):
            idx = int(preds[b, t])
            if idx == 0:  # CTC blank
                prev = -1
                continue
            if idx != prev:
                chars_emitted.append(chars[idx])
                steps.append(float(log_probs[t, b, idx]))
            prev = idx
        if steps:
            conf = float(np.exp(np.mean(steps)))
        else:
            conf = 0.0
        out.append("".join(chars_emitted))
        confs.append(conf)
    return out, confs

_MODEL: tuple[CRNN, list[str]] | None = None
_MODEL_PATH: str | None = None


def load_runtime_model(model_path: str) -> tuple[CRNN, list[str]]:
    """Load model once (cached). Raises FileNotFoundError with helpful message."""
    global _MODEL, _MODEL_PATH
    if _MODEL is not None and _MODEL_PATH == model_path:
        return _MODEL
    ckpt_path = Path(model_path)
    if not ckpt_path.exists():
        raise FileNotFoundError(
            f"CRNN checkpoint not found at {ckpt_path}. "
            "训练产物请用 publish_checkpoint.py 发布后设置 MODEL_ARTIFACT_DIR"
        )
    _MODEL = load_checkpoint(ckpt_path, device="cpu")
    _MODEL_PATH = model_path
    return _MODEL


def _crop_cell(image_bgr, x0, y0, x1, y1, color: bool = False) -> np.ndarray:
    """Crop a cell and letterbox to (48, 48).

    Returns grayscale (48, 48) for the 1-channel CRNN, or RGB (48, 48, 3)
    for the RGB CRNN (BGR→RGB conversion so channel order matches training).
    """
    crop = image_bgr[y0:y1, x0:x1]
    if crop.size == 0:
        if color:
            return np.full((48, 48, 3), 255, dtype=np.uint8)
        return np.zeros((48, 48), dtype=np.uint8)
    if color:
        rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
        h, w = rgb.shape[:2]
        scale = min(48 / h, 48 / w) if h > 0 and w > 0 else 1.0
        new_h = max(1, int(round(h * scale)))
        new_w = max(1, int(round(w * scale)))
        resized = cv2.resize(rgb, (new_w, new_h), interpolation=cv2.INTER_AREA)
        canvas = np.full((48, 48, 3), 255, dtype=np.uint8)  # white background
        yoff = (48 - new_h) // 2
        xoff = (48 - new_w) // 2
        canvas[yoff : yoff + new_h, xoff : xoff + new_w] = resized
        return canvas
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    # Letterbox to (48, 48) preserving aspect ratio.
    h, w = gray.shape
    scale = min(48 / h, 48 / w) if h > 0 and w > 0 else 1.0
    new_h = max(1, int(round(h * scale)))
    new_w = max(1, int(round(w * scale)))
    resized = cv2.resize(gray, (new_w, new_h), interpolation=cv2.INTER_AREA)
    canvas = np.full((48, 48), 255, dtype=np.uint8)  # white background
    yoff = (48 - new_h) // 2
    xoff = (48 - new_w) // 2
    canvas[yoff : yoff + new_h, xoff : xoff + new_w] = resized
    return canvas


def _clamp(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, v))


def ocr_cells_from_crop(
    image_bgr: np.ndarray,
    user_rows: int,
    user_cols: int,
    crop_bbox: tuple[int, int, int, int],
    valid_codes: set[str] | None = None,
    min_conf: float = 0.5,
    max_workers: int = 1,
    include_all: bool = False,
) -> dict[tuple[int, int], tuple[str, float]]:
    """OCR all cells of a user crop.

    Returns ``{(row, col): (code, confidence)}``. Confidence is the mean
    per-step log-probability of the constrained-decode path, mapped to 0-1
    via ``exp`` — the fix for 011 F1 (old formula ``exp(score/len(code))``
    collapsed to ~0.002 and min_conf=0.5 rejected everything).

    ``include_all=True``：返回所有 cell（跳过 codes_set / min_conf 过滤），
    UNMAPPED 判定由调用方（Spring）完成——Python image-service 逐 cell 回调用。
    """
    import torch

    model, chars = _MODEL if _MODEL is not None else load_runtime_model(_default_model_path())
    color = getattr(model, "input_channels", 1) == 3
    # 显式字符映射：以 checkpoint 自己的 chars 为准（010 R2）
    char_to_idx = {ch: i for i, ch in enumerate(chars)}

    # Default closed vocabulary = mard codes (the only brand with full
    # synthetic training coverage) + BLANK. The checkpoint's stored code_dict
    # may contain dirty codes from an older training run, so we build the
    # inference trie from the color library's mard brand instead. Caller
    # valid_codes are intersected with this vocabulary (never widened) so
    # inference can only emit codes that have training examples.
    from ocr_core.code_library import load_library as _load_lib
    supported_codes = getattr(model, "supported_codes", frozenset())
    mard_codes = {e["code"] for e in _load_lib() if e.get("brand") == "mard"}
    train_vocab = {c for c in mard_codes
                   if c[:1].isalpha() and c[1:].isdigit() and c[1:] != ""}
    if "BLANK" in supported_codes:
        train_vocab.add("BLANK")
    if valid_codes is not None:
        codes_set = {c.upper() for c in valid_codes} & train_vocab
    else:
        codes_set = set(train_vocab)
    trie = build_code_trie(sorted(codes_set))

    h, w = image_bgr.shape[:2]
    x, y, cw, ch = crop_bbox
    x0 = max(0, x)
    y0 = max(0, y)
    x1 = min(w, x + cw)
    y1 = min(h, y + ch)
    if x0 >= x1 or y0 >= y1:
        return {}

    cell_w = (x1 - x0) / user_cols
    cell_h = (y1 - y0) / user_rows

    cell_imgs: list[np.ndarray] = []
    coords: list[tuple[int, int]] = []
    for r in range(user_rows):
        for c in range(user_cols):
            cy0 = _clamp(int(round(y0 + r * cell_h)), 0, h)
            cx0 = _clamp(int(round(x0 + c * cell_w)), 0, w)
            cy1 = _clamp(int(round(y0 + (r + 1) * cell_h)), 0, h)
            cx1 = _clamp(int(round(x0 + (c + 1) * cell_w)), 0, w)
            # Inset slightly to skip blue grid lines.
            iy = max(1, int(round((cy1 - cy0) * 0.10)))
            ix = max(1, int(round((cx1 - cx0) * 0.10)))
            cell_imgs.append(_crop_cell(image_bgr, cx0 + ix, cy0 + iy, cx1 - ix, cy1 - iy, color=color))
            coords.append((r, c))

    batch_size = 128
    merged: dict[tuple[int, int], tuple[str, float]] = {}
    with torch.no_grad():
        for i in range(0, len(cell_imgs), batch_size):
            batch_imgs = np.stack(cell_imgs[i : i + batch_size])
            if color:
                # (B, 48, 48, 3) → (B, 3, 48, 48)
                tensor = torch.from_numpy(batch_imgs).float().permute(0, 3, 1, 2) / 255.0
            else:
                tensor = torch.from_numpy(batch_imgs).float().unsqueeze(1) / 255.0
            logits = model(tensor)  # (T, B, C)
            T = logits.shape[0]
            decoded = constrained_decode(logits, trie, char_to_idx, blank=0)
            log_probs = torch.log_softmax(logits, dim=2)
            # Free-path confidence (see _greedy_conf): a long label like BLANK
            # is scored by the frames that actually emit a character, so the
            # trie-forced low-probability frames don't drag confidence down.
            greedy_codes, greedy_confs = _greedy_conf(log_probs, chars)
            for j, (code, score) in enumerate(decoded):
                r, c = coords[i + j]
                # If the trie stopped at a prefix (e.g. ``BLA`` for BLANK),
                # prefer the free CTC decode when it completes to a valid code.
                greedy_code = greedy_codes[j] if j < len(greedy_codes) else ""
                if code not in codes_set and greedy_code in codes_set:
                    code = greedy_code
                # Drop non-complete prefixes entirely (they are not valid
                # outputs — a trie walk that stops mid-code is noise).
                if code not in codes_set:
                    continue
                if greedy_code == code:
                    # Both constrained and free paths agree — trust free conf.
                    norm_conf = greedy_confs[j]
                else:
                    # Fallback: mean per-step log-prob over the trie path.
                    norm_conf = float(np.exp(score / max(1, T)))
                if norm_conf < min_conf and not include_all:
                    continue
                prev = merged.get((r, c))
                if prev is None or norm_conf > prev[1]:
                    merged[(r, c)] = (code, norm_conf)
    return merged


def _default_model_path() -> str:
    import os

    env = os.environ.get("MODEL_ARTIFACT_DIR")
    if env:
        p = Path(env)
        if (p / "model.pt").exists():
            return str(p / "model.pt")
        return str(p)
    return str(Path(__file__).resolve().parent.parent / "artifacts" / "models" / "current" / "model.pt")
