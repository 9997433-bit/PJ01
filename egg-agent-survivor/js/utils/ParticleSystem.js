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
      this._poolIndex = -1;
      this._activeSlot = -1;
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
    constructor(capacity = 3000) {
      this.capacity = Math.max(1, Math.floor(capacity));
      this.pool = new Array(this.capacity);
      this._activeIndices = new Int32Array(this.capacity);
      this._freeIndices = new Int32Array(this.capacity);
      for (let i = 0; i < this.capacity; i++) {
        const particle = new Particle();
        particle._poolIndex = i;
        this.pool[i] = particle;
        this._freeIndices[i] = this.capacity - i - 1;
      }
      this._freeCount = this.capacity;
      this._overflowCursor = 0;
      this.activeCount = 0;
      this.emissionScale = 1;
      this.renderScale = 1;
      this.activeLimit = this.capacity;

      // 批次按 shape / color / alpha / lineWidth 缓存，运行期只复用数组。
      this._batchMap = new Map();
      this._batches = [];
      this.lastDrawCount = 0;
      this.lastBatchCount = 0;
    }

    clear() {
      for (let slot = 0; slot < this.activeCount; slot++) {
        const index = this._activeIndices[slot];
        const particle = this.pool[index];
        particle.active = false;
        particle._activeSlot = -1;
      }
      for (let i = 0; i < this.capacity; i++) this._freeIndices[i] = this.capacity - i - 1;
      this._freeCount = this.capacity;
      this.activeCount = 0;
      this._overflowCursor = 0;
      this.lastDrawCount = 0;
      this.lastBatchCount = 0;
    }

    setQuality(emissionScale = 1, renderScale = 1) {
      this.emissionScale = MathUtils.clamp(emissionScale, 0.1, 1);
      this.renderScale = MathUtils.clamp(renderScale, 0.1, 1);
      this.activeLimit = Math.max(64, Math.floor(this.capacity * this.emissionScale));
    }

    /** O(1) 取空闲粒子；池满时覆盖一个已有粒子。 */
    _acquire(essential = false) {
      if (!essential && this.activeCount >= this.activeLimit) return null;

      if (this._freeCount > 0) {
        const index = this._freeIndices[--this._freeCount];
        const particle = this.pool[index];
        particle._activeSlot = this.activeCount;
        this._activeIndices[this.activeCount++] = index;
        return particle;
      }

      const slot = this._overflowCursor++ % this.activeCount;
      return this.pool[this._activeIndices[slot]];
    }

    _releaseAt(slot) {
      const index = this._activeIndices[slot];
      const particle = this.pool[index];
      const lastSlot = this.activeCount - 1;
      const lastIndex = this._activeIndices[lastSlot];

      particle.active = false;
      particle._activeSlot = -1;
      if (slot !== lastSlot) {
        this._activeIndices[slot] = lastIndex;
        this.pool[lastIndex]._activeSlot = slot;
      }
      this.activeCount = lastSlot;
      this._freeIndices[this._freeCount++] = index;
    }

    emit(options, essential = false) {
      const p = this._acquire(essential);
      if (!p) return null;
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

      const scaledCount = Math.max(1, Math.round(count * this.emissionScale));
      for (let i = 0; i < scaledCount; i++) {
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
      }, true);
    }

    update(dt) {
      let slot = 0;
      while (slot < this.activeCount) {
        const p = this.pool[this._activeIndices[slot]];

        p.life -= dt;
        if (p.life <= 0) {
          this._releaseAt(slot);
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
        slot++;
      }
    }

    /** 需在相机变换已应用的上下文中调用 */
    draw(ctx, camera, frameId = 0) {
      if (this.activeCount === 0) {
        this.lastDrawCount = 0;
        this.lastBatchCount = 0;
        return;
      }

      for (let i = 0; i < this._batches.length; i++) {
        this._batches[i].indices.length = 0;
      }

      let drawCount = 0;
      for (let slot = 0; slot < this.activeCount; slot++) {
        const index = this._activeIndices[slot];
        const p = this.pool[index];
        // 固定哈希采样可降低绘制量，同时避免每帧随机抽样造成闪烁。
        if (this.renderScale < 0.999) {
          const hash = Math.imul(index + 1, 2654435761) >>> 0;
          if (hash / 4294967296 > this.renderScale) continue;
        }
        if (camera && !camera.isVisible(p, 160)) continue;

        const t = p.life / p.maxLife;
        const size = p.endSize
          ? MathUtils.lerp(p.endSize, p.size, t)
          : p.size * t;
        if (size <= 0.15) continue;

        const alpha = Math.min(1, p.alpha * t);
        const alphaBucket = Math.max(1, Math.min(4, Math.ceil(alpha * 4)));
        const width = p.shape === 'ring'
          ? Math.max(1, Math.round(5 * t))
          : p.shape === 'spark'
            ? Math.max(1, Math.round(size * 0.6))
            : 0;
        const batch = this._getBatch(p.shape, p.color, alphaBucket, width);
        batch.indices.push(index);
        drawCount++;
      }

      if (drawCount === 0) {
        this.lastDrawCount = 0;
        this.lastBatchCount = 0;
        return;
      }

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';

      let batchCount = 0;
      for (let i = 0; i < this._batches.length; i++) {
        const batch = this._batches[i];
        if (batch.indices.length === 0) continue;
        batchCount++;
        ctx.globalAlpha = batch.alphaBucket * 0.25;
        ctx.fillStyle = batch.color;
        ctx.strokeStyle = batch.color;
        if (batch.width) ctx.lineWidth = batch.width;
        ctx.beginPath();

        for (let j = 0; j < batch.indices.length; j++) {
          const p = this.pool[batch.indices[j]];
          const t = p.life / p.maxLife;
          const size = p.endSize
            ? MathUtils.lerp(p.endSize, p.size, t)
            : p.size * t;

          if (batch.shape === 'ring') {
            ctx.moveTo(p.x + size, p.y);
            ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
          } else if (batch.shape === 'spark') {
            const length = size * p.stretch * 2.4;
            const speed = Math.hypot(p.vx, p.vy) || 1;
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x - (p.vx / speed) * length, p.y - (p.vy / speed) * length);
          } else {
            ctx.moveTo(p.x + size, p.y);
            ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
          }
        }

        if (batch.shape === 'circle') ctx.fill();
        else ctx.stroke();
      }

      ctx.restore();
      this.lastDrawCount = drawCount;
      this.lastBatchCount = batchCount;
    }

    _getBatch(shape, color, alphaBucket, width) {
      const key = `${shape}|${color}|${alphaBucket}|${width}`;
      let batch = this._batchMap.get(key);
      if (!batch) {
        batch = { shape, color, alphaBucket, width, indices: [] };
        this._batchMap.set(key, batch);
        this._batches.push(batch);
      }
      return batch;
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
