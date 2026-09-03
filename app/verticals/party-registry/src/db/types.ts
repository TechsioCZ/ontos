import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { partyDatabaseSchema } from './schema.ts';

export type PartyDatabaseExecutor = NodePgDatabase<typeof partyDatabaseSchema>;

type PartyTransactionCallback = Parameters<PartyDatabaseExecutor['transaction']>[0];

export type PartyTransaction = Parameters<PartyTransactionCallback>[0];
