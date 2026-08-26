/**
 * SpatialGrid — 均匀网格空间哈希
 *
 * 幸存者类游戏同屏可能有数百个敌人，两两检测是 O(n²)。
 * 每帧重建一次网格后，邻域查询降到近似 O(1)。
 */
(function (global) {
  'use strict';

  class SpatialGrid {
    constructor(cellSize = 96) {
      this.cellSize = cellSize;
      this.cells = new Map();
      this._queryResult = [];
    }

    _key(cx, cy) { return cx * 73856093 ^ cy * 19349663; }

    clear() { this.cells.clear(); }

    /** 用当前实体集合重建网格 */
    rebuild(entities) {
      this.cells.clear();
      for (let i = 0; i < entities.length; i++) {
        this.insert(entities[i]);
      }
    }

    insert(entity) {
      const cx = Math.floor(entity.position.x / this.cellSize);
      const cy = Math.floor(entity.position.y / this.cellSize);
      const key = this._key(cx, cy);
      let bucket = this.cells.get(key);
      if (!bucket) {
        bucket = [];
        this.cells.set(key, bucket);
      }
      bucket.push(entity);
    }

    /** 返回半径内的候选实体（复用内部数组，请勿长期持有） */
    query(position, radius) {
      const result = this._queryResult;
      result.length = 0;

      const minX = Math.floor((position.x - radius) / this.cellSize);
      const maxX = Math.floor((position.x + radius) / this.cellSize);
      const minY = Math.floor((position.y - radius) / this.cellSize);
      const maxY = Math.floor((position.y + radius) / this.cellSize);
      const radiusSq = radius * radius;

      for (let cy = minY; cy <= maxY; cy++) {
        for (let cx = minX; cx <= maxX; cx++) {
          const bucket = this.cells.get(this._key(cx, cy));
          if (!bucket) continue;
          for (let i = 0; i < bucket.length; i++) {
            const e = bucket[i];
            if (position.distanceSqTo(e.position) <= radiusSq + e.radius * e.radius) {
              result.push(e);
            }
          }
        }
      }
      return result;
    }

    /** 半径内距离最近的一个实体，可用 filter 过滤 */
    findNearest(position, radius, filter) {
      let best = null;
      let bestDist = Infinity;
      const candidates = this.query(position, radius);
      for (let i = 0; i < candidates.length; i++) {
        const e = candidates[i];
        if (filter && !filter(e)) continue;
        const d = position.distanceSqTo(e.position);
        if (d < bestDist) { bestDist = d; best = e; }
      }
      return best;
    }
  }

  global.SpatialGrid = SpatialGrid;
})(window);
