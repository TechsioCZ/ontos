import type { EffectPgDatabase } from 'drizzle-orm/effect-postgres';
import type { assortmentRelations } from './schema.ts';

export type AssortmentDatabaseExecutor = EffectPgDatabase<typeof assortmentRelations>;
