import { Option, Schema } from 'effect';
import { useMemo, useSyncExternalStore } from 'react';

import type { DemoGuide, DemoGuideId } from './demo-guide-types.ts';

/** Browser-local state of the demo guide. Nothing is sent to the server. */
export const DEMO_GUIDE_OPEN_KEY = 'ontos.demo-guide.open';
export const DEMO_GUIDE_WIDTH_KEY = 'ontos.demo-guide.width';
export const demoGuideProgressKey = (guideId: DemoGuideId): string => `ontos.demo-guide.progress.v1.${guideId}`;

export const DEMO_GUIDE_DEFAULT_WIDTH = 420;
export const DEMO_GUIDE_MIN_WIDTH = 320;
export const DEMO_GUIDE_MAX_WIDTH = 720;
/** Page width the panel always leaves free on desktop (unless that would make the guide narrower than its minimum). */
export const DEMO_GUIDE_MIN_PAGE_WIDTH = 480;

const changeEvent = 'ontos:demo-guide-change';

const widthSchema = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0));
const progressSchema = Schema.fromJsonString(Schema.Array(Schema.String));

/** Storage can be unavailable in private or restricted browser contexts; the guide then forgets its state. */
const readKey = (key: string): string | null => {
  try {
    return globalThis.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeKey = (key: string, value: string | null): void => {
  try {
    if (value === null) {
      globalThis.localStorage.removeItem(key);
    } else {
      globalThis.localStorage.setItem(key, value);
    }
  } catch {
    // Blocked storage: keep the previous state.
  }
  globalThis.dispatchEvent(new Event(changeEvent));
};

// Same-tab writes notify through a window event; other tabs arrive through the native storage event.
const subscribe = (listener: () => void): (() => void) => {
  globalThis.addEventListener(changeEvent, listener);
  globalThis.addEventListener('storage', listener);
  return () => {
    globalThis.removeEventListener(changeEvent, listener);
    globalThis.removeEventListener('storage', listener);
  };
};

/** Stored width, or the default; always within the absolute minimum and maximum. */
export const parseGuideWidth = (raw: string | null): number => {
  const decoded = raw === null ? undefined : Option.getOrUndefined(Schema.decodeOption(widthSchema)(raw));
  return decoded === undefined
    ? DEMO_GUIDE_DEFAULT_WIDTH
    : Math.min(Math.max(decoded, DEMO_GUIDE_MIN_WIDTH), DEMO_GUIDE_MAX_WIDTH);
};

/**
 * Width for a drag or key press: never narrower than the minimum, never covering the page below 480 px.
 * `sharedWidth` is the width the page and the guide share (viewport minus the docked navigation sidebar).
 */
export const clampGuideWidth = (width: number, sharedWidth: number): number =>
  Math.round(
    Math.min(
      Math.max(width, DEMO_GUIDE_MIN_WIDTH),
      Math.max(DEMO_GUIDE_MIN_WIDTH, Math.min(DEMO_GUIDE_MAX_WIDTH, sharedWidth - DEMO_GUIDE_MIN_PAGE_WIDTH)),
    ),
  );

/**
 * CSS width of the docked guide: the saved width re-fitted to the current screen by the browser itself, so a
 * resize, a smaller screen or a projector never squeezes the page below 480 px (the guide keeps at least 320 px).
 */
export const guideWidthCss = (savedWidth: number, sidebarWidthCss: string): string =>
  `clamp(${DEMO_GUIDE_MIN_WIDTH}px, calc(100vw - ${sidebarWidthCss} - ${DEMO_GUIDE_MIN_PAGE_WIDTH}px), ${savedWidth}px)`;

/** Done step ids; anything that is not a JSON array of strings counts as no progress. */
export const parseGuideProgress = (raw: string | null): readonly string[] =>
  raw === null ? [] : Option.getOrElse(Schema.decodeOption(progressSchema)(raw), (): readonly string[] => []);

export const toggleStep = (doneIds: readonly string[], stepId: string): readonly string[] =>
  doneIds.includes(stepId) ? doneIds.filter((id) => id !== stepId) : [...doneIds, stepId];

export interface DemoGuideProgressSummary {
  readonly done: number;
  /** First step, in guide order, that is not done yet. */
  readonly nextStepId: string | undefined;
  readonly total: number;
}

export const summarizeGuideProgress = (guide: DemoGuide, doneIds: readonly string[]): DemoGuideProgressSummary => {
  const steps = guide.chapters.flatMap((chapter) => chapter.steps);
  const done = new Set(doneIds);
  return {
    done: steps.filter((step) => done.has(step.id)).length,
    nextStepId: steps.find((step) => !done.has(step.id))?.id,
    total: steps.length,
  };
};

const readOpen = (): boolean => readKey(DEMO_GUIDE_OPEN_KEY) === 'open';
const serverOpen = (): boolean => false;
/** The server renders the guide closed; the saved choice applies on the client. */
export const useDemoGuideOpen = (): boolean => useSyncExternalStore(subscribe, readOpen, serverOpen);
export const setDemoGuideOpen = (open: boolean): void => {
  writeKey(DEMO_GUIDE_OPEN_KEY, open ? 'open' : null);
};

const readWidth = (): number => parseGuideWidth(readKey(DEMO_GUIDE_WIDTH_KEY));
const serverWidth = (): number => DEMO_GUIDE_DEFAULT_WIDTH;
export const useDemoGuideWidth = (): number => useSyncExternalStore(subscribe, readWidth, serverWidth);
/** `undefined` restores the default width. */
export const setDemoGuideWidth = (width: number | undefined): void => {
  writeKey(DEMO_GUIDE_WIDTH_KEY, width === undefined ? null : String(Math.round(width)));
};

const serverProgress = (): string | null => null;
export const readDemoGuideProgress = (guideId: DemoGuideId): readonly string[] =>
  parseGuideProgress(readKey(demoGuideProgressKey(guideId)));
/** The snapshot is the raw stored string, so React compares a stable primitive. */
export const useDemoGuideProgress = (guideId: DemoGuideId): readonly string[] => {
  const raw = useSyncExternalStore(subscribe, () => readKey(demoGuideProgressKey(guideId)), serverProgress);
  return useMemo(() => parseGuideProgress(raw), [raw]);
};
export const setDemoGuideProgress = (guideId: DemoGuideId, doneIds: readonly string[]): void => {
  writeKey(demoGuideProgressKey(guideId), JSON.stringify(doneIds));
};
export const resetDemoGuideProgress = (guideId: DemoGuideId): void => {
  writeKey(demoGuideProgressKey(guideId), null);
};
