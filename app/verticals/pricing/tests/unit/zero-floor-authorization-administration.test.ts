import type {
  PricingZeroFloorAuthorization,
  PricingZeroFloorCurrentAuthorizationSet,
} from '@app/pricing-contracts/domain/line-composition';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { composePricingRawLines } from '../../src/services/line-value-composition.service.ts';
import { makeZeroFloorAuthorizationAdministration } from '../../src/services/zero-floor-authorization-administration.service.ts';
import type {
  ExpectedZeroFloorAuthorizationCurrent,
  ManagedZeroFloorAuthorizationRevision,
  ZeroFloorAuthorizationGovernanceProof,
  ZeroFloorAuthorizationPersistence,
  ZeroFloorAuthorizationScheduleAcknowledgement,
  ZeroFloorAuthorizationScheduleSnapshot,
} from '../../src/services/zero-floor-authorization-persistence.service.ts';
import { ZeroFloorAuthorizationPersistenceUnavailable } from '../../src/services/zero-floor-authorization-persistence.service.ts';
import { authorizationSetFor, firstRawLine, makeIssue779Scenario } from './support/issue-779-line-value.fixture.ts';

const now = '2026-09-28T12:00:00.000Z';

const fixture = Effect.fn('test.zeroFloorGovernanceFixture')(function* zeroFloorGovernanceFixture() {
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
  return { authorization, authorizationSet };
});

const managedRevision = (
  authorization: PricingZeroFloorAuthorization,
  overrides?: Partial<ManagedZeroFloorAuthorizationRevision>,
): ManagedZeroFloorAuthorizationRevision => ({
  authorization,
  lineage: {
    rootAuthorizationRef: authorization.authorizationRef,
    transition: 'CREATED',
  },
  recordedAt: '2026-09-28T10:00:00.000Z',
  revisionNumber: 1,
  scheduleRevision: 1,
  scheduleState: 'SCHEDULED',
  ...overrides,
});

const expectedCurrent = (authorization: PricingZeroFloorAuthorization): ExpectedZeroFloorAuthorizationCurrent => ({
  authorizationRef: authorization.authorizationRef,
  authorizationRevision: authorization.authorizationRevision,
  effectivePeriod: authorization.effectivePeriod,
  scheduleRevision: 1,
});

const governanceProof = (
  authorization: PricingZeroFloorAuthorization,
  authorizationSet: PricingZeroFloorCurrentAuthorizationSet,
): ZeroFloorAuthorizationGovernanceProof => ({
  approvalEvidence: {
    approvalEvidenceRef: authorization.governanceEvidence.approvalEvidenceRef,
    approvalRevision: 'zero-floor-governance-approval:r797',
    approvedAt: '2026-09-28T10:00:00.000Z',
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
});

const schedule = (
  authorization: PricingZeroFloorAuthorization,
  revisions: readonly ManagedZeroFloorAuthorizationRevision[],
  scheduleRevision: number,
): ZeroFloorAuthorizationScheduleSnapshot => ({
  authorizationRef: authorization.authorizationRef,
  revisions,
  scheduleRevision,
  tenantId: authorization.businessScope.tenantId,
});

const unexpected = <A>(name: string): Effect.Effect<A, ZeroFloorAuthorizationPersistenceUnavailable> =>
  Effect.fail(new ZeroFloorAuthorizationPersistenceUnavailable({ reason: `Unexpected ${name}` }));

const persistenceWith = (overrides: Partial<ZeroFloorAuthorizationPersistence>): ZeroFloorAuthorizationPersistence => ({
  create: () => unexpected('create'),
  lookupResult: () => unexpected('lookupResult'),
  manage: () => unexpected('manage'),
  readCurrentSet: () => unexpected('readCurrentSet'),
  readGovernanceProof: () => unexpected('readGovernanceProof'),
  readSchedule: () => unexpected('readSchedule'),
  verifyGeneration: () => unexpected('verifyGeneration'),
  ...overrides,
});

describe('ZERO_FLOOR Authorization administration #797', () => {
  it.effect('accepts the generation advance only for a newly recorded independent approval', () =>
    Effect.gen(function* verifiesApprovalGeneration() {
      const { authorization, authorizationSet } = yield* fixture();
      const { approvalEvidence } = governanceProof(authorization, authorizationSet);
      const command = {
        actingPrincipalId: authorization.governanceEvidence.approvedByPrincipalRef,
        actionInvocationId: 'action-invocation:zero-floor:approve',
        approvalRevision: approvalEvidence.approvalRevision,
        authorization,
        expectedSetGeneration: 7,
        intent: 'APPROVE' as const,
        reason: 'Record independent bounded governance authority',
        requestCorrelationId: 'correlation:zero-floor:approve',
        trustedOperationAt: now,
        validityPeriod: approvalEvidence.validityPeriod,
      };
      const recorded = makeZeroFloorAuthorizationAdministration(
        persistenceWith({
          manage: () =>
            Effect.succeed({
              approvalEvidence,
              outcome: 'ZERO_FLOOR_GOVERNANCE_APPROVAL_RECORDED',
              setGeneration: 8,
            }),
        }),
      );
      expect(yield* recorded.manage(command)).toMatchObject({
        outcome: 'ZERO_FLOOR_GOVERNANCE_APPROVAL_RECORDED',
        setGeneration: 8,
      });

      const reused = makeZeroFloorAuthorizationAdministration(
        persistenceWith({
          manage: () =>
            Effect.succeed({
              approvalEvidence,
              outcome: 'ZERO_FLOOR_GOVERNANCE_APPROVAL_REUSED',
              setGeneration: 7,
            }),
        }),
      );
      expect(yield* reused.manage(command)).toMatchObject({
        outcome: 'ZERO_FLOOR_GOVERNANCE_APPROVAL_REUSED',
        setGeneration: 7,
      });
    }),
  );

  it.effect('reuses approval authority only inside its approved meaning and effective period', () =>
    Effect.gen(function* verifiesBoundedReuse() {
      const { authorization, authorizationSet } = yield* fixture();
      const approvedAuthorization: PricingZeroFloorAuthorization = {
        ...authorization,
        effectivePeriod: {
          endsAt: '2026-10-01T00:00:00.000Z',
          startsAt: '2026-09-01T00:00:00.000Z',
        },
      };
      const proposedAuthorization: PricingZeroFloorAuthorization = {
        ...approvedAuthorization,
        authorizationRevision: `${approvedAuthorization.authorizationRevision}:successor`,
        effectivePeriod: {
          endsAt: '2026-09-30T00:00:00.000Z',
          startsAt: now,
        },
      };
      const proof = {
        ...governanceProof(approvedAuthorization, authorizationSet),
        authorization: proposedAuthorization,
      };
      let createCalls = 0;
      const administration = makeZeroFloorAuthorizationAdministration(
        persistenceWith({
          create: () => {
            createCalls += 1;
            return Effect.succeed({
              outcome: 'ZERO_FLOOR_AUTHORIZATION_CREATED',
              revision: managedRevision(proposedAuthorization),
              setGeneration: 8,
            });
          },
        }),
      );
      const command = {
        actingPrincipalId: 'pricing-governance-principal',
        actionInvocationId: 'action-invocation:zero-floor:bounded-reuse',
        authorization: proposedAuthorization,
        expectedSetGeneration: 7,
        governanceProof: proof,
        reason: 'Reuse only the separately approved bounded authority',
        requestCorrelationId: 'correlation:zero-floor:bounded-reuse',
        trustedOperationAt: now,
      };
      expect(yield* administration.create(command)).toMatchObject({
        outcome: 'ZERO_FLOOR_AUTHORIZATION_CREATED',
      });

      const expandedAuthorization: PricingZeroFloorAuthorization = {
        ...proposedAuthorization,
        economicCoverage: {
          ...proposedAuthorization.economicCoverage,
          maximumFloorAdjustment: '999',
        },
      };
      expect(
        Schema.is(ZeroFloorAuthorizationPersistenceUnavailable)(
          yield* Effect.flip(
            administration.create({
              ...command,
              authorization: expandedAuthorization,
              governanceProof: { ...proof, authorization: expandedAuthorization },
            }),
          ),
        ),
      ).toBe(true);
      expect(createCalls).toBe(1);
    }),
  );

  it.effect('preserves exact bounded scope, governance evidence, and expected generation on create/replay', () =>
    Effect.gen(function* verifiesCreate() {
      const { authorization, authorizationSet } = yield* fixture();
      const command = {
        actingPrincipalId: 'pricing-governance-principal',
        actionInvocationId: 'action-invocation:zero-floor:create',
        authorization,
        expectedSetGeneration: 7,
        governanceProof: governanceProof(authorization, authorizationSet),
        reason: 'Approve a bounded negative configuration',
        requestCorrelationId: 'correlation:zero-floor:create',
        trustedOperationAt: now,
      };
      let observedGeneration = 0;
      const administration = makeZeroFloorAuthorizationAdministration(
        persistenceWith({
          create: (received) => {
            observedGeneration = received.expectedSetGeneration;
            return Effect.succeed({
              outcome: 'ZERO_FLOOR_AUTHORIZATION_CREATED',
              revision: managedRevision(authorization),
              setGeneration: 8,
            });
          },
        }),
      );
      expect(yield* administration.create(command)).toMatchObject({
        outcome: 'ZERO_FLOOR_AUTHORIZATION_CREATED',
        revision: { authorization },
      });
      expect(observedGeneration).toBe(7);

      const corrupt = makeZeroFloorAuthorizationAdministration(
        persistenceWith({
          create: () =>
            Effect.succeed({
              outcome: 'ZERO_FLOOR_AUTHORIZATION_REUSED',
              revision: managedRevision({
                ...authorization,
                economicCoverage: { ...authorization.economicCoverage, maximumFloorAdjustment: '999' },
              }),
              setGeneration: 8,
            }),
        }),
      );
      const failure = yield* Effect.flip(corrupt.create(command));
      expect(Schema.is(ZeroFloorAuthorizationPersistenceUnavailable)(failure)).toBe(true);

      const staleGeneration = makeZeroFloorAuthorizationAdministration(
        persistenceWith({
          create: () =>
            Effect.succeed({
              outcome: 'ZERO_FLOOR_AUTHORIZATION_CREATED',
              revision: managedRevision(authorization),
              setGeneration: 7,
            }),
        }),
      );
      expect(
        Schema.is(ZeroFloorAuthorizationPersistenceUnavailable)(yield* Effect.flip(staleGeneration.create(command))),
      ).toBe(true);
    }),
  );

  it.effect('accepts successor, end, and correction only with exact expected-state evidence', () =>
    Effect.gen(function* verifiesTransitions() {
      const { authorization, authorizationSet } = yield* fixture();
      const expected = expectedCurrent(authorization);
      const successor: PricingZeroFloorAuthorization = {
        ...authorization,
        authorizationRevision: 'zero-floor-auth-r797-successor',
        economicCoverage: { maximumFloorAdjustment: '25', minimumRawAmount: '-25' },
        effectivePeriod: { endsAt: '2026-10-15T00:00:00.000Z', startsAt: '2026-09-28T12:00:00.000Z' },
        governanceEvidence: {
          ...authorization.governanceEvidence,
          approvalEvidenceRef: 'pricing-governance-proof:797-successor',
          reason: 'Approved successor bounds',
        },
      };
      const endedPredecessor = {
        ...authorization,
        effectivePeriod: {
          ...authorization.effectivePeriod,
          endsAt: successor.effectivePeriod.startsAt,
        },
      };
      const successorSchedule = schedule(
        authorization,
        [
          managedRevision(endedPredecessor, { scheduleRevision: 2 }),
          managedRevision(successor, {
            lineage: {
              predecessorRevision: authorization.authorizationRevision,
              rootAuthorizationRef: authorization.authorizationRef,
              transition: 'SUCCESSOR',
            },
            revisionNumber: 2,
            scheduleRevision: 2,
          }),
        ],
        2,
      );
      const successorCommand = {
        actingPrincipalId: 'pricing-governance-principal',
        actionInvocationId: 'action-invocation:zero-floor:successor',
        authorization: successor,
        expectedCurrent: expected,
        expectedSetGeneration: 7,
        governanceProof: governanceProof(successor, authorizationSet),
        intent: 'SUCCESSOR' as const,
        reason: 'Replace scope or bounds through a versioned successor',
        requestCorrelationId: 'correlation:zero-floor:successor',
        trustedOperationAt: now,
      };
      const successorService = makeZeroFloorAuthorizationAdministration(
        persistenceWith({
          manage: () =>
            Effect.succeed({
              outcome: 'ZERO_FLOOR_AUTHORIZATION_SUCCEEDED',
              schedule: successorSchedule,
              setGeneration: 8,
            }),
        }),
      );
      expect(yield* successorService.manage(successorCommand)).toMatchObject({
        outcome: 'ZERO_FLOOR_AUTHORIZATION_SUCCEEDED',
      });

      const skippedGeneration = makeZeroFloorAuthorizationAdministration(
        persistenceWith({
          manage: () =>
            Effect.succeed({
              outcome: 'ZERO_FLOOR_AUTHORIZATION_SUCCEEDED',
              schedule: successorSchedule,
              setGeneration: 9,
            }),
        }),
      );
      expect(
        Schema.is(ZeroFloorAuthorizationPersistenceUnavailable)(
          yield* Effect.flip(skippedGeneration.manage(successorCommand)),
        ),
      ).toBe(true);

      const openPredecessor = makeZeroFloorAuthorizationAdministration(
        persistenceWith({
          manage: () =>
            Effect.succeed({
              outcome: 'ZERO_FLOOR_AUTHORIZATION_SUCCEEDED',
              schedule: schedule(
                authorization,
                [
                  managedRevision(authorization, { scheduleRevision: 2 }),
                  managedRevision(successor, {
                    lineage: {
                      predecessorRevision: authorization.authorizationRevision,
                      rootAuthorizationRef: authorization.authorizationRef,
                      transition: 'SUCCESSOR',
                    },
                    revisionNumber: 2,
                    scheduleRevision: 2,
                  }),
                ],
                2,
              ),
              setGeneration: 8,
            }),
        }),
      );
      expect(
        Schema.is(ZeroFloorAuthorizationPersistenceUnavailable)(
          yield* Effect.flip(openPredecessor.manage(successorCommand)),
        ),
      ).toBe(true);

      const changedGenerationNoop = makeZeroFloorAuthorizationAdministration(
        persistenceWith({
          manage: () =>
            Effect.succeed({
              outcome: 'ZERO_FLOOR_AUTHORIZATION_UNCHANGED',
              schedule: schedule(authorization, [managedRevision(authorization)], 1),
              setGeneration: 8,
            }),
        }),
      );
      expect(
        Schema.is(ZeroFloorAuthorizationPersistenceUnavailable)(
          yield* Effect.flip(
            changedGenerationNoop.manage({
              actingPrincipalId: 'pricing-governance-principal',
              actionInvocationId: 'action-invocation:zero-floor:changed-generation-noop',
              authorization,
              expectedCurrent: expectedCurrent(authorization),
              expectedSetGeneration: 7,
              governanceProof: governanceProof(authorization, authorizationSet),
              intent: 'SUCCESSOR',
              reason: 'No-op must preserve the expected complete-set generation',
              requestCorrelationId: 'correlation:zero-floor:changed-generation-noop',
              trustedOperationAt: now,
            }),
          ),
        ),
      ).toBe(true);

      const ended = {
        ...authorization,
        effectivePeriod: { ...authorization.effectivePeriod, endsAt: '2026-09-28T11:00:00.000Z' },
      };
      const endService = makeZeroFloorAuthorizationAdministration(
        persistenceWith({
          manage: () =>
            Effect.succeed({
              outcome: 'ZERO_FLOOR_AUTHORIZATION_ENDED',
              schedule: schedule(authorization, [managedRevision(ended, { scheduleRevision: 2 })], 2),
              setGeneration: 8,
            }),
        }),
      );
      expect(
        yield* endService.manage({
          actingPrincipalId: 'pricing-governance-principal',
          actionInvocationId: 'action-invocation:zero-floor:end',
          authorization,
          authorizationRef: authorization.authorizationRef,
          effectiveTo: '2026-09-28T11:00:00.000Z',
          expectedCurrent: expected,
          expectedSetGeneration: 7,
          intent: 'END_CURRENT',
          reason: 'Stop approving this configuration',
          requestCorrelationId: 'correlation:zero-floor:end',
          trustedOperationAt: now,
        }),
      ).toMatchObject({ outcome: 'ZERO_FLOOR_AUTHORIZATION_ENDED' });

      const correction = {
        ...authorization,
        authorizationRevision: 'zero-floor-auth-r797-correction',
        governanceEvidence: {
          ...authorization.governanceEvidence,
          approvalEvidenceRef: 'pricing-governance-proof:797-correction',
          reason: 'Corrected immutable audit evidence',
        },
      };
      const targetSchedule = schedule(authorization, [managedRevision(authorization)], 1);
      const correctionService = makeZeroFloorAuthorizationAdministration(
        persistenceWith({
          manage: () =>
            Effect.succeed({
              outcome: 'ZERO_FLOOR_AUTHORIZATION_CORRECTED',
              schedule: schedule(
                authorization,
                [
                  managedRevision(authorization, { scheduleState: 'SUPERSEDED' }),
                  managedRevision(correction, {
                    lineage: {
                      correctedRevision: authorization.authorizationRevision,
                      rootAuthorizationRef: authorization.authorizationRef,
                      transition: 'CORRECTED',
                    },
                    revisionNumber: 2,
                    scheduleRevision: 2,
                  }),
                ],
                2,
              ),
              setGeneration: 8,
            }),
          readSchedule: () =>
            Effect.succeed({ outcome: 'ZERO_FLOOR_AUTHORIZATION_SCHEDULE', schedule: targetSchedule }),
        }),
      );
      expect(
        yield* correctionService.manage({
          actingPrincipalId: 'pricing-governance-principal',
          actionInvocationId: 'action-invocation:zero-floor:correct',
          authorization: correction,
          expectedScheduleRevision: 1,
          expectedSetGeneration: 7,
          governanceProof: governanceProof(correction, authorizationSet),
          intent: 'CORRECT_REVISION',
          reason: 'Correct audit evidence without rewriting history',
          requestCorrelationId: 'correlation:zero-floor:correct',
          targetRevision: authorization.authorizationRevision,
          trustedOperationAt: now,
        }),
      ).toMatchObject({ outcome: 'ZERO_FLOOR_AUTHORIZATION_CORRECTED' });

      const expandedCorrection = {
        ...correction,
        economicCoverage: {
          ...correction.economicCoverage,
          maximumFloorAdjustment: '999',
        },
      };
      expect(
        yield* correctionService.manage({
          actingPrincipalId: 'pricing-governance-principal',
          actionInvocationId: 'action-invocation:zero-floor:expanded-correction',
          authorization: expandedCorrection,
          expectedScheduleRevision: 1,
          expectedSetGeneration: 7,
          governanceProof: governanceProof(expandedCorrection, authorizationSet),
          intent: 'CORRECT_REVISION',
          reason: 'An expansion requires a successor Authorization',
          requestCorrelationId: 'correlation:zero-floor:expanded-correction',
          targetRevision: authorization.authorizationRevision,
          trustedOperationAt: now,
        }),
      ).toMatchObject({
        outcome: 'ZERO_FLOOR_AUTHORIZATION_CONFLICT',
        reason: 'SCOPE_EXPANSION_REQUIRES_SUCCESSOR',
      });

      const narrowerCorrection = {
        ...correction,
        coveredMeaning: {
          audienceRefs: correction.coveredMeaning.audienceRefs.slice(0, 1),
          materialRevisionRefs: correction.coveredMeaning.materialRevisionRefs.slice(0, 1),
        },
        economicCoverage: { maximumFloorAdjustment: '10', minimumRawAmount: '-10' },
        effectivePeriod: { ...correction.effectivePeriod, endsAt: '2026-09-28T23:00:00.000Z' },
      };
      const narrowerCorrectionService = makeZeroFloorAuthorizationAdministration(
        persistenceWith({
          manage: () =>
            Effect.succeed({
              outcome: 'ZERO_FLOOR_AUTHORIZATION_CORRECTED',
              schedule: schedule(
                authorization,
                [
                  managedRevision(authorization, { scheduleState: 'SUPERSEDED' }),
                  managedRevision(narrowerCorrection, {
                    lineage: {
                      correctedRevision: authorization.authorizationRevision,
                      rootAuthorizationRef: authorization.authorizationRef,
                      transition: 'CORRECTED',
                    },
                    revisionNumber: 2,
                    scheduleRevision: 2,
                  }),
                ],
                2,
              ),
              setGeneration: 8,
            }),
          readSchedule: () =>
            Effect.succeed({ outcome: 'ZERO_FLOOR_AUTHORIZATION_SCHEDULE', schedule: targetSchedule }),
        }),
      );
      expect(
        yield* narrowerCorrectionService.manage({
          actingPrincipalId: 'pricing-governance-principal',
          actionInvocationId: 'action-invocation:zero-floor:narrower-correction',
          authorization: narrowerCorrection,
          expectedScheduleRevision: 1,
          expectedSetGeneration: 7,
          governanceProof: governanceProof(narrowerCorrection, authorizationSet),
          intent: 'CORRECT_REVISION',
          reason: 'Narrow the corrected Authorization without expanding authority',
          requestCorrelationId: 'correlation:zero-floor:narrower-correction',
          targetRevision: authorization.authorizationRevision,
          trustedOperationAt: now,
        }),
      ).toMatchObject({ outcome: 'ZERO_FLOOR_AUTHORIZATION_CORRECTED' });

      const erasedCorrectionTarget = makeZeroFloorAuthorizationAdministration(
        persistenceWith({
          manage: () =>
            Effect.succeed({
              outcome: 'ZERO_FLOOR_AUTHORIZATION_CORRECTED',
              schedule: schedule(
                authorization,
                [
                  managedRevision(correction, {
                    lineage: {
                      correctedRevision: authorization.authorizationRevision,
                      rootAuthorizationRef: authorization.authorizationRef,
                      transition: 'CORRECTED',
                    },
                    revisionNumber: 2,
                    scheduleRevision: 2,
                  }),
                ],
                2,
              ),
              setGeneration: 8,
            }),
          readSchedule: () =>
            Effect.succeed({ outcome: 'ZERO_FLOOR_AUTHORIZATION_SCHEDULE', schedule: targetSchedule }),
        }),
      );
      expect(
        Schema.is(ZeroFloorAuthorizationPersistenceUnavailable)(
          yield* Effect.flip(
            erasedCorrectionTarget.manage({
              actingPrincipalId: 'pricing-governance-principal',
              actionInvocationId: 'action-invocation:zero-floor:erased-correction-target',
              authorization: correction,
              expectedScheduleRevision: 1,
              expectedSetGeneration: 7,
              governanceProof: governanceProof(correction, authorizationSet),
              intent: 'CORRECT_REVISION',
              reason: 'Never erase corrected immutable history',
              requestCorrelationId: 'correlation:zero-floor:erased-correction-target',
              targetRevision: authorization.authorizationRevision,
              trustedOperationAt: now,
            }),
          ),
        ),
      ).toBe(true);
    }),
  );

  it.effect('rejects an unchanged result unless the exact expected Current state was checked first', () =>
    Effect.gen(function* rejectsFalseNoop() {
      const { authorization, authorizationSet } = yield* fixture();
      const successor = {
        ...authorization,
        authorizationRevision: 'zero-floor-auth-r797-successor',
        effectivePeriod: { ...authorization.effectivePeriod, startsAt: '2026-09-28T12:00:00.000Z' },
      };
      const administration = makeZeroFloorAuthorizationAdministration(
        persistenceWith({
          manage: () =>
            Effect.succeed({
              outcome: 'ZERO_FLOOR_AUTHORIZATION_UNCHANGED',
              schedule: schedule(
                authorization,
                [managedRevision({ ...authorization, authorizationRevision: 'stale-revision' })],
                1,
              ),
              setGeneration: 7,
            }),
        }),
      );
      const failure = yield* Effect.flip(
        administration.manage({
          actingPrincipalId: 'pricing-governance-principal',
          actionInvocationId: 'action-invocation:zero-floor:stale-noop',
          authorization: successor,
          expectedCurrent: expectedCurrent(authorization),
          expectedSetGeneration: 7,
          governanceProof: governanceProof(successor, authorizationSet),
          intent: 'SUCCESSOR',
          reason: 'Do not treat a stale same-value request as success',
          requestCorrelationId: 'correlation:zero-floor:stale-noop',
          trustedOperationAt: now,
        }),
      );
      expect(Schema.is(ZeroFloorAuthorizationPersistenceUnavailable)(failure)).toBe(true);

      const unchangedOpenPredecessor = makeZeroFloorAuthorizationAdministration(
        persistenceWith({
          manage: () =>
            Effect.succeed({
              outcome: 'ZERO_FLOOR_AUTHORIZATION_UNCHANGED',
              schedule: schedule(authorization, [managedRevision(authorization)], 1),
              setGeneration: 7,
            }),
        }),
      );
      expect(
        Schema.is(ZeroFloorAuthorizationPersistenceUnavailable)(
          yield* Effect.flip(
            unchangedOpenPredecessor.manage({
              actingPrincipalId: 'pricing-governance-principal',
              actionInvocationId: 'action-invocation:zero-floor:missing-successor',
              authorization: successor,
              expectedCurrent: expectedCurrent(authorization),
              expectedSetGeneration: 7,
              governanceProof: governanceProof(successor, authorizationSet),
              intent: 'SUCCESSOR',
              reason: 'Do not accept an unchanged predecessor when a successor was requested',
              requestCorrelationId: 'correlation:zero-floor:missing-successor',
              trustedOperationAt: now,
            }),
          ),
        ),
      ).toBe(true);
    }),
  );

  it.effect('accepts a warning only for the exact presented Current and future schedule', () =>
    Effect.gen(function* verifiesScheduleChallenge() {
      const { authorization, authorizationSet } = yield* fixture();
      const future: PricingZeroFloorAuthorization = {
        ...authorization,
        authorizationRevision: 'zero-floor-auth-r797-future',
        effectivePeriod: { endsAt: '2026-10-15T00:00:00.000Z', startsAt: '2026-09-30T00:00:00.000Z' },
      };
      const presentedSchedule = schedule(
        authorization,
        [
          managedRevision(authorization),
          managedRevision(future, {
            lineage: {
              predecessorRevision: authorization.authorizationRevision,
              rootAuthorizationRef: authorization.authorizationRef,
              transition: 'SUCCESSOR',
            },
            revisionNumber: 2,
            scheduleRevision: 2,
          }),
        ],
        2,
      );
      const expected = { ...expectedCurrent(authorization), scheduleRevision: 2 };
      const successor: PricingZeroFloorAuthorization = {
        ...authorization,
        authorizationRevision: 'zero-floor-auth-r797-scheduled-edit',
        effectivePeriod: { ...authorization.effectivePeriod, startsAt: now },
      };
      const command = {
        actingPrincipalId: 'pricing-governance-principal',
        actionInvocationId: 'action-invocation:zero-floor:challenge',
        authorization: successor,
        expectedCurrent: expected,
        expectedSetGeneration: 7,
        governanceProof: governanceProof(successor, authorizationSet),
        intent: 'SUCCESSOR' as const,
        reason: 'Preserve the future schedule',
        requestCorrelationId: 'correlation:zero-floor:challenge',
        trustedOperationAt: now,
      };
      const acknowledgement: Extract<ZeroFloorAuthorizationScheduleAcknowledgement, { readonly intent: 'SUCCESSOR' }> =
        {
          actingPrincipalId: command.actingPrincipalId,
          authorizationRef: authorization.authorizationRef,
          expectedCurrent: expected,
          expectedSetGeneration: 7,
          fingerprint: 'a'.repeat(64),
          intent: 'SUCCESSOR' as const,
          issuedAt: '2026-09-28T12:00:00.010Z',
          presentedSchedule,
          presentedScheduleFingerprint: 'b'.repeat(64),
          proposedAuthorization: successor,
          proposedPayloadFingerprint: 'c'.repeat(64),
          tenantId: authorization.businessScope.tenantId,
          validUntil: '2026-09-28T13:00:00.000Z',
        };
      const challengeService = (challenge: typeof acknowledgement) =>
        makeZeroFloorAuthorizationAdministration(
          persistenceWith({
            manage: () =>
              Effect.succeed({
                acknowledgement: challenge,
                outcome: 'ZERO_FLOOR_AUTHORIZATION_ACKNOWLEDGEMENT_REQUIRED',
              }),
          }),
        );
      expect(yield* challengeService(acknowledgement).manage(command)).toMatchObject({
        outcome: 'ZERO_FLOOR_AUTHORIZATION_ACKNOWLEDGEMENT_REQUIRED',
      });
      const staleTarget = {
        ...acknowledgement,
        presentedSchedule: schedule(
          authorization,
          [
            managedRevision({
              ...authorization,
              effectivePeriod: { ...authorization.effectivePeriod, endsAt: '2026-09-28T23:00:00.000Z' },
            }),
            managedRevision(future, {
              lineage: {
                predecessorRevision: authorization.authorizationRevision,
                rootAuthorizationRef: authorization.authorizationRef,
                transition: 'SUCCESSOR',
              },
              revisionNumber: 2,
              scheduleRevision: 2,
            }),
          ],
          2,
        ),
      };
      expect(
        Schema.is(ZeroFloorAuthorizationPersistenceUnavailable)(
          yield* Effect.flip(challengeService(staleTarget).manage(command)),
        ),
      ).toBe(true);
      const noFuture = {
        ...acknowledgement,
        presentedSchedule: schedule(authorization, [managedRevision(authorization)], 2),
      };
      expect(
        Schema.is(ZeroFloorAuthorizationPersistenceUnavailable)(
          yield* Effect.flip(challengeService(noFuture).manage(command)),
        ),
      ).toBe(true);
    }),
  );

  it.effect('fails before persistence when scope, bounds, or Current proof is stale', () =>
    Effect.gen(function* rejectsStaleGovernanceProof() {
      const { authorization, authorizationSet } = yield* fixture();
      let persistenceCalls = 0;
      const administration = makeZeroFloorAuthorizationAdministration(
        persistenceWith({
          create: () => {
            persistenceCalls += 1;
            return Effect.succeed({
              outcome: 'ZERO_FLOOR_AUTHORIZATION_CREATED',
              revision: managedRevision(authorization),
              setGeneration: 8,
            });
          },
        }),
      );
      const proof = governanceProof(authorization, authorizationSet);
      const failure = yield* Effect.flip(
        administration.create({
          actingPrincipalId: 'pricing-governance-principal',
          actionInvocationId: 'action-invocation:zero-floor:stale-proof',
          authorization,
          expectedSetGeneration: 7,
          governanceProof: {
            ...proof,
            currentness: { ...proof.currentness, evaluatedAt: '2026-09-28T11:59:59.999Z' },
          },
          reason: 'A stale proof must not authorize even an equal payload',
          requestCorrelationId: 'correlation:zero-floor:stale-proof',
          trustedOperationAt: now,
        }),
      );
      expect(Schema.is(ZeroFloorAuthorizationPersistenceUnavailable)(failure)).toBe(true);
      const impossibleObservation = yield* Effect.flip(
        administration.create({
          actingPrincipalId: 'pricing-governance-principal',
          actionInvocationId: 'action-invocation:zero-floor:future-evaluation',
          authorization,
          expectedSetGeneration: 7,
          governanceProof: {
            ...proof,
            completenessEvidence: {
              ...proof.completenessEvidence,
              observedAt: '2026-09-28T11:59:59.999Z',
            },
            currentness: {
              ...proof.currentness,
              evaluatedAt: now,
              observedAt: '2026-09-28T11:59:59.999Z',
              revalidatedAt: now,
            },
          },
          reason: 'An observation before evaluation cannot prove Current governance',
          requestCorrelationId: 'correlation:zero-floor:future-evaluation',
          trustedOperationAt: now,
        }),
      );
      expect(Schema.is(ZeroFloorAuthorizationPersistenceUnavailable)(impossibleObservation)).toBe(true);
      expect(persistenceCalls).toBe(0);
    }),
  );

  it.effect('binds durable result lookup to the original Action invocation', () =>
    Effect.gen(function* verifiesResultLookup() {
      const { authorization } = yield* fixture();
      const exact = makeZeroFloorAuthorizationAdministration(
        persistenceWith({
          lookupResult: (query) =>
            Effect.succeed({
              actionInvocationId: query.actionInvocationId,
              outcome: 'ZERO_FLOOR_AUTHORIZATION_RESULT_FOUND',
              result: {
                outcome: 'ZERO_FLOOR_AUTHORIZATION_CREATED',
                revision: managedRevision(authorization),
                setGeneration: 8,
              },
            }),
        }),
      );
      expect(
        yield* exact.lookupResult({
          actingPrincipalId: 'pricing-governance-principal',
          actionInvocationId: 'action-invocation:zero-floor:lookup',
        }),
      ).toMatchObject({
        outcome: 'ZERO_FLOOR_AUTHORIZATION_RESULT_FOUND',
      });

      const drifted = makeZeroFloorAuthorizationAdministration(
        persistenceWith({
          lookupResult: () =>
            Effect.succeed({
              actionInvocationId: 'action-invocation:zero-floor:other',
              outcome: 'ZERO_FLOOR_AUTHORIZATION_RESULT_ABSENT',
            }),
        }),
      );
      expect(
        Schema.is(ZeroFloorAuthorizationPersistenceUnavailable)(
          yield* Effect.flip(
            drifted.lookupResult({
              actingPrincipalId: 'pricing-governance-principal',
              actionInvocationId: 'action-invocation:zero-floor:lookup',
            }),
          ),
        ),
      ).toBe(true);
    }),
  );

  it.effect('binds complete Current-set and generation proof to the exact query for #790', () =>
    Effect.gen(function* verifiesSetProof() {
      const { authorizationSet } = yield* fixture();
      const query = { query: authorizationSet.query };
      const authority = {
        generation: 7,
        observedAt: authorizationSet.currentness.observedAt,
        ownerRevision: authorizationSet.ownerRevision,
        ownerRootRef: 'zero-floor-authorization-set:tenant-779',
        predicateRef: authorizationSet.exactPredicateRef,
        verificationRef: 'zero-floor-set-verification:779',
      };
      const factProofs = authorizationSet.authorizations.map((authorization) => ({
        factRef: authorization.authorizationRef,
        factRevisionRef: authorization.authorizationRevision,
        verificationRef: authority.verificationRef,
      }));
      const administration = makeZeroFloorAuthorizationAdministration(
        persistenceWith({
          readCurrentSet: () =>
            Effect.succeed({
              authority,
              authorizationSet,
              factProofs,
              outcome: 'ZERO_FLOOR_AUTHORIZATION_SET_CURRENT',
            }),
          verifyGeneration: () =>
            Effect.succeed({
              generation: authority.generation,
              outcome: 'ZERO_FLOOR_AUTHORIZATION_SET_GENERATION_CURRENT',
              ownerRevision: authority.ownerRevision,
              ownerRootRef: authority.ownerRootRef,
              verifiedThrough: '2026-09-28T10:30:00.000Z',
            }),
        }),
      );
      expect(yield* administration.readCurrentSet(query)).toMatchObject({ authority, authorizationSet });
      expect(
        yield* administration.verifyGeneration({
          generation: authority.generation,
          observedAt: authority.observedAt,
          ownerRevision: authority.ownerRevision,
          ownerRootRef: authority.ownerRootRef,
          query: authorizationSet.query,
          through: '2026-09-28T10:30:00.000Z',
        }),
      ).toMatchObject({ outcome: 'ZERO_FLOOR_AUTHORIZATION_SET_GENERATION_CURRENT' });

      const driftedSet: PricingZeroFloorCurrentAuthorizationSet = {
        ...authorizationSet,
        query: { ...authorizationSet.query, exactPredicateRef: 'zero-floor:other-predicate' },
      };
      const drifted = makeZeroFloorAuthorizationAdministration(
        persistenceWith({
          readCurrentSet: () =>
            Effect.succeed({
              authority,
              authorizationSet: driftedSet,
              factProofs,
              outcome: 'ZERO_FLOOR_AUTHORIZATION_SET_CURRENT',
            }),
        }),
      );
      expect(
        Schema.is(ZeroFloorAuthorizationPersistenceUnavailable)(yield* Effect.flip(drifted.readCurrentSet(query))),
      ).toBe(true);
    }),
  );
});
