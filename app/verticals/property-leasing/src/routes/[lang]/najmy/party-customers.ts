import { executeCustomerList } from '@app/party-registry/apis/customer-list/client';
import { Effect, Random } from 'effect';

/** Current CUSTOMER Counterparties of the selected Legal Entity through Party Registry's customer-list read. */
export const listCustomers = (request: Parameters<typeof executeCustomerList>[0] = {}) =>
  Effect.all([Random.nextInt, Random.nextInt], { concurrency: 1 }).pipe(
    Effect.flatMap(([first, second]) =>
      executeCustomerList(request, `party-registry:customer-list:${first}:${second}`),
    ),
    Effect.map(({ items }) => items),
  );
