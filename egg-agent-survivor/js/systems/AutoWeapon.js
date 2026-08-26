/**
 * WeaponSystem — 自动瞄准最近敌人的主武器
 * 数值集中在 `weapon`，升级卡片直接修改这些字段即可。
 */
(function (global) {
  'use strict';

  const Vector2 = global.Vector2;

  const DEFAULT_WEAPON = {
    damage: 11,
    cooldown: 0.62,
    projectileSpeed: 560,
    projectileCount: 1,
    spread: 0.22,     // 多发时的夹角（弧度）
    pierce: 0,
    critChance: 0.08,
    range: 520,
  };

  class WeaponSystem {
    constructor() {
      this.weapon = Object.assign({}, DEFAULT_WEAPON);
      this.timer = 0;
    }

    reset() {
      this.weapon = Object.assign({}, DEFAULT_WEAPON);
      this.timer = 0;
    }

    update(dt, engine) {
      const player = engine.player;
      if (!player || !player.isAlive) return;

      this.timer -= dt;
      if (this.timer > 0) return;

      const target = engine.grid.findNearest(
        player.position,
        this.weapon.range,
        (e) => e.tag === 'enemy' && !e.dead
      );
      if (!target) return;

      this.timer = this.weapon.cooldown * player.stats.cooldownMultiplier;
      this._fire(engine, player, target);
    }

    _fire(engine, player, target) {
      const w = this.weapon;
      const baseDir = target.position.sub(player.position).normalizeSelf();
      const baseAngle = baseDir.angle();
      const count = Math.max(1, Math.round(w.projectileCount));

      for (let i = 0; i < count; i++) {
        const offset = count === 1 ? 0 : (i - (count - 1) / 2) * w.spread;
        const dir = Vector2.fromAngle(baseAngle + offset);
        const muzzle = player.position.add(dir.scale(player.radius + 6));

        engine.add(new global.Projectile(muzzle.x, muzzle.y, dir, {
          damage: w.damage * player.stats.damageMultiplier,
          speed: w.projectileSpeed,
          pierce: w.pierce,
          critChance: w.critChance,
          radius: 6,
        }));
      }

      engine.particles.burst(
        player.position.x + baseDir.x * player.radius,
        player.position.y + baseDir.y * player.radius,
        4,
        {
          colors: ['#7cf9ff', '#ffffff'],
          speedMin: 40, speedMax: 150, lifeMin: 0.1, lifeMax: 0.22,
          angle: baseAngle, spread: 0.9, size: 3,
        }
      );
    }
  }

  WeaponSystem.DEFAULT_WEAPON = DEFAULT_WEAPON;
  global.WeaponSystem = WeaponSystem;
})(window);
