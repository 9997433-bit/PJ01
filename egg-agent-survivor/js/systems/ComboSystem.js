/**
 * ComboSystem — 连击、倍率与 Fever 模式
 *
 * 规则：
 *  - 每次击杀 +1 连击，并把倒计时窗口重置。窗口随连击数收窄
 *    （3.0s → 1.5s），所以「连得越久越难续」，高段位必须主动找怪。
 *  - 连击数决定倍率档位 1x → 5x，倍率只作用于得分，不改战斗数值，
 *    避免连击滚雪球把难度曲线彻底压平。
 *  - 连击达到 FEVER_AT 触发 Fever：窗口冻结（连击不会断）、倍率锁死在
 *    最高档、武器获得增伤与射速加成，并在屏幕上叠一层全屏特效。
 *    Fever 结束后连击清零，节奏重新起步。
 *
 * 击杀来源：Enemy._die() 会同步派发 enemy:died，所以弹道、灼烧、自爆
 * 这些路径全都能自动计入；WeaponSystem 只额外写一个 pendingSource
 * 做武器归因。registerKill 对同一只敌人幂等，重复调用不会多记。
 *
 * 挂到 engine.combo 上。系统缺席时（例如只跑战斗层的测试）所有调用方
 * 都必须容忍 engine.combo === undefined。
 */
(function (global) {
  'use strict';

  const MathUtils = global.MathUtils;
  const TAU = Math.PI * 2;

  /** 档位表：取「不超过当前连击数」的最后一条 */
  const TIERS = [
    { at: 0,  multiplier: 1, label: 'COMBO', color: '#7cf9ff' },
    { at: 5,  multiplier: 2, label: 'NICE',  color: '#6bffd0' },
    { at: 12, multiplier: 3, label: 'GREAT', color: '#ffd45e' },
    { at: 20, multiplier: 4, label: 'WILD',  color: '#ff8a3d' },
    { at: 30, multiplier: 5, label: 'FEVER', color: '#ff4d6d' },
  ];

  const FEVER_AT = 30;
  const FEVER_DURATION = 8;
  const WINDOW_MAX = 3.0;
  const WINDOW_MIN = 1.5;
  /** 每次击杀的保底分，与敌人经验值相加后再乘倍率 */
  const BASE_POINTS = 5;

  class ComboSystem {
    constructor(options = {}) {
      this.engine = null;

      this.feverAt = options.feverAt || FEVER_AT;
      this.feverDuration = options.feverDuration || FEVER_DURATION;
      this.windowMax = options.windowMax || WINDOW_MAX;
      this.windowMin = options.windowMin || WINDOW_MIN;
      /** Fever 期间的战斗加成 */
      this.feverDamage = options.feverDamage || 1.5;
      this.feverCooldown = options.feverCooldown || 0.65;

      /** WeaponSystem 在结算前写入，供 enemy:died 归因用 */
      this.pendingSource = null;

      this._resetState();
    }

    onAdd(engine) {
      this.engine = engine;
      engine.combo = this;
      engine.events.on('enemy:died', (enemy) => this.registerKill(enemy, this.pendingSource));
    }

    _resetState() {
      this.count = 0;
      this.best = 0;
      this.score = 0;
      this.timer = 0;
      this.window = this.windowMax;
      this.tier = TIERS[0];
      this.multiplier = 1;

      this.fever = false;
      this.feverTimer = 0;
      this.feverCount = 0;

      this.pendingSource = null;
      this._pulse = 0;
      this._feverFade = 0;
    }

    reset() { this._resetState(); }

    /* ================= 查询 ================= */

    /** 连击窗口随连击数收窄，高连击必须打得更密 */
    windowFor(count) {
      return MathUtils.remap(count, 1, this.feverAt, this.windowMax, this.windowMin);
    }

    tierFor(count) {
      let tier = TIERS[0];
      for (const t of TIERS) if (count >= t.at) tier = t;
      return tier;
    }

    /** 剩余窗口比例 0~1，Fever 期间恒为 1 */
    get timeRatio() {
      if (this.fever) return 1;
      if (this.count <= 0 || this.window <= 0) return 0;
      return MathUtils.clamp(this.timer / this.window, 0, 1);
    }

    /** 距离触发 Fever 的进度 0~1 */
    get feverProgress() {
      return this.fever ? 1 : MathUtils.clamp(this.count / this.feverAt, 0, 1);
    }

    get feverRatio() {
      return this.fever ? MathUtils.clamp(this.feverTimer / this.feverDuration, 0, 1) : 0;
    }

    /** 武器增伤系数：仅 Fever 期间生效 */
    get damageBonus() { return this.fever ? this.feverDamage : 1; }
    /** 武器冷却系数：小于 1 表示打得更快 */
    get cooldownScale() { return this.fever ? this.feverCooldown : 1; }

    /* ================= 计数 ================= */

    /**
     * 记一次击杀。对同一只敌人幂等，被静默回收（despawn）的不算数。
     * @param {object} enemy
     * @param {string} [source] 武器 id，仅用于事件里的归因
     * @returns {number} 本次击杀入账的分数
     */
    registerKill(enemy, source) {
      if (!enemy || enemy.culled || enemy._comboCounted) return 0;
      enemy._comboCounted = true;

      this.count++;
      if (this.count > this.best) this.best = this.count;

      this.window = this.windowFor(this.count);
      this.timer = this.window;

      const previous = this.tier;
      this.tier = this.tierFor(this.count);
      this.multiplier = this.tier.multiplier;

      const worth = BASE_POINTS + (enemy.xpValue || 0);
      const points = Math.round(worth * this.multiplier * (this.fever ? 2 : 1));
      this.score += points;

      const engine = this.engine;
      if (engine) {
        engine.events.emit('combo:hit', {
          count: this.count, multiplier: this.multiplier, points, enemy, source: source || null,
        });
        if (this.tier !== previous) {
          this._pulse = 1;
          engine.events.emit('combo:tier', {
            count: this.count, tier: this.tier, multiplier: this.multiplier,
          });
        }
      }

      if (!this.fever && this.count >= this.feverAt) this.startFever();
      return points;
    }

    /** 窗口耗尽：连击归零 */
    breakCombo() {
      if (this.count <= 0) return;
      const lost = this.count;
      this.count = 0;
      this.timer = 0;
      this.tier = TIERS[0];
      this.multiplier = 1;
      if (this.engine) this.engine.events.emit('combo:break', { count: lost });
    }

    startFever() {
      if (this.fever) return;
      this.fever = true;
      this.feverTimer = this.feverDuration;
      this.feverCount++;
      this.tier = TIERS[TIERS.length - 1];
      this.multiplier = this.tier.multiplier;

      const engine = this.engine;
      if (!engine) return;
      engine.camera.addTrauma(0.55);
      const player = engine.player;
      if (player) {
        engine.particles.shockwave(player.position.x, player.position.y, {
          size: 24, endSize: 460, color: '#ff4d6d', life: 0.8,
        });
        engine.particles.burst(player.position.x, player.position.y, 46, {
          colors: ['#ff4d6d', '#ffd45e', '#ffffff'],
          speedMin: 160, speedMax: 540, lifeMin: 0.4, lifeMax: 0.95,
          shape: 'spark', stretch: 1.8, drag: 0.9,
        });
      }
      engine.events.emit('fever:start', { duration: this.feverDuration, count: this.count });
    }

    endFever() {
      if (!this.fever) return;
      this.fever = false;
      this.feverTimer = 0;
      const reached = this.count;
      // 清零而不是继续衰减：Fever 之后重新起步，节奏才有起伏
      this.count = 0;
      this.timer = 0;
      this.tier = TIERS[0];
      this.multiplier = 1;
      if (this.engine) this.engine.events.emit('fever:end', { count: reached });
    }

    /* ================= 每帧 ================= */

    update(dt) {
      if (this.fever) {
        this.timer = this.window;
        this.feverTimer -= dt;
        if (this.feverTimer <= 0) this.endFever();
        return;
      }
      if (this.count <= 0) return;
      this.timer -= dt;
      if (this.timer <= 0) this.breakCombo();
    }

    /** 视觉状态即使在暂停 / 选卡界面也要继续过渡，否则切换很生硬 */
    updateAlways(rawDelta) {
      this._pulse = Math.max(0, this._pulse - rawDelta * 2.4);
      const target = this.fever ? 1 : 0;
      this._feverFade = MathUtils.damp(this._feverFade, target, 0.0008, rawDelta);
      if (Math.abs(this._feverFade - target) < 0.01) this._feverFade = target;
    }

    /* ================= Fever 全屏特效 ================= */

    drawScreen(ctx, engine) {
      const fade = this._feverFade;
      if (fade <= 0.01) return;

      const w = engine.width;
      const h = engine.height;
      const t = engine.elapsed;
      const pulse = 0.5 + Math.sin(t * 9) * 0.5;

      ctx.save();

      // 1) 四周内收的红金辉光，把视线压向画面中心
      const glow = ctx.createRadialGradient(
        w / 2, h / 2, Math.min(w, h) * 0.26,
        w / 2, h / 2, Math.max(w, h) * 0.72
      );
      glow.addColorStop(0, 'rgba(255,77,109,0)');
      glow.addColorStop(0.62, `rgba(255,77,109,${0.1 * fade})`);
      glow.addColorStop(1, `rgba(255,120,60,${(0.34 + pulse * 0.14) * fade})`);
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);

      // 2) 从边缘往内扫的速度线，只画在外圈，避免糊住战场
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = '#ffd45e';
      ctx.lineCap = 'round';
      const rays = 26;
      const outer = Math.hypot(w, h) * 0.52;
      for (let i = 0; i < rays; i++) {
        const angle = (i / rays) * TAU + t * 0.6;
        // 每条线自己的相位，让扫动看起来不是整体旋转
        const phase = (t * 1.4 + i * 0.37) % 1;
        const length = 90 + phase * 130;
        const start = outer - phase * 90;
        ctx.globalAlpha = fade * 0.34 * (1 - phase) * (0.6 + pulse * 0.4);
        ctx.lineWidth = 2 + (1 - phase) * 3;
        ctx.beginPath();
        ctx.moveTo(w / 2 + Math.cos(angle) * start, h / 2 + Math.sin(angle) * start);
        ctx.lineTo(
          w / 2 + Math.cos(angle) * (start - length),
          h / 2 + Math.sin(angle) * (start - length)
        );
        ctx.stroke();
      }

      // 3) 上下两条脉冲光带，呼应 DOM 层的边框脉冲
      ctx.globalAlpha = fade * (0.22 + pulse * 0.2);
      const band = ctx.createLinearGradient(0, 0, 0, h);
      band.addColorStop(0, 'rgba(255,212,94,0.9)');
      band.addColorStop(0.12, 'rgba(255,77,109,0)');
      band.addColorStop(0.88, 'rgba(255,77,109,0)');
      band.addColorStop(1, 'rgba(255,212,94,0.9)');
      ctx.fillStyle = band;
      ctx.fillRect(0, 0, w, h);

      ctx.restore();
    }

    /* ================= HUD ================= */

    snapshot() {
      return {
        count: this.count,
        best: this.best,
        score: this.score,
        multiplier: this.multiplier,
        label: this.tier.label,
        color: this.tier.color,
        timeRatio: this.timeRatio,
        feverProgress: this.feverProgress,
        feverRatio: this.feverRatio,
        feverTimeLeft: Math.max(0, this.feverTimer),
        feverAt: this.feverAt,
        fever: this.fever,
        pulse: this._pulse,
      };
    }
  }

  ComboSystem.TIERS = TIERS;
  ComboSystem.FEVER_AT = FEVER_AT;
  ComboSystem.FEVER_DURATION = FEVER_DURATION;

  global.ComboSystem = ComboSystem;
})(window);
