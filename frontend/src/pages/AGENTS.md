# FRONTEND PAGES

## OVERVIEW

4 route-level pages, each a top-level component rendered by `App.tsx` router. No page-level state management — pages compose hooks + components, lift local state via `useState`.

## STRUCTURE

```
pages/
├── UploadPage.tsx            # Image upload + CropBox + parse trigger (323 lines)
├── HistoryPage.tsx           # Blueprint list with pagination (122 lines)
├── BlueprintDetailPage.tsx   # BeadBoard + CellEditor + export (263 lines)
└── ColorLibraryPage.tsx      # Color entry CRUD table (248 lines)
```

## WHERE TO LOOK

| Page | Component(s) used | Hooks | Route |
|------|-------------------|-------|-------|
| `UploadPage` | `CropBox`, `Button`, `Toast` | `useNavigate` | `/` |
| `HistoryPage` | `AnimatedPage`, `SkeletonCard` | `useBlueprints` | `/history` |
| `BlueprintDetailPage` | `BeadBoard`, `CellEditor`, `ColorFilter`, `Toast` | `useBlueprint` (detail) | `/blueprints/:id` |
| `ColorLibraryPage` | `Button`, `Modal`, `Toast` | `useColorLibrary` | `/colors` |

## CONVENTIONS

- **Page = route handler** — no shared layout logic, wrap in `<AnimatedPage>` for transitions
- **`useParams<{ id: string }>()`** — typed route params via `react-router-dom` v6
- **No Redux/Zustand** — all server state via React Query, local state via `useState`
- **Loading + error states** — every page handles `isLoading`, `isError`, `data` separately
- **Toast for feedback** — `useToast()` for success/error on mutations
- **No SSR** — pure client-side React 18
- **Default export** — every page uses `export default function XxxPage`

## ANTI-PATTERNS

- **`useEffect` for data fetching** — must use React Query hooks, not `fetch` + `useEffect`
- **Direct API calls in components** — go through `frontend/src/api/*` wrappers + hooks
- **Inline styles** — Tailwind classes only, no `style={{}}` props
- **Hardcoded `/api` URLs** — use `client.ts` baseURL

## UNIQUE STYLES

- **`UploadPage`** is the only page with multi-step UX (select → crop → parse → result)
- **`BlueprintDetailPage`** uses canvas (`BeadBoard`) for grid render + DOM for editor overlay
- **`ColorLibraryPage`** uses `Modal` for create/edit forms, inline for delete confirm
- **Pagination** — `HistoryPage` uses `useBlueprints({ page, pageSize })` pattern

## NOTES

- Pages do NOT include `Layout` — `App.tsx` wraps routes in `<Layout>` once
- ErrorBoundary at `App.tsx` level catches page render errors
- `UploadPage` calls `uploadBlueprint()` then navigates to `/blueprints/:id` on success
- `BlueprintDetailPage` exports PNG via canvas `.toBlob()` + `URL.createObjectURL`
