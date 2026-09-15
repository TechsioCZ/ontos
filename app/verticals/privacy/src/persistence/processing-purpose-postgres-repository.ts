/* eslint-disable anti-slop/no-unknown-parameters -- PostgreSQL JSONB values are untrusted unknowns and are decoded immediately by owner schemas at this repository boundary. expires: 2027-03-31. */
import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { OperationContextUnavailable } from '@app/core-runtime';
import { and, asc, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';
import { randomUUID } from 'node:crypto';

import type {
  CreatePurposeVersionInput,
  ProcessingPurpose,
  PurposeVersion,
  PurposeVersionMaterialScope,
} from '../../shared/domain/processing-purpose.ts';
import { ConsentMaterialDimensionKindSchema } from '../../shared/domain/privacy-consent-scope.ts';
import type { ConsentMaterialDimensionKind } from '../../shared/domain/privacy-consent-scope.ts';
import {
  CreatePurposeVersionInputSchema,
  PurposeNotFound,
  PurposeVersionConflict,
  PurposeVersionMaterialScopeSchema,
} from '../../shared/domain/processing-purpose.ts';
import { PrivacyMaterialChangeAssessmentSchema } from '../../shared/domain/privacy-material-change.ts';
import type { PrivacyMaterialChangeAssessment } from '../../shared/domain/privacy-material-change.ts';
import type { ProcessingPurposeRef } from '../../shared/resources/processing-purpose.ts';
import { deriveMaterialVersionEvidence } from '../domain/processing-purpose-materiality.ts';
import { processingPurposes, purposeVersions } from '../database/schema.ts';
import type { ProcessingPurposeRepositoryService } from './processing-purpose-repository.ts';
import { ProcessingPurposePersistenceUnavailable } from './processing-purpose-persistence-unavailable.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

const PERSISTENCE_UNAVAILABLE = 'Processing Purpose persistence is unavailable';
const versionInputEquivalent = Schema.toEquivalence(CreatePurposeVersionInputSchema);
const unavailable = (reason = PERSISTENCE_UNAVAILABLE, cause?: unknown) => {
  const error = new ProcessingPurposePersistenceUnavailable({
    code: 'privacy_processing_purpose_persistence_unavailable',
    reason,
  });
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  }
  return error;
};

const scopeUnavailable = () =>
  new OperationContextUnavailable({
    code: 'operation_context_unavailable',
    reason: 'Processing Purpose operations require a trusted Legal Entity scope',
  });

const purposeRef = (tenantId: string, resourceId: string): ProcessingPurposeRef => ({
  moduleId: 'privacy.core',
  resourceId,
  resourceType: 'privacy.core.processing-purpose',
  tenantId,
});

const iso = (value: Date): string => DateTime.formatIso(DateTime.fromDateUnsafe(value));

const decodeMaterialityAssessment = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSONB is decoded immediately at this owner repository boundary.
  value: unknown,
): Effect.Effect<PrivacyMaterialChangeAssessment, ProcessingPurposePersistenceUnavailable> =>
  Schema.decodeUnknownEffect(PrivacyMaterialChangeAssessmentSchema)(value).pipe(
    Effect.mapError((cause) => unavailable('Stored materiality assessment could not be decoded', cause)),
  );

const decodeMaterialScope = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSONB is decoded immediately at this owner repository boundary.
  value: unknown,
): Effect.Effect<PurposeVersionMaterialScope, ProcessingPurposePersistenceUnavailable> =>
  Schema.decodeUnknownEffect(PurposeVersionMaterialScopeSchema)(value).pipe(
    Effect.mapError((cause) => unavailable('Stored Purpose Version material scope could not be decoded', cause)),
  );

const decodeRequiredConsentDimensions = (
  value: unknown,
): Effect.Effect<readonly ConsentMaterialDimensionKind[], ProcessingPurposePersistenceUnavailable> =>
  Schema.decodeUnknownEffect(Schema.Array(ConsentMaterialDimensionKindSchema))(value).pipe(
    Effect.mapError((cause) => unavailable('Stored required consent dimensions could not be decoded', cause)),
  );

const loadVersions = Effect.fn('ProcessingPurposePostgresRepository.loadVersions')(
  (
    transaction: ScopedTransaction,
    tenantId: string,
    legalEntityId: string,
    processingPurposeId: string,
  ): Effect.Effect<readonly PurposeVersion[], ProcessingPurposePersistenceUnavailable> =>
    Effect.gen(function* loadPurposeVersions() {
      const rows = yield* transaction
        .select()
        .from(purposeVersions)
        .where(
          and(
            eq(purposeVersions.tenantId, tenantId),
            eq(purposeVersions.legalEntityId, legalEntityId),
            eq(purposeVersions.processingPurposeId, processingPurposeId),
          ),
        )
        .orderBy(asc(purposeVersions.versionNumber))
        .pipe(Effect.mapError((cause) => unavailable(PERSISTENCE_UNAVAILABLE, cause)));
      return yield* Effect.forEach(
        rows,
        (row): Effect.Effect<PurposeVersion, ProcessingPurposePersistenceUnavailable> =>
          // oxlint-disable-next-line effect-native/prefer-effect-fn-for-operations -- Row decoding is an inner callback of the named repository operation.
          Effect.gen(function* decodePurposeVersion() {
            const materialChangeAssessment =
              row.materialChangeAssessment === null
                ? null
                : yield* decodeMaterialityAssessment(row.materialChangeAssessment);
            const requiredConsentDimensions = yield* decodeRequiredConsentDimensions(row.requiredConsentDimensions);
            const materialScope = row.materialScope === null ? null : yield* decodeMaterialScope(row.materialScope);
            return {
              effectiveFrom: iso(row.effectiveFrom),
              effectiveTo: row.effectiveTo === null ? null : iso(row.effectiveTo),
              materialChangeAssessment,
              materialScope,
              meaning: row.meaning,
              recordedAt: iso(row.recordedAt),
              requiredConsentDimensions,
              versionId: row.purposeVersionId,
              versionNumber: row.versionNumber,
            };
          }),
        { concurrency: 1 },
      );
    }),
);

const makeRepository = (
  transaction: ScopedTransaction,
  trustedScope: Readonly<{ legalEntityId: string; tenantId: string }>,
): ProcessingPurposeRepositoryService => {
  const assertScope = (tenantId: string, legalEntityId: string) =>
    tenantId === trustedScope.tenantId && legalEntityId === trustedScope.legalEntityId
      ? Effect.void
      : Effect.fail(unavailable('Processing Purpose request scope does not match the trusted operation scope'));

  const get: ProcessingPurposeRepositoryService['get'] = Effect.fn('ProcessingPurposePostgresRepository.get')(
    function* getPurpose(tenantId, legalEntityId, processingPurposeId) {
      yield* assertScope(tenantId, legalEntityId);
      const rows = yield* transaction
        .select()
        .from(processingPurposes)
        .where(
          and(
            eq(processingPurposes.tenantId, tenantId),
            eq(processingPurposes.legalEntityId, legalEntityId),
            eq(processingPurposes.processingPurposeId, processingPurposeId),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError((cause) => unavailable(PERSISTENCE_UNAVAILABLE, cause)));
      const [row] = rows;
      if (row === undefined) {
        return Option.none<ProcessingPurpose>();
      }
      const versions = yield* loadVersions(transaction, tenantId, legalEntityId, processingPurposeId);
      return Option.some({
        businessCode: row.businessCode,
        createdAt: iso(row.createdAt),
        governanceOwnerId: row.governanceOwnerId,
        legalEntityId: row.legalEntityId,
        lifecycle: row.lifecycle === 'RETIRED' ? 'RETIRED' : 'ACTIVE',
        purposeRef: purposeRef(row.tenantId, row.processingPurposeId),
        retiredAt: row.retiredAt === null ? null : iso(row.retiredAt),
        versions,
      });
    },
  );

  const appendVersion = Effect.fn('ProcessingPurposePostgresRepository.appendVersion')(function* appendVersion(
    tenantId: string,
    legalEntityId: string,
    processingPurposeId: string,
    actionInvocationId: string,
    current: ProcessingPurpose,
    input: CreatePurposeVersionInput,
  ) {
    const versionId = randomUUID();
    const materiality = deriveMaterialVersionEvidence(current, input, versionId);
    if ('conflictReason' in materiality) {
      return yield* new PurposeVersionConflict({
        code: 'privacy_purpose_version_conflict',
        reason: materiality.conflictReason,
      });
    }
    const previous = current.versions.at(-1);
    if (previous !== undefined && input.effectiveFrom <= previous.effectiveFrom) {
      return yield* new PurposeVersionConflict({
        code: 'privacy_purpose_version_conflict',
        reason: 'Purpose Version effective time must follow the latest retained version',
      });
    }
    const nowDateTime = yield* DateTime.now;
    const now = DateTime.toDateUtc(nowDateTime);
    const version: PurposeVersion = {
      effectiveFrom: input.effectiveFrom,
      effectiveTo: null,
      materialChangeAssessment: materiality,
      materialScope: input.materialScope,
      meaning: input.meaning,
      recordedAt: DateTime.formatIso(nowDateTime),
      requiredConsentDimensions: [...(input.requiredConsentDimensions ?? [])],
      versionId,
      versionNumber: (previous?.versionNumber ?? 0) + 1,
    };
    if (previous !== undefined) {
      yield* transaction
        .update(purposeVersions)
        .set({ effectiveTo: DateTime.toDateUtc(DateTime.makeUnsafe(input.effectiveFrom)) })
        .where(
          and(
            eq(purposeVersions.tenantId, tenantId),
            eq(purposeVersions.legalEntityId, legalEntityId),
            eq(purposeVersions.processingPurposeId, processingPurposeId),
            eq(purposeVersions.purposeVersionId, previous.versionId),
          ),
        )
        .pipe(Effect.mapError((cause) => unavailable('Previous Purpose Version could not be closed', cause)));
    }
    yield* transaction
      .insert(purposeVersions)
      .values({
        actionInvocationId,
        effectiveFrom: DateTime.toDateUtc(DateTime.makeUnsafe(input.effectiveFrom)),
        effectiveTo: null,
        legalEntityId,
        materialChangeAssessment: materiality,
        materialScope: input.materialScope,
        meaning: input.meaning,
        processingPurposeId,
        purposeVersionId: version.versionId,
        recordedAt: now,
        requiredConsentDimensions: version.requiredConsentDimensions,
        tenantId,
        versionNumber: version.versionNumber,
      })
      .pipe(Effect.mapError((cause) => unavailable('Processing Purpose version could not be recorded', cause)));
    return { ...current, versions: [...current.versions, version] };
  });

  return {
    addVersion: Effect.fn('ProcessingPurposePostgresRepository.addVersion')(function* addVersion(
      ...args: Parameters<ProcessingPurposeRepositoryService['addVersion']>
    ) {
      const [tenantId, legalEntityId, processingPurposeId, actionInvocationId, input] = args;
      const current = yield* get(tenantId, legalEntityId, processingPurposeId);
      if (Option.isNone(current)) {
        return yield* new PurposeNotFound({
          code: 'privacy_purpose_not_found',
          reason: 'Processing Purpose was not found',
        });
      }
      const replayRows = yield* transaction
        .select({
          effectiveFrom: purposeVersions.effectiveFrom,
          materialChangeAssessment: purposeVersions.materialChangeAssessment,
          materialScope: purposeVersions.materialScope,
          meaning: purposeVersions.meaning,
          requiredConsentDimensions: purposeVersions.requiredConsentDimensions,
        })
        .from(purposeVersions)
        .where(
          and(
            eq(purposeVersions.tenantId, tenantId),
            eq(purposeVersions.legalEntityId, legalEntityId),
            eq(purposeVersions.actionInvocationId, actionInvocationId),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError((cause) => unavailable(PERSISTENCE_UNAVAILABLE, cause)));
      const replay = replayRows.at(0);
      if (replay !== undefined) {
        const replayAssessment =
          replay.materialChangeAssessment === null
            ? null
            : yield* decodeMaterialityAssessment(replay.materialChangeAssessment);
        const replayScope = replay.materialScope === null ? null : yield* decodeMaterialScope(replay.materialScope);
        const replayRequiredConsentDimensions = yield* decodeRequiredConsentDimensions(
          replay.requiredConsentDimensions,
        );
        const replayInput =
          replayAssessment === null || replayScope === null
            ? null
            : {
                effectiveFrom: iso(replay.effectiveFrom),
                materialChange: {
                  affectedPrivacySubjectRefs: replayAssessment.affectedPrivacySubjectRefs,
                  changedAt: replayAssessment.changedAt,
                  changeRef: replayAssessment.changeRef,
                },
                materialScope: replayScope,
                meaning: replay.meaning,
                requiredConsentDimensions: replayRequiredConsentDimensions,
              };
        if (replayInput === null || !versionInputEquivalent(replayInput, input)) {
          return yield* new PurposeVersionConflict({
            code: 'privacy_purpose_version_conflict',
            reason: 'Purpose Version Action invocation was replayed with different input',
          });
        }
        return current.value;
      }
      return yield* appendVersion(
        tenantId,
        legalEntityId,
        processingPurposeId,
        actionInvocationId,
        current.value,
        input,
      );
    }),
    create: Effect.fn('ProcessingPurposePostgresRepository.create')(function* createPurpose(
      ...args: Parameters<ProcessingPurposeRepositoryService['create']>
    ) {
      const [tenantId, legalEntityId, actionInvocationId, input] = args;
      yield* assertScope(tenantId, legalEntityId);
      const nowDateTime = yield* DateTime.now;
      const now = DateTime.toDateUtc(nowDateTime);
      const processingPurposeId = randomUUID();
      const version: PurposeVersion = {
        effectiveFrom: input.effectiveFrom,
        effectiveTo: null,
        materialChangeAssessment: null,
        materialScope: input.materialScope ?? null,
        meaning: input.meaning,
        recordedAt: DateTime.formatIso(nowDateTime),
        requiredConsentDimensions: [...(input.requiredConsentDimensions ?? [])],
        versionId: randomUUID(),
        versionNumber: 1,
      };
      yield* transaction
        .insert(processingPurposes)
        .values({
          businessCode: input.businessCode,
          createdAt: now,
          governanceOwnerId: input.governanceOwnerId,
          legalEntityId,
          lifecycle: 'ACTIVE',
          processingPurposeId,
          tenantId,
          updatedAt: now,
        })
        .pipe(Effect.mapError((cause) => unavailable('Processing Purpose identity could not be recorded', cause)));
      yield* transaction
        .insert(purposeVersions)
        .values({
          actionInvocationId,
          effectiveFrom: DateTime.toDateUtc(DateTime.makeUnsafe(input.effectiveFrom)),
          effectiveTo: null,
          legalEntityId,
          materialChangeAssessment: null,
          materialScope: input.materialScope ?? null,
          meaning: input.meaning,
          processingPurposeId,
          purposeVersionId: version.versionId,
          recordedAt: now,
          requiredConsentDimensions: version.requiredConsentDimensions,
          tenantId,
          versionNumber: 1,
        })
        .pipe(Effect.mapError((cause) => unavailable('Processing Purpose version could not be recorded', cause)));
      return {
        businessCode: input.businessCode,
        createdAt: iso(now),
        governanceOwnerId: input.governanceOwnerId,
        legalEntityId,
        lifecycle: 'ACTIVE',
        purposeRef: purposeRef(tenantId, processingPurposeId),
        retiredAt: null,
        versions: [version],
      };
    }),
    get,
    list: Effect.fn('ProcessingPurposePostgresRepository.list')(function* listPurposes(tenantId, legalEntityId) {
      yield* assertScope(tenantId, legalEntityId);
      const rows = yield* transaction
        .select({ processingPurposeId: processingPurposes.processingPurposeId })
        .from(processingPurposes)
        .where(and(eq(processingPurposes.tenantId, tenantId), eq(processingPurposes.legalEntityId, legalEntityId)))
        .pipe(Effect.mapError((cause) => unavailable(PERSISTENCE_UNAVAILABLE, cause)));
      const loaded = yield* Effect.forEach(
        rows,
        ({ processingPurposeId }) => get(tenantId, legalEntityId, processingPurposeId),
        { concurrency: 1 },
      );
      return loaded.flatMap((purpose) => (Option.isSome(purpose) ? [purpose.value] : []));
    }),
  };
};

export const processingPurposeRepositoryForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): Effect.Effect<ProcessingPurposeRepositoryService, OperationContextUnavailable> =>
  scope.legalEntityId === undefined
    ? Effect.fail(scopeUnavailable())
    : Effect.succeed(makeRepository(transaction, { legalEntityId: scope.legalEntityId, tenantId: scope.tenantId }));
