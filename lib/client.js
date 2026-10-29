// dsh-qq-sounds — 浏览器半（Client half）
//
// 预构建的 ModuleLoader factory bundle（手写，无构建步骤）：
//   /plugins/dsh-qq-sounds/client.js → window.__ModuleLoader__.load({ id, factory })
//   factory 返回 cordis 插件 { inject, apply }，由页面外壳挂载。
//
// 职责：
//   · 设置页「QQ 提醒音」分区：总开关 / 音量 / QQ 目录检测 / 四类事件各自的音效 / 重复提醒 / 静音时段 / 行为开关；
//   · 声音引擎：Web Audio 合成内置音（含两个「仿 QQ」音）+ 本机音频文件（经宿主 /api/qq-sounds/audio 取流）；
//   · 事件轮询：宿主检测事件并写环形日志，本页每 1.2s 取增量，命中就响；
//   · 重复提醒：审批 / 提问未处理时按间隔重响，直到你回到页面或达到次数上限。
//
// 配置唯一主存是宿主（~/.dsh/qq-sounds/config.json），页面只做镜像，不写 localStorage。

window.__ModuleLoader__.load({
  id: "dsh-qq-sounds",
  factory: (require) => {
    // 兜底一：连模块解析都不许把宿主拖下水。任何异常都退化成「空插件」。
    let ReactModule;
    try {
      ReactModule = require("react");
    } catch {
      return { inject: [], apply() {} };
    }
    const React = ReactModule.default !== undefined ? ReactModule.default : ReactModule;
    const { useState, useRef, useEffect } = React;

    const inject = ["slots"];

    const API = "/api/qq-sounds";
    const POLL_MS = 350;
    const SAVE_DEBOUNCE_MS = 350;

    const EVENT_DEFS = [
      { type: "completed", icon: "✅", label: "任务完成", desc: "一轮对话正常结束（turn/end · completed）" },
      { type: "approval", icon: "🔐", label: "需要审批 / 放权限", desc: "出现审批请求（approval/asked）" },
      { type: "question", icon: "❓", label: "需要你回答问题", desc: "Agent 调用 ask_user_question" },
      { type: "failed", icon: "❌", label: "任务出错", desc: "一轮对话以错误结束（turn/end · error）" }
    ];

    const QQ_VARIANTS = [
      { id: "msg", label: "QQ 好友消息（msg.wav）" },
      { id: "system", label: "QQ 系统消息 / 好友通知（system.wav）" },
      { id: "global", label: "QQ 全局提示（Global.wav）" },
      { id: "tweet", label: "QQ 上线提示（tweet.wav）" },
      { id: "shake", label: "QQ 窗口抖动（shake.wav）" },
      { id: "audio", label: "QQ 语音通话（Audio.wav）" }
    ];

    const BUILTINS = [
      { id: "qq-msg", label: "仿 QQ 好友消息（内置合成）" },
      { id: "qq-system", label: "仿 QQ 系统提示（内置合成）" },
      { id: "chime", label: "钟琴和弦" },
      { id: "ding", label: "清脆单音" },
      { id: "alert", label: "注意提示" },
      { id: "error", label: "下行低鸣" },
      { id: "question", label: "疑问短句" }
    ];

    const CSS = [
      ".qqs-section{max-width:820px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px;font-size:13px}",
      ".qqs-title{margin:0;font-size:16px;font-weight:600;line-height:24px}",
      ".qqs-sub{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:19px}",
      ".qqs-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-module-platform)}",
      ".qqs-card.qqs-off{opacity:.72}",
      ".qqs-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".qqs-cardTitle{font-weight:600;font-size:14px;display:inline-flex;align-items:center;gap:6px}",
      ".qqs-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".qqs-col{display:flex;flex-direction:column;gap:6px}",
      ".qqs-spacer{flex:1}",
      ".qqs-desc{color:var(--dsw-alias-label-tertiary);font-size:12px}",
      ".qqs-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
      ".qqs-block{border-top:1px dashed var(--dsw-alias-border-l2);padding-top:10px;display:flex;flex-direction:column;gap:8px}",
      ".qqs-field{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}",
      ".qqs-fieldLabel{font-size:12px;color:var(--dsw-alias-label-secondary)}",
      ".qqs-input,.qqs-select{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);padding:5px 9px;font:inherit;font-size:13px}",
      ".qqs-input{width:100%;box-sizing:border-box}",
      ".qqs-select{max-width:320px;cursor:pointer}",
      ".qqs-input:focus,.qqs-select:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}",
      ".qqs-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:14px;padding:4px 12px;cursor:pointer;font:inherit;font-size:12px;line-height:1.6;display:inline-flex;align-items:center;gap:4px}",
      ".qqs-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}",
      ".qqs-btn:disabled{opacity:.5;cursor:default}",
      ".qqs-btnMini{padding:2px 9px;border-radius:12px}",
      ".qqs-check{display:inline-flex;align-items:center;gap:7px;cursor:pointer;user-select:none;font-size:13px}",
      ".qqs-check input{margin:0;cursor:pointer;accent-color:var(--dsw-alias-brand-primary);width:15px;height:15px}",
      ".qqs-ok{color:var(--dsw-alias-state-success-primary);font-size:12px}",
      ".qqs-err{color:var(--dsw-alias-state-error-primary);font-size:12px;word-break:break-all}",
      ".qqs-notice{border:1px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-label);border-radius:8px;padding:8px 10px;font-size:12px;line-height:18px}",
      ".qqs-badge{display:inline-block;border:1px solid var(--dsw-alias-border-l3);border-radius:4px;padding:0 6px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);white-space:nowrap}",
      ".qqs-badgeOk{color:var(--dsw-alias-state-success-primary);border-color:currentColor}",
      ".qqs-foot{border-top:1px solid var(--dsw-alias-border-l2);padding-top:10px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:19px;white-space:pre-line}",
      ".qqs-range{width:180px;accent-color:var(--dsw-alias-brand-primary)}",
      ".qqs-mono{font-family:var(--ds-font-family-code,monospace);font-size:11px;word-break:break-all}",
      ".qqs-soundRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".qqs-time{width:86px}",
      ".qqs-evtHead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;width:100%}"
    ].join("\n");

    // ---------- 配置镜像 ----------

    function defaultEvent(type) {
      const event = { enabled: type !== "failed", sound: { mode: "qq", qq: "msg", builtin: "chime", custom: "" } };
      if (type === "approval") {
        event.sound.qq = "system";
        event.sound.builtin = "alert";
        event.repeat = { enabled: true, intervalSec: 25, maxTimes: 6 };
      } else if (type === "question") {
        event.sound.qq = "system";
        event.sound.builtin = "question";
        event.repeat = { enabled: true, intervalSec: 30, maxTimes: 4 };
      } else if (type === "failed") {
        event.sound.builtin = "error";
      }
      return event;
    }

    function defaultConfig() {
      const events = {};
      for (const def of EVENT_DEFS) events[def.type] = defaultEvent(def.type);
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

    function normalizeConfig(raw) {
      const base = defaultConfig();
      if (raw === null || typeof raw !== "object") return base;

      base.master.enabled = raw.master?.enabled !== false;
      for (const def of EVENT_DEFS) {
        const source = raw.events?.[def.type];
        if (source === null || typeof source !== "object") continue;
        const target = base.events[def.type];
        target.enabled = source.enabled === true;
        const sound = source.sound;
        if (sound !== null && typeof sound === "object") {
          if (["qq", "builtin", "custom", "off"].includes(sound.mode)) target.sound.mode = sound.mode;
          if (QQ_VARIANTS.some((v) => v.id === sound.qq)) target.sound.qq = sound.qq;
          if (BUILTINS.some((b) => b.id === sound.builtin)) target.sound.builtin = sound.builtin;
          if (typeof sound.custom === "string") target.sound.custom = sound.custom.slice(0, 4096);
        }
        if (target.repeat !== undefined && source.repeat !== null && typeof source.repeat === "object") {
          target.repeat = {
            enabled: source.repeat.enabled === true,
            intervalSec: clampInt(source.repeat.intervalSec, 5, 600, target.repeat.intervalSec),
            maxTimes: clampInt(source.repeat.maxTimes, 1, 50, target.repeat.maxTimes)
          };
        }
      }

      base.qq.dir = typeof raw.qq?.dir === "string" ? raw.qq.dir : "";
      const detected = raw.qq?.detected;
      if (detected !== null && typeof detected === "object") {
        const files = {};
        for (const variant of QQ_VARIANTS) {
          const value = detected.files?.[variant.id];
          if (typeof value === "string" && value !== "") files[variant.id] = value;
        }
        base.qq.detected = {
          root: typeof detected.root === "string" ? detected.root : "",
          dir: typeof detected.dir === "string" ? detected.dir : "",
          files,
          at: typeof detected.at === "string" ? detected.at : ""
        };
      }

      base.quiet.enabled = raw.quiet?.enabled === true;
      if (typeof raw.quiet?.start === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.quiet.start)) base.quiet.start = raw.quiet.start;
      if (typeof raw.quiet?.end === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.quiet.end)) base.quiet.end = raw.quiet.end;

      base.behavior.onlyWhenUnfocused = raw.behavior?.onlyWhenUnfocused === true;
      base.behavior.notify = raw.behavior?.notify === true;
      base.behavior.titleBadge = raw.behavior?.titleBadge !== false;

      base.volume = clampInt(raw.volume, 0, 100, 100);

      return base;
    }

    const errMsg = (error) => (error && error.message !== undefined ? String(error.message) : String(error));

    // ---------- 声音引擎 ----------

    const audio = (() => {
      let ctx = null;
      let volume = 1;

      const ensureCtx = () => {
        if (ctx !== null) return ctx;
        const Ctor = window.AudioContext ?? window.webkitAudioContext;
        if (Ctor === undefined) return null;
        try {
          ctx = new Ctor();
        } catch {
          return null;
        }
        return ctx;
      };

      const unlock = async () => {
        const local = ensureCtx();
        if (local === null) return false;
        try {
          if (local.state === "suspended") await local.resume();
          const buffer = local.createBuffer(1, 1, 22050);
          const source = local.createBufferSource();
          source.buffer = buffer;
          source.connect(local.destination);
          source.start(0);
        } catch {
          /* 忽略 */
        }
        return ctx !== null && ctx.state === "running";
      };

      const tone = (local, freq, start, duration, options = {}) => {
        const osc = local.createOscillator();
        const gain = local.createGain();
        const t0 = local.currentTime + 0.02 + start;
        osc.type = options.type ?? "sine";
        osc.frequency.setValueAtTime(freq, t0);
        if (options.slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(options.slideTo, t0 + duration);
        const peak = Math.max(0.0001, (options.gain ?? 0.5) * volume);
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.02, duration * 0.3));
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
        osc.connect(gain);
        gain.connect(local.destination);
        osc.start(t0);
        osc.stop(t0 + duration + 0.04);
      };

      const builtin = (id) => {
        const local = ensureCtx();
        if (local === null) return false;
        if (local.state !== "running") void local.resume();
        switch (id) {
          // 仿 QQ「滴滴」：两个短促上行的方波，衰减快。
          case "qq-msg":
            tone(local, 784, 0, 0.09, { type: "square", gain: 0.35 });
            tone(local, 1046, 0.12, 0.12, { type: "square", gain: 0.3 });
            break;
          // 仿 QQ 系统提示：两个低沉的下行音，像好友申请。
          case "qq-system":
            tone(local, 523, 0, 0.14, { type: "triangle", gain: 0.5 });
            tone(local, 392, 0.18, 0.22, { type: "triangle", gain: 0.45 });
            break;
          case "chime":
            tone(local, 1046.5, 0, 0.9, { gain: 0.3 });
            tone(local, 1318.5, 0.05, 0.8, { gain: 0.2 });
            tone(local, 1568, 0.1, 0.7, { gain: 0.14 });
            break;
          case "ding":
            tone(local, 880, 0, 0.55, { gain: 0.45 });
            tone(local, 1760, 0, 0.35, { gain: 0.1 });
            break;
          case "alert":
            tone(local, 660, 0, 0.12, { type: "triangle" });
            tone(local, 880, 0.16, 0.12, { type: "triangle" });
            tone(local, 660, 0.32, 0.2, { type: "triangle" });
            break;
          case "error":
            tone(local, 220, 0, 0.45, { type: "sawtooth", gain: 0.35, slideTo: 110 });
            tone(local, 165, 0.25, 0.4, { type: "sawtooth", gain: 0.25, slideTo: 82 });
            break;
          case "question":
          default:
            tone(local, 587.33, 0, 0.16);
            tone(local, 493.88, 0.18, 0.3);
            break;
        }
        return true;
      };

      let lastElement = null;
      let lastObjectUrl = null;
      let lastSource = null;
      /** 解码缓存：path → AudioBuffer。第二次响起时直接播，不再走网络 + 解码。 */
      const bufferCache = new Map();

      /** base64 → Uint8Array（不依赖 Buffer）。 */
      const decodeBase64 = (text) => {
        const binary = atob(String(text));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return bytes;
      };

      /** 把已解码的 AudioBuffer 立刻播出去。 */
      const playDecoded = async (buffer) => {
        const local = ensureCtx();
        if (local === null) return { ok: false, error: "Web Audio 不可用" };
        if (local.state !== "running") {
          try {
            await local.resume();
          } catch {
            /* 忽略 */
          }
        }
        try {
          const source = local.createBufferSource();
          source.buffer = buffer;
          const gain = local.createGain();
          gain.gain.value = Math.min(1, Math.max(0, volume));
          source.connect(gain);
          gain.connect(local.destination);
          source.start(0);
          lastSource = source;
          return { ok: true };
        } catch (error) {
          return { ok: false, error: error && error.message ? String(error.message) : String(error) };
        }
      };

      /**
       * 用 Web Audio 直接解码播放字节（绕开 <audio> 元素）。
       * 桌面端 dsh-app:// 下 <audio> 解 blob 一律报 no supported source，而 Web Audio 通路
       * 已被内置合成音验证可用，所以 WAV/MP3 一律走这里。
       */
      const playBytes = async (bytes, cacheKey) => {
        const local = ensureCtx();
        if (local === null) return { ok: false, error: "Web Audio 不可用" };
        try {
          if (local.state !== "running") await local.resume();
          const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          const buffer = await local.decodeAudioData(copy);
          if (typeof cacheKey === "string" && cacheKey !== "") {
            if (bufferCache.size > 16) bufferCache.clear();
            bufferCache.set(cacheKey, buffer);
          }
          return await playDecoded(buffer);
        } catch (error) {
          return { ok: false, error: "decodeAudioData: " + (error && error.message ? String(error.message) : String(error)) };
        }
      };

      /** 桌面端（dsh-app://）走 base64 JSON；浏览器端走二进制，失败再回落 base64。 */
      const viaBase64 = async (path) => {
        reportRaw("a64|start|" + path.split("\\").pop());
        const response = await fetch(`${API}/audio64?path=${encodeURIComponent(path)}`, { cache: "no-store" });
        if (!response.ok) {
          reportRaw("a64|http" + response.status);
          let detail = `HTTP ${response.status}`;
          try {
            const payload = await response.json();
            if (payload !== null && typeof payload.error === "string") detail = payload.error;
          } catch {
            /* 忽略 */
          }
          return { ok: false, error: detail };
        }
        const payload = await response.json();
        const bytes = decodeBase64(payload.b64);
        return await playBytes(bytes, path);
      };

      const file = async (path) => {
        // 命中缓存直接播：省掉「下载 base64 + 解码」这两段延迟。
        const cached = bufferCache.get(path);
        if (cached !== undefined) return await playDecoded(cached);
        const bridgePage = typeof location === "object" && location !== null && location.protocol !== "http:" && location.protocol !== "https:";
        try {
          if (bridgePage) return await viaBase64(path);
          const url = `${API}/audio?path=${encodeURIComponent(path)}`;
          const response = await fetch(url, { cache: "no-store" });
          if (!response.ok) {
            let detail = `HTTP ${response.status}`;
            try {
              const payload = await response.json();
              if (payload !== null && typeof payload.error === "string") detail = payload.error;
            } catch {
              /* 忽略 */
            }
            return { ok: false, error: detail };
          }
          const buffer = await response.arrayBuffer();
          return await playBytes(new Uint8Array(buffer), path);
        } catch (error) {
          return { ok: false, error: error && error.message ? String(error.message) : String(error) };
        }
      };

      /** 预取：把要用的音频提前下载 + 解码进缓存，第一次响也不用等。 */
      const prefetch = async (path) => {
        if (typeof path !== "string" || path === "" || bufferCache.has(path)) return;
        try {
          const bridgePage = typeof location === "object" && location !== null && location.protocol !== "http:" && location.protocol !== "https:";
          if (bridgePage) {
            const response = await fetch(`${API}/audio64?path=${encodeURIComponent(path)}`, { cache: "no-store" });
            if (!response.ok) return;
            const payload = await response.json();
            const local = ensureCtx();
            if (local === null) return;
            const copy = decodeBase64(payload.b64);
            const buffer = await local.decodeAudioData(copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength));
            if (bufferCache.size > 16) bufferCache.clear();
            bufferCache.set(path, buffer);
            return;
          }
          const response = await fetch(`${API}/audio?path=${encodeURIComponent(path)}`, { cache: "no-store" });
          if (!response.ok) return;
          const local = ensureCtx();
          if (local === null) return;
          const buffer = await local.decodeAudioData(await response.arrayBuffer());
          if (bufferCache.size > 16) bufferCache.clear();
          bufferCache.set(path, buffer);
        } catch {
          /* 预取失败无所谓，真响的时候再取 */
        }
      };

      return {
        unlock,
        builtin,
        file,
        prefetch,
        setVolume(value) {
          const n = Number(value);
          volume = Number.isFinite(n) ? Math.min(1, Math.max(0, n / 100)) : 1;
        }
      };
    })();

    // ---------- 和宿主说话 ----------

    /**
     * 诊断上报：发布版关闭（true 时会往宿主 trace.log 追加一行，仅本地排查用）。
     * 保留函数签名，避免散落的调用点满地改。
     */
    const DIAG = false;
    function reportRaw() {
      /* release: no-op */
    }

    async function apiRaw(path, options) {
      const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(8000) : undefined;
      const response = await fetch(`${API}/${path}`, {
        cache: "no-store",
        signal,
        headers: options?.body === undefined ? undefined : { "content-type": "application/json" },
        ...options
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text === "" ? null : JSON.parse(text);
      } catch {
        payload = null;
      }
      if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
      return payload;
    }

    // 桌面端的 fetch 走 Electron IPC 桥：并发请求里只要有一个挂住，后面的会一起排队。
    // 所以这里把请求串行化，并给每个请求加硬超时——任何一个挂住都不再拖死轮询。
    let apiQueue = Promise.resolve();
    function api(path, options) {
      const run = () =>
        Promise.race([
          apiRaw(path, options),
          new Promise((_, reject) => setTimeout(() => reject(new Error("api timeout 6s: " + path)), 6000))
        ]);
      const next = apiQueue.then(run, run);
      apiQueue = next.catch(() => {});
      return next;
    }

    // ---------- 状态 ----------

    function createStore(initial) {
      let state = {
        config: initial,
        loaded: false,
        error: null,
        unlocked: false,
        detection: null,
        busy: false,
        lastError: null,
        lastPlay: null
      };
      const listeners = new Set();
      return {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        getSnapshot: () => state,
        set(partial) {
          state = { ...state, ...partial };
          for (const listener of listeners) listener();
        }
      };
    }

    // ---------- 小组件 ----------

    const e = React.createElement;

    function Btn(props) {
      return e(
        "button",
        {
          className: "qqs-btn" + (props.mini ? " qqs-btnMini" : ""),
          onClick: props.onClick,
          disabled: props.disabled === true,
          title: props.title ?? ""
        },
        props.children
      );
    }

    function Toggle(props) {
      return e(
        "label",
        { className: "qqs-check" },
        e("input", { type: "checkbox", checked: props.checked === true, onChange: (ev) => props.onChange(ev.target.checked) }),
        e("span", null, props.label ?? "")
      );
    }

    function SoundRows(props) {
      const { config } = props;
      const files = config.qq.detected.files ?? {};
      return e(
        "div",
        { className: "qqs-soundRow" },
        QQ_VARIANTS.map((variant) =>
          e(
            Btn,
            {
              key: variant.id,
              mini: true,
              disabled: files[variant.id] === undefined,
              title: files[variant.id] ?? "未找到，请先检测 QQ 目录",
              onClick: () => props.onPreview({ kind: "file", path: files[variant.id] })
            },
            "▶ " + variant.id
          )
        ),
        e("span", { className: "qqs-hint" }, "试听 QQ 音（按钮名即文件名）")
      );
    }

    function EventCard(props) {
      const { def, eventConfig, patch, onPreview, previewError } = props;
      const sound = eventConfig.sound;
      const mode = sound.mode;
      const repeat = eventConfig.repeat;

      const patchSound = (partial) => patch({ sound: { ...sound, ...partial } });
      const current = mode === "qq" ? "qq:" + sound.qq : mode === "custom" ? "custom" : mode === "off" ? "off" : "builtin:" + sound.builtin;
      const onChangeMode = (value) => {
        if (value === "off") return patchSound({ mode: "off" });
        if (value === "custom") return patchSound({ mode: "custom" });
        if (value.startsWith("qq:")) return patchSound({ mode: "qq", qq: value.slice(3) });
        patchSound({ mode: "builtin", builtin: value.slice(8) });
      };

      const options = [
        ...QQ_VARIANTS.map((variant) => ({ value: "qq:" + variant.id, label: variant.label })),
        { value: "off", label: "静音（只弹通知）" },
        ...BUILTINS.map((builtin) => ({ value: "builtin:" + builtin.id, label: builtin.label })),
        { value: "custom", label: "自定义本机音频…" }
      ];

      return e(
        "div",
        { className: "qqs-card" + (eventConfig.enabled ? "" : " qqs-off") },
        e(
          "div",
          { className: "qqs-head" },
          e(Toggle, { checked: eventConfig.enabled, onChange: (v) => patch({ enabled: v }), label: "" }),
          e("span", { className: "qqs-cardTitle" }, def.icon + " " + def.label),
          e("span", { className: "qqs-desc" }, def.desc),
          e("span", { className: "qqs-spacer" }),
          e(Btn, { mini: true, onClick: () => onPreview({ kind: "event", type: def.type }), disabled: !eventConfig.enabled }, "▶ 试听")
        ),
        eventConfig.enabled
          ? e(
              "div",
              { className: "qqs-col" },
              e(
                "div",
                { className: "qqs-row" },
                e("span", { className: "qqs-fieldLabel" }, "音效"),
                e(
                  "select",
                  { className: "qqs-select", value: current, onChange: (ev) => onChangeMode(ev.target.value) },
                  options.map((option) => e("option", { key: option.value, value: option.value }, option.label))
                ),
                mode === "qq" && (config_filesMissing(props.config, sound.qq))
                  ? e("span", { className: "qqs-err" }, "没找到该 QQ 音效文件，会回落到内置「仿 QQ」音")
                  : null
              ),
              mode === "custom"
                ? e(
                    "div",
                    { className: "qqs-field" },
                    e("span", { className: "qqs-fieldLabel" }, "本机音频绝对路径（宿主读取，≤4MB）"),
                    e("input", {
                      className: "qqs-input",
                      value: sound.custom,
                      placeholder: "C:\\自定目录\\ding.wav",
                      onChange: (ev) => patchSound({ custom: ev.target.value })
                    })
                  )
                : null,
              repeat !== undefined
                ? e(
                    "div",
                    { className: "qqs-block" },
                    e(
                      "div",
                      { className: "qqs-row" },
                      e(Toggle, { checked: repeat.enabled, onChange: (v) => patch({ repeat: { ...repeat, enabled: v } }), label: "未处理时重复提醒" }),
                      e("span", { className: "qqs-hint" }, "回到页面或达到次数后停止")
                    ),
                    repeat.enabled
                      ? e(
                          "div",
                          { className: "qqs-row" },
                          e("span", { className: "qqs-fieldLabel" }, "间隔（秒）"),
                          e("input", {
                            className: "qqs-input qqs-time",
                            type: "number",
                            min: 5,
                            max: 600,
                            value: repeat.intervalSec,
                            onChange: (ev) => patch({ repeat: { ...repeat, intervalSec: clampInt(ev.target.value, 5, 600, repeat.intervalSec) } })
                          }),
                          e("span", { className: "qqs-fieldLabel" }, "最多"),
                          e("input", {
                            className: "qqs-input qqs-time",
                            type: "number",
                            min: 1,
                            max: 50,
                            value: repeat.maxTimes,
                            onChange: (ev) => patch({ repeat: { ...repeat, maxTimes: clampInt(ev.target.value, 1, 50, repeat.maxTimes) } })
                          }),
                          e("span", { className: "qqs-fieldLabel" }, "次")
                        )
                      : null
                  )
                : null,
              previewError !== null ? e("span", { className: "qqs-err" }, previewError) : null
            )
          : null
      );
    }

    function config_filesMissing(config, variant) {
      return (config.qq.detected.files ?? {})[variant] === undefined;
    }

    function Section(props) {
      const controller = props.qqSounds;
      const state = React.useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot, controller.store.getSnapshot);
      const config = state.config;
      const [previewError, setPreviewError] = useState({});
      const [detectError, setDetectError] = useState(null);
      const [dirDraft, setDirDraft] = useState(config.qq.dir);
      const [busy, setBusy] = useState(false);

      useEffect(() => {
        setDirDraft(config.qq.dir);
      }, [config.qq.dir]);

      const preview = async (target) => {
        const result = await controller.preview(target);
        if (result !== null && result.ok !== true) {
          setPreviewError((previous) => ({ ...previous, [target.type ?? "file"]: result.error }));
        }
      };

      const runDetect = async () => {
        setBusy(true);
        setDetectError(null);
        try {
          const value = await api("detect", { method: "POST", body: JSON.stringify({ dir: dirDraft }) });
          controller.store.set({ config: normalizeConfig(value.config), detection: value.qq });
        } catch (error) {
          setDetectError(errMsg(error));
        } finally {
          setBusy(false);
        }
      };

      const detected = config.qq.detected;
      const fileCount = Object.keys(detected.files ?? {}).length;

      return e(
        "div",
        { className: "qqs-section" },
        e("h2", { className: "qqs-title" }, "QQ 提醒音"),
        e(
          "p",
          { className: "qqs-sub" },
          "DSH 干完活响「QQ 好友消息」，需要你放权限 / 回答问题时响「QQ 系统消息」。音效直接用本机 QQ 自带的 wav；没装 QQ 就回落到内置的「仿 QQ」合成音。"
        ),
        state.error !== null ? e("div", { className: "qqs-notice" }, "⚠ 宿主接口不可用：" + state.error) : null,
        e(
          "p",
          { className: "qqs-hint qqs-mono" },
          "自检：配置" + (state.loaded ? "已读" : "未读") +
            " · 音频解锁=" + (state.unlocked ? "是" : "否") +
            " · 上次播放=" +
            (state.lastPlay === null
              ? "无"
              : (state.lastPlay.ok ? "成功" : "失败（" + (state.lastPlay.error ?? "?") + "）") +
                " · 事件 #" + String(state.lastPlay.eventId ?? "-") + " " + (state.lastPlay.type || "-")) +
            " · 音效模式=" + (config.events.completed.sound.mode === "qq" ? "QQ 文件" : config.events.completed.sound.mode)
        ),

        e(
          "div",
          { className: "qqs-card" },
          e(
            "div",
            { className: "qqs-row" },
            e(Toggle, { checked: config.master.enabled, onChange: (v) => controller.patch({ master: { enabled: v } }), label: e("span", { className: "qqs-cardTitle" }, "启用 QQ 提醒音") }),
            e("span", { className: "qqs-spacer" }),
            state.unlocked ? e("span", { className: "qqs-ok" }, "✓ 音频已解锁") : e(Btn, { mini: true, onClick: () => controller.unlock() }, "解锁音频")
          ),
          config.master.enabled
            ? e(
                "div",
                { className: "qqs-row" },
                e("span", { className: "qqs-fieldLabel" }, "音量"),
                e("input", {
                  className: "qqs-range",
                  type: "range",
                  min: 0,
                  max: 100,
                  step: 5,
                  value: config.volume,
                  onChange: (ev) => controller.patch({ volume: Number(ev.target.value) })
                }),
                e("span", { className: "qqs-hint" }, config.volume + "%")
              )
            : e("span", { className: "qqs-hint" }, "已停用：事件不再记录，也不会响。"),
          !state.unlocked ? e("span", { className: "qqs-hint" }, "浏览器要求页面先有过交互才允许出声：点一下页面任意处，或点「解锁音频」。") : null
        ),

        config.master.enabled
          ? e(
              "div",
              { className: "qqs-card" },
              e(
                "div",
                { className: "qqs-head" },
                e("span", { className: "qqs-cardTitle" }, "QQ 音效目录"),
                e("span", { className: "qqs-spacer" }),
                fileCount > 0
                  ? e("span", { className: "qqs-badge qqs-badgeOk" }, "已找到 " + fileCount + " 个音效")
                  : e("span", { className: "qqs-badge" }, "未找到")
              ),
              detected.dir !== ""
                ? e("span", { className: "qqs-hint qqs-mono" }, detected.dir)
                : e("span", { className: "qqs-hint" }, "没自动找到 QQ 的音效目录。装上 QQ 后点「重新检测」，或手动填 QQ 安装目录（含 Misc\\Sound\\Classic 的那一层之上的目录）。"),
              e(
                "div",
                { className: "qqs-row" },
                e("input", {
                  className: "qqs-input",
                  value: dirDraft,
                  placeholder: "C:\\software_setup\\qq",
                  onChange: (ev) => setDirDraft(ev.target.value)
                }),
                e(Btn, { mini: true, onClick: runDetect, disabled: busy }, busy ? "检测中…" : "重新检测")
              ),
              detectError !== null ? e("span", { className: "qqs-err" }, detectError) : null,
              e("div", { className: "qqs-block" }, e(SoundRows, { config, onPreview: preview })),
              e(
                "span",
                { className: "qqs-hint" },
                "插件不打包也不复制 QQ 的音频文件，只在使用时按路径读取你本机的那一份；换机器 / 删 QQ 后重新检测即可。"
              )
            )
          : null,

        config.master.enabled
          ? EVENT_DEFS.map((def) =>
              e(EventCard, {
                key: def.type,
                def,
                config,
                eventConfig: config.events[def.type],
                patch: (partial) => controller.patch({ events: { ...config.events, [def.type]: { ...config.events[def.type], ...partial } } }),
                onPreview: preview,
                previewError: previewError[def.type] ?? null
              })
            )
          : null,

        config.master.enabled
          ? e(
              "div",
              { className: "qqs-card" },
              e("div", { className: "qqs-head" }, e("span", { className: "qqs-cardTitle" }, "何时提醒、怎么提醒")),
              e(Toggle, { checked: config.behavior.onlyWhenUnfocused, onChange: (v) => controller.patch({ behavior: { ...config.behavior, onlyWhenUnfocused: v } }), label: "只在 DSH 不在前台时响（你在看着就不吵）" }),
              e(Toggle, { checked: config.behavior.notify, onChange: (v) => controller.patch({ behavior: { ...config.behavior, notify: v } }), label: "同时弹系统通知（点击可回到窗口）" }),
              e(Toggle, { checked: config.behavior.titleBadge, onChange: (v) => controller.patch({ behavior: { ...config.behavior, titleBadge: v } }), label: "在窗口标题前加 🔔（有待处理时）" }),
              e(
                "div",
                { className: "qqs-block" },
                e(Toggle, { checked: config.quiet.enabled, onChange: (v) => controller.patch({ quiet: { ...config.quiet, enabled: v } }), label: "静音时段（该时段内不响、也不补发）" }),
                config.quiet.enabled
                  ? e(
                      "div",
                      { className: "qqs-row" },
                      e("input", { className: "qqs-input qqs-time", type: "time", value: config.quiet.start, onChange: (ev) => controller.patch({ quiet: { ...config.quiet, start: ev.target.value } }) }),
                      e("span", { className: "qqs-fieldLabel" }, "→"),
                      e("input", { className: "qqs-input qqs-time", type: "time", value: config.quiet.end, onChange: (ev) => controller.patch({ quiet: { ...config.quiet, end: ev.target.value } }) }),
                      e("span", { className: "qqs-hint" }, "支持跨午夜，如 23:00 → 07:30")
                    )
                  : null
              )
            )
          : null,

        e(
          "p",
          { className: "qqs-foot" },
          "说明：\n" +
            "· 事件由宿主进程检测（turn/end、approval/asked、ask_user_question），本页每 " +
            Math.round(POLL_MS / 100) / 10 +
            " 秒取一次增量，所以声音最多延迟约 1 秒。\n" +
            "· 重复提醒只针对审批 / 提问；你点一下页面、切回窗口或达到次数上限就停。\n" +
            "· 配置存在 ~/.dsh/qq-sounds/config.json（可用 DSH_QQ_SOUNDS_DATA 改目录），不写浏览器存储。\n" +
            "· 只在本机回环地址上提供 /api/qq-sounds/*；读取的音频限制在 wav/mp3/ogg/m4a/aac/flac/webm 且 ≤4MB。\n" +
            "· QQ 音效的版权归腾讯；本插件不内置、不转发行任何 QQ 音频。"
        )
      );
    }

    // ---------- 插件 ----------

    function apply(ctx) {
      // 铁律一：任何异常都不能逃出 apply。桌面端的 web boot 审计把「entry 未激活」
      // 当成整次启动失败，一个插件出错不能让用户进不去。
      // 铁律二：同一页面只能有一个活实例。热更新/重复挂载时如果旧实例没被销毁，
      // 两个实例会同时轮询同一条事件 —— 表现就是「有时响两声、有时感觉很慢」。
      try {
        if (typeof window.__dshQqSoundsDispose === "function") window.__dshQqSoundsDispose();
      } catch {
        /* 旧实例清理失败也继续 */
      }

      let cleanup = null;
      try {
        cleanup = applyInner(ctx);
      } catch (error) {
        reportRaw("applyerr|" + (error && error.message ? error.message : String(error)));
        return () => {};
      }

      const inner = typeof cleanup === "function" ? cleanup : () => {};
      const dispose = () => {
        try {
          if (window.__dshQqSoundsDispose === dispose) delete window.__dshQqSoundsDispose;
        } catch {
          /* 忽略 */
        }
        try {
          inner();
        } catch {
          /* 清理失败不影响宿主 */
        }
      };
      try {
        window.__dshQqSoundsDispose = dispose;
      } catch {
        /* 忽略 */
      }
      return dispose;
    }

    function applyInner(ctx) {
      const styleEl = document.createElement("style");
      styleEl.textContent = CSS;
      document.head.appendChild(styleEl);

      const store = createStore(defaultConfig());
      let saveTimer = null;
      let pollTimer = null;
      let pollCursor = 0;
      let pollBootId = null;
      let firstSync = true;
      let polling = false;
      let disposed = false;
      const pollDiag = { ok: false, err: false };
      let pollCount = 0;

      const repeats = new Map(); // sessionId:type → { timer, count, eventId }
      const seen = new Set();

      // ---- 标题角标 ----
      const originalTitle = document.title;
      const setBadge = (on) => {
        if (disposed) return;
        const config = store.getSnapshot().config;
        if (config.behavior.titleBadge !== true) return;
        if (on) {
          if (!document.title.startsWith("🔔 ")) document.title = "🔔 " + document.title;
        } else if (document.title.startsWith("🔔 ")) {
          document.title = document.title.slice(2);
        }
      };

      // ---- DIAG：累积式上报（保留最近约 900 字符），便于离线排查（定位完就删）----
      const diagReport = reportRaw;

      // ---- 播放 ----
      let pendingGap = null; // 上一次播放的「事件产生 → 真正出声」延迟，随下一次轮询回传宿主
      const playResolved = async (resolved, meta = {}) => {
        let result;
        if (resolved === null) {
          result = { ok: true };
        } else if (resolved.kind === "file") {
          result = await audio.file(resolved.path);
        } else {
          result = audio.builtin(resolved.id) ? { ok: true } : { ok: false, error: "Web Audio 不可用" };
        }
        // 文件播不出来时兜底响一声合成音：至少让你知道「有事件了」。
        if (result.ok !== true && resolved !== null && resolved.kind === "file") {
          const fellBack = audio.builtin("qq-msg");
          diagReport("fallback|" + (fellBack ? "ok" : "err") + "|" + String(result.error ?? "").slice(0, 80));
          if (fellBack) result = { ok: true, error: result.error };
        }
        store.set({
          lastPlay: {
            ts: Date.now(),
            type: meta.type ?? "",
            kind: resolved === null ? "none" : resolved.kind,
            eventId: meta.eventId ?? null,
            ok: result.ok === true,
            error: result.error ?? null,
            gapMs: meta.eventTime !== undefined && meta.eventTime !== null ? Date.now() - meta.eventTime : null
          }
        });
        if (meta.eventTime !== undefined && meta.eventTime !== null) {
          pendingGap = { gapMs: Date.now() - meta.eventTime, eventId: meta.eventId ?? null, type: meta.type ?? "", at: new Date().toISOString() };
        }
        return result;
      };

      const resolveForEvent = (config, type) => {
        const eventConfig = config.events[type];
        if (eventConfig === undefined) return null;
        const sound = eventConfig.sound;
        if (sound.mode === "off") return null;
        if (sound.mode === "qq") {
          const path = (config.qq.detected.files ?? {})[sound.qq];
          if (typeof path === "string" && path !== "") return { kind: "file", path };
          return { kind: "builtin", id: sound.builtin };
        }
        if (sound.mode === "custom") {
          const path = sound.custom.trim();
          if (path !== "") return { kind: "file", path };
          return { kind: "builtin", id: sound.builtin };
        }
        return { kind: "builtin", id: sound.builtin };
      };

      const shouldPlayNow = (config) => {
        if (config.master.enabled !== true) return false;
        if (config.behavior.onlyWhenUnfocused === true && document.hasFocus() && document.visibilityState === "visible") return false;
        return true;
      };

      const notifyDesktop = (config, entry) => {
        if (config.behavior.notify !== true) return;
        if (typeof Notification !== "function") return;
        if (Notification.permission !== "granted") return;
        try {
          const def = EVENT_DEFS.find((item) => item.type === entry.type);
          const notification = new Notification(`DSH · ${def ? def.label : entry.type}`, {
            body: [entry.summary, entry.workspace ? "@" + entry.workspace : ""].filter((part) => part !== "").join("\n"),
            silent: true,
            tag: "dsh-qq-sounds"
          });
          notification.onclick = () => {
            try {
              window.focus();
            } catch {
              /* 忽略 */
            }
            notification.close();
          };
        } catch {
          /* 忽略 */
        }
      };

      const stopRepeat = (key) => {
        const record = repeats.get(key);
        if (record === undefined) return;
        clearInterval(record.timer);
        repeats.delete(key);
      };

      const stopAllRepeats = () => {
        for (const key of [...repeats.keys()]) stopRepeat(key);
      };

      const startRepeat = (config, entry) => {
        const eventConfig = config.events[entry.type];
        if (eventConfig === undefined || eventConfig.repeat === undefined || eventConfig.repeat.enabled !== true) return;
        const key = entry.sessionId + ":" + entry.type;
        stopRepeat(key);
        const intervalSec = clampInt(eventConfig.repeat.intervalSec, 5, 600, 25);
        const maxTimes = clampInt(eventConfig.repeat.maxTimes, 1, 50, 6);
        const record = { count: 0, eventId: entry.id, timer: null };
        record.timer = setInterval(() => {
          if (disposed) return;
          const live = store.getSnapshot().config;
          if (live.master.enabled !== true) {
            stopRepeat(key);
            return;
          }
          record.count += 1;
          if (record.count > maxTimes) {
            stopRepeat(key);
            return;
          }
          const resolved = resolveForEvent(live, entry.type);
          void playResolved(resolved, { type: entry.type, eventId: entry.id, eventTime: Date.parse(entry.time) });
        }, intervalSec * 1000);
        repeats.set(key, record);
      };

      const onEvent = (config, entry) => {
        const eventConfig = config.events[entry.type];
        if (eventConfig === undefined || eventConfig.enabled !== true) return;
        if (shouldPlayNow(config)) void playResolved(resolveForEvent(config, entry.type), { type: entry.type, eventId: entry.id, eventTime: Date.parse(entry.time) });
        notifyDesktop(config, entry);
        if (document.visibilityState !== "visible" || !document.hasFocus()) setBadge(true);
        if (entry.type === "approval" || entry.type === "question") startRepeat(config, entry);
      };

      // ---- 轮询 ----
      const doPoll = async () => {
        if (polling || disposed) return;
        polling = true;
        pollCount += 1;
        try {
          // 用 POST 而不是 GET?since=…：桌面端 IPC 桥对带查询串的 GET 会挂住（实测，
          // 第一次轮询就卡死、后续被 polling 标志挡掉）。游标放进 body，宿主只回增量，
          // 响应通常只有几十字节 —— 这是把「响应延迟」压下来的关键。
          const pollBody = { since: pollCursor };
          if (pendingGap !== null) {
            pollBody.gap = pendingGap.gapMs;
            pollBody.gapEvt = pendingGap.eventId;
            pollBody.gapType = pendingGap.type;
            pendingGap = null;
          }
          const value = await Promise.race([
            api("poll", { method: "POST", body: JSON.stringify(pollBody) }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("poll timeout 5s")), 5000))
          ]);
          const nextBoot = typeof value?.bootId === "string" ? value.bootId : null;
          if (pollBootId !== null && nextBoot !== null && nextBoot !== pollBootId) {
            pollCursor = 0;
            seen.clear();
            firstSync = true;
          }
          if (nextBoot !== null) pollBootId = nextBoot;
          if (Number.isFinite(Number(value?.lastId))) pollCursor = Math.max(pollCursor, Math.floor(Number(value.lastId)));

          const events = Array.isArray(value?.events) ? value.events : [];
          const config = store.getSnapshot().config;
          const fresh = [];
          for (const entry of events) {
            const key = `${entry.id}|${entry.time}|${entry.type}|${entry.sessionId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            fresh.push(entry);
          }
          if (seen.size > 500) {
            for (const key of [...seen].slice(0, seen.size - 500)) seen.delete(key);
          }

          if (firstSync) {
            // 页面刚打开：把已有事件当作「历史」，不响。
            firstSync = false;
          } else {
            for (const entry of fresh) {
              reportRaw("ev|" + entry.id + "|" + entry.type);
              onEvent(config, entry);
            }
          }

          if (store.getSnapshot().error !== null) store.set({ error: null });
          pollCount += 1;
          if (!pollDiag.ok) {
            pollDiag.ok = true;
            diagReport("pollok|n=" + events.length + "|lastId=" + pollCursor + "|first=" + firstSync);
          }
        } catch (error) {
          if (!firstSync) store.set({ error: errMsg(error) });
          if (!pollDiag.err) {
            pollDiag.err = true;
            diagReport("pollerr|" + errMsg(error));
          }
        } finally {
          polling = false;
        }
      };

      // ---- 配置读写 ----
      const persist = () => {
        if (saveTimer !== null) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          saveTimer = null;
          const config = store.getSnapshot().config;
          void api("config", { method: "POST", body: JSON.stringify({ config }) }).catch((error) => {
            store.set({ lastError: errMsg(error) });
          });
        }, SAVE_DEBOUNCE_MS);
      };

      const patch = (partial) => {
        const next = normalizeConfig({ ...store.getSnapshot().config, ...partial });
        store.set({ config: next });
        audio.setVolume(next.volume);
        persist();
      };

      // ---- 预取：把要用的音频提前下载 + 解码进缓存 ----
      // 关键：开机时 AudioContext 通常还是 suspended，decodeAudioData 往往进不了缓存，
      // 于是「重启后第一声」总要现下载（实测 ~800ms）。所以除了配置加载后试一次，
      // 每次用户手势（解锁成功）后再补一次，保证你打字/点击之后第一声就已经预热好。
      const prefetchWanted = () => {
        void (async () => {
          const config = store.getSnapshot().config;
          const wanted = new Set();
          for (const def of EVENT_DEFS) {
            const eventConfig = config.events[def.type];
            if (eventConfig === undefined || eventConfig.enabled !== true) continue;
            if (eventConfig.sound.mode === "qq") {
              const path = (config.qq.detected.files ?? {})[eventConfig.sound.qq];
              if (typeof path === "string" && path !== "") wanted.add(path);
            } else if (eventConfig.sound.mode === "custom" && eventConfig.sound.custom.trim() !== "") {
              wanted.add(eventConfig.sound.custom.trim());
            }
          }
          for (const path of wanted) await audio.prefetch(path);
        })();
      };

      // ---- 首次加载：拿到配置后立刻预取 ----
      void api("config").then(
        (value) => {
          const config = normalizeConfig(value?.config);
          store.set({ config, loaded: true });
          audio.setVolume(config.volume);
          prefetchWanted();
        },
        (error) => store.set({ error: errMsg(error), loaded: true })
      );

      // ---- 用户手势：解锁音频 + 预取 + 停止重响 ----
      const onGesture = () => {
        void audio.unlock().then((ok) => {
          store.set({ unlocked: ok });
          if (ok) prefetchWanted();
        });
        stopAllRepeats();
        setBadge(false);
      };
      document.addEventListener("pointerdown", onGesture, { capture: true });
      document.addEventListener("keydown", onGesture, { capture: true });
      const onVisible = () => {
        if (document.visibilityState === "visible") {
          stopAllRepeats();
          setBadge(false);
        }
      };
      document.addEventListener("visibilitychange", onVisible);
      window.addEventListener("focus", onVisible);

      // 首帧解锁（页面已交互过时通常直接成功）。
      void audio.unlock().then((ok) => store.set({ unlocked: ok }));

      // ---- 对设置页暴露的动作面 ----
      const qqSounds = {
        store,
        patch,
        unlock: () => audio.unlock().then((ok) => store.set({ unlocked: ok })),
        preview: async (target) => {
          await audio.unlock();
          store.set({ unlocked: true });
          const config = store.getSnapshot().config;
          audio.setVolume(config.volume);
          if (target !== null && target.kind === "file") {
            if (typeof target.path !== "string" || target.path === "") return { ok: false, error: "这个音效还没找到文件" };
            return await playResolved({ kind: "file", path: target.path }, { type: "preview" });
          }
          if (target !== null && target.kind === "event") {
            return await playResolved(resolveForEvent(config, target.type), { type: target.type });
          }
          return { ok: false, error: "未知的试听目标" };
        }
      };

      // ---- 注册设置分区（失败也不影响启动：声音照响，只是没有设置页）----
      let disposeSection = () => {};
      try {
        disposeSection = ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            {
              name: "settings.section",
              id: "qq-sounds",
              order: 26,
              label: "QQ 提醒音",
              inject: () => ({ qqSounds })
            },
            (props) => e(Section, props)
          )
        );
        diagReport("slotok");
      } catch (error) {
        diagReport("sloterr|" + (error && error.message ? error.message : String(error)));
      }

      pollTimer = setInterval(doPoll, POLL_MS);
      void doPoll();
      diagReport("pollstart|interval=" + POLL_MS);

      return () => {
        disposed = true;
        if (saveTimer !== null) clearTimeout(saveTimer);
        if (pollTimer !== null) clearInterval(pollTimer);
        stopAllRepeats();
        document.removeEventListener("pointerdown", onGesture, { capture: true });
        document.removeEventListener("keydown", onGesture, { capture: true });
        document.removeEventListener("visibilitychange", onVisible);
        window.removeEventListener("focus", onVisible);
        document.title = originalTitle;
        disposeSection();
        styleEl.remove();
      };
    }

    return { apply, inject };
  }
});
