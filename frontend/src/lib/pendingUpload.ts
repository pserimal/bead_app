const DB_NAME = 'beadapp-upload-cache';
const STORE_NAME = 'files';
const FILE_KEY = 'current';

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
