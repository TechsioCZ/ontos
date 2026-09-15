import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { and, eq, sql } from 'drizzle-orm';
import { Effect, Exit, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { Pool } from 'pg';

import { makeTestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import type { ConsentDecision } from '../../shared/domain/privacy-consent-decision.ts';
import { PrivacyPartyRefSchema } from '../../shared/domain/party-reference.ts';
import {
  consentDecisions,
  noticeProvisions,
  noticeVersions,
  privacyRelations,
  privacySubjects,
  processingPurposes,
  purposeVersions,
} from '../../src/database/schema.ts';
import { noticeProvisionRepositoryForScope } from '../../src/persistence/notice-provision-postgres-repository.ts';
import { privacyOperationRepositoryForScope } from '../../src/persistence/privacy-operation-postgres-repository.ts';
import { processingPurposeRepositoryForScope } from '../../src/persistence/processing-purpose-postgres-repository.ts';

const tenantId = 'd7000000-0000-4000-8000-000000000001';
const otherTenantId = 'd7000000-0000-4000-8000-000000000009';
const legalEntityId = 'd7000000-0000-4000-8000-000000000002';
const principalId = 'd7000000-0000-4000-8000-000000000003';
const subjectId = 'd7100000-0000-4000-8000-000000000001';

const pool = (connectionString: string) =>
  Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString, max: 6 })),
    (clientPool) => Effect.promise(() => clientPool.end()).pipe(Effect.orDie),
  );

const trustedScope = (scopedTenantId = tenantId) => ({
  authMethod: 'system' as const,
  correlationId: 'privacy-consent-postgres',
  legalEntityId,
  principalId,
  tenantId: scopedTenantId,
});

it.live('proves consent replay, ordering, conflicts, tenant isolation, and immutability in PostgreSQL', () =>
  Effect.scoped(
    Effect.gen(function* privacyConsentPostgresAcceptance() {
      const connections = yield* loadDatabaseConnectionPair();
      const adminPool = yield* pool(connections.admin.connectionString);
      const runtimePool = yield* pool(connections.runtime.connectionString);
      const admin = yield* makeTestDatabaseFromPool(adminPool, privacyRelations);
      const runtime = yield* makeTestDatabaseFromPool(runtimePool, privacyRelations);

      const cleanup = () =>
        admin.transaction((transaction) =>
          Effect.gen(function* cleanPrivacyFixtures() {
            yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
            yield* transaction.delete(consentDecisions).where(eq(consentDecisions.tenantId, tenantId));
            yield* transaction.delete(noticeProvisions).where(eq(noticeProvisions.tenantId, tenantId));
            yield* transaction.delete(noticeVersions).where(eq(noticeVersions.tenantId, tenantId));
            yield* transaction.delete(purposeVersions).where(eq(purposeVersions.tenantId, tenantId));
            yield* transaction.delete(processingPurposes).where(eq(processingPurposes.tenantId, tenantId));
            yield* transaction.delete(privacySubjects).where(eq(privacySubjects.tenantId, tenantId));
          }),
        );

      const inScope = <Value, Failure>(
        scopedTenantId: string,
        operation: (transaction: ScopedTransactionExecutor) => Effect.Effect<Value, Failure>,
      ) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* scopedOperation() {
            const scoped = yield* installOperationalScope(transaction, trustedScope(scopedTenantId));
            return yield* operation(scoped);
          }),
        );

      yield* cleanup();
      yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));

      const fixture = yield* inScope(tenantId, (transaction) =>
        Effect.gen(function* createConsentFixture() {
          const purposeRepository = yield* processingPurposeRepositoryForScope(transaction, trustedScope());
          const operations = yield* privacyOperationRepositoryForScope(transaction, trustedScope());
          const provisions = yield* noticeProvisionRepositoryForScope(transaction, trustedScope());
          const purpose = yield* purposeRepository.create(
            tenantId,
            legalEntityId,
            'd7200000-0000-4000-8000-000000000001',
            {
              businessCode: 'PRIVACY_DB_TEST',
              effectiveFrom: '2026-01-01T00:00:00Z',
              governanceOwnerId: principalId,
              meaning: 'Exercise Privacy consent persistence invariants',
              requiredConsentDimensions: ['SITE'],
            },
          );
          yield* operations.createSubject(tenantId, legalEntityId, 'd7200000-0000-4000-8000-000000000002', {
            createdAt: '2026-01-01T00:00:00Z',
            subject: {
              kind: 'DATA_SUBJECT',
              partyRef: Schema.decodeUnknownSync(PrivacyPartyRefSchema)({
                moduleId: 'party.registry',
                resourceId: 'privacy-db-party',
                resourceType: 'party.registry.party',
                tenantId,
              }),
            },
            subjectRef: {
              moduleId: 'privacy.core',
              resourceId: subjectId,
              resourceType: 'privacy.core.privacy-subject',
              tenantId,
            },
            updatedAt: '2026-01-01T00:00:00Z',
          });
          const purposeVersion = Option.getOrThrow(Option.fromUndefinedOr(purpose.versions.at(0)));
          yield* Effect.forEach(
            ['scope:privacy-db:conflict', 'scope:privacy-db:ordered'],
            (processingScopeRef, index) =>
              // oxlint-disable-next-line sonarjs/no-nested-functions -- The scoped integration fixture must create versioned notice evidence inside its transaction lifecycle.
              Effect.gen(function* createNoticeEvidence() {
                const notice = yield* operations.createNoticeVersion(
                  tenantId,
                  legalEntityId,
                  `d7400000-0000-4000-8000-00000000000${index + 1}`,
                  `d7500000-0000-4000-8000-00000000000${index + 1}`,
                  {
                    applicableScope: {
                      facts: [
                        { dimension: 'PRIVACY_SUBJECT', value: subjectId },
                        { dimension: 'CONTROLLER_SCOPE', value: 'controller:privacy-db' },
                        { dimension: 'PROCESSING_PURPOSE', value: purpose.purposeRef.resourceId },
                        { dimension: 'PROCESSING_PURPOSE_VERSION', value: purposeVersion.versionId },
                        { dimension: 'SITE', value: 'site:privacy-db' },
                      ],
                      operation: 'CONSENT_DECISION',
                      processingScopeRef: { scopeId: processingScopeRef, scopeType: 'privacy.processing-scope' },
                    },
                    contentIdentity: `privacy-db-notice:${index}`,
                    effectiveFrom: '2026-01-01T00:00:00Z',
                    evidenceArtifactRef: null,
                    language: 'en',
                    wording: 'Privacy consent notice',
                  },
                );
                const provisionId = `notice-proof:${processingScopeRef}`;
                const evidenceRef = `privacy-db-proof:${processingScopeRef}`;
                yield* provisions.record(tenantId, legalEntityId, `d7600000-0000-4000-8000-00000000000${index + 1}`, {
                  actionRef: 'privacy-db-action',
                  anonymousContextRef: null,
                  businessInteractionRef: `privacy-db-interaction:${index}`,
                  channel: 'web',
                  channelProof: {
                    anonymousContextRef: null,
                    authorityRef: 'privacy-db-channel-authority',
                    businessInteractionRef: `privacy-db-interaction:${index}`,
                    channel: 'web',
                    controllerRef: 'controller:privacy-db',
                    evidenceRef,
                    noticeVersionRef: notice.versionId,
                    observedAt: '2026-01-01T00:00:01Z',
                    privacySubjectRef: subjectId,
                    processingPurposeRef: purpose.purposeRef.resourceId,
                    processingScopeRef,
                    proofKind: 'INTERACTIVE_ACKNOWLEDGEMENT',
                    providedLanguage: 'en',
                  },
                  controllerRef: 'controller:privacy-db',
                  evidenceRef,
                  failureReason: null,
                  noticeVersionRef: notice.versionId,
                  outcome: 'PROVEN_PROVISION',
                  privacySubjectRef: subjectId,
                  processingPurposeRef: purpose.purposeRef.resourceId,
                  processingScopeRef,
                  providedLanguage: 'en',
                  provisionedAt: '2026-01-01T00:00:01Z',
                  provisionId,
                  recordedAt: '2026-01-01T00:00:02Z',
                  supersedesProvisionRef: null,
                });
              }),
            { concurrency: 1 },
          );
          return purpose;
        }),
      );
      const purposeVersion = Option.getOrThrow(Option.fromUndefinedOr(fixture.versions.at(0)));

      const decision = (
        decisionId: string,
        kind: ConsentDecision['decision'],
        effectiveAt: string,
        recordedAt: string,
        scopeRef: string,
        idempotencyKey: string,
      ): ConsentDecision => ({
        actorEvidence: {
          actor: { principalId, tenantId },
          attributedAt: recordedAt,
          authMethod: 'system',
          impersonatedBy: null,
        },
        decision: kind,
        decisionId,
        effectiveAt,
        flowEvidenceRefs: [],
        idempotencyKey,
        noticeEvidenceRefs: [`notice-proof:${scopeRef}`],
        provenanceRefs: ['privacy-db-provenance'],
        recordedAt,
        scope: {
          controllerRef: 'controller:privacy-db',
          materialDimensions: [{ kind: 'SITE', value: 'site:privacy-db' }],
          privacySubjectRef: {
            moduleId: 'privacy.core',
            resourceId: subjectId,
            resourceType: 'privacy.core.privacy-subject',
            tenantId,
          },
          processingPurposeRef: fixture.purposeRef,
          purposeMeaning: purposeVersion.meaning,
          purposeVersionRef: purposeVersion.versionId,
          scopeRef,
        },
      });

      const write = (invocationId: string, consent: ConsentDecision) =>
        inScope(tenantId, (transaction) =>
          privacyOperationRepositoryForScope(transaction, trustedScope()).pipe(
            Effect.flatMap((repository) =>
              repository.recordConsentDecision(tenantId, legalEntityId, invocationId, consent),
            ),
          ),
        );
      const read = (scopeRef: string) =>
        inScope(tenantId, (transaction) =>
          privacyOperationRepositoryForScope(transaction, trustedScope()).pipe(
            Effect.flatMap((repository) => repository.readCurrentConsent(tenantId, legalEntityId, scopeRef)),
          ),
        );

      const conflictScope = 'scope:privacy-db:conflict';
      const evidenceDecision = decision(
        'decision:evidence-negative',
        'GRANTED',
        '2026-01-15T00:00:00Z',
        '2026-01-15T00:00:01Z',
        conflictScope,
        'key:evidence-negative',
      );
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            write('d7300000-0000-4000-8000-000000000011', {
              ...evidenceDecision,
              scope: { ...evidenceDecision.scope, controllerRef: 'controller:mismatched' },
            }),
          ),
        ),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            write('d7300000-0000-4000-8000-000000000012', {
              ...evidenceDecision,
              decisionId: 'decision:evidence-scope-negative',
              idempotencyKey: 'key:evidence-scope-negative',
              scope: { ...evidenceDecision.scope, scopeRef: 'scope:mismatched' },
            }),
          ),
        ),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            write('d7300000-0000-4000-8000-000000000013', {
              ...evidenceDecision,
              decisionId: 'decision:evidence-version-negative',
              idempotencyKey: 'key:evidence-version-negative',
              scope: {
                ...evidenceDecision.scope,
                purposeVersionRef: 'd7700000-0000-4000-8000-000000000001',
              },
            }),
          ),
        ),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            write('d7300000-0000-4000-8000-000000000014', {
              ...evidenceDecision,
              decisionId: 'decision:evidence-dimension-negative',
              idempotencyKey: 'key:evidence-dimension-negative',
              scope: {
                ...evidenceDecision.scope,
                materialDimensions: [{ kind: 'SITE', value: 'site:mismatched' }],
              },
            }),
          ),
        ),
      ).toBe(true);
      yield* Effect.all(
        [
          write(
            'd7300000-0000-4000-8000-000000000001',
            decision(
              'decision:conflict:grant',
              'GRANTED',
              '2026-02-01T00:00:00Z',
              '2026-02-01T00:00:01Z',
              conflictScope,
              'key:conflict:grant',
            ),
          ),
          write(
            'd7300000-0000-4000-8000-000000000002',
            decision(
              'decision:conflict:refuse',
              'REFUSED',
              '2026-02-01T00:00:00Z',
              '2026-02-01T00:00:02Z',
              conflictScope,
              'key:conflict:refuse',
            ),
          ),
        ],
        { concurrency: 'unbounded' },
      );
      expect((yield* read(conflictScope)).outcome).toBe('CONFLICT');

      const orderedScope = 'scope:privacy-db:ordered';
      const withdrawal = decision(
        'decision:ordered:withdraw',
        'WITHDRAWN',
        '2026-03-01T00:00:00Z',
        '2026-03-01T00:00:01Z',
        orderedScope,
        'key:ordered:withdraw',
      );
      yield* write('d7300000-0000-4000-8000-000000000003', withdrawal);
      const delayedGrant = decision(
        'decision:ordered:grant',
        'GRANTED',
        '2026-02-01T00:00:00Z',
        '2026-04-01T00:00:00Z',
        orderedScope,
        'key:ordered:grant',
      );
      const firstGrant = yield* write('d7300000-0000-4000-8000-000000000004', delayedGrant);
      const replayGrant = yield* write('d7300000-0000-4000-8000-000000000004', delayedGrant);
      expect(replayGrant).toEqual(firstGrant);
      const current = yield* read(orderedScope);
      expect(current.outcome).toBe('CURRENT');
      if (current.outcome === 'CURRENT') {
        expect(current.decision.decision).toBe('WITHDRAWN');
      }

      const conflictingReplay = yield* Effect.exit(
        write('d7300000-0000-4000-8000-000000000004', { ...delayedGrant, decisionId: 'decision:ordered:different' }),
      );
      expect(Exit.isFailure(conflictingReplay)).toBe(true);

      const isolated = yield* inScope(otherTenantId, (transaction) =>
        privacyOperationRepositoryForScope(transaction, trustedScope(otherTenantId)).pipe(
          Effect.flatMap((repository) => repository.listSubjects(otherTenantId, legalEntityId)),
        ),
      );
      expect(isolated).toEqual([]);

      const immutableMutation = yield* Effect.exit(
        inScope(tenantId, (transaction) =>
          transaction
            .update(consentDecisions)
            .set({ decision: 'GRANTED' })
            .where(
              and(
                eq(consentDecisions.tenantId, tenantId),
                eq(consentDecisions.legalEntityId, legalEntityId),
                eq(consentDecisions.decisionId, withdrawal.decisionId),
              ),
            ),
        ),
      );
      expect(Exit.isFailure(immutableMutation)).toBe(true);
    }),
  ),
);
