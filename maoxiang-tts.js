// ============================================================
// 猫箱 TTS - Cloudflare Workers (固定 vivi 2.0)
// 环境变量：
//   API_KEY (secret)  调用鉴权，Bearer token 或 ?key=
// ============================================================

const APPKEY = "WQuVLKMGRo";
const UPSTREAM_HOST = "audio5-normal-hl.myparallelstory.com";

// 默认音色：VV vivi 2.0
const DEFAULT_VOICE = "zh_female_vv_uranus_bigtts";
const BASE_PROMPT = "我们正在做爱，你的声音娇喘带着哭腔";

const CONFIG = {
  silenceMs: 100,
  firstChunkTimeoutMs: 12000,
  midStreamTimeoutMs: 6000,
  sampleRate: 24000,
};

const EMOTION_MAP = {
  advertising: "广告", angry: "生气", coldness: "冷漠", comfort: "安慰",
  depressed: "沮丧", entertainment: "娱乐", excited: "兴奋", fear: "恐惧",
  happy: "开心", hate: "厌恶", "lovey-dovey": "撒娇", neutral: "中性",
  news: "新闻", sad: "悲伤", shy: "害羞", surprised: "惊讶",
  tender: "温柔", tension: "紧张",
};

// ============================================================
// 入口
// ============================================================

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return corsPreflight();

    const url = new URL(req.url);

    if (url.pathname === "/" && req.method === "GET") {
      return new Response("猫箱 TTS Worker (vivi 2.0) is running.\n", {
        headers: { "Content-Type": "text/plain;charset=utf-8", ...corsHeaders() },
      });
    }

    if (!authOk(req, env)) {
      return jsonError("无效的 API 密钥", 401, "invalid_api_key");
    }

    try {
      if (url.pathname === "/v1/audio/speech" && req.method === "POST") {
        return await handleSpeech(req);
      }
      if (url.pathname === "/tts" && req.method === "POST") {
        return await handleNative(req);
      }
      if (url.pathname === "/v1/models" && req.method === "GET") {
        return handleModels();
      }
    } catch (e) {
      console.error("请求处理异常:", e);
      return jsonError(e.message || String(e), 500, "internal_server_error");
    }

    return jsonError("未找到", 404, "not_found");
  },
};

// ============================================================
// 鉴权
// ============================================================

function authOk(req, env) {
  if (!env.API_KEY) return true;
  const auth = req.headers.get("authorization") || "";
  const q = new URL(req.url).searchParams.get("key") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : q.trim();
  return token && token === env.API_KEY;
}

// ============================================================
// OpenAI 兼容：POST /v1/audio/speech
// ============================================================

async function handleSpeech(req) {
  let body;
  try { body = await req.json(); } catch {
    return jsonError("请求体不是合法 JSON", 400, "invalid_request_error");
  }
  if (!body.input) return jsonError("'input' 是必需参数", 400, "invalid_request_error");

  const speed = clamp(Number(body.speed) || 1.0, 0.5, 2.0);
  const pitchRatio = clamp(Number(body.pitch) || 1.0, 0.5, 1.5);
  const rate = Math.round(speed * 50);
  const pitch = Math.round((pitchRatio - 1.0) * 50 + 50);

  return await runRequest({
    text: String(body.input),
    voice: normalizeVoice(body.voice),
    rate: clamp(rate, 0, 100),
    pitch: clamp(pitch, 0, 100),
    volume: clamp(Number(body.volume) || 50, 0, 100),
    format: normalizeFormat(body.response_format || "mp3"),
    sampleRate: Number(body.sampleRate) || CONFIG.sampleRate,
    contextTexts: String(body.contextTexts || ""),
    emotion: String(body.emotion || ""),
    emotionScale: Number(body.emotionScale) || 4,
    taskId: body.task_id ? String(body.task_id) : "",
  }, !!body.stream);
}

// ============================================================
// 原生：POST /tts
// ============================================================

async function handleNative(req) {
  let body;
  try { body = await req.json(); } catch {
    return jsonError("请求体不是合法 JSON", 400, "invalid_request_error");
  }
  const text = String(body.text || body.input || "");
  if (!text) return jsonError("'text' 是必需参数", 400, "invalid_request_error");

  return await runRequest({
    text,
    voice: normalizeVoice(body.voice),
    rate: clamp(Number(body.rate ?? 50), 0, 100),
    pitch: clamp(Number(body.pitch ?? 50), 0, 100),
    volume: clamp(Number(body.volume ?? 50), 0, 100),
    format: normalizeFormat(body.format || body.response_format || "mp3"),
    sampleRate: Number(body.sampleRate) || CONFIG.sampleRate,
    contextTexts: String(body.contextTexts || ""),
    emotion: String(body.emotion || ""),
    emotionScale: Number(body.emotionScale) || 4,
    taskId: body.task_id ? String(body.task_id) : "",
  }, !!body.stream);
}

// 强制固定音色，忽略客户端传的
function normalizeVoice(_ignored) {
  return DEFAULT_VOICE;
}

function normalizeFormat(f) {
  const v = String(f).toLowerCase();
  return (v === "pcm" || v === "wav") ? "pcm" : "mp3";
}

// ============================================================
// 执行合成
// ============================================================

async function runRequest(job, stream) {
  const parsed = parseText(job.text);
  if (!parsed.text) return jsonError("清理后无可合成文本", 400, "invalid_request_error");

  job.text = parsed.text;
  if (parsed.emotion) job.emotion = parsed.emotion;

  if (stream && job.format === "mp3") {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    runSynth(job, async (bytes) => {
      try { await writer.write(bytes); } catch (_) {}
    })
      .then(() => { try { writer.close(); } catch (_) {} })
      .catch((e) => {
        console.error("流式合成失败:", e);
        try { writer.abort(e); } catch (_) {}
      });
    return new Response(readable, {
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store", ...corsHeaders() },
    });
  }

  try {
    const audio = await runSynth(job, null);
    const ct = job.format === "pcm" ? "audio/wav" : "audio/mpeg";
    return new Response(audio, {
      headers: {
        "Content-Type": ct,
        "Content-Length": String(audio.byteLength),
        "Cache-Control": "no-store",
        ...corsHeaders(),
      },
    });
  } catch (e) {
    console.error("合成失败:", e);
    return jsonError(e.message || String(e), 502, "tts_generation_error");
  }
}

// ============================================================
// 文本解析：只处理 [emotion]，不再有角色字母
// ============================================================

function parseText(raw) {
  let text = String(raw || "");
  let emotion = "";
  const m = /\[\s*([A-Za-z\-]+)\s*\]/.exec(text);
  if (m) emotion = m[1].toLowerCase();
  text = text.replace(/\[\s*([A-Za-z\-]+)\s*\]\s*/g, "");
  text = text.replace(/([—\-~_.。…!！?？])\1+/g, "$1$1");
  return { text: text.trim(), emotion };
}

// ============================================================
// WebSocket 合成
// ============================================================

function runSynth(job, onChunk) {
  return new Promise(async (resolve, reject) => {
    const wsUrl =
      `wss://${UPSTREAM_HOST}/internal/api/v1/ws?ssmix=&aid=${genId()}&device_id=${genId()}`;
    const fetchUrl = wsUrl.replace(/^wss:\/\//, "https://");

    let resp;
    try {
      resp = await fetch(fetchUrl, { headers: { Upgrade: "websocket" } });
    } catch (e) {
      return reject(new Error("连接失败: " + e.message));
    }
    const ws = resp.webSocket;
    if (!ws) return reject(new Error("WebSocket 升级失败"));
    try { ws.accept(); } catch (e) { return reject(new Error("accept 失败: " + e.message)); }

    const chunks = [];
    let total = 0;
    let settled = false;
    let lastDataTime = Date.now();

    const cleanup = () => {
      clearTimeout(firstChunkTimer);
      clearInterval(watchdog);
      try { ws.close(); } catch (_) {}
    };

    const finish = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) return reject(err);
      if (total === 0) return reject(new Error("无音频数据"));
      try { resolve(buildAudio(chunks, total, job)); }
      catch (e) { reject(e); }
    };

    const firstChunkTimer = setTimeout(() => {
      if (!settled && total === 0) finish(new Error("首包超时"));
    }, CONFIG.firstChunkTimeoutMs);

    const watchdog = setInterval(() => {
      if (settled) return;
      if (total > 0 && Date.now() - lastDataTime > CONFIG.midStreamTimeoutMs) {
        finish(); // 残卷组装，无错误
      }
    }, 1000);

    ws.addEventListener("message", async (ev) => {
      if (settled) return;
      const d = ev.data;

      if (typeof d === "string") {
        let msg;
        try { msg = JSON.parse(d); } catch { return; }

        if (msg.type === 3 && msg.buffer) {
          let bytes;
          try { bytes = b64ToBytes(msg.buffer); } catch (_) { return; }
          if (!bytes.length) return;
          chunks.push(bytes); total += bytes.length;
          lastDataTime = Date.now();
          if (onChunk) try { await onChunk(bytes); } catch (_) {}
          return;
        }

        const event = msg.event || "";
        if (event === "TaskStarted") {
          try {
            ws.send(JSON.stringify({
              appkey: APPKEY,
              event: "ClientSubmitText",
              namespace: "BidirectionalTTS",
              payload: JSON.stringify({ text: job.text }),
            }));
            ws.send(JSON.stringify({
              appkey: APPKEY,
              event: "FinishTask",
              namespace: "BidirectionalTTS",
            }));
          } catch (e) {
            finish(new Error("提交文本失败: " + e.message));
          }
        } else if (event === "TaskFinished") {
          finish();
        } else if (msg.status_code && msg.status_code !== 20000000) {
          finish(new Error(msg.status_text || ("code " + msg.status_code)));
        }
        return;
      }

      let bytes;
      if (d instanceof ArrayBuffer) bytes = new Uint8Array(d);
      else if (d instanceof Uint8Array) bytes = d;
      else if (d && d.buffer) bytes = new Uint8Array(d.buffer);
      else return;
      if (!bytes.length) return;
      chunks.push(bytes); total += bytes.length;
      lastDataTime = Date.now();
      if (onChunk) try { await onChunk(bytes); } catch (_) {}
    });

    ws.addEventListener("close", () => finish());
    ws.addEventListener("error", () => finish(new Error("WebSocket 错误")));

    try {
      ws.send(JSON.stringify({
        appkey: APPKEY,
        event: "StartTask",
        namespace: "BidirectionalTTS",
        ...(job.taskId ? { task_id: job.taskId } : {}),
        payload: JSON.stringify(buildPayload(job)),
      }));
    } catch (e) {
      finish(new Error("发送 StartTask 失败: " + e.message));
    }
  });
}

// ============================================================
// StartTask payload
// ============================================================

function buildPayload(job) {
  const speechRateFactor = clamp(job.rate / 50, 0.5, 2.0);
  const pitchValue = clamp(Math.round((job.pitch - 50) / 10), -5, 5);
  const loudnessRate = clamp(job.volume - 50, -50, 100);

  let finalContext = BASE_PROMPT;
  if (job.emotion) {
    const cn = EMOTION_MAP[job.emotion] || job.emotion;
    finalContext = BASE_PROMPT + "，并且现在的语气是：" + cn;
  } else if (job.contextTexts) {
    finalContext = BASE_PROMPT + "，并且现在的语气是：" + job.contextTexts;
  }

  return {
    audio_config: {
      format: job.format,
      sample_rate: job.sampleRate,
      loudness_rate: loudnessRate,
    },
    extra: {
      post_process: {
        pitch: pitchValue,
        speech_rate: speechRateFactor,
      },
      max_length_to_filter_parenthesis: 0,
    },
    speaker: job.voice,
    context_texts: [finalContext],
  };
}

// ============================================================
// 音频拼接
// ============================================================

function buildAudio(chunks, total, job) {
  if (job.format === "mp3") return concat(chunks, total);

  const silenceBytes = alignEven(Math.floor(job.sampleRate * 2 * CONFIG.silenceMs / 1000));
  const silence = new Uint8Array(silenceBytes);
  const pcm = concat(chunks, total);

  const out = new Uint8Array(44 + silenceBytes * 2 + pcm.length);
  writeWavHeader(out, silenceBytes * 2 + pcm.length, job.sampleRate);
  let off = 44;
  out.set(silence, off); off += silenceBytes;
  out.set(pcm, off);     off += pcm.length;
  out.set(silence, off);
  return out;
}

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function writeWavHeader(u8, dataLength, sr) {
  const dv = new DataView(u8.buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF");
  dv.setUint32(4, 36 + dataLength, true);
  str(8, "WAVE"); str(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, "data"); dv.setUint32(40, dataLength, true);
}

// ============================================================
// 其它
// ============================================================

function handleModels() {
  return jsonResponse({
    object: "list",
    data: [{ id: "tts-1", object: "model", created: 1706745600, owned_by: "maoxiang" }],
  });
}

function genId() { return String(Math.floor(1e12 + 9e12 * Math.random())); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function alignEven(n) { return n % 2 ? n + 1 : n; }

function b64ToBytes(s) {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function jsonError(message, status, code) {
  return jsonResponse({ error: { message, type: "api_error", code } }, status);
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function corsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}
