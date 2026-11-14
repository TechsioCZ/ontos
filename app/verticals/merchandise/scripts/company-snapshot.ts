// Admin-script access to one company's merchandise rows (seeds, demo resets, presentation repairs). Requests never
// use this: they read bounded pages (src/services/merchandise-queries.ts).
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Effect } from 'effect';
import type { MerchandiseState } from '../shared/apis/records.ts';
import { merchandiseRelations } from '../src/database/schema.ts';
import { readSnapshot, replaceSnapshot } from '../src/services/merchandise-store.ts';
import type { StoreScope } from '../src/services/merchandise-store.ts';

/** The company's full merchandise snapshot, or undefined when it was never seeded. */
export const readCompanySnapshot = Effect.fn('MerchandiseSeed.read')(function* readCompanySnapshot(scope: StoreScope) {
  const db = yield* makeWithDefaults({ relations: merchandiseRelations });
  return yield* readSnapshot(db, scope);
});

/** Replaces the company's merchandise with `state` in one transaction (batched inserts); returns the revision. */
export const writeCompanySnapshot = Effect.fn('MerchandiseSeed.write')(function* writeCompanySnapshot(
  scope: StoreScope,
  state: MerchandiseState,
) {
  const db = yield* makeWithDefaults({ relations: merchandiseRelations });
  return yield* db.transaction((transaction) => replaceSnapshot(transaction, scope, state));
});
