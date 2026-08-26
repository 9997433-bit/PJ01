'use strict';

/**
 * 极简浏览器环境，用来在 Node 里跑真实的 index.html 启动流程。
 *
 * 只实现生产代码真正碰到的那部分 DOM / BOM：元素按 id 记账，事件监听器可回放，
 * innerHTML 清空会连子节点一起丢掉（否则反复重绘的容器会把历史节点攒死）。
 * 需要断言 CSS 自定义属性的用例不少，所以 style 实现了 setProperty/getPropertyValue，
 * 而不是退化成普通对象。
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');

/** 按 index.html 的声明顺序取出本地脚本 */
function scriptsFromIndexHtml() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  return [...html.matchAll(/<script\s+src="([^"]+)"><\/script>/g)]
    .map((match) => match[1])
    .filter((source) => !/^https?:/.test(source));
}

function createStyle() {
  const custom = new Map();
  return {
    setProperty(name, value) { custom.set(name, String(value)); },
    getPropertyValue(name) { return custom.has(name) ? custom.get(name) : ''; },
    removeProperty(name) { custom.delete(name); },
  };
}

function createContext2D() {
  const real = {
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createPattern: () => null,
    measureText: () => ({ width: 10 }),
    save() {},
    restore() {},
  };
  return new Proxy(real, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return typeof prop === 'string' && /^[a-z]/.test(prop) ? () => {} : 0;
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
}

function createDom() {
  const elements = new Map();
  const ctx = createContext2D();

  function make(id) {
    const el = {
      id,
      tagName: 'DIV',
      style: createStyle(),
      dataset: {},
      attributes: {},
      hidden: false,
      disabled: false,
      textContent: '',
      width: 1280,
      height: 720,
      children: [],
      listeners: {},
      parentElement: null,
      classList: {
        _set: new Set(),
        add(name) { this._set.add(name); },
        remove(name) { this._set.delete(name); },
        toggle(name, on) {
          if (on === undefined) {
            if (this._set.has(name)) this._set.delete(name);
            else this._set.add(name);
          } else if (on) this._set.add(name);
          else this._set.delete(name);
        },
        contains(name) { return this._set.has(name); },
        get value() { return [...this._set].join(' '); },
      },
      appendChild(child) {
        el.children.push(child);
        child.parentElement = el;
        return child;
      },
      removeChild(child) {
        const index = el.children.indexOf(child);
        if (index >= 0) el.children.splice(index, 1);
        return child;
      },
      addEventListener(type, fn) { (el.listeners[type] || (el.listeners[type] = [])).push(fn); },
      removeEventListener() {},
      setAttribute(name, value) { el.attributes[name] = String(value); },
      getAttribute(name) { return el.attributes[name]; },
      removeAttribute(name) { delete el.attributes[name]; },
      getBoundingClientRect: () => ({ width: 1280, height: 720, left: 0, top: 0 }),
      getContext: () => ctx,
      focus() {}, blur() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      closest: () => null,
      /** 回放已注册的监听器，用来模拟点击 */
      _fire(type, event = {}) {
        for (const fn of el.listeners[type] || []) fn(event);
      },
    };

    // className 与 classList 双向同步：生产代码两种写法都在用
    let className = '';
    Object.defineProperty(el, 'className', {
      get() { return className; },
      set(value) {
        className = String(value);
        el.classList._set = new Set(className.split(/\s+/).filter(Boolean));
      },
    });

    let html = '';
    Object.defineProperty(el, 'innerHTML', {
      get() { return html; },
      set(value) {
        html = String(value);
        if (!html) el.children.length = 0;
      },
    });

    return el;
  }

  const documentStub = {
    readyState: 'complete',
    hidden: false,
    body: make('body'),
    documentElement: make('html'),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, make(id));
      return elements.get(id);
    },
    createElement: (tag) => {
      const el = make('created');
      el.tagName = String(tag || 'div').toUpperCase();
      return el;
    },
    addEventListener() {},
    removeEventListener() {},
  };

  return { documentStub, elements, ctx, make };
}

/** 按 index.html 的顺序加载全部脚本，返回启动后的沙箱 */
function bootGame() {
  const { documentStub, elements, ctx } = createDom();
  const windowListeners = new Map();
  const timers = new Map();
  let nextTimerId = 1;

  const win = {
    console,
    document: documentStub,
    devicePixelRatio: 1,
    innerWidth: 1280,
    innerHeight: 720,
    addEventListener(type, fn) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = windowListeners.get(type) || [];
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    setTimeout(callback, delay = 0) {
      const id = nextTimerId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval: () => 0,
    clearInterval() {},
    localStorage: {
      _data: new Map(),
      getItem(key) { return this._data.has(key) ? this._data.get(key) : null; },
      setItem(key, value) { this._data.set(key, String(value)); },
      removeItem(key) { this._data.delete(key); },
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    navigator: { userAgent: 'node', maxTouchPoints: 0 },
    ResizeObserver: class { observe() {} disconnect() {} },
    performance: { now: () => Date.now() },
  };
  win.window = win;
  win.self = win;

  const context = vm.createContext(win);
  const loaded = [];
  for (const relative of scriptsFromIndexHtml()) {
    const filename = path.join(ROOT, relative);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    loaded.push(relative);
  }

  return {
    win,
    ctx,
    elements,
    loaded,
    get game() { return win.game; },
    el(id) { return documentStub.getElementById(id); },
    fireWindow(type, event = {}) {
      for (const fn of windowListeners.get(type) || []) fn(event);
    },
    /** 模拟一次完整按键（按下 + 抬起），preventDefault 由 InputManager 调用 */
    pressKey(code) {
      const event = { code, repeat: false, preventDefault() {} };
      this.fireWindow('keydown', event);
      return event;
    },
    releaseKey(code) {
      this.fireWindow('keyup', { code });
    },
    flushTimers() {
      const pending = [...timers.values()].sort((a, b) => a.delay - b.delay);
      timers.clear();
      for (const timer of pending) timer.callback();
    },
  };
}

/** 深度优先找出所有 class 命中的后代节点 */
function findByClass(root, className) {
  const out = [];
  const walk = (node) => {
    for (const child of node.children || []) {
      if (child.classList && child.classList.contains(className)) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

module.exports = {
  ROOT,
  bootGame,
  createDom,
  findByClass,
  scriptsFromIndexHtml,
};
