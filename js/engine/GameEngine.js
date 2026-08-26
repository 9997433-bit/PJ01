/**
 * GameEngine — 主循环 / 时间管理 / 状态机 / 实体与系统调度
 *
 * 设计要点：
 *  - 变步长 + dt 上限：切后台或卡顿回来时不会「瞬移穿墙」；
 *  - timeScale 与 hitStop：命中定格、慢动作等演出手段的统一入口；
 *  - 状态机用白名单表约束合法迁移，非法迁移只警告不崩溃；
 *  - 实体增删延迟到帧末生效，避免遍历中修改数组。
 */
(function (global) {
  'use strict';

  const GameState = Object.freeze({
    MENU: 'menu',
    PLAYING: 'playing',
    PAUSED: 'paused',
    LEVELUP: 'levelup',
    DEAD: 'dead',
    VICTORY: 'victory',
  });

  const VALID_TRANSITIONS = {
    [GameState.MENU]: [GameState.PLAYING],
    [GameState.PLAYING]: [GameState.PAUSED, GameState.LEVELUP, GameState.DEAD,
      GameState.MENU, GameState.VICTORY],
    [GameState.PAUSED]: [GameState.PLAYING, GameState.MENU],
    // 升级面板挂起时也可能结算胜负（例如选卡瞬间 Boss 死亡演出结束）
    [GameState.LEVELUP]: [GameState.PLAYING, GameState.MENU, GameState.DEAD, GameState.VICTORY],
    [GameState.DEAD]: [GameState.MENU, GameState.PLAYING],
    [GameState.VICTORY]: [GameState.MENU, GameState.PLAYING],
  };

  /** 渲染层级：数值越大越靠上 */
  const Layer = Object.freeze({
    GROUND: 0,
    PICKUP: 10,
    ACTOR: 20,
    PROJECTILE: 30,
    EFFECT: 40,
  });

  const MAX_DELTA = 1 / 20; // 单帧最多推进 50ms
  const FPS_WINDOW = 120;
  const QUALITY_CHECK_INTERVAL = 0.5;
  const QUALITY_PROFILES = Object.freeze([
    Object.freeze({
      name: 'high',
      particleEmission: 1,
      particleRender: 1,
      renderStride: 1,
      lodBias: 0,
      sortEntities: true,
    }),
    Object.freeze({
      name: 'balanced',
      particleEmission: 0.62,
      particleRender: 0.7,
      renderStride: 1,
      lodBias: 1,
      sortEntities: true,
    }),
    Object.freeze({
      name: 'performance',
      particleEmission: 0.34,
      particleRender: 0.42,
      renderStride: 2,
      lodBias: 2,
      sortEntities: false,
    }),
  ]);

  class GameEngine {
    constructor(canvas, options = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

      this.events = new global.EventBus();
      this.camera = new global.Camera({ smoothing: 0.0016, lookAhead: 70 });
      this.input = options.input || null;
      this.particles = new global.ParticleSystem(options.particleCapacity || 3000);
      this.floatingText = new global.FloatingTextSystem(options.floatingTextCapacity || 140);
      this.grid = new global.SpatialGrid(options.cellSize || 110);
      this.background = null;

      this.entities = [];
      this._pendingAdd = [];
      this._tagIndex = new Map();
      this.systems = [];

      this.state = GameState.MENU;
      this.previousState = null;

      this.running = false;
      this.deltaTime = 0;      // 本帧已缩放的游戏时间（秒）
      this.rawDelta = 0;       // 本帧真实时间（秒）
      this.elapsed = 0;        // 累计游戏内时间（仅 PLAYING 累加）
      this.frameCount = 0;
      this.timeScale = 1;
      this.hitStop = 0;
      this.fps = 60;
      this.renderedFrameCount = 0;
      this.skippedRenderCount = 0;

      this.quality = {
        adaptive: options.adaptiveQuality !== false,
        targetFps: options.targetFps || 60,
        level: 0,
        name: QUALITY_PROFILES[0].name,
        renderStride: 1,
        lodBias: 0,
        sortEntities: true,
      };
      this._fpsSamples = new Float32Array(FPS_WINDOW);
      this._fpsSampleCount = 0;
      this._fpsSampleCursor = 0;
      this._fpsSampleTotal = 0;
      this._qualityCheckElapsed = 0;
      this._slowWindows = 0;
      this._fastWindows = 0;

      this.width = 0;
      this.height = 0;
      this.dpr = 1;

      this._rafId = null;
      this._lastTimestamp = 0;
      this._drawList = [];

      this._loop = this._loop.bind(this);
      this._setupResize();
      this._setupVisibility();
      this.resize();
      this._applyQualityProfile(0, 'initial');
    }

    /* ================= 画布自适应 ================= */

    _setupResize() {
      this._onResize = () => this.resize();
      global.addEventListener('resize', this._onResize);
      global.addEventListener('orientationchange', this._onResize);
      if (global.ResizeObserver) {
        this._resizeObserver = new global.ResizeObserver(() => this.resize());
        this._resizeObserver.observe(this.canvas.parentElement || this.canvas);
      }
    }

    resize() {
      const parent = this.canvas.parentElement;
      const rect = parent ? parent.getBoundingClientRect() : { width: global.innerWidth, height: global.innerHeight };
      const cssWidth = Math.max(1, Math.floor(rect.width || global.innerWidth));
      const cssHeight = Math.max(1, Math.floor(rect.height || global.innerHeight));
      // 高分屏按 DPR 放大后端缓冲，但封顶 2 以免移动端 GPU 吃不消
      const dpr = Math.min(global.devicePixelRatio || 1, 2);

      this.width = cssWidth;
      this.height = cssHeight;
      this.dpr = dpr;

      this.canvas.width = Math.floor(cssWidth * dpr);
      this.canvas.height = Math.floor(cssHeight * dpr);
      this.canvas.style.width = `${cssWidth}px`;
      this.canvas.style.height = `${cssHeight}px`;

      this.camera.resize(cssWidth, cssHeight);
      // 小屏拉近一点，保证角色在手机上不至于太小
      this.camera.setZoom(global.MathUtils.clamp(Math.min(cssWidth, cssHeight) / 720, 0.8, 1.35), true);

      this.events.emit('resize', { width: cssWidth, height: cssHeight, dpr });
    }

    _setupVisibility() {
      global.document.addEventListener('visibilitychange', () => {
        if (global.document.hidden && this.state === GameState.PLAYING) {
          this.setState(GameState.PAUSED);
        }
        // 回到前台时重置时间戳，避免累计出一个巨大的 dt
        this._lastTimestamp = 0;
      });
    }

    /* ================= 状态机 ================= */

    setState(next) {
      if (next === this.state) return true;
      const allowed = VALID_TRANSITIONS[this.state] || [];
      if (!allowed.includes(next)) {
        console.warn(`[GameEngine] 非法状态迁移: ${this.state} → ${next}`);
        return false;
      }
      const prev = this.state;
      this.previousState = prev;
      this.state = next;
      if (this.input) this.input.reset();
      this.events.emit('state:exit', prev);
      this.events.emit('state:change', { from: prev, to: next });
      this.events.emit(`state:${next}`, prev);
      return true;
    }

    isState(...states) { return states.includes(this.state); }

    /** 空格 / ESC 的暂停开关 */
    togglePause() {
      if (this.state === GameState.PLAYING) this.setState(GameState.PAUSED);
      else if (this.state === GameState.PAUSED) this.setState(GameState.PLAYING);
    }

    /* ================= 生命周期 ================= */

    start() {
      if (this.running) return;
      this.running = true;
      this._lastTimestamp = 0;
      this._rafId = global.requestAnimationFrame(this._loop);
    }

    stop() {
      this.running = false;
      if (this._rafId !== null) global.cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }

    destroy() {
      this.stop();
      global.removeEventListener('resize', this._onResize);
      global.removeEventListener('orientationchange', this._onResize);
      if (this._resizeObserver) this._resizeObserver.disconnect();
      this.events.clear();
    }

    _loop(timestamp) {
      if (!this.running) return;
      this._rafId = global.requestAnimationFrame(this._loop);

      if (!this._lastTimestamp) this._lastTimestamp = timestamp;
      const rawDelta = Math.min((timestamp - this._lastTimestamp) / 1000, MAX_DELTA);
      this._lastTimestamp = timestamp;
      this.rawDelta = rawDelta;
      this.frameCount++;
      this._monitorFps(rawDelta);

      let scale = this.timeScale;
      if (this.hitStop > 0) {
        this.hitStop = Math.max(0, this.hitStop - rawDelta);
        scale *= 0.08; // 命中定格：几乎停住但不完全冻结，保留一点张力
      }
      this.deltaTime = rawDelta * scale;

      this.update(this.deltaTime, rawDelta);
      const stride = this.state === GameState.PLAYING ? this.quality.renderStride : 1;
      if (stride === 1 || this.frameCount % stride === 0) {
        this.render();
        this.renderedFrameCount++;
      } else {
        this.skippedRenderCount++;
      }
    }

    /**
     * 使用无分配的滚动窗口监控 FPS，并以迟滞策略切换画质。
     * 低于目标时快速降级，恢复则需要连续多个稳定窗口，避免档位抖动。
     */
    _monitorFps(rawDelta) {
      if (!(rawDelta > 0)) return;

      const frameMs = Math.min(250, rawDelta * 1000);
      if (this._fpsSampleCount < FPS_WINDOW) {
        this._fpsSampleCount++;
      } else {
        this._fpsSampleTotal -= this._fpsSamples[this._fpsSampleCursor];
      }
      this._fpsSamples[this._fpsSampleCursor] = frameMs;
      this._fpsSampleTotal += frameMs;
      this._fpsSampleCursor = (this._fpsSampleCursor + 1) % FPS_WINDOW;
      this.fps = this._fpsSampleTotal > 0
        ? (1000 * this._fpsSampleCount) / this._fpsSampleTotal
        : this.quality.targetFps;

      if (!this.quality.adaptive || this.state !== GameState.PLAYING) return;
      this._qualityCheckElapsed += rawDelta;
      if (this._qualityCheckElapsed < QUALITY_CHECK_INTERVAL) return;
      this._qualityCheckElapsed = 0;

      const target = this.quality.targetFps;
      const level = this.quality.level;
      const severe = this.fps < target * 0.68;
      const slow = this.fps < target - (level === 0 ? 8 : 13);
      const fast = this.fps >= target - 2;

      this._slowWindows = slow ? this._slowWindows + 1 : 0;
      this._fastWindows = fast ? this._fastWindows + 1 : 0;

      if (level < QUALITY_PROFILES.length - 1 && (severe || this._slowWindows >= 2)) {
        this.setQualityLevel(severe ? QUALITY_PROFILES.length - 1 : level + 1, 'fps-low');
      } else if (level > 0 && this._fastWindows >= 6) {
        this.setQualityLevel(level - 1, 'fps-recovered');
      }
    }

    setQualityLevel(level, reason = 'manual') {
      const next = Math.max(0, Math.min(QUALITY_PROFILES.length - 1, Math.round(level)));
      if (next === this.quality.level && reason !== 'initial') return false;
      this._applyQualityProfile(next, reason);
      return true;
    }

    _applyQualityProfile(level, reason) {
      const profile = QUALITY_PROFILES[level];
      const previous = this.quality.name;
      this.quality.level = level;
      this.quality.name = profile.name;
      this.quality.renderStride = profile.renderStride;
      this.quality.lodBias = profile.lodBias;
      this.quality.sortEntities = profile.sortEntities;
      this._slowWindows = 0;
      this._fastWindows = 0;
      if (this.particles.setQuality) {
        this.particles.setQuality(profile.particleEmission, profile.particleRender);
      }
      if (this.floatingText.setQuality) {
        this.floatingText.setQuality(profile.particleRender);
      }
      if (reason !== 'initial') {
        this.events.emit('performance:quality', {
          from: previous,
          to: profile.name,
          level,
          fps: this.fps,
          reason,
        });
      }
    }

    getPerformanceSnapshot() {
      return {
        fps: this.fps,
        quality: this.quality.name,
        qualityLevel: this.quality.level,
        renderedFrames: this.renderedFrameCount,
        skippedFrames: this.skippedRenderCount,
        particles: this.particles.activeCount,
      };
    }

    /** 命中定格，单位秒 */
    freeze(duration = 0.06) {
      this.hitStop = Math.max(this.hitStop, duration);
    }

    /* ================= 更新 ================= */

    update(dt, rawDelta) {
      if (this.input) this.input.update(this.camera);

      const simulating = this.state === GameState.PLAYING;

      if (simulating) {
        this.elapsed += dt;

        this.grid.rebuild(this.entities);

        for (let i = 0; i < this.systems.length; i++) {
          const system = this.systems[i];
          if (system.update) system.update(dt, this);
        }

        for (let i = 0; i < this.entities.length; i++) {
          const entity = this.entities[i];
          if (entity.active && !entity.dead) entity.update(dt, this);
        }

        this._flush();
      }

      // 粒子与相机在暂停/菜单下继续走，界面不会显得完全僵死
      const fxDelta = simulating ? dt : rawDelta * 0.35;
      this.particles.update(fxDelta);
      this.floatingText.update(fxDelta);
      this.camera.update(simulating ? dt : rawDelta);
      // 背景要读战况来切气氛（Fever / Boss / 波次），把引擎一起递进去
      if (this.background && this.background.update) this.background.update(fxDelta, this);

      // updateAlways 不受状态机限制，供 HUD、背景演出等使用
      for (let i = 0; i < this.systems.length; i++) {
        const system = this.systems[i];
        if (system.updateAlways) system.updateAlways(rawDelta, this);
      }

      if (this.input) this.input.endFrame();
    }

    /** 应用挂起的增删 */
    _flush() {
      if (this._pendingAdd.length) {
        for (const entity of this._pendingAdd) {
          this.entities.push(entity);
          this._indexTag(entity);
          if (entity.onAdd) entity.onAdd(this);
        }
        this._pendingAdd.length = 0;
      }

      let write = 0;
      for (let read = 0; read < this.entities.length; read++) {
        const entity = this.entities[read];
        if (entity.dead) {
          this._unindexTag(entity);
          if (entity.onRemove) entity.onRemove(this);
          continue;
        }
        this.entities[write++] = entity;
      }
      this.entities.length = write;
    }

    /* ================= 渲染 ================= */

    render() {
      const ctx = this.ctx;
      ctx.save();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

      ctx.fillStyle = '#05070f';
      ctx.fillRect(0, 0, this.width, this.height);

      ctx.save();
      this.camera.applyTransform(ctx);

      if (this.background && this.background.draw) {
        this.background.draw(ctx, this.camera, this);
      }

      // 先按层级、同层再按 y 排序，得到自然的前后遮挡
      const drawList = this._drawList;
      drawList.length = 0;
      for (let i = 0; i < this.entities.length; i++) {
        const entity = this.entities[i];
        if (!entity.visible || entity.dead) continue;
        if (entity.shouldRender) {
          if (!entity.shouldRender(this.camera, this)) continue;
        } else if (!this.camera.isVisible(entity.position, entity.radius + 80)) {
          continue;
        }
        drawList.push(entity);
      }
      if (this.quality.sortEntities) {
        drawList.sort((a, b) => (a.layer - b.layer) || (a.position.y - b.position.y));
      }

      for (let i = 0; i < drawList.length; i++) {
        drawList[i].draw(ctx, this);
      }

      this.particles.draw(ctx, this.camera, this.frameCount);
      this.floatingText.draw(ctx, this.camera);

      for (let i = 0; i < this.systems.length; i++) {
        const system = this.systems[i];
        if (system.drawWorld) system.drawWorld(ctx, this);
      }

      ctx.restore(); // 退出相机空间

      for (let i = 0; i < this.systems.length; i++) {
        const system = this.systems[i];
        if (system.drawScreen) system.drawScreen(ctx, this);
      }

      this._drawVignette(ctx);
      ctx.restore();
    }

    _drawVignette(ctx) {
      const w = this.width;
      const h = this.height;
      if (!this._vignette || this._vignetteW !== w || this._vignetteH !== h) {
        const gradient = ctx.createRadialGradient(
          w / 2, h / 2, Math.min(w, h) * 0.34,
          w / 2, h / 2, Math.max(w, h) * 0.78
        );
        gradient.addColorStop(0, 'rgba(0,0,0,0)');
        gradient.addColorStop(1, 'rgba(0,0,0,0.62)');
        this._vignette = gradient;
        this._vignetteW = w;
        this._vignetteH = h;
      }
      ctx.fillStyle = this._vignette;
      ctx.fillRect(0, 0, w, h);
    }

    /* ================= 实体管理 ================= */

    add(entity) {
      entity.engine = this;
      this._pendingAdd.push(entity);
      return entity;
    }

    /** 立刻加入（用于初始化阶段，避免等到下一帧 flush） */
    addImmediate(entity) {
      entity.engine = this;
      this.entities.push(entity);
      this._indexTag(entity);
      if (entity.onAdd) entity.onAdd(this);
      return entity;
    }

    remove(entity) { entity.dead = true; }

    _indexTag(entity) {
      if (!entity.tag) return;
      if (!this._tagIndex.has(entity.tag)) this._tagIndex.set(entity.tag, new Set());
      this._tagIndex.get(entity.tag).add(entity);
    }

    _unindexTag(entity) {
      const set = this._tagIndex.get(entity.tag);
      if (set) set.delete(entity);
    }

    getByTag(tag) {
      const set = this._tagIndex.get(tag);
      return set ? Array.from(set) : [];
    }

    countByTag(tag) {
      const set = this._tagIndex.get(tag);
      return set ? set.size : 0;
    }

    clearEntities() {
      for (const entity of this.entities) {
        if (entity.onRemove) entity.onRemove(this);
      }
      this.entities.length = 0;
      this._pendingAdd.length = 0;
      this._tagIndex.clear();
      this.grid.clear();
    }

    addSystem(system) {
      system.engine = this;
      this.systems.push(system);
      if (system.onAdd) system.onAdd(this);
      return system;
    }

    /** 重开一局：清空世界与时间，但保留 systems 与订阅 */
    resetWorld() {
      this.clearEntities();
      this.particles.clear();
      this.floatingText.clear();
      this.camera.reset();
      this.elapsed = 0;
      this.timeScale = 1;
      this.hitStop = 0;
      this._fpsSampleCount = 0;
      this._fpsSampleCursor = 0;
      this._fpsSampleTotal = 0;
      this._qualityCheckElapsed = 0;
      this.fps = this.quality.targetFps;
      this.setQualityLevel(0, 'reset');
      for (const system of this.systems) {
        if (system.reset) system.reset(this);
      }
    }
  }

  GameEngine.GameState = GameState;
  GameEngine.Layer = Layer;
  GameEngine.QUALITY_PROFILES = QUALITY_PROFILES;
  global.GameEngine = GameEngine;
  global.GameState = GameState;
  global.Layer = Layer;
})(window);
