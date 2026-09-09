import type { EffectPgDatabase } from 'drizzle-orm/effect-postgres';

import type { partyRelations } from './schema.ts';

export type PartyDatabaseExecutor = EffectPgDatabase<typeof partyRelations>;

type PartyTransactionCallback = Parameters<PartyDatabaseExecutor['transaction']>[0];

export type PartyTransaction = Parameters<PartyTransactionCallback>[0];
