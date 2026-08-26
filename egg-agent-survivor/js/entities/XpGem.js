/**
 * XpGem / Pickup — 掉落物
 *
 * XpGem：经验宝石。四档品质随价值自动切换外观；进入玩家拾取半径后加速吸附，
 *        越近吸得越快 —— 这个非线性的加速度就是「唰」地被吸走的手感来源。
 * Pickup：功能性掉落（回血 / 全图吸取 / 清屏冲击波 / 金币）。
 *
 * 两者接口一致，CollisionSystem 与引擎可以无差别处理。
 */
(function (global) {
  'use strict';

  const MathUtils = global.MathUtils;
  const TAU = Math.PI * 2;

  /** 价值 → 外观档位 */
  const GEM_TIERS = [
    { min: 0,  color: '#4fd8ff', edge: '#0b5f8a', size: 5.2, name: '碎片' },
    { min: 12, color: '#6bffb8', edge: '#12683a', size: 6.4, name: '结晶' },
    { min: 40, color: '#b78bff', edge: '#4a1f80', size: 7.8, name: '灵核' },
    { min: 110, color: '#ffd45e', edge: '#8a5f0b', size: 9.6, name: '王冠' },
  ];

  function tierFor(value) {
    let tier = GEM_TIERS[0];
    for (const t of GEM_TIERS) if (value >= t.min) tier = t;
    return tier;
  }

  class XpGem extends global.Entity {
    constructor(x, y, value = 1) {
      const v = Math.max(1, Math.round(value));
      const tier = tierFor(v);
      super(x, y, { radius: tier.size, tag: 'gem', layer: global.Layer.PICKUP });

      this.value = v;
      this.tier = tier;
      this.isGem = true;
      this.collecting = false;
      this.pullSpeed = 0;
      this.seed = Math.random();
      this.life = 95;      // 长时间未拾取自动消失，控制实体总量

      // 出生时向外抛洒一小段，避免宝石完全重叠
      const angle = Math.random() * TAU;
      const speed = MathUtils.randRange(50, 140);
      this.velocity.set(Math.cos(angle) * speed, Math.sin(angle) * speed);
    }

    update(dt, engine) {
      this.age += dt;
      this.life -= dt;
      if (this.life <= 0) { this.dead = true; return; }

      const player = engine.player;
      if (!player || !player.isAlive) return;

      const dx = player.position.x - this.position.x;
      const dy = player.position.y - this.position.y;
      const distance = Math.hypot(dx, dy) || 1;
      const pickupRadius = player.stats.pickupRadius;

      if (!this.collecting && (distance < pickupRadius || engine.magnetAll)) {
        this.collecting = true;
      }

      if (this.collecting) {
        this.pullSpeed = Math.min(this.pullSpeed + 1600 * dt, 1500);
        // 越近加速越猛
        const boost = MathUtils.remap(distance, 0, pickupRadius || 1, 2.2, 1);
        this.position.x += (dx / distance) * this.pullSpeed * boost * dt;
        this.position.y += (dy / distance) * this.pullSpeed * boost * dt;
        if (distance < player.radius + this.radius) this.collect(engine);
      } else {
        this.position.addScaledSelf(this.velocity, dt);
        this.velocity.scaleSelf(Math.pow(0.0009, dt));
      }
    }

    collect(engine) {
      if (this.dead) return;
      this.dead = true;
      const player = engine.player;
      engine.player.gainXp(this.value);
      // 经验飘字跟着玩家走并按窗口累加：连吸十几颗也只有一个滚动的 +N
      if (engine.floatingText && engine.floatingText.xp) {
        engine.floatingText.xp(player, player.position.x, player.position.y - player.radius - 14, this.value);
      }
      engine.particles.burst(this.position.x, this.position.y, 4, {
        colors: [this.tier.color, '#ffffff'],
        speedMin: 30, speedMax: 120, lifeMin: 0.1, lifeMax: 0.26,
        sizeMin: 1.5, sizeMax: 3,
      });
      engine.events.emit('gem:collected', this);
      if (engine.audio) engine.audio.play('gem');
    }

    draw(ctx) {
      const bob = Math.sin(this.age * 3.4 + this.seed * TAU) * 1.8;
      const r = this.radius;
      // 快消失时闪烁提示
      const blink = this.life < 6 && Math.sin(this.age * 18) < 0 ? 0.3 : 1;

      ctx.save();
      ctx.translate(this.position.x, this.position.y + bob);
      ctx.rotate(this.age * 1.2 + this.seed * TAU);
      ctx.globalAlpha = blink;

      ctx.shadowColor = this.tier.color;
      ctx.shadowBlur = 12;
      ctx.fillStyle = this.tier.color;
      ctx.strokeStyle = this.tier.edge;
      ctx.lineWidth = 1.4;

      ctx.beginPath();
      ctx.moveTo(0, -r * 1.3);
      ctx.lineTo(r, 0);
      ctx.lineTo(0, r * 1.3);
      ctx.lineTo(-r, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.beginPath();
      ctx.moveTo(0, -r * 1.3);
      ctx.lineTo(r * 0.42, -r * 0.2);
      ctx.lineTo(0, r * 0.1);
      ctx.closePath();
      ctx.fill();

      ctx.restore();
    }
  }

  /* ------------------------------------------------------------------ */

  const PICKUP_TYPES = {
    heal: {
      color: '#ff7a9c', edge: '#7d1230', label: '♥', banner: '蛋黄补给',
      apply(engine) {
        engine.player.heal(engine.player.stats.maxHealth * 0.3);
      },
    },
    magnet: {
      color: '#4fd8ff', edge: '#0c4a70', label: '✦', banner: '全图吸取',
      apply(engine) {
        engine.magnetAll = true;
        engine.magnetTimer = 1.1;
      },
    },
    bomb: {
      color: '#ffb03a', edge: '#7a4405', label: '✹', banner: '蛋壳冲击波',
      apply(engine) {
        const p = engine.player;
        const radius = 520;
        engine.camera.addTrauma(0.85);
        engine.freeze(0.08);
        engine.particles.shockwave(p.position.x, p.position.y, {
          size: 30, endSize: radius * 2, color: '#ffb03a', life: 0.75,
        });
        const combat = engine.combat;
        if (!combat) return;
        const damage = 120 + (engine.spawner ? engine.spawner.wave * 18 : 0);
        for (const enemy of combat.queryCircle(p.position.x, p.position.y, radius)) {
          enemy.takeDamage(damage, { source: 'bomb', knockback: 340 });
        }
      },
    },
    coin: {
      color: '#ffd45e', edge: '#7a5a12', label: '¢', banner: '',
      apply(engine) { engine.coins = (engine.coins || 0) + 10; },
    },
  };

  class Pickup extends global.Entity {
    constructor(x, y, typeKey = 'heal') {
      super(x, y, { radius: 12, tag: 'pickup', layer: global.Layer.PICKUP });
      this.typeKey = typeKey;
      this.def = PICKUP_TYPES[typeKey] || PICKUP_TYPES.heal;
      this.isGem = false;
      this.collecting = false;
      this.pullSpeed = 0;
      this.seed = Math.random();
      this.life = 45;
    }

    update(dt, engine) {
      this.age += dt;
      this.life -= dt;
      if (this.life <= 0) { this.dead = true; return; }

      const player = engine.player;
      if (!player || !player.isAlive) return;

      const dx = player.position.x - this.position.x;
      const dy = player.position.y - this.position.y;
      const distance = Math.hypot(dx, dy) || 1;

      if (distance < player.stats.pickupRadius * 0.85 || engine.magnetAll) this.collecting = true;
      if (this.collecting) {
        this.pullSpeed = Math.min(this.pullSpeed + 1300 * dt, 1200);
        this.position.x += (dx / distance) * this.pullSpeed * dt;
        this.position.y += (dy / distance) * this.pullSpeed * dt;
      }
      if (distance < player.radius + this.radius) this.collect(engine);
    }

    collect(engine) {
      if (this.dead) return;
      this.dead = true;
      this.def.apply(engine);
      engine.particles.burst(this.position.x, this.position.y, 12, {
        colors: [this.def.color, '#ffffff'],
        speedMin: 60, speedMax: 240, lifeMin: 0.2, lifeMax: 0.5,
      });
      if (this.def.banner && engine.hud) engine.hud.showBanner(this.def.banner, '补给');
      if (engine.audio) engine.audio.play('pickup');
    }

    draw(ctx) {
      const bob = Math.sin(this.age * 3 + this.seed * TAU) * 2.4;
      const blink = this.life < 5 && Math.sin(this.age * 18) < 0 ? 0.3 : 1;

      ctx.save();
      ctx.translate(this.position.x, this.position.y + bob);
      ctx.globalAlpha = blink;
      ctx.shadowColor = this.def.color;
      ctx.shadowBlur = 16;

      ctx.fillStyle = this.def.color;
      ctx.strokeStyle = this.def.edge;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(0, 0, this.radius * 0.86, this.radius, 0, 0, TAU);
      ctx.fill();
      ctx.stroke();

      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 12px "Rajdhani", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.def.label, 0, 0.5);

      ctx.restore();
    }
  }

  XpGem.TIERS = GEM_TIERS;
  Pickup.TYPES = PICKUP_TYPES;

  global.XpGem = XpGem;
  // 兼容早期命名
  global.XPGem = XpGem;
  global.Pickup = Pickup;
})(window);
