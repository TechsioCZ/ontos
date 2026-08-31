import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { projectsDatabaseSchema } from './schema.ts';

export type ProjectsDatabaseExecutor = NodePgDatabase<typeof projectsDatabaseSchema>;

type ProjectsTransactionCallback = Parameters<ProjectsDatabaseExecutor['transaction']>[0];

export type ProjectsTransaction = Parameters<ProjectsTransactionCallback>[0];
