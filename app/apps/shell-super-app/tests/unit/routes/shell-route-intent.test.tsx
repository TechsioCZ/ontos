import { moduleWriteEvent } from '@app/shared-contracts/page-data';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Clock, Deferred, Effect } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { TestClock } from 'effect/testing';
import type { ComponentProps } from 'react';

import { browserRuntime } from '../../../src/runtime/browser-effect-runtime.ts';
import { ShellRouteLink } from '../../../src/routes/shell-frame.tsx';
import { StaffRoutePreloadContext, useIdleRoutePreload } from '../../../src/routes/use-idle-route-preload.ts';

interface RouterStateSlot {
  current: RouterStateFixture;
}

interface RouterStateFixture {
  readonly location: { readonly href: string };
  readonly resolvedLocation: { readonly href: string };
}

const { forget, gate, preloadRoute, router, routeState, unstableRouter } = rstest.hoisted(() => {
  const preload = rstest.fn<
    (destination: {
      readonly hash?: string;
      readonly search?: Readonly<Record<string, string>>;
      readonly to: string;
    }) => Promise<void>
  >(() => Promise.resolve());
  const state: RouterStateSlot = {
    current: { location: { href: '/en' }, resolvedLocation: { href: '/en' } },
  };
  return {
    forget: rstest.fn<() => void>(),
    gate: { wait: (): Effect.Effect<boolean> => Effect.succeed(true) },
    preloadRoute: preload,
    router: {
      clearCache: rstest.fn<() => void>(),
      matchRoutes: () => [],
      options: { parseSearch: (search: string) => Object.fromEntries(new URLSearchParams(search)) },
      preloadRoute: preload,
      routesById: {},
    },
    routeState: state,
    unstableRouter: { enabled: false },
  };
});

rstest.mock('../../../src/routes/browser-request-cache.ts', () => ({
  awaitPrimaryModuleReads: Effect.suspend(() => gate.wait()),
  forgetRecordedPageReads: Effect.sync(forget),
  withoutRecordedPageReads: <A,>(start: () => Promise<A>) =>
    Effect.tryPromise(start).pipe(Effect.timeout('30 seconds')),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  rootRouteId: '__root__',
  useNavigate: () => () => Promise.resolve(),
  useRouter: () => (unstableRouter.enabled ? { ...router } : router),
  useRouterState: ({ select }: { readonly select: (state: RouterStateFixture) => string | undefined }) =>
    select(routeState.current),
}));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  Link: ({
    activeOptions: _active,
    children,
    prefetch: _prefetch,
    preload: _preload,
    to,
    ...props
  }: ComponentProps<'a'> & {
    readonly activeOptions?: unknown;
    readonly prefetch?: string;
    readonly preload?: boolean;
    readonly to: string;
  }) => (
    <a href={to.startsWith('https:') ? to : `/en${to === '/' ? '' : to}`} {...props}>
      {children}
    </a>
  ),
  useModernI18n: () => ({ language: 'en', t: (key: string) => key }),
}));

const StaffLinks = ({ enabled = true }: { readonly enabled?: boolean }) => (
  <StaffRoutePreloadContext value={{ enabled, generation: 0 }}>
    <ShellRouteLink to="/finance">Finance</ShellRouteLink>
    <ShellRouteLink to="/operations">Operations</ShellRouteLink>
    <ShellRouteLink to="/contacts">Contacts</ShellRouteLink>
  </StaffRoutePreloadContext>
);
const IntentContext = ({
  context = 'company-a',
  disabled = false,
}: {
  readonly context?: string;
  readonly disabled?: boolean;
}) => {
  const preload = useIdleRoutePreload([{ enabled: true, href: '/contacts' }], context, disabled);
  return (
    <StaffRoutePreloadContext value={preload}>
      <ShellRouteLink to="/finance">Finance</ShellRouteLink>
    </StaffRoutePreloadContext>
  );
};

beforeEach(() => {
  preloadRoute.mockReset();
  preloadRoute.mockResolvedValue();
  router.clearCache.mockClear();
  forget.mockClear();
  gate.wait = () => Effect.succeed(true);
  unstableRouter.enabled = false;
  routeState.current = { location: { href: '/en' }, resolvedLocation: { href: '/en' } };
});
afterEach(() => cleanup());

it.live('starts every rendered destination concurrently and never cancels started work on leave', () =>
  Effect.gen(function* concurrentRender() {
    const release = yield* Deferred.make<boolean>();
    preloadRoute.mockImplementation(() => browserRuntime.runPromise(Deferred.await(release).pipe(Effect.asVoid)));
    render(<StaffLinks />);
    expect(preloadRoute.mock.calls.map(([destination]) => destination)).toEqual([
      { hash: '', search: {}, to: '/en/finance' },
      { hash: '', search: {}, to: '/en/operations' },
      { hash: '', search: {}, to: '/en/contacts' },
    ]);
    fireEvent.mouseLeave(screen.getByRole('link', { name: 'Finance' }));
    fireEvent.mouseLeave(screen.getByRole('link', { name: 'Operations' }));
    expect(preloadRoute).toHaveBeenCalledTimes(3);
    yield* Deferred.succeed(release, true);
  }),
);

it.each(['mouseEnter', 'focus', 'touchStart'] as const)('starts %s preparation with zero dwell', (event) => {
  render(<StaffLinks />);
  preloadRoute.mockClear();
  fireEvent[event](screen.getByRole('link', { name: 'Finance' }));
  expect(preloadRoute).toHaveBeenCalledTimes(1);
});

it('retains complete localized query/hash and user event handlers', () => {
  const onFocus = rstest.fn<() => void>();
  render(
    <StaffRoutePreloadContext value={{ enabled: true, generation: 0 }}>
      <ShellRouteLink onFocus={onFocus} to="/finance?filter=active&refreshToken=next#rows">
        Finance
      </ShellRouteLink>
    </StaffRoutePreloadContext>,
  );
  expect(preloadRoute).toHaveBeenCalledWith({
    hash: 'rows',
    search: { filter: 'active', refreshToken: 'next' },
    to: '/en/finance',
  });
  fireEvent.focus(screen.getByRole('link'));
  expect(onFocus).toHaveBeenCalledTimes(1);
});

it.effect('gives the current primary reads priority, then warms both rendered and idle menu destinations', () =>
  Effect.gen(function* primaryFirst() {
    const clock = yield* Clock.Clock;
    gate.wait = () => Effect.sleep('10 millis').pipe(Effect.as(true), Effect.provideService(Clock.Clock, clock));
    render(<IntentContext />);
    fireEvent.mouseEnter(screen.getByRole('link'));
    expect(preloadRoute).not.toHaveBeenCalled();
    yield* TestClock.adjust('10 millis');
    yield* Effect.promise(() => waitFor(() => expect(preloadRoute).toHaveBeenCalledWith({ to: '/en/contacts' })));
    expect(preloadRoute).toHaveBeenCalledWith({ hash: '', search: {}, to: '/en/finance' });
  }),
);

it.live('settles the preparation key when the router handle changes identity across renders', () =>
  Effect.gen(function* stablePreparationKey() {
    unstableRouter.enabled = true;
    render(<IntentContext />);
    yield* Effect.promise(() => waitFor(() => expect(preloadRoute).toHaveBeenCalled()));
    yield* Effect.sleep('20 millis');
    const settledCalls = preloadRoute.mock.calls.length;
    yield* Effect.sleep('20 millis');
    expect(preloadRoute).toHaveBeenCalledTimes(settledCalls);
  }),
);

it.live('restarts preparations after writes and clears native/context caches on a company change', () =>
  Effect.gen(function* invalidation() {
    const view = render(<IntentContext />);
    yield* Effect.promise(() => waitFor(() => expect(preloadRoute).toHaveBeenCalledTimes(2)));
    preloadRoute.mockClear();
    globalThis.dispatchEvent(new Event(moduleWriteEvent));
    yield* Effect.promise(() => waitFor(() => expect(preloadRoute).toHaveBeenCalledWith({ to: '/en/contacts' })));
    expect(router.clearCache).toHaveBeenCalledTimes(1);
    view.rerender(<IntentContext context="company-b" />);
    yield* Effect.promise(() => waitFor(() => expect(forget).toHaveBeenCalledTimes(1)));
    expect(router.clearCache).toHaveBeenCalledTimes(2);
  }),
);

it.live('does not speculate during navigation, switching or sign-out', () =>
  Effect.gen(function* foregroundPriority() {
    const view = render(<IntentContext disabled />);
    fireEvent.focus(screen.getByRole('link'));
    expect(preloadRoute).not.toHaveBeenCalled();
    routeState.current = { location: { href: '/en/operations' }, resolvedLocation: { href: '/en' } };
    view.rerender(<IntentContext />);
    expect(preloadRoute).not.toHaveBeenCalled();
    routeState.current = { location: { href: '/en/operations' }, resolvedLocation: { href: '/en/operations' } };
    view.rerender(<IntentContext />);
    yield* Effect.promise(() => waitFor(() => expect(preloadRoute).toHaveBeenCalled()));
  }),
);

it('does not prepare storefront, external, new-tab or download links', () => {
  render(
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
  expect(preloadRoute).not.toHaveBeenCalled();
});
