/**
 * Player — 玩家「蛋型特工」
 *
 * 负责：加速度式移动（WASD / 虚拟摇杆）、冲刺、受击与无敌帧、
 *      血量与回复、经验与升级曲线、拖尾粒子与挤压拉伸动画。
 *
 * 所有数值集中在 `stats`，升级/道具系统只需要改这里的字段。
 */
(function (global) {
  'use strict';

  const Vector2 = global.Vector2;
  const MathUtils = global.MathUtils;

  const BASE_STATS = {
    maxHealth: 100,
    speed: 236,          // 像素/秒
    acceleration: 15,    // 越大越跟手（指数逼近系数）
    friction: 11,        // 松手后的减速系数
    armor: 0,            // 每次受击的固定减伤
    regen: 0.35,         // 每秒回血
    pickupRadius: 96,
    damageMultiplier: 1,
    cooldownMultiplier: 1,
    xpMultiplier: 1,
    dashCooldown: 1.7,
    dashSpeed: 780,
    dashDuration: 0.16,
  };

  const INVULN_ON_HIT = 0.65;
  const INVULN_ON_DASH = 0.22;
  const TRAIL_INTERVAL = 0.028;

  /**
   * 可选角色（Round 3 主菜单角色选择）。
   * 每个角色 = 初始武器 + 一组声明式属性修正（add 先于 mul 结算）。
   * traits 是给菜单卡片看的文案，statMods 才是唯一的数值事实来源。
   */
  const CHARACTERS = [
    {
      id: 'nova',
      name: '新星',
      codename: 'AGENT NOVA',
      icon: '✷',
      role: '均衡输出',
      weapon: 'magicBolt',
      desc: '标准制式特工，自动索敌魔法弹开局，属性全面无短板。',
      traits: ['属性均衡', '魔法弹起手'],
      statMods: [],
    },
    {
      id: 'aegis',
      name: '壁垒',
      codename: 'AGENT AEGIS',
      icon: '▣',
      role: '重装坦克',
      weapon: 'frostNova',
      desc: '加厚合金蛋壳，霜爆冲击解围。跑不快，但也砸不碎。',
      traits: ['生命 +60', '护甲 +3', '回复 +0.45/s', '移速 −14%'],
      statMods: [
        { stat: 'maxHealth', add: 60 },
        { stat: 'armor', add: 3 },
        { stat: 'regen', add: 0.45 },
        { stat: 'speed', mul: 0.86 },
      ],
    },
    {
      id: 'gale',
      name: '疾风',
      codename: 'AGENT GALE',
      icon: '➢',
      role: '高速游击',
      weapon: 'boomerang',
      desc: '轻量化蛋壳换来极限机动，靠走位与回旋镖放风筝。',
      traits: ['移速 +20%', '冲刺冷却 −38%', '生命 −25'],
      statMods: [
        { stat: 'speed', mul: 1.2 },
        { stat: 'dashCooldown', mul: 0.62 },
        { stat: 'maxHealth', add: -25 },
      ],
    },
    {
      id: 'blaze',
      name: '燎原',
      codename: 'AGENT BLAZE',
      icon: '♨',
      role: '狂热输出',
      weapon: 'flamethrower',
      desc: '拆掉安全阀的火力狂人，火焰喷射开局，越烧越旺。',
      traits: ['伤害 +20%', '冷却 −6%', '生命 −15'],
      statMods: [
        { stat: 'damageMultiplier', add: 0.2 },
        { stat: 'cooldownMultiplier', add: -0.06 },
        { stat: 'maxHealth', add: -15 },
      ],
    },
  ];

  const DEFAULT_CHARACTER = CHARACTERS[0].id;

  class Player extends global.Entity {
    /**
     * @param {number} x
     * @param {number} y
     * @param {string} [characterId] 可选角色 id，缺省为均衡型「新星」
     */
    constructor(x = 0, y = 0, characterId = DEFAULT_CHARACTER) {
      super(x, y, { radius: 19, tag: 'player', layer: global.Layer.ACTOR });

      this.stats = Object.assign({}, BASE_STATS);
      this.character = Player.applyCharacter(this.stats, characterId);
      this.characterId = this.character.id;
      this.health = this.stats.maxHealth;

      this.level = 1;
      this.xp = 0;
      this.xpToNext = Player.xpRequiredFor(1);
      this.kills = 0;

      this.facing = new Vector2(0, 1);
      this.faceSign = 1;
      this.moveInput = new Vector2(0, 0);
      this.desiredVelocity = new Vector2(0, 0);

      this.invulnerable = 0;
      this.hitFlash = 0;
      this.dashTimer = 0;
      this.dashCooldownTimer = 0;
      this.isDashing = false;

      this.knockback = new Vector2(0, 0);
      this._trailTimer = 0;
      this._afterImages = [];
      this._squash = 1;
      this._bobPhase = Math.random() * Math.PI * 2;
    }

    /** 升级曲线：前期快、后期稳步拉长 */
    static xpRequiredFor(level) {
      return Math.floor(9 + level * 7 + Math.pow(level, 1.85));
    }

    /** 按 id 查角色定义；未知 id 落回默认角色 */
    static getCharacter(id) {
      return CHARACTERS.find((c) => c.id === id) || CHARACTERS[0];
    }

    /**
     * 把角色的属性修正应用到一份 stats 上（原地修改）。
     * add 先于 mul 结算；maxHealth 至少保留 30，避免修正叠出脆皮到开局即死。
     * @param {object} stats 形如 BASE_STATS 的属性表
     * @param {string} characterId
     * @returns {object} 命中的角色定义
     */
    static applyCharacter(stats, characterId) {
      const character = Player.getCharacter(characterId);
      for (const mod of character.statMods) {
        if (stats[mod.stat] === undefined) continue;
        if (mod.add !== undefined) stats[mod.stat] += mod.add;
        if (mod.mul !== undefined) stats[mod.stat] *= mod.mul;
      }
      stats.maxHealth = Math.max(30, stats.maxHealth);
      return character;
    }

    get healthPercent() { return MathUtils.clamp(this.health / this.stats.maxHealth, 0, 1); }
    get xpPercent() { return MathUtils.clamp(this.xp / this.xpToNext, 0, 1); }
    get isAlive() { return this.health > 0 && !this.dead; }

    /* ================= 更新 ================= */

    update(dt, engine) {
      this.age += dt;
      const input = engine.input;

      this._updateTimers(dt);
      if (input) this.moveInput.copy(input.moveAxis);

      if (input && input.wasPressed('dash')) this.tryDash();

      this._updateMovement(dt);
      this._updateTrail(dt, engine);
      this._updateAfterImages(dt);

      if (this.stats.regen > 0 && this.health < this.stats.maxHealth) {
        this.heal(this.stats.regen * dt, { silent: true });
      }
    }

    _updateTimers(dt) {
      this.invulnerable = Math.max(0, this.invulnerable - dt);
      this.hitFlash = Math.max(0, this.hitFlash - dt * 3.4);
      this.dashCooldownTimer = Math.max(0, this.dashCooldownTimer - dt);
      if (this.isDashing) {
        this.dashTimer -= dt;
        if (this.dashTimer <= 0) this.isDashing = false;
      }
    }

    _updateMovement(dt) {
      const s = this.stats;

      if (!this.moveInput.isZero()) {
        this.facing.copy(this.moveInput).normalizeSelf();
        if (Math.abs(this.moveInput.x) > 0.12) {
          this.faceSign = this.moveInput.x > 0 ? 1 : -1;
        }
      }

      const targetSpeed = this.isDashing ? s.dashSpeed : s.speed;
      this.desiredVelocity.copy(this.isDashing ? this.facing : this.moveInput).scaleSelf(targetSpeed);

      // 有输入用 acceleration，无输入用 friction —— 起步利落、停下有惯性
      const rate = this.moveInput.isZero() && !this.isDashing ? s.friction : s.acceleration;
      const t = 1 - Math.exp(-rate * dt);
      this.velocity.x += (this.desiredVelocity.x - this.velocity.x) * t;
      this.velocity.y += (this.desiredVelocity.y - this.velocity.y) * t;

      if (!this.knockback.isZero()) {
        this.position.addScaledSelf(this.knockback, dt);
        this.knockback.scaleSelf(Math.pow(0.0016, dt));
        if (this.knockback.lengthSq() < 1) this.knockback.set(0, 0);
      }

      this.position.addScaledSelf(this.velocity, dt);

      // 速度越快越「拉长」，冲刺时更夸张
      const speedRatio = MathUtils.clamp(this.velocity.length() / s.speed, 0, 2);
      const target = 1 + speedRatio * (this.isDashing ? 0.26 : 0.11);
      this._squash = MathUtils.damp(this._squash, target, 0.001, dt);
      this._bobPhase += dt * (6 + speedRatio * 7);
    }

    _updateTrail(dt, engine) {
      const speed = this.velocity.length();
      if (speed < 42) return;

      this._trailTimer -= dt;
      if (this._trailTimer > 0) return;
      this._trailTimer = TRAIL_INTERVAL;

      const back = this.velocity.normalized().scale(-1);
      const jitter = back.perpendicular().scale(MathUtils.randRange(-6, 6));
      const intensity = MathUtils.clamp(speed / this.stats.speed, 0, 2);

      engine.particles.emit({
        x: this.position.x + back.x * 8 + jitter.x,
        y: this.position.y + back.y * 8 + jitter.y + 4,
        vx: back.x * speed * 0.22 + MathUtils.randRange(-18, 18),
        vy: back.y * speed * 0.22 + MathUtils.randRange(-18, 18),
        life: MathUtils.randRange(0.22, 0.42) * (this.isDashing ? 1.5 : 1),
        size: MathUtils.randRange(2.4, 5.2) * (0.7 + intensity * 0.5),
        color: this.isDashing ? '#b78bff' : (Math.random() < 0.3 ? '#8affe4' : '#4fd8ff'),
        drag: 0.9,
        shape: Math.random() < 0.25 ? 'spark' : 'circle',
        stretch: 1.4,
      });

      if (this.isDashing) {
        this._afterImages.push({
          x: this.position.x,
          y: this.position.y,
          life: 0.3,
          maxLife: 0.3,
          squash: this._squash,
          angle: this.facing.angle(),
        });
      }
    }

    _updateAfterImages(dt) {
      for (let i = this._afterImages.length - 1; i >= 0; i--) {
        const ghost = this._afterImages[i];
        ghost.life -= dt;
        if (ghost.life <= 0) this._afterImages.splice(i, 1);
      }
    }

    /* ================= 行为 ================= */

    tryDash() {
      if (this.dashCooldownTimer > 0 || this.isDashing || !this.isAlive) return false;
      if (this.moveInput.isZero() && this.facing.isZero()) return false;

      this.isDashing = true;
      this.dashTimer = this.stats.dashDuration;
      this.dashCooldownTimer = this.stats.dashCooldown * this.stats.cooldownMultiplier;
      this.invulnerable = Math.max(this.invulnerable, INVULN_ON_DASH);

      const engine = this.engine;
      if (engine) {
        engine.particles.shockwave(this.position.x, this.position.y, {
          size: 10, endSize: 74, color: '#b78bff', life: 0.35,
        });
        engine.particles.burst(this.position.x, this.position.y, 14, {
          colors: ['#b78bff', '#7cf9ff', '#ffffff'],
          speedMin: 90, speedMax: 260, lifeMin: 0.2, lifeMax: 0.45,
          shape: 'spark', stretch: 1.6,
        });
        engine.camera.addTrauma(0.16);
        engine.events.emit('player:dash', this);
      }
      return true;
    }

    /**
     * @param {number} amount 伤害值
     * @param {{source?:Entity, knockback?:number, ignoreInvuln?:boolean}} options
     */
    takeDamage(amount, options = {}) {
      if (!this.isAlive) return 0;
      if (this.invulnerable > 0 && !options.ignoreInvuln) return 0;

      const dealt = Math.max(1, amount - this.stats.armor);
      this.health = Math.max(0, this.health - dealt);
      this.invulnerable = INVULN_ON_HIT;
      this.hitFlash = 1;

      const engine = this.engine;
      if (engine) {
        const dir = options.source
          ? this.position.sub(options.source.position).normalizeSelf()
          : Vector2.randomDirection();
        this.knockback.copy(dir.scale(options.knockback || 190));

        engine.camera.addTrauma(MathUtils.clamp(0.24 + dealt / 120, 0.2, 0.75));
        engine.freeze(0.05);
        engine.particles.burst(this.position.x, this.position.y, 16, {
          colors: ['#ff4d6d', '#ff9ebb', '#ffffff'],
          speedMin: 80, speedMax: 300, lifeMin: 0.2, lifeMax: 0.5,
          shape: 'spark', stretch: 1.5,
        });
        engine.floatingText.spawn(this.position.x, this.position.y - 24, `-${Math.round(dealt)}`, {
          style: 'hurt',
        });
        engine.events.emit('player:damaged', { player: this, amount: dealt });
      }

      if (this.health <= 0) this._die();
      return dealt;
    }

    heal(amount, options = {}) {
      if (!this.isAlive) return 0;
      const before = this.health;
      this.health = Math.min(this.stats.maxHealth, this.health + amount);
      const healed = this.health - before;
      if (healed > 0.5 && !options.silent && this.engine) {
        this.engine.floatingText.spawn(this.position.x, this.position.y - 26, `+${Math.round(healed)}`, {
          style: 'heal',
        });
        this.engine.events.emit('player:healed', { player: this, amount: healed });
      }
      return healed;
    }

    gainXp(amount) {
      if (!this.isAlive) return;
      this.xp += amount * this.stats.xpMultiplier;

      let levelsGained = 0;
      while (this.xp >= this.xpToNext) {
        this.xp -= this.xpToNext;
        this.level++;
        this.xpToNext = Player.xpRequiredFor(this.level);
        levelsGained++;
      }

      if (levelsGained > 0) this._onLevelUp(levelsGained);
      if (this.engine) this.engine.events.emit('player:xp', this);
    }

    _onLevelUp(levels) {
      // 升级顺带小幅补血，保证「变强」的正反馈立刻可感知
      this.stats.maxHealth += 4 * levels;
      this.heal(this.stats.maxHealth * 0.12 * levels, { silent: true });

      const engine = this.engine;
      if (engine) {
        engine.particles.shockwave(this.position.x, this.position.y, {
          size: 16, endSize: 210, color: '#ffd45e', life: 0.6,
        });
        engine.particles.burst(this.position.x, this.position.y, 34, {
          colors: ['#ffd45e', '#7cf9ff', '#ffffff', '#b78bff'],
          speedMin: 120, speedMax: 400, lifeMin: 0.4, lifeMax: 0.9,
          drag: 0.9,
        });
        engine.floatingText.spawn(this.position.x, this.position.y - 44, `LEVEL ${this.level}`, {
          style: 'levelup', spread: 0, stack: false,
        });
        engine.camera.addTrauma(0.2);
        engine.events.emit('player:levelup', { player: this, level: this.level, levels });
      }
    }

    addKill() {
      this.kills++;
      if (this.engine) this.engine.events.emit('player:kill', this);
    }

    _die() {
      const engine = this.engine;
      if (engine) {
        engine.camera.addTrauma(1);
        engine.freeze(0.24);
        engine.particles.shockwave(this.position.x, this.position.y, {
          size: 20, endSize: 300, color: '#ff4d6d', life: 0.9,
        });
        engine.particles.burst(this.position.x, this.position.y, 60, {
          colors: ['#ff4d6d', '#ffffff', '#ffd45e'],
          speedMin: 120, speedMax: 520, lifeMin: 0.5, lifeMax: 1.4,
          gravity: 220, drag: 0.93,
        });
        engine.events.emit('player:died', this);
      }
      this.visible = false;
    }

    reset(x = 0, y = 0) {
      this.stats = Object.assign({}, BASE_STATS);
      this.character = Player.applyCharacter(this.stats, this.characterId);
      this.position.set(x, y);
      this.velocity.set(0, 0);
      this.knockback.set(0, 0);
      this.health = this.stats.maxHealth;
      this.level = 1;
      this.xp = 0;
      this.xpToNext = Player.xpRequiredFor(1);
      this.kills = 0;
      this.invulnerable = 0;
      this.hitFlash = 0;
      this.dashTimer = 0;
      this.dashCooldownTimer = 0;
      this.isDashing = false;
      this.dead = false;
      this.visible = true;
      this._afterImages.length = 0;
      this._squash = 1;
    }

    /* ================= 渲染 ================= */

    draw(ctx) {
      // 无敌期闪烁；死亡后不再绘制本体
      if (!this.visible) return;
      const blinking = this.invulnerable > 0 && Math.floor(this.age * 22) % 2 === 0;

      this.drawShadow(ctx, 1 + (this._squash - 1) * 0.4, 0.3);
      this._drawAfterImages(ctx);
      this._drawAura(ctx);

      ctx.save();
      ctx.globalAlpha = blinking ? 0.45 : 1;
      ctx.translate(this.position.x, this.position.y + Math.sin(this._bobPhase) * 1.6);

      // 沿运动方向倾斜，速度越快越明显
      const tilt = MathUtils.clamp(this.velocity.x / this.stats.speed, -1, 1) * 0.2;
      ctx.rotate(tilt);

      const stretch = this._squash;
      const w = this.radius * (2 - stretch * 0.35);
      const h = this.radius * (1.28 * stretch);

      this._drawBody(ctx, w, h);
      this._drawVisor(ctx, w, h);
      ctx.restore();

      if (this.healthPercent < 0.3 && this.isAlive) this._drawDangerRing(ctx);
    }

    _drawAura(ctx) {
      const pulse = 0.5 + Math.sin(this.age * 3.4) * 0.5;
      const radius = this.radius * (2.5 + pulse * 0.35);
      const gradient = ctx.createRadialGradient(
        this.position.x, this.position.y, this.radius * 0.4,
        this.position.x, this.position.y, radius
      );
      const color = this.isDashing ? '183,139,255' : '79,216,255';
      gradient.addColorStop(0, `rgba(${color},${0.24 + pulse * 0.08})`);
      gradient.addColorStop(1, `rgba(${color},0)`);

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(this.position.x, this.position.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    _drawAfterImages(ctx) {
      if (this._afterImages.length === 0) return;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const ghost of this._afterImages) {
        const t = ghost.life / ghost.maxLife;
        ctx.globalAlpha = t * 0.42;
        ctx.fillStyle = '#b78bff';
        ctx.beginPath();
        ctx.ellipse(
          ghost.x, ghost.y,
          this.radius * (2 - ghost.squash * 0.35) * 0.5,
          this.radius * 1.28 * ghost.squash * 0.5,
          0, 0, Math.PI * 2
        );
        ctx.fill();
      }
      ctx.restore();
    }

    _drawBody(ctx, w, h) {
      const gradient = ctx.createLinearGradient(0, -h, 0, h);
      gradient.addColorStop(0, '#ffffff');
      gradient.addColorStop(0.5, '#e8f6ff');
      gradient.addColorStop(1, '#9fd4ee');

      ctx.save();
      ctx.shadowColor = this.isDashing ? 'rgba(183,139,255,0.95)' : 'rgba(79,216,255,0.85)';
      ctx.shadowBlur = 22;

      // 蛋型：上窄下宽，用两段贝塞尔而不是纯椭圆
      ctx.beginPath();
      ctx.moveTo(0, -h);
      ctx.bezierCurveTo(w * 0.92, -h * 0.72, w, h * 0.36, 0, h);
      ctx.bezierCurveTo(-w, h * 0.36, -w * 0.92, -h * 0.72, 0, -h);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = this.isDashing ? '#d7b9ff' : '#6fe7ff';
      ctx.stroke();

      if (this.hitFlash > 0) {
        ctx.globalAlpha = Math.min(0.85, this.hitFlash);
        ctx.fillStyle = '#ff5c7c';
        ctx.fill();
      }
      ctx.restore();

      // 高光
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(-w * 0.34, -h * 0.42, w * 0.18, h * 0.16, -0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    _drawVisor(ctx, w, h) {
      const offsetX = this.faceSign * w * 0.1;
      const offsetY = h * 0.02;

      ctx.save();
      ctx.translate(offsetX, offsetY);

      ctx.fillStyle = '#101a2c';
      ctx.beginPath();
      ctx.ellipse(0, 0, w * 0.62, h * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = 'rgba(124,249,255,0.9)';
      ctx.lineWidth = 1.4;
      ctx.stroke();

      // 面罩内的扫描光
      const glow = ctx.createLinearGradient(-w * 0.6, 0, w * 0.6, 0);
      glow.addColorStop(0, 'rgba(124,249,255,0)');
      glow.addColorStop(0.5, `rgba(124,249,255,${this.isDashing ? 0.95 : 0.65})`);
      glow.addColorStop(1, 'rgba(124,249,255,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.ellipse(this.faceSign * w * 0.12, -h * 0.04, w * 0.42, h * 0.12, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }

    _drawDangerRing(ctx) {
      const pulse = 0.5 + Math.sin(this.age * 9) * 0.5;
      ctx.save();
      ctx.globalAlpha = 0.25 + pulse * 0.45;
      ctx.strokeStyle = '#ff4d6d';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 8]);
      ctx.lineDashOffset = -this.age * 26;
      ctx.beginPath();
      ctx.arc(this.position.x, this.position.y, this.radius * 2.1 + pulse * 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  Player.BASE_STATS = BASE_STATS;
  Player.CHARACTERS = CHARACTERS;
  Player.DEFAULT_CHARACTER = DEFAULT_CHARACTER;
  global.Player = Player;
})(window);
