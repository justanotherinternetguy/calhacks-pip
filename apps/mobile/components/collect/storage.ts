// Saved /collect sessions in the browser: IndexedDB database `safe-collect`, object store `sessions` (key `id`).
// A tiny promise wrapper, no dependency. Every call fails soft: a browser without IndexedDB (private window, native)
// gets an empty list and save errors as strings, and the page keeps recording in memory.
import { Platform } from 'react-native';
import type { CollectSession } from './session';

const DB = 'safe-collect';
const STORE = 'sessions';
const VERSION = 1;

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    const idb: IDBFactory | undefined = Platform.OS === 'web' ? (globalThis as { indexedDB?: IDBFactory }).indexedDB : undefined;
    if (!idb) { reject(new Error('IndexedDB is not available')); return; }
    const req = idb.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('could not open IndexedDB'));
    req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  });
  opening.catch(() => { opening = null; });
  return opening;
}

function run<T>(mode: IDBTransactionMode, f: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = f(tx.objectStore(STORE));
    let result: T;
    req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? req.error ?? new Error('IndexedDB error'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  }));
}

const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Save (insert or replace). Resolves 'ok' or the reason it failed. */
export async function saveSession(s: CollectSession): Promise<string> {
  try { await run('readwrite', (st) => st.put(s)); return 'ok'; } catch (e) { return why(e); }
}

/** Every saved session, newest first. Empty when storage is unavailable. */
export async function listSessions(): Promise<CollectSession[]> {
  try {
    const all = await run<CollectSession[]>('readonly', (st) => st.getAll() as IDBRequest<CollectSession[]>);
    return (all ?? []).filter((s) => s && s.version === 1).sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export async function deleteSession(id: string): Promise<string> {
  try { await run('readwrite', (st) => st.delete(id)); return 'ok'; } catch (e) { return why(e); }
}
