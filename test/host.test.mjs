// 宿主半的单元测试：不依赖 DSH 运行时，只喂一个最小 ctx 桩。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

import {
  inQuietHours,
  sessionTaskName,
  lastAssistantText,
  normalizeConfig,
  detectQQ,
  createCore
} from "../lib/host.js";

const dataDir = await mkdtemp(join(tmpdir(), "qqs-test-"));
process.env.DSH_QQ_SOUNDS_DATA = dataDir;

const mockCtx = () => ({ on() {}, logger: { info() {}, warn() {}, error() {} } });

test("inQuietHours：跨午夜、同日、关闭、两端相等", () => {
  const at = (h, m) => new Date(2026, 0, 1, h, m, 0);
  const crossMidnight = { enabled: true, start: "23:00", end: "07:30" };
  assert.equal(inQuietHours(crossMidnight, at(23, 30)), true);
  assert.equal(inQuietHours(crossMidnight, at(2, 0)), true);
  assert.equal(inQuietHours(crossMidnight, at(7, 29)), true);
  assert.equal(inQuietHours(crossMidnight, at(7, 30)), false);
  assert.equal(inQuietHours(crossMidnight, at(15, 0)), false);

  const daytime = { enabled: true, start: "12:00", end: "13:00" };
  assert.equal(inQuietHours(daytime, at(12, 30)), true);
  assert.equal(inQuietHours(daytime, at(13, 0)), false);

  assert.equal(inQuietHours({ enabled: false, start: "00:00", end: "23:59" }, at(12, 0)), false);
  assert.equal(inQuietHours({ enabled: true, start: "09:00", end: "09:00" }, at(9, 0)), false);
});

test("normalizeConfig：默认值、夹取范围、非法值回落", () => {
  const cfg = normalizeConfig({
    master: { enabled: false },
    volume: 999,
    events: {
      approval: { enabled: true, sound: { mode: "custom", qq: "bogus", custom: "C:\\a.wav" }, repeat: { enabled: true, intervalSec: 1, maxTimes: 999 } },
      completed: { enabled: true, sound: { mode: "nonsense" } }
    },
    quiet: { enabled: true, start: "25:00", end: "07:00" }
  });

  assert.equal(cfg.master.enabled, false);
  assert.equal(cfg.volume, 100);
  assert.equal(cfg.events.approval.sound.mode, "custom");
  assert.equal(cfg.events.approval.sound.qq, "system", "非法 qq 变体应回落到默认 system");
  assert.equal(cfg.events.approval.repeat.intervalSec, 5);
  assert.equal(cfg.events.approval.repeat.maxTimes, 50);
  assert.equal(cfg.events.completed.sound.mode, "qq", "非法 mode 应回落到默认 qq");
  assert.equal(cfg.quiet.start, "23:00", "非法时间应回落到默认");
  assert.equal(cfg.quiet.end, "07:00");
});

test("sessionTaskName：标题 → 首条用户消息 → cwd", () => {
  assert.equal(
    sessionTaskName({ header: { cwd: "C:\\work\\proj" }, events: [{ type: "session/title", data: { title: "重构插件" } }] }),
    "重构插件"
  );
  assert.equal(
    sessionTaskName({
      header: { cwd: "C:\\work\\proj" },
      events: [{ type: "user/message", data: { message: { content: [{ type: "text", text: "帮我看下这个报错" }] } } }]
    }),
    "帮我看下这个报错"
  );
  assert.equal(sessionTaskName({ header: { cwd: "C:\\work\\proj" }, events: [] }), "proj");
  assert.equal(sessionTaskName({ events: [] }), "未命名会话");
});

test("lastAssistantText：取最后一条 assistant 文本块", () => {
  assert.equal(
    lastAssistantText([
      { type: "assistant/message", data: { message: { content: [{ type: "text", text: "第一句" }] } } },
      { type: "assistant/message", data: { message: { content: [{ type: "text", text: "最后一句" }] } } }
    ]),
    "最后一句"
  );
  assert.equal(lastAssistantText([]), "");
});

test("createCore：完成/审批/提问/出错四类事件入队，去抖生效", async () => {
  const core = createCore(mockCtx());
  await core.start();

  const session = {
    id: "s1",
    header: { cwd: "C:\\work\\proj" },
    events: [{ type: "user/message", data: { message: { content: [{ type: "text", text: "跑一下测试" }] } } }]
  };

  core.onSessionEvent(session, { type: "turn/end", data: { reason: { kind: "completed" } } });
  // 同一会话同类事件 5 秒内只记一次
  core.onSessionEvent(session, { type: "turn/end", data: { reason: { kind: "completed" } } });
  core.onSessionEvent(session, { type: "approval/asked", data: { toolName: "write", reason: "写入工作区" } });
  core.onSessionEvent(session, { type: "tool/call", data: { name: "ask_user_question", arguments: { questions: [{ header: "选哪个" }] } } });

  const poll1 = core.poll(0);
  assert.equal(poll1.events.length, 3);
  assert.deepEqual(poll1.events.map((e) => e.type), ["completed", "approval", "question"]);
  assert.equal(poll1.events[0].task, "跑一下测试");
  assert.equal(poll1.events[1].summary, "write：写入工作区");
  assert.equal(poll1.events[2].summary, "选哪个");

  // 游标增量
  const cursor = poll1.lastId;
  // 「出错」默认是关的（怕吵），这里显式打开再测。
  const beforeFailed = core.getConfig();
  await core.saveConfig({
    ...beforeFailed,
    events: { ...beforeFailed.events, failed: { ...beforeFailed.events.failed, enabled: true } }
  });
  core.onSessionEvent({ ...session, id: "s2" }, { type: "turn/end", data: { reason: { kind: "error", error: { message: "boom", code: "E1" } } } });
  const poll2 = core.poll(cursor);
  assert.equal(poll2.events.length, 1);
  assert.equal(poll2.events[0].type, "failed");
  assert.match(poll2.events[0].summary, /boom/);
});

test("createCore：总开关、单事件开关、静音时段都会拦掉事件", async () => {
  const core = createCore(mockCtx());
  await core.start();
  const session = { id: "s3", header: { cwd: "C:\\w" }, events: [] };
  const end = { type: "turn/end", data: { reason: { kind: "completed" } } };

  await core.saveConfig({ ...core.getConfig(), master: { enabled: false } });
  core.onSessionEvent(session, end);
  assert.equal(core.poll(0).events.length, 0, "总开关关闭时不应记录");

  const base = core.getConfig();
  await core.saveConfig({ ...base, master: { enabled: true }, events: { ...base.events, completed: { ...base.events.completed, enabled: false } } });
  core.onSessionEvent(session, end);
  assert.equal(core.poll(0).events.length, 0, "单事件关闭时不应记录");

  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const start = `${pad(now.getHours())}:00`;
  const endHour = `${pad((now.getHours() + 1) % 24)}:00`;
  const restored = core.getConfig();
  await core.saveConfig({
    ...restored,
    master: { enabled: true },
    events: { ...restored.events, completed: { ...restored.events.completed, enabled: true } },
    quiet: { enabled: true, start, end: endHour }
  });
  core.onSessionEvent({ ...session, id: "s4" }, end);
  const duringQuiet = core.poll(0);
  assert.equal(duringQuiet.events.length, 0, "静音时段内不应记录");
});

test("createCore：配置写盘并可再读回", async () => {
  const core = createCore(mockCtx());
  await core.start();
  await core.saveConfig({
    ...core.getConfig(),
    volume: 30,
    qq: { dir: "C:\\software_setup\\qq", detected: { root: "x", dir: "y", files: { msg: "C:\\a.wav" }, at: "now" } }
  });
  assert.equal(existsSync(join(dataDir, "config.json")), true);

  const fresh = createCore(mockCtx());
  await fresh.start();
  assert.equal(fresh.getConfig().volume, 30);
  assert.equal(fresh.getConfig().qq.dir, "C:\\software_setup\\qq");
});

test("loadAudio：白名单、绝对路径、缺失文件", async () => {
  const core = createCore(mockCtx());
  await core.start();

  const wavPath = join(dataDir, "ding.wav");
  await writeFile(wavPath, Buffer.from("RIFF0000WAVEfmt ", "utf8"));
  const loaded = await core.loadAudio(wavPath);
  assert.equal(loaded.mime, "audio/wav");
  assert.equal(loaded.buffer.length, 16);

  await assert.rejects(() => core.loadAudio("relative.wav"), /绝对路径/);
  await assert.rejects(() => core.loadAudio(join(dataDir, "a.txt")), /不支持的音频格式/);
  await assert.rejects(() => core.loadAudio(join(dataDir, "missing.wav")), /不存在/);
});

test("detectQQ：用 user-data 之外的目录探测到 QQ 音效", async (t) => {
  const dir = "C:\\software_setup\\qq";
  if (!existsSync(join(dir, "Misc", "Sound", "Classic", "msg.wav"))) {
    t.skip("本机没有 QQ 音效目录，跳过");
    return;
  }
  const hit = await detectQQ({ qq: { dir: "" } });
  assert.ok(hit.files.msg.endsWith("msg.wav"));
  assert.ok(hit.files.system.endsWith("system.wav"));
});

test("清理临时数据目录", async () => {
  await rm(dataDir, { recursive: true, force: true });
});
