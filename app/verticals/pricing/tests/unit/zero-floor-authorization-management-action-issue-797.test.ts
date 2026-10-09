import type { PricingZeroFloorAuthorization } from '@app/pricing-contracts/domain/line-composition';
import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { mapManageZeroFloorAuthorizationActionProblem } from '../../api/manage-zero-floor-authorization-action-problems.ts';
import {
  ManageZeroFloorAuthorizationAcknowledgementRequired,
  ManageZeroFloorAuthorizationConflict,
  ManageZeroFloorAuthorizationPayloadSchema,
  ManageZeroFloorAuthorizationRejected,
  applyZeroFloorAuthorizationManagement,
  manageZeroFloorAuthorizationAction,
} from '../../src/actions/manage-zero-floor-authorization.action.ts';
import type {
  ManageZeroFloorAuthorizationActionServices,
  ManageZeroFloorAuthorizationTrustedContext,
} from '../../src/actions/manage-zero-floor-authorization.action.ts';
import type { ZeroFloorAuthorizationGovernanceProof } from '../../src/services/zero-floor-authorization-persistence.service.ts';
import { composePricingRawLines } from '../../src/services/line-value-composition.service.ts';
import { authorizationSetFor, firstRawLine, makeIssue779Scenario } from './support/issue-779-line-value.fixture.ts';

const decodePayload = Schema.decodeUnknownSync(ManageZeroFloorAuthorizationPayloadSchema, {
  onExcessProperty: 'error',
});

const actionFixture = Effect.fn('test.zeroFloorAuthorizationManagementActionFixture')(
  function* zeroFloorAuthorizationManagementActionFixture() {
    const pricing = yield* makeIssue779Scenario({ discounts: ['40', '40', '40'] });
    const composition = yield* composePricingRawLines(pricing.compositionRequest);
    if (composition.outcome !== 'RAW_COMPOSITION_READY') {
      return yield* Effect.die('Expected raw composition fixture');
    }
    const authorizationSet = authorizationSetFor(firstRawLine(composition.lines));
    const [authorization] = authorizationSet.authorizations;
    if (authorization === undefined) {
      return yield* Effect.die('Expected ZERO_FLOOR Authorization fixture');
    }
    const governanceProof: ZeroFloorAuthorizationGovernanceProof = {
      approvalEvidence: {
        approvalEvidenceRef: authorization.governanceEvidence.approvalEvidenceRef,
        approvalRevision: 'zero-floor-governance-approval:r797',
        approvedAt: authorizationSet.currentness.evaluatedAt,
        approvedByPrincipalRef: authorization.governanceEvidence.approvedByPrincipalRef,
        approvedEffectivePeriod: authorization.effectivePeriod,
        authorityRef: 'zero-floor-governance-authority:797',
        authorization,
        authorizationFingerprint: 'a'.repeat(64),
        sellingLegalEntityId: authorization.businessScope.commercialScope.sellingLegalEntityId,
        tenantId: authorization.businessScope.tenantId,
        validityPeriod: { endsAt: '2027-01-01T00:00:00.000Z', startsAt: '2026-09-01T00:00:00.000Z' },
      },
      authorization,
      completenessEvidence: authorizationSet.completenessEvidence,
      currentness: authorizationSet.currentness,
      exactPredicateRef: authorizationSet.exactPredicateRef,
      ownerRevision: authorizationSet.ownerRevision,
    };
    const trusted: ManageZeroFloorAuthorizationTrustedContext = {
      actingPrincipalId: 'pricing-governance-principal',
      actionInvocationId: 'action-invocation:zero-floor:797',
      legalEntityId: authorization.businessScope.commercialScope.sellingLegalEntityId,
      requestCorrelationId: 'correlation:zero-floor:797',
      tenantId: authorization.businessScope.tenantId,
      trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(authorizationSet.currentness.evaluatedAt)),
    };
    return { authorization, governanceProof, trusted };
  },
);

const createdRevision = (authorization: PricingZeroFloorAuthorization) => ({
  authorization,
  lineage: {
    rootAuthorizationRef: authorization.authorizationRef,
    transition: 'CREATED' as const,
  },
  recordedAt: authorization.effectivePeriod.startsAt,
  revisionNumber: 1,
  scheduleRevision: 1,
  scheduleState: 'SCHEDULED' as const,
});

describe('ZERO_FLOOR Authorization management Action issue #797', () => {
  it.effect('publishes the generated Action and creates only with owner-issued fresh governance proof', () =>
    Effect.gen(function* createsWithProof() {
      const { authorization, governanceProof, trusted } = yield* actionFixture();
      const payload = decodePayload({
        authorization,
        expectedSetGeneration: 7,
        intent: 'CREATE',
        reason: 'Approve the exact bounded ZERO_FLOOR scope',
      });
      let proofReads = 0;
      let observedCommand: unknown;
      const services: ManageZeroFloorAuthorizationActionServices = {
        create: (command) => {
          observedCommand = command;
          return Effect.succeed({
            outcome: 'ZERO_FLOOR_AUTHORIZATION_CREATED',
            revision: createdRevision(authorization),
            setGeneration: 8,
          });
        },
        manage: () => Effect.die('CREATE must not use management persistence'),
        readGovernanceProof: () => {
          proofReads += 1;
          return Effect.succeed(governanceProof);
        },
      };

      expect(manageZeroFloorAuthorizationAction.descriptor).toMatchObject({
        actionKey: 'commerce.pricing.manage-zero-floor-authorization',
        idempotency: 'required',
        legalEntityScope: 'required',
        payloadSchema: ManageZeroFloorAuthorizationPayloadSchema,
      });
      expect(yield* applyZeroFloorAuthorizationManagement(payload, trusted, services)).toMatchObject({
        outcome: 'ZERO_FLOOR_AUTHORIZATION_CREATED',
        setGeneration: 8,
      });
      expect(proofReads).toBe(1);
      expect(observedCommand).toMatchObject({
        authorization,
        expectedSetGeneration: 7,
        governanceProof,
        trustedOperationAt: governanceProof.currentness.evaluatedAt,
      });
      expect(() => decodePayload({ ...payload, storefrontId: 'storefront-must-not-be-pricing-identity' })).toThrow();
      expect(() => decodePayload({ ...payload, tenantApproval: true })).toThrow();
    }),
  );

  it.effect('rejects cross-scope and EUR activation before owner proof or persistence', () =>
    Effect.gen(function* rejectsBeforeDependencies() {
      const { authorization, governanceProof, trusted } = yield* actionFixture();
      let calls = 0;
      const services: ManageZeroFloorAuthorizationActionServices = {
        create: () => {
          calls += 1;
          return Effect.die('Rejected commands must not reach create persistence');
        },
        manage: () => {
          calls += 1;
          return Effect.die('Rejected commands must not reach management persistence');
        },
        readGovernanceProof: () => {
          calls += 1;
          return Effect.succeed(governanceProof);
        },
      };
      const payload = decodePayload({
        authorization,
        expectedSetGeneration: 7,
        intent: 'CREATE',
        reason: 'Reject untrusted scope before owner calls',
      });
      const scopeFailure = yield* applyZeroFloorAuthorizationManagement(
        payload,
        { ...trusted, tenantId: 'other-tenant' },
        services,
      ).pipe(Effect.flip);
      const currencyFailure = yield* applyZeroFloorAuthorizationManagement(
        decodePayload({ ...payload, authorization: { ...authorization, currencyCode: 'EUR' } }),
        trusted,
        services,
      ).pipe(Effect.flip);

      expect(scopeFailure).toBeInstanceOf(ManageZeroFloorAuthorizationRejected);
      expect(scopeFailure).toMatchObject({ code: 'manage_zero_floor_authorization_scope_mismatch' });
      expect(currencyFailure).toMatchObject({ code: 'manage_zero_floor_authorization_currency_not_enabled' });
      expect(calls).toBe(0);
      expect(mapManageZeroFloorAuthorizationActionProblem(scopeFailure)).toMatchObject({ status: 403 });
      expect(mapManageZeroFloorAuthorizationActionProblem(currencyFailure)).toMatchObject({ status: 422 });
    }),
  );

  it.effect('ends the exact expected Current revision without inventing a new approval proof', () =>
    Effect.gen(function* endsExactCurrent() {
      const { authorization, trusted } = yield* actionFixture();
      const effectiveTo = trusted.trustedOperationAt.toISOString();
      const payload = decodePayload({
        authorization,
        authorizationRef: authorization.authorizationRef,
        effectiveTo,
        expectedCurrent: {
          authorizationRef: authorization.authorizationRef,
          authorizationRevision: authorization.authorizationRevision,
          effectivePeriod: authorization.effectivePeriod,
          scheduleRevision: 1,
        },
        expectedSetGeneration: 7,
        intent: 'END_CURRENT',
        reason: 'End the exact Current Authorization',
      });
      let observedCommand: unknown;
      const result = yield* applyZeroFloorAuthorizationManagement(payload, trusted, {
        create: () => Effect.die('END_CURRENT must not create'),
        manage: (command) => {
          observedCommand = command;
          return Effect.succeed({
            outcome: 'ZERO_FLOOR_AUTHORIZATION_ENDED',
            schedule: {
              authorizationRef: authorization.authorizationRef,
              revisions: [
                {
                  ...createdRevision({
                    ...authorization,
                    effectivePeriod: { ...authorization.effectivePeriod, endsAt: effectiveTo },
                  }),
                  scheduleRevision: 2,
                },
              ],
              scheduleRevision: 2,
              tenantId: authorization.businessScope.tenantId,
            },
            setGeneration: 8,
          });
        },
        readGovernanceProof: () => Effect.die('END_CURRENT must not read a replacement approval proof'),
      });

      expect(result).toMatchObject({ outcome: 'ZERO_FLOOR_AUTHORIZATION_ENDED', setGeneration: 8 });
      expect(observedCommand).toMatchObject({
        authorizationRef: authorization.authorizationRef,
        effectiveTo,
        expectedSetGeneration: 7,
        intent: 'END_CURRENT',
      });
    }),
  );

  it.effect('rejects a submitted acknowledgement without the presented future schedule', () =>
    Effect.gen(function* rejectsIncompleteAcknowledgement() {
      const { authorization, trusted } = yield* actionFixture();
      const expectedCurrent = {
        authorizationRef: authorization.authorizationRef,
        authorizationRevision: authorization.authorizationRevision,
        effectivePeriod: authorization.effectivePeriod,
        scheduleRevision: 1,
      };
      const successor = {
        ...authorization,
        authorizationRevision: 'zero-floor-auth-r797-successor',
        effectivePeriod: { ...authorization.effectivePeriod, startsAt: trusted.trustedOperationAt.toISOString() },
      };
      const acknowledgement = {
        actingPrincipalId: trusted.actingPrincipalId,
        authorizationRef: authorization.authorizationRef,
        expectedCurrent,
        expectedSetGeneration: 7,
        fingerprint: 'a'.repeat(64),
        intent: 'SUCCESSOR' as const,
        issuedAt: trusted.trustedOperationAt.toISOString(),
        presentedSchedule: {
          authorizationRef: authorization.authorizationRef,
          revisions: [createdRevision(authorization)],
          scheduleRevision: 1,
          tenantId: authorization.businessScope.tenantId,
        },
        presentedScheduleFingerprint: 'b'.repeat(64),
        proposedAuthorization: successor,
        proposedPayloadFingerprint: 'c'.repeat(64),
        tenantId: trusted.tenantId,
        validUntil: '2026-09-28T13:00:00.000Z',
      };
      const payload = decodePayload({
        acknowledgement,
        authorization: successor,
        expectedCurrent,
        expectedSetGeneration: 7,
        intent: 'SUCCESSOR',
        reason: 'Keep a future schedule only after it was presented',
      });
      let calls = 0;
      const failure = yield* applyZeroFloorAuthorizationManagement(payload, trusted, {
        create: () => {
          calls += 1;
          return Effect.die('Must not create');
        },
        manage: () => {
          calls += 1;
          return Effect.die('Must not manage');
        },
        readGovernanceProof: () => {
          calls += 1;
          return Effect.die('Must not read governance proof');
        },
      }).pipe(Effect.flip);
      expect(failure).toMatchObject({ code: 'manage_zero_floor_authorization_acknowledgement_mismatch' });
      expect(calls).toBe(0);
      const requiredProblem = mapManageZeroFloorAuthorizationActionProblem(
        new ManageZeroFloorAuthorizationAcknowledgementRequired({
          acknowledgement,
          code: 'zero_floor_authorization_schedule_acknowledgement_required',
          reason: 'Review the exact future schedule',
        }),
      );
      expect(requiredProblem).toMatchObject({
        acknowledgement,
        code: 'zero_floor_authorization_schedule_acknowledgement_required',
        status: 422,
      });
    }),
  );

  it('maps owner conflicts and unavailable evidence to stable HTTP statuses', () => {
    const conflict = new ManageZeroFloorAuthorizationConflict({
      code: 'manage_zero_floor_authorization_conflict',
      reason: 'EXPECTED_GENERATION_STALE',
    });
    expect(mapManageZeroFloorAuthorizationActionProblem(conflict)).toMatchObject({
      code: 'manage_zero_floor_authorization_conflict',
      status: 409,
    });
    expect(
      mapManageZeroFloorAuthorizationActionProblem(
        new ManageZeroFloorAuthorizationConflict({
          code: 'manage_zero_floor_authorization_conflict',
          reason: 'ACKNOWLEDGEMENT_STALE',
        }),
      ),
    ).toMatchObject({
      code: 'manage_zero_floor_authorization_conflict',
      reason: 'ACKNOWLEDGEMENT_STALE',
      status: 409,
    });
  });
});
