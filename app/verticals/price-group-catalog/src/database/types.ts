import type { EffectPgDatabase } from 'drizzle-orm/effect-postgres';

import type { priceGroupCatalogRelations } from './schema.ts';

export type PriceGroupCatalogDatabaseExecutor = EffectPgDatabase<typeof priceGroupCatalogRelations>;

type PriceGroupCatalogTransactionCallback = Parameters<PriceGroupCatalogDatabaseExecutor['transaction']>[0];

// eslint-disable-next-line no-unused-vars -- This projection proves that owner work stays inside a caller-owned Drizzle transaction.
type PriceGroupCatalogTransaction = Parameters<PriceGroupCatalogTransactionCallback>[0];
