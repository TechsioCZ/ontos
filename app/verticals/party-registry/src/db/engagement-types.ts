import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { contactsRelations } from './engagement-schema.ts';

export type ContactsDatabaseExecutor = NodePgDatabase<typeof contactsRelations>;

type ContactsTransactionCallback = Parameters<ContactsDatabaseExecutor['transaction']>[0];

export type ContactsTransaction = Parameters<ContactsTransactionCallback>[0];
