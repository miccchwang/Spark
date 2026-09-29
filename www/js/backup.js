/* Spark — backup, restore and storage durability.
   Everything lives in IndexedDB, which a WebView may evict without warning,
   so this module provides a way out: one .zip holding the idea list plus every
   recording and photo as a normal file. */
window.Backup = (function () {
  const FORMAT = 'spark-backup';
  /* v2 adds images/. v3 adds the canvas: boards.json, nodes.json and edges.json.
     Older archives still import. A file that is not there is read as an empty list, which is
     exactly right — a v1 backup had no photos, and a v2 one had no boards. */
  const VERSION = 3;

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

  /* Photos keep their real format. In practice nearly everything has already been
     re-encoded to JPEG on the way in, but a kept-as-is screenshot is still a PNG. */
  function imgExtFor(mime) {
    const m = (mime || '').toLowerCase();
    if (m.indexOf('png') >= 0) return 'png';
    if (m.indexOf('webp') >= 0) return 'webp';
    if (m.indexOf('gif') >= 0) return 'gif';
    if (m.indexOf('heic') >= 0 || m.indexOf('heif') >= 0) return 'heic';
    if (m.indexOf('bmp') >= 0) return 'bmp';
    return 'jpg';
  }

  function imgMimeForExt(ext) {
    const e = (ext || '').toLowerCase();
    if (e === 'png') return 'image/png';
    if (e === 'webp') return 'image/webp';
    if (e === 'gif') return 'image/gif';
    if (e === 'heic' || e === 'heif') return 'image/heic';
    if (e === 'bmp') return 'image/bmp';
    return 'image/jpeg';
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
    const [projects, ideas, audio, images, boards, nodes, edges] = await Promise.all([
      window.DB.all('projects'),
      window.DB.all('ideas'),
      window.DB.all('audio'),
      window.DB.all('images'),
      window.DB.all('boards'),
      window.DB.all('nodes'),
      window.DB.all('edges'),
    ]);
    return { projects, ideas, audio, images, boards, nodes, edges };
  }

  async function buildBlob() {
    const { projects, ideas, audio, images, boards, nodes, edges } = await collect();
    const audioIndex = [];
    const imageIndex = [];
    const entries = [];

    for (const rec of audio) {
      if (!rec || !rec.blob) continue;
      const ext = extFor(rec.mime || rec.blob.type);
      const file = 'audio/' + rec.id + '.' + ext;
      const bytes = new Uint8Array(await rec.blob.arrayBuffer());
      entries.push({ name: file, data: bytes });
      audioIndex.push({ id: rec.id, file, mime: rec.mime || rec.blob.type || mimeForExt(ext), size: bytes.length });
    }

    for (const rec of images) {
      if (!rec || !rec.blob) continue;
      const ext = imgExtFor(rec.mime || rec.blob.type);
      const file = 'images/' + rec.id + '.' + ext;
      const bytes = new Uint8Array(await rec.blob.arrayBuffer());
      entries.push({ name: file, data: bytes });
      imageIndex.push({
        id: rec.id,
        ideaId: rec.ideaId,
        file,
        mime: rec.mime || rec.blob.type || imgMimeForExt(ext),
        w: rec.w || 0,
        h: rec.h || 0,
        size: bytes.length,
        createdAt: rec.createdAt || 0,
      });
    }

    // Only recordings can have audio. A written or photographic idea without one is not
    // missing anything.
    const missing = ideas
      .filter((i) => (i.kind || 'voice') === 'voice' && !audioIndex.some((a) => a.id === i.id))
      .map((i) => i.id);
    const now = new Date();

    const manifest = {
      format: FORMAT,
      version: VERSION,
      app: 'Spark',
      exportedAt: now.toISOString(),
      counts: {
        projects: projects.length,
        ideas: ideas.length,
        audio: audioIndex.length,
        images: imageIndex.length,
        boards: boards.length,
        nodes: nodes.length,
        edges: edges.length,
      },
      missingAudio: missing,
    };

    const readme = [
      'Spark 灵感备份',
      '',
      '导出时间：' + now.toLocaleString(),
      '灵感 ' + ideas.length + ' 条 · 项目 ' + projects.length + ' 个 · 录音 ' + audioIndex.length +
        ' 段 · 照片 ' + imageIndex.length + ' 张 · 画布 ' + boards.length + ' 块',
      '',
      '目录说明',
      '  manifest.json  备份信息与统计',
      '  projects.json  项目列表',
      '  ideas.json     灵感元数据（类型、标题、备注、时间、坐标、时长）',
      '  audio.json     录音文件索引（id / 文件名 / 格式 / 大小）',
      '  audio/         每段录音的原文件，可直接双击播放',
      '  images.json    照片索引（id / 所属灵感 / 文件名 / 尺寸 / 大小）',
      '  images/        每张照片的原文件，可直接双击查看',
      '  boards.json    画布列表（名称、上次打开的位置）',
      '  nodes.json     画布上的卡片（坐标、文字，或引用哪条灵感 / 待办）',
      '  edges.json     卡片之间的连线',
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
      { name: 'images.json', data: JSON.stringify(imageIndex, null, 2) },
      { name: 'boards.json', data: JSON.stringify(boards, null, 2) },
      { name: 'nodes.json', data: JSON.stringify(nodes, null, 2) },
      { name: 'edges.json', data: JSON.stringify(edges, null, 2) },
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
    // Absent in a v1 archive, which is fine: it had no photos.
    const inImages = byName.get('images.json') ? json(byName.get('images.json').data) : [];
    // Absent before v3: no boards, no cards, no lines.
    const inBoards = byName.get('boards.json') ? json(byName.get('boards.json').data) : [];
    const inNodes = byName.get('nodes.json') ? json(byName.get('nodes.json').data) : [];
    const inEdges = byName.get('edges.json') ? json(byName.get('edges.json').data) : [];

    const [haveProjects, haveIdeas, haveAudio, haveImages, haveBoards] = await Promise.all([
      window.DB.all('projects'),
      window.DB.all('ideas'),
      window.DB.all('audio'),
      window.DB.all('images'),
      window.DB.all('boards'),
    ]);
    const projectIds = new Set(haveProjects.map((p) => p.id));
    const ideaIds = new Set(haveIdeas.map((i) => i.id));
    const audioIds = new Set(haveAudio.map((a) => a.id));
    const imageIds = new Set(haveImages.map((a) => a.id));
    const boardIds = new Set(haveBoards.map((b) => b.id));

    const added = { projects: 0, ideas: 0, audio: 0, images: 0, boards: 0, nodes: 0, edges: 0 };
    const skipped = { projects: 0, ideas: 0, audio: 0, images: 0, boards: 0, nodes: 0, edges: 0 };

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

    for (const a of inImages) {
      if (!a || !a.id || !a.file || !a.ideaId) continue;
      if (imageIds.has(a.id)) { skipped.images++; continue; }
      const entry = byName.get(a.file);
      if (!entry) { skipped.images++; continue; }
      const mime = a.mime || imgMimeForExt(a.file.split('.').pop());
      await window.DB.put('images', {
        id: a.id,
        ideaId: a.ideaId,
        mime,
        w: a.w || 0,
        h: a.h || 0,
        createdAt: a.createdAt || 0,
        blob: new Blob([entry.data.slice()], { type: mime }),
      });
      imageIds.add(a.id);
      added.images++;
    }

    for (const i of inIdeas) {
      if (!i || !i.id) continue;
      if (ideaIds.has(i.id)) { skipped.ideas++; continue; }
      const next = Object.assign({}, i);
      // a restored idea must not point at a project that does not exist here
      if (next.projectId && !projectIds.has(next.projectId)) next.projectId = null;
      // Only a recording can be missing its audio — a written or photographic idea was
      // never supposed to have any.
      const kind = next.kind || 'voice';
      if (kind === 'voice' && !audioIds.has(next.id)) next.audioMissing = true;
      if (kind === 'photo') {
        const landed = inImages.some((im) => im.ideaId === next.id && imageIds.has(im.id));
        if (!landed) next.imageMissing = true;
      }
      await window.DB.put('ideas', next);
      ideaIds.add(next.id);
      added.ideas++;
    }

    /* The canvas goes in last and in order: boards, then cards, then lines. Each layer can
       only be checked against the one below it. */
    for (const b of inBoards) {
      if (!b || !b.id) continue;
      if (boardIds.has(b.id)) { skipped.boards++; continue; }
      await window.DB.put('boards', b);
      boardIds.add(b.id);
      added.boards++;
    }

    for (const n of inNodes) {
      if (!n || !n.id) continue;
      // A card on a board that is not here has nowhere to live.
      if (!boardIds.has(n.boardId)) { skipped.nodes++; continue; }
      if (await window.DB.get('nodes', n.id)) { skipped.nodes++; continue; }
      // A card pointing at an idea that did not come across keeps the text it was saved
      // with, so it still reads as something rather than as an empty box.
      await window.DB.put('nodes', n);
      added.nodes++;
    }

    for (const e of inEdges) {
      if (!e || !e.id || !e.from || !e.to) continue;
      if (!boardIds.has(e.boardId)) { skipped.edges++; continue; }
      // A line to a card that is not here would draw into nothing.
      const [a, b] = await Promise.all([window.DB.get('nodes', e.from), window.DB.get('nodes', e.to)]);
      if (!a || !b) { skipped.edges++; continue; }
      if (await window.DB.get('edges', e.id)) { skipped.edges++; continue; }
      await window.DB.put('edges', e);
      added.edges++;
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
