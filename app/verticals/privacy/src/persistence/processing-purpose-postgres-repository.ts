import { ProcessingPurposeRepository } from './processing-purpose-repository.ts';
import type { ProcessingPurposeRepositoryService } from './processing-purpose-repository.ts';
import type { DataAccessEventInput, OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { capturePrivacyRead } from './privacy-read-evidence.ts';
import { OperationContextUnavailable } from '@app/core-runtime';
import { and, asc, eq } from 'drizzle-orm';
import { flow, Crypto, DateTime, Effect, Option, Schema } from 'effect';

import type {
  CreatePurposeVersionInput,
  ProcessingPurpose,
  PurposeVersion,
} from '../../shared/domain/processing-purpose.ts';
import { ConsentMaterialDimensionKindSchema } from '../../shared/domain/privacy-consent-scope.ts';
import {
  CreatePurposeVersionInputSchema,
  PurposeNotFound,
  PurposeVersionConflict,
  PurposeVersionMaterialScopeSchema,
  resolvePurposeVersionTimeline,
} from '../../shared/domain/processing-purpose.ts';
import { PrivacyMaterialChangeAssessmentSchema } from '../../shared/domain/privacy-material-change.ts';
import type { ProcessingPurposeRef } from '../../shared/resources/processing-purpose.ts';
import { deriveMaterialVersionEvidence } from '../domain/processing-purpose-materiality.ts';
import { processingPurposes, purposeVersions } from '../database/schema.ts';
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

const decodeMaterialityAssessment = flow(
  Schema.decodeUnknownEffect(PrivacyMaterialChangeAssessmentSchema),
  Effect.mapError((cause) => unavailable('Stored materiality assessment could not be decoded', cause)),
);

const decodeMaterialScope = flow(
  Schema.decodeUnknownEffect(PurposeVersionMaterialScopeSchema),
  Effect.mapError((cause) => unavailable('Stored Purpose Version material scope could not be decoded', cause)),
);

const decodeRequiredConsentDimensions = flow(
  Schema.decodeUnknownEffect(Schema.Array(ConsentMaterialDimensionKindSchema)),
  Effect.mapError((cause) => unavailable('Stored required consent dimensions could not be decoded', cause)),
);

export const loadPurposeVersions = Effect.fn('ProcessingPurposePostgresRepository.loadVersions')(
  Effect.fn('loadPurposeVersions')(function* loadPurposeVersions(
    transaction: ScopedTransaction,
    tenantId: string,
    legalEntityId: string,
    processingPurposeId: string,
    readEvidence?: DataAccessEventInput[],
  ) {
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
    yield* capturePrivacyRead(readEvidence, {
      accessKind: 'list',
      queryHash: 'privacy.purpose-versions.for-scope.v1',
      resultCount: rows.length,
    });
    const versions = yield* Effect.forEach(
      rows,
      Effect.fn('decodePurposeVersion')(function* decodePurposeVersion(row: (typeof rows)[number]) {
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
    return yield* resolvePurposeVersionTimeline(versions).pipe(
      Effect.mapError((cause) => unavailable('Stored Purpose Version timeline is incoherent', cause)),
    );
  }),
);

const makeRepository = Effect.fn('ProcessingPurposePostgresRepository.make')(function* makeRepositoryEffect(
  transaction: ScopedTransaction,
  configuration: Readonly<{
    readEvidence?: DataAccessEventInput[] | undefined;
    scope: Readonly<{ legalEntityId: string; tenantId: string }>;
  }>,
): Effect.fn.Return<ProcessingPurposeRepositoryService, never, Crypto.Crypto> {
  const { readEvidence, scope: trustedScope } = configuration;
  const crypto = yield* Crypto.Crypto;
  const nextIdentifier = (reason: string) =>
    crypto.randomUUIDv4().pipe(Effect.mapError((cause) => unavailable(reason, cause)));
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
      yield* capturePrivacyRead(readEvidence, {
        accessKind: 'read',
        queryHash: 'privacy.processing-purpose.for-scope.v1',
        resultCount: rows.length,
      });
      const [row] = rows;
      if (row === undefined) {
        return Option.none<ProcessingPurpose>();
      }
      const versions = yield* loadPurposeVersions(
        transaction,
        tenantId,
        legalEntityId,
        processingPurposeId,
        readEvidence,
      );
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
    const versionId = yield* nextIdentifier('Purpose Version identifier could not be generated');
    const materiality = deriveMaterialVersionEvidence(current, input, versionId);
    if ('conflictReason' in materiality) {
      return yield* new PurposeVersionConflict({
        code: 'privacy_purpose_version_conflict',
        reason: materiality.conflictReason,
      });
    }
    const previous = current.versions.at(-1);
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
    const versions = yield* resolvePurposeVersionTimeline([...current.versions, version]);
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
    return { ...current, versions };
  });

  return {
    addVersion: Effect.fn('ProcessingPurposePostgresRepository.addVersion')(function* addVersion(
      ...args: Parameters<ProcessingPurposeRepositoryService['addVersion']>
    ) {
      const [tenantId, legalEntityId, processingPurposeId, actionInvocationId, input] = args;
      yield* assertScope(tenantId, legalEntityId);
      const roots = yield* transaction
        .select({ processingPurposeId: processingPurposes.processingPurposeId })
        .from(processingPurposes)
        .where(
          and(
            eq(processingPurposes.tenantId, tenantId),
            eq(processingPurposes.legalEntityId, legalEntityId),
            eq(processingPurposes.processingPurposeId, processingPurposeId),
          ),
        )
        .for('update')
        .pipe(Effect.mapError((cause) => unavailable('Processing Purpose append could not be serialized', cause)));
      if (roots.length !== 1) {
        return yield* new PurposeNotFound({
          code: 'privacy_purpose_not_found',
          reason: 'Processing Purpose was not found',
        });
      }
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
          processingPurposeId: purposeVersions.processingPurposeId,
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
        if (
          replay.processingPurposeId !== processingPurposeId ||
          replayInput === null ||
          !versionInputEquivalent(replayInput, input)
        ) {
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
      const [processingPurposeId, versionId] = yield* Effect.all(
        [
          nextIdentifier('Processing Purpose identifier could not be generated'),
          nextIdentifier('Purpose Version identifier could not be generated'),
        ],
        { concurrency: 2 },
      );
      const version: PurposeVersion = {
        effectiveFrom: input.effectiveFrom,
        effectiveTo: null,
        materialChangeAssessment: null,
        materialScope: input.materialScope ?? null,
        meaning: input.meaning,
        recordedAt: DateTime.formatIso(nowDateTime),
        requiredConsentDimensions: [...(input.requiredConsentDimensions ?? [])],
        versionId,
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
});

export const processingPurposeRepositoryForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): Effect.Effect<ProcessingPurposeRepositoryService, OperationContextUnavailable, Crypto.Crypto> => {
  const { legalEntityId, tenantId } = scope;
  return legalEntityId === undefined
    ? Effect.fail(scopeUnavailable())
    : makeRepository(transaction, { scope: { legalEntityId, tenantId } }).pipe(
        Effect.map((repository) => ProcessingPurposeRepository.of(repository)),
      );
};

/** The same scoped owner reads, with invocation-local result metadata. */
export const processingPurposeRepositoryWithReadEvidence = (
  transaction: ScopedTransaction,
  input: { readonly readEvidence: DataAccessEventInput[]; readonly scope: OperationalScope },
): Effect.Effect<ProcessingPurposeRepositoryService, OperationContextUnavailable, Crypto.Crypto> => {
  const { legalEntityId, tenantId } = input.scope;
  return legalEntityId === undefined
    ? Effect.fail(scopeUnavailable())
    : makeRepository(transaction, { readEvidence: input.readEvidence, scope: { legalEntityId, tenantId } });
};
