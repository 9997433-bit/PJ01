/**
 * Background — 动态深空：星云 / 三层视差星野 / 能量网格 / 流星
 *
 * 全部按相机可见范围绘制，因此地图可以无限大而开销恒定。四层从远到近：
 *
 *   1. 星云   —— 世界坐标上的大团柔光，视差最慢（depth 0.12），
 *                颜色随战况在冷蓝 / 危险红 / Fever 暖金之间平滑过渡；
 *   2. 星野   —— 三层不同景深的星点，越近越大越亮、视差越明显。
 *                同色同亮度的星批成一条路径，190 颗星只有十几次状态切换；
 *   3. 网格   —— 无限滚动的霓虹地格，带一道周期扫过的能量脉冲；
 *   4. 流星   —— 偶发的拖尾划过，给静态星空一点生命感。
 *
 * 三条性能纪律，保证移动端也稳：
 *  - 运行期零分配：星、流星、批次数组全部预分配，只在构造期建一次；
 *  - 渐变按「颜色 + 半径档」缓存，星云每帧只是几次 fillRect；
 *  - 跟随引擎画质档降级（lodBias）：先砍星云与流星，再砍星野密度。
 */
(function (global) {
  'use strict';

  const MathUtils = global.MathUtils;
  const TAU = Math.PI * 2;

  const GRID_SIZE = 128;
  /** 星野在这个尺寸内平铺循环 */
  const STAR_FIELD = 2600;
  /** 星云团在这个尺寸内平铺循环，比星野稀疏得多 */
  const NEBULA_FIELD = 2100;

  const STAR_COLORS = ['#ffffff', '#7cf9ff', '#b78bff', '#6bffd0', '#ffd45e'];

  /** 三层景深：depth 越大离镜头越近，视差与亮度都更强 */
  const STAR_LAYERS = [
    { count: 84, depth: 0.15, sizeMin: 0.45, sizeMax: 1.15, alpha: 0.42, twinkle: 1.1 },
    { count: 78, depth: 0.40, sizeMin: 0.70, sizeMax: 1.90, alpha: 0.68, twinkle: 1.6 },
    { count: 46, depth: 0.72, sizeMin: 1.10, sizeMax: 2.70, alpha: 0.95, twinkle: 2.2 },
  ];

  const NEBULA_COUNT = 9;
  const METEOR_POOL = 3;

  /**
   * 情绪主题。战况决定气氛：平时是冷蓝深空，Boss 压场时转血色，
   * Fever 整片烧成暖金。颜色按 RGB 插值，切换是渐变而不是跳变。
   */
  const MOODS = Object.freeze({
    menu:  { a: [72, 158, 255], b: [168, 108, 255], grid: [84, 196, 255], major: [124, 249, 255], gain: 1.25 },
    calm:  { a: [64, 148, 255], b: [150, 96, 255],  grid: [84, 196, 255], major: [124, 249, 255], gain: 1 },
    tense: { a: [110, 120, 255], b: [200, 92, 220], grid: [110, 170, 255], major: [150, 220, 255], gain: 1.1 },
    boss:  { a: [255, 74, 108], b: [180, 70, 220],  grid: [190, 120, 190], major: [255, 150, 180], gain: 1.35 },
    fever: { a: [255, 92, 118], b: [255, 198, 82],  grid: [255, 170, 120], major: [255, 212, 94], gain: 1.6 },
  });

  function lerpChannel(from, to, t) {
    return from + (to - from) * t;
  }

  class Background {
    constructor(options = {}) {
      this.time = 0;
      this.intro = 0;
      this.introDuration = 1.5;

      this.stars = [];
      for (let layerIndex = 0; layerIndex < STAR_LAYERS.length; layerIndex++) {
        const layer = STAR_LAYERS[layerIndex];
        for (let i = 0; i < layer.count; i++) {
          this.stars.push({
            x: Math.random() * STAR_FIELD,
            y: Math.random() * STAR_FIELD,
            size: MathUtils.randRange(layer.sizeMin, layer.sizeMax),
            depth: layer.depth * MathUtils.randRange(0.86, 1.14),
            baseAlpha: layer.alpha,
            twinkleRate: layer.twinkle,
            phase: Math.random() * TAU,
            colorIndex: MathUtils.randInt(0, STAR_COLORS.length - 1),
            // 最亮的那一小撮带十字星芒，星空才有层次
            flare: layerIndex === 2 && Math.random() < 0.22,
            layer: layerIndex,
          });
        }
      }

      this.nebulae = [];
      for (let i = 0; i < NEBULA_COUNT; i++) {
        this.nebulae.push({
          x: Math.random() * NEBULA_FIELD,
          y: Math.random() * NEBULA_FIELD,
          radius: MathUtils.randRange(320, 640),
          phase: Math.random() * TAU,
          rate: MathUtils.randRange(0.06, 0.15),
          tone: Math.random(),         // 0 → 主色，1 → 辅色
          strength: MathUtils.randRange(0.5, 1),
        });
      }

      this.meteors = [];
      for (let i = 0; i < METEOR_POOL; i++) {
        this.meteors.push({ active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, length: 200, color: '#ffffff' });
      }
      this._meteorTimer = MathUtils.randRange(1.5, 4);

      // 星点批次：同色同亮度档合成一条路径，避免上百次 fill()
      this._starBatches = [];
      for (let c = 0; c < STAR_COLORS.length; c++) {
        this._starBatches.push([[], [], [], []]);
      }
      this._flares = [];
      this._gradients = new Map();

      this.mood = 'calm';
      this._moodName = null;
      // 当前显示中的主题（向目标主题平滑逼近）
      this.theme = {
        a: MOODS.calm.a.slice(),
        b: MOODS.calm.b.slice(),
        grid: MOODS.calm.grid.slice(),
        major: MOODS.calm.major.slice(),
        gain: MOODS.calm.gain,
      };

      this.quality = options.quality !== undefined ? options.quality : 1;
      this.lodBias = 0;
      this.enabled = options.enabled !== false;
    }

    /** 开场：网格与星云从中心向外亮起，配合主菜单的入场动画 */
    playIntro(duration = 1.5) {
      this.introDuration = Math.max(0.2, duration);
      this.intro = this.introDuration;
    }

    reset() {
      for (const meteor of this.meteors) meteor.active = false;
      this._meteorTimer = MathUtils.randRange(1.5, 4);
    }

    /* ================= 每帧 ================= */

    update(dt, engine) {
      this.time += dt;
      if (this.intro > 0) this.intro = Math.max(0, this.intro - dt);

      this._syncMood(engine, dt);
      this._updateMeteors(dt, engine);
    }

    /** 战况 → 目标主题，再按帧率无关的插值逼近，气氛切换是渐变 */
    _syncMood(engine, dt) {
      let name = 'calm';
      if (engine) {
        this.lodBias = engine.quality ? engine.quality.lodBias : 0;
        if (engine.state === 'menu') name = 'menu';
        else if (engine.combo && engine.combo.fever) name = 'fever';
        else if (engine.spawner && engine.spawner.bossAlive) name = 'boss';
        else if (engine.spawner && engine.spawner.wave >= 6) name = 'tense';
      }
      this.mood = name;

      const target = MOODS[name] || MOODS.calm;
      const t = 1 - Math.pow(0.06, Math.min(dt, 0.25));
      const theme = this.theme;
      for (let i = 0; i < 3; i++) {
        theme.a[i] = lerpChannel(theme.a[i], target.a[i], t);
        theme.b[i] = lerpChannel(theme.b[i], target.b[i], t);
        theme.grid[i] = lerpChannel(theme.grid[i], target.grid[i], t);
        theme.major[i] = lerpChannel(theme.major[i], target.major[i], t);
      }
      theme.gain = lerpChannel(theme.gain, target.gain, t);
    }

    _updateMeteors(dt, engine) {
      for (const meteor of this.meteors) {
        if (!meteor.active) continue;
        meteor.life -= dt;
        if (meteor.life <= 0) { meteor.active = false; continue; }
        meteor.x += meteor.vx * dt;
        meteor.y += meteor.vy * dt;
      }

      if (this.lodBias >= 2) return;
      this._meteorTimer -= dt;
      if (this._meteorTimer > 0) return;
      // 菜单里划得勤一些，待机画面才不冷清
      this._meteorTimer = this.mood === 'menu'
        ? MathUtils.randRange(1.6, 3.6)
        : MathUtils.randRange(4, 11);
      this._spawnMeteor(engine);
    }

    _spawnMeteor(engine) {
      const meteor = this.meteors.find((m) => !m.active);
      if (!meteor) return;

      const camera = engine && engine.camera;
      const cx = camera ? camera.position.x : 0;
      const cy = camera ? camera.position.y : 0;
      const angle = MathUtils.randRange(Math.PI * 0.12, Math.PI * 0.38);
      const speed = MathUtils.randRange(760, 1500);

      meteor.active = true;
      meteor.x = cx + MathUtils.randRange(-900, 300);
      meteor.y = cy + MathUtils.randRange(-800, -220);
      meteor.vx = Math.cos(angle) * speed;
      meteor.vy = Math.sin(angle) * speed;
      meteor.maxLife = MathUtils.randRange(0.8, 1.5);
      meteor.life = meteor.maxLife;
      meteor.length = MathUtils.randRange(150, 320);
      meteor.color = MathUtils.pick(['#ffffff', '#7cf9ff', '#b78bff']);
    }

    /* ================= 绘制 ================= */

    draw(ctx, camera, engine) {
      if (!this.enabled) return;
      if (engine && engine.quality) this.lodBias = engine.quality.lodBias;

      const bounds = camera.getVisibleBounds(GRID_SIZE);
      // 开场时整片深空从中心亮起
      const reveal = this.intro > 0
        ? MathUtils.easeOutCubic(1 - this.intro / this.introDuration)
        : 1;

      if (this.lodBias < 2) this._drawNebula(ctx, camera, reveal);
      this._drawStars(ctx, camera, reveal);
      this._drawGrid(ctx, bounds, camera, reveal);
      if (this.lodBias < 2) this._drawMeteors(ctx, camera, reveal);
    }

    /** 星云：世界格点上的柔光团，视差最慢，负责整屏的底色氛围 */
    _drawNebula(ctx, camera, reveal) {
      const theme = this.theme;
      const depth = 0.12;
      const view = camera.getVisibleBounds(700);
      const count = this.lodBias >= 1 ? 5 : NEBULA_COUNT;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      for (let i = 0; i < count; i++) {
        const blob = this.nebulae[i];
        const px = blob.x - camera.position.x * depth;
        const py = blob.y - camera.position.y * depth;
        const x = view.minX + (((px - view.minX) % NEBULA_FIELD) + NEBULA_FIELD) % NEBULA_FIELD;
        const y = view.minY + (((py - view.minY) % NEBULA_FIELD) + NEBULA_FIELD) % NEBULA_FIELD;
        if (x > view.maxX || y > view.maxY) continue;

        const breathe = 0.78 + Math.sin(this.time * blob.rate + blob.phase) * 0.22;
        const radius = blob.radius * breathe;
        const alpha = 0.1 * blob.strength * theme.gain * reveal;
        if (alpha < 0.004) continue;

        const r = Math.round(lerpChannel(theme.a[0], theme.b[0], blob.tone));
        const g = Math.round(lerpChannel(theme.a[1], theme.b[1], blob.tone));
        const b = Math.round(lerpChannel(theme.a[2], theme.b[2], blob.tone));

        ctx.globalAlpha = alpha;
        ctx.save();
        ctx.translate(x, y);
        ctx.fillStyle = this._blobGradient(ctx, r, g, b, radius);
        ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
        ctx.restore();
      }

      ctx.restore();
    }

    /**
     * 柔光渐变按「量化后的颜色 + 半径档」缓存。绘制前已 translate 到团心，
     * 渐变本身是局部坐标，因此可以跨帧复用而不是每团每帧重建。
     */
    _blobGradient(ctx, r, g, b, radius) {
      const key = `${r >> 3}|${g >> 3}|${b >> 3}|${Math.round(radius / 48)}`;
      let gradient = this._gradients.get(key);
      if (!gradient) {
        const bucket = Math.max(48, Math.round(radius / 48) * 48);
        gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, bucket);
        gradient.addColorStop(0, `rgba(${r},${g},${b},0.85)`);
        gradient.addColorStop(0.45, `rgba(${r},${g},${b},0.28)`);
        gradient.addColorStop(1, `rgba(${r},${g},${b},0)`);
        this._gradients.set(key, gradient);
        // 主题在渐变时会不断量化出新键，超出上限就整体丢弃重建
        if (this._gradients.size > 96) this._gradients.clear();
      }
      return gradient;
    }

    /** 三层视差星野。按「颜色 × 亮度档」批处理，几百颗星也只有十几次状态切换 */
    _drawStars(ctx, camera, reveal) {
      const batches = this._starBatches;
      for (let c = 0; c < batches.length; c++) {
        for (let a = 0; a < 4; a++) batches[c][a].length = 0;
      }
      const flares = this._flares;
      flares.length = 0;

      const view = camera.getVisibleBounds(60);
      const stride = this.lodBias >= 2 ? 2 : 1;
      const gain = this.theme.gain;

      for (let i = 0; i < this.stars.length; i += stride) {
        const star = this.stars[i];
        // 按深度做视差后再对星域取模，实现无缝循环
        const px = star.x - camera.position.x * star.depth;
        const py = star.y - camera.position.y * star.depth;
        const x = view.minX + (((px - view.minX) % STAR_FIELD) + STAR_FIELD) % STAR_FIELD;
        const y = view.minY + (((py - view.minY) % STAR_FIELD) + STAR_FIELD) % STAR_FIELD;
        if (x > view.maxX || y > view.maxY) continue;

        const twinkle = 0.72 + Math.sin(this.time * star.twinkleRate + star.phase) * 0.28;
        const alpha = MathUtils.clamp(star.baseAlpha * twinkle * gain * reveal, 0, 1);
        if (alpha < 0.05) continue;

        const bucket = Math.min(3, Math.floor(alpha * 4));
        batches[star.colorIndex][bucket].push(x, y, star.size);

        if (star.flare && alpha > 0.55 && this.lodBias === 0) {
          flares.push(x, y, star.size * (2.6 + twinkle), star.colorIndex, alpha);
        }
      }

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      for (let c = 0; c < batches.length; c++) {
        const color = STAR_COLORS[c];
        for (let a = 0; a < 4; a++) {
          const points = batches[c][a];
          if (!points.length) continue;
          ctx.globalAlpha = (a + 1) * 0.25;
          ctx.fillStyle = color;
          ctx.beginPath();
          for (let p = 0; p < points.length; p += 3) {
            const size = points[p + 2];
            ctx.moveTo(points[p] + size, points[p + 1]);
            ctx.arc(points[p], points[p + 1], size, 0, TAU);
          }
          ctx.fill();
        }
      }

      // 亮星的十字光芒：数量很少，值得单独描一遍
      if (flares.length) {
        ctx.lineWidth = 1;
        for (let f = 0; f < flares.length; f += 5) {
          const x = flares[f];
          const y = flares[f + 1];
          const len = flares[f + 2];
          ctx.globalAlpha = flares[f + 4] * 0.5;
          ctx.strokeStyle = STAR_COLORS[flares[f + 3]];
          ctx.beginPath();
          ctx.moveTo(x - len, y);
          ctx.lineTo(x + len, y);
          ctx.moveTo(x, y - len);
          ctx.lineTo(x, y + len);
          ctx.stroke();
        }
      }

      ctx.restore();
    }

    /**
     * 能量网格。细线一条路径批完；主线单独一层更亮；
     * 另有一道横向脉冲周期性扫过，让静态地格看起来在通电。
     */
    _drawGrid(ctx, bounds, camera, reveal) {
      const theme = this.theme;
      const grid = theme.grid;
      const major = theme.major;
      const pulse = 0.5 + Math.sin(this.time * 0.8) * 0.5;
      const startX = Math.floor(bounds.minX / GRID_SIZE) * GRID_SIZE;
      const startY = Math.floor(bounds.minY / GRID_SIZE) * GRID_SIZE;

      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = `rgba(${grid[0] | 0},${grid[1] | 0},${grid[2] | 0},${((0.07 + pulse * 0.028) * reveal).toFixed(3)})`;
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
      const majorStep = GRID_SIZE * 4;
      ctx.strokeStyle = `rgba(${major[0] | 0},${major[1] | 0},${major[2] | 0},${((0.12 + pulse * 0.05) * reveal).toFixed(3)})`;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let x = Math.floor(bounds.minX / majorStep) * majorStep; x <= bounds.maxX; x += majorStep) {
        ctx.moveTo(x, bounds.minY);
        ctx.lineTo(x, bounds.maxY);
      }
      for (let y = Math.floor(bounds.minY / majorStep) * majorStep; y <= bounds.maxY; y += majorStep) {
        ctx.moveTo(bounds.minX, y);
        ctx.lineTo(bounds.maxX, y);
      }
      ctx.stroke();

      if (this.lodBias === 0) this._drawGridPulse(ctx, bounds, majorStep, reveal);
      ctx.restore();
    }

    /**
     * 扫描光带：一条竖直的柔光每隔几秒从左扫到右，中途留白。
     * 用局部坐标的线性渐变填充，渐变可缓存，整段只有一次 fillRect。
     */
    _drawGridPulse(ctx, bounds, majorStep, reveal) {
      const period = 9;
      const phase = (this.time % period) / period;
      if (phase > 0.55) return;

      const travel = phase / 0.55;
      const halfWidth = majorStep * 0.75;
      const width = bounds.maxX - bounds.minX;
      const x = bounds.minX - halfWidth + (width + halfWidth * 2) * travel;
      // 两端淡入淡出，光带不会在视野边缘凭空出现
      const edge = Math.sin(travel * Math.PI);
      const alpha = 0.16 * edge * reveal * this.theme.gain;
      if (alpha < 0.006) return;

      const major = this.theme.major;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = alpha;
      ctx.translate(x, 0);
      ctx.fillStyle = this._sweepGradient(ctx, major, halfWidth);
      ctx.fillRect(-halfWidth, bounds.minY, halfWidth * 2, bounds.maxY - bounds.minY);
      ctx.restore();
    }

    _sweepGradient(ctx, color, halfWidth) {
      const r = color[0] | 0;
      const g = color[1] | 0;
      const b = color[2] | 0;
      const bucket = Math.round(halfWidth / 32) * 32 || 32;
      const key = `sweep|${r >> 3}|${g >> 3}|${b >> 3}|${bucket}`;
      let gradient = this._gradients.get(key);
      if (!gradient) {
        gradient = ctx.createLinearGradient(-bucket, 0, bucket, 0);
        gradient.addColorStop(0, `rgba(${r},${g},${b},0)`);
        gradient.addColorStop(0.5, `rgba(${r},${g},${b},1)`);
        gradient.addColorStop(1, `rgba(${r},${g},${b},0)`);
        this._gradients.set(key, gradient);
        if (this._gradients.size > 96) this._gradients.clear();
      }
      return gradient;
    }

    /** 流星：一条带渐隐拖尾的斜线，尾部分三段递减，比单色直线有厚度 */
    _drawMeteors(ctx, camera, reveal) {
      let any = false;
      for (const meteor of this.meteors) {
        if (meteor.active) { any = true; break; }
      }
      if (!any) return;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';

      for (const meteor of this.meteors) {
        if (!meteor.active) continue;
        if (!camera.isVisible(meteor, meteor.length + 200)) continue;

        const t = meteor.life / meteor.maxLife;
        // 进场淡入、离场淡出，避免凭空出现
        const fade = Math.min(1, t * 3, (1 - t) * 6 + 0.15) * reveal;
        if (fade <= 0.02) continue;

        const speed = Math.hypot(meteor.vx, meteor.vy) || 1;
        const ux = meteor.vx / speed;
        const uy = meteor.vy / speed;
        ctx.strokeStyle = meteor.color;

        for (let seg = 0; seg < 3; seg++) {
          const from = (seg / 3) * meteor.length;
          const to = ((seg + 1) / 3) * meteor.length;
          ctx.globalAlpha = fade * (0.55 - seg * 0.16);
          ctx.lineWidth = 2.6 - seg * 0.7;
          ctx.beginPath();
          ctx.moveTo(meteor.x - ux * from, meteor.y - uy * from);
          ctx.lineTo(meteor.x - ux * to, meteor.y - uy * to);
          ctx.stroke();
        }

        // 头部亮核
        ctx.globalAlpha = fade;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(meteor.x, meteor.y, 1.9, 0, TAU);
        ctx.fill();
      }

      ctx.restore();
    }
  }

  Background.MOODS = MOODS;
  Background.STAR_LAYERS = STAR_LAYERS;

  global.Background = Background;
})(window);
