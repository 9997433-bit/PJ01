/**
 * BuildOverview — 构筑总览面板
 *
 * 一局跑到十几分钟时，玩家手上已经有六把武器、二十来层被动和一堆元素反应，
 * 光看 HUD 根本说不清「我这套构筑到底强在哪、下一步该点什么」。这个面板把
 * 四件事摊开：武器与它们的实际输出占比、吃到的被动层数、核心属性、
 * 元素解锁进度与反应统计（含当前可用的融合）。
 *
 * 交互：Tab 键或 HUD 上的 ⌗ 按钮开关。
 *   - 战斗中打开会顺手暂停（面板是查询而非操作，不该让玩家边看边挨打），
 *     且只有「因面板而暂停」时关闭才会自动恢复战斗；
 *   - 升级三选一时打开不动状态机，方便对着卡面比对构筑；
 *   - 任何离开 PAUSED / LEVELUP 的状态迁移都会顺手收起面板。
 *
 * 面板内容用 innerHTML 一次性写入：它只在打开时与每 0.5 秒刷新一次，
 * 不在每帧路径上，可读性比手搓 DOM 树划算得多。
 */
(function (global) {
  'use strict';

  const MathUtils = global.MathUtils;
  const REFRESH_INTERVAL = 0.5;
  const NEUTRAL_COLOR = '#7cf9ff';
  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/[&<>"']/g, (char) => ESCAPES[char]);
  }

  /** 1.24 → "+24%"：被动多为乘区，看增量比看绝对值直观 */
  function delta(multiplier) {
    const value = Math.round((multiplier - 1) * 100);
    return `${value >= 0 ? '+' : ''}${value}%`;
  }

  function percent(ratio) {
    return `${Math.round(ratio * 100)}%`;
  }

  function statRow(label, value) {
    return `<div class="ov-stat"><span class="ov-stat__label">${escapeHtml(label)}</span>`
      + `<span class="ov-stat__value">${escapeHtml(value)}</span></div>`;
  }

  function section(title, meta, body) {
    return `<section class="ov-section">
      <h3 class="ov-section__title">${escapeHtml(title)}
        ${meta ? `<span class="ov-section__meta">${escapeHtml(meta)}</span>` : ''}
      </h3>
      ${body}
    </section>`;
  }

  function emptyHint(text) {
    return `<p class="ov-empty">${escapeHtml(text)}</p>`;
  }

  class BuildOverview {
    constructor(engine) {
      this.engine = engine;
      this.visible = false;
      /** 只有「因本面板而暂停」时，关闭才负责把战斗恢复回来 */
      this._pausedByPanel = false;
      this._refreshTimer = 0;

      this.el = {
        root: document.getElementById('build-overview'),
        body: document.getElementById('build-body'),
        toggle: document.getElementById('btn-build'),
        close: document.getElementById('btn-build-close'),
      };

      if (this.el.toggle) {
        this.el.toggle.addEventListener('click', () => {
          this.el.toggle.blur();
          this.toggle();
        });
      }
      if (this.el.close) {
        this.el.close.addEventListener('click', () => this.close());
      }

      engine.events.on('state:change', ({ to }) => {
        const GameState = global.GameState;
        if (to !== GameState.PAUSED && to !== GameState.LEVELUP) this.close();
      });

      this._syncDom();
    }

    /* ================= 开关 ================= */

    toggle() {
      if (this.visible) this.close();
      else this.open();
      return this.visible;
    }

    open() {
      if (this.visible) return false;
      const engine = this.engine;
      const GameState = global.GameState;
      if (!engine.isState(GameState.PLAYING, GameState.PAUSED, GameState.LEVELUP)) return false;

      if (engine.state === GameState.PLAYING) {
        if (!engine.setState(GameState.PAUSED)) return false;
        this._pausedByPanel = true;
      }

      this.visible = true;
      this._refreshTimer = REFRESH_INTERVAL;
      this.render();
      this._syncDom();
      return true;
    }

    close() {
      if (!this.visible) return false;
      this.visible = false;
      this._syncDom();

      if (this._pausedByPanel) {
        this._pausedByPanel = false;
        // ESC 已经把游戏放回 PLAYING 时这里什么都不做，避免多余的状态迁移
        if (this.engine.state === global.GameState.PAUSED) {
          this.engine.setState(global.GameState.PLAYING);
        }
      }
      return true;
    }

    _syncDom() {
      const { root, toggle } = this.el;
      if (root) {
        root.classList.toggle('is-visible', this.visible);
        if (root.setAttribute) root.setAttribute('aria-hidden', this.visible ? 'false' : 'true');
      }
      if (toggle) {
        toggle.classList.toggle('is-on', this.visible);
        if (toggle.setAttribute) toggle.setAttribute('aria-expanded', this.visible ? 'true' : 'false');
      }
    }

    /** 由 main.js 的 updateAlways 驱动：打开期间低频刷新，关闭时零成本 */
    update(dt) {
      if (!this.visible) return;
      this._refreshTimer -= dt;
      if (this._refreshTimer > 0) return;
      this._refreshTimer = REFRESH_INTERVAL;
      this.render();
    }

    /* ================= 渲染 ================= */

    render() {
      const body = this.el.body;
      if (!body) return '';
      const html = this._summary()
        + this._weapons()
        + this._elements()
        + this._passives()
        + this._stats();
      body.innerHTML = html;
      return html;
    }

    _summary() {
      const engine = this.engine;
      const player = engine.player;
      const weapons = engine.weapons;
      const combo = engine.combo;
      const cells = [
        ['等级', player ? player.level : 0],
        ['生存', MathUtils.formatTime(engine.elapsed)],
        ['击杀', player ? player.kills : 0],
        ['总伤害', weapons ? Math.round(weapons.totalDamage) : 0],
        ['最高连击', combo ? combo.best : 0],
      ];
      return `<div class="ov-summary">${cells.map(([label, value]) => `
        <div class="ov-summary__cell">
          <span class="ov-summary__value">${escapeHtml(value)}</span>
          <span class="ov-summary__label">${escapeHtml(label)}</span>
        </div>`).join('')}</div>`;
    }

    /** 武器列表按实际输出降序：占比条才是「这把武器值不值得继续点」的答案 */
    _weapons() {
      const weapons = this.engine.weapons;
      const slots = weapons && weapons.snapshot ? weapons.snapshot() : [];
      if (!slots.length) return section('武器', '', emptyHint('尚未装备武器'));

      const total = slots.reduce((sum, slot) => sum + slot.damage, 0);
      const sorted = slots.slice().sort((a, b) => b.damage - a.damage);
      const rows = sorted.map((slot) => {
        const [primary, secondary] = this._elementColors(slot.elements);
        const share = total > 0 ? slot.damage / total : 0;
        const elements = slot.elements.map((id) => this._elementName(id)).join(' + ');
        return `<li class="ov-weapon${slot.isFusion ? ' is-fusion' : ''}"
            style="--ov-color:${escapeHtml(primary)};--ov-color-2:${escapeHtml(secondary)}">
          <span class="ov-weapon__icon">${escapeHtml(slot.icon)}</span>
          <span class="ov-weapon__main">
            <span class="ov-weapon__name">${escapeHtml(slot.name)}
              ${slot.isFusion ? '<em class="ov-tag">融合</em>' : ''}
              ${elements ? `<em class="ov-elements">${escapeHtml(elements)}</em>` : ''}
            </span>
            <span class="ov-weapon__bar"><i style="width:${percent(share)}"></i></span>
          </span>
          <span class="ov-weapon__meta">
            <b class="${slot.maxed ? 'is-max' : ''}">Lv.${slot.level}/${slot.maxLevel}</b>
            <span>${escapeHtml(slot.damage)} 伤害 · ${percent(share)}</span>
          </span>
        </li>`;
      }).join('');

      const capacity = weapons.maxSlots ? `${slots.length}/${weapons.maxSlots} 槽位` : '';
      return section('武器', capacity, `<ul class="ov-weapons">${rows}</ul>`);
    }

    /** 元素解锁进度 + 反应统计 + 当前可执行的融合 */
    _elements() {
      const fusion = this.engine.fusion;
      if (!fusion) return '';

      const progress = fusion.elementProgress().map((entry) => `
        <li class="ov-element${entry.ready ? ' is-ready' : ''}" style="--ov-color:${escapeHtml(entry.color)}">
          <span class="ov-element__icon">${escapeHtml(entry.icon)}</span>
          <span class="ov-element__name">${escapeHtml(entry.name)}</span>
          <span class="ov-element__level">${entry.level}/${entry.unlockLevel}</span>
        </li>`).join('');

      const available = fusion.availableFusions();
      const ready = available.length
        ? `<ul class="ov-fusions">${available.map((candidate) => `
            <li class="ov-fusion">
              <span class="ov-fusion__icon">${escapeHtml(candidate.cfg.icon)}</span>
              <span>${escapeHtml(candidate.sources[0].def.name)} × ${escapeHtml(candidate.sources[1].def.name)}
                → <b>${escapeHtml(candidate.cfg.name)}</b></span>
            </li>`).join('')}</ul>`
        : emptyHint(`把两种不同元素的武器都升到 Lv.${fusion.config.fusion.unlockLevel}，融合卡就会出现在三选一里`);

      const stats = fusion.stats;
      const reactions = Object.keys(stats.perReaction)
        .sort((a, b) => stats.perReaction[b] - stats.perReaction[a])
        .slice(0, 6)
        .map((id) => {
          const cfg = fusion.reactionById(id);
          return `<li class="ov-reaction" style="--ov-color:${escapeHtml(cfg ? cfg.color : NEUTRAL_COLOR)}">
            <span>${escapeHtml(cfg ? `${cfg.icon} ${cfg.name}` : id)}</span>
            <b>${stats.perReaction[id]}</b>
          </li>`;
        }).join('');

      const meta = `反应 ${stats.reactions} 次 · ${Math.round(stats.reactionDamage)} 伤害`;
      return section('元素与融合', meta, `
        <ul class="ov-elements-grid">${progress}</ul>
        ${ready}
        ${reactions ? `<ul class="ov-reactions">${reactions}</ul>` : ''}`);
    }

    _passives() {
      const upgrades = this.engine.upgrades;
      const list = global.UpgradeSystem ? global.UpgradeSystem.PASSIVES : null;
      if (!upgrades || !list) return '';

      const taken = list
        .map((passive) => ({ passive, stacks: upgrades.getStacks(passive.id) }))
        .filter((entry) => entry.stacks > 0)
        .sort((a, b) => b.stacks - a.stacks);

      const body = taken.length
        ? `<ul class="ov-passives">${taken.map(({ passive, stacks }) => `
            <li class="ov-passive">
              <span class="ov-passive__icon">${escapeHtml(passive.icon)}</span>
              <span class="ov-passive__name">${escapeHtml(passive.name)}</span>
              <b class="ov-passive__stacks">×${stacks}</b>
            </li>`).join('')}</ul>`
        : emptyHint('还没有吃到被动强化');

      return section('被动强化', `${upgrades.picks} 次选择 · 重随 ${upgrades.rerolls}`, body);
    }

    _stats() {
      const player = this.engine.player;
      if (!player || !player.stats) return '';
      const s = player.stats;
      const rows = [
        statRow('伤害', delta(s.damageMultiplier)),
        statRow('冷却', delta(s.cooldownMultiplier)),
        statRow('范围', delta(s.areaMultiplier)),
        statRow('持续', delta(s.durationMultiplier)),
        statRow('暴击', `${percent(s.critChance)} / ×${(s.critMultiplier).toFixed(2)}`),
        statRow('生命', `${Math.ceil(player.health)} / ${Math.round(s.maxHealth)}`),
        statRow('回复', `${s.regen.toFixed(1)}/s`),
        statRow('护甲', s.armor),
        statRow('移速', Math.round(s.speed)),
        statRow('额外投射', `+${s.extraProjectiles}`),
        statRow('幸运', percent(s.luck)),
        statRow('荆棘', s.thorns),
      ].join('');
      return section('属性', '', `<div class="ov-stats">${rows}</div>`);
    }

    /* ================= 小工具 ================= */

    _elementColors(elements) {
      const fusion = this.engine.fusion;
      if (!fusion || !elements || !elements.length) return [NEUTRAL_COLOR, NEUTRAL_COLOR];
      const primary = fusion.elementColor(elements[0]);
      return [primary, elements.length > 1 ? fusion.elementColor(elements[1]) : primary];
    }

    _elementName(id) {
      const fusion = this.engine.fusion;
      const cfg = fusion && fusion.config.elements[id];
      return cfg ? `${cfg.icon}${cfg.name}` : id;
    }
  }

  global.BuildOverview = BuildOverview;
})(window);
