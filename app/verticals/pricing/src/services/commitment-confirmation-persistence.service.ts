import { defineScopedRoutine } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory, ScopedRoutineInvocationError } from '@app/core-runtime';
import { PricingCommitmentConfirmationIssuedSchema } from '@app/pricing-contracts/domain/commitment-confirmation';
import type { PricingCommitmentConfirmationIssued } from '@app/pricing-contracts/domain/commitment-confirmation';
import { PricingInstantSchema } from '@app/pricing-contracts/domain/currency-support';
import { Effect, Option, Schema } from 'effect';

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

const StoredOutcomeSchema = Schema.Union([
  Schema.Struct({
    confirmation: Schema.toType(PricingCommitmentConfirmationIssuedSchema),
    outcome: Schema.Literal('STORED'),
  }),
  Schema.Struct({
    confirmation: Schema.toType(PricingCommitmentConfirmationIssuedSchema),
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
  readonly store: (
    confirmation: PricingCommitmentConfirmationIssued,
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
  const confirmation = Schema.decodeUnknownOption(PricingCommitmentConfirmationIssuedSchema)(
    envelope.value.confirmation,
  );
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
  _scope: OperationalScope,
): Effect.Effect<CommitmentConfirmationPersistence> =>
  Effect.succeed({
    recover: (confirmationRef) =>
      transaction.invoke(readPricingCommitmentConfirmationRoutine, [confirmationRef]).pipe(
        Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
        Effect.map((rows) => decodeCommitmentConfirmationRecoveryOutcome(confirmationRef, rows)),
      ),
    store: (confirmation) =>
      transaction.invoke(persistPricingCommitmentConfirmationRoutine, [confirmation]).pipe(
        Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
        Effect.flatMap(decodeCommitmentConfirmationStoreOutcome),
      ),
  });
