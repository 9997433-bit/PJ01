/**
 * XPGem — 经验碎片
 * 进入玩家拾取半径后被磁吸加速，接触即结算经验。
 */
(function (global) {
  'use strict';

  const MathUtils = global.MathUtils;

  class XPGem extends global.Entity {
    constructor(x, y, value = 1) {
      super(x, y, { radius: 7, tag: 'xp', layer: global.Layer.PICKUP });
      this.value = value;
      this.magnetized = false;
      this.magnetSpeed = 120;
      this._phase = Math.random() * Math.PI * 2;
      this.lifetime = 60;

      // 掉落时向外弹一小段，避免全部重叠在死亡点
      const dir = global.Vector2.randomDirection();
      this.velocity.copy(dir.scale(MathUtils.randRange(40, 110)));

      this.color = value >= 10 ? '#ffd45e' : value >= 5 ? '#b78bff' : '#6bffd0';
      this.radius = value >= 10 ? 10 : value >= 5 ? 8 : 6.5;
    }

    update(dt, engine) {
      this.age += dt;
      this._phase += dt * 3.4;
      this.lifetime -= dt;
      if (this.lifetime <= 0) { this.dead = true; return; }

      const player = engine.player;
      if (!player || !player.isAlive) return;

      const toPlayer = player.position.sub(this.position);
      const distance = toPlayer.length();

      if (!this.magnetized && distance <= player.stats.pickupRadius) {
        this.magnetized = true;
      }

      if (this.magnetized) {
        this.magnetSpeed = Math.min(920, this.magnetSpeed + 1500 * dt);
        this.velocity.copy(toPlayer.normalized().scale(this.magnetSpeed));
        if (distance < player.radius + this.radius) {
          this._collect(engine, player);
          return;
        }
      } else {
        this.velocity.scaleSelf(Math.pow(0.02, dt));
      }

      this.position.addScaledSelf(this.velocity, dt);
    }

    _collect(engine, player) {
      this.dead = true;
      player.gainXp(this.value);
      engine.particles.burst(this.position.x, this.position.y, 6, {
        colors: [this.color, '#ffffff'],
        speedMin: 30, speedMax: 130, lifeMin: 0.15, lifeMax: 0.35, size: 2.5,
      });
      engine.events.emit('xp:collected', { value: this.value });
    }

    draw(ctx) {
      const bob = Math.sin(this._phase) * 2;
      const pulse = 0.75 + Math.sin(this._phase * 1.7) * 0.25;

      ctx.save();
      ctx.translate(this.position.x, this.position.y + bob);
      ctx.globalCompositeOperation = 'lighter';

      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, this.radius * 3.4);
      glow.addColorStop(0, this.color);
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = 0.3 * pulse;
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, this.radius * 3.4, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.rotate(this.age * 1.9);
      ctx.fillStyle = this.color;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(0, -this.radius * 1.35);
      ctx.lineTo(this.radius * 0.92, 0);
      ctx.lineTo(0, this.radius * 1.35);
      ctx.lineTo(-this.radius * 0.92, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  global.XPGem = XPGem;
})(window);
