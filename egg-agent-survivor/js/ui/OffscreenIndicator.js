/**
 * OffscreenIndicator — 屏外目标的边缘指示器
 *
 * 幸存者类游戏的相机跟着玩家走，Boss、精英和补给经常在视野外，
 * 玩家只能靠猜。这里在屏幕边缘画箭头把它们「钉」回来：
 *
 *  1. 高价值目标（Boss / 精英 / 补给 / 处决窗口）逐个画箭头 + 距离，
 *     Boss 额外带一圈血量弧，不用切视角就知道它还剩多少。
 *  2. 杂兵不逐个画 —— 几十个箭头等于没有信息。改成把屏外杂兵按方位
 *     分箱统计，在对应边缘染一层「压力热区」，玩家一眼看出哪边要塌。
 *  3. 目标列表按低频（RESCAN_INTERVAL）重建，屏幕坐标每帧算。
 *     前者是 O(实体数) 的扫描，后者只有几十次三角函数。
 *
 * 作为系统挂在最后注册，drawScreen 因此盖在血条与波次条之上。
 */
(function (global) {
  'use strict';

  const MathUtils = global.MathUtils;
  const TAU = Math.PI * 2;

  const RESCAN_INTERVAL = 0.12;
  const PRESSURE_BINS = 16;

  /** 目标分类的外观与优先级（数字越小越先画、越不容易被裁掉） */
  const STYLES = {
    execute: { color: '#ffd45e', glow: '#fff3c4', size: 17, priority: 0, label: '处决' },
    boss:    { color: '#ff4d6d', glow: '#ffd0da', size: 15, priority: 1, label: 'BOSS' },
    elite:   { color: '#ffd45e', glow: '#fff3c4', size: 11, priority: 2, label: '精英' },
    pickup:  { color: '#6bffd0', glow: '#d6fff0', size: 9,  priority: 3, label: '' },
  };

  class OffscreenIndicator {
    /**
     * @param {object} [options]
     *   margin        箭头距屏幕边缘的内缩像素
     *   maxArrows     单帧最多画几个箭头
     *   showPickups   是否指示屏外补给
     *   showPressure  是否绘制杂兵压力热区
     *   pressureRange 统计杂兵的世界半径
     */
    constructor(options = {}) {
      this.margin = options.margin === undefined ? 42 : options.margin;
      this.maxArrows = options.maxArrows === undefined ? 8 : options.maxArrows;
      this.showPickups = options.showPickups !== false;
      this.showPressure = options.showPressure !== false;
      this.pressureRange = options.pressureRange || 1500;
      this.enabled = options.enabled !== false;

      this.engine = null;
      this.targets = [];
      this.pressure = new Float32Array(PRESSURE_BINS);
      this.offscreenEnemies = 0;

      this._rescanTimer = 0;
      this._screen = new global.Vector2(0, 0);
      this._time = 0;
    }

    onAdd(engine) {
      this.engine = engine;
      engine.indicators = this;
    }

    reset() {
      this.targets.length = 0;
      this.pressure.fill(0);
      this.offscreenEnemies = 0;
      this._rescanTimer = 0;
      this._time = 0;
    }

    /* ================= 扫描 ================= */

    update(dt, engine) {
      if (!this.enabled) return;
      this._time += dt;
      this._rescanTimer -= dt;
      if (this._rescanTimer > 0) return;
      this._rescanTimer = RESCAN_INTERVAL;
      this._rescan(engine);
    }

    /** 暂停 / 升级界面下引擎不跑 update，这里兜一次底，指示器不会僵在旧位置 */
    updateAlways(dt, engine) {
      if (!this.enabled) return;
      if (engine.state === global.GameState.PLAYING) return;
      if (this.targets.length === 0) return;
      this._time += dt;
    }

    _rescan(engine) {
      const targets = this.targets;
      targets.length = 0;
      this.pressure.fill(0);
      this.offscreenEnemies = 0;

      const player = engine.player;
      if (!player) return;

      const camera = engine.camera;
      const rangeSq = this.pressureRange * this.pressureRange;
      const entities = engine.entities;

      for (let i = 0; i < entities.length; i++) {
        const entity = entities[i];
        if (entity.dead || !entity.visible) continue;

        const isEnemy = entity.tag === 'enemy';
        const isPickup = this.showPickups && entity.tag === 'pickup';
        if (!isEnemy && !isPickup) continue;

        // 已经看得见的目标不需要指示
        if (camera.isVisible(entity.position, entity.radius)) continue;

        if (isPickup) {
          targets.push({ entity, kind: 'pickup' });
          continue;
        }

        if (entity.qte) {
          targets.push({ entity, kind: 'execute' });
          continue;
        }
        if (entity.isBoss) {
          targets.push({ entity, kind: 'boss' });
          continue;
        }
        if (entity.elite) {
          targets.push({ entity, kind: 'elite' });
          continue;
        }

        // 杂兵只进热区统计
        if (!this.showPressure) continue;
        const dx = entity.position.x - player.position.x;
        const dy = entity.position.y - player.position.y;
        const distSq = dx * dx + dy * dy;
        if (distSq > rangeSq) continue;

        this.offscreenEnemies++;
        const bin = binFor(Math.atan2(dy, dx));
        // 越近权重越高：贴脸的一圈比远处的一片更值得预警
        this.pressure[bin] += MathUtils.remap(Math.sqrt(distSq), this.pressureRange, 0, 0.35, 1);
      }

      targets.sort((a, b) => STYLES[a.kind].priority - STYLES[b.kind].priority);
      if (targets.length > this.maxArrows) targets.length = this.maxArrows;
    }

    /* ================= 绘制 ================= */

    drawScreen(ctx, engine) {
      if (!this.enabled) return;
      if (!engine.isState(global.GameState.PLAYING, global.GameState.LEVELUP,
        global.GameState.PAUSED)) return;
      if (!engine.player) return;

      if (this.showPressure && this.offscreenEnemies > 0) this._drawPressure(ctx, engine);
      if (this.targets.length > 0) this._drawArrows(ctx, engine);
    }

    /** 屏外杂兵密度：在对应方位的边缘糊一层渐隐的红雾 */
    _drawPressure(ctx, engine) {
      const w = engine.width;
      const h = engine.height;
      const cx = w / 2;
      const cy = h / 2;
      const reach = Math.max(w, h) * 0.42;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      for (let bin = 0; bin < PRESSURE_BINS; bin++) {
        const weight = this.pressure[bin];
        if (weight < 1.2) continue;

        const angle = (bin + 0.5) / PRESSURE_BINS * TAU - Math.PI;
        const edge = edgePoint(cx, cy, Math.cos(angle), Math.sin(angle), w / 2, h / 2);
        const alpha = Math.min(0.3, weight * 0.032);

        const gradient = ctx.createRadialGradient(edge.x, edge.y, 0, edge.x, edge.y, reach);
        gradient.addColorStop(0, `rgba(255,77,109,${alpha.toFixed(3)})`);
        gradient.addColorStop(0.45, `rgba(255,77,109,${(alpha * 0.32).toFixed(3)})`);
        gradient.addColorStop(1, 'rgba(255,77,109,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, w, h);
      }
      ctx.restore();
    }

    _drawArrows(ctx, engine) {
      const camera = engine.camera;
      const w = engine.width;
      const h = engine.height;
      const cx = w / 2;
      const cy = h / 2;
      const halfW = Math.max(20, w / 2 - this.margin);
      const halfH = Math.max(20, h / 2 - this.margin);
      const player = engine.player.position;

      ctx.save();
      ctx.font = '700 10px "Rajdhani", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      for (const target of this.targets) {
        const entity = target.entity;
        if (entity.dead) continue;

        camera.worldToScreen(entity.position, this._screen);
        const dx = this._screen.x - cx;
        const dy = this._screen.y - cy;
        if (Math.abs(dx) < 1e-3 && Math.abs(dy) < 1e-3) continue;

        const edge = edgePoint(cx, cy, dx, dy, halfW, halfH);
        const angle = Math.atan2(dy, dx);
        const style = STYLES[target.kind];
        const distance = Math.round(entity.position.distanceTo(player) / 10);

        this._drawArrow(ctx, edge.x, edge.y, angle, style, target.kind, entity, distance);
      }
      ctx.restore();
    }

    _drawArrow(ctx, x, y, angle, style, kind, entity, distance) {
      // 高优先目标呼吸得更快更亮，余光里也能注意到
      const urgent = kind === 'execute' || kind === 'boss';
      const pulse = urgent
        ? 0.72 + Math.sin(this._time * (kind === 'execute' ? 16 : 7)) * 0.28
        : 0.68;
      const size = style.size * (urgent ? 0.94 + pulse * 0.16 : 1);

      ctx.save();
      ctx.translate(x, y);

      // 底座光晕，保证箭头在任何背景上都读得出来
      ctx.globalAlpha = pulse * 0.55;
      ctx.fillStyle = 'rgba(6,10,20,0.82)';
      ctx.beginPath();
      ctx.arc(0, 0, size * 1.15, 0, TAU);
      ctx.fill();

      ctx.globalAlpha = pulse;
      ctx.shadowColor = style.glow;
      ctx.shadowBlur = urgent ? 18 : 10;
      ctx.fillStyle = style.color;

      ctx.save();
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.moveTo(size, 0);
      ctx.lineTo(-size * 0.62, size * 0.66);
      ctx.lineTo(-size * 0.3, 0);
      ctx.lineTo(-size * 0.62, -size * 0.66);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      ctx.shadowBlur = 0;

      if (entity.isBoss && entity.maxHealth > 0) {
        this._drawHealthArc(ctx, size * 1.42, entity.healthPercent, style.color);
      }

      // 文字沿指向反方向偏进屏幕内侧，不会被自己的箭头压住
      const inward = size * 2.1;
      const tx = -Math.cos(angle) * inward;
      const ty = -Math.sin(angle) * inward;

      if (style.label) {
        ctx.globalAlpha = Math.min(1, pulse + 0.2);
        ctx.fillStyle = style.color;
        ctx.fillText(style.label, tx, ty - 6);
      }
      ctx.globalAlpha = 0.72;
      ctx.fillStyle = '#dceaf7';
      ctx.fillText(`${distance}m`, tx, ty + (style.label ? 6 : 0));

      ctx.restore();
    }

    _drawHealthArc(ctx, radius, ratio, color) {
      ctx.save();
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.28;
      ctx.strokeStyle = '#0b1222';
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, TAU);
      ctx.stroke();

      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(0, 0, radius, -Math.PI / 2, -Math.PI / 2 + TAU * MathUtils.clamp(ratio, 0, 1));
      ctx.stroke();
      ctx.restore();
    }

    /** 调试 / 测试用快照 */
    snapshot() {
      return {
        arrows: this.targets.map((t) => ({ kind: t.kind, id: t.entity.id })),
        offscreenEnemies: this.offscreenEnemies,
        pressure: Array.from(this.pressure),
      };
    }
  }

  /** 把方向角落进 [0, PRESSURE_BINS) 的箱号 */
  function binFor(angle) {
    const normalized = (angle + Math.PI) / TAU;
    const bin = Math.floor(normalized * PRESSURE_BINS);
    return bin < 0 ? 0 : bin >= PRESSURE_BINS ? PRESSURE_BINS - 1 : bin;
  }

  /** 从中心沿 (dx,dy) 打到 halfW×halfH 矩形边框上的交点 */
  function edgePoint(cx, cy, dx, dy, halfW, halfH) {
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    const sx = ax > 1e-6 ? halfW / ax : Infinity;
    const sy = ay > 1e-6 ? halfH / ay : Infinity;
    const scale = Math.min(sx, sy);
    if (!Number.isFinite(scale)) return { x: cx, y: cy };
    return { x: cx + dx * scale, y: cy + dy * scale };
  }

  OffscreenIndicator.STYLES = STYLES;
  OffscreenIndicator.PRESSURE_BINS = PRESSURE_BINS;
  OffscreenIndicator.edgePoint = edgePoint;
  OffscreenIndicator.binFor = binFor;

  global.OffscreenIndicator = OffscreenIndicator;
})(window);
