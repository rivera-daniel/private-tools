// Passes one file from one tool page to another. The file is kept in this browser's IndexedDB,
// never sent anywhere, and deleted when the receiving page reads it or the next time any tool
// page loads.
const DB = 'private-tools';
const STORE = 'handoff';
const KEY = 'file';
const MAX_AGE_MS = 60000;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const result = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(result?.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

export const sendFile = (file) => run('readwrite', (store) => store.put({ file, at: Date.now() }, KEY));

// Returns the waiting file, or null when there is none or it is stale. Always deletes it.
export async function takeFile() {
  const entry = await run('readwrite', (store) => { const req = store.get(KEY); store.delete(KEY); return req; });
  return entry && Date.now() - entry.at < MAX_AGE_MS ? entry.file : null;
}

export const clearFile = () => run('readwrite', (store) => store.delete(KEY)).catch(() => {});
