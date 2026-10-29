// 端到端冒烟：用假的 Cordis ctx + 真 http 服务器跑通插件的五个路由。
// 只验证「插件能挂、路由能答、契约对」，不启动 DSH 本体。
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

import plugin from "../lib/host.js";

const dataDir = await mkdtemp(join(tmpdir(), "qqs-routes-"));
process.env.DSH_QQ_SOUNDS_DATA = dataDir;

const QQ_DIR = "C:\\software_setup\\qq";
const QQ_WAV = join(QQ_DIR, "Misc", "Sound", "Classic", "msg.wav");

function makeCtx() {
  const routes = new Map();
  const cleanups = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on() {},
    inject(deps, callback) {
      assert.deepEqual(deps, ["webServer"]);
      callback({
        effect(factory, label) {
          assert.equal(typeof label, "string");
          const disposer = factory();
          if (typeof disposer === "function") cleanups.push(disposer);
          return disposer;
        },
        webServer: {
          register(route) {
            routes.set(route.path, route);
            return () => routes.delete(route.path);
          }
        }
      });
    }
  };
  return { ctx, routes, cleanups };
}

async function withServer(fn) {
  const { ctx, routes, cleanups } = makeCtx();
  const dispose = plugin.apply(ctx);
  assert.equal(plugin.name, "dsh-qq-sounds");
  assert.equal(typeof dispose, "function");

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const route = routes.get(pathname);
    if (route === undefined || route.kind !== "exact") {
      res.writeHead(404).end("not found");
      return;
    }
    void route.handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    dispose();
    for (const cleanup of cleanups.reverse()) cleanup();
  }
}

test("插件挂载后注册了五个路由，且都能应答", async () => {
  await withServer(async (base) => {
    const health = await fetch(`${base}/api/qq-sounds/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, version: 1 });

    const config = await (await fetch(`${base}/api/qq-sounds/config`)).json();
    assert.equal(config.config.version, 1);
    assert.equal(config.config.master.enabled, true);
    assert.equal(config.config.events.approval.sound.mode, "qq");
    assert.equal(config.config.events.approval.sound.qq, "system");

    // 保存配置 → 再读回来
    const saved = await (
      await fetch(`${base}/api/qq-sounds/config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: { ...config.config, volume: 42 } })
      })
    ).json();
    assert.equal(saved.config.volume, 42);

    const again = await (await fetch(`${base}/api/qq-sounds/config`)).json();
    assert.equal(again.config.volume, 42);

    const poll = await (await fetch(`${base}/api/qq-sounds/poll?since=0`)).json();
    assert.equal(Array.isArray(poll.events), true);
    assert.equal(typeof poll.bootId, "string");
    assert.equal(poll.lastId, 0);
  });
});

test("detect 路由能探测本机 QQ 音效（没有 QQ 时返回空）", async () => {
  await withServer(async (base) => {
    const value = await (
      await fetch(`${base}/api/qq-sounds/detect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dir: QQ_DIR })
      })
    ).json();
    assert.equal(typeof value.qq.dir, "string");
    if (existsSync(QQ_WAV)) {
      assert.ok(value.qq.files.msg.endsWith("msg.wav"));
      assert.ok(value.qq.files.system.endsWith("system.wav"));
    }
  });
});

test("audio 路由按字节回音频，坏路径报 404", async () => {
  await withServer(async (base) => {
    if (existsSync(QQ_WAV)) {
      const response = await fetch(`${base}/api/qq-sounds/audio?path=${encodeURIComponent(QQ_WAV)}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "audio/wav");
      assert.deepEqual(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString("latin1"), "RIFF");
    }

    const missing = await fetch(`${base}/api/qq-sounds/audio?path=${encodeURIComponent("C:\\nope\\x.wav")}`);
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /不存在/);

    const badExt = await fetch(`${base}/api/qq-sounds/audio?path=${encodeURIComponent("C:\\nope\\x.exe")}`);
    assert.equal(badExt.status, 404);
  });
});

test("audio64 路由以 base64 JSON 回音频（桌面端 IPC 桥用）", async () => {
  await withServer(async (base) => {
    if (!existsSync(QQ_WAV)) return;
    const response = await fetch(`${base}/api/qq-sounds/audio64?path=${encodeURIComponent(QQ_WAV)}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    const payload = await response.json();
    assert.equal(payload.mime, "audio/wav");
    const bytes = Buffer.from(payload.b64, "base64");
    assert.equal(bytes.length, payload.bytes);
    assert.equal(bytes.subarray(0, 4).toString("latin1"), "RIFF");
    assert.equal(bytes.length, 9220);
  });
});

test("清理临时数据目录", async () => {
  await rm(dataDir, { recursive: true, force: true });
});
