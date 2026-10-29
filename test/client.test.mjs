// 浏览器半的装载冒烟：用最小 DOM / React 桩跑一遍 bundle 注册与插件 apply，
// 验证 ModuleLoader 契约（id、factory 形状）、设置分区注册参数，以及 dispose 干净。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const SOURCE = await readFile(fileURLToPath(new URL("../lib/client.js", import.meta.url)), "utf8");

function makeReactStub() {
  const React = {
    createElement: (type, props, ...children) => {
      const merged = { ...(props ?? {}) };
      if (children.length > 0) merged.children = children.length === 1 ? children[0] : children;
      return { type, props: merged };
    },
    useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    useRef: (initial) => ({ current: initial }),
    useEffect: () => {},
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot()
  };
  return { __esModule: true, default: React, ...React };
}

/** 极简渲染器：把组件树展开成 { tag, props, children } 并收集所有文本。 */
function shallowRender(node, texts = []) {
  if (node === null || node === undefined || typeof node === "boolean") return null;
  if (Array.isArray(node)) return node.map((child) => shallowRender(child, texts));
  if (typeof node === "string" || typeof node === "number") {
    texts.push(String(node));
    return String(node);
  }
  if (typeof node.type === "function") return shallowRender(node.type(node.props ?? {}), texts);
  const children = node.props?.children;
  const rendered = Array.isArray(children)
    ? children.map((child) => shallowRender(child, texts))
    : shallowRender(children, texts);
  return { tag: node.type, props: node.props, children: rendered };
}

function makeDom() {
  const appended = [];
  const listeners = new Map();
  const head = {
    appendChild(node) {
      appended.push(node);
      node.parentNode = head;
      return node;
    }
  };
  const document = {
    title: "DeepSeek Harness",
    head,
    visibilityState: "visible",
    createElement: () => ({ textContent: "", remove() { this.removed = true; } }),
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: (type) => listeners.delete(type),
    hasFocus: () => true
  };
  return { document, appended, listeners };
}

function loadBundle() {
  const { document, appended, listeners } = makeDom();
  let captured = null;
  const window = {
    __ModuleLoader__: {
      load(options) {
        captured = options;
      }
    },
    addEventListener() {},
    removeEventListener() {}
  };
  const sandbox = {
    window,
    document,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ config: { version: 1, volume: 50 } }),
      json: async () => ({ config: { version: 1, volume: 50 } })
    }),
    Audio: function Audio() {
      this.play = async () => {};
      this.volume = 1;
    },
    Notification: undefined,
    URLSearchParams
  };
  sandbox.window.window = window;
  vm.runInNewContext(SOURCE, sandbox, { filename: "client.js" });
  return { captured, appended, listeners, document };
}

test("bundle 用正确的 id 注册，factory 返回 { apply, inject }", () => {
  const { captured } = loadBundle();
  assert.ok(captured !== null, "应调用 window.__ModuleLoader__.load");
  assert.equal(captured.id, "dsh-qq-sounds");
  assert.equal(typeof captured.factory, "function");

  const plugin = captured.factory((specifier) => {
    assert.equal(specifier, "react");
    return makeReactStub();
  });

  assert.equal(typeof plugin.apply, "function");
  assert.deepEqual([...plugin.inject], ["slots"]);
});

test("apply 注册 settings.section 分区，参数正确，dispose 干净", () => {
  const { captured, appended, document } = loadBundle();
  const plugin = captured.factory(() => makeReactStub());

  let registration = null;
  let injectedProps = null;
  let disposed = false;

  const ctx = {
    slots: {
      inject(name, factory) {
        assert.equal(name, "settings.section");
        const dispose = factory();
        return () => {
          disposed = true;
          if (typeof dispose === "function") dispose();
        };
      },
      register(options, component) {
        registration = options;
        injectedProps = options.inject();
        return () => {};
      }
    }
  };

  const dispose = plugin.apply(ctx);

  assert.ok(registration !== null, "应注册 settings.section");
  assert.equal(registration.name, "settings.section");
  assert.equal(registration.id, "qq-sounds");
  assert.equal(registration.label, "QQ 提醒音");
  assert.equal(registration.order, 26);
  assert.equal(typeof registration.inject, "function");

  const face = injectedProps.qqSounds;
  assert.equal(typeof face.patch, "function");
  assert.equal(typeof face.preview, "function");
  assert.equal(typeof face.unlock, "function");
  assert.equal(typeof face.store.getSnapshot, "function");
  assert.equal(face.store.getSnapshot().config.master.enabled, true);

  assert.equal(appended.length, 1, "应注入一份 CSS");
  assert.equal(document.title, "DeepSeek Harness");

  assert.equal(typeof dispose, "function");
  dispose();
  assert.equal(disposed, true);
  assert.equal(appended[0].removed, true, "dispose 应移除样式");
});

test("设置分区能渲染出四类事件与 QQ 音效区，不抛错", () => {
  const { captured } = loadBundle();
  const plugin = captured.factory(() => makeReactStub());

  let registration = null;
  let Component = null;
  const ctx = {
    slots: {
      inject: (name, factory) => factory(),
      register: (options, component) => {
        registration = options;
        Component = component;
        return () => {};
      }
    }
  };
  plugin.apply(ctx);

  assert.equal(typeof Component, "function");
  const face = registration.inject().qqSounds;

  const texts = [];
  shallowRender(Component({ qqSounds: face }), texts);
  const flat = texts.join(" ");

  assert.match(flat, /QQ 提醒音/);
  assert.match(flat, /任务完成/);
  assert.match(flat, /需要审批/);
  assert.match(flat, /需要你回答问题/);
  assert.match(flat, /任务出错/);
  assert.match(flat, /QQ 音效目录/);
  assert.match(flat, /静音时段/);
  assert.match(flat, /重复提醒/);
});
