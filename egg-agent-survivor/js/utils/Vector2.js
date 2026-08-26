/**
 * Vector2 — 2D 向量数学库
 * 约定：不带 `set/add/...` 前缀的实例方法均返回新实例（不可变风格），
 *      形如 `addSelf` 的方法就地修改（用于每帧高频调用，避免 GC 压力）。
 */
(function (global) {
  'use strict';

  const EPSILON = 1e-6;

  class Vector2 {
    constructor(x = 0, y = 0) {
      this.x = x;
      this.y = y;
    }

    /* ---------- 构造 ---------- */

    static zero() { return new Vector2(0, 0); }
    static one() { return new Vector2(1, 1); }
    static up() { return new Vector2(0, -1); }
    static down() { return new Vector2(0, 1); }
    static left() { return new Vector2(-1, 0); }
    static right() { return new Vector2(1, 0); }

    static fromAngle(radians, length = 1) {
      return new Vector2(Math.cos(radians) * length, Math.sin(radians) * length);
    }

    /** 单位圆内均匀随机点 */
    static randomInsideCircle(radius = 1) {
      const angle = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius;
      return Vector2.fromAngle(angle, r);
    }

    static randomDirection() {
      return Vector2.fromAngle(Math.random() * Math.PI * 2, 1);
    }

    clone() { return new Vector2(this.x, this.y); }

    /* ---------- 就地运算 ---------- */

    set(x, y) { this.x = x; this.y = y; return this; }
    copy(v) { this.x = v.x; this.y = v.y; return this; }
    addSelf(v) { this.x += v.x; this.y += v.y; return this; }
    subSelf(v) { this.x -= v.x; this.y -= v.y; return this; }
    scaleSelf(s) { this.x *= s; this.y *= s; return this; }

    /** this += v * s，积分位置时最常用 */
    addScaledSelf(v, s) { this.x += v.x * s; this.y += v.y * s; return this; }

    normalizeSelf() {
      const len = this.length();
      if (len > EPSILON) { this.x /= len; this.y /= len; }
      return this;
    }

    clampLengthSelf(max) {
      const lenSq = this.lengthSq();
      if (lenSq > max * max && lenSq > EPSILON) {
        const scale = max / Math.sqrt(lenSq);
        this.x *= scale;
        this.y *= scale;
      }
      return this;
    }

    /** 朝 target 做帧率无关的指数插值靠拢，smoothing 为「每秒剩余比例」 */
    smoothDampSelf(target, smoothing, dt) {
      const t = 1 - Math.pow(smoothing, dt);
      this.x += (target.x - this.x) * t;
      this.y += (target.y - this.y) * t;
      return this;
    }

    lerpSelf(target, t) {
      this.x += (target.x - this.x) * t;
      this.y += (target.y - this.y) * t;
      return this;
    }

    /* ---------- 不可变运算 ---------- */

    add(v) { return new Vector2(this.x + v.x, this.y + v.y); }
    sub(v) { return new Vector2(this.x - v.x, this.y - v.y); }
    scale(s) { return new Vector2(this.x * s, this.y * s); }
    mul(v) { return new Vector2(this.x * v.x, this.y * v.y); }
    negate() { return new Vector2(-this.x, -this.y); }

    normalized() {
      const len = this.length();
      return len > EPSILON ? new Vector2(this.x / len, this.y / len) : new Vector2(0, 0);
    }

    /** 逆时针 90 度垂线 */
    perpendicular() { return new Vector2(-this.y, this.x); }

    rotate(radians) {
      const c = Math.cos(radians);
      const s = Math.sin(radians);
      return new Vector2(this.x * c - this.y * s, this.x * s + this.y * c);
    }

    /* ---------- 查询 ---------- */

    length() { return Math.hypot(this.x, this.y); }
    lengthSq() { return this.x * this.x + this.y * this.y; }
    angle() { return Math.atan2(this.y, this.x); }
    dot(v) { return this.x * v.x + this.y * v.y; }
    cross(v) { return this.x * v.y - this.y * v.x; }
    distanceTo(v) { return Math.hypot(v.x - this.x, v.y - this.y); }
    distanceSqTo(v) {
      const dx = v.x - this.x;
      const dy = v.y - this.y;
      return dx * dx + dy * dy;
    }
    isZero() { return this.lengthSq() < EPSILON * EPSILON; }
    equals(v, tolerance = EPSILON) {
      return Math.abs(this.x - v.x) < tolerance && Math.abs(this.y - v.y) < tolerance;
    }

    toString() { return `Vector2(${this.x.toFixed(2)}, ${this.y.toFixed(2)})`; }
  }

  /* ---------- 通用标量工具 ---------- */

  const MathUtils = {
    clamp(value, min, max) { return value < min ? min : value > max ? max : value; },
    lerp(a, b, t) { return a + (b - a) * t; },
    /** 帧率无关的指数插值：smoothing 表示每秒残留比例（越小越快） */
    damp(a, b, smoothing, dt) { return a + (b - a) * (1 - Math.pow(smoothing, dt)); },
    randRange(min, max) { return min + Math.random() * (max - min); },
    randInt(min, max) { return Math.floor(min + Math.random() * (max - min + 1)); },
    pick(array) { return array[Math.floor(Math.random() * array.length)]; },
    chance(probability) { return Math.random() < probability; },
    /** 把 value 从 [inMin,inMax] 映射到 [outMin,outMax] 并夹取 */
    remap(value, inMin, inMax, outMin, outMax) {
      const t = MathUtils.clamp((value - inMin) / (inMax - inMin || 1), 0, 1);
      return outMin + (outMax - outMin) * t;
    },
    easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); },
    easeInOutQuad(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; },
    formatTime(seconds) {
      const total = Math.max(0, Math.floor(seconds));
      const m = String(Math.floor(total / 60)).padStart(2, '0');
      const s = String(total % 60).padStart(2, '0');
      return `${m}:${s}`;
    },
  };

  Vector2.EPSILON = EPSILON;

  global.Vector2 = Vector2;
  global.MathUtils = MathUtils;
})(window);
