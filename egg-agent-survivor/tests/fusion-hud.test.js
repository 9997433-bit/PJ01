'use strict';

/**
 * Round 3：融合接线 + HUD 武器栏 + 构筑总览
 *
 * Round 2 把元素融合整套实现完了，却没有接进 index.html —— 生产环境里
 * 一次反应都不会发生。这组用例守住三件事：
 *   1. 接线：脚本被引入、装配顺序正确、两处装饰真的挂上了；
 *   2. 卡池：融合卡进得去、保底出得来、走升级卡路径能真的换出融合武器；
 *   3. 界面：HUD 武器栏按元素上色并跟随冷却，构筑总览按 Tab 开合且不打乱状态机。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ROOT, bootGame, scriptsFromIndexHtml } = require('./helpers/browser-harness');

const DT = 1 / 60;

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function childByClass(node, className) {
  return node.children.find((child) => child.classList.contains(className)) || null;
}

/** 把两把源武器拉到解锁线，让 火+冰 → 蒸汽奇点 可用 */
function unlockSteamVortex(game) {
  const weapons = game.weaponSystem;
  weapons.add('flamethrower');
  weapons.add('frostNova');
  const unlock = game.fusion.config.fusion.unlockLevel;
  while (weapons.get('flamethrower').level < unlock) weapons.levelUp('flamethrower');
  while (weapons.get('frostNova').level < unlock) weapons.levelUp('frostNova');
  return weapons;
}

/* ================= 接线 ================= */

test('index.html 引入融合系统与构筑总览，且排在依赖之后', () => {
  const sources = scriptsFromIndexHtml();
  const indexOf = (name) => sources.findIndex((source) => source.endsWith(name));

  assert.ok(indexOf('ElementFusion.js') >= 0, 'index.html 必须引入 ElementFusion.js');
  assert.ok(indexOf('BuildOverview.js') >= 0, 'index.html 必须引入 BuildOverview.js');
  assert.ok(
    indexOf('ElementFusion.js') > indexOf('WeaponSystem.js'),
    'ElementFusion 装饰 WeaponSystem 的方法，必须后加载'
  );
  assert.ok(
    indexOf('ElementFusion.js') > indexOf('UpgradeSystem.js'),
    'ElementFusion 装饰 UpgradeSystem 的卡池，必须后加载'
  );
  assert.ok(indexOf('BuildOverview.js') > indexOf('HUD.js'), '界面层顺序：HUD 先于构筑总览');
  assert.equal(indexOf('main.js'), sources.length - 1, '入口必须最后加载');

  for (const relative of sources) {
    assert.ok(fs.existsSync(path.join(ROOT, relative)), `引用了不存在的脚本：${relative}`);
  }
});

test('index.html 预载融合配置并铺好武器栏与构筑总览的挂载点', () => {
  const html = read('index.html');
  assert.match(
    html,
    /<link rel="preload" href="js\/data\/fusion-weapons\.json"[^>]*as="fetch"/,
    'fusion-weapons.json 应当被预载，避免首局开打后才热合并'
  );
  assert.ok(fs.existsSync(path.join(ROOT, 'js/data/fusion-weapons.json')));
  assert.match(html, /id="weapon-bar"/);
  assert.match(html, /id="build-overview"/);
  assert.match(html, /id="build-body"/);
  assert.match(html, /id="btn-build"/);
  assert.match(html, /<kbd>TAB<\/kbd>/, '主菜单操作表应当写明构筑总览的按键');
});

test('启动后融合系统挂进引擎，并装饰了武器命中与升级卡池', () => {
  const boot = bootGame();
  const { win, game } = boot;

  assert.ok(game.engine.fusion instanceof win.ElementFusion, 'engine.fusion 应当就位');
  assert.equal(game.fusion, game.engine.fusion, 'main.js 应当持有同一个实例');
  assert.equal(game.engine.weapons.__fusionHooks, true, '命中出口应被装饰');
  assert.equal(game.engine.upgrades.__fusionHooks, true, '卡池应被装饰');

  assert.equal(win.WeaponSystem.WEAPONS.flamethrower.element, 'fire', '基础武器应被打上元素标签');
  assert.equal(win.WeaponSystem.WEAPONS.magicBolt.element, 'light');
  assert.ok(win.WeaponSystem.WEAPONS.steamVortex.isFusion, '融合武器应注册进 WEAPONS');
  assert.ok(!win.WeaponSystem.IDS.includes('steamVortex'), '融合武器不该混进新武器卡池');
});

test('真实战斗里武器命中会挂上元素印记', () => {
  const boot = bootGame();
  const game = boot.game;
  game.startRun();

  const enemy = game.spawner.spawnAt(60, 0, 'grunt');
  enemy.health = 1e6;
  enemy.maxHealth = 1e6;

  let frames = 0;
  while (frames < 600 && !game.fusion.marksOf(enemy)) {
    game.engine.update(DT, DT);
    frames++;
  }

  const marks = game.fusion.marksOf(enemy);
  assert.ok(marks, '自动武器命中后应当留下元素印记');
  assert.ok(marks.light && marks.light.stacks > 0, '初始武器是光元素，应当挂光印记');
});

/* ================= 卡池 ================= */

test('融合卡进入卡池、保底出现在三选一，并能真的换出融合武器', () => {
  const boot = bootGame();
  const game = boot.game;
  game.startRun();
  const weapons = unlockSteamVortex(game);

  const pool = game.upgrades.buildPool();
  const card = pool.find((entry) => entry.kind === 'fusion');
  assert.ok(card, '双源达到解锁线后卡池里应当有融合卡');
  assert.equal(card.id, 'f_steamVortex');
  assert.equal(card.rarity, 'legendary');
  // 卡片来自 VM realm，数组原型不同，先搬回本 realm 再比
  assert.deepEqual(Array.from(card.colors), ['#ff8a3d', '#7fd8ff'], '融合卡应带上两种元素色');
  assert.match(card.desc(), /火焰喷射 × 霜爆冲击/);
  assert.ok(
    !pool.some((entry) => entry.kind === 'weaponNew' && entry.weaponId === 'steamVortex'),
    '融合武器不该以「新武器」的身份出现'
  );

  // guaranteeCard：有可用融合时，每次三选一都必须看得到它
  for (let i = 0; i < 8; i++) {
    const picked = game.upgrades.roll(3);
    assert.ok(
      picked.some((entry) => entry.kind === 'fusion'),
      '开启保底后每一轮三选一都应当包含融合卡'
    );
  }

  const chosen = game.upgrades.choices.find((entry) => entry.kind === 'fusion');
  const before = weapons.weapons.length;
  game.upgrades.apply(chosen, game.upgrades.context());

  assert.ok(weapons.has('steamVortex'), '选择融合卡应当装上融合武器');
  assert.ok(!weapons.has('flamethrower') && !weapons.has('frostNova'), '源武器应被吞掉');
  assert.equal(weapons.weapons.length, before - 1, '融合净腾出 1 个武器槽');
  assert.equal(game.fusion.stats.fusions, 1);
});

test('融合卡的卡面带上 fusion 修饰类与双元素色变量', () => {
  const boot = bootGame();
  const game = boot.game;
  game.startRun();
  unlockSteamVortex(game);

  game.upgrades.roll(3);
  const container = boot.el('upgrade-cards');
  game.upgrades.renderCards(container, game.upgrades.context(), () => {});

  const index = game.upgrades.choices.findIndex((entry) => entry.kind === 'fusion');
  assert.ok(index >= 0);
  const node = container.children[index];
  assert.ok(node.classList.contains('card--legendary'));
  assert.ok(node.classList.contains('card--fusion'));
  assert.equal(node.style.getPropertyValue('--card-color'), '#ff8a3d');
  assert.equal(node.style.getPropertyValue('--card-color-2'), '#7fd8ff');
});

/* ================= HUD 武器栏 ================= */

test('HUD 武器栏渲染图标、等级与元素色，并跟随冷却回落', () => {
  const boot = bootGame();
  const game = boot.game;
  game.startRun();
  game.hud.update(DT);

  const bar = boot.el('weapon-bar');
  assert.ok(bar.classList.contains('is-active'));
  assert.equal(bar.children.length, 1, '开局只有一把武器');

  const slot = bar.children[0];
  assert.ok(slot.classList.contains('weapon'));
  assert.equal(slot.style.getPropertyValue('--weapon-color'), '#fff3c4', '魔法弹是光元素');
  assert.equal(childByClass(slot, 'weapon__icon').textContent, '✷');
  assert.equal(childByClass(slot, 'weapon__level').textContent, '1');
  assert.ok(slot.classList.contains('is-ready'), '冷却归零时应当标记就绪');
  assert.equal(childByClass(slot, 'weapon__cd').style.height, '0%');

  // 刚开火：遮罩拉满、就绪标记消失
  const magicBolt = game.weaponSystem.get('magicBolt');
  magicBolt.cooldown = magicBolt.stats.cooldown;
  game.hud.update(DT);
  assert.equal(childByClass(slot, 'weapon__cd').style.height, '100%');
  assert.ok(!slot.classList.contains('is-ready'));

  // 半程
  magicBolt.cooldown = magicBolt.stats.cooldown * 0.5;
  game.hud.update(DT);
  assert.equal(childByClass(slot, 'weapon__cd').style.height, '50%');

  // 新武器进来后重建槽位，元素色跟着换
  game.weaponSystem.add('flamethrower');
  game.hud.update(DT);
  assert.equal(bar.children.length, 2);
  assert.equal(bar.children[1].style.getPropertyValue('--weapon-color'), '#ff8a3d');
});

test('武器栏为融合武器画出双元素色，并给满级槽位打标记', () => {
  const boot = bootGame();
  const game = boot.game;
  game.startRun();
  unlockSteamVortex(game);
  assert.ok(game.fusion.performFusion('steamVortex'));

  game.hud.update(DT);
  const bar = boot.el('weapon-bar');
  const fusionSlot = bar.children.find((node) => node.classList.contains('weapon--fusion'));
  assert.ok(fusionSlot, '融合武器应当有独立的槽位样式');
  assert.equal(fusionSlot.style.getPropertyValue('--weapon-color'), '#ff8a3d');
  assert.equal(fusionSlot.style.getPropertyValue('--weapon-color-2'), '#7fd8ff');

  const magicBolt = game.weaponSystem.get('magicBolt');
  while (magicBolt.level < magicBolt.def.maxLevel) game.weaponSystem.levelUp('magicBolt');
  game.hud.update(DT);
  const maxed = bar.children.find((node) => node.classList.contains('is-max'));
  assert.ok(maxed, '满级武器应当被标记');
  assert.equal(childByClass(maxed, 'weapon__level').textContent, String(magicBolt.def.maxLevel));
});

/* ================= 构筑总览 ================= */

test('Tab 打开构筑总览会暂停战斗，再按一次恢复', () => {
  const boot = bootGame();
  const { win, game } = boot;
  game.startRun();

  boot.pressKey('Tab');
  game.engine.update(DT, DT);

  assert.equal(game.buildOverview.visible, true);
  assert.equal(game.engine.state, win.GameState.PAUSED, '战斗中打开面板应当顺手暂停');
  const panel = boot.el('build-overview');
  assert.ok(panel.classList.contains('is-visible'));
  assert.equal(panel.getAttribute('aria-hidden'), 'false');
  assert.equal(boot.el('btn-build').getAttribute('aria-expanded'), 'true');

  boot.releaseKey('Tab');
  boot.pressKey('Tab');
  game.engine.update(DT, DT);

  assert.equal(game.buildOverview.visible, false);
  assert.equal(game.engine.state, win.GameState.PLAYING, '关闭面板应当恢复战斗');
  assert.equal(panel.getAttribute('aria-hidden'), 'true');
});

test('构筑总览列出武器输出占比、元素解锁进度、被动与属性', () => {
  const boot = bootGame();
  const game = boot.game;
  game.startRun();
  unlockSteamVortex(game);
  game.weaponSystem.get('magicBolt').damageDealt = 300;
  game.weaponSystem.get('flamethrower').damageDealt = 100;
  game.upgrades.apply(
    game.upgrades.buildPool().find((card) => card.id === 'p_damage'),
    game.upgrades.context()
  );

  game.buildOverview.open();
  const html = boot.el('build-body').innerHTML;

  assert.match(html, /ov-summary/, '应当有概览条');
  assert.match(html, /魔法弹/);
  assert.match(html, /火焰喷射/);
  assert.match(html, /75%/, '魔法弹打了 300/400，占比应当是 75%');
  assert.match(html, /蒸汽奇点/, '可用融合应当在面板里给出提示');
  assert.match(html, /蛋白强化/, '吃到的被动应当列出来');
  assert.match(html, /\+12%/, '被动带来的增伤应当反映在属性区');
  assert.match(html, /3\/6 槽位/);
});

test('构筑总览在三选一时只叠加显示，不动状态机', () => {
  const boot = bootGame();
  const { win, game } = boot;
  game.startRun();
  game.engine.player.gainXp(10000);
  assert.equal(game.engine.state, win.GameState.LEVELUP);

  assert.equal(game.buildOverview.toggle(), true);
  assert.equal(game.engine.state, win.GameState.LEVELUP, '选卡时打开面板不应改变状态');

  assert.equal(game.buildOverview.toggle(), false);
  assert.equal(game.engine.state, win.GameState.LEVELUP, '关闭同样不该改变状态');
});

test('面板打开期间的状态迁移会顺手收起它，且不会误恢复战斗', () => {
  const boot = bootGame();
  const { win, game } = boot;
  game.startRun();

  // ESC：主循环自己把游戏放回 PLAYING，面板只负责收起
  game.buildOverview.open();
  assert.equal(game.engine.state, win.GameState.PAUSED);
  boot.pressKey('Escape');
  game.engine.update(DT, DT);
  assert.equal(game.engine.state, win.GameState.PLAYING);
  assert.equal(game.buildOverview.visible, false);

  // 回主菜单同样要收起，且不能把 MENU 顶回 PLAYING
  game.buildOverview.open();
  game.toMenu();
  assert.equal(game.buildOverview.visible, false);
  assert.equal(game.engine.state, win.GameState.MENU);

  // 菜单里打不开：没有构筑可看
  assert.equal(game.buildOverview.open(), false);
  assert.equal(game.buildOverview.visible, false);
});

test('HUD 按钮与关闭按钮都能开合构筑总览', () => {
  const boot = bootGame();
  const game = boot.game;
  game.startRun();

  boot.el('btn-build')._fire('click');
  assert.equal(game.buildOverview.visible, true);

  boot.el('btn-build-close')._fire('click');
  assert.equal(game.buildOverview.visible, false);
  assert.equal(boot.el('btn-build').getAttribute('aria-expanded'), 'false');
});

/* ================= 查询接口与样式 ================= */

test('ElementFusion 暴露构筑总览需要的查询接口', () => {
  const boot = bootGame();
  const game = boot.game;
  game.startRun();
  const fusion = game.fusion;

  const before = fusion.elementProgress();
  assert.equal(before.length, 5, '五种元素都要有进度条目');
  const fireBefore = before.find((entry) => entry.id === 'fire');
  assert.equal(fireBefore.level, 0);
  assert.equal(fireBefore.ready, false);
  assert.equal(fireBefore.unlockLevel, fusion.config.fusion.unlockLevel);

  unlockSteamVortex(game);
  const fireAfter = fusion.elementProgress().find((entry) => entry.id === 'fire');
  assert.equal(fireAfter.weapon, '火焰喷射');
  assert.equal(fireAfter.level, fusion.config.fusion.unlockLevel);
  assert.equal(fireAfter.ready, true);

  assert.equal(fusion.reactionById('vaporize').name, '蒸发');
  assert.equal(fusion.reactionById('not-a-reaction'), null);
});

test('样式表覆盖武器栏、构筑总览与融合卡面', () => {
  const css = read('css/style.css');

  assert.match(css, /\.weapons\.is-active/);
  assert.match(css, /\.weapon__cd/);
  assert.match(css, /\.weapon__icon/);
  assert.match(css, /\.weapon__level/);
  assert.match(css, /\.weapon--fusion/);
  assert.match(css, /#hud\[data-layout="portrait"\] \.weapons/, '小屏也要有武器栏排版');

  assert.match(css, /\.overview\.is-visible/);
  assert.match(css, /\.overview__panel/);
  assert.match(css, /\.ov-weapon__bar/);
  assert.match(css, /\.ov-element/);
  assert.match(css, /\.ov-stat/);

  assert.match(css, /\.card--legendary/, '传说卡此前没有配色，融合卡会退化成裸卡面');
  assert.match(css, /\.card--fusion/);
});
