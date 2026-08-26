/**
 * MenuStage — 主菜单的角色预览台与开场动画
 *
 * 用一块独立的小画布渲染「真正的」Player 实体（同一套蛋壳、面罩、光晕），
 * 预览里看到的就是待会儿操控的那只蛋，而不是另画一张贴图。
 *
 * 开场序列（约 1.7 秒，进菜单时重放一次）：
 *   0.00s  三道收缩光环 + 从四周飞向中心的碎片
 *   0.45s  碎片汇聚成型，蛋壳带过冲曲线弹出
 *   0.55s  一次白闪与冲击环，同时护航无人机入轨
 *   之后   浮尘、环轨与无人机进入常驻待机
 *
 * 不自己起 rAF：由 main.js 在菜单状态下按帧喂 update()，
 * 离开菜单就彻底停摆，不跟战斗抢时间片。
 */
(function (global) {
  'use strict';

  const MathUtils = global.MathUtils;
  const TAU = Math.PI * 2;

  const INTRO_DURATION = 1.7;
  /** 蛋壳成型的时刻（秒），碎片在此之前汇聚完毕 */
  const FORM_AT = 0.5;

  const DRONES = [
    { glyph: '✦', color: '#7cf9ff', radius: 1.00, tiltY: 0.34, speed: 0.55, phase: 0, size: 13 },
    { glyph: '◆', color: '#b78bff', radius: 1.24, tiltY: 0.26, speed: -0.38, phase: 2.2, size: 11 },
    { glyph: '✹', color: '#ffd45e', radius: 0.78, tiltY: 0.44, speed: 0.78, phase: 4.1, size: 10 },
  ];

  const SHARD_COUNT = 26;
  const MOTE_COUNT = 22;

  function easeOutBack(t) {
    const c = 2.4;
    const u = t - 1;
    return 1 + (c + 1) * u * u * u + c * u * u;
  }

  class MenuStage {
    constructor(canvas, options = {}) {
      this.canvas = canvas || null;
      this.ctx = null;
      if (this.canvas && typeof this.canvas.getContext === 'function') {
        this.ctx = this.canvas.getContext('2d');
      }

      this.actor = options.actor || (global.Player ? new global.Player(0, 0) : null);
      if (this.actor) {
        this.actor.stats.regen = 0;
        this.actor.velocity.set(0, 0);
      }

      this.time = 0;
      this.intro = 0;
      this.width = 0;
      this.height = 0;
      this.dpr = 1;
      this.enabled = true;

      this.shards = [];
      for (let i = 0; i < SHARD_COUNT; i++) {
        const angle = (i / SHARD_COUNT) * TAU + MathUtils.randRange(-0.14, 0.14);
        this.shards.push({
          angle,
          distance: MathUtils.randRange(1.1, 2.4),   // 相对半径，成型时收敛到 0
          spin: MathUtils.randRange(-6, 6),
          size: MathUtils.randRange(2, 5.4),
          delay: MathUtils.randRange(0, 0.18),
          color: MathUtils.pick(['#7cf9ff', '#b78bff', '#ffffff', '#6bffd0']),
        });
      }

      this.motes = [];
      for (let i = 0; i < MOTE_COUNT; i++) {
        this.motes.push({
          x: Math.random(),
          y: Math.random(),
          size: MathUtils.randRange(0.8, 2.2),
          speed: MathUtils.randRange(0.012, 0.045),
          drift: MathUtils.randRange(-0.02, 0.02),
          phase: Math.random() * TAU,
          color: MathUtils.pick(['#7cf9ff', '#b78bff', '#ffffff']),
        });
      }

      this.playIntro();
    }

    /** 用户要求减少动效时直接跳到待机态，不播成型序列 */
    static prefersReducedMotion() {
      return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    playIntro() {
      this.intro = MenuStage.prefersReducedMotion() ? 0 : INTRO_DURATION;
      this.time = 0;
      if (this.actor) {
        this.actor._bobPhase = 0;
        this.actor._squash = 1;
        this.actor.faceSign = 1;
      }
    }

    /** 画布跟着 CSS 尺寸走，高分屏按 DPR 放大后端缓冲（封顶 2） */
    resize() {
      const canvas = this.canvas;
      if (!canvas) return false;

      let width = 0;
      let height = 0;
      if (typeof canvas.getBoundingClientRect === 'function') {
        const rect = canvas.getBoundingClientRect();
        width = rect.width;
        height = rect.height;
      }
      if (!(width > 0) || !(height > 0)) {
        width = canvas.clientWidth || 260;
        height = canvas.clientHeight || 260;
      }

      const dpr = Math.min(global.devicePixelRatio || 1, 2);
      const w = Math.max(80, Math.round(width));
      const h = Math.max(80, Math.round(height));
      if (w === this.width && h === this.height && dpr === this.dpr) return false;

      this.width = w;
      this.height = h;
      this.dpr = dpr;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      return true;
    }

    update(dt) {
      if (!this.enabled) return;
      this.time += dt;
      if (this.intro > 0) this.intro = Math.max(0, this.intro - dt);

      // 量尺寸要读布局，每帧都读会造成强制回流；菜单里三分之一秒一次足够
      this._measure = (this._measure || 0) + dt;
      if (this._measure > 0.3) {
        this._measure = 0;
        this.resize();
      }

      const actor = this.actor;
      if (!actor) return;
      // 待机演出：呼吸式挤压 + 轻微左右张望，倾斜靠 draw 读 velocity.x 得到
      actor.age += dt;
      actor._bobPhase += dt * 2.7;
      actor._squash = 1 + Math.sin(this.time * 1.7) * 0.05;
      actor.velocity.set(Math.sin(this.time * 0.7) * 52, 0);
      actor.faceSign = Math.sin(this.time * 0.7) >= 0 ? 1 : -1;
      actor.position.set(0, 0);
      actor.invulnerable = 0;
      actor.hitFlash = 0;
    }

    draw() {
      const ctx = this.ctx;
      if (!ctx || !this.enabled) return;
      if (!this.width) this.resize();
      const w = this.width;
      const h = this.height;
      if (!(w > 0) || !(h > 0)) return;

      const progress = 1 - this.intro / INTRO_DURATION;
      // 尺度基准：预览框再小也保持同一套比例
      const scale = Math.min(w, h) / 260;
      const cx = w / 2;
      const cy = h * 0.52;

      ctx.save();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      ctx.translate(cx, cy);
      ctx.scale(scale, scale);

      this._drawBackdrop(ctx, progress);
      this._drawMotes(ctx, w / scale, h / scale);
      this._drawOrbit(ctx, progress, false);
      this._drawDrones(ctx, progress, false);

      this._drawActor(ctx, progress);

      this._drawOrbit(ctx, progress, true);
      this._drawDrones(ctx, progress, true);
      this._drawShards(ctx, progress);
      this._drawFlash(ctx, progress);

      ctx.restore();
    }

    /* ================= 分层 ================= */

    _drawBackdrop(ctx, progress) {
      const reveal = MathUtils.clamp(progress * 2.2, 0, 1);
      const pulse = 0.86 + Math.sin(this.time * 1.1) * 0.14;
      const radius = 132 * pulse;

      if (!this._backdrop) {
        const gradient = ctx.createRadialGradient(0, 0, 6, 0, 0, 132);
        gradient.addColorStop(0, 'rgba(124,249,255,0.24)');
        gradient.addColorStop(0.45, 'rgba(96,150,255,0.11)');
        gradient.addColorStop(1, 'rgba(10,16,32,0)');
        this._backdrop = gradient;
      }

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = reveal;
      ctx.scale(pulse, pulse);
      ctx.fillStyle = this._backdrop;
      ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
      ctx.restore();
    }

    /** 环境浮尘：整块画布内缓慢上浮，给静止的预览一点空气感 */
    _drawMotes(ctx, w, h) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const mote of this.motes) {
        const y = ((mote.y - this.time * mote.speed) % 1 + 1) % 1;
        const x = ((mote.x + Math.sin(this.time * 0.4 + mote.phase) * 0.04 + mote.drift) % 1 + 1) % 1;
        ctx.globalAlpha = 0.16 + Math.sin(this.time * 2 + mote.phase) * 0.12;
        ctx.fillStyle = mote.color;
        ctx.beginPath();
        ctx.arc((x - 0.5) * w, (y - 0.5) * h, mote.size, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    /** 两道倾斜的环轨，前后半环分开画，无人机才能真的绕到蛋后面 */
    _drawOrbit(ctx, progress, front) {
      const reveal = MathUtils.clamp((progress - 0.28) * 2.6, 0, 1);
      if (reveal <= 0.01) return;

      const rings = [
        { rx: 104, ry: 34, tilt: -0.22, speed: 0.5, color: 'rgba(124,249,255,', width: 1.4 },
        { rx: 128, ry: 24, tilt: 0.3, speed: -0.34, color: 'rgba(183,139,255,', width: 1 },
      ];

      ctx.save();
      for (const ring of rings) {
        ctx.save();
        ctx.rotate(ring.tilt);
        ctx.strokeStyle = `${ring.color}${(0.3 * reveal).toFixed(3)})`;
        ctx.lineWidth = ring.width;
        ctx.setLineDash([14, 10]);
        ctx.lineDashOffset = -this.time * ring.speed * 60;
        ctx.beginPath();
        // 上半环画在角色后面，下半环画在前面
        if (front) ctx.ellipse(0, 0, ring.rx, ring.ry, 0, 0, Math.PI);
        else ctx.ellipse(0, 0, ring.rx, ring.ry, 0, Math.PI, TAU);
        ctx.stroke();
        ctx.restore();
      }
      ctx.restore();
    }

    /** 三架护航无人机沿椭圆轨道巡航，绕到后面时变小变暗 */
    _drawDrones(ctx, progress, front) {
      const reveal = MathUtils.clamp((progress - 0.42) * 2.4, 0, 1);
      if (reveal <= 0.01) return;

      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const drone of DRONES) {
        const angle = this.time * drone.speed + drone.phase;
        const depth = Math.sin(angle);
        if ((depth > 0) !== front) continue;

        const x = Math.cos(angle) * 118 * drone.radius;
        const y = depth * 118 * drone.radius * drone.tiltY - 6;
        const near = 0.72 + (depth + 1) * 0.2;

        ctx.globalAlpha = reveal * (0.45 + near * 0.5);
        ctx.fillStyle = drone.color;
        ctx.shadowColor = drone.color;
        ctx.shadowBlur = 12 * near;
        ctx.font = `700 ${(drone.size * near).toFixed(1)}px "Rajdhani", system-ui, sans-serif`;
        ctx.fillText(drone.glyph, x, y + Math.sin(this.time * 2.4 + drone.phase) * 3);
      }
      ctx.restore();
    }

    _drawActor(ctx, progress) {
      const actor = this.actor;
      if (!actor) return;

      const elapsed = progress * INTRO_DURATION;
      if (elapsed < FORM_AT) return;

      const t = MathUtils.clamp((elapsed - FORM_AT) / 0.42, 0, 1);
      const pop = t < 1 ? easeOutBack(t) : 1;

      ctx.save();
      ctx.globalAlpha = MathUtils.clamp(t * 2.4, 0, 1);
      ctx.scale(pop, pop);
      // 预览里的蛋放大到 2.1 倍，细节（面罩扫描、高光）才看得清
      ctx.scale(2.1, 2.1);
      ctx.translate(0, Math.sin(this.time * 1.3) * 1.6);
      actor.draw(ctx);
      ctx.restore();
    }

    /** 开场碎片：从四周旋转着收拢，成型瞬间归零 */
    _drawShards(ctx, progress) {
      const elapsed = progress * INTRO_DURATION;
      if (elapsed > FORM_AT + 0.3) return;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const shard of this.shards) {
        const local = MathUtils.clamp((elapsed - shard.delay) / (FORM_AT - shard.delay || 0.1), 0, 1);
        const ease = 1 - Math.pow(1 - local, 2.6);
        const distance = 132 * shard.distance * (1 - ease);
        const fade = local < 1
          ? MathUtils.clamp(local * 3, 0, 1)
          : MathUtils.clamp(1 - (elapsed - FORM_AT) / 0.3, 0, 1);
        if (fade <= 0.02) continue;

        const angle = shard.angle + shard.spin * ease * 0.1;
        const x = Math.cos(angle) * distance;
        const y = Math.sin(angle) * distance * 0.7;

        ctx.globalAlpha = fade * 0.9;
        ctx.strokeStyle = shard.color;
        ctx.lineWidth = shard.size * 0.5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        // 拖尾指向圆心，看起来是被吸进去的
        ctx.moveTo(x, y);
        ctx.lineTo(x * 0.86, y * 0.86);
        ctx.stroke();
      }
      ctx.restore();
    }

    /** 成型瞬间的白闪与冲击环 */
    _drawFlash(ctx, progress) {
      const elapsed = progress * INTRO_DURATION;
      const since = elapsed - FORM_AT;
      if (since < 0 || since > 0.75) return;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      const flash = MathUtils.clamp(1 - since / 0.26, 0, 1);
      if (flash > 0.01) {
        ctx.globalAlpha = flash * 0.5;
        ctx.fillStyle = '#dff7ff';
        ctx.beginPath();
        ctx.arc(0, 0, 70 + (1 - flash) * 60, 0, TAU);
        ctx.fill();
      }

      const ringT = MathUtils.clamp(since / 0.65, 0, 1);
      if (ringT < 1) {
        ctx.globalAlpha = (1 - ringT) * 0.7;
        ctx.strokeStyle = '#7cf9ff';
        ctx.lineWidth = 3 * (1 - ringT) + 0.6;
        ctx.beginPath();
        ctx.arc(0, 0, 24 + ringT * 130, 0, TAU);
        ctx.stroke();
      }

      ctx.restore();
    }
  }

  MenuStage.INTRO_DURATION = INTRO_DURATION;
  global.MenuStage = MenuStage;
})(window);
