import type { EffectPgDatabase } from 'drizzle-orm/effect-postgres';
import type { commerceCustomerContextRelations } from './schema.ts';

type CommerceCustomerContextDatabaseExecutor = EffectPgDatabase<typeof commerceCustomerContextRelations>;

type TransactionCallback = Parameters<CommerceCustomerContextDatabaseExecutor['transaction']>[0];

/** Available only to the owner-local persistence factory. */
export type CommerceCustomerContextTransaction = Parameters<TransactionCallback>[0];
