import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  endBrowserSession,
  onOtherSessionScopeEnded,
  registerSessionScopedReset,
  resetSessionScope,
} from '../../src/routes/session-scope.ts';

const announcementKey = 'ontos.session-scope.v1';

it.effect('runs every registered reset when the session scope ends, and announces the boundary', () =>
  Effect.gen(function* verifyBoundary() {
    const resets: string[] = [];
    registerSessionScopedReset(Effect.sync(() => resets.push('request-cache')));
    registerSessionScopedReset(Effect.sync(() => resets.push('composition')));
    globalThis.localStorage.removeItem(announcementKey);

    yield* endBrowserSession;

    expect(resets).toEqual(expect.arrayContaining(['request-cache', 'composition']));
    expect(globalThis.localStorage.getItem(announcementKey)).not.toBeNull();
  }),
);

it.effect('resets this document without announcing it to other documents', () =>
  Effect.gen(function* verifyLocalReset() {
    globalThis.localStorage.removeItem(announcementKey);
    const before = globalThis.localStorage.getItem(announcementKey);

    yield* resetSessionScope;

    expect(globalThis.localStorage.getItem(announcementKey)).toBe(before);
  }),
);

it.effect('tells this document when another document of the browser ends its session scope', () =>
  Effect.sync(() => {
    let notified = 0;
    const stop = onOtherSessionScopeEnded(() => {
      notified += 1;
    });
    try {
      globalThis.dispatchEvent(new StorageEvent('storage', { key: 'some.other.key' }));
      expect(notified).toBe(0);

      globalThis.dispatchEvent(new StorageEvent('storage', { key: announcementKey }));
      expect(notified).toBe(1);
    } finally {
      stop();
    }
    globalThis.dispatchEvent(new StorageEvent('storage', { key: announcementKey }));
    expect(notified).toBe(1);
  }),
);
