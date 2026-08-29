// DOM 冒烟测试：用最小 stub 加载并执行 app.js 的初始化，捕获运行时错误。
// 用于在无浏览器环境下验证 app.js 顶层逻辑和 init() 是否能跑通。

import { pathToFileURL } from "url";
import fs from "fs";

function makeEl() {
  const el = {
    _listeners: {},
    _class: new Set(),
    _children: [],
    style: {},
    dataset: {},
    value: "",
    checked: true,
    textContent: "",
    innerHTML: "",
    className: "",
    hidden: false,
    scrollTop: 0,
    scrollHeight: 0,
    id: "",
    clientWidth: 480,
    clientHeight: 480,
    addEventListener(ev, fn) { this._listeners[ev] = fn; },
    setAttribute() {},
    getContext() {
      return new Proxy({}, { get: (t, p) => (...args) => {
        if (p === "createRadialGradient") return { addColorStop() {} };
        return undefined;
      }});
    },
    appendChild(c) { this._children.push(c); return c; },
    querySelectorAll() { return []; },
  };
  el.classList = {
    toggle() {}, add() {}, remove() {},
  };
  return el;
}

// 构建一个假的 document / window
const els = {}; // id -> element
function byId(id) {
  if (!els[id]) { els[id] = makeEl(); els[id].id = id; }
  return els[id];
}

globalThis.document = {
  getElementById: byId,
  querySelectorAll: () => [],
  createElement: (tag) => makeEl(),
};
globalThis.window = { devicePixelRatio: 1, addEventListener() {} };
globalThis.localStorage = {
  _store: {},
  getItem(k) { return this._store[k] ?? null; },
  setItem(k, v) { this._store[k] = String(v); },
};
globalThis.fetch = async () => { throw new Error("net disabled"); };
globalThis.Blob = class { constructor() {} };
globalThis.URL = { createObjectURL: () => "", revokeObjectURL: () => {} };
globalThis.FileReader = class { readAsText(){} };

try {
  const url = pathToFileURL("C:\\Users\\liaof\\Desktop\\围棋AI学习助手-网页版\\public\\js\\app.js").href;
  await import(url + "?t=" + Date.now());
  console.log("app.js 顶层 + init() 执行成功，无运行时错误");
} catch (e) {
  console.log("app.js 运行时错误：");
  console.log(e && e.stack ? e.stack : e);
  process.exit(1);
}
