// Tiny IndexedDB wrapper. Everything stays on the phone.
const DB_NAME = "garden-log";
const DB_VERSION = 1;

let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("plants")) db.createObjectStore("plants", { keyPath: "id" });
      if (!db.objectStoreNames.contains("photos")) {
        const s = db.createObjectStore("photos", { keyPath: "id" });
        s.createIndex("plantId", "plantId");
      }
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => (result = r));
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const plants = {
  all: () => tx("plants", "readonly", (s) => wrap(s.getAll())),
  get: (id) => tx("plants", "readonly", (s) => wrap(s.get(id))),
  put: (p) => tx("plants", "readwrite", (s) => { p.updatedAt = Date.now(); s.put(p); return p; }),
  async remove(id) {
    const ph = await photos.forPlant(id);
    await tx("photos", "readwrite", (s) => ph.forEach((p) => s.delete(p.id)));
    return tx("plants", "readwrite", (s) => s.delete(id));
  },
};

export const photos = {
  forPlant: (plantId) => tx("photos", "readonly", (s) => wrap(s.index("plantId").getAll(plantId))),
  all: () => tx("photos", "readonly", (s) => wrap(s.getAll())),
  put: (p) => tx("photos", "readwrite", (s) => { s.put(p); return p; }),
  remove: (id) => tx("photos", "readwrite", (s) => s.delete(id)),
};

export const meta = {
  async get(key, fallback = null) {
    const row = await tx("meta", "readonly", (s) => wrap(s.get(key)));
    return row ? row.value : fallback;
  },
  set: (key, value) => tx("meta", "readwrite", (s) => s.put({ key, value })),
};

export async function clearAll() {
  for (const store of ["plants", "photos", "meta"]) await tx(store, "readwrite", (s) => s.clear());
}
