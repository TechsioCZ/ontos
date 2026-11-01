import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import React, { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ModulePageProps } from '@app/shared-contracts/page-data';

import { AiApprovalsPage, preloadPage } from '../../src/routes/[lang]/prodej/schvalovani-ai/page.tsx';

const { merchandiseRecords, records } = rstest.hoisted(() => ({
  merchandiseRecords: rstest.fn(),
  records: rstest.fn(),
}));

rstest.mock('../../src/api/records-consumer.ts', () => ({ executeRecords: records }));
rstest.mock('@app/merchandise/clients/records', () => ({ executeRecords: merchandiseRecords }));
rstest.mock('@modern-js/runtime/head', () => ({ Helmet: () => null }));
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
  merchandiseRecords.mockReset();
  merchandiseRecords.mockReturnValue(Effect.fail('offline'));
});

afterEach(() => {
  rstest.unstubAllGlobals();
});

// Proposals follow the live module-write signal (page data), so the screen offers no manual refresh.
describe('AI approvals update without a manual refresh', () => {
  it('renders no refresh button', () => {
    const html = renderToStaticMarkup(createElement(AiApprovalsPage, props));
    expect(html).not.toContain('Obnovit');
    expect(html).not.toContain('<button');
  });

  it.live('opening the screen loads opportunity and order proposals', () =>
    Effect.gen(function* opensScreen() {
      // Page data loads only in a browser document.
      rstest.stubGlobal('document', {});
      rstest.stubGlobal('dispatchEvent', () => true);
      yield* Effect.promise(() => preloadPage(props));
      expect(records).toHaveBeenCalledTimes(1);
      expect(merchandiseRecords).toHaveBeenCalledTimes(1);
    }),
  );
});
