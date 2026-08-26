/**
 * ParticleSystem — 定容对象池粒子系统
 *
 * 全部粒子预分配，运行期零 new，避免 GC 造成的掉帧毛刺。
 * 采用 'lighter' 叠加混合，天然贴合霓虹发光风格。
 */
(function (global) {
  'use strict';

  const MathUtils = global.MathUtils;

  class Particle {
    constructor() {
      this.active = false;
      this.x = 0; this.y = 0;
      this.vx = 0; this.vy = 0;
      this.life = 0; this.maxLife = 1;
      this.size = 4; this.endSize = 0;
      this.color = '#7cf9ff';
      this.alpha = 1;
      this.drag = 0.9;
      this.gravity = 0;
      this.shape = 'circle'; // circle | spark | ring
      this.rotation = 0;
      this.spin = 0;
      this.stretch = 1;
    }
  }

  class ParticleSystem {
    constructor(capacity = 1400) {
      this.capacity = capacity;
      this.pool = new Array(capacity);
      for (let i = 0; i < capacity; i++) this.pool[i] = new Particle();
      this._cursor = 0;
      this.activeCount = 0;
    }

    clear() {
      for (let i = 0; i < this.capacity; i++) this.pool[i].active = false;
      this.activeCount = 0;
    }

    /** 取一个空闲粒子；池满时覆盖最老的一个（视觉上无感） */
    _acquire() {
      for (let i = 0; i < this.capacity; i++) {
        const p = this.pool[this._cursor];
        this._cursor = (this._cursor + 1) % this.capacity;
        if (!p.active) return p;
      }
      const fallback = this.pool[this._cursor];
      this._cursor = (this._cursor + 1) % this.capacity;
      return fallback;
    }

    emit(options) {
      const p = this._acquire();
      p.active = true;
      p.x = options.x || 0;
      p.y = options.y || 0;
      p.vx = options.vx || 0;
      p.vy = options.vy || 0;
      p.maxLife = options.life || 0.5;
      p.life = p.maxLife;
      p.size = options.size !== undefined ? options.size : 4;
      p.endSize = options.endSize !== undefined ? options.endSize : 0;
      p.color = options.color || '#7cf9ff';
      p.alpha = options.alpha !== undefined ? options.alpha : 1;
      p.drag = options.drag !== undefined ? options.drag : 0.86;
      p.gravity = options.gravity || 0;
      p.shape = options.shape || 'circle';
      p.rotation = options.rotation || 0;
      p.spin = options.spin || 0;
      p.stretch = options.stretch || 1;
      return p;
    }

    /** 向四周炸开的一簇粒子 */
    burst(x, y, count, options = {}) {
      const speedMin = options.speedMin !== undefined ? options.speedMin : 60;
      const speedMax = options.speedMax !== undefined ? options.speedMax : 220;
      const spread = options.spread !== undefined ? options.spread : Math.PI * 2;
      const baseAngle = options.angle !== undefined ? options.angle : Math.random() * Math.PI * 2;
      const colors = options.colors || [options.color || '#7cf9ff'];

      for (let i = 0; i < count; i++) {
        const angle = baseAngle + (Math.random() - 0.5) * spread;
        const speed = MathUtils.randRange(speedMin, speedMax);
        this.emit({
          x: x + (options.jitter ? MathUtils.randRange(-options.jitter, options.jitter) : 0),
          y: y + (options.jitter ? MathUtils.randRange(-options.jitter, options.jitter) : 0),
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: MathUtils.randRange(options.lifeMin || 0.25, options.lifeMax || 0.6),
          size: MathUtils.randRange(options.sizeMin || 2, options.sizeMax || 5),
          endSize: options.endSize || 0,
          color: MathUtils.pick(colors),
          drag: options.drag !== undefined ? options.drag : 0.86,
          gravity: options.gravity || 0,
          shape: options.shape || 'circle',
          spin: options.spin || 0,
          stretch: options.stretch || 1,
        });
      }
    }

    /** 扩散的能量环，用于升级 / 冲刺 / 爆炸 */
    shockwave(x, y, options = {}) {
      this.emit({
        x, y,
        life: options.life || 0.45,
        size: options.size || 14,
        endSize: options.endSize || 130,
        color: options.color || '#7cf9ff',
        alpha: options.alpha !== undefined ? options.alpha : 0.9,
        drag: 1,
        shape: 'ring',
      });
    }

    update(dt) {
      let active = 0;
      for (let i = 0; i < this.capacity; i++) {
        const p = this.pool[i];
        if (!p.active) continue;

        p.life -= dt;
        if (p.life <= 0) {
          p.active = false;
          continue;
        }

        // drag 定义为「每秒残留速度比例」，保证不同帧率下衰减一致
        const damping = Math.pow(p.drag, dt * 60);
        p.vx *= damping;
        p.vy *= damping;
        p.vy += p.gravity * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rotation += p.spin * dt;
        active++;
      }
      this.activeCount = active;
    }

    /** 需在相机变换已应用的上下文中调用 */
    draw(ctx, camera) {
      if (this.activeCount === 0) return;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      for (let i = 0; i < this.capacity; i++) {
        const p = this.pool[i];
        if (!p.active) continue;
        if (camera && !camera.isVisible(p, 160)) continue;

        const t = p.life / p.maxLife;          // 1 → 0
        const size = p.endSize
          ? MathUtils.lerp(p.endSize, p.size, t)
          : p.size * t;
        if (size <= 0.15) continue;

        ctx.globalAlpha = Math.min(1, p.alpha * t);
        ctx.fillStyle = p.color;
        ctx.strokeStyle = p.color;

        if (p.shape === 'ring') {
          ctx.lineWidth = Math.max(1, 5 * t);
          ctx.beginPath();
          ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
          ctx.stroke();
        } else if (p.shape === 'spark') {
          const len = size * p.stretch * 2.4;
          const angle = Math.atan2(p.vy, p.vx);
          ctx.lineWidth = Math.max(1, size * 0.6);
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - Math.cos(angle) * len, p.y - Math.sin(angle) * len);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.restore();
    }
  }

  /* ---------- 漂浮文字（伤害数字 / 提示） ---------- */

  class FloatingTextSystem {
    constructor(capacity = 80) {
      this.capacity = capacity;
      this.items = [];
      for (let i = 0; i < capacity; i++) {
        this.items.push({ active: false, x: 0, y: 0, vy: -46, life: 0, maxLife: 0.9, text: '', color: '#fff', size: 16 });
      }
      this._cursor = 0;
    }

    spawn(x, y, text, options = {}) {
      const item = this.items[this._cursor];
      this._cursor = (this._cursor + 1) % this.capacity;
      item.active = true;
      item.x = x + MathUtils.randRange(-6, 6);
      item.y = y;
      item.vy = options.vy !== undefined ? options.vy : -52;
      item.maxLife = options.life || 0.85;
      item.life = item.maxLife;
      item.text = String(text);
      item.color = options.color || '#ffffff';
      item.size = options.size || 15;
    }

    clear() { for (const item of this.items) item.active = false; }

    update(dt) {
      for (const item of this.items) {
        if (!item.active) continue;
        item.life -= dt;
        if (item.life <= 0) { item.active = false; continue; }
        item.y += item.vy * dt;
        item.vy *= Math.pow(0.94, dt * 60);
      }
    }

    draw(ctx, camera) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const item of this.items) {
        if (!item.active) continue;
        if (camera && !camera.isVisible(item, 80)) continue;
        const t = item.life / item.maxLife;
        const pop = t > 0.8 ? MathUtils.remap(t, 1, 0.8, 1.5, 1) : 1;
        ctx.globalAlpha = Math.min(1, t * 1.6);
        ctx.font = `800 ${item.size * pop}px "Rajdhani", "Segoe UI", sans-serif`;
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(4,6,16,0.85)';
        ctx.strokeText(item.text, item.x, item.y);
        ctx.fillStyle = item.color;
        ctx.fillText(item.text, item.x, item.y);
      }
      ctx.restore();
    }
  }

  global.Particle = Particle;
  global.ParticleSystem = ParticleSystem;
  global.FloatingTextSystem = FloatingTextSystem;
})(window);
