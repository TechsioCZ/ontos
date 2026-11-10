import { describe, expect, it } from 'effect-rstest';
import {
  decodeDetailViewMode,
  DETAIL_VIEW_MODE_KEY,
  readDetailViewMode,
  saveDetailViewMode,
} from '../../src/detail-view-mode.ts';

describe('detail view mode', () => {
  it('reads only the two known modes and falls back to the full page', () => {
    expect(decodeDetailViewMode('panel')).toBe('panel');
    expect(decodeDetailViewMode('page')).toBe('page');
    for (const value of [null, '', 'modal', 'PANEL', '{}', 'null']) {
      expect(decodeDetailViewMode(value)).toBe('page');
    }
  });

  it('persists the shared choice, defaults to the page, and tolerates blocked storage', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const dispatchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'dispatchEvent');
    const events = new EventTarget();
    const notifications: string[] = [];
    events.addEventListener(DETAIL_VIEW_MODE_KEY, () => {
      notifications.push(readDetailViewMode());
    });
    Object.defineProperty(globalThis, 'dispatchEvent', {
      configurable: true,
      value: (event: Event) => events.dispatchEvent(event),
    });
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => {
          values.delete(key);
        },
        setItem: (key: string, value: string) => {
          values.set(key, value);
        },
      },
    });
    try {
      expect(readDetailViewMode()).toBe('page');
      expect(saveDetailViewMode('panel')).toBe(true);
      expect(values.get(DETAIL_VIEW_MODE_KEY)).toBe('panel');
      expect(readDetailViewMode()).toBe('panel');
      expect(saveDetailViewMode('page')).toBe(true);
      expect(readDetailViewMode()).toBe('page');
      expect(notifications).toEqual(['panel', 'page']);
      values.set(DETAIL_VIEW_MODE_KEY, 'broken');
      expect(readDetailViewMode()).toBe('page');
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get: () => {
          throw new Error('Storage blocked');
        },
      });
      expect(readDetailViewMode()).toBe('page');
      expect(saveDetailViewMode('panel')).toBe(false);
    } finally {
      if (dispatchDescriptor === undefined) {
        Reflect.deleteProperty(globalThis, 'dispatchEvent');
      } else {
        Object.defineProperty(globalThis, 'dispatchEvent', dispatchDescriptor);
      }
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, 'localStorage');
      } else {
        Object.defineProperty(globalThis, 'localStorage', descriptor);
      }
    }
  });
});
