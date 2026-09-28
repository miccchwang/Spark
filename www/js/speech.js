/* Spark — offline speech to text.

   The recording comes out of MediaRecorder as WebM/Opus at whatever rate the device
   captured. Vosk wants 16 kHz mono PCM, so this module decodes the blob with the Web Audio
   API, resamples it offline, then feeds the result to the native SparkSpeech plugin in
   chunks. The audio never leaves the phone and nothing here touches the network.

   In a plain browser there is no native plugin, so available() reports why and the UI hides
   the feature instead of failing. */
window.Speech = (function () {
  const SR = 16000;
  /** Seconds of audio per bridge call — bigger is faster, but a chunk is held in memory twice. */
  const CHUNK_SECONDS = 12;
  /** Chinese models emit characters with no spaces; Latin models need them. */
  const SEP = { cn: '', en: ' ' };

  const plugin = () =>
    (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SparkSpeech) || null;

  let progressFn = null;
  let progressBound = false;

  function bindProgress() {
    if (progressBound) return;
    const p = plugin();
    if (!p || !p.addListener) return;
    progressBound = true;
    p.addListener('progress', (d) => { if (progressFn) progressFn(d); });
  }

  const isNative = () => !!plugin();

  async function available() {
    const p = plugin();
    if (!p) return { ok: false, reason: '离线转写只在装到手机上的 Spark 里可用' };
    bindProgress();
    try {
      const r = await p.available();
      const langs = (r && r.bundled) || [];
      if (!langs.length) return { ok: false, reason: '这个安装包里没有语音模型' };
      return { ok: true, langs };
    } catch (e) {
      return { ok: false, reason: (e && e.message) || '离线识别引擎不可用' };
    }
  }

  /* ---------------- audio conversion ---------------- */

  async function decodeToPcm16(blob) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('这个环境不支持解码音频');
    const raw = await blob.arrayBuffer();

    const tmp = new AC();
    let decoded;
    try {
      decoded = await tmp.decodeAudioData(raw);
    } finally {
      try { tmp.close(); } catch (e) { /* ignore */ }
    }

    const frames = Math.max(1, Math.ceil(decoded.duration * SR));
    const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    let mono;
    if (Off) {
      // Let Chromium resample — its filter is better than anything worth writing here.
      const off = new Off(1, frames, SR);
      const src = off.createBufferSource();
      src.buffer = decoded;
      src.connect(off.destination);
      src.start();
      mono = (await off.startRendering()).getChannelData(0);
    } else {
      mono = resampleManually(decoded, frames);
    }

    const out = new Int16Array(mono.length);
    for (let i = 0; i < mono.length; i++) {
      const s = Math.max(-1, Math.min(1, mono[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  /* OfflineAudioContext is missing on a few old WebViews. Speech is band-limited to about
     4 kHz, so straight linear interpolation is good enough for the fallback path. */
  function resampleManually(decoded, frames) {
    const src = decoded.getChannelData(0);
    const ratio = decoded.sampleRate / SR;
    const out = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, src.length - 1);
      const t = pos - i0;
      out[i] = src[i0] * (1 - t) + src[i1] * t;
    }
    return out;
  }

  function toBase64(int16) {
    const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
    let s = '';
    const STEP = 0x8000;
    for (let i = 0; i < bytes.length; i += STEP) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
    }
    return btoa(s);
  }

  /* ---------------- public ---------------- */

  /**
   * Transcribe a recorded blob.
   * onUpdate({ text, partial, done, total }) fires as chunks land so the UI can stream.
   * Resolves with the finished transcript.
   */
  async function transcribe(blob, opts) {
    const o = opts || {};
    const p = plugin();
    if (!p) throw new Error('离线转写只在手机 App 里可用');

    const lang = o.lang || 'cn';
    const sep = SEP[lang] || '';
    const onUpdate = o.onUpdate;

    bindProgress();

    const pcm = await decodeToPcm16(blob);
    if (!pcm.length) throw new Error('这段录音里没有声音');

    await p.start({ lang });

    const perChunk = SR * CHUNK_SECONDS;
    let settled = '';
    let partial = '';

    for (let off = 0; off < pcm.length; off += perChunk) {
      const slice = pcm.subarray(off, Math.min(off + perChunk, pcm.length));
      const r = await p.feed({ pcm: toBase64(slice) });
      if (r && r.text) settled = settled ? settled + sep + r.text : r.text;
      partial = (r && r.partial) || '';
      if (onUpdate) {
        onUpdate({
          text: settled,
          partial,
          done: Math.min(off + perChunk, pcm.length),
          total: pcm.length,
        });
      }
    }

    const fin = await p.finish();
    const text = ((fin && fin.text) || settled).trim();
    if (onUpdate) onUpdate({ text, partial: '', done: pcm.length, total: pcm.length });
    return text;
  }

  /** Abandon a run in progress; safe to call when nothing is running. */
  async function cancel() {
    const p = plugin();
    if (!p) return;
    try { await p.cancel(); } catch (e) { /* ignore */ }
  }

  /** fn({ megabytes }) reports first-run model unpacking. */
  function onProgress(fn) {
    progressFn = fn;
    bindProgress();
  }

  return { isNative, available, transcribe, cancel, onProgress };
})();
