/**
 * HUD — DOM 抬头显示
 *
 * 数值类 UI 用 DOM 而非 canvas 绘制：文字锐利、无需处理 DPR，
 * 且能直接复用 CSS 动画。每帧只在数值变化时写 DOM，避免无谓重排。
 */
(function (global) {
  'use strict';

  const MathUtils = global.MathUtils;
  const EMPTY = [];
  /** 无元素武器（回旋蛋镖等）的槽位配色 */
  const NEUTRAL_WEAPON_COLOR = '#7cf9ff';
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
        combo: document.getElementById('combo-meter'),
        comboValue: document.getElementById('combo-value'),
        comboMult: document.getElementById('combo-mult'),
        comboLabel: document.getElementById('combo-label'),
        comboFill: document.getElementById('combo-fill'),
        comboFeverFill: document.getElementById('combo-fever-fill'),
        comboFeverLabel: document.getElementById('combo-fever-label'),
        feverOverlay: document.getElementById('fever-overlay'),
        weapons: document.getElementById('weapon-bar'),
      };
      this._cache = {};
      this._fpsTimer = 0;
      this._layout = null;
      this._fever = false;
      /** 武器槽 DOM 只在武器集合/等级变化时重建，每帧只写冷却条宽度 */
      this._weaponSlots = [];
      this._weaponSignature = null;

      engine.events.on('player:damaged', () => this._flashDamage());
      engine.events.on('wave:elite', () => this.showBanner('精英目标出现', '警告'));

      // Fever 的整屏视觉靠 class 驱动，用事件而不是每帧 toggle，
      // 免得 CSS 动画被反复重置。回主菜单时必须强制熄灭。
      engine.events.on('fever:start', () => this._setFever(true));
      engine.events.on('fever:end', () => this._setFever(false));
      engine.events.on('state:change', ({ to }) => {
        if (to === global.GameState.MENU) this._setFever(false);
      });

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

    /** 色调偏移挂在 body 上，画布与整套界面一起进入 Fever */
    _setFever(on) {
      if (this._fever === on) return;
      this._fever = on;
      if (this.el.combo) this.el.combo.classList.toggle('is-fever', on);
      if (this.el.feverOverlay) this.el.feverOverlay.classList.toggle('is-active', on);
      if (document.body) document.body.classList.toggle('is-fever', on);
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

      this._updateCombo();
      this._updateWeapons();

      this._fpsTimer += dt;
      if (this._fpsTimer > 0.35) {
        this._fpsTimer = 0;
        this._set('fps', this.el.fps, Math.round(engine.fps));
      }
    }

    /**
     * 连击表。ComboSystem 没装载时整块隐藏，HUD 不该假设它一定在。
     * 档位配色写成内联变量，CSS 只负责形状与动画。
     */
    _updateCombo() {
      const el = this.el;
      if (!el.combo) return;

      const combo = this.engine.combo;
      const snapshot = combo ? combo.snapshot() : null;
      const active = !!snapshot && (snapshot.count > 0 || snapshot.fever);

      el.combo.classList.toggle('is-active', active);
      if (!snapshot) return;

      this._set('comboValue', el.comboValue, snapshot.count);
      this._set('comboMult', el.comboMult, `×${snapshot.multiplier}`);
      this._set('comboLabel', el.comboLabel, snapshot.fever ? 'FEVER MODE' : snapshot.label);
      this._setWidth('comboFill', el.comboFill, snapshot.timeRatio);
      this._setWidth(
        'comboFever',
        el.comboFeverFill,
        snapshot.fever ? snapshot.feverRatio : snapshot.feverProgress
      );
      this._set('comboFeverLabel', el.comboFeverLabel, snapshot.fever
        ? `FEVER ${Math.ceil(snapshot.feverTimeLeft)}s`
        : `FEVER ${snapshot.count}/${snapshot.feverAt}`);

      if (this._cache.comboColor !== snapshot.color) {
        this._cache.comboColor = snapshot.color;
        this._setCssProperty(el.combo, '--combo-color', snapshot.color);
      }
    }

    /* ================= 武器栏 ================= */

    /** 元素色取自 ElementFusion 的调色板；系统缺席时统一退回霓虹青 */
    _elementColors(elements) {
      const fusion = this.engine.fusion;
      if (!fusion || !elements || !elements.length) {
        return [NEUTRAL_WEAPON_COLOR, NEUTRAL_WEAPON_COLOR];
      }
      const primary = fusion.elementColor(elements[0]);
      return [primary, elements.length > 1 ? fusion.elementColor(elements[1]) : primary];
    }

    /**
     * 底部武器栏：图标 + 等级 + 元素色。
     * 槽位 DOM 只在武器集合或等级变化时重建，每帧只改冷却遮罩的高度，
     * 六把武器 × 60 帧也不会产生可观的重排。
     */
    _updateWeapons() {
      const root = this.el.weapons;
      if (!root) return;

      const weapons = this.engine.weapons;
      const slots = weapons && weapons.snapshot ? weapons.snapshot() : EMPTY;
      if (!slots.length) {
        if (this._weaponSignature !== '') this._clearWeaponSlots();
        return;
      }

      const signature = slots.map((slot) => `${slot.id}.${slot.level}`).join('|');
      if (signature !== this._weaponSignature) {
        this._weaponSignature = signature;
        this._buildWeaponSlots(slots);
        root.classList.add('is-active');
      }

      for (let i = 0; i < this._weaponSlots.length; i++) {
        const node = this._weaponSlots[i];
        const data = slots[i];
        if (!data) continue;

        const pct = `${Math.round((1 - data.ready) * 100)}%`;
        if (node.pct !== pct) {
          node.pct = pct;
          node.cooldown.style.height = pct;
        }
        const ready = data.ready >= 1;
        if (node.ready !== ready) {
          node.ready = ready;
          node.root.classList.toggle('is-ready', ready);
        }
      }
    }

    _clearWeaponSlots() {
      this._weaponSignature = '';
      this._weaponSlots.length = 0;
      if (!this.el.weapons) return;
      this.el.weapons.innerHTML = '';
      this.el.weapons.classList.remove('is-active');
    }

    _buildWeaponSlots(slots) {
      const root = this.el.weapons;
      root.innerHTML = '';
      this._weaponSlots.length = 0;

      for (const data of slots) {
        const [primary, secondary] = this._elementColors(data.elements);
        const node = document.createElement('div');
        node.className = 'weapon'
          + (data.isFusion ? ' weapon--fusion' : '')
          + (data.maxed ? ' is-max' : '');
        node.setAttribute('title', `${data.name} · Lv.${data.level}/${data.maxLevel}`);
        this._setCssProperty(node, '--weapon-color', primary);
        this._setCssProperty(node, '--weapon-color-2', secondary);

        const cooldown = document.createElement('span');
        cooldown.className = 'weapon__cd';

        const icon = document.createElement('span');
        icon.className = 'weapon__icon';
        icon.textContent = data.icon;

        const level = document.createElement('span');
        level.className = 'weapon__level';
        level.textContent = String(data.level);

        node.appendChild(cooldown);
        node.appendChild(icon);
        node.appendChild(level);
        root.appendChild(node);

        this._weaponSlots.push({ root: node, cooldown, pct: null, ready: null });
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
