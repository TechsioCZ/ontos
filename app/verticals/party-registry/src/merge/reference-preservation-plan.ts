import type { PartyAlias } from '../../shared/resources/party-alias.ts';
import type { PartyRef } from '../../shared/resources/party.ts';
import { resolveCanonicalPartyRef } from './party-alias-resolution.ts';

export type SupportedReferenceClass =
  | 'COMMERCE_PROFILE'
  | 'CONNECTOR_CORRELATION'
  | 'COUNTERPARTY'
  | 'ENGAGEMENT_PROFILE'
  | 'DIRECT_RESOURCE_REF'
  | 'EVENT_OR_OUTBOX_PAYLOAD'
  | 'HISTORICAL_DOCUMENT';
export type ReferenceClass = SupportedReferenceClass | 'UNSUPPORTED';
export interface HistoricalPartySnapshot {
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

export const planReferencePreservation = (
  input: Readonly<{
    aliases: readonly PartyAlias[];
    consumerReconciliation?: readonly ConsumerReconciliationContract[];
    references: readonly PartyReferenceInventoryItem[];
  }>,
) => {
  const blockers: Readonly<{ code: string; ownerKey: string }>[] = [];
  const contracts = new Map(
    (input.consumerReconciliation ?? []).map((contract) => [contract.consumerKey, contract]),
  );
  for (const reference of input.references) {
    if (reference.class === 'UNSUPPORTED') {
      blockers.push({ code: 'UNSUPPORTED_REFERENCE_CLASS', ownerKey: reference.ownerKey });
      continue;
    }
    if (reference.ownerKey !== 'party.registry') {
      const contract = contracts.get(reference.ownerKey);
      if (
        contract === undefined ||
        !contract.collisionBehaviorTested ||
        !contract.idempotent ||
        contract.evidenceRefs.length === 0
      ) {
        blockers.push({
          code: 'CONSUMER_RECONCILIATION_UNPROVEN',
          ownerKey: reference.ownerKey,
        });
      } else if (!contract.partialRetrySupported) {
        blockers.push({
          code: 'CONSUMER_PARTIAL_RETRY_UNPROVEN',
          ownerKey: reference.ownerKey,
        });
      }
    }
  }
  if (blockers.length > 0) {
    return {
      _tag: 'ReferencePreservationBlocked',
      blockers: [
        ...new Map(
          blockers.map((blocker) => [`${blocker.code}:${blocker.ownerKey}`, blocker]),
        ).values(),
      ],
    } as const;
  }

  const references: PlannedPartyReference[] = [];
  for (const reference of input.references) {
    if (reference.class === 'UNSUPPORTED') {
      continue;
    }
    const resolution = resolveCanonicalPartyRef(reference.partyRef, input.aliases);
    if (resolution._tag !== 'CanonicalPartyResolved') {
      blockers.push({ code: resolution._tag, ownerKey: reference.ownerKey });
      continue;
    }
    const planned = {
      canonicalPartyRef: resolution.canonicalPartyRef,
      class: reference.class,
      originalPartyRef: reference.partyRef,
      ownerKey: reference.ownerKey,
      physicalRewriteRequired: false as const,
    };
    references.push(
      reference.historicalSnapshot === undefined
        ? planned
        : { ...planned, historicalSnapshot: reference.historicalSnapshot },
    );
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
