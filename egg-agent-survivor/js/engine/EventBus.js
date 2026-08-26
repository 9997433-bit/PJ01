/**
 * EventBus — 极简发布订阅
 * 引擎、实体与 UI 之间只通过事件通信，避免互相直接引用。
 */
(function (global) {
  'use strict';

  class EventBus {
    constructor() {
      this._handlers = new Map();
    }

    /** @returns {Function} 取消订阅的函数 */
    on(event, handler) {
      if (!this._handlers.has(event)) this._handlers.set(event, new Set());
      this._handlers.get(event).add(handler);
      return () => this.off(event, handler);
    }

    once(event, handler) {
      const wrapper = (payload) => {
        this.off(event, wrapper);
        handler(payload);
      };
      return this.on(event, wrapper);
    }

    off(event, handler) {
      const set = this._handlers.get(event);
      if (set) set.delete(handler);
    }

    emit(event, payload) {
      const set = this._handlers.get(event);
      if (!set || set.size === 0) return;
      // 复制一份，允许回调内部增删订阅
      for (const handler of Array.from(set)) {
        try {
          handler(payload);
        } catch (err) {
          console.error(`[EventBus] "${event}" 处理器异常:`, err);
        }
      }
    }

    clear(event) {
      if (event) this._handlers.delete(event);
      else this._handlers.clear();
    }
  }

  global.EventBus = EventBus;
})(window);
