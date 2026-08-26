const DB_NAME = 'beadapp-upload-cache';
const STORE_NAME = 'files';
const FILE_KEY = 'current';

export const PENDING_WIZARD_KEY = 'pendingWizardState';
export const PENDING_LEGEND_KEY = 'pendingLegendState';
export const PENDING_CROP_KEY = 'pendingCrop';

export type WizardStep = 'upload' | 'crop' | 'materials';

export interface PersistedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PendingMaterial {
  code: string;
  count: number;
  confirmed: boolean;
  row?: number;
  col?: number;
  bbox?: PersistedRect;
}

export interface PendingWizardState {
  step: WizardStep;
  imageUrl?: string;
  imageW?: number;
  imageH?: number;
  crop?: PersistedRect | null;
  materialsBox?: PersistedRect | null;
  rows?: number;
  cols?: number;
  materialsRows?: number;
  materialsCols?: number;
  codes?: string;
  jobName?: string;
  legendInventory?: PendingMaterial[];
  skipLegendPrompt?: boolean;
}

export interface PendingCropState {
  imageUrl?: string;
  imageW: number;
  imageH: number;
  crop: PersistedRect;
  rows: number;
  cols: number;
}

interface StoredUpload {
  blob: Blob;
  name: string;
  type: string;
  lastModified: number;
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB unavailable'));
  });
}

/** Persist the source File so a full /crop → / navigation does not lose it. */
export async function savePendingUpload(file: File): Promise<boolean> {
  try {
    const database = await openDatabase();
    if (!database) return false;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(
        {
          blob: file,
          name: file.name,
          type: file.type,
          lastModified: file.lastModified,
        } satisfies StoredUpload,
        FILE_KEY,
      );
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not save upload'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Could not save upload'));
    });
    database.close();
    return true;
  } catch {
    return false;
  }
}

/** Load the source File after returning from the standalone crop page. */
export async function loadPendingUpload(): Promise<File | null> {
  try {
    const database = await openDatabase();
    if (!database) return null;
    const stored = await new Promise<StoredUpload | File | null>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(FILE_KEY);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error ?? new Error('Could not load upload'));
    });
    database.close();
    if (!stored) return null;
    if (stored instanceof File) return stored;
    return new File([stored.blob], stored.name, {
      type: stored.type,
      lastModified: stored.lastModified,
    });
  } catch {
    return null;
  }
}

/** Remove the source File after a job has been created successfully. */
export async function clearPendingUpload(): Promise<void> {
  try {
    const database = await openDatabase();
    if (!database) return;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(FILE_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not clear upload'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Could not clear upload'));
    });
    database.close();
  } catch {
    // A failed cache cleanup must not hide a successfully created job.
  }
}

function readSessionValue<T>(key: string): T | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeSessionValue(key: string, value: unknown): boolean {
  if (typeof sessionStorage === 'undefined') return false;
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function readPendingWizard(): PendingWizardState | null {
  const current = readSessionValue<PendingWizardState>(PENDING_WIZARD_KEY);
  if (current && typeof current.step === 'string') return current;

  // Keep the handoff-era key as a read fallback so an in-progress session is
  // not lost when the new canonical snapshot is introduced.
  const legacy = readSessionValue<Omit<PendingWizardState, 'step'>>(PENDING_LEGEND_KEY);
  return legacy ? { step: 'materials', ...legacy } : null;
}

export function savePendingWizard(state: PendingWizardState): boolean {
  const saved = writeSessionValue(PENDING_WIZARD_KEY, state);
  if (state.step === 'materials' || (state.legendInventory?.length ?? 0) > 0) {
    writeSessionValue(PENDING_LEGEND_KEY, state);
  } else if (typeof sessionStorage !== 'undefined') {
    try {
      sessionStorage.removeItem(PENDING_LEGEND_KEY);
    } catch {
      // Storage may be disabled; the canonical snapshot is still best effort.
    }
  }
  return saved;
}

export function clearPendingWizard(): void {
  if (typeof sessionStorage === 'undefined') return;
  for (const key of [PENDING_WIZARD_KEY, PENDING_LEGEND_KEY, 'pendingJobName']) {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // Storage may be disabled by the browser; there is nothing else to do.
    }
  }
}

export function readPendingCrop(): PendingCropState | null {
  return readSessionValue<PendingCropState>(PENDING_CROP_KEY);
}

export function savePendingCrop(state: PendingCropState): boolean {
  return writeSessionValue(PENDING_CROP_KEY, state);
}

export function clearPendingCrop(): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.removeItem(PENDING_CROP_KEY);
  } catch {
    // Storage may be disabled by the browser; the current navigation still works.
  }
}
