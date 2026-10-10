// IndexedDB storage. Everything stays in this browser on this device.

const DB_NAME = 'receipts';
const VERSION = 1;
let dbp;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('receipts')) db.createObjectStore('receipts', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const getAll = () => tx('receipts', 'readonly', (s) => s.getAll());
export const put = (r) => tx('receipts', 'readwrite', (s) => s.put(r));
export const putMany = (rs) => tx('receipts', 'readwrite', (s) => rs.forEach((r) => s.put(r)));
export const remove = (id) => tx('receipts', 'readwrite', (s) => s.delete(id));
export const clearAll = () => tx('receipts', 'readwrite', (s) => s.clear());
export const getSetting = (k) => tx('settings', 'readonly', (s) => s.get(k));
export const setSetting = (k, v) => tx('settings', 'readwrite', (s) => s.put(v, k));
export const clearSettings = () => tx('settings', 'readwrite', (s) => s.clear());
