import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { contactsDatabaseSchema } from './schema.ts';

export type ContactsDatabaseExecutor = NodePgDatabase<typeof contactsDatabaseSchema>;

type ContactsTransactionCallback = Parameters<ContactsDatabaseExecutor['transaction']>[0];

export type ContactsTransaction = Parameters<ContactsTransactionCallback>[0];
