import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { Effect } from 'effect';
import { afterEach, describe, expect, it, rstest } from 'effect-rstest';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { OverviewPage, preloadPage } from '../../src/routes/[lang]/nemovitosti/prehled/page.tsx';

const { reads } = rstest.hoisted(() => ({
  reads: {
    agreements: rstest.fn(),
    finance: rstest.fn(),
    occupancy: rstest.fn(),
    property: rstest.fn(),
    work: rstest.fn(),
  },
}));

rstest.mock('@app/legal-agreements/clients/records', () => ({ executeRecords: reads.agreements }));
rstest.mock('@app/finance-billing/clients/records', () => ({ executeRecords: reads.finance }));
rstest.mock('@app/property-leasing/clients/records', () => ({ executeRecords: reads.occupancy }));
rstest.mock('../../src/api/records-client', () => ({ executeRecords: reads.property }));
rstest.mock('@app/work-tasks/clients/records', () => ({ executeRecords: reads.work }));
rstest.mock('../../src/routes/ultramodern-route-head', () => ({ UltramodernRouteHead: () => null }));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  FederatedI18nBoundary: ({ children }: { readonly children: ReactNode }) => children,
  useModernI18n: () => ({ language: 'cs', t: String }),
}));

const props: ModulePageProps = {
  context: { legalEntityId: 'company-a', principalId: 'manager-a', tenantId: 'tenant-a' },
  routeParams: {},
  search: '',
};

afterEach(() => {
  rstest.unstubAllGlobals();
});

// The five governed reads follow the live module-write signal (page data), so the overview has no refresh button.
describe('rental overview updates without a manual refresh', () => {
  it('renders no refresh button', () => {
    const html = renderToStaticMarkup(createElement(OverviewPage, props));
    expect(html).toContain('overview-heading');
    expect(html).not.toContain('Obnovit');
    expect(html).not.toContain('<button');
  });

  it.live('opening the overview loads every source once', () =>
    Effect.gen(function* opensOverview() {
      for (const read of Object.values(reads)) {
        read.mockReturnValue(Effect.fail({ _tag: 'RecordsForbiddenProblem' }));
      }
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
