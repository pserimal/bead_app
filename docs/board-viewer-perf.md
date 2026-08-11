# Board Viewer Performance Gate

**Status**: accepted · **Date**: 2026-08-11 · **Commit baseline**: `6f21c81`

## Purpose

The blueprint viewer (detail page + immersive mode) renders a full bead
board on a single canvas with per-cell draw calls. On mobile devices with
weak CPUs this is the app's #1 interaction bottleneck (measured INP 884ms
before the fix). Any change to the viewer files **must** re-run this gate —
it makes "did the page get slower?" a mechanical question instead of a
judgment call.

## When this gate is mandatory

Modify any of these files → run the gate before commit:

| File | What it owns |
|------|--------------|
| `frontend/src/lib/boardCanvas.ts` | `drawBoard` / static-layer cache (the measured hot path) |
| `frontend/src/hooks/useBoardViewer.ts` | gestures, redraw scheduling, view math |
| `frontend/src/pages/BlueprintDetailPage.tsx` | detail page viewer integration |
| `frontend/src/components/ImmersionBoard.tsx` | immersive mode viewer integration |

Also run the gate when touching: `frontend/src/lib/animations.ts`,
framer-motion usage on these pages, or anything that changes canvas
allocation / redraw frequency.

## How to run (≈2 minutes)

1. **Start services** (see AGENTS.md "本地启动"): server :8080, image_service :8001, frontend :5173.
2. **Open a large blueprint** (≥90×158, e.g. the 14,220-cell test board):
   `http://192.168.5.156:5173/blueprints/<id>` — wait for load.
3. **Reload the page first** — the redraw-skip-on-shrink design means the
   script must start from the initial fit state; any prior zoom raises the
   drawn scale and makes low-zoom redraws not fire.
4. **Emulate mobile + CPU throttle** (chrome_devtools_emulate):
   `viewport: 390x844x3,mobile,touch` + `cpuThrottlingRate: 4`.
   ⚠️ CPU throttling resets to 1x on page reload — always reload **before**
   emulating, never after.
5. **Run the script**: paste the whole body of
   `frontend/scripts/board-viewer-perf.js` into
   `chrome_devtools_evaluate_script` (function parameter).
6. **Read the verdict**: `{ pass: true, results: [...] }`.

The script drives both pages itself: detail canvas (fit-view redraw +
zoomed redraw), enters immersive mode, measures its canvas the same way,
then exits. No manual interaction needed.

## Fixed thresholds (version 1)

Measured at **4× CPU throttle**, 390×844 dpr3, 90×158 = 14,220 cells:

| Metric | Threshold | Baseline (6f21c81 / 6f21c81+) | Pre-fix |
|--------|-----------|--------------------|---------|
| Low-zoom redraw (scale < 0.35, no code text) | ≤ 5,000 calls · ≤ 80ms | ~2,700 calls / ~20ms | — |
| High-zoom redraw (scale ≥ 0.35, code text) | ≤ 32,000 calls · ≤ 600ms | 28,451 calls (95–452ms) | 51,889 / 446ms |
| Viewport-mode redraw (scale > 102%, culled) | ≤ 8,000 calls · ≤ 120ms | 172–1,588 calls / 1–9ms | 86MP texture (300%) |
| Canvas bitmap | ≤ 15 MP · **max dim ≤ 4096** | 9.6 MP full / 0.9–1.4 MP viewport | 86.2 MP (300%) |
| INP (optional trace verification) | ≤ 300ms | 154ms | 884ms |

The thresholds are deliberately loose (≈3× headroom over baseline) so
machine noise doesn't flake the gate; they exist to catch **structural**
regressions (e.g. reverting to full redraw, drawing text at fit zoom,
dropping the static-layer cache). A result near or above threshold means
the change reintroduced the known bottleneck — fix or justify before commit.
Note: `ms` is measured under 4× CPU throttle and fluctuates (95–452ms for
the same 28k-call redraw); the **calls** count is the primary signal.

## Why these six measurements

- **Low-zoom redraw** — the view users land on (fit). Previously the
  biggest trap: 14k fillText/strokeText at 1–3px font sizes, invisible but
  expensive. Fixed by `CODE_MIN_SCALE = 0.35` skip.
- **High-zoom redraw** — the expensive-but-necessary path (text must be
  readable). Dominated by per-cell `fillText`/`strokeText`; static-layer
  `drawImage` must stay ≤ 1 call per redraw.
- **Viewport-mode redraw** — scale > 102% (board width × renderScale × dpr
  exceeds the 4096px texture limit, or area > 24MP) switches to viewport
  culling (bitmap = viewport size ≤ ~2MP, only visible cells drawn, ~2k
  calls per drag frame). This is what makes drag at 300%+ smooth; before
  it, the bitmap reached 86MP (12048×7152) — far past the 4096² GPU
  texture limit, forcing software compositing and janky drags. The 4096
  edge limit also fixes **image disappearing on mobile**: iOS Safari et al.
  render canvases wider than 4096px incorrectly (large blank areas), which
  happened in full-board mode between 102%–158%.
- **Bitmap** — canvas memory; dpr=2 cap × renderScale=3 cap (full mode);
  viewport mode is bounded by viewport size.
- **INP** — end-to-end user-perceived latency; optional because it needs a
  full performance trace, but run it when a change touches gesture/redraw
  scheduling (`useBoardViewer.ts`).

## History

| Date | Commit | Change | Low-zoom | High-zoom | Viewport | INP |
|------|--------|--------|----------|-----------|----------|-----|
| 2026-08-11 | `6f21c81` | static-layer cache + CODE_MIN_SCALE + stroke threshold 28→12 | ~2.7k calls / ~20ms | 28.4k / 95ms | — | 154ms |
| 2026-08-11 | (viewport mode) | culled viewport rendering at scale > 158%; first-paint ready state (loading) | 995 / 3ms | 28.4k / 261ms | 172–1.6k calls / 1–9ms, ≤1.4MP | — |
| 2026-08-11 | (before) | full redraw every frame | — | 51.9k / 446ms | 86MP texture at 300% | 884ms |

## Related

- Unit-level structural locks: `frontend/src/lib/boardCanvas.test.ts`
  (5 tests: no code text at low zoom, text at high zoom, static-layer
  reuse, stroke threshold, render structure).
- Model acceptance gate: `docs/acceptance.md` (same philosophy, different axis).
