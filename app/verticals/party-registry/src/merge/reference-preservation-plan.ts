import { Match, Option, Schema } from 'effect';

import type { PartyAlias } from '../../shared/resources/party-alias.ts';
import type { PartyRef } from '../../shared/resources/party.ts';
import { resolveCanonicalPartyRef } from './party-alias-resolution.ts';

const SupportedReferenceClassSchema = Schema.Literals([
  'COMMERCE_PROFILE',
  'CONNECTOR_CORRELATION',
  'COUNTERPARTY',
  'ENGAGEMENT_PROFILE',
  'DIRECT_RESOURCE_REF',
  'EVENT_OR_OUTBOX_PAYLOAD',
  'HISTORICAL_DOCUMENT',
]);
type SupportedReferenceClass = typeof SupportedReferenceClassSchema.Type;
const ReferenceClassSchema = Schema.Union([
  SupportedReferenceClassSchema,
  Schema.Literal('UNSUPPORTED'),
]);
type ReferenceClass = typeof ReferenceClassSchema.Type;
interface HistoricalPartySnapshot {
  readonly address?: string;
  readonly name?: string;
  readonly price?: string;
}
export interface PartyReferenceInventoryItem {
  readonly class: ReferenceClass;
  readonly historicalSnapshot?: HistoricalPartySnapshot;
  readonly ownerKey: string;
  readonly partyRef: PartyRef;
}
export interface ConsumerReconciliationContract {
  readonly collisionBehaviorTested: boolean;
  readonly consumerKey: string;
  readonly evidenceRefs: readonly string[];
  readonly idempotent: boolean;
  readonly partialRetrySupported: boolean;
}
interface PlannedPartyReference {
  readonly canonicalPartyRef: PartyRef;
  readonly class: SupportedReferenceClass;
  readonly historicalSnapshot?: HistoricalPartySnapshot;
  readonly originalPartyRef: PartyRef;
  readonly ownerKey: string;
  readonly physicalRewriteRequired: false;
}

type ReferenceBlocker = Readonly<{ code: string; ownerKey: string }>;

const consumerContractBlocker = (
  ownerKey: string,
  contract: ConsumerReconciliationContract | undefined
): ReferenceBlocker | undefined => {
  if (ownerKey === 'party.registry') {
    return undefined;
  }
  if (
    contract === undefined ||
    !contract.collisionBehaviorTested ||
    !contract.idempotent ||
    contract.evidenceRefs.length === 0
  ) {
    return { code: 'CONSUMER_RECONCILIATION_UNPROVEN', ownerKey };
  }
  if (!contract.partialRetrySupported) {
    return { code: 'CONSUMER_PARTIAL_RETRY_UNPROVEN', ownerKey };
  }
  return undefined;
};

const collectReferenceBlockers = (
  references: readonly PartyReferenceInventoryItem[],
  consumerReconciliation: readonly ConsumerReconciliationContract[] | undefined
): ReferenceBlocker[] => {
  const blockers: ReferenceBlocker[] = [];
  const contracts = new Map(
    (consumerReconciliation ?? []).map((contract) => [
      contract.consumerKey,
      contract,
    ])
  );
  for (const reference of references) {
    if (reference.class === 'UNSUPPORTED') {
      blockers.push({
        code: 'UNSUPPORTED_REFERENCE_CLASS',
        ownerKey: reference.ownerKey,
      });
      continue;
    }
    const blocker = consumerContractBlocker(
      reference.ownerKey,
      contracts.get(reference.ownerKey)
    );
    if (blocker !== undefined) {
      blockers.push(blocker);
    }
  }
  return blockers;
};

export const planReferencePreservation = (
  input: Readonly<{
    aliases: readonly PartyAlias[];
    consumerReconciliation?: readonly ConsumerReconciliationContract[];
    references: readonly PartyReferenceInventoryItem[];
  }>
) => {
  const blockers = collectReferenceBlockers(
    input.references,
    input.consumerReconciliation
  );
  if (blockers.length > 0) {
    return {
      _tag: 'ReferencePreservationBlocked',
      blockers: [
        ...new Map(
          blockers.map((blocker) => [
            `${blocker.code}:${blocker.ownerKey}`,
            blocker,
          ])
        ).values(),
      ],
    } as const;
  }

  const references: PlannedPartyReference[] = [];
  for (const reference of input.references) {
    if (reference.class === 'UNSUPPORTED') {
      continue;
    }
    const supportedReferenceClass: SupportedReferenceClass = reference.class;
    const resolution = resolveCanonicalPartyRef(
      reference.partyRef,
      input.aliases
    );
    const planned = Match.value(resolution).pipe(
      Match.tag('CanonicalPartyResolved', ({ canonicalPartyRef }) =>
        Option.some({
          canonicalPartyRef,
          class: supportedReferenceClass,
          originalPartyRef: reference.partyRef,
          ownerKey: reference.ownerKey,
          physicalRewriteRequired: false as const,
        })
      ),
      Match.tag('PartyAliasCycleRejected', ({ _tag }) => {
        blockers.push({ code: _tag, ownerKey: reference.ownerKey });
        return Option.none<PlannedPartyReference>();
      }),
      Match.tag('PartyAliasSelfReferenceRejected', ({ _tag }) => {
        blockers.push({ code: _tag, ownerKey: reference.ownerKey });
        return Option.none<PlannedPartyReference>();
      }),
      Match.tag('PartyAliasCrossTenantRejected', ({ _tag }) => {
        blockers.push({ code: _tag, ownerKey: reference.ownerKey });
        return Option.none<PlannedPartyReference>();
      }),
      Match.exhaustive
    );
    if (Option.isSome(planned)) {
      references.push(
        reference.historicalSnapshot === undefined
          ? planned.value
          : {
              ...planned.value,
              historicalSnapshot: reference.historicalSnapshot,
            }
      );
    }
  }
  if (blockers.length > 0) {
    return { _tag: 'ReferencePreservationBlocked', blockers } as const;
  }
  return {
    _tag: 'ReferencePreservationPlanned',
    references,
    requiresPhysicalRewrite: false,
  } as const;
};
