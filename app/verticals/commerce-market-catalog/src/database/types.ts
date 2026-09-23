import type { EffectPgDatabase } from 'drizzle-orm/effect-postgres';
import type { commerceMarketCatalogRelations } from './schema.ts';

export type CommerceMarketCatalogDatabaseExecutor = EffectPgDatabase<typeof commerceMarketCatalogRelations>;
