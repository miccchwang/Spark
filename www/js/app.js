/* Spark — capture ideas as voice notes with time and place, filed into projects. */
(function () {
  const S = {
    projects: [],
    ideas: [],
    todos: [],
    view: 'inbox',        // 'inbox' | 'todos' | project id
    query: '',
    theme: 'dark',
    audioEl: null,
    audioId: null,
    currentId: null,
    newIcon: 'bulb',
    delArmed: false,
    pending: null,        // a finished recording waiting for its topic, not yet persisted
    speech: null,         // result of the offline recogniser probe
    distill: null,        // the payload currently shown in the distill sheet
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
    distillBtn.hidden = false;

    const isInbox = S.view === 'inbox';
    $('#viewTitle').textContent = isInbox ? '收件箱' : projName(S.view);
    $('#viewSub').textContent = visibleIdeas().length + ' 个灵感';
    $('#recMeta').textContent = isInbox
      ? '长按卡片可拖到上方项目归档'
      : '新录音会存进「' + projName(S.view) + '」';
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

    const items = visibleIdeas();
    if (!items.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.innerHTML = S.query
        ? icon('search', 'lg big') + '没有匹配的灵感'
        : icon('spark', 'lg big') + '这里还空着<br>点下面的按钮，把刚冒出来的想法说出来';
      list.appendChild(e);
      return;
    }
    items.forEach((i) => list.appendChild(makeCard(i)));
  }

  function makeCard(i) {
    const el = document.createElement('div');
    el.className = 'card';
    el.dataset.id = i.id;
    el.innerHTML =
      '<div class="card-top"><span class="grip">' + icon('grip') + '</span>' +
      '<div class="card-body"><p class="card-title"></p><div class="card-meta">' +
      '<span class="m-when"></span><span class="m-loc"></span><span class="m-dur"></span>' +
      '</div><p class="card-note"></p></div>' +
      '<button class="play" aria-label="播放">' + icon('play') + '</button></div>';

    const title = el.querySelector('.card-title');
    title.textContent = i.title || '未命名灵感';
    if (!i.title) title.classList.add('untitled');

    el.querySelector('.m-when').innerHTML = icon('clock', 'sm') + '<span>' + fmtWhen(i.createdAt) + '</span>';
    el.querySelector('.m-loc').innerHTML = icon('pin', 'sm') + '<span>' +
      (i.lat == null ? '无位置' : i.lat.toFixed(2) + ', ' + i.lon.toFixed(2)) + '</span>';
    el.querySelector('.m-dur').innerHTML = icon('timer', 'sm') + '<span>' + fmtDur(i.durationMs) + '</span>';

    const note = el.querySelector('.card-note');
    if (i.note) { note.textContent = i.note; } else { note.remove(); }

    const play = el.querySelector('.play');
    play.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(i.id); });

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
    $('#dMeta').innerHTML =
      metaRow('clock', fmtFull(i.createdAt)) +
      metaRow('pin', where) +
      metaRow('folder', inProj) +
      metaRow('timer', '时长 ' + fmtDur(i.durationMs));
    $('#dDur').textContent = '00:00';
    $('#dSeek').value = 0;
    syncPlayIcons();
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

    const loc = await locPromise;
    if (!out.blob || out.blob.size < 500) { toast('录音太短，已丢弃'); return; }

    // Nothing is written yet. The save sheet collects the topic first, so a recording the
    // user walks away from never lands in the database.
    openSaveSheet(out, loc);
  }

  async function cancelRecording() {
    await window.Rec.cancel();
    clearInterval(recInterval);
    $('#recPanel').hidden = true;
    toast('已丢弃');
  }

  /* ---------------- save sheet: topic before the idea is stored ---------------- */

  function openSaveSheet(out, loc) {
    S.pending = {
      blob: out.blob,
      mime: out.mime,
      durationMs: out.durationMs,
      lat: loc ? loc.lat : null,
      lon: loc ? loc.lon : null,
      projectId: S.view === 'inbox' ? null : S.view,
    };

    $('#sTitle').value = '';
    $('#sNote').value = '';
    $('#sMeta').innerHTML =
      metaRow('clock', fmtWhen(Date.now())) +
      metaRow('pin', S.pending.lat == null
        ? '未记录位置'
        : S.pending.lat.toFixed(4) + ', ' + S.pending.lon.toFixed(4)) +
      metaRow('timer', '时长 ' + fmtDur(S.pending.durationMs));

    renderSaveProjects();
    resetTransStatus($('#sTransStatus'));
    $('#saveSheet').hidden = false;
    setTimeout(() => $('#sTitle').focus(), 150);
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

    const id = window.DB.uid();
    await window.DB.put('audio', { id, blob: pend.blob, mime: pend.mime });

    const idea = {
      id,
      projectId: pend.projectId || null,
      title: $('#sTitle').value.trim(),
      note: $('#sNote').value.trim(),
      durationMs: pend.durationMs,
      createdAt: Date.now(),
      lat: pend.lat,
      lon: pend.lon,
    };
    await window.DB.put('ideas', idea);

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
    toast('已存到' + where + (idea.lat == null ? ' · 无位置' : ' · 含位置'));
  }

  async function discardPending() {
    if (!S.pending) return;
    await window.Speech.cancel();
    S.pending = null;
    $('#saveSheet').hidden = true;
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

  /* ---------------- backup & storage ---------------- */
  async function renderStats() {
    const grid = $('#statGrid');
    const audio = await window.DB.all('audio');
    const audioBytes = audio.reduce((n, a) => n + ((a.blob && a.blob.size) || 0), 0);
    const info = await window.Backup.info();

    const cells = [
      ['灵感', S.ideas.length + ' 条'],
      ['项目', S.projects.length + ' 个'],
      ['录音', audio.length + ' 段 · ' + window.Backup.human(audioBytes)],
      ['已用空间', window.Backup.human(info.usage)],
    ];
    grid.innerHTML = '';
    cells.forEach((pair) => {
      const box = document.createElement('div');
      box.className = 'stat';
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
      txt.textContent = '持久化存储未开启，系统在空间紧张时可能清掉录音。建议先导出备份。';
    }
  }

  function openDataSheet() {
    $('#dataSheet').hidden = false;
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
      if (r.added.ideas || r.added.projects || r.added.audio) {
        toast('导入完成：' + r.added.ideas + ' 条灵感 · ' + r.added.audio + ' 段录音');
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
    $('#recStop').addEventListener('click', finishRecording);
    $('#recCancel').addEventListener('click', cancelRecording);

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
      if (!S.pending) return;
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
      b.addEventListener('click', () => { $('#' + b.dataset.close).hidden = true; });
    });
    document.querySelectorAll('.sheet').forEach((s) => {
      s.addEventListener('click', (e) => {
        if (e.target !== s) return;
        // Tapping away from the save sheet throws the recording away, so route it through
        // the same path as the discard button rather than just hiding the sheet.
        if (s.id === 'saveSheet') discardPending();
        else s.hidden = true;
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
    render();
    bind();

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
