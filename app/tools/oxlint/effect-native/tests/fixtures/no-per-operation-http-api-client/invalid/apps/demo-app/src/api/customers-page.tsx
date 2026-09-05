// expect-count: 2
// A9: a route module builds its own client and a component calls that factory per interaction.
import { Effect } from 'effect';
import { HttpApiClient } from 'effect/unstable/httpapi';
import { contactsApi } from './api.ts';

const loadCustomers = (page: number) =>
  HttpApiClient.make(contactsApi, { baseUrl: '/api' }).pipe(
    Effect.flatMap((client) => client.customerList.getCustomerList({ payload: { page } })),
  );

export function CustomersPage() {
  const onRefresh = () => Effect.runPromise(loadCustomers(1));
  return (
    <button type="button" onClick={onRefresh}>
      Refresh
    </button>
  );
}
