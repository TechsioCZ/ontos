import type { OutboxMessage } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import type { ConsumerReconciliationContract } from './reference-preservation-plan.ts';
import { MergeReadinessOwnerKeySchema } from '../../shared/domain/merge-readiness.ts';
import type { PartyMerge } from '../../shared/resources/party-merge.ts';
import type { OutboxPayloadJson } from '../../shared/outbox/party-registry-party-merged-v1.ts';
import { outboxProducerModuleKey, outboxTopic } from '../../shared/outbox/party-registry-party-merged-v1.ts';

const PublicationBlockerSchema = Schema.Struct({
  code: Schema.Literals([
    'PRODUCTION_MERGE_DISABLED',
    'CONSUMER_RECONCILIATION_UNPROVEN',
    'CONSUMER_PARTIAL_RETRY_UNPROVEN',
  ]),
  ownerKey: Schema.toEncoded(MergeReadinessOwnerKeySchema),
});
export type PartyMergedPublicationBlocker = typeof PublicationBlockerSchema.Type;

export class PartyMergedPublicationDisabled extends Schema.TaggedError<PartyMergedPublicationDisabled>()(
  'PartyMergedPublicationDisabled',
  {
    blockers: Schema.Array(PublicationBlockerSchema).check(Schema.isMinLength(1)),
    publicationEnabled: Schema.Literal(false),
  },
) {}

const reconciliationBlocker = (
  consumerKey: string,
  contract: ConsumerReconciliationContract | undefined,
): PartyMergedPublicationBlocker | undefined => {
  if (
    contract === undefined ||
    contract.consumerKey !== consumerKey ||
    !contract.collisionBehaviorTested ||
    !contract.idempotent ||
    contract.evidenceRefs.length === 0
  ) {
    return { code: 'CONSUMER_RECONCILIATION_UNPROVEN', ownerKey: consumerKey };
  }
  if (!contract.partialRetrySupported) {
    return { code: 'CONSUMER_PARTIAL_RETRY_UNPROVEN', ownerKey: consumerKey };
  }
  return undefined;
};

/**
 * Evaluates consumer evidence while retaining Party Registry's independent production kill switch.
 * A complete consumer dependency cone therefore still cannot make merge publication executable.
 */
export const evaluatePartyMergedPublicationGate = (
  requiredConsumerKeys: readonly string[],
  contracts: readonly ConsumerReconciliationContract[],
) => {
  const contractsByKey = new Map(contracts.map((contract) => [contract.consumerKey, contract]));
  const blockers: PartyMergedPublicationBlocker[] = [{ code: 'PRODUCTION_MERGE_DISABLED', ownerKey: 'party.registry' }];
  for (const consumerKey of [...new Set(requiredConsumerKeys)].toSorted()) {
    const blocker = reconciliationBlocker(consumerKey, contractsByKey.get(consumerKey));
    if (blocker !== undefined) {
      blockers.push(blocker);
    }
  }
  return {
    blockers,
    publicationEnabled: false,
    status: 'DISABLED',
  } as const;
};

/** Builds the exact future event payload from already-prepared merge evidence. */
export const createPartyMergedPayload = (merge: PartyMerge, occurredAt: string): OutboxPayloadJson => ({
  absorbedPartyRefs: merge.absorbedPartyRefs,
  mergeId: merge.mergeRef.resourceId,
  occurredAt,
  policyVersion: merge.policyVersion,
  survivorPartyRef: merge.survivorPartyRef,
  tenantId: merge.mergeRef.tenantId,
});

/** Pure durable-message factory for a future merge Action's atomic Domain Event/outbox commit. */
export const createPartyMergedOutboxMessage = (payload: OutboxPayloadJson): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: outboxProducerModuleKey,
  topic: outboxTopic,
});

/**
 * The only current producer seam. It deliberately fails before a message can reach an Action
 * collector; registering a merge Action requires a separately reviewed replacement of this gate.
 */
export const publishPartyMerged = (
  requiredConsumerKeys: readonly string[],
  contracts: readonly ConsumerReconciliationContract[],
): Effect.Effect<never, PartyMergedPublicationDisabled> => {
  const gate = evaluatePartyMergedPublicationGate(requiredConsumerKeys, contracts);
  return Effect.fail(
    new PartyMergedPublicationDisabled({
      blockers: [...gate.blockers],
      publicationEnabled: false,
    }),
  );
};
