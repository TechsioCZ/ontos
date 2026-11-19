// @rstest-environment happy-dom
import { acted, settle, waitUntil } from '@app/admin-ui/testing/module-ui';
import type { LoaderFnContext } from '@modern-js/plugin-tanstack/runtime';
import { moduleWriteEvent } from '@app/shared-contracts/page-data';
import { fireEvent, screen, cleanup } from '@testing-library/react';
import { Deferred, Effect, Fiber, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { useState } from 'react';
import type { ReactElement } from 'react';

import { browserRuntime } from '../../../src/runtime/browser-effect-runtime.ts';
import { withPrimaryModulePreparation } from '../../../src/routes/browser-request-cache.ts';
import { staffRoutePreloads } from '../../../src/routes/route-preload-scheduler.ts';
import { ShellRouteLink } from '../../../src/routes/shell-frame.tsx';
import { StaffRoutePreloadContext, useIdleRoutePreload } from '../../../src/routes/use-idle-route-preload.ts';
import { shellLocaleCopy } from '../../support/shell-i18n.tsx';
import { makeShellRouter, renderShellRoute } from '../../support/shell-router.tsx';

const StaffLinks = () => (
  <StaffRoutePreloadContext value={{ enabled: true, generation: 0 }}>
    <ShellRouteLink to="/finance">Finance</ShellRouteLink>
    <ShellRouteLink to="/operations">Operations</ShellRouteLink>
    <ShellRouteLink to="/contacts">Contacts</ShellRouteLink>
  </StaffRoutePreloadContext>
);

const IntentContext = ({ initiallyDisabled = false }: { readonly initiallyDisabled?: boolean }) => {
  const [context, setContext] = useState('company-a');
  const [disabled, setDisabled] = useState(initiallyDisabled);
  const preload = useIdleRoutePreload([{ enabled: true, href: '/contacts' }], context, disabled);
  return (
    <StaffRoutePreloadContext value={preload}>
      <ShellRouteLink to="/finance">Finance</ShellRouteLink>
      <output>{preload.enabled ? 'ready' : 'blocked'}</output>
      <button onClick={() => setContext('company-b')} type="button">
        Switch company
      </button>
      <button onClick={() => setDisabled(false)} type="button">
        Enable intents
      </button>
    </StaffRoutePreloadContext>
  );
};

interface PreparedDestination {
  readonly hash: string;
  readonly search: Readonly<Record<string, string>>;
  readonly to: string;
}

/** Real route loaders record the destinations reached by the Shell's intent scheduler. */
const mountLinks = (
  element: ReactElement,
  navigation: Effect.Effect<unknown> = Effect.void,
  preparation: Effect.Effect<unknown> = Effect.void,
) =>
  Effect.gen(function* mountRealLinks() {
    const prepared: PreparedDestination[] = [];
    const completed: PreparedDestination[] = [];
    const starts: PreparedDestination[] = [];
    const router = makeShellRouter({
      page: { component: () => null, path: '$destination' },
      root: () => element,
      url: '/en',
    });
    for (const route of Object.values(router.routesById)) {
      if (route.path === '$destination') {
        route.update({
          beforeLoad: ({ location, preload }: Pick<LoaderFnContext, 'location' | 'preload'>) => {
            if (preload) {
              starts.push({
                hash: location.hash,
                search: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(location.search),
                to: location.pathname,
              });
            }
          },
          loader: ({ abortController, location, preload }: LoaderFnContext) => {
            if (preload) {
              const destination = {
                hash: location.hash,
                search: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(location.search),
                to: location.pathname,
              };
              prepared.push(destination);
              return browserRuntime.runPromise(
                preparation.pipe(Effect.andThen(Effect.sync(() => completed.push(destination)))),
                { signal: abortController.signal },
              );
            }
            return browserRuntime.runPromise(navigation);
          },
        });
      }
    }
    yield* renderShellRoute(router, shellLocaleCopy('en'));
    yield* settle;
    return { completed, prepared, router, starts };
  });

const ready = () => screen.getByRole('status').textContent === 'ready';

/** A FIFO turn of the actual browser Effect scheduler, then its route queue's terminal disposition. */
const blockedIntentProcessed = Effect.gen(function* observeBlockedIntent() {
  // runFork starts immediately, but an event can yield before entering schedule/preloadRoute. Queue this
  // continuation after that event's continuation; awaitIdle alone could otherwise inspect an empty queue too early.
  yield* Effect.promise(() => browserRuntime.runPromise(Effect.yieldNow));
  const disposition = browserRuntime.runFork(staffRoutePreloads.awaitIdle);
  expect(
    disposition.pollUnsafe(),
    'the blocked intent must be rejected, not left queued behind foreground work',
  ).toBeDefined();
  yield* Fiber.join(disposition);
});

beforeEach(() => {
  browserRuntime.runSync(staffRoutePreloads.invalidate);
  browserRuntime.runSync(staffRoutePreloads.resume);
});
afterEach(() => {
  cleanup();
  browserRuntime.runSync(staffRoutePreloads.invalidate);
  return browserRuntime.runPromise(staffRoutePreloads.awaitIdle);
});

it.live('rendering staff links prepares nothing; only intent prepares a destination', () =>
  Effect.gen(function* renderedLinksIdle() {
    const { prepared } = yield* mountLinks(<StaffLinks />);
    yield* Effect.sleep('20 millis');
    yield* staffRoutePreloads.awaitIdle;
    expect(prepared).toEqual([]);
    fireEvent.mouseEnter(screen.getByRole('link', { name: 'Operations' }));
    yield* staffRoutePreloads.awaitIdle;
    expect(prepared).toEqual([{ hash: '', search: {}, to: '/en/operations' }]);
  }),
);

it.live('never cancels started intent work on leave', () =>
  Effect.gen(function* leaveKeepsWork() {
    const release = yield* Deferred.make<boolean>();
    const arrived = yield* Deferred.make<boolean>();
    const { completed, prepared } = yield* mountLinks(
      <StaffLinks />,
      Effect.void,
      Deferred.succeed(arrived, true).pipe(Effect.andThen(Deferred.await(release))),
    );
    yield* Effect.gen(function* leaveWhilePreparing() {
      fireEvent.mouseEnter(screen.getByRole('link', { name: 'Finance' }));
      yield* Deferred.await(arrived);
      fireEvent.mouseLeave(screen.getByRole('link', { name: 'Finance' }));
      // The real native loader is held open: leaving the link neither cancels nor starts another preparation.
      expect(prepared).toHaveLength(1);
      yield* Deferred.succeed(release, true);
      yield* staffRoutePreloads.awaitIdle;
      expect(prepared).toHaveLength(1);
      expect(completed).toHaveLength(1);
    }).pipe(Effect.ensuring(Deferred.succeed(release, true)));
  }),
);

it.live('a menu of many links sends nothing until one is pointed at', () =>
  Effect.gen(function* manyLinks() {
    const { prepared, starts } = yield* mountLinks(
      <StaffRoutePreloadContext value={{ enabled: true, generation: 0 }}>
        {['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'].map((key) => (
          <ShellRouteLink key={key} to={`/${key}`}>
            {key}
          </ShellRouteLink>
        ))}
      </StaffRoutePreloadContext>,
    );
    yield* staffRoutePreloads.awaitIdle;
    expect(prepared).toEqual([]);
    fireEvent.focus(screen.getByRole('link', { name: 'eight' }));
    expect(starts).toHaveLength(1);
    expect(starts.at(-1)).toEqual({ hash: '', search: {}, to: '/en/eight' });
    yield* staffRoutePreloads.awaitIdle;
    expect(prepared).toHaveLength(1);
  }),
);

it.live.each(['mouseEnter', 'focus', 'touchStart'] as const)('prepares on %s with zero dwell', (event) =>
  Effect.gen(function* intent() {
    const { prepared, starts } = yield* mountLinks(<StaffLinks />);
    fireEvent[event](screen.getByRole('link', { name: 'Finance' }));
    expect(starts).toHaveLength(1);
    yield* staffRoutePreloads.awaitIdle;
    expect(prepared).toHaveLength(1);
  }),
);

it.live('retains complete localized query/hash and user event handlers', () =>
  Effect.gen(function* completeDestination() {
    const focused: string[] = [];
    const { prepared, starts } = yield* mountLinks(
      <StaffRoutePreloadContext value={{ enabled: true, generation: 0 }}>
        <ShellRouteLink
          onFocus={() => {
            focused.push('finance');
          }}
          to="/finance?filter=active&refreshToken=next#rows"
        >
          Finance
        </ShellRouteLink>
      </StaffRoutePreloadContext>,
    );
    yield* staffRoutePreloads.awaitIdle;
    expect(prepared).toEqual([]);
    fireEvent.focus(screen.getByRole('link'));
    expect(focused).toHaveLength(1);
    expect(starts).toEqual([
      {
        hash: 'rows',
        search: { filter: 'active', refreshToken: 'next' },
        to: '/en/finance',
      },
    ]);
    yield* staffRoutePreloads.awaitIdle;
    expect(prepared).toEqual(starts);
  }),
);

it.live('waits for the current primary reads, then prepares the pointed link and never the idle menu', () =>
  Effect.gen(function* primaryFirst() {
    const release = yield* Deferred.make<boolean>();
    const reading = yield* Deferred.make<boolean>();
    yield* Effect.addFinalizer(() => Deferred.succeed(release, true));
    const foreground = yield* withPrimaryModulePreparation(
      window.location.pathname,
      Deferred.succeed(reading, true).pipe(Effect.andThen(Deferred.await(release))),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(reading);
    const { prepared, starts } = yield* mountLinks(<IntentContext />);
    fireEvent.mouseEnter(screen.getByRole('link'));
    yield* blockedIntentProcessed;
    expect(foreground.pollUnsafe()).toBeUndefined();
    expect(starts).toEqual([]);
    expect(prepared).toEqual([]);
    yield* Deferred.succeed(release, true);
    yield* Fiber.join(foreground);
    yield* waitUntil(ready);
    fireEvent.mouseEnter(screen.getByRole('link'));
    yield* staffRoutePreloads.awaitIdle;
    expect(prepared).toContainEqual({ hash: '', search: {}, to: '/en/finance' });
    expect(prepared.map(({ to }) => to)).not.toContain('/en/contacts');
    expect(prepared).toHaveLength(1);
  }),
);

it.live('drops caches at once after writes and prepares nothing in the background afterwards', () =>
  Effect.gen(function* invalidation() {
    const { prepared, router } = yield* mountLinks(<IntentContext />);
    yield* waitUntil(ready);
    yield* staffRoutePreloads.awaitIdle;
    expect(prepared).toEqual([]);
    // A repeated native preload reuses its cached loader result until an invalidation.
    const operations = { hash: '', search: {}, to: '/en/operations' };
    const warmCache = Effect.promise(() => router.preloadRoute({ to: operations.to }));
    yield* warmCache;
    yield* warmCache;
    yield* staffRoutePreloads.awaitIdle;
    expect(prepared).toEqual([operations]);
    window.dispatchEvent(new Event(moduleWriteEvent));
    yield* warmCache;
    yield* staffRoutePreloads.awaitIdle;
    expect(prepared).toEqual([operations, operations]);
    window.dispatchEvent(new Event(moduleWriteEvent));
    yield* warmCache;
    yield* staffRoutePreloads.awaitIdle;
    // Each write forced exactly one reload; the idle menu added no preparations.
    expect(prepared.length - 1).toBe(2);
    expect(prepared).toEqual([operations, operations, operations]);
    const recording = 'ontos.page-reads.v1:/en/finance';
    window.localStorage.setItem(recording, '[]');
    yield* acted(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Switch company' }));
    });
    expect(window.localStorage.getItem(recording)).toBeNull();
    yield* warmCache;
    yield* staffRoutePreloads.awaitIdle;
    expect(prepared.length - 1).toBe(3);
  }),
);

it.live('does not prepare during navigation, switching or sign-out', () =>
  Effect.gen(function* foregroundPriority() {
    const release = yield* Deferred.make<boolean>();
    const navigating = yield* Deferred.make<boolean>();
    yield* Effect.addFinalizer(() => Deferred.succeed(release, true));
    const { prepared, router, starts } = yield* mountLinks(
      <IntentContext initiallyDisabled />,
      Deferred.succeed(navigating, true).pipe(Effect.andThen(Deferred.await(release))),
    );
    fireEvent.focus(screen.getByRole('link'));
    yield* blockedIntentProcessed;
    expect(starts).toEqual([]);
    expect(prepared).toEqual([]);
    const navigation = yield* Effect.promise(() => router.navigate({ to: '/en/operations' })).pipe(Effect.forkChild);
    yield* Deferred.await(navigating);
    yield* acted(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Enable intents' }));
    });
    fireEvent.focus(screen.getByRole('link'));
    yield* blockedIntentProcessed;
    expect(navigation.pollUnsafe()).toBeUndefined();
    expect(router.state.isLoading).toBe(true);
    expect(starts).toEqual([]);
    expect(prepared).toEqual([]);
    yield* Deferred.succeed(release, true);
    yield* Fiber.join(navigation);
    yield* waitUntil(ready);
    fireEvent.mouseEnter(screen.getByRole('link'));
    yield* staffRoutePreloads.awaitIdle;
    expect(prepared.length).toBeGreaterThan(0);
  }),
);

it.live('does not prepare storefront, external, new-tab or download links', () =>
  Effect.gen(function* excludedLinks() {
    const { prepared, starts } = yield* mountLinks(
      <StaffRoutePreloadContext value={{ enabled: true, generation: 0 }}>
        <ShellRouteLink to="https://shop.example/produkt/item">Storefront</ShellRouteLink>
        <ShellRouteLink target="_blank" to="/finance">
          New tab
        </ShellRouteLink>
        <ShellRouteLink download to="/export">
          Download
        </ShellRouteLink>
      </StaffRoutePreloadContext>,
    );
    for (const link of screen.getAllByRole('link')) {
      fireEvent.mouseEnter(link);
    }
    expect(starts).toEqual([]);
    yield* staffRoutePreloads.awaitIdle;
    expect(prepared).toEqual([]);
  }),
);
