/**
 * HUD — DOM 抬头显示
 *
 * 数值类 UI 用 DOM 而非 canvas 绘制：文字锐利、无需处理 DPR，
 * 且能直接复用 CSS 动画。每帧只在数值变化时写 DOM，避免无谓重排。
 */
(function (global) {
  'use strict';

  const MathUtils = global.MathUtils;

  class HUD {
    constructor(engine) {
      this.engine = engine;
      this.el = {
        root: document.getElementById('hud'),
        healthFill: document.getElementById('health-fill'),
        healthText: document.getElementById('health-text'),
        xpFill: document.getElementById('xp-fill'),
        level: document.getElementById('level-value'),
        timer: document.getElementById('timer-value'),
        kills: document.getElementById('kills-value'),
        fps: document.getElementById('fps-value'),
        dash: document.getElementById('dash-indicator'),
        dashFill: document.getElementById('dash-fill'),
        wave: document.getElementById('wave-banner'),
      };
      this._cache = {};
      this._fpsTimer = 0;

      engine.events.on('player:damaged', () => this._flashDamage());
      engine.events.on('wave:elite', () => this.showBanner('精英目标出现', '警告'));
    }

    _set(key, element, value) {
      if (!element || this._cache[key] === value) return;
      this._cache[key] = value;
      element.textContent = value;
    }

    _setWidth(key, element, ratio) {
      if (!element) return;
      const pct = `${(ratio * 100).toFixed(1)}%`;
      if (this._cache[key] === pct) return;
      this._cache[key] = pct;
      element.style.width = pct;
    }

    _flashDamage() {
      if (!this.el.root) return;
      this.el.root.classList.remove('is-hurt');
      // 强制回流以便重放动画
      void this.el.root.offsetWidth;
      this.el.root.classList.add('is-hurt');
    }

    showBanner(text, tag = '') {
      const el = this.el.wave;
      if (!el) return;
      el.innerHTML = `${tag ? `<span class="banner-tag">${tag}</span>` : ''}<span>${text}</span>`;
      el.classList.remove('is-visible');
      void el.offsetWidth;
      el.classList.add('is-visible');
      clearTimeout(this._bannerTimer);
      this._bannerTimer = setTimeout(() => el.classList.remove('is-visible'), 2400);
    }

    update(dt) {
      const engine = this.engine;
      const player = engine.player;
      if (!player) return;

      this._setWidth('hp', this.el.healthFill, player.healthPercent);
      this._set('hpText', this.el.healthText,
        `${Math.ceil(player.health)} / ${Math.round(player.stats.maxHealth)}`);
      if (this.el.healthFill) {
        this.el.healthFill.classList.toggle('is-critical', player.healthPercent < 0.3);
      }

      this._setWidth('xp', this.el.xpFill, player.xpPercent);
      this._set('level', this.el.level, player.level);
      this._set('timer', this.el.timer, MathUtils.formatTime(engine.elapsed));
      this._set('kills', this.el.kills, player.kills);

      const ready = player.dashCooldownTimer <= 0;
      const ratio = ready ? 1 : 1 - player.dashCooldownTimer / (player.stats.dashCooldown * player.stats.cooldownMultiplier);
      this._setWidth('dash', this.el.dashFill, MathUtils.clamp(ratio, 0, 1));
      if (this.el.dash) this.el.dash.classList.toggle('is-ready', ready);

      this._fpsTimer += dt;
      if (this._fpsTimer > 0.35) {
        this._fpsTimer = 0;
        this._set('fps', this.el.fps, Math.round(engine.fps));
      }
    }
  }

  global.HUD = HUD;
})(window);
