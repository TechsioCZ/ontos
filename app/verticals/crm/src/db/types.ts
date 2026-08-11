import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { crmDatabaseSchema } from './schema.ts';

export type CrmDatabaseExecutor = NodePgDatabase<typeof crmDatabaseSchema>;
