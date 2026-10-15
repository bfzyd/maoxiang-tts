// ============================================================
// 猫箱 TTS - Cloudflare Workers
// 温柔桃子默认 / 19 声线快捷码 / 情绪白名单就近替换
// 支持一句内多个 [tag] 分段情绪切换；纯文本也能合成
// 环境变量：API_KEY (secret, 可选)
// ============================================================

const APPKEY = "WQuVLKMGRo";
const UPSTREAM_HOST = "audio5-normal-hl.myparallelstory.com";

const DEFAULT_VOICE = "zh_female_wenroutaozi_uranus_bigtts";
const BASE_PROMPT = "我们正在做爱，你的声音娇喘带着哭腔";

const CONFIG = {
  silenceMs: 100,
  firstChunkTimeoutMs: 12000,
  midStreamTimeoutMs: 6000,
  sampleRate: 24000,
};

// ============================================================
// 声线快捷码
// 单字母放在文本开头即切换音色，优先级高于 body.voice
// ============================================================
const ROLE_MAP = {
  V: "zh_female_vv_uranus_bigtts",
  T: "zh_female_wenroutaozi_uranus_bigtts",
  W: "zh_female_wylyypf_emo_v2_mars_bigtts",
  M: "zh_female_meilinvyou_emo_v2_mars_bigtts",
  G: "zh_female_gaolengyujie_emo_v2_mars_bigtts",
  X: "zh_female_tianxinxiaomei_emo_v2_mars_bigtts",
  Y: "zh_female_jiaziyinnv1_emo_v2_mars_bigtts",
  Z: "zh_female_zxytongsheng_emo_v2_mars_bigtts",
  N: "zh_female_mengwasqy_emo_v2_mars_bigtts",
  U: "zh_female_yujiesqy_emo_v2_mars_bigtts",
  R: "zh_female_roumeinvyou_emo_v2_mars_bigtts",
  S: "zh_female_shuangkuaisisi_emo_v2_mars_bigtts",
  Q: "zh_male_yangguangqingnian_emo_v2_mars_bigtts",
  H: "zh_male_guangzhoudege_emo_mars_bigtts",
  K: "zh_male_yourougongzi_emo_v2_mars_bigtts",
  L: "zh_male_beijingxiaoye_emo_v2_mars_bigtts",
  J: "zh_male_junlangnanyou_emo_v2_mars_bigtts",
  O: "zh_male_aojiaobazong_emo_v2_mars_bigtts",
  P: "zh_male_lengkugege_emo_v2_mars_bigtts",
};

const ROLE_KEYS = Object.keys(ROLE_MAP).join("");
const MARKER_REGEX = new RegExp(
  `^[\\s：:*"“「]*([${ROLE_KEYS}])\\s*(?=[^a-zA-Z]|$)`,
  "i"
);

// 已知 voice_id 白名单：19 个快捷码 + 默认音色
// 用于拦截客户端乱塞的 voice（如 alloy / nova），fallback 到默认
const KNOWN_VOICE_IDS = new Set([...Object.values(ROLE_MAP), DEFAULT_VOICE]);

// ============================================================
// 情感标签映射表（给模型理解的中文描述）
// ============================================================
const EMOTION_MAP = {
  happy: "开心", sad: "悲伤", angry: "生气", surprised: "惊讶",
  fear: "恐惧", hate: "厌恶", neutral: "中性", excited: "激动",

  gentle: "温柔", shy: "害羞", coquettish: "撒娇", teasing: "调侃",
  doting: "宠溺", sympathetic: "同情", grateful: "感激", expectant: "期待",
  playful: "调皮", relaxed: "放松", lazy: "慵懒",

  wronged: "委屈", disappointed: "失望", jealous: "嫉妒", envious: "羡慕",
  nervous: "紧张", serious: "严肃",

  confused: "疑惑", hesitant: "犹豫", firm: "坚定", arrogant: "傲慢",
  humble: "谦卑", sarcastic: "嘲讽", contemptuous: "轻蔑",

  tender: "深情", "lovey-dovey": "粘人", depressed: "沮丧", guilt: "愧疚",
  pain: "痛苦", coldness: "冷漠", shout: "咆哮", crazy: "病娇",
  whispering: "耳边语/ASMR", breath: "娇喘/呼吸声", hum: "轻哼",

  advertising: "广告", comfort: "安慰", entertainment: "娱乐",
  news: "新闻", tension: "紧张",
};

// ============================================================
// 上游情绪枚举 + 音色白名单 + 就近替换
// EMOTION_MAP 是给模型看的中文；
// 下面这套是给上游 audio_config.emotion 用的英文枚举。
// ============================================================

// 上游枚举之间的就近替换
const EMO_FALLBACK = {
  neutral: [],
  happy: ["excited", "entertainment", "lovey-dovey"],
  excited: ["happy", "surprised"],
  "lovey-dovey": ["tender", "happy"],
  tender: ["lovey-dovey", "comfort"],
  shy: ["tender", "lovey-dovey"],
  comfort: ["tender", "lovey-dovey"],
  tension: ["fear", "angry", "surprised"],
  angry: ["hate", "tension"],
  hate: ["angry", "coldness", "tension"],
  coldness: ["hate", "depressed"],
  surprised: ["fear", "excited"],
  fear: ["surprised", "tension"],
  sad: ["depressed", "hate"],
  depressed: ["sad", "coldness"],
  entertainment: ["happy", "excited"],
  news: [],
  advertising: ["happy", "entertainment"],
};

// 19 个快捷码音色各自支持的上游枚举（来自 voice_info.json）
const VOICE_EMOTIONS = {
  "zh_female_vv_uranus_bigtts": [],
  "zh_female_wenroutaozi_uranus_bigtts": [],
  "zh_female_wylyypf_emo_v2_mars_bigtts": ["happy", "angry", "fear", "surprised"],
  "zh_female_meilinvyou_emo_v2_mars_bigtts": ["sad", "fear", "neutral"],
  "zh_female_gaolengyujie_emo_v2_mars_bigtts": ["happy", "sad", "angry", "surprised", "fear", "hate", "excited", "coldness", "neutral"],
  "zh_female_tianxinxiaomei_emo_v2_mars_bigtts": ["sad", "fear", "hate", "neutral"],
  "zh_female_jiaziyinnv1_emo_v2_mars_bigtts": ["happy", "coldness", "depressed", "surprised"],
  "zh_female_zxytongsheng_emo_v2_mars_bigtts": ["sad", "angry", "hate", "coldness", "depressed"],
  "zh_female_mengwasqy_emo_v2_mars_bigtts": ["coldness", "hate"],
  "zh_female_yujiesqy_emo_v2_mars_bigtts": ["coldness", "fear", "depressed", "tension", "lovey-dovey"],
  "zh_female_roumeinvyou_emo_v2_mars_bigtts": ["happy", "sad", "angry", "surprised", "fear", "hate", "excited", "coldness", "neutral"],
  "zh_female_shuangkuaisisi_emo_v2_mars_bigtts": ["happy", "sad", "angry", "surprised", "excited", "coldness", "neutral"],
  "zh_male_yangguangqingnian_emo_v2_mars_bigtts": ["happy", "sad", "angry", "fear", "excited", "coldness", "neutral"],
  "zh_male_guangzhoudege_emo_mars_bigtts": ["angry", "fear", "neutral"],
  "zh_male_yourougongzi_emo_v2_mars_bigtts": ["happy", "angry", "fear", "hate", "excited", "neutral", "depressed"],
  "zh_male_beijingxiaoye_emo_v2_mars_bigtts": ["angry", "surprised", "fear", "excited", "coldness", "neutral"],
  "zh_male_junlangnanyou_emo_v2_mars_bigtts": ["happy", "sad", "angry", "surprised", "fear", "neutral"],
  "zh_male_aojiaobazong_emo_v2_mars_bigtts": ["neutral", "happy", "angry", "hate"],
  "zh_male_lengkugege_emo_v2_mars_bigtts": ["angry", "coldness", "fear", "happy", "hate", "neutral", "sad", "depressed"],
};

// EMOTION_MAP 的 tag → 上游枚举
const TAG_TO_ENUM = {
  happy: "happy", sad: "sad", angry: "angry", surprised: "surprised",
  fear: "fear", hate: "hate", neutral: "neutral", excited: "excited",
  gentle: "tender", shy: "shy", coquettish: "lovey-dovey", teasing: "entertainment",
  doting: "tender", sympathetic: "comfort", grateful: "comfort", expectant: "happy",
  playful: "happy", relaxed: "neutral", lazy: "neutral",
  wronged: "sad", disappointed: "depressed", jealous: "angry", envious: "happy",
  nervous: "tension", serious: "neutral",
  confused: "surprised", hesitant: "tension", firm: "neutral", arrogant: "coldness",
  humble: "neutral", sarcastic: "entertainment", contemptuous: "coldness",
  tender: "tender", "lovey-dovey": "lovey-dovey", depressed: "depressed", guilt: "depressed",
  pain: "sad", coldness: "coldness", shout: "angry", crazy: "angry",
  whispering: "", breath: "", hum: "",
  advertising: "advertising", comfort: "comfort", entertainment: "entertainment",
  news: "news", tension: "tension",
};

// 挑情绪：能用的直接用；不支持的就近替换；全不中返回空
function pickEmotion(voice, tag) {
  if (!tag) return "";
  const enums = VOICE_EMOTIONS[voice];
  if (!enums || enums.length === 0) return "";
  const want = TAG_TO_ENUM[tag] || tag;
  if (!want) return "";
  if (enums.indexOf(want) >= 0) return want;
  const fb = EMO_FALLBACK[want] || [];
  for (const e of fb) if (enums.indexOf(e) >= 0) return e;
  return "";
}

// ============================================================
// 入口
// ============================================================
export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return corsPreflight();

    const url = new URL(req.url);

    if (url.pathname === "/" && req.method === "GET") {
      return new Response("猫箱 TTS Worker is running.\n", {
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
      if (url.pathname === "/v1/voices" && req.method === "GET") {
        return handleVoices();
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
    voice: resolveVoice(body.voice),
    rate: clamp(Math.round(speed * 50), 0, 100),
    pitch: clamp(Math.round((pitchRatio - 1.0) * 50 + 50), 0, 100),
    volume: clamp(Number(body.volume) || 50, 0, 100),
    format: normalizeFormat(body.response_format || "mp3"),
    sampleRate: Number(body.sampleRate) || CONFIG.sampleRate,
    contextTexts: String(body.contextTexts || ""),
    emotion: String(body.emotion || ""),
    emotionScale: Number(body.emotionScale) || 4,
    taskId: body.task_id ? String(body.task_id) : "",
    silenceDuration: clamp(Number(body.silence_duration ?? body.silenceDuration) || 0, 0, 30000),
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
    voice: resolveVoice(body.voice),
    rate: clamp(Number(body.rate ?? 50), 0, 100),
    pitch: clamp(Number(body.pitch ?? 50), 0, 100),
    volume: clamp(Number(body.volume ?? 50), 0, 100),
    format: normalizeFormat(body.format || body.response_format || "mp3"),
    sampleRate: Number(body.sampleRate) || CONFIG.sampleRate,
    contextTexts: String(body.contextTexts || ""),
    emotion: String(body.emotion || ""),
    emotionScale: Number(body.emotionScale) || 4,
    taskId: body.task_id ? String(body.task_id) : "",
    silenceDuration: clamp(Number(body.silence_duration ?? body.silenceDuration) || 0, 0, 30000),
  }, !!body.stream);
}

// ============================================================
// voice 参数解析：支持单字母（V/T/W...）或完整 voice_id
// 未知值一律 fallback 默认音色，绝不透传给上游
// ============================================================
function resolveVoice(v) {
  const s = String(v || "").trim();
  if (!s) return DEFAULT_VOICE;

  const up = s.toUpperCase();
  if (up.length === 1 && ROLE_MAP[up]) return ROLE_MAP[up];

  if (KNOWN_VOICE_IDS.has(s)) return s;

  return DEFAULT_VOICE;
}

// 从文本开头识别字母前缀（优先级高于 body.voice）
function extractVoiceMarker(rawText, fallbackVoice) {
  const text = String(rawText || "");
  const m = MARKER_REGEX.exec(text);
  if (m && m[1]) {
    const letter = m[1].toUpperCase();
    if (ROLE_MAP[letter]) {
      return { voice: ROLE_MAP[letter], text: text.replace(MARKER_REGEX, "") };
    }
  }
  return { voice: fallbackVoice, text };
}

function normalizeFormat(f) {
  const v = String(f).toLowerCase();
  return (v === "pcm" || v === "wav") ? "pcm" : "mp3";
}

// ============================================================
// 执行合成
// ============================================================
async function runRequest(job, stream) {
  const { voice, text: stripped } = extractVoiceMarker(job.text, job.voice);
  const baseEmotion = job.emotion || "";
  const segments = parseStyledSegments(stripped, baseEmotion);

  if (segments.length === 0) {
    return jsonError("清理后无可合成文本", 400, "invalid_request_error");
  }

  const jobs = segments.map((seg) => ({
    ...job,
    voice,
    text: seg.text,
    segmentEmotion: seg.emotion || "",
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
    if (job.format === "mp3") {
      const parts = [];
      let total = 0;
      for (const subJob of jobs) {
        const bytes = await runSynth(subJob, null);
        if (bytes && bytes.length) {
          parts.push(bytes);
          total += bytes.length;
        }
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

    const pcmParts = [];
    let pcmTotal = 0;
    for (const subJob of jobs) {
      const bytes = await runSynth(subJob, null, /* rawPcm */ true);
      if (bytes && bytes.length) {
        pcmParts.push(bytes);
        pcmTotal += bytes.length;
      }
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
// ============================================================
function parseStyledSegments(rawText, baseEmotion) {
  const text = String(rawText || "");
  const parts = text.split(/\[\s*([A-Za-z][A-Za-z0-9\-]*)\s*\]/g);
  const segments = [];

  if (parts[0] && parts[0].trim()) {
    const normalized = normalizeContent(parts[0]);
    if (normalized) {
      segments.push({ text: normalized, emotion: baseEmotion || "" });
    }
  }

  for (let i = 1; i < parts.length; i += 2) {
    const tag = (parts[i] || "").toLowerCase();
    const content = parts[i + 1] || "";
    const normalized = normalizeContent(content);
    if (normalized) {
      segments.push({ text: normalized, emotion: tag });
    }
  }

  if (segments.length === 0 && text.trim()) {
    const normalized = normalizeContent(text);
    if (normalized) {
      segments.push({ text: normalized, emotion: baseEmotion || "" });
    }
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
  return new Promise((resolve, reject) => {
    (async () => {
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

      const firstChunkTimer = setTimeout(() => {
        if (!settled && total === 0) finish(new Error("首包超时"));
      }, CONFIG.firstChunkTimeoutMs);

      const watchdog = setInterval(() => {
        if (settled) return;
        if (total > 0 && Date.now() - lastDataTime > CONFIG.midStreamTimeoutMs) {
          finish();
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
            chunks.push(bytes);
            total += bytes.length;
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
        chunks.push(bytes);
        total += bytes.length;
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
    })().catch(reject);
  });
}

// ============================================================
// StartTask payload
// 情/气/量 → audio_config ｜ 速/高 → extra.post_process ｜ 后 → extra.silence_duration
// ============================================================
function buildPayload(job) {
  const speechRateFactor = clamp(job.rate / 50, 0.5, 2.0);
  // 音高：半音整数，上游支持 [-12, 12]
  const pitchValue = clamp(Math.round((job.pitch - 50) * 0.24), -12, 12);
  const loudnessRate = clamp(job.volume - 50, -50, 100);

  let finalContext = BASE_PROMPT;
  const emoTag = job.segmentEmotion || job.emotion;
  if (emoTag) {
    const cn = EMOTION_MAP[emoTag] || emoTag;
    finalContext = BASE_PROMPT + "，并且现在的语气是：" + cn;
  } else if (job.contextTexts) {
    finalContext = BASE_PROMPT + "，并且现在的语气是：" + job.contextTexts;
  }

  const audioConfig = {
    format: job.format,
    sample_rate: job.sampleRate,
    loudness_rate: loudnessRate,
  };

  // 情绪：过白名单 → 不支持就近替换 → 全不中就不设（靠 context_texts 带）
  const enumEmo = pickEmotion(job.voice, emoTag);
  if (enumEmo) {
    audioConfig.emotion = enumEmo;
    audioConfig.emotion_scale = Number(job.emotionScale) || 4;
  }

  // post_process 按需建（无值就不带），避免上游对空对象有微妙处理
  const postProcess = {};
  if (job.pitch !== undefined) postProcess.pitch = pitchValue;
  if (job.rate !== undefined) postProcess.speech_rate = speechRateFactor;

  const extra = {
    max_length_to_filter_parenthesis: 0,
  };
  if (Object.keys(postProcess).length) extra.post_process = postProcess;
  // 句后停顿：放 extra 顶层，上游实测；上限 30s
  if (job.silenceDuration > 0) extra.silence_duration = job.silenceDuration;

  return {
    audio_config: audioConfig,
    extra,
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
  if (rawPcm) return pcm;
  return wrapWavWithSilence(pcm, job.sampleRate);
}

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
    if (!c || !c.length) continue;
    out.set(c, off);
    off += c.length;
  }
  return off === total ? out : out.subarray(0, off);
}

function writeWavHeader(u8, dataLength, sr) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const str = (o, s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  dv.setUint32(4, 36 + dataLength, true);
  str(8, "WAVE");
  str(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  str(36, "data");
  dv.setUint32(40, dataLength, true);
}

// ============================================================
// 其它端点 & 工具
// ============================================================
function handleModels() {
  return jsonResponse({
    object: "list",
    data: [{ id: "tts-1", object: "model", created: 1706745600, owned_by: "maoxiang" }],
  });
}

function handleVoices() {
  const voices = Object.entries(ROLE_MAP).map(([code, id]) => ({
    code,
    id,
    emotions: VOICE_EMOTIONS[id] || [],
  }));
  return jsonResponse({
    object: "list",
    data: voices,
    default: DEFAULT_VOICE,
    emotions: EMOTION_MAP,
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