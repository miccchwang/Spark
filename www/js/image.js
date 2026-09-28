/* Spark — photo capture.
   Two jobs, both of them about not blowing up the database:

   1. Open the right picker. On Android the WebView routes a file input that carries
      `capture` to the system camera app and a plain one to the gallery, so the platform
      picker is all we need — no camera plugin, no extra permission.

   2. Shrink before storing. A modern phone photo is 3–12 MB; a hundred of them would
      fill the quota and make every backup enormous. We redraw through a canvas to a
      bounded long edge, which also bakes in the EXIF rotation so nothing arrives
      sideways.

   Nothing here touches the network. */
window.Photo = (function () {
  /* 1600 px on the long edge is still comfortably sharper than any phone screen, and
     brings a 12 MP photo down to roughly 200–400 KB. */
  const MAX_EDGE = 1600;
  const QUALITY = 0.82;
  /* Screenshots and small pictures are kept byte-for-byte: re-encoding crisp UI text
     through JPEG turns it to mush and saves nothing. */
  const KEEP_UNDER = 700 * 1024;
  /* The inline thumbnail that rides on the idea row so the list can draw a preview
     without opening the image store at all. */
  const THUMB_EDGE = 200;
  const THUMB_QUALITY = 0.7;

  /* ---------------- decoding ---------------- */

  /* createImageBitmap honours EXIF orientation, so a photo taken in portrait comes back
     the right way up. Older engines that cannot decode the format at all (HEIC in some
     builds) throw here, and the caller falls back to keeping the original bytes. */
  async function decode(file) {
    if (window.createImageBitmap) {
      try {
        return await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch (e) {
        // retry without the option before giving up — some builds reject the dictionary
        return await createImageBitmap(file);
      }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('decode failed'));
        el.src = url;
      });
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function fit(w, h, edge) {
    const scale = Math.min(1, edge / Math.max(w, h));
    return {
      w: Math.max(1, Math.round(w * scale)),
      h: Math.max(1, Math.round(h * scale)),
      scaled: scale < 1,
    };
  }

  function draw(src, w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0, w, h);
    return c;
  }

  function encode(canvas, mime, quality) {
    return new Promise((resolve) => {
      if (canvas.toBlob) {
        canvas.toBlob((b) => resolve(b), mime, quality);
        return;
      }
      // ancient fallback; toDataURL is synchronous and blocking
      const url = canvas.toDataURL(mime, quality);
      const bin = atob(url.split(',')[1]);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      resolve(new Blob([u8], { type: mime }));
    });
  }

  /* ---------------- shrink ---------------- */

  async function shrink(file) {
    const srcMime = file.type || 'image/jpeg';
    let bmp;
    try {
      bmp = await decode(file);
    } catch (e) {
      // Undecodable format. Keep the bytes rather than dropping the user's photo; it
      // still backs up and restores, it just has no inline thumbnail.
      return { blob: file, mime: srcMime, w: 0, h: 0, thumb: '' };
    }

    // `fit` returns the original dimensions untouched when no scaling is needed, so
    // these are correct for both the kept-original and the re-encoded branch.
    const full = fit(bmp.width, bmp.height, MAX_EDGE);
    const keep = !full.scaled && file.size <= KEEP_UNDER;

    const out = keep
      ? { blob: file, mime: srcMime }
      : {
        // PNG sources are usually screenshots or diagrams, so give them more quality
        // than a camera photo needs.
        blob: await encode(draw(bmp, full.w, full.h), 'image/jpeg', /png/i.test(srcMime) ? 0.92 : QUALITY),
        mime: 'image/jpeg',
      };

    const thumb = await makeThumb(bmp);
    // Everything that reads the bitmap has to happen before this line.
    if (bmp.close) bmp.close();

    return { blob: out.blob, mime: out.mime, w: full.w, h: full.h, thumb: thumb.thumb };
  }

  async function makeThumb(bmp) {
    try {
      const t = fit(bmp.width, bmp.height, THUMB_EDGE);
      const blob = await encode(draw(bmp, t.w, t.h), 'image/jpeg', THUMB_QUALITY);
      if (!blob) return { thumb: '' };
      return { thumb: await toDataUrl(blob) };
    } catch (e) {
      return { thumb: '' };
    }
  }

  function toDataUrl(blob) {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => resolve('');
      r.readAsDataURL(blob);
    });
  }

  /* ---------------- picking ---------------- */

  /* Resolves to [] when the user backs out. A cancelled picker fires no `change` event
     at all on some platforms, so we also watch for the blur/refocus round trip that a
     dismissed system dialog leaves behind. */
  function pick(opts) {
    const o = opts || {};
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      if (o.camera) input.setAttribute('capture', 'environment');
      if (o.multiple) input.multiple = true;
      // Keep it in the document so the WebView treats the click as a real gesture, but
      // out of the way of the layout.
      input.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;';
      document.body.appendChild(input);

      let done = false;
      let blurred = false;
      let graceTimer = 0;

      function cleanup() {
        window.removeEventListener('focus', onFocus);
        window.removeEventListener('blur', onBlur);
        clearTimeout(graceTimer);
        input.remove();
      }

      async function finish(files) {
        if (done) return;
        done = true;
        cleanup();
        const list = files ? Array.prototype.slice.call(files) : [];
        if (!list.length) { resolve([]); return; }
        const out = [];
        for (const f of list) {
          try {
            out.push(await shrink(f));
          } catch (e) {
            // one unreadable file must not sink the rest of the batch
          }
        }
        resolve(out);
      }

      function onBlur() { blurred = true; }
      function onFocus() {
        if (!blurred) return;
        blurred = false;
        // Give a slow `change` a chance to land first.
        graceTimer = setTimeout(() => finish(null), 1500);
      }

      input.addEventListener('change', () => finish(input.files));
      input.addEventListener('cancel', () => finish(null));
      window.addEventListener('blur', onBlur);
      window.addEventListener('focus', onFocus);

      input.click();
    });
  }

  const camera = () => pick({ camera: true });
  const gallery = () => pick({ camera: false, multiple: true });

  /* ---------------- object URLs for the full-size viewer ----------------
     The list never needs these (it draws from the inline thumbnail), so the only
     consumer is the detail sheet, which releases the batch when it closes. */
  let live = [];
  function url(rec) {
    const u = URL.createObjectURL(rec.blob);
    live.push(u);
    return u;
  }
  function release() {
    live.forEach((u) => URL.revokeObjectURL(u));
    live = [];
  }

  return { pick, camera, gallery, shrink, url, release, MAX_EDGE, THUMB_EDGE };
})();
