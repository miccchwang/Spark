package com.spark.ideas;

import android.content.res.AssetManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;
import org.vosk.LibVosk;
import org.vosk.LogLevel;
import org.vosk.Model;
import org.vosk.Recognizer;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Spark — offline speech to text.
 *
 * The language models ship inside the APK as assets, get copied into the app's private
 * storage on first use, and are then fed to Vosk's Kaldi recogniser. Nothing here touches
 * the network, so transcription keeps working in airplane mode.
 *
 * The web layer decodes the recording to 16 kHz mono PCM and hands it over in base64
 * chunks, which keeps the bridge messages small and lets the UI show progress.
 */
@CapacitorPlugin(name = "SparkSpeech")
public class SpeechPlugin extends Plugin {

    /** Language code -> folder name inside assets/. */
    private static final Map<String, String> MODELS = new HashMap<>();

    static {
        MODELS.put("cn", "vosk-model-cn");
        MODELS.put("en", "vosk-model-en");
    }

    /** Bump when the bundled models change so stale copies get replaced on upgrade. */
    private static final String UNPACK_VERSION = "1";
    private static final String STAMP = ".unpacked";
    private static final float SAMPLE_RATE = 16000.0f;
    /** Emit an unpack progress event roughly this often, in bytes. */
    private static final long PROGRESS_STEP = 4L * 1024 * 1024;

    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    /** Model stays loaded for the session; it costs a few hundred MB to build. */
    private Model model;
    private String modelLang;

    private Recognizer recognizer;
    private String recognizerLang;
    /** Text already finalised by acceptWaveForm, joined with the language's separator. */
    private final StringBuilder settled = new StringBuilder();

    // ---------------------------------------------------------------- public API

    /** Which languages are compiled into this build, and what is currently in memory. */
    @PluginMethod
    public void available(PluginCall call) {
        JSObject out = new JSObject();
        List<String> bundled = new ArrayList<>();
        for (Map.Entry<String, String> e : MODELS.entrySet()) {
            if (assetExists(e.getValue())) bundled.add(e.getKey());
        }
        out.put("bundled", toArray(bundled));
        out.put("loaded", modelLang == null ? JSONObject.NULL : modelLang);
        out.put("sampleRate", (int) SAMPLE_RATE);
        call.resolve(out);
    }

    /** Unpack the model if needed and build it. Safe to call repeatedly. */
    @PluginMethod
    public void load(final PluginCall call) {
        final String lang = normLang(call.getString("lang", "cn"));
        worker.execute(() -> {
            try {
                ensureModel(lang, true);
                JSObject out = new JSObject();
                out.put("ok", true);
                out.put("lang", lang);
                resolve(call, out);
            } catch (Throwable t) {
                reject(call, t);
            }
        });
    }

    /** Begin a transcription run. Any previous run is discarded. */
    @PluginMethod
    public void start(final PluginCall call) {
        final String lang = normLang(call.getString("lang", "cn"));
        worker.execute(() -> {
            try {
                ensureModel(lang, true);
                synchronized (SpeechPlugin.this) {
                    closeRecognizer();
                    recognizer = new Recognizer(model, SAMPLE_RATE);
                    recognizerLang = lang;
                    settled.setLength(0);
                }
                JSObject out = new JSObject();
                out.put("ok", true);
                out.put("lang", lang);
                resolve(call, out);
            } catch (Throwable t) {
                reject(call, t);
            }
        });
    }

    /**
     * Feed one base64 chunk of little-endian 16-bit mono PCM.
     * Returns the newly finalised segment plus whatever is still being decoded.
     */
    @PluginMethod
    public void feed(final PluginCall call) {
        final String b64 = call.getString("pcm", "");
        worker.execute(() -> {
            try {
                byte[] pcm = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
                String settledNow = "";
                String partial = "";
                synchronized (SpeechPlugin.this) {
                    if (recognizer == null) throw new IllegalStateException("转写还没开始");
                    // acceptWaveForm consumes the whole buffer and only evaluates endpointing
                    // once, at the end — it never abandons the tail — so handing it a long
                    // chunk loses no audio. Reading getResult() then moves the recogniser to
                    // its endpoint state, and the next call starts a fresh utterance.
                    boolean closed = recognizer.acceptWaveForm(pcm, pcm.length);
                    if (closed) {
                        settledNow = textOf(recognizer.getResult());
                        if (settledNow.length() > 0) {
                            if (settled.length() > 0) settled.append(separator(recognizerLang));
                            settled.append(settledNow);
                        }
                    } else {
                        partial = textOf(recognizer.getPartialResult());
                    }
                }
                JSObject out = new JSObject();
                out.put("text", settledNow);
                out.put("partial", partial);
                out.put("settled", settled.toString());
                resolve(call, out);
            } catch (Throwable t) {
                reject(call, t);
            }
        });
    }

    /** Flush the tail of the audio and return the complete transcript. */
    @PluginMethod
    public void finish(final PluginCall call) {
        worker.execute(() -> {
            try {
                String text;
                synchronized (SpeechPlugin.this) {
                    if (recognizer == null) throw new IllegalStateException("转写还没开始");
                    String tail = textOf(recognizer.getFinalResult());
                    if (tail.length() > 0) {
                        if (settled.length() > 0) settled.append(separator(recognizerLang));
                        settled.append(tail);
                    }
                    text = settled.toString().trim();
                    closeRecognizer();
                }
                JSObject out = new JSObject();
                out.put("text", text);
                resolve(call, out);
            } catch (Throwable t) {
                reject(call, t);
            }
        });
    }

    /** Abandon the current run without keeping the text. */
    @PluginMethod
    public void cancel(final PluginCall call) {
        worker.execute(() -> {
            synchronized (SpeechPlugin.this) {
                closeRecognizer();
                settled.setLength(0);
            }
            call.resolve();
        });
    }

    /** Release the model. Called when the app goes to the background to give the RAM back. */
    @PluginMethod
    public void unload(final PluginCall call) {
        worker.execute(() -> {
            synchronized (SpeechPlugin.this) {
                closeRecognizer();
                closeModel();
            }
            call.resolve();
        });
    }

    // ---------------------------------------------------------------- model handling

    private synchronized void ensureModel(String lang, boolean reportProgress) throws IOException {
        if (model != null && lang.equals(modelLang)) return;
        closeModel();

        String assetDir = MODELS.get(lang);
        if (assetDir == null) throw new IOException("不支持的语言：" + lang);
        if (!assetExists(assetDir)) throw new IOException("这个安装包里没有离线语音模型");

        File dir = unpack(assetDir, reportProgress);

        LibVosk.setLogLevel(LogLevel.WARNINGS);
        model = new Model(dir.getAbsolutePath());
        modelLang = lang;
    }

    /**
     * Copy assets/<assetDir> into the app's private storage the first time, then reuse it.
     * The stamp file records which bundle version produced the copy so upgrades re-unpack.
     */
    private File unpack(String assetDir, boolean reportProgress) throws IOException {
        File dir = new File(getContext().getFilesDir(), assetDir);
        File stamp = new File(dir, STAMP);

        if (stamp.isFile() && UNPACK_VERSION.equals(readLine(stamp))) return dir;

        deleteTree(dir);
        if (!dir.mkdirs() && !dir.isDirectory()) throw new IOException("无法创建模型目录");

        AssetManager am = getContext().getAssets();
        copyTree(am, assetDir, dir, new long[] { 0 }, new long[] { 0 }, reportProgress);

        writeLine(stamp, UNPACK_VERSION);
        return dir;
    }

    private void copyTree(AssetManager am, String assetPath, File dest, long[] done, long[] lastEmit, boolean report)
        throws IOException {
        String[] kids = am.list(assetPath);
        if (kids == null) return;

        if (kids.length == 0) {
            // A directory with no entries is reported the same way as a file, and the model
            // has no empty directories, so treat it as a file.
            copyFile(am, assetPath, dest);
            done[0] += dest.length();
            if (report && done[0] - lastEmit[0] >= PROGRESS_STEP) {
                lastEmit[0] = done[0];
                emitProgress((int) (done[0] / (1024 * 1024)));
            }
            return;
        }

        if (!dest.isDirectory() && !dest.mkdirs()) throw new IOException("无法创建目录：" + dest);
        for (String kid : kids) {
            copyTree(am, assetPath + "/" + kid, new File(dest, kid), done, lastEmit, report);
        }
    }

    private static void copyFile(AssetManager am, String assetPath, File dest) throws IOException {
        try (InputStream in = am.open(assetPath); OutputStream out = new FileOutputStream(dest)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    private boolean assetExists(String assetDir) {
        try {
            return getContext().getAssets().list(assetDir) != null;
        } catch (IOException e) {
            return false;
        }
    }

    private static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private static String readLine(File f) {
        try (java.io.BufferedReader r = new java.io.BufferedReader(new java.io.InputStreamReader(new java.io.FileInputStream(f)))) {
            String line = r.readLine();
            return line == null ? "" : line.trim();
        } catch (IOException e) {
            return "";
        }
    }

    private static void writeLine(File f, String value) throws IOException {
        try (OutputStream out = new FileOutputStream(f)) {
            out.write((value + "\n").getBytes("UTF-8"));
        }
    }

    // ---------------------------------------------------------------- helpers

    private static String normLang(String lang) {
        if (lang == null) return "cn";
        String l = lang.trim().toLowerCase();
        if (l.startsWith("zh") || l.startsWith("cn")) return "cn";
        if (l.startsWith("en")) return "en";
        return MODELS.containsKey(l) ? l : "cn";
    }

    /** Chinese models emit characters with no spaces; Latin models need them. */
    private static String separator(String lang) {
        return "cn".equals(lang) ? "" : " ";
    }

    /** Vosk hands back JSON like {"text":"..."} or {"partial":"..."}. */
    private static String textOf(String json) {
        if (json == null || json.isEmpty()) return "";
        try {
            JSONObject o = new JSONObject(json);
            String t = o.optString("text", "");
            if (t.isEmpty()) t = o.optString("partial", "");
            return t == null ? "" : t.trim();
        } catch (Exception e) {
            return "";
        }
    }

    private static org.json.JSONArray toArray(List<String> items) {
        org.json.JSONArray arr = new org.json.JSONArray();
        for (String s : items) arr.put(s);
        return arr;
    }

    private synchronized void closeRecognizer() {
        if (recognizer != null) {
            try {
                recognizer.close();
            } catch (Exception ignored) {
                // the native handle is gone either way
            }
            recognizer = null;
        }
        recognizerLang = null;
    }

    private synchronized void closeModel() {
        if (model != null) {
            try {
                model.close();
            } catch (Exception ignored) {
                // nothing useful to do here
            }
            model = null;
        }
        modelLang = null;
    }

    /** First-run model unpacking takes a few seconds; keep the UI informed. */
    private void emitProgress(final int megabytes) {
        final JSObject p = new JSObject();
        p.put("megabytes", megabytes);
        if (getActivity() == null) {
            notifyListeners("progress", p);
            return;
        }
        getActivity().runOnUiThread(() -> notifyListeners("progress", p));
    }

    private void resolve(final PluginCall call, final JSObject data) {        if (getActivity() == null) {
            call.resolve(data);
            return;
        }
        getActivity().runOnUiThread(() -> call.resolve(data));
    }

    private void reject(final PluginCall call, final Throwable t) {
        final String msg = (t == null || t.getMessage() == null) ? "转写失败" : t.getMessage();
        if (getActivity() == null) {
            call.reject(msg);
            return;
        }
        getActivity().runOnUiThread(() -> call.reject(msg));
    }

    @Override
    protected void handleOnDestroy() {
        worker.execute(() -> {
            synchronized (SpeechPlugin.this) {
                closeRecognizer();
                closeModel();
            }
        });
        worker.shutdown();
        super.handleOnDestroy();
    }
}
