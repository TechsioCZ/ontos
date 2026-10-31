import { optionalField } from '../../../../../shared/domain/common.ts';
// Finance remains the owner of incoming invoices; resolve references through its governed public read.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Effect } from 'effect';
import { useEffect, useState } from 'react';
import { readFinance } from '../../../../api/finance-reads.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { langOf } from '../../../../ui/ops-agenda/ui-bits.tsx';
import { usePurchasingT } from './purchasing-model.ts';

import { matchingIncomingInvoice } from './purchase-invoice-match.ts';
import type { IncomingInvoiceLink } from './purchase-invoice-match.ts';

type FinanceLinks =
  | { readonly status: 'loading' }
  | { readonly cause: Effect.Error<ReturnType<typeof readFinance>>; readonly status: 'unavailable' }
  | {
      /** Finance decides whether this person may create invoice drafts; provoz only mirrors it. */
      readonly canWrite: boolean;
      readonly invoices: readonly IncomingInvoiceLink[];
      readonly status: 'ready';
    };

export type { FinanceLinks };

export const useIncomingInvoiceLinks = (refresh = 0): FinanceLinks => {
  const [state, setState] = useState<FinanceLinks>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    void browserRuntime.runPromise(
      readFinance(`facility-operations.purchase-invoice-links.${refresh}`).pipe(
        Effect.match({
          onFailure: (cause): FinanceLinks => ({ cause, status: 'unavailable' }),
          onSuccess: (records): FinanceLinks => ({
            canWrite: records.canWrite,
            invoices: records.state.invoices.flatMap((invoice) =>
              invoice.direction === 'INCOMING' && invoice.businessState !== 'VOIDED'
                ? [
                    {
                      number: invoice.documentNumber,
                      resourceId: invoice.ref.resourceId,
                      supplier: invoice.counterpartyName,
                      ...optionalField('sourceOrder', invoice.sourceOrder),
                    },
                  ]
                : [],
            ),
            status: 'ready',
          }),
        }),
        Effect.tap((next) =>
          Effect.sync(() => {
            if (alive) {
              setState(next);
            }
          }),
        ),
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
  const lang = langOf(language.slice(0, 2));
  return (
    <a
      className="font-medium text-fg-primary underline underline-offset-2"
      href={`/${lang}/finance?resourceId=${encodeURIComponent(match.resourceId)}`}
    >
      {k('orders.finance.open')}
    </a>
  );
};
