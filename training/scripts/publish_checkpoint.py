"""Publish a trained checkpoint as an immutable, versioned artifact (010 R3).

Usage (from repo root):
    python -m training.scripts.publish_checkpoint \\
        --checkpoint training/checkpoints/crnn_real_m.pt \\
        --name crnn_real_m --version 2026-08-01T00-00-00Z

    python -m training.scripts.publish_checkpoint --colors   # 生成颜色库快照

Legacy checkpoints (old 3-key dict, no format_version) are migrated in memory
to format_version=1 with computed metadata, so existing training output can be
published without retraining.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

import torch

from ocr_core.bead_ocr_crnn import CRNN, _code_dict_version
from ocr_core.charset import charset_hash

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
ARTIFACTS = _REPO_ROOT / "artifacts"


def publish_checkpoint(checkpoint: Path, name: str, version: str) -> Path:
    ckpt = torch.load(checkpoint, map_location="cpu", weights_only=False)

    # ── 迁移 legacy 格式（010 R2：缺 format_version 的旧 3-key dict）──
    if "format_version" not in ckpt:
        chars = ckpt["chars"]
        ckpt = {
            "format_version": 1,
            "model_arch": CRNN.ARCH_ID,
            "num_classes": ckpt["num_classes"],
            "hidden": 128,
            "input_size": CRNN.INPUT_SIZE,
            "input_channels": CRNN.INPUT_CHANNELS,
            "blank_index": CRNN.BLANK_INDEX,
            "chars": chars,
            "charset_hash": charset_hash(),
            "code_dict_version": None,
            "code_dict": None,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "training": {"legacy_migrated": True, "source": str(checkpoint)},
            "state_dict": ckpt["state_dict"],
        }
        print(f"[migrate] legacy 3-key checkpoint → format_version=1 ({len(chars)} chars)")

    out_dir = ARTIFACTS / "models" / f"{name}-{version}"
    out_dir.mkdir(parents=True, exist_ok=False)  # immutable: 已存在即失败

    # model.pt（含元数据）
    torch.save(ckpt, out_dir / "model.pt")
    # charset.json
    (out_dir / "charset.json").write_text(
        json.dumps({"chars": ckpt["chars"], "charset_hash": ckpt.get("charset_hash", charset_hash())}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    # code_dict.json
    code_dict = ckpt.get("code_dict")
    if code_dict:
        (out_dir / "code_dict.json").write_text(
            json.dumps({"codes": sorted(code_dict), "code_dict_version": _code_dict_version(code_dict)}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    # manifest.json
    manifest = {
        "model_name": name,
        "version": version,
        "format_version": ckpt["format_version"],
        "model_arch": ckpt.get("model_arch"),
        "num_classes": ckpt.get("num_classes"),
        "charset_hash": ckpt.get("charset_hash"),
        "code_dict_version": ckpt.get("code_dict_version"),
        "created_at": ckpt.get("created_at"),
        "training": ckpt.get("training", {}),
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # dev 便捷指针
    current = ARTIFACTS / "models" / "current"
    if current.is_symlink() or current.exists():
        current.unlink() if current.is_file() else shutil.rmtree(current, ignore_errors=True)
    try:
        current.symlink_to(out_dir.name, target_is_directory=True)
    except OSError:
        # Windows 无权限建 symlink 时退化：写 current.txt
        (ARTIFACTS / "models" / "current.txt").write_text(out_dir.name, encoding="utf-8")

    print(f"[publish] {out_dir}")
    return out_dir


def publish_colors() -> Path:
    src = _REPO_ROOT / "backend" / "app" / "data" / "default_colors.json"
    out = ARTIFACTS / "colors" / "library.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    if src.exists():
        shutil.copy(src, out)
        print(f"[colors] copied {src} → {out}")
    else:
        print(f"[colors] source not found: {src}（跳过）")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Publish CRNN training artifact (010 R3)")
    ap.add_argument("--checkpoint", type=Path)
    ap.add_argument("--name", default="crnn")
    ap.add_argument("--version", default=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ"))
    ap.add_argument("--colors", action="store_true", help="生成颜色库快照 artifacts/colors/library.json")
    args = ap.parse_args()

    if args.colors:
        publish_colors()
    if args.checkpoint:
        publish_checkpoint(args.checkpoint, args.name, args.version)
    if not args.colors and not args.checkpoint:
        ap.error("需要 --checkpoint 或 --colors")


if __name__ == "__main__":
    main()
