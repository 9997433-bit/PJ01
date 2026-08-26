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

      // 音效先于一切系统就位：Enemy / Weapon / Collision 都会直接调 engine.audio
      this.audio = new global.AudioManager(loadAudioPrefs());
      this.audio.attach(this.engine);

      // 顺序即执行顺序：碰撞系统先重建敌人网格，武器与刷怪才能查询到最新战场
      this.collisions = this.engine.addSystem(new global.CollisionSystem());
      this.weaponSystem = this.engine.addSystem(new global.WeaponSystem());
      this.spawner = this.engine.addSystem(new global.EnemySpawner());
      this.upgrades = this.engine.addSystem(new global.UpgradeSystem({
        weapons: this.weaponSystem,
      }));

      // 反馈层排在战斗系统之后：这一帧的击杀先结算完，再决定怎么演。
      // ComboSystem 必须早于 JuiceSystem 注册，否则击杀爆炸读到的是上一档倍率。
      this.combo = this.engine.addSystem(new global.ComboSystem());
      this.juice = this.engine.addSystem(new global.JuiceSystem());
      // 屏外指示器最后注册，drawScreen 才会盖在 Boss 血条与波次条之上
      this.indicators = this.engine.addSystem(new global.OffscreenIndicator());

      this.hud = new global.HUD(this.engine);
      this.engine.hud = this.hud;

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
        resultCombo: byId('result-combo'),
        resultScore: byId('result-score'),
        resultBest: byId('result-best'),
        menuBest: byId('menu-best'),
        btnStart: byId('btn-start'),
        btnResume: byId('btn-resume'),
        btnQuit: byId('btn-quit'),
        btnRetry: byId('btn-retry'),
        btnMenu: byId('btn-menu'),
        btnPause: byId('btn-pause'),
        btnMute: byId('btn-mute'),
        muteGlyph: byId('mute-glyph'),
        btnReroll: byId('btn-reroll'),
        rerollCount: byId('reroll-count'),
      };
      this._renderBest();
      this._renderMute();
    }

    _bindUi() {
      const d = this.dom;
      // 点完立刻失焦，否则空格/回车会重复触发这颗按钮
      const on = (el, handler) => el.addEventListener('click', () => {
        el.blur();
        // 每次点击都顺手解锁音频：浏览器只在用户手势里允许 resume
        this.audio.unlock('uiClick');
        handler();
      });

      on(d.btnStart, () => this.startRun());
      on(d.btnResume, () => this.engine.setState(GameState.PLAYING));
      on(d.btnQuit, () => this.toMenu());
      on(d.btnRetry, () => this.startRun());
      on(d.btnMenu, () => this.toMenu());
      on(d.btnPause, () => this.engine.togglePause());
      if (d.btnMute) on(d.btnMute, () => this.toggleMute());
      if (d.btnReroll) on(d.btnReroll, () => this._rerollCards());
    }

    /* ================= 音效 ================= */

    toggleMute() {
      const muted = this.audio.toggleMute();
      try {
        localStorage.setItem('eas:muted', muted ? '1' : '0');
      } catch (_) { /* 隐私模式下 localStorage 可能不可用 */ }
      this._renderMute();
      // 取消静音时给一声确认，否则玩家不确定是否真的开了
      if (!muted) this.audio.play('uiSelect');
      return muted;
    }

    _renderMute() {
      const { btnMute, muteGlyph } = this.dom;
      const muted = this.audio.muted;
      if (muteGlyph) muteGlyph.textContent = muted ? '✕' : '♪';
      if (btnMute) {
        btnMute.classList.toggle('is-off', muted);
        btnMute.setAttribute('aria-pressed', muted ? 'true' : 'false');
      }
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

    _upgradeContext() {
      return {
        player: this.engine.player,
        engine: this.engine,
        weapons: this.weaponSystem,
      };
    }

    _renderCards() {
      this.dom.levelupLevel.textContent = this.engine.player.level;
      this.upgrades.roll(3);
      this._paintCards();
    }

    /** 只重画卡面，不重新抽卡（重随 / 消除之后复用） */
    _paintCards() {
      this._currentChoices = this.upgrades.renderCards(
        this.dom.cards,
        this._upgradeContext(),
        (card) => this._chooseUpgrade(card)
      );
      if (this.dom.rerollCount) this.dom.rerollCount.textContent = this.upgrades.rerolls;
      if (this.dom.btnReroll) this.dom.btnReroll.disabled = !this.upgrades.canReroll();
    }

    _rerollCards() {
      if (this.engine.state !== GameState.LEVELUP) return;
      if (!this.upgrades.reroll()) return;
      this._paintCards();
    }

    _chooseUpgrade(upgrade) {
      const engine = this.engine;
      this.audio.play('uiSelect');
      this.upgrades.apply(upgrade, this._upgradeContext());

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
      if (this.dom.resultCombo) this.dom.resultCombo.textContent = this.combo.best;
      if (this.dom.resultScore) this.dom.resultScore.textContent = this.combo.score;

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

      if (input.wasPressed('mute')) this.toggleMute();

      if (engine.state === GameState.MENU && input.wasPressed('confirm')) {
        this.startRun();
      }

      if (engine.state === GameState.DEAD && input.wasPressed('confirm')) {
        this.startRun();
      }

      if (engine.state === GameState.LEVELUP && this._currentChoices) {
        if (input.wasKeyPressed('KeyR')) {
          this._rerollCards();
        } else {
          for (let i = 0; i < this._currentChoices.length; i++) {
            if (input.wasKeyPressed(`Digit${i + 1}`)) {
              this._chooseUpgrade(this._currentChoices[i]);
              break;
            }
          }
        }
      }

      if (engine.state !== GameState.MENU) this.hud.update(dt);
    }
  }

  /** 音量与静音偏好；隐私模式下 localStorage 会抛错，静默退回默认值 */
  function loadAudioPrefs() {
    const prefs = { volume: 0.75, muted: false };
    try {
      // 没存过时 getItem 返回 null，而 Number(null) 是 0 —— 直接用就等于默认静音了
      const stored = localStorage.getItem('eas:volume');
      if (stored !== null && stored !== '') {
        const volume = Number(stored);
        if (Number.isFinite(volume) && volume >= 0 && volume <= 1) prefs.volume = volume;
      }
      prefs.muted = localStorage.getItem('eas:muted') === '1';
    } catch (_) { /* 忽略，用默认值 */ }
    return prefs;
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
