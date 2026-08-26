/**
 * Enemy — 追击型敌人
 *
 * 提供基础战斗闭环（追击 / 分离 / 接触伤害 / 受击 / 掉落），
 * ENEMY_TYPES 表可直接扩展新怪物，无需改动逻辑。
 */
(function (global) {
  'use strict';

  const Vector2 = global.Vector2;
  const MathUtils = global.MathUtils;

  const ENEMY_TYPES = {
    grunt: {
      name: '杂兵蛋', radius: 15, health: 22, speed: 76, damage: 9, xp: 4,
      color: '#ff6b8a', accent: '#ffd0da', shape: 'blob',
    },
    runner: {
      name: '突击蛋', radius: 12, health: 14, speed: 138, damage: 7, xp: 5,
      color: '#ffd45e', accent: '#fff2c4', shape: 'dart',
    },
    tank: {
      name: '重甲蛋', radius: 24, health: 90, speed: 52, damage: 17, xp: 14,
      color: '#b78bff', accent: '#e6d6ff', shape: 'hex',
    },
    elite: {
      name: '精英蛋', radius: 30, health: 320, speed: 62, damage: 24, xp: 60,
      color: '#ff4d6d', accent: '#ffe0e6', shape: 'hex', elite: true,
    },
  };

  const CONTACT_COOLDOWN = 0.6;
  const SEPARATION_RADIUS = 34;

  class Enemy extends global.Entity {
    constructor(x, y, typeKey = 'grunt', scaling = 1) {
      const def = ENEMY_TYPES[typeKey] || ENEMY_TYPES.grunt;
      super(x, y, { radius: def.radius, tag: 'enemy', layer: global.Layer.ACTOR });

      this.typeKey = typeKey;
      this.def = def;
      this.maxHealth = def.health * scaling;
      this.health = this.maxHealth;
      this.speed = def.speed * (1 + (scaling - 1) * 0.16);
      this.damage = def.damage * (1 + (scaling - 1) * 0.42);
      this.xpValue = def.xp;

      this.contactTimer = 0;
      this.hitFlash = 0;
      this.knockback = new Vector2(0, 0);
      this._steer = new Vector2(0, 0);
      this._wobble = Math.random() * Math.PI * 2;
      this._spawnAnim = 0;
    }

    update(dt, engine) {
      this.age += dt;
      this._spawnAnim = Math.min(1, this._spawnAnim + dt * 4);
      this.hitFlash = Math.max(0, this.hitFlash - dt * 4);
      this.contactTimer = Math.max(0, this.contactTimer - dt);
      this._wobble += dt * 5;

      const player = engine.player;
      if (!player || !player.isAlive) {
        this.velocity.scaleSelf(Math.pow(0.02, dt));
        this.position.addScaledSelf(this.velocity, dt);
        return;
      }

      const toPlayer = player.position.sub(this.position);
      const distance = toPlayer.length();
      this._steer.copy(toPlayer).normalizeSelf().scaleSelf(this.speed);

      this._applySeparation(engine);

      const t = 1 - Math.exp(-6 * dt);
      this.velocity.x += (this._steer.x - this.velocity.x) * t;
      this.velocity.y += (this._steer.y - this.velocity.y) * t;

      if (!this.knockback.isZero()) {
        this.position.addScaledSelf(this.knockback, dt);
        this.knockback.scaleSelf(Math.pow(0.0009, dt));
        if (this.knockback.lengthSq() < 4) this.knockback.set(0, 0);
      }

      this.position.addScaledSelf(this.velocity, dt);

      if (distance < this.radius + player.radius && this.contactTimer <= 0) {
        this.contactTimer = CONTACT_COOLDOWN;
        player.takeDamage(this.damage, { source: this });
      }
    }

    /** 避免所有敌人叠成一坨 */
    _applySeparation(engine) {
      const neighbors = engine.grid.query(this.position, SEPARATION_RADIUS);
      let pushX = 0;
      let pushY = 0;
      let count = 0;

      for (let i = 0; i < neighbors.length; i++) {
        const other = neighbors[i];
        if (other === this || other.tag !== 'enemy') continue;
        const dx = this.position.x - other.position.x;
        const dy = this.position.y - other.position.y;
        const distSq = dx * dx + dy * dy;
        if (distSq < 1e-3 || distSq > SEPARATION_RADIUS * SEPARATION_RADIUS) continue;
        const inv = 1 / Math.sqrt(distSq);
        pushX += dx * inv;
        pushY += dy * inv;
        count++;
      }

      if (count > 0) {
        this._steer.x += (pushX / count) * this.speed * 0.85;
        this._steer.y += (pushY / count) * this.speed * 0.85;
      }
    }

    takeDamage(amount, options = {}) {
      if (this.dead) return 0;
      this.health -= amount;
      this.hitFlash = 1;

      const engine = this.engine;
      if (engine) {
        if (options.knockback && options.direction) {
          this.knockback.copy(options.direction.normalized().scale(options.knockback));
        }
        engine.floatingText.spawn(
          this.position.x, this.position.y - this.radius - 6,
          Math.round(amount),
          { color: options.critical ? '#ffd45e' : '#ffffff', size: options.critical ? 20 : 15 }
        );
        engine.particles.burst(this.position.x, this.position.y, 5, {
          colors: [this.def.accent, '#ffffff'],
          speedMin: 50, speedMax: 180, lifeMin: 0.12, lifeMax: 0.3,
          size: 3, shape: 'spark',
        });
      }

      if (this.health <= 0) this._die();
      return amount;
    }

    _die() {
      this.dead = true;
      const engine = this.engine;
      if (!engine) return;

      engine.particles.burst(this.position.x, this.position.y, this.def.elite ? 46 : 16, {
        colors: [this.def.color, this.def.accent, '#ffffff'],
        speedMin: 70, speedMax: this.def.elite ? 420 : 260,
        lifeMin: 0.25, lifeMax: 0.7, drag: 0.88,
      });
      engine.particles.shockwave(this.position.x, this.position.y, {
        size: this.radius * 0.6, endSize: this.radius * (this.def.elite ? 9 : 3.4),
        color: this.def.color, life: this.def.elite ? 0.7 : 0.32,
      });
      if (this.def.elite) engine.camera.addTrauma(0.5);

      const gems = this.def.elite ? 6 : 1;
      for (let i = 0; i < gems; i++) {
        const offset = gems > 1 ? Vector2.randomInsideCircle(34) : new Vector2(0, 0);
        engine.add(new global.XPGem(
          this.position.x + offset.x,
          this.position.y + offset.y,
          Math.ceil(this.xpValue / gems)
        ));
      }

      if (engine.player) engine.player.addKill();
      engine.events.emit('enemy:died', this);
    }

    draw(ctx) {
      const scale = MathUtils.easeOutCubic(this._spawnAnim);
      if (scale <= 0.01) return;

      this.drawShadow(ctx, scale, 0.28);

      ctx.save();
      ctx.translate(this.position.x, this.position.y + Math.sin(this._wobble) * 1.5);
      ctx.scale(scale, scale);

      const r = this.radius;
      ctx.shadowColor = this.def.color;
      ctx.shadowBlur = this.def.elite ? 26 : 13;
      ctx.fillStyle = this.hitFlash > 0.05 ? '#ffffff' : this.def.color;
      ctx.strokeStyle = this.def.accent;
      ctx.lineWidth = 2;

      ctx.beginPath();
      if (this.def.shape === 'dart') {
        const angle = this.velocity.lengthSq() > 1 ? this.velocity.angle() : 0;
        ctx.rotate(angle + Math.PI / 2);
        ctx.moveTo(0, -r * 1.35);
        ctx.lineTo(r * 0.85, r * 0.9);
        ctx.lineTo(0, r * 0.45);
        ctx.lineTo(-r * 0.85, r * 0.9);
        ctx.closePath();
      } else if (this.def.shape === 'hex') {
        ctx.rotate(this.age * 0.6);
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          const px = Math.cos(a) * r;
          const py = Math.sin(a) * r;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
      } else {
        // 会呼吸的蛋型轮廓
        const squash = 1 + Math.sin(this._wobble) * 0.07;
        ctx.moveTo(0, -r * 1.16 * squash);
        ctx.bezierCurveTo(r * 1.05, -r * 0.7, r * 1.02, r * 0.5, 0, r * squash);
        ctx.bezierCurveTo(-r * 1.02, r * 0.5, -r * 1.05, -r * 0.7, 0, -r * 1.16 * squash);
        ctx.closePath();
      }
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.stroke();

      // 眼睛
      ctx.fillStyle = 'rgba(12,16,28,0.9)';
      ctx.beginPath();
      ctx.ellipse(-r * 0.26, -r * 0.08, r * 0.15, r * 0.22, 0, 0, Math.PI * 2);
      ctx.ellipse(r * 0.26, -r * 0.08, r * 0.15, r * 0.22, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      if (this.health < this.maxHealth) this._drawHealthBar(ctx, scale);
    }

    _drawHealthBar(ctx, scale) {
      const width = this.radius * 2 * scale;
      const x = this.position.x - width / 2;
      const y = this.position.y - this.radius * scale - 11;

      ctx.save();
      ctx.fillStyle = 'rgba(8,12,22,0.75)';
      ctx.fillRect(x - 1, y - 1, width + 2, 5);
      ctx.fillStyle = this.def.elite ? '#ff4d6d' : '#6bffb8';
      ctx.fillRect(x, y, width * MathUtils.clamp(this.health / this.maxHealth, 0, 1), 3);
      ctx.restore();
    }
  }

  Enemy.TYPES = ENEMY_TYPES;
  global.Enemy = Enemy;
})(window);
