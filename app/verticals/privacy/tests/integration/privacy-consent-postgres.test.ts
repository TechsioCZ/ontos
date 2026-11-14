import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { makeNativeReadTestContext } from '@app/core-runtime/testing/native-reads';
import { NodeCrypto } from '@effect/platform-node';
import { TrustedOperationConsentAuthorityFactSchema } from '@app/consent-authority-contracts';
import type { ConsentSelfServiceRequest, TrustedOperationConsentAuthorityFact } from '@app/consent-authority-contracts';
import { and, eq } from 'drizzle-orm';
import { Crypto, DateTime, Effect, Exit, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { ConsentSelfServiceAuthorizationError } from '../../shared/domain/privacy-consent-self-service.ts';
import type { ConsentDecision } from '../../shared/domain/privacy-consent-decision.ts';
import { consentDecisions, privacySubjects } from '../../src/database/schema.ts';
import { noticeProvisionRepositoryForScope } from '../../src/persistence/notice-provision-postgres-repository.ts';
import { privacyOperationRepositoryForScope } from '../../src/persistence/privacy-operation-postgres-repository.ts';
import { PrivacyOperationPersistenceError } from '../../src/persistence/privacy-operation-persistence-error.ts';
import { processingPurposeRepositoryForScope } from '../../src/persistence/processing-purpose-postgres-repository.ts';
import {
  CommerceConsentAuthorityLookup,
  preparedCommerceConsentExecution,
} from '../../src/actions/commerce-consent-authority.ts';
import { consentSelfServiceAction, handleConsentSelfService } from '../../src/actions/consent-self-service.action.ts';

it.live(
  'proves web-collected EMAIL consent, channel isolation, replay, ordering, acknowledged receipt retries, and immutability in PostgreSQL',
  Effect.fn('privacyConsentPostgresAcceptance')(
    function* privacyConsentPostgresAcceptance() {
      const native = yield* makeNativeReadTestContext({
        contextPermissions: ['privacy.consent.read'],
        moduleId: 'privacy.core',
        ownerFixtureRetention: 'retain-complete-context',
      });
      const { principalId, tenantId } = native.principal;
      const legalEntityId = Option.getOrThrow(Option.fromUndefinedOr(native.principal.legalEntityId));
      const crypto = yield* Crypto.Crypto;
      const subjectId = yield* crypto.randomUUIDv4();
      const trustedScope = () => ({ ...native.principal, correlationId: 'privacy-consent-postgres', legalEntityId });
      const inScope = <Value, Failure, Requirements>(
        _scopedTenantId: string,
        operation: (transaction: ScopedTransactionExecutor) => Effect.Effect<Value, Failure, Requirements>,
      ) => native.prepareOwner((transaction) => operation(transaction)).pipe(Effect.provide(native.layer));

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
                  anonymousContext: {
                    addressability: 'SESSION',
                    contextRef: `native-consent:${subjectId}`,
                    createdAt: '2026-01-01T00:00:00Z',
                    expiresAt: '2027-01-01T00:00:00Z',
                    kind: 'ANONYMOUS_PRIVACY_CONTEXT',
                    provenance: { method: 'SESSION', source: 'native-consent-owner' },
                  },
                  kind: 'ANONYMOUS',
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
            [
              `scope:privacy-db:${tenantId}:conflict`,
              `scope:privacy-db:${tenantId}:ordered`,
              `scope:privacy-db:${tenantId}:receipt-retry`,
            ],
            Effect.fn('createNoticeEvidence')(function* createNoticeEvidence(
              processingScopeRef: string,
              index: number,
            ) {
              const controllerRef =
                processingScopeRef === `scope:privacy-db:${tenantId}:receipt-retry`
                  ? legalEntityId
                  : 'controller:privacy-db';
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
        decisionId: `${tenantId}:${decisionId}`,
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
        inScope(
          tenantId,
          Effect.fn('writeRetainedConsent')(function* writeRetainedConsent(transaction) {
            const repository = yield* privacyOperationRepositoryForScope(transaction, trustedScope());
            return yield* repository.recordConsentDecision(tenantId, legalEntityId, invocationId, consent);
          }),
        );
      const read = (scopeRef: string) =>
        inScope(
          tenantId,
          Effect.fn('readRetainedConsent')(function* readRetainedConsent(transaction) {
            const repository = yield* privacyOperationRepositoryForScope(transaction, trustedScope());
            return yield* repository.readCurrentConsent(tenantId, legalEntityId, scopeRef);
          }),
        );

      const conflictScope = `scope:privacy-db:${tenantId}:conflict`;
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

      const orderedScope = `scope:privacy-db:${tenantId}:ordered`;
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

      // The public authority facts represent retained server acknowledgements. Commerce
      // proves receipt persistence and replay in its own owner-local integration suite.
      // This test proves Privacy's real Action and current-consent selection without
      // importing another owner's implementation or accessing its database.
      yield* Effect.gen(function* retryAcknowledgedReceipt() {
        yield* TestClock.setTime(new Date('2026-10-23T12:00:00.000Z').getTime());
        const scopeRef = `scope:privacy-db:${tenantId}:receipt-retry`;
        const scope = { ...evidenceDecision.scope, controllerRef: legalEntityId, scopeRef };
        const grantId = yield* crypto.randomUUIDv4();
        const withdrawalId = yield* crypto.randomUUIDv4();
        const noticeProof = yield* inScope(tenantId, (transaction) =>
          noticeProvisionRepositoryForScope(transaction, trustedScope()).pipe(
            Effect.flatMap((provisions) => provisions.findById(tenantId, legalEntityId, `notice-proof:${scopeRef}`)),
            Effect.map(Option.getOrThrow),
          ),
        );
        const provisionNotice = (requestId: string) =>
          inScope(
            tenantId,
            Effect.fn('provisionReceiptNotice')(function* provisionReceiptNotice(transaction) {
              const provisions = yield* noticeProvisionRepositoryForScope(transaction, trustedScope());
              yield* provisions.record(tenantId, legalEntityId, requestId, {
                ...noticeProof,
                provisionId: `commerce-notice:${requestId}`,
              });
            }),
          );
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
        const retainedAuthorityFact = (requestId: string, kind: 'GRANTED' | 'WITHDRAWN', acknowledgedAt: string) =>
          Schema.decodeUnknownEffect(TrustedOperationConsentAuthorityFactSchema)({
            actorPrincipalRef: { principalId, tenantId },
            authorizedScope: scope,
            decisionReceipt: { acknowledgedAt, decision: kind, requestRef: requestId },
            evidenceRefs: [requestId, 'receipt-retry-session'],
            expiresAt: '2099-01-01T00:00:00Z',
            kind: 'OPERATION_SCOPED',
            operation: kind === 'WITHDRAWN' ? 'CONSENT_WITHDRAW' : 'CONSENT_WRITE',
            operationRef: requestId,
            proofRef: 'receipt-retry-session',
            scopeRef,
            status: 'CURRENT',
            subjectRef: scope.privacySubjectRef,
            verifiedAt: acknowledgedAt,
          });
        const grant = yield* retainedAuthorityFact(grantId, 'GRANTED', '2026-10-23T12:00:00.000Z');
        const withdrawn = yield* retainedAuthorityFact(withdrawalId, 'WITHDRAWN', '2026-10-23T12:00:01.000Z');
        yield* provisionNotice(grantId);
        yield* provisionNotice(withdrawalId);
        let unavailable = true;
        const invoke = Effect.fn('invokeConsentAction')(function* invokeConsentAction(
          request: ConsentSelfServiceRequest,
          fact: TrustedOperationConsentAuthorityFact,
        ) {
          const execution = yield* preparedCommerceConsentExecution.pipe(
            Effect.provideService(CommerceConsentAuthorityLookup, {
              resolve: Effect.fn('lookupReceipt')(function* lookupReceipt() {
                if (unavailable) {
                  return yield* new ConsentSelfServiceAuthorizationError({
                    code: 'AUTHORITY_UNAVAILABLE',
                    reason: 'First call fails before Action execution',
                  });
                }
                return fact;
              }),
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
        expect(Exit.isFailure(yield* Effect.exit(invoke(requestForReceipt(grantId, 'GRANTED'), grant)))).toBe(true);
        expect((yield* read(scopeRef)).outcome).toBe('ABSENT');
        yield* TestClock.adjust('1 second');
        unavailable = false;
        yield* invoke(requestForReceipt(withdrawalId, 'WITHDRAWN'), withdrawn);
        yield* TestClock.adjust('1 second');
        const delayed = yield* invoke(requestForReceipt(grantId, 'GRANTED'), grant);
        expect(delayed.decision.effectiveAt).toBe(grant.decisionReceipt.acknowledgedAt);
        expect(delayed.decision.recordedAt).toBe(DateTime.formatIso(yield* DateTime.now));
        const afterRetry = yield* read(scopeRef);
        expect(afterRetry.outcome).toBe('CURRENT');
        if (afterRetry.outcome === 'CURRENT') {
          expect(afterRetry.decision.decision).toBe('WITHDRAWN');
          expect(afterRetry.decision.effectiveAt).toBe(withdrawn.decisionReceipt.acknowledgedAt);
        }
      }).pipe(Effect.provide(TestClock.layer()));

      // A separate genuinely validated Tenant cannot see the original Tenant's existing Subjects.
      const foreign = yield* makeNativeReadTestContext({
        contextPermissions: [],
        moduleId: 'privacy.core',
        ownerFixtureRetention: 'retain-complete-context',
      });
      const isolated = yield* foreign
        .prepareOwner((transaction) =>
          transaction.select().from(privacySubjects).where(eq(privacySubjects.tenantId, tenantId)),
        )
        .pipe(Effect.provide(foreign.layer));
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
    },
    Effect.scoped,
    Effect.provide(NodeCrypto.layer),
  ),
);
