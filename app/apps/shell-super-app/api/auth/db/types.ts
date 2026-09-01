import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { authDatabaseSchema } from './schema.ts';

export type AuthDatabaseExecutor = NodePgDatabase<typeof authDatabaseSchema>;
