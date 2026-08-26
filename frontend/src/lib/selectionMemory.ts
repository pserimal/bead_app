import type { PersistedRect } from './pendingUpload';

const STORAGE_KEY = 'lastSelectionPositions';

export type SelectionMemoryKind = 'crop' | 'materials';

type StoredSelection = {
  imageW: number;
  imageH: number;
  rect: PersistedRect;
};

type SelectionStore = Partial<Record<SelectionMemoryKind, StoredSelection>>;

function validNumber(value: number): boolean {
  return Number.isFinite(value);
}

function readStore(): SelectionStore {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as SelectionStore;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function clampRect(rect: PersistedRect, imageW: number, imageH: number): PersistedRect {
  const w = Math.max(0, Math.min(imageW, rect.w));
  const h = Math.max(0, Math.min(imageH, rect.h));
  return {
    x: Math.max(0, Math.min(imageW - w, rect.x)),
    y: Math.max(0, Math.min(imageH - h, rect.y)),
    w,
    h,
  };
}

/** Read the last rectangle and scale it to the current image dimensions. */
export function readLastSelection(kind: SelectionMemoryKind, imageW: number, imageH: number): PersistedRect | null {
  if (!validNumber(imageW) || !validNumber(imageH) || imageW <= 0 || imageH <= 0) return null;
  const stored = readStore()[kind];
  if (!stored || !validNumber(stored.imageW) || !validNumber(stored.imageH) || stored.imageW <= 0 || stored.imageH <= 0) return null;
  const { rect } = stored;
  if (!rect || ![rect.x, rect.y, rect.w, rect.h].every(validNumber)) return null;
  return clampRect(
    {
      x: rect.x * imageW / stored.imageW,
      y: rect.y * imageH / stored.imageH,
      w: rect.w * imageW / stored.imageW,
      h: rect.h * imageH / stored.imageH,
    },
    imageW,
    imageH,
  );
}

/** Persist a rectangle with its source dimensions so it can be reused safely. */
export function saveLastSelection(kind: SelectionMemoryKind, rect: PersistedRect, imageW: number, imageH: number): boolean {
  if (!validNumber(imageW) || !validNumber(imageH) || imageW <= 0 || imageH <= 0) return false;
  if (!rect || ![rect.x, rect.y, rect.w, rect.h].every(validNumber)) return false;
  if (typeof localStorage === 'undefined') return false;
  try {
    const store = readStore();
    store[kind] = { imageW, imageH, rect: clampRect(rect, imageW, imageH) };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}
