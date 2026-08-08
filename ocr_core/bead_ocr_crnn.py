"""CRNN model for per-cell bead-code recognition (shared training/inference core).

Architecture (classic CRNN, used in scene-text recognition):
    Input  : (B, 1, 48, 48) grayscale, the cell crop.
    CNN    : 5 conv blocks with BN + ReLU + MaxPool, collapse height to 1.
    RNN    : 2-layer Bidirectional LSTM on the width axis.
    FC     : Linear projection to num_classes (chars + CTC blank).
    Output : (T=6, B, num_classes) logits over time steps (width axis).

010 决议 R2：checkpoint 携带完整元数据（format_version / model_arch / charset_hash /
code_dict_version 等），加载时硬校验架构与字符集兼容性；解码器为纯函数，
不再依赖模块级 `_CHAR_TO_IDX` 全局。
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F

from ocr_core.charset import charset_hash

log = logging.getLogger(__name__)


class CheckpointFormatError(Exception):
    """Checkpoint 缺失或不兼容 `format_version` 元数据。"""


# ── Architecture ─────────────────────────────────────────────────────


class _ConvBlock(nn.Module):
    def __init__(self, in_c: int, out_c: int, pool: tuple[int, int] | None = None):
        super().__init__()
        self.conv = nn.Conv2d(in_c, out_c, kernel_size=3, padding=1, bias=False)
        self.bn = nn.BatchNorm2d(out_c)
        self.pool = pool

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = F.relu(self.bn(self.conv(x)), inplace=True)
        if self.pool is not None:
            x = F.max_pool2d(x, self.pool)
        return x


class CRNN(nn.Module):
    """Compact CRNN. Input (B, 1, 48, 48) → output (T=6, B, num_classes)."""

    ARCH_ID = "crnn-v1"
    INPUT_SIZE = [48, 48]
    INPUT_CHANNELS = 1
    BLANK_INDEX = 0

    def __init__(self, num_classes: int, hidden: int = 128,
                 input_channels: int | None = None):
        super().__init__()
        self.input_channels = input_channels if input_channels is not None else self.INPUT_CHANNELS
        # CNN: collapse H=48 → 1 across the layers.
        self.cnn = nn.Sequential(
            _ConvBlock(self.input_channels, 64, pool=(2, 2)),  # H 48 → 24, W 48 → 24
            _ConvBlock(64, 128, pool=(2, 2)),   # H 24 → 12, W 24 → 12
            _ConvBlock(128, 256, pool=(2, 1)),  # H 12 →  6, W 12 → 12
            _ConvBlock(256, 256, pool=(2, 1)),  # H  6 →  3, W 12 → 12
            _ConvBlock(256, 512, pool=(3, 1)),  # H  3 →  1, W 12 → 12
            # W stays 12 → T=12 time steps (was (1,2) → W 6 → T=6).
            nn.Conv2d(512, 512, kernel_size=(1, 2), bias=False),  # W 12 → 6
        )
        self.rnn = nn.LSTM(
            input_size=512,
            hidden_size=hidden,
            num_layers=2,
            batch_first=False,
            bidirectional=True,
            dropout=0.1,
        )
        self.fc = nn.Linear(hidden * 2, num_classes)
        self.num_classes = num_classes
        self.hidden = hidden

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (B, C, H, W), where C is 1 for v1 or 3 for RGB v2
        feat = self.cnn(x)               # (B, 512, 1, T_w)
        assert feat.size(2) == 1, f"expected H=1 after CNN, got {feat.size(2)}"
        feat = feat.squeeze(2)           # (B, 512, T_w)
        feat = feat.permute(2, 0, 1)     # (T_w, B, 512) — time-major for CTC
        out, _ = self.rnn(feat)          # (T_w, B, 2*hidden)
        logits = self.fc(out)            # (T_w, B, num_classes)
        return logits


class CRNNRGB(CRNN):
    """RGB-input CRNN variant that preserves bead/background color."""

    ARCH_ID = "crnn-v2-rgb"
    INPUT_CHANNELS = 3


# ── CTC greedy decode + dictionary constraint (pure functions) ───────


def ctc_greedy_decode(
    logits: torch.Tensor,
    idx_to_char: dict[int, str],
    blank: int = 0,
) -> list[str]:
    """Greedy CTC decode → list of strings (one per batch element).

    Repeated non-blank tokens are collapsed, blanks are dropped.
    """
    preds = logits.argmax(dim=2).transpose(0, 1).cpu().numpy()  # (B, T)
    out: list[str] = []
    for row in preds:
        chars: list[str] = []
        prev = -1
        for idx in row:
            if idx != prev and idx != blank:
                chars.append(idx_to_char.get(int(idx), "?"))
            prev = idx
        out.append("".join(chars))
    return out


def build_code_trie(codes: list[str]) -> dict:
    """Build a prefix tree over the code vocabulary."""
    root: dict = {"children": {}, "code": None}
    for c in codes:
        node = root
        for ch in c:
            node = node["children"].setdefault(ch, {"children": {}, "code": None})
        node["code"] = c
    return root


def constrained_decode(
    logits: torch.Tensor,
    code_trie: dict,
    char_to_idx: dict[str, int],
    blank: int = 0,
    blank_penalty: float = 0.0,
) -> list[tuple[str, float]]:
    """Beam-free constrained decode: walk the trie top-down at each time step.

    ``char_to_idx`` is passed explicitly (pure function — no module global).
    ``blank_penalty`` subtracts from log-prob of the blank token to bias the
    decoder toward emitting a character. Returns ``[(code, score), ...]``.

    CTC-aware: at each step the decoder compares the best *trie child* logit
    against the blank logit (after penalty).  If blank wins, the trie node is
    NOT advanced (blank frames carry no character) and the current path is
    kept — this is what makes the decoder work with real CTC models, which
    emit long blank runs between characters (e.g. ``A_______110`` → ``A10``).
    A repeated character (CTC collapse: ``A110`` → ``A10``) is also skipped
    without advancing the trie — the second identical frame carries no new
    information.
    """
    log_probs = F.log_softmax(logits, dim=2)  # (T, B, C)
    T, B, C = log_probs.shape
    blank_logp = log_probs[:, :, blank]  # (T, B)
    # Each path tracks (trie node, emitted chars, whether the PREVIOUS frame
    # emitted a character).  The last flag distinguishes CTC collapse
    # (``22`` consecutive frames → one ``2``) from distinct characters
    # separated by a blank frame (``2 _ 2`` → ``22``).
    paths = [{"node": code_trie, "score": 0.0, "emitted": [],
              "prev_emitted": False} for _ in range(B)]
    for t in range(T):
        step = log_probs[t]  # (B, C)
        next_paths = []
        for b in range(B):
            p = paths[b]
            node = p["node"]
            cur_score = p["score"]
            emitted = p["emitted"]
            children = node["children"]
            best_child = None
            best_score = -1e9
            for ch, child in children.items():
                if ch not in char_to_idx:
                    continue
                s = step[b, char_to_idx[ch]].item()
                if s > best_score:
                    best_score = s
                    best_child = (ch, child)
            blank_s = blank_logp[t, b].item() - blank_penalty
            if best_child is not None and best_score > blank_s:
                ch, child = best_child
                if (emitted and ch == emitted[-1] and p["prev_emitted"]):
                    # CTC collapse: consecutive identical frames (no blank
                    # between) emit the character once.  Stay on the same
                    # trie node.
                    next_paths.append({
                        "node": node, "score": cur_score + best_score,
                        "emitted": emitted, "prev_emitted": True,
                    })
                else:
                    # Real character: advance down the trie.
                    next_paths.append({
                        "node": child,
                        "score": cur_score + best_score,
                        "emitted": emitted + [ch],
                        "prev_emitted": True,
                    })
            else:
                # Blank (or no trie child): keep the node, no emission.
                next_paths.append({
                    "node": node, "score": cur_score, "emitted": emitted,
                    "prev_emitted": False,
                })
        paths = next_paths
    results: list[tuple[str, float]] = []
    for p in paths:
        node = p["node"]
        emitted_str = "".join(p["emitted"])
        code = node["code"] or emitted_str
        results.append((code, p["score"]))
    return results


# ── Checkpoint I/O (010 R2 metadata) ─────────────────────────────────


def _code_dict_version(codes: list[str] | None) -> str | None:
    if not codes:
        return None
    return "sha256:" + hashlib.sha256("|".join(sorted(codes)).encode("utf-8")).hexdigest()


def save_checkpoint(
    path: str | Path,
    model: CRNN,
    num_classes: int,
    chars: list[str],
    code_dict: list[str] | None = None,
    training: dict | None = None,
) -> None:
    """Save checkpoint with full metadata (010 R2)."""
    model_cls = type(model)
    ckpt = {
        "format_version": 1,
        "model_arch": getattr(model_cls, "ARCH_ID", CRNN.ARCH_ID),
        "num_classes": num_classes,
        "hidden": getattr(model, "hidden", 128),
        "input_size": list(getattr(model_cls, "INPUT_SIZE", CRNN.INPUT_SIZE)),
        "input_channels": getattr(model, "input_channels", CRNN.INPUT_CHANNELS),
        "blank_index": getattr(model_cls, "BLANK_INDEX", CRNN.BLANK_INDEX),
        "chars": chars,
        "charset_hash": charset_hash(),
        "code_dict_version": _code_dict_version(code_dict),
        "code_dict": sorted(code_dict) if code_dict else None,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "training": training or {},
        "state_dict": model.state_dict(),
    }
    torch.save(ckpt, path)


def load_checkpoint(path: str | Path, device: str = "cpu") -> tuple[CRNN, list[str]]:
    """Load checkpoint with hard compatibility validation (010 R2).

    Raises CheckpointFormatError for legacy 3-key checkpoints (missing
    format_version) — they must be migrated via publish_checkpoint.py.
    """
    ckpt = torch.load(path, map_location=device, weights_only=False)

    if "format_version" not in ckpt:
        raise CheckpointFormatError(
            f"checkpoint lacks format_version; retrain or migrate (old format = 3-key dict): {path}"
        )

    chars = ckpt["chars"]
    num_classes = ckpt["num_classes"]
    model_arch = ckpt.get("model_arch")
    model_classes = {
        CRNN.ARCH_ID: CRNN,
        CRNNRGB.ARCH_ID: CRNNRGB,
    }
    model_cls = model_classes.get(model_arch)
    if model_cls is None:
        raise CheckpointFormatError(
            f"model_arch mismatch: checkpoint={model_arch!r}; supported={sorted(model_classes)}"
        )

    # ── Hard checks ──
    if model_arch != model_cls.ARCH_ID:
        raise CheckpointFormatError(
            f"model_arch mismatch: checkpoint={model_arch} != runtime={model_cls.ARCH_ID}"
        )
    if num_classes != len(chars):
        raise CheckpointFormatError(
            f"num_classes mismatch: {num_classes} != len(chars)={len(chars)}"
        )
    if list(ckpt.get("input_size") or []) != model_cls.INPUT_SIZE:
        raise CheckpointFormatError(
            f"input_size mismatch: {ckpt.get('input_size')} != {model_cls.INPUT_SIZE}"
        )
    if ckpt.get("input_channels") != model_cls.INPUT_CHANNELS:
        raise CheckpointFormatError(
            f"input_channels mismatch: {ckpt.get('input_channels')} != {model_cls.INPUT_CHANNELS}"
        )
    if ckpt.get("blank_index") != model_cls.BLANK_INDEX:
        raise CheckpointFormatError(
            f"blank_index mismatch: {ckpt.get('blank_index')} != {model_cls.BLANK_INDEX}"
        )
    ckpt_charset_hash = ckpt.get("charset_hash")
    if ckpt_charset_hash and ckpt_charset_hash != charset_hash():
        raise CheckpointFormatError(
            f"charset_hash mismatch: checkpoint={ckpt_charset_hash[:16]}... != runtime={charset_hash()[:16]}..."
        )

    # ── Soft checks ──
    if ckpt.get("code_dict_version") and ckpt.get("code_dict"):
        cur = _code_dict_version(ckpt["code_dict"])
        if cur != ckpt["code_dict_version"]:
            log.warning(
                "code_dict drift: checkpoint=%s vs embedded=%s — 建议重发布匹配的颜色库快照或重训",
                ckpt["code_dict_version"], cur,
            )

    hidden = ckpt.get("hidden", 128)
    model = model_cls(num_classes=num_classes, hidden=hidden)
    model.load_state_dict(ckpt["state_dict"])
    model.to(device)
    model.eval()
    return model, chars
