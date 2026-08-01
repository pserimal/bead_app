#!/usr/bin/env python3
"""Build the color library JSON artifact from the official beadcolors CSV files.

Source of truth: https://github.com/maxcleme/beadcolors (gen/v1 CSVs)
Each brand CSV row: `code,name,r,g,b,hex,contributor`.

Output (same shape as `artifacts/colors/library.json`):
    [{"brand": "<brand-id>", "code": "...",
      "color_name": "...", "color_hex": "#RRGGBB", "sort_order": <n>}, ...]

Processing rules:
  1. Merge entries with the same (code, hex) across brands — a code with the
     same color in several brands is stored once (first brand kept).
  2. Real conflicts (same code, different hex) keep the original code for the
     highest-priority brand and prefix the others with a short brand id,
     e.g. `MARD-A10`.  All codes stay <= 8 chars (DB VARCHAR(8) PK).
  3. Entries are sorted by (brand, code); JSON key order is
     brand, code, color_name, color_hex, sort_order.

Usage:
    python -m training.scripts.build_color_library \
        --csv-dir <dir-with-15-csvs> \
        --out <output.json> \
        [--dry-run]

Exit code is non-zero on any validation failure.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import Counter, OrderedDict, defaultdict
from pathlib import Path

# ── Brand metadata ─────────────────────────────────────────────────────

BRANDS: list[str] = [
    "hama", "hama_maxi", "hama_mini",
    "perler", "perler_caps", "perler_mini",
    "nabbi",
    "artkal_a", "artkal_c", "artkal_m", "artkal_r", "artkal_s",
    "yant", "diamondDotz", "mard",
]

# Short prefix used when a code conflicts across brands.
BRAND_PREFIX: dict[str, str] = {
    "hama": "HAMA", "hama_maxi": "HMAX", "hama_mini": "HMIN",
    "perler": "PERLER", "perler_caps": "PCAP", "perler_mini": "PMIN",
    "nabbi": "NABBI",
    "artkal_a": "ARKA", "artkal_c": "ARKC", "artkal_m": "ARKM",
    "artkal_r": "ARKR", "artkal_s": "ARKS",
    "yant": "YANT", "diamondDotz": "DDOTZ", "mard": "MARD",
}

# Priority for keeping the bare code on conflict (lower = kept bare first).
BRAND_PRIORITY: list[str] = [
    "hama", "perler", "artkal_m", "artkal_c", "artkal_s", "artkal_a",
    "artkal_r", "nabbi", "yant", "mard",
    "hama_mini", "hama_maxi", "perler_mini", "perler_caps", "diamondDotz",
]

MAX_CODE_LEN = 8  # matches color_library.code VARCHAR(8) PK


# ── CSV loading ────────────────────────────────────────────────────────


def load_csvs(csv_dir: Path) -> list[tuple[str, str, str, str]]:
    """Return [(code, name, hex, brand), ...] for every CSV found."""
    entries: list[tuple[str, str, str, str]] = []
    for brand in BRANDS:
        path = csv_dir / f"{brand}.csv"
        if not path.exists():
            print(f"  ⚠️  missing {path.name} — skipped")
            continue
        with open(path, newline="", encoding="utf-8") as f:
            for row in csv.reader(f):
                if not row or len(row) < 6:
                    continue
                code, name = row[0].strip(), row[1].strip()
                hexv = row[5].strip().upper()
                if not code or not hexv:
                    continue
                # Normalize to #RRGGBB (same shape as the existing artifact).
                if not hexv.startswith("#"):
                    hexv = "#" + hexv
                entries.append((code, name, hexv, brand))
    return entries


# ── Conflict resolution ────────────────────────────────────────────────


def build_final_entries(
    entries: list[tuple[str, str, str, str]],
) -> list[dict]:
    """Merge same (code, hex); resolve cross-brand code conflicts with prefixes."""
    # Group by (code, hex) → [(name, brand), ...]
    grouped: "OrderedDict[tuple[str, str], list[tuple[str, str]]]" = OrderedDict()
    for code, name, hexv, brand in entries:
        grouped.setdefault((code, hexv), []).append((name, brand))

    # code → set of hex values
    code_hexs: defaultdict[str, set[str]] = defaultdict(set)
    for (code, hexv) in grouped:
        code_hexs[code].add(hexv)

    priority = {b: i for i, b in enumerate(BRAND_PRIORITY)}

    def rank(nb: tuple[str, str]) -> int:
        return priority.get(nb[1], len(BRAND_PRIORITY))

    result: list[dict] = []
    used: set[str] = set()
    for (code, hexv), variants in grouped.items():
        is_conflict = len(code_hexs[code]) > 1
        if not is_conflict:
            name = variants[0][0]
            result.append({"brand": variants[0][1], "code": code,
                           "color_name": name, "color_hex": hexv})
            used.add(code)
            continue

        ordered = sorted(variants, key=rank)
        if code not in used:
            # Highest-priority brand keeps the bare code.
            name, brand = ordered[0]
            result.append({"brand": brand, "code": code,
                           "color_name": name, "color_hex": hexv})
            used.add(code)
            # Other brands with the *same* hex are dropped (duplicate color).
        else:
            # Bare code already taken by another hex — prefix every variant.
            for name, brand in ordered:
                final = f"{BRAND_PREFIX[brand]}-{code}"
                if final not in used:
                    result.append({"brand": brand, "code": final,
                                   "color_name": name, "color_hex": hexv})
                    used.add(final)
    return result


# ── Validation ─────────────────────────────────────────────────────────


def validate(entries: list[dict]) -> list[str]:
    """Return a list of error strings (empty == valid)."""
    errors: list[str] = []
    codes = [e["code"] for e in entries]
    dups = [c for c, n in Counter(codes).items() if n > 1]
    if dups:
        errors.append(f"duplicate codes: {dups[:10]}")
    over_len = [c for c in codes if len(c) > MAX_CODE_LEN]
    if over_len:
        errors.append(f"codes over {MAX_CODE_LEN} chars: {over_len[:10]}")
    bad_hex = [e["code"] for e in entries
               if len(e["color_hex"]) != 7 or not e["color_hex"].startswith("#")
               or not all(c in "0123456789ABCDEF" for c in e["color_hex"][1:])]
    if bad_hex:
        errors.append(f"invalid hex: {bad_hex[:10]}")
    missing_brand = [e["code"] for e in entries if not e.get("brand")]
    if missing_brand:
        errors.append(f"missing brand: {missing_brand[:10]}")
    return errors


# ── Main ───────────────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv-dir", type=Path, required=True,
                    help="directory containing <brand>.csv files (gen/v1 format)")
    ap.add_argument("--out", type=Path, required=True,
                    help="output JSON path")
    ap.add_argument("--dry-run", action="store_true",
                    help="validate and print summary without writing")
    args = ap.parse_args()

    print(f"[build] loading CSVs from {args.csv_dir}")
    entries = load_csvs(args.csv_dir)
    if not entries:
        print("  ✗ no entries loaded — aborting", file=sys.stderr)
        return 1
    print(f"  loaded {len(entries)} raw rows")

    final = build_final_entries(entries)
    # Sort by (brand, code), then assign sort_order 1..N.
    final.sort(key=lambda e: (e["brand"], e["code"]))
    for i, e in enumerate(final, start=1):
        e["sort_order"] = i

    errors = validate(final)
    if errors:
        print("  ✗ validation failed:")
        for err in errors:
            print(f"    - {err}")
        return 1

    by_brand = Counter(e["brand"] for e in final)
    print(f"  ✓ {len(final)} entries (brands: {dict(by_brand)})")
    print(f"  ✓ all codes ≤ {MAX_CODE_LEN} chars, no duplicates, hex valid")

    if args.dry_run:
        print(f"  [dry-run] not writing {args.out}")
        return 0

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(final, f, ensure_ascii=False, indent=2)
    print(f"  ✓ wrote {args.out} ({args.out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
