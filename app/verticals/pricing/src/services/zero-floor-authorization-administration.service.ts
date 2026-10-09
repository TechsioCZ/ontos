import {
  PricingZeroFloorAuthorizationQuerySchema,
  PricingZeroFloorAuthorizationSchema,
} from '@app/pricing-contracts/domain/line-composition';
import type { PricingZeroFloorAuthorization } from '@app/pricing-contracts/domain/line-composition';
import { comparePricingExactDecimals } from '@app/pricing-contracts/domain/exact-decimal';
import { Effect, Schema } from 'effect';

import type {
  CreateZeroFloorAuthorizationPersistenceCommand,
  CreateZeroFloorAuthorizationPersistenceOutcome,
  ExpectedZeroFloorAuthorizationCurrent,
  ManageZeroFloorAuthorizationPersistenceCommand,
  ManageZeroFloorAuthorizationPersistenceOutcome,
  ReadCurrentZeroFloorAuthorizationSetPersistenceOutcome,
  ReadCurrentZeroFloorAuthorizationSetPersistenceQuery,
  ReadCurrentZeroFloorAuthorizationGovernanceProofOutcome,
  ReadCurrentZeroFloorAuthorizationGovernanceProofQuery,
  ReadZeroFloorAuthorizationSchedulePersistenceOutcome,
  ReadZeroFloorAuthorizationSchedulePersistenceQuery,
  VerifyZeroFloorAuthorizationSetGenerationPersistenceOutcome,
  VerifyZeroFloorAuthorizationSetGenerationPersistenceQuery,
  ZeroFloorAuthorizationPersistence,
  ZeroFloorAuthorizationResultLookupOutcome,
  ZeroFloorAuthorizationResultLookupQuery,
  ZeroFloorAuthorizationScheduleAcknowledgement,
  ZeroFloorAuthorizationScheduleSnapshot,
} from './zero-floor-authorization-persistence.service.ts';
import {
  ZeroFloorAuthorizationGovernanceProofSchema,
  ZeroFloorAuthorizationPersistenceUnavailable,
  zeroFloorAuthorizationPersistenceForScope,
} from './zero-floor-authorization-persistence.service.ts';

const sameAuthorization = Schema.toEquivalence(PricingZeroFloorAuthorizationSchema);
const sameBusinessScope = Schema.toEquivalence(PricingZeroFloorAuthorizationSchema.fields.businessScope);
const sameQuery = Schema.toEquivalence(PricingZeroFloorAuthorizationQuerySchema);

const correctionPreservesAuthorizedMeaning = (
  target: PricingZeroFloorAuthorization,
  proposed: PricingZeroFloorAuthorization,
): boolean => {
  const targetAudienceRefs = new Set(target.coveredMeaning.audienceRefs);
  const targetMaterialRevisionRefs = new Set(target.coveredMeaning.materialRevisionRefs);
  return (
    target.authorizationRef === proposed.authorizationRef &&
    sameBusinessScope(target.businessScope, proposed.businessScope) &&
    target.currencyCode === proposed.currencyCode &&
    proposed.coveredMeaning.audienceRefs.every((reference) => targetAudienceRefs.has(reference)) &&
    proposed.coveredMeaning.materialRevisionRefs.every((reference) => targetMaterialRevisionRefs.has(reference)) &&
    comparePricingExactDecimals(proposed.economicCoverage.minimumRawAmount, target.economicCoverage.minimumRawAmount) >=
      0 &&
    comparePricingExactDecimals(
      proposed.economicCoverage.maximumFloorAdjustment,
      target.economicCoverage.maximumFloorAdjustment,
    ) <= 0 &&
    proposed.effectivePeriod.startsAt >= target.effectivePeriod.startsAt &&
    (target.effectivePeriod.endsAt === undefined ||
      (proposed.effectivePeriod.endsAt !== undefined &&
        proposed.effectivePeriod.endsAt <= target.effectivePeriod.endsAt))
  );
};

const approvalCoversAuthorization = (
  approved: PricingZeroFloorAuthorization,
  proposed: PricingZeroFloorAuthorization,
): boolean => {
  const approvedEndsAt = approved.effectivePeriod.endsAt;
  const proposedEndsAt = proposed.effectivePeriod.endsAt;
  return (
    proposed.effectivePeriod.startsAt >= approved.effectivePeriod.startsAt &&
    (approvedEndsAt === undefined || (proposedEndsAt !== undefined && proposedEndsAt <= approvedEndsAt)) &&
    sameAuthorization(
      {
        ...approved,
        authorizationRevision: proposed.authorizationRevision,
        effectivePeriod: proposed.effectivePeriod,
      },
      proposed,
    )
  );
};

const sameExpectedCurrent = (
  left: ExpectedZeroFloorAuthorizationCurrent,
  right: ExpectedZeroFloorAuthorizationCurrent,
): boolean =>
  left.authorizationRef === right.authorizationRef &&
  left.authorizationRevision === right.authorizationRevision &&
  left.effectivePeriod.startsAt === right.effectivePeriod.startsAt &&
  left.effectivePeriod.endsAt === right.effectivePeriod.endsAt &&
  left.scheduleRevision === right.scheduleRevision;

const unavailable = (reason: string): ZeroFloorAuthorizationPersistenceUnavailable =>
  new ZeroFloorAuthorizationPersistenceUnavailable({ reason });

const governanceProofMatches = (
  command:
    | CreateZeroFloorAuthorizationPersistenceCommand
    | Extract<ManageZeroFloorAuthorizationPersistenceCommand, { readonly intent: 'CORRECT_REVISION' | 'SUCCESSOR' }>,
): boolean => {
  const { approvalEvidence, completenessEvidence, currentness } = command.governanceProof;
  const evaluatedAt = command.trustedOperationAt;
  return (
    Schema.is(ZeroFloorAuthorizationGovernanceProofSchema)(command.governanceProof) &&
    sameAuthorization(command.governanceProof.authorization, command.authorization) &&
    approvalCoversAuthorization(approvalEvidence.authorization, command.authorization) &&
    approvalEvidence.approvalEvidenceRef === command.authorization.governanceEvidence.approvalEvidenceRef &&
    approvalEvidence.approvedByPrincipalRef === command.authorization.governanceEvidence.approvedByPrincipalRef &&
    approvalEvidence.tenantId === command.authorization.businessScope.tenantId &&
    approvalEvidence.sellingLegalEntityId ===
      command.authorization.businessScope.commercialScope.sellingLegalEntityId &&
    approvalEvidence.approvedAt <= evaluatedAt &&
    approvalEvidence.validityPeriod.startsAt <= evaluatedAt &&
    evaluatedAt < approvalEvidence.validityPeriod.endsAt &&
    currentness.status === 'CURRENT' &&
    currentness.evaluatedAt === evaluatedAt &&
    currentness.evaluatedAt <= currentness.observedAt &&
    currentness.observedAt <= currentness.revalidatedAt &&
    completenessEvidence.ownerRevision === command.governanceProof.ownerRevision &&
    completenessEvidence.observedAt === currentness.observedAt &&
    completenessEvidence.scope.kind === 'EXACT_PREDICATE' &&
    completenessEvidence.scope.predicateRef === command.governanceProof.exactPredicateRef &&
    (completenessEvidence.nextApplicabilityBoundary === undefined ||
      evaluatedAt < completenessEvidence.nextApplicabilityBoundary)
  );
};

const approvalCommandIsCoherent = (
  command: Extract<ManageZeroFloorAuthorizationPersistenceCommand, { readonly intent: 'APPROVE' }>,
): boolean =>
  command.actingPrincipalId === command.authorization.governanceEvidence.approvedByPrincipalRef &&
  command.validityPeriod.startsAt <= command.trustedOperationAt &&
  command.trustedOperationAt < command.validityPeriod.endsAt;

const scheduleIsCoherent = (schedule: ZeroFloorAuthorizationScheduleSnapshot): boolean => {
  const scheduled = schedule.revisions.filter(({ scheduleState }) => scheduleState !== 'SUPERSEDED');
  const sorted = [...scheduled].toSorted((left, right) =>
    left.authorization.effectivePeriod.startsAt.localeCompare(right.authorization.effectivePeriod.startsAt),
  );
  return (
    new Set(schedule.revisions.map(({ authorization }) => authorization.authorizationRevision)).size ===
      schedule.revisions.length &&
    schedule.revisions.every(
      ({ authorization, lineage, scheduleRevision }) =>
        authorization.authorizationRef === schedule.authorizationRef &&
        authorization.businessScope.tenantId === schedule.tenantId &&
        lineage.rootAuthorizationRef === schedule.authorizationRef &&
        scheduleRevision <= schedule.scheduleRevision,
    ) &&
    sorted.every((revision, index) => {
      const next = sorted[index + 1];
      return (
        (revision.authorization.effectivePeriod.endsAt === undefined ||
          revision.authorization.effectivePeriod.startsAt < revision.authorization.effectivePeriod.endsAt) &&
        (next === undefined ||
          (revision.authorization.effectivePeriod.endsAt !== undefined &&
            revision.authorization.effectivePeriod.endsAt <= next.authorization.effectivePeriod.startsAt))
      );
    })
  );
};

const scheduleContainsExpectedCurrent = (
  schedule: ZeroFloorAuthorizationScheduleSnapshot,
  expectedCurrent: ExpectedZeroFloorAuthorizationCurrent,
): boolean =>
  schedule.revisions.some(
    ({ authorization, scheduleState }) =>
      scheduleState !== 'SUPERSEDED' &&
      authorization.authorizationRef === expectedCurrent.authorizationRef &&
      authorization.authorizationRevision === expectedCurrent.authorizationRevision &&
      authorization.effectivePeriod.startsAt === expectedCurrent.effectivePeriod.startsAt &&
      authorization.effectivePeriod.endsAt === expectedCurrent.effectivePeriod.endsAt,
  );

const acknowledgementPresentsFutureSchedule = (
  acknowledgement: ZeroFloorAuthorizationScheduleAcknowledgement,
  comparedAt: string,
): boolean =>
  acknowledgement.presentedSchedule.revisions.some(
    ({ authorization, scheduleState }) =>
      scheduleState !== 'SUPERSEDED' && authorization.effectivePeriod.startsAt > comparedAt,
  );

const acknowledgementMatchesCommonCommand = (
  acknowledgement: ZeroFloorAuthorizationScheduleAcknowledgement,
  command: Exclude<ManageZeroFloorAuthorizationPersistenceCommand, { readonly intent: 'APPROVE' }>,
): boolean =>
  acknowledgement.intent === command.intent &&
  acknowledgement.actingPrincipalId === command.actingPrincipalId &&
  acknowledgement.tenantId === command.authorization.businessScope.tenantId &&
  acknowledgement.authorizationRef === command.authorization.authorizationRef &&
  acknowledgement.expectedSetGeneration === command.expectedSetGeneration &&
  scheduleIsCoherent(acknowledgement.presentedSchedule) &&
  acknowledgementPresentsFutureSchedule(acknowledgement, command.trustedOperationAt);

const acknowledgementMatchesExpectedCurrent = (
  acknowledgement: Extract<
    ZeroFloorAuthorizationScheduleAcknowledgement,
    { readonly intent: 'END_CURRENT' | 'SUCCESSOR' }
  >,
  expectedCurrent: ExpectedZeroFloorAuthorizationCurrent,
): boolean =>
  sameExpectedCurrent(acknowledgement.expectedCurrent, expectedCurrent) &&
  acknowledgement.presentedSchedule.scheduleRevision === expectedCurrent.scheduleRevision &&
  scheduleContainsExpectedCurrent(acknowledgement.presentedSchedule, expectedCurrent);

const acknowledgementMatchesCommand = (
  acknowledgement: ZeroFloorAuthorizationScheduleAcknowledgement,
  command: Exclude<ManageZeroFloorAuthorizationPersistenceCommand, { readonly intent: 'APPROVE' }>,
  timing: 'ISSUED_CHALLENGE' | 'PRESENTED_ACKNOWLEDGEMENT' = 'PRESENTED_ACKNOWLEDGEMENT',
): boolean => {
  const timingMatches =
    timing === 'ISSUED_CHALLENGE'
      ? acknowledgement.issuedAt >= command.trustedOperationAt
      : acknowledgement.issuedAt <= command.trustedOperationAt &&
        command.trustedOperationAt < acknowledgement.validUntil;
  if (!acknowledgementMatchesCommonCommand(acknowledgement, command) || !timingMatches) {
    return false;
  }
  if (command.intent === 'SUCCESSOR' && acknowledgement.intent === 'SUCCESSOR') {
    return (
      acknowledgementMatchesExpectedCurrent(acknowledgement, command.expectedCurrent) &&
      sameAuthorization(acknowledgement.proposedAuthorization, command.authorization)
    );
  }
  if (command.intent === 'END_CURRENT' && acknowledgement.intent === 'END_CURRENT') {
    return (
      acknowledgementMatchesExpectedCurrent(acknowledgement, command.expectedCurrent) &&
      sameAuthorization(acknowledgement.proposedAuthorization, command.authorization) &&
      acknowledgement.effectiveTo === command.effectiveTo
    );
  }
  return (
    command.intent === 'CORRECT_REVISION' &&
    acknowledgement.intent === 'CORRECT_REVISION' &&
    acknowledgement.expectedScheduleRevision === command.expectedScheduleRevision &&
    acknowledgement.presentedSchedule.scheduleRevision === command.expectedScheduleRevision &&
    acknowledgement.presentedSchedule.revisions.some(
      ({ authorization, scheduleState }) =>
        scheduleState !== 'SUPERSEDED' && authorization.authorizationRevision === command.targetRevision,
    ) &&
    acknowledgement.targetRevision === command.targetRevision &&
    sameAuthorization(acknowledgement.proposedAuthorization, command.authorization)
  );
};

const outcomeAuthorizationRef = (
  command: CreateZeroFloorAuthorizationPersistenceCommand | ManageZeroFloorAuthorizationPersistenceCommand,
): string => command.authorization.authorizationRef;

const expectedManagedOutcome = (
  intent: Exclude<ManageZeroFloorAuthorizationPersistenceCommand['intent'], 'APPROVE'>,
): 'ZERO_FLOOR_AUTHORIZATION_CORRECTED' | 'ZERO_FLOOR_AUTHORIZATION_ENDED' | 'ZERO_FLOOR_AUTHORIZATION_SUCCEEDED' => {
  if (intent === 'SUCCESSOR') {
    return 'ZERO_FLOOR_AUTHORIZATION_SUCCEEDED';
  }
  return intent === 'END_CURRENT' ? 'ZERO_FLOOR_AUTHORIZATION_ENDED' : 'ZERO_FLOOR_AUTHORIZATION_CORRECTED';
};

const verifyCreateOutcome = (
  command: CreateZeroFloorAuthorizationPersistenceCommand,
  outcome: CreateZeroFloorAuthorizationPersistenceOutcome,
): Effect.Effect<CreateZeroFloorAuthorizationPersistenceOutcome, ZeroFloorAuthorizationPersistenceUnavailable> => {
  if (outcome.outcome === 'ZERO_FLOOR_AUTHORIZATION_CONFLICT') {
    return outcome.authorizationRef === command.authorization.authorizationRef
      ? Effect.succeed(outcome)
      : Effect.fail(unavailable('ZERO_FLOOR create conflict did not bind the requested Authorization'));
  }
  const { revision } = outcome;
  const expectedGeneration =
    outcome.outcome === 'ZERO_FLOOR_AUTHORIZATION_CREATED'
      ? command.expectedSetGeneration + 1
      : command.expectedSetGeneration;
  return outcome.setGeneration === expectedGeneration &&
    sameAuthorization(revision.authorization, command.authorization) &&
    revision.lineage.rootAuthorizationRef === command.authorization.authorizationRef &&
    revision.lineage.transition === 'CREATED'
    ? Effect.succeed(outcome)
    : Effect.fail(unavailable('ZERO_FLOOR create evidence did not preserve the requested governed Authorization'));
};

const scheduleMatchesManagement = (
  command: ManageZeroFloorAuthorizationPersistenceCommand,
  schedule: ZeroFloorAuthorizationScheduleSnapshot,
): boolean => {
  if (command.intent === 'APPROVE') {
    return false;
  }
  if (!scheduleIsCoherent(schedule) || schedule.authorizationRef !== outcomeAuthorizationRef(command)) {
    return false;
  }
  if (command.intent === 'SUCCESSOR') {
    const predecessor = schedule.revisions.find(
      ({ authorization, scheduleState }) =>
        scheduleState !== 'SUPERSEDED' &&
        authorization.authorizationRef === command.expectedCurrent.authorizationRef &&
        authorization.authorizationRevision === command.expectedCurrent.authorizationRevision &&
        authorization.effectivePeriod.startsAt === command.expectedCurrent.effectivePeriod.startsAt,
    );
    return (
      command.authorization.authorizationRevision !== command.expectedCurrent.authorizationRevision &&
      schedule.scheduleRevision === command.expectedCurrent.scheduleRevision + 1 &&
      predecessor?.authorization.effectivePeriod.endsAt === command.authorization.effectivePeriod.startsAt &&
      schedule.revisions.some(
        ({ authorization, lineage, scheduleState }) =>
          scheduleState !== 'SUPERSEDED' &&
          sameAuthorization(authorization, command.authorization) &&
          lineage.transition === 'SUCCESSOR' &&
          lineage.predecessorRevision === command.expectedCurrent.authorizationRevision,
      )
    );
  }
  if (command.intent === 'END_CURRENT') {
    const endedAuthorization: PricingZeroFloorAuthorization = {
      ...command.authorization,
      effectivePeriod: {
        ...command.authorization.effectivePeriod,
        endsAt: command.effectiveTo,
      },
    };
    return (
      command.authorization.authorizationRef === command.expectedCurrent.authorizationRef &&
      command.authorization.authorizationRevision === command.expectedCurrent.authorizationRevision &&
      command.authorization.effectivePeriod.startsAt === command.expectedCurrent.effectivePeriod.startsAt &&
      command.authorization.effectivePeriod.endsAt === command.expectedCurrent.effectivePeriod.endsAt &&
      schedule.scheduleRevision === command.expectedCurrent.scheduleRevision + 1 &&
      schedule.revisions.some(({ authorization }) => sameAuthorization(authorization, endedAuthorization))
    );
  }
  return (
    command.authorization.authorizationRevision !== command.targetRevision &&
    schedule.scheduleRevision === command.expectedScheduleRevision + 1 &&
    schedule.revisions.some(
      ({ authorization, scheduleState }) =>
        scheduleState === 'SUPERSEDED' && authorization.authorizationRevision === command.targetRevision,
    ) &&
    schedule.revisions.some(
      ({ authorization, lineage, scheduleState }) =>
        scheduleState !== 'SUPERSEDED' &&
        sameAuthorization(authorization, command.authorization) &&
        lineage.transition === 'CORRECTED' &&
        lineage.correctedRevision === command.targetRevision,
    )
  );
};

const unchangedScheduleMatchesExpected = (
  command: ManageZeroFloorAuthorizationPersistenceCommand,
  schedule: ZeroFloorAuthorizationScheduleSnapshot,
): boolean => {
  if (command.intent === 'APPROVE') {
    return false;
  }
  if (command.intent === 'SUCCESSOR') {
    const exactReusableAuthorization = schedule.revisions.some(
      ({ authorization, scheduleState }) =>
        scheduleState !== 'SUPERSEDED' &&
        authorization.authorizationRevision === command.expectedCurrent.authorizationRevision &&
        sameAuthorization(authorization, command.authorization),
    );
    if (
      exactReusableAuthorization &&
      schedule.scheduleRevision === command.expectedCurrent.scheduleRevision &&
      scheduleIsCoherent(schedule)
    ) {
      return true;
    }
  }
  return false;
};

const verifyManageOutcome = (
  command: ManageZeroFloorAuthorizationPersistenceCommand,
  outcome: ManageZeroFloorAuthorizationPersistenceOutcome,
): Effect.Effect<ManageZeroFloorAuthorizationPersistenceOutcome, ZeroFloorAuthorizationPersistenceUnavailable> => {
  if (outcome.outcome === 'ZERO_FLOOR_AUTHORIZATION_CONFLICT') {
    return outcome.authorizationRef === outcomeAuthorizationRef(command)
      ? Effect.succeed(outcome)
      : Effect.fail(unavailable('ZERO_FLOOR management conflict did not bind the requested Authorization'));
  }
  if (command.intent === 'APPROVE') {
    if (
      outcome.outcome !== 'ZERO_FLOOR_GOVERNANCE_APPROVAL_RECORDED' &&
      outcome.outcome !== 'ZERO_FLOOR_GOVERNANCE_APPROVAL_REUSED'
    ) {
      return Effect.fail(unavailable('ZERO_FLOOR approval returned an unrelated management outcome'));
    }
    const { approvalEvidence } = outcome;
    const expectedGeneration =
      outcome.outcome === 'ZERO_FLOOR_GOVERNANCE_APPROVAL_RECORDED'
        ? command.expectedSetGeneration + 1
        : command.expectedSetGeneration;
    return outcome.setGeneration === expectedGeneration &&
      sameAuthorization(approvalEvidence.authorization, command.authorization) &&
      approvalEvidence.approvalRevision === command.approvalRevision &&
      approvalEvidence.approvedByPrincipalRef === command.actingPrincipalId &&
      approvalEvidence.validityPeriod.startsAt === command.validityPeriod.startsAt &&
      approvalEvidence.validityPeriod.endsAt === command.validityPeriod.endsAt
      ? Effect.succeed(outcome)
      : Effect.fail(unavailable('ZERO_FLOOR approval evidence did not bind the trusted approval request'));
  }
  if (
    outcome.outcome === 'ZERO_FLOOR_GOVERNANCE_APPROVAL_RECORDED' ||
    outcome.outcome === 'ZERO_FLOOR_GOVERNANCE_APPROVAL_REUSED'
  ) {
    return Effect.fail(unavailable('ZERO_FLOOR management returned unrelated governance approval evidence'));
  }
  if (outcome.outcome === 'ZERO_FLOOR_AUTHORIZATION_ACKNOWLEDGEMENT_REQUIRED') {
    return acknowledgementMatchesCommand(outcome.acknowledgement, command, 'ISSUED_CHALLENGE')
      ? Effect.succeed(outcome)
      : Effect.fail(unavailable('ZERO_FLOOR acknowledgement challenge did not bind the exact requested change'));
  }
  if (outcome.outcome === 'ZERO_FLOOR_AUTHORIZATION_UNCHANGED') {
    return outcome.setGeneration === command.expectedSetGeneration &&
      unchangedScheduleMatchesExpected(command, outcome.schedule)
      ? Effect.succeed(outcome)
      : Effect.fail(
          unavailable('ZERO_FLOOR no-op evidence did not prove the exact expected Current state before success'),
        );
  }
  const expectedOutcome = expectedManagedOutcome(command.intent);
  return outcome.outcome === expectedOutcome &&
    outcome.setGeneration === command.expectedSetGeneration + 1 &&
    scheduleMatchesManagement(command, outcome.schedule)
    ? Effect.succeed(outcome)
    : Effect.fail(unavailable('ZERO_FLOOR management evidence did not preserve the requested versioned transition'));
};

const verifyCurrentSetOutcome = (
  query: ReadCurrentZeroFloorAuthorizationSetPersistenceQuery,
  outcome: ReadCurrentZeroFloorAuthorizationSetPersistenceOutcome,
): Effect.Effect<
  ReadCurrentZeroFloorAuthorizationSetPersistenceOutcome,
  ZeroFloorAuthorizationPersistenceUnavailable
> => {
  const { authority, authorizationSet } = outcome;
  const valid =
    sameQuery(query.query, authorizationSet.query) &&
    authority.predicateRef === authorizationSet.exactPredicateRef &&
    authority.ownerRevision === authorizationSet.ownerRevision &&
    authority.observedAt === authorizationSet.currentness.observedAt &&
    authorizationSet.authorizations.every(
      ({ businessScope, currencyCode, effectivePeriod }) =>
        businessScope.tenantId === query.query.tenantId &&
        currencyCode === query.query.currencyCode &&
        effectivePeriod.startsAt <= query.query.effectiveAt &&
        (effectivePeriod.endsAt === undefined || query.query.effectiveAt < effectivePeriod.endsAt),
    );
  return valid
    ? Effect.succeed(outcome)
    : Effect.fail(unavailable('ZERO_FLOOR Current set did not bind the exact query and owner authority'));
};

const verifyGovernanceProofOutcome = (
  query: ReadCurrentZeroFloorAuthorizationGovernanceProofQuery,
  outcome: ReadCurrentZeroFloorAuthorizationGovernanceProofOutcome,
): Effect.Effect<
  ReadCurrentZeroFloorAuthorizationGovernanceProofOutcome,
  ZeroFloorAuthorizationPersistenceUnavailable
> =>
  Schema.is(ZeroFloorAuthorizationGovernanceProofSchema)(outcome.governanceProof) &&
  sameAuthorization(outcome.governanceProof.authorization, query.authorization) &&
  outcome.governanceProof.currentness.evaluatedAt === query.effectiveAt
    ? Effect.succeed(outcome)
    : Effect.fail(unavailable('ZERO_FLOOR governance proof did not bind the exact Authorization and evaluation'));

const verifyGenerationOutcome = (
  query: VerifyZeroFloorAuthorizationSetGenerationPersistenceQuery,
  outcome: VerifyZeroFloorAuthorizationSetGenerationPersistenceOutcome,
): Effect.Effect<
  VerifyZeroFloorAuthorizationSetGenerationPersistenceOutcome,
  ZeroFloorAuthorizationPersistenceUnavailable
> => {
  if (outcome.verifiedThrough !== query.through) {
    return Effect.fail(unavailable('ZERO_FLOOR generation verification did not cover the requested instant'));
  }
  if (outcome.outcome === 'ZERO_FLOOR_AUTHORIZATION_SET_GENERATION_CHANGED') {
    return Effect.succeed(outcome);
  }
  return outcome.generation === query.generation &&
    outcome.ownerRevision === query.ownerRevision &&
    outcome.ownerRootRef === query.ownerRootRef
    ? Effect.succeed(outcome)
    : Effect.fail(unavailable('ZERO_FLOOR generation evidence did not bind the previously observed owner root'));
};

const verifyScheduleOutcome = (
  query: ReadZeroFloorAuthorizationSchedulePersistenceQuery,
  outcome: ReadZeroFloorAuthorizationSchedulePersistenceOutcome,
): Effect.Effect<
  ReadZeroFloorAuthorizationSchedulePersistenceOutcome,
  ZeroFloorAuthorizationPersistenceUnavailable
> => {
  if (outcome.outcome === 'ZERO_FLOOR_AUTHORIZATION_SCHEDULE') {
    return outcome.schedule.authorizationRef === query.authorizationRef &&
      outcome.schedule.tenantId === query.tenantId &&
      scheduleIsCoherent(outcome.schedule)
      ? Effect.succeed(outcome)
      : Effect.fail(unavailable('ZERO_FLOOR schedule evidence did not bind the requested Tenant and Authorization'));
  }
  return outcome.authorizationRef === query.authorizationRef
    ? Effect.succeed(outcome)
    : Effect.fail(unavailable('ZERO_FLOOR schedule outcome did not bind the requested Authorization'));
};

const verifyLookupOutcome = (
  query: ZeroFloorAuthorizationResultLookupQuery,
  outcome: ZeroFloorAuthorizationResultLookupOutcome,
): Effect.Effect<ZeroFloorAuthorizationResultLookupOutcome, ZeroFloorAuthorizationPersistenceUnavailable> =>
  outcome.actionInvocationId === query.actionInvocationId
    ? Effect.succeed(outcome)
    : Effect.fail(unavailable('ZERO_FLOOR result lookup did not bind the original Action invocation'));

const manageAuthorization = (
  persistence: ZeroFloorAuthorizationPersistence,
  command: ManageZeroFloorAuthorizationPersistenceCommand,
): Effect.Effect<ManageZeroFloorAuthorizationPersistenceOutcome, ZeroFloorAuthorizationPersistenceUnavailable> => {
  const execute = () =>
    (command.intent === 'APPROVE' && approvalCommandIsCoherent(command)) ||
    command.intent === 'END_CURRENT' ||
    (command.intent !== 'APPROVE' && governanceProofMatches(command))
      ? persistence.manage(command).pipe(Effect.flatMap((outcome) => verifyManageOutcome(command, outcome)))
      : Effect.fail(unavailable('ZERO_FLOOR transition requires fresh exact scope, bounds, and Current proof'));
  if (command.intent !== 'CORRECT_REVISION') {
    return execute();
  }
  return persistence
    .readSchedule({
      authorizationRef: command.authorization.authorizationRef,
      tenantId: command.authorization.businessScope.tenantId,
      trustedOperationAt: command.trustedOperationAt,
    })
    .pipe(
      Effect.flatMap((outcome) =>
        verifyScheduleOutcome(
          {
            authorizationRef: command.authorization.authorizationRef,
            tenantId: command.authorization.businessScope.tenantId,
            trustedOperationAt: command.trustedOperationAt,
          },
          outcome,
        ),
      ),
      Effect.flatMap((outcome) => {
        if (outcome.outcome === 'ZERO_FLOOR_AUTHORIZATION_CONFLICT') {
          return Effect.succeed(outcome);
        }
        if (outcome.outcome !== 'ZERO_FLOOR_AUTHORIZATION_SCHEDULE') {
          return Effect.succeed({
            authorizationRef: command.authorization.authorizationRef,
            outcome: 'ZERO_FLOOR_AUTHORIZATION_CONFLICT' as const,
            reason: 'TARGET_REVISION_NOT_FOUND' as const,
          });
        }
        const target = outcome.schedule.revisions.find(
          ({ authorization }) => authorization.authorizationRevision === command.targetRevision,
        );
        if (target === undefined) {
          return Effect.succeed({
            authorizationRef: command.authorization.authorizationRef,
            outcome: 'ZERO_FLOOR_AUTHORIZATION_CONFLICT' as const,
            reason: 'TARGET_REVISION_NOT_FOUND' as const,
          });
        }
        return correctionPreservesAuthorizedMeaning(target.authorization, command.authorization)
          ? execute()
          : Effect.succeed({
              authorizationRef: command.authorization.authorizationRef,
              outcome: 'ZERO_FLOOR_AUTHORIZATION_CONFLICT' as const,
              reason: 'SCOPE_EXPANSION_REQUIRES_SUCCESSOR' as const,
            });
      }),
    );
};

export interface ZeroFloorAuthorizationAdministrationService {
  readonly create: ZeroFloorAuthorizationPersistence['create'];
  readonly lookupResult: ZeroFloorAuthorizationPersistence['lookupResult'];
  readonly manage: ZeroFloorAuthorizationPersistence['manage'];
  readonly readCurrentSet: ZeroFloorAuthorizationPersistence['readCurrentSet'];
  readonly readGovernanceProof: ZeroFloorAuthorizationPersistence['readGovernanceProof'];
  readonly readSchedule: ZeroFloorAuthorizationPersistence['readSchedule'];
  readonly verifyGeneration: ZeroFloorAuthorizationPersistence['verifyGeneration'];
}

/**
 * Verifies every persistence result at the owner boundary. Public generated Actions may delegate to
 * this service, but they cannot convert stale expected state, incomplete sets, or failed Results into success.
 */
export const makeZeroFloorAuthorizationAdministration = (
  persistence: ZeroFloorAuthorizationPersistence,
): ZeroFloorAuthorizationAdministrationService => ({
  create: (command) =>
    governanceProofMatches(command)
      ? persistence.create(command).pipe(Effect.flatMap((outcome) => verifyCreateOutcome(command, outcome)))
      : Effect.fail(unavailable('ZERO_FLOOR create requires fresh exact scope, bounds, and Current proof')),
  lookupResult: (query) =>
    persistence.lookupResult(query).pipe(Effect.flatMap((outcome) => verifyLookupOutcome(query, outcome))),
  manage: (command) => manageAuthorization(persistence, command),
  readCurrentSet: (query) =>
    persistence.readCurrentSet(query).pipe(Effect.flatMap((outcome) => verifyCurrentSetOutcome(query, outcome))),
  readGovernanceProof: (query) =>
    persistence
      .readGovernanceProof(query)
      .pipe(Effect.flatMap((outcome) => verifyGovernanceProofOutcome(query, outcome))),
  readSchedule: (query) =>
    persistence.readSchedule(query).pipe(Effect.flatMap((outcome) => verifyScheduleOutcome(query, outcome))),
  verifyGeneration: (query) =>
    persistence.verifyGeneration(query).pipe(Effect.flatMap((outcome) => verifyGenerationOutcome(query, outcome))),
});

export const zeroFloorAuthorizationAdministrationForScope = (
  transaction: Parameters<typeof zeroFloorAuthorizationPersistenceForScope>[0],
  scope: Parameters<typeof zeroFloorAuthorizationPersistenceForScope>[1],
): Effect.Effect<ZeroFloorAuthorizationAdministrationService> =>
  zeroFloorAuthorizationPersistenceForScope(transaction, scope).pipe(
    Effect.map(makeZeroFloorAuthorizationAdministration),
  );
