/**
 * CollisionSystem — 战斗碰撞与范围查询
 *
 * 引擎自带的 SpatialGrid 装的是「所有实体」，而战斗里 95% 的查询只关心敌人。
 * 这里额外维护一张仅含敌人的网格：格子按当前最大体型自适应，武器选敌、
 * 群体分离、AoE 结算全部复用它，把 O(n²) 压到接近 O(n)。
 *
 * 挂到 engine.combat 上，武器与敌人 AI 通过它做查询：
 *   forEachInCircle(x, y, r, fn)        零分配遍历（fn 返回 false 提前中断）
 *   queryCircle(x, y, r, exclude)       圆形范围内的敌人数组
 *   queryCone(x, y, dir, half, range)   扇形范围
 *   nearestEnemy / strongestEnemy / randomEnemy
 *
 * 系统在实体 update 之前运行，因此判定用的是上一帧末的位置 —— 60fps 下
 * 一帧的滞后不可感知，换来的是「查询与结算共用同一份网格」的简洁。
 */
(function (global) {
  'use strict';

  const DEFAULT_CELL = 72;

  class CollisionSystem {
    constructor(options = {}) {
      this.cellSize = options.cellSize || DEFAULT_CELL;
      this.cells = new Map();
      this.enemies = [];
      this.projectiles = [];
      this.maxRadius = 0;
      this.checksThisFrame = 0;
      this.engine = null;
      this._scratch = [];
    }

    onAdd(engine) {
      this.engine = engine;
      engine.combat = this;
      engine.magnetAll = false;
      engine.magnetTimer = 0;
    }

    reset(engine) {
      this.cells.clear();
      this.enemies.length = 0;
      this.projectiles.length = 0;
      this.maxRadius = 0;
      const target = engine || this.engine;
      if (target) {
        target.magnetAll = false;
        target.magnetTimer = 0;
      }
    }

    /* ================= 网格 ================= */

    _key(cx, cy) { return cx * 73856093 ^ cy * 19349663; }

    /** 从引擎实体表里挑出敌人与弹道，同时重建敌人网格 */
    _rebuild(engine) {
      const enemies = this.enemies;
      const projectiles = this.projectiles;
      enemies.length = 0;
      projectiles.length = 0;
      this.cells.clear();
      this.maxRadius = 0;

      const cs = this.cellSize;
      const entities = engine.entities;
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        if (e.dead) continue;
        if (e.tag === 'enemy') {
          enemies.push(e);
          if (e.radius > this.maxRadius) this.maxRadius = e.radius;
          const key = this._key(Math.floor(e.position.x / cs), Math.floor(e.position.y / cs));
          let bucket = this.cells.get(key);
          if (!bucket) { bucket = []; this.cells.set(key, bucket); }
          bucket.push(e);
        } else if (e.tag === 'projectile') {
          projectiles.push(e);
        }
      }
    }

    /**
     * 遍历圆内敌人。fn(enemy, distance)，返回 false 可提前中断。
     * 判定包含敌人自身半径，所以「圆边缘擦到大体型」也算命中。
     */
    forEachInCircle(x, y, radius, fn) {
      const cs = this.cellSize;
      // 向外多扫一圈最大体型，否则中心在格外、身体探进来的大怪会漏判
      const pad = radius + this.maxRadius;
      const minX = Math.floor((x - pad) / cs);
      const maxX = Math.floor((x + pad) / cs);
      const minY = Math.floor((y - pad) / cs);
      const maxY = Math.floor((y + pad) / cs);

      for (let cy = minY; cy <= maxY; cy++) {
        for (let cx = minX; cx <= maxX; cx++) {
          const bucket = this.cells.get(this._key(cx, cy));
          if (!bucket) continue;
          for (let i = 0; i < bucket.length; i++) {
            const enemy = bucket[i];
            if (enemy.dead) continue;
            const dx = enemy.position.x - x;
            const dy = enemy.position.y - y;
            const distSq = dx * dx + dy * dy;
            const reach = radius + enemy.radius;
            this.checksThisFrame++;
            if (distSq > reach * reach) continue;
            if (fn(enemy, Math.sqrt(distSq)) === false) return;
          }
        }
      }
    }

    queryCircle(x, y, radius, exclude) {
      const out = [];
      this.forEachInCircle(x, y, radius, (enemy) => {
        if (enemy !== exclude) out.push(enemy);
      });
      return out;
    }

    /** 扇形查询：direction 为中心方向，halfAngle 为半张角 */
    queryCone(x, y, direction, halfAngle, range) {
      const out = [];
      const cosHalf = Math.cos(halfAngle);
      const dirX = Math.cos(direction);
      const dirY = Math.sin(direction);

      this.forEachInCircle(x, y, range, (enemy, d) => {
        if (d < 1e-3) { out.push(enemy); return; }
        const nx = (enemy.position.x - x) / d;
        const ny = (enemy.position.y - y) / d;
        // 大体型在近距离时给一点角度宽容，避免贴脸反而打不到
        const tolerance = Math.min(0.6, enemy.radius / Math.max(d, 1));
        if (nx * dirX + ny * dirY >= cosHalf - tolerance) out.push(enemy);
      });
      return out;
    }

    nearestEnemy(x, y, radius, filter) {
      let best = null;
      let bestDist = Infinity;
      this.forEachInCircle(x, y, radius || 600, (enemy, d) => {
        if (filter && !filter(enemy)) return;
        if (d < bestDist) { bestDist = d; best = enemy; }
      });
      return best;
    }

    /** 血量最高的目标：让高伤单体武器优先照顾坦克与 Boss */
    strongestEnemy(x, y, radius, filter) {
      let best = null;
      let bestHealth = -1;
      this.forEachInCircle(x, y, radius || 600, (enemy) => {
        if (filter && !filter(enemy)) return;
        if (enemy.health > bestHealth) { bestHealth = enemy.health; best = enemy; }
      });
      return best;
    }

    randomEnemy(x, y, radius, filter) {
      const list = this._scratch;
      list.length = 0;
      this.forEachInCircle(x, y, radius || 600, (enemy) => {
        if (!filter || filter(enemy)) list.push(enemy);
      });
      return list.length ? list[(Math.random() * list.length) | 0] : null;
    }

    get enemyCount() { return this.enemies.length; }

    /* ================= 每帧结算 ================= */

    update(dt, engine) {
      this.checksThisFrame = 0;
      this._rebuild(engine);

      this._updateMagnet(dt, engine);
      this._resolveProjectiles(engine);
      this._resolveContact(engine);
    }

    /** 全图吸取是限时的，计时结束后恢复正常拾取半径 */
    _updateMagnet(dt, engine) {
      if (!engine.magnetAll) return;
      engine.magnetTimer -= dt;
      if (engine.magnetTimer <= 0) engine.magnetAll = false;
    }

    _resolveProjectiles(engine) {
      const now = engine.elapsed;
      const player = engine.player;
      const projectiles = this.projectiles;

      for (let i = 0; i < projectiles.length; i++) {
        const p = projectiles[i];
        if (p.dead) continue;

        if (p.faction === 'enemy') {
          if (!player || !player.isAlive) continue;
          const rr = player.radius + p.radius;
          if (player.position.distanceSqTo(p.position) <= rr * rr) {
            const dealt = player.takeDamage(p.damage, { source: p });
            // 无敌帧内命中不消耗弹道，否则冲刺穿弹幕会白嫖掉一整轮
            if (dealt > 0) {
              engine.particles.burst(p.position.x, p.position.y, 8, {
                colors: [p.color, '#ffffff'],
                speedMin: 50, speedMax: 200, lifeMin: 0.12, lifeMax: 0.3,
              });
              p.dead = true;
            }
          }
          continue;
        }

        let destroyed = false;
        this.forEachInCircle(p.position.x, p.position.y, p.radius, (enemy, d) => {
          if (destroyed) return false;
          if (d > p.radius + enemy.radius) return;
          if (!p.canHit(enemy, now)) return;

          const angle = Math.atan2(
            enemy.position.y - p.position.y,
            enemy.position.x - p.position.x
          );
          // 演出层在场时由它统一出飘字，跟武器直伤的样式保持一致
          const juice = engine.juice;
          const combo = engine.combo;
          if (combo) combo.pendingSource = p.weaponId || null;

          const dealt = enemy.takeDamage(p.damage, {
            knockback: p.knockback,
            angle,
            critical: p.critical,
            silent: !!juice,
            source: p.weaponId,
          });

          if (combo) combo.pendingSource = null;
          if (juice && dealt > 0) {
            juice.hit(enemy, dealt, { critical: p.critical, kill: enemy.dead });
          }

          if (p.burn) enemy.applyBurn(p.burn.dps, p.burn.duration);
          if (p.slow) enemy.applySlow(p.slow.mult, p.slow.duration);
          if (p.onHit) p.onHit(p, enemy, engine);
          if (engine.weapons) engine.weapons.reportDamage(p.weaponId, dealt);

          if (p.critical) engine.camera.addTrauma(0.04);
          if (engine.audio) engine.audio.play(p.critical ? 'crit' : 'hit');

          if (p.registerHit(enemy, now)) { destroyed = true; return false; }
        });

        if (destroyed) p.dead = true;
      }
    }

    /** 敌人接触玩家：每只怪独立冷却，避免同一帧被十几只同时啃穿 */
    _resolveContact(engine) {
      const player = engine.player;
      if (!player || !player.isAlive) return;

      this.forEachInCircle(player.position.x, player.position.y, player.radius, (enemy, d) => {
        if (!enemy.canTouch) return;
        if (enemy.contactTimer > 0) return;
        if (d > player.radius + enemy.radius) return;

        enemy.contactTimer = enemy.def.contactCooldown;
        const dealt = player.takeDamage(enemy.damage, { source: enemy });
        if (dealt <= 0) return;

        // 反向轻推敌人，避免它继续贴模造成连击
        const angle = Math.atan2(
          enemy.position.y - player.position.y,
          enemy.position.x - player.position.x
        );
        const push = 150 * (1 - enemy.kbResist);
        enemy.knockback.x += Math.cos(angle) * push;
        enemy.knockback.y += Math.sin(angle) * push;

        const thorns = player.stats.thorns || 0;
        if (thorns > 0) {
          enemy.takeDamage(thorns, { source: 'thorns', angle, knockback: 90 });
        }
      });
    }

    /* ================= 调试 ================= */

    drawWorld(ctx, engine) {
      if (!engine.debugCollision) return;
      const cs = this.cellSize;
      ctx.save();
      ctx.strokeStyle = 'rgba(107,255,184,0.22)';
      ctx.lineWidth = 1;
      for (const bucket of this.cells.values()) {
        if (!bucket.length) continue;
        const cx = Math.floor(bucket[0].position.x / cs);
        const cy = Math.floor(bucket[0].position.y / cs);
        ctx.strokeRect(cx * cs, cy * cs, cs, cs);
      }
      ctx.restore();
    }
  }

  global.CollisionSystem = CollisionSystem;
})(window);
