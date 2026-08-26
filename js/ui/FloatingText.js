/**
 * FloatingText — 统一飘字管理（伤害 / 经验 / 连击 / 提示）
 *
 * 战场上每秒钟能冒出几十条字，散着写必然演成一锅粥。这里把三件事收成一处：
 *
 *  1. 语义化预设：调用方只说「这是暴击 / 这是经验」，字号、配色、运动曲线、
 *     叠字优先级统一在 STYLES 里定义，改风格只动这一张表；
 *  2. 同源聚合：同一个目标在 MERGE_WINDOW 内的连续伤害滚进同一条飘字里，
 *     数字持续累加并重新弹一下。火焰、闪电这类高频小伤害不再刷屏，
 *     也不会把定容池冲干净导致暴击数字被顶掉；
 *  3. 防重叠与配额：新字会避开刚刚落在同一处的旧字；池满时挤掉的是
 *     优先级最低、寿命最短的那条，重要提示永远抢得到位置。
 *
 * 渲染侧同样做了预算控制：字体串按整数字号复用、发光只给高优先级的前几条、
 * 渐变填充按「颜色 + 字号」缓存，因此几十条字也只有个位数的状态切换。
 *
 * 挂在 engine.floatingText 上；沿用旧名 FloatingTextSystem 以兼容既有调用。
 */
(function (global) {
  'use strict';

  const MathUtils = global.MathUtils;

  const DEFAULT_CAPACITY = 140;

  /** 同一目标的伤害在这段时间内滚进同一条飘字 */
  const MERGE_WINDOW = 0.34;
  /** 每次合并把剩余寿命补到至少这么长，滚动中的数字不会中途消失 */
  const MERGE_EXTEND = 0.5;
  /** 防重叠时的检测半径与纵向让位步长（世界单位） */
  const STACK_RADIUS = 26;
  const STACK_STEP = 17;
  /** 单帧最多几条字带辉光，超出的退化成描边 */
  const GLOW_BUDGET = 6;

  /**
   * 样式预设。
   *  priority 越高越晚被挤掉、越晚绘制（盖在别的字上面）；
   *  glow     >0 表示允许辉光，数值即模糊半径；
   *  gravity  给伤害数字一点下坠，抛物线比直线更有重量感；
   *  wobble   横向摆动幅度，用在暴击与连击上。
   */
  const STYLES = Object.freeze({
    damage:   { color: '#ffffff', size: 15, life: 0.8, vy: -52, gravity: 46, drag: 0.94, priority: 1, wobble: 0 },
    crit:     { color: '#ffd45e', size: 22, life: 1.0, vy: -76, gravity: 40, drag: 0.93, priority: 3, glow: 12, wobble: 5, gradient: true },
    kill:     { color: '#ff9ebb', size: 18, life: 0.9, vy: -62, gravity: 44, drag: 0.94, priority: 2, glow: 8 },
    xp:       { color: '#6bffd0', size: 14, life: 0.72, vy: -46, gravity: 0, drag: 0.9, priority: 0 },
    heal:     { color: '#6bff9e', size: 16, life: 0.9, vy: -44, gravity: 0, drag: 0.9, priority: 2, glow: 8 },
    hurt:     { color: '#ff6b88', size: 19, life: 1.0, vy: -58, gravity: 0, drag: 0.92, priority: 4, glow: 10 },
    combo:    { color: '#7cf9ff', size: 26, life: 1.1, vy: -70, gravity: 0, drag: 0.9, priority: 5, glow: 16, wobble: 3, gradient: true },
    levelup:  { color: '#ffd45e', size: 24, life: 1.25, vy: -66, gravity: 0, drag: 0.88, priority: 6, glow: 18, gradient: true },
    reaction: { color: '#b78bff', size: 18, life: 0.9, vy: -60, gravity: 0, drag: 0.9, priority: 3, glow: 10 },
    notice:   { color: '#ffffff', size: 20, life: 1.1, vy: -56, gravity: 0, drag: 0.9, priority: 5, glow: 12 },
  });

  const BASE = STYLES.damage;

  /** 起手过冲的弹入曲线，比线性放大「脆」很多 */
  function easeOutBack(t) {
    const c = 2.2;
    const u = t - 1;
    return 1 + (c + 1) * u * u * u + c * u * u;
  }

  class FloatingText {
    constructor(capacity = DEFAULT_CAPACITY) {
      this.capacity = Math.max(8, Math.floor(capacity));
      this.items = new Array(this.capacity);
      for (let i = 0; i < this.capacity; i++) {
        this.items[i] = {
          active: false,
          generation: 0,
          x: 0, y: 0,
          originX: 0,
          vx: 0, vy: -52,
          gravity: 0,
          drag: 0.94,
          life: 0, maxLife: 0.85,
          age: 0,
          text: '',
          color: '#ffffff',
          size: 15,
          baseSize: 15,
          glow: 0,
          gradient: false,
          priority: 1,
          wobble: 0,
          seed: 0,
          pop: 0,
          amount: 0,
          critical: false,
          styleName: 'damage',
          mergeKey: null,
          mergeLeft: 0,
          follow: null,
          offsetX: 0,
          offsetY: 0,
        };
      }

      this._cursor = 0;
      this.activeCount = 0;
      /** 聚合索引：目标对象 → 正在滚动的那条飘字 */
      this._merge = new Map();
      this._mergePrune = 0;
      /** 最近落点，用来给新字让位，定长环形缓冲避免每次遍历全池 */
      this._recent = new Float32Array(16);
      this._recentCursor = 0;
      this._recentCount = 0;

      this.qualityScale = 1;
      this._visible = [];
      this._gradients = new Map();
      this.lastDrawCount = 0;
    }

    /** 画质降档时缩减辉光与渐变，把预算让给粒子 */
    setQuality(scale = 1) {
      this.qualityScale = MathUtils.clamp(scale, 0, 1);
    }

    /* ================= 生成 ================= */

    /**
     * 通用入口。保持与旧版一致的 (x, y, text, options) 签名，
     * options.style 选预设，其余字段可逐项覆盖。
     */
    spawn(x, y, text, options = {}) {
      const style = STYLES[options.style] || BASE;
      const priority = options.priority !== undefined ? options.priority : style.priority;
      const item = this._acquire(priority);
      if (!item) return null;

      const size = options.size !== undefined ? options.size : style.size;
      const spread = options.spread !== undefined ? options.spread : 6;
      const px = x + (spread ? MathUtils.randRange(-spread, spread) : 0);
      const py = options.stack === false ? y : this._avoidOverlap(px, y);

      item.active = true;
      item.generation++;
      item.x = px;
      item.originX = px;
      item.y = py;
      item.vx = options.vx || 0;
      item.vy = options.vy !== undefined ? options.vy : style.vy;
      item.gravity = options.gravity !== undefined ? options.gravity : (style.gravity || 0);
      item.drag = options.drag !== undefined ? options.drag : (style.drag || 0.94);
      item.maxLife = options.life || style.life;
      item.life = item.maxLife;
      item.age = 0;
      item.text = String(text);
      item.color = options.color || style.color;
      item.size = size;
      item.baseSize = size;
      item.glow = options.glow !== undefined ? options.glow : (style.glow || 0);
      item.gradient = options.gradient !== undefined ? options.gradient : !!style.gradient;
      item.priority = priority;
      item.wobble = options.wobble !== undefined ? options.wobble : (style.wobble || 0);
      item.seed = Math.random() * Math.PI * 2;
      item.pop = 1;
      item.amount = options.amount || 0;
      item.critical = !!options.critical;
      item.styleName = options.style || 'damage';
      item.mergeKey = null;
      item.mergeLeft = 0;

      // 跟随目标的字（经验、玩家自身的提示）用相对偏移记录，
      // 目标一旦消失就地脱钩，继续按自己的速度飘完剩下的寿命。
      const follow = options.follow && options.follow.position ? options.follow : null;
      item.follow = follow;
      item.offsetX = follow ? px - follow.position.x : 0;
      item.offsetY = follow ? py - follow.position.y : 0;

      this._remember(px, py);
      return item;
    }

    /**
     * 伤害飘字。传入目标实体即可开启聚合：同一目标在窗口内的后续伤害
     * 会累加进同一条数字并重新弹一下，而不是再叠一层字。
     *
     * @param {object} target 任意可作 Map 键的对象（通常是敌人实体）
     */
    damage(target, x, y, amount, options = {}) {
      const value = Math.round(amount);
      if (!(value > 0)) return null;

      const critical = !!options.critical;
      const kill = !!options.kill;
      const styleName = options.style || (critical ? 'crit' : kill ? 'kill' : 'damage');

      const merged = target ? this._tryMerge(target, value, styleName, critical) : null;
      if (merged) return merged;

      const item = this.spawn(x, y, this._damageLabel(value, critical), Object.assign({
        style: styleName,
        size: this._damageSize(value, critical, kill),
        amount: value,
        critical,
      }, options.overrides));

      if (item && target) {
        item.mergeKey = target;
        item.mergeLeft = MERGE_WINDOW;
        this._merge.set(target, { item, generation: item.generation });
      }
      return item;
    }

    /** 经验拾取。按玩家聚合成一条滚动的 +N，避免每颗宝石都弹一次 */
    xp(target, x, y, amount) {
      const value = Math.round(amount);
      if (!(value > 0)) return null;

      const entry = target ? this._merge.get(target) : null;
      if (entry && this._entryAlive(entry) && entry.item.styleName === 'xp') {
        const item = entry.item;
        item.amount += value;
        item.text = `+${item.amount}`;
        item.size = Math.min(item.baseSize * 1.75, item.baseSize + Math.log10(1 + item.amount) * 5);
        item.life = Math.max(item.life, MERGE_EXTEND * 0.7);
        item.mergeLeft = MERGE_WINDOW;
        item.pop = 0.55;
        return item;
      }

      const item = this.spawn(x, y, `+${value}`, {
        style: 'xp', spread: 4, amount: value, follow: target,
      });
      if (item && target) {
        item.mergeKey = target;
        item.mergeLeft = MERGE_WINDOW;
        this._merge.set(target, { item, generation: item.generation });
      }
      return item;
    }

    /** 连击提示，配色跟着档位走 */
    combo(x, y, text, color) {
      return this.spawn(x, y, text, { style: 'combo', color, spread: 0, stack: false });
    }

    /** 通用大字提示（处决 / 暴怒 / 元素反应 / 升级） */
    notice(x, y, text, options = {}) {
      return this.spawn(x, y, text, Object.assign({ style: 'notice' }, options));
    }

    /* ================= 聚合 ================= */

    _entryAlive(entry) {
      const item = entry.item;
      return item.active && item.generation === entry.generation && item.mergeLeft > 0;
    }

    _tryMerge(target, value, styleName, critical) {
      const entry = this._merge.get(target);
      if (!entry) return null;
      if (!this._entryAlive(entry)) {
        this._merge.delete(target);
        return null;
      }

      const item = entry.item;
      // 暴击自己起一条新字：它要独立的配色与字号才够显眼
      if (styleName === 'crit' && !item.critical) return null;
      if (item.styleName === 'xp') return null;

      item.amount += value;
      item.text = this._damageLabel(item.amount, item.critical);
      item.size = this._damageSize(item.amount, item.critical, false);
      item.life = Math.max(item.life, MERGE_EXTEND);
      item.maxLife = Math.max(item.maxLife, item.life);
      item.mergeLeft = MERGE_WINDOW;
      // 每次累加都重新弹一下，滚动中的数字才有「还在挨打」的存在感
      item.pop = 0.6;
      item.vy = Math.min(item.vy, -46);
      return item;
    }

    _damageLabel(value, critical) {
      return critical ? `${value}!` : String(value);
    }

    /** 字号随伤害对数增长：小数字不占地方，大数字一眼认得出 */
    _damageSize(value, critical, kill) {
      return MathUtils.clamp(13 + Math.log10(1 + value) * 6, 13, 30)
        * (critical ? 1.4 : 1)
        * (kill ? 1.15 : 1);
    }

    /* ================= 池与布局 ================= */

    /** 优先用空槽（保持生成顺序）；池满时挤掉优先级最低、快消失的那条 */
    _acquire(priority) {
      for (let i = 0; i < this.capacity; i++) {
        const index = (this._cursor + i) % this.capacity;
        const item = this.items[index];
        if (!item.active) {
          this._cursor = (index + 1) % this.capacity;
          return item;
        }
      }

      let victim = null;
      for (let i = 0; i < this.capacity; i++) {
        const item = this.items[i];
        if (item.priority > priority) continue;
        if (!victim
          || item.priority < victim.priority
          || (item.priority === victim.priority && item.life < victim.life)) {
          victim = item;
        }
      }
      if (victim && victim.mergeKey) this._merge.delete(victim.mergeKey);
      return victim;
    }

    /** 落点撞车时向上让位，堆叠的伤害数字才不会糊成一团 */
    _avoidOverlap(x, y) {
      let result = y;
      for (let i = 0; i < this._recentCount; i++) {
        const rx = this._recent[i * 2];
        const ry = this._recent[i * 2 + 1];
        if (Math.abs(rx - x) < STACK_RADIUS && Math.abs(ry - result) < STACK_STEP) {
          result = ry - STACK_STEP;
        }
      }
      return result;
    }

    _remember(x, y) {
      const slot = this._recentCursor;
      this._recent[slot * 2] = x;
      this._recent[slot * 2 + 1] = y;
      this._recentCursor = (slot + 1) % 8;
      if (this._recentCount < 8) this._recentCount++;
    }

    clear() {
      for (let i = 0; i < this.capacity; i++) {
        const item = this.items[i];
        item.active = false;
        item.mergeKey = null;
        item.mergeLeft = 0;
        item.follow = null;
        item.styleName = 'damage';
        item.critical = false;
      }
      // 清空后把游标归零，items 的顺序始终等于生成顺序
      this._cursor = 0;
      this.activeCount = 0;
      this._recentCount = 0;
      this._recentCursor = 0;
      this._merge.clear();
      this._visible.length = 0;
    }

    /* ================= 每帧 ================= */

    update(dt) {
      let active = 0;
      for (let i = 0; i < this.capacity; i++) {
        const item = this.items[i];
        if (!item.active) continue;

        item.life -= dt;
        if (item.life <= 0) {
          item.active = false;
          item.mergeKey = null;
          item.mergeLeft = 0;
          continue;
        }

        item.age += dt;
        if (item.mergeLeft > 0) item.mergeLeft -= dt;
        if (item.pop > 0) item.pop = Math.max(0, item.pop - dt * 6.5);

        const damping = Math.pow(item.drag, dt * 60);
        item.vx *= damping;
        item.vy *= damping;
        item.vy += item.gravity * dt;

        const dx = item.vx * dt;
        const dy = item.vy * dt;
        const follow = item.follow;
        if (follow && follow.position && !follow.dead) {
          item.offsetX += dx;
          item.offsetY += dy;
          item.x = follow.position.x + item.offsetX;
          item.y = follow.position.y + item.offsetY;
        } else {
          item.follow = null;
          item.x += dx;
          item.y += dy;
        }
        active++;
      }
      this.activeCount = active;

      // 聚合索引里的失效条目定期清一遍，敌人被回收后不该继续被引用
      this._mergePrune += dt;
      if (this._mergePrune > 2 && this._merge.size) {
        this._mergePrune = 0;
        for (const [key, entry] of this._merge) {
          if (!this._entryAlive(entry)) this._merge.delete(key);
        }
      }
    }

    /** 需在已应用相机变换的上下文中调用 */
    draw(ctx, camera) {
      if (this.activeCount === 0) {
        this.lastDrawCount = 0;
        return;
      }

      const visible = this._visible;
      visible.length = 0;
      for (let i = 0; i < this.capacity; i++) {
        const item = this.items[i];
        if (!item.active) continue;
        if (camera && !camera.isVisible(item, 90)) continue;
        visible.push(item);
      }
      if (!visible.length) {
        this.lastDrawCount = 0;
        return;
      }

      // 优先级高的后画，压在普通伤害数字上面
      visible.sort((a, b) => a.priority - b.priority);

      // 相机在小屏会拉近，按缩放反补一点字号，手机上才读得清
      const zoom = camera && camera.zoom ? camera.zoom : 1;
      const readability = MathUtils.clamp(1 / zoom, 0.9, 1.35);
      const allowGlow = this.qualityScale >= 0.6;
      let glowLeft = allowGlow ? GLOW_BUDGET : 0;

      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;

      let lastFont = '';
      for (let i = visible.length - 1; i >= 0; i--) {
        const item = visible[i];
        const t = item.life / item.maxLife;
        // 起手弹入 + 每次合并再弹一下，两个脉冲叠在一起
        const intro = item.age < 0.14 ? easeOutBack(item.age / 0.14) : 1;
        const pulse = 1 + item.pop * 0.32;
        const fontSize = Math.max(6, Math.round(item.size * readability * intro * pulse));
        const font = `800 ${fontSize}px "Rajdhani", "PingFang SC", "Segoe UI", sans-serif`;
        if (font !== lastFont) {
          ctx.font = font;
          lastFont = font;
        }

        // 尾段才开始褪，读数时间尽量长
        ctx.globalAlpha = MathUtils.clamp(t * 3.2, 0, 1) * MathUtils.clamp(item.age * 8, 0, 1);
        const wobble = item.wobble
          ? Math.sin(item.age * 13 + item.seed) * item.wobble * MathUtils.clamp(t * 1.6, 0, 1)
          : 0;

        ctx.save();
        ctx.translate(item.x + wobble, item.y);

        const glow = item.glow && glowLeft > 0 ? item.glow : 0;
        if (glow) {
          glowLeft--;
          ctx.shadowColor = item.color;
          ctx.shadowBlur = glow;
        }

        // 深色描边保证任何背景上都读得清
        ctx.lineWidth = Math.max(3, fontSize * 0.22);
        ctx.strokeStyle = 'rgba(3,6,16,0.88)';
        ctx.strokeText(item.text, 0, 0);

        ctx.fillStyle = item.gradient
          ? this._gradientFor(ctx, item.color, fontSize)
          : item.color;
        ctx.fillText(item.text, 0, 0);
        ctx.restore();
      }

      ctx.restore();
      this.lastDrawCount = visible.length;
    }

    /**
     * 顶白底彩的竖向渐变，让重要数字有金属质感。
     * 绘制前已 translate 到字的位置，因此渐变可以按「颜色 + 字号」缓存复用。
     */
    _gradientFor(ctx, color, fontSize) {
      const bucket = Math.round(fontSize / 3) * 3;
      const key = `${color}|${bucket}`;
      let gradient = this._gradients.get(key);
      if (!gradient) {
        gradient = ctx.createLinearGradient(0, -bucket * 0.62, 0, bucket * 0.62);
        gradient.addColorStop(0, '#ffffff');
        gradient.addColorStop(0.52, color);
        gradient.addColorStop(1, color);
        this._gradients.set(key, gradient);
      }
      return gradient;
    }
  }

  FloatingText.STYLES = STYLES;
  FloatingText.MERGE_WINDOW = MERGE_WINDOW;

  global.FloatingText = FloatingText;
  // 旧名：GameEngine 与既有调用点仍按这个名字取用
  global.FloatingTextSystem = FloatingText;
})(window);
