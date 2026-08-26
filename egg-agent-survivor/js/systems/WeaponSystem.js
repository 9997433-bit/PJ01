/**
 * WeaponSystem — 自动武器
 *
 * 所有武器都自动开火，玩家只负责走位。每把武器是一份数据定义：
 *   base      1 级数值
 *   perLevel  每级增量
 *   fire()    冷却结束时触发（返回 false 表示没打出去，稍后重试）
 *   tick()    需要持续行为的武器（环绕刀、火焰喷射）每帧调用
 *   render()  需要持续视觉的武器（刀刃、火舌、电弧、霜环）
 *
 * 六把武器：
 *   knifeOrbit   飞刀环绕 — 贴身防守，持续切割
 *   magicBolt    魔法弹   — 自动索敌追踪，稳定单体输出
 *   chainBolt    闪电链   — 在密集怪群里反复弹射
 *   flamethrower 火焰喷射 — 扇形范围 + 灼烧 DoT
 *   frostNova    霜爆冲击 — 环形击退减速，解围用
 *   boomerang    回旋蛋镖 — 来回穿透一整条直线
 *
 * 玩家增益读自 player.stats（damageMultiplier / cooldownMultiplier /
 * areaMultiplier / extraProjectiles / critChance ...），由 ensureCombatStats
 * 补齐默认值，这样即使 Player 基类没定义这些字段也能安全运行。
 */
(function (global) {
  'use strict';

  const MathUtils = global.MathUtils;
  const TAU = Math.PI * 2;

  /** 战斗相关的扩展属性默认值（Player.BASE_STATS 之外的部分） */
  const COMBAT_STATS = {
    areaMultiplier: 1,
    projectileSpeedMultiplier: 1,
    durationMultiplier: 1,
    extraProjectiles: 0,
    critChance: 0.05,
    critMultiplier: 1.9,
    thorns: 0,
    luck: 0,
  };

  function ensureCombatStats(player) {
    if (!player || !player.stats) return;
    for (const key in COMBAT_STATS) {
      if (player.stats[key] === undefined) player.stats[key] = COMBAT_STATS[key];
    }
  }

  /* ------------------------------------------------------------------ *
   * 武器定义
   * ------------------------------------------------------------------ */

  const WEAPONS = {

    /* ---------- 飞刀环绕 ---------- */
    knifeOrbit: {
      id: 'knifeOrbit',
      name: '飞刀环绕',
      icon: '🗡',
      desc: '数把利刃绕身旋转，撕碎贴近的敌人',
      maxLevel: 8,
      base: { damage: 10, count: 2, orbit: 80, spin: 2.4, hitCooldown: 0.42, knockback: 160 },
      perLevel: { damage: 3.6, count: 0.5, orbit: 5, spin: 0.09 },
      levelText: [
        '', '2 把飞刀开始旋转', '+1 把飞刀', '伤害提升，轨道扩大', '+1 把飞刀',
        '转速提升', '+1 把飞刀', '伤害大幅提升', '+1 把飞刀，轨道再扩大',
      ],

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
        const bladeRadius = 14 * Math.sqrt(area);
        const damage = s.damage * stats.damageMultiplier;
        const now = engine.elapsed;

        w.blades.length = 0;
        for (let i = 0; i < count; i++) {
          const a = w.phase + (i / count) * TAU;
          const bx = player.position.x + Math.cos(a) * orbitRadius;
          const by = player.position.y + Math.sin(a) * orbitRadius;
          w.blades.push(bx, by, a);

          engine.combat.forEachInCircle(bx, by, bladeRadius, (enemy, d) => {
            if (d > bladeRadius + enemy.radius) return;
            // 每个目标独立冷却，否则贴脸时一帧内会被切成筛子
            const next = w.hitLog.get(enemy);
            if (next !== undefined && now < next) return;
            w.hitLog.set(enemy, now + s.hitCooldown);
            sys.dealDamage(w, enemy, damage, { angle: a + Math.PI / 2, knockback: s.knockback });
          });
        }

        w.cleanupTimer -= dt;
        if (w.cleanupTimer <= 0) {
          w.cleanupTimer = 3;
          for (const enemy of w.hitLog.keys()) if (enemy.dead) w.hitLog.delete(enemy);
        }
      },

      render(w, ctx, engine) {
        const area = engine.player.stats.areaMultiplier;
        const bladeRadius = 14 * Math.sqrt(area);
        const t = engine.elapsed;

        for (let i = 0; i < w.blades.length; i += 3) {
          ctx.save();
          ctx.translate(w.blades[i], w.blades[i + 1]);
          ctx.rotate(w.blades[i + 2] + t * 9);
          ctx.shadowColor = '#ffe9a8';
          ctx.shadowBlur = 12;
          ctx.fillStyle = '#fff6cf';
          ctx.strokeStyle = '#8a6b12';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(bladeRadius * 1.5, 0);
          ctx.lineTo(-bladeRadius * 0.4, bladeRadius * 0.62);
          ctx.lineTo(-bladeRadius * 0.9, 0);
          ctx.lineTo(-bladeRadius * 0.4, -bladeRadius * 0.62);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }
      },
    },

    /* ---------- 魔法弹 ---------- */
    magicBolt: {
      id: 'magicBolt',
      name: '魔法弹',
      icon: '✷',
      desc: '自动锁定最近敌人的追踪能量弹',
      maxLevel: 8,
      base: { damage: 15, cooldown: 0.85, count: 1, speed: 480, pierce: 0, homing: 4.4, range: 540 },
      perLevel: { damage: 4.8, cooldown: -0.055, count: 0.34, speed: 12, pierce: 0.16 },
      levelText: [
        '', '发射 1 发追踪弹', '射速提升', '+1 发', '伤害提升',
        '获得穿透', '+1 发', '射速大幅提升', '+1 发，伤害提升',
      ],

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

        for (let i = 0; i < count; i++) {
          // 多发时小角度散布，追踪会重新把它们收束到目标上
          const spread = count === 1 ? 0 : (i - (count - 1) / 2) * 0.22;
          const roll = sys.rollDamage(w, s.damage);
          sys.spawn(engine, {
            x: player.position.x,
            y: player.position.y,
            angle: baseAngle + spread,
            speed: s.speed * player.stats.projectileSpeedMultiplier,
            damage: roll.damage,
            critical: roll.critical,
            radius: 6 * Math.sqrt(player.stats.areaMultiplier),
            pierce: Math.floor(s.pierce),
            homing: s.homing,
            life: 2.8 * player.stats.durationMultiplier,
            knockback: 90,
            color: '#8ad9ff',
            kind: 'bolt',
            weaponId: w.id,
          });
        }
        if (engine.audio) engine.audio.play('shoot');
        return true;
      },
    },

    /* ---------- 闪电链 ---------- */
    chainBolt: {
      id: 'chainBolt',
      name: '闪电链',
      icon: '⚡',
      desc: '劈中敌人后在附近目标间连锁跳跃',
      maxLevel: 8,
      base: { damage: 20, cooldown: 1.5, chains: 2, range: 400, jumpRange: 200, falloff: 0.86, stun: 0.12 },
      perLevel: { damage: 5.6, cooldown: -0.1, chains: 0.62, jumpRange: 8, falloff: 0.014 },
      levelText: [
        '', '劈向敌人并弹射 2 次', '+1 次弹射', '伤害提升', '+1 次弹射',
        '衰减降低', '+1 次弹射', '冷却大幅缩短', '+2 次弹射，伤害提升',
      ],

      init(w) { w.arcs = []; },

      fire(w, engine, sys) {
        const s = w.stats;
        const player = engine.player;
        const combat = engine.combat;
        let current = combat.strongestEnemy(player.position.x, player.position.y, s.range);
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
            critical: roll.critical,
            angle: Math.atan2(current.position.y - fromY, current.position.x - fromX),
            knockback: 70,
            stun: s.stun,
          });
          w.arcs.push({
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
        for (let i = w.arcs.length - 1; i >= 0; i--) {
          w.arcs[i].life -= dt;
          if (w.arcs[i].life <= 0) w.arcs.splice(i, 1);
        }
      },

      render(w, ctx) {
        if (!w.arcs.length) return;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = '#bff0ff';
        ctx.shadowColor = '#6fd8ff';
        ctx.shadowBlur = 14;
        ctx.lineCap = 'round';

        for (const arc of w.arcs) {
          const alpha = arc.life / arc.maxLife;
          const dx = arc.x2 - arc.x1;
          const dy = arc.y2 - arc.y1;
          const len = Math.hypot(dx, dy) || 1;
          const nx = -dy / len;
          const ny = dx / len;

          // 画两遍：粗的做辉光底、细的做芯线
          for (let pass = 0; pass < 2; pass++) {
            ctx.lineWidth = pass === 0 ? 6 : 2;
            ctx.globalAlpha = pass === 0 ? alpha * 0.3 : alpha;
            ctx.beginPath();
            ctx.moveTo(arc.x1, arc.y1);
            const segments = 5;
            for (let i = 1; i < segments; i++) {
              const k = i / segments;
              // 中段抖得最厉害，两端收紧，看起来才像电弧
              const jitter = (Math.random() - 0.5) * 24 * (1 - Math.abs(k - 0.5) * 2);
              ctx.lineTo(arc.x1 + dx * k + nx * jitter, arc.y1 + dy * k + ny * jitter);
            }
            ctx.lineTo(arc.x2, arc.y2);
            ctx.stroke();
          }
        }
        ctx.restore();
      },
    },

    /* ---------- 火焰喷射 ---------- */
    flamethrower: {
      id: 'flamethrower',
      name: '火焰喷射',
      icon: '🔥',
      desc: '朝移动方向持续喷火，附加灼烧',
      maxLevel: 8,
      base: {
        damage: 30, cooldown: 2.6, duration: 1.1, range: 180,
        angle: 0.52, burnDps: 10, burnTime: 3, tick: 0.16,
      },
      perLevel: { damage: 8.5, cooldown: -0.14, duration: 0.09, range: 14, angle: 0.028, burnDps: 3.4 },
      levelText: [
        '', '喷出灼热火舌', '范围扩大', '灼烧加强', '持续时间延长',
        '伤害提升', '锥角扩大', '冷却缩短', '伤害与灼烧大幅提升',
      ],

      init(w) {
        w.active = 0;
        w.tickTimer = 0;
        w.direction = 0;
        w.flames = [];
      },

      fire(w, engine) {
        w.active = w.stats.duration * engine.player.stats.durationMultiplier;
        w.tickTimer = 0;
        if (engine.audio) engine.audio.play('flame');
        return true;
      },

      tick(w, dt, engine, sys) {
        // 火焰粒子始终衰减，即使喷射已经结束
        for (let i = w.flames.length - 1; i >= 0; i--) {
          const f = w.flames[i];
          f.life -= dt;
          f.x += f.vx * dt;
          f.y += f.vy * dt;
          f.vx *= 0.96;
          f.vy *= 0.96;
          if (f.life <= 0) w.flames.splice(i, 1);
        }
        if (w.active <= 0) return;

        const s = w.stats;
        const player = engine.player;
        const stats = player.stats;
        w.active -= dt;

        // 朝向：跟随移动方向；站定时锁向最近的敌人
        let want = player.facing.angle();
        const idle = player.velocity.lengthSq() < 900;
        if (idle) {
          const target = engine.combat.nearestEnemy(
            player.position.x, player.position.y, s.range * 1.6
          );
          if (target) {
            want = Math.atan2(
              target.position.y - player.position.y,
              target.position.x - player.position.x
            );
          }
        }
        // 角度插值必须走最短弧，否则跨越 ±π 时火舌会绕一整圈
        let diff = want - w.direction;
        while (diff > Math.PI) diff -= TAU;
        while (diff < -Math.PI) diff += TAU;
        w.direction += diff * Math.min(1, dt * 9);

        const area = stats.areaMultiplier;
        const range = s.range * area;
        const halfAngle = s.angle * Math.min(1.6, area);

        for (let i = 0; i < 3; i++) {
          const a = w.direction + (Math.random() - 0.5) * halfAngle * 2;
          const speed = MathUtils.randRange(200, 340);
          w.flames.push({
            x: player.position.x + Math.cos(w.direction) * player.radius,
            y: player.position.y + Math.sin(w.direction) * player.radius,
            vx: Math.cos(a) * speed,
            vy: Math.sin(a) * speed,
            life: range / 340,
            maxLife: range / 340,
            size: MathUtils.randRange(8, 16) * Math.sqrt(area),
          });
        }

        // 伤害按固定 tick 结算，避免高帧率下每帧结算导致 DPS 翻倍
        w.tickTimer -= dt;
        if (w.tickTimer > 0) return;
        w.tickTimer = s.tick;

        const hits = engine.combat.queryCone(
          player.position.x, player.position.y, w.direction, halfAngle, range
        );
        const perTick = s.damage * s.tick * stats.damageMultiplier;
        for (const enemy of hits) {
          sys.dealDamage(w, enemy, perTick, {
            angle: Math.atan2(
              enemy.position.y - player.position.y,
              enemy.position.x - player.position.x
            ),
            knockback: 34,
            silent: true,       // 每 0.16s 一跳，飘字会刷屏
            preMultiplied: true,
          });
          enemy.applyBurn(s.burnDps * stats.damageMultiplier, s.burnTime);
        }
      },

      render(w, ctx) {
        if (!w.flames.length) return;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (const f of w.flames) {
          const k = f.life / f.maxLife;
          const r = f.size * (1.25 - k * 0.5);
          const gradient = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, r);
          // 白 → 黄 → 红，模拟火焰温度梯度
          gradient.addColorStop(0, `rgba(255,255,220,${0.7 * k})`);
          gradient.addColorStop(0.45, `rgba(255,168,46,${0.5 * k})`);
          gradient.addColorStop(1, 'rgba(255,60,20,0)');
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.arc(f.x, f.y, r, 0, TAU);
          ctx.fill();
        }
        ctx.restore();
      },
    },

    /* ---------- 霜爆冲击 ---------- */
    frostNova: {
      id: 'frostNova',
      name: '霜爆冲击',
      icon: '❄',
      desc: '以自身为中心炸开寒霜，击退并减速',
      maxLevel: 6,
      base: { damage: 26, cooldown: 4.2, radius: 140, knockback: 440, slow: 0.55, slowTime: 2.4 },
      perLevel: { damage: 9, cooldown: -0.34, radius: 18, slow: -0.05, slowTime: 0.25 },
      levelText: [
        '', '释放霜爆冲击波', '范围扩大', '减速加强', '伤害提升', '冷却缩短', '范围与减速大幅提升',
      ],

      init(w) { w.rings = []; },

      fire(w, engine, sys) {
        const s = w.stats;
        const player = engine.player;
        const radius = s.radius * player.stats.areaMultiplier;
        const hits = engine.combat.queryCircle(player.position.x, player.position.y, radius);
        if (!hits.length) return false;      // 附近没敌人就不浪费这次冷却

        const roll = sys.rollDamage(w, s.damage);
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
          radius: 10, maxRadius: radius, life: 0.45, maxLife: 0.45,
        });
        engine.camera.addTrauma(0.22);
        engine.particles.shockwave(player.position.x, player.position.y, {
          size: 12, endSize: radius * 2, color: '#a8ecff', life: 0.5,
        });
        if (engine.audio) engine.audio.play('nova');
        return true;
      },

      tick(w, dt) {
        for (let i = w.rings.length - 1; i >= 0; i--) {
          const ring = w.rings[i];
          ring.life -= dt;
          ring.radius = ring.maxRadius * MathUtils.easeOutCubic(1 - ring.life / ring.maxLife);
          if (ring.life <= 0) w.rings.splice(i, 1);
        }
      },

      render(w, ctx) {
        for (const ring of w.rings) {
          const alpha = ring.life / ring.maxLife;
          ctx.save();
          ctx.globalAlpha = alpha * 0.85;
          ctx.strokeStyle = '#a8ecff';
          ctx.shadowColor = '#7fd8ff';
          ctx.shadowBlur = 18;
          ctx.lineWidth = 6 * alpha + 1;
          ctx.beginPath();
          ctx.arc(ring.x, ring.y, ring.radius, 0, TAU);
          ctx.stroke();
          ctx.globalAlpha = alpha * 0.14;
          ctx.fillStyle = '#7fd8ff';
          ctx.fill();
          ctx.restore();
        }
      },
    },

    /* ---------- 回旋蛋镖 ---------- */
    boomerang: {
      id: 'boomerang',
      name: '回旋蛋镖',
      icon: '🪃',
      desc: '掷出后回旋返回，来回穿透一整条直线',
      maxLevel: 6,
      base: { damage: 23, cooldown: 2.1, count: 1, speed: 540, flyOut: 0.6 },
      perLevel: { damage: 8, cooldown: -0.16, count: 0.4, speed: 18, flyOut: 0.05 },
      levelText: [
        '', '掷出 1 枚回旋镖', '飞得更远', '+1 枚', '伤害提升', '冷却缩短', '+1 枚，伤害提升',
      ],

      fire(w, engine, sys) {
        const s = w.stats;
        const player = engine.player;
        const target = engine.combat.nearestEnemy(player.position.x, player.position.y, 640);
        const baseAngle = target
          ? Math.atan2(
            target.position.y - player.position.y,
            target.position.x - player.position.x
          )
          : player.facing.angle();

        const count = Math.max(1, Math.round(s.count)
          + Math.floor(player.stats.extraProjectiles / 2));

        for (let i = 0; i < count; i++) {
          const spread = count === 1 ? 0 : (i - (count - 1) / 2) * 0.5;
          const roll = sys.rollDamage(w, s.damage);
          sys.spawn(engine, {
            x: player.position.x,
            y: player.position.y,
            angle: baseAngle + spread,
            speed: s.speed * player.stats.projectileSpeedMultiplier,
            damage: roll.damage,
            critical: roll.critical,
            radius: 11 * Math.sqrt(player.stats.areaMultiplier),
            kind: 'boomerang',
            owner: player,
            returnAfter: s.flyOut * player.stats.durationMultiplier,
            life: 6,
            knockback: 130,
            spin: 16,
            color: '#ffd45e',
            weaponId: w.id,
          });
        }
        if (engine.audio) engine.audio.play('throw');
        return true;
      },
    },
  };

  const WEAPON_IDS = Object.keys(WEAPONS);

  /* ------------------------------------------------------------------ *
   * 系统
   * ------------------------------------------------------------------ */

  class WeaponSystem {
    constructor(options = {}) {
      this.weapons = [];
      this.maxSlots = options.maxSlots || 6;
      this.startingWeapon = options.startingWeapon || 'magicBolt';
      this.engine = null;
      this.totalDamage = 0;
    }

    onAdd(engine) {
      this.engine = engine;
      engine.weapons = this;
    }

    /** 每局开始时由引擎 resetWorld 调用 */
    reset(engine) {
      this.weapons.length = 0;
      this.totalDamage = 0;
      const target = engine || this.engine;
      if (target && target.player) ensureCombatStats(target.player);
      this.add(this.startingWeapon);
    }

    /* ================= 增删与升级 ================= */

    has(id) { return this.weapons.some((w) => w.id === id); }
    get(id) { return this.weapons.find((w) => w.id === id) || null; }
    get isFull() { return this.weapons.length >= this.maxSlots; }

    isMaxed(id) {
      const w = this.get(id);
      return !!w && w.level >= w.def.maxLevel;
    }

    add(id) {
      const def = WEAPONS[id];
      if (!def || this.has(id) || this.isFull) return null;

      const weapon = {
        id,
        def,
        level: 0,
        cooldown: 0,
        stats: {},
        damageDealt: 0,
      };
      if (def.init) def.init(weapon);
      this.weapons.push(weapon);
      this.levelUp(id);
      return weapon;
    }

    levelUp(id) {
      const weapon = this.get(id) || this.add(id);
      if (!weapon || weapon.level >= weapon.def.maxLevel) return weapon;
      weapon.level++;
      this.recalc(weapon);
      return weapon;
    }

    /** stats = base + perLevel * (level - 1) */
    recalc(weapon) {
      const def = weapon.def;
      for (const key in def.base) {
        const step = def.perLevel && def.perLevel[key] ? def.perLevel[key] : 0;
        weapon.stats[key] = def.base[key] + step * (weapon.level - 1);
      }
      if (weapon.stats.cooldown !== undefined) {
        weapon.stats.cooldown = Math.max(0.12, weapon.stats.cooldown);
      }
    }

    recalcAll() { for (const w of this.weapons) this.recalc(w); }

    /** 某等级的升级说明，供升级卡使用 */
    levelDescription(id, level) {
      const def = WEAPONS[id];
      if (!def) return '';
      return def.levelText[level] || '数值全面提升';
    }

    /* ================= 结算辅助 ================= */

    /**
     * 计算一次伤害（含玩家增伤与暴击）。
     * @returns {{damage:number, critical:boolean}}
     */
    /** Fever 期间的增伤系数；ComboSystem 缺席时恒为 1 */
    get feverDamage() {
      const combo = this.engine && this.engine.combo;
      return combo ? combo.damageBonus : 1;
    }

    rollDamage(weapon, base) {
      const stats = this.engine.player.stats;
      let damage = base * stats.damageMultiplier;
      const critical = Math.random() < stats.critChance;
      if (critical) damage *= stats.critMultiplier;
      // ±8% 浮动，让伤害数字不那么呆板
      damage *= MathUtils.randRange(0.92, 1.08);
      return { damage, critical };
    }

    /**
     * 统一的伤害出口。options.preMultiplied 表示 amount 已经乘过增伤，
     * 否则这里补乘一次 damageMultiplier。
     */
    dealDamage(weapon, enemy, amount, options = {}) {
      const engine = this.engine;
      const base = options.preMultiplied
        ? amount
        : amount * engine.player.stats.damageMultiplier;
      const damage = base * this.feverDamage;

      // 有 JuiceSystem 时把飘字交给它统一出，配色与字号才跟暴击 / 击杀挂钩
      const juice = engine.juice;
      const combo = engine.combo;
      // 连击归因：Enemy._die() 会在 takeDamage 内部同步派发 enemy:died，
      // ComboSystem 只能靠这个字段知道这一杀该记在哪把武器头上。
      if (combo) combo.pendingSource = weapon.id;

      const dealt = enemy.takeDamage(damage, {
        angle: options.angle,
        knockback: options.knockback,
        critical: options.critical,
        stun: options.stun,
        silent: options.silent || !!juice,
        source: weapon.id,
      });

      if (combo) combo.pendingSource = null;

      if (juice && dealt > 0 && !options.silent) {
        juice.hit(enemy, dealt, { critical: options.critical, kill: enemy.dead });
      }

      weapon.damageDealt += dealt;
      this.totalDamage += dealt;
      return dealt;
    }

    /** 由 CollisionSystem 回报弹道命中，用于武器伤害统计 */
    reportDamage(weaponId, amount) {
      if (!weaponId || !amount) return;
      const weapon = this.get(weaponId);
      if (weapon) weapon.damageDealt += amount;
      this.totalDamage += amount;
    }

    spawn(engine, config) {
      // 弹道伤害在出膛时定死，Fever 加成只能在这里乘一次
      const fever = this.feverDamage;
      if (fever !== 1 && config.damage) config.damage *= fever;
      return engine.add(new global.Projectile(config));
    }

    /* ================= 主循环 ================= */

    update(dt, engine) {
      const player = engine.player;
      if (!player || !player.isAlive || !engine.combat) return;
      ensureCombatStats(player);

      // Fever 期间所有武器一起提速
      const cooldownMultiplier = player.stats.cooldownMultiplier
        * (engine.combo ? engine.combo.cooldownScale : 1);

      for (let i = 0; i < this.weapons.length; i++) {
        const weapon = this.weapons[i];
        if (weapon.def.tick) weapon.def.tick(weapon, dt, engine, this);
        if (!weapon.def.fire) continue;

        weapon.cooldown -= dt;
        if (weapon.cooldown > 0) continue;

        const fired = weapon.def.fire(weapon, engine, this);
        // 没打出去（例如没有目标）就短暂重试，而不是空转一整个冷却
        weapon.cooldown = fired ? weapon.stats.cooldown * cooldownMultiplier : 0.2;
      }
    }

    drawWorld(ctx, engine) {
      for (let i = 0; i < this.weapons.length; i++) {
        const weapon = this.weapons[i];
        if (weapon.def.render) weapon.def.render(weapon, ctx, engine);
      }
    }

    /** HUD 用的武器槽快照 */
    snapshot() {
      const cooldownMultiplier = this.engine && this.engine.player
        ? this.engine.player.stats.cooldownMultiplier : 1;
      return this.weapons.map((w) => {
        const total = w.stats.cooldown ? w.stats.cooldown * cooldownMultiplier : 0;
        return {
          id: w.id,
          icon: w.def.icon,
          name: w.def.name,
          level: w.level,
          maxLevel: w.def.maxLevel,
          ready: total > 0 ? MathUtils.clamp(1 - w.cooldown / total, 0, 1) : 1,
          damage: Math.round(w.damageDealt),
        };
      });
    }
  }

  WeaponSystem.WEAPONS = WEAPONS;
  WeaponSystem.IDS = WEAPON_IDS;
  WeaponSystem.COMBAT_STATS = COMBAT_STATS;
  WeaponSystem.ensureCombatStats = ensureCombatStats;

  global.WeaponSystem = WeaponSystem;
  global.WEAPONS = WEAPONS;
})(window);
