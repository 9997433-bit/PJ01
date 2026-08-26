/**
 * Projectile — 弹幕
 * 支持穿透（每个目标只结算一次）、暴击与拖尾。
 *
 * 构造支持两种签名：
 *   new Projectile(x, y, direction, options)
 *   new Projectile({ x, y, angle|direction|velocity, ...options })
 * 后者供外部战斗系统按配置对象生成弹丸。
 */
(function (global) {
  'use strict';

  const Vector2 = global.Vector2;
  const MathUtils = global.MathUtils;

  function resolveDirection(source) {
    if (!source) return Vector2.right();
    if (typeof source.angle === 'number') return Vector2.fromAngle(source.angle);
    if (source.direction) return new Vector2(source.direction.x, source.direction.y).normalizeSelf();
    if (source.velocity) return new Vector2(source.velocity.x, source.velocity.y).normalizeSelf();
    if (typeof source.x === 'number' && typeof source.y === 'number') {
      return new Vector2(source.x, source.y).normalizeSelf();
    }
    return Vector2.right();
  }

  class Projectile extends global.Entity {
    constructor(x, y, direction, options = {}) {
      let config = options;
      let originX = x;
      let originY = y;
      let dir = direction;

      // 单参数配置对象形式
      if (x !== null && typeof x === 'object') {
        config = x;
        originX = config.x || 0;
        originY = config.y || 0;
        dir = resolveDirection(config);
      } else {
        dir = resolveDirection(direction);
      }

      super(originX, originY, {
        radius: config.radius || 6,
        tag: 'projectile',
        layer: global.Layer.PROJECTILE,
      });

      this.speed = config.speed || 540;
      this.velocity.copy(dir.scale(this.speed));
      this.damage = config.damage || 10;
      this.pierce = config.pierce || 0;
      this.lifetime = config.life !== undefined ? config.life : (config.lifetime || 1.6);
      this.knockback = config.knockback !== undefined ? config.knockback : 210;
      this.color = config.color || '#7cf9ff';

      this.faction = config.faction || 'player';
      this.kind = config.kind || 'bolt';
      this.owner = config.owner || null;
      this.weaponId = config.weaponId || null;

      // 外部系统已经掷过暴击的，就不要再掷一次
      this.critical = !!config.critical;
      this.critChance = config.critical !== undefined ? 0 : (config.critChance || 0);

      this._hitIds = new Set();
      this._trailTimer = 0;
    }

    /** 供外部碰撞系统查询：该目标是否还能被本弹丸命中 */
    canHit(target) {
      return !this.dead && !this._hitIds.has(target.id);
    }

    /**
     * 登记一次命中并消耗穿透次数。
     * @returns {boolean} true 表示弹丸已耗尽，应当销毁
     */
    registerHit(target) {
      this._hitIds.add(target.id);
      if (this.pierce <= 0) return true;
      this.pierce--;
      return false;
    }

    update(dt, engine) {
      this.age += dt;
      this.lifetime -= dt;
      if (this.lifetime <= 0) { this.dead = true; return; }

      this.position.addScaledSelf(this.velocity, dt);

      this._trailTimer -= dt;
      if (this._trailTimer <= 0) {
        this._trailTimer = 0.02;
        engine.particles.emit({
          x: this.position.x, y: this.position.y,
          vx: -this.velocity.x * 0.1, vy: -this.velocity.y * 0.1,
          life: 0.22, size: this.radius * 0.85, color: this.color, drag: 0.8,
        });
      }

      // 存在外部碰撞系统时交出判定权，避免同一次命中被结算两遍
      if (engine.combat || engine.collision) return;

      const candidates = engine.grid.query(this.position, this.radius + 30);
      for (let i = 0; i < candidates.length; i++) {
        const target = candidates[i];
        if (target.tag !== 'enemy' || target.dead || !this.canHit(target)) continue;
        const reach = this.radius + target.radius;
        if (this.position.distanceSqTo(target.position) > reach * reach) continue;

        const critical = this.critical || Math.random() < this.critChance;
        const damage = this.damage * (critical && !this.critical ? 2 : 1);
        target.takeDamage(damage, {
          critical,
          knockback: this.knockback,
          direction: this.velocity,
        });

        engine.particles.burst(this.position.x, this.position.y, critical ? 12 : 6, {
          colors: critical ? ['#ffd45e', '#ffffff'] : [this.color, '#ffffff'],
          speedMin: 60, speedMax: 240, lifeMin: 0.15, lifeMax: 0.35,
          shape: 'spark', angle: this.velocity.angle(), spread: Math.PI,
        });
        if (critical) engine.camera.addTrauma(0.09);

        if (this.registerHit(target)) { this.dead = true; return; }
      }
    }

    draw(ctx) {
      const angle = this.velocity.angle();
      ctx.save();
      ctx.translate(this.position.x, this.position.y);
      ctx.rotate(angle);
      ctx.globalCompositeOperation = 'lighter';

      const len = this.radius * 3.2;
      const gradient = ctx.createLinearGradient(-len, 0, this.radius, 0);
      gradient.addColorStop(0, 'rgba(124,249,255,0)');
      gradient.addColorStop(1, this.color);
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.moveTo(-len, -this.radius * 0.45);
      ctx.lineTo(this.radius, 0);
      ctx.lineTo(-len, this.radius * 0.45);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = 0.9 + Math.sin(this.age * 30) * 0.1;
      ctx.beginPath();
      ctx.arc(0, 0, this.radius * 0.62, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  global.Projectile = Projectile;
})(window);
