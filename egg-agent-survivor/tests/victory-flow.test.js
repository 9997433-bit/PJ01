'use strict';

/**
 * Round 3 验收：胜利流程 / 主菜单角色选择 / 武器进化
 *
 * 与 boot.test.js 同一套最小浏览器环境：按 index.html 声明的顺序加载全部
 * 生产脚本，跑真实的 Game 装配，再对三大 R3 特性逐条验收：
 *   1. 15 分钟胜利条件 + 最终 Boss + VICTORY 状态 + 结算评级 S/A/B/C；
 *   2. 主菜单 4 个可选角色（不同初始属性/武器）；
 *   3. 武器进化配方（两把满级武器 → 进化武器）与进化图鉴 UI。
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
      style: { setProperty() {} },
      dataset: {},
      hidden: false,
      disabled: false,
      textContent: '',
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
      _fire(type, event = {}) {
        for (const fn of el.listeners[type] || []) fn(event);
      },
    };

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
  for (const relative of scriptsFromIndexHtml()) {
    const filename = path.join(ROOT, relative);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  }

  return { win, elements, ctx };
}

/** 把一把已持有的武器直接升到满级 */
function maxOut(weapons, id) {
  if (!weapons.has(id)) weapons.add(id);
  while (!weapons.isMaxed(id)) weapons.levelUp(id);
  return weapons.get(id);
}

/* ================================================================
 * 1. 胜利状态机
 * ================================================================ */

test('GameState 含 VICTORY，且状态迁移白名单正确', () => {
  const { win } = boot();
  const { GameState } = win.GameEngine;
  const engine = win.game.engine;

  assert.equal(GameState.VICTORY, 'victory');

  // MENU → VICTORY 非法
  assert.equal(engine.setState(GameState.VICTORY), false);
  assert.equal(engine.state, GameState.MENU);

  // PLAYING → VICTORY 合法
  assert.ok(engine.setState(GameState.PLAYING));
  assert.ok(engine.setState(GameState.VICTORY));

  // VICTORY → PLAYING（再来一局）与 VICTORY → MENU 均合法
  assert.ok(engine.setState(GameState.PLAYING));
  assert.ok(engine.setState(GameState.VICTORY));
  assert.ok(engine.setState(GameState.MENU));
});

test('主循环推进跨过 FINAL_BOSS_AT 时刻会自动召唤最终 Boss', () => {
  const { win } = boot();
  const game = win.game;
  game.startRun();

  const engine = game.engine;
  engine.elapsed = win.Game.FINAL_BOSS_AT - 0.05;

  const dt = 1 / 60;
  for (let i = 0; i < 12; i++) engine.update(dt, dt);

  assert.ok(game.finalBossSpawned, '越过时刻后应标记已召唤');
  assert.ok(game.spawner.finalBossAlive, '最终 Boss 应存活在场');
  const boss = game.spawner.finalBoss;
  assert.ok(boss.isBoss && boss.isFinalBoss, '最终 Boss 应同时具备 Boss 与 Final 标记');
  assert.equal(game.spawner.boss, boss, 'Boss 血条应指向最终 Boss');
  assert.ok(game.finalBossSpawnAt !== null, '应记录出场时刻用于速杀评分');
});

test('最终 Boss 在场时常规 Boss 波让位，不会同屏双 Boss', () => {
  const { win } = boot();
  const game = win.game;
  game.startRun();

  game.spawner.spawnFinalBoss();
  const finalBoss = game.spawner.finalBoss;
  assert.ok(finalBoss);

  game.spawner.wave = 30;
  game.spawner.spawnBoss();
  assert.equal(game.spawner.boss, finalBoss, '常规 Boss 不应顶掉最终 Boss');

  // 重复召唤最终 Boss 也应幂等
  assert.equal(game.spawner.spawnFinalBoss(), finalBoss);
});

test('胜利需要双条件：Boss 已死且撑满 15 分钟，二者缺一不可', () => {
  const { win } = boot();
  const { GameState } = win.GameEngine;
  const game = win.game;
  game.victoryDelay = 0; // 测试走同步路径
  game.startRun();

  const engine = game.engine;

  // 条件一未满足：只有时间到，Boss 未死
  engine.elapsed = win.Game.VICTORY_TIME;
  game._updateVictoryFlow();
  assert.ok(game.finalBossSpawned, '晚于出场时刻也要补召最终 Boss');
  assert.equal(engine.state, GameState.PLAYING, 'Boss 未死不能胜利');

  // 击杀最终 Boss → 双条件满足 → VICTORY
  game.spawner.finalBoss.kill();
  assert.ok(game.finalBossDown, '击杀事件应被胜利流程捕获');
  game._updateVictoryFlow();
  assert.equal(engine.state, GameState.VICTORY, '双条件满足应进入胜利结算');
});

test('Boss 提前阵亡时，胜利要等到 15 分钟整才宣布', () => {
  const { win } = boot();
  const { GameState } = win.GameEngine;
  const game = win.game;
  game.victoryDelay = 0;
  game.startRun();

  const engine = game.engine;
  engine.elapsed = win.Game.FINAL_BOSS_AT;
  game._updateVictoryFlow();
  game.spawner.finalBoss.kill();

  game._updateVictoryFlow();
  assert.equal(engine.state, GameState.PLAYING, '未到 15 分钟不能提前胜利');

  engine.elapsed = win.Game.VICTORY_TIME;
  game._updateVictoryFlow();
  assert.equal(engine.state, GameState.VICTORY);
});

test('玩家阵亡后胜利流程立即停摆，不会尸体通关', () => {
  const { win } = boot();
  const { GameState } = win.GameEngine;
  const game = win.game;
  game.victoryDelay = 0;
  game.startRun();

  const engine = game.engine;
  engine.elapsed = win.Game.FINAL_BOSS_AT;
  game._updateVictoryFlow();
  game.spawner.finalBoss.kill();

  engine.elapsed = win.Game.VICTORY_TIME;
  engine.player.health = 0; // 视为已阵亡
  game._updateVictoryFlow();
  assert.equal(engine.state, GameState.PLAYING, '死人不能触发胜利结算');
  assert.equal(game._victoryPending, false);
});

test('胜利结算：统计与评级写入 DOM，评级必为 S/A/B/C 之一', () => {
  const { win, elements } = boot();
  const { GameState } = win.GameEngine;
  const game = win.game;
  game.victoryDelay = 0;
  game.startRun();

  const engine = game.engine;
  const player = engine.player;
  player.kills = 640;
  player.level = 31;
  game.combo.best = 55;
  game.combo.score = 123456;

  engine.elapsed = win.Game.FINAL_BOSS_AT;
  game._updateVictoryFlow();
  game.spawner.finalBoss.kill(); // 这一杀本身也会计入连击得分
  engine.elapsed = win.Game.VICTORY_TIME;
  game._updateVictoryFlow();

  assert.equal(engine.state, GameState.VICTORY);
  assert.equal(elements.get('victory-kills').textContent, 641, '击杀数应含最终 Boss 这一杀');
  assert.equal(elements.get('victory-level').textContent, 31);
  assert.equal(elements.get('victory-combo').textContent, 55);
  assert.ok(game.combo.score > 123456, '击杀最终 Boss 应追加得分');
  assert.equal(elements.get('victory-score').textContent, game.combo.score);
  assert.equal(elements.get('victory-time').textContent, '15:00');
  assert.ok(['S', 'A', 'B', 'C'].includes(elements.get('victory-grade').textContent));
  assert.ok(game.lastVictory && game.lastVictory.points >= 0, '应缓存本局评级结果');
  assert.ok(game.bestTime >= win.Game.VICTORY_TIME, '通关时长应计入最佳记录');
});

test('胜利后可以再战一局，也可以返回主菜单', () => {
  const { win } = boot();
  const { GameState } = win.GameEngine;
  const game = win.game;
  game.victoryDelay = 0;
  game.startRun();

  const engine = game.engine;
  engine.elapsed = win.Game.FINAL_BOSS_AT;
  game._updateVictoryFlow();
  game.spawner.finalBoss.kill();
  engine.elapsed = win.Game.VICTORY_TIME;
  game._updateVictoryFlow();
  assert.equal(engine.state, GameState.VICTORY);

  // 再战一局：世界重置、胜利标记清零
  game.startRun();
  assert.equal(engine.state, GameState.PLAYING);
  assert.equal(engine.elapsed, 0);
  assert.equal(game.finalBossSpawned, false);
  assert.equal(game.finalBossDown, false);

  // 再打一次胜利 → 返回主菜单
  engine.elapsed = win.Game.FINAL_BOSS_AT;
  game._updateVictoryFlow();
  game.spawner.finalBoss.kill();
  engine.elapsed = win.Game.VICTORY_TIME;
  game._updateVictoryFlow();
  assert.equal(engine.state, GameState.VICTORY);
  game.toMenu();
  assert.equal(engine.state, GameState.MENU);
});

/* ================================================================
 * 2. 评级函数（纯函数边界）
 * ================================================================ */

test('rateRun：满指标拿 S，空局拿 C，评级单调不升', () => {
  const { win } = boot();
  const rate = win.VictoryScreen.rateRun;

  const perfect = rate({
    kills: 900, level: 40, bestCombo: 80, healthPercent: 1, bossClearSeconds: 30,
  });
  assert.equal(perfect.grade, 'S');
  assert.ok(perfect.points >= 85);

  const good = rate({
    kills: 620, level: 30, bestCombo: 45, healthPercent: 0.6, bossClearSeconds: 90,
  });
  assert.equal(good.grade, 'A');

  const okay = rate({
    kills: 480, level: 26, bestCombo: 32, healthPercent: 0.45, bossClearSeconds: 120,
  });
  assert.equal(okay.grade, 'B');

  const weak = rate({});
  assert.equal(weak.grade, 'C');

  // 单调性：任一指标变差，总分不应上升
  const worse = rate({
    kills: 620, level: 30, bestCombo: 45, healthPercent: 0.6, bossClearSeconds: 999,
  });
  assert.ok(worse.points <= good.points);
});

test('rateRun：非法输入不炸，速杀窗口边界正确', () => {
  const { win } = boot();
  const rate = win.VictoryScreen.rateRun;

  // 非法/缺省输入一律按 0 处理
  const junk = rate({ kills: NaN, level: -5, bestCombo: Infinity, healthPercent: 7 });
  assert.ok(Number.isFinite(junk.points));
  assert.ok(['S', 'A', 'B', 'C'].includes(junk.grade));

  const cfg = win.VictoryScreen.RATING.bossClear;
  const fast = rate({ bossClearSeconds: cfg.fast });
  const slow = rate({ bossClearSeconds: cfg.slow });
  const never = rate({ bossClearSeconds: Infinity });
  assert.equal(fast.breakdown.bossClear, cfg.max, '速杀窗口内应拿满分');
  assert.equal(slow.breakdown.bossClear, 0, '拖满窗口应为 0 分');
  assert.equal(never.breakdown.bossClear, 0);
});

/* ================================================================
 * 3. 主菜单角色选择
 * ================================================================ */

test('角色表：恰好 4 名角色，id 唯一，初始武器互不相同且真实存在', () => {
  const { win } = boot();
  const characters = win.Player.CHARACTERS;

  assert.equal(characters.length, 4);
  assert.equal(new Set(characters.map((c) => c.id)).size, 4, 'id 不可重复');
  assert.equal(new Set(characters.map((c) => c.weapon)).size, 4, '初始武器应互不相同');
  for (const character of characters) {
    assert.ok(win.WEAPONS[character.weapon], `初始武器 ${character.weapon} 必须在武器表里`);
    assert.ok(character.name && character.role && character.icon, '卡面文案字段齐全');
    assert.ok(Array.isArray(character.statMods), '属性修正必须是声明式数组');
  }
});

test('角色属性修正：壁垒更硬更慢，疾风更快更脆，未知 id 落回默认', () => {
  const { win } = boot();
  const Player = win.Player;
  const base = Player.BASE_STATS;

  const aegis = new Player(0, 0, 'aegis');
  assert.equal(aegis.stats.maxHealth, base.maxHealth + 60);
  assert.equal(aegis.stats.armor, base.armor + 3);
  assert.ok(aegis.stats.speed < base.speed, '壁垒应更慢');
  assert.equal(aegis.health, aegis.stats.maxHealth, '出场即满血');

  const gale = new Player(0, 0, 'gale');
  assert.ok(gale.stats.speed > base.speed, '疾风应更快');
  assert.ok(gale.stats.dashCooldown < base.dashCooldown, '疾风冲刺更勤');
  assert.ok(gale.stats.maxHealth < base.maxHealth, '疾风更脆');

  const fallback = new Player(0, 0, 'no-such-agent');
  assert.equal(fallback.characterId, Player.DEFAULT_CHARACTER, '未知 id 应落回默认角色');
  assert.equal(fallback.stats.maxHealth, base.maxHealth);
});

test('主菜单渲染 4 张角色卡，点击切换选中并持久化偏好', () => {
  const { win, elements } = boot();
  const game = win.game;
  const roster = elements.get('character-select');

  assert.equal(roster.children.length, 4, '主菜单应渲染 4 张角色卡');
  assert.ok(
    game._rosterCards.find((c) => c.id === game.selectedCharacter).el.classList.contains('is-selected'),
    '默认角色应有选中态'
  );

  // 点击第 3 张卡（疾风）
  const galeCard = game._rosterCards.find((c) => c.id === 'gale');
  galeCard.el._fire('click');
  assert.equal(game.selectedCharacter, 'gale');
  assert.ok(galeCard.el.classList.contains('is-selected'));
  assert.equal(win.localStorage.getItem('eas:character'), 'gale', '偏好应写入 localStorage');

  assert.equal(game.selectCharacter('not-a-character'), false, '非法 id 应被拒绝');
  assert.equal(game.selectedCharacter, 'gale');
});

test('选中的角色决定开局：属性修正生效且初始武器正确', () => {
  const { win } = boot();
  const game = win.game;

  game.selectCharacter('aegis');
  game.startRun();
  assert.equal(game.engine.player.characterId, 'aegis');
  assert.equal(game.engine.player.stats.armor, 3);
  assert.equal(game.weaponSystem.weapons.length, 1);
  assert.equal(game.weaponSystem.weapons[0].id, 'frostNova', '壁垒应以霜爆冲击开局');

  game.selectCharacter('blaze');
  game.startRun();
  assert.equal(game.weaponSystem.weapons[0].id, 'flamethrower', '燎原应以火焰喷射开局');
  assert.ok(game.engine.player.stats.damageMultiplier > 1, '燎原自带增伤');
});

test('角色偏好跨局生效：重启 Game 后仍是上次选的角色', () => {
  const { win } = boot();
  win.localStorage.setItem('eas:character', 'blaze');
  const rebooted = new win.Game();
  assert.equal(rebooted.selectedCharacter, 'blaze');
});

/* ================================================================
 * 4. 武器进化
 * ================================================================ */

test('进化配方表：源武器合法、进化武器已注册且不混入新武器卡池', () => {
  const { win } = boot();
  const { EVOLUTIONS, EVOLVED_WEAPONS } = win.UpgradeSystem;
  const registry = win.WeaponSystem.WEAPONS;
  const baseIds = win.WeaponSystem.IDS;

  assert.ok(EVOLUTIONS.length >= 3, '至少三条进化配方');

  const usedSources = new Set();
  for (const recipe of EVOLUTIONS) {
    assert.equal(recipe.sources.length, 2, '每条配方恰好两把源武器');
    for (const sourceId of recipe.sources) {
      assert.ok(baseIds.includes(sourceId), `源武器 ${sourceId} 必须是基础武器`);
      assert.ok(!usedSources.has(sourceId), `源武器 ${sourceId} 不应出现在多条配方里`);
      usedSources.add(sourceId);
    }

    const def = registry[recipe.id];
    assert.ok(def && def.isEvolved, `进化武器 ${recipe.id} 应注册进武器表`);
    assert.equal(def.maxLevel, 1, '进化武器是 maxLevel 1 的最终形态');
    assert.ok(!baseIds.includes(recipe.id), '进化武器不得进入「新武器」卡池快照');
    assert.ok(EVOLVED_WEAPONS[recipe.id], '配方与定义表一一对应');
  }

  // 六把基础武器全部有进化出路
  assert.equal(usedSources.size, baseIds.length, '所有基础武器都应被某条配方覆盖');
});

test('进化条件：两把源武器都满级才可进化，差一级都不行', () => {
  const { win } = boot();
  const game = win.game;
  game.startRun();

  const weapons = game.weaponSystem;
  weapons.weapons.length = 0;
  weapons.add('knifeOrbit');
  weapons.add('boomerang');

  maxOut(weapons, 'knifeOrbit');
  // boomerang 升到差一级
  while (weapons.get('boomerang').level < weapons.get('boomerang').def.maxLevel - 1) {
    weapons.levelUp('boomerang');
  }
  assert.equal(game.upgrades.availableEvolutions().length, 0, '差一级不可进化');

  weapons.levelUp('boomerang');
  const available = game.upgrades.availableEvolutions();
  assert.equal(available.length, 1);
  assert.equal(available[0].def.id, 'bladeMaelstrom');
});

test('执行进化：吞掉两把源武器、净腾出一个槽位、继承伤害统计', () => {
  const { win } = boot();
  const game = win.game;
  game.startRun();

  const weapons = game.weaponSystem;
  weapons.weapons.length = 0;
  const a = maxOut(weapons, 'magicBolt');
  const b = maxOut(weapons, 'chainBolt');
  a.damageDealt = 1200;
  b.damageDealt = 800;

  const evolved = game.upgrades.performEvolution('arcaneTempest');
  assert.ok(evolved, '进化应成功');
  assert.equal(evolved.id, 'arcaneTempest');
  assert.ok(!weapons.has('magicBolt') && !weapons.has('chainBolt'), '两把源武器应被吞掉');
  assert.equal(weapons.weapons.length, 1, '净占用从 2 槽变 1 槽');
  assert.equal(evolved.damageDealt, 2000, '伤害统计应继承');
  assert.equal(game.upgrades.evolutionCount, 1);

  // 已进化后不可重复进化
  assert.equal(game.upgrades.performEvolution('arcaneTempest'), null);
});

test('进化保底：配方凑齐后升级三选一必出进化卡', () => {
  const { win } = boot();
  const game = win.game;
  game.startRun();

  const weapons = game.weaponSystem;
  weapons.weapons.length = 0;
  maxOut(weapons, 'flamethrower');
  maxOut(weapons, 'frostNova');

  for (let i = 0; i < 8; i++) {
    const picked = game.upgrades.roll(3);
    assert.ok(
      picked.some((card) => card.kind === 'evolution'),
      `第 ${i + 1} 次抽卡应包含进化卡（保底）`
    );
  }

  // 选中进化卡走完整 apply 管线
  const card = game.upgrades.roll(3).find((c) => c.kind === 'evolution');
  game.upgrades.apply(card, game._upgradeContext());
  assert.ok(weapons.has('frostburnCataclysm'), '通过卡片应用也能完成进化');
});

test('进化武器有真实战斗力：冰火湮灭的灼烧力场能烧穿敌人', () => {
  const { win } = boot();
  const game = win.game;
  game.startRun();

  const engine = game.engine;
  const player = engine.player;
  player.stats.maxHealth = 1e7;
  player.health = 1e7;

  const weapons = game.weaponSystem;
  weapons.weapons.length = 0;
  const evolved = weapons.add('frostburnCataclysm');
  assert.ok(evolved, '进化武器可被直接装备');

  const enemy = new win.Enemy(90, 0, 'tank', 1);
  engine.addImmediate(enemy);
  const before = enemy.health;

  const dt = 1 / 60;
  for (let i = 0; i < 90 && !enemy.dead; i++) {
    player.moveInput.set(0, 0);
    engine.update(dt, dt);
  }

  assert.ok(enemy.dead || enemy.health < before, '力场应持续造成伤害');
  assert.ok(evolved.damageDealt > 0, '伤害应记入武器统计');
});

test('进化图鉴 UI：渲染全部配方，状态随收集进度流转', () => {
  const { win, elements } = boot();
  const game = win.game;
  game.startRun(); // 默认新星：只有 magicBolt

  const upgrades = game.upgrades;
  const container = elements.get('evolution-recipes');

  let rows = upgrades.renderRecipes(container);
  assert.equal(rows.length, win.UpgradeSystem.EVOLUTIONS.length, '图鉴应列出全部配方');
  assert.equal(container.children.length, rows.length);

  const arcane = () => upgrades.recipeProgress().find((r) => r.id === 'arcaneTempest');
  const blade = () => upgrades.recipeProgress().find((r) => r.id === 'bladeMaelstrom');
  assert.equal(arcane().state, 'progress', '持有一把源武器即为收集中');
  assert.equal(blade().state, 'locked', '两把都没有则未持有');

  const weapons = game.weaponSystem;
  maxOut(weapons, 'magicBolt');
  maxOut(weapons, 'chainBolt');
  assert.equal(arcane().state, 'ready', '双满级即可进化');

  upgrades.performEvolution('arcaneTempest');
  assert.equal(arcane().state, 'done', '进化完成后标记已进化');

  // 暂停面板打开时自动重画图鉴
  container.innerHTML = '';
  assert.equal(container.children.length, 0);
  game.engine.setState(win.GameState.PAUSED);
  assert.equal(container.children.length, rows.length, '切到暂停应触发图鉴重画');
});

/* ================================================================
 * 5. 装配完整性
 * ================================================================ */

test('index.html 装配顺序：进化/融合/胜利结算脚本齐备且次序正确', () => {
  const sources = scriptsFromIndexHtml();
  const indexOf = (name) => sources.findIndex((s) => s.endsWith(name));

  assert.ok(indexOf('ElementFusion.js') !== -1, 'R2 元素融合脚本必须被 index.html 引用');
  assert.ok(indexOf('VictoryScreen.js') !== -1, '胜利结算脚本必须被 index.html 引用');
  assert.ok(
    indexOf('WeaponSystem.js') < indexOf('UpgradeSystem.js'),
    '进化武器注册依赖武器表先加载'
  );
  assert.ok(
    indexOf('UpgradeSystem.js') < indexOf('ElementFusion.js'),
    '融合系统装饰升级系统，必须后加载'
  );
  assert.ok(indexOf('VictoryScreen.js') < indexOf('main.js'), '入口最后加载');
});

test('R2 融合系统随游戏装配启用（修复 index.html 漏引用的回归）', () => {
  const { win } = boot();
  const game = win.game;
  assert.ok(game.fusion, 'main.js 应装配 ElementFusion');
  assert.equal(game.engine.fusion, game.fusion);
  assert.ok(win.WeaponSystem.WEAPONS.steamVortex, '融合武器应注册进武器表');
});
