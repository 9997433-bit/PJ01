/**
 * Entity — 所有游戏对象的基类
 * 只做最小约定：位置、速度、圆形碰撞体、渲染层级、生命周期标记。
 */
(function (global) {
  'use strict';

  const Vector2 = global.Vector2;
  let nextId = 1;

  class Entity {
    constructor(x = 0, y = 0, options = {}) {
      this.id = nextId++;
      this.position = new Vector2(x, y);
      this.velocity = new Vector2(0, 0);
      this.radius = options.radius || 12;
      this.tag = options.tag || 'entity';
      this.layer = options.layer !== undefined ? options.layer : global.Layer.ACTOR;

      this.active = true;   // 参与更新
      this.visible = true;  // 参与渲染
      this.dead = false;    // 帧末移除
      this.age = 0;
      this.engine = null;
    }

    update(dt) {
      this.age += dt;
      this.position.addScaledSelf(this.velocity, dt);
    }

    draw(_ctx, _engine) {}

    kill() { this.dead = true; }

    distanceTo(other) { return this.position.distanceTo(other.position); }

    /** 圆-圆重叠检测 */
    overlaps(other, extra = 0) {
      const r = this.radius + other.radius + extra;
      return this.position.distanceSqTo(other.position) <= r * r;
    }

    /** 统一的落地阴影，让角色不像「贴纸」浮在背景上 */
    drawShadow(ctx, scale = 1, alpha = 0.32) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#000000';
      ctx.beginPath();
      ctx.ellipse(
        this.position.x,
        this.position.y + this.radius * 0.82,
        this.radius * 0.85 * scale,
        this.radius * 0.34 * scale,
        0, 0, Math.PI * 2
      );
      ctx.fill();
      ctx.restore();
    }
  }

  global.Entity = Entity;
})(window);
