import type { EffectPgDatabase } from 'drizzle-orm/effect-postgres';
import type { taxRelations } from './schema.ts';

export type TaxDatabaseExecutor = EffectPgDatabase<typeof taxRelations>;
