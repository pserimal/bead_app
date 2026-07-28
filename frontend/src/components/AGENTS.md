# COMPONENTS

**Updated:** 2026-07-12

## OVERVIEW

14 React components — atomic, prop-driven, Tailwind v4 styled. Hotspot: `CropBox.tsx` (1017 lines, drag-based, was 714) — considered for decomposition. No global state library — `ToastContext` is the only React Context.

## STRUCTURE

```
components/
├── BeadBoard.tsx      # Canvas 2D bead grid — pan/zoom/rotation + cell selection (216 lines)
├── CropBox.tsx        # Dual-region drag-based image cropping, forwardRef exposing applyCrop(), onCropComplete callback, 8 resize handles, zoom/pan, touch support (1017 lines — was 714)
├── CellEditor.tsx     # Searchable color picker modal for cell editing (87 lines)
├── ColorFilter.tsx    # Color code filtering with collapse (69 lines)
├── AnimatedPage.tsx   # framer-motion page transition wrapper (28 lines)
├── Layout.tsx         # App shell with responsive nav (85 lines)
├── ErrorBoundary.tsx  # Class component error catcher (26 lines)
├── ErrorDisplay.tsx   # Error message with retry (15 lines)
├── Toast.tsx          # Auto-dismiss notification (49 lines)
├── ToastContext.tsx   # React Context for global toasts, `useToast()` hook (53 lines)
├── Modal.tsx          # Portal-based modal, Escape + overlay close (60 lines)
├── Button.tsx         # Variants: primary/secondary/danger (37 lines)
├── Spinner.tsx        # Loading indicator (28 lines)
└── SkeletonCard.tsx   # Loading placeholder (11 lines)
```

## WHERE TO LOOK

| Task | File | Notes |
|------|------|-------|
| Add interactive canvas | `BeadBoard.tsx` | Canvas 2D `getContext('2d')`, event handlers for pan/zoom/select |
| Modify image cropping | `CropBox.tsx` | Drag interaction model, dual-region with 8 resize handles, zoom/pan, touch support; `applyCrop()` + `onCropComplete` callback |
| Edit bead cell color | `CellEditor.tsx` | Searchable color picker, integrated with `useColorLibrary` |
| Add UI feedback | `Toast.tsx` + `ToastContext.tsx` | `useToast()` hook, auto-dismiss, single global toast stack |
| Add loading state | `Spinner.tsx` / `SkeletonCard.tsx` | Spinner for full-page, SkeletonCard for card placeholders |
| Add modal dialog | `Modal.tsx` | Portal (`createPortal`), Escape key + overlay click close |
| Error boundaries | `ErrorBoundary.tsx` | Class component, catches render errors, shows `ErrorDisplay` |
| App shell | `Layout.tsx` | Responsive nav bar, outlet slot for page content |
| Page transitions | `AnimatedPage.tsx` | framer-motion wrapper, imports variants from `lib/animations.ts` |

## CONVENTIONS

- **Default exports** — every component uses `export default function Xxx`
- **Props interface** — `interface XxxProps` defined in same file, not in `types/`
- **Tailwind only** — no CSS modules, no styled-components, no inline styles
- **Canvas 2D** — `BeadBoard` renders via `useRef<HTMLCanvasElement>` + `useEffect` draw loop, not DOM grid
- **forwardRef** — `CropBox` exposes `applyCrop()` to parent via `forwardRef` + `useImperativeHandle`
- **Portal** — `Modal` uses `createPortal` to render outside component tree
- **Only one Context** — `ToastContext`; everything else is prop drilling
- **class component exception** — `ErrorBoundary` is a class (needs `componentDidCatch`)

## ANTI-PATTERNS

- **CropBox.tsx is 1017 lines** — still large despite drag rewrite; further sub-component decomposition remains (CropOverlay, RegionHandle, PreviewPanel)
- **Prop drilling** — toast callbacks and event handlers drilled through multiple levels
- **No loading skeleton on initial load** — `SkeletonCard` exists but rarely used

## NOTES

- BeadBoard uses `requestAnimationFrame` for smooth pan/zoom
- CropBox's `applyCrop()` returns `{gridRect, colorCardRect}` for Region A/B selection
- Toast auto-dismiss timeout: 3s for success, 5s for error
