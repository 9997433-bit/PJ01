'use strict';

/**
 * 启动冒烟测试
 *
 * 直接按 index.html 声明的顺序加载全部脚本（含 InputManager / HUD / main.js），
 * 在最小浏览器环境里跑一遍真实的启动流程，确保：
 *   1. 页面加载不抛异常、不落进 #boot-error 分支；
 *   2. 「开始任务」后引擎进入 PLAYING 且各系统互相挂好；
 *   3. index.html 里引用的脚本文件都真实存在（防止改名后漏改引用）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

/** 从 index.html 里按顺序抽出本地脚本路径 */
function scriptsFromIndexHtml() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const sources = [];
  const pattern = /<script\s+src="([^"]+)"><\/script>/g;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    if (!/^https?:/.test(match[1])) sources.push(match[1]);
  }
  return sources;
}

function createGradient() {
  return { addColorStop() {} };
}

function createContext2D() {
  const real = {
    createRadialGradient: createGradient,
    createLinearGradient: createGradient,
    createPattern: () => null,
    measureText: () => ({ width: 10 }),
    save() {}, restore() {},
  };
  return new Proxy(real, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return typeof prop === 'string' && /^[a-z]/.test(prop) ? () => {} : 0;
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
}

/** 元素按 id 缓存，便于测试结束后回查内容 */
function createDom() {
  const elements = new Map();
  const ctx = createContext2D();

  function make(id) {
    const el = {
      id,
      style: {},
      dataset: {},
      hidden: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      width: 1280,
      height: 720,
      children: [],
      listeners: {},
      classList: {
        _set: new Set(),
        add(c) { this._set.add(c); },
        remove(c) { this._set.delete(c); },
        toggle(c, on) { if (on === undefined) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); } else if (on) this._set.add(c); else this._set.delete(c); },
        contains(c) { return this._set.has(c); },
      },
      appendChild(child) { el.children.push(child); return child; },
      removeChild(child) {
        const i = el.children.indexOf(child);
        if (i >= 0) el.children.splice(i, 1);
        return child;
      },
      addEventListener(type, fn) { (el.listeners[type] || (el.listeners[type] = [])).push(fn); },
      removeEventListener() {},
      setAttribute() {},
      removeAttribute() {},
      getBoundingClientRect: () => ({ width: 1280, height: 720, left: 0, top: 0 }),
      getContext: () => ctx,
      focus() {}, blur() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      parentElement: null,
      /** 触发已注册的监听器，用来模拟点击 */
      _fire(type, event = {}) {
        for (const fn of el.listeners[type] || []) fn(event);
      },
    };
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
    createElement: () => make('created'),
    addEventListener() {},
    removeEventListener() {},
  };

  return { documentStub, elements, ctx };
}

function boot() {
  const { documentStub, elements, ctx } = createDom();

  const win = {
    console,
    document: documentStub,
    devicePixelRatio: 1,
    innerWidth: 1280,
    innerHeight: 720,
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    localStorage: {
      _data: new Map(),
      getItem(k) { return this._data.has(k) ? this._data.get(k) : null; },
      setItem(k, v) { this._data.set(k, String(v)); },
      removeItem(k) { this._data.delete(k); },
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

  return { win, elements, ctx, loaded };
}

/* ------------------------------------------------------------------ */

test('index.html 引用的脚本文件都存在', () => {
  const sources = scriptsFromIndexHtml();
  assert.ok(sources.length > 10, '脚本清单看起来不完整');
  for (const relative of sources) {
    assert.ok(
      fs.existsSync(path.join(ROOT, relative)),
      `index.html 引用了不存在的脚本：${relative}`
    );
  }
});

test('index.html 按依赖顺序加载：实体先于系统，入口最后', () => {
  const sources = scriptsFromIndexHtml();
  const indexOf = (name) => sources.findIndex((s) => s.endsWith(name));

  assert.ok(indexOf('Vector2.js') < indexOf('Entity.js'), '数学库要先于实体');
  assert.ok(indexOf('GameEngine.js') < indexOf('Entity.js'), 'Entity 依赖 GameEngine 导出的 Layer');
  assert.ok(indexOf('Entity.js') < indexOf('Enemy.js'), 'Enemy 继承 Entity');
  assert.ok(indexOf('Projectile.js') < indexOf('Enemy.js'), 'Enemy 会发射 Projectile');
  assert.ok(indexOf('XpGem.js') < indexOf('Enemy.js'), 'Enemy 死亡会掉落 XpGem');
  assert.ok(indexOf('WeaponSystem.js') < indexOf('UpgradeSystem.js'), '升级卡池依赖武器表');
  assert.ok(indexOf('main.js') === sources.length - 1, '入口必须最后加载');
});

test('页面启动不报错，进入主菜单', () => {
  const { win, elements } = boot();

  const bootError = elements.get('boot-error');
  assert.ok(!bootError || !bootError.textContent, `启动失败：${bootError && bootError.textContent}`);
  assert.ok(win.game, '应当挂载全局 game 实例');
  assert.equal(win.game.engine.state, win.GameState.MENU);
});

test('开始任务后引擎进入战斗状态，战斗系统全部挂载', () => {
  const { win } = boot();
  const game = win.game;

  game.startRun();

  assert.equal(game.engine.state, win.GameState.PLAYING);
  assert.ok(game.engine.player, '应当创建玩家');
  assert.ok(game.engine.combat, 'CollisionSystem 应当挂到 engine.combat');
  assert.ok(game.engine.weapons, 'WeaponSystem 应当挂到 engine.weapons');
  assert.ok(game.engine.spawner, 'EnemySpawner 应当挂到 engine.spawner');
  assert.ok(game.engine.upgrades, 'UpgradeSystem 应当挂到 engine.upgrades');
  assert.equal(game.weaponSystem.weapons.length, 1, '开局应当自带一把武器');
  assert.equal(game.spawner.wave, 1);
});

test('从启动到实际战斗：跑 40 秒后有击杀与升级', () => {
  const { win } = boot();
  const game = win.game;
  game.startRun();

  const player = game.engine.player;
  player.stats.maxHealth = 1e7;
  player.health = 1e7;

  const dt = 1 / 60;
  for (let i = 0; i < 40 * 60; i++) {
    player.moveInput.set(Math.cos(i * dt * 0.7), Math.sin(i * dt * 0.9));
    game.engine.update(dt, dt);
  }

  assert.ok(game.spawner.totalSpawned > 20, '应当持续刷怪');
  assert.ok(player.kills > 0, '自动武器应当产生击杀');
  assert.ok(player.level > 1, '应当通过拾取经验升级');
});

test('升级面板：切到 LEVELUP 状态并渲染出三张卡', () => {
  const { win, elements } = boot();
  const game = win.game;
  game.startRun();

  // 直接灌满经验触发升级，避免依赖随机战斗过程
  game.engine.player.gainXp(10000);

  assert.equal(game.engine.state, win.GameState.LEVELUP, '升级时应当暂停并弹出面板');
  const cards = elements.get('upgrade-cards');
  assert.ok(cards.children.length > 0 && cards.children.length <= 3, '应当渲染 1~3 张卡');

  // 点第一张卡，队列清空后应当回到战斗
  const before = game.pendingLevelUps;
  assert.ok(before > 0);
  cards.children[0]._fire('click');
  assert.ok(game.pendingLevelUps < before, '选择后应当消费掉一次升级');
});
