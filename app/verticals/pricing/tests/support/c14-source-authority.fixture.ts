import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { externalPriceSourceAuthorityForScope } from '../../src/persistence/external-price-source-authority-persistence.ts';
import { ExternalPriceSourceAuthorityGrantSchema } from '../../src/services/external-price-input-boundary.service.ts';

export { ExternalPriceSourceAuthorityGrantSchema } from '../../src/services/external-price-input-boundary.service.ts';

/** INTERNAL native fixture seam. Caller supplies every exact key, scope, time and owner authority fact. */
export const storeInternalC14PricingSourceGrant = (
  transaction: Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0],
  scope: OperationalScope,
  input: typeof ExternalPriceSourceAuthorityGrantSchema.Type,
) =>
  Schema.decodeUnknownEffect(ExternalPriceSourceAuthorityGrantSchema)(input).pipe(
    Effect.flatMap((grant) =>
      externalPriceSourceAuthorityForScope(transaction, scope).pipe(
        Effect.flatMap((authority) => authority.store(grant)),
      ),
    ),
  );
