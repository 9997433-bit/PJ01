/**
 * JuiceSystem — 打击感反馈层
 *
 * 把「命中定格 / 屏幕闪白 / 伤害飘字 / 击杀爆炸」这四件事收在一处，
 * 战斗逻辑只管发事件与调 API，不用各自去拼粒子参数。
 *
 * 三条节流原则，避免后期几十只怪同时死时把画面糊掉、把帧率拖垮：
 *  1. 命中定格有冷却与单帧上限——定格叠满会让操作变成幻灯片；
 *  2. 屏幕闪白同时最多叠 MAX_FLASHES 层，超出时只抬高最亮的一层；
 *  3. 击杀爆炸先看粒子池余量，池子快满就退化成精简版本。
 *
 * 挂到 engine.juice 上。调用方都要容忍 engine.juice === undefined。
 */
(function (global) {
  'use strict';

  const MathUtils = global.MathUtils;

  const MAX_FLASHES = 4;
  /** 两次命中定格之间的最小间隔（真实秒） */
  const HITSTOP_COOLDOWN = 0.11;
  const HITSTOP_MAX = 0.16;

  class JuiceSystem {
    constructor(options = {}) {
      this.engine = null;
      this.enabled = options.enabled !== false;
      /** 全局强度，0 关闭演出，1 为默认 */
      this.intensity = options.intensity !== undefined ? options.intensity : 1;

      this.flashes = [];
      this._stopCooldown = 0;
    }

    onAdd(engine) {
      this.engine = engine;
      engine.juice = this;

      engine.events.on('enemy:died', (enemy) => this.onKill(enemy));
      engine.events.on('combo:tier', (payload) => this.onComboTier(payload));
      engine.events.on('fever:start', () => this.onFeverStart());
      engine.events.on('fever:end', () => this.flash('#7cf9ff', 0.2, 0.4));
      engine.events.on('player:damaged', () => this.flash('#ff4d6d', 0.34, 0.3));
      engine.events.on('player:levelup', () => this.flash('#ffd45e', 0.3, 0.45));
    }

    reset() {
      this.flashes.length = 0;
      this._stopCooldown = 0;
    }

    /* ================= 基础手段 ================= */

    /**
     * 命中定格。带冷却，密集击杀时只有第一下会真的顿住。
     * @param {number} seconds
     * @returns {boolean} 是否真的定格了
     */
    hitStop(seconds) {
      if (!this.enabled || this.intensity <= 0) return false;
      if (this._stopCooldown > 0) return false;
      const duration = Math.min(HITSTOP_MAX, seconds * this.intensity);
      if (duration <= 0) return false;
      this._stopCooldown = HITSTOP_COOLDOWN;
      this.engine.freeze(duration);
      return true;
    }

    /**
     * 全屏闪色。
     * @param {string} color
     * @param {number} strength 0~1
     * @param {number} life     秒
     */
    flash(color = '#ffffff', strength = 0.4, life = 0.24) {
      if (!this.enabled || this.intensity <= 0) return null;
      const amount = MathUtils.clamp(strength * this.intensity, 0, 1);
      if (amount <= 0.01) return null;

      // 叠满时不再新增图层，只把最弱的一层顶掉，亮度总量才不会失控
      if (this.flashes.length >= MAX_FLASHES) {
        let weakest = 0;
        for (let i = 1; i < this.flashes.length; i++) {
          if (this.flashes[i].strength < this.flashes[weakest].strength) weakest = i;
        }
        if (this.flashes[weakest].strength >= amount) return null;
        this.flashes.splice(weakest, 1);
      }

      const entry = { color, strength: amount, life, maxLife: life };
      this.flashes.push(entry);
      return entry;
    }

    /**
     * 伤害飘字。字号随伤害量对数增长，暴击与击杀另有配色，
     * 这样一眼就能从数字堆里认出「这一下很重」。
     */
    damageNumber(x, y, amount, options = {}) {
      if (!this.enabled) return;
      const value = Math.round(amount);
      if (value <= 0) return;

      const critical = !!options.critical;
      const kill = !!options.kill;
      const size = MathUtils.clamp(13 + Math.log10(1 + value) * 6, 13, 30)
        * (critical ? 1.4 : 1)
        * (kill ? 1.15 : 1);

      let color = '#ffffff';
      if (kill) color = '#ff9ebb';
      if (critical) color = '#ffd45e';

      this.engine.floatingText.spawn(x, y, critical ? `${value}!` : value, {
        color,
        size,
        life: critical ? 1 : 0.8,
        vy: -52 - Math.min(28, value * 0.2),
      });
    }

    /**
     * 单次命中的完整反馈：飘字 + 溅射火花。
     * 武器直伤与弹道命中都走这里，Enemy 自带的那份反馈会被调用方关掉，
     * 免得同一下打出两组数字。
     */
    hit(enemy, amount, options = {}) {
      if (!this.enabled || amount <= 0) return;
      const x = enemy.position.x;
      const y = enemy.position.y;
      this.damageNumber(x, y - enemy.radius - 6, amount, options);

      const particles = this.engine.particles;
      if (particles.activeCount / particles.capacity > 0.85) return;
      const accent = enemy.def ? enemy.def.accent : '#ffffff';
      particles.burst(x, y, options.critical ? 9 : 4, {
        colors: [accent, '#ffffff'],
        speedMin: 50, speedMax: 200, lifeMin: 0.1, lifeMax: 0.28,
        sizeMin: 2, sizeMax: 4, shape: 'spark',
      });
    }

    /** 连击提示字，跟着档位配色一起弹出来 */
    comboPopup(x, y, text, color) {
      if (!this.enabled) return;
      this.engine.floatingText.spawn(x, y, text, { color, size: 26, life: 1.1, vy: -70 });
    }

    /* ================= 事件反馈 ================= */

    onKill(enemy) {
      if (!this.enabled || enemy.culled) return;
      const big = enemy.elite || enemy.isBoss;

      // Boss / 精英才值得打断节奏；杂兵定格会让清场变得黏手
      if (big) this.hitStop(enemy.isBoss ? 0.14 : 0.07);
      if (enemy.isBoss) this.flash('#ffd45e', 0.6, 0.55);
      else if (enemy.elite) this.flash('#ffd45e', 0.22, 0.26);

      this.killBurst(enemy);
    }

    /**
     * 击杀爆炸。Enemy._die() 已经出了一份基础碎片，这里补的是
     * 「亮核 + 冲击环 + 放射火花」，并按粒子池余量降级。
     */
    killBurst(enemy) {
      const engine = this.engine;
      const particles = engine.particles;
      const headroom = 1 - particles.activeCount / particles.capacity;
      if (headroom < 0.12) return;

      const combo = engine.combo;
      // 连击越高炸得越夸张，是「打得好」最直接的视觉回报
      const boost = combo ? 1 + (combo.multiplier - 1) * 0.22 : 1;
      const big = enemy.elite || enemy.isBoss;
      const color = enemy.def ? enemy.def.color : '#ff6b8a';
      const accent = enemy.def ? enemy.def.accent : '#ffffff';
      const x = enemy.position.x;
      const y = enemy.position.y;

      particles.emit({
        x, y,
        life: 0.16, size: enemy.radius * 1.5 * boost, endSize: 0,
        color: '#ffffff', alpha: 0.85, drag: 1,
      });

      if (headroom < 0.3) return;   // 池子紧张时到此为止

      const sparks = Math.round((big ? 18 : 8) * boost * this.intensity);
      particles.burst(x, y, sparks, {
        colors: [color, accent, '#ffffff'],
        speedMin: 140, speedMax: big ? 560 : 340,
        lifeMin: 0.18, lifeMax: 0.5,
        sizeMin: 1.6, sizeMax: 3.4,
        shape: 'spark', stretch: 1.9, drag: 0.87,
      });

      if (combo && combo.multiplier > 1) {
        particles.shockwave(x, y, {
          size: enemy.radius * 0.5,
          endSize: enemy.radius * (2.4 + combo.multiplier * 0.9),
          color: combo.tier.color,
          life: 0.28,
          alpha: 0.7,
        });
      }
    }

    onComboTier({ tier, count, multiplier }) {
      if (multiplier <= 1) return;
      const engine = this.engine;
      const player = engine.player;
      this.flash(tier.color, 0.16 + multiplier * 0.03, 0.3);
      engine.camera.addTrauma(0.06 + multiplier * 0.02);
      if (player) {
        this.comboPopup(
          player.position.x, player.position.y - player.radius - 40,
          `${count} COMBO ×${multiplier}`, tier.color
        );
      }
    }

    onFeverStart() {
      // Fever 是整局最重的一次转场，允许它无视定格冷却
      this._stopCooldown = 0;
      this.hitStop(0.16);
      this.flash('#ff4d6d', 0.7, 0.6);
      this.flash('#ffd45e', 0.4, 0.35);
      const player = this.engine.player;
      if (player) {
        this.comboPopup(player.position.x, player.position.y - player.radius - 62, 'FEVER!', '#ffd45e');
      }
    }

    /* ================= 每帧 ================= */

    /** 演出层用真实时间推进，暂停或选卡时闪白也要照常褪掉 */
    updateAlways(rawDelta) {
      this._stopCooldown = Math.max(0, this._stopCooldown - rawDelta);

      for (let i = this.flashes.length - 1; i >= 0; i--) {
        const f = this.flashes[i];
        f.life -= rawDelta;
        if (f.life <= 0) this.flashes.splice(i, 1);
      }
    }

    drawScreen(ctx, engine) {
      if (!this.flashes.length) return;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < this.flashes.length; i++) {
        const f = this.flashes[i];
        const t = f.life / f.maxLife;
        // 二次衰减：起手很亮、收尾很快，才不会拖出一层脏雾
        ctx.globalAlpha = f.strength * t * t;
        ctx.fillStyle = f.color;
        ctx.fillRect(0, 0, engine.width, engine.height);
      }
      ctx.restore();
    }
  }

  JuiceSystem.MAX_FLASHES = MAX_FLASHES;
  JuiceSystem.HITSTOP_COOLDOWN = HITSTOP_COOLDOWN;
  JuiceSystem.HITSTOP_MAX = HITSTOP_MAX;

  global.JuiceSystem = JuiceSystem;
})(window);
