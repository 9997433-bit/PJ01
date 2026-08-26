'use strict';

/**
 * 连击 / Fever / 打击感反馈的行为测试
 *
 * 复用与战斗测试同一套最小浏览器环境，额外加载 ComboSystem 与 JuiceSystem，
 * 覆盖三件容易回归的事：
 *   1. 连击计数与倍率档位、窗口超时断连、同一敌人不重复计数；
 *   2. Fever 的进入 / 退出条件，以及它给武器的加成「只生效一次」；
 *   3. 演出层的节流上限（定格冷却、闪白层数、粒子池降级）与渲染安全。
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
  'js/ui/FloatingText.js',
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
  'js/systems/WeaponSystem.js',
  'js/systems/EnemySpawner.js',
  'js/systems/UpgradeSystem.js',
  'js/systems/ComboSystem.js',
  'js/systems/JuiceSystem.js',
];

/* ------------------------------------------------------------------ *
 * 最小浏览器环境
 * ------------------------------------------------------------------ */

function createGradient() {
  return { addColorStop() {} };
}

function createContext2D() {
  const real = {
    createRadialGradient: createGradient,
    createLinearGradient: createGradient,
    measureText: () => ({ width: 10 }),
    canvas: null,
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
    style: {},
    dataset: {},
    textContent: '',
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(child) { el.children.push(child); return child; },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getBoundingClientRect: () => ({ width: 1280, height: 720 }),
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
      readyState: 'complete',
      hidden: false,
      body: createElementStub(),
      getElementById: () => createElementStub(),
      createElement: () => createElementStub(),
      addEventListener() {},
      removeEventListener() {},
    },
    devicePixelRatio: 1,
    innerWidth: 1280,
    innerHeight: 720,
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    setTimeout,
    clearTimeout,
    ResizeObserver: class { observe() {} disconnect() {} },
  };
  win.window = win;
  win.self = win;
  win.globalThis = win;

  const context = vm.createContext(win);
  for (const relative of SCRIPTS) {
    const filename = path.join(ROOT, relative);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  }

  return { win, canvas, ctx };
}

/** 装配一局游戏，系统顺序与 main.js 保持一致 */
function createGame() {
  const env = createBrowserEnv();
  const win = env.win;

  const engine = new win.GameEngine(env.canvas, {});
  engine.hud = { showBanner() {} };

  const collisions = engine.addSystem(new win.CollisionSystem());
  const weapons = engine.addSystem(new win.WeaponSystem());
  const spawner = engine.addSystem(new win.EnemySpawner());
  const upgrades = engine.addSystem(new win.UpgradeSystem({ weapons }));
  const combo = engine.addSystem(new win.ComboSystem());
  const juice = engine.addSystem(new win.JuiceSystem());

  engine.resetWorld();

  const player = new win.Player(0, 0);
  engine.player = player;
  engine.addImmediate(player);
  engine.camera.follow(player, true);
  player.stats.maxHealth = 1e7;
  player.health = 1e7;

  engine.setState(win.GameState.PLAYING);

  return {
    win, engine, player, collisions, weapons, spawner, upgrades, combo, juice, ctx: env.ctx,
  };
}

/** 造一只挂在引擎上的敌人并直接打死，走的是真实的 enemy:died 路径 */
function killOne(game, typeKey = 'grunt') {
  const enemy = new game.win.Enemy(600, 600, typeKey, 1);
  game.engine.addImmediate(enemy);
  enemy.takeDamage(enemy.maxHealth * 10, { silent: true });
  return enemy;
}

function killMany(game, count, typeKey) {
  for (let i = 0; i < count; i++) killOne(game, typeKey);
}

/* ------------------------------------------------------------------ *
 * 连击
 * ------------------------------------------------------------------ */

test('击杀累加连击，倍率按档位从 1x 爬到 5x', () => {
  const game = createGame();
  const combo = game.combo;

  assert.equal(combo.count, 0);
  assert.equal(combo.multiplier, 1);

  killOne(game);
  assert.equal(combo.count, 1);
  assert.equal(combo.multiplier, 1, '第一杀还在最低档');

  killMany(game, 4);
  assert.equal(combo.count, 5);
  assert.equal(combo.multiplier, 2, '5 连击进入第二档');

  killMany(game, 7);
  assert.equal(combo.count, 12);
  assert.equal(combo.multiplier, 3);

  killMany(game, 8);
  assert.equal(combo.count, 20);
  assert.equal(combo.multiplier, 4);

  killMany(game, 10);
  assert.equal(combo.multiplier, 5, '倍率封顶在 5x');
  assert.equal(combo.best, combo.count);
});

test('同一只敌人只计一次连击', () => {
  const game = createGame();
  const enemy = killOne(game);
  assert.equal(game.combo.count, 1);

  // 直接重复调用（模拟事件与武器两条路径同时上报）
  game.combo.registerKill(enemy, 'magicBolt');
  game.combo.registerKill(enemy, 'magicBolt');
  assert.equal(game.combo.count, 1, '重复上报不应重复计数');
});

test('被静默回收的敌人不算连击', () => {
  const game = createGame();
  const enemy = new game.win.Enemy(600, 600, 'grunt', 1);
  game.engine.addImmediate(enemy);
  enemy.despawn();

  game.combo.registerKill(enemy);
  assert.equal(game.combo.count, 0, 'despawn 是超出上限的静默剔除，不是击杀');
});

test('窗口耗尽后断连，且窗口随连击数收窄', () => {
  const game = createGame();
  const combo = game.combo;

  killOne(game);
  const wideWindow = combo.window;
  killMany(game, 29);
  assert.ok(combo.fever, '30 连击应当已经进入 Fever');
  combo.endFever();

  killMany(game, 20);
  assert.ok(combo.window < wideWindow, '连击越高窗口越短');

  let broken = null;
  game.engine.events.on('combo:break', (payload) => { broken = payload; });

  // 推进到超过整个窗口，中间不再击杀
  combo.update(combo.window + 0.01);
  assert.equal(combo.count, 0);
  assert.equal(combo.multiplier, 1);
  assert.ok(broken && broken.count === 20, 'combo:break 应当带上断掉时的连击数');
});

test('得分按倍率结算，倍率越高单杀越值钱', () => {
  const game = createGame();
  const combo = game.combo;

  const first = combo.registerKill({ xpValue: 10 });
  assert.ok(first > 0);

  // 直接把连击顶到最高档，再比同一种敌人的入账
  combo.count = 29;
  const topTier = combo.registerKill({ xpValue: 10 });
  assert.ok(topTier > first * 2, `高倍率单杀应当明显更值钱：${first} → ${topTier}`);
  assert.equal(combo.score, first + topTier);
});

/* ------------------------------------------------------------------ *
 * Fever
 * ------------------------------------------------------------------ */

test('30 连击触发 Fever：倍率锁死、窗口冻结、到时自动退出并清零连击', () => {
  const game = createGame();
  const combo = game.combo;

  const events = [];
  game.engine.events.on('fever:start', (p) => events.push(['start', p]));
  game.engine.events.on('fever:end', (p) => events.push(['end', p]));

  killMany(game, 29);
  assert.equal(combo.fever, false, '差一杀时还不该触发');

  killOne(game);
  assert.equal(combo.fever, true);
  assert.equal(combo.multiplier, 5);
  assert.equal(events.length, 1);
  assert.equal(events[0][0], 'start');

  // Fever 期间窗口冻结：远超窗口长度也不会断连
  combo.update(combo.feverDuration - 0.5);
  assert.equal(combo.fever, true, 'Fever 期间连击不会因为超时断掉');
  assert.equal(combo.timeRatio, 1);

  combo.update(1);
  assert.equal(combo.fever, false);
  assert.equal(combo.count, 0, 'Fever 结束后连击清零，节奏重新起步');
  assert.equal(combo.multiplier, 1);
  assert.equal(events.length, 2);
  assert.equal(events[1][0], 'end');
});

test('Fever 期间武器获得增伤与射速加成，且退出后立刻恢复', () => {
  const game = createGame();
  const combo = game.combo;

  assert.equal(combo.damageBonus, 1);
  assert.equal(combo.cooldownScale, 1);
  assert.equal(game.weapons.feverDamage, 1);

  combo.startFever();
  assert.ok(combo.damageBonus > 1, 'Fever 应当增伤');
  assert.ok(combo.cooldownScale < 1, 'Fever 应当提高射速');
  assert.equal(game.weapons.feverDamage, combo.damageBonus);

  combo.endFever();
  assert.equal(game.weapons.feverDamage, 1);
});

test('Fever 增伤在直伤与弹道各只乘一次', () => {
  const game = createGame();
  const weapon = game.weapons.get('magicBolt');
  const target = new game.win.Enemy(300, 0, 'grunt', 1);
  game.engine.addImmediate(target);
  target.maxHealth = 1e9;
  target.health = 1e9;

  // 直伤路径：dealDamage 的返回值就是实际打进去的数字
  const plain = game.weapons.dealDamage(weapon, target, 100, { silent: true });
  game.combo.startFever();
  const fevered = game.weapons.dealDamage(weapon, target, 100, { silent: true });
  const ratio = fevered / plain;
  assert.ok(
    Math.abs(ratio - game.combo.damageBonus) < 1e-9,
    `直伤应当恰好乘一次 Fever 加成，实际 ${ratio}`
  );

  // 弹道路径：伤害在出膛时定死
  const projectile = game.weapons.spawn(game.engine, { x: 0, y: 0, damage: 100 });
  assert.ok(
    Math.abs(projectile.damage / 100 - game.combo.damageBonus) < 1e-9,
    '弹道伤害也应当只乘一次'
  );
});

test('重开一局会清空连击、得分与 Fever 状态', () => {
  const game = createGame();
  killMany(game, 32);
  assert.ok(game.combo.fever);
  assert.ok(game.combo.score > 0);

  game.engine.resetWorld();

  assert.equal(game.combo.count, 0);
  assert.equal(game.combo.best, 0);
  assert.equal(game.combo.score, 0);
  assert.equal(game.combo.fever, false);
});

/* ------------------------------------------------------------------ *
 * 打击感
 * ------------------------------------------------------------------ */

test('命中定格有冷却：密集击杀不会把游戏顿成幻灯片', () => {
  const game = createGame();
  const juice = game.juice;

  assert.equal(juice.hitStop(0.1), true, '第一次应当真的定格');
  assert.equal(juice.hitStop(0.1), false, '冷却内的定格请求应当被丢弃');

  juice.updateAlways(game.win.JuiceSystem.HITSTOP_COOLDOWN + 0.01);
  assert.equal(juice.hitStop(0.1), true, '冷却结束后可以再次定格');

  // 单次定格时长有上限，否则一发大招能把画面冻住半秒
  game.engine.hitStop = 0;
  juice.updateAlways(1);
  juice.hitStop(10);
  assert.ok(game.engine.hitStop <= game.win.JuiceSystem.HITSTOP_MAX);
});

test('屏幕闪色层数有上限，弱光不会顶掉强光', () => {
  const game = createGame();
  const juice = game.juice;
  const max = game.win.JuiceSystem.MAX_FLASHES;

  for (let i = 0; i < max * 3; i++) juice.flash('#ffffff', 0.5, 0.3);
  assert.equal(juice.flashes.length, max, `同时最多叠 ${max} 层`);

  assert.equal(juice.flash('#ffffff', 0.05, 0.3), null, '更弱的闪光不应挤掉已有图层');
  const strong = juice.flash('#ff0000', 0.95, 0.3);
  assert.ok(strong, '更强的闪光应当顶掉最弱的一层');
  assert.equal(juice.flashes.length, max);

  juice.updateAlways(1);
  assert.equal(juice.flashes.length, 0, '过期图层应当被回收');
});

test('伤害飘字：字号随伤害增长，暴击带标记，非正数不出字', () => {
  const game = createGame();
  const juice = game.juice;
  const texts = game.engine.floatingText;
  const active = () => texts.items.filter((i) => i.active);

  texts.clear();
  juice.damageNumber(0, 0, 0);
  juice.damageNumber(0, 0, -5);
  assert.equal(active().length, 0, '零伤害与负伤害不应该弹字');

  juice.damageNumber(0, 0, 7);
  juice.damageNumber(0, 0, 9999);
  const items = active();
  assert.equal(items.length, 2);
  assert.ok(items[1].size > items[0].size, '大伤害的字应当更大');

  texts.clear();
  juice.damageNumber(0, 0, 50, { critical: true });
  assert.match(active()[0].text, /!$/, '暴击数字应当带感叹号');
});

test('击杀爆炸会补粒子，但粒子池吃紧时自动降级', () => {
  const game = createGame();
  const particles = game.engine.particles;

  particles.clear();
  const enemy = new game.win.Enemy(0, 0, 'grunt', 1);
  game.engine.addImmediate(enemy);
  game.juice.killBurst(enemy);
  particles.update(0);   // activeCount 只在 update 里重算
  assert.ok(particles.activeCount > 0, '击杀应当补上爆炸粒子');

  // 把池子灌满到只剩不到 12% 余量，此时应当完全跳过
  particles.clear();
  for (let i = 0; i < particles.capacity * 0.95; i++) particles.emit({ life: 10 });
  particles.update(0);
  const before = particles.activeCount;
  game.juice.killBurst(enemy);
  particles.update(0);
  assert.equal(particles.activeCount, before, '池子快满时不应再追加爆炸粒子');
});

/* ------------------------------------------------------------------ *
 * 集成
 * ------------------------------------------------------------------ */

test('真实战斗里连击会随击杀增长，且得分与击杀数同步', () => {
  const game = createGame();
  const dt = 1 / 60;
  for (let i = 0; i < 60 * 60; i++) {
    game.player.moveInput.set(Math.cos(i * dt * 0.7), Math.sin(i * dt * 0.9));
    game.engine.update(dt, dt);
  }

  assert.ok(game.player.kills > 0, '前置条件：这一局要真的打死过怪');
  assert.ok(game.combo.best > 1, `应当攒出过连击，实际最高 ${game.combo.best}`);
  assert.ok(game.combo.score > 0, '应当累计到得分');
  assert.ok(game.combo.best <= game.player.kills, '连击数不可能超过总击杀数');
});

test('渲染路径不抛异常（Fever 全屏特效 + 屏幕闪色）', () => {
  const game = createGame();
  killMany(game, 30);
  assert.ok(game.combo.fever);

  // 让淡入过渡走到中途与终点，两种分支都画一遍
  game.combo.updateAlways(0.05);
  game.juice.flash('#ffffff', 0.8, 0.4);
  assert.doesNotThrow(() => game.engine.render());

  game.combo.updateAlways(1);
  assert.doesNotThrow(() => game.engine.render());

  game.combo.endFever();
  game.combo.updateAlways(1);
  assert.doesNotThrow(() => game.engine.render());
});
