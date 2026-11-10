import { Cause } from 'effect';
import { expect, it } from 'effect-rstest';
import { orderDetailTitle } from '../../src/routes/[lang]/prodej/objednavky/order-detail-view.ts';
import { orderNavigationFailureKey } from '../../src/routes/[lang]/prodej/objednavky/order-navigation.ts';

/** Echoes the key and its parameters, so each test can read which message the title asked for. */
const translate = (key: string | string[], ...args: unknown[]) => `${String(key)}:${JSON.stringify(args)}`;

it('titles the open order by its number, and the edit form by the same number', () => {
  expect(orderDetailTitle({ editing: false, number: 'OBJ-42', t: translate })).toBe(
    'merchandise.pages.orders.detail.title:[{"number":"OBJ-42"}]',
  );
  expect(orderDetailTitle({ editing: true, number: 'OBJ-42', t: translate })).toBe(
    'merchandise.pages.orders.detail.editTitle:[{"number":"OBJ-42"}]',
  );
});

it('gives a timed-out order page its own message and every other failure the generic one', () => {
  expect(orderNavigationFailureKey(new Cause.TimeoutError())).toBe('detail.navigationTimeout');
  expect(orderNavigationFailureKey(new Cause.UnknownError('navigation failed'))).toBe('detail.navigationFailed');
});
