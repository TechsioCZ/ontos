import { sql } from 'drizzle-orm';
import { Effect } from 'effect';

import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { ASSORTMENT_TABLES, gatewayAssertionRedemptions } from '../../src/database/schema.ts';
import type { assortmentRelations } from '../../src/database/schema.ts';

type AssortmentAdminDatabase = TestDatabaseFromClient<typeof assortmentRelations>;

/** Owner tables the shared runtime role reads and writes under its row-level security policies. */
const ASSORTMENT_OWNER_TABLES = ASSORTMENT_TABLES.filter((table) => table !== gatewayAssertionRedemptions);

const ownerTableAccess = (admin: AssortmentAdminDatabase, statement: 'grant' | 'revoke') =>
  admin.transaction((transaction) =>
    Effect.forEach(
      ASSORTMENT_OWNER_TABLES,
      (table) =>
        transaction.execute(
          statement === 'grant'
            ? sql`grant select, insert, update, delete on table ${table} to ontos_runtime`
            : sql`revoke select, insert, update, delete on table ${table} from ontos_runtime`,
          'objects',
        ),
      { discard: true },
    ),
  );

/**
 * Lets the shared runtime role (the enrolled session-setting identity Assortment runs as) use the owner
 * tables for the current test scope, so owner operations run under the production role and its row-level
 * security instead of an administrator that bypasses both. Schema usage and the decision-set fence routine
 * are granted by the migrations and stay untouched.
 */
export const grantRuntimeOwnerTableAccess = (admin: AssortmentAdminDatabase) =>
  Effect.gen(function* grantRuntimeOwnerTableAccessForScope() {
    yield* ownerTableAccess(admin, 'grant');
    yield* Effect.addFinalizer(() => ownerTableAccess(admin, 'revoke').pipe(Effect.orDie));
  });
