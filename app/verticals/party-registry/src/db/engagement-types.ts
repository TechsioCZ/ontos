import type { EffectPgDatabase } from 'drizzle-orm/effect-postgres';
import type { contactsRelations } from './engagement-schema.ts';

type ContactsDatabaseExecutor = EffectPgDatabase<typeof contactsRelations>;

type ContactsTransactionCallback = Parameters<ContactsDatabaseExecutor['transaction']>[0];

export type ContactsTransaction = Parameters<ContactsTransactionCallback>[0];
