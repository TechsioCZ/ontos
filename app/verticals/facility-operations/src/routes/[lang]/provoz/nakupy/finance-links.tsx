// Finance remains the owner of incoming invoices; resolve references through its governed public read.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Effect } from 'effect';
import { useEffect, useState } from 'react';
import { readFinance } from '../../../../api/finance-reads.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { usePurchasingT } from './purchasing-model.ts';

import { matchingIncomingInvoice } from './purchase-invoice-match.ts';
import type { IncomingInvoiceLink } from './purchase-invoice-match.ts';

type FinanceLinks =
  | { readonly status: 'loading' | 'unavailable' }
  | {
      readonly status: 'ready';
      /** Finance decides whether this person may create invoice drafts; provoz only mirrors it. */
      readonly canWrite: boolean;
      readonly invoices: readonly IncomingInvoiceLink[];
    };

export type { FinanceLinks };

export const useIncomingInvoiceLinks = (refresh = 0): FinanceLinks => {
  const [state, setState] = useState<FinanceLinks>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    void browserRuntime.runPromise(
      readFinance('facility-operations.purchase-invoice-links').pipe(
        Effect.match({
          onFailure: (): FinanceLinks => ({ status: 'unavailable' }),
          onSuccess: (records): FinanceLinks => ({
            status: 'ready',
            canWrite: records.canWrite,
            invoices: records.state.invoices
              .filter((invoice) => invoice.direction === 'INCOMING' && invoice.businessState !== 'VOIDED')
              .map((invoice) => ({
                number: invoice.documentNumber,
                resourceId: invoice.ref.resourceId,
                supplier: invoice.counterpartyName,
                ...(invoice.sourceOrder === undefined ? {} : { sourceOrder: invoice.sourceOrder }),
              })),
          }),
        }),
        Effect.map((next) => {
          if (alive) {
            setState(next);
          }
        }),
      ),
    );
    return () => {
      alive = false;
    };
  }, [refresh]);
  return state;
};

export const FinanceInvoiceLink = ({
  links,
  number,
  supplier,
}: {
  readonly links: FinanceLinks;
  readonly number: string;
  readonly supplier: string;
}) => {
  const k = usePurchasingT();
  const { language } = useModernI18n();
  const match = links.status === 'ready' ? matchingIncomingInvoice(links.invoices, number, supplier) : undefined;
  if (match === undefined) {
    return (
      <span className="text-fg-secondary text-xs">
        {k(`orders.finance.${links.status === 'ready' ? 'notFound' : links.status}`)}
      </span>
    );
  }
  const lang = language.startsWith('en') ? 'en' : 'cs';
  return (
    <a
      className="font-medium text-fg-primary underline underline-offset-2"
      href={`/${lang}/finance?resourceId=${encodeURIComponent(match.resourceId)}`}
    >
      {k('orders.finance.open')}
    </a>
  );
};
