/**
 * InputManager — 统一键盘 / 鼠标 / 触摸输入
 *
 * 对外只暴露语义化查询：`moveAxis`（归一化方向）、`isDown('dash')`、
 * `wasPressed('pause')`，游戏逻辑无需关心输入来自 WASD 还是虚拟摇杆。
 */
(function (global) {
  'use strict';

  const KEY_BINDINGS = {
    up: ['KeyW', 'ArrowUp'],
    down: ['KeyS', 'ArrowDown'],
    left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
    dash: ['ShiftLeft', 'ShiftRight', 'Space'],
    pause: ['Escape', 'KeyP'],
    confirm: ['Enter', 'NumpadEnter'],
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

      this.joystick = {
        active: false,
        pointerId: null,
        origin: new global.Vector2(0, 0),
        current: new global.Vector2(0, 0),
        vector: new global.Vector2(0, 0),
        radius: options.joystickRadius || 62,
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
      j.active = true;
      j.pointerId = e.pointerId;
      j.origin.copy(this.pointerScreen);
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
        j.origin.copy(j.current.sub(delta.normalized().scale(j.radius)));
        if (j.base) {
          j.base.style.left = `${j.origin.x}px`;
          j.base.style.top = `${j.origin.y}px`;
        }
      }
      j.vector.copy(j.current.sub(j.origin).scale(1 / j.radius)).clampLengthSelf(1);
      this._renderKnob();
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
    }

    reset() {
      this._down.clear();
      this._pressedThisFrame.clear();
      this._releasedThisFrame.clear();
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
  }

  InputManager.KEY_BINDINGS = KEY_BINDINGS;
  global.InputManager = InputManager;
})(window);
