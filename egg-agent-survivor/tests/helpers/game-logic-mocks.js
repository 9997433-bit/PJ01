'use strict';

/**
 * Minimal, dependency-free contracts used by the boundary tests until the
 * production game modules exist. Keep these APIs small so they can be replaced
 * with imports from the engine without rewriting the test cases.
 */

function assertFinite(value, name) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
}

class Vector2 {
  constructor(x = 0, y = 0) {
    assertFinite(x, 'x');
    assertFinite(y, 'y');
    this.x = x;
    this.y = y;
  }

  clone() {
    return new Vector2(this.x, this.y);
  }

  add(other) {
    return new Vector2(this.x + other.x, this.y + other.y);
  }

  subtract(other) {
    return new Vector2(this.x - other.x, this.y - other.y);
  }

  scale(factor) {
    assertFinite(factor, 'factor');
    return new Vector2(this.x * factor, this.y * factor);
  }

  length() {
    return Math.hypot(this.x, this.y);
  }

  normalize() {
    const scale = Math.max(Math.abs(this.x), Math.abs(this.y));
    if (scale === 0) {
      return new Vector2();
    }

    // Scaling first avoids overflow for vectors near Number.MAX_VALUE.
    const scaledLength = Math.hypot(this.x / scale, this.y / scale);
    return new Vector2(
      (this.x / scale) / scaledLength,
      (this.y / scale) / scaledLength,
    );
  }

  distanceTo(other) {
    return Math.hypot(this.x - other.x, this.y - other.y);
  }
}

function normalizeAABB(box) {
  for (const key of ['x', 'y', 'width', 'height']) {
    assertFinite(box[key], `box.${key}`);
  }

  return {
    x: box.width < 0 ? box.x + box.width : box.x,
    y: box.height < 0 ? box.y + box.height : box.y,
    width: Math.abs(box.width),
    height: Math.abs(box.height),
  };
}

/**
 * By default edge contact is a collision. Pass includeTouching=false for
 * trigger/overlap checks that require positive intersection area.
 */
function intersectsAABB(left, right, includeTouching = true) {
  const a = normalizeAABB(left);
  const b = normalizeAABB(right);

  if (includeTouching) {
    return (
      a.x <= b.x + b.width
      && a.x + a.width >= b.x
      && a.y <= b.y + b.height
      && a.y + a.height >= b.y
    );
  }

  return (
    a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y
  );
}

function containsPointAABB(box, point, includeBoundary = true) {
  const normalized = normalizeAABB(box);
  assertFinite(point.x, 'point.x');
  assertFinite(point.y, 'point.y');

  if (includeBoundary) {
    return (
      point.x >= normalized.x
      && point.x <= normalized.x + normalized.width
      && point.y >= normalized.y
      && point.y <= normalized.y + normalized.height
    );
  }

  return (
    point.x > normalized.x
    && point.x < normalized.x + normalized.width
    && point.y > normalized.y
    && point.y < normalized.y + normalized.height
  );
}

function validateExperienceOptions(options = {}) {
  const base = options.base ?? 10;
  const increment = options.increment ?? 5;
  const maxLevel = options.maxLevel ?? 100;

  if (!Number.isSafeInteger(base) || base <= 0) {
    throw new RangeError('base must be a positive safe integer');
  }
  if (!Number.isSafeInteger(increment) || increment < 0) {
    throw new RangeError('increment must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(maxLevel) || maxLevel < 1) {
    throw new RangeError('maxLevel must be a positive safe integer');
  }

  return { base, increment, maxLevel };
}

function experienceForNextLevel(level, options = {}) {
  const { base, increment } = validateExperienceOptions(options);
  if (!Number.isSafeInteger(level) || level < 1) {
    throw new RangeError('level must be a positive safe integer');
  }

  const required = base + ((level - 1) * increment);
  if (!Number.isSafeInteger(required)) {
    throw new RangeError('experience requirement exceeds safe integer range');
  }
  return required;
}

function totalExperienceForLevel(level, options = {}) {
  if (!Number.isSafeInteger(level) || level < 1) {
    throw new RangeError('level must be a positive safe integer');
  }
  const { base, increment } = validateExperienceOptions(options);
  const completedLevels = level - 1;
  const total = (
    (completedLevels * base)
    + ((increment * completedLevels * (completedLevels - 1)) / 2)
  );
  if (!Number.isSafeInteger(total)) {
    throw new RangeError('total experience exceeds safe integer range');
  }
  return total;
}

function calculateLevel(totalExperience, options = {}) {
  if (!Number.isSafeInteger(totalExperience) || totalExperience < 0) {
    throw new RangeError('totalExperience must be a non-negative safe integer');
  }
  const validated = validateExperienceOptions(options);
  let level = 1;
  let currentExperience = totalExperience;

  while (level < validated.maxLevel) {
    const needed = experienceForNextLevel(level, validated);
    if (currentExperience < needed) {
      break;
    }
    currentExperience -= needed;
    level += 1;
  }

  const capped = level === validated.maxLevel;
  return {
    level,
    currentExperience,
    experienceForNextLevel: capped
      ? null
      : experienceForNextLevel(level, validated),
    capped,
  };
}

module.exports = {
  Vector2,
  calculateLevel,
  containsPointAABB,
  experienceForNextLevel,
  intersectsAABB,
  normalizeAABB,
  totalExperienceForLevel,
};
