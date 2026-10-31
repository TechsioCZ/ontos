import { defineScopedRoutine } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { CommerceEnrollmentOwnerTransactionRunner } from '../../../src/enrollment/orchestration/owner-transition-production.ts';
import { attemptUnavailable } from '../../../src/enrollment/attempts/errors.ts';
import { CustomerConsentReceiptSchema } from './model.ts';
import type { CustomerConsentReceipt } from './model.ts';
import { consentConflict, consentUnavailable } from './problems.ts';

interface ConsentReceiptScope {
  readonly legalEntityId: string;
  readonly tenantId: string;
}

const readRoutine = defineScopedRoutine({
  name: 'read_customer_consent_receipt',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: Schema.Struct({ receipt: CustomerConsentReceiptSchema }),
  routineKey: 'customer-consent.receipt.read',
  schema: 'commerce_customer_context',
});
const receiptEquivalent = Schema.toEquivalence(CustomerConsentReceiptSchema);
const writeRoutine = defineScopedRoutine({
  name: 'write_customer_consent_receipt',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
  ],
  resultSchema: Schema.Struct({ receipt: CustomerConsentReceiptSchema }),
  routineKey: 'customer-consent.receipt.write',
  schema: 'commerce_customer_context',
});
export const readCustomerConsentReceipt = Effect.fn('CustomerConsent.readReceipt')(function* readReceipt(
  scope: ConsentReceiptScope,
  requestId: string,
) {
  const runner = yield* CommerceEnrollmentOwnerTransactionRunner;
  const rows = yield* runner
    .run(scope, (transaction) =>
      transaction
        .invoke(readRoutine, [requestId])
        .pipe(
          Effect.mapError((cause) =>
            attemptUnavailable('Customer consent receipt could not be read', undefined, cause),
          ),
        ),
    )
    .pipe(Effect.mapError(consentUnavailable));
  if (rows.length > 1) {
    return yield* Effect.fail(consentUnavailable());
  }
  return Option.fromNullishOr(rows[0]?.receipt);
});
export const recordCustomerConsentReceipt = Effect.fn('CustomerConsent.recordReceipt')(function* recordReceipt(
  scope: ConsentReceiptScope,
  receipt: CustomerConsentReceipt,
) {
  const runner = yield* CommerceEnrollmentOwnerTransactionRunner;
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(CustomerConsentReceiptSchema))(receipt).pipe(
    Effect.mapError(consentUnavailable),
  );
  const rows = yield* runner
    .run(scope, (transaction) =>
      transaction
        .invoke(writeRoutine, [receipt.requestId, encoded])
        .pipe(
          Effect.mapError((cause) =>
            attemptUnavailable('Customer notice acknowledgement could not be durably recorded', undefined, cause),
          ),
        ),
    )
    .pipe(Effect.mapError(consentUnavailable));
  const retained = rows[0]?.receipt;
  if (retained === undefined || rows.length !== 1) {
    return yield* Effect.fail(consentUnavailable());
  }
  // The original server time survives an unchanged retry; every authored field and the real session must match.
  if (!receiptEquivalent({ ...receipt, acknowledgedAt: retained.acknowledgedAt }, retained)) {
    return yield* Effect.fail(consentConflict());
  }
  return retained;
});
