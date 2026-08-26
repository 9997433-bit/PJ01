/**
 * HUD — DOM 抬头显示
 *
 * 数值类 UI 用 DOM 而非 canvas 绘制：文字锐利、无需处理 DPR，
 * 且能直接复用 CSS 动画。每帧只在数值变化时写 DOM，避免无谓重排。
 */
(function (global) {
  'use strict';

  const MathUtils = global.MathUtils;
  const LAYOUT_BREAKPOINTS = Object.freeze({
    compactWidth: 860,
    portraitWidth: 620,
    shortHeight: 520,
  });
  const LAYOUT_RESERVES = Object.freeze({
    wide: Object.freeze({ top: 72, bottom: 82 }),
    compact: Object.freeze({ top: 64, bottom: 12 }),
    portrait: Object.freeze({ top: 108, bottom: 12 }),
  });

  class HUD {
    constructor(engine) {
      this.engine = engine;
      this.el = {
        root: document.getElementById('hud'),
        viewport: document.getElementById('viewport'),
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
      this._layout = null;

      engine.events.on('player:damaged', () => this._flashDamage());
      engine.events.on('wave:elite', () => this.showBanner('精英目标出现', '警告'));

      this._onViewportChange = () => this._syncLayout();
      global.addEventListener('resize', this._onViewportChange);
      global.addEventListener('orientationchange', this._onViewportChange);
      if (global.visualViewport) {
        global.visualViewport.addEventListener('resize', this._onViewportChange);
      }
      if (global.ResizeObserver && this.el.viewport) {
        this._resizeObserver = new global.ResizeObserver(this._onViewportChange);
        this._resizeObserver.observe(this.el.viewport);
      }
      this._syncLayout();
    }

    /**
     * 保持 JS 与 CSS 的断点只有一个语义来源，测试可直接覆盖边界值。
     * 短横屏优先走 compact；窄竖屏固定双行，避免地址栏伸缩导致来回跳版。
     */
    static layoutForViewport(width, height) {
      const safeWidth = Number.isFinite(width) && width > 0 ? width : 1;
      const safeHeight = Number.isFinite(height) && height > 0 ? height : 1;
      const short = safeHeight <= LAYOUT_BREAKPOINTS.shortHeight;
      const portrait = safeHeight >= safeWidth;
      let name = 'wide';

      if (safeWidth <= LAYOUT_BREAKPOINTS.portraitWidth && portrait) {
        name = 'portrait';
      } else if (safeWidth <= LAYOUT_BREAKPOINTS.compactWidth || short) {
        name = 'compact';
      }

      return {
        name,
        short,
        topReserve: LAYOUT_RESERVES[name].top,
        bottomReserve: LAYOUT_RESERVES[name].bottom,
      };
    }

    _viewportSize() {
      const visual = global.visualViewport;
      if (
        visual
        && Number.isFinite(visual.width)
        && visual.width > 0
        && Number.isFinite(visual.height)
        && visual.height > 0
      ) {
        return { width: visual.width, height: visual.height };
      }

      if (this.el.viewport && typeof this.el.viewport.getBoundingClientRect === 'function') {
        const rect = this.el.viewport.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          return { width: rect.width, height: rect.height };
        }
      }

      return {
        width: global.innerWidth || 1,
        height: global.innerHeight || 1,
      };
    }

    _setCssProperty(element, name, value) {
      if (element && element.style && typeof element.style.setProperty === 'function') {
        element.style.setProperty(name, value);
      }
    }

    _syncLayout() {
      const { width, height } = this._viewportSize();
      const next = HUD.layoutForViewport(width, height);
      const signature = `${next.name}:${next.short}:${Math.round(width)}x${Math.round(height)}`;
      if (this._layout === signature) return;
      this._layout = signature;

      if (this.el.root) {
        this.el.root.dataset.layout = next.name;
        this.el.root.dataset.short = String(next.short);
        this._setCssProperty(this.el.root, '--hud-viewport-width', `${width}px`);
        this._setCssProperty(this.el.root, '--hud-viewport-height', `${height}px`);
      }

      // InputManager 从 viewport 的计算样式读取这两项，把动态摇杆限制在 HUD 外。
      if (this.el.viewport) {
        this.el.viewport.dataset.hudLayout = next.name;
        this._setCssProperty(this.el.viewport, '--hud-top-reserve', `${next.topReserve}px`);
        this._setCssProperty(this.el.viewport, '--hud-bottom-reserve', `${next.bottomReserve}px`);
      }
    }

    _set(key, element, value) {
      if (!element || this._cache[key] === value) return;
      this._cache[key] = value;
      element.textContent = value;
    }

    _setWidth(key, element, ratio) {
      if (!element) return;
      const safeRatio = Number.isFinite(ratio) ? MathUtils.clamp(ratio, 0, 1) : 0;
      const pct = `${(safeRatio * 100).toFixed(1)}%`;
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

    destroy() {
      clearTimeout(this._bannerTimer);
      global.removeEventListener('resize', this._onViewportChange);
      global.removeEventListener('orientationchange', this._onViewportChange);
      if (global.visualViewport) {
        global.visualViewport.removeEventListener('resize', this._onViewportChange);
      }
      if (this._resizeObserver) this._resizeObserver.disconnect();
    }
  }

  HUD.LAYOUT_BREAKPOINTS = LAYOUT_BREAKPOINTS;
  global.HUD = HUD;
})(window);
