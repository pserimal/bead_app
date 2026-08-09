# Model Acceptance Mechanism

**Status**: accepted · **Date**: 2026-08-09

## Purpose

Before any CRNN checkpoint is deployed to production, it must pass a
fixed, versioned acceptance gate. The gate compares a candidate checkpoint
against the **current production checkpoint** on a **fixed benchmark** that
every session shares. This makes "is the new model better?" a mechanical
question instead of a judgment call made after training.

## Fixed benchmark (version 1)

The benchmark sets are fixed by path in `training/scripts/eval_acceptance.py`
and are the same for every model. They cover four real-labeled domains plus
one synthetic heldout:

| Set | Content | Why it matters |
|-----|---------|----------------|
| `code_main` (1_标注结果_2026-07-29) | 8644 real labeled code cells | production truth for real boards |
| `blank_clean` (5_标注结果_2026-08-08) | 2536 clean blank + 1967 code cells | clean empty-cell recognition |
| `blank_polluted` (corrections-fdaa77a1) | 111 polluted blank + 233 code cells | watermarked/contaminated empty cells |
| `blank_polluted_ref` (4_标注结果_2026-08-08) | 164 blank + 520 code cells | older polluted-blank annotation reference |
| `synthetic_heldout` (mard_board_heldout_v2) | 10240 diagram crops incl. 870 blank | genuinely unseen generalization |

Notes:

- The real sets are also used in training — they are the only production
  truth we have for real boards, and their purpose here is **regression
  detection** (the new model must not degrade on data the old model knew).
- The synthetic heldout is generated with an **independent seed (13579)**
  that is never used for training, so it measures genuine generalization.
  Regenerate it (same seed) if missing; never reuse a training seed.

## Metrics

Per set, four metrics are reported for each model:

- `blank_acc` — blank-labeled cells correctly recognized as `BLANK`
- `code_acc` — non-blank cells whose recognized code matches the label
- `overall` — exact match over all cells in the set
- `blank_conf` / `code_conf` — mean confidence (free-path CTC, same as
  production inference)

## Gate rule

A candidate **PASSES** if, on **every** benchmark set, all of
`blank_acc`, `code_acc`, `overall` are at least the production value minus a
small tolerance (`TOLERANCE = 0.005`, configurable at the top of the
script). Any metric more than 0.005 worse than production → **FAIL**.

This is intentionally strict: "better on unseen data" never justifies
regressing a domain the old model handled. Trade-offs (e.g. big blank gain
at a small code cost) are a **human decision** — the gate reports them, it
does not silently allow them.

## Running the gate

```bash
python -m training.scripts.eval_acceptance \
    --candidate training/checkpoints/<candidate>.pt \
    --production training/checkpoints/<current-production>.pt \
    --json training/docs/acceptance-<candidate>-vs-<production>.json
```

Exit code 0 = PASS, 1 = FAIL. Reports are stored under
`training/docs/acceptance-*.json` (not committed; local-only).

## Result — v7 vs v8 (2026-08-09)

| Set | metric | v7 (prod) | v8 (cand) | delta |
|-----|--------|-----------|-----------|-------|
| code_main | code_acc | 0.9925 | 0.9903 | -0.0022 |
| blank_clean | blank_acc | 1.0000 | 1.0000 | 0 |
| blank_clean | code_acc | 1.0000 | 1.0000 | 0 |
| blank_polluted | blank_acc | 0.0000 | **0.9459** | +0.9459 |
| blank_polluted | code_acc | 0.7725 | 0.9957 | +0.2232 |
| blank_polluted_ref | blank_acc | 0.9756 | 0.9756 | 0 |
| blank_polluted_ref | code_acc | 0.9808 | 0.9846 | +0.0038 |
| synthetic_heldout | blank_acc | 0.4977 | **0.9977** | +0.5000 |
| synthetic_heldout | code_acc | 0.9818 | 0.9764 | **-0.0053** |

**Verdict: FAIL (by 0.0003)** — `synthetic_heldout.code_acc` regressed
0.0053 (tolerance 0.005). v8's blank recognition improves dramatically
(+50pp on heldout, +94.6pp on polluted) at a small, measurable code cost
(-0.5pp on unseen synthetic codes). Deployment was a **manual human
decision** taken despite the gate: the blank fix was the requested feature
and the code cost is small, but future sessions must re-run this gate and
surface the same trade-off rather than assuming PASS.

## Process rules for future sessions

1. Any candidate model must run `eval_acceptance` against the current
   production checkpoint before deployment.
2. The benchmark sets and tolerance are **fixed** — do not silently add or
   remove sets to make a candidate pass. Version bumps (e.g. adding a new
   real annotation set) are a deliberate, documented change.
3. If the gate FAILs but a human decides to deploy anyway (explicit
   trade-off), record the decision in the commit message and here.
4. New real annotation sets are added to `REAL_SETS` when they represent a
   new production domain; that is a benchmark version bump, not a
   per-training tweak.
