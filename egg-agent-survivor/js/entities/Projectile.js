/**
 * Projectile — 玩家弹幕
 * 支持穿透（每个目标只结算一次）、暴击与拖尾。
 */
(function (global) {
  'use strict';

  const MathUtils = global.MathUtils;

  class Projectile extends global.Entity {
    constructor(x, y, direction, options = {}) {
      super(x, y, { radius: options.radius || 6, tag: 'projectile', layer: global.Layer.PROJECTILE });
      this.speed = options.speed || 540;
      this.velocity.copy(direction.normalized().scale(this.speed));
      this.damage = options.damage || 10;
      this.pierce = options.pierce || 0;
      this.lifetime = options.lifetime || 1.6;
      this.knockback = options.knockback !== undefined ? options.knockback : 210;
      this.critChance = options.critChance || 0;
      this.color = options.color || '#7cf9ff';
      this._hitIds = new Set();
      this._trailTimer = 0;
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

      const candidates = engine.grid.query(this.position, this.radius + 30);
      for (let i = 0; i < candidates.length; i++) {
        const target = candidates[i];
        if (target.tag !== 'enemy' || target.dead || this._hitIds.has(target.id)) continue;
        const reach = this.radius + target.radius;
        if (this.position.distanceSqTo(target.position) > reach * reach) continue;

        this._hitIds.add(target.id);
        const critical = Math.random() < this.critChance;
        const damage = this.damage * (critical ? 2 : 1);
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

        if (this.pierce <= 0) { this.dead = true; return; }
        this.pierce--;
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
