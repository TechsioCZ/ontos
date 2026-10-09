import type { EffectPgDatabase } from 'drizzle-orm/effect-postgres';

import type { inventoryRelations } from './schema.ts';

export type InventoryDatabaseExecutor = EffectPgDatabase<typeof inventoryRelations>;
