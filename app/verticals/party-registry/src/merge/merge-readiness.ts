import type {
  MergeReadinessBlocker,
  MergeReadinessResult,
} from '../../shared/domain/merge-readiness.ts';
import type { PartyRef } from '../../shared/resources/party.ts';
import type { PartyAlias } from '../../shared/resources/party-alias.ts';
import type { MergeSurvivorSelectionInput } from '../../shared/domain/merge-selection.ts';
import { selectCanonicalSurvivor } from './canonical-survivor-selection.ts';
import { analyzeMergeCollisions } from './merge-collision-analysis.ts';
import type { MergeCollisionInput } from './merge-collision-analysis.ts';
import { planReferencePreservation } from './reference-preservation-plan.ts';
import type {
  ConsumerReconciliationContract,
  PartyReferenceInventoryItem,
} from './reference-preservation-plan.ts';

export const rejectProductionMergeExecution = () =>
  ({
    _tag: 'ProductionMergeExecutionRejected',
    code: 'PRODUCTION_MERGE_DISABLED',
    detail:
      'Party Merge execution is disabled until consumer reconciliation and wrong-merge recovery are behaviorally proven.',
  }) as const;

export interface PreparedMergeReadinessInput {
  readonly aliases: readonly PartyAlias[];
  readonly collisionInput: MergeCollisionInput;
  readonly consumerReconciliation: readonly ConsumerReconciliationContract[];
  readonly references: readonly PartyReferenceInventoryItem[];
  readonly selectionInput: MergeSurvivorSelectionInput;
}

const baseBlockers = () =>
  [
    {
      code: 'PRODUCTION_MERGE_DISABLED' as const,
      detail:
        'Party Merge execution is disabled until all consumer reconciliation and wrong-merge recovery contracts are behaviorally proven.',
      ownerKey: 'party.registry',
    },
    {
      code: 'CONSUMER_RECONCILIATION_UNPROVEN' as const,
      detail:
        'Every in-scope first-party consumer must prove collision handling, idempotence, and partial retry behavior.',
      ownerKey: 'first-party-consumers',
    },
    {
      code: 'WRONG_MERGE_RECOVERY_UNPROVEN' as const,
      detail:
        'A behaviorally tested wrong-merge recovery path is required before merge execution can be enabled.',
      ownerKey: 'party.registry',
    },
  ] as const;

export const analyzePreparedMergeReadiness = (
  input: PreparedMergeReadinessInput,
): MergeReadinessResult => {
  const selection = selectCanonicalSurvivor(input.selectionInput);
  const partyRefs = input.selectionInput.candidates.map(({ partyRef }) => partyRef);
  const survivorPartyRef =
    selection._tag === 'CanonicalSurvivorSelected'
      ? selection.survivorPartyRef
      : (partyRefs[0] ?? input.collisionInput.survivorPartyRef);
  // Analyze the actual selection set, never a separately supplied collision target set.
  const collisions = analyzeMergeCollisions({
    ...input.collisionInput,
    absorbedPartyRefs: partyRefs.filter(
      (partyRef) =>
        partyRef.resourceId !== survivorPartyRef.resourceId ||
        partyRef.tenantId !== survivorPartyRef.tenantId,
    ),
    survivorPartyRef,
  });
  const referencePlan = planReferencePreservation({
    aliases: input.aliases,
    consumerReconciliation: input.consumerReconciliation,
    references: input.references,
  });
  const selectionBlockers: MergeReadinessBlocker[] =
    selection._tag === 'CanonicalSurvivorSelected'
      ? []
      : [
          {
            code: selection.blocker,
            detail: `Canonical survivor selection is blocked: ${selection.blocker}.`,
            ownerKey: 'party.registry',
          },
        ];
  const collisionBlockers: MergeReadinessBlocker[] = collisions.map(({ code, ownerKey }) => ({
    code,
    detail: `Merge preflight found ${code}; owner reconciliation is required.`,
    ownerKey,
  }));
  const referenceBlockers: MergeReadinessBlocker[] =
    referencePlan._tag === 'ReferencePreservationPlanned'
      ? []
      : referencePlan.blockers.map(({ code, ownerKey }) => ({
          code:
            code === 'UNSUPPORTED_REFERENCE_CLASS' ||
            code === 'CONSUMER_RECONCILIATION_UNPROVEN' ||
            code === 'CONSUMER_PARTIAL_RETRY_UNPROVEN'
              ? code
              : ('UNSUPPORTED_REFERENCE_CLASS' as const),
          detail: `Reference preservation is blocked: ${code}.`,
          ownerKey,
        }));
  return {
    analysis: {
      collisionCodes: collisions.map(({ code }) => code),
      referencePlanStatus:
        referencePlan._tag === 'ReferencePreservationPlanned' ? 'PLANNED' : 'BLOCKED',
      selectedSurvivorPartyRef:
        selection._tag === 'CanonicalSurvivorSelected' ? selection.survivorPartyRef : null,
      selectionStatus: selection._tag === 'CanonicalSurvivorSelected' ? 'SELECTED' : 'BLOCKED',
    },
    blockers: [...baseBlockers(), ...selectionBlockers, ...collisionBlockers, ...referenceBlockers],
    mergeExecutionEnabled: false,
    partyRefs,
    status: 'DISABLED',
  };
};

export const evaluateDisabledMergeReadiness = (
  partyRefs: readonly PartyRef[],
): MergeReadinessResult => {
  const unavailable = analyzePreparedMergeReadiness({
    aliases: [],
    collisionInput: {
      absorbedPartyRefs: partyRefs.slice(1),
      connectorCorrelations: [],
      consumerProfiles: [],
      counterparties: [],
      counterpartyRoles: [],
      officialIdentifiers: [],
      relationships: [],
      // SAFETY: the governed readiness request schema requires at least two distinct PartyRefs.
      survivorPartyRef: partyRefs[0] as PartyRef,
    },
    consumerReconciliation: [],
    references: partyRefs.map((partyRef) => ({
      class: 'DIRECT_RESOURCE_REF',
      ownerKey: 'party.registry',
      partyRef,
    })),
    selectionInput: {
      candidates: partyRefs.map((partyRef) => ({
        authoritativeEvidenceRank: 0,
        blockingAuthoritativeConflict: false,
        completenessRank: 0,
        createdAt: '1970-01-01T00:00:00.000Z',
        lifecycle: 'ACTIVE',
        partyRef,
        referenceStabilityRank: 0,
      })),
      confirmation: null,
    },
  });
  return {
    ...unavailable,
    blockers: [
      ...unavailable.blockers,
      {
        code: 'PREPARED_STATE_UNAVAILABLE',
        detail:
          'This read-only boundary has no canonical prepared merge state for the requested Parties.',
        ownerKey: 'party.registry',
      },
    ],
  };
};
