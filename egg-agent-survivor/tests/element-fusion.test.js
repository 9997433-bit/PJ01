'use strict';

/**
 * 元素融合系统测试
 *
 * 在 Node VM 里加载生产脚本（Vector2 → WeaponSystem → ElementFusion），
 * 用最小引擎桩验证四层契约：
 *   1. 内嵌配置快照与 js/data/fusion-weapons.json 逐字段一致（防止双源漂移）；
 *   2. 反应表完整：5 元素两两组合 10 条反应，处理器齐备、消耗合法；
 *   3. 融合武器与元素对一一对应，行为原型都真实存在；
 *   4. 融合检测 / 执行 / 印记与反应运行时的核心逻辑正确。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

const SCRIPTS = [
  'js/utils/Vector2.js',
  'js/systems/WeaponSystem.js',
  'js/systems/ElementFusion.js',
];

function loadSandbox() {
  const sandbox = { console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of SCRIPTS) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
  }
  return sandbox;
}

function loadJsonConfig() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'js/data/fusion-weapons.json'), 'utf8'));
}

/** VM realm 里的对象/数组原型与本 realm 不同，比较前先做 JSON 归一化 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 最小引擎桩：只提供 ElementFusion 与 WeaponSystem 实际触碰的接口 */
function stubEngine(sandbox, weapons) {
  const engine = {
    elapsed: 0,
    player: {
      isAlive: true,
      position: { x: 0, y: 0 },
      stats: {
        damageMultiplier: 1, cooldownMultiplier: 1, areaMultiplier: 1,
        projectileSpeedMultiplier: 1, durationMultiplier: 1,
        extraProjectiles: 0, critChance: 0, critMultiplier: 2, luck: 0,
      },
      heal() {},
    },
    events: { emitted: [], emit(name, payload) { this.emitted.push({ name, payload }); }, on() {} },
    particles: { burst() {}, shockwave() {}, emit() {} },
    floatingText: { spawn() {} },
    camera: { addTrauma() {}, isVisible: () => true },
    combat: {
      forEachInCircle() {},
      queryCircle: () => [],
      nearestEnemy: () => null,
      strongestEnemy: () => null,
      randomEnemy: () => null,
    },
    freeze() {},
    hud: null,
    upgrades: null,
    weapons,
  };
  weapons.engine = engine;
  return engine;
}

function stubEnemy() {
  return {
    dead: false,
    position: { x: 100, y: 0 },
    radius: 12,
    maxHealth: 100,
    slow: null,
    burn: null,
    kbResist: 0,
    damageTaken: 0,
    takeDamage(amount) { this.damageTaken += amount; return amount; },
    applyBurn() {},
    applySlow(mult, time) { this.slow = { mult, time }; },
  };
}

const ELEMENT_IDS = ['fire', 'frost', 'volt', 'venom', 'light'];

/* ================= 数据层 ================= */

test('内嵌配置快照与 fusion-weapons.json 逐字段一致', () => {
  const sandbox = loadSandbox();
  assert.deepEqual(
    plain(sandbox.ElementFusion.DEFAULT_CONFIG),
    loadJsonConfig(),
    'js/systems/ElementFusion.js 的 DEFAULT_CONFIG 与 js/data/fusion-weapons.json 出现漂移，请同步两者'
  );
});

test('反应表覆盖全部 10 个元素对，处理器与消耗合法', () => {
  const sandbox = loadSandbox();
  const { DEFAULT_CONFIG, REACTIONS, pairKey } = sandbox.ElementFusion;

  assert.deepEqual(Object.keys(DEFAULT_CONFIG.elements).sort(), [...ELEMENT_IDS].sort());

  const expectedPairs = [];
  for (let i = 0; i < ELEMENT_IDS.length; i++) {
    for (let j = i + 1; j < ELEMENT_IDS.length; j++) {
      expectedPairs.push(pairKey(ELEMENT_IDS[i], ELEMENT_IDS[j]));
    }
  }
  assert.equal(expectedPairs.length, 10);
  assert.deepEqual(Object.keys(DEFAULT_CONFIG.reactions).sort(), expectedPairs.sort());

  const seenIds = new Set();
  for (const [key, cfg] of Object.entries(DEFAULT_CONFIG.reactions)) {
    const [a, b] = key.split('+');
    assert.equal(pairKey(a, b), key, `反应键 ${key} 必须按字典序`);
    assert.equal(typeof REACTIONS[cfg.id], 'function', `反应 ${cfg.id} 缺少处理器`);
    assert.ok(!seenIds.has(cfg.id), `反应 id 重复: ${cfg.id}`);
    seenIds.add(cfg.id);
    assert.ok(cfg.cooldown > 0, `反应 ${cfg.id} 需要正冷却`);
    for (const el of Object.keys(cfg.consume)) {
      assert.ok(el === a || el === b, `反应 ${cfg.id} 消耗了不相关元素 ${el}`);
    }
  }
});

test('融合武器与元素对一一对应，原型与等级数据合法', () => {
  const sandbox = loadSandbox();
  const { DEFAULT_CONFIG, ARCHETYPES, pairKey } = sandbox.ElementFusion;

  const weapons = Object.entries(DEFAULT_CONFIG.weapons);
  assert.equal(weapons.length, 10, '每个元素对应当恰好有一把融合武器');

  const usedPairs = new Set();
  for (const [id, cfg] of weapons) {
    assert.equal(cfg.elements.length, 2, `${id} 必须绑定两个元素`);
    const [a, b] = cfg.elements;
    assert.notEqual(a, b, `${id} 的两个元素不能相同`);
    assert.ok(DEFAULT_CONFIG.elements[a] && DEFAULT_CONFIG.elements[b], `${id} 引用了未知元素`);

    const key = pairKey(a, b);
    assert.ok(DEFAULT_CONFIG.reactions[key], `${id} 的元素对 ${key} 没有对应反应`);
    assert.ok(!usedPairs.has(key), `元素对 ${key} 被多把融合武器占用`);
    usedPairs.add(key);

    assert.ok(ARCHETYPES[cfg.archetype], `${id} 使用了未实现的原型 ${cfg.archetype}`);
    assert.ok(cfg.maxLevel >= 1);
    assert.equal(cfg.levelText.length, cfg.maxLevel + 1, `${id} 的 levelText 长度应为 maxLevel+1`);
    assert.ok(cfg.base.damage > 0, `${id} 缺少基础伤害`);
  }

  for (const [weaponId, element] of Object.entries(DEFAULT_CONFIG.weaponElements)) {
    assert.ok(
      element === null || DEFAULT_CONFIG.elements[element],
      `${weaponId} 绑定了未知元素 ${element}`
    );
  }
});

/* ================= 运行时层 ================= */

test('融合武器注册进 WEAPONS 但不进 IDS（不会混入新武器卡池）', () => {
  const sandbox = loadSandbox();
  const weapons = new sandbox.WeaponSystem();
  const fusion = new sandbox.ElementFusion({ weapons });
  fusion.onAdd(stubEngine(sandbox, weapons));

  assert.ok(sandbox.WeaponSystem.WEAPONS.steamVortex, '融合武器应注册进 WEAPONS');
  assert.ok(sandbox.WeaponSystem.WEAPONS.steamVortex.isFusion);
  assert.ok(!sandbox.WeaponSystem.IDS.includes('steamVortex'), 'IDS 快照不应包含融合武器');
  assert.equal(sandbox.WeaponSystem.WEAPONS.flamethrower.element, 'fire', '基础武器应被打上元素标签');
  assert.equal(sandbox.WeaponSystem.WEAPONS.boomerang.element, null, '回旋蛋镖保持无元素');
});

test('融合检测：双源达到解锁线才出现，执行后吞源换融合武器', () => {
  const sandbox = loadSandbox();
  const weapons = new sandbox.WeaponSystem();
  const fusion = new sandbox.ElementFusion({ weapons });
  const engine = stubEngine(sandbox, weapons);
  fusion.onAdd(engine);

  weapons.add('flamethrower');
  weapons.add('frostNova');
  assert.equal(fusion.availableFusions().length, 0, '等级不足时不应出现融合');

  const unlock = fusion.config.fusion.unlockLevel;
  while (weapons.get('flamethrower').level < unlock) weapons.levelUp('flamethrower');
  while (weapons.get('frostNova').level < unlock) weapons.levelUp('frostNova');

  const available = fusion.availableFusions();
  assert.deepEqual(plain(available.map((c) => c.id)), ['steamVortex'], '火5+冰5 只应解锁蒸汽奇点');

  const cards = fusion.buildFusionCards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, 'fusion');
  assert.equal(cards[0].rarity, 'legendary');
  assert.equal(typeof cards[0].desc(), 'string');

  const before = weapons.weapons.length;
  const weapon = fusion.performFusion('steamVortex');
  assert.ok(weapon, '融合应成功执行');
  assert.equal(weapon.id, 'steamVortex');
  assert.equal(weapon.level, 1, '双源恰好等于解锁线时不结转额外等级');
  assert.ok(!weapons.has('flamethrower') && !weapons.has('frostNova'), '源武器应被吞掉');
  assert.equal(weapons.weapons.length, before - 1, '融合净腾出 1 个武器槽');
  assert.ok(engine.events.emitted.some((e) => e.name === 'fusion:performed'));
});

test('等级结转：源武器超出解锁线的等级按 carryover 折算', () => {
  const sandbox = loadSandbox();
  const weapons = new sandbox.WeaponSystem();
  const fusion = new sandbox.ElementFusion({ weapons });
  fusion.onAdd(stubEngine(sandbox, weapons));

  weapons.add('flamethrower');
  weapons.add('frostNova');
  // 火 8（满级）+ 冰 6（满级）：超出 5 的部分 (3+1)×0.5 = 2 级结转 → 起始 3 级
  while (weapons.get('flamethrower').level < 8) weapons.levelUp('flamethrower');
  while (weapons.get('frostNova').level < 6) weapons.levelUp('frostNova');

  const weapon = fusion.performFusion('steamVortex');
  assert.equal(weapon.level, 3);
});

test('印记与反应：跨元素命中触发反应、遵守冷却并消耗印记', () => {
  const sandbox = loadSandbox();
  const weapons = new sandbox.WeaponSystem();
  const fusion = new sandbox.ElementFusion({ weapons });
  const engine = stubEngine(sandbox, weapons);
  fusion.onAdd(engine);

  const enemy = stubEnemy();

  fusion.applyMark(enemy, 'fire');
  assert.equal(fusion.stats.reactions, 0, '单元素不触发反应');

  fusion.applyMark(enemy, 'frost');
  assert.equal(fusion.stats.reactions, 1, '火+冰 应触发蒸发');
  assert.equal(fusion.stats.perReaction.vaporize, 1);
  assert.ok(enemy.damageTaken > 0, '蒸发应造成即时伤害');
  assert.ok(engine.events.emitted.some((e) => e.name === 'fusion:reaction'));

  const state = fusion.marks.get(enemy);
  assert.ok(!state.elements.fire && !state.elements.frost, '蒸发应吃掉双方印记');

  // 冷却期内重挂两元素不应再次触发
  fusion.applyMark(enemy, 'fire');
  fusion.applyMark(enemy, 'frost');
  assert.equal(fusion.stats.reactions, 1, '反应冷却应拦截二次触发');

  // 冷却过后可再次触发
  engine.elapsed = 10;
  fusion.applyMark(enemy, 'fire');
  fusion.applyMark(enemy, 'frost');
  assert.equal(fusion.stats.reactions, 2);
});

test('毒印记叠层受上限约束，noReact 印记不触发反应', () => {
  const sandbox = loadSandbox();
  const weapons = new sandbox.WeaponSystem();
  const fusion = new sandbox.ElementFusion({ weapons });
  fusion.onAdd(stubEngine(sandbox, weapons));

  const enemy = stubEnemy();
  for (let i = 0; i < 20; i++) fusion.applyMark(enemy, 'venom');
  const state = fusion.marks.get(enemy);
  assert.equal(state.elements.venom.stacks, 8, '毒最多叠 8 层');

  fusion.applyMark(enemy, 'volt', 1, { noReact: true });
  assert.equal(fusion.stats.reactions, 0, 'noReact 印记不得触发反应');

  fusion.applyMark(enemy, 'volt');
  assert.equal(fusion.stats.perReaction.contagion, 1, '毒+雷 应触发感电扩散');
});

test('reset 清空印记、延迟效果与统计', () => {
  const sandbox = loadSandbox();
  const weapons = new sandbox.WeaponSystem();
  const fusion = new sandbox.ElementFusion({ weapons });
  fusion.onAdd(stubEngine(sandbox, weapons));

  const enemy = stubEnemy();
  fusion.applyMark(enemy, 'fire');
  fusion.applyMark(enemy, 'volt'); // 超载 → 压入延迟效果
  assert.ok(fusion.marks.size > 0);
  assert.ok(fusion.effects.length > 0);

  fusion.reset();
  assert.equal(fusion.marks.size, 0);
  assert.equal(fusion.effects.length, 0);
  assert.equal(fusion.stats.reactions, 0);
});
