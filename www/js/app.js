/* Spark — capture ideas as voice notes with time and place, filed into projects. */
(function () {
  const S = {
    projects: [],
    ideas: [],
    view: 'inbox',        // 'inbox' | project id
    query: '',
    theme: 'dark',
    audioEl: null,
    audioId: null,
    currentId: null,
    newEmoji: '💡',
    delArmed: false,
  };

  const $ = (s) => document.querySelector(s);
  const EMOJIS = ['💡', '🚀', '🎯', '🧠', '📚', '🎨', '🏃', '💼', '🌱', '🍜', '✈️', '🧪'];

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
    $('#themeBtn').textContent = t === 'dark' ? '☀️' : '🌙';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#0f1115' : '#f5f6f8');
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
    const isInbox = S.view === 'inbox';
    $('#viewTitle').textContent = isInbox ? '收件箱' : projName(S.view);
    const n = visibleIdeas().length;
    $('#viewSub').textContent = n + ' 个灵感';
    $('#recMeta').textContent = isInbox
      ? '长按卡片可拖到上方项目归档'
      : '新录音会存进「' + projName(S.view) + '」';
  }

  function makeChip(o) {
    const b = document.createElement('button');
    b.className = 'chip' + (o.active ? ' active' : '');
    b.setAttribute('data-drop', o.drop);
    const em = document.createElement('span');
    em.textContent = o.emoji;
    const nm = document.createElement('span');
    nm.textContent = o.label;
    const ct = document.createElement('span');
    ct.className = 'count';
    ct.textContent = o.count;
    b.append(em, nm, ct);
    b.addEventListener('click', () => { S.view = o.drop; render(); });
    if (o.project) attachChipLongPress(b, o.project);
    return b;
  }

  function renderRail() {
    const rail = $('#projectRail');
    rail.innerHTML = '';
    rail.appendChild(makeChip({ drop: 'inbox', label: '收件箱', emoji: '📥', count: countIn(null), active: S.view === 'inbox' }));
    S.projects.forEach((p) => {
      rail.appendChild(makeChip({ drop: p.id, label: p.name, emoji: p.emoji, count: countIn(p.id), active: S.view === p.id, project: p }));
    });
    const add = document.createElement('button');
    add.className = 'chip add';
    add.textContent = '＋ 新项目';
    add.addEventListener('click', openProjectSheet);
    rail.appendChild(add);
  }

  function renderList() {
    const list = $('#ideaList');
    list.innerHTML = '';
    const items = visibleIdeas();
    if (!items.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.innerHTML = S.query
        ? '<span class="big">🔍</span>没有匹配的灵感'
        : '<span class="big">✨</span>这里还空着<br>点下面的按钮，把刚冒出来的想法说出来';
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
      '<div class="card-top"><span class="grip">⠿</span><div class="card-body">' +
      '<p class="card-title"></p><div class="card-meta">' +
      '<span class="m-when"></span><span class="m-loc"></span><span class="m-dur"></span>' +
      '</div><p class="card-note"></p></div>' +
      '<button class="play">▶️</button></div>';

    const title = el.querySelector('.card-title');
    title.textContent = i.title || '未命名灵感';
    if (!i.title) title.classList.add('untitled');

    el.querySelector('.m-when').textContent = '🕒 ' + fmtWhen(i.createdAt);
    el.querySelector('.m-loc').textContent = (i.lat == null) ? '📍 无位置' : '📍 ' + i.lat.toFixed(4) + ', ' + i.lon.toFixed(4);
    el.querySelector('.m-dur').textContent = '⏱️ ' + fmtDur(i.durationMs);

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
    S.newEmoji = '💡';
    $('#projectSheet').hidden = false;
    setTimeout(() => $('#pName').focus(), 120);
  }

  async function createProject() {
    const name = $('#pName').value.trim();
    if (!name) { toast('先给项目起个名字'); return; }
    const p = { id: window.DB.uid(), name, emoji: S.newEmoji, createdAt: Date.now() };
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
    x.className = 'icon-btn';
    x.textContent = '✕';
    x.addEventListener('click', () => wrap.remove());
    head.append(h, x);
    card.appendChild(head);
    const list = document.createElement('div');
    list.className = 'move-list';
    items.forEach((it) => {
      const b = document.createElement('button');
      b.className = 'move-item';
      b.textContent = it.label;
      b.addEventListener('click', () => { wrap.remove(); if (it.run) it.run(); });
      list.appendChild(b);
    });
    card.appendChild(list);
    wrap.appendChild(card);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
    document.body.appendChild(wrap);
  }

  function projectActions(p) {
    showActions(p.emoji + ' ' + p.name, [
      {
        label: '✏️ 重命名',
        run: async () => {
          const n = prompt('新项目名称', p.name);
          if (n && n.trim()) { p.name = n.trim(); await window.DB.put('projects', p); render(); }
        },
      },
      {
        label: '🎨 换图标',
        run: async () => {
          const e = prompt('输入一个 emoji 作为图标', p.emoji);
          if (e && e.trim()) { p.emoji = e.trim().slice(0, 4); await window.DB.put('projects', p); render(); }
        },
      },
      {
        label: '🗑️ 删除项目',
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
      b.textContent = playing ? '⏸️' : '▶️';
    });
    const dp = $('#dPlay');
    if (dp) {
      const playing = S.audioId === S.currentId && S.audioEl && !S.audioEl.paused;
      dp.textContent = playing ? '⏸️' : '▶️';
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
  function openDetail(id) {
    const i = findIdea(id);
    if (!i) return;
    S.currentId = id;
    S.delArmed = false;
    $('#dName').value = i.title || '';
    $('#dNote').value = i.note || '';
    $('#dDelete').textContent = '删除';
    $('#detailSheet').hidden = false;

    const where = i.lat == null
      ? '📍 未记录位置'
      : '📍 ' + i.lat.toFixed(5) + ', ' + i.lon.toFixed(5) +
        ' · <a href="geo:0,0?q=' + i.lat + ',' + i.lon + '">在地图中查看</a>';
    const inProj = i.projectId ? '🗂️ ' + projName(i.projectId) : '🗂️ 收件箱（未归档）';
    $('#dMeta').innerHTML =
      '🕒 ' + fmtFull(i.createdAt) + '<br>' + where + '<br>' + inProj + '<br>⏱️ 时长 ' + fmtDur(i.durationMs);
    $('#dDur').textContent = '00:00';
    $('#dSeek').value = 0;
    syncPlayIcons();
  }

  async function saveDetailFields() {
    const i = findIdea(S.currentId);
    if (!i) return;
    i.title = $('#dName').value.trim();
    i.note = $('#dNote').value;
    await window.DB.put('ideas', i);
    render();
  }

  async function deleteIdea() {
    const i = findIdea(S.currentId);
    if (!i) return;
    if (!S.delArmed) { S.delArmed = true; $('#dDelete').textContent = '确认删除？'; return; }
    if (S.audioId === i.id) stopAudio();
    await window.DB.del('ideas', i.id);
    await window.DB.del('audio', i.id);
    S.ideas = S.ideas.filter((x) => x.id !== i.id);
    $('#detailSheet').hidden = true;
    render();
    toast('已删除');
  }

  function openMoveSheet() {
    const i = findIdea(S.currentId);
    if (!i) return;
    const box = $('#moveList');
    box.innerHTML = '';
    const opts = [{ id: null, name: '收件箱', emoji: '📥' }].concat(S.projects);
    opts.forEach((p) => {
      const b = document.createElement('button');
      b.className = 'move-item' + ((i.projectId || null) === p.id ? ' current' : '');
      b.textContent = p.emoji + ' ' + p.name + ((i.projectId || null) === p.id ? '（当前）' : '');
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

    const id = window.DB.uid();
    await window.DB.put('audio', { id, blob: out.blob, mime: out.mime });
    const idea = {
      id,
      projectId: S.view === 'inbox' ? null : S.view,
      title: '',
      note: '',
      durationMs: out.durationMs,
      createdAt: Date.now(),
      lat: loc ? loc.lat : null,
      lon: loc ? loc.lon : null,
    };
    await window.DB.put('ideas', idea);
    S.ideas.push(idea);
    render();

    const card = document.querySelector('.card[data-id="' + id + '"]');
    if (card) {
      card.classList.add('flash');
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    toast(loc ? '已保存 · 含位置信息' : '已保存 · 未取得位置');
  }

  async function cancelRecording() {
    await window.Rec.cancel();
    clearInterval(recInterval);
    $('#recPanel').hidden = true;
    toast('已丢弃');
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
      btn.hidden = true;
      txt.textContent = '✓ 已开启持久化存储，系统不会自动清理这些灵感。';
    } else {
      wrap.classList.remove('ok');
      btn.hidden = false;
      txt.textContent = '⚠️ 持久化存储未开启，系统在空间紧张时可能清掉录音。建议先导出备份。';
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
    EMOJIS.forEach((e) => {
      const b = document.createElement('button');
      b.textContent = e;
      b.addEventListener('click', () => {
        S.newEmoji = e;
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
      s.addEventListener('click', (e) => { if (e.target === s) s.hidden = true; });
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
    render();
    bind();

    // ask for durable storage; harmless if the browser declines without a gesture
    window.Backup.requestPersist();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
