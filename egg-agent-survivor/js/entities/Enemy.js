/**
 * Enemy — 敌人实体与类型注册表
 *
 * 设计要点：
 * 1. 所有敌人共用一个类，差异由 ENEMY_TYPES 的「数据 + 行为函数」驱动，
 *    新增怪种只写一条表项，不动逻辑。
 * 2. 追击用 steering 而不是硬寻路：期望速度 = 类型行为 + 群体分离，
 *    再按质量做加速度平滑，重甲蛋转向迟钝、突击蛋灵活。
 * 3. 数值随波次成长统一走 Enemy.scaleFor(wave)，避免魔法数字散落各处。
 * 4. 击退是独立于速度的叠加分量，指数衰减，不会破坏 AI 的期望速度。
 *
 * 接触伤害与弹道命中由 CollisionSystem 统一结算，这里只负责
 * 「自己怎么动、怎么死、怎么画」。
 */
(function (global) {
  'use strict';

  const Vector2 = global.Vector2;
  const MathUtils = global.MathUtils;
  const TAU = Math.PI * 2;

  /**
   * 类型字段：
   *   health/speed/damage/radius  1 波时的基础值
   *   xp                          掉落经验基数
   *   armor                       固定减伤（在倍率之后结算）
   *   kbResist                    击退抗性 0~1
   *   mass                        分离权重与转向惯性
   *   contactCooldown             对玩家造成接触伤害的间隔
   *   behavior(enemy, dt, engine) 写入 enemy.desired（期望速度）
   *   drawBody(enemy, ctx, r)     本体绘制（已平移到实体中心）
   */
  const ENEMY_TYPES = {

    /* 杂兵蛋：最基础的直线追击 */
    grunt: {
      key: 'grunt', name: '杂兵蛋',
      health: 22, speed: 78, damage: 9, radius: 15, xp: 4,
      armor: 0, kbResist: 0, mass: 1, contactCooldown: 0.6,
      color: '#ff6b8a', accent: '#ffd0da',
      behavior: seekPlayer,
      drawBody: drawEggShape,
    },

    /* 突击蛋：低血高速，周期性冲刺切入 */
    runner: {
      key: 'runner', name: '突击蛋',
      health: 14, speed: 140, damage: 7, radius: 12, xp: 5,
      armor: 0, kbResist: 0, mass: 0.7, contactCooldown: 0.45,
      color: '#ffd45e', accent: '#fff2c4',
      behavior(enemy, dt, engine) {
        enemy.timer -= dt;
        if (enemy.timer <= 0 && enemy.dashTime <= 0) {
          enemy.timer = MathUtils.randRange(1.5, 2.8);
          enemy.dashTime = 0.4;
          // 冲刺方向带一点随机偏移，避免整群怪挤成一条直线
          enemy.dashDir = enemy.angleToPlayer(engine) + MathUtils.randRange(-0.28, 0.28);
        }
        if (enemy.dashTime > 0) {
          enemy.dashTime -= dt;
          const speed = enemy.speed * 2.4;
          enemy.desired.set(Math.cos(enemy.dashDir) * speed, Math.sin(enemy.dashDir) * speed);
          enemy.emitTrail(engine, dt, 0.045);
          return;
        }
        seekPlayer(enemy, dt, engine);
      },
      drawBody(enemy, ctx, r) {
        // 沿速度方向拉成飞镖形
        const angle = enemy.velocity.lengthSq() > 1 ? enemy.velocity.angle() : 0;
        ctx.rotate(angle + Math.PI / 2);
        ctx.beginPath();
        ctx.moveTo(0, -r * 1.4);
        ctx.lineTo(r * 0.86, r * 0.9);
        ctx.lineTo(0, r * 0.42);
        ctx.lineTo(-r * 0.86, r * 0.9);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      },
    },

    /* 孵化崽：成群出现，单体极弱，靠数量制造压迫 */
    swarm: {
      key: 'swarm', name: '孵化崽',
      health: 7, speed: 96, damage: 5, radius: 9, xp: 2,
      armor: 0, kbResist: 0, mass: 0.45, contactCooldown: 0.5,
      color: '#6bffb8', accent: '#d6fff0',
      behavior(enemy, dt, engine) {
        seekPlayer(enemy, dt, engine);
        // 轻微蛇形，让虫群看起来在「涌动」而不是整齐平移
        const wobble = Math.sin(enemy.age * 6 + enemy.seed * TAU) * 0.9;
        rotateInPlace(enemy.desired, wobble * dt);
      },
      drawBody: drawEggShape,
    },

    /* 重甲蛋：厚甲肉盾，几乎免疫击退 */
    tank: {
      key: 'tank', name: '重甲蛋',
      health: 105, speed: 54, damage: 18, radius: 25, xp: 16,
      armor: 3, kbResist: 0.8, mass: 3.4, contactCooldown: 0.8,
      color: '#b78bff', accent: '#e6d6ff',
      behavior: seekPlayer,
      drawBody(enemy, ctx, r) {
        drawEggShape(enemy, ctx, r);
        // 铆钉装甲带
        ctx.save();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = 'rgba(20,12,40,0.75)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.ellipse(0, r * 0.1, r * 0.88, r * 0.46, 0, 0, TAU);
        ctx.stroke();
        ctx.fillStyle = enemy.def.accent;
        for (let i = 0; i < 5; i++) {
          const a = -0.5 + i * 0.5;
          ctx.beginPath();
          ctx.arc(Math.cos(a) * r * 0.88, r * 0.1 + Math.sin(a) * r * 0.46, 1.9, 0, TAU);
          ctx.fill();
        }
        ctx.restore();
      },
    },

    /* 酸液蛋：远程单位，维持距离并抛射酸弹 */
    spitter: {
      key: 'spitter', name: '酸液蛋',
      health: 28, speed: 62, damage: 11, radius: 15, xp: 9,
      armor: 0, kbResist: 0.15, mass: 1.1, contactCooldown: 0.7,
      color: '#7cff6b', accent: '#e0ffd6',
      preferredRange: 250,
      behavior(enemy, dt, engine) {
        const distance = enemy.position.distanceTo(engine.player.position);
        const range = enemy.def.preferredRange;
        const toPlayer = enemy.angleToPlayer(engine);

        // 近了后退、远了前进、区间内绕圈走位
        let move;
        if (distance < range * 0.7) move = toPlayer + Math.PI;
        else if (distance > range * 1.15) move = toPlayer;
        else move = toPlayer + (enemy.seed > 0.5 ? 1 : -1) * Math.PI * 0.5;
        enemy.desired.set(Math.cos(move) * enemy.speed, Math.sin(move) * enemy.speed);

        enemy.timer -= dt;
        if (enemy.timer <= 0 && enemy.windup <= 0 && distance < range * 1.5) {
          enemy.timer = MathUtils.randRange(2.2, 3.4);
          enemy.windup = 0.5;
        }
        if (enemy.windup > 0) {
          enemy.windup -= dt;
          enemy.desired.scaleSelf(0.25);   // 蓄力时几乎站住，给玩家反应窗口
          if (enemy.windup <= 0) enemy.fireAcid(engine);
        }
      },
      drawBody(enemy, ctx, r) {
        drawEggShape(enemy, ctx, r);
        if (enemy.windup > 0) {
          const charge = 1 - enemy.windup / 0.5;
          ctx.fillStyle = '#eaffe4';
          ctx.beginPath();
          ctx.arc(0, r * 0.5, 2 + charge * 4.5, 0, TAU);
          ctx.fill();
        }
      },
    },

    /* 爆裂蛋：不做接触伤害，贴近后引爆 */
    bomber: {
      key: 'bomber', name: '爆裂蛋',
      health: 34, speed: 82, damage: 0, radius: 16, xp: 10,
      armor: 0, kbResist: 0.1, mass: 1.2, contactCooldown: 999,
      color: '#ff8a3d', accent: '#ffd9b8',
      blastRadius: 92, blastDamage: 26,
      behavior(enemy, dt, engine) {
        seekPlayer(enemy, dt, engine);
        const distance = enemy.position.distanceTo(engine.player.position);
        if (enemy.fuse <= 0 && distance < enemy.def.blastRadius * 0.6) {
          enemy.fuse = 0.8;
          if (engine.audio) engine.audio.play('fuse');
        }
        if (enemy.fuse > 0) {
          enemy.fuse -= dt;
          enemy.desired.scaleSelf(0.4);
          if (enemy.fuse <= 0) enemy.kill();
        }
      },
      onDeath(enemy, engine) {
        const def = enemy.def;
        const radius = def.blastRadius * (enemy.elite ? 1.4 : 1);

        engine.particles.shockwave(enemy.position.x, enemy.position.y, {
          size: 14, endSize: radius * 2, color: def.color, life: 0.45,
        });
        engine.particles.burst(enemy.position.x, enemy.position.y, 28, {
          colors: [def.color, def.accent, '#ffffff'],
          speedMin: 120, speedMax: 460, lifeMin: 0.25, lifeMax: 0.65, drag: 0.88,
        });
        engine.camera.addTrauma(0.34);

        const player = engine.player;
        if (player && player.isAlive
          && player.position.distanceTo(enemy.position) < radius + player.radius) {
          player.takeDamage(def.blastDamage * enemy.damageScale, { source: enemy, knockback: 260 });
        }

        // 也会波及友军，密集时能打出连锁爆炸
        const combat = engine.combat;
        if (!combat) return;
        for (const other of combat.queryCircle(enemy.position.x, enemy.position.y, radius)) {
          if (other === enemy) continue;
          other.takeDamage(def.blastDamage * 0.7, { source: 'blast', knockback: 240 });
        }
      },
      drawBody(enemy, ctx, r) {
        if (enemy.fuse > 0) {
          const pulse = 1 + Math.sin(enemy.age * 42) * 0.14;
          ctx.scale(pulse, pulse);
        }
        drawEggShape(enemy, ctx, r);
        if (enemy.fuse > 0 && Math.sin(enemy.age * 42) > 0) {
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          ctx.beginPath();
          ctx.ellipse(0, 0, r * 0.9, r * 1.05, 0, 0, TAU);
          ctx.fill();
        }
      },
    },

    /* 蛋皇：多阶段 Boss */
    boss: {
      key: 'boss', name: '蛋皇',
      health: 1200, speed: 52, damage: 28, radius: 52, xp: 260,
      armor: 6, kbResist: 0.95, mass: 12, contactCooldown: 1.0,
      color: '#ff4d6d', accent: '#ffd45e',
      isBoss: true,
      behavior: bossBehavior,
      drawBody: drawBossShape,
    },
  };

  /** 精英词缀：叠加在基础类型上 */
  const ELITE = {
    healthMul: 4.5, damageMul: 1.5, speedMul: 0.94, radiusMul: 1.35, xpMul: 5,
    tint: '#ffd45e',
  };

  /* ------------------------------------------------------------------ *
   * 行为辅助
   * ------------------------------------------------------------------ */

  function rotateInPlace(v, radians) {
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    const x = v.x * c - v.y * s;
    v.y = v.x * s + v.y * c;
    v.x = x;
  }

  /** 默认追击 */
  function seekPlayer(enemy, dt, engine) {
    const angle = enemy.angleToPlayer(engine);
    enemy.desired.set(Math.cos(angle) * enemy.speed, Math.sin(angle) * enemy.speed);
  }

  /* ---------------- Boss 阶段机 ---------------- */

  const BOSS_PHASES = [
    { at: 1.00, name: '压迫', speedMul: 1.00, casts: ['summon', 'radial'] },
    { at: 0.66, name: '狂怒', speedMul: 1.16, casts: ['radial', 'charge', 'summon'] },
    { at: 0.32, name: '崩壳', speedMul: 1.34, casts: ['spiral', 'charge', 'radial'] },
  ];

  function bossBehavior(enemy, dt, engine) {
    const ratio = enemy.health / enemy.maxHealth;
    let phase = BOSS_PHASES[0];
    for (const p of BOSS_PHASES) if (ratio <= p.at) phase = p;

    if (enemy.phaseName !== phase.name) {
      enemy.phaseName = phase.name;
      enemy.castIndex = 0;
      enemy.invulnerable = 0.7;
      engine.camera.addTrauma(0.6);
      engine.particles.shockwave(enemy.position.x, enemy.position.y, {
        size: enemy.radius, endSize: enemy.radius * 7, color: enemy.def.accent, life: 0.7,
      });
      if (engine.hud) engine.hud.showBanner(`${enemy.def.name} · ${phase.name}`, '阶段转换');
      if (engine.audio) engine.audio.play('bossPhase');
    }

    if (enemy.castTime > 0) {
      enemy.castTime -= dt;
      runBossCast(enemy, dt, engine);
      if (enemy.castTime <= 0) { enemy.cast = null; enemy.castFired = false; }
      return;
    }

    seekPlayer(enemy, dt, engine);
    enemy.desired.scaleSelf(phase.speedMul);

    enemy.timer -= dt;
    if (enemy.timer <= 0) {
      enemy.cast = phase.casts[enemy.castIndex % phase.casts.length];
      enemy.castIndex++;
      enemy.castTime = enemy.cast === 'charge' ? 1.9 : 1.5;
      enemy.castElapsed = 0;
      enemy.castTick = 0;
      enemy.castFired = false;
      enemy.timer = MathUtils.randRange(2.4, 3.4);
      if (enemy.cast === 'charge') enemy.dashDir = enemy.angleToPlayer(engine);
    }
  }

  function runBossCast(enemy, dt, engine) {
    enemy.castElapsed += dt;
    const elapsed = enemy.castElapsed;

    switch (enemy.cast) {
      case 'summon': {
        enemy.desired.set(0, 0);
        enemy.castTick -= dt;
        if (enemy.castTick <= 0 && elapsed > 0.45 && engine.spawner) {
          enemy.castTick = 0.16;
          const angle = Math.random() * TAU;
          const radius = enemy.radius + 34;
          engine.spawner.spawnAt(
            enemy.position.x + Math.cos(angle) * radius,
            enemy.position.y + Math.sin(angle) * radius,
            Math.random() < 0.6 ? 'swarm' : 'grunt'
          );
        }
        break;
      }
      case 'radial': {
        enemy.desired.set(0, 0);
        if (elapsed >= 0.85 && !enemy.castFired) {
          enemy.castFired = true;
          const count = 20;
          const offset = Math.random() * TAU;
          for (let i = 0; i < count; i++) {
            enemy.fireBullet(engine, offset + (i / count) * TAU, 220, 14);
          }
          engine.camera.addTrauma(0.25);
        }
        break;
      }
      case 'spiral': {
        enemy.desired.set(0, 0);
        enemy.castTick -= dt;
        if (enemy.castTick <= 0 && elapsed > 0.35) {
          enemy.castTick = 0.07;
          enemy.spiralAngle += 0.44;
          for (let arm = 0; arm < 3; arm++) {
            enemy.fireBullet(engine, enemy.spiralAngle + (arm / 3) * TAU, 200, 12);
          }
        }
        break;
      }
      case 'charge': {
        if (elapsed < 0.7) {
          // 蓄力：微微后仰并缓慢修正朝向，给玩家一个可读的预警窗口
          enemy.desired.set(Math.cos(enemy.dashDir) * -50, Math.sin(enemy.dashDir) * -50);
          const want = enemy.angleToPlayer(engine);
          let diff = want - enemy.dashDir;
          while (diff > Math.PI) diff -= TAU;
          while (diff < -Math.PI) diff += TAU;
          enemy.dashDir += diff * Math.min(1, dt * 2.2);
        } else {
          const speed = enemy.speed * 4.4;
          enemy.desired.set(Math.cos(enemy.dashDir) * speed, Math.sin(enemy.dashDir) * speed);
          enemy.emitTrail(engine, dt, 0.03);
        }
        break;
      }
      default:
        enemy.desired.set(0, 0);
    }
  }

  /* ------------------------------------------------------------------ *
   * 绘制
   * ------------------------------------------------------------------ */

  /** 会呼吸的蛋型轮廓（上窄下宽，两段贝塞尔） */
  function drawEggShape(enemy, ctx, r) {
    const squash = 1 + Math.sin(enemy.age * 5 + enemy.seed * TAU) * 0.06;
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.16 * squash);
    ctx.bezierCurveTo(r * 1.05, -r * 0.7, r * 1.02, r * 0.5, 0, r * squash);
    ctx.bezierCurveTo(-r * 1.02, r * 0.5, -r * 1.05, -r * 0.7, 0, -r * 1.16 * squash);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  function drawBossShape(enemy, ctx, r) {
    // 外层能量环
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = enemy.def.accent;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, r + 12 + Math.sin(enemy.age * 2) * 5, 0, TAU);
    ctx.stroke();
    ctx.restore();

    drawEggShape(enemy, ctx, r);

    // 王冠
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.fillStyle = enemy.def.accent;
    ctx.strokeStyle = '#7a5a12';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-r * 0.5, -r * 0.92);
    ctx.lineTo(-r * 0.5, -r * 1.3);
    ctx.lineTo(-r * 0.22, -r * 1.06);
    ctx.lineTo(0, -r * 1.5);
    ctx.lineTo(r * 0.22, -r * 1.06);
    ctx.lineTo(r * 0.5, -r * 1.3);
    ctx.lineTo(r * 0.5, -r * 0.92);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // 冲锋预警线
    if (enemy.cast === 'charge' && enemy.castElapsed < 0.7) {
      ctx.save();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 0.35 + Math.sin(enemy.age * 26) * 0.25;
      ctx.strokeStyle = '#ff4d6d';
      ctx.lineWidth = 5;
      ctx.setLineDash([18, 12]);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(enemy.dashDir) * 520, Math.sin(enemy.dashDir) * 520);
      ctx.stroke();
      ctx.restore();
    }
  }

  /* ------------------------------------------------------------------ *
   * Enemy
   * ------------------------------------------------------------------ */

  class Enemy extends global.Entity {
    /**
     * @param {number} x
     * @param {number} y
     * @param {string} typeKey
     * @param {number} wave      当前波次，决定成长倍率
     * @param {object} [options] { elite:boolean, healthMul:number }
     */
    constructor(x, y, typeKey = 'grunt', wave = 1, options = {}) {
      const def = ENEMY_TYPES[typeKey] || ENEMY_TYPES.grunt;
      const elite = !!options.elite && !def.isBoss;
      const radius = def.radius * (elite ? ELITE.radiusMul : 1);

      super(x, y, { radius, tag: 'enemy', layer: global.Layer.ACTOR });

      const scale = Enemy.scaleFor(wave);
      this.typeKey = def.key;
      this.def = def;
      this.elite = elite;

      this.maxHealth = def.health * scale.health
        * (elite ? ELITE.healthMul : 1) * (options.healthMul || 1);
      this.health = this.maxHealth;
      this.speed = def.speed * scale.speed * (elite ? ELITE.speedMul : 1);
      this.damageScale = scale.damage * (elite ? ELITE.damageMul : 1);
      this.damage = def.damage * this.damageScale;
      this.armor = def.armor;
      this.kbResist = def.kbResist;
      this.mass = def.mass * (elite ? ELITE.radiusMul : 1);
      this.xpValue = Math.max(1, Math.round(def.xp * (elite ? ELITE.xpMul : 1)));

      this.desired = new Vector2(0, 0);
      this.knockback = new Vector2(0, 0);

      this.contactTimer = 0;
      this.hitFlash = 0;
      this.invulnerable = 0;
      this.spawnAnim = 0;
      this.spawnGuard = def.isBoss ? 0.9 : 0.3;   // 出生保护期内不咬人
      this.seed = Math.random();
      this.timer = MathUtils.randRange(0.3, 1.6);

      // 状态效果
      this.burn = null;
      this.slow = null;
      this.stun = 0;

      // 类型专属运行时字段
      this.dashTime = 0;
      this.dashDir = 0;
      this.trailTimer = 0;
      this.windup = 0;
      this.fuse = 0;
      this.cast = null;
      this.castTime = 0;
      this.castElapsed = 0;
      this.castTick = 0;
      this.castIndex = 0;
      this.castFired = false;
      this.phaseName = null;
      this.spiralAngle = 0;
    }

    /** 波次成长：二次项让后期真正吃力，前 5 波保持友好 */
    static scaleFor(wave) {
      const w = Math.max(0, wave - 1);
      return {
        health: 1 + 0.17 * w + 0.014 * w * w,
        damage: 1 + 0.08 * w,
        speed: 1 + Math.min(0.34, 0.012 * w),
      };
    }

    get isBoss() { return !!this.def.isBoss; }
    get isAlive() { return !this.dead && this.health > 0; }
    get healthPercent() { return MathUtils.clamp(this.health / this.maxHealth, 0, 1); }
    /** 出生保护期结束前不参与接触伤害 */
    get canTouch() { return this.spawnGuard <= 0 && this.damage > 0; }

    angleToPlayer(engine) {
      const target = engine.player.position;
      return Math.atan2(target.y - this.position.y, target.x - this.position.x);
    }

    /* ================= 更新 ================= */

    update(dt, engine) {
      this.age += dt;
      this.spawnAnim = Math.min(1, this.spawnAnim + dt * 4.5);
      this.spawnGuard = Math.max(0, this.spawnGuard - dt);
      this.hitFlash = Math.max(0, this.hitFlash - dt * 4);
      this.contactTimer = Math.max(0, this.contactTimer - dt);
      this.invulnerable = Math.max(0, this.invulnerable - dt);

      this._updateStatus(dt, engine);

      const player = engine.player;
      if (!player || !player.isAlive) {
        // 玩家已死：原地慢慢停下，别继续追一具尸体
        this.velocity.scaleSelf(Math.pow(0.02, dt));
        this.position.addScaledSelf(this.velocity, dt);
        return;
      }

      if (this.stun > 0) {
        this.stun -= dt;
        this.desired.set(0, 0);
      } else {
        this.def.behavior(this, dt, engine);
      }

      if (this.slow) this.desired.scaleSelf(this.slow.mult);

      this._applySeparation(engine);

      // 期望速度 → 实际速度：质量越大转向越迟钝
      const accel = 9.5 / Math.max(0.55, this.mass * 0.34);
      const t = 1 - Math.exp(-accel * dt);
      this.velocity.x += (this.desired.x - this.velocity.x) * t;
      this.velocity.y += (this.desired.y - this.velocity.y) * t;

      if (!this.knockback.isZero()) {
        this.position.addScaledSelf(this.knockback, dt);
        this.knockback.scaleSelf(Math.pow(0.0016, dt));
        if (this.knockback.lengthSq() < 4) this.knockback.set(0, 0);
      }

      this.position.addScaledSelf(this.velocity, dt);
    }

    _updateStatus(dt, engine) {
      if (this.burn) {
        this.burn.time -= dt;
        this.burn.tick -= dt;
        if (this.burn.tick <= 0) {
          this.burn.tick = 0.25;
          this.takeDamage(this.burn.dps * 0.25, { silent: true, noFlash: true, source: 'burn' });
          engine.particles.emit({
            x: this.position.x + MathUtils.randRange(-6, 6),
            y: this.position.y + MathUtils.randRange(-6, 6),
            vy: -MathUtils.randRange(30, 70),
            life: 0.32, size: 3.4, color: '#ff9d3d', drag: 0.9,
          });
        }
        if (this.burn.time <= 0) this.burn = null;
      }
      if (this.slow) {
        this.slow.time -= dt;
        if (this.slow.time <= 0) this.slow = null;
      }
    }

    /** 邻域推挤，避免所有敌人叠成一个点 */
    _applySeparation(engine) {
      const combat = engine.combat;
      if (!combat) return;

      let pushX = 0;
      let pushY = 0;
      let count = 0;

      combat.forEachInCircle(this.position.x, this.position.y, this.radius * 2.1, (other, d) => {
        if (other === this) return;
        const minDistance = this.radius + other.radius;
        if (d > minDistance || d < 1e-3) return;
        const overlap = (minDistance - d) / minDistance;
        // 轻的被推得更远，重甲蛋几乎不动
        const weight = overlap * (other.mass / (other.mass + this.mass)) * 2;
        pushX += ((this.position.x - other.position.x) / d) * weight;
        pushY += ((this.position.y - other.position.y) / d) * weight;
        count++;
      });

      if (count > 0) {
        this.desired.x += pushX * this.speed * 1.5;
        this.desired.y += pushY * this.speed * 1.5;
      }
    }

    emitTrail(engine, dt, interval) {
      this.trailTimer -= dt;
      if (this.trailTimer > 0) return;
      this.trailTimer = interval;
      engine.particles.emit({
        x: this.position.x, y: this.position.y,
        vx: -this.velocity.x * 0.12, vy: -this.velocity.y * 0.12,
        life: 0.28, size: this.radius * 0.5, color: this.def.color,
        drag: 0.88, shape: 'spark', stretch: 1.5,
      });
    }

    /* ================= 攻击 ================= */

    fireBullet(engine, angle, speed, damage) {
      engine.add(new global.Projectile({
        x: this.position.x + Math.cos(angle) * this.radius * 0.7,
        y: this.position.y + Math.sin(angle) * this.radius * 0.7,
        angle,
        speed,
        damage: damage * this.damageScale,
        radius: 8,
        faction: 'enemy',
        kind: 'orb',
        life: 4.5,
        color: this.def.accent,
      }));
    }

    fireAcid(engine) {
      this.fireBullet(engine, this.angleToPlayer(engine), 280, this.def.damage);
      engine.particles.burst(this.position.x, this.position.y, 6, {
        colors: [this.def.color, this.def.accent],
        speedMin: 40, speedMax: 140, lifeMin: 0.15, lifeMax: 0.35,
      });
      if (engine.audio) engine.audio.play('spit');
    }

    /* ================= 受伤与死亡 ================= */

    /**
     * @param {number} amount
     * @param {object} [options]
     *   knockback   击退强度
     *   angle       击退方向（弧度）
     *   direction   击退方向（Vector2，与 angle 二选一）
     *   critical    是否暴击
     *   stun        眩晕秒数
     *   silent      不弹伤害数字（持续伤害用）
     *   noFlash     不闪白
     *   ignoreArmor 无视护甲
     * @returns {number} 实际造成的伤害
     */
    takeDamage(amount, options = {}) {
      if (this.dead || this.invulnerable > 0) return 0;

      // 护甲按固定值减，但至少保留 15%，避免高护甲完全免疫小额伤害
      const dealt = options.ignoreArmor
        ? amount
        : Math.max(amount * 0.15, amount - this.armor);
      if (dealt <= 0) return 0;

      this.health -= dealt;
      if (!options.noFlash) this.hitFlash = 1;

      const engine = this.engine;
      if (engine) {
        if (options.knockback) {
          const strength = options.knockback * (1 - this.kbResist);
          const angle = options.angle !== undefined
            ? options.angle
            : (options.direction ? options.direction.angle() : Math.random() * TAU);
          this.knockback.x += Math.cos(angle) * strength;
          this.knockback.y += Math.sin(angle) * strength;
        }
        if (options.stun) {
          this.stun = Math.max(this.stun, options.stun * (1 - this.kbResist));
        }

        if (!options.silent) {
          engine.floatingText.spawn(
            this.position.x, this.position.y - this.radius - 6,
            Math.round(dealt),
            {
              color: options.critical ? '#ffd45e' : '#ffffff',
              size: options.critical ? 21 : 15,
              life: options.critical ? 1 : 0.8,
            }
          );
          engine.particles.burst(this.position.x, this.position.y, options.critical ? 9 : 4, {
            colors: [this.def.accent, '#ffffff'],
            speedMin: 50, speedMax: 200, lifeMin: 0.1, lifeMax: 0.28,
            sizeMin: 2, sizeMax: 4, shape: 'spark',
          });
        }
      }

      if (this.health <= 0) this._die();
      return dealt;
    }

    applyBurn(dps, duration) {
      if (!this.burn) {
        this.burn = { dps, time: duration, tick: 0.25 };
      } else {
        this.burn.dps = Math.max(this.burn.dps, dps);
        this.burn.time = Math.max(this.burn.time, duration);
      }
    }

    applySlow(mult, duration) {
      // 更强的减速覆盖更弱的；更弱的只能续时间
      if (!this.slow || mult < this.slow.mult) this.slow = { mult, time: duration };
      else this.slow.time = Math.max(this.slow.time, duration);
    }

    /** 超出上限时的静默剔除：不掉落、不计击杀 */
    despawn() {
      this.dead = true;
      this.culled = true;
    }

    kill() { if (!this.dead) this._die(); }

    _die() {
      this.dead = true;
      this.health = 0;
      const engine = this.engine;
      if (!engine) return;

      const def = this.def;
      if (def.onDeath) def.onDeath(this, engine);

      const big = this.elite || this.isBoss;
      engine.particles.burst(this.position.x, this.position.y, big ? 52 : 14, {
        colors: [def.color, def.accent, '#ffffff'],
        speedMin: 70, speedMax: big ? 460 : 250,
        lifeMin: 0.24, lifeMax: 0.7, drag: 0.88,
      });
      engine.particles.shockwave(this.position.x, this.position.y, {
        size: this.radius * 0.6,
        endSize: this.radius * (big ? 9 : 3.2),
        color: def.color,
        life: big ? 0.75 : 0.3,
      });
      if (this.isBoss) {
        engine.camera.addTrauma(1);
        engine.freeze(0.18);
      } else if (this.elite) {
        engine.camera.addTrauma(0.4);
      }

      this._dropLoot(engine);

      if (engine.player) engine.player.addKill();
      engine.events.emit('enemy:died', this);
      if (engine.audio) engine.audio.play(this.isBoss ? 'bossDie' : 'kill');
    }

    _dropLoot(engine) {
      // 大目标把经验拆成多颗，吸取时的连续入账更有正反馈
      const shards = this.isBoss ? 18 : this.elite ? 6 : 1;
      const each = Math.max(1, Math.round(this.xpValue / shards));
      for (let i = 0; i < shards; i++) {
        let ox = 0;
        let oy = 0;
        if (shards > 1) {
          const offset = Vector2.randomInsideCircle(this.radius * 1.6);
          ox = offset.x;
          oy = offset.y;
        }
        engine.add(new global.XpGem(this.position.x + ox, this.position.y + oy, each));
      }

      const luck = engine.player ? (engine.player.stats.luck || 0) : 0;
      const roll = Math.random();
      let drop = null;
      if (this.isBoss) drop = 'heal';
      else if (roll < 0.012 + luck * 0.01) drop = 'heal';
      else if (roll < 0.020 + luck * 0.015) drop = 'magnet';
      else if (roll < 0.024 + luck * 0.008) drop = 'bomb';

      if (drop) engine.add(new global.Pickup(this.position.x, this.position.y, drop));
    }

    /* ================= 渲染 ================= */

    draw(ctx) {
      const scale = MathUtils.easeOutCubic(this.spawnAnim);
      if (scale <= 0.01) return;

      const def = this.def;
      this.drawShadow(ctx, scale, 0.28);

      ctx.save();
      ctx.translate(this.position.x, this.position.y);
      ctx.scale(scale, scale);

      ctx.shadowColor = this.elite ? ELITE.tint : def.color;
      ctx.shadowBlur = this.isBoss ? 34 : this.elite ? 26 : 13;
      ctx.fillStyle = this.hitFlash > 0.05 ? '#ffffff' : def.color;
      ctx.strokeStyle = this.elite ? ELITE.tint : def.accent;
      ctx.lineWidth = this.elite ? 3 : 2;

      def.drawBody(this, ctx, this.radius);

      ctx.shadowBlur = 0;
      this._drawEyes(ctx);
      ctx.restore();

      this._drawStatusRings(ctx);
      // Boss 有屏幕顶部的专属血条，世界里不再重复画
      if (this.health < this.maxHealth && !this.isBoss) this._drawHealthBar(ctx, scale);
    }

    _drawEyes(ctx) {
      const r = this.radius;
      // 眼睛朝移动方向偏一点，看起来在「盯着」玩家
      const look = MathUtils.clamp(this.velocity.x / (this.speed + 1), -1, 1) * r * 0.1;

      ctx.fillStyle = 'rgba(12,16,28,0.92)';
      ctx.beginPath();
      ctx.ellipse(-r * 0.26 + look, -r * 0.08, r * 0.15, r * 0.22, 0, 0, TAU);
      ctx.ellipse(r * 0.26 + look, -r * 0.08, r * 0.15, r * 0.22, 0, 0, TAU);
      ctx.fill();

      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.arc(-r * 0.22 + look, -r * 0.15, r * 0.05, 0, TAU);
      ctx.arc(r * 0.3 + look, -r * 0.15, r * 0.05, 0, TAU);
      ctx.fill();
    }

    _drawStatusRings(ctx) {
      if (!this.burn && !this.slow) return;
      ctx.save();
      ctx.translate(this.position.x, this.position.y);
      if (this.burn) {
        ctx.globalAlpha = 0.45 + Math.sin(this.age * 18 + this.seed * 10) * 0.2;
        ctx.strokeStyle = '#ff8a2b';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.ellipse(0, 0, this.radius * 1.05, this.radius * 1.2, 0, 0, TAU);
        ctx.stroke();
      }
      if (this.slow) {
        ctx.globalAlpha = 0.4;
        ctx.strokeStyle = '#7fd8ff';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.lineDashOffset = -this.age * 18;
        ctx.beginPath();
        ctx.arc(0, 0, this.radius * 1.3, 0, TAU);
        ctx.stroke();
      }
      ctx.restore();
    }

    _drawHealthBar(ctx, scale) {
      const width = this.radius * 2 * scale;
      const x = this.position.x - width / 2;
      const y = this.position.y - this.radius * scale - 11;

      ctx.save();
      ctx.fillStyle = 'rgba(8,12,22,0.75)';
      ctx.fillRect(x - 1, y - 1, width + 2, 5);
      ctx.fillStyle = this.elite ? ELITE.tint : '#6bffb8';
      ctx.fillRect(x, y, width * this.healthPercent, 3);
      ctx.restore();
    }
  }

  Enemy.TYPES = ENEMY_TYPES;
  Enemy.ELITE = ELITE;
  Enemy.BOSS_PHASES = BOSS_PHASES;

  global.Enemy = Enemy;
  global.ENEMY_TYPES = ENEMY_TYPES;
})(window);
