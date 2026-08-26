// 模型 slug: gpt-5.6-sol-xhigh-fast
'use strict';

/**
 * Round 3 端到端回归。
 *
 * 生产版本目前只有一名默认特工，也没有独立的 VICTORY 状态；因此这里把
 * 「选角」定义为从菜单确认默认 Player，把「胜利」定义为成功处决第五波 Boss。
 * 随后继续覆盖玩家死亡与结算界面，形成完整的主流程交叉验证。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const DT = 1 / 60;

function scriptsFromIndexHtml() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  return [...html.matchAll(/<script\s+src="([^"]+)"><\/script>/g)]
    .map((match) => match[1])
    .filter((source) => !/^https?:/.test(source));
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
    get(target, property) {
      if (property in target) return target[property];
      return typeof property === 'string' && /^[a-z]/.test(property) ? () => {} : 0;
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    },
  });
}

function createDom() {
  const elements = new Map();
  const context = createContext2D();

  function make(id) {
    const element = {
      id,
      style: {},
      dataset: {},
      hidden: false,
      disabled: false,
      textContent: '',
      width: 1280,
      height: 720,
      children: [],
      listeners: {},
      classList: {
        values: new Set(),
        add(name) { this.values.add(name); },
        remove(name) { this.values.delete(name); },
        toggle(name, enabled) {
          if (enabled === undefined) {
            this.values.has(name) ? this.values.delete(name) : this.values.add(name);
          } else if (enabled) {
            this.values.add(name);
          } else {
            this.values.delete(name);
          }
        },
        contains(name) { return this.values.has(name); },
      },
      appendChild(child) {
        element.children.push(child);
        child.parentElement = element;
        return child;
      },
      removeChild(child) {
        const index = element.children.indexOf(child);
        if (index >= 0) element.children.splice(index, 1);
        return child;
      },
      addEventListener(type, listener) {
        (element.listeners[type] || (element.listeners[type] = [])).push(listener);
      },
      removeEventListener() {},
      setAttribute(name, value) { element[name] = String(value); },
      removeAttribute(name) { delete element[name]; },
      getBoundingClientRect: () => ({
        width: 1280,
        height: 720,
        left: 0,
        top: 0,
      }),
      getContext: () => context,
      focus() {},
      blur() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      closest: () => null,
      parentElement: null,
      _fire(type, event = {}) {
        for (const listener of element.listeners[type] || []) listener(event);
      },
    };

    let html = '';
    Object.defineProperty(element, 'innerHTML', {
      get() { return html; },
      set(value) {
        html = String(value);
        if (!html) element.children.length = 0;
      },
    });
    return element;
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

  return { documentStub, elements };
}

function bootGame() {
  const { documentStub, elements } = createDom();
  const timers = new Map();
  let nextTimerId = 1;

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
    setTimeout(callback, delay = 0) {
      const id = nextTimerId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval,
    clearInterval,
    localStorage: {
      data: new Map(),
      getItem(key) { return this.data.has(key) ? this.data.get(key) : null; },
      setItem(key, value) { this.data.set(key, String(value)); },
      removeItem(key) { this.data.delete(key); },
    },
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
    navigator: { userAgent: 'node-round3-regression', maxTouchPoints: 0 },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    performance: { now: () => Date.now() },
  };
  win.window = win;
  win.self = win;
  win.globalThis = win;

  const context = vm.createContext(win);
  for (const source of scriptsFromIndexHtml()) {
    const filename = path.join(ROOT, source);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  }

  return {
    win,
    elements,
    flushTimers() {
      const pending = [...timers.values()].sort((left, right) => left.delay - right.delay);
      timers.clear();
      for (const timer of pending) timer.callback();
    },
  };
}

function updateUntil(game, predicate, maxFrames, message) {
  for (let frame = 0; frame < maxFrames; frame++) {
    game.engine.update(DT, DT);
    if (predicate()) return;
  }
  assert.fail(message);
}

test('主流程：菜单 → 默认角色 → 战斗 → 升级 → Boss 胜利 → 死亡结算', () => {
  const { win, elements, flushTimers } = bootGame();
  const game = win.game;
  assert.ok(game, '游戏入口应成功启动');
  assert.equal(game.engine.state, win.GameState.MENU);

  const menuActor = game.engine.player;
  elements.get('btn-start')._fire('click');

  const player = game.engine.player;
  assert.equal(game.engine.state, win.GameState.PLAYING);
  assert.ok(player instanceof win.Player, '确认菜单后应选择并创建默认蛋型特工');
  assert.notEqual(player, menuActor, '实战角色不应复用菜单装饰角色');
  assert.equal(game.weaponSystem.weapons.length, 1, '选角进入战斗后应配发初始武器');

  const target = game.spawner.spawnAt(80, 0, 'grunt');
  target.health = 1;
  target.maxHealth = 1;
  updateUntil(
    game,
    () => target.dead,
    240,
    '自动武器应在四秒内完成一次真实战斗击杀',
  );
  assert.ok(player.kills >= 1);
  assert.ok(game.weaponSystem.totalDamage > 0);

  const levelBefore = player.level;
  player.gainXp(player.xpToNext);
  assert.equal(game.engine.state, win.GameState.LEVELUP);
  assert.equal(player.level, levelBefore + 1);

  const cards = elements.get('upgrade-cards');
  assert.ok(cards.children.length > 0 && cards.children.length <= 3);
  cards.children[0]._fire('click');
  assert.equal(game.engine.state, win.GameState.PLAYING, '选完升级应回到战斗');

  for (const weapon of game.weaponSystem.weapons) weapon.cooldown = 999;
  game.spawner.wave = 4;
  game.spawner.waveTime = win.EnemySpawner.WAVE_DURATION - DT / 2;
  let bossVictory = false;
  game.engine.events.on('boss:qte:success', () => { bossVictory = true; });
  game.engine.update(DT, DT);

  const boss = game.spawner.boss;
  assert.ok(boss && boss.isBoss, '第五波应生成 Boss');
  assert.equal(game.spawner.wave, 5);

  boss.spawnGuard = 0;
  boss.health = boss.maxHealth * (win.Enemy.EXECUTE.threshold - 0.02);
  game.engine.update(DT, DT);
  assert.ok(boss.qte, 'Boss 低血量时应开启处决窗口');

  updateUntil(
    game,
    () => boss.qte.time / boss.qte.duration >= win.Enemy.EXECUTE.hitStart + 0.02,
    600,
    'Boss 处决环应能进入判定带',
  );
  game.input._pressedThisFrame.add('KeyE');
  game.engine.update(DT, DT);

  assert.equal(bossVictory, true, '判定带内按 E 应获得 Boss 战胜利');
  assert.equal(boss.dead, true);
  game.engine.update(DT, DT);
  assert.equal(game.spawner.boss, null, '胜利后刷怪器应清理 Boss 引用');

  player.takeDamage(1e9, { ignoreInvuln: true });
  assert.equal(player.isAlive, false);
  flushTimers();

  assert.equal(game.engine.state, win.GameState.DEAD);
  assert.equal(win.document.body.dataset.state, win.GameState.DEAD);
  assert.ok(elements.get('screen-gameover').classList.contains('is-visible'));
  assert.equal(Number(elements.get('result-level').textContent), player.level);
  assert.equal(Number(elements.get('result-kills').textContent), player.kills);
});

test('最终压测页提供结构化报告生成与 JSON 导出入口', () => {
  const html = fs.readFileSync(path.join(ROOT, 'tests/benchmark.html'), 'utf8');
  const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/);

  assert.ok(inlineScript, '压测页应包含内联执行脚本');
  assert.doesNotThrow(() => new vm.Script(inlineScript[1], {
    filename: 'tests/benchmark.inline.js',
  }));
  assert.match(html, /id="export-report"/);
  assert.match(html, /function buildFinalReport\(\)/);
  assert.match(html, /application\/json/);
  assert.match(html, /downloadFinalReport/);
  assert.match(html, /exportReport:\s*buildFinalReport/);
});
