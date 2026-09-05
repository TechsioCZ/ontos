import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { partyRelations } from './schema.ts';

export type PartyDatabaseExecutor = NodePgDatabase<typeof partyRelations>;

type PartyTransactionCallback = Parameters<PartyDatabaseExecutor['transaction']>[0];

export type PartyTransaction = Parameters<PartyTransactionCallback>[0];
