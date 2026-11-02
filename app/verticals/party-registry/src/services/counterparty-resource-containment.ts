import { ownerResourceModuleContainment } from '@app/core-runtime';
import type { ResourceContainmentRelationship } from '@app/core-runtime';
import { Array as Arr, Effect } from 'effect';

import { PartySearchProjectionUnavailable } from '../../shared/domain/search-projection-error.ts';
import type { PartySearchSourceCounterparty } from './party-search-projection.service.ts';

/** Core accepts at most this many containment edges in one atomic TOUCH. */
const touchBatchSize = 100;

/**
 * The `resource#module@module_access` edge of each Counterparty in its own company's `party.registry` scope, so
 * resource-level reads (`resource#read = (reader + module->read_all) & module->access`) resolve for that company.
 * The Legal Entity comes from the verified owner snapshot, never from an event payload. Batched for Core's TOUCH limit.
 */
export const counterpartyContainmentBatches = Effect.fn('CounterpartyResourceContainment.batches')(function* batches(
  tenantId: string,
  counterparties: readonly Pick<PartySearchSourceCounterparty, 'legalEntityId' | 'ref'>[],
) {
  const relationships: ResourceContainmentRelationship[] = [];
  for (const { legalEntityId, ref } of counterparties) {
    const relationship =
      ref.tenantId === tenantId ? ownerResourceModuleContainment(tenantId, legalEntityId, ref) : undefined;
    if (relationship === undefined) {
      return yield* new PartySearchProjectionUnavailable({
        code: 'party_search_projection_unavailable',
        reason: 'A Counterparty resource containment identity is invalid',
      });
    }
    relationships.push(relationship);
  }
  return Arr.chunksOf(relationships, touchBatchSize);
});
