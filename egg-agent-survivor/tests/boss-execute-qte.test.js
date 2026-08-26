'use strict';

/**
 * Boss 处决 QTE 与屏外指示器
 *
 * QTE 是一段有时序的状态机：开窗 → 进判定带 → 命中 / 失手 / 超时，
 * 每条分支都会改动 Boss 的生死与数值，肉眼很难在浏览器里逐条走查。
 * 这里在最小浏览器环境里逐帧推进真实的 Enemy 逻辑，把四条分支各跑一遍。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

const SCRIPTS = [
  'js/utils/Vector2.js',
  'js/utils/ParticleSystem.js',
  'js/utils/Camera.js',
  'js/engine/EventBus.js',
  'js/engine/SpatialGrid.js',
  'js/engine/GameEngine.js',
  'js/entities/Entity.js',
  'js/entities/Player.js',
  'js/entities/Projectile.js',
  'js/entities/XpGem.js',
  'js/entities/Enemy.js',
  'js/systems/CollisionSystem.js',
  'js/ui/OffscreenIndicator.js',
];

const DT = 1 / 60;

/* ------------------------------------------------------------------ *
 * 最小浏览器环境
 * ------------------------------------------------------------------ */

function createContext2D() {
  const real = {
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }),
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

function createElementStub() {
  const el = {
    style: {}, dataset: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(child) { el.children.push(child); return child; },
    addEventListener() {}, removeEventListener() {}, setAttribute() {},
    getBoundingClientRect: () => ({ width: 1280, height: 720, left: 0, top: 0 }),
    focus() {}, blur() {},
    parentElement: null,
  };
  return el;
}

function createBrowserEnv() {
  const canvas = createElementStub();
  const ctx = createContext2D();
  canvas.getContext = () => ctx;
  canvas.width = 1280;
  canvas.height = 720;

  const win = {
    console,
    document: {
      readyState: 'complete', hidden: false,
      body: createElementStub(),
      getElementById: () => createElementStub(),
      createElement: () => createElementStub(),
      addEventListener() {}, removeEventListener() {},
    },
    devicePixelRatio: 1,
    innerWidth: 1280,
    innerHeight: 720,
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    setTimeout, clearTimeout,
    ResizeObserver: class { observe() {} disconnect() {} },
  };
  win.window = win;
  win.self = win;

  const context = vm.createContext(win);
  for (const relative of SCRIPTS) {
    const filename = path.join(ROOT, relative);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  }
  return { win, canvas, ctx };
}

/** 可编程的输入替身：测试直接往里塞「本帧按下了什么」 */
function createInputStub(win) {
  return {
    moveAxis: new win.Vector2(0, 0),
    pressed: new Set(),
    pointer: false,
    press(action) { this.pressed.add(action); },
    tap() { this.pointer = true; },
    wasPressed(action) { return this.pressed.has(action); },
    wasPointerPressed() { return this.pointer; },
    wasKeyPressed() { return false; },
    isDown() { return false; },
    update() { return this.moveAxis; },
    endFrame() { this.pressed.clear(); this.pointer = false; },
    reset() { this.pressed.clear(); this.pointer = false; },
  };
}

/** 一局只有玩家和一只 Boss 的战斗，Boss 血量已被压到开窗阈值以下 */
function createBossFight(options = {}) {
  const env = createBrowserEnv();
  const win = env.win;
  const input = createInputStub(win);

  const engine = new win.GameEngine(env.canvas, { input });
  const banners = [];
  engine.hud = { showBanner(text, tag) { banners.push({ text, tag }); } };
  engine.addSystem(new win.CollisionSystem());

  const events = [];
  for (const name of ['boss:qte:open', 'boss:qte:success', 'boss:qte:fail', 'enemy:died']) {
    engine.events.on(name, (payload) => events.push({ name, payload }));
  }

  const played = [];
  engine.audio = { play(name) { played.push(name); return true; } };

  const player = new win.Player(0, 0);
  player.stats.maxHealth = 1e6;
  player.health = 1e6;
  engine.player = player;
  engine.addImmediate(player);
  engine.camera.follow(player, true);

  const boss = new win.Enemy(options.bossX === undefined ? 220 : options.bossX, 0, 'boss', 5);
  boss.spawnGuard = 0;
  boss.spawnAnim = 1;
  if (options.lowHealth !== false) {
    boss.health = boss.maxHealth * (win.Enemy.EXECUTE.threshold - 0.02);
  }
  engine.addImmediate(boss);

  engine.setState(win.GameState.PLAYING);

  return { win, engine, player, boss, input, events, played, banners, ctx: env.ctx };
}

function step(fight, frames = 1) {
  for (let i = 0; i < frames; i++) fight.engine.update(DT, DT);
}

/** 推进到 QTE 进度落在 [from, to] 区间内，返回是否成功抵达 */
function advanceToProgress(fight, target) {
  const duration = fight.win.Enemy.EXECUTE.duration;
  for (let i = 0; i < 600; i++) {
    if (!fight.boss.qte) return false;
    if (fight.boss.qte.time / duration >= target) return true;
    step(fight);
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 开窗
 * ------------------------------------------------------------------ */

test('Boss 血量跌破阈值时开启处决窗口', () => {
  const fight = createBossFight();
  assert.equal(fight.boss.qte, null, '开局不应当就有窗口');

  step(fight);

  assert.ok(fight.boss.qte, '血量低于阈值应当开窗');
  assert.equal(fight.engine.activeExecute, fight.boss, '应当挂上全局的处决目标');
  assert.ok(fight.events.some((e) => e.name === 'boss:qte:open'), '应当广播开窗事件');
  assert.ok(fight.banners.some((b) => b.tag === '处决窗口'), '应当给玩家一条提示');
});

test('血量健康的 Boss 不会开窗', () => {
  const fight = createBossFight({ lowHealth: false });
  step(fight, 30);
  assert.equal(fight.boss.qte, null);
  assert.equal(fight.boss.executeUsed, false);
});

test('处决窗口期间 Boss 免疫伤害，也不再造成接触伤害', () => {
  const fight = createBossFight();
  step(fight);

  const before = fight.boss.health;
  assert.equal(fight.boss.takeDamage(99999, { ignoreArmor: true }), 0,
    '窗口里必须免伤，否则自动武器会抢在玩家按键前把 Boss 磨死');
  assert.equal(fight.boss.health, before);
  assert.equal(fight.boss.canTouch, false);
});

test('窗口期间 Boss 停止读招并刹停', () => {
  const fight = createBossFight();
  fight.boss.cast = 'radial';
  fight.boss.castTime = 5;
  fight.boss.velocity.set(400, 400);

  step(fight, 20);

  assert.equal(fight.boss.cast, null, '开窗要打断进行中的技能');
  assert.ok(fight.boss.velocity.length() < 1, '应当在原地刹停');
});

/* ------------------------------------------------------------------ *
 * 判定
 * ------------------------------------------------------------------ */

test('在判定带内按键 → 处决成功', () => {
  const fight = createBossFight();
  const EXECUTE = fight.win.Enemy.EXECUTE;
  step(fight);

  const baseXp = fight.boss.xpValue;
  assert.ok(advanceToProgress(fight, EXECUTE.hitStart + 0.05), '应当能推进到判定带内');
  assert.equal(fight.boss.qte.armed, true, '进入判定带后应当置位');

  fight.input.press('execute');
  step(fight);

  assert.equal(fight.boss.qte, null, '解算后窗口关闭');
  assert.equal(fight.boss.dead, true, '处决应当直接终结 Boss');
  assert.equal(fight.boss.health, 0);
  assert.equal(fight.engine.activeExecute, null, '全局引用要撤下');
  assert.ok(fight.events.some((e) => e.name === 'boss:qte:success'));
  assert.ok(fight.events.some((e) => e.name === 'enemy:died'));
  assert.ok(fight.boss.xpValue > baseXp, '处决应当给经验加成');
  assert.equal(fight.player.kills, 1);
});

test('点击与按键等效，触屏也能处决', () => {
  const fight = createBossFight();
  const EXECUTE = fight.win.Enemy.EXECUTE;
  step(fight);
  advanceToProgress(fight, EXECUTE.hitStart + 0.05);

  fight.input.tap();
  step(fight);

  assert.equal(fight.boss.dead, true);
  assert.ok(fight.events.some((e) => e.name === 'boss:qte:success'));
});

test('判定带之前抢按 → 失手并暴怒', () => {
  const fight = createBossFight();
  step(fight);

  const speed = fight.boss.speed;
  const damage = fight.boss.damage;
  const health = fight.boss.health;

  fight.input.press('execute');
  step(fight);

  assert.equal(fight.boss.qte, null);
  assert.equal(fight.boss.dead, false, '抢按不该白送人头');
  assert.equal(fight.boss.enraged, true);
  assert.ok(fight.boss.speed > speed, '暴怒要加速');
  assert.ok(fight.boss.damage > damage, '暴怒要加伤');
  assert.equal(fight.boss.health, health, '失手不改变血量');
  assert.ok(fight.events.some((e) => e.name === 'boss:qte:fail'));
});

test('判定带之后才按 → 同样算失手', () => {
  const fight = createBossFight();
  const EXECUTE = fight.win.Enemy.EXECUTE;
  step(fight);
  assert.ok(advanceToProgress(fight, EXECUTE.hitEnd + 0.05));

  fight.input.press('execute');
  step(fight);

  assert.equal(fight.boss.dead, false);
  assert.equal(fight.boss.enraged, true);
});

test('完全不按 → 超时失手，窗口自行关闭', () => {
  const fight = createBossFight();
  step(fight);

  const frames = Math.ceil(fight.win.Enemy.EXECUTE.duration / DT) + 10;
  step(fight, frames);

  assert.equal(fight.boss.qte, null, '超时后必须关窗，不能卡死在跪姿');
  assert.equal(fight.boss.dead, false);
  assert.equal(fight.boss.enraged, true);
  assert.equal(fight.engine.activeExecute, null);
});

test('一只 Boss 只有一次处决机会，失手后恢复正常 AI', () => {
  const fight = createBossFight();
  step(fight);
  fight.input.press('execute');
  step(fight);
  assert.equal(fight.boss.executeUsed, true);

  // 继续压血也不会二次开窗
  fight.boss.invulnerable = 0;
  fight.boss.takeDamage(fight.boss.health * 0.5, { ignoreArmor: true, silent: true });
  step(fight, 120);

  assert.equal(fight.boss.qte, null, '不应当二次开窗');
  assert.ok(fight.boss.velocity.length() > 1, '失手后 Boss 应当重新动起来');
});

test('QTE 期间播放提示音，成功时不吞掉击杀音', () => {
  const fight = createBossFight();
  const EXECUTE = fight.win.Enemy.EXECUTE;
  step(fight);
  advanceToProgress(fight, EXECUTE.hitStart + 0.02);

  assert.ok(fight.played.includes('qteTick'), '进入判定带应当有提示音');

  fight.input.press('execute');
  step(fight);
  assert.ok(fight.played.includes('bossDie'), 'Boss 死亡音仍要照常播放');
});

test('收缩环半径单调递减，判定带落在环的行程内', () => {
  const { win } = createBrowserEnv();
  const EXECUTE = win.Enemy.EXECUTE;
  const ring = win.Enemy.executeRingScale;

  assert.equal(ring(0), EXECUTE.outerRadius);
  assert.equal(ring(1), EXECUTE.innerRadius);
  assert.ok(ring(0.3) > ring(0.7), '环必须持续收缩');
  assert.ok(ring(EXECUTE.hitStart) > ring(EXECUTE.hitEnd), '判定带要有宽度');
  assert.ok(EXECUTE.hitEnd < 1, '判定带不能贴着窗口末尾，否则等同于「按到底」');
});

test('清场时撤下全局处决引用', () => {
  const fight = createBossFight();
  step(fight);
  assert.equal(fight.engine.activeExecute, fight.boss);

  fight.engine.resetWorld();
  assert.equal(fight.engine.activeExecute, null);
});

test('绘制处决窗口不抛异常', () => {
  const fight = createBossFight();
  step(fight, 40);
  assert.ok(fight.boss.qte);
  fight.engine.render();
});

/* ------------------------------------------------------------------ *
 * 屏外指示器
 * ------------------------------------------------------------------ */

function createIndicatorScene() {
  const env = createBrowserEnv();
  const win = env.win;
  const engine = new win.GameEngine(env.canvas, {});
  engine.hud = { showBanner() {} };
  engine.addSystem(new win.CollisionSystem());
  const indicator = engine.addSystem(new win.OffscreenIndicator());

  const player = new win.Player(0, 0);
  engine.player = player;
  engine.addImmediate(player);
  engine.camera.follow(player, true);
  engine.camera.update(DT);
  engine.setState(win.GameState.PLAYING);

  return { win, engine, player, indicator, ctx: env.ctx };
}

test('屏外的 Boss 与精英会生成箭头，屏内的不会', () => {
  const scene = createIndicatorScene();
  const { win, engine, indicator } = scene;

  const farBoss = new win.Enemy(6000, 0, 'boss', 5);
  const farElite = new win.Enemy(0, -5000, 'tank', 5, { elite: true });
  const nearBoss = new win.Enemy(40, 20, 'boss', 5);
  for (const e of [farBoss, farElite, nearBoss]) {
    e.spawnAnim = 1;
    engine.addImmediate(e);
  }

  indicator.update(DT, engine);
  // snapshot 来自 vm 上下文，转回本 realm 的数组才能做严格比较
  const kinds = Array.from(indicator.snapshot().arrows, (a) => a.kind).sort();

  assert.deepEqual(kinds, ['boss', 'elite'], '只有看不见的高价值目标需要指示');
});

test('处决窗口中的屏外 Boss 升级为最高优先级的箭头', () => {
  const scene = createIndicatorScene();
  const { win, engine, indicator } = scene;

  const boss = new win.Enemy(6000, 0, 'boss', 5);
  boss.spawnAnim = 1;
  boss.qte = { time: 0, duration: 2.8, armed: false };
  engine.addImmediate(boss);

  indicator.update(DT, engine);
  assert.deepEqual(Array.from(indicator.snapshot().arrows, (a) => a.kind), ['execute']);
});

test('屏外杂兵只进压力热区，不会刷出一屏箭头', () => {
  const scene = createIndicatorScene();
  const { win, engine, indicator } = scene;

  for (let i = 0; i < 40; i++) {
    const enemy = new win.Enemy(1200, i * 4 - 80, 'grunt', 3);
    enemy.spawnAnim = 1;
    engine.addImmediate(enemy);
  }

  indicator.update(DT, engine);
  const snapshot = indicator.snapshot();

  assert.equal(snapshot.arrows.length, 0, '杂兵不逐个画箭头');
  assert.equal(snapshot.offscreenEnemies, 40);
  const loudest = snapshot.pressure.indexOf(Math.max(...snapshot.pressure));
  assert.equal(loudest, win.OffscreenIndicator.binFor(0), '压力应当集中在右侧方位');
});

test('箭头数量受 maxArrows 限制', () => {
  const scene = createIndicatorScene();
  const { win, engine } = scene;
  const indicator = new win.OffscreenIndicator({ maxArrows: 3 });
  indicator.onAdd(engine);

  for (let i = 0; i < 10; i++) {
    const elite = new win.Enemy(3000 + i * 40, 0, 'tank', 5, { elite: true });
    elite.spawnAnim = 1;
    engine.addImmediate(elite);
  }

  indicator.update(DT, engine);
  assert.equal(indicator.targets.length, 3);
});

test('边缘交点始终落在内缩矩形的边界上', () => {
  const { win } = createBrowserEnv();
  const edgePoint = win.OffscreenIndicator.edgePoint;
  const halfW = 600;
  const halfH = 320;

  for (let i = 0; i < 64; i++) {
    const angle = (i / 64) * Math.PI * 2;
    const p = edgePoint(640, 360, Math.cos(angle) * 5000, Math.sin(angle) * 5000, halfW, halfH);
    const dx = Math.abs(p.x - 640);
    const dy = Math.abs(p.y - 360);
    assert.ok(dx <= halfW + 1e-6 && dy <= halfH + 1e-6, `交点 (${dx}, ${dy}) 跑出了矩形`);
    assert.ok(Math.abs(dx - halfW) < 1e-6 || Math.abs(dy - halfH) < 1e-6, '交点必须贴在边上');
  }
});

test('绘制指示器不抛异常，且在菜单状态下静默', () => {
  const scene = createIndicatorScene();
  const { win, engine, indicator } = scene;

  const boss = new win.Enemy(6000, 3000, 'boss', 5);
  boss.spawnAnim = 1;
  engine.addImmediate(boss);
  for (let i = 0; i < 30; i++) {
    const grunt = new win.Enemy(-1400, i * 6, 'grunt', 3);
    grunt.spawnAnim = 1;
    engine.addImmediate(grunt);
  }

  indicator.update(DT, engine);
  engine.render();

  engine.setState(win.GameState.MENU);
  let drawn = 0;
  const counting = new Proxy({}, { get: () => { drawn++; return () => {}; } });
  indicator.drawScreen(counting, engine);
  assert.equal(drawn, 0, '菜单状态不应当画任何东西');
});
