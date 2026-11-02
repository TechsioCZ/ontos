import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import React, { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { RecordsPage, preloadPage } from '../../src/routes/[lang]/aktivity/page.tsx';

const { records, workRecords } = rstest.hoisted(() => ({ records: rstest.fn(), workRecords: rstest.fn() }));

rstest.mock('../../src/api/records-consumer.ts', () => ({ executeRecords: records }));
rstest.mock('@app/work-tasks/clients/records', () => ({ executeRecords: workRecords }));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({ useRouterState: () => '' }));
rstest.mock('../../src/routes/ultramodern-route-head', () => ({ UltramodernRouteHead: () => null }));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  FederatedI18nBoundary: ({ children }: { readonly children: ReactNode }) => children,
  useModernI18n: () => ({ language: 'cs', t: String }),
}));

const props: ModulePageProps = {
  context: { legalEntityId: 'company-a', principalId: 'seller-a', tenantId: 'tenant-a' },
  routeParams: {},
  search: '',
};

beforeEach(() => {
  // The owner's Node-only test config compiles TSX with the classic React runtime.
  rstest.stubGlobal('React', React);
  records.mockReset();
  records.mockReturnValue(Effect.fail('offline'));
  workRecords.mockReset();
});

afterEach(() => {
  rstest.unstubAllGlobals();
});

// Activities and follow-up Tasks follow the live module-write signal (page data); nothing is loaded by a button.
describe('activities load without a manual trigger', () => {
  it('renders no load or refresh button', () => {
    const html = renderToStaticMarkup(createElement(RecordsPage, props));
    expect(html).not.toContain('pages.records.refresh');
    expect(html).not.toContain('pages.records.loadTasks');
    expect(html).not.toContain('<button');
  });

  it.live('opening the page loads the activities of the legal entity', () =>
    Effect.gen(function* opensPage() {
      // Page data loads only in a browser document.
      rstest.stubGlobal('document', {});
      rstest.stubGlobal('dispatchEvent', () => true);
      yield* Effect.promise(() => preloadPage(props));
      expect(records).toHaveBeenCalledTimes(1);
      expect(workRecords).not.toHaveBeenCalled();
    }),
  );
});
