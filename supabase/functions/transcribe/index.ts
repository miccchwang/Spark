/* Spark — online speech to text.

   The phone uploads the recording here, and this function does the talking to the speech
   service. That is the whole point of the round trip: the provider key stays on the server,
   so it is never shipped inside the APK and never lands in the phone's storage.

   Nothing about the audio is stored. It is forwarded in memory and the answer is passed
   straight back; no bucket, no table, no log of the transcript.

   Deploy:
     supabase functions deploy transcribe
     supabase secrets set ASR_KEY=sk-...

   Optional secrets:
     ASR_URL    an OpenAI-compatible /v1/audio/transcriptions endpoint
     ASR_MODEL  model name, defaults to whisper-1
     ASR_PROMPT a hint passed to the recogniser — a list of names or domain words
                measurably improves results on jargon and proper nouns

   Any provider that speaks the OpenAI transcription API works: OpenAI, Groq, SiliconFlow,
   or a self-hosted whisper.cpp server. Only ASR_URL has to change. */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/** Most transcription APIs reject anything past this, so fail here with a readable message
    rather than letting the provider answer with an opaque 413. */
const MAX_BYTES = 24 * 1024 * 1024;

const ASR_URL = Deno.env.get('ASR_URL') || 'https://api.openai.com/v1/audio/transcriptions';
const ASR_KEY = Deno.env.get('ASR_KEY') || '';
const ASR_MODEL = Deno.env.get('ASR_MODEL') || 'whisper-1';
const ASR_PROMPT = Deno.env.get('ASR_PROMPT') || '';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: '只支持 POST' }, 405);

  if (!ASR_KEY) {
    return json({ error: '服务端还没有配置识别密钥，请先执行 supabase secrets set ASR_KEY=…' }, 500);
  }

  // Only a signed-in user of this project gets to spend the key. Without this check the
  // function would be an open relay for anyone who found the URL.
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return json({ error: '请先登录' }, 401);

  const supa = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: auth } } },
  );
  const { data: { user }, error: authError } = await supa.auth.getUser();
  if (authError || !user) return json({ error: '登录状态已失效，请重新登录' }, 401);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: '请求里没有音频' }, 400);
  }

  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) return json({ error: '请求里没有音频' }, 400);
  if (file.size > MAX_BYTES) {
    return json({ error: '这段录音超过 24 MB，识别服务不收；录短一点再试' }, 413);
  }

  const out = new FormData();
  out.append('file', file, file.name || 'audio.webm');
  out.append('model', ASR_MODEL);
  // 'auto' lets the recogniser detect the language; Chinese recordings want it explicit
  // often enough that the client is allowed to send its own choice through.
  const lang = String(form.get('lang') || '').trim();
  if (lang && lang !== 'auto') out.append('language', lang);
  if (ASR_PROMPT) out.append('prompt', ASR_PROMPT);

  let res: Response;
  try {
    res = await fetch(ASR_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ASR_KEY}` },
      body: out,
    });
  } catch (e) {
    return json({ error: '连不上识别服务：' + (e as Error).message }, 502);
  }

  const raw = await res.text();
  if (!res.ok) {
    let detail = raw.slice(0, 300);
    try {
      const parsed = JSON.parse(raw);
      detail = parsed?.error?.message || parsed?.message || detail;
    } catch { /* provider answered with something that is not JSON; keep the raw slice */ }
    return json({ error: '识别服务返回 ' + res.status + '：' + detail }, 502);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ error: '识别服务返回了无法解析的内容' }, 502);
  }

  // Providers disagree on the field name: OpenAI and Groq use text, some self-hosted
  // whisper servers answer with transcript.
  const text = String(payload.text || payload.transcript || '').trim();
  return json({ text });
});
