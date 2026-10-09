import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { Context, DateTime, Effect, Schema } from 'effect';
import { assortmentMeaningFingerprint } from './policy-administration.service.ts';
import {
  AssortmentCandidateSchema,
  AssortmentEvidenceReferenceSchema,
  AssortmentOwnerResourceRefSchema,
  AssortmentPurchaseConstituentSchema,
} from '../../shared/domain/decision-contracts.ts';
import {
  AssortmentCommitmentConfirmationInvalid,
  AssortmentCommitmentConfirmationResultSchema,
  AssortmentCommitmentConfirmationUnavailable,
} from '../../shared/domain/commitment-confirmation.ts';
import type {
  AssortmentCommitmentConfirmationPayload,
  AssortmentCommitmentConfirmationResult,
} from '../../shared/domain/commitment-confirmation.ts';
import type {
  AssortmentCommitmentConfirmationPersistenceMetadata,
  AssortmentCommitmentConfirmationRepository,
} from './assortment-commitment-confirmation.service.ts';
import { commitmentConfirmations } from '../database/schema.ts';

const unavailable = (cause?: unknown) => {
  const failure = new AssortmentCommitmentConfirmationUnavailable({
    code: 'assortment_confirmation_unavailable',
    reason: 'Assortment Commitment Confirmation persistence is unavailable',
  });
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

const encodeOwnerRef = (value: typeof AssortmentOwnerResourceRefSchema.Type) =>
  Schema.encodeUnknownEffect(Schema.toCodecJson(AssortmentOwnerResourceRefSchema))(value).pipe(
    Effect.mapError(unavailable),
  );
const encodeConstituent = (value: typeof AssortmentPurchaseConstituentSchema.Type) =>
  Schema.encodeUnknownEffect(Schema.toCodecJson(AssortmentPurchaseConstituentSchema))(value).pipe(
    Effect.mapError(unavailable),
  );
const encodeCandidate = (value: typeof AssortmentCandidateSchema.Type) =>
  Schema.encodeUnknownEffect(Schema.toCodecJson(AssortmentCandidateSchema))(value).pipe(Effect.mapError(unavailable));
const encodeEvidenceReference = (value: typeof AssortmentEvidenceReferenceSchema.Type) =>
  Schema.encodeUnknownEffect(Schema.toCodecJson(AssortmentEvidenceReferenceSchema))(value).pipe(
    Effect.mapError(unavailable),
  );

const decodeOwnerRef = (value: Schema.Json) =>
  Schema.decodeEffect(Schema.toCodecJson(AssortmentOwnerResourceRefSchema))(value).pipe(Effect.mapError(unavailable));
const decodeConstituent = (value: Schema.Json) =>
  Schema.decodeEffect(Schema.toCodecJson(AssortmentPurchaseConstituentSchema))(value).pipe(
    Effect.mapError(unavailable),
  );
const decodeCandidate = (value: Schema.Json) =>
  Schema.decodeEffect(Schema.toCodecJson(AssortmentCandidateSchema))(value).pipe(Effect.mapError(unavailable));
const decodeEvidenceReference = (value: Schema.Json) =>
  Schema.decodeEffect(Schema.toCodecJson(AssortmentEvidenceReferenceSchema))(value).pipe(Effect.mapError(unavailable));

const ownerRefEquivalence = Schema.toEquivalence(AssortmentOwnerResourceRefSchema);
const constituentEquivalence = Schema.toEquivalence(AssortmentPurchaseConstituentSchema);
const candidateEquivalence = Schema.toEquivalence(AssortmentCandidateSchema);
const evidenceReferenceEquivalence = Schema.toEquivalence(AssortmentEvidenceReferenceSchema);

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

export type ConfirmationRow = Pick<
  typeof commitmentConfirmations.$inferSelect,
  | 'actionInvocationId'
  | 'actorPrincipalId'
  | 'attemptModuleId'
  | 'attemptResourceId'
  | 'attemptResourceType'
  | 'candidateJson'
  | 'commitmentConfirmationId'
  | 'constituentJson'
  | 'decisionEvidenceJson'
  | 'expiresAt'
  | 'issuedAt'
  | 'legalEntityId'
  | 'prospectiveMeaningJson'
  | 'tenantId'
>;

export type CommitmentConfirmationInsert = Pick<
  typeof commitmentConfirmations.$inferInsert,
  | 'actionInvocationId'
  | 'actorPrincipalId'
  | 'attemptModuleId'
  | 'attemptResourceId'
  | 'attemptResourceType'
  | 'candidateJson'
  | 'commitmentConfirmationId'
  | 'constituentFingerprint'
  | 'constituentJson'
  | 'decisionEvidenceJson'
  | 'expiresAt'
  | 'issuedAt'
  | 'legalEntityId'
  | 'prospectiveMeaningJson'
  | 'tenantId'
>;

export interface AssortmentCommitmentConfirmationPersistencePort {
  readonly findByInvocation: (
    query: Readonly<{
      readonly actionInvocationId: string;
      readonly legalEntityId: string;
      readonly tenantId: string;
    }>,
  ) => Effect.Effect<readonly ConfirmationRow[], InstanceType<typeof AssortmentCommitmentConfirmationUnavailable>>;
  readonly insert: (
    record: CommitmentConfirmationInsert,
  ) => Effect.Effect<boolean, InstanceType<typeof AssortmentCommitmentConfirmationUnavailable>>;
}

export class AssortmentCommitmentConfirmationPersistence extends Context.Service<
  AssortmentCommitmentConfirmationPersistence,
  AssortmentCommitmentConfirmationPersistencePort
>()(
  '@app/assortment/services/assortment-commitment-confirmation.repository/AssortmentCommitmentConfirmationPersistence',
) {}

const decodeConfirmationRow = Effect.fn('AssortmentCommitmentConfirmationRepository.decodeConfirmationRow')(
  function* decodeStoredConfirmation(row: ConfirmationRow) {
    const [attemptRef, prospectivePurchaseMeaningRef, constituent, candidate, decisionEvidenceRef] = yield* Effect.all(
      [
        decodeOwnerRef({
          moduleId: row.attemptModuleId,
          resourceId: row.attemptResourceId,
          resourceType: row.attemptResourceType,
          tenantId: row.tenantId,
        }),
        decodeOwnerRef(row.prospectiveMeaningJson),
        decodeConstituent(row.constituentJson),
        decodeCandidate(row.candidateJson),
        decodeEvidenceReference(row.decisionEvidenceJson),
      ],
      { concurrency: 5 },
    );
    return yield* Schema.decodeEffect(AssortmentCommitmentConfirmationResultSchema)({
      attemptRef,
      candidate,
      confirmationRef: {
        moduleId: 'commerce.assortment',
        resourceId: row.commitmentConfirmationId,
        resourceType: 'commerce.assortment.commitment-confirmation',
        tenantId: row.tenantId,
      },
      constituent,
      decisionEvidenceRef,
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(row.expiresAt)),
      issuedAt: DateTime.formatIso(DateTime.makeUnsafe(row.issuedAt)),
      prospectivePurchaseMeaningRef,
    }).pipe(Effect.mapError(unavailable));
  },
);

const replayMatches = (
  row: ConfirmationRow,
  stored: AssortmentCommitmentConfirmationResult,
  payload: AssortmentCommitmentConfirmationPayload,
  metadata: AssortmentCommitmentConfirmationPersistenceMetadata,
): boolean =>
  row.actionInvocationId === metadata.actionInvocationId &&
  row.actorPrincipalId === metadata.actorPrincipalId &&
  ownerRefEquivalence(stored.attemptRef, payload.attemptRef) &&
  ownerRefEquivalence(stored.prospectivePurchaseMeaningRef, payload.prospectivePurchaseMeaningRef) &&
  constituentEquivalence(stored.constituent, payload.constituent) &&
  candidateEquivalence(stored.candidate, payload.candidate) &&
  evidenceReferenceEquivalence(stored.decisionEvidenceRef, payload.decisionEvidenceRef);

const replayConflict = () =>
  new AssortmentCommitmentConfirmationInvalid({
    code: 'assortment_confirmation_invalid',
    reason: 'Confirmation action invocation was already used with a different payload or actor',
  });

const persistencePortForTransaction = (
  transaction: ScopedTransaction,
): AssortmentCommitmentConfirmationPersistencePort => ({
  findByInvocation: ({ actionInvocationId, legalEntityId, tenantId }) =>
    transaction
      .select({
        actionInvocationId: commitmentConfirmations.actionInvocationId,
        actorPrincipalId: commitmentConfirmations.actorPrincipalId,
        attemptModuleId: commitmentConfirmations.attemptModuleId,
        attemptResourceId: commitmentConfirmations.attemptResourceId,
        attemptResourceType: commitmentConfirmations.attemptResourceType,
        candidateJson: commitmentConfirmations.candidateJson,
        commitmentConfirmationId: commitmentConfirmations.commitmentConfirmationId,
        constituentJson: commitmentConfirmations.constituentJson,
        decisionEvidenceJson: commitmentConfirmations.decisionEvidenceJson,
        expiresAt: commitmentConfirmations.expiresAt,
        issuedAt: commitmentConfirmations.issuedAt,
        legalEntityId: commitmentConfirmations.legalEntityId,
        prospectiveMeaningJson: commitmentConfirmations.prospectiveMeaningJson,
        tenantId: commitmentConfirmations.tenantId,
      })
      .from(commitmentConfirmations)
      .where(
        and(
          eq(commitmentConfirmations.actionInvocationId, actionInvocationId),
          eq(commitmentConfirmations.tenantId, tenantId),
          eq(commitmentConfirmations.legalEntityId, legalEntityId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable)),
  insert: (record) =>
    transaction
      .insert(commitmentConfirmations)
      .values(record)
      .onConflictDoNothing({
        target: [
          commitmentConfirmations.tenantId,
          commitmentConfirmations.legalEntityId,
          commitmentConfirmations.actionInvocationId,
        ],
      })
      .returning({ commitmentConfirmationId: commitmentConfirmations.commitmentConfirmationId })
      .pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(unavailable),
      ),
});

const storedConfirmation = (
  persistence: AssortmentCommitmentConfirmationPersistencePort,
  scope: OperationalScope,
  legalEntityId: string,
  actionInvocationId: string,
) => persistence.findByInvocation({ actionInvocationId, legalEntityId, tenantId: scope.tenantId });

export const assortmentCommitmentConfirmationRepositoryFromPort = (
  persistence: AssortmentCommitmentConfirmationPersistencePort,
  scope: OperationalScope,
): AssortmentCommitmentConfirmationRepository => ({
  persist: Effect.fn('assortmentCommitmentConfirmationRepositoryFromPort.persist')(
    function* persistConfirmation(payload, result, persistenceScope, metadata) {
      if (
        persistenceScope.legalEntityId === undefined ||
        scope.legalEntityId === undefined ||
        persistenceScope.tenantId !== scope.tenantId ||
        persistenceScope.legalEntityId !== scope.legalEntityId ||
        result.confirmationRef.tenantId !== persistenceScope.tenantId
      ) {
        return yield* unavailable();
      }
      const [prospectiveMeaningJson, constituentJson, candidateJson, decisionEvidenceJson] = yield* Effect.all(
        [
          encodeOwnerRef(payload.prospectivePurchaseMeaningRef),
          encodeConstituent(payload.constituent),
          encodeCandidate(payload.candidate),
          encodeEvidenceReference(result.decisionEvidenceRef),
        ],
        { concurrency: 4 },
      );
      const inserted = yield* persistence.insert({
        actionInvocationId: metadata.actionInvocationId,
        actorPrincipalId: metadata.actorPrincipalId,
        attemptModuleId: payload.attemptRef.moduleId,
        attemptResourceId: payload.attemptRef.resourceId,
        attemptResourceType: payload.attemptRef.resourceType,
        candidateJson,
        commitmentConfirmationId: result.confirmationRef.resourceId,
        constituentFingerprint: assortmentMeaningFingerprint(payload.constituent),
        constituentJson,
        decisionEvidenceJson,
        expiresAt: DateTime.toDateUtc(result.expiresAt),
        issuedAt: DateTime.toDateUtc(result.issuedAt),
        legalEntityId: persistenceScope.legalEntityId,
        prospectiveMeaningJson,
        tenantId: persistenceScope.tenantId,
      });
      if (inserted) {
        return result;
      }

      const [row] = yield* storedConfirmation(
        persistence,
        scope,
        persistenceScope.legalEntityId,
        metadata.actionInvocationId,
      );
      if (row === undefined || row.tenantId !== scope.tenantId || row.legalEntityId !== scope.legalEntityId) {
        return yield* unavailable();
      }
      const stored = yield* decodeConfirmationRow(row);
      return replayMatches(row, stored, payload, metadata) ? stored : yield* replayConflict();
    },
  ),
});

export const assortmentCommitmentConfirmationRepositoryForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): AssortmentCommitmentConfirmationRepository =>
  assortmentCommitmentConfirmationRepositoryFromPort(
    AssortmentCommitmentConfirmationPersistence.of(persistencePortForTransaction(transaction)),
    scope,
  );
