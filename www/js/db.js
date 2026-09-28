/* Spark — IndexedDB storage layer.
   stores: projects, ideas, todos, audio (audio kept separate so lists stay light). */
window.DB = (function () {
  const NAME = 'spark';
  /* v2 adds todos. Records carry ownerId/groupId/updatedAt/rev from the start even though
     the local edition leaves them null, so switching an install to the online edition does
     not need another migration. */
  const VER = 2;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VER);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('projects')) {
          db.createObjectStore('projects', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('ideas')) {
          const s = db.createObjectStore('ideas', { keyPath: 'id' });
          s.createIndex('projectId', 'projectId');
          s.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains('todos')) {
          const s = db.createObjectStore('todos', { keyPath: 'id' });
          s.createIndex('done', 'done');
          s.createIndex('createdAt', 'createdAt');
          s.createIndex('ideaId', 'ideaId');
          s.createIndex('projectId', 'projectId');
        }
        if (!db.objectStoreNames.contains('audio')) {
          db.createObjectStore('audio', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('messages')) {
          // Discussion threads live offline too, so a thread read on the train still reads.
          const s = db.createObjectStore('messages', { keyPath: 'id' });
          s.createIndex('threadId', 'threadId');
          s.createIndex('createdAt', 'createdAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  function wrap(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function st(name, mode) {
    const db = await open();
    return db.transaction(name, mode).objectStore(name);
  }

  return {
    open,
    all: async (name) => wrap((await st(name, 'readonly')).getAll()),
    get: async (name, id) => wrap((await st(name, 'readonly')).get(id)),
    put: async (name, value) => wrap((await st(name, 'readwrite')).put(value)),
    del: async (name, id) => wrap((await st(name, 'readwrite')).delete(id)),
    uid: () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)),
  };
})();
