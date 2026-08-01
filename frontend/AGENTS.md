# FRONTEND

**Updated:** 2026-07-12

## OVERVIEW

React 18 + TypeScript + Vite + Tailwind CSS v4 frontend with TanStack React Query for server state and Axios for API calls. No global state library — prop drilling + React Query + single Context (Toast).

## STRUCTURE

```
src/
├── main.tsx            # Entry point, renders <App />
├── App.tsx             # QueryClient + ErrorBoundary + ToastProvider + BrowserRouter + Routes
├── App.css             # Global styles (minimal, Tailwind handles most)
├── index.css           # Tailwind v4 imports + CSS-based config (no tailwind.config.*)
├── api/
│   ├── client.ts       # Axios instance, baseURL '/api', 30s timeout, error interceptor (17 lines)
│   ├── blueprints.ts   # getBlueprints, getBlueprintDetail, uploadBlueprint, updateCell, deleteBlueprint (41 lines)
│   └── colors.ts       # getColorLibraries, createEntry, updateEntry, deleteEntry (33 lines)
├── components/
│   ├── BeadBoard.tsx   # Canvas-based bead grid — pan/zoom/rotation + cell selection (216 lines)
│   ├── CellEditor.tsx  # Searchable color picker modal for cell editing (87 lines)
│   ├── CropBox.tsx     # Dual-region image cropping, forwardRef exposing applyCrop() (714 lines — HOTSPOT)
│   ├── ColorFilter.tsx # Color code filtering with collapse (69 lines)
│   ├── AnimatedPage.tsx # framer-motion page transition wrapper (28 lines)
│   ├── Layout.tsx      # App shell with responsive nav (85 lines)
│   ├── ErrorBoundary.tsx # Class component error catcher (26 lines)
│   ├── ErrorDisplay.tsx # Error message with retry (15 lines)
│   ├── Toast.tsx       # Auto-dismiss notification (49 lines)
│   ├── ToastContext.tsx # React Context for global toasts, `useToast()` hook (53 lines)
│   ├── Modal.tsx       # Portal-based modal, Escape + overlay close (60 lines)
│   ├── Button.tsx      # Variants: primary/secondary/danger (37 lines)
│   ├── Spinner.tsx     # Loading indicator (28 lines)
│   └── SkeletonCard.tsx # Loading placeholder (11 lines)
├── test/              # 12 vitest test files (React Testing Library)
├── hooks/
│   ├── useBlueprints.ts # useQuery for paginated blueprint list (45 lines)
│   └── useColorLibrary.ts # useQuery + useMutation for color entries (49 lines)
├── pages/
│   ├── UploadPage.tsx  # Image upload + CropBox + parsing trigger (323 lines)
│   ├── HistoryPage.tsx # Blueprint list with pagination (122 lines)
│   ├── BlueprintDetailPage.tsx # BeadBoard + CellEditor + export (263 lines)
│   └── ColorLibraryPage.tsx # Color entry CRUD table (248 lines)
└── types/
    ├── api.ts          # PaginatedResponse<T>, ApiError (11 lines)
    ├── blueprint.ts    # BlueprintListItem, BlueprintDetail, CellResponse, etc. (47 lines)
    ├── color.ts        # ColorLibrary, ColorEntry, ColorEntryCreate (37 lines)
    └── index.ts        # Re-exports (3 lines)
```

## WHERE TO LOOK

| Task | File | Notes |
|------|------|-------|
| Add new page | `pages/` | Create component, add route in `App.tsx` |
| Add new component | `components/` | Follow atomic pattern: small, prop-driven, default export |
| Add API call | `api/blueprints.ts` or `api/colors.ts` | Use `apiClient` from `client.ts` |
| Add React Query hook | `hooks/` | Wrap API calls in `useQuery`/`useMutation` |
| Add types | `types/` | Mirror backend schema structure |
| Modify canvas interaction | `components/BeadBoard.tsx` | Canvas 2D context, event handlers (mousedown/move/up + wheel) |
| Modify image cropping | `components/CropBox.tsx` | forwardRef pattern, dual-region selection |
| Add global toast | `components/ToastContext.tsx` | `useToast()` hook |
| State management | Pages + hooks only | No Redux/Zustand — React Query for server state, `useState` for local |

## CONVENTIONS

- **Components**: PascalCase, default export, functional (except `ErrorBoundary` — class component)
- **Hooks**: camelCase, prefixed `use`, noun phrase (`useBlueprints`, `useColorLibrary`)
- **API functions**: camelCase verbs (`getX`, `uploadX`, `updateX`, `deleteX`)
- **Types**: PascalCase with suffix (`BlueprintDetail`, `CellUpdateBatch`)
- **CSS**: Tailwind v4 utility classes only, config in `index.css` (no `tailwind.config.*`)
- **Props**: `interface XxxProps` pattern, often inlined in component file
- **ESLint**: Flat config (`eslint.config.js`) — ESLint v10+ format, no `.eslintrc`
- **No Prettier**: No formatter configured
- **Test infrastructure**: 12 vitest files in `src/test/` — React Testing Library + `vi.mock` patterns

## ANTI-PATTERNS

- **CropBox.tsx is 1017 lines** — complexity hotspot, refactored from 714; further decomposition possible (CropOverlay, RegionHandle, PreviewPanel)
- **Duplicated pagination schema** — `PaginatedResponse` in both `types/api.ts` and backend `schemas/common.py`
- **No error code mapping** — errors pass through message string only
- **Prop drilling** — toast callbacks and event handlers drilled through multiple levels
- **No loading skeleton on initial load** — `SkeletonCard` exists but rarely used

## COMMANDS

```bash
# Install dependencies
cd frontend && npm install

# Dev server (port 5173)
cd frontend && npm run dev

# Build for production
cd frontend && npm run build

# Preview production build
cd frontend && npm run preview

# Lint
cd frontend && npm run lint
```

## NOTES

- Dev proxy: `/api` → `http://localhost:8080` (configured in `vite.config.ts`)
- React Router v7 with 4 routes: `/`, `/blueprints`, `/blueprints/:id`, `/colors`
- TanStack React Query configured with `retry: 1`, no refetch on window focus
- Axios error interceptor extracts `error.response.data.detail` for user-facing messages
- `forwardRef` used in CropBox to expose `applyCrop()` to parent
- Canvas 2D rendering in BeadBoard (not DOM grid) — uses `useRef` + `useEffect` for draw loop
- Only one React Context: `ToastContext` — everything else is prop drilling or React Query
