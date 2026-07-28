"""CRNN model for per-cell bead-code recognition.

Architecture (classic CRNN, used in scene-text recognition):
    Input  : (B, 1, 48, 48) grayscale, the cell crop.
    CNN    : 5 conv blocks with BN + ReLU + MaxPool, collapse height to 1.
    RNN    : 2-layer Bidirectional LSTM on the width axis.
    FC     : Linear projection to num_classes (chars + CTC blank).
    Output : (T=11, B, num_classes) logits over time steps (width axis).

Inference path decodes via CTC greedy, then maps tokens to a closed
code vocabulary via the CHARS table in synth_generator.

Checkpoint layout:
    {
        "state_dict": ...,
        "num_classes": int,
        "chars": list[str],
    }
"""
from __future__ import annotations

from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F


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

    def __init__(self, num_classes: int, hidden: int = 128):
        super().__init__()
        # CNN: collapse H=48 → 1 across the layers.
        self.cnn = nn.Sequential(
            _ConvBlock(1, 64, pool=(2, 2)),     # H 48 → 24, W 48 → 24
            _ConvBlock(64, 128, pool=(2, 2)),   # H 24 → 12, W 24 → 12
            _ConvBlock(128, 256, pool=(2, 1)),  # H 12 →  6, W 12 → 12
            _ConvBlock(256, 256, pool=(2, 1)),  # H  6 →  3, W 12 → 12
            _ConvBlock(256, 512, pool=(3, 1)),  # H  3 →  1, W 12 → 12
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

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (B, 1, H, W)
        feat = self.cnn(x)               # (B, 512, 1, T_w)
        assert feat.size(2) == 1, f"expected H=1 after CNN, got {feat.size(2)}"
        feat = feat.squeeze(2)           # (B, 512, T_w)
        feat = feat.permute(2, 0, 1)     # (T_w, B, 512) — time-major for CTC
        out, _ = self.rnn(feat)          # (T_w, B, 2*hidden)
        logits = self.fc(out)            # (T_w, B, num_classes)
        return logits


# ── CTC greedy decode + dictionary constraint ────────────────────────


def ctc_greedy_decode(
    logits: torch.Tensor,
    idx_to_char: dict[int, str],
    blank: int = 0,
) -> list[str]:
    """Greedy CTC decode → list of strings (one per batch element).

    Repeated non-blank tokens are collapsed, blanks are dropped.
    No language-model / dictionary constraint here — that lives in
    ``constrained_decode`` so training and inference paths stay separate.
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
    """Build a prefix tree over the code vocabulary.

    Returns a nested dict: each node has "children" (char → node) and
    "code" (the code ending at this node, or None).
    """
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
    blank: int = 0,
    blank_penalty: float = 2.0,
) -> list[tuple[str, float]]:
    """Beam-free constrained decode: walk the trie top-down at each time step,
    greedily pick the highest-prob child.

    ``blank_penalty`` subtracts from log-prob of the blank token to bias the
    decoder toward emitting a character (avoids all-blank collapse on hard
    inputs). Returns ``[(code, score), ...]`` aligned with batch dim.
    """
    log_probs = F.log_softmax(logits, dim=2)  # (T, B, C)
    T, B, C = log_probs.shape
    # Walk one path per batch element in parallel.
    # Path state per batch: (node, accumulated_score).
    paths = [{"node": code_trie, "score": 0.0, "emitted": []} for _ in range(B)]
    for t in range(T):
        step = log_probs[t]  # (B, C)
        # Penalize blank so the decoder prefers to emit (CTC degeneracy fix).
        step = step.clone()
        step[:, blank] -= blank_penalty
        next_paths = []
        for b in range(B):
            p = paths[b]
            node = p["node"]
            cur_score = p["score"]
            emitted = p["emitted"]
            children = node["children"]
            if not children:
                # Dead-end: stay (this path can't grow further, so any future
                # step would still pick blank). Force blank by setting best.
                best_child = None
                best_score = step[b, blank].item()
                # Path terminates — emit completed code (or keep prior).
            else:
                best_child = None
                best_score = -1e9
                for ch, child in children.items():
                    if ch not in _CHAR_TO_IDX:
                        continue
                    s = step[b, _CHAR_TO_IDX[ch]].item()
                    if s > best_score:
                        best_score = s
                        best_child = (ch, child)
            if best_child is not None:
                ch, child = best_child
                next_paths.append({
                    "node": child,
                    "score": cur_score + best_score,
                    "emitted": emitted + [ch],
                })
            else:
                next_paths.append(p)
        paths = next_paths
    # For each batch element, return either the trie-completed code or the
    # longest emitted prefix (best-effort, may be invalid).
    results: list[tuple[str, float]] = []
    for p in paths:
        node = p["node"]
        emitted_str = "".join(p["emitted"])
        code = node["code"] or emitted_str
        results.append((code, p["score"]))
    return results


# Late-bound symbol so we don't import synth_generator at module load (the
# trainer sets this; the inference entrypoint also sets it).
_CHAR_TO_IDX: dict[str, int] = {}


def set_char_index(char_to_idx: dict[str, int]) -> None:
    """Inject the char→index map so constrained_decode can index the logits."""
    global _CHAR_TO_IDX
    _CHAR_TO_IDX = char_to_idx


# ── Checkpoint I/O ───────────────────────────────────────────────────


def save_checkpoint(path: str | Path, model: CRNN, num_classes: int, chars: list[str]) -> None:
    torch.save({
        "state_dict": model.state_dict(),
        "num_classes": num_classes,
        "chars": chars,
    }, path)


def load_checkpoint(path: str | Path, device: str = "cpu") -> tuple[CRNN, list[str]]:
    ckpt = torch.load(path, map_location=device, weights_only=False)
    chars = ckpt["chars"]
    model = CRNN(num_classes=ckpt["num_classes"])
    model.load_state_dict(ckpt["state_dict"])
    model.to(device)
    model.eval()
    set_char_index({ch: i for i, ch in enumerate(chars)})
    return model, chars