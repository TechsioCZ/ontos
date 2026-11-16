import { definePageData, pageDataPending } from '@app/shared-contracts/page-data';
import { Result, Schema } from 'effect';
import { useEffect, useSyncExternalStore } from 'react';
import type { VatChoices } from '../../../../shared/apis/vat-choices.ts';
import { isPlausibleIssueDate } from '../../../../shared/domain/invoice-draft.ts';
import { executeVatChoices } from '../../../api/vat-choices-client.ts';
import { financeBrowserRuntime } from '../../../runtime/browser.ts';

const VatChoicesKeySchema = Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String]));
const encodeKey = (key: readonly [string, string]) => Result.getOrThrow(Schema.encodeResult(VatChoicesKeySchema)(key));

interface VatChoicesInput {
  readonly on: string;
  readonly scope: string;
}

/**
 * The VAT an invoice line may use, per verified scope and issue date. Finance's own read answers it from Tax, so any
 * Finance user who fills in invoices gets the company's current rates without a Tax right of their own.
 */
const vatChoicesData = definePageData({
  changesFrom: ['finance-billing', 'tax'],
  key: ({ on, scope }: VatChoicesInput) => encodeKey([scope, on]),
  load: ({ on }: VatChoicesInput) => executeVatChoices({ on }, 'finance-billing.vat-choices'),
  maxEntries: 24,
  runtime: financeBrowserRuntime,
});

/** Where a form stands with the company's VAT: still loading, ready, or Tax cannot answer right now. */
export type VatChoicesState =
  | { readonly state: 'loading' }
  | { readonly choices: VatChoices; readonly state: 'ready' }
  | { readonly state: 'unavailable' };

const pendingSnapshot = () => pageDataPending;

/** The VAT choices on `on` (YYYY-MM-DD) for the scope; nothing is read for a half-typed date or without a scope. */
export const useVatChoices = (scope: string | undefined, on: string): VatChoicesState => {
  const input = scope === undefined || !isPlausibleIssueDate(on) ? undefined : { on, scope };
  const snapshot = useSyncExternalStore(
    vatChoicesData.subscribe,
    () => (input === undefined ? pageDataPending : vatChoicesData.snapshot(input)),
    pendingSnapshot,
  );
  const wantedScope = input?.scope;
  const wantedOn = input?.on;
  useEffect(() => {
    if (wantedScope !== undefined && wantedOn !== undefined) {
      vatChoicesData.ensure({ on: wantedOn, scope: wantedScope });
    }
  }, [wantedOn, wantedScope]);
  if (snapshot.state === 'ready') {
    return { choices: snapshot.value, state: 'ready' };
  }
  return snapshot.state === 'failed' ? { state: 'unavailable' } : { state: 'loading' };
};

/** The choices once Tax answered; undefined while loading or when Tax cannot answer. */
export const choicesOf = (vat: VatChoicesState): VatChoices | undefined =>
  vat.state === 'ready' ? vat.choices : undefined;
