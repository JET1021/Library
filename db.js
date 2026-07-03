// Couche de stockage 100% locale (IndexedDB). Rien ne quitte l'appareil.
const DB_NAME = "biblio-db";
const DB_VERSION = 1;
const STORE_BOOKS = "books";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_BOOKS)) {
        const store = db.createObjectStore(STORE_BOOKS, { keyPath: "id" });
        store.createIndex("shelf", "shelf", { unique: false });
        store.createIndex("addedAt", "addedAt", { unique: false });
        store.createIndex("title", "title", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const DB = {
  async addBook(book) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_BOOKS, "readwrite");
      tx.objectStore(STORE_BOOKS).put(book);
      tx.oncomplete = () => resolve(book);
      tx.onerror = () => reject(tx.error);
    });
  },

  async updateBook(book) {
    return DB.addBook(book);
  },

  async deleteBook(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_BOOKS, "readwrite");
      tx.objectStore(STORE_BOOKS).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async getBook(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_BOOKS, "readonly");
      const req = tx.objectStore(STORE_BOOKS).get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async getAllBooks() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_BOOKS, "readonly");
      const req = tx.objectStore(STORE_BOOKS).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },

  async estimateUsage() {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      return { usage, quota };
    }
    return null;
  },
};
