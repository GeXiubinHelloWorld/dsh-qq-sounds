// dsh-qq-sounds — 宿主半（Host half）
//
// 只做四件事，全部围绕「让浏览器半侧能按 QQ 的音去响」：
//   1. 配置持久化：~/.dsh/qq-sounds/config.json（可用 DSH_QQ_SOUNDS_DATA 改目录）；
//   2. QQ 音效探测：注册表里的安装位置 + 常见安装路径，找到 <QQ>\Misc\Sound\Classic\*.wav；
//   3. 音频读取：/api/qq-sounds/audio 把本机 wav/mp3 原样回给浏览器（白名单扩展名 + 4MB 上限）；
//   4. 事件检测：session/event 火线上识别「完成 / 需要审批 / 需要回答 / 出错」，写环形事件日志，
//      浏览器半侧轮询 /api/qq-sounds/poll 取增量。
//
// 刻意不 import 任何 @deepseek-ai/* 包：宿主侧只用 node: 内置模块，浏览器侧走同源 HTTP 路由。
// 这样插件装进任何 profile 都不需要额外的 peer 依赖能被解析到。
//
// 路由注册只用公开的 webServer 服务：
//   ctx.inject(["webServer"], (inner) => inner.effect(() => inner.webServer.register(route), label))

import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, isAbsolute, extname, basename } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

// ---------- 常量 ----------

/** QQ 经典版音效文件名（不含扩展名）→ 语义。 */
const QQ_VARIANTS = ["msg", "system", "global", "tweet", "shake", "audio"];

const AUDIO_EXTS = new Set([".wav", ".mp3", ".ogg", ".m4a", ".aac", ".flac", ".webm"]);

const AUDIO_MAX_BYTES = 4 * 1024 * 1024;
const BODY_MAX_BYTES = 512 * 1024;
const EVENT_COOLDOWN_MS = 5_000;
const LOG_CAP = 64;
const DETECT_TTL_MS = 30_000;

const EVENT_TYPES = ["completed", "approval", "question", "failed"];

const BUILTIN_IDS = ["qq-msg", "qq-system", "chime", "ding", "alert", "error", "question"];

/** QQ 安装根目录的常见位置（Windows）。探测时会逐个验证 Misc\Sound\Classic 是否存在。 */
const COMMON_QQ_ROOTS = [
  "C:\\Program Files (x86)\\Tencent\\QQ",
  "C:\\Program Files\\Tencent\\QQ",
  "C:\\Program Files (x86)\\Tencent\\QQNT",
  "C:\\Program Files\\Tencent\\QQNT",
  "C:\\software_setup\\qq",
  "D:\\software_setup\\qq",
  "C:\\QQ",
  "D:\\QQ"
];

const REG_UNINSTALL_ROOTS = [
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"
];

// ---------- 配置 ----------

function dataDir() {
  const override = process.env.DSH_QQ_SOUNDS_DATA;
  if (typeof override === "string" && override.trim() !== "") return override.trim();
  return join(homedir(), ".dsh", "qq-sounds");
}

function configPath() {
  return join(dataDir(), "config.json");
}

function defaultEvent(type) {
  const base = {
    enabled: type !== "failed",
    sound: { mode: "qq", qq: "msg", builtin: "chime", custom: "" }
  };
  if (type === "approval") {
    base.sound.qq = "system";
    base.sound.builtin = "alert";
    base.repeat = { enabled: true, intervalSec: 25, maxTimes: 6 };
  } else if (type === "question") {
    base.sound.qq = "system";
    base.sound.builtin = "question";
    base.repeat = { enabled: true, intervalSec: 30, maxTimes: 4 };
  } else if (type === "failed") {
    base.sound.builtin = "error";
  }
  return base;
}

function defaultConfig() {
  const events = {};
  for (const type of EVENT_TYPES) events[type] = defaultEvent(type);
  return {
    version: 1,
    master: { enabled: true },
    events,
    qq: { dir: "", detected: { root: "", dir: "", files: {}, at: "" } },
    quiet: { enabled: false, start: "23:00", end: "07:30" },
    behavior: { onlyWhenUnfocused: false, notify: false, titleBadge: true },
    volume: 100
  };
}

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
};

const cleanString = (value, max = 512) => (typeof value === "string" ? value.slice(0, max) : "");

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function cleanTime(value, fallback) {
  return typeof value === "string" && TIME_RE.test(value) ? value : fallback;
}

export function normalizeConfig(raw) {
  const base = defaultConfig();
  if (raw === null || typeof raw !== "object") return base;

  base.master.enabled = raw.master?.enabled !== false;

  for (const type of EVENT_TYPES) {
    const source = raw.events?.[type];
    if (source === null || typeof source !== "object") continue;
    const target = base.events[type];
    target.enabled = source.enabled === true;

    const sound = source.sound;
    if (sound !== null && typeof sound === "object") {
      if (["qq", "builtin", "custom", "off"].includes(sound.mode)) target.sound.mode = sound.mode;
      if (QQ_VARIANTS.includes(sound.qq)) target.sound.qq = sound.qq;
      if (BUILTIN_IDS.includes(sound.builtin)) target.sound.builtin = sound.builtin;
      target.sound.custom = cleanString(sound.custom, 4096);
    }

    if (target.repeat !== undefined && source.repeat !== null && typeof source.repeat === "object") {
      target.repeat = {
        enabled: source.repeat.enabled === true,
        intervalSec: clampInt(source.repeat.intervalSec, 5, 600, target.repeat.intervalSec),
        maxTimes: clampInt(source.repeat.maxTimes, 1, 50, target.repeat.maxTimes)
      };
    }
  }

  base.qq.dir = cleanString(raw.qq?.dir, 1024).trim();

  const detected = raw.qq?.detected;
  if (detected !== null && typeof detected === "object") {
    const files = {};
    for (const variant of QQ_VARIANTS) {
      const value = detected.files?.[variant];
      if (typeof value === "string" && value !== "") files[variant] = value.slice(0, 1024);
    }
    base.qq.detected = {
      root: cleanString(detected.root, 1024),
      dir: cleanString(detected.dir, 1024),
      files,
      at: cleanString(detected.at, 40)
    };
  }

  base.quiet.enabled = raw.quiet?.enabled === true;
  base.quiet.start = cleanTime(raw.quiet?.start, base.quiet.start);
  base.quiet.end = cleanTime(raw.quiet?.end, base.quiet.end);

  base.behavior.onlyWhenUnfocused = raw.behavior?.onlyWhenUnfocused === true;
  base.behavior.notify = raw.behavior?.notify === true;
  base.behavior.titleBadge = raw.behavior?.titleBadge !== false;

  base.volume = clampInt(raw.volume, 0, 100, 100);

  return base;
}

async function readConfigFromDisk() {
  try {
    const text = await readFile(configPath(), "utf8");
    return normalizeConfig(JSON.parse(text));
  } catch {
    return defaultConfig();
  }
}

async function writeConfigToDisk(config) {
  await mkdir(dataDir(), { recursive: true });
  await writeFile(configPath(), JSON.stringify(config, null, 2), "utf8");
}

// ---------- 小工具 ----------

const errText = (error) => (error instanceof Error ? error.message : String(error));

const truncate = (text, max = 160) => {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
};

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** 静音时段判定，支持跨午夜（如 23:00–07:30）。两端相等视为全天不静音。 */
export function inQuietHours(quiet, date = new Date()) {
  if (!quiet || quiet.enabled !== true) return false;
  const start = toMinutes(cleanTime(quiet.start, "23:00"));
  const end = toMinutes(cleanTime(quiet.end, "07:30"));
  if (start === end) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** 从会话事件尾部推断一个人类可读的任务名（标题事件 → 首条用户消息 → cwd 目录名）。 */
export function sessionTaskName(session) {
  const events = Array.isArray(session?.events) ? session.events : [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === "session/title" && typeof event.data?.title === "string" && event.data.title.trim() !== "") {
      return truncate(event.data.title, 80);
    }
  }
  for (const event of events) {
    if (event?.type !== "user/message") continue;
    const content = event.data?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
        return truncate(block.text, 80);
      }
    }
  }
  const cwd = typeof session?.header?.cwd === "string" ? session.header.cwd : "";
  return cwd === "" ? "未命名会话" : truncate(basename(cwd), 80);
}

/** 最后一条 assistant 文本，做「完成」事件的摘要。 */
export function lastAssistantText(events) {
  const list = Array.isArray(events) ? events : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const event = list[i];
    if (event?.type !== "assistant/message") continue;
    const content = event.data?.message?.content;
    if (!Array.isArray(content)) return "";
    const texts = content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text);
    if (texts.length > 0) return truncate(texts.join(" "), 120);
  }
  return "";
}

// ---------- QQ 音效探测 ----------

function runRegQuery(args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    try {
      execFile("reg.exe", args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) =>
        resolve(error === null ? String(stdout ?? "") : "")
      );
    } catch {
      resolve("");
    }
  });
}

/** 读一条 `reg query` 输出里的某个值；找不到返回空串。 */
function regValue(output, name) {
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s+(\S+)\s+REG_[A-Z_]+\s+(.*)$/);
    if (match !== null && match[1].toLowerCase() === name.toLowerCase()) return match[2].trim();
  }
  return "";
}

/**
 * 从注册表卸载项里找 QQ 的安装位置。
 * 只走「列子键 → 名字里带 QQ/Tencent → 读 DisplayIcon/InstallLocation/UninstallString」这条窄路径，
 * 任何一步失败都静默跳过：探测是尽力而为，找不到就让用户手填目录。
 */
async function registryCandidates() {
  if (process.platform !== "win32") return [];
  const keys = [];
  for (const root of REG_UNINSTALL_ROOTS) {
    const listing = await runRegQuery(["query", root]);
    if (listing === "") continue;
    for (const line of listing.split(/\r?\n/)) {
      const match = line.match(/^\s+(\S.*?)\s*$/);
      if (match === null) continue;
      const key = match[1];
      if (!/qq|tencent|腾讯/i.test(key)) continue;
      if (/qqmail|qqlive|qqmusic|qqplayer|qqpcmgr|qqbrowser|weiyun/i.test(key)) continue;
      keys.push(`${root}\\${basename(key)}`);
    }
  }

  const found = [];
  for (const key of keys.slice(0, 12)) {
    const values = await runRegQuery(["query", key]);
    if (values === "") continue;
    const display = regValue(values, "DisplayName");
    if (display !== "" && !/qq/i.test(display) && !/腾讯/i.test(display)) continue;
    for (const field of ["InstallLocation", "DisplayIcon", "UninstallString"]) {
      let value = regValue(values, field);
      if (value === "") continue;
      value = value.replace(/"/g, "");
      if (/\.exe$/i.test(value)) value = join(value, "..");
      if (value !== "") found.push(value);
    }
  }
  return found;
}

/** 在一组候选根目录下找 Misc\Sound\Classic；命中即返回该目录与文件表。 */
async function inspectQqRoot(root) {
  if (typeof root !== "string" || root.trim() === "") return null;
  const normalized = root.trim().replace(/[\\/]+$/, "");
  const soundDirs = [
    join(normalized, "Misc", "Sound", "Classic"),
    join(normalized, "Misc", "Sound"),
    join(normalized, "resource", "sound"),
    join(normalized, "sound")
  ];
  for (const dir of soundDirs) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const byLower = new Map();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (!AUDIO_EXTS.has(ext)) continue;
      byLower.set(basename(entry.name, extname(entry.name)).toLowerCase(), join(dir, entry.name));
    }
    if (byLower.size === 0) continue;
    const files = {};
    for (const variant of QQ_VARIANTS) {
      const hit = byLower.get(variant);
      if (hit !== undefined) files[variant] = hit;
    }
    if (Object.keys(files).length === 0) continue;
    return { root: normalized, dir, files };
  }
  return null;
}

/**
 * 探测本机 QQ 音效。
 * 顺序：用户手填目录 → 环境变量 → 常见路径 → 注册表；第一个能读出 wav 的胜出。
 * 注册表查询放在最后，因为它要起 reg.exe：慢，而且在多数机器上用不上。
 */
export async function detectQQ(config) {
  const candidates = [];
  const push = (value) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim().replace(/^"|"$/g, "");
    if (trimmed !== "" && !candidates.includes(trimmed)) candidates.push(trimmed);
  };

  push(config?.qq?.dir);
  push(process.env.DSH_QQ_DIR);
  for (const root of COMMON_QQ_ROOTS) push(root);

  const tryAll = async (list) => {
    for (const candidate of list) {
      const hit = await inspectQqRoot(candidate);
      if (hit !== null) return { ...hit, at: new Date().toISOString() };
    }
    return null;
  };

  const direct = await tryAll(candidates);
  if (direct !== null) return direct;

  const registered = [];
  for (const root of await registryCandidates()) {
    if (!candidates.includes(root)) registered.push(root);
  }
  const viaRegistry = await tryAll(registered);
  if (viaRegistry !== null) return viaRegistry;

  return { root: "", dir: "", files: {}, at: new Date().toISOString() };
}

// ---------- 音频读取 ----------

function isLoopback(address) {
  if (typeof address !== "string") return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1" || address.startsWith("127.");
}

function mimeOf(ext) {
  switch (ext) {
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
      return "audio/mp4";
    case ".aac":
      return "audio/aac";
    case ".ogg":
      return "audio/ogg";
    case ".flac":
      return "audio/flac";
    case ".webm":
      return "audio/webm";
    default:
      return "audio/wav";
  }
}

// ---------- WAV 转码：MS ADPCM → PCM16 ----------
//
// QQ 经典版的「好友消息」msg.wav 是 MS ADPCM (wFormatTag=2)。Chromium 的 <audio> 与
// decodeAudioData 都不支持这种编码，不转码就只能回落到合成音。这里在宿主侧解成
// PCM16 再送出去。QQ 其余音效（system/Global/tweet/shake/Audio）本来就是 PCM。

const ADPCM_COEFS = [
  [256, 0],
  [512, -256],
  [0, 0],
  [192, 64],
  [240, 0],
  [460, -208],
  [392, -232]
];

const ADPCM_ADAPT = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];

function readRiffChunks(buffer) {
  if (buffer.length < 12) return null;
  if (buffer.toString("latin1", 0, 4) !== "RIFF" || buffer.toString("latin1", 8, 12) !== "WAVE") return null;
  const chunks = {};
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("latin1", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > buffer.length) break;
    chunks[id] = { start, size };
    offset = start + size + (size % 2);
  }
  return chunks;
}

function wavInfo(buffer) {
  const chunks = readRiffChunks(buffer);
  // 注意：fmt 的 chunk id 是 "fmt "（带尾空格），data 是 "data"。
  const fmtChunk = chunks === null ? undefined : chunks["fmt "];
  if (fmtChunk === undefined) return null;
  const at = fmtChunk.start;
  return {
    formatTag: buffer.readUInt16LE(at),
    channels: buffer.readUInt16LE(at + 2),
    sampleRate: buffer.readUInt32LE(at + 4),
    blockAlign: buffer.readUInt16LE(at + 12),
    bitsPerSample: buffer.readUInt16LE(at + 14),
    hasData: chunks.data !== undefined,
    chunks
  };
}

/** 把 MS ADPCM（单声道）WAV 解成 PCM16 样本。 */
function decodeMsAdpcmMono(buffer, info) {
  const chunks = info.chunks;
  const blockAlign = info.blockAlign;
  const dataStart = chunks.data.start;
  const dataSize = chunks.data.size;
  if (blockAlign <= 7 || dataSize === 0) throw new Error("ADPCM 块参数无效");

  const samples = [];
  let block = 0;
  while (block * blockAlign < dataSize) {
    const base = dataStart + block * blockAlign;
    const end = Math.min(base + blockAlign, dataStart + dataSize);
    if (end - base < 7) break;

    const predictor = buffer[base];
    let delta = buffer.readInt16LE(base + 1);
    let sample1 = buffer.readInt16LE(base + 3);
    let sample2 = buffer.readInt16LE(base + 5);
    const coef = ADPCM_COEFS[predictor] ?? ADPCM_COEFS[0];

    samples.push(sample2, sample1);

    for (let i = base + 7; i < end; i += 1) {
      const byte = buffer[i];
      const nibbles = [byte >> 4, byte & 0x0f];
      for (const nibble of nibbles) {
        const signed = nibble >= 8 ? nibble - 16 : nibble;
        let predicted = (sample1 * coef[0] + sample2 * coef[1]) >> 8;
        predicted += signed * delta;
        if (predicted > 32767) predicted = 32767;
        else if (predicted < -32768) predicted = -32768;
        sample2 = sample1;
        sample1 = predicted;
        samples.push(predicted);
        delta = (ADPCM_ADAPT[nibble] * delta) >> 8;
        if (delta < 16) delta = 16;
      }
    }
    block += 1;
  }
  return { samples, sampleRate: info.sampleRate };
}

function buildPcm16Wav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(dataBytes, 40);
  const pcm = Buffer.alloc(dataBytes);
  for (let i = 0; i < samples.length; i += 1) pcm.writeInt16LE(samples[i], i * 2);
  return Buffer.concat([header, pcm]);
}

/** 需要且能够转码时返回 PCM WAV，否则返回 null。 */
export function transcodeToPcm(buffer) {
  const info = wavInfo(buffer);
  if (info === null || !info.hasData) return null;
  if (info.formatTag !== 2 || info.channels !== 1) return null;
  const { samples, sampleRate } = decodeMsAdpcmMono(buffer, info);
  if (samples.length === 0) return null;
  return buildPcm16Wav(samples, sampleRate);
}

const TRANSCODE_CACHE = new Map();

async function loadAudio(path) {
  if (typeof path !== "string" || path.trim() === "") throw new Error("未提供音频路径");
  const target = path.trim();
  if (!isAbsolute(target)) throw new Error("请提供绝对路径");
  const ext = extname(target).toLowerCase();
  if (!AUDIO_EXTS.has(ext)) throw new Error(`不支持的音频格式 ${ext || "(无扩展名)"}`);
  let info;
  try {
    info = await stat(target);
  } catch {
    throw new Error(`文件不存在：${target}`);
  }
  if (!info.isFile()) throw new Error("目标不是文件");
  if (info.size > AUDIO_MAX_BYTES) throw new Error(`音频过大（上限 ${AUDIO_MAX_BYTES / 1024 / 1024}MB）`);
  let buffer = await readFile(target);

  if (ext === ".wav") {
    const key = `${target}|${info.mtimeMs}|${info.size}`;
    if (TRANSCODE_CACHE.has(key)) return { buffer: TRANSCODE_CACHE.get(key), mime: "audio/wav" };
    try {
      const converted = transcodeToPcm(buffer);
      if (converted !== null) {
        if (TRANSCODE_CACHE.size > 32) TRANSCODE_CACHE.clear();
        TRANSCODE_CACHE.set(key, converted);
        buffer = converted;
      }
    } catch {
      /* 转码失败就按原字节返回，前端会自己回落 */
    }
  }

  return { buffer, mime: mimeOf(ext) };
}

// ---------- 核心 ----------

const cloneConfig = (config) => ({
  ...config,
  master: { ...config.master },
  events: Object.fromEntries(
    Object.entries(config.events).map(([key, value]) => [
      key,
      { ...value, sound: { ...value.sound }, ...(value.repeat ? { repeat: { ...value.repeat } } : {}) }
    ])
  ),
  qq: { ...config.qq, detected: { ...config.qq.detected, files: { ...config.qq.detected.files } } },
  quiet: { ...config.quiet },
  behavior: { ...config.behavior }
});

export function createCore(ctx) {
  let config = null;
  let configReady = null;
  const eventLog = [];
  const lastFire = new Map();
  let eventId = 0;
  const bootId = randomUUID();
  let detectCache = null;

  const snapshot = () => cloneConfig(config);

  const ensureConfig = async () => {
    if (config !== null) return config;
    if (configReady === null) {
      configReady = readConfigFromDisk().then((loaded) => {
        if (config === null) config = loaded;
        return config;
      });
    }
    return configReady;
  };

  const saveConfig = async (input) => {
    const next = normalizeConfig(input);
    config = next;
    try {
      await writeConfigToDisk(next);
    } catch (error) {
      ctx.logger?.warn?.(`[qq-sounds] 配置写盘失败：${errText(error)}`);
    }
    return snapshot();
  };

  const detect = async (payload = {}) => {
    await ensureConfig();
    if (typeof payload.dir === "string") config.qq.dir = payload.dir.trim();
    const hit = await detectQQ(config);
    config.qq.detected = hit;
    detectCache = { at: Date.now(), value: hit };
    try {
      await writeConfigToDisk(config);
    } catch {
      /* 探测结果写盘失败不影响使用 */
    }
    return { qq: hit, config: snapshot() };
  };

  const maybeDetect = async () => {
    await ensureConfig();
    const detected = config.qq.detected;
    if (detected !== null && typeof detected === "object" && Object.keys(detected.files ?? {}).length > 0) return detected;
    if (detectCache !== null && Date.now() - detectCache.at < DETECT_TTL_MS) return detectCache.value;
    const hit = await detectQQ(config);
    config.qq.detected = hit;
    detectCache = { at: Date.now(), value: hit };
    return hit;
  };

  /** 事件入队：过滤总开关、单事件开关、静音时段与去抖；返回写入的条目或 null。 */
  const fire = (type, meta) => {
    if (config === null) return null;
    if (!EVENT_TYPES.includes(type)) return null;
    if (config.master.enabled !== true) return null;
    const eventConfig = config.events[type];
    if (eventConfig === undefined || eventConfig.enabled !== true) return null;
    if (inQuietHours(config.quiet)) return null;

    const key = `${type}:${meta.sessionId}`;
    const now = Date.now();
    const previous = lastFire.get(key) ?? 0;
    if (now - previous < EVENT_COOLDOWN_MS) return null;
    lastFire.set(key, now);
    if (lastFire.size > 400) lastFire.clear();

    eventId += 1;
    const entry = {
      id: eventId,
      type,
      sessionId: meta.sessionId,
      task: meta.task,
      workspace: meta.workspace,
      summary: meta.summary ?? "",
      time: new Date().toISOString()
    };
    eventLog.push(entry);
    if (eventLog.length > LOG_CAP) eventLog.splice(0, eventLog.length - LOG_CAP);
    return entry;
  };

  const onSessionEvent = (session, event) => {
    if (config === null) return;
    try {
      const sessionId = session?.id ?? "unknown";
      const cwd = typeof session?.header?.cwd === "string" ? session.header.cwd : "";
      const base = {
        sessionId,
        task: sessionTaskName(session),
        workspace: cwd === "" ? "未知工作区" : truncate(basename(cwd), 60)
      };

      if (event?.type === "turn/end") {
        const reason = event.data?.reason?.kind;
        if (reason === "completed") {
          fire("completed", { ...base, summary: lastAssistantText(session?.events) });
        } else if (reason === "error") {
          const error = event.data?.reason?.error;
          const detail = error?.message ? `${error.message}${error.code ? `（${error.code}）` : ""}` : "未知错误";
          fire("failed", { ...base, summary: truncate(detail, 200) });
        }
        return;
      }

      if (event?.type === "approval/asked") {
        const data = event.data ?? {};
        const parts = [];
        if (typeof data.toolName === "string" && data.toolName !== "") parts.push(data.toolName);
        if (typeof data.reason === "string" && data.reason !== "") parts.push(truncate(data.reason, 140));
        fire("approval", { ...base, summary: parts.join("：") || "等待你审批 / 放权限" });
        return;
      }

      if (event?.type === "tool/call" && event.data?.name === "ask_user_question") {
        const questions = Array.isArray(event.data?.arguments?.questions) ? event.data.arguments.questions : [];
        const headers = questions
          .map((question) => (question && typeof question.header === "string" ? question.header : ""))
          .filter((header) => header !== "");
        fire("question", { ...base, summary: headers.length > 0 ? truncate(headers.join("；"), 160) : "等待你回答问题" });
      }
    } catch (error) {
      ctx.logger?.error?.(`[qq-sounds] 事件处理失败：${errText(error)}`);
    }
  };

  return {
    async start() {
      await ensureConfig();
      ctx.on("session/event", onSessionEvent);
      void maybeDetect().catch(() => {});
    },
    stop() {
      eventLog.length = 0;
      lastFire.clear();
    },
    ensureConfig,
    getConfig: () => snapshot(),
    saveConfig,
    detect,
    maybeDetect,
    poll(since) {
      const cursor = Number.isFinite(Number(since)) ? Math.floor(Number(since)) : 0;
      return { events: eventLog.filter((entry) => entry.id > cursor), lastId: eventId, bootId };
    },
    loadAudio,
    onSessionEvent
  };
}

// ---------- HTTP 路由 ----------

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store"
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_MAX_BYTES) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text === "" ? {} : JSON.parse(text));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", (error) => reject(error));
  });
}

export function createRoutes(core) {
  const json = (handler) => async (req, res) => {
    if (!isLoopback(req.socket?.remoteAddress)) {
      sendJson(res, 403, { error: "只接受本机回环请求" });
      return;
    }
    try {
      const payload = await handler(req, res);
      if (payload !== undefined) sendJson(res, 200, payload);
    } catch (error) {
      sendJson(res, 400, { error: errText(error) });
    }
  };

  return [
    {
      kind: "exact",
      path: "/api/qq-sounds/health",
      handler: json(async () => ({ ok: true, version: 1 }))
    },
    {
      kind: "exact",
      path: "/api/qq-sounds/config",
      handler: json(async (req) => {
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          const config = await core.saveConfig(body?.config ?? body);
          return { config };
        }
        const config = await core.ensureConfig();
        void core.maybeDetect().catch(() => {});
        return { config };
      })
    },
    {
      kind: "exact",
      path: "/api/qq-sounds/detect",
      handler: json(async (req) => {
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          return await core.detect(body);
        }
        await core.ensureConfig();
        const qq = await core.maybeDetect();
        return { qq };
      })
    },
    {
      kind: "exact",
      path: "/api/qq-sounds/poll",
      handler: json(async (req) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        return core.poll(url.searchParams.get("since") ?? "0");
      })
    },
    {
      kind: "exact",
      path: "/api/qq-sounds/audio64",
      // 桌面端的页面来源是 dsh-app://app，fetch 走 Electron 的 IPC 桥；二进制 body
      // 过桥会被当文本处理而损坏（<audio> 报 no supported source），所以再给一条
      // base64 JSON 通道专门给桥用。浏览器端仍走下面的二进制路由，省一次编码。
      handler: json(async (req) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const { buffer, mime } = await core.loadAudio(url.searchParams.get("path") ?? "");
        return { mime, bytes: buffer.length, b64: buffer.toString("base64") };
      })
    },
    {
      kind: "exact",
      path: "/api/qq-sounds/audio",
      handler: async (req, res) => {
        if (!isLoopback(req.socket?.remoteAddress)) {
          sendJson(res, 403, { error: "只接受本机回环请求" });
          return;
        }
        try {
          const url = new URL(req.url ?? "/", "http://127.0.0.1");
          const target = url.searchParams.get("path") ?? "";
          const { buffer, mime } = await core.loadAudio(target);
          res.writeHead(200, {
            "content-type": mime,
            "content-length": String(buffer.length),
            "cache-control": "no-cache"
          });
          res.end(buffer);
        } catch (error) {
          sendJson(res, 404, { error: errText(error) });
        }
      }
    }
  ];
}

// ---------- 插件 ----------

/**
 * 铁律：宿主半的 apply 绝不抛异常。
 * 一个提醒音插件没有任何理由让 DSH 起不来——注册路由、读配置、起轮询都放在
 * 各自的 try/catch 里，出问题就退化成「插件不工作」，宿主照常启动。
 */
function apply(ctx) {
  let core = null;
  try {
    core = createCore(ctx);
  } catch (error) {
    ctx.logger?.error?.(`[qq-sounds] 初始化失败（已降级，不阻断启动）：${errText(error)}`);
    return () => {};
  }

  try {
    ctx.inject(["webServer"], (inner) => {
      for (const route of createRoutes(core)) {
        inner.effect(() => inner.webServer.register(route), `dsh-qq-sounds: ${route.path}`);
      }
    });
  } catch (error) {
    ctx.logger?.error?.(`[qq-sounds] 路由注册失败（已降级）：${errText(error)}`);
  }

  try {
    const boot = core.start();
    if (boot !== undefined && typeof boot.catch === "function") {
      boot.catch((error) => ctx.logger?.error?.(`[qq-sounds] 启动失败（已降级）：${errText(error)}`));
    }
  } catch (error) {
    ctx.logger?.error?.(`[qq-sounds] start 抛出（已降级）：${errText(error)}`);
  }

  return () => {
    try {
      core.stop();
    } catch {
      /* 清理失败不影响宿主 */
    }
  };
}

export default { name: "dsh-qq-sounds", apply };
