/* Spark — backup, restore and storage durability.
   Everything lives in IndexedDB, which a WebView may evict without warning,
   so this module provides a way out: one .zip holding the idea list plus every
   recording as a normal audio file. */
window.Backup = (function () {
  const FORMAT = 'spark-backup';
  const VERSION = 1;

  /* ---------------- helpers ---------------- */
  function extFor(mime) {
    const m = (mime || '').toLowerCase();
    if (m.indexOf('mp4') >= 0 || m.indexOf('aac') >= 0) return 'm4a';
    if (m.indexOf('mpeg') >= 0 || m.indexOf('mp3') >= 0) return 'mp3';
    if (m.indexOf('ogg') >= 0) return 'ogg';
    if (m.indexOf('wav') >= 0) return 'wav';
    return 'webm';
  }

  function mimeForExt(ext) {
    const e = (ext || '').toLowerCase();
    if (e === 'm4a') return 'audio/mp4';
    if (e === 'mp3') return 'audio/mpeg';
    if (e === 'ogg') return 'audio/ogg';
    if (e === 'wav') return 'audio/wav';
    return 'audio/webm';
  }

  function stamp(d) {
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
      p(d.getHours()) + p(d.getMinutes());
  }

  function human(bytes) {
    if (!bytes) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0, n = bytes;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + u[i];
  }

  const text = (u8) => new TextDecoder().decode(u8);
  const json = (u8) => JSON.parse(text(u8));

  /* ---------------- export ---------------- */
  async function collect() {
    const [projects, ideas, audio] = await Promise.all([
      window.DB.all('projects'),
      window.DB.all('ideas'),
      window.DB.all('audio'),
    ]);
    return { projects, ideas, audio };
  }

  async function buildBlob() {
    const { projects, ideas, audio } = await collect();
    const audioIndex = [];
    const entries = [];

    for (const rec of audio) {
      if (!rec || !rec.blob) continue;
      const ext = extFor(rec.mime || rec.blob.type);
      const file = 'audio/' + rec.id + '.' + ext;
      const bytes = new Uint8Array(await rec.blob.arrayBuffer());
      entries.push({ name: file, data: bytes });
      audioIndex.push({ id: rec.id, file, mime: rec.mime || rec.blob.type || mimeForExt(ext), size: bytes.length });
    }

    const missing = ideas.filter((i) => !audioIndex.some((a) => a.id === i.id)).map((i) => i.id);
    const now = new Date();

    const manifest = {
      format: FORMAT,
      version: VERSION,
      app: 'Spark',
      exportedAt: now.toISOString(),
      counts: { projects: projects.length, ideas: ideas.length, audio: audioIndex.length },
      missingAudio: missing,
    };

    const readme = [
      'Spark 灵感备份',
      '',
      '导出时间：' + now.toLocaleString(),
      '灵感 ' + ideas.length + ' 条 · 项目 ' + projects.length + ' 个 · 录音 ' + audioIndex.length + ' 段',
      '',
      '目录说明',
      '  manifest.json  备份信息与统计',
      '  projects.json  项目列表',
      '  ideas.json     灵感元数据（标题、备注、时间、坐标、时长）',
      '  audio.json     录音文件索引（id / 文件名 / 格式 / 大小）',
      '  audio/         每段录音的原文件，可直接双击播放',
      '',
      '在 Spark 中「从备份导入」即可还原。导入采用合并方式，',
      '已存在的灵感不会被覆盖或重复。',
    ].join('\n');

    // manifest first so a human opening the zip sees it at the top
    const all = [
      { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
      { name: 'README.txt', data: readme },
      { name: 'projects.json', data: JSON.stringify(projects, null, 2) },
      { name: 'ideas.json', data: JSON.stringify(ideas, null, 2) },
      { name: 'audio.json', data: JSON.stringify(audioIndex, null, 2) },
    ].concat(entries);

    const bytes = window.Zip.write(all, now);
    return {
      blob: new Blob([bytes], { type: 'application/zip' }),
      name: 'spark-backup-' + stamp(now) + '.zip',
      manifest,
    };
  }

  /* Deliver the file. On Android a plain download is unreliable, so prefer the
     share sheet (which can write to Files/Drive) and fall back to a download. */
  async function deliver(blob, name) {
    if (navigator.canShare && typeof File !== 'undefined') {
      try {
        const file = new File([blob], name, { type: 'application/zip' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: 'Spark 备份' });
          return 'shared';
        }
      } catch (e) {
        if (e && e.name === 'AbortError') return 'cancelled';
        // otherwise fall through to the download path
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 60000);
    return 'downloaded';
  }

  async function exportAll() {
    const { blob, name, manifest } = await buildBlob();
    const how = await deliver(blob, name);
    return { how, name, manifest, bytes: blob.size };
  }

  /* ---------------- import ---------------- */
  async function importZip(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const entries = await window.Zip.read(bytes);
    const byName = new Map(entries.map((e) => [e.name, e]));

    const manEntry = byName.get('manifest.json');
    if (!manEntry) throw new Error('缺少 manifest.json，这不是 Spark 备份');
    const manifest = json(manEntry.data);
    if (manifest.format !== FORMAT) throw new Error('备份格式不匹配');

    const inProjects = byName.get('projects.json') ? json(byName.get('projects.json').data) : [];
    const inIdeas = byName.get('ideas.json') ? json(byName.get('ideas.json').data) : [];
    const inAudio = byName.get('audio.json') ? json(byName.get('audio.json').data) : [];

    const [haveProjects, haveIdeas, haveAudio] = await Promise.all([
      window.DB.all('projects'),
      window.DB.all('ideas'),
      window.DB.all('audio'),
    ]);
    const projectIds = new Set(haveProjects.map((p) => p.id));
    const ideaIds = new Set(haveIdeas.map((i) => i.id));
    const audioIds = new Set(haveAudio.map((a) => a.id));

    const added = { projects: 0, ideas: 0, audio: 0 };
    const skipped = { projects: 0, ideas: 0, audio: 0 };

    for (const p of inProjects) {
      if (!p || !p.id) continue;
      if (projectIds.has(p.id)) { skipped.projects++; continue; }
      await window.DB.put('projects', p);
      projectIds.add(p.id);
      added.projects++;
    }

    for (const a of inAudio) {
      if (!a || !a.id || !a.file) continue;
      if (audioIds.has(a.id)) { skipped.audio++; continue; }
      const entry = byName.get(a.file);
      if (!entry) { skipped.audio++; continue; }
      const mime = a.mime || mimeForExt(a.file.split('.').pop());
      // copy into a fresh buffer so the blob owns its memory
      await window.DB.put('audio', { id: a.id, mime, blob: new Blob([entry.data.slice()], { type: mime }) });
      audioIds.add(a.id);
      added.audio++;
    }

    for (const i of inIdeas) {
      if (!i || !i.id) continue;
      if (ideaIds.has(i.id)) { skipped.ideas++; continue; }
      const next = Object.assign({}, i);
      // a restored idea must not point at a project that does not exist here
      if (next.projectId && !projectIds.has(next.projectId)) next.projectId = null;
      if (!audioIds.has(next.id)) next.audioMissing = true;
      await window.DB.put('ideas', next);
      ideaIds.add(next.id);
      added.ideas++;
    }

    return { added, skipped, manifest };
  }

  /* ---------------- storage durability ---------------- */
  async function info() {
    const out = { persisted: false, usage: 0, quota: 0, supported: false };
    if (!navigator.storage) return out;
    out.supported = true;
    try { if (navigator.storage.persisted) out.persisted = await navigator.storage.persisted(); } catch (e) { /* ignore */ }
    try {
      if (navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        out.usage = est.usage || 0;
        out.quota = est.quota || 0;
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  async function requestPersist() {
    if (!navigator.storage || !navigator.storage.persist) return false;
    try { return await navigator.storage.persist(); } catch (e) { return false; }
  }

  return { exportAll, importZip, info, requestPersist, human, buildBlob };
})();
