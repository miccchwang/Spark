/* Spark — online edition transport.

   Talks to Supabase over plain REST (GoTrue for auth, PostgREST for data) with fetch and
   no SDK. That keeps the bundle small and means any PostgREST-compatible server works, not
   just Supabase. The endpoint and anon key are configured at runtime from the settings
   sheet, so nothing has to be baked into the build.

   The anon key is public by design — every table is protected by the row level security
   policies in supabase/schema.sql, and the access token below is what identifies the user.

   Everything here is inert until the app is switched to online mode and configured. */
window.Api = (function () {
  const KEY = 'spark.backend';
  const SESSION = 'spark.session';

  let cfg = { url: '', anonKey: '' };
  let session = null;
  let refreshing = null;

  /* ---------------- configuration ---------------- */

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) cfg = Object.assign(cfg, JSON.parse(raw));
      const s = localStorage.getItem(SESSION);
      if (s) session = JSON.parse(s);
    } catch (e) { /* a corrupt entry just means starting signed out */ }
    return cfg;
  }

  function configure(next) {
    cfg = {
      url: String((next && next.url) || '').trim().replace(/\/+$/, ''),
      anonKey: String((next && next.anonKey) || '').trim(),
    };
    try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
    // A different project means the old token is meaningless.
    if (session) signOut();
    return cfg;
  }

  const config = () => ({ url: cfg.url, anonKey: cfg.anonKey });
  const isConfigured = () => /^https?:\/\//.test(cfg.url) && cfg.anonKey.length > 20;
  const currentUser = () => (session && session.user) || null;
  const isSignedIn = () => !!(session && session.access_token);

  /* ---------------- session ---------------- */

  function storeSession(s) {
    session = s ? {
      access_token: s.access_token,
      refresh_token: s.refresh_token,
      // refresh a minute early rather than racing the expiry
      expires_at: Date.now() + ((s.expires_in || 3600) - 60) * 1000,
      user: s.user || (session && session.user) || null,
    } : null;
    try {
      if (session) localStorage.setItem(SESSION, JSON.stringify(session));
      else localStorage.removeItem(SESSION);
    } catch (e) { /* ignore */ }
    return session;
  }

  function signOut() {
    storeSession(null);
  }

  function authHeaders() {
    const h = { 'Content-Type': 'application/json', apikey: cfg.anonKey };
    if (session && session.access_token) h.Authorization = 'Bearer ' + session.access_token;
    return h;
  }

  async function readError(res) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body.error_description || body.msg || body.message || body.hint || body.error || '';
    } catch (e) { /* non-JSON error body */ }
    if (res.status === 401 || res.status === 403) {
      return new Error(detail || '没有权限，请重新登录');
    }
    if (res.status === 404) return new Error(detail || '接口不存在，检查后端地址');
    return new Error(detail || ('请求失败 ' + res.status));
  }

  async function authFetch(path, options) {
    const res = await fetch(cfg.url + path, options);
    if (!res.ok) throw await readError(res);
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /** Refresh the access token if it is about to expire. Safe to call before every request. */
  async function ensureFresh() {
    if (!session) return null;
    if (Date.now() < session.expires_at) return session;
    if (!session.refresh_token) { signOut(); return null; }
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const s = await authFetch('/auth/v1/token?grant_type=refresh_token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: cfg.anonKey },
          body: JSON.stringify({ refresh_token: session.refresh_token }),
        });
        return storeSession(Object.assign({}, s, { user: s.user || session.user }));
      } catch (e) {
        signOut();
        return null;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  /* ---------------- auth ---------------- */

  async function signUp(email, password, displayName) {
    const s = await authFetch('/auth/v1/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: cfg.anonKey },
      body: JSON.stringify({ email: email, password: password }),
    });
    // With email confirmation on, signup returns a user but no session.
    if (!s || !s.access_token) {
      return { needsConfirmation: true, user: (s && s.user) || null };
    }
    storeSession(s);
    if (displayName) await updateProfile({ display_name: displayName }).catch(() => {});
    return { needsConfirmation: false, user: s.user };
  }

  async function signIn(email, password) {
    const s = await authFetch('/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: cfg.anonKey },
      body: JSON.stringify({ email: email, password: password }),
    });
    storeSession(s);
    return s.user;
  }

  /* ---------------- data ---------------- */

  function q(params) {
    const parts = [];
    Object.keys(params || {}).forEach((k) => {
      if (params[k] !== undefined && params[k] !== null) {
        parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
      }
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  async function request(path, options) {
    if (!isConfigured()) throw new Error('还没有配置后端地址');
    await ensureFresh();
    const res = await fetch(cfg.url + path, Object.assign({}, options, { headers: authHeaders() }));
    if (!res.ok) throw await readError(res);
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  const select = (table, params) => request('/rest/v1/' + table + q(params));
  const rpc = (fn, args) =>
    request('/rest/v1/rpc/' + fn, { method: 'POST', body: JSON.stringify(args || {}) });

  const insert = (table, rows, params, opts) =>
    request('/rest/v1/' + table + q(params), {
      method: 'POST',
      // Upsert needs both the on_conflict column list and the merge-duplicates preference;
      // without the preference PostgREST answers a duplicate key with 409.
      headers: Object.assign(authHeaders(), {
        Prefer: 'return=representation' + ((opts && opts.upsert) ? ',resolution=merge-duplicates' : ''),
      }),
      body: JSON.stringify(rows),
    });

  const update = (table, filter, patch) =>
    request('/rest/v1/' + table + q(filter), {
      method: 'PATCH',
      headers: Object.assign(authHeaders(), { Prefer: 'return=representation' }),
      body: JSON.stringify(patch),
    });

  const remove = (table, filter) =>
    request('/rest/v1/' + table + q(filter), { method: 'DELETE' });

  const updateProfile = (patch) => {
    const u = currentUser();
    if (!u) return Promise.reject(new Error('没有登录'));
    return update('profiles', { id: 'eq.' + u.id }, patch);
  };

  /* ---------------- domain helpers ---------------- */

  const myContacts = () =>
    select('contacts', { select: 'id,alias,created_at,contact:contact_id(id,email,display_name)', order: 'created_at.desc' });

  const myGroups = () =>
    select('groups', { select: 'id,name,owner_id,created_at', order: 'created_at.desc' });

  async function addContactByEmail(email, alias) {
    const found = await rpc('find_profile_by_email', { candidate: email });
    const row = Array.isArray(found) ? found[0] : found;
    if (!row || !row.id) throw new Error('没有找到这个邮箱对应的账号');
    if (currentUser() && row.id === currentUser().id) throw new Error('不能把自己加为通讯人');
    return insert('contacts', [{ owner_id: currentUser().id, contact_id: row.id, alias: alias || row.display_name }]);
  }

  const createGroup = (name) => rpc('create_group', { group_name: name });
  const addGroupMember = (groupId, memberId) =>
    rpc('add_group_member', { gid: groupId, who: memberId });

  const groupMembers = (groupId) =>
    select('group_members', {
      group_id: 'eq.' + groupId,
      select: 'group_id,member_id,role,profile:member_id(email,display_name)',
    });

  const groupIdeas = (groupId) =>
    select('shared_ideas', {
      group_id: 'eq.' + groupId,
      select: '*,author:author_id(email,display_name)',
      order: 'shared_at.desc',
    });

  /**
   * Share a local idea into a group.
   *
   * Only text leaves the device — title, note, keywords and where/when it was recorded.
   * The recording itself stays in the local store. Sharing the same idea twice into the
   * same group refreshes the copy rather than failing on the unique key, and sharing it
   * into a second group creates a separate row with its own discussion.
   */
  const shareIdea = (idea, groupId) =>
    insert('shared_ideas', [{
      source_id: idea.id,
      group_id: groupId,
      author_id: currentUser().id,
      title: idea.title || null,
      note: idea.note || null,
      keywords: (idea.keywords || []).slice(0, 12),
      duration_ms: idea.durationMs || null,
      recorded_at: idea.createdAt ? new Date(idea.createdAt).toISOString() : null,
      lat: idea.lat,
      lon: idea.lon,
    }], { on_conflict: 'source_id,group_id' }, { upsert: true });

  const thread = (shareId) =>
    select('messages', {
      share_id: 'eq.' + shareId,
      select: '*,author:author_id(email,display_name)',
      order: 'created_at.asc',
    });

  const postMessage = (msg) =>
    insert('messages', [Object.assign({ author_id: currentUser().id }, msg)]);

  const groupTodos = (groupId) =>
    select('shared_todos', {
      group_id: 'eq.' + groupId,
      select: '*,assignee:assignee_id(email,display_name),creator:created_by(email,display_name)',
      order: 'done.asc,created_at.desc',
    });

  return {
    load,
    configure,
    config,
    isConfigured,
    isSignedIn,
    currentUser,
    signUp,
    signIn,
    signOut,
    ensureFresh,
    select,
    insert,
    update,
    remove,
    rpc,
    updateProfile,
    myContacts,
    myGroups,
    addContactByEmail,
    createGroup,
    addGroupMember,
    groupMembers,
    groupIdeas,
    shareIdea,
    thread,
    postMessage,
    groupTodos,
  };
})();
