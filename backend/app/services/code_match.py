"""Dictionary-constrained code matching & fuzzy correction (Plan C).

The bead-code space is a **closed vocabulary** (every legal code lives in
``default_colors.json``). Generic OCR engines mis-read isolated 2–3 char
glyphs on colored backgrounds — common confusions are ``1``/``I``/``l``,
``0``/``O``, ``5``/``S``, ``8``/``B``, ``2``/``Z``. Two things recover most
of those errors:

1. **``clean_token``** — normalize confusable letter forms back to digits
   *before* the regex, so ``HI`` → ``H1`` instead of being dropped by the
   allowlist filter.
2. **``fuzzy_correct``** — if the cleaned token still isn't a real code,
   accept the unique nearest valid code within Levenshtein distance 1.

Both are pure-Python (codes are ≤4 chars; no need for rapidfuzz) so this
adds zero dependencies.
"""
from __future__ import annotations

# Letter forms that OCR routinely confuses with digits. Mapped to their
# digit twin in the *digit region* of a token (i.e. after the leading
# letter prefix). Keys are upper-case.
CONFUSABLES: dict[str, str] = {
    "I": "1",
    "L": "1",
    "O": "0",
    "S": "5",
    "B": "8",
    "Z": "2",
    "G": "6",
    "Q": "0",
    "D": "0",
}


def build_valid_letters(codes: list[str]) -> set[str]:
    """Set of legal leading letters, e.g. {'H', 'F', ...}."""
    return {c[0] for c in codes if c}


def levenshtein(a: str, b: str) -> int:
    """Standard iterative Levenshtein distance. Codes are ≤4 chars."""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost))
        prev = cur
    return prev[-1]


def clean_token(text: str, valid_letters: set[str] | str) -> str | None:
    """Normalize raw OCR text to a ``<letter><digits>`` candidate.

    Steps:
      1. Uppercase, keep alphanumerics only.
      2. Skip leading junk until the first legal letter prefix.
      3. Map confusable letters (I/L/O/S/...) → digits in the digit region.
      4. Drop any non-digit left in the digit region.

    Returns ``None`` if no legal prefix letter is present.
    """
    if not text:
        return None
    letters = set(valid_letters)
    kept = "".join(ch for ch in text.upper() if ch.isalnum())
    if not kept:
        return None
    # Locate the first legal leading letter.
    idx = next((i for i, ch in enumerate(kept) if ch in letters), -1)
    if idx < 0:
        return None
    kept = kept[idx:]
    letter = kept[0]
    rest = kept[1:]
    # Confusables → digits; then keep digits only (drops stray letters the
    # OCR may have inserted between digits).
    rest = "".join(CONFUSABLES.get(ch, ch) for ch in rest)
    digits = "".join(ch for ch in rest if ch.isdigit())
    if not digits:
        return None
    return letter + digits


def fuzzy_correct(
    token: str,
    valid_codes: set[str] | list[str],
    max_dist: int = 1,
) -> str | None:
    """Return the unique nearest valid code within ``max_dist``.

    Exact matches short-circuit. Ties (≥2 codes at the same minimal
    distance) return ``None`` — ambiguity is left to the caller to drop,
    rather than guessing. ``max_dist=1`` covers single insertions /
    deletions / substitutions, which is where almost all OCR noise lives.
    """
    if not token:
        return None
    codes = valid_codes if isinstance(valid_codes, set) else set(valid_codes)
    if token in codes:
        return token
    best: str | None = None
    best_dist = max_dist + 1
    for code in codes:
        d = levenshtein(token, code)
        if d == 0:
            return code
        if d < best_dist:
            best_dist = d
            best = code
        elif d == best_dist:
            # Tie — ambiguous, refuse to guess.
            best = None
    return best if best_dist <= max_dist else None


def resolve_code(
    raw_text: str,
    valid_codes: set[str] | list[str],
    valid_letters: set[str] | str,
    max_dist: int = 1,
) -> tuple[str | None, bool]:
    """High-level helper: clean → exact → fuzzy.

    Returns ``(code, was_fuzzy)``. ``code`` is ``None`` when no valid code
    can be recovered. ``was_fuzzy`` is True when the result came from
    Levenshtein correction (caller may want to discount its confidence).
    """
    token = clean_token(raw_text, valid_letters)
    if token is None:
        return (None, False)
    codes = valid_codes if isinstance(valid_codes, set) else set(valid_codes)
    if token in codes:
        return (token, False)
    corrected = fuzzy_correct(token, codes, max_dist=max_dist)
    if corrected is None:
        return (None, False)
    return (corrected, True)
