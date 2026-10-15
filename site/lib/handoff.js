// Passes one file from one tool page to another in the same tab. Nothing is sent anywhere.
// The file is encrypted with a fresh AES-GCM key and the ciphertext is kept in IndexedDB. The key
// lives only in this tab's sessionStorage, so a copy left behind by an interrupted navigation
// cannot be read once the tab is closed. The receiving page deletes both when it reads them, and
// any tool page deletes a leftover copy when it loads.
const DB = 'private-tools';
const STORE = 'handoff';
const KEY = 'file';
const SESSION_KEY = 'private-tools-handoff-key';
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

const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function sendFile(file) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  // The name and type travel inside the ciphertext, ahead of the bytes.
  const head = new TextEncoder().encode(JSON.stringify({ name: file.name, type: file.type, lastModified: file.lastModified }));
  const plain = new Uint8Array(4 + head.length + file.size);
  new DataView(plain.buffer).setUint32(0, head.length);
  plain.set(head, 4); plain.set(new Uint8Array(await file.arrayBuffer()), 4 + head.length);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  sessionStorage.setItem(SESSION_KEY, b64(new Uint8Array(await crypto.subtle.exportKey('raw', key))));
  await run('readwrite', (store) => store.put({ iv, data, at: Date.now() }, KEY));
}

// Returns the waiting file, or null when there is none, it is stale or its key is gone. Always deletes it.
export async function takeFile() {
  const raw = sessionStorage.getItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_KEY);
  const entry = await run('readwrite', (store) => { const req = store.get(KEY); store.delete(KEY); return req; });
  if (!entry || !raw || !entry.data || Date.now() - entry.at >= MAX_AGE_MS) return null;
  const key = await crypto.subtle.importKey('raw', unb64(raw), 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: entry.iv }, key, entry.data));
  const length = new DataView(plain.buffer).getUint32(0);
  const meta = JSON.parse(new TextDecoder().decode(plain.subarray(4, 4 + length)));
  return new File([plain.subarray(4 + length)], meta.name, { type: meta.type, lastModified: meta.lastModified });
}

export function clearFile() {
  sessionStorage.removeItem(SESSION_KEY);
  return run('readwrite', (store) => store.delete(KEY)).catch(() => {});
}
