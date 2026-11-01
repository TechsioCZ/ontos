import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import React, { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { OverviewPage, preloadPage } from '../../src/routes/[lang]/provoz/prehled/page.tsx';

const { reads } = rstest.hoisted(() => ({
  reads: {
    agreements: rstest.fn(),
    customers: rstest.fn(),
    finance: rstest.fn(),
    occupancy: rstest.fn(),
    overview: rstest.fn(),
    property: rstest.fn(),
    sales: rstest.fn(),
    work: rstest.fn(),
  },
}));

rstest.mock('@app/legal-agreements/clients/records', () => ({ executeRecords: reads.agreements }));
rstest.mock('@app/property-leasing/clients/records', () => ({ executeRecords: reads.occupancy }));
rstest.mock('@app/property-portfolio/clients/records', () => ({ executeRecords: reads.property }));
rstest.mock('@app/work-tasks/clients/records', () => ({ executeRecords: reads.work }));
rstest.mock('@app/party-registry/api/client', () => ({ listCustomers: reads.customers }));
rstest.mock('../../src/api/finance-reads.ts', () => ({ readFinance: reads.finance }));
rstest.mock('../../src/api/overview-client.ts', () => ({ executeOverview: reads.overview }));
rstest.mock('../../src/ui/ops-agenda/sales-source.ts', () => ({ loadSalesCases: reads.sales }));
rstest.mock('../../src/routes/ultramodern-route-head', () => ({ UltramodernRouteHead: () => null }));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  FederatedI18nBoundary: ({ children }: { readonly children: ReactNode }) => children,
  useModernI18n: () => ({ language: 'cs', t: String }),
}));

const props: ModulePageProps = { routeParams: {}, search: '' };

beforeEach(() => {
  // The owner's Node-only test config compiles TSX with the classic React runtime.
  rstest.stubGlobal('React', React);
  for (const read of Object.values(reads)) {
    read.mockReset();
    read.mockReturnValue(Effect.fail({ _tag: 'RecordsForbiddenProblem' }));
  }
});

afterEach(() => {
  rstest.unstubAllGlobals();
});

// Every source follows the live module-write signal (page data), so the overview offers no manual refresh.
describe('operations overview updates without a manual refresh', () => {
  it('renders no refresh button', () => {
    const html = renderToStaticMarkup(createElement(OverviewPage, props));
    expect(html).toContain('agenda.overview.title');
    expect(html).not.toContain('agenda.overview.refresh');
  });

  it.live('opening the overview loads every source once', () =>
    Effect.gen(function* opensOverview() {
      // Page data loads only in a browser document.
      rstest.stubGlobal('document', {});
      rstest.stubGlobal('dispatchEvent', () => true);
      yield* Effect.promise(() => preloadPage(props));
      for (const read of Object.values(reads)) {
        expect(read).toHaveBeenCalledTimes(1);
      }
    }),
  );
});
