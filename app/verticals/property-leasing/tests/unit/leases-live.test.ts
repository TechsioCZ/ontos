import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import React, { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { RecordsPage, preloadPage } from '../../src/routes/[lang]/najmy/page.tsx';

const { records } = rstest.hoisted(() => ({ records: rstest.fn() }));

rstest.mock('../../src/api/records-client.ts', () => ({ executeRecords: records }));
rstest.mock('@app/legal-agreements/clients/records', () => ({ executeRecords: () => Effect.never }));
rstest.mock('@app/property-portfolio/clients/records', () => ({ executeRecords: () => Effect.never }));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({ useNavigate: () => () => {}, useRouterState: () => '' }));
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

beforeEach(() => {
  // The owner's Node-only test config compiles TSX with the classic React runtime.
  rstest.stubGlobal('React', React);
  records.mockReset();
  records.mockReturnValue(Effect.fail({ _tag: 'RecordsUnavailableProblem' }));
});

afterEach(() => {
  rstest.unstubAllGlobals();
});

// Leases follow the live module-write signal (page data); only a failed or refused read offers „Zkusit znovu“.
describe('leases update without a manual refresh', () => {
  it('renders no refresh button while the leases load', () => {
    const html = renderToStaticMarkup(createElement(RecordsPage, props));
    expect(html).toContain('property-leasing.demo.kind.ALL');
    expect(html).not.toContain('property-leasing.demo.refresh');
    expect(html).not.toContain('property-leasing.demo.retry');
  });

  it.live('opening the page loads the leases', () =>
    Effect.gen(function* opensPage() {
      // Page data loads only in a browser document.
      rstest.stubGlobal('document', {});
      rstest.stubGlobal('dispatchEvent', () => true);
      yield* Effect.promise(() => preloadPage(props));
      expect(records).toHaveBeenCalledTimes(1);
    }),
  );
});
