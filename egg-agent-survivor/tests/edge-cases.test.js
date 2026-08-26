'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  calculateLevel,
  containsPointAABB,
  experienceForNextLevel,
  intersectsAABB,
  normalizeAABB,
  totalExperienceForLevel,
} = require('./helpers/game-logic-mocks');

function loadProductionVector2() {
  const filename = path.resolve(__dirname, '../js/utils/Vector2.js');
  const source = fs.readFileSync(filename, 'utf8');
  const browserGlobal = {};
  browserGlobal.window = browserGlobal;
  vm.runInNewContext(source, browserGlobal, { filename });
  return browserGlobal.Vector2;
}

const Vector2 = loadProductionVector2();

test('Vector2 arithmetic returns new vectors without mutating operands', () => {
  const left = new Vector2(3, -4);
  const right = new Vector2(-2, 10);

  assert.deepEqual(left.add(right), new Vector2(1, 6));
  assert.deepEqual(left.sub(right), new Vector2(5, -14));
  assert.deepEqual(left.scale(2), new Vector2(6, -8));
  assert.deepEqual(left, new Vector2(3, -4));
  assert.deepEqual(right, new Vector2(-2, 10));
});

test('Vector2 normalization handles zero and ordinary vectors', () => {
  assert.deepEqual(new Vector2().normalized(), new Vector2());

  const normalized = new Vector2(3, 4).normalized();
  assert.ok(Math.abs(normalized.x - 0.6) < 1e-12);
  assert.ok(Math.abs(normalized.y - 0.8) < 1e-12);
  assert.ok(Math.abs(normalized.length() - 1) < 1e-12);
});

test('Vector2 normalization remains stable for very large finite components', () => {
  const normalized = new Vector2(1e150, -1e150).normalized();

  assert.ok(Number.isFinite(normalized.x));
  assert.ok(Number.isFinite(normalized.y));
  assert.ok(Math.abs(normalized.length() - 1) < 1e-12);
});

test.todo('Vector2 should reject non-finite state before NaN can spread');
test.todo('Vector2 normalization should remain stable near Number.MAX_VALUE');

test('AABB reports separated, overlapping, and containing boxes', () => {
  const player = { x: 10, y: 10, width: 20, height: 20 };

  assert.equal(
    intersectsAABB(player, { x: 15, y: 15, width: 2, height: 2 }),
    true,
  );
  assert.equal(
    intersectsAABB(player, { x: 31, y: 10, width: 5, height: 5 }),
    false,
  );
  assert.equal(
    intersectsAABB(player, { x: 0, y: 0, width: 100, height: 100 }),
    true,
  );
});

test('AABB edge contact policy is explicit', () => {
  const left = { x: 0, y: 0, width: 10, height: 10 };
  const right = { x: 10, y: 2, width: 5, height: 5 };

  assert.equal(intersectsAABB(left, right), true);
  assert.equal(intersectsAABB(left, right, false), false);
});

test('AABB normalizes negative extents and supports zero-size hit points', () => {
  assert.deepEqual(
    normalizeAABB({ x: 10, y: 20, width: -5, height: -8 }),
    { x: 5, y: 12, width: 5, height: 8 },
  );

  const pointBox = { x: 5, y: 5, width: 0, height: 0 };
  assert.equal(
    intersectsAABB(pointBox, { x: 0, y: 0, width: 5, height: 5 }),
    true,
  );
  assert.equal(
    intersectsAABB(pointBox, { x: 0, y: 0, width: 5, height: 5 }, false),
    false,
  );
});

test('AABB point containment includes boundaries only when requested', () => {
  const box = { x: 2, y: 3, width: 4, height: 5 };

  assert.equal(containsPointAABB(box, { x: 2, y: 3 }), true);
  assert.equal(containsPointAABB(box, { x: 2, y: 3 }, false), false);
  assert.equal(containsPointAABB(box, { x: 4, y: 5 }, false), true);
  assert.equal(containsPointAABB(box, { x: 7, y: 5 }), false);
});

test('AABB rejects non-finite dimensions and points', () => {
  assert.throws(
    () => intersectsAABB(
      { x: 0, y: 0, width: Number.NaN, height: 1 },
      { x: 0, y: 0, width: 1, height: 1 },
    ),
    TypeError,
  );
  assert.throws(
    () => containsPointAABB(
      { x: 0, y: 0, width: 1, height: 1 },
      { x: Number.POSITIVE_INFINITY, y: 0 },
    ),
    TypeError,
  );
});

test('experience requirements are deterministic and monotonic', () => {
  const requirements = Array.from(
    { length: 100 },
    (_, index) => experienceForNextLevel(index + 1),
  );

  assert.deepEqual(requirements.slice(0, 4), [10, 15, 20, 25]);
  for (let index = 1; index < requirements.length; index += 1) {
    assert.ok(requirements[index] >= requirements[index - 1]);
  }
});

test('experience calculation handles exact level thresholds', () => {
  assert.deepEqual(calculateLevel(0), {
    level: 1,
    currentExperience: 0,
    experienceForNextLevel: 10,
    capped: false,
  });
  assert.deepEqual(calculateLevel(9), {
    level: 1,
    currentExperience: 9,
    experienceForNextLevel: 10,
    capped: false,
  });
  assert.deepEqual(calculateLevel(10), {
    level: 2,
    currentExperience: 0,
    experienceForNextLevel: 15,
    capped: false,
  });
  assert.deepEqual(calculateLevel(totalExperienceForLevel(4)), {
    level: 4,
    currentExperience: 0,
    experienceForNextLevel: 25,
    capped: false,
  });
});

test('experience calculation retains overflow and stops at the level cap', () => {
  assert.deepEqual(calculateLevel(47), {
    level: 4,
    currentExperience: 2,
    experienceForNextLevel: 25,
    capped: false,
  });

  assert.deepEqual(calculateLevel(100, { maxLevel: 3 }), {
    level: 3,
    currentExperience: 75,
    experienceForNextLevel: null,
    capped: true,
  });
});

test('experience calculation rejects unsafe or invalid inputs', () => {
  for (const invalidTotal of [-1, 1.5, Number.NaN, Number.MAX_VALUE]) {
    assert.throws(() => calculateLevel(invalidTotal), RangeError);
  }

  assert.throws(() => experienceForNextLevel(0), RangeError);
  assert.throws(
    () => experienceForNextLevel(2, {
      base: Number.MAX_SAFE_INTEGER,
      increment: 1,
    }),
    RangeError,
  );
  assert.throws(() => totalExperienceForLevel(1.5), RangeError);
});
