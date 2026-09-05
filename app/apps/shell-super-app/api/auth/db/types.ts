import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { authRelations } from './schema.ts';

export type AuthDatabaseExecutor = NodePgDatabase<typeof authRelations>;
