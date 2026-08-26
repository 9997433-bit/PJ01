'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function createStyle() {
  return {
    values: new Map(),
    setProperty(name, value) {
      this.values.set(name, value);
    },
    getPropertyValue(name) {
      return this.values.get(name) || '';
    },
  };
}

function loadHud(initialWidth = 390, initialHeight = 844) {
  const dimensions = { width: initialWidth, height: initialHeight };
  const listeners = new Map();
  const elements = new Map();

  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        dataset: {},
        style: createStyle(),
        classList: { add() {}, remove() {}, toggle() {} },
        getBoundingClientRect: () => (
          id === 'viewport'
            ? { left: 0, top: 0, ...dimensions }
            : { left: 0, top: 0, width: 0, height: 0 }
        ),
      });
    }
    return elements.get(id);
  }

  const win = {
    console,
    document: { getElementById: element },
    innerWidth: dimensions.width,
    innerHeight: dimensions.height,
    MathUtils: {
      clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
      formatTime: () => '00:00',
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const registered = listeners.get(type) || [];
      const index = registered.indexOf(handler);
      if (index >= 0) registered.splice(index, 1);
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    setTimeout,
    clearTimeout,
  };
  win.window = win;

  vm.runInNewContext(read('js/ui/HUD.js'), win, { filename: 'js/ui/HUD.js' });

  const engine = {
    events: { on() {} },
  };
  const hud = new win.HUD(engine);

  return {
    dimensions,
    elements,
    fire(type) {
      for (const handler of listeners.get(type) || []) handler();
    },
    hud,
    win,
  };
}

function loadInputManager(width, height, computedValues) {
  const targetListeners = new Map();
  const documentListeners = new Map();
  const joystickBase = {
    style: {},
    classList: {
      active: false,
      add() { this.active = true; },
      remove() { this.active = false; },
    },
  };
  const joystickKnob = { style: {} };

  function addListener(store, type, handler) {
    if (!store.has(type)) store.set(type, []);
    store.get(type).push(handler);
  }

  const target = {
    addEventListener(type, handler) { addListener(targetListeners, type, handler); },
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
  };
  const documentStub = {
    body: target,
    addEventListener(type, handler) { addListener(documentListeners, type, handler); },
    removeEventListener() {},
  };
  const win = {
    console,
    document: documentStub,
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({
      getPropertyValue: (name) => computedValues[name] || '',
    }),
  };
  win.window = win;

  const context = vm.createContext(win);
  vm.runInContext(read('js/utils/Vector2.js'), context, { filename: 'js/utils/Vector2.js' });
  vm.runInContext(read('js/utils/InputManager.js'), context, { filename: 'js/utils/InputManager.js' });

  const input = new win.InputManager(target, { joystickBase, joystickKnob });
  const fire = (store, type, event) => {
    for (const handler of store.get(type) || []) handler(event);
  };

  return {
    input,
    joystickBase,
    pointerDown(event) { fire(targetListeners, 'pointerdown', event); },
    pointerMove(event) { fire(documentListeners, 'pointermove', event); },
    pointerUp(event) { fire(documentListeners, 'pointerup', event); },
  };
}

test('HUD viewport breakpoints cover phone, tablet, landscape, and exact boundaries', () => {
  const { win } = loadHud();
  const cases = [
    [320, 568, 'portrait'],
    [375, 667, 'portrait'],
    [390, 844, 'portrait'],
    [620, 844, 'portrait'],
    [620, 520, 'compact'],
    [621, 844, 'compact'],
    [768, 1024, 'compact'],
    [860, 900, 'compact'],
    [861, 521, 'wide'],
    [1024, 500, 'compact'],
  ];

  for (const [width, height, expected] of cases) {
    assert.equal(
      win.HUD.layoutForViewport(width, height).name,
      expected,
      `${width}×${height} should use ${expected}`,
    );
  }
});

test('HUD updates layout data and joystick reserves after rotation', () => {
  const setup = loadHud(390, 844);
  const root = setup.elements.get('hud');
  const viewport = setup.elements.get('viewport');

  assert.equal(root.dataset.layout, 'portrait');
  assert.equal(viewport.dataset.hudLayout, 'portrait');
  assert.equal(viewport.style.getPropertyValue('--hud-top-reserve'), '108px');
  assert.equal(viewport.style.getPropertyValue('--hud-bottom-reserve'), '12px');

  setup.dimensions.width = 568;
  setup.dimensions.height = 320;
  setup.fire('resize');

  assert.equal(root.dataset.layout, 'compact');
  assert.equal(viewport.style.getPropertyValue('--hud-top-reserve'), '64px');

  setup.dimensions.width = 1024;
  setup.dimensions.height = 768;
  setup.fire('orientationchange');

  assert.equal(root.dataset.layout, 'wide');
  assert.equal(viewport.style.getPropertyValue('--hud-bottom-reserve'), '82px');
});

test('dynamic joystick stays below safe HUD area and inside the left control half', () => {
  const width = 390;
  const height = 844;
  const safeTop = 47 + 108;
  const safeBottom = 34 + 12;
  const setup = loadInputManager(width, height, {
    '--joystick-safe-left': 'calc(0px + 8px)',
    '--joystick-safe-right': 'calc(0px + 8px)',
    '--joystick-safe-top': `calc(47px + 108px)`,
    '--joystick-safe-bottom': 'calc(34px + 12px)',
  });
  const plainTarget = { closest: () => null };

  setup.pointerDown({
    clientX: 190,
    clientY: 10,
    pointerId: 1,
    pointerType: 'touch',
    target: plainTarget,
  });

  const radius = setup.input.joystick.radius;
  const origin = setup.input.joystick.origin;
  assert.equal(radius, 48);
  assert.ok(origin.y - radius >= safeTop, 'joystick ring must start below the safe HUD edge');
  assert.ok(origin.y + radius <= height - safeBottom, 'joystick ring must clear the home indicator');
  assert.ok(origin.x + radius <= width / 2 - 8, 'joystick ring must remain in the left half');

  setup.pointerMove({
    clientX: 190,
    clientY: 0,
    pointerId: 1,
    pointerType: 'touch',
    target: plainTarget,
  });
  assert.ok(
    Number.parseFloat(setup.joystickBase.style.top) - radius >= safeTop,
    'dragging must not pull the joystick under the HUD',
  );
});

test('dynamic joystick ignores the right half and interactive HUD controls', () => {
  const setup = loadInputManager(390, 844, {});
  const plainTarget = { closest: () => null };

  setup.pointerDown({
    clientX: 300,
    clientY: 500,
    pointerId: 1,
    pointerType: 'touch',
    target: plainTarget,
  });
  assert.equal(setup.input.joystick.active, false);

  setup.pointerDown({
    clientX: 100,
    clientY: 40,
    pointerId: 2,
    pointerType: 'touch',
    target: { closest: () => ({ tagName: 'BUTTON' }) },
  });
  assert.equal(setup.input.joystick.active, false);
});

test('mobile CSS declares safe areas, dynamic viewport units, and all R2 breakpoints', () => {
  const css = read('css/style.css');

  for (const side of ['top', 'right', 'bottom', 'left']) {
    assert.match(css, new RegExp(`env\\(safe-area-inset-${side}, 0px\\)`));
    assert.match(css, new RegExp(`--joystick-safe-${side}:`));
  }
  assert.match(css, /height:\s*100dvh/);
  assert.match(css, /@media\s*\(max-width:\s*860px\)/);
  assert.match(css, /@media\s*\(max-width:\s*620px\)/);
  assert.match(css, /@media\s*\(max-width:\s*430px\)/);
  assert.match(css, /@media\s*\(max-height:\s*520px\)\s*and\s*\(orientation:\s*landscape\)/);
  assert.match(css, /#hud\[data-layout="compact"\]/);
  assert.match(css, /#hud\[data-layout="portrait"\]/);
  assert.match(css, /display:\s*contents/);
  assert.match(css, /--touch-target:\s*44px/);
  assert.match(css, /#joystick\.is-active\s*\{\s*opacity:\s*0\.35/);
});
