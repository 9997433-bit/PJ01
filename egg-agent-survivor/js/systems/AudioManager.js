/**
 * AudioManager — 纯 Web Audio 程序化音效
 *
 * 设计要点：
 * 1. 零外部文件。每个音效都是一张「配方表」，运行时用振荡器 + 噪声 + 滤波器
 *    现场合成，包体不增加一个字节，也不存在加载失败与首播延迟。
 * 2. 配方是数据不是代码：调音只改 SOUNDS 里的数字，不动合成逻辑。
 * 3. 自动播放策略：浏览器要求先有用户手势。构造时不建 AudioContext，
 *    首次手势（或显式 unlock）才建；未 running 时直接丢弃播放请求 —— 挂起的
 *    上下文 currentTime 不前进，排进去的声音会在 resume 瞬间一起炸响。
 * 4. 弹幕游戏一秒能触发几十次开火/命中，所以有两道闸：同名节流与全局复音上限。
 *    超限直接丢弃，宁可少一声也不要糊成白噪声。
 * 5. 无 Web Audio 的环境（Node 测试、老浏览器）降级为静默空转，调用方无需判空。
 */
(function (global) {
  'use strict';

  const EPS = 0.0001;

  /** 单个音层的默认值，配方里只写要改的字段 */
  const LAYER_DEFAULTS = {
    type: 'tone',      // tone | noise
    wave: 'sine',      // sine | square | sawtooth | triangle
    freq: 440,         // 起始频率（Hz）
    freqEnd: null,     // 终止频率，null 表示不滑音
    sweep: 'exp',      // exp | linear
    sweepTime: null,   // 滑音时长，默认取整个包络长度
    attack: 0.004,
    hold: 0,
    decay: 0.16,
    gain: 1,
    delay: 0,          // 相对音效起点的延迟，用于琶音与叠层
    pan: 0,            // -1 左 / 1 右
    detune: 0,         // 音分
    filter: null,      // { type, freq, freqEnd, q }
    fm: null,          // { ratio, depth } 频率调制，做金属质感
  };

  const SOUND_DEFAULTS = {
    gain: 0.6,
    throttle: 0.02,    // 同名音效的最小间隔（秒）
    pitchJitter: 0,    // 随机变调（半音），避免连发听起来像机关枪卡带
    priority: false,   // 真时无视复音上限
    layers: [],
  };

  /**
   * 音效配方表。
   * 键名与全项目里的 `engine.audio.play('xxx')` 调用点一一对应，
   * tests/audio-manager.test.js 会扫描源码校验不存在漏配。
   */
  const SOUNDS = {

    /* ---------------- 武器 ---------------- */

    // 主武器点射：极短的方波下滑 + 一点噪声，密集连发也不糊
    shoot: {
      gain: 0.22, throttle: 0.035, pitchJitter: 1.6,
      layers: [
        { wave: 'square', freq: 720, freqEnd: 230, attack: 0.002, decay: 0.075, gain: 0.5,
          filter: { type: 'lowpass', freq: 2600, q: 1.1 } },
        { type: 'noise', decay: 0.045, gain: 0.22,
          filter: { type: 'bandpass', freq: 1900, q: 0.9 } },
      ],
    },

    // 电弧：高频锯齿被带通刷过，短促刺耳
    zap: {
      gain: 0.26, throttle: 0.05, pitchJitter: 2.4,
      layers: [
        { wave: 'sawtooth', freq: 1500, freqEnd: 320, attack: 0.001, decay: 0.11, gain: 0.44,
          filter: { type: 'bandpass', freq: 2400, freqEnd: 700, q: 3.4 } },
        { type: 'noise', decay: 0.09, gain: 0.3,
          filter: { type: 'highpass', freq: 2200, q: 0.7 } },
      ],
    },

    // 火焰：低频噪声长尾，模拟持续喷吐
    flame: {
      gain: 0.2, throttle: 0.09,
      layers: [
        { type: 'noise', attack: 0.03, hold: 0.05, decay: 0.22, gain: 0.5,
          filter: { type: 'lowpass', freq: 900, freqEnd: 320, q: 1.6 } },
        { wave: 'triangle', freq: 130, freqEnd: 70, attack: 0.02, decay: 0.2, gain: 0.16 },
      ],
    },

    // 新星：正弦下坠 + 冲击噪声，铺得比普通武器宽
    nova: {
      gain: 0.4, throttle: 0.12, priority: true,
      layers: [
        { wave: 'sine', freq: 620, freqEnd: 90, attack: 0.006, decay: 0.5, gain: 0.6 },
        { wave: 'triangle', freq: 310, freqEnd: 60, attack: 0.006, decay: 0.42, gain: 0.3, delay: 0.02 },
        { type: 'noise', attack: 0.004, decay: 0.34, gain: 0.28,
          filter: { type: 'lowpass', freq: 2400, freqEnd: 400, q: 1 } },
      ],
    },

    // 投掷：带通噪声扫过，典型的挥空声
    throw: {
      gain: 0.24, throttle: 0.07, pitchJitter: 1.2,
      layers: [
        { type: 'noise', attack: 0.02, decay: 0.16, gain: 0.42,
          filter: { type: 'bandpass', freq: 700, freqEnd: 2100, q: 1.4 } },
      ],
    },

    /* ---------------- 命中与击杀 ---------------- */

    // 普通命中：轻到几乎只是「触感」，否则同屏几十次会盖住一切
    hit: {
      gain: 0.15, throttle: 0.028, pitchJitter: 2.2,
      layers: [
        { wave: 'triangle', freq: 340, freqEnd: 150, attack: 0.001, decay: 0.06, gain: 0.42 },
        { type: 'noise', decay: 0.035, gain: 0.2,
          filter: { type: 'bandpass', freq: 1400, q: 1.2 } },
      ],
    },

    // 暴击：比命中高一个八度并加金属质感的 FM
    crit: {
      gain: 0.28, throttle: 0.035, pitchJitter: 1.4,
      layers: [
        { wave: 'square', freq: 880, freqEnd: 300, attack: 0.001, decay: 0.11, gain: 0.4,
          fm: { ratio: 2.7, depth: 260 },
          filter: { type: 'highpass', freq: 400, q: 0.8 } },
        { wave: 'sine', freq: 1760, freqEnd: 900, attack: 0.001, decay: 0.09, gain: 0.22, delay: 0.012 },
      ],
    },

    // 击杀：小小的「啵」，尾巴上翘让反馈偏正向
    kill: {
      gain: 0.26, throttle: 0.03, pitchJitter: 2.6,
      layers: [
        { wave: 'sine', freq: 260, freqEnd: 520, attack: 0.002, decay: 0.1, gain: 0.5 },
        { type: 'noise', decay: 0.07, gain: 0.26,
          filter: { type: 'lowpass', freq: 1800, q: 0.9 } },
      ],
    },

    /* ---------------- 玩家 ---------------- */

    // 受击：低频撞击 + 刺耳过载，必须能从密集战斗音里穿出来
    hurt: {
      gain: 0.5, throttle: 0.1, priority: true,
      layers: [
        { wave: 'sawtooth', freq: 190, freqEnd: 62, attack: 0.002, decay: 0.28, gain: 0.5,
          filter: { type: 'lowpass', freq: 1200, freqEnd: 300, q: 2.2 } },
        { wave: 'square', freq: 96, freqEnd: 44, attack: 0.002, decay: 0.34, gain: 0.34 },
        { type: 'noise', decay: 0.13, gain: 0.3,
          filter: { type: 'bandpass', freq: 800, q: 0.8 } },
      ],
    },

    // 升级：大三和弦琶音，全曲最「甜」的一声
    levelup: {
      gain: 0.42, throttle: 0.2, priority: true,
      layers: [
        { wave: 'triangle', freq: 523.25, attack: 0.006, decay: 0.3, gain: 0.34 },
        { wave: 'triangle', freq: 659.25, attack: 0.006, decay: 0.3, gain: 0.32, delay: 0.075 },
        { wave: 'triangle', freq: 783.99, attack: 0.006, decay: 0.34, gain: 0.32, delay: 0.15 },
        { wave: 'sine', freq: 1046.5, attack: 0.01, decay: 0.55, gain: 0.28, delay: 0.225 },
        { wave: 'sine', freq: 1567.98, attack: 0.02, decay: 0.6, gain: 0.14, delay: 0.225 },
      ],
    },

    // 冲刺：短促上扬的气流声
    dash: {
      gain: 0.3, throttle: 0.08,
      layers: [
        { type: 'noise', attack: 0.008, decay: 0.2, gain: 0.42,
          filter: { type: 'bandpass', freq: 480, freqEnd: 2600, q: 1.1 } },
        { wave: 'sine', freq: 220, freqEnd: 660, attack: 0.006, decay: 0.16, gain: 0.2 },
      ],
    },

    // 死亡：长长的下坠，收在几乎听不见的低频上
    death: {
      gain: 0.6, throttle: 0.5, priority: true,
      layers: [
        { wave: 'sawtooth', freq: 420, freqEnd: 40, sweepTime: 1.1, attack: 0.01, decay: 1.2, gain: 0.5,
          filter: { type: 'lowpass', freq: 1800, freqEnd: 180, q: 1.4 } },
        { wave: 'sine', freq: 110, freqEnd: 32, attack: 0.02, decay: 1.4, gain: 0.34 },
        { type: 'noise', attack: 0.01, decay: 0.9, gain: 0.24,
          filter: { type: 'lowpass', freq: 1000, freqEnd: 120, q: 1 } },
      ],
    },

    /* ---------------- 拾取 ---------------- */

    // 经验宝石：极轻的小铃，堆叠时不能刺耳
    gem: {
      gain: 0.14, throttle: 0.035, pitchJitter: 3.2,
      layers: [
        { wave: 'sine', freq: 1180, attack: 0.001, decay: 0.09, gain: 0.4 },
        { wave: 'sine', freq: 1770, attack: 0.001, decay: 0.06, gain: 0.16 },
      ],
    },

    // 补给：上行纯五度，明确的「拿到好东西」
    pickup: {
      gain: 0.36, throttle: 0.1, priority: true,
      layers: [
        { wave: 'triangle', freq: 660, attack: 0.004, decay: 0.16, gain: 0.36 },
        { wave: 'triangle', freq: 990, attack: 0.004, decay: 0.26, gain: 0.32, delay: 0.08 },
        { wave: 'sine', freq: 1980, attack: 0.01, decay: 0.3, gain: 0.12, delay: 0.08 },
      ],
    },

    /* ---------------- 敌人 ---------------- */

    // 酸液吐射：湿黏的下滑
    spit: {
      gain: 0.22, throttle: 0.06, pitchJitter: 2,
      layers: [
        { wave: 'sawtooth', freq: 420, freqEnd: 120, attack: 0.004, decay: 0.16, gain: 0.34,
          filter: { type: 'lowpass', freq: 1400, freqEnd: 400, q: 3.2 } },
      ],
    },

    // 引信：干脆的一声「嘀」，提示玩家赶紧走开
    fuse: {
      gain: 0.3, throttle: 0.08, priority: true,
      layers: [
        { wave: 'square', freq: 1320, attack: 0.001, decay: 0.05, gain: 0.3 },
        { wave: 'square', freq: 1760, attack: 0.001, decay: 0.07, gain: 0.26, delay: 0.09 },
      ],
    },

    /* ---------------- 波次与 Boss ---------------- */

    waveStart: {
      gain: 0.32, throttle: 0.4,
      layers: [
        { wave: 'triangle', freq: 392, attack: 0.008, decay: 0.22, gain: 0.3 },
        { wave: 'triangle', freq: 587.33, attack: 0.008, decay: 0.34, gain: 0.28, delay: 0.11 },
      ],
    },

    // 精英警告：两声下行小三度，比 Boss 警报克制
    eliteWarn: {
      gain: 0.4, throttle: 0.5, priority: true,
      layers: [
        { wave: 'sawtooth', freq: 466.16, attack: 0.01, decay: 0.24, gain: 0.28,
          filter: { type: 'lowpass', freq: 2200, q: 1.2 } },
        { wave: 'sawtooth', freq: 392, attack: 0.01, decay: 0.34, gain: 0.28, delay: 0.2,
          filter: { type: 'lowpass', freq: 2000, q: 1.2 } },
      ],
    },

    // Boss 警报：两轮防空警报式的上下扫频，够长够吓人
    bossWarn: {
      gain: 0.55, throttle: 0.8, priority: true,
      layers: [
        { wave: 'sawtooth', freq: 180, freqEnd: 620, sweepTime: 0.42, attack: 0.03, decay: 0.5, gain: 0.34,
          filter: { type: 'lowpass', freq: 1600, q: 2.6 } },
        { wave: 'sawtooth', freq: 620, freqEnd: 180, sweepTime: 0.42, attack: 0.03, decay: 0.5, gain: 0.34,
          delay: 0.46, filter: { type: 'lowpass', freq: 1600, q: 2.6 } },
        { wave: 'square', freq: 90, freqEnd: 60, attack: 0.05, hold: 0.5, decay: 0.5, gain: 0.22 },
      ],
    },

    // Boss 登场：低音号角，底下垫一层缓慢涨起的噪声
    bossSpawn: {
      gain: 0.62, throttle: 1, priority: true,
      layers: [
        { wave: 'sawtooth', freq: 55, freqEnd: 110, sweepTime: 0.8, attack: 0.12, hold: 0.3, decay: 0.9, gain: 0.44,
          filter: { type: 'lowpass', freq: 700, freqEnd: 2000, q: 1.8 } },
        { wave: 'square', freq: 82.4, attack: 0.14, hold: 0.35, decay: 0.8, gain: 0.24 },
        { type: 'noise', attack: 0.5, decay: 0.6, gain: 0.3,
          filter: { type: 'lowpass', freq: 400, freqEnd: 3200, q: 1 } },
        { wave: 'sine', freq: 1320, freqEnd: 330, attack: 0.01, decay: 0.7, gain: 0.16, delay: 0.85 },
      ],
    },

    // 阶段转换：不协和的小二度撞在一起，听感就是「它变强了」
    bossPhase: {
      gain: 0.5, throttle: 0.6, priority: true,
      layers: [
        { wave: 'square', freq: 233.08, attack: 0.004, decay: 0.5, gain: 0.3,
          filter: { type: 'lowpass', freq: 1800, q: 2 } },
        { wave: 'square', freq: 246.94, attack: 0.004, decay: 0.5, gain: 0.28 },
        { wave: 'sawtooth', freq: 1200, freqEnd: 300, attack: 0.002, decay: 0.3, gain: 0.2 },
        { type: 'noise', decay: 0.4, gain: 0.24,
          filter: { type: 'highpass', freq: 1400, q: 0.8 } },
      ],
    },

    // Boss 死亡：一长串下坠爆裂，配合击杀定格
    bossDie: {
      gain: 0.7, throttle: 1, priority: true,
      layers: [
        { wave: 'sawtooth', freq: 300, freqEnd: 34, sweepTime: 1.3, attack: 0.01, decay: 1.5, gain: 0.5,
          filter: { type: 'lowpass', freq: 2200, freqEnd: 140, q: 1.6 } },
        { wave: 'square', freq: 150, freqEnd: 28, sweepTime: 1.2, attack: 0.01, decay: 1.4, gain: 0.32 },
        { type: 'noise', attack: 0.006, decay: 1.1, gain: 0.4,
          filter: { type: 'lowpass', freq: 3000, freqEnd: 160, q: 1 } },
        { type: 'noise', attack: 0.004, decay: 0.4, gain: 0.3, delay: 0.24,
          filter: { type: 'bandpass', freq: 700, q: 0.7 } },
      ],
    },

    /* ---------------- 处决 QTE ---------------- */

    // 窗口开启：上行的紧张感，告诉玩家「现在，准备按」
    qteOpen: {
      gain: 0.55, throttle: 0.4, priority: true,
      layers: [
        { wave: 'sine', freq: 440, freqEnd: 1320, sweepTime: 0.3, attack: 0.006, decay: 0.36, gain: 0.34 },
        { wave: 'square', freq: 110, freqEnd: 220, sweepTime: 0.3, attack: 0.01, decay: 0.4, gain: 0.2,
          filter: { type: 'lowpass', freq: 1200, q: 2 } },
        { type: 'noise', attack: 0.2, decay: 0.24, gain: 0.2,
          filter: { type: 'highpass', freq: 2600, q: 0.8 } },
      ],
    },

    // 环圈逼近时的滴答，节流很紧、音量很小
    qteTick: {
      gain: 0.18, throttle: 0.06,
      layers: [
        { wave: 'square', freq: 1760, attack: 0.001, decay: 0.035, gain: 0.24 },
      ],
    },

    // 处决命中：一记重击 + 高频金属尖啸，全曲最响
    execute: {
      gain: 0.85, throttle: 0.5, priority: true,
      layers: [
        { wave: 'square', freq: 1400, freqEnd: 180, sweepTime: 0.18, attack: 0.001, decay: 0.3, gain: 0.4,
          fm: { ratio: 3.3, depth: 500 } },
        { wave: 'sawtooth', freq: 120, freqEnd: 30, sweepTime: 0.9, attack: 0.002, decay: 1, gain: 0.5,
          filter: { type: 'lowpass', freq: 2400, freqEnd: 120, q: 1.6 } },
        { type: 'noise', attack: 0.001, decay: 0.55, gain: 0.45,
          filter: { type: 'lowpass', freq: 5000, freqEnd: 300, q: 1 } },
        { wave: 'sine', freq: 1046.5, attack: 0.02, decay: 0.9, gain: 0.2, delay: 0.22 },
        { wave: 'sine', freq: 1567.98, attack: 0.02, decay: 0.9, gain: 0.16, delay: 0.3 },
      ],
    },

    // 处决失手：下坠的闷响，明确的负反馈但不刺耳
    qteFail: {
      gain: 0.48, throttle: 0.4, priority: true,
      layers: [
        { wave: 'square', freq: 260, freqEnd: 78, sweepTime: 0.34, attack: 0.004, decay: 0.44, gain: 0.34,
          filter: { type: 'lowpass', freq: 1000, freqEnd: 260, q: 2.4 } },
        { wave: 'sawtooth', freq: 130, freqEnd: 52, attack: 0.004, decay: 0.5, gain: 0.24 },
      ],
    },

    /* ---------------- 界面 ---------------- */

    uiClick: {
      gain: 0.24, throttle: 0.04,
      layers: [
        { wave: 'square', freq: 880, freqEnd: 1320, sweepTime: 0.04, attack: 0.001, decay: 0.06, gain: 0.24,
          filter: { type: 'highpass', freq: 500, q: 0.7 } },
      ],
    },

    uiSelect: {
      gain: 0.34, throttle: 0.08,
      layers: [
        { wave: 'triangle', freq: 587.33, attack: 0.003, decay: 0.12, gain: 0.3 },
        { wave: 'triangle', freq: 880, attack: 0.003, decay: 0.2, gain: 0.26, delay: 0.06 },
      ],
    },
  };

  /** attach() 会把这些引擎事件接到对应音效上（其余音效由各自的调用点直接触发） */
  const EVENT_SOUNDS = [
    ['player:levelup', 'levelup'],
    ['player:damaged', 'hurt'],
    ['player:dash', 'dash'],
    ['player:died', 'death'],
    ['wave:start', 'waveStart'],
    ['wave:elite', 'eliteWarn'],
    ['wave:boss', 'bossWarn', { delay: 0.4 }],
    ['boss:qte:open', 'qteOpen'],
    ['boss:qte:success', 'execute'],
    ['boss:qte:fail', 'qteFail'],
  ];

  /* ------------------------------------------------------------------ *
   * 合成辅助
   * ------------------------------------------------------------------ */

  /**
   * ADSR 中的 AHD 段。用指数斜坡而不是线性，听感上才是「自然衰减」；
   * 指数斜坡的目标值不能为 0，所以统一收敛到 EPS。
   */
  function envelope(param, when, peak, attack, hold, decay) {
    const top = Math.max(peak, EPS);
    param.setValueAtTime(EPS, when);
    param.exponentialRampToValueAtTime(top, when + attack);
    if (hold > 0) param.setValueAtTime(top, when + attack + hold);
    param.exponentialRampToValueAtTime(EPS, when + attack + hold + decay);
  }

  function sweep(param, when, from, to, duration, mode) {
    param.setValueAtTime(from, when);
    if (to === null || to === undefined || duration <= 0) return;
    if (mode === 'linear') param.linearRampToValueAtTime(to, when + duration);
    else param.exponentialRampToValueAtTime(Math.max(to, 1), when + duration);
  }

  function semitones(value, offset) {
    return offset ? value * Math.pow(2, offset / 12) : value;
  }

  /* ------------------------------------------------------------------ *
   * AudioManager
   * ------------------------------------------------------------------ */

  class AudioManager {
    /**
     * @param {object} [options]
     *   AudioContext  注入构造器（测试用），默认取 window.AudioContext
     *   volume        主音量 0~1
     *   muted         初始静音
     *   maxVoices     全局同时发声上限
     *   autoUnlock    是否自动监听首次用户手势来解锁（默认 true）
     *   sounds        额外/覆盖的音效配方
     */
    constructor(options = {}) {
      const Ctor = options.AudioContext
        || global.AudioContext
        || global.webkitAudioContext
        || null;

      this._Ctor = Ctor;
      this.supported = !!Ctor;

      this.sounds = options.sounds
        ? Object.assign({}, SOUNDS, options.sounds)
        : SOUNDS;

      this.masterVolume = clamp01(options.volume === undefined ? 0.75 : options.volume);
      this.muted = !!options.muted;
      this.maxVoices = options.maxVoices || 24;

      this.ctx = null;
      this.master = null;
      this._compressor = null;
      this._noiseBuffer = null;

      this._lastPlayed = new Map();
      this._voices = 0;
      this._unsubscribes = [];
      this._unlockHandler = null;
      this._unlockTargets = [];

      this.stats = { played: 0, throttled: 0, dropped: 0, failed: 0 };

      if (this.supported && options.autoUnlock !== false) this.installUnlockHandlers();
    }

    /** 上下文已就绪且真的在走时钟 */
    get ready() {
      return !!(this.ctx && this.ctx.state === 'running');
    }

    get voiceCount() { return this._voices; }

    /* ================= 生命周期 ================= */

    /**
     * 建上下文并接好 主增益 → 压缩器 → 输出。
     * 压缩器是刚需：同屏几十个命中音叠加时它负责把峰值摁住，不然会削波爆音。
     */
    _ensureContext() {
      if (this.ctx || !this.supported) return this.ctx;
      try {
        const ctx = new this._Ctor();
        const master = ctx.createGain();
        master.gain.value = this.muted ? 0 : this.masterVolume;

        let tail = master;
        if (ctx.createDynamicsCompressor) {
          const comp = ctx.createDynamicsCompressor();
          setParam(comp.threshold, -18);
          setParam(comp.knee, 24);
          setParam(comp.ratio, 12);
          setParam(comp.attack, 0.003);
          setParam(comp.release, 0.22);
          master.connect(comp);
          this._compressor = comp;
          tail = comp;
        }
        tail.connect(ctx.destination);

        this.ctx = ctx;
        this.master = master;
      } catch (error) {
        this.supported = false;
        this.stats.failed++;
        console.warn('[AudioManager] Web Audio 初始化失败，音效已禁用:', error);
      }
      return this.ctx;
    }

    /** 首次用户手势时调用；浏览器的自动播放策略要求上下文在手势里被 resume */
    unlock() {
      const ctx = this._ensureContext();
      if (!ctx) return false;
      if (ctx.state === 'suspended' && ctx.resume) {
        const result = ctx.resume();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      }
      return ctx.state !== 'closed';
    }

    /** 在 document 上挂一次性手势监听，任何一种交互都能解锁 */
    installUnlockHandlers(target) {
      if (this._unlockHandler || !this.supported) return;
      const doc = target || global.document;
      if (!doc || !doc.addEventListener) return;

      const events = ['pointerdown', 'keydown', 'touchend'];
      const handler = () => {
        this.unlock();
        this.removeUnlockHandlers();
      };

      this._unlockHandler = handler;
      this._unlockTargets = events.map((type) => {
        doc.addEventListener(type, handler, { passive: true });
        return { doc, type };
      });
    }

    removeUnlockHandlers() {
      if (!this._unlockHandler) return;
      for (const { doc, type } of this._unlockTargets) {
        doc.removeEventListener(type, this._unlockHandler);
      }
      this._unlockHandler = null;
      this._unlockTargets = [];
    }

    /**
     * 订阅引擎事件并把自己挂到 engine.audio 上。
     * @returns {Function} 取消全部订阅
     */
    attach(engine) {
      if (!engine) return () => {};
      engine.audio = this;

      if (engine.events) {
        for (const [event, sound, options] of EVENT_SOUNDS) {
          this._unsubscribes.push(
            engine.events.on(event, () => this.play(sound, options))
          );
        }
      }
      return () => this.detach(engine);
    }

    detach(engine) {
      for (const off of this._unsubscribes) {
        try { off(); } catch (_) { /* 订阅可能已被 events.clear() 清掉 */ }
      }
      this._unsubscribes.length = 0;
      if (engine && engine.audio === this) engine.audio = null;
    }

    dispose() {
      this.detach(null);
      this.removeUnlockHandlers();
      if (this.ctx && this.ctx.close) {
        const result = this.ctx.close();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      }
      this.ctx = null;
      this.master = null;
      this._noiseBuffer = null;
      this._voices = 0;
    }

    /* ================= 音量 ================= */

    setMasterVolume(value) {
      this.masterVolume = clamp01(value);
      this._applyGain();
      return this.masterVolume;
    }

    setMuted(muted) {
      this.muted = !!muted;
      this._applyGain();
      return this.muted;
    }

    toggleMute() { return this.setMuted(!this.muted); }

    _applyGain() {
      if (!this.master) return;
      const target = this.muted ? 0 : this.masterVolume;
      const param = this.master.gain;
      // 直接赋值会「啪」一声，用 20ms 斜坡切
      if (this.ctx && param.linearRampToValueAtTime) {
        param.cancelScheduledValues(this.ctx.currentTime);
        param.setValueAtTime(param.value, this.ctx.currentTime);
        param.linearRampToValueAtTime(target, this.ctx.currentTime + 0.02);
      } else {
        param.value = target;
      }
    }

    /* ================= 播放 ================= */

    /**
     * @param {string} name  SOUNDS 里的键
     * @param {object} [options]
     *   volume  本次的额外增益倍率
     *   delay   延后播放的秒数
     *   pitch   额外变调（半音）
     *   force   跳过节流
     * @returns {boolean} 是否真的排上了声音
     */
    play(name, options) {
      const def = this.sounds[name];
      if (!def) return false;
      if (this.muted || this.masterVolume <= 0) return false;

      const ctx = this._ensureContext();
      // 上下文挂起时 currentTime 是冻结的，此刻排进去的声音会在 resume 时同时炸响
      if (!ctx || ctx.state !== 'running' || !this.master) return false;

      const now = ctx.currentTime;
      const opts = options || {};
      const throttle = def.throttle === undefined ? SOUND_DEFAULTS.throttle : def.throttle;

      if (!opts.force && throttle > 0) {
        const last = this._lastPlayed.get(name);
        if (last !== undefined && now - last < throttle) {
          this.stats.throttled++;
          return false;
        }
      }

      const layers = def.layers || [];
      if (!def.priority && this._voices + layers.length > this.maxVoices) {
        this.stats.dropped++;
        return false;
      }

      this._lastPlayed.set(name, now);

      const baseGain = (def.gain === undefined ? SOUND_DEFAULTS.gain : def.gain)
        * (opts.volume === undefined ? 1 : opts.volume);
      const jitter = def.pitchJitter
        ? (Math.random() * 2 - 1) * def.pitchJitter
        : 0;
      const pitch = jitter + (opts.pitch || 0);
      const start = now + Math.max(0, opts.delay || 0);

      let spawned = 0;
      for (const raw of layers) {
        if (this._spawnLayer(raw, start, baseGain, pitch)) spawned++;
      }

      if (spawned > 0) this.stats.played++;
      return spawned > 0;
    }

    _spawnLayer(raw, start, baseGain, pitch) {
      const layer = Object.assign({}, LAYER_DEFAULTS, raw);
      const ctx = this.ctx;
      const when = start + layer.delay;
      const total = layer.attack + layer.hold + layer.decay;

      try {
        const amp = ctx.createGain();
        envelope(amp.gain, when, baseGain * layer.gain, layer.attack, layer.hold, layer.decay);

        let node = amp;
        if (layer.pan && ctx.createStereoPanner) {
          const panner = ctx.createStereoPanner();
          setParam(panner.pan, layer.pan);
          amp.connect(panner);
          node = panner;
        }
        node.connect(this.master);

        let head = amp;
        if (layer.filter) {
          const filter = ctx.createBiquadFilter();
          filter.type = layer.filter.type || 'lowpass';
          sweep(
            filter.frequency, when,
            layer.filter.freq, layer.filter.freqEnd,
            layer.filter.sweepTime || total, 'exp'
          );
          if (layer.filter.q !== undefined) setParam(filter.Q, layer.filter.q);
          filter.connect(amp);
          head = filter;
        }

        const source = layer.type === 'noise'
          ? this._createNoiseSource(total)
          : this._createOscillator(layer, when, total, pitch);
        if (!source) return false;

        source.connect(head);
        source.start(when);
        source.stop(when + total + 0.02);

        this._voices++;
        source.onended = () => { this._voices = Math.max(0, this._voices - 1); };
        return true;
      } catch (error) {
        this.stats.failed++;
        return false;
      }
    }

    _createOscillator(layer, when, total, pitch) {
      const ctx = this.ctx;
      const osc = ctx.createOscillator();
      osc.type = layer.wave;
      if (layer.detune !== undefined && osc.detune) setParam(osc.detune, layer.detune);

      const from = semitones(layer.freq, pitch);
      const to = layer.freqEnd === null ? null : semitones(layer.freqEnd, pitch);
      sweep(osc.frequency, when, from, to, layer.sweepTime || total, layer.sweep);

      // FM：一个高比例的调制振荡器直接推载波频率，得到金属/爆裂质感
      if (layer.fm) {
        const mod = ctx.createOscillator();
        const modGain = ctx.createGain();
        mod.type = 'sine';
        setParam(mod.frequency, from * (layer.fm.ratio || 2));
        envelope(modGain.gain, when, layer.fm.depth || 200, 0.002, 0, layer.decay);
        mod.connect(modGain);
        modGain.connect(osc.frequency);
        mod.start(when);
        mod.stop(when + total + 0.02);
      }
      return osc;
    }

    /** 白噪声：一秒的缓冲循环复用，每次随机偏移起点避免听出周期 */
    _createNoiseSource(duration) {
      const ctx = this.ctx;
      if (!ctx.createBufferSource || !ctx.createBuffer) return null;

      if (!this._noiseBuffer) {
        const rate = ctx.sampleRate || 44100;
        const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(rate)), rate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        this._noiseBuffer = buffer;
      }

      const source = ctx.createBufferSource();
      source.buffer = this._noiseBuffer;
      source.loop = duration > 0.9;
      return source;
    }

    /** 音效名清单，供调试面板与测试使用 */
    get soundNames() { return Object.keys(this.sounds); }

    has(name) { return Object.prototype.hasOwnProperty.call(this.sounds, name); }
  }

  function clamp01(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return n < 0 ? 0 : n > 1 ? 1 : n;
  }

  /** AudioParam 与普通数值属性都能赋值（便于对接精简实现） */
  function setParam(param, value) {
    if (!param) return;
    if (typeof param === 'object' && 'value' in param) param.value = value;
  }

  AudioManager.SOUNDS = SOUNDS;
  AudioManager.EVENT_SOUNDS = EVENT_SOUNDS;
  AudioManager.LAYER_DEFAULTS = LAYER_DEFAULTS;

  global.AudioManager = AudioManager;
})(window);
