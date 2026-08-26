/**
 * Background — 无限滚动的霓虹网格 + 视差星尘
 * 只绘制相机可见范围内的格线，因此地图可以无限大而开销恒定。
 */
(function (global) {
  'use strict';

  const GRID_SIZE = 128;
  const STAR_COUNT = 190;
  const STAR_FIELD = 2600; // 星尘在这个尺寸内平铺循环

  class Background {
    constructor() {
      this.stars = [];
      for (let i = 0; i < STAR_COUNT; i++) {
        this.stars.push({
          x: Math.random() * STAR_FIELD,
          y: Math.random() * STAR_FIELD,
          size: global.MathUtils.randRange(0.6, 2.3),
          depth: global.MathUtils.randRange(0.25, 0.75), // 视差深度
          twinkle: Math.random() * Math.PI * 2,
          hue: global.MathUtils.pick(['#7cf9ff', '#b78bff', '#ffffff', '#6bffd0']),
        });
      }
      this.time = 0;
    }

    update(dt) { this.time += dt; }

    draw(ctx, camera) {
      const bounds = camera.getVisibleBounds(GRID_SIZE);
      this._drawStars(ctx, camera);
      this._drawGrid(ctx, bounds);
    }

    _drawStars(ctx, camera) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const view = camera.getVisibleBounds(60);

      for (const star of this.stars) {
        // 按深度做视差后再对星域取模，实现无缝循环
        const px = star.x - camera.position.x * star.depth;
        const py = star.y - camera.position.y * star.depth;
        const x = view.minX + ((px - view.minX) % STAR_FIELD + STAR_FIELD) % STAR_FIELD;
        const y = view.minY + ((py - view.minY) % STAR_FIELD + STAR_FIELD) % STAR_FIELD;
        if (x > view.maxX || y > view.maxY) continue;

        const alpha = 0.25 + Math.sin(this.time * 1.6 + star.twinkle) * 0.2 + star.depth * 0.25;
        ctx.globalAlpha = Math.max(0.05, alpha);
        ctx.fillStyle = star.hue;
        ctx.beginPath();
        ctx.arc(x, y, star.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    _drawGrid(ctx, bounds) {
      const startX = Math.floor(bounds.minX / GRID_SIZE) * GRID_SIZE;
      const startY = Math.floor(bounds.minY / GRID_SIZE) * GRID_SIZE;
      const pulse = 0.5 + Math.sin(this.time * 0.8) * 0.5;

      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = `rgba(84,196,255,${0.075 + pulse * 0.03})`;
      ctx.beginPath();
      for (let x = startX; x <= bounds.maxX; x += GRID_SIZE) {
        ctx.moveTo(x, bounds.minY);
        ctx.lineTo(x, bounds.maxY);
      }
      for (let y = startY; y <= bounds.maxY; y += GRID_SIZE) {
        ctx.moveTo(bounds.minX, y);
        ctx.lineTo(bounds.maxX, y);
      }
      ctx.stroke();

      // 每 4 格一条更亮的主线，提供空间参照
      const major = GRID_SIZE * 4;
      ctx.strokeStyle = `rgba(124,249,255,${0.13 + pulse * 0.05})`;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let x = Math.floor(bounds.minX / major) * major; x <= bounds.maxX; x += major) {
        ctx.moveTo(x, bounds.minY);
        ctx.lineTo(x, bounds.maxY);
      }
      for (let y = Math.floor(bounds.minY / major) * major; y <= bounds.maxY; y += major) {
        ctx.moveTo(bounds.minX, y);
        ctx.lineTo(bounds.maxX, y);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  global.Background = Background;
})(window);
