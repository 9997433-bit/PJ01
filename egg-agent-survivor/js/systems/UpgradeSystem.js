/**
 * UpgradeSystem — 升级三选一
 *
 * 玩家升级 → 游戏切到 LEVELUP 状态（引擎在该状态下不推进实体，等于暂停）
 * → 弹出 3 张卡 → 选择后应用 → 队列里还有升级就继续弹，否则恢复游戏。
 *
 * 卡池三类：
 *   1. 新武器（还有空槽时）
 *   2. 已持有武器的升级（未满级）
 *   3. 被动属性（可叠加，有次数上限）
 *
 * 抽卡按权重进行；稀有度决定基础权重与卡面配色，玩家的 luck 会放大
 * 高稀有度出现的概率。重随与消除各给一次，每选满 5 次返还一次重随。
 *
 * 卡片用 DOM 渲染（复用 index.html 的 #upgrade-cards 与 .card 样式）：
 * 文字锐利、天然可点击、键盘可达，比在 canvas 里画 UI 省事得多。
 */
(function (global) {
  'use strict';

  const MathUtils = global.MathUtils;

  /** DOM 桩里 style 可能只是普通对象，自定义属性统一走这层保护 */
  function setCssVar(element, name, value) {
    if (element && element.style && typeof element.style.setProperty === 'function') {
      element.style.setProperty(name, value);
    }
  }

  const RARITY = {
    common:    { key: 'common',    label: '普通', weight: 100 },
    rare:      { key: 'rare',      label: '稀有', weight: 44 },
    epic:      { key: 'epic',      label: '史诗', weight: 16 },
    legendary: { key: 'legendary', label: '传说', weight: 5 },
  };

  /**
   * 被动卡。apply(context) 只改 player.stats。
   * maxStacks 控制最多可选次数，避免单一属性无限堆叠。
   */
  const PASSIVES = [
    {
      id: 'p_damage', name: '蛋白强化', icon: '◆', rarity: 'common', maxStacks: 8,
      desc: (c) => `全部伤害 +12%（当前 ${Math.round(c.player.stats.damageMultiplier * 100)}%）`,
      apply: (c) => { c.player.stats.damageMultiplier += 0.12; },
    },
    {
      id: 'p_cooldown', name: '急速孵化', icon: '⚡', rarity: 'rare', maxStacks: 6,
      desc: () => '所有武器冷却 -8%',
      apply: (c) => {
        c.player.stats.cooldownMultiplier = Math.max(0.25, c.player.stats.cooldownMultiplier - 0.08);
      },
    },
    {
      id: 'p_area', name: '范围扩张', icon: '◎', rarity: 'common', maxStacks: 6,
      desc: () => '武器作用范围 +12%',
      apply: (c) => { c.player.stats.areaMultiplier += 0.12; },
    },
    {
      id: 'p_speed', name: '推进器', icon: '➢', rarity: 'common', maxStacks: 6,
      desc: () => '移动速度 +10%',
      apply: (c) => { c.player.stats.speed *= 1.1; },
    },
    {
      id: 'p_maxhp', name: '强化蛋壳', icon: '❤', rarity: 'common', maxStacks: 8,
      desc: () => '生命上限 +26 并立即回复等量生命',
      apply: (c) => { c.player.stats.maxHealth += 26; c.player.heal(26, { silent: true }); },
    },
    {
      id: 'p_regen', name: '纳米修复', icon: '✚', rarity: 'rare', maxStacks: 5,
      desc: (c) => `每秒回复 +0.8 生命（当前 ${c.player.stats.regen.toFixed(1)}/s）`,
      apply: (c) => { c.player.stats.regen += 0.8; },
    },
    {
      id: 'p_armor', name: '合金镀层', icon: '▣', rarity: 'rare', maxStacks: 5,
      desc: (c) => `每次受击减伤 +2（当前 ${c.player.stats.armor}）`,
      apply: (c) => { c.player.stats.armor += 2; },
    },
    {
      id: 'p_pickup', name: '磁力场', icon: '◉', rarity: 'common', maxStacks: 5,
      desc: () => '经验拾取范围 +36%',
      apply: (c) => { c.player.stats.pickupRadius *= 1.36; },
    },
    {
      id: 'p_crit', name: '暴击芯片', icon: '✦', rarity: 'rare', maxStacks: 6,
      desc: (c) => `暴击率 +7%（当前 ${Math.round(c.player.stats.critChance * 100)}%）`,
      apply: (c) => {
        c.player.stats.critChance = Math.min(0.85, c.player.stats.critChance + 0.07);
      },
    },
    {
      id: 'p_critmult', name: '致命一击', icon: '✧', rarity: 'epic', maxStacks: 4,
      desc: (c) => `暴击伤害 +45%（当前 ${Math.round(c.player.stats.critMultiplier * 100)}%）`,
      apply: (c) => { c.player.stats.critMultiplier += 0.45; },
    },
    {
      id: 'p_amount', name: '多重投射', icon: '⋈', rarity: 'epic', maxStacks: 3,
      desc: () => '多发类武器额外 +1 发',
      apply: (c) => { c.player.stats.extraProjectiles += 1; },
    },
    {
      id: 'p_projspeed', name: '高速弹道', icon: '➤', rarity: 'common', maxStacks: 4,
      desc: () => '弹道速度 +15%',
      apply: (c) => { c.player.stats.projectileSpeedMultiplier += 0.15; },
    },
    {
      id: 'p_duration', name: '持久力场', icon: '⏳', rarity: 'common', maxStacks: 4,
      desc: () => '效果持续时间 +15%',
      apply: (c) => { c.player.stats.durationMultiplier += 0.15; },
    },
    {
      id: 'p_xp', name: '经验虹吸', icon: '⬢', rarity: 'rare', maxStacks: 4,
      desc: () => '获得经验 +22%',
      apply: (c) => { c.player.stats.xpMultiplier += 0.22; },
    },
    {
      id: 'p_thorns', name: '碎壳荆棘', icon: '✹', rarity: 'epic', maxStacks: 4,
      desc: (c) => `被撞击时反弹 14 点伤害（当前 ${c.player.stats.thorns}）`,
      apply: (c) => { c.player.stats.thorns += 14; },
    },
    {
      id: 'p_dash', name: '相位引擎', icon: '⟫', rarity: 'epic', maxStacks: 3,
      desc: () => '冲刺冷却 -26%，冲刺速度 +12%',
      apply: (c) => {
        c.player.stats.dashCooldown *= 0.74;
        c.player.stats.dashSpeed *= 1.12;
      },
    },
    {
      id: 'p_luck', name: '幸运蛋', icon: '☘', rarity: 'rare', maxStacks: 4,
      desc: () => '幸运 +15%：更容易刷出高稀有度选项与稀有掉落',
      apply: (c) => { c.player.stats.luck += 0.15; },
    },
    {
      id: 'p_greed', name: '孤注一掷', icon: '⚔', rarity: 'legendary', maxStacks: 1,
      desc: () => '伤害 +50%，但生命上限 -20',
      apply: (c) => {
        c.player.stats.damageMultiplier += 0.5;
        c.player.stats.maxHealth = Math.max(20, c.player.stats.maxHealth - 20);
        c.player.health = Math.min(c.player.health, c.player.stats.maxHealth);
      },
    },
  ];

  /** 卡池被抽干时的保底卡，保证永远有得选 */
  const SUPPLY_CARD = {
    id: 'supply', name: '应急补给', icon: '✚', rarity: 'common', kind: 'supply',
    tag: '补给', maxStacks: Infinity,
    desc: () => '立即回复 45% 生命',
    apply: (c) => { c.player.heal(c.player.stats.maxHealth * 0.45); },
  };

  class UpgradeSystem {
    /**
     * @param {object} [options] { weapons, cardCount }
     */
    constructor(options = {}) {
      this.weapons = options.weapons || null;
      this.cardCount = options.cardCount || 3;

      this.engine = null;
      this.stacks = new Map();
      this.banished = new Set();
      this.rerolls = 1;
      this.banishes = 1;
      this.picks = 0;
      this.choices = [];
    }

    onAdd(engine) {
      this.engine = engine;
      engine.upgrades = this;
      if (!this.weapons && engine.weapons) this.weapons = engine.weapons;
    }

    reset() {
      this.stacks.clear();
      this.banished.clear();
      this.rerolls = 1;
      this.banishes = 1;
      this.picks = 0;
      this.choices.length = 0;
    }

    getStacks(id) { return this.stacks.get(id) || 0; }

    /* ================= 卡池 ================= */

    _weaponSystem() {
      return this.weapons || (this.engine && this.engine.weapons) || null;
    }

    /**
     * 卡面文案与 apply 都会直接读写 areaMultiplier / critChance 这类扩展属性，
     * 而它们由 WeaponSystem 在首帧补齐。这里先兜一次底，
     * 避免「首帧之前就升级」时把属性算成 NaN。
     */
    _ensureStats() {
      const player = this.engine && this.engine.player;
      if (player && global.WeaponSystem) global.WeaponSystem.ensureCombatStats(player);
    }

    /** 组装当前所有可选项 */
    buildPool() {
      this._ensureStats();
      const pool = [];
      const weapons = this._weaponSystem();
      if (!weapons) return pool;

      // 1. 已有武器升级
      for (const weapon of weapons.weapons) {
        if (weapon.level >= weapon.def.maxLevel) continue;
        const nextLevel = weapon.level + 1;
        pool.push({
          kind: 'weaponLevel',
          id: `w_${weapon.id}`,
          weaponId: weapon.id,
          name: weapon.def.name,
          icon: weapon.def.icon,
          rarity: weapon.level >= 5 ? 'epic' : weapon.level >= 3 ? 'rare' : 'common',
          weight: 34,
          tag: `Lv.${weapon.level} → Lv.${nextLevel}`,
          desc: () => weapons.levelDescription(weapon.id, nextLevel),
          apply: (c) => { c.weapons.levelUp(weapon.id); },
        });
      }

      // 2. 新武器
      if (!weapons.isFull) {
        for (const id of global.WeaponSystem.IDS) {
          if (weapons.has(id)) continue;
          const def = global.WEAPONS[id];
          pool.push({
            kind: 'weaponNew',
            id: `n_${id}`,
            weaponId: id,
            name: def.name,
            icon: def.icon,
            rarity: 'rare',
            weight: 32,
            tag: '新武器',
            desc: () => def.desc,
            apply: (c) => { c.weapons.add(id); },
          });
        }
      }

      // 3. 被动
      for (const passive of PASSIVES) {
        const taken = this.getStacks(passive.id);
        if (taken >= passive.maxStacks) continue;
        pool.push({
          kind: 'passive',
          id: passive.id,
          name: passive.name,
          icon: passive.icon,
          rarity: passive.rarity,
          weight: 22,
          tag: taken > 0 ? `${taken}/${passive.maxStacks}` : '被动',
          desc: passive.desc,
          apply: passive.apply,
        });
      }

      return pool.filter((card) => !this.banished.has(card.id));
    }

    /** 幸运放大高稀有度权重 */
    _weightOf(card, luck) {
      const rarity = RARITY[card.rarity] || RARITY.common;
      const boost = card.rarity === 'common'
        ? 1
        : 1 + luck * (card.rarity === 'legendary' ? 2.4 : 1.4);
      return card.weight * (rarity.weight / 100) * boost;
    }

    /** 抽 count 张互不重复的卡 */
    roll(count = this.cardCount) {
      const pool = this.buildPool();
      const player = this.engine && this.engine.player;
      const luck = player && player.stats ? (player.stats.luck || 0) : 0;
      const picked = [];

      const n = Math.min(count, pool.length);
      for (let i = 0; i < n; i++) {
        let total = 0;
        for (const card of pool) total += this._weightOf(card, luck);
        if (total <= 0) break;

        let roll = Math.random() * total;
        for (let j = 0; j < pool.length; j++) {
          roll -= this._weightOf(pool[j], luck);
          if (roll <= 0) { picked.push(pool.splice(j, 1)[0]); break; }
        }
      }

      if (!picked.length) picked.push(SUPPLY_CARD);
      this.choices = picked;
      return picked;
    }

    /**
     * 应用一张卡。
     * @param {object} card
     * @param {object} context { player, engine, weapons }
     */
    apply(card, context) {
      this._ensureStats();
      const ctx = context || this.context();
      card.apply(ctx);
      this.stacks.set(card.id, this.getStacks(card.id) + 1);
      this.picks++;
      // 每选满 5 次返还一次重随，鼓励中后期继续使用
      if (this.picks % 5 === 0) this.rerolls++;
      if (ctx.weapons) ctx.weapons.recalcAll();
      if (ctx.engine) ctx.engine.events.emit('upgrade:applied', card);
    }

    context() {
      const engine = this.engine;
      return {
        player: engine ? engine.player : null,
        engine,
        weapons: this._weaponSystem(),
      };
    }

    /* ================= 重随 / 消除 ================= */

    canReroll() { return this.rerolls > 0; }

    reroll() {
      if (this.rerolls <= 0) return null;
      this.rerolls--;
      return this.roll();
    }

    /** 消除一张卡：本局不再出现，并立刻补抽 */
    banish(card) {
      if (this.banishes <= 0 || !card || card.kind === 'supply') return null;
      this.banishes--;
      this.banished.add(card.id);
      return this.roll();
    }

    /* ================= 卡片 UI ================= */

    /**
     * 把当前 choices 渲染进容器。
     * @param {HTMLElement} container
     * @param {object} context
     * @param {(card:object, index:number) => void} onPick
     */
    renderCards(container, context, onPick) {
      if (!container) return this.choices;
      container.innerHTML = '';

      this.choices.forEach((card, index) => {
        const rarity = RARITY[card.rarity] || RARITY.common;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `card card--${rarity.key}${card.kind === 'fusion' ? ' card--fusion' : ''}`;
        button.style.animationDelay = `${index * 70}ms`;
        button.setAttribute('aria-label', `${card.name} · ${rarity.label}`);

        // 融合卡自带两种元素色，卡面直接用它们描边，一眼看出是哪对元素合成的
        if (card.colors && card.colors.length) {
          setCssVar(button, '--card-color', card.colors[0]);
          setCssVar(button, '--card-color-2', card.colors[1] || card.colors[0]);
        }

        const meta = card.tag || rarity.label;
        button.innerHTML = `
          <span class="card__key">${index + 1}</span>
          <span class="card__icon">${card.icon}</span>
          <span class="card__name">${card.name}</span>
          <span class="card__desc">${card.desc(context)}</span>
          <span class="card__meta">${rarity.label} · ${meta}</span>
        `;

        button.addEventListener('click', () => onPick(card, index));
        // 右键消除：把不想要的选项永久踢出本局卡池
        button.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          if (this.banish(card)) this.renderCards(container, context, onPick);
        });

        container.appendChild(button);
      });

      return this.choices;
    }
  }

  UpgradeSystem.PASSIVES = PASSIVES;
  UpgradeSystem.RARITY = RARITY;
  UpgradeSystem.SUPPLY_CARD = SUPPLY_CARD;

  global.UpgradeSystem = UpgradeSystem;
  // 兼容早期命名
  global.UpgradePool = UpgradeSystem;
})(window);
