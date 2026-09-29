/* Spark — the canvas.

   A simplified Milanote board: a pan-and-zoom surface holding cards, and the lines between
   them. One surface covers all four things asked of it, because all four are the same
   primitive wearing different shapes. A mindmap is a radial arrangement of nodes and edges,
   a task tree is a hierarchical one, a flow is a left-to-right one. So rather than build
   four modes, this builds the one primitive and offers layout presets that rearrange it —
   you can start typing a tree and end up looking at a mindmap without changing tools.

   A card is either written here or borrowed from the idea list. A node carrying an ideaId or
   a todoId draws its text live from that record, so the canvas and the list can never drift
   apart: edit the idea, the card follows.

   Coordinates live in a fixed WORLD x WORLD world. A bounded world is not a limitation so
   much as a simplification — nodes can never go negative, so the edge layer can be one plain
   SVG drawn at raw coordinates, with no origin shifting, no viewBox arithmetic and no
   clipping. Four thousand units at the default zoom is roughly nine screens across.

   Two colours, as everywhere else. Selection is a thicker rule, a reference node is a
   second hairline, and edges are plain ink. Nothing here uses colour, grey or blur. */
window.Canvas = (function () {
  const WORLD = 4000;
  const NODE_W = 176;
  const MIN_K = 0.3;
  const MAX_K = 1.9;
  /** Keeps content off the very edge of the world, and off the very edge of the screen. */
  const PAD = 44;

  const C = {
    boards: [],
    board: null,        // the board being edited, or null for the board list
    nodes: [],
    edges: [],
    sel: null,          // selected node id
    connect: false,     // true while the toolbar's 连线 tool is armed
    connectFrom: null,  // first end of an edge while picking the second
    view: { x: 0, y: 0, k: 0.7 },
    ctx: { ideas: [], todos: [], openIdea: null },
    host: null,
  };

  /* Rendered node heights, filled at paint time. Layout needs real heights: a card holding
     three lines of text is twice the height of one holding a word, and a fixed pitch would
     either overlap the tall ones or scatter the short ones. */
  const heights = new Map();
  const ptrs = new Map();
  let mode = null;          // 'pan' | 'node' | 'pinch'
  let grab = null;
  let pinch = null;
  let viewTimer = 0;

  const $ = (s) => document.querySelector(s);
  const icon = (name, cls) =>
    '<svg class="ico' + (cls ? ' ' + cls : '') + '"><use href="#i-' + name + '"/></svg>';
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function toast(msg) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 2000);
  }

  /* ---------------- data ---------------- */

  async function load() {
    C.boards = (await window.DB.all('boards')).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return C.boards;
  }

  async function openBoard(id) {
    C.board = C.boards.find((b) => b.id === id) || null;
    C.sel = null;
    C.connectFrom = null;
    if (!C.board) { C.nodes = []; C.edges = []; return; }
    C.nodes = await window.DB.byIndex('nodes', 'boardId', C.board.id);
    C.edges = await window.DB.byIndex('edges', 'boardId', C.board.id);
    // Reopen where you left off, so a board you have been shaping for a while does not
    // greet you at the origin every time.
    const v = C.board.view;
    C.view = v && typeof v.k === 'number'
      ? { x: v.x, y: v.y, k: clamp(v.k, MIN_K, MAX_K) }
      : { x: 0, y: 0, k: 0.7 };
  }

  async function saveView() {
    if (!C.board) return;
    C.board.view = { x: C.view.x, y: C.view.y, k: C.view.k };
    await window.DB.put('boards', C.board);
  }

  async function touchBoard() {
    if (!C.board) return;
    C.board.updatedAt = Date.now();
    await window.DB.put('boards', C.board);
  }

  /** The text a card shows. A reference card reads through to its source every time. */
  function nodeText(n) {
    if (n.ideaId) {
      const i = C.ctx.ideas.find((x) => x.id === n.ideaId);
      if (!i) return n.text || '（灵感已删除）';
      return i.title || i.note || '未命名灵感';
    }
    if (n.todoId) {
      const t = C.ctx.todos.find((x) => x.id === n.todoId);
      if (!t) return n.text || '（待办已删除）';
      return t.text || '待办';
    }
    return n.text || '';
  }

  /** A reference card is drawn a touch differently, so it must be knowable at a glance. */
  const refIcon = (n) => (n.ideaId ? 'spark' : (n.todoId ? 'check' : null));

  /* ---------------- geometry ---------------- */

  const stageEl = () => $('#cvStage');
  const worldEl = () => $('#cvWorld');

  function applyView() {
    const w = worldEl();
    if (!w) return;
    w.style.transform =
      'translate(' + C.view.x + 'px,' + C.view.y + 'px) scale(' + C.view.k + ')';
  }

  /** Keep the board from being flung off screen, and centre it when it is smaller than the
      viewport rather than pinning it to a corner. */
  function clampView() {
    const st = stageEl();
    if (!st) return;
    const r = st.getBoundingClientRect();
    const w = WORLD * C.view.k;
    const fit = (size, view) => {
      if (w <= size) return (size - w) / 2;
      return clamp(view, size - w, 0);
    };
    C.view.x = fit(r.width, C.view.x);
    C.view.y = fit(r.height, C.view.y);
  }

  /** Zoom while holding one world point still under the finger. */
  function zoomAt(cx, cy, k2) {
    const k1 = C.view.k;
    const k = clamp(k2, MIN_K, MAX_K);
    if (k === k1) return;
    const wx = (cx - C.view.x) / k1;
    const wy = (cy - C.view.y) / k1;
    C.view.k = k;
    C.view.x = cx - wx * k;
    C.view.y = cy - wy * k;
    clampView();
    applyView();
  }

  function queueViewSave() {
    clearTimeout(viewTimer);
    viewTimer = setTimeout(saveView, 600);
  }

  /** Frame every card. Also the recovery move when someone loses the board entirely. */
  function fitView() {
    const st = stageEl();
    if (!st) return;
    const r = st.getBoundingClientRect();
    if (!C.nodes.length) {
      C.view = { x: 0, y: 0, k: 0.7 };
      clampView();
      applyView();
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    C.nodes.forEach((n) => {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + NODE_W);
      maxY = Math.max(maxY, n.y + (heights.get(n.id) || 90));
    });
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const k = clamp(Math.min((r.width - PAD * 2) / spanX, (r.height - PAD * 2) / spanY), MIN_K, MAX_K);
    C.view.k = k;
    C.view.x = (r.width - spanX * k) / 2 - minX * k;
    C.view.y = (r.height - spanY * k) / 2 - minY * k;
    clampView();
    applyView();
    queueViewSave();
  }

  /* ---------------- painting ---------------- */

  /** Where an edge should meet a card, so lines stop at the border instead of under it. */
  function anchor(n, tx, ty) {
    const h = heights.get(n.id) || 90;
    const cx = n.x + NODE_W / 2;
    const cy = n.y + h / 2;
    const dx = tx - cx;
    const dy = ty - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    // scale the direction vector until it lands on the card's box
    const sx = dx ? (NODE_W / 2) / Math.abs(dx) : Infinity;
    const sy = dy ? (h / 2) / Math.abs(dy) : Infinity;
    const s = Math.min(sx, sy);
    return { x: cx + dx * s, y: cy + dy * s };
  }

  function paintEdges() {
    const layer = $('#cvEdgeLayer');
    if (!layer) return;
    const byId = new Map(C.nodes.map((n) => [n.id, n]));
    const parts = [];
    C.edges.forEach((e) => {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) return;
      const ah = heights.get(a.id) || 90;
      const bh = heights.get(b.id) || 90;
      const p1 = anchor(a, b.x + NODE_W / 2, b.y + bh / 2);
      const p2 = anchor(b, a.x + NODE_W / 2, a.y + ah / 2);
      // A shallow arc rather than a straight line: two cards connected in both directions
      // would otherwise draw the exact same segment twice and look like one edge.
      const mx = (p1.x + p2.x) / 2;
      const my = (p1.y + p2.y) / 2;
      const nx = -(p2.y - p1.y);
      const ny = (p2.x - p1.x);
      const len = Math.hypot(nx, ny) || 1;
      const bow = Math.min(28, len * 0.12);
      const cx = mx + (nx / len) * bow;
      const cy = my + (ny / len) * bow;
      // The head's direction is the curve's tangent at its end. For a quadratic that is the
      // control point -> endpoint vector; using p1 -> p2 instead would aim every head at the
      // destination's centre and make a bowed edge look like it misses.
      const ang = Math.atan2(p2.y - cy, p2.x - cx);
      const ux = Math.cos(ang);
      const uy = Math.sin(ang);
      // Stop the line just short of the tip. stroke-linecap is round, so ending the curve
      // exactly at p2 leaves a ~1px nub poking out through the point of the arrow.
      const ex = p2.x - ux * 2;
      const ey = p2.y - uy * 2;
      parts.push(
        '<path d="M' + p1.x.toFixed(1) + ' ' + p1.y.toFixed(1) +
        ' Q' + cx.toFixed(1) + ' ' + cy.toFixed(1) +
        ' ' + ex.toFixed(1) + ' ' + ey.toFixed(1) + '" />'
      );
      // A filled head at the destination, so direction is readable. Build it around the TIP:
      // the two base corners sit HEAD_LEN back along the tangent, fanned out by ±HEAD_HALF.
      // The tempting alternative — start at a point HEAD_LEN back along the line and then step
      // by rotated offsets — is wrong twice over: the offsets are measured from the tip, not
      // from the back point, so the apex ends up pointing back up the line and the whole head
      // floats 17px short of the card with the bare line overshooting past it.
      const HEAD_LEN = 11;
      const HEAD_HALF = 0.42;
      const b1x = p2.x - HEAD_LEN * Math.cos(ang - HEAD_HALF);
      const b1y = p2.y - HEAD_LEN * Math.sin(ang - HEAD_HALF);
      const b2x = p2.x - HEAD_LEN * Math.cos(ang + HEAD_HALF);
      const b2y = p2.y - HEAD_LEN * Math.sin(ang + HEAD_HALF);
      parts.push(
        '<path class="head" d="M' + p2.x.toFixed(1) + ' ' + p2.y.toFixed(1) +
        ' L' + b1x.toFixed(1) + ' ' + b1y.toFixed(1) +
        ' L' + b2x.toFixed(1) + ' ' + b2y.toFixed(1) + ' Z" />'
      );
    });
    layer.innerHTML = parts.join('');
  }

  function makeNodeEl(n) {
    const el = document.createElement('div');
    el.className = 'cv-node';
    el.dataset.id = n.id;
    el.style.left = n.x + 'px';
    el.style.top = n.y + 'px';
    el.style.width = NODE_W + 'px';

    const ref = refIcon(n);
    el.innerHTML =
      '<div class="cv-node-top">' +
      (ref ? '<span class="cv-tag">' + icon(ref, 'sm') + '</span>' : '') +
      '</div><p class="cv-node-text"></p>';
    const text = nodeText(n);
    const p = el.querySelector('.cv-node-text');
    p.textContent = text || '空节点';
    if (!text) p.classList.add('blank');
    if (n.todoId) {
      const t = C.ctx.todos.find((x) => x.id === n.todoId);
      if (t && t.done) el.classList.add('done');
    }
    if (n.id === C.sel) el.classList.add('sel');
    if (n.id === C.connectFrom) el.classList.add('from');
    return el;
  }

  function paint() {
    const w = worldEl();
    if (!w) return;
    const svg = $('#cvEdges');
    Array.from(w.querySelectorAll('.cv-node')).forEach((el) => el.remove());
    // The edge layer stays first in the world: appended last it would paint over the cards
    // instead of running behind them.
    if (svg && w.firstChild !== svg) w.insertBefore(svg, w.firstChild);
    C.nodes.forEach((n) => w.appendChild(makeNodeEl(n)));
    // Heights have to be read after the cards are in the document and laid out.
    heights.clear();
    w.querySelectorAll('.cv-node').forEach((el) => heights.set(el.dataset.id, el.offsetHeight));
    paintEdges();
    updateTools();
    applyView();
  }

  /* ---------------- mutations ---------------- */

  /** Somewhere near the middle of what you are currently looking at. */
  function viewCentre() {
    const st = stageEl();
    if (!st) return { x: WORLD / 2, y: WORLD / 2 };
    const r = st.getBoundingClientRect();
    const x = (r.width / 2 - C.view.x) / C.view.k;
    const y = (r.height / 2 - C.view.y) / C.view.k;
    return {
      x: clamp(x - NODE_W / 2, 0, WORLD - NODE_W),
      y: clamp(y - 45, 0, WORLD - 120),
    };
  }

  /**
   * Somewhere free to put a new card.
   *
   * A card always appears at the middle of what you are looking at, which means a run of
   * them would all land on the same spot. So the spot is tested and, if taken, stepped to
   * the right — wrapping to a new row — until one is clear.
   */
  function freeSpot(at) {
    const gapX = NODE_W + 24;
    const gapY = 118;
    const taken = (x, y) => C.nodes.some((n) =>
      Math.abs(n.x - x) < NODE_W * 0.6 && Math.abs(n.y - y) < 60);
    let x = at.x;
    let y = at.y;
    for (let i = 0; i < 400; i++) {
      if (!taken(x, y)) return { x: x, y: y };
      x += gapX;
      if (x > WORLD - NODE_W) { x = at.x; y += gapY; }
      if (y > WORLD - 120) break;
    }
    return at;
  }

  async function addNode(opts) {
    const o = opts || {};
    const at = freeSpot(o.at || viewCentre());
    const node = {
      id: window.DB.uid(),
      boardId: C.board.id,
      x: clamp(at.x, 0, WORLD - NODE_W),
      y: clamp(at.y, 0, WORLD - 120),
      text: o.text || '',
      ideaId: o.ideaId || null,
      todoId: o.todoId || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    C.nodes.push(node);
    await window.DB.put('nodes', node);
    await touchBoard();
    C.sel = node.id;
    paint();
    return node;
  }

  async function updateNode(node, patch) {
    Object.assign(node, patch, { updatedAt: Date.now() });
    await window.DB.put('nodes', node);
    await touchBoard();
    paint();
  }

  async function deleteNode(id) {
    // The edges that touch it go too. Leaving them would draw lines to nowhere, and they
    // would quietly reappear if the id was ever reused.
    const doomed = C.edges.filter((e) => e.from === id || e.to === id);
    if (doomed.length) await window.DB.delMany('edges', doomed.map((e) => e.id));
    C.edges = C.edges.filter((e) => e.from !== id && e.to !== id);
    await window.DB.del('nodes', id);
    C.nodes = C.nodes.filter((n) => n.id !== id);
    if (C.sel === id) C.sel = null;
    if (C.connectFrom === id) C.connectFrom = null;
    await touchBoard();
    paint();
  }

  async function addEdge(from, to) {
    if (from === to) { toast('不能连到自己'); return; }
    if (C.edges.some((e) => e.from === from && e.to === to)) { toast('这两个已经连过了'); return; }
    const edge = { id: window.DB.uid(), boardId: C.board.id, from: from, to: to, createdAt: Date.now() };
    C.edges.push(edge);
    await window.DB.put('edges', edge);
    await touchBoard();
    // A full paint, not just paintEdges: the origin card's dashed border has to come off and
    // the toolbar has to stop looking armed.
    paint();
  }

  /* ---------------- layout ----------------
     The four named uses are four arrangements of the same graph, so the presets share one
     tree extraction and differ only in how they turn depth into position. */

  function buildTree() {
    const out = new Map();
    const indeg = new Map();
    C.nodes.forEach((n) => { out.set(n.id, []); indeg.set(n.id, 0); });
    C.edges.forEach((e) => {
      if (!out.has(e.from) || !out.has(e.to)) return;
      out.get(e.from).push(e.to);
      indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
    });
    if (!C.nodes.length) return null;
    // A root is a card nothing points at. Failing that (a cycle, or a board that is all
    // cross-links) the first card in the store does; every board still gets a layout.
    const root = (C.nodes.find((n) => indeg.get(n.id) === 0) || C.nodes[0]).id;

    const level = new Map([[root, 0]]);
    const order = [[root]];
    const seen = new Set([root]);
    let frontier = [root];
    while (frontier.length) {
      const next = [];
      frontier.forEach((id) => {
        (out.get(id) || []).forEach((cid) => {
          if (seen.has(cid)) return;   // also what stops a cycle from looping forever
          seen.add(cid);
          level.set(cid, level.get(id) + 1);
          next.push(cid);
        });
      });
      if (next.length) order.push(next);
      frontier = next;
    }
    // Cards unreachable from the root — a second component, or a ring with no entry — are
    // parked on their own row rather than dropped.
    const orphans = C.nodes.filter((n) => !seen.has(n.id)).map((n) => n.id);
    if (orphans.length) {
      orphans.forEach((id) => { seen.add(id); level.set(id, order.length); });
      order.push(orphans);
    }
    return { root: root, order: order, level: level, out: out };
  }

  /** Shift a computed layout so it sits centred in the world and never goes negative. */
  function placeIntoWorld(pos) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pos.forEach((p, id) => {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + NODE_W);
      maxY = Math.max(maxY, p.y + (heights.get(id) || 90));
    });
    const dx = clamp((WORLD - (maxX - minX)) / 2 - minX, 0, WORLD);
    const dy = clamp((WORLD - (maxY - minY)) / 2 - minY, 0, WORLD);
    pos.forEach((p) => { p.x += dx; p.y += dy; });
  }

  async function applyLayout(pos) {
    placeIntoWorld(pos);
    for (const n of C.nodes) {
      const p = pos.get(n.id);
      if (!p) continue;
      n.x = clamp(p.x, 0, WORLD - NODE_W);
      n.y = clamp(p.y, 0, WORLD - 120);
      n.updatedAt = Date.now();
    }
    await Promise.all(C.nodes.map((n) => window.DB.put('nodes', n)));
    await touchBoard();
    paint();
    fitView();
  }

  /** Top-down: every level a row, each row centred on the one above it. The task-tree shape. */
  async function layoutTree() {
    const t = buildTree();
    if (!t) return;
    const pos = new Map();
    const HGAP = 26;
    const VGAP = 54;
    let y = 0;
    t.order.forEach((row) => {
      // Each row is centred on the one above it, and the row below clears the tallest card
      // in this one — a row of one-line cards should not reserve room for a paragraph.
      const total = row.length * NODE_W + (row.length - 1) * HGAP;
      let x = -total / 2;
      let rowH = 0;
      row.forEach((id) => {
        pos.set(id, { x: x, y: y });
        x += NODE_W + HGAP;
        rowH = Math.max(rowH, heights.get(id) || 90);
      });
      y += rowH + VGAP;
    });
    await applyLayout(pos);
  }

  /** Left-to-right: depth becomes the x axis. The work-flow shape. */
  async function layoutFlow() {
    const t = buildTree();
    if (!t) return;
    const pos = new Map();
    const HGAP = 66;
    const VGAP = 26;
    const colW = NODE_W + HGAP;
    t.order.forEach((col, depth) => {
      let h = 0;
      col.forEach((id) => { h += (heights.get(id) || 90) + VGAP; });
      let y = -h / 2;
      col.forEach((id) => {
        pos.set(id, { x: depth * colW, y: y });
        y += (heights.get(id) || 90) + VGAP;
      });
    });
    await applyLayout(pos);
  }

  /** Radial: the root at the centre, each branch owning an angular sector. The mindmap shape. */
  async function layoutMindmap() {
    const t = buildTree();
    if (!t) return;
    const pos = new Map([[t.root, { x: 0, y: 0 }]]);
    const RING = 250;
    const kidsOf = (id) =>
      (t.out.get(id) || []).filter((c) => t.level.get(c) === t.level.get(id) + 1);

    (function place(id, a0, a1, depth) {
      const kids = kidsOf(id);
      if (!kids.length) return;
      const step = (a1 - a0) / kids.length;
      kids.forEach((cid, n) => {
        const a = a0 + step * (n + 0.5);
        pos.set(cid, { x: Math.cos(a) * RING * depth, y: Math.sin(a) * RING * depth });
        place(cid, a0 + step * n, a0 + step * (n + 1), depth + 1);
      });
    })(t.root, 0, Math.PI * 2, 1);

    // Cards the tree could not reach — a second component, or a ring with no way in — get a
    // row under the map. Stacking them all at the centre would just hide them behind it.
    const loose = C.nodes.filter((n) => !pos.has(n.id));
    if (loose.length) {
      const below = Math.max(0, ...Array.from(pos.values()).map((p) => p.y)) + 220;
      const total = loose.length * NODE_W + (loose.length - 1) * 26;
      loose.forEach((n, i) => {
        pos.set(n.id, { x: -total / 2 + i * (NODE_W + 26), y: below });
      });
    }
    await applyLayout(pos);
  }

  /** A tidy grid — the neutral fallback, and a good way to see everything you have. */
  async function layoutGrid() {
    const cols = Math.max(1, Math.ceil(Math.sqrt(C.nodes.length)));
    const pos = new Map();
    const HGAP = 26;
    const VGAP = 26;
    const rowH = Math.max(90, ...C.nodes.map((n) => heights.get(n.id) || 90));
    C.nodes.forEach((n, i) => {
      pos.set(n.id, {
        x: (i % cols) * (NODE_W + HGAP),
        y: Math.floor(i / cols) * (rowH + VGAP),
      });
    });
    await applyLayout(pos);
  }

  /* ---------------- sheets ---------------- */

  function openSheet(html) {
    const wrap = document.createElement('div');
    wrap.className = 'sheet';
    wrap.innerHTML = html;
    const close = () => wrap.remove();
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    wrap.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', close));
    document.body.appendChild(wrap);
    return { wrap, close };
  }

  function actionSheet(title, items) {
    const s = openSheet(
      '<div class="sheet-card"><div class="grabber"></div>' +
      '<div class="sheet-head"><h2></h2>' +
      '<button class="icon-btn bare" data-x aria-label="关闭">' + icon('close') + '</button></div>' +
      '<div class="move-list"></div></div>'
    );
    s.wrap.querySelector('h2').textContent = title;
    const list = s.wrap.querySelector('.move-list');
    items.forEach((it) => {
      const b = document.createElement('button');
      b.className = 'move-item';
      b.innerHTML = icon(it.icon) + '<span></span>';
      b.querySelector('span').textContent = it.label;
      b.addEventListener('click', () => { s.close(); if (it.run) it.run(); });
      list.appendChild(b);
    });
    return s;
  }

  function openBoardSheet(board) {
    const isNew = !board;
    const s = openSheet(
      '<div class="sheet-card"><div class="grabber"></div>' +
      '<div class="sheet-head"><h2>' + (isNew ? '新建画布' : '重命名') + '</h2>' +
      '<button class="icon-btn bare" data-x aria-label="关闭">' + icon('close') + '</button></div>' +
      '<input type="text" id="cvBoardName" class="field" placeholder="画布名称，例如「新 App 结构」" autocomplete="off">' +
      '<p class="hint">画布用来把想法摆开：卡片可以自由写，也可以引用已有的灵感或待办。' +
      '连线之后可以用「排版」一键变成思维导图、任务树或流程图。</p>' +
      '<button class="solid-btn wide" id="cvBoardOk">' + (isNew ? '创建' : '保存') + '</button></div>'
    );
    const input = s.wrap.querySelector('#cvBoardName');
    if (board) input.value = board.name;
    setTimeout(() => input.focus(), 150);

    const commit = async () => {
      const name = input.value.trim();
      if (!name) { toast('给画布起个名字'); return; }
      s.close();
      if (board) {
        board.name = name;
        board.updatedAt = Date.now();
        await window.DB.put('boards', board);
        refresh();
      } else {
        const nb = {
          id: window.DB.uid(),
          name: name,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          view: null,
        };
        C.boards.unshift(nb);
        await window.DB.put('boards', nb);
        await openBoard(nb.id);
        refresh();
      }
    };
    s.wrap.querySelector('#cvBoardOk').addEventListener('click', commit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
  }

  /** The editor for one card — written text on one side, a reference on the other. */
  function openNodeSheet(node) {
    const isRef = !!(node.ideaId || node.todoId);
    const s = openSheet(
      '<div class="sheet-card"><div class="grabber"></div>' +
      '<div class="sheet-head"><h2>' + (isRef ? '引用的卡片' : '卡片') + '</h2>' +
      '<button class="icon-btn bare" data-x aria-label="关闭">' + icon('close') + '</button></div>' +
      '<div class="cv-refbox" id="cvRefBox" hidden></div>' +
      '<textarea id="cvNodeText" class="field" rows="4" placeholder="写点什么…"></textarea>' +
      '<button class="ghost-btn wide" id="cvOpenRef" hidden>' + icon('go') + '打开来源</button>' +
      '<button class="ghost-btn wide" id="cvLinkRef">' + icon('link') + '引用一条灵感或待办</button>' +
      '<div class="sheet-actions">' +
      '<button class="danger-btn" id="cvNodeDel">删除</button>' +
      '<button class="solid-btn" id="cvNodeDone">完成</button></div></div>'
    );
    const box = s.wrap.querySelector('#cvRefBox');
    const ta = s.wrap.querySelector('#cvNodeText');
    const openRef = s.wrap.querySelector('#cvOpenRef');
    ta.value = node.text || '';

    const paintRef = () => {
      const kind = node.ideaId ? 'idea' : (node.todoId ? 'todo' : null);
      if (!kind) { box.hidden = true; ta.hidden = false; openRef.hidden = true; return; }
      // A reference card has no text of its own — showing an editable box would imply it did.
      box.hidden = false;
      ta.hidden = true;
      const src = kind === 'idea'
        ? C.ctx.ideas.find((x) => x.id === node.ideaId)
        : C.ctx.todos.find((x) => x.id === node.todoId);
      box.innerHTML =
        '<div class="cv-refbox-head">' + icon(kind === 'idea' ? 'spark' : 'check', 'sm') +
        '<span>' + (kind === 'idea' ? '引用自灵感' : '引用自待办') + '</span></div>' +
        '<p class="cv-refbox-text"></p>';
      box.querySelector('.cv-refbox-text').textContent = nodeText(node);
      box.classList.toggle('gone', !src);
      // Only an idea has a sheet to open; a to-do lives in the list view.
      openRef.hidden = !(kind === 'idea' && src && C.ctx.openIdea);
    };
    paintRef();

    openRef.addEventListener('click', () => {
      const id = node.ideaId;
      s.close();
      if (id && C.ctx.openIdea) C.ctx.openIdea(id);
    });

    s.wrap.querySelector('#cvNodeDel').addEventListener('click', async () => {
      s.close();
      await deleteNode(node.id);
      toast('已删除');
    });

    s.wrap.querySelector('#cvLinkRef').addEventListener('click', () => {
      s.close();
      openRefPicker(node);
    });

    const done = async () => {
      s.close();
      if (!node.ideaId && !node.todoId) await updateNode(node, { text: ta.value.trim() });
      else paint();
    };
    s.wrap.querySelector('#cvNodeDone').addEventListener('click', done);
    if (!isRef) setTimeout(() => ta.focus(), 150);
  }

  /** Pick something from the idea list to mirror onto the canvas. */
  function openRefPicker(node) {
    const s = openSheet(
      '<div class="sheet-card"><div class="grabber"></div>' +
      '<div class="sheet-head"><h2>引用一条内容</h2>' +
      '<button class="icon-btn bare" data-x aria-label="关闭">' + icon('close') + '</button></div>' +
      '<div class="pick-label">灵感</div><div class="people-list" id="cvPickIdeas"></div>' +
      '<div class="pick-label">待办</div><div class="people-list" id="cvPickTodos"></div></div>'
    );

    const row = (parent, label, sub, run) => {
      const b = document.createElement('button');
      b.className = 'person';
      b.innerHTML = '<div class="person-main"><p class="person-name"></p><p class="person-sub"></p></div>';
      b.querySelector('.person-name').textContent = label;
      b.querySelector('.person-sub').textContent = sub;
      b.addEventListener('click', async () => { s.close(); await run(); });
      parent.appendChild(b);
    };

    const ideas = s.wrap.querySelector('#cvPickIdeas');
    const open = C.ctx.ideas.filter((i) => !i.done).sort((a, b) => b.createdAt - a.createdAt);
    if (!open.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = '还没有灵感。';
      ideas.appendChild(p);
    }
    open.slice(0, 40).forEach((i) => {
      const kind = i.kind || 'voice';
      const label = i.title || i.note || '未命名灵感';
      // The text is kept as a snapshot beside the reference. The card reads through to the
      // live record while it is there, and falls back to this if the idea is ever deleted.
      row(ideas, label, kind === 'photo' ? '照片' : (kind === 'text' ? '文字' : '语音'), () =>
        updateNode(node, { ideaId: i.id, todoId: null, text: label }));
    });

    const todos = s.wrap.querySelector('#cvPickTodos');
    const live = C.ctx.todos.filter((t) => !t.done);
    if (!live.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = '还没有未完成的待办。';
      todos.appendChild(p);
    }
    live.slice(0, 40).forEach((t) => {
      const label = t.text || '待办';
      row(todos, label, t.due ? '截止 ' + t.due : '未设时间', () =>
        updateNode(node, { todoId: t.id, ideaId: null, text: label }));
    });
  }

  function openLayoutSheet() {
    actionSheet('排版', [
      { icon: 'brain', label: '思维导图 · 从中心向外散开', run: layoutMindmap },
      { icon: 'folder', label: '任务树 · 自上而下分层', run: layoutTree },
      { icon: 'go', label: '流程图 · 从左到右推进', run: layoutFlow },
      { icon: 'grip', label: '网格 · 排整齐，先看清有什么', run: layoutGrid },
    ]);
  }

  /* ---------------- the board list ---------------- */

  function renderBoards(box) {
    const head = document.createElement('div');
    head.className = 'cv-head';
    head.innerHTML =
      '<p class="cv-lead">画布用来把想法摆开。卡片可以自由写，也可以引用已有的灵感或待办；' +
      '连上线之后，一键就能排成思维导图、任务树或流程图。</p>';
    box.appendChild(head);

    if (!C.boards.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.innerHTML = icon('board', 'lg big') + '还没有画布<br>建一块，把脑子里的结构摊开';
      box.appendChild(e);
    }

    C.boards.forEach((b) => {
      const card = document.createElement('div');
      card.className = 'card cv-board-card';
      card.innerHTML =
        '<div class="card-top"><span class="grip">' + icon('board') + '</span>' +
        '<div class="card-body"><p class="card-title"></p><div class="card-meta">' +
        '<span class="m-when"></span><span class="m-loc"></span></div></div>' +
        '<div class="card-tail"><span class="cv-chev">' + icon('go') + '</span></div></div>';
      card.querySelector('.card-title').textContent = b.name;
      const when = new Date(b.updatedAt || b.createdAt);
      card.querySelector('.m-when').innerHTML =
        icon('clock', 'sm') + '<span>' + fmtWhen(when.getTime()) + '</span>';
      card.querySelector('.m-loc').innerHTML = icon('target', 'sm') + '<span id="cvN-' + b.id + '">…</span>';
      const consumed = attachLongPress(card, () => boardActions(b));
      card.addEventListener('click', async () => {
        if (consumed()) return;   // the click that follows a long press is not a tap
        await openBoard(b.id);
        refresh();
      });
      card.addEventListener('contextmenu', (e) => { e.preventDefault(); boardActions(b); });
      box.appendChild(card);
      // Counts are read after the card is in the DOM so the list itself stays synchronous.
      window.DB.byIndex('nodes', 'boardId', b.id).then((ns) => {
        const el = document.getElementById('cvN-' + b.id);
        if (el) el.textContent = ns.length + ' 张卡片';
      });
    });

    const add = document.createElement('button');
    add.className = 'cv-new';
    add.innerHTML = icon('plus') + '<span>新建画布</span>';
    add.addEventListener('click', () => openBoardSheet(null));
    box.appendChild(add);
  }

  function boardActions(b) {
    actionSheet(b.name, [
      { icon: 'edit', label: '重命名', run: () => openBoardSheet(b) },
      {
        icon: 'trash',
        label: '删除这块画布',
        run: async () => {
          const ns = await window.DB.byIndex('nodes', 'boardId', b.id);
          const es = await window.DB.byIndex('edges', 'boardId', b.id);
          if (es.length) await window.DB.delMany('edges', es.map((e) => e.id));
          if (ns.length) await window.DB.delMany('nodes', ns.map((n) => n.id));
          await window.DB.del('boards', b.id);
          C.boards = C.boards.filter((x) => x.id !== b.id);
          if (C.board && C.board.id === b.id) C.board = null;
          refresh();
          toast('已删除');
        },
      },
    ]);
  }

  /* ---------------- the board editor ---------------- */

  function renderBoard(box) {
    const wrap = document.createElement('div');
    wrap.className = 'cv-wrap';
    wrap.innerHTML =
      '<div class="cv-bar">' +
      '<button class="cv-btn" id="cvBack" aria-label="返回画布列表">' + icon('go', 'flip') + '</button>' +
      '<button class="cv-name" id="cvName"></button>' +
      '<button class="cv-btn" id="cvFit" aria-label="适应屏幕">' + icon('fit') + '</button>' +
      '</div>' +
      '<div class="cv-stage" id="cvStage">' +
      '<div class="cv-world" id="cvWorld">' +
      // The grid is drawn as real rules rather than a repeating gradient: the design system
      // builds texture out of lines, and a line has the advantage of scaling with the board.
      '<svg class="cv-edges" id="cvEdges" width="' + WORLD + '" height="' + WORLD + '">' +
      '<defs><pattern id="cvGrid" width="80" height="80" patternUnits="userSpaceOnUse">' +
      '<path d="M80 0H0V80" fill="none" stroke="currentColor" stroke-width="1"/>' +
      '</pattern></defs>' +
      '<rect class="grid" width="' + WORLD + '" height="' + WORLD + '" fill="url(#cvGrid)"/>' +
      '<g id="cvEdgeLayer"></g>' +
      '</svg>' +
      '</div></div>' +
      '<div class="cv-hint" id="cvHint"></div>' +
      '<div class="cv-tools">' +
      '<button class="cv-tool" id="cvAdd">' + icon('plus') + '<span>加卡片</span></button>' +
      '<button class="cv-tool" id="cvLink">' + icon('link') + '<span>连线</span></button>' +
      '<button class="cv-tool" id="cvLayout">' + icon('brain') + '<span>排版</span></button>' +
      '</div>';
    box.appendChild(wrap);

    wrap.querySelector('#cvName').textContent = C.board.name;
    wrap.querySelector('#cvBack').addEventListener('click', async () => {
      await saveView();
      C.board = null;
      C.sel = null;
      C.connectFrom = null;
      refresh();
    });
    wrap.querySelector('#cvName').addEventListener('click', () => openBoardSheet(C.board));
    wrap.querySelector('#cvFit').addEventListener('click', fitView);
    wrap.querySelector('#cvLayout').addEventListener('click', openLayoutSheet);
    wrap.querySelector('#cvAdd').addEventListener('click', async () => {
      const n = await addNode({});
      openNodeSheet(n);
    });
    wrap.querySelector('#cvLink').addEventListener('click', () => {
      C.connectFrom = null;
      C.connect = !C.connect;
      if (!C.connect) C.connectFrom = null;
      paint();
    });

    bindStage();
    paint();
    if (!C.nodes.length) fitView();
  }

  function updateTools() {
    const link = $('#cvLink');
    if (link) link.classList.toggle('on', !!C.connect);
    const hint = $('#cvHint');
    if (!hint) return;
    if (C.connectFrom) {
      hint.textContent = '再点一张卡片，连线就建好了';
      hint.hidden = false;
    } else if (C.connect) {
      hint.textContent = '连线模式：先点起点，再点终点';
      hint.hidden = false;
    } else if (C.sel) {
      hint.textContent = '再点一下选中的卡片可以编辑';
      hint.hidden = false;
    } else {
      hint.hidden = true;
    }
  }

  /* ---------------- pointer handling ----------------
     One set of pointer events on the stage does panning, dragging, pinching and tapping.
     Nodes never get their own listeners: a card that is dragged is dragged by the stage, so
     there is exactly one place that decides what a gesture meant. */

  function bindStage() {
    const st = stageEl();
    if (!st) return;

    st.addEventListener('pointerdown', (e) => {
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { st.setPointerCapture(e.pointerId); } catch (err) { /* older WebView */ }

      if (ptrs.size === 2) {
        const [a, b] = Array.from(ptrs.values());
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: C.view.k };
        mode = 'pinch';
        grab = null;
        return;
      }
      if (ptrs.size > 2) return;

      const el = e.target.closest('.cv-node');
      const node = el ? C.nodes.find((x) => x.id === el.dataset.id) : null;

      // In connect mode a card is a target, not something to drag. Every other time, a press
      // on a card moves it.
      if (node && !C.connect) {
        mode = 'node';
        grab = { node, el, sx: e.clientX, sy: e.clientY, ox: node.x, oy: node.y, moved: false };
        el.classList.add('dragging');
      } else {
        mode = 'pan';
        grab = {
          node, el,                       // remembered so a tap can still be resolved
          sx: e.clientX, sy: e.clientY,
          ox: C.view.x, oy: C.view.y,
          moved: false,
        };
      }
    });

    st.addEventListener('pointermove', (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (mode === 'pinch' && ptrs.size >= 2) {
        const [a, b] = Array.from(ptrs.values());
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const r = st.getBoundingClientRect();
        zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, pinch.k * (d / (pinch.d || d)));
        return;
      }

      if (!grab) return;
      const dx = e.clientX - grab.sx;
      const dy = e.clientY - grab.sy;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) grab.moved = true;

      if (mode === 'node') {
        // Screen pixels become world units through the current zoom.
        const n = grab.node;
        n.x = clamp(grab.ox + dx / C.view.k, 0, WORLD - NODE_W);
        n.y = clamp(grab.oy + dy / C.view.k, 0, WORLD - 120);
        grab.el.style.left = n.x + 'px';
        grab.el.style.top = n.y + 'px';
        paintEdges();
      } else if (mode === 'pan') {
        C.view.x = grab.ox + dx;
        C.view.y = grab.oy + dy;
        clampView();
        applyView();
      }
    });

    const release = async (e) => {
      if (!ptrs.delete(e.pointerId)) return;

      if (mode === 'pinch') {
        if (ptrs.size < 2) { mode = null; pinch = null; }
        return;
      }
      if (!grab) { mode = null; return; }

      const g = grab;
      const was = mode;
      grab = null;
      mode = null;
      if (g.el) g.el.classList.remove('dragging');

      if (g.moved) {
        if (was === 'node') {
          // Committed once, on release: writing on every frame would put dozens of
          // transactions behind a single flick.
          await window.DB.put('nodes', g.node);
          await touchBoard();
        } else {
          queueViewSave();
        }
        return;
      }

      // A press that did not move is a tap.
      if (g.node) onNodeTap(g.node);
      else {
        // Tapping the empty board clears the selection and leaves connect mode.
        C.connect = false;
        C.connectFrom = null;
        C.sel = null;
        paint();
      }
    };

    st.addEventListener('pointerup', release);
    st.addEventListener('pointercancel', (e) => {
      ptrs.delete(e.pointerId);
      if (grab && grab.el) grab.el.classList.remove('dragging');
      grab = null;
      mode = null;
    });

    st.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = st.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, C.view.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
      queueViewSave();
    }, { passive: false });
  }

  /* One tap selects, a second tap on the same card opens it. That is a rhythm a thumb can
     keep, and it needs no double-tap timing window to land inside. */
  function onNodeTap(node) {
    if (C.connect) {
      if (!C.connectFrom) {
        C.connectFrom = node.id;
        C.sel = null;
        paint();
        return;
      }
      const from = C.connectFrom;
      C.connectFrom = null;
      C.connect = false;
      C.sel = null;
      addEdge(from, node.id);
      return;
    }
    if (C.sel === node.id) { openNodeSheet(node); return; }
    C.sel = node.id;
    paint();
  }

  /* ---------------- entry points ---------------- */

  function render(box, ctx) {
    if (ctx) C.ctx = ctx;
    C.host = box;
    if (!box) return;
    box.innerHTML = '';
    if (C.board) renderBoard(box);
    else renderBoards(box);
  }

  /**
   * Ask for a full redraw.
   *
   * Opening or leaving a board changes more than the canvas: the app header follows the
   * board's name, and the project rail steps aside to give the board the screen. None of
   * that is the canvas's to change, so it goes back through the app's own render.
   */
  function refresh() {
    if (C.ctx.refresh) C.ctx.refresh();
    else render(C.host, C.ctx);
  }

  /** What the app header should say, and whether the canvas wants the whole screen. */
  function heading() {
    if (C.board) {
      return {
        title: C.board.name,
        sub: C.nodes.length + ' 张卡片 · ' + C.edges.length + ' 条连线',
        focus: true,
      };
    }
    return { title: '画布', sub: C.boards.length + ' 块画布', focus: false };
  }

  function fmtWhen(ts) {
    const d = new Date(ts), now = new Date();
    const y = new Date(now.getTime() - 86400000);
    const pad = (n) => String(n).padStart(2, '0');
    let day;
    if (d.toDateString() === now.toDateString()) day = '今天';
    else if (d.toDateString() === y.toDateString()) day = '昨天';
    else day = (d.getMonth() + 1) + '月' + d.getDate() + '日';
    return day + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /**
   * Long press without a drag — the touch equivalent of a right click.
   *
   * Returns a function that answers "did a long press just fire?". A long press is still
   * followed by a click, so the caller has to be able to swallow the one that comes with it,
   * or the action sheet opens and the board opens underneath it.
   */
  function attachLongPress(el, run) {
    let timer = 0;
    let sx = 0, sy = 0;
    let fired = false;
    const stop = () => { clearTimeout(timer); timer = 0; };
    el.addEventListener('pointerdown', (e) => {
      sx = e.clientX; sy = e.clientY; fired = false; stop();
      timer = setTimeout(() => { timer = 0; fired = true; run(); }, 550);
    });
    el.addEventListener('pointermove', (e) => {
      if (!timer) return;
      if (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8) stop();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => el.addEventListener(ev, stop));
    return () => { const f = fired; fired = false; return f; };
  }

  return {
    load,
    render,
    heading,
    openBoard,
    count: () => C.boards.length,
    /** True while a board is open, so the shell can get out of the way. */
    focused: () => !!C.board,
    /** Leave the editor without losing the board list. */
    leave() { C.board = null; C.sel = null; C.connectFrom = null; },
    boards: () => C.boards,
  };
})();
