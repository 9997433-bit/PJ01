/**
 * Projectile — 通用弹道（玩家与敌人共用）
 *
 * 一个类覆盖所有弹道形态，用 kind 切换运动与绘制：
 *   bolt      直线飞行，可追踪、可穿透
 *   knife     直线投掷，带自旋
 *   boomerang 飞出后回旋返回，对同一目标有独立的重复命中冷却
 *   orb       缓慢发光的能量球（敌人弹幕也用它）
 *
 * 命中判定在 CollisionSystem 里做；这里只负责运动、命中记账与绘制。
 * 穿透去重用 Set 记录已命中目标，回旋镖则记录命中时刻做冷却。
 */
(function (global) {
  'use strict';

  const MathUtils = global.MathUtils;
  const TAU = Math.PI * 2;
  const MAX_TRAIL = 7;

  class Projectile extends global.Entity {
    /**
     * @param {object} config
     *   x, y, angle, speed, damage, radius
     *   kind        'bolt' | 'knife' | 'boomerang' | 'orb'
     *   faction     'player' | 'enemy'
     *   pierce      可额外穿透的敌人数
     *   life        存活秒数
     *   knockback   击退强度
     *   critical    是否暴击
     *   homing      追踪转向速度（弧度/秒），0 关闭
     *   color
     *   burn        { dps, duration }
     *   slow        { mult, duration }
     *   onHit(projectile, enemy, engine)
     *   owner       回旋镖的归属实体
     *   returnAfter 回旋镖开始返回的时间
     *   weaponId    来源武器（用于伤害统计）
     */
    constructor(config = {}) {
      super(config.x || 0, config.y || 0, {
        radius: config.radius !== undefined ? config.radius : 6,
        tag: 'projectile',
        layer: global.Layer.PROJECTILE,
      });

      this.angle = config.angle || 0;
      this.speed = config.speed !== undefined ? config.speed : 420;
      this.velocity.set(Math.cos(this.angle) * this.speed, Math.sin(this.angle) * this.speed);

      this.kind = config.kind || 'bolt';
      this.faction = config.faction || 'player';
      this.damage = config.damage !== undefined ? config.damage : 10;
      this.pierce = config.pierce || 0;
      this.life = config.life !== undefined ? config.life : 2.2;
      this.maxLife = this.life;
      this.knockback = config.knockback || 0;
      this.critical = !!config.critical;
      this.homing = config.homing || 0;
      this.color = config.color || '#ffe066';
      this.burn = config.burn || null;
      this.slow = config.slow || null;
      this.onHit = config.onHit || null;
      this.weaponId = config.weaponId || null;
      this.spin = config.spin !== undefined ? config.spin : (this.kind === 'knife' ? 18 : 0);
      this.rotation = 0;
      /** 每次穿透后的伤害衰减系数 */
      this.pierceFalloff = config.pierceFalloff !== undefined ? config.pierceFalloff : 1;

      this.owner = config.owner || null;
      this.returnAfter = config.returnAfter || 0.55;
      this.returning = false;
      this.reHitDelay = config.reHitDelay || 0.35;

      this.target = null;
      this.hitSet = new Set();
      this.hitTimes = new Map();
      this.trail = [];
    }

    update(dt, engine) {
      this.age += dt;
      this.life -= dt;
      if (this.life <= 0) { this.dead = true; return; }

      if (this.kind === 'boomerang') this._updateBoomerang(dt, engine);
      else this._updateLinear(dt, engine);

      this.position.addScaledSelf(this.velocity, dt);
      this.rotation += this.spin * dt;

      if (this.kind !== 'boomerang') {
        this.trail.push(this.position.x, this.position.y);
        if (this.trail.length > MAX_TRAIL * 2) this.trail.splice(0, 2);
      }

      // 飞得太远就回收，避免脱离战场的弹道一直占用实体槽位
      const player = engine.player;
      if (player && this.position.distanceSqTo(player.position) > 2400 * 2400) {
        this.dead = true;
      }
    }

    _updateLinear(dt, engine) {
      if (this.homing <= 0 || this.faction !== 'player') return;

      if (!this.target || this.target.dead) {
        const combat = engine.combat;
        this.target = combat ? combat.nearestEnemy(this.position.x, this.position.y, 460) : null;
      }
      if (!this.target || this.target.dead) return;

      const want = Math.atan2(
        this.target.position.y - this.position.y,
        this.target.position.x - this.position.x
      );
      let diff = want - this.angle;
      while (diff > Math.PI) diff -= TAU;
      while (diff < -Math.PI) diff += TAU;

      this.angle += MathUtils.clamp(diff, -this.homing * dt, this.homing * dt);
      this.velocity.set(Math.cos(this.angle) * this.speed, Math.sin(this.angle) * this.speed);
    }

    _updateBoomerang(dt, engine) {
      const owner = this.owner || engine.player;
      if (!owner) { this.dead = true; return; }

      if (!this.returning && this.age >= this.returnAfter) this.returning = true;

      if (this.returning) {
        const want = Math.atan2(
          owner.position.y - this.position.y,
          owner.position.x - this.position.x
        );
        let diff = want - this.angle;
        while (diff > Math.PI) diff -= TAU;
        while (diff < -Math.PI) diff += TAU;
        this.angle += MathUtils.clamp(diff, -9 * dt, 9 * dt);
        this.speed = Math.min(this.speed + 640 * dt, 940);
        // 回到手上就收回
        if (this.position.distanceTo(owner.position) < owner.radius + this.radius) {
          this.dead = true;
        }
      } else {
        // 飞出阶段持续减速，形成抛物线般的手感
        this.speed = Math.max(this.speed - 540 * dt, 60);
      }
      this.velocity.set(Math.cos(this.angle) * this.speed, Math.sin(this.angle) * this.speed);
    }

    /* ================= 命中记账 ================= */

    /** 该敌人当前是否可被本发弹道命中 */
    canHit(enemy, now) {
      if (this.kind === 'boomerang') {
        const last = this.hitTimes.get(enemy);
        return last === undefined || now - last >= this.reHitDelay;
      }
      return !this.hitSet.has(enemy);
    }

    /** 记录一次命中；返回 true 表示弹道应当销毁 */
    registerHit(enemy, now) {
      if (this.kind === 'boomerang') {
        this.hitTimes.set(enemy, now);
        return false;
      }
      this.hitSet.add(enemy);
      this.damage *= this.pierceFalloff;
      if (this.pierce > 0) { this.pierce--; return false; }
      return true;
    }

    /* ================= 渲染 ================= */

    draw(ctx) {
      if (this.trail.length >= 4) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.3;
        ctx.strokeStyle = this.color;
        ctx.lineWidth = this.radius * 1.15;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(this.trail[0], this.trail[1]);
        for (let i = 2; i < this.trail.length; i += 2) ctx.lineTo(this.trail[i], this.trail[i + 1]);
        ctx.stroke();
        ctx.restore();
      }

      ctx.save();
      ctx.translate(this.position.x, this.position.y);
      ctx.shadowColor = this.color;
      ctx.shadowBlur = 14;
      ctx.fillStyle = this.color;

      switch (this.kind) {
        case 'knife': {
          ctx.rotate(this.rotation);
          ctx.strokeStyle = 'rgba(255,255,255,0.9)';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(this.radius * 1.9, 0);
          ctx.lineTo(-this.radius * 0.5, this.radius * 0.75);
          ctx.lineTo(-this.radius * 1.1, 0);
          ctx.lineTo(-this.radius * 0.5, -this.radius * 0.75);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          break;
        }
        case 'boomerang': {
          ctx.rotate(this.rotation);
          ctx.strokeStyle = this.color;
          ctx.lineWidth = this.radius * 0.66;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.arc(0, 0, this.radius * 1.3, 0.5, 0.5 + Math.PI * 1.15);
          ctx.stroke();
          break;
        }
        case 'orb': {
          const pulse = 1 + Math.sin(this.age * 12) * 0.12;
          const r = this.radius * 1.7 * pulse;
          const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
          gradient.addColorStop(0, '#ffffff');
          gradient.addColorStop(0.35, this.color);
          gradient.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.arc(0, 0, r, 0, TAU);
          ctx.fill();
          break;
        }
        default: {
          ctx.rotate(this.angle);
          ctx.beginPath();
          ctx.ellipse(0, 0, this.radius * 1.9, this.radius * 0.8, 0, 0, TAU);
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.ellipse(this.radius * 0.6, 0, this.radius * 0.6, this.radius * 0.3, 0, 0, TAU);
          ctx.fill();
        }
      }

      ctx.restore();
    }
  }

  global.Projectile = Projectile;
})(window);
