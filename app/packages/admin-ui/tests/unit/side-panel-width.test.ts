import { describe, expect, it } from 'effect-rstest';
import {
  clampPanelWidth,
  decodePanelWidth,
  draggedPanelWidth,
  readPanelWidth,
  savePanelWidth,
  SIDE_PANEL_WIDTH_KEY,
} from '../../src/side-panel-width.ts';

describe('side panel width', () => {
  it('accepts only positive whole pixel widths from storage', () => {
    expect(decodePanelWidth('840')).toBe(840);
    for (const value of [null, '', 'broken', '{}', '-10', '0', '4.5', 'Infinity', 'NaN']) {
      expect(decodePanelWidth(value)).toBeUndefined();
    }
  });

  it('expands a right-hand panel when its left edge moves left', () => {
    expect(draggedPanelWidth(576, 1000, 800)).toBe(776);
    expect(draggedPanelWidth(576, 1000, 1200)).toBe(376);
  });

  it('respects the minimum and viewport bounds, including a narrow phone', () => {
    expect(clampPanelWidth(250, 384, 1280)).toBe(384);
    expect(clampPanelWidth(2000, 384, 1280)).toBe(1280);
    expect(clampPanelWidth(900, 384, 320)).toBe(320);
    expect(clampPanelWidth(700.6, 384, 1280)).toBe(701);
  });

  it('persists the shared preference, restores defaults, and tolerates blocked storage', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const dispatchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'dispatchEvent');
    const events = new EventTarget();
    const notifications: (number | undefined)[] = [];
    events.addEventListener(SIDE_PANEL_WIDTH_KEY, () => {
      notifications.push(readPanelWidth());
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
      expect(savePanelWidth(820)).toBe(true);
      expect(values.get(SIDE_PANEL_WIDTH_KEY)).toBe('820');
      expect(readPanelWidth()).toBe(820);
      savePanelWidth();
      expect(values.has(SIDE_PANEL_WIDTH_KEY)).toBe(false);
      expect(readPanelWidth()).toBeUndefined();
      expect(notifications).toEqual([820, undefined]);
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get: () => {
          throw new Error('Storage blocked');
        },
      });
      expect(savePanelWidth(900)).toBe(false);
      expect(readPanelWidth()).toBeUndefined();
      savePanelWidth();
      expect(readPanelWidth()).toBeUndefined();
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
