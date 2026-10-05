import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { Context, DateTime, Effect, Option, Result, Schema } from 'effect';
import { and, eq } from 'drizzle-orm';
import {
  AssortmentDecisionEvidenceSchema,
  AssortmentDecisionRequestSchema,
  AssortmentGovernedDecisionSchema,
  AssortmentDependencyFailureError,
  AssortmentOwnerModuleIdSchema,
  AssortmentPurchaseConstituentSchema,
  AssortmentPurchaseRequestSchema,
} from '../../shared/domain/decision-contracts.ts';
import type {
  AssortmentDecisionEvidence,
  AssortmentDecisionRequest,
  AssortmentGovernedDecision,
  AssortmentOwnerResourceRef,
} from '../../shared/domain/decision-contracts.ts';
import { AssortmentConsumerDecisionEvidenceReferenceSchema } from '../../shared/domain/consumer-evidence.ts';
import type {
  AssortmentDecisionEvidenceStore,
  AssortmentOwnedPurchaseConstituentDecision,
  AssortmentOwnedVisibilityDecision,
} from '../../shared/domain/ports/decision-evaluation.ts';
import {
  makeAssortmentDecisionEvaluation,
  makeUnavailableAssortmentDecisionSource,
} from '../../shared/domain/ports/decision-evaluation.ts';
import type { AssortmentOwnerFailure } from '../../shared/domain/ports/owner-evidence.ts';
import { assortmentDecisionMatchesRequest } from '../../shared/domain/decision-evidence.ts';
import { assortmentMeaningFingerprint } from './policy-administration.service.ts';
import { decisionEvidence } from '../database/schema.ts';

const DecisionJsonCodec = Schema.toCodecJson(AssortmentGovernedDecisionSchema);
const RequestJsonCodec = Schema.toCodecJson(AssortmentDecisionRequestSchema);
const constituentEquivalence = Schema.toEquivalence(AssortmentPurchaseConstituentSchema);
const PurchaseInputIdentitySchema = Schema.Struct({
  constituent: AssortmentPurchaseConstituentSchema,
  request: AssortmentPurchaseRequestSchema,
});
const MODULE_ID = 'commerce.assortment' as const;
const EVIDENCE_RESOURCE_TYPE = 'commerce.assortment.decision-evidence' as const;

export type AssortmentPersistedDecisionEvidence = Readonly<{
  readonly evidence: AssortmentDecisionEvidence;
  readonly outcome: 'ELIGIBLE' | 'INELIGIBLE';
  readonly request: AssortmentDecisionRequest;
}>;

export type AssortmentDecisionEvidenceInsert = Readonly<{
  readonly decisionJson: Schema.Json;
  readonly legalEntityId: string;
  readonly outcome: 'ELIGIBLE' | 'INELIGIBLE';
  readonly requestFingerprint: string;
  readonly requestJson: Schema.Json;
  readonly tenantId: string;
}>;

export type AssortmentDecisionEvidenceRow = Readonly<{
  readonly decisionEvidenceId: string;
  readonly decisionJson: Schema.Json;
  readonly legalEntityId: string;
  readonly outcome: string;
  readonly requestFingerprint: string;
  readonly requestJson: Schema.Json;
  readonly tenantId: string;
}>;

/** Narrow transaction-scoped query seam for persistence behavior and owner-focused tests. */
export interface AssortmentDecisionEvidencePersistencePort {
  readonly find: (
    query: Readonly<{ readonly id: string; readonly legalEntityId: string; readonly tenantId: string }>,
  ) => Effect.Effect<readonly AssortmentDecisionEvidenceRow[], AssortmentOwnerFailure>;
  readonly insert: (
    record: AssortmentDecisionEvidenceInsert,
  ) => Effect.Effect<Option.Option<string>, AssortmentOwnerFailure>;
}

export class AssortmentDecisionEvidencePersistence extends Context.Service<
  AssortmentDecisionEvidencePersistence,
  AssortmentDecisionEvidencePersistencePort
>()('@app/assortment/services/decision-evidence.repository/AssortmentDecisionEvidencePersistence') {}

const ownerModuleId = Result.getOrThrow(Schema.decodeResult(AssortmentOwnerModuleIdSchema)(MODULE_ID));

const unavailable = (cause?: unknown): InstanceType<typeof AssortmentDependencyFailureError> => {
  const failure = new AssortmentDependencyFailureError({
    code: 'DEPENDENCY_FAILURE',
    ownerModuleId,
    retryable: true,
    safeReasonCode: 'DEPENDENCY_UNAVAILABLE',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

export const assortmentDecisionRequestFingerprint = (request: AssortmentDecisionRequest): string => {
  const normalized = {
    ...request,
    trustedContext: {
      ...request.trustedContext,
      operationTime: DateTime.formatIso(request.trustedContext.operationTime),
    },
  };
  return assortmentMeaningFingerprint(normalized);
};

const isScopedRequest = (request: AssortmentDecisionRequest, scope: OperationalScope): boolean =>
  scope.legalEntityId !== undefined &&
  request.trustedContext.tenantId === scope.tenantId &&
  request.trustedContext.sellingLegalEntityRef.resourceId === scope.legalEntityId &&
  request.trustedContext.sellingLegalEntityRef.tenantId === scope.tenantId;

const decisionEvidenceReference = (tenantId: string, resourceId: string) => ({
  evidenceRef: {
    moduleId: MODULE_ID,
    resourceId,
    resourceType: EVIDENCE_RESOURCE_TYPE,
    tenantId,
  },
  ownerModuleId: 'commerce.assortment',
});

type PersistableDecision = AssortmentOwnedPurchaseConstituentDecision | AssortmentOwnedVisibilityDecision;

const requestOf = (input: PersistableDecision): AssortmentDecisionRequest => input.request;

const evidenceOf = (input: PersistableDecision): AssortmentGovernedDecision => input.decision;

const inputHasExactConstituent = (input: PersistableDecision): boolean =>
  input.request.decisionPurpose === 'VISIBILITY' ||
  (Schema.is(PurchaseInputIdentitySchema)(input) &&
    constituentEquivalence(input.constituent, input.request.constituent));

const encodeDecision = (decision: AssortmentGovernedDecision) =>
  Schema.encodeUnknownEffect(DecisionJsonCodec)(decision).pipe(Effect.mapError(unavailable));

const encodeRequest = (request: AssortmentDecisionRequest) =>
  Schema.encodeUnknownEffect(RequestJsonCodec)(request).pipe(Effect.mapError(unavailable));

const decodeDecision = (value: Schema.Json) =>
  Schema.decodeEffect(DecisionJsonCodec)(value).pipe(Effect.mapError(unavailable));

const decodeRequest = (value: Schema.Json) =>
  Schema.decodeEffect(RequestJsonCodec)(value).pipe(Effect.mapError(unavailable));

const storedEvidence = (
  decision: AssortmentGovernedDecision,
  request: AssortmentDecisionRequest,
  row: Readonly<{ readonly outcome: string; readonly requestFingerprint: string }>,
): Effect.Effect<AssortmentPersistedDecisionEvidence, AssortmentOwnerFailure> => {
  if (
    (decision.outcome !== 'ELIGIBLE' && decision.outcome !== 'INELIGIBLE') ||
    row.outcome !== decision.outcome ||
    row.requestFingerprint !== assortmentDecisionRequestFingerprint(request) ||
    decision.evidence === undefined ||
    !Schema.is(AssortmentDecisionEvidenceSchema)(decision.evidence) ||
    !assortmentDecisionMatchesRequest(request, decision)
  ) {
    return Effect.fail(unavailable());
  }
  return Effect.succeed({ evidence: decision.evidence, outcome: decision.outcome, request });
};

const persistencePortForTransaction = (
  transaction: ScopedTransactionExecutor,
): AssortmentDecisionEvidencePersistencePort => ({
  find: ({ id, legalEntityId, tenantId }) =>
    transaction
      .select({
        decisionEvidenceId: decisionEvidence.decisionEvidenceId,
        decisionJson: decisionEvidence.decisionJson,
        legalEntityId: decisionEvidence.legalEntityId,
        outcome: decisionEvidence.outcome,
        requestFingerprint: decisionEvidence.requestFingerprint,
        requestJson: decisionEvidence.requestJson,
        tenantId: decisionEvidence.tenantId,
      })
      .from(decisionEvidence)
      .where(
        and(
          eq(decisionEvidence.decisionEvidenceId, id),
          eq(decisionEvidence.tenantId, tenantId),
          eq(decisionEvidence.legalEntityId, legalEntityId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable)),
  insert: (record) =>
    transaction
      .insert(decisionEvidence)
      .values(record)
      .returning({ decisionEvidenceId: decisionEvidence.decisionEvidenceId })
      .pipe(
        Effect.map((rows) => Option.fromUndefinedOr(rows[0]?.decisionEvidenceId)),
        Effect.mapError(unavailable),
      ),
});

export const assortmentDecisionEvidenceRepositoryFromPort = (
  persistence: AssortmentDecisionEvidencePersistencePort,
  scope: OperationalScope,
): AssortmentDecisionEvidenceStore & {
  readonly resolve: (
    reference: AssortmentOwnerResourceRef,
  ) => Effect.Effect<AssortmentPersistedDecisionEvidence, AssortmentOwnerFailure>;
} => ({
  persist: Effect.fn('assortmentDecisionEvidenceRepositoryForScope.persist')(function* persistDecisionEvidence(input) {
    const request = requestOf(input);
    const decision = evidenceOf(input);
    const { legalEntityId } = scope;
    if (
      legalEntityId === undefined ||
      !isScopedRequest(request, scope) ||
      decision.outcome === 'INDETERMINATE' ||
      decision.evidence === undefined ||
      !Schema.is(AssortmentDecisionRequestSchema)(request) ||
      !assortmentDecisionMatchesRequest(request, decision) ||
      !inputHasExactConstituent(input)
    ) {
      return yield* unavailable();
    }
    const [decisionJson, requestJson] = yield* Effect.all([encodeDecision(decision), encodeRequest(request)], {
      concurrency: 2,
    });
    const insertedId = yield* persistence.insert({
      decisionJson,
      legalEntityId,
      outcome: decision.outcome,
      requestFingerprint: assortmentDecisionRequestFingerprint(request),
      requestJson,
      tenantId: scope.tenantId,
    });
    if (Option.isNone(insertedId)) {
      return yield* unavailable();
    }
    return yield* Schema.decodeEffect(AssortmentConsumerDecisionEvidenceReferenceSchema)(
      decisionEvidenceReference(scope.tenantId, insertedId.value),
    ).pipe(Effect.mapError(unavailable));
  }),
  resolve: Effect.fn('assortmentDecisionEvidenceRepositoryForScope.resolve')(
    function* resolveDecisionEvidence(reference) {
      if (
        scope.legalEntityId === undefined ||
        reference.tenantId !== scope.tenantId ||
        reference.moduleId !== MODULE_ID ||
        reference.resourceType !== EVIDENCE_RESOURCE_TYPE
      ) {
        return yield* unavailable();
      }
      const [row] = yield* persistence.find({
        id: reference.resourceId,
        legalEntityId: scope.legalEntityId,
        tenantId: scope.tenantId,
      });
      if (row === undefined || row.tenantId !== scope.tenantId || row.legalEntityId !== scope.legalEntityId) {
        return yield* unavailable();
      }
      const request = yield* decodeRequest(row.requestJson);
      // Preserve decode order so malformed request data cannot be hidden by a valid decision payload.
      // oxlint-disable-next-line effect-native/no-sequential-independent-yields
      const decision = yield* decodeDecision(row.decisionJson);
      return yield* storedEvidence(decision, request, row);
    },
  ),
});

export const assortmentDecisionEvidenceRepositoryForScope = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
) =>
  assortmentDecisionEvidenceRepositoryFromPort(
    AssortmentDecisionEvidencePersistence.of(persistencePortForTransaction(transaction)),
    scope,
  );

export const assortmentDecisionEvaluationForScope = (transaction: ScopedTransactionExecutor, scope: OperationalScope) =>
  makeAssortmentDecisionEvaluation({
    evidenceStore: assortmentDecisionEvidenceRepositoryForScope(transaction, scope),
    source: makeUnavailableAssortmentDecisionSource(),
  });

export const assortmentDecisionEvidenceReferenceForScope = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
) => assortmentDecisionEvidenceRepositoryForScope(transaction, scope).resolve;
