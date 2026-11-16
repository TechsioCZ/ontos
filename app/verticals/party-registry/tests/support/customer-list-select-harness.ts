import type { SQL, Table } from 'drizzle-orm';
import { getTableName } from 'drizzle-orm';
import { Effect } from 'effect';

import type { listCustomerRecords } from '../../src/services/customer-list-persistence.service.ts';

/** The transaction the customer list and counterparty identity reads take: only its `select`. */
export type CustomerListSelectTransaction = Parameters<typeof listCustomerRecords>[0];

/**
 * The narrow Drizzle native Effect select surface the customer-list persistence service uses: each `select` answers
 * the next queued rows, and the harness records the tables it reads and the conditions it filters by.
 */
export const customerListSelectHarness = (selects: readonly (readonly object[])[]) => {
  const queue = [...selects];
  const selectedTables: string[] = [];
  const conditions: SQL[] = [];
  const select = () => {
    const rows = queue.shift() ?? [];
    const chain = Object.assign(Effect.succeed(rows), {
      from: (table: Table) => {
        selectedTables.push(getTableName(table));
        return chain;
      },
      innerJoin: (table: Table) => {
        selectedTables.push(getTableName(table));
        return chain;
      },
      limit: () => chain,
      orderBy: () => chain,
      where: (condition: SQL) => {
        conditions.push(condition);
        return chain;
      },
    });
    return chain;
  };
  // SAFETY: the harness implements precisely the select fluent methods the customer-list persistence service calls.
  // eslint-disable-next-line anti-slop/no-chained-type-assertions -- Drizzle's full select builder is narrowed to the fluent methods this service calls. expires: 2026-12-31.
  const transaction = { select } as unknown as CustomerListSelectTransaction;
  return { conditions, selectedTables, transaction };
};
