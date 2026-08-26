/**
 * UpgradePool — 升级卡池
 * 每张卡是纯数据 + 一个 apply 函数，只改 player.stats 或 weapon 字段。
 */
(function (global) {
  'use strict';

  const UPGRADES = [
    {
      id: 'multishot', name: '多重弹射', icon: '⋈', rarity: 'epic', maxStacks: 4,
      desc: (s) => `主武器每次多发射 1 发弹丸（当前 ${s.weapon.projectileCount} 发）`,
      apply: (s) => { s.weapon.projectileCount += 1; s.weapon.spread = Math.min(0.5, s.weapon.spread + 0.03); },
    },
    {
      id: 'damage', name: '高压弹头', icon: '◆', rarity: 'common', maxStacks: 8,
      desc: () => '弹丸伤害 +25%',
      apply: (s) => { s.weapon.damage *= 1.25; },
    },
    {
      id: 'firerate', name: '超频扳机', icon: '⚡', rarity: 'common', maxStacks: 8,
      desc: () => '射击间隔 -14%',
      apply: (s) => { s.weapon.cooldown = Math.max(0.08, s.weapon.cooldown * 0.86); },
    },
    {
      id: 'pierce', name: '穿甲涂层', icon: '➤', rarity: 'rare', maxStacks: 4,
      desc: () => '弹丸可额外穿透 1 个敌人',
      apply: (s) => { s.weapon.pierce += 1; },
    },
    {
      id: 'crit', name: '暴击芯片', icon: '✦', rarity: 'rare', maxStacks: 5,
      desc: (s) => `暴击率 +9%（当前 ${Math.round(s.weapon.critChance * 100)}%）`,
      apply: (s) => { s.weapon.critChance = Math.min(0.85, s.weapon.critChance + 0.09); },
    },
    {
      id: 'range', name: '锁定天线', icon: '◎', rarity: 'common', maxStacks: 4,
      desc: () => '索敌范围 +22%，弹速 +12%',
      apply: (s) => { s.weapon.range *= 1.22; s.weapon.projectileSpeed *= 1.12; },
    },
    {
      id: 'health', name: '强化蛋壳', icon: '❤', rarity: 'common', maxStacks: 8,
      desc: () => '生命上限 +26 并立即回复等量生命',
      apply: (s) => { s.player.stats.maxHealth += 26; s.player.heal(26, { silent: true }); },
    },
    {
      id: 'armor', name: '合金镀层', icon: '▣', rarity: 'rare', maxStacks: 5,
      desc: (s) => `每次受击减伤 +2（当前 ${s.player.stats.armor}）`,
      apply: (s) => { s.player.stats.armor += 2; },
    },
    {
      id: 'regen', name: '纳米修复', icon: '✚', rarity: 'rare', maxStacks: 5,
      desc: (s) => `每秒回复 +0.9 生命（当前 ${s.player.stats.regen.toFixed(1)}/s）`,
      apply: (s) => { s.player.stats.regen += 0.9; },
    },
    {
      id: 'speed', name: '推进器', icon: '➢', rarity: 'common', maxStacks: 6,
      desc: () => '移动速度 +11%',
      apply: (s) => { s.player.stats.speed *= 1.11; },
    },
    {
      id: 'magnet', name: '磁力场', icon: '◉', rarity: 'common', maxStacks: 5,
      desc: () => '经验拾取范围 +38%',
      apply: (s) => { s.player.stats.pickupRadius *= 1.38; },
    },
    {
      id: 'xp', name: '经验虹吸', icon: '⬢', rarity: 'rare', maxStacks: 4,
      desc: () => '获得经验 +22%',
      apply: (s) => { s.player.stats.xpMultiplier += 0.22; },
    },
    {
      id: 'dash', name: '相位引擎', icon: '⟫', rarity: 'epic', maxStacks: 3,
      desc: () => '冲刺冷却 -28%，冲刺距离 +12%',
      apply: (s) => {
        s.player.stats.dashCooldown *= 0.72;
        s.player.stats.dashSpeed *= 1.12;
      },
    },
  ];

  const RARITY_WEIGHT = { common: 10, rare: 5, epic: 2 };

  class UpgradePool {
    constructor() {
      this.stacks = new Map();
    }

    reset() { this.stacks.clear(); }

    getStacks(id) { return this.stacks.get(id) || 0; }

    /** 随机抽取 count 张互不重复、且未堆满的卡 */
    roll(count = 3) {
      const available = UPGRADES.filter((u) => this.getStacks(u.id) < u.maxStacks);
      const picked = [];
      const pool = available.slice();

      while (picked.length < count && pool.length > 0) {
        const total = pool.reduce((sum, u) => sum + RARITY_WEIGHT[u.rarity], 0);
        let roll = Math.random() * total;
        let index = 0;
        for (let i = 0; i < pool.length; i++) {
          roll -= RARITY_WEIGHT[pool[i].rarity];
          if (roll <= 0) { index = i; break; }
        }
        picked.push(pool.splice(index, 1)[0]);
      }
      return picked;
    }

    apply(upgrade, context) {
      upgrade.apply(context);
      this.stacks.set(upgrade.id, this.getStacks(upgrade.id) + 1);
    }
  }

  UpgradePool.UPGRADES = UPGRADES;
  global.UpgradePool = UpgradePool;
})(window);
