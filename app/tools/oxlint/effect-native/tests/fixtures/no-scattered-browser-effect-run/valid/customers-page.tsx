// Route code that keeps the typed failure union: composes Effects, hands them to the shared
// adapter, and matches the failure vocabulary instead of reclassifying after a Promise.
import { Match } from 'effect';
import type { Effect } from 'effect';

import { archiveCustomer, getCustomerList } from '../contacts-api.ts';
import { useEffectMutation, useEffectQuery } from './runtime/query-adapter.ts';

type CustomerListFailure = { readonly _tag: 'Unauthorized' } | { readonly _tag: 'Unavailable' };

const describeFailure = Match.type<CustomerListFailure>().pipe(
  Match.tag('Unauthorized', () => 'sign-in-required'),
  Match.tag('Unavailable', () => 'retry-later'),
  Match.exhaustive,
);

export const CustomersPage = () => {
  const query = useEffectQuery(['customers'], getCustomerList({ correlationId: 'static' }));
  const lifecycle = useEffectMutation((customerId: string) => archiveCustomer({ customerId }));
  const names = (query.data ?? []).map((customer: { readonly name: string }) => customer.name);
  return (
    <ul aria-busy={lifecycle.isPending}>
      {names.map((name: string) => (
        <li key={name}>{query.error === null ? name : describeFailure(query.error)}</li>
      ))}
    </ul>
  );
};

export const listEffect: Effect.Effect<ReadonlyArray<string>, CustomerListFailure> =
  getCustomerList({ correlationId: 'static' });
