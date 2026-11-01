import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import React, { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { RecordsPage, preloadPage } from '../../src/routes/[lang]/smlouvy/page.tsx';

const { customers, records } = rstest.hoisted(() => ({ customers: rstest.fn(), records: rstest.fn() }));

rstest.mock('../../src/api/records-client.ts', () => ({ executeRecords: records }));
rstest.mock('@app/party-registry/api/client', () => ({
  executeCounterpartyRead: rstest.fn(),
  listCustomers: customers,
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({ useNavigate: () => () => {}, useRouterState: () => '' }));
rstest.mock('../../src/routes/ultramodern-route-head', () => ({ UltramodernRouteHead: () => null }));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  FederatedI18nBoundary: ({ children }: { readonly children: ReactNode }) => children,
  useModernI18n: () => ({ language: 'cs', t: String }),
}));

const props: ModulePageProps = {
  context: { legalEntityId: 'company-a', principalId: 'lawyer-a', tenantId: 'tenant-a' },
  routeParams: {},
  search: '',
};

beforeEach(() => {
  // The owner's Node-only test config compiles TSX with the classic React runtime.
  rstest.stubGlobal('React', React);
  records.mockReset();
  records.mockReturnValue(Effect.fail({ _tag: 'RecordsUnavailableProblem' }));
  customers.mockReset();
  customers.mockReturnValue(Effect.never);
});

afterEach(() => {
  rstest.unstubAllGlobals();
});

// Contracts follow the live module-write signal (page data); only a failed load offers „Zkusit znovu“.
describe('agreements update without a manual refresh', () => {
  it('renders no refresh button while the contracts load', () => {
    const html = renderToStaticMarkup(createElement(RecordsPage, props));
    expect(html).toContain('legal-agreements.pages.records.title');
    expect(html).not.toContain('legal-agreements.demo.refresh');
    expect(html).not.toContain('legal-agreements.demo.retry');
  });

  it.live('opening the page loads the contracts', () =>
    Effect.gen(function* opensPage() {
      // Page data loads only in a browser document.
      rstest.stubGlobal('document', {});
      rstest.stubGlobal('dispatchEvent', () => true);
      yield* Effect.promise(() => preloadPage(props));
      expect(records).toHaveBeenCalledTimes(1);
    }),
  );
});
