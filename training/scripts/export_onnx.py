"""Export the bead CRNN checkpoint to ONNX for offline KMP inference.

Usage:
    conda run -n bead-train python -m training.scripts.export_onnx \
        --checkpoint training/checkpoints/bean-mard-v8.pt \
        --out-dir artifacts/models/bean-mard-v8-onnx

The exported graph keeps the model output as [T, B, C]. Image preprocessing,
CTC/trie decoding, confidence normalization, and color lookup remain outside
the graph so the Kotlin implementation can be tested independently.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch

from ocr_core.bead_ocr_crnn import load_checkpoint
from ocr_core.charset import charset_hash


REPO_ROOT = Path(__file__).resolve().parents[2]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def export_onnx(checkpoint: Path, out_dir: Path, opset: int = 17, verify: bool = False) -> Path:
    model, chars = load_checkpoint(checkpoint, device="cpu")
    model.eval()

    input_channels = int(getattr(model, "input_channels", 1))
    input_size = list(getattr(type(model), "INPUT_SIZE", [48, 48]))
    out_dir.mkdir(parents=True, exist_ok=True)
    model_path = out_dir / "model.onnx"

    example = torch.zeros((1, input_channels, input_size[0], input_size[1]), dtype=torch.float32)
    with torch.no_grad():
        torch_output = model(example).cpu().numpy()

    torch.onnx.export(
        model,
        (example,),
        str(model_path),
        export_params=True,
        opset_version=opset,
        do_constant_folding=True,
        input_names=["images"],
        output_names=["logits"],
        dynamic_axes={
            "images": {0: "batch"},
            "logits": {1: "batch"},
        },
        training=torch.onnx.TrainingMode.EVAL,
        dynamo=False,
    )

    manifest = {
        "format_version": 1,
        "runtime_format": "onnx",
        "opset": opset,
        "model_arch": getattr(type(model), "ARCH_ID", None),
        "input_name": "images",
        "output_name": "logits",
        "input_size": input_size,
        "input_channels": input_channels,
        "blank_index": 0,
        "num_classes": len(chars),
        "output_shape": list(torch_output.shape),
        "charset_hash": charset_hash(),
        "source_checkpoint": str(checkpoint),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "model_sha256": _sha256(model_path),
    }
    # Merge into an existing artifact manifest (e.g. a published .pt model):
    # keep the pt fields, add the onnx fields, and record the onnx export time
    # separately so the pt manifest is never overwritten.
    manifest_path = out_dir / "manifest.json"
    if manifest_path.exists():
        existing = json.loads(manifest_path.read_text(encoding="utf-8"))
        onnx_created = manifest.pop("created_at")
        existing.update(manifest)
        existing["onnx_created_at"] = onnx_created
        manifest = existing
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    (out_dir / "charset.json").write_text(
        json.dumps({"chars": chars, "charset_hash": manifest["charset_hash"]}, indent=2),
        encoding="utf-8",
    )

    code_dict = getattr(model, "supported_codes", None)
    if code_dict:
        codes = sorted(code_dict)
        (out_dir / "code_dict.json").write_text(
            json.dumps({"codes": codes}, indent=2),
            encoding="utf-8",
        )

    if verify:
        verify_onnx(model_path, model, example)

    return model_path


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def verify_onnx(model_path: Path, model: torch.nn.Module, example: torch.Tensor) -> None:
    try:
        import onnxruntime as ort
    except ImportError as exc:
        raise RuntimeError("verification requires onnxruntime; install image_service requirements") from exc

    session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    rng = np.random.default_rng(20260809)
    for batch_size in (1, 2, 16):
        inputs = example if batch_size == 1 else torch.from_numpy(
            rng.random((batch_size, *example.shape[1:]), dtype=np.float32)
        )
        with torch.no_grad():
            expected = model(inputs).cpu().numpy()
        actual = session.run(["logits"], {"images": inputs.numpy()})[0]
        np.testing.assert_allclose(actual, expected, rtol=1e-4, atol=1e-5)
        print(f"[verify] batch={batch_size} parity passed: shape={actual.shape}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Export bead CRNN to ONNX")
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--opset", type=int, default=17)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()

    checkpoint = args.checkpoint if args.checkpoint.is_absolute() else REPO_ROOT / args.checkpoint
    out_dir = args.out_dir if args.out_dir.is_absolute() else REPO_ROOT / args.out_dir
    path = export_onnx(checkpoint, out_dir, opset=args.opset, verify=args.verify)
    print(f"[export] {path}")


if __name__ == "__main__":
    main()
