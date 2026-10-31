// Contact (party registry) and invoice (finance) references for documents. Read through each owner's PUBLIC governed
// read, filtered to what the current person may see; the link stores the owner's resource id + a display snapshot.
import { listCustomers } from '@app/party-registry/api/client';
import { Effect } from 'effect';
import type { Cause } from 'effect';
import { useEffect, useState } from 'react';
import type { SubjectRef } from '../../shared/domain/documents.ts';
import { readFinance } from '../api/finance-reads.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';

export type OptionsState<Failure> =
  | { readonly status: 'loading' }
  | { readonly error: Failure; readonly status: 'failed' }
  | { readonly options: readonly SubjectRef[]; readonly status: 'ready' };

const useOptions = <E>(load: () => Effect.Effect<readonly SubjectRef[], E>): OptionsState<E | Cause.TimeoutError> => {
  const [state, setState] = useState<OptionsState<E | Cause.TimeoutError>>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    void browserRuntime.runPromise(
      load().pipe(
        Effect.timeout('12 seconds'),
        Effect.match({
          onFailure: (error): OptionsState<E | Cause.TimeoutError> => ({ error, status: 'failed' }),
          onSuccess: (options): OptionsState<E | Cause.TimeoutError> => ({ options, status: 'ready' }),
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
  }, [load]);
  return state;
};

const loadContacts = () =>
  listCustomers({ includeArchived: false }).pipe(
    Effect.map((customers) =>
      customers
        .flatMap((customer): SubjectRef[] =>
          customer.displayName === null
            ? []
            : [{ id: customer.counterpartyRef.resourceId, kind: 'contact', label: customer.displayName }],
        )
        .toSorted((left, right) => left.label.localeCompare(right.label, 'cs')),
    ),
  );

const loadInvoices = () =>
  readFinance('facility-operations.document-invoice-options').pipe(
    Effect.map((records) =>
      records.state.invoices.flatMap((invoice): SubjectRef[] =>
        invoice.businessState === 'VOIDED'
          ? []
          : [
              {
                id: invoice.ref.resourceId,
                kind: 'invoice',
                label: [invoice.number ?? invoice.documentNumber, invoice.counterpartyName]
                  .filter((part) => part !== undefined)
                  .join(' · ')
                  .slice(0, 300),
              },
            ],
      ),
    ),
  );

/** Customers / counterparties of the current company (party registry). */
export const useContactOptions = () => useOptions(loadContacts);
/** Issued and received invoices of the current company (finance). */
export const useInvoiceOptions = () => useOptions(loadInvoices);
