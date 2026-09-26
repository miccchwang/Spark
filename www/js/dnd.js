/* Spark — pointer based drag and drop.
   HTML5 drag events never fire on touch screens, so drags start from a long press
   (touch) or a move threshold (mouse) and hit-test drop zones manually. */
window.DnD = (function () {
  const LONG_PRESS_MS = 340;
  const MOVE_THRESHOLD = 8;
  const EDGE = 70;

  function attach(el, opts) {
    const getData = opts.getData || function () { return null; };
    const onDrop = opts.onDrop || function () {};
    const onStart = opts.onStart || function () {};
    const onEnd = opts.onEnd || function () {};

    let startX = 0, startY = 0, timer = 0, dragging = false, decided = false;
    let ghost = null, dx = 0, dy = 0, target = null, scrollRaf = 0, lastY = 0;

    const blockScroll = (e) => { if (dragging && e.cancelable) e.preventDefault(); };

    function clearHighlight() {
      document.querySelectorAll('.drop-hover').forEach((n) => n.classList.remove('drop-hover'));
    }

    function setTarget(node) {
      if (node === target) return;
      clearHighlight();
      target = node;
      if (target) {
        target.classList.add('drop-hover');
        if (navigator.vibrate) navigator.vibrate(8);
      }
    }

    function begin(x, y) {
      dragging = true;
      el.classList.add('dragging');
      onStart();

      const rect = el.getBoundingClientRect();
      ghost = el.cloneNode(true);
      ghost.classList.add('ghost');
      ghost.classList.remove('dragging');
      ghost.style.left = rect.left + 'px';
      ghost.style.top = rect.top + 'px';
      ghost.style.width = rect.width + 'px';
      document.body.appendChild(ghost);
      document.body.classList.add('dnd-active');

      dx = x - rect.left;
      dy = y - rect.top;
      moveGhost(x, y);

      window.addEventListener('pointermove', onPointerMove, { passive: false });
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
      window.addEventListener('touchmove', blockScroll, { passive: false });
      if (navigator.vibrate) navigator.vibrate(15);
    }

    function moveGhost(x, y) {
      if (!ghost) return;
      ghost.style.transform = 'translate(' + (x - dx) + 'px,' + (y - dy) + 'px)';
    }

    function edgeScroll(y) {
      const h = window.innerHeight;
      let v = 0;
      if (y < EDGE) v = -Math.ceil((EDGE - y) / 6);
      else if (y > h - EDGE) v = Math.ceil((y - (h - EDGE)) / 6);
      if (v) window.scrollBy(0, v);
      if (dragging) scrollRaf = requestAnimationFrame(() => edgeScroll(lastY));
    }

    function onPointerMove(e) {
      if (!dragging) {
        if (Math.abs(e.clientX - startX) > MOVE_THRESHOLD || Math.abs(e.clientY - startY) > MOVE_THRESHOLD) {
          clearTimeout(timer);
          decided = true;
          if (e.pointerType !== 'touch') begin(e.clientX, e.clientY);
        }
        return;
      }
      if (e.cancelable) e.preventDefault();
      lastY = e.clientY;
      moveGhost(e.clientX, e.clientY);

      ghost.style.visibility = 'hidden';
      const under = document.elementFromPoint(e.clientX, e.clientY);
      ghost.style.visibility = 'visible';
      setTarget(under ? under.closest('[data-drop]') : null);
    }

    function onPointerUp(e) {
      clearTimeout(timer);
      if (!dragging) return;
      const dropNode = target;
      const data = getData();
      cleanup();
      if (dropNode) onDrop(dropNode.getAttribute('data-drop'), data);
      else onEnd();
    }

    function cleanup() {
      dragging = false;
      decided = false;
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('touchmove', blockScroll);
      clearHighlight();
      document.body.classList.remove('dnd-active');
      el.classList.remove('dragging');
      if (ghost) { ghost.remove(); ghost = null; }
      target = null;
    }

    el.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      if (dragging) return;
      startX = e.clientX; startY = e.clientY; decided = false;
      lastY = e.clientY;
      if (e.pointerType === 'touch') {
        timer = setTimeout(() => { if (!decided) begin(startX, startY); }, LONG_PRESS_MS);
      }
      window.addEventListener('pointermove', onPointerMove, { passive: false });
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
    });

    return { cancel: cleanup };
  }

  return { attach };
})();
