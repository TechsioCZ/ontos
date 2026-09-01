import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { coreDatabaseSchema } from './schema.ts';

export type CoreDatabaseExecutor = NodePgDatabase<typeof coreDatabaseSchema>;

type CoreTransactionCallback = Parameters<CoreDatabaseExecutor['transaction']>[0];

export type CoreTransaction = Parameters<CoreTransactionCallback>[0];

export type CoreDbExecutor = CoreDatabaseExecutor | CoreTransaction;
