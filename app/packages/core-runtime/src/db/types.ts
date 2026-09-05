import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { coreRelations } from './schema.ts';

export type CoreDatabaseExecutor = NodePgDatabase<typeof coreRelations>;

type CoreTransactionCallback = Parameters<CoreDatabaseExecutor['transaction']>[0];

export type CoreTransaction = Parameters<CoreTransactionCallback>[0];

export type CoreDbExecutor = CoreDatabaseExecutor | CoreTransaction;
