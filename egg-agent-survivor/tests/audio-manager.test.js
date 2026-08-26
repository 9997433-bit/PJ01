'use strict';

/**
 * AudioManager 单元测试
 *
 * 程序化音效没有「听一下」这种自动化手段，所以这里用一个严格的假 AudioContext
 * 顶替浏览器实现：它按 Web Audio 规范拒绝非法参数（比如指数斜坡的目标值必须为正），
 * 于是「所有配方都能播放且不抛异常」这条用例就等价于把每张配方表的包络数学
 * 完整验算了一遍。
 *
 * 另外扫描全项目的 `engine.audio.play('xxx')` 调用点，防止调用方与配方表脱节 ——
 * 漏配一个键名在浏览器里只是「某个音效没了」，很难被发现。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const AUDIO_SRC = path.join(ROOT, 'js/systems/AudioManager.js');

/* ------------------------------------------------------------------ *
 * 假 Web Audio
 * ------------------------------------------------------------------ */

/** 按规范校验入参的 AudioParam，非法调度直接抛错 */
function createParam(value) {
  return {
    value,
    events: [],
    setValueAtTime(v, t) {
      assertFinite(v, 'setValueAtTime value');
      assertFinite(t, 'setValueAtTime time');
      this.value = v;
      this.events.push(['set', v, t]);
      return this;
    },
    linearRampToValueAtTime(v, t) {
      assertFinite(v, 'linearRamp value');
      assertFinite(t, 'linearRamp time');
      this.events.push(['linear', v, t]);
      return this;
    },
    exponentialRampToValueAtTime(v, t) {
      assertFinite(v, 'exponentialRamp value');
      assertFinite(t, 'exponentialRamp time');
      // 规范要求：指数斜坡的目标值必须严格大于 0
      if (v <= 0) throw new RangeError(`exponentialRampToValueAtTime 目标值必须为正，收到 ${v}`);
      this.events.push(['exp', v, t]);
      return this;
    },
    cancelScheduledValues(t) {
      this.events.push(['cancel', t]);
      return this;
    },
  };
}

function assertFinite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} 必须是有限数字，收到 ${value}`);
  }
}

function createFakeAudioContext() {
  const log = { nodes: [], oscillators: [], buffers: [], connections: 0, started: 0, stopped: 0 };

  function track(kind, node) {
    node.kind = kind;
    node.connect = (dest) => { log.connections++; node.dest = dest; return dest; };
    node.disconnect = () => {};
    log.nodes.push(node);
    return node;
  }

  function schedulable(node) {
    node.started = null;
    node.stoppedAt = null;
    node.onended = null;
    node.start = (t) => {
      assertFinite(t, 'start time');
      if (node.started !== null) throw new Error('同一个源节点不能 start 两次');
      node.started = t;
      log.started++;
    };
    node.stop = (t) => {
      assertFinite(t, 'stop time');
      if (node.started === null) throw new Error('未 start 的源节点不能 stop');
      if (t < node.started) throw new RangeError('stop 时间早于 start');
      node.stoppedAt = t;
      log.stopped++;
    };
    return node;
  }

  const ctx = {
    state: 'suspended',
    currentTime: 0,
    sampleRate: 44100,
    destination: track('destination', {}),
    log,

    resume() { ctx.state = 'running'; return Promise.resolve(); },
    suspend() { ctx.state = 'suspended'; return Promise.resolve(); },
    close() { ctx.state = 'closed'; return Promise.resolve(); },

    createGain() {
      return track('gain', { gain: createParam(1) });
    },
    createOscillator() {
      const osc = schedulable(track('oscillator', {
        type: 'sine',
        frequency: createParam(440),
        detune: createParam(0),
      }));
      log.oscillators.push(osc);
      return osc;
    },
    createBiquadFilter() {
      return track('filter', {
        type: 'lowpass',
        frequency: createParam(350),
        Q: createParam(1),
        detune: createParam(0),
      });
    },
    createDynamicsCompressor() {
      return track('compressor', {
        threshold: createParam(-24),
        knee: createParam(30),
        ratio: createParam(12),
        attack: createParam(0.003),
        release: createParam(0.25),
      });
    },
    createStereoPanner() {
      return track('panner', { pan: createParam(0) });
    },
    createBuffer(channels, length, sampleRate) {
      const data = new Float32Array(length);
      const buffer = { numberOfChannels: channels, length, sampleRate, getChannelData: () => data };
      log.buffers.push(buffer);
      return buffer;
    },
    createBufferSource() {
      return schedulable(track('bufferSource', { buffer: null, loop: false }));
    },
  };

  return ctx;
}

/** 记录 document 上挂了哪些一次性解锁监听 */
function createDocumentStub() {
  const listeners = [];
  return {
    listeners,
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    removeEventListener(type, fn) {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
}

/** 在隔离上下文里加载 AudioManager.js */
function loadAudioManager(options = {}) {
  const documentStub = createDocumentStub();
  const win = { console: { warn() {}, error() {}, log() {} }, document: documentStub };
  win.window = win;
  win.self = win;
  if (options.withGlobalAudioContext) {
    win.AudioContext = function () { return createFakeAudioContext(); };
  }

  const context = vm.createContext(win);
  vm.runInContext(fs.readFileSync(AUDIO_SRC, 'utf8'), context, { filename: AUDIO_SRC });
  return { win, documentStub, AudioManager: win.AudioManager };
}

/** 建一个已解锁、可立刻发声的管理器 */
function createRunningManager(overrides = {}) {
  const { AudioManager, documentStub } = loadAudioManager();
  let ctx = null;
  const manager = new AudioManager(Object.assign({
    AudioContext: function () { ctx = createFakeAudioContext(); return ctx; },
    autoUnlock: false,
  }, overrides));
  manager.unlock();
  return { manager, get ctx() { return ctx; }, documentStub, AudioManager };
}

/** 最小事件总线，形状与引擎的 EventBus 一致 */
function createEventBus() {
  const handlers = new Map();
  return {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
      return () => handlers.get(event).delete(fn);
    },
    emit(event, payload) {
      for (const fn of handlers.get(event) || []) fn(payload);
    },
    count(event) { return (handlers.get(event) || new Set()).size; },
  };
}

/* ------------------------------------------------------------------ *
 * 加载与降级
 * ------------------------------------------------------------------ */

test('脚本加载后挂出 window.AudioManager 与配方表', () => {
  const { AudioManager } = loadAudioManager();
  assert.equal(typeof AudioManager, 'function');
  assert.ok(AudioManager.SOUNDS, '应当导出配方表供调试与测试使用');
  assert.ok(Object.keys(AudioManager.SOUNDS).length > 15, '音效数量看起来不完整');
});

test('没有 Web Audio 的环境降级为静默，且不抛异常', () => {
  const { AudioManager } = loadAudioManager();
  const manager = new AudioManager({ autoUnlock: false });

  assert.equal(manager.supported, false);
  assert.equal(manager.ready, false);
  assert.equal(manager.play('shoot'), false);
  assert.equal(manager.unlock(), false);
  // 全套接口都要能安全空转
  manager.setMasterVolume(0.5);
  manager.setMuted(true);
  manager.toggleMute();
  manager.dispose();
});

test('存在 window.AudioContext 时自动识别为可用', () => {
  const { AudioManager } = loadAudioManager({ withGlobalAudioContext: true });
  const manager = new AudioManager({ autoUnlock: false });
  assert.equal(manager.supported, true);
});

/* ------------------------------------------------------------------ *
 * 解锁与自动播放策略
 * ------------------------------------------------------------------ */

test('未解锁（上下文 suspended）时不排任何声音', () => {
  const { AudioManager } = loadAudioManager();
  let ctx = null;
  const manager = new AudioManager({
    AudioContext: function () { ctx = createFakeAudioContext(); return ctx; },
    autoUnlock: false,
  });

  assert.equal(manager.play('shoot'), false, '挂起的上下文里排声音会在 resume 时一起炸响');
  assert.equal(ctx.log.started, 0);

  manager.unlock();
  assert.equal(ctx.state, 'running');
  assert.equal(manager.ready, true);
  assert.equal(manager.play('shoot'), true);
  assert.ok(ctx.log.started > 0);
});

test('unlock 可以补播一声：resume 是异步的，手势当下 play() 会被丢掉', async () => {
  const { AudioManager } = loadAudioManager();
  let ctx = null;
  const manager = new AudioManager({
    AudioContext: function () { ctx = createFakeAudioContext(); return ctx; },
    autoUnlock: false,
  });

  assert.equal(manager.play('uiClick'), false, '解锁前直接播会被丢掉');
  manager.unlock('uiClick');
  assert.equal(manager.stats.played, 0, 'resume 尚未完成时不应当已经发声');

  await Promise.resolve();
  await Promise.resolve();

  assert.equal(ctx.state, 'running');
  assert.equal(manager.stats.played, 1, 'resume 完成后应当补播那一声');
});

test('已解锁时 unlock 的补播立即生效', () => {
  const { manager } = createRunningManager();
  manager.unlock('uiSelect');
  assert.equal(manager.stats.played, 1);
});

test('autoUnlock 在首次手势后解锁并摘掉监听', () => {
  const { AudioManager, documentStub } = loadAudioManager();
  let ctx = null;
  const manager = new AudioManager({
    AudioContext: function () { ctx = createFakeAudioContext(); return ctx; },
  });

  const types = documentStub.listeners.map((l) => l.type);
  assert.ok(types.includes('pointerdown') && types.includes('keydown'),
    '应当同时覆盖鼠标与键盘手势');

  documentStub.listeners[0].fn();
  assert.equal(ctx.state, 'running');
  assert.equal(documentStub.listeners.length, 0, '解锁后监听必须全部摘掉');

  manager.dispose();
});

/* ------------------------------------------------------------------ *
 * 合成
 * ------------------------------------------------------------------ */

test('播放会建立 源 → 滤波 → 增益 → 主总线 的完整链路', () => {
  const { manager, ctx } = createRunningManager();
  assert.equal(manager.play('shoot'), true);

  const kinds = ctx.log.nodes.map((n) => n.kind);
  assert.ok(kinds.includes('oscillator'), 'shoot 有一层振荡器');
  assert.ok(kinds.includes('bufferSource'), 'shoot 有一层噪声');
  assert.ok(kinds.includes('filter'), 'shoot 两层都带滤波');
  assert.ok(kinds.includes('compressor'), '主总线上要有压缩器压住叠加峰值');
  assert.equal(ctx.log.started, 2, 'shoot 恰好两层');
  assert.ok(ctx.log.stopped >= ctx.log.started, '每个源都必须被安排停止，否则振荡器泄漏');
});

test('噪声缓冲只生成一次并被复用', () => {
  const { manager, ctx } = createRunningManager();
  manager.play('flame', { force: true });
  ctx.currentTime += 1;
  manager.play('throw', { force: true });
  assert.equal(ctx.log.buffers.length, 1, '白噪声缓冲应当缓存复用');
});

test('每一张配方都能完整合成，且不违反 AudioParam 的取值约束', () => {
  const { manager, ctx } = createRunningManager({ maxVoices: 10000 });

  for (const name of manager.soundNames) {
    ctx.currentTime += 5; // 跨过节流
    assert.equal(manager.play(name), true, `音效 ${name} 没能播放`);
  }
  assert.equal(manager.stats.failed, 0, `有配方在合成时抛了异常：${JSON.stringify(manager.stats)}`);
});

test('未知音效名安全返回 false', () => {
  const { manager } = createRunningManager();
  assert.equal(manager.play('nope'), false);
  assert.equal(manager.has('nope'), false);
  assert.equal(manager.has('shoot'), true);
});

test('随机变调不会把频率推出合法范围', () => {
  const { manager, ctx } = createRunningManager();
  for (let i = 0; i < 60; i++) {
    ctx.currentTime += 1;
    manager.play('shoot');
  }
  for (const osc of ctx.log.oscillators) {
    for (const [, value] of osc.frequency.events) {
      assert.ok(value > 0 && value < 22050, `频率 ${value} 超出可听范围`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * 限流
 * ------------------------------------------------------------------ */

test('同名音效在节流窗口内被丢弃，窗口外恢复', () => {
  const { manager, ctx } = createRunningManager();

  assert.equal(manager.play('shoot'), true);
  assert.equal(manager.play('shoot'), false, '同一时刻的第二发应当被节流');
  assert.equal(manager.stats.throttled, 1);

  ctx.currentTime += 0.5;
  assert.equal(manager.play('shoot'), true, '过了节流窗口应当恢复');
});

test('force 可以绕过节流', () => {
  const { manager } = createRunningManager();
  assert.equal(manager.play('qteTick'), true);
  assert.equal(manager.play('qteTick'), false);
  assert.equal(manager.play('qteTick', { force: true }), true);
});

test('复音超上限时丢弃普通音效，但放行 priority', () => {
  const { manager, ctx } = createRunningManager({ maxVoices: 2 });

  assert.equal(manager.play('shoot'), true, 'shoot 两层，正好占满');
  ctx.currentTime += 1;
  assert.equal(manager.play('hit'), false, '超出上限的普通音效应当被丢弃');
  assert.equal(manager.stats.dropped, 1);

  ctx.currentTime += 1;
  assert.equal(manager.play('hurt'), true, '受击是 priority，必须响');
});

test('源节点结束后归还复音额度', () => {
  const { manager, ctx } = createRunningManager({ maxVoices: 2 });
  manager.play('shoot');
  assert.equal(manager.voiceCount, 2);

  for (const node of ctx.log.nodes) {
    if (node.onended) node.onended();
  }
  assert.equal(manager.voiceCount, 0);

  ctx.currentTime += 1;
  assert.equal(manager.play('hit'), true, '额度归还后应当能继续发声');
});

/* ------------------------------------------------------------------ *
 * 音量与静音
 * ------------------------------------------------------------------ */

test('主音量夹取到 0~1，非法输入退回 0', () => {
  const { manager } = createRunningManager();
  assert.equal(manager.setMasterVolume(2), 1);
  assert.equal(manager.setMasterVolume(-3), 0);
  assert.equal(manager.setMasterVolume('abc'), 0);
  assert.equal(manager.setMasterVolume(0.35), 0.35);
});

test('静音时完全不发声，取消静音后恢复', () => {
  const { manager, ctx } = createRunningManager();

  assert.equal(manager.setMuted(true), true);
  assert.equal(manager.play('levelup'), false);
  assert.equal(ctx.log.started, 0);

  assert.equal(manager.toggleMute(), false);
  assert.equal(manager.play('levelup'), true);
  assert.ok(ctx.log.started > 0);
});

test('音量为 0 等价于静音', () => {
  const { manager } = createRunningManager();
  manager.setMasterVolume(0);
  assert.equal(manager.play('levelup'), false);
});

/* ------------------------------------------------------------------ *
 * 引擎接线
 * ------------------------------------------------------------------ */

test('attach 挂到 engine.audio 并把引擎事件接到对应音效', () => {
  const { manager, ctx, AudioManager } = createRunningManager();
  const engine = { events: createEventBus() };

  const detach = manager.attach(engine);
  assert.equal(engine.audio, manager);

  for (const [event] of AudioManager.EVENT_SOUNDS) {
    assert.equal(engine.events.count(event), 1, `事件 ${event} 应当被订阅一次`);
  }

  ctx.currentTime += 1;
  engine.events.emit('player:levelup', { levels: 1 });
  assert.equal(manager.stats.played, 1, '升级事件应当触发一次音效');

  ctx.currentTime += 1;
  engine.events.emit('player:damaged', { amount: 10 });
  assert.equal(manager.stats.played, 2, '受击事件应当触发一次音效');

  detach();
  assert.equal(engine.audio, null);
  ctx.currentTime += 1;
  engine.events.emit('player:levelup', { levels: 1 });
  assert.equal(manager.stats.played, 2, 'detach 之后不应再发声');
});

test('dispose 关闭上下文并摘掉解锁监听', () => {
  const { AudioManager, documentStub } = loadAudioManager();
  let ctx = null;
  const manager = new AudioManager({
    AudioContext: function () { ctx = createFakeAudioContext(); return ctx; },
  });
  manager.unlock();
  manager.dispose();

  assert.equal(ctx.state, 'closed');
  assert.equal(documentStub.listeners.length, 0);
  assert.equal(manager.ctx, null);
});

/* ------------------------------------------------------------------ *
 * 与调用方的一致性
 * ------------------------------------------------------------------ */

test('全项目里 audio.play() 用到的音效名都在配方表中', () => {
  const { AudioManager } = loadAudioManager();
  const known = new Set(Object.keys(AudioManager.SOUNDS));
  const missing = [];

  for (const file of collectScripts(path.join(ROOT, 'js'))) {
    // AudioManager 自己的调用参数是变量，扫了也没有意义
    if (file === AUDIO_SRC) continue;
    const source = fs.readFileSync(file, 'utf8');
    const calls = source.matchAll(/audio\.play\(([^)]*)\)/g);
    for (const call of calls) {
      for (const literal of call[1].matchAll(/'([^']+)'/g)) {
        if (!known.has(literal[1])) {
          missing.push(`${path.relative(ROOT, file)} → '${literal[1]}'`);
        }
      }
    }
  }

  assert.deepEqual(missing, [], `这些调用点没有对应的音效配方：\n${missing.join('\n')}`);
});

test('EVENT_SOUNDS 里的音效名都真实存在', () => {
  const { AudioManager } = loadAudioManager();
  for (const [event, sound] of AudioManager.EVENT_SOUNDS) {
    assert.ok(AudioManager.SOUNDS[sound], `事件 ${event} 绑定了不存在的音效 ${sound}`);
  }
});

function collectScripts(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectScripts(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}
