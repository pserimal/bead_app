#!/usr/bin/env python3
"""Merge the Zippland/liangdabiao 291-color mapping into the color library.

Source data: `colorSystemMapping.json` — 291 standard colors → 5 Chinese bead
brands (MARD / COCO / 漫漫 / 盼盼 / 咪小窝).  Format::

    {"#FAF4C8": {"MARD": "A01", "COCO": "E02", "漫漫": "E2", "盼盼": "65", "咪小窝": "77"}, ...}

Attribution (important — read before using this script):

- The file is byte-identical in both reference projects:
  * liangdabiao/perler-beads-ai (Apache-2.0) — the project we reference.
  * Zippland/perler-beads (AGPL-3.0) — the original, whose data this is.
  So the data copyright belongs to Zippland/perler-beads (AGPL-3.0);
  liangdabiao/perler-beads-ai is the intermediate reference.  Both are
  credited in `docs/adr/0005-synthetic-board-generation.md`.
- ai_dou is AGPL-3.0; this merge is a derivative of AGPL data and stays AGPL.

Policy decisions (per project discussions):

1. **MARD is skipped** — our library already carries the identical MARD
   palette (291 entries from maxcleme/beadcolors); hex values match 100 %.
   Only the code format differs (ours `A1`, theirs `A01`) — if MARD entries
   are ever imported, normalize codes to our no-leading-zero format.
2. New brands get English ids: COCO → `coco`, 漫漫 → `manman`,
   盼盼 → `panpan`, 咪小窝 → `mixiaowo`.
3. `color_name`: reuse the existing library entry's name when the same hex
   already exists; otherwise fall back to the brand code (the source file
   has no color names).
4. Conflicts (same code, different hex across brands) follow the same rule
   as `build_color_library.py`: the first (highest-priority) brand keeps the
   bare code, later brands get a brand prefix (`COCO-`, `MM-`, `PP-`, `MXW-`).
5. Entries are appended to the existing library; existing entries are never
   modified.  Run with `--dry-run` to preview before writing.

Usage::

    python -m training.scripts.import_zippland_palette \
        --mapping /path/to/colorSystemMapping.json \
        [--library artifacts/colors/library.json] \
        [--out artifacts/colors/library.json] \
        [--dry-run]

Exit code is non-zero on any validation failure.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

BRANDS: dict[str, str] = {
    "COCO": "coco",
    "漫漫": "manman",
    "盼盼": "panpan",
    "咪小窝": "mixiaowo",
}
BRAND_PREFIX: dict[str, str] = {
    "COCO": "COCO-",
    "漫漫": "MM-",
    "盼盼": "PP-",
    "咪小窝": "MXW-",
}
# New brands are lower priority than every existing brand, so existing
# entries always keep their bare code on conflict.
SKIP_BRANDS = {"MARD"}  # already present in our library (identical data)


def _hex_upper(h: str) -> str:
    return h.strip().upper().lstrip("#")


def load_library(path: Path) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def build_new_entries(
    mapping: dict, library: list[dict]
) -> list[dict]:
    """Compute the entries to append, without touching the library."""
    # Existing (code → hex) per brand and (hex → color_name) lookup.
    existing_codes: dict[str, dict[str, str]] = {}  # brand_id -> {code: hex}
    existing_raw: dict[str, set[str]] = {}  # brand_id -> raw codes seen
    hex_name: dict[str, str] = {}
    for e in library:
        existing_codes.setdefault(e["brand"], {})[e["code"]] = e["color_hex"]
        hex_name.setdefault(e["color_hex"].upper(), e.get("color_name", ""))

    entries: list[dict] = []
    sort_counter: dict[str, int] = {}
    for hex_key, brand_map in sorted(mapping.items()):
        hex_val = _hex_upper(hex_key)
        rgb = (int(hex_val[0:2], 16), int(hex_val[2:4], 16), int(hex_val[4:6], 16))
        for zh, brand_id in BRANDS.items():
            code_raw = brand_map.get(zh)
            if not code_raw:
                continue
            code = str(code_raw).strip().upper()
            # Same brand already carries this code (source data maps several
            # standard colors onto one brand code) — keep the first occurrence.
            if code in existing_raw.get(brand_id, set()):
                continue
            existing_raw.setdefault(brand_id, set()).add(code)
            # Priority: existing brands keep bare codes; if this code is
            # already taken by another brand with a *different* hex, prefix.
            taken = any(
                b != brand_id and code in codes and codes[code].upper() != hex_val
                for b, codes in existing_codes.items()
            )
            final_code = f"{BRAND_PREFIX[zh]}{code}" if taken else code
            existing_codes.setdefault(brand_id, {})[final_code] = hex_val
            # Reuse a color name if the same hex is already in the library.
            name = hex_name.get(hex_val, final_code)
            sort_counter[brand_id] = sort_counter.get(brand_id, 0) + 1
            entries.append(
                {
                    "brand": brand_id,
                    "code": final_code,
                    "color_name": name,
                    "color_hex": f"#{hex_val}",
                    "sort_order": sort_counter[brand_id],
                }
            )
            assert len(final_code) <= 8, f"code too long: {final_code}"
    return entries


def validate(entries: list[dict], library: list[dict]) -> list[str]:
    errors: list[str] = []
    seen: set[tuple[str, str]] = {(e["brand"], e["code"]) for e in library}
    for e in entries:
        key = (e["brand"], e["code"])
        if key in seen:
            errors.append(f"duplicate (brand, code): {key}")
        seen.add(key)
        if len(e["code"]) > 8:
            errors.append(f"code > 8 chars: {e['code']}")
    return errors


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--mapping", required=True, type=Path,
                   help="path to colorSystemMapping.json (from liangdabiao/perler-beads-ai)")
    p.add_argument("--library", type=Path,
                   default=_REPO_ROOT / "artifacts" / "colors" / "library.json")
    p.add_argument("--out", type=Path, default=None,
                   help="output JSON (default: overwrite --library)")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    if not args.mapping.exists():
        print(f"mapping file not found: {args.mapping}", file=sys.stderr)
        return 1

    with open(args.mapping, encoding="utf-8") as f:
        mapping = json.load(f)
    library = load_library(args.library)

    new_entries = build_new_entries(mapping, library)
    errors = validate(new_entries, library)
    if errors:
        for e in errors[:20]:
            print(f"  [error] {e}", file=sys.stderr)
        print(f"{len(errors)} validation errors", file=sys.stderr)
        return 1

    per_brand: dict[str, int] = {}
    for e in new_entries:
        per_brand[e["brand"]] = per_brand.get(e["brand"], 0) + 1
    print(f"new entries: {len(new_entries)}")
    for b, n in sorted(per_brand.items()):
        print(f"  {b}: {n}")
    print(f"library before: {len(library)} → after: {len(library) + len(new_entries)}")
    if new_entries:
        print("sample:", json.dumps(new_entries[0], ensure_ascii=False))
        print("sample:", json.dumps(new_entries[300], ensure_ascii=False))

    if args.dry_run:
        print("dry-run — nothing written")
        return 0

    out = args.out or args.library
    library.extend(new_entries)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(library, f, ensure_ascii=False, indent=2)
    print(f"wrote {out} ({len(library)} entries)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
