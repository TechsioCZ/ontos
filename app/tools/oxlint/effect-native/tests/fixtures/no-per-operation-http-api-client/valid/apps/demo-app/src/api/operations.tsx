// A9 target shape: components run a long-lived Effect that yields the shared client.
import { Effect } from 'effect';
import { ContactsClientTag } from './client-layer.ts';

export const listCustomers = Effect.gen(function* () {
  const client = yield* ContactsClientTag;
  return yield* client.customerList.list({});
});

export function CustomersPage() {
  const onRefresh = () => Effect.runPromise(listCustomers);
  return (
    <button type="button" onClick={onRefresh}>
      Refresh
    </button>
  );
}
