/**
 * main.js — 游戏总装配
 * 把引擎、实体、系统与 DOM 界面接起来，并驱动整局流程。
 */
(function (global) {
  'use strict';

  const { GameState } = global.GameEngine;
  const MathUtils = global.MathUtils;

  class Game {
    constructor() {
      this.canvas = document.getElementById('game-canvas');
      this.input = new global.InputManager(document.getElementById('viewport'), {
        joystickBase: document.getElementById('joystick'),
        joystickKnob: document.getElementById('joystick-knob'),
      });

      this.engine = new global.GameEngine(this.canvas, { input: this.input });
      this.engine.background = new global.Background();
      this.engine.player = null;

      this.weaponSystem = this.engine.addSystem(new global.WeaponSystem());
      this.spawner = this.engine.addSystem(new global.Spawner());
      this.upgrades = new global.UpgradePool();
      this.hud = new global.HUD(this.engine);

      this.pendingLevelUps = 0;
      this.bestTime = Number(localStorage.getItem('eas:bestTime') || 0);

      this._cacheDom();
      this._bindUi();
      this._bindEngineEvents();

      // HUD 与快捷键需要在暂停/菜单下也保持响应
      this.engine.addSystem({
        updateAlways: (dt) => this._updateAlways(dt),
      });

      this.engine.start();
      this._showMenuScene();
    }

    /* ================= DOM ================= */

    _cacheDom() {
      const byId = (id) => document.getElementById(id);
      this.dom = {
        screens: {
          [GameState.MENU]: byId('screen-menu'),
          [GameState.PAUSED]: byId('screen-pause'),
          [GameState.LEVELUP]: byId('screen-levelup'),
          [GameState.DEAD]: byId('screen-gameover'),
        },
        hud: byId('hud'),
        cards: byId('upgrade-cards'),
        levelupLevel: byId('levelup-level'),
        resultTime: byId('result-time'),
        resultLevel: byId('result-level'),
        resultKills: byId('result-kills'),
        resultBest: byId('result-best'),
        menuBest: byId('menu-best'),
        btnStart: byId('btn-start'),
        btnResume: byId('btn-resume'),
        btnQuit: byId('btn-quit'),
        btnRetry: byId('btn-retry'),
        btnMenu: byId('btn-menu'),
        btnPause: byId('btn-pause'),
      };
      this._renderBest();
    }

    _bindUi() {
      const d = this.dom;
      // 点完立刻失焦，否则空格/回车会重复触发这颗按钮
      const on = (el, handler) => el.addEventListener('click', () => {
        el.blur();
        handler();
      });

      on(d.btnStart, () => this.startRun());
      on(d.btnResume, () => this.engine.setState(GameState.PLAYING));
      on(d.btnQuit, () => this.toMenu());
      on(d.btnRetry, () => this.startRun());
      on(d.btnMenu, () => this.toMenu());
      on(d.btnPause, () => this.engine.togglePause());
    }

    _bindEngineEvents() {
      const engine = this.engine;

      engine.events.on('state:change', ({ to }) => this._syncScreens(to));

      engine.events.on('player:levelup', ({ levels }) => {
        this.pendingLevelUps += levels;
        if (engine.state === GameState.PLAYING) this._openLevelUp();
      });

      engine.events.on('player:died', () => {
        // 死亡优先级高于升级：丢弃未消费的升级并关掉选卡界面
        this.pendingLevelUps = 0;
        this._currentChoices = null;
        // 稍等一拍，让死亡爆炸演出播完再弹结算
        setTimeout(() => {
          if (engine.isState(GameState.PLAYING, GameState.LEVELUP)) {
            this._recordResult();
            engine.setState(GameState.DEAD);
          }
        }, 900);
      });
    }

    _syncScreens(state) {
      for (const [key, el] of Object.entries(this.dom.screens)) {
        if (el) el.classList.toggle('is-visible', key === state);
      }
      this.dom.hud.classList.toggle('is-hidden', state === GameState.MENU);
      document.body.dataset.state = state;
    }

    /* ================= 流程 ================= */

    startRun() {
      const engine = this.engine;
      engine.resetWorld();
      this.upgrades.reset();
      this.pendingLevelUps = 0;
      this.menuActor = null;

      const player = new global.Player(0, 0);
      engine.player = player;
      engine.addImmediate(player);
      engine.camera.follow(player, true);
      engine.camera.setZoom(engine.camera.targetZoom, true);

      engine.particles.shockwave(0, 0, { size: 20, endSize: 260, color: '#7cf9ff', life: 0.7 });

      engine.setState(GameState.PLAYING);
      this.hud.showBanner('生存下去，特工', '任务开始');
    }

    toMenu() {
      this.engine.setState(GameState.MENU);
      this._showMenuScene();
    }

    /** 菜单里的待机场景：一只自己绕圈的蛋，纯装饰 */
    _showMenuScene() {
      const engine = this.engine;
      engine.resetWorld();

      const idle = new global.Player(0, 0);
      idle.stats.regen = 0;
      // 菜单状态下引擎不跑实体逻辑，这里手动喂一个绕圈的「输入」
      idle.update = function (dt, eng) {
        this.age += dt;
        this._updateTimers(dt);
        this.moveInput.set(Math.cos(this.age * 0.55), Math.sin(this.age * 0.8));
        this._updateMovement(dt);
        this._updateTrail(dt, eng);
        this._updateAfterImages(dt);
      };

      this.menuActor = idle;
      engine.player = idle;
      engine.addImmediate(idle);
      engine.camera.follow(idle, true);
      this._syncScreens(GameState.MENU);
    }

    _openLevelUp() {
      if (this.pendingLevelUps <= 0) return;
      this.engine.setState(GameState.LEVELUP);
      this._renderCards();
    }

    _renderCards() {
      const engine = this.engine;
      const container = this.dom.cards;
      container.innerHTML = '';
      this.dom.levelupLevel.textContent = engine.player.level;

      const choices = this.upgrades.roll(3);
      const context = { player: engine.player, weapon: this.weaponSystem.weapon, engine };

      choices.forEach((upgrade, index) => {
        const stacks = this.upgrades.getStacks(upgrade.id);
        const card = document.createElement('button');
        card.type = 'button';
        card.className = `card card--${upgrade.rarity}`;
        card.style.animationDelay = `${index * 70}ms`;
        card.innerHTML = `
          <span class="card__key">${index + 1}</span>
          <span class="card__icon">${upgrade.icon}</span>
          <span class="card__name">${upgrade.name}</span>
          <span class="card__desc">${upgrade.desc(context)}</span>
          <span class="card__meta">${upgrade.rarity.toUpperCase()}${stacks ? ` · Lv.${stacks + 1}` : ''}</span>
        `;
        card.addEventListener('click', () => this._chooseUpgrade(upgrade));
        container.appendChild(card);
      });

      this._currentChoices = choices;
    }

    _chooseUpgrade(upgrade) {
      const engine = this.engine;
      this.upgrades.apply(upgrade, {
        player: engine.player,
        weapon: this.weaponSystem.weapon,
        engine,
      });

      engine.particles.shockwave(engine.player.position.x, engine.player.position.y, {
        size: 12, endSize: 180, color: '#ffd45e', life: 0.5,
      });
      this.pendingLevelUps--;

      if (!engine.player.isAlive) {
        this.pendingLevelUps = 0;
      } else if (this.pendingLevelUps > 0) {
        this._renderCards();
      } else {
        engine.setState(GameState.PLAYING);
        this.hud.showBanner(upgrade.name, '已装备');
      }
    }

    _recordResult() {
      const engine = this.engine;
      const player = engine.player;
      this.dom.resultTime.textContent = MathUtils.formatTime(engine.elapsed);
      this.dom.resultLevel.textContent = player.level;
      this.dom.resultKills.textContent = player.kills;

      if (engine.elapsed > this.bestTime) {
        this.bestTime = engine.elapsed;
        try {
          localStorage.setItem('eas:bestTime', String(this.bestTime));
        } catch (_) { /* 隐私模式下 localStorage 可能不可用 */ }
      }
      this._renderBest();
      this.dom.resultBest.textContent = MathUtils.formatTime(this.bestTime);
    }

    _renderBest() {
      const text = this.bestTime > 0 ? MathUtils.formatTime(this.bestTime) : '--:--';
      if (this.dom.menuBest) this.dom.menuBest.textContent = text;
    }

    /* ================= 每帧 ================= */

    _updateAlways(dt) {
      const engine = this.engine;
      const input = this.input;

      if (engine.state === GameState.MENU && this.menuActor) {
        this.menuActor.update(dt, engine);
      }

      if (input.wasPressed('pause')) {
        if (engine.isState(GameState.PLAYING, GameState.PAUSED)) engine.togglePause();
      }

      if (engine.state === GameState.MENU && input.wasPressed('confirm')) {
        this.startRun();
      }

      if (engine.state === GameState.DEAD && input.wasPressed('confirm')) {
        this.startRun();
      }

      if (engine.state === GameState.LEVELUP && this._currentChoices) {
        for (let i = 0; i < this._currentChoices.length; i++) {
          if (input.wasKeyPressed(`Digit${i + 1}`)) {
            this._chooseUpgrade(this._currentChoices[i]);
            break;
          }
        }
      }

      if (engine.state !== GameState.MENU) this.hud.update(dt);
    }
  }

  const boot = () => {
    try {
      global.game = new Game();
    } catch (error) {
      console.error('[EggAgentSurvivor] 启动失败:', error);
      const fallback = document.getElementById('boot-error');
      if (fallback) {
        fallback.textContent = `启动失败: ${error.message}`;
        fallback.classList.add('is-visible');
      }
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
