import type { EffectPgDatabase } from 'drizzle-orm/effect-postgres';

import type { catalogRelations } from './schema.ts';

type CatalogDatabaseExecutor = EffectPgDatabase<typeof catalogRelations>;

type CatalogTransactionCallback = Parameters<CatalogDatabaseExecutor['transaction']>[0];

// Keep the transaction projection tied to the owner schema for database factories and tests.
export type CatalogTransaction = Parameters<CatalogTransactionCallback>[0];
