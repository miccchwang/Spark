/* Spark — IndexedDB storage layer.
   stores: projects, ideas, todos, audio, images, messages, boards, nodes, edges
   (audio and images are kept separate from ideas so the lists stay light — a card reads the
   idea row only, never a megabyte of pixels. The canvas works the same way: a board row is
   tiny, and its nodes and edges are separate rows so dragging one node writes one row
   instead of rewriting the whole board.) */
window.DB = (function () {
  const NAME = 'spark';
  /* v2 adds todos. Records carry ownerId/groupId/updatedAt/rev from the start even though
     the local edition leaves them null, so switching an install to the online edition does
     not need another migration.
     v3 adds images. An idea's kind ('voice' | 'text' | 'photo') is stored on the idea row;
     older rows have no kind and are read as 'voice', which is what they are.
     v4 adds the canvas: boards, nodes and edges. */
  const VER = 4;
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
        if (!db.objectStoreNames.contains('images')) {
          // One idea can carry several photos, so this is a child store keyed by its own id
          // with an ideaId index rather than a 1:1 mirror of the idea row like audio is.
          const s = db.createObjectStore('images', { keyPath: 'id' });
          s.createIndex('ideaId', 'ideaId');
          s.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains('messages')) {
          // Discussion threads live offline too, so a thread read on the train still reads.
          const s = db.createObjectStore('messages', { keyPath: 'id' });
          s.createIndex('threadId', 'threadId');
          s.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains('boards')) {
          const s = db.createObjectStore('boards', { keyPath: 'id' });
          s.createIndex('updatedAt', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('nodes')) {
          // One board holds many nodes, so boardId is the index everything reads by.
          const s = db.createObjectStore('nodes', { keyPath: 'id' });
          s.createIndex('boardId', 'boardId');
          s.createIndex('ideaId', 'ideaId');
          s.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains('edges')) {
          // An edge is its own row rather than a list on the node, because deleting a node
          // then has to remove exactly the edges that touch it — an index scan, not a
          // rewrite of every node that happened to point at it.
          const s = db.createObjectStore('edges', { keyPath: 'id' });
          s.createIndex('boardId', 'boardId');
          s.createIndex('from', 'from');
          s.createIndex('to', 'to');
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
    /* Read one index of a store, e.g. every photo belonging to one idea. */
    byIndex: async (name, index, value) =>
      wrap((await st(name, 'readonly')).index(index).getAll(value)),
    /* Delete many rows in a single transaction, so a cascade is all-or-nothing
       rather than a loop of separate commits. */
    delMany: async (name, ids) => {
      const s = await st(name, 'readwrite');
      await Promise.all(ids.map((id) => wrap(s.delete(id))));
    },
    uid: () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)),
  };
})();
