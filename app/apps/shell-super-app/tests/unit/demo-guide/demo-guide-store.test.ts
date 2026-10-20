import { afterEach, expect, it } from 'effect-rstest';

import {
  clampGuideWidth,
  DEMO_GUIDE_DEFAULT_WIDTH,
  DEMO_GUIDE_MAX_WIDTH,
  DEMO_GUIDE_MIN_WIDTH,
  DEMO_GUIDE_OPEN_KEY,
  parseGuideProgress,
  parseGuideWidth,
  readDemoGuideProgress,
  resetDemoGuideProgress,
  setDemoGuideOpen,
  setDemoGuideProgress,
  summarizeGuideProgress,
  toggleStep,
} from '../../../src/demo-guide/demo-guide-store.ts';
import type { DemoGuide } from '../../../src/demo-guide/demo-guide-types.ts';

const target = { kind: 'app', path: '/' } as const;
const guide: DemoGuide = {
  chapters: [
    {
      id: 'one',
      steps: [
        { id: 'a', persona: null, say: 'A.', target, title: 'A' },
        { id: 'b', persona: null, say: 'B.', target, title: 'B' },
      ],
      summary: 'One.',
      title: 'One',
    },
    { id: 'two', steps: [{ id: 'c', persona: null, say: 'C.', target, title: 'C' }], summary: 'Two.', title: 'Two' },
  ],
  companyName: 'Test',
  id: 'hanak',
  intro: 'Test.',
  legalEntityId: 'test',
};

afterEach(() => {
  globalThis.localStorage.clear();
});

it('reads progress only from a JSON array of strings', () => {
  expect(parseGuideProgress(null)).toEqual([]);
  expect(parseGuideProgress('["a","b"]')).toEqual(['a', 'b']);
  expect(parseGuideProgress('not json')).toEqual([]);
  expect(parseGuideProgress('[1]')).toEqual([]);
});

it('toggles a step on and off', () => {
  expect(toggleStep(['a'], 'b')).toEqual(['a', 'b']);
  expect(toggleStep(['a', 'b'], 'a')).toEqual(['b']);
});

it('keeps the stored width within bounds', () => {
  expect(parseGuideWidth(null)).toBe(DEMO_GUIDE_DEFAULT_WIDTH);
  expect(parseGuideWidth('abc')).toBe(DEMO_GUIDE_DEFAULT_WIDTH);
  expect(parseGuideWidth('500')).toBe(500);
  expect(parseGuideWidth('10')).toBe(DEMO_GUIDE_MIN_WIDTH);
  expect(parseGuideWidth('9999')).toBe(DEMO_GUIDE_MAX_WIDTH);
});

it('never lets a drag cover the page', () => {
  expect(clampGuideWidth(1000, 1440)).toBe(DEMO_GUIDE_MAX_WIDTH);
  expect(clampGuideWidth(100, 1440)).toBe(DEMO_GUIDE_MIN_WIDTH);
  expect(clampGuideWidth(600, 1024)).toBe(544);
  expect(clampGuideWidth(600, 390)).toBe(DEMO_GUIDE_MIN_WIDTH);
});

it('summarizes done steps and the next step in guide order', () => {
  expect(summarizeGuideProgress(guide, [])).toEqual({ done: 0, nextStepId: 'a', total: 3 });
  expect(summarizeGuideProgress(guide, ['a', 'x'])).toEqual({ done: 1, nextStepId: 'b', total: 3 });
  expect(summarizeGuideProgress(guide, ['a', 'b', 'c'])).toEqual({ done: 3, nextStepId: undefined, total: 3 });
});

it('stores progress per guide and the open flag in localStorage', () => {
  setDemoGuideProgress('hanak', ['a']);
  expect(readDemoGuideProgress('hanak')).toEqual(['a']);
  expect(readDemoGuideProgress('siampark')).toEqual([]);
  resetDemoGuideProgress('hanak');
  expect(readDemoGuideProgress('hanak')).toEqual([]);
  setDemoGuideOpen(true);
  expect(globalThis.localStorage.getItem(DEMO_GUIDE_OPEN_KEY)).toBe('open');
  setDemoGuideOpen(false);
  expect(globalThis.localStorage.getItem(DEMO_GUIDE_OPEN_KEY)).toBeNull();
});
