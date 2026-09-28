/* Spark — capture ideas as voice notes with time and place, filed into projects. */
(function () {
  const S = {
    projects: [],
    ideas: [],
    todos: [],
    view: 'inbox',        // 'inbox' | 'todos' | 'people' | 'group:<id>' | project id
    query: '',
    theme: 'dark',
    audioEl: null,
    audioId: null,
    currentId: null,
    newIcon: 'bulb',
    delArmed: false,
    pending: null,        // a finished capture waiting for its topic, not yet persisted:
                          // { kind: 'voice'|'text'|'photo', blob?, shots?, lat, lon, projectId }
    speech: null,         // result of the offline recogniser probe
    distill: null,        // the payload currently shown in the distill sheet
    mode: 'local',        // 'local' keeps everything on device; 'online' adds the backend
    contacts: [],
    groups: [],
    groupData: {},        // gid -> { ideas, todos, members }, filled lazily per group
    thread: null,         // the discussion currently open: { idea, group, messages, todos, members }
    threadTodosOpen: true,// whether the thread's action list is unfolded
    shareIdea: null,      // the local idea waiting to be sent to a group
    groupEdit: null,      // null = creating, a group = adding members to it
    cmdPick: 0,           // highlighted row in the command palette
  };

  const $ = (s) => document.querySelector(s);

  /* project marks come from the icon sprite — monochrome, never emoji */
  const ICONS = ['bulb', 'rocket', 'target', 'brain', 'book', 'palette',
    'run', 'case', 'sprout', 'bowl', 'plane', 'flask'];
  const LEGACY_EMOJI = {
    '💡': 'bulb', '🚀': 'rocket', '🎯': 'target', '🧠': 'brain', '📚': 'book',
    '🎨': 'palette', '🏃': 'run', '💼': 'case', '🌱': 'sprout', '🍜': 'bowl',
    '✈️': 'plane', '✈': 'plane', '🧪': 'flask',
  };
  const icon = (name, cls) =>
    '<svg class="ico' + (cls ? ' ' + cls : '') + '"><use href="#i-' + name + '"/></svg>';
  const iconOf = (p) => (p && (p.icon || LEGACY_EMOJI[p.emoji])) || 'folder';

  /* ---------------- helpers ---------------- */
  const pad = (n) => String(n).padStart(2, '0');

  function fmtDur(ms) {
    const s = Math.max(0, Math.round((ms || 0) / 1000));
    return pad(Math.floor(s / 60)) + ':' + pad(s % 60);
  }

  function fmtWhen(ts) {
    const d = new Date(ts), now = new Date();
    const y = new Date(now.getTime() - 86400000);
    let day;
    if (d.toDateString() === now.toDateString()) day = '今天';
    else if (d.toDateString() === y.toDateString()) day = '昨天';
    else day = (d.getMonth() + 1) + '月' + d.getDate() + '日';
    return day + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function fmtFull(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  const findIdea = (id) => S.ideas.find((i) => i.id === id);
  const projName = (id) => (S.projects.find((p) => p.id === id) || {}).name || '收件箱';
  const countIn = (pid) => S.ideas.filter((i) => (i.projectId || null) === pid).length;

  const findTodo = (id) => S.todos.find((t) => t.id === id);
  const openTodos = () => S.todos.filter((t) => !t.done);
  const ideaText = (i) => [i.title, i.note].filter(Boolean).join('。');

  /* An idea arrives one of three ways. Rows written before photos existed carry no kind
     and are, correctly, recordings. */
  const KIND_ICON = { voice: 'timer', text: 'edit', photo: 'camera' };
  const KIND_LABEL = { voice: '语音', text: '文字', photo: '照片' };
  const ideaKind = (i) => i.kind || 'voice';

  /* The third line of a card's meta: how long it runs, or what it is made of. */
  function kindMeta(i) {
    const kind = ideaKind(i);
    if (kind === 'voice') return icon('timer', 'sm') + '<span>' + fmtDur(i.durationMs) + '</span>';
    if (kind === 'photo') {
      return icon('camera', 'sm') + '<span>' + (i.photoCount || 1) + ' 张照片</span>';
    }
    return icon('edit', 'sm') + '<span>文字</span>';
  }

  /* Distillation ranks terms against the user's own corpus, so the IDF table is rebuilt
     whenever the ideas change and reused across every render in between. */
  let idfCache = null;
  function corpusIdf() {
    if (!idfCache) idfCache = window.Summarize.buildIdf(S.ideas.map(ideaText));
    return idfCache;
  }
  function invalidateCorpus() { idfCache = null; }

  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2000);
  }

  /* ---------------- theme ---------------- */
  function setTheme(t) {
    S.theme = t;
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('spark.theme', t); } catch (e) { /* ignore */ }
    $('#themeBtn').innerHTML = icon(t === 'dark' ? 'sun' : 'moon');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#000000' : '#ffffff');
  }

  /* ---------------- rendering ---------------- */
  function visibleIdeas() {
    let list = S.ideas.filter((i) => (S.view === 'inbox' ? !i.projectId : i.projectId === S.view));
    if (S.query) {
      const q = S.query.toLowerCase();
      list = list.filter((i) => (i.title || '').toLowerCase().includes(q) || (i.note || '').toLowerCase().includes(q));
    }
    return list.sort((a, b) => b.createdAt - a.createdAt);
  }

  function renderHeader() {
    const distillBtn = $('#distillBtn');
    if (S.view === 'todos') {
      $('#viewTitle').textContent = '待办';
      $('#viewSub').textContent = openTodos().length + ' / ' + S.todos.length + ' 项';
      $('#recMeta').textContent = '录音仍然存成灵感，提炼后可以一键转成待办';
      distillBtn.hidden = true;
      return;
    }
    if (S.view === 'people') {
      $('#viewTitle').textContent = '社群';
      $('#viewSub').textContent = S.contacts.length + ' 位通讯人 · ' + S.groups.length + ' 个群组';
      $('#recMeta').textContent = '录音照旧存在本机；分享是把某一条灵感单独发到群里';
      distillBtn.hidden = true;
      return;
    }
    if (S.view.indexOf('group:') === 0) {
      const g = findGroup(S.view.slice(6));
      const d = S.groupData[S.view.slice(6)] || {};
      $('#viewTitle').textContent = (g && g.name) || '群组';
      $('#viewSub').textContent = ((d.ideas || []).length) + ' 条分享 · ' +
        ((d.members || []).length) + ' 位成员';
      $('#recMeta').textContent = '点开一条分享，可以在讨论区用 / 命令直接生成待办或摘要';
      distillBtn.hidden = true;
      return;
    }
    distillBtn.hidden = false;

    const isInbox = S.view === 'inbox';
    $('#viewTitle').textContent = isInbox ? '收件箱' : projName(S.view);
    $('#viewSub').textContent = visibleIdeas().length + ' 个灵感';
    $('#recMeta').textContent = isInbox
      ? '长按卡片可拖到上方项目归档'
      : '新记录会存进「' + projName(S.view) + '」';
  }

  function makeChip(o) {
    const b = document.createElement('button');
    b.className = 'chip' + (o.active ? ' active' : '');
    b.setAttribute('data-drop', o.drop);
    b.innerHTML = icon(o.icon) + '<span class="label"></span><span class="count"></span>';
    b.querySelector('.label').textContent = o.label;
    b.querySelector('.count').textContent = o.count;
    b.addEventListener('click', () => { S.view = o.drop; render(); });
    if (o.project) attachChipLongPress(b, o.project);
    return b;
  }

  function renderRail() {
    const rail = $('#projectRail');
    rail.innerHTML = '';
    rail.appendChild(makeChip({ drop: 'inbox', label: '收件箱', icon: 'tray', count: countIn(null), active: S.view === 'inbox' }));
    rail.appendChild(makeChip({ drop: 'todos', label: '待办', icon: 'check', count: openTodos().length, active: S.view === 'todos' }));
    if (S.mode === 'online') {
      rail.appendChild(makeChip({
        drop: 'people',
        label: '社群',
        icon: 'plane',
        count: S.groups.length,
        active: S.view === 'people' || S.view.indexOf('group:') === 0,
      }));
    }
    S.projects.forEach((p) => {
      rail.appendChild(makeChip({ drop: p.id, label: p.name, icon: iconOf(p), count: countIn(p.id), active: S.view === p.id, project: p }));
    });
    const add = document.createElement('button');
    add.className = 'chip add';
    add.innerHTML = icon('plus') + '<span>新项目</span>';
    add.addEventListener('click', openProjectSheet);
    rail.appendChild(add);
  }

  function renderList() {
    const list = $('#ideaList');
    list.innerHTML = '';
    if (S.view === 'todos') { renderTodos(list); return; }
    if (S.view === 'people') { renderPeople(list); return; }
    if (S.view.indexOf('group:') === 0) { renderGroupView(list, S.view.slice(6)); return; }

    const items = visibleIdeas();
    if (!items.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.innerHTML = S.query
        ? icon('search', 'lg big') + '没有匹配的灵感'
        : icon('spark', 'lg big') + '这里还空着<br>写下来、拍下来，或者说出来';
      list.appendChild(e);
      return;
    }
    items.forEach((i) => list.appendChild(makeCard(i)));
  }

  function makeCard(i) {
    const kind = ideaKind(i);
    const el = document.createElement('div');
    el.className = 'card';
    el.dataset.id = i.id;
    el.innerHTML =
      '<div class="card-top"><span class="grip">' + icon('grip') + '</span>' +
      '<div class="card-body"><p class="card-title"></p><div class="card-meta">' +
      '<span class="m-when"></span><span class="m-loc"></span><span class="m-kind"></span>' +
      '</div><p class="card-note"></p></div>' +
      '<div class="card-tail"></div></div>';

    const title = el.querySelector('.card-title');
    title.textContent = i.title || '未命名灵感';
    if (!i.title) title.classList.add('untitled');

    el.querySelector('.m-when').innerHTML = icon('clock', 'sm') + '<span>' + fmtWhen(i.createdAt) + '</span>';
    el.querySelector('.m-loc').innerHTML = icon('pin', 'sm') + '<span>' +
      (i.lat == null ? '无位置' : i.lat.toFixed(2) + ', ' + i.lon.toFixed(2)) + '</span>';
    el.querySelector('.m-kind').innerHTML = kindMeta(i);

    const note = el.querySelector('.card-note');
    if (i.note) {
      note.textContent = i.note;
      // A typed idea's note *is* the idea, so it can run long — keep the list scannable.
      if (kind === 'text') note.classList.add('clamp');
    } else {
      note.remove();
    }

    /* The trailing slot: a play button for a recording, the picture itself for a photo,
       and nothing at all for typed text. */
    const tail = el.querySelector('.card-tail');
    if (kind === 'voice') {
      const play = document.createElement('button');
      play.className = 'play';
      play.setAttribute('aria-label', '播放');
      play.innerHTML = icon('play');
      play.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(i.id); });
      tail.appendChild(play);
    } else if (kind === 'photo') {
      const shot = document.createElement('div');
      shot.className = 'card-shot';
      if (i.thumb) {
        const img = document.createElement('img');
        img.src = i.thumb;
        img.alt = '';
        shot.appendChild(img);
      } else {
        // Undecodable source format, or a photo restored from a backup without pixels.
        shot.classList.add('blank');
        shot.innerHTML = icon('camera');
      }
      tail.appendChild(shot);
    }

    el.addEventListener('click', (e) => {
      if (e.target.closest('.play')) return;
      openDetail(i.id);
    });

    window.DnD.attach(el, { getData: () => i.id, onDrop: handleDrop });
    return el;
  }

  function render() { renderRail(); renderList(); renderHeader(); syncPlayIcons(); }

  /* ---------------- drag to archive ---------------- */
  async function handleDrop(dropId, ideaId) {
    const i = findIdea(ideaId);
    if (!i) return;
    const pid = dropId === 'inbox' ? null : dropId;
    if ((i.projectId || null) === pid) { toast('已经在这个项目里了'); return; }
    i.projectId = pid;
    await window.DB.put('ideas', i);
    render();
    toast(pid ? '已归档到「' + projName(pid) + '」' : '已移回收件箱');
  }

  /* ---------------- projects ---------------- */
  function openProjectSheet() {
    $('#pName').value = '';
    S.newIcon = 'bulb';
    const row = $('#pEmoji');
    row.querySelectorAll('button').forEach((b, i) => b.classList.toggle('sel', i === 0));
    $('#projectSheet').hidden = false;
    setTimeout(() => $('#pName').focus(), 120);
  }

  async function createProject() {
    const name = $('#pName').value.trim();
    if (!name) { toast('先给项目起个名字'); return; }
    const p = { id: window.DB.uid(), name, icon: S.newIcon, createdAt: Date.now() };
    await window.DB.put('projects', p);
    S.projects.push(p);
    $('#projectSheet').hidden = true;
    render();
    toast('项目「' + name + '」已创建');
  }

  function attachChipLongPress(el, p) {
    let t = 0, moved = false;
    el.addEventListener('pointerdown', () => {
      moved = false;
      t = setTimeout(() => { if (!moved) projectActions(p); }, 620);
    });
    const cancel = () => clearTimeout(t);
    el.addEventListener('pointermove', (e) => {
      if (Math.abs(e.movementX || 0) > 6 || Math.abs(e.movementY || 0) > 6) { moved = true; cancel(); }
    });
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointercancel', cancel);
  }

  function showActions(title, items) {
    const wrap = document.createElement('div');
    wrap.className = 'sheet';
    const card = document.createElement('div');
    card.className = 'sheet-card';
    const head = document.createElement('div');
    head.className = 'sheet-head';
    const h = document.createElement('h2');
    h.textContent = title;
    const x = document.createElement('button');
    x.className = 'icon-btn bare';
    x.innerHTML = icon('close');
    x.addEventListener('click', () => wrap.remove());
    head.append(h, x);
    card.appendChild(head);
    const list = document.createElement('div');
    list.className = 'move-list';
    items.forEach((it) => {
      const b = document.createElement('button');
      b.className = 'move-item';
      if (it.icon) {
        b.innerHTML = icon(it.icon) + '<span></span>';
        b.querySelector('span').textContent = it.label;
      } else {
        b.textContent = it.label;
      }
      b.addEventListener('click', () => { wrap.remove(); if (it.run) it.run(); });
      list.appendChild(b);
    });
    card.appendChild(list);
    wrap.appendChild(card);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
    document.body.appendChild(wrap);
  }

  function openIconPicker(p) {
    const wrap = document.createElement('div');
    wrap.className = 'sheet';
    wrap.innerHTML =
      '<div class="sheet-card"><div class="grabber"></div>' +
      '<div class="sheet-head"><h2>项目图标</h2>' +
      '<button class="icon-btn bare" data-x>' + icon('close') + '</button></div>' +
      '<div class="pick-row"></div></div>';
    const row = wrap.querySelector('.pick-row');
    ICONS.forEach((n) => {
      const b = document.createElement('button');
      b.innerHTML = icon(n);
      if (iconOf(p) === n) b.classList.add('sel');
      b.addEventListener('click', async () => {
        p.icon = n;
        delete p.emoji;
        await window.DB.put('projects', p);
        wrap.remove();
        render();
      });
      row.appendChild(b);
    });
    wrap.querySelector('[data-x]').addEventListener('click', () => wrap.remove());
    wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
    document.body.appendChild(wrap);
  }

  function projectActions(p) {
    showActions(p.name, [
      {
        label: '重命名', icon: 'edit',
        run: async () => {
          const n = prompt('新项目名称', p.name);
          if (n && n.trim()) { p.name = n.trim(); await window.DB.put('projects', p); render(); }
        },
      },
      {
        label: '换图标', icon: 'palette',
        run: () => openIconPicker(p),
      },
      {
        label: '删除项目', icon: 'trash',
        run: async () => {
          if (!confirm('删除「' + p.name + '」？其中的灵感会移回收件箱。')) return;
          for (const i of S.ideas) {
            if (i.projectId === p.id) { i.projectId = null; await window.DB.put('ideas', i); }
          }
          await window.DB.del('projects', p.id);
          S.projects = S.projects.filter((x) => x.id !== p.id);
          if (S.view === p.id) S.view = 'inbox';
          render();
          toast('项目已删除');
        },
      },
      { label: '取消' },
    ]);
  }

  /* ---------------- audio playback ---------------- */
  function stopAudio() {
    if (S.audioEl) {
      S.audioEl.pause();
      try { URL.revokeObjectURL(S.audioEl.src); } catch (e) { /* ignore */ }
    }
    S.audioEl = null;
    S.audioId = null;
    syncPlayIcons();
  }

  async function togglePlay(id) {
    if (S.audioId === id && S.audioEl) {
      if (S.audioEl.paused) S.audioEl.play().catch(() => toast('无法播放'));
      else S.audioEl.pause();
      syncPlayIcons();
      return;
    }
    stopAudio();
    const rec = await window.DB.get('audio', id);
    if (!rec || !rec.blob) { toast('这段录音已丢失'); return; }
    const el = new Audio(URL.createObjectURL(rec.blob));
    S.audioEl = el;
    S.audioId = id;
    el.addEventListener('ended', () => stopAudio());
    el.addEventListener('timeupdate', updateSeek);
    el.addEventListener('loadedmetadata', updateSeek);
    el.play().catch(() => toast('无法播放'));
    syncPlayIcons();
  }

  function syncPlayIcons() {
    document.querySelectorAll('.play').forEach((b) => {
      const card = b.closest('.card');
      if (!card) return;
      const playing = S.audioId === card.dataset.id && S.audioEl && !S.audioEl.paused;
      b.innerHTML = icon(playing ? 'pause' : 'play');
      b.classList.toggle('on', !!playing);
    });
    const dp = $('#dPlay');
    if (dp) {
      const playing = S.audioId === S.currentId && S.audioEl && !S.audioEl.paused;
      dp.innerHTML = icon(playing ? 'pause' : 'play');
      dp.classList.toggle('on', !!playing);
    }
  }

  function updateSeek() {
    if (!S.audioEl) return;
    const el = S.audioEl;
    const dur = el.duration || 0;
    const seek = $('#dSeek');
    if (seek && S.currentId === S.audioId) {
      if (!seek.dataset.scrubbing) seek.value = dur ? (el.currentTime / dur) * 100 : 0;
      $('#dDur').textContent = fmtDur(el.currentTime * 1000) + (dur ? ' / ' + fmtDur(dur * 1000) : '');
    }
  }

  /* ---------------- detail sheet ---------------- */
  function metaRow(name, html) {
    return '<div class="row">' + icon(name, 'sm') + '<span>' + html + '</span></div>';
  }

  function openDetail(id) {
    const i = findIdea(id);
    if (!i) return;
    const kind = ideaKind(i);
    S.currentId = id;
    S.delArmed = false;
    $('#dName').value = i.title || '';
    $('#dNote').value = i.note || '';
    $('#dDelete').textContent = '删除';
    $('#dDelete').classList.remove('armed');
    $('#detailSheet').hidden = false;

    const where = i.lat == null
      ? '未记录位置'
      : i.lat.toFixed(5) + ', ' + i.lon.toFixed(5) +
        ' · <a href="geo:0,0?q=' + i.lat + ',' + i.lon + '">在地图中查看</a>';
    const inProj = i.projectId ? projName(i.projectId) : '收件箱（未归档）';
    const what = kind === 'voice'
      ? '时长 ' + fmtDur(i.durationMs)
      : (kind === 'photo' ? (i.photoCount || 1) + ' 张照片' : '文字灵感');
    $('#dMeta').innerHTML =
      metaRow('clock', fmtFull(i.createdAt)) +
      metaRow('pin', where) +
      metaRow('folder', inProj) +
      metaRow(KIND_ICON[kind], what);

    // Only a recording has a player, and only a recording has anything to transcribe.
    const isVoice = kind === 'voice';
    $('#dPlayerWrap').hidden = !isVoice;
    $('#dTransRow').hidden = !isVoice;
    $('#dDur').textContent = '00:00';
    $('#dSeek').value = 0;
    renderDetailShots(i);
    syncPlayIcons();
  }

  /* ---------- the photos of one idea ---------- */

  /* Loaded when the detail sheet opens and released when it closes: the list itself
     draws from the inline thumbnail and never touches this store. */
  async function renderDetailShots(i) {
    const box = $('#dShots');
    window.Photo.release();
    box.innerHTML = '';

    if (ideaKind(i) !== 'photo') { box.hidden = true; return; }

    let recs = [];
    try {
      recs = await window.DB.byIndex('images', 'ideaId', i.id);
    } catch (e) {
      recs = [];
    }
    recs.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    if (!recs.length) {
      box.hidden = false;
      box.innerHTML = '<p class="hint">' +
        (i.imageMissing ? '照片不在本机：导入的备份里没有带上这些图片' : '照片已丢失') + '</p>';
      return;
    }
    box.hidden = false;
    recs.forEach((r, n) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'shot';
      const img = document.createElement('img');
      img.src = window.Photo.url(r);
      img.alt = '照片 ' + (n + 1);
      b.appendChild(img);
      b.addEventListener('click', () => openViewer(recs, n));
      box.appendChild(b);
    });
  }

  /* ---------- full-screen viewer ---------- */

  let viewer = null;
  const viewerUrls = new Map();

  function openViewer(recs, at) {
    viewer = { recs, at };
    viewerUrls.clear();
    paintViewer();
    $('#shotViewer').hidden = false;
  }

  function viewerUrl(r) {
    if (!viewerUrls.has(r.id)) viewerUrls.set(r.id, window.Photo.url(r));
    return viewerUrls.get(r.id);
  }

  function paintViewer() {
    if (!viewer) return;
    const r = viewer.recs[viewer.at];
    if (!r) return;
    $('#shotImg').src = viewerUrl(r);
    $('#shotCount').textContent = (viewer.at + 1) + ' / ' + viewer.recs.length;
    $('#shotPrev').disabled = viewer.at === 0;
    $('#shotNext').disabled = viewer.at === viewer.recs.length - 1;
    $('#shotNav').hidden = viewer.recs.length < 2;
    $('#shotInfo').textContent = (r.w && r.h ? r.w + ' × ' + r.h + ' · ' : '') +
      window.Backup.human((r.blob && r.blob.size) || 0);
  }

  function closeViewer() {
    viewer = null;
    viewerUrls.clear();
    $('#shotImg').removeAttribute('src');
    $('#shotViewer').hidden = true;
  }

  function stepViewer(delta) {
    if (!viewer) return;
    const next = viewer.at + delta;
    if (next < 0 || next >= viewer.recs.length) return;
    viewer.at = next;
    paintViewer();
  }

  async function saveDetailFields() {
    const i = findIdea(S.currentId);
    if (!i) return;
    i.title = $('#dName').value.trim();
    i.note = $('#dNote').value;
    i.updatedAt = Date.now();
    i.rev = (i.rev || 1) + 1;
    await window.DB.put('ideas', i);
    invalidateCorpus();
    render();
  }

  async function deleteIdea() {
    const i = findIdea(S.currentId);
    if (!i) return;
    if (!S.delArmed) {
      S.delArmed = true;
      $('#dDelete').textContent = '确认删除？';
      $('#dDelete').classList.add('armed');
      return;
    }
    if (S.audioId === i.id) stopAudio();
    closeViewer();
    window.Photo.release();
    // The photos are a child store, so they do not go away with the idea row.
    try {
      const shots = await window.DB.byIndex('images', 'ideaId', i.id);
      if (shots.length) await window.DB.delMany('images', shots.map((s) => s.id));
    } catch (e) { /* nothing stored under this idea */ }
    await window.DB.del('ideas', i.id);
    await window.DB.del('audio', i.id);
    S.ideas = S.ideas.filter((x) => x.id !== i.id);
    invalidateCorpus();
    $('#detailSheet').hidden = true;
    render();
    toast('已删除');
  }

  function openMoveSheet() {
    const i = findIdea(S.currentId);
    if (!i) return;
    const box = $('#moveList');
    box.innerHTML = '';
    const opts = [{ id: null, name: '收件箱', icon: 'tray' }].concat(S.projects);
    opts.forEach((p) => {
      const here = (i.projectId || null) === p.id;
      const b = document.createElement('button');
      b.className = 'move-item' + (here ? ' current' : '');
      b.innerHTML = icon(p.icon || 'tray') + '<span></span>' + (here ? '<span class="tag">当前</span>' : '');
      b.querySelector('span').textContent = p.name;
      b.addEventListener('click', async () => {
        i.projectId = p.id;
        await window.DB.put('ideas', i);
        $('#moveSheet').hidden = true;
        $('#detailSheet').hidden = true;
        render();
        toast(p.id ? '已归档到「' + p.name + '」' : '已移回收件箱');
      });
      box.appendChild(b);
    });
    $('#moveSheet').hidden = false;
  }

  /* ---------------- recording ---------------- */
  let recInterval = 0;
  let locPromise = null;
  let bars = [];

  function buildBars() {
    const box = $('#recLevel');
    box.innerHTML = '';
    bars = [];
    for (let i = 0; i < 26; i++) {
      const b = document.createElement('i');
      box.appendChild(b);
      bars.push(b);
    }
  }

  function onLevel(v) {
    bars.forEach((b, i) => {
      const jitter = 0.35 + Math.random() * 0.65;
      const h = 6 + v * 38 * jitter;
      b.style.height = Math.min(46, h) + 'px';
    });
  }

  function fetchLocation() {
    locPromise = new Promise((resolve) => {
      if (!navigator.geolocation) { resolve(null); return; }
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
      );
    });
  }

  async function startRecording() {
    if (S.pending) { toast('先把上一条灵感存好'); return; }
    if (!window.Rec.isSupported()) { toast('这个环境不支持录音'); return; }
    try {
      await window.Rec.start(onLevel);
    } catch (e) {
      const name = (e && e.name) || 'Error';
      let hint;
      if (name === 'NotAllowedError') hint = '麦克风权限被拒绝，请在系统设置里允许 Spark 使用麦克风';
      else if (name === 'NotFoundError') hint = '没有找到可用的麦克风';
      else if (name === 'NotReadableError') hint = '麦克风被其他应用占用，请关掉后重试';
      else hint = '无法使用麦克风（' + name + '）';
      toast(hint);
      return;
    }
    fetchLocation();
    $('#recPanel').hidden = false;
    const t0 = Date.now();
    clearInterval(recInterval);
    recInterval = setInterval(() => {
      $('#recTime').textContent = fmtDur(Date.now() - t0);
    }, 200);
  }

  async function finishRecording() {
    let out;
    try {
      out = await window.Rec.stop();
    } catch (e) {
      clearInterval(recInterval);
      $('#recPanel').hidden = true;
      toast('录音失败');
      return;
    }
    clearInterval(recInterval);
    $('#recPanel').hidden = true;

    if (!out.blob || out.blob.size < 500) { toast('录音太短，已丢弃'); return; }

    // Nothing is written yet. The save sheet collects the topic first, so a recording the
    // user walks away from never lands in the database.
    openSaveSheet({
      kind: 'voice',
      blob: out.blob,
      mime: out.mime,
      durationMs: out.durationMs,
    });
  }

  async function cancelRecording() {
    await window.Rec.cancel();
    clearInterval(recInterval);
    $('#recPanel').hidden = true;
    toast('已丢弃');
  }

  /* ---------------- three ways in: text, photo, voice ---------------- */

  /* Typed ideas need no permission and no picker, so they go straight to the save sheet. */
  function startText() {
    if (S.pending) { toast('先把上一条灵感存好'); return; }
    fetchLocation();
    openSaveSheet({ kind: 'text' });
  }

  /* The picker has to be opened synchronously inside the tap, before the first await,
     or the WebView stops treating it as a user gesture and the dialog never appears. */
  async function startPhoto(fromCamera) {
    if (S.pending) { toast('先把上一条灵感存好'); return; }
    const picking = fromCamera ? window.Photo.camera() : window.Photo.gallery();
    fetchLocation();                       // start the fix while the camera is open
    let shots = [];
    try {
      shots = await picking;
    } catch (e) {
      toast('无法读取照片');
      return;
    }
    if (!shots.length) return;             // backed out of the picker
    openSaveSheet({ kind: 'photo', shots });
  }

  /* ---------------- save sheet: topic before the idea is stored ---------------- */

  function openSaveSheet(pend) {
    /* Capture from inside a project files into it. The guard matters: the rail's other
       entries (待办 / 社群) are views, not projects, and using one as a projectId would
       file the idea under an id no list ever shows. */
    const inProject = S.projects.some((x) => x.id === S.view) ? S.view : null;
    const p = Object.assign({ lat: null, lon: null, projectId: inProject }, pend);
    S.pending = p;
    const kind = p.kind || 'voice';

    $('#sTitle').value = '';
    $('#sNote').value = '';
    applySavePlaceholders(kind);
    renderSaveMeta();
    renderSaveShots();
    renderSaveProjects();

    // Only a recording has anything to transcribe.
    $('#sTransRow').hidden = kind !== 'voice';
    resetTransStatus($('#sTransStatus'));

    $('#saveSheet').hidden = false;
    setTimeout(() => {
      // For typed text the note *is* the content, so that is where the cursor belongs.
      (kind === 'text' ? $('#sNote') : $('#sTitle')).focus();
    }, 150);

    // Location arrives when it arrives. Making the sheet wait for a GPS fix used to stall
    // it for up to twelve seconds on a cold start.
    if (locPromise) {
      locPromise.then((loc) => {
        if (S.pending !== p || !loc) return;
        p.lat = loc.lat;
        p.lon = loc.lon;
        renderSaveMeta();
      });
    }
  }

  function applySavePlaceholders(kind) {
    const t = $('#sTitle');
    const n = $('#sNote');
    if (kind === 'text') {
      t.placeholder = '主题（可选）';
      n.placeholder = '把想法写下来…';
      n.rows = 6;
    } else if (kind === 'photo') {
      t.placeholder = '主题，例如「白板上的架构图」';
      n.placeholder = '给照片加一句备注（可选）';
      n.rows = 3;
    } else {
      t.placeholder = '主题，例如「登录页的动效想法」';
      n.placeholder = '补充信息（可选）';
      n.rows = 3;
    }
  }

  function renderSaveMeta() {
    const p = S.pending;
    if (!p) return;
    const kind = p.kind || 'voice';
    const rows = [
      metaRow('clock', fmtWhen(Date.now())),
      metaRow('pin', p.lat == null ? '未记录位置' : p.lat.toFixed(4) + ', ' + p.lon.toFixed(4)),
    ];
    if (kind === 'voice') rows.push(metaRow('timer', '时长 ' + fmtDur(p.durationMs)));
    else if (kind === 'photo') rows.push(metaRow('camera', (p.shots || []).length + ' 张照片'));
    else rows.push(metaRow('edit', '文字灵感'));
    $('#sMeta').innerHTML = rows.join('');
  }

  /* The review strip: thumbnails you can drop, and a way to add more from the album. */
  function renderSaveShots() {
    const p = S.pending;
    const wrap = $('#sShotsWrap');
    const box = $('#sShots');
    const kind = p ? (p.kind || 'voice') : 'voice';
    if (!p || kind !== 'photo') { wrap.hidden = true; box.innerHTML = ''; return; }

    wrap.hidden = false;
    box.innerHTML = '';
    p.shots.forEach((s, n) => {
      const cell = document.createElement('div');
      cell.className = 'shot-cell';
      const img = document.createElement('img');
      img.alt = '照片 ' + (n + 1);
      if (s.thumb) img.src = s.thumb;
      else cell.classList.add('blank');
      cell.appendChild(img);

      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'shot-x';
      x.setAttribute('aria-label', '移除这张照片');
      x.innerHTML = icon('close');
      x.addEventListener('click', () => {
        p.shots.splice(n, 1);
        renderSaveShots();
        renderSaveMeta();
      });
      cell.appendChild(x);
      box.appendChild(cell);
    });

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'shot-add';
    add.innerHTML = icon('plus') + '<span>相册</span>';
    add.addEventListener('click', async () => {
      const more = await window.Photo.gallery();
      if (!more.length) return;
      p.shots = p.shots.concat(more);
      renderSaveShots();
      renderSaveMeta();
    });
    box.appendChild(add);
  }

  function renderSaveProjects() {
    const box = $('#sProjects');
    box.innerHTML = '';
    const opts = [{ id: null, name: '收件箱', icon: 'tray' }].concat(S.projects);
    opts.forEach((p) => {
      const here = (S.pending.projectId || null) === p.id;
      const b = document.createElement('button');
      b.type = 'button';
      if (here) b.classList.add('sel');
      b.innerHTML = icon(p.icon || 'tray') + '<span></span>';
      b.querySelector('span').textContent = p.name;
      b.addEventListener('click', () => {
        S.pending.projectId = p.id;
        renderSaveProjects();
      });
      box.appendChild(b);
    });
  }

  async function commitSave() {
    const pend = S.pending;
    if (!pend) return;

    const shots = pend.shots || [];
    // Dropping every photo leaves a written note, which is what it has become.
    let kind = pend.kind || 'voice';
    if (kind === 'photo' && !shots.length) kind = 'text';

    const id = window.DB.uid();

    // Only a recording writes an audio row. Writing one for a text or photo idea would
    // make the "audio is missing" flag a lie the first time it was restored.
    if (kind === 'voice') {
      await window.DB.put('audio', { id, blob: pend.blob, mime: pend.mime });
    }

    const idea = {
      id,
      kind,
      projectId: pend.projectId || null,
      title: $('#sTitle').value.trim(),
      note: $('#sNote').value.trim(),
      durationMs: kind === 'voice' ? pend.durationMs : 0,
      createdAt: Date.now(),
      lat: pend.lat,
      lon: pend.lon,
    };
    if (kind === 'photo') {
      idea.photoCount = shots.length;
      // The list draws its thumbnail from here, so it never has to open the image store.
      idea.thumb = (shots.find((s) => s.thumb) || {}).thumb || '';
    }
    await window.DB.put('ideas', idea);

    for (const s of shots) {
      await window.DB.put('images', {
        id: window.DB.uid(),
        ideaId: id,
        mime: s.mime,
        w: s.w,
        h: s.h,
        createdAt: Date.now(),
        blob: s.blob,
      });
    }

    S.ideas.push(idea);
    invalidateCorpus();
    S.pending = null;
    $('#saveSheet').hidden = true;
    render();

    const card = document.querySelector('.card[data-id="' + id + '"]');
    if (card) {
      card.classList.add('flash');
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    const where = idea.projectId ? '「' + projName(idea.projectId) + '」' : '收件箱';
    const extra = kind === 'photo' ? ' · ' + shots.length + ' 张照片' : '';
    toast('已存到' + where + extra + (idea.lat == null ? ' · 无位置' : ' · 含位置'));
  }

  async function discardPending() {
    if (!S.pending) return;
    if ((S.pending.kind || 'voice') === 'voice') await window.Speech.cancel();
    S.pending = null;
    $('#saveSheet').hidden = true;
    $('#sShotsWrap').hidden = true;
    resetTransStatus($('#sTransStatus'));
    toast('已丢弃');
  }

  /* ---------------- offline transcription ---------------- */

  const TRANS_ICON = '<svg class="ico"><use href="#i-spark"/></svg>';
  let transBusy = false;

  function setTransStatus(el, text, busy) {
    el.textContent = text;
    el.classList.toggle('busy', !!busy);
  }

  function resetTransStatus(el) {
    const ok = S.speech && S.speech.ok;
    setTransStatus(el, ok ? '不联网，在本机把录音变成文字' : ((S.speech && S.speech.reason) || '正在检查离线识别引擎…'), false);
  }

  function applySpeechSupport() {
    const ok = !!(S.speech && S.speech.ok);
    [$('#dTranscribe'), $('#sTranscribe')].forEach((b) => {
      b.disabled = !ok;
      b.innerHTML = TRANS_ICON + '离线转写';
    });
    resetTransStatus($('#dTransStatus'));
    resetTransStatus($('#sTransStatus'));
  }

  /**
   * Runs the recogniser over a recorded blob and hands the text to onText(text, streaming).
   * Nothing leaves the device — see js/speech.js.
   */
  async function transcribeBlob(blob, btn, status, onText) {
    if (!(S.speech && S.speech.ok)) { toast((S.speech && S.speech.reason) || '离线转写不可用'); return; }
    if (transBusy) { toast('正在转写，稍等一下'); return; }

    transBusy = true;
    btn.disabled = true;
    const t0 = Date.now();

    window.Speech.onProgress((d) => {
      setTransStatus(status, '首次使用，正在把语音模型装进本机… ' + (d.megabytes || 0) + ' MB', true);
    });

    try {
      setTransStatus(status, '正在识别…', true);
      const text = await window.Speech.transcribe(blob, {
        onUpdate: (u) => {
          const done = Math.round(u.done / 16000);
          const all = Math.round(u.total / 16000);
          setTransStatus(status, '正在识别… ' + done + ' / ' + all + ' 秒', true);
          const live = (u.text + u.partial).trim();
          if (live) onText(live, true);
        },
      });
      if (text) {
        onText(text, false);
        setTransStatus(status, '转写完成 · 用时 ' + fmtDur(Date.now() - t0), false);
      } else {
        setTransStatus(status, '没听清内容，靠麦克风近一点再试一次', false);
      }
    } catch (e) {
      setTransStatus(status, '转写失败：' + ((e && e.message) || '未知错误'), false);
    } finally {
      transBusy = false;
      btn.disabled = false;
    }
  }

  /* ---------------- todos ---------------- */

  /* Records carry the online-edition fields (ownerId/groupId/rev) as nulls from the start
     so turning on sync later does not need a second migration. */
  function blankTodo(text, opts) {
    const o = opts || {};
    const now = Date.now();
    return {
      id: window.DB.uid(),
      text: String(text || '').trim(),
      done: false,
      doneAt: null,
      ideaId: o.ideaId || null,
      projectId: o.projectId === undefined ? null : o.projectId,
      due: o.due || '',
      dueAt: o.dueAt || null,
      source: o.source || 'manual',
      createdAt: now,
      updatedAt: now,
      ownerId: null,
      groupId: null,
      rev: 1,
    };
  }

  async function addTodo(text, opts) {
    const todo = blankTodo(text, opts);
    if (!todo.text) return null;
    await window.DB.put('todos', todo);
    S.todos.push(todo);
    if (S.view === 'todos') render();
    else renderHeader();
    return todo;
  }

  async function toggleTodo(id) {
    const t = findTodo(id);
    if (!t) return;
    t.done = !t.done;
    t.doneAt = t.done ? Date.now() : null;
    t.updatedAt = Date.now();
    t.rev = (t.rev || 1) + 1;
    await window.DB.put('todos', t);
    render();
  }

  async function deleteTodo(id) {
    await window.DB.del('todos', id);
    S.todos = S.todos.filter((t) => t.id !== id);
    render();
    toast('待办已删除');
  }

  function todoOrder(a, b) {
    if (a.dueAt && b.dueAt) return a.dueAt - b.dueAt;
    if (a.dueAt) return -1;
    if (b.dueAt) return 1;
    return b.createdAt - a.createdAt;
  }

  function makeTodoRow(t) {
    const el = document.createElement('div');
    el.className = 'todo' + (t.done ? ' done' : '');
    el.dataset.id = t.id;

    const tick = document.createElement('button');
    tick.className = 'tick';
    tick.setAttribute('aria-label', t.done ? '标记为未完成' : '标记为完成');
    tick.innerHTML = icon('check');
    tick.addEventListener('click', (e) => { e.stopPropagation(); toggleTodo(t.id); });

    const body = document.createElement('div');
    body.className = 'todo-body';

    const text = document.createElement('p');
    text.className = 'todo-text';
    text.textContent = t.text;
    body.appendChild(text);

    const meta = document.createElement('div');
    meta.className = 'todo-meta';
    if (t.due) {
      const d = document.createElement('span');
      d.innerHTML = icon('clock', 'sm');
      const v = document.createElement('span');
      v.textContent = t.due;
      d.appendChild(v);
      meta.appendChild(d);
    }
    if (t.ideaId) {
      const src = document.createElement('span');
      src.className = 't-src';
      const i = findIdea(t.ideaId);
      src.textContent = '来自「' + ((i && i.title) || '未命名灵感') + '」';
      meta.appendChild(src);
    }
    if (meta.childNodes.length) body.appendChild(meta);

    el.append(tick, body);
    el.addEventListener('click', () => {
      const i = t.ideaId ? findIdea(t.ideaId) : null;
      showActions(t.text.slice(0, 24), [
        { label: t.done ? '标记为未完成' : '标记为完成', icon: 'check', run: () => toggleTodo(t.id) },
        ...(i ? [{ label: '打开来源灵感', icon: 'spark', run: () => openDetail(i.id) }] : []),
        { label: '删除待办', icon: 'trash', run: () => deleteTodo(t.id) },
        { label: '取消' },
      ]);
    });
    return el;
  }

  function renderTodos(box) {
    const add = document.createElement('button');
    add.className = 'todo-add';
    add.innerHTML = icon('plus') + '<span>添加待办</span>';
    add.addEventListener('click', () => {
      const text = prompt('待办内容');
      if (text && text.trim()) addTodo(text.trim(), { source: 'manual' });
    });
    box.appendChild(add);

    if (!S.todos.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.innerHTML = icon('check', 'lg big') +
        '还没有待办<br>可以直接添加，也可以在灵感里提炼要点后一键转过来';
      box.appendChild(e);
      return;
    }

    const open = S.todos.filter((t) => !t.done).sort(todoOrder);
    const done = S.todos.filter((t) => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));

    [['待完成 · ' + open.length, open], ['已完成 · ' + done.length, done]].forEach(([label, items]) => {
      if (!items.length) return;
      const group = document.createElement('div');
      group.className = 'todo-group';
      const h = document.createElement('div');
      h.className = 'group-label';
      h.textContent = label;
      group.appendChild(h);
      items.forEach((t) => group.appendChild(makeTodoRow(t)));
      box.appendChild(group);
    });
  }

  /* ---------------- distill (offline, deterministic) ---------------- */

  function distillScope(scope) {
    if (scope.kind === 'idea') {
      const i = findIdea(scope.ideaId);
      if (!i) return null;
      const text = ideaText(i);
      if (!text) return null;
      return {
        ideaId: i.id,
        projectId: i.projectId || null,
        label: i.title || '未命名灵感',
        title: '提炼要点',
        payload: window.Summarize.summarize(text, {
          idf: corpusIdf(),
          boost: new Set(window.Summarize.terms(i.title || '')),
        }),
      };
    }

    const pid = scope.projectId === undefined ? null : scope.projectId;
    const list = S.ideas.filter((i) => (i.projectId || null) === pid && ideaText(i));
    if (!list.length) return null;
    return {
      ideaId: null,
      projectId: pid,
      label: pid ? projName(pid) : '收件箱',
      title: '项目汇总',
      payload: window.Summarize.rollup(list),
    };
  }

  function openDistill(scope) {
    const d = distillScope(scope);
    if (!d) { toast('这里还没有可提炼的文字'); return; }

    const existing = new Set(S.todos.map((t) => t.text));
    S.distill = { ...d, added: new Set() };

    $('#gTitle').textContent = d.title;
    if (scope.kind === 'idea') {
      const i = findIdea(scope.ideaId);
      $('#gScope').textContent = d.label + ' · ' + fmtWhen(i.createdAt);
    } else {
      $('#gScope').textContent = d.label + ' · ' + d.payload.count + ' 条灵感';
    }

    const kw = $('#gKeywords');
    kw.innerHTML = '';
    if (!d.payload.keywords.length) {
      kw.innerHTML = '<span class="kw muted">没有提取到关键词</span>';
    } else {
      d.payload.keywords.forEach((k, n) => {
        const c = document.createElement('span');
        c.className = 'kw' + (n < 3 ? ' top' : '');
        c.textContent = k.term;
        kw.appendChild(c);
      });
    }

    const dl = $('#gDigest');
    dl.innerHTML = '';
    if (!d.payload.digest.length) {
      dl.innerHTML = '<p class="hint">内容太短，没有可以摘出来的句子。</p>';
    } else {
      d.payload.digest.forEach((s, n) => {
        const row = document.createElement('div');
        row.className = 'digest-line';
        const idx = document.createElement('span');
        idx.className = 'n';
        idx.textContent = pad(n + 1);
        const p = document.createElement('p');
        p.textContent = s;
        row.append(idx, p);
        dl.appendChild(row);
      });
    }

    const al = $('#gActions');
    al.innerHTML = '';
    if (!d.payload.actions.length) {
      al.innerHTML = '<p class="hint">没有识别到明确的待办。需要出现动作词，并且带时间或第二个动作词。</p>';
    } else {
      d.payload.actions.forEach((a) => {
        const row = document.createElement('div');
        row.className = 'action-row';

        const p = document.createElement('p');
        p.textContent = a.text;
        row.appendChild(p);

        const foot = document.createElement('div');
        foot.className = 'action-foot';

        if (a.due) {
          const due = document.createElement('span');
          due.className = 'action-due';
          due.innerHTML = icon('clock', 'sm');
          const v = document.createElement('span');
          v.textContent = a.due;
          due.appendChild(v);
          foot.appendChild(due);
        } else {
          const spacer = document.createElement('span');
          spacer.className = 'action-due';
          foot.appendChild(spacer);
        }

        const btn = document.createElement('button');
        btn.className = 'mini-btn';
        const already = existing.has(a.text);
        btn.textContent = already ? '已在待办' : '转成待办';
        btn.disabled = already;
        btn.addEventListener('click', async () => {
          await addTodo(a.text, {
            source: 'extracted',
            due: a.due || '',
            ideaId: d.ideaId,
            projectId: d.projectId,
          });
          btn.textContent = '已在待办';
          btn.disabled = true;
          toast('已加入待办');
        });
        foot.appendChild(btn);

        row.appendChild(foot);
        al.appendChild(row);
      });
    }

    $('#distillSheet').hidden = false;
  }

  /* ---------------- online: people, groups and the discussion area ----------------

     The online edition is strictly additive. Everything above still works with the network
     off; the only things that need a backend are sharing an idea into a group and the
     discussion that hangs off it. A local idea stays local until you explicitly share it,
     and even then only its text leaves the device — the recording never does. */

  const meId = () => ((window.Api.currentUser() || {}).id || '');
  const onlineReady = () =>
    S.mode === 'online' && window.Api.isConfigured() && window.Api.isSignedIn();
  const findGroup = (id) => S.groups.find((g) => g.id === id);

  function personLabel(p) {
    if (!p) return '未知';
    return p.display_name || (p.email || '').split('@')[0] || p.email || '未知';
  }

  function authorName(m) {
    if (m && m.author_id === meId()) return '我';
    return personLabel(m && m.author);
  }

  /** Flatten the contacts rows into the plain { id, name, email } shape the UI wants. */
  function contactRows() {
    return S.contacts.map((c) => {
      const p = c.contact || {};
      return { id: p.id || c.contact_id, name: c.alias || personLabel(p), email: p.email || '' };
    }).filter((r) => r.id);
  }

  /* --- small building blocks shared by the new views --- */

  function sectionHead(label, count, actionLabel, onAction) {
    const el = document.createElement('div');
    el.className = 'section-head';
    const h = document.createElement('span');
    h.className = 'section-label';
    h.textContent = label;
    el.appendChild(h);
    if (count != null && count !== '') {
      const c = document.createElement('span');
      c.className = 'section-count';
      c.textContent = count;
      el.appendChild(c);
    }
    if (actionLabel) {
      const b = document.createElement('button');
      b.className = 'mini-btn';
      b.textContent = actionLabel;
      b.addEventListener('click', onAction);
      el.appendChild(b);
    }
    return el;
  }

  function sectionHint(text) {
    const el = document.createElement('p');
    el.className = 'section-hint';
    el.textContent = text;
    return el;
  }

  function loadingState(text) {
    const el = document.createElement('div');
    el.className = 'empty';
    el.innerHTML = icon('clock', 'lg big') + '<span class="empty-title"></span>';
    el.querySelector('.empty-title').textContent = text || '正在读取…';
    return el;
  }

  function stateBlock(iconName, title, sub, btnLabel, onClick) {
    const el = document.createElement('div');
    el.className = 'empty';
    el.innerHTML = icon(iconName, 'lg big') + '<span class="empty-title"></span><span class="empty-sub"></span>';
    el.querySelector('.empty-title').textContent = title;
    el.querySelector('.empty-sub').textContent = sub || '';
    if (btnLabel) {
      const b = document.createElement('button');
      b.className = 'solid-btn';
      b.textContent = btnLabel;
      b.addEventListener('click', onClick);
      el.appendChild(b);
    }
    return el;
  }

  const notReadyState = () => stateBlock('plane', '在线模式还没连接',
    '到设置里填上后端地址并登录，就能添加通讯人和群组。', '打开设置', openDataSheet);

  /* --- the 社群 list view --- */

  function renderPeople(box) {
    if (!onlineReady()) { box.appendChild(notReadyState()); return; }

    const rows = contactRows();
    box.appendChild(sectionHead('通讯人', rows.length, '添加', openPeopleSheet));
    if (!rows.length) {
      box.appendChild(sectionHint('还没有通讯人。填上对方的注册邮箱就能把他拉进群。'));
    } else {
      rows.forEach((r) => {
        const el = document.createElement('div');
        el.className = 'prow';
        el.innerHTML = '<div class="prow-ico">' + icon('users') + '</div>' +
          '<div class="prow-body"><p class="prow-name"></p><p class="prow-sub"></p></div>';
        el.querySelector('.prow-name').textContent = r.name;
        el.querySelector('.prow-sub').textContent = r.email;
        box.appendChild(el);
      });
    }

    box.appendChild(sectionHead('群组', S.groups.length, '新建', () => openGroupSheet(null)));
    if (!S.groups.length) {
      box.appendChild(sectionHint('还没有群组。建一个、把通讯人加进来，就可以分享灵感了。'));
    } else {
      S.groups.forEach((g) => box.appendChild(makeGroupRow(g)));
    }
  }

  function makeGroupRow(g) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'prow go';
    el.innerHTML = '<div class="prow-ico">' + icon('case') + '</div>' +
      '<div class="prow-body"><p class="prow-name"></p><p class="prow-sub"></p></div>' +
      '<span class="prow-go">' + icon('go') + '</span>';
    el.querySelector('.prow-name').textContent = g.name;
    el.querySelector('.prow-sub').textContent = (g.owner_id === meId() ? '我创建的' : '我是成员') +
      ' · ' + fmtWhen(new Date(g.created_at).getTime());
    el.addEventListener('click', () => { S.view = 'group:' + g.id; render(); });
    return el;
  }

  /* --- one group --- */

  function ensureGroup(gid) {
    if (S.groupData[gid]) return S.groupData[gid];
    // Plant a placeholder first, so a re-entrant render shows a spinner instead of
    // kicking off a second fetch for the same group.
    S.groupData[gid] = { loading: true, ideas: [], members: [], todos: [] };
    loadGroup(gid);
    return S.groupData[gid];
  }

  async function loadGroup(gid) {
    try {
      const r = await Promise.all([
        window.Api.groupIdeas(gid),
        window.Api.groupMembers(gid),
        window.Api.groupTodos(gid),
      ]);
      S.groupData[gid] = {
        ideas: r[0] || [],
        members: (r[1] || []).map((m) => ({
          id: m.member_id,
          role: m.role,
          email: (m.profile || {}).email || '',
          name: personLabel(m.profile),
        })),
        todos: r[2] || [],
      };
    } catch (e) {
      S.groupData[gid] = { ideas: [], members: [], todos: [], error: (e && e.message) || '读取失败' };
      toast('读取群组失败：' + ((e && e.message) || '未知错误'));
    }
    if (S.view === 'group:' + gid) render();
  }

  function refreshGroup(gid) { delete S.groupData[gid]; return loadGroup(gid); }

  function renderGroupView(box, gid) {
    if (!onlineReady()) { box.appendChild(notReadyState()); return; }
    const g = findGroup(gid);
    if (!g) {
      box.appendChild(stateBlock('case', '找不到这个群组', '它可能已经被删除了。',
        '返回社群', () => { S.view = 'people'; render(); }));
      return;
    }

    const d = ensureGroup(gid);
    if (d.loading) { box.appendChild(loadingState('正在读取群组…')); return; }
    if (d.error) {
      box.appendChild(stateBlock('warn', '读不到这个群组', d.error, '重试', () => refreshGroup(gid)));
      return;
    }

    const bar = document.createElement('div');
    bar.className = 'group-bar';
    const shareBtn = document.createElement('button');
    shareBtn.className = 'solid-btn';
    shareBtn.innerHTML = icon('up') + '分享灵感';
    shareBtn.addEventListener('click', () => openShareSheet(null, gid));
    const memBtn = document.createElement('button');
    memBtn.className = 'ghost-btn';
    memBtn.innerHTML = icon('users') + '成员 ' + d.members.length;
    memBtn.addEventListener('click', () => openGroupSheet(g));
    bar.append(shareBtn, memBtn);
    box.appendChild(bar);

    if (d.todos.length) {
      const open = d.todos.filter((t) => !t.done).length;
      box.appendChild(sectionHead('群里的待办', open + ' / ' + d.todos.length, null, null));
      d.todos.forEach((t) => box.appendChild(makeSharedTodoRow(t)));
    }

    box.appendChild(sectionHead('分享的想法', d.ideas.length, null, null));
    if (!d.ideas.length) {
      box.appendChild(sectionHint('还没有人往这个群分享灵感。点上面的按钮，把本机的一条发进来。'));
    } else {
      d.ideas.forEach((idea) => box.appendChild(makeSharedCard(idea)));
    }
  }

  function makeSharedCard(idea) {
    const el = document.createElement('div');
    el.className = 'card shared';
    el.innerHTML = '<div class="card-body"><p class="card-title"></p><div class="card-meta">' +
      '<span class="m-when"></span><span class="m-kw"></span></div><p class="card-note"></p></div>' +
      '<span class="card-go">' + icon('go') + '</span>';

    const title = el.querySelector('.card-title');
    title.textContent = idea.title || '未命名灵感';
    if (!idea.title) title.classList.add('untitled');

    el.querySelector('.m-when').innerHTML = icon('clock', 'sm') + '<span>' +
      personLabel(idea.author) + ' · ' + fmtWhen(new Date(idea.shared_at).getTime()) + '</span>';

    const kw = (idea.keywords || []).slice(0, 4);
    el.querySelector('.m-kw').innerHTML = kw.length
      ? icon('spark', 'sm') + '<span>' + kw.join(' · ') + '</span>' : '';

    const note = el.querySelector('.card-note');
    if (idea.note) note.textContent = idea.note; else note.remove();

    el.addEventListener('click', () => openThread(idea));
    return el;
  }

  function makeSharedTodoRow(t) {
    const row = document.createElement('div');
    row.className = 'todo' + (t.done ? ' done' : '');

    const tick = document.createElement('button');
    tick.className = 'tick' + (t.done ? ' on' : '');
    tick.innerHTML = icon('check');
    tick.setAttribute('aria-label', t.done ? '取消完成' : '标记完成');
    tick.addEventListener('click', () => tickSharedTodo(t, false));

    const body = document.createElement('div');
    body.className = 'todo-body';
    const txt = document.createElement('p');
    txt.className = 'todo-text';
    txt.textContent = t.text;
    const meta = document.createElement('div');
    meta.className = 'todo-meta';
    const bits = [];
    if (t.assignee) bits.push('@' + personLabel(t.assignee));
    if (t.due) bits.push(window.Commands.describeDue(t.due));
    if (t.creator) bits.push('来自 ' + personLabel(t.creator));
    meta.textContent = bits.join(' · ');
    body.append(txt, meta);

    row.append(tick, body);
    return row;
  }

  /**
   * Record a newly created shared to-do in both places that show it.
   *
   * The thread and the group view keep separate copies of the same rows, and a /todo made
   * inside a thread has to land in both or the group list would stay stale until the next
   * full reload.
   */
  function rememberSharedTodo(row) {
    if (!row || !row.id) return;
    if (!(S.thread.todos || []).some((t) => t.id === row.id)) S.thread.todos.push(row);
    const d = S.groupData[row.group_id];
    if (d && d.todos && !d.todos.some((t) => t.id === row.id)) d.todos.push(row);
  }

  /** Tick a shared todo from the group list (onThread=false) or from a discussion card. */
  async function tickSharedTodo(t, onThread) {
    try {
      await setSharedTodoDone(t, !t.done);
    } catch (e) {
      toast('同步失败：' + ((e && e.message) || '未知错误'));
    }
    if (onThread) renderThread(); else render();
  }

  async function setSharedTodoDone(t, next) {
    const was = { done: t.done, done_at: t.done_at };
    t.done = next;
    t.done_at = next ? new Date().toISOString() : null;
    try {
      await window.Api.update('shared_todos', { id: 'eq.' + t.id }, { done: next, done_at: t.done_at });
      // The group view and the thread keep separate copies of the same row; keep them level.
      Object.keys(S.groupData).forEach((gid) => {
        const c = (S.groupData[gid].todos || []).find((x) => x.id === t.id);
        if (c) { c.done = t.done; c.done_at = t.done_at; }
      });
    } catch (e) {
      t.done = was.done;
      t.done_at = was.done_at;
      throw e;
    }
  }

  /* --- the discussion area --- */

  async function openThread(idea) {
    const gid = idea.group_id;
    S.thread = {
      idea: idea,
      group: findGroup(gid) || { id: gid, name: '群组' },
      messages: [], todos: [], members: [], loading: true, offline: false,
    };
    S.threadTodosOpen = true;   // re-decided below once the real list arrives
    $('#tInput').value = '';
    $('#tInput').style.height = '';
    $('#threadSheet').hidden = false;
    renderThread();

    try {
      const r = await Promise.all([
        window.Api.thread(idea.id),
        window.Api.groupMembers(gid),
        window.Api.groupTodos(gid),
      ]);
      S.thread.messages = r[0] || [];
      S.thread.members = (r[1] || []).map((m) => ({
        id: m.member_id,
        role: m.role,
        email: (m.profile || {}).email || '',
        name: personLabel(m.profile),
      }));
      S.thread.todos = (r[2] || []).filter((t) => t.share_id === idea.id);
      await cacheThread(idea.id, S.thread.messages);
      const d = S.groupData[gid];
      if (d) { d.todos = r[2] || []; d.members = S.thread.members; }
    } catch (e) {
      // A thread that was read once still reads on the train.
      S.thread.offline = true;
      S.thread.messages = await cachedThread(idea.id);
      S.thread.todos = (((S.groupData[gid] || {}).todos) || []).filter((t) => t.share_id === idea.id);
      toast('读取讨论失败，显示本机缓存：' + ((e && e.message) || '未知错误'));
    }
    S.threadTodosOpen = S.thread.todos.length <= 2;
    S.thread.loading = false;
    renderThread();
  }

  async function cacheThread(shareId, msgs) {
    try {
      await Promise.all(msgs.map((m) =>
        window.DB.put('messages', Object.assign({}, m, { threadId: shareId }))));
    } catch (e) { /* the cache is a convenience, never a requirement */ }
  }

  async function cachedThread(shareId) {
    try {
      const all = await window.DB.all('messages');
      return all.filter((m) => m.threadId === shareId)
        .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    } catch (e) { return []; }
  }

  function renderThread() {
    const t = S.thread;
    if (!t) return;

    $('#tTitle').textContent = t.idea.title || '讨论';
    const bits = [t.group.name];
    bits.push(t.loading ? '正在读取…' : t.messages.length + ' 条');
    if (t.offline) bits.push('本机缓存');
    bits.push('分享于 ' + fmtWhen(new Date(t.idea.shared_at || Date.now()).getTime()));
    $('#tMeta').textContent = bits.join(' · ');

    const pinBox = $('#tPins');
    pinBox.innerHTML = '';
    const pins = t.messages.filter((m) => m.kind === 'command' && m.command === 'pin');
    pinBox.hidden = !pins.length;
    pins.forEach((m) => {
      const el = document.createElement('div');
      el.className = 'pin';
      el.innerHTML = icon('pin') + '<span></span>';
      el.querySelector('span').textContent = (m.payload && m.payload.text) || m.body;
      pinBox.appendChild(el);
    });

    const box = $('#tMessages');
    box.innerHTML = '';
    if (t.loading) {
      box.appendChild(loadingState('正在读取讨论…'));
    } else if (!t.messages.length) {
      box.appendChild(sectionHint('还没有人说话。用下面的 / 命令，可以直接在这条想法上生成待办或摘要。'));
    } else {
      t.messages.forEach((m) => box.appendChild(makeMessage(m)));
      box.scrollTop = box.scrollHeight;
    }

    renderThreadTodos();
    updateComposer();
  }

  /**
   * The action list pinned under a thread.
   *
   * It duplicates the /todo cards in the conversation, which is the point — it is the
   * checklist. But it also competes with the conversation for height, so a short list
   * opens by default and a long one folds, leaving the toggle as the way in. The user's
   * own choice wins for as long as the thread stays open.
   */
  function renderThreadTodos() {
    const box = $('#tTodos');
    box.innerHTML = '';
    const t = S.thread;
    if (!t || !t.todos.length) { box.hidden = true; return; }
    box.hidden = false;

    const open = t.todos.filter((x) => !x.done).length;
    box.appendChild(sectionHead(
      '这条想法上的待办',
      open + ' / ' + t.todos.length,
      S.threadTodosOpen ? '收起' : '展开',
      () => { S.threadTodosOpen = !S.threadTodosOpen; renderThreadTodos(); }
    ));

    if (!S.threadTodosOpen) return;
    t.todos.forEach((x) => box.appendChild(makeSharedTodoRow(x)));
  }

  function makeMessage(m) {
    const el = document.createElement('div');
    el.className = 'msg' +
      (m.author_id === meId() ? ' mine' : '') +
      (m.kind === 'command' ? ' cmd' : '');
    const head = document.createElement('div');
    head.className = 'msg-head';
    head.textContent = authorName(m) + ' · ' + fmtWhen(new Date(m.created_at).getTime());
    const body = document.createElement('div');
    body.className = 'msg-body';
    if (m.kind === 'command') fillCommandCard(body, m);
    else body.textContent = m.body;
    el.append(head, body);
    return el;
  }

  function chip(text) {
    const s = document.createElement('span');
    s.className = 'kw';
    s.textContent = text;
    return s;
  }

  /**
   * Draw a command message from its stored payload.
   *
   * The payload is written once, when the command runs, and every later read renders from
   * it — so reopening the thread shows exactly the same card without recomputing anything.
   */
  function fillCommandCard(body, m) {
    const p = m.payload || {};

    const name = document.createElement('div');
    name.className = 'cmd-name';
    name.textContent = '/' + (m.command || '?');
    body.appendChild(name);

    const out = document.createElement('div');
    out.className = 'cmd-out';

    switch (m.command) {
      case 'todo':
      case 'assign': {
        const row = document.createElement('div');
        row.className = 'cmd-todo';
        const known = (S.thread.todos || []).find((x) => x.id === p.todoId);
        const tick = document.createElement('button');
        tick.className = 'tick' + (known && known.done ? ' on' : '');
        tick.innerHTML = icon('check');
        tick.disabled = !known;
        tick.setAttribute('aria-label', known && known.done ? '取消完成' : '标记完成');
        tick.addEventListener('click', () => { if (known) tickSharedTodo(known, true); });
        const txt = document.createElement('span');
        txt.textContent = p.text || m.body;
        row.append(tick, txt);
        if (p.assignee) row.appendChild(chip('@' + p.assignee));
        if (p.due) row.appendChild(chip(window.Commands.describeDue(p.due)));
        out.appendChild(row);
        break;
      }

      case 'done':
        out.textContent = '勾掉了：' + (p.text || m.body);
        break;

      case 'tag':
        out.classList.add('kw-row');
        (p.tags || []).forEach((tg) => out.appendChild(chip(tg)));
        break;

      case 'pin':
        out.textContent = p.text || m.body;
        break;

      case 'summary': {
        (p.digest || []).forEach((line) => {
          const d = document.createElement('div');
          d.className = 'digest-line';
          d.textContent = line;
          out.appendChild(d);
        });
        if ((p.keywords || []).length) {
          const row = document.createElement('div');
          row.className = 'kw-row';
          (p.keywords || []).forEach((k) => row.appendChild(chip(typeof k === 'string' ? k : k.term)));
          out.appendChild(row);
        }
        if ((p.actions || []).length) {
          const acts = document.createElement('div');
          acts.className = 'action-list';
          p.actions.forEach((a) => {
            const li = document.createElement('div');
            li.className = 'action-row';
            li.textContent = a;
            acts.appendChild(li);
          });
          out.appendChild(acts);
        }
        break;
      }

      case 'keywords': {
        const row = document.createElement('div');
        row.className = 'kw-row';
        (p.keywords || []).forEach((k) => row.appendChild(chip(typeof k === 'string' ? k : k.term)));
        out.appendChild(row);
        break;
      }

      case 'help':
        window.Commands.specs().forEach((s) => {
          const li = document.createElement('div');
          li.className = 'cmd-help';
          li.innerHTML = '<code></code><span></span>';
          li.querySelector('code').textContent = s.usage;
          li.querySelector('span').textContent = s.hint;
          out.appendChild(li);
        });
        break;

      default:
        out.textContent = m.body || '';
    }

    body.appendChild(out);
  }

  /* --- composer --- */

  function updateComposer() {
    const raw = $('#tInput').value;
    const text = raw.trim();
    const pal = $('#tPalette');
    const hint = $('#tHint');
    pal.innerHTML = '';

    // Typing a bare command name: offer the palette. When nothing matches we fall through
    // to the hint below, so an unknown command still gets explained instead of going quiet.
    if (/^\/[A-Za-z\u4e00-\u9fa5]*$/.test(text)) {
      const hits = window.Commands.suggest(text);
      if (hits.length) {
        pal.hidden = false;
        S.cmdPick = 0;
        hits.forEach((s, i) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'pal-row' + (i === 0 ? ' on' : '');
          b.innerHTML = '<code></code><span></span>';
          b.querySelector('code').textContent = s.usage;
          b.querySelector('span').textContent = s.hint;
          b.addEventListener('click', () => {
            $('#tInput').value = s.name + ' ';
            $('#tInput').focus();
            updateComposer();
          });
          pal.appendChild(b);
        });
        hint.hidden = true;
        return;
      }
      pal.hidden = true;
    } else {
      pal.hidden = true;
    }

    const p = window.Commands.parse(text);
    if (p.kind === 'unknown') {
      hint.hidden = false;
      hint.classList.add('bad');
      hint.textContent = '没有 /' + p.command + ' 这个命令，输入 / 看全部命令';
    } else if (p.kind === 'command') {
      const ok = window.Commands.isComplete(p);
      hint.hidden = false;
      hint.classList.toggle('bad', !ok);
      hint.textContent = ok ? window.Commands.preview(p) : p.spec.usage;
    } else {
      hint.hidden = true;
    }
  }

  async function sendThreadMessage() {
    const input = $('#tInput');
    const raw = input.value.trim();
    if (!raw) return;
    const t = S.thread;
    if (!t || t.loading) return;
    if (!onlineReady()) { toast('在线模式未就绪，先到设置里登录'); return; }

    const p = window.Commands.parse(raw);
    if (p.kind === 'unknown') { toast('没有 /' + p.command + ' 这个命令'); return; }
    if (p.kind === 'command' && !window.Commands.isComplete(p)) {
      toast('命令还没写完：' + p.spec.usage);
      return;
    }

    const send = $('#tSend');
    send.disabled = true;
    try {
      let kind = 'text', command = null, payload = null, body = raw;
      if (p.kind === 'command') {
        const r = await runCommand(p);
        kind = 'command';
        command = p.command;
        payload = r.payload;
        body = r.body || raw;
      }

      const saved = await window.Api.postMessage({
        share_id: t.idea.id,
        group_id: t.group.id,
        body: body,
        kind: kind,
        command: command,
        payload: payload,
      });
      const row = (Array.isArray(saved) && saved[0]) ? saved[0] : {
        id: window.DB.uid(), share_id: t.idea.id, group_id: t.group.id,
        author_id: meId(), author: window.Api.currentUser(),
        body: body, kind: kind, command: command, payload: payload,
        created_at: new Date().toISOString(),
      };
      t.messages.push(row);
      await cacheThread(t.idea.id, [row]);
      input.value = '';
      input.style.height = '';
      renderThread();
    } catch (e) {
      toast('发送失败：' + ((e && e.message) || '未知错误'));
    } finally {
      send.disabled = false;
      updateComposer();
    }
  }

  /**
   * Run one parsed command and return the { body, payload } stored on the message row.
   *
   * Backend side effects happen here, before the message is posted. REST gives us no
   * transaction across two tables, so if the post then fails the effect stands — a visible
   * todo is a far better failure mode than a silently dropped one.
   */
  async function runCommand(p) {
    const t = S.thread;
    const gid = t.group.id;

    switch (p.command) {
      case 'todo': {
        const row = await window.Api.insert('shared_todos', [{
          share_id: t.idea.id, group_id: gid, text: p.args.text,
          due: p.args.due || null, created_by: meId(),
        }]);
        const saved = (Array.isArray(row) && row[0]) || {};
        if (saved.id) rememberSharedTodo(Object.assign({}, saved, { group_id: gid }));
        return {
          body: p.args.text,
          payload: { todoId: saved.id || null, text: p.args.text, due: p.args.due || '' },
        };
      }

      case 'assign': {
        const who = resolveMember(p.args.who);
        if (!who) throw new Error('群里没有「' + p.args.who + '」，先确认对方已经加入这个群');
        const row = await window.Api.insert('shared_todos', [{
          share_id: t.idea.id, group_id: gid, text: p.args.text,
          due: p.args.due || null, assignee_id: who.id, created_by: meId(),
        }]);
        const saved = (Array.isArray(row) && row[0]) || {};
        if (saved.id) {
          rememberSharedTodo(Object.assign({}, saved, {
            group_id: gid,
            assignee: { display_name: who.name, email: who.email },
          }));
        }
        return {
          body: p.args.text,
          payload: {
            todoId: saved.id || null, text: p.args.text,
            due: p.args.due || '', assignee: who.name,
          },
        };
      }

      case 'done': {
        const target = resolveTodoRef(p.args.ref);
        if (!target) throw new Error('没有找到「' + p.args.ref + '」这条待办');
        if (!target.done) await setSharedTodoDone(target, true);
        return { body: target.text, payload: { todoId: target.id, text: target.text } };
      }

      case 'tag':
        return { body: p.args.tags.join(' '), payload: { tags: p.args.tags } };

      case 'pin':
        return { body: p.args.text, payload: { text: p.args.text } };

      case 'summary': {
        const out = localSummary(p.args.limit);
        return { body: out.digest.join(' '), payload: out };
      }

      case 'keywords': {
        const out = localKeywords(p.args.limit);
        return { body: out.keywords.join(' '), payload: { keywords: out.keywords } };
      }

      case 'help':
        return { body: '命令列表', payload: {} };

      default:
        return { body: p.rest, payload: {} };
    }
  }

  function resolveMember(handle) {
    const h = String(handle || '').replace(/^@/, '').trim().toLowerCase();
    if (!h) return null;
    return (S.thread.members || []).find((m) =>
      (m.email || '').toLowerCase() === h ||
      (m.name || '').toLowerCase() === h ||
      (m.email || '').toLowerCase().split('@')[0] === h) || null;
  }

  /** "/done 2" counts the open todos in the order they are shown; "/done 换色" matches text. */
  function resolveTodoRef(ref) {
    const r = String(ref || '').trim();
    if (!r) return null;
    const list = S.thread.todos || [];
    if (/^\d+$/.test(r)) {
      const open = list.filter((x) => !x.done);
      return open[+r - 1] || list[+r - 1] || null;
    }
    const low = r.toLowerCase();
    return list.find((x) => (x.text || '').toLowerCase().indexOf(low) >= 0) || null;
  }

  /** The text a command works on: the shared idea plus everything said about it. */
  function threadCorpus() {
    const t = S.thread;
    const said = (t.messages || []).filter((m) => m.kind === 'text').map((m) => m.body);
    return {
      idea: [t.idea.title, t.idea.note].filter(Boolean).join('。'),
      said: said.join('。'),
    };
  }

  /**
   * /summary and /keywords run the same deterministic engine the 提炼要点 sheet uses — no
   * model, no network, same input always giving the same output.
   *
   * The IDF table here is built over just two documents: the idea itself and the
   * discussion. That is deliberate. A term appearing in both is already-known context,
   * while a term that only shows up in the discussion is new signal — which is exactly
   * what you want surfaced when catching up on a thread.
   */
  function localSummary(limit) {
    const c = threadCorpus();
    const text = [c.idea, c.said].filter(Boolean).join('。');
    const out = window.Summarize.summarize(text, {
      idf: window.Summarize.buildIdf([c.idea, c.said]),
      boost: new Set(window.Summarize.terms(S.thread.idea.title || '')),
      keywordLimit: 8,
      digestLimit: limit || 3,
      actionLimit: 5,
    });
    return {
      keywords: out.keywords.map((k) => k.term),
      digest: out.digest,
      actions: out.actions.map((a) => a.text),
    };
  }

  function localKeywords(limit) {
    const c = threadCorpus();
    const text = [c.idea, c.said].filter(Boolean).join('。');
    return {
      keywords: window.Summarize
        .keywords(text, {
          idf: window.Summarize.buildIdf([c.idea, c.said]),
          boost: new Set(window.Summarize.terms(S.thread.idea.title || '')),
          limit: limit || 10,
        })
        .map((k) => k.term),
    };
  }

  /* --- contacts sheet --- */

  function openPeopleSheet() {
    if (!onlineReady()) { toast('先到设置里连接后端并登录'); return; }
    $('#cEmail').value = '';
    $('#cAlias').value = '';
    $('#peopleSheet').hidden = false;
    renderContactList();
  }

  function renderContactList() {
    const box = $('#cList');
    box.innerHTML = '';
    const rows = contactRows();
    if (!rows.length) { box.appendChild(sectionHint('还没有通讯人。')); return; }

    rows.forEach((r) => {
      const el = document.createElement('div');
      el.className = 'prow';
      el.innerHTML = '<div class="prow-body"><p class="prow-name"></p><p class="prow-sub"></p></div>' +
        '<button class="mini-btn danger">移除</button>';
      el.querySelector('.prow-name').textContent = r.name;
      el.querySelector('.prow-sub').textContent = r.email;
      el.querySelector('button').addEventListener('click', async () => {
        try {
          await window.Api.remove('contacts', {
            owner_id: 'eq.' + meId(), contact_id: 'eq.' + r.id,
          });
          await refreshOnline();
          renderContactList();
          toast('已移除');
        } catch (e) {
          toast('移除失败：' + ((e && e.message) || '未知错误'));
        }
      });
      box.appendChild(el);
    });
  }

  async function addContact() {
    const email = $('#cEmail').value.trim();
    const alias = $('#cAlias').value.trim();
    if (!email) { toast('请填写对方的邮箱'); return; }

    const btn = $('#cAdd');
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = '正在查找…';
    try {
      await window.Api.addContactByEmail(email, alias);
      $('#cEmail').value = '';
      $('#cAlias').value = '';
      await refreshOnline();
      renderContactList();
      toast('已添加');
    } catch (e) {
      toast('添加失败：' + ((e && e.message) || '未知错误'));
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  /* --- group sheet, doubling as the member picker --- */

  function openGroupSheet(g) {
    if (!onlineReady()) { toast('先到设置里连接后端并登录'); return; }
    S.groupEdit = g || null;
    $('#grTitle').textContent = g ? '添加成员' : '新建群组';
    $('#grNameWrap').hidden = !!g;
    $('#grName').value = '';
    $('#grCreate').textContent = g ? '加进「' + g.name + '」' : '创建群组';
    $('#grHint').textContent = g
      ? '只有群主能加人。加进来的人登录后就能看到群里的分享和讨论。'
      : '建好之后随时可以从通讯人里加人。';
    $('#groupSheet').hidden = false;
    renderMemberPicker();
  }

  function renderMemberPicker() {
    const box = $('#grPick');
    box.innerHTML = '';
    const rows = contactRows();
    if (!rows.length) { box.appendChild(sectionHint('还没有通讯人，先在上面添加。')); return; }

    const g = S.groupEdit;
    const existing = new Set(
      (g && S.groupData[g.id] ? (S.groupData[g.id].members || []) : []).map((m) => m.id));

    rows.forEach((r) => {
      const el = document.createElement('label');
      el.className = 'pick-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = r.id;
      cb.disabled = existing.has(r.id);
      const nm = document.createElement('span');
      nm.className = 'pick-name';
      nm.textContent = r.name;
      const sub = document.createElement('span');
      sub.className = 'pick-sub';
      sub.textContent = existing.has(r.id) ? '已在群里' : r.email;
      el.append(cb, nm, sub);
      box.appendChild(el);
    });
  }

  async function createOrExtendGroup() {
    const g = S.groupEdit;
    const picked = Array.from($('#grPick').querySelectorAll('input:checked')).map((c) => c.value);

    const btn = $('#grCreate');
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = '处理中…';
    try {
      let target = g;
      if (!g) {
        const name = $('#grName').value.trim();
        if (!name) { toast('请填写群组名称'); return; }
        const created = await window.Api.createGroup(name);
        target = Array.isArray(created) ? created[0] : created;
        if (!target || !target.id) throw new Error('创建没有返回群组');
      }
      for (let i = 0; i < picked.length; i++) {
        await window.Api.addGroupMember(target.id, picked[i]);
      }
      await refreshOnline();
      delete S.groupData[target.id];
      await loadGroup(target.id);
      $('#groupSheet').hidden = true;
      S.view = 'group:' + target.id;
      render();
      toast(g ? '已加进 ' + picked.length + ' 位成员' : '群组已创建');
    } catch (e) {
      toast('操作失败：' + ((e && e.message) || '未知错误'));
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  /* --- sharing a local idea into a group --- */

  function ideaKeywords(i, limit) {
    return window.Summarize
      .keywords(ideaText(i), {
        idf: corpusIdf(),
        limit: limit || 6,
        boost: new Set(window.Summarize.terms(i.title || '')),
      })
      .map((k) => k.term);
  }

  function openShareSheet(idea, gid) {
    if (!onlineReady()) { toast('先到设置里连接后端并登录'); return; }
    if (!S.groups.length) { toast('还没有群组，先在社群页建一个'); return; }
    S.shareIdea = idea || null;
    S.shareTarget = gid || (S.groups[0] && S.groups[0].id) || null;
    $('#shareSheet').hidden = false;
    renderShareSheet();
  }

  function renderShareSheet() {
    const iBox = $('#shIdeas');
    iBox.innerHTML = '';
    const ideas = S.ideas.slice().sort((a, b) => b.createdAt - a.createdAt);
    if (!ideas.length) {
      iBox.appendChild(sectionHint('本机还没有灵感。'));
    } else {
      ideas.slice(0, 50).forEach((i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pick-item' + (S.shareIdea && S.shareIdea.id === i.id ? ' on' : '');
        b.innerHTML = '<span class="pick-name"></span><span class="pick-sub"></span>';
        b.querySelector('.pick-name').textContent = i.title || '未命名灵感';
        b.querySelector('.pick-sub').textContent = fmtWhen(i.createdAt);
        b.addEventListener('click', () => { S.shareIdea = i; renderShareSheet(); });
        iBox.appendChild(b);
      });
    }

    const gBox = $('#shGroups');
    gBox.innerHTML = '';
    S.groups.forEach((g) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pick-item' + (S.shareTarget === g.id ? ' on' : '');
      b.innerHTML = '<span class="pick-name"></span><span class="pick-sub"></span>';
      b.querySelector('.pick-name').textContent = g.name;
      b.querySelector('.pick-sub').textContent = g.owner_id === meId() ? '我创建的' : '我是成员';
      b.addEventListener('click', () => { S.shareTarget = g.id; renderShareSheet(); });
      gBox.appendChild(b);
    });

    const note = $('#shIdea');
    if (S.shareIdea) {
      const kw = ideaKeywords(S.shareIdea, 4);
      note.textContent = '只发文字：标题、备注，还有关键词「' +
        (kw.length ? kw.join(' · ') : '暂无') + '」。录音留在本机，不会上传。';
    } else {
      note.textContent = '先选一条灵感，再选一个群组。只发文字，录音留在本机。';
    }

    $('#shGo').disabled = !S.shareIdea || !S.shareTarget;
  }

  async function doShare() {
    const i = S.shareIdea;
    const gid = S.shareTarget;
    if (!i || !gid) return;

    const btn = $('#shGo');
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = '正在分享…';
    try {
      await window.Api.shareIdea({
        id: i.id,
        title: i.title,
        note: i.note,
        keywords: ideaKeywords(i, 6),
        durationMs: i.durationMs,
        createdAt: i.createdAt,
        lat: i.lat,
        lon: i.lon,
      }, gid);
      delete S.groupData[gid];
      await loadGroup(gid);
      $('#shareSheet').hidden = true;
      S.view = 'group:' + gid;
      render();
      toast('已分享到群里');
    } catch (e) {
      toast('分享失败：' + ((e && e.message) || '未知错误'));
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  /* ---------------- settings & online mode ---------------- */

  /**
   * Local mode is the default and never touches the network. Switching to online only
   * reveals the backend and account fields — nothing is sent until the user configures a
   * project and signs in.
   */
  function setMode(m) {
    S.mode = m === 'online' ? 'online' : 'local';
    try { localStorage.setItem('spark.mode', S.mode); } catch (e) { /* ignore */ }
    if (S.mode === 'local') {
      // Local mode must not keep a stale copy of anyone else's data in memory.
      S.contacts = [];
      S.groups = [];
      S.groupData = {};
      S.thread = null;
      if (S.view === 'people' || S.view.indexOf('group:') === 0) S.view = 'inbox';
    }
    renderSettings();
    render();
  }

  function renderSettings() {
    const seg = $('#modeSeg');
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.mode));

    $('#modeHint').textContent = S.mode === 'online'
      ? '在线模式：可以加通讯人、建群组、把灵感分享出去，并围绕一条灵感讨论。'
      : '本地模式：内容只存在这台设备上，不联网、不需要账号。';

    $('#onlineBox').hidden = S.mode !== 'online';
    if (S.mode !== 'online') return;

    const c = window.Api.config();
    if (!$('#apiUrl').value) $('#apiUrl').value = c.url || '';
    if (!$('#apiKey').value) $('#apiKey').value = c.anonKey || '';

    const configured = window.Api.isConfigured();
    const user = window.Api.currentUser();

    $('#authBox').hidden = !configured;
    $('#authForm').hidden = !!user;      // no point offering a login form once signed in
    $('#authActions').hidden = !!user;
    $('#authWho').hidden = !user;
    if (user) $('#authWhoText').textContent = user.email || '已登录';

    if (!c.url && !c.anonKey) $('#apiState').textContent = '还没有填写后端地址。';
    else if (!configured) $('#apiState').textContent = '地址或 anon key 看起来不完整。';
    else $('#apiState').textContent = '已连接：' + c.url;
  }

  async function refreshOnline() {
    if (S.mode !== 'online' || !window.Api.isSignedIn()) {
      S.contacts = [];
      S.groups = [];
      render();
      return;
    }
    try {
      const both = await Promise.all([window.Api.myContacts(), window.Api.myGroups()]);
      S.contacts = both[0] || [];
      S.groups = both[1] || [];
    } catch (e) {
      S.contacts = [];
      S.groups = [];
      toast('读取在线数据失败：' + ((e && e.message) || '未知错误'));
    }
    render();
  }

  async function doAuth(mode) {
    const email = $('#authEmail').value.trim();
    const pass = $('#authPass').value;
    if (!email || !pass) { toast('请填写邮箱和密码'); return; }
    if (mode === 'up' && pass.length < 6) { toast('密码至少 6 位'); return; }

    const btn = mode === 'up' ? $('#authSignUp') : $('#authSignIn');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '请稍候…';
    try {
      if (mode === 'up') {
        const r = await window.Api.signUp(email, pass);
        if (r.needsConfirmation) {
          toast('注册成功，请先到邮箱确认，然后回来登录');
        } else {
          toast('注册完成');
        }
      } else {
        await window.Api.signIn(email, pass);
        toast('已登录');
      }
      $('#authPass').value = '';
      await refreshOnline();
    } catch (e) {
      toast((mode === 'up' ? '注册失败：' : '登录失败：') + ((e && e.message) || '未知错误'));
    } finally {
      btn.disabled = false;
      btn.textContent = label;
      renderSettings();
    }
  }

  /* ---------------- backup & storage ---------------- */
  async function renderStats() {
    const grid = $('#statGrid');
    const [audio, images] = await Promise.all([
      window.DB.all('audio'),
      window.DB.all('images'),
    ]);
    const audioBytes = audio.reduce((n, a) => n + ((a.blob && a.blob.size) || 0), 0);
    const imageBytes = images.reduce((n, a) => n + ((a.blob && a.blob.size) || 0), 0);
    const info = await window.Backup.info();

    const cells = [
      ['灵感', S.ideas.length + ' 条'],
      ['项目', S.projects.length + ' 个'],
      ['录音', audio.length + ' 段 · ' + window.Backup.human(audioBytes)],
      ['照片', images.length + ' 张 · ' + window.Backup.human(imageBytes)],
      ['已用空间', window.Backup.human(info.usage) + ' / ' + window.Backup.human(info.quota)],
    ];
    grid.innerHTML = '';
    cells.forEach((pair, n) => {
      const box = document.createElement('div');
      box.className = 'stat' + (n === cells.length - 1 ? ' wide' : '');
      const k = document.createElement('div');
      k.className = 'k';
      k.textContent = pair[0];
      const v = document.createElement('div');
      v.className = 'v';
      v.textContent = pair[1];
      box.append(k, v);
      grid.appendChild(box);
    });

    const wrap = $('#persistBox');
    const btn = $('#persistBtn');
    const txt = $('#persistText');
    if (!info.supported) { wrap.hidden = true; return; }
    wrap.hidden = false;
    if (info.persisted) {
      wrap.classList.add('ok');
      wrap.querySelector('.ico').outerHTML = icon('check');
      btn.hidden = true;
      txt.textContent = '已开启持久化存储，系统不会自动清理这些灵感。';
    } else {
      wrap.classList.remove('ok');
      wrap.querySelector('.ico').outerHTML = icon('warn');
      btn.hidden = false;
      txt.textContent = '持久化存储未开启，系统在空间紧张时可能清掉录音和照片。建议先导出备份。';
    }
  }

  function openDataSheet() {
    $('#dataSheet').hidden = false;
    renderSettings();
    renderStats();
  }

  async function doExport() {
    const btn = $('#bExport');
    if (btn.dataset.busy) return;
    btn.dataset.busy = '1';
    const label = btn.textContent;
    btn.textContent = '正在打包…';
    try {
      const r = await window.Backup.exportAll();
      if (r.how === 'cancelled') toast('已取消');
      else if (r.how === 'shared') toast('备份已发送 · ' + window.Backup.human(r.bytes));
      else toast('备份已导出 · ' + window.Backup.human(r.bytes));
    } catch (e) {
      toast('导出失败：' + ((e && e.message) || '未知错误'));
    } finally {
      delete btn.dataset.busy;
      btn.textContent = label;
      renderStats();
    }
  }

  async function doImport(file) {
    const btn = $('#bImport');
    if (btn.dataset.busy) return;
    btn.dataset.busy = '1';
    const label = btn.textContent;
    btn.textContent = '正在导入…';
    try {
      const r = await window.Backup.importZip(file);
      S.projects = await window.DB.all('projects');
      S.ideas = await window.DB.all('ideas');
      S.todos = await window.DB.all('todos');
      invalidateCorpus();
      render();
      await renderStats();
      if (r.added.ideas || r.added.projects || r.added.audio || r.added.images) {
        const bits = [r.added.ideas + ' 条灵感'];
        if (r.added.audio) bits.push(r.added.audio + ' 段录音');
        if (r.added.images) bits.push(r.added.images + ' 张照片');
        toast('导入完成：' + bits.join(' · '));
      } else {
        toast('备份里的内容都已经存在了');
      }
    } catch (e) {
      toast('导入失败：' + ((e && e.message) || '文件无法读取'));
    } finally {
      delete btn.dataset.busy;
      btn.textContent = label;
    }
  }

  /* ---------------- wiring ---------------- */
  function bind() {
    $('#themeBtn').addEventListener('click', () => setTheme(S.theme === 'dark' ? 'light' : 'dark'));

    $('#searchBtn').addEventListener('click', () => {
      const bar = $('#searchBar');
      bar.hidden = !bar.hidden;
      if (!bar.hidden) $('#searchInput').focus();
      else { S.query = ''; $('#searchInput').value = ''; render(); }
    });
    $('#searchClose').addEventListener('click', () => {
      S.query = ''; $('#searchInput').value = ''; $('#searchBar').hidden = true; render();
    });
    $('#searchInput').addEventListener('input', (e) => { S.query = e.target.value.trim(); renderList(); renderHeader(); });

    $('#recBtn').addEventListener('click', startRecording);
    $('#textBtn').addEventListener('click', startText);
    $('#photoBtn').addEventListener('click', () => startPhoto(true));
    $('#recStop').addEventListener('click', finishRecording);
    $('#recCancel').addEventListener('click', cancelRecording);

    /* --- photo viewer --- */
    $('#shotClose').addEventListener('click', closeViewer);
    $('#shotPrev').addEventListener('click', (e) => { e.stopPropagation(); stepViewer(-1); });
    $('#shotNext').addEventListener('click', (e) => { e.stopPropagation(); stepViewer(1); });
    $('#shotViewer').addEventListener('click', (e) => {
      // Tapping the picture or the backdrop dismisses; the arrows are a control, not a tap.
      if (e.target.closest('.shot-nav')) return;
      closeViewer();
    });

    $('#dPlay').addEventListener('click', () => { if (S.currentId) togglePlay(S.currentId); });
    const seek = $('#dSeek');
    seek.addEventListener('pointerdown', () => { seek.dataset.scrubbing = '1'; });
    seek.addEventListener('change', () => {
      delete seek.dataset.scrubbing;
      if (S.audioEl && S.audioEl.duration) S.audioEl.currentTime = (seek.value / 100) * S.audioEl.duration;
    });
    $('#dName').addEventListener('change', saveDetailFields);
    $('#dNote').addEventListener('change', saveDetailFields);
    $('#dMove').addEventListener('click', openMoveSheet);
    $('#dDelete').addEventListener('click', deleteIdea);

    $('#dTranscribe').addEventListener('click', async () => {
      const i = findIdea(S.currentId);
      if (!i) return;
      const rec = await window.DB.get('audio', i.id);
      if (!rec || !rec.blob) { toast('这段录音已丢失'); return; }
      transcribeBlob(rec.blob, $('#dTranscribe'), $('#dTransStatus'), (text, streaming) => {
        $('#dNote').value = text;
        if (!streaming) saveDetailFields();
      });
    });

    $('#dDistill').addEventListener('click', () => {
      if (S.currentId) openDistill({ kind: 'idea', ideaId: S.currentId });
    });

    $('#distillBtn').addEventListener('click', () => {
      // Inbox rolls up everything unfiled; a project rolls up its own ideas.
      openDistill({ kind: 'project', projectId: S.view === 'inbox' ? null : S.view });
    });

    $('#sSave').addEventListener('click', commitSave);
    $('#sDiscard').addEventListener('click', discardPending);
    $('#sClose').addEventListener('click', discardPending);
    $('#sTitle').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitSave(); }
    });
    $('#sTranscribe').addEventListener('click', () => {
      // Only a recording can be transcribed; the row is hidden for the other two kinds.
      if (!S.pending || !S.pending.blob) return;
      const base = $('#sNote').value.trim();
      transcribeBlob(S.pending.blob, $('#sTranscribe'), $('#sTransStatus'), (text, streaming) => {
        $('#sNote').value = base ? base + '\n' + text : text;
        const t = $('#sTitle');
        if (!streaming && !t.value.trim()) t.value = text.slice(0, 18);
      });
    });

    $('#pCreate').addEventListener('click', createProject);
    $('#pName').addEventListener('keydown', (e) => { if (e.key === 'Enter') createProject(); });

    $('#dataBtn').addEventListener('click', openDataSheet);

    /* --- contacts, groups, sharing --- */
    $('#cAdd').addEventListener('click', addContact);
    $('#cAlias').addEventListener('keydown', (e) => { if (e.key === 'Enter') addContact(); });
    $('#grCreate').addEventListener('click', createOrExtendGroup);
    $('#grName').addEventListener('keydown', (e) => { if (e.key === 'Enter') createOrExtendGroup(); });
    $('#shGo').addEventListener('click', doShare);

    /* --- discussion composer --- */
    const tInput = $('#tInput');
    tInput.addEventListener('input', () => {
      tInput.style.height = 'auto';
      tInput.style.height = Math.min(120, tInput.scrollHeight) + 'px';
      updateComposer();
    });
    tInput.addEventListener('keydown', (e) => {
      const pal = $('#tPalette');
      const open = !pal.hidden && pal.children.length > 0;

      if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        S.cmdPick = Math.max(0, Math.min(pal.children.length - 1,
          S.cmdPick + (e.key === 'ArrowDown' ? 1 : -1)));
        Array.prototype.forEach.call(pal.children, (c, i) => c.classList.toggle('on', i === S.cmdPick));
        return;
      }
      if (e.key === 'Escape' && open) { e.preventDefault(); pal.hidden = true; return; }
      if (e.key !== 'Enter' || e.shiftKey) return;

      e.preventDefault();
      // Enter picks the highlighted command while the palette is open, unless what is
      // already typed is a complete command that needs no arguments.
      const p = window.Commands.parse(tInput.value.trim());
      if (open && !(p.kind === 'command' && window.Commands.isComplete(p))) {
        const s = window.Commands.suggest(tInput.value.trim())[S.cmdPick];
        if (s) {
          tInput.value = s.name + ' ';
          tInput.focus();
          updateComposer();
        }
        return;
      }
      sendThreadMessage();
    });
    $('#tSend').addEventListener('click', sendThreadMessage);
    $('#tCmd').addEventListener('click', () => {
      tInput.value = '/';
      tInput.focus();
      updateComposer();
    });

    $('#modeSeg').querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => setMode(b.dataset.mode));
    });
    $('#apiSave').addEventListener('click', async () => {
      const url = $('#apiUrl').value.trim();
      const key = $('#apiKey').value.trim();
      window.Api.configure({ url: url, anonKey: key });
      renderSettings();
      if (!window.Api.isConfigured()) { toast('地址或 anon key 看起来不完整'); return; }
      // A stale session from a different project must not survive a backend change.
      await window.Api.signOut();
      await refreshOnline();
      toast('已保存后端设置，请登录或注册');
    });
    $('#authSignIn').addEventListener('click', () => doAuth('in'));
    $('#authSignUp').addEventListener('click', () => doAuth('up'));
    $('#authOut').addEventListener('click', async () => {
      await window.Api.signOut();
      await refreshOnline();
      toast('已退出登录');
    });
    $('#authPass').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doAuth('in'); }
    });

    $('#bExport').addEventListener('click', doExport);
    $('#bImport').addEventListener('click', () => $('#bFile').click());
    $('#bFile').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) doImport(f);
    });
    $('#persistBtn').addEventListener('click', async () => {
      const ok = await window.Backup.requestPersist();
      toast(ok ? '已开启持久化存储' : '系统暂未授予，建议定期导出备份');
      renderStats();
    });

    const row = $('#pEmoji');
    ICONS.forEach((n) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = icon(n);
      b.setAttribute('aria-label', n);
      b.addEventListener('click', () => {
        S.newIcon = n;
        row.querySelectorAll('button').forEach((x) => x.classList.remove('sel'));
        b.classList.add('sel');
      });
      row.appendChild(b);
    });
    row.firstChild.classList.add('sel');

    document.querySelectorAll('[data-close]').forEach((b) => {
      b.addEventListener('click', () => {
        $('#' + b.dataset.close).hidden = true;
        // Leaving a discussion is the natural moment to pick up other members' changes.
        if (b.dataset.close === 'threadSheet' && S.thread) refreshGroup(S.thread.group.id);
        if (b.dataset.close === 'detailSheet') { closeViewer(); window.Photo.release(); }
      });
    });
    document.querySelectorAll('.sheet').forEach((s) => {
      s.addEventListener('click', (e) => {
        if (e.target !== s) return;
        // Tapping away from the save sheet throws the capture away, so route it through
        // the same path as the discard button rather than just hiding the sheet.
        if (s.id === 'saveSheet') { discardPending(); return; }
        s.hidden = true;
        if (s.id === 'threadSheet' && S.thread) refreshGroup(S.thread.group.id);
        if (s.id === 'detailSheet') { closeViewer(); window.Photo.release(); }
      });
    });
  }

  /* ---------------- boot ---------------- */
  async function boot() {
    buildBars();
    let saved = null;
    try { saved = localStorage.getItem('spark.theme'); } catch (e) { /* ignore */ }
    const sysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    setTheme(saved || (sysDark ? 'dark' : 'light'));

    await window.DB.open();
    S.projects = await window.DB.all('projects');
    S.ideas = await window.DB.all('ideas');
    S.todos = await window.DB.all('todos');
    invalidateCorpus();

    // The online edition is opt-in and stays dormant until the user flips the switch in
    // settings; loading the saved config here costs nothing and makes that switch instant.
    window.Api.load();
    let savedMode = null;
    try { savedMode = localStorage.getItem('spark.mode'); } catch (e) { /* ignore */ }
    S.mode = savedMode === 'online' ? 'online' : 'local';

    render();
    bind();

    if (S.mode === 'online' && window.Api.isSignedIn()) refreshOnline();

    // Probe the offline recogniser once, up front, so the transcribe buttons start in the
    // right state instead of flipping after a sheet is already open.
    try {
      S.speech = await window.Speech.available();
    } catch (e) {
      S.speech = { ok: false, reason: '离线识别引擎不可用' };
    }
    applySpeechSupport();

    // ask for durable storage; harmless if the browser declines without a gesture
    window.Backup.requestPersist();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
