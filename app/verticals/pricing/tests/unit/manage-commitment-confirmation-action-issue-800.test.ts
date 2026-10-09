import type {
  PricingCommitmentConfirmationIssued,
  PricingCommitmentConfirmationVerificationOutcome,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import type { DataAccessEventInput } from '@app/core-runtime';
import { DateTime, Effect, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import {
  handleManageCommitmentConfirmation,
  manageCommitmentConfirmationAction,
  ManageCommitmentConfirmationAuditEvidenceSchema,
  ManageCommitmentConfirmationPersistenceConflict,
  ManageCommitmentConfirmationPayloadSchema,
  ManageCommitmentConfirmationResultSchema,
} from '../../src/actions/manage-commitment-confirmation.action.ts';
import type {
  ManageCommitmentConfirmationActionServices,
  ManageCommitmentConfirmationPayload,
  ManageCommitmentConfirmationResult,
} from '../../src/actions/manage-commitment-confirmation.action.ts';
import { CommitmentConfirmationPersistenceUnavailable } from '../../src/services/commitment-confirmation-persistence.service.ts';
import { PricingCommitmentConfirmationRenewal } from '../../src/services/commitment-confirmation-renewal.service.ts';
import { PricingCommitmentConfirmationVerification } from '../../src/services/commitment-confirmation-verification.service.ts';
import { PricingCurrentBackedConfirmationIssuance } from '../../src/services/current-backed-confirmation-issuance.service.ts';
import { PricingQuotationBackedConfirmationIssuance } from '../../src/services/quotation-backed-confirmation-issuance.service.ts';
import { QuotationPersistenceUnavailable } from '../../src/services/quotation-persistence.service.ts';
import {
  issue788IssuedAt,
  makeIssue788Binding,
  makeIssue788CommercialTotal,
  makeIssue788CurrentConfirmation,
  makeIssue788IssuedConfirmation,
  makeIssue788Quotation,
  makeIssue788QuotationSource,
} from './support/issue-788-confirmation.fixture.ts';

const actionInvocationId = '80000000-0000-4000-8000-000000000001';
const actorPrincipalId = '80000000-0000-4000-8000-000000000002';
const legalEntityId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tenantId = '11111111-1111-4111-8111-111111111111';
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeAuditEvidence = Schema.decodeUnknownSync(ManageCommitmentConfirmationAuditEvidenceSchema, {
  onExcessProperty: 'error',
});

type ConfirmationAuditEvidence = typeof ManageCommitmentConfirmationAuditEvidenceSchema.Type;
type ManageCommitmentConfirmationContext = Parameters<typeof handleManageCommitmentConfirmation>[1];

const noIssue = () => Effect.die('unexpected issuance');
const noQuotationRead = () => Effect.die('unexpected Quotation read');
const noConfirmationRecovery = () => Effect.die('unexpected Confirmation recovery');
const noRenew = () => Effect.die('unexpected renewal');
const noVerify = () => Effect.die('unexpected verification');
const noStore = () => Effect.die('unexpected Confirmation persistence');

const services = (
  overrides: Partial<ManageCommitmentConfirmationActionServices>,
): ManageCommitmentConfirmationActionServices => ({
  issueCurrent: noIssue,
  issueQuotation: noIssue,
  readQuotation: noQuotationRead,
  recoverConfirmation: noConfirmationRecovery,
  renew: noRenew,
  store: noStore,
  verify: noVerify,
  ...overrides,
});

const provideProductionServices =
  (actionServices: ManageCommitmentConfirmationActionServices) =>
  <Value, Failure, Requirements>(effect: Effect.Effect<Value, Failure, Requirements>) =>
    effect.pipe(
      Effect.provideService(PricingCurrentBackedConfirmationIssuance, {
        issue: actionServices.issueCurrent,
      }),
      Effect.provideService(PricingQuotationBackedConfirmationIssuance, {
        issue: actionServices.issueQuotation,
      }),
      Effect.provideService(PricingCommitmentConfirmationRenewal, { renew: actionServices.renew }),
      Effect.provideService(PricingCommitmentConfirmationVerification, { verify: actionServices.verify }),
    );

const context = (
  actionServices: ManageCommitmentConfirmationActionServices,
  record: (evidence: ConfirmationAuditEvidence) => void,
  recordAccess?: (evidence: DataAccessEventInput) => void,
): ManageCommitmentConfirmationContext => ({
  actionInvocationId,
  addDomainEvent: () => Effect.die('unexpected domain event'),
  addOutboxMessage: () => Effect.die('unexpected outbox message'),
  compositionRevision: 'a'.repeat(64),
  recordAuditEvidence: (evidence) =>
    Effect.sync(() => {
      record(decodeAuditEvidence(evidence));
    }),
  recordDataAccess: (evidence) =>
    Effect.sync(() => {
      recordAccess?.(evidence);
    }),
  scope: {
    authBindingId: '80000000-0000-4000-8000-000000000003',
    authContextRef: 'session:pricing-confirmation',
    authMethod: 'session' as const,
    correlationId: 'pricing-confirmation-correlation:800',
    legalEntityId,
    principalId: actorPrincipalId,
    tenantId,
  },
  services: actionServices,
});

describe('issue #800 Pricing Commitment Confirmation Action audit', () => {
  it.effect('records exact Current-backed issuance lineage and the trusted human caller', () =>
    Effect.gen(function* currentIssuanceAudit() {
      const total = yield* makeIssue788CommercialTotal();
      const binding = makeIssue788Binding(total);
      const confirmation = makeIssue788CurrentConfirmation(total);
      let evidence: ConfirmationAuditEvidence | undefined;
      let accessEvidence: DataAccessEventInput | undefined;
      const payload = {
        binding,
        kind: 'ISSUE_CURRENT_BACKED_CONFIRMATION' as const,
        reason: 'Confirm the unchanged purchase before acceptance',
        schemaVersion: '1' as const,
      };

      const result = yield* handleManageCommitmentConfirmation(
        payload,
        context(
          services({
            issueCurrent: (received) => {
              expect(received).toEqual({ binding });
              return Effect.succeed({ _tag: 'ISSUED' as const, confirmation });
            },
            store: (received) => Effect.succeed({ confirmation: received, outcome: 'STORED' as const }),
          }),
          (recorded) => {
            evidence = recorded;
          },
          (recorded) => {
            accessEvidence = recorded;
          },
        ),
      );

      expect(result).toMatchObject({ kind: payload.kind, outcome: { _tag: 'ISSUED' } });
      expect(evidence).toMatchObject({
        attemptRef: binding.attemptRef,
        confirmationRef: confirmation.confirmationRef,
        decisionBundleHash: binding.decisionBundleHash,
        decisionBundleRef: binding.decisionBundleRef,
        decisionBundleVersion: binding.decisionBundleVersion,
        expiresAt: confirmation.expiresAt,
        issuedAt: confirmation.issuedAt,
        operation: payload.kind,
        outcome: 'ISSUED',
        reason: payload.reason,
        schemaVersion: '1',
        sourceKind: 'CURRENT_BACKED',
      });
      const encodedEvidence = yield* encodeJson(evidence);
      expect(encodedEvidence).not.toContain(confirmation.authenticity.proofRef);
      expect(encodedEvidence).not.toContain(confirmation.authenticity.payloadDigest);
      expect(accessEvidence).toMatchObject({
        accessKind: 'read',
        resultCount: 1,
        servingModuleKey: 'commerce.pricing',
      });
    }),
  );

  it.effect('records Quotation lineage and redacts an unverifiable source reason without persisting a proof', () =>
    Effect.gen(function* quotationRejectionAudit() {
      const total = yield* makeIssue788CommercialTotal();
      const binding = makeIssue788Binding(total);
      const quotation = makeIssue788Quotation(total);
      const source = makeIssue788QuotationSource(quotation);
      let evidence: ConfirmationAuditEvidence | undefined;
      let accessEvidence: DataAccessEventInput | undefined;
      const payload = {
        binding,
        kind: 'ISSUE_QUOTATION_BACKED_CONFIRMATION' as const,
        quotationRef: quotation.quotationRef,
        reason: 'Use the exact still-valid customer Quotation',
        schemaVersion: '1' as const,
      };

      const result = yield* handleManageCommitmentConfirmation(
        payload,
        context(
          services({
            issueQuotation: (candidate) => {
              expect(candidate).toMatchObject({
                binding,
                materialEvidence: source.materialEvidence,
                quotation,
                requestedBinding: binding.purchase,
              });
              return Effect.succeed({
                _tag: 'SOURCE_UNVERIFIABLE' as const,
                reason: 'provider-secret-token=must-never-enter-audit',
                retryable: true,
              });
            },
            readQuotation: (quotationRef) => {
              expect(quotationRef).toBe(quotation.quotationRef);
              return Effect.succeedSome(quotation);
            },
          }),
          (recorded) => {
            evidence = recorded;
          },
          (recorded) => {
            accessEvidence = recorded;
          },
        ),
      );

      expect(result).toMatchObject({
        kind: payload.kind,
        outcome: { _tag: 'SOURCE_UNVERIFIABLE', retryable: true },
      });
      expect(evidence).toMatchObject({
        attemptRef: binding.attemptRef,
        operation: payload.kind,
        outcome: 'SOURCE_UNVERIFIABLE',
        outcomeReason: 'DETAIL_REDACTED',
        quotationRef: quotation.quotationRef,
        retryable: true,
        sourceKind: 'QUOTATION_BACKED',
      });
      expect(evidence).not.toHaveProperty('confirmationRef');
      expect(yield* encodeJson(evidence)).not.toContain('provider-secret-token');
      expect(accessEvidence).toMatchObject({ accessKind: 'read', resultCount: 1 });
    }),
  );

  it.effect('records verification use with trusted operation time and separate effective time', () =>
    Effect.gen(function* verificationAudit() {
      const trustedOperationAt = '2026-10-01T12:00:00.000Z';
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(trustedOperationAt)));
      const total = yield* makeIssue788CommercialTotal();
      const quotation = makeIssue788Quotation(total);
      const confirmation = makeIssue788IssuedConfirmation(total, { quotation });
      const outcome: PricingCommitmentConfirmationVerificationOutcome = {
        _tag: 'AUTHENTICITY_UNVERIFIABLE',
        confirmationRef: confirmation.confirmationRef,
        reason: 'DEPENDENCY_UNAVAILABLE',
        retryable: true,
      };
      let evidence: ConfirmationAuditEvidence | undefined;
      const payload = {
        confirmationRef: confirmation.confirmationRef,
        kind: 'VERIFY_COMMITMENT_CONFIRMATION' as const,
        reason: 'Verify the proof selected for acceptance',
        requestedBinding: confirmation.binding,
        schemaVersion: '1' as const,
      };

      yield* handleManageCommitmentConfirmation(
        payload,
        context(
          services({
            recoverConfirmation: (confirmationRef) => {
              expect(confirmationRef).toBe(confirmation.confirmationRef);
              return Effect.succeed({ confirmation, outcome: 'FOUND' as const });
            },
            verify: (request) => {
              expect(request.attemptedAt).toBe(trustedOperationAt);
              expect(request.confirmation).toEqual(confirmation);
              return Effect.succeed(outcome);
            },
          }),
          (recorded) => {
            evidence = recorded;
          },
        ),
      );

      expect(evidence).toMatchObject({
        confirmationRef: confirmation.confirmationRef,
        effectiveAt: trustedOperationAt,
        operation: payload.kind,
        outcome: 'AUTHENTICITY_UNVERIFIABLE',
        outcomeReason: 'DEPENDENCY_UNAVAILABLE',
        quotationRef: quotation.quotationRef,
        retryable: true,
        sourceKind: 'QUOTATION_BACKED',
      });
      expect(evidence?.operationAt).toBe(trustedOperationAt);
    }),
  );

  it.effect('returns semantic absence and corruption outcomes only after authoritative owner reads', () =>
    Effect.gen(function* failClosedOwnerLoads() {
      const total = yield* makeIssue788CommercialTotal();
      const binding = makeIssue788Binding(total);
      const quotation = makeIssue788Quotation(total);
      const queryHashes: string[] = [];

      const runCase = Effect.fn('test.failClosedConfirmationOwnerLoad')(function* runFailClosedCase(input: {
        readonly expectedOutcome: Partial<ManageCommitmentConfirmationResult['outcome']>;
        readonly expectedOutcomeReason: string;
        readonly overrides: Partial<ManageCommitmentConfirmationActionServices>;
        readonly payload: ManageCommitmentConfirmationPayload;
      }) {
        let auditEvidence: ConfirmationAuditEvidence | undefined;
        let accessEvidence: DataAccessEventInput | undefined;
        const result = yield* handleManageCommitmentConfirmation(
          input.payload,
          context(
            services(input.overrides),
            (recorded) => {
              auditEvidence = recorded;
            },
            (recorded) => {
              accessEvidence = recorded;
            },
          ),
        );
        expect(result.outcome).toMatchObject(input.expectedOutcome);
        expect(auditEvidence).toMatchObject({ outcomeReason: input.expectedOutcomeReason });
        expect(accessEvidence).toMatchObject({ accessKind: 'read', resultCount: 0 });
        queryHashes.push(String(accessEvidence?.queryHash));
      });

      yield* runCase({
        expectedOutcome: { _tag: 'SOURCE_INVALID', reason: 'QUOTATION_NOT_FOUND', retryable: false },
        expectedOutcomeReason: 'QUOTATION_NOT_FOUND',
        overrides: { readQuotation: () => Effect.succeedNone },
        payload: {
          binding,
          kind: 'ISSUE_QUOTATION_BACKED_CONFIRMATION',
          quotationRef: `${quotation.quotationRef}:absent`,
          reason: 'Issue an owner-retained Quotation',
          schemaVersion: '1',
        },
      });
      for (const recoveryCase of [
        {
          confirmationRef: 'pricing-confirmation:800:absent',
          expectedOutcome: { _tag: 'AUTHENTICITY_UNVERIFIABLE', reason: 'MISSING_PROOF', retryable: false },
          expectedOutcomeReason: 'MISSING_PROOF',
          recoverConfirmation: () =>
            Effect.succeed({ confirmationRef: 'pricing-confirmation:800:absent', outcome: 'ABSENT' as const }),
        },
        {
          confirmationRef: 'pricing-confirmation:800:corrupt',
          expectedOutcome: { _tag: 'AUTHENTICITY_INVALID', reason: 'PAYLOAD_TAMPERED', retryable: false },
          expectedOutcomeReason: 'PAYLOAD_TAMPERED',
          recoverConfirmation: () =>
            Effect.succeed({
              confirmationRef: 'pricing-confirmation:800:corrupt',
              outcome: 'CORRUPT' as const,
              reason: 'PAYLOAD_INVALID' as const,
            }),
        },
      ] as const) {
        yield* runCase({
          expectedOutcome: recoveryCase.expectedOutcome,
          expectedOutcomeReason: recoveryCase.expectedOutcomeReason,
          overrides: { recoverConfirmation: recoveryCase.recoverConfirmation },
          payload: {
            confirmationRef: recoveryCase.confirmationRef,
            kind: 'VERIFY_COMMITMENT_CONFIRMATION',
            reason: 'Verify an owner-retained Confirmation',
            requestedBinding: binding,
            schemaVersion: '1',
          },
        });
      }

      expect(new Set(queryHashes).size).toBe(3);
    }),
  );

  it.effect('propagates owner persistence failures and immutable proof conflicts', () =>
    Effect.gen(function* persistenceFailureSemantics() {
      const total = yield* makeIssue788CommercialTotal();
      const binding = makeIssue788Binding(total);
      const quotation = makeIssue788Quotation(total);
      const confirmation = makeIssue788CurrentConfirmation(total);
      let recordedEvidence = 0;
      const failingContext = (actionServices: ManageCommitmentConfirmationActionServices) =>
        context(actionServices, () => {
          recordedEvidence += 1;
        });

      const quotationFailure = yield* handleManageCommitmentConfirmation(
        {
          binding,
          kind: 'ISSUE_QUOTATION_BACKED_CONFIRMATION',
          quotationRef: quotation.quotationRef,
          reason: 'Issue an owner-retained Quotation',
          schemaVersion: '1',
        },
        failingContext(
          services({
            readQuotation: () => Effect.fail(new QuotationPersistenceUnavailable({ reason: 'owner read unavailable' })),
          }),
        ),
      ).pipe(Effect.flip);
      expect(quotationFailure).toBeInstanceOf(QuotationPersistenceUnavailable);

      const confirmationFailure = yield* handleManageCommitmentConfirmation(
        {
          confirmationRef: confirmation.confirmationRef,
          kind: 'VERIFY_COMMITMENT_CONFIRMATION',
          reason: 'Verify an owner-retained Confirmation',
          requestedBinding: binding,
          schemaVersion: '1',
        },
        failingContext(
          services({
            recoverConfirmation: () =>
              Effect.fail(new CommitmentConfirmationPersistenceUnavailable({ reason: 'owner read unavailable' })),
          }),
        ),
      ).pipe(Effect.flip);
      expect(confirmationFailure).toBeInstanceOf(CommitmentConfirmationPersistenceUnavailable);

      const proofConflict = yield* handleManageCommitmentConfirmation(
        {
          binding,
          kind: 'ISSUE_CURRENT_BACKED_CONFIRMATION',
          reason: 'Issue an owner-retained Current proof',
          schemaVersion: '1',
        },
        failingContext(
          services({
            issueCurrent: () => Effect.succeed({ _tag: 'ISSUED', confirmation }),
            store: (storedConfirmation) =>
              Effect.succeed({
                confirmationRef: storedConfirmation.confirmationRef,
                outcome: 'IDENTITY_CONFLICT',
                reason: 'CONFIRMATION_OR_PROOF_IDENTITY_ALREADY_BOUND',
              }),
          }),
        ),
      ).pipe(Effect.flip);
      expect(proofConflict).toBeInstanceOf(ManageCommitmentConfirmationPersistenceConflict);
      expect(recordedEvidence).toBe(0);
    }),
  );

  it.effect('rolls back an unavailable owner read and retries the same open Action invocation', () =>
    Effect.gen(function* retryOpenInvocation() {
      const trustedRuntimeAt = '2026-09-28T12:00:01.000Z';
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(trustedRuntimeAt)));
      const total = yield* makeIssue788CommercialTotal();
      const binding = makeIssue788Binding(total);
      const quotation = makeIssue788Quotation(total);
      const confirmation = makeIssue788IssuedConfirmation(total, {
        confirmationRef: 'pricing-confirmation:800:retry',
        quotation,
      });
      let readAttempts = 0;
      let issuanceAttempts = 0;
      const actionServices = services({
        issueQuotation: () =>
          Effect.sync(() => {
            issuanceAttempts += 1;
            return { _tag: 'ISSUED' as const, confirmation };
          }),
        readQuotation: () =>
          Effect.suspend(() => {
            readAttempts += 1;
            return readAttempts === 1
              ? Effect.fail(new QuotationPersistenceUnavailable({ reason: 'owner read unavailable' }))
              : Effect.succeedSome(quotation);
          }),
        store: (storedConfirmation) => Effect.succeed({ confirmation: storedConfirmation, outcome: 'STORED' as const }),
      });
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        legalEntityAccess: 'allowed',
        legalEntityPermission: 'allowed',
        services: [bindActionTestServices(manageCommitmentConfirmationAction, actionServices)],
      });
      const principal = {
        authBindingId: '80000000-0000-4000-8000-000000000010',
        authContextRef: 'api-key:pricing-confirmation-worker',
        authMethod: 'api_key' as const,
        legalEntityId,
        principalId: actorPrincipalId,
        tenantId,
      };
      const request = {
        payload: {
          binding,
          kind: 'ISSUE_QUOTATION_BACKED_CONFIRMATION' as const,
          quotationRef: quotation.quotationRef,
          reason: 'Issue the exact accepted customer Quotation proof',
          schemaVersion: '1' as const,
        },
        principal,
        registration: manageCommitmentConfirmationAction,
        transport: {
          correlationId: 'pricing-confirmation-runtime:retry',
          idempotencyKey: 'pricing-confirmation-runtime:retry:same-invocation',
        },
      };
      const provideActionServices = provideProductionServices(actionServices);

      const firstFailure = yield* provideActionServices(harness.runtime.runAction(request)).pipe(Effect.flip);
      expect(firstFailure).toBeInstanceOf(QuotationPersistenceUnavailable);
      const openSnapshot = harness.snapshot();
      const originalInvocationId = openSnapshot.invocations[0]?.actionInvocationId;
      expect(openSnapshot.invocations).toHaveLength(1);
      expect(openSnapshot.invocations[0]?.status).toBe('running');
      expect(openSnapshot.committed).toHaveLength(0);
      expect(openSnapshot.transactionCount).toBe(1);

      const retryResult = yield* provideActionServices(harness.runtime.runAction(request));
      expect(retryResult).toMatchObject({ kind: request.payload.kind, outcome: { _tag: 'ISSUED' } });
      const committedSnapshot = harness.snapshot();
      expect(committedSnapshot.invocations).toHaveLength(1);
      expect(committedSnapshot.invocations[0]?.actionInvocationId).toBe(originalInvocationId);
      expect(committedSnapshot.invocations[0]?.status).toBe('succeeded');
      expect(committedSnapshot.committed).toHaveLength(1);
      expect(committedSnapshot.transactionCount).toBe(2);
      expect(readAttempts).toBe(2);
      expect(issuanceAttempts).toBe(1);
    }),
  );

  it.effect('records previous/new identity and source lineage for both renewal paths', () =>
    Effect.gen(function* renewalAudit() {
      const total = yield* makeIssue788CommercialTotal();
      const currentPrevious = makeIssue788CurrentConfirmation(total, {
        confirmationRef: 'pricing-confirmation:800:current:previous',
      });
      const currentNew = makeIssue788CurrentConfirmation(total, {
        confirmationRef: 'pricing-confirmation:800:current:new',
      });
      const quotationPrevious = makeIssue788IssuedConfirmation(total, {
        confirmationRef: 'pricing-confirmation:800:quotation:previous',
      });
      const quotationNew = makeIssue788IssuedConfirmation(total, {
        confirmationRef: 'pricing-confirmation:800:quotation:new',
      });

      for (const [previous, renewed] of [
        [currentPrevious, currentNew],
        [quotationPrevious, quotationNew],
      ] as const satisfies readonly (readonly [
        PricingCommitmentConfirmationIssued,
        PricingCommitmentConfirmationIssued,
      ])[]) {
        let evidence: ConfirmationAuditEvidence | undefined;
        const payload = {
          binding: previous.binding,
          confirmationRef: previous.confirmationRef,
          kind: 'RENEW_COMMITMENT_CONFIRMATION' as const,
          reason: 'Renew the unchanged accepted purchase proof',
          schemaVersion: '1' as const,
        };
        yield* handleManageCommitmentConfirmation(
          payload,
          context(
            services({
              recoverConfirmation: (confirmationRef) => {
                expect(confirmationRef).toBe(previous.confirmationRef);
                return Effect.succeed({ confirmation: previous, outcome: 'FOUND' as const });
              },
              renew: () =>
                Effect.succeed({
                  _tag: 'RENEWED' as const,
                  confirmation: renewed,
                  previousConfirmationRef: previous.confirmationRef,
                }),
              store: (confirmation) => Effect.succeed({ confirmation, outcome: 'STORED' as const }),
            }),
            (recorded) => {
              evidence = recorded;
            },
          ),
        );

        expect(evidence).toMatchObject({
          confirmationRef: renewed.confirmationRef,
          operation: payload.kind,
          outcome: 'RENEWED',
          previousConfirmationRef: previous.confirmationRef,
          sourceKind: previous.source.kind,
        });
        if (previous.source.kind === 'QUOTATION_BACKED') {
          expect(evidence).toMatchObject({
            quotationRef: previous.source.quotationRevalidation.quotation.quotationRef,
          });
        } else {
          expect(evidence).not.toHaveProperty('quotationRef');
        }
      }
    }),
  );

  it.effect('persists standard Action evidence for successful Quotation issuance and Current verification', () =>
    Effect.gen(function* realActionRuntime() {
      const trustedRuntimeAt = '2026-09-28T12:00:01.000Z';
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(trustedRuntimeAt)));
      const total = yield* makeIssue788CommercialTotal();
      const binding = makeIssue788Binding(total);
      const quotation = makeIssue788Quotation(total);
      const quotationConfirmation = makeIssue788IssuedConfirmation(total, {
        confirmationRef: 'pricing-confirmation:800:quotation:runtime',
        quotation,
      });
      const currentConfirmation = makeIssue788CurrentConfirmation(total, {
        confirmationRef: 'pricing-confirmation:800:current:runtime',
      });
      const actionServices = services({
        issueQuotation: () => Effect.succeed({ _tag: 'ISSUED', confirmation: quotationConfirmation }),
        readQuotation: (quotationRef) =>
          Effect.succeed(quotationRef === quotation.quotationRef ? Option.some(quotation) : Option.none()),
        recoverConfirmation: (confirmationRef) =>
          Effect.succeed(
            confirmationRef === currentConfirmation.confirmationRef
              ? { confirmation: currentConfirmation, outcome: 'FOUND' as const }
              : { confirmationRef, outcome: 'ABSENT' as const },
          ),
        store: (confirmation) => Effect.succeed({ confirmation, outcome: 'STORED' }),
        verify: () =>
          Effect.succeed({
            _tag: 'VERIFIED',
            authenticityEvidence: {
              authenticityRef: `pricing-confirmation-authenticity:${currentConfirmation.confirmationRef}`,
              confirmationRef: currentConfirmation.confirmationRef,
              issuerRef: currentConfirmation.authenticity.issuerRef,
              keyRef: currentConfirmation.authenticity.keyRef,
              keyStatus: 'ACTIVE',
              keyVersion: currentConfirmation.authenticity.keyVersion,
              lineageRef: currentConfirmation.authenticity.lineageRef,
              payloadDigest: currentConfirmation.authenticity.payloadDigest,
              proofRef: currentConfirmation.authenticity.proofRef,
              proofVersion: currentConfirmation.authenticity.proofVersion,
              verifiedAt: issue788IssuedAt,
            },
            confirmation: currentConfirmation,
            verifiedAt: issue788IssuedAt,
          }),
      });
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        legalEntityAccess: 'allowed',
        legalEntityPermission: 'allowed',
        services: [bindActionTestServices(manageCommitmentConfirmationAction, actionServices)],
      });
      const principal = {
        authBindingId: '80000000-0000-4000-8000-000000000010',
        authContextRef: 'api-key:pricing-confirmation-worker',
        authMethod: 'api_key' as const,
        legalEntityId,
        principalId: actorPrincipalId,
        tenantId,
      };

      const provideActionServices = provideProductionServices(actionServices);

      yield* provideActionServices(
        harness.runtime.runAction({
          payload: {
            binding,
            kind: 'ISSUE_QUOTATION_BACKED_CONFIRMATION',
            quotationRef: quotation.quotationRef,
            reason: 'Issue the exact accepted customer Quotation proof',
            schemaVersion: '1',
          },
          principal,
          registration: manageCommitmentConfirmationAction,
          transport: {
            correlationId: 'pricing-confirmation-runtime:quotation',
            idempotencyKey: 'pricing-confirmation-runtime:quotation:once',
          },
        }),
      );
      yield* provideActionServices(
        harness.runtime.runAction({
          payload: {
            confirmationRef: currentConfirmation.confirmationRef,
            kind: 'VERIFY_COMMITMENT_CONFIRMATION',
            reason: 'Use the exact Current-backed proof at acceptance',
            requestedBinding: binding,
            schemaVersion: '1',
          },
          principal,
          registration: manageCommitmentConfirmationAction,
          transport: {
            correlationId: 'pricing-confirmation-runtime:current-verification',
            idempotencyKey: 'pricing-confirmation-runtime:current-verification:once',
          },
        }),
      );

      const { committed } = harness.snapshot();
      expect(committed).toHaveLength(2);
      expect(committed.map(({ auditProfile }) => auditProfile)).toEqual(['standard', 'standard']);
      expect(committed.map(({ principal: committedPrincipal }) => committedPrincipal)).toEqual([principal, principal]);
      expect(committed.map(({ transport }) => transport.correlationId)).toEqual([
        'pricing-confirmation-runtime:quotation',
        'pricing-confirmation-runtime:current-verification',
      ]);
      expect(committed.map(({ evidence }) => evidence.dataAccessEvents.length)).toEqual([1, 1]);
      expect(committed[0]?.evidence.auditEvidence).toMatchObject({
        confirmationRef: quotationConfirmation.confirmationRef,
        outcome: 'ISSUED',
        quotationRef: quotation.quotationRef,
        sourceKind: 'QUOTATION_BACKED',
      });
      expect(committed[1]?.evidence.auditEvidence).toMatchObject({
        confirmationRef: currentConfirmation.confirmationRef,
        effectiveAt: trustedRuntimeAt,
        outcome: 'VERIFIED',
        sourceKind: 'CURRENT_BACKED',
      });
      for (const { evidence } of committed) {
        const encodedAuditEvidence = yield* encodeJson(evidence.auditEvidence);
        expect(new TextEncoder().encode(encodedAuditEvidence).byteLength).toBeLessThan(4096);
      }
    }),
  );

  it.effect('decodes exactly the versioned contract for all four operations', () =>
    Effect.gen(function* versionedContract() {
      const total = yield* makeIssue788CommercialTotal();
      const binding = makeIssue788Binding(total);
      const confirmation = makeIssue788IssuedConfirmation(total);
      const source = makeIssue788QuotationSource(makeIssue788Quotation(total));
      const decode = Schema.decodeUnknownEffect(ManageCommitmentConfirmationPayloadSchema, {
        onExcessProperty: 'error',
      });
      const decodeEach = Effect.forEach;
      const inputs: readonly unknown[] = [
        {
          binding,
          kind: 'ISSUE_CURRENT_BACKED_CONFIRMATION',
          reason: 'Current issuance',
          schemaVersion: '1',
        },
        {
          binding,
          kind: 'ISSUE_QUOTATION_BACKED_CONFIRMATION',
          quotationRef: source.quotationRevalidation.quotation.quotationRef,
          reason: 'Quotation issuance',
          schemaVersion: '1',
        },
        {
          confirmationRef: confirmation.confirmationRef,
          kind: 'VERIFY_COMMITMENT_CONFIRMATION',
          reason: 'Confirmation use',
          requestedBinding: binding,
          schemaVersion: '1',
        },
        {
          binding,
          confirmationRef: confirmation.confirmationRef,
          kind: 'RENEW_COMMITMENT_CONFIRMATION',
          reason: 'Confirmation renewal',
          schemaVersion: '1',
        },
      ];

      const decodedInputs = yield* decodeEach(inputs, (input) => decode(input));
      expect(decodedInputs.map(({ kind }) => kind)).toEqual([
        'ISSUE_CURRENT_BACKED_CONFIRMATION',
        'ISSUE_QUOTATION_BACKED_CONFIRMATION',
        'VERIFY_COMMITMENT_CONFIRMATION',
        'RENEW_COMMITMENT_CONFIRMATION',
      ]);
      yield* decode({
        binding,
        kind: 'ISSUE_CURRENT_BACKED_CONFIRMATION',
        reason: 'Current issuance',
        schemaVersion: '2',
      }).pipe(Effect.flip);
      const decodeResult = Schema.decodeUnknownEffect(ManageCommitmentConfirmationResultSchema, {
        onExcessProperty: 'error',
      });
      yield* decodeResult({
        kind: 'ISSUE_CURRENT_BACKED_CONFIRMATION',
        outcome: { _tag: 'ISSUED' },
      }).pipe(Effect.flip);
      yield* decodeResult({
        kind: 'VERIFY_COMMITMENT_CONFIRMATION',
        outcome: {
          _tag: 'VERIFIED',
          confirmationRef: confirmation.confirmationRef,
          retryable: false,
        },
      }).pipe(Effect.flip);
    }),
  );
});
