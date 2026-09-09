import type { EffectPgDatabase } from 'drizzle-orm/effect-postgres';
import type { paymentTermCatalogRelations } from './schema.ts';

export type PaymentTermCatalogDatabaseExecutor = EffectPgDatabase<
  typeof paymentTermCatalogRelations
>;

type PaymentTermCatalogTransactionCallback = Parameters<
  PaymentTermCatalogDatabaseExecutor['transaction']
>[0];

export type PaymentTermCatalogTransaction = Parameters<PaymentTermCatalogTransactionCallback>[0];
