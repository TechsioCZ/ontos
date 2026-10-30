import { defineScopedRoutine } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory, ScopedRoutineInvocationError } from '@app/core-runtime';
import { PricingCommitmentConfirmationIssuedSchema } from '@app/pricing-contracts/domain/commitment-confirmation';
import type { PricingCommitmentConfirmationIssued } from '@app/pricing-contracts/domain/commitment-confirmation';
import { PricingInstantSchema } from '@app/pricing-contracts/domain/currency-support';
import { Effect, Option, Predicate, Schema } from 'effect';
import { and, eq } from 'drizzle-orm';
import { pricingCommitmentConfirmationIssuanceReceipts } from '../database/schema.ts';

const ownerModuleKey = 'commerce.pricing';
const schema = 'pricing';
const scopeParameters = [
  { source: 'tenantId', type: 'uuid' },
  { source: 'legalEntityId', type: 'uuid' },
] as const;
const CommitmentConfirmationRoutineRowSchema = Schema.Struct({ payload: Schema.Unknown });

export const persistPricingCommitmentConfirmationRoutine = defineScopedRoutine({
  name: 'persist_pricing_commitment_confirmation_v1',
  ownerModuleKey,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: CommitmentConfirmationRoutineRowSchema,
  routineKey: 'pricing.persist-pricing-commitment-confirmation-v1',
  schema,
});

export const readPricingCommitmentConfirmationRoutine = defineScopedRoutine({
  name: 'read_pricing_commitment_confirmation_v1',
  ownerModuleKey,
  parameters: [...scopeParameters, { source: 'input', type: 'text' }],
  resultSchema: CommitmentConfirmationRoutineRowSchema,
  routineKey: 'pricing.read-pricing-commitment-confirmation-v1',
  schema,
});

// SQL jsonb carries retained owner instants as ISO text, not DateTime.Utc instances.
const confirmationJsonCodec = Schema.toCodecJson(PricingCommitmentConfirmationIssuedSchema);
const encodeConfirmationJson = Schema.encodeEffect(confirmationJsonCodec);
const StoredOutcomeSchema = Schema.Union([
  Schema.Struct({
    confirmation: confirmationJsonCodec,
    outcome: Schema.Literal('STORED'),
  }),
  Schema.Struct({
    confirmation: confirmationJsonCodec,
    outcome: Schema.Literal('REUSED'),
  }),
  Schema.Struct({
    confirmationRef: Schema.String,
    outcome: Schema.Literal('IDENTITY_CONFLICT'),
    reason: Schema.Literal('CONFIRMATION_OR_PROOF_IDENTITY_ALREADY_BOUND'),
  }),
]);
export type CommitmentConfirmationStoreOutcome = typeof StoredOutcomeSchema.Type;

const RecoveryFoundFields = {
  attemptRef: Schema.String,
  confirmation: Schema.Unknown,
  confirmationRef: Schema.String,
  decisionBundleHash: Schema.String,
  decisionBundleRef: Schema.String,
  decisionBundleVersion: Schema.String,
  expiresAt: PricingInstantSchema,
  issuedAt: PricingInstantSchema,
  outcome: Schema.Literal('FOUND'),
  payloadDigest: Schema.String,
  proofRef: Schema.String,
} as const;
const RecoveryWireSchema = Schema.Union([
  Schema.Struct({ confirmationRef: Schema.String, outcome: Schema.Literal('ABSENT') }),
  Schema.Struct({
    ...RecoveryFoundFields,
    quotationRef: Schema.Null,
    sourceKind: Schema.Literal('CURRENT_BACKED'),
  }),
  Schema.Struct({
    ...RecoveryFoundFields,
    quotationRef: Schema.String,
    sourceKind: Schema.Literal('QUOTATION_BACKED'),
  }),
]);
type RecoveryWire = typeof RecoveryWireSchema.Type;

export type CommitmentConfirmationRecoveryOutcome =
  | { readonly confirmation: PricingCommitmentConfirmationIssued; readonly outcome: 'FOUND' }
  | { readonly confirmationRef: string; readonly outcome: 'ABSENT' }
  | {
      readonly confirmationRef: string;
      readonly outcome: 'CORRUPT';
      readonly reason: 'NORMALIZED_BINDING_MISMATCH' | 'PAYLOAD_INVALID';
    };

export class CommitmentConfirmationPersistenceUnavailable extends Schema.TaggedError<CommitmentConfirmationPersistenceUnavailable>()(
  'CommitmentConfirmationPersistenceUnavailable',
  { reason: Schema.String },
) {}

export interface CommitmentConfirmationPersistence {
  readonly recover: (
    confirmationRef: string,
  ) => Effect.Effect<CommitmentConfirmationRecoveryOutcome, CommitmentConfirmationPersistenceUnavailable>;
  readonly recoverIssuance: (
    actionInvocationId: string,
  ) => Effect.Effect<Option.Option<PricingCommitmentConfirmationIssued>, CommitmentConfirmationPersistenceUnavailable>;
  readonly store: (
    confirmation: PricingCommitmentConfirmationIssued,
    issuanceInvocationId?: string,
  ) => Effect.Effect<CommitmentConfirmationStoreOutcome, CommitmentConfirmationPersistenceUnavailable>;
}

const unavailable = (cause: unknown) => {
  const failure = new CommitmentConfirmationPersistenceUnavailable({
    reason: 'Pricing Commitment Confirmation storage could not be verified',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const firstPayload = (rows: readonly (typeof CommitmentConfirmationRoutineRowSchema.Type)[]) => rows[0]?.payload;

export const decodeCommitmentConfirmationStoreOutcome = (
  rows: readonly (typeof CommitmentConfirmationRoutineRowSchema.Type)[],
): Effect.Effect<CommitmentConfirmationStoreOutcome, CommitmentConfirmationPersistenceUnavailable> => {
  const outcome = Schema.decodeUnknownOption(StoredOutcomeSchema)(firstPayload(rows));
  return Effect.fromOption(outcome).pipe(Effect.mapError(unavailable));
};

const recoveredConfirmationMatchesEnvelope = (
  confirmation: PricingCommitmentConfirmationIssued,
  envelope: Extract<RecoveryWire, { readonly outcome: 'FOUND' }>,
): boolean => {
  const quotationRef =
    confirmation.source.kind === 'QUOTATION_BACKED'
      ? confirmation.source.quotationRevalidation.quotation.quotationRef
      : null;
  return (
    confirmation.confirmationRef === envelope.confirmationRef &&
    confirmation.binding.attemptRef === envelope.attemptRef &&
    confirmation.binding.decisionBundleHash === envelope.decisionBundleHash &&
    confirmation.binding.decisionBundleRef === envelope.decisionBundleRef &&
    confirmation.binding.decisionBundleVersion === envelope.decisionBundleVersion &&
    confirmation.source.kind === envelope.sourceKind &&
    quotationRef === envelope.quotationRef &&
    confirmation.issuedAt === envelope.issuedAt &&
    confirmation.expiresAt === envelope.expiresAt &&
    confirmation.authenticity.payloadDigest === envelope.payloadDigest &&
    confirmation.authenticity.proofRef === envelope.proofRef
  );
};

export const decodeCommitmentConfirmationRecoveryOutcome = (
  requestedConfirmationRef: string,
  rows: readonly (typeof CommitmentConfirmationRoutineRowSchema.Type)[],
): CommitmentConfirmationRecoveryOutcome => {
  const envelope = Schema.decodeUnknownOption(RecoveryWireSchema)(firstPayload(rows));
  if (Option.isNone(envelope)) {
    return { confirmationRef: requestedConfirmationRef, outcome: 'CORRUPT', reason: 'PAYLOAD_INVALID' };
  }
  if (envelope.value.outcome === 'ABSENT') {
    return envelope.value.confirmationRef === requestedConfirmationRef
      ? envelope.value
      : { confirmationRef: requestedConfirmationRef, outcome: 'CORRUPT', reason: 'NORMALIZED_BINDING_MISMATCH' };
  }
  const confirmation = Schema.decodeUnknownOption(confirmationJsonCodec)(envelope.value.confirmation);
  if (Option.isNone(confirmation)) {
    return { confirmationRef: requestedConfirmationRef, outcome: 'CORRUPT', reason: 'PAYLOAD_INVALID' };
  }
  return requestedConfirmationRef === envelope.value.confirmationRef &&
    recoveredConfirmationMatchesEnvelope(confirmation.value, envelope.value)
    ? { confirmation: confirmation.value, outcome: 'FOUND' }
    : { confirmationRef: requestedConfirmationRef, outcome: 'CORRUPT', reason: 'NORMALIZED_BINDING_MISMATCH' };
};

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

export const commitmentConfirmationPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): Effect.Effect<CommitmentConfirmationPersistence> => {
  const recoverIssuance = Effect.fn('CommitmentConfirmationPersistence.recoverIssuance')(function* recoverIssuance(
    actionInvocationId: string,
  ) {
    const invocationId = yield* Schema.decodeUnknownEffect(Schema.String.check(Schema.isUUID()))(
      actionInvocationId,
    ).pipe(Effect.mapError(unavailable));
    if (scope.legalEntityId === undefined) {
      return yield* unavailable('Issuance recovery requires a Selling Legal Entity');
    }
    const [receipt] = yield* transaction
      .select({ confirmationRef: pricingCommitmentConfirmationIssuanceReceipts.confirmationRef })
      .from(pricingCommitmentConfirmationIssuanceReceipts)
      .where(
        and(
          eq(pricingCommitmentConfirmationIssuanceReceipts.tenantId, scope.tenantId),
          eq(pricingCommitmentConfirmationIssuanceReceipts.legalEntityId, scope.legalEntityId),
          eq(pricingCommitmentConfirmationIssuanceReceipts.principalId, scope.principalId),
          eq(pricingCommitmentConfirmationIssuanceReceipts.actionInvocationId, invocationId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (receipt === undefined) {
      return Option.none();
    }
    const rows = yield* transaction
      .invoke(readPricingCommitmentConfirmationRoutine, [receipt.confirmationRef])
      .pipe(Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)));
    const recovered = decodeCommitmentConfirmationRecoveryOutcome(receipt.confirmationRef, rows);
    if (recovered.outcome !== 'FOUND' || recovered.confirmation.source.kind !== 'QUOTATION_BACKED') {
      return yield* unavailable('The original issuance receipt no longer binds its immutable Quotation proof');
    }
    return Option.some(recovered.confirmation);
  });
  const retainOriginalQuotationIssuance = Effect.fn('CommitmentConfirmationPersistence.retainIssuance')(
    function* retainOriginalQuotationIssuance(
      confirmation: PricingCommitmentConfirmationIssued,
      issuanceInvocationId: string,
    ) {
      if (scope.legalEntityId === undefined || confirmation.source.kind !== 'QUOTATION_BACKED') {
        return yield* unavailable('An issuance receipt requires the exact Quotation-backed owner scope');
      }
      const actionInvocationId = yield* Schema.decodeUnknownEffect(Schema.String.check(Schema.isUUID()))(
        issuanceInvocationId,
      ).pipe(Effect.mapError(unavailable));
      yield* transaction
        .insert(pricingCommitmentConfirmationIssuanceReceipts)
        .values({
          actionInvocationId,
          confirmationRef: confirmation.confirmationRef,
          legalEntityId: scope.legalEntityId,
          principalId: scope.principalId,
          tenantId: scope.tenantId,
        })
        .onConflictDoNothing()
        .pipe(Effect.mapError(unavailable));
      const [receipt] = yield* transaction
        .select({
          confirmationRef: pricingCommitmentConfirmationIssuanceReceipts.confirmationRef,
          principalId: pricingCommitmentConfirmationIssuanceReceipts.principalId,
        })
        .from(pricingCommitmentConfirmationIssuanceReceipts)
        .where(
          and(
            eq(pricingCommitmentConfirmationIssuanceReceipts.tenantId, scope.tenantId),
            eq(pricingCommitmentConfirmationIssuanceReceipts.legalEntityId, scope.legalEntityId),
            eq(pricingCommitmentConfirmationIssuanceReceipts.actionInvocationId, actionInvocationId),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      return yield* receipt !== undefined &&
      receipt.confirmationRef === confirmation.confirmationRef &&
      receipt.principalId === scope.principalId
        ? Effect.void
        : unavailable('The immutable issuance invocation is already bound to another proof or actor');
    },
  );
  const store: CommitmentConfirmationPersistence['store'] = (confirmation, issuanceInvocationId) =>
    encodeConfirmationJson(confirmation).pipe(
      Effect.mapError(unavailable),
      Effect.flatMap((encoded) =>
        Predicate.isObject(encoded) ? Effect.succeed(encoded) : Effect.fail(unavailable('Invalid confirmation JSON')),
      ),
      Effect.flatMap((encoded) =>
        transaction
          .invoke(persistPricingCommitmentConfirmationRoutine, [encoded])
          .pipe(Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause))),
      ),
      Effect.flatMap(decodeCommitmentConfirmationStoreOutcome),
      Effect.tap((outcome) =>
        issuanceInvocationId === undefined || outcome.outcome === 'IDENTITY_CONFLICT'
          ? Effect.void
          : retainOriginalQuotationIssuance(confirmation, issuanceInvocationId),
      ),
    );
  return Effect.succeed({
    recover: (confirmationRef) =>
      transaction.invoke(readPricingCommitmentConfirmationRoutine, [confirmationRef]).pipe(
        Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
        Effect.map((rows) => decodeCommitmentConfirmationRecoveryOutcome(confirmationRef, rows)),
      ),
    recoverIssuance,
    store,
  });
};
