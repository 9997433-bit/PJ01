'use strict';

/**
 * 战斗系统集成冒烟测试
 *
 * 在 Node 里用一个最小浏览器环境跑真实的游戏脚本，逐帧推进引擎，
 * 验证「刷怪 → 自动开火 → 击杀 → 掉宝石 → 拾取升级」这条闭环真的跑通，
 * 并确保绘制路径不会抛异常。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

/** 按 index.html 的顺序加载（跳过需要真实 DOM 事件的输入与界面层） */
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
  'js/systems/WeaponSystem.js',
  'js/systems/EnemySpawner.js',
  'js/systems/UpgradeSystem.js',
];

/* ------------------------------------------------------------------ *
 * 最小浏览器环境
 * ------------------------------------------------------------------ */

function createGradient() {
  return { addColorStop() {} };
}

/** 记录所有调用但什么都不画的 2D 上下文 */
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
      // 未知的绘图方法一律当作空操作，属性读取返回 0
      return typeof prop === 'string' && /^[a-z]/.test(prop) ? () => {} : 0;
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
}

function createElementStub() {
  const el = {
    style: {},
    dataset: {},
    hidden: false,
    disabled: false,
    textContent: '',
    innerHTML: '',
    children: [],
    classList: {
      add() {}, remove() {}, toggle() {}, contains: () => false,
    },
    appendChild(child) { el.children.push(child); return child; },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getBoundingClientRect: () => ({ width: 1280, height: 720 }),
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

  const documentStub = {
    readyState: 'complete',
    hidden: false,
    body: createElementStub(),
    getElementById: () => createElementStub(),
    createElement: () => createElementStub(),
    addEventListener() {},
    removeEventListener() {},
  };

  const win = {
    console,
    document: documentStub,
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
function createGame(options = {}) {
  const env = createBrowserEnv();
  const win = env.win;

  const engine = new win.GameEngine(env.canvas, {});
  engine.hud = { showBanner() {} };

  const collisions = engine.addSystem(new win.CollisionSystem());
  const weapons = engine.addSystem(new win.WeaponSystem());
  const spawner = engine.addSystem(new win.EnemySpawner());
  const upgrades = engine.addSystem(new win.UpgradeSystem({ weapons }));

  engine.resetWorld();

  const player = new win.Player(0, 0);
  engine.player = player;
  engine.addImmediate(player);
  engine.camera.follow(player, true);

  // 测试里让玩家足够耐打，才能观察到中后期波次
  if (options.immortal !== false) {
    player.stats.maxHealth = 1e7;
    player.health = 1e7;
  }

  engine.setState(win.GameState.PLAYING);

  return { win, engine, player, collisions, weapons, spawner, upgrades, ctx: env.ctx };
}

/**
 * 逐帧推进。
 * @param {object} game
 * @param {number} seconds 模拟时长
 * @param {(game:object, frame:number) => void} [onFrame]
 */
function simulate(game, seconds, onFrame) {
  const dt = 1 / 60;
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) {
    // 绕圈走位，既触发移动相关逻辑，也避免站桩被围死
    const t = i * dt;
    game.player.moveInput.set(Math.cos(t * 0.7), Math.sin(t * 0.9));
    game.engine.update(dt, dt);
    if (onFrame) onFrame(game, i);
  }
}

/** 自动选第一张升级卡，模拟玩家一直在做三选一 */
function autoPickUpgrades(game) {
  let picks = 0;
  game.engine.events.on('player:levelup', ({ levels }) => {
    for (let i = 0; i < levels; i++) {
      const choices = game.upgrades.roll(3);
      assert.ok(choices.length > 0, '升级时必须至少有一个可选项');
      game.upgrades.apply(choices[0], {
        player: game.player,
        engine: game.engine,
        weapons: game.weapons,
      });
      picks++;
    }
  });
  return () => picks;
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

test('系统装配后互相挂载正确', () => {
  const game = createGame();
  assert.equal(game.engine.combat, game.collisions);
  assert.equal(game.engine.weapons, game.weapons);
  assert.equal(game.engine.spawner, game.spawner);
  assert.equal(game.engine.upgrades, game.upgrades);
  // 开局自带一把武器，否则玩家永远打不死第一只怪
  assert.equal(game.weapons.weapons.length, 1);
});

test('战斗闭环：刷怪 → 自动开火 → 击杀 → 掉宝石 → 升级', () => {
  const game = createGame();
  const getPicks = autoPickUpgrades(game);

  let projectilesSeen = 0;
  let gemsCollected = 0;
  game.engine.events.on('gem:collected', () => { gemsCollected++; });

  simulate(game, 60, (g) => {
    projectilesSeen += g.engine.countByTag('projectile');
  });

  assert.ok(game.spawner.totalSpawned > 30,
    `应当持续刷怪，实际只刷了 ${game.spawner.totalSpawned} 只`);
  assert.ok(projectilesSeen > 0, '武器应当自动开火产生弹道');
  assert.ok(game.player.kills > 0,
    `武器应当能击杀敌人，实际击杀 ${game.player.kills}`);
  assert.ok(gemsCollected > 0, '击杀后应当掉落并被拾取到经验宝石');
  assert.ok(game.player.level > 1,
    `拾取经验后应当升级，实际等级 ${game.player.level}`);
  assert.ok(getPicks() > 0, '升级应当触发三选一');
  assert.ok(game.weapons.totalDamage > 0, '武器应当记录到造成的伤害');
});

test('波次随时间推进，同屏敌人不超过硬上限', () => {
  const game = createGame();
  autoPickUpgrades(game);

  let peak = 0;
  simulate(game, 95, (g) => {
    peak = Math.max(peak, g.engine.countByTag('enemy'));
  });

  // 每 30 秒一波，95 秒后应当进入第 4 波
  assert.equal(game.spawner.wave, 4, `95 秒后应当是第 4 波，实际 ${game.spawner.wave}`);
  assert.ok(peak <= game.win.EnemySpawner.HARD_CAP,
    `同屏敌人 ${peak} 超过了硬上限 ${game.win.EnemySpawner.HARD_CAP}`);
});

test('第 5 波出现 Boss，且带阶段信息', () => {
  const game = createGame();
  autoPickUpgrades(game);

  let bossSeen = null;
  game.engine.events.on('wave:boss', (boss) => { bossSeen = boss; });

  simulate(game, 125);

  assert.ok(bossSeen, '第 5 波应当触发 Boss');
  assert.equal(bossSeen.typeKey, 'boss');
  assert.ok(bossSeen.maxHealth > 1000, 'Boss 血量应当远高于杂兵');
});

test('六把武器都能装备并正常开火', () => {
  const game = createGame();
  const ids = game.win.WeaponSystem.IDS;
  assert.equal(ids.length, 6);

  for (const id of ids) game.weapons.add(id);
  assert.equal(game.weapons.weapons.length, 6);

  // 先攒一批敌人，确保需要目标的武器（闪电链、霜爆）能真正走到伤害分支
  for (let i = 0; i < 40; i++) {
    const angle = (i / 40) * Math.PI * 2;
    game.spawner.spawnAt(Math.cos(angle) * 90, Math.sin(angle) * 90, 'grunt');
  }

  simulate(game, 12);

  for (const weapon of game.weapons.weapons) {
    assert.ok(weapon.damageDealt > 0,
      `武器「${weapon.def.name}」在 12 秒内没有造成任何伤害`);
  }
});

test('武器升级会提升数值，且不会超过最大等级', () => {
  const game = createGame();
  const weapon = game.weapons.add('chainBolt');
  const baseDamage = weapon.stats.damage;

  game.weapons.levelUp('chainBolt');
  assert.ok(weapon.stats.damage > baseDamage, '升级后伤害应当提高');
  assert.equal(weapon.level, 2);

  for (let i = 0; i < 30; i++) game.weapons.levelUp('chainBolt');
  assert.equal(weapon.level, weapon.def.maxLevel, '等级应当卡在上限');
  assert.ok(game.weapons.isMaxed('chainBolt'));
});

test('升级卡池：满级武器与堆满的被动会退出卡池', () => {
  const game = createGame();
  const upgrades = game.upgrades;

  const before = upgrades.buildPool();
  assert.ok(before.some((c) => c.kind === 'weaponNew'), '有空槽时应当能刷出新武器');

  // 塞满 6 个武器槽后，新武器卡应当消失
  for (const id of game.win.WeaponSystem.IDS) game.weapons.add(id);
  const after = upgrades.buildPool();
  assert.ok(!after.some((c) => c.kind === 'weaponNew'), '槽位满后不应再刷新武器卡');

  // 把某个被动堆到上限
  const passive = game.win.UpgradeSystem.PASSIVES.find((p) => p.id === 'p_amount');
  for (let i = 0; i < passive.maxStacks; i++) {
    upgrades.apply(
      { id: passive.id, kind: 'passive', apply: passive.apply },
      { player: game.player, engine: game.engine, weapons: game.weapons }
    );
  }
  assert.ok(!upgrades.buildPool().some((c) => c.id === passive.id), '堆满的被动应当退出卡池');
  assert.equal(game.player.stats.extraProjectiles, passive.maxStacks);
});

test('重随与消除各自消耗次数并刷新选项', () => {
  const game = createGame();
  const upgrades = game.upgrades;

  upgrades.roll(3);
  assert.equal(upgrades.rerolls, 1);
  assert.ok(upgrades.reroll(), '第一次重随应当成功');
  assert.equal(upgrades.rerolls, 0);
  assert.equal(upgrades.reroll(), null, '次数用完后重随应当失败');

  const target = upgrades.choices[0];
  assert.ok(upgrades.banish(target), '第一次消除应当成功');
  assert.ok(upgrades.banished.has(target.id));
  assert.ok(!upgrades.buildPool().some((c) => c.id === target.id), '被消除的卡不应再出现');
});

test('伤害结算：护甲减伤、击退与状态效果', () => {
  const game = createGame();
  const win = game.win;

  const tank = new win.Enemy(200, 0, 'tank', 1);
  game.engine.addImmediate(tank);
  const armor = tank.armor;
  assert.ok(armor > 0, '重甲蛋应当有护甲');

  const dealt = tank.takeDamage(20, { knockback: 300, angle: 0 });
  assert.equal(Math.round(dealt), 20 - armor, '护甲应当按固定值减伤');
  // 击退抗性很高，但不应该完全为零
  assert.ok(tank.knockback.x > 0 && tank.knockback.x < 300, '击退应当被抗性削弱');

  // 护甲不应让小伤害完全归零，至少保留 15%
  const chip = tank.takeDamage(1, {});
  assert.ok(chip > 0, '高护甲也不能完全免疫伤害');

  tank.applyBurn(10, 2);
  tank.applySlow(0.5, 2);
  assert.ok(tank.burn && tank.slow);
  const before = tank.health;
  tank.update(0.5, game.engine);
  assert.ok(tank.health < before, '灼烧应当持续掉血');

  // 更强的减速覆盖更弱的，反之只续时间
  tank.applySlow(0.3, 1);
  assert.equal(tank.slow.mult, 0.3);
  tank.applySlow(0.9, 5);
  assert.equal(tank.slow.mult, 0.3, '更弱的减速不应覆盖更强的');
});

test('弹道穿透：同一目标只结算一次，穿透耗尽后销毁', () => {
  const game = createGame();
  const win = game.win;

  const projectile = new win.Projectile({ x: 0, y: 0, damage: 5, pierce: 1 });
  const a = new win.Enemy(10, 0, 'grunt', 1);
  const b = new win.Enemy(20, 0, 'grunt', 1);

  assert.ok(projectile.canHit(a, 0));
  assert.equal(projectile.registerHit(a, 0), false, '还有穿透次数时不应销毁');
  assert.equal(projectile.canHit(a, 0), false, '同一目标不应被重复命中');
  assert.equal(projectile.registerHit(b, 0), true, '穿透耗尽后应当销毁');
});

test('回旋镖对同一目标有重复命中冷却', () => {
  const game = createGame();
  const win = game.win;

  const boomerang = new win.Projectile({ kind: 'boomerang', damage: 5, reHitDelay: 0.3 });
  const enemy = new win.Enemy(10, 0, 'grunt', 1);

  assert.ok(boomerang.canHit(enemy, 0));
  boomerang.registerHit(enemy, 0);
  assert.equal(boomerang.canHit(enemy, 0.1), false, '冷却内不应再次命中');
  assert.ok(boomerang.canHit(enemy, 0.4), '冷却结束后应当可以再次命中');
});

test('范围查询：圆形与扇形都能正确筛选目标', () => {
  const game = createGame();
  const win = game.win;
  const combat = game.collisions;

  game.spawner.spawnAt(100, 0, 'grunt');    // 正右方
  game.spawner.spawnAt(-100, 0, 'grunt');   // 正左方
  game.spawner.spawnAt(0, 600, 'grunt');    // 远处
  game.engine._flush();
  combat.update(1 / 60, game.engine);

  assert.equal(combat.queryCircle(0, 0, 200).length, 2, '圆形查询应当排除远处目标');

  const cone = combat.queryCone(0, 0, 0, 0.4, 200);
  assert.equal(cone.length, 1, '扇形只应命中正前方目标');
  assert.ok(cone[0].position.x > 0);

  const nearest = combat.nearestEnemy(90, 0, 400);
  assert.ok(nearest && nearest.position.x === 100);
  assert.equal(combat.nearestEnemy(0, 0, 10), null, '范围内没有目标时应返回 null');
});

test('敌人成长曲线随波次单调递增', () => {
  const game = createGame();
  const win = game.win;

  const early = new win.Enemy(0, 0, 'grunt', 1);
  const late = new win.Enemy(0, 0, 'grunt', 15);
  assert.ok(late.maxHealth > early.maxHealth * 3, '后期血量应当显著更高');
  assert.ok(late.damage > early.damage);

  const elite = new win.Enemy(0, 0, 'grunt', 1, { elite: true });
  assert.ok(elite.maxHealth > early.maxHealth * 4, '精英应当有更高血量');
  assert.ok(elite.xpValue > early.xpValue, '精英应当掉落更多经验');
  assert.ok(elite.radius > early.radius);
});

test('渲染路径不抛异常（含 Boss、状态效果与所有武器特效）', () => {
  const game = createGame();
  for (const id of game.win.WeaponSystem.IDS) game.weapons.add(id);

  game.spawner.spawnAt(60, 0, 'boss');
  for (const type of ['grunt', 'runner', 'swarm', 'tank', 'spitter', 'bomber']) {
    game.spawner.spawnAt(70, 40, type, { elite: true });
  }
  game.engine._flush();
  for (const enemy of game.engine.getByTag('enemy')) {
    enemy.applyBurn(5, 5);
    enemy.applySlow(0.6, 5);
  }

  simulate(game, 6);
  assert.doesNotThrow(() => {
    game.engine.render();
    game.engine.render();
  });
});

test('掉落物在超时后自动消失，避免实体无限堆积', () => {
  const game = createGame();
  const win = game.win;

  const gem = new win.XpGem(5000, 5000, 1);   // 远离玩家，不会被吸走
  game.engine.addImmediate(gem);
  gem.update(100, game.engine);
  assert.ok(gem.dead, '长时间未拾取的宝石应当自动消失');
});
