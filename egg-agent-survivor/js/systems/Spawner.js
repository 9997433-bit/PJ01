/**
 * Spawner — 随时间递增的刷怪系统
 * 敌人在相机视野外生成，强度按存活时间连续放大，并定期投放精英怪。
 */
(function (global) {
  'use strict';

  const MathUtils = global.MathUtils;

  const UNLOCKS = [
    { time: 0, type: 'grunt', weight: 10 },
    { time: 35, type: 'runner', weight: 7 },
    { time: 95, type: 'tank', weight: 4 },
  ];

  const ELITE_INTERVAL = 75;
  const MAX_ENEMIES = 230;

  class Spawner {
    constructor() {
      this.reset();
    }

    reset() {
      this.timer = 0.35;
      this.eliteTimer = ELITE_INTERVAL;
      this.wave = 1;
      this._opened = false;
    }

    get difficulty() {
      // 随时间线性增长的强度系数，供血量/伤害缩放使用
      return 1 + (this.engine ? this.engine.elapsed : 0) / 62;
    }

    update(dt, engine) {
      const elapsed = engine.elapsed;

      // 开局先撒一小波，避免前几秒空场
      if (!this._opened) {
        this._opened = true;
        for (let i = 0; i < 4; i++) this._spawn(engine, 'grunt', 1);
      }

      this.eliteTimer -= dt;
      if (this.eliteTimer <= 0) {
        this.eliteTimer = ELITE_INTERVAL;
        this._spawn(engine, 'elite', 1 + elapsed / 110);
        engine.events.emit('wave:elite', { time: elapsed });
      }

      if (engine.countByTag('enemy') >= MAX_ENEMIES) return;

      this.timer -= dt;
      if (this.timer > 0) return;

      // 刷新间隔从 0.85s 一路压到 0.14s
      const interval = MathUtils.clamp(0.85 - elapsed * 0.005, 0.14, 0.85);
      this.timer = interval * MathUtils.randRange(0.75, 1.25);

      const batch = 1 + Math.floor(elapsed / 42);
      for (let i = 0; i < batch; i++) {
        this._spawn(engine, this._pickType(elapsed), this.difficulty);
      }
    }

    _pickType(elapsed) {
      const available = UNLOCKS.filter((u) => elapsed >= u.time);
      const total = available.reduce((sum, u) => sum + u.weight, 0);
      let roll = Math.random() * total;
      for (const entry of available) {
        roll -= entry.weight;
        if (roll <= 0) return entry.type;
      }
      return 'grunt';
    }

    _spawn(engine, type, scaling) {
      const point = engine.camera.randomPointOutside(70);
      const enemy = new global.Enemy(point.x, point.y, type, scaling);
      engine.add(enemy);

      engine.particles.burst(point.x, point.y, 6, {
        colors: [enemy.def.color, '#ffffff'],
        speedMin: 20, speedMax: 90, lifeMin: 0.2, lifeMax: 0.4, size: 3,
      });
      return enemy;
    }
  }

  global.Spawner = Spawner;
})(window);
