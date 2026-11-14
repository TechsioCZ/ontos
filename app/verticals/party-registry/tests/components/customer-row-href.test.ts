import { expect, it } from 'effect-rstest';

import { customerRowHref } from '../../src/routes/[lang]/prodej/zakaznici/page.tsx';

const counterpartyId = '40000000-0000-4000-8000-000000000001';

// The list page cannot be rendered in this test setup, so the row-click decision is tested as a pure function.
it('navigates a customer row to the full page in page mode', () => {
  expect(customerRowHref('page', 'cs', counterpartyId)).toBe(`/cs/prodej/zakaznici/${counterpartyId}`);
});

it('encodes the counterparty id in the full-page route', () => {
  expect(customerRowHref('page', 'en', 'a/b c')).toBe('/en/prodej/zakaznici/a%2Fb%20c');
});

it('keeps the side panel for a row click in panel mode', () => {
  expect(customerRowHref('panel', 'cs', counterpartyId)).toBeNull();
});
