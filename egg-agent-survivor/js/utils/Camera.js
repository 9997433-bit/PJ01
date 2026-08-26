/**
 * Camera — 平滑跟随相机
 *
 * 特性：帧率无关的指数平滑、按移动方向的前瞻偏移（look-ahead）、
 *      基于 trauma 的屏震、缩放、世界/屏幕坐标互转与可见性剔除。
 */
(function (global) {
  'use strict';

  const Vector2 = global.Vector2;
  const MathUtils = global.MathUtils;

  class Camera {
    constructor(options = {}) {
      this.position = new Vector2(0, 0);
      this.target = null;

      this.viewportWidth = options.width || 1;
      this.viewportHeight = options.height || 1;

      this.zoom = options.zoom || 1;
      this.targetZoom = this.zoom;

      /** 每秒残留比例，越小跟随越紧（0.0015 ≈ 手感偏跟手） */
      this.smoothing = options.smoothing !== undefined ? options.smoothing : 0.0018;
      /** 沿速度方向前瞻的最大像素数，让玩家看到更多前方空间 */
      this.lookAhead = options.lookAhead !== undefined ? options.lookAhead : 68;

      this._lookAheadOffset = new Vector2(0, 0);
      this._desired = new Vector2(0, 0);
      this._shakeOffset = new Vector2(0, 0);

      this.trauma = 0;
      this.traumaDecay = 1.4;
      this.maxShake = 26;
      this._shakeTime = 0;

      /** 可选的世界边界 {minX,minY,maxX,maxY}，null 表示无限地图 */
      this.bounds = options.bounds || null;
    }

    resize(width, height) {
      this.viewportWidth = Math.max(1, width);
      this.viewportHeight = Math.max(1, height);
    }

    follow(target, snap = false) {
      this.target = target;
      if (snap && target) this.snapToTarget();
    }

    snapToTarget() {
      if (!this.target) return;
      this.position.copy(this.target.position);
      this._lookAheadOffset.set(0, 0);
    }

    addTrauma(amount) {
      this.trauma = MathUtils.clamp(this.trauma + amount, 0, 1);
    }

    setZoom(zoom, immediate = false) {
      this.targetZoom = zoom;
      if (immediate) this.zoom = zoom;
    }

    update(dt) {
      this.zoom = MathUtils.damp(this.zoom, this.targetZoom, 0.02, dt);

      if (this.target) {
        const targetPos = this.target.position;
        const velocity = this.target.velocity;

        if (velocity && this.lookAhead > 0) {
          const speed = velocity.length();
          const scale = speed > 1
            ? Math.min(1, speed / 260) * this.lookAhead / speed
            : 0;
          this._desired.set(velocity.x * scale, velocity.y * scale);
          this._lookAheadOffset.smoothDampSelf(this._desired, 0.05, dt);
        }

        this._desired.set(
          targetPos.x + this._lookAheadOffset.x,
          targetPos.y + this._lookAheadOffset.y
        );
        this.position.smoothDampSelf(this._desired, this.smoothing, dt);
      }

      this._clampToBounds();
      this._updateShake(dt);
    }

    _clampToBounds() {
      if (!this.bounds) return;
      const halfW = this.viewportWidth / (2 * this.zoom);
      const halfH = this.viewportHeight / (2 * this.zoom);
      const b = this.bounds;
      if (b.maxX - b.minX > halfW * 2) {
        this.position.x = MathUtils.clamp(this.position.x, b.minX + halfW, b.maxX - halfW);
      } else {
        this.position.x = (b.minX + b.maxX) / 2;
      }
      if (b.maxY - b.minY > halfH * 2) {
        this.position.y = MathUtils.clamp(this.position.y, b.minY + halfH, b.maxY - halfH);
      } else {
        this.position.y = (b.minY + b.maxY) / 2;
      }
    }

    _updateShake(dt) {
      if (this.trauma <= 0) {
        this._shakeOffset.set(0, 0);
        return;
      }
      this._shakeTime += dt;
      // trauma 的平方让小伤害几乎无感、大爆发非常明显
      const magnitude = this.trauma * this.trauma * this.maxShake;
      const t = this._shakeTime * 34;
      this._shakeOffset.set(
        Math.sin(t * 1.7) * Math.cos(t * 0.9) * magnitude,
        Math.sin(t * 2.3 + 1.1) * Math.cos(t * 1.3) * magnitude
      );
      this.trauma = Math.max(0, this.trauma - this.traumaDecay * dt);
    }

    /* ---------- 变换 ---------- */

    /** 在绘制世界物体前调用（外部需自行 ctx.save()/restore()） */
    applyTransform(ctx) {
      ctx.translate(this.viewportWidth / 2, this.viewportHeight / 2);
      ctx.scale(this.zoom, this.zoom);
      ctx.translate(
        -this.position.x + this._shakeOffset.x,
        -this.position.y + this._shakeOffset.y
      );
    }

    worldToScreen(world, out) {
      const result = out || new Vector2();
      return result.set(
        (world.x - this.position.x - this._shakeOffset.x) * this.zoom + this.viewportWidth / 2,
        (world.y - this.position.y - this._shakeOffset.y) * this.zoom + this.viewportHeight / 2
      );
    }

    screenToWorld(screen, out) {
      const result = out || new Vector2();
      return result.set(
        (screen.x - this.viewportWidth / 2) / this.zoom + this.position.x + this._shakeOffset.x,
        (screen.y - this.viewportHeight / 2) / this.zoom + this.position.y + this._shakeOffset.y
      );
    }

    /** 视锥剔除：世界坐标点在视野内（含 margin 外扩）时返回 true */
    isVisible(position, radius = 0) {
      const halfW = this.viewportWidth / (2 * this.zoom) + radius;
      const halfH = this.viewportHeight / (2 * this.zoom) + radius;
      return Math.abs(position.x - this.position.x) <= halfW
        && Math.abs(position.y - this.position.y) <= halfH;
    }

    /** 返回当前可见的世界矩形，供背景网格等按需绘制 */
    getVisibleBounds(margin = 0) {
      const halfW = this.viewportWidth / (2 * this.zoom) + margin;
      const halfH = this.viewportHeight / (2 * this.zoom) + margin;
      return {
        minX: this.position.x - halfW,
        minY: this.position.y - halfH,
        maxX: this.position.x + halfW,
        maxY: this.position.y + halfH,
      };
    }

    /**
     * 视野外的随机世界坐标点，用于生成敌人。
     * 沿外扩矩形的周长取点（而不是外接圆），敌人从任何方向进场的距离都一致。
     */
    randomPointOutside(margin = 90) {
      const halfW = this.viewportWidth / (2 * this.zoom) + margin;
      const halfH = this.viewportHeight / (2 * this.zoom) + margin;
      const perimeter = (halfW + halfH) * 4;
      let t = Math.random() * perimeter;

      let x;
      let y;
      if (t < halfW * 2) { x = -halfW + t; y = -halfH; }
      else if ((t -= halfW * 2) < halfH * 2) { x = halfW; y = -halfH + t; }
      else if ((t -= halfH * 2) < halfW * 2) { x = halfW - t; y = halfH; }
      else { x = -halfW; y = halfH - (t - halfW * 2); }

      return new Vector2(this.position.x + x, this.position.y + y);
    }

    reset() {
      this.position.set(0, 0);
      this._lookAheadOffset.set(0, 0);
      this._shakeOffset.set(0, 0);
      this.trauma = 0;
      this.zoom = this.targetZoom;
    }
  }

  global.Camera = Camera;
})(window);
