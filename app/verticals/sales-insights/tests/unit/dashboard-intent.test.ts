import { Effect } from 'effect';
import { afterEach, expect, it, rstest } from 'effect-rstest';
import React, { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { modulePagePreload } from '@app/shared-contracts/page-data' with { rstest: 'importActual' };

import { CrmDashboard } from '../../src/components/crm-dashboard.tsx';

const { links, snapshot } = rstest.hoisted(() => ({
  links: (() => {
    const captured: { readonly prefetch?: string; readonly preload?: string | boolean; readonly to: string }[] = [];
    return captured;
  })(),
  snapshot: {
    refreshing: false,
    state: 'ready' as const,
    value: [
      { href: '/finance', id: 'unpaid_amount', source: 'invoices', state: 'ready', unit: 'CZK', value: 100 },
      { href: '/ukoly', id: 'tasks_open', source: 'tasks', state: 'ready', unit: 'count', value: 2 },
      {
        href: '/prodej/prilezitosti',
        id: 'opportunities_open',
        source: 'opportunities',
        state: 'ready',
        unit: 'count',
        value: 3,
      },
    ],
  },
}));

// Render the ready server snapshot to inspect the owner's real card links without mounting a browser.
rstest.mock('@app/shared-contracts/page-data', () => ({ modulePagePreload, pageDataPending: snapshot }));

rstest.mock('../../src/dashboard/dashboard-data.ts', () => ({
  dashboardData: {
    ensure: rstest.fn(),
    preload: () => Effect.void,
    refresh: () => Effect.void,
    snapshot: () => snapshot,
    subscribe: () => () => {},
  },
  dashboardInputOf: () => ({ legalEntityId: 'company-a' }),
}));

// Capture the public localized-link contract at the owner boundary. Shell separately exercises this contract
// through the real localized/native router and recorder, without importing this deployment's private source.
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  FederatedI18nBoundary: ({ children }: { readonly children: ReactNode }) => children,
  Link: ({ children, ...props }: { readonly children: ReactNode; readonly to: string }) => {
    links.push(props);
    return createElement('a', { href: props.to }, children);
  },
  useModernI18n: () => ({ t: String }),
}));

afterEach(() => {
  rstest.unstubAllGlobals();
});

it('leaves Home card preparation to the Shell, which prepares the same menu routes outside the replay list', () => {
  // The owner's Node-only test config compiles TSX with the classic React runtime.
  rstest.stubGlobal('React', React);
  links.length = 0;
  const html = renderToStaticMarkup(createElement(CrmDashboard, { routeParams: {}, search: '' }));
  expect(links).toHaveLength(3);
  expect(links).toEqual([
    expect.objectContaining({ prefetch: 'none', preload: false, to: '/finance' }),
    expect.objectContaining({ prefetch: 'none', preload: false, to: '/ukoly' }),
    expect.objectContaining({ prefetch: 'none', preload: false, to: '/prodej/prilezitosti' }),
  ]);
  for (const { to } of links) {
    expect(html).toContain(`href="${to}"`);
  }
});
