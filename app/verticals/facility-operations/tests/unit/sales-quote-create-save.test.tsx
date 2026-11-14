// @rstest-environment happy-dom
// A new sales quote is created on the one shared Uložit (the former "Uložit koncept" / "Uložit odeslanou" pair is a
// status field now): one click sends the same command, sent by default, and leaving with typed input asks first.
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { createElement } from 'react';
import { SalesQuoteFormPanel } from '../../src/routes/[lang]/provoz/nakupy/sales-tab.tsx';
import { click, labels, mountPanel, typeInto, unmountPanels } from './draft-base-fixture.ts';
import { leaveQuestionOpen, pick, recordingRunner, saveSent, settleUntil } from './form-save-fixture.ts';
import type { RecordingRunner } from './form-save-fixture.ts';

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));
rstest.mock('../../src/ui/party-customers.ts', () => ({
  listCustomers: () =>
    Effect.succeed([
      {
        counterpartyRef: {
          resourceId: '44444444-4444-4444-8444-444444444444',
          tenantId: '70000000-0000-4000-8000-000000000020',
        },
        displayName: 'Kavárna Dolce',
        partyId: 'party-1',
      },
    ]),
}));

const copy = { cancel: 'facility-operations.common.cancel' };
const customerId = '44444444-4444-4444-8444-444444444444';
const calls: string[] = [];
const mount = (runner: RecordingRunner) =>
  mountPanel(
    createElement(SalesQuoteFormPanel, {
      onClose: () => {
        calls.push('close');
      },
      onSaved: () => {
        calls.push('saved');
      },
      run: runner.run,
    }),
  );
const customersLoaded = () => document.querySelector('select[name="sales-customer"]') !== null;

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  calls.length = 0;
});

afterEach(() => {
  unmountPanels();
  rstest.unstubAllGlobals();
});

describe('new sales quote', () => {
  it.live('types the quote, saves once as sent and goes on', () =>
    Effect.gen(function* scenario() {
      const runner = recordingRunner();
      yield* mount(runner);
      yield* settleUntil(customersLoaded);
      yield* pick('sales-customer', customerId);
      yield* typeInto('[id$="-0-description"]', 'Servis vzduchotechniky');
      yield* typeInto('[id$="-0-price"]', '4 500');
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([
        expect.objectContaining({
          _tag: 'SalesQuoteCreate',
          lines: [{ description: 'Servis vzduchotechniky', quantity: 1, unitPriceMinor: 450_000, vatRate: 21 }],
          status: 'sent',
        }),
      ]);
      expect(calls).toEqual(['saved']);
    }),
  );

  it.live('kept as a draft when the status says so', () =>
    Effect.gen(function* scenario() {
      const runner = recordingRunner();
      yield* mount(runner);
      yield* settleUntil(customersLoaded);
      yield* pick('sales-customer', customerId);
      yield* typeInto('[id$="-0-description"]', 'Servis');
      yield* typeInto('[id$="-0-price"]', '100');
      yield* pick('sales-quote-status', 'draft');
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([expect.objectContaining({ _tag: 'SalesQuoteCreate', status: 'draft' })]);
    }),
  );

  it.live('Zrušit with typed lines asks; Zahodit změny leaves without sending', () =>
    Effect.gen(function* scenario() {
      const runner = recordingRunner();
      yield* mount(runner);
      yield* typeInto('[id$="-0-description"]', 'Servis');
      yield* click(copy.cancel);
      expect(leaveQuestionOpen()).toBe(true);
      yield* click(labels.discard);
      expect(calls).toEqual(['close']);
      expect(runner.sent).toEqual([]);
    }),
  );
});
