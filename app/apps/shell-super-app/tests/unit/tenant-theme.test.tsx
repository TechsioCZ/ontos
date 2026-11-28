import type { RouteComponent } from '@modern-js/plugin-tanstack/runtime';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { extendBrand } from '@techsio/ui-kit/theme/theme-config';
import { BrandScope, useAppTheme } from '@techsio/ui-kit/theme/theme-provider';
import { Deferred, Effect } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';

import { TENANT_THEME_CHANGED_EVENT } from '../../src/api/tenant-theme-events.ts';
import { ShellContentLayout } from '../../src/routes/shell-content-layout.tsx';
import { businessShellTheme } from '../../src/routes/tenant-theme.ts';
import type { ShellTheme } from '../../src/routes/tenant-theme.ts';
import { useShellControls } from '../../src/routes/use-shell-controls.ts';
import { authenticatedShellFixture } from './routes/authenticated-shell-fixture.ts';
import { makeShellBff } from '../support/shell-bff-double.ts';
import { shellTestCopy } from '../support/shell-i18n.tsx';
import { makeShellRouter, renderShellRoute } from '../support/shell-router.tsx';

/*
 * The tenant's theme is data the Shell layout applies at runtime: the page model brings it, the open Shell picks up a
 * change without a reload, the light/dark switch exists only for a theme with both modes, and a module either
 * inherits the theme or scopes its own look with the kit's BrandScope.
 */

const acmeTheme: ShellTheme = {
  brand: extendBrand(businessShellTheme.brand, {
    key: 'acme',
    label: 'Acme',
    tokens: { '--color-primary': 'var(--color-primary-700)' },
  }),
  revision: 'acme-1',
};

const copy = shellTestCopy('en', { 'shell.dashboard.appearance.label': 'Appearance' });

/** A Shell page under the real layout whose page model carries `theme`. */
const renderPage = (component: RouteComponent, theme: ShellTheme) =>
  renderShellRoute(
    makeShellRouter({
      page: {
        component,
        loaderData: () => ({ shell: { ...authenticatedShellFixture(), theme } }),
        path: 'modules/$moduleId',
      },
      url: '/en/modules/projects',
    }),
    copy,
  );

/** What a module component sees of the theme it renders in. */
const ThemeProbe = ({ testId }: { readonly testId: string }) => <p data-testid={testId}>{useAppTheme().brand.key}</p>;

/** A stand-in module page: one screen without a scope, one with a look derived from the tenant's theme. */
const ModulePage = () => {
  const { brand } = useAppTheme();
  return (
    <main>
      <ThemeProbe testId="inherited" />
      <BrandScope
        brand={extendBrand(brand, { key: 'acme-projects', tokens: { '--color-primary': 'var(--color-primary-900)' } })}
      >
        <ThemeProbe testId="scoped" />
      </BrandScope>
    </main>
  );
};

/** A signed-in Shell page with the dashboard frame around it. */
const FramedPage = () => {
  const shell = authenticatedShellFixture();
  const controls = useShellControls(shell);
  return (
    <ShellContentLayout controls={controls} shell={shell}>
      <p>Module content</p>
    </ShellContentLayout>
  );
};

afterEach(cleanup);

it.effect('lets a module inherit the tenant theme and scope a derived one to its own subtree', () =>
  Effect.gen(function* moduleThemeScope() {
    yield* renderPage(ModulePage, acmeTheme);

    // Without a scope the module sees the tenant's brand, which the frame applies to the whole document.
    expect((yield* Effect.promise(() => screen.findByTestId('inherited'))).textContent).toBe('acme');
    expect(document.documentElement.dataset['theme']).toBe('acme');

    // Inside BrandScope the subtree carries the derived brand; outside it nothing changes.
    expect(screen.getByTestId('scoped').textContent).toBe('acme-projects');
    const scope = screen.getByTestId('scoped').closest<HTMLElement>('[data-theme]');
    expect(scope?.dataset['theme']).toBe('acme-projects');
    expect(screen.getByTestId('inherited').closest('[data-theme]')).toBe(document.documentElement);
    expect(document.documentElement.dataset['theme']).toBe('acme');
  }),
);

it.effect('swaps the theme of an open Shell when the tenant theme changes, without a reload', () =>
  Effect.gen(function* liveSwap() {
    const bff = makeShellBff({
      executeTenantTheme: () => Effect.succeed({ revision: acmeTheme.revision, theme: acmeTheme.brand }),
    });
    yield* Effect.gen(function* changedInThisBrowser() {
      yield* renderPage(ModulePage, businessShellTheme);
      expect((yield* Effect.promise(() => screen.findByTestId('inherited'))).textContent).toBe('business');

      window.dispatchEvent(new Event(TENANT_THEME_CHANGED_EVENT));
      yield* Effect.promise(() => waitFor(() => expect(screen.getByTestId('inherited').textContent).toBe('acme')));
      expect(document.documentElement.dataset['theme']).toBe('acme');
    }).pipe(Effect.provide(bff.browser));
    expect(bff.requests.map((received) => received.endpoint)).toEqual(['executeTenantTheme']);
  }),
);

it.live('keeps the newest theme when an older read of it answers late', () =>
  Effect.gen(function* latestReadWins() {
    const staleTheme = extendBrand(businessShellTheme.brand, { key: 'stale', label: 'Stale' });
    const staleAnswer = yield* Deferred.make<null>();
    let reads = 0;
    const bff = makeShellBff({
      executeTenantTheme: () => {
        reads += 1;
        // The first read answers only after the second one has; it carries what the tenant had before.
        return reads === 1
          ? Deferred.await(staleAnswer).pipe(Effect.as({ revision: 'stale-1', theme: staleTheme }))
          : Effect.succeed({ revision: acmeTheme.revision, theme: acmeTheme.brand });
      },
    });
    yield* Effect.gen(function* twoReads() {
      yield* renderPage(ModulePage, businessShellTheme);
      expect((yield* Effect.promise(() => screen.findByTestId('inherited'))).textContent).toBe('business');

      window.dispatchEvent(new Event(TENANT_THEME_CHANGED_EVENT));
      yield* Effect.promise(() => waitFor(() => expect(bff.requests).toHaveLength(1)));
      window.dispatchEvent(new Event(TENANT_THEME_CHANGED_EVENT));
      yield* Effect.promise(() => waitFor(() => expect(screen.getByTestId('inherited').textContent).toBe('acme')));

      yield* Deferred.succeed(staleAnswer, null);
      yield* Effect.sleep('50 millis');
      expect(screen.getByTestId('inherited').textContent).toBe('acme');
      expect(document.documentElement.dataset['theme']).toBe('acme');
    }).pipe(Effect.provide(bff.browser));
    expect(reads).toBe(2);
  }),
);

it.effect('offers the light/dark switch only for a theme that ships both modes', () =>
  Effect.gen(function* modeSwitch() {
    yield* renderPage(FramedPage, businessShellTheme);
    yield* Effect.promise(() => screen.findByText('Module content'));
    expect(screen.queryByRole('button', { name: 'Appearance' })).toBeNull();
    cleanup();

    const bothModes = extendBrand(businessShellTheme.brand, { key: 'acme', modes: ['light', 'dark'] });
    yield* renderPage(FramedPage, { brand: bothModes, revision: 'acme-2' });
    expect(yield* Effect.promise(() => screen.findByRole('button', { name: 'Appearance' }))).toBeTruthy();
  }),
);
