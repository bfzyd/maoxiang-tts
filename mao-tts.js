// ============================================================
// 猫箱 TTS - Cloudflare Workers
// 温柔桃子音色 / 45+ 情感标签适配
// 支持一句内多个 [tag] 分段情绪切换；纯文本也能合成（方案 A）
// 环境变量：API_KEY (secret)
// ============================================================

const APPKEY = "WQuVLKMGRo";
const UPSTREAM_HOST = "audio5-normal-hl.myparallelstory.com";

// 锁定音色：温柔桃子
const DEFAULT_VOICE = "zh_female_wenroutaozi_uranus_bigtts";
const BASE_PROMPT = "我们正在做爱，你的声音娇喘带着哭腔";

const CONFIG = {
  silenceMs: 100,
  firstChunkTimeoutMs: 12000,
  midStreamTimeoutMs: 6000,
  sampleRate: 24000,
};

// ============================================================
// 情感标签映射表
// ============================================================
const EMOTION_MAP = {
  // 1. 核心情感
  happy: "开心", sad: "悲伤", angry: "生气", surprised: "惊讶",
  fear: "恐惧", hate: "厌恶", neutral: "中性", excited: "激动",

  // 2. 细腻正向
  gentle: "温柔", shy: "害羞", coquettish: "撒娇", teasing: "调侃",
  doting: "宠溺", sympathetic: "同情", grateful: "感激", expectant: "期待",
  playful: "调皮", relaxed: "放松", lazy: "慵懒",

  // 3. 细腻负面
  wronged: "委屈", disappointed: "失望", jealous: "嫉妒", envious: "羡慕",
  nervous: "紧张", serious: "严肃",

  // 4. 中性与冲突
  confused: "疑惑", hesitant: "犹豫", firm: "坚定", arrogant: "傲慢",
  humble: "谦卑", sarcastic: "嘲讽", contemptuous: "轻蔑",

  // 5. 极致 / 用户定义
  tender: "深情", "lovey-dovey": "粘人", depressed: "沮丧", guilt: "愧疚",
  pain: "痛苦", coldness: "冷漠", shout: "咆哮", crazy: "病娇",
  whispering: "耳边语", breath: "娇喘", hum: "轻哼",

  // 兼容旧标签
  advertising: "广告", comfort: "安慰", entertainment: "娱乐",
  news: "新闻", tension: "紧张",
};

// ============================================================
// 入口
// ============================================================
export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return corsPreflight();

    const url = new URL(req.url);

    if (url.pathname === "/" && req.method === "GET") {
      return new Response("猫箱 TTS Worker (温柔桃子) is running.\n", {
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
// OpenAI 兼容端点：POST /v1/audio/speech
// ============================================================
async function handleSpeech(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return jsonError("请求体不是合法 JSON", 400, "invalid_request_error");
  }
  if (!body.input) {
    return jsonError("'input' 是必需参数", 400, "invalid_request_error");
  }

  const speed = clamp(Number(body.speed) || 1.0, 0.5, 2.0);
  const pitchRatio = clamp(Number(body.pitch) || 1.0, 0.5, 1.5);

  return await runRequest({
    text: String(body.input),
    voice: DEFAULT_VOICE,
    rate: clamp(Math.round(speed * 50), 0, 100),
    pitch: clamp(Math.round((pitchRatio - 1.0) * 50 + 50), 0, 100),
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
// 原生端点：POST /tts
// ============================================================
async function handleNative(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return jsonError("请求体不是合法 JSON", 400, "invalid_request_error");
  }
  const text = String(body.text || body.input || "");
  if (!text) {
    return jsonError("'text' 是必需参数", 400, "invalid_request_error");
  }

  return await runRequest({
    text,
    voice: DEFAULT_VOICE,
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

function normalizeFormat(f) {
  const v = String(f).toLowerCase();
  return (v === "pcm" || v === "wav") ? "pcm" : "mp3";
}

// ============================================================
// 执行合成：支持一句内多个 [tag] 分段
// ============================================================
async function runRequest(job, stream) {
  const baseEmotion = job.emotion || "";
  const segments = parseStyledSegments(job.text, baseEmotion);

  if (segments.length === 0) {
    return jsonError("清理后无可合成文本", 400, "invalid_request_error");
  }

  const jobs = segments.map((seg) => ({
    ...job,
    text: seg.text,
    emotion: seg.emotion || "",
  }));

  // ---------- 流式（仅 mp3） ----------
  if (stream && job.format === "mp3") {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    (async () => {
      try {
        for (const subJob of jobs) {
          await runSynth(subJob, async (bytes) => {
            try { await writer.write(bytes); } catch (_) {}
          });
        }
        try { await writer.close(); } catch (_) {}
      } catch (e) {
        console.error("流式合成失败:", e);
        try { await writer.abort(e); } catch (_) {}
      }
    })();

    return new Response(readable, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
        ...corsHeaders(),
      },
    });
  }

  // ---------- 非流式 ----------
  try {
    // MP3：逐段合成后字节拼接
    if (job.format === "mp3") {
      const parts = [];
      let total = 0;
      for (const subJob of jobs) {
        const bytes = await runSynth(subJob, null);
        parts.push(bytes);
        total += bytes.length;
      }
      const audio = concat(parts, total);
      return new Response(audio, {
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Length": String(audio.byteLength),
          "Cache-Control": "no-store",
          ...corsHeaders(),
        },
      });
    }

    // PCM：每段裸 PCM，最后统一包一次 WAV 头 + 前后静音
    const pcmParts = [];
    let pcmTotal = 0;
    for (const subJob of jobs) {
      const bytes = await runSynth(subJob, null, /* rawPcm */ true);
      pcmParts.push(bytes);
      pcmTotal += bytes.length;
    }
    const pcm = concat(pcmParts, pcmTotal);
    const audio = wrapWavWithSilence(pcm, job.sampleRate);

    return new Response(audio, {
      headers: {
        "Content-Type": "audio/wav",
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
// 按 [tag] 切分整段文本为多个带情绪的 segment
// 例：[shout] A [lovey-dovey] B
//   → [{ emotion:"shout", text:"A" }, { emotion:"lovey-dovey", text:"B" }]
// 无 tag 时，整段按 baseEmotion 合成（方案 A）
// ============================================================
function parseStyledSegments(rawText, baseEmotion) {
  const text = String(rawText || "");
  // split 带捕获组：奇数位是 tag，偶数位是 tag 后的文本
  const parts = text.split(/\[\s*([A-Za-z][A-Za-z0-9\-]*)\s*\]/g);
  const segments = [];

  // ① 首个 tag 之前的纯文本，用基础情绪
  if (parts[0] && parts[0].trim()) {
    segments.push({
      text: normalizeContent(parts[0]),
      emotion: baseEmotion || "",
    });
  }

  // ② 每个 [tag] 后的文本，用该 tag 情绪
  for (let i = 1; i < parts.length; i += 2) {
    const tag = (parts[i] || "").toLowerCase();
    const content = parts[i + 1] || "";
    const normalized = normalizeContent(content);
    if (normalized) {
      segments.push({ text: normalized, emotion: tag });
    }
  }

  // ③ 完全没有 tag 时，整段当作普通文本合成
  if (segments.length === 0 && text.trim()) {
    segments.push({
      text: normalizeContent(text),
      emotion: baseEmotion || "",
    });
  }

  return segments;
}

function normalizeContent(s) {
  return String(s || "")
    .replace(/([—\-~_.。…!！?？])\1+/g, "$1$1")
    .trim();
}

// ============================================================
// WebSocket 合成（单段）
// ============================================================
function runSynth(job, onChunk, rawPcm) {
  return new Promise(async (resolve, reject) => {
    const wsUrl = `wss://${UPSTREAM_HOST}/internal/api/v1/ws?ssmix=&aid=${genId()}&device_id=${genId()}`;
    const fetchUrl = wsUrl.replace(/^wss:\/\//, "https://");

    let resp;
    try {
      resp = await fetch(fetchUrl, { headers: { Upgrade: "websocket" } });
    } catch (e) {
      return reject(new Error("连接失败: " + e.message));
    }
    const ws = resp.webSocket;
    if (!ws) return reject(new Error("WebSocket 升级失败"));
    try {
      ws.accept();
    } catch (e) {
      return reject(new Error("accept 失败: " + e.message));
    }

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
      try {
        resolve(buildAudio(chunks, total, job, rawPcm));
      } catch (e) {
        reject(e);
      }
    };

    // 首包 12s 超时
    const firstChunkTimer = setTimeout(() => {
      if (!settled && total === 0) finish(new Error("首包超时"));
    }, CONFIG.firstChunkTimeoutMs);

    // 中途断流 6s → 残卷组装
    const watchdog = setInterval(() => {
      if (settled) return;
      if (total > 0 && Date.now() - lastDataTime > CONFIG.midStreamTimeoutMs) {
        finish();
      }
    }, 1000);

    ws.addEventListener("message", async (ev) => {
      if (settled) return;
      const d = ev.data;

      // 文本帧
      if (typeof d === "string") {
        let msg;
        try { msg = JSON.parse(d); } catch { return; }

        // type=3 是 base64 音频
        if (msg.type === 3 && msg.buffer) {
          let bytes;
          try { bytes = b64ToBytes(msg.buffer); } catch (_) { return; }
          if (!bytes.length) return;
          chunks.push(bytes);
          total += bytes.length;
          lastDataTime = Date.now();
          if (onChunk) try { await onChunk(bytes); } catch (_) {}
          return;
        }

        // 控制消息
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

      // 二进制帧
      let bytes;
      if (d instanceof ArrayBuffer) bytes = new Uint8Array(d);
      else if (d instanceof Uint8Array) bytes = d;
      else if (d && d.buffer) bytes = new Uint8Array(d.buffer);
      else return;

      if (!bytes.length) return;
      chunks.push(bytes);
      total += bytes.length;
      lastDataTime = Date.now();
      if (onChunk) try { await onChunk(bytes); } catch (_) {}
    });

    ws.addEventListener("close", () => finish());
    ws.addEventListener("error", () => finish(new Error("WebSocket 错误")));

    // 发送 StartTask
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

  // context_texts：情感标签优先，其次用户自定义
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
function buildAudio(chunks, total, job, rawPcm) {
  if (job.format === "mp3") return concat(chunks, total);
  const pcm = concat(chunks, total);
  if (rawPcm) return pcm;                 // 多段合成只返回裸 PCM
  return wrapWavWithSilence(pcm, job.sampleRate);
}

// PCM → WAV 头 + 前后 100ms 静音
function wrapWavWithSilence(pcm, sampleRate) {
  const silenceBytes = alignEven(
    Math.floor(sampleRate * 2 * CONFIG.silenceMs / 1000)
  );
  const silence = new Uint8Array(silenceBytes);
  const out = new Uint8Array(44 + silenceBytes * 2 + pcm.length);
  writeWavHeader(out, silenceBytes * 2 + pcm.length, sampleRate);
  let off = 44;
  out.set(silence, off); off += silenceBytes;
  out.set(pcm, off);     off += pcm.length;
  out.set(silence, off);
  return out;
}

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function writeWavHeader(u8, dataLength, sr) {
  const dv = new DataView(u8.buffer);
  const str = (o, s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  dv.setUint32(4, 36 + dataLength, true);
  str(8, "WAVE");
  str(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);   // PCM
  dv.setUint16(22, 1, true);   // mono
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  str(36, "data");
  dv.setUint32(40, dataLength, true);
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

function genId() {
  return String(Math.floor(1e12 + 9e12 * Math.random()));
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function alignEven(n) {
  return n % 2 ? n + 1 : n;
}

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
