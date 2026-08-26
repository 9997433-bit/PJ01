/**
 * UpgradeSystem — 升级三选一
 *
 * 玩家升级 → 游戏切到 LEVELUP 状态（引擎在该状态下不推进实体，等于暂停）
 * → 弹出 3 张卡 → 选择后应用 → 队列里还有升级就继续弹，否则恢复游戏。
 *
 * 卡池四类：
 *   1. 新武器（还有空槽时）
 *   2. 已持有武器的升级（未满级）
 *   3. 被动属性（可叠加，有次数上限）
 *   4. 武器进化（Round 3）：两把满级源武器 → 一把进化武器。
 *      配方见 EVOLUTIONS；进化卡是传说级且有保底注入，
 *      两把武器练满的瞬间就该看到回报。
 *
 * 抽卡按权重进行；稀有度决定基础权重与卡面配色，玩家的 luck 会放大
 * 高稀有度出现的概率。重随与消除各给一次，每选满 5 次返还一次重随。
 *
 * 卡片用 DOM 渲染（复用 index.html 的 #upgrade-cards 与 .card 样式）：
 * 文字锐利、天然可点击、键盘可达，比在 canvas 里画 UI 省事得多。
 */
(function (global) {
  'use strict';

  const MathUtils = global.MathUtils;
  const TAU = Math.PI * 2;

  const RARITY = {
    common:    { key: 'common',    label: '普通', weight: 100 },
    rare:      { key: 'rare',      label: '稀有', weight: 44 },
    epic:      { key: 'epic',      label: '史诗', weight: 16 },
    legendary: { key: 'legendary', label: '传说', weight: 5 },
  };

  /**
   * 被动卡。apply(context) 只改 player.stats。
   * maxStacks 控制最多可选次数，避免单一属性无限堆叠。
   */
  const PASSIVES = [
    {
      id: 'p_damage', name: '蛋白强化', icon: '◆', rarity: 'common', maxStacks: 8,
      desc: (c) => `全部伤害 +12%（当前 ${Math.round(c.player.stats.damageMultiplier * 100)}%）`,
      apply: (c) => { c.player.stats.damageMultiplier += 0.12; },
    },
    {
      id: 'p_cooldown', name: '急速孵化', icon: '⚡', rarity: 'rare', maxStacks: 6,
      desc: () => '所有武器冷却 -8%',
      apply: (c) => {
        c.player.stats.cooldownMultiplier = Math.max(0.25, c.player.stats.cooldownMultiplier - 0.08);
      },
    },
    {
      id: 'p_area', name: '范围扩张', icon: '◎', rarity: 'common', maxStacks: 6,
      desc: () => '武器作用范围 +12%',
      apply: (c) => { c.player.stats.areaMultiplier += 0.12; },
    },
    {
      id: 'p_speed', name: '推进器', icon: '➢', rarity: 'common', maxStacks: 6,
      desc: () => '移动速度 +10%',
      apply: (c) => { c.player.stats.speed *= 1.1; },
    },
    {
      id: 'p_maxhp', name: '强化蛋壳', icon: '❤', rarity: 'common', maxStacks: 8,
      desc: () => '生命上限 +26 并立即回复等量生命',
      apply: (c) => { c.player.stats.maxHealth += 26; c.player.heal(26, { silent: true }); },
    },
    {
      id: 'p_regen', name: '纳米修复', icon: '✚', rarity: 'rare', maxStacks: 5,
      desc: (c) => `每秒回复 +0.8 生命（当前 ${c.player.stats.regen.toFixed(1)}/s）`,
      apply: (c) => { c.player.stats.regen += 0.8; },
    },
    {
      id: 'p_armor', name: '合金镀层', icon: '▣', rarity: 'rare', maxStacks: 5,
      desc: (c) => `每次受击减伤 +2（当前 ${c.player.stats.armor}）`,
      apply: (c) => { c.player.stats.armor += 2; },
    },
    {
      id: 'p_pickup', name: '磁力场', icon: '◉', rarity: 'common', maxStacks: 5,
      desc: () => '经验拾取范围 +36%',
      apply: (c) => { c.player.stats.pickupRadius *= 1.36; },
    },
    {
      id: 'p_crit', name: '暴击芯片', icon: '✦', rarity: 'rare', maxStacks: 6,
      desc: (c) => `暴击率 +7%（当前 ${Math.round(c.player.stats.critChance * 100)}%）`,
      apply: (c) => {
        c.player.stats.critChance = Math.min(0.85, c.player.stats.critChance + 0.07);
      },
    },
    {
      id: 'p_critmult', name: '致命一击', icon: '✧', rarity: 'epic', maxStacks: 4,
      desc: (c) => `暴击伤害 +45%（当前 ${Math.round(c.player.stats.critMultiplier * 100)}%）`,
      apply: (c) => { c.player.stats.critMultiplier += 0.45; },
    },
    {
      id: 'p_amount', name: '多重投射', icon: '⋈', rarity: 'epic', maxStacks: 3,
      desc: () => '多发类武器额外 +1 发',
      apply: (c) => { c.player.stats.extraProjectiles += 1; },
    },
    {
      id: 'p_projspeed', name: '高速弹道', icon: '➤', rarity: 'common', maxStacks: 4,
      desc: () => '弹道速度 +15%',
      apply: (c) => { c.player.stats.projectileSpeedMultiplier += 0.15; },
    },
    {
      id: 'p_duration', name: '持久力场', icon: '⏳', rarity: 'common', maxStacks: 4,
      desc: () => '效果持续时间 +15%',
      apply: (c) => { c.player.stats.durationMultiplier += 0.15; },
    },
    {
      id: 'p_xp', name: '经验虹吸', icon: '⬢', rarity: 'rare', maxStacks: 4,
      desc: () => '获得经验 +22%',
      apply: (c) => { c.player.stats.xpMultiplier += 0.22; },
    },
    {
      id: 'p_thorns', name: '碎壳荆棘', icon: '✹', rarity: 'epic', maxStacks: 4,
      desc: (c) => `被撞击时反弹 14 点伤害（当前 ${c.player.stats.thorns}）`,
      apply: (c) => { c.player.stats.thorns += 14; },
    },
    {
      id: 'p_dash', name: '相位引擎', icon: '⟫', rarity: 'epic', maxStacks: 3,
      desc: () => '冲刺冷却 -26%，冲刺速度 +12%',
      apply: (c) => {
        c.player.stats.dashCooldown *= 0.74;
        c.player.stats.dashSpeed *= 1.12;
      },
    },
    {
      id: 'p_luck', name: '幸运蛋', icon: '☘', rarity: 'rare', maxStacks: 4,
      desc: () => '幸运 +15%：更容易刷出高稀有度选项与稀有掉落',
      apply: (c) => { c.player.stats.luck += 0.15; },
    },
    {
      id: 'p_greed', name: '孤注一掷', icon: '⚔', rarity: 'legendary', maxStacks: 1,
      desc: () => '伤害 +50%，但生命上限 -20',
      apply: (c) => {
        c.player.stats.damageMultiplier += 0.5;
        c.player.stats.maxHealth = Math.max(20, c.player.stats.maxHealth - 20);
        c.player.health = Math.min(c.player.health, c.player.stats.maxHealth);
      },
    },
  ];

  /** 卡池被抽干时的保底卡，保证永远有得选 */
  const SUPPLY_CARD = {
    id: 'supply', name: '应急补给', icon: '✚', rarity: 'common', kind: 'supply',
    tag: '补给', maxStacks: Infinity,
    desc: () => '立即回复 45% 生命',
    apply: (c) => { c.player.heal(c.player.stats.maxHealth * 0.45); },
  };

  /* ------------------------------------------------------------------ *
   * 武器进化（Round 3）
   *
   * 与 R2 元素融合的分工：融合看「元素对 + 解锁等级」，吃两把不同元素
   * 的 5 级武器；进化看「固定配方 + 双满级」，是把一对武器练到顶之后
   * 的终局奖励。两套系统互不依赖，进化武器与融合武器一样注册进
   * WeaponSystem.WEAPONS 但不进加载期快照 IDS，因此永远不会混进
   * 「新武器」卡池，只能通过配方获得。
   *
   * 进化武器都是 maxLevel 1 的最终形态：吃掉两把满级武器（净腾出
   * 1 个武器槽）换来一把数值与机制双重超模的传说武器。
   * ------------------------------------------------------------------ */

  /** 电弧折线（奥术风暴渲染用） */
  function drawJagged(ctx, x1, y1, x2, y2, jitter) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    for (let i = 1; i < 5; i++) {
      const k = i / 5;
      const j = (Math.random() - 0.5) * jitter * (1 - Math.abs(k - 0.5) * 2);
      ctx.lineTo(x1 + dx * k + nx * j, y1 + dy * k + ny * j);
    }
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  const EVOLVED_WEAPONS = {

    /* ---------- 千刃奇点 = 飞刀环绕 + 回旋蛋镖 ---------- */
    bladeMaelstrom: {
      id: 'bladeMaelstrom',
      name: '千刃奇点',
      icon: '❋',
      desc: '巨型刃环绞碎近身之敌，并周期性向四面八方掷出穿透刃镖',
      isEvolved: true,
      maxLevel: 1,
      base: {
        damage: 30, count: 6, orbit: 130, spin: 3.1, hitCooldown: 0.34, knockback: 210,
        cooldown: 3.2, volley: 6, speed: 640, flyOut: 0.55,
      },
      perLevel: {},
      levelText: ['', '飞刀环绕与回旋蛋镖的最终形态'],

      init(w) {
        w.phase = 0;
        w.hitLog = new Map();
        w.blades = [];
        w.cleanupTimer = 3;
      },

      tick(w, dt, engine, sys) {
        const s = w.stats;
        const player = engine.player;
        const stats = player.stats;
        w.phase += s.spin * dt;

        const count = Math.max(1, Math.round(s.count));
        const area = stats.areaMultiplier;
        const orbitRadius = s.orbit * area;
        const bladeRadius = 18 * Math.sqrt(area);
        const now = engine.elapsed;

        w.blades.length = 0;
        for (let i = 0; i < count; i++) {
          const a = w.phase + (i / count) * TAU;
          const bx = player.position.x + Math.cos(a) * orbitRadius;
          const by = player.position.y + Math.sin(a) * orbitRadius;
          w.blades.push(bx, by, a);

          engine.combat.forEachInCircle(bx, by, bladeRadius, (enemy, d) => {
            if (d > bladeRadius + enemy.radius) return;
            const next = w.hitLog.get(enemy);
            if (next !== undefined && now < next) return;
            w.hitLog.set(enemy, now + s.hitCooldown);
            sys.dealDamage(w, enemy, s.damage, { angle: a + Math.PI / 2, knockback: s.knockback });
          });
        }

        w.cleanupTimer -= dt;
        if (w.cleanupTimer <= 0) {
          w.cleanupTimer = 3;
          for (const enemy of w.hitLog.keys()) if (enemy.dead) w.hitLog.delete(enemy);
        }
      },

      /** 周期性向全场均匀掷出一圈回旋刃镖 */
      fire(w, engine, sys) {
        const s = w.stats;
        const player = engine.player;
        if (!engine.combat.nearestEnemy(player.position.x, player.position.y, 720)) return false;

        const volley = Math.max(3, Math.round(s.volley) + player.stats.extraProjectiles);
        const offset = Math.random() * TAU;
        for (let i = 0; i < volley; i++) {
          const roll = sys.rollDamage(w, s.damage * 1.4);
          sys.spawn(engine, {
            x: player.position.x,
            y: player.position.y,
            angle: offset + (i / volley) * TAU,
            speed: s.speed * player.stats.projectileSpeedMultiplier,
            damage: roll.damage,
            critical: roll.critical,
            radius: 12 * Math.sqrt(player.stats.areaMultiplier),
            kind: 'boomerang',
            owner: player,
            returnAfter: s.flyOut * player.stats.durationMultiplier,
            life: 6,
            knockback: 150,
            spin: 18,
            color: '#ffd45e',
            weaponId: w.id,
          });
        }
        if (engine.audio) engine.audio.play('throw');
        return true;
      },

      render(w, ctx, engine) {
        const area = engine.player.stats.areaMultiplier;
        const r = 18 * Math.sqrt(area);
        const t = engine.elapsed;

        for (let i = 0; i < w.blades.length; i += 3) {
          ctx.save();
          ctx.translate(w.blades[i], w.blades[i + 1]);
          ctx.rotate(w.blades[i + 2] + t * 10);
          ctx.shadowColor = '#ffd45e';
          ctx.shadowBlur = 16;
          ctx.fillStyle = '#fff2c4';
          ctx.strokeStyle = '#b8860b';
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(r * 1.6, 0);
          ctx.lineTo(0, r * 0.6);
          ctx.lineTo(-r * 1.1, 0);
          ctx.lineTo(0, -r * 0.6);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }
      },
    },

    /* ---------- 奥术风暴 = 魔法弹 + 闪电链 ---------- */
    arcaneTempest: {
      id: 'arcaneTempest',
      name: '奥术风暴',
      icon: '✦',
      desc: '齐射追踪奥术弹，每次命中都炸出在敌群间跳跃的电弧',
      isEvolved: true,
      maxLevel: 1,
      base: {
        damage: 32, cooldown: 1.1, count: 3, speed: 560, pierce: 1, homing: 6, range: 620,
        chains: 3, jumpRange: 200, falloff: 0.8, stun: 0.1,
      },
      perLevel: {},
      levelText: ['', '魔法弹与闪电链的最终形态'],

      init(w) { w.arcs = []; },

      fire(w, engine, sys) {
        const s = w.stats;
        const player = engine.player;
        const target = engine.combat.nearestEnemy(player.position.x, player.position.y, s.range);
        if (!target) return false;

        const count = Math.max(1, Math.round(s.count) + player.stats.extraProjectiles);
        const baseAngle = Math.atan2(
          target.position.y - player.position.y,
          target.position.x - player.position.x
        );

        // 命中回调：从被命中的敌人向外跳电弧
        const chainFrom = (p, enemy, eng) => {
          if (!enemy || !eng.combat) return;
          const visited = new Set([enemy]);
          let current = enemy;
          let damage = s.damage * s.falloff;
          for (let j = 0; j < Math.round(s.chains); j++) {
            const next = eng.combat.nearestEnemy(
              current.position.x, current.position.y, s.jumpRange,
              (e) => !visited.has(e)
            );
            if (!next) break;
            visited.add(next);
            sys.dealDamage(w, next, damage, {
              angle: Math.atan2(
                next.position.y - current.position.y,
                next.position.x - current.position.x
              ),
              knockback: 60,
              stun: s.stun,
            });
            w.arcs.push({
              x1: current.position.x, y1: current.position.y,
              x2: next.position.x, y2: next.position.y,
              life: 0.2, maxLife: 0.2,
            });
            current = next;
            damage *= s.falloff;
          }
        };

        for (let i = 0; i < count; i++) {
          const spread = count === 1 ? 0 : (i - (count - 1) / 2) * 0.24;
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
            knockback: 100,
            color: '#b78bff',
            kind: 'bolt',
            weaponId: w.id,
            onHit: chainFrom,
          });
        }
        if (engine.audio) engine.audio.play('zap');
        return true;
      },

      tick(w, dt) {
        for (let i = w.arcs.length - 1; i >= 0; i--) {
          w.arcs[i].life -= dt;
          if (w.arcs[i].life <= 0) w.arcs.splice(i, 1);
        }
      },

      render(w, ctx) {
        if (!w.arcs.length) return;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';
        for (const arc of w.arcs) {
          const alpha = arc.life / arc.maxLife;
          ctx.strokeStyle = '#d9c2ff';
          ctx.shadowColor = '#b78bff';
          ctx.shadowBlur = 14;
          ctx.lineWidth = 5;
          ctx.globalAlpha = alpha * 0.3;
          drawJagged(ctx, arc.x1, arc.y1, arc.x2, arc.y2, 22);
          ctx.lineWidth = 2;
          ctx.globalAlpha = alpha;
          drawJagged(ctx, arc.x1, arc.y1, arc.x2, arc.y2, 14);
        }
        ctx.restore();
      },
    },

    /* ---------- 冰火湮灭 = 火焰喷射 + 霜爆冲击 ---------- */
    frostburnCataclysm: {
      id: 'frostburnCataclysm',
      name: '冰火湮灭',
      icon: '❉',
      desc: '身周展开冰火两极力场：持续灼烧一切来敌，并周期炸开冻结新星',
      isEvolved: true,
      maxLevel: 1,
      base: {
        damage: 24, radius: 175, tick: 0.4, burnDps: 12, burnTime: 2.6,
        cooldown: 4.2, pulseDamage: 64, knockback: 380, slow: 0.5, slowTime: 2.4,
      },
      perLevel: {},
      levelText: ['', '火焰喷射与霜爆冲击的最终形态'],

      init(w) {
        w.rings = [];
        w.dotTimer = 0;
      },

      /** 常驻力场：范围内持续灼烧（damage 语义为 DPS，按 tick 结算） */
      tick(w, dt, engine, sys) {
        const s = w.stats;
        const player = engine.player;
        const stats = player.stats;
        const radius = s.radius * stats.areaMultiplier;

        w.dotTimer -= dt;
        if (w.dotTimer <= 0) {
          w.dotTimer = s.tick;
          const perTick = s.damage * s.tick;
          engine.combat.forEachInCircle(player.position.x, player.position.y, radius, (enemy) => {
            sys.dealDamage(w, enemy, perTick, {
              silent: true,
              angle: Math.atan2(
                enemy.position.y - player.position.y,
                enemy.position.x - player.position.x
              ),
              knockback: 0,
            });
            enemy.applyBurn(s.burnDps * stats.damageMultiplier, s.burnTime);
          });
        }

        for (let i = w.rings.length - 1; i >= 0; i--) {
          const ring = w.rings[i];
          ring.life -= dt;
          ring.radius = ring.maxRadius * MathUtils.easeOutCubic(1 - ring.life / ring.maxLife);
          if (ring.life <= 0) w.rings.splice(i, 1);
        }
      },

      /** 周期冻结新星：击退 + 深度减速 */
      fire(w, engine, sys) {
        const s = w.stats;
        const player = engine.player;
        const radius = s.radius * player.stats.areaMultiplier;
        const hits = engine.combat.queryCircle(player.position.x, player.position.y, radius);
        if (!hits.length) return false;

        const roll = sys.rollDamage(w, s.pulseDamage);
        for (const enemy of hits) {
          sys.dealDamage(w, enemy, roll.damage, {
            critical: roll.critical,
            angle: Math.atan2(
              enemy.position.y - player.position.y,
              enemy.position.x - player.position.x
            ),
            knockback: s.knockback,
          });
          enemy.applySlow(
            MathUtils.clamp(s.slow, 0.25, 0.95),
            s.slowTime * player.stats.durationMultiplier
          );
        }

        w.rings.push({
          x: player.position.x, y: player.position.y,
          radius: 12, maxRadius: radius, life: 0.5, maxLife: 0.5,
        });
        engine.camera.addTrauma(0.24);
        engine.particles.shockwave(player.position.x, player.position.y, {
          size: 14, endSize: radius * 2, color: '#a8ecff', life: 0.5,
        });
        engine.particles.shockwave(player.position.x, player.position.y, {
          size: 10, endSize: radius * 1.6, color: '#ff8a3d', life: 0.42,
        });
        if (engine.audio) engine.audio.play('nova');
        return true;
      },

      render(w, ctx, engine) {
        const player = engine.player;
        if (!player) return;
        const radius = w.stats.radius * player.stats.areaMultiplier;
        const t = engine.elapsed;

        // 冰火双色的旋转力场边界
        ctx.save();
        ctx.translate(player.position.x, player.position.y);
        ctx.rotate(t * 0.7);
        ctx.globalAlpha = 0.4;
        ctx.lineWidth = 2.2;
        ctx.setLineDash([20, 16]);
        ctx.strokeStyle = '#ff8a3d';
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, TAU);
        ctx.stroke();
        ctx.rotate(Math.PI / 6);
        ctx.strokeStyle = '#a8ecff';
        ctx.beginPath();
        ctx.arc(0, 0, radius * 0.94, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        for (const ring of w.rings) {
          const alpha = ring.life / ring.maxLife;
          ctx.save();
          ctx.globalAlpha = alpha * 0.85;
          ctx.strokeStyle = '#a8ecff';
          ctx.shadowColor = '#ff8a3d';
          ctx.shadowBlur = 18;
          ctx.lineWidth = 6 * alpha + 1;
          ctx.beginPath();
          ctx.arc(ring.x, ring.y, ring.radius, 0, TAU);
          ctx.stroke();
          ctx.restore();
        }
      },
    },
  };

  /**
   * 进化配方：sources 的两把武器都到各自 maxLevel 后可进化为 id 对应的武器。
   * 六把基础武器两两成对，全部覆盖，不存在练满了却没有出路的武器。
   */
  const EVOLUTIONS = [
    { id: 'bladeMaelstrom', sources: ['knifeOrbit', 'boomerang'] },
    { id: 'arcaneTempest', sources: ['magicBolt', 'chainBolt'] },
    { id: 'frostburnCataclysm', sources: ['flamethrower', 'frostNova'] },
  ];

  /**
   * 把进化武器注册进 WeaponSystem.WEAPONS。与融合武器同一策略：
   * 不进加载期快照 IDS，因此不会作为「新武器」出现在卡池里。
   * 幂等，可在脚本加载与 onAdd 两个时机安全重复调用。
   */
  function registerEvolvedWeapons() {
    const registry = global.WeaponSystem && global.WeaponSystem.WEAPONS;
    if (!registry) return false;
    for (const id in EVOLVED_WEAPONS) {
      const existing = registry[id];
      if (existing && existing !== EVOLVED_WEAPONS[id] && !existing.isEvolved) {
        console.warn(`[UpgradeSystem] 武器 id 冲突，跳过进化武器注册: ${id}`);
        continue;
      }
      registry[id] = EVOLVED_WEAPONS[id];
    }
    return true;
  }

  class UpgradeSystem {
    /**
     * @param {object} [options] { weapons, cardCount }
     */
    constructor(options = {}) {
      this.weapons = options.weapons || null;
      this.cardCount = options.cardCount || 3;

      this.engine = null;
      this.stacks = new Map();
      this.banished = new Set();
      this.rerolls = 1;
      this.banishes = 1;
      this.picks = 0;
      this.choices = [];
      this.evolutionCount = 0;
    }

    onAdd(engine) {
      this.engine = engine;
      engine.upgrades = this;
      if (!this.weapons && engine.weapons) this.weapons = engine.weapons;
      registerEvolvedWeapons();
    }

    reset() {
      this.stacks.clear();
      this.banished.clear();
      this.rerolls = 1;
      this.banishes = 1;
      this.picks = 0;
      this.choices.length = 0;
      this.evolutionCount = 0;
    }

    getStacks(id) { return this.stacks.get(id) || 0; }

    /* ================= 卡池 ================= */

    _weaponSystem() {
      return this.weapons || (this.engine && this.engine.weapons) || null;
    }

    /**
     * 卡面文案与 apply 都会直接读写 areaMultiplier / critChance 这类扩展属性，
     * 而它们由 WeaponSystem 在首帧补齐。这里先兜一次底，
     * 避免「首帧之前就升级」时把属性算成 NaN。
     */
    _ensureStats() {
      const player = this.engine && this.engine.player;
      if (player && global.WeaponSystem) global.WeaponSystem.ensureCombatStats(player);
    }

    /** 组装当前所有可选项 */
    buildPool() {
      this._ensureStats();
      const pool = [];
      const weapons = this._weaponSystem();
      if (!weapons) return pool;

      // 1. 已有武器升级
      for (const weapon of weapons.weapons) {
        if (weapon.level >= weapon.def.maxLevel) continue;
        const nextLevel = weapon.level + 1;
        pool.push({
          kind: 'weaponLevel',
          id: `w_${weapon.id}`,
          weaponId: weapon.id,
          name: weapon.def.name,
          icon: weapon.def.icon,
          rarity: weapon.level >= 5 ? 'epic' : weapon.level >= 3 ? 'rare' : 'common',
          weight: 34,
          tag: `Lv.${weapon.level} → Lv.${nextLevel}`,
          desc: () => weapons.levelDescription(weapon.id, nextLevel),
          apply: (c) => { c.weapons.levelUp(weapon.id); },
        });
      }

      // 2. 新武器
      if (!weapons.isFull) {
        for (const id of global.WeaponSystem.IDS) {
          if (weapons.has(id)) continue;
          const def = global.WEAPONS[id];
          pool.push({
            kind: 'weaponNew',
            id: `n_${id}`,
            weaponId: id,
            name: def.name,
            icon: def.icon,
            rarity: 'rare',
            weight: 32,
            tag: '新武器',
            desc: () => def.desc,
            apply: (c) => { c.weapons.add(id); },
          });
        }
      }

      // 3. 被动
      for (const passive of PASSIVES) {
        const taken = this.getStacks(passive.id);
        if (taken >= passive.maxStacks) continue;
        pool.push({
          kind: 'passive',
          id: passive.id,
          name: passive.name,
          icon: passive.icon,
          rarity: passive.rarity,
          weight: 22,
          tag: taken > 0 ? `${taken}/${passive.maxStacks}` : '被动',
          desc: passive.desc,
          apply: passive.apply,
        });
      }

      // 4. 武器进化
      for (const card of this._evolutionCards()) pool.push(card);

      return pool.filter((card) => !this.banished.has(card.id));
    }

    /** 幸运放大高稀有度权重 */
    _weightOf(card, luck) {
      const rarity = RARITY[card.rarity] || RARITY.common;
      const boost = card.rarity === 'common'
        ? 1
        : 1 + luck * (card.rarity === 'legendary' ? 2.4 : 1.4);
      return card.weight * (rarity.weight / 100) * boost;
    }

    /** 抽 count 张互不重复的卡 */
    roll(count = this.cardCount) {
      const pool = this.buildPool();
      const player = this.engine && this.engine.player;
      const luck = player && player.stats ? (player.stats.luck || 0) : 0;
      const picked = [];

      const n = Math.min(count, pool.length);
      for (let i = 0; i < n; i++) {
        let total = 0;
        for (const card of pool) total += this._weightOf(card, luck);
        if (total <= 0) break;

        let roll = Math.random() * total;
        for (let j = 0; j < pool.length; j++) {
          roll -= this._weightOf(pool[j], luck);
          if (roll <= 0) { picked.push(pool.splice(j, 1)[0]); break; }
        }
      }

      // 进化保底：配方已凑齐却没抽中时，强制占据第一张卡。
      // 双满级是玩家整局的投资，这个回报不该被权重埋掉。
      if (picked.length && !picked.some((card) => card.kind === 'evolution')) {
        const evolutions = this._evolutionCards().filter((c) => !this.banished.has(c.id));
        if (evolutions.length) {
          picked[0] = evolutions[Math.floor(Math.random() * evolutions.length)];
        }
      }

      if (!picked.length) picked.push(SUPPLY_CARD);
      this.choices = picked;
      return picked;
    }

    /**
     * 应用一张卡。
     * @param {object} card
     * @param {object} context { player, engine, weapons }
     */
    apply(card, context) {
      this._ensureStats();
      const ctx = context || this.context();
      card.apply(ctx);
      this.stacks.set(card.id, this.getStacks(card.id) + 1);
      this.picks++;
      // 每选满 5 次返还一次重随，鼓励中后期继续使用
      if (this.picks % 5 === 0) this.rerolls++;
      if (ctx.weapons) ctx.weapons.recalcAll();
      if (ctx.engine) ctx.engine.events.emit('upgrade:applied', card);
    }

    context() {
      const engine = this.engine;
      return {
        player: engine ? engine.player : null,
        engine,
        weapons: this._weaponSystem(),
      };
    }

    /* ================= 重随 / 消除 ================= */

    canReroll() { return this.rerolls > 0; }

    reroll() {
      if (this.rerolls <= 0) return null;
      this.rerolls--;
      return this.roll();
    }

    /** 消除一张卡：本局不再出现，并立刻补抽 */
    banish(card) {
      if (this.banishes <= 0 || !card || card.kind === 'supply') return null;
      this.banishes--;
      this.banished.add(card.id);
      return this.roll();
    }

    /* ================= 武器进化 ================= */

    /**
     * 当前可执行的进化列表。
     * 条件：进化武器尚未持有，且两把源武器都在手并各自满级。
     * @returns {Array<{recipe:object, def:object, sources:[object,object]}>}
     */
    availableEvolutions() {
      const weapons = this._weaponSystem();
      if (!weapons) return [];

      const out = [];
      for (const recipe of EVOLUTIONS) {
        if (weapons.has(recipe.id)) continue;
        const a = weapons.get(recipe.sources[0]);
        const b = weapons.get(recipe.sources[1]);
        if (!a || !b) continue;
        if (a.level < a.def.maxLevel || b.level < b.def.maxLevel) continue;
        out.push({ recipe, def: EVOLVED_WEAPONS[recipe.id], sources: [a, b] });
      }
      return out;
    }

    /** 生成与卡片契约兼容的进化卡 */
    _evolutionCards() {
      const cards = [];
      for (const candidate of this.availableEvolutions()) {
        const def = candidate.def;
        const [a, b] = candidate.sources;
        cards.push({
          kind: 'evolution',
          id: `e_${def.id}`,
          weaponId: def.id,
          name: def.name,
          icon: def.icon,
          rarity: 'legendary',
          weight: 70,
          tag: '武器进化',
          desc: () => `${a.def.name} × ${b.def.name} 进化：${def.desc}（腾出 1 个武器槽）`,
          apply: (c) => { this.performEvolution(def.id, c); },
        });
      }
      return cards;
    }

    /**
     * 执行进化：吞掉两把满级源武器（净腾出 1 个槽位），装上进化武器。
     * @param {string} id 进化武器 id
     * @param {object} [context]
     * @returns {object|null} 新武器实例
     */
    performEvolution(id, context) {
      const weapons = this._weaponSystem();
      const candidate = this.availableEvolutions().find((c) => c.def.id === id);
      if (!weapons || !candidate) return null;

      const [a, b] = candidate.sources;
      this._removeWeapon(weapons, a.id);
      this._removeWeapon(weapons, b.id);

      const evolved = weapons.add(id);
      if (!evolved) return null;
      // 继承两把源武器的伤害统计，结算面板不断档
      evolved.damageDealt = a.damageDealt + b.damageDealt;
      this.evolutionCount++;

      const engine = (context && context.engine) || this.engine;
      if (engine) {
        if (engine.events) {
          engine.events.emit('weapon:evolved', {
            id, name: candidate.def.name, from: [a.id, b.id],
          });
        }
        if (engine.hud && engine.hud.showBanner) {
          engine.hud.showBanner(candidate.def.name, '武器进化完成');
        }
        if (engine.player && engine.particles) {
          engine.particles.shockwave(engine.player.position.x, engine.player.position.y, {
            size: 18, endSize: 360, color: '#ffd45e', life: 0.65,
          });
          engine.particles.shockwave(engine.player.position.x, engine.player.position.y, {
            size: 12, endSize: 280, color: '#ffffff', life: 0.5,
          });
        }
        if (engine.freeze) engine.freeze(0.12);
        if (engine.camera) engine.camera.addTrauma(0.28);
        if (engine.audio) engine.audio.play('fuse');
      }
      return evolved;
    }

    _removeWeapon(weapons, id) {
      const list = weapons.weapons;
      for (let i = 0; i < list.length; i++) {
        if (list[i].id === id) { list.splice(i, 1); return; }
      }
    }

    /**
     * 全部配方的进度快照（进化图鉴 UI 与测试用）。
     * state: done（已进化）/ ready（可进化）/ progress（收集中）/ locked（未持有）
     */
    recipeProgress() {
      const weapons = this._weaponSystem();
      const registry = global.WeaponSystem ? global.WeaponSystem.WEAPONS : {};

      return EVOLUTIONS.map((recipe) => {
        const def = EVOLVED_WEAPONS[recipe.id];
        const owned = weapons ? weapons.has(recipe.id) : false;
        const sources = recipe.sources.map((sourceId) => {
          const sourceDef = registry[sourceId] || { name: sourceId, icon: '?', maxLevel: 1 };
          const held = weapons ? weapons.get(sourceId) : null;
          return {
            id: sourceId,
            name: sourceDef.name,
            icon: sourceDef.icon,
            level: held ? held.level : 0,
            maxLevel: sourceDef.maxLevel,
            owned: !!held,
            maxed: !!held && held.level >= sourceDef.maxLevel,
          };
        });

        let state = 'locked';
        if (owned) state = 'done';
        else if (sources.every((s) => s.maxed)) state = 'ready';
        else if (sources.some((s) => s.owned)) state = 'progress';

        return {
          id: recipe.id,
          name: def.name,
          icon: def.icon,
          desc: def.desc,
          state,
          sources,
        };
      });
    }

    /**
     * 进化配方 UI：把全部配方渲染进容器（暂停面板的「进化图鉴」）。
     * @param {HTMLElement} container
     * @returns {Array} recipeProgress 快照
     */
    renderRecipes(container) {
      const rows = this.recipeProgress();
      if (!container) return rows;
      container.innerHTML = '';

      const STATE_LABEL = {
        locked: '未持有', progress: '收集中', ready: '可进化!', done: '已进化',
      };

      for (const row of rows) {
        const el = document.createElement('div');
        el.className = `recipe is-${row.state}`;

        const parts = row.sources.map((s) => `
          <span class="recipe__part${s.maxed ? ' is-maxed' : ''}">
            <i>${s.icon}</i><b>${s.name}</b><em>${s.level}/${s.maxLevel}</em>
          </span>
        `).join('<span class="recipe__op">+</span>');

        el.innerHTML = `
          ${parts}
          <span class="recipe__op recipe__op--arrow">→</span>
          <span class="recipe__result"><i>${row.icon}</i><b>${row.name}</b></span>
          <span class="recipe__state">${STATE_LABEL[row.state]}</span>
        `;
        container.appendChild(el);
      }
      return rows;
    }

    /* ================= 卡片 UI ================= */

    /**
     * 把当前 choices 渲染进容器。
     * @param {HTMLElement} container
     * @param {object} context
     * @param {(card:object, index:number) => void} onPick
     */
    renderCards(container, context, onPick) {
      if (!container) return this.choices;
      container.innerHTML = '';

      this.choices.forEach((card, index) => {
        const rarity = RARITY[card.rarity] || RARITY.common;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `card card--${rarity.key}`;
        button.style.animationDelay = `${index * 70}ms`;
        button.setAttribute('aria-label', `${card.name} · ${rarity.label}`);

        const meta = card.tag || rarity.label;
        button.innerHTML = `
          <span class="card__key">${index + 1}</span>
          <span class="card__icon">${card.icon}</span>
          <span class="card__name">${card.name}</span>
          <span class="card__desc">${card.desc(context)}</span>
          <span class="card__meta">${rarity.label} · ${meta}</span>
        `;

        button.addEventListener('click', () => onPick(card, index));
        // 右键消除：把不想要的选项永久踢出本局卡池
        button.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          if (this.banish(card)) this.renderCards(container, context, onPick);
        });

        container.appendChild(button);
      });

      return this.choices;
    }
  }

  UpgradeSystem.PASSIVES = PASSIVES;
  UpgradeSystem.RARITY = RARITY;
  UpgradeSystem.SUPPLY_CARD = SUPPLY_CARD;
  UpgradeSystem.EVOLUTIONS = EVOLUTIONS;
  UpgradeSystem.EVOLVED_WEAPONS = EVOLVED_WEAPONS;
  UpgradeSystem.registerEvolvedWeapons = registerEvolvedWeapons;

  // WeaponSystem 已按 index.html 的顺序先行加载，这里立即注册进化武器；
  // 若加载顺序被打乱，onAdd 里还会兜底重试一次。
  registerEvolvedWeapons();

  global.UpgradeSystem = UpgradeSystem;
  // 兼容早期命名
  global.UpgradePool = UpgradeSystem;
})(window);
