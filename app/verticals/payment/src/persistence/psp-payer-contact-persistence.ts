import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { Effect } from 'effect';

import type { PaymentPayerContact } from '../../shared/domain/payment-payer-contact.ts';
import { paymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type { PaymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import { pspOperationPayerContacts } from '../database/schema.ts';

/**
 * The transient payer contact of one new COLLECT (plan D-P3), written in the collection Action's own
 * Core-installed transaction. The runtime role may only INSERT this table: no RETURNING, no read back.
 * `on conflict do nothing` keeps the first contact of an operation; the dispatch routines that prepare,
 * withhold or record the COLLECT as never sent delete it, and the driver purges what is left after a
 * bounded age.
 */
export interface PspPayerContactPersistence {
  readonly rememberForCollect: (
    operationId: string,
    contact: PaymentPayerContact,
  ) => Effect.Effect<void, PaymentUnavailable>;
}

/** Construction is private to a Core-owned transaction; the handler receives only this closed method. */
export const pspPayerContactPersistenceForTransaction = (
  transaction: ScopedTransactionExecutor,
): PspPayerContactPersistence => {
  const rememberForCollect = Effect.fn('PspPayerContactPersistence.rememberForCollect')(function* rememberForCollect(
    operationId: string,
    contact: PaymentPayerContact,
  ) {
    const { legalEntityId, tenantId } = transaction.scope;
    if (legalEntityId === undefined) {
      return yield* paymentUnavailable('A verified Selling Legal Entity scope is required');
    }
    return yield* transaction
      .insert(pspOperationPayerContacts)
      .values({
        email: contact.email ?? null,
        fullName: contact.fullName ?? null,
        legalEntityId,
        operationId,
        phone: contact.phone ?? null,
        tenantId,
      })
      // No conflict target: inferring one needs SELECT on its columns, which the runtime role does not hold.
      .onConflictDoNothing()
      .pipe(
        Effect.asVoid,
        Effect.mapError((cause) => paymentUnavailable('The payer contact could not be written', cause)),
      );
  });
  return Object.freeze({ rememberForCollect });
};
