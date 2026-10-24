import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { ActionAuthorizationPreflightDatabaseLive, loadDatabaseConnectionPair } from '@app/core-runtime';
import { TrustedOperationConsentAuthorityFactSchema } from '@app/consent-authority-contracts';
import type { ConsentSelfServiceRequest } from '@app/consent-authority-contracts';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { CoreDatabase, makeCoreDatabase } from '../../../../packages/core-runtime/src/db/client.ts';
import { CommerceEnrollmentOwnerTransactionRunnerLive } from '../../../commerce-customer-context/src/enrollment/orchestration/owner-transaction-runner.ts';
import {
  CustomerConsentReceiptSchema,
  matchesCustomerConsentReceipt,
} from '../../../commerce-customer-context/api/portal-auth/consent/model.ts';
import {
  readCustomerConsentReceipt,
  recordCustomerConsentReceipt,
} from '../../../commerce-customer-context/api/portal-auth/consent/receipt-persistence.ts';
import { consentSelfServiceAction, handleConsentSelfService } from '../../src/actions/consent-self-service.action.ts';
import {
  CommerceConsentAuthorityLookup,
  preparedCommerceConsentExecution,
} from '../../src/actions/commerce-consent-authority.ts';
import { ConsentSelfServiceAuthorizationError } from '../../shared/domain/privacy-consent-self-service.ts';
import { TestClock } from 'effect/testing';
import { and, eq, sql } from 'drizzle-orm';
import { DateTime, Effect, Exit, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
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
import { PrivacyOperationPersistenceError } from '../../src/persistence/privacy-operation-persistence-error.ts';
import { processingPurposeRepositoryForScope } from '../../src/persistence/processing-purpose-postgres-repository.ts';

const tenantId = 'd7000000-0000-4000-8000-000000000001';
const otherTenantId = 'd7000000-0000-4000-8000-000000000009';
const legalEntityId = 'd7000000-0000-4000-8000-000000000002';
const principalId = 'd7000000-0000-4000-8000-000000000003';
const subjectId = 'd7100000-0000-4000-8000-000000000001';

const pool = makeTestPgClient;
const receiptAuthorityUnavailable = () =>
  new ConsentSelfServiceAuthorizationError({
    code: 'AUTHORITY_UNAVAILABLE',
    reason: 'Receipt lookup could not complete',
  });

const trustedScope = (scopedTenantId = tenantId) => ({
  authMethod: 'system' as const,
  correlationId: 'privacy-consent-postgres',
  legalEntityId,
  principalId,
  tenantId: scopedTenantId,
});

it.live(
  'proves web-collected EMAIL consent, channel isolation, replay, ordering, and immutability in PostgreSQL',
  Effect.fn('privacyConsentPostgresAcceptance')(function* privacyConsentPostgresAcceptance() {
    const connections = yield* loadDatabaseConnectionPair();
    const adminPool = yield* pool(connections.admin.connectionString);
    const runtimePool = yield* pool(connections.runtime.connectionString);
    const admin = yield* makeTestDatabaseFromClient(adminPool, privacyRelations);
    const runtime = yield* makeTestDatabaseFromClient(runtimePool, privacyRelations);

    const cleanup = () =>
      admin.transaction(
        Effect.fn('cleanPrivacyFixtures')(function* cleanPrivacyFixtures(
          transaction: Parameters<Parameters<typeof admin.transaction>[0]>[0],
        ) {
          yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
          yield* transaction.execute(
            sql`delete from commerce_customer_context.customer_consent_receipts where tenant_id = ${tenantId}::uuid and receipt_id in ('d7800000-0000-4000-8000-000000000001'::uuid, 'd7800000-0000-4000-8000-000000000002'::uuid)`,
          );
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
      runtime.transaction(
        Effect.fn('scopedOperation')(function* scopedOperation(
          transaction: Parameters<Parameters<typeof runtime.transaction>[0]>[0],
        ) {
          const scoped = yield* installOperationalScope(transaction, trustedScope(scopedTenantId));
          return yield* operation(scoped);
        }),
      );

    yield* cleanup();
    yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));

    const fixture = yield* inScope(
      tenantId,
      Effect.fn('createConsentFixture')(function* createConsentFixture(transaction) {
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
            requiredConsentDimensions: ['SITE', 'COMMUNICATION_CHANNEL'],
          },
        );
        yield* operations.createSubject(
          { legalEntityId, tenantId },
          {
            actionInvocationId: 'd7200000-0000-4000-8000-000000000002',
            subject: {
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
            },
          },
        );
        const purposeVersion = Option.getOrThrow(Option.fromUndefinedOr(purpose.versions.at(0)));
        yield* Effect.forEach(
          ['scope:privacy-db:conflict', 'scope:privacy-db:ordered', 'scope:privacy-db:receipt-retry'],
          Effect.fn('createNoticeEvidence')(function* createNoticeEvidence(processingScopeRef: string, index: number) {
            const controllerRef =
              processingScopeRef === 'scope:privacy-db:receipt-retry' ? legalEntityId : 'controller:privacy-db';
            const notice = yield* operations.createNoticeVersion(
              { legalEntityId, tenantId },
              {
                actionInvocationId: `d7400000-0000-4000-8000-00000000000${index + 1}`,
                input: {
                  applicableScope: {
                    facts: [
                      { dimension: 'PRIVACY_SUBJECT', value: subjectId },
                      { dimension: 'CONTROLLER_SCOPE', value: controllerRef },
                      { dimension: 'PROCESSING_PURPOSE', value: purpose.purposeRef.resourceId },
                      { dimension: 'PROCESSING_PURPOSE_VERSION', value: purposeVersion.versionId },
                      { dimension: 'SITE', value: 'site:privacy-db' },
                      { dimension: 'CHANNEL', value: 'EMAIL' },
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
                noticeId: `d7500000-0000-4000-8000-00000000000${index + 1}`,
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
                controllerRef,
                evidenceRef,
                noticeVersionRef: notice.versionId,
                observedAt: '2026-01-01T00:00:01Z',
                privacySubjectRef: subjectId,
                processingPurposeRef: purpose.purposeRef.resourceId,
                processingScopeRef,
                proofKind: 'INTERACTIVE_ACKNOWLEDGEMENT',
                providedLanguage: 'en',
              },
              controllerRef,
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
        materialDimensions: [
          { kind: 'SITE', value: 'site:privacy-db' },
          { kind: 'COMMUNICATION_CHANNEL', value: 'EMAIL' },
        ],
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
    const smsDecision: ConsentDecision = {
      ...evidenceDecision,
      decisionId: 'decision:email-proof-cannot-authorize-sms',
      idempotencyKey: 'key:email-proof-cannot-authorize-sms',
      scope: {
        ...evidenceDecision.scope,
        materialDimensions: [
          { kind: 'SITE', value: 'site:privacy-db' },
          { kind: 'COMMUNICATION_CHANNEL', value: 'SMS' },
        ],
      },
    };
    const smsFailure = yield* Effect.flip(write('d7300000-0000-4000-8000-000000000015', smsDecision));
    expect(Schema.is(PrivacyOperationPersistenceError)(smsFailure)).toBe(true);
    if (Schema.is(PrivacyOperationPersistenceError)(smsFailure)) {
      expect(smsFailure.code).toBe('privacy_operation_not_found');
      expect(smsFailure.reason).toContain('notice evidence is not authoritative');
    }

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
    expect(firstGrant.scope.materialDimensions).toContainEqual({ kind: 'COMMUNICATION_CHANNEL', value: 'EMAIL' });
    const current = yield* read(orderedScope);
    expect(current.outcome).toBe('CURRENT');
    if (current.outcome === 'CURRENT') {
      expect(current.decision.decision).toBe('WITHDRAWN');
    }

    const conflictingReplay = yield* Effect.exit(
      write('d7300000-0000-4000-8000-000000000004', { ...delayedGrant, decisionId: 'decision:ordered:different' }),
    );
    expect(Exit.isFailure(conflictingReplay)).toBe(true);

    // Unlike the repository-only ordering case above, timestamps below are produced by
    // the server clock, persisted as Commerce receipts, then consumed by the real Action.
    // Owner HTTP/session admission is represented by the lookup port; neither Action
    // decision timestamps nor current-consent selection are mocked.
    const receiptDatabase = yield* makeCoreDatabase(connections.runtime);
    const receiptRunner = CommerceEnrollmentOwnerTransactionRunnerLive.pipe(
      Layer.provide(ActionAuthorizationPreflightDatabaseLive),
      Layer.provide(Layer.succeed(CoreDatabase, receiptDatabase)),
    );
    yield* Effect.gen(function* retryAcknowledgedReceipt() {
      yield* TestClock.setTime(new Date('2026-10-23T12:00:00.000Z').getTime());
      const scopeRef = 'scope:privacy-db:receipt-retry';
      const scope = { ...evidenceDecision.scope, controllerRef: legalEntityId, scopeRef };
      const receiptScope = {
        compositionRevision: 'receipt-retry-proof',
        legalEntityId,
        partyId: 'privacy-db-party',
        requestCorrelation: 'receipt-retry-proof',
        tenantId,
      };
      const grantId = 'd7800000-0000-4000-8000-000000000001';
      const withdrawalId = 'd7800000-0000-4000-8000-000000000002';
      const noticeProof = yield* inScope(tenantId, (transaction) =>
        noticeProvisionRepositoryForScope(transaction, trustedScope()).pipe(
          Effect.flatMap((provisions) => provisions.findById(tenantId, legalEntityId, `notice-proof:${scopeRef}`)),
          Effect.map(Option.getOrThrow),
        ),
      );
      const acknowledge = Effect.fn('acknowledgeReceipt')(function* acknowledgeReceipt(
        requestId: string,
        kind: 'GRANTED' | 'WITHDRAWN',
      ) {
        const receipt = yield* recordCustomerConsentReceipt(
          receiptScope,
          yield* Schema.decodeUnknownEffect(CustomerConsentReceiptSchema)({
            acknowledgedAt: DateTime.formatIso(yield* DateTime.now),
            decision: kind,
            noticeVersionId: noticeProof.noticeVersionRef,
            partyId: receiptScope.partyId,
            providedLanguage: 'en',
            providerSubjectId: 'receipt-retry-provider',
            requestId,
            scope,
            sessionRef: 'receipt-retry-session',
          }),
        );
        yield* inScope(
          tenantId,
          Effect.fn('provisionReceiptNotice')(function* provisionReceiptNotice(transaction) {
            const provisions = yield* noticeProvisionRepositoryForScope(transaction, trustedScope());
            yield* provisions.record(tenantId, legalEntityId, requestId, {
              ...noticeProof,
              provisionId: `commerce-notice:${requestId}`,
            });
          }),
        );
        return receipt;
      });
      const requestForReceipt = (requestId: string, kind: 'GRANTED' | 'WITHDRAWN'): ConsentSelfServiceRequest => ({
        decision: kind,
        noticeEvidenceRefs: [`commerce-notice:${requestId}`],
        path: {
          credentialRef: 'receipt-retry-session',
          kind: 'OPERATION_SCOPED',
          operation: kind === 'WITHDRAWN' ? 'CONSENT_WITHDRAW' : 'CONSENT_WRITE',
          operationRef: requestId,
          requestRef: requestId,
          scopeRef,
          subjectRef: scope.privacySubjectRef,
        },
        scope,
      });
      let unavailable = true;
      const invoke = Effect.fn('invokeConsentAction')(function* invokeConsentAction(
        request: ConsentSelfServiceRequest,
      ) {
        const execution = yield* preparedCommerceConsentExecution.pipe(
          Effect.provideService(CommerceConsentAuthorityLookup, {
            resolve: Effect.fn('lookupReceipt')(
              function* lookupReceipt() {
                if (unavailable) {
                  return yield* new ConsentSelfServiceAuthorizationError({
                    code: 'AUTHORITY_UNAVAILABLE',
                    reason: 'First call fails before Action execution',
                  });
                }
                const retained = Option.getOrThrow(
                  yield* readCustomerConsentReceipt(receiptScope, request.path.requestRef),
                );
                expect(matchesCustomerConsentReceipt('receipt-retry-session', request, retained)).toBe(true);
                return yield* Schema.decodeUnknownEffect(TrustedOperationConsentAuthorityFactSchema)({
                  actorPrincipalRef: { principalId, tenantId },
                  authorizedScope: retained.scope,
                  decisionReceipt: {
                    acknowledgedAt: DateTime.formatIso(retained.acknowledgedAt),
                    decision: retained.decision,
                    requestRef: retained.requestId,
                  },
                  evidenceRefs: [retained.requestId, retained.sessionRef],
                  expiresAt: '2099-01-01T00:00:00Z',
                  kind: 'OPERATION_SCOPED',
                  operation: request.path.operation,
                  operationRef: retained.requestId,
                  proofRef: retained.sessionRef,
                  scopeRef,
                  status: 'CURRENT',
                  subjectRef: scope.privacySubjectRef,
                  verifiedAt: DateTime.formatIso(yield* DateTime.now),
                });
              },
              Effect.provide(receiptRunner),
              Effect.mapError(receiptAuthorityUnavailable),
            ),
            resolveNotice: () =>
              Effect.fail(
                new ConsentSelfServiceAuthorizationError({
                  code: 'MISSING_AUTHORITY',
                  reason: 'Not used by this fixture',
                }),
              ),
          }),
        );
        const actionInvocationId = request.path.requestRef;
        const principal = { authMethod: 'api_key' as const, legalEntityId, principalId, tenantId };
        const actionScope = { ...principal, correlationId: 'receipt-retry-proof' };
        expect(
          yield* execution.preflight.prepare({
            actionInvocationId,
            actionKey: 'privacy.core.consent-self-service',
            correlationId: actionScope.correlationId,
            payload: request,
            principal,
            scope: actionScope,
          }),
        ).toEqual({ outcome: 'not_applicable' });
        return yield* inScope(
          tenantId,
          Effect.fn('runSelfServiceAction')(function* runSelfServiceAction(transaction) {
            const operations = yield* privacyOperationRepositoryForScope(transaction, actionScope);
            const purposes = yield* processingPurposeRepositoryForScope(transaction, actionScope);
            const collector = createActionCollector(
              consentSelfServiceAction.descriptor.domainEvents,
              'privacy.core',
              consentSelfServiceAction.descriptor.accessEvidencePolicy,
              consentSelfServiceAction.descriptor.auditEvidenceSchema,
            );
            return yield* handleConsentSelfService(request, {
              ...collector,
              actionInvocationId,
              compositionRevision: 'receipt-retry-proof',
              scope: actionScope,
              services: {
                authority: execution.authority,
                consentDecision: { get: purposes.get, recordConsentDecision: operations.recordConsentDecision },
              },
            });
          }),
        );
      });
      const grant = yield* acknowledge(grantId, 'GRANTED');
      expect(Exit.isFailure(yield* Effect.exit(invoke(requestForReceipt(grantId, 'GRANTED'))))).toBe(true);
      expect((yield* read(scopeRef)).outcome).toBe('ABSENT');
      yield* TestClock.adjust('1 second');
      unavailable = false;
      const withdrawn = yield* acknowledge(withdrawalId, 'WITHDRAWN');
      yield* invoke(requestForReceipt(withdrawalId, 'WITHDRAWN'));
      yield* TestClock.adjust('1 second');
      const replayReceipt = yield* acknowledge(grantId, 'GRANTED');
      expect(replayReceipt.acknowledgedAt).toEqual(grant.acknowledgedAt);
      const delayed = yield* invoke(requestForReceipt(grantId, 'GRANTED'));
      expect(delayed.decision.effectiveAt).toBe(DateTime.formatIso(grant.acknowledgedAt));
      expect(delayed.decision.recordedAt).toBe(DateTime.formatIso(yield* DateTime.now));
      const afterRetry = yield* read(scopeRef);
      expect(afterRetry.outcome).toBe('CURRENT');
      if (afterRetry.outcome === 'CURRENT') {
        expect(afterRetry.decision.decision).toBe('WITHDRAWN');
        expect(afterRetry.decision.effectiveAt).toBe(DateTime.formatIso(withdrawn.acknowledgedAt));
      }
    }).pipe(Effect.provide(receiptRunner), Effect.provide(TestClock.layer()));

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
  }, Effect.scoped),
);
