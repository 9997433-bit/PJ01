/**
 * VictoryScreen — 15 分钟通关的胜利结算（Round 3）
 *
 * 职责：
 *   1. rateRun()：把一局的统计换算成 S/A/B/C 评级。
 *      纯函数、无 DOM 依赖，评分权重全部写死在 RATING 表里，测试可直接校验边界。
 *   2. show()：把统计与评级填进 #screen-victory 的 DOM。
 *      切屏与按钮流转仍由 main.js 的状态机统一负责，这里只管「画结算」。
 *
 * 评分模型（满分 100）：
 *   击杀 30 + 等级 25 + 最高连击 15 + 通关时剩余生命 15 + 最终 Boss 速杀 15。
 *   S ≥ 85, A ≥ 65, B ≥ 45, 其余 C。
 */
(function (global) {
  'use strict';

  const MathUtils = global.MathUtils;

  const RATING = {
    kills: { max: 30, cap: 900 },       // 900 击杀拿满
    level: { max: 25, cap: 40 },        // 40 级拿满
    combo: { max: 15, cap: 80 },        // 80 连击拿满
    health: { max: 15 },                // 通关瞬间的生命比例
    bossClear: { max: 15, fast: 45, slow: 180 }, // 45 秒内速杀最终 Boss 拿满，180 秒以上 0 分
  };

  const GRADES = [
    { grade: 'S', min: 85, title: '传奇特工', color: '#ffd45e' },
    { grade: 'A', min: 65, title: '王牌特工', color: '#b78bff' },
    { grade: 'B', min: 45, title: '精英特工', color: '#7cf9ff' },
    { grade: 'C', min: 0, title: '见习特工', color: '#9db4cc' },
  ];

  function clamp01(value) {
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  }

  class VictoryScreen {
    constructor() {
      const byId = (id) => document.getElementById(id);
      this.el = {
        time: byId('victory-time'),
        level: byId('victory-level'),
        kills: byId('victory-kills'),
        combo: byId('victory-combo'),
        score: byId('victory-score'),
        character: byId('victory-character'),
        grade: byId('victory-grade'),
        gradeTitle: byId('victory-grade-title'),
      };
    }

    /**
     * 一局统计 → 评级。
     * @param {object} stats {
     *   kills, level, bestCombo, healthPercent(0~1),
     *   bossClearSeconds  最终 Boss 从出场到被击杀的秒数（未知给 Infinity）
     * }
     * @returns {{ grade:string, title:string, color:string, points:number, breakdown:object }}
     */
    static rateRun(stats = {}) {
      const r = RATING;
      const kills = Math.max(0, stats.kills || 0);
      const level = Math.max(1, stats.level || 1);
      const combo = Math.max(0, stats.bestCombo || 0);
      const health = clamp01(stats.healthPercent);
      const clearSeconds = Number.isFinite(stats.bossClearSeconds)
        ? Math.max(0, stats.bossClearSeconds)
        : Infinity;

      const breakdown = {
        kills: r.kills.max * clamp01(kills / r.kills.cap),
        level: r.level.max * clamp01(level / r.level.cap),
        combo: r.combo.max * clamp01(combo / r.combo.cap),
        health: r.health.max * health,
        bossClear: r.bossClear.max
          * clamp01(1 - (clearSeconds - r.bossClear.fast) / (r.bossClear.slow - r.bossClear.fast)),
      };

      let points = 0;
      for (const key in breakdown) {
        breakdown[key] = Math.round(breakdown[key] * 10) / 10;
        points += breakdown[key];
      }
      points = Math.round(points * 10) / 10;

      const tier = GRADES.find((g) => points >= g.min) || GRADES[GRADES.length - 1];
      return { grade: tier.grade, title: tier.title, color: tier.color, points, breakdown };
    }

    /**
     * 填充结算面板。
     * @param {object} stats 同 rateRun，另加 timeSeconds / score / characterName
     * @returns {object} rateRun 的评级结果
     */
    show(stats = {}) {
      const rating = VictoryScreen.rateRun(stats);
      const el = this.el;
      const setText = (element, value) => { if (element) element.textContent = value; };

      setText(el.time, MathUtils.formatTime(stats.timeSeconds || 0));
      setText(el.level, stats.level || 1);
      setText(el.kills, stats.kills || 0);
      setText(el.combo, stats.bestCombo || 0);
      setText(el.score, stats.score || 0);
      setText(el.character, stats.characterName || '—');
      setText(el.grade, rating.grade);
      setText(el.gradeTitle, `${rating.title} · ${rating.points} 分`);

      if (el.grade) {
        el.grade.dataset.grade = rating.grade;
        if (el.grade.style && typeof el.grade.style.setProperty === 'function') {
          el.grade.style.setProperty('--grade-color', rating.color);
        }
      }
      return rating;
    }
  }

  VictoryScreen.RATING = RATING;
  VictoryScreen.GRADES = GRADES;

  global.VictoryScreen = VictoryScreen;
})(window);
