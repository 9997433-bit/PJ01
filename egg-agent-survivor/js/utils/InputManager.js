/**
 * InputManager — 统一键盘 / 鼠标 / 触摸输入
 *
 * 对外只暴露语义化查询：`moveAxis`（归一化方向）、`isDown('dash')`、
 * `wasPressed('pause')`，游戏逻辑无需关心输入来自 WASD 还是虚拟摇杆。
 */
(function (global) {
  'use strict';

  const MathUtils = global.MathUtils;

  const KEY_BINDINGS = {
    up: ['KeyW', 'ArrowUp'],
    down: ['KeyS', 'ArrowDown'],
    left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
    dash: ['ShiftLeft', 'ShiftRight', 'Space'],
    pause: ['Escape', 'KeyP'],
    confirm: ['Enter', 'NumpadEnter'],
    // 处决 QTE：刻意避开 Space，否则会和冲刺抢同一次按键
    execute: ['KeyE', 'KeyF', 'Enter', 'NumpadEnter'],
    mute: ['KeyM'],
  };

  // 这些键在游戏中会触发页面滚动，需要吞掉默认行为
  const PREVENT_DEFAULT = new Set([
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab',
  ]);

  class InputManager {
    /**
     * @param {HTMLElement} target 接收指针事件的元素（通常是 canvas 容器）
     * @param {{joystickBase?:HTMLElement, joystickKnob?:HTMLElement, joystickRadius?:number}} options
     */
    constructor(target, options = {}) {
      this.target = target || global.document.body;
      this.enabled = true;

      this._down = new Set();
      this._pressedThisFrame = new Set();
      this._releasedThisFrame = new Set();

      this.moveAxis = new global.Vector2(0, 0);
      this.pointerScreen = new global.Vector2(0, 0);
      this.pointerWorld = new global.Vector2(0, 0);
      this.pointerDown = false;
      this.hasTouch = false;
      /** 本帧内是否有一次「按下」边沿，供点击型交互（处决 QTE）查询 */
      this._pointerPressedThisFrame = false;

      this.joystick = {
        active: false,
        pointerId: null,
        origin: new global.Vector2(0, 0),
        current: new global.Vector2(0, 0),
        vector: new global.Vector2(0, 0),
        radius: options.joystickRadius || 48,
        base: options.joystickBase || null,
        knob: options.joystickKnob || null,
      };

      this._bind();
    }

    /* ---------- 事件注册 ---------- */

    _bind() {
      this._onKeyDown = (e) => {
        if (!this.enabled) return;
        if (e.repeat) {
          if (PREVENT_DEFAULT.has(e.code)) e.preventDefault();
          return;
        }
        if (PREVENT_DEFAULT.has(e.code)) e.preventDefault();
        this._down.add(e.code);
        this._pressedThisFrame.add(e.code);
      };

      this._onKeyUp = (e) => {
        this._down.delete(e.code);
        this._releasedThisFrame.add(e.code);
      };

      // 失焦时清空按键，避免切标签页回来后角色一直朝一个方向跑
      this._onBlur = () => this.reset();

      this._onPointerDown = (e) => {
        if (!this.enabled) return;
        this.pointerDown = true;
        this._pointerPressedThisFrame = true;
        this._updatePointer(e);
        if (e.pointerType === 'touch' || e.pointerType === 'pen') {
          this.hasTouch = true;
          this._startJoystick(e);
        }
      };

      this._onPointerMove = (e) => {
        this._updatePointer(e);
        if (this.joystick.active && e.pointerId === this.joystick.pointerId) {
          this._moveJoystick(e);
        }
      };

      this._onPointerUp = (e) => {
        this.pointerDown = false;
        if (this.joystick.active && e.pointerId === this.joystick.pointerId) {
          this._endJoystick();
        }
      };

      const doc = global.document;
      global.addEventListener('keydown', this._onKeyDown, { passive: false });
      global.addEventListener('keyup', this._onKeyUp);
      global.addEventListener('blur', this._onBlur);
      this.target.addEventListener('pointerdown', this._onPointerDown);
      doc.addEventListener('pointermove', this._onPointerMove);
      doc.addEventListener('pointerup', this._onPointerUp);
      doc.addEventListener('pointercancel', this._onPointerUp);
      this.target.addEventListener('contextmenu', (e) => e.preventDefault());
      // iOS Safari 上双指/长按仍会尝试滚动或缩放
      this.target.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    }

    destroy() {
      global.removeEventListener('keydown', this._onKeyDown);
      global.removeEventListener('keyup', this._onKeyUp);
      global.removeEventListener('blur', this._onBlur);
      this.target.removeEventListener('pointerdown', this._onPointerDown);
      global.document.removeEventListener('pointermove', this._onPointerMove);
      global.document.removeEventListener('pointerup', this._onPointerUp);
      global.document.removeEventListener('pointercancel', this._onPointerUp);
    }

    /* ---------- 指针 ---------- */

    _updatePointer(e) {
      const rect = this.target.getBoundingClientRect();
      this.pointerScreen.set(e.clientX - rect.left, e.clientY - rect.top);
    }

    _startJoystick(e) {
      const j = this.joystick;
      const rect = this.target.getBoundingClientRect();
      const interactive = e.target
        && typeof e.target.closest === 'function'
        && e.target.closest('button, a, input, select, textarea, [role="button"]');

      // 移动摇杆只占左半屏；右半屏和 HUD 控件保留给交互与未来的主动技能。
      if (interactive || this.pointerScreen.x > rect.width * 0.5) return;

      j.active = true;
      j.pointerId = e.pointerId;
      j.origin.copy(this._constrainJoystickOrigin(this.pointerScreen, rect));
      j.current.copy(this.pointerScreen);
      j.vector.set(0, 0);
      if (j.base) {
        j.base.style.left = `${j.origin.x}px`;
        j.base.style.top = `${j.origin.y}px`;
        j.base.classList.add('is-active');
      }
      this._renderKnob();
    }

    _moveJoystick(e) {
      const j = this.joystick;
      j.current.copy(this.pointerScreen);
      const delta = j.current.sub(j.origin);
      const len = delta.length();
      // 拖出半径外时把摇杆原点跟着拽走，手指不会「跑出」摇杆
      if (len > j.radius) {
        const shiftedOrigin = j.current.sub(delta.normalized().scale(j.radius));
        j.origin.copy(this._constrainJoystickOrigin(shiftedOrigin));
        if (j.base) {
          j.base.style.left = `${j.origin.x}px`;
          j.base.style.top = `${j.origin.y}px`;
        }
      }
      j.vector.copy(j.current.sub(j.origin).scale(1 / j.radius)).clampLengthSelf(1);
      this._renderKnob();
    }

    _cssPixels(name, fallback = 0) {
      if (typeof global.getComputedStyle !== 'function') return fallback;
      const raw = global.getComputedStyle(this.target).getPropertyValue(name);
      const values = raw && raw.match(/-?(?:\d*\.)?\d+px/g);
      if (!values || values.length === 0) return fallback;
      return values.reduce((sum, value) => sum + Number.parseFloat(value), 0);
    }

    /**
     * HUD.js 把当前布局的保留高度写到 viewport，CSS 再叠加安全区。
     * 原点与底盘半径一起钳制，因此刘海、顶部双行 HUD、横屏状态条都不会被摇杆覆盖。
     */
    _constrainJoystickOrigin(point, suppliedRect) {
      const rect = suppliedRect || this.target.getBoundingClientRect();
      const radius = this.joystick.radius;
      const inset = 8;
      const left = this._cssPixels('--joystick-safe-left', inset) + radius;
      const rightEdge = Math.min(
        rect.width * 0.5 - inset - radius,
        rect.width - this._cssPixels('--joystick-safe-right', inset) - radius,
      );
      const top = this._cssPixels('--joystick-safe-top', 0) + radius;
      const bottom = rect.height - this._cssPixels('--joystick-safe-bottom', 0) - radius;

      // 极端小视口无法容纳完整底盘时固定在可用区中心，避免 min/max 反转产生 NaN。
      const minX = Math.min(left, rightEdge);
      const maxX = Math.max(left, rightEdge);
      const minY = Math.min(top, bottom);
      const maxY = Math.max(top, bottom);
      return new global.Vector2(
        MathUtils.clamp(point.x, minX, maxX),
        MathUtils.clamp(point.y, minY, maxY),
      );
    }

    _endJoystick() {
      const j = this.joystick;
      j.active = false;
      j.pointerId = null;
      j.vector.set(0, 0);
      if (j.base) j.base.classList.remove('is-active');
      if (j.knob) j.knob.style.transform = 'translate(-50%, -50%)';
    }

    _renderKnob() {
      const j = this.joystick;
      if (!j.knob) return;
      j.knob.style.transform =
        `translate(calc(-50% + ${j.vector.x * j.radius}px), calc(-50% + ${j.vector.y * j.radius}px))`;
    }

    /* ---------- 每帧 ---------- */

    /** 在所有游戏逻辑之前调用：刷新方向轴 */
    update(camera) {
      const axis = this.moveAxis.set(0, 0);

      if (this.enabled) {
        if (this._isBindingDown('left')) axis.x -= 1;
        if (this._isBindingDown('right')) axis.x += 1;
        if (this._isBindingDown('up')) axis.y -= 1;
        if (this._isBindingDown('down')) axis.y += 1;
        axis.normalizeSelf();

        if (this.joystick.active && !this.joystick.vector.isZero()) {
          axis.copy(this.joystick.vector).clampLengthSelf(1);
        }
      }

      if (camera) camera.screenToWorld(this.pointerScreen, this.pointerWorld);
      return axis;
    }

    /** 在所有游戏逻辑之后调用：清空「本帧」缓冲 */
    endFrame() {
      this._pressedThisFrame.clear();
      this._releasedThisFrame.clear();
      this._pointerPressedThisFrame = false;
    }

    reset() {
      this._down.clear();
      this._pressedThisFrame.clear();
      this._releasedThisFrame.clear();
      this._pointerPressedThisFrame = false;
      this.moveAxis.set(0, 0);
      this._endJoystick();
    }

    /* ---------- 查询 ---------- */

    _isBindingDown(action) {
      const codes = KEY_BINDINGS[action];
      if (!codes) return false;
      for (const code of codes) if (this._down.has(code)) return true;
      return false;
    }

    isDown(action) { return this.enabled && this._isBindingDown(action); }

    wasPressed(action) {
      const codes = KEY_BINDINGS[action];
      if (!codes) return false;
      for (const code of codes) if (this._pressedThisFrame.has(code)) return true;
      return false;
    }

    isKeyDown(code) { return this._down.has(code); }
    wasKeyPressed(code) { return this._pressedThisFrame.has(code); }
    /** 本帧是否有一次指针按下（鼠标点击 / 触摸），与键盘 wasPressed 语义一致 */
    wasPointerPressed() { return this.enabled && this._pointerPressedThisFrame; }
  }

  InputManager.KEY_BINDINGS = KEY_BINDINGS;
  global.InputManager = InputManager;
})(window);
