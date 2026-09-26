/* Spark — voice recorder (MediaRecorder + live input level). */
window.Rec = (function () {
  const MIMES = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
    'audio/mpeg',
  ];

  let recorder = null;
  let stream = null;
  let chunks = [];
  let ctx = null;
  let analyser = null;
  let buf = null;
  let raf = 0;
  let t0 = 0;
  let mime = '';

  function pickMime() {
    if (typeof MediaRecorder === 'undefined') return '';
    for (const m of MIMES) {
      try { if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m; } catch (e) { /* ignore */ }
    }
    return '';
  }

  function teardownAudio() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (ctx) { try { ctx.close(); } catch (e) { /* ignore */ } }
    ctx = analyser = buf = null;
  }

  function stopStream() {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  }

  async function start(onLevel) {
    if (recorder) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('此环境不支持录音');
    }
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });

    mime = pickMime();
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch (e) {
      recorder = new MediaRecorder(stream);
      mime = '';
    }

    chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.start(250);
    t0 = Date.now();

    // live level meter
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i];
        if (onLevel) onLevel(Math.min(1, sum / buf.length / 90));
        raf = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) { /* meter is optional */ }
  }

  function stop() {
    return new Promise((resolve, reject) => {
      if (!recorder) { reject(new Error('没有正在进行的录音')); return; }
      const durationMs = Date.now() - t0;
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' });
        teardownAudio();
        stopStream();
        recorder = null;
        chunks = [];
        resolve({ blob, mime: blob.type, durationMs });
      };
      recorder.onerror = (e) => { teardownAudio(); stopStream(); recorder = null; reject(e.error || new Error('录音失败')); };
      try { recorder.stop(); } catch (e) { reject(e); }
    });
  }

  function cancel() {
    return new Promise((resolve) => {
      if (!recorder) { resolve(); return; }
      recorder.onstop = () => { teardownAudio(); stopStream(); recorder = null; chunks = []; resolve(); };
      try { recorder.stop(); } catch (e) { teardownAudio(); stopStream(); recorder = null; resolve(); }
    });
  }

  return {
    start,
    stop,
    cancel,
    isRecording: () => !!recorder,
    isSupported: () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && typeof MediaRecorder !== 'undefined'),
  };
})();
