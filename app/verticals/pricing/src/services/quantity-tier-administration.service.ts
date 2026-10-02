import { priceDecimalValuesEqual } from '@app/pricing-contracts/domain/price-definition';
import {
  QuantityTierEffectivePeriodSchema,
  quantityTierIdentityKeysEqual,
  ScheduledQuantityTierRevisionSchema,
} from '@app/pricing-contracts/domain/quantity-tier';
import type {
  QuantityTierEffectivePeriod,
  QuantityTierIdentityKey,
  QuantityTierResultingUnitPrice,
  QuantityTierScheduleAcknowledgement,
  QuantityTierScheduleReadResult,
  QuantityTierScheduleSnapshot,
  ScheduledQuantityTierRevision,
} from '@app/pricing-contracts/domain/quantity-tier';
import { Effect, Schema } from 'effect';
import type { OperationalScope } from '@app/core-runtime';

import type {
  DefineQuantityTierPersistenceCommand,
  DefineQuantityTierPersistenceOutcome,
  QuantityTierPersistence,
  ReadCurrentQuantityTierPersistenceOutcome,
  ReadCurrentQuantityTierPersistenceQuery,
  ReadQuantityTierSchedulePersistenceQuery,
  RetireCurrentQuantityTierScheduleAcknowledgement,
  ReviseQuantityTierPersistenceCommand,
  ReviseQuantityTierPersistenceOutcome,
} from './quantity-tier-persistence.service.ts';
import {
  QuantityTierPersistenceUnavailable,
  quantityTierPersistenceForScope,
} from './quantity-tier-persistence.service.ts';

const sameEffectivePeriod = Schema.toEquivalence(QuantityTierEffectivePeriodSchema);
const sameScheduledRevision = Schema.toEquivalence(ScheduledQuantityTierRevisionSchema);

const sameResultingUnitPrice = (left: QuantityTierResultingUnitPrice, right: QuantityTierResultingUnitPrice): boolean =>
  left.currencyCode === right.currencyCode && priceDecimalValuesEqual(left.amount, right.amount);

const unavailableEvidence = (reason: string): QuantityTierPersistenceUnavailable =>
  new QuantityTierPersistenceUnavailable({ reason });

const revisionMatches = (
  revision: ScheduledQuantityTierRevision,
  identityKey: QuantityTierIdentityKey,
  effectivePeriod: QuantityTierEffectivePeriod,
  resultingUnitPrice: QuantityTierResultingUnitPrice,
): boolean =>
  quantityTierIdentityKeysEqual(revision.definition.identityKey, identityKey) &&
  sameEffectivePeriod(revision.effectivePeriod, effectivePeriod) &&
  sameResultingUnitPrice(revision.definition.revision.resultingUnitPrice, resultingUnitPrice);

const scheduleIdentityMatches = (
  schedule: QuantityTierScheduleSnapshot,
  identityKey: QuantityTierIdentityKey,
): boolean =>
  quantityTierIdentityKeysEqual(schedule.identityKey, identityKey) &&
  schedule.revisions.every(({ definition }) => quantityTierIdentityKeysEqual(definition.identityKey, identityKey));

const acknowledgementMatches = (
  acknowledgement: QuantityTierScheduleAcknowledgement | RetireCurrentQuantityTierScheduleAcknowledgement,
  command: Extract<ReviseQuantityTierPersistenceCommand, { readonly intent: 'RETIRE_CURRENT' | 'VALUE_ONLY_CURRENT' }>,
): boolean =>
  acknowledgement.actingPrincipalId === command.actingPrincipalId &&
  acknowledgement.intent === command.intent &&
  quantityTierIdentityKeysEqual(acknowledgement.identityKey, command.identityKey) &&
  acknowledgement.scheduleRevision === command.expectedCurrent.scheduleRevision &&
  acknowledgement.targetRevisionId === command.expectedCurrent.revisionId &&
  sameEffectivePeriod(acknowledgement.targetEffectivePeriod, command.expectedCurrent.effectivePeriod) &&
  sameEffectivePeriod(
    acknowledgement.intendedEffectivePeriod,
    command.intent === 'RETIRE_CURRENT'
      ? { effectiveFrom: command.expectedCurrent.effectivePeriod.effectiveFrom, effectiveTo: command.effectiveTo }
      : {
          effectiveFrom: command.effectiveFrom,
          effectiveTo: command.expectedCurrent.effectivePeriod.effectiveTo,
        },
  ) &&
  (command.intent === 'RETIRE_CURRENT' ||
    sameResultingUnitPrice(acknowledgement.intendedResultingUnitPrice, command.resultingUnitPrice));

const samePresentedFuture = (
  schedule: QuantityTierScheduleSnapshot,
  acknowledgement: Pick<QuantityTierScheduleAcknowledgement, 'presentedFuture'>,
): boolean =>
  schedule.future.length === acknowledgement.presentedFuture.length &&
  schedule.future.every((revision, index) => {
    const presented = acknowledgement.presentedFuture[index];
    return presented !== undefined && sameScheduledRevision(revision, presented);
  });

const verifyDefineOutcome = (
  command: DefineQuantityTierPersistenceCommand,
  outcome: DefineQuantityTierPersistenceOutcome,
): Effect.Effect<DefineQuantityTierPersistenceOutcome, QuantityTierPersistenceUnavailable> => {
  if (outcome.outcome === 'QUANTITY_TIER_CONFLICT') {
    return quantityTierIdentityKeysEqual(outcome.identityKey, command.identityKey)
      ? Effect.succeed(outcome)
      : Effect.fail(unavailableEvidence('Quantity Tier conflict evidence did not bind the requested exact Tier'));
  }
  const { definition } = outcome;
  return quantityTierIdentityKeysEqual(definition.identityKey, command.identityKey) &&
    definition.revision.effectiveFrom === command.effectivePeriod.effectiveFrom &&
    sameResultingUnitPrice(definition.revision.resultingUnitPrice, command.resultingUnitPrice)
    ? Effect.succeed(outcome)
    : Effect.fail(unavailableEvidence('Quantity Tier definition evidence did not bind the requested exact Tier'));
};

const verifyCurrentOutcome = (
  query: ReadCurrentQuantityTierPersistenceQuery,
  outcome: ReadCurrentQuantityTierPersistenceOutcome,
): Effect.Effect<ReadCurrentQuantityTierPersistenceOutcome, QuantityTierPersistenceUnavailable> => {
  if (outcome.outcome === 'QUANTITY_TIER_CURRENT') {
    return quantityTierIdentityKeysEqual(outcome.current.definition.identityKey, query.identityKey) &&
      outcome.current.effectivePeriod.effectiveFrom <= query.effectiveAt &&
      (outcome.current.effectivePeriod.effectiveTo === null ||
        query.effectiveAt < outcome.current.effectivePeriod.effectiveTo)
      ? Effect.succeed(outcome)
      : Effect.fail(
          unavailableEvidence('Current Quantity Tier evidence did not bind the requested exact Tier and instant'),
        );
  }
  return quantityTierIdentityKeysEqual(outcome.identityKey, query.identityKey)
    ? Effect.succeed(outcome)
    : Effect.fail(unavailableEvidence('Quantity Tier read evidence did not bind the requested exact Tier'));
};

const verifyScheduleOutcome = (
  query: ReadQuantityTierSchedulePersistenceQuery,
  outcome: QuantityTierScheduleReadResult,
): Effect.Effect<QuantityTierScheduleReadResult, QuantityTierPersistenceUnavailable> => {
  const valid =
    'schedule' in outcome
      ? scheduleIdentityMatches(outcome.schedule, query.identityKey)
      : quantityTierIdentityKeysEqual(outcome.identityKey, query.identityKey);
  return valid
    ? Effect.succeed(outcome)
    : Effect.fail(unavailableEvidence('Quantity Tier schedule evidence did not bind the requested exact Tier'));
};

const findExpectedRevision = (
  command: ReviseQuantityTierPersistenceCommand,
  schedule: QuantityTierScheduleSnapshot,
) => {
  if (command.intent === 'VALUE_ONLY_CURRENT') {
    return schedule.revisions.find(({ effectivePeriod }) =>
      sameEffectivePeriod(effectivePeriod, {
        effectiveFrom: command.effectiveFrom,
        effectiveTo: command.expectedCurrent.effectivePeriod.effectiveTo,
      }),
    );
  }
  if (command.intent === 'RETIRE_CURRENT') {
    return schedule.revisions.find(
      ({ definition, effectivePeriod }) =>
        definition.revision.revisionId !== command.expectedCurrent.revisionId &&
        effectivePeriod.effectiveFrom === command.expectedCurrent.effectivePeriod.effectiveFrom &&
        effectivePeriod.effectiveTo === command.effectiveTo,
    );
  }
  if (command.intent === 'CORRECT_REVISION') {
    return schedule.revisions.find(
      ({ definition, effectivePeriod }) =>
        definition.revision.revisionId !== command.targetRevisionId &&
        sameEffectivePeriod(effectivePeriod, command.targetEffectivePeriod),
    );
  }
  return schedule.revisions.find(({ effectivePeriod }) =>
    sameEffectivePeriod(effectivePeriod, command.effectivePeriod),
  );
};

const expectedPeriodFor = (command: ReviseQuantityTierPersistenceCommand): QuantityTierEffectivePeriod => {
  if (command.intent === 'VALUE_ONLY_CURRENT') {
    return { effectiveFrom: command.effectiveFrom, effectiveTo: command.expectedCurrent.effectivePeriod.effectiveTo };
  }
  if (command.intent === 'RETIRE_CURRENT') {
    return { effectiveFrom: command.expectedCurrent.effectivePeriod.effectiveFrom, effectiveTo: command.effectiveTo };
  }
  return command.intent === 'CORRECT_REVISION' ? command.targetEffectivePeriod : command.effectivePeriod;
};

const predecessorIsPreserved = (
  command: ReviseQuantityTierPersistenceCommand,
  schedule: QuantityTierScheduleSnapshot,
) =>
  command.intent !== 'VALUE_ONLY_CURRENT' ||
  command.effectiveFrom === command.expectedCurrent.effectivePeriod.effectiveFrom ||
  schedule.revisions.some(
    ({ definition, effectivePeriod }) =>
      definition.revision.revisionId === command.expectedCurrent.revisionId &&
      definition.revision.revision === command.expectedCurrent.revision &&
      quantityTierIdentityKeysEqual(definition.identityKey, command.identityKey) &&
      sameEffectivePeriod(effectivePeriod, {
        effectiveFrom: command.expectedCurrent.effectivePeriod.effectiveFrom,
        effectiveTo: command.effectiveFrom,
      }),
  );

const scheduleWasAcknowledged = (
  command: ReviseQuantityTierPersistenceCommand,
  schedule: QuantityTierScheduleSnapshot,
) => {
  if (command.intent !== 'VALUE_ONLY_CURRENT' && command.intent !== 'RETIRE_CURRENT') {
    return true;
  }
  return command.acknowledgement === undefined
    ? schedule.future.length === 0
    : acknowledgementMatches(command.acknowledgement, command) &&
        samePresentedFuture(schedule, command.acknowledgement);
};

const lifecycleLineageIsValid = (
  command: ReviseQuantityTierPersistenceCommand,
  revision: ScheduledQuantityTierRevision | undefined,
) => {
  if (revision === undefined) {
    return false;
  }
  if (command.intent === 'RETIRE_CURRENT') {
    return (
      revision.lineage.kind === 'RETIREMENT' &&
      revision.lineage.previousRevisionId === command.expectedCurrent.revisionId &&
      revision.lineage.correctedRevisionId === null
    );
  }
  if (command.intent === 'CORRECT_REVISION') {
    return (
      revision.lineage.kind === 'CORRECTION' &&
      revision.lineage.previousRevisionId === command.targetRevisionId &&
      revision.lineage.correctedRevisionId === command.targetRevisionId
    );
  }
  return true;
};

const verifyReviseOutcome = (
  command: ReviseQuantityTierPersistenceCommand,
  outcome: ReviseQuantityTierPersistenceOutcome,
): Effect.Effect<ReviseQuantityTierPersistenceOutcome, QuantityTierPersistenceUnavailable> => {
  if (outcome.outcome === 'QUANTITY_TIER_CONFLICT') {
    return quantityTierIdentityKeysEqual(outcome.identityKey, command.identityKey)
      ? Effect.succeed(outcome)
      : Effect.fail(unavailableEvidence('Quantity Tier conflict evidence did not bind the requested exact Tier'));
  }
  if (outcome.outcome === 'QUANTITY_TIER_ACKNOWLEDGEMENT_REQUIRED') {
    return (command.intent === 'VALUE_ONLY_CURRENT' || command.intent === 'RETIRE_CURRENT') &&
      command.acknowledgement === undefined &&
      acknowledgementMatches(outcome.acknowledgement, command)
      ? Effect.succeed(outcome)
      : Effect.fail(unavailableEvidence('Quantity Tier warning did not bind the requested Current edit'));
  }
  if (!scheduleIdentityMatches(outcome.schedule, command.identityKey)) {
    return Effect.fail(unavailableEvidence('Revised Quantity Tier schedule did not bind the requested exact Tier'));
  }
  const expectedRevision = findExpectedRevision(command, outcome.schedule);
  const expectedPeriod = expectedPeriodFor(command);
  const predecessorPreserved = predecessorIsPreserved(command, outcome.schedule);
  const scheduleAcknowledged = scheduleWasAcknowledged(command, outcome.schedule);
  const lifecycleLineageMatches = lifecycleLineageIsValid(command, expectedRevision);
  const expectedValue =
    command.intent === 'RETIRE_CURRENT'
      ? expectedRevision?.definition.revision.resultingUnitPrice
      : command.resultingUnitPrice;
  return scheduleAcknowledged &&
    predecessorPreserved &&
    lifecycleLineageMatches &&
    expectedRevision !== undefined &&
    expectedValue !== undefined &&
    revisionMatches(expectedRevision, command.identityKey, expectedPeriod, expectedValue)
    ? Effect.succeed(outcome)
    : Effect.fail(
        unavailableEvidence('Revised Quantity Tier evidence did not preserve the requested value and interval'),
      );
};

export interface QuantityTierAdministrationService {
  readonly define: QuantityTierPersistence['define'];
  readonly readCurrent: QuantityTierPersistence['readCurrent'];
  readonly readSchedule: QuantityTierPersistence['readSchedule'];
  readonly revise: QuantityTierPersistence['revise'];
}

/**
 * Owner-local orchestration only. Public administration Actions, durable recovery, threshold selection,
 * and aggregation are intentionally owned by #797/#802, #767, and #768 respectively.
 */
export const makeQuantityTierAdministration = (
  persistence: QuantityTierPersistence,
): QuantityTierAdministrationService => ({
  define: (command) =>
    persistence.define(command).pipe(Effect.flatMap((outcome) => verifyDefineOutcome(command, outcome))),
  readCurrent: (query) =>
    persistence.readCurrent(query).pipe(Effect.flatMap((outcome) => verifyCurrentOutcome(query, outcome))),
  readSchedule: (query) =>
    persistence.readSchedule(query).pipe(Effect.flatMap((outcome) => verifyScheduleOutcome(query, outcome))),
  revise: (command) =>
    persistence.revise(command).pipe(Effect.flatMap((outcome) => verifyReviseOutcome(command, outcome))),
});

export const quantityTierAdministrationForScope = (
  transaction: Parameters<typeof quantityTierPersistenceForScope>[0],
  scope: OperationalScope,
): Effect.Effect<QuantityTierAdministrationService> =>
  quantityTierPersistenceForScope(transaction, scope).pipe(Effect.map(makeQuantityTierAdministration));
