import type { EffectPgDatabase } from 'drizzle-orm/effect-postgres';
import type { paymentTermCatalogRelations } from './schema.ts';

export type PaymentTermCatalogDatabaseExecutor = EffectPgDatabase<typeof paymentTermCatalogRelations>;

type PaymentTermCatalogTransactionCallback = Parameters<PaymentTermCatalogDatabaseExecutor['transaction']>[0];

// eslint-disable-next-line no-unused-vars -- Retain the transaction type projection that structurally connects the exported executor to callback-scoped transactions.
type PaymentTermCatalogTransaction = Parameters<PaymentTermCatalogTransactionCallback>[0];
