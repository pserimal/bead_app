"""Train CRNN on synthetic + real marked cell data.

Usage:
    # Real only (8644 labeled marked cells from training/samples/)
    cd training && python -m training.scripts.train_crnn \\
        --real-only --epochs 30 --out checkpoints/crnn_real_v1.pt

    # Mixed: synthetic pretraining (covers all 65 codes) + real fine-tuning
    cd training && python -m training.scripts.train_crnn \\
        --synth-n 50000 --epochs 30 --out checkpoints/crnn_v3.pt

    # Custom real data directory
    cd training && python -m training.scripts.train_crnn \\
        --real-dir /path/to/marked/cells \\
        --manifest /path/to/manifest.csv \\
        --epochs 30 --out checkpoints/crnn.pt

The training loop expects:
- torch installed (`pip install torch torchvision`)
- Real data format: PNG files where the first underscore-delimited token of
  the filename is the bead code (e.g. `H7_0000_marked.png` → code "H7")
- A manifest.csv at the real-dir root with column "编码" for code labels
  (optional — filename parsing is sufficient)

Stage 1 (default, no --real-only):
    Synth pretraining on all library codes (style="marked" by default)

Stage 2 (--real-only, or always after Stage 1):
    Real-data fine-tuning with class-balanced sampling
    (WeightedRandomSampler handles the H7-dominant imbalance)
"""
from __future__ import annotations

import argparse
import csv
import random
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Iterable

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, Dataset, WeightedRandomSampler

# Make the `training` package importable when this file is run as
# `python -m training.scripts.train_crnn` from the repo root.
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from ocr_core.bead_ocr_crnn import CRNN, CRNNRGB, ctc_greedy_decode, save_checkpoint  # noqa: E402
from training.models.synth_generator import (  # noqa: E402
    CODES,
    Sample,
    _get_wm_font,
    generate_dataset,
)
from training.models.board_generator import _WM_CHARS  # noqa: E402


# ── Dataset ──────────────────────────────────────────────────────────


def _to_gray(img: np.ndarray) -> np.ndarray:
    """Convert RGB uint8 to grayscale (pass-through if already 2d)."""
    if img.ndim == 2:
        return img
    return (0.299 * img[:, :, 0] + 0.587 * img[:, :, 1] + 0.114 * img[:, :, 2]).astype(np.uint8)


def _to_rgb(img: np.ndarray) -> np.ndarray:
    """Return an RGB uint8 image, repeating grayscale inputs across channels."""
    if img.ndim == 2:
        return np.stack([img] * 3, axis=-1)
    if img.shape[-1] > 3:
        return img[:, :, :3]
    return img


def _resize_to_48(arr: np.ndarray) -> np.ndarray:
    """Resize a 48-ish grayscale or RGB image to (48, 48) uint8."""
    from PIL import Image
    arr = _to_rgb(arr)
    if arr.shape[:2] != (48, 48):
        img = Image.fromarray(arr.astype(np.uint8)).resize((48, 48), Image.LANCZOS)
        arr = np.array(img)
    return arr


def _to_model_tensor(arr: np.ndarray, color: bool) -> torch.Tensor:
    """Convert resized pixels to normalized model input (CHW)."""
    arr = _resize_to_48(arr)
    if color:
        pixels = np.ascontiguousarray(arr)
        return torch.from_numpy(pixels).float().permute(2, 0, 1) / 255.0
    gray = np.ascontiguousarray(_to_gray(arr))
    return torch.from_numpy(gray).float().unsqueeze(0) / 255.0


class SampleLike:
    """Lightweight wrapper so real + synth samples share the same Dataset interface.

    Avoids importing the Sample dataclass at module top — real cells are loaded
    as plain numpy arrays from disk and wrapped on the fly.
    """
    __slots__ = ("image", "code", "token_indices")

    def __init__(self, image: np.ndarray, code: str, char_to_idx: dict[str, int]):
        self.image = image
        self.code = code
        self.token_indices = [char_to_idx[ch] for ch in code]


def _overlay_watermark_residue(Image, arr: np.ndarray, rng) -> np.ndarray:
    """Overlay a dark CJK stroke fragment on a cell to mimic real watermarks.

    Real production watermarks are dark CJK glyphs that randomly cover bead
    cells (medium glyph size, position-random, ~50% alpha).  Drawing the
    glyph at 2x resolution and downscaling preserves the look; placing the
    glyph center at a random offset within the cell simulates the random
    placement users see in shared diagrams.
    """
    from PIL import ImageDraw, ImageFont
    font = _get_wm_font()
    if font is None:
        return arr
    SZ = 96  # 2x cell size
    base = Image.fromarray(arr.astype(np.uint8)).convert("RGBA")
    # 1–3 random CJK chars; 30–50 px glyphs (large enough to cover most of
    # the 48-px cell at typical placements).
    n_chars = rng.randint(1, 3)
    text = "".join(rng.choice(_WM_CHARS) for _ in range(n_chars))
    fs = rng.randint(30, 50)
    try:
        glyph = ImageFont.truetype(font.path, fs)
    except Exception:
        return arr
    # Use the cell's native size so alpha_composite doesn't size-mismatch.
    W, H = base.size
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    # Glyph bounding box large enough to overflow the cell at any offset.
    bbox = glyph.getbbox(text)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    cx = rng.randint(-tw // 2, W)
    cy = rng.randint(-th // 2, H)
    # Real watermarks are semi-transparent dark strokes — the code below
    # stays visible through them. Keep alpha moderate so the augment adds
    # noise without destroying the label (v9b: 0.3 prob, alpha 80-160).
    alpha = rng.randint(80, 160)
    gray = rng.randint(0, 40)
    ImageDraw.Draw(overlay).text((cx - bbox[0], cy - bbox[1]), text,
                                  font=glyph,
                                  fill=(gray, gray, gray, alpha))
    base = Image.alpha_composite(base, overlay).convert("RGB")
    return np.array(base)


class CellDataset(Dataset):
    """Wraps a list of Sample or SampleLike into a torch Dataset.

    Each item is (image_tensor, target_indices, target_length).

    When ``augment=True``, applies light data augmentation (rotation ±5°,
    brightness jitter ±10%) on __getitem__ — only for training, not validation.
    """

    def __init__(self, samples: list, augment: bool = False, color: bool = False):
        self.samples = samples
        self.augment = augment
        self.color = color
        from PIL import Image
        import random as _rng
        self._Image = Image
        # HDF5-free per-pytorch random state for the augment branch.
        self._rng = _rng
        # Cache the watermark font once (lazy load via _get_wm_font).
        self._wm_font = _get_wm_font() if augment else None

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, idx: int):
        s = self.samples[idx]
        arr = _resize_to_48(s.image)

        if self.augment:
            from PIL import Image, ImageEnhance
            import random as _rng
            # Random rotation ±5°
            angle = _rng.uniform(-5, 5)
            if abs(angle) > 0.5:
                img = Image.fromarray(arr.astype(np.uint8))
                img = img.rotate(angle, resample=Image.BILINEAR, fillcolor=128)
                arr = np.array(img)
            # Brightness jitter ±12%
            factor = _rng.uniform(0.88, 1.12)
            if abs(factor - 1.0) > 0.02:
                img = Image.fromarray(arr.astype(np.uint8))
                img = ImageEnhance.Brightness(img).enhance(factor)
                arr = np.array(img)
            # RGB: saturation jitter ±15% (keeps model color-robust)
            if self.color:
                color_factor = _rng.uniform(0.85, 1.15)
                if abs(color_factor - 1.0) > 0.03:
                    img = Image.fromarray(arr.astype(np.uint8))
                    img = ImageEnhance.Color(img).enhance(color_factor)
                    arr = np.array(img)
            # Cell-level watermark residue (real production watermarks are
            # dark CJK strokes that randomly cover bead cells; we simulate the
            # same look at the cell level so the model learns to read through
            # heavy watermark contamination). Applied only at training time
            # (augment=True) — never in validation or production.
            from PIL import ImageDraw, ImageFont
            self._ImageDraw = ImageDraw
            self._ImageFont = ImageFont
            if self._rng.random() < 0.3:
                arr = _overlay_watermark_residue(self._Image, arr, self._rng)

        img = _to_model_tensor(arr, color=self.color)
        target = torch.tensor(s.token_indices, dtype=torch.long)
        return img, target, len(s.token_indices)


def collate(batch):
    imgs, targets, lengths = zip(*batch)
    imgs = torch.stack(imgs)
    # Pad targets with -1 (CTCLoss ignore_index).
    max_len = max(lengths)
    padded = torch.full((len(targets), max_len), -1, dtype=torch.long)
    for i, t in enumerate(targets):
        padded[i, : t.size(0)] = t
    return imgs, padded, torch.tensor(lengths, dtype=torch.long)


# ── Real data loading ────────────────────────────────────────────────


def _parse_code_from_filename(name: str) -> str | None:
    """Extract bead code from a marked image filename.

    Supported patterns:
      - legacy labeled cells: `H7_0000_marked.png` (first token is the code)
      - board-crop cells:     `r001_c002_A10.png` (code after the coords)
      - sample cells:         `sample_000_H15.png` (last token)
    Returns None if no token looks like a code (letter followed by digits).
    """
    stem = name.rsplit(".", 1)[0]
    # Empty cells are a real special label, not the CTC blank token.
    # Normalize both current ``blank_*`` and historical ``EMPTY_*`` exports.
    if stem.lower().startswith(("blank_", "empty_")):
        return "BLANK"
    # r<row>_c<col>_<CODE>.png — coords first, code last.
    parts = stem.split("_")
    # Corrections export: `CODE_r<row>_c<col>_h.._v..png` — code is the first
    # token and may be the special BLANK label.
    if len(parts) >= 5 and parts[1].startswith("r") and parts[2].startswith("c"):
        candidate = parts[0]
        if candidate.upper() == "BLANK":
            return "BLANK"
    elif len(parts) >= 3 and parts[0].startswith("r") and parts[1].startswith("c"):
        candidate = parts[2]
    elif parts and parts[0].startswith("sample"):
        candidate = parts[-1] if len(parts) >= 2 else ""
    else:
        candidate = parts[0] if parts else ""

    def _looks_like_code(tok: str) -> bool:
        if not tok or not tok[0].isalpha():
            return False
        return any(ch.isdigit() for ch in tok[1:])

    if _looks_like_code(candidate):
        return candidate.upper()
    return None


def _load_real_samples(
    real_dir: Path,
    char_to_idx: dict[str, int],
    manifest_path: Path | None = None,
) -> tuple[list, set[str]]:
    """Load labeled marked cells from a directory.

    Filename pattern: `<CODE>_<SEQ>_marked[_h<v>].png`. Code is parsed from
    the first underscore-delimited token. Optionally cross-references with
    a manifest.csv whose first column is the code label.

    Returns (samples, set_of_codes_seen).
    """
    pngs = sorted(real_dir.glob("*.png"))
    if not pngs:
        raise FileNotFoundError(f"No PNG files found in {real_dir}")

    # Optional manifest: filename → code lookup
    manifest_lookup: dict[str, str] = {}
    if manifest_path is not None and manifest_path.exists():
        with open(manifest_path, encoding="utf-8-sig") as f:
            reader = csv.reader(f)
            rows = list(reader)
        if len(rows) > 1:
            header = rows[0]
            # Find columns
            code_col = filename_col = None
            for i, col in enumerate(header):
                if col.strip() in ("编码", "code"):
                    code_col = i
                elif col.strip() in ("文件名", "filename"):
                    filename_col = i
            for row in rows[1:]:
                if code_col is not None and filename_col is not None:
                    if len(row) > max(code_col, filename_col):
                        manifest_lookup[row[filename_col]] = row[code_col].upper()

    from PIL import Image

    samples: list = []
    seen_codes: set[str] = set()
    skipped_no_code = 0
    for f in pngs:
        # Prefer manifest code if available, else filename parsing
        if f.name in manifest_lookup:
            code = manifest_lookup[f.name]
        else:
            code = _parse_code_from_filename(f.name)
        if not code:
            skipped_no_code += 1
            continue
        # Validate characters are in vocab
        if not all(ch in char_to_idx for ch in code):
            skipped_no_code += 1
            continue
        try:
            with Image.open(f) as im:
                im.load()
                arr = np.array(im.convert("RGB") if im.mode != "RGB" else im)
        except Exception as e:  # noqa: BLE001
            print(f"  [warn] failed to read {f.name}: {e}")
            continue
        samples.append(SampleLike(arr, code, char_to_idx))
        seen_codes.add(code)

    if skipped_no_code:
        print(f"  [real] skipped {skipped_no_code} files (unparseable code or unknown chars)")
    return samples, seen_codes


def _stratified_split(
    samples: list, val_frac: float, seed: int
) -> tuple[list, list]:
    """Split samples per-code so each code's fraction in val matches val_frac.

    This guarantees the validation set has at least one example per code (for
    codes with >= 2 samples). Codes with only 1 sample go entirely to train.
    """
    rng = random.Random(seed)
    by_code: dict[str, list] = defaultdict(list)
    for s in samples:
        by_code[s.code].append(s)

    train_set, val_set = [], []
    for code, group in by_code.items():
        rng.shuffle(group)
        n_val = max(1, int(round(len(group) * val_frac))) if len(group) >= 2 else 0
        val_set.extend(group[:n_val])
        train_set.extend(group[n_val:])
    rng.shuffle(train_set)
    rng.shuffle(val_set)
    return train_set, val_set


# ── Vocab ────────────────────────────────────────────────────────────


def derive_vocab(real_codes: Iterable[str]) -> tuple[list[str], dict[str, int]]:
    """Build the character vocabulary from real + library codes.

    Always includes <blank> at index 0 (CTC requirement), then union of:
      - letters seen in real_codes
      - letters in synth CODES
      - digits 0-9

    This keeps the output head minimal while supporting all observed prefixes.
    """
    real_codes = list(real_codes)
    letters: set[str] = set()
    digits: set[str] = set()
    for code in real_codes + CODES:
        for ch in code:
            if ch.isalpha():
                letters.add(ch.upper())
            elif ch.isdigit():
                digits.add(ch)
    chars = ["<blank>"] + sorted(letters) + sorted(digits)
    char_to_idx = {ch: i for i, ch in enumerate(chars)}
    return chars, char_to_idx


# ── Sampling ─────────────────────────────────────────────────────────


def make_weighted_sampler(samples: list, real_weight: float = 1.0,
                          synth_weight: float = 1.0,
                          real_codes_known: set[str] | None = None
                          ) -> WeightedRandomSampler:
    """Inverse-frequency weighted sampler to address class imbalance.

    Each sample's weight is the inverse frequency of its code, multiplied by
    a per-source multiplier (real_weight or synth_weight). This both
    balances codes and biases the mix between real and synth sources.

    When ``real_codes_known`` is provided, synth samples whose code has
    zero real examples get a 3× boost (``synth_weight * 3``) — this forces
    the model to learn missing codes from synth.
    """
    code_counts = Counter(s.code for s in samples)
    weights: list[float] = []
    num_boosted = 0
    for s in samples:
        base = 1.0 / code_counts[s.code]
        if isinstance(s, Sample):
            # Synth sample
            src_w = synth_weight
            if real_codes_known is not None and s.code not in real_codes_known:
                src_w *= 3.0  # boost missing codes
                num_boosted += 1
        else:
            src_w = real_weight
        weights.append(base * src_w)
    total = sum(weights)
    weights = [w * len(samples) / total for w in weights]
    if real_codes_known and num_boosted:
        print(f"  [sampler] boosted {num_boosted} synth samples for {len(set(s.code for s in samples if isinstance(s, Sample) and s.code not in real_codes_known))} missing codes")
    return WeightedRandomSampler(
        weights=torch.tensor(weights, dtype=torch.double),
        num_samples=len(samples),
        replacement=True,
    )


# ── Evaluation ───────────────────────────────────────────────────────


def evaluate(model: CRNN, samples: list, device: str,
             codes: set[str], idx_to_char: dict[int, str]) -> tuple[float, float, list[tuple[str, str]]]:
    """Return (exact_match_rate, valid_code_rate, mismatches).

    mismatches is a list of (gt_code, pred_code) for the first few errors,
    useful for debugging.
    """
    model.eval()
    correct = 0
    valid = 0
    mismatches: list[tuple[str, str]] = []
    with torch.no_grad():
        bs = 64
        for i in range(0, len(samples), bs):
            chunk = samples[i : i + bs]
            arrs = []
            for s in chunk:
                arrs.append(_to_model_tensor(
                    s.image, color=getattr(model, "input_channels", 1) == 3
                ))
            imgs = torch.stack(arrs)
            imgs = imgs.to(device)
            logits = model(imgs)  # (T, B, C)
            preds = ctc_greedy_decode(logits, idx_to_char)
            for j, pred in enumerate(preds):
                if pred in codes:
                    valid += 1
                if pred == chunk[j].code:
                    correct += 1
                elif len(mismatches) < 20:
                    mismatches.append((chunk[j].code, pred))
    n = max(1, len(samples))
    return correct / n, valid / n, mismatches


# ── Training loop ───────────────────────────────────────────────────


def train(args):
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[train] device={device}")

    # ── Load real data first (needed to derive vocab if --real-dir given) ──
    real_samples: list = []
    real_codes_seen: set[str] = set()
    if args.real_dir is not None:
        print(f"[train] loading real data from {args.real_dir}...")
        # Provisional vocab: include all letters + digits. Will refine below.
        prov_chars = ["<blank>"] + list("ABCDEFGHIJKLMNOPQRSTUVWXYZ") + list("0123456789")
        prov_idx = {ch: i for i, ch in enumerate(prov_chars)}
        real_samples, real_codes_seen = _load_real_samples(
            Path(args.real_dir), prov_idx,
            Path(args.manifest) if args.manifest else None,
        )
        print(f"[train] loaded {len(real_samples)} real samples, "
              f"{len(real_codes_seen)} unique codes")

    # ── Build final vocab from real + library ──
    chars, char_to_idx = derive_vocab(real_codes_seen)
    idx_to_char = {i: ch for i, ch in enumerate(chars)}
    print(f"[train] vocab size: {len(chars)} ({len(chars)-1} non-blank: "
          f"{''.join(c for c in chars if c != '<blank>')[:40]}...)")

    # If real samples were loaded with provisional vocab, re-tokenize now
    if real_samples:
        for s in real_samples:
            s.token_indices = [char_to_idx[ch] for ch in s.code]

    # ── Generate synthetic data ──
    synth_samples: list = []
    if not args.real_only and args.synth_n > 0:
        print(f"[train] generating {args.synth_n} synthetic samples "
              f"(style={args.style})...")
        synth_samples = generate_dataset(
            args.synth_n, seed=args.seed, style=args.style
        )
        # Re-tokenize synth with the actual vocab (filter out codes whose
        # chars aren't in our vocab).
        kept = []
        for s in synth_samples:
            if all(ch in char_to_idx for ch in s.code):
                s.token_indices = [char_to_idx[ch] for ch in s.code]
                kept.append(s)
            # else: skip — code uses a letter not in vocab
        synth_samples = kept
        print(f"[train] kept {len(synth_samples)}/{len(synth_samples) + (args.synth_n - len(kept))} "
              f"synth (dropped any whose letters aren't in vocab)")

    # ── Stratified split on real data ──
    train_real: list = []
    val_real: list = []
    if real_samples:
        train_real, val_real = _stratified_split(real_samples, args.val_frac, args.seed)
        print(f"[train] real split: train={len(train_real)} val={len(val_real)}")

    # ── Build training set: real first, then synth (or only one) ──
    if args.real_only:
        train_samples = train_real
        val_samples = val_real
    elif args.synth_only:
        rng = random.Random(args.seed)
        rng.shuffle(synth_samples)
        cut = int(len(synth_samples) * (1 - args.val_frac))
        train_samples = synth_samples[:cut]
        val_samples = synth_samples[cut:]
    else:
        # Mixed: real for train, real for val, plus synth to fill train
        train_samples = list(train_real) + list(synth_samples)
        val_samples = list(val_real)

    print(f"[train] final: train={len(train_samples)} val={len(val_samples)}")

    # ── Sampler / loader ──
    sampler = None
    if args.balance_classes and train_samples:
        sampler = make_weighted_sampler(
            train_samples,
            real_weight=args.real_weight,
            synth_weight=args.synth_weight,
            real_codes_known=real_codes_seen if not args.real_only else None,
        )

    train_loader = DataLoader(
        CellDataset(train_samples, augment=args.augment, color=args.color),
        batch_size=args.batch_size,
        shuffle=(sampler is None),
        sampler=sampler,
        collate_fn=collate,
        num_workers=args.num_workers,
    )

    # ── Model / optimizer / scheduler ──
    model_cls = CRNNRGB if args.color else CRNN
    model = model_cls(num_classes=len(chars)).to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs)
    ctc_loss = nn.CTCLoss(blank=0, zero_infinity=True)

    codes_set = (set(CODES) | set(real_codes_seen))
    # Keep the checkpoint's supported-code dictionary clean: only codes the
    # model can actually emit (letter+digit, or the BLANK special label).
    # Dirty entries from the multi-brand library (dashed prefixes like
    # ``ARKA-A10``, bare digits like ``1``) have no training examples and
    # must not leak into the inference trie.
    codes_set = {c for c in codes_set
                 if c == "BLANK"
                 or (c[:1].isalpha() and c[1:].isdigit() and c[1:] != "")}
    best_val = 0.0
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    for epoch in range(args.epochs):
        model.train()
        t0 = time.time()
        total = 0.0
        n = 0
        for imgs, targets, target_lengths in train_loader:
            imgs = imgs.to(device)
            targets = targets.to(device)
            target_lengths = target_lengths.to(device)
            logits = model(imgs)
            log_probs = nn.functional.log_softmax(logits, dim=2)
            T, B, C = log_probs.shape
            input_lengths = torch.full((B,), T, dtype=torch.long, device=device)
            # CTCLoss expects concatenated 1-D targets; we filter -1 first.
            mask = targets >= 0
            flat_targets = targets[mask]
            loss = ctc_loss(log_probs, flat_targets, input_lengths, target_lengths)
            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            optimizer.step()
            total += float(loss.item()) * B
            n += B
        scheduler.step()
        em, vr, mismatches = evaluate(model, val_samples, device, codes_set, idx_to_char)
        dt = time.time() - t0
        print(f"[train] epoch {epoch+1:3d}/{args.epochs} loss={total/n:.4f} "
              f"val_em={em:.3f} val_valid={vr:.3f} ({dt:.1f}s)")
        if mismatches and args.debug_mismatches:
            print(f"  first mismatches: {mismatches[:8]}")
        if em > best_val:
            best_val = em
            save_checkpoint(
                out_path, model, len(chars), chars,
                code_dict=list(codes_set) if codes_set else None,
                training={"seed": args.seed, "epochs": args.epochs,
                           "synth_n": args.synth_n, "color": args.color},
            )
            print(f"  → saved checkpoint → {out_path} (val_em={em:.3f})")

    print(f"[train] done. best_val_em={best_val:.3f} "
          f"(vocab={len(chars)}, train={len(train_samples)}, val={len(val_samples)})")


def parse_args():
    p = argparse.ArgumentParser(
        description="Train CRNN on synthetic + real marked cell data",
    )

    # Data sources (mutually exclusive on the all-data side, but flexible)
    p.add_argument("--real-dir", type=str, default=None,
                   help="Directory of marked real cell PNGs "
                        "(default: %(default)s). Filenames must encode the code "
                        "as the first underscore-delimited token.")
    p.add_argument("--manifest", type=str, default=None,
                   help="Optional manifest.csv at the real-dir root (columns: "
                        "编码, 文件名). If absent, codes are parsed from filenames.")
    p.add_argument("--synth-n", type=int, default=0,
                   help="Number of synthetic samples to generate. 0 disables synth. "
                        "Default 0 (use --synth-n 50000 to add synthetic).")
    p.add_argument("--style", type=str, default="marked",
                   choices=["colored", "marked"],
                   help="Synthetic data style (default marked — matches real).")
    p.add_argument("--real-only", action="store_true",
                   help="Train only on real data (skip synthetic entirely).")
    p.add_argument("--synth-only", action="store_true",
                   help="Train only on synthetic data (skip real).")

    # Sampling
    p.add_argument("--balance-classes", action="store_true", default=True,
                   help="Use WeightedRandomSampler to balance code frequency "
                        "(default: True).")
    p.add_argument("--no-balance-classes", dest="balance_classes", action="store_false",
                   help="Disable class-balanced sampling.")
    p.add_argument("--real-weight", type=float, default=1.5,
                   help="Per-sample weight multiplier for real data "
                        "(default 1.5; synth multiplier is 1.0).")
    p.add_argument("--synth-weight", type=float, default=1.0,
                   help="Per-sample weight multiplier for synthetic data "
                        "(default 1.0).")
    p.add_argument("--val-frac", type=float, default=0.2,
                   help="Validation fraction of real data, stratified per code "
                        "(default 0.2).")

    # Training
    p.add_argument("--epochs", type=int, default=30)
    p.add_argument("--batch-size", type=int, default=64)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--num-workers", type=int, default=0)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--out", type=str, default="checkpoints/crnn.pt")
    p.add_argument("--augment", action="store_true", default=False,
                   help="Apply light data augmentation (rotation ±5°, "
                        "brightness ±12%; RGB saturation ±15% in --color mode).")
    p.add_argument("--color", action="store_true",
                   help="Train the RGB-input CRNN (crnn-v2-rgb) to preserve bead/background color.")
    p.add_argument("--debug-mismatches", action="store_true",
                   help="Print first few (gt, pred) mismatches per epoch.")
    return p.parse_args()


if __name__ == "__main__":
    train(parse_args())