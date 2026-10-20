// Finance remains the owner of incoming invoices; resolve references through its governed public read.
import { executeRecords } from '@app/siampark-billing-finance/clients/records';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Effect } from 'effect';
import { useEffect, useState } from 'react';
import { browserRuntime } from '../../../../../runtime/browser-effect-runtime.ts';
import { usePurchasingT } from './purchasing-model.ts';

export interface IncomingInvoiceLink {
  readonly number: string;
  readonly supplier: string | undefined;
  readonly resourceId: string;
}

type FinanceLinks =
  | { readonly status: 'loading' | 'unavailable' }
  | { readonly status: 'ready'; readonly invoices: readonly IncomingInvoiceLink[] };

export const useIncomingInvoiceLinks = (): FinanceLinks => {
  const [state, setState] = useState<FinanceLinks>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    void browserRuntime.runPromise(
      executeRecords({}, 'siampark-ops.purchase-invoice-links').pipe(
        Effect.match({
          onFailure: (): FinanceLinks => ({ status: 'unavailable' }),
          onSuccess: (records): FinanceLinks => ({
            status: 'ready',
            invoices: records.state.invoices
              .filter((invoice) => invoice.direction === 'INCOMING' && invoice.businessState !== 'VOIDED')
              .map((invoice) => ({
                number: invoice.documentNumber,
                resourceId: invoice.ref.resourceId,
                supplier: invoice.counterpartyName,
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
  }, []);
  return state;
};

const normalize = (value: string) => value.trim().toLocaleLowerCase('cs-CZ');

/** Never turn an ambiguous number or a different supplier's invoice into a link. */
export const matchingIncomingInvoice = (
  invoices: readonly IncomingInvoiceLink[],
  number: string,
  supplier: string,
): IncomingInvoiceLink | undefined => {
  const matches = invoices.filter(
    (invoice) =>
      normalize(invoice.number) === normalize(number) &&
      (invoice.supplier === undefined || normalize(invoice.supplier) === normalize(supplier)),
  );
  return matches.length === 1 ? matches[0] : undefined;
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
      className="font-medium text-primary underline underline-offset-2"
      href={`/${lang}/siampark/finance?resourceId=${encodeURIComponent(match.resourceId)}`}
    >
      {k('orders.finance.open')}
    </a>
  );
};
