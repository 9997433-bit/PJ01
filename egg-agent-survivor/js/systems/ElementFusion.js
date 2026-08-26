/**
 * ElementFusion — 元素融合武器系统（Round 2）
 *
 * 三层模型（详细规范见 .agent_workspace/ROUND2_FUSION_SPEC.md）：
 *
 *   1. 元素印记（Mark）
 *      每把基础武器绑定一种元素（火/冰/雷/毒/光）。武器命中敌人时在其身上
 *      挂对应元素的印记（可叠层、限时）。印记本身只有「毒」带 DoT，
 *      其余元素的价值全部体现在反应上。
 *
 *   2. 元素反应（Reaction）
 *      敌人身上已有元素 A 的印记、又被元素 B 命中时，触发 A+B 的反应
 *      （蒸发/超载/爆燃/圣焰/超导/脆化/折射/感电扩散/闪耀/净化，共 C(5,2)=10 种）。
 *      反应按敌人 × 元素对独立冷却，反应伤害不再挂新印记，杜绝无限连锁。
 *
 *   3. 融合武器（Fusion Weapon）
 *      两把不同元素的基础武器都达到解锁等级后，升级三选一里出现融合卡：
 *      吞掉两把源武器、腾出一个武器槽，换取一把以该元素对反应为核心机制的
 *      传说武器（每个元素对一把，共 10 把，行为由 8 种原型参数化生成）。
 *
 * 接入方式（对 Round 1 代码零改动）：
 *   - 融合武器定义注册进 WeaponSystem.WEAPONS，但不进加载期快照 WeaponSystem.IDS，
 *     因此升级/HUD/统计全部复用现有管线，又不会混进「新武器」卡池；
 *   - 装饰 weapons.dealDamage / weapons.spawn 两个命中出口来挂印记；
 *   - 装饰 upgrades.buildPool / upgrades.roll 来注入并保底融合卡。
 *   所有装饰只包一层且幂等（__fusionHooks 标记），Round 3 若在
 *   WeaponSystem 中补上一等事件（damage:dealt），本系统可平滑切换。
 *
 * 数据驱动：
 *   js/data/fusion-weapons.json 是权威调参文件（http 环境下 fetch 加载并热合并）；
 *   本文件内嵌同版本快照 DEFAULT_CONFIG 作为 file:// 离线兜底。
 *   两者一致性由 tests/element-fusion.test.js 强制校验。
 */
(function (global) {
  'use strict';

  const MathUtils = global.MathUtils;
  const TAU = Math.PI * 2;
  const EMPTY = [];

  const CONFIG_URL = 'js/data/fusion-weapons.json';

  /* ------------------------------------------------------------------ *
   * 小工具
   * ------------------------------------------------------------------ */

  function deepClone(value) {
    if (Array.isArray(value)) return value.map(deepClone);
    if (value && typeof value === 'object') {
      const out = {};
      for (const key in value) out[key] = deepClone(value[key]);
      return out;
    }
    return value;
  }

  /** 以 patch 覆盖 base；对象递归合并、数组与标量整体替换，null/undefined 保留 base */
  function deepMerge(base, patch) {
    if (patch === undefined || patch === null) return base;
    if (typeof patch !== 'object' || Array.isArray(patch)) return deepClone(patch);
    const out = (base && typeof base === 'object' && !Array.isArray(base)) ? base : {};
    for (const key in patch) out[key] = deepMerge(out[key], patch[key]);
    return out;
  }

  /** 元素对的规范键：按字典序排序，保证 (a,b) 与 (b,a) 落到同一条反应 */
  function pairKey(a, b) {
    return a < b ? `${a}+${b}` : `${b}+${a}`;
  }

  /** 抖动折线（电弧/光束共用） */
  function drawJaggedLine(ctx, x1, y1, x2, y2, jitter) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    const segments = 5;
    for (let i = 1; i < segments; i++) {
      const k = i / segments;
      const j = (Math.random() - 0.5) * jitter * (1 - Math.abs(k - 0.5) * 2);
      ctx.lineTo(x1 + dx * k + nx * j, y1 + dy * k + ny * j);
    }
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  /* ------------------------------------------------------------------ *
   * 内嵌配置快照 —— 与 js/data/fusion-weapons.json 保持逐字段一致
   * ------------------------------------------------------------------ */

  const DEFAULT_CONFIG = {
    meta: {
      version: 1,
      doc: '.agent_workspace/ROUND2_FUSION_SPEC.md',
      note: '元素融合系统的权威调参数据。js/systems/ElementFusion.js 内嵌同版本快照用于 file:// 离线兜底；修改本文件后必须同步快照，tests/element-fusion.test.js 会校验两者逐字段一致。',
    },
    elements: {
      fire: { name: '火', color: '#ff8a3d', icon: '🔥', desc: '灼烧持续伤害' },
      frost: { name: '冰', color: '#7fd8ff', icon: '❄', desc: '减速与控制' },
      volt: { name: '雷', color: '#ffe86b', icon: '⚡', desc: '弹射与眩晕' },
      venom: { name: '毒', color: '#9dff57', icon: '☠', desc: '可叠层的毒蚀' },
      light: { name: '光', color: '#fff3c4', icon: '✨', desc: '增幅与净化' },
    },
    weaponElements: {
      flamethrower: 'fire',
      frostNova: 'frost',
      chainBolt: 'volt',
      knifeOrbit: 'venom',
      magicBolt: 'light',
      boomerang: null,
    },
    marks: {
      duration: 4,
      maxStacks: 3,
      perElement: {
        venom: { duration: 5, maxStacks: 8, dps: 3, tick: 0.5 },
      },
    },
    fusion: {
      unlockLevel: 5,
      carryover: 0.5,
      maxFusionWeapons: 2,
      cardWeight: 60,
      cardRarity: 'legendary',
      guaranteeCard: true,
      reactionCooldown: 1.0,
      growthPerMinute: 0.15,
      maxReactionsPerHit: 1,
    },
    reactions: {
      'fire+frost': {
        id: 'vaporize', name: '蒸发', icon: '♨', color: '#e8fbff', cooldown: 1.0,
        damage: 30, maxHealthPct: 0.05, maxHealthCap: 120,
        radius: 90, splash: 0.6, knockback: 120,
        consume: { fire: 1, frost: 1 },
      },
      'fire+volt': {
        id: 'overload', name: '超载', icon: '💥', color: '#ffb35c', cooldown: 1.2,
        damage: 46, radius: 110, delay: 0.45, knockback: 300,
        consume: { fire: 1, volt: 1 },
      },
      'fire+venom': {
        id: 'detonate', name: '爆燃', icon: '🧨', color: '#c8ff6b', cooldown: 1.4,
        perStack: 16, radius: 70, splash: 0.4,
        consume: { fire: 1, venom: 'all' },
      },
      'fire+light': {
        id: 'sanctify', name: '圣焰', icon: '🕯', color: '#ffe9b0', cooldown: 1.2,
        damage: 34, burnBoost: 1.6, burnTime: 3, fallbackBurnDps: 6,
        consume: { fire: 1, light: 1 },
      },
      'frost+volt': {
        id: 'superconduct', name: '超导', icon: '🧊', color: '#bfe9ff', cooldown: 1.0,
        damage: 36, slowMult: 0.3, slowTime: 3, stun: 0.35,
        consume: { frost: 1, volt: 1 },
      },
      'frost+venom': {
        id: 'shatter', name: '脆化', icon: '💠', color: '#d5f6ff', cooldown: 1.2,
        damage: 40, slowedBonus: 1.5, radius: 80, splash: 0.5,
        consume: { frost: 1, venom: 2 },
      },
      'frost+light': {
        id: 'refract', name: '折射', icon: '🔮', color: '#e6f7ff', cooldown: 1.1,
        damage: 30, targets: 3, radius: 220, spreadMark: 'frost',
        consume: { frost: 1, light: 1 },
      },
      'venom+volt': {
        id: 'contagion', name: '感电扩散', icon: '🦠', color: '#c0ff8a', cooldown: 1.5,
        damage: 18, targets: 4, radius: 180, copyStacks: true,
        consume: { volt: 1 },
      },
      'light+volt': {
        id: 'flash', name: '闪耀', icon: '🌟', color: '#fff8d0', cooldown: 1.6,
        damage: 24, radius: 130, stun: 0.7,
        consume: { light: 1, volt: 1 },
      },
      'light+venom': {
        id: 'purge', name: '净化', icon: '✴', color: '#f2ffd9', cooldown: 1.4,
        perStack: 12, healPerStack: 1, healCap: 8,
        consume: { light: 1, venom: 'all' },
      },
    },
    weapons: {
      steamVortex: {
        name: '蒸汽奇点', icon: '🌀', elements: ['fire', 'frost'],
        archetype: 'zone', zoneStyle: 'vortex', applies: 'alternate',
        desc: '召唤缓慢游走的高压蒸汽涡旋，吸聚敌人并持续蒸灼',
        maxLevel: 6,
        base: { damage: 26, cooldown: 6.5, duration: 4, radius: 95, tick: 0.4, drift: 90, pull: 60, count: 1 },
        perLevel: { damage: 7, cooldown: -0.45, duration: 0.35, radius: 8 },
        levelText: ['', '召唤 1 座蒸汽涡旋', '范围扩大', '持续时间延长', '伤害提升', '冷却缩短', '伤害与范围全面强化'],
      },
      plasmaStorm: {
        name: '等离子风暴', icon: '🌩', elements: ['fire', 'volt'],
        archetype: 'strike', targeting: 'cluster', applies: 'alternate',
        desc: '呼叫等离子轰击，在怪群头顶落下连环爆炸',
        maxLevel: 6,
        base: { damage: 58, cooldown: 3.4, strikes: 3, radius: 78, range: 520, stagger: 0.14, telegraph: 0.32, knockback: 180, stun: 0 },
        perLevel: { damage: 14, cooldown: -0.2, strikes: 0.5, radius: 5 },
        levelText: ['', '呼叫 3 道等离子轰击', '伤害提升', '+1 道轰击', '爆炸范围扩大', '冷却缩短', '+1 道轰击，伤害提升'],
      },
      brimstonePlague: {
        name: '硫磺瘟疫', icon: '☣', elements: ['fire', 'venom'],
        archetype: 'zone', zoneStyle: 'pool', applies: 'alternate',
        desc: '在敌人脚下引燃硫磺毒沼，灼烧与剧毒同时侵蚀',
        maxLevel: 6,
        base: { damage: 18, cooldown: 4.6, duration: 3.4, radius: 70, tick: 0.45, drift: 0, pull: 0, count: 2 },
        perLevel: { damage: 5, cooldown: -0.25, duration: 0.3, count: 0.34 },
        levelText: ['', '喷洒 2 片硫磺毒沼', '毒沼持续更久', '+1 片毒沼', '伤害提升', '冷却缩短', '+1 片毒沼，伤害提升'],
      },
      coronaNova: {
        name: '日冕新星', icon: '☀', elements: ['fire', 'light'],
        archetype: 'nova', applies: 'alternate',
        desc: '以自身为中心炸开日冕环，圣焰灼烧所及之敌',
        maxLevel: 6,
        base: { damage: 55, cooldown: 5.2, radius: 190, knockback: 320 },
        perLevel: { damage: 15, cooldown: -0.35, radius: 16 },
        levelText: ['', '炸开灼热的日冕环', '范围扩大', '伤害提升', '冷却缩短', '范围再扩大', '伤害大幅提升'],
      },
      superconductorField: {
        name: '超导力场', icon: '🧲', elements: ['frost', 'volt'],
        archetype: 'aura', applies: 'both',
        desc: '身周展开超导力场：范围内敌人持续减速并遭电弧打击',
        maxLevel: 6,
        base: { damage: 20, radius: 150, zaps: 2, zapInterval: 0.9, slowMult: 0.72, slowTime: 0.6, stun: 0.1 },
        perLevel: { damage: 6, radius: 12, zaps: 0.4, zapInterval: -0.06 },
        levelText: ['', '展开超导力场', '电弧伤害提升', '+1 道电弧', '力场扩大', '电弧更密集', '全面强化'],
      },
      wintersting: {
        name: '凛冬荆棘', icon: '❆', elements: ['frost', 'venom'],
        archetype: 'orbitals', applies: 'alternate',
        desc: '淬毒冰棘环绕旋转，缓速并毒蚀近身之敌',
        maxLevel: 6,
        base: { damage: 16, count: 3, orbit: 110, spin: 2.0, hitCooldown: 0.5, knockback: 120 },
        perLevel: { damage: 5, count: 0.5, orbit: 7, spin: 0.08 },
        levelText: ['', '3 根淬毒冰棘开始旋转', '+1 根冰棘', '伤害提升', '轨道扩大', '+1 根冰棘', '伤害与转速提升'],
      },
      auroraPrism: {
        name: '极光棱镜', icon: '◈', elements: ['frost', 'light'],
        archetype: 'beam', applies: 'alternate',
        desc: '展开旋转的极光射线，冻结并撕裂整条直线上的敌人',
        maxLevel: 6,
        base: { damage: 34, cooldown: 7, duration: 2.6, length: 320, width: 26, sweep: 1.6, tick: 0.25 },
        perLevel: { damage: 9, cooldown: -0.4, duration: 0.25, length: 18 },
        levelText: ['', '展开旋转的极光射线', '射线更长', '伤害提升', '持续时间延长', '冷却缩短', '伤害大幅提升'],
      },
      venomGrid: {
        name: '腐电蛛网', icon: '🕸', elements: ['venom', 'volt'],
        archetype: 'chainStrike', applies: 'alternate',
        desc: '毒电弧在敌群间跳跃，每一跳都注入剧毒',
        maxLevel: 6,
        base: { damage: 30, cooldown: 1.9, chains: 4, range: 420, jumpRange: 210, falloff: 0.9, stun: 0.1 },
        perLevel: { damage: 8, cooldown: -0.12, chains: 0.7 },
        levelText: ['', '毒电弧弹射 4 次', '+1 次弹射', '伤害提升', '+1 次弹射', '冷却缩短', '+1 次弹射，伤害提升'],
      },
      judgement: {
        name: '天雷裁决', icon: '⚖', elements: ['light', 'volt'],
        archetype: 'strike', targeting: 'strongest', applies: 'both',
        desc: '圣光天雷轰击最强之敌，震慑周围一切',
        maxLevel: 6,
        base: { damage: 110, cooldown: 4.8, strikes: 1, radius: 120, range: 560, stagger: 0.2, telegraph: 0.4, knockback: 260, stun: 0.8 },
        perLevel: { damage: 30, cooldown: -0.3, radius: 8, strikes: 0.25 },
        levelText: ['', '天雷轰击最强之敌', '伤害提升', '眩晕范围扩大', '冷却缩短', '+1 道天雷', '伤害大幅提升'],
      },
      sanctifiedBlight: {
        name: '辉光瘟疫', icon: '🦋', elements: ['light', 'venom'],
        archetype: 'seekerSwarm', applies: 'alternate',
        desc: '放出追踪的辉光孢子，圣光与剧毒一同侵染目标',
        maxLevel: 6,
        base: { damage: 22, cooldown: 2.2, count: 3, speed: 430, pierce: 1, homing: 5.2, range: 560 },
        perLevel: { damage: 6, cooldown: -0.14, count: 0.5, pierce: 0.2 },
        levelText: ['', '放出 3 枚辉光孢子', '伤害提升', '+1 枚孢子', '获得额外穿透', '冷却缩短', '+1 枚孢子，伤害提升'],
      },
    },
  };

  /* ------------------------------------------------------------------ *
   * 反应处理器
   * 签名：handler(fusion, enemy, state, cfg, power)
   *   power = 玩家增伤 × 时间成长，由 fusion._power() 统一计算。
   * 约束：处理器内造成的伤害一律走 fusion._hit / fusion._splash，
   *       不得调用 applyMark（除非 noReact），避免反应递归触发反应。
   * ------------------------------------------------------------------ */

  const REACTIONS = {
    /** 火+冰 蒸发：即时蒸汽爆裂，附带最大生命百分比加成与溅射 */
    vaporize(f, enemy, state, cfg, power) {
      const bonus = Math.min(cfg.maxHealthCap, (enemy.maxHealth || 0) * cfg.maxHealthPct);
      const damage = (cfg.damage + bonus) * power;
      f._hit(enemy, damage, { knockback: cfg.knockback, angle: Math.random() * TAU });
      f._splash(enemy, damage * cfg.splash, cfg.radius, cfg.knockback * 0.5);
      f._fx(enemy, cfg.color, cfg.radius);
    },

    /** 火+雷 超载：短暂延迟后的大范围爆炸（延迟由 update 结算，位置跟随目标） */
    overload(f, enemy, state, cfg, power) {
      f.effects.push({
        type: 'overload',
        enemy,
        x: enemy.position.x,
        y: enemy.position.y,
        timer: cfg.delay,
        total: cfg.delay,
        cfg,
        power,
      });
    },

    /** 火+毒 爆燃：引爆全部毒层，伤害随层数走 */
    detonate(f, enemy, state, cfg, power) {
      const stacks = f._stacksOf(state, 'venom');
      if (stacks <= 0) return;
      const damage = cfg.perStack * stacks * power;
      f._hit(enemy, damage, { knockback: 90, angle: Math.random() * TAU });
      f._splash(enemy, damage * cfg.splash, cfg.radius, 60);
      f._fx(enemy, cfg.color, cfg.radius);
    },

    /** 火+光 圣焰：即时圣伤并强化灼烧 */
    sanctify(f, enemy, state, cfg, power) {
      f._hit(enemy, cfg.damage * power, { critical: true });
      if (enemy.applyBurn) {
        const dps = enemy.burn ? enemy.burn.dps * cfg.burnBoost : cfg.fallbackBurnDps * power;
        enemy.applyBurn(dps, cfg.burnTime);
      }
      f._fx(enemy, cfg.color, 46);
    },

    /** 冰+雷 超导：即时伤害 + 深度减速 + 短暂眩晕 */
    superconduct(f, enemy, state, cfg, power) {
      f._hit(enemy, cfg.damage * power, { stun: cfg.stun });
      if (enemy.applySlow) enemy.applySlow(cfg.slowMult, cfg.slowTime);
      f._fx(enemy, cfg.color, 40);
    },

    /** 冰+毒 脆化：对减速目标造成额外伤害并炸出碎片溅射 */
    shatter(f, enemy, state, cfg, power) {
      const slowed = !!enemy.slow;
      const damage = cfg.damage * (slowed ? cfg.slowedBonus : 1) * power;
      f._hit(enemy, damage, { knockback: 140, angle: Math.random() * TAU });
      f._splash(enemy, damage * cfg.splash, cfg.radius, 80);
      f._fx(enemy, cfg.color, cfg.radius);
    },

    /** 冰+光 折射：光束跳向附近敌人并扩散冰印记 */
    refract(f, enemy, state, cfg, power) {
      const combat = f.engine.combat;
      if (!combat) return;
      const targets = [];
      combat.forEachInCircle(enemy.position.x, enemy.position.y, cfg.radius, (other) => {
        if (other === enemy || targets.length >= cfg.targets) return;
        targets.push(other);
      });
      for (const other of targets) {
        f._hit(other, cfg.damage * power, { silent: true });
        if (cfg.spreadMark) f.applyMark(other, cfg.spreadMark, 1, { noReact: true });
        f.arcs.push({
          x1: enemy.position.x, y1: enemy.position.y,
          x2: other.position.x, y2: other.position.y,
          life: 0.24, maxLife: 0.24, color: cfg.color, jitter: 6,
        });
      }
    },

    /** 毒+雷 感电扩散：把毒层复制给周围敌人 */
    contagion(f, enemy, state, cfg, power) {
      const combat = f.engine.combat;
      if (!combat) return;
      const stacks = Math.max(1, f._stacksOf(state, 'venom'));
      const targets = [];
      combat.forEachInCircle(enemy.position.x, enemy.position.y, cfg.radius, (other) => {
        if (other === enemy || targets.length >= cfg.targets) return;
        targets.push(other);
      });
      for (const other of targets) {
        f._hit(other, cfg.damage * power, { silent: true });
        if (cfg.copyStacks) f.applyMark(other, 'venom', stacks, { noReact: true });
        f.arcs.push({
          x1: enemy.position.x, y1: enemy.position.y,
          x2: other.position.x, y2: other.position.y,
          life: 0.22, maxLife: 0.22, color: cfg.color, jitter: 18,
        });
      }
    },

    /** 光+雷 闪耀：以目标为中心的眩晕闪光 */
    flash(f, enemy, state, cfg, power) {
      const combat = f.engine.combat;
      f._hit(enemy, cfg.damage * power, { stun: cfg.stun });
      if (combat) {
        combat.forEachInCircle(enemy.position.x, enemy.position.y, cfg.radius, (other) => {
          if (other === enemy) return;
          f._hit(other, cfg.damage * 0.5 * power, { silent: true, stun: cfg.stun });
        });
      }
      f._fx(enemy, cfg.color, cfg.radius);
      if (f.engine.camera) f.engine.camera.addTrauma(0.08);
    },

    /** 光+毒 净化：焚净全部毒层换取伤害，并按层数治疗玩家 */
    purge(f, enemy, state, cfg, power) {
      const stacks = f._stacksOf(state, 'venom');
      if (stacks <= 0) return;
      f._hit(enemy, cfg.perStack * stacks * power, { critical: stacks >= 6 });
      const player = f.engine.player;
      if (player && player.heal) {
        player.heal(Math.min(cfg.healCap, stacks * cfg.healPerStack));
      }
      f._fx(enemy, cfg.color, 50);
    },
  };

  /* ------------------------------------------------------------------ *
   * 行为原型库
   * 每个原型都是 { init?, fire?, tick?, render? }，签名在武器定义钩子的
   * 基础上追加末位参数 fusion。伤害一律走 sys.dealDamage（预乘增伤，
   * preMultiplied: true）或 sys.spawn，命中后由接缝自动挂印记。
   * ------------------------------------------------------------------ */

  const ARCHETYPES = {

    /* ---------- 新星：以玩家为中心的爆发环 ---------- */
    nova: {
      init(w) { w.state.rings = []; },

      fire(w, engine, sys, fusion) {
        const s = w.stats;
        const player = engine.player;
        const radius = s.radius * player.stats.areaMultiplier;
        const hits = engine.combat.queryCircle(player.position.x, player.position.y, radius);
        if (!hits.length) return false;

        const roll = sys.rollDamage(w, s.damage);
        for (const enemy of hits) {
          sys.dealDamage(w, enemy, roll.damage, {
            preMultiplied: true,
            critical: roll.critical,
            angle: Math.atan2(
              enemy.position.y - player.position.y,
              enemy.position.x - player.position.x
            ),
            knockback: s.knockback,
          });
        }

        w.state.rings.push({
          x: player.position.x, y: player.position.y,
          radius: 12, maxRadius: radius, life: 0.5, maxLife: 0.5,
        });
        engine.camera.addTrauma(0.2);
        engine.particles.shockwave(player.position.x, player.position.y, {
          size: 14, endSize: radius * 2, color: fusion.elementColor(w.def.elements[0]), life: 0.5,
        });
        if (engine.audio) engine.audio.play('nova');
        return true;
      },

      tick(w, dt) {
        const rings = w.state.rings;
        for (let i = rings.length - 1; i >= 0; i--) {
          const ring = rings[i];
          ring.life -= dt;
          ring.radius = ring.maxRadius * MathUtils.easeOutCubic(1 - ring.life / ring.maxLife);
          if (ring.life <= 0) rings.splice(i, 1);
        }
      },

      render(w, ctx, engine, fusion) {
        const [c1, c2] = fusion.elementColors(w.def);
        for (const ring of w.state.rings) {
          const alpha = ring.life / ring.maxLife;
          ctx.save();
          ctx.globalAlpha = alpha * 0.9;
          ctx.strokeStyle = c1;
          ctx.shadowColor = c2;
          ctx.shadowBlur = 20;
          ctx.lineWidth = 7 * alpha + 1;
          ctx.beginPath();
          ctx.arc(ring.x, ring.y, ring.radius, 0, TAU);
          ctx.stroke();
          ctx.globalAlpha = alpha * 0.5;
          ctx.strokeStyle = c2;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(ring.x, ring.y, ring.radius * 0.86, 0, TAU);
          ctx.stroke();
          ctx.restore();
        }
      },
    },

    /* ---------- 光环：跟随玩家的常驻力场（无冷却，纯 tick 武器） ---------- */
    aura: {
      init(w) {
        w.state.zapTimer = 0;
        w.state.slowTimer = 0;
        w.state.spin = Math.random() * TAU;
        w.state.arcs = [];
      },

      tick(w, dt, engine, sys, fusion) {
        const s = w.stats;
        const player = engine.player;
        const stats = player.stats;
        const radius = s.radius * stats.areaMultiplier;
        const px = player.position.x;
        const py = player.position.y;
        w.state.spin += dt * 0.8;

        // 力场减速：0.4s 重刷一次，覆盖场内所有敌人
        w.state.slowTimer -= dt;
        if (w.state.slowTimer <= 0) {
          w.state.slowTimer = 0.4;
          engine.combat.forEachInCircle(px, py, radius, (enemy) => {
            enemy.applySlow(s.slowMult, s.slowTime);
          });
        }

        // 周期电弧
        w.state.zapTimer -= dt;
        if (w.state.zapTimer <= 0) {
          w.state.zapTimer = Math.max(0.25, s.zapInterval * stats.cooldownMultiplier);
          const zaps = Math.max(1, Math.round(s.zaps));
          for (let i = 0; i < zaps; i++) {
            const target = engine.combat.randomEnemy(px, py, radius);
            if (!target) break;
            const roll = sys.rollDamage(w, s.damage);
            sys.dealDamage(w, target, roll.damage, {
              preMultiplied: true,
              critical: roll.critical,
              angle: Math.atan2(target.position.y - py, target.position.x - px),
              knockback: 60,
              stun: s.stun,
            });
            w.state.arcs.push({
              x1: px, y1: py,
              x2: target.position.x, y2: target.position.y,
              life: 0.18, maxLife: 0.18,
            });
          }
        }

        const arcs = w.state.arcs;
        for (let i = arcs.length - 1; i >= 0; i--) {
          arcs[i].life -= dt;
          if (arcs[i].life <= 0) arcs.splice(i, 1);
        }
      },

      render(w, ctx, engine, fusion) {
        const player = engine.player;
        if (!player) return;
        const [c1, c2] = fusion.elementColors(w.def);
        const radius = w.stats.radius * player.stats.areaMultiplier;

        ctx.save();
        ctx.translate(player.position.x, player.position.y);
        ctx.rotate(w.state.spin);
        ctx.strokeStyle = c1;
        ctx.globalAlpha = 0.4;
        ctx.lineWidth = 2;
        ctx.setLineDash([18, 14]);
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, TAU);
        ctx.stroke();
        ctx.setLineDash(EMPTY);
        ctx.restore();

        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = c2;
        ctx.shadowColor = c2;
        ctx.shadowBlur = 12;
        ctx.lineCap = 'round';
        for (const arc of w.state.arcs) {
          ctx.globalAlpha = arc.life / arc.maxLife;
          ctx.lineWidth = 2.2;
          drawJaggedLine(ctx, arc.x1, arc.y1, arc.x2, arc.y2, 20);
        }
        ctx.restore();
      },
    },

    /* ---------- 环绕体：飞刀环绕的融合版 ---------- */
    orbitals: {
      init(w) {
        w.state.phase = Math.random() * TAU;
        w.state.hitLog = new Map();
        w.state.shards = [];
        w.state.cleanup = 3;
      },

      tick(w, dt, engine, sys) {
        const s = w.stats;
        const player = engine.player;
        const stats = player.stats;
        w.state.phase += s.spin * dt;

        const count = Math.max(1, Math.round(s.count));
        const area = stats.areaMultiplier;
        const orbitRadius = s.orbit * area;
        const shardRadius = 13 * Math.sqrt(area);
        const damage = s.damage * stats.damageMultiplier;
        const now = engine.elapsed;

        w.state.shards.length = 0;
        for (let i = 0; i < count; i++) {
          const a = w.state.phase + (i / count) * TAU;
          const sx = player.position.x + Math.cos(a) * orbitRadius;
          const sy = player.position.y + Math.sin(a) * orbitRadius;
          w.state.shards.push(sx, sy, a);

          engine.combat.forEachInCircle(sx, sy, shardRadius, (enemy, d) => {
            if (d > shardRadius + enemy.radius) return;
            const next = w.state.hitLog.get(enemy);
            if (next !== undefined && now < next) return;
            w.state.hitLog.set(enemy, now + s.hitCooldown);
            sys.dealDamage(w, enemy, damage, {
              preMultiplied: true,
              angle: a + Math.PI / 2,
              knockback: s.knockback,
            });
          });
        }

        w.state.cleanup -= dt;
        if (w.state.cleanup <= 0) {
          w.state.cleanup = 3;
          for (const enemy of w.state.hitLog.keys()) {
            if (enemy.dead) w.state.hitLog.delete(enemy);
          }
        }
      },

      render(w, ctx, engine, fusion) {
        const [c1, c2] = fusion.elementColors(w.def);
        const area = engine.player.stats.areaMultiplier;
        const r = 13 * Math.sqrt(area);
        const shards = w.state.shards;

        for (let i = 0; i < shards.length; i += 3) {
          const color = (i / 3) % 2 === 0 ? c1 : c2;
          ctx.save();
          ctx.translate(shards[i], shards[i + 1]);
          ctx.rotate(shards[i + 2] + engine.elapsed * 4);
          ctx.shadowColor = color;
          ctx.shadowBlur = 12;
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.92;
          ctx.beginPath();
          ctx.moveTo(r * 1.4, 0);
          ctx.lineTo(0, r * 0.55);
          ctx.lineTo(-r * 1.4, 0);
          ctx.lineTo(0, -r * 0.55);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
      },
    },

    /* ---------- 射线：从玩家射出的旋转光束 ---------- */
    beam: {
      init(w) {
        w.state.active = 0;
        w.state.dir = 0;
        w.state.tickTimer = 0;
      },

      fire(w, engine) {
        const s = w.stats;
        const player = engine.player;
        const length = s.length * player.stats.areaMultiplier;
        const target = engine.combat.nearestEnemy(player.position.x, player.position.y, length);
        if (!target) return false;

        w.state.dir = Math.atan2(
          target.position.y - player.position.y,
          target.position.x - player.position.x
        );
        w.state.active = s.duration * player.stats.durationMultiplier;
        w.state.tickTimer = 0;
        if (engine.audio) engine.audio.play('zap');
        return true;
      },

      tick(w, dt, engine, sys) {
        if (w.state.active <= 0) return;
        w.state.active -= dt;

        const s = w.stats;
        const player = engine.player;
        const stats = player.stats;
        w.state.dir += s.sweep * dt;

        w.state.tickTimer -= dt;
        if (w.state.tickTimer > 0) return;
        w.state.tickTimer = s.tick;

        const px = player.position.x;
        const py = player.position.y;
        const area = stats.areaMultiplier;
        const length = s.length * area;
        const halfWidth = s.width * 0.5 * Math.sqrt(area);
        const dirX = Math.cos(w.state.dir);
        const dirY = Math.sin(w.state.dir);
        const damage = s.damage * stats.damageMultiplier;

        // 线段命中：以中点为圆心粗筛，再做点到线段的投影过滤
        engine.combat.forEachInCircle(
          px + dirX * length / 2, py + dirY * length / 2, length / 2 + halfWidth,
          (enemy) => {
            const ex = enemy.position.x - px;
            const ey = enemy.position.y - py;
            const t = MathUtils.clamp(ex * dirX + ey * dirY, 0, length);
            const dx = ex - dirX * t;
            const dy = ey - dirY * t;
            const reach = halfWidth + enemy.radius;
            if (dx * dx + dy * dy > reach * reach) return;
            sys.dealDamage(w, enemy, damage, {
              preMultiplied: true,
              silent: true,
              angle: w.state.dir,
              knockback: 40,
            });
          }
        );
      },

      render(w, ctx, engine, fusion) {
        if (w.state.active <= 0) return;
        const player = engine.player;
        const s = w.stats;
        const [c1, c2] = fusion.elementColors(w.def);
        const area = player.stats.areaMultiplier;
        const length = s.length * area;
        const width = s.width * Math.sqrt(area);
        const alpha = MathUtils.clamp(w.state.active / 0.4, 0, 1);

        ctx.save();
        ctx.translate(player.position.x, player.position.y);
        ctx.rotate(w.state.dir);
        ctx.globalCompositeOperation = 'lighter';

        const gradient = ctx.createLinearGradient(0, 0, length, 0);
        gradient.addColorStop(0, c2);
        gradient.addColorStop(0.5, c1);
        gradient.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalAlpha = alpha * 0.35;
        ctx.fillStyle = gradient;
        ctx.fillRect(0, -width / 2, length, width);

        ctx.globalAlpha = alpha * 0.9;
        ctx.strokeStyle = '#ffffff';
        ctx.shadowColor = c1;
        ctx.shadowBlur = 16;
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(length, 0);
        ctx.stroke();
        ctx.restore();
      },
    },

    /* ---------- 打击：预警后从天而降的轰击 ---------- */
    strike: {
      init(w) {
        w.state.pending = [];
        w.state.blasts = [];
      },

      fire(w, engine) {
        const s = w.stats;
        const player = engine.player;
        const combat = engine.combat;
        const count = Math.max(1, Math.round(s.strikes));
        const targeting = w.def.targeting || 'cluster';
        const targets = [];

        for (let i = 0; i < count; i++) {
          const filter = (e) => targets.indexOf(e) === -1;
          const found = targeting === 'strongest'
            ? combat.strongestEnemy(player.position.x, player.position.y, s.range, filter)
            : combat.randomEnemy(player.position.x, player.position.y, s.range, filter);
          if (!found) break;
          targets.push(found);
        }
        if (!targets.length) return false;

        for (let i = 0; i < targets.length; i++) {
          w.state.pending.push({
            enemy: targets[i],
            x: targets[i].position.x,
            y: targets[i].position.y,
            timer: s.telegraph + i * s.stagger,
            total: s.telegraph + i * s.stagger,
          });
        }
        return true;
      },

      tick(w, dt, engine, sys) {
        const s = w.stats;
        const player = engine.player;
        const pending = w.state.pending;

        for (let i = pending.length - 1; i >= 0; i--) {
          const hit = pending[i];
          // 预警期间跟踪目标，落点始终有威胁
          if (hit.enemy && !hit.enemy.dead) {
            hit.x = hit.enemy.position.x;
            hit.y = hit.enemy.position.y;
          }
          hit.timer -= dt;
          if (hit.timer > 0) continue;
          pending.splice(i, 1);

          const radius = s.radius * player.stats.areaMultiplier;
          const roll = sys.rollDamage(w, s.damage);
          engine.combat.forEachInCircle(hit.x, hit.y, radius, (enemy) => {
            sys.dealDamage(w, enemy, roll.damage, {
              preMultiplied: true,
              critical: roll.critical,
              angle: Math.atan2(enemy.position.y - hit.y, enemy.position.x - hit.x),
              knockback: s.knockback,
              stun: s.stun,
            });
          });

          w.state.blasts.push({ x: hit.x, y: hit.y, radius, life: 0.32, maxLife: 0.32 });
          engine.particles.shockwave(hit.x, hit.y, {
            size: 10, endSize: radius * 2, color: '#ffffff', life: 0.35,
          });
          engine.particles.burst(hit.x, hit.y, 10, {
            speedMin: 80, speedMax: 320, lifeMin: 0.15, lifeMax: 0.4,
          });
          engine.camera.addTrauma(0.14);
          if (engine.audio) engine.audio.play('nova');
        }

        const blasts = w.state.blasts;
        for (let i = blasts.length - 1; i >= 0; i--) {
          blasts[i].life -= dt;
          if (blasts[i].life <= 0) blasts.splice(i, 1);
        }
      },

      render(w, ctx, engine, fusion) {
        const [c1, c2] = fusion.elementColors(w.def);

        // 预警圈：收缩表示剩余时间
        for (const hit of w.state.pending) {
          const k = MathUtils.clamp(hit.timer / Math.max(hit.total, 1e-3), 0, 1);
          ctx.save();
          ctx.globalAlpha = 0.55;
          ctx.strokeStyle = c2;
          ctx.lineWidth = 2;
          ctx.setLineDash([6, 6]);
          ctx.beginPath();
          ctx.arc(hit.x, hit.y, w.stats.radius * (0.4 + k * 0.6), 0, TAU);
          ctx.stroke();
          ctx.setLineDash(EMPTY);
          ctx.restore();
        }

        // 落雷光柱
        for (const blast of w.state.blasts) {
          const alpha = blast.life / blast.maxLife;
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          const gradient = ctx.createLinearGradient(blast.x, blast.y - 420, blast.x, blast.y);
          gradient.addColorStop(0, 'rgba(0,0,0,0)');
          gradient.addColorStop(1, c1);
          ctx.globalAlpha = alpha * 0.8;
          ctx.fillStyle = gradient;
          const half = 9 * alpha + 3;
          ctx.fillRect(blast.x - half, blast.y - 420, half * 2, 420);

          ctx.globalAlpha = alpha;
          ctx.strokeStyle = c1;
          ctx.shadowColor = c2;
          ctx.shadowBlur = 18;
          ctx.lineWidth = 5 * alpha + 1;
          ctx.beginPath();
          ctx.arc(blast.x, blast.y, blast.radius * (1 - alpha * 0.4), 0, TAU);
          ctx.stroke();
          ctx.restore();
        }
      },
    },

    /* ---------- 区域：毒沼 / 游走涡旋（damage 语义为 DPS） ---------- */
    zone: {
      init(w) { w.state.zones = []; },

      fire(w, engine) {
        const s = w.stats;
        const player = engine.player;
        const style = w.def.zoneStyle || 'pool';
        const count = Math.max(1, Math.round(s.count || 1));
        const duration = s.duration * player.stats.durationMultiplier;
        const used = [];
        let spawned = 0;

        for (let i = 0; i < count; i++) {
          let x;
          let y;
          if (style === 'vortex') {
            const target = engine.combat.nearestEnemy(player.position.x, player.position.y, 520);
            if (!target) break;
            x = target.position.x;
            y = target.position.y;
          } else {
            const target = engine.combat.randomEnemy(
              player.position.x, player.position.y, 480,
              (e) => used.indexOf(e) === -1
            );
            if (!target) break;
            used.push(target);
            x = target.position.x;
            y = target.position.y;
          }
          w.state.zones.push({
            x, y,
            life: duration,
            maxLife: duration,
            tickTimer: 0,
            seed: Math.random() * TAU,
          });
          spawned++;
        }
        return spawned > 0;
      },

      tick(w, dt, engine, sys) {
        const s = w.stats;
        const player = engine.player;
        const stats = player.stats;
        const style = w.def.zoneStyle || 'pool';
        const radius = s.radius * stats.areaMultiplier;
        const perTick = s.damage * s.tick * stats.damageMultiplier;
        const zones = w.state.zones;

        for (let i = zones.length - 1; i >= 0; i--) {
          const zone = zones[i];
          zone.life -= dt;
          if (zone.life <= 0) { zones.splice(i, 1); continue; }

          if (style === 'vortex') {
            // 涡旋缓慢游向最近的敌人，并把范围内敌人往中心拽
            const target = engine.combat.nearestEnemy(zone.x, zone.y, 420);
            if (target) {
              const dx = target.position.x - zone.x;
              const dy = target.position.y - zone.y;
              const d = Math.hypot(dx, dy) || 1;
              zone.x += (dx / d) * s.drift * dt;
              zone.y += (dy / d) * s.drift * dt;
            }
          }

          zone.tickTimer -= dt;
          if (zone.tickTimer > 0) continue;
          zone.tickTimer = s.tick;

          engine.combat.forEachInCircle(zone.x, zone.y, radius, (enemy, d) => {
            sys.dealDamage(w, enemy, perTick, {
              preMultiplied: true,
              silent: true,
              angle: Math.atan2(enemy.position.y - zone.y, enemy.position.x - zone.x),
              knockback: 0,
            });
            if (s.pull > 0 && d > 1e-3) {
              const strength = s.pull * s.tick * (1 - enemy.kbResist);
              enemy.position.x -= ((enemy.position.x - zone.x) / d) * strength;
              enemy.position.y -= ((enemy.position.y - zone.y) / d) * strength;
            }
          });
        }
      },

      render(w, ctx, engine, fusion) {
        const [c1, c2] = fusion.elementColors(w.def);
        const radius = w.stats.radius * engine.player.stats.areaMultiplier;
        const style = w.def.zoneStyle || 'pool';
        const t = engine.elapsed;

        for (const zone of w.state.zones) {
          const alpha = MathUtils.clamp(zone.life / 0.6, 0, 1) * 0.85;
          ctx.save();
          ctx.translate(zone.x, zone.y);

          ctx.globalAlpha = alpha * 0.16;
          ctx.fillStyle = c1;
          ctx.beginPath();
          ctx.arc(0, 0, radius, 0, TAU);
          ctx.fill();

          if (style === 'vortex') {
            ctx.globalAlpha = alpha * 0.8;
            ctx.strokeStyle = c2;
            ctx.shadowColor = c2;
            ctx.shadowBlur = 10;
            ctx.lineWidth = 2.4;
            for (let arm = 0; arm < 3; arm++) {
              const start = zone.seed + t * 3 + (arm / 3) * TAU;
              ctx.beginPath();
              ctx.arc(0, 0, radius * (0.35 + arm * 0.24), start, start + 2.1);
              ctx.stroke();
            }
          } else {
            ctx.globalAlpha = alpha * 0.7;
            ctx.strokeStyle = c2;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(0, 0, radius * (0.94 + Math.sin(t * 5 + zone.seed) * 0.05), 0, TAU);
            ctx.stroke();
            // 几颗冒泡
            ctx.fillStyle = c2;
            for (let b = 0; b < 3; b++) {
              const ba = zone.seed + b * 2.1 + t * 1.7;
              const br = radius * (0.25 + ((b * 37 + Math.floor(t * 2)) % 5) * 0.12);
              ctx.globalAlpha = alpha * (0.3 + 0.25 * Math.sin(t * 6 + b));
              ctx.beginPath();
              ctx.arc(Math.cos(ba) * br, Math.sin(ba) * br, 3.4, 0, TAU);
              ctx.fill();
            }
          }
          ctx.restore();
        }
      },
    },

    /* ---------- 连锁：在敌群间跳跃的弧线 ---------- */
    chainStrike: {
      init(w) { w.state.arcs = []; },

      fire(w, engine, sys) {
        const s = w.stats;
        const player = engine.player;
        const combat = engine.combat;
        let current = combat.nearestEnemy(player.position.x, player.position.y, s.range);
        if (!current) return false;

        const chains = Math.max(1, Math.round(s.chains)
          + Math.floor(player.stats.extraProjectiles / 2));
        const roll = sys.rollDamage(w, s.damage);
        const visited = new Set();
        let damage = roll.damage;
        let fromX = player.position.x;
        let fromY = player.position.y;

        for (let i = 0; i <= chains && current; i++) {
          visited.add(current);
          sys.dealDamage(w, current, damage, {
            preMultiplied: true,
            critical: roll.critical,
            angle: Math.atan2(current.position.y - fromY, current.position.x - fromX),
            knockback: 70,
            stun: s.stun,
          });
          w.state.arcs.push({
            x1: fromX, y1: fromY,
            x2: current.position.x, y2: current.position.y,
            life: 0.22, maxLife: 0.22,
          });

          fromX = current.position.x;
          fromY = current.position.y;
          damage *= s.falloff;
          current = combat.nearestEnemy(fromX, fromY, s.jumpRange, (e) => !visited.has(e));
        }

        engine.camera.addTrauma(0.08);
        if (engine.audio) engine.audio.play('zap');
        return true;
      },

      tick(w, dt) {
        const arcs = w.state.arcs;
        for (let i = arcs.length - 1; i >= 0; i--) {
          arcs[i].life -= dt;
          if (arcs[i].life <= 0) arcs.splice(i, 1);
        }
      },

      render(w, ctx, engine, fusion) {
        if (!w.state.arcs.length) return;
        const [c1, c2] = fusion.elementColors(w.def);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';
        for (const arc of w.state.arcs) {
          const alpha = arc.life / arc.maxLife;
          ctx.strokeStyle = c1;
          ctx.shadowColor = c1;
          ctx.shadowBlur = 14;
          ctx.lineWidth = 5;
          ctx.globalAlpha = alpha * 0.3;
          drawJaggedLine(ctx, arc.x1, arc.y1, arc.x2, arc.y2, 22);
          ctx.strokeStyle = c2;
          ctx.lineWidth = 2;
          ctx.globalAlpha = alpha;
          drawJaggedLine(ctx, arc.x1, arc.y1, arc.x2, arc.y2, 14);
        }
        ctx.restore();
      },
    },

    /* ---------- 追踪群：自动索敌的孢子/能量体（复用 Projectile） ---------- */
    seekerSwarm: {
      fire(w, engine, sys, fusion) {
        const s = w.stats;
        const player = engine.player;
        const target = engine.combat.nearestEnemy(player.position.x, player.position.y, s.range);
        if (!target) return false;

        const count = Math.max(1, Math.round(s.count) + player.stats.extraProjectiles);
        const baseAngle = Math.atan2(
          target.position.y - player.position.y,
          target.position.x - player.position.x
        );
        const colors = fusion.elementColors(w.def);

        for (let i = 0; i < count; i++) {
          const spread = count === 1 ? 0 : (i - (count - 1) / 2) * 0.34;
          const roll = sys.rollDamage(w, s.damage);
          sys.spawn(engine, {
            x: player.position.x,
            y: player.position.y,
            angle: baseAngle + spread,
            speed: s.speed * player.stats.projectileSpeedMultiplier,
            damage: roll.damage,
            critical: roll.critical,
            radius: 7 * Math.sqrt(player.stats.areaMultiplier),
            pierce: Math.floor(s.pierce),
            homing: s.homing,
            life: 3 * player.stats.durationMultiplier,
            knockback: 80,
            color: colors[i % 2],
            kind: 'orb',
            weaponId: w.id,
          });
        }
        if (engine.audio) engine.audio.play('shoot');
        return true;
      },
    },
  };

  /* ------------------------------------------------------------------ *
   * 系统本体
   * ------------------------------------------------------------------ */

  class ElementFusion {
    /**
     * @param {object} [options]
     *   weapons  WeaponSystem 实例（缺省时从 engine.weapons 取）
     *   config   覆盖内嵌快照的配置补丁（测试用）
     *   configUrl 外部配置地址（缺省 js/data/fusion-weapons.json）
     */
    constructor(options = {}) {
      this.config = deepMerge(deepClone(DEFAULT_CONFIG), options.config || null);
      this.configUrl = options.configUrl || CONFIG_URL;
      this.weapons = options.weapons || null;
      this.engine = null;

      /** Map<Enemy, { elements, cooldowns, venomTick }> */
      this.marks = new Map();
      /** 延迟结算的反应效果（超载爆炸等） */
      this.effects = [];
      /** 反应产生的临时视觉（折射光束、感电蛛网） */
      this.arcs = [];

      this.stats = { reactions: 0, reactionDamage: 0, fusions: 0, perReaction: {} };
      this._sweepTimer = 0.5;
      this._configLoaded = false;
    }

    onAdd(engine) {
      this.engine = engine;
      engine.fusion = this;
      if (!this.weapons) this.weapons = engine.weapons || null;

      this._tagBaseWeapons();
      this._registerFusionWeapons();
      this._hookWeaponSystem();
      this._hookUpgrades();
      this._fetchExternalConfig();
    }

    reset() {
      this.marks.clear();
      this.effects.length = 0;
      this.arcs.length = 0;
      this.stats = { reactions: 0, reactionDamage: 0, fusions: 0, perReaction: {} };
    }

    /* ================= 配置 ================= */

    /** 给 Round 1 基础武器打上元素标签（不覆盖已有值，方便后续武器自带元素） */
    _tagBaseWeapons() {
      const registry = global.WeaponSystem && global.WeaponSystem.WEAPONS;
      if (!registry) return;
      for (const id in this.config.weaponElements) {
        const def = registry[id];
        if (def && def.element === undefined) def.element = this.config.weaponElements[id];
      }
    }

    /**
     * 把融合武器注册进 WEAPONS 注册表。WeaponSystem.IDS 是加载期快照，
     * 不包含这些 id，因此它们不会出现在「新武器」卡池里，只能通过融合获得；
     * 而升级卡、HUD、伤害统计走的都是注册表本身，全部自动兼容。
     * 幂等：重复调用（外部配置热合并后）会原地同步字段，保留 def 引用。
     */
    _registerFusionWeapons() {
      const registry = global.WeaponSystem && global.WeaponSystem.WEAPONS;
      if (!registry) return;

      for (const id in this.config.weapons) {
        const cfg = this.config.weapons[id];
        const existing = registry[id];
        if (existing && !existing.isFusion) {
          console.warn(`[ElementFusion] 武器 id 冲突，跳过注册: ${id}`);
          continue;
        }
        if (existing) this._syncDef(existing, cfg);
        else registry[id] = this._buildDef(id, cfg);
      }
    }

    _buildDef(id, cfg) {
      const arch = ARCHETYPES[cfg.archetype];
      if (!arch) {
        console.warn(`[ElementFusion] 未知行为原型: ${cfg.archetype} (${id})`);
        return null;
      }
      const fusion = this;
      const def = {
        id,
        isFusion: true,
        element: null, // 融合武器不是任何单元素的融合源
      };
      this._syncDef(def, cfg);

      def.init = function (w) {
        w.state = {};
        if (arch.init) arch.init(w, fusion);
      };
      if (arch.fire) {
        def.fire = function (w, engine, sys) { return arch.fire(w, engine, sys, fusion); };
      }
      if (arch.tick) {
        def.tick = function (w, dt, engine, sys) { arch.tick(w, dt, engine, sys, fusion); };
      }
      if (arch.render) {
        def.render = function (w, ctx, engine) { arch.render(w, ctx, engine, fusion); };
      }
      return def;
    }

    /** 数据字段原地同步（保留 def 与武器实例之间的引用关系） */
    _syncDef(def, cfg) {
      def.name = cfg.name;
      def.icon = cfg.icon;
      def.desc = cfg.desc;
      def.maxLevel = cfg.maxLevel;
      def.elements = cfg.elements.slice();
      def.applies = cfg.applies || 'alternate';
      def.targeting = cfg.targeting;
      def.zoneStyle = cfg.zoneStyle;
      def.base = deepClone(cfg.base);
      def.perLevel = deepClone(cfg.perLevel);
      def.levelText = cfg.levelText.slice();
      return def;
    }

    /**
     * http 环境下加载权威 JSON 并热合并；file:// 或测试环境下 fetch 缺席/失败，
     * 静默停留在内嵌快照上（两者由测试保证一致，行为无差别）。
     */
    _fetchExternalConfig() {
      if (typeof global.fetch !== 'function') return;
      const fusion = this;
      global.fetch(this.configUrl)
        .then((res) => (res && res.ok ? res.json() : null))
        .then((json) => {
          if (!json) return;
          fusion.config = deepMerge(fusion.config, json);
          fusion._configLoaded = true;
          fusion._tagBaseWeapons();
          fusion._registerFusionWeapons();
          if (fusion.weapons) fusion.weapons.recalcAll();
        })
        .catch(() => { /* 离线兜底：内嵌快照继续生效 */ });
    }

    /* ================= 接缝：武器命中 ================= */

    /**
     * 装饰 WeaponSystem 的两个伤害出口：
     *   dealDamage — 直接结算类武器（环绕/光环/链式/区域/新星）
     *   spawn      — 弹道类武器（通过 Projectile.onHit 回调）
     * 只包一层、幂等。若未来 WeaponSystem 提供 damage:dealt 事件，
     * 把这两个装饰替换成事件订阅即可，其余逻辑不变。
     */
    _hookWeaponSystem() {
      const weapons = this.weapons;
      if (!weapons || weapons.__fusionHooks) return;
      weapons.__fusionHooks = true;
      const fusion = this;

      const dealDamage = weapons.dealDamage;
      weapons.dealDamage = function (weapon, enemy, amount, options) {
        const dealt = dealDamage.call(this, weapon, enemy, amount, options);
        if (dealt > 0 && enemy && !enemy.dead) fusion._onWeaponHit(weapon, enemy);
        return dealt;
      };

      const spawn = weapons.spawn;
      weapons.spawn = function (engine, config) {
        return spawn.call(this, engine, fusion._instrumentProjectile(config));
      };
    }

    /** 给带元素的弹道挂 onHit 链，命中后自动打印记 */
    _instrumentProjectile(config) {
      if (!config || !config.weaponId || !this.weapons) return config;
      const weapon = this.weapons.get(config.weaponId);
      const def = weapon && weapon.def;
      if (!def || (!def.element && !def.isFusion)) return config;

      const fusion = this;
      const prevOnHit = config.onHit;
      config.onHit = function (p, enemy, engine) {
        if (prevOnHit) prevOnHit(p, enemy, engine);
        if (!enemy || enemy.dead) return;
        const live = fusion.weapons && fusion.weapons.get(p.weaponId);
        if (live) fusion._onWeaponHit(live, enemy);
        else {
          // 武器已被融合吞掉但弹道仍在飞：退回静态元素表
          const el = fusion.config.weaponElements[p.weaponId];
          if (el) fusion.applyMark(enemy, el, 1);
        }
      };
      return config;
    }

    _onWeaponHit(weapon, enemy) {
      const elements = this._hitElements(weapon);
      for (let i = 0; i < elements.length; i++) {
        this.applyMark(enemy, elements[i], 1);
      }
    }

    /** 本次命中要挂的元素：单元素武器直接挂；融合武器按 applies 策略 */
    _hitElements(weapon) {
      const def = weapon.def;
      if (!def) return EMPTY;
      if (def.isFusion) {
        if (def.applies === 'both') return def.elements;
        weapon._markFlip = !weapon._markFlip;
        return [def.elements[weapon._markFlip ? 0 : 1]];
      }
      return def.element ? [def.element] : EMPTY;
    }

    /* ================= 印记与反应 ================= */

    _markRules(element) {
      const marks = this.config.marks;
      const per = marks.perElement[element];
      return {
        duration: per && per.duration !== undefined ? per.duration : marks.duration,
        maxStacks: per && per.maxStacks !== undefined ? per.maxStacks : marks.maxStacks,
        dps: per ? per.dps || 0 : 0,
        tick: per ? per.tick || 0.5 : 0.5,
      };
    }

    /**
     * 挂一个元素印记并检查反应。
     * @param {object} enemy
     * @param {string} element
     * @param {number} [stacks]
     * @param {object} [opts] { noReact } 反应产物用，禁止递归触发
     */
    applyMark(enemy, element, stacks = 1, opts = {}) {
      if (!enemy || enemy.dead || !this.config.elements[element]) return;
      const now = this.engine ? this.engine.elapsed : 0;

      let state = this.marks.get(enemy);
      if (!state) {
        state = { elements: Object.create(null), cooldowns: Object.create(null), venomTick: 0 };
        this.marks.set(enemy, state);
      }

      const rules = this._markRules(element);
      const mark = state.elements[element]
        || (state.elements[element] = { stacks: 0, expires: 0 });
      mark.stacks = Math.min(rules.maxStacks, mark.stacks + stacks);
      mark.expires = now + rules.duration;

      if (!opts.noReact) this._checkReactions(enemy, state, element);
    }

    _stacksOf(state, element) {
      const mark = state.elements[element];
      return mark ? mark.stacks : 0;
    }

    /** 元素 incoming 落到已有印记的敌人身上：查反应表并触发 */
    _checkReactions(enemy, state, incoming) {
      const now = this.engine ? this.engine.elapsed : 0;
      const maxN = this.config.fusion.maxReactionsPerHit || 1;
      let triggered = 0;

      for (const other in state.elements) {
        if (triggered >= maxN) break;
        if (other === incoming) continue;
        if (state.elements[other].stacks <= 0) continue;

        const key = pairKey(other, incoming);
        const cfg = this.config.reactions[key];
        if (!cfg || !REACTIONS[cfg.id]) continue;
        if (now < (state.cooldowns[key] || 0)) continue;

        state.cooldowns[key] = now + (cfg.cooldown || this.config.fusion.reactionCooldown);
        this._runReaction(enemy, state, cfg);
        triggered++;
      }
    }

    _runReaction(enemy, state, cfg) {
      const engine = this.engine;
      REACTIONS[cfg.id](this, enemy, state, cfg, this._power());
      this._consumeMarks(state, cfg.consume);

      this.stats.reactions++;
      this.stats.perReaction[cfg.id] = (this.stats.perReaction[cfg.id] || 0) + 1;

      if (engine && engine.floatingText) {
        engine.floatingText.spawn(
          enemy.position.x, enemy.position.y - enemy.radius - 20, cfg.name,
          { color: cfg.color, size: 18, life: 0.9, vy: -60 }
        );
      }
      if (engine && engine.events) {
        engine.events.emit('fusion:reaction', { id: cfg.id, name: cfg.name, enemy });
      }
      if (engine && engine.audio) engine.audio.play('crit');
    }

    _consumeMarks(state, consume) {
      if (!consume) return;
      for (const element in consume) {
        const mark = state.elements[element];
        if (!mark) continue;
        mark.stacks = consume[element] === 'all' ? 0 : mark.stacks - consume[element];
        if (mark.stacks <= 0) delete state.elements[element];
      }
    }

    /** 反应强度：玩家增伤 × 局内时间成长（跟随敌人血量曲线，不然后期反应形同挠痒） */
    _power() {
      const engine = this.engine;
      const mult = engine && engine.player ? engine.player.stats.damageMultiplier : 1;
      const elapsed = engine ? engine.elapsed : 0;
      return mult * (1 + (elapsed / 60) * this.config.fusion.growthPerMinute);
    }

    /** 反应伤害统一出口：计入全局伤害统计，但不再挂印记 */
    _hit(enemy, amount, opts = {}) {
      if (!enemy || enemy.dead || !isFinite(amount) || amount <= 0) return 0;
      const dealt = enemy.takeDamage(amount, {
        angle: opts.angle,
        knockback: opts.knockback,
        critical: opts.critical,
        stun: opts.stun,
        silent: opts.silent,
        source: 'fusion',
      });
      this.stats.reactionDamage += dealt;
      if (this.weapons) this.weapons.totalDamage += dealt;
      return dealt;
    }

    /** 溅射：伤害源周围的敌人吃打折伤害（静默，避免飘字刷屏） */
    _splash(source, amount, radius, knockback) {
      const combat = this.engine && this.engine.combat;
      if (!combat || amount <= 0) return;
      combat.forEachInCircle(source.position.x, source.position.y, radius, (enemy) => {
        if (enemy === source) return;
        this._hit(enemy, amount, {
          silent: true,
          knockback,
          angle: Math.atan2(
            enemy.position.y - source.position.y,
            enemy.position.x - source.position.x
          ),
        });
      });
    }

    /** 反应命中的通用视觉 */
    _fx(enemy, color, size) {
      const engine = this.engine;
      if (!engine || !engine.particles) return;
      engine.particles.shockwave(enemy.position.x, enemy.position.y, {
        size: 8, endSize: size * 2, color, life: 0.35,
      });
      engine.particles.burst(enemy.position.x, enemy.position.y, 8, {
        colors: [color, '#ffffff'],
        speedMin: 60, speedMax: 240, lifeMin: 0.12, lifeMax: 0.34,
      });
    }

    /* ================= 融合检测与执行 ================= */

    /** 元素 el 的最佳融合源：等级最高、已达解锁线的非融合武器 */
    _bestSource(element) {
      if (!this.weapons) return null;
      const unlock = this.config.fusion.unlockLevel;
      let best = null;
      for (const w of this.weapons.weapons) {
        if (w.def.isFusion || w.def.element !== element) continue;
        if (w.level < unlock) continue;
        if (!best || w.level > best.level) best = w;
      }
      return best;
    }

    /**
     * 当前可执行的融合列表。
     * @returns {Array<{id:string, cfg:object, sources:[object,object]}>}
     */
    availableFusions() {
      const weapons = this.weapons;
      if (!weapons) return [];

      let fusionCount = 0;
      for (const w of weapons.weapons) if (w.def.isFusion) fusionCount++;
      if (fusionCount >= this.config.fusion.maxFusionWeapons) return [];

      const out = [];
      for (const id in this.config.weapons) {
        if (weapons.has(id)) continue;
        const cfg = this.config.weapons[id];
        const a = this._bestSource(cfg.elements[0]);
        const b = this._bestSource(cfg.elements[1]);
        if (a && b && a !== b) out.push({ id, cfg, sources: [a, b] });
      }
      return out;
    }

    /**
     * 执行融合：吞掉两把源武器（净腾出 1 个槽位），装上融合武器。
     * 源武器超出解锁线的等级按 carryover 折算成融合武器的起始等级。
     * @returns {object|null} 新武器实例
     */
    performFusion(id) {
      const candidate = this.availableFusions().find((c) => c.id === id);
      if (!candidate) return null;

      const weapons = this.weapons;
      const [a, b] = candidate.sources;
      const unlock = this.config.fusion.unlockLevel;
      const bonus = Math.max(0, Math.floor(
        ((a.level - unlock) + (b.level - unlock)) * this.config.fusion.carryover
      ));

      this._removeWeapon(a.id);
      this._removeWeapon(b.id);

      const weapon = weapons.add(id);
      if (!weapon) return null;
      weapon.damageDealt = a.damageDealt + b.damageDealt; // 继承统计，结算面板不断档
      for (let i = 0; i < bonus; i++) weapons.levelUp(id);

      this.stats.fusions++;
      const engine = this.engine;
      if (engine) {
        if (engine.events) {
          engine.events.emit('fusion:performed', {
            id, name: candidate.cfg.name, from: [a.id, b.id], level: weapon.level,
          });
        }
        if (engine.hud && engine.hud.showBanner) {
          engine.hud.showBanner(candidate.cfg.name, '元素融合完成');
        }
        if (engine.player && engine.particles) {
          const colors = this.elementColors(weapon.def);
          engine.particles.shockwave(engine.player.position.x, engine.player.position.y, {
            size: 16, endSize: 340, color: colors[0], life: 0.6,
          });
          engine.particles.shockwave(engine.player.position.x, engine.player.position.y, {
            size: 10, endSize: 260, color: colors[1], life: 0.5,
          });
        }
        if (engine.freeze) engine.freeze(0.12);
        if (engine.camera) engine.camera.addTrauma(0.25);
        if (engine.audio) engine.audio.play('fuse');
      }
      return weapon;
    }

    _removeWeapon(id) {
      const list = this.weapons.weapons;
      for (let i = 0; i < list.length; i++) {
        if (list[i].id === id) { list.splice(i, 1); return; }
      }
    }

    /* ================= 接缝：升级卡池 ================= */

    /**
     * 装饰 UpgradeSystem：
     *   buildPool — 把融合卡按权重混入卡池（尊重 banish）；
     *   roll      — guaranteeCard 开启时，只要有可用融合且本次没抽中，
     *               强制把一张融合卡放进三选一（融合是本作的构筑高光时刻，
     *               不该被 5% 的传说权重埋掉）。
     */
    _hookUpgrades() {
      const upgrades = this.engine && this.engine.upgrades;
      if (!upgrades || upgrades.__fusionHooks) return;
      upgrades.__fusionHooks = true;
      const fusion = this;

      const buildPool = upgrades.buildPool;
      upgrades.buildPool = function () {
        const pool = buildPool.call(this);
        for (const card of fusion.buildFusionCards()) {
          if (!this.banished.has(card.id)) pool.push(card);
        }
        return pool;
      };

      const roll = upgrades.roll;
      upgrades.roll = function (count) {
        const picked = roll.call(this, count);
        if (!fusion.config.fusion.guaranteeCard) return picked;
        if (picked.some((card) => card.kind === 'fusion')) return picked;

        const cards = fusion.buildFusionCards().filter((c) => !this.banished.has(c.id));
        if (cards.length && picked.length) {
          picked[picked.length - 1] = MathUtils.pick(cards);
        }
        return picked;
      };
    }

    /** 生成与 UpgradeSystem 卡片契约兼容的融合卡 */
    buildFusionCards() {
      const out = [];
      const fusionCfg = this.config.fusion;
      for (const candidate of this.availableFusions()) {
        const cfg = candidate.cfg;
        const [a, b] = candidate.sources;
        out.push({
          kind: 'fusion',
          id: `f_${candidate.id}`,
          weaponId: candidate.id,
          name: cfg.name,
          icon: cfg.icon,
          rarity: fusionCfg.cardRarity,
          weight: fusionCfg.cardWeight,
          tag: '元素融合',
          desc: () => `${a.def.name} × ${b.def.name} 融合：${cfg.desc}（腾出 1 个武器槽）`,
          apply: () => { this.performFusion(candidate.id); },
        });
      }
      return out;
    }

    /* ================= 主循环 ================= */

    update(dt, engine) {
      const now = engine.elapsed;
      const doSweep = (this._sweepTimer -= dt) <= 0;
      if (doSweep) this._sweepTimer = 0.5;

      /* 印记维护 + 毒 DoT */
      for (const [enemy, state] of this.marks) {
        if (enemy.dead) { this.marks.delete(enemy); continue; }

        const venom = state.elements.venom;
        if (venom && venom.stacks > 0) {
          state.venomTick -= dt;
          if (state.venomTick <= 0) {
            const rules = this._markRules('venom');
            state.venomTick = rules.tick;
            this._hit(enemy, venom.stacks * rules.dps * rules.tick * this._power(), {
              silent: true,
            });
            if (engine.particles && Math.random() < 0.5) {
              engine.particles.emit({
                x: enemy.position.x + MathUtils.randRange(-6, 6),
                y: enemy.position.y + MathUtils.randRange(-6, 6),
                vy: -MathUtils.randRange(24, 56),
                life: 0.3, size: 3, color: this.elementColor('venom'), drag: 0.9,
              });
            }
          }
        }

        if (doSweep) {
          let alive = 0;
          for (const el in state.elements) {
            const mark = state.elements[el];
            if (mark.expires <= now || mark.stacks <= 0) delete state.elements[el];
            else alive++;
          }
          if (!alive) this.marks.delete(enemy);
        }
      }

      /* 延迟反应效果（超载） */
      for (let i = this.effects.length - 1; i >= 0; i--) {
        const fx = this.effects[i];
        if (fx.enemy && !fx.enemy.dead) {
          fx.x = fx.enemy.position.x;
          fx.y = fx.enemy.position.y;
        }
        fx.timer -= dt;
        if (fx.timer > 0) continue;
        this.effects.splice(i, 1);
        if (fx.type === 'overload') this._explodeOverload(fx);
      }

      /* 反应视觉衰减 */
      for (let i = this.arcs.length - 1; i >= 0; i--) {
        this.arcs[i].life -= dt;
        if (this.arcs[i].life <= 0) this.arcs.splice(i, 1);
      }
    }

    _explodeOverload(fx) {
      const engine = this.engine;
      const cfg = fx.cfg;
      const damage = cfg.damage * fx.power;

      if (engine.combat) {
        engine.combat.forEachInCircle(fx.x, fx.y, cfg.radius, (enemy) => {
          this._hit(enemy, enemy === fx.enemy ? damage : damage * 0.75, {
            silent: enemy !== fx.enemy,
            knockback: cfg.knockback,
            angle: Math.atan2(enemy.position.y - fx.y, enemy.position.x - fx.x),
          });
        });
      }
      if (engine.particles) {
        engine.particles.shockwave(fx.x, fx.y, {
          size: 12, endSize: cfg.radius * 2.2, color: cfg.color, life: 0.42,
        });
        engine.particles.burst(fx.x, fx.y, 14, {
          colors: [cfg.color, '#ffffff'],
          speedMin: 80, speedMax: 340, lifeMin: 0.15, lifeMax: 0.45,
        });
      }
      if (engine.camera) engine.camera.addTrauma(0.18);
      if (engine.audio) engine.audio.play('nova');
    }

    /* ================= 渲染 ================= */

    drawWorld(ctx, engine) {
      /* 超载引信：目标身上的膨胀预警环 */
      for (const fx of this.effects) {
        if (fx.type !== 'overload') continue;
        const k = 1 - MathUtils.clamp(fx.timer / fx.total, 0, 1);
        ctx.save();
        ctx.globalAlpha = 0.4 + k * 0.5;
        ctx.strokeStyle = fx.cfg.color;
        ctx.lineWidth = 2 + k * 3;
        ctx.beginPath();
        ctx.arc(fx.x, fx.y, 14 + k * 22, 0, TAU);
        ctx.stroke();
        ctx.restore();
      }

      /* 反应弧线（折射 / 感电扩散） */
      if (this.arcs.length) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';
        for (const arc of this.arcs) {
          ctx.globalAlpha = arc.life / arc.maxLife;
          ctx.strokeStyle = arc.color;
          ctx.shadowColor = arc.color;
          ctx.shadowBlur = 10;
          ctx.lineWidth = 2;
          drawJaggedLine(ctx, arc.x1, arc.y1, arc.x2, arc.y2, arc.jitter);
        }
        ctx.restore();
      }

      /* 元素印记指示点。战场规模过大时整体跳过（性能守门） */
      if (this.marks.size === 0 || this.marks.size > 400) return;
      const camera = engine.camera;
      ctx.save();
      for (const [enemy, state] of this.marks) {
        if (enemy.dead) continue;
        if (camera && camera.isVisible && !camera.isVisible(enemy.position, enemy.radius + 20)) {
          continue;
        }
        let i = 0;
        let total = 0;
        for (const el in state.elements) if (state.elements[el].stacks > 0) total++;
        if (!total) continue;
        for (const el in state.elements) {
          const mark = state.elements[el];
          if (mark.stacks <= 0) continue;
          const x = enemy.position.x + (i - (total - 1) / 2) * 8;
          const y = enemy.position.y - enemy.radius - 9;
          ctx.fillStyle = this.elementColor(el);
          ctx.globalAlpha = 0.9;
          ctx.beginPath();
          ctx.arc(x, y, 2.2 + Math.min(3, mark.stacks) * 0.5, 0, TAU);
          ctx.fill();
          i++;
        }
      }
      ctx.restore();
    }

    /* ================= 查询辅助 ================= */

    elementColor(element) {
      const cfg = this.config.elements[element];
      return cfg ? cfg.color : '#ffffff';
    }

    /** 融合武器的两个元素色 [主, 副] */
    elementColors(def) {
      return [
        this.elementColor(def.elements ? def.elements[0] : def.element),
        this.elementColor(def.elements ? def.elements[1] : def.element),
      ];
    }

    /** 敌人当前的印记快照（调试 / HUD 用） */
    marksOf(enemy) {
      const state = this.marks.get(enemy);
      return state ? state.elements : null;
    }
  }

  /* ------------------------------------------------------------------ *
   * 自装配
   * index.html 引入本脚本后无需改动 main.js：加载后短暂轮询 global.game，
   * 引擎就绪即 addSystem。手动装配（main.js 里 addSystem）优先，
   * engine.fusion 幂等标记保证不会装两次。
   * ------------------------------------------------------------------ */

  ElementFusion.autoInstall = function () {
    if (typeof global.setInterval !== 'function') return;
    const tryInstall = () => {
      const game = global.game;
      if (!game || !game.engine) return false;
      if (!game.engine.fusion) game.engine.addSystem(new ElementFusion());
      return true;
    };
    if (tryInstall()) return;
    let attempts = 0;
    const timer = global.setInterval(() => {
      if (tryInstall() || ++attempts >= 40) global.clearInterval(timer);
    }, 250);
  };

  ElementFusion.DEFAULT_CONFIG = DEFAULT_CONFIG;
  ElementFusion.REACTIONS = REACTIONS;
  ElementFusion.ARCHETYPES = ARCHETYPES;
  ElementFusion.pairKey = pairKey;
  ElementFusion.CONFIG_URL = CONFIG_URL;
  ElementFusion.AUTO_INSTALL = true;

  global.ElementFusion = ElementFusion;

  if (ElementFusion.AUTO_INSTALL && global.document) ElementFusion.autoInstall();
})(window);
