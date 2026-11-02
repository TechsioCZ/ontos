import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import React, { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { HomeSummary, preloadPage as preloadHome } from '../../src/components/home-summary.tsx';
import { AiApprovalsPage, preloadPage as preloadApprovals } from '../../src/routes/[lang]/crm/schvalovani-ai/page.tsx';

const { records } = rstest.hoisted(() => ({ records: rstest.fn() }));

rstest.mock('../../src/api/records-consumer.ts', () => ({ executeRecords: records }));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  FederatedI18nBoundary: ({ children }: { readonly children: ReactNode }) => children,
  useModernI18n: () => ({ language: 'cs', t: String }),
}));

const props = { routeParams: {}, search: '' };

beforeEach(() => {
  // The owner's Node-only test config compiles TSX with the classic React runtime.
  rstest.stubGlobal('React', React);
  records.mockReset();
  records.mockReturnValue(Effect.fail('offline'));
});

afterEach(() => {
  rstest.unstubAllGlobals();
});

// Records follow the live module-write signal (page data), so no screen offers a manual refresh.
describe('CRM screens update without a manual refresh', () => {
  it.each([
    ['home summary', HomeSummary],
    ['AI approvals', AiApprovalsPage],
  ])('%s renders no refresh button', (_name, component) => {
    const html = renderToStaticMarkup(createElement(component));
    expect(html).not.toContain('Obnovit');
    expect(html).not.toContain('<button');
  });

  it.live('opening either screen loads the shared records read', () =>
    Effect.gen(function* opensScreen() {
      // Page data loads only in a browser document.
      rstest.stubGlobal('document', {});
      rstest.stubGlobal('dispatchEvent', () => true);
      expect(preloadApprovals).toBe(preloadHome);
      yield* Effect.promise(() => preloadHome(props));
      expect(records).toHaveBeenCalledTimes(1);
    }),
  );
});
