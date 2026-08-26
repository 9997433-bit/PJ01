/**
 * EnemySpawner — 波次与刷怪
 *
 * 节奏设计：
 *  - 每 WAVE_DURATION 秒推进一波，波次决定可用怪种、刷新速率与同屏上限。
 *  - 常规刷怪落在相机视野外一圈的椭圆上，玩家永远看不到凭空冒出来的怪；
 *    用椭圆而不是正圆，横屏时左右刷得更远，各方向入场时间才一致。
 *  - 每波中段随机触发一次事件（包围圈 / 冲锋列 / 精英小队 / 崽潮），
 *    让压力曲线有起伏，而不是均匀铺开。
 *  - 每 BOSS_EVERY 波来一个 Boss，Boss 在场时常规刷怪降速，把注意力让给它。
 *  - 同屏上限随波次抬升但有硬顶；超顶时静默回收离玩家最远的杂兵，
 *    玩家看不到它们消失，却能立刻腾出预算给新的压迫感。
 */
(function (global) {
  'use strict';

  const MathUtils = global.MathUtils;
  const TAU = Math.PI * 2;

  const WAVE_DURATION = 30;
  const BOSS_EVERY = 5;
  const HARD_CAP = 400;

  /**
   * 波次表：取「不超过当前波次」的最后一条。
   * interval 是刷新间隔（秒），batch 是每次刷几只，cap 是同屏上限。
   */
  const WAVE_TABLE = [
    { wave: 1,  interval: 1.15, batch: 1, cap: 40,  weights: { grunt: 10 } },
    { wave: 2,  interval: 1.00, batch: 1, cap: 55,  weights: { grunt: 10, runner: 3 } },
    { wave: 3,  interval: 0.88, batch: 2, cap: 70,  weights: { grunt: 10, runner: 5, swarm: 4 } },
    { wave: 4,  interval: 0.80, batch: 2, cap: 85,  weights: { grunt: 9, runner: 6, swarm: 6, tank: 2 } },
    { wave: 5,  interval: 0.74, batch: 2, cap: 100, weights: { grunt: 8, runner: 6, swarm: 7, tank: 3, spitter: 3 } },
    { wave: 7,  interval: 0.64, batch: 3, cap: 130, weights: { grunt: 7, runner: 7, swarm: 8, tank: 4, spitter: 4, bomber: 2 } },
    { wave: 9,  interval: 0.56, batch: 3, cap: 160, weights: { grunt: 6, runner: 8, swarm: 9, tank: 5, spitter: 5, bomber: 3 } },
    { wave: 12, interval: 0.47, batch: 4, cap: 205, weights: { grunt: 5, runner: 9, swarm: 10, tank: 6, spitter: 6, bomber: 4 } },
    { wave: 16, interval: 0.39, batch: 5, cap: 270, weights: { grunt: 4, runner: 10, swarm: 12, tank: 8, spitter: 7, bomber: 5 } },
    { wave: 21, interval: 0.33, batch: 6, cap: 330, weights: { grunt: 3, runner: 11, swarm: 14, tank: 10, spitter: 8, bomber: 7 } },
  ];

  /** 波次事件：一波内在随机进度点触发一次 */
  const EVENTS = [
    {
      id: 'encircle', name: '包围圈', minWave: 3, weight: 3,
      run(spawner, engine) {
        const count = 14 + Math.min(30, spawner.wave * 2);
        const radius = spawner.spawnRadius() * 0.94;
        const offset = Math.random() * TAU;
        const type = spawner.wave >= 8 ? 'runner' : 'grunt';
        const player = engine.player.position;
        for (let i = 0; i < count; i++) {
          const a = offset + (i / count) * TAU;
          spawner.spawnAt(player.x + Math.cos(a) * radius, player.y + Math.sin(a) * radius, type);
        }
        spawner.announce(engine, '包围圈', '警告');
      },
    },
    {
      id: 'charge', name: '冲锋列', minWave: 5, weight: 3,
      run(spawner, engine) {
        const count = 10 + Math.min(24, spawner.wave * 2);
        const angle = Math.random() * TAU;
        const radius = spawner.spawnRadius();
        const player = engine.player.position;
        // 以垂直方向排成横排，再分三列错开，形成一堵推进的墙
        const px = Math.cos(angle + Math.PI / 2);
        const py = Math.sin(angle + Math.PI / 2);
        const cx = player.x + Math.cos(angle) * radius;
        const cy = player.y + Math.sin(angle) * radius;
        for (let i = 0; i < count; i++) {
          const lateral = (i - count / 2) * 34;
          const depth = (i % 3) * 44;
          spawner.spawnAt(
            cx + px * lateral + Math.cos(angle) * depth,
            cy + py * lateral + Math.sin(angle) * depth,
            'runner'
          );
        }
        spawner.announce(engine, '冲锋列', '警告');
      },
    },
    {
      id: 'eliteSquad', name: '精英小队', minWave: 6, weight: 2,
      run(spawner, engine) {
        const count = 2 + Math.floor(spawner.wave / 6);
        for (let i = 0; i < count; i++) {
          const p = spawner.edgePoint();
          spawner.spawnAt(p.x, p.y, Math.random() < 0.5 ? 'tank' : 'spitter', { elite: true });
        }
        spawner.announce(engine, '精英小队来袭', '警告');
        engine.events.emit('wave:elite', spawner.wave);
      },
    },
    {
      id: 'swarmTide', name: '孵化潮', minWave: 4, weight: 3,
      run(spawner, engine) {
        const count = 28 + Math.min(70, spawner.wave * 4);
        for (let i = 0; i < count; i++) {
          const p = spawner.edgePoint(MathUtils.randRange(0.92, 1.25));
          spawner.spawnAt(p.x, p.y, 'swarm');
        }
        spawner.announce(engine, '孵化潮', '警告');
      },
    },
    {
      id: 'bomberRun', name: '爆裂突袭', minWave: 8, weight: 2,
      run(spawner, engine) {
        const count = 6 + Math.floor(spawner.wave / 3);
        for (let i = 0; i < count; i++) {
          const p = spawner.edgePoint();
          spawner.spawnAt(p.x, p.y, 'bomber');
        }
        spawner.announce(engine, '爆裂突袭', '警告');
      },
    },
  ];

  class EnemySpawner {
    constructor() {
      this.engine = null;
      this._resetState();
    }

    onAdd(engine) {
      this.engine = engine;
      engine.spawner = this;
    }

    _resetState() {
      this.wave = 1;
      this.waveTime = 0;
      this.spawnTimer = 0;
      this.eventFired = false;
      this.eventAt = MathUtils.randRange(0.35, 0.7);
      this.boss = null;
      this.totalSpawned = 0;
    }

    reset() { this._resetState(); }

    /* ================= 波次数据 ================= */

    ruleFor(wave) {
      let rule = WAVE_TABLE[0];
      for (const r of WAVE_TABLE) if (wave >= r.wave) rule = r;
      return rule;
    }

    /** 超出表格后线性外推，保证 20 波以后仍然持续加压 */
    currentRule() {
      const base = this.ruleFor(this.wave);
      const over = Math.max(0, this.wave - WAVE_TABLE[WAVE_TABLE.length - 1].wave);
      if (over === 0) return base;
      return {
        interval: Math.max(0.14, base.interval - over * 0.012),
        batch: base.batch + Math.floor(over / 4),
        cap: Math.min(HARD_CAP, base.cap + over * 12),
        weights: base.weights,
      };
    }

    get progress() { return this.waveTime / WAVE_DURATION; }
    get timeToNextWave() { return WAVE_DURATION - this.waveTime; }
    get isBossWave() { return this.wave % BOSS_EVERY === 0; }
    get bossAlive() { return !!(this.boss && !this.boss.dead); }

    /** 精英出现概率随波次上升，封顶 18% */
    eliteChance() { return Math.min(0.18, Math.max(0, (this.wave - 4) * 0.014)); }

    /* ================= 刷怪位置 ================= */

    /** 视野外一圈的半径：屏幕对角线的一半加缓冲 */
    spawnRadius() {
      const camera = this.engine.camera;
      const w = camera.viewportWidth / camera.zoom;
      const h = camera.viewportHeight / camera.zoom;
      return Math.hypot(w, h) * 0.5 + 80;
    }

    edgePoint(scale = 1) {
      const camera = this.engine.camera;
      const player = this.engine.player.position;
      const halfW = camera.viewportWidth / (2 * camera.zoom) + 90;
      const halfH = camera.viewportHeight / (2 * camera.zoom) + 90;
      const angle = Math.random() * TAU;
      return {
        x: player.x + Math.cos(angle) * halfW * scale,
        y: player.y + Math.sin(angle) * halfH * scale,
      };
    }

    pickType(weights) {
      let total = 0;
      for (const key in weights) total += weights[key];
      let roll = Math.random() * total;
      for (const key in weights) {
        roll -= weights[key];
        if (roll <= 0) return key;
      }
      return 'grunt';
    }

    /* ================= 生成 ================= */

    /**
     * @param {number} x
     * @param {number} y
     * @param {string} typeKey
     * @param {object} [options] { elite, healthMul }
     */
    spawnAt(x, y, typeKey, options) {
      const engine = this.engine;
      if (!engine || !engine.player) return null;
      if (engine.countByTag('enemy') >= HARD_CAP) return null;

      const enemy = new global.Enemy(x, y, typeKey, this.wave, options || {});
      engine.add(enemy);
      this.totalSpawned++;

      engine.particles.burst(x, y, 6, {
        colors: [enemy.def.color, '#ffffff'],
        speedMin: 30, speedMax: 120, lifeMin: 0.14, lifeMax: 0.34, sizeMin: 1.5, sizeMax: 3.5,
      });
      return enemy;
    }

    spawnBoss() {
      const point = this.edgePoint(1.05);
      // Boss 血量随出场轮次额外倍增，避免后期被瞬间融掉
      const round = this.wave / BOSS_EVERY;
      const boss = this.spawnAt(point.x, point.y, 'boss', {
        healthMul: 1 + (round - 1) * 0.85,
      });
      if (!boss) return;

      this.boss = boss;
      this.announce(this.engine, `${boss.def.name} 降临`, '⚠ BOSS');
      this.engine.camera.addTrauma(0.7);
      this.engine.events.emit('wave:boss', boss);
      if (this.engine.audio) this.engine.audio.play('bossSpawn');
    }

    announce(engine, text, tag) {
      if (engine.hud) engine.hud.showBanner(text, tag);
    }

    /* ================= 主循环 ================= */

    update(dt, engine) {
      if (!engine.player || !engine.player.isAlive) return;

      this.waveTime += dt;
      if (this.waveTime >= WAVE_DURATION) {
        this.waveTime -= WAVE_DURATION;
        this.wave++;
        this.eventFired = false;
        this.eventAt = MathUtils.randRange(0.3, 0.72);
        this.announce(engine, `第 ${this.wave} 波`, 'WAVE');
        engine.events.emit('wave:start', this.wave);
        if (this.isBossWave) this.spawnBoss();
      }

      if (!this.eventFired && this.progress >= this.eventAt) {
        this.eventFired = true;
        this.triggerEvent(engine);
      }

      if (this.boss && this.boss.dead) this.boss = null;

      const rule = this.currentRule();
      const cap = Math.min(HARD_CAP, rule.cap);
      const alive = engine.countByTag('enemy');

      if (alive >= cap) {
        this.cullDistant(engine, cap);
        return;
      }

      this.spawnTimer -= dt;
      if (this.spawnTimer > 0) return;
      this.spawnTimer = rule.interval * (this.bossAlive ? 1.7 : 1);

      const batch = Math.min(rule.batch, cap - alive);
      const eliteChance = this.eliteChance();
      for (let i = 0; i < batch; i++) {
        const point = this.edgePoint();
        const type = this.pickType(rule.weights);
        const elite = type !== 'swarm' && Math.random() < eliteChance;
        this.spawnAt(point.x, point.y, type, elite ? { elite: true } : null);
      }
    }

    triggerEvent(engine) {
      const pool = EVENTS.filter((e) => this.wave >= e.minWave);
      if (!pool.length) return;
      let total = 0;
      for (const e of pool) total += e.weight;
      let roll = Math.random() * total;
      for (const e of pool) {
        roll -= e.weight;
        if (roll <= 0) { e.run(this, engine); return; }
      }
    }

    /** 静默回收远处杂兵（永不回收 Boss 与精英） */
    cullDistant(engine, cap) {
      const excess = engine.countByTag('enemy') - cap;
      if (excess <= 0) return;

      const player = engine.player.position;
      const cullRadius = this.spawnRadius() * 1.8;
      const cullRadiusSq = cullRadius * cullRadius;
      let removed = 0;

      const entities = engine.entities;
      for (let i = 0; i < entities.length && removed < excess; i++) {
        const e = entities[i];
        if (e.tag !== 'enemy' || e.dead || e.isBoss || e.elite) continue;
        if (e.position.distanceSqTo(player) > cullRadiusSq) {
          e.despawn();
          removed++;
        }
      }
    }

    /* ================= 屏幕层 UI ================= */

    /**
     * Boss 血条与波次进度条直接画在画布上（而不是 DOM），
     * 这样它们跟随游戏演出，不依赖外部样式表。
     */
    drawScreen(ctx, engine) {
      if (!engine.isState(global.GameState.PLAYING, global.GameState.LEVELUP,
        global.GameState.PAUSED)) return;

      this._drawWaveMeter(ctx, engine);
      if (this.bossAlive) this._drawBossBar(ctx, engine);
    }

    _drawWaveMeter(ctx, engine) {
      const width = 190;
      const x = (engine.width - width) / 2;
      const y = 92;

      ctx.save();
      ctx.font = '700 11px "Rajdhani", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(180,205,235,0.75)';
      ctx.fillText(`WAVE ${this.wave}${this.isBossWave ? ' · BOSS' : ''}`, x + width / 2, y - 7);

      ctx.fillStyle = 'rgba(8,12,22,0.6)';
      ctx.fillRect(x, y, width, 3);
      ctx.fillStyle = this.isBossWave ? '#ff4d6d' : '#4fd8ff';
      ctx.fillRect(x, y, width * MathUtils.clamp(this.progress, 0, 1), 3);
      ctx.restore();
    }

    _drawBossBar(ctx, engine) {
      const boss = this.boss;
      const width = Math.min(560, engine.width - 80);
      const x = (engine.width - width) / 2;
      const y = 112;
      const ratio = MathUtils.clamp(boss.health / boss.maxHealth, 0, 1);

      ctx.save();
      ctx.fillStyle = 'rgba(8,12,22,0.78)';
      ctx.fillRect(x - 2, y - 2, width + 4, 16);

      const gradient = ctx.createLinearGradient(x, 0, x + width, 0);
      gradient.addColorStop(0, '#ff4d6d');
      gradient.addColorStop(1, '#ffd45e');
      ctx.fillStyle = gradient;
      ctx.fillRect(x, y, width * ratio, 12);

      // 阶段分隔线，让玩家能预判下一次转阶段
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      for (const phase of global.Enemy.BOSS_PHASES) {
        if (phase.at >= 1) continue;
        ctx.beginPath();
        ctx.moveTo(x + width * phase.at, y);
        ctx.lineTo(x + width * phase.at, y + 12);
        ctx.stroke();
      }

      ctx.font = '700 12px "Rajdhani", system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(`${boss.def.name}${boss.phaseName ? ` · ${boss.phaseName}` : ''}`, x + 6, y + 6);
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.ceil(boss.health)}`, x + width - 6, y + 6);
      ctx.restore();
    }

    /** HUD / 调试用 */
    snapshot() {
      return {
        wave: this.wave,
        progress: this.progress,
        timeLeft: this.timeToNextWave,
        isBossWave: this.isBossWave,
        boss: this.bossAlive
          ? {
            name: this.boss.def.name,
            health: this.boss.health,
            maxHealth: this.boss.maxHealth,
            phase: this.boss.phaseName,
          }
          : null,
      };
    }
  }

  EnemySpawner.WAVE_TABLE = WAVE_TABLE;
  EnemySpawner.EVENTS = EVENTS;
  EnemySpawner.WAVE_DURATION = WAVE_DURATION;
  EnemySpawner.BOSS_EVERY = BOSS_EVERY;
  EnemySpawner.HARD_CAP = HARD_CAP;

  global.EnemySpawner = EnemySpawner;
})(window);
