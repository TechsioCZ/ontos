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

const fold = (value: string) =>
  value
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .toLowerCase();

/** Active customers whose name, IČO, e-mail or phone contains `query`, ignoring case and diacritics. */
export const findCustomers = (query: string) =>
  listCustomers({ includeArchived: false }).pipe(
    Effect.map((items) =>
      items.filter(
        (item) =>
          item.status === 'ACTIVE' &&
          fold([item.displayName, item.companyId, item.email, item.phone].join(' ')).includes(fold(query.trim())),
      ),
    ),
  );
